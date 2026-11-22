import { CITATION_LIMITS } from "@agentlee/shared";
import { KOREAN_PARTICLES } from "./verify.js";

/**
 * Passages of a stored page text (#234): its sentences, and the words they share with a query. Two users:
 * - `web_find` — a researcher looks for a phrase or keywords in the whole text of a page it fetched (the model only
 *   saw the first `EXCERPT_CHARS`);
 * - `closestPassage` — a note whose quote the citation check did not find is matched to the one passage of its page
 *   that says the same words; that passage (the page's own text) replaces the quote and is checked again, so the
 *   check stays exact (`findSnippet`).
 * Both are deterministic: no model, no fuzzy scores other than shared words.
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

/** The numbers of a text (`32`, `142`, `3.5`, `1,234` → `1234`): a passage that replaces a quote keeps them all. */
export function numbersOf(text: string): Set<string> {
  return new Set(
    [...text.normalize("NFKC").matchAll(/\p{Nd}+(?:[.,]\p{Nd}+)*/gu)].map((m) => m[0].replace(/,/g, "")),
  );
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
  | { kind: "match"; passage: string; recall: number }
  | { kind: "none" }
  /** Two different passages match about as well: neither is taken. */
  | { kind: "ambiguous" };

/** The share of a quote's words a passage must contain, and the fewest words a quote needs to be repaired at all. */
export const REPAIR = { minRecall: 0.75, minTerms: 4, maxSentences: 3, ambiguityMargin: 0.05 } as const;

/**
 * The passage of `text` closest to a quote the citation check did not find: windows of one to three consecutive
 * sentences (at most `CITATION_LIMITS.snippet` characters) scored by the quote's words they contain (recall) and how
 * few other words they add (precision), recall weighted (F₃). Taken only when it is confident:
 * - at least `minRecall` of the quote's words (`minTerms` or more) are in it;
 * - every number of the quote is in it (a passage with other figures never stands in for the quote);
 * - no other, non-overlapping passage with different words scores within `ambiguityMargin` of it.
 */
export function closestPassage(text: string, quote: string): Closest {
  const q = new Set(termsOf(quote));
  if (q.size < REPAIR.minTerms) return { kind: "none" };
  const nums = numbersOf(quote);
  const sentences = sentenceRanges(text);
  const terms = sentences.map((r) => termsOf(text.slice(r.start, r.end)));
  type Cand = Range & { f: number; recall: number; key: string };
  const cands: Cand[] = [];
  for (let i = 0; i < sentences.length; i++) {
    // Only windows that start with a sentence sharing a word with the quote (the rest cannot be the closest).
    if (!terms[i]!.some((t) => q.has(t))) continue;
    for (let n = 1; n <= REPAIR.maxSentences && i + n <= sentences.length; n++) {
      const r = { start: sentences[i]!.start, end: sentences[i + n - 1]!.end };
      const passage = passageText(text, r);
      if (passage.length > CITATION_LIMITS.snippet) break;
      const words = terms.slice(i, i + n).flat();
      const set = new Set(words);
      let shared = 0;
      for (const t of q) if (set.has(t)) shared++;
      const recall = shared / q.size;
      if (recall < REPAIR.minRecall) continue;
      const have = numbersOf(passage);
      if ([...nums].some((x) => !have.has(x))) continue;
      const precision = shared / Math.max(set.size, 1);
      const f = (10 * precision * recall) / (9 * precision + recall);
      cands.push({ ...r, f, recall, key: [...set].sort().join(" ") });
    }
  }
  if (!cands.length) return { kind: "none" };
  cands.sort((a, b) => b.f - a.f || a.end - a.start - (b.end - b.start) || a.start - b.start);
  const best = cands[0]!;
  const rival = cands.find(
    (c) =>
      !(c.start < best.end && best.start < c.end) &&
      c.key !== best.key &&
      c.f >= best.f - REPAIR.ambiguityMargin,
  );
  if (rival) return { kind: "ambiguous" };
  return { kind: "match", passage: passageText(text, best), recall: best.recall };
}
