import crypto from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Source } from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { conversations, sources } from "../db/schema.js";
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
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
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
    characters: r.body?.length ?? 0,
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
    const same = this.db
      .select()
      .from(sources)
      .where(
        and(
          eq(sources.conversationId, scope.conversationId),
          eq(sources.kind, "page"),
          eq(sources.url, p.url),
          eq(sources.bodyHash, bodyHash),
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
        title: cut(p.title, SOURCE_LIMITS.title) || cut(p.site, SOURCE_LIMITS.title),
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
