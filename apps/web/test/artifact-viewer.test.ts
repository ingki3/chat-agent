import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { ARTIFACT_REDACTED_NOTICE } from "@agentlee/shared";
import { ApiError } from "../src/api.js";
import { ViewerBody, artifactErrorText, artifactKey, type ArtifactViewer } from "../src/artifacts/viewer.js";
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
