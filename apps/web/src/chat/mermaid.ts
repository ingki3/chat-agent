import {
  FRAME_BOOT,
  FRAME_CODE,
  FRAME_READY,
  FRAME_RENDER,
  FRAME_RESULT,
  MAX_FIX_ERROR,
  MAX_SOURCE,
  MAX_SVG,
  type FrameRender,
} from "./mermaid-config.js";

export {
  CONFIG_REFUSED,
  DIAGRAM_FONT,
  errorText,
  MAX_FIX_ERROR,
  MAX_SOURCE,
  MAX_SVG,
  mermaidConfig,
  prepareSource,
  type Prepared,
} from "./mermaid-config.js";

/**
 * Mermaid diagrams in answers and artifact pages (#182). Model output is untrusted, so mermaid never runs in the
 * app's document:
 *
 * - it runs in a **diagram frame**: `<iframe sandbox="allow-scripts" src="/mermaid-frame">` — an opaque origin
 *   (no cookies, storage or DOM of the app), served with its own CSP (no network at all: `connect-src`,
 *   `img-src` data/blob only, `font-src 'none'`, no frames, no forms). The app fetches the frame bundle itself
 *   (same origin, its cookies and service worker) and posts it in; the frame runs it as a blob script. Measuring
 *   and drawing happen in the frame's DOM; only the SVG *text* comes back;
 * - the app never puts that SVG into its DOM: it is shown as `<img src="blob:…">` (MermaidBlock);
 * - the source is cleaned before drawing (front matter, `%%{init}%%` directives) and the frame refuses any config
 *   mermaid's own parser still finds; mermaid runs with `securityLevel: "strict"`, no HTML labels;
 * - one drawing at a time, each with a time limit; a drawing that times out or is aborted while it runs takes the
 *   frame down with it (the work stops) and the next one starts a fresh frame.
 */

/** How long one drawing may take. */
export const RENDER_TIMEOUT_MS = 10_000;
/** How long starting the frame (fetching the bundle, running it) may take. */
export const START_TIMEOUT_MS = 30_000;

/**
 * Whether a fenced code block is finished, judged with the markdown parser's own result: `markdown` is the code
 * node's source span (fence lines and any container prefixes included), `value` the code it holds. Without a
 * closing fence the span is the opening line plus the code's lines; with one, one line more. An indented
 * "```" or a "> ```" outside a block quote stays code content, so it never counts as closing.
 */
export function fenceClosed(markdown: string, value: string): boolean {
  const span = markdown.replace(/\n$/, "").split("\n").length;
  const code = value === "" ? 0 : value.split("\n").length;
  return span === code + 2;
}

export type SvgImage = { svg: string; width: number; height: number };

/**
 * mermaid's SVG made fit for an `<img>`: a fixed width and height from its viewBox (mermaid writes
 * `width="100%"` + a max-width style, which an image has no use for) and the SVG namespace.
 */
