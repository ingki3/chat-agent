import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { Message, Run } from "@agentlee/shared";

/**
 * How the chat screen settles the end of a reply (#103, #141) — one way for every sign of an end: the stream's `done`,
 * a stream that closed without one, a stop answered with an ended run, an `active-run` answer that the run is over
 * (or none at all while the latest reply still reads as unfinished). Each marks the reply as ending; the screen then
 * calls {@link settleEnd} until it is settled (every 2 s, one at a time).
 *
 * The live reply is let go only once a messages read **started after the end** shows the saved reply final — never
 * on a guess, never on a read sent before the end (it would show "streaming" for good).
 */

/** A reply whose end is being settled; `runId` is the run followed live, if any. */
export type Ending = { conversationId: string; messageId: string; runId: string | null };

/**
 * - `final`: the saved reply is final; the live reply was let go (if it was still this run's).
 * - `running`: a run is in progress after all (this one, or a new one — e.g. sent from another tab): it is followed.
 * - `unfinished`: not settled yet; try again later.
 */
export type SettleResult = "final" | "running" | "unfinished";

/**
 * A request of the settle loop (a messages page, the run's state) that never answers is given up after this; the next
 * try reads again. Only the loop's own reads: the screen's first load and older pages wait as long as it takes.
 */
export const READ_TIMEOUT_MS = 10_000;
/** The settle loop's wait after an unsettled try, doubling up to the cap. */
export const SETTLE_FIRST_RETRY_MS = 2000;
export const SETTLE_MAX_RETRY_MS = 30_000;

/**
 * `signal` with a time limit added — with a plain AbortController (no `AbortSignal.any`/`timeout`, missing on the iOS
 * versions the app supports). `done()` drops the timer and the listener once the request is over.
 */
export function limitedSignal(
  signal: AbortSignal | undefined,
  ms = READ_TIMEOUT_MS,
): { signal: AbortSignal; done: () => void } {
  const ac = new AbortController();
  const stop = () => ac.abort(signal?.reason);
  const timer = setTimeout(() => ac.abort(new Error("read_timeout")), ms);
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });
  return {
    signal: ac.signal,
    done: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", stop);
    },
  };
}

/** Conversations whose messages the settle loop is reading now (per query client). */
const settleReading = new WeakMap<QueryClient, Set<string>>();

/**
 * The signal for one messages page request: during a read of the settle loop, with its time limit
 * ({@link READ_TIMEOUT_MS}, each page its own); otherwise TanStack's own, unchanged (cancelled when the screen goes).
 */
export function pageSignal(
  qc: QueryClient,
  conversationId: string,
  signal: AbortSignal,
  ms = READ_TIMEOUT_MS,
): { signal: AbortSignal; done: () => void } {
  if (!settleReading.get(qc)?.has(conversationId)) return { signal, done: () => {} };
  return limitedSignal(signal, ms);
}

/**
 * The ending to settle after a new sign `e`, with `followed` the run in progress the screen follows (or none):
 * - a sign about a run that is not the one followed (a late stop answer of an earlier run) is ignored;
 * - one about the followed run replaces an older attempt (its own end is what matters now);
 * - signs of the same end are one; a sign without a run never replaces one in progress.
 */
export function nextEnding(cur: Ending | null, e: Ending, followed: string | null): Ending | null {
  if (e.runId !== null && followed !== null && e.runId !== followed) return cur;
  if (!cur || cur.conversationId !== e.conversationId) return e;
  if (cur.runId === e.runId) return cur;
  if (e.runId !== null && e.runId === followed) return e;
  return cur;
}

const UNFINISHED = new Set<Message["status"]>(["pending", "streaming"]);
type Pages = InfiniteData<{ items: Message[]; nextBefore: number | null }>;
const messagesKey = (conversationId: string) => ["messages", conversationId];
const activeKey = (conversationId: string) => ["active-run", conversationId];

