import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  CitationNotePart,
  CITATION_LIMITS,
  CITATION_STATUS_TEXT,
  citationMarkers,
  citationUnits,
  citationVerified,
  FINANCE_DISCLAIMER,
  sentenceEndMarkers,
  uncitedUnits,
  type MessagePart,
} from "@agentlee/shared";
import { SELFTEST_SKILL } from "@agentlee/mcp-tools/skills";
import { UserStore } from "../src/auth/users.js";
import { citationNote } from "../src/citations/checker.js";
import { CitationStore, CiteRefused } from "../src/citations/store.js";
import { findSnippet, normalizeSnippet, normalizeWithMap, verifyStats } from "../src/citations/verify.js";
import { ConversationStore } from "../src/conversations/store.js";
import { createTestDb, type Db } from "../src/db/client.js";
import { citations, sources } from "../src/db/schema.js";
import { McpTokens } from "../src/isolation/tokens.js";
import { McpService } from "../src/mcp/service.js";
import { sanitizeRecord } from "../src/logging.js";
import { FIXTURE_PAGES, fixtureWebWorker } from "../src/runtime/fake-citations.js";
import { SourceStore } from "../src/web/sources.js";
import { callOurTool } from "./helpers/live-mcp.js";

/**
 * The citation check (#25, PRD FR-5.2, 수용 기준 3): the snippet must really be in the stored page text, the scope
 * comes from the run token only, and the end-of-run note never lets a failed or missing citation pass as normal.
 */

const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const BODY =
  "산업통상자원부는 10일 10월 반도체 수출이 전년 같은 달보다 32% 늘어난 142억 달러로 집계됐다고 밝혔다.\n" +
  'He said "Semiconductor exports rose 132% in October" — a record. 성장률은 3.5%였다. ＡＢＣ전자는 "최대 실적"이라고 했다.';

