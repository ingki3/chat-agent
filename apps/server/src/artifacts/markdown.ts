import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { math, mathHtml } from "micromark-extension-math";

/**
 * A markdown artifact as HTML, made by the server (#172): the served original (`/a/:id/v/:ver/raw`) and the PDF
 * export. The app itself renders markdown with the chat's renderer (react-markdown); this is the same policy for
 * the pages the server sends:
 * - raw HTML in the markdown is shown as text, never parsed (micromark's `allowDangerousHtml` stays off), so
 *   `<script>` or `<img onerror=…>` are inert text;
 * - link URLs are limited to safe protocols (`allowDangerousProtocol` off: `javascript:`, `data:` … become empty);
 * - images become links (no request to wherever the markdown points — the CSP refuses them anyway);
 * - math is KaTeX as MathML only (no stylesheet needed), with `trust: false` (no `\href`, `\url`, `\html…`).
 * The page around it has no script (`serve.ts`).
 */
export function markdownHtml(markdown: string): string {
  const html = micromark(markdown, {
    allowDangerousHtml: false,
    allowDangerousProtocol: false,
    extensions: [gfm(), math()],
    htmlExtensions: [
      gfmHtml(),
      mathHtml({ output: "mathml", throwOnError: false, trust: false, strict: "ignore" }),
    ],
  });
  // Every `<img` in the output is micromark's own (raw HTML is escaped), with its attributes escaped.
  return html.replace(IMG, (_, src: string, alt: string) =>
    src
      ? `<a href="${src}" class="imglink">🖼 ${alt || "그림"}</a>`
      : `<span class="badlink">🖼 ${alt || "그림"}</span>`,
  );
}

const IMG = /<img src="([^"]*)" alt="([^"]*)"(?: title="[^"]*")? \/>/g;

/** Styles of a rendered markdown page (light and dark, as the server's other pages). */
export const MARKDOWN_STYLE =
  ".md{max-width:820px;margin:0 auto;font-size:15px;line-height:1.65;overflow-wrap:anywhere}" +
  ".md h1{font-size:24px;margin:8px 0 14px}.md h2{font-size:20px;margin:22px 0 10px}.md h3{font-size:17px;margin:18px 0 8px}" +
  ".md p,.md ul,.md ol,.md blockquote,.md pre,.md table{margin:0 0 12px}" +
  ".md blockquote{padding:2px 12px;border-left:3px solid #8886;opacity:.9}" +
  ".md code{font:13px/1.5 ui-monospace,Menlo,monospace;background:#8882;border-radius:4px;padding:1px 4px}" +
  ".md pre{padding:10px 12px;background:#8881;border:1px solid #8884;border-radius:8px;overflow:auto;white-space:pre-wrap;word-break:break-word}" +
  ".md pre code{background:none;padding:0}.md table{display:block;overflow:auto}" +
  ".md th{position:static}.md img{max-width:100%}.md .math-display{overflow:auto;margin:0 0 12px}" +
  ".md a{color:#2f6fb0}.md hr{border:0;border-top:1px solid #8886;margin:16px 0}";
