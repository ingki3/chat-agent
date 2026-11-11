/**
 * Known secrets (review round 23): every secret value this server holds — connection credentials and refreshed
 * tokens, `.env` keys (skill secrets, legacy runtime keys, the gate code), the master key, per-run MCP tokens,
 * session cookies, and everything that goes through `encrypt`/`decrypt` — is registered here, and everything a run
 * produces (text and reasoning deltas, tool inputs and results, notices, errors, stored messages, titles,
 * artifacts, sources, the history handed to a runtime) is scrubbed against this one registry before it is stored,
 * streamed or sent. A value is found raw and in the encodings it can pass through on the way out:
 *
 * - JSON / JS / Python string escapes, any nesting depth (`\"`, `\\\"`, `A`, `\u{41}`, `\x41`), per char;
 * - percent-encoding (either hex case, `+` for a space), per char — so partly encoded forms match too;
 * - base64 (standard and URL alphabets, any alignment inside a longer encoded string) and hex of its UTF-8 bytes.
 *
 * Streams are scrubbed with a holdback (`StreamScrubber`): text that could still turn into a secret with the next
 * chunk is held until it either does (then it is replaced) or cannot any more, so a secret split across chunks never
 * goes out in pieces. Registered values are never logged. Values shorter than `MIN_KNOWN_LENGTH` are not registered
 * (they would mask ordinary words); key-name heuristics for unknown secrets stay in `@agentlee/shared` redact.
 */

export const KNOWN_PLACEHOLDER = "[숨김]";
export const MIN_KNOWN_LENGTH = 8;
/**
 * The one length cap (UTF-16 units), for registering and for matching alike (round 24): a value up to this long is
 * registered and matched whole; a longer one is registered as consecutive pieces of this length (the last one
 * ending at its end), each matched on its own — so all of it is masked wherever it appears. At most
 * `MAX_PIECES` pieces (1 MiB); nothing the server holds comes close.
 */
export const MAX_KNOWN_LENGTH = 16_384;
const MAX_PIECES = 64;
/** A partial match this long (secret characters) at the very end of a finished text is masked too. */
const TAIL_MIN = 8;
/** Backslash runs longer than this are not read as one escape (keeps the scan linear). */
const MAX_BACKSLASH_RUN = 16;
/**
 * Extra steps a single start position may take beyond one per character of the secret (backtracking only happens
 * around backslashes): a full-length value always gets the steps it needs.
 */
const STEP_BUDGET = 4096;

/** Keys of a JSON credential whose string values are secrets in their own right. */
const SECRET_KEY = /token|secret|key|password|passwd|auth|credential|cookie|session|endpoint|bearer/i;

type Compiled = {
  secrets: { cps: number[] }[];
  /** Secret indexes by the first UTF-16 unit of their raw form. */
  byFirst: Map<number, number[]>;
  /** Secrets that start with "+" or a space (its form encoding). */
  plusFirst: number[];
  /** Base64 cores (case-sensitive), found in the text with whitespace and `\n`-style escapes taken out. */
  literals: string[];
  /** Hex of the UTF-8 bytes, lower case, found in the same view lower-cased (any mix of cases). */
  hexes: string[];
};

export class KnownSecrets {
  private readonly values = new Set<string>();
  private compiled: Compiled | undefined;

  /** Registers a secret value (idempotent; too short or blank values are ignored). */
  add(value: string | undefined | null): void {
    for (const v of pieces(value)) {
      if (this.values.has(v)) continue;
      this.values.add(v);
      this.compiled = undefined;
    }
  }

  /** Forgets a value that is no longer valid anywhere (a revoked run token, an ended session). */
  remove(value: string | undefined | null): void {
    for (const v of pieces(value)) if (this.values.delete(v)) this.compiled = undefined;
  }

