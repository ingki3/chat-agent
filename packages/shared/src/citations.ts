import { z } from "zod";
import { FINANCE_DISCLAIMER } from "./finance.js";
import { FileLocator } from "./locators.js";

/**
 * Web citations (#25, PRD FR-5.1–5.5, G2, 수용 기준 3·11). The model cites with the `cite` tool (`{ sourceId,
 * snippet }`); the server checks the snippet against the page text it stored (#50) and numbers the citation for
 * the answer (`[n]`). At the end of the run the server appends a `citation_note` part: every `[n]` the answer
 * uses with its status, and the paragraphs that state something without any marker. A runtime cannot write or
 * change that part.
 *
 * This file is the data contract between the server and the chat screen: the statuses, the exact words shown
 * for them, and the paragraph and marker rules both sides apply to the same answer text.
 */

/**
 * - `verified` — the snippet is in the stored page text (after normalising whitespace, quote styles, NFKC, case)
 * - `snippet_not_found` — the page was fetched, the snippet is not in it
 * - `fetch_failed` — the source has no stored page text (a search result, or a page that could not be read)
 * - `unknown_source` — not a source of this conversation (another conversation's, another user's, made up),
 *   or a marker in the answer that no `cite` produced
 */
export const CitationStatus = z.enum(["verified", "snippet_not_found", "fetch_failed", "unknown_source"]);
export type CitationStatus = z.infer<typeof CitationStatus>;

/** What the screen says for each status (issue #25). Only `verified` reads as normal; every other has ⚠️. */
export const CITATION_STATUS_TEXT: Record<CitationStatus, string> = {
  verified: "원문 구절 확인",
  snippet_not_found: "⚠️ 출처에서 이 내용을 찾지 못했어요",
  fetch_failed: "⚠️ 출처를 가져오지 못했어요",
  unknown_source: "⚠️ 출처를 가져오지 못했어요",
};

/**
 * Shown for an `unbacked` note: the answer has `[n]` markers that cite nothing. About the markers only — the same
 * box may list the answer's finance sources (review #190 2차).
 */
export const CITATION_UNBACKED_TEXT = "⚠️ 근거에 연결되지 않은 출처 표시가 있어요.";

/**
 * Shown under an answer with paragraphs that state something without a citation marker (#202): one line with the
 * count — the paragraphs themselves are marked where they are in the answer (never repeated in the note).
 */
export const citationMissingText = (n: number) => `⚠️ 출처 표시 없는 문단 ${n}개`;
/** The mark on each such paragraph in the answer (its label for screen readers and its tooltip). */
export const CITATION_MISSING_MARK = "출처 표시 없음";

/** The only status that may be shown like a normal citation. Anything else (including unknown values) is a failure. */
export const citationVerified = (status: unknown): boolean => status === "verified";

export const CITATION_LIMITS = {
  /** Citations one answer may register. */
  perRun: 50,
  /** Characters of a snippet the model may send (and of the quote kept). */
  snippet: 500,
  /** Normalised characters a snippet needs at least: shorter ones prove nothing. */
  minSnippet: 8,
  /** Paragraph ranges a note marks at most. */
  missing: 100,
  /** Marker positions a note lists at most. */
  markers: 300,
  title: 300,
  site: 120,
  url: 2048,
} as const;

/** At most `n` UTF-16 units (what the schema's `max` counts), never cutting a character in half. */
export function boundText(s: string, n: number): string {
  if (s.length <= n) return s;
  let out = "";
  for (const ch of s) {
    if (out.length + ch.length > n) break;
    out += ch;
  }
  return out;
}

