import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { SkillResult, ToolScope } from "@agentlee/mcp-tools";
import { IMAGE_GENERATE_TOOL, SPEECH_GENERATE_TOOL } from "@agentlee/mcp-tools/media";
import {
  FILE_LIMITS,
  MEDIA_TOOL_HINTS,
  MEDIA_TOOL_LIMITS,
  type FileKind,
  type MediaToolCode,
} from "@agentlee/shared";
import type { UserStore } from "../auth/users.js";
import type { Db } from "../db/client.js";
import { conversations, messages, runs } from "../db/schema.js";
import { FileAddCancelledError, FileLimitError, type FileRow, type FileStore } from "../files/store.js";
import { logEvent, type EventLogger } from "../logging.js";
import type { ErrorLog } from "../observability/errors.js";
import { carriesSecret } from "../secrets/egress.js";
import { MIN_KNOWN_LENGTH, scrubKnown, scrubKnownDeep } from "../secrets/known.js";
import type { UsageStore } from "../usage/store.js";
import type { MediaBudget } from "./budget.js";
import { boundMicros, imageCostBound, MAX_IMAGE_PIXELS, speechCostBound } from "./cost.js";
import type { OpenRouterKeys } from "./keys.js";
import {
  GENERATION_ID,
  generationUrl,
  imageEndpointsUrl,
  MediaHttpError,
  modelEndpointsUrl,
  OPENROUTER_IMAGES_URL,
  OPENROUTER_SPEECH_URL,
  openRouterGet,
  openRouterPost,
  outputFormats,
  RASTER_FORMATS,
  readBytes,
  speechModelUrl,
} from "./openrouter.js";
import { moderationFor, STRICTNESS, withMediaPolicy } from "./policy.js";
import { mediaRunKey } from "../usage/store.js";
import type { MediaSettingsStore } from "./settings.js";
import { imageSize, stripImage, textRuns } from "./strip.js";
import { removeSpeechWorkdir, type Mp3Info, type SpeechAudio } from "./speech-audio.js";
import {
  looksCut,
  resplitSpeech,
  SPEECH_SPLIT,
  splitSpeech,
  type SpeechSplitLimits,
} from "./speech-split.js";

/**
 * `image_generate` and `speech_generate` (#238 stage 2): one synchronous OpenRouter generation per call (a long speech
 * text: one per piece, #248 — below), stored as a file of the run's conversation linked to its reply (the reply then
 * shows it: an inline image, an audio player).
 *
 * Every call, in this order — nothing is paid for before all of it passed:
 * 1. strict input; the kind switched on with a model (관리자 → 미디어 생성) and an OpenRouter key (the admin's, else
 *    `.env`'s) — else `media_disabled` / `media_no_key`; the run is this user's, still open, still wanted (`alive`);
 * 2. the user's own texts (prompt, text, voice, instructions) pass the egress predicate (`carriesSecret`, `.env`'s
 *    values too) **before** anything else looks at them — `media_secret_blocked`, told to the model as
 *    `media_failed`;
 * 3. the model's records, read for this call — a read that fails is `media_lookup_failed` (retryable), never
 *    "unknown, go on": the options it lists (aspect ratio, voices, output formats, moderation) and its prices.
 *    Options it does not list are refused (`media_bad_option`); an explicit voice only when it is in the model's
 *    confirmed public list; an image model whose output formats are all vector is refused before paying;
 * 4. the settings revision and the key are the same as when the call started (`media_changed` otherwise);
 * 5. reference images: this user's and conversation's sent png·jpg·webp files, metadata stripped, the rest checked
 *    for known secrets;
 * 6. the run's per-kind limit (`perRunLimits`) — `media_quota`; a place among the conversation's files — counting
 *    the calls in flight (`media_file_limit`);
 * 7. the daily budget against the call's **upper bound** (`cost.ts`) — no bound, no call (`media_no_price`). The
 *    budget check and the reserving usage row (`reserveMedia`, the bound in `estimated_cost_micros`) are one
 *    synchronous step, so two calls cannot both take the last of the budget; the bound holds until a cost is
 *    reported and for good when none ever is;
 * 8. the body gets the request policy (`provider.data_collection: "deny"`) and, for a youth account, the strictest
 *    `moderation` the model lists.
 *
 * After the request: a refusal (4xx/5xx — not billed) removes the reserving row; a 2xx keeps it and its cost is
 * settled from what OpenRouter reports — the image answer's `usage.cost`, the speech call's generation record
 * (`X-Generation-Id`) — whatever happens to the file afterwards. A request whose outcome is unknown (network
 * error, timeout) keeps its bound. A usage write that fails is tried once more, then logged for the operator.
 * The tool's result passes the known-secret scrub. Nothing about the prompt, the text or the answer is logged.
 *
 * **Long speech (#248).** The production TTS model stops its audio at ~290 s without an error, so a speech text is
 * split into pieces (`speech-split.ts`: paragraph and sentence boundaries, each estimated ≤ 240 s at a slow reading
 * rate) — one piece for a text that fits, sent exactly as before. Every piece is its own generation with the same
 * model, voice, instructions and moderation, and its **own usage row** (its own call id and generation id, reserved,
 * settled and late-settled like any single call). Up front, in the one synchronous budget step: the sum of the
 * pieces' bounds **plus the largest one re-split** (the headroom of one retry) must fit — all in integer micro-USD,
 * the same integers the rows hold — and every piece's row is reserved as `pending_send` (never billed: the start-up
 * recovery removes such rows). Pieces go one after another. Right before each request, synchronously: its fields
 * pass the egress check again (a secret registered meanwhile), a new service day (past midnight) must still have the
 * piece's bound left (the row moves to that day), and the row becomes `reserved` (sent). Each answer is measured
 * (ffprobe, `speech-audio.ts`) and a piece that came back cut (at the provider's mark, or far shorter than its
 * estimate) is split smaller and tried once more — within the call's cap on paid requests, its pieces reserved
 * (budget check again) just before they are sent; cut again is `media_truncated`. Then ffmpeg
 * joins the pieces into one MP3 (stream copy; re-encoded when their streams differ, or at a lower rate when the
 * result passes 50MB), its length is checked against the pieces' sum, and it is stored as one file. Any stop on
 * the way (a failed or refused piece, cancel, a settings change, the call's time budget) stores nothing: the pieces
 * already sent keep their rows (their cost is recorded), the reserved rows of pieces never sent are removed. Without
 * ffmpeg/ffprobe a text of one piece is made unmeasured as before; a longer one is `media_split_unavailable` before
 * anything is paid. One tool call is one use of the run's speech limit, one file place, one slot.
 */
