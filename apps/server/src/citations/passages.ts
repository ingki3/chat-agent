import { GAP_MARK, KOREAN_PARTICLES, PAGE_GAP, touchesGap } from "./verify.js";

/**
 * Passages of a stored page text (#234): its sentences, and the words they share with a query — for `web_find`, where
 * a researcher looks for a phrase or keywords in the whole text of a page it fetched (the model only saw the first
 * `EXCERPT_CHARS`). Deterministic: no model, no similarity scores. (A note's quote is never rewritten to a passage:
 * review #237 4차 — any rewrite could change what the claim rests on.)
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
  text.slice(r.start, r.end).replaceAll(GAP_MARK, "").replace(/\s+/gu, " ").trim();

// ---------------------------------------------------------------------------------------------------------------
// web_find

export type FoundPassage = Range & { text: string; phrase: boolean; score: number };

/** Characters of one returned passage at most (the matching sentence and what fits of its neighbours). */
export const FIND_PASSAGE_CHARS = 700;

/** Lower case, whitespace runs as one space, and for each character of that where it stands in `text`. */
function flatMap(text: string): { s: string; at: number[] } {
  const out: string[] = [];
  const at: number[] = [];
  let space = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (/\s/u.test(c)) {
      space = out.length > 0;
      continue;
    }
    if (space) {
      out.push(" ");
      at.push(i);
      space = false;
    }
    const l = c.toLowerCase();
    for (const ch of l) {
      out.push(ch);
      at.push(i);
    }
  }
  return { s: out.join(""), at };
}

/** The sentence `i` with `ranges[i].start <= pos < ranges[i + 1].start` (the last one before `pos`). */
function sentenceAt(ranges: Range[], pos: number): number {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ranges[mid]!.start <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The passages of `text` that best match `query`: where the whole phrase stands first (ignoring case and spacing —
 * looked for in the whole text, so a sentence cut in pieces does not hide it), then sentences with the most of its
 * words (at least half of them; a word also counts inside a longer one, `시행` in `시행계획`). Each comes with the
 * sentences around it, at most `FIND_PASSAGE_CHARS`. Passages do not overlap; best first, then in page order.
 * `gaps`: a web PDF's text — nothing is taken on or across its `PAGE_GAP` marks (#234).
 */
export function findPassages(
  text: string,
  query: string,
  max: number,
  opts: { gaps?: boolean } = {},
): { total: number; passages: FoundPassage[] } {
  const want = flat(query);
  const terms = [...new Set(termsOf(query))].filter((t) => t.length > 0);
  if (!want || !terms.length) return { total: 0, passages: [] };
  const gap = (a: number, b: number) => opts.gaps === true && touchesGap(text, a, b);
  const need = Math.max(1, Math.ceil(terms.length / 2));
  const sentences = sentenceRanges(text);
  if (!sentences.length) return { total: 0, passages: [] };
  type Hit = { first: number; last: number; score: number; phrase: boolean };
  const hits: Hit[] = [];
  const phrased = new Set<number>();
  // The phrase, in the whole text.
  const f = flatMap(text);
  for (let at = f.s.indexOf(want); at !== -1; at = f.s.indexOf(want, at + 1)) {
    const a = f.at[at]!;
    const b = f.at[at + want.length - 1]! + 1;
    if (gap(a, b)) continue;
    const first = sentenceAt(sentences, a);
    const last = sentenceAt(sentences, b - 1);
    for (let k = first; k <= last; k++) phrased.add(k);
    hits.push({ first, last, score: 2 * terms.length + 1, phrase: true });
  }
  // The words, sentence by sentence.
  for (const [i, r] of sentences.entries()) {
    if (phrased.has(i) || gap(r.start, r.end)) continue;
    const s = flat(text.slice(r.start, r.end));
    const words = new Set(termsOf(s));
    let n = 0;
    for (const t of terms) if (words.has(t) || (Array.from(t).length >= 2 && s.includes(t))) n++;
    if (n >= need) hits.push({ first: i, last: i, score: n, phrase: false });
  }
  hits.sort((x, y) => y.score - x.score || x.first - y.first);
  const taken: FoundPassage[] = [];
  for (const h of hits) {
    if (taken.length >= max) break;
    const r = withContext(text, sentences, h.first, h.last, gap);
    if (taken.some((t) => t.start < r.end && r.start < t.end)) continue;
    taken.push({ ...r, text: passageText(text, r), phrase: h.phrase, score: h.score });
  }
  return { total: hits.length, passages: taken };
}

/**
 * Sentences `first`–`last` with their neighbours before and after while they fit in `FIND_PASSAGE_CHARS` — never
 * across a PDF page that was not read (`PAGE_GAP`, review #237 2차): a passage is always one stretch of read text.
 */
function withContext(
  text: string,
  sentences: Range[],
  first: number,
  last: number,
  gap: (a: number, b: number) => boolean,
): Range {
  const own = { start: sentences[first]!.start, end: sentences[last]!.end };
  // A very long stretch alone is cut at a space near the limit (its start is kept: that is where it matched).
  if (own.end - own.start >= FIND_PASSAGE_CHARS) {
    const cut = text.lastIndexOf(" ", own.start + FIND_PASSAGE_CHARS);
    return { start: own.start, end: cut > own.start ? cut : own.start + FIND_PASSAGE_CHARS };
  }
  const blocked = (r: Range | undefined) => !r || gap(r.start, r.end);
  let start = own.start;
  let end = own.end;
  let back = true;
  let ahead = true;
  for (let k = 1; k <= 2; k++) {
    const before = sentences[first - k];
    if (back && !blocked(before) && end - before!.start <= FIND_PASSAGE_CHARS) start = before!.start;
    else back = false;
    const after = sentences[last + k];
    if (ahead && !blocked(after) && after!.end - start <= FIND_PASSAGE_CHARS) end = after!.end;
    else ahead = false;
  }
  return { start, end };
}

export { PAGE_GAP };
