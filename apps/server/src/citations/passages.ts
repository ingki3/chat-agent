import { CITATION_LIMITS } from "@agentlee/shared";
import { KOREAN_PARTICLES } from "./verify.js";

/**
 * Passages of a stored page text (#234): its sentences, and the words they share with a query. Two users:
 * - `web_find` — a researcher looks for a phrase or keywords in the whole text of a page it fetched (the model only
 *   saw the first `EXCERPT_CHARS`);
 * - `closestPassage` — a note whose quote the citation check did not find is matched to the one passage of its page
 *   with the very same words, numbers and order (only form may differ); that passage (the page's own text) replaces
 *   the quote and is checked again, so the check stays exact (`findSnippet`).
 * Both are deterministic: no model, no similarity scores.
 */

export type Range = { start: number; end: number };

/** Characters of one sentence at most before it is split again at clause punctuation (then at spaces). */
const SENTENCE_MAX = 400;

/**
 * The sentences of a text as `[start, end)` ranges, whitespace trimmed: split at line breaks and after `. ! ? 。` and
 * their fullwidth forms followed by a space — not inside a number or a date (`3.5`, `2026. 11. 12.` keeps its parts
 * together when a digit follows). A sentence longer than `SENTENCE_MAX` is split again after `, ; :` and then at a
 * space, so every piece can be quoted whole.
 */
export function sentenceRanges(text: string): Range[] {
  const out: Range[] = [];
  const push = (s: number, e: number) => {
    while (s < e && /\s/u.test(text[s]!)) s++;
    while (e > s && /\s/u.test(text[e - 1]!)) e--;
    if (e > s) splitLong(text, s, e, out);
  };
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\n" || c === "\r") {
      push(start, i);
      start = i + 1;
      continue;
    }
    if (!/[.!?。！？]/u.test(c)) continue;
    const next = text[i + 1];
    if (next === undefined || !/\s/u.test(next)) continue;
    // `2026. 11.`, `제 3. 2항`: a digit before and (after spaces) a digit after is one unit.
    let k = i + 1;
    while (k < text.length && (text[k] === " " || text[k] === "\t")) k++;
    if (/\p{N}/u.test(text[i - 1] ?? "") && /\p{N}/u.test(text[k] ?? "")) continue;
    push(start, i + 1);
    start = i + 1;
  }
  push(start, text.length);
  return out;
}

function splitLong(text: string, s: number, e: number, out: Range[]): void {
  if (e - s <= SENTENCE_MAX) {
    out.push({ start: s, end: e });
    return;
  }
  // The last clause mark (followed by a space) in the first SENTENCE_MAX characters, else the last space there.
  const piece = text.slice(s, s + SENTENCE_MAX);
  let cut = -1;
  for (const m of piece.matchAll(/[,;:，；：](?=\s)/gu)) cut = m.index + 1;
  if (cut < SENTENCE_MAX / 4) cut = piece.lastIndexOf(" ");
  if (cut < SENTENCE_MAX / 4) cut = SENTENCE_MAX;
  let a = s + cut;
  out.push({ start: s, end: trimEnd(text, s, a) });
  while (a < e && /\s/u.test(text[a]!)) a++;
  if (a < e) splitLong(text, a, e, out);
}

const trimEnd = (text: string, s: number, e: number) => {
  while (e > s && /\s/u.test(text[e - 1]!)) e--;
  return e;
};

/** Particles longest first (a word keeps at least two characters before one). */
const PARTICLES = [...KOREAN_PARTICLES].sort((a, b) => b.length - a.length);
const HANGUL_END = /[가-힣]$/u;

/** A word without the Korean particle it ends with (`수출이` → `수출`), lower case. */
export function stemOf(word: string): string {
  const w = word.toLowerCase();
  if (!HANGUL_END.test(w)) return w;
  for (const p of PARTICLES)
    if (w.endsWith(p) && Array.from(w).length - Array.from(p).length >= 2) return w.slice(0, -p.length);
  return w;
}

/** The words of a text (letters and digits, NFC), stemmed. */
export function termsOf(text: string): string[] {
  return [...text.normalize("NFC").matchAll(/[\p{L}\p{N}\p{M}]+/gu)].map((m) => stemOf(m[0]));
}