describe("snippet check: normalisation without fuzzy matches", () => {
  const found = (s: string, body = BODY) => findSnippet(body, s).found;

  it("whitespace, quote styles, fullwidth, invisible characters and decomposed Hangul are normalised", () => {
    // A line break and double spaces in either text.
    expect(found("142억 달러로 집계됐다고 밝혔다. He said")).toBe(true);
    expect(found("32%  늘어난   142억 달러")).toBe(true);
    // Curly vs straight quotes, any style.
    expect(found("He said “Semiconductor exports rose 132% in October”")).toBe(true);
    expect(found("He said 'Semiconductor exports rose 132% in October'")).toBe(true);
    expect(found("ABC전자는 「최대 실적」이라고 했다")).toBe(true);
    // Fullwidth letters fold to ASCII; case is kept (round 10).
    expect(found('ABC전자는 "최대 실적"')).toBe(true);
    expect(found('abc전자는 "최대 실적"')).toBe(false);
    expect(found("SEMICONDUCTOR EXPORTS ROSE 132%")).toBe(false);
    // The dash style.
    expect(found('October" - a record')).toBe(true);
    // A zero-width space and a soft hyphen inside the snippet; Hangul written decomposed (NFD).
    expect(found("반도\u200B체 수\u00AD출이 전년")).toBe(true);
    expect(found("반도체 수출이 전년 같은 달보다".normalize("NFD"))).toBe(true);
    expect(found("반도체 수출이 전년 같은 달보다", BODY.normalize("NFD"))).toBe(true);
    // Spaces of every width (round 3: an explicit fold instead of NFKC).
    expect(found("반도체 수출이 전년 같은 달보다", "반도체\u00A0수출이\u3000전년\u2009같은 달보다")).toBe(
      true,
    );
    // Quote marks and ellipses the model put around the passage.
    expect(found("“…반도체 수출이 전년 같은 달보다...”")).toBe(true);
  });

  it("the quote is the passage as it stands in the page", () => {
    expect(findSnippet(BODY, "ABC전자는 「최대 실적」")).toEqual({
      found: true,
      quote: 'ＡＢＣ전자는 "최대 실적',
    });
    const m = findSnippet(BODY, "142억 달러로 집계됐다고 밝혔다. He said");
    expect(m).toEqual({ found: true, quote: "142억 달러로 집계됐다고 밝혔다. He said" });
  });

  it("no partial, fuzzy, joined or reordered matches", () => {
    // One character different, a paraphrase, a reordering.
    expect(found("반도체 수출이 전년 같은 달보다 33% 늘어난")).toBe(false);
    expect(found("반도체 수출이 작년보다 32% 늘었다")).toBe(false);
    expect(found("32% 늘어난 반도체 수출이 전년 같은 달보다")).toBe(false);
    // Two real passages joined with an ellipsis.
    expect(found("반도체 수출이 전년 … 142억 달러로 집계됐다고")).toBe(false);
    expect(found("반도체 수출이 전년...142억 달러로")).toBe(false);
    // Starts like the page and then goes on with something it does not say.
    expect(found("142억 달러로 집계됐다고 밝혔다. 역대 최대다")).toBe(false);
    // Inside a number or a word: "32%" is not in "132%", "3" is not "3.5", no word cut in half.
    expect(found("exports rose 32% in October")).toBe(false);
    expect(found("Semiconductor exports rose 13")).toBe(false);
    expect(found("성장률은 3였다")).toBe(false);
    expect(found("다. 성장률은 3")).toBe(false);
    expect(found("emiconductor exports rose")).toBe(false);
    expect(found("Semiconductor export")).toBe(false);
    expect(found("도체 수출이 전년 같은")).toBe(false);
    // A Korean particle after the end is fine.
    expect(found("10월 반도체 수출")).toBe(true);
  });

  it("case is kept: units and formulas that differ only in case are different text (round 10)", () => {
    expect(found("발전소의 설비 용량은 500mW", "발전소의 설비 용량은 500MW이다.")).toBe(false);
    expect(found("회선의 최대 속도는 100MBps", "회선의 최대 속도는 100Mbps이다.")).toBe(false);
    expect(found("검출된 기체는 Co였다고 한다", "검출된 기체는 CO였다고 한다.")).toBe(false);
    expect(found("Exports rose sharply in October", "exports rose sharply in October.")).toBe(false);
    // The exact case verifies.
    expect(found("발전소의 설비 용량은 500MW", "발전소의 설비 용량은 500MW이다.")).toBe(true);
    expect(found("회선의 최대 속도는 100Mbps", "회선의 최대 속도는 100Mbps이다.")).toBe(true);
    expect(found("검출된 기체는 CO였다고 한다", "검출된 기체는 CO였다고 한다.")).toBe(true);
    // The duplicate key keeps them apart too.
    expect(normalizeSnippet("회선 속도 100Mbps")).not.toBe(normalizeSnippet("회선 속도 100MBps"));
  });

  it("a quote mark right after a digit is a unit and is kept as itself (round 12)", () => {
    expect(found('제품의 전체 길이는 12"이다.', "제품의 전체 길이는 12'이다.")).toBe(false);
    expect(found("이 망원경의 시야각은 30”이다.", "이 망원경의 시야각은 30’이다.")).toBe(false);
    expect(found("제품의 전체 길이는 12'이다.", "제품의 전체 길이는 12'이다.")).toBe(true);
    expect(found("제품의 전체 길이는 12&quot;이다", "제품의 전체 길이는 12'이다.")).toBe(false);
    expect(found('제품의 전체 길이는 12"이다.', "제품의 전체 길이는 12&quot;이다.")).toBe(true);
    expect(found('제품의 전체 길이는 12"이다.', "제품의 전체 길이는 12&rdquo;이다.")).toBe(false); // entity too
    expect(normalizeSnippet("전체 길이는 12'이다")).not.toBe(normalizeSnippet('전체 길이는 12"이다'));
    // Elsewhere quotes still fold: the opening quote of a quoted number may differ; the closing one, right after
    // the digit, must match exactly (accepted limitation (d), ops §22).
    expect(found("그는 “100”이라고 말했다", "그는 “100”이라고 말했다.")).toBe(true);
    expect(found('그는 "100”이라고 말했다', "그는 “100”이라고 말했다.")).toBe(true);
    expect(found('그는 “100"이라고 말했다', "그는 “100”이라고 말했다.")).toBe(false);
    expect(found("그는 “좋다”고 말했다", '그는 "좋다"고 말했다.')).toBe(true);
  });

  it("round 15: one backward walk at the start, whole Korean multiplier tokens", () => {
    // 1. Leaving the currency sign out does not hide the sign; nor does an HTML space after it.
    expect(
      found("100 million in operating profit", "The company reported -$100 million in operating profit."),
    ).toBe(false);
    expect(found("5 million in total", "Net income: -€5 million in total.")).toBe(false);
    expect(found("100 million in profit", "It reported -$ 100 million in profit.")).toBe(false);
    expect(found("$ 100 million in profit", "It reported -$ 100 million in profit.")).toBe(false);
    expect(found("100 million in profit", "It reported - $100 million in profit.")).toBe(false);
    expect(found("100 million in profit", "It reported 1/$100 million in profit.")).toBe(false);
    expect(found("100 million in profit", "It reported $100 million in profit.")).toBe(true);
    expect(found("$ 100 million in profit", "It reported $ 100 million in profit.")).toBe(true);
    // 2. (Round 16: back to the first-character rule.) After a number, a word that starts with a numeral unit is a
    // multiplier — ordinary words too: accepted limitation (e). Quoting through the word verifies.
    expect(found("객실 요금: $100", "객실 요금: $100 조식 포함")).toBe(false);
    expect(found("여행 총액: $500", "여행 총액: $500 조기 예약 할인")).toBe(false);
    expect(found("버스 요금: ¥100", "버스 요금: ¥100 경로에 따라 추가 요금")).toBe(false);
    expect(found("상품권 가격: $50", "상품권 가격: $50 백화점에서 사용")).toBe(false);
    expect(found("객실 요금: $100 조식 포함", "객실 요금: $100 조식 포함")).toBe(true);
    expect(found("버스 요금: ¥100 경로에 따라", "버스 요금: ¥100 경로에 따라 추가 요금")).toBe(true);
    expect(found("상품권 가격: $50 백화점에서", "상품권 가격: $50 백화점에서 사용")).toBe(true);
    // Round 16, Codex: quantity expressions the whole-token rule missed.
    expect(found("올해 예상 피해액은 1", "올해 예상 피해액은 1 억원대에 달했다.")).toBe(false);
    expect(found("숙박 요금은 10", "숙박 요금은 10 만원대로 안내됐다.")).toBe(false);
    expect(found("누적 방문자는 1", "누적 방문자는 1 만여 명에 이른다.")).toBe(false);
    expect(found("올해 참가 인원은 3", "올해 참가 인원은 3 만명으로 집계됐다.")).toBe(false);
    expect(found("숙박 요금은 10", "숙박 요금은 10만원대로 안내됐다.")).toBe(false); // <strong>10</strong>만원대로, attached
    expect(found("숙박 요금은 10 만원대로", "숙박 요금은 10 만원대로 안내됐다.")).toBe(true);
    expect(found("예상 피해액은 1", "예상 피해액은 1 억원입니다.")).toBe(false);
    expect(found("총 투자 금액은 10", "총 투자 금액은 10 만 달러입니다.")).toBe(false);
    expect(found("총 투자 금액은 3", "총 투자 금액은 3 천만 원이다.")).toBe(false);
    expect(found("올해 매출 총액은 5", "올해 매출 총액은 5 조 원이었다.")).toBe(false);
    expect(found("총 투자 금액은 10", "총 투자 금액은 10 만에 그쳤다.")).toBe(false);
  });

  it("a range with units is cut at neither side: token-based range boundary (round 17)", () => {
    expect(found("올해 예상 수익률은 3%", "올해 예상 수익률은 3%~5%이다.")).toBe(false);
    expect(found("객실의 하루 요금은 10만원", "객실의 하루 요금은 10만원~20만원이다.")).toBe(false);
    expect(found("내일 예상 기온은 10°C", "내일 예상 기온은 10°C~20°C이다.")).toBe(false);
    expect(found("5%라고 안내했다.", "올해 예상 수익률은 3%~5%라고 안내했다.")).toBe(false);
    expect(found("올해 예상 수익률은 3%", "올해 예상 수익률은 3% ~ 5%이다.")).toBe(false);
    expect(found("5%라고 안내했다.", "올해 예상 수익률은 3% ~ 5%라고 안내했다.")).toBe(false);
    expect(found("20만원이라고 안내했다", "요금은 10만원~20만원이라고 안내했다.")).toBe(false);
    expect(found("올해 예상 수익률은 3%", "올해 예상 수익률은 3%/5%이다.")).toBe(false);
    // Controls: the whole range; prose with numbers on both sides of a comma; a separator not followed by a digit.
    expect(found("올해 예상 수익률은 3%~5%", "올해 예상 수익률은 3%~5%이다.")).toBe(true);
    expect(found("매출은 3% 증가, 5% 감소했다", "매출은 3% 증가, 5% 감소했다.")).toBe(true);
    expect(found("매출은 3% 증가", "매출은 3% 증가, 5% 감소했다.")).toBe(true);
    expect(found("5% 감소했다고 밝혔다", "매출은 3% 증가, 5% 감소했다고 밝혔다.")).toBe(true);
    expect(found("주차는 A-1 구역에서 한다", "주차는 A-1 구역에서 한다.")).toBe(true);
    expect(found("주차 위치는 B동 A", "주차 위치는 B동 A-1 구역이다.")).toBe(true);
    expect(found("올해 예상 수익률은 3%", "올해 예상 수익률은 3%~이다.")).toBe(true);
    // Only the token at the edge counts: a digit elsewhere in the match does not make a range.
    expect(found("3층 주차장은 B동 A", "3층 주차장은 B동 A-1 구역이다.")).toBe(true);
    // Round 18: a digit within 3 tokens on both sides of the mark is a range (accepted limitation (f)).
    expect(found("최대 20명이라고 했다", "인원은 10~최대 20명이라고 했다.")).toBe(false);
    expect(found("그 뒤 최대 인원은 20명이라고 했다", "인원은 10~그 뒤 최대 인원은 20명이라고 했다.")).toBe(
      true,
    );
    // A sign or a decimal mark only matters before a number.
    expect(found("A등급이었다고 밝혔다", "결과는 -A등급이었다고 밝혔다.")).toBe(true);
    expect(found("A형이었다고 밝혔다", "결과는 3,A형이었다고 밝혔다.")).toBe(true);
    expect(found("A1등급이었다고 밝혔다", "결과는 -A1등급이었다고 밝혔다.")).toBe(true);
    expect(found("A1형이었다고 밝혔다", "결과는 3,A1형이었다고 밝혔다.")).toBe(true);
  });

  it("scientific notation and powers are one number (round 19)", () => {
    expect(found("진공에서 빛의 속력은 약 3", "진공에서 빛의 속력은 약 3×10⁸ m/s이다.")).toBe(false);
    expect(found("10⁸ m/s라고 설명했다.", "진공에서 빛의 속력은 약 3×10⁸ m/s라고 설명했다.")).toBe(false);
    expect(found("전파의 주파수는 10", "전파의 주파수는 10^9 Hz이다.")).toBe(false);
    expect(found("진공에서 빛의 속력은 약 3", "진공에서 빛의 속력은 약 3*10^8 m/s이다.")).toBe(false);
    expect(found("10^8 m/s라고 설명했다", "빛의 속력은 약 3*10^8 m/s라고 설명했다.")).toBe(false);
    expect(found("진공에서 빛의 속력은 약 3", "진공에서 빛의 속력은 약 3 × 10⁸ m/s이다.")).toBe(false);
    expect(found("진공에서 빛의 속력은 약 3", "진공에서 빛의 속력은 약 3·10⁸ m/s이다.")).toBe(false);
    expect(found("9 Hz라고 했다고 한다", "전파의 주파수는 10^9 Hz라고 했다고 한다.")).toBe(false);
    expect(found("10⁸ m/s라고 설명했다.", "빛의 속력은 약 3·10⁸ m/s라고 설명했다.")).toBe(false);
    // A superscript digit after a digit is part of the number (the end token rule).
    expect(found("빛의 속력은 약 3×10", "빛의 속력은 약 3×10⁸ m/s이다.")).toBe(false);
    // `e` notation: the letter is part of the token; the exponent's sign continues it.
    expect(found("측정값은 무려 1", "측정값은 무려 1e9 회였다.")).toBe(false);
    expect(found("측정값은 무려 1", "측정값은 무려 1E9 회였다.")).toBe(false);
    expect(found("측정된 농도는 1.5", "측정된 농도는 1.5e-3 mol이다.")).toBe(false);
    expect(found("측정된 농도는 1.5e", "측정된 농도는 1.5e-3 mol이다.")).toBe(false);
    expect(found("3 mol이라고 했다", "측정된 농도는 1.5e-3 mol이라고 했다.")).toBe(false);
    // Controls: the whole notation, and a whole equation.
    expect(found("진공에서 빛의 속력은 약 3×10⁸ m/s", "진공에서 빛의 속력은 약 3×10⁸ m/s이다.")).toBe(true);
    expect(found("측정된 농도는 1.5e-3 mol", "측정된 농도는 1.5e-3 mol이다.")).toBe(true);
    expect(found("간단한 계산은 3 × 4 = 12", "간단한 계산은 3 × 4 = 12이다.")).toBe(true);
  });

  it("a range check looks 3 tokens either side and allows the second value's sign (round 18)", () => {
    expect(found("객실의 하루 요금은 10만 원", "객실의 하루 요금은 10만 원~20만 원이다.")).toBe(false);
    expect(found("20만 원이라고 안내했다.", "객실의 하루 요금은 10만 원~20만 원이라고 안내했다.")).toBe(
      false,
    );
    expect(found("총 투자 금액은 1억 원", "총 투자 금액은 1억 원 ~ 2억 원이다.")).toBe(false);
    expect(found("$20 million in total.", "The cost is $10 million ~ $20 million in total.")).toBe(false);
    expect(found("내일 예상 기온은 -10", "내일 예상 기온은 -10~-5도이다.")).toBe(false);
    expect(found("내일 예상 기온은 -10°C", "내일 예상 기온은 -10°C~-5°C이다.")).toBe(false);
    expect(found("올해 예상 수익률은 -5%", "올해 예상 수익률은 -5%~+5%이다.")).toBe(false);
    expect(found("+5%라고 안내했다", "수익률은 -5%~+5%라고 안내했다.")).toBe(false);
    expect(found("The cost is $10 million", "The cost is $10 million ~ $20 million in total.")).toBe(false);
    // The window really is 3 tokens: the digit three tokens back still counts, on both sides.
    expect(found("요금은 무려 10 만 원", "요금은 무려 10 만 원~20만 원이다.")).toBe(false);
    expect(found("20만 원이라고 안내했다", "요금은 10 만 원~20만 원이라고 안내했다.")).toBe(false);
    expect(found("20만 원이라고 안내했다", "요금은 10 만 원 ~ 20만 원이라고 안내했다.")).toBe(false);
    expect(found("만 원 이상 20만 원이라고 했다", "요금은 10~만 원 이상 20만 원이라고 했다.")).toBe(true); // 4th token: outside
    expect(found("구간은 약 5도이다", "구간은 10~-구간은 약 5도이다.")).toBe(false);
    // Controls: whole ranges; a comma is no range mark; `A-1` without a digit before the mark.
    expect(found("객실의 하루 요금은 10만 원~20만 원", "객실의 하루 요금은 10만 원~20만 원이다.")).toBe(true);
    expect(found("내일 예상 기온은 -10~-5도", "내일 예상 기온은 -10~-5도이다.")).toBe(true);
    expect(found("매출은 3% 증가", "매출은 3% 증가, 5% 감소했다.")).toBe(true);
    expect(found("주차는 A-1 구역에서 한다", "주차는 A-1 구역에서 한다.")).toBe(true);
    // Accepted limitation (f): a dash between two figures within 3 tokens reads as a range.
    expect(found("매출은 3% 증가", "매출은 3% 증가 - 5% 감소했다.")).toBe(false);
  });

  it("a range that repeats the currency sign is one range (round 16)", () => {
    expect(found("객실의 하루 요금은 $100", "객실의 하루 요금은 $100-$200이다.")).toBe(false);
    expect(found("객실의 하루 요금은 €100", "객실의 하루 요금은 €100 ~ €200이다.")).toBe(false);
    expect(found("Admission prices are $10", "Admission prices are $10–$20 per person.")).toBe(false);
    expect(found("Admission prices are $10", "Admission prices are $10 – $ 20 per person.")).toBe(false);
    // Whole ranges verify; a currency sign after a range mark without a number is no range.
    expect(found("객실의 하루 요금은 $100-$200", "객실의 하루 요금은 $100-$200이다.")).toBe(true);
    expect(found("객실의 하루 요금은 €100 ~ €200", "객실의 하루 요금은 €100 ~ €200이다.")).toBe(true);
    expect(found("Admission prices are $10", "Admission prices are $10 - $ is the sign.")).toBe(true);
  });

  it("round 14: a sign before a currency sign, multipliers across a space, wrapped quotes kept", () => {
    // 1. The sign before `$100`, also across a space and as HTML puts it.
    expect(
      found("$100 million in operating profit", "The company reported -$100 million in operating profit."),
    ).toBe(false);
    expect(found("$5 million.", "Net income: - $5 million.")).toBe(false);
    expect(found("$5 million in total", "Net income: −$5 million in total.")).toBe(false);
    expect(found("$5 million in total", "Net income: -\n$5 million in total.")).toBe(false); // <span>-</span>$5
    expect(found("₩5,000 감소했다고 밝혔다", "매출은 -₩5,000 감소했다고 밝혔다.")).toBe(false);
    expect(
      found("$100 million in operating profit", "The company reported 1-$100 million in operating profit."),
    ).toBe(false);
    expect(
      found("$100 million in operating profit", "The company reported $100 million in operating profit."),
    ).toBe(true);
    expect(
      found("-$100 million in operating profit", "The company reported -$100 million in operating profit."),
    ).toBe(true);
    // A currency sign without a number after it is no number.
    expect(found("€ 기호는 유로를 뜻한다", "표의 -€ 기호는 유로를 뜻한다.")).toBe(true);
    // 2. A multiplier across a space after the number.
    expect(found("총 투자 금액은 10", "총 투자 금액은 10 만 달러입니다.")).toBe(false);
    expect(found("예상 피해액은 1", "예상 피해액은 1 억원입니다.")).toBe(false);
    expect(found("총 투자 금액은 3", "총 투자 금액은 3 천만 원이다.")).toBe(false);
    expect(found("The company reported $100", "The company reported $100 million.")).toBe(false);
    expect(found("The company reported 5", "The company reported 5 billion dollars.")).toBe(false);
    expect(found("The company reported 5", "The company reported 5 bn dollars.")).toBe(false);
    expect(found("The company reported 5", "The company reported 5M dollars.")).toBe(false);
    expect(found("The company reported 5", "The company reported 5 K users.")).toBe(false);
    // Controls: other words after the number, a whole quote, case kept (Million is not on the list).
    expect(found("The company reported $100", "The company reported $100 in fees.")).toBe(true);
    expect(found("The company reported 5", "The company reported 5 MBps links.")).toBe(true);
    expect(found("The company reported 5", "The company reported 5 Million users.")).toBe(true);
    expect(found("총 투자 금액은 10 만", "총 투자 금액은 10 만 달러입니다.")).toBe(true);
    // 3. A snippet sent with the page's own quotes around a number verifies as sent.
    expect(found("“올해 매출 목표는 100”", "대표는 “올해 매출 목표는 100”이라고 말했다.")).toBe(true);
    expect(found("“1,000,000”", "표에 적힌 값은 “1,000,000”이다.")).toBe(true);
    expect(found("“1,000,000원”", "표에 적힌 값은 “1,000,000원”이다.")).toBe(true);
    expect(found('"내년 성장률 목표는 3.5"', '그는 "내년 성장률 목표는 3.5"라고 했다.')).toBe(true);
    // …the opening quote folds as usual; the closing one after the digit must be the same mark.
    expect(found('"올해 매출 목표는 100”', "대표는 “올해 매출 목표는 100”이라고 말했다.")).toBe(true);
    expect(found('“올해 매출 목표는 100"', "대표는 “올해 매출 목표는 100”이라고 말했다.")).toBe(false);
    // The unit rejections stay.
    expect(found('제품의 전체 길이는 12"', "제품의 전체 길이는 12'이다.")).toBe(false);
    expect(found('"제품의 전체 길이는 12"', "제품의 전체 길이는 12'이다.")).toBe(false);
    // P3: a zero-width character between the number and the unit quote.
    expect(found('제품의 전체 길이는 12"', "제품의 전체 길이는 12\u200B'이다.")).toBe(false);
    expect(found("제품의 전체 길이는 12'", "제품의 전체 길이는 12\u200B'이다.")).toBe(true);
  });

  it("a unit quote is never trimmed off the snippet, and spaces before it still make it a unit (round 13)", () => {
    // Codex: the trailing `"` after a digit is a unit, not a wrapping quote.
    expect(found('제품의 전체 길이는 12"', "제품의 전체 길이는 12'이다.")).toBe(false);
    expect(found('이 망원경의 시야각은 30"', "이 망원경의 시야각은 30’이다.")).toBe(false);
    expect(found('제품의 전체 길이는 12"', '제품의 전체 길이는 12"이다.')).toBe(true);
    expect(normalizeSnippet('제품의 전체 길이는 12"')).not.toBe(normalizeSnippet("제품의 전체 길이는 12"));
    expect(normalizeSnippet('"12" 크기의 제품이다')).not.toBe(normalizeSnippet("12 크기의 제품이다"));
    // An unpaired quote next to a digit is kept at the start too (it is not known to wrap the snippet).
    expect(normalizeSnippet('"12 크기의 제품이다')).toBe('"12 크기의 제품이다');
    // A quote wrapping the whole snippet is still dropped — and the number then may not stop before a unit quote.
    expect(normalizeSnippet('"제품의 전체 길이는 12"')).toBe("제품의 전체 길이는 12");
    expect(found('"제품의 전체 길이는 12"', "제품의 전체 길이는 12'이다.")).toBe(false);
    expect(found("제품의 전체 길이는 12", "제품의 전체 길이는 12'이다.")).toBe(false);
    expect(found('"제품의 전체 길이는 12"', "제품의 전체 길이는 12이다.")).toBe(true);
    // HTML extraction: `<span>12</span>'` reads as `12 '` — still a unit, in the page and in the snippet.
    expect(found('제품의 전체 길이는 12 "이다', "제품의 전체 길이는 12 '이다.")).toBe(false);
    expect(found("제품의 전체 길이는 12 '이다", "제품의 전체 길이는 12 '이다.")).toBe(true);
    expect(found("제품의 전체 길이는 12", "제품의 전체 길이는 12 '이다.")).toBe(false);
    expect(normalizeSnippet("전체 길이는 12 '이다")).not.toBe(normalizeSnippet('전체 길이는 12 "이다'));
    // Controls: quoted numbers and ordinary quoted words.
    expect(found("그는 “100”이라고 말했다", "그는 “100”이라고 말했다.")).toBe(true);
    expect(found("“그는 좋다고 말했다”", "그는 좋다고 말했다.")).toBe(true);
    expect(found("그는 “좋다”고 말했다", '그는 "좋다"고 말했다.')).toBe(true);
    expect(normalizeSnippet("“그는 좋다고 말했다”")).toBe("그는 좋다고 말했다");
  });

  it("a sign across a space belongs to the number (round 12)", () => {
    expect(found("5% 감소했다고 밝혔다", "매출은 - 5% 감소했다고 밝혔다.")).toBe(false);
    expect(found("5도까지 떨어졌다고 한다", "기온은 − 5도까지 떨어졌다고 한다.")).toBe(false);
    expect(found("5 ~ 5도라고 예보했다", "기온은 - 5 ~ 5도라고 예보했다.")).toBe(false);
    expect(found("5% 감소했다고 밝혔다", "매출은 + 5% 감소했다고 밝혔다.")).toBe(false);
    // HTML extraction: `<span>-</span>5%` reads as `-` and `5%` with a break between.
    expect(found("5% 감소했다고 밝혔다", "매출은 -\n5% 감소했다고 밝혔다.")).toBe(false);
    // The sign quoted with the number verifies; a word before is no sign.
    expect(found("- 5% 감소했다고 밝혔다", "매출은 - 5% 감소했다고 밝혔다.")).toBe(true);
    expect(found("5% 감소했다고 밝혔다", "매출은 약 5% 감소했다고 밝혔다.")).toBe(true);
  });

  it("primes, accents and backticks are not quote marks (round 11)", () => {
    expect(found("제품의 전체 길이는 12″이다.", "제품의 전체 길이는 12′이다.")).toBe(false);
    expect(found("이 망원경의 시야각은 30″이다.", "이 망원경의 시야각은 30′이다.")).toBe(false);
    expect(found("이 함수의 도함수는 f″(x)=2x이다.", "이 함수의 도함수는 f′(x)=2x이다.")).toBe(false);
    expect(found("제품의 전체 길이는 12′이다.", "제품의 전체 길이는 12′이다.")).toBe(true);
    expect(found('제품의 전체 길이는 12"이다.', "제품의 전체 길이는 12′이다.")).toBe(false);
    expect(found("명령어는 `ls -la`이다.", "명령어는 'ls -la'이다.")).toBe(false);
    expect(found("명령어는 ´ls -la´이다.", "명령어는 'ls -la'이다.")).toBe(false);
    // Typographic quotes and dashes still fold.
    expect(found("그는 “좋다”고 말했다 — 정말로", '그는 "좋다"고 말했다 - 정말로.')).toBe(true);
    // The duplicate key keeps primes apart too.
    expect(normalizeSnippet("전체 길이는 12′이다")).not.toBe(normalizeSnippet("전체 길이는 12″이다"));
  });

  it("range and fraction marks with spaces, and every tilde, continue a number (round 11)", () => {
    expect(found("예상 기온은 10", "예상 기온은 10 ~ 20도이다.")).toBe(false);
    expect(found("20도라고 예보했다", "기온은 10∼20도라고 예보했다.")).toBe(false);
    expect(found("20도라고 예보했다", "기온은 10〜20도라고 예보했다.")).toBe(false);
    expect(found("20도라고 예보했다", "기온은 10～20도라고 예보했다.")).toBe(false);
    expect(found("5%라고 안내했다", "올해 예상 수익률은 3 ~ 5%라고 안내했다.")).toBe(false);
    expect(found("실험에서 측정한 확률은 1", "실험에서 측정한 확률은 1 / 2이다.")).toBe(false);
    expect(found("이번 경기의 점수는 3", "이번 경기의 점수는 3 : 1이었다.")).toBe(false);
    expect(found("예상 기온은 10", "예상 기온은 10 - 20도이다.")).toBe(false);
    expect(found("예상 기온은 10", "예상 기온은 10 − 20도이다.")).toBe(false); // the minus sign as a range mark
    expect(found("20도라고 예보했다", "기온은 10 - 20도라고 예보했다.")).toBe(false);
    expect(found("20도이다고 했다", "예상 기온은 10 − 20도이다고 했다.")).toBe(false);
    // `.` and `,` stay adjacent-only: prose lists are not numbers.
    expect(found("올해 성장률은 무려 3", "올해 성장률은 무려 3, 4명이 참석했다.")).toBe(true);
    expect(found("4명이 참석했다고 밝혔다", "인원은 3, 4명이 참석했다고 밝혔다.")).toBe(true);
    expect(found("올해 성장률은 무려 3", "올해 성장률은 무려 3, 내년은 4였다.")).toBe(true);
    // Whole ranges verify; a tilde folds to `~` for the quote too.
    expect(found("예상 기온은 10 ~ 20도", "예상 기온은 10 ~ 20도이다.")).toBe(true);
    expect(found("기온은 10~20도라고 예보했다", "기온은 10∼20도라고 예보했다.")).toBe(true);
  });

  it("a match never cuts a number in half: separators and Korean compound numerals (round 9)", () => {
    // Codex: fractions, at the end and at the start.
    expect(found("이번 계약의 지분은 1", "이번 계약의 지분은 1/2이다.")).toBe(false);
    expect(found("해당 사건의 발생 확률은 1", "해당 사건의 발생 확률은 1/100이다.")).toBe(false);
    expect(found("100원으로 산정됐다고 밝혔다", "금액은 1/100원으로 산정됐다고 밝혔다.")).toBe(false);
    // Ratios and ranges (every separator), both ends.
    for (const sep of [".", ",", "/", ":", "-", "–", "~"]) {
      expect(found("이번 경기의 점수는 3", `이번 경기의 점수는 3${sep}1이었다.`), sep).toBe(false);
      expect(found("1이었다고 발표했다", `점수는 3${sep}1이었다고 발표했다.`), sep).toBe(false);
    }
    expect(found("예상 기온은 10", "예상 기온은 10-20도이다.")).toBe(false);
    expect(found("예상 기온은 10", "예상 기온은 10~20도이다.")).toBe(false);
    expect(found("20도라고 예보했다", "기온은 10~20도라고 예보했다.")).toBe(false);
    // Whole numbers still verify, and a separator followed by a non-digit is no number.
    expect(found("이번 계약의 지분은 1/2", "이번 계약의 지분은 1/2이다.")).toBe(true);
    expect(found("예상 기온은 10~20도", "예상 기온은 10~20도이다.")).toBe(true);
    expect(found("올해 성장률은 무려 3", "올해 성장률은 무려 3, 내년은 4였다.")).toBe(true);
    expect(found("4였다고 덧붙였다", "올해는 3. 4였다고 덧붙였다.")).toBe(true);
    expect(found("3명이 참석했다고 밝혔다", "결과:3명이 참석했다고 밝혔다.")).toBe(true); // `:` after a word
    // Codex: Korean compound numerals.
    expect(found("총 참석 인원은 백", "총 참석 인원은 백이 명이었다.")).toBe(false);
    expect(found("이번 투표 결과는 십", "이번 투표 결과는 십이 대 칠이었다.")).toBe(false);
    expect(found("그날 기온은 십", "그날 기온은 십이 도였다.")).toBe(false);
    expect(found("이 명이었다고 밝혔다", "총 인원은 백이 명이었다고 밝혔다.")).toBe(false); // start: token rule
    expect(found("총 참석 인원은 백이 명", "총 참석 인원은 백이 명이었다.")).toBe(true);
    // The known over-rejection: a word ending in 백/천/조 followed by the particle 이.
    expect(found("문서 끝의 공백", "문서 끝의 공백이 남았다.")).toBe(false);
    expect(found("문서 끝의 공백이", "문서 끝의 공백이 남았다.")).toBe(true);
  });

  it("not inside a decimal, a thousands group or after a sign (review #97)", () => {
    expect(found("32% increased this year", "Sales: 1.32% increased this year.")).toBe(false);
    expect(found("1.32% increased this year", "Sales: 1.32% increased this year.")).toBe(true);
    expect(found("234 units sold worldwide", "In total 1,234 units sold worldwide.")).toBe(false);
    expect(found("1,234 units sold worldwide", "In total 1,234 units sold worldwide.")).toBe(true);
    expect(found("32% 감소했다고 밝혔다", "매출은 -32% 감소했다고 밝혔다.")).toBe(false);
    expect(found("32% 감소했다고 밝혔다", "매출은 −32% 감소했다고 밝혔다.")).toBe(false);
    expect(found("32% 감소했다고 밝혔다", "매출은 32% 감소했다고 밝혔다.")).toBe(true);
    // A sentence end before a number is not a decimal point.
    expect(found("32% 늘었다고 밝혔다", "끝났다. 32% 늘었다고 밝혔다.")).toBe(true);
  });

  it("HTML entities, line-end hyphens (not joined) and inline footnote numbers in the page (review #97)", () => {
    const page =
      "기온은 &minus;5도로 떨어졌다 &amp; 눈이 왔다. 수치는 &#8722;3&nbsp;% 였다. 값은 &#x2212;7이다.";
    expect(found("기온은 −5도로 떨어졌다 & 눈이 왔다", page)).toBe(true);
    // Round 11: the minus sign is not a dash — it is kept as itself (only dash punctuation folds to `-`).
    expect(found("기온은 -5도로 떨어졌다", page)).toBe(false);
    expect(found("수치는 −3 % 였다", page)).toBe(true);
    expect(found("수치는 -3 % 였다", page)).toBe(false);
    expect(found("값은 −7이다.", page)).toBe(true);
    expect(
      findSnippet(page, "기온은 −5도로 떨어졌다").found && findSnippet(page, "기온은 −5도로 떨어졌다"),
    ).toEqual({
      found: true,
      quote: "기온은 &minus;5도로 떨어졌다",
    });
    // An unknown or broken entity stays as written.
    expect(found("a &bogus; b c d e", "x a &bogus; b c d e")).toBe(true);
    // Round 3: a hyphen at a line end is never joined — it stays a hyphen and a space (x−y is not xy, re-sign is
    // not resign). A wrapped word then shows as not found (⚠️), which is acceptable.
    const wrapped =
      "Semicon-\nductor exports rose sharply. They re-\nsign the deal. Then x\u2212\ny was used.";
    expect(found("Semiconductor exports rose sharply", wrapped)).toBe(false);
    expect(found("Semicon- ductor exports rose sharply", wrapped)).toBe(true);
    expect(found("They resign the deal", wrapped)).toBe(false);
    expect(found("Then xy was used", wrapped)).toBe(false);
    expect(found("Then x\u2212 y was used", wrapped)).toBe(true);
    expect(found("Semiconductor exports rose", "Semicon-\r\nductor exports rose.")).toBe(false);
    // Round 4: footnote marks are never removed — the page is compared as written. A quote that leaves one out is
    // not found (⚠️); one that keeps it is.
    const notes = "수출이 크게 늘었다[3]. 업계는 반겼다²³. 정부는 지원을 약속했다[12][13].";
    expect(found("수출이 크게 늘었다. 업계는 반겼다.", notes)).toBe(false);
    expect(found("정부는 지원을 약속했다.", notes)).toBe(false);
    expect(found("수출이 크게 늘었다[3]. 업계는", notes)).toBe(true);
    expect(found("업계는 반겼다²³. 정부는", notes)).toBe(true);
    expect(found("said so. Then they left", "They said so.¹ Then they left.")).toBe(false);
    // Different array elements are different text.
    expect(found("the value of arr[2] is used", "the value of arr[1] is used here.")).toBe(false);
    expect(found("the value of arr is used", "the value of arr[1] is used here.")).toBe(false);
    expect(found("the value of arr[1] is used", "the value of arr[1] is used here.")).toBe(true);
    // Superscripts after a digit or a unit are exponents (and no NFKC: ² is not 2).
    expect(found("참가자는 10만 명이었다", "참가자는 10²만 명이었다.")).toBe(false);
    expect(found("참가자는 102만 명이었다", "참가자는 10²만 명이었다.")).toBe(false);
    expect(found("참가자는 10²만 명이었다", "참가자는 10²만 명이었다.")).toBe(true);
    expect(found("넓이는 (10) 제곱미터였다", "넓이는 (10)² 제곱미터였다.")).toBe(false);
    expect(found("넓이는 (10)2 제곱미터였다", "넓이는 (10)² 제곱미터였다.")).toBe(false);
    expect(found("물 분자는 H2O 이다", "물 분자는 H₂O 이다.")).toBe(false);
    expect(found("첫째는 1 항목이다", "첫째는 ① 항목이다.")).toBe(false);
    expect(found("넓이는 10 제곱미터였다", "넓이는 10² 제곱미터였다.")).toBe(false);
    expect(found("업계는 반겼다정부는 지원했다", "업계는 반겼다²정부는 지원했다.")).toBe(false);
    expect(found("면적은 32m³ 이었다", "면적은 32m² 이었다.")).toBe(false);
    expect(found("면적은 32m 이었다", "면적은 32m² 이었다.")).toBe(false);
    expect(found("면적은 32m² 이었다", "면적은 32m² 이었다.")).toBe(true);
    expect(found("값은 1234원이었다", "값은 12[3]34원이었다.")).toBe(false);
    expect(found("값은 12원이었다", "값은 12[3]원이었다.")).toBe(false);
    expect(found("값은 34원이었다고", "값은 [3]34원이었다고 했다.")).toBe(false);
  });

  it("the end may stop only before a Korean particle from the closed list, then a boundary (round 5)", () => {
    // The review's positive controls: a particle after a figure, a unit, a product name.
    expect(found("수출 증가율은 32%", "수출 증가율은 32%로 집계됐다.")).toBe(true);
    expect(found("공장 건물의 면적은 32m²", "공장 건물의 면적은 32m²로 집계됐다.")).toBe(true);
    expect(found("사용한 모델은 GPT-4o", "사용한 모델은 GPT-4o이며 공개형이다.")).toBe(true);
    expect(found("해당 런타임은 Node.js", "해당 런타임은 Node.js입니다.")).toBe(true);
    expect(found("10월 반도체 수출", "10월 반도체 수출에서는 감소했다.")).toBe(true);
    expect(found("10월 반도체 수출", "10월 반도체 수출으로는 부족했다.")).toBe(true);
    expect(found("10월 반도체 수출", "10월 반도체 수출이")).toBe(true); // the end of the text is a boundary
    // Round 6: past-tense copula forms.
    expect(found("이 회사의 주력 제품은 반도체", "이 회사의 주력 제품은 반도체였다.")).toBe(true);
    expect(found("해당 사업의 유일한 목적은 수출", "해당 사업의 유일한 목적은 수출이었다.")).toBe(true);
    expect(found("해당 서비스의 운영 주체는 정부", "해당 서비스의 운영 주체는 정부였습니다.")).toBe(true);
    expect(found("지난해 수출 증가율은 32%", "지난해 수출 증가율은 32%였다.")).toBe(true);
    expect(found("해당 런타임은 Node.js", "해당 런타임은 Node.js였습니다.")).toBe(true);
    expect(found("이 회사의 주력 제품은 반도체", "이 회사의 주력 제품은 반도체였던 시절.")).toBe(true);
    expect(found("이 회사의 주력 제품은 반도체", "이 회사의 주력 제품은 반도체인데 지금은 아니다.")).toBe(
      true,
    );
    expect(found("이 회사의 주력 제품은 반도체", "이 회사의 주력 제품은 반도체였었다.")).toBe(false); // still closed
    // Rounds 6–8: a quote can never stop right before 만 (not a particle — it is also a numeral unit), and no
    // numeral unit (십 백 천 만 억 조 경) is a particle, so no number is cut before its unit. Quoting through 만 works.
    for (const [quote, page] of [
      ["총 투자 금액은 10", "총 투자 금액은 10만 달러입니다."],
      ["지난달 신규 가입자는 32", "지난달 신규 가입자는 32만 명이다."],
      ["해당 제품의 가격은 3", "해당 제품의 가격은 3만 원이다."],
      ["총 투자 금액은 1.5", "총 투자 금액은 1.5억 달러였다."],
      ["해당 금액은 무려 3.", "해당 금액은 무려 3.만 원이다."],
      ["총 투자 금액은 천", "총 투자 금액은 천만 달러입니다."],
      ["지난달 신규 가입자는 십", "지난달 신규 가입자는 십만 명이다."],
      ["해당 제품의 가격은 삼", "해당 제품의 가격은 삼만 원이다."],
      ["지난달 신규 가입자는 이십", "지난달 신규 가입자는 이십만 명이다."],
      ["예상 피해액은 수천", "예상 피해액은 수천만 원입니다."],
      ["매년 방문객은 수십", "매년 방문객은 수십만 명이다."],
      ["해당 영상은 수백", "해당 영상은 수백만 회 재생됐다."],
      ["올해 매출은 무려 2", "올해 매출은 무려 2조 원이었다."],
      // The accepted limitation: also before 만 meaning "only".
      ["이번 작업은 전기 공사", "이번 작업은 전기 공사만 포함한다."],
      ["직원들은 오늘도 일", "직원들은 오늘도 일만 했다."],
      ["이번 주에는 이사", "이번 주에는 이사만 진행한다."],
      ["운영 환경에서는 Python 3.12", "운영 환경에서는 Python 3.12만 지원합니다."],
      ["이번 배포에서는 HTTP/2", "이번 배포에서는 HTTP/2만 허용합니다."],
      ["방화벽에서는 포트 443", "방화벽에서는 포트 443만 허용합니다."],
      ["이 계획은 자금", "이 계획은 자금만 있으면 된다."],
      ["올해 수출은 미국까지", "올해 수출은 미국까지만 늘었다."],
      ["올해 수출은 미국", "올해 수출은 미국까지만 늘었다."], // no 까지+만 either
    ])
      expect(found(quote!, page!), quote).toBe(false);
    for (const [quote, page] of [
      ["이번 작업은 전기 공사만", "이번 작업은 전기 공사만 포함한다."],
      ["총 투자 금액은 10만", "총 투자 금액은 10만 달러입니다."],
      ["총 투자 금액은 천만", "총 투자 금액은 천만 달러입니다."],
      ["예상 피해액은 수천만", "예상 피해액은 수천만 원입니다."],
      ["운영 환경에서는 Python 3.12만", "운영 환경에서는 Python 3.12만 지원합니다."],
      ["올해 수출은 미국까지만", "올해 수출은 미국까지만 늘었다."],
      ["올해 수출은 미국까지", "올해 수출은 미국까지도 늘었다."],
      ["올해 수출은 미국", "올해 수출은 미국까지도 늘었다."], // 까지+도
      ["올해 수출은 미국", "올해 수출은 미국에서는 늘었다."], // 에서+는
      ["수출 증가율은 무려 32", "수출 증가율은 무려 32로 집계됐다."],
      ["10월 반도체 수출", "10월 반도체 수출이 늘었다."],
    ])
      expect(found(quote!, page!), quote).toBe(true);
    expect(found("지난달 신규 가입자는 3", "지난달 신규 가입자는 3명이었다.")).toBe(false); // 명 is not a particle
    expect(found("올해의 기준은 10", "올해의 기준은 10월이다.")).toBe(false); // 월 is not a particle
    // Not a particle, or a particle that runs on into more of the word.
    expect(found("이 설정은 유효", "이 설정은 유효하지 않습니다.")).toBe(false);
    // Only listed particles: a syllable outside the list fails even right before a boundary.
    expect(found("이 설정은 유효", "이 설정은 유효하, 그리고 끝.")).toBe(false);
    expect(found("이 기능은 사용", "이 기능은 사용불가 상태다.")).toBe(false);
    expect(found("10월 반도체 수", "10월 반도체 수출이 늘었다.")).toBe(false);
    expect(found("수출 증가율은 32%", "수출 증가율은 32%로써 확정됐다.")).toBe(false);
    expect(found("사용한 모델은 GPT-4", "사용한 모델은 GPT-4o이며 공개형이다.")).toBe(false);
    expect(found("공장 건물의 면적은 32m", "공장 건물의 면적은 32m²로 집계됐다.")).toBe(false);
    expect(found("10월 반도체 수출", "10월 반도체 수출이다1")).toBe(false);
  });

  it("a match neither starts nor ends inside a token (round 4)", () => {
    // The three review cases: the quote stops right before a superscript or subscript.
    expect(found("면적은 정확히 32m", "면적은 정확히 32m² 이었다.")).toBe(false);
    expect(found("넓이는 정확히 (10)", "넓이는 정확히 (10)² 이었다.")).toBe(false);
    expect(found("이 물질의 화학식은 H", "이 물질의 화학식은 H₂O 이다.")).toBe(false);
    // Modifier letters and marks count too; the start mirrors the end.
    expect(found("value was abcdefgh", "the value was abcdefghʰ ok")).toBe(false);
    // A combining mark that does not compose (x + U+0333) is part of the token.
    expect(found("value was abcdefgx", "the value was abcdefgx\u0333 ok")).toBe(false);
    expect(found("value was abcdefgx\u0333", "the value was abcdefgx\u0333 ok")).toBe(true);
    expect(found("conductor exports rose", "Semiconductor exports rose.")).toBe(false);
    expect(found("도체 수출이 전년 같은", "반도체 수출이 전년 같은 달.")).toBe(false);
    expect(found("% 늘었다고 밝혔다", "매출은 132% 늘었다고 밝혔다.")).toBe(false);
    expect(found("₂O 분자가 있었다", "그 안에 H₂O 분자가 있었다.")).toBe(false);
    // Positive controls: whole tokens, a Korean particle, a quote that ends its sentence.
    expect(found("면적은 정확히 32m²", "면적은 정확히 32m² 이었다.")).toBe(true);
    expect(found("이 물질의 화학식은 H₂O", "이 물질의 화학식은 H₂O 이다.")).toBe(true);
    expect(found("10월 반도체 수출", "10월 반도체 수출이 늘었다.")).toBe(true);
    expect(found("수출이 크게 늘었다.", "수출이 크게 늘었다.[3] 업계는")).toBe(true);
    // Round 5: one closed rule at the end — no exception for a quote that ends a sentence.
    expect(found("Exports rose sharply.", "Exports rose sharply.²")).toBe(false);
    expect(found("Exports rose sharply.", "Exports rose sharply. Then")).toBe(true);
    // …but a full stop is not a sentence end inside a decimal.
    expect(found("성장률은 무려 3.", "성장률은 무려 3.5%였다.")).toBe(false);
    expect(found("성장률은 무려 3", "성장률은 무려 3.5%였다.")).toBe(false);
    expect(found("총 판매량은 무려 1", "총 판매량은 무려 1,234대였다.")).toBe(false);
  });

  it("at the stored body cap one check stays well inside one event-loop turn, and repeats hit the cache", () => {
    const base =
      "산업통상자원부는 10일 10월 반도체 수출이 전년 같은 달보다 32% 늘어난 142억 달러로 집계됐다. Exports “rose”. ";
    const body = base.repeat(Math.ceil(400_000 / base.length)).slice(0, 400_000);
    normalizeWithMap(base); // warm the character caches the first page would warm
    let t = performance.now();
    expect(findSnippet(body, "없는 구절이에요 정말로", "perf-key").found).toBe(false);
    const first = performance.now() - t;
    const normalized = verifyStats.normalized;
    t = performance.now();
    expect(findSnippet(body, "없는 다른 구절이에요", "perf-key").found).toBe(false);
    const again = performance.now() - t;
    expect(verifyStats.normalized).toBe(normalized + 1); // the snippet only: the page came from the cache
    // Measured 25–35 ms here (400k characters); generous bounds for slower CI machines.
    expect(first).toBeLessThan(250);
    expect(again).toBeLessThan(25);
    // A changed body under the same key is normalised again, not served from the cache.
    expect(findSnippet(`${body} 끝에 붙인 새 문장입니다`, "끝에 붙인 새 문장입니다", "perf-key").found).toBe(
      true,
    );
  });

  it("composed and decomposed accents are the same text (round 2)", () => {
    const nfc = "Le café prices rose sharply in Paris.";
    expect(found("café prices rose sharply", nfc.normalize("NFD"))).toBe(true);
    expect(found("café prices rose sharply".normalize("NFD"), nfc)).toBe(true);
    expect(found("cafe prices rose sharply", nfc)).toBe(false);
  });

  it("a snippet must say something: fewer than 8 normalised characters prove nothing", () => {
    expect(findSnippet(BODY, "  “32%”  ")).toEqual({ found: false, reason: "too_short" });
    expect(findSnippet(BODY, "반도체 수출이")).toEqual({ found: false, reason: "too_short" });
    expect(normalizeSnippet("  “Hello  World” ")).toBe("Hello World");
  });
});

