import { describe, expect, it } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { Run } from "@agentlee/shared";
import { confirmRunEnded } from "../src/chat/confirm-end.js";
import { readMessagesAfterEnd, rereadQuery } from "../src/chat/reread.js";

const run = (id: string, endedAt: number | null = null): Run => ({
  id,
  conversationId: "c1",
  assistantMessageId: `m-${id}`,
  status: endedAt === null ? "running" : "done",
  errorCode: null,
  runtime: "claude-code",
  model: "fake",
  effort: null,
  connectionId: null,
  createdAt: 1,
  endedAt,
});

/** A read held until `answer()` — like a slow `active-run` response. */
function heldRead() {
  let answer!: (r: Run | null) => void;
  let asked = 0;
  const read = () => {
    asked++;
    return new Promise<Run | null>((resolve) => (answer = resolve));
  };
  return { read, answer: (r: Run | null) => answer(r), asked: () => asked };
}

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["active-run", "c1"], run("r1"));
  let around = 0;
  return { qc, around: () => around++, arounds: () => around };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("confirmRunEnded (#141)", () => {
  it("applies the answer while the cache still holds the run it checks", async () => {
    const { qc, around, arounds } = setup();
    const ac = new AbortController();
    const ok = await confirmRunEnded({
      qc,
      conversationId: "c1",
      runId: "r1",
      signal: ac.signal,
      read: async () => null,
      around,
    });
    expect(ok).toBe(true);
    expect(qc.getQueryData(["active-run", "c1"])).toBeNull();
    expect(arounds()).toBe(1);
  });

  it("a late `null` never wipes the next run started since the read began", async () => {
    const { qc, around, arounds } = setup();
    const h = heldRead();
    const ac = new AbortController();
    const p = confirmRunEnded({
      qc,
      conversationId: "c1",
      runId: "r1",
      signal: ac.signal,
      read: h.read,
      around,
    });
    await flush();
    // The normal path confirmed r1 ended, then the next send stored r2.
    qc.setQueryData(["active-run", "c1"], null);
    qc.setQueryData(["active-run", "c1"], run("r2"));
    h.answer(null);
    expect(await p).toBe(false);
    expect(qc.getQueryData<Run>(["active-run", "c1"])?.id).toBe("r2");
    expect(arounds()).toBe(0); // no follow-up refresh for a stale answer
  });

  it("an aborted check (finishing ended, conversation left) is never applied", async () => {
    const { qc, around, arounds } = setup();
    const h = heldRead();
    const ac = new AbortController();
    const p = confirmRunEnded({
      qc,
      conversationId: "c1",
      runId: "r1",
      signal: ac.signal,
      read: h.read,
      around,
    });
    await flush();
    ac.abort();
    h.answer(null);
    expect(await p).toBe(false);
    expect(qc.getQueryData<Run>(["active-run", "c1"])?.id).toBe("r1");
    expect(arounds()).toBe(0);
  });

  it("a run started while the messages are read again is not overwritten either", async () => {
    const { qc, around } = setup();
    const ac = new AbortController();
    // The messages query exists and is being read again when the new run arrives.
    let release!: () => void;
    const messages = new Promise<void>((r) => (release = r));
    let reads = 0;
    const unsubscribe = new QueryObserver(qc, {
      queryKey: ["messages", "c1"],
      queryFn: async () => {
        if (reads++ > 0) await messages; // the first read (on subscribe) answers at once
        return [];
      },
    }).subscribe(() => {});
    await flush();
    const p = confirmRunEnded({
      qc,
      conversationId: "c1",
      runId: "r1",
      signal: ac.signal,
      read: async () => null,
      around,
    });
    await flush();
    qc.setQueryData(["active-run", "c1"], run("r2"));
    release();
    expect(await p).toBe(false);
    expect(reads).toBe(2);
    expect(qc.getQueryData<Run>(["active-run", "c1"])?.id).toBe("r2");
    unsubscribe();
  });

  it("the cache already let the run go (the normal path won): nothing to apply", async () => {
    const { qc, around, arounds } = setup();
    qc.setQueryData(["active-run", "c1"], null);
    const ok = await confirmRunEnded({
      qc,
      conversationId: "c1",
      runId: "r1",
      signal: new AbortController().signal,
      read: async () => run("r1", 5),
      around,
    });
    expect(ok).toBe(false);
    expect(qc.getQueryData(["active-run", "c1"])).toBeNull();
    expect(arounds()).toBe(0);
  });
});

