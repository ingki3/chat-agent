import { memo, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { splitBlocks } from "./blocks.js";
import { CopyButton } from "./CopyButton.js";
import "katex/dist/katex.min.css";

/**
 * Model output → safe markdown (FR-3.2): GFM tables, code blocks with highlight + copy, KaTeX math, links in a
 * new tab. Model output is untrusted: raw HTML is shown as text (never parsed), URLs are limited to http(s),
 * mailto and in-page links, images are shown as links (no request to wherever the model points), and KaTeX
 * runs with `trust: false` (no \href / \url / \htmlClass …).
 */

type HastNode = { type: string; value?: string; children?: HastNode[]; tagName?: string };
type MdNode = { type: string; value?: string; children?: MdNode[] };

/** remark plugin: raw HTML nodes become plain text, so `<img onerror=…>` is shown, not parsed. */
function remarkHtmlAsText() {
  const walk = (node: MdNode) => {
    if (node.type === "html") node.type = "text";
    node.children?.forEach(walk);
  };
  return (tree: MdNode) => walk(tree);
}

const SAFE_URL = /^(https?:|mailto:)/i;
/** Only http(s), mailto, in-page and relative links survive; anything else (javascript:, data:, …) is dropped. */
export function safeUrl(url: string): string {
  const u = url.trim();
  // Browsers ignore tabs/newlines and leading control characters in schemes ("java\tscript:"): judge without them.
  // eslint-disable-next-line no-control-regex
  const bare = u.replace(/[\u0000- \u007f]/g, "");
  if (SAFE_URL.test(bare)) return u;
  if (/^[a-z][a-z0-9+.-]*:/i.test(bare)) return "";
  // A colon before any / ? # would make it a scheme after all ("javascript&colon;" is decoded before here).
  if (/^[^/?#]*:/.test(bare)) return "";
  return u;
}

function hastText(node: HastNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(hastText).join("");
}

function CodeBlock({ children, node }: { children?: ReactNode; node: HastNode | undefined }) {
  const code = node?.children?.find((c) => c.tagName === "code") as
    (HastNode & { properties?: { className?: unknown } }) | undefined;
  const classes = code?.properties?.className;
  const lang = (Array.isArray(classes) ? classes : [])
    .map(String)
    .find((c) => c.startsWith("language-"))
    ?.slice("language-".length);
  const text = hastText(code).replace(/\n$/, "");
  return (
    <div className="codeblk">
      <div className="ch">
        <span>{lang ?? "code"}</span>
        <CopyButton text={text} label="코드 복사" />
      </div>
      <pre>{children}</pre>
    </div>
  );
}

const components: Components = {
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span className="badlink">{children}</span>
    ),
  img: ({ src, alt }) =>
    typeof src === "string" && src ? (
      <a href={src} target="_blank" rel="noopener noreferrer" className="imglink">
        🖼 {alt || "그림"}
      </a>
    ) : (
      <span className="badlink">🖼 {alt || "그림"}</span>
    ),
  pre: ({ node, children }) => <CodeBlock node={node as HastNode | undefined}>{children}</CodeBlock>,
  table: ({ children }) => (
    <div className="tablewrap">
      <table>{children}</table>
    </div>
  ),
};

const remarkPlugins: ComponentProps<typeof ReactMarkdown>["remarkPlugins"] = [
  remarkGfm,
  remarkMath,
  remarkHtmlAsText,
];
const rehypePlugins: ComponentProps<typeof ReactMarkdown>["rehypePlugins"] = [
  [rehypeKatex, { throwOnError: false, trust: false, strict: "ignore", output: "htmlAndMathml" }],
  [rehypeHighlight, { detect: false }],
];

/** One block; memoised on its text, so finished blocks are not parsed again while the reply streams. */
export const MarkdownBlock = memo(function MarkdownBlock({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      rehypePlugins={rehypePlugins}
      components={components}
      urlTransform={safeUrl}
      skipHtml={false}
    >
      {text}
    </ReactMarkdown>
  );
});

const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {splitBlocks(text).map((b, i) => (
        <MarkdownBlock key={i} text={b} />
      ))}
    </div>
  );
});

export default Markdown;