// ---- the store: scope from the token only ----------------------------------------------------------------------

function family(db: Db = createTestDb()) {
  const users = new UserStore(db);
  const mom = users.create({ email: "mom@example.com", name: "엄마", role: "member", passwordHash: "x" });
  const dad = users.create({ email: "dad@example.com", name: "아빠", role: "admin", passwordHash: "x" });
  const conversations = new ConversationStore(db);
  const c = conversations.create(mom.id);
  const other = conversations.create(mom.id);
  const dads = conversations.create(dad.id);
  const store = new SourceStore(db);
  const page = (scope: { userId: string; conversationId: string; runId: string }, i = 0) => {
    const p = FIXTURE_PAGES[i]!;
    return store.addPage(scope, {
      url: p.url,
      finalUrl: p.url,
      title: p.title,
      site: p.site,
      publishedAt: p.publishedAt,
      contentType: "text/html",
      body: p.text,
      truncated: false,
    })!;
  };
  const run = (conversationId: string, userId = mom.id) => ({
    userId,
    conversationId,
    runId: crypto.randomUUID(),
  });
  return { db, users, mom, dad, c, other, dads, sources: store, page, run, cites: new CitationStore(db) };
}

const SNIP = "10월 반도체 수출이 전년 같은 달보다 32% 늘어난";

