import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ARTIFACT_REDACTED_NOTICE } from "@agentlee/shared";
import { ApiError } from "../src/api.js";
import {
  ViewerBody,
  artifactErrorText,
  artifactKey,
  fenceFor,
  fenced,
  type ArtifactViewer,
} from "../src/artifacts/viewer.js";
import { splitBlocks } from "../src/chat/blocks.js";
import { AFTER_RUN_LIMITS, afterSize, clearAfter, keepAfter, takeAfter } from "../src/chat/after-run.js";
import { recoverLost, retryUntil } from "../src/artifacts/follow-run.js";
import {
  ArtifactCard,
  artifactLink,
  fromOf,
  legacyPanelTarget,
  pinnedVersion,
} from "../src/artifacts/ArtifactCard.js";
import { MemoryRouter } from "react-router";

const viewer = (v: Partial<ArtifactViewer>) =>
  ({ revoked: false, data: undefined, error: null, ...v }) as ArtifactViewer;
const render = (v: Partial<ArtifactViewer>, qc = new QueryClient()) =>
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client: qc }, createElement(ViewerBody, { v: viewer(v) })),
  );

describe("the artifact page body (#29, review #117)", () => {
  it("shows the revoke notice — not 'loading' — once a share no longer shows the artifact", () => {
    const html = render({ revoked: true });
    expect(html).toContain('data-testid="artifact-revoked"');
    expect(html).toContain("이미 내려받은 파일");
    expect(html).not.toContain("불러오는 중");
    expect(html).not.toContain("artifact-frame");
  });

  it("still says loading while there is nothing yet", () => {
    expect(render({})).toContain("불러오는 중");
  });
});

describe("a redacted version (#53 review)", () => {
  const base = {
    id: "a1",
    conversationId: "c1",
    messageId: null,
    runId: null,
    kind: "table" as const,
    title: "표",
    language: null,
    latestVersion: 2,
    createdAt: 1,
    updatedAt: 1,
  };
  const ver = (version: number, redacted?: true) => ({
    version,
    contentHash: "h",
    bytes: 1,
    title: "표",
    language: null,
    runId: null,
    revertedFrom: null,
    createdAt: 1,
    ...(redacted ? { redacted } : {}),
  });
  const data = { ...base, versions: [ver(1), ver(2, true)] };

  it("shows the notice instead of the frame, and offers no download, export or restore of it", () => {
    const html = render({
      data,
      version: 2,
      title: "표",
      owner: false,
      revert: { isPending: false, isError: false },
    } as never);
    expect(html).toContain('data-testid="artifact-redacted"');
    expect(html).toContain(ARTIFACT_REDACTED_NOTICE);
    expect(html).not.toContain("artifact-frame");
    expect(html).not.toContain("/raw");
    expect(html).not.toContain("artifact-download");
    expect(html).not.toContain("artifact-export-");
    // In the version list it is marked.
    expect(html).toContain("· 가림");
  });

  it("another version of the same artifact still opens in the frame", () => {
    const html = render({
      data,
      version: 1,
      title: "표",
      owner: false,
      revert: { isPending: false, isError: false },
    } as never);
    expect(html).toContain('data-testid="artifact-frame"');
    expect(html).not.toContain('data-testid="artifact-redacted"');
    expect(html).toContain("artifact-revert");
  });

  it("the version API's 409 artifact_redacted reads as the notice too", () => {
    expect(artifactErrorText(new ApiError(409, "artifact_redacted"))).toBe(ARTIFACT_REDACTED_NOTICE);
    expect(artifactErrorText(new ApiError(404, "not_found"))).toBe("아티팩트를 찾을 수 없어요.");
  });
});