export type MediaGeneratorOptions = {
  db: Db;
  files: () => FileStore | undefined;
  keys: Pick<OpenRouterKeys, "resolve">;
  settings: Pick<MediaSettingsStore, "get" | "revision">;
  budget: Pick<MediaBudget, "allows" | "allowsMicros" | "dayOf">;
  usage:
    | Pick<
        UsageStore,
        | "reserveMedia"
        | "settleMedia"
        | "releaseMedia"
        | "answeredMedia"
        | "unconfirmMedia"
        | "generationMedia"
        | "sendingMedia"
      >
    | undefined;
  /**
   * The key generation (관리자 → 미디어 생성's `<process>:<changes>`): a key swapped and swapped back during a call's
   * lookup (A→B→A) is a change too. Without it only the key itself is compared.
   */
  keyGeneration?: () => string;
  /**
   * While the start-up recovery of a previous process's reservations has not succeeded (`MediaRecovery`), no new
   * paid call starts (`media_recovering`, retryable).
   */
  recovering?: () => boolean;
  users: Pick<UserStore, "byId">;
  fetchImpl?: typeof fetch | undefined;
  /** The `.env` skill secrets (by env name): the egress check knows them too. */
  secrets?: Readonly<Record<string, string>> | undefined;
  /** Tests: the wait between cost lookups. */
  sleep?: (ms: number) => Promise<void>;
  /** Generations at once: in total and per user. */
  slots?: { total: number; perUser: number };
  now?: () => number;
  /** Where a failed usage write is reported (the operator's log and the admin's error list). */
  log?: EventLogger | undefined;
  errors?: Pick<ErrorLog, "record"> | undefined;
  /**
   * #248: ffprobe/ffmpeg for measuring and joining speech pieces, resolved per call; undefined = not on this server
   * (a speech text of one piece is still made, unmeasured).
   */
  speechAudio?: () => SpeechAudio | undefined;
  /** #248: the piece sizing and cut detection (tests use short pieces). */
  split?: SpeechSplitLimits;
};

export const MEDIA_SLOTS = { total: 4, perUser: 2 } as const;

export type MediaFileOut = { fileId: string; name: string; bytes: number; url: string; kind: FileKind };
export type MediaToolOutput = {
  status: "ok";
  fileId: string;
  file: MediaFileOut;
  model: string;
  voice?: string;
  /** OpenRouter's reported cost (USD); null when it reported none (speech: of all its pieces, null if any is missing). */
  costUsd: number | null;
  /** Speech (#248): the stored audio's length in seconds (null: not measured — no ffprobe on this server). */
  durationSeconds?: number | null;
  /** Speech (#248): the pieces the stored audio was read in. */
  chunks?: number;
  note: string;
};

class MediaToolError extends Error {
  constructor(
    readonly code: MediaToolCode,
    readonly hint?: string,
  ) {
    super(code);
  }
}

type Kind = "image" | "speech";
type Descriptor = { type?: unknown; values?: unknown };
type Params = Map<string, Set<string> | null>;

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPG = Buffer.from([0xff, 0xd8, 0xff]);
const REFERENCE_KINDS: ReadonlySet<string> = new Set(["png", "jpg", "webp"]);
const B64 = /^[A-Za-z0-9+/\r\n]*={0,2}\s*$/;
/** The largest image answer read: a 50MB file as base64, plus the JSON around it. */
const IMAGE_ANSWER_MAX = Math.ceil((FILE_LIMITS.bytes * 4) / 3) + 256 * 1024;
/** Option values that may go back to the model in a hint: plain identifiers only (never free text). */
const HINT_VALUE = /^[A-Za-z0-9 _.:()+-]{1,64}$/;

/** The raster image kind of these bytes (by content, never by what the answer claims). */
export function imageKindOf(b: Buffer): "png" | "jpg" | "webp" | undefined {
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG)) return "png";
  if (b.length >= 3 && b.subarray(0, 3).equals(JPG)) return "jpg";
  if (b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP")
    return "webp";
  return undefined;
}

/** Whether these bytes are MP3 (an ID3 tag, or an MPEG audio frame header). */
export function isMp3(b: Buffer): boolean {
  if (b.length >= 3 && b.toString("latin1", 0, 3) === "ID3") return true;
  if (b.length < 4) return false;
  return b[0] === 0xff && (b[1]! & 0xe0) === 0xe0 && ((b[1]! >> 3) & 3) !== 1 && ((b[1]! >> 1) & 3) !== 0;
}

