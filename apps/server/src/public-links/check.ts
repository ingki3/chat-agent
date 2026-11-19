import type { PublicLinkCheck } from "@agentlee/shared";
import { domainToASCII } from "node:url";
import { knownMasks, type KnownSecrets } from "../secrets/known.js";

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
/** The longest host name (RFC 1035). */
const HOST_MAX = 253;
/** The authority read after `//`: userinfo, host and port together, at most this long (a host alone is ≤ 253). */
const AUTHORITY_MAX = HOST_MAX + 128;
/**
 * What ends an authority: the URL's own delimiters (`/ ? # \`), whitespace other than tab and newline (those the URL
 * parser removes), and characters that close or separate a URL in HTML, CSS or prose (`" ' < > ( ) , ; [ ] { } |`
 * and the backtick).
 */
/* eslint-disable no-control-regex -- control characters end a URL */
const AUTHORITY_END =
  /[/?#\\"'<>(),;[\]{}|`\u0000-\u0008\u000b\u000c\u000e-\u001f\u0020\u007f\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;
/* eslint-enable no-control-regex */
/** The page's own placeholder base (relative URLs resolve there): never an external host. */
export const PAGE_HOST = "artifact.invalid";

/**
 * The host of the authority `span` (what follows `//`), normalised as the URL parser would: tabs and newlines
 * removed, userinfo dropped up to the last `@`, a `:port` dropped, then `domainToASCII` — so a Unicode host
 * (`도서관.example.org`) and its punycode form are the same host — and trailing dots trimmed. Undefined when it is not
 * a name with a dot and a top-level label of letters or punycode (an IP address, `// comment`, `//todo`).
 */
function hostOf(span: string): string | undefined {
  let a = span.replace(/[\t\r\n]/g, "");
  const at = a.lastIndexOf("@");
  if (at !== -1) a = a.slice(at + 1);
  a = a.replace(/:\d*$/, "");
  if (!a || a.length > HOST_MAX + 64) return undefined;
  const ascii = domainToASCII(a).replace(/\.+$/, "");
  if (!ascii || ascii.length > HOST_MAX) return undefined;
  const labels = ascii.split(".");
  if (labels.length < 2 || !labels.every((l) => l.length > 0 && l.length <= 63)) return undefined;
  return TLD.test(labels[labels.length - 1]!) ? ascii : undefined;
}

/**
 * External addresses **mentioned** in a text (review #209 round 5 — a deliberate choice): every `https://host`,
 * `http://host` and protocol-relative `//host`, wherever it appears — attributes, CSS, SVG, scripts, plain text or
 * links alike. Over-inclusive on purpose: a host that is only mentioned (a link, a sentence) is listed too, and none
 * that a page could load from is missed, however its HTML, CSS or `srcset` is written. (An earlier HTML/CSS scanner
 * kept missing edge cases.) The notice says so: these are the addresses the document names, any of which the public
 * page may load from.
 *
 * One pass: anchored at each `//`; extra slashes after it are skipped (`https:///host`), then the authority is read
 * up to its first delimiter (`AUTHORITY_END`) and at most `AUTHORITY_MAX` characters, and the scan resumes after it —
 * no stretch of the text is read twice. The host is normalised by `hostOf` (Unicode and punycode alike); the page's
 * own `artifact.invalid` is left out. At most 10, sorted.
 */
export function mentionedHosts(...texts: string[]): string[] {
  const hosts = new Set<string>();
  for (const text of texts) {
    let from = 0;
    while (hosts.size < 10) {
      const at = text.indexOf("//", from);
      if (at === -1) break;
      let i = at + 2;
      while (i < text.length && (text[i] === "/" || text[i] === "\\")) i++;
      const start = i;
      while (i < text.length && i - start < AUTHORITY_MAX && !AUTHORITY_END.test(text[i]!)) i++;
      const host = i > start ? hostOf(text.slice(start, i)) : undefined;
      if (host && host !== PAGE_HOST) hosts.add(host);
      from = Math.max(i, at + 2);
    }
  }
  return [...hosts].sort();
}

const countOf = (re: RegExp, text: string) => text.match(re)?.length ?? 0;

/**
 * What a version holds that the public should not see, or should know about (#204, issue §4):
 * - `secret`: a known secret value (the registry every response is scrubbed with, secrets/known.ts) in its stored
 *   title or content — the link is refused.
 * - `emails`, `phones`: how many email addresses and phone numbers it shows — a warning only.
 * - `externalHosts`: every external address the version names (`mentionedHosts` — over-inclusive by design); the
 *   public page may load from any of them (in fact only allow-listed CDN scripts load; the sandbox CSP blocks the
 *   rest), and a visitor's browser then tells that site it was there.
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
    externalHosts: mentionedHosts(v.title, v.content),
  };
}
