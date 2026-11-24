import { z } from "zod";
import type { MediaCatalog, MediaKind, MediaModel } from "@agentlee/shared";
import { carriesSecret } from "../secrets/egress.js";

/**
 * The OpenRouter reads of 미디어 생성 stage 1 (#238): the key check and the per-kind model catalogs. Same rules as
 * the transcription fallback (`audio/openrouter.ts`): every URL is a constant of this file, redirects are refused,
 * the key goes only in the `Authorization` header to openrouter.ai, every URL passes the one egress predicate
 * (`carriesSecret`) before the request exists, and nothing about the request or the answer is logged.
 */
export const OPENROUTER_API = "https://openrouter.ai/api/v1";
export const OPENROUTER_KEY_URL = `${OPENROUTER_API}/key`;

/**
 * Where each kind's models come from. Images, speech and video have their own catalogs (OpenRouter docs,
 * 2026-11-24); music has none — Lyria is listed in the general Models API with audio output, so music reads that
 * list filtered by output modality (`audio`).
 */
export const MEDIA_CATALOG_URLS: Record<MediaKind, string> = {
  image: `${OPENROUTER_API}/images/models`,
  speech: `${OPENROUTER_API}/audio/speech/models`,
  music: `${OPENROUTER_API}/models?output_modalities=audio`,
  video: `${OPENROUTER_API}/videos/models`,
};

/**
 * Where the prices are when a kind's own catalog has none (OpenRouter docs and OpenAPI spec, 2026-11-24):
 *
 * - images: `/images/models` gives each model's `endpoints` as a **URL string** (`/api/v1/images/models/<id>/endpoints`);
 *   the per-endpoint records there carry `pricing: [{ billable, unit, cost_usd, variant? }]`. The URL is built here
 *   from the model id (never followed from the answer);
 * - speech: `/audio/speech/models` has no prices at all; the general Models API lists TTS models with
 *   `output_modalities=speech` and a `pricing` map of decimal strings (`prompt` per character of input, `completion`
 *   per second of audio for per-second models — TTS guide "Pricing");
 * - music: the general Models API's `pricing` map itself (`prompt`, `completion`, `request`, `audio_output`, …).
 */
export const SPEECH_PRICING_URL = `${OPENROUTER_API}/models?output_modalities=speech`;
/** `author/slug` (maybe `:variant`) — the only shape put into a per-model URL. */
const MODEL_PATH = /^[A-Za-z0-9._~-]{1,100}\/[A-Za-z0-9._~:-]{1,100}$/;
const modelPath = (id: string) =>
  MODEL_PATH.test(id) && !id.includes("..") && id.split("/").every((seg) => seg !== "." && seg !== "..")
    ? id.split("/").map(encodeURIComponent).join("/")
    : null;
/** An image model's per-endpoint records (pricing, definitive parameters); null for an id of another shape. */
export const imageEndpointsUrl = (id: string): string | null => {
  const p = modelPath(id);
  return p ? `${OPENROUTER_API}/images/models/${p}/endpoints` : null;
};
/** A speech model with each endpoint's own parameters (voices); null for an id of another shape. */
export const speechModelUrl = (id: string): string | null => {
  const p = modelPath(id);
  return p ? `${OPENROUTER_API}/audio/speech/models/${p}` : null;
};
/** A model's endpoints in the general Models API (`data.endpoints[].pricing` — a speech model's prices). */
export const modelEndpointsUrl = (id: string): string | null => {
  const p = modelPath(id);
  return p ? `${OPENROUTER_API}/models/${p}/endpoints` : null;
};
export const OPENROUTER_IMAGES_URL = `${OPENROUTER_API}/images`;
export const OPENROUTER_SPEECH_URL = `${OPENROUTER_API}/audio/speech`;
/** `GET /generation?id=` (a generation's cost, `data.total_cost`); the id as OpenRouter writes it. */
export const GENERATION_ID = /^gen-[0-9A-Za-z-]{1,124}$/;
export const generationUrl = (id: string): string | null =>
  GENERATION_ID.test(id) ? `${OPENROUTER_API}/generation?id=${id}` : null;