describe("CitationStore (#25)", () => {
  it("verifies, numbers per run, and keeps the first number for the same snippet", () => {
    const f = family();
    const scope = f.run(f.c.id);
    const src = f.page(scope);
    const a = f.cites.cite(scope, { sourceId: src.id, snippet: SNIP });
    expect(a).toEqual({ n: 1, marker: "[1]", status: "verified", sourceId: src.id });
    // The same passage written differently: still one citation.
    expect(f.cites.cite(scope, { sourceId: src.id, snippet: `“${SNIP}”` }).n).toBe(1);
    const b = f.cites.cite(scope, { sourceId: src.id, snippet: "메모리 가격 회복이 증가를 이끌었다" });
    expect(b).toMatchObject({ n: 2, status: "verified" });
    const c = f.cites.cite(scope, { sourceId: src.id, snippet: "메모리 가격 하락이 감소를 불렀다" });
    expect(c).toMatchObject({ n: 3, status: "snippet_not_found" });
    // Another run of the same conversation numbers from 1 again.
    expect(f.cites.cite(f.run(f.c.id), { sourceId: src.id, snippet: SNIP }).n).toBe(1);
    const rows = f.cites.forRun(scope.runId);
    expect(rows.map((r) => [r.n, r.status, r.quote])).toEqual([
      [1, "verified", "10월 반도체 수출이 전년 같은 달보다 32% 늘어난"],
      [2, "verified", "메모리 가격 회복이 증가를 이끌었다"],
      [3, "snippet_not_found", null],
    ]);
    expect(rows[0]!.source?.id).toBe(src.id);
  });

  it("a retry of a citation that did not verify is checked again and keeps its number (round 15)", () => {
    const f = family();
    const scope = f.run(f.c.id);
    const body = (t: string) =>
      f.sources.addPage(scope, {
        url: `https://e.example/${encodeURIComponent(t)}`,
        finalUrl: `https://e.example/${encodeURIComponent(t)}`,
        title: "t",
        site: "e.example",
        contentType: "text/html",
        body: t,
        truncated: false,
      })!;
    for (const [page, bare, exact] of [
      ["대표는 “올해 매출 목표는 100”이라고 말했다.", "올해 매출 목표는 100", "“올해 매출 목표는 100”"],
      ["표에 적힌 값은 “1,000,000”이다.", "1,000,000", "“1,000,000”"],
      ['그는 "내년 성장률 목표는 3.5"라고 했다.', "내년 성장률 목표는 3.5", '"내년 성장률 목표는 3.5"'],
    ]) {
      const src = body(page!);
      const first = f.cites.cite(scope, { sourceId: src.id, snippet: bare! });
      expect(first.status, bare).toBe("snippet_not_found");
      const retry = f.cites.cite(scope, { sourceId: src.id, snippet: exact! });
      expect(retry, exact).toEqual({ ...first, status: "verified" });
      // A verified entry is not checked again (and a later failing variant cannot downgrade it).
      expect(f.cites.cite(scope, { sourceId: src.id, snippet: bare! })).toEqual(retry);
      const row = f.cites.forRun(scope.runId).find((r) => r.n === first.n)!;
      expect(row.status).toBe("verified");
      expect(row.quote).not.toBeNull();
    }
    // A retry that still fails keeps the entry as it was.
    const src = body("다른 본문입니다 정말로.");
    const a = f.cites.cite(scope, { sourceId: src.id, snippet: "없는 구절입니다 정말" });
    expect(f.cites.cite(scope, { sourceId: src.id, snippet: "“없는 구절입니다 정말”" })).toEqual(a);
  });

  it("the duplicate key is case-sensitive: 100Mbps and 100MBps are two citations (round 10)", () => {
    const f = family();
    const scope = f.run(f.c.id);
    const src = f.page(scope);
    const a = f.cites.cite(scope, { sourceId: src.id, snippet: "회선의 최대 속도는 100Mbps" });
    const b = f.cites.cite(scope, { sourceId: src.id, snippet: "회선의 최대 속도는 100MBps" });
    expect([a.n, b.n]).toEqual([1, 2]);
    expect(f.cites.cite(scope, { sourceId: src.id, snippet: "“회선의 최대 속도는 100Mbps”" }).n).toBe(1);
  });

  it("a search result (no page text) is fetch_failed", () => {
    const f = family();
    const scope = f.run(f.c.id);
    const hit = f.sources.addSearchResult(scope, {
      provider: "test",
      url: "https://news.example/a",
      title: "제목",
      site: "news.example",
      snippet: SNIP,
    })!;
    expect(f.cites.cite(scope, { sourceId: hit.id, snippet: SNIP })).toMatchObject({
      status: "fetch_failed",
    });
  });

  it("another conversation's or another user's source is unknown_source, and its id is not kept", () => {
    const f = family();
    const mine = f.page(f.run(f.other.id));
    const dads = f.page(f.run(f.dads.id, f.dad.id));
    const scope = f.run(f.c.id);
    for (const id of [mine.id, dads.id, "made-up", crypto.randomUUID()]) {
      const r = f.cites.cite(scope, { sourceId: id, snippet: SNIP });
      expect(r, id).toMatchObject({ status: "unknown_source", sourceId: null });
    }
    expect(
      f.db
        .select()
        .from(citations)
        .all()
        .map((r) => r.sourceId),
    ).toEqual([null]);
    // A row of this conversation that is somehow another user's (the owner check is the second line).
    f.db.update(sources).set({ conversationId: f.c.id }).where(eq(sources.id, dads.id)).run();
    expect(f.cites.cite(f.run(f.c.id), { sourceId: dads.id, snippet: SNIP }).status).toBe("unknown_source");
  });

  it("a token whose user does not own the conversation registers nothing", () => {
    const f = family();
    const src = f.page(f.run(f.c.id));
    expect(() => f.cites.cite(f.run(f.c.id, f.dad.id), { sourceId: src.id, snippet: SNIP })).toThrow(
      CiteRefused,
    );
    expect(f.db.select().from(citations).all()).toEqual([]);
  });

  it("an earlier answer's source is cited again and checked again against the stored text", () => {
    const f = family();
    const src = f.page(f.run(f.c.id));
    expect(f.cites.cite(f.run(f.c.id), { sourceId: src.id, snippet: SNIP }).status).toBe("verified");
    // The stored text is what counts — not the earlier result.
    f.db.update(sources).set({ body: "다른 글" }).where(eq(sources.id, src.id)).run();
    expect(f.cites.cite(f.run(f.c.id), { sourceId: src.id, snippet: SNIP }).status).toBe("snippet_not_found");
    f.db.update(sources).set({ body: null }).where(eq(sources.id, src.id)).run();
    expect(f.cites.cite(f.run(f.c.id), { sourceId: src.id, snippet: SNIP }).status).toBe("fetch_failed");
  });

  it("refuses too short a snippet and more than the per-run limit", () => {
    const f = family();
    const scope = f.run(f.c.id);
    const src = f.page(scope);
    expect(() => f.cites.cite(scope, { sourceId: src.id, snippet: "32%" })).toThrow("cite_snippet_too_short");
    for (let i = 0; i < CITATION_LIMITS.perRun; i++)
      f.cites.cite(scope, { sourceId: src.id, snippet: `없는 구절 번호 ${i}입니다` });
    expect(() => f.cites.cite(scope, { sourceId: src.id, snippet: SNIP })).toThrow("cite_limit");
  });
});

