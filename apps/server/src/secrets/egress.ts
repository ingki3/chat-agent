import { KnownSecrets, knownSecrets, scrubKnown } from "./known.js";

/**
 * The one egress predicate (review #111, #113): whether an outbound request — every text of it the server puts on
 * the wire: URL (host, path, query, fragment), header values, body, a redirect hop, a provider's query — carries a
 * secret this server knows. Every outbound tool (finance, web_search, web_fetch) asks this one function before any
 * job or provider call exists; nothing keeps a copy of its own.
 *
 * Within ONE request (the decided bar, docs/ops.md §30·§40):
 * - a whole known secret (the process-wide registry, and the caller's configured values) in any encoding the shared
 *   matcher knows (`scrubKnown`: raw, JSON/JS/Python escapes, octal, percent, base64, hex, a cut-off tail — with
 *   one transport layer);
 * - any `EGRESS_WINDOW`-character window of a known or configured secret (all of a shorter one), raw or in one
 *   decoded view (`decodedViews`: one encoding, optionally inside one transport layer).
 * Fragments shorter than a window spread over several requests are out of scope (the sender would already have to
 * know the value; the model never receives one). The check sees what the server knows when it runs; a value
 * registered after that is out of scope for that request.
 *
 * Only known values are ever matched — ordinary text is never refused for looking like a key.
 */

/** Characters of a secret that count as a leak of it (any window this long; all of a shorter value). */
export const EGRESS_WINDOW = 16;

export type EgressCheck = {
  /** Values the caller holds in addition to the registry (e.g. the finance tool secrets, however short). */
  config?: readonly string[];
  /** The registry to check against (default: the process-wide one). */
  registry?: KnownSecrets;
};

/** Whether any of these texts (the parts of one request) carries a known or configured secret. */
export function carriesSecret(texts: readonly string[], o: EgressCheck = {}): boolean {
  const registry = o.registry ?? knownSecrets;
  const config = (o.config ?? []).filter((v) => v.length > 0);
  let cfg: KnownSecrets | undefined;
  if (config.length) {
    cfg = new KnownSecrets();
    for (const v of config) cfg.add(v, { fresh: true });
  }
  // Header values are Latin-1 in Node: UTF-8 bytes from a response (a Set-Cookie) come back as one character per
  // byte and go out as those same bytes (#127 round 3). Such a text is also checked as the UTF-8 it is on the wire.
  const parts = texts
    .filter((t) => typeof t === "string" && t.length > 0)
    .flatMap((t) => {
      const latin1 = /[\x80-\xff]/.test(t) && [...t].every((c) => c.charCodeAt(0) <= 0xff);
      const wire = latin1 ? Buffer.from(t, "latin1").toString("utf8") : t;
      return wire === t ? [t] : [t, wire];
    });
  if (!parts.length) return false;
  // Whole values: the shared matcher (raw and every encoding it knows).
  // A request part is a finished text: no cut-off tail rule (a public JWT header at the end of a URL is not a
  // secret, review #127 round 2) — a cut-off secret is still found by its windows below.
  const whole = (t: string, r: KnownSecrets) => scrubKnown(t, { registry: r, tail: false }) !== t;
  if (parts.some((t) => whole(t, registry) || (cfg && whole(t, cfg)))) return true;
  // A short configured value's base64 / hex is too short for the run decoders: its exact forms (#113 review).
  if (config.length && parts.some((t) => carriesShortForms(t, config))) return true;
  // Windows: of the registry's values (cached per generation) and of the configured ones.
  const reg = registryWindows(registry);
  const extra = windowsOf(config.map(windowed));
  const hit = (view: string) => reg.matches(view) || extra.matches(view);
  if (reg.empty && extra.empty) return false;
  return parts.some((t) => decodedViews(t).some(hit));
}

/**
 * The texts of a URL to check (#113): as given, as the URL parser normalises it (what goes on the wire), and its path
 * read back — the parser turns `\` in a path into `/` (`\u0041` goes out as `/u0041`), so the `/`s before an escape
 * letter or octal digit are also read as the `\` they were. Every outbound tool checks URLs through this.
 */
export function urlTexts(raw: string): string[] {
  const out = [raw];
  try {
    const u = new URL(raw);
    if (u.href !== raw) out.push(u.href);
    const back = u.pathname.replace(/\/+(?=[uUx0-7])/g, "\\");
    if (back !== u.pathname) out.push(back);
  } catch {
    // not a URL: checked as it is (and refused before it is sent)
  }
  return out;
}

/**
 * The URL without one query parameter `name=value` — the first exact occurrence only (an allowed place, review
 * #127 round 2): another parameter of the same name, or the same pair a second time, stays and is checked.
 */
