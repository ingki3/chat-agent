import { COMPOSE_ENDED, type ComposeJob, type ComposeJobStatus, type PublicPart } from "@agentlee/shared";

/**
 * The composition card's pure parts (#238 stage 4-1): where a `compose_video` job is in a reply (linked by the call's
 * id to its successful result — review R10: the same card after a reload), which of two job states is newer, and how a
 * status reads in Korean.
 */

/** A `compose_video` call's tool name as each runtime reports it (bare, or `mcp__agentlee__…`). */
export const isComposeTool = (name: string) => name === "compose_video" || name.endsWith("__compose_video");

/** The jobs a reply's `compose_video` calls queued (a refused call has none), in order, each once. */
export function composeJobIds(parts: readonly PublicPart[]): string[] {
  const calls = new Set(
    parts.flatMap((p) => (p.type === "tool_call" && isComposeTool(p.name) ? [p.id] : [])),
  );
  const out: string[] = [];
  for (const p of parts) {
    if (p.type !== "tool_result" || !calls.has(p.callId) || p.isError) continue;
    const id = (p.output as { jobId?: unknown } | null)?.jobId;
    if (typeof id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The newer of two states of a job: the higher `version` (every change the card shows counts). */
export const newestComposeJob = (old: ComposeJob | undefined, next: ComposeJob): ComposeJob =>
  !old || next.version >= old.version ? next : old;

export const COMPOSE_STATUS_TEXT: Record<ComposeJobStatus, string> = {
  preparing: "입력 파일을 준비하는 중이에요",
  queued: "차례를 기다리는 중이에요",
  running: "합성하는 중이에요",
  done: "완성됐어요",
  failed: "합성하지 못했어요",
};

/** "1분 20초" / "12.5초". */
export function secondsText(sec: number): string {
  if (sec < 60) return `${Math.round(sec * 10) / 10}초`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return s ? `${m}분 ${s}초` : `${m}분`;
}

/**
 * How often the card reads its job again: never once it has ended; a job not ended without a live stream (no
 * `EventSource`, or the stream failed) every 3 s — else not at all (the stream brings every change).
 */
export function composePollMs(
  status: ComposeJobStatus | undefined,
  streamFailed: boolean,
  hasEventSource: boolean,
): number | false {
  if (!status || COMPOSE_ENDED.has(status)) return false;
  return streamFailed || !hasEventSource ? 3000 : false;
}

/**
 * The card's length line (review r5): the length once known; while the job may still work it out, "계산 중"; ended
 * without one (failed before its lengths were decoded), "확인할 수 없음" — never "계산 중" for good.
 */
export function durationText(job: Pick<ComposeJob, "durationSec" | "status">): string {
  if (job.durationSec > 0) return secondsText(job.durationSec);
  return COMPOSE_ENDED.has(job.status) ? "확인할 수 없음" : "계산 중";
}
