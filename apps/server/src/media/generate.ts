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
import { carriesSecret } from "../secrets/egress.js";
import { scrubKnown } from "../secrets/known.js";
import type { UsageStore } from "../usage/store.js";
import type { MediaBudget } from "./budget.js";
import type { OpenRouterKeys } from "./keys.js";
import {
  generationUrl,
  imageEndpointsUrl,
  imageUnitCost,
  MediaHttpError,
  OPENROUTER_IMAGES_URL,
  OPENROUTER_SPEECH_URL,
  OpenRouterError,
  openRouterGet,
  openRouterPost,
  readBytes,
  speechModelUrl,
} from "./openrouter.js";
import { moderationFor, withMediaPolicy } from "./policy.js";
import type { MediaSettingsStore } from "./settings.js";

/**
 * `image_generate` and `speech_generate` (#238 stage 2): one synchronous OpenRouter generation per call, stored as
 * a file of the run's conversation linked to its reply (the reply then shows it: an inline image, an audio player).
 *
 * Every call, in this order — nothing goes out before all of it passed:
 * 1. strict input; the kind switched on with a model (관리자 → 미디어 생성) and an OpenRouter key (the admin's, else
 *    `.env`'s) — else `media_disabled` / `media_no_key`;
 * 2. the run is this user's, still open, and still wants results (`alive`); reference images are this user's and
 *    conversation's sent png·jpg·webp files;
 * 3. every outgoing text (prompt, text, voice, instructions, model, URL) passes the one egress predicate
 *    (`carriesSecret`, also against `.env`'s values) — `media_secret_blocked`, told to the model as `media_failed`;
 * 4. the run's per-kind limit (`perRunLimits`) — `media_quota`;
 * 5. the user's daily budget (`MediaBudget`) minus what this user's calls still in flight reserved — an image's
 *    reservation is the model's listed per-image price; a speech call (priced per character, not listed per
 *    endpoint) reserves nothing, so only "something is left" is checked (docs/decisions/media-generation.md §6);
 * 6. the body gets the request policy (`provider.data_collection: "deny"`, `withMediaPolicy`) and, for a youth
 *    account, the strictest `moderation` the model lists (`moderationFor`).
 *
 * The cost is what OpenRouter reports — the image answer's `usage.cost`, the speech call's generation record
 * (`X-Generation-Id` → `/generation?id=`) — or null ("not reported", counted apart). A generation that answered
 * is always recorded (its money is spent), also when the run stopped meanwhile and the file is not stored.
 * Nothing about the prompt, the text or the answer is logged (the MCP service logs a fixed code).
 */
