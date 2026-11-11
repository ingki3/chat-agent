import crypto from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import { boundText, CITATION_LIMITS, type CitationStatus, type CiteResult } from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { citations, conversations, sources } from "../db/schema.js";
import type { SourceScope } from "../web/sources.js";
import { findSnippet, normalizeSnippet } from "./verify.js";

export type CitationRow = typeof citations.$inferSelect;

/** Why a `cite` call registered nothing (the model sees the code, the log keeps it). */
export class CiteRefused extends Error {
  constructor(readonly code: "cite_snippet_too_short" | "cite_limit" | "cite_not_allowed") {
    super(code);
  }
}

/**
 * Citations of answers (#25). The scope — user, conversation, run — is the run's MCP token's, never the model's
 * input: a `sourceId` counts only when it is a source of *that* conversation and *that* user, and the
 * conversation is that user's. Anything else is `unknown_source` (and the id it named is not kept). A source of
 * an earlier answer of the same conversation can be cited again: it is checked again against the stored text.
 */
export class CitationStore {
  constructor(private readonly db: Db) {}

  /** Checks and registers one citation of the run; the same source and snippet twice keep their first number. */
  cite(scope: SourceScope, input: { sourceId: string; snippet: string }): CiteResult {
    const snippet = boundText(input.snippet, CITATION_LIMITS.snippet);
    const key = normalizeSnippet(snippet);
    if (Array.from(key).length < CITATION_LIMITS.minSnippet) throw new CiteRefused("cite_snippet_too_short");
    return this.db.transaction(
      (tx) => {
        const owner = tx
          .select({ ownerId: conversations.ownerId })
          .from(conversations)
          .where(eq(conversations.id, scope.conversationId))
          .get();
        if (owner?.ownerId !== scope.userId) throw new CiteRefused("cite_not_allowed");
        const src = tx
          .select()
          .from(sources)
          .where(and(eq(sources.id, input.sourceId), eq(sources.conversationId, scope.conversationId)))
          .get();
        const mine = src && src.userId === scope.userId ? src : undefined;
        let status: CitationStatus;
        let quote: string | null = null;
        if (!mine) status = "unknown_source";
        else if (mine.kind !== "page" || !mine.body) status = "fetch_failed";
        else {
          const m = findSnippet(mine.body, snippet);
          status = m.found ? "verified" : "snippet_not_found";
          if (m.found) quote = m.quote;
        }
        const sourceId = mine?.id ?? null;
        const same = tx
          .select()
          .from(citations)
          .where(and(eq(citations.runId, scope.runId), eq(citations.snippetKey, key)))
          .all()
          .find((c) => c.sourceId === sourceId);
        if (same) return result(same.n, same.status, same.sourceId);
        const count =
          tx
            .select({ c: sql<number>`count(*)` })
            .from(citations)
            .where(eq(citations.runId, scope.runId))
            .get()?.c ?? 0;
        if (count >= CITATION_LIMITS.perRun) throw new CiteRefused("cite_limit");
        const n = count + 1;
        tx.insert(citations)
          .values({
            id: crypto.randomUUID(),
            runId: scope.runId,
            conversationId: scope.conversationId,
            userId: scope.userId,
            n,
            sourceId,
            status,
            snippet,
            snippetKey: key,
            quote,
          })
          .run();
        return result(n, status, sourceId);
      },
      { behavior: "immediate" },
    );
  }

  /** The run's citations by number, with their sources (the note at the end of the run). */
  forRun(runId: string): (CitationRow & { source: typeof sources.$inferSelect | undefined })[] {
    const rows = this.db
      .select()
      .from(citations)
      .where(eq(citations.runId, runId))
      .orderBy(asc(citations.n))
      .all();
    return rows.map((r) => ({
      ...r,
      source: r.sourceId
        ? this.db
            .select()
            .from(sources)
            .where(and(eq(sources.id, r.sourceId), eq(sources.conversationId, r.conversationId)))
            .get()
        : undefined,
    }));
  }
}

const result = (n: number, status: CitationStatus, sourceId: string | null): CiteResult => ({
  n,
  marker: `[${n}]`,
  status,
  sourceId,
});
