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

describe("traceability parser catches format drift", () => {
  const traceRows = parseTrace(trace);

  it("flags a FR heading whose number is lost", () => {
    const broken = prd.replace(/^### FR-15\..*$/m, "### 가족 이메일 동기화");
    expect(parsePrd(broken).problems.join("\n")).toMatch(/outside any FR section/);
  });

  it("still parses a heading with different punctuation", () => {
    const changed = prd.replace(/^### FR-15\./m, "### FR-15:");
    const parsed = parsePrd(changed);
    expect(parsed.problems).toEqual([]);
    expect(parsed.keys).toContain("FR-15.7");
  });

  it("flags indented and out-of-order numbered items", () => {
    const indented = prd.replace(/^7\. \*\*관리자 이메일 변경\*\*/m, "   7. **관리자 이메일 변경**");
    expect(parsePrd(indented).problems.join("\n")).toMatch(/indented numbered item/);
    const skipped = prd.replace(/^7\. \*\*관리자 이메일 변경\*\*/m, "8. **관리자 이메일 변경**");
    expect(parsePrd(skipped).problems.join("\n")).toMatch(/out of order/);
  });

  it("reports a missing row and an empty issue cell even if another cell mentions an issue", () => {
    const { keys } = parsePrd(prd);
    const noRow = trace.replace(/^\| FR-4\.3 .*\n/m, "");
    expect(unmapped(keys, parseTrace(noRow))).toEqual(["FR-4.3"]);
    const emptyCell = trace.replace(/^\| FR-1\.2 \| (.*?) \| #9 \|/m, "| FR-1.2 | $1 #9 | |");
    expect(unmapped(keys, parseTrace(emptyCell))).toEqual(["FR-1.2"]);
  });

  it("requires deferred items to point at their tracking issue", () => {
    const { keys } = parsePrd(prd);
    const bare = trace.replace(/^\| FR-2\.5 \| (.*?) \| #64 \(v1\.1 백로그\) \|/m, "| FR-2.5 | $1 | #5 |");
    expect(traceRows.get("FR-2.5")).toContain("#64");
    expect(unmapped(keys, parseTrace(bare))).toEqual(["FR-2.5"]);
  });
});
