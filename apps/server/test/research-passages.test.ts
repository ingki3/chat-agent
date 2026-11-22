import { describe, expect, it } from "vitest";
import { sourceTypeOf } from "@agentlee/shared";
import {
  claimFitsPassage,
  closestPassage,
  findPassages,
  numberFacts,
  PAGE_GAP,
  sentenceRanges,
  termsOf,
} from "../src/citations/passages.js";
import { findSnippet } from "../src/citations/verify.js";
import { mergeNotes, mergeUnverified } from "../src/research/engine.js";
import type { ResearchNote } from "../src/research/store.js";
import { pdfTitle } from "../src/web/service.js";

/**
 * 깊이 조사의 조사 한계 (#234), the pure parts — no port, no fixture site: passages (`web_find`, the note repair),
 * the retry's merges, a PDF's title, the source type.
 */

describe("web_find passages", () => {
  it("findPassages: best first, no overlaps, context bounded", () => {
    const text =
      "가격이 올랐다. 수출이 늘었다.\n반도체 수출이 32% 늘었다. 메모리 가격이 회복됐다.\n" +
      "다른 이야기다. ".repeat(50) +
      "반도체 수출 증가는 메모리 가격 회복 덕분이다.";
    const r = findPassages(text, "반도체 수출", 5);
    expect(r.passages[0]!.phrase).toBe(true);
    expect(r.passages.map((p) => p.text.includes("반도체 수출"))).toEqual(r.passages.map(() => true));
    for (const [i, a] of r.passages.entries())
      for (const b of r.passages.slice(i + 1)) expect(a.end <= b.start || b.end <= a.start).toBe(true);
    for (const p of r.passages) expect(p.text.length).toBeLessThanOrEqual(700);
    expect(findPassages(text, "   ", 5)).toEqual({ total: 0, passages: [] });
  });
});

