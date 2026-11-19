import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  type ComponentProps,
  type ReactNode,
} from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { splitBlocks } from "./blocks.js";
import { CopyButton } from "./CopyButton.js";
import { fenceClosed } from "./mermaid.js";
import { MermaidBlock } from "./MermaidBlock.js";
import type { TextRange } from "@agentlee/shared";
import { CITATION_MISSING_MARK } from "@agentlee/shared";
import { rehypeCitationMarkers, rehypeMissingMarks } from "../citations/markdown.js";
import { markEffect } from "../citations/marks.js";
import "katex/dist/katex.min.css";

/**
 * Model output → safe markdown (FR-3.2): GFM tables, code blocks with highlight + copy, KaTeX math, links in a
 * new tab. Model output is untrusted: raw HTML is shown as text (never parsed), URLs are limited to http(s),
 * mailto and in-page links, images are shown as links (no request to wherever the model points), and KaTeX
 * runs with `trust: false` (no \href / \url / \htmlClass …).
 */

type HastNode = {
  type: string;
  value?: string;
  children?: HastNode[];
  tagName?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
};

/** The markdown of the block being rendered: a code block reads its own source (fences included) from it. */
const BlockText = createContext("");
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
  const block = useContext(BlockText);
  if (lang === "mermaid") {
    // Drawn only once the closing fence has arrived (a streaming reply shows the code until then, #182).
    const at = node?.position;
    const md =
      at?.start.offset !== undefined && at.end.offset !== undefined
        ? block.slice(at.start.offset, at.end.offset)
        : "";
    return <MermaidBlock source={text} closed={fenceClosed(md, text)} code={children} />;
  }
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
  table: ({ children, ...props }) => {
    // A table without a citation (#202, `rehypeMissingMarks`): marked as a whole, the ⚠️ above it when it is
    // its range's focus target (a table continuing a range from an earlier part only gets the bar).
    const p = props as Record<string, unknown>;
    const target = p["data-cite-missing"];
    return String(p.className ?? "").includes("cite-missing-block") ? (
      <div
        className="cite-missing-block cite-missing-table"
        {...(typeof target === "string"
          ? { "data-cite-missing": target, "data-testid": "citation-missing", tabIndex: -1 }
          : {})}
      >
        {typeof target === "string" && (
          <span
            className="cite-missing-badge"
            role="img"
            aria-label={CITATION_MISSING_MARK}
            title={CITATION_MISSING_MARK}
          >
            ⚠️
          </span>
        )}
        <div className="tablewrap">
          <table>{children}</table>
        </div>
      </div>
    ) : (
      <div className="tablewrap">
        <table>{children}</table>
      </div>
    );
  },
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

/**
 * Citation markers of a finished answer (#25): which `[n]` are citations, and how one is drawn. Without it the
 * text renders exactly as before. `missing` (#202): the note's ranges of paragraphs without a citation (in the
 * answer text), marked in place with the answer's `markId`.
 */
export type MarkdownCite = {
  numbers: ReadonlySet<number>;
  render: (ns: number[]) => ReactNode;
  missing?: readonly TextRange[];
  markId?: string;
  /** The server's marker positions in the answer text (#202 review 3차): only these `[n]` become chips. */
  markers?: readonly { start: number; n: number }[];
};

/** One block; memoised on its text, so finished blocks are not parsed again while the reply streams. */
export const MarkdownBlock = memo(function MarkdownBlock({
  text,
  cite,
  offset = 0,
}: {
  text: string;
  cite?: MarkdownCite;
  /** Where this block starts in the answer text (the note's ranges point into it). */
  offset?: number;
}) {
  const withCite = useMemo(
    () =>
      cite
        ? {
            rehype: [
              // First, while every element still has its source position (#202 review 2차).
              ...(cite.missing?.length && cite.markId
                ? [rehypeMissingMarks(cite.missing, offset, offset + text.length, cite.markId)]
                : []),
              ...(rehypePlugins ?? []),
              rehypeCitationMarkers(
                cite.numbers,
                cite.markers ? { offset, markers: cite.markers, source: text } : undefined,
              ),
            ],
            components: {
              ...components,
              sup: ({ node, children }: { node?: unknown; children?: ReactNode }) => {
                const n = (node as { properties?: { dataCiteN?: unknown } } | undefined)?.properties
                  ?.dataCiteN;
                // One chip for markers side by side (#150): "1,3".
                return typeof n === "string" && /^\d+(,\d+)*$/.test(n) ? (
                  cite.render(n.split(",").map(Number))
                ) : (
                  <sup>{children}</sup>
                );
              },
            } as Components,
          }
        : undefined,
    [cite, offset, text],
  );
  // Its marks are drawn — or gone again (review 2차): the answer's summary line checks for them either way.
  const marked = !!(cite?.missing?.length && cite.markId);
  useEffect(() => markEffect(marked), [marked, withCite]);
  return (
    <BlockText.Provider value={text}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={withCite?.rehype ?? rehypePlugins}
        components={withCite?.components ?? components}
        urlTransform={safeUrl}
        skipHtml={false}
      >
        {text}
      </ReactMarkdown>
    </BlockText.Provider>
  );
});

const Markdown = memo(function Markdown({
  text,
  cite,
  offset = 0,
}: {
  text: string;
  cite?: MarkdownCite;
  /** Where this text starts in the answer text (text parts joined, #202). */
  offset?: number;
}) {
  const blocks = splitBlocks(text);
  // Where each block starts in the answer text: one pass.
  const starts: number[] = [];
  for (let i = 0, at = offset; i < blocks.length; at += blocks[i]!.length, i++) starts.push(at);
  return (
    <div className="md">
      {blocks.map((b, i) => (
        <MarkdownBlock key={i} text={b} offset={starts[i]!} {...(cite ? { cite } : {})} />
      ))}
    </div>
  );
});

export default Markdown;