export const OPENROUTER_TIMEOUT_MS = 15_000;
/** The largest answer read (the models list is the big one). */
export const OPENROUTER_MAX_BYTES = 8 * 1024 * 1024;
/** Models listed per kind on the screen (the catalogs are far smaller today). */
export const CATALOG_MAX_MODELS = 300;

export class OpenRouterError extends Error {
  constructor(readonly code: "unauthorized" | "failed") {
    super(code);
  }
}

/** One GET to a fixed OpenRouter URL; the JSON answer, or `OpenRouterError`. */
export async function openRouterGet(
  url: string,
  o: {
    apiKey?: string | undefined;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    /** A caller's own stop (a shared deadline): aborts the request and the reading of its body. */
    signal?: AbortSignal | undefined;
  },
): Promise<unknown> {
  if (!url.startsWith(`${OPENROUTER_API}/`) || carriesSecret([url])) throw new OpenRouterError("failed");
  const timeout = AbortSignal.timeout(o.timeoutMs ?? OPENROUTER_TIMEOUT_MS);
  const doFetch = o.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "GET",
      headers: { Accept: "application/json", ...(o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {}) },
      redirect: "error",
      signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout,
    });
  } catch {
    throw new OpenRouterError("failed");
  }
  if (!res.ok) {
    // The outcome is known: the rest of the body is not received.
    await res.body?.cancel().catch(() => {});
    throw new OpenRouterError(res.status === 401 || res.status === 403 ? "unauthorized" : "failed");
  }
  const text = await readLimited(res);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new OpenRouterError("failed");
  }
}

/**
 * The answer's body as UTF-8 text, at most `OPENROUTER_MAX_BYTES` **bytes**: a declared length over it is refused
 * before reading, and the bytes are counted while they stream — the stream is cancelled as soon as they go over (an
 * answer without `Content-Length`, or a compressed one, is never read to its end). Same as the Cloudflare client.
 */
export async function readLimited(res: Response, max: number = OPENROUTER_MAX_BYTES): Promise<string> {
  // As `Response.text()` decodes: UTF-8, a leading BOM dropped.
  return new TextDecoder("utf-8").decode(await readBytes(res, max));
}

/**
 * `GET /api/v1/key` (OpenRouter docs): `limit` and `limit_remaining` are numbers, or `null` for an unlimited key —
 * both must be there. A missing field, a string or any other shape is not a check that passed
 * (`failed`, nothing saved): it would otherwise show as "제한 없음".
 */
const Usd = z.number().finite();
const KeyAnswer = z.object({
  data: z
    .object({
      limit: Usd.nullable(),
      limit_remaining: Usd.nullable(),
      usage: Usd.nullable().optional(),
    })
    .passthrough(),
});

export type KeyStatus = {
  limitUsd: number | null;
  limitRemainingUsd: number | null;
  usageUsd: number | null;
};

/** `GET /api/v1/key` with this key: its limit and what is left (`unauthorized` = OpenRouter refused the key). */
export async function checkKey(apiKey: string, fetchImpl?: typeof fetch): Promise<KeyStatus> {
  const answer = KeyAnswer.safeParse(
    await openRouterGet(OPENROUTER_KEY_URL, { apiKey, ...(fetchImpl ? { fetchImpl } : {}) }),
  );
  if (!answer.success) throw new OpenRouterError("failed");
  const d = answer.data.data;
  return { limitUsd: d.limit, limitRemainingUsd: d.limit_remaining, usageUsd: d.usage ?? null };
}

// ---------------------------------------------------------------- catalogs

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const MODEL_ID = /^[A-Za-z0-9._~:/-]{1,200}$/;
const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** "$0.0000006", never "$6e-7": up to 6 significant digits, plain decimals (per-character prices are tiny). */
const USD = new Intl.NumberFormat("en-US", {
  maximumSignificantDigits: 6,
  maximumFractionDigits: 12,
  useGrouping: false,
});
const usd = (n: number) => `$${USD.format(n)}`;

