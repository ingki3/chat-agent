import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePrd, parseTrace, unmapped } from "../traceability.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const prd = fs.readFileSync(path.join(root, "PRD.md"), "utf8");
const trace = fs.readFileSync(path.join(root, "docs/traceability.md"), "utf8");

describe("traceability (real documents)", () => {
  const { keys, problems } = parsePrd(prd);

  it("parses the PRD without structural problems", () => {
    expect(problems).toEqual([]);
    expect(keys.filter((k) => k.startsWith("FR-"))).toHaveLength(100);
    expect(keys.filter((k) => /^D\d+$/.test(k))).toHaveLength(8);
    expect(keys.filter((k) => k.startsWith("NFR "))).toHaveLength(11);
    expect(keys.filter((k) => k.startsWith("AC-"))).toHaveLength(13);
  });

  it("maps every PRD item to an issue in the 담당 이슈 column", () => {
    expect(unmapped(keys, parseTrace(trace))).toEqual([]);
  });
});

// Synthetic documents keep these regression checks independent of the real PRD wording.
const MINI_PRD = [
  "## 5. 기능 요구사항 (FR)",
  "### FR-1. 계정",
  "1. 첫째",
  "2. 둘째",
  "### FR-2. 대화",
  "1. 하나",
  "## 6. 화면",
  "## 8. 비기능",
  "| 분류 | 요구사항 |",
  "|---|---|",
  "| 성능 | 빠르게 |",
  "| 청소년 (아들) | 안전 |",
  "## 9. 구성",
  "## 11. 수용 기준",
  "1. 접속된다",
  "## 12. 열린 질문",
].join("\n");
const MINI_TRACE = [
  "| 항목 | 내용 | 담당 이슈 | 검증 |",
  "|---|---|---|---|",
  "| FR-1.1 | 첫째 | #1 | U |",
  "| FR-1.2 | 둘째 #9 | #2 | U |",
  "| FR-2.1 | 하나 | #3 | U |",
  "",
  "| 항목 | 담당 이슈 | 검증 |",
  "|---|---|---|",
  "| NFR 성능 | #4 | M |",
  "| NFR 청소년 | #5 | M |",
  "| AC-1 | #6 | E |",
].join("\n");

describe("traceability parser catches format drift", () => {
  it("parses the synthetic baseline cleanly", () => {
    const { keys, problems } = parsePrd(MINI_PRD);
    expect(problems).toEqual([]);
    expect(keys).toEqual(["FR-1.1", "FR-1.2", "FR-2.1", "NFR 성능", "NFR 청소년", "AC-1"]);
    expect(unmapped(keys, parseTrace(MINI_TRACE))).toEqual([]);
  });

  it("flags a FR heading whose number is lost", () => {
    const broken = MINI_PRD.replace("### FR-2. 대화", "### 대화");
    expect(parsePrd(broken).problems.join("\n")).toMatch(/outside any FR section/);
  });

  it("still parses a heading with different punctuation", () => {
    const parsed = parsePrd(MINI_PRD.replace("### FR-2. 대화", "### FR-2: 대화"));
    expect(parsed.problems).toEqual([]);
    expect(parsed.keys).toContain("FR-2.1");
  });

  it("flags indented, out-of-order and non-contiguous items", () => {
    expect(parsePrd(MINI_PRD.replace("2. 둘째", "   2. 둘째")).problems.join("\n")).toMatch(
      /indented numbered item/,
    );
    expect(parsePrd(MINI_PRD.replace("2. 둘째", "3. 둘째")).problems.join("\n")).toMatch(/out of order/);
    expect(parsePrd(MINI_PRD.replace("### FR-2. 대화", "### FR-3. 대화")).problems.join("\n")).toMatch(
      /not contiguous/,
    );
  });

  it("reports a missing row and an empty issue cell even if another cell mentions an issue", () => {
    const { keys } = parsePrd(MINI_PRD);
    expect(unmapped(keys, parseTrace(MINI_TRACE.replace("| FR-2.1 | 하나 | #3 | U |\n", "")))).toEqual([
      "FR-2.1",
    ]);
    expect(
      unmapped(
        keys,
        parseTrace(MINI_TRACE.replace("| FR-1.2 | 둘째 #9 | #2 | U |", "| FR-1.2 | 둘째 #9 | | U |")),
      ),
    ).toEqual(["FR-1.2"]);
  });

  it("requires deferred items to point at their tracking issue", () => {
    const prd = MINI_PRD.replace(
      "### FR-2. 대화\n1. 하나",
      "### FR-2. 대화\n1. 하나\n2. 미룸\n3. 셋\n4. 넷\n5. 프로젝트",
    );
    const { keys } = parsePrd(prd);
    const base = MINI_TRACE.replace(
      "| FR-2.1 | 하나 | #3 | U |",
      "| FR-2.1 | 하나 | #3 | U |\n| FR-2.2 | 미룸 | #7 | U |\n| FR-2.3 | 셋 | #7 | U |\n| FR-2.4 | 넷 | #7 | U |\n| FR-2.5 | 프로젝트 | #64 (v1.1) | — |",
    );
    expect(unmapped(keys, parseTrace(base))).toEqual([]);
    expect(unmapped(keys, parseTrace(base.replace("#64 (v1.1)", "v1.1")))).toEqual(["FR-2.5"]);
    expect(unmapped(keys, parseTrace(base.replace("#64 (v1.1)", "#5")))).toEqual(["FR-2.5"]);
  });
});
