import type { Notice } from "./stream.js";

/** What a finished run leaves behind for its message: notices and errors are not stored with the message. */
export type AfterRun = { notices: Notice[]; error?: { code: string; message: string } };

/**
 * Runs that ended while their conversation was not on screen (#172: the artifact page follows the run the chat left
 * when it moved there): what they left behind, per conversation and message, for the chat screen to show when the
 * user comes back. Tab memory only, like the chat screen's own.
 */
const ended = new Map<string, Record<string, AfterRun>>();

export function keepAfter(conversationId: string, messageId: string, after: AfterRun) {
  ended.set(conversationId, { ...ended.get(conversationId), [messageId]: after });
}

export const afterOf = (conversationId: string): Record<string, AfterRun> => ({
  ...ended.get(conversationId),
});
