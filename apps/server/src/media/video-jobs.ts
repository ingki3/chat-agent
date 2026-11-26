import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { SkillResult, ToolScope } from "@agentlee/mcp-tools";
import { VIDEO_GENERATE_TOOL } from "@agentlee/mcp-tools/media";
import {
  FILE_LIMITS,
  MEDIA_TOOL_HINTS,
  VIDEO_ACTIVE,
  VIDEO_LIMITS,
  type MediaToolCode,
  type VideoJob,
  type VideoJobCode,
  type VideoJobStatus,
} from "@agentlee/shared";
import type { UserStore } from "../auth/users.js";
import type { Db } from "../db/client.js";
import { conversations, messages, runs, videoJobs } from "../db/schema.js";
import type { ConversationStore } from "../conversations/store.js";
import { FileAddCancelledError, FileLimitError, StoreLinkError, type FileStore } from "../files/store.js";
import { logEvent, type EventLogger } from "../logging.js";
import type { PublishInput } from "../notifications/compose.js";
import { carriesSecret } from "../secrets/egress.js";
import { scrubKnown, scrubKnownDeep } from "../secrets/known.js";
import { mediaRunKey, type UsageStore } from "../usage/store.js";
import type { MediaBudget } from "./budget.js";
import type { OpenRouterKeys } from "./keys.js";
import {
  MEDIA_CATALOG_URLS,
  MediaHttpError,
  OPENROUTER_VIDEOS_URL,
  openRouterGet,
  openRouterPost,
  readBytes,
  VIDEO_JOB_ID,
  videoContentUrl,
  videoGet,
  videoStatusUrl,
} from "./openrouter.js";
import { withMediaPolicy } from "./policy.js";
import type { MediaSettingsStore } from "./settings.js";
import { makeVideoWorkdir, removeVideoWorkdir, sweepVideoScratch, type VideoProbe } from "./video-probe.js";
import { isPlanError, planVideo, replanVideo, videoRecordOf, type VideoRecord } from "./video-plan.js";

/**
 * `video_generate` and its jobs (#238 stage 3 — docs/decisions/media-generation.md §14, the user's 확정 사항 and the
 * plan review's 11 items). The tool only makes a **confirmation card** (a `video_jobs` row `awaiting_approval`) —
 * nothing is reserved or sent. The conversation's owner approves it (`approve`, the card's version), and only then:
 *
 * 1. the card is still what was approved (version), not expired (24 h), made under the same settings revision, model
 *    and key mark (else it expires — `video_settings_changed`); the media recovery is done; ffprobe is here;
 * 2. the model's record is read again (async, before anything is written): the card's exact length, resolution and
 *    aspect ratio are still offered (else it expires — `video_options_changed`) and the bound now is not above the
 *    card's (else the card is re-priced, version + 1, and nothing is sent: `video_estimate_changed`);
 * 3. what would be sent passes the egress check (registered and configured secrets: model, prompt, options, URL);
 * 4. **one synchronous step, one write transaction** (review item 2): the row and every check above again, the slots
 *    (2 per user, 4 in all — DB-counted), a file place (the conversation's files and the places held by other approved
 *    jobs), the daily budget for the bound at the approval's moment (its day is the day the cost counts for), the
 *    usage row (`video_job`, the bound) and `submitting` (version + 1, deadline = now + 60 min) — or none of it;
 * 5. `POST /videos`: a 202 with a valid id is `pending`; a 4xx (not billed) releases the bound and fails the job; no
 *    answer, a 5xx or an unreadable 202 keeps the bound (`video_unconfirmed`) — never sent again.
 *
 * **The engine** (only the lock-holding server runs it) keeps no state of its own: the row is the job — its status,
 * `deadline_at` (approval + 60 min), `next_at` (when it is handled next), `failures` (the backoff), the key mark it
 * was approved under. A pass (every 5 s) never throws and goes: the start's recovery until it succeeded once (until
 * then nothing is approved), **deadlines first** — a running job past its deadline is `video_timeout` whatever it is
 * doing, its work stopped (a settled cost stays, else the bound) —, waiting cards that no longer stand, refused
 * submits' bounds, due notifications, then the due jobs by `next_at` (each leased while its work runs). Only the work
 * under way has an in-memory stop. Polls (30 s; 404, 429, 5xx and no answer back off up to 5 min; 410 is gone) go only
 * with the key the job was approved under. `completed`: its `usage.cost` is settled at once, the video streamed into
 * `video-scratch/<uuid>` (fixed host, validated id, no redirect, 1GB guard), checked by ffprobe and stored with
 * `files.addGenerated` — the file row, `file_id` and `done` in one transaction, inside the file lock and only while
 * the job is still `downloading` and before its deadline. A deleted conversation: its jobs' bounds are resolved in the
 * delete's own transaction (a refusal's released, others `unconfirmed`, a settled cost kept), their work stopped. A
 * `submitting` row whose submit is not under way here (a restart, a lost write) is `video_unconfirmed` — never sent
 * again. Notifications: once, by `notified_at`, a failed one retried with its own backoff (`notify_next_at`).
 */
export type VideoJobRow = typeof videoJobs.$inferSelect;

export class VideoError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly job?: VideoJobRow,
  ) {
    super(code);
  }
}

class ToolError extends Error {
  constructor(
    readonly code: MediaToolCode,
    readonly hint?: string,
  ) {
    super(code);
  }
}

export type VideoNotify = {
  publish(userId: string, input: PublishInput, opts?: { dedupeKey?: string }): string | undefined;
  /** Review r2: whether it was published, refused for good, or failed for now (then tried again). */
  publishOutcome?(
    userId: string,
    input: PublishInput,
    opts?: { dedupeKey?: string },
  ): { status: "published" | "refused" | "failed"; id?: string };
  wants?(userId: string, kind: "video_done" | "video_failed"): boolean;
};

type Limits = {
  cardTtlMs: number;
  deadlineMs: number;
  pollMs: number;
  maxBackoffMs: number;
  requestTimeoutMs: number;
  downloadTimeoutMs: number;
  maxBytes: number;
  slots: { total: number; perUser: number };
  /** How often the engine looks for due jobs and expired cards. */
  tickMs: number;
  /** The first wait of a failed write kept trying by a job's own work (doubling, at most 30 s). */
  retryMs: number;
};

export type VideoJobsOptions = {
  db: Db;
  files: () => FileStore | undefined;
  conversations: Pick<ConversationStore, "onDelete" | "onDeleted">;
  keys: Pick<OpenRouterKeys, "snapshot" | "mark">;
  settings: Pick<MediaSettingsStore, "get" | "revision">;
  budget: Pick<MediaBudget, "allowsMicros">;
  usage:
    | Pick<
        UsageStore,
        "reserveMedia" | "settleMedia" | "releaseMedia" | "releaseVideoMedia" | "unconfirmVideoMedia"
      >
    | undefined;
  users: Pick<UserStore, "byId">;
  notifications: () => VideoNotify | undefined;
  /** While the previous process's media reservations are not taken up, nothing is approved (`video_recovering`). */
  recovering?: () => boolean;
  /** Files image/speech calls of this conversation are making right now (they take places too). */
  filesPending?: (conversationId: string) => number;
  /** ffprobe, resolved per approval and per check (undefined: not on this server — nothing is approved). */
  probe: () => VideoProbe | undefined;
  dataDir: string;
  fetchImpl?: typeof fetch | undefined;
  /** The `.env` skill secrets: the egress check knows them too. */
  secrets?: Readonly<Record<string, string>> | undefined;
  log?: EventLogger | undefined;
  now?: () => number;
  limits?: Partial<Limits>;
};

