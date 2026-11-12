import { boundText, CITATION_LIMITS } from "@agentlee/shared";

/**
 * The citation check (#25, PRD FR-5.2): is the snippet the model quoted really in the page text we stored?
 *
 * Both texts are normalised the same way:
 * - Unicode NFC per character cluster (a base character with its combining marks and Hangul jamo), so decomposed
 *   Hangul and accents match composed ones, then a small explicit fold: fullwidth ASCII to ASCII and `…` to `...`;
 *   spaces of every width count as whitespace. No NFKC: superscripts, subscripts and other compatibility
 *   characters stay distinct (`10²` is not `102`, `H₂O` is not `H2O`);
 * - typographic quote marks to one quote mark, dash punctuation to `-`, `∼` `〜` to `~` — primes (`′` `″`),
 *   the backtick, `´` and the minus sign `−` are kept as themselves (`12′` is not `12″`); invisible characters
 *   removed, any run of whitespace to
 *   one space. **No case folding** (review #97 round 10: `500MW` is not `500mW`, `CO` is not `Co`) — a quote must
 *   keep the page's case;
 * - common HTML entities decoded (`&amp;` `&minus;` `&nbsp;` `&#8722;` `&#x2212;` …) — page text can still carry
 *   them;
 * Footnote marks are **not** removed (`[3]`, `²` stay as written — `arr[1]` is not `arr[2]`), and a hyphen at a line end is **not** joined (`x−\ny`, `re-\nsign` are ambiguous): a wrapped word shows as not found.
 * When in doubt, nothing is normalised — a false "not found" shows ⚠️, a false "verified" must not happen.
 * Then the snippet must occur **as a whole**: no fuzzy matching, no partial overlap, no joining of pieces. A match
 * must not start or end inside a token: the source characters right before and after it must not be a letter,
 * digit, mark, modifier, superscript or subscript (`32m` is not found in `32m²`, `(10)` not in `(10)²`, `H` not
 * in `H₂O`, `32%` not in `132%`). Exceptions at the end only: a Korean particle (Hangul after a Hangul end —
 * `반도체 수출` in `반도체 수출이`), and a quote that itself ends with sentence punctuation. A match also must not
 * start inside a number after a separator or sign (`1.32%`, `1,234`, `-32%`) or end before the rest of a decimal
 * (`3` not in `3.5`).
 *
 * Normalising is one linear pass with per-character caches; a page's normalised text is cached by its body hash
 * (the same page is usually cited several times in a run).
 */