/** "$0.04 / image"-like texts from a price map (USD amounts as numbers or decimal strings): the non-zero ones. */
export function priceText(pricing: unknown, unitOf: (key: string) => string = (k) => k): string | null {
  if (!isObj(pricing)) return null;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(pricing)) {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
    if (!Number.isFinite(n) || n <= 0) continue;
    parts.push(`${usd(n)}/${clip(unitOf(k), 30)}`);
    if (parts.length >= 3) break;
  }
  return parts.length ? parts.join(", ") : null;
}

/** "resolution: 1K·2K·4K", "speed: 0.7–1.2", "seed" from a `supported_parameters` map (capability descriptors). */
export function optionTexts(params: unknown): string[] {
  if (Array.isArray(params))
    return params.filter((p): p is string => typeof p === "string").map((p) => clip(p));
  if (!isObj(params)) return [];
  const out: string[] = [];
  for (const [name, d] of Object.entries(params)) {
    if (!isObj(d)) {
      out.push(clip(name));
      continue;
    }
    if (Array.isArray(d.values)) {
      const vals = d.values.filter((v) => typeof v === "string" || typeof v === "number").map(String);
      out.push(clip(`${name}: ${vals.slice(0, 8).join("·")}${vals.length > 8 ? "…" : ""}`));
    } else if (typeof d.min === "number" && typeof d.max === "number")
      out.push(clip(`${name}: ${d.min}–${d.max}`));
    else out.push(clip(name));
  }
  return out.slice(0, 12);
}

const listOf = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x) => typeof x === "string" || typeof x === "number").map(String) : [];

/** `[{billable, unit, cost_usd}]` price lines (the image endpoints' shape): "$0.05/image" (the output's, if listed). */
export function priceLines(lines: unknown): string | null {
  if (!Array.isArray(lines)) return null;
  const rows = lines
    .filter(isObj)
    .map((l) => ({
      out: l.billable === "output_image",
      unit: str(l.unit) ?? str(l.billable) ?? "단위",
      variant: str(l.variant),
      cost: typeof l.cost_usd === "number" ? l.cost_usd : Number(str(l.cost_usd) ?? NaN),
    }))
    .filter((l) => Number.isFinite(l.cost) && l.cost > 0);
  // The output image's price when listed (what a call costs); the input lines only when there is none.
  const shown = rows.some((l) => l.out) ? rows.filter((l) => l.out) : rows;
  const texts = [
    ...new Set(
      shown.map((l) => `${usd(l.cost)}/${clip(l.unit, 30)}${l.variant ? ` (${clip(l.variant, 20)})` : ""}`),
    ),
  ].slice(0, 3);
  return texts.length ? texts.join(", ") : null;
}

/** First pricing found on an entry or its inline endpoints (a map, or the image endpoints' price lines). */
function entryPrice(e: Json): string | null {
  const direct = priceText(e.pricing) ?? priceLines(e.pricing);
  if (direct) return direct;
  if (Array.isArray(e.endpoints))
    for (const ep of e.endpoints) {
      if (!isObj(ep)) continue;
      const p = priceText(ep.pricing) ?? priceLines(ep.pricing);
      if (p) return p;
    }
  return null;
}

/**
 * Speech prices of the general Models API. Their unit is the model's own and not stated in the answer: per
 * character, per input text token (`prompt`), per second or per output audio token (`completion`) — OpenRouter's
 * TTS guide names characters and seconds, but Gemini TTS bills tokens (#238 review r1). So the price shows which
 * side it is and that its unit is not confirmed.
 */
const SPEECH_UNITS: Record<string, string> = { prompt: "입력 단위", completion: "출력 단위" };
export const SPEECH_UNIT_NOTE = " (단위 미확정: 글자·토큰·초 중 모델마다 다름)";

/**
 * Music: the general Models API lists every model with audio output — music models (Lyria) and voice-chat models
 * (GPT Audio and the like) alike. The documented tell is `supported_voices`: a voice-chat model lists its voices, a
 * music model has none (null). Such models stay listed (the admin decides) but say what they are.
 */
export const VOICE_CHAT_NOTE = "음성 대화 모델(음악 생성용 아님)";

