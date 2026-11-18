import type { QueryClient } from "@tanstack/react-query";
import type { Run } from "@agentlee/shared";
import { rereadQuery } from "./reread.js";

/**
 * One check, while a reply is finishing, of whether its run ended (#141): the read after `done` may have failed (its
 * retry too, or a retry left waiting), and busy must not be cleared on a guess.
 *
 * The answer is applied only while it is still about `runId`: not after `signal` aborted (the reply stopped finishing,
 * the conversation was left), and never over another run — the cache must still hold `runId` after every await. A
 * late answer (`null` from before the next send) therefore never wipes a run started since. Returns whether it was
 * applied.
 */
export async function confirmRunEnded(o: {
  qc: QueryClient;
  conversationId: string;
  runId: string;
  signal: AbortSignal;
  read: (conversationId: string, signal: AbortSignal) => Promise<Run | null>;
  /** What else to read again once applied (conversation, list, artifacts). */
  around: () => unknown;
}): Promise<boolean> {
  const key = ["active-run", o.conversationId];
  const current = () => !o.signal.aborted && o.qc.getQueryData<Run | null>(key)?.id === o.runId;
  const r = await o.read(o.conversationId, o.signal);
  if (!current()) return false;
  // Messages first, as in a refresh: the saved reply is there before the live one is let go (read from now on, #103).
  await rereadQuery(o.qc, ["messages", o.conversationId]);
  if (!current()) return false;
  await o.qc.cancelQueries({ queryKey: key });
  if (!current()) return false;
  o.qc.setQueryData(key, r);
  void o.around();
  return true;
}