/** One `[n]` of an answer as the server checked it. Titles, sites and quotes are page text: shown as text only. */
export const CitationEntry = z.object({
  n: z.number().int().positive(),
  status: CitationStatus,
  /** Null for `unknown_source` (nothing of another conversation is ever shown). */
  sourceId: z.string().nullable(),
  title: z.string().max(CITATION_LIMITS.title).nullable(),
  site: z.string().max(CITATION_LIMITS.site).nullable(),
  url: z.string().max(CITATION_LIMITS.url).nullable(),
  publishedAt: z.string().nullable(),
  /**
   * `verified`: the passage as it stands in the stored page text. Otherwise the snippet the model sent (what it
   * meant to quote) — or null for `unknown_source`.
   */
  quote: z.string().max(CITATION_LIMITS.snippet).nullable(),
  /**
   * A citation of an uploaded file (#48, `file_cite`): where the passage is. Then `title` is the file name, `site`
   * the place ("12쪽", `locatorLabel`), `url` null and `sourceId` null. Absent for web citations.
   */
  locator: FileLocator.optional(),
  /**
   * A citation of an uploaded file (#186): the file's id, whatever the status but `unknown_source` — what a later
   * answer that writes this number again carries over, checked again against the file's current text (the locator
   * has the id for verified passages only). Absent for web citations and on entries stored before #186.
   */
  fileId: z.string().min(1).max(64).optional(),
  /**
   * The server's citation row this entry stands for (#186 review 2차): an opaque id — what a later answer that writes
   * this number again is checked against (the row keeps the whole passage server-side; `quote` is for display and
   * may be cut). A carried entry names the row it was carried from. Absent on `unknown_source` and on entries stored
   * before (those are found by their answer's run and number, or not carried).
   */
  citationId: z.string().min(1).max(64).optional(),
});
export type CitationEntry = z.infer<typeof CitationEntry>;

/** A range of the answer text (text parts joined with ""), `[start, end)` in UTF-16 code units. */
export const TextRange = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});
export type TextRange = z.infer<typeof TextRange>;

/**
 * Added by the server at the end of an answer that used web or file source tools, cited sources, or carries numbers
 * of the answer before (#25, #150) — decided by those tool calls only, never by the text (#185). `citations`: every
 * marker the answer uses, by number. `missing`: body paragraphs without a marker (empty when every one has one).
 * The numbered part of the answer's source note: the screen shows it in one "출처" box with the `finance_note`, if
 * there is one.
 */
export const CitationNotePart = z.object({
  type: z.literal("citation_note"),
  citations: z.array(CitationEntry).max(CITATION_LIMITS.perRun * 2),
  missing: z.array(TextRange).max(CITATION_LIMITS.missing),
  /**
   * Where the citation markers are in the answer text (each `[n]` the screen turns into a citation). Only these:
   * an `[n]` elsewhere (array indexing, code) stays text.
   */
  markers: z.array(TextRange.extend({ n: z.number().int().positive() })).max(CITATION_LIMITS.markers),
  /**
   * The answer used no source and carried no number (#185, review #190 1차): its sentence-end `[n]` cite nothing.
   * Every citation is `unknown_source`; the screen flags the markers in the text and shows a short notice, never a
   * source box. Not an earlier answer's note for carrying numbers over. Absent on every other note.
   */
  unbacked: z.literal(true).optional(),
});
export type CitationNotePart = z.infer<typeof CitationNotePart>;

/** What the `cite` tool answers (also what `CitationStore.cite` returns). */
export type CiteResult = {
  n: number;
  marker: string;
  status: CitationStatus;
  sourceId: string | null;
};

// ---- the answer text: paragraphs and markers (same rules on the server and in the browser) ------------------

export type CitationUnitKind = "body" | "heading" | "lead_in" | "disclaimer" | "code" | "rule";
export type CitationUnit = TextRange & { kind: CitationUnitKind };

