import crypto from "node:crypto";
import { and, asc, count, eq, sql } from "drizzle-orm";
import { symbolOk, WATCHLIST_MAX, type WatchlistItem, type WatchMarket } from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { watchlistItems } from "../db/schema.js";
import { scrubKnown } from "../secrets/known.js";

export type WatchlistRow = typeof watchlistItems.$inferSelect;

/** Why an item cannot be added: the status and the fixed code. */
export class WatchlistError extends Error {
  constructor(
    readonly status: 400 | 409,
    readonly code: "watchlist_bad_symbol" | "watchlist_full" | "watchlist_duplicate",
  ) {
    super(code);
  }
}

/**
 * Whether a symbol may be stored: it fits its market's pattern **and** contains no known secret (raw or encoded, by
 * the shared matcher). One answer for both (review #111): both checks always run and a failure of either is the
 * same `watchlist_bad_symbol`, so the API is no oracle for guessed secrets. (With the 7-character limit a symbol is
 * shorter than any known secret anyway; the matcher check stays as defence in depth.) A row whose symbol becomes a
 * known secret later is removed by the background rescrub (`rescrub.ts` `removeOn`).
 */
export function watchSymbolOk(market: WatchMarket, symbol: string): boolean {
  const pattern = symbolOk(market, symbol);
  const clean = scrubKnown(symbol) === symbol;
  return pattern && clean;
}

export const toWatchlistItem = (r: WatchlistRow): WatchlistItem => ({
  id: r.id,
  market: r.market,
  symbol: r.symbol,
  name: r.name ?? null,
  createdAt: r.createdAt,
});

/**
 * 관심 종목 (#31, FR-7.7): one person's list, Korean and US symbols together, in the order they were added. Only the
 * owner reads or changes it — the routes (`watchlist_item` resource) and `watchlist_get` (the run token's user).
 */
export class WatchlistStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  list(userId: string): WatchlistRow[] {
    return this.db
      .select()
      .from(watchlistItems)
      .where(eq(watchlistItems.userId, userId))
      .orderBy(asc(watchlistItems.createdAt), sql`rowid`)
      .all();
  }

  byId(id: string): WatchlistRow | undefined {
    return this.db.select().from(watchlistItems).where(eq(watchlistItems.id, id)).get();
  }

  add(
    userId: string,
    item: { market: WatchMarket; symbol: string; name?: string | undefined },
  ): WatchlistRow {
    if (!watchSymbolOk(item.market, item.symbol)) throw new WatchlistError(400, "watchlist_bad_symbol");
    // A display name from the search: third-party text — no known secret is stored (review round 26).
    const name = item.name?.trim() ? scrubKnown(item.name.trim()).slice(0, 60) : null;
    return this.db.transaction((tx) => {
      const n = tx.select({ n: count() }).from(watchlistItems).where(eq(watchlistItems.userId, userId)).get()!
        .n;
      const dup = tx
        .select({ id: watchlistItems.id })
        .from(watchlistItems)
        .where(
          and(
            eq(watchlistItems.userId, userId),
            eq(watchlistItems.market, item.market),
            eq(watchlistItems.symbol, item.symbol),
          ),
        )
        .get();
      if (dup) throw new WatchlistError(409, "watchlist_duplicate");
      if (n >= WATCHLIST_MAX) throw new WatchlistError(409, "watchlist_full");
      return tx
        .insert(watchlistItems)
        .values({
          id: crypto.randomUUID(),
          userId,
          market: item.market,
          symbol: item.symbol,
          name,
          createdAt: this.now(),
        })
        .returning()
        .get();
    });
  }

  remove(id: string): boolean {
    return this.db.delete(watchlistItems).where(eq(watchlistItems.id, id)).run().changes > 0;
  }
}
