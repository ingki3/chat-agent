/**
 * Enter while the composer is busy (#141). The reply's `done` event shows "완료" before the run is read again as
 * ended; until then the composer stays busy, because the server refuses a send while a run is active. An Enter in
 * that short window is queued and sent once the composer is free again (the run confirmed ended). An Enter while the
 * reply is still being written is not queued — it shows a short hint instead (stop first, or wait).
 *
 * The queued text is the composer's text as it was at Enter: editing it, pressing stop or "취소" drops the queue
 * (back to `IDLE`).
 */
export type Deferred = {
  /** An Enter is waiting for the run to be confirmed ended. */
  queued: boolean;
  /** An Enter came while the reply was still being written: "답변이 끝난 뒤에 보낼 수 있어요". */
  hint: boolean;
};

export const IDLE: Deferred = { queued: false, hint: false };

export type EnterContext = {
  text: string;
  sending: boolean;
  uploading: boolean;
  busy: boolean;
  /** The reply has its `done`; only the confirmation that the run ended is missing. */
  finishing: boolean;
};

export type Step = { next: Deferred; send: boolean };

/** Enter (or "보내기"): send now, queue, hint, or nothing to send. */
export function enter(s: Deferred, c: EnterContext): Step {
  if (!c.text.trim() || c.sending || c.uploading) return { next: s, send: false };
  if (!c.busy) return { next: IDLE, send: true };
  if (c.finishing) return { next: { queued: true, hint: false }, send: false };
  return { next: { queued: false, hint: true }, send: false };
}

/** The composer is free again (not busy, not sending, no upload): a queued Enter is sent now; a hint goes away. */
export function free(s: Deferred): Step {
  return { next: IDLE, send: s.queued };
}
