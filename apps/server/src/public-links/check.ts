import type { PublicLinkCheck } from "@agentlee/shared";
import { knownMasks, type KnownSecrets } from "../secrets/known.js";
import { findScripts } from "../artifacts/serve.js";

const LOCAL_CHAR = /[A-Za-z0-9._%+-]/;
const DOMAIN_CHAR = /[A-Za-z0-9.-]/;
/** RFC 5321 limits: a local part of at most 64 characters, a domain of at most 255. */
const LOCAL_MAX = 64;
/** A top-level domain: letters, or an IDN in its ASCII (punycode) form — `xn--3e0b707e` is `.한국`. */
const TLD = /^(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})$/i;
const DOMAIN_MAX = 255;

/**
 * How many email addresses (a common, not exhaustive, shape: `local@label.label.tld`) a text holds. A linear scan
 * anchored at each `@` that looks at most `LOCAL_MAX` characters before it and `DOMAIN_MAX` after it — never a
 * regular expression that could rescan the same stretch from every start (review #209: up to 512 KiB, on the event
 * loop). An address is counted once, at its `@`.
 */
export function countEmails(text: string): number {
  let n = 0;
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    let l = at;
    while (l > 0 && at - l < LOCAL_MAX && LOCAL_CHAR.test(text[l - 1]!)) l--;
    if (l === at) continue;
    let r = at + 1;
    while (r < text.length && r - at - 1 < DOMAIN_MAX && DOMAIN_CHAR.test(text[r]!)) r++;
    // Trailing dots or hyphens are punctuation, not the domain.
    let end = r;
    while (end > at + 1 && (text[end - 1] === "." || text[end - 1] === "-")) end--;
    const domain = text.slice(at + 1, end);
    const labels = domain.split(".");
    if (labels.length >= 2 && labels.every((x) => x.length > 0) && TLD.test(labels[labels.length - 1]!)) n++;
  }
  return n;
}
/**
 * Phone numbers (every quantifier bounded, so each start position costs a fixed amount — linear in the text): Korean mobile and area numbers (010-1234-5678, 02 123 4567, 01012345678) and international ones
 * (+82 10-1234-5678). Digits not glued to other digits.
 */
const PHONE =
  /(?<![\d])(?:\+\d{1,3}[ .-]?)?(?:0\d{1,2}|\d{2,3})[ .-]\d{3,4}[ .-]\d{4}(?![\d])|(?<![\d])01[016789]\d{7,8}(?![\d])/g;
const WS = /[\t\n\f\r ]/;
/** Attribute names (and CSS `url(` / `@import`) whose value a browser loads; the `=` after a name may be spaced. */
const TRIGGER =
  /\b(?:src|href|srcset|poster|data|action|xlink:href)(?=[\t\n\f\r ]*=)|url\(|@import(?=[\t\n\f\r ])/gi;
/** Markdown images `![alt](https://…)`: the alt text bounded, so no start rescans the text. */
const MD_IMAGE = /!\[[^\]\n]{0,300}\]\(\s{0,16}(?:https?:)?\/\/([A-Za-z0-9.-]{1,253})/gi;
/** Longest attribute value looked at (a URL is far shorter; the bound keeps every value's work fixed). */
const VALUE_MAX = 2048;

/** Where the page's own relative URLs resolve: a host of its own, never reported (review #209 round 3). */
export const PAGE_BASE = "https://artifact.invalid/";

/**
 * The host a URL attribute value loads from, as the browser resolves it: the value trimmed of leading and trailing C0
 * controls and spaces and stripped of tabs and newlines (the URL parser's own preprocessing — a vertical tab or form
 * feed in front still loads), then `new URL(value, PAGE_BASE)`. Only http(s) hosts other than the page's own.
 */
export function hostOfUrl(raw: string): string | undefined {
  const value = raw
    .slice(0, VALUE_MAX)
    // eslint-disable-next-line no-control-regex -- the URL parser's C0 control and space trimming
    .replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "")
    .replace(/[\t\n\r]/g, "");
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value, PAGE_BASE);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  return url.host === new URL(PAGE_BASE).host ? undefined : url.hostname.toLowerCase();
}

