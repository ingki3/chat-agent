import { z } from "zod";

/**
 * 멀티미디어 합성 (#238 stage 4-1, docs/decisions/media-generation.md §15): `compose_video` puts the conversation's
 * own images, videos and audio together into one MP4 on this server — clips with cuts or transitions, narration,
 * background music with ducking, and a subtitle track that can be switched on and off. No external service and no
 * cost: no confirmation card; the call queues a job at once and its card shows the progress and then the video.
 * The server builds every ffmpeg filter graph itself from this timeline — the model never passes an argument.
 */

export const COMPOSE_LIMITS = {
  /** The whole result, transitions overlapped and a held last frame included (user decision 2). */
  maxSeconds: 300,
  maxClips: 40,
  maxNarration: 40,
  maxSubtitles: 400,
  subtitleChars: 200,
  fps: 30,
  sampleRate: 48_000,
  /** One composition, from its start to the stored file (user decision 2). */
  timeoutMs: 30 * 60_000,
  /** The tool call's own preparation (the inputs copied and probed before the job is queued). */
  prepareTimeoutMs: 120_000,
  /** The result's safety cap (user decision 2: a result may be over the 50MB file limit). */
  maxBytes: 1024 * 1024 * 1024,
  /** All input copies of one job together. */
  maxInputBytes: 2 * 1024 * 1024 * 1024,
  /** Jobs at once (user decision 3): one running in all, at most 3 waiting, one per user (waiting or running). */
  slots: { running: 1, waiting: 3, perUser: 1 },
  /** Calls one run may make (the admin's per-run limit; default). */
  perRunDefault: 1,
  /** The longest side of an input image or video this server takes. */
  maxInputSide: 8192,
} as const;

export const COMPOSE_RESOLUTIONS = ["720p", "1080p"] as const;
export const COMPOSE_ASPECTS = ["16:9", "9:16", "1:1"] as const;
export const COMPOSE_TRANSITIONS = [
  "fade",
  "dissolve",
  "wipeleft",
  "wiperight",
  "slideleft",
  "slideright",
] as const;
export const COMPOSE_KEN_BURNS = ["in", "out", "left", "right"] as const;

const FileId = z.string().trim().min(1).max(64);
const Sec = z.number().finite().min(0).max(COMPOSE_LIMITS.maxSeconds);

export const ComposeClip = z
  .object({
    fileId: FileId.describe(
      "An image (png/jpg/webp) or video (mp4/mov) of this conversation (fileId from file_list).",
    ),
    durationSec: z
      .number()
      .finite()
      .min(0.5)
      .max(COMPOSE_LIMITS.maxSeconds)
      .optional()
      .describe(
        "Seconds on screen: required for an image (0.5–30); for a video, default the trim or its whole length.",
      ),
    trim: z
      .object({ startSec: Sec, endSec: Sec })
      .strict()
      .optional()
      .describe("Video only: the part of the source to use."),
    fit: z
      .enum(["letterbox", "crop"])
      .optional()
      .describe("letterbox (default: the whole picture, black bars) or crop (fill the frame)."),
    kenBurns: z
      .enum(COMPOSE_KEN_BURNS)
      .optional()
      .describe("Image only: a slow zoom in/out or pan left/right."),
    volume: z
      .number()
      .finite()
      .min(0)
      .max(2)
      .optional()
      .describe("Video only: its own sound's volume (default 1)."),
    transition: z
      .object({
        type: z.enum(COMPOSE_TRANSITIONS),
        durationSec: z.number().finite().min(0.2).max(2),
      })
      .strict()
      .optional()
      .describe("Into the NEXT clip (never on the last clip); without it, a cut."),
  })
  .strict();
export type ComposeClip = z.infer<typeof ComposeClip>;

export const ComposeTimeline = z
  .object({
    output: z
      .object({
        resolution: z.enum(COMPOSE_RESOLUTIONS).optional(),
        aspectRatio: z.enum(COMPOSE_ASPECTS).optional(),
      })
      .strict()
      .optional()
      .describe("Default 720p, 16:9 (30 fps, H.264/AAC MP4)."),
    clips: z.array(ComposeClip).min(1).max(COMPOSE_LIMITS.maxClips),
    narration: z
      .array(
        z
          .object({
            fileId: FileId.describe("An audio file (mp3/m4a/wav) — or a video whose sound is used."),
            startSec: Sec,
          })
          .strict(),
      )
      .max(COMPOSE_LIMITS.maxNarration)
      .optional(),
    music: z
      .object({
        fileId: FileId,
        volume: z.number().finite().min(0).max(1).optional().describe("Default 0.3."),
        loop: z.boolean().optional().describe("Repeat to the end (default true)."),
        fadeInSec: z.number().finite().min(0).max(10).optional(),
        fadeOutSec: z.number().finite().min(0).max(10).optional(),
        duck: z.boolean().optional().describe("Lower it under narration (default true)."),
      })
      .strict()
      .optional(),
    subtitles: z
      .array(
        z
          .object({
            startSec: Sec,
            endSec: Sec,
            text: z.string().trim().min(1).max(COMPOSE_LIMITS.subtitleChars),
          })
          .strict(),
      )
      .max(COMPOSE_LIMITS.maxSubtitles)
      .optional()
      .describe("In order, not overlapping; a track the viewer can switch on and off (not burned in)."),
  })
  .strict();
