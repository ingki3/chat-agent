import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadResearchPrompts,
  notesBlock,
  parseGaps,
  parseNotes,
  parsePlan,
  RESEARCH_PROMPT_IDS,
  RESEARCH_PROMPTS_DIR,
  stepPrompt,
} from "../src/research/prompts.js";
import {
  cleanReport,
  isTopicLabel,
  mdText,
  renderReport,
  type ReportCitation,
} from "../src/research/report.js";
import { pickNotes, summaryOf } from "../src/research/engine.js";
import { emptyState } from "../src/research/store.js";

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
      sources: [
        { ...cite(1)[1], k: 1, title: "제목 ![i](x)", url: "javascript:alert(1)" },
        { ...cite(2)[1], k: 2, kind: "file", title: "자료.pdf", place: "3쪽" },
      ],
      removed: 1,
      timedOut: true,
      fallback: false,
      unanswered: ["못 찾은 질문"],
      questions: 2,
    });
    expect(md).not.toContain("](javascript");
    expect(md).toContain("# 보고서 \\[x\\]\\(javascript:alert\\(1\\)\\)");
    expect(md).toContain("1. 제목 \\!\\[i\\]\\(x\\)");
    expect(md).toContain("2. 📎 자료.pdf · 3쪽 — “구절 2”");
    expect(md).toContain("- ⏱ 30분 시간 상한에 걸려 일부만 조사했어요.");
    expect(md).toContain("확인된 근거를 찾지 못한 하위 질문: 못 찾은 질문");
    expect(mdText("a\nb   c")).toBe("a b c");
  });

  it("summarises the 요약 section without markers", () => {
    expect(summaryOf("## 요약\n\n늘었다[1]. 줄었다[2].\n\n## 다음\n\n본문[3].")).toBe("늘었다. 줄었다.");
    expect(summaryOf("## 다른\n\n본문[1].")).toBe("");
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
      { claim: "가", quote: "구절", sourceId: "s1" },
      { claim: "나", quote: "파일 구절", fileId: "f1", page: 3 },
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
