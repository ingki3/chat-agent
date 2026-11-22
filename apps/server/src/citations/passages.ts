import { CITATION_LIMITS } from "@agentlee/shared";
import { KOREAN_PARTICLES, normalizeSnippet, normalizeWithMap, PAGE_GAP, touchesGap } from "./verify.js";

/**
 * Passages of a stored page text (#234): its sentences, and the words they share with a query. Two users:
 * - `web_find` — a researcher looks for a phrase or keywords in the whole text of a page it fetched (the model only
 *   saw the first `EXCERPT_CHARS`);
 * - `closestPassage` — a note whose quote the citation check did not find is matched to the one passage of its page
 *   that differs from it only in spacing next to digits or marks, glyph variants or a `…` between two sentences; that
 *   passage (the page's own text) replaces the quote and is checked again, so the check stays exact (`findSnippet`).
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
    // The mark of a page that was not read is no text of the page.
    if (touchesGap(text, r.start, r.end)) continue;
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

/**
 * Sentence `i` with its neighbours before and after while they fit in `FIND_PASSAGE_CHARS` — never across a PDF page
 * that was not read (`PAGE_GAP`, review #237 2차): a passage is always one stretch of read text.
 */
function withContext(text: string, sentences: Range[], i: number): Range {
  const own = sentences[i]!;
  // A very long sentence alone is cut at a space near the limit (its start is kept: that is where it matched).
  if (own.end - own.start >= FIND_PASSAGE_CHARS) {
    const cut = text.lastIndexOf(" ", own.start + FIND_PASSAGE_CHARS);
    return { start: own.start, end: cut > own.start ? cut : own.start + FIND_PASSAGE_CHARS };
  }
  const gap = (r: Range | undefined) => !r || touchesGap(text, r.start, r.end);
  let start = own.start;
  let end = own.end;
  let back = true;
  let ahead = true;
  for (let k = 1; k <= 2; k++) {
    const before = sentences[i - k];
    if (back && !gap(before) && end - before!.start <= FIND_PASSAGE_CHARS) start = before!.start;
    else back = false;
    const after = sentences[i + k];
    if (ahead && !gap(after) && after!.end - start <= FIND_PASSAGE_CHARS) end = after!.end;
    else ahead = false;
  }
  return { start, end };
}

// ---------------------------------------------------------------------------------------------------------------
// Note repair

export type Closest =
  | { kind: "match"; passage: string }
  | { kind: "none" }
  /** The quote stands in two different places of the page: neither is taken. */
  | { kind: "ambiguous" };

const HANGUL = /^[가-힣]$/u;
const DIGIT = /^\p{Nd}$/u;
/** A space here may be added or left out: between a digit and a Hangul syllable (`10 월` / `10월`, `3 개`). */
const looseSpace = (a: string | undefined, b: string | undefined) =>
  !!a && !!b && ((DIGIT.test(a) && HANGUL.test(b)) || (HANGUL.test(a) && DIGIT.test(b)));

/**
 * The form the repair compares (review #237 3차 — the coordinator's final decision): the citation check's own
 * normalisation (`normalizeWithMap`: NFC, quote marks, dashes, `…`, whitespace runs; case kept), with a space dropped
 * **only between a digit and a Hangul syllable**. Every other space stays where it is: between two digits (`1 2 12`
 * is not `12 1 2`), two letters (`아버지 가방에`), or next to any symbol or punctuation (`x! = y`, `.menu .item`).
 */
