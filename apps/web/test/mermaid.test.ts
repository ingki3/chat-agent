import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { firstLoadProblems } from "../build/entry-check.js";
import { DiagramFixContext, type DiagramFix } from "../src/chat/diagram-fix.js";
import Markdown from "../src/chat/Markdown.js";
import {
  errorText,
  fenceClosed,
  fixRequest,
  MAX_FIX_ERROR,
  MAX_SOURCE,
  MAX_SVG,
  mermaidConfig,
  prepareSource,
  renderDiagram,
  RENDER_TIMEOUT_MS,
  setMermaidLoaderForTest,
  svgForImage,
  type MermaidApi,
} from "../src/chat/mermaid.js";

/**
 * Mermaid diagrams (#182): source cleaning, fence detection, the SVG → image step, the render queue with a fake
 * mermaid (the real one needs a browser — e2e/mermaid.spec.ts draws real diagrams), and what the block renders.
 */

// The render queue makes an offscreen element: a minimal document is enough here (no DOM in these tests).
const hosts: { removed: boolean }[] = [];
beforeEach(() => {
  hosts.length = 0;
  vi.stubGlobal("document", {
    createElement: () => {
      const h = { removed: false, style: {}, setAttribute() {}, remove: () => (h.removed = true) };
      hosts.push(h);
      return h;
    },
    body: { append() {} },
    getElementById: () => null,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setMermaidLoaderForTest(null);
});

const SVG = (body = "<g/>") =>
  `<svg id="x" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 120.5px;" viewBox="0 0 120.5 80">${body}</svg>`;

/** A fake mermaid: records calls, at most one drawing at a time is checked. */
function fake(opts: { svg?: string; fail?: unknown; hang?: boolean; delayMs?: number } = {}) {
  const calls: { text: string; config: Record<string, unknown> }[] = [];
  let config: Record<string, unknown> = {};
  let active = 0;
  let maxActive = 0;
  const api: MermaidApi = {
    initialize: (c) => void (config = c),
    render: async (_id, text) => {
      calls.push({ text, config });
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        if (opts.hang) await new Promise(() => {});
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        if (opts.fail !== undefined) throw opts.fail;
        return { svg: opts.svg ?? SVG() };
      } finally {
        active--;
      }
    },
  };
  return { api, calls, maxActive: () => maxActive };
}

describe("prepareSource", () => {
  it("removes %%{init}%% directives, closed or not, anywhere", () => {
    const src =
      '%%{init: {"securityLevel": "loose", "theme": "forest"}}%%\ngraph TD\n  A-->B %%{ wrap }%%\n%%{init: {"x":1}';
    expect(prepareSource(src)).toEqual({ ok: true, text: "graph TD\n  A-->B" });
  });
  it("removes a directive spanning lines and one formed by joining the pieces left behind", () => {
    expect(prepareSource('%%{\ninit: {"theme":"dark"}\n}%%\ngraph LR\nA-->B')).toEqual({
      ok: true,
      text: "graph LR\nA-->B",
    });
    const joined = prepareSource('%%%%{x}%%{init: {"securityLevel":"loose"}}%%\ngraph TD\nA-->B');
    expect(joined.ok && joined.text).not.toContain("%%{");
    expect(joined.ok && joined.text).not.toContain("securityLevel");
  });
  it("removes leading --- front matter (config, theme) — also after blank lines and with CRLF", () => {
    const src =
      "\n---\ntitle: t\nconfig:\n  securityLevel: loose\n  theme: forest\n---\nflowchart LR\n  A --> B";
    expect(prepareSource(src)).toEqual({ ok: true, text: "flowchart LR\n  A --> B" });
    expect(prepareSource('---\r\nconfig:\r\n  theme: dark\r\n---\r\npie\r\n  "a": 1')).toEqual({
      ok: true,
      text: 'pie\n  "a": 1',
    });
  });
  it("keeps --- inside the diagram (not front matter)", () => {
    expect(prepareSource("graph TD\nA---B")).toEqual({ ok: true, text: "graph TD\nA---B" });
  });
  it("refuses a source over the limit", () => {
    expect(prepareSource("x".repeat(MAX_SOURCE))).toMatchObject({ ok: true });
    expect(prepareSource("x".repeat(MAX_SOURCE + 1))).toEqual({
      ok: false,
      reason: "too-long",
      length: MAX_SOURCE + 1,
    });
  });
});

describe("fenceClosed", () => {
  it.each([
    ["```mermaid\ngraph TD\nA-->B\n```", true],
    ["~~~mermaid\ngraph TD\n~~~", true],
    ["````mermaid\ngraph TD\n```\n````", true],
    ["```mermaid\ngraph TD\nA-->B", false],
    ["```mermaid\ngraph TD\nA-->B\n``", false],
    ["````mermaid\ngraph TD\n```", false],
    ["```mermaid", false],
    ["> ```mermaid\n> graph TD\n> ```", true],
    ["", false],
  ])("%j → %s", (md, closed) => expect(fenceClosed(md)).toBe(closed));
});

describe("svgForImage", () => {
  it("gives the SVG a fixed size from its viewBox and drops width=100% and the max-width style", () => {
    const r = svgForImage(SVG())!;
    expect(r.width).toBe(121);
    expect(r.height).toBe(80);
    expect(r.svg).toMatch(
      /^<svg width="121" height="80" id="x" xmlns="http:\/\/www.w3.org\/2000\/svg" viewBox=/,
    );
    expect(r.svg).not.toContain("100%");
    expect(r.svg).not.toContain("max-width");
  });
  it("adds the SVG namespace when missing; refuses something that is not a sized SVG", () => {
    expect(svgForImage('<svg viewBox="0 0 10 10"></svg>')!.svg).toContain(
      'xmlns="http://www.w3.org/2000/svg"',
    );
    expect(svgForImage("<div>no</div>")).toBeNull();
    expect(svgForImage('<svg viewBox="0 0 0 0"></svg>')).toBeNull();
  });
});

describe("fix request", () => {
  it("carries the error and the source, asking for a fixed diagram", () => {
    const msg = fixRequest("Parse error on line 2:\nExpecting 'SEMI'", "graph TD\n  A-->");
    expect(msg).toContain("다이어그램이 그려지지 않았어요");
    expect(msg).toContain("고친 다이어그램");
    expect(msg).toContain("```text\nParse error on line 2:\nExpecting 'SEMI'\n```");
    expect(msg).toContain("```mermaid\ngraph TD\n  A-->\n```");
  });
  it("cuts a long error; a fence longer than any backticks in the source", () => {
    const msg = fixRequest("e".repeat(2000), 'graph TD\nA["```"]');
    expect(msg).toContain(`${"e".repeat(MAX_FIX_ERROR)}…`);
    expect(msg).not.toContain("e".repeat(MAX_FIX_ERROR + 1));
    expect(msg).toContain('````mermaid\ngraph TD\nA["```"]\n````');
  });
  it("errorText: Error, jison-style objects, strings — cut to the limit", () => {
    expect(errorText(new Error(" bad "))).toBe("bad");
    expect(errorText({ str: "jison" })).toBe("jison");
    expect(errorText("x".repeat(MAX_FIX_ERROR + 10))).toHaveLength(MAX_FIX_ERROR + 1);
  });
});

describe("mermaidConfig", () => {
  it("strict, no HTML labels (flowchart too), no start on load, no error diagram; theme by the app", () => {
    for (const dark of [false, true]) {
      const c = mermaidConfig(dark);
      expect(c).toMatchObject({
        startOnLoad: false,
        securityLevel: "strict",
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        suppressErrorRendering: true,
        maxTextSize: MAX_SOURCE,
        theme: dark ? "dark" : "default",
      });
      expect(c.secure).toEqual(expect.arrayContaining(["securityLevel", "htmlLabels", "theme", "secure"]));
      expect(String(c.fontFamily)).toContain("Apple SD Gothic Neo");
    }
  });
});

describe("renderDiagram", () => {
  it("draws with the app's config and gives an image-ready SVG; the offscreen element is removed", async () => {
    const f = fake();
    setMermaidLoaderForTest(async () => f.api);
    const r = await renderDiagram("graph TD\nA-->B", true);
    expect(r).toMatchObject({ kind: "ok", width: 121, height: 80 });
    expect(f.calls[0]!.config).toMatchObject({ securityLevel: "strict", theme: "dark", htmlLabels: false });
    expect(hosts.length).toBe(1);
    expect(hosts.every((h) => h.removed)).toBe(true);
  });
  it("one drawing at a time, in order; a finished one is not drawn again (cache)", async () => {
    const f = fake({ delayMs: 5 });
    setMermaidLoaderForTest(async () => f.api);
    const rs = await Promise.all(["a", "b", "c"].map((t) => renderDiagram(`graph TD\n${t}`, false)));
    expect(rs.every((r) => r.kind === "ok")).toBe(true);
    expect(f.maxActive()).toBe(1);
    expect(f.calls.map((c) => c.text)).toEqual(["graph TD\na", "graph TD\nb", "graph TD\nc"]);
    await renderDiagram("graph TD\na", false);
    expect(f.calls).toHaveLength(3);
    await renderDiagram("graph TD\na", true); // another theme: drawn again
    expect(f.calls).toHaveLength(4);
  });
  it("a syntax error is a result with mermaid's message, never a rejection", async () => {
    setMermaidLoaderForTest(async () => fake({ fail: new Error("Parse error on line 1") }).api);
    expect(await renderDiagram("graph TD\nA-->", false)).toEqual({
      kind: "error",
      message: "Parse error on line 1",
    });
    expect(hosts.every((h) => h.removed)).toBe(true);
  });
  it("a too-large SVG is refused", async () => {
    setMermaidLoaderForTest(async () => fake({ svg: SVG("x".repeat(MAX_SVG)) }).api);
    expect(await renderDiagram("graph TD\nA", false)).toMatchObject({ kind: "too-big" });
  });
  it("a drawing that hangs times out, and the queue goes on", async () => {
    vi.useFakeTimers();
    let n = 0;
    const hang = fake({ hang: true });
    const ok = fake();
    setMermaidLoaderForTest(async () => ({
      initialize: (c) => (n === 0 ? hang : ok).api.initialize(c),
      render: (...a) => (n++ === 0 ? hang : ok).api.render(...a),
    }));
    const first = renderDiagram("graph TD\nslow", false);
    const second = renderDiagram("graph TD\nnext", false);
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS + 1);
    expect(await first).toEqual({ kind: "timeout" });
    expect(await second).toMatchObject({ kind: "ok" });
  });
  it("skips a drawing aborted before its turn; a failed load is a result and is tried again", async () => {
    const ac = new AbortController();
    ac.abort();
    const f = fake();
    let loads = 0;
    setMermaidLoaderForTest(async () => {
      if (loads++ === 0) throw new Error("chunk gone");
      return f.api;
    });
    expect(await renderDiagram("graph TD\nA", false, ac.signal)).toEqual({ kind: "aborted" });
    expect(await renderDiagram("graph TD\nA", false)).toEqual({ kind: "load-failed" });
    expect(await renderDiagram("graph TD\nA", false)).toMatchObject({ kind: "ok" });
  });
});

