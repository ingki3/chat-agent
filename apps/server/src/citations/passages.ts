import { GAP_MARK, gapRanges, KOREAN_PARTICLES, PAGE_GAP } from "./verify.js";

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
  // Never between the two halves of a surrogate pair (review #237 8차).
  let a = codePointCut(text, s + cut);
  if (a <= s) a = s + cut + 1;
  out.push({ start: s, end: trimEnd(text, s, a) });
  while (a < e && /\s/u.test(text[a]!)) a++;
  if (a < e) splitLong(text, a, e, out);
}

/** `i`, or one before it when `i` would split a surrogate pair. */
export function codePointCut(text: string, i: number): number {
  if (i <= 0 || i >= text.length) return i;
  const hi = text.charCodeAt(i - 1);
  const lo = text.charCodeAt(i);
  return hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff ? i - 1 : i;
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

/**
 * Case folding for a search — the same for the page and the query, cluster by cluster: NFC, lower case, and the
 * final sigma as sigma (`ς` → `σ`: `ΣΟΦΟΣ` lowercases to `σοφος` alone but `σοφοσ` inside a longer text).
 */
const fold = (t: string) => t.normalize("NFC").toLowerCase().replace(/ς/gu, "σ");
/** Folded, whitespace runs as one space — a sentence for keywords. */
const flat = (s: string) => fold(s.replace(/\s+/gu, " ").trim());
/** A passage as it is shown and quoted: the page's characters, whitespace runs as one space. */
export const passageText = (text: string, r: Range, gaps = false) => {
  const raw = text.slice(r.start, r.end);
  // Only a web PDF's U+E000 is a mark (shown without it); anywhere else it is the page's own character.
  return (gaps ? raw.replaceAll(GAP_MARK, "") : raw).replace(/\s+/gu, " ").trim();
};

// ---------------------------------------------------------------------------------------------------------------
// web_find

export type FoundPassage = Range & { text: string; phrase: boolean; score: number };

/** Characters of one returned passage at most (the matching sentence and what fits of its neighbours). */
export const FIND_PASSAGE_CHARS = 700;

/** A code point that belongs to the cluster before it: a combining mark or a Hangul medial/final jamo (NFD). */
const JOINS = /^[\p{M}ᅠ-ᇿힰ-퟿]$/u;

/**
 * Lower case, NFC, whitespace runs as one space — and for each character of that where it stands in `text`. NFC is
 * taken per cluster (a character with its combining marks, a decomposed Hangul syllable), so a decomposed page
 * matches a composed query and every position still points into the original text (review #237 6차).
 */
function flatMap(text: string): { s: string; at: number[]; end: number[] } {
  const out: string[] = [];
  const at: number[] = [];
  /** The end of the original cluster each character came from (a surrogate pair, combining marks — whole). */
  const end: number[] = [];
  let space = false;
  let i = 0;
  while (i < text.length) {
    const start = i;
    const first = text.codePointAt(i)!;
    i += first > 0xffff ? 2 : 1;
    while (i < text.length) {
      const cp = text.codePointAt(i)!;
      if (!JOINS.test(String.fromCodePoint(cp))) break;
      i += cp > 0xffff ? 2 : 1;
    }
    const cluster = text.slice(start, i);
    if (/^\s$/u.test(cluster)) {
      space = out.length > 0;
      continue;
    }
    if (space) {
      out.push(" ");
      at.push(start);
      end.push(start);
      space = false;
    }
    for (const ch of fold(cluster))
      for (let k = 0; k < ch.length; k++) {
        out.push(ch[k]!);
        at.push(start);
        end.push(i);
      }
  }
  return { s: out.join(""), at, end };
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
  // The query folded exactly as the page is (the same clusters, the same case folding — review #237 7차).
  const want = flatMap(query).s;
  // The query's words folded as the page's are (`fold` — the final sigma too, review #237 8차).
  const terms = [...new Set(termsOf(fold(query)))].filter((t) => t.length > 0);
  if (!want || !terms.length) return { total: 0, passages: [] };
  // The marks' ranges once per search (review #237 6차), each check a binary search.
  const ranges = opts.gaps === true ? gapRanges(text) : [];
  const gap = (a: number, b: number) => ranges.length > 0 && overlapsAny(ranges, a, b);
  const need = Math.max(1, Math.ceil(terms.length / 2));
  const sentences = sentenceRanges(text);
  if (!sentences.length) return { total: 0, passages: [] };
  /** `match`: where the phrase itself stands — the passage always holds all of it. */
  type Hit = { first: number; last: number; score: number; phrase: boolean; match?: Range };
  const hits: Hit[] = [];
  const phrased = new Set<number>();
  // The phrase, in the whole text.
  const f = flatMap(text);
  for (let at = f.s.indexOf(want); at !== -1; at = f.s.indexOf(want, at + 1)) {
    const a = f.at[at]!;
    // The end of the original cluster the last character came from (never inside a surrogate pair).
    const b = f.end[at + want.length - 1]!;
    if (gap(a, b)) continue;
    const first = sentenceAt(sentences, a);
    const last = sentenceAt(sentences, b - 1);
    for (let k = first; k <= last; k++) phrased.add(k);
    hits.push({ first, last, score: 2 * terms.length + 1, phrase: true, match: { start: a, end: b } });
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
    const r = withContext(text, sentences, h.first, h.last, gap, h.match);
    if (taken.some((t) => t.start < r.end && r.start < t.end)) continue;
    taken.push({ ...r, text: passageText(text, r, opts.gaps === true), phrase: h.phrase, score: h.score });
  }
  return { total: hits.length, passages: taken };
}

/** Whether `[a, b)` overlaps one of the sorted, disjoint `ranges` (binary search). */
function overlapsAny(ranges: readonly [number, number][], a: number, b: number): boolean {
  let lo = 0;
  let hi = ranges.length;
  // The first range that ends after `a`.
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ranges[mid]![1] <= a) lo = mid + 1;
    else hi = mid;
  }
  return lo < ranges.length && ranges[lo]![0] < b;
}

/**
 * Sentences `first`–`last` with their neighbours before and after while they fit in `FIND_PASSAGE_CHARS` — never
 * across a PDF page that was not read (`PAGE_GAP`, review #237 2차): a passage is always one stretch of read text.
 * A phrase's own range (`match`) is always inside the passage (review #237 6차): a stretch too long for the limit is
 * cut around the match, the room left split before and after it.
 */
function withContext(
  text: string,
  sentences: Range[],
  first: number,
  last: number,
  gap: (a: number, b: number) => boolean,
  match?: Range,
): Range {
  const own = { start: sentences[first]!.start, end: sentences[last]!.end };
  if (own.end - own.start >= FIND_PASSAGE_CHARS) {
    if (!match) {
      // A long sentence of keyword hits is cut at a space near the limit (its start kept).
      const cut = text.lastIndexOf(" ", own.start + FIND_PASSAGE_CHARS);
      return {
        start: own.start,
        end: cut > own.start ? cut : codePointCut(text, own.start + FIND_PASSAGE_CHARS),
      };
    }
    const room = Math.max(0, FIND_PASSAGE_CHARS - (match.end - match.start));
    let start = Math.max(own.start, match.start - Math.floor(room / 2));
    const end = Math.min(own.end, Math.max(match.end, start + FIND_PASSAGE_CHARS));
    start = Math.max(own.start, Math.min(start, end - FIND_PASSAGE_CHARS));
    // Both edges on code points (never half a surrogate pair).
    return {
      start: codePointCut(text, Math.min(start, match.start)),
      end: codePointCut(text, Math.max(end, match.end)),
    };
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
