import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { usageRecords } from "../db/schema.js";
import type { UsageReport } from "../runtime/adapter.js";

/**
 * What the usage was for (#44, PRD FR-9). `chat` = a reply in a conversation (runs.ts), `connection_test` = a
 * connection test (#17). `title`, `summary` (#45) and `schedule` (#33) are for the features that come later: they
 * call `record` the same way with their own purpose.
 */
export const USAGE_PURPOSES = ["chat", "schedule", "title", "summary", "connection_test"] as const;
export type UsagePurpose = (typeof USAGE_PURPOSES)[number];

/** Who and what one attempt's usage belongs to. IDs, runtime and model only — never content. */
export type UsageAttempt = {
  userId: string;
  /** Null outside a conversation (connection tests). */
  conversationId: string | null;
  /** The run (`runs.id`), or for a connection test the test's own id. */
  runId: string;
  /** 1, 2, … — a new session open + turn for the same reply (a retry or a fallback) is a new attempt. */
  attempt: number;
  runtime: string;
  model: string;
  connectionId: string | null;
  purpose: UsagePurpose;
};

export type UsageRow = typeof usageRecords.$inferSelect;

/** A token count as stored: a non-negative integer, or NULL when the runtime did not report it. */
const tokens = (v: number | undefined): number | null =>
  v !== undefined && Number.isInteger(v) && v >= 0 ? v : null;
const cost = (v: number | undefined): number | null =>
  v !== undefined && Number.isFinite(v) && v >= 0 ? v : null;

/**
 * Usage storage (#44). One row per (run, attempt), written with an upsert: the adapter contract says a usage event
 * is the attempt's whole usage so far, so a later event of the same attempt replaces the earlier figures — a
 * duplicate event, a replay or a stop never adds a row or counts twice. Nothing else is stored: no prompt, no reply.
 */
export class UsageStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  record(a: UsageAttempt, u: UsageReport): void {
    const at = this.now();
    const figures = {
      inputTokens: tokens(u.inputTokens),
      outputTokens: tokens(u.outputTokens),
      cacheReadTokens: tokens(u.cacheReadTokens),
      cacheWriteTokens: tokens(u.cacheWriteTokens),
      costUsd: cost(u.costUsd),
      requestCount: 1,
      updatedAt: at,
    };
    this.db
      .insert(usageRecords)
      .values({
        userId: a.userId,
        conversationId: a.conversationId,
        runId: a.runId,
        attempt: a.attempt,
        runtime: a.runtime,
        model: a.model,
        connectionId: a.connectionId,
        purpose: a.purpose,
        createdAt: at,
        ...figures,
      })
      .onConflictDoUpdate({ target: [usageRecords.runId, usageRecords.attempt], set: figures })
      .run();
  }

  /** A run's rows by attempt (tests, and the usage screen #32 later). */
  forRun(runId: string): UsageRow[] {
    return this.db
      .select()
      .from(usageRecords)
      .where(eq(usageRecords.runId, runId))
      .orderBy(asc(usageRecords.attempt))
      .all();
  }
}