// ---- the tools on our MCP server ---------------------------------------------------------------------------

describe("cite and sources_list on our MCP server (#25)", () => {
  function service(f: ReturnType<typeof family>) {
    const tokens = new McpTokens();
    const logs: Record<string, unknown>[] = [];
    const log = {
      info: (o: Record<string, unknown>, msg: string) => logs.push({ ...o, msg }),
      warn: (o: Record<string, unknown>, msg: string) => logs.push({ ...o, msg }),
      error: (o: Record<string, unknown>, msg: string) => logs.push({ ...o, msg }),
    };
    const svc = new McpService(tokens, f.users, {
      skills: [SELFTEST_SKILL],
      log: log as never,
      web: {
        sources: f.sources,
        citations: f.cites,
        worker: fixtureWebWorker(),
        fetchProxy: {
          endpoint: async () => ({ url: "http://127.0.0.1:9", port: 9 }) as never,
          close: async () => {},
        },
        searchProviders: [],
      },
    });
    closers.push(() => svc.close());
    const call = async (
      scope: { userId: string; conversationId: string; runId: string },
      tool: string,
      args: unknown,
    ) => {
      const { url } = await svc.endpoint();
      const r = await callOurTool(url, tokens.issue(scope), tool, args);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(r.content[0]!.text!) as Record<string, unknown>;
      } catch {
        body = { text: r.content[0]?.text }; // the MCP SDK's own input validation answers in words
      }
      return { isError: r.isError, body };
    };
    return { svc, call, logs };
  }

  it("fetch → cite in the token's conversation; other conversations' ids are unknown_source; logs hold codes only", async () => {
    const f = family();
    const { svc, call, logs } = service(f);
    expect(svc.toolNamesFor(f.mom.id)).toEqual([
      "echo_time",
      "web_fetch",
      "sources_list",
      "cite",
      "skill_selftest",
    ]);
    const scope = f.run(f.c.id);
    const page = await call(scope, "web_fetch", { url: FIXTURE_PAGES[0]!.url });
    const sourceId = page.body.sourceId as string;
    const ok = await call(scope, "cite", { sourceId, snippet: SNIP });
    expect(ok).toMatchObject({
      isError: false,
      body: {
        n: 1,
        marker: "[1]",
        status: "verified",
        sourceId,
        site: "가나다 신문",
        url: FIXTURE_PAGES[0]!.url,
      },
    });
    // The same id through a token of another conversation (same user) and of another user.
    const elsewhere = await call(f.run(f.other.id), "cite", { sourceId, snippet: SNIP });
    expect(elsewhere.body).toMatchObject({ status: "unknown_source", sourceId: null });
    expect(elsewhere.body).not.toHaveProperty("url");
    const dad = await call(f.run(f.dads.id, f.dad.id), "cite", { sourceId, snippet: SNIP });
    expect(dad.body).toMatchObject({ status: "unknown_source", sourceId: null });
    // Strict input: no scope fields can be smuggled in.
    const smuggled = await call(f.run(f.other.id), "cite", {
      sourceId,
      snippet: SNIP,
      conversationId: f.c.id,
    });
    expect(smuggled.isError).toBe(true);
    const short = await call(scope, "cite", { sourceId, snippet: "32%" });
    expect(short).toEqual({ isError: true, body: { error: "cite_snippet_too_short" } });
    // A token for a conversation the user does not own.
    const notMine = await call(f.run(f.c.id, f.dad.id), "cite", { sourceId, snippet: SNIP });
    expect(notMine).toEqual({ isError: true, body: { error: "cite_not_allowed" } });

    const cites = logs.filter((l) => l.msg === "citation.finished").map((l) => sanitizeRecord(l));
    expect(cites.map((l) => l.citeCode)).toEqual([
      "verified",
      "unknown_source",
      "unknown_source",
      "cite_snippet_too_short",
      "cite_not_allowed",
    ]);
    const text = JSON.stringify(logs.map((l) => sanitizeRecord(l)));
    for (const secret of [sourceId, "반도체", "32%", FIXTURE_PAGES[0]!.url, "가나다"])
      expect(text).not.toContain(secret);
  });

  it("sources_list: this conversation's own sources, titles framed as external content", async () => {
    const f = family();
    const { call } = service(f);
    const scope = f.run(f.c.id);
    await call(scope, "web_fetch", { url: FIXTURE_PAGES[0]!.url });
    await call(f.run(f.other.id), "web_fetch", { url: FIXTURE_PAGES[1]!.url });
    const r = await call(f.run(f.c.id), "sources_list", {});
    const items = r.body.items as { sourceId: string; url: string; hasText: boolean }[];
    expect(items.map((i) => [i.url, i.hasText])).toEqual([[FIXTURE_PAGES[0]!.url, true]]);
    expect(r.body.content).toMatch(
      /^<external_content source="sources">\n\[1\] 10월 반도체 수출 32% 증가\n<\/external_content>$/,
    );
    expect(JSON.stringify(r.body.items)).not.toContain("반도체 수출 32% 증가"); // titles only inside the block
    const dad = await call(f.run(f.c.id, f.dad.id), "sources_list", {});
    expect(dad).toEqual({ isError: true, body: { error: "cite_not_allowed" } });
  });
});

