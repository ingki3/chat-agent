import type { PublicLinkCheck } from "@agentlee/shared";
import { knownMasks, type KnownSecrets } from "../secrets/known.js";

/** Email addresses (a common, not exhaustive, shape). */
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/**
 * Phone numbers: Korean mobile and area numbers (010-1234-5678, 02 123 4567, 01012345678) and international ones
 * (+82 10-1234-5678). Digits not glued to other digits.
 */
const PHONE =
  /(?<![\d])(?:\+\d{1,3}[ .-]?)?(?:0\d{1,2}|\d{2,3})[ .-]\d{3,4}[ .-]\d{4}(?![\d])|(?<![\d])01[016789]\d{7,8}(?![\d])/g;
/** URLs a page would load: `src=`/`href=`/`srcset=`/`action=` attributes, CSS `url(…)` and `@import`, markdown images. */
const EXTERNAL =
  /(?:\b(?:src|href|srcset|poster|data|action|xlink:href)\s*=\s*["']?\s*|url\(\s*["']?\s*|@import\s+["']\s*|!\[[^\]]*\]\(\s*)(?:https?:)?\/\/([A-Za-z0-9.-]+)/gi;

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
    emails: countOf(EMAIL, v.content),
    phones: countOf(PHONE, v.content),
    externalHosts: [...hosts].sort(),
  };
}
