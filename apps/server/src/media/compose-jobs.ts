import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { SkillResult, ToolScope } from "@agentlee/mcp-tools";
import { COMPOSE_VIDEO_TOOL } from "@agentlee/mcp-tools/media";
import {
  COMPOSE_ACTIVE,
  COMPOSE_FAILURE_SHORT,
  COMPOSE_LIMITS,
  ComposeTimeline,
  FILE_KINDS,
  FILE_LIMITS,
  MEDIA_TOOL_HINTS,
  type ComposeJob,
  type ComposeJobCode,
  type ComposeJobStatus,
  type MediaToolCode,
} from "@agentlee/shared";
import type { UserStore } from "../auth/users.js";
import type { Db } from "../db/client.js";
import { composeJobs, conversations, messages, runs } from "../db/schema.js";
import type { ConversationStore } from "../conversations/store.js";
import { FileAddCancelledError, type FileRow, type FileStore } from "../files/store.js";
import { logEvent, type EventLogger } from "../logging.js";
import type { PublishInput } from "../notifications/compose.js";
import { carriesSecret } from "../secrets/egress.js";
import { scrubKnown, scrubKnownDeep } from "../secrets/known.js";
import { storagePaths } from "../storage/paths.js";
import {
  checkTimeline,
  cueText,
  FPS,
  inputKindOf,
  isPlanError,
  planTimeline,
  toAss,
  toVtt,
  type InputInfo,
  type Plan,
} from "./compose-plan.js";
import { removeComposeWorkdir, sweepComposeScratch, type Composer } from "./compose-run.js";
import type { MediaSettingsStore } from "./settings.js";

/**
 * `compose_video` and its jobs (#238 stage 4-1 — docs/decisions/media-generation.md §15, the user's 확정 사항 and the
 * plan review's R1–R12). Nothing leaves the server and nothing is paid, so there is no confirmation card: the call
 * itself queues the job.
 *
 * **The call** (`queue`): the admin's switch and the local readiness (ffmpeg, ffprobe, the sandbox — a tiny composition
 * checked like a real one), the run's reply, the subtitles' egress check (known secrets), the timeline's own rules, the
 * run's per-run limit; the inputs: files of this conversation sent with an active message (or made in one), of a kind
 * for their place. Then, in one short `BEGIN IMMEDIATE` transaction (review R7): the slots (1 running, 3 waiting, 1 per
 * user — waiting or running), a place among the conversation's files, and the `preparing` row (its id is its working
 * folder's name). Outside it, the inputs are copied through the store's checked descriptors (`FileStore.open`, each
 * file once) into `compose-scratch/<id>/in/`, probed by ffprobe, and the plan made (`compose-plan.ts`); then `queued`.
 * Any refusal on the way removes the row and the folder and answers the model with a fixed code and a hint. The call
 * never throws for a bad timeline.
 *
 * **The engine** (only the lock-holding server runs it): one job at a time, the oldest queued first. It runs the
 * composition (`compose-run.ts`) with a 30-minute deadline, writes its progress (at most once a second), and stores the
 * checked MP4 with `files.addGenerated` — the file row, `file_id` and `done` in one transaction, inside the file lock
 * and only while the job is still this one, running. Every end removes the job's folder. **A restart** (the
 * conservative reading of user decision 3): every job not ended of another process — preparing, queued or running —
 * is `compose_interrupted` (never run again by itself), and every working folder goes. A conversation deleted: its
 * jobs' work stops at once (their rows go with the conversation). Notifications: once per end, retried with a backoff.
 */
export type ComposeJobRow = typeof composeJobs.$inferSelect;

class ToolError extends Error {
  constructor(
    readonly code: MediaToolCode,
    readonly hint?: string,
  ) {
    super(code);
  }
}

export type ComposeNotify = {
  publish(userId: string, input: PublishInput, opts?: { dedupeKey?: string }): string | undefined;
  publishOutcome?(
    userId: string,
    input: PublishInput,
    opts?: { dedupeKey?: string },
  ): { status: "published" | "refused" | "failed"; id?: string };
  wants?(userId: string, kind: "compose_done" | "compose_failed"): boolean;
};

type Limits = {
  timeoutMs: number;
  prepareTimeoutMs: number;
  slots: { running: number; waiting: number; perUser: number };
  maxInputBytes: number;
  /** How often the engine looks for queued jobs and due notifications. */
  tickMs: number;
  /** How long a readiness verdict holds. */
  readyTtlMs: number;
  /** The first wait of a failed notification (doubling, at most 5 min). */
  notifyRetryMs: number;
  /** At most one progress write per this. */
  progressMs: number;
};

const DEFAULTS: Limits = {
  timeoutMs: COMPOSE_LIMITS.timeoutMs,
  prepareTimeoutMs: COMPOSE_LIMITS.prepareTimeoutMs,
  slots: COMPOSE_LIMITS.slots,
  maxInputBytes: COMPOSE_LIMITS.maxInputBytes,
  tickMs: 2000,
  readyTtlMs: 10 * 60_000,
  notifyRetryMs: 30_000,
  progressMs: 1000,
};