const DEFAULTS: Limits = {
  cardTtlMs: VIDEO_LIMITS.cardTtlMs,
  deadlineMs: VIDEO_LIMITS.deadlineMs,
  pollMs: VIDEO_LIMITS.pollMs,
  maxBackoffMs: VIDEO_LIMITS.maxBackoffMs,
  requestTimeoutMs: VIDEO_LIMITS.requestTimeoutMs,
  downloadTimeoutMs: VIDEO_LIMITS.downloadTimeoutMs,
  maxBytes: VIDEO_LIMITS.maxBytes,
  slots: VIDEO_LIMITS.slots,
  tickMs: 5_000,
  retryMs: 1_000,
};

const ACTIVE = [...VIDEO_ACTIVE] as VideoJobStatus[];
/** A submit OpenRouter refused before it was billed (4xx, or refused here): its bound is released. */
const REFUSED: readonly VideoJobCode[] = ["video_rejected", "video_payment", "video_rate_limited"];
const POLLED: VideoJobStatus[] = ["pending", "in_progress", "downloading"];
/** How long a job's work may hold it (a poll, a download, its check, the file lock) before a pass picks it again. */
const LEASE_MS = (l: { requestTimeoutMs: number; downloadTimeoutMs: number }) =>
  l.requestTimeoutMs + l.downloadTimeoutMs + 2 * 60_000;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A poll answer is small (ids, URLs, usage); anything bigger is not read. */
const STATUS_MAX = 256 * 1024;
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
/** The provider's moderation, as OpenRouter's `error` strings say it — mapped to a fixed code, never stored. */
const MODERATION = /moderat|content polic|safety|nsfw/i;

/** `20261126-153012` (UTC) for a file name. */
const stamp = (t: number) => new Date(t).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

export class VideoJobs {
  private readonly events = new EventEmitter();
  private readonly now: () => number;
  private readonly limits: Limits;
  /** Per run, the calls of `video_generate` (the admin's per-run limit). */
  private readonly calls = new Map<string, { n: number; at: number }>();
  /**
   * The only in-memory state of a running job: the stop of its request or file work under way in this process (its
   * submit, a poll, a download), and its end. Never what decides a job's state — the row does (`next_at`,
   * `deadline_at`); a restart loses these and the rows say the same.
   */
  private readonly inflight = new Map<string, { stop: AbortController; done: Promise<unknown> }>();
  private readonly streams = new Set<() => void>();
  /**
   * Job ids of a conversation being deleted, by conversation: only a delete that committed (`onDeleted`) stops them;
   * a rolled-back delete's entry is replaced by the next delete of that conversation.
   */
  private readonly deleting = new Map<string, string[]>();
  /** Until when the probe's readiness (a known-good MP4 checked in the sandbox) holds. */
  private probeOkUntil = 0;
  private timer: NodeJS.Timeout | undefined;
  private stopping = false;
  /** The first pass's recovery succeeded (until then nothing is approved: `video_recovering`). */
  private recovered = false;
  /**
   * Whether the last process's download folders are all gone (review r4: a sweep that failed is tried again by later
   * passes — around the folders of downloads under way now, `workdirs`). Clean-up only: no job's state depends on it.
   */
  private swept = false;
  private readonly workdirs = new Set<string>();
  /** This process (the card keeps the newest of two equal versions from different processes). */
  readonly boot = crypto.randomBytes(6).toString("hex");

  constructor(private readonly o: VideoJobsOptions) {
    this.now = o.now ?? Date.now;
    this.limits = { ...DEFAULTS, ...o.limits };
    this.events.setMaxListeners(0);
    // Review item 5: a deleted conversation's jobs — their bounds fixed in the delete's own transaction (a settled
    // cost stays settled, an open bound becomes `unconfirmed`: kept for good), then their requests stopped.
    o.conversations.onDelete((conversationId) => {
      const rows = this.o.db
        .select({
          id: videoJobs.id,
          usageKey: videoJobs.usageKey,
          status: videoJobs.status,
          errorCode: videoJobs.errorCode,
        })
        .from(videoJobs)
        .where(eq(videoJobs.conversationId, conversationId))
        .all();
      // Review r2: no reservation of the conversation is left unresolved — a refusal's (never billed) goes, every
      // other still held is `unconfirmed` (kept for good), a settled cost stays (both only touch `video_job` rows).
      for (const r of rows) {
        if (!r.usageKey) continue;
        if (r.status === "failed" && REFUSED.includes(r.errorCode as VideoJobCode))
          this.o.usage?.releaseVideoMedia(r.usageKey);
        else this.o.usage?.unconfirmVideoMedia(r.usageKey);
      }
      this.deleting.set(
        conversationId,
        rows.map((r) => r.id),
      );
    });
    o.conversations.onDeleted((c) => {
      const ids = this.deleting.get(c.id) ?? [];
      this.deleting.delete(c.id);
      for (const id of ids) {
        this.inflight.get(id)?.stop.abort();
        this.changed(id);
      }
    });
  }

  // ---------------------------------------------------------------- reading

  get(id: string): VideoJobRow | undefined {
    return this.o.db.select().from(videoJobs).where(eq(videoJobs.id, id)).get();
  }

  /** The card as the API sends it (the stored video's name and size with it). */
  view(row: VideoJobRow): VideoJob {
    const f = row.fileId ? this.o.files()?.get(row.fileId) : undefined;
    return scrubKnownDeep(
      {
        id: row.id,
        conversationId: row.conversationId,
        messageId: row.messageId,
        status: row.status,
        model: row.model,
        prompt: row.prompt,
        durationSec: row.durationSec,
        resolution: row.resolution,
        aspectRatio: row.aspectRatio,
        audio: row.audio ?? null,
        estimateUsd: row.estimateMicros / 1_000_000,
        costUsd: row.costMicros === null ? null : row.costMicros / 1_000_000,
        version: row.version,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        approvedAt: row.approvedAt,
        deadlineAt: row.deadlineAt,
        endedAt: row.endedAt,
        errorCode: (row.errorCode as VideoJobCode | null) ?? null,
        progress: row.progress,
        file: f && row.status === "done" ? { fileId: f.id, name: f.name, bytes: f.bytes } : null,
        boot: this.boot,
      },
      { tail: false },
    );
  }

  /** Called with the job's id after every change of it (the card's live progress). */
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

  /** A progress stream (routes): closed by `stop`. Returns the function that forgets it. */
  addStream(close: () => void): () => void {
    this.streams.add(close);
    return () => void this.streams.delete(close);
  }

  private changed(id: string): void {
    this.events.emit("change", id);
  }

  // ---------------------------------------------------------------- the tool: a card, nothing paid

  private secret(texts: readonly string[]): boolean {
    return carriesSecret(texts, { config: Object.values(this.o.secrets ?? {}) });
  }

  private takeCall(runId: string, limit: number): boolean {
    const t = this.now();
    const used = this.calls.get(runId)?.n ?? 0;
    if (used >= limit) return false;
    this.calls.set(runId, { n: used + 1, at: t });
    if (this.calls.size > 500)
      for (const [k, v] of this.calls) if (t - v.at > 6 * 3600_000) this.calls.delete(k);
    return true;
  }

  /** The run's reply, when the run is this user's and still open. */
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

  /** The model's record in `/videos/models`, read now; undefined when the list has no such model. */
  private async record(model: string, apiKey: string): Promise<VideoRecord | undefined> {
    const answer = await openRouterGet(MEDIA_CATALOG_URLS.video, {
      apiKey,
      ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
    });
    if (!isObj(answer) || !Array.isArray(answer.data)) throw new Error("not a catalog");
    return videoRecordOf(answer, model);
  }

  /** `video_generate` (the MCP tool): the card. Its result goes to the model, known secrets scrubbed. */
  async propose(
    scope: ToolScope,
    input: Record<string, unknown>,
    o: { alive?: (() => boolean) | undefined; signal?: AbortSignal | undefined } = {},
  ): Promise<SkillResult> {
    try {
      return { ok: true, output: scrubKnownDeep(await this.card(scope, input, o), { tail: false }) };
    } catch (e) {
      if (e instanceof ToolError) {
        const hint = e.hint ?? MEDIA_TOOL_HINTS[e.code];
        return { ok: false, code: e.code, ...(hint ? { hint: scrubKnown(hint, { tail: false }) } : {}) };
      }
      throw e;
    }
  }