describe("the closest passage for a quote that did not verify (#234 note repair)", () => {
  const page =
    "산업통상자원부는 10일 10월 반도체 수출이 전년 같은 달보다 32% 늘어난 142억 달러로 집계됐다고 밝혔다.\n" +
    "메모리 가격 회복이 증가를 이끌었다. 업계는 연말까지 증가세가 이어질 것으로 본다.";

  it("match (b): a space added or left out between a digit and a Hangul syllable — nothing else", () => {
    expect(
      closestPassage(
        page,
        "“산업통상자원부는 10일 10 월 반도체 수출이 전년 같은 달보다 32% 늘어난 142억 달러로 집계됐다고 밝혔다”",
      ),
    ).toEqual({
      kind: "match",
      passage:
        "산업통상자원부는 10일 10월 반도체 수출이 전년 같은 달보다 32% 늘어난 142억 달러로 집계됐다고 밝혔다",
    });
    expect(closestPassage("상자 3 개를 샀다고 밝혔다.", "상자 3개를 샀다고 밝혔다")).toEqual({
      kind: "match",
      passage: "상자 3 개를 샀다고 밝혔다",
    });
  });

  it("match (a): … joining consecutive sentences, each piece exact (a sentence's end, then whole sentences)", () => {
    expect(
      closestPassage(
        page,
        "메모리 가격 회복이 증가를 이끌었다 … 업계는 연말까지 증가세가 이어질 것으로 본다",
      ),
    ).toEqual({
      kind: "match",
      passage: "메모리 가격 회복이 증가를 이끌었다. 업계는 연말까지 증가세가 이어질 것으로 본다.",
    });
    // The first piece may start inside its sentence (at a word).
    expect(
      closestPassage(page, "가격 회복이 증가를 이끌었다. … 업계는 연말까지 증가세가 이어질 것으로 본다."),
    ).toEqual({
      kind: "match",
      passage: "가격 회복이 증가를 이끌었다. 업계는 연말까지 증가세가 이어질 것으로 본다.",
    });
  });

  it("none (review #237 3차): spaces between digits or next to symbols, a decimal point as …, partial pieces", () => {
    const facts = [
      "선수들의 출발 순서는 1 2 12 순이다.",
      "허용 길이는 3.5미터이다.",
      "수식의 조건은 x! = y 이다.",
      "The selector is .menu .item in this stylesheet.",
      "표시 가격은 32% 늘었다.",
      "기간은 2026–2027년이다.",
      "첫 문장이다. 둘째 문장이다. 셋째 문장이다.",
    ].join("\n");
    for (const quote of [
      "선수들의 출발 순서는 12 1 2 순이다",
      "허용 길이는 3…5미터이다",
      "허용 길이는 3 … 5미터이다",
      "수식의 조건은 x != y 이다",
      "The selector is .menu.item in this stylesheet",
      "표시 가격은 32 % 늘었다",
      "기간은 2026 - 2027년이다",
      // The last piece is not a whole sentence; the pieces are not consecutive sentences.
      "메모리 가격 회복이 증가를 이끌었다 … 업계는 연말까지 증가세가",
      "첫 문장이다 … 셋째 문장이다",
      // The first piece does not end its sentence.
      "첫 문장 … 둘째 문장이다",
    ])
      expect(closestPassage(`${page}\n${facts}`, quote), quote).toEqual({ kind: "none" });
  });

  it("none: any other difference — particles, case, hyphens in a word, currency, comparison, sign, unit, words", () => {
    const facts = [
      "정부는 내년부터 지원금을 지급하지 않는다고 밝혔다.",
      "부산시는 2026년 예산을 늘린다고 밝혔다.",
      "수출은 전년보다 −5% 줄었다.",
      "원고가 피고를 먼저 고소했다.",
      "이 상품의 가격은 $50 이상이다.",
      "올해 지원 기준은 소득 < 500만원이다.",
      "이 기체의 성분은 CO 라고 밝혔다.",
      "We agreed to resign today.",
      "아버지 가방에 들어가신다.",
      "서울보다 부산이 인구가 적다.",
      "물가는 3% 올랐다.",
    ].join("\n");
    for (const quote of [
      "정부는 내년부터 지원금을 지급한다고 밝혔다",
      "서울시는 2026년 예산을 늘린다고 밝혔다",
      "수출은 전년보다 +5% 줄었다",
      "수출은 전년보다 5% 줄었다",
      "원고를 피고가 먼저 고소했다",
      "이 상품의 가격은 €50 이상이다",
      "올해 지원 기준은 소득 > 500만원이다",
      "이 기체의 성분은 Co 라고 밝혔다",
      "We agreed to re-sign today",
      "아버지가 방에 들어가신다",
      "부산보다 서울이 인구가 적다",
      "물가는 3%p 올랐다",
      // A particle is a word too now: 수출은 is not 수출이.
      "10월 반도체 수출은 전년 같은 달보다 32% 늘어난 142억 달러로",
      // Words left out in between (a summary, not a quote).
      "산업통상자원부는 반도체 수출이 32% 늘었다고 밝혔다",
      // Two sentences joined where the page has no sentence end.
      "산업통상자원부는 10일 … 10월 반도체 수출이",
    ])
      expect(closestPassage(`${page}\n${facts}`, quote), quote).toEqual({ kind: "none" });
    expect(closestPassage(page, "수출")).toEqual({ kind: "none" });
  });

  it("ambiguous: two different places of the page; the same passage twice is one", () => {
    const twins = "10 월 수출이 늘었다고 밝혔다.\n10월 수출이 늘었다고 밝혔다.";
    expect(closestPassage(twins, "10월  수출이 늘었다고")).toEqual({ kind: "ambiguous" });
    const same = "서울시는 2026년 예산을 늘린다고 밝혔다.\n서울시는 2026년 예산을 늘린다고 밝혔다.";
    expect(closestPassage(same, "서울시는 2026 년 예산을 늘린다고 밝혔다")).toEqual({
      kind: "match",
      passage: "서울시는 2026년 예산을 늘린다고 밝혔다",
    });
  });

  it("never across a PDF page that was not read — the repair, the exact check and web_find alike", () => {
    const pdf = `1쪽 끝 문장이다. 정부는 지원금을\n\n${PAGE_GAP}\n\n내년부터 지급한다고 밝혔다. 3쪽 문장이다.`;
    expect(closestPassage(pdf, "정부는 지원금을 내년부터 지급한다고 밝혔다")).toEqual({ kind: "none" });
    expect(findSnippet(pdf, "정부는 지원금을 내년부터 지급한다고 밝혔다").found).toBe(false);
    // Even a snippet that copies the mark itself.
    expect(findSnippet(pdf, `정부는 지원금을 ${PAGE_GAP} 내년부터 지급한다고 밝혔다`).found).toBe(false);
    expect(findSnippet(pdf, "내년부터 지급한다고 밝혔다").found).toBe(true);
    // Not on any part of the mark either (review #237 3차).
    const meeting = `회의는 여기까지 진행했다.\n\n${PAGE_GAP}\n\n다음 회의는 내일 열린다.`;
    expect(findSnippet(meeting, "회의는 여기까지 진행했다. [읽지 못한").found).toBe(false);
    expect(findSnippet(meeting, "못한 쪽] 다음 회의는 내일 열린다").found).toBe(false);
    expect(findSnippet(meeting, "읽지 못한 쪽").found).toBe(false);
    expect(findSnippet(meeting, "다음 회의는 내일 열린다").found).toBe(true);
    const found = findPassages(pdf, "지원금 지급", 5).passages;
    expect(found.length).toBeGreaterThan(0);
    for (const p of found) expect(p.text).not.toContain(PAGE_GAP);
    expect(findPassages(pdf, "읽지 못한 쪽", 5).passages).toEqual([]);
  });

  it("a repaired passage keeps only a claim whose numbers and signs it has", () => {
    const passage = "이 상품의 가격은 $50 이상이고 수출은 −5% 줄었다";
    expect(claimFitsPassage("가격은 $50 이상, 수출 −5%", passage)).toBe(true);
    expect(claimFitsPassage("가격은 €50 이상", passage)).toBe(false);
    expect(claimFitsPassage("수출은 5% 늘었다", passage)).toBe(false);
    expect(claimFitsPassage("수출은 -7% 줄었다", passage)).toBe(false);
    expect(claimFitsPassage("가격은 50 > 기준", passage)).toBe(false);
    // Any symbol (Unicode S*), not a hand list (review #237 3차).
    expect(claimFitsPassage("표시 가격은 ₹50 이상이다", "표시 가격은 50 이상이다")).toBe(false);
    expect(claimFitsPassage("측정값은 ≠ 50 이다", "측정값은 기준값 50 부근이다")).toBe(false);
    expect(claimFitsPassage("측정값은 50 부근이다", "측정값은 기준값 50 부근이다")).toBe(true);
  });

  it("numbers keep their sign, value and unit in order", () => {
    expect(numberFacts("수출은 −5%, 수입은 +3.5%p, 1,234 명, 142억 달러")).toEqual([
      "-5%",
      "+3.5%p",
      "1234",
      "142억",
    ]);
  });

  it("sentences: split at line breaks and sentence ends, not inside numbers or dates; long ones cut at clauses", () => {
    const t = "2026. 11. 12. 발표했다. 금리는 3.5%다! 다음 줄\n둘째 줄";
    expect(sentenceRanges(t).map((r) => t.slice(r.start, r.end))).toEqual([
      "2026. 11. 12.",
      "발표했다.",
      "금리는 3.5%다!",
      "다음 줄",
      "둘째 줄",
    ]);
    const long = `${"가나다라 ".repeat(60)}, ${"마바사 ".repeat(60)}`;
    expect(sentenceRanges(long).every((r) => r.end - r.start <= 400)).toBe(true);
    expect(termsOf("수출이 반도체를 Node.js로")).toEqual(["수출", "반도체", "node", "js"]);
  });
});

