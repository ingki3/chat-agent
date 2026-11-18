/**
 * The audio of a YouTube video as a conversation file (#191, `youtube_audio_fetch`): the limits, hosts and outcome
 * codes shared by the tool definition (`@agentlee/mcp-tools/youtube`), the server and the logs. How it runs — a
 * pinned yt-dlp (+ its pinned JS runtime, deno) in its own sandbox whose only way out is an egress proxy for the
 * YouTube hosts below, then the pinned ffmpeg of `audio_transcribe` (#173) with no network — is the server's
 * business (apps/server/src/youtube).
 */

/**
 * The skill whose per-user permission and server switch turn `youtube_audio_fetch` on (FR-1.6). Not a finance
 * skill, but hidden from youth accounts unless named explicitly (the user's decision, 2026-11-18).
 */
export const YOUTUBE_SKILL = "youtube-audio-download";

/**
 * The hosts the download may reach through its egress proxy (HTTPS 443 only). `*.` entries match any subdomain of
 * the rest (not the bare name): YouTube serves the media from `rrN---sn-….googlevideo.com`. Nothing else — no
 * other site yt-dlp supports, no GitHub or npm (the JS challenge solver is installed with yt-dlp), no thumbnails.
 */
export const YOUTUBE_EGRESS_HOSTS = [
  "www.youtube.com",
  "m.youtube.com",
  "youtube.com",
  "youtu.be",
  "*.googlevideo.com",
] as const;

export const YOUTUBE_LIMITS = {
  /** Longest audio saved (seconds) — the same as `audio_transcribe` (`AUDIO_LIMITS.maxSeconds`). */
  maxSeconds: 2 * 60 * 60,
  /** The downloaded audio track (bytes): refused beforehand when the metadata says more, stopped above it. */
  maxBytes: 300 * 1024 * 1024,
  /** The metadata step (yt-dlp extraction + the JS challenge): wall clock and resident memory of its group. */
  probeTimeoutMs: 2 * 60_000,
  /** The download step. */
  downloadTimeoutMs: 20 * 60_000,
  /** yt-dlp + deno together. */
  ytdlpMemoryBytes: 2 * 1024 * 1024 * 1024,
  /** ffmpeg's remux / cut / AAC encode to M4A. */
  convertTimeoutMs: 5 * 60_000,
  convertMemoryBytes: 1024 * 1024 * 1024,
  /** The whole call (the runtimes' MCP tool timeout is set above it — Codex `tool_timeout_sec`). */
  callTimeoutMs: 30 * 60_000,
  /** What one call's working folder may hold (the download, the M4A, yt-dlp's info JSON, deno's cache). */
  workBytes: 700 * 1024 * 1024,
  workEntries: 10_000,
  /** Free space the data volume must have before a call starts. */
  minFreeBytes: 1024 * 1024 * 1024,
  /** Calls one answer (run) may make. */
  callsPerRun: 3,
  /** Characters of the video's description handed back (inside `<external_content>`). */
  descriptionChars: 2_000,
  titleChars: 300,
  /** Characters of the URL the tool takes. */
  urlChars: 500,
} as const;

/** Why a call did not run or did not finish (`{ error, hint }` to the model, `youtubeCode` in the log). */
export const YOUTUBE_CODES = [
  "youtube_not_allowed",
  "youtube_bad_input",
  /** Not a YouTube video address (another site, a channel, a search). */
  "youtube_bad_url",
  "youtube_playlist",
  /** A live stream, or one that has not started (a premiere included). */
  "youtube_live",
  /** Over `maxSeconds` (without a section), or a section over it. */
  "youtube_too_long",
  "youtube_bad_section",
  /** The audio is larger than `maxBytes`. */
  "youtube_too_large",
  /** YouTube asked to confirm "not a bot" (or limited the requests). */
  "youtube_bot_check",
  /** Age-restricted, private, members-only or otherwise needs a login — never done (no cookies). */
  "youtube_login_required",
  /** Removed, blocked, unavailable here. */
  "youtube_unavailable",
  /** No audio-only track that can be downloaded directly. */
  "youtube_no_audio",
  "youtube_quota",
  "youtube_busy",
  /** The run ended (stopped, interrupted, its token revoked) or the user lost the permission meanwhile. */
  "youtube_cancelled",
  "youtube_disk_limit",
  "youtube_file_limit",
  "youtube_timeout",
  "youtube_memory_limit",
  "youtube_convert_failed",
  "youtube_failed",
  /**
   * The address about to go out carries a known secret (the egress guard, #113/#129): nothing runs. Logged as is;
   * the model is told `youtube_failed` (no oracle for which value is a secret).
   */
  "youtube_secret_blocked",
  /** No sandbox here (not macOS), a spawn failure, the egress proxy could not start. */
  "youtube_server_unavailable",
  "youtube_not_installed",
] as const;
export type YoutubeCode = (typeof YOUTUBE_CODES)[number];

/** What the model tells the user for each refusal (Korean, fixed text). */
export const YOUTUBE_HINTS: Partial<Record<YoutubeCode, string>> = {
  youtube_bad_url:
    "YouTube 영상 주소(youtube.com/watch?v=…, youtu.be/…, /shorts/…)만 받을 수 있어요. 다른 사이트·채널·검색 주소는 안 돼요.",
  youtube_playlist: "재생목록은 받을 수 없어요. 영상 하나의 주소를 주세요.",
  youtube_live:
    "라이브 방송이나 아직 시작하지 않은 영상은 받을 수 없어요. 방송이 끝나고 다시보기가 올라온 뒤에 해 주세요.",
  youtube_too_long:
    "2시간이 넘는 영상은 한 번에 받을 수 없어요. start·end로 2시간 이하 구간을 지정해 주세요(예: start 0:00:00, end 1:30:00).",
  youtube_bad_section: "구간이 맞지 않아요. start는 end보다 앞이고, 둘 다 영상 길이 안이어야 해요.",
  youtube_too_large: "음성이 너무 커서(300MB 넘음) 받을 수 없어요.",
  youtube_bot_check:
    "YouTube가 로봇 확인을 요구해서 받지 못했어요. 잠시 뒤에 다시 해 보거나, 음성 파일을 직접 올려 주세요.",
  youtube_login_required:
    "로그인이 필요한 영상(연령 제한·비공개·회원 전용)이라 받을 수 없어요. 서버는 로그인·쿠키를 쓰지 않아요.",
  youtube_unavailable: "영상을 찾을 수 없거나(삭제·비공개·지역 제한) 지금 받을 수 없어요.",
  youtube_no_audio: "이 영상에서 받을 수 있는 음성 트랙을 찾지 못했어요.",
  youtube_quota: "한 답변에서 영상 음성 받기는 3번까지예요.",
  youtube_busy: "지금 다른 영상 음성을 받는 중이에요. 끝난 뒤에 다시 해 주세요.",
  youtube_file_limit: "이 대화의 파일이 너무 많아 저장하지 못했어요. 새 대화에서 해 주세요.",
  youtube_timeout: "시간 안에 받지 못했어요. 더 짧은 구간으로 다시 해 보세요.",
  youtube_not_installed: "서버에 유튜브 음성 받기가 설치되어 있지 않아요(관리자: pnpm youtube:install).",
};

/** The M4A the tool saves: a format `audio_transcribe` takes (`AUDIO_FILE_KINDS`). */
export const YOUTUBE_FILE_KIND = "m4a" as const;
