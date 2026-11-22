import { describe, expect, it } from "vitest";
import { sourceTypeOf } from "@agentlee/shared";
import {
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

  it("match: only the form differs — punctuation, spacing, quote marks, an ellipsis, subject/object particles", () => {
    expect(
      closestPassage(
        page,
        "“산업통상자원부는 10일, 10 월 반도체 수출은 전년 같은 달보다 32% 늘어난 142억 달러로 집계됐다고 밝혔다”",
      ),
    ).toEqual({
      kind: "match",
      passage:
        "산업통상자원부는 10일 10월 반도체 수출이 전년 같은 달보다 32% 늘어난 142억 달러로 집계됐다고 밝혔다",
    });
    // Two consecutive sentences the model joined with "…".
    expect(
      closestPassage(page, "메모리 가격 회복이 증가를 이끌었다 … 업계는 연말까지 증가세가 이어질 것으로"),
    ).toEqual({
      kind: "match",
      passage: "메모리 가격 회복이 증가를 이끌었다. 업계는 연말까지 증가세가 이어질 것으로",
    });
  });

  it("none: a different meaning is never repaired — negation, subject, sign, unit, word order, meaningful particles", () => {
    const facts =
      "정부는 내년부터 지원금을 지급하지 않는다고 밝혔다.\n부산시는 2026년 예산을 늘린다고 밝혔다.\n" +
      "수출은 전년보다 −5% 줄었다.\n서울보다 부산이 인구가 적다.\n물가는 3% 올랐다.";
    for (const quote of [
      "정부는 내년부터 지원금을 지급한다고 밝혔다",
      "서울시는 2026년 예산을 늘린다고 밝혔다",
      "수출은 전년보다 +5% 줄었다",
      "수출은 전년보다 5% 줄었다",
      "물가는 3%p 올랐다",
      "부산보다 서울이 인구가 적다",
      "서울까지 부산이 인구가 적다",
      "10월 반도체 수출이 전년 같은 달보다 50% 늘어난 142억 달러",
    ])
      expect(closestPassage(`${page}\n${facts}`, quote), quote).toEqual({ kind: "none" });
    // Too short to say anything.
    expect(closestPassage(page, "수출 증가")).toEqual({ kind: "none" });
    // Words left out in between (a summary, not a quote).
    expect(closestPassage(page, "산업통상자원부는 반도체 수출이 32% 늘었다고 밝혔다")).toEqual({
      kind: "none",
    });
  });

  it("ambiguous: the words stand in two different passages — neither is taken; the same passage twice is one", () => {
    const twins = "서울시는 예산을 늘린다고 밝혔다.\n서울시가 예산을 늘린다고 밝혔다.";
    expect(closestPassage(twins, "서울시, 예산을 늘린다고 밝혔다")).toEqual({ kind: "ambiguous" });
    const same = "서울시는 2026년 예산을 늘린다고 밝혔다.\n서울시는 2026년 예산을 늘린다고 밝혔다.";
    expect(closestPassage(same, "서울시는 2026년, 예산을 늘린다고 밝혔다")).toEqual({
      kind: "match",
      passage: "서울시는 2026년 예산을 늘린다고 밝혔다",
    });
  });

  it("never across a PDF page that was not read; the exact check cannot either", () => {
    const pdf = `1쪽 끝에 정부는 지원금을\n\n${PAGE_GAP}\n\n내년부터 지급한다고 밝혔다.`;
    expect(closestPassage(pdf, "정부는 지원금을 내년부터 지급한다고 밝혔다")).toEqual({ kind: "none" });
    expect(findSnippet(pdf, "정부는 지원금을 내년부터 지급한다고 밝혔다").found).toBe(false);
  });

  it("numbers keep their sign, value and unit in order", () => {
    expect(numberFacts("수출은 −5%, 수입은 +3.5%p, 1,234 명, 142억 달러")).toEqual([
      "-5%",
      "+3.5%p",
      "1234명",
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

  it("unverified claims: earlier and new, once, without those now backed, at most five", () => {
    expect(mergeUnverified(["x", "y  z"], ["y z", "w"], [n("1", "A", "x")])).toEqual(["y  z", "w"]);
    expect(mergeUnverified(["a", "b", "c"], ["d", "e", "f"], [])).toEqual(["a", "b", "c", "d", "e"]);
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