describe("markdown and code artifacts (#172)", () => {
  const md = {
    id: "m1",
    conversationId: "c1",
    messageId: null,
    runId: null,
    kind: "markdown" as const,
    title: "메모",
    language: null,
    latestVersion: 2,
    createdAt: 1,
    updatedAt: 1,
  };
  const ver = (version: number, redacted?: true) => ({
    version,
    contentHash: "h",
    bytes: 1,
    title: "메모",
    language: null,
    runId: null,
    revertedFrom: null,
    createdAt: 1,
    ...(redacted ? { redacted } : {}),
  });
  const viewed = (version: number) => ({
    data: { ...md, versions: [ver(1), ver(2, true)] },
    version,
    title: "메모",
    owner: true,
    revert: { isPending: false, isError: false },
  });

  it("is rendered by the app from the version's text — no frame, no raw original", () => {
    const qc = new QueryClient();
    qc.setQueryData([...artifactKey("m1"), "v", 1], { version: 1, kind: "markdown", content: "# 제목" });
    const html = render(viewed(1) as never, qc);
    expect(html).toContain('data-testid="artifact-text"');
    expect(html).toContain('data-kind="markdown"');
    // Until the renderer's chunk is there, the text shows as plain text (the chat's fallback).
    expect(html).toContain("# 제목");
    expect(html).not.toContain("artifact-frame");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain("/raw");
    // The original download stays the .md file.
    expect(html).toContain("/a/m1/v/1/download");
  });

  it("a redacted version shows the notice and nothing of its text", () => {
    const html = render(viewed(2) as never);
    expect(html).toContain('data-testid="artifact-redacted"');
    expect(html).not.toContain("artifact-text");
  });
});

describe("artifact page addresses (#172)", () => {
  it("links: the newest is followed, a version is in ?v=", () => {
    expect(artifactLink("a 1")).toBe("/a/a%201");
    expect(artifactLink("a1", 3)).toBe("/a/a1?v=3");
  });

  it("a card pins ?v= only for a version that really is older than the newest (review #175 4차)", () => {
    expect(pinnedVersion(1, 1)).toBeUndefined(); // the newest: follows the newest
    expect(pinnedVersion(1, undefined)).toBeUndefined(); // newest not known (yet): follows the newest
    expect(pinnedVersion(undefined, 3)).toBeUndefined();
    expect(pinnedVersion(1, 2)).toBe(1);
  });

  it("an old split-panel link goes to the artifact page", () => {
    expect(legacyPanelTarget("?artifact=a1")).toBe("/a/a1");
    expect(legacyPanelTarget("?artifact=a1&v=2")).toBe("/a/a1?v=2");
    expect(legacyPanelTarget("?artifact=a1&v=x")).toBe("/a/a1");
    expect(legacyPanelTarget("?v=2")).toBeUndefined();
    expect(legacyPanelTarget("")).toBeUndefined();
  });

  it("only a conversation or a shared view counts as where it was opened from", () => {
    expect(fromOf({ from: "/c/abc" })).toBe("/c/abc");
    expect(fromOf({ from: "/shared/s1" })).toBe("/shared/s1");
    for (const bad of ["//evil.example/c/x", "https://evil.example/", "/c/x/../../admin", "/settings", "/c/"])
      expect(fromOf({ from: bad })).toBeUndefined();
    expect(fromOf(null)).toBeUndefined();
    expect(fromOf({ from: 1 })).toBeUndefined();
  });
});

