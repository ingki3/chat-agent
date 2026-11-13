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
    // File text is not kept once the viewer is gone (review #123 3차): a later visit reads it again — scrubbed with
    // the secrets known then — instead of showing a cached copy first.
    gcTime: 0,
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
    gcTime: 0,
  });
}

type Paging = {
  data?: { pages: readonly FileViewResponse[] } | undefined;
  hasNextPage: boolean;
  isError: boolean;
};

/** The windows of a paging query this viewer may show: only once asked here (review #123 3차: no earlier visit's). */
export const shownPages = (asked: boolean, paging: Paging): readonly FileViewResponse[] =>
  asked ? (paging.data?.pages ?? []) : [];

/**
 * Whether there is more text that way. Until the paging query has a window (not asked yet, its first request
 * still running or failed), the opening window says; then the paging query (a failed later window keeps it: the
 * button retries — review #123 3차).
 */
export const hasMore = (
  direction: "before" | "after",
  opening: FileViewResponse,
  asked: boolean,
  paging: Paging,
) =>
  asked && paging.data?.pages.length
    ? paging.hasNextPage || paging.isError
    : (direction === "before" ? opening.prev : opening.next) !== null;

/**
 * What "더 보기" does now: ask (the first time — the query starts), `retry` its first window when that failed, or
 * load the `next` window (again, when that failed).
 */
export const moreAction = (asked: boolean, paging: Paging): "ask" | "retry" | "next" =>
  !asked ? "ask" : paging.data?.pages.length ? "next" : "retry";

/** Every segment loaded, once, in file order. */
export function combine(windows: readonly (FileViewResponse | undefined)[]): ViewSegment[] {
  const bySeq = new Map<number, ViewSegment>();
  for (const w of windows) for (const x of w?.items ?? []) if (!bySeq.has(x.seq)) bySeq.set(x.seq, x);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