describe("rereadQuery (#103)", () => {
  it("a first read still on its way is not taken as the read after: a new one is sent and its answer kept", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // The first read (sent while the reply streamed) is held; every later one answers at once.
    let answerFirst!: (v: string) => void;
    let reads = 0;
    const unsubscribe = new QueryObserver(qc, {
      queryKey: ["messages", "c1"],
      queryFn: () =>
        reads++ === 0 ? new Promise<string>((r) => (answerFirst = r)) : Promise.resolve("complete"),
    }).subscribe(() => {});
    await flush();
    expect(reads).toBe(1);
    // A plain invalidate joins it (TanStack cancels an in-flight read only when there is data): the bug.
    const joined = qc.invalidateQueries({ queryKey: ["messages", "c1"] });
    await flush();
    expect(reads).toBe(1);
    const p = rereadQuery(qc, ["messages", "c1"]);
    await flush();
    expect(reads).toBe(2);
    answerFirst("streaming");
    await p;
    await joined;
    expect(qc.getQueryData(["messages", "c1"])).toBe("complete");
    unsubscribe();
  });
});

/** A messages query on screen whose reads after the first are held until answered (or failed) one by one. */
function heldMessages(qc: QueryClient) {
  const pending: { answer: (v: string) => void; fail: (e: Error) => void }[] = [];
  let reads = 0;
  const unsubscribe = new QueryObserver(qc, {
    queryKey: ["messages", "c1"],
    queryFn: () => {
      if (reads++ === 0) return Promise.resolve("streaming");
      return new Promise<string>((answer, fail) => pending.push({ answer, fail }));
    },
  }).subscribe(() => {});
  return { reads: () => reads, pending, unsubscribe };
}

describe("the read after the end, shared by the refresh and the check while finishing (#103 review)", () => {
  it("the check joins the refresh's read (never cancels it) and applies nothing before it succeeded", async () => {
    const { qc, around, arounds } = setup();
    const m = heldMessages(qc);
    await flush();
    let refreshed = false;
    // The refresh after `done`: messages, then (only then) the run's state.
    const refresh = readMessagesAfterEnd(qc, "c1", "r1").then(() => (refreshed = true));
    await flush();
    expect(m.reads()).toBe(2);
    const check = confirmRunEnded({
      qc,
      conversationId: "c1",
      runId: "r1",
      signal: new AbortController().signal,
      read: async () => null,
      around,
    });
    await flush();
    await flush();
    // One read in flight for both; the live reply is still held (the run is still in the cache).
    expect(m.reads()).toBe(2);
    expect(m.pending).toHaveLength(1);
    expect(refreshed).toBe(false);
    expect(qc.getQueryData<Run>(["active-run", "c1"])?.id).toBe("r1");
    m.pending[0]!.answer("complete");
    expect(await check).toBe(true);
    await refresh;
    expect(qc.getQueryData(["messages", "c1"])).toBe("complete");
    expect(qc.getQueryData(["active-run", "c1"])).toBeNull();
    expect(arounds()).toBe(1);
    m.unsubscribe();
  });

  it("a failed read keeps the live reply for both; the next try reads again and then lets it go", async () => {
    const { qc, around } = setup();
    const m = heldMessages(qc);
    await flush();
    const refresh = readMessagesAfterEnd(qc, "c1", "r1");
    const check = () =>
      confirmRunEnded({
        qc,
        conversationId: "c1",
        runId: "r1",
        signal: new AbortController().signal,
        read: async () => null,
        around,
      });
    const first = check();
    await flush();
    await flush();
    m.pending[0]!.fail(new Error("offline"));
    await expect(refresh).rejects.toThrow();
    await expect(first).rejects.toThrow();
    expect(qc.getQueryData<Run>(["active-run", "c1"])?.id).toBe("r1");
    expect(qc.getQueryData(["messages", "c1"])).toBe("streaming");
    // The next tick: a new read, answered — applied.
    const second = check();
    await flush();
    await flush();
    expect(m.reads()).toBe(3);
    m.pending[1]!.answer("complete");
    expect(await second).toBe(true);
    expect(qc.getQueryData(["active-run", "c1"])).toBeNull();
    m.unsubscribe();
  });

  it("a first read sent before the end and still on its way is never what it waits for", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let answerFirst!: (v: string) => void;
    let reads = 0;
    const unsubscribe = new QueryObserver(qc, {
      queryKey: ["messages", "c1"],
      queryFn: () =>
        reads++ === 0 ? new Promise<string>((r) => (answerFirst = r)) : Promise.resolve("complete"),
    }).subscribe(() => {});
    await flush();
    const p = readMessagesAfterEnd(qc, "c1", "r1");
    await flush();
    answerFirst("streaming");
    await p;
    expect(reads).toBe(2);
    expect(qc.getQueryData(["messages", "c1"])).toBe("complete");
    unsubscribe();
  });
});
