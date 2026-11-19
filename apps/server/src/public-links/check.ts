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
/** Attribute names whose value a browser loads (`style` holds CSS); the `=` after a name may be spaced. */
const ATTR = /\b(?:src|href|srcset|poster|data|action|xlink:href|style)(?=[\t\n\f\r ]*=)/gi;
/** CSS loads: `url(` and `@import` — looked for only inside CSS (`<style>` elements, `style=""` attributes). */
const CSS_LOAD = /url\(|@import(?=[\t\n\f\r ])/gi;
const STYLE_OPEN = /<style\b[^>]{0,1000}>/gi;
const STYLE_CLOSE = /<\/style[\t\n\f\r />]/gi;
/** Markdown images `![alt](https://…)`: the alt text bounded, so no start rescans the text. */
const MD_IMAGE = /!\[[^\]\n]{0,300}\]\(\s{0,16}(?:https?:)?\/\/([A-Za-z0-9.-]{1,253})/gi;
/** Longest attribute value looked at (a URL is far shorter; the bound keeps every value's work fixed). */
const VALUE_MAX = 2048;
/** Longest `style=""` value looked at for CSS loads. */
const STYLE_MAX = 64 * 1024;

/** Where the page's own relative URLs resolve: a host of its own, never reported (review #209 round 3). */
export const PAGE_BASE = "https://artifact.invalid/";
const PAGE_HOST = new URL(PAGE_BASE).host;

/** A C0 control or space: what the URL parser trims from both ends of a URL. */
const isC0 = (c: string) => c.charCodeAt(0) <= 0x20;

/**
 * The host a URL value loads from, as the browser resolves it: leading and trailing C0 controls and spaces trimmed
 * **first** (any number of them — review #209 round 4), then at most `VALUE_MAX` characters, tabs and newlines
 * removed (the URL parser's own preprocessing), then `new URL(value, PAGE_BASE)`. Only http(s) hosts other than the
 * page's own.
 */
export function hostOfUrl(raw: string): string | undefined {
  let a = 0;
  let b = raw.length;
  while (a < b && isC0(raw[a]!)) a++;
  while (b > a && isC0(raw[b - 1]!)) b--;
  if (a === b) return undefined;
  const value = raw.slice(a, Math.min(b, a + VALUE_MAX)).replace(/[\t\n\r]/g, "");
  let url: URL;
  try {
    url = new URL(value, PAGE_BASE);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  return url.host === PAGE_HOST ? undefined : url.hostname.toLowerCase();
}

/**
 * The value starting at `i` and where it ends: quoted (`"…"`, `'…'`) or an unquoted run up to `stop`. Leading C0
 * controls and spaces are skipped before the `max`-character bound is counted, and the closing quote is looked for
 * only within that bound — each character is looked at a fixed number of times.
 */
function quotedOrRun(text: string, i: number, stop: RegExp, max: number): { value: string; end: number } {
  const q = text[i];
  if (q === '"' || q === "'") {
    let j = i + 1;
    while (j < text.length && text[j] !== q && isC0(text[j]!)) j++;
    const start = j;
    while (j < text.length && text[j] !== q && j - start < max) j++;
    return { value: text.slice(start, j), end: j };
  }
  let j = i;
  while (j < text.length && isC0(text[j]!) && !stop.test(text[j]!)) j++;
  const start = j;
  while (j < text.length && j - start < max && !stop.test(text[j]!)) j++;
  return { value: text.slice(start, j), end: j };
}

/** An attribute's value after its name at `i`: `=` with any whitespace around it, then the value. */
function attrValue(text: string, i: number, max: number): { value: string; end: number } | undefined {
  while (i < text.length && WS.test(text[i]!)) i++;
  if (text[i] !== "=") return undefined;
  i++;
  while (i < text.length && WS.test(text[i]!)) i++;
  return quotedOrRun(text, i, /[\t\n\f\r >]/, max);
}

/**
 * The URLs of a `srcset` value, by the HTML candidate rules: skip whitespace and commas; the URL runs to the next
 * whitespace (a comma inside it is part of it — only trailing commas end it); descriptors run to the next comma
 * outside parentheses.
 */
export function srcsetUrls(v: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < v.length) {
    while (i < v.length && (WS.test(v[i]!) || v[i] === ",")) i++;
    if (i >= v.length) break;
    const start = i;
    while (i < v.length && !WS.test(v[i]!)) i++;
    const url = v.slice(start, i);
    if (url.endsWith(",")) {
      out.push(url.replace(/,+$/, ""));
      continue;
    }
    out.push(url);
    // Descriptors (`1x`, `200w`, …) up to the next comma outside parentheses.
    for (let depth = 0; i < v.length; i++) {
      const c = v[i];
      if (c === "(") depth++;
      else if (c === ")" && depth > 0) depth--;
      else if (c === "," && depth === 0) {
        i++;
        break;
      }
    }
  }
  return out;
}

/** Hosts a stretch of CSS loads from: `url(…)` and `@import "…"` / `@import url(…)`. One pass. */
function cssHosts(css: string, add: (h: string | undefined) => void): void {
  const re = new RegExp(CSS_LOAD.source, "gi");
  for (let m = re.exec(css); m; m = re.exec(css)) {
    let i = m.index + m[0].length;
    const skip = () => {
      while (i < css.length && WS.test(css[i]!)) i++;
    };
    let stop = /[)]/;
    skip();
    if (m[0].toLowerCase() === "@import") {
      if (css.slice(i, i + 4).toLowerCase() === "url(") {
        i += 4;
        skip();
      } else stop = /[\t\n\f\r ;]/;
    }
    const { value, end } = quotedOrRun(css, i, stop, VALUE_MAX);
    add(hostOfUrl(value));
    re.lastIndex = Math.max(re.lastIndex, end);
  }
}

/**
 * Hosts a page refers to for loading: every `<script src>` exactly as `prepareHtml` finds it (the same tokenizer —
 * `findScripts`, the parsed value used as is); `src=`/`href=`/`srcset=`/`poster=`/`data=`/`action=` attributes;
 * CSS `url(…)` and `@import` **inside CSS only** — `<style>` elements and `style=""` attributes, never body text that
 * merely mentions `url(` (review #209 round 4); and markdown images. Each value is resolved as the browser would
 * (`hostOfUrl`; `srcset` by its candidate rules). Every scan resumes after the value it read, so no stretch of the
 * text is looked at twice. At most 10.
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
  const re = new RegExp(ATTR.source, "gi");
  for (let m = re.exec(content); m && hosts.size < 10; m = re.exec(content)) {
    const name = m[0].toLowerCase();
    const v = attrValue(content, m.index + m[0].length, name === "style" ? STYLE_MAX : VALUE_MAX);
    if (!v) continue;
    if (name === "style") cssHosts(v.value, add);
    else if (name === "srcset") for (const u of srcsetUrls(v.value)) add(hostOfUrl(u));
    else add(hostOfUrl(v.value));
    re.lastIndex = Math.max(re.lastIndex, v.end);
  }
  const open = new RegExp(STYLE_OPEN.source, "gi");
  const close = new RegExp(STYLE_CLOSE.source, "gi");
  for (let m = open.exec(content); m && hosts.size < 10; m = open.exec(content)) {
    close.lastIndex = m.index + m[0].length;
    const c = close.exec(content);
    const end = c ? c.index : content.length;
    cssHosts(content.slice(m.index + m[0].length, end), add);
    open.lastIndex = Math.max(open.lastIndex, end);
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
