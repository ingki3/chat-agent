import { z } from "zod";

/**
 * Speaker-labelled transcription of an uploaded audio or video file (#173, `audio_transcribe`): the limits and
 * outcome codes shared by the tool definition (`@agentlee/mcp-tools/audio`), the server and the logs. How it runs —
 * ffmpeg and a pinned MLX Whisper + Nemotron diarizer, each in its own sandbox, no network — is the server's
 * business (apps/server/src/audio).
 */

/** The skill whose per-user permission and server switch turn `audio_transcribe` on (FR-1.6). Not a finance skill. */
export const AUDIO_SKILL = "audio-transcription";

/** The conversation file kinds the tool takes (uploads, `FILE_KINDS`). */
export const AUDIO_FILE_KINDS = ["m4a", "mp3", "wav", "mp4"] as const;

export const AUDIO_LIMITS = {
  /** Longest recording transcribed (seconds of audio; a longer one is refused after the conversion). */
  maxSeconds: 2 * 60 * 60,
  /** ffmpeg's conversion to 16 kHz mono WAV: wall clock and resident memory. */
  convertTimeoutMs: 5 * 60_000,
  convertMemoryBytes: 1024 * 1024 * 1024,
  /** One local model step (load + diarization, or load + Whisper): wall clock and resident memory. */
  transcribeTimeoutMs: 25 * 60_000,
  transcribeMemoryBytes: 8 * 1024 * 1024 * 1024,
  /**
   * The whole call, fallback included (the runtimes' MCP tool timeout is set above it — Codex `tool_timeout_sec`).
   */
  callTimeoutMs: 60 * 60_000,
  /** Speakers the diarizer can tell apart (Nemotron-3-Diarization). */
  maxSpeakers: 8,
  /** Diarization activity threshold: allowed range and default (tuned on Korean panel recordings). */
  threshold: { min: 0.3, max: 0.98, default: 0.85 },
  /** Diarization segments shorter than this are dropped; gaps shorter than `mergeGapSeconds` are merged. */
  minDurationSeconds: 0.3,
  mergeGapSeconds: 0.5,
  /** Segments handed back to the model (the start); the whole transcript is also stored as a file. */
  segments: 400,
  /** Characters of one segment's text. */
  segmentChars: 2_000,
  /** The stored markdown transcript. */
  transcriptBytes: 5 * 1024 * 1024,
  /** OpenRouter fallback: one upload stays under the provider's 25 MB multipart limit (64 kbps mono MP3 chunks). */
  fallbackChunkSeconds: 600,
  fallbackChunkBytes: 24 * 1024 * 1024,
  fallbackRequestTimeoutMs: 180_000,
} as const;

/** Why a call did not run or did not finish (`{ error }` to the model, `audioCode` in the log). */
export const AUDIO_CODES = [
  "audio_not_allowed",
  "audio_bad_input",
  "audio_file_not_found",
  /** Not one of `AUDIO_FILE_KINDS`. */
  "audio_unsupported_kind",
  /** ffmpeg could not read an audio track from it. */
  "audio_decode_failed",
  "audio_too_long",
  "audio_empty",
  "audio_busy",
  "audio_timeout",
  "audio_memory_limit",
  /** The local transcription failed and the external fallback is off (or has no key). */
  "audio_failed",
  /** The local transcription failed, and so did the OpenRouter fallback. */
  "audio_fallback_failed",
  "audio_unavailable",
  "audio_not_installed",
] as const;
export type AudioCode = (typeof AUDIO_CODES)[number];

/** Where the words came from: this Mac, or OpenRouter (`openai/whisper-large-v3`) after the local model failed. */
export const AUDIO_STT_ENGINES = ["local", "openrouter"] as const;
export type AudioSttEngine = (typeof AUDIO_STT_ENGINES)[number];

/** The OpenRouter model of the fallback (fixed — not chosen by the model). */
export const AUDIO_FALLBACK_MODEL = "openai/whisper-large-v3";

/** `GET`/`PUT /api/admin/audio` (#173): the OpenRouter fallback switch (off by default) and whether a key is set. */
export const AudioAdmin = z.object({
  /** The admin turned the fallback on. It is used only when `keyConfigured` too. */
  fallback: z.boolean(),
  /** `OPENROUTER_API_KEY` is set in `.env` (the value never leaves the server). */
  keyConfigured: z.boolean(),
});
export type AudioAdmin = z.infer<typeof AudioAdmin>;
export const SetAudioAdminRequest = z.object({ fallback: z.boolean() }).strict();

/** What the answer says when the words were transcribed outside this Mac. */
export const AUDIO_EXTERNAL_NOTICE = "외부 전사 사용 (OpenRouter openai/whisper-large-v3)";
