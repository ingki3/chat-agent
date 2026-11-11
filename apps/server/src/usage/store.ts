import { and, asc, eq } from "drizzle-orm";
import type { UsagePurpose } from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { connections, usageRecords } from "../db/schema.js";
import type { UsageReport } from "../runtime/adapter.js";
import { costOf, PriceStore } from "./prices.js";

export { USAGE_PURPOSES, type UsagePurpose } from "@agentlee/shared";

/*
 * What the usage was for (#44, PRD FR-9, `UsagePurpose`): `chat` = a reply in a conversation (runs.ts),
 * `connection_test` = a connection test (#17). `title`, `summary` (#45) and `schedule` (#33) are for the features
 * that come later: they call `record` the same way with their own purpose.
 */

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

export type UsageStoreOptions = {
  /** Price tables (#32). Default: the database's own. */
  prices?: PriceStore;
  /**
   * Called after every write with its time (#32: the daily cost check). Must not throw — whatever it does cannot
   * change or stop the run that reported the usage.
   */
  onRecorded?: (at: number) => void;
};

/**
 * Usage storage (#44). One row per (run, attempt), written with an upsert: the adapter contract says a usage event
 * is the attempt's whole usage so far, so a later event of the same attempt replaces the earlier figures — a
 * duplicate event, a replay or a stop never adds a row or counts twice. Nothing else is stored: no prompt, no reply.
 *
 * Cost (#32): the first write of an attempt fixes its connection's auth type and, for an API key connection, the
 * price table version then current. Later writes of the same attempt recompute the cost from that same version, so
 * a price edit never changes a cost already written. Subscription and connection-less rows get no cost.
 */
export class UsageStore {
  readonly prices: PriceStore;
  private readonly onRecorded: ((at: number) => void) | undefined;

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
    opts: UsageStoreOptions = {},
  ) {
    this.prices = opts.prices ?? new PriceStore(db, now);
    this.onRecorded = opts.onRecorded;
  }

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
    this.db.transaction((tx) => {
      const existing = tx
        .select({ authType: usageRecords.authType, priceVersion: usageRecords.priceVersion })
        .from(usageRecords)
        .where(and(eq(usageRecords.runId, a.runId), eq(usageRecords.attempt, a.attempt)))
        .get();
      // Pinned at the first write: the auth type and the price version stay what they were then. A connection id
      // that names no connection is `unknown` (shown as 미제공, never dropped from the totals).
      const authType = existing
        ? existing.authType
        : a.connectionId
          ? (tx
              .select({ authType: connections.authType })
              .from(connections)
              .where(eq(connections.id, a.connectionId))
              .get()?.authType ?? "unknown")
          : null;
      const costed = authType === "api_key";
      const priceVersion = existing ? existing.priceVersion : costed ? this.prices.currentVersion() : null;
      const pricedCostMicros =
        costed && priceVersion !== null
          ? costOf(figures, this.prices.priceIn(priceVersion, a.runtime, a.model))
          : null;
      tx.insert(usageRecords)
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
          authType,
          priceVersion,
          pricedCostMicros,
          ...figures,
        })
        .onConflictDoUpdate({
          target: [usageRecords.runId, usageRecords.attempt],
          set: { ...figures, pricedCostMicros },
        })
        .run();
    });
    this.onRecorded?.(at);
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
