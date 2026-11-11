import { z } from "zod";
import { FINANCE_DISCLAIMER } from "./finance.js";

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

/** Shown above an answer with paragraphs that state something without a citation marker. */
export const CITATION_MISSING_TEXT = "⚠️ 일부 내용에 출처 표시 없음";

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
});
export type CitationEntry = z.infer<typeof CitationEntry>;

/** A range of the answer text (text parts joined with ""), `[start, end)` in UTF-16 code units. */
export const TextRange = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});
export type TextRange = z.infer<typeof TextRange>;

/**
 * Added by the server at the end of an answer that used web tools or cited sources (#25). `citations`: every
 * marker the answer uses, by number. `missing`: body paragraphs without a marker (empty when every one has one).
 */
export const CitationNotePart = z.object({
  type: z.literal("citation_note"),
  citations: z.array(CitationEntry).max(CITATION_LIMITS.perRun * 2),
  missing: z.array(TextRange).max(CITATION_LIMITS.missing),
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
const LEAD_IN = /[:：]\s*$/;

/**
 * Words that say something about the answer, not about the world: the finance disclaimer, a `※` note, and the
 * research-mode statement that the sources are not enough. Short ones only — a long paragraph that starts like
 * this still states things.
 */
function isDisclaimer(t: string): boolean {
  if (t.includes(FINANCE_DISCLAIMER) || /투자\s*권유가\s*아닙니다/.test(t)) return t.length <= 240;
  if (/^※/.test(t)) return t.length <= 240;
  if (/^(?:⚠️\s*)?(?:출처|자료|근거)(?:가|는|이)?\s*(?:충분하지\s*않|부족)/.test(t)) return t.length <= 100;
  return false;
}

/**
 * The answer split into units the missing-citation check looks at: paragraphs (blank-line separated), list items
 * and tables are `body` — unless a paragraph is a short line ending with a colon right before a list or table
 * (`lead_in`) or a disclaimer. Headings (`#`, a bold-only line), rules and fenced code are never body.
 */
export function citationUnits(text: string): CitationUnit[] {
  const out: CitationUnit[] = [];
  type Block = { start: number; end: number; type: "para" | "item" | "table" };
  const st: { cur: Block | null; fence: number | null } = { cur: null, fence: null };
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
      (LIST_ITEM.test(text.slice(next.start, next.end)) || TABLE.test(text.slice(next.start, next.end)));
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
  const out: CitationMarker[] = [];
  for (const m of text.matchAll(/\[(\d{1,3})\](?!\()/g)) {
    const start = m.index;
    if (code.some((c) => start >= c.start && start < c.end)) continue;
    const n = Number(m[1]);
    if (n >= 1) out.push({ n, start, end: start + m[0].length });
  }
  return out;
}

/** Body units that contain no marker: what the note marks as missing a citation. */
export function uncitedUnits(text: string): TextRange[] {
  const units = citationUnits(text);
  const markers = citationMarkers(text, units);
  return units
    .filter((u) => u.kind === "body" && !markers.some((m) => m.start >= u.start && m.end <= u.end))
    .map(({ start, end }) => ({ start, end }));
}
