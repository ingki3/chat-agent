import crypto from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Source } from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { conversations, sources } from "../db/schema.js";

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
  addPage(scope: SourceScope, p: PageInput): SourceRow | undefined {
    if (!this.owns(scope)) return undefined;
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

  /** Stores a search result (no body). Undefined when the scope does not own the conversation. */
  addSearchResult(scope: SourceScope, s: SearchInput): SourceRow | undefined {
    if (!this.owns(scope)) return undefined;
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
      .all();
  }

  /**
   * One source of one conversation, with its body — for the citation check (#25), which cites by source id.
   * An id from another conversation is not found.
   */
  get(conversationId: string, id: string): SourceRow | undefined {
    return this.db
      .select()
      .from(sources)
      .where(and(eq(sources.id, id), eq(sources.conversationId, conversationId)))
      .get();
  }
}