  /**
   * Registers a stored credential: the whole value, and — for a JSON credential (login tokens, push keys) —
   * every string under a secret-looking key, so one token of it is found on its own.
   */
  addCredential(plaintext: string): void {
    this.add(plaintext);
    if (!/^\s*[[{]/.test(plaintext)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      return;
    }
    const walk = (v: unknown, secretKey: boolean, depth: number): void => {
      if (depth > 8) return;
      if (typeof v === "string") {
        if (secretKey) this.add(v);
      } else if (Array.isArray(v)) for (const x of v) walk(x, secretKey, depth + 1);
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) walk(x, secretKey || SECRET_KEY.test(k), depth + 1);
    };
    walk(parsed, false, 0);
  }

  /** Registers a binary key by its usual text forms (base64, base64url, hex). */
  addKey(key: Buffer): void {
    this.add(key.toString("base64"));
    this.add(key.toString("base64").replace(/=+$/, ""));
    this.add(key.toString("base64url"));
    this.add(key.toString("hex"));
  }

  /** Every registered value (for the skill and finance output scrubbers, which pull from here too). */
  list(): string[] {
    return [...this.values];
  }

  size(): number {
    return this.values.size;
  }

  /** Test helper: forgets everything. */
  clear(): void {
    this.values.clear();
    this.compiled = undefined;
  }

  /** The matcher for the current set. */
  matcher(): Compiled | undefined {
    if (!this.values.size) return undefined;
    if (this.compiled) return this.compiled;
    const secrets: Compiled["secrets"] = [];
    const byFirst = new Map<number, number[]>();
    const plusFirst: number[] = [];
    const literals: string[] = [];
    const hexes: string[] = [];
    for (const v of this.values) {
      const i = secrets.length;
      const cps = [...v].map((c) => c.codePointAt(0)!);
      secrets.push({ cps });
      const first = v.charCodeAt(0);
      const list = byFirst.get(first) ?? [];
      list.push(i);
      byFirst.set(first, list);
      if (cps[0] === 32 || cps[0] === 43) plusFirst.push(i);
      for (const l of encodedLiterals(v)) literals.push(l);
      hexes.push(Buffer.from(v, "utf8").toString("hex"));
    }
    const uniq = [...new Set(literals)].filter((l) => l.length >= MIN_KNOWN_LENGTH);
    this.compiled = { secrets, byFirst, plusFirst, literals: uniq, hexes: [...new Set(hexes)] };
    return this.compiled;
  }
}

/** What is registered for a value: itself, or pieces of `MAX_KNOWN_LENGTH` covering all of it. */
function pieces(value: string | undefined | null): string[] {
  if (typeof value !== "string" || value.length < MIN_KNOWN_LENGTH || !/\S/.test(value)) return [];
  if (value.length <= MAX_KNOWN_LENGTH) return [value];
  const out: string[] = [];
  // Never cut a surrogate pair: a piece boundary moves back by one unit before a low surrogate.
  const cut = (k: number) => (k > 0 && k < value.length && /[\uDC00-\uDFFF]/.test(value[k]!) ? k - 1 : k);
  for (let at = 0; at < value.length && out.length < MAX_PIECES - 1;) {
    const end = cut(Math.min(value.length, at + MAX_KNOWN_LENGTH));
    out.push(value.slice(at, end));
    if (end >= value.length) return out;
    at = end;
  }
  out.push(value.slice(cut(value.length - MAX_KNOWN_LENGTH))); // the end, whatever the piece limit left out
  return out;
}

/** The process-wide registry: every secret source registers here; every run output is scrubbed against it. */
export const knownSecrets = new KnownSecrets();

/** Base64 (both alphabets, every alignment) of a value's UTF-8 bytes, as literal patterns. */
function encodedLiterals(v: string): string[] {
  const bytes = Buffer.from(v, "utf8");
  const out: string[] = [];
  for (let shift = 0; shift < 3; shift++) {
    const b64 = Buffer.concat([Buffer.alloc(shift), bytes]).toString("base64");
    // Only the characters made from the value's own bits: the same whatever comes before or after it.
    const from = Math.ceil((8 * shift) / 6);
    const to = Math.floor((8 * (shift + bytes.length)) / 6);
    const core = b64.slice(from, to);
    out.push(core, core.replace(/\+/g, "-").replace(/\//g, "_"));
  }
  return out;
}

// ---- matching ----

const PARTIAL = -2;
const FAIL = -1;

const HEX = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);
const hexVal = (c: number) => (c <= 57 ? c - 48 : (c | 32) - 87);

/** Simple escapes (`\n`, `\"`, …) → the character they stand for. */
const SIMPLE: Record<number, number> = {
  34: 34, // "
  39: 39, // '
  47: 47, // /
  96: 96, // `
  110: 10, // n
  116: 9, // t
  114: 13, // r
  98: 8, // b
  102: 12, // f
  118: 11, // v
  48: 0, // 0
};

function utf8(cp: number): number[] {
  return [...Buffer.from(String.fromCodePoint(cp), "utf8")];
}

/**
 * Ways code point `cp` can be written at `i`: each entry the end of that form, or PARTIAL when the text ends
 * inside a form that is consistent so far.
 */
function forms(text: string, i: number, cp: number, out: number[]): void {
  const n = text.length;
  if (i >= n) {
    out.push(PARTIAL);
    return;
  }
  const c = text.charCodeAt(i);
  // Raw.
  if (cp > 0xffff) {
    const s = String.fromCodePoint(cp);
    if (c === s.charCodeAt(0))
      out.push(i + 1 >= n ? PARTIAL : text.charCodeAt(i + 1) === s.charCodeAt(1) ? i + 2 : FAIL);
  } else if (c === cp) out.push(i + 1);
  if (cp === 32 && c === 43) out.push(i + 1); // form encoding: "+"
  // Percent-encoding of each UTF-8 byte.
  if (c === 37) {
    let j = i;
    let ok = true;
    for (const b of utf8(cp)) {
      // Each byte: "%", its high digit, its low digit (either case); the text may end anywhere in between.
      const want = [-1, b >> 4, b & 15];
      for (let d = 0; d < 3 && ok; d++) {
        if (j + d >= n) {
          out.push(PARTIAL);
          ok = false;
        } else {
          const h = text.charCodeAt(j + d);
          if (d === 0 ? h !== 37 : !HEX(h) || hexVal(h) !== want[d]) ok = false;
        }
      }
      if (!ok) break;
      j += 3;
    }
    if (ok) out.push(j);
  }
  // Backslash escapes, any nesting depth (a run of backslashes, then the escape).
  if (c === 92) {
    let r = 0;
    while (i + r < n && text.charCodeAt(i + r) === 92 && r <= MAX_BACKSLASH_RUN) r++;
    if (r > MAX_BACKSLASH_RUN) return;
    // An escaped backslash at any depth: 2, 4, 8 or 16 backslashes (the raw one is the literal form above).
    if (cp === 92) for (let k = 2; k <= r; k *= 2) out.push(i + k);
    const j = i + r;
    if (j >= n) {
      out.push(PARTIAL);
      return;
    }
    const x = text.charCodeAt(j);
    if (
      SIMPLE[x] === cp &&
      !(x === 48 && j + 1 < n && text.charCodeAt(j + 1) >= 48 && text.charCodeAt(j + 1) <= 57)
    )
      out.push(j + 1);
    if (x === 120) hexEscape(text, j + 1, 2, cp, out); // \xHH
    if (x === 117) {
      if (j + 1 < n && text.charCodeAt(j + 1) === 123)
        braceEscape(text, j + 2, cp, out); // \u{…}
      else if (cp > 0xffff) {
        // A surrogate pair: 😀 (the low half may have its own backslash run).
        const hi = 0xd800 + ((cp - 0x10000) >> 10);
        const lo = 0xdc00 + ((cp - 0x10000) & 0x3ff);
        const mid: number[] = [];
        hexEscape(text, j + 1, 4, hi, mid);
        for (const e of mid) {
          if (e === PARTIAL) out.push(PARTIAL);
          else if (e >= 0) {
            const tail: number[] = [];
            forms(text, e, lo, tail);
            for (const t of tail) if (t === PARTIAL || t >= 0) out.push(t);
          }
        }
      } else hexEscape(text, j + 1, 4, cp, out); // \uXXXX
    }
    if (x === 85) hexEscape(text, j + 1, 8, cp, out); // Python \UXXXXXXXX
    // Byte escapes of its UTF-8 bytes: octal `\163` (Python, C, Ruby, Bash) or `\xed\x95\x9c` (Python bytes).
    if ((x >= 48 && x <= 55) || (x === 120 && cp > 0x7f)) byteEscapes(text, i, utf8(cp), out);
  }
}

/** `bytes` written as one escape each (`\ooo` with 1–3 octal digits, or `\xHH`), each after a backslash run. */
function byteEscapes(text: string, i: number, bytes: number[], out: number[]): void {
  const n = text.length;
  let j = i;
  for (const b of bytes) {
    if (j >= n) return void out.push(PARTIAL);
    if (text.charCodeAt(j) !== 92) return;
    let r = 0;
    while (j + r < n && text.charCodeAt(j + r) === 92 && r <= MAX_BACKSLASH_RUN) r++;
    if (r > MAX_BACKSLASH_RUN) return;
    j += r;
    if (j >= n) return void out.push(PARTIAL);
    const x = text.charCodeAt(j);
    let v = 0;
    if (x >= 48 && x <= 55) {
      let k = 0;
      while (k < 3 && j + k < n && text.charCodeAt(j + k) >= 48 && text.charCodeAt(j + k) <= 55)
        v = v * 8 + text.charCodeAt(j + k++) - 48;
      if (k < 3 && j + k >= n) return void out.push(PARTIAL); // more digits may follow
      j += k;
    } else if (x === 120) {
      if (j + 2 >= n) return void out.push(PARTIAL);
      const h1 = text.charCodeAt(j + 1);
      const h2 = text.charCodeAt(j + 2);
      if (!HEX(h1) || !HEX(h2)) return;
      v = hexVal(h1) * 16 + hexVal(h2);
      j += 3;
    } else return;
    if (v !== b) return;
  }
  out.push(j);
}

function hexEscape(text: string, at: number, len: number, cp: number, out: number[]): void {
  let v = 0;
  for (let k = 0; k < len; k++) {
    if (at + k >= text.length) {
      // Consistent so far? (the digits seen are the leading digits of cp)
      if (k === 0 || v === cp >>> (4 * (len - k))) out.push(PARTIAL);
      return;
    }
    const h = text.charCodeAt(at + k);
    if (!HEX(h)) return;
    v = v * 16 + hexVal(h);
  }
  if (v === cp) out.push(at + len);
}

function braceEscape(text: string, at: number, cp: number, out: number[]): void {
  let v = 0;
  for (let k = 0; k < 7; k++) {
    if (at + k >= text.length) {
      out.push(PARTIAL);
      return;
    }
    const h = text.charCodeAt(at + k);
    if (h === 125) {
      if (k > 0 && v === cp) out.push(at + k + 1);
      return;
    }
    if (!HEX(h)) return;
    v = v * 16 + hexVal(h);
  }
}

/** Matches secret `cps` at `start`: its end, PARTIAL (the text ends inside a consistent match), or FAIL. */
function matchAt(text: string, start: number, cps: number[]): { end: number; depth: number } {
  let steps = 0;
  const budget = cps.length * 2 + STEP_BUDGET;
  let partialDepth = -1;
  let full = FAIL;
  const buf: number[] = [];
  // Depth-first: (position, index into cps). Most characters have exactly one form, so this rarely branches.
  const stack: [number, number][] = [[start, 0]];
  while (stack.length && full === FAIL) {
    const [pos, k] = stack.pop()!;
    if (k === cps.length) {
      full = pos;
      break;
    }
    if (++steps > budget) break;
    buf.length = 0;
    forms(text, pos, cps[k]!, buf);
    for (let b = buf.length - 1; b >= 0; b--) {
      const e = buf[b]!;
      if (e === PARTIAL) partialDepth = Math.max(partialDepth, k);
      else if (e >= 0) stack.push([e, k + 1]);
    }
  }
  if (full !== FAIL) return { end: full, depth: cps.length };
  if (partialDepth >= 0) return { end: PARTIAL, depth: partialDepth };
  return { end: FAIL, depth: 0 };
}

type Scan = {
  /** Ranges to mask, sorted and merged. */
  ranges: [number, number][];
  /** Earliest start of a match the text ends inside (Infinity when none), and how much of the secret it has. */
  partialAt: number;
  partialDepth: number;
};

function scan(text: string, m: Compiled): Scan {
  const found: [number, number][] = [];
  let partialAt = Infinity;
  let partialDepth = 0;
  const n = text.length;
  const all = m.secrets.map((_, i) => i);
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    // "%" and "\" may start an encoded first character of any secret; "+" an encoded space.
    const cand = c === 37 || c === 92 ? all : c === 43 ? m.plusFirst : m.byFirst.get(c);
    if (!cand) continue;
    for (const s of cand) {
      const r = matchAt(text, i, m.secrets[s]!.cps);
      if (r.end >= 0) found.push([i, r.end]);
      else if (r.end === PARTIAL && i < partialAt) {
        partialAt = i;
        partialDepth = r.depth;
      } else if (r.end === PARTIAL && i === partialAt) partialDepth = Math.max(partialDepth, r.depth);
    }
  }
  // Base64 and hex: in the text with line breaks, spaces and `\n`-style escapes taken out (base64 wrapped at 76
  // columns, PEM/MIME, CRLF or LF, a stringified PEM), hex also in any mix of cases.
  const view = stripped(text);
  const lower = view.v.replace(/[A-F]/g, (c) => c.toLowerCase());
  const vn = view.v.length;
  const origin = (k: number) => (k < vn ? view.origin[k]! : n);
  const find = (hay: string, l: string, ratio: number) => {
    for (let at = hay.indexOf(l); at !== -1; at = hay.indexOf(l, at + 1))
      found.push([origin(at), origin(at + l.length - 1) + 1]);
    // The text ends inside this pattern?
    const first = l.charCodeAt(0);
    for (let k = Math.max(0, vn - l.length + 1); k < vn; k++) {
      if (hay.charCodeAt(k) !== first || !l.startsWith(hay.slice(k))) continue;
      const i = origin(k);
      const depth = Math.floor((vn - k) * ratio);
      if (i < partialAt) {
        partialAt = i;
        partialDepth = depth;
      } else if (i === partialAt) partialDepth = Math.max(partialDepth, depth);
      break;
    }
  };
  for (const l of m.literals) find(view.v, l, 3 / 4);
  for (const h of m.hexes) find(lower, h, 1 / 2);
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const ranges: [number, number][] = [];
  for (const r of found) {
    const last = ranges.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else ranges.push([r[0], r[1]]);
  }
  return { ranges, partialAt, partialDepth };
}

/** The text without whitespace and `\n` `\r` `\t` escapes (any backslash run), with each character's offset. */
function stripped(text: string): { v: string; origin: Int32Array } {
  const origin = new Int32Array(text.length);
  let v = "";
  let from = 0;
  let len = 0;
  const flush = (to: number) => {
    if (to > from) {
      v += text.slice(from, to);
      for (let k = from; k < to; k++) origin[len++] = k;
    }
  };
  for (let k = 0; k < text.length;) {
    const c = text.charCodeAt(k);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      flush(k);
      from = ++k;
    } else if (c === 92) {
      let e = k;
      while (e < text.length && text.charCodeAt(e) === 92) e++;
      const x = text.charCodeAt(e);
      if (x === 110 || x === 114 || x === 116) {
        flush(k);
        from = k = e + 1;
      } else k = e;
    } else k++;
  }
  flush(text.length);
  return { v, origin: origin.subarray(0, len) };
}

