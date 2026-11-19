/**
 * 깊이 조사's report (#211 decision 4): the writer's text is kept only where a server-checked citation backs it. Every
 * sentence needs at least one `verified` marker (`cite` / `file_cite` of the writer's own step); a sentence without
 * one — uncited, or citing only what did not verify — is removed and counted, markers that did not verify are taken
 * out of the sentences that stay, a heading left without content goes, and the markers are numbered again in the
 * order they appear. Tables and code blocks are not kept (the writer is told not to write them): each of their
 * content rows counts as removed. The server then adds the source list and "한계" itself.
 */

/** One citation of the writer's step as the report uses it. */
export type ReportCitation = {
  n: number;
  verified: boolean;
  kind: "web" | "file";
  title: string;
  /** Web: the page's address (http/https only is linked). */
  url?: string | undefined;
  site?: string | undefined;
  /** File: its name and the place of the passage ("3쪽"). */
  place?: string | undefined;
  /** The passage as found in the source. */
  quote: string;
};

export type CleanResult = {
  /** The body, markers numbered 1… in order of appearance. */
  body: string;
  /** Sentences (and table / code rows) removed. */
  removed: number;
  /** Old number → new number, in the new order. */
  numbering: { from: number; to: number }[];
};

const MARK = /\[(\d{1,3})\]/g;

/**
 * Sentences of one line: each ends at `.`, `!`, `?` or `。` (with the markers right after it) followed by a space or
 * the line's end — a dot inside a number or an address ("3.5%", "example.com") does not end one.
 */
export function sentences(line: string): string[] {
  const END = ".!?。";
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < line.length) {
    if (!END.includes(line[i]!)) {
      i++;
      continue;
    }
    let j = i;
    while (j < line.length && END.includes(line[j]!)) j++;
    let k = j;
    for (let m = /^\s*\[\d{1,3}\]/.exec(line.slice(k)); m; m = /^\s*\[\d{1,3}\]/.exec(line.slice(k)))
      k += m[0].length;
    if (k >= line.length || /\s/.test(line[k]!)) {
      out.push(line.slice(start, k));
      start = k;
    }
    i = Math.max(j, k);
  }
  if (start < line.length) out.push(line.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Leading list / quote markers of a line ("- ", "1. ", "> "), kept as they are. */
const PREFIX = /^(\s*(?:>\s*)*(?:[-*+]\s+|\d{1,3}[.)]\s+)?)/;

export function cleanReport(text: string, cites: ReadonlyMap<number, ReportCitation>): CleanResult {
  const ok = (n: number) => cites.get(n)?.verified === true;
  let removed = 0;
  const kept: string[] = [];
  let fence = false;
  const table = { rows: 0 };
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) {
      if (line.trim()) removed++;
      continue;
    }
    if (!line.trim()) {
      kept.push("");
      continue;
    }
    // Tables: not kept; their header and separator rows are not claims, every other row is.
    if (/^\s*\|/.test(line)) {
      if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line)) {
        // The separator: the row before it was the header.
        if (table.rows) removed--;
      } else {
        table.rows++;
        removed++;
      }
      continue;
    }
    table.rows = 0;
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      // The report's own title is the server's: a level-1 heading of the writer's becomes a section.
      kept.push(`${h[1]!.length === 1 ? "##" : h[1]} ${h[2]!.replace(MARK, "").trim()}`);
      continue;
    }
    const prefix = PREFIX.exec(line)![1]!;
    const content = line.slice(prefix.length);
    const out: string[] = [];
    for (const s of sentences(content)) {
      const marks = [...s.matchAll(MARK)].map((m) => Number(m[1]));
      if (!marks.some(ok)) {
        removed++;
        continue;
      }
      // Only the verified markers stay; doubled ones ("[1][1]") are one.
      const seen = new Set<number>();
      const cleaned = s
        .replace(MARK, (m, d: string) => {
          const n = Number(d);
          if (!ok(n) || seen.has(n)) return "";
          seen.add(n);
          return m;
        })
        .replace(/\s+([.!?。,])/g, "$1")
        .replace(/\s{2,}/g, " ")
        .trim();
      out.push(cleaned);
    }
    if (out.length) kept.push(prefix + out.join(" "));
  }
  // Headings with nothing under them (before the next heading of the same or a higher level) go.
  const lines = dropEmptySections(kept);
  // Numbered again in order of appearance.
  const map = new Map<number, number>();
  const numbering: CleanResult["numbering"] = [];
  const body = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .replace(MARK, (_m, d: string) => {
      const n = Number(d);
      let k = map.get(n);
      if (k === undefined) {
        k = map.size + 1;
        map.set(n, k);
        numbering.push({ from: n, to: k });
      }
      return `[${k}]`;
    });
  return { body, removed, numbering };
}

