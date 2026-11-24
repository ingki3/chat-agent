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
  o: { apiKey?: string | undefined; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<unknown> {
  if (!url.startsWith(`${OPENROUTER_API}/`) || carriesSecret([url])) throw new OpenRouterError("failed");
  const doFetch = o.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      method: "GET",
      headers: { Accept: "application/json", ...(o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {}) },
      redirect: "error",
      signal: AbortSignal.timeout(o.timeoutMs ?? OPENROUTER_TIMEOUT_MS),
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
  if (!res.body) return "";
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
  // As `Response.text()` decodes: UTF-8, a leading BOM dropped.
  return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
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

/** "$0.04 / image"-like texts from a price map (USD amounts as numbers or decimal strings): the non-zero ones. */
export function priceText(pricing: unknown, unitOf: (key: string) => string = (k) => k): string | null {
  if (!isObj(pricing)) return null;
  const parts: string[] = [];
  for (const [k, v] of Object.entries(pricing)) {
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
    if (!Number.isFinite(n) || n <= 0) continue;
    parts.push(`$${String(+n.toPrecision(6))}/${clip(unitOf(k), 30)}`);
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

/** First pricing found on a speech/image entry or its endpoints (the shapes differ by catalog). */
function entryPrice(e: Json): string | null {
  const direct = priceText(e.pricing);
  if (direct) return direct;
  if (Array.isArray(e.endpoints))
    for (const ep of e.endpoints) {
      if (!isObj(ep)) continue;
      const p = priceText(ep.pricing);
      if (p) return p;
      if (Array.isArray(ep.pricing)) {
        // `[{billable, unit, cost_usd}]` lines (the image endpoints' shape)
        const lines = ep.pricing
          .filter(isObj)
          .map((l) => ({ unit: str(l.unit) ?? str(l.billable) ?? "단위", cost: Number(l.cost_usd) }))
          .filter((l) => Number.isFinite(l.cost) && l.cost > 0)
          .slice(0, 3)
          .map((l) => `$${String(+l.cost.toPrecision(6))}/${clip(l.unit, 30)}`);
        if (lines.length) return lines.join(", ");
      }
    }
  return null;
}

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
    return {
      id,
      name,
      price: priceText(e.pricing),
      options: optionTexts(e.supported_parameters),
    };
  }
  if (kind === "speech") {
    // Parameters sit on the output modality entries (merged over endpoints); older shapes put them on the model.
    const outs = Array.isArray(e.output_modalities) ? e.output_modalities.filter(isObj) : [];
    const params =
      outs.find((o) => isObj(o.supported_parameters))?.supported_parameters ?? e.supported_parameters;
    return { id, name, price: entryPrice(e), options: optionTexts(params) };
  }
  return { id, name, price: entryPrice(e), options: optionTexts(e.supported_parameters) };
}

/** A kind's catalog as the screen lists it (entries that do not parse are left out, never guessed). */
export async function fetchCatalog(
  kind: MediaKind,
  o: { apiKey?: string | undefined; fetchImpl?: typeof fetch },
): Promise<Omit<MediaCatalog, "generation">> {
  const answer = await openRouterGet(MEDIA_CATALOG_URLS[kind], o);
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
  models.sort((a, b) => a.id.localeCompare(b.id));
  return { kind, source: MEDIA_CATALOG_URLS[kind].replace("https://openrouter.ai", ""), models };
}