function apply(text: string, ranges: [number, number][], upTo: number): string {
  let out = "";
  let at = 0;
  for (const [a, b] of ranges) {
    if (b > upTo) break;
    out += text.slice(at, a) + KNOWN_PLACEHOLDER;
    at = b;
  }
  return out + text.slice(at, upTo);
}

/**
 * Masks every known secret in a finished text. With `tail` (the default), a match the text ends inside that already
 * holds `TAIL_MIN` characters of a secret is masked too (a cut-off secret is still a leak).
 */
export function scrubKnown(text: string, opts: { tail?: boolean; registry?: KnownSecrets } = {}): string {
  const m = (opts.registry ?? knownSecrets).matcher();
  if (!m || !text) return text;
  const s = scan(text, m);
  if (!s.ranges.length && s.partialAt === Infinity) return text;
  if ((opts.tail ?? true) && s.partialAt !== Infinity && s.partialDepth >= TAIL_MIN) {
    // Everything from the cut-off secret on goes (with a complete match it overlaps).
    let from = s.partialAt;
    for (const [a, b] of s.ranges) if (a < from && b > from) from = a;
    return apply(text, s.ranges, from) + KNOWN_PLACEHOLDER;
  }
  return apply(text, s.ranges, text.length);
}

/** `scrubKnown` on every string (and object key) of a JSON-like value. Returns the same value when nothing changed. */
export function scrubKnownDeep<T>(value: T, opts: { tail?: boolean; registry?: KnownSecrets } = {}): T {
  if (!(opts.registry ?? knownSecrets).matcher()) return value;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return scrubKnown(v, opts);
    if (depth > 64 || !v || typeof v !== "object") return v;
    if (Array.isArray(v)) {
      let changed = false;
      const out = v.map((x) => {
        const y = walk(x, depth + 1);
        if (y !== x) changed = true;
        return y;
      });
      return changed ? out : v;
    }
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      const k2 = scrubKnown(k, opts);
      const y = walk(x, depth + 1);
      if (k2 !== k || y !== x) changed = true;
      out[k2] = y;
    }
    return changed ? out : v;
  };
  return walk(value, 0) as T;
}

