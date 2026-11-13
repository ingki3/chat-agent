import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import type { FileLocator, FileViewResponse, ViewSegment } from "@agentlee/shared";

/**
 * The viewer's queries (#24, review #123 2차): the **opening window** is a query of its own — it resolves the
 * locator, and its target stays whatever else is loaded or refetched. The windows before and after it are two
 * paging queries that start from it (`before` goes back, each window ending where the one after it starts; `after`
 * goes on). A refetch of any of them recomputes its windows from the same start, so the opening window can never
 * be lost among them.
 *
 * Every query is keyed by the **visit** (one mount of the viewer, review #123 4차) and, for paging, by the opening
 * window's extraction: nothing a previous visit asked for — even a request still in flight when it ended — can be
 * read by this one. Requests are aborted when the viewer goes; nothing is kept (`gcTime: 0`) or trusted as fresh
 * (`staleTime: 0`): file text is always read with the secrets known now.
 */

export type ViewFetch = (
  opts: { loc?: FileLocator | undefined; from?: number | undefined; to?: number | undefined },
  signal?: AbortSignal,
) => Promise<FileViewResponse>;
type Window = { from: number; to?: number | undefined };

let visits = 0;
/** A new visit id (one per mount of the viewer). */
export const newVisit = () => ++visits;

const baseKey = (visit: number, fileId: string, loc: FileLocator | undefined) =>
  ["file-view", visit, fileId, loc ? JSON.stringify(loc) : null] as const;

export function openingQuery(visit: number, fileId: string, loc: FileLocator | undefined, fetch: ViewFetch) {
  return queryOptions({
    queryKey: [...baseKey(visit, fileId, loc), "opening"],
    queryFn: ({ signal }) => fetch({ loc }, signal),
    retry: false,
    staleTime: 0,
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
  visit: number,
  fileId: string,
  loc: FileLocator | undefined,
  opening: FileViewResponse | undefined,
  fetch: ViewFetch,
  enabled: boolean,
) {
  const step = direction === "before" ? before : after;
  const start = opening ? step(opening) : undefined;
  return infiniteQueryOptions({
    queryKey: [
      ...baseKey(visit, fileId, loc),
      direction,
      // The opening window it starts from: its bytes, its extraction's state and size, where it starts and ends.
      opening
        ? `${opening.extract.fileRevision}:${opening.extract.status}:${opening.extract.characters}`
        : null,
      start?.from ?? null,
      start?.to ?? null,
    ],
    queryFn: ({ pageParam, signal }) => fetch(pageParam, signal),
    initialPageParam: start ?? { from: 0 },
    getNextPageParam: (last: FileViewResponse) => step(last),
    enabled: enabled && start !== undefined,
    retry: false,
    staleTime: 0,
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