export function withoutParam(raw: string, name: string, value: string): string {
  const q = raw.indexOf("?");
  if (q < 0) return raw;
  const h = raw.indexOf("#", q);
  const end = h < 0 ? raw.length : h;
  const params = raw.slice(q + 1, end).split("&");
  const forms = new Set([`${name}=${value}`, `${name}=${encodeURIComponent(value)}`]);
  const i = params.findIndex((x) => forms.has(x));
  if (i < 0) return raw;
  params.splice(i, 1);
  return `${raw.slice(0, q)}${params.length ? `?${params.join("&")}` : ""}${raw.slice(end)}`;
}

/**
 * The query sent in place of one that carries a known secret (watchlist search, review #111 round 3; web_search,
 * #113): fixed, never the user's text, harmless, and its hits are never shown.
 */
export const SEARCH_DECOY = "agentlee decoy no match";

/** The base64 (both alphabets, with and without padding) and hex forms of a value's UTF-8 bytes. */
function exactForms(v: string): { cased: string[]; hex: string } {
  const b = Buffer.from(v, "utf8");
  const b64 = b.toString("base64");
  return {
    cased: [...new Set([b64, b64.replace(/=+$/, ""), b.toString("base64url")])],
    hex: b.toString("hex"),
  };
}

/**
 * Whether a text carries a configured value shorter than a window as base64 or hex of its own (the run decoders
 * need 8 characters): looked for in the text and with one transport layer taken off, whitespace removed too.
 */
function carriesShortForms(text: string, config: readonly string[]): boolean {
  const forms = config.filter((v) => v.length < EGRESS_WINDOW).map(exactForms);
  if (!forms.length) return false;
  return transportLayers(text).some((layer) =>
    [layer, layer.replace(/\s+/g, "")].some((t) => {
      const lower = t.toLowerCase();
      return forms.some((f) => lower.includes(f.hex) || f.cased.some((c) => t.includes(c)));
    }),
  );
}

/**
 * What of a value is windowed. A JWT's header (`eyJhbGciOi…`) is public and the same across tokens of one issuer:
 * only its payload and signature are (the whole token is still matched whole). Anything else: all of it.
 */
function windowed(v: string): string {
  const m = /^([A-Za-z0-9_-]{8,})\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)$/.exec(v);
  if (!m) return v;
  try {
    const header = JSON.parse(Buffer.from(m[1]!, "base64url").toString("utf8")) as unknown;
    if (header && typeof header === "object" && "alg" in header) return `${m[2]}.${m[3]}`;
  } catch {
    // not a JWT
  }
  return v;
}

type Windows = { empty: boolean; matches(view: string): boolean };

/** Windows of these values: every `EGRESS_WINDOW`-character slice of a long one, a shorter one whole. */
function windowsOf(values: readonly string[]): Windows {
  const long = new Set<string>();
  const short = new Set<string>();
  for (const v of values) {
    if (!v) continue;
    if (v.length < EGRESS_WINDOW) short.add(v);
    else for (let i = 0; i + EGRESS_WINDOW <= v.length; i++) long.add(v.slice(i, i + EGRESS_WINDOW));
  }
  const shorts = [...short];
  return {
    empty: !long.size && !shorts.length,
    matches(view) {
      if (long.size)
        for (let i = 0; i + EGRESS_WINDOW <= view.length; i++)
          if (long.has(view.slice(i, i + EGRESS_WINDOW))) return true;
      return shorts.some((s) => view.includes(s));
    },
  };
}

const cache = new WeakMap<KnownSecrets, { gen: number; windows: Windows }>();

/**
 * The registry's windows, from each value whole (not the matcher's pieces: a window across a piece boundary counts).
 * A JSON credential document is registered whole and by each secret string inside it: only those strings are
 * windowed — the document's structure (`{"access_token":`) is not a secret of its own. Which values are documents is
 * what the registry recorded (`addCredential`), not what a value looks like.
 */
function registryWindows(registry: KnownSecrets): Windows {
  const c = cache.get(registry);
  if (c && c.gen === registry.generation) return c.windows;
  const windows = windowsOf(registry.windowSources().map(windowed));
  cache.set(registry, { gen: registry.generation, windows });
  return windows;
}

/** Runs of `%XX` decoded as UTF-8 bytes (invalid sequences become U+FFFD); everything else as it is. */
function percentDecode(t: string, plus: boolean): string | undefined {
  if (!t.includes("%") && !(plus && t.includes("+"))) return undefined;
  const s = plus ? t.replace(/\+/g, " ") : t;
  return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) =>
    Buffer.from(run.replace(/%/g, ""), "hex").toString("utf8"),
  );
}

