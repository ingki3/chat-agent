/**
 * Removes secrets from tool inputs and outputs before they are stored, streamed or shown (PRD FR-3.4:
 * "펼치면 도구 이름·입력·결과 요약 — 비밀 필드 제거된 값"). This changes what is kept in the history and what
 * later runtimes see, so it errs on precise names rather than broad substrings:
 *
 * - **Secret fields** (by exact name, or a known secret suffix such as `githubToken`, `dbPassword`): the value
 *   is hidden whatever its type — numbers too (an OTP or PIN is often a number). Token *counters*
 *   (`inputTokens`, `maxTokens`, …) and look-alikes (`tokenizer`, `tokenSymbol`) are ordinary data.
 * - **Credentials inside any string** (an API key in an error message or a log line): each match is replaced
 *   in place, the rest of the text stays.
 */
import { applyEdits, literalEdits, mapRegions, structureEdits } from "./json-spans.js";

export const REDACTED = "[숨김]";

/** Field names (lower-case, letters and digits only) whose value is always secret. */
export const SECRET_NAMES = new Set([
  "password",
  "passwd",
  "pass",
  "passphrase",
  "pwd",
  "secret",
  "token",
  "auth",
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "credential",
  "credentials",
  "session",
  "sessionid",
  "sid",
  "otp",
  "totp",
  "mfacode",
  "otpcode",
  "verificationcode",
  "pin",
  "pincode",
  "cvv",
  "cvc",
  "apikey",
  "xapikey",
  "accesskey",
  "privatekey",
  "signature",
]);
/** Name endings that make a field secret (`githubToken`, `dbPassword`, `stripeSecretKey`, `xAuthToken`). */
export const SECRET_SUFFIXES = [
  "password",
  "passwd",
  "passphrase",
  "secret",
  "secretkey",
  "token",
  "apikey",
  "accesskey",
  "privatekey",
  "sessionid",
  "cookie",
  "credentials",
  "otp",
];
/** Counters that end like a secret name but are not (`inputTokens` ends in "tokens", these in "token"). */
const NOT_SECRET =
  /^(max|input|output|total|prompt|completion|cached|reasoning|num|next|page|nextpage|cursor|continuation|sync)token$/;

const normKey = (k: string) => k.toLowerCase().replace(/[^a-z0-9]/g, "");
export function isSecretKey(k: string): boolean {
  const n = normKey(k);
  if (SECRET_NAMES.has(n)) return true;
  if (NOT_SECRET.test(n)) return false;
  return SECRET_SUFFIXES.some((s) => n.endsWith(s) && n.length > s.length);
}

// ---- free text ----
//
// Every pattern below runs in linear time on any input (tool output can be megabytes): a candidate may only
// start where the previous character cannot belong to it (a lookbehind), and runs of characters are taken
// whole with the atomic `(?=(X+))\N` idiom, so the engine never retries a run from inside. PEM blocks are found
// with indexOf. `test/redact.test.ts` checks 1 MB of adversarial input per pattern.

/** Known high-entropy credential formats: always secret, wherever they appear. */
const FORMATS = [
  /(?<![\w-])(?:sk|pk|rk)-(?=([\w-]{8,}))\1/g, // OpenAI / Anthropic / Stripe style keys
  /(?<![\w-])gh[pousr]_(?=([A-Za-z0-9]{20,}))\1/g, // GitHub tokens
  /(?<![\w-])github_pat_(?=(\w{20,}))\1/g,
  /(?<![\w-])xox[abprs]-(?=([A-Za-z0-9-]{10,}))\1/g, // Slack
  /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}(?![A-Za-z0-9])/g, // AWS access key id
  /(?<![\w-])AIza(?=([\w-]{30,}))\1/g, // Google API key
  /(?<![\w-])eyJ(?=([\w-]{5,}))\1\.(?=([\w-]{8,}))\2\.(?=([\w-]{8,}))\3/g, // JWT
];

/**
 * A free-text value that is clearly a credential, not a word, an identifier path, a placeholder or an example:
 * no spaces, ASCII, long enough, and mixing kinds of characters.
 */
