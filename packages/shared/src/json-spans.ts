/**
 * Finds the values of secret fields in JSON that sits anywhere inside a string — a whole JSON document, or
 * JSON printed into a log line (`stdout: {"password":\n "hunter2"}`) — and returns their character spans, so
 * the caller can splice a placeholder in without ever re-serialising (every other byte, including number
 * lexemes such as 9007199254740993, stays exactly as it was).
 *
 * Linear: every `{` / `[` is a candidate start, tokenised with an explicit stack (strings with escapes, numbers
 * as raw lexemes, literals, structure, any whitespace). When a candidate fails part-way, the spans of the
 * complete pairs found so far are kept — and a secret value that was cut off is hidden up to where it stopped —
 * and scanning resumes where the failure happened, so no region is scanned twice.
 */
export type Span = [start: number, end: number];
/**
 * A planned change: the secret placeholder over a secret value (`hide`; `text: null` when the whole, well-formed
 * value was found — the caller's tagged placeholder — or the caller's untagged one when it was cut off), or a
 * rewritten string literal.
 */
export type Edit = { start: number; end: number; text: string | null; hide?: boolean };

/**
 * Decodes the content of a JSON string literal (between the quotes): \" \\ \/ \b \f \n \r \t and \uXXXX
 * (UTF-16 units, so surrogate pairs come out as one character). An invalid escape is kept as written.
 */
const ESCAPES: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};
export function decodeJsonString(raw: string): string {
  if (!raw.includes("\\")) return raw;
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c !== "\\" || i + 1 >= raw.length) {
      out += c;
      continue;
    }
    const e = raw[++i]!;
    if (e === "u" && /^[0-9a-fA-F]{4}$/.test(raw.slice(i + 1, i + 5))) {
      out += String.fromCharCode(parseInt(raw.slice(i + 1, i + 5), 16));
      i += 4;
    } else out += ESCAPES[e] ?? `\\${e}`;
  }
  return out;
}

const MAX_DEPTH = 10_000;

const isWs = (c: number) => c === 32 || c === 9 || c === 10 || c === 13;

/** End of the JSON string starting at `i` (on its opening quote), or `-(stop + 1)` where it went wrong. */
function scanString(s: string, i: number, limit = s.length): number {
  for (let j = i + 1; j < limit; j++) {
    const c = s.charCodeAt(j);
    if (c === 34) return j + 1; // "
    if (c === 92) {
      j++; // escape: skip the next character (a \u escape's hex digits are ordinary characters)
      if (j >= limit) return -(limit + 1);
    } else if (c < 32) return -(j + 1); // raw control character: not JSON
  }
  return -(limit + 1);
}

/** End of a number / true / false / null at `i`, or -1. Numbers follow the JSON grammar. */
function scanScalar(s: string, i: number): number {
  const end = scalarEnd(s, i);
  // A token must end at a JSON token boundary: `123hunter2`, `truehunter2`, `1e+x` are broken, not `123`, `true`.
  if (end < 0) return -1;
  const c = s.charCodeAt(end);
  return end >= s.length || c === 32 || c === 9 || c === 10 || c === 13 || c === 44 || c === 125 || c === 93
    ? end
    : -1;
}

function scalarEnd(s: string, i: number): number {
  for (const lit of ["true", "false", "null"]) if (s.startsWith(lit, i)) return i + lit.length;
  let j = i;
  const digit = (k: number) => {
    const c = s.charCodeAt(k);
    return c >= 48 && c <= 57;
  };
  if (s[j] === "-") j++;
  if (s[j] === "0") j++;
  else if (digit(j)) while (digit(j)) j++;
  else return -1;
  if (s[j] === "." && digit(j + 1)) {
    j++;
    while (digit(j)) j++;
  }
  if (
    (s[j] === "e" || s[j] === "E") &&
    (digit(j + 1) || ((s[j + 1] === "+" || s[j + 1] === "-") && digit(j + 2)))
  ) {
    j += 2;
    while (digit(j)) j++;
  }
  return j;
}

