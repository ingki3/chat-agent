import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Every PRD item must have a row in docs/traceability.md that names at least one issue (or an explicit v1.1 deferral).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const prd = fs.readFileSync(path.join(root, "PRD.md"), "utf8");
const trace = fs.readFileSync(path.join(root, "docs/traceability.md"), "utf8");

function prdKeys(): string[] {
  const keys: string[] = [];
  let section: string | null = null;
  for (const line of prd.split("\n")) {
    const fr = /^### (FR-\d+)\./.exec(line);
    if (fr) section = fr[1]!;
    else if (/^## /.test(line)) section = null;
    const item = /^(\d+)\. /.exec(line);
    if (section && item) keys.push(`${section}.${item[1]}`);
  }
  for (const d of prd.matchAll(/^\| (D\d+) \|/gm)) keys.push(d[1]!);
  const nfr = prd.split("## 8.")[1]?.split("## 9.")[0] ?? "";
  for (const row of nfr.matchAll(/^\| ([^|-][^|]*?) \|/gm)) {
    const name = row[1]!.trim().split(" ")[0]!;
    if (name !== "분류") keys.push(`NFR ${name}`);
  }
  const ac = prd.split("## 11.")[1]?.split("## 12.")[0] ?? "";
  for (const a of ac.matchAll(/^(\d+)\. /gm)) keys.push(`AC-${a[1]}`);
  return keys;
}

describe("traceability", () => {
  const keys = prdKeys();

  it("finds the PRD structure", () => {
    expect(keys.filter((k) => k.startsWith("FR-")).length).toBeGreaterThanOrEqual(100);
    expect(keys.filter((k) => /^D\d+$/.test(k))).toHaveLength(8);
    expect(keys.filter((k) => k.startsWith("AC-"))).toHaveLength(13);
    expect(keys.filter((k) => k.startsWith("NFR "))).toHaveLength(11);
  });

  it.each(keys)("%s is mapped to an issue", (key) => {
    const row = trace.split("\n").find((l) => l.startsWith(`| ${key} `) || l.startsWith(`| ${key}|`));
    expect(row, `missing row for ${key}`).toBeDefined();
    expect(/#\d+|v1\.1/.test(row!), `row for ${key} names no issue`).toBe(true);
  });
});