describe("a retry's merges (#234)", () => {
  const n = (id: string, sourceId: string, claim = id): ResearchNote => ({
    id,
    claim,
    quote: `q-${id}`,
    sourceId,
  });

  it("notes: duplicates once; every source the retry newly found keeps a place within the cap", () => {
    const a = Array.from({ length: 12 }, (_, i) => n(`a${i}`, "A"));
    const merged = mergeNotes(a, [n("a0", "A"), n("b1", "B"), n("b2", "B"), n("c1", "C")], 12);
    expect(merged).toHaveLength(12);
    expect(merged.filter((x) => x.sourceId === "B").map((x) => x.id)).toEqual(["b1"]);
    expect(merged.filter((x) => x.sourceId === "C").map((x) => x.id)).toEqual(["c1"]);
    expect(merged.filter((x) => x.sourceId === "A")).toHaveLength(10);
    // Under the cap: everything, in order, once.
    expect(mergeNotes([n("a0", "A")], [n("a0", "A"), n("b1", "B")], 12).map((x) => x.id)).toEqual([
      "a0",
      "b1",
    ]);
  });

  it("unverified claims: dedupe, then cap; the whole claim is the key; removed only when a kept note backs it", () => {
    expect(mergeUnverified(["x", "y  z"], ["y z", "w"], [n("1", "A", "x")])).toEqual(["y z", "w"]);
    expect(mergeUnverified(["a", "b", "c"], ["d", "e", "f"], [])).toEqual(["a", "b", "c", "d", "e"]);
    // Five copies of one claim do not crowd out another.
    expect(mergeUnverified(["a", "a", "a", "a", "a"], ["b"], [])).toEqual(["a", "b"]);
    // A long claim kept cut to 300 characters is the same claim when a later note backs it whole.
    // The whole claim is its identity (review #237 3차): the same first 300 characters, different endings.
    const stem = "가".repeat(300);
    const yes = `${stem} 승인하였다`;
    const no = `${stem} 거부하였다`;
    expect(mergeUnverified([yes, no], [], [n("1", "A", yes)])).toEqual([no]);
    expect(mergeUnverified([], [yes], [])).toEqual([yes]);
    // A retry that found nothing keeps what failed before.
    expect(mergeUnverified(["a"], [], [])).toEqual(["a"]);
  });
});