/** The read after an end, one per conversation + reply (per query client): every caller shares the one in flight. */
const afterEnd = new WeakMap<QueryClient, Map<string, Promise<void>>>();

/**
 * Reads a conversation's messages after a reply's end: resolves only once a read **started after this call** has
 * succeeded — the query's data was updated by it (`dataUpdateCount` past its value after the cancel; a clock
 * reading in the same millisecond, or a read paused offline, never counts). Rejects on a failed read, or after
 * {@link READ_TIMEOUT_MS} without an answer. Callers for the same reply share the one read in flight: none cancels
 * another's.
 */
export function readMessagesAfterEnd(
  qc: QueryClient,
  conversationId: string,
  messageId: string,
): Promise<void> {
  let reads = afterEnd.get(qc);
  if (!reads) afterEnd.set(qc, (reads = new Map()));
  const k = `${conversationId}\n${messageId}`;
  const inFlight = reads.get(k);
  if (inFlight) return inFlight;
  const key = messagesKey(conversationId);
  const p = (async () => {
    const query = qc.getQueryCache().find({ queryKey: key, exact: true });
    // Not shown anywhere (no such query): nothing to read before the live reply goes.
    if (!query) return;
    await qc.cancelQueries({ queryKey: key, exact: true });
    const before = query.state.dataUpdateCount;
    // Each page request of this read has its own time limit (`pageSignal`): a long conversation's pages, read one after
    // another, are never cut short as a whole. Offline the read is paused and would wait: not read now.
    let marks = settleReading.get(qc);
    if (!marks) settleReading.set(qc, (marks = new Set()));
    marks.add(conversationId);
    try {
      const read = qc.refetchQueries({ queryKey: key, exact: true }, { throwOnError: true });
      if (query.state.fetchStatus === "paused") {
        void read.catch(() => {});
        throw new Error("messages_read_paused");
      }
      await read;
    } finally {
      marks.delete(conversationId);
    }
    if (query.state.dataUpdateCount <= before || query.state.status !== "success")
      throw new Error("messages_not_read");
  })().finally(() => {
    if (reads.get(k) === p) reads.delete(k);
  });
  reads.set(k, p);
  return p;
}

/** Forgets the reads after an end of a conversation (left, or the screen gone): a later try starts its own. */
export function forgetReadsAfterEnd(qc: QueryClient, conversationId: string): void {
  const reads = afterEnd.get(qc);
  if (!reads) return;
  for (const k of [...reads.keys()]) if (k.startsWith(`${conversationId}\n`)) reads.delete(k);
}

/** The reply's status in the messages the screen holds (undefined: not among them). */
function statusOf(qc: QueryClient, conversationId: string, messageId: string): Message["status"] | undefined {
  const pages = qc.getQueryData<Pages>(messagesKey(conversationId))?.pages ?? [];
  for (const p of pages) {
    const m = p.items.find((x) => x.id === messageId);
    if (m) return m.status;
  }
  return undefined;
}

const gone = (e: unknown) => {
  const status = (e as { status?: unknown } | null)?.status;
  return status === 403 || status === 404;
};

/**
 * One try at settling `ending` (see the module comment). Everything is applied only while it is still about the same
 * run — not after `signal` aborted (the conversation left), and never over a run the cache took up since (a send
 * from this screen, a run followed in the meantime).
 */
