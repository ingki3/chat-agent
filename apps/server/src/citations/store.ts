import crypto from "node:crypto";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  boundText,
  CITATION_LIMITS,
  type CitationStatus,
  type CiteResult,
  type FileLocator,
} from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { citations, conversations, files, sources } from "../db/schema.js";
import type { SourceScope } from "../web/sources.js";
import { findSnippet, normalizeSnippet } from "./verify.js";
import { scrubKnown, scrubKnownDeep } from "../secrets/known.js";

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
/**
 * What `citations.snippet_key` holds: the normalised snippet hashed (review #97 round 23). It is only compared, and
 * normalising folds characters (fullwidth to ASCII), so the normalised text itself could rebuild a known secret
 * that the stored snippet does not hold.
 */
export const snippetKey = (snippet: string) =>
  "sha256:" + crypto.createHash("sha256").update(normalizeSnippet(snippet), "utf8").digest("hex");

export class CitationStore {
  constructor(private readonly db: Db) {
    // Rows from before keys were hashed (round 23): every key is recomputed from its stored snippet and the ones
    // that differ are replaced. No test on the stored key's form — an old plaintext key may itself start with
    // `sha256:` (review #97 round 24). Citations are few, so this is cheap.
    const rows = db.$client.prepare("select id, snippet, snippet_key as k from citations").all() as {
      id: string;
      snippet: string;
      k: string;
    }[];
    const set = db.$client.prepare("update citations set snippet_key = ? where id = ?");
    for (const r of rows) {
      const key = snippetKey(r.snippet);
      if (r.k !== key) set.run(key, r.id);
    }
  }

