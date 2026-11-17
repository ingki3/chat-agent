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
import { recoverLost } from "../src/artifacts/follow-run.js";
import { artifactLink, fromOf, legacyPanelTarget } from "../src/artifacts/ArtifactCard.js";

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

describe("a lost run stream on the artifact page recovers (review #175 2차)", () => {
  afterEach(() => vi.useRealTimers());
  const run = (id: string, endedAt: number | null) => ({ id, endedAt }) as never;

  it("still running: subscribes again; a failed read waits for the next tick", async () => {
    vi.useFakeTimers();
    const reconnect = vi.fn();
    const ended = vi.fn();
    const read = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(run("r1", null));
    const stop = recoverLost({ runId: "r1", read, reconnect, ended, everyMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(reconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(ended).not.toHaveBeenCalled();
    // Done: no more reads.
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).toHaveBeenCalledTimes(2);
    stop();
  });

  it("ended, gone or another run: refresh what it changed", async () => {
    vi.useFakeTimers();
    for (const answer of [run("r1", 5), null, run("r2", null)]) {
      const reconnect = vi.fn();
      const ended = vi.fn();
      recoverLost({ runId: "r1", read: async () => answer, reconnect, ended, everyMs: 1000 });
      await vi.advanceTimersByTimeAsync(1000);
      expect(ended).toHaveBeenCalledTimes(1);
      expect(reconnect).not.toHaveBeenCalled();
    }
  });

  it("stopped (the page left or the stream came back): nothing more happens", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue(run("r1", null));
    const reconnect = vi.fn();
    const stop = recoverLost({ runId: "r1", read, reconnect, ended: vi.fn(), everyMs: 1000 });
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(read).not.toHaveBeenCalled();
    expect(reconnect).not.toHaveBeenCalled();
  });
});
