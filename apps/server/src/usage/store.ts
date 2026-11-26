import { and, asc, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
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

/** The `runtime` of a media row (#238): the generation ran at OpenRouter, not in a runtime. */
export const MEDIA_RUNTIME = "openrouter";
/** One media generation's usage row key: `<runId>#media:<callId>`. */
export const mediaRunKey = (runId: string, callId: string) => `${runId}#media:${callId}`;

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
  /** The media rows' clock (#251 r3, default: `now`). */
  mediaNow?: () => number;
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
    this.mediaNow = opts.mediaNow ?? now;
  }

  /**
   * The media rows' clock (#251 r3): the same one the media budget, the generator, the recovery and the late-cost
   * settler use, so a reservation, its updates and the settler's backoff are measured on one clock.
   */
  private readonly mediaNow: () => number;

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

  /**
   * One media generation (#238): OpenRouter's own reported cost, as is — no price table, no tokens. The row is an
   * API key row (the OpenRouter key), so its cost counts in every total, today's cost check and the forecast; a
   * generation OpenRouter reported no cost for is "미제공" (`costMissing`). `callId` is unique per generation (one
   * row each). A repeat with the same id replaces the cost only when it carries one (a correction, `0` included); a
   * repeat with `null` never erases a cost already known.
   */
  recordMedia(m: {
    userId: string;
    conversationId: string | null;
    runId: string;
    callId: string;
    model: string;
    costUsd: number | null;
  }): void {
    const at = this.mediaNow();
    const usd = cost(m.costUsd ?? undefined);
    const micros = usd === null ? null : Math.round(usd * 1_000_000);
    const row = this.db
      .insert(usageRecords)
      .values({
        userId: m.userId,
        conversationId: m.conversationId,
        runId: mediaRunKey(m.runId, m.callId),
        attempt: 1,
        runtime: MEDIA_RUNTIME,
        model: m.model,
        connectionId: null,
        purpose: "media",
        createdAt: at,
        authType: "api_key",
        priceVersion: null,
        pricedCostMicros: micros,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costUsd: usd,
        mediaSettlement: usd === null ? "unconfirmed" : "settled",
        requestCount: 1,
        updatedAt: at,
      })
      .onConflictDoUpdate({
        target: [usageRecords.runId, usageRecords.attempt],
        // A re-report without a cost keeps the cost already known; a cost (a first one, or a correction — $0
        // included) replaces it.
        set:
          usd === null
            ? { updatedAt: at }
            : { costUsd: usd, pricedCostMicros: micros, mediaSettlement: "settled", updatedAt: at },
      })
      .returning({ createdAt: usageRecords.createdAt })
      .get();
    // The day the row belongs to (a correction after midnight checks the day of the call — #251 r4).
    this.onRecorded?.(row?.createdAt ?? at);
  }

  /**
   * 미디어 생성 (#238): a paid generation's row written **before** its request, holding the call's reserved upper
   * bound (`estimated_cost_micros`), state `reserved` and no cost yet. The daily media budget counts the bound until
   * a cost is settled — also when none ever comes. Throws when the row cannot be written (then nothing is sent).
   * Synchronous: the caller checks the budget and writes this in one go, so two calls cannot both take the last of
   * the budget.
   */
  reserveMedia(m: {
    userId: string;
    conversationId: string | null;
    runId: string;
    callId: string;
    model: string;
    /** The bound in USD (rounded up to micro-USD here), or — #248 — already as integer micro-USD. */
    estimateUsd?: number;
    estimateMicros?: number;
    /**
     * #248: `pending_send` — a speech piece reserved ahead of its request (`sendingMedia` turns it `reserved` right
     * before the request). #238 stage 3: `video_job` — an approved video job's bound, settled or made `unconfirmed`
     * by its job only (the start-up recovery and the late-cost settler never touch it). Default `reserved` (the
     * request follows at once).
     */
    state?: "pending_send" | "reserved" | "video_job";
    /**
     * The moment of the reservation — the one the caller checked the budget at (#251 r2: the row counts for the
     * day that was checked, even when midnight passes before the insert). Default: now.
     */
    at?: number;
  }): void {
    const micros =
      m.estimateMicros !== undefined ? m.estimateMicros : Math.ceil((m.estimateUsd ?? NaN) * 1_000_000);
    if (!Number.isSafeInteger(micros) || micros < 0) throw new Error("bad estimate");
    const at = m.at ?? this.mediaNow();
    const unsent = m.state === "pending_send";
    this.db
      .insert(usageRecords)
      .values({
        userId: m.userId,
        conversationId: m.conversationId,
        runId: mediaRunKey(m.runId, m.callId),
        attempt: 1,
        runtime: MEDIA_RUNTIME,
        model: m.model,
        connectionId: null,
        purpose: "media",
        createdAt: at,
        authType: "api_key",
        priceVersion: null,
        pricedCostMicros: null,
        estimatedCostMicros: micros,
        mediaSettlement: m.state ?? "reserved",
        mediaSettleTries: 0,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        costUsd: null,
        // A piece not sent yet is no request (yet): counted when `sendingMedia` marks it sent (#251 r2).
        requestCount: unsent ? 0 : 1,
        updatedAt: at,
      })
      .run();
  }

  /**
   * #248: a reserved speech piece whose request goes out now (`pending_send` → `reserved`, and now one request).
   * Its day does not change: a call's costs count for the day it started (#251 r3). False when there is no such
   * unsent row (nothing may be sent then).
   */
  sendingMedia(runKey: string): boolean {
    return (
      this.db
        .update(usageRecords)
        .set({ mediaSettlement: "reserved", requestCount: 1, updatedAt: this.mediaNow() })
        .where(
          and(
            eq(usageRecords.runId, runKey),
            eq(usageRecords.purpose, "media"),
            eq(usageRecords.mediaSettlement, "pending_send"),
          ),
        )
        .run().changes === 1
    );
  }

  /**
   * The reported cost of a reserved generation (it replaces the bound in the budget). The daily cost check runs for
   * the day the row belongs to (its `created_at`), not the day the cost arrived — a call made before midnight and
   * settled after it counts for the day it was made.
   */
  settleMedia(runKey: string, costUsd: number): void {
    const usd = cost(costUsd);
    if (usd === null) return;
    const row = this.db
      .update(usageRecords)
      .set({
        costUsd: usd,
        pricedCostMicros: Math.round(usd * 1_000_000),
        mediaSettlement: "settled",
        updatedAt: this.mediaNow(),
      })
      .where(and(eq(usageRecords.runId, runKey), eq(usageRecords.purpose, "media")))
      .returning({ createdAt: usageRecords.createdAt })
      .get();
    if (row) this.onRecorded?.(row.createdAt);
  }

  /**
   * A generation answered without a cost: `awaiting_cost` with OpenRouter's generation id (looked up again later by
   * the settler), or `unconfirmed` when there is no id to look up. The bound keeps holding the budget either way.
   */
  answeredMedia(runKey: string, generationId: string | null): void {
    this.db
      .update(usageRecords)
      .set({
        mediaGenerationId: generationId,
        mediaSettlement: generationId ? "awaiting_cost" : "unconfirmed",
        updatedAt: this.mediaNow(),
      })
      .where(and(eq(usageRecords.runId, runKey), eq(usageRecords.purpose, "media")))
      .run();
  }

  /** A generation whose cost can never be confirmed (an unknown outcome, or the lookups gave up). */
  unconfirmMedia(runKey: string): void {
    this.db
      .update(usageRecords)
      .set({ mediaSettlement: "unconfirmed", updatedAt: this.mediaNow() })
      .where(and(eq(usageRecords.runId, runKey), eq(usageRecords.purpose, "media")))
      .run();
  }

  /**
   * #238 stage 3: a video job's bound that will never be confirmed (the job failed, timed out, was not confirmed, or
   * its conversation went) — only while it is still the job's (`video_job`): a cost already settled stays.
   */
  unconfirmVideoMedia(runKey: string): void {
    this.db
      .update(usageRecords)
      .set({ mediaSettlement: "unconfirmed", updatedAt: this.mediaNow() })
      .where(
        and(
          eq(usageRecords.runId, runKey),
          eq(usageRecords.purpose, "media"),
          eq(usageRecords.mediaSettlement, "video_job"),
        ),
      )
      .run();
  }

  /** #238 stage 3: a refused video submit's bound (never billed) — only while it is still the job's (`video_job`). */
  releaseVideoMedia(runKey: string): void {
    this.db
      .delete(usageRecords)
      .where(
        and(
          eq(usageRecords.runId, runKey),
          eq(usageRecords.purpose, "media"),
          eq(usageRecords.mediaSettlement, "video_job"),
        ),
      )
      .run();
  }

  /** One more cost lookup that found nothing (the settler's backoff counts these). */
  triedMedia(runKey: string, tries: number): void {
    this.db
      .update(usageRecords)
      .set({ mediaSettleTries: tries, updatedAt: this.mediaNow() })
      .where(and(eq(usageRecords.runId, runKey), eq(usageRecords.purpose, "media")))
      .run();
  }

  /**
   * The generation id of a reserved generation, written as soon as the 2xx headers came (before its body is read
   * or its cost looked up): a process that stops right then leaves a row the next one can still settle.
   */
  generationMedia(runKey: string, generationId: string): void {
    this.db
      .update(usageRecords)
      .set({ mediaGenerationId: generationId, updatedAt: this.mediaNow() })
      .where(
        and(
          eq(usageRecords.runId, runKey),
          eq(usageRecords.purpose, "media"),
          eq(usageRecords.mediaSettlement, "reserved"),
        ),
      )
      .run();
  }

  /**
   * At start, before the server takes any request (#238 review r4): **every** `reserved` row is a previous
   * process's — one server holds the data folder's lock (storage/data-lock.ts), and no media call of this process
   * has started yet — so no clock is compared. With a generation id it waits for its cost (`awaiting_cost`), without
   * one it is `unconfirmed` (its reserved amount stays). A `pending_send` row (#248: a speech piece whose request
   * was never sent) is removed — it cost nothing. One transaction: all of it, or none. Returns the count.
   */
  recoverReservedMedia(o: { noWait?: boolean } = {}): number {
    const at = this.mediaNow();
    const reserved = and(eq(usageRecords.purpose, "media"), eq(usageRecords.mediaSettlement, "reserved"));
    const sqlite = this.db.$client;
    const move = sqlite.transaction(() => {
      const a = this.db
        .update(usageRecords)
        .set({ mediaSettlement: "awaiting_cost", updatedAt: at })
        .where(and(reserved, isNotNull(usageRecords.mediaGenerationId)))
        .run().changes;
      const b = this.db
        .update(usageRecords)
        .set({ mediaSettlement: "unconfirmed", updatedAt: at })
        .where(and(reserved, isNull(usageRecords.mediaGenerationId)))
        .run().changes;
      const c = this.db
        .delete(usageRecords)
        .where(and(eq(usageRecords.purpose, "media"), eq(usageRecords.mediaSettlement, "pending_send")))
        .run().changes;
      return a + b + c;
    });
    // BEGIN IMMEDIATE: the write lock is taken first. `noWait` (a background retry, review r6): with the busy
    // handler off for this one statement, a lock held elsewhere is SQLITE_BUSY at once — the event loop never
    // waits for it — and the next timer tick tries again.
    if (!o.noWait) return move.immediate();
    const timeout = Number(sqlite.pragma("busy_timeout", { simple: true })) || 0;
    sqlite.pragma("busy_timeout = 0");
    try {
      return move.immediate();
    } finally {
      sqlite.pragma(`busy_timeout = ${timeout}`);
    }
  }

  /**
   * Generations waiting for their cost (`awaiting_cost`) that are due at `at`: their backoff since the last try
   * (1 min · 2^tries, at most 6 h) has passed, or they are to be given up (no id, too many tries, too old) — the due
   * ones are chosen first, then at most `limit`, oldest try first. `giveUpOnly`: only the rows to be given up (a
   * cycle without a key can do nothing else).
   */
  dueMedia(
    at: number,
    o: { maxTries: number; maxAgeMs: number; limit: number; giveUpOnly?: boolean },
  ): { runKey: string; generationId: string | null; tries: number; createdAt: number; updatedAt: number }[] {
    const tries = sql`coalesce(${usageRecords.mediaSettleTries}, 0)`;
    return this.db
      .select({
        runKey: usageRecords.runId,
        generationId: usageRecords.mediaGenerationId,
        tries: usageRecords.mediaSettleTries,
        createdAt: usageRecords.createdAt,
        updatedAt: usageRecords.updatedAt,
      })
      .from(usageRecords)
      .where(
        and(
          eq(usageRecords.purpose, "media"),
          eq(usageRecords.mediaSettlement, "awaiting_cost"),
          or(
            isNull(usageRecords.mediaGenerationId),
            sql`${tries} >= ${o.maxTries}`,
            lt(usageRecords.createdAt, at - o.maxAgeMs),
            o.giveUpOnly
              ? undefined
              : sql`${usageRecords.updatedAt} + min(21600000, 60000 * (1 << min(${tries}, 20))) <= ${at}`,
          ),
        ),
      )
      .orderBy(asc(usageRecords.updatedAt))
      .limit(o.limit)
      .all()
      .map((r) => ({ ...r, tries: r.tries ?? 0 }));
  }

  /** A reserved generation OpenRouter refused (no charge): its row goes. */
  releaseMedia(runKey: string): void {
    this.db
      .delete(usageRecords)
      .where(and(eq(usageRecords.runId, runKey), eq(usageRecords.purpose, "media")))
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
