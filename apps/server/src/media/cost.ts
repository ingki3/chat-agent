/**
 * The upper bound of one generation's cost (#238 stage 2, review r1 P1): reserved in the daily budget before the
 * paid request and replaced by the reported cost afterwards (`UsageStore.reserveMedia`/`settleMedia`). A bound is
 * always on the safe side — every endpoint the request may be routed to, every price tier (variants, overrides),
 * every billable part — and when a price's unit gives no bound (an image priced per output token), there is none:
 * the call is refused (`media_no_price`) rather than sent unreserved.
 */

/** Added to every bound: rounding, provider-side wrapping of the prompt. */
export const COST_MARGIN = 1.2;
/** The largest image OpenRouter lists (`resolution` up to 8K): 8192 × 8192 pixels. */
export const MAX_IMAGE_MEGAPIXELS = (8192 * 8192) / 1_000_000;
/**
 * Speech: the longest the audio of a text can be — half a second per character (far slower than any voice reads),
 * plus 30 s — and the most audio tokens a second of it can be billed as (Gemini TTS: 32/s; 50 here).
 */
export const SPEECH_SECONDS_PER_CHAR = 0.5;
export const SPEECH_EXTRA_SECONDS = 30;
export const AUDIO_TOKENS_PER_SECOND = 50;
/** Text tokens never outnumber UTF-8 bytes (byte-level tokenizers); a per-character price is bounded the same. */
const utf8 = (s: string) => Buffer.byteLength(s, "utf8");

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/**
 * An image request's bound from its model's endpoint records (`ImageEndpoint.pricing: [{billable, unit, cost_usd,
 * variant?}]`): the dearest endpoint; per billable part its dearest line (a variant is a tier) times its most
 * possible quantity. Null = no bound (no records, or a part whose unit gives none).
 */
export function imageCostBound(
  endpoints: readonly unknown[],
  o: { prompt: string; references: number },
): number | null {
  const records = endpoints.filter(isObj);
  if (!records.length) return null;
  let worst = 0;
  for (const ep of records) {
    if (!Array.isArray(ep.pricing)) return null;
    const byPart = new Map<string, number>();
    for (const l of ep.pricing) {
      if (!isObj(l)) return null;
      const cost = num(l.cost_usd);
      if (cost === null || cost < 0) return null;
      if (cost === 0) continue;
      const q = imageQuantity(String(l.billable ?? ""), String(l.unit ?? ""), o);
      if (q === null) return null;
      const key = String(l.billable ?? "");
      byPart.set(key, Math.max(byPart.get(key) ?? 0, cost * q));
    }
    worst = Math.max(
      worst,
      [...byPart.values()].reduce((a, b) => a + b, 0),
    );
  }
  return worst * COST_MARGIN;
}

function imageQuantity(
  billable: string,
  unit: string,
  o: { prompt: string; references: number },
): number | null {
  const refs = o.references;
  switch (billable) {
    case "output_image":
      return unit === "image" || unit === "request" ? 1 : unit === "megapixel" ? MAX_IMAGE_MEGAPIXELS : null;
    case "input_text":
      return unit === "token" ? utf8(o.prompt) + 64 : unit === "request" ? 1 : null;
    case "input_image":
    case "input_reference":
      if (!refs) return 0;
      return unit === "image"
        ? refs
        : unit === "megapixel"
          ? refs * MAX_IMAGE_MEGAPIXELS
          : unit === "request"
            ? 1
            : null;
    case "input_font":
      return 0; // never sent
    default:
      return unit === "request" ? 1 : null;
  }
}

/** Price keys of the general Models API's `pricing` that bill what this request sends as text. */
const INPUT_KEYS = new Set(["prompt", "input_cache_read", "input_cache_write", "input_cache_write_1h"]);
/** Keys that bill nothing a speech request has (no images, no input audio, no web search). */
const NONE_KEYS = new Set(["image", "audio", "input_audio_cache", "web_search", "discount"]);

/**
 * A speech request's bound from its model's endpoints in the Models API (`data.endpoints[].pricing`, decimal
 * strings): per endpoint, each price (the dearest of the base and its `overrides`) times its most possible
 * quantity — input prices × the text's UTF-8 bytes (characters and tokens alike), `request` × 1, every other
 * (output) price × the longest audio as tokens (`AUDIO_TOKENS_PER_SECOND` × seconds — also a bound for a
 * per-second price). The unit is not stated in the answer, so every interpretation is covered. Null = no bound.
 */
export function speechCostBound(
  endpoints: readonly unknown[],
  o: { text: string; instructions?: string | undefined },
): number | null {
  const records = endpoints.filter(isObj);
  if (!records.length) return null;
  const input = utf8(o.text) + utf8(o.instructions ?? "") + 64;
  const seconds = [...o.text].length * SPEECH_SECONDS_PER_CHAR + SPEECH_EXTRA_SECONDS;
  const output = seconds * AUDIO_TOKENS_PER_SECOND;
  let worst = 0;
  for (const ep of records) {
    const p = ep.pricing;
    if (!isObj(p)) return null;
    const overrides = Array.isArray(p.overrides) ? p.overrides.filter(isObj) : [];
    let sum = 0;
    for (const [k, v] of Object.entries(p)) {
      if (k === "overrides" || NONE_KEYS.has(k)) continue;
      const prices = [num(v), ...overrides.map((x) => num(x[k]))].filter((n): n is number => n !== null);
      if (num(v) === null && v !== undefined && v !== null) return null;
      if (!prices.length) continue;
      const price = Math.max(...prices);
      // A negative price is "variable" (decided per request): no bound.
      if (price < 0) return null;
      if (price === 0) continue;
      sum += price * (INPUT_KEYS.has(k) ? input : k === "request" ? 1 : output);
    }
    worst = Math.max(worst, sum);
  }
  return worst * COST_MARGIN;
}
