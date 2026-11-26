import { z } from "zod";

/**
 * 미디어 생성 3단계 — 영상 (#238 stage 3, docs/decisions/media-generation.md §14). `video_generate` only proposes:
 * it makes a confirmation card (model, length, resolution, aspect ratio, sound, the most it may cost) and nothing is
 * paid until the conversation's owner approves it there. Then the server submits the job to OpenRouter, follows it
 * (`GET /videos/{id}` every 30 s), downloads and checks the MP4 and shows it in the card — on the server, whatever
 * happens to the page; a restart resumes it from the database.
 */

export const VIDEO_LIMITS = {
  /** A card not approved within this is expired (user decision 4). */
  cardTtlMs: 24 * 3600_000,
  /** A submitted job not finished within this is a timeout — its bound stays (user decision 4). */
  deadlineMs: 60 * 60_000,
  /** Between status polls (OpenRouter recommends 10–30 s). */
  pollMs: 30_000,
  /** The longest wait between polls after 429s or transient errors. */
  maxBackoffMs: 5 * 60_000,
  /** One status poll or the submit request. */
  requestTimeoutMs: 30_000,
  /** The download of one result (cut to what is left of the job's deadline). */
  downloadTimeoutMs: 15 * 60_000,
  /**
   * The disk guard of one result (user decision 5: a video may be over the 50MB file limit; 4K is never asked for,
   * so real files are far smaller).
   */
  maxBytes: 1024 * 1024 * 1024,
  /** Jobs at once (approved, not ended): per user and in total (user decision 3). */
  slots: { total: 4, perUser: 2 },
  /** The highest resolution asked for: `<n>p` with n at most this (no 2K/4K). */
  maxResolutionP: 1080,
  /** The resolution asked for when it is supported (else the lowest supported one). */
  defaultResolution: "720p",
  /**
   * The longest length a request or a model's list may name (a sanity bound of the input only — review r1: the
   * admin's default length has its own limit, `MEDIA_LIMITS.videoMaxSec`; what is asked for becomes the model's
   * nearest listed length).
   */
  requestMaxSec: 86_400,
  /** The aspect ratio asked for when the user names none and the model lists it. */
  defaultAspectRatio: "16:9",
} as const;

export const VIDEO_JOB_STATUSES = [
  "awaiting_approval",
  "submitting",
  "pending",
  "in_progress",
  "downloading",
  "done",
  "failed",
  "expired",
  "dismissed",
] as const;
export const VideoJobStatus = z.enum(VIDEO_JOB_STATUSES);
export type VideoJobStatus = z.infer<typeof VideoJobStatus>;

/** Approved and not ended: holds a slot, a file place of its conversation and its reserved bound. */
export const VIDEO_ACTIVE: ReadonlySet<VideoJobStatus> = new Set([
  "submitting",
  "pending",
  "in_progress",
  "downloading",
]);
export const VIDEO_ENDED: ReadonlySet<VideoJobStatus> = new Set(["done", "failed", "expired", "dismissed"]);

/** Why a job ended other than with its video (fixed codes: stored, logged and shown as fixed words). */
export const VIDEO_JOB_CODES = [
  /** The card waited 24 hours. */
  "video_card_expired",
  /** The admin changed the settings, the model or the key while the card waited. */
  "video_settings_changed",
  /** The model no longer offers the card's length, resolution or aspect ratio, or its prices give no bound. */
  "video_options_changed",
  /** A known secret is in what would be sent: nothing was sent. */
  "video_blocked",
  /** OpenRouter refused the submit (4xx — not billed). */
  "video_rejected",
  "video_payment",
  "video_rate_limited",
  /** The submit's outcome is unknown (network, timeout, 5xx, a restart while submitting): its bound stays. */
  "video_unconfirmed",
  /** The provider failed or cancelled the job. */
  "video_failed",
  /** The provider's moderation refused it. */
  "video_moderated",
  /** OpenRouter expired the job. */
  "video_remote_expired",
  /** Not finished within 60 minutes of the submit. */
  "video_timeout",
  /** OpenRouter no longer knows the job (404). */
  "video_lost",
  /** The finished video could not be downloaded (an error, a redirect, cut off). */
  "video_download_failed",
  /** Over the 1GB disk guard. */
  "video_too_large",
  /** Not an MP4 with a video stream. */
  "video_not_mp4",
  /** It could not be stored (the conversation's files, the disk). */
  "video_store_failed",
] as const;
export const VideoJobCode = z.enum(VIDEO_JOB_CODES);
export type VideoJobCode = z.infer<typeof VideoJobCode>;

/** `GET /api/video-jobs/:id` — the card. */
export const VideoJob = z.object({
  id: z.string(),
  conversationId: z.string(),
  messageId: z.string(),
  status: VideoJobStatus,
  model: z.string(),
  prompt: z.string(),
  durationSec: z.number().int(),
  resolution: z.string(),
  /** Null: the model lists no aspect ratios — none is sent (its default). */
  aspectRatio: z.string().nullable(),
  /** The model's own default for sound (`generate_audio` in its record): on, off, or not stated (null). */
  audio: z.boolean().nullable(),
  /** The most it may cost (the reserved upper bound, USD). */
  estimateUsd: z.number(),
  /** What OpenRouter reported, once it did. */
  costUsd: z.number().nullable(),
  /** +1 on every saved change: an approval names the version it saw. */
  version: z.number().int(),
  createdAt: z.number().int(),
  /** A card not approved by then is expired. */
  expiresAt: z.number().int(),
  approvedAt: z.number().int().nullable(),
  /** Submit + 60 minutes. */
  deadlineAt: z.number().int().nullable(),
  endedAt: z.number().int().nullable(),
  errorCode: VideoJobCode.nullable(),
  /** The provider's percent, when it reports one. */
  progress: z.number().int().min(0).max(100).nullable(),
  /** The stored video (done). */
  file: z.object({ fileId: z.string(), name: z.string(), bytes: z.number().int() }).nullable(),
  /** This server process (the card keeps the newest of two equal versions from different processes). */
  boot: z.string().optional(),
});
export type VideoJob = z.infer<typeof VideoJob>;

