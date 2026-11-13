import crypto from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  CitationEntry,
  REFERENCE_LIMITS,
  boundText,
  isRealDate,
  type CitationStatus,
  type ReferenceSource,
} from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { messages, sources } from "../db/schema.js";
import { scrubKnown } from "../secrets/known.js";

/**
 * The sources of a conversation for 참고문헌 내보내기 (#26, PRD FR-5.6).
 *
 * - **What counts:** the citations of the answers *still in the conversation's history* (active assistant messages),
 *   as the server's own end-of-run note lists them (`citation_note`, built from the citation rows — a runtime cannot
 *   write it). An answer that was regenerated or cut by an edit is not in the history, and neither are its sources;
 *   a `[n]` that no `cite` produced (`unknown_source`) names no source and is left out. Web entries are completed
 *   from the conversation's own `sources` row (the access date, the page's current title) — looked up by id *and*
 *   conversation, so an id never reaches another conversation's row.
 * - **Duplicates:** web sources are one entry per address. Only what cannot change the document is normalised (the
 *   host's case, a default port, the `#fragment`); scheme, `www.`, path (a trailing slash too) and query stay part
 *   of the key. A fetched row is the document it ended at (`final_url`, else `url`); a start address joins a
 *   document only when the cited rows redirect it to exactly one (two destinations stay two documents). A page
 *   fetched twice is one source. File sources are one
 *   entry per file, the places cited in it listed in order.
 * - **Verified:** a source is verified when at least one of its citations was (the page really holds a quoted
 *   passage); otherwise it is a failed source — shown in the export screen and left out unless asked for.
 * - **Plain text and secrets:** every string that is written out (title, site, address, file name, place labels)
 *   is scrubbed of known secrets, made one line of plain text (no control, bidirectional or invisible characters)
 *   and bounded. Addresses keep http(s) only and lose any user name or password.
 */

export type CollectedSource = ReferenceSource & {
  /** Stable opaque id (hash of the de-duplication key — the address itself never leaves in it). */
  id: string;
};

// ---- plain text -----------------------------------------------------------------------------------------------

/**
 * One line of plain text: well-formed Unicode, no C0/C1 control characters (newlines and tabs become spaces), no
 * bidirectional controls (they can make a line read differently from what it holds), no invisible spaces, no
 * non-characters, whitespace collapsed. Fit for the copy, `.txt` and a document worker text block alike.
 */
export function plainLine(s: string, max: number): string {
  const out = s
    // A lone surrogate (not well-formed Unicode, refused by the document worker) becomes U+FFFD.
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
    // eslint-disable-next-line no-control-regex -- removing control characters is the point
    .replace(/[\0-\x1f\x7f-\x9f]/g, " ")
    .replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\u00ad\u200b\u2060\ufeff\ufffe\uffff]/g, "")
    .replace(/\s+/gu, " ")
    .trim();
  return boundText(out, max).trim();
}

/** Known secrets out, then plain text (and secrets out again: making it one line can join two halves). */
export const cleanText = (s: string | null | undefined, max: number): string | null => {
  if (!s) return null;
  const t = scrubKnown(plainLine(scrubKnown(s), max));
  return t || null;
};

/** An http(s) address without user name, password or fragment; undefined for anything else. */
function parseUrl(raw: string): URL | undefined {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  u.username = "";
  u.password = "";
  u.hash = "";
  return u;
}

/** The address as written out: scrubbed before and after it is normalised, bounded, one line. */
export function cleanUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const u = parseUrl(scrubKnown(raw));
  if (!u) return null;
  const href = scrubKnown(u.href);
  return href.length <= REFERENCE_LIMITS.url ? plainLine(href, REFERENCE_LIMITS.url) || null : null;
}

/**
 * The de-duplication key of an address: scheme, host (lower case — `URL` does it), port when not the default, path
 * and query exactly as parsed; no fragment, user name or password. Nothing else is assumed to be the same page.
 */
export function urlKey(raw: string): string | undefined {
  const u = parseUrl(raw);
  return u ? `web:${u.protocol}//${u.host}${u.pathname}${u.search}` : undefined;
}

const idOf = (key: string) => "r_" + crypto.createHash("sha256").update(key).digest("hex").slice(0, 24);

// ---- dates -----------------------------------------------------------------------------------------------------

export const DEFAULT_TIME_ZONE = "Asia/Seoul";

const days = new Map<string, Intl.DateTimeFormat>();
/** A day in `timeZone` (an unknown zone: Asia/Seoul) as `YYYY-MM-DD`. */
export function dayIn(ms: number, timeZone: string = DEFAULT_TIME_ZONE): string {
  let f = days.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    } catch {
      return dayIn(ms, DEFAULT_TIME_ZONE);
    }
    days.set(timeZone, f);
  }
  return f.format(new Date(ms));
}