describe("a PDF's title", () => {
  it("a PDF's title is its file name when it has none", () => {
    expect(pdfTitle(new URL("https://www.kcue.or.kr/down/2027%20plan.pdf"))).toBe("2027 plan.pdf");
    expect(pdfTitle(new URL("https://example.org/"))).toBeUndefined();
    expect(pdfTitle(new URL("https://example.org/%E0%A4%A.pdf"))).toBe("%E0%A4%A.pdf");
  });
});

describe("source type by domain (#234)", () => {
  it("government, academic, organization, other", () => {
    expect(
      [
        "https://www.moe.go.kr/a.pdf",
        "https://www.whitehouse.gov/",
        "https://www.gov.uk/x",
        "https://ec.europa.eu/",
        "https://www.snu.ac.kr/",
        "https://www.kice.re.kr/",
        "https://mit.edu/",
        "https://www.ox.ac.uk/",
        "https://www.kcue.or.kr/",
        "https://wikipedia.org/",
        "https://blog.naver.com/",
        "https://ac.example.com/",
        "not a url",
      ].map(sourceTypeOf),
    ).toEqual([
      "government",
      "government",
      "government",
      "government",
      "academic",
      "academic",
      "academic",
      "academic",
      "organization",
      "organization",
      "other",
      "other",
      "other",
    ]);
  });
});
