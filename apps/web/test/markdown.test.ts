import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { splitBlocks } from "../src/chat/blocks.js";
import Markdown, { MarkdownBlock, safeUrl } from "../src/chat/Markdown.js";

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

const blocksOf = splitBlocks;

describe("splitBlocks", () => {
  it("splits before a line that follows blank lines; the blank lines stay with the block before", () => {
    expect(blocksOf("a\nb\n\nc\n\n\nd")).toEqual(["a\nb\n\n", "c\n\n\n", "d"]);
  });
  it("keeps fenced code and $$ math whole, even with blank lines inside", () => {
    const code = "```py\nx = 1\n\ny = 2\n```";
    const math = "$$\na\n\nb\n$$";
    expect(blocksOf(`intro\n\n${code}\n\n${math}\n\nend`)).toEqual([
      "intro\n\n",
      `${code}\n\n`,
      `${math}\n\n`,
      "end",
    ]);
  });
  it("keeps an unfinished fence (still streaming) in the last block", () => {
    expect(blocksOf("p\n\n```js\nlet a\n\nlet b")).toEqual(["p\n\n", "```js\nlet a\n\nlet b"]);
  });
  it("keeps indented continuations and further items with their list", () => {
    expect(blocksOf("1. item\n\n   more\n\nnext")).toEqual(["1. item\n\n   more\n\n", "next"]);
    expect(blocksOf("1. 첫째\n\n1. 둘째\n\n끝")).toEqual(["1. 첫째\n\n1. 둘째\n\n", "끝"]);
  });
  it("keeps every blank line inside indented code (review #78)", () => {
    const code = '    s = """a\n\n\n    b"""';
    expect(blocksOf(`문단\n\n${code}\n\n끝`)).toEqual([`문단\n\n${code}\n\n`, "끝"]);
  });
  it("one-line $$…$$ does not swallow the rest", () => {
    expect(blocksOf("$$x$$\n\nafter")).toEqual(["$$x$$\n\n", "after"]);
  });
  it("does not split a reply that may hold reference or footnote definitions", () => {
    for (const t of ["a\n\n[ref]: https://x\n\nb", "a\n\n## h\n[ref]:\n  https://x", "a[^1]\n\n[^1]: n"])
      expect(blocksOf(t)).toEqual([t]);
  });
  it("joined, the blocks are the text byte for byte (any document, any prefix while streaming)", () => {
    const docs = [
      "",
      "\n\n앞의 빈 줄\n\n\n\n뒤\n\n",
      "a\n \n\t\nb   \n\n\n\nc",
      '문단\n\n    s = """a\n\n\n    b"""\n\n\n끝\n',
      "1. a\n\n\n2. b\n\n   - c\n\n\n\n     d\n\n끝",
      "```py\n\n\nx\n```\n\n\n~~~\n\n~~~\n\n$$\n\n\n$$\n$$y$$\n\n> q\n\n\n> r",
      "| a | b |\n|---|---|\n| 1 | 2 |\n\n\n## h\n\n- x\n\n\n\ntext\r\n\r\nwindows",
      "[a]: x\n\n\n본문",
    ];
    for (const doc of docs)
      for (let n = 0; n <= doc.length; n++) {
        const prefix = doc.slice(0, n);
        const blocks = blocksOf(prefix);
        expect(blocks.join("")).toBe(prefix);
        expect(blocks.every((b) => b.length > 0)).toBe(true);
      }
  });
});