const YEAR = (y: number) => y >= 1900 && y <= 2200;

/**
 * A page's publication date as the formatters take it — the day **the source states**: a written date (`2026`,
 * `2026-11`, `2026-11-10`) as it is; a time (`2026-11-09T23:30:00-05:00`) as the date written in it, in its own
 * offset (never moved to another zone). Not a real calendar date (2026-02-31), an unlikely year or anything else:
 * null — "n.d.".
 */
export function referenceDate(v: string | null | undefined): string | null {
  if (!v) return null;
  const s = v.trim();
  const written = /^(\d{4})(?:-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?)?$/.exec(s);
  const timed = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  const m = written ?? timed;
  if (!m) return null;
  const y = Number(m[1]);
  const mo = m[2] ? Number(m[2]) : undefined;
  const d = m[3] ? Number(m[3]) : undefined;
  if (!YEAR(y) || !isRealDate(y, mo, d)) return null;
  if (timed && !Number.isFinite(Date.parse(s))) return null;
  return timed ? `${m[1]}-${m[2]}-${m[3]}` : s;
}

// ---- gathering -------------------------------------------------------------------------------------------------

type SourceRow = typeof sources.$inferSelect;

/** One citation of the history, in order: its note entry (checked) and, for a file citation, the file's id if any. */
type Cited = { entry: CitationEntry; fileId: string | null };

/** The citation entries of the conversation's history, oldest answer first, by number within an answer. */
function citedEntries(db: Db, conversationId: string): Cited[] {
  const rows = db
    .select({ parts: messages.parts })
    .from(messages)
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(messages.active, true),
        eq(messages.role, "assistant"),
      ),
    )
    .orderBy(asc(messages.seq))
    .all();
  const out: Cited[] = [];
  for (const r of rows)
    for (const p of r.parts as unknown[]) {
      if (!p || typeof p !== "object" || (p as { type?: unknown }).type !== "citation_note") continue;
      const list = (p as { citations?: unknown }).citations;
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        const e = CitationEntry.safeParse(raw);
        if (!e.success) continue;
        const fileId = (raw as { fileId?: unknown }).fileId;
        out.push({ entry: e.data, fileId: typeof fileId === "string" && fileId ? fileId : null });
      }
    }
  return out;
}

/** Status rank when merging citations of one source: verified wins, then the latest failure stands. */
const better = (a: CitationStatus, b: CitationStatus) => (b === "verified" ? b : a === "verified" ? a : b);

type WebAcc = {
  key: string;
  order: number;
  status: CitationStatus;
  /** The row the entry is written from: a verified page's, else a page's, else the first. */
  best: { row: SourceRow | undefined; entry: CitationEntry; rank: number };
};

const rankOf = (status: CitationStatus, row: SourceRow | undefined) =>
  (status === "verified" ? 4 : 0) + (row?.kind === "page" ? 2 : 0) + (row ? 1 : 0);

function webSource(a: WebAcc, timeZone: string): CollectedSource | undefined {
  const { row, entry } = a.best;
  const url = cleanUrl(row ? (row.finalUrl ?? row.url) : entry.url);
  const site = cleanText(row?.site ?? entry.site, REFERENCE_LIMITS.site);
  const title = cleanText(row?.title ?? entry.title, REFERENCE_LIMITS.title) ?? site ?? url;
  if (!title) return undefined;
  return {
    id: idOf(a.key),
    kind: "web",
    author: null,
    title,
    site,
    url,
    publishedAt: referenceDate(row?.publishedAt ?? entry.publishedAt),
    // The access date is when the server fetched it, as a day in the user's time zone.
    accessedAt: row ? dayIn(row.fetchedAt, timeZone) : null,
    verified: a.status === "verified",
    status: a.status,
  };
}

/**
 * File citations (#48 — the `citation_note` entries #107 adds: no source id, no address, the file's name as the
 * title and the place label as the site, verified passages only). Kept apart from the web path: one entry per file
 * (by id when the entry carries one, else by name), the cited places in first-cited order.
 */
type FileAcc = { key: string; order: number; status: CitationStatus; name: string; locators: string[] };

export const isFileEntry = (e: CitationEntry) =>
  e.status !== "unknown_source" && e.sourceId === null && e.url === null && !!e.title;