/** Lower case, NFC, whitespace runs as one space — for finding a phrase. */
const flat = (s: string) => s.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
/** A passage as it is shown and quoted: the page's characters, whitespace runs as one space. */
export const passageText = (text: string, r: Range) =>
  text.slice(r.start, r.end).replace(/\s+/gu, " ").trim();

// ---------------------------------------------------------------------------------------------------------------
// web_find

export type FoundPassage = Range & { text: string; phrase: boolean; score: number };

/** Characters of one returned passage at most (the matching sentence and what fits of its neighbours). */
export const FIND_PASSAGE_CHARS = 700;

/**
 * The passages of `text` that best match `query`: a sentence that holds the whole phrase first (ignoring case and
 * spacing), then sentences with the most of its words (at least half of them; a word also counts inside a longer one,
 * `시행` in `시행계획`). Each comes with the sentences around it, at most `FIND_PASSAGE_CHARS`. Passages do not
 * overlap; best first, then in page order.
 */
export function findPassages(
  text: string,
  query: string,
  max: number,
): { total: number; passages: FoundPassage[] } {
  const want = flat(query);
  const terms = [...new Set(termsOf(query))].filter((t) => t.length > 0);
  if (!want || !terms.length) return { total: 0, passages: [] };
  const need = Math.max(1, Math.ceil(terms.length / 2));
  const sentences = sentenceRanges(text);
  const hits: { i: number; score: number; phrase: boolean }[] = [];
  for (const [i, r] of sentences.entries()) {
    const s = flat(text.slice(r.start, r.end));
    const phrase = s.includes(want);
    const words = new Set(termsOf(s));
    let n = 0;
    for (const t of terms) if (words.has(t) || (Array.from(t).length >= 2 && s.includes(t))) n++;
    if (phrase || n >= need) hits.push({ i, score: (phrase ? terms.length + 1 : 0) + n, phrase });
  }
  hits.sort((a, b) => b.score - a.score || a.i - b.i);
  const taken: FoundPassage[] = [];
  for (const h of hits) {
    if (taken.length >= max) break;
    const r = withContext(text, sentences, h.i);
    if (taken.some((t) => t.start < r.end && r.start < t.end)) continue;
    taken.push({ ...r, text: passageText(text, r), phrase: h.phrase, score: h.score });
  }
  return { total: hits.length, passages: taken };
}

/** Sentence `i` with its neighbours before and after while they fit in `FIND_PASSAGE_CHARS`. */
function withContext(text: string, sentences: Range[], i: number): Range {
  const own = sentences[i]!;
  // A very long sentence alone is cut at a space near the limit (its start is kept: that is where it matched).
  if (own.end - own.start >= FIND_PASSAGE_CHARS) {
    const cut = text.lastIndexOf(" ", own.start + FIND_PASSAGE_CHARS);
    return { start: own.start, end: cut > own.start ? cut : own.start + FIND_PASSAGE_CHARS };
  }
  let start = own.start;
  let end = own.end;
  for (let k = 1; k <= 2; k++) {
    const before = sentences[i - k];
    if (before && end - before.start <= FIND_PASSAGE_CHARS) start = before.start;
    const after = sentences[i + k];
    if (after && after.end - start <= FIND_PASSAGE_CHARS) end = after.end;
  }
  return { start, end };
}

// ---------------------------------------------------------------------------------------------------------------
// Note repair

export type Closest =
  | { kind: "match"; passage: string }
  | { kind: "none" }
  /** The quote's words stand in two different passages of the page: neither is taken. */
  | { kind: "ambiguous" };

/** The fewest words a quote needs to be repaired at all; the longest passage it may become. */
export const REPAIR = { minTerms: 4 } as const;

/**
 * The only particles a repair forgives (subject, topic, object — `수출이` / `수출은` / `수출을`). Particles that carry
 * meaning (`보다`, `까지`, `부터`, `에서`, `도`, `만` …) and every verb ending must be the page's exactly: `서울보다
 * 부산이` is not `서울이 부산보다`, `지급한다` is not `지급하지 않는다` (review #237 1차).
 */
const LOOSE_PARTICLES = ["은", "는", "이", "가", "을", "를"];

/** A word with a forgiven particle taken off (two characters stay at least), lower case, NFC. */
function repairStem(word: string): string {
  const w = word.normalize("NFC").toLowerCase();
  for (const p of LOOSE_PARTICLES)
    if (w.endsWith(p) && Array.from(w).length - 1 >= 2 && HANGUL_END.test(w)) return w.slice(0, -1);
  return w;
}

