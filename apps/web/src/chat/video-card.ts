import type { PublicPart, VideoJob, VideoJobStatus } from "@agentlee/shared";

/**
 * The video card's pure parts (#238 stage 3): where a `video_generate` card is in a reply, which of two job states is
 * newer, and how a status and an amount read in Korean.
 */

/** A `video_generate` call's tool name as each runtime reports it (bare, or `mcp__agentlee__…`). */
export const isVideoTool = (name: string) => name === "video_generate" || name.endsWith("__video_generate");

/** The cards of a reply: the jobs its `video_generate` calls made (a refused call has none), in order, each once. */
export function videoJobIds(parts: readonly PublicPart[]): string[] {
  const calls = new Set(parts.flatMap((p) => (p.type === "tool_call" && isVideoTool(p.name) ? [p.id] : [])));
  const out: string[] = [];
  for (const p of parts) {
    if (p.type !== "tool_result" || !calls.has(p.callId) || p.isError) continue;
    const id = (p.output as { jobId?: unknown } | null)?.jobId;
    if (typeof id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * The newer of two states of a job: the higher `version` (every saved change counts); of the same version, from two
 * server processes, the one arriving now.
 */
export const newestJob = (old: VideoJob | undefined, next: VideoJob): VideoJob => {
  if (!old) return next;
  if (old.version !== next.version) return old.version > next.version ? old : next;
  return next;
};

export const VIDEO_STATUS_TEXT: Record<VideoJobStatus, string> = {
  awaiting_approval: "승인을 기다려요",
  submitting: "보내는 중이에요",
  pending: "차례를 기다리는 중이에요",
  in_progress: "만드는 중이에요",
  downloading: "완성된 영상을 받는 중이에요",
  done: "완성됐어요",
  failed: "만들지 못했어요",
  expired: "만료됐어요",
  dismissed: "닫았어요",
};

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
/** "$0.4800" — always rounded up to the cent's hundredth shown (never less than what is held). */
export const usdText = (n: number) => usd.format(Math.ceil(n * 10_000) / 10_000);

/** "켜짐" / "꺼짐" / "모델 기본값(확인 안 됨)". */
export const audioText = (a: boolean | null) =>
  a === true ? "켜짐 (모델 기본값)" : a === false ? "꺼짐 (모델 기본값)" : "모델 기본값 (확인 안 됨)";

/** Whether this browser can play an MP4 in a `<video>` (an old one gets the download only). */
export function canPlayMp4(): boolean {
  try {
    if (typeof document === "undefined") return false;
    return document.createElement("video").canPlayType("video/mp4") !== "";
  } catch {
    return false;
  }
}
