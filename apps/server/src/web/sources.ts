import crypto from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Source } from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { conversations, sources } from "../db/schema.js";
import { cutAt, hasGapMarks, visibleIndex } from "../citations/verify.js";
import { scrubKnownDeep } from "../secrets/known.js";

export type SourceRow = typeof sources.$inferSelect;

/** Who and what a source belongs to — the run's MCP token scope (checked against the conversation's owner). */
export type SourceScope = { userId: string; conversationId: string; runId: string };

export type PageInput = {
  url: string;
  finalUrl: string;
  title: string;
  site: string;
  publishedAt?: string | undefined;
  contentType: string;
  body: string;
  truncated: boolean;
};

export type SearchInput = {
  provider: string;
  url: string;
  title: string;
  site: string;
  publishedAt?: string | undefined;
  snippet?: string | undefined;
};

/** Bounds for text that came from the web (titles and snippets are shown, not trusted). */
export const SOURCE_LIMITS = { title: 300, site: 120, snippet: 600, url: 2048 } as const;

/** Whitespace collapsed and at most `n` characters (an ellipsis marks a cut). */
export const cut = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  // On a code point (review #237 11차): never half a surrogate pair before the ellipsis.
  return t.length > n ? `${cutAt(t, n - 1)}…` : t;
};
/**
 * A title without control characters (C0, C1) and bidirectional controls, whitespace as one space (#234, review
 * #237 14·15차 — the PDF reader's metadata title gets the same in `extract/pdf.mjs`).
 */
