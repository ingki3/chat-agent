import { MEDIA_LIMITS, VIDEO_LIMITS } from "@agentlee/shared";
import { boundMicros, videoCostBound, videoPricing, type VideoPricing } from "./cost.js";

/**
 * A video card's options from its model's record in `/videos/models` (#238 stage 3, review item 10) — pure, so the
 * card, the approval and the admin's choice judge a record the same way. Only what this server can bound and play:
 * whole-second lengths the model lists, resolutions `<n>p` with n ≤ 1080 (no 2K/4K), the aspect ratios it lists.
 */
export type VideoRecord = {
  id: string;
  durations: number[];
  /** Usable resolutions (≤ 1080p), lowest first. */
  resolutions: string[];
  /** Null: the model lists none (then none is sent). */
  aspectRatios: string[] | null;
  /** `generate_audio`: the endpoint's default for sound (null: not stated). */
  audio: boolean | null;
  skus: unknown;
};

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const P = /^(\d{3,4})p$/i;
const RATIO = /^\d{1,2}:\d{1,2}$/;

/** `720p` → 720; anything else (2K, 4K, 1K, free text) → undefined. */
export const resolutionP = (r: string): number | undefined => {
  const m = P.exec(r);
  return m ? Number(m[1]) : undefined;
};

/** The model's record of the catalog answer (`{data: [...]}`), parsed; undefined when it is not there. */
export function videoRecordOf(answer: unknown, model: string): VideoRecord | undefined {
  const data = isObj(answer) && Array.isArray(answer.data) ? answer.data : [];
  const e = data.find((x) => isObj(x) && x.id === model);
  if (!isObj(e)) return undefined;
  const durations = Array.isArray(e.supported_durations)
    ? [
        ...new Set(
          e.supported_durations.filter(
            (d): d is number =>
              typeof d === "number" && Number.isInteger(d) && d > 0 && d <= MEDIA_LIMITS.videoMaxSec,
          ),
        ),
      ].sort((a, b) => a - b)
    : [];
  const resolutions = Array.isArray(e.supported_resolutions)
    ? [
        ...new Set(
          e.supported_resolutions.filter(
            (r): r is string =>
              typeof r === "string" &&
              resolutionP(r) !== undefined &&
              resolutionP(r)! <= VIDEO_LIMITS.maxResolutionP,
          ),
        ),
      ].sort((a, b) => resolutionP(a)! - resolutionP(b)!)
    : [];
  const ratios = Array.isArray(e.supported_aspect_ratios)
    ? [
        ...new Set(
          e.supported_aspect_ratios.filter((r): r is string => typeof r === "string" && RATIO.test(r)),
        ),
      ]
    : [];
  return {
    id: model,
    durations,
    resolutions,
    aspectRatios: ratios.length ? ratios : null,
    audio: typeof e.generate_audio === "boolean" ? e.generate_audio : null,
    skus: e.pricing_skus,
  };
}

/** Whether a model can be used for cards at all (the admin's choice): lengths, a usable resolution, a bound. */
export function videoModelVerdict(
  r: VideoRecord,
): { ok: true } | { ok: false; reason: "unsupported" | Exclude<VideoPricing, { ok: true }>["reason"] } {
  if (!r.durations.length || !r.resolutions.length) return { ok: false, reason: "unsupported" };
  const p = videoPricing(r.skus, r.resolutions);
  return p.ok ? { ok: true } : { ok: false, reason: p.reason };
}

export type VideoChoice = {
  durationSec: number;
  resolution: string;
  aspectRatio: string | null;
  audio: boolean | null;
  /** The bound in integer micro-USD (the number shown, checked and reserved). */
  micros: number;
};

export type VideoPlanError =
  | { code: "media_video_unsupported" }
  | { code: "media_no_price" }
  | { code: "media_bad_option"; hint: string };

/**
 * The card's options for what was asked (review item 10):
 * - length: asked for — the shortest listed one at least that long, else the longest; not asked — the longest listed
 *   one at most the admin's default (8 s), else the shortest;
 * - resolution: asked for — it must be listed and ≤ 1080p; not asked — 720p if listed, else the lowest listed;
 * - aspect ratio: asked for — it must be listed (a model listing none takes none); not asked — 16:9 if listed, else
 *   the first listed, else none (the model's default).
 * Then the bound for that length and resolution — none is `media_no_price`.
 */
export function planVideo(
  r: VideoRecord,
  ask: {
    durationSec?: number | undefined;
    resolution?: string | undefined;
    aspectRatio?: string | undefined;
  },
  defaultSec: number,
): VideoChoice | VideoPlanError {
  if (!r.durations.length || !r.resolutions.length) return { code: "media_video_unsupported" };
  const d = r.durations;
  const durationSec =
    ask.durationSec !== undefined
      ? (d.find((x) => x >= ask.durationSec!) ?? d.at(-1)!)
      : ([...d].reverse().find((x) => x <= defaultSec) ?? d[0]!);
  let resolution: string;
  if (ask.resolution !== undefined) {
    const want = r.resolutions.find((x) => x.toLowerCase() === ask.resolution!.toLowerCase());
    if (!want)
      return { code: "media_bad_option", hint: `이 모델의 해상도(1080p 이하): ${r.resolutions.join(", ")}` };
    resolution = want;
  } else
    resolution =
      r.resolutions.find((x) => x.toLowerCase() === VIDEO_LIMITS.defaultResolution) ?? r.resolutions[0]!;
  let aspectRatio: string | null;
  if (ask.aspectRatio !== undefined) {
    if (!r.aspectRatios?.includes(ask.aspectRatio))
      return {
        code: "media_bad_option",
        hint: r.aspectRatios
          ? `이 모델의 화면비: ${r.aspectRatios.slice(0, 12).join(", ")}`
          : "이 모델은 화면비를 고를 수 없어요. aspectRatio를 빼고 다시 해 보세요.",
      };
    aspectRatio = ask.aspectRatio;
  } else
    aspectRatio = r.aspectRatios
      ? r.aspectRatios.includes(VIDEO_LIMITS.defaultAspectRatio)
        ? VIDEO_LIMITS.defaultAspectRatio
        : r.aspectRatios[0]!
      : null;
  return boundOf(r, { durationSec, resolution, aspectRatio });
}

/**
 * The approval's check (review item 10): the card's exact combination is still offered (else `null` — the card
 * expires), and its bound now.
 */
export function replanVideo(
  r: VideoRecord,
  c: { durationSec: number; resolution: string; aspectRatio: string | null },
): VideoChoice | VideoPlanError | null {
  if (!r.durations.includes(c.durationSec) || !r.resolutions.includes(c.resolution)) return null;
  if (c.aspectRatio === null ? r.aspectRatios !== null : !r.aspectRatios?.includes(c.aspectRatio))
    return null;
  return boundOf(r, c);
}

function boundOf(
  r: VideoRecord,
  c: { durationSec: number; resolution: string; aspectRatio: string | null },
): VideoChoice | VideoPlanError {
  const usd = videoCostBound(r.skus, { resolution: c.resolution, durationSec: c.durationSec });
  if (usd === null) return { code: "media_no_price" };
  return { ...c, audio: r.audio, micros: boundMicros(usd) };
}

export const isPlanError = (p: VideoChoice | VideoPlanError): p is VideoPlanError => "code" in p;