// The container stack, reused across calls (one scan at a time; JavaScript is single-threaded here).
const OBJ = new Uint8Array(MAX_DEPTH); // 1 = object, 0 = array
const SECRET_AT = new Int32Array(MAX_DEPTH); // start of the container when it is a secret field's value, else -1
// obj: KEY (a key, or `}` when FIRST), COLON, NEXT (`,` or close); array: VALUE (or `]` when FIRST), NEXT
const STATE = new Uint8Array(MAX_DEPTH);
const FIRST = new Uint8Array(MAX_DEPTH);
const KEY_SECRET = new Uint8Array(MAX_DEPTH);
const KEY = 0;
const COLON = 1;
const NEXT = 2;
const VALUE = 3;

/** Collected during one scan. `strings`: non-secret string values that may hold JSON (looked at afterwards). */
/** A string literal to look inside later; `partial`: cut off (no closing quote), `end` is where it stopped. */
type Str = { start: number; end: number; partial: boolean };
type Found = { spans: Span[]; partial: Span[]; strings: Str[] };

/**
 * A string literal from the quote at `i`: where it ends (after its closing quote, or where it stopped — the end
 * of the input or a raw line break — when cut off), and whether it holds an escaped quote.
 */
function scanLiteral(s: string, i: number): { end: number; partial: boolean; escaped: boolean } {
  let escaped = false;
  for (let j = i + 1; j < s.length; j++) {
    const c = s.charCodeAt(j);
    if (c === 34) return { end: j + 1, partial: false, escaped };
    if (c === 92) {
      // An escaped quote (\" or \u0022) is the evidence of a JSON-stringified value.
      const e = s.charCodeAt(j + 1);
      if (e === 34 || (e === 117 && s.startsWith("0022", j + 2))) escaped = true;
      j++;
    } else if (c < 32) return { end: j, partial: true, escaped };
  }
  return { end: s.length, partial: true, escaped };
}

/** A secret value cut off by a failure: hidden as far as it goes, but not marked as completely hidden. */
function failAt(out: Span[], openSecret: number, at: number): number {
  if (openSecret >= 0) out.push([openSecret, Math.max(at, openSecret + 1)]);
  return at;
}

/**
 * Scans one candidate starting at `p` (a `{` or `[`). Adds spans to `out`; returns where scanning stopped
 * (the end of the JSON value, or the failure point).
 */
function scanCandidate(s: string, p: number, isSecretKey: (k: string) => boolean, found: Found): number {
  const out = found.spans;
  let depth = 0;
  let i = p;
  let expectValue = true;
  let valueSecret = false;
  /** Outermost open container that is a secret value: hidden up to where scanning stopped. */
  let openSecret = -1;
  for (;;) {
    while (i < s.length && isWs(s.charCodeAt(i))) i++;
    if (i >= s.length) return failAt(found.partial, openSecret, i);
    const c = s.charCodeAt(i);
    if (expectValue) {
      expectValue = false;
      const start = i;
      if (c === 123 || c === 91) {
        if (depth >= MAX_DEPTH) return failAt(found.partial, openSecret, i);
        OBJ[depth] = c === 123 ? 1 : 0;
        SECRET_AT[depth] = valueSecret ? start : -1;
        if (valueSecret && openSecret < 0) openSecret = start;
        STATE[depth] = c === 123 ? KEY : VALUE;
        FIRST[depth] = 1;
        KEY_SECRET[depth] = 0;
        depth++;
        i++;
        continue;
      }
      let end: number;
      if (c === 34) {
        end = scanString(s, i);
        if (end < 0) {
          // Cut off: a secret value is hidden as far as it goes; any other is looked inside like a whole one.
          if (valueSecret) found.partial.push([start, -end - 1]);
          else found.strings.push({ start, end: -end - 1, partial: true });
          return failAt(found.partial, openSecret, -end - 1);
        }
      } else {
        end = scanScalar(s, i);
        if (end < 0) {
          // A broken value under a secret key: hidden as far as we can tell, but not marked complete — the sweep
          // then hides the rest.
          if (valueSecret) found.partial.push([start, start + 1]);
          return failAt(found.partial, openSecret, i);
        }
      }
      if (valueSecret) out.push([start, end]);
      else if (c === 34) found.strings.push({ start, end, partial: false });
      i = end;
      continue;
    }
    const top = depth - 1;
    const obj = OBJ[top] === 1;
    const state = STATE[top];
    if (c === (obj ? 125 : 93) && (state === NEXT || FIRST[top] === 1)) {
      depth--;
      i++;
      const at = SECRET_AT[top]!;
      if (at >= 0) {
        out.push([at, i]);
        if (at === openSecret) openSecret = -1;
      }
      if (depth === 0) return i;
      continue;
    }
    if (obj) {
      if (state === KEY) {
        if (c !== 34) return failAt(found.partial, openSecret, i);
        const end = scanString(s, i);
        if (end < 0) return failAt(found.partial, openSecret, -end - 1);
        // Judged by the decoded name: "pass\u0077ord" is "password".
        KEY_SECRET[top] = isSecretKey(decodeJsonString(s.slice(i + 1, end - 1))) ? 1 : 0;
        STATE[top] = COLON;
        FIRST[top] = 0;
        i = end;
      } else if (state === COLON) {
        if (c !== 58) return failAt(found.partial, openSecret, i);
        i++;
        STATE[top] = NEXT;
        expectValue = true;
        valueSecret = KEY_SECRET[top] === 1;
      } else {
        if (c !== 44) return failAt(found.partial, openSecret, i);
        i++;
        STATE[top] = KEY;
      }
    } else if (state === VALUE) {
      STATE[top] = NEXT;
      FIRST[top] = 0;
      expectValue = true;
      valueSecret = false;
    } else {
      if (c !== 44) return failAt(found.partial, openSecret, i);
      i++;
      STATE[top] = VALUE;
      FIRST[top] = 0;
    }
  }
}

