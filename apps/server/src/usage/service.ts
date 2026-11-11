import { and, desc, eq, gte, lt, sum } from "drizzle-orm";
import type {
  AdminUsageReport,
  MyUsage,
  UsageGroup,
  UsagePurpose,
  UsageRecordView,
  UsageSettings,
  UsageTotals,
} from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { connections, usageRecords, users } from "../db/schema.js";
import { logEvent, type EventLogger } from "../logging.js";
import { forecastMonth, monthInfo } from "./calendar.js";
import type { UsageRow } from "./store.js";

/** Settings keys (`settings` table). */
export const THRESHOLD_KEY = "usage.daily_cost_threshold_usd";
/** The service-zone day ("YYYY-MM-DD") the daily cost notification was last sent for. */
export const ALERTED_KEY = "usage.daily_cost_alerted_day";

const RUNTIME_LABEL: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex" };
export const PURPOSE_LABEL: Record<UsagePurpose, string> = {
  chat: "대화",
  schedule: "예약",
  title: "제목",
  summary: "요약",
  connection_test: "연결 테스트",
};
const NO_CONNECTION = "연결 없음";
const GONE_CONNECTION = "삭제된 연결";
const RECENT = 50;

type Row = UsageRow & { userName: string | null; connectionLabel: string | null };

export function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    costMissing: 0,
    apiKeyRequests: 0,
    subscriptionRequests: 0,
  };
}

/** Adds one row. Only API key rows carry a cost; one without a price counts as "미제공" instead. */
export function addRow(t: UsageTotals, r: UsageRow): void {
  const input = r.inputTokens ?? 0;
  const output = r.outputTokens ?? 0;
  t.requests += r.requestCount;
  t.inputTokens += input;
  t.outputTokens += output;
  t.cacheReadTokens += r.cacheReadTokens ?? 0;
  t.cacheWriteTokens += r.cacheWriteTokens ?? 0;
  t.totalTokens += input + output;
  if (r.authType === "api_key") {
    t.apiKeyRequests += r.requestCount;
    if (r.pricedCostUsd === null) t.costMissing += 1;
    else t.costUsd += r.pricedCostUsd;
  } else if (r.authType === "subscription") t.subscriptionRequests += r.requestCount;
}

function totalsOf(rows: UsageRow[]): UsageTotals {
  const t = emptyTotals();
  for (const r of rows) addRow(t, r);
  return t;
}

/** Groups rows by `key` (with its label), biggest cost first, then most requests. */
export function groupBy(rows: Row[], key: (r: Row) => [string, string]): UsageGroup[] {
  const groups = new Map<string, UsageGroup>();
  for (const r of rows) {
    const [k, label] = key(r);
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { key: k, label, ...emptyTotals() }));
    addRow(g, r);
  }
  return [...groups.values()].sort(
    (a, b) => b.costUsd - a.costUsd || b.requests - a.requests || a.label.localeCompare(b.label),
  );
}

const byUser = (r: Row): [string, string] => [r.userId, r.userName ?? "?"];
const byRuntime = (r: Row): [string, string] => [r.runtime, RUNTIME_LABEL[r.runtime] ?? r.runtime];
const byModel = (r: Row): [string, string] => [`${r.runtime}/${r.model}`, r.model];
const byConnection = (r: Row): [string, string] =>
  r.connectionId === null ? ["none", NO_CONNECTION] : [r.connectionId, r.connectionLabel ?? GONE_CONNECTION];
const byPurpose = (r: Row): [string, string] => [r.purpose, PURPOSE_LABEL[r.purpose]];

export type UsageServiceOptions = {
  /** Service time zone for days and months (default Asia/Seoul). */
  timeZone?: string;
  now?: () => number;
};

/** Plain settings storage (the `settings` table). */
export type SettingsLike = { get(key: string): string | undefined; set(key: string, value: string): void };

/**
 * Usage screens and the daily cost check (#32, FR-9.3·9.5). Reads only: nothing here is on the path that starts
 * or continues a run, and there is no budget limit (v1.1) — so nothing here can block a run.
 */
export class UsageService {
  readonly timeZone: string;
  private readonly now: () => number;

  constructor(
    private readonly db: Db,
    private readonly settings: SettingsLike,
    private readonly notifyAdmins: (amountUsd: number, thresholdUsd: number) => void,
    private readonly log: EventLogger | undefined,
    opts: UsageServiceOptions = {},
  ) {
    this.timeZone = opts.timeZone ?? "Asia/Seoul";
    this.now = opts.now ?? Date.now;
  }

  getSettings(): UsageSettings {
    const raw = this.settings.get(THRESHOLD_KEY);
    const n = raw === undefined || raw === "" ? NaN : Number(raw);
    return { dailyCostThresholdUsd: Number.isFinite(n) && n > 0 ? n : null };
  }

