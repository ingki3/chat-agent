import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { FileLocator, FileViewResponse, ViewSegment } from "@agentlee/shared";

/**
 * The viewer's queries (#24, review #123 2차): the **opening window** is a query of its own — it resolves the
 * locator, and its target stays whatever else is loaded or refetched. The windows before and after it are two
 * paging queries that start from it (`before` goes back, each window ending where the one after it starts; `after`
 * goes on). A refetch of any of them recomputes its windows from the same start, so the opening window can never
 * be lost among them.
 */

export type ViewFetch = (opts: {
  loc?: FileLocator | undefined;
  from?: number | undefined;
  to?: number | undefined;
}) => Promise<FileViewResponse>;
type Window = { from: number; to?: number | undefined };

const baseKey = (fileId: string, loc: FileLocator | undefined) =>
  ["file-view", fileId, loc ? JSON.stringify(loc) : null] as const;

export function openingQuery(fileId: string, loc: FileLocator | undefined, fetch: ViewFetch) {
  return queryOptions({
    queryKey: [...baseKey(fileId, loc), "opening"],
    queryFn: () => fetch({ loc }),
    retry: false,
    // Still being read: look again until the text is there.
    refetchInterval: (q) => (q.state.data?.extract.status === "pending" ? 3000 : false),
  });
}

/** The window just before `w` (ending where it starts), or undefined at the start of the file. */
const before = (w: FileViewResponse): Window | undefined =>
  w.prev === null ? undefined : { from: w.prev, to: w.items[0]?.seq };
const after = (w: FileViewResponse): Window | undefined => (w.next === null ? undefined : { from: w.next });

export function pagingQuery(
  direction: "before" | "after",
  fileId: string,
  loc: FileLocator | undefined,
  opening: FileViewResponse | undefined,
  fetch: ViewFetch,
  enabled: boolean,
) {
  const step = direction === "before" ? before : after;
  const start = opening ? step(opening) : undefined;
  return infiniteQueryOptions({
    queryKey: [...baseKey(fileId, loc), direction, start?.from ?? null, start?.to ?? null],
    queryFn: ({ pageParam }) => fetch(pageParam),
    initialPageParam: start ?? { from: 0 },
    getNextPageParam: (last: FileViewResponse) => step(last),
    enabled: enabled && start !== undefined,
    retry: false,
  });
}

/** Whether there is more text that way: not asked yet and there is some, or the paging query has more. */
export const hasMore = (
  direction: "before" | "after",
  opening: FileViewResponse,
  asked: boolean,
  paging: { hasNextPage: boolean },
) => (asked ? paging.hasNextPage : (direction === "before" ? opening.prev : opening.next) !== null);

/** Every segment loaded, once, in file order. */
export function combine(windows: readonly (FileViewResponse | undefined)[]): ViewSegment[] {
  const bySeq = new Map<number, ViewSegment>();
  for (const w of windows) for (const x of w?.items ?? []) if (!bySeq.has(x.seq)) bySeq.set(x.seq, x);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
