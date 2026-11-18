import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { firstLoadProblems } from "../build/entry-check.js";
import { DiagramFixContext, type DiagramFix } from "../src/chat/diagram-fix.js";
import Markdown from "../src/chat/Markdown.js";
import {
  CONFIG_REFUSED,
  errorText,
  fenceClosed,
  fixRequest,
  FrameHost,
  MAX_FIX_ERROR,
  MAX_SOURCE,
  MAX_SVG,
  mermaidConfig,
  prepareSource,
  renderDiagram,
  RENDER_TIMEOUT_MS,
  setFrameHostForTest,
  svgForImage,
  type FrameEnv,
} from "../src/chat/mermaid.js";
import {
  FRAME_BOOT,
  FRAME_CODE,
  FRAME_READY,
  FRAME_RENDER,
  FRAME_RESULT,
} from "../src/chat/mermaid-config.js";

/**
 * Mermaid diagrams (#182): source cleaning, fence detection, the SVG → image step, the frame host's protocol and
 * its queue with a fake frame (the real frame needs a browser — e2e/mermaid.spec.ts draws real diagrams in it and
 * checks that nothing of mermaid ever enters the app's document), and what the block renders.
 */

afterEach(() => {
  vi.useRealTimers();
  setFrameHostForTest(null);
});

const SVG = (body = "<g/>") =>
  `<svg id="x" width="100%" xmlns="http://www.w3.org/2000/svg" style="max-width: 120.5px;" viewBox="0 0 120.5 80">${body}</svg>`;

type Draw = (text: string, dark: boolean) => Promise<{ svg: string } | { error: string }>;

/**
 * A fake frame: boots, takes the code, answers renders with `draw` (a never-settling promise hangs it). Records the
 * frames made and removed, what was posted into them, and how many drawings ran at once.
 */