const LIST_ITEM = /^\s{0,3}(?:[-*+•·]|\d{1,3}[.)])\s+\S/;
const HEADING = /^\s{0,3}#{1,6}\s+\S/;
/** A line that is only bold text (a heading written as `**제목**`). */
const BOLD_LINE = /^\s*(\*\*|__)[^\n]{1,80}?\1\s*[:：]?\s*$/;
const FENCE = /^\s{0,3}(```|~~~)/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const TABLE = /^\s*\|/;
/** A GFM delimiter row (`|---|:--:|`, `--- | ---`): a table even when its rows have no leading `|`. */
const DELIMITER_ROW = /^(?=[^\n]*\|)(?=[^\n]*-{3})[ \t|:-]+$/;
const LEAD_IN = /[:：]\s*$/;

const SENTENCES = /(?<=[.!?。！？])\s+/u;
/**
 * The pure notices a disclaimer may be made of — a small closed set, each a whole sentence (only its ending may
 * vary). Anything else, however it starts, is something stated and is checked (review #97 round 2: no prefixes).
 */
const NOTICES: readonly RegExp[] = [
  /^(?:출처|자료|근거)(?:가|는)\s*(?:충분하지\s*않아요|충분하지\s*않습니다|충분하지\s*않다|부족해요|부족합니다|부족하다)$/u,
  /^(?:공식\s*발표를|원문을)\s*확인해\s*(?:보세요|주세요)$/u,
  /^(?:최신\s*정보는|자세한\s*내용은)\s*원문을\s*확인해\s*(?:보세요|주세요)$/u,
  /^(?:이\s*답변은\s*)?공개\s*(?:보도|자료)를\s*바탕으로\s*(?:했어요|했습니다|했다|작성했어요|작성했습니다)$/u,
  /^(?:이\s*답변은\s*)?참고용(?:이에요|입니다|이다)$/u,
  /^(?:이\s*답변은\s*)?정확하지\s*않을\s*수\s*(?:있어요|있습니다|있다)$/u,
];
const isNotice = (sentence: string) => {
  const s = sentence
    .replace(/^[※\s]+/u, "")
    .replace(/[.!。\s]+$/u, "")
    .replace(/\s+/gu, " ");
  return NOTICES.some((re) => re.test(s));
};

/**
 * A pure disclaimer: the finance disclaimer and the notices above, nothing else — every sentence must be one of
 * them, whole. `※ 반도체 수출은 32% 증가했다.`, `출처가 부족하지만 양산은 확정됐다.`, `출처가 부족합니다만 …` and
 * `※ 최신 정보는 양산이 확정됐다는 소식입니다.` are claims.
 */
function isDisclaimer(t: string): boolean {
  if (t.length > 240) return false;
  const rest = t
    .split(FINANCE_DISCLAIMER)
    .join(" ")
    .replace(/^[\s※*]+|[\s*]+$/gu, "");
  if (!rest) return true;
  return rest.split(SENTENCES).filter(Boolean).every(isNotice);
}

/**
 * The answer split into units the missing-citation check looks at: paragraphs (blank-line separated), list items
 * and tables are `body` — unless a paragraph is a short line ending with a colon right before a list or table
 * (`lead_in`) or a disclaimer. Headings (`#`, a bold-only line), rules and fenced code are never body.
 */
export function citationUnits(text: string): CitationUnit[] {
  const out: CitationUnit[] = [];
  type Block = { start: number; end: number; type: "para" | "item" | "table" };
  // `gfm`: the current table is a GFM table (a header row, then a delimiter row): every following non-blank line
  // that starts no other block is one of its rows, with or without a leading `|` (#202, review 1차).
  const st: { cur: Block | null; fence: number | null; gfm: boolean } = {
    cur: null,
    fence: null,
    gfm: false,
  };
  const flush = () => {
    const c = st.cur;
    if (c) out.push({ start: c.start, end: c.end, kind: c.type === "para" ? "lead_in" : "body" });
    st.cur = null;
  };
  let pos = 0;
  for (;;) {
    const nl = text.indexOf("\n", pos);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(pos, end);
    const c = st.cur;
    const nextEnd = nl === -1 ? -1 : text.indexOf("\n", nl + 1);
    const nextLine = nl === -1 ? "" : text.slice(nl + 1, nextEnd === -1 ? text.length : nextEnd);
    if (st.gfm && c?.type === "table") {
      if (
        line.trim() &&
        !FENCE.test(line) &&
        !HEADING.test(line) &&
        !LIST_ITEM.test(line) &&
        !RULE.test(line) &&
        !/^\s{0,3}>/.test(line)
      ) {
        c.end = end;
        if (nl === -1) break;
        pos = nl + 1;
        continue;
      }
      st.gfm = false;
    }
    if (st.fence !== null) {
      if (FENCE.test(line)) {
        out.push({ start: st.fence, end, kind: "code" });
        st.fence = null;
      }
    } else if (FENCE.test(line)) {
      flush();
      st.fence = pos;
    } else if (!line.trim()) flush();
    else if (HEADING.test(line) || BOLD_LINE.test(line)) {
      flush();
      out.push({ start: pos, end, kind: "heading" });
    } else if (RULE.test(line)) {
      flush();
      out.push({ start: pos, end, kind: "rule" });
    } else if (line.includes("|") && DELIMITER_ROW.test(nextLine)) {
      // A GFM table's header row: the table is one unit from here (rows without an outer `|` too).
      flush();
      st.cur = { start: pos, end, type: "table" };
      st.gfm = true;
    } else if (TABLE.test(line)) {
      if (c?.type === "table") c.end = end;
      else {
        flush();
        st.cur = { start: pos, end, type: "table" };
      }
    } else if (LIST_ITEM.test(line)) {
      flush();
      st.cur = { start: pos, end, type: "item" };
    } else if (c && (c.type === "para" || (c.type === "item" && /^\s/.test(line)))) c.end = end;
    else {
      flush();
      st.cur = { start: pos, end, type: "para" };
    }
    if (nl === -1) break;
    pos = nl + 1;
  }
  flush();
  if (st.fence !== null) out.push({ start: st.fence, end: text.length, kind: "code" });
  // `flush` marked every paragraph `lead_in` provisionally: decide now that the next unit is known.
  return out.map((u, i) => {
    if (u.kind !== "lead_in") {
      const t = text.slice(u.start, u.end).trim();
      return u.kind === "body" && isDisclaimer(t) ? { ...u, kind: "disclaimer" } : u;
    }
    const t = text.slice(u.start, u.end).trim();
    if (isDisclaimer(t)) return { ...u, kind: "disclaimer" };
    const next = out[i + 1];
    const beforeList =
      next?.kind === "body" &&
      (LIST_ITEM.test(text.slice(next.start, next.end)) || isTableText(text.slice(next.start, next.end)));
    const lead = LEAD_IN.test(t) && !t.includes("\n") && t.length <= 120 && beforeList;
    return { ...u, kind: lead ? "lead_in" : "body" };
  });
}

export type CitationMarker = TextRange & { n: number };

/** `[n]` markers of the answer, outside fenced code. Not `[n](link)` (a markdown link) and not `[^n]`. */
export function citationMarkers(
  text: string,
  units: readonly CitationUnit[] = citationUnits(text),
): CitationMarker[] {
  const code = units.filter((u) => u.kind === "code");
  // Inline code spans (`a[1]`) on one line.
  for (const m of text.matchAll(/`[^`\n]+`/g))
    code.push({ start: m.index, end: m.index + m[0].length, kind: "code" });
  const out: CitationMarker[] = [];
  for (const m of text.matchAll(/\[(\d{1,3})\](?!\()/g)) {
    const start = m.index;
    if (code.some((c) => start >= c.start && start < c.end)) continue;
    const n = Number(m[1]);
    if (n >= 1) out.push({ n, start, end: start + m[0].length });
  }
  return out;
}

const END = /[.!?。！？]/u;

/**
 * Whether a marker at `start` is array indexing: right after `]` (`m[0][1]`), or right after an identifier that is
 * itself directly preceded by `[` or `]`, or by `=` (also `+=`, `==`) or `(` with spaces allowed — `x = a[1]`,
 * `f(a[1]`. Nothing else counts (review #97 rounds 4–5): `Windows, Linux[1]`, `GPT-4o[1]`, `S&P500[1]`,
 * `Node.js[1]`, `Python 3.12[1]`, `example.com[1]` are citation markers — and so is `obj.items[1]` at a prose line
 * end (a rare over-warning). Code blocks and inline code are never markers anyway.
 */
function inExpression(text: string, start: number): boolean {
  const prev = text[start - 1] ?? "";
  if (prev === "]") return true; // m[0][1]
  if (!/[A-Za-z0-9_]/.test(prev)) return false;
  let k = start - 1;
  while (k >= 0 && /[A-Za-z0-9_]/.test(text[k]!)) k--;
  if (k >= 0 && /[[\]]/.test(text[k]!)) return true;
  while (k >= 0 && (text[k] === " " || text[k] === "\t")) k--;
  return k >= 0 && /[=(]/.test(text[k]!);
}
/**
 * Markers that stand where a citation stands — at the end of a sentence: right before sentence punctuation (not
 * `a[1].length`), right after it (`늘었다.[1]`), or at the end of a line (trailing spaces allowed) unless it is
 * array indexing in an expression (`늘었다[1]`, `this year[1]`; not `x = a[1]`). Chained markers (`[1][2]`) count together. For answers that used no web tool:
 * a marker there pretends to cite, so it is checked; `a[1]` in prose is not.
 */
export function sentenceEndMarkers(text: string): CitationMarker[] {
  const all = citationMarkers(text);
  const out: CitationMarker[] = [];
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]!.start === all[j]!.end) j++;
    const before = text[all[i]!.start - 1] ?? "";
    const after = text[all[j]!.end] ?? "";
    const afterNext = text[all[j]!.end + 1] ?? "";
    // The line end may come after trailing spaces.
    const lineRest = /^[ \t]*(\r?\n|$)/.exec(text.slice(all[j]!.end, all[j]!.end + 200));
    const atEnd =
      (END.test(after) && !/[A-Za-z0-9_(]/.test(afterNext)) ||
      /[.!?。！？"”)]/u.test(before) ||
      (lineRest !== null && before !== "" && !inExpression(text, all[i]!.start));
    if (atEnd) out.push(...all.slice(i, j + 1));
    i = j + 1;
  }
  return out;
}

/** A table unit (#202): its first line starts with `|`, or its second line is a delimiter row. */
export function isTableText(unit: string): boolean {
  const lines = unit.replace(/^\s*\n/, "").split("\n");
  return TABLE.test(lines[0] ?? "") || DELIMITER_ROW.test(lines[1] ?? "");
}

/**
 * A line right after a table that says where it is from: `출처: …`, `(자료: …)`, `※ …`, `표 1. …`, `표 1 전형별 인원`.
 */
const CAPTION = /^[\s*_(（[]*(?:(?:출처|자료|근거|source|표)\s*[:：.)\]]|표\s*\d+(?=[\s:：.)\]]))|^\s*※/iu;

/**
 * Opinion framing (#202, `common@11`): a sentence that says itself it is the assistant's own judgement — it starts
 * with "제 판단으로는", "제 생각에는", "제 의견으로는", "제 추정으로는", "개인적으로는" … or ends with "…제 추정이에요",
 * "…제 판단입니다" …. Only these explicit words: a sentence is never taken for an opinion from what it says.
 */
const OPINION_WORD = "(?:제|저의|내)\\s*(?:판단|생각|의견|추정|추측|견해|소견)";
const OPINION_LEAD = new RegExp(
  `^(?:${OPINION_WORD}(?:으로는|으론|에는|엔|에|으로|은|는|이지만|이긴\\s*하지만)?|개인적으로(?:는)?)(?:[,\\s]|$)`,
  "u",
);
const OPINION_TAIL = new RegExp(
  `${OPINION_WORD}(?:이에요|이예요|예요|입니다|이다|일\\s*뿐이에요|일\\s*뿐입니다|일\\s*뿐이다)$`,
  "u",
);

const LIST_MARKER = /^\s*(?:[-*+•·]|\d{1,3}[.)])\s+/u;
/** A list item's leading label: bold text ending in a colon (`**추천:**`, `**추천**:`) — only that, never a sentence. */
const ITEM_LABEL = /^(\*\*|__)[^*_\n]{1,20}?[:：]\1\s*|^(\*\*|__)[^*_\n]{1,20}?\2\s*[:：]\s*/u;

/**
 * The sentences of a unit (#202): line by line — a list item's marker and its leading label (`- **추천:** …`) are
 * not part of it — then at sentence punctuation, with or without a space after it (`마감됐어요.더 볼까요?` is two
 * sentences; `2.0`, `12.3` are not cut). Emphasis marks are dropped, the words kept.
 */
export function unitSentences(t: string): string[] {
  return t
    .split(/\n+/u)
    .flatMap((raw) => {
      const item = LIST_MARKER.exec(raw);
      const line = item ? raw.slice(item[0].length).replace(ITEM_LABEL, "") : raw;
      return line.split(/(?<=[.!?。！？])(?![\d.!?。！？])\s*/u);
    })
    .map((s) =>
      s
        .replace(/\*\*|__/gu, "")
        .replace(/^[\s>]+/u, "")
        .trim(),
    )
    .filter(Boolean);
}

const sentenceBody = (s: string) => s.replace(/[\s.!?。！？…~]+$/gu, "");

/**
 * A paragraph of the assistant's own opinion, said so (#202): **every** sentence carries the explicit framing above.
 * One sentence without it (a fact next to the opinion) and the paragraph is checked like any other.
 */
export function isFramedOpinion(unit: string): boolean {
  const sentences = unitSentences(unit).map(sentenceBody);
  // An empty piece (a lone mark) is not framed either: every piece must say it is an opinion.
  return sentences.length > 0 && sentences.every((s) => OPINION_LEAD.test(s) || OPINION_TAIL.test(s));
}

/** The last sentence of a unit, as a range of the answer text. */
function lastSentence(text: string, u: TextRange): TextRange {
  const t = text.slice(u.start, u.end).replace(/\s+$/u, "");
  let at = 0;
  // A sentence ends at its punctuation (and the markers right after it), with or without a space (#202).
  for (const m of t.matchAll(/[.!?。！？]+(?:\[\d{1,3}\])*(?!\d)\s*|\n+/gu))
    if (m.index + m[0].length < t.length) at = m.index + m[0].length;
  return { start: u.start + at, end: u.start + t.length };
}

/**
 * Body units that contain no marker: what the note marks as missing a citation. Not flagged (#202):
 * - a table — one unit — with a marker in it, in its caption (a short `출처: …` line right after it) or in the
 *   sentence right before it (the lead-in, a heading, the last sentence of the paragraph before);
 * - a paragraph of the assistant's opinion that says so in every sentence (`isFramedOpinion`).
 */
export function uncitedUnits(text: string): TextRange[] {
  const units = citationUnits(text);
  const markers = citationMarkers(text, units);
  const cited = (r: TextRange) => markers.some((m) => m.start >= r.start && m.end <= r.end);
  const tableCited = (i: number) => {
    const prev = units[i - 1];
    // The sentence before: not another table's last cell (two tables in a row are two tables).
    if (
      prev &&
      prev.kind !== "code" &&
      prev.kind !== "rule" &&
      !isTableText(text.slice(prev.start, prev.end)) &&
      cited(lastSentence(text, prev))
    )
      return true;
    const next = units[i + 1];
    if (!next || next.kind === "code" || next.kind === "rule") return false;
    const t = text.slice(next.start, next.end).trim();
    return !t.includes("\n") && t.length <= 160 && CAPTION.test(t) && cited(next);
  };
  return units
    .filter((u, i) => {
      if (u.kind !== "body" || cited(u)) return false;
      const t = text.slice(u.start, u.end);
      if (isTableText(t)) return !tableCited(i);
      return !isFramedOpinion(t);
    })
    .map(({ start, end }) => ({ start, end }));
}