/**
 * The value after a trigger at `i`, and where it ends: `= "…"`, `= '…'` or an unquoted run for an attribute; up to
 * `)` for `url(`; the quoted string (or `url(…)`) after `@import`. Whitespace of any length around `=` is skipped
 * (HTML allows it); a value is at most `VALUE_MAX` characters.
 */
function valueAt(text: string, i: number, kind: "attr" | "url" | "import"): { value: string; end: number } {
  const skip = () => {
    while (i < text.length && WS.test(text[i]!)) i++;
  };
  skip();
  if (kind === "attr") {
    if (text[i] !== "=") return { value: "", end: i };
    i++;
    skip();
  }
  if (kind === "import" && text.slice(i, i + 4).toLowerCase() === "url(") return valueAt(text, i + 4, "url");
  const q = text[i];
  if (q === '"' || q === "'") {
    const close = text.indexOf(q, i + 1);
    const end = close === -1 || close - i > VALUE_MAX ? Math.min(text.length, i + 1 + VALUE_MAX) : close;
    return { value: text.slice(i + 1, end), end };
  }
  const start = i;
  const stop = kind === "url" ? /[)]/ : /[\t\n\f\r >]/;
  while (i < text.length && i - start < VALUE_MAX && !stop.test(text[i]!)) i++;
  return { value: text.slice(start, i), end: i };
}

/**
 * Hosts a page refers to for loading: every `<script src>` exactly as `prepareHtml` finds it (the same tokenizer —
 * `findScripts`, the parsed value used as is), and `src=`/`href=`/`srcset=`/`poster=`/`data=`/`action=` attributes,
 * CSS `url(…)` and `@import`, and markdown images — each value resolved as the browser would (`hostOfUrl`). One
 * pass: the scan resumes after each value, so no stretch of the text is looked at twice. At most 10.
 */
export function externalHosts(content: string): string[] {
  const hosts = new Set<string>();
  const add = (h: string | undefined) => {
    if (h && hosts.size < 10) hosts.add(h);
  };
  for (const s of findScripts(content)) {
    const src = s.attrs.get("src");
    if (src !== undefined) add(hostOfUrl(src));
  }
  const re = new RegExp(TRIGGER.source, "gi");
  for (let m = re.exec(content); m && hosts.size < 10; m = re.exec(content)) {
    const t = m[0].toLowerCase();
    const kind = t === "url(" ? "url" : t === "@import" ? "import" : "attr";
    const { value, end } = valueAt(content, m.index + m[0].length, kind);
    // srcset: comma-separated "url size" candidates.
    for (const part of t === "srcset" ? value.split(",") : [value])
      add(hostOfUrl(t === "srcset" ? (part.trim().split(/\s+/)[0] ?? "") : part));
    re.lastIndex = Math.max(re.lastIndex, end);
  }
  for (const m of content.matchAll(MD_IMAGE)) {
    if (hosts.size >= 10) break;
    add(m[1]!.toLowerCase());
  }
  return [...hosts].sort();
}

const countOf = (re: RegExp, text: string) => text.match(re)?.length ?? 0;

/**
 * What a version holds that the public should not see, or should know about (#204, issue §4):
 * - `secret`: a known secret value (the registry every response is scrubbed with, secrets/known.ts) in its stored
 *   title or content — the link is refused.
 * - `emails`, `phones`: how many email addresses and phone numbers it shows — a warning only.
 * - `externalHosts`: hosts the page refers to for loading (scripts, images, styles, fonts) — a visitor's browser may
 *   contact them (only allow-listed CDN scripts actually load; the sandbox CSP blocks the rest).
 */
export function checkVersion(
  v: { version: number; title: string; content: string },
  registry?: KnownSecrets,
): PublicLinkCheck {
  const opts = registry ? { registry } : {};
  const secret = knownMasks(v.title, opts).length > 0 || knownMasks(v.content, opts).length > 0;
  return {
    version: v.version,
    secret,
    // The title is shown too (the page's heading, the download's file name): counted with the content.
    emails: countEmails(v.title) + countEmails(v.content),
    phones: countOf(PHONE, v.title) + countOf(PHONE, v.content),
    externalHosts: externalHosts(v.content),
  };
}