const SIMPLE: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  v: "\v",
  a: "\x07",
};

/**
 * One layer of JSON / JS / Python string escapes decoded: `\uXXXX`, `\u{X…}`, `\UXXXXXXXX`, `\xHH`, octal `\ooo`,
 * the simple ones; any other escaped character stands for itself. `bytes`: `\xHH` and octal escapes are bytes read
 * as UTF-8 (a Python bytes literal / C string), otherwise each is one code point.
 */
function escapeDecode(t: string, bytes: boolean): string | undefined {
  if (!t.includes("\\")) return undefined;
  const re = /\\(u\{[0-9A-Fa-f]{1,6}\}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|x[0-9A-Fa-f]{2}|[0-7]{1,3}|[\s\S])/g;
  let out = "";
  let pending: number[] = [];
  let last = 0;
  const flush = () => {
    if (pending.length) out += Buffer.from(pending).toString("utf8");
    pending = [];
  };
  const cp = (n: number) => (n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "");
  for (const m of t.matchAll(re)) {
    const e = m[1]!;
    const between = t.slice(last, m.index);
    if (between) {
      flush();
      out += between;
    }
    last = m.index + m[0].length;
    let byte: number | undefined;
    let text: string;
    if (e[0] === "u" && e[1] === "{") text = cp(parseInt(e.slice(2, -1), 16));
    else if (e[0] === "u" && e.length === 5) text = String.fromCharCode(parseInt(e.slice(1), 16));
    else if (e[0] === "U" && e.length === 9) text = cp(parseInt(e.slice(1), 16));
    else if (e[0] === "x" && e.length === 3) {
      byte = parseInt(e.slice(1), 16);
      text = String.fromCharCode(byte);
    } else if (/^[0-7]+$/.test(e)) {
      const n = parseInt(e, 8);
      if (n <= 0xff) byte = n;
      text = String.fromCharCode(n);
    } else text = SIMPLE[e] ?? e;
    if (bytes && byte !== undefined) {
      pending.push(byte);
      continue;
    }
    flush();
    out += text;
  }
  flush();
  return out + t.slice(last);
}

/** The decodes of a base64 / hex run at every alignment, each as UTF-8 and as Latin-1 text. */
function runDecodes(layer: string): string[] {
  const out: string[] = [];
  const add = (b: Buffer) => {
    if (b.length) out.push(b.toString("utf8"), b.toString("latin1"));
  };
  // Both base64 alphabets (Node's decoder reads `-` `_` as well as `+` `/`); padding ends a run. A run may start
  // with something that is not part of the encoding (`/path/<base64>`): every alignment is decoded.
  for (const [run] of layer.matchAll(/[A-Za-z0-9+/_-]{8,}/g))
    for (let k = 0; k < 4 && run.length - k >= 8; k++) add(Buffer.from(run.slice(k), "base64"));
  for (const [run] of layer.matchAll(/[0-9A-Fa-f]{8,}/g))
    for (let k = 0; k < 2; k++) {
      const s = run.slice(k);
      add(Buffer.from(s.slice(0, s.length - (s.length % 2)), "hex"));
    }
  return out;
}

/** One encoding decoded, every way: percent, string escapes (code points or bytes), base64, hex. */
function oneDecode(layer: string): string[] {
  const out: string[] = [];
  for (const v of [
    percentDecode(layer, false),
    percentDecode(layer, true),
    escapeDecode(layer, false),
    escapeDecode(layer, true),
  ])
    if (v !== undefined && v !== layer) out.push(v);
  out.push(...runDecodes(layer));
  // Base64 / hex as it is often written: broken by spaces or lines (MIME's 76 columns, CRLF), a window across one.
  const solid = layer.replace(/\s+/g, "");
  if (solid !== layer) out.push(...runDecodes(solid));
  return out;
}

/** The text, and the text with one transport layer (percent-encoding or JSON string escaping) taken off. */
function transportLayers(text: string): string[] {
  const out = [text];
  for (const v of [percentDecode(text, false), percentDecode(text, true), escapeDecode(text, false)])
    if (v !== undefined && !out.includes(v)) out.push(v);
  return out;
}

/**
 * What a text can say once decoded (the common-encodings bound): the text itself and one encoding of it decoded
 * (percent, JSON/JS/Python escapes incl. octal, base64 at any alignment, hex) — on the text, and on the text with
 * one transport layer (percent-encoding or JSON string escaping) taken off first. A secret's windows are looked for
 * in every one of them.
 */
export function decodedViews(text: string): string[] {
  const views = new Set<string>();
  for (const t of transportLayers(text)) {
    views.add(t);
    for (const v of oneDecode(t)) views.add(v);
  }
  return [...views];
}
