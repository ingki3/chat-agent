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
const ended = new Map<string, Record<string, { at: number; after: AfterRun }>>();

/** Drops what expired (each message by its own time, review #175 3차), then the oldest conversations past the cap. */
const prune = (now: number) => {
  for (const [id, items] of ended) {
    for (const [m, e] of Object.entries(items)) if (now - e.at > AFTER_RUN_LIMITS.ttlMs) delete items[m];
    if (!Object.keys(items).length) ended.delete(id);
  }
  while (ended.size > AFTER_RUN_LIMITS.conversations) ended.delete(ended.keys().next().value!);
};

export function keepAfter(conversationId: string, messageId: string, after: AfterRun, now = Date.now()) {
  prune(now); // expired notices never come back with a newer one
  const items = { ...ended.get(conversationId), [messageId]: { at: now, after } };
  ended.delete(conversationId); // newest last: the cap drops the oldest
  ended.set(conversationId, items);
  prune(now);
}

/** What the conversation's ended runs left, removed from the store (the chat screen keeps it from here on). */
export function takeAfter(conversationId: string, now = Date.now()): Record<string, AfterRun> {
  prune(now);
  const items = ended.get(conversationId) ?? {};
  ended.delete(conversationId);
  return Object.fromEntries(Object.entries(items).map(([m, e]) => [m, e.after]));
}

/** Another account (or none): nothing of the previous one stays. */
export const clearAfter = () => ended.clear();

/** Tests: how many conversations are kept. */
export const afterSize = () => ended.size;