/** Rendering split into blocks must mean the same as rendering the whole document at once. */
describe("block rendering = whole-document rendering", () => {
  const whole = (text: string) =>
    renderToStaticMarkup(createElement("div", { className: "md" }, createElement(MarkdownBlock, { text })));
  const norm = (html: string) => html.replace(/>\s+</g, "><").trim();
  const DOCS = {
    "reference links defined in another block":
      "[출처][ref]와 [다른 곳][b]\n\n본문\n\n[ref]: https://example.com\n[b]: https://b.example",
    "ordered list split by blank lines": "1. 첫째\n\n1. 둘째\n\n1. 셋째\n\n다음 문단",
    "numbered on from 3": "3. 셋\n\n4. 넷",
    "loose bullet list with nested items": "- a\n\n  - a.1\n\n  - a.2\n\n- b\n\n문단",
    "list item with a second paragraph and code":
      "1. 설명\n\n   이어서\n\n   ```js\n   let x\n   ```\n\n2. 다음",
    "paragraph, then list, then paragraph": "문단\n\n- x\n- y\n\n끝",
    blockquotes: "> 인용 1\n\n> 인용 2\n\n본문",
    "code with blank lines and math": "```py\na = 1\n\nb = 2\n```\n\n$$\nx^2\n\n$$\n\n$y$ 끝",
    "table and heading": "## 제목\n\n| a | b |\n|---|--:|\n| 1 | 2 |\n\n텍스트",
    "multi-line reference definition": "[출처][ref] 참고\n\n본문\n\n[ref]:\n  https://example.com",
    "reference definition with a title on the next line":
      '[출처][ref]\n\n[ref]: https://example.com\n  "예시 제목"\n\n끝',
    "reference definition, destination and title on separate lines":
      "앞 [a][] 뒤\n\n[a]:\n  <https://a.example/x y>\n  'a 제목'\n\n다음 문단",
    "reference label over two lines": "[출처][long label]\n\n본문\n\n[long\nlabel]: https://example.com",
    "reference label with an escaped bracket": "[출처][a\\]b]\n\n본문\n\n[a\\]b]: https://example.com",
    "reference definition right after a heading": "[출처][ref]\n\n## 출처\n[ref]:\n  https://example.com",
    "reference definition after a heading, then more text":
      "앞 [a] 뒤\n\n## 참고\n[a]: https://a.example\n\n다음 문단\n\n- 목록 [a]",
    "long multi-line reference title":
      '[출처][ref]\n\n[ref]: https://example.com\n  "첫째 줄 제목\n  둘째 줄\n  셋째 줄\n  넷째 줄"\n\n끝',
    "blank lines inside indented code": '문단\n\n    s = """a\n\n\n    b"""\n\n끝',
    "unfinished reference definition (no destination yet)": "[출처][ref]\n\n[ref]:",
    "reference-looking line inside a paragraph": "문단 시작\n[ref]: https://example.com\n\n[x][ref]",
    footnotes: "본문[^1]\n\n다음\n\n[^1]: 각주",
    "indented code after a paragraph": "문단\n\n    code line\n\n끝",
  };
  it.each(Object.entries(DOCS))("%s", (_name, text) => {
    expect(norm(render(text))).toBe(norm(whole(text)));
  });
});

describe("safeUrl", () => {
  it.each([
    ["https://example.com/a?b#c", "https://example.com/a?b#c"],
    ["http://x.y", "http://x.y"],
    ["mailto:a@b.c", "mailto:a@b.c"],
    ["#section", "#section"],
    ["/relative/path", "/relative/path"],
    ["javascript:alert(1)", ""],
    ["JaVaScRiPt:alert(1)", ""],
    [" java\tscript:alert(1)", ""],
    ["data:text/html,<script>alert(1)</script>", ""],
    ["vbscript:msgbox", ""],
  ])("%s → %s", (input, out) => expect(safeUrl(input)).toBe(out));
});

