import { afterEach, describe, expect, it, vi } from "vitest";
import { onlineManager, QueryClient, QueryObserver } from "@tanstack/react-query";
import type { Run } from "@agentlee/shared";
import { rereadQuery } from "../src/chat/reread.js";
import {
  forgetReadsAfterEnd,
  READ_TIMEOUT_MS,
  readMessagesAfterEnd,
  settleEnd,
  type Ending,
} from "../src/chat/settle.js";

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

/** The messages the screen holds: the replies' statuses, newest page first like the server's. */
const pages = (...replies: [string, string][]) => ({
  pages: [{ items: replies.map(([id, status]) => ({ id, role: "assistant", status })), nextBefore: null }],
  pageParams: [undefined],
});
type Pages = ReturnType<typeof pages>;

const flush = async (n = 3) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

/**
 * A messages query on screen: the first read answers at once (`first`); each later one waits for `answer`/`fail`
 * (in order), with the request's signal recorded.
 */
function screen(first: Pages, cached: Run | null = run("r1")) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["active-run", "c1"], cached);
  const held: { answer: (v: Pages) => void; fail: (e: unknown) => void; signal: AbortSignal }[] = [];
  let reads = 0;
  const observer = new QueryObserver(qc, {
    queryKey: ["messages", "c1"],
    queryFn: ({ signal }) => {
      if (reads++ === 0) return Promise.resolve(first);
      return new Promise<Pages>((answer, fail) => held.push({ answer, fail, signal }));
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  let arounds = 0;
  const settle = (
    ending: Ending,
    readActiveRun = async (): Promise<Run | null> => null,
    signal?: AbortSignal,
  ) =>
    settleEnd({
      qc,
      ending,
      signal: signal ?? new AbortController().signal,
      readActiveRun,
      around: () => arounds++,
    });
  const active = () => qc.getQueryData<Run | null>(["active-run", "c1"]);
  return { qc, held, reads: () => reads, unsubscribe, settle, active, arounds: () => arounds };
}

const ofRun1: Ending = { conversationId: "c1", messageId: "m-r1", runId: "r1" };

afterEach(() => {
  vi.useRealTimers();
  onlineManager.setOnline(true);
});

describe("settling a reply's end (#103 review): one way for every sign of an end", () => {
  it("stop and `done` together: one read after the end for both, and the live reply stays until it shows final", async () => {
    const s = screen(pages(["m-r1", "streaming"]));
    await flush();
    // The stop answered with an ended run, and the stream's `done`: two signs, the same end.
    const byStop = s.settle(ofRun1);
    const byDone = s.settle(ofRun1);
    await flush();
    expect(s.reads()).toBe(2);
    expect(s.held).toHaveLength(1);
    expect(s.active()?.id).toBe("r1"); // not let go before the read answered
    s.held[0]!.answer(pages(["m-r1", "stopped"]));
    expect(await byStop).toBe("final");
    expect(await byDone).toBe("final");
    expect(s.active()).toBeNull();
    expect(s.reads()).toBe(2);
    s.unsubscribe();
  });

  it("a read after the end that still shows it unfinished, and no run: the live reply stays; the next try settles it", async () => {
    const s = screen(pages(["m-r1", "streaming"]));
    await flush();
    const first = s.settle(ofRun1);
    await flush();
    s.held[0]!.answer(pages(["m-r1", "streaming"]));
    expect(await first).toBe("unfinished");
    expect(s.active()?.id).toBe("r1");
    expect(s.arounds()).toBe(0);
    const second = s.settle(ofRun1);
    await flush();
    s.held[1]!.answer(pages(["m-r1", "complete"]));
    expect(await second).toBe("final");
    expect(s.active()).toBeNull();
    expect(s.arounds()).toBe(1);
    s.unsubscribe();
  });

  it("no run followed, an unfinished reply (sent from another tab): the run found is followed, its reply read in", async () => {
    // The screen read "no run", then another tab sent: the reply is pending, its run running.
    const s = screen(pages(["m-r2", "pending"]), null);
    await flush();
    const p = s.settle({ conversationId: "c1", messageId: "m-r2", runId: null }, async () => run("r2"));
    await flush();
    s.held[0]!.answer(pages(["m-r2", "pending"]));
    expect(await p).toBe("running");
    expect(s.active()?.id).toBe("r2");
    await flush();
    expect(s.reads()).toBe(3); // the messages are read again (its reply joins the list)
    s.unsubscribe();
  });

  it("a stream closed without `done`, the run's state unreadable: kept, tried again, settled once the reply is final", async () => {
    const s = screen(pages(["m-r1", "streaming"]));
    await flush();
    const failing = async (): Promise<Run | null> => {
      throw Object.assign(new Error("offline"), { status: 0 });
    };
    const first = s.settle(ofRun1, failing);
    await flush();
    s.held[0]!.answer(pages(["m-r1", "streaming"]));
    await expect(first).rejects.toThrow();
    expect(s.active()?.id).toBe("r1");
    // Saved as complete, but the run's end still unreadable: kept (busy until it is read, #141).
    const second = s.settle(ofRun1, failing);
    await flush();
    s.held[1]!.answer(pages(["m-r1", "complete"]));
    await expect(second).rejects.toThrow();
    expect(s.active()?.id).toBe("r1");
    const third = s.settle(ofRun1);
    await flush();
    s.held[2]!.answer(pages(["m-r1", "complete"]));
    expect(await third).toBe("final");
    expect(s.active()).toBeNull();
    s.unsubscribe();
  });

  it("a failed read keeps the live reply; the next try reads again", async () => {
    const s = screen(pages(["m-r1", "streaming"]));
    await flush();
    const first = s.settle(ofRun1);
    await flush();
    s.held[0]!.fail(new Error("500"));
    await expect(first).rejects.toThrow();
    expect(s.active()?.id).toBe("r1");
    const second = s.settle(ofRun1);
    await flush();
    expect(s.reads()).toBe(3);
    s.held[1]!.answer(pages(["m-r1", "complete"]));
    expect(await second).toBe("final");
    s.unsubscribe();
  });

  it("saved as final but the run not read as ended yet: still busy (the server refuses a send until then, #141)", async () => {
    const s = screen(pages(["m-r1", "streaming"]));
    await flush();
    const first = s.settle(ofRun1, async () => run("r1"));
    await flush();
    s.held[0]!.answer(pages(["m-r1", "complete"]));
    expect(await first).toBe("unfinished");
    expect(s.active()?.id).toBe("r1");
    // Its state unreadable: still kept (a failed read is tried again, never cleared on a guess).
    const failing = s.settle(ofRun1, async () => {
      throw new Error("500");
    });
    await flush();
    s.held[1]!.answer(pages(["m-r1", "complete"]));
    await expect(failing).rejects.toThrow();
    expect(s.active()?.id).toBe("r1");
    // Read as ended: let go, with the answer read.
    const ended = s.settle(ofRun1, async () => run("r1", 5));
    await flush();
    s.held[2]!.answer(pages(["m-r1", "complete"]));
    expect(await ended).toBe("final");
    expect(s.active()?.endedAt).toBe(5);
    s.unsubscribe();
  });

  it("the conversation gone (404): nothing to wait for — let go", async () => {
    const s = screen(pages(["m-r1", "streaming"]));
    await flush();
    const p = s.settle(ofRun1);
    await flush();
    s.held[0]!.fail(Object.assign(new Error("not found"), { status: 404 }));
    expect(await p).toBe("final");
    expect(s.active()).toBeNull();
    s.unsubscribe();
  });

  it("a run taken up meanwhile (a send here) is never overwritten by a late settle", async () => {
    const s = screen(pages(["m-r1", "streaming"]));
    await flush();
    const p = s.settle(ofRun1);
    await flush();
    s.qc.setQueryData(["active-run", "c1"], run("r2"));
    s.held[0]!.answer(pages(["m-r1", "complete"]));
    expect(await p).toBe("running");
    expect(s.active()?.id).toBe("r2");
    expect(s.arounds()).toBe(0);
    s.unsubscribe();
  });

  it("a settle for a conversation left (aborted) applies nothing", async () => {
    const s = screen(pages(["m-r1", "streaming"]));
    await flush();
    const ac = new AbortController();
    const p = s.settle(ofRun1, undefined, ac.signal);
    await flush();
    ac.abort();
    s.held[0]!.answer(pages(["m-r1", "complete"]));
    expect(await p).toBe("unfinished");
    expect(s.active()?.id).toBe("r1");
    s.unsubscribe();
  });
});

describe("the read after an end: a real new read, never one that cannot answer (#103 review)", () => {
  it("a first read sent before the end and still on its way is not what it waits for", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let answerFirst!: (v: Pages) => void;
    let reads = 0;
    const unsubscribe = new QueryObserver(qc, {
      queryKey: ["messages", "c1"],
      queryFn: () =>
        reads++ === 0
          ? new Promise<Pages>((r) => (answerFirst = r))
          : Promise.resolve(pages(["m-r1", "complete"])),
    }).subscribe(() => {});
    await flush();
    // A plain invalidate joins it (TanStack cancels an in-flight read only when there is data): the original bug.
    void qc.invalidateQueries({ queryKey: ["messages", "c1"] });
    await flush();
    expect(reads).toBe(1);
    const p = readMessagesAfterEnd(qc, "c1", "m-r1");
    await flush();
    answerFirst(pages(["m-r1", "streaming"]));
    await p;
    expect(reads).toBe(2);
    expect(qc.getQueryData<Pages>(["messages", "c1"])?.pages[0]!.items[0]!.status).toBe("complete");
    unsubscribe();
  });

  it("rereadQuery sends a new read too (a send's read of its new messages)", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let reads = 0;
    let answerFirst!: (v: string) => void;
    const unsubscribe = new QueryObserver(qc, {
      queryKey: ["messages", "c1"],
      queryFn: () =>
        reads++ === 0 ? new Promise<string>((r) => (answerFirst = r)) : Promise.resolve("after"),
    }).subscribe(() => {});
    await flush();
    const p = rereadQuery(qc, ["messages", "c1"]);
    await flush();
    expect(reads).toBe(2);
    answerFirst("before");
    await p;
    expect(qc.getQueryData(["messages", "c1"])).toBe("after");
    unsubscribe();
  });

  it("a hung read is given up after the time limit (the shared read does not stay pinned): the next try reads again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = screen(pages(["m-r1", "streaming"]));
    await vi.advanceTimersByTimeAsync(0);
    const p = readMessagesAfterEnd(s.qc, "c1", "m-r1");
    const rejected = expect(p).rejects.toThrow(/timeout/);
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    await rejected;
    const again = readMessagesAfterEnd(s.qc, "c1", "m-r1");
    expect(again).not.toBe(p);
    await vi.advanceTimersByTimeAsync(0);
    expect(s.reads()).toBe(3);
    s.held[1]!.answer(pages(["m-r1", "complete"]));
    await again;
    s.unsubscribe();
  });

  it("the screen gone while the read is on its way: the request is cancelled (its signal), the read rejects and is forgotten", async () => {
    const s = screen(pages(["m-r1", "streaming"]));
    await flush();
    const p = readMessagesAfterEnd(s.qc, "c1", "m-r1");
    const settled = p.then(
      () => "resolved",
      () => "rejected",
    );
    await flush();
    expect(s.held[0]!.signal.aborted).toBe(false);
    s.unsubscribe();
    forgetReadsAfterEnd(s.qc, "c1");
    await flush();
    expect(s.held[0]!.signal.aborted).toBe(true);
    expect(await settled).toBe("rejected");
    // A later try (the screen back) is a new read of its own.
    expect(readMessagesAfterEnd(s.qc, "c1", "m-r1")).not.toBe(p);
  });

  it("offline (the read paused): never taken as read — it waits, then gives up; the cache still shows the old reply", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = screen(pages(["m-r1", "streaming"]));
    await vi.advanceTimersByTimeAsync(0);
    onlineManager.setOnline(false);
    const p = readMessagesAfterEnd(s.qc, "c1", "m-r1");
    const rejected = expect(p).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(READ_TIMEOUT_MS);
    await rejected;
    expect(s.reads()).toBe(1); // no read was sent
    expect(s.qc.getQueryData<Pages>(["messages", "c1"])?.pages[0]!.items[0]!.status).toBe("streaming");
    s.unsubscribe();
  });
});