export type ComposeTimeline = z.infer<typeof ComposeTimeline>;

export const COMPOSE_JOB_STATUSES = ["preparing", "queued", "running", "done", "failed"] as const;
export const ComposeJobStatus = z.enum(COMPOSE_JOB_STATUSES);
export type ComposeJobStatus = z.infer<typeof ComposeJobStatus>;
/** Not ended: holds a job slot and one of the conversation's file places. */
export const COMPOSE_ACTIVE: ReadonlySet<ComposeJobStatus> = new Set(["preparing", "queued", "running"]);
export const COMPOSE_ENDED: ReadonlySet<ComposeJobStatus> = new Set(["done", "failed"]);

/** Why a job ended without its video (fixed codes: stored, logged and shown as fixed words). */
export const COMPOSE_JOB_CODES = [
  /** The server stopped or restarted while the job waited or ran (user decision 3: never run again by itself). */
  "compose_interrupted",
  /** Not finished within 30 minutes. */
  "compose_timeout",
  /** ffmpeg could not make it (a sandbox or memory limit, an input it could not decode). */
  "compose_failed",
  /** The result was not the MP4 expected (length, streams, subtitle track). */
  "compose_verify_failed",
  /** Over the 1GB safety cap. */
  "compose_too_large",
  /** It could not be stored (the conversation's files, the disk). */
  "compose_store_failed",
] as const;
export const ComposeJobCode = z.enum(COMPOSE_JOB_CODES);
export type ComposeJobCode = z.infer<typeof ComposeJobCode>;

/** `GET /api/compose-jobs/:id` — the card. */
export const ComposeJob = z.object({
  id: z.string(),
  conversationId: z.string(),
  messageId: z.string(),
  status: ComposeJobStatus,
  /** 1 = next to run (queued only). */
  queuePosition: z.number().int().nullable(),
  /** 0–100 while running. */
  progress: z.number().int().min(0).max(100).nullable(),
  /** The result's length (seconds) and frame size, from the timeline. */
  durationSec: z.number(),
  width: z.number().int(),
  height: z.number().int(),
  clips: z.number().int(),
  /** Whether the result has a subtitle track (`/api/compose-jobs/:id/subtitles.vtt` for the player). */
  subtitles: z.boolean(),
  version: z.number().int(),
  createdAt: z.number().int(),
  startedAt: z.number().int().nullable(),
  endedAt: z.number().int().nullable(),
  errorCode: ComposeJobCode.nullable(),
  file: z.object({ fileId: z.string(), name: z.string(), bytes: z.number().int() }).nullable(),
});
export type ComposeJob = z.infer<typeof ComposeJob>;

export const COMPOSE_JOB_CODE_TEXT: Record<ComposeJobCode, string> = {
  compose_interrupted: "서버가 다시 시작돼 합성이 중단됐어요. 다시 요청해 주세요.",
  compose_timeout: "30분 안에 끝나지 않아 멈췄어요. 더 짧게 나눠 요청해 주세요.",
  compose_failed: "영상을 합성하지 못했어요. 입력 파일을 확인하고 다시 요청해 주세요.",
  compose_verify_failed: "합성한 영상이 예상한 모양(길이·스트림)이 아니어서 저장하지 않았어요.",
  compose_too_large: "합성한 영상이 너무 커서(1GB 초과) 저장하지 않았어요.",
  compose_store_failed: "합성한 영상을 이 대화에 저장하지 못했어요.",
};

/** The failure's short reason on a lock screen (fixed words). */
export const COMPOSE_FAILURE_SHORT: Record<ComposeJobCode, string> = {
  compose_interrupted: "서버 재시작으로 중단",
  compose_timeout: "30분 안에 끝나지 않았어요",
  compose_failed: "합성하지 못했어요",
  compose_verify_failed: "결과 확인 실패",
  compose_too_large: "영상이 너무 커요",
  compose_store_failed: "저장하지 못했어요",
};

/** The card's refused reads. */
export const COMPOSE_JOB_ERRORS: Record<string, string> = {
  compose_no_subtitles: "이 영상에는 자막이 없어요.",
};

/** Output frame size of a resolution and aspect ratio (even numbers, the longer side 1280/1920 or the square's). */
export function composeFrame(
  resolution: (typeof COMPOSE_RESOLUTIONS)[number],
  aspect: (typeof COMPOSE_ASPECTS)[number],
): { width: number; height: number } {
  const short = resolution === "1080p" ? 1080 : 720;
  const long = resolution === "1080p" ? 1920 : 1280;
  if (aspect === "1:1") return { width: short, height: short };
  return aspect === "16:9" ? { width: long, height: short } : { width: short, height: long };
}
