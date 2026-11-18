/**
 * Mermaid diagrams in answers and artifact pages (#182). Model output is untrusted, so:
 *
 * - the source is cleaned before drawing: `%%{init …}%%` directives and a leading `---` config front matter are
 *   removed — theme and security are the app's, never the diagram's;
 * - mermaid runs with `securityLevel: "strict"`, no HTML labels, no start on load, no error diagram in the page;
 * - the SVG it makes never enters the page DOM: it is shown as `<img src="blob:…">` (MermaidBlock), where scripts,
 *   links and event handlers inside it cannot run;
 * - limits: source length, SVG size, one drawing at a time (a queue) and a time limit per drawing.
 *
 * mermaid itself is loaded with `import()` the first time a diagram is drawn: a chunk of its own, never in the
 * app's first load.
 */

/** Longest source drawn (characters); a longer one stays a code block with a notice. */
export const MAX_SOURCE = 20_000;
/** Largest SVG shown (characters); a larger one stays a code block with a notice. */
export const MAX_SVG = 2_000_000;
/** How long one drawing may take. */
export const RENDER_TIMEOUT_MS = 10_000;
/** Error text sent with "다이어그램 고치기" is cut to this. */
export const MAX_FIX_ERROR = 500;

/** Korean-friendly fonts (the system ones — an SVG shown as an image cannot use the page's web fonts). */
export const DIAGRAM_FONT =
  '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", "Noto Sans KR", "Malgun Gothic", sans-serif';

export type Prepared = { ok: true; text: string } | { ok: false; reason: "too-long"; length: number };

/**
 * The source as it is drawn: line endings normalised, every `%%{ … }%%` directive (closed or not — mermaid also
 * reads an unclosed one to the end) and any leading `---` front matter removed. Over the limit: not drawn.
 */
export function prepareSource(source: string): Prepared {
  if (source.length > MAX_SOURCE) return { ok: false, reason: "too-long", length: source.length };
  let t = source.replace(/\r\n?/g, "\n");
  for (;;) {
    const before = t;
    // Front matter (config, theme, title …) at the start, after any blank lines.
    t = t.replace(/^\s*---[ \t]*\n[\s\S]*?\n[ \t]*---[ \t]*(?:\n|$)/, "");
    // Directives: closed ones whole, an unclosed one to the end of its line. Repeated until none is left, so a
    // removal that joins `%%` and `{` into a new one is removed too.
    t = t.replace(/%%\{[\s\S]*?\}%%/g, "").replace(/%%\{[^\n]*/g, "");
    if (t === before) break;
  }
  return { ok: true, text: t.trim() };
}

/** Whether a fenced code block's source (its markdown, fence lines included) has its closing fence yet. */
export function fenceClosed(markdown: string): boolean {
  // Lines of a fence inside a block quote or list carry its markers: judge without them.
  const lines = markdown
    .replace(/\s+$/, "")
    .split("\n")
    .map((l) => l.replace(/^[\s>]*/, ""));
  if (lines.length < 2) return false;
  const open = /^(`{3,}|~{3,})/.exec(lines[0]!)?.[1];
  if (!open) return false;
  const last = lines[lines.length - 1]!.trimEnd();
  return last.length >= open.length && [...last].every((c) => c === open[0]);
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
const longestTicks = (s: string) => Math.max(0, ...(s.match(/`+/g) ?? []).map((m) => m.length));

