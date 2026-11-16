/**
 * Enter while the composer cannot send yet (#141). The reply's `done` event shows "완료" before the run is read again
 * as ended; until then the composer stays busy, because the server refuses a send while a run is active. An Enter in
 * that short window is queued — the text and the files as they were at Enter — and sent once the composer is free
 * again (the run confirmed ended). An Enter while the reply is still being written, or while a file is still
 * uploading, is not queued: it shows a short hint instead.
 *
 * Editing the text, adding or removing a file, pressing stop or "취소" drops the queue (back to `IDLE`); a queue whose
 * snapshot no longer matches the composer when it is free is dropped, never sent with other content.
 */
export type Queued = { text: string; fileIds: readonly string[] };

export type Hint = "busy" | "uploading";

export type Deferred = {
  /** An Enter waiting for the run to be confirmed ended: exactly what is sent then. */
  queued: Queued | null;
  /** Why an Enter did nothing: "답변이 끝난 뒤에…" / "파일을 다 올린 뒤에…". */
  hint: Hint | null;
};

export const IDLE: Deferred = { queued: null, hint: null };

export type EnterContext = {
  text: string;
  /** The uploaded files that would go with it now. */
  fileIds: readonly string[];
  sending: boolean;
  uploading: boolean;
  busy: boolean;
  /** The reply has its `done`; only the confirmation that the run ended is missing. */
  finishing: boolean;
};

/** `send`: what to send now (null: nothing). */
export type Step = { next: Deferred; send: Queued | null };

/** Enter (or "보내기"): send now, queue, hint, or nothing to send. */
export function enter(s: Deferred, c: EnterContext): Step {
  if (!c.text.trim() || c.sending) return { next: s, send: null };
  if (c.uploading) return { next: { queued: null, hint: "uploading" }, send: null };
  const now: Queued = { text: c.text, fileIds: [...c.fileIds] };
  if (!c.busy) return { next: IDLE, send: now };
  if (c.finishing) return { next: { queued: now, hint: null }, send: null };
  return { next: { queued: null, hint: "busy" }, send: null };
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The composer is free again (not busy, not sending, no upload): a queued Enter is sent now — only if the composer
 * still holds what was queued; a hint goes away.
 */
export function free(s: Deferred, current: Queued): Step {
  const q = s.queued;
  const same = !!q && q.text === current.text && sameIds(q.fileIds, current.fileIds);
  return { next: IDLE, send: same ? q : null };
}
