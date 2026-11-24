import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadResearchPrompts,
  maskOutline,
  notesBlock,
  parseGaps,
  parseNotes,
  outlineTurn,
  parseOutline,
  parsePlan,
  RESEARCH_PROMPT_IDS,
  RESEARCH_PROMPTS_DIR,
  stepPrompt,
  writerTurn,
} from "../src/research/prompts.js";
import {
  cleanReport,
  isTopicLabel,
  renderReport,
  reportSourceKey,
  groupSources,
  linkedHref,
  codeSpan,
  oneLine,
  type ReportCitation,
} from "../src/research/report.js";
import { MARKDOWN_STYLE, markdownHtml } from "../src/artifacts/markdown.js";
import { KnownSecrets, scrubContent } from "../src/secrets/known.js";
import { pickNotes, summaryOf } from "../src/research/engine.js";
import { claimKeyOf, emptyState, restoreOutline, storeOutline } from "../src/research/store.js";

/**
 * 깊이 조사's pure parts (#211): the removal of what has no verified citation (decision 4), the report around it, and
 * what the server reads from the model (plan, notes, gaps) — bounded and tolerant of a model's extra words.
 */

const cite = (n: number, verified = true): [number, ReportCitation] => [
  n,
  { n, verified, kind: "web", title: `출처 ${n}`, url: `https://example.test/${n}`, quote: `구절 ${n}` },
];

