import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PanelBody } from "../src/artifacts/ArtifactPanel.js";
import type { ArtifactViewer } from "../src/artifacts/viewer.js";

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