function addFile(files: Map<string, FileAcc>, c: Cited, order: number): void {
  const name = cleanText(c.entry.title, REFERENCE_LIMITS.title);
  if (!name) return;
  const key = c.fileId ? `file:${c.fileId}` : `file-name:${name.normalize("NFC")}`;
  const label = cleanText(c.entry.site, REFERENCE_LIMITS.locator);
  const acc = files.get(key) ?? { key, order, status: c.entry.status, name, locators: [] };
  acc.status = better(acc.status, c.entry.status);
  if (label && !acc.locators.includes(label) && acc.locators.length < REFERENCE_LIMITS.locators)
    acc.locators.push(label);
  files.set(key, acc);
}

const fileSource = (a: FileAcc): CollectedSource => ({
  id: idOf(a.key),
  kind: "file",
  fileName: a.name,
  locators: a.locators,
  verified: a.status === "verified",
  status: a.status,
});

/**
 * The de-duplicated sources of a conversation in first-cited order, and whether there were more than the export
 * lists (`REFERENCE_LIMITS.entries`).
 */
export function collectReferences(
  db: Db,
  conversationId: string,
  /** The user's time zone, for access dates. */
  timeZone: string = DEFAULT_TIME_ZONE,
): { sources: CollectedSource[]; truncated: boolean } {
  const cited = citedEntries(db, conversationId);
  const ids = [...new Set(cited.flatMap((c) => (c.entry.sourceId ? [c.entry.sourceId] : [])))];
  const rows = new Map<string, SourceRow>();
  // Within this conversation only; in chunks (SQLite's variable limit).
  for (let i = 0; i < ids.length; i += 500)
    for (const r of db
      .select()
      .from(sources)
      .where(and(eq(sources.conversationId, conversationId), inArray(sources.id, ids.slice(i, i + 500))))
      .all())
      rows.set(r.id, r);

  const files = new Map<string, FileAcc>();
  // Web citations, grouped by the document they reached (review #115 round 2): a fetched row's identity is where
  // it ended — its `final_url`, or its `url` when it was not redirected. A start address is followed on to its
  // destination only when the cited rows give it exactly one (`/latest` → `/nov-12` and `/latest` → `/nov-13` are
  // two documents, and a row that only names `/latest` stays `/latest`). A page fetched straight at its address is a
  // destination of that address too (review #115 round 3): `/latest` fetched directly and `/latest` → `/nov-13` are
  // two documents. Search results (no fetched page) are leads, never a destination. Chains follow stored rows only:
  // a middle hop that no cited row fetched is not looked up.
  const webCited: { order: number; entry: CitationEntry; row: SourceRow | undefined; start: string }[] = [];
  const destinations = new Map<string, Set<string>>();
  cited.forEach((c, order) => {
    const e = c.entry;
    if (e.status === "unknown_source") return;
    if (e.sourceId === null) {
      if (isFileEntry(e)) addFile(files, c, order);
      return;
    }
    const row = rows.get(e.sourceId);
    const from = row ? urlKey(row.url) : undefined;
    const to = row ? urlKey(row.finalUrl ?? row.url) : e.url ? urlKey(e.url) : undefined;
    const start = to ?? `source:${e.sourceId}`;
    if (row?.kind === "page" && from && to)
      destinations.set(from, (destinations.get(from) ?? new Set()).add(to));
    webCited.push({ order, entry: e, row, start });
  });
  /** The document an address leads to through the cited rows' redirects (one destination each step, no loops). */
  const identity = (k: string) => {
    const seen = new Set([k]);
    for (;;) {
      const next = destinations.get(k);
      if (!next || next.size !== 1) return k;
      const to = [...next][0]!;
      if (seen.has(to)) return k;
      seen.add(to);
      k = to;
    }
  };
  const web = new Map<string, WebAcc>();
  for (const c of webCited) {
    const key = identity(c.start);
    const rank = rankOf(c.entry.status, c.row);
    const acc = web.get(key);
    if (!acc) {
      web.set(key, {
        key,
        order: c.order,
        status: c.entry.status,
        best: { row: c.row, entry: c.entry, rank },
      });
      continue;
    }
    acc.status = better(acc.status, c.entry.status);
    if (rank > acc.best.rank) acc.best = { row: c.row, entry: c.entry, rank };
  }

  const all = [
    ...[...web.values()].map((a) => ({ order: a.order, source: webSource(a, timeZone) })),
    ...[...files.values()].map((a) => ({ order: a.order, source: fileSource(a) })),
  ]
    .filter((x): x is { order: number; source: CollectedSource } => !!x.source)
    .sort((a, b) => a.order - b.order)
    .map((x) => x.source);
  return {
    sources: all.slice(0, REFERENCE_LIMITS.entries),
    truncated: all.length > REFERENCE_LIMITS.entries,
  };
}