export type MediaGeneratorOptions = {
  db: Db;
  files: () => FileStore | undefined;
  keys: Pick<OpenRouterKeys, "resolve">;
  settings: Pick<MediaSettingsStore, "get">;
  budget: Pick<MediaBudget, "allows">;
  usage: Pick<UsageStore, "recordMedia"> | undefined;
  users: Pick<UserStore, "byId">;
  fetchImpl?: typeof fetch | undefined;
  /** The `.env` skill secrets (by env name): the egress check knows them too. */
  secrets?: Readonly<Record<string, string>> | undefined;
  /** Tests: the wait between cost lookups. */
  sleep?: (ms: number) => Promise<void>;
  /** Generations at once: in total and per user. */
  slots?: { total: number; perUser: number };
  now?: () => number;
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
function mergeParams(maps: unknown[]): Params | null {
  const out: Params = new Map();
  let any = false;
  for (const m of maps) {
    if (typeof m !== "object" || m === null || Array.isArray(m)) continue;
    any = true;
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
  return any ? out : null;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export class MediaGenerator {
  private readonly calls = new Map<string, { n: number; at: number }>();
  /** Micro-USD reserved by this user's calls in flight (their estimate), released when each one settles. */
  private readonly reserved = new Map<string, number>();
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
      return { ok: true, output: await this.execute(kind, scope, input, o) };
    } catch (e) {
      if (e instanceof MediaToolError) {
        const hint = e.hint ?? MEDIA_TOOL_HINTS[e.code];
        return { ok: false, code: e.code, ...(hint ? { hint } : {}) };
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

  private async execute(
    kind: Kind,
    scope: ToolScope,
    raw: Record<string, unknown>,
    o: { alive?: (() => boolean) | undefined; signal?: AbortSignal | undefined },
  ): Promise<MediaToolOutput> {
    const tool = kind === "image" ? IMAGE_GENERATE_TOOL : SPEECH_GENERATE_TOOL;
    const parsed = z.strictObject(tool.input).safeParse(raw);
    if (!parsed.success) throw new MediaToolError("media_bad_input");
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
    const ctx = { scope, store, messageId, model, apiKey: key.key, youth: user.youth === true, alive };

    const limits = this.o.slots ?? MEDIA_SLOTS;
    const mine = this.byUser.get(scope.userId) ?? 0;
    if (this.running >= limits.total || mine >= limits.perUser) throw new MediaToolError("media_busy");
    this.running++;
    this.byUser.set(scope.userId, mine + 1);
    let reservation = 0;
    try {
      const plan =
        kind === "image"
          ? await this.planImage(ctx, parsed.data as ImageInput)
          : await this.planSpeech(ctx, parsed.data as SpeechInput);
      if (carriesSecret(plan.texts, { config: Object.values(this.o.secrets ?? {}) }))
        throw new MediaToolError("media_secret_blocked");
      if (!this.takeCall(scope.runId, kind, settings.perRunLimits[kind]))
        throw new MediaToolError("media_quota");
      // The daily budget, with what this user's other calls in flight reserved (their estimates).
      const held = this.reserved.get(scope.userId) ?? 0;
      const estimate = Math.round((plan.estimateUsd ?? 0) * 1_000_000);
      if (!this.o.budget.allows(scope.userId, (held + estimate) / 1_000_000))
        throw new MediaToolError("media_budget");
      reservation = estimate;
      this.reserved.set(scope.userId, held + estimate);
      if (!alive()) throw new MediaToolError("media_cancelled");
      return kind === "image"
        ? await this.image(ctx, plan.body)
        : await this.speech(ctx, plan.body, plan.voice);
    } finally {
      if (reservation) {
        const left = (this.reserved.get(scope.userId) ?? reservation) - reservation;
        if (left > 0) this.reserved.set(scope.userId, left);
        else this.reserved.delete(scope.userId);
      }
      this.running--;
      const left = (this.byUser.get(scope.userId) ?? 1) - 1;
      if (left > 0) this.byUser.set(scope.userId, left);
      else this.byUser.delete(scope.userId);
    }
  }

  // ---------------------------------------------------------------- planning (no money spent)

  /** A model's details read for this call (null when OpenRouter did not answer: the call goes on without them). */
  private async details(url: string | null, apiKey: string): Promise<unknown> {
    if (!url) return null;
    try {
      return await openRouterGet(url, {
        apiKey,
        ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
      });
    } catch {
      return null;
    }
  }

  private async planImage(ctx: CallCtx, input: ImageInput): Promise<Plan> {
    const answer = await this.details(imageEndpointsUrl(ctx.model), ctx.apiKey);
    const endpoints = isObj(answer) && Array.isArray(answer.endpoints) ? answer.endpoints : null;
    const params = endpoints
      ? mergeParams(endpoints.map((e) => (isObj(e) ? e.supported_parameters : null)))
      : null;
    if (input.aspectRatio && params) {
      if (!params.has("aspect_ratio"))
        throw new MediaToolError(
          "media_bad_option",
          "이 모델은 비율(aspectRatio)을 고를 수 없어요. 빼고 다시 해 보세요.",
        );
      const vals = params.get("aspect_ratio");
      if (vals && !vals.has(input.aspectRatio))
        throw new MediaToolError("media_bad_option", `이 모델의 비율: ${[...vals].slice(0, 20).join(", ")}`);
    }
    const refs = input.referenceFileIds ? this.references(ctx, input.referenceFileIds) : [];
    const moderation = moderationFor(
      { youth: ctx.youth },
      params?.get("moderation") ? [...params.get("moderation")!] : undefined,
    );
    const body = withMediaPolicy({
      model: ctx.model,
      prompt: input.prompt,
      n: 1,
      response_format: "b64_json",
      ...(input.aspectRatio ? { aspect_ratio: input.aspectRatio } : {}),
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
      texts: [OPENROUTER_IMAGES_URL, ctx.model, input.prompt, input.aspectRatio ?? "", moderation ?? ""],
      estimateUsd: endpoints ? imageUnitCost(endpoints) : null,
    };
  }

  /** The reference images: this user's and conversation's sent png·jpg·webp files, read and hash-checked. */
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
      if (!data || imageKindOf(data) !== f.kind) throw bad();
      return { mediaType: f.mediaType, data };
    });
  }

  private async planSpeech(ctx: CallCtx, input: SpeechInput): Promise<Plan> {
    const answer = await this.details(speechModelUrl(ctx.model), ctx.apiKey);
    const maps: unknown[] = [];
    if (isObj(answer)) {
      const outs = [
        ...(Array.isArray(answer.output_modalities) ? answer.output_modalities : []),
        ...(Array.isArray(answer.endpoints)
          ? answer.endpoints.flatMap((e) =>
              isObj(e) && Array.isArray(e.output_modalities) ? e.output_modalities : [],
            )
          : []),
      ];
      for (const out of outs) if (isObj(out)) maps.push(out.supported_parameters);
    }
    const params = mergeParams(maps);
    const formats = params?.get("response_format");
    // The file is stored as MP3: a model that answers only in raw PCM is not usable here (yet).
    if (formats && !formats.has("mp3")) throw new MediaToolError("media_unsupported_model");
    const voices = params?.get("voice");
    let voice = input.voice;
    if (voice && voices && !voices.has(voice))
      throw new MediaToolError(
        "media_bad_option",
        `이 모델의 목소리(voice): ${scrubKnown([...voices].slice(0, 30).join(", "))}`,
      );
    voice ??= voices ? [...voices][0] : undefined;
    const moderation = moderationFor(
      { youth: ctx.youth },
      params?.get("moderation") ? [...params.get("moderation")!] : undefined,
    );
    const body = withMediaPolicy({
      model: ctx.model,
      input: input.text,
      response_format: "mp3",
      ...(voice ? { voice } : {}),
      ...(input.instructions ? { instructions: input.instructions } : {}),
      ...(moderation ? { moderation } : {}),
    });
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
      // Priced per character in the general Models API, not per endpoint: no reservation (see the class note).
      estimateUsd: null,
    };
  }

  // ---------------------------------------------------------------- the calls (money spent)

  private failure(e: unknown): MediaToolError {
    if (e instanceof MediaToolError) return e;
    if (e instanceof MediaHttpError) {
      if (e.status === 402) return new MediaToolError("media_payment");
      if (e.status === 429) return new MediaToolError("media_rate_limited");
      if (e.status === 400 || e.status === 403 || e.status === 422)
        return new MediaToolError("media_refused");
    }
    return new MediaToolError("media_failed");
  }

  private record(ctx: CallCtx, callId: string, costUsd: number | null): void {
    try {
      this.o.usage?.recordMedia({
        userId: ctx.scope.userId,
        conversationId: ctx.scope.conversationId,
        runId: ctx.scope.runId,
        callId,
        model: ctx.model,
        costUsd,
      });
    } catch {
      // A usage row never breaks the call (the generation is already made).
    }
  }

  private async image(ctx: CallCtx, body: Record<string, unknown>): Promise<MediaToolOutput> {
    let answer: unknown;
    try {
      const res = await openRouterPost(OPENROUTER_IMAGES_URL, body, {
        apiKey: ctx.apiKey,
        fetchImpl: this.o.fetchImpl,
        timeoutMs: MEDIA_TOOL_LIMITS.imageTimeoutMs,
      });
      answer = JSON.parse(new TextDecoder().decode(await readBytes(res, IMAGE_ANSWER_MAX)));
    } catch (e) {
      throw this.failure(
        e instanceof OpenRouterError || e instanceof SyntaxError ? new MediaHttpError(0) : e,
      );
    }
    const usage = isObj(answer) && isObj(answer.usage) ? answer.usage : {};
    const cost =
      typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : null;
    const callId = crypto.randomUUID();
    // The money is spent once OpenRouter answered: recorded before anything else can fail.
    this.record(ctx, callId, cost);
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
    body: Record<string, unknown>,
    voice: string | undefined,
  ): Promise<MediaToolOutput> {
    let bytes: Buffer;
    let generation: string | null;
    try {
      const res = await openRouterPost(OPENROUTER_SPEECH_URL, body, {
        apiKey: ctx.apiKey,
        fetchImpl: this.o.fetchImpl,
        timeoutMs: MEDIA_TOOL_LIMITS.speechTimeoutMs,
      });
      generation = res.headers.get("x-generation-id");
      if (/json/i.test(res.headers.get("content-type") ?? "")) {
        await res.body?.cancel().catch(() => {});
        throw new MediaHttpError(0);
      }
      bytes = await readBytes(res, FILE_LIMITS.bytes);
    } catch (e) {
      throw this.failure(e instanceof OpenRouterError ? new MediaHttpError(0) : e);
    }
    const callId = crypto.randomUUID();
    this.record(ctx, callId, null);
    const cost = this.cost(generation, ctx.apiKey).then((c) => {
      if (c !== null) this.record(ctx, callId, c);
      return c;
    });
    try {
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
      // The cost is looked up whatever happened to the file (the generation was made).
      await cost.catch(() => null);
    }
  }

  /**
   * The generation's cost (`GET /generation?id=` → `data.total_cost`), tried a few times — the record can lag the
   * answer a little. Null when there is no id, or no cost came (the row then stays "not reported").
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
  /** The call's expected cost (USD) when the model lists it; null = not known. */
  estimateUsd: number | null;
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
