import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PanelBody } from "../src/artifacts/ArtifactPanel.js";
import { ARTIFACT_REDACTED_NOTICE } from "@agentlee/shared";
import { ApiError } from "../src/api.js";
import { artifactErrorText, type ArtifactViewer } from "../src/artifacts/viewer.js";

const viewer = (v: Partial<ArtifactViewer>) =>
  ({ revoked: false, data: undefined, error: null, ...v }) as ArtifactViewer;
const render = (v: Partial<ArtifactViewer>) =>
  renderToStaticMarkup(createElement(PanelBody, { v: viewer(v) }));

describe("the artifact panel body (#29, review #117)", () => {
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