// ---- the answer text: paragraphs, markers, the note -------------------------------------------------------

const kinds = (t: string) => citationUnits(t).map((u) => [u.kind, t.slice(u.start, u.end)]);

describe("paragraphs that need a citation", () => {
  it("headings, list lead-ins, disclaimers, rules and code are not checked; paragraphs, items and tables are", () => {
    const t = [
      "## 제목",
      "",
      "**굵은 제목**",
      "",
      "첫 문단이에요[1].",
      "",
      "주요 내용:",
      "- 첫째 항목[2]",
      "  이어지는 줄",
      "- 둘째 항목",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "---",
      "",
      "```",
      "x = [3]",
      "```",
      "",
      "※ 공개 자료를 바탕으로 했어요.",
      "",
      FINANCE_DISCLAIMER,
      "",
      "출처가 충분하지 않아요.",
    ].join("\n");
    expect(kinds(t)).toEqual([
      ["heading", "## 제목"],
      ["heading", "**굵은 제목**"],
      ["body", "첫 문단이에요[1]."],
      ["lead_in", "주요 내용:"],
      ["body", "- 첫째 항목[2]\n  이어지는 줄"],
      ["body", "- 둘째 항목"],
      ["body", "| a | b |\n|---|---|\n| 1 | 2 |"],
      ["rule", "---"],
      ["code", "```\nx = [3]\n```"],
      ["disclaimer", "※ 공개 자료를 바탕으로 했어요."],
      ["disclaimer", FINANCE_DISCLAIMER],
      ["disclaimer", "출처가 충분하지 않아요."],
    ]);
    // The code block's [3] is not a marker.
    expect(citationMarkers(t).map((m) => m.n)).toEqual([1, 2]);
    expect(uncitedUnits(t).map((r) => t.slice(r.start, r.end))).toEqual([
      "- 둘째 항목",
      "| a | b |\n|---|---|\n| 1 | 2 |",
    ]);
  });

  it("a disclaimer is only a pure disclaimer: mixed or factual short paragraphs are checked (review #97)", () => {
    for (const t of [
      "※ 반도체 수출은 32% 증가했다.",
      "※ 반도체 수출은 크게 늘었다.",
      "출처가 부족하지만 양산은 확정됐다.",
      "출처가 충분하지 않은데 양산은 확정됐다.",
      "출처가 충분하지 않아요. 양산은 2027년이에요.",
      "출처가 충분하지 않아요. 양산은 확정됐어요.",
      "※ 이 답변은 공개 보도를 바탕으로 했어요. 수출은 늘었어요.",
      `${FINANCE_DISCLAIMER} 삼성전자는 오를 거예요.`,
      "※ 이 답변은 수출이 32% 늘었다는 보도를 바탕으로 했어요.",
      "출처가 부족해요. 2개 기사뿐이에요.",
      // Round 2: prefixes of a notice that go on to state something.
      "출처가 부족합니다만 양산은 확정됐습니다.",
      "※ 최신 정보는 양산이 확정됐다는 소식입니다.",
      "출처가 충분하지 않은데요 양산은 확정됐어요.",
      "출처가 부족하지만요, 양산은 확정이에요.",
      "자료가 부족합니다만, 확인해 보세요.",
      "※ 참고용이지만 양산은 확정됐어요.",
      "공식 발표를 확인해 보니 양산은 확정이에요.",
    ])
      expect(kinds(t)[0]![0], t).toBe("body");
    for (const t of [
      "※ 이 답변은 공개 보도를 바탕으로 했어요.",
      "※ 참고용이에요.",
      "출처가 충분하지 않아요.",
      "출처가 충분하지 않아요. 공식 발표를 확인해 보세요.",
      "자료가 부족해요.",
      "출처가 충분하지 않습니다.",
      "공식 발표를 확인해 보세요.",
      `※ ${FINANCE_DISCLAIMER}`,
    ])
      expect(kinds(t)[0]![0], t).toBe("disclaimer");
  });

  it("sentence-end markers (answers without web tools)", () => {
    const ns = (t: string) => sentenceEndMarkers(t).map((m) => m.n);
    expect(ns("최신 수출은 32% 증가했다[1].")).toEqual([1]);
    expect(ns("늘었다.[2] 그리고")).toEqual([2]);
    expect(ns("늘었다[1][2]. 끝")).toEqual([1, 2]);
    expect(ns("늘었다[3]\n다음")).toEqual([3]);
    expect(ns("늘었다[3]  \n다음")).toEqual([3]);
    expect(ns("늘었다[3]\t")).toEqual([3]);
    // Round 3: prose after ASCII words at a line end is a marker; only expressions are indexing.
    expect(ns("Exports increased this year[1]  \n")).toEqual([1]);
    expect(ns("신제품 이름은 Galaxy Ultra[1]  \n다음")).toEqual([1]);
    // Round 4: a comma, a hyphen or `&` before the name is prose, not an expression.
    expect(ns("지원 운영체제는 Windows, Linux[1]\n")).toEqual([1]);
    expect(ns("사용한 모델은 GPT-4o[1]\n")).toEqual([1]);
    expect(ns("기준 지수는 S&P500[1]\n")).toEqual([1]);
    // Round 5: a dot is not an expression context (obj.items[1] at a prose line end is a marker too).
    expect(ns("해당 런타임은 Node.js[1]\n")).toEqual([1]);
    expect(ns("권장 버전은 Python 3.12[1]\n")).toEqual([1]);
    expect(ns("공식 사이트는 example.com[1]\n")).toEqual([1]);
    expect(ns("설정값은 obj.items[1]\n")).toEqual([1]);
    expect(ns("모델은 X1[2]")).toEqual([2]);
    expect(ns("Exports rose[4].")).toEqual([4]);
    for (const t of [
      "배열 a[1] 은 두 번째",
      "a[1].length",
      "x = a[1]\n",
      "`b[2]`.",
      "[1](http://x).",
      "m[1][2] = 3",
      // Round 3: expressions only.
      "y = foo(a[1]\n",
      "f(a[1]\n",
      "m[0][1]\n",
      "total += arr[2]  \n",
      "arr[idx[1]\n",
    ])
      expect(ns(t), t).toEqual([]);
  });

  it("the exclusions are narrow: a colon not before a list, a long 'not enough' paragraph and a long ※ text are body", () => {
    expect(kinds("결론은 이렇습니다:\n\n다음 문단")).toEqual([
      ["body", "결론은 이렇습니다:"],
      ["body", "다음 문단"],
    ]);
    const long = `출처가 충분하지 않지만 ${"반도체 수출은 크게 늘었다. ".repeat(6)}`;
    expect(kinds(long)[0]![0]).toBe("body");
    expect(kinds(`※ ${"가".repeat(300)}`)[0]![0]).toBe("body");
    expect(kinds("※ 참고용이에요. ".repeat(30))[0]![0]).toBe("body");
    // A lead-in of two lines is a paragraph.
    expect(kinds("첫 줄\n둘째 줄:\n- 항목")[0]![0]).toBe("body");
  });

  it("markers: [n] only — not a markdown link, a footnote or inline code", () => {
    expect(citationMarkers("a[1] b[12] c[1](http://x) d[^2] e[0] f[ 3 ]").map((m) => m.n)).toEqual([1, 12]);
    expect(citationMarkers("코드 `x[1]` 와 늘었다[2].").map((m) => m.n)).toEqual([2]);
  });
});

