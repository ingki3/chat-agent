import { z } from "zod";
import { ConnectionAuthType } from "./connections.js";

/**
 * Usage screens (#32, PRD FR-9). Costs are USD and only for API key connections, from a versioned price table;
 * subscription connections count requests and tokens only. A cost the price table cannot give is `null` and is
 * shown as "미제공". There is no budget limit in v1: nothing here can stop a run.
 */

export const USAGE_PURPOSES = ["chat", "schedule", "title", "summary", "connection_test"] as const;
export const UsagePurpose = z.enum(USAGE_PURPOSES);
export type UsagePurpose = z.infer<typeof UsagePurpose>;

/** USD per million tokens; `null` = not provided. */
const Price = z.number().finite().min(0).max(10_000).nullable();

/** One model's prices. Runtime + model is the key (`runs.model` as the runtime reports it). */
export const ModelPrice = z.object({
  runtime: z.string().trim().min(1).max(40),
  model: z.string().trim().min(1).max(100),
  input: Price,
  output: Price,
  cacheRead: Price,
  cacheWrite: Price,
});
export type ModelPrice = z.infer<typeof ModelPrice>;

/** `PUT /api/admin/usage/prices`: the whole new table. Saving makes a new version; old versions stay. */
export const PriceTableRequest = z
  .object({ prices: z.array(ModelPrice).max(200) })
  .refine((t) => new Set(t.prices.map((p) => `${p.runtime}\u0000${p.model}`)).size === t.prices.length, {
    message: "duplicate model",
  });
export type PriceTableRequest = z.infer<typeof PriceTableRequest>;

export const PriceTable = z.object({
  version: z.number().int(),
  prices: z.array(ModelPrice),
  createdAt: z.number().int(),
});
export type PriceTable = z.infer<typeof PriceTable>;

/** `GET /api/admin/usage/prices`: the current table (null before the first save) and the version history. */
export const PriceTableResponse = z.object({
  current: PriceTable.nullable(),
  versions: z.array(
    z.object({ version: z.number().int(), createdAt: z.number().int(), models: z.number().int() }),
  ),
});
export type PriceTableResponse = z.infer<typeof PriceTableResponse>;

/** `GET/PUT /api/admin/usage/settings`. The budget switch is not here: it comes in v1.1 (FR-9.1). */
export const UsageSettings = z.object({
  /** Today's cost above this → one admin notification (`daily_cost`) per day; null = off. */
  dailyCostThresholdUsd: z.number().finite().positive().max(100_000).nullable(),
});
export type UsageSettings = z.infer<typeof UsageSettings>;

/** Sums over a set of usage rows. Tokens the runtime did not report count as 0. */
export const UsageTotals = z.object({
  requests: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cacheReadTokens: z.number().int(),
  cacheWriteTokens: z.number().int(),
  /** input (cache included) + output. */
  totalTokens: z.number().int(),
  /** Sum of the costs that could be computed (API key rows with a price). */
  costUsd: z.number(),
  /** API key rows whose cost is not provided ("미제공": no price for the model, or tokens not reported). */
  costMissing: z.number().int(),
  /** Rows on API key connections (costed) and on subscriptions (requests and tokens only). */
  apiKeyRequests: z.number().int(),
  subscriptionRequests: z.number().int(),
});
export type UsageTotals = z.infer<typeof UsageTotals>;

export const UsageGroup = UsageTotals.extend({ key: z.string(), label: z.string() });
export type UsageGroup = z.infer<typeof UsageGroup>;

/** `GET /api/usage/me`: the caller's own usage this month (sidebar, settings). */
export const MyUsage = z.object({
  /** "YYYY-MM" in the service time zone. */
  month: z.string(),
  total: UsageTotals,
  byRuntime: z.array(UsageGroup),
  byModel: z.array(UsageGroup),
});
export type MyUsage = z.infer<typeof MyUsage>;

export const UsageRecordView = z.object({
  id: z.number().int(),
  createdAt: z.number().int(),
  userName: z.string(),
  runtime: z.string(),
  model: z.string(),
  purpose: UsagePurpose,
  connectionLabel: z.string(),
  authType: ConnectionAuthType.nullable(),
  totalTokens: z.number().int(),
  /** null = not costed (subscription / no connection) or not provided — see `authType`. */
  costUsd: z.number().nullable(),
  priceVersion: z.number().int().nullable(),
});
export type UsageRecordView = z.infer<typeof UsageRecordView>;

/** `GET /api/admin/usage`: this month for everyone (FR-9.3, 9.5). */
export const AdminUsageReport = z.object({
  month: z.string(),
  timeZone: z.string(),
  daysInMonth: z.number().int(),
  /** Days of the month so far, today included. */
  daysElapsed: z.number().int(),
  daysRemaining: z.number().int(),
  total: UsageTotals,
  todayCostUsd: z.number(),
  /** This month's cost so far + daily average × days remaining. */
  forecastCostUsd: z.number(),
  byUser: z.array(UsageGroup),
  byRuntime: z.array(UsageGroup),
  byModel: z.array(UsageGroup),
  byConnection: z.array(UsageGroup),
  byPurpose: z.array(UsageGroup),
  recent: z.array(UsageRecordView),
  priceVersion: z.number().int().nullable(),
  settings: UsageSettings,
});
export type AdminUsageReport = z.infer<typeof AdminUsageReport>;