export function credentialLike(v: string): boolean {
  if (v.length < 6 || v.length > 4096) return false;
  if (!/^[\x21-\x7e]+$/.test(v)) return false; // non-ASCII or spaces: prose ("다음에", "is an HTTP scheme")
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(v)) return false; // process.env.PASSWORD, os.environ.x
  if (/^[A-Z][A-Z0-9_]*$/.test(v)) return false; // YOUR_API_KEY, PASSWORD (env names / placeholders)
  if (/[$%]\{|\{\{|^\$|^%|^<|>$|\.\.\.|^\*+$/.test(v)) return false; // ${TOKEN}, {{token}}, <key>, ...
  if (
    /^(.)\1+$/.test(v) ||
    /^(x+|your[\w-]*|changeme|example\w*|placeholder|null|none|undefined|true|false)$/i.test(v)
  )
    return false;
  const kinds =
    Number(/[a-z]/.test(v)) +
    Number(/[A-Z]/.test(v)) +
    Number(/[0-9]/.test(v)) +
    Number(/[^A-Za-z0-9]/.test(v));
  return kinds >= 2 && (v.length >= 12 || /[0-9]/.test(v));
}

/** `Bearer <token>` / `Basic <base64>`: only when what follows looks like a real token. */
const AUTH_SCHEME = /(?<![\w-])(Bearer|Basic)([ \t]+)(?=([A-Za-z0-9._~+/-]+=*))\3/gi;
/** `password=…`, `api_key: …` in free text (URLs, logs, config lines). The key is judged by `isSecretKey`. */
const ASSIGNMENT =
  /(?<![\w-])(?=([A-Za-z][\w-]*))\1(?<=(?:pass(?:word|wd|phrase)?|pwd|secret|token|key|otp|pin|credentials?|cookie|session_?id|auth|authorization))([ \t]*[=:][ \t]*)(?:"([^"\n]{1,512})"|'([^'\n]{1,512})'|(?=([^\s&,;"'<>()[\]{}\\]+))\5)/gi;
function redactPem(s: string): string {
  let i = s.indexOf("-----BEGIN ");
  if (i < 0) return s;
  let out = "";
  let from = 0;
  const header = /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----/y;
  while (i >= 0) {
    header.lastIndex = i;
    if (header.test(s)) {
      const end = s.indexOf("PRIVATE KEY-----", header.lastIndex);
      const stop = end < 0 ? s.length : end + "PRIVATE KEY-----".length;
      out += s.slice(from, i) + REDACTED;
      from = stop;
      i = s.indexOf("-----BEGIN ", stop);
    } else i = s.indexOf("-----BEGIN ", i + 1);
  }
  return out + s.slice(from);
}

/** How many levels of JSON-inside-a-JSON-string are opened (each level is one pass over its own text). */
const MAX_NESTED = 4;

// ---- pass C: the fail-closed sweep ----
//
// Passes A and B are precise for well-formed JSON; broken or oddly wrapped JSON can still slip past them. The
// sweep runs last, over the final text, and makes no guesses (review #78, rounds 10–14). Escapes are not
// recognised form by form — every escape trick is another spelling of the same characters — the text is
// decoded instead:
//
// 1. Layers. Layer 0 is the text; layer k + 1 is layer k with one layer of string unescaping applied,
//    tolerantly — JSON's escapes and the ones Python's repr() and string literals use (`\'`, `\xHH`,
//    `\UXXXXXXXX`, octal, `\a \v`, `\N{…}`; see escapeAt); an invalid escape stays as written — until a layer has
//    nothing left to decode, at most 8 layers. Each layer keeps, for every character, the offset in layer 0 where
//    it came from. Each layer is O(n). Layers are only matched against: the text that is kept is always the
//    original. Deeper wrapping is not looked into but hidden (fail-closed): if the last layer still holds a
//    backslash that would decode further, everything from there is hidden.
// 2. Keys, on every layer, with plain characters only (scanLayer): quoted (`"…"`, `'…'`, `` `…` ``, closed by the
//    next unescaped quote of the same character; also computed, `["…"]` / `` [`…`] ``) or bare (identifier
//    characters of any script — `\p{ID_Continue}`, `$`, `-` — and escapes), then a gap — any whitespace in any
//    language (`\s`, `\p{Z}`, BOM, line separators), line continuations (a backslash before a real line break)
//    and comments (`/* … */`, `//…` and `#…` to the line end) — then a separator (`:`, `=`, `=>`, `:=`; escaped
//    separators are plain on the next layer).
//    - A key holding an escape the decoder does not know (escapeAt gives nothing, or an unknown `\N{…}`), an
//      escape whose meaning differs between languages (see escapeAt), or a template substitution `${…}` is
//      unknown: it may spell anything, so its value is hidden. For a bare token this applies only where a key
//      can start (atKeyPosition: start of text or line, after `{` `,` `;` `&` `?` or a statement word such as
//      `export`), not inside a regex group or a path. Bash `$'…'` holds a whole assignment and is read as one (its `=` may be an escape too: `\x3d`, `\075`).
//      A computed key `[…]` that is not one plain string literal is unknown too. A comment whose end is not
//      found within its window means what follows cannot be known: fail closed from there. In short — whenever
//      the scanner cannot be sure what the key is, it is unknown, never "not a key". This is what makes the rule independent of
//      language: no syntax list decides it — whatever a language's escape is, either we decode it to the same
//      characters (then the decoded key is judged) or we do not (then the key is not trusted).
//    - A known key is judged by `isSecretKey`, the same function A and B use.
//    - After the separator, whitespace, quotes and backslashes are skipped; a value that then starts with the tag
//      that passes A and B put on every value they fully replaced (TAG, a Unicode noncharacter: removed from all
//      input first, and decoded to U+FFFD when it appears as an escape, so data can never imitate it) was hidden
//      already. Otherwise — a quoted or unknown key, or a bare key with a quote around the separator — A/B could
//      not parse this content: everything from the end of the separator (mapped back to layer 0) to the end of
//      the input becomes one `[숨김]`.
// 3. Free text (a bare known key, no quotes around): only a value that passes `credentialLike` is hidden — on any
//    layer, mapped back to layer 0 ("password: 다음에…", "password=process.env.PASSWORD" stay).
//
// The earliest hiding position over all layers wins. Linear: each layer is a few passes; quotes pair up through
// one precomputed "next unescaped quote" array per character and names are read only when a separator follows,
// so names never overlap; bare keys and free-text values are read once.

/** Marks a placeholder written by pass A or B (see above). U+FDD0 is a noncharacter: never meaningful text. */
export const TAG = "﷐";
const TAG_CODE = 0xfdd0;
const TAGS = /﷐/g;

const JSON_ESCAPES: Record<string, string> = {
  '"': '"',
  "'": "'", // not JSON, but how Python-style strings in tool output escape their quote
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};
const isHex = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);

