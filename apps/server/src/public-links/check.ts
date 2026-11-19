import type { PublicLinkCheck } from "@agentlee/shared";
import { knownMasks, type KnownSecrets } from "../secrets/known.js";

const LOCAL_CHAR = /[A-Za-z0-9._%+-]/;
const DOMAIN_CHAR = /[A-Za-z0-9.-]/;
/** RFC 5321 limits: a local part of at most 64 characters, a domain of at most 255. */
const LOCAL_MAX = 64;
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
    if (
      labels.length >= 2 &&
      labels.every((x) => x.length > 0) &&
      /^[A-Za-z]{2,}$/.test(labels[labels.length - 1]!)
    )
      n++;
  }
  return n;
}
/**
 * Phone numbers (every quantifier bounded, so each start position costs a fixed amount — linear in the text): Korean mobile and area numbers (010-1234-5678, 02 123 4567, 01012345678) and international ones
 * (+82 10-1234-5678). Digits not glued to other digits.
 */
const PHONE =
  /(?<![\d])(?:\+\d{1,3}[ .-]?)?(?:0\d{1,2}|\d{2,3})[ .-]\d{3,4}[ .-]\d{4}(?![\d])|(?<![\d])01[016789]\d{7,8}(?![\d])/g;
/**
 * URLs a page would load: `src=`/`href=`/`srcset=`/`action=` attributes, CSS `url(…)` and `@import`, markdown images.
 * Every repetition is bounded (spaces, an image's alt text, the host), so no start position rescans the whole text.
 */
const EXTERNAL =
  /(?:\b(?:src|href|srcset|poster|data|action|xlink:href)\s{0,16}=\s{0,16}["']?\s{0,16}|url\(\s{0,16}["']?\s{0,16}|@import\s{1,16}["']\s{0,16}|!\[[^\]\n]{0,300}\]\(\s{0,16})(?:https?:)?\/\/([A-Za-z0-9.-]{1,253})/gi;

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
  const hosts = new Set<string>();
  for (const m of v.content.matchAll(EXTERNAL)) {
    hosts.add(m[1]!.toLowerCase());
    if (hosts.size >= 10) break;
  }
  return {
    version: v.version,
    secret,
    // The title is shown too (the page's heading, the download's file name): counted with the content.
    emails: countEmails(v.title) + countEmails(v.content),
    phones: countOf(PHONE, v.title) + countOf(PHONE, v.content),
    externalHosts: [...hosts].sort(),
  };
}
