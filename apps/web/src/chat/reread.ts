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
