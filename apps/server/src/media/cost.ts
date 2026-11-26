/**
 * The upper bound of one generation's cost (#238 stage 2, review r1–r2 P1): reserved in the daily budget before
 * the paid request and replaced by the reported cost afterwards (`UsageStore.reserveMedia`/`settleMedia`). A bound
 * is always on the safe side — every endpoint the request may be routed to, every price tier (variants, overrides),
 * every billable part. **A missing price is not a free one:** only an explicit `0` is free; an empty price list, a
 * missing required price, a price that does not read as a number, a variable price (`-1`) anywhere, or a unit that
 * gives no bound (an image priced per output token) is no bound — the call is refused (`media_no_price`).
 */

/** Added to every bound: rounding, provider-side wrapping of the prompt. */
export const COST_MARGIN = 1.2;
/** The largest image OpenRouter lists (`resolution` up to 8K): 8192 × 8192 pixels — also the reference cap. */
export const MAX_IMAGE_PIXELS = 8192 * 8192;
export const MAX_IMAGE_MEGAPIXELS = MAX_IMAGE_PIXELS / 1_000_000;
/**
 * A bound as the integer micro-USD a reserving row holds (rounded up once). #248: a speech call's pieces are summed,
 * checked against the budget and written in these same integers.
 */
export const boundMicros = (usd: number): number => Math.ceil(usd * 1_000_000);
/** Text tokens never outnumber UTF-8 bytes (byte-level tokenizers); a per-character price is bounded the same. */
const utf8 = (s: string) => Buffer.byteLength(s, "utf8");

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
/** A price as OpenRouter writes it (a number or a decimal string); undefined when it does not read as one. */
const price = (v: unknown): number | undefined => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/**
 * An image request's bound from its model's endpoint records (`ImageEndpoint.pricing: [{billable, unit, cost_usd,
 * variant?}]`): the dearest endpoint; per billable part its dearest line (a variant is a tier) times its most
 * possible quantity. Every endpoint must list its output image's price (`0` = confirmed free). `references`: the
 * megapixels of each reference image actually sent — each billed as at least 1 and rounded up to a whole megapixel
 * (providers round per image: BFL, review r3), so small references never reserve less than they cost. Null = no
 * bound.
 */
