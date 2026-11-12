import crypto from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { conversationSummaries } from "../db/schema.js";
import { coveredHash, SUMMARY_MAX_CHARS, type SummaryRef } from "../runtime/context.js";
import { scrubKnown } from "../secrets/known.js";
import type { MessageRow } from "./store.js";

export type SummaryRow = typeof conversationSummaries.$inferSelect;

/**
 * Conversation summaries (#45, FR-3.6): written once a fresh context reaches the limit ratio, reused for every fresh
 * session while the messages they cover are still the history's. A summary is model output about the
 * conversation: known secrets are scrubbed when it is stored and again when it is read (round 24), and the
 * background rescrub covers the column (`secrets/columns.ts`).
 */
export class SummaryStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** Stores a summary covering `history` up to `through` (both active messages of the conversation). */
  save(s: {
    conversationId: string;
    through: MessageRow;
    history: readonly MessageRow[];
    summary: string;
    runtime: string;
    model: string;
    runId: string | null;
  }): SummaryRow {
    const row: SummaryRow = {
      id: crypto.randomUUID(),
      conversationId: s.conversationId,
      throughMessageId: s.through.id,
      throughSeq: s.through.seq,
      coveredHash: coveredHash(s.history, s.through.seq),
      summary: scrubKnown(s.summary.trim().slice(0, SUMMARY_MAX_CHARS)),
      runtime: s.runtime,
      model: s.model,
      runId: s.runId,
      createdAt: this.now(),
    };
    this.db.insert(conversationSummaries).values(row).run();
    return row;
  }

  /**
   * The summary to use for `history` (the active messages before the turn): the newest one whose covered messages
   * are exactly the history's up to its point — an edit or regenerate before that point makes it stale.
   */
  current(conversationId: string, history: readonly MessageRow[]): (SummaryRef & SummaryRow) | null {
    const rows = this.db
      .select()
      .from(conversationSummaries)
      .where(eq(conversationSummaries.conversationId, conversationId))
      .orderBy(desc(conversationSummaries.throughSeq), desc(conversationSummaries.createdAt))
      .all();
    for (const r of rows) {
      if (!history.some((m) => m.id === r.throughMessageId)) continue;
      if (r.coveredHash !== coveredHash(history, r.throughSeq)) continue;
      return { ...r, summary: scrubKnown(r.summary) };
    }
    return null;
  }

  get(conversationId: string, id: string): SummaryRow | undefined {
    const r = this.db
      .select()
      .from(conversationSummaries)
      .where(and(eq(conversationSummaries.id, id), eq(conversationSummaries.conversationId, conversationId)))
      .get();
    return r ? { ...r, summary: scrubKnown(r.summary) } : undefined;
  }
}
