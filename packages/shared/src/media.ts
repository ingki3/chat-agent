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
  /**
   * Changes whenever the key in use may have (saved, deleted, server restart): the screen keys its catalog cache on
   * it so a list read with another key is never shown. Not derived from the key.
   */
  generation: z.string(),
});
export type MediaKeyView = z.infer<typeof MediaKeyView>;

/** `GET /api/admin/media`. */
export const MediaAdmin = z.object({
  key: MediaKeyView,
  settings: MediaSettings,
  /**
   * A fresh random token per settings save (never reused, also not by a backup restore): a save names the revision
   * it was made from (`MediaSettingsRequest`).
   */
  settingsRevision: z.string().min(1).max(64),
  /**
   * Youth accounts see media generation (user decision 2026-11-24); their requests ask the provider for its
   * strictest moderation where it has one. Fixed policy, shown so the admin knows.
   */
  youthStrictModeration: z.literal(true),
});
export type MediaAdmin = z.infer<typeof MediaAdmin>;

/** `PUT /api/admin/media/key`: a new key, checked with OpenRouter before it is saved. */
/** The key generation a key write was made from (`MediaKeyView.generation`). */
const Generation = z.string().regex(/^[0-9A-Za-z-]{1,64}:\d{1,12}$/);
export const MediaKeyRequest = z
  .object({ key: z.string().trim().min(8).max(300).regex(/^\S+$/), expectedGeneration: Generation })
  .strict();
/** `DELETE /api/admin/media/key`, `POST /api/admin/media/key/check`: the generation the screen showed. */
export const MediaKeyWriteRequest = z.object({ expectedGeneration: Generation }).strict();
/** `PUT /api/admin/media/settings`: the new settings and the revision they were made from. */
export const MediaSettingsRequest = z
  .object({ settings: MediaSettings, expectedRevision: z.string().min(1).max(64) })
  .strict();
export type MediaSettingsRequest = z.infer<typeof MediaSettingsRequest>;
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
  /** Music only: a voice-chat model (it lists voices — GPT Audio and the like), not a music model. */
  voiceChat: z.boolean().optional(),
  /** Image only: it lists only vector output formats (SVG) — this server cannot store its images. */
  vectorOnly: z.boolean().optional(),
});
export type MediaModel = z.infer<typeof MediaModel>;

/** `GET /api/admin/media/catalog/:kind`. */
export const MediaCatalog = z.object({
  kind: MediaKind,
  /** Where the list came from (shown in small print). */
  source: z.string(),
  models: z.array(MediaModel),
  /**
   * The key generation (`MediaKeyView.generation`) this list was actually read with: the screen shows a list only
   * while its key status has this same generation.
   */
  generation: z.string(),
});
export type MediaCatalog = z.infer<typeof MediaCatalog>;

export const MEDIA_ERRORS: Record<string, string> = {
  media_key_invalid: "OpenRouter가 이 키를 받지 않았어요. 키를 다시 확인하세요.",
  media_key_check_failed: "OpenRouter에 키를 확인하지 못했어요. 잠시 뒤 다시 해 보세요.",
  media_no_key: "OpenRouter 키가 없어요. 먼저 키를 등록하세요(.env의 OPENROUTER_API_KEY도 쓸 수 있어요).",
  media_catalog_failed: "OpenRouter에서 모델 목록을 받지 못했어요. 잠시 뒤 다시 해 보세요.",
  media_key_changed: "그사이 OpenRouter 키가 바뀌었어요. 목록을 다시 불러오세요.",
  media_settings_changed: "다른 곳에서 설정이 바뀌었어요. 최신 값을 불러왔어요 — 다시 확인 후 저장하세요.",
  media_model_unknown: "고른 모델이 OpenRouter 목록에 없어요. 목록을 새로 불러와 다시 고르세요.",
  media_model_unsupported:
    "이 이미지 모델은 벡터(SVG)만 만들어 이 서버에 저장할 수 없어요. png·jpeg·webp를 내는 모델을 고르세요.",
};

// ---------------------------------------------------------------- stage 2: the tools

/** `image_generate` / `speech_generate` (#238 stage 2): input limits and the stored files. */
export const MEDIA_TOOL_LIMITS = {
  promptChars: 4000,
  /**
   * The whole text of one speech call (#248: longer than one provider call can read — it is split into pieces,
   * see apps/server/src/media/speech-split.ts; about 40 minutes of Korean at a slow reading rate).
   */
  speechChars: 12_000,
  instructionsChars: 500,
  voiceChars: 100,
  /** Conversation images an image call may take as references (png·jpg·webp of the same conversation). */
  referenceFiles: 4,
  referenceBytes: 10 * 1024 * 1024,
  /** All references of one call together (what one request may make the server parse). */
  referenceTotalBytes: 20 * 1024 * 1024,
  /** How long one generation may take (the image providers can take a minute). */
  imageTimeoutMs: 180_000,
  /** One TTS request (one piece of a long text). */
  speechTimeoutMs: 120_000,
  /**
   * A whole speech call (#248): no new piece starts after this; the one under way, the join and the cost lookups
   * still finish (the runtimes' MCP tool timeout is set above all of it — runtime/lockdown.ts).
   */
  speechCallTimeoutMs: 30 * 60_000,
  /** #248: one ffprobe measurement and one ffmpeg join (a join may run twice: re-encoded when over 50MB). */
  speechProbeTimeoutMs: 20_000,
  speechJoinTimeoutMs: 180_000,
  /** Tries of `GET /generation?id=` after a speech call (its record can lag a little), and the wait between. */
  costTries: 3,
  costWaitMs: 1500,
} as const;