function parseEntry(kind: MediaKind, e: Json): MediaModel | null {
  const id = str(e.id);
  if (!id || !MODEL_ID.test(id)) return null;
  const name = clip(str(e.name) ?? id, 120);
  if (kind === "video") {
    const durations = listOf(e.supported_durations)
      .map(Number)
      .filter((n) => Number.isFinite(n) && n > 0);
    const options = [
      durations.length ? `길이: ${durations.join("·")}초` : null,
      listOf(e.supported_resolutions).length ? `해상도: ${listOf(e.supported_resolutions).join("·")}` : null,
      listOf(e.supported_aspect_ratios).length
        ? `비율: ${listOf(e.supported_aspect_ratios).join("·")}`
        : null,
    ].filter((x): x is string => x !== null);
    return {
      id,
      name,
      price: priceText(e.pricing_skus, (k) => k.replace(/^per-/, "")) ?? priceText(e.pricing),
      options: options.map((o) => clip(o)),
      maxDurationSec: durations.length ? Math.max(...durations) : null,
    };
  }
  if (kind === "music") {
    const arch = isObj(e.architecture) ? e.architecture : {};
    if (!listOf(arch.output_modalities).includes("audio")) return null;
    const voiceChat = listOf(e.supported_voices).length > 0;
    return {
      id,
      name,
      price: priceText(e.pricing),
      options: [...(voiceChat ? [VOICE_CHAT_NOTE] : []), ...optionTexts(e.supported_parameters)].slice(0, 12),
      ...(voiceChat ? { voiceChat: true } : {}),
    };
  }
  if (kind === "speech") {
    // Parameters sit on the output modality entries (merged over endpoints); older shapes put them on the model.
    const outs = Array.isArray(e.output_modalities) ? e.output_modalities.filter(isObj) : [];
    const params =
      outs.find((o) => isObj(o.supported_parameters))?.supported_parameters ?? e.supported_parameters;
    return { id, name, price: entryPrice(e), options: optionTexts(params) };
  }
  const vectorOnly = isVectorOnly(e.supported_parameters);
  return {
    id,
    name,
    price: entryPrice(e),
    options: [...(vectorOnly ? [VECTOR_ONLY_NOTE] : []), ...optionTexts(e.supported_parameters)].slice(0, 12),
    ...(vectorOnly ? { vectorOnly: true } : {}),
  };
}

/** Raster formats this server stores (`output_format` values as OpenRouter names them). */
export const RASTER_FORMATS = ["png", "jpeg", "jpg", "webp"] as const;
export const VECTOR_ONLY_NOTE = "벡터(SVG) 전용 — 이 서버에 저장할 수 없음";

/** The `output_format` values a model lists (lower-cased), or null when it lists none. */
export function outputFormats(params: unknown): string[] | null {
  if (!isObj(params) || !isObj(params.output_format) || !Array.isArray(params.output_format.values))
    return null;
  return params.output_format.values
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.toLowerCase());
}

/** A model that lists its output formats and none of them is a raster one (SVG only, e.g. a vector model). */
export function isVectorOnly(params: unknown): boolean {
  const f = outputFormats(params);
  return !!f && f.length > 0 && !f.some((x) => (RASTER_FORMATS as readonly string[]).includes(x));
}

/** Runs `fn` over `items`, at most `limit` at a time. */
async function eachLimited<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Per-model price reads at once (the image catalog), and the whole price read's time budget. */
export const PRICE_READS_AT_ONCE = 6;
export const PRICE_READS_BUDGET_MS = 20_000;

/**
 * Fills in the prices a kind's catalog does not carry itself (see `SPEECH_PRICING_URL`). Best effort: a price that
 * cannot be read stays null ("목록에 없음") — the list itself is never failed by it.
 */