  setSettings(s: UsageSettings): UsageSettings {
    this.settings.set(THRESHOLD_KEY, s.dailyCostThresholdUsd === null ? "" : String(s.dailyCostThresholdUsd));
    return this.getSettings();
  }

  private rows(from: number, to: number, userId?: string): Row[] {
    return this.db
      .select({ r: usageRecords, userName: users.name, connectionLabel: connections.label })
      .from(usageRecords)
      .leftJoin(users, eq(users.id, usageRecords.userId))
      .leftJoin(connections, eq(connections.id, usageRecords.connectionId))
      .where(
        and(
          gte(usageRecords.createdAt, from),
          lt(usageRecords.createdAt, to),
          userId === undefined ? undefined : eq(usageRecords.userId, userId),
        ),
      )
      .orderBy(desc(usageRecords.createdAt), desc(usageRecords.id))
      .all()
      .map(({ r, userName, connectionLabel }) => ({ ...r, userName, connectionLabel }));
  }

  /** The caller's own usage this month — the only rows it reads are the caller's. */
  mine(userId: string): MyUsage {
    const m = monthInfo(this.now(), this.timeZone);
    const rows = this.rows(m.monthStart, m.monthEnd, userId);
    return {
      month: m.month,
      total: totalsOf(rows),
      byRuntime: groupBy(rows, byRuntime),
      byModel: groupBy(rows, byModel),
    };
  }

  /** Everyone's usage this month, in every breakdown, with today's cost and the month's forecast. */
  admin(priceVersion: number | null): AdminUsageReport {
    const at = this.now();
    const m = monthInfo(at, this.timeZone);
    const rows = this.rows(m.monthStart, m.monthEnd);
    const total = totalsOf(rows);
    const today = totalsOf(rows.filter((r) => r.createdAt >= m.dayStart && r.createdAt < m.dayEnd));
    const recent: UsageRecordView[] = rows.slice(0, RECENT).map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      userName: r.userName ?? "?",
      runtime: r.runtime,
      model: r.model,
      purpose: r.purpose,
      connectionLabel: byConnection(r)[1],
      authType: r.authType,
      totalTokens: (r.inputTokens ?? 0) + (r.outputTokens ?? 0),
      costUsd: r.authType === "api_key" ? r.pricedCostUsd : null,
      priceVersion: r.priceVersion,
    }));
    return {
      month: m.month,
      timeZone: this.timeZone,
      daysInMonth: m.daysInMonth,
      daysElapsed: m.dayOfMonth,
      daysRemaining: m.daysInMonth - m.dayOfMonth,
      total,
      todayCostUsd: today.costUsd,
      forecastCostUsd: forecastMonth(total.costUsd, m.dayOfMonth, m.daysInMonth),
      byUser: groupBy(rows, byUser),
      byRuntime: groupBy(rows, byRuntime),
      byModel: groupBy(rows, byModel),
      byConnection: groupBy(rows, byConnection),
      byPurpose: groupBy(rows, byPurpose),
      recent,
      priceVersion,
      settings: this.getSettings(),
    };
  }

  /** Today's cost so far (API key rows with a price), in the service zone. */
  todayCost(at: number): number {
    const m = monthInfo(at, this.timeZone);
    const row = this.db
      .select({ usd: sum(usageRecords.pricedCostUsd) })
      .from(usageRecords)
      .where(
        and(
          eq(usageRecords.authType, "api_key"),
          gte(usageRecords.createdAt, m.dayStart),
          lt(usageRecords.createdAt, m.dayEnd),
        ),
      )
      .get();
    return Number(row?.usd ?? 0);
  }

  /**
   * After a usage write (FR-9.5): if a threshold is set and today's cost is above it, notify the admins — once per
   * day. The day is claimed in a transaction before notifying, so the many writes of a busy day (or two at once)
   * send one notification. Never throws: a failure is logged with a fixed code and the run carries on. Only
   * notifies; never blocks anything.
   */
  checkDailyCost(at: number): void {
    try {
      const { dailyCostThresholdUsd: threshold } = this.getSettings();
      if (threshold === null) return;
      const day = monthInfo(at, this.timeZone).today;
      if (this.settings.get(ALERTED_KEY) === day) return;
      const amount = this.todayCost(at);
      if (!(amount > threshold)) return;
      const claimed = this.db.transaction(() => {
        if (this.settings.get(ALERTED_KEY) === day) return false;
        this.settings.set(ALERTED_KEY, day);
        return true;
      });
      if (!claimed) return;
      logEvent(this.log, "info", "usage.daily_cost_alert", { costUsd: amount });
      this.notifyAdmins(amount, threshold);
    } catch (e) {
      logEvent(this.log, "warn", "usage.alert_failed", { err: e });
    }
  }
}