/**
 * May the decoded content of a string hold JSON with keys worth a look? It needs a `{` / `[` and a quote (a
 * key), both possibly written as \u escapes. Credentials without JSON structure are already visible to the
 * free-text rules in the raw literal, so nothing else needs opening.
 */
const mayHoldJson = (raw: string) =>
  (raw.includes("{") || raw.includes("[") || raw.includes("\\u")) &&
  (raw.includes('\\"') || raw.includes("\\u"));

/**
 * Secrets are found by two independent passes and the union is kept — a wrong guess in one pass can never hide
 * what the other finds (reviews #78 rounds 5–7):
 *
 * - **Pass A, structure** (`structureEdits`, on the raw text): every plausible `{` / `[` is scanned as JSON once;
 *   the region it covers (complete or not) is never a candidate start again. Secret values get the placeholder;
 *   string values inside the JSON whose content holds JSON are opened one level deeper.
 * - **Pass B, stringified values** (`literalEdits`, on the text after pass A): in the free text outside pass A's
 *   regions, each `"{` / `"[` whose span up to its closing quote holds an escaped quote is a JSON-stringified
 *   value printed into text. It is consumed whole (to its closing quote, or — cut off — to the end of the input
 *   or a raw line break) and opened one level deeper; candidates never overlap. Candidates starting inside a pass A
 *   region are left to pass A (string values there are opened by it).
 *
 * Each pass is linear, and inner levels only see the content of literals found above them: at most
 * 2 × levels × input size in total.
 */
export function structureEdits(
  s: string,
  isSecretKey: (k: string) => boolean,
  inner: ((content: string) => string) | null,
  /** Placeholder for a secret value that was cut off (no closing quote, a broken container). */
  partialText: string,
): { edits: Edit[]; regions: Span[] } {
  const found: Found = { spans: [], partial: [], strings: [] };
  const regions: Span[] = [];
  let i = 0;
  while (i < s.length) {
    const ch = s.charCodeAt(i);
    if (ch !== 123 && ch !== 91) {
      i++;
      continue;
    }
    const p = i;
    // Cheap first look: `{` must be followed by a key or `}`, `[` by a value or `]` — prose braces stop here.
    let q = p + 1;
    while (q < s.length && isWs(s.charCodeAt(q))) q++;
    const next = s.charCodeAt(q);
    const plausible =
      ch === 123
        ? next === 34 || next === 125 // " }
        : next === 34 ||
          next === 123 ||
          next === 91 ||
          next === 93 ||
          next === 45 ||
          (next >= 48 && next <= 57) ||
          next === 116 ||
          next === 102 ||
          next === 110; // " { [ ] - digit t f n
    if (!plausible) {
      i = q > p + 1 ? q : p + 1;
      continue;
    }
    // Never rescan a region already scanned as part of a candidate.
    const stop = Math.max(scanCandidate(s, p, isSecretKey, found), p + 1);
    regions.push([p, stop]);
    i = stop;
  }
  const edits: Edit[] = [
    ...found.spans.map(([start, end]): Edit => ({ start, end, text: null, hide: true })),
    ...found.partial.map(([start, end]): Edit => ({ start, end, text: partialText, hide: true })),
  ];
  if (inner)
    for (const str of found.strings) {
      const text = edited(s, str, inner);
      if (text !== null) edits.push({ start: str.start, end: str.end, text });
    }
  return { edits: normalise(edits), regions };
}

