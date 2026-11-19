import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * "이전 메시지 보기" and the list being read (#103 review): an older page fetched while the messages are read (a read after
 * a reply's end, a background refetch, a schedule result's read) would cut that read short. A click then waits and
 * goes once the list is idle; it counts as done only when its page has arrived — a page fetch that another read
 * cancelled is asked for again.
 */

/** Whether the list is busy: any fetch, **paused too** (offline: `isFetching` counts 0, the read still waits). */
export function listBusy(qc: QueryClient, queryKey: QueryKey): boolean {
  const s = qc.getQueryState(queryKey);
  return !!s && s.fetchStatus !== "idle";
}

/**
 * A waiting click: the conversation, how many pages the list had when it was made, and — once its page was asked for —
 * the query's error count at that moment (`errorUpdateCount`): only an error after it is its own.
 */
export type OlderAsk = { conversationId: string; pages: number; errorsAtStart?: number };

/**
 * What to do with a waiting click now: `done` (its page arrived, there is none, or its own request failed),
 * `wait` (the list is busy), or `fetch` (ask for the page now).
 */
export function olderStep(
  ask: OlderAsk | null,
  now: { conversationId: string; pages: number; hasNextPage: boolean; errors: number; busy: boolean },
): "none" | "done" | "wait" | "fetch" {
  if (!ask || ask.conversationId !== now.conversationId) return "none";
  if (now.pages > ask.pages || !now.hasNextPage) return "done";
  if (now.busy) return "wait";
  // Its own request failed (an error since it started, and nothing on its way): nothing more is asked. An error left
  // over from before (a failed background read) is not its answer; a request cancelled without an error is asked again.
  if (ask.errorsAtStart !== undefined && now.errors > ask.errorsAtStart) return "done";
  return "fetch";
}