describe("cleanReport", () => {
  it("keeps only sentences with a verified marker, drops failed markers, renumbers in order", () => {
    const cites = new Map([cite(3), cite(5, false), cite(7)]);
    const r = cleanReport(
      [
        "## 요약",
        "",
        "수출이 늘었다[7]. 근거 없는 문장이다. 실패한 인용만 있다[5].",
        "두 출처가 있다[3][5]. 3.5% 늘었다[3].",
        "",
        "## 빈 섹션",
        "",
        "아무 근거도 없다.",
        "",
        "## 목록",
        "",
        "- 목록 항목이다[3]",
        "- 근거 없는 항목",
        "> 인용문이다[7].",
      ].join("\n"),
      cites,
    );
    expect(r.removed).toBe(4);
    // (근거 없는 문장, 실패한 인용만 있는 문장, 빈 섹션의 문장, 근거 없는 항목)
    expect(r.body).toBe(
      [
        "## 요약",
        "",
        "수출이 늘었다[1].",
        "두 출처가 있다[2]. 3.5% 늘었다[2].",
        "",
        "## 목록",
        "",
        "- 목록 항목이다[2]",
        "",
        "> 인용문이다[1].",
      ].join("\n"),
    );
    expect(r.numbering).toEqual([
      { from: 7, to: 1 },
      { from: 3, to: 2 },
    ]);
  });

  it("counts table rows and code lines as removed, and keeps the writer from setting the title", () => {
    const r = cleanReport(
      [
        "# 제목[1]",
        "| 자료 | 값 |",
        "|---|---|",
        "| 가 | 32%[1] |",
        "```",
        "code",
        "```",
        "본문이다[1].",
      ].join("\n"),
      new Map([cite(1)]),
    );
    expect(r.removed).toBe(2);
    expect(r.body).toBe("## 제목[1]\n\n본문이다[1].");
  });

  it("cuts sentences as #202 does: run-together sentences, factual headings, markers in links and code", () => {
    const cites = new Map([cite(1), cite(2)]);
    const r = cleanReport(
      [
        "## 요약",
        "",
        "근거 없는 결론이다.검증된 사실이다[1].",
        "",
        "## 수출이 50% 늘었다.",
        "",
        "링크 속 표시는 인용이 아니다 [1](https://example.test). 코드 속 `a[1]`도 아니다.",
        "3.5% 늘었다[2]. example.com 도 있다[2].",
      ].join("\n"),
      cites,
    );
    // 근거 없는 결론, 사실을 단정한 제목, 링크 속 [1]만 있는 문장, 코드 속 [1]만 있는 문장.
    expect(r.removed).toBe(4);
    expect(r.body).toBe("## 요약\n\n검증된 사실이다[1].\n\n3.5% 늘었다[2]. example.com 도 있다[2].");
    // A heading sentence is a fact only when it ends like a sentence (review 5: no guessing from word endings).
    expect(isTopicLabel("수출 증가의 배경")).toBe(true);
    expect(isTopicLabel("2026년 10월")).toBe(true);
    expect(isTopicLabel("수출이 늘었다.")).toBe(false);
    expect(isTopicLabel("“수출이 줄었다.”")).toBe(false);
  });

  it("keeps a marker written after a space on the sentence it ends (review 2)", () => {
    const r = cleanReport("수출이 늘었다. [1] 수입도 늘었다.", new Map([cite(1)]));
    expect(r).toMatchObject({ removed: 1, body: "수출이 늘었다. [1]" });
  });

  it("checks every sentence of a heading, and a marker only in a link's address is none", () => {
    const r = cleanReport(
      [
        "## 근거 없는 결론이다. 검증된 사실이다[1].",
        "",
        "근거 없는 주장 [참고](/자료/[1]).",
        "본문이다[1].",
      ].join("\n"),
      new Map([cite(1)]),
    );
    expect(r.removed).toBe(2);
    expect(r.body).toBe("## 검증된 사실이다[1].\n\n본문이다[1].");
  });

  it("numbers markers only once the body is final: a cited heading over an emptied section leaves no number", () => {
    const r = cleanReport("## 수출이 32% 늘었다[1]\n\n근거 없는 본문이다.", new Map([cite(1)]));
    expect(r).toEqual({ body: "", removed: 1, numbering: [] });
  });

  it("decides on parsed markdown: heading sentences, autolinks, link labels, code spans (review 3)", () => {
    const cites = new Map([cite(1)]);
    // A heading's first sentence states a fact (removed), its second names a topic (kept).
    expect(cleanReport("## 수출이 늘었다. 증가 원인\n\n본문이다[1].", cites)).toMatchObject({
      removed: 1,
      body: "## 증가 원인\n\n본문이다[1].",
    });
    // An autolink's address is no marker.
    expect(cleanReport("근거 없는 주장 <https://example.org/ref/[1]>.", cites)).toMatchObject({
      removed: 1,
      body: "",
    });
    // A numbered link label opening the next sentence is not a trailing citation.
    expect(cleanReport("수출이 늘었다[1]. [2](https://example.org)에서 주장했다.", cites)).toMatchObject({
      removed: 1,
      body: "수출이 늘었다[1].",
    });
    // A link's syntax shown in inline code does not hide the real marker after it.
    expect(cleanReport("링크를 설명하는 구문은 `[이름](`이다[1].", cites)).toMatchObject({
      removed: 0,
      body: "링크를 설명하는 구문은 `[이름](`이다[1].",
    });
  });

  it("review 4: quoted facts in headings, a link label right after a period, heading forms", () => {
    const cites = new Map([cite(1)]);
    // A fact inside closing quotes or brackets still ends a sentence: removed when uncited.
    expect(cleanReport("## “수출이 줄었다.” 2026년 통계[1]\n\n본문이다[1].", cites)).toMatchObject({
      removed: 1,
      body: "## 2026년 통계[1]\n\n본문이다[1].",
    });
    expect(cleanReport("## (수출이 줄었다.) 증가 원인\n\n본문이다[1].", cites)).toMatchObject({
      removed: 1,
      body: "## 증가 원인\n\n본문이다[1].",
    });
    // A numbered link label right after the period (no space) starts the next sentence.
    expect(cleanReport("수출이 늘었다[1].[2](https://example.org)에서 주장했다.", cites)).toMatchObject({
      removed: 1,
      body: "수출이 늘었다[1].",
    });
    // A setext heading and a bold-only heading are written again as one heading, without stray marks.
    expect(cleanReport("증가 원인\n---\n\n본문이다[1].", cites).body).toBe("## 증가 원인\n\n본문이다[1].");
    expect(cleanReport("**수출이 늘었다. 증가 원인**\n\n본문이다[1].", cites)).toMatchObject({
      removed: 1,
      body: "**증가 원인**\n\n본문이다[1].",
    });
    expect(cleanReport("## 증가 원인 ##\n\n본문이다[1].", cites).body).toBe("## 증가 원인\n\n본문이다[1].");
  });

  it("review 5: labels ending in nouns stay, a bold label with its colon keeps its form", () => {
    const cites = new Map([cite(1)]);
    for (const h of ["## 전력 시장(공급과 수요)", "## 수출 동향(개요)"])
      expect(cleanReport(`${h}\n\n본문이다[1].`, cites)).toMatchObject({
        removed: 0,
        body: `${h}\n\n본문이다[1].`,
      });
    expect(cleanReport("**증가 원인**:\n\n본문이다[1].", cites)).toMatchObject({
      removed: 0,
      body: "**증가 원인**:\n\n본문이다[1].",
    });
    expect(cleanReport("####### 일곱 개\n\n본문이다[1].", cites).body).not.toMatch(/#{7}/);
  });

  it("review 6: judges heading sentences on the parsed words, dropping the inline node that holds a fact", () => {
    const cites = new Map([cite(1)]);
    const body = "\n\n본문이다[1].";
    for (const [h, kept] of [
      ["## ~~2026년 수출이 줄었다.~~ 증가 원인", "## 증가 원인"],
      ["## [2026년 수출이 줄었다.](https://example.org/a) 증가 원인", "## 증가 원인"],
      ["## *수출이 줄었다.* 원인", "## 원인"],
      ["## **수출이 줄었다.** 원인", "## 원인"],
    ] as const)
      expect(cleanReport(h + body, cites), h).toMatchObject({ removed: 1, body: kept + body });
    // A heading that is only a fact inside a link goes, with nothing of its address left.
    expect(cleanReport("## [2026년 수출이 줄었다.](https://example.org/a)" + body, cites)).toMatchObject({
      removed: 1,
      body: "본문이다[1].",
    });
  });

  it("review 7: headings go through the same sentence cleaning as body lines", () => {
    const cites = new Map([cite(1)]);
    const body = "\n\n본문이다[1].";
    // A marker after the period and a space is the first sentence's.
    expect(cleanReport("## 수출이 늘었다. [1] 수입은 줄었다." + body, cites)).toMatchObject({
      removed: 1,
      body: "## 수출이 늘었다. [1]" + body,
    });
    // Two sentences in one bold node: each is checked on its own span.
    expect(cleanReport("## **수출이 늘었다[1]. 수입은 줄었다.**" + body, cites)).toMatchObject({
      removed: 1,
      body: "## **수출이 늘었다[1].**" + body,
    });
    // The same source cited by two sentences: each keeps its marker.
    expect(cleanReport("## 수출이 늘었다[1]. 수입은 줄었다[1]." + body, cites)).toMatchObject({
      removed: 0,
      body: "## 수출이 늘었다[1]. 수입은 줄었다[1]." + body,
    });
  });

  it("review 8: image descriptions are checked, code spans are never touched, emptied wrappers go", () => {
    const cites = new Map([cite(1)]);
    // An image shows its description: an uncited one goes with the image.
    expect(
      cleanReport("올해 수출은 늘었다[1]. ![수입은 두 배 증가했다.](https://example.org/trend.png)", cites),
    ).toMatchObject({ removed: 1, body: "올해 수출은 늘었다[1]." });
    // Nothing removed: the line as written, code span and all.
    expect(cleanReport("파일 존재 여부는 `[ -f report.md ]`로 검사한다[1].", cites)).toMatchObject({
      removed: 0,
      body: "파일 존재 여부는 `[ -f report.md ]`로 검사한다[1].",
    });
    // A wrapper whose sentences all went (a space between them left) goes whole.
    expect(cleanReport("수출이 늘었다[1]. **수입은 줄었다. 매출도 줄었다.**", cites)).toMatchObject({
      removed: 2,
      body: "수출이 늘었다[1].",
    });
    expect(
      cleanReport("수출이 늘었다[1]. [수입은 줄었다. 매출도 줄었다.](https://example.org/a)", cites),
    ).toMatchObject({ removed: 2, body: "수출이 늘었다[1]." });
  });

  it("finds the summary also under a cited 요약 heading", () => {
    expect(summaryOf("## 요약[1]\n\n늘었다[1].\n\n## 다음\n\n본문[2].")).toBe("늘었다.");
  });

  it("gives the writer each file note's verified place", () => {
    const block = notesBlock([{ id: "n1", claim: "c", quote: "q", fileId: "f", page: 3, place: "3쪽" }]);
    expect(block).toContain('"page":3');
    expect(block).toContain('"place":"3쪽"');
  });

  it("keeps a factual heading that has a verified marker", () => {
    const r = cleanReport("## 수출이 32% 늘었다[1]\n\n본문이다[1].", new Map([cite(1)]));
    expect(r).toMatchObject({ removed: 0, body: "## 수출이 32% 늘었다[1]\n\n본문이다[1]." });
  });

  it("renders the report with links only to http(s) pages and page text escaped", () => {
    const md = renderReport({
      title: "보고서 [x](javascript:alert(1))",
      date: "2026-11-19",
      body: "## 요약\n\n늘었다[1].",
      sources: groupSources([
        { ...cite(1)[1], k: 1, title: "제목 ![i](x)", url: "javascript:alert(1)" },
        { ...cite(2)[1], k: 2, kind: "file", title: "자료.pdf", place: "3쪽" },
      ]),
      removed: 1,
      timedOut: true,
      fallback: false,
      unanswered: ["못 찾은 질문"],
      questions: 2,
    });
    // The title verbatim, as code; no link to anything but http(s).
    expect(md).toContain("# `보고서 [x](javascript:alert(1))`");
    expect(markdownHtml(md)).not.toMatch(/href="javascript/);
    // No safe address: the title as code, nothing in it read.
    expect(md).toContain("1. `제목 ![i](x)`");
    expect(md).toContain("2. 📎 `자료.pdf`\n   - `3쪽` — `구절 2`");
    expect(md).toContain("- ⏱ 30분 시간 상한에 걸려 일부만 조사했어요.");
    expect(md).toContain("확인된 근거를 찾지 못한 하위 질문: `못 찾은 질문`");
  });

  it("summarises the 요약 section without markers", () => {
    expect(summaryOf("## 요약\n\n늘었다[1]. 줄었다[2].\n\n## 다음\n\n본문[3].")).toBe("늘었다. 줄었다.");
    expect(summaryOf("## 다른\n\n본문[1].")).toBe("");
  });
});

/** A web citation of page `p` (two passages of one page share its key). */
const onPage = (n: number, p: string, quote: string): [number, ReportCitation] => [
  n,
  {
    n,
    verified: true,
    kind: "web",
    title: `페이지 ${p}`,
    url: `https://example.test/${p}`,
    quote,
    key: reportSourceKey({ url: `https://example.test/${p}` }),
  },
];

describe("one number per source (#233)", () => {
  const cites = new Map([
    onPage(1, "a", "구절 가"),
    onPage(2, "b", "구절 나"),
    onPage(3, "a", "구절 다"),
    onPage(4, "a#x", "구절 라"),
    onPage(5, "a?p=2", "구절 마"),
  ]);

  it("numbers markers by source in order of appearance; a run of markers is written once", () => {
    const r = cleanReport("가[2]. 나[3]. 다[1][3]. 라[2][1]. 마[4]. 바[5].", cites);
    // [1], [3] and [4] are one page (`#x` is no other page); `?p=2` is another.
    expect(r.body).toBe("가[1]. 나[2]. 다[2]. 라[1][2]. 마[2]. 바[3].");
    expect(r.numbering).toEqual([
      { from: 2, to: 1 },
      { from: 3, to: 2 },
      { from: 1, to: 2 },
      { from: 4, to: 2 },
      { from: 5, to: 3 },
    ]);
    const sources = groupSources(r.numbering.map(({ from, to }) => ({ ...cites.get(from)!, k: to })));
    expect(sources.map((x) => [x.k, x.passages.map((p) => p.quote)])).toEqual([
      [1, ["구절 나"]],
      [2, ["구절 다", "구절 가", "구절 라"]],
      [3, ["구절 마"]],
    ]);
  });

  it("writes markers apart only by spaces as one run (review 7)", () => {
    const r = cleanReport("문장[1] [3]. 다음[2]\t[1].", cites);
    expect(r.body).toBe("문장[1]. 다음[2][1].");
    const sources = groupSources(r.numbering.map(({ from, to }) => ({ ...cites.get(from)!, k: to })));
    expect(sources[0]!.passages.map((p) => p.quote)).toEqual(["구절 가", "구절 다"]);
  });

  it("keeps pages the crawler fetched apart as two sources; an address a link would alter is shown, not linked (review 8)", () => {
    const a = "https://x.test/p?q=a\\b";
    const b = "https://x.test/p?q=a%5Cb";
    const v6 = "https://[2606:4700:4700::1111]/page";
    const web = (n: number, title: string, url: string, quote: string): [number, ReportCitation] => [
      n,
      { n, verified: true, kind: "web", title, site: "x.test", url, quote, key: reportSourceKey({ url }) },
    ];
    const cites = new Map([
      web(1, "역슬래시 쪽", a, "구절 하나"),
      web(2, "퍼센트 쪽", b, "구절 둘"),
      // The same final address from two fetches: one source.
      web(3, "IPv6", v6, "구절 셋"),
      web(4, "IPv6", v6, "구절 넷"),
    ]);
    const r = cleanReport("하나[1]. 둘[2]. 셋[3]. 넷[4].", cites);
    expect(r.body).toBe("하나[1]. 둘[2]. 셋[3]. 넷[3].");
    const sources = groupSources(r.numbering.map(({ from, to }) => ({ ...cites.get(from)!, k: to })));
    expect(sources.map((x) => [x.k, x.title, x.passages.map((p) => p.quote)])).toEqual([
      [1, "역슬래시 쪽", ["구절 하나"]],
      [2, "퍼센트 쪽", ["구절 둘"]],
      [3, "IPv6", ["구절 셋", "구절 넷"]],
    ]);
    const md = renderReport({
      title: "t",
      date: "2026-11-22",
      body: r.body,
      sources,
      removed: 0,
      timedOut: false,
      fallback: false,
      unanswered: [],
      questions: 2,
    });
    // The backslash address and the IPv6 one would be altered by a link: shown as text; the other one is linked.
    expect(md).toContain("1. `역슬래시 쪽` — `x.test` — `https://x.test/p?q=a\\b`");
    expect(md).toContain("2. [`퍼센트 쪽`](<https://x.test/p?q=a%5Cb>) — `x.test`");
    expect(md).toContain("3. `IPv6` — `x.test` — `https://[2606:4700:4700::1111]/page`");
    const hrefs = [...markdownHtml(md).matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toEqual([b]);
    // Why: Markdown would not keep the backslash address as it is (a link to it would go to the other page).
    expect(linkedHref(a)).toBeUndefined();
    expect(linkedHref(b)).toBe(b);
    expect(markdownHtml(md)).toContain("<code>https://x.test/p?q=a\\b</code>");
  });

  it("parses nothing in an unlinked entry's title, site and address, and nothing starts math or a link (review 9)", () => {
    const md = renderReport({
      title: "t",
      date: "2026-11-22",
      body: "본문[1].",
      removed: 0,
      timedOut: false,
      fallback: false,
      unanswered: [],
      questions: 1,
      sources: [
        {
          k: 1,
          kind: "web",
          title: "https://example.org/p?q=a\\b",
          site: "www.example.org",
          url: "https://example.org/p?q=a\\b",
          passages: [{ quote: "가격은 US$10, 단위 $20 www.x.org a@b.org https://y.test" }],
        },
        {
          k: 2,
          kind: "web",
          title: "US$10 보고서",
          site: "www.example.org",
          url: "https://x.test/?unit=$20",
          passages: [{ quote: "AT&amp;T" }],
        },
        {
          k: 3,
          kind: "web",
          title: "US$10 `x`",
          site: "a@b.org",
          url: "https://[::1]/?unit=$20",
          passages: [{ quote: "q" }],
        },
      ],
    });
    const html = markdownHtml(md.slice(md.indexOf("## 출처")));
    const items = html.split("<li>").slice(1);
    // Unlinked entries: no link, the code texts are the stored title, site and address.
    for (const [i, codes] of [
      [0, ["https://example.org/p?q=a\\b", "www.example.org", "https://example.org/p?q=a\\b"]],
      [4, ["US$10 `x`", "a@b.org", "https://[::1]/?unit=$20"]],
    ] as const) {
      const head = items[i]!.split("\n")[0]!;
      expect(head).not.toMatch(/<a\s/);
      expect([...head.matchAll(/<code>([^<]*)<\/code>/g)].map((m) => m[1])).toEqual(codes);
    }
    // The linked entry is as before; nothing else links, and no math anywhere.
    expect([...html.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1])).toEqual(["https://x.test/?unit=$20"]);
    // Page text (sites, passages) as code, shown exactly as written; nothing invisible added anywhere.
    expect(html).toContain(
      '<a href="https://x.test/?unit=$20"><code>US$10 보고서</code></a> — <code>www.example.org</code>',
    );
    expect(html).toContain("<code>가격은 US$10, 단위 $20 www.x.org a@b.org https://y.test</code>");
    expect(html).toContain("<code>AT&amp;amp;T</code>");
    expect(html).not.toMatch(/<math|katex/);
    expect(md).not.toMatch(/[\u2060\u200B-\u200D\uFEFF]/);
  });

  it("adds nothing to page text: a secret found later is masked whole; sheet names keep their `+`/`-` (review 10)", () => {
    const secret = `tok@www.${"Zq9".repeat(8)}://x`;
    const md = renderReport({
      title: "t",
      date: "2026-11-22",
      body: "본문[1].",
      removed: 0,
      timedOut: false,
      fallback: false,
      unanswered: [],
      questions: 1,
      sources: [
        {
          k: 1,
          kind: "web",
          title: `제목 ${secret}`,
          site: "www.x.test",
          url: "https://x.test/a",
          passages: [{ quote: `값은 ${secret}이다` }],
        },
        {
          k: 2,
          kind: "file",
          title: "실적.xlsx",
          passages: [
            { quote: "매출", place: "+ 실적" },
            { quote: "비용", place: "- 국내" },
          ],
        },
      ],
    });
    expect(md).not.toMatch(/[\u2060\u200B-\u200D\uFEFF]/);
    // Registered after the report was stored: the stored Markdown's rescan masks every occurrence.
    const reg = new KnownSecrets();
    reg.add(secret);
    expect(md).toContain(secret);
    expect(scrubContent(md, { registry: reg })).not.toContain(secret);
    const html = markdownHtml(md);
    expect(html).toContain("<li><code>+ 실적</code> — <code>매출</code></li>");
    expect(html).toContain("<li><code>- 국내</code> — <code>비용</code></li>");
  });

  it("masks a later secret with `$` and `&` in a linked title; keeps names apart by their Unicode spaces (review 11)", () => {
    const secret = `Ab$Cd&Ef${"Zq9".repeat(8)}`;
    const md = renderReport({
      title: "t",
      date: "2026-11-22",
      body: "본문[1].",
      removed: 0,
      timedOut: false,
      fallback: false,
      unanswered: [],
      questions: 1,
      sources: [
        {
          k: 1,
          kind: "web",
          title: `제목 ${secret}`,
          url: "https://x.test/a",
          passages: [{ quote: "구절" }],
        },
        {
          k: 2,
          kind: "file",
          title: "실적.xlsx",
          passages: [
            { quote: "가", place: "국내 실적" },
            { quote: "나", place: "국내\u3000실적" },
          ],
        },
      ],
    });
    expect(md).toContain(`[\`제목 ${secret}\`](<https://x.test/a>)`);
    const reg = new KnownSecrets();
    reg.add(secret);
    const stored = scrubContent(md, { registry: reg });
    expect(stored).not.toContain(secret);
    const html = markdownHtml(stored);
    expect(html).not.toContain(secret);
    expect(html).toMatch(/<a href="https:\/\/x\.test\/a"><code>제목 [^<]+<\/code><\/a>/);
    expect(markdownHtml(md)).toContain("<li><code>국내 실적</code> — <code>가</code></li>");
    expect(markdownHtml(md)).toContain("<li><code>국내\u3000실적</code> — <code>나</code></li>");
  });

  it("keys sources the same way for the writer's report and the fallback", () => {
    expect(reportSourceKey({ url: "https://example.test/a#x" })).toBe(
      reportSourceKey({ url: "https://example.test/a" }),
    );
    expect(reportSourceKey({ url: "https://example.test/a?p=2" })).not.toBe(
      reportSourceKey({ url: "https://example.test/a" }),
    );
    expect(reportSourceKey({ fileId: "f1", url: "https://x.test" })).toBe("file:f1");
    expect(reportSourceKey({ sourceId: "s1" })).toBe("source:s1");
  });

  it("lists each source once with its passages under it, indented by its number's width (10. and on)", () => {
    const sources = Array.from({ length: 11 }, (_, i) => ({
      k: i + 1,
      kind: "web" as const,
      title: `페이지 ${i + 1}`,
      passages: [{ quote: `구절 ${i + 1}` }, ...(i === 9 ? [{ quote: "둘째 구절" }] : [])],
    }));
    const md = renderReport({
      title: "t",
      date: "2026-11-22",
      body: "본문[1].",
      sources,
      removed: 0,
      timedOut: false,
      fallback: false,
      unanswered: [],
      questions: 2,
    });
    expect(md).toContain(
      "9. `페이지 9`\n   - `구절 9`\n10. `페이지 10`\n    - `구절 10`\n    - `둘째 구절`\n11.",
    );
    expect(md).toContain("보고서에 인용한 출처 11개");
    // One ordered list, every source's passages inside its own item.
    const html = markdownHtml(md);
    expect(html.match(/<ol/g)).toHaveLength(1);
    expect(html).toContain(
      "<li><code>페이지 10</code>\n<ul>\n<li><code>구절 10</code></li>\n<li><code>둘째 구절</code></li>\n</ul>\n</li>",
    );
  });

  it("links each source to exactly its stored address, or shows the original address as code (reviews 12, 13)", () => {
    const urls = [
      "https://x.test/a&sol;b",
      "https://x.test/?a=1&amp;b=2&c=3",
      "https://x.test/a_(b)",
      "https://x.test/a b",
      "https://x.test/a\\b",
      "https://x.test/%E2%9C%93?q=<x>",
      "https://x.test/%E2%9C%93?q=%3Cx%3E",
      "https://x.test/a<x>",
    ];
    const sources = urls.map((url, i) => ({
      k: i + 1,
      kind: "web" as const,
      title: `페이지 ${i + 1}`,
      url,
      passages: [{ quote: "구절" }],
    }));
    const md = renderReport({
      title: "t",
      date: "2026-11-22",
      body: "본문[1].",
      sources,
      removed: 0,
      timedOut: false,
      fallback: false,
      unanswered: [],
      questions: 2,
    });
    const hrefs = [...markdownHtml(md).matchAll(/<a href="([^"]*)"/g)].map((m) =>
      m[1]!
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">"),
    );
    // Linked only where the stored address itself is the URL standard's form and goes in and out verbatim (review 13):
    // anything else (`&sol;`, `&amp;` as entities, a space, a backslash, `<x>`) is shown as code — the original.
    const linked = ["https://x.test/a_(b)", "https://x.test/%E2%9C%93?q=%3Cx%3E"];
    expect(hrefs).toEqual(linked);
    const codes = texts(markdownHtml(md), "code");
    for (const u of urls.filter((x) => !linked.includes(x))) expect(codes).toContain(u);
    // Two different addresses never share a link.
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

/** The text of each element `tag` of rendered HTML (tags inside dropped, entities read). */
const texts = (html: string, tag: string) =>
  [...html.matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "g"))].map((m) =>
    m[1]!
      .replace(/<[^>]+>/g, "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&"),
  );
const hrefsOf = (html: string) =>
  [...html.matchAll(/<a href="([^"]*)"/g)].map((m) => m[1]!.replace(/&quot;/g, '"').replace(/&amp;/g, "&"));

describe("the stored report holds every text verbatim, so a secret found later is masked (review 12)", () => {
  it("masks it in the title, 한계, the fallback's headings, link texts and addresses", () => {
    const tail = "Zq9".repeat(8);
    const secrets = [`Ab$${tail}`, `Cd&${tail}`, `Ef&amp;${tail}`, `Gh\\${tail}`];
    const md = renderReport({
      title: `보고서 ${secrets[0]}`,
      date: "2026-11-22",
      // The fallback's body, as the engine writes it: each sub-question a heading.
      body: `## ${codeSpan(oneLine(`질문 ${secrets[1]}`))}\n\n- ${codeSpan("출처")}: ${codeSpan("구절")} [1]`,
      removed: 0,
      timedOut: false,
      fallback: true,
      unanswered: [`못 찾은 ${secrets[2]}`, `또 ${secrets[3]}`],
      questions: 2,
      sources: [
        {
          k: 1,
          kind: "web",
          title: `링크 ${secrets[1]}`,
          url: `https://x.test/${secrets[0]}/${secrets[1]}`,
          passages: [{ quote: "가" }],
        },
        {
          k: 2,
          kind: "web",
          title: `코드 ${secrets[3]}`,
          url: `https://x.test/${secrets[2]}`,
          passages: [{ quote: "나" }],
        },
      ],
    });
    // Before: every secret is in the stored text as it is.
    for (const x of secrets) expect(md).toContain(x);
    const reg = new KnownSecrets();
    for (const x of secrets) reg.add(x);
    const html = markdownHtml(scrubContent(md, { registry: reg }));
    const shown = [
      ...texts(html, "h1"),
      ...texts(html, "h2"),
      ...texts(html, "li"),
      ...texts(html, "a"),
      ...hrefsOf(html),
    ];
    expect(shown.length).toBeGreaterThan(8);
    for (const t of shown) for (const x of secrets) expect(t, t).not.toContain(x);
    // The rest is there as written.
    expect(texts(html, "h1")[0]).toMatch(/^보고서 /);
    expect(texts(html, "h2").some((t) => t.startsWith("질문 "))).toBe(true);
  });

  it("cuts nothing: long sub-questions, titles and addresses are stored whole; spaces at the ends stay (review 13)", () => {
    const long = `${"가".repeat(290)} 끝-${"Zq9".repeat(3)}`;
    const url = `https://x.test/${"a".repeat(2000)} b`;
    const md = renderReport({
      title: `${"제".repeat(119)}목`,
      date: "2026-11-22",
      body: `## ${codeSpan(oneLine(long))}\n\n- ${codeSpan("출처")}: ${codeSpan("구절")} [1]`,
      removed: 0,
      timedOut: false,
      fallback: true,
      unanswered: [long],
      questions: 1,
      sources: [
        { k: 1, kind: "web", title: long, site: " 앞뒤 공백 ", url, passages: [{ quote: "가" }] },
        { k: 2, kind: "file", title: "f.xlsx", passages: [{ quote: "나", place: " 시트 " }] },
      ],
    });
    expect(md).not.toContain("…");
    const html = markdownHtml(md);
    expect(texts(html, "h1")[0]).toBe(`${"제".repeat(119)}목`);
    expect(texts(html, "h2")).toContain(long);
    const codes = texts(html, "code");
    for (const t of [long, url, " 앞뒤 공백 ", " 시트 "]) expect(codes).toContain(t);
    // Shown with their spaces: inline code keeps white space on the report page (and still wraps).
    expect(MARKDOWN_STYLE).toContain(".md :not(pre)>code{white-space:pre-wrap;overflow-wrap:anywhere}");
  });

  it("writes a code span of spaces only without padding (review 14)", () => {
    expect(codeSpan("  ")).toBe("`  `");
    expect(texts(markdownHtml(`- ${codeSpan("  ")}`), "code")).toEqual(["  "]);
    expect(texts(markdownHtml(`- ${codeSpan(" 시트 ")}`), "code")).toEqual([" 시트 "]);
  });

  it("keeps names verbatim: double spaces in sheet names stay apart", () => {
    const md = renderReport({
      title: "t",
      date: "2026-11-22",
      body: "본문[1].",
      removed: 0,
      timedOut: false,
      fallback: false,
      unanswered: [],
      questions: 1,
      sources: [
        {
          k: 1,
          kind: "file",
          title: "실적  2026.xlsx",
          passages: [
            { quote: "가", place: "국내 실적" },
            { quote: "나", place: "국내  실적" },
          ],
        },
      ],
    });
    const codes = texts(markdownHtml(md), "code");
    expect(codes).toContain("실적  2026.xlsx");
    expect(codes).toContain("국내 실적");
    expect(codes).toContain("국내  실적");
  });
});

describe("what the server reads from the model", () => {
  it("reads a plan (fenced, cut to the limits; no files → the web only) or one clarifying question", () => {
    const p = parsePlan(
      '계획이에요:\n```json\n{"title":"T","estimateMinutes":99,"subQuestions":[' +
        Array.from({ length: 8 }, (_, i) => `{"question":"q${i}","scope":"files"}`).join(",") +
        "]}\n```",
      { hasFiles: false, mayClarify: true },
    );
    expect(p?.kind).toBe("plan");
    if (p?.kind !== "plan") return;
    expect(p.plan.subQuestions).toHaveLength(6);
    expect(p.plan.subQuestions.every((q) => q.scope === "web")).toBe(true);
    expect(p.plan.estimateMinutes).toBe(30);
    expect(parsePlan('{"clarify":"무엇을?"}', { hasFiles: false, mayClarify: true })).toEqual({
      kind: "clarify",
      question: "무엇을?",
    });
    // Asked once already: a second question is no plan.
    expect(parsePlan('{"clarify":"또?"}', { hasFiles: false, mayClarify: false })).toBeUndefined();
    expect(parsePlan("아무것도 아님", { hasFiles: false, mayClarify: true })).toBeUndefined();
  });

  it("reads NOTE lines — also of a step cut off mid-line — and gaps", () => {
    const text = [
      "생각 중…",
      'NOTE {"claim":"가","sourceId":"s1","quote":"구절"}',
      '- NOTE {"claim":"나","fileId":"file:f1","page":3,"quote":"파일 구절"}',
      'NOTE {"claim":"출처 없음","quote":"x"}',
      'NOTE {"claim":"잘림","sourceId":"s2","quo',
    ].join("\n");
    expect(parseNotes(text)).toEqual([
      { claim: "가", claimKey: claimKeyOf("가"), quote: "구절", sourceId: "s1" },
      { claim: "나", claimKey: claimKeyOf("나"), quote: "파일 구절", fileId: "f1", page: 3 },
    ]);
    expect(parseNotes(text, 1)).toHaveLength(1);
    expect(
      parseGaps(
        '{"gaps":[{"question":"a","scope":"files"},{"question":""},{"question":"b"},{"question":"c"},{"question":"d"}]}',
        false,
      ),
    ).toEqual([
      { question: "a", scope: "web" },
      { question: "b", scope: "web" },
      { question: "c", scope: "web" },
    ]);
  });

  it("reads the outline (#233): known note ids only, at least two sections, one line each", () => {
    const ids = new Set(["n1", "n2"]);
    const o = parseOutline(
      `개요예요:\n${JSON.stringify({
        sections: [
          { heading: "## 요약 두 줄", question: "무엇이 바뀌나", notes: ["n1", "n9", "n1"], analysis: "" },
          { heading: "", question: "빈 소제목은 버린다" },
          { heading: "시사점", question: "무엇을 하나", notes: ["n2"], analysis: "상황별 할 일" },
        ],
      })}`,
      ids,
    );
    expect(o).toEqual({
      sections: [
        // Verbatim (reviews 15–16): the writer gets it as framed data.
        { heading: "## 요약 두 줄", question: "무엇이 바뀌나", notes: ["n1"], analysis: "" },
        { heading: "시사점", question: "무엇을 하나", notes: ["n2"], analysis: "상황별 할 일" },
      ],
    });
    expect(parseOutline('{"sections":[{"heading":"하나"}]}', ids)).toBeUndefined();
    // Sections whose notes are all unknown rest on nothing: left out, and too few left is no outline.
    expect(
      parseOutline(
        JSON.stringify({
          sections: [
            { heading: "가", notes: ["x1"], analysis: "a" },
            { heading: "나", notes: ["x2"], analysis: "b" },
            { heading: "다", notes: ["n1"] },
          ],
        }),
        ids,
      ),
    ).toBeUndefined();
    expect(parseOutline("개요 없음", ids)).toBeUndefined();
    const plan = { title: "t", subQuestions: [], estimateMinutes: 1, backend: "claude" as const };
    const turn = writerTurn({ question: "q", plan, notes: [], outline: o });
    expect(turn).toContain(
      "개요 (섹션마다 heading·question·notes·analysis, 이 순서대로 보고서 전체를 한 번에 쓴다):\n",
    );
    expect(turn).toContain('source="research-outline"');
    expect(turn).toContain(JSON.stringify(o!.sections[0]));
    expect(writerTurn({ question: "q", plan, notes: [] })).not.toContain("개요 (");
    expect(outlineTurn({ question: "q", plan, notes: [] }).startsWith("[깊이 조사 · 개요]")).toBe(true);
  });

  it("never cuts an outline field: one too long is left out, a heading with its section (review 14)", () => {
    const ids = new Set(["n1", "n2"]);
    const secret = "Zq9".repeat(4);
    const long = `${"가".repeat(61 - secret.length)}${secret}`;
    const o = parseOutline(
      JSON.stringify({
        sections: [
          { heading: long, question: "질문", notes: ["n1"] },
          { heading: "요약", question: `${"나".repeat(201)}`, notes: ["n1"], analysis: "분석" },
          { heading: "시사점", notes: ["n2"], analysis: `${"다".repeat(301)}` },
          { heading: "배경", notes: ["n2"] },
        ],
      }),
      ids,
    );
    expect(o).toEqual({
      sections: [
        { heading: "요약", question: "", notes: ["n1"], analysis: "분석" },
        { heading: "시사점", question: "", notes: ["n2"], analysis: "" },
        { heading: "배경", question: "", notes: ["n2"], analysis: "" },
      ],
    });
    const plan = { title: "t", subQuestions: [], estimateMinutes: 1, backend: "claude" as const };
    const turn = writerTurn({ question: "q", plan, notes: [], outline: o });
    expect(turn).not.toContain(secret.slice(0, 4));
    expect(turn).not.toContain("가".repeat(10));
  });

  it("checks an outline field's length as written, stripping nothing (review 15)", () => {
    const ids = new Set(["n1"]);
    const o = parseOutline(
      JSON.stringify({
        sections: [
          { heading: `#${"가".repeat(60)}`, notes: ["n1"] },
          { heading: "변동", notes: ["n1"], analysis: "-2% 하락의 뜻" },
          { heading: "> 인용 같은 제목", notes: ["n1"] },
        ],
      }),
      ids,
    );
    expect(o!.sections.map((x) => [x.heading, x.analysis])).toEqual([
      ["변동", "-2% 하락의 뜻"],
      ["> 인용 같은 제목", ""],
    ]);
  });

  it("leaves out an outline field with a line break, and checks length as written (review 16)", () => {
    const ids = new Set(["n1"]);
    const o = parseOutline(
      JSON.stringify({
        sections: [
          { heading: `${"가".repeat(59)}\r\n`, notes: ["n1"] },
          { heading: "줄\n바꿈", notes: ["n1"] },
          { heading: "하나", notes: ["n1"], question: `${"나".repeat(199)}\r\n`, analysis: "분석\r" },
          { heading: "둘", notes: ["n1"], question: "질문", analysis: `${"다".repeat(300)}` },
        ],
      }),
      ids,
    );
    expect(o).toEqual({
      sections: [
        { heading: "하나", question: "", notes: ["n1"], analysis: "" },
        { heading: "둘", question: "질문", notes: ["n1"], analysis: "다".repeat(300) },
      ],
    });
  });

  it("masks an outline field by field, checked again (review 16)", () => {
    const ids = new Set(["n1"]);
    const o = {
      sections: [
        { heading: "요약 SECRET-ABCDEFG", question: "q SECRET-ABCDEFG", notes: ["n1"], analysis: "" },
        { heading: "시사점", question: "", notes: ["n1"], analysis: "a" },
      ],
    };
    const scrub = (t: string) => t.replace(/SECRET-ABCDEFG/g, "[숨김]");
    expect(maskOutline(o, ids, scrub)).toEqual({
      sections: [
        { heading: "요약 [숨김]", question: "q [숨김]", notes: ["n1"], analysis: "" },
        { heading: "시사점", question: "", notes: ["n1"], analysis: "a" },
      ],
    });
    // A mask that makes a heading too long leaves the section out; too few left: no outline.
    expect(maskOutline(o, ids, (t) => t.replace(/SECRET-ABCDEFG/g, "x".repeat(70)))).toBeUndefined();
    expect(maskOutline(undefined, ids, scrub)).toBeUndefined();
  });

  it("keeps the outline keyless in the checkpoint, and reads only that shape back (review 17)", () => {
    const o = {
      sections: [
        { heading: "요약", question: "q", notes: ["n1"], analysis: "" },
        { heading: "시사점", question: "", notes: ["n1", "n2"], analysis: "a" },
      ],
    };
    const stored = storeOutline(o);
    expect(JSON.stringify(stored)).toBe('[["요약","q","",["n1"]],["시사점","","a",["n1","n2"]]]');
    expect(restoreOutline(JSON.parse(JSON.stringify(stored)))).toEqual(o);
    expect(restoreOutline({ sections: o.sections })).toBeUndefined();
    expect(restoreOutline([["요약", "q", ""]])).toBeUndefined();
    expect(restoreOutline(null)).toBeUndefined();
  });

  it("takes notes in turn from each sub-question", () => {
    const s = emptyState();
    const n = (id: string) => ({ id, claim: id, quote: id, sourceId: "s" });
    s.questions = [
      {
        id: "q1",
        question: "1",
        scope: "web",
        round: 0,
        status: "done",
        sources: 1,
        dropped: 0,
        found: [n("a"), n("b"), n("c")],
      },
      {
        id: "q2",
        question: "2",
        scope: "web",
        round: 0,
        status: "done",
        sources: 1,
        dropped: 0,
        found: [n("d")],
      },
    ];
    expect(pickNotes(s, 3).map((x) => x.id)).toEqual(["a", "d", "b"]);
  });
});

describe("the step prompts (versioned like the system instructions)", () => {
  it("has every prompt with its header, numbers filled in", () => {
    const p = loadResearchPrompts();
    for (const id of RESEARCH_PROMPT_IDS) {
      expect(fs.existsSync(path.join(RESEARCH_PROMPTS_DIR, `${id}.md`))).toBe(true);
      expect(p[id].version).toBeGreaterThanOrEqual(1);
      expect(stepPrompt(p, id)).not.toMatch(/\{\{/);
    }
    expect(stepPrompt(p, "subagent")).toContain("최대 12번");
    expect(
      Object.fromEntries(RESEARCH_PROMPT_IDS.map((id) => [id, `${id}@${p[id].version}`])),
    ).toMatchSnapshot();
    expect(stepPrompt(p, "writer")).toMatchSnapshot();
  });
});

/**
 * The report inputs of review rounds 1–8 (#212, the corpus of Codex's 8th and 9th rounds, in their order), `[1]` and
 * `[2]` both verified: what the cleaning makes of each today — body, removed count, numbering — kept as a snapshot,
 * so any change of the rules shows here.
 */
const REVIEW_CORPUS: readonly string[] = [
  "근거 없는 결론이다.검증된 사실이다[1].",
  "## 수출이 50% 늘었다.\n\n본문이다[1].",
  "코드 속 `a[1]`도 아니다.",
  "근거 없는 주장 [참고](/자료/[1])",
  "## 근거 없는 결론이다. 검증된 사실이다[1].\n\n본문이다[1].",
  "수출이 늘었다. [1] 수입도 늘었다.",
  "## 수출이 32% 늘었다[1]\n\n근거 없는 본문이다.",
  "## 수출이 늘었다. 증가 원인\n\n본문이다[1].",
  "근거 없는 주장 <https://example.org/ref/[1]>.",
  "수출이 늘었다[1]. [2](https://example.org)에서 주장했다.",
  "링크를 설명하는 구문은 `[이름](`이다[1].",
  "수출이 늘었다[1].[2](https://example.org)에서 주장했다.",
  "## “수출이 줄었다.” 2026년 통계[1]\n\n본문이다[1].",
  "## (수출이 줄었다.) 증가 원인\n\n본문이다[1].",
  "증가 원인\n---\n\n본문이다[1].",
  "**수출이 늘었다. 증가 원인**\n\n본문이다[1].",
  "## 전력 시장(공급과 수요)\n\n본문이다[1].",
  "## 수출 동향(개요)\n\n본문이다[1].",
  "**증가 원인**:\n\n본문이다[1].",
  "## ~~2026년 수출이 줄었다.~~ 증가 원인\n\n본문이다[1].",
  "## [2026년 수출이 줄었다.](https://example.org/2026)\n\n본문이다[1].",
  "링크 속 표시는 인용이 아니다 [1](https://example.test).",
  "근거 없는 문장이다. 다음도 무인용이다.",
];

describe("cleanReport: the review corpus (#212)", () => {
  it("cleans all 23 inputs as approved in review round 9", () => {
    const cites = new Map([cite(1), cite(2)]);
    expect(REVIEW_CORPUS).toHaveLength(23);
    expect(REVIEW_CORPUS.map((input) => ({ input, ...cleanReport(input, cites) }))).toMatchSnapshot();
  });
});