export function imageCostBound(
  endpoints: readonly unknown[],
  o: { prompt: string; references: readonly number[] },
): number | null {
  if (!endpoints.length) return null;
  let worst = 0;
  for (const ep of endpoints) {
    if (!isObj(ep) || !Array.isArray(ep.pricing) || !ep.pricing.length) return null;
    const byPart = new Map<string, number>();
    let output = false;
    for (const l of ep.pricing) {
      if (!isObj(l) || typeof l.billable !== "string" || typeof l.unit !== "string") return null;
      const cost = price(l.cost_usd);
      if (cost === undefined || cost < 0) return null;
      if (l.billable === "output_image") output = true;
      const q = imageQuantity(l.billable, l.unit, o);
      if (q === null) {
        if (cost > 0) return null;
        continue;
      }
      byPart.set(l.billable, Math.max(byPart.get(l.billable) ?? 0, cost * q));
    }
    if (!output) return null;
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
  o: { prompt: string; references: readonly number[] },
): number | null {
  const refs = o.references;
  switch (billable) {
    case "output_image":
      return unit === "image" || unit === "request"
        ? 1
        : unit === "megapixel"
          ? Math.ceil(MAX_IMAGE_MEGAPIXELS)
          : null;
    case "input_text":
      return unit === "token" ? utf8(o.prompt) + 64 : unit === "request" ? 1 : null;
    case "input_image":
    case "input_reference":
      if (!refs.length) return 0;
      return unit === "image"
        ? refs.length
        : unit === "megapixel"
          ? // Per reference, rounded up to whole megapixels with at least one (providers bill each image so).
            refs.reduce((a, b) => a + Math.max(1, Math.ceil(b)), 0)
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
const NONE_KEYS = new Set(["image", "audio", "input_audio_cache", "web_search"]);
/** Fields of `pricing` and of its `overrides` that are not prices. */
const NOT_PRICES = new Set([
  "overrides",
  "discount",
  "min_prompt_tokens",
  "utc_days",
  "utc_start",
  "utc_end",
]);
/** `PublicPricing` requires these: an endpoint without them gives no bound. */
const REQUIRED = ["prompt", "completion"];

/**
 * A speech request's bound from its model's endpoints in the Models API (`data.endpoints[].pricing`, decimal
 * strings): per endpoint, over the union of the price keys of the base and its `overrides`, each key's dearest value
 * times its most possible quantity — input prices × the text's UTF-8 bytes (characters and tokens alike), `request`
 * × 1. A non-zero **output** price (per audio token or second: `completion`, `audio_output`, …) is no bound (#251
 * r9 — the audio's length is the provider's to decide): only models priced on their input are used. A value that
 * does not read as a number or is negative (variable) anywhere — base or override — is no bound. Null = none.
 */
export function speechCostBound(
  endpoints: readonly unknown[],
  o: { text: string; instructions?: string | undefined },
): number | null {
  if (!endpoints.length) return null;
  const input = utf8(o.text) + utf8(o.instructions ?? "") + 64;
  let worst = 0;
  for (const ep of endpoints) {
    if (!isObj(ep) || !isObj(ep.pricing)) return null;
    const base = ep.pricing;
    if (base.overrides !== undefined && !Array.isArray(base.overrides)) return null;
    const overrides: unknown[] = Array.isArray(base.overrides) ? base.overrides : [];
    if (!overrides.every(isObj)) return null;
    const tiers = [base, ...(overrides as Record<string, unknown>[])];
    if (REQUIRED.some((k) => base[k] === undefined)) return null;
    const keys = new Set(tiers.flatMap((t) => Object.keys(t)).filter((k) => !NOT_PRICES.has(k)));
    let sum = 0;
    for (const k of keys) {
      const values: number[] = [];
      for (const t of tiers) {
        if (!(k in t)) continue;
        const v = price(t[k]);
        // Unreadable or variable anywhere: no bound (a max would hide a -1 behind a positive price).
        if (v === undefined || v < 0) return null;
        values.push(v);
      }
      if (NONE_KEYS.has(k)) continue;
      const dearest = Math.max(...values);
      if (dearest === 0) continue;
      // An output price (per audio token or second — `completion`, `audio_output`, …): how much audio comes back is
      // the provider's, not bounded by the text (#251 r9: one character and an instruction to talk for 90 s billed
      // past the reservation). No bound: such a model is refused before anything is sent, and when it is chosen.
      if (!INPUT_KEYS.has(k) && k !== "request") return null;
      sum += dearest * (INPUT_KEYS.has(k) ? input : 1);
    }
    worst = Math.max(worst, sum);
  }
  return worst * COST_MARGIN;
}

/**
 * Whether a speech model is priced on its output (#251 r9): any endpoint with a non-zero price for what comes back
 * (`completion`, `audio_output`, … — base or override). Such a model has no bound (`speechCostBound`) and is refused
 * when chosen (관리자 → 미디어 생성) and before any request.
 */
export function speechOutputPriced(endpoints: readonly unknown[]): boolean {
  for (const ep of endpoints) {
    if (!isObj(ep) || !isObj(ep.pricing)) continue;
    const base = ep.pricing;
    const tiers = [base, ...(Array.isArray(base.overrides) ? base.overrides.filter(isObj) : [])];
    for (const t of tiers)
      for (const [k, v] of Object.entries(t)) {
        if (NOT_PRICES.has(k) || INPUT_KEYS.has(k) || NONE_KEYS.has(k) || k === "request") continue;
        const n = price(v);
        if (n !== undefined && n > 0) return true;
      }
  }
  return false;
}

/**
 * A speech model's price record judged (#251 r10 — the same verdict when it is chosen and before every call): the
 * Models API answer for `/models/<id>/endpoints` must be that model's record with endpoints (`invalid` otherwise);
 * priced on its output is `output_priced`; a price that gives no bound (missing, unreadable, variable `-1`) is
 * `no_price`. `ok`: its endpoints, whose bound `speechCostBound` gives.
 */
export function speechPricing(
  answer: unknown,
  model: string,
): { ok: true; endpoints: unknown[] } | { ok: false; reason: "invalid" | "output_priced" | "no_price" } {
  const data = isObj(answer) && isObj(answer.data) ? answer.data : undefined;
  const endpoints = data && Array.isArray(data.endpoints) ? data.endpoints : [];
  if (!data || data.id !== model || !endpoints.length) return { ok: false, reason: "invalid" };
  if (speechOutputPriced(endpoints)) return { ok: false, reason: "output_priced" };
  if (speechCostBound(endpoints, { text: "가" }) === null) return { ok: false, reason: "no_price" };
  return { ok: true, endpoints };
}

// ---------------------------------------------------------------- video (#238 stage 3)

/**
 * SKUs of `/videos/models`' `pricing_skus` that bill inputs this server never sends (reference or first-frame images,
 * a video input, a continuation of an earlier job): left out of a bound.
 */
const VIDEO_UNSENT =
  /^(cents_per_image_input|reference_images|reference_input_images)$|_with_video_input|video_continuation/;
/** A per-second SKU (USD per second; the `cents_*` ones in cents) and what follows its name. */
const VIDEO_PER_SECOND = [
  { re: /^(?:long_)?(?:reference_)?duration_seconds(.*)$/, cents: false },
  { re: /^cents_per_(?:video_output_second|second_output)(.*)$/, cents: true },
] as const;
/** A resolution tier as OpenRouter suffixes it (`_720p`, `_1080p`, `_2k`, `_4k`, …). */
const VIDEO_TIER = /^_(\d{3,4}p|\dk)$/;

export type VideoPricing =
  | { ok: true }
  | {
      ok: false;
      /** `token_priced`: a `video_tokens*` price (no bound from a length); `no_price`: none usable or unreadable. */
      reason: "token_priced" | "no_price";
    };

/**
 * One SKU read: a per-second price (USD) and the resolution tier it is for (null: every tier, the unsuffixed one), or
 * `ignored` (an input never sent), or `unknown` (a unit this server cannot bound: `video_tokens`, megapixels, …).
 */
function videoSku(
  key: string,
  value: unknown,
): { usdPerSec: number; tier: string | null } | "ignored" | "unknown" | "min" {
  const k = key.toLowerCase();
  if (VIDEO_UNSENT.test(k)) return "ignored";
  if (k === "minimum_cents_per_generation") return "min";
  for (const { re, cents } of VIDEO_PER_SECOND) {
    const m = re.exec(k);
    if (!m) continue;
    // Sound variants (with or without — the server never sends `generate_audio`, so both count), then the tier.
    const rest = m[1]!.replace(/_(?:with|without|no)_audio|_audio/g, "");
    const tier = rest === "" ? null : (VIDEO_TIER.exec(rest)?.[1] ?? undefined);
    if (tier === undefined) return "unknown";
    const v = price(value);
    if (v === undefined || v < 0) return "unknown";
    return { usdPerSec: cents ? v / 100 : v, tier };
  }
  return "unknown";
}

/**
 * The per-second prices of `pricing_skus`, in USD per second (the `cents_*` ones divided by 100), with the resolution
 * tier each is for (null: every tier) — what the admin's model list shows (review r1: never raw cents as dollars).
 * Prices this server cannot read or that bill inputs never sent are left out.
 */
export function videoRates(skus: unknown): { usdPerSec: number; tier: string | null }[] {
  if (!isObj(skus)) return [];
  const out: { usdPerSec: number; tier: string | null }[] = [];
  for (const [key, value] of Object.entries(skus)) {
    const s = videoSku(key, value);
    if (typeof s === "object") out.push(s);
  }
  return out;
}

/**
 * A video job's upper bound (USD) from its model's `pricing_skus` (user decision 1: only models priced per second):
 * the dearest per-second SKU that can apply to the resolution asked for — its own tier's and the unsuffixed ones,
 * every sound and long-length variant (the server never says whether to make sound) — times the length, at least the
 * model's `minimum_cents_per_generation`, times `COST_MARGIN`. SKUs of inputs never sent are left out. Any other SKU
 * this server cannot read (`video_tokens*`, per megapixel, a price that is not a number or negative) means no bound
 * (null): the model is refused when chosen and before any request.
 */
export function videoCostBound(skus: unknown, o: { resolution: string; durationSec: number }): number | null {
  if (!isObj(skus)) return null;
  const want = o.resolution.toLowerCase();
  let perSec: number | undefined;
  let min = 0;
  for (const [key, value] of Object.entries(skus)) {
    const s = videoSku(key, value);
    if (s === "ignored") continue;
    if (s === "unknown") return null;
    if (s === "min") {
      const v = price(value);
      if (v === undefined || v < 0) return null;
      min = Math.max(min, v / 100);
      continue;
    }
    if (s.tier !== null && s.tier !== want) continue;
    perSec = Math.max(perSec ?? 0, s.usdPerSec);
  }
  if (perSec === undefined || !Number.isFinite(o.durationSec) || o.durationSec <= 0) return null;
  return Math.max(perSec * o.durationSec, min) * COST_MARGIN;
}

/**
 * A video model's prices judged as a job judges them (the admin's choice and every card alike): `token_priced` for a
 * `video_tokens` price, `no_price` when no bound can be given for any tier the model lists (or none at all).
 */
export function videoPricing(skus: unknown, resolutions: readonly string[]): VideoPricing {
  if (!isObj(skus) || !Object.keys(skus).length) return { ok: false, reason: "no_price" };
  if (Object.keys(skus).some((k) => /^video_tokens/i.test(k))) return { ok: false, reason: "token_priced" };
  const tiers = resolutions.length ? resolutions : ["720p"];
  return tiers.some((r) => videoCostBound(skus, { resolution: r, durationSec: 1 }) !== null)
    ? { ok: true }
    : { ok: false, reason: "no_price" };
}