const NAMED: Record<string, string> = {
  "LOW LINE": "_",
  "HYPHEN-MINUS": "-",
  COLON: ":",
  "EQUALS SIGN": "=",
  "QUOTATION MARK": '"',
  APOSTROPHE: "'",
  SPACE: " ",
  "FULL STOP": ".",
  SOLIDUS: "/",
  "REVERSE SOLIDUS": "\\",
};
/** Longest `\N{…}` name looked at (Unicode names are at most 88 characters; anything longer is unknown). */
const NAME_MAX = 80;
const DIGIT_NAMES = ["ZERO", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE"];
/**
 * Python `\N{NAME}`: Latin letters, digits and the punctuation of keys decode; any other name is unknown (null) —
 * there is no Unicode name table here, and guessing could misread a key (KELVIN SIGN lowercases to `k`).
 */
function namedChar(name: string): string | null {
  const letter = /^LATIN (SMALL|CAPITAL) LETTER ([A-Z])$/.exec(name);
  if (letter) return letter[1] === "SMALL" ? letter[2]!.toLowerCase() : letter[2]!;
  const digit = /^DIGIT ([A-Z]+)$/.exec(name);
  if (digit && DIGIT_NAMES.includes(digit[1]!)) return String(DIGIT_NAMES.indexOf(digit[1]!));
  return NAMED[name] ?? null;
}

const hexRun = (s: string, i: number, count: number) => {
  for (let k = 0; k < count; k++) if (!isHex(s.charCodeAt(i + k))) return false;
  return true;
};
const fromCode = (code: number) =>
  // Only the raw tags passes A/B wrote may exist: a tag spelled as an escape decodes to U+FFFD.
  code === TAG_CODE || code > 0x10ffff ? "�" : String.fromCodePoint(code);

/**
 * The escape starting at the backslash `i`, decoded tolerantly — JSON's (`\" \\ \/ \b \f \n \r \t \uXXXX`) and
 * the ones Python's repr() and string literals use (`\' \xHH \UXXXXXXXX`, octal `\ooo`, `\a \v`, `\N{NAME}`) —
 * or null when there is none (it stays as written).
 */
/**
 * Escapes that mean the same in every major language (JSON, JavaScript, Python, Ruby, C-likes) — `\n \t \r \" \'
 * \\ \/`, `\xHH` with exactly two digits, `\uXXXX`, `\u{…}`, `\UXXXXXXXX`, a known `\N{…}` — decode plainly. Others
 * decode for matching but are `ambiguous`: octal above `\377` (Ruby keeps the low 8 bits), `\0` followed by a digit,
 * `\a \b \f \v` (`\a` is "a" in JavaScript), `\xHH` followed by more hex digits (C/C++ read them all), `\uu…XXXX`
 * (Java). A key holding an ambiguous, unknown or undecodable escape is unknown.
 */
function escapeAt(
  s: string,
  i: number,
): { decoded: string; length: number; unknown?: true; ambiguous?: true } | null {
  const e = s[i + 1];
  if (e === undefined) return null;
  if (e === "u" && s[i + 2] === "{") {
    // JavaScript `\u{…}`: 1–6 hex digits.
    const m = /^\{([0-9a-fA-F]{1,6})\}/.exec(s.slice(i + 2, i + 11));
    return m ? { decoded: fromCode(parseInt(m[1]!, 16)), length: 2 + m[0].length } : null;
  }
  if (e === "u" && hexRun(s, i + 2, 4))
    return { decoded: fromCode(parseInt(s.slice(i + 2, i + 6), 16)), length: 6 };
  if (e === "x" && hexRun(s, i + 2, 2)) {
    const decoded = fromCode(parseInt(s.slice(i + 2, i + 4), 16));
    // C and C++ read every hex digit that follows: `\x002d` is "-" there, NUL and "2d" elsewhere.
    return isHex(s.charCodeAt(i + 4)) ? { decoded, length: 4, ambiguous: true } : { decoded, length: 4 };
  }
  if (e === "u" && s[i + 2] === "u") {
    // Java allows any number of u's (`\uuuu0061`); elsewhere it is not an escape at all.
    let k = i + 2;
    while (s[k] === "u") k++;
    return hexRun(s, k, 4)
      ? { decoded: fromCode(parseInt(s.slice(k, k + 4), 16)), length: k + 4 - i, ambiguous: true }
      : null;
  }
  if (e === "U" && hexRun(s, i + 2, 8))
    return { decoded: fromCode(parseInt(s.slice(i + 2, i + 10), 16)), length: 10 };
  if (e >= "0" && e <= "7") {
    let k = i + 1;
    while (k < i + 4 && s[k]! >= "0" && s[k]! <= "7") k++;
    const value = parseInt(s.slice(i + 1, k), 8);
    const ambiguous = value > 0o377 || (e === "0" && k > i + 2);
    return ambiguous
      ? { decoded: fromCode(value), length: k - i, ambiguous: true }
      : { decoded: fromCode(value), length: k - i };
  }
  if (e === "N" && s[i + 2] === "{") {
    // The closing brace is looked for within the window only — never a scan of the rest of the input. No brace
    // there (a longer name, or `\N{` never closed): unknown as well, so fail-closed from here.
    const close = s.slice(i + 3, i + 4 + NAME_MAX).indexOf("}");
    if (close < 0) return { decoded: "\\N{", length: 3, unknown: true };
    const end = i + 3 + close;
    const decoded = namedChar(s.slice(i + 3, end).toUpperCase());
    // An unknown name stays as written and is reported: the sweep hides from it to the end (fail-closed).
    return decoded === null
      ? { decoded: s.slice(i, end + 1), length: end + 1 - i, unknown: true }
      : { decoded, length: end + 1 - i };
  }
  if (e === "a") return { decoded: "\x07", length: 2, ambiguous: true };
  if (e === "v") return { decoded: "\x0b", length: 2, ambiguous: true };
  const simple = JSON_ESCAPES[e];
  if (simple === undefined) return null;
  return e === "b" || e === "f"
    ? { decoded: simple, length: 2, ambiguous: true }
    : { decoded: simple, length: 2 };
}

/** Characters a key run (with escapes) may hold, as `escapeInKey` reads it. */
const KEY_RUN = /[\w$.\-\\{}]/;
/** The last run looked at: escapes come in order, so one run is read once, not once per escape in it (linear). */
let keyRun = { d: "", from: -1, end: -1 };
/** Where the run of key characters starting at `e` ends (at most 256 on from where the run was entered). */
function keyRunEnd(d: string, e: number): number {
  if (keyRun.d === d && e >= keyRun.from && e <= keyRun.end) return keyRun.end;
  let end = e;
  for (let k = 0; end < d.length && k < 256 && KEY_RUN.test(d[end]!); k++) end++;
  keyRun = { d, from: e, end };
  return end;
}

/**
 * Whether the escape at `u` is part of a key: after it (and its `{…}`), only more key characters, a closing quote
 * and a gap until a separator (`:`, `=`, `=>`, `:=`) — or a comment whose end cannot be found.
 */
function escapeInKey(d: string, u: number): boolean {
  let e = u + 2;
  if (d.charCodeAt(u + 2) === 123) {
    const close = d.slice(u + 3, u + 83).indexOf("}"); // within the name window only (linear)
    e = close >= 0 ? u + 3 + close + 1 : u + 3;
  }
  e = keyRunEnd(d, e);
  if (isQuoteChar(d.charCodeAt(e))) e++;
  if (e >= d.length) return false;
  const [g, , open] = gapEnd(d, e, false);
  return open || separatorAt(d, g) > 0;
}

/**
 * One layer of tolerant unescaping (see `escapeAt`). With `origin` (the layer-0 offset of every character of
 * `s`), also returns the layer-0 offset of every decoded character.
 */
function decodeLayer(
  s: string,
  origin: Int32Array | null,
): { text: string; origin: Int32Array | null; unknownAt: number } {
  // Layer-0 offset of the first escape we cannot decode for sure (an unknown \N{…}) inside a key — one followed by
  // a separator (round 28: anywhere else, like `print("\N{SNOWMAN}")`, it is text and nothing is hidden).
  let unknownAt = -1;
  const parts: string[] = [];
  const out = origin ? new Int32Array(s.length) : null;
  let n = 0;
  let from = 0;
  for (let i = 0; i < s.length;) {
    const esc = s.charCodeAt(i) === 92 ? escapeAt(s, i) : null;
    if (esc?.unknown) {
      if (unknownAt < 0 && escapeInKey(s, i)) unknownAt = origin ? origin[i]! : i;
    } else if (esc) {
      if (i > from) parts.push(s.slice(from, i));
      parts.push(esc.decoded);
      // An escape is never shorter than what it decodes to, so the offsets fit.
      if (out) for (let k = 0; k < esc.decoded.length; k++) out[n + k] = origin![i]!;
      n += esc.decoded.length;
      i += esc.length;
      from = i;
      continue;
    }
    if (out) out[n] = origin![i]!;
    n++;
    i++;
  }
  if (s.length > from) parts.push(s.slice(from));
  return { text: parts.join(""), origin: out ? out.subarray(0, n) : null, unknownAt };
}

/** Position of the first backslash in `s` that starts an escape the tolerant decoder would decode, or -1. */
function firstEscape(s: string): number {
  for (let i = s.indexOf("\\"); i >= 0; i = s.indexOf("\\", i + 1)) if (escapeAt(s, i)) return i;
  return -1;
}

/** Whitespace between a key and its separator, in any language: `\s`, `\p{Z}`, BOM, line separators. */
const GAP = /[\s\p{Z}\uFEFF]/u;
const isGap = (c: number) =>
  c === 32 ||
  c === 9 ||
  c === 10 ||
  c === 13 ||
  (c > 127 || c === 11 || c === 12 ? GAP.test(String.fromCharCode(c)) : false);
const isQuoteChar = (c: number) => c === 34 || c === 39 || c === 96;

/**
 * End of the gap at `k`: whitespace (see GAP) and line continuations (a backslash before a real line break);
 * with `quotes`, also quotes (`"` `'` `` ` ``) and backslashes — and whether a quote was among them.
 */
const COMMENT_MAX = 512;
/** YAML `''` merges read into one quoted key, at most (keys are short; a run of quotes stays linear). */
const YAML_MERGES = 8;
/** One plain string literal and nothing else (a computed key we can read). */
const SIMPLE_LITERAL = /^\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\$]|\\.|\$(?!\{))*`)\s*$/;
const STATEMENT_WORDS = new Set([
  "export",
  "declare",
  "local",
  "set",
  "readonly",
  "typeset",
  "let",
  "var",
  "const",
]);

/**
 * Where a key can start, for rule A on bare tokens: the start of the text or a line, after `{` `,` `;` `&` `?`, or
 * after a statement word (`export`, `declare`, `local`, `set`, `readonly`, …) — whitespace between allowed. Not
 * after `(` (a regex group or a call: `/(\d{2}:\d{2})/`), nor inside a path or a regex.
 */
function atKeyPosition(d: string, start: number): boolean {
  let b = start - 1;
  while (b >= 0 && isGap(d.charCodeAt(b)) && d.charCodeAt(b) !== 10 && d.charCodeAt(b) !== 13) b--;
  if (b < 0) return true;
  const c = d.charCodeAt(b);
  if (c === 10 || c === 13 || c === 123 || c === 44 || c === 59 || c === 38 || c === 63) return true;
  if (b === start - 1) return false; // no whitespace: not after a word
  let w = b;
  while (w >= 0 && w > b - 16 && /[a-z]/.test(d[w]!)) w--;
  return STATEMENT_WORDS.has(d.slice(w + 1, b + 1));
}

/** Identifier characters of a bare key, in any script. */
const IDENT = /^[\p{ID_Continue}$-]$/u;
/**
 * End of the gap at `k`: whitespace (see GAP), line continuations (a backslash before a real line break) and
 * comments (`/* … *\/`, `//…` and `#…` to the line end); with `quotes`, also quotes (`"` `'` `` ` ``) and
 * backslashes. Also whether a quote was among them. A comment runs to its real end, however long (round 24: a
 * long comment is no reason to hide anything — only a separator after it is); one never closed runs to the end
 * of the text. (`open` is kept for the callers; it is always false now.)
 */
function gapEnd(d: string, k: number, quotes: boolean): [end: number, quote: boolean, open: boolean] {
  let quote = false;
  for (;;) {
    const c = d.charCodeAt(k);
    if (k >= d.length) break;
    if (isGap(c)) k++;
    else if (c === 92 && (d.charCodeAt(k + 1) === 10 || d.charCodeAt(k + 1) === 13))
      k += d.charCodeAt(k + 1) === 13 && d.charCodeAt(k + 2) === 10 ? 3 : 2;
    else if (c === 47 && d.charCodeAt(k + 1) === 42) {
      // A /* comment */ (the search is memoised: the scans stay linear).
      const close = BLOCK_END.next(d, k + 2);
      if (close < 0) return [d.length, quote, false];
      k = close + 2;
    } else if ((c === 47 && d.charCodeAt(k + 1) === 47) || c === 35) {
      // A // or # comment, to the end of the line (LF, CR, NEL, U+2028, U+2029).
      const eol = LINE_END.next(d, k);
      if (eol < 0) return [d.length, quote, false];
      k = eol;
    } else if (quotes && isQuoteChar(c)) {
      quote = true;
      k++;
    } else if (quotes && c === 92) k++;
    else break;
  }
  return [k, quote, false];
}

/**
 * The next match at or after `from`, memoised on the last answer: queries that move forward reuse it (one scan of
 * the text per pass, however many comments start before the same end).
 */
class NextFinder {
  private d: string | undefined;
  private from = 0;
  private at = -1;
  constructor(private readonly find: (d: string, from: number) => number) {}
  next(d: string, from: number): number {
    if (this.d !== d || from < this.from || (this.at >= 0 && from > this.at)) {
      this.d = d;
      this.at = this.find(d, from);
    }
    this.from = from;
    return this.at;
  }
}
const BLOCK_END = new NextFinder((d, from) => d.indexOf("*/", from));
const LINE_END = new NextFinder((d, from) => {
  for (let k = from; k < d.length; k++) {
    const c = d.charCodeAt(k);
    if (c === 10 || c === 13 || c === 0x85 || c === 0x2028 || c === 0x2029) return k;
  }
  return -1;
});

/** A separator at `k` (`:`, `=`, `=>`, `:=`): its length, or 0. */
function separatorAt(d: string, k: number): number {
  const c = d.charCodeAt(k);
  if (c !== 58 && c !== 61) return 0;
  const c2 = d.charCodeAt(k + 1);
  return (c === 61 && c2 === 62) || (c === 58 && c2 === 61) ? 2 : 1;
}

/**
 * Reads a key token's text: escapes decoded where the decoder knows them; an escape it does not know (or cannot
 * decode for sure) makes the key unknown — it may spell anything.
 */
function readKey(raw: string): { name: string; unknown: boolean } {
  let name = "";
  let unknown = false;
  for (let i = 0; i < raw.length;) {
    if (raw.charCodeAt(i) !== 92) {
      name += raw[i]!;
      i++;
      continue;
    }
    const e = escapeAt(raw, i);
    if (!e || e.unknown) {
      unknown = true;
      name += raw[i]!;
      i++;
      continue;
    }
    if (e.ambiguous) unknown = true;
    name += e.decoded;
    i += e.length;
  }
  return { name, unknown };
}

/**
 * The first `=` in the body of a Bash `$'…'` string, written plainly or as an escape that decodes to it (`\x3d`,
 * `\075`, `\u003d`): its offset and length, or [-1, 0]. One pass over the body.
 */
function ansiCEquals(raw: string): [at: number, length: number] {
  for (let i = 0; i < raw.length;) {
    const c = raw.charCodeAt(i);
    if (c === 61) return [i, 1];
    if (c !== 92) {
      i++;
      continue;
    }
    const e = escapeAt(raw, i);
    if (e && !e.unknown && e.decoded === "=") return [i, e.length];
    i += e && !e.unknown ? e.length : 2;
  }
  return [-1, 0];
}

/**
 * Pass C on one layer `d` (with `origin`, the layer-0 offset of each character; `n0` the length of layer 0).
 * Returns the earliest layer-0 offset to hide from (or -1), and the free-text values to hide (layer-0 ranges).
 */
function scanLayer(d: string, origin: Int32Array, n0: number): { fire: number; ranges: [number, number][] } {
  const n = d.length;
  const at = (k: number) => (k < n ? origin[k]! : n0);
  let fire = -1;
  const ranges: [number, number][] = [];
  const hideFrom = (k: number) => {
    const f = at(k);
    if (fire < 0 || f < fire) fire = f;
  };
  /** After the separator ending at `afterSep`: the value starts with a pass A/B tag (already hidden)? */
  const tagged = (afterSep: number) => d.charCodeAt(gapEnd(d, afterSep, true)[0]) === TAG_CODE;

  // A. Quoted keys: `"…"`, `'…'`, `` `…` ``, each closed by the next unescaped quote of the same character.
  for (const quote of [34, 39, 96]) {
    const next = new Int32Array(n + 1).fill(-1);
    for (let k = n - 1; k >= 0; k--) {
      next[k] = next[k + 1]!;
      if (d.charCodeAt(k) === quote) {
        let b = k;
        while (b > 0 && d.charCodeAt(b - 1) === 92) b--;
        if ((k - b) % 2 === 0) next[k] = k;
      }
    }
    for (let open = next[0]!; open >= 0; open = next[open + 1]!) {
      let close = next[open + 1]!;
      if (close < 0) break;
      let raw = d.slice(open + 1, close);
      // YAML single-quoted style: `''` is one quote inside the string (`'pass''word': x` has the key pass'word).
      // A key is short: only so far (a run of quotes `''''…` was otherwise rejoined from every quote — quadratic).
      for (let merges = 0; quote === 39 && d.charCodeAt(close + 1) === 39; merges++) {
        const more = next[close + 2]!;
        if (more < 0 || merges >= YAML_MERGES || more - open > COMMENT_MAX) break;
        raw += "'" + d.slice(close + 2, more);
        close = more;
      }
      // Bash ANSI-C quoting, `$'…'`: the quotes hold the whole assignment (`export $'\560assword=x'`).
      // The `=` may itself be an escape there (`$'\560assword\x3dhunter2'`, `\075`, #98): Bash decodes it first.
      if (quote === 39 && d.charCodeAt(open - 1) === 36) {
        const [eq, eqLen] = ansiCEquals(raw);
        if (eq > 0) {
          const key = readKey(raw.slice(0, eq));
          const after = open + 1 + eq + eqLen;
          if ((key.unknown || isSecretKey(key.name)) && !tagged(after)) {
            hideFrom(after);
            break;
          }
        }
      }
      let [g, , unclosed] = gapEnd(d, close + 1, false);
      // A computed key: `["…"]:`, `` [`…`]: ``.
      if (!unclosed && d.charCodeAt(g) === 93) [g, , unclosed] = gapEnd(d, g + 1, false);
      const key = readKey(raw);
      // A template literal with `${…}` computes its text: unknown.
      if (quote === 96 && raw.includes("${")) key.unknown = true;
      // A plain string that is not a secret's name is no key to worry about, whatever follows it (round 23:
      // `console.log("hello" /* long comment */, "done")` stays as it is).
      if (!key.unknown && !isSecretKey(key.name)) continue;
      if (unclosed) {
        // A comment whose end we cannot find after a key: what follows it cannot be known. Fail closed.
        hideFrom(g);
        break;
      }
      const sep = separatorAt(d, g);
      if (!sep) continue;
      if (tagged(g + sep)) continue;
      hideFrom(g + sep);
      break; // later keys of this pass start further on
    }
  }

  // C. Computed keys `[…]:` where a key starts — after `{` or `,` (comments between allowed, `/* … */` or a `//`
  // line comment), directly inside an object literal's braces: anything but one plain string literal inside the
  // brackets (`[("a")]`, `["pa" + "ss"]`, `` [`a${b}`] ``) computes the key — unknown, so fail closed. Not in a
  // regex character class (`/a,[b]:c/`) or a Markdown link definition (`[guide]: https://…`): no object brace is
  // open there. Brackets are matched with a stack, twice: once over every character, and once skipping short
  // one-line string literals inside a candidate key's brackets (a `[` or `]` inside `["pa[ss" + "word"]` must not
  // break the pairing, #98; only there — outside, a quote may be a wrapping layer's or an apostrophe). Each pass is
  // one walk, so no `[` is ever scanned twice by a pass.
  // (The second walk only when the first met a quote inside such brackets.)
  let quoteInKey = false;
  for (const skipStrings of [false, true]) {
    if (skipStrings && !quoteInKey) break;
    const stack: { c: number; at: number; inObject: boolean }[] = [];
    let inKey = 0; // candidate key brackets open on the stack
    for (let k = 0; k < n; k++) {
      const c = d.charCodeAt(k);
      if (inKey > 0 && isQuoteChar(c)) {
        quoteInKey = true;
        if (!skipStrings) continue;
        const end = shortLiteralEnd(d, k);
        if (end > k) k = end;
        continue;
      }
      if (c === 123 || c === 40 || c === 91) {
        const inObject = stack.at(-1)?.c === 123;
        if (c === 91 && inObject) inKey++;
        stack.push({ c, at: k, inObject });
        continue;
      }
      if (c !== 125 && c !== 41 && c !== 93) continue;
      const want = c === 125 ? 123 : c === 41 ? 40 : 91;
      if (stack.at(-1)?.c !== want) continue; // unbalanced: ignored
      const top = stack.pop()!;
      if (c === 93) {
        const open = top.at;
        if (!top.inObject) continue;
        inKey--;
        const b = gapBefore(d, open - 1);
        const before = b < 0 ? -1 : d.charCodeAt(b);
        if (before !== 123 && before !== 44) continue;
        // One plain string literal: the quoted pass reads it (only short contents are looked at).
        if (k - open <= COMMENT_MAX && SIMPLE_LITERAL.test(d.slice(open + 1, k))) continue;
        const [g, , unclosed] = gapEnd(d, k + 1, false);
        if (unclosed) {
          hideFrom(g);
          continue;
        }
        const sep = separatorAt(d, g);
        if (!sep || tagged(g + sep)) continue;
        hideFrom(g + sep);
      }
    }
  }

  // B. Bare keys: a run of identifier characters (any script), `.`, and escapes — known ones joined in decoded
  // (also when they decode to something else, like `\u002e` or `\n`), ones the decoder does not know or that
  // differ between languages make the key unknown — and line continuations inside the key.
  for (let i = 0; i < n && (fire < 0 || at(i) < fire);) {
    let name = "";
    let unknown = false;
    let j = i;
    while (j < n) {
      const c = d.charCodeAt(j);
      if (
        (c >= 48 && c <= 57) ||
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) ||
        c === 95 ||
        c === 45 ||
        c === 36 ||
        c === 46 ||
        // HTTP field names and INI/properties keys take these too (`pass!word: x`, `pass/word=x`).
        (j > i && (c === 33 || (c === 47 && d.charCodeAt(j + 1) !== 47 && d.charCodeAt(j + 1) !== 42)))
      ) {
        name += d[j]!;
        j++;
        continue;
      }
      // A percent-encoded character of a URL query name (`?%70assword=x` is "password"): decoded, joined.
      if (c === 37 && isHexCode(d.charCodeAt(j + 1)) && isHexCode(d.charCodeAt(j + 2))) {
        const ch = String.fromCharCode(parseInt(d.slice(j + 1, j + 3), 16));
        if (/[\s"'`:=&?#;,]/.test(ch)) break;
        name += ch;
        j += 3;
        continue;
      }
      // Shell quoting inside a word (`pass'word'=x`, `pass""word=x`): the quoted letters are part of the name.
      if (j > i && (c === 39 || c === 34)) {
        const rel = d.slice(j + 1, j + 66).indexOf(d[j]!);
        const close = rel < 0 ? -1 : j + 1 + rel;
        const inner = close > 0 ? d.slice(j + 1, close) : undefined;
        if (inner === undefined || !/^[A-Za-z0-9_]*$/.test(inner)) break;
        name += inner;
        j = close + 1;
        continue;
      }
      if (c > 127 && c !== TAG_CODE) {
        // Non-ASCII identifier characters (ID_Continue: 한, KELVIN SIGN …), whole code points.
        const cp = String.fromCodePoint(d.codePointAt(j)!);
        if (!IDENT.test(cp)) break;
        name += cp;
        j += cp.length;
        continue;
      }
      if (c !== 92) break;
      const next = d.charCodeAt(j + 1);
      if (next === 10 || next === 13) {
        // A line continuation inside the key (`pass\⏎word`): joined.
        j += next === 13 && d.charCodeAt(j + 2) === 10 ? 3 : 2;
        continue;
      }
      if (next === 32 && j > i) {
        // An escaped space inside a properties key (`pass\ word=x` is "pass word").
        name += " ";
        j += 2;
        continue;
      }
      if (j + 1 >= n || isGap(next) || isQuoteChar(next) || next === 92) break;
      const e = escapeAt(d, j);
      if (e && !e.unknown && !e.ambiguous) {
        // A quote or a separator ends the key (it is structure one layer down); anything else is joined in.
        if (/["'`:=]/.test(e.decoded)) break;
        name += e.decoded;
        j += e.length;
      } else {
        // An escape the decoder does not know: the key is unknown. Its body goes with it — the letter after the
        // backslash and a `{…}` right after that (`\u{61 73 73}`), so spaces or braces in it do not end the key.
        // The name keeps the escape as written (a language that leaves `\p` alone has the key `\password`,
        // judged as "password" once the punctuation is dropped).
        unknown = true;
        const start = j;
        if (e) j += e.length;
        else {
          j += 2;
          if (d.charCodeAt(j) === 123) {
            const close = d.slice(j, j + 82).indexOf("}");
            if (close > 0) j += close + 1;
          }
        }
        name += d.slice(start, j);
      }
    }
    if (j === i) {
      i++;
      continue;
    }
    const i0 = i;
    i = j;
    const [g, quoteBefore, unclosed] = gapEnd(d, j, true);
    if (unclosed && ((unknown && atKeyPosition(d, i0)) || isSecretKey(name))) {
      // A comment whose end we cannot find after a key: fail closed.
      hideFrom(g);
      break;
    }
    const sep = separatorAt(d, g);
    if (!sep) {
      // Java properties also separate key and value by whitespace alone (`password hunter2`): only a whole line
      // of exactly that, with a secret's name and a clear credential as the value.
      if (
        !unknown &&
        isSecretKey(name) &&
        lineStart(d, i0) &&
        (d.charCodeAt(j) === 32 || d.charCodeAt(j) === 9)
      ) {
        let p = j;
        while (d.charCodeAt(p) === 32 || d.charCodeAt(p) === 9) p++;
        let end = p;
        while (
          end < n &&
          !isGap(d.charCodeAt(end)) &&
          !isQuoteChar(d.charCodeAt(end)) &&
          d.charCodeAt(end) !== 92
        )
          end++;
        let after = end;
        while (d.charCodeAt(after) === 32 || d.charCodeAt(after) === 9) after++;
        // The line (or the string holding it: `"password hunter2"`, `…\npassword hunter2\n…`) ends there.
        const ca = d.charCodeAt(after);
        const eol =
          after >= n ||
          ca === 10 ||
          ca === 13 ||
          isQuoteChar(ca) ||
          (ca === 92 && /[nr"'\\]/.test(d[after + 1] ?? ""));
        if (eol && end > p && credentialLike(d.slice(p, end))) {
          ranges.push([at(p), at(end)]);
          i = Math.max(i, end);
        }
      }
      continue;
    }
    // Rule A (an unknown key fails closed) applies to a bare token only where a key can start: at the start of
    // the text or a line, or after `{`, `,`, `(` (whitespace between allowed) — not inside a regex or a path
    // (`/\d{2}:\d{2}/`, `\\?\C:\Users`).
    if (unknown && !atKeyPosition(d, i0)) unknown = false;
    if (!unknown && !isSecretKey(name)) continue;
    const afterSep = g + sep;
    const [p, quoteAfter] = gapEnd(d, afterSep, true);
    if (d.charCodeAt(p) === TAG_CODE) continue;
    if (unknown || quoteBefore || quoteAfter) {
      hideFrom(afterSep);
      break;
    }
    // Free text: only a value that is clearly a credential.
    let end = p;
    while (end < n) {
      const c = d.charCodeAt(end);
      if (
        isGap(c) ||
        isQuoteChar(c) ||
        c === 92 ||
        c === 44 ||
        c === 59 ||
        c === 38 ||
        c === 125 ||
        c === 93 ||
        c === 41
      )
        break;
      end++;
    }
    if (end > p && credentialLike(d.slice(p, end))) ranges.push([at(p), at(end)]);
    i = Math.max(i, end);
  }
  return { fire, ranges };
}

const isHexCode = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);

/**
 * `k` starts a line: only spaces or tabs before it on its line, or the start of the text — also inside a string
 * (an opening quote, or an escaped line break `\n` of a stringified document, right before it).
 */
function lineStart(d: string, k: number): boolean {
  let b = k - 1;
  while (b >= 0 && (d.charCodeAt(b) === 32 || d.charCodeAt(b) === 9)) b--;
  if (b < 0 || d.charCodeAt(b) === 10 || d.charCodeAt(b) === 13) return true;
  if ((d.charCodeAt(b) === 110 || d.charCodeAt(b) === 114) && d.charCodeAt(b - 1) === 92) return true;
  if (!isQuoteChar(d.charCodeAt(b))) return false;
  const stop = b - 16;
  while (b >= 0 && b > stop && (isQuoteChar(d.charCodeAt(b)) || d.charCodeAt(b) === 92)) b--;
  return (
    b < 0 ||
    isGap(d.charCodeAt(b)) ||
    d.charCodeAt(b) === 58 ||
    d.charCodeAt(b) === 91 ||
    d.charCodeAt(b) === 44
  );
}

/**
 * The last non-gap character at or before `b`, stepping back over whitespace, `/* … *\/` comments and `//` line
 * comments (#98: `{a: 1, // note⏎["pass" + "word"]: x}`). A line comment is only looked for on a line the step
 * back crossed into, and only one that follows a `{` or `,` (or fills its line): a `//` in a string such as
 * `"https://…"` is not taken for one.
 */
function gapBefore(d: string, b: number): number {
  // A few comments at most (keeps the scan linear); more than that and the bracket is not taken for a key.
  for (let comments = 0; comments < 4; comments++) {
    let crossed = false;
    while (b >= 0 && isGap(d.charCodeAt(b))) {
      if (isLineBreak(d.charCodeAt(b))) crossed = true;
      b--;
    }
    if (b >= 1 && d.charCodeAt(b) === 47 && d.charCodeAt(b - 1) === 42) {
      const from = Math.max(0, b - 1 - COMMENT_MAX);
      const open = d.slice(from, b - 1).lastIndexOf("/*");
      if (open < 0) return b;
      b = from + open - 1;
      continue;
    }
    if (!crossed || b < 0) return b;
    // The line holding `b` (its last COMMENT_MAX characters): a `//` after `{`, `,` or nothing ends it.
    let ls = b;
    while (ls > 0 && ls > b - COMMENT_MAX && !isLineBreak(d.charCodeAt(ls - 1))) ls--;
    let found = -2;
    // Searched within that line only (at most COMMENT_MAX characters): never the rest of the input (linear).
    const line = d.slice(ls, b);
    for (let r = line.indexOf("//"); r >= 0; r = line.indexOf("//", r + 1)) {
      const c = ls + r;
      let p = c - 1;
      while (p >= ls && isGap(d.charCodeAt(p))) p--;
      const pc = p >= ls ? d.charCodeAt(p) : -1;
      if (pc === 123 || pc === 44) return p;
      if (pc === -1) {
        found = p; // a line that is only a comment: keep stepping back
        break;
      }
    }
    if (found === -2) return b;
    b = found;
  }
  return -1;
}

const isLineBreak = (c: number) => c === 10 || c === 13 || c === 0x85 || c === 0x2028 || c === 0x2029;

/**
 * End (the closing quote) of the one-line string literal whose opening quote is at `k`, at most COMMENT_MAX
 * characters on — or -1 when the quote is escaped, or no unescaped closing quote of the same character comes
 * before the line ends. Linear over a walk: a quote that finds no end scanned only a window holding no other
 * opening quote of its kind.
 */
function shortLiteralEnd(d: string, k: number): number {
  const q = d.charCodeAt(k);
  let b = k;
  while (b > 0 && d.charCodeAt(b - 1) === 92) b--;
  if ((k - b) % 2 === 1) return -1;
  const stop = Math.min(d.length, k + 1 + COMMENT_MAX);
  for (let p = k + 1; p < stop; p++) {
    const c = d.charCodeAt(p);
    if (c === q) return p;
    if (isLineBreak(c)) return -1;
    if (c === 92) p++;
  }
  return -1;
}

/** Decoded layers pass C looks at (layer 0 is the text itself); deeper wrapping is hidden, fail-closed. */
const MAX_LAYERS = 8;

export function sweepSecrets(s: string): string {
  const n = s.length;
  let fire = -1;
  const ranges: [number, number][] = [];
  const hideFrom = (f: number) => {
    if (f >= 0 && (fire < 0 || f < fire)) fire = f;
  };
  let layer = s;
  let origin: Int32Array = Int32Array.from({ length: n }, (_, k) => k);
  for (let k = 0; ; k++) {
    const found = scanLayer(layer, origin, n);
    hideFrom(found.fire);
    for (const r of found.ranges) ranges.push(r); // (no spread: a huge array would overflow the call stack)
    if (!layer.includes("\\")) break;
    if (k === MAX_LAYERS) {
      // Fail closed: content wrapped deeper than we decode is never trusted. Any backslash that still starts an
      // escape on the last layer (it would decode further) hides everything from there to the end of the input.
      // (A backslash that starts no escape — `C:\Users`, a regex `\d` — decodes to itself on every layer: it is
      // text, not wrapping.)
      const at = firstEscape(layer);
      if (at >= 0) hideFrom(origin[at]!);
      break;
    }
    const next = decodeLayer(layer, origin);
    // An escape we cannot decode for sure (an unknown \N{…} name) could be part of a key: fail closed from it.
    hideFrom(next.unknownAt);
    if (next.text === layer) break;
    layer = next.text;
    origin = next.origin!;
  }
  // Free-text values (any layer, mapped to layer 0) before the fail-closed point; then the rest is hidden.
  const limit = fire < 0 ? n : fire;
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = "";
  let from = 0;
  for (const [a, b] of ranges) {
    if (a >= limit) break;
    if (a < from) {
      from = Math.max(from, Math.min(b, limit));
      continue;
    }
    out += s.slice(from, a) + REDACTED;
    from = Math.min(b, limit);
  }
  if (fire >= 0) return out + s.slice(from, Math.max(from, fire)) + REDACTED;
  return from === 0 && !out ? s : out + s.slice(from);
}

function redactText(raw: string, level = 0, sweep = true): string {
  // Nothing in the input may look like a pass A/B tag (rule 3 of the sweep).
  const s = raw.includes(TAG) ? raw.replace(TAGS, "�") : raw;
  // JSON anywhere in the text (a whole document, or printed into a log line): secret fields by structure, the
  // values spliced out in place — nothing is re-serialised, so all other text and numbers stay byte-identical.
  // A string that itself holds JSON (`"{\"password\":…}"`) is redacted one level deeper and only that literal
  // is rewritten. Placeholders written here carry the tag until the top level is done.
  const inner = level < MAX_NESTED ? (content: string) => redactText(content, level + 1, false) : null;
  const placeholder = `"${TAG}${REDACTED}"`;
  // Pass A (JSON structure in the raw text), then pass B (JSON-stringified values in what is left): the union.
  // A value cut off part-way gets the untagged placeholder: the sweep (C) then still fires on its key.
  const a = structureEdits(s, isSecretKey, inner, `"${REDACTED}`);
  let out = applyEdits(s, a.edits, placeholder);
  if (inner)
    out = applyEdits(out, literalEdits(out, mapRegions(a.regions, a.edits, placeholder), inner), placeholder);
  out = redactPem(out);
  for (const re of FORMATS) out = out.replace(re, REDACTED);
  out = out.replace(AUTH_SCHEME, (whole, scheme: string, _sp: string, token: string) =>
    credentialLike(token) ? REDACTED : whole,
  );
  out = out.replace(
    ASSIGNMENT,
    (whole, key: string, sep: string, dq?: string, sq?: string, bare?: string) => {
      const value = dq ?? sq ?? bare ?? "";
      if (!isSecretKey(key) || !credentialLike(value)) return whole;
      return `${key}${sep}${REDACTED}`;
    },
  );
  if (level > 0) return out; // tags stay until the top level has swept
  // Pass C, last and only once (at the top level, over everything): the fail-closed sweep. Then the tags go.
  return (sweep ? sweepSecrets(out) : out).replace(TAGS, "");
}

export function redactString(s: string): string {
  return redactText(s);
}
/** True when the string carries a credential. */
export const looksSecret = (v: string) => redactString(v) !== v;

function redactValue(value: unknown, depth: number, sweep: boolean): unknown {
  if (typeof value === "string") return redactText(value, 0, sweep);
  if (value === null || typeof value !== "object") return value;
  if (depth > 20) return REDACTED; // pathological nesting: show nothing rather than walk forever
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1, sweep));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Whatever the type: a numeric OTP or PIN is as secret as a string one. Only an absent value stays.
    out[k] = isSecretKey(k) && v !== null && v !== undefined ? REDACTED : redactValue(v, depth + 1, sweep);
  }
  return out;
}

/** Storage and streaming (server): all passes, A, B, free-text rules and the fail-closed sweep C. */
export function redactSecrets(value: unknown): unknown {
  return redactValue(value, 0, true);
}

/**
 * Display (web): the same without pass C. What the browser shows was already redacted by the server, and the
 * position tags that tell C which values A/B hid are gone by then — C would take every `[숨김]` the server
 * wrote for an unhidden value and wipe the rest of the text. A, B and the free-text rules still run as a
 * second line of defence.
 */
export function redactForDisplay(value: unknown): unknown {
  return redactValue(value, 0, false);
}