async function addPrices(
  kind: MediaKind,
  models: MediaModel[],
  o: { apiKey?: string | undefined; fetchImpl?: typeof fetch },
): Promise<void> {
  if (kind === "speech") {
    if (models.every((m) => m.price)) return;
    let answer: unknown;
    try {
      answer = await openRouterGet(SPEECH_PRICING_URL, o);
    } catch {
      return;
    }
    const data = isObj(answer) && Array.isArray(answer.data) ? answer.data : [];
    const byId = new Map<string, string>();
    for (const e of data) {
      if (!isObj(e)) continue;
      const id = str(e.id);
      const price = priceText(e.pricing, (k) => SPEECH_UNITS[k] ?? k);
      if (id && price && !byId.has(id)) byId.set(id, `${price}${SPEECH_UNIT_NOTE}`);
    }
    for (const m of models) m.price ??= byId.get(m.id) ?? null;
    return;
  }
  if (kind !== "image") return;
  const missing = models.filter((m) => !m.price && imageEndpointsUrl(m.id));
  const deadline = AbortSignal.timeout(PRICE_READS_BUDGET_MS);
  await eachLimited(missing, PRICE_READS_AT_ONCE, async (m) => {
    if (deadline.aborted) return;
    try {
      // The shared deadline also stops reads already under way (review r1, P3).
      const answer = await openRouterGet(imageEndpointsUrl(m.id)!, { ...o, signal: deadline });
      const eps = isObj(answer) && Array.isArray(answer.endpoints) ? answer.endpoints : [];
      m.price = entryPrice({ endpoints: eps });
    } catch {
      // stays null
    }
  });
}

/**
 * A kind's catalog as the screen lists it (entries that do not parse are left out, never guessed). `prices: false`
 * (a save's model check) reads only the list itself.
 */
export async function fetchCatalog(
  kind: MediaKind,
  o: { apiKey?: string | undefined; fetchImpl?: typeof fetch; prices?: boolean },
): Promise<Omit<MediaCatalog, "generation">> {
  const req = { apiKey: o.apiKey, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) };
  const answer = await openRouterGet(MEDIA_CATALOG_URLS[kind], req);
  const data = isObj(answer) && Array.isArray(answer.data) ? answer.data : null;
  if (!data) throw new OpenRouterError("failed");
  const seen = new Set<string>();
  const models: MediaModel[] = [];
  for (const e of data) {
    if (!isObj(e)) continue;
    const m = parseEntry(kind, e);
    if (!m || seen.has(m.id)) continue;
    seen.add(m.id);
    models.push(m);
    if (models.length >= CATALOG_MAX_MODELS) break;
  }
  if (o.prices !== false) await addPrices(kind, models, req);
  models.sort((a, b) => Number(!!a.voiceChat) - Number(!!b.voiceChat) || a.id.localeCompare(b.id));
  return { kind, source: MEDIA_CATALOG_URLS[kind].replace("https://openrouter.ai", ""), models };
}

// ---------------------------------------------------------------- generation requests

/**
 * One POST of a generation (`/images`, `/audio/speech`) to its fixed URL: JSON body, key only in `Authorization`,
 * redirects refused, every text of the body checked by the caller first. The `Response` when OK (the caller reads
 * it with `readLimited` / `readBytes`); otherwise `MediaHttpError` with the status (the body is not read).
 */
export class MediaHttpError extends Error {
  constructor(readonly status: number) {
    super(`http_${status}`);
  }
}

export async function openRouterPost(
  url: string,
  body: Record<string, unknown>,
  o: {
    apiKey: string;
    fetchImpl?: typeof fetch | undefined;
    timeoutMs: number;
    signal?: AbortSignal | undefined;
  },
): Promise<Response> {
  if ((url !== OPENROUTER_IMAGES_URL && url !== OPENROUTER_SPEECH_URL) || carriesSecret([url]))
    throw new MediaHttpError(0);
  const doFetch = o.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(o.timeoutMs);
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${o.apiKey}` },
      body: JSON.stringify(body),
      redirect: "error",
      signal: o.signal ? AbortSignal.any([o.signal, timeout]) : timeout,
    });
  } catch {
    throw new MediaHttpError(0);
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new MediaHttpError(res.status);
  }
  return res;
}

/** The answer's bytes, at most `max` (a declared or streamed length over it is `OpenRouterError`). */
export async function readBytes(res: Response, max: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > max) {
    await res.body.cancel().catch(() => {});
    throw new OpenRouterError("failed");
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => {});
        throw new OpenRouterError("failed");
      }
      chunks.push(value);
    }
  } catch {
    throw new OpenRouterError("failed");
  }
  return Buffer.concat(chunks);
}
