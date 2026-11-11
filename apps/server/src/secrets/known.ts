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
  secrets: {
    cps: number[];
    /** The value itself (raw matches: `indexOf`, and a KMP pass over the text's end for a cut-off one). */
    raw: string;
    /** KMP failure table of `raw` (UTF-16 units; equal to code points when `astral` is false). */
    fail: Int32Array;
    astral: boolean;
  }[];
  /** Secret indexes by the first UTF-16 unit of their raw form. */
  byFirst: Map<number, number[]>;
  /** Secret indexes by their first code point (for encoded first characters). */
  byFirstCp: Map<number, number[]>;
  /** Secrets that start with "+" or a space (its form encoding). */
  plusFirst: number[];
  /** Base64 cores (case-sensitive), found in the text with whitespace and `\n`-style escapes taken out. */
  literals: string[];
  /** Hex of the UTF-8 bytes, lower case, found in the same view lower-cased (any mix of cases). */
  hexes: string[];
  /** KMP failure tables of `literals` and `hexes`. */
  literalFail: Int32Array[];
  hexFail: Int32Array[];
};

export class KnownSecrets {
  private readonly values = new Set<string>();
  private compiled: Compiled | undefined;
  private readonly listeners: ((values: string[]) => void)[] = [];

  /**
   * Called (synchronously, once per `add` call) when a value that may already be stored somewhere was registered
   * — the background rescrub of stored rows hooks in here (round 25). Not for `fresh` values.
   */
  onRegistered(fn: (values: string[]) => void): () => void {
    this.listeners.push(fn);
    return () => {
      const k = this.listeners.indexOf(fn);
      if (k >= 0) this.listeners.splice(k, 1);
    };
  }

