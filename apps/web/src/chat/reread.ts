import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * Reads a query again with a request sent from now on (#103). `invalidateQueries` alone joins a first read still on
 * its way (TanStack only cancels an in-flight refetch when the query already has data): opened just before a run
 * ended, the chat screen took that read — sent while the reply was still streaming — as the one after the end, let
 * the live reply go and showed "streaming" for good. Whatever is in flight is cancelled first, so the answer
 * describes the server as it is after this call.
 */
export async function rereadQuery(qc: QueryClient, queryKey: QueryKey): Promise<void> {
  await qc.cancelQueries({ queryKey });
  await qc.invalidateQueries({ queryKey });
}

/** The read of a conversation's messages after its run ended, one per conversation + run (per query client). */
const afterEnd = new WeakMap<QueryClient, Map<string, Promise<void>>>();

/**
 * Reads a conversation's messages after its run ended (#103 review): resolves only once a read **started after this
 * call** has succeeded, rejects otherwise (the caller keeps the live reply and tries again later). Every caller for
 * the same conversation and run — the refresh after `done`, the check while finishing — shares the one read in
 * flight: neither cancels the other's, and neither goes on before it has answered.
 */
export function readMessagesAfterEnd(qc: QueryClient, conversationId: string, runId: string): Promise<void> {
  let reads = afterEnd.get(qc);
  if (!reads) afterEnd.set(qc, (reads = new Map()));
  const k = `${conversationId}\n${runId}`;
  const inFlight = reads.get(k);
  if (inFlight) return inFlight;
  const key = ["messages", conversationId];
  const p = (async () => {
    // Not shown anywhere (no such query): nothing to read before the live reply goes.
    if (!qc.getQueryCache().find({ queryKey: key, exact: true })) return;
    const since = Date.now();
    await qc.cancelQueries({ queryKey: key });
    await qc.refetchQueries({ queryKey: key }, { throwOnError: true });
    // Only an answer that arrived after the cancel above counts (the cancelled read's answer is dropped).
    const s = qc.getQueryState(key);
    if (!s || s.status !== "success" || s.dataUpdatedAt < since) throw new Error("messages_not_read");
  })().finally(() => {
    if (reads.get(k) === p) reads.delete(k);
  });
  reads.set(k, p);
  return p;
}