function skeleton(text: string): { s: string; from: number[]; to: number[] } {
  const n = normalizeWithMap(text);
  const out: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  for (let i = 0; i < n.norm.length; i++) {
    const c = n.norm[i]!;
    if (c === " " && looseSpace(n.norm[i - 1], n.norm[i + 1])) continue;
    out.push(c);
    from.push(n.from[i]!);
    to.push(n.to[i]!);
  }
  return { s: out.join(""), from, to };
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
 * The numbers of a text with their sign and what scales them, in order: `%`, `%p`, `‰` or a Korean numeral unit
 * (`−5%` → `-5%`, `142억` → `142억`, `500만원` → `500만`, `1,234 명` → `1234`).
 */
export function numberFacts(text: string): string[] {
  return [
    ...text
      .normalize("NFKC")
      .matchAll(/([+\-−–▲△▼▽])?\s?(\p{Nd}+(?:[.,]\p{Nd}+)*)(?:\s?(%p|%|‰|[십백천만억조경]+))?/gu),
  ].map((m) => `${m[1] ? SIGNS[m[1]] : ""}${m[2]!.replace(/,/g, "")}${m[3] ?? ""}`);
}

/**
 * Whether a model's claim may stand on a repaired passage: every number of the claim (value, sign, unit) is one of
 * the passage's, and every symbol of the claim (Unicode `S*` — currency, math, modifier and other symbols: `₹`, `≠`,
 * `$`, `<` …) is in the passage too.
 */
export function claimFitsPassage(claim: string, passage: string): boolean {
  const have = new Set(numberFacts(passage));
  if (numberFacts(claim).some((f) => !have.has(f))) return false;
  const symbols = (t: string) => new Set(t.normalize("NFC").match(/\p{S}/gu) ?? []);
  const p = symbols(passage);
  return [...symbols(claim)].every((c) => p.has(c));
}

/** A sentence's text as the check normalises it, without its sentence-final marks. */
const sentenceForm = (t: string) =>
  normalizeWithMap(t)
    .norm.trim()
    .replace(/[.!?。！？]+$/u, "")
    .trim();

/**
 * The page's own passage for a quote the citation check did not find — **only** in two cases (review #237 3차, the
 * coordinator's final decision; the claim stays the model's, so nothing that carries meaning may differ):
 * - (a) `…` joining consecutive sentences: the quote, split at `…`, is a sentence-final segment of one sentence and
 *   then whole sentences, each exactly as the check normalises it, one right after another in the page. A `…` with
 *   a digit on both sides (`3…5`) is never a join;
 * - (b) a space added or left out between a digit and a Hangul syllable (`skeleton`) — nothing else differs.
 * Any other difference is no match. Not across a PDF page that was not read (`PAGE_GAP`). Two different places:
 * `ambiguous`. The passage is then checked again exactly (`findSnippet`), its token and number edges too.
 */
export function closestPassage(text: string, quote: string): Closest {
  const q = normalizeSnippet(quote);
  if (Array.from(q.replace(/\s/gu, "")).length < CITATION_LIMITS.minSnippet) return { kind: "none" };
  const found = new Set<string>();
  const keep = (start: number, end: number) => {
    if (touchesGap(text, start, end)) return;
    const raw = text.slice(start, end);
    const passage = raw.replace(/\s+/gu, " ").trim();
    if (passage.length <= CITATION_LIMITS.snippet) found.add(passage);
  };
  if (/\.{3,}/u.test(q)) {
    if (/\p{Nd}\s*\.{3,}\s*\p{Nd}/u.test(q)) return { kind: "none" };
    const pieces = q
      .split(/\s*\.{3,}\s*/u)
      .map(sentenceForm)
      .filter(Boolean);
    if (pieces.length < 2) return { kind: "none" };
    const sentences = sentenceRanges(text);
    const forms = sentences.map((r) => sentenceForm(text.slice(r.start, r.end)));
    for (let i = 0; i + pieces.length <= sentences.length; i++) {
      const first = forms[i]!;
      const head = pieces[0]!;
      // The first piece ends its sentence, starting at a word boundary (or is the whole sentence).
      if (!first.endsWith(head)) continue;
      const before = first.slice(0, first.length - head.length);
      if (before && !/\s$/u.test(before)) continue;
      if (!pieces.slice(1).every((p, k) => forms[i + 1 + k] === p)) continue;
      // Where the first piece starts in the page: its sentence's start, past the words before it.
      const r = sentences[i]!;
      const own = normalizeWithMap(text.slice(r.start, r.end));
      const lead = own.norm.length - own.norm.trimStart().length;
      const at = before ? own.from[lead + before.length]! : 0;
      keep(r.start + at, sentences[i + pieces.length - 1]!.end);
    }
  } else {
    const want = skeleton(q).s;
    const page = skeleton(text);
    for (let at = page.s.indexOf(want); at !== -1; at = page.s.indexOf(want, at + 1))
      keep(page.from[at]!, page.to[at + want.length - 1]!);
  }
  if (!found.size) return { kind: "none" };
  if (found.size > 1) return { kind: "ambiguous" };
  return { kind: "match", passage: [...found][0]! };
}

export { PAGE_GAP };