export type ComposeJobsOptions = {
  db: Db;
  files: () => FileStore | undefined;
  conversations: Pick<ConversationStore, "onDelete" | "onDeleted">;
  settings: Pick<MediaSettingsStore, "get">;
  users: Pick<UserStore, "byId">;
  notifications: () => ComposeNotify | undefined;
  /** ffmpeg/ffprobe in the sandbox, resolved per use (undefined: not on this server — not offered). */
  composer: () => Composer | undefined;
  /** Files image/speech calls of this conversation are making right now (they take places too). */
  filesPending?: (conversationId: string) => number;
  dataDir: string;
  /** The `.env` skill secrets: the egress check knows them too. */
  secrets?: Readonly<Record<string, string>> | undefined;
  log?: EventLogger | undefined;
  now?: () => number;
  limits?: Partial<Limits>;
};

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ACTIVE = [...COMPOSE_ACTIVE] as ComposeJobStatus[];
const WAITING: ComposeJobStatus[] = ["preparing", "queued"];

/** `20261126-153012` (UTC) for a file name. */
const stamp = (t: number) => new Date(t).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

/** The first problems of a timeline that does not parse, as `path: message` (for the model's hint). */
function zodHint(e: z.ZodError): string {
  return e.issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join(".") || "timeline"}: ${i.message}`)
    .join("; ")
    .slice(0, 500);
}

export class ComposeJobs {
  private readonly events = new EventEmitter();
  private readonly now: () => number;
  private readonly limits: Limits;
  /** Per run, the calls of `compose_video` (the admin's per-run limit). */
  private readonly calls = new Map<string, { n: number; at: number }>();
  /** The work of this process under way, by job: a call preparing it, or the engine running it. */
  private readonly work = new Map<string, { stop: AbortController; done?: Promise<unknown> }>();
  private readonly streams = new Set<() => void>();
  /** Job ids of a conversation being deleted (only a delete that committed, `onDeleted`, stops them). */
  private readonly deleting = new Map<string, string[]>();
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  private recovered = false;
  private swept = false;
  /**
   * The engine's one running slot (review r2): the live executor of a job — set in the same synchronous step as the
   * row becomes `running`, cleared only by that executor's own end. Nothing else decides whether the engine is busy, so
   * a failure anywhere in a run cannot leave the slot held by a job no executor runs.
   */
  private executor: { id: string; done: Promise<void> } | undefined;
  private ready: { ok: boolean | null; at: number | null; checking?: Promise<boolean> } = {
    ok: null,
    at: null,
  };
  /** This process. */
  readonly boot = crypto.randomBytes(6).toString("hex");

  constructor(private readonly o: ComposeJobsOptions) {
    this.now = o.now ?? Date.now;
    this.limits = { ...DEFAULTS, ...o.limits };
    this.events.setMaxListeners(0);
    o.conversations.onDelete((conversationId) => {
      const ids = this.o.db
        .select({ id: composeJobs.id })
        .from(composeJobs)
        .where(eq(composeJobs.conversationId, conversationId))
        .all()
        .map((r) => r.id);
      this.deleting.set(conversationId, ids);
    });
    // The delete committed: the rows went with the conversation; their work stops now (each removes its own folder).
    o.conversations.onDeleted((c) => {
      const ids = this.deleting.get(c.id) ?? [];
      this.deleting.delete(c.id);
      for (const id of ids) {
        const w = this.work.get(id);
        // Preparing or running: its work stops and removes its own folder. Waiting (queued) or ended: nothing works on
        // it — its folder (the input copies) goes now, not at the next start (review r1).
        if (w) w.stop.abort();
        else removeComposeWorkdir(this.folderOf(id));
        this.changed(id);
      }
      // The jobs still waiting may have moved up (review r2).
      if (ids.length) this.queuedChanged();
    });
  }

  /** Every waiting job's card hears that its place in the queue may have changed. Never throws. */
  private queuedChanged(): void {
    try {
      for (const q of this.o.db
        .select({ id: composeJobs.id })
        .from(composeJobs)
        .where(eq(composeJobs.status, "queued"))
        .all())
        this.changed(q.id);
    } catch {
      // the cards read their state again on their own (stream or polling)
    }
  }

  /** A job's working folder (`compose-scratch/<id>`). */
  private folderOf(id: string): string {
    return path.join(storagePaths(this.o.dataDir).composeScratch, id);
  }

  // ---------------------------------------------------------------- reading

  get(id: string): ComposeJobRow | undefined {
    return this.o.db.select().from(composeJobs).where(eq(composeJobs.id, id)).get();
  }

  /** 1 = the next to run (queued jobs only). */
  private position(row: ComposeJobRow): number | null {
    if (row.status !== "queued") return null;
    const ahead = this.o.db.$client
      .prepare(
        `SELECT count(*) AS n FROM compose_jobs WHERE status = 'queued'
           AND (created_at < ? OR (created_at = ? AND id < ?))`,
      )
      .get(row.createdAt, row.createdAt, row.id) as { n: number };
    return ahead.n + 1;
  }

  /** The card as the API sends it. */
  view(row: ComposeJobRow): ComposeJob {
    const f = row.fileId ? this.o.files()?.get(row.fileId) : undefined;
    return scrubKnownDeep(
      {
        id: row.id,
        conversationId: row.conversationId,
        messageId: row.messageId,
        status: row.status,
        queuePosition: this.position(row),
        progress: row.status === "running" || row.status === "done" ? (row.progress ?? 0) : null,
        durationSec: row.durationMs / 1000,
        width: row.width,
        height: row.height,
        clips: row.clips,
        subtitles: row.subtitles,
        version: row.version,
        createdAt: row.createdAt,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        errorCode: (row.errorCode as ComposeJobCode | null) ?? null,
        file: f && row.status === "done" ? { fileId: f.id, name: f.name, bytes: f.bytes } : null,
      },
      { tail: false },
    );
  }

  /** The card's subtitle track (WebVTT), from the stored timeline (scrubbed again); undefined without subtitles. */
  vtt(row: ComposeJobRow): string | undefined {
    if (!row.subtitles) return undefined;
    try {
      const t = ComposeTimeline.safeParse(scrubKnownDeep(JSON.parse(row.timelineJson) as unknown));
      if (!t.success || !t.data.subtitles?.length) return undefined;
      return toVtt(t.data.subtitles);
    } catch {
      return undefined;
    }
  }

  subscribe(id: string, fn: () => void): () => void {
    const h = (jobId: string) => {
      if (jobId !== id) return;
      try {
        fn();
      } catch {
        // a subscriber's own problem
      }
    };
    this.events.on("change", h);
    return () => void this.events.off("change", h);
  }

  addStream(close: () => void): () => void {
    this.streams.add(close);
    return () => void this.streams.delete(close);
  }

  private changed(id: string): void {
    this.events.emit("change", id);
  }

  // ---------------------------------------------------------------- readiness and the gate

  /**
   * Whether `compose_video` is offered now (review R9 — its own gate, not `offered()` of the paid kinds): the admin's
   * switch, the engine running here, and the last readiness check said yes (a stale verdict is checked again in the
   * background and holds until then; none yet — not offered, a check starts).
   */
  offered(): boolean {
    if (!this.started) return false;
    let enabled: boolean;
    try {
      enabled = this.o.settings.get().composeEnabled;
    } catch {
      return false;
    }
    if (!enabled) return false;
    if (this.ready.at === null || this.now() - this.ready.at > this.limits.readyTtlMs) void this.checkReady();
    return this.ready.ok === true && !!this.o.composer();
  }

  /** The admin screen's readiness: the last verdict (null: not checked yet) — a stale one is checked again. */
  readiness(): { ready: boolean | null; checkedAt: number | null } {
    if (this.ready.at === null || this.now() - this.ready.at > this.limits.readyTtlMs) void this.checkReady();
    return { ready: this.ready.ok, checkedAt: this.ready.at };
  }

  /** One readiness check at a time (a tiny composition in the sandbox, `Composer.ready`). Never throws. */
  checkReady(): Promise<boolean> {
    if (this.ready.checking) return this.ready.checking;
    const c = this.o.composer();
    const p = (async () => {
      // Always after this call has returned (the slot below is set first).
      await Promise.resolve();
      let ok: boolean;
      try {
        ok = c ? await c.ready() : false;
      } catch {
        ok = false;
      }
      this.ready = { ok, at: this.now() };
      if (!ok) logEvent(this.o.log, "warn", "compose.unready");
      return ok;
    })();
    this.ready.checking = p;
    return p;
  }

  // ---------------------------------------------------------------- the tool

  private secret(texts: readonly string[]): boolean {
    return carriesSecret(texts, { config: Object.values(this.o.secrets ?? {}) });
  }

  private replyOf(scope: ToolScope): string | undefined {
    const r = this.o.db
      .select({ ownerId: conversations.ownerId, messageId: runs.assistantMessageId, endedAt: runs.endedAt })
      .from(runs)
      .innerJoin(conversations, eq(conversations.id, runs.conversationId))
      .innerJoin(messages, eq(messages.id, runs.assistantMessageId))
      .where(and(eq(runs.id, scope.runId), eq(runs.conversationId, scope.conversationId)))
      .get();
    return r && r.ownerId === scope.userId && r.endedAt === null ? r.messageId : undefined;
  }

  private callsLeft(runId: string, limit: number): boolean {
    return (this.calls.get(runId)?.n ?? 0) < limit;
  }

  private takeCall(runId: string): void {
    const t = this.now();
    this.calls.set(runId, { n: (this.calls.get(runId)?.n ?? 0) + 1, at: t });
    if (this.calls.size > 500)
      for (const [k, v] of this.calls) if (t - v.at > 6 * 3600_000) this.calls.delete(k);
  }

  /** `compose_video` (the MCP tool). Its result goes to the model, known secrets scrubbed. */
  async queue(
    scope: ToolScope,
    input: Record<string, unknown>,
    o: { alive?: (() => boolean) | undefined; signal?: AbortSignal | undefined } = {},
  ): Promise<SkillResult> {
    try {
      return { ok: true, output: scrubKnownDeep(await this.call(scope, input, o), { tail: false }) };
    } catch (e) {
      if (e instanceof ToolError) {
        const hint = e.hint ?? MEDIA_TOOL_HINTS[e.code];
        return { ok: false, code: e.code, ...(hint ? { hint: scrubKnown(hint, { tail: false }) } : {}) };
      }
      // Review r1: anything else (a folder that could not be made, a write that failed) never reaches the model as
      // its message — it could name a path of this server. A fixed code; the operator's log has the error.
      logEvent(this.o.log, "warn", "error", { userId: scope.userId, runId: scope.runId, err: e });
      return { ok: false, code: "media_failed", hint: MEDIA_TOOL_HINTS.media_failed! };
    }
  }

  private async call(
    scope: ToolScope,
    raw: Record<string, unknown>,
    o: { alive?: (() => boolean) | undefined; signal?: AbortSignal | undefined },
  ) {
    const settings = this.o.settings.get();
    if (!settings.composeEnabled || !this.started) throw new ToolError("compose_disabled");
    const composer = this.o.composer();
    if (!composer) throw new ToolError("compose_disabled");
    if (this.ready.ok !== true && !(await this.checkReady())) throw new ToolError("compose_disabled");
    if (!this.o.users.byId(scope.userId)?.active) throw new ToolError("media_not_allowed");
    if (!SAFE_ID.test(scope.userId) || !SAFE_ID.test(scope.conversationId))
      throw new ToolError("media_not_allowed");
    const messageId = this.replyOf(scope);
    if (!messageId) throw new ToolError("media_not_allowed");
    const alive = () => {
      try {
        return !!this.replyOf(scope) && (o.alive?.() ?? true) && !o.signal?.aborted && !this.stopping;
      } catch {
        return false;
      }
    };
    if (!alive()) throw new ToolError("media_cancelled");
    const parsed = z.strictObject(COMPOSE_VIDEO_TOOL.input).safeParse(raw);
    if (!parsed.success) throw new ToolError("compose_invalid_timeline", zodHint(parsed.error));
    const timeline = (parsed.data as { timeline: ComposeTimeline }).timeline;
    // The user's own texts first — before any other check answers about them (review R12).
    if (this.secret((timeline.subtitles ?? []).map((s) => s.text)))
      throw new ToolError("media_secret_blocked");
    const early = checkTimeline(timeline);
    if (early) throw new ToolError(early.code, early.hint);
    if (!this.callsLeft(scope.runId, settings.perRunLimits.compose)) throw new ToolError("media_quota");
    const files = this.o.files();
    if (!files) throw new ToolError("compose_disabled");
    const inputs = this.inputsOf(files, scope, timeline);
    if (!alive()) throw new ToolError("media_cancelled");
    // The reservation (review R7): a working folder, then one short write transaction.
    const dir = composer.workdir();
    const id = path.basename(dir);
    const at = this.now();
    let reserved: MediaToolCode | null;
    try {
      reserved = this.reserve(id, scope, messageId, timeline, at, files);
    } catch (e) {
      removeComposeWorkdir(dir);
      throw e;
    }
    if (reserved) {
      removeComposeWorkdir(dir);
      throw new ToolError(reserved);
    }
    this.takeCall(scope.runId);
    this.changed(id);
    const stop = new AbortController();
    const unlink = () => stop.abort();
    o.signal?.addEventListener("abort", unlink, { once: true });
    let slow = false;
    const timer = setTimeout(() => {
      slow = true;
      stop.abort();
    }, this.limits.prepareTimeoutMs);
    this.work.set(id, { stop });
    let outcome: { plan: Plan } | ToolError;
    try {
      outcome = await this.prepare(id, dir, composer, files, inputs, timeline, stop.signal);
    } catch {
      outcome = new ToolError("compose_input_unreadable");
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", unlink);
      this.work.delete(id);
    }
    if (!(outcome instanceof ToolError) && !alive()) outcome = new ToolError("media_cancelled");
    if (outcome instanceof ToolError) {
      this.discard(id, dir);
      if (slow)
        throw new ToolError(
          "compose_input_unreadable",
          `preparing the inputs took over ${Math.round(this.limits.prepareTimeoutMs / 1000)} s (use fewer or smaller files)`,
        );
      throw stop.signal.aborted && outcome.code !== "media_cancelled"
        ? new ToolError("media_cancelled")
        : outcome;
    }
    const { plan } = outcome;
    let queued: { changes: number };
    try {
      queued = this.o.db
        .update(composeJobs)
        .set({
          status: "queued",
          planJson: JSON.stringify(plan),
          durationMs: Math.round((plan.frames / FPS) * 1000),
          width: plan.width,
          height: plan.height,
          clips: plan.clips.length,
          subtitles: (timeline.subtitles ?? []).some((s) => cueText(s.text)),
          version: sql`${composeJobs.version} + 1`,
          updatedAt: this.now(),
        })
        .where(and(eq(composeJobs.id, id), eq(composeJobs.status, "preparing")))
        .run();
    } catch (e) {
      // Review r1: the write failed — the preparation's own clean-up (its row and folder; should that fail too, the
      // engine's next pass reaps a `preparing` row no call of this process holds).
      this.discard(id, dir);
      throw e;
    }
    if (queued.changes !== 1) {
      // Deleted (its conversation) or interrupted (the engine stopping) meanwhile.
      this.discard(id, dir);
      throw new ToolError("media_cancelled");
    }
    this.changed(id);
    logEvent(this.o.log, "info", "compose.queued", {
      userId: scope.userId,
      conversationId: scope.conversationId,
      runId: scope.runId,
      composeJobId: id,
    });
    setImmediate(() => void this.tick());
    const row = this.get(id);
    return {
      status: row?.status === "running" ? "running" : "queued",
      jobId: id,
      queuePosition: row ? this.position(row) : null,
      durationSec: plan.frames / FPS,
      width: plan.width,
      height: plan.height,
      clips: plan.clips.length,
      heldLastFrameSec: plan.held / FPS,
      note: "Not finished yet: the video is being put together on the server. A card under your reply shows its progress and then plays it — tell the user to check the card; never say the video is finished.",
    };
  }

  /** The timeline's files: this conversation's, sent with an active message (or made in one), of a usable kind. */
  private inputsOf(files: FileStore, scope: ToolScope, t: ComposeTimeline): FileRow[] {
    const wanted = [
      ...t.clips.map((c, i) => ({ id: c.fileId, where: `clips[${i}].fileId` })),
      ...(t.narration ?? []).map((n, i) => ({ id: n.fileId, where: `narration[${i}].fileId` })),
      ...(t.music ? [{ id: t.music.fileId, where: "music.fileId" }] : []),
    ];
    const rows = new Map<string, FileRow>();
    let bytes = 0;
    for (const w of wanted) {
      if (rows.has(w.id)) continue;
      const f = files.get(w.id);
      if (
        !f ||
        f.userId !== scope.userId ||
        f.conversationId !== scope.conversationId ||
        !files.isActiveAttachment(f)
      )
        throw new ToolError(
          "compose_input_missing",
          `${w.where}: not a file of this conversation (file_list)`,
        );
      if (!inputKindOf(f.kind)) throw new ToolError("compose_input_kind", `${w.where}: a ${f.kind} file`);
      bytes += f.bytes;
      rows.set(w.id, f);
    }
    if (bytes > this.limits.maxInputBytes)
      throw new ToolError("compose_too_long", "the inputs are over 2GB together");
    return [...rows.values()];
  }

  /** The slots, the file place and the `preparing` row — one `BEGIN IMMEDIATE` transaction. Null: reserved. */
  private reserve(
    id: string,
    scope: ToolScope,
    messageId: string,
    timeline: ComposeTimeline,
    at: number,
    files: FileStore,
  ): MediaToolCode | null {
    const { slots } = this.limits;
    return this.o.db.$client
      .transaction((): MediaToolCode | null => {
        const active = this.o.db
          .select({ ownerId: composeJobs.ownerId, status: composeJobs.status })
          .from(composeJobs)
          .where(inArray(composeJobs.status, ACTIVE))
          .all();
        if (active.filter((a) => a.ownerId === scope.userId).length >= slots.perUser) return "compose_busy";
        if (active.filter((a) => WAITING.includes(a.status)).length >= slots.waiting) return "compose_busy";
        if (
          files.placesTaken(scope.conversationId) + (this.o.filesPending?.(scope.conversationId) ?? 0) >=
          FILE_LIMITS.perConversation
        )
          return "media_file_limit";
        this.o.db
          .insert(composeJobs)
          .values({
            id,
            conversationId: scope.conversationId,
            ownerId: scope.userId,
            messageId,
            runId: scope.runId,
            status: "preparing",
            // Checked above (no known secret); scrubbed like every stored user text (and again by the rescrub).
            timelineJson: JSON.stringify(scrubKnownDeep(timeline)),
            durationMs: 0,
            width: 0,
            height: 0,
            clips: timeline.clips.length,
            subtitles: false,
            boot: this.boot,
            createdAt: at,
            updatedAt: at,
          })
          .run();
        return null;
      })
      .immediate();
  }

  /**
   * An ended job's row (`compose_failed`, nothing to run, nothing to notify) — the permission tests' fixture, and a
   * record for tests of the card's reads. Its id.
   */
  recordEnded(v: {
    conversationId: string;
    ownerId: string;
    messageId: string;
    timeline: ComposeTimeline;
  }): string {
    const id = crypto.randomUUID();
    const at = this.now();
    this.o.db
      .insert(composeJobs)
      .values({
        id,
        conversationId: v.conversationId,
        ownerId: v.ownerId,
        messageId: v.messageId,
        runId: "recorded",
        status: "failed",
        errorCode: "compose_failed",
        timelineJson: JSON.stringify(scrubKnownDeep(v.timeline)),
        durationMs: 2000,
        width: 1280,
        height: 720,
        clips: v.timeline.clips.length,
        subtitles: (v.timeline.subtitles ?? []).some((s) => cueText(s.text)),
        boot: this.boot,
        createdAt: at,
        updatedAt: at,
        endedAt: at,
        notifiedAt: at,
      })
      .run();
    return id;
  }

  /** The inputs copied (each file once, through the store's checked descriptor), probed, and the plan. */
  private async prepare(
    id: string,
    dir: string,
    composer: Composer,
    files: FileStore,
    rows: FileRow[],
    timeline: ComposeTimeline,
    signal: AbortSignal,
  ): Promise<{ plan: Plan } | ToolError> {
    const infos = new Map<string, InputInfo>();
    for (const [k, f] of rows.entries()) {
      if (signal.aborted) return new ToolError("media_cancelled");
      const name = `in-${k}.${FILE_KINDS[f.kind].exts[0]}`;
      const file = path.join(dir, "in", name);
      if (!(await copyStored(files, f, file, signal))) return new ToolError("compose_input_unreadable");
      if (signal.aborted) return new ToolError("media_cancelled");
      const p = await composer.probe(file, f.kind, signal);
      if (!p.ok)
        return p.reason === "kind"
          ? new ToolError("compose_input_kind")
          : new ToolError("compose_input_unreadable", `${f.id}: could not be read (${p.reason})`);
      infos.set(f.id, { ...p.info, fileId: f.id, name });
    }
    if (!this.get(id)) return new ToolError("media_cancelled");
    const plan = planTimeline(timeline, infos);
    if (isPlanError(plan)) return new ToolError(plan.code, plan.hint);
    return { plan };
  }

  /** A preparation that did not end queued: its row (still preparing) and its folder go. */
  private discard(id: string, dir: string): void {
    try {
      this.o.db
        .delete(composeJobs)
        .where(and(eq(composeJobs.id, id), eq(composeJobs.status, "preparing")))
        .run();
    } catch {
      // a row left preparing is reaped by the engine's next pass (or interrupted by the next start)
    }
    removeComposeWorkdir(dir);
    this.changed(id);
  }

  // ---------------------------------------------------------------- the engine

  get started(): boolean {
    return !!this.timer && !this.stopping;
  }

  /** The engine's start (the lock-holding server, at onReady). Never throws; calling it again is harmless. */
  start(): void {
    if (this.timer || this.stopping) return;
    this.timer = setInterval(() => void this.tick(), this.limits.tickMs);
    this.timer.unref();
    void this.checkReady();
    void this.tick();
  }

  /** No new work; the job under way stops and every job not ended is `compose_interrupted`; streams close. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const done = [...this.work.values()].map((w) => w.done).filter(Boolean);
    for (const w of this.work.values()) w.stop.abort();
    await Promise.race([Promise.all(done), new Promise((r) => setTimeout(r, 10_000).unref())]);
    try {
      this.interrupt(true);
    } catch {
      // the next start does it
    }
    for (const close of [...this.streams]) close();
  }

  /** Every job's work under way here, ended (tests). */
  async idle(): Promise<void> {
    for (;;) {
      const done = [...this.work.values()].map((w) => w.done).filter(Boolean);
      if (!done.length) return;
      await Promise.all(done);
    }
  }

  /**
   * Every job not ended `compose_interrupted`: of other processes (the start), or — `mine` — this one's too (the
   * stop). One statement.
   */
  private interrupt(mine: boolean): void {
    const at = this.now();
    const ids = this.o.db
      .select({ id: composeJobs.id })
      .from(composeJobs)
      .where(
        and(inArray(composeJobs.status, ACTIVE), ...(mine ? [] : [sql`${composeJobs.boot} <> ${this.boot}`])),
      )
      .all()
      .map((r) => r.id);
    if (!ids.length) return;
    this.o.db
      .update(composeJobs)
      .set({
        status: "failed",
        errorCode: "compose_interrupted",
        endedAt: at,
        version: sql`${composeJobs.version} + 1`,
        updatedAt: at,
      })
      .where(
        and(inArray(composeJobs.status, ACTIVE), ...(mine ? [] : [sql`${composeJobs.boot} <> ${this.boot}`])),
      )
      .run();
    for (const id of ids) {
      this.changed(id);
      logEvent(this.o.log, "warn", "compose.failed", {
        composeJobId: id,
        composeCode: "compose_interrupted",
      });
    }
  }

  /** The start's recovery: other processes' jobs interrupted, every working folder not of this process's work gone. */
  private recover(): void {
    this.interrupt(false);
    this.recovered = true;
    this.sweep();
  }

  private sweep(): void {
    this.swept = sweepComposeScratch(
      this.o.dataDir,
      (name) => this.work.has(name) || this.isMineActive(name),
    );
    if (!this.swept) logEvent(this.o.log, "warn", "media.sweep_failed");
  }

  private isMineActive(id: string): boolean {
    const r = this.get(id);
    return !!r && COMPOSE_ACTIVE.has(r.status) && r.boot === this.boot;
  }

  /** One pass (the timer's; tests call it directly). Never throws. Resolves when the job it started has ended. */
  tick(): Promise<void> {
    if (!this.started) return Promise.resolve();
    const step = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        logEvent(this.o.log, "warn", "error", { err: e });
      }
    };
    if (!this.recovered) step(() => this.recover());
    else if (!this.swept) step(() => this.sweep());
    step(() => this.reap());
    step(() => this.notifyDue());
    let started: Promise<unknown> | undefined;
    step(() => (started = this.startNext()));
    return (started ?? Promise.resolve()).then(
      () => undefined,
      () => undefined,
    );
  }

  /**
   * Rows of this process that no work holds any more (review r1): a `preparing` row whose call's clean-up failed (its
   * row and folder go — the slot and the file place free), a `running` row whose end could not be written
   * (`compose_failed`). Never a row whose call or run is under way here.
   */
  private reap(): void {
    for (const r of this.o.db
      .select({ id: composeJobs.id, status: composeJobs.status })
      .from(composeJobs)
      .where(and(inArray(composeJobs.status, ["preparing", "running"]), eq(composeJobs.boot, this.boot)))
      .all()) {
      if (this.work.has(r.id) || this.executor?.id === r.id) continue;
      if (r.status === "preparing") this.discard(r.id, this.folderOf(r.id));
      else this.finish(r.id, "compose_failed");
    }
  }

  /** The oldest queued job of this process, running — when none runs (one at a time in all). */
  private startNext(): Promise<unknown> | undefined {
    if (!this.recovered || this.executor || this.stopping) return undefined;
    const busy = this.o.db
      .select({ id: composeJobs.id })
      .from(composeJobs)
      .where(eq(composeJobs.status, "running"))
      .get();
    if (busy) return undefined;
    const next = this.o.db
      .select()
      .from(composeJobs)
      .where(and(eq(composeJobs.status, "queued"), eq(composeJobs.boot, this.boot)))
      .orderBy(asc(composeJobs.createdAt), asc(composeJobs.id))
      .get();
    if (!next) return undefined;
    const at = this.now();
    const r = this.o.db
      .update(composeJobs)
      .set({
        status: "running",
        startedAt: at,
        progress: 0,
        version: sql`${composeJobs.version} + 1`,
        updatedAt: at,
      })
      .where(and(eq(composeJobs.id, next.id), eq(composeJobs.status, "queued")))
      .run();
    if (r.changes !== 1) return undefined;
    // The row is `running`: its executor takes the slot in this same synchronous step (nothing between can throw).
    const stop = new AbortController();
    const done = this.execute(next, stop.signal);
    this.executor = { id: next.id, done };
    this.work.set(next.id, { stop, done });
    return done;
  }

  /**
   * A job's executor: everything after the row became `running` — the cards told, the composition, its file — and,
   * whatever fails on the way, its end and the slot's release. Never rejects.
   */
  private async execute(next: ComposeJobRow, signal: AbortSignal): Promise<void> {
    const id = next.id;
    try {
      // After the slot is taken (`startNext` registers it right after this call returns).
      await Promise.resolve();
      this.changed(id);
      // The others' queue positions moved too.
      this.queuedChanged();
      logEvent(this.o.log, "info", "compose.started", {
        userId: next.ownerId,
        conversationId: next.conversationId,
        composeJobId: id,
      });
      await this.run(id, signal);
    } catch (e) {
      logEvent(this.o.log, "warn", "error", { composeJobId: id, err: e });
      try {
        this.finish(id, "compose_failed");
      } catch {
        // reaped by a later pass (or interrupted by the next start)
      }
    } finally {
      this.work.delete(id);
      if (this.executor?.id === id) this.executor = undefined;
      if (!this.stopping) setImmediate(() => void this.tick());
    }
  }

  /** One job: the composition, its check and its file — or why not. Its folder goes at the end, whatever happened. */
  private async run(id: string, signal: AbortSignal): Promise<void> {
    const dir = path.join(storagePaths(this.o.dataDir).composeScratch, id);
    const realDir = (() => {
      try {
        return fs.realpathSync.native(dir);
      } catch {
        return dir;
      }
    })();
    try {
      const row = this.get(id);
      const composer = this.o.composer();
      if (!row || row.status !== "running") return;
      if (!composer || !row.planJson) return void this.finish(id, "compose_failed");
      const plan = JSON.parse(row.planJson) as Plan;
      let subs: string | null = null;
      if (row.subtitles) {
        const t = ComposeTimeline.safeParse(scrubKnownDeep(JSON.parse(row.timelineJson) as unknown));
        subs = t.success && t.data.subtitles?.some((x) => cueText(x.text)) ? toAss(t.data.subtitles) : null;
      }
      const deadlineAt = this.now() + this.limits.timeoutMs;
      const deadline = new AbortController();
      // Review r1: the deadline holds until the file is committed — its moment ends the job at once (its row: the
      // users' slots and the file place free); the work stops, and a store still waiting for the file lock finds the
      // job no longer running (nothing is committed late). The engine's slot is its executor's until that ends.
      const timer = setTimeout(
        () => {
          deadline.abort();
          try {
            this.finish(id, "compose_timeout");
          } catch {
            // reaped by a later pass
          }
        },
        Math.max(1, deadlineAt - this.now()),
      );
      const both = AbortSignal.any([signal, deadline.signal]);
      let lastWrite = 0;
      try {
        const outcome = await composer.compose({
          dir: realDir,
          plan,
          subs,
          signal: both,
          deadlineAt: Date.now() + (deadlineAt - this.now()),
          onProgress: (f) => {
            const t = this.now();
            if (t - lastWrite < this.limits.progressMs && f < 1) return;
            lastWrite = t;
            this.progress(id, Math.min(99, Math.floor(f * 100)));
          },
        });
        if (signal.aborted) return; // deleted, or the engine stopping (`stop` interrupts it)
        if (deadline.signal.aborted) return void this.finish(id, "compose_timeout");
        if (!outcome.ok) return void this.finish(id, outcome.code);
        await this.store(id, outcome.file, outcome.bytes, deadline.signal);
      } finally {
        clearTimeout(timer);
      }
    } finally {
      removeComposeWorkdir(realDir);
    }
  }

  private progress(id: string, pct: number): void {
    try {
      const r = this.o.db
        .update(composeJobs)
        .set({ progress: pct, version: sql`${composeJobs.version} + 1`, updatedAt: this.now() })
        .where(and(eq(composeJobs.id, id), eq(composeJobs.status, "running")))
        .run();
      if (r.changes === 1) this.changed(id);
    } catch {
      // only the bar
    }
  }

  /** The checked MP4 as a file of the conversation: the file row, `file_id` and `done` in one transaction. */
  private async store(id: string, file: string, bytes: number, deadline: AbortSignal): Promise<void> {
    const row = this.get(id);
    const files = this.o.files();
    if (!row || row.status !== "running") return;
    if (!files) return void this.finish(id, "compose_store_failed");
    let sha256: string;
    try {
      sha256 = await hashFile(file);
    } catch {
      return void this.finish(id, "compose_store_failed");
    }
    if (deadline.aborted) return void this.finish(id, "compose_timeout");
    try {
      await files.addGenerated({
        userId: row.ownerId,
        conversationId: row.conversationId,
        messageId: row.messageId,
        name: `compose-${stamp(this.now())}.mp4`,
        kind: "mp4",
        bytes,
        sha256,
        tmp: file,
        // Inside the file-write lock: the job is still this one, running, without a file (review R8).
        guard: () => {
          if (deadline.aborted) return false;
          const r = this.get(id);
          return !!r && r.status === "running" && r.fileId === null;
        },
        video: {
          jobId: id,
          commit: (f) =>
            this.o.db
              .update(composeJobs)
              .set({
                status: "done",
                fileId: f.id,
                progress: 100,
                endedAt: this.now(),
                version: sql`${composeJobs.version} + 1`,
                updatedAt: this.now(),
              })
              .where(and(eq(composeJobs.id, id), eq(composeJobs.status, "running")))
              .run().changes === 1,
        },
      });
    } catch (e) {
      // A cancel is not always a delete (review r1, P1): the `done` write itself may have failed. The row says which —
      // gone or ended (its conversation deleted, the deadline, the engine stopping): nothing more; still running: it
      // ends here (the one running slot and its file place free). Should that write fail too, a later pass reaps it.
      if (e instanceof FileAddCancelledError) {
        let still: boolean;
        try {
          still = this.get(id)?.status === "running";
        } catch {
          return;
        }
        if (still) this.finish(id, deadline.aborted ? "compose_timeout" : "compose_store_failed");
        return;
      }
      return void this.finish(id, "compose_store_failed");
    }
    this.changed(id);
    const done = this.get(id);
    if (!done) return;
    logEvent(this.o.log, "info", "compose.done", {
      userId: done.ownerId,
      conversationId: done.conversationId,
      composeJobId: id,
    });
    this.notify(done);
  }

  /** A running job's end without its video. Null when it had already ended or is gone. */
  private finish(id: string, code: ComposeJobCode): ComposeJobRow | null {
    const at = this.now();
    const r = this.o.db
      .update(composeJobs)
      .set({
        status: "failed",
        errorCode: code,
        endedAt: at,
        version: sql`${composeJobs.version} + 1`,
        updatedAt: at,
      })
      .where(and(eq(composeJobs.id, id), inArray(composeJobs.status, ACTIVE)))
      .run();
    if (r.changes !== 1) return null;
    this.changed(id);
    const row = this.get(id);
    if (!row) return null;
    logEvent(this.o.log, "warn", "compose.failed", {
      userId: row.ownerId,
      conversationId: row.conversationId,
      composeJobId: id,
      composeCode: code,
    });
    this.notify(row);
    return row;
  }

  /**
   * The owner's notification of a job's end, once (`notified_at`: published, or refused for good); a publish that
   * failed is tried again after its own backoff (`notify_next_at`). The link opens the conversation.
   */
  private notify(row: ComposeJobRow): void {
    if (row.status !== "done" && row.status !== "failed") return;
    const n = this.o.notifications();
    if (!n) return;
    const kind = row.status === "done" ? "compose_done" : "compose_failed";
    let ok: boolean;
    try {
      if (n.wants?.(row.ownerId, kind) ?? true) {
        const url = `/c/${row.conversationId}`;
        const ref = { kind: "conversation", id: row.conversationId };
        const input: PublishInput =
          kind === "compose_done"
            ? { kind, url, ref }
            : {
                kind,
                reason:
                  COMPOSE_FAILURE_SHORT[(row.errorCode as ComposeJobCode | null) ?? "compose_failed"] ??
                  "실패",
                url,
                ref,
              };
        const opts = { dedupeKey: `compose:${row.id}:end` };
        const outcome = n.publishOutcome
          ? n.publishOutcome(row.ownerId, input, opts).status
          : n.publish(row.ownerId, input, opts) === undefined
            ? "refused"
            : "published";
        ok = outcome !== "failed";
      } else ok = true;
      if (ok)
        this.o.db
          .update(composeJobs)
          .set({ notifiedAt: this.now() })
          .where(and(eq(composeJobs.id, row.id), sql`${composeJobs.notifiedAt} IS NULL`))
          .run();
    } catch {
      ok = false;
    }
    if (ok) return;
    try {
      const tries = row.notifyTries + 1;
      this.o.db
        .update(composeJobs)
        .set({
          notifyTries: tries,
          notifyNextAt: this.now() + Math.min(5 * 60_000, this.limits.notifyRetryMs * 2 ** (tries - 1)),
        })
        .where(and(eq(composeJobs.id, row.id), sql`${composeJobs.notifiedAt} IS NULL`))
        .run();
    } catch {
      // asked again by the next pass
    }
  }

  /** The ends whose notification is due (never tried, or its retry time passed), oldest first. */
  private notifyDue(): void {
    const at = this.now();
    for (const r of this.o.db
      .select()
      .from(composeJobs)
      .where(
        and(
          inArray(composeJobs.status, ["done", "failed"]),
          sql`${composeJobs.notifiedAt} IS NULL`,
          sql`coalesce(${composeJobs.notifyNextAt}, 0) <= ${at}`,
        ),
      )
      .orderBy(sql`coalesce(${composeJobs.notifyNextAt}, 0)`, asc(composeJobs.endedAt))
      .limit(20)
      .all())
      this.notify(r);
  }
}

/** A stored file's bytes copied through the store's checked descriptor (`FileStore.open`): its size and hash agree. */
async function copyStored(files: FileStore, f: FileRow, to: string, signal: AbortSignal): Promise<boolean> {
  const fd = files.open(f);
  if (fd === undefined) return false;
  let out: number | undefined;
  try {
    out = fs.openSync(
      to,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    const hash = crypto.createHash("sha256");
    const buf = Buffer.allocUnsafe(1 << 20);
    let total = 0;
    for (;;) {
      if (signal.aborted) return false;
      const n = await new Promise<number>((resolve, reject) =>
        fs.read(fd, buf, 0, buf.length, null, (e, got) => (e ? reject(e) : resolve(got))),
      );
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
      let off = 0;
      while (off < n) off += fs.writeSync(out, buf, off, n - off);
      total += n;
      if (total > f.bytes) return false;
    }
    return total === f.bytes && hash.digest("hex") === f.sha256;
  } catch {
    return false;
  } finally {
    fs.closeSync(fd);
    if (out !== undefined) fs.closeSync(out);
  }
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(file);
    s.on("data", (c) => h.update(c));
    s.on("error", reject);
    s.on("end", () => resolve(h.digest("hex")));
  });
}