function dropEmptySections(lines: string[]): string[] {
  const level = (l: string) => /^(#{1,6})\s/.exec(l)?.[1]!.length ?? 0;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lv = level(lines[i]!);
    if (!lv) {
      out.push(lines[i]!);
      continue;
    }
    let has = false;
    for (let j = i + 1; j < lines.length; j++) {
      const l2 = level(lines[j]!);
      if (l2 && l2 <= lv) break;
      if (!l2 && lines[j]!.trim()) {
        has = true;
        break;
      }
    }
    if (has) out.push(lines[i]!);
  }
  return out;
}

/** Page or file text going into the markdown: one line, no markup that could open a link, an image or a block. */
export function mdText(s: string, max = 200): string {
  const one = Array.from(
    s
      .replace(/[\r\n\t]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim(),
  );
  const clipped = one.length > max ? `${one.slice(0, max - 1).join("")}…` : one.join("");
  return clipped.replace(/([\\`*_{}[\]()<>#|!~])/g, "\\$1");
}

const safeUrl = (u: string | undefined) => {
  if (!u) return undefined;
  try {
    const p = new URL(u);
    return p.protocol === "https:" || p.protocol === "http:" ? p.toString() : undefined;
  } catch {
    return undefined;
  }
};

export type ReportInput = {
  title: string;
  /** "2026-11-19" (Asia/Seoul). */
  date: string;
  body: string;
  /** The citations the body keeps, by their new number. */
  sources: (ReportCitation & { k: number })[];
  removed: number;
  timedOut: boolean;
  fallback: boolean;
  /** Sub-questions that found nothing verified (or were never reached). */
  unanswered: string[];
  questions: number;
};

/** The whole report: title, the job's line, the body, the source list and "한계". */
export function renderReport(r: ReportInput): string {
  const src = r.sources.map((c) => {
    const quote = `“${mdText(c.quote, 160)}”`;
    if (c.kind === "file")
      return `${c.k}. 📎 ${mdText(c.title, 80)}${c.place ? ` · ${mdText(c.place, 40)}` : ""} — ${quote}`;
    const url = safeUrl(c.url);
    const name = mdText(c.title || c.site || "웹 페이지", 100);
    const link = url ? `[${name}](<${url.replace(/[<>\s]/g, encodeURIComponent)}>)` : name;
    return `${c.k}. ${link}${c.site ? ` — ${mdText(c.site, 40)}` : ""} — ${quote}`;
  });
  const limits = [
    `- 서버가 원문과 대조해 확인하지 못한 문장 ${r.removed}개를 보고서에서 뺐어요.`,
    ...(r.timedOut ? ["- ⏱ 30분 시간 상한에 걸려 일부만 조사했어요."] : []),
    ...(r.fallback
      ? ["- 보고서 작성을 끝내지 못해, 확인된 원문 구절을 하위 질문별로 그대로 정리했어요."]
      : []),
    ...(r.unanswered.length
      ? [`- 확인된 근거를 찾지 못한 하위 질문: ${r.unanswered.map((q) => mdText(q, 80)).join(" / ")}`]
      : []),
    "- 이 보고서는 조사 중에 가져온 공개 웹 페이지와 첨부 파일에서 **원문 구절이 확인된** 내용만 담아요. 확인 시점 이후 바뀐 내용은 반영되지 않아요.",
  ];
  return [
    `# ${mdText(r.title, 120)}`,
    `> 깊이 조사 보고서 · ${r.date} · 하위 질문 ${r.questions}개 · 출처 ${r.sources.length}개${r.timedOut ? " · 시간 상한으로 일부만 조사" : ""}`,
    r.body || "_확인된 근거로 쓸 수 있는 내용이 없었어요._",
    `## 출처\n\n${src.length ? src.join("\n") : "- (없음)"}`,
    `## 한계\n\n${limits.join("\n")}`,
  ].join("\n\n");
}
