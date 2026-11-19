import type { PublicLinkCheck } from "@agentlee/shared";
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
const HOST_CHAR = /[A-Za-z0-9.-]/;
/** The longest host name (RFC 1035). */
const HOST_MAX = 253;
/** The page's own placeholder base (relative URLs resolve there): never an external host. */
export const PAGE_HOST = "artifact.invalid";

/**
 * External addresses **mentioned** in a text (review #209 round 5 — a deliberate choice): every `https://host`,
 * `http://host` and protocol-relative `//host`, wherever it appears — attributes, CSS, SVG, scripts, plain text or
 * links alike. Over-inclusive on purpose: a host that is only mentioned (a link, a sentence) is listed too, and none
 * that a page could load from is missed, however its HTML, CSS or `srcset` is written. (An earlier HTML/CSS scanner
 * kept missing edge cases.) The notice says so: these are the addresses the document names, any of which the public
 * page may load from.
 *
 * One pass: anchored at each `//`, at most `HOST_MAX` characters after it; a host ends at the first non-host
 * character, so no stretch of the text is read twice. A host needs a dot and a top-level label of letters or
 * punycode (`xn--…`) — `// comment` and `//todo` are not hosts. Lower-cased; at most 10.
 */
export function mentionedHosts(...texts: string[]): string[] {
  const hosts = new Set<string>();
  for (const text of texts)
    for (let at = text.indexOf("//"); at !== -1 && hosts.size < 10; at = text.indexOf("//", at + 2)) {
      let r = at + 2;
      while (r < text.length && r - at - 2 < HOST_MAX && HOST_CHAR.test(text[r]!)) r++;
      let end = r;
      while (end > at + 2 && (text[end - 1] === "." || text[end - 1] === "-")) end--;
      const host = text.slice(at + 2, end).toLowerCase();
      const labels = host.split(".");
      if (
        labels.length >= 2 &&
        labels.every((l) => l.length > 0 && l.length <= 63) &&
        TLD.test(labels[labels.length - 1]!) &&
        host !== PAGE_HOST
      )
        hosts.add(host);
      at = Math.max(at, r - 2);
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
