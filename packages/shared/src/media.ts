import { z } from "zod";

/**
 * 미디어 생성 (#238): images, speech (TTS), music and video made by OpenRouter models. Stage 1 is the admin's
 * settings and the common base (key, models, cost limits, request policy); the tools come in stages 2–3 and read
 * these settings as they are here.
 */

/** The kinds of media, in the order the admin screen shows them. */
export const MEDIA_KINDS = ["image", "speech", "music", "video"] as const;
export const MediaKind = z.enum(MEDIA_KINDS);
export type MediaKind = z.infer<typeof MediaKind>;

export const MEDIA_KIND_LABEL: Record<MediaKind, string> = {
  image: "이미지",
  speech: "음성",
  music: "음악",
  video: "영상",
};

/** Admin limits on the admin's numbers (the screen and the server check the same ones). */
export const MEDIA_LIMITS = {
  /** 1인당 하루 비용 한도 (USD): default (user decision 2026-11-24) and the largest the admin may set. */
  dailyCostDefaultUsd: 50,
  dailyCostMaxUsd: 10_000,
  /** Calls one run may make per kind: the defaults (issue #238) and the largest the admin may set. */
  perRunDefaults: { image: 4, speech: 3, music: 1, video: 1 } as Record<MediaKind, number>,
  perRunMax: 50,
  /** Video length when the user names none (user decision 2026-11-24); longer only on request, up to the model. */
  videoDefaultSec: 8,
  videoMaxSec: 600,
  /** Model ids as OpenRouter writes them ("author/slug", maybe ":variant"). */
  modelIdMax: 200,
} as const;

const ModelId = z
  .string()
  .trim()
  .min(1)
  .max(MEDIA_LIMITS.modelIdMax)
  .regex(/^[A-Za-z0-9._~:/-]+$/);

/** One kind's switch and target model. Enabled needs a model. */
export const MediaKindSettings = z
  .object({ enabled: z.boolean(), model: ModelId.nullable() })
  .strict()
  .refine((k) => !k.enabled || k.model !== null, { message: "enabled needs a model" });
export type MediaKindSettings = z.infer<typeof MediaKindSettings>;

const PerRun = z.number().int().min(0).max(MEDIA_LIMITS.perRunMax);

/** `PUT /api/admin/media/settings` body and the settings as stored. */
export const MediaSettings = z
  .object({
    kinds: z.object({
      image: MediaKindSettings,
      speech: MediaKindSettings,
      music: MediaKindSettings,
      video: MediaKindSettings,
    }),
    /** Per user, per service-zone day, over every kind (OpenRouter's reported cost). */
    dailyCostLimitUsd: z
      .number()
      .finite()
      .positive()
      .max(MEDIA_LIMITS.dailyCostMaxUsd)
      .refine((n) => /^\d+(\.\d{1,2})?$/.test(String(n)), { message: "at most 2 decimals" }),
    perRunLimits: z.object({ image: PerRun, speech: PerRun, music: PerRun, video: PerRun }),
    /** Video length when the user asks for none (stage 3 enforces it). */
    videoDefaultSec: z.number().int().min(1).max(MEDIA_LIMITS.videoMaxSec),
  })
  .strict();
export type MediaSettings = z.infer<typeof MediaSettings>;

/** Every kind off and no model until the admin picks one (each call costs money). */
export const DEFAULT_MEDIA_SETTINGS: MediaSettings = {
  kinds: {
    image: { enabled: false, model: null },
    speech: { enabled: false, model: null },
    music: { enabled: false, model: null },
    video: { enabled: false, model: null },
  },
  dailyCostLimitUsd: MEDIA_LIMITS.dailyCostDefaultUsd,
  perRunLimits: { ...MEDIA_LIMITS.perRunDefaults },
  videoDefaultSec: MEDIA_LIMITS.videoDefaultSec,
};

/** Where the OpenRouter key in use comes from: the admin's (saved here), `.env`, or none. */
export const MediaKeySource = z.enum(["admin", "env", "none"]);
export type MediaKeySource = z.infer<typeof MediaKeySource>;

/** The key as the screen sees it — never the value: its last 4 characters (the admin's) and its last check. */
export const MediaKeyView = z.object({
  source: MediaKeySource,
  /** The admin's key only (`.env`'s is not shown). */
  last4: z.string().nullable(),
  /** From `GET /api/v1/key` at the last check: null = unlimited (or not checked). */
  limitUsd: z.number().nullable(),
  limitRemainingUsd: z.number().nullable(),
  usageUsd: z.number().nullable(),
  checkedAt: z.number().int().nullable(),
});
export type MediaKeyView = z.infer<typeof MediaKeyView>;

/** `GET /api/admin/media`. */
export const MediaAdmin = z.object({
  key: MediaKeyView,
  settings: MediaSettings,
  /**
   * Youth accounts see media generation (user decision 2026-11-24); their requests ask the provider for its
   * strictest moderation where it has one. Fixed policy, shown so the admin knows.
   */
  youthStrictModeration: z.literal(true),
});
export type MediaAdmin = z.infer<typeof MediaAdmin>;

/** `PUT /api/admin/media/key`: a new key, checked with OpenRouter before it is saved. */
export const MediaKeyRequest = z.object({ key: z.string().trim().min(8).max(300).regex(/^\S+$/) }).strict();
export type MediaKeyRequest = z.infer<typeof MediaKeyRequest>;

/** One model in a kind's catalog, as the screen lists it. */
export const MediaModel = z.object({
  id: z.string(),
  name: z.string(),
  /** A short price text from the catalog ("$0.04/이미지", "$0.50/초"), null when the catalog gives none. */
  price: z.string().nullable(),
  /** Supported options in short ("aspect_ratio: 1:1, 16:9", "길이: 4·6·8초"). */
  options: z.array(z.string()),
  /** Video only: the longest length the model lists (seconds). */
  maxDurationSec: z.number().nullable().optional(),
});
export type MediaModel = z.infer<typeof MediaModel>;

/** `GET /api/admin/media/catalog/:kind`. */
export const MediaCatalog = z.object({
  kind: MediaKind,
  /** Where the list came from (shown in small print). */
  source: z.string(),
  models: z.array(MediaModel),
});
export type MediaCatalog = z.infer<typeof MediaCatalog>;

export const MEDIA_ERRORS: Record<string, string> = {
  media_key_invalid: "OpenRouter가 이 키를 받지 않았어요. 키를 다시 확인하세요.",
  media_key_check_failed: "OpenRouter에 키를 확인하지 못했어요. 잠시 뒤 다시 해 보세요.",
  media_no_key: "OpenRouter 키가 없어요. 먼저 키를 등록하세요(.env의 OPENROUTER_API_KEY도 쓸 수 있어요).",
  media_catalog_failed: "OpenRouter에서 모델 목록을 받지 못했어요. 잠시 뒤 다시 해 보세요.",
  media_key_changed: "그사이 OpenRouter 키가 바뀌었어요. 목록을 다시 불러오세요.",
  media_model_unknown: "고른 모델이 OpenRouter 목록에 없어요. 목록을 새로 불러와 다시 고르세요.",
};