  /** Checks and registers one citation of the run; the same source and snippet twice keep their first number. */
  cite(scope: SourceScope, input: { sourceId: string; snippet: string }): CiteResult {
    // Known secrets are kept out of what is stored (the snippet is model output; the page text is scrubbed too).
    const snippet = scrubKnown(boundText(input.snippet, CITATION_LIMITS.snippet));
    if (Array.from(normalizeSnippet(snippet)).length < CITATION_LIMITS.minSnippet)
      throw new CiteRefused("cite_snippet_too_short");
    const key = snippetKey(snippet);
    const owner = this.db
      .select({ ownerId: conversations.ownerId })
      .from(conversations)
      .where(eq(conversations.id, scope.conversationId))
      .get();
    if (owner?.ownerId !== scope.userId) throw new CiteRefused("cite_not_allowed");
    const src = this.db
      .select()
      .from(sources)
      .where(and(eq(sources.id, input.sourceId), eq(sources.conversationId, scope.conversationId)))
      .get();
    const mine = src && src.userId === scope.userId ? src : undefined;
    const sourceId = mine?.id ?? null;
    // Cheap checks first: a repeated verified citation or one over the limit costs no text comparison. A repeat of
    // one that did not verify is checked again (the model may have corrected the quote, review #97 round 15).
    const existing = this.existing(scope.runId, key, sourceId);
    if (existing?.status === "verified") return result(existing.n, existing.status, existing.sourceId);
    if (!existing && this.count(scope.runId) >= CITATION_LIMITS.perRun) throw new CiteRefused("cite_limit");
    let status: CitationStatus;
    let quote: string | null = null;
    if (!mine) status = "unknown_source";
    else if (mine.kind !== "page" || !mine.body) status = "fetch_failed";
    else {
      const m = findSnippet(mine.body, snippet, mine.bodyHash ?? undefined);
      status = m.found ? "verified" : "snippet_not_found";
      if (m.found) quote = scrubKnown(m.quote);
    }
    // The transaction holds the numbering only (checked again inside it).
    return this.db.transaction(
      () => {
        const again = this.existing(scope.runId, key, sourceId);
        if (again) {
          // The same passage again: it keeps its number. A retry that now verifies upgrades the entry; one that
          // still fails leaves it as it was.
          if (again.status !== "verified" && status === "verified")
            this.db.update(citations).set({ status, quote, snippet }).where(eq(citations.id, again.id)).run();
          return result(again.n, again.status === "verified" ? again.status : status, again.sourceId);
        }
        const count = this.count(scope.runId);
        if (count >= CITATION_LIMITS.perRun) throw new CiteRefused("cite_limit");
        const n = count + 1;
        this.db
          .insert(citations)
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

  /**
   * A file citation (#48, `file_cite`), numbered with the run's web citations. `check` looks for the snippet in
   * the file's extracted text — called only once the file is known to be this conversation's and this user's
   * (`fileId` null otherwise: `unknown_source`). The same file and snippet twice keep their first number; a retry
   * that now verifies upgrades the entry (as `cite`).
   */
  citeFile(
    scope: SourceScope,
    input: { fileId: string | null; snippet: string },
    check: (snippet: string) => {
      status: CitationStatus;
      quote: string | null;
      locator: (FileLocator & { sheetNo?: number | undefined }) | null;
    },
  ): CiteResult & { locator: (FileLocator & { sheetNo?: number | undefined }) | null } {
    const snippet = scrubKnown(boundText(input.snippet, CITATION_LIMITS.snippet));
    if (Array.from(normalizeSnippet(snippet)).length < CITATION_LIMITS.minSnippet)
      throw new CiteRefused("cite_snippet_too_short");
    const key = snippetKey(snippet);
    const owner = this.db
      .select({ ownerId: conversations.ownerId })
      .from(conversations)
      .where(eq(conversations.id, scope.conversationId))
      .get();
    if (owner?.ownerId !== scope.userId) throw new CiteRefused("cite_not_allowed");
    const fileId = input.fileId;
    const existing = this.existing(scope.runId, key, null, fileId);
    if (!existing && this.count(scope.runId) >= CITATION_LIMITS.perRun) throw new CiteRefused("cite_limit");
    // The file's state now comes before anything this run registered (review #107 7차): a file being extracted
    // again (a new secret) or one that failed is `fetch_failed`, whatever an earlier call verified.
    const found = fileId ? check(snippet) : { status: "unknown_source" as const, quote: null, locator: null };
    const quote = found.quote === null ? null : scrubKnown(found.quote);
    const locator = found.locator ? JSON.stringify(scrubKnownDeep(found.locator)) : null;
    return this.db.transaction(
      () => {
        const again = this.existing(scope.runId, key, null, fileId);
        if (again) {
          // Only a check that verifies **now** stands (review #107 8차): verified against the text as it is now (an
          // extraction may have replaced it); any other current result — not found, unreadable, pending —
          // replaces what an earlier call verified. Its number stays.
          if (found.status === "verified") {
            this.db
              .update(citations)
              .set({ status: found.status, quote, snippet, locator })
              .where(eq(citations.id, again.id))
              .run();
            return { ...result(again.n, "verified", null), locator: found.locator };
          }
          this.db
            .update(citations)
            .set({ status: found.status, quote: null, snippet, locator: null })
            .where(eq(citations.id, again.id))
            .run();
          return { ...result(again.n, found.status, null), locator: null };
        }
        const count = this.count(scope.runId);
        if (count >= CITATION_LIMITS.perRun) throw new CiteRefused("cite_limit");
        const n = count + 1;
        this.db
          .insert(citations)
          .values({
            id: crypto.randomUUID(),
            runId: scope.runId,
            conversationId: scope.conversationId,
            userId: scope.userId,
            n,
            sourceId: null,
            fileId,
            status: found.status,
            snippet,
            snippetKey: key,
            quote,
            locator,
          })
          .run();
        return { ...result(n, found.status, null), locator: found.locator };
      },
      { behavior: "immediate" },
    );
  }

  private existing(
    runId: string,
    key: string,
    sourceId: string | null,
    fileId: string | null = null,
  ): CitationRow | undefined {
    return this.db
      .select()
      .from(citations)
      .where(and(eq(citations.runId, runId), eq(citations.snippetKey, key)))
      .all()
      .find((c) => c.sourceId === sourceId && (c.fileId ?? null) === fileId);
  }

  private count(runId: string): number {
    return (
      this.db
        .select({ c: sql<number>`count(*)` })
        .from(citations)
        .where(eq(citations.runId, runId))
        .get()?.c ?? 0
    );
  }

  /** The run's citations by number, with their sources or files (the note at the end of the run). */
  forRun(runId: string): (CitationRow & {
    source: typeof sources.$inferSelect | undefined;
    file?: { id: string; name: string } | undefined;
  })[] {
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
      // A file of the same conversation and user only (the row's own scope).
      file: r.fileId
        ? this.db
            .select({ id: files.id, name: files.name })
            .from(files)
            .where(
              and(
                eq(files.id, r.fileId),
                eq(files.conversationId, r.conversationId),
                eq(files.userId, r.userId),
              ),
            )
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