const QUOTES =
  /["'\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F\u00AB\u00BB\u2039\u203A\u300C\u300D\u300E\u300F\u301D\u301E\u301F\uFF02\uFF07]/gu;
/** One quote character (any style the fold above maps), whole string. */
const QUOTE_CHAR =
  /^["'\u2018\u2019\u201A\u201B\u201C\u201D\u201E\u201F\u00AB\u00BB\u2039\u203A\u300C\u300D\u300E\u300F\u301D\u301E\u301F\uFF02\uFF07]$/u;
/** Currency signs that may stand right before a number (fullwidth `＄` folds to `$`). */
const CURRENCY = /^[$€¥£₩₹\uFFE5\uFFE1\uFFE6]$/u;
const DASHES = /[\u2010\u2011\u2012\u2013\u2014\u2015]/gu;
/** Tilde-like range marks (`∼` U+223C, `〜` U+301C) are `~` (fullwidth `～` folds with the fullwidth ASCII). */
const TILDES = /[\u223C\u301C]/gu;
/** The fraction slash `⁄` (U+2044) is `/` (`1⁄2`). */
const FRACTION_SLASH = /\u2044/gu;
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/gu;
const INVISIBLE_CHAR = /^[\u200B-\u200D\u2060\uFEFF\u00AD]$/u;
const DIGIT = /\p{N}/u;
/**
 * A character that belongs to a token: letter, digit or mark. That covers modifier letters (`ʰ`, \p{Lm} ⊂ \p{L}),
 * superscript and subscript digits (`²`, `₂`, \p{No} ⊂ \p{N}) and subscript letters (\p{Lm}).
 */
const TOKEN = /[\p{L}\p{N}\p{M}]/u;
/**
 * Korean particles and copula endings a quote may stop right before (review #97 round 5) — a closed list: the
 * source must continue with one of these and then a token boundary (not a letter, digit or mark, or the end of
 * the text). Whatever the quote ends with: Hangul, a digit, `%`, a unit, `²`, Latin (`32%로`, `32m²로`,
 * `GPT-4o이며`, `Node.js입니다`, `수출이`). `유효하지 않습니다` (`하…`) and `사용불가` (`불…`) are not. A missing
 * rare particle only gives a false "not found" (⚠️). `만` is deliberately **not** in the list (review #97 round 8):
 * it is also a numeral unit (`10만`, `천만`, `수천만`), so a quote can never stop right before 만 — quoting through
 * 만 (`공사만`, `10만`, `Python 3.12만`) is verified. None of the numeral units (십 백 천 만 억 조 경) is a particle,
 * so truncating a number before its unit is rejected by this rule alone.
 */
export const KOREAN_PARTICLES = [
  "은",
  "는",
  "이",
  "가",
  "을",
  "를",
  "의",
  "에",
  "에서",
  "에게",
  "께",
  "로",
  "으로",
  "와",
  "과",
  "도",
  "까지",
  "부터",
  "보다",
  "처럼",
  "이나",
  "나",
  "이며",
  "며",
  "이고",
  "고",
  "이다",
  "다",
  "입니다",
  "이에요",
  "예요",
  "인",
  "이라",
  "라",
  "이라고",
  "라고",
  "이란",
  "란",
  "인데",
  // Past-tense copula (review #97 round 6): `반도체였다`, `수출이었다`, `정부였습니다`, `32%였다`.
  "였다",
  "이었다",
  "였습니다",
  "이었습니다",
  "였어요",
  "이었어요",
  "였고",
  "이었고",
  "였으며",
  "이었으며",
  "였던",
  "이었던",
  "였는데",
  "이었는데",
] as const;
/** Particles that may take 는 / 도 after them (`에서는`, `으로는`, `에도`, `까지도` …). */
export const COMBINING_PARTICLES = [
  "에",
  "에서",
  "에게",
  "께",
  "로",
  "으로",
  "와",
  "과",
  "까지",
  "부터",
  "보다",
  "처럼",
] as const;
const byLength = (xs: readonly string[]) => [...xs].sort((a, b) => b.length - a.length).join("|");
const PARTICLE_THEN_BOUNDARY = new RegExp(
  `^(?:(?:${byLength(COMBINING_PARTICLES)})(?:는|도)|${byLength(KOREAN_PARTICLES)})(?![\\p{L}\\p{N}\\p{M}])`,
  "u",
);
const PARTICLE_LOOKAHEAD = 7;
/** A sign (`-` `−` `+`): a match starting with one is numeric. */
const SIGN = /^[+\-\u2212]$/u;
const KOREAN_UNIT = /^[십백천만억조]$/u;
const KOREAN_DIGIT = /^[일이삼사오육칠팔구]$/u;
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
/** One cluster normalised (NFC + fold, invisible removed, quotes, dashes; case kept), cached. */
function normCluster(s: string): string {
  let r = clusterCache.get(s);
  if (r !== undefined) return r;
  r = fold(s.normalize("NFC"))
    .replace(INVISIBLE, "")
    .replace(QUOTES, '"')
    .replace(DASHES, "-")
    .replace(TILDES, "~")
    .replace(FRACTION_SLASH, "/");
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
  /**
   * Whether a digit comes right before `i`, spaces allowed (`12'`, and `12 '` from `<span>12</span>'`): a quote
   * mark there is a unit (feet, inches, minutes), not a quote.
   */
  const afterDigit = (i: number) => {
    let k = i - 1;
    while (k >= 0 && (SPACE.test(text[k]!) || INVISIBLE_CHAR.test(text[k]!))) k--;
    return k >= 0 && DIGIT.test(text[k]!);
  };
  let i = 0;
  while (i < len) {
    const c = text.charCodeAt(i);
    // ASCII fast path — unless a combining mark follows (NFD `cafe\u0301` must equal NFC `café`).
    if (c < 0x80 && !(i + 1 < len && joins(text.codePointAt(i + 1)!))) {
      if (c === 32 || (c >= 9 && c <= 13)) {
        space(i);
        i++;
      } else if (c === 34 || c === 39) {
        // Right after a digit a quote mark is a unit (`12'`, `12"` — feet, inches, minutes): kept as itself.
        put(afterDigit(i) ? String.fromCharCode(c) : '"', i, i + 1);
        i++;
      } else if (c === 38) {
        const m = ENTITY.exec(text.slice(i, i + 12));
        const decoded = m
          ? m[1] !== undefined || m[2] !== undefined
            ? safeFromCodePoint(m[1] !== undefined ? Number(m[1]) : parseInt(m[2]!, 16))
            : ENTITIES[m[3]!.toLowerCase()]
          : undefined;
        if (m && decoded !== undefined) {
          const end = i + m[0].length;
          emit(afterDigit(i) && QUOTE_CHAR.test(decoded) ? decoded : normCluster(decoded), i, end);
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
    while (i < len) {
      const cp = text.codePointAt(i)!;
      if (!joins(cp)) break;
      i += cp > 0xffff ? 2 : 1;
    }
    const cluster = text.slice(start, i);
    emit(afterDigit(start) && QUOTE_CHAR.test(cluster) ? fold(cluster) : normCluster(cluster), start, i);
  }
  return { norm: out.join(""), from: from.subarray(0, n), to: to.subarray(0, n) };
}

function safeFromCodePoint(cp: number): string | undefined {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return undefined;
  return String.fromCodePoint(cp);
}

/** The snippet normalised; surrounding quote marks, ellipses and spaces the model added are dropped. */
/**
 * The snippet normalised; the spaces, ellipses and wrapping quote marks the model added around it are dropped. A
 * quote mark next to a digit (`…12"`, `"12…`, spaces allowed) is kept — it may be a unit — unless it pairs with a
 * quote mark at the other end (`"…12"` wraps the whole snippet).
 */
export function normalizeSnippet(snippet: string): string {
  return snippetForms(snippet).stripped;
}

/**
 * The snippet normalised, and — when the model wrapped it in a pair of quote marks — the form with that first
 * pair still on (`“올해 매출 목표는 100”`): the page may have the very same quotes around a number.
 */
function snippetForms(snippet: string): { stripped: string; wrapped?: string } {
  let s = normalizeWithMap(snippet).norm;
  let wrapped: string | undefined;
  for (;;) {
    const before = s;
    s = s.replace(/^(?:\s|\.{3,})+|(?:\s|\.{3,})+$/gu, "");
    const opens = QUOTE_CHAR.test(firstChar(s));
    const closes = s.length > 1 && QUOTE_CHAR.test(lastChar(s));
    if (opens && closes) {
      wrapped ??= s;
      s = Array.from(s).slice(1, -1).join("");
    } else if (opens && !/^.\s*\p{N}/u.test(s)) s = Array.from(s).slice(1).join("");
    else if (closes && !/\p{N}\s*.$/u.test(s)) s = Array.from(s).slice(0, -1).join("");
    if (s === before) return wrapped === undefined ? { stripped: s } : { stripped: s, wrapped };
  }
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
  const forms = snippetForms(snippet);
  if (Array.from(forms.stripped).length < CITATION_LIMITS.minSnippet)
    return { found: false, reason: "too_short" };
  const page = normalizedBody(body, cacheKey);
  // A wrapped snippet is first looked for as it was sent, quotes and all; only then without them.
  for (const want of forms.wrapped === undefined ? [forms.stripped] : [forms.wrapped, forms.stripped]) {
    const quote = matchIn(body, page, want);
    if (quote !== undefined) return { found: true, quote };
  }
  return { found: false, reason: "not_found" };
}

const firstTokens = (s: string, n: number) => s.split(" ").slice(0, n).join(" ");
const lastTokens = (s: string, n: number) => s.split(" ").slice(-n).join(" ");

/** The first occurrence of `want` in the page that respects every boundary rule, as the original passage. */
function matchIn(body: string, { norm, from, to }: Normalized, want: string): string | undefined {
  const last = lastChar(want);
  // A numeric edge: a digit in the first / last two tokens, or a sign or currency sign at the start.
  // (A sign or currency sign first is covered: the number after it is in the first two tokens.)
  const numericStart = DIGIT.test(firstTokens(want, NUMERIC_EDGE_TOKENS));
  const numericEnd = DIGIT.test(lastTokens(want, NUMERIC_EDGE_TOKENS));
  for (let at = norm.indexOf(want); at !== -1; at = norm.indexOf(want, at + 1)) {
    const before = charBefore(norm, at);
    // At a token boundary at the start: after a space, punctuation or nothing — not inside a word or glued to a
    // symbol (`h…` after `100km/`, `5도` after `10~`).
    if (before !== "" && before !== " " && !BOUNDARY_PUNCT.test(before)) continue;
    const start = from[at]!;
    const end = to[at + want.length - 1]!;
    // A numeric edge must be a clause edge (review #97 round 22): the number's whole clause is quoted. A sign
    // before the start, across spaces, line breaks and currency signs, still belongs to the number (`-\n$5`).
    if (numericStart && (!startsClause(body, start) || signBefore(body, start))) continue;
    if (numericEnd && !endsClause(body, end, want)) continue;
    const rest = norm.slice(at + want.length, at + want.length + PARTICLE_LOOKAHEAD);
    const after = firstChar(rest);
    // At a token boundary at the end too: a space, punctuation, nothing — or (below) a listed particle.
    if (after !== "" && after !== " " && !BOUNDARY_PUNCT.test(after) && !TOKEN.test(after)) continue;
    if (!numericEnd) {
      // A Korean numeral unit not before a numeral digit (`백` in `백이 명`, `십` in `십이 도` — 백이 is one number).
      if (KOREAN_UNIT.test(last) && KOREAN_DIGIT.test(after)) continue;
      // Not inside a token at the end — unless the source goes on with a Korean particle or copula from the closed
      // list that itself ends at a token boundary (`수출이`, `반도체였다`).
      if (TOKEN.test(after) && !PARTICLE_THEN_BOUNDARY.test(rest)) continue;
    }
    return boundText(body.slice(start, end).replace(/\s+/g, " ").trim(), CITATION_LIMITS.snippet);
  }
  return undefined;
}

/** Tokens at each edge of a match that make it numeric. */
const NUMERIC_EDGE_TOKENS = 2;
/** Punctuation that ends a clause: sentence and clause marks, closing brackets and quotes, the ellipsis. */
const CLAUSE_END = /^[.,!?;:)\]}」』”’"'…。、！？]$/u;
/** Punctuation a clause starts after: sentence and clause marks, opening brackets and quotes. */
const CLAUSE_START = /^[.,!?;:([{「『“‘"'…。、！？]$/u;
/** Whitespace in the page that is not a line break (a line break is a clause edge). */
const INLINE_SPACE = /^[ \t\u00A0\u2000-\u200A\u202F\u205F\u3000\u200B-\u200D\u2060\uFEFF\u00AD]$/u;

/** Any punctuation a token may meet without being cut: clause punctuation, brackets and quotes. */
const BOUNDARY_PUNCT = /^[.,!?;:()[\]{}「」『』“”‘’"'…。、！？]$/u;

/**
 * Punctuation between two digits is part of the number (`3.5`, `1,234`, `3:1`), never a clause edge; a ratio's
 * `:` also with spaces (`3 : 1`). `.` and `,` count only when adjacent (`3, 4명` is prose).
 */
function insideNumber(text: string, i: number): boolean {
  if (DIGIT.test(text[i - 1] ?? "") && DIGIT.test(text[i + 1] ?? "")) return true;
  if (text[i] !== ":") return false;
  let a = i - 1;
  while (a >= 0 && INLINE_SPACE.test(text[a]!)) a--;
  let b = i + 1;
  while (b < text.length && INLINE_SPACE.test(text[b]!)) b++;
  return DIGIT.test(text[a] ?? "") && DIGIT.test(text[b] ?? "");
}

/** A sign right before the start, across any spaces, line breaks and currency signs (`-$100`, `- 5%`, `-\n$5`). */
function signBefore(body: string, start: number): boolean {
  let k = start - 1;
  while (k >= 0 && (SPACE.test(body[k]!) || INLINE_SPACE.test(body[k]!) || CURRENCY.test(body[k]!))) k--;
  return k >= 0 && SIGN.test(body[k]!);
}

/**
 * Whether the match `[…, end)` of `body` ends a clause: it ends with clause punctuation itself, or the page goes on
 * (across inline spaces) with clause punctuation, a line break, or nothing. A quote mark right after a digit is a
 * unit (`12'`), and punctuation between digits is part of the number — neither ends a clause.
 */
function endsClause(body: string, end: number, want: string): boolean {
  const own = end - 1;
  const ownChar = body[own] ?? "";
  if (
    CLAUSE_END.test(ownChar) &&
    !insideNumber(body, own) &&
    !(QUOTE_CHAR.test(ownChar) && DIGIT.test(lastChar(want.slice(0, -1))))
  )
    return true;
  let k = end;
  while (k < body.length && INLINE_SPACE.test(body[k]!)) k++;
  if (k >= body.length || body[k] === "\n" || body[k] === "\r") return true;
  const c = body[k]!;
  if (!CLAUSE_END.test(c) || insideNumber(body, k)) return false;
  // A quote mark right after the number is its unit, not a closing quote.
  return !(QUOTE_CHAR.test(c) && DIGIT.test(lastChar(want)));
}

/**
 * Whether the match `[start, …)` of `body` starts a clause: the page has (across inline spaces) clause punctuation,
 * an opening bracket or quote, a line break, or nothing before it. Punctuation between digits is part of a number.
 * (A wrapped snippet that starts with its own quote mark is also tried without it, so the page's quote counts.)
 */
function startsClause(body: string, start: number): boolean {
  let k = start - 1;
  while (k >= 0 && INLINE_SPACE.test(body[k]!)) k--;
  if (k < 0 || body[k] === "\n" || body[k] === "\r") return true;
  return CLAUSE_START.test(body[k]!) && !insideNumber(body, k);
}
