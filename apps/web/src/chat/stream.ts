import { useCallback, useEffect, useRef, useState } from "react";
import type { Message, MessagePart, PublicPart, Run, StreamEvent } from "@agentlee/shared";
import { ApiError, runs } from "../api.js";

/**
 * Live state of a reply, rebuilt from the run's event stream (#12) the same way the server builds the stored
 * parts: deltas append to the text part at `partIndex`, tool events add tool_call / tool_result parts. Parts
 * that did not change keep their identity, so memoised rendering skips them.
 */
/** `switchTo`: runtimes the user could continue with instead (a subscription limit, an expired login — #18). */
export type Notice = { level: "info" | "warn"; code: string; message: string; switchTo?: string[] };
export type LiveReply = {
  runId: string;
  messageId: string;
  parts: PublicPart[];
  notices: Notice[];
  error?: { code: string; message: string };
  status?: Message["status"];
  /** The event stream dropped and EventSource is reconnecting (resumes from Last-Event-ID). */
  reconnecting: boolean;
  /**
   * Retries are used up while the run may still be going: the screen stops waiting (not busy) and offers
   * "다시 연결". A later look at the run (it ended) clears it.
   */
  lost?: boolean;
};

export const emptyLive = (runId: string, messageId: string): LiveReply => ({
  runId,
  messageId,
  parts: [],
  notices: [],
  reconnecting: false,
});

export function applyEvent(l: LiveReply, e: StreamEvent): LiveReply {
  switch (e.type) {
    case "delta": {
      const parts = [...l.parts];
      const at = parts[e.partIndex];
      if (at?.type === "text") parts[e.partIndex] = { type: "text", text: at.text + e.text };
      else if (e.partIndex >= parts.length) parts.push({ type: "text", text: e.text });
      else parts.splice(e.partIndex, 0, { type: "text", text: e.text });
      return { ...l, parts };
    }
    case "tool_start":
      return {
        ...l,
        parts: [...l.parts, { type: "tool_call", id: e.callId, name: e.name, input: e.input ?? null }],
      };
    case "tool_end":
      return {
        ...l,
        parts: [
          ...l.parts,
          {
            type: "tool_result",
            callId: e.callId,
            output: e.output ?? null,
            ...(e.isError ? { isError: true } : {}),
          },
        ],
      };
    case "part_update": {
      const part = e.part as MessagePart;
      if (part.type === "reasoning") return l; // internal, never shown
      const parts = [...l.parts];
      parts[e.partIndex] = part;
      return { ...l, parts };
    }
    case "notice":
      return {
        ...l,
        notices: [
          ...l.notices,
          {
            level: e.level,
            code: e.code,
            message: e.message,
            ...(e.switchTo?.length ? { switchTo: e.switchTo } : {}),
          },
        ],
      };
    case "error":
      return { ...l, error: { code: e.code, message: e.message } };
    case "done":
      return { ...l, status: e.status };
    default:
      return l;
  }
}

const EVENT_TYPES: StreamEvent["type"][] = [
  "delta",
  "tool_start",
  "tool_end",
  "part_update",
  "notice",
  "error",
  "done",
];

/** Runs `fn` later; returns a cancel function. */
export type Scheduler = (fn: () => void) => () => void;

/** Next animation frame; background tabs get no frames, so a timer keeps their state current. */
export const frameScheduler: Scheduler = (fn) => {
  if (document.hidden) {
    const t = setTimeout(fn, 250);
    return () => clearTimeout(t);
  }
  const f = requestAnimationFrame(fn);
  return () => cancelAnimationFrame(f);
};

/**
 * Collects events and hands them over in one batch per scheduled tick (one animation frame): a fast stream
 * costs one render per frame, not one per token.
 */
export class FrameBatcher<E> {
  private queue: E[] = [];
  private cancel: (() => void) | null = null;
  constructor(
    private readonly commit: (events: E[]) => void,
    private readonly schedule: Scheduler = frameScheduler,
  ) {}
  push(e: E): void {
    this.queue.push(e);
    this.cancel ??= this.schedule(() => {
      this.cancel = null;
      this.flush();
    });
  }
  /** Hands over whatever is queued now (end of the stream). */
  flush(): void {
    this.cancel?.();
    this.cancel = null;
    if (!this.queue.length) return;
    const events = this.queue;
    this.queue = [];
    this.commit(events);
  }
  dispose(): void {
    this.cancel?.();
    this.cancel = null;
    this.queue = [];
  }
}

/** Connection failures in a row — without a single new event in between — before giving up. */
export const MAX_FAILURES = 5;