/** Pass B: JSON-stringified values (`"{\"…` / `"[\"…`) in the free text outside `regions`. */
export function literalEdits(s: string, regions: Span[], inner: (content: string) => string): Edit[] {
  const edits: Edit[] = [];
  let r = 0;
  let i = 0;
  while (i < s.length) {
    while (r < regions.length && regions[r]![1] <= i) r++;
    const region = regions[r];
    if (region && region[0] <= i) {
      i = region[1];
      continue;
    }
    const n1 = s.charCodeAt(i + 1);
    if (s.charCodeAt(i) !== 34 || (n1 !== 123 && n1 !== 91)) {
      i++;
      continue;
    }
    // The literal may run on into a region of pass A (what looked like JSON there was really inside this
    // string): pass A's edits are already in the text, and `[숨김]` survives decoding and re-encoding.
    const lit = scanLiteral(s, i);
    if (!lit.escaped) {
      // Not a stringified value: read on after the quote. Its span holds no other quote (an escaped one would
      // have been evidence), so the next candidate starts at or after its end — checks never overlap.
      i++;
      continue;
    }
    const text = edited(s, { start: i, end: lit.end, partial: lit.partial }, inner);
    if (text !== null) edits.push({ start: i, end: lit.end, text });
    i = Math.max(lit.end, i + 1);
  }
  return edits;
}

/** Where `regions` of the text before `edits` (sorted, each edit inside or outside a region) are afterwards. */
export function mapRegions(regions: Span[], edits: Edit[], placeholder: string): Span[] {
  const out: Span[] = [];
  let e = 0;
  let shift = 0;
  const advance = (pos: number) => {
    while (e < edits.length && edits[e]!.end <= pos) {
      const ed = edits[e]!;
      shift += (ed.text ?? placeholder).length - (ed.end - ed.start);
      e++;
    }
    return pos + shift;
  };
  for (const [a, b] of regions) {
    const start = advance(a);
    out.push([start, advance(b)]);
  }
  return out;
}

/** Sorted, not overlapping: secret spans win over anything inside them. */
function normalise(edits: Edit[]): Edit[] {
  edits.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Edit[] = [];
  for (const ed of edits) {
    const last = out.at(-1);
    if (last && ed.start < last.end) {
      if (last.hide) {
        last.end = Math.max(last.end, ed.end);
        // Cut off anywhere means not completely hidden.
        if (ed.hide && ed.text !== null && last.text === null) last.text = ed.text;
      }
    } else out.push({ ...ed });
  }
  return out;
}

/**
 * The rewritten literal when redacting the string's decoded content changes it, else null. A cut-off string
 * (no closing quote) is opened as far as it goes and rewritten without a closing quote, as it was.
 */
function edited(s: string, str: Str, inner: (content: string) => string): string | null {
  const raw = s.slice(str.start + 1, str.partial ? str.end : str.end - 1);
  if (!mayHoldJson(raw)) return null;
  const content = decodeJsonString(raw);
  // The shortest thing worth opening is a secret pair like {"pin":1} (9 characters).
  if (content.length < 9 || (!content.includes("{") && !content.includes("["))) return null;
  const red = inner(content);
  if (red === content) return null;
  const literal = JSON.stringify(red);
  return str.partial ? literal.slice(0, -1) : literal;
}

/** Applies sorted, non-overlapping edits; `text: null` becomes `placeholder`. */
export function applyEdits(s: string, edits: Edit[], placeholder: string): string {
  if (!edits.length) return s;
  let out = "";
  let from = 0;
  for (const e of edits) {
    out += s.slice(from, e.start) + (e.text ?? placeholder);
    from = e.end;
  }
  return out + s.slice(from);
}
