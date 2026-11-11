import { boundText, CITATION_LIMITS } from "@agentlee/shared";

/**
 * The citation check (#25, PRD FR-5.2): is the snippet the model quoted really in the page text we stored?
 *
 * Both texts are normalised the same way — Unicode NFKC (fullwidth letters, compatibility forms, `…` → `...`),
 * every quote style to one quote mark, every dash to `-`, invisible characters removed, any run of whitespace to
 * one space, lower case — and then the snippet must occur **as a whole**: no fuzzy matching, no partial overlap,
 * no joining of pieces. A match must also start at a word boundary, and must not end in the middle of a number
 * or a Latin word (`32%` is not found in `132%`, `3` not in `3.5`); a Korean particle after the end is fine
 * (`반도체 수출` in `반도체 수출이`).
 */

const QUOTES =
  /["'\u0060\u00B4\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F\u00AB\u00BB\u2039\u203A\u300C\u300D\u300E\u300F\u301D\u301E\u301F\uFF02\uFF07\u2032\u2033]/gu;
const DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/gu;
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/gu;
const WORD = /[\p{L}\p{N}]/u;
const DIGIT = /\p{N}/u;
const LATIN = /\p{Script=Latin}/u;

const segmenter = new Intl.Segmenter("und", { granularity: "grapheme" });

/** One grapheme (or any short text) normalised, without whitespace collapsing. */
function normChunk(s: string): string {
  return s.normalize("NFKC").replace(INVISIBLE, "").replace(QUOTES, '"').replace(DASHES, "-").toLowerCase();
}

/** The normalised text, and for each of its UTF-16 units the original `[start, end)` it came from. */
export function normalizeWithMap(text: string): { norm: string; from: number[]; to: number[] } {
  let norm = "";
  const from: number[] = [];
  const to: number[] = [];
  for (const { segment, index } of segmenter.segment(text)) {
    const n = normChunk(segment);
    for (const ch of n) {
      let add = ch;
      if (/\s/u.test(ch)) {
        if (!norm.length || norm.endsWith(" ")) continue;
        add = " ";
      }
      norm += add;
      for (let i = 0; i < add.length; i++) {
        from.push(index);
        to.push(index + segment.length);
      }
    }
  }
  if (norm.endsWith(" ")) {
    norm = norm.slice(0, -1);
    from.pop();
    to.pop();
  }
  return { norm, from, to };
}

/** The snippet normalised; surrounding quote marks, ellipses and spaces the model added are dropped. */
export function normalizeSnippet(snippet: string): string {
  return normalizeWithMap(snippet).norm.replace(/^(?:\s|"|\.{3,})+|(?:\s|"|\.{3,})+$/gu, "");
}

/** The code point that ends right before `i`. */
const charBefore = (s: string, i: number) => Array.from(s.slice(Math.max(0, i - 2), i)).at(-1) ?? "";
const lastChar = (s: string) => Array.from(s).at(-1) ?? "";
const firstChar = (s: string) => Array.from(s)[0] ?? "";

export type SnippetMatch =
  { found: true; quote: string } | { found: false; reason: "too_short" | "not_found" };

/**
 * Looks for the snippet in the stored text. `quote` is the original passage (as it stands in the page), at most
 * `CITATION_LIMITS.snippet` characters.
 */
export function findSnippet(body: string, snippet: string): SnippetMatch {
  const want = normalizeSnippet(snippet);
  if (Array.from(want).length < CITATION_LIMITS.minSnippet) return { found: false, reason: "too_short" };
  const { norm, from, to } = normalizeWithMap(body);
  const first = firstChar(want);
  const last = lastChar(want);
  for (let at = norm.indexOf(want); at !== -1; at = norm.indexOf(want, at + 1)) {
    const before = charBefore(norm, at);
    if (WORD.test(first) && WORD.test(before)) continue;
    const rest = norm.slice(at + want.length, at + want.length + 3);
    const after = firstChar(rest);
    if (DIGIT.test(last) && (DIGIT.test(after) || /^[.,]\p{N}/u.test(rest))) continue;
    if (LATIN.test(last) && LATIN.test(after)) continue;
    const start = from[at]!;
    const end = to[at + want.length - 1]!;
    const quote = body.slice(start, end).replace(/\s+/g, " ").trim();
    return { found: true, quote: boundText(quote, CITATION_LIMITS.snippet) };
  }
  return { found: false, reason: "not_found" };
}
