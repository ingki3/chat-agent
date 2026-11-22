import { describe, expect, it } from "vitest";
import { sourceTypeOf } from "@agentlee/shared";
import { findPassages, PAGE_GAP, sentenceRanges, termsOf } from "../src/citations/passages.js";
import {
  cutOutsideGap,
  findSnippet,
  findSnippetAt,
  GAP_MARK,
  gapRanges,
  hasGapMarks,
  stripGapMarks,
  touchesGap,
  visibleIndex,
} from "../src/citations/verify.js";
import { parseNotes, subagentTurn } from "../src/research/prompts.js";
import { claimKeyOf } from "../src/research/store.js";
import { mergeNotes, mergeUnverified } from "../src/research/engine.js";
import type { ResearchNote } from "../src/research/store.js";
import { pdfTitle } from "../src/web/service.js";

/**
 * 깊이 조사의 조사 한계 (#234), the pure parts — no port, no fixture site: passages (`web_find`), PDF page marks,
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
    // A phrase across the split of a long sentence without spaces (400 characters a piece) is still found.
    const solid = `${"가".repeat(396)}대학입학전형시행계획${"나".repeat(50)}`;
    expect(solid.length).toBe(456);
    const hit = findPassages(solid, "대학입학전형시행계획", 5);
    expect(hit.total).toBe(1);
    expect(hit.passages[0]!.phrase).toBe(true);
    expect(hit.passages[0]!.text).toContain("대학입학전형시행계획");
  });
});

describe("PDF pages that were not read (#234 PAGE_GAP)", () => {
  /** A web PDF's text as the PDF reader stored it: its marks hold (`hasGapMarks`). */
  const G = { gaps: true } as const;

  it("no match stands on any part of the mark or across it — the exact check and web_find alike", () => {
    const pdf = `1쪽 끝 문장이다. 정부는 지원금을\n\n${PAGE_GAP}\n\n내년부터 지급한다고 밝혔다. 3쪽 문장이다.`;
    expect(findSnippet(pdf, "정부는 지원금을 내년부터 지급한다고 밝혔다", undefined, G).found).toBe(false);
    expect(
      findSnippet(pdf, "정부는 지원금을 [읽지 못한 쪽] 내년부터 지급한다고 밝혔다", undefined, G).found,
    ).toBe(false);
    expect(findSnippet(pdf, "내년부터 지급한다고 밝혔다", undefined, G).found).toBe(true);
    const meeting = `회의는 여기까지 진행했다.\n\n${PAGE_GAP}\n\n다음 회의는 내일 열린다.`;
    expect(findSnippet(meeting, "회의는 여기까지 진행했다. [읽지 못한", undefined, G).found).toBe(false);
    expect(findSnippet(meeting, "못한 쪽] 다음 회의는 내일 열린다", undefined, G).found).toBe(false);
    expect(findSnippet(meeting, "읽지 못한 쪽", undefined, G).found).toBe(false);
    expect(findSnippet(meeting, "다음 회의는 내일 열린다", undefined, G).found).toBe(true);
    const found = findPassages(pdf, "지원금 지급", 5, G).passages;
    expect(found.length).toBeGreaterThan(0);
    for (const p of found) {
      expect(p.text).not.toContain(GAP_MARK);
      expect(p.text).not.toContain("읽지 못한");
    }
    expect(findPassages(pdf, "읽지 못한 쪽", 5, G).passages).toEqual([]);
  });

  it('a page that merely says "[읽지 못한 쪽]" is ordinary text (no mark without the reader\'s U+E000)', () => {
    const plain = "화면에는 [읽지 못한 쪽]이라는 안내가 뜹니다.";
    expect(findSnippet(plain, "화면에는 [읽지 못한 쪽]이라는 안내가 뜹니다.").found).toBe(true);
    expect(touchesGap(plain, 0, plain.length)).toBe(false);
    expect(stripGapMarks(`a${GAP_MARK}b`)).toBe("ab");
  });

  it("anything else (an attachment, another page) treats U+E000 as ordinary text — even an unpaired one", () => {
    const attachment = `회의 메모${GAP_MARK}\n다음 회의는 내일 열린다.`;
    expect(findSnippetAt(attachment, "다음 회의는 내일 열린다").found).toBe(true);
    expect(findSnippet(attachment, "다음 회의는 내일 열린다", undefined, G).found).toBe(false);
    expect(hasGapMarks("application/pdf")).toBe(true);
    expect(hasGapMarks("text/html")).toBe(false);
    expect(hasGapMarks(null)).toBe(false);
    // Only a web PDF's search honours the marks.
    expect(findPassages(attachment, "다음 회의", 5).passages).toHaveLength(1);
  });

  it("visible counts and places leave the marks' U+E000 out", () => {
    const text = `앞 문장이다.\n\n${PAGE_GAP}\n\n뒤 문장이다.`;
    const at = text.indexOf("뒤");
    expect(visibleIndex(text, at)).toBe(stripGapMarks(text).indexOf("뒤"));
    expect(visibleIndex(text, text.length)).toBe(stripGapMarks(text).length);
    expect(visibleIndex("가나다", 2)).toBe(2);
  });

  it("the stored bound never cuts a mark in two: the cut moves before it", () => {
    const text = `${"가".repeat(90)}\n\n${PAGE_GAP}\n\n${"나".repeat(50)}`;
    const at = 92 + 4; // inside the mark
    const cut = cutOutsideGap(text, at);
    expect(cut).toBe("가".repeat(90));
    expect(gapRanges(cut)).toEqual([]);
    expect(cutOutsideGap(text, 200)).toBe(text);
    expect(cutOutsideGap(text, 50)).toBe("가".repeat(50));
    // A cut past the mark keeps it whole.
    const past = cutOutsideGap(text, 92 + PAGE_GAP.length + 5);
    expect(gapRanges(past)).toHaveLength(1);
    expect(past).toContain(PAGE_GAP);
  });
});