/**
 * Scrubs a stream chunk by chunk. `push` returns what may go out now; text that may still become a secret with
 * the next chunk is held back. `end` returns the rest (a cut-off secret at the very end is masked).
 */
export class StreamScrubber {
  private pending = "";
  constructor(private readonly registry: KnownSecrets = knownSecrets) {}

  push(chunk: string): string {
    const text = this.pending + chunk;
    const m = this.registry.matcher();
    if (!m) {
      this.pending = "";
      return text;
    }
    const s = scan(text, m);
    let cut = s.partialAt === Infinity ? text.length : s.partialAt;
    // Held text starts at a word: the reader never sees half a word (`단어1` of `단어173`) while the rest waits.
    if (cut < text.length) {
      let w = cut;
      while (w > 0 && w > cut - 256 && !/\s/.test(text[w - 1]!)) w--;
      if (w === 0 || /\s/.test(text[w - 1]!)) cut = w;
    }
    // A complete match that runs past the cut is masked with the held text (next time round).
    for (const [a, b] of s.ranges) if (a < cut && b > cut) cut = a;
    this.pending = text.slice(cut);
    return apply(text, s.ranges, cut);
  }

  /** Whatever is held back, scrubbed as a finished text. */
  end(): string {
    const rest = this.pending;
    this.pending = "";
    return rest ? scrubKnown(rest, { registry: this.registry }) : "";
  }

  held(): number {
    return this.pending.length;
  }
}