export function svgForImage(svg: string): SvgImage | null {
  const open = /<svg\b[^>]*>/i.exec(svg);
  if (!open) return null;
  let tag = open[0];
  const vb = /\sviewBox\s*=\s*["']\s*([-\d.e]+)[\s,]+([-\d.e]+)[\s,]+([\d.e]+)[\s,]+([\d.e]+)\s*["']/i.exec(
    tag,
  );
  const w = vb ? Math.ceil(Number(vb[3])) : 0;
  const h = vb ? Math.ceil(Number(vb[4])) : 0;
  if (!(w > 0 && h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
  tag = tag.replace(/\s(?:width|height|style)\s*=\s*("[^"]*"|'[^']*')/gi, "");
  if (!/\sxmlns\s*=/.test(tag)) tag = tag.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  tag = tag.replace(/^<svg\b/i, `<svg width="${w}" height="${h}"`);
  return {
    svg: svg.slice(0, open.index) + tag + svg.slice(open.index + open[0].length),
    width: w,
    height: h,
  };
}

/** The longest run of backticks in `s` (a fence around it must be longer). */
function longestTicks(s: string): number {
  let best = 0;
  for (const m of s.matchAll(/`+/g)) best = Math.max(best, m[0].length);
  return best;
}

/** The follow-up message of "다이어그램 고치기": the real error (cut) and the source, asking for a fixed diagram. */
export function fixRequest(error: string, source: string): string {
  const err = error.length > MAX_FIX_ERROR ? `${error.slice(0, MAX_FIX_ERROR)}…` : error;
  const fence = "`".repeat(Math.max(3, longestTicks(source) + 1));
  const errFence = "`".repeat(Math.max(3, longestTicks(err) + 1));
  return [
    "아래 mermaid 다이어그램이 그려지지 않았어요. 오류를 보고 문법을 고친 다이어그램을 다시 보여 주세요.",
    "",
    "오류:",
    `${errFence}text`,
    err,
    errFence,
    "",
    "원본:",
    `${fence}mermaid`,
    source,
    fence,
  ].join("\n");
}

export type RenderResult =
  | ({ kind: "ok" } & SvgImage)
  | { kind: "error"; message: string }
  | { kind: "too-big"; size: number }
  | { kind: "timeout" }
  | { kind: "load-failed" }
  | { kind: "aborted" };

// ---- the diagram frame ----

/** One frame as the host sees it (a real iframe in the app, a fake in unit tests). */
export type FrameHandle = {
  /** Sends a message into the frame. */
  post: (message: unknown) => void;
  /** Takes the frame out of the page: whatever runs in it stops. */
  remove: () => void;
};
export type FrameEnv = {
  /** Makes a frame; `onMessage` gets the data of messages that really come from it. */
  create: (onMessage: (data: unknown) => void) => FrameHandle;
  /** The frame bundle's code (fetched by the app). */
  loadCode: () => Promise<string>;
};

type Pending = (r: RenderResult) => void;

/** Draws in the diagram frame: starts it when needed, one drawing at a time, takes it down on a timeout or abort. */
export class FrameHost {
  private frame: FrameHandle | null = null;
  private started: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private code: Promise<string> | null = null;
  /** Ends a start still in progress (the frame was taken down meanwhile). */
  private abortStart: ((e: unknown) => void) | null = null;
  /** Frames made so far (tests). */
  created = 0;

  constructor(
    private readonly env: FrameEnv,
    private readonly timeouts = { render: RENDER_TIMEOUT_MS, start: START_TIMEOUT_MS },
  ) {}

  private loadCode(): Promise<string> {
    if (!this.code)
      this.code = this.env.loadCode().catch((e: unknown) => ((this.code = null), Promise.reject(e)));
    return this.code;
  }

  private start(): Promise<void> {
    if (this.started) return this.started;
    const started = new Promise<void>((resolve, reject) => {
      const fail = (e: unknown) => {
        clearTimeout(timer);
        if (this.started === started) this.destroy();
        reject(e);
      };
      this.abortStart = (e) => {
        clearTimeout(timer);
        reject(e);
      };
      const timer = setTimeout(() => fail(new Error("frame_start_timeout")), this.timeouts.start);
      let booted = false;
      this.created++;
      const frame = this.env.create((data) => {
        if (this.frame !== frame || typeof data !== "object" || data === null) return;
        const d = data as { type?: unknown; id?: unknown; svg?: unknown; error?: unknown };
        if (d.type === FRAME_BOOT && !booted) {
          booted = true;
          this.loadCode().then((code) => {
            if (this.frame === frame) frame.post({ type: FRAME_CODE, code });
          }, fail);
        } else if (d.type === FRAME_READY) {
          clearTimeout(timer);
          this.abortStart = null;
          resolve();
        } else if (d.type === FRAME_RESULT && typeof d.id === "number") {
          const done = this.pending.get(d.id);
          if (!done) return;
          if (typeof d.svg === "string") {
            if (d.svg.length > MAX_SVG) return done({ kind: "too-big", size: d.svg.length });
            const img = svgForImage(d.svg);
            done(img ? { kind: "ok", ...img } : { kind: "error", message: "그림을 만들지 못했어요." });
          } else if (typeof d.error === "string") {
            done({ kind: "error", message: d.error.slice(0, MAX_FIX_ERROR + 1) });
          }
        }
      });
      this.frame = frame;
    });
    this.started = started;
    return started;
  }

  /** Takes the frame down; a drawing still waiting on it ends as aborted. */
  destroy() {
    const frame = this.frame;
    this.frame = null;
    this.started = null;
    frame?.remove();
    const abortStart = this.abortStart;
    this.abortStart = null;
    abortStart?.(new Error("frame_gone"));
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const done of waiting) done({ kind: "aborted" });
  }

  /** Whether a frame is up (tests). */
  get alive() {
    return this.frame !== null;
  }

  async render(text: string, dark: boolean, signal?: AbortSignal): Promise<RenderResult> {
    if (signal?.aborted) return { kind: "aborted" };
    if (text.length > MAX_SOURCE) return { kind: "error", message: "too long" };
    // An abort while the frame starts ends this drawing; the frame goes on starting for the next one.
    const aborted = new Promise<"aborted">((resolve) =>
      signal?.addEventListener("abort", () => resolve("aborted"), { once: true }),
    );
    const started = await Promise.race([
      this.start().then(
        () => "ok" as const,
        () => "failed" as const,
      ),
      aborted,
    ]);
    if (started === "failed") return { kind: "load-failed" };
    if (started === "aborted" || signal?.aborted || !this.frame) return { kind: "aborted" };
    const frame = this.frame!;
    const id = ++this.seq;
    return new Promise<RenderResult>((resolve) => {
      const done = (r: RenderResult) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
        resolve(r);
      };
      // Stopping a drawing means stopping the frame: mermaid's work cannot be cancelled otherwise.
      const timer = setTimeout(() => {
        done({ kind: "timeout" });
        this.destroy();
      }, this.timeouts.render);
      const onAbort = () => {
        done({ kind: "aborted" });
        this.destroy();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, done);
      const msg: FrameRender = { type: FRAME_RENDER, id, text, dark };
      frame.post(msg);
    });
  }
}

/** The real frame: a sandboxed iframe off screen (it lays out — mermaid measures text — but is never seen). */
export function iframeEnv(src = "/mermaid-frame"): FrameEnv {
  return {
    create(onMessage) {
      const iframe = document.createElement("iframe");
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.setAttribute("aria-hidden", "true");
      iframe.setAttribute("tabindex", "-1");
      iframe.setAttribute("title", "다이어그램 그리기");
      iframe.dataset.mermaidFrame = "";
      iframe.style.cssText =
        "position:fixed;left:-10000px;top:0;width:1200px;height:800px;border:0;visibility:hidden;pointer-events:none";
      const listen = (e: MessageEvent) => {
        // Only the frame itself (an opaque origin, "null"), never another window or frame of the page.
        if (e.source !== iframe.contentWindow || e.origin !== "null") return;
        onMessage(e.data);
      };
      window.addEventListener("message", listen);
      iframe.src = src;
      document.body.append(iframe);
      return {
        // The frame's origin is opaque, so it cannot be named: "*" (the message holds only the diagram and code).
        post: (m) => iframe.contentWindow?.postMessage(m, "*"),
        remove: () => {
          window.removeEventListener("message", listen);
          iframe.remove();
        },
      };
    },
    loadCode: async () => {
      const { default: url } = await import("./mermaid-frame-url.js");
      const res = await fetch(url, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`frame bundle ${res.status}`);
      return res.text();
    },
  };
}

let host: FrameHost | null = null;
const getHost = () => (host ??= new FrameHost(iframeEnv()));

/** Tests: draw with another host (a fake frame), and start with an empty queue and cache. */
export function setFrameHostForTest(h: FrameHost | null) {
  host?.destroy();
  host = h;
  tail = Promise.resolve();
  cache.clear();
}

/** Results of finished drawings by theme + source, so a remount (the saved reply replacing the live one, a
 * conversation opened again) shows the diagram at once instead of the code first. */
const cache = new Map<string, RenderResult>();
const CACHE_MAX = 64;
export const cacheKey = (text: string, dark: boolean) => `${dark ? "dark" : "light"}\n${text}`;
export function cached(text: string, dark: boolean): RenderResult | undefined {
  return cache.get(cacheKey(text, dark));
}
function remember(key: string, r: RenderResult) {
  cache.delete(key);
  cache.set(key, r);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
}

let tail: Promise<unknown> = Promise.resolve();

/**
 * Draws one diagram (the prepared text) — queued: one drawing at a time. A drawing whose `signal` is aborted
 * before its turn is skipped; aborted while it runs, the frame is taken down. Errors are results, never rejections.
 */
export function renderDiagram(text: string, dark: boolean, signal?: AbortSignal): Promise<RenderResult> {
  const key = cacheKey(text, dark);
  const run = tail.then(async (): Promise<RenderResult> => {
    if (signal?.aborted) return { kind: "aborted" };
    const hit = cache.get(key);
    if (hit) return hit;
    const r = await getHost().render(text, dark, signal);
    if (r.kind === "ok" || r.kind === "error" || r.kind === "too-big") remember(key, r);
    return r;
  });
  tail = run.catch(() => undefined);
  return run;
}