describe("citationNote", () => {
  const f = family();
  const scope = f.run(f.c.id);
  const src = f.page(scope);
  f.cites.cite(scope, { sourceId: src.id, snippet: SNIP });
  f.cites.cite(scope, { sourceId: src.id, snippet: "없는 구절을 인용했어요" });
  f.cites.cite(scope, { sourceId: "made-up", snippet: "아무 구절이나 적었어요" });
  const text = (t: string): MessagePart[] => [{ type: "text", text: t }];

  it("each marker with its server status; a marker no cite produced is unknown_source", () => {
    const note = citationNote(scope.runId, text("가[1]. 나[2]. 다[3]. 라[4]."), f.cites)!;
    expect(note.citations).toEqual([
      {
        n: 1,
        status: "verified",
        sourceId: src.id,
        title: FIXTURE_PAGES[0]!.title,
        site: "가나다 신문",
        url: FIXTURE_PAGES[0]!.url,
        publishedAt: FIXTURE_PAGES[0]!.publishedAt,
        quote: SNIP,
      },
      expect.objectContaining({
        n: 2,
        status: "snippet_not_found",
        sourceId: src.id,
        quote: "없는 구절을 인용했어요",
      }),
      {
        n: 3,
        status: "unknown_source",
        sourceId: null,
        title: null,
        site: null,
        url: null,
        publishedAt: null,
        quote: null,
      },
      {
        n: 4,
        status: "unknown_source",
        sourceId: null,
        title: null,
        site: null,
        url: null,
        publishedAt: null,
        quote: null,
      },
    ]);
    expect(note.missing).toEqual([]);
    // Only verified reads as normal.
    expect(note.citations.map((c) => citationVerified(c.status))).toEqual([true, false, false, false]);
    expect(CITATION_STATUS_TEXT.verified).not.toContain("⚠️");
    for (const s of ["snippet_not_found", "fetch_failed", "unknown_source"] as const)
      expect(CITATION_STATUS_TEXT[s].startsWith("⚠️ ")).toBe(true);
  });

  it("fits the shared schema even with long titles and quotes of characters outside the BMP", () => {
    const s2 = f.run(f.c.id);
    const emoji = "😀".repeat(400);
    const row = f.sources.addPage(s2, {
      url: "https://e.example/x",
      finalUrl: "https://e.example/x",
      title: emoji,
      site: emoji,
      contentType: "text/html",
      body: `${emoji} 끝`,
      truncated: false,
    })!;
    f.cites.cite(s2, { sourceId: row.id, snippet: "😀".repeat(250) });
    const note = citationNote(s2.runId, text("가[1]."), f.cites)!;
    expect(note.citations[0]!.status).toBe("verified");
    expect(CitationNotePart.parse(note)).toEqual(note);
    expect(note.citations[0]!.quote).toBe("😀".repeat(250));
  });

  it("marks the body paragraphs without a marker", () => {
    const t = "## 요약\n\n가[1].\n\n나는 출처가 없어요.\n\n※ 참고용이에요.";
    const note = citationNote(scope.runId, text(t), f.cites)!;
    expect(note.missing.map((r) => t.slice(r.start, r.end))).toEqual(["나는 출처가 없어요."]);
  });

  it("a short progress note before the first tool call is not flagged; facts before it and notes after it are", () => {
    const call: MessagePart[] = [
      { type: "tool_call", id: "t", name: "web_fetch", input: {} },
      { type: "tool_result", callId: "t", output: {}, isError: false },
    ];
    const missingOf = (parts: MessagePart[]) => {
      const t = parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
      return citationNote(scope.runId, parts, f.cites)!.missing.map((r) => t.slice(r.start, r.end));
    };
    expect(missingOf([...text("자료를 찾아 비교해 볼게요.\n\n"), ...call, ...text("가[1].")])).toEqual([]);
    expect(missingOf([...text("Let me search for that.\n\n"), ...call, ...text("가[1].")])).toEqual([]);
    // A statement before the tool call, a note with a figure, two sentences, or a note after the call: checked.
    expect(missingOf([...text("반도체 수출은 늘었어요.\n\n"), ...call, ...text("가[1].")])).toEqual([
      "반도체 수출은 늘었어요.",
    ]);
    expect(missingOf([...text("2026년 자료를 찾아볼게요.\n\n"), ...call, ...text("가[1].")])).toHaveLength(1);
    expect(
      missingOf([...text("수출이 늘었어요. 더 찾아볼게요.\n\n"), ...call, ...text("가[1].")]),
    ).toHaveLength(1);
    // Round 2: a fact joined to the note.
    for (const note of [
      "양산이 확정됐으니 자료를 더 찾아볼게요.",
      "양산이 확정돼서 더 찾아볼게요.",
      "Exports rose, so let me check.",
      // Round 3: a complement clause that carries a fact.
      "양산이 확정됐음을 알려드리겠습니다.",
      "양산이 확정됐다는 소식을 확인해 볼게요.",
      "양산이 확정이라는 기사를 찾아볼게요.",
    ])
      expect(missingOf([...text(`${note}\n\n`), ...call, ...text("가[1].")]), note).toHaveLength(1);
    expect(missingOf([...call, ...text("가[1].\n\n더 찾아볼게요.")])).toEqual(["더 찾아볼게요."]);
  });

  it("applies when the run used a web tool or cited — and not otherwise", () => {
    const fresh = crypto.randomUUID();
    // No web tool, no citation, no [n] that stands where a citation stands: no note.
    for (const t of [
      "그냥 답이에요.",
      "배열 a[1] 은 두 번째 값",
      "a[1].length 는 3",
      "x = a[1]\n",
      "`b[2]`.",
      "[1](http://x).",
    ])
      expect(citationNote(fresh, text(t), f.cites), t).toBeUndefined();
    // A sentence that ends in [n] without any citation pretends to cite: checked, unknown, nothing else marked.
    const fake = citationNote(fresh, text("최신 수출은 32% 증가했다[1].\n\n출처 없는 다른 문단."), f.cites)!;
    expect(fake.citations).toEqual([
      expect.objectContaining({ n: 1, status: "unknown_source", sourceId: null }),
    ]);
    expect(fake.markers).toEqual([{ n: 1, start: 15, end: 18 }]);
    expect(fake.missing).toEqual([]);
    const withFetch: MessagePart[] = [
      { type: "tool_call", id: "t", name: "mcp__agentlee__web_fetch", input: {} },
      { type: "tool_result", callId: "t", output: { error: "web_blocked" }, isError: true },
      ...text("가져오지 못했지만 이렇다고 해요."),
    ];
    const note = citationNote(fresh, withFetch, f.cites)!;
    expect(note.citations).toEqual([]);
    expect(note.missing).toHaveLength(1);
    // Codex reports tool names without the prefix.
    expect(
      citationNote(fresh, [{ ...withFetch[0]!, name: "web_search" } as MessagePart, ...text("x")], f.cites),
    ).toBeDefined();
    // Nothing written: nothing to note.
    expect(citationNote(scope.runId, [], f.cites)).toBeUndefined();
  });
});
