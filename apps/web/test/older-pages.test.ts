import { afterEach, describe, expect, it } from "vitest";
import { InfiniteQueryObserver, onlineManager, QueryClient, type InfiniteData } from "@tanstack/react-query";
import { listBusy, olderStep, type OlderAsk } from "../src/chat/older-pages.js";

type Page = { items: string[]; nextBefore: number | null };
const flush = async (n = 3) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

/** The chat screen's messages query (newest page first), with each request answered by `answer`. */
function list(answer: (page: number | undefined) => Promise<Page>) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const observer = new InfiniteQueryObserver<Page, Error, InfiniteData<Page>, string[], number | undefined>(
    qc,
    {
      queryKey: ["messages", "c1"],
      queryFn: ({ pageParam }) => answer(pageParam),
      initialPageParam: undefined,
      getNextPageParam: (last) => last.nextBefore ?? undefined,
    },
  );
  const unsubscribe = observer.subscribe(() => {});
  const now = (): Parameters<typeof olderStep>[1] => {
    const r = observer.getCurrentResult();
    return {
      conversationId: "c1",
      pages: r.data?.pages.length ?? 0,
      hasNextPage: r.hasNextPage,
      failed: r.isFetchNextPageError,
      busy: listBusy(qc, ["messages", "c1"]),
    };
  };
  return { qc, observer, unsubscribe, now };
}

afterEach(() => onlineManager.setOnline(true));

describe("a waiting older-page click (#103 review)", () => {
  it("offline, the paused read counts as busy (isFetching says 0): the click waits, the newest read goes on after", async () => {
    let newest = 0;
    const l = list(async (p) =>
      p === undefined ? { items: [`n${++newest}`], nextBefore: 1 } : { items: ["old"], nextBefore: null },
    );
    await flush();
    onlineManager.setOnline(false);
    void l.qc.refetchQueries({ queryKey: ["messages", "c1"] }); // the read after an end, paused offline
    await flush();
    expect(l.qc.isFetching({ queryKey: ["messages", "c1"] })).toBe(0);
    expect(listBusy(l.qc, ["messages", "c1"])).toBe(true);
    const ask: OlderAsk = { conversationId: "c1", pages: 1 };
    expect(olderStep(ask, l.now())).toBe("wait");
    onlineManager.setOnline(true);
    // (What the client does on reconnect when mounted: paused fetches go on.)
    l.qc.getQueryCache().onOnline();
    for (let i = 0; i < 50 && listBusy(l.qc, ["messages", "c1"]); i++) await flush();
    // Back online: the newest page was read again (not cut short by the click), then the click may go.
    expect(l.observer.getCurrentResult().data?.pages[0]?.items).toEqual(["n2"]);
    expect(olderStep(ask, l.now())).toBe("fetch");
    l.unsubscribe();
  });

  it("a page fetch cancelled by another read (a schedule result's) is asked for again; done once the page arrived", async () => {
    const l = list(async (p) =>
      p === undefined ? { items: ["n"], nextBefore: 1 } : { items: ["old"], nextBefore: null },
    );
    await flush();
    const ask: OlderAsk = { conversationId: "c1", pages: 1, started: true };
    // The click's page fetch, then another read's invalidate cancels it.
    void l.observer.fetchNextPage();
    void l.qc.invalidateQueries({ queryKey: ["messages", "c1"] });
    await flush(6);
    expect(l.observer.getCurrentResult().data?.pages).toHaveLength(1);
    expect(olderStep(ask, l.now())).toBe("fetch"); // not done: asked again
    await l.observer.fetchNextPage();
    expect(olderStep(ask, l.now())).toBe("done");
    l.unsubscribe();
  });

  it("an earlier page's error left over is not the click's answer; its own failure ends it", () => {
    const base = { conversationId: "c1", pages: 1, hasNextPage: true, failed: true, busy: false };
    expect(olderStep({ conversationId: "c1", pages: 1 }, base)).toBe("fetch");
    expect(olderStep({ conversationId: "c1", pages: 1, started: true }, base)).toBe("done");
    expect(olderStep({ conversationId: "c0", pages: 1 }, base)).toBe("none");
    expect(olderStep(null, base)).toBe("none");
  });
});