  private async card(
    scope: ToolScope,
    raw: Record<string, unknown>,
    o: { alive?: (() => boolean) | undefined; signal?: AbortSignal | undefined },
  ) {
    const parsed = z.strictObject(VIDEO_GENERATE_TOOL.input).safeParse(raw);
    if (!parsed.success) throw new ToolError("media_bad_input");
    const input = parsed.data as {
      prompt: string;
      durationSec?: number;
      resolution?: string;
      aspectRatio?: string;
    };
    const revision = this.o.settings.revision();
    const settings = this.o.settings.get();
    const k = settings.kinds.video;
    if (!k.enabled || !k.model) throw new ToolError("media_disabled");
    const model = k.model;
    const snap = this.o.keys.snapshot();
    if (!snap.ok) throw new ToolError("media_lookup_failed");
    if (!snap.key) throw new ToolError("media_no_key");
    const key = snap.key;
    const mark = snap.key.mark;
    if (!this.o.users.byId(scope.userId)?.active) throw new ToolError("media_not_allowed");
    if (!SAFE_ID.test(scope.userId) || !SAFE_ID.test(scope.conversationId))
      throw new ToolError("media_not_allowed");
    const messageId = this.replyOf(scope);
    if (!messageId) throw new ToolError("media_not_allowed");
    const alive = () => {
      try {
        return !!this.replyOf(scope) && (o.alive?.() ?? true) && !o.signal?.aborted;
      } catch {
        return false;
      }
    };
    if (!alive()) throw new ToolError("media_cancelled");
    // The user's own texts first — before any option check answers about them.
    if (this.secret([input.prompt, input.resolution ?? "", input.aspectRatio ?? "", model]))
      throw new ToolError("media_secret_blocked");
    let record: VideoRecord | undefined;
    try {
      record = await this.record(model, key.key);
    } catch {
      throw new ToolError("media_lookup_failed");
    }
    if (!record) throw new ToolError("media_video_unsupported");
    const plan = planVideo(record, input, settings.videoDefaultSec);
    if (isPlanError(plan)) throw new ToolError(plan.code, "hint" in plan ? plan.hint : undefined);
    // The admin may have changed something meanwhile.
    const nowKind = this.o.settings.get().kinds.video;
    if (
      this.o.settings.revision() !== revision ||
      this.o.keys.mark() !== mark ||
      !nowKind.enabled ||
      nowKind.model !== model
    )
      throw new ToolError("media_changed");
    if (this.secret(this.sent(model, input.prompt, plan))) throw new ToolError("media_secret_blocked");
    if (!this.takeCall(scope.runId, settings.perRunLimits.video)) throw new ToolError("media_quota");
    if (!alive()) throw new ToolError("media_cancelled");
    const at = this.now();
    // A card whose bound does not fit what is left today is not made (it could never be approved today).
    if (!this.o.budget.allowsMicros(scope.userId, plan.micros, at)) throw new ToolError("media_budget");
    const id = this.createCard(
      {
        conversationId: scope.conversationId,
        ownerId: scope.userId,
        messageId,
        runId: scope.runId,
        model,
        // Checked above; scrubbed like every stored user text (and again by the background rescrub).
        prompt: scrubKnown(input.prompt),
        durationSec: plan.durationSec,
        resolution: plan.resolution,
        aspectRatio: plan.aspectRatio,
        audio: plan.audio,
        estimateMicros: plan.micros,
        settingsRevision: revision,
        keyMark: mark,
      },
      at,
    );
    logEvent(this.o.log, "info", "video.proposed", {
      userId: scope.userId,
      conversationId: scope.conversationId,
      runId: scope.runId,
      videoJobId: id,
    });
    return {
      status: "awaiting_approval",
      jobId: id,
      model,
      durationSec: plan.durationSec,
      resolution: plan.resolution,
      aspectRatio: plan.aspectRatio,
      audio: plan.audio,
      estimateUsd: plan.micros / 1_000_000,
      note: "Not made yet: a confirmation card is shown under your reply, and the video is generated only after the user approves it there. Tell the user to check the card; never say the video was made.",
    };
  }

  /**
   * A card's row (`awaiting_approval`, version 0, expiring after 24 hours): the tool's, once every check passed — and
   * the permission tests' fixture. Its id.
   */
  createCard(
    v: Omit<
      typeof videoJobs.$inferInsert,
      "id" | "status" | "version" | "createdAt" | "updatedAt" | "expiresAt"
    >,
    at: number = this.now(),
  ): string {
    const id = crypto.randomUUID();
    this.o.db
      .insert(videoJobs)
      .values({
        ...v,
        id,
        status: "awaiting_approval",
        version: 0,
        createdAt: at,
        updatedAt: at,
        expiresAt: at + this.limits.cardTtlMs,
      })
      .run();
    return id;
  }

  /** Every text of the submit that leaves this server (the egress check). */
  private sent(
    model: string,
    prompt: string,
    c: { durationSec: number; resolution: string; aspectRatio: string | null },
  ): string[] {
    return [OPENROUTER_VIDEOS_URL, model, prompt, String(c.durationSec), c.resolution, c.aspectRatio ?? ""];
  }

  // ---------------------------------------------------------------- the card's actions

  private owned(id: string, userId: string): VideoJobRow {
    const row = this.get(id);
    if (!row) throw new VideoError("not_found", 404);
    if (row.ownerId !== userId) throw new VideoError("forbidden", 403);
    return row;
  }

  /** One guarded write: only while the row is in one of `from` (and at `version`, when given). Null: it was not. */
  private write(
    id: string,
    from: readonly VideoJobStatus[],
    set: Partial<VideoJobRow>,
    version?: number,
  ): VideoJobRow | null {
    const r = this.o.db
      .update(videoJobs)
      .set({ ...set, version: sql`${videoJobs.version} + 1`, updatedAt: this.now() })
      .where(
        and(
          eq(videoJobs.id, id),
          inArray(videoJobs.status, [...from]),
          ...(version === undefined ? [] : [eq(videoJobs.version, version)]),
        ),
      )
      .run();
    if (r.changes !== 1) return null;
    this.changed(id);
    return this.get(id) ?? null;
  }

  /** A card that waited too long, or whose settings, model or key changed: expired (nothing was paid). */
  private expire(row: VideoJobRow, code: VideoJobCode): VideoJobRow {
    const r = this.write(row.id, ["awaiting_approval"], {
      status: "expired",
      errorCode: code,
      endedAt: this.now(),
    });
    if (r)
      logEvent(this.o.log, "info", "video.expired", {
        userId: r.ownerId,
        conversationId: r.conversationId,
        videoJobId: r.id,
        videoCode: code,
      });
    return r ?? this.get(row.id) ?? row;
  }

  /** Why the card no longer stands, or null: 24 hours passed, or the admin changed the settings, model or key. */
  private stale(row: VideoJobRow, at: number): VideoJobCode | null {
    if (at >= row.expiresAt) return "video_card_expired";
    const k = this.o.settings.get().kinds.video;
    // A key that could not be read now is not a change (the approval refuses it; the card stays).
    const snap = this.o.keys.snapshot();
    if (
      !k.enabled ||
      k.model !== row.model ||
      this.o.settings.revision() !== row.settingsRevision ||
      (snap.ok && snap.key?.mark !== row.keyMark)
    )
      return "video_settings_changed";
    return null;
  }