describe("code artifacts as one fenced block (review #175)", () => {
  it("the fence is longer than any backtick run, at least three", () => {
    expect(fenceFor("print(1)")).toBe("```");
    expect(fenceFor("a ```` b ` c")).toBe("`````");
    expect(fenced("x", "python")).toBe("```python\nx\n```");
  });

  it("a very large text with many backtick runs does not throw (no spread of every run into one call)", () => {
    const content = "` ".repeat(200_000); // 400,000 bytes: within the artifact limit
    expect(fenceFor(content)).toBe("```");
    const many = "`".repeat(5000) + "x";
    expect(fenceFor(many)).toHaveLength(5001);
    const text = fenced(content, "");
    expect(text.startsWith("```\n")).toBe(true);
    // One block for the renderer: the fence holds the whole text.
    expect(splitBlocks(text)).toHaveLength(1);
  });

  it("the page renders such a code artifact", () => {
    const content = "` ".repeat(200_000);
    const qc = new QueryClient();
    qc.setQueryData([...artifactKey("c1"), "v", 1], { version: 1, kind: "code", content });
    const html = render(
      {
        data: {
          id: "c1",
          conversationId: "c",
          messageId: null,
          runId: null,
          kind: "code",
          title: "코드",
          language: null,
          latestVersion: 1,
          createdAt: 1,
          updatedAt: 1,
          versions: [
            {
              version: 1,
              contentHash: "h",
              bytes: 400_000,
              title: "코드",
              language: null,
              runId: null,
              revertedFrom: null,
              createdAt: 1,
            },
          ],
        },
        version: 1,
        title: "코드",
        owner: true,
        revert: { isPending: false, isError: false },
      } as never,
      qc,
    );
    expect(html).toContain('data-kind="code"');
  });
});

describe("what a run left behind while the chat was not on screen (review #175)", () => {
  afterEach(() => clearAfter());
  const note = (message: string) => ({ notices: [{ level: "info" as const, code: "x", message }] });

  it("is kept per conversation and message, and taken once by the chat screen", () => {
    keepAfter("conv-a", "m1", note("알림"));
    keepAfter("conv-a", "m2", { notices: [], error: { code: "e", message: "오류" } });
    const got = takeAfter("conv-a");
    expect(Object.keys(got)).toEqual(["m1", "m2"]);
    expect(got.m2?.error?.code).toBe("e");
    expect(takeAfter("conv-a")).toEqual({}); // consumed (also how a deleted conversation's entry goes)
    expect(takeAfter("conv-b")).toEqual({});
  });

  it("an expired notice does not come back with a newer one of the same conversation", () => {
    keepAfter("conv-t", "old", note("old"), 0);
    keepAfter("conv-t", "new", note("new"), AFTER_RUN_LIMITS.ttlMs + 1);
    expect(Object.keys(takeAfter("conv-t", AFTER_RUN_LIMITS.ttlMs + 2))).toEqual(["new"]);
    // Each message by its own time: one still fresh stays while an older one in the same conversation expires.
    keepAfter("conv-u", "a", note("a"), 0);
    keepAfter("conv-u", "b", note("b"), AFTER_RUN_LIMITS.ttlMs / 2);
    expect(Object.keys(takeAfter("conv-u", AFTER_RUN_LIMITS.ttlMs + 1))).toEqual(["b"]);
  });

  it("is bounded: the oldest conversations go past the cap, entries expire, sign-out empties it", () => {
    for (let i = 0; i < AFTER_RUN_LIMITS.conversations + 5; i++)
      keepAfter(`c${i}`, "m", note(`${i}`), 1000 + i);
    expect(afterSize()).toBe(AFTER_RUN_LIMITS.conversations);
    expect(takeAfter("c0", 2000)).toEqual({});
    expect(takeAfter(`c${AFTER_RUN_LIMITS.conversations + 4}`, 2000).m).toBeDefined();
    keepAfter("old", "m", note("old"), 0);
    expect(takeAfter("old", AFTER_RUN_LIMITS.ttlMs + 1)).toEqual({});
    keepAfter("x", "m", note("x"));
    clearAfter();
    expect(afterSize()).toBe(0);
  });
});