/** Outcome codes of the media tools (fixed: logged and shown to the model). */
export const MEDIA_TOOL_CODES = [
  "media_ok",
  "media_disabled",
  "media_no_key",
  "media_bad_input",
  "media_not_allowed",
  "media_quota",
  "media_budget",
  "media_secret_blocked",
  "media_bad_option",
  "media_unsupported_model",
  "media_reference_invalid",
  "media_refused",
  "media_payment",
  "media_rate_limited",
  "media_failed",
  "media_file_limit",
  "media_cancelled",
  "media_busy",
  "media_lookup_failed",
  "media_no_price",
  "media_changed",
  /** A usage row of a generation could not be written (operator's log and error list only). */
  "media_usage_failed",
  "media_recovering",
  /** #248: the text needs more pieces than one call may make. */
  "media_too_long",
  /** #248: the text needs several pieces, and this server has no ffmpeg/ffprobe to measure and join them. */
  "media_split_unavailable",
  /** #248: a piece came back cut by the provider, and again after it was split smaller. */
  "media_truncated",
] as const;
export type MediaToolCode = (typeof MEDIA_TOOL_CODES)[number];

/** What the model is told with a refusal (fixed words; it relays them to the user in its own words). */
export const MEDIA_TOOL_HINTS: Partial<Record<MediaToolCode, string>> = {
  media_disabled: "관리자가 이 생성 기능을 꺼 두었거나 모델을 정하지 않았어요. 관리자에게 켜 달라고 하세요.",
  media_no_key: "OpenRouter 키가 없어 만들 수 없어요. 관리자에게 키 등록을 부탁하세요.",
  media_quota: "이번 답변에서 만들 수 있는 횟수를 다 썼어요. 다음 메시지에서 다시 요청해 주세요.",
  media_budget:
    "오늘 남은 미디어 생성 예산이 이번 호출의 최대 비용(예약해 두는 상한)보다 적어요. 내일 다시 하거나 관리자에게 한도를 물어보세요.",
  media_bad_option: "이 모델이 받지 않는 옵션이에요. hint의 값 중에서 고르거나 옵션을 빼고 다시 해 보세요.",
  media_unsupported_model:
    "관리자가 고른 모델이 이 서버가 저장할 수 있는 형식(이미지 png·jpg·webp, 음성 mp3)을 내놓지 않아요. 관리자에게 다른 모델을 부탁하세요.",
  media_reference_invalid:
    "참고 이미지는 이 대화의 png·jpg·webp 파일(10MB 이하, 4개까지)만 쓸 수 있어요. file_list의 fileId를 쓰세요.",
  media_refused:
    "제공자가 이 요청을 거절했어요(내용 정책일 수 있어요). 요청을 바꾸지 말고 사용자에게 그대로 알리세요.",
  media_payment: "OpenRouter 잔액이나 키 한도가 부족해요. 관리자에게 알려 주세요.",
  media_rate_limited: "OpenRouter가 잠시 요청을 막았어요. 조금 뒤에 다시 해 보세요.",
  media_failed: "생성하지 못했어요. 잠시 뒤에 다시 해 보거나 사용자에게 알리세요.",
  media_file_limit: "이 대화의 파일이 너무 많아(20개) 저장할 수 없어요. 새 대화에서 해 주세요.",
  media_busy: "다른 생성이 진행 중이에요. 끝난 뒤에 다시 해 주세요.",
  media_lookup_failed:
    "OpenRouter에서 모델 정보(옵션·가격)를 확인하지 못해 보내지 않았어요. 잠시 뒤에 다시 해 보세요.",
  media_no_price:
    "이 모델의 비용 상한을 정할 수 없어 보내지 않았어요(가격 단위를 알 수 없음). 관리자에게 다른 모델을 부탁하세요.",
  media_recovering:
    "서버가 지난번 미디어 생성 비용 기록을 정리하는 중이라 지금은 만들 수 없어요. 잠시 뒤에 다시 해 주세요.",
  media_changed: "그사이 관리자가 생성 설정이나 키를 바꿨어요. 다시 요청해 주세요.",
  media_too_long:
    "글이 너무 길어 한 번에 읽을 수 없어요. 몇 부분으로 나눠 따로 요청해 주세요(이미 나간 비용은 없어요).",
  media_split_unavailable:
    "이 글은 약 4분이 넘어 여러 조각으로 나눠 합성해야 하는데, 이 서버에 ffmpeg가 없어 이어 붙일 수 없어요. 더 짧게 나눠 요청하거나 관리자에게 ffmpeg 설치를 부탁하세요(비용은 나가지 않았어요).",
  media_truncated:
    "음성이 제공자 쪽에서 중간에 끊겨 와서(더 잘게 나눠 다시 해도 끊김) 파일을 저장하지 않았어요. 이미 나간 비용은 기록됐어요. 글을 더 짧게 나눠 요청해 주세요.",
};