function fakeFrames(
  draw: Draw = async () => ({ svg: SVG() }),
  opts: { code?: (signal: AbortSignal) => Promise<string> } = {},
) {
  const frames: { removed: boolean; posts: unknown[]; running: number }[] = [];
  let maxRunning = 0;
  const texts: { text: string; dark: boolean }[] = [];
  const env: FrameEnv = {
    loadCode: opts.code ?? (async () => "/* bundle */"),
    create(onMessage) {
      const f = { removed: false, posts: [] as unknown[], running: 0 };
      frames.push(f);
      const send = (m: unknown) => queueMicrotask(() => !f.removed && onMessage(m));
      send({ type: FRAME_BOOT });
      return {
        post(m) {
          f.posts.push(m);
          const d = m as { type: string; id: number; text: string; dark: boolean; code: string };
          if (d.type === FRAME_CODE) send({ type: FRAME_READY });
          if (d.type === FRAME_RENDER) {
            texts.push({ text: d.text, dark: d.dark });
            f.running++;
            maxRunning = Math.max(
              maxRunning,
              frames.reduce((n, x) => n + (x.removed ? 0 : x.running), 0),
            );
            void draw(d.text, d.dark).then((r) => {
              f.running--;
              send({ type: FRAME_RESULT, id: d.id, ...r });
            });
          }
        },
        remove() {
          f.removed = true;
          f.running = 0;
        },
      };
    },
  };
  const host = new FrameHost(env, { render: RENDER_TIMEOUT_MS, start: 5000 });
  setFrameHostForTest(host);
  return { host, frames, texts, maxRunning: () => maxRunning };
}
const never = () => new Promise<never>(() => {});

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
  // Review #189: mermaid takes any whitespace but a line break around the fences (NBSP, \v, \f, U+2003 …) and
  // runs to the last closing fence.
  it.each([
    ["NBSP after the opening", "---\u00a0\nconfig:\n  fontSize: 777\n---\ngraph TD\nA-->B"],
    ["\\v after the opening", "---\v\nconfig:\n  fontSize: 777\n---\ngraph TD\nA-->B"],
    [
      "NBSP and \\f before the opening",
      "\u00a0\f---\nconfig:\n  fontSize: 777\n\u00a0\f---\ngraph TD\nA-->B",
    ],
    ["an em space after the closing", "---\nconfig:\n  fontSize: 777\n---\u2003\ngraph TD\nA-->B"],
    ["indented fences", "  ---\n  config:\n    fontSize: 777\n  ---\ngraph TD\nA-->B"],
  ])("front matter with odd whitespace (%s) is removed", (_n, src) => {
    const r = prepareSource(src);
    expect(r).toEqual({ ok: true, text: "graph TD\nA-->B" });
  });
  it("front matter runs to the last closing fence, as mermaid reads it: nothing of it is left", () => {
    const r = prepareSource("---\ntitle: a\n---\nconfig:\n  fontSize: 777\n---\ngraph TD\nA-->B");
    expect(r).toEqual({ ok: true, text: "graph TD\nA-->B" });
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

describe("fenceClosed (with the parser's code value)", () => {
  it.each([
    ["```mermaid\ngraph TD\nA-->B\n```", "graph TD\nA-->B", true],
    ["~~~mermaid\ngraph TD\n~~~", "graph TD", true],
    ["````mermaid\ngraph TD\n```\n````", "graph TD\n```", true],
    ["```mermaid\n```", "", true],
    ["```mermaid\ngraph TD\nA-->B", "graph TD\nA-->B", false],
    ["```mermaid\ngraph TD\nA-->B\n``", "graph TD\nA-->B\n``", false],
    ["````mermaid\ngraph TD\n```", "graph TD\n```", false],
    ["```mermaid", "", false],
    ["> ```mermaid\n> graph TD\n> ```", "graph TD", true],
  ])("%j → %s", (md, value, closed) => expect(fenceClosed(md, value)).toBe(closed));
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

describe("FrameHost and the queue", () => {
  it("starts the frame on the first drawing (boot → code → ready), then draws with the prepared text and theme", async () => {
    const f = fakeFrames();
    const r = await renderDiagram("graph TD\nA-->B", true);
    expect(r).toMatchObject({ kind: "ok", width: 121, height: 80 });
    expect(f.frames).toHaveLength(1);
    expect(f.frames[0]!.posts[0]).toEqual({ type: FRAME_CODE, code: "/* bundle */" });
    expect(f.texts).toEqual([{ text: "graph TD\nA-->B", dark: true }]);
    await renderDiagram("graph TD\nC", false);
    expect(f.frames).toHaveLength(1); // the same frame
  });
  it("one drawing at a time, in order; a finished one is not drawn again (cache)", async () => {
    const f = fakeFrames(async () => (await new Promise((r) => setTimeout(r, 5)), { svg: SVG() }));
    const rs = await Promise.all(["a", "b", "c"].map((t) => renderDiagram(`graph TD\n${t}`, false)));
    expect(rs.every((r) => r.kind === "ok")).toBe(true);
    expect(f.maxRunning()).toBe(1);
    expect(f.texts.map((t) => t.text)).toEqual(["graph TD\na", "graph TD\nb", "graph TD\nc"]);
    await renderDiagram("graph TD\na", false);
    expect(f.texts).toHaveLength(3);
    await renderDiagram("graph TD\na", true); // another theme: drawn again
    expect(f.texts).toHaveLength(4);
  });
  it("a syntax error is a result with the frame's message, never a rejection", async () => {
    fakeFrames(async () => ({ error: "Parse error on line 1" }));
    expect(await renderDiagram("graph TD\nA-->", false)).toEqual({
      kind: "error",
      message: "Parse error on line 1",
    });
  });
  it("the frame's refusal of a config it still found is an error the fix button can use", async () => {
    fakeFrames(async () => ({ error: CONFIG_REFUSED }));
    expect(await renderDiagram("graph TD\nA", false)).toEqual({ kind: "error", message: CONFIG_REFUSED });
  });
  it("a too-large SVG is refused; an answer that is not a sized SVG is an error", async () => {
    fakeFrames(async () => ({ svg: SVG("x".repeat(MAX_SVG)) }));
    expect(await renderDiagram("graph TD\nA", false)).toMatchObject({ kind: "too-big" });
    fakeFrames(async () => ({ svg: "<div>no</div>" }));
    expect(await renderDiagram("graph TD\nB", false)).toMatchObject({ kind: "error" });
  });
  it("a drawing that hangs times out: its frame is taken down (the work stops), the next drawing gets a new frame", async () => {
    vi.useFakeTimers();
    let n = 0;
    const f = fakeFrames(() => (n++ === 0 ? never() : Promise.resolve({ svg: SVG() })));
    const first = renderDiagram("graph TD\nslow", false);
    const second = renderDiagram("graph TD\nnext", false);
    await vi.advanceTimersByTimeAsync(RENDER_TIMEOUT_MS + 1);
    expect(await first).toEqual({ kind: "timeout" });
    expect(f.frames[0]!.removed).toBe(true);
    expect(await second).toMatchObject({ kind: "ok" });
    expect(f.frames).toHaveLength(2);
    expect(f.frames[1]!.removed).toBe(false);
    expect(f.maxRunning()).toBe(1); // the hung one never ran alongside the next
  });
  it("aborted while it draws (unmount, theme switch): the frame is taken down, the next drawing works", async () => {
    let n = 0;
    const f = fakeFrames(() => (n++ === 0 ? never() : Promise.resolve({ svg: SVG() })));
    const ac = new AbortController();
    const first = renderDiagram("graph TD\nA", false, ac.signal);
    await vi.waitFor(() => expect(f.texts).toHaveLength(1));
    ac.abort();
    expect(await first).toEqual({ kind: "aborted" });
    expect(f.frames[0]!.removed).toBe(true);
    expect(f.host.alive).toBe(false);
    expect(await renderDiagram("graph TD\nA", true)).toMatchObject({ kind: "ok" });
    expect(f.frames).toHaveLength(2);
  });
  it("skips a drawing aborted before its turn — no frame is even made", async () => {
    const f = fakeFrames();
    const ac = new AbortController();
    ac.abort();
    expect(await renderDiagram("graph TD\nA", false, ac.signal)).toEqual({ kind: "aborted" });
    expect(f.frames).toHaveLength(0);
  });
  it("a bundle that cannot be fetched is a result; the next drawing tries again", async () => {
    let loads = 0;
    const f = fakeFrames(undefined, {
      code: async () => {
        if (loads++ === 0) throw new Error("offline");
        return "/* bundle */";
      },
    });
    expect(await renderDiagram("graph TD\nA", false)).toEqual({ kind: "load-failed" });
    expect(f.frames[0]!.removed).toBe(true);
    expect(await renderDiagram("graph TD\nA", false)).toMatchObject({ kind: "ok" });
  });
  // Review #189 2차: a bundle fetch that hangs is dropped (aborted) with the start it served; the next start
  // fetches afresh, and the stale fetch answering late changes nothing.
  it("a hanging bundle fetch is aborted on the start timeout; the next drawing fetches again; a late answer is ignored", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    let releaseStale: (code: string) => void = () => {};
    const f = fakeFrames(undefined, {
      code: (signal) => {
        signals.push(signal);
        if (signals.length === 1) return new Promise<string>((resolve) => (releaseStale = resolve));
        return Promise.resolve("/* fresh */");
      },
    });
    const first = renderDiagram("graph TD\nA", false);
    await vi.advanceTimersByTimeAsync(5001); // the start limit of fakeFrames
    expect(await first).toEqual({ kind: "load-failed" });
    expect(signals[0]!.aborted).toBe(true);
    expect(f.frames[0]!.removed).toBe(true);
    expect(await renderDiagram("graph TD\nB", false)).toMatchObject({ kind: "ok" });
    expect(signals).toHaveLength(2);
    expect(f.frames[1]!.posts[0]).toEqual({ type: FRAME_CODE, code: "/* fresh */" });
    // The stale fetch answers now: the kept bundle stays the fresh one, the live frame is untouched.
    releaseStale("/* stale */");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.frames[1]!.posts.filter((p) => (p as { type: string }).type === FRAME_CODE)).toHaveLength(1);
    // A later frame (after a timeout took this one down) gets the kept fresh bundle, without fetching again.
    f.host.destroy();
    expect(await renderDiagram("graph TD\nC", false)).toMatchObject({ kind: "ok" });
    expect(f.frames[2]!.posts[0]).toEqual({ type: FRAME_CODE, code: "/* fresh */" });
    expect(signals).toHaveLength(2);
  });
  it("a frame that never gets ready ends in load-failed after the start limit, and is taken down", async () => {
    vi.useFakeTimers();
    const frames: { removed: boolean }[] = [];
    const host = new FrameHost(
      {
        loadCode: async () => "",
        create: () => {
          const f = { removed: false };
          frames.push(f);
          return { post: () => {}, remove: () => void (f.removed = true) };
        },
      },
      { render: 1000, start: 2000 },
    );
    setFrameHostForTest(host);
    const r = renderDiagram("graph TD\nA", false);
    await vi.advanceTimersByTimeAsync(2001);
    expect(await r).toEqual({ kind: "load-failed" });
    expect(frames[0]!.removed).toBe(true);
  });
  it("ignores answers for unknown ids and malformed messages", async () => {
    let onMessage: (d: unknown) => void = () => {};
    const host = new FrameHost(
      {
        loadCode: async () => "",
        create: (m) => {
          onMessage = m;
          queueMicrotask(() => m({ type: FRAME_BOOT }));
          return {
            post: (msg) => {
              const d = msg as { type: string; id: number };
              if (d.type === FRAME_CODE) queueMicrotask(() => onMessage({ type: FRAME_READY }));
              if (d.type === FRAME_RENDER)
                queueMicrotask(() => {
                  onMessage(null);
                  onMessage("x");
                  onMessage({ type: FRAME_RESULT, id: d.id + 99, svg: SVG() });
                  onMessage({ type: FRAME_RESULT, id: String(d.id), svg: SVG() });
                  onMessage({ type: FRAME_RESULT, id: d.id, svg: 42 });
                  onMessage({ type: FRAME_RESULT, id: d.id, error: "real" });
                });
            },
            remove: () => {},
          };
        },
      },
      { render: 1000, start: 1000 },
    );
    expect(await host.render("graph TD\nA", false)).toEqual({ kind: "error", message: "real" });
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
  // Review #189: lines that look like a closing fence but are code content to the parser.
  it.each([
    ["indented four spaces", "```mermaid\ngraph TD\n  A-->B\n    ```"],
    ["in a block quote marker at top level", "```mermaid\ngraph TD\n  A-->B\n> ```"],
    ["shorter than the opening", "````mermaid\ngraph TD\n  A-->B\n```"],
    ["unfinished, blank lines after", "```mermaid\ngraph TD\n  A-->B\n\n"],
  ])("a fence-looking last line that is code (%s) keeps it unfinished", (_n, md) => {
    expect(render(md)).toContain('data-state="source"');
  });
  it.each([
    ["at the top", "```mermaid\ngraph TD\n  A-->B\n```"],
    ["indented up to three spaces", "```mermaid\ngraph TD\n  A-->B\n   ```"],
    ["in a block quote", "> ```mermaid\n> graph TD\n> ```"],
    ["in a list item", "- 목록\n\n  ```mermaid\n  graph TD\n  ```"],
    ["with blank lines after", "```mermaid\ngraph TD\n```\n\n"],
  ])("a real closing fence (%s) finishes the block", (_n, md) => {
    expect(render(md)).toContain('data-state="pending"');
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
    fakeFrames(async () => ({ svg: hostile }));
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
    fakeFrames(async () => ({ error: "Parse error on line 2" }));
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
