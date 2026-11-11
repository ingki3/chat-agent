import { boundText, CITATION_LIMITS } from "@agentlee/shared";

/**
 * The citation check (#25, PRD FR-5.2): is the snippet the model quoted really in the page text we stored?
 *
 * Both texts are normalised the same way:
 * - Unicode NFC per character cluster (a base character with its combining marks and Hangul jamo), so decomposed
 *   Hangul and accents match composed ones, then a small explicit fold: fullwidth ASCII to ASCII and `…` to `...`;
 *   spaces of every width count as whitespace. No NFKC: superscripts, subscripts and other compatibility
 *   characters stay distinct (`10²` is not `102`, `H₂O` is not `H2O`);
 * - every quote style to one quote mark, every dash to `-`, invisible characters removed, any run of whitespace to
 *   one space, lower case;
 * - common HTML entities decoded (`&amp;` `&minus;` `&nbsp;` `&#8722;` `&#x2212;` …) — page text can still carry
 *   them;
 * - inline footnote numbers dropped: `[3]` (one to three digits in brackets, not next to a digit) and superscript
 *   digits right after a Hangul / Han / Kana character at a word end.
 * A hyphen at a line end is **not** joined (`x−\ny`, `re-\nsign` are ambiguous): a wrapped word shows as not found.
 * When in doubt, nothing is normalised — a false "not found" shows ⚠️, a false "verified" must not happen.
 * Then the snippet must occur **as a whole**: no fuzzy matching, no partial overlap, no joining of pieces. A match
 * must start at a word boundary and not inside a number (`32%` is not found in `132%`, `1.32%`, `-32%`; `234` not
 * in `1,234`), and must not end in the middle of a number or a Latin word (`3` not in `3.5`); a Korean particle
 * after the end is fine (`반도체 수출` in `반도체 수출이`).
 *
 * Normalising is one linear pass with per-character caches; a page's normalised text is cached by its body hash
 * (the same page is usually cited several times in a run).
 */

const QUOTES = /["'`´‘’‚‛“”„‟«»‹›「」『』〝〞〟＂＇′″]/gu;
const DASHES = /[‐‑‒–—―−]/gu;
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/gu;
const WORD = /[\p{L}\p{N}]/u;
const DIGIT = /\p{N}/u;
const LATIN = /\p{Script=Latin}/u;
const SPACE = /\s/u;

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  shy: "",
  minus: "−",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  middot: "·",
  times: "×",
  deg: "°",
  percnt: "%",
};
const ENTITY = /^&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([a-zA-Z]{2,8}));/;

/** Superscript digits used as footnote numbers (¹²³⁰⁴…⁹). */
const isSuperscriptDigit = (c: number) =>
  c === 0xb9 || c === 0xb2 || c === 0xb3 || (c >= 0x2070 && c <= 0x2079);

/**
 * Whether a code point attaches to the cluster before it: combining marks, Hangul medial/final jamo, joiners and
 * variation selectors. Cached per BMP code point (0 unknown, 1 joins, 2 does not).
 */
const joinsCache = new Uint8Array(0x10000);
function joins(cp: number): boolean {
  if (cp < 0x300) return false;
  if (cp >= 0x10000) return /\p{M}/u.test(String.fromCodePoint(cp));
  const k = joinsCache[cp]!;
  if (k) return k === 1;
  const j =
    (cp >= 0x1160 && cp <= 0x11ff) ||
    (cp >= 0xd7b0 && cp <= 0xd7ff) ||
    cp === 0x200d ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    /\p{M}/u.test(String.fromCharCode(cp));
  joinsCache[cp] = j ? 1 : 2;
  return j;
}

/**
 * The small explicit fold after NFC (review #97 round 3: no NFKC — it turns `²` into `2`, `①` into `1`):
 * fullwidth ASCII to ASCII and `…` to `...` (spaces of every width are whitespace already). Superscripts, subscripts, circled digits and
 * every other compatibility character stay what they are.
 */
function fold(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    out += cp >= 0xff01 && cp <= 0xff5e ? String.fromCharCode(cp - 0xfee0) : cp === 0x2026 ? "..." : ch;
  }
  return out;
}

