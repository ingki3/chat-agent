import type { PublicLinkCheck } from "@agentlee/shared";
import { knownMasks, type KnownSecrets } from "../secrets/known.js";
import { findScripts } from "../artifacts/serve.js";

const LOCAL_CHAR = /[A-Za-z0-9._%+-]/;
const DOMAIN_CHAR = /[A-Za-z0-9.-]/;
/** RFC 5321 limits: a local part of at most 64 characters, a domain of at most 255. */
const LOCAL_MAX = 64;
/** A top-level domain: letters, or an IDN in its ASCII (punycode) form — `xn--3e0b707e` is `.한국`. */
const TLD = /^(?:[A-Za-z]{2,63}|xn--[A-Za-z0-9-]{1,59})$/;
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
const HOST_CHAR = /[A-Za-z0-9.-]/;
/** Attribute names (and CSS `url(` / `@import`) whose value a browser loads; the `=` after a name may be spaced. */
const TRIGGER =
  /\b(?:src|href|srcset|poster|data|action|xlink:href)(?=[\t\n\f\r ]*=)|url\(|@import(?=[\t\n\f\r ])/gi;
/** Markdown images `![alt](https://…)`: the alt text bounded, so no start rescans the text. */
const MD_IMAGE = /!\[[^\]\n]{0,300}\]\(\s{0,16}(?:https?:)?\/\/([A-Za-z0-9.-]{1,253})/gi;

/**
 * The host of an absolute or scheme-relative URL starting at `i` (after optional whitespace, `=`, a quote), or
 * undefined. A hand-written scan: each character is looked at a fixed number of times, however long a run of
 * whitespace — HTML allows any amount around `=` (review #209: a regex with a bounded run missed `src=\n   "…"`).
 */
function hostAt(text: string, i: number): string | undefined {
  const skip = () => {
    while (i < text.length && WS.test(text[i]!)) i++;
  };
  skip();
  if (text[i] === "=") {
    i++;
    skip();
  }
  if (text[i] === '"' || text[i] === "'") {
    i++;
    skip();
  }
  const rest = text.slice(i, i + 8).toLowerCase();
  if (rest.startsWith("https:")) i += 6;
  else if (rest.startsWith("http:")) i += 5;
  if (text[i] !== "/" || text[i + 1] !== "/") return undefined;
  i += 2;
  const start = i;
  while (i < text.length && i - start < 253 && HOST_CHAR.test(text[i]!)) i++;
  return i > start ? text.slice(start, i).toLowerCase() : undefined;
}

/**
 * Hosts a page refers to for loading: every `<script src>` exactly as `prepareHtml` finds it (the same tokenizer —
 * `findScripts`), and `src=`/`href=`/`srcset=`/`poster=`/`data=`/`action=` attributes, CSS `url(…)` and `@import`,
 * and markdown images. At most 10.
 */
export function externalHosts(content: string): string[] {
  const hosts = new Set<string>();
  const add = (h: string | undefined) => {
    if (h && hosts.size < 10) hosts.add(h);
  };
  for (const s of findScripts(content)) {
    const src = s.attrs.get("src");
    if (src !== undefined) add(hostAt(src, 0));
  }
  for (const m of content.matchAll(TRIGGER)) {
    if (hosts.size >= 10) break;
    add(hostAt(content, m.index + m[0].length));
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
