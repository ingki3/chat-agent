// Parses PRD.md and docs/traceability.md so tests can prove every PRD item is mapped to an issue.

/** PRD items deliberately deferred; their row must point at the named tracking issue. */
export const DEFERRED: Record<string, string> = { "FR-2.5": "#64" };

export type PrdParse = { keys: string[]; problems: string[] };

export function parsePrd(md: string): PrdParse {
  const keys: string[] = [];
  const problems: string[] = [];
  const lines = md.split("\n");
  let inFrChapter = false; // between "## 5." and "## 6."
  let section: string | null = null;
  let expected = 1;
  const frNumbers: number[] = [];
  const itemCount = new Map<string, number>();

  for (const [i, line] of lines.entries()) {
    if (/^## /.test(line)) {
      inFrChapter = /^## 5\./.test(line);
      section = null;
      continue;
    }
    if (/^#{3,6} /.test(line)) {
      const fr = /^### (FR-(\d+))\b/.exec(line);
      section = fr ? fr[1]! : null;
      expected = 1;
      if (fr) {
        frNumbers.push(Number(fr[2]));
        itemCount.set(section!, 0);
      } else if (inFrChapter && /FR-\d+/.test(line)) {
        problems.push(`line ${i + 1}: FR heading not recognised: ${line.trim()}`);
      }
      continue;
    }
    const top = /^(\d+)\. /.exec(line);
    const indented = /^\s+(\d+)\. /.exec(line);
    if (inFrChapter && indented)
      problems.push(`line ${i + 1}: indented numbered item is not tracked: ${line.trim()}`);
    if (!top) continue;
    if (inFrChapter && !section) {
      problems.push(`line ${i + 1}: numbered requirement outside any FR section`);
      continue;
    }
    if (section) {
      const n = Number(top[1]);
      if (n !== expected) problems.push(`${section}: item ${n} out of order (expected ${expected})`);
      expected = n + 1;
      keys.push(`${section}.${n}`);
      itemCount.set(section, (itemCount.get(section) ?? 0) + 1);
    }
  }

  frNumbers.forEach((n, idx) => {
    if (n !== idx + 1) problems.push(`FR headings not contiguous: found FR-${n} at position ${idx + 1}`);
  });
  for (const [s, c] of itemCount) if (c === 0) problems.push(`${s} has no numbered items`);

  for (const d of md.matchAll(/^\| (D\d+) \|/gm)) keys.push(d[1]!);
  const nfr = md.split(/^## 8\./m)[1]?.split(/^## 9\./m)[0] ?? "";
  for (const row of nfr.matchAll(/^\| ([^|-][^|]*?) \|/gm)) {
    const name = row[1]!.trim().replace(/\s*\(.*\)$/, "");
    if (name !== "분류") keys.push(`NFR ${name}`);
  }
  const ac = md.split(/^## 11\./m)[1]?.split(/^## 12\./m)[0] ?? "";
  let acExpected = 1;
  for (const a of ac.matchAll(/^(\d+)\. /gm)) {
    const n = Number(a[1]);
    if (n !== acExpected) problems.push(`AC ${n} out of order (expected ${acExpected})`);
    acExpected = n + 1;
    keys.push(`AC-${n}`);
  }

  const seen = new Set<string>();
  for (const k of keys) {
    if (seen.has(k)) problems.push(`duplicate PRD key ${k}`);
    seen.add(k);
  }
  return { keys, problems };
}

/** Maps each table row key (first cell) to its "담당 이슈" cell, using each table's own header. */
export function parseTrace(md: string): Map<string, string> {
  const rows = new Map<string, string>();
  let issueCol = -1;
  for (const line of md.split("\n")) {
    if (!line.startsWith("|")) {
      issueCol = -1;
      continue;
    }
    const cells = line.split("|").map((c) => c.trim());
    if (cells.includes("담당 이슈")) {
      issueCol = cells.indexOf("담당 이슈");
      continue;
    }
    if (issueCol < 0 || /^-+$/.test(cells[1] ?? "")) continue;
    rows.set(cells[1]!, cells[issueCol] ?? "");
  }
  return rows;
}

export function unmapped(prdKeys: string[], trace: Map<string, string>): string[] {
  return prdKeys.filter((k) => {
    const cell = trace.get(k);
    if (cell === undefined) return true;
    if (k in DEFERRED) return !cell.includes(DEFERRED[k]!);
    return !/#\d+/.test(cell);
  });
}