type Tok = { stem: string; start: number; end: number };
function repairTokens(text: string): Tok[] {
  return [...text.matchAll(/[\p{L}\p{N}\p{M}]+/gu)].map((m) => ({
    stem: repairStem(m[0]),
    start: m.index,
    end: m.index + m[0].length,
  }));
}

const SIGNS: Record<string, string> = {
  "+": "+",
  "▲": "+",
  "△": "+",
  "-": "-",
  "−": "-",
  "–": "-",
  "▼": "-",
  "▽": "-",
};
/**
 * The numbers of a text with their sign and the word or mark right after them, in order (`−5%` → `-5%`, `142억` →
 * `142억`, `1,234 명` → `1234명`, `10 월` → `10월`):
 * a repaired passage must have the very same list — value, sign, unit and the order that pairs them.
 */
export function numberFacts(text: string): string[] {
  return [
    ...text
      .normalize("NFKC")
      .matchAll(/([+\-−–▲△▼▽])?\s?(\p{Nd}+(?:[.,]\p{Nd}+)*)(?:\s?(%p|%|‰|[\p{L}]+))?/gu),
  ].map((m) => `${m[1] ? SIGNS[m[1]] : ""}${m[2]!.replace(/,/g, "")}${m[3] ?? ""}`);
}

/**
 * The page's own passage for a quote the citation check did not find — **only when the two differ in form, never
 * in meaning** (review #237 1차). The quote's words must stand in the page in the same order, one after another,
 * nothing added or left out in between: only whitespace, punctuation, quote marks, an ellipsis where the model
 * joined two consecutive sentences, spacing inside a word (`10 월` / `10월`) and the subject, topic and object
 * particles may differ (`LOOSE_PARTICLES`). Every number keeps its value, sign and unit (`numberFacts` — the
 * passage reaches the sign just before it and the unit right after it). Not across a page the extractor could not
 * read (`PAGE_GAP`, a PDF). Two different passages with these words: `ambiguous`. The passage is then checked again
 * exactly, like any quote (`findSnippet`) — its numeric edges and token boundaries too.
 */
export function closestPassage(text: string, quote: string): Closest {
  const q = repairTokens(quote);
  if (q.length < REPAIR.minTerms) return { kind: "none" };
  const want = q.map((t) => t.stem).join("");
  const facts = numberFacts(quote).join(" ");
  const page = repairTokens(text);
  // The page's words as one string, and where each word starts in it.
  const starts = new Map<number, number>();
  const ends = new Map<number, number>();
  let joined = "";
  for (const [i, t] of page.entries()) {
    starts.set(joined.length, i);
    joined += t.stem;
    ends.set(joined.length, i);
  }
  const found = new Set<string>();
  for (let at = joined.indexOf(want); at !== -1; at = joined.indexOf(want, at + 1)) {
    const a = starts.get(at);
    const b = ends.get(at + want.length);
    if (a === undefined || b === undefined) continue;
    let start = page[a]!.start;
    let end = page[b]!.end;
    // The sign right before the first number and the unit marks right after the last belong to the passage.
    const sign = /[+\-−–▲△▼▽]\s?$/u.exec(text.slice(Math.max(0, start - 2), start));
    if (sign) start -= sign[0].length;
    const unit = /^(?:%p|%|‰)/u.exec(text.slice(end, end + 2));
    if (unit) end += unit[0].length;
    const raw = text.slice(start, end);
    if (raw.includes(PAGE_GAP)) continue;
    const passage = raw.replace(/\s+/gu, " ").trim();
    if (passage.length > CITATION_LIMITS.snippet) continue;
    if (numberFacts(passage).join(" ") !== facts) continue;
    found.add(passage);
  }
  if (!found.size) return { kind: "none" };
  if (found.size > 1) return { kind: "ambiguous" };
  return { kind: "match", passage: [...found][0]! };
}

/**
 * Where a PDF page the extractor could not read (a scan, without OCR) stood in its text (#234, `web/pdf.ts`): its own
 * line, so no passage — a citation, `web_find`, a repair — runs across it.
 */
export const PAGE_GAP = "[읽지 못한 쪽]";
