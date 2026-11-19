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
/** The span read after `//` for the userinfo and joined candidates (a host alone is ≤ 253). */
const AUTHORITY_MAX = HOST_MAX + 128;
/** A host character: a Unicode letter, digit or mark, `-` or `.` (anything else ends candidate (a)). */
const HOST_CHAR = /[\p{L}\p{N}\p{M}.-]/u;
/**
 * What ends the span (candidates (b), (c)): whitespace other than tab and newline (those the URL parser removes), the
 * URL's own delimiters `/ ? #` and `\`, quotes, `<` `>` and the backtick.
 */
/* eslint-disable no-control-regex -- control characters end a URL */
const SPAN_END =
  /[/?#\\"'<>`\u0000-\u0008\u000b\u000c\u000e-\u001f\u0020\u007f\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/;
/* eslint-enable no-control-regex */
/** The page's own placeholder base (relative URLs resolve there): never an external host. */
export const PAGE_HOST = "artifact.invalid";

/** The maximal run of host characters at the start of `s` (candidate (a)). */
function hostRun(s: string): string {
  let i = 0;
  while (i < s.length && i < HOST_MAX + 64 && HOST_CHAR.test(s[i]!)) i++;
  return s.slice(0, i);
}

/**
 * A candidate as a host name: trailing dots and hyphens trimmed, a `:port` dropped, `domainToASCII` (a Unicode host
 * and its punycode form are one host), then a name with a dot and a top-level label of letters or punycode — not an
 * IP address, not the page's own `artifact.invalid`.
 */
function asHost(candidate: string): string | undefined {
  const raw = candidate.replace(/:\d*$/, "").replace(/[.-]+$/, "");
  if (!raw || raw.length > HOST_MAX + 64) return undefined;
  const ascii = domainToASCII(raw).replace(/\.+$/, "");
  if (!ascii || ascii.length > HOST_MAX || ascii === PAGE_HOST) return undefined;
  const labels = ascii.split(".");
  if (labels.length < 2 || !labels.every((l) => l.length > 0 && l.length <= 63)) return undefined;
  return TLD.test(labels[labels.length - 1]!) ? ascii : undefined;
}

/**
 * External addresses **mentioned** in a text (review #209 round 5 — a deliberate choice): every `https://host`,
 * `http://host` and protocol-relative `//host`, wherever it appears — attributes, CSS, SVG, scripts, plain text or
 * links alike. Over-inclusive on purpose: a host that is only mentioned is listed too, and so is every plausible
 * reading of an address (review #209 round 7: rather than one parse that some input always defeats, the **union** of
 * a few bounded readings). For each `//` (extra `/` and `\` after it skipped):
 * - (a) the run of host characters right after it — it ends at `!`, `&`, `,`, `:`, a newline, …;
 * - (b) the same run after the last `@` within the span (`last,first@docs.example.org`);
 * - (c) the run at the start of the span with tabs and newlines removed (a host split by a newline).
 * The span runs to whitespace other than tab and newline, `/ ? # \`, a quote, `<`, `>` or the backtick, at most
 * `AUTHORITY_MAX` characters; the scan resumes after it, so no stretch of the text is read twice. Each candidate goes
 * through `asHost`. At most 10, sorted.
 */
export function mentionedHosts(...texts: string[]): string[] {
  const hosts = new Set<string>();
  const add = (c: string) => {
    const h = asHost(c);
    if (h && hosts.size < 10) hosts.add(h);
  };
  for (const text of texts) {
    let from = 0;
    while (hosts.size < 10) {
      const at = text.indexOf("//", from);
      if (at === -1) break;
      let i = at + 2;
      while (i < text.length && (text[i] === "/" || text[i] === "\\")) i++;
      const start = i;
      while (i < text.length && i - start < AUTHORITY_MAX && !SPAN_END.test(text[i]!)) i++;
      const span = text.slice(start, i);
      add(hostRun(span));
      const last = span.lastIndexOf("@");
      if (last !== -1) add(hostRun(span.slice(last + 1)));
      const joined = span.replace(/[\t\r\n]/g, "");
      if (joined !== span) add(hostRun(joined));
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