/** `supported_parameters` maps (capability descriptors) merged: a name → its listed values (null: no list). */
function mergeParams(maps: unknown[]): Params {
  const out: Params = new Map();
  for (const m of maps) {
    if (typeof m !== "object" || m === null || Array.isArray(m)) continue;
    for (const [name, d] of Object.entries(m as Record<string, Descriptor>)) {
      const vals = Array.isArray(d?.values)
        ? d.values.filter((v): v is string | number => typeof v === "string" || typeof v === "number")
        : null;
      const had = out.get(name);
      if (!out.has(name)) out.set(name, vals ? new Set(vals.map(String)) : null);
      else if (had && vals) for (const v of vals) had.add(String(v));
      else if (!vals) out.set(name, null);
    }
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export class MediaGenerator {
  private readonly calls = new Map<string, { n: number; at: number }>();
  /** Files being made per conversation (calls past the file-place check, not stored yet). */
  private readonly filesInFlight = new Map<string, number>();
  private running = 0;
  private readonly byUser = new Map<string, number>();
  private readonly now: () => number;
  private readonly split: SpeechSplitLimits;

  constructor(private readonly o: MediaGeneratorOptions) {
    this.now = o.now ?? Date.now;
    this.split = o.split ?? SPEECH_SPLIT;
  }

  /** Whether the kind is offered now: switched on, a model chosen, a key in place. */
  offered(kind: Kind): boolean {
    const k = this.o.settings.get().kinds[kind];
    return k.enabled && !!k.model && !!this.o.keys.resolve();
  }

  async run(
    kind: Kind,
    scope: ToolScope,
    input: Record<string, unknown>,
    o: { alive?: (() => boolean) | undefined; signal?: AbortSignal | undefined } = {},
  ): Promise<SkillResult> {
    try {
      // The result goes to the model: every known secret out of it (file names, voices, notes).
      return { ok: true, output: scrubKnownDeep(await this.execute(kind, scope, input, o), { tail: false }) };
    } catch (e) {
      if (e instanceof MediaToolError) {
        const hint = e.hint ?? MEDIA_TOOL_HINTS[e.code];
        return { ok: false, code: e.code, ...(hint ? { hint: scrubKnown(hint, { tail: false }) } : {}) };
      }
      throw e;
    }
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

  private runOpen(scope: ToolScope): boolean {
    const r = this.o.db.select({ endedAt: runs.endedAt }).from(runs).where(eq(runs.id, scope.runId)).get();
    return !!r && r.endedAt === null;
  }

  private takeCall(runId: string, kind: Kind, limit: number): boolean {
    const t = this.now();
    const key = `${runId}:${kind}`;
    const used = this.calls.get(key)?.n ?? 0;
    if (used >= limit) return false;
    this.calls.set(key, { n: used + 1, at: t });
    if (this.calls.size > 500)
      for (const [k, v] of this.calls) if (t - v.at > 6 * 3600_000) this.calls.delete(k);
    return true;
  }

  private secret(texts: readonly string[]): boolean {
    return carriesSecret(texts, { config: Object.values(this.o.secrets ?? {}) });
  }

  private async execute(
    kind: Kind,
    scope: ToolScope,
    raw: Record<string, unknown>,
    o: { alive?: (() => boolean) | undefined; signal?: AbortSignal | undefined },
  ): Promise<MediaToolOutput> {
    const tool = kind === "image" ? IMAGE_GENERATE_TOOL : SPEECH_GENERATE_TOOL;
    const parsed = z.strictObject(tool.input).safeParse(raw);
    if (!parsed.success) throw new MediaToolError("media_bad_input");
    const revision = this.o.settings.revision();
    const generation = this.o.keyGeneration?.();
    if (this.o.recovering?.()) throw new MediaToolError("media_recovering");
    const settings = this.o.settings.get();
    const k = settings.kinds[kind];
    if (!k.enabled || !k.model) throw new MediaToolError("media_disabled");
    const model = k.model;
    const key = this.o.keys.resolve();
    if (!key) throw new MediaToolError("media_no_key");
    const user = this.o.users.byId(scope.userId);
    if (!user?.active) throw new MediaToolError("media_not_allowed");
    const store = this.o.files();
    if (!store) throw new MediaToolError("media_failed");
    if (!SAFE_ID.test(scope.userId) || !SAFE_ID.test(scope.conversationId))
      throw new MediaToolError("media_not_allowed");
    const messageId = this.replyOf(scope);
    if (!messageId) throw new MediaToolError("media_not_allowed");
    const alive = () => {
      try {
        return this.runOpen(scope) && (o.alive?.() ?? true) && !o.signal?.aborted;
      } catch {
        return false;
      }
    };
    if (!alive()) throw new MediaToolError("media_cancelled");
    // The user's own texts first — before any option check answers about them (review r1).
    const own =
      kind === "image"
        ? [(parsed.data as ImageInput).prompt, (parsed.data as ImageInput).aspectRatio ?? ""]
        : [
            (parsed.data as SpeechInput).text,
            (parsed.data as SpeechInput).voice ?? "",
            (parsed.data as SpeechInput).instructions ?? "",
          ];
    if (this.secret([...own, model])) throw new MediaToolError("media_secret_blocked");
    const ctx: CallCtx = {
      scope,
      store,
      messageId,
      model,
      apiKey: key.key,
      youth: user.youth === true,
      alive,
      signal: o.signal,
    };

    const limits = this.o.slots ?? MEDIA_SLOTS;
    const mine = this.byUser.get(scope.userId) ?? 0;
    if (this.running >= limits.total || mine >= limits.perUser) throw new MediaToolError("media_busy");
    this.running++;
    this.byUser.set(scope.userId, mine + 1);
    let holdsFile = false;
    const releaseFile = () => {
      if (!holdsFile) return;
      holdsFile = false;
      const left = (this.filesInFlight.get(scope.conversationId) ?? 1) - 1;
      if (left > 0) this.filesInFlight.set(scope.conversationId, left);
      else this.filesInFlight.delete(scope.conversationId);
    };
    ctx.fileSaved = releaseFile;
    try {
      const plan =
        kind === "image"
          ? await this.planImage(ctx, parsed.data as ImageInput)
          : await this.planSpeech(ctx, parsed.data as SpeechInput);
      // The admin may have switched the kind off, picked another model or changed the key meanwhile.
      const changed = () => {
        const nowKey = this.o.keys.resolve();
        const nowKind = this.o.settings.get().kinds[kind];
        return (
          this.o.settings.revision() !== revision ||
          nowKey?.key !== key.key ||
          this.o.keyGeneration?.() !== generation ||
          !nowKind.enabled ||
          nowKind.model !== model
        );
      };
      ctx.changed = changed;
      if (changed()) throw new MediaToolError("media_changed");
      if (this.secret(plan.texts)) throw new MediaToolError("media_secret_blocked");
      if (plan.bound === null) throw new MediaToolError("media_no_price");
      // A place among the conversation's files, counting the calls in flight — before anything is paid for, and
      // before the run's call is counted (a refusal here leaves the run its call).
      const inFlight = this.filesInFlight.get(scope.conversationId) ?? 0;
      if (store.count(scope.conversationId) + inFlight >= FILE_LIMITS.perConversation)
        throw new MediaToolError("media_file_limit");
      this.filesInFlight.set(scope.conversationId, inFlight + 1);
      holdsFile = true;
      if (!this.takeCall(scope.runId, kind, settings.perRunLimits[kind]))
        throw new MediaToolError("media_quota");
      if (!alive()) throw new MediaToolError("media_cancelled");
      if (kind === "speech") {
        // The budget check and every piece's reserving row in one synchronous step (#248).
        const pieces = this.reserve(ctx, plan.pieces!, plan.checkMicros!);
        return await this.speech(ctx, plan, pieces);
      }
      // The budget check and the reserving row in one synchronous step, at one moment (the row counts for the day
      // that was checked — #251 r2).
      const callId = crypto.randomUUID();
      const at = this.now();
      if (!this.o.budget.allows(scope.userId, plan.bound, at)) throw new MediaToolError("media_budget");
      if (
        !this.write(ctx, "reserve", () =>
          this.o.usage?.reserveMedia({ ...this.row(ctx, callId), estimateUsd: plan.bound!, at }),
        )
      )
        throw new MediaToolError("media_failed");
      return await this.image(ctx, callId, plan.body);
    } finally {
      releaseFile();
      this.running--;
      const left = (this.byUser.get(scope.userId) ?? 1) - 1;
      if (left > 0) this.byUser.set(scope.userId, left);
      else this.byUser.delete(scope.userId);
    }
  }

  /**
   * Speech pieces' reservations (#248), synchronous: the budget must allow `checkMicros` (the pieces' bounds, plus
   * the headroom asked for — integer micro-USD, the same integers the rows get), then every piece gets its
   * reserving row, `pending_send` until its request goes out. **One moment** (`at`) for the whole step: the budget
   * is checked for its day and every row is written with it (#251 r2 — midnight between the check and the inserts
   * would otherwise count the call's own rows twice). A row that cannot be written undoes the ones written (nothing
   * is sent).
   */
  private reserve(ctx: CallCtx, pieces: readonly PlannedPiece[], checkMicros: number): Piece[] {
    const at = this.now();
    if (!this.o.budget.allowsMicros(ctx.scope.userId, checkMicros, at))
      throw new MediaToolError("media_budget");
    const day = this.o.budget.dayOf(at);
    const out: Piece[] = [];
    for (const p of pieces) {
      const callId = crypto.randomUUID();
      if (
        !this.write(ctx, "reserve", () =>
          this.o.usage?.reserveMedia({
            ...this.row(ctx, callId),
            estimateMicros: p.micros,
            state: "pending_send",
            at,
          }),
        )
      ) {
        for (const r of out) this.release(ctx, r.callId);
        throw new MediaToolError("media_failed");
      }
      out.push({ ...p, callId, day });
    }
    return out;
  }

  /**
   * Right before a piece's request (#248), synchronous: its fields pass the egress check again (a secret may have
   * been registered since the call started); if the service day changed since it was reserved, the new day's budget
   * must still hold its bound and the row moves to now; then the row is `reserved` (sent). One moment (`at`) for the
   * day, the budget check and the row. Throws — the row still unsent, released by the caller — when any of it fails.
   */
  private sending(ctx: CallCtx, plan: Plan, p: Piece): void {
    if (this.secret([p.text, ...(plan.sentTexts ?? [])])) throw new MediaToolError("media_secret_blocked");
    const at = this.now();
    const today = this.o.budget.dayOf(at);
    const moved = today !== p.day;
    if (moved && !this.o.budget.allowsMicros(ctx.scope.userId, p.micros, at))
      throw new MediaToolError("media_budget");
    let ok = true;
    const wrote = this.write(ctx, "reserve", () => {
      ok = this.o.usage?.sendingMedia(mediaRunKey(ctx.scope.runId, p.callId), { at, move: moved }) ?? true;
    });
    if (!wrote || !ok) throw new MediaToolError("media_failed");
    p.day = today;
  }

  /** A reserving row whose request was never sent goes (it never cost anything). */
  private release(ctx: CallCtx, callId: string): void {
    this.write(ctx, "release", () => this.o.usage?.releaseMedia(mediaRunKey(ctx.scope.runId, callId)));
  }

  private row(ctx: CallCtx, callId: string) {
    return {
      userId: ctx.scope.userId,
      conversationId: ctx.scope.conversationId,
      runId: ctx.scope.runId,
      callId,
      model: ctx.model,
    };
  }

  /**
   * A usage write, tried twice; when both fail, the operator is told (log and the admin's error list — the call's
   * IDs and a fixed code only). False when it did not get written.
   */
  private write(ctx: CallCtx, what: "reserve" | "settle" | "release", fn: () => void): boolean {
    for (let i = 0; i < 2; i++) {
      try {
        fn();
        return true;
      } catch {
        // tried again
      }
    }
    logEvent(this.o.log, "error", "media.usage_failed", {
      userId: ctx.scope.userId,
      conversationId: ctx.scope.conversationId,
      runId: ctx.scope.runId,
      mediaCode: "media_usage_failed",
      mediaStep: what,
    });
    try {
      this.o.errors?.record({
        source: "tool",
        code: "media_usage_failed",
        category: "tool",
        userId: ctx.scope.userId,
        conversationId: ctx.scope.conversationId,
        runId: ctx.scope.runId,
      });
    } catch {
      // the log line above stays
    }
    return false;
  }

  // ---------------------------------------------------------------- planning (no money spent)

  /** A model's record for this call; `media_lookup_failed` when OpenRouter did not answer it. */
  private async lookup(url: string | null, apiKey: string): Promise<Record<string, unknown>> {
    if (!url) throw new MediaToolError("media_lookup_failed");
    let a: unknown;
    try {
      a = await openRouterGet(url, { apiKey, ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}) });
    } catch {
      throw new MediaToolError("media_lookup_failed");
    }
    if (!isObj(a)) throw new MediaToolError("media_lookup_failed");
    return a;
  }

  /**
   * The moderation values a model lists, checked: none listed = confirmed "no moderation option"; a descriptor
   * whose values cannot be read, or that names none this server knows the order of, cannot be judged — for a youth
   * account that is `media_lookup_failed` (never sent with moderation unconfirmed).
   */
  private moderation(ctx: CallCtx, params: Params): string | null {
    if (!params.has("moderation")) return null;
    const vals = params.get("moderation");
    const known = vals ? [...vals].filter((v) => (STRICTNESS as readonly string[]).includes(v)) : [];
    if (!known.length) {
      if (ctx.youth) throw new MediaToolError("media_lookup_failed");
      return null;
    }
    return moderationFor({ youth: ctx.youth }, known);
  }

  /** Listed values that may go into a hint: plain identifiers that carry no known secret. */
  private hintValues(vals: Iterable<string>, max: number): string {
    return [...vals]
      .filter((v) => HINT_VALUE.test(v) && !this.secret([v]))
      .slice(0, max)
      .join(", ");
  }

  private async planImage(ctx: CallCtx, input: ImageInput): Promise<Plan> {
    const answer = await this.lookup(imageEndpointsUrl(ctx.model), ctx.apiKey);
    // A 200 is not a record: the model's endpoints, each with its parameters and its price list (OpenAPI required).
    const endpoints = Array.isArray(answer.endpoints) ? answer.endpoints : [];
    if (
      answer.id !== ctx.model ||
      !endpoints.length ||
      // Prices missing or empty are the cost bound's business (`media_no_price`), not a failed lookup.
      !endpoints.every((e) => isObj(e) && isObj(e.supported_parameters))
    )
      throw new MediaToolError("media_lookup_failed");
    const params = mergeParams(endpoints.map((e) => (e as Record<string, unknown>).supported_parameters));
    if (input.aspectRatio) {
      if (!params.has("aspect_ratio"))
        throw new MediaToolError(
          "media_bad_option",
          "이 모델은 비율(aspectRatio)을 고를 수 없어요. 빼고 다시 해 보세요.",
        );
      const vals = params.get("aspect_ratio");
      if (vals && !vals.has(input.aspectRatio))
        throw new MediaToolError("media_bad_option", `이 모델의 비율: ${this.hintValues(vals, 20)}`);
    }
    // Output: a raster format the model lists (asked for explicitly); a vector-only model is refused unpaid.
    const formats = new Set(endpoints.flatMap((e) => outputFormats(e.supported_parameters) ?? []));
    let outputFormat: string | undefined;
    if (formats.size) {
      outputFormat = ["png", "webp", "jpeg", "jpg"].find((f) => formats.has(f));
      if (!outputFormat || !(RASTER_FORMATS as readonly string[]).includes(outputFormat))
        throw new MediaToolError("media_unsupported_model");
    }
    const refs = input.referenceFileIds ? this.references(ctx, input.referenceFileIds) : [];
    const moderation = this.moderation(ctx, params);
    const body = withMediaPolicy({
      model: ctx.model,
      prompt: input.prompt,
      n: 1,
      response_format: "b64_json",
      ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
      ...(outputFormat ? { output_format: outputFormat } : {}),
      ...(moderation ? { moderation } : {}),
      ...(refs.length
        ? {
            input_references: refs.map((r) => ({
              type: "image_url",
              image_url: { url: `data:${r.mediaType};base64,${r.data.toString("base64")}` },
            })),
          }
        : {}),
    });
    return {
      body,
      texts: [
        OPENROUTER_IMAGES_URL,
        ctx.model,
        input.prompt,
        input.aspectRatio ?? "",
        outputFormat ?? "",
        moderation ?? "",
      ],
      bound: imageCostBound(endpoints, { prompt: input.prompt, references: refs.map((r) => r.megapixels) }),
    };
  }

  /**
   * The reference images: this user's and conversation's sent png·jpg·webp files, read and hash-checked, their
   * metadata stripped (`strip.ts`) and what is left checked for known secrets.
   */
  private references(
    ctx: CallCtx,
    ids: readonly string[],
  ): { mediaType: string; data: Buffer; megapixels: number }[] {
    const bad = () => new MediaToolError("media_reference_invalid");
    const files = [...new Set(ids)].map((id) => ctx.store.get(id));
    // The whole request's processing is bounded before any file is read.
    if (files.reduce((a, f) => a + (f?.bytes ?? 0), 0) > MEDIA_TOOL_LIMITS.referenceTotalBytes) throw bad();
    // The shortest secret the egress check knows (a configured `.env` value may be shorter than the registry's).
    const minRun = Math.max(
      4,
      Math.min(
        MIN_KNOWN_LENGTH,
        ...Object.values(this.o.secrets ?? {})
          .filter(Boolean)
          // UTF-16 units, as the registry measures (MIN_KNOWN_LENGTH) and as `textRuns` counts.
          .map((v) => v.length),
      ),
    );
    return files.map((f) => {
      if (
        !f ||
        f.userId !== ctx.scope.userId ||
        f.conversationId !== ctx.scope.conversationId ||
        !f.messageId
      )
        throw bad();
      const m = this.o.db
        .select({ active: messages.active })
        .from(messages)
        .where(and(eq(messages.id, f.messageId), eq(messages.conversationId, ctx.scope.conversationId)))
        .get();
      if (!m?.active || !REFERENCE_KINDS.has(f.kind) || f.bytes > MEDIA_TOOL_LIMITS.referenceBytes)
        throw bad();
      const data = readStored(ctx.store, f);
      const kind = data ? imageKindOf(data) : undefined;
      if (!data || kind !== f.kind) throw bad();
      const clean = stripImage(data, kind);
      if (!clean || imageKindOf(clean) !== kind) throw bad();
      // Its real area (what an input priced per megapixel is reserved for), capped like an output.
      const size = imageSize(clean, kind);
      if (!size || size.width * size.height > MAX_IMAGE_PIXELS) throw bad();
      const runs = textRuns(clean, minRun);
      if (!runs) throw bad();
      if (this.secret(runs)) throw new MediaToolError("media_secret_blocked");
      return { mediaType: f.mediaType, data: clean, megapixels: (size.width * size.height) / 1_000_000 };
    });
  }

  private async planSpeech(ctx: CallCtx, input: SpeechInput): Promise<Plan> {
    // #248: the pieces first — a text that needs more than one cannot be made without ffmpeg (nothing is asked).
    const texts = splitSpeech(input.text, this.split);
    if (texts.length > this.split.maxPieces) throw new MediaToolError("media_too_long");
    ctx.audio = this.o.speechAudio?.();
    if (texts.length > 1 && !ctx.audio) throw new MediaToolError("media_split_unavailable");
    const [answer, priced] = await Promise.all([
      this.lookup(speechModelUrl(ctx.model), ctx.apiKey),
      this.lookup(modelEndpointsUrl(ctx.model), ctx.apiKey),
    ]);
    // A 200 is not a record: the model itself, with its speech output's parameters; its endpoints' prices.
    const data = isObj(priced.data) ? priced.data : {};
    const endpoints = Array.isArray(data.endpoints) ? data.endpoints : [];
    if (
      answer.id !== ctx.model ||
      !Array.isArray(answer.output_modalities) ||
      !answer.output_modalities.some(
        (m) => isObj(m) && m.type === "speech" && isObj(m.supported_parameters),
      ) ||
      data.id !== ctx.model ||
      !endpoints.length
    )
      throw new MediaToolError("media_lookup_failed");
    const maps: unknown[] = [];
    const outs = [
      ...(Array.isArray(answer.output_modalities) ? answer.output_modalities : []),
      ...(Array.isArray(answer.endpoints)
        ? answer.endpoints.flatMap((e) =>
            isObj(e) && Array.isArray(e.output_modalities) ? e.output_modalities : [],
          )
        : []),
    ];
    for (const out of outs) if (isObj(out)) maps.push(out.supported_parameters);
    const params = mergeParams(maps);
    const formats = params.get("response_format");
    // The file is stored as MP3: a model that answers only in raw PCM is not usable here (yet).
    if (formats && !formats.has("mp3")) throw new MediaToolError("media_unsupported_model");
    const voices = params.get("voice");
    let voice = input.voice;
    if (voice) {
      // Only a voice of the model's confirmed public list: a provider may also take custom or cloned voice ids.
      if (!voices)
        throw new MediaToolError(
          "media_bad_option",
          "이 모델은 목소리 목록을 알려 주지 않아 voice를 지정할 수 없어요. voice를 빼고 다시 해 보세요.",
        );
      if (!voices.has(voice))
        throw new MediaToolError(
          "media_bad_option",
          `이 모델의 목소리(voice): ${this.hintValues(voices, 30)}`,
        );
    }
    voice ??= voices ? [...voices].find((v) => HINT_VALUE.test(v)) : undefined;
    const moderation = this.moderation(ctx, params);
    // Every piece the same request but its `input` (set per piece).
    const body = withMediaPolicy({
      model: ctx.model,
      input: input.text,
      response_format: "mp3",
      ...(voice ? { voice } : {}),
      ...(input.instructions ? { instructions: input.instructions } : {}),
      ...(moderation ? { moderation } : {}),
    });
    // Every bound as the integer micro-USD its row will hold: the check sums exactly what is reserved (#248).
    const microsOf = (text: string) => {
      const b = speechCostBound(endpoints, { text, instructions: input.instructions });
      return b === null ? null : boundMicros(b);
    };
    const pieces = texts.map((text) => ({ text, micros: microsOf(text) }));
    // The headroom of one retry: the largest piece's bound when split smaller (its pieces' bounds summed).
    let headroom = 0;
    let total: number | null = 0;
    for (const p of pieces) {
      if (p.micros === null || total === null) {
        total = null;
        break;
      }
      total += p.micros;
      if (!ctx.audio) continue;
      const again = resplitSpeech(p.text, this.split).map(microsOf);
      if (again.some((b) => b === null)) {
        total = null;
        break;
      }
      headroom = Math.max(
        headroom,
        (again as number[]).reduce((a, b) => a + b, 0),
      );
    }
    const check = total === null ? null : total + headroom;
    return {
      body,
      voice,
      texts: [
        OPENROUTER_SPEECH_URL,
        ctx.model,
        input.text,
        voice ?? "",
        input.instructions ?? "",
        moderation ?? "",
      ],
      bound: check === null ? null : check / 1_000_000,
      checkMicros: check ?? undefined,
      pieces: check === null ? [] : (pieces as PlannedPiece[]),
      microsOf,
      // What each piece's request carries besides its text (checked again before every request).
      sentTexts: [OPENROUTER_SPEECH_URL, ctx.model, voice ?? "", input.instructions ?? "", moderation ?? ""],
    };
  }

  // ---------------------------------------------------------------- the calls (money spent)

  /** The answer before 2xx: a refusal (not billed) removes the reserving row; an unknown outcome keeps it. */
  private refused(ctx: CallCtx, callId: string, e: unknown): MediaToolError {
    if (e instanceof MediaHttpError && e.status > 0) {
      this.write(ctx, "release", () => this.o.usage?.releaseMedia(mediaRunKey(ctx.scope.runId, callId)));
      if (e.status === 402) return new MediaToolError("media_payment");
      if (e.status === 429) return new MediaToolError("media_rate_limited");
      if (e.status === 400 || e.status === 403 || e.status === 422)
        return new MediaToolError("media_refused");
    }
    // Sent, but whether it was billed is not known (network error, timeout): the bound stays, for good.
    this.write(ctx, "settle", () => this.o.usage?.unconfirmMedia(mediaRunKey(ctx.scope.runId, callId)));
    return new MediaToolError("media_failed");
  }

  /**
   * The 2xx headers came: OpenRouter's generation id (validated) is written on the reserving row at once — before
   * the body is read or the cost looked up — so a process that stops now leaves a row the next one can settle.
   */
  private headersCame(ctx: CallCtx, callId: string, res: Response): string | null {
    const raw = res.headers.get("x-generation-id");
    const id = raw && GENERATION_ID.test(raw) ? raw : null;
    if (id)
      this.write(ctx, "settle", () =>
        this.o.usage?.generationMedia(mediaRunKey(ctx.scope.runId, callId), id),
      );
    return id;
  }

  /**
   * After a 2xx: the reported cost settles the row; without one, the row waits for its cost (`awaiting_cost`, the
   * settler looks the generation id up later) or — no id to look up — can never be confirmed (`unconfirmed`). The
   * bound holds the budget until then.
   */
  private settle(ctx: CallCtx, callId: string, cost: number | null, generationId: string | null): void {
    const key = mediaRunKey(ctx.scope.runId, callId);
    this.write(ctx, "settle", () =>
      cost !== null
        ? this.o.usage?.settleMedia(key, cost)
        : this.o.usage?.answeredMedia(
            key,
            generationId && GENERATION_ID.test(generationId) ? generationId : null,
          ),
    );
  }

  private async image(ctx: CallCtx, callId: string, body: Record<string, unknown>): Promise<MediaToolOutput> {
    let res: Response;
    try {
      res = await openRouterPost(OPENROUTER_IMAGES_URL, body, {
        apiKey: ctx.apiKey,
        fetchImpl: this.o.fetchImpl,
        timeoutMs: MEDIA_TOOL_LIMITS.imageTimeoutMs,
      });
    } catch (e) {
      throw this.refused(ctx, callId, e);
    }
    // 2xx: the reserving row stays; from here the money may be spent whatever happens to the answer.
    const generationId = this.headersCame(ctx, callId, res);
    let answer: unknown;
    try {
      answer = JSON.parse(new TextDecoder().decode(await readBytes(res, IMAGE_ANSWER_MAX)));
    } catch {
      this.settle(ctx, callId, null, generationId);
      throw new MediaToolError("media_failed");
    }
    const usage = isObj(answer) && isObj(answer.usage) ? answer.usage : {};
    const cost =
      typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : null;
    this.settle(ctx, callId, cost, generationId);
    const first = isObj(answer) && Array.isArray(answer.data) && isObj(answer.data[0]) ? answer.data[0] : {};
    const b64 = typeof first.b64_json === "string" && B64.test(first.b64_json) ? first.b64_json : null;
    if (!b64) throw new MediaToolError("media_failed");
    const bytes = Buffer.from(b64, "base64");
    if (!bytes.length || bytes.length > FILE_LIMITS.bytes) throw new MediaToolError("media_failed");
    const kind = imageKindOf(bytes);
    if (!kind) throw new MediaToolError("media_unsupported_model");
    const file = await this.store(ctx, bytes, kind, `image-${stamp(this.now())}.${kind}`);
    return {
      status: "ok",
      fileId: file.fileId,
      file,
      model: ctx.model,
      costUsd: cost,
      note: "The image is saved as a file of this conversation and shown under your reply. Describe it in a sentence; do not paste its URL.",
    };
  }

  /**
   * One speech request — one piece of the text (#248; a text that fits is its only piece). Its answer's bytes (null
   * when the body could not be read or passes `maxBytes`) and its cost lookup, which settles the piece's own row
   * whatever happens to the bytes afterwards.
   */
  private async piece(
    ctx: CallCtx,
    p: Piece,
    body: Record<string, unknown>,
    maxBytes: number,
  ): Promise<{ bytes: Buffer | null; cost: Promise<number | null> }> {
    let res: Response;
    try {
      res = await openRouterPost(
        OPENROUTER_SPEECH_URL,
        { ...body, input: p.text },
        {
          apiKey: ctx.apiKey,
          fetchImpl: this.o.fetchImpl,
          timeoutMs: MEDIA_TOOL_LIMITS.speechTimeoutMs,
        },
      );
    } catch (e) {
      throw this.refused(ctx, p.callId, e);
    }
    // 2xx: the reserving row stays, and the cost is looked up whatever happens to the body or the file.
    const generation = this.headersCame(ctx, p.callId, res);
    let bytes: Buffer | null = null;
    if (/json/i.test(res.headers.get("content-type") ?? "")) await res.body?.cancel().catch(() => {});
    else {
      try {
        bytes = await readBytes(res, maxBytes);
      } catch {
        bytes = null;
      }
    }
    const cost = this.cost(generation, ctx.apiKey).then((c) => {
      this.settle(ctx, p.callId, c, generation);
      return c;
    });
    return { bytes, cost };
  }

  /**
   * The speech call (#248): its reserved pieces one after another, each measured and — cut by the provider — split
   * smaller and tried once more, then joined and stored as one MP3. See the comment at the top of this file.
   */
  private async speech(ctx: CallCtx, plan: Plan, reserved: Piece[]): Promise<MediaToolOutput> {
    const audio = ctx.audio;
    const queue: Piece[] = [...reserved];
    /** Reserved rows whose request has not been sent (removed when the call stops early). */
    const unsent = new Set(reserved.map((p) => p.callId));
    const costs: Promise<number | null>[] = [];
    const made: Made[] = [];
    let bytesSoFar = 0;
    let n = 0;
    const started = this.now();
    let workdir: string | undefined;
    try {
      if (audio) {
        try {
          workdir = audio.workdir();
        } catch {
          throw new MediaToolError("media_failed");
        }
      }
      while (queue.length) {
        const p = queue.shift()!;
        // Every piece after the first: the run may have stopped, the admin changed something, the time run out.
        if (costs.length) {
          if (!ctx.alive()) throw new MediaToolError("media_cancelled");
          if (ctx.changed?.()) throw new MediaToolError("media_changed");
          if (this.now() - started > MEDIA_TOOL_LIMITS.speechCallTimeoutMs)
            throw new MediaToolError(
              "media_failed",
              "글이 길어 정해진 시간 안에 다 읽지 못해 저장하지 않았어요. 더 짧게 나눠 요청해 주세요.",
            );
        }
        const left = FILE_LIMITS.bytes - bytesSoFar;
        if (left <= 0) throw new MediaToolError("media_failed");
        // Synchronously from here to the request: egress check, a new day's budget, the row marked sent.
        this.sending(ctx, plan, p);
        unsent.delete(p.callId);
        const r = await this.piece(ctx, p, plan.body, left);
        costs.push(r.cost);
        if (!r.bytes) throw new MediaToolError("media_failed");
        if (!r.bytes.length || !isMp3(r.bytes)) throw new MediaToolError("media_unsupported_model");
        if (!audio || !workdir) {
          // No ffprobe here: a text of one piece, unmeasured (as before #248).
          made.push({ bytes: r.bytes });
          bytesSoFar += r.bytes.length;
          continue;
        }
        const file = path.join(workdir, "in", `piece-${String(n++).padStart(3, "0")}.mp3`);
        fs.writeFileSync(file, r.bytes, { flag: "wx", mode: 0o600 });
        const info = await audio.probe(file, ctx.signal);
        if (!info) throw this.stopped(ctx) ?? new MediaToolError("media_failed");
        if (looksCut(p.text, info.seconds, this.split)) {
          // Cut by the provider: smaller pieces, once (their rows reserved — and the budget checked — first).
          fs.rmSync(file, { force: true });
          const parts = p.retry ? [] : resplitSpeech(p.text, this.split);
          if (!parts.length) throw new MediaToolError("media_truncated");
          if (!ctx.alive()) throw new MediaToolError("media_cancelled");
          // The call's cap on paid requests, the retry included (the ones made, the ones queued, these).
          if (costs.length + queue.length + parts.length > this.split.maxRequests)
            throw new MediaToolError("media_truncated", TOO_MANY_REQUESTS);
          const micros = parts.map((t) => plan.microsOf!(t));
          if (micros.some((b) => b === null)) throw new MediaToolError("media_no_price");
          const again = this.reserve(
            ctx,
            parts.map((text, i) => ({ text, micros: micros[i]! })),
            (micros as number[]).reduce((a, b) => a + b, 0),
          );
          for (const a of again) unsent.add(a.callId);
          queue.unshift(...again.map((a) => ({ ...a, retry: true })));
          continue;
        }
        made.push({ file, bytes: r.bytes, info });
        bytesSoFar += r.bytes.length;
      }
      const joined = await this.joined(ctx, made, workdir);
      const file = await this.store(ctx, joined.bytes, "mp3", `speech-${stamp(this.now())}.mp3`);
      const all = await Promise.all(costs);
      return {
        status: "ok",
        fileId: file.fileId,
        file,
        model: ctx.model,
        ...(plan.voice ? { voice: plan.voice } : {}),
        durationSeconds: joined.seconds,
        chunks: made.length,
        costUsd: all.some((c) => c === null)
          ? null
          : Number((all as number[]).reduce((a, b) => a + b, 0).toFixed(10)),
        note: "The audio is saved as an MP3 file of this conversation; the user can play it under your reply.",
      };
    } finally {
      for (const id of unsent) this.release(ctx, id);
      await Promise.all(costs.map((c) => c.catch(() => null)));
      if (workdir) removeSpeechWorkdir(workdir);
    }
  }

  /** `media_cancelled` when the call was stopped (a measurement or join killed with it); else undefined. */
  private stopped(ctx: CallCtx): MediaToolError | undefined {
    return ctx.signal?.aborted || !ctx.alive() ? new MediaToolError("media_cancelled") : undefined;
  }

  /**
   * The pieces as one MP3 (#248): one piece as it came; several joined by ffmpeg — stream copy when every piece has
   * the same stream (codec, rate, channels), else re-encoded; over 50MB once more at 64 kbit/s mono — and the
   * result measured: about the pieces' summed length (a few frames per seam), or nothing is stored.
   */
  private async joined(
    ctx: CallCtx,
    made: Made[],
    workdir: string | undefined,
  ): Promise<{ bytes: Buffer; seconds: number | null }> {
    const audio = ctx.audio;
    const first = made[0];
    if (!first) throw new MediaToolError("media_failed");
    const round = (s: number) => Math.round(s * 100) / 100;
    if (!audio || !workdir || !first.info) return { bytes: first.bytes, seconds: null };
    if (made.length === 1) return { bytes: first.bytes, seconds: round(first.info.seconds) };
    if (!ctx.alive()) throw new MediaToolError("media_cancelled");
    const infos = made.map((m) => m.info!);
    const files = made.map((m) => m.file!);
    const want = infos.reduce((a, i) => a + i.seconds, 0);
    const head = infos[0]!;
    const same = infos.every(
      (i) => i.codec === "mp3" && i.sampleRate === head.sampleRate && i.channels === head.channels,
    );
    const size = (f: string) => fs.statSync(f).size;
    let out = await audio.join(
      {
        workdir,
        files,
        reencode: same ? undefined : { bitrateK: 128, sampleRate: head.sampleRate, channels: head.channels },
      },
      ctx.signal,
    );
    if (out && size(out) > FILE_LIMITS.bytes)
      out = await audio.join(
        { workdir, files, reencode: { bitrateK: 64, sampleRate: head.sampleRate, channels: 1 } },
        ctx.signal,
      );
    if (!out || !size(out) || size(out) > FILE_LIMITS.bytes)
      throw this.stopped(ctx) ?? new MediaToolError("media_failed");
    const info = await audio.probe(out, ctx.signal);
    if (!info) throw this.stopped(ctx) ?? new MediaToolError("media_failed");
    if (Math.abs(info.seconds - want) > 1 + 0.25 * made.length) throw new MediaToolError("media_failed");
    const bytes = fs.readFileSync(out);
    if (!isMp3(bytes)) throw new MediaToolError("media_failed");
    return { bytes, seconds: round(info.seconds) };
  }

  /**
   * The generation's cost (`GET /generation?id=` → `data.total_cost`), tried a few times — the record can lag the
   * answer a little. Null when there is no id, or no cost came (the reserved bound then keeps holding).
   */
  private async cost(id: string | null, apiKey: string): Promise<number | null> {
    if (!id || !generationUrl(id)) return null;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let i = 0; i < MEDIA_TOOL_LIMITS.costTries; i++) {
      if (i) await sleep(MEDIA_TOOL_LIMITS.costWaitMs * i);
      const c = await generationCost(id, apiKey, this.o.fetchImpl);
      if (c !== null) return c;
    }
    return null;
  }

  /** The bytes as a file of the conversation, linked to the run's reply (inside the store's write lock: `alive`). */
  private async store(ctx: CallCtx, bytes: Buffer, kind: FileKind, name: string): Promise<MediaFileOut> {
    if (!ctx.alive()) throw new MediaToolError("media_cancelled");
    const tmp = ctx.store.tempFile();
    try {
      fs.writeFileSync(tmp, bytes, { flag: "wx", mode: 0o600 });
      const row = await ctx.store.addGenerated({
        userId: ctx.scope.userId,
        conversationId: ctx.scope.conversationId,
        messageId: ctx.messageId,
        name,
        kind,
        bytes: bytes.length,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        tmp,
        guard: ctx.alive,
      });
      // Stored: the place it held among the conversation's files is now the file itself.
      ctx.fileSaved?.();
      return {
        fileId: row.id,
        name: scrubKnown(row.name),
        bytes: row.bytes,
        url: `/api/files/${row.id}/content`,
        kind,
      };
    } catch (e) {
      if (e instanceof MediaToolError) throw e;
      if (e instanceof FileLimitError) throw new MediaToolError("media_file_limit");
      if (e instanceof FileAddCancelledError) throw new MediaToolError("media_cancelled");
      if ((e as { code?: unknown }).code === "SQLITE_CONSTRAINT_FOREIGNKEY")
        throw new MediaToolError("media_not_allowed");
      throw e;
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  }
}

type ImageInput = { prompt: string; aspectRatio?: string; referenceFileIds?: string[] };
type SpeechInput = { text: string; voice?: string; instructions?: string };
type CallCtx = {
  scope: ToolScope;
  /** The caller's stop (the MCP service aborts it when the run ends): ffprobe/ffmpeg are killed with it. */
  signal?: AbortSignal | undefined;
  /** Whether the admin changed the settings or the key since the call started (#248: checked before every piece). */
  changed?: () => boolean;
  /** #248: ffprobe/ffmpeg of this call (undefined: not on this server). */
  audio?: SpeechAudio | undefined;
  store: FileStore;
  messageId: string;
  model: string;
  apiKey: string;
  youth: boolean;
  alive: () => boolean;
  /** Releases the call's in-flight file place (once the file is stored, or when the call ends). */
  fileSaved?: () => void;
};
type Plan = {
  body: Record<string, unknown>;
  /** Every text of the request that leaves this server (the egress check). */
  texts: string[];
  /** The call's cost upper bound (USD); null = none can be given (the call is refused). */
  bound: number | null;
  voice?: string | undefined;
  /** Speech (#248): the pieces of the text with their bounds. */
  pieces?: PlannedPiece[];
  /** Speech: what the budget must allow up front — the pieces' bounds plus one retry's headroom (micro-USD). */
  checkMicros?: number | undefined;
  /** Speech: a piece's bound in micro-USD (a retry's smaller pieces). */
  microsOf?: (text: string) => number | null;
  /** Speech: every text a piece's request carries besides its own text (the egress check before each request). */
  sentTexts?: string[];
};
/** A piece of a speech text and its bound as the integer micro-USD its row holds. */
type PlannedPiece = { text: string; micros: number };
/**
 * A reserved piece: its own call id (usage row) and the service day its row counts for. `retry`: already a smaller
 * piece of one that came back cut.
 */
type Piece = PlannedPiece & { callId: string; day: number; retry?: boolean };

/** #248: a retry that would pass the call's cap on paid requests. */
const TOO_MANY_REQUESTS =
  "음성 조각이 제공자 쪽에서 끊겨 다시 나누면 한 번의 호출에서 보낼 수 있는 요청 수를 넘어 멈췄어요. 파일은 저장하지 않았고, 이미 나간 비용은 기록됐어요. 글을 몇 부분으로 나눠 따로 요청해 주세요.";
/** A piece's answer: its bytes, and (measured) its file in the working folder and its stream. */
type Made = { bytes: Buffer; file?: string; info?: Mp3Info };

/** `20261124-153012` (UTC) for a file name. */
const stamp = (t: number) => new Date(t).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);

