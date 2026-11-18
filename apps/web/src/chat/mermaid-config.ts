/**
 * What the app and the diagram frame (#182, `src/mermaid-frame/main.ts`) share: limits, the mermaid config, source
 * cleaning and the error text. No DOM and no mermaid here — the frame bundles this module, the app imports it too.
 */

/** Longest source drawn (characters); a longer one stays a code block with a notice. */
export const MAX_SOURCE = 20_000;
/** Largest SVG shown (characters); a larger one stays a code block with a notice. */
export const MAX_SVG = 2_000_000;
/** Error text sent with "다이어그램 고치기" (and from the frame) is cut to this. */
export const MAX_FIX_ERROR = 500;

/** Korean-friendly fonts (the system ones — an SVG shown as an image cannot use the page's web fonts). */
export const DIAGRAM_FONT =
  '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Pretendard", "Noto Sans KR", "Malgun Gothic", sans-serif';

/** The frame's answer when mermaid still finds a config in the cleaned source (see the frame). */
export const CONFIG_REFUSED =
  "다이어그램 안의 설정(--- 머리말, %%{init}%% 지시문)은 쓸 수 없어요. 빼고 다시 그려 주세요.";

export type Prepared = { ok: true; text: string } | { ok: false; reason: "too-long"; length: number };

/**
 * A leading front matter, cut wider than mermaid reads one (`matchFrontMatter`): mermaid takes any whitespace but a
 * line break (NBSP, `\v` … too), `---`, and runs to the **last** later line that starts with the same indent and
 * `---`. Here: `---` after any whitespace at all, up to the last later line that is `---` after any whitespace —
 * or only the first line when there is none. Whatever mermaid would read as front matter is gone.
 */
function stripFrontMatter(t: string): string {
  const lead = /^\s*/.exec(t)![0].length;
  if (!t.startsWith("---", lead)) return t;
  const lines = t.slice(lead).split("\n");
  let last = 0;
  for (let i = 1; i < lines.length; i++) if (/^\s*---/.test(lines[i]!)) last = i;
  return lines.slice(last + 1).join("\n");
}

/**
 * The source as it is drawn: line endings normalised (mermaid's own line breaks are `\n` and `\r`), front matter
 * and every `%%{ … }%%` directive removed (closed or not — mermaid reads an unclosed one to the end of the text; a
 * removal that joins `%%` and `{` into a new one is removed too). Over the limit: not drawn. The frame checks the
 * result once more with mermaid's own parser and refuses any config it still finds.
 */
export function prepareSource(source: string): Prepared {
  if (source.length > MAX_SOURCE) return { ok: false, reason: "too-long", length: source.length };
  let t = source.replace(/\r\n?/g, "\n");
  for (;;) {
    const before = t;
    t = stripFrontMatter(t);
    t = t.replace(/%%\{[\s\S]*?\}%%/g, "").replace(/%%\{[^\n]*/g, "");
    if (t === before) break;
  }
  return { ok: true, text: t.trim() };
}

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

/** Messages between the app and the diagram frame (both sides check every field). */
export const FRAME_BOOT = "agentlee:mermaid-boot";
export const FRAME_CODE = "agentlee:mermaid-code";
export const FRAME_READY = "agentlee:mermaid-ready";
export const FRAME_RENDER = "agentlee:mermaid-render";
export const FRAME_RESULT = "agentlee:mermaid-result";
export type FrameRender = { type: typeof FRAME_RENDER; id: number; text: string; dark: boolean };
export type FrameResult = { type: typeof FRAME_RESULT; id: number; svg?: string; error?: string };
