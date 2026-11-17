import { describe, expect, it } from "vitest";
import { markdownHtml } from "../src/artifacts/markdown.js";
import { artifactCsp, serveVersion } from "../src/artifacts/serve.js";
import { exportDocument } from "../src/artifacts/export.js";

/** Markdown artifacts rendered by the server (#172): the served original and the PDF export. */
describe("markdown artifact pages", () => {
  it("renders headings, lists, tables, code and math", () => {
    const html = markdownHtml(
      [
        "# 제목",
        "",
        "- 하나",
        "- 둘",
        "",
        "1. 첫째",
        "",
        "| 이름 | 값 |",
        "|---|---:|",
        "| a | 1 |",
        "",
        "```python",
        'print("<b>")',
        "```",
        "",
        "인라인 $x^2$ 수식",
        "",
        "$$",
        "\\frac{1}{2}",
        "$$",
        "",
        "- [x] 완료",
        "",
        "~~지움~~",
      ].join("\n"),
    );
    expect(html).toContain("<h1>제목</h1>");
    expect(html).toContain("<li>하나</li>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<th>이름</th>");
    expect(html).toContain('<td align="right">1</td>');
    expect(html).toContain('<code class="language-python">print(&quot;&lt;b&gt;&quot;)');
    expect(html).toMatch(/<math[^>]*><semantics><mrow><msup><mi>x<\/mi><mn>2<\/mn><\/msup>/);
    expect(html).toContain("<mfrac>");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<del>지움</del>");
  });

  it("raw HTML is text, unsafe links are dropped, images are links, math cannot link", () => {
    const html = markdownHtml(
      [
        "<script>alert(1)</script>",
        "",
        "<img src=x onerror=alert(1)>",
        "",
        "[나쁜 링크](javascript:alert(1)) [데이터](data:text/html,<b>x</b>) [좋은 링크](https://example.com/a?b=1)",
        "",
        '![그림 "설명"](https://example.com/i.png "제목") ![나쁜 그림](javascript:alert(1))',
        "",
        "$\\href{javascript:alert(1)}{x}$",
        "",
        '<a href="javascript:alert(1)">a</a>',
      ].join("\n"),
    );
    // No element that runs or loads anything, no event attribute on any tag, no unsafe link target.
    expect(html).not.toMatch(/<(script|img|iframe)\b/i);
    expect(html).not.toMatch(/<[a-z][^>]*\son[a-z]+=/i);
    expect(html).not.toMatch(/(href|src)="(javascript|data):/i);
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain('<a href="">나쁜 링크</a>');
    expect(html).toContain('<a href="https://example.com/a?b=1">좋은 링크</a>');
    expect(html).toContain('<a href="https://example.com/i.png" class="imglink">🖼 그림 &quot;설명&quot;</a>');
    expect(html).toContain('<span class="badlink">🖼 나쁜 그림</span>');
    // KaTeX with trust off: \href is shown as an error/text, never a link.
    expect(html).not.toMatch(/<a [^>]*href="javascript/);
  });

  it("the served page and the export carry no script (the app's frame gets only the Escape bridge)", () => {
    const md = "# 제목\n\n<script>x()</script>";
    const page = serveVersion("markdown", "글 <b>", md)!;
    expect(page.type).toBe("text/html; charset=utf-8");
    expect(page.csp).toEqual([artifactCsp([])]);
    expect(page.body).not.toContain("<script");
    expect(page.body).toContain("<title>글 &lt;b&gt;</title>");
    expect(page.body).toContain('<article class="md"><h1>제목</h1>');
    const doc = exportDocument("markdown", "글", md)!;
    expect(doc.body).toBe(serveVersion("markdown", "글", md)!.body);
    expect(doc.body).not.toContain("<script");
    // Code: escaped in a <pre>, under its title.
    const code = exportDocument("code", "코드 <i>", "if (a < b) {}")!;
    expect(code.type).toBe("text/html; charset=utf-8");
    expect(code.body).toContain("<h1>코드 &lt;i&gt;</h1><pre>if (a &lt; b) {}</pre>");
    expect(code.body).not.toContain("<script");
  });
});
