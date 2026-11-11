import { desc, eq, sql } from "drizzle-orm";
import type { ModelPrice, PriceTable } from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { priceTables } from "../db/schema.js";

/** The token figures a cost is computed from (as stored: input includes cached tokens; NULL = not reported). */
export type TokenFigures = {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
};

const PER = 1_000_000;

/**
 * Cost in USD of one usage row at `price` (USD per million tokens), or null when it cannot be given ("미제공"):
 * no price for the model, input or output tokens not reported, or a price missing for a kind of token the row
 * used. Input tokens include cached ones (adapter contract), so cache reads and writes are taken out of input
 * and charged at their own price. Cache figures the runtime did not report count as none.
 */
export function costOf(t: TokenFigures, price: ModelPrice | undefined): number | null {
  if (!price || t.inputTokens === null || t.outputTokens === null) return null;
  const cacheRead = t.cacheReadTokens ?? 0;
  const cacheWrite = t.cacheWriteTokens ?? 0;
  const parts: [number, number | null][] = [
    [Math.max(0, t.inputTokens - cacheRead - cacheWrite), price.input],
    [t.outputTokens, price.output],
    [cacheRead, price.cacheRead],
    [cacheWrite, price.cacheWrite],
  ];
  let usd = 0;
  for (const [tokens, perMillion] of parts) {
    if (tokens === 0) continue;
    if (perMillion === null) return null;
    usd += (tokens * perMillion) / PER;
  }
  return usd;
}

/**
 * Versioned price tables (#32). `save` always adds a version — a version is never changed, so costs written with
 * it stay as they were. Versions are numbered 1, 2, … in the order they were saved.
 */
export class PriceStore {
  /** Versions are immutable: cache their parsed tables (a usage write looks one up every time). */
  private readonly cache = new Map<number, PriceTable>();

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  currentVersion(): number | null {
    const row = this.db
      .select({ v: sql<number | null>`max(${priceTables.version})` })
      .from(priceTables)
      .get();
    return row?.v ?? null;
  }

  current(): PriceTable | null {
    const v = this.currentVersion();
    return v === null ? null : (this.version(v) ?? null);
  }

  version(v: number): PriceTable | undefined {
    const hit = this.cache.get(v);
    if (hit) return hit;
    const row = this.db.select().from(priceTables).where(eq(priceTables.version, v)).get();
    if (!row) return undefined;
    const table: PriceTable = { version: row.version, prices: row.prices, createdAt: row.createdAt };
    this.cache.set(v, table);
    return table;
  }

  /** The price of one runtime's model in version `v`, if that version lists it. */
  priceIn(v: number, runtime: string, model: string): ModelPrice | undefined {
    return this.version(v)?.prices.find((p) => p.runtime === runtime && p.model === model);
  }

  versions(): { version: number; createdAt: number; models: number }[] {
    return this.db
      .select()
      .from(priceTables)
      .orderBy(desc(priceTables.version))
      .all()
      .map((r) => ({ version: r.version, createdAt: r.createdAt, models: r.prices.length }));
  }

  /** Saves a new version (the next number) and returns it. */
  save(prices: ModelPrice[], createdBy: string): PriceTable {
    return this.db.transaction((tx) => {
      const top = tx
        .select({ v: sql<number | null>`max(${priceTables.version})` })
        .from(priceTables)
        .get();
      const version = (top?.v ?? 0) + 1;
      const createdAt = this.now();
      tx.insert(priceTables).values({ version, prices, createdBy, createdAt }).run();
      return { version, prices, createdAt };
    });
  }
}