describe("Markdown mermaid blocks", () => {
  const render = (text: string, fix?: DiagramFix) =>
    renderToStaticMarkup(
      fix
        ? createElement(DiagramFixContext.Provider, { value: fix }, createElement(Markdown, { text }))
        : createElement(Markdown, { text }),
    );

  it("an unfinished block (still streaming) is a plain code block", () => {
    const html = render("앞\n\n```mermaid\ngraph TD\n  A-->B");
    expect(html).toContain('data-state="source"');
    expect(html).not.toContain("<img");
    expect(html).toContain("graph TD");
  });
  it("a finished block waits for its drawing with the code shown", () => {
    const html = render("```mermaid\ngraph TD\n  A-->B\n```");
    expect(html).toContain('data-testid="mermaid"');
    expect(html).toContain('data-state="pending"');
    expect(html).toContain("그리는 중");
  });
  it("other languages are untouched", () => {
    expect(render("```js\nlet a\n```")).not.toContain('data-testid="mermaid"');
  });

  it.each([
    ["click A call alert()", "graph TD\n  A-->B\n  click A call alert()"],
    ["<img onerror> label", 'graph TD\n  A["<img src=x onerror=alert(1)>"]-->B'],
    ["javascript: link", 'graph TD\n  A-->B\n  click A "javascript:alert(1)"'],
  ])("hostile input (%s): exactly one img of a blob URL, nothing of the SVG in the page", async (_n, src) => {
    // Even if mermaid let it all through, the SVG only ever becomes an image's blob.
    const hostile = SVG(
      `<script>alert(1)</script><a href="javascript:alert(1)"><text>x</text></a><image href="x" onerror="alert(1)"/><foreignObject><img src=x onerror=alert(1)></foreignObject>`,
    );
    setMermaidLoaderForTest(async () => fake({ svg: hostile }).api);
    const prepared = prepareSource(src);
    expect(prepared.ok).toBe(true);
    await renderDiagram(prepared.ok ? prepared.text : "", false);
    const html = render(`\`\`\`mermaid\n${src}\n\`\`\``);
    expect(html).toContain('data-state="diagram"');
    expect(html.match(/<img\b/g)).toHaveLength(1);
    expect(html).toMatch(/<img src="blob:[^"]+" alt="다이어그램"/);
    expect(html).not.toMatch(/<svg|<script|onerror=|<foreignObject/i);
    expect(html).not.toContain('href="javascript:');
  });

  it("a syntax error: the code, the notice and 다이어그램 고치기 (only in a conversation, off while a run goes on)", async () => {
    setMermaidLoaderForTest(async () => fake({ fail: new Error("Parse error on line 2") }).api);
    const src = "graph TD\n  A-->";
    await renderDiagram(src, false);
    const md = `\`\`\`mermaid\n${src}\n\`\`\``;
    const free = render(md, { send: () => {} });
    expect(free).toContain('data-state="error"');
    expect(free).toContain("다이어그램을 그릴 수 없습니다");
    expect(free).toContain("Parse error on line 2");
    expect(free).toContain("A--&gt;"); // the code stays
    expect(free).toMatch(/<button type="button" class="small" data-testid="mermaid-fix">다이어그램 고치기/);
    expect(render(md, { send: null })).toMatch(/data-testid="mermaid-fix" disabled=""/);
    expect(render(md)).not.toContain("mermaid-fix"); // the artifact page: no conversation to send to
  });

  it("a source over the limit stays code with a notice, never drawn", () => {
    const html = render(`\`\`\`mermaid\ngraph TD\n${"A-->B\n".repeat(MAX_SOURCE / 6 + 10)}\`\`\``);
    expect(html).toContain('data-state="limit"');
    expect(html).toContain("너무 길어");
    expect(html).not.toContain("<img");
  });
});

describe("first-load build check", () => {
  const nm = (p: string) => `/repo/node_modules/.pnpm/${p}@1.0.0/node_modules/${p}/dist/x.mjs`;
  it("finds mermaid in the entry or a chunk it imports statically; a lazy chunk is fine", () => {
    const lazyOk = [
      { fileName: "index.js", isEntry: true, imports: ["vendor.js"], moduleIds: ["/repo/src/main.tsx"] },
      { fileName: "vendor.js", isEntry: false, imports: [], moduleIds: [nm("react")] },
      { fileName: "mermaid.core.js", isEntry: false, imports: [], moduleIds: [nm("mermaid")] },
    ];
    expect(firstLoadProblems(lazyOk)).toEqual([]);
    const pulled = lazyOk.map((c) =>
      c.fileName === "vendor.js" ? { ...c, moduleIds: [...c.moduleIds, nm("mermaid")] } : c,
    );
    expect(firstLoadProblems(pulled)).toEqual([`vendor.js: ${nm("mermaid")}`]);
    // A package whose name only starts with "mermaid" is not mermaid.
    expect(
      firstLoadProblems([{ fileName: "i.js", isEntry: true, imports: [], moduleIds: [nm("mermaid-like")] }]),
    ).toEqual([]);
  });
});