export async function settleEnd(o: {
  qc: QueryClient;
  ending: Ending;
  signal: AbortSignal;
  readActiveRun: (conversationId: string, signal: AbortSignal) => Promise<Run | null>;
  /** What else to read again once settled (conversation, list, artifacts). */
  around: () => unknown;
}): Promise<SettleResult> {
  const { qc, signal } = o;
  const { conversationId, messageId, runId } = o.ending;
  const key = activeKey(conversationId);
  const cached = () => qc.getQueryData<Run | null>(key) ?? null;
  // The cache still holds what this ending is about: its run, or (no run followed) no run in progress.
  const holds = () => {
    if (signal.aborted) return false;
    const c = cached();
    return runId === null ? !c || c.endedAt !== null : c?.id === runId;
  };
  /** Not ours any more: left (`unfinished`), another run followed (`running`), or this end settled by another try. */
  const notOurs = (): SettleResult => {
    if (signal.aborted) return "unfinished";
    const c = cached();
    return c && c.endedAt === null && c.id !== runId ? "running" : "final";
  };
  /** Applies `r` (the run's state read after the end) in place of what the cache holds for this ending. */
  const apply = async (r: Run | null) => {
    await qc.cancelQueries({ queryKey: key, exact: true });
    if (!holds()) return false;
    if (runId !== null || (r && r.endedAt === null)) qc.setQueryData(key, r);
    return true;
  };
  /** Follows a run in progress other than this ending's: its reply joins the list (sent elsewhere, it may not be in it). */
  const follow = async (r: Run): Promise<SettleResult> => {
    if (!(await apply(r))) return notOurs();
    void qc.invalidateQueries({ queryKey: messagesKey(conversationId), exact: true });
    return "running";
  };
  try {
    await readMessagesAfterEnd(qc, conversationId, messageId);
  } catch (e) {
    if (!gone(e)) throw e;
    // No access any more, or the conversation is gone: nothing to wait for.
    if (await apply(null)) void o.around();
    return "final";
  }
  // Taken over meanwhile (a run followed since: a send here, a run found): that run's own end settles the rest.
  if (!holds()) return notOurs();
  const status = statusOf(qc, conversationId, messageId);
  const final = status === undefined || !UNFINISHED.has(status);
  // The run's state, read after the end too: the composer stays busy until the run is read as ended (the server
  // refuses a send while it is active, #141) — a failed read throws (tried again), the live reply kept.
  // Bounded like a page, and dropped when the conversation is left: a hung answer fails this try (tried again).
  const limited = limitedSignal(signal);
  const r = await o.readActiveRun(conversationId, limited.signal).finally(limited.done);
  if (!holds()) return notOurs();
  if (r && r.endedAt === null) {
    if (r.id === runId) return final ? "unfinished" : "running"; // saved, still finishing / still going
    return follow(r);
  }
  if (!final) return "unfinished";
  if (!(await apply(r))) return notOurs();
  void o.around();
  return "final";
}

/**
 * The settle loop for one ending: `tryOnce` now, then after {@link SETTLE_FIRST_RETRY_MS}, doubling up to
 * {@link SETTLE_MAX_RETRY_MS} while it stays unsettled (a failed try counts as unsettled). One try at a time.
 * `poke()` — a new sign of the same end (a stop answered with the ended run) — tries again at once (a try already on
 * its way finishes first — its reads shared — and, unsettled, is followed at once); `stop()` ends the loop. `settled` gets the result that ended it.
 */
export function startSettleLoop(
  tryOnce: () => Promise<SettleResult>,
  settled: (r: Exclude<SettleResult, "unfinished">) => void,
): { poke: () => void; stop: () => void } {
  let stopped = false;
  let running = false;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wait = SETTLE_FIRST_RETRY_MS;
  const attempt = async () => {
    clearTimeout(timer);
    timer = undefined;
    running = true;
    let r: SettleResult = "unfinished";
    try {
      r = await tryOnce();
    } catch {
      // a failed read: tried again
    }
    running = false;
    if (stopped) return;
    if (r !== "unfinished") return settled(r);
    if (again) {
      again = false;
      return void attempt();
    }
    timer = setTimeout(() => void attempt(), wait);
    wait = Math.min(wait * 2, SETTLE_MAX_RETRY_MS);
  };
  void attempt();
  return {
    poke: () => {
      if (stopped) return;
      wait = SETTLE_FIRST_RETRY_MS;
      // A try on its way may have read before this sign: unless it settles, the next one follows at once.
      if (running) again = true;
      else void attempt();
    },
    stop: () => {
      stopped = true;
      clearTimeout(timer);
    },
  };
}
