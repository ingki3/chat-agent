import {
  citationMarkers,
  citationUnits,
  plainTextRanges,
  sentenceSpans,
  type CitationMarker,
} from "@agentlee/shared";

/**
 * 깊이 조사's report (#211 decision 4): the writer's text is kept only where a server-checked citation backs it. The
 * text is cut exactly as the answers' missing-citation check (#202) cuts it — `citationUnits` (the screen's markdown
 * blocks), `citationMarkers` (not a `[1](link)`, not inside code) and `sentenceSpans` (`결론이다.사실이다[1].` is two
 * sentences). Every sentence needs at least one `verified` marker of the writer's own step (`cite` / `file_cite`); a
 * sentence without one — uncited, or citing only what did not verify — is removed and counted. A heading that states
 * something (a sentence, a number) is a sentence too; only a short topic label is kept without a marker. Markers that did
 * not verify are taken out of the sentences that stay, a heading left without content goes, and the markers are
 * numbered again in the order they appear. Tables and code blocks are not kept (the writer is told not to write
 * them): each of their content rows counts as removed. The server then adds the source list and "한계" itself.
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

/** A line's list or quote marker and an item's leading bold label (`- **배경:** …`): kept with the line. */
const LINE_PREFIX =
  /^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(?:(?:\*\*|__)[^*_\n]{1,20}?[:：](?:\*\*|__)[ \t]*)?/u;

/**
 * A heading that only names a topic ("증가율", "수출 증가의 배경"): short, no number, no sentence ending. Anything else
 * ("수출이 50% 늘었다") states a fact and needs a verified marker like a sentence.
 */