  /**
   * The key a job may use now: the one whose mark is the job's own, read in one go (`snapshot`). Undefined when the
   * key could not be read, there is none, or it is another (the admin changed it) — then nothing is sent or asked.
   */
  private keyFor(row: Pick<VideoJobRow, "keyMark">): string | undefined {
    const snap = this.o.keys.snapshot();
    return snap.ok && snap.key && snap.key.mark === row.keyMark ? snap.key.key : undefined;
  }

  dismiss(id: string, userId: string, version: number): VideoJobRow {
    const row = this.owned(id, userId);
    if (row.status !== "awaiting_approval" || row.version !== version)
      throw new VideoError("video_job_changed", 409, row);
    const r = this.write(id, ["awaiting_approval"], { status: "dismissed", endedAt: this.now() }, version);
    if (!r) throw new VideoError("video_job_changed", 409, this.get(id));
    return r;
  }

  /**
   * The owner's approval (see the comment at the top): everything checked, the bound reserved and the job submitted —
   * or nothing. `stillAllowed`: the request's session and the resource check again, inside the step that reserves.
   * Returns the job after the submit's answer (pending, or failed with why).
   */
  async approve(
    id: string,
    userId: string,
    version: number,
    stillAllowed: () => boolean,
  ): Promise<VideoJobRow | undefined> {
    if (!this.started) throw new VideoError("video_engine_unavailable", 503);
    if (!this.recovered) throw new VideoError("video_recovering", 503);
    let row = this.owned(id, userId);
    if (row.status === "awaiting_approval") {
      const stale = this.stale(row, this.now());
      if (stale) row = this.expire(row, stale);
    }
    if (row.status === "expired") throw new VideoError("video_job_expired", 409, row);
    if (row.status !== "awaiting_approval" || row.version !== version)
      throw new VideoError("video_job_changed", 409, row);
    if (this.o.recovering?.()) throw new VideoError("video_recovering", 503);
    // Review item 8 and r1 (P1): ffprobe must really work here — a known-good MP4 checked in the same sandbox —
    // before anything is paid (else a paid video could never be checked).
    if (!(await this.probeReady())) throw new VideoError("video_probe_unavailable", 503);
    const allowed = () =>
      stillAllowed() && !!this.o.users.byId(userId)?.active && this.get(id)?.ownerId === userId;
    if (!allowed()) throw new VideoError("forbidden", 403);
    const lookupKey = this.keyFor(row);
    if (!lookupKey) throw new VideoError("video_key_unavailable", 503);
    let record: VideoRecord | undefined;
    try {
      record = await this.record(row.model, lookupKey);
    } catch {
      throw new VideoError("video_lookup_failed", 502);
    }
    // Review r1: the session, the account and the ownership again — before any branch below changes or shows the card.
    if (!allowed()) throw new VideoError("forbidden", 403);
    row = this.owned(id, userId);
    if (row.status !== "awaiting_approval" || row.version !== version)
      throw new VideoError(row.status === "expired" ? "video_job_expired" : "video_job_changed", 409, row);
    const plan = record ? replanVideo(record, row) : null;
    if (!plan || isPlanError(plan))
      throw new VideoError("video_job_expired", 409, this.expire(row, "video_options_changed"));
    if (plan.micros > row.estimateMicros || plan.audio !== (row.audio ?? null)) {
      // Dearer now, or the model's default for sound changed (review r1): the card shows the new bound and sound
      // (version + 1) and is approved again — nothing is sent.
      const r = this.write(
        id,
        ["awaiting_approval"],
        { estimateMicros: Math.max(plan.micros, row.estimateMicros), audio: plan.audio },
        version,
      );
      const code = plan.micros > row.estimateMicros ? "video_estimate_changed" : "video_card_refreshed";
      throw new VideoError(r ? code : "video_job_changed", 409, r ?? this.get(id));
    }
    const body = withMediaPolicy({
      model: row.model,
      prompt: row.prompt,
      duration: row.durationSec,
      resolution: row.resolution,
      ...(row.aspectRatio ? { aspect_ratio: row.aspectRatio } : {}),
    });
    // A secret registered since the card was made: nothing is sent, the card ends (nothing was paid).
    if (this.secret(this.sent(row.model, row.prompt, row))) {
      const r = this.write(
        id,
        ["awaiting_approval"],
        { status: "failed", errorCode: "video_blocked", endedAt: this.now() },
        version,
      );
      if (!r) throw new VideoError("video_job_changed", 409, this.get(id));
      return r;
    }
    // ---- one synchronous step (review item 2): from here to the transaction's end nothing else runs here.
    const at = this.now();
    const fresh = this.owned(id, userId);
    if (fresh.status !== "awaiting_approval" || fresh.version !== version)
      throw new VideoError("video_job_changed", 409, fresh);
    if (!allowed()) throw new VideoError("forbidden", 403);
    const stale = this.stale(fresh, at);
    if (stale) throw new VideoError("video_job_expired", 409, this.expire(fresh, stale));
    // Review r4: the paid request goes only with the key whose mark is the card's — read now, in one go.
    const sendKey = this.keyFor(fresh);
    if (!sendKey) throw new VideoError("video_key_unavailable", 503);
    if (this.o.recovering?.()) throw new VideoError("video_recovering", 503);
    const usage = this.o.usage;
    const files = this.o.files();
    if (!usage || !files) throw new VideoError("video_engine_unavailable", 503);
    const callId = crypto.randomUUID();
    const usageKey = mediaRunKey(fresh.runId, callId);
    const outcome = this.o.db.$client
      .transaction((): VideoError | null => {
        const active = this.o.db
          .select({ ownerId: videoJobs.ownerId })
          .from(videoJobs)
          .where(inArray(videoJobs.status, ACTIVE))
          .all();
        if (
          active.length >= this.limits.slots.total ||
          active.filter((a) => a.ownerId === userId).length >= this.limits.slots.perUser
        )
          return new VideoError("video_busy", 409);
        // Review item 3: its result's place — the conversation's files, the places other approved jobs hold, and
        // the files image/speech calls are making now.
        if (
          files.placesTaken(fresh.conversationId) + (this.o.filesPending?.(fresh.conversationId) ?? 0) >=
          FILE_LIMITS.perConversation
        )
          return new VideoError("video_file_limit", 409);
        // The bound shown on the card, for the approval's day (user decision 3: the cost is the approval day's).
        if (!this.o.budget.allowsMicros(userId, fresh.estimateMicros, at))
          return new VideoError("video_budget", 409);
        usage.reserveMedia({
          userId,
          conversationId: fresh.conversationId,
          runId: fresh.runId,
          callId,
          model: fresh.model,
          estimateMicros: fresh.estimateMicros,
          state: "video_job",
          at,
        });
        const done = this.o.db
          .update(videoJobs)
          .set({
            status: "submitting",
            usageKey,
            approvedAt: at,
            deadlineAt: at + this.limits.deadlineMs,
            // A lease while the submit runs here: past it (a restart), the engine finds it `submitting` and not
            // under way — `video_unconfirmed`, never sent again.
            nextAt: at + this.limits.requestTimeoutMs + 60_000,
            failures: 0,
            version: sql`${videoJobs.version} + 1`,
            updatedAt: at,
          })
          .where(
            and(
              eq(videoJobs.id, id),
              eq(videoJobs.status, "awaiting_approval"),
              eq(videoJobs.version, version),
            ),
          )
          .run();
        if (done.changes !== 1) throw new VideoError("video_job_changed", 409);
        return null;
      })
      .immediate();
    if (outcome) throw new VideoError(outcome.code, outcome.status, this.get(id));
    this.changed(id);
    // ---- the paid request.
    const stop = new AbortController();
    const work = this.submit(id, usageKey, sendKey, body, stop.signal).catch((e: unknown) => {
      // What follows the paid request never strands the approval as a 500: the row says where it stands (a
      // `submitting` row not under way here ends `video_unconfirmed` on the next pass — never sent again).
      logEvent(this.o.log, "warn", "error", { videoJobId: id, err: e });
      return undefined;
    });
    await this.track(id, stop, work);
    return this.get(id);
  }

