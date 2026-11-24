import crypto from "node:crypto";
import fs from "node:fs";
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
import { scrubKnown, scrubKnownDeep } from "../secrets/known.js";
import type { UsageStore } from "../usage/store.js";
import type { MediaBudget } from "./budget.js";
import { imageCostBound, speechCostBound } from "./cost.js";
import type { OpenRouterKeys } from "./keys.js";
import {
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
import { moderationFor, withMediaPolicy } from "./policy.js";
import type { MediaSettingsStore } from "./settings.js";
import { printableRuns, stripImage } from "./strip.js";

/**
 * `image_generate` and `speech_generate` (#238 stage 2): one synchronous OpenRouter generation per call, stored as
 * a file of the run's conversation linked to its reply (the reply then shows it: an inline image, an audio player).
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
 */
export type MediaGeneratorOptions = {
  db: Db;
  files: () => FileStore | undefined;
  keys: Pick<OpenRouterKeys, "resolve">;
  settings: Pick<MediaSettingsStore, "get" | "revision">;
  budget: Pick<MediaBudget, "allows">;
  usage: Pick<UsageStore, "reserveMedia" | "settleMedia" | "releaseMedia"> | undefined;
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
};

export const MEDIA_SLOTS = { total: 4, perUser: 2 } as const;

export type MediaFileOut = { fileId: string; name: string; bytes: number; url: string; kind: FileKind };
export type MediaToolOutput = {
  status: "ok";
  fileId: string;
  file: MediaFileOut;
  model: string;
  voice?: string;
  /** OpenRouter's reported cost (USD); null when it reported none. */
  costUsd: number | null;
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

  constructor(private readonly o: MediaGeneratorOptions) {
    this.now = o.now ?? Date.now;
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
    };

    const limits = this.o.slots ?? MEDIA_SLOTS;
    const mine = this.byUser.get(scope.userId) ?? 0;
    if (this.running >= limits.total || mine >= limits.perUser) throw new MediaToolError("media_busy");
    this.running++;
    this.byUser.set(scope.userId, mine + 1);
    let holdsFile = false;
    try {
      const plan =
        kind === "image"
          ? await this.planImage(ctx, parsed.data as ImageInput)
          : await this.planSpeech(ctx, parsed.data as SpeechInput);
      // The admin may have switched the kind off, picked another model or changed the key meanwhile.
      const nowKey = this.o.keys.resolve();
      const nowKind = this.o.settings.get().kinds[kind];
      if (
        this.o.settings.revision() !== revision ||
        nowKey?.key !== key.key ||
        !nowKind.enabled ||
        nowKind.model !== model
      )
        throw new MediaToolError("media_changed");
      if (this.secret(plan.texts)) throw new MediaToolError("media_secret_blocked");
      if (plan.bound === null) throw new MediaToolError("media_no_price");
      if (!this.takeCall(scope.runId, kind, settings.perRunLimits[kind]))
        throw new MediaToolError("media_quota");
      // A place among the conversation's files, counting the calls in flight — before anything is paid for.
      const inFlight = this.filesInFlight.get(scope.conversationId) ?? 0;
      if (store.count(scope.conversationId) + inFlight >= FILE_LIMITS.perConversation)
        throw new MediaToolError("media_file_limit");
      this.filesInFlight.set(scope.conversationId, inFlight + 1);
      holdsFile = true;
      if (!alive()) throw new MediaToolError("media_cancelled");
      // The budget check and the reserving row in one synchronous step.
      const callId = crypto.randomUUID();
      if (!this.o.budget.allows(scope.userId, plan.bound)) throw new MediaToolError("media_budget");
      if (
        !this.write(ctx, "reserve", () =>
          this.o.usage?.reserveMedia({ ...this.row(ctx, callId), estimateUsd: plan.bound! }),
        )
      )
        throw new MediaToolError("media_failed");
      return kind === "image"
        ? await this.image(ctx, callId, plan.body)
        : await this.speech(ctx, callId, plan.body, plan.voice);
    } finally {
      if (holdsFile) {
        const left = (this.filesInFlight.get(scope.conversationId) ?? 1) - 1;
        if (left > 0) this.filesInFlight.set(scope.conversationId, left);
        else this.filesInFlight.delete(scope.conversationId);
      }
      this.running--;
      const left = (this.byUser.get(scope.userId) ?? 1) - 1;
      if (left > 0) this.byUser.set(scope.userId, left);
      else this.byUser.delete(scope.userId);
    }
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

  /** Listed values that may go into a hint: plain identifiers that carry no known secret. */
  private hintValues(vals: Iterable<string>, max: number): string {
    return [...vals]
      .filter((v) => HINT_VALUE.test(v) && !this.secret([v]))
      .slice(0, max)
      .join(", ");
  }

  private async planImage(ctx: CallCtx, input: ImageInput): Promise<Plan> {
    const answer = await this.lookup(imageEndpointsUrl(ctx.model), ctx.apiKey);
    const endpoints = Array.isArray(answer.endpoints) ? answer.endpoints.filter(isObj) : [];
    if (!endpoints.length) throw new MediaToolError("media_lookup_failed");
    const params = mergeParams(endpoints.map((e) => e.supported_parameters));
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
    const moderationValues = params.get("moderation");
    const moderation = moderationFor(
      { youth: ctx.youth },
      moderationValues ? [...moderationValues] : undefined,
    );
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
      bound: imageCostBound(endpoints, { prompt: input.prompt, references: refs.length }),
    };
  }

  /**
   * The reference images: this user's and conversation's sent png·jpg·webp files, read and hash-checked, their
   * metadata stripped (`strip.ts`) and what is left checked for known secrets.
   */
  private references(ctx: CallCtx, ids: readonly string[]): { mediaType: string; data: Buffer }[] {
    const bad = () => new MediaToolError("media_reference_invalid");
    return [...new Set(ids)].map((id) => {
      const f = ctx.store.get(id);
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
      const runs = printableRuns(clean);
      if (!runs || this.secret(runs)) throw new MediaToolError("media_secret_blocked");
      return { mediaType: f.mediaType, data: clean };
    });
  }

  private async planSpeech(ctx: CallCtx, input: SpeechInput): Promise<Plan> {
    const [answer, priced] = await Promise.all([
      this.lookup(speechModelUrl(ctx.model), ctx.apiKey),
      this.lookup(modelEndpointsUrl(ctx.model), ctx.apiKey),
    ]);
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
    const moderationValues = params.get("moderation");
    const moderation = moderationFor(
      { youth: ctx.youth },
      moderationValues ? [...moderationValues] : undefined,
    );
    const body = withMediaPolicy({
      model: ctx.model,
      input: input.text,
      response_format: "mp3",
      ...(voice ? { voice } : {}),
      ...(input.instructions ? { instructions: input.instructions } : {}),
      ...(moderation ? { moderation } : {}),
    });
    const data = isObj(priced.data) ? priced.data : {};
    const endpoints = Array.isArray(data.endpoints) ? data.endpoints : [];
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
      bound: speechCostBound(endpoints, { text: input.text, instructions: input.instructions }),
    };
  }

  // ---------------------------------------------------------------- the calls (money spent)

  /** The answer before 2xx: a refusal (not billed) removes the reserving row; an unknown outcome keeps it. */
  private refused(ctx: CallCtx, callId: string, e: unknown): MediaToolError {
    if (e instanceof MediaHttpError && e.status > 0) {
      this.write(ctx, "release", () => this.o.usage?.releaseMedia(ctx.scope.runId, callId));
      if (e.status === 402) return new MediaToolError("media_payment");
      if (e.status === 429) return new MediaToolError("media_rate_limited");
      if (e.status === 400 || e.status === 403 || e.status === 422)
        return new MediaToolError("media_refused");
    }
    return new MediaToolError("media_failed");
  }

  private settle(ctx: CallCtx, callId: string, cost: number | null): void {
    if (cost === null) return; // the bound keeps holding the budget
    this.write(ctx, "settle", () => this.o.usage?.settleMedia(ctx.scope.runId, callId, cost));
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
    let answer: unknown;
    try {
      answer = JSON.parse(new TextDecoder().decode(await readBytes(res, IMAGE_ANSWER_MAX)));
    } catch {
      throw new MediaToolError("media_failed");
    }
    const usage = isObj(answer) && isObj(answer.usage) ? answer.usage : {};
    const cost =
      typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : null;
    this.settle(ctx, callId, cost);
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

  private async speech(
    ctx: CallCtx,
    callId: string,
    body: Record<string, unknown>,
    voice: string | undefined,
  ): Promise<MediaToolOutput> {
    let res: Response;
    try {
      res = await openRouterPost(OPENROUTER_SPEECH_URL, body, {
        apiKey: ctx.apiKey,
        fetchImpl: this.o.fetchImpl,
        timeoutMs: MEDIA_TOOL_LIMITS.speechTimeoutMs,
      });
    } catch (e) {
      throw this.refused(ctx, callId, e);
    }
    // 2xx: the reserving row stays, and the cost is looked up whatever happens to the body or the file.
    const generation = res.headers.get("x-generation-id");
    let bytes: Buffer | null = null;
    if (/json/i.test(res.headers.get("content-type") ?? "")) await res.body?.cancel().catch(() => {});
    else {
      try {
        bytes = await readBytes(res, FILE_LIMITS.bytes);
      } catch {
        bytes = null;
      }
    }
    const cost = this.cost(generation, ctx.apiKey).then((c) => {
      this.settle(ctx, callId, c);
      return c;
    });
    try {
      if (!bytes) throw new MediaToolError("media_failed");
      if (!bytes.length || !isMp3(bytes)) throw new MediaToolError("media_unsupported_model");
      const file = await this.store(ctx, bytes, "mp3", `speech-${stamp(this.now())}.mp3`);
      return {
        status: "ok",
        fileId: file.fileId,
        file,
        model: ctx.model,
        ...(voice ? { voice } : {}),
        costUsd: await cost,
        note: "The audio is saved as an MP3 file of this conversation; the user can play it under your reply.",
      };
    } finally {
      await cost.catch(() => null);
    }
  }

  /**
   * The generation's cost (`GET /generation?id=` → `data.total_cost`), tried a few times — the record can lag the
   * answer a little. Null when there is no id, or no cost came (the reserved bound then keeps holding).
   */
  private async cost(id: string | null, apiKey: string): Promise<number | null> {
    const url = id ? generationUrl(id) : null;
    if (!url) return null;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let i = 0; i < MEDIA_TOOL_LIMITS.costTries; i++) {
      if (i) await sleep(MEDIA_TOOL_LIMITS.costWaitMs * i);
      try {
        const a = await openRouterGet(url, {
          apiKey,
          ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
        });
        const c = isObj(a) && isObj(a.data) ? a.data.total_cost : undefined;
        if (typeof c === "number" && Number.isFinite(c) && c >= 0) return c;
      } catch {
        // tried again
      }
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
  store: FileStore;
  messageId: string;
  model: string;
  apiKey: string;
  youth: boolean;
  alive: () => boolean;
};
type Plan = {
  body: Record<string, unknown>;
  /** Every text of the request that leaves this server (the egress check). */
  texts: string[];
  /** The call's cost upper bound (USD); null = none can be given (the call is refused). */
  bound: number | null;
  voice?: string | undefined;
};

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