const clusterCache = new Map<string, string>();
/** One cluster normalised (NFC + fold, invisible removed, quotes, dashes, lower case), cached. */
function normCluster(s: string): string {
  let r = clusterCache.get(s);
  if (r !== undefined) return r;
  r = fold(s.normalize("NFC")).replace(INVISIBLE, "").replace(QUOTES, '"').replace(DASHES, "-").toLowerCase();
  if (clusterCache.size < 50_000) clusterCache.set(s, r);
  return r;
}

export type Normalized = { norm: string; from: Int32Array; to: Int32Array };

/** The normalised text, and for each of its UTF-16 units the original `[start, end)` it came from. */
export function normalizeWithMap(text: string): Normalized {
  verifyStats.normalized++;
  const len = text.length;
  const out: string[] = [];
  // Output can be a little longer than the input (`…` → `...`): grown when needed.
  let from = new Int32Array(len + 16);
  let to = new Int32Array(len + 16);
  let n = 0;
  let pendingSpace = -1; // start of a whitespace run not yet written
  const put = (ch: string, s: number, e: number) => {
    if (pendingSpace >= 0 && n > 0) write(" ", pendingSpace, s);
    pendingSpace = -1;
    write(ch, s, e);
  };
  const write = (ch: string, s: number, e: number) => {
    for (let k = 0; k < ch.length; k++) {
      if (n >= from.length) {
        const f = new Int32Array(from.length * 2);
        f.set(from);
        from = f;
        const t = new Int32Array(to.length * 2);
        t.set(to);
        to = t;
      }
      from[n] = s;
      to[n] = e;
      n++;
    }
    out.push(ch);
  };
  const space = (s: number) => {
    if (pendingSpace < 0) pendingSpace = s;
  };
  /** Writes a normalised piece (may hold several characters, spaces or dashes). */
  const emit = (r: string, s: number, e: number) => {
    for (const ch of r) {
      if (SPACE.test(ch)) space(s);
      else put(ch, s, e);
    }
  };
  /** The code point that ends right before `i` in the source text. */
  const rawBefore = (i: number) => {
    if (i <= 0) return "";
    const c = text.charCodeAt(i - 1);
    return c >= 0xdc00 && c <= 0xdfff && i >= 2 ? text.slice(i - 2, i) : text[i - 1]!;
  };
  /** A word end after a footnote: end of text, a space, or punctuation (not a letter, digit or unit). */
  const wordEndAt = (j: number) => {
    const next = text.codePointAt(j);
    return next === undefined || !/[\p{L}\p{N}\p{M}]/u.test(String.fromCodePoint(next));
  };
  /**
   * Superscript digits at `[s, e)` that are a footnote: only right after a Hangul, Han or Kana character, at a word
   * end (`반겼다²`). Anywhere else (`10²`, `m²`, `(10)²`, `so.¹`) they are kept as the characters they are.
   */
  const superscriptNote = (s: number, e: number) =>
    /[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(rawBefore(s)) &&
    wordEndAt(e);

  let i = 0;
  while (i < len) {
    const c = text.charCodeAt(i);
    // ASCII fast path — unless a combining mark follows (NFD `cafe\u0301` must equal NFC `café`).
    if (c < 0x80 && !(i + 1 < len && joins(text.codePointAt(i + 1)!))) {
      if (c === 32 || (c >= 9 && c <= 13)) {
        space(i);
        i++;
      } else if (c >= 65 && c <= 90) {
        put(String.fromCharCode(c + 32), i, i + 1);
        i++;
      } else if (c === 34 || c === 39 || c === 96) {
        put('"', i, i + 1);
        i++;
      } else if (c === 91) {
        const m = /^\[\d{1,3}\]/.exec(text.slice(i, i + 5));
        // An inline footnote number — not next to a digit, where dropping it would join two numbers.
        if (
          m &&
          !DIGIT.test(rawBefore(i)) &&
          !/^\p{N}/u.test(text.slice(i + m[0].length, i + m[0].length + 2))
        )
          i += m[0].length;
        else {
          put("[", i, i + 1);
          i++;
        }
      } else if (c === 38) {
        const m = ENTITY.exec(text.slice(i, i + 12));
        const decoded = m
          ? m[1] !== undefined || m[2] !== undefined
            ? safeFromCodePoint(m[1] !== undefined ? Number(m[1]) : parseInt(m[2]!, 16))
            : ENTITIES[m[3]!.toLowerCase()]
          : undefined;
        if (m && decoded !== undefined) {
          const end = i + m[0].length;
          emit(normCluster(decoded), i, end);
          i = end;
        } else {
          put("&", i, i + 1);
          i++;
        }
      } else {
        put(String.fromCharCode(c), i, i + 1);
        i++;
      }
      continue;
    }
    // A cluster: this code point and the ones that join it.
    const start = i;
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < len ? 2 : 1;
    if (isSuperscriptDigit(c)) {
      let e = i;
      while (e < len && isSuperscriptDigit(text.charCodeAt(e))) e++;
      if (superscriptNote(start, e)) {
        i = e; // a footnote number
        continue;
      }
    }
    while (i < len) {
      const cp = text.codePointAt(i)!;
      if (!joins(cp)) break;
      i += cp > 0xffff ? 2 : 1;
    }
    emit(normCluster(text.slice(start, i)), start, i);
  }
  return { norm: out.join(""), from: from.subarray(0, n), to: to.subarray(0, n) };
}

function safeFromCodePoint(cp: number): string | undefined {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return undefined;
  return String.fromCodePoint(cp);
}

/** The snippet normalised; surrounding quote marks, ellipses and spaces the model added are dropped. */
export function normalizeSnippet(snippet: string): string {
  return normalizeWithMap(snippet).norm.replace(/^(?:\s|"|\.{3,})+|(?:\s|"|\.{3,})+$/gu, "");
}

/** The code point that ends right before `i`. */
const charBefore = (s: string, i: number) => Array.from(s.slice(Math.max(0, i - 2), i)).at(-1) ?? "";
const lastChar = (s: string) => Array.from(s).at(-1) ?? "";
const firstChar = (s: string) => Array.from(s)[0] ?? "";

/**
 * Normalised page texts by body hash (a few pages, the most recently used kept). The text itself is compared on
 * a hit too (cheap next to normalising), so a hash that no longer matches its body is never trusted.
 */
const BODY_CACHE_SIZE = 4;
/** Texts normalised so far, snippets included (tests check that a repeated page comes from the cache). */
export const verifyStats = { normalized: 0 };
const bodyCache = new Map<string, { body: string; n: Normalized }>();
function normalizedBody(body: string, key: string | undefined): Normalized {
  if (key === undefined) return normalizeWithMap(body);
  const hit = bodyCache.get(key);
  if (hit && hit.body === body) {
    bodyCache.delete(key);
    bodyCache.set(key, hit);
    return hit.n;
  }
  const n = normalizeWithMap(body);
  bodyCache.delete(key);
  bodyCache.set(key, { body, n });
  while (bodyCache.size > BODY_CACHE_SIZE) bodyCache.delete(bodyCache.keys().next().value!);
  return n;
}

export type SnippetMatch =
  { found: true; quote: string } | { found: false; reason: "too_short" | "not_found" };

/**
 * Looks for the snippet in the stored text. `quote` is the original passage (as it stands in the page), at most
 * `CITATION_LIMITS.snippet` characters. `cacheKey` (the body's hash) lets repeated checks of one page reuse its
 * normalised text.
 */
export function findSnippet(body: string, snippet: string, cacheKey?: string): SnippetMatch {
  const want = normalizeSnippet(snippet);
  if (Array.from(want).length < CITATION_LIMITS.minSnippet) return { found: false, reason: "too_short" };
  const { norm, from, to } = normalizedBody(body, cacheKey);
  const first = firstChar(want);
  const last = lastChar(want);
  for (let at = norm.indexOf(want); at !== -1; at = norm.indexOf(want, at + 1)) {
    const before = charBefore(norm, at);
    if (WORD.test(first) && WORD.test(before)) continue;
    // Not inside a number: `1.32%`, `1,234`, `-32%` (a sign changes the figure).
    if (
      DIGIT.test(first) &&
      /[.,\-+]/u.test(before) &&
      (before === "-" || before === "+" || DIGIT.test(charBefore(norm, at - 1)))
    )
      continue;
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
