import type { Notice } from "./stream.js";

/** What a finished run leaves behind for its message: notices and errors are not stored with the message. */
export type AfterRun = { notices: Notice[]; error?: { code: string; message: string } };

/** Conversations kept at most (the oldest goes first), and how long an entry is kept. */
export const AFTER_RUN_LIMITS = { conversations: 20, ttlMs: 60 * 60 * 1000 };

/**
 * Runs that ended while their conversation was not on screen (#172: the artifact page follows the run the chat left
 * when it moved there): what they left behind, per conversation and message, until the chat screen takes it when
 * the user comes back. Tab memory only, bounded: a few conversations, an hour each; emptied when the account changes
 * or signs out (`clearAfter`), and a deleted conversation's entry goes with it (`takeAfter`).
 */
const ended = new Map<string, { at: number; items: Record<string, AfterRun> }>();

const prune = (now: number) => {
  for (const [id, e] of ended) if (now - e.at > AFTER_RUN_LIMITS.ttlMs) ended.delete(id);
  while (ended.size > AFTER_RUN_LIMITS.conversations) ended.delete(ended.keys().next().value!);
};

export function keepAfter(conversationId: string, messageId: string, after: AfterRun, now = Date.now()) {
  const items = { ...ended.get(conversationId)?.items, [messageId]: after };
  ended.delete(conversationId); // newest last: the cap drops the oldest
  ended.set(conversationId, { at: now, items });
  prune(now);
}

/** What the conversation's ended runs left, removed from the store (the chat screen keeps it from here on). */
export function takeAfter(conversationId: string, now = Date.now()): Record<string, AfterRun> {
  prune(now);
  const e = ended.get(conversationId);
  ended.delete(conversationId);
  return { ...e?.items };
}

/** Another account (or none): nothing of the previous one stays. */
export const clearAfter = () => ended.clear();

/** Tests: how many conversations are kept. */
export const afterSize = () => ended.size;