/**
 * Follows a run's event stream. A dropped connection is resumed by EventSource itself (Last-Event-ID header).
 * A subscription that ends without `done` (an HTTP error, the server going away) is opened again with the
 * last event seen (`?lastEventId=`) while the run is there, with backoff; events already applied are skipped
 * by id, so nothing is shown twice or lost. Only a new event resets the failure budget (a connection that
 * opens and drops again without sending anything does not), so after `MAX_FAILURES` the stream gives up and
 * the reply is marked `lost` — `reconnect()` starts over. `onEnd` gets the final live state (notices and
 * errors are not stored with the message); `onLost` is told when the stream gave up.
 */
export function useRunStream(
  run: Run | null | undefined,
  onEnd: (last: LiveReply) => void,
  onLost?: () => void,
): { live: LiveReply | null; reconnect: () => void } {
  const [attempt, setAttempt] = useState(0);
  // Tagged with the attempt it belongs to: after "다시 연결" the old (lost) state is not shown again.
  const [tagged, setTagged] = useState<{ attempt: number; live: LiveReply } | null>(null);
  const endRef = useRef(onEnd);
  const lostRef = useRef(onLost);
  useEffect(() => {
    endRef.current = onEnd;
    lostRef.current = onLost;
  });
  const runId = run && run.endedAt === null ? run.id : null;
  const messageId = run?.assistantMessageId ?? "";
  useEffect(() => {
    if (!runId) return;
    const setState = (live: LiveReply) => setTagged({ attempt, live });
    let cur = emptyLive(runId, messageId);
    let lastId = 0;
    let ended = false;
    let failures = 0;
    let triedAfterEnd = 0;
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const batcher = new FrameBatcher<StreamEvent>((events) => {
      for (const e of events) cur = applyEvent(cur, e);
      setState(cur);
    });
    const setReconnecting = (reconnecting: boolean) => {
      if (cur.reconnecting === reconnecting) return;
      batcher.flush();
      cur = { ...cur, reconnecting };
      setState(cur);
    };
    const end = () => {
      if (ended) return;
      ended = true;
      clearTimeout(retryTimer);
      batcher.flush();
      es?.close();
      endRef.current(cur);
    };
    const giveUp = () => {
      if (ended) return;
      ended = true;
      clearTimeout(retryTimer);
      es?.close();
      batcher.flush();
      cur = { ...cur, reconnecting: false, lost: true };
      setState(cur);
      lostRef.current?.();
    };
    const resubscribe = async () => {
      let status: "active" | "ended" | "gone" | "unknown" = "unknown";
      try {
        status = (await runs.get(runId)).endedAt === null ? "active" : "ended";
      } catch (e) {
        if (e instanceof ApiError && [401, 403, 404].includes(e.status)) status = "gone";
      }
      if (ended) return;
      if (status === "gone") return end();
      // Ended: one more subscription fetches the rest (and `done`); if even that fails (events expired after
      // an hour), show what was saved.
      if (status === "ended" && triedAfterEnd++ > 0) return end();
      retryTimer = setTimeout(open, Math.min(500 * 2 ** (failures - 1), 3000));
    };
    const open = () => {
      if (ended) return;
      const s = new EventSource(
        `/api/runs/${encodeURIComponent(runId)}/events${lastId ? `?lastEventId=${lastId}` : ""}`,
      );
      es = s;
      // Our "error" event shares its name with EventSource's own connection-error event (which has no data).
      for (const type of EVENT_TYPES)
        s.addEventListener(type, (m) => {
          const msg = m as MessageEvent<unknown>;
          if (typeof msg.data !== "string" || ended) return;
          const id = Number(msg.lastEventId);
          if (Number.isInteger(id) && id > 0) {
            if (id <= lastId) return; // already applied (replay after a resubscribe)
            lastId = id;
          }
          let e: StreamEvent;
          try {
            e = JSON.parse(msg.data) as StreamEvent;
          } catch {
            return;
          }
          failures = 0; // progress: the connection works again
          batcher.push(e);
          if (e.type === "done") end();
        });
      s.onopen = () => setReconnecting(false);
      s.onerror = () => {
        if (ended) return;
        failures++;
        if (failures > MAX_FAILURES) return giveUp();
        setReconnecting(true);
        // CONNECTING: the browser retries by itself. CLOSED without `done`: it will not — we do.
        if (s.readyState === EventSource.CLOSED) {
          s.close();
          void resubscribe();
        }
      };
    };
    open();
    return () => {
      ended = true;
      clearTimeout(retryTimer);
      batcher.dispose();
      es?.close();
    };
  }, [runId, messageId, attempt]);
  const reconnect = useCallback(() => setAttempt((a) => a + 1), []);
  if (!runId) return { live: null, reconnect };
  const state = tagged?.attempt === attempt ? tagged.live : null;
  return { live: state?.runId === runId ? state : emptyLive(runId, messageId), reconnect };
}