export function isTopicLabel(t: string): boolean {
  const s = t
    .replace(/\[\d{1,3}\]/g, "")
    .replace(/\*\*|__|[*_`]/g, "")
    .trim();
  return (
    s.length > 0 &&
    Array.from(s).length <= 40 &&
    !/\p{Nd}/u.test(s) &&
    !/[.!?。！？]$/u.test(s) &&
    !/(?:다|요|죠|니다|음|함|됨|임)$/u.test(s)
  );
}

type Block = { text: string; level: number; item: boolean };

/**
 * The sentences of `t` (`sentenceSpans`), with the citation markers a sentence ends with kept on it also after a
 * space: `수출이 늘었다. [1] 수입도 늘었다.` — `[1]` cites the first sentence. Only real markers move (`isMarker`, at
 * their offset in `t`): a link label opening the next sentence (`[2](https://…)에서 …`) stays where it is.
 */
function lineSentences(
  t: string,
  isMarker: (start: number, end: number) => boolean,
): { start: number; end: number }[] {
  const spans = sentenceSpans(t).map((r) => ({ ...r }));
  for (let i = 1; i < spans.length; i++) {
    let k = spans[i]!.start;
    for (;;) {
      const m = /^[ \t]*(\[\d{1,3}\])/.exec(t.slice(k, spans[i]!.end));
      if (!m) break;
      const ms = k + m[0].length - m[1]!.length;
      if (!isMarker(ms, ms + m[1]!.length)) break;
      k += m[0].length;
    }
    if (k === spans[i]!.start) continue;
    spans[i - 1]!.end = k;
    const rest = t.slice(k, spans[i]!.end);
    spans[i]!.start = spans[i]!.end - rest.trimStart().length;
  }
  return spans.filter((r) => t.slice(r.start, r.end).trim());
}

/** A kept marker, held as its old number until the body is final (`\u0000n\u0000`). */
// eslint-disable-next-line no-control-regex -- a NUL can never be in the cleaned text (it is stripped first)
const HELD = /\u0000(\d{1,3})\u0000/g;

export function cleanReport(text: string, cites: ReadonlyMap<number, ReportCitation>): CleanResult {
  // eslint-disable-next-line no-control-regex -- NUL marks the held markers below: never one of the writer's own
  const src = text.replace(/\r\n?/g, "\n").replace(/\u0000/g, "");
  const units = citationUnits(src);
  // Written markers only: inside the parser's plain text — never a link's label or address, an autolink, or code.
  const plain = plainTextRanges(src);
  const markers = citationMarkers(src, units).filter((m) =>
    plain.some((r) => m.start >= r.start && m.end <= r.end),
  );
  const isMarker = (start: number, end: number) => markers.some((m) => m.start === start && m.end === end);
  const ok = (m: CitationMarker) => cites.get(m.n)?.verified === true;
  const within = (start: number, end: number) => markers.filter((m) => m.start >= start && m.end <= end);
  const backed = (start: number, end: number) => within(start, end).some(ok);
  /** The range with its verified markers held (once each) and every other marker taken out. */
  const emit = (start: number, end: number) => {
    let out = "";
    let at = start;
    const seen = new Set<number>();
    for (const m of within(start, end)) {
      out += src.slice(at, m.start);
      at = m.end;
      if (!ok(m) || seen.has(m.n)) continue;
      seen.add(m.n);
      out += `\u0000${m.n}\u0000`;
    }
    out += src.slice(at, end);
    return out
      .replace(/[ \t]+([.!?。,])/gu, "$1")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  };
  let removed = 0;
  /** The sentences of `[from, to)` that a verified marker backs; the others are counted as removed. */
  const keptSentences = (from: number, to: number, labels = false) => {
    const kept: string[] = [];
    const t = src.slice(from, to);
    for (const r of lineSentences(t, (a, b) => isMarker(from + a, from + b))) {
      // A heading's sentence that only names a topic ("증가 원인") stands without a marker; any other needs one.
      const words = t.slice(r.start, r.end);
      if (backed(from + r.start, from + r.end)) kept.push(emit(from + r.start, from + r.end));
      else if (labels && isTopicLabel(words)) kept.push(words.replace(/\[\d{1,3}\]/g, "").trim());
      else removed++;
    }
    return kept;
  };
  const blocks: Block[] = [];
  for (const u of units) {
    if (u.inline || u.kind === "rule") continue;
    const raw = src.slice(u.start, u.end);
    if (u.kind === "code") {
      removed += raw.split("\n").filter((l) => l.trim() && !/^\s*(```|~~~)/.test(l)).length;
      continue;
    }
    if (u.table) {
      const rows = raw.split("\n").filter((l) => l.trim() && !/^\s*\|?[\s:|-]+\|?\s*$/.test(l));
      removed += Math.max(0, rows.length - 1);
      continue;
    }
    if (u.kind === "heading") {
      const h = /^(#{1,6})[ \t]+/.exec(raw);
      const level = h ? h[1]!.length : 7;
      const at = u.start + (h?.[0].length ?? 0);
      // Sentence by sentence (`## 수출이 늘었다. 증가 원인`: the first states a fact, the second names a topic).
      const kept = keptSentences(at, u.end, true);
      if (!kept.length) continue;
      const shown = kept.join(" ");
      // The report's own title is the server's: a level-1 heading of the writer's becomes a section.
      blocks.push({
        text: h ? `${level === 1 ? "##" : h[1]} ${shown}` : shown,
        level: level === 1 ? 2 : level,
        item: false,
      });
      continue;
    }
    // Body, lead-ins, disclaimers, list items, quotes: sentence by sentence, line by line — from the start of the unit's
    // line, so a quote's `>` (before the unit) stays with it.
    const begin = src.lastIndexOf("\n", u.start - 1) + 1;
    const from = /^[ \t>]*$/.test(src.slice(begin, u.start)) ? begin : u.start;
    const lines: string[] = [];
    let lineStart = from;
    for (const line of src.slice(from, u.end).split("\n")) {
      const prefix = LINE_PREFIX.exec(line)![0];
      const kept = keptSentences(lineStart + prefix.length, lineStart + line.length);
      if (kept.length) lines.push(prefix + kept.join(" "));
      lineStart += line.length + 1;
    }
    if (lines.length)
      blocks.push({
        text: lines.join("\n"),
        level: 0,
        item: /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]/.test(lines[0]!),
      });
  }
  // The body is final first (empty sections gone); only then are its markers numbered — no number of a dropped heading.
  const shown = dropEmptySections(blocks);
  const held = shown
    .map((b, i) => (i === 0 ? "" : b.item && shown[i - 1]!.item ? "\n" : "\n\n") + b.text)
    .join("")
    .trim();
  const map = new Map<number, number>();
  const numbering: CleanResult["numbering"] = [];
  const body = held.replace(HELD, (_m, d: string) => {
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

/** Headings with nothing under them (before the next heading of the same or a higher level) go. */
function dropEmptySections(blocks: Block[]): Block[] {
  return blocks.filter((b, i) => {
    if (!b.level) return true;
    for (let j = i + 1; j < blocks.length; j++) {
      const n = blocks[j]!;
      if (n.level && n.level <= b.level) return false;
      if (!n.level) return true;
    }
    return false;
  });
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