/** A stored file's bytes through the store's checked open, matching its size and hash; undefined otherwise. */
function readStored(store: FileStore, f: FileRow): Buffer | undefined {
  const fd = store.open(f);
  if (fd === undefined) return undefined;
  try {
    const buf = Buffer.alloc(f.bytes);
    let at = 0;
    while (at < buf.length) {
      const n = fs.readSync(fd, buf, at, buf.length - at, at);
      if (n <= 0) break;
      at += n;
    }
    if (at !== f.bytes || crypto.createHash("sha256").update(buf).digest("hex") !== f.sha256)
      return undefined;
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

/** A generation's cost (`GET /generation?id=` → `data.total_cost`) once; null when not (yet) there. */
export async function generationCost(
  id: string,
  apiKey: string,
  fetchImpl?: typeof fetch | undefined,
  signal?: AbortSignal | undefined,
): Promise<number | null> {
  const url = generationUrl(id);
  if (!url) return null;
  try {
    const a = await openRouterGet(url, { apiKey, signal, ...(fetchImpl ? { fetchImpl } : {}) });
    const c = isObj(a) && isObj(a.data) ? a.data.total_cost : undefined;
    return typeof c === "number" && Number.isFinite(c) && c >= 0 ? c : null;
  } catch {
    return null;
  }
}
