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

/** 1 USD in micro-USD: costs are stored, summed and compared as integers of this unit. */
export const MICROS = 1_000_000;
export const toUsd = (micros: number) => micros / MICROS;

/**
 * A non-negative decimal string ("0.29", "15", "1.5") as an exact integer in units of 10^-`scale` (BigInt), or
 * undefined when it is not one or has more than `scale` decimals. No float is involved anywhere.
 */
export function parseDecimal(value: string, scale: number): bigint | undefined {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value);
  if (!m) return undefined;
  const frac = m[2] ?? "";
  if (frac.length > scale) return undefined;
  return BigInt(m[1]!) * 10n ** BigInt(scale) + BigInt(frac.padEnd(scale, "0") || "0");
}

/**
 * A USD amount (the daily threshold) in integer micro-USD, parsed from its shortest decimal form — exact for the
 * at-most-6-decimal values the settings accept.
 */
export function toMicros(usd: number): number {
  const exact = parseDecimal(String(usd), 6);
  if (exact === undefined) throw new Error("amount_not_decimal");
  return Number(exact);
}

/**
 * Cost of one usage row at `price` in integer micro-USD, or null when it cannot be given ("미제공"): no price for the
 * model, input or output tokens not reported, or a price missing for a kind of token the row used. Input tokens
 * include cached ones (adapter contract), so cache reads and writes are taken out of input and charged at their own
 * price. Cache figures the runtime did not report count as none.
 *
 * Exact: each price ("USD per million tokens", ≤ 6 decimals) is read as an integer of micro-USD per million tokens,
 * tokens × that is an integer of 10^-12 USD (BigInt), the parts are summed exactly, and the sum is rounded once to
 * a whole micro-USD, half up (50 tokens × $0.29/M = 14.5 → 15 micro-USD).
 */
export function costOf(t: TokenFigures, price: ModelPrice | undefined): number | null {
  if (!price || t.inputTokens === null || t.outputTokens === null) return null;
  const cacheRead = t.cacheReadTokens ?? 0;
  const cacheWrite = t.cacheWriteTokens ?? 0;
  const parts: [number, string | null][] = [
    [Math.max(0, t.inputTokens - cacheRead - cacheWrite), price.input],
    [t.outputTokens, price.output],
    [cacheRead, price.cacheRead],
    [cacheWrite, price.cacheWrite],
  ];
  let pico = 0n; // 10^-12 USD
  for (const [tokens, perMillion] of parts) {
    if (tokens === 0) continue;
    if (perMillion === null) return null;
    const microPerMillion = parseDecimal(perMillion, 6);
    if (microPerMillion === undefined) return null; // not a price we accept: 미제공, never a guess
    pico += BigInt(tokens) * microPerMillion;
  }
  return Number((pico + 500_000n) / 1_000_000n);
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