describe("Markdown", () => {
  it("renders GFM tables with alignment", () => {
    const html = render("| a | b |\n|---|--:|\n| 1 | 2 |");
    expect(html).toContain("<table>");
    expect(html).toContain('<td style="text-align:right">2</td>');
  });
  it("renders code blocks with a language label, highlighting and a copy button", () => {
    const html = render("```python\nimport math\nprint(1)\n```");
    expect(html).toContain('class="codeblk"');
    expect(html).toContain("<span>python</span>");
    expect(html).toContain("hljs-keyword");
    expect(html).toContain('aria-label="코드 복사"');
  });
  it("renders inline and block math with KaTeX", () => {
    const html = render("inline $a^2$\n\n$$\n\\frac{1}{2}\n$$");
    expect(html).toContain('class="katex"');
    expect(html).toContain("katex-display");
  });
  it("opens links in a new tab without opener or referrer", () => {
    const html = render("[x](https://example.com)");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  const XSS = [
    '<img src="x" onerror="alert(1)">',
    "<script>alert(1)</script>",
    '<a href="javascript:alert(1)">raw</a>',
    "[click](javascript:alert(1))",
    "[click](JAVASCRIPT:alert(1))",
    "![img](javascript:alert(1))",
    '<iframe src="javascript:alert(1)"></iframe>',
    "<svg onload=alert(1)>",
    "$\\href{javascript:alert(1)}{x}$",
    "$\\url{javascript:alert(1)}$",
    '<div style="background:url(javascript:alert(1))">x</div>',
    "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  ];
  it.each(XSS)("never turns %s into live markup", (payload) => {
    const html = render(`before\n\n${payload}\n\nafter`);
    expect(html).not.toMatch(/<(script|iframe|svg|img|div style)\b/i);
    expect(html).not.toMatch(/<[a-z][^>]*\son\w+=/i);
    expect(html).not.toMatch(/(href|src)="\s*(javascript|data):/i);
    expect(html).toContain("after");
  });
  it("shows raw HTML as text instead of dropping it", () => {
    expect(render("<b>굵게</b>")).toContain("&lt;b&gt;굵게&lt;/b&gt;");
  });
});

describe("citation markers in the markdown view (#25, #150)", () => {
  const cited = (text: string, numbers: number[]) =>
    renderToStaticMarkup(
      createElement(Markdown, {
        text,
        cite: { numbers: new Set(numbers), render: (ns) => createElement("b", { "data-ns": ns.join(",") }) },
      }),
    );
  it("markers side by side are one chip; others, unlisted numbers and code stay apart", () => {
    const out = cited("가는 늘었다[1][3]. 나는[2] [4]. 배열 `a[1]`, 목록[9][2].", [1, 2, 3, 4]);
    expect([...out.matchAll(/data-ns="([^"]+)"/g)].map((m) => m[1])).toEqual(["1,3", "2,4", "2"]);
    expect(out).toContain("<code>a[1]</code>");
    expect(out).toContain("목록[9]");
  });
});

describe("paragraphs without a citation, marked in the answer (#202)", () => {
  const ANSWER = [
    "## 요약",
    "",
    "메모리 가격 회복이 증가를 이끌었어요[1].",
    "",
    "미국 수출 비중이 가장 컸어요.",
    "",
    "- **배경:** 메모리 가격이에요[1]",
    "- **전망:** 증가를 예상해요",
    "  - 하위 항목도 있어요",
    "",
    "| 자료 | 증가율 |",
    "|---|---|",
    "| 가 | 32% |",
    "",
    "> 인용문이에요.",
  ].join("\n");
  const range = (full: string, s: string) => {
    const start = full.indexOf(s);
    return { start, end: start + s.length };
  };
  const marked = (text: string, missing: { start: number; end: number }[], offset = 0) =>
    renderToStaticMarkup(
      createElement(Markdown, {
        text,
        offset,
        cite: { numbers: new Set([1]), render: () => createElement("b", null, "1"), missing, markId: "m1" },
      }),
    );
  const marks = (html: string) =>
    [...html.matchAll(/<(\w+)[^>]*data-cite-missing="m1"[^>]*>/g)].map((m) => m[1]);

  it("each range marks its paragraph, list item, table or quote in place — with a ⚠️, the text not repeated", () => {
    const missing = [
      range(ANSWER, "미국 수출 비중이 가장 컸어요."),
      range(ANSWER, "- **전망:** 증가를 예상해요"),
      range(ANSWER, "  - 하위 항목도 있어요"),
      range(ANSWER, "| 자료 | 증가율 |\n|---|---|\n| 가 | 32% |"),
      range(ANSWER, "> 인용문이에요."),
    ];
    const out = marked(ANSWER, missing);
    expect(marks(out)).toEqual(["p", "li", "li", "div", "blockquote"]);
    // The ⚠️ at the end of the paragraph's own text; the nested item has its own.
    expect(out).toMatch(
      /미국 수출 비중이 가장 컸어요\.<span class="cite-missing-badge" role="img" aria-label="출처 표시 없음"[^>]*>⚠️<\/span><\/p>/,
    );
    expect(out).toMatch(/증가를 예상해요\n?<span class="cite-missing-badge"[^>]*>⚠️<\/span>\n?<ul>/);
    expect(out.split("⚠️")).toHaveLength(6);
    // Every paragraph once: nothing is repeated.
    expect(out.split("미국 수출 비중이 가장 컸어요.")).toHaveLength(2);
    // Cited ones, the heading and the first item are not marked.
    expect(out).toMatch(/<p>메모리 가격 회복이 증가를 이끌었어요<b>1<\/b>\.<\/p>/);
    expect(out).toMatch(/<h2>요약<\/h2>/);
  });

  it("ranges point into the answer text: a later text part and later blocks use their offset", () => {
    const first = "앞 부분이에요[1].\n\n";
    const second = "뒷 문단이에요.\n\n또 다른 문단이에요[1].";
    const all = first + second;
    const out = marked(second, [range(all, "뒷 문단이에요.")], first.length);
    expect(marks(out)).toEqual(["p"]);
    expect(out).toMatch(/뒷 문단이에요\.<span class="cite-missing-badge"/);
    // Without the offset the same range points elsewhere: nothing is marked by mistake.
    expect(marks(marked(second, [range(all, "뒷 문단이에요.")]))).toEqual([]);
  });

  it("an old note's ranges (stored before #202: tables, progress notes) still mark their paragraphs", () => {
    const text = "자료를 찾아 볼게요.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n원하시면 더 정리해 드릴게요.";
    const out = marked(text, [
      range(text, "자료를 찾아 볼게요."),
      range(text, "| a | b |\n|---|---|\n| 1 | 2 |"),
      range(text, "원하시면 더 정리해 드릴게요."),
    ]);
    expect(marks(out)).toEqual(["p", "div", "p"]);
  });

  it("no ranges, or no note: nothing is marked", () => {
    expect(marks(marked(ANSWER, []))).toEqual([]);
    expect(render(ANSWER)).not.toContain("data-cite-missing");
  });
});
