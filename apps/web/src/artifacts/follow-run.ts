import { useEffect, useEffectEvent, useRef } from "react";
import type { Run } from "@agentlee/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError, conversations } from "../api.js";
import { useRunStream } from "../chat/stream.js";
import { keepAfter } from "../chat/after-run.js";
import { CONVERSATIONS_KEY } from "../Sidebar.js";
import { MY_ARTIFACTS_KEY, artifactKey } from "./viewer.js";

/**
 * The artifact page follows the conversation's running reply (review #175): the chat moves here as soon as a run
 * names an artifact (#172), and leaving the chat closed its stream — so this page subscribes to that run itself.
 * - each artifact version the run stores (`artifact_ref` parts) refreshes the artifact: a v2 made later in the same
 *   run shows at once (the page follows the newest unless a version was picked);
 * - when the run ends, everything the chat screen would have refreshed is refreshed (its messages, its run state —
 *   so the chat is not left busy —, the conversation, the sidebar list, the artifacts), and its notices and error
 *   are kept for the chat screen to show when the user goes back (`after-run.ts`).
 * - a stream that gave up (`lost`, its retries spent) is not left lost (review #175 2차): `recoverLost` reads the run
 *   again — still running: subscribe again; ended (or another run): refresh as above;
 * - the refresh after the end is tried again, backing off, until it has succeeded; 403/404 (no access any more,
 *   conversation gone) ends it and forgets the run; nothing is tried while the tab is hidden (review #175 3차).
 * Owner only: someone a share shows it to cannot read the conversation's run (403, nothing followed).
 */
export function useFollowRun(conversationId: string | undefined, artifactId: string, enabled: boolean) {
  const qc = useQueryClient();
  const on = enabled && !!conversationId;
  const cid = conversationId ?? "";
  // The chat screen's own key: what it knew is used at once, and what is read here is what it shows on return.
  const active = useQuery({
    queryKey: ["active-run", cid],
    queryFn: ({ signal }) => conversations.activeRun(cid, signal),
    enabled: on,
    retry: false,
  });
  /** Everything the run may have changed, read again; rejects when a read fails (so it is tried again). */
  const refreshAll = () =>
    Promise.all(
      [
        ["messages", cid],
        ["active-run", cid],
        ["conversation", cid],
        CONVERSATIONS_KEY,
        ["artifact"],
        MY_ARTIFACTS_KEY,
      ].map((queryKey) => qc.invalidateQueries({ queryKey }, { throwOnError: true })),
    ).then(() => undefined);
  /** No access any more, or the conversation is gone: nothing of its run is kept or followed. */
  const forget = () => qc.removeQueries({ queryKey: ["active-run", cid] });
  // The refresh after a run ended goes on (backing off) until it has succeeded (review #175 3차).
  const settling = useRef<(() => void) | null>(null);
  const settle = () => {
    settling.current?.();
    settling.current = retryUntil(refreshAll, { firstMs: 0, onGone: forget });
  };
  useEffect(() => () => settling.current?.(), []);
  const { live, reconnect } = useRunStream(
    on ? active.data : null,
    (last) => {
      if (last.notices.length || last.error)
        keepAfter(cid, last.messageId, {
          notices: last.notices,
          ...(last.error ? { error: last.error } : {}),
        });
      settle();
    },
    () => settle(),
  );
  const lostRun = live?.lost ? live.runId : null;
  const onReconnect = useEffectEvent(() => reconnect());
  const onRefresh = useEffectEvent(() => refreshAll());
  const onGone = useEffectEvent(() => forget());
  useEffect(() => {
    if (!lostRun || !cid) return;
    return recoverLost({
      runId: lostRun,
      read: () => conversations.activeRun(cid),
      reconnect: onReconnect,
      refresh: onRefresh,
      gone: onGone,
    });
  }, [lostRun, cid]);
  // The versions this run has stored so far; a new one refreshes the artifact on screen.
  const stored = (live?.parts ?? [])
    .flatMap((p) => (p.type === "artifact_ref" ? [`${p.artifactId}:${p.version ?? ""}`] : []))
    .join(",");
  useEffect(() => {
    if (!stored) return;
    void qc.invalidateQueries({ queryKey: artifactKey(artifactId), exact: true });
    void qc.invalidateQueries({ queryKey: MY_ARTIFACTS_KEY });
  }, [stored, artifactId, qc]);
}

/** How often a lost run is read again at first, and the longest wait between tries (backing off in between). */
export const RECOVER_EVERY_MS = 5000;
export const RECOVER_MAX_MS = 60_000;

type Visibility = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;
export type RetryOptions = {
  /** Wait before the first try (default `everyMs`). */
  firstMs?: number;
  everyMs?: number;
  maxMs?: number;
  /** The page's visibility (default `document`): no tries while hidden, the next one as soon as it shows. */
  doc?: Visibility | undefined;
  /** A 403 or 404: no access any more, or gone — no more tries. */
  onGone?: () => void;
};

const isGone = (e: unknown) => e instanceof ApiError && (e.status === 403 || e.status === 404);

/**
 * Tries `attempt` until it succeeds. A failure is tried again after a growing wait (`everyMs` × 2ⁿ, at most
 * `maxMs`) — except 403/404, which ends it (`onGone`). Nothing is tried while the page is hidden: the due try runs
 * when it shows again. Returns the stop function.
 */
export function retryUntil(attempt: () => Promise<unknown>, opts: RetryOptions = {}): () => void {
  const every = opts.everyMs ?? RECOVER_EVERY_MS;
  const max = opts.maxMs ?? RECOVER_MAX_MS;
  const doc = "doc" in opts ? opts.doc : typeof document === "undefined" ? undefined : document;
  let stopped = false;
  let failures = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onVisible = () => {
    if (!doc || doc.hidden) return;
    doc.removeEventListener("visibilitychange", onVisible);
    void run();
  };
  const later = (ms: number) => {
    timer = setTimeout(() => {
      if (stopped) return;
      if (doc?.hidden) doc.addEventListener("visibilitychange", onVisible);
      else void run();
    }, ms);
  };
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    doc?.removeEventListener("visibilitychange", onVisible);
  };
  const run = async () => {
    if (stopped) return;
    try {
      await attempt();
      stop();
    } catch (e) {
      if (stopped) return;
      if (isGone(e)) {
        stop();
        opts.onGone?.();
        return;
      }
      failures++;
      later(Math.min(every * 2 ** failures, max));
    }
  };
  later(opts.firstMs ?? every);
  return stop;
}

/**
 * Recovery of a run stream that gave up (`retryUntil`, first try after `everyMs`): the conversation's active run is
 * read. Still this run, running → `reconnect` (a new subscription; lost again → a new recovery). Ended, none or
 * another run → `refresh`, tried again until it has succeeded. 403/404 → `gone`.
 */
export function recoverLost(
  opts: {
    runId: string;
    read: () => Promise<Run | null>;
    reconnect: () => void;
    refresh: () => Promise<unknown>;
    gone: () => void;
  } & Omit<RetryOptions, "onGone" | "firstMs">,
): () => void {
  let phase: "check" | "refresh" = "check";
  return retryUntil(
    async () => {
      if (phase === "check") {
        const run = await opts.read();
        if (run && run.id === opts.runId && run.endedAt === null) return opts.reconnect();
        phase = "refresh";
      }
      await opts.refresh();
    },
    { ...opts, onGone: opts.gone },
  );
}