/** mermaid's error as one short text. */
export function errorText(e: unknown): string {
  const raw =
    e instanceof Error
      ? e.message
      : typeof e === "object" && e && "message" in e
        ? String((e as { message: unknown }).message)
        : typeof e === "object" && e && "str" in e
          ? String((e as { str: unknown }).str)
          : String(e);
  const t = raw.replace(/\r\n?/g, "\n").trim() || "알 수 없는 오류";
  return t.length > MAX_FIX_ERROR ? `${t.slice(0, MAX_FIX_ERROR)}…` : t;
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

/** The part of mermaid this module uses (a fake in unit tests). */
export type MermaidApi = {
  initialize: (config: Record<string, unknown>) => void;
  render: (id: string, text: string, container?: Element) => Promise<{ svg: string }>;
};

/** The config every drawing uses: the app decides theme and security, never the diagram. */
export function mermaidConfig(dark: boolean): Record<string, unknown> {
  return {
    startOnLoad: false,
    securityLevel: "strict",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    suppressErrorRendering: true,
    maxTextSize: MAX_SOURCE,
    maxEdges: 500,
    logLevel: "fatal",
    theme: dark ? "dark" : "default",
    darkMode: dark,
    fontFamily: DIAGRAM_FONT,
    themeVariables: { fontFamily: DIAGRAM_FONT, darkMode: dark },
    // Keys a directive could never change, even if one slipped past prepareSource.
    secure: [
      "secure",
      "securityLevel",
      "startOnLoad",
      "maxTextSize",
      "maxEdges",
      "suppressErrorRendering",
      "htmlLabels",
      "flowchart",
      "theme",
      "themeVariables",
      "themeCSS",
      "darkMode",
      "fontFamily",
      "dompurifyConfig",
    ],
  };
}

const loadMermaid = (): Promise<MermaidApi> =>
  import("mermaid").then((m) => m.default as unknown as MermaidApi);
let loader: () => Promise<MermaidApi> = loadMermaid;
let loaded: Promise<MermaidApi> | null = null;
/** mermaid, loaded once; a failed load is tried again next time. */
function getMermaid(): Promise<MermaidApi> {
  if (!loaded) loaded = loader().catch((e: unknown) => ((loaded = null), Promise.reject(e)));
  return loaded;
}

/** Tests: draw with a fake mermaid, and start with an empty queue and cache. */
export function setMermaidLoaderForTest(l: (() => Promise<MermaidApi>) | null) {
  loader = l ?? loadMermaid;
  loaded = null;
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
let seq = 0;

/**
 * Draws one diagram (the prepared text) — queued: one drawing at a time, each with a time limit. A drawing whose
 * `signal` is aborted before its turn is skipped. Errors are results, never rejections.
 */
export function renderDiagram(text: string, dark: boolean, signal?: AbortSignal): Promise<RenderResult> {
  const key = cacheKey(text, dark);
  const run = tail.then(async (): Promise<RenderResult> => {
    if (signal?.aborted) return { kind: "aborted" };
    const hit = cache.get(key);
    if (hit) return hit;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<RenderResult>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), RENDER_TIMEOUT_MS);
    });
    try {
      const r = await Promise.race([draw(text, dark), timeout]);
      if (r.kind === "ok" || r.kind === "error" || r.kind === "too-big") remember(key, r);
      return r;
    } finally {
      clearTimeout(timer);
    }
  });
  tail = run.catch(() => undefined);
  return run;
}

async function draw(text: string, dark: boolean): Promise<RenderResult> {
  let m: MermaidApi;
  try {
    m = await getMermaid();
  } catch {
    return { kind: "load-failed" };
  }
  const id = `mmd-${++seq}`;
  // mermaid measures text in a real element: an offscreen one of ours, removed right after (the result is only
  // ever shown as an image).
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText =
    "position:fixed;left:-10000px;top:0;width:1200px;visibility:hidden;pointer-events:none;contain:layout";
  document.body.append(host);
  try {
    m.initialize(mermaidConfig(dark));
    const { svg } = await m.render(id, text, host);
    if (svg.length > MAX_SVG) return { kind: "too-big", size: svg.length };
    const img = svgForImage(svg);
    return img ? { kind: "ok", ...img } : { kind: "error", message: "그림을 만들지 못했어요." };
  } catch (e) {
    return { kind: "error", message: errorText(e) };
  } finally {
    host.remove();
    // Without a container mermaid would have used one of its own on <body>: never left behind.
    document.getElementById(`d${id}`)?.remove();
  }
}