/** `POST /api/video-jobs/:id/approve|dismiss`: the version the card showed. */
export const VideoJobActionRequest = z.object({ version: z.number().int().nonnegative() }).strict();
export type VideoJobActionRequest = z.infer<typeof VideoJobActionRequest>;

/** A refused action that changed or re-read the card: the card as it is now. */
export const VideoJobRefusal = z.object({ error: z.string(), job: VideoJob.optional() });

/** What the card says about how a job ended (fixed words). */
export const VIDEO_JOB_CODE_TEXT: Record<VideoJobCode, string> = {
  video_card_expired: "24시간 안에 승인하지 않아 카드가 만료됐어요. 다시 요청해 주세요.",
  video_settings_changed: "그사이 관리자가 영상 설정·모델·키를 바꿔 카드가 만료됐어요. 다시 요청해 주세요.",
  video_options_changed:
    "모델이 이 길이·해상도·화면비를 더 지원하지 않거나 비용 상한을 정할 수 없게 돼 카드가 만료됐어요.",
  video_blocked: "보낼 수 없는 내용(비밀값)이 들어 있어 보내지 않았어요. 비용은 나가지 않았어요.",
  video_rejected: "OpenRouter가 이 요청을 받지 않았어요. 비용은 나가지 않았어요.",
  video_payment: "OpenRouter 잔액이나 키 한도가 부족해요. 비용은 나가지 않았어요. 관리자에게 알려 주세요.",
  video_rate_limited:
    "OpenRouter가 잠시 요청을 막았어요. 비용은 나가지 않았어요. 조금 뒤 다시 요청해 주세요.",
  video_unconfirmed:
    "제출 결과를 확인하지 못했어요. 이중 과금을 막으려고 다시 보내지 않았고, 비용은 최대치로 기록돼 있어요.",
  video_failed: "제공자가 영상을 만들지 못했어요. 비용은 최대치로 기록돼 있어요(확인되면 바뀌지 않아요).",
  video_moderated: "내용 검사에서 거부됐어요. 비용은 최대치로 기록돼 있어요.",
  video_remote_expired: "제공자 쪽에서 작업 시간이 다 돼 끝났어요. 비용은 최대치로 기록돼 있어요.",
  video_timeout: "제출 뒤 60분 안에 끝나지 않아 멈췄어요. 비용은 최대치로 기록돼 있어요.",
  video_lost: "OpenRouter에서 이 작업을 찾지 못했어요. 비용은 최대치로 기록돼 있어요.",
  video_download_failed: "완성된 영상을 받아 오지 못했어요. 비용은 기록돼 있어요.",
  video_too_large: "완성된 영상이 너무 커서(1GB 초과) 저장하지 않았어요. 비용은 기록돼 있어요.",
  video_not_mp4: "받은 파일이 MP4 영상이 아니어서 저장하지 않았어요. 비용은 기록돼 있어요.",
  video_store_failed: "완성된 영상을 이 대화에 저장하지 못했어요. 비용은 기록돼 있어요.",
};

/** The card's refused actions (`error` of a 4xx/5xx answer). */
export const VIDEO_JOB_ERRORS: Record<string, string> = {
  video_job_changed: "그사이 카드가 바뀌었어요. 새 내용을 확인하고 다시 눌러 주세요.",
  video_estimate_changed:
    "그사이 모델 가격이 올라 예상 최대 비용을 새로 고쳤어요. 확인하고 다시 승인해 주세요(아직 보내지 않았어요).",
  video_card_refreshed:
    "그사이 모델의 소리 기본값이 바뀌어 카드를 새로 고쳤어요. 확인하고 다시 승인해 주세요(아직 보내지 않았어요).",
  video_job_expired: "이 카드는 만료됐어요. 다시 요청해 주세요.",
  video_probe_unavailable:
    "이 서버에 ffprobe가 없어 받은 영상을 확인할 수 없어서 보내지 않았어요. 관리자에게 ffmpeg(ffprobe 포함) 설치를 부탁하세요.",
  video_engine_unavailable: "이 서버는 지금 영상 작업을 돌릴 수 없어요. 잠시 뒤 다시 해 주세요.",
  video_busy: "진행 중인 영상이 많아요(한 사람 2개, 전체 4개까지). 끝난 뒤 다시 승인해 주세요.",
  video_file_limit:
    "이 대화의 파일이 너무 많아(20개) 영상을 저장할 자리가 없어요. 새 대화에서 요청해 주세요.",
  video_budget: "오늘 남은 미디어 생성 예산이 이 영상의 최대 비용보다 적어요. 내일 다시 해 주세요.",
  video_recovering: "서버가 지난번 미디어 비용 기록을 정리하는 중이에요. 잠시 뒤 다시 승인해 주세요.",
  video_lookup_failed: "OpenRouter에서 모델 정보를 확인하지 못했어요. 잠시 뒤 다시 승인해 주세요.",
};