describe("a lost run stream on the artifact page recovers (review #175 2·3·4차)", () => {
  afterEach(() => vi.useRealTimers());
  const run = (id: string, endedAt: number | null) => ({ id, endedAt }) as never;
  /** A page whose visibility the test sets. */
  const visibility = () => {
    const listeners = new Set<() => void>();
    return {
      hidden: false,
      addEventListener: (_: string, f: () => void) => void listeners.add(f),
      removeEventListener: (_: string, f: () => void) => void listeners.delete(f),
      show(this: { hidden: boolean }) {
        this.hidden = false;
        for (const f of [...listeners]) f();
      },
      listeners,
    };
  };
  const base = (over: Partial<Parameters<typeof recoverLost>[0]> = {}) => {
    const o = {
      runId: "r1",
      read: vi.fn().mockResolvedValue(run("r1", null)),
      reconnect: vi.fn(),
      ended: vi.fn(),
      gone: vi.fn(),
      everyMs: 1000,
      maxMs: 4000,
      doc: undefined,
      ...over,
    };
    return { o, stop: recoverLost(o) };
  };

  it("still running: subscribes again; a failed read is tried again later (backing off)", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(run("r1", null));
    const { o, stop } = base({ read });
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999); // after one failure: 2 s
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(o.reconnect).toHaveBeenCalledTimes(1);
    expect(o.ended).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(read).toHaveBeenCalledTimes(2); // done: no more reads
    stop();
  });

  it("ended, none or another run: hands over to the final refresh, which lives on after the recovery stops", async () => {
    vi.useFakeTimers();
    for (const answer of [run("r1", 5), null, run("r2", null)]) {
      const { o } = base({ read: vi.fn().mockResolvedValue(answer) });
      await vi.advanceTimersByTimeAsync(1000);
      expect(o.ended).toHaveBeenCalledTimes(1);
      expect(o.reconnect).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(o.read).toHaveBeenCalledTimes(1);
    }
    // Review #175 4차, the exact sequence: the run is confirmed ended; the final refresh's active-run read succeeds
    // (null — the end shows, `lostRun` goes and the recovery is stopped) but the artifact read fails (500). The
    // final refresh (`settle`, owned by the page) still goes on until it succeeds.
    let settleStop: (() => void) | undefined;
    const refresh = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(500, "server"))
      .mockRejectedValueOnce(new ApiError(500, "server"))
      .mockResolvedValue(undefined);
    const ended = vi.fn(() => {
      settleStop = retryUntil(refresh, { firstMs: 0, everyMs: 1000, maxMs: 4000, doc: undefined });
    });
    const recoveryStop = base({ read: vi.fn().mockResolvedValue(null), ended }).stop;
    await vi.advanceTimersByTimeAsync(1000);
    expect(ended).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // the final refresh starts at once (a 0 ms timer)
    expect(refresh).toHaveBeenCalledTimes(1); // failed
    recoveryStop(); // the end showed: the recovery effect is cleaned up
    await vi.advanceTimersByTimeAsync(2000);
    expect(refresh).toHaveBeenCalledTimes(2); // failed again, still retrying
    await vi.advanceTimersByTimeAsync(4000);
    expect(refresh).toHaveBeenCalledTimes(3); // succeeded
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(3);
    settleStop?.();
  });

  it("stopped while the read is in flight: the read is aborted and neither reconnect nor the refresh follows", async () => {
    vi.useFakeTimers();
    for (const answer of [run("r1", null), null]) {
      let signal: AbortSignal | undefined;
      let answerRead: (r: unknown) => void = () => {};
      const read = vi.fn(
        (s: AbortSignal) =>
          new Promise((resolve) => {
            signal = s;
            answerRead = resolve; // a read that answers even after the abort (as a cached or late response could)
          }),
      );
      const { o, stop } = base({ read: read as never });
      await vi.advanceTimersByTimeAsync(1000);
      expect(read).toHaveBeenCalledTimes(1);
      stop();
      expect(signal?.aborted).toBe(true);
      answerRead(answer);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(o.reconnect).not.toHaveBeenCalled();
      expect(o.ended).not.toHaveBeenCalled();
      expect(o.gone).not.toHaveBeenCalled();
    }
  });

  it("403/404 (no access, conversation gone): stops at once and forgets", async () => {
    vi.useFakeTimers();
    for (const status of [403, 404]) {
      const { o } = base({ read: vi.fn().mockRejectedValue(new ApiError(status, "x")) });
      await vi.advanceTimersByTimeAsync(1000);
      expect(o.gone).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(o.read).toHaveBeenCalledTimes(1);
      expect(o.ended).not.toHaveBeenCalled();
    }
    // A final refresh failing with 404 ends too.
    const refresh = vi.fn().mockRejectedValue(new ApiError(404, "x"));
    const onGone = vi.fn();
    retryUntil(refresh, { firstMs: 0, everyMs: 1000, doc: undefined, onGone });
    await vi.advanceTimersByTimeAsync(0);
    expect(onGone).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("long transient errors back off to the cap", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValue(new Error("down"));
    const { stop } = base({ read });
    const at: number[] = [];
    read.mockImplementation(() => {
      at.push(Date.now());
      return Promise.reject(new Error("down"));
    });
    const t0 = Date.now();
    await vi.advanceTimersByTimeAsync(1000 + 2000 + 4000 + 4000 + 4000);
    expect(at.map((t) => t - t0)).toEqual([1000, 3000, 7000, 11000, 15000]);
    stop();
  });

  it("nothing is tried while the page is hidden; the due try runs as it shows", async () => {
    vi.useFakeTimers();
    const doc = visibility();
    doc.hidden = true;
    const { o } = base({ doc: doc as unknown as Document });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(o.read).not.toHaveBeenCalled();
    doc.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(o.read).toHaveBeenCalledTimes(1);
    expect(o.reconnect).toHaveBeenCalledTimes(1);
    expect(doc.listeners.size).toBe(0);
  });

  it("stopped (the page left or the stream came back): nothing more happens", async () => {
    vi.useFakeTimers();
    const doc = visibility();
    doc.hidden = true;
    const { o, stop } = base({ doc: doc as unknown as Document });
    await vi.advanceTimersByTimeAsync(1000);
    stop();
    doc.show();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(o.read).not.toHaveBeenCalled();
    expect(doc.listeners.size).toBe(0);
  });

  it("the refresh after a run's end (retryUntil) goes on until it succeeds", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    retryUntil(refresh, { firstMs: 0, everyMs: 1000, doc: undefined });
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(refresh).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe("a card is a link to where it opens (review #175 5차)", () => {
  const detail = (latest: number) => ({
    id: "a1",
    conversationId: "c1",
    messageId: null,
    runId: null,
    kind: "markdown" as const,
    title: "메모",
    language: null,
    latestVersion: latest,
    createdAt: 1,
    updatedAt: 1,
    versions: Array.from({ length: latest }, (_, i) => ({
      version: i + 1,
      contentHash: "h",
      bytes: 1,
      title: "메모",
      language: null,
      runId: null,
      revertedFrom: null,
      createdAt: 1,
    })),
  });
  const card = (version: number | undefined, latest?: number) => {
    const qc = new QueryClient();
    if (latest) qc.setQueryData(artifactKey("a1"), detail(latest));
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(
          MemoryRouter,
          { initialEntries: ["/c/c1"] },
          createElement(ArtifactCard, { id: "a1", version }),
        ),
      ),
    );
  };

  it("an old version pins ?v=; the newest, or one not known yet, follows the newest", () => {
    expect(card(1, 2)).toContain('href="/a/a1?v=1"');
    expect(card(2, 2)).toContain('href="/a/a1"');
    expect(card(undefined, 2)).toContain('href="/a/a1"');
    const loading = card(1);
    expect(loading).toContain('href="/a/a1"');
    expect(loading).toContain('aria-busy="true"'); // a plain click waits for the details (does nothing yet)
    expect(card(1, 2)).not.toContain("aria-busy");
  });
});