export const cleanTitle = (t: string) =>
  t
    .replace(/\s+/gu, " ")
    .replace(/[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, "")
    .trim();

/**
 * A PDF's title when it has none of its own: the file name of its address ("2027 시행계획.pdf"), cleaned
 * (`cleanTitle`) and bounded; undefined when nothing is left (the caller then names it by its site).
 */
export function pdfTitle(u: URL): string | undefined {
  const last = u.pathname.split("/").filter(Boolean).at(-1);
  if (!last) return undefined;
  let name: string;
  try {
    name = decodeURIComponent(last);
  } catch {
    name = last;
  }
  return cut(cleanTitle(name), SOURCE_LIMITS.title) || undefined;
}

const sha256 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

export function toSource(r: SourceRow): Source {
  return {
    id: r.id,
    runId: r.runId,
    kind: r.kind,
    provider: r.provider,
    url: r.url,
    finalUrl: r.finalUrl ?? null,
    title: r.title,
    site: r.site,
    publishedAt: r.publishedAt ?? null,
    fetchedAt: r.fetchedAt,
    contentType: r.contentType ?? null,
    bodyHash: r.bodyHash ?? null,
    // Visible characters: a web PDF's gap marks (U+E000, #234) are not text; any other page counts as stored.
    characters: r.body
      ? hasGapMarks(r.contentType)
        ? visibleIndex(r.body, r.body.length)
        : r.body.length
      : 0,
    truncated: r.truncated,
    snippet: r.snippet ?? null,
  };
}

/**
 * Sources of conversations (#50). A source is written only for the run's own user and conversation, and only if
 * that user owns the conversation — the scope comes from the run-scoped token, this is the second check.
 * The same page (same URL and the same text) or the same search link in one conversation keeps its first id, so a
 * repeated fetch or search does not multiply sources and citations stay stable.
 */
export class SourceStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  private owns(scope: SourceScope): boolean {
    const c = this.db
      .select({ ownerId: conversations.ownerId })
      .from(conversations)
      .where(eq(conversations.id, scope.conversationId))
      .get();
    return c?.ownerId === scope.userId;
  }

  /** Stores a fetched page. Undefined when the scope does not own the conversation. */
  addPage(scope: SourceScope, raw: PageInput): SourceRow | undefined {
    if (!this.owns(scope)) return undefined;
    // A fetched page never stores a known secret (review round 23) — e.g. a key the model put in the URL.
    const p = scrubKnownDeep(raw);
    const bodyHash = sha256(p.body);
    // A row is never changed once stored (review #237 17차 — citations, share snapshots and references read it): the
    // same row again only for the very same fetch — request and final address, body, title and type. Anything else
    // is a new row (a new source id) with what this fetch found.
    const title = cut(p.title, SOURCE_LIMITS.title) || cut(p.site, SOURCE_LIMITS.title);
    const same = this.db
      .select()
      .from(sources)
      .where(
        and(
          eq(sources.conversationId, scope.conversationId),
          eq(sources.kind, "page"),
          eq(sources.url, p.url),
          eq(sources.bodyHash, bodyHash),
          eq(sources.finalUrl, p.finalUrl),
          eq(sources.title, title),
          eq(sources.contentType, p.contentType),
        ),
      )
      .get();
    if (same) return same;
    return this.db
      .insert(sources)
      .values({
        id: crypto.randomUUID(),
        userId: scope.userId,
        conversationId: scope.conversationId,
        runId: scope.runId,
        kind: "page",
        provider: "web_fetch",
        url: p.url,
        finalUrl: p.finalUrl,
        title,
        site: cut(p.site, SOURCE_LIMITS.site),
        publishedAt: p.publishedAt ?? null,
        fetchedAt: this.now(),
        contentType: p.contentType,
        bodyHash,
        body: p.body,
        truncated: p.truncated,
      })
      .returning()
      .get();
  }

  /**
   * A fork's copy of a cited source (#52): what the share showed of it (`Source`, never the page text — a viewer is
   * not served that), as a new row of the forker's conversation. `runId` names the fork (no run fetched it).
   */
  copyInto(to: { userId: string; conversationId: string; forkId: string }, raw: Source): SourceRow {
    const s = scrubKnownDeep(raw);
    return this.db
      .insert(sources)
      .values({
        id: crypto.randomUUID(),
        userId: to.userId,
        conversationId: to.conversationId,
        runId: to.forkId,
        kind: s.kind,
        provider: s.provider,
        url: s.url,
        finalUrl: s.finalUrl,
        title: cut(s.title, SOURCE_LIMITS.title),
        site: cut(s.site, SOURCE_LIMITS.site),
        publishedAt: s.publishedAt,
        fetchedAt: s.fetchedAt,
        contentType: s.contentType,
        bodyHash: null,
        body: null,
        truncated: s.truncated,
        snippet: s.snippet === null ? null : cut(s.snippet, SOURCE_LIMITS.snippet),
      })
      .returning()
      .get();
  }

  /** Stores a search result (no body). Undefined when the scope does not own the conversation. */
  addSearchResult(scope: SourceScope, raw: SearchInput): SourceRow | undefined {
    if (!this.owns(scope)) return undefined;
    const s = scrubKnownDeep(raw);
    const same = this.db
      .select()
      .from(sources)
      .where(
        and(
          eq(sources.conversationId, scope.conversationId),
          eq(sources.kind, "search"),
          eq(sources.url, s.url),
          isNull(sources.body),
        ),
      )
      .get();
    if (same) return same;
    return this.db
      .insert(sources)
      .values({
        id: crypto.randomUUID(),
        userId: scope.userId,
        conversationId: scope.conversationId,
        runId: scope.runId,
        kind: "search",
        provider: s.provider,
        url: s.url,
        title: cut(s.title, SOURCE_LIMITS.title),
        site: cut(s.site, SOURCE_LIMITS.site),
        publishedAt: s.publishedAt ?? null,
        fetchedAt: this.now(),
        snippet: s.snippet ? cut(s.snippet, SOURCE_LIMITS.snippet) : null,
      })
      .returning()
      .get();
  }

  /** A conversation's sources, oldest first (the order citations are numbered in). */
  list(conversationId: string): SourceRow[] {
    return this.db
      .select()
      .from(sources)
      .where(eq(sources.conversationId, conversationId))
      .orderBy(sql`rowid`)
      .all()
      .map((r) => scrubKnownDeep(r)); // reads scrubbed too (round 24): secrets registered after storing
  }

  /**
   * Which ids are this conversation's sources and whether `cite` can check a passage against their stored text
   * (#53: the references a fresh session gets). Ids and flags only — no page text is read.
   */
  citable(conversationId: string): Map<string, { text: boolean }> {
    const rows = this.db
      .select({ id: sources.id, kind: sources.kind, hasBody: sql<number>`${sources.body} is not null` })
      .from(sources)
      .where(eq(sources.conversationId, conversationId))
      .all();
    return new Map(rows.map((r) => [r.id, { text: r.kind === "page" && r.hasBody === 1 }]));
  }

  /**
   * The sources of the token's conversation (#25 `sources_list`), oldest first — undefined when the token's user
   * does not own it. Only that user's rows (a conversation has one owner; this is the second check).
   */
  listFor(scope: SourceScope): SourceRow[] | undefined {
    if (!this.owns(scope)) return undefined;
    return this.list(scope.conversationId).filter((r) => r.userId === scope.userId);
  }

  /**
   * The newest `limit` sources of the token's conversation (that user's rows), oldest first — metadata and whether a
   * page's text is stored, **never the text** (review #237 18차: a page fetched many times would load every body).
   * Undefined when the token's user does not own the conversation.
   */
  recentFor(
    scope: SourceScope,
    limit: number,
  ): (Omit<SourceRow, "body" | "createdAt"> & { hasBody: boolean })[] | undefined {
    if (!this.owns(scope)) return undefined;
    const rows = this.db
      .select({
        id: sources.id,
        userId: sources.userId,
        conversationId: sources.conversationId,
        runId: sources.runId,
        kind: sources.kind,
        provider: sources.provider,
        url: sources.url,
        finalUrl: sources.finalUrl,
        title: sources.title,
        site: sources.site,
        publishedAt: sources.publishedAt,
        fetchedAt: sources.fetchedAt,
        contentType: sources.contentType,
        bodyHash: sources.bodyHash,
        truncated: sources.truncated,
        snippet: sources.snippet,
        hasBody: sql<number>`${sources.body} is not null`,
      })
      .from(sources)
      .where(and(eq(sources.conversationId, scope.conversationId), eq(sources.userId, scope.userId)))
      .orderBy(sql`rowid desc`)
      .limit(limit)
      .all();
    return rows.reverse().map((r) => scrubKnownDeep({ ...r, hasBody: r.hasBody === 1 }));
  }

  /** What counting needs of a source (#234): its body hash and addresses — never its text. */
  keyInfo(
    conversationId: string,
    id: string,
  ): { bodyHash: string | null; finalUrl: string | null; url: string } | undefined {
    return this.db
      .select({ bodyHash: sources.bodyHash, finalUrl: sources.finalUrl, url: sources.url })
      .from(sources)
      .where(and(eq(sources.id, id), eq(sources.conversationId, conversationId)))
      .get();
  }

  /**
   * One page of the token's conversation with its (scrubbed) text — `web_find` (#234). Undefined when the token's
   * user does not own the conversation or the row is not theirs.
   */
  getFor(scope: SourceScope, id: string): SourceRow | undefined {
    if (!this.owns(scope)) return undefined;
    const row = this.get(scope.conversationId, id);
    return row && row.userId === scope.userId ? row : undefined;
  }

  /**
   * One source of one conversation, with its body — for the citation check (#25), which cites by source id.
   * An id from another conversation is not found.
   */
  get(conversationId: string, id: string): SourceRow | undefined {
    return scrubKnownDeep(
      this.db
        .select()
        .from(sources)
        .where(and(eq(sources.id, id), eq(sources.conversationId, conversationId)))
        .get(),
    );
  }
}
