import { and, eq, gte, lt } from "drizzle-orm";
import type { MediaSettings } from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { usageRecords } from "../db/schema.js";
import { monthInfo } from "../usage/calendar.js";
import { toMicros, toUsd } from "../usage/prices.js";

export type MediaBudgetState = {
  limitUsd: number;
  /** Media cost of this user today (service-zone day) as OpenRouter reported it. */
  spentUsd: number;
  /** What is left today, never below 0. */
  remainingUsd: number;
  /** Generations today OpenRouter reported no cost for (not in `spentUsd`). */
  uncosted: number;
};

/**
 * The per-user daily media budget (#238): the admin's `dailyCostLimitUsd` minus the user's `media` usage rows of
 * the service-zone day (integer micro-USD, summed exactly). Stage 2's tools ask `remaining` before every call and
 * refuse when it is 0 (or below the call's estimate). Read-only: it never writes.
 */
export class MediaBudget {
  constructor(
    private readonly db: Db,
    private readonly settings: () => Pick<MediaSettings, "dailyCostLimitUsd">,
    private readonly timeZone: string,
    private readonly now: () => number = Date.now,
  ) {}

  remaining(userId: string, at: number = this.now()): MediaBudgetState {
    const r = this.micros(userId, at);
    return {
      limitUsd: r.limitUsd,
      spentUsd: toUsd(r.spent),
      remainingUsd: toUsd(r.left),
      uncosted: r.uncosted,
    };
  }

  /**
   * Whether a call estimated at `estimateUsd` still fits today's budget. Only an omitted estimate or an explicit `0`
   * means "not known" (then: something must be left); a negative or non-finite estimate (a broken price
   * computation) is refused, never treated as free.
   */
  allows(userId: string, estimateUsd: number = 0, at: number = this.now()): boolean {
    if (typeof estimateUsd !== "number" || !Number.isFinite(estimateUsd) || estimateUsd < 0) return false;
    const { left } = this.micros(userId, at);
    const estimate = Math.round(estimateUsd * 1_000_000);
    return left > 0 && estimate <= left;
  }

  private micros(userId: string, at: number) {
    const day = monthInfo(at, this.timeZone);
    const rows = this.db
      .select({ micros: usageRecords.pricedCostMicros })
      .from(usageRecords)
      .where(
        and(
          eq(usageRecords.userId, userId),
          eq(usageRecords.purpose, "media"),
          gte(usageRecords.createdAt, day.dayStart),
          lt(usageRecords.createdAt, day.dayEnd),
        ),
      )
      .all();
    let spent = 0;
    let uncosted = 0;
    for (const r of rows) {
      if (r.micros === null) uncosted += 1;
      else spent += r.micros;
    }
    const limitUsd = this.settings().dailyCostLimitUsd;
    return { limitUsd, spent, uncosted, left: Math.max(0, toMicros(limitUsd) - spent) };
  }
}