  /** Work of a job under way here: its stop kept until it ends (the only in-memory state of a job). */
  private track(id: string, stop: AbortController, work: Promise<unknown>): Promise<unknown> {
    const done = work.finally(() => {
      if (this.inflight.get(id)?.stop === stop) this.inflight.delete(id);
    });
    this.inflight.set(id, { stop, done });
    return done;
  }

  /** The probe is here and works (`VideoProbe.ready`); an `ok` holds for 10 minutes, a failure is asked again. */
  private async probeReady(): Promise<boolean> {
    const probe = this.o.probe();
    if (!probe) return false;
    if (this.now() < this.probeOkUntil) return true;
    let ok: boolean;
    try {
      ok = await probe.ready();
    } catch {
      ok = false;
    }
    if (ok) this.probeOkUntil = this.now() + 10 * 60_000;
    return ok;
  }

  private async submit(
    id: string,
    usageKey: string,
    apiKey: string,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<VideoJobRow | undefined> {
    let res: Response;
    try {
      res = await openRouterPost(OPENROUTER_VIDEOS_URL, body, {
        apiKey,
        fetchImpl: this.o.fetchImpl,
        timeoutMs: this.limits.requestTimeoutMs,
        signal,
      });
    } catch (e) {
      const status = e instanceof MediaHttpError ? e.status : 0;
      // Refused here before sending (-1), or by OpenRouter with a 4xx (not billed): the bound goes.
      if (status === -1 || (status >= 400 && status < 500)) {
        const code: VideoJobCode =
          status === 402 ? "video_payment" : status === 429 ? "video_rate_limited" : "video_rejected";
        // Review r4: the refusal is known here — it is recorded (and its bound released) or, should the writes fail,
        // kept trying while this job's work is still under way (a pass leaves it alone), until it is or the deadline.
        return (
          this.fail(id, code, { release: usageKey }) ??
          this.retrying(id, () => this.fail(id, code, { release: usageKey }))
        );
      }
      // No answer, a timeout or a 5xx: it may have started and may bill — never sent again, its bound stays.
      return this.fail(id, "video_unconfirmed") ?? this.get(id);
    }
    let remote: string | null;
    try {
      const a = JSON.parse(new TextDecoder().decode(await readBytes(res, STATUS_MAX))) as unknown;
      const rid = isObj(a) ? a.id : undefined;
      remote = typeof rid === "string" && VIDEO_JOB_ID.test(rid) ? rid : null;
    } catch {
      remote = null;
    }
    if (!remote) return this.fail(id, "video_unconfirmed") ?? this.get(id);
    // The id is what lets the job be followed: written now or — the writes failing — kept trying while this job's
    // work is under way (review r4), until it is written or the deadline.
    const accept = () => {
      const r = this.write(id, ["submitting"], {
        status: "pending",
        remoteId: remote,
        submittedAt: this.now(),
        nextAt: this.now() + this.limits.pollMs,
        failures: 0,
      });
      if (r)
        logEvent(this.o.log, "info", "video.submitted", {
          userId: r.ownerId,
          conversationId: r.conversationId,
          videoJobId: id,
        });
      return r;
    };
    try {
      const r = accept();
      if (r) return r;
    } catch {
      // kept trying below
    }
    return this.retrying(id, accept);
  }

  /**
   * A write that a job's state depends on and that failed: tried again (1 s, 2 s, 4 s … at most 30 s apart) as more
   * work of that job under way here — so no pass takes the job up meanwhile — until it succeeds (non-null), the job
   * is no longer `submitting` or is gone, its deadline passed (the pass's timeout ends it), or the engine stops. The
   * approval does not wait for it: it answers with the row as it is now.
   */
  private retrying(id: string, attempt: () => VideoJobRow | null): VideoJobRow | undefined {
    const stop = new AbortController();
    const work = (async () => {
      for (let n = 0; ; n++) {
        await new Promise<void>((r) => setTimeout(r, Math.min(30_000, this.limits.retryMs * 2 ** n)).unref());
        if (stop.signal.aborted || this.stopping) return;
        let row: VideoJobRow | undefined;
        try {
          row = this.get(id);
        } catch {
          continue;
        }
        if (!row || row.status !== "submitting" || this.pastDeadline(id)) return;
        try {
          if (attempt()) return;
        } catch {
          // tried again
        }
      }
    })();
    void this.track(id, stop, work);
    try {
      return this.get(id);
    } catch {
      return undefined;
    }
  }

  // ---------------------------------------------------------------- the engine

  /** Whether the engine runs here (only the lock-holding server's does; approvals need it). */
  get started(): boolean {
    return !!this.timer && !this.stopping;
  }

  /**
   * The engine's start (the lock-holding server, at onReady). Never throws, and does nothing more than install the
   * pass's timer and run a first pass: the recovery is part of a pass (`recover`) and tried again by every pass
   * until it succeeds — until then nothing is approved (`video_recovering`). Calling it again is harmless.
   */
  start(): void {
    if (this.timer || this.stopping) return;
    this.timer = setInterval(() => void this.tick(), this.limits.tickMs);
    this.timer.unref();
    void this.tick();
  }

  /** No new work starts; the work under way is stopped; open streams close. Waits (10 s at most) for it to end. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const w of this.inflight.values()) w.stop.abort();
    for (const close of [...this.streams]) close();
    await Promise.race([
      Promise.all([...this.inflight.values()].map((w) => w.done)),
      new Promise<void>((r) => setTimeout(r, 10_000).unref()),
    ]);
  }

  /** Every job's work under way here, ended (tests). */
  async idle(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight.values()].map((w) => w.done));
  }

  /**
   * One pass (the timer's; tests call it directly). It never throws — each step is on its own, and what fails is
   * done by a later pass. In this order: the recovery (until it succeeded once), **deadlines first** (whatever a job
   * is doing), cards that no longer stand, refused submits' bounds, due notifications, then the due jobs (oldest
   * `next_at` first). Resolves when the work it started has ended.
   */
  tick(): Promise<void> {
    if (!this.started) return Promise.resolve();
    const at = this.now();
    const step = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        logEvent(this.o.log, "warn", "error", { err: e });
      }
    };
    if (!this.recovered) step(() => this.recover(at));
    else if (!this.swept) step(() => this.sweep());
    step(() => this.endLate(at));
    step(() => this.expireStale(at));
    step(() => this.releaseRefused());
    step(() => this.notifyDue(at));
    let started: Promise<unknown>[] = [];
    step(() => (started = this.startDue(at)));
    return Promise.all(started).then(
      () => undefined,
      () => undefined,
    );
  }

  /**
   * The start's recovery (nothing is under way in this process yet): the last process's download folders go, and
   * every running job is due now (its lease was the last process's). A `submitting` one then ends
   * `video_unconfirmed` (its outcome is unknown — never sent again), the others are polled again (a download starts
   * over). Only once this succeeded are approvals taken.
   */
  private recover(at: number): void {
    if (this.inflight.size) return;
    this.sweep();
    this.o.db.update(videoJobs).set({ nextAt: at }).where(inArray(videoJobs.status, ACTIVE)).run();
    this.recovered = true;
  }

  /** The last process's download folders (never one of a download under way here). */
  private sweep(): void {
    this.swept = sweepVideoScratch(this.o.dataDir, (name) => this.workdirs.has(name));
    if (!this.swept) logEvent(this.o.log, "warn", "media.sweep_failed");
  }

  /** Running jobs past their deadline: `video_timeout` (a settled cost stays, else the bound), their work stopped. */
  private endLate(at: number): void {
    for (const r of this.o.db
      .select({ id: videoJobs.id })
      .from(videoJobs)
      .where(and(inArray(videoJobs.status, ACTIVE), sql`${videoJobs.deadlineAt} <= ${at}`))
      .all()) {
      try {
        this.fail(r.id, "video_timeout");
      } catch {
        // the next pass ends it
      }
    }
  }

  /** Waiting cards past 24 hours, or made under other settings, model or key: expired. */
  private expireStale(at: number): void {
    for (const r of this.o.db
      .select()
      .from(videoJobs)
      .where(eq(videoJobs.status, "awaiting_approval"))
      .all()) {
      const stale = this.stale(r, at);
      if (stale) this.expire(r, stale);
    }
  }

  /**
   * Every waiting card, expired now (`video_settings_changed`) — called inside the admin's key and settings writes,
   * so no card made under the old key or settings can be approved after them. One statement (no list of ids bound);
   * the open cards hear it only once that write's transaction committed (review r4: a rolled-back save never shows
   * an expiry that did not happen).
   */
  expireWaiting(): void {
    const at = this.now();
    const ids = this.o.db
      .select({ id: videoJobs.id })
      .from(videoJobs)
      .where(eq(videoJobs.status, "awaiting_approval"))
      .all()
      .map((r) => r.id);
    if (!ids.length) return;
    this.o.db
      .update(videoJobs)
      .set({
        status: "expired",
        errorCode: "video_settings_changed",
        endedAt: at,
        version: sql`${videoJobs.version} + 1`,
        updatedAt: at,
      })
      .where(eq(videoJobs.status, "awaiting_approval"))
      .run();
    // After the caller's transaction: only the cards that really are expired now (in chunks — no bound limit).
    setImmediate(() => {
      try {
        for (let k = 0; k < ids.length; k += 500)
          for (const r of this.o.db
            .select({ id: videoJobs.id })
            .from(videoJobs)
            .where(
              and(
                inArray(videoJobs.id, ids.slice(k, k + 500)),
                eq(videoJobs.status, "expired"),
                eq(videoJobs.endedAt, at),
              ),
            )
            .all())
            this.changed(r.id);
      } catch {
        // the cards read their state again anyway (every 30 s)
      }
    });
  }

  /** The due running jobs, oldest `next_at` first, each leased (`next_at` pushed past its work) and started. */
  private startDue(at: number): Promise<unknown>[] {
    const out: Promise<unknown>[] = [];
    for (const r of this.o.db
      .select()
      .from(videoJobs)
      .where(and(inArray(videoJobs.status, ACTIVE), sql`${videoJobs.nextAt} <= ${at}`))
      .orderBy(asc(videoJobs.nextAt))
      .limit(20)
      .all()) {
      if (this.inflight.has(r.id)) continue;
      try {
        // A submit not under way here: its outcome is unknown — never sent again.
        if (r.status === "submitting") {
          this.fail(r.id, "video_unconfirmed");
          continue;
        }
        // The lease: no later pass picks it while its work runs; past it (a restart) it is picked again.
        const leased = this.o.db
          .update(videoJobs)
          .set({ nextAt: at + LEASE_MS(this.limits) })
          .where(and(eq(videoJobs.id, r.id), inArray(videoJobs.status, POLLED)))
          .run().changes;
        if (leased !== 1) continue;
      } catch {
        continue;
      }
      const stop = new AbortController();
      out.push(this.track(r.id, stop, this.advance(r, stop.signal)));
    }
    return out;
  }

  /**
   * After a 429 or a transient error: the next try after `Retry-After`, else 30 s · 2^n (at most 5 min, never past the
   * deadline), the failures in a row counted on the row.
   */
  private backoff(row: VideoJobRow, retryAfter?: number): void {
    const failures = (this.get(row.id)?.failures ?? row.failures) + 1;
    const wait = Math.min(this.limits.maxBackoffMs, retryAfter ?? this.limits.pollMs * 2 ** (failures - 1));
    const at = Math.min(this.now() + Math.max(wait, 0), row.deadlineAt ?? Infinity);
    this.o.db
      .update(videoJobs)
      .set({ nextAt: at, failures })
      .where(and(eq(videoJobs.id, row.id), inArray(videoJobs.status, POLLED)))
      .run();
  }

  /** The next poll after `ms`, the failures cleared (`failures: false` keeps them). */
  private later(row: VideoJobRow, ms: number, set: Partial<VideoJobRow> = {}): void {
    // A change the card shows (status, progress) is a new version (review r4: an older answer never wins).
    const visible = Object.keys(set).length
      ? { version: sql`${videoJobs.version} + 1`, updatedAt: this.now() }
      : {};
    const r = this.o.db
      .update(videoJobs)
      .set({ nextAt: Math.min(this.now() + ms, row.deadlineAt ?? Infinity), failures: 0, ...set, ...visible })
      .where(and(eq(videoJobs.id, row.id), inArray(videoJobs.status, POLLED)))
      .run();
    if (r.changes === 1 && Object.keys(set).length) this.changed(row.id);
  }

  private left(row: VideoJobRow): number {
    return (row.deadlineAt ?? this.now() + this.limits.deadlineMs) - this.now();
  }

  /** Whether the job is still running and its deadline has passed. */
  private pastDeadline(id: string): boolean {
    const r = this.get(id);
    return !!r && ACTIVE.includes(r.status) && r.deadlineAt !== null && this.now() >= r.deadlineAt;
  }

  /**
   * One poll of one job, and what follows from its answer. Only with the key the job was approved under (its mark):
   * under another key (the admin changed it since) nothing is asked — the job waits for its key, else its deadline.
   * Never throws.
   */
  private async advance(row: VideoJobRow, signal: AbortSignal): Promise<void> {
    try {
      const url = row.remoteId ? videoStatusUrl(row.remoteId) : null;
      if (!url) {
        this.fail(row.id, "video_lost");
        return;
      }
      const key = this.keyFor(row);
      if (!key) return this.later(row, this.limits.pollMs);
      let answer: unknown;
      try {
        const res = await videoGet(url, {
          apiKey: key,
          fetchImpl: this.o.fetchImpl,
          timeoutMs: Math.max(1, Math.min(this.limits.requestTimeoutMs, this.left(row))),
          signal,
        });
        answer = JSON.parse(new TextDecoder().decode(await readBytes(res, STATUS_MAX)));
      } catch (e) {
        if (signal.aborted) return;
        const status = e instanceof MediaHttpError ? e.status : 0;
        // Gone for good (410), or not a request this server can make (-1 refused here, -2 a redirect).
        if (status === 410 || status === -1 || status === -2) {
          this.fail(row.id, "video_lost");
          return;
        }
        // 404 (it may be another account's answer, or not stored yet), 429, 5xx, no answer, not JSON: later.
        return this.backoff(row, e instanceof MediaHttpError ? e.retryAfterMs : undefined);
      }
      if (signal.aborted || !this.get(row.id)) return;
      const a = isObj(answer) ? answer : {};
      // An answer about another job is not this one's — neither its status nor its cost.
      if (a.id !== row.remoteId) return this.backoff(row);
      const status = a.status;
      if (status === "pending" || status === "in_progress") {
        const progress =
          typeof a.progress === "number" && Number.isFinite(a.progress)
            ? Math.max(0, Math.min(100, Math.round(a.progress)))
            : null;
        // `completed` may briefly read as in_progress again: a job already downloading stays so.
        if (row.status === "downloading") return this.later(row, this.limits.pollMs);
        const changed = row.status !== status || row.progress !== progress;
        return this.later(row, this.limits.pollMs, changed ? { status, progress } : {});
      }
      if (status === "completed") return await this.complete(row, a, signal);
      if (status === "failed" || status === "cancelled") {
        // The provider's words are never stored or shown: only whether they name its moderation.
        const moderated = typeof a.error === "string" && MODERATION.test(a.error);
        this.fail(row.id, moderated ? "video_moderated" : "video_failed");
        return;
      }
      if (status === "expired") {
        this.fail(row.id, "video_remote_expired");
        return;
      }
      // Anything else: asked again later.
      this.later(row, this.limits.pollMs);
    } catch (e) {
      logEvent(this.o.log, "warn", "error", { videoJobId: row.id, err: e });
      try {
        this.backoff(row);
      } catch {
        // the lease runs out: the job is picked again
      }
    }
  }

  /**
   * A `completed` job: its reported cost settled first, then the video downloaded, checked and stored with the
   * job's end in one transaction.
   */
  private async complete(row: VideoJobRow, a: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    const usage = isObj(a.usage) ? a.usage : {};
    const cost =
      typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : null;
    // The cost and `downloading` together, before a byte is fetched (a restart then never loses the cost). The
    // failures in a row are kept (a download retried across completed polls counts on).
    const settled = this.o.db.$client.transaction(() => {
      const r = this.get(row.id);
      if (!r || !POLLED.includes(r.status) || this.pastDeadline(row.id)) return null;
      if (cost !== null && r.costMicros === null && r.usageKey) this.o.usage?.settleMedia(r.usageKey, cost);
      this.o.db
        .update(videoJobs)
        .set({
          status: "downloading",
          ...(cost !== null && r.costMicros === null ? { costMicros: Math.round(cost * 1_000_000) } : {}),
          version: sql`${videoJobs.version} + 1`,
          updatedAt: this.now(),
        })
        .where(eq(videoJobs.id, row.id))
        .run();
      return this.get(row.id) ?? null;
    })();
    if (!settled) return;
    this.changed(row.id);
    const url = settled.remoteId ? videoContentUrl(settled.remoteId) : null;
    if (!url) {
      this.fail(row.id, "video_lost");
      return;
    }
    // Review r4: the content only with the job's own key, read again right now (the admin may have changed it while
    // the status was asked) — another key: the download waits (the cost above is settled), at worst its deadline.
    const apiKey = this.keyFor(settled);
    if (!apiKey) return this.later(settled, this.limits.pollMs);
    let workdir: string | undefined;
    try {
      try {
        workdir = makeVideoWorkdir(this.o.dataDir);
        this.workdirs.add(path.basename(workdir));
      } catch {
        this.fail(row.id, "video_store_failed");
        return;
      }
      const file = path.join(workdir, "video.mp4");
      const got = await this.download(settled, url, apiKey, file, signal);
      if (signal.aborted || !this.get(row.id)) return;
      if (typeof got === "string") {
        this.fail(row.id, this.pastDeadline(row.id) ? "video_timeout" : got);
        return;
      }
      if (!("bytes" in got)) return this.backoff(settled, got.retryAfter);
      const probe = this.o.probe();
      const verdict = probe ? await probe.check(file, signal) : "failed";
      if (signal.aborted || !this.get(row.id) || this.pastDeadline(row.id)) return;
      if (verdict !== "ok") {
        this.fail(
          row.id,
          this.pastDeadline(row.id)
            ? "video_timeout"
            : verdict === "not_mp4"
              ? "video_not_mp4"
              : "video_store_failed",
        );
        return;
      }
      await this.store(settled, file, got);
    } finally {
      if (workdir) {
        removeVideoWorkdir(workdir);
        this.workdirs.delete(path.basename(workdir));
      }
    }
  }
  /**
   * The video streamed into `file`: its size and hash, or why not — `retry` for what a later try may fix (OpenRouter
   * says not ready yet: 409; 429; 5xx; no answer), a code for what it will not (another 4xx, a redirect, over 1GB,
   * cut off). The request's time is what is left of the job's deadline, at most 15 minutes.
   */
  private async download(
    row: VideoJobRow,
    url: string,
    apiKey: string,
    file: string,
    signal: AbortSignal,
  ): Promise<{ bytes: number; sha256: string } | { retry: true; retryAfter?: number } | VideoJobCode> {
    let res: Response;
    try {
      res = await videoGet(url, {
        apiKey,
        fetchImpl: this.o.fetchImpl,
        timeoutMs: Math.max(1, Math.min(this.limits.downloadTimeoutMs, this.left(row))),
        signal,
      });
    } catch (e) {
      const status = e instanceof MediaHttpError ? e.status : 0;
      // Review r1: a 429's (or 503's) `Retry-After` is kept for the next try.
      if (status === 409 || status === 429 || status >= 500 || status === 0)
        return e instanceof MediaHttpError && e.retryAfterMs !== undefined
          ? { retry: true, retryAfter: e.retryAfterMs }
          : { retry: true };
      return "video_download_failed";
    }
    const max = this.limits.maxBytes;
    const declared = Number(res.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > max) {
      await res.body?.cancel().catch(() => {});
      return "video_too_large";
    }
    if (!res.body) return "video_download_failed";
    const hash = crypto.createHash("sha256");
    let fd: number | undefined;
    let total = 0;
    const reader = res.body.getReader();
    try {
      fd = fs.openSync(file, "wx", 0o600);
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > max) {
          await reader.cancel().catch(() => {});
          return "video_too_large";
        }
        hash.update(value);
        let at = 0;
        while (at < value.byteLength) at += fs.writeSync(fd, value, at, value.byteLength - at);
      }
    } catch {
      await reader.cancel().catch(() => {});
      return "video_download_failed";
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    if (!total) return "video_download_failed";
    return { bytes: total, sha256: hash.digest("hex") };
  }

  /** The checked video as a file of the conversation: the file row, `file_id` and `done` in one transaction. */
  private async store(row: VideoJobRow, file: string, got: { bytes: number; sha256: string }): Promise<void> {
    const files = this.o.files();
    if (!files) {
      this.fail(row.id, "video_store_failed");
      return;
    }
    let transient = false;
    try {
      await files.addGenerated({
        userId: row.ownerId,
        conversationId: row.conversationId,
        messageId: row.messageId,
        name: `video-${stamp(this.now())}.mp4`,
        kind: "mp4",
        bytes: got.bytes,
        sha256: got.sha256,
        tmp: file,
        // Inside the file-write lock: the job is still this one, downloading, without a file.
        guard: () => {
          const r = this.get(row.id);
          return !!r && r.status === "downloading" && r.fileId === null && !this.pastDeadline(row.id);
        },
        video: {
          jobId: row.id,
          commit: (f) => {
            try {
              return this.commitDone(row, f);
            } catch {
              // A write that failed (the database, for now): not the job's end — stored again later (review r4).
              transient = true;
              return false;
            }
          },
        },
      });
    } catch (e) {
      // The job went (its conversation deleted) or changed under it: nothing is stored, nothing more to do.
      if (e instanceof FileAddCancelledError && !this.get(row.id)) return;
      if (e instanceof FileAddCancelledError && this.get(row.id)?.status !== "downloading") return;
      // Past its deadline while waiting for the lock: the next pass's timeout.
      if (e instanceof FileAddCancelledError && this.pastDeadline(row.id)) return;
      // The job is still the one downloading (only the commit's write failed) or another write failed: below.
      if (e instanceof FileAddCancelledError && !transient) return;
      // For good: no place left (the conversation's files), a store folder that is a link.
      if (e instanceof FileLimitError || e instanceof StoreLinkError) {
        this.fail(row.id, "video_store_failed");
        return;
      }
      // Anything else (the commit's write, the insert, the rename — the database or the disk for now): the job stays
      // `downloading` and is downloaded and stored again by a later pass, until its deadline (its cost is settled).
      this.backoff(row);
      return;
    }
    this.changed(row.id);
    const done = this.get(row.id);
    if (!done) return;
    logEvent(this.o.log, "info", "video.done", {
      userId: done.ownerId,
      conversationId: done.conversationId,
      videoJobId: done.id,
    });
    this.notify(done);
  }

  /** `done` with its file, in the file row's own transaction (false: the job is no longer the one downloading). */
  private commitDone(row: VideoJobRow, f: { id: string }): boolean {
    const r = this.get(row.id);
    if (!r || r.status !== "downloading" || r.fileId !== null || this.pastDeadline(row.id)) return false;
    // No cost was reported: the bound stays for good (a settled one is left as it is).
    if (r.costMicros === null && r.usageKey) this.o.usage?.unconfirmVideoMedia(r.usageKey);
    return (
      this.o.db
        .update(videoJobs)
        .set({
          status: "done",
          fileId: f.id,
          progress: 100,
          nextAt: null,
          endedAt: this.now(),
          version: sql`${videoJobs.version} + 1`,
          updatedAt: this.now(),
        })
        .where(and(eq(videoJobs.id, row.id), eq(videoJobs.status, "downloading")))
        .run().changes === 1
    );
  }

  /**
   * The job's end other than its video: failed with a fixed code; its bound stays (`unconfirmed`) unless a cost was
   * settled or it was released (a refusal before it was billed). Null when the job had already ended or is gone.
   */
  private fail(id: string, code: VideoJobCode, o: { release?: string } = {}): VideoJobRow | null {
    const end = (release: boolean) =>
      this.o.db.$client.transaction(() => {
        const row = this.get(id);
        if (!row || !VIDEO_ACTIVE.has(row.status)) return null;
        // Review r1: a refusal's bound goes in the same transaction as the job's end. Should that fail, the job ends
        // anyway with its refusal code and its `video_job` row is released later (`releaseRefused`: every pass and
        // at start); anything else keeps its bound for good unless a cost was settled.
        if (o.release && release) this.o.usage?.releaseMedia(o.release);
        else if (!o.release && row.usageKey && row.costMicros === null)
          this.o.usage?.unconfirmVideoMedia(row.usageKey);
        this.o.db
          .update(videoJobs)
          .set({
            status: "failed",
            errorCode: code,
            nextAt: null,
            endedAt: this.now(),
            version: sql`${videoJobs.version} + 1`,
            updatedAt: this.now(),
          })
          .where(eq(videoJobs.id, id))
          .run();
        return this.get(id) ?? null;
      })();
    let r: VideoJobRow | null = null;
    let wrote = false;
    for (const release of o.release ? [true, true, false] : [true, true]) {
      try {
        r = end(release);
        wrote = true;
        break;
      } catch {
        // tried again (a refusal's last try: the end alone)
      }
    }
    if (!wrote)
      logEvent(this.o.log, "error", "media.usage_failed", {
        videoJobId: id,
        mediaCode: "media_usage_failed",
        mediaStep: o.release ? "release" : "settle",
      });
    if (!r) return null;
    this.inflight.get(id)?.stop.abort();
    this.changed(id);
    logEvent(this.o.log, "warn", "video.failed", {
      userId: r.ownerId,
      conversationId: r.conversationId,
      videoJobId: id,
      videoCode: code,
    });
    this.notify(r);
    return r;
  }

  /**
   * The bounds of refused submits (402/429/4xx — never billed) still held because their release failed (review r1):
   * released now. Every pass and at start.
   */
  private releaseRefused(): void {
    const rows = this.o.db
      .select({ usageKey: videoJobs.usageKey })
      .from(videoJobs)
      .where(
        and(
          eq(videoJobs.status, "failed"),
          inArray(videoJobs.errorCode, [...REFUSED]),
          sql`${videoJobs.usageKey} IS NOT NULL`,
          sql`EXISTS (SELECT 1 FROM usage_records u WHERE u.run_id = ${videoJobs.usageKey}
            AND u.purpose = 'media' AND u.media_settlement = 'video_job')`,
        ),
      )
      .all();
    for (const r of rows) {
      try {
        this.o.usage?.releaseVideoMedia(r.usageKey!);
      } catch {
        // tried again on the next pass
      }
    }
  }

  /**
   * The owner's notification of a job's end, once: `notified_at` is written when it was published, or refused for
   * good (the kind turned off, the account or the conversation gone, no access). A publish that failed (a lookup error,
   * a write error) is tried again after a backoff of its own (`notify_next_at`: 30 s · 2^n, at most 5 min) with the
   * same `dedupeKey` (one row however often). The link opens the conversation (not a reply that a regeneration may
   * have replaced; the video is in its card and among the conversation's files).
   */
  private notify(row: VideoJobRow): void {
    if (row.status !== "done" && row.status !== "failed") return;
    const n = this.o.notifications();
    if (!n) return;
    const kind = row.status === "done" ? "video_done" : "video_failed";
    let ok: boolean;
    try {
      if (n.wants?.(row.ownerId, kind) ?? true) {
        const url = `/c/${row.conversationId}`;
        const ref = { kind: "conversation", id: row.conversationId };
        const input: PublishInput =
          kind === "video_done"
            ? { kind, url, ref }
            : {
                kind,
                reason:
                  VIDEO_FAILURE_SHORT[(row.errorCode as VideoJobCode | null) ?? "video_failed"] ?? "실패",
                url,
                ref,
              };
        const opts = { dedupeKey: `video:${row.id}:end` };
        const outcome = n.publishOutcome
          ? n.publishOutcome(row.ownerId, input, opts).status
          : n.publish(row.ownerId, input, opts) === undefined
            ? "refused"
            : "published";
        ok = outcome !== "failed";
      } else ok = true;
      if (ok)
        this.o.db
          .update(videoJobs)
          .set({ notifiedAt: this.now() })
          .where(and(eq(videoJobs.id, row.id), sql`${videoJobs.notifiedAt} IS NULL`))
          .run();
    } catch {
      ok = false;
    }
    if (ok) return;
    try {
      const tries = row.notifyTries + 1;
      this.o.db
        .update(videoJobs)
        .set({
          notifyTries: tries,
          notifyNextAt:
            this.now() + Math.min(this.limits.maxBackoffMs, this.limits.pollMs * 2 ** (tries - 1)),
        })
        .where(and(eq(videoJobs.id, row.id), sql`${videoJobs.notifiedAt} IS NULL`))
        .run();
    } catch {
      // asked again by the next pass
    }
  }

  /** The ends of approved jobs whose notification is due (never tried, or its retry time passed), oldest first. */
  private notifyDue(at: number): void {
    for (const r of this.o.db
      .select()
      .from(videoJobs)
      .where(
        and(
          inArray(videoJobs.status, ["done", "failed"]),
          sql`${videoJobs.notifiedAt} IS NULL`,
          sql`${videoJobs.approvedAt} IS NOT NULL`,
          sql`coalesce(${videoJobs.notifyNextAt}, 0) <= ${at}`,
        ),
      )
      .orderBy(sql`coalesce(${videoJobs.notifyNextAt}, 0)`, asc(videoJobs.endedAt))
      .limit(20)
      .all())
      this.notify(r);
  }
}

/** The failure's short reason on a lock screen (fixed words; the card has the full text, `VIDEO_JOB_CODE_TEXT`). */
export const VIDEO_FAILURE_SHORT: Partial<Record<VideoJobCode, string>> = {
  video_rejected: "요청이 거절됐어요",
  video_payment: "OpenRouter 잔액·한도 부족",
  video_rate_limited: "요청이 잠시 막혔어요",
  video_unconfirmed: "제출 결과를 확인하지 못했어요",
  video_failed: "제공자가 만들지 못했어요",
  video_moderated: "내용 검사에서 거부됐어요",
  video_remote_expired: "제공자 쪽 시간 초과",
  video_timeout: "60분 안에 끝나지 않았어요",
  video_lost: "작업을 찾지 못했어요",
  video_download_failed: "영상을 받아 오지 못했어요",
  video_too_large: "영상이 너무 커요",
  video_not_mp4: "MP4 영상이 아니에요",
  video_store_failed: "저장하지 못했어요",
};