describe("passages", () => {
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
    const u = (claim: string) => ({ key: claimKeyOf(claim), claim });
    const texts = (xs: { claim: string }[]) => xs.map((x) => x.claim);
    expect(texts(mergeUnverified([u("x"), u("y  z")], [u("y z"), u("w")], [n("1", "A", "x")]))).toEqual([
      "y  z",
      "w",
    ]);
    expect(texts(mergeUnverified([u("a"), u("b"), u("c")], [u("d"), u("e"), u("f")], []))).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    // Five copies of one claim do not crowd out another.
    expect(texts(mergeUnverified([u("a"), u("a"), u("a"), u("a"), u("a")], [u("b")], []))).toEqual([
      "a",
      "b",
    ]);
    // An older checkpoint's plain texts.
    expect(texts(mergeUnverified(["a"], [], []))).toEqual(["a"]);
  });

  it("claims that share their first 500 characters are two claims (the identity is the whole claim)", () => {
    const stem = "가".repeat(500);
    const line = (claim: string) =>
      `NOTE ${JSON.stringify({ claim, sourceId: "s1", quote: "인용 구절입니다." })}`;
    const [yes, no] = parseNotes([line(`${stem} 승인하였다`), line(`${stem} 거부하였다`)].join("\n"));
    expect(yes!.claim).toBe(no!.claim); // the same 500 characters shown
    expect(yes!.claimKey).not.toBe(no!.claimKey);
    const kept = mergeUnverified(
      [],
      [yes!, no!].map((r) => ({ key: r.claimKey, claim: r.claim })),
      [{ ...n("1", "s1", yes!.claim), claimKey: yes!.claimKey }],
    );
    expect(kept.map((k) => k.key)).toEqual([no!.claimKey]);
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

describe("a retry's hints name only its scope's tools (#234)", () => {
  const plan = { title: "t", subQuestions: [], estimateMinutes: 5, backend: "claude" as const };
  const turn = (scope: "web" | "files" | "both") =>
    subagentTurn({
      question: "q",
      plan,
      sub: { id: "q1", question: "하위", scope },
      files: [{ id: "f1", name: "메모.txt" }],
      retry: { found: [], unverified: ["확인 못 한 주장"] },
    });
  it("files only: file_search and file_read, never a web tool", () => {
    const t = turn("files");
    expect(t).toContain("file_search");
    expect(t).not.toMatch(/web_(find|fetch|search)/);
  });
  it("web and both", () => {
    expect(turn("web")).toContain("web_find");
    expect(turn("web")).not.toContain("file_search");
    expect(turn("both")).toContain("web_find");
    expect(turn("both")).toContain("file_search");
  });
});

describe("web_find review #237 6차", () => {
  it("a phrase in a stretch longer than a passage: the passage holds all of it, context around it", () => {
    const body = `${"가".repeat(389)}대학입학전형 시행계획${"나".repeat(400)}`;
    const r = findPassages(body, "대학입학전형 시행계획", 5);
    expect(r.total).toBe(1);
    const p = r.passages[0]!;
    expect(p.phrase).toBe(true);
    expect(p.text).toContain("대학입학전형 시행계획");
    expect(p.end - p.start).toBeLessThanOrEqual(700);
    expect(p.start).toBeGreaterThan(0);
    expect(p.end).toBeLessThan(body.length);
  });

  it("a decomposed (NFD) page matches a composed query — alone and across the old 400-character split", () => {
    const phrase = "대학입학전형시행계획";
    const nfd = phrase.normalize("NFD");
    const alone = `올해 ${nfd}을 발표했다.`;
    const one = findPassages(alone, phrase, 5);
    expect(one.passages[0]!.phrase).toBe(true);
    expect(one.passages[0]!.text.normalize("NFC")).toContain(phrase);
    const solid = `${"가".repeat(396)}${nfd}${"나".repeat(50)}`;
    const across = findPassages(solid, phrase, 5);
    expect(across.total).toBe(1);
    expect(across.passages[0]!.phrase).toBe(true);
    expect(across.passages[0]!.text.normalize("NFC")).toContain(phrase);
  });

  it("another page's own U+E000 stays in the passage, which then verifies as it stands", () => {
    const body = `이 문서의 기호는 A${GAP_MARK}B로 표시한다.`;
    const [p] = findPassages(body, "기호", 5).passages;
    expect(p!.text).toContain(GAP_MARK);
    expect(findSnippet(body, p!.text).found).toBe(true);
  });

  it("a long PDF with many marks and many matches is searched and checked quickly (marks once per search)", () => {
    const page = "신청 기간은 9월이다. 신청 방법은 누리집에서 한다. ".repeat(60);
    const text = Array.from({ length: 90 }, () => page).join(`\n\n${PAGE_GAP}\n\n`);
    expect(text.length).toBeGreaterThan(150_000);
    let t0 = performance.now();
    const r = findPassages(text, "신청", 8, { gaps: true });
    const search = performance.now() - t0;
    expect(r.total).toBeGreaterThan(1000);
    t0 = performance.now();
    findSnippet(text, "신청 방법은 누리집에서 한다", undefined, { gaps: true });
    findSnippet(text, "없는 문장이 하나 있다고 한다", undefined, { gaps: true });
    const check = performance.now() - t0;
    // Generous bounds for a laptop under test load (before: ~400 ms for the search alone).
    expect(search).toBeLessThan(250);
    expect(check).toBeLessThan(250);
  });
});

describe("web_find review #237 7차", () => {
  it("a match ending in a surrogate pair keeps it whole", () => {
    const body = "일정은 확인 𠮷 표시로 알린다. 달력 📅 아이콘도 있다.";
    const a = findPassages(body, "확인 𠮷", 5).passages[0]!;
    expect(a.phrase).toBe(true);
    expect(a.text).toContain("확인 𠮷");
    const b = findPassages(body, "달력 📅", 5).passages[0]!;
    expect(b.text).toContain("📅");
    // No lone surrogate anywhere in what comes back.
    for (const t of [a.text, b.text]) expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(t)).toBe(false);
  });

  it("Greek capitals with a final sigma match the same way in the query and the page, across the split too", () => {
    const solid = `${"α".repeat(396)}ΣΟΦΟΣ${"β".repeat(50)}`;
    for (const q of ["ΣΟΦΟΣ", "σοφος", "σοφοσ"]) {
      const r = findPassages(solid, q, 5);
      expect(r.total, q).toBe(1);
      expect(r.passages[0]!.phrase, q).toBe(true);
      expect(r.passages[0]!.text, q).toContain("ΣΟΦΟΣ");
    }
  });
});

describe("review #237 8차", () => {
  const k = (id: string, sourceId: string, sourceKey: string, quote: string): ResearchNote => ({
    id,
    claim: id,
    quote,
    sourceId,
    sourceKey,
  });

  it("one passage of one page reached by two URLs takes one slot; a new passage of that page still fits", () => {
    const before = Array.from({ length: 11 }, (_, i) => k(`a${i}`, "A1", "u:A", `구절 ${i}`));
    const merged = mergeNotes(
      before,
      [k("dup", "A2", "u:A", "구절  0"), k("new", "A2", "u:A", "새 구절")],
      12,
    );
    expect(merged).toHaveLength(12);
    expect(merged.map((n) => n.id)).toContain("new");
    expect(merged.map((n) => n.id)).not.toContain("dup");
    // The first kept note keeps its source id.
    expect(merged.find((n) => n.quote === "구절 0")!.sourceId).toBe("A1");
  });

  it("the query's words are folded like the page's (a Greek final sigma in the keyword path)", () => {
    const r = findPassages("ΤΟ ΚΟΣΜΟΣ ΕΙΝΑΙ ΜΕΓΑΛΟΣ.", "ΚΟΣΜΟΣ ΑΛΛΟ", 5);
    expect(r.total).toBe(1);
    expect(r.passages[0]!.phrase).toBe(false);
  });

  it("no cut splits a surrogate pair — the 400-character sentence split nor the 700-character passage", () => {
    const split = `${"가".repeat(399)}📅${"나".repeat(100)}`;
    for (const r of sentenceRanges(split)) expect(split.slice(r.start, r.end).isWellFormed()).toBe(true);
    const long = `${"가".repeat(699)}📅${"나".repeat(300)}`;
    for (const q of ["가가", "나나나", "📅", "가 나"])
      for (const p of findPassages(long, q, 5).passages) expect(p.text.isWellFormed(), q).toBe(true);
    const centred = `${"가".repeat(200)}📅${"다".repeat(300)}목표 구절${"라".repeat(300)}📅${"마".repeat(200)}`;
    for (const p of findPassages(centred, "목표 구절", 5).passages) {
      expect(p.text.isWellFormed()).toBe(true);
      expect(p.text).toContain("목표 구절");
    }
  });
});

describe("review #237 9차", () => {
  const k = (id: string, sourceId: string, sourceKey: string, quote: string): ResearchNote => ({
    id,
    claim: id,
    quote,
    sourceId,
    sourceKey,
  });

  it("a duplicate already in the first run's notes does not cost a new source its place", () => {
    // Eleven distinct notes of A and one duplicate of them (an old checkpoint), then B and C from the retry.
    const before = [
      ...Array.from({ length: 11 }, (_, i) => k(`a${i}`, "A", "u:A", `구절 ${i}`)),
      k("a-dup", "A", "u:A", "구절  3"),
    ];
    const merged = mergeNotes(before, [k("b", "B", "u:B", "B 구절"), k("c", "C", "u:C", "C 구절")], 12);
    expect(merged).toHaveLength(12);
    expect(merged.filter((n) => n.sourceId === "B").map((n) => n.id)).toEqual(["b"]);
    expect(merged.filter((n) => n.sourceId === "C").map((n) => n.id)).toEqual(["c"]);
    expect(merged.filter((n) => n.sourceId === "A")).toHaveLength(10);
    expect(merged.map((n) => n.id)).not.toContain("a-dup");
  });

  it("the centred cut stays within 700 when its start moves back for a surrogate pair", () => {
    // A phrase across the 400-character split of a long sentence without spaces (so the centred cut applies), 📅 put
    // where the cut's start lands between its halves (a = 49 before the fix: 701 characters).
    for (let a = 0; a <= 396; a++) {
      const body = `${"가".repeat(a)}📅${"다".repeat(396 - a)}목표구절${"라".repeat(500)}`;
      for (const p of findPassages(body, "목표구절", 5).passages) {
        expect(p.end - p.start, `${a}`).toBeLessThanOrEqual(700);
        expect(p.text.isWellFormed()).toBe(true);
        expect(p.text).toContain("목표구절");
      }
    }
  });

  it("a query without words (📅, ★) is still found as a phrase", () => {
    const body = "회의 날짜는 📅 표시로 알린다. 중요한 곳은 ★ 표시다.";
    const cal = findPassages(body, "📅", 5);
    expect(cal.total).toBe(1);
    expect(cal.passages[0]!.phrase).toBe(true);
    expect(cal.passages[0]!.text).toContain("📅");
    expect(findPassages(body, "★", 5).passages[0]!.text).toContain("★");
    expect(findPassages(body, "🎉", 5)).toEqual({ total: 0, passages: [] });
  });
});