  /**
   * Registers a secret value (idempotent; too short or blank values are ignored). `fresh`: a value just generated
   * here (a run token, a new session) — it cannot be in any stored row yet, so no rescrub is needed.
   */
  add(value: string | undefined | null, opts: { fresh?: boolean } = {}): void {
    const added: string[] = [];
    for (const v of pieces(value)) {
      if (this.values.has(v)) continue;
      this.values.add(v);
      this.compiled = undefined;
      added.push(v);
    }
    if (added.length && !opts.fresh)
      for (const fn of [...this.listeners]) {
        try {
          fn(added);
        } catch {
          // a listener never breaks registration
        }
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
    const byFirstCp = new Map<number, number[]>();
    const literals: string[] = [];
    const hexes: string[] = [];
    for (const v of this.values) {
      const i = secrets.length;
      const cps = [...v].map((c) => c.codePointAt(0)!);
      secrets.push({ cps, raw: v, fail: failure(v), astral: cps.length !== v.length });
      const first = v.charCodeAt(0);
      const list = byFirst.get(first) ?? [];
      list.push(i);
      byFirst.set(first, list);
      if (cps[0] === 32 || cps[0] === 43) plusFirst.push(i);
      const cpList = byFirstCp.get(cps[0]!) ?? [];
      cpList.push(i);
      byFirstCp.set(cps[0]!, cpList);
      for (const l of encodedLiterals(v)) literals.push(l);
      hexes.push(Buffer.from(v, "utf8").toString("hex"));
    }
    const uniq = [...new Set(literals)].filter((l) => l.length >= MIN_KNOWN_LENGTH);
    const hexList = [...new Set(hexes)];
    this.compiled = {
      secrets,
      byFirst,
      byFirstCp,
      plusFirst,
      literals: uniq,
      hexes: hexList,
      literalFail: uniq.map(failure),
      hexFail: hexList.map(failure),
    };
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
  // Full-length pieces from the start; the last one is full-length too, aligned to the end (overlapping the one
  // before), so no piece is ever short (round 25: a 1-character tail piece masked every "a" in "banana").
  for (let at = 0; at + MAX_KNOWN_LENGTH < value.length && out.length < MAX_PIECES - 1;) {
    const end = cut(at + MAX_KNOWN_LENGTH);
    out.push(value.slice(at, end));
    at = end;
  }
  out.push(value.slice(cut(value.length - MAX_KNOWN_LENGTH)));
  return out;
}

/** KMP failure function: for each prefix length, the longest proper border. */
function failure(p: string): Int32Array {
  const f = new Int32Array(p.length);
  for (let i = 1, k = 0; i < p.length; i++) {
    while (k > 0 && p.charCodeAt(i) !== p.charCodeAt(k)) k = f[k - 1]!;
    if (p.charCodeAt(i) === p.charCodeAt(k)) k++;
    f[i] = k;
  }
  return f;
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
    // Octal of the code point itself (Python str, JS legacy: `\344` is "ä"), 1–3 digits, greedy.
    if (x >= 48 && x <= 55 && cp < 256) {
      let v = 0;
      let k = 0;
      while (k < 3 && j + k < n && text.charCodeAt(j + k) >= 48 && text.charCodeAt(j + k) <= 55)
        v = v * 8 + text.charCodeAt(j + k++) - 48;
      if (k < 3 && j + k >= n) out.push(PARTIAL);
      else if (v === cp) out.push(j + k);
    }
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

/** The work left for one scan (steps of `matchAt`): linear in the text; when it runs out the scan fails safe. */
type Work = { left: number };
const EXHAUSTED = -3;
/** "%", "\\" and "+": where an encoded form can start (anything else is matched raw, one unit for one unit). */
const isSpecial = (c: number) => c === 37 || c === 92 || c === 43;

type Match = {
  /** End of a complete match, PARTIAL (the text ends inside a consistent match), FAIL, or EXHAUSTED. */
  end: number;
  /** Characters of the secret matched (for PARTIAL: before the text ran out). */
  depth: number;
  /** On FAIL along one path of raw characters only: where it failed, and how many characters it had (KMP). */
  rawFail?: { pos: number; k: number };
  /** The furthest text position a consistent path reached. */
  reach: number;
};

/**
 * Matches secret `cps` at `start` (or resumes at `pos` with `k` characters already matched — a KMP shift).
 * Depth-first over the forms of each character; most characters have exactly one form, so this rarely branches.
 */
function matchAt(text: string, start: number, cps: number[], work: Work, pos0 = start, k0 = 0): Match {
  let steps = 0;
  const budget = cps.length * 2 + STEP_BUDGET;
  let partialDepth = -1;
  let full = FAIL;
  let reach = pos0;
  const buf: number[] = [];
  let seen: Set<number> | undefined;
  // One path of raw characters only, so far (then a failure tells KMP where the next start can be).
  let rawOnly = true;
  let last = { pos: pos0, k: k0 };
  const stack: [number, number][] = [[pos0, k0]];
  while (stack.length && full === FAIL) {
    const [pos, k] = stack.pop()!;
    if (pos > reach) reach = pos;
    if (k === cps.length) {
      full = pos;
      break;
    }
    if (++steps > budget || --work.left < 0) return { end: EXHAUSTED, depth: 0, reach };
    buf.length = 0;
    forms(text, pos, cps[k]!, buf);
    // Two forms ending at the same place (octal of the code point and of its byte) are one state: once the search
    // branches, a state is never explored twice (linear in the secret, not exponential).
    const valid = buf.filter((e) => e >= 0).length;
    if (!seen && valid > 1) seen = new Set();
    if (
      valid > 1 ||
      (valid === 1 && (buf.find((e) => e >= 0) !== pos + 1 || isSpecial(text.charCodeAt(pos))))
    )
      rawOnly = false;
    if (valid === 0 && rawOnly) last = { pos, k };
    for (let b = buf.length - 1; b >= 0; b--) {
      const e = buf[b]!;
      if (e === PARTIAL) partialDepth = Math.max(partialDepth, k);
      else if (e >= 0) {
        if (seen) {
          const key = e * (cps.length + 1) + k + 1;
          if (seen.has(key)) continue;
          seen.add(key);
        }
        stack.push([e, k + 1]);
      }
    }
  }
  if (full !== FAIL) return { end: full, depth: cps.length, reach };
  if (partialDepth >= 0) return { end: PARTIAL, depth: partialDepth, reach };
  return { end: FAIL, depth: 0, reach, ...(rawOnly ? { rawFail: last } : {}) };
}

type Scan = {
  /** Ranges to mask, sorted and merged. */
  ranges: [number, number][];
  /** Earliest start of a match the text ends inside (Infinity when none), and how much of the secret it has. */
  partialAt: number;
  /** Earliest start of such a match that already holds `TAIL_MIN` characters of its secret (Infinity: none). */
  deepPartialAt: number;
  partialDepth: number;
};

/**
 * `stream`: everything from the earliest partial match is held back anyway, so a secret is not tried again after
 * its own partial match; `tail`: the same after a partial match deep enough to be masked; `plain`: never skipped.
 */
type ScanMode = "stream" | "tail" | "plain";

/**
 * The whole search (round 27): every encoding on the text itself, and again on the text with one transport layer
 * decoded — percent-encoding, or JSON/JS string escapes — mapped back (`%5Cu0073…`, `%5C163…`, `%2573…`). An
 * escape the text ends inside (`%5`, `\\u00`) is held like any partial match: the next chunk may complete it.
 */
function scan(text: string, m: Compiled, mode: ScanMode = "plain"): Scan {
  const out = scanCore(text, m, mode);
  const views: View[] = [];
  if (text.includes("%")) views.push(percentDecoded(text));
  if (text.includes("\\")) views.push(escapeDecoded(text));
  if (!views.length) return out;
  const found = [...out.ranges];
  let { partialAt, partialDepth, deepPartialAt } = out;
  const partial = (i: number, depth: number) => {
    if (i < partialAt) {
      partialAt = i;
      partialDepth = depth;
    } else if (i === partialAt) partialDepth = Math.max(partialDepth, depth);
    if (depth >= TAIL_MIN && i < deepPartialAt) deepPartialAt = i;
  };
  for (const view of views) {
    const sub = scanCore(view.v, m, mode);
    const vn = view.v.length;
    const at = (k: number) => (k < vn ? view.start[k]! : (view.incompleteAt ?? text.length));
    for (const [a, b] of sub.ranges) found.push([at(a), b > 0 && b <= vn ? view.end[b - 1]! : text.length]);
    if (sub.partialAt !== Infinity) partial(at(sub.partialAt), sub.partialDepth);
    if (sub.deepPartialAt !== Infinity) partial(at(sub.deepPartialAt), TAIL_MIN);
    if (view.incompleteAt !== undefined) partial(view.incompleteAt, 0);
  }
  return { ranges: merge(found), partialAt, partialDepth, deepPartialAt };
}

/** Base64 (both alphabets) and padding characters. */
const B64_EDGE = /[A-Za-z0-9+/_=-]/;

function merge(found: [number, number][]): [number, number][] {
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const ranges: [number, number][] = [];
  for (const r of found) {
    const last = ranges.at(-1);
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else ranges.push([r[0], r[1]]);
  }
  return ranges;
}

/** Every encoding on one text (no transport layer decoded): the character search, raw matches, base64 and hex. */
function scanCore(text: string, m: Compiled, mode: ScanMode): Scan {
  let deepPartialAt = Infinity;
  const found: [number, number][] = [];
  let partialAt = Infinity;
  let partialDepth = 0;
  const n = text.length;
  // Total work: linear in the text. Running out never lets a match through: what the search was in the middle of
  // is masked (if it already held enough of a secret), the budget is renewed once; a second time, the rest goes.
  const work: Work = { left: 64 * n + 65_536 };
  let renewed = false;
  // Per secret: no start before `skipUntil` can match (inside a complete match, after a partial one that is held
  // or masked, or skipped by a KMP shift); `resume*` continues a KMP shift's match at its start.
  const skipUntil = new Int32Array(m.secrets.length);
  const resumeAt = new Int32Array(m.secrets.length).fill(-1);
  const resumePos = new Int32Array(m.secrets.length);
  const resumeK = new Int32Array(m.secrets.length);
  // Next "%", "\\" or "+" at or after each position: a start with none within the secret's length can only
  // match raw — `indexOf` and the KMP pass below find those, so the character search never runs there.
  const nextSpecial = new Int32Array(n + 1).fill(n);
  for (let k = n - 1; k >= 0; k--) nextSpecial[k] = isSpecial(text.charCodeAt(k)) ? k : nextSpecial[k + 1]!;
  const buf: number[] = [];
  let exhaustedAt = -1;
  const partial = (i: number, depth: number) => {
    if (i < partialAt) {
      partialAt = i;
      partialDepth = depth;
    } else if (i === partialAt) partialDepth = Math.max(partialDepth, depth);
    if (depth >= TAIL_MIN && i < deepPartialAt) deepPartialAt = i;
  };
  outer: for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    let cand = c === 43 ? m.plusFirst : m.byFirst.get(c);
    if (c === 37 || c === 92) {
      // "%" and "\\" may start an encoded first character: only secrets whose first character this form can
      // spell are tried (one check per distinct first character, not per secret).
      cand = [...(cand ?? [])];
      for (const [cp, list] of m.byFirstCp) {
        buf.length = 0;
        forms(text, i, cp, buf);
        if (buf.some((e) => e >= 0 || e === PARTIAL)) cand.push(...list);
      }
    }
    if (!cand) continue;
    for (const s of cand) {
      if (skipUntil[s]! > i) continue;
      const sec = m.secrets[s]!;
      const resuming = resumeAt[s] === i;
      if (!resuming && !isSpecial(c) && nextSpecial[i]! >= i + sec.raw.length) continue; // raw only: below
      const r = resuming
        ? matchAt(text, i, sec.cps, work, resumePos[s], resumeK[s])
        : matchAt(text, i, sec.cps, work);
      resumeAt[s] = -1;
      if (r.end === EXHAUSTED) {
        if (r.reach - i >= MIN_KNOWN_LENGTH) found.push([i, r.reach]);
        skipUntil[s] = Math.max(r.reach, i + 1);
        if (renewed) {
          exhaustedAt = r.reach;
          break outer;
        }
        renewed = true;
        work.left = 64 * n + 65_536;
        continue;
      }
      if (r.end >= 0) {
        found.push([i, r.end]);
        skipUntil[s] = r.end;
      } else if (r.end === PARTIAL) {
        partial(i, r.depth);
        // From here on this secret's text is held (stream) or masked (tail, deep enough): not tried again.
        if (mode === "stream" || (mode === "tail" && r.depth >= TAIL_MIN)) skipUntil[s] = n;
      } else if (r.rawFail && r.rawFail.k > 0 && !sec.astral) {
        // A raw path failed after k characters: KMP says where the next possible start is, and with how much of
        // the secret already matched (the scan stays linear on repeated prefixes).
        const border = sec.fail[r.rawFail.k - 1]!;
        const next = i + (r.rawFail.k - border);
        skipUntil[s] = next;
        if (border > 0) {
          resumeAt[s] = next;
          resumePos[s] = r.rawFail.pos;
          resumeK[s] = border;
        }
      }
    }
  }
  if (exhaustedAt >= 0) found.push([exhaustedAt, n]);
  // Raw matches: every complete one, and one the text ends inside (the longest such suffix, by KMP).
  for (const sec of m.secrets) {
    const l = sec.raw;
    for (let at = text.indexOf(l); at !== -1; at = text.indexOf(l, at + l.length))
      found.push([at, at + l.length]);
    let q = 0;
    for (let k = Math.max(0, n - l.length + 1); k < n; k++) {
      const ch = text.charCodeAt(k);
      while (q > 0 && l.charCodeAt(q) !== ch) q = sec.fail[q - 1]!;
      if (l.charCodeAt(q) === ch) q++;
      if (q === l.length) q = sec.fail[q - 1]!;
    }
    if (q > 0) partial(n - q, q);
  }
  // Base64 and hex: in the text with line breaks, spaces and `\n`-style escapes taken out (base64 wrapped at 76
  // columns, PEM/MIME, CRLF or LF, a stringified PEM), hex also in any mix of cases.
  // (One transport layer decoded first: `scan`.)
  {
    const view = stripped(text);
    const lower = view.v.replace(/[A-F]/g, (c) => c.toLowerCase());
    const vn = view.v.length;
    const origin = (k: number) => (k < vn ? view.start[k]! : n);
    const find = (hay: string, l: string, fail: Int32Array, ratio: number) => {
      // Non-overlapping occurrences (one inside another adds nothing: it is masked with it). A match ends where its
      // last character ends (round 27: not at the next one — the line break after a token stays).
      for (let at = hay.indexOf(l); at !== -1; at = hay.indexOf(l, at + l.length)) {
        // The core plus the few characters around it that mix its bits with its neighbours' (base64 edges,
        // padding): up to 3 on each side, of the encoding's own alphabet.
        let a = at;
        let b = at + l.length;
        // Only characters right next to it in the text itself (not across a space or a line break taken out).
        for (
          let k = 0;
          k < 3 && a > 0 && B64_EDGE.test(hay[a - 1]!) && view.end[a - 1] === view.start[a];
          k++
        )
          a--;
        for (let k = 0; k < 3 && b < vn && B64_EDGE.test(hay[b]!) && view.start[b] === view.end[b - 1]; k++)
          b++;
        found.push([origin(a), view.end[b - 1]!]);
      }
      // The text ends inside this pattern? The longest suffix that is a prefix of it, in one KMP pass (linear).
      let q = 0;
      for (let k = Math.max(0, vn - l.length + 1); k < vn; k++) {
        const c = hay.charCodeAt(k);
        while (q > 0 && l.charCodeAt(q) !== c) q = fail[q - 1]!;
        if (l.charCodeAt(q) === c) q++;
        if (q === l.length) q = fail[q - 1]!; // a whole occurrence: found above
      }
      if (q === 0) return;
      const i = origin(vn - q);
      const depth = Math.floor(q * ratio);
      if (i < partialAt) {
        partialAt = i;
        partialDepth = depth;
      } else if (i === partialAt) partialDepth = Math.max(partialDepth, depth);
      if (depth >= TAIL_MIN && i < deepPartialAt) deepPartialAt = i;
    };
    m.literals.forEach((l, k) => find(view.v, l, m.literalFail[k]!, 3 / 4));
    m.hexes.forEach((h, k) => find(lower, h, m.hexFail[k]!, 1 / 2));
  }
  return { ranges: merge(found), partialAt, partialDepth, deepPartialAt };
}

/**
 * A decoded or stripped view of a text: for each of its characters, where it starts and ends in the text; and
 * where an escape the text ends inside starts (left out of the view).
 */
type View = { v: string; start: Int32Array; end: Int32Array; incompleteAt?: number };

class ViewBuilder {
  v = "";
  private readonly s: Int32Array;
  private readonly e: Int32Array;
  private n = 0;
  constructor(size: number) {
    this.s = new Int32Array(size);
    this.e = new Int32Array(size);
  }
  /** Appends `chars` standing for text[from, to) (each character gets the whole span). */
  add(chars: string, from: number, to: number): void {
    for (let k = 0; k < chars.length; k++) {
      this.s[this.n] = from;
      this.e[this.n++] = to;
    }
    this.v += chars;
  }
  /** Appends text[from, to) as it is. */
  slice(text: string, from: number, to: number): void {
    if (to <= from) return;
    for (let k = from; k < to; k++) {
      this.s[this.n] = k;
      this.e[this.n++] = k + 1;
    }
    this.v += text.slice(from, to);
  }
  done(incompleteAt?: number): View {
    return {
      v: this.v,
      start: this.s.subarray(0, this.n),
      end: this.e.subarray(0, this.n),
      ...(incompleteAt === undefined ? {} : { incompleteAt }),
    };
  }
}

/** UTF-8 sequence length from its first byte (0: not a valid first byte). */
const utf8Len = (b: number) =>
  b < 0x80 ? 1 : b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;

/** One layer of percent-encoding decoded (UTF-8 sequences whole); everything else as it is. */
function percentDecoded(text: string): View {
  const n = text.length;
  const out = new ViewBuilder(n);
  const byteAt = (k: number) =>
    text.charCodeAt(k) === 37 && HEX(text.charCodeAt(k + 1)) && HEX(text.charCodeAt(k + 2))
      ? hexVal(text.charCodeAt(k + 1)) * 16 + hexVal(text.charCodeAt(k + 2))
      : -1;
  for (let k = 0; k < n;) {
    if (text.charCodeAt(k) === 37) {
      // The text ends inside `%X` (or inside a multi-byte sequence): held, not decoded.
      if (k + 2 >= n && (k + 1 >= n || HEX(text.charCodeAt(k + 1)))) return out.done(k);
      const b = byteAt(k);
      const len = b < 0 ? 0 : utf8Len(b);
      if (len) {
        const bytes = [b];
        let j = k + 3;
        while (bytes.length < len && byteAt(j) >= 0x80 && byteAt(j) < 0xc0) {
          bytes.push(byteAt(j));
          j += 3;
        }
        if (bytes.length < len && j >= n - 2 && (j >= n || text.charCodeAt(j) === 37)) return out.done(k);
        if (bytes.length === len) {
          out.add(Buffer.from(bytes).toString("utf8"), k, j);
          k = j;
          continue;
        }
      }
    }
    out.add(text[k]!, k, k + 1);
    k++;
  }
  return out.done();
}

const JSON_SIMPLE: Record<string, string> = {
  '"': '"',
  "\\": "\\",
  "/": "/",
  "'": "'",
  b: "\b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
};

/** One layer of JSON/JS string escapes decoded (`\uXXXX` with surrogate pairs, `\xHH`, `\"`, `\n`, …). */
function escapeDecoded(text: string): View {
  const n = text.length;
  const out = new ViewBuilder(n);
  const hexRun = (at: number, len: number) => {
    for (let d = 0; d < len; d++) if (!HEX(text.charCodeAt(at + d))) return -1;
    return parseInt(text.slice(at, at + len), 16);
  };
  for (let k = 0; k < n;) {
    if (text.charCodeAt(k) === 92) {
      const x = text[k + 1];
      // The text ends inside an escape (`\`, `\u00`, `\x4`): held, not decoded.
      if (x === undefined) return out.done(k);
      if ((x === "u" && k + 6 > n) || (x === "x" && k + 4 > n)) {
        const digits = text.slice(k + 2);
        if (/^[0-9a-fA-F]*$/.test(digits)) return out.done(k);
      }
      if (x === "u") {
        const v = hexRun(k + 2, 4);
        if (v >= 0) {
          out.add(String.fromCharCode(v), k, k + 6);
          k += 6;
          continue;
        }
      } else if (x === "x") {
        const v = hexRun(k + 2, 2);
        if (v >= 0) {
          out.add(String.fromCharCode(v), k, k + 4);
          k += 4;
          continue;
        }
      } else if (x in JSON_SIMPLE) {
        out.add(JSON_SIMPLE[x]!, k, k + 2);
        k += 2;
        continue;
      }
    }
    out.add(text[k]!, k, k + 1);
    k++;
  }
  return out.done();
}

/** The text without whitespace and `\n` `\r` `\t` escapes (any backslash run), with each character's offset. */
function stripped(text: string): View {
  const out = new ViewBuilder(text.length);
  let from = 0;
  const flush = (to: number) => out.slice(text, from, to);
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
  return out.done();
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
  const r = knownMasks(text, opts);
  return r.length ? apply(text, r, text.length) : text;
}

/** `scrubKnown` for a header value or a URL: the marker percent-encoded, so the result stays ASCII. */
export function scrubKnownAscii(
  text: string,
  opts: { tail?: boolean; registry?: KnownSecrets } = {},
): string {
  const r = knownMasks(text, opts);
  if (!r.length) return text;
  return apply(text, r, text.length).split(KNOWN_PLACEHOLDER).join(encodeURIComponent(KNOWN_PLACEHOLDER));
}

/** The ranges `scrubKnown` masks (sorted, merged; a cut-off secret at the end runs to the end). */
export function knownMasks(
  text: string,
  opts: { tail?: boolean; registry?: KnownSecrets } = {},
): [number, number][] {
  const m = (opts.registry ?? knownSecrets).matcher();
  if (!m || !text) return [];
  const tail = opts.tail ?? true;
  const s = scan(text, m, tail ? "tail" : "plain");
  if (!s.ranges.length && s.partialAt === Infinity) return [];
  if (tail && s.deepPartialAt !== Infinity) {
    // Everything from the earliest cut-off secret that holds enough of it goes (a complete match it overlaps too).
    let from = s.deepPartialAt;
    for (const [a, b] of s.ranges) if (a < from && b > from) from = a;
    return [...s.ranges.filter(([, b]) => b <= from), [from, text.length]];
  }
  return s.ranges;
}

/**
 * Texts that are read one after another (the text parts of a message, around its tool calls) scrubbed as one
 * text (round 26): a secret split across them is found, and masked in each piece it touches — the marker goes
 * where it starts.
 */
export function scrubJoined(texts: string[], opts: { registry?: KnownSecrets } = {}): string[] {
  if (texts.length < 2) return texts.map((t) => scrubKnown(t, opts));
  const joined = texts.join("");
  const masks = knownMasks(joined, opts);
  if (!masks.length) return texts;
  const out: string[] = [];
  let o = 0;
  for (const t of texts) {
    const end = o + t.length;
    let piece = "";
    let at = o;
    for (const [a, b] of masks) {
      if (b <= o || a >= end) continue;
      const from = Math.max(a, o);
      piece += joined.slice(at, from) + (a >= o ? KNOWN_PLACEHOLDER : "");
      at = Math.min(b, end);
    }
    out.push(piece + joined.slice(at, end));
    o = end;
  }
  return out;
}

/**
 * A message's parts: every value scrubbed on its own, then the text parts — and, separately, the reasoning parts —
 * as one text each (`scrubJoined`).
 */
export function scrubParts<P>(parts: P[], opts: { registry?: KnownSecrets } = {}): P[] {
  // Every value on its own — but a text or reasoning part's text only for complete matches: whether its end is a
  // cut-off secret is judged on the joined text (round 27: a part ending in a secret's first letters stays).
  let changedAny = false;
  const deep = parts.map((p) => {
    const q = p as { type?: unknown; text?: unknown };
    let r: P;
    if ((q.type === "text" || q.type === "reasoning") && typeof q.text === "string") {
      const { text, ...rest } = q;
      const restOut = scrubKnownDeep(rest, opts);
      const textOut = scrubKnown(text, { ...opts, tail: false });
      r = restOut === rest && textOut === text ? p : ({ ...restOut, text: textOut } as P);
    } else r = scrubKnownDeep(p, opts);
    if (r !== p) changedAny = true;
    return r;
  });
  let out = changedAny ? deep : parts;
  for (const type of ["text", "reasoning"]) {
    const idx = out.flatMap((p, k) =>
      (p as { type?: unknown; text?: unknown }).type === type &&
      typeof (p as { text?: unknown }).text === "string"
        ? [k]
        : [],
    );
    if (!idx.length) continue;
    const texts = idx.map((k) => (out[k] as { text: string }).text);
    const next = scrubJoined(texts, opts);
    if (next.every((t, j) => t === texts[j])) continue;
    out = out === parts || out === deep ? [...out] : out;
    idx.forEach((k, j) => (out[k] = { ...(out[k] as object), text: next[j] } as P));
  }
  return out;
}

/** `scrubKnown` on every string (and object key) of a JSON-like value. Returns the same value when nothing changed. */
export function scrubKnownDeep<T>(
  value: T,
  opts: { tail?: boolean; registry?: KnownSecrets; numberMask?: string | null } = {},
): T {
  if (!(opts.registry ?? knownSecrets).matcher()) return value;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return scrubKnown(v, opts);
    // A number is compared by its canonical text (round 25: an all-digit secret returned as a JSON number). It
    // becomes the marker — or `numberMask` (null for chart and table data, which treat it as missing).
    if (typeof v === "number" || typeof v === "bigint") {
      const t = String(v);
      return scrubKnown(t, opts) === t
        ? v
        : opts.numberMask === undefined
          ? KNOWN_PLACEHOLDER
          : opts.numberMask;
    }
    if (!v || typeof v !== "object") return v;
    if (depth > 64) {
      // Too deep to walk: the subtree is scrubbed as its JSON text, and replaced by that text if anything was
      // found — never handed back as it was (round 26).
      let json: string;
      try {
        json = JSON.stringify(v) ?? "";
      } catch {
        return KNOWN_PLACEHOLDER;
      }
      const t = scrubKnown(json, opts);
      return t === json ? v : t;
    }
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
 * An artifact version's content (round 26): canonical JSON (chart, table, document) is scrubbed value by value
 * and stays valid JSON (a numeric secret becomes a string); any other content as text.
 */
export function scrubContent(content: string, opts: { registry?: KnownSecrets } = {}): string {
  const text = scrubKnown(content, opts);
  if (text === content) return content;
  const head = content.trimStart()[0];
  if (head === "{" || head === "[")
    try {
      // A masked number becomes null: charts skip it (the other bars keep their scale), tables show an empty cell.
      return JSON.stringify(scrubKnownDeep(JSON.parse(content) as unknown, { ...opts, numberMask: null }));
    } catch {
      // not JSON: the text scrub stands
    }
  return text;
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
    const s = scan(text, m, "stream");
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

/**
 * A run's stored events scrubbed as one stream (round 25): the text deltas go through one `StreamScrubber` in
 * order, so a secret registered after it was streamed in pieces cannot be rebuilt by joining the deltas of a
 * replay; held text moves into a later delta, and what is left at the end goes into the last one. Every other
 * event is scrubbed on its own.
 */
export function scrubEventSequence<E extends { data: unknown }>(
  events: E[],
  registry: KnownSecrets = knownSecrets,
): E[] {
  if (!registry.matcher()) return events;
  // The deltas joined hold no secret (the normal case): each event as it is, scrubbed on its own — a replay then
  // shows exactly what the live stream showed. Only a secret across deltas rewrites the sequence.
  const joined = events
    .map((e) => e.data as { type?: unknown; text?: unknown } | null)
    .map((d) => (d && d.type === "delta" && typeof d.text === "string" ? d.text : ""))
    .join("");
  if (scrubKnown(joined, { tail: false, registry }) === joined)
    return events.map((e) => ({ ...e, data: scrubKnownDeep(e.data, { tail: false, registry }) }));
  const scrubber = new StreamScrubber(registry);
  let lastDelta = -1;
  const out = events.map((e, k) => {
    const d = e.data as { type?: unknown; text?: unknown } | null;
    if (d && d.type === "delta" && typeof d.text === "string") {
      lastDelta = k;
      return { ...e, data: { ...scrubKnownDeep(d, { tail: false, registry }), text: scrubber.push(d.text) } };
    }
    return { ...e, data: scrubKnownDeep(e.data, { tail: false, registry }) };
  });
  const rest = scrubber.end();
  if (rest && lastDelta >= 0) {
    const e = out[lastDelta]!;
    out[lastDelta] = {
      ...e,
      data: { ...(e.data as object), text: (e.data as { text: string }).text + rest },
    };
  }
  return out;
}
