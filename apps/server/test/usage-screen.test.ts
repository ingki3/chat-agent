import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdminUsageReport,
  CSRF_HEADER,
  MyUsage,
  PriceTableResponse,
  type ModelPrice,
  type Run,
  type UsageGroup,
} from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { connections, notifications, usageRecords, users } from "../src/db/schema.js";
import { RuntimeRegistry } from "../src/runtime/adapter.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import { forecastMonth, monthInfo } from "../src/usage/calendar.js";
import { costOf, PriceStore } from "../src/usage/prices.js";
import { UsageService } from "../src/usage/service.js";
import { UsageStore, type UsageAttempt } from "../src/usage/store.js";
import { createFamily } from "./helpers/permission-matrix.js";

type App = Awaited<ReturnType<typeof buildApp>>;
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

const here = path.dirname(fileURLToPath(import.meta.url));
/** AC-12 fixture: a made-up price table (test-v1) and four records (docs/acceptance.md AC-12). */
const FIXTURE = JSON.parse(
  fs.readFileSync(path.resolve(here, "../../../fixtures/acceptance/usage-fixture.json"), "utf8"),
) as {
  priceTable: {
    usdPerMTok: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>;
  };
  records: {
    user: "dad" | "wife" | "son";
    runtime: string;
    model: string;
    connection: string;
    auth: "api_key" | "subscription";
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  }[];
  expected: {
    costUsdByRecord: (number | null)[];
    totalCostUsd: number;
    byUserCostUsd: Record<string, number>;
    subscriptionTokensByUser: Record<string, number>;
  };
};
const RUNTIME_OF: Record<string, string> = { "claude-opus-5-5": "claude-code", "gpt-6.1-sol": "codex" };
const FIXTURE_PRICES: ModelPrice[] = Object.entries(FIXTURE.priceTable.usdPerMTok).map(([model, p]) => ({
  runtime: RUNTIME_OF[model]!,
  model,
  ...p,
}));
/** The fixture's input excludes cached tokens; our rows (adapter contract) include them. */
const reportOf = (r: (typeof FIXTURE.records)[number]) => ({
  inputTokens: r.input + r.cacheRead + r.cacheWrite,
  outputTokens: r.output,
  cacheReadTokens: r.cacheRead,
  cacheWriteTokens: r.cacheWrite,
});

/** 2026-11-11 12:00 in Seoul (03:00 UTC). */
const NOV_11_NOON_KST = Date.UTC(2026, 10, 11, 3, 0, 0);
const DAY = 86_400_000;

describe("cost of one row (#32)", () => {
  const price: ModelPrice = {
    runtime: "claude-code",
    model: "m",
    input: 10,
    output: 50,
    cacheRead: 1,
    cacheWrite: 12.5,
  };

  it("the AC-12 fixture's API key records cost what the fixture expects", () => {
    FIXTURE.records.forEach((r, i) => {
      const want = FIXTURE.expected.costUsdByRecord[i]!;
      if (want === null) return; // the subscription record: never costed (see the store tests)
      const p = FIXTURE_PRICES.find((x) => x.model === r.model);
      expect(costOf(reportOf(r), p)).toBe(Math.round(want * 1_000_000));
    });
  });

  it("no price, unreported input/output, or a missing price for tokens that were used → null (미제공)", () => {
    const t = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(costOf(t, undefined)).toBeNull();
    expect(costOf({ ...t, inputTokens: null }, price)).toBeNull();
    expect(costOf({ ...t, outputTokens: null }, price)).toBeNull();
    expect(costOf({ ...t, cacheReadTokens: 500 }, { ...price, cacheRead: null })).toBeNull();
    // A missing price for a kind of token not used does not matter.
    expect(costOf(t, { ...price, cacheRead: null, cacheWrite: null })).toBe(15_000);
    // Unreported cache figures count as none.
    expect(costOf({ ...t, cacheReadTokens: null, cacheWriteTokens: null }, price)).toBe(15_000);
  });
});

describe("calendar and forecast (#32, FR-9.5)", () => {
  it("forecast = month so far + daily average × days remaining", () => {
    expect(forecastMonth(30, 10, 30)).toBeCloseTo(90, 10);
    expect(forecastMonth(11, 11, 30)).toBeCloseTo(30, 10);
    expect(forecastMonth(5, 31, 31)).toBeCloseTo(5, 10); // last day: nothing left to add
    expect(forecastMonth(0, 1, 30)).toBe(0);
  });

  it("months and days are the service zone's (Seoul), not UTC", () => {
    const m = monthInfo(NOV_11_NOON_KST, "Asia/Seoul");
    expect(m).toMatchObject({ month: "2026-11", today: "2026-11-11", daysInMonth: 30, dayOfMonth: 11 });
    expect(m.monthStart).toBe(Date.UTC(2026, 9, 31, 15, 0, 0)); // 2026-11-01 00:00 KST
    expect(m.monthEnd).toBe(Date.UTC(2026, 10, 30, 15, 0, 0));
    expect(m.dayStart).toBe(Date.UTC(2026, 10, 10, 15, 0, 0));
    expect(m.dayEnd - m.dayStart).toBe(DAY);
    // 2026-10-31 20:00 UTC is already November 1st in Seoul.
    expect(monthInfo(Date.UTC(2026, 9, 31, 20), "Asia/Seoul").month).toBe("2026-11");
    expect(monthInfo(Date.UTC(2026, 9, 31, 20), "UTC").month).toBe("2026-10");
    // A zone with daylight saving time: the day it ends is 25 hours long.
    const fallBack = monthInfo(Date.UTC(2026, 10, 1, 12), "America/New_York");
    expect(fallBack.dayEnd - fallBack.dayStart).toBe(DAY + 3600_000);
  });
});

/** A bare store: users, a key and a subscription connection, a mutable clock. */
function bare() {
  const db = createTestDb();
  for (const id of ["u1", "u2"])
    db.insert(users)
      .values({ id, email: `${id}@example.com`, name: id, role: "member" })
      .run();
  const conn = (id: string, authType: "api_key" | "subscription", runtime = "claude-code") =>
    db
      .insert(connections)
      .values({
        id,
        runtime,
        authType,
        scope: "personal",
        ownerId: "u1",
        label: id,
        createdAt: 0,
        updatedAt: 0,
      })
      .run();
  conn("key", "api_key");
  conn("sub", "subscription");
  conn("codex-sub", "subscription", "codex");
  const clock = { t: NOV_11_NOON_KST };
  const prices = new PriceStore(db, () => clock.t);
  const usage = new UsageStore(db, () => clock.t, { prices });
  let seq = 0;
  const attempt = (o: Partial<UsageAttempt> = {}): UsageAttempt => ({
    userId: "u1",
    conversationId: "c1",
    runId: `run-${++seq}`,
    attempt: 1,
    runtime: "claude-code",
    model: "opus",
    connectionId: "key",
    purpose: "chat",
    ...o,
  });
  const row = (runId: string) =>
    db
      .select()
      .from(usageRecords)
      .all()
      .find((r) => r.runId === runId)!;
  const opus = (input: number, output: number): ModelPrice => ({
    runtime: "claude-code",
    model: "opus",
    input,
    output,
    cacheRead: null,
    cacheWrite: null,
  });
  return { db, clock, prices, usage, attempt, row, opus };
}

describe("costing at record time (#32): API key only, pinned price version", () => {
  it("an API key row is costed from the current version and keeps that version", () => {
    const t = bare();
    t.prices.save([t.opus(10, 50)], "admin");
    const a = t.attempt();
    t.usage.record(a, { inputTokens: 100_000, outputTokens: 10_000, costUsd: 9.99 });
    expect(t.row(a.runId)).toMatchObject({
      authType: "api_key",
      priceVersion: 1,
      pricedCostMicros: 1_500_000,
      costUsd: 9.99, // the runtime's own figure is kept for reference, not used
    });
  });

  it("a subscription row gets no cost even with a price and a runtime-reported cost (tokens and requests only)", () => {
    const t = bare();
    t.prices.save([t.opus(10, 50)], "admin");
    const a = t.attempt({ connectionId: "sub" });
    t.usage.record(a, { inputTokens: 100_000, outputTokens: 10_000, costUsd: 1.23 });
    expect(t.row(a.runId)).toMatchObject({
      authType: "subscription",
      priceVersion: null,
      pricedCostMicros: null,
      inputTokens: 100_000,
      requestCount: 1,
    });
  });

  it("no connection (development fake runtime) → not costed; unknown connection → not costed", () => {
    const t = bare();
    t.prices.save([t.opus(10, 50)], "admin");
    const a = t.attempt({ connectionId: null });
    const b = t.attempt({ connectionId: "gone" });
    t.usage.record(a, { inputTokens: 1000, outputTokens: 10 });
    t.usage.record(b, { inputTokens: 1000, outputTokens: 10 });
    expect(t.row(a.runId)).toMatchObject({ authType: null, priceVersion: null, pricedCostMicros: null });
    // A connection id that names nothing: explicitly unknown (미확인, counted as 미제공), no price applied.
    expect(t.row(b.runId)).toMatchObject({ authType: "unknown", priceVersion: null, pricedCostMicros: null });
  });

  it("an API key row with no price table, or a model the table does not list → cost NULL (미제공)", () => {
    const t = bare();
    const a = t.attempt();
    t.usage.record(a, { inputTokens: 1000, outputTokens: 10 });
    expect(t.row(a.runId)).toMatchObject({ authType: "api_key", priceVersion: null, pricedCostMicros: null });
    t.prices.save([t.opus(10, 50)], "admin");
    const b = t.attempt({ model: "haiku" });
    t.usage.record(b, { inputTokens: 1000, outputTokens: 10 });
    expect(t.row(b.runId)).toMatchObject({ authType: "api_key", priceVersion: 1, pricedCostMicros: null });
  });

  it("editing prices makes a new version and never rewrites past costs; a later report of an old attempt keeps its version", () => {
    const t = bare();
    t.prices.save([t.opus(10, 50)], "admin");
    const old = t.attempt();
    t.usage.record(old, { inputTokens: 100_000, outputTokens: 0 });
    expect(t.row(old.runId).pricedCostMicros).toBe(1_000_000);

    const v2 = t.prices.save([t.opus(20, 100)], "admin");
    expect(v2.version).toBe(2);
    expect(t.prices.version(1)!.prices[0]!.input).toBe(10); // version 1 is still there, unchanged
    expect(t.row(old.runId)).toMatchObject({ priceVersion: 1, pricedCostMicros: 1_000_000 });

    // The old attempt reports again (last one wins): its figures change, its version does not.
    t.usage.record(old, { inputTokens: 200_000, outputTokens: 0 });
    expect(t.row(old.runId)).toMatchObject({ priceVersion: 1, inputTokens: 200_000 });
    expect(t.row(old.runId).pricedCostMicros).toBe(2_000_000); // 200k × $10, not × $20

    const fresh = t.attempt();
    t.usage.record(fresh, { inputTokens: 100_000, outputTokens: 0 });
    expect(t.row(fresh.runId)).toMatchObject({ priceVersion: 2, pricedCostMicros: 2_000_000 });
  });

  it("the auth type is pinned at the first write too (a connection that changes later does not recost)", () => {
    const t = bare();
    t.prices.save([t.opus(10, 50)], "admin");
    const a = t.attempt({ connectionId: "sub" });
    t.usage.record(a, { inputTokens: 1000, outputTokens: 0 });
    t.db.update(connections).set({ authType: "api_key" }).run();
    t.usage.record(a, { inputTokens: 2000, outputTokens: 0 });
    expect(t.row(a.runId)).toMatchObject({ authType: "subscription", pricedCostMicros: null });

    // And the other way: an API key attempt stays costed (with its own version) after its connection changes.
    const b = t.attempt({ connectionId: "key" });
    t.usage.record(b, { inputTokens: 100_000, outputTokens: 0 });
    t.db.update(connections).set({ authType: "subscription" }).run();
    t.usage.record(b, { inputTokens: 200_000, outputTokens: 0 });
    expect(t.row(b.runId)).toMatchObject({ authType: "api_key", priceVersion: 1 });
    expect(t.row(b.runId).pricedCostMicros).toBe(2_000_000);
  });
});

const sumOf = (groups: UsageGroup[], k: "costUsd" | "requests" | "totalTokens" | "costMissing") =>
  groups.reduce((n, g) => n + g[k], 0);

async function start(o: { threshold?: number; tz?: string } = {}) {
  const db = createTestDb();
  const clock = { t: NOV_11_NOON_KST };
  const lines: string[] = [];
  const logStream = new Writable({ write: (c, _e, cb) => (lines.push(String(c)), cb()) });
  const runtimes = new RuntimeRegistry();
  const fake = new FakeRuntime({ needsConnection: true });
  runtimes.register(fake);
  const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
    db,
    logStream,
    runtimes,
    runs: { flushMs: 0 },
    notifications: { sender: async () => {} },
    usage: { now: () => clock.t, ...(o.tz ? { timeZone: o.tz } : {}) },
  });
  apps.push(app);
  const f = await createFamily(app);
  const headers = (cookie: string, write = false) => ({
    host: "localhost:3000",
    cookie,
    ...(write
      ? { origin: "http://localhost:3000", [CSRF_HEADER]: "1", "content-type": "application/json" }
      : {}),
  });
  const get = (cookie: string, url: string) => app.inject({ url, headers: headers(cookie) });
  const put = (cookie: string, url: string, payload: object) =>
    app.inject({ method: "PUT", url, headers: headers(cookie, true), payload });
  const conn = (ownerId: string | null, authType: "api_key" | "subscription", runtime = "claude-code") => {
    const owner = ownerId ? app.users!.byId(ownerId)! : undefined;
    const c =
      authType === "api_key"
        ? app.connections!.store.create({
            runtime: runtime as "claude-code",
            authType,
            scope: owner ? "personal" : "shared",
            owner: owner ?? null,
            createdBy: f.users.admin.id,
            secret:
              runtime === "codex" ? `sk-usagefake${"k".repeat(24)}` : `sk-ant-usagefake${"k".repeat(24)}`,
          })
        : (() => {
            const id = `sub-${Math.random().toString(36).slice(2)}`;
            db.insert(connections)
              .values({
                id,
                runtime,
                authType,
                scope: "personal",
                ownerId,
                label: "구독",
                createdAt: 0,
                updatedAt: 0,
              })
              .run();
            return { id };
          })();
    return c.id;
  };
  let seq = 0;
  const record = (userId: string, o: Partial<UsageAttempt>, report: Parameters<UsageStore["record"]>[1]) =>
    app.usageStore!.record(
      {
        userId,
        conversationId: null,
        runId: `run-${++seq}`,
        attempt: 1,
        runtime: "claude-code",
        model: "claude-opus-5-5",
        connectionId: null,
        purpose: "chat",
        ...o,
      },
      report,
    );
  const savePrices = async (prices: ModelPrice[]) => {
    const r = await put(f.cookies.admin, "/api/admin/usage/prices", { prices });
    expect(r.statusCode).toBe(200);
  };
  const report = async () => {
    const r = await get(f.cookies.admin, "/api/admin/usage");
    expect(r.statusCode).toBe(200);
    return AdminUsageReport.parse(r.json());
  };
  const inbox = (userId: string) =>
    db
      .select()
      .from(notifications)
      .all()
      .filter((n) => n.userId === userId && n.kind === "daily_cost");
  const log = () =>
    lines
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  if (o.threshold !== undefined) {
    const r = await put(f.cookies.admin, "/api/admin/usage/settings", { dailyCostThresholdUsd: o.threshold });
    expect(r.statusCode).toBe(200);
  }
  return { app, db, f, fake, clock, get, put, headers, conn, record, savePrices, report, inbox, log };
}

/** Loads the AC-12 fixture: dad = admin, wife = owner, son = stranger (the son's account). */
async function withFixture(t: Awaited<ReturnType<typeof start>>) {
  await t.savePrices(FIXTURE_PRICES);
  const who = { dad: t.f.users.admin.id, wife: t.f.users.owner.id, son: t.f.users.stranger.id };
  const conns: Record<string, string> = {
    "shared-anthropic-key": t.conn(null, "api_key"),
    "shared-openai-key": t.conn(null, "api_key", "codex"),
    "son-chatgpt": t.conn(who.son, "subscription", "codex"),
  };
  for (const r of FIXTURE.records)
    t.record(
      who[r.user],
      { runtime: r.runtime, model: r.model, connectionId: conns[r.connection]! },
      reportOf(r),
    );
  return who;
}

describe("admin usage report (#32, FR-9.3·9.5, AC-12)", () => {
  it("AC-12: per-record costs, totals and per-user costs match the fixture; subscription = tokens only", async () => {
    const t = await start();
    const who = await withFixture(t);
    const rep = await t.report();
    const e = FIXTURE.expected;
    expect(rep.total.costUsd).toBeCloseTo(e.totalCostUsd, 9);
    expect(rep.total.costMissing).toBe(0);
    expect(rep.total.requests).toBe(4);
    expect(rep.total).toMatchObject({ apiKeyRequests: 3, subscriptionRequests: 1 });
    const user = (id: string) => rep.byUser.find((g) => g.key === id)!;
    expect(user(who.dad).costUsd).toBeCloseTo(e.byUserCostUsd.dad!, 9);
    expect(user(who.wife).costUsd).toBeCloseTo(e.byUserCostUsd.wife!, 9);
    expect(user(who.son).costUsd).toBe(0);
    expect(user(who.son)).toMatchObject({
      totalTokens: e.subscriptionTokensByUser.son,
      subscriptionRequests: 1,
    });
    // Per record (newest first in `recent`): the subscription one has no cost.
    const costs = [...rep.recent].reverse().map((r) => r.costUsd);
    costs.forEach((c, i) => {
      const want = e.costUsdByRecord[i]!;
      if (want === null) expect(c).toBeNull();
      else expect(c).toBeCloseTo(want, 9);
    });
    expect(rep.recent.every((r) => r.authType !== "api_key" || r.priceVersion === 1)).toBe(true);
    expect(rep.priceVersion).toBe(1);
  });

  it("every breakdown (user, runtime, model, connection, purpose) adds up to the same total", async () => {
    const t = await start();
    await withFixture(t);
    // More rows: other purposes, a row without a price (미제공), one without a connection, unreported tokens.
    const key = t.conn(t.f.users.owner.id, "api_key");
    t.record(
      t.f.users.owner.id,
      { purpose: "connection_test", connectionId: key },
      { inputTokens: 50, outputTokens: 5 },
    );
    t.record(
      t.f.users.owner.id,
      { purpose: "title", connectionId: key, model: "unlisted" },
      { inputTokens: 9, outputTokens: 1 },
    );
    t.record(t.f.users.admin.id, { purpose: "schedule" }, { inputTokens: 7, outputTokens: 7 });
    t.record(t.f.users.shared.id, { purpose: "summary", connectionId: key }, { outputTokens: 3 });
    const rep = await t.report();
    expect(rep.total.requests).toBe(8);
    expect(rep.total.costMissing).toBe(2);
    const breakdowns = [rep.byUser, rep.byRuntime, rep.byModel, rep.byConnection, rep.byPurpose];
    for (const groups of breakdowns) {
      expect(sumOf(groups, "costUsd")).toBeCloseTo(rep.total.costUsd, 9);
      expect(sumOf(groups, "requests")).toBe(rep.total.requests);
      expect(sumOf(groups, "totalTokens")).toBe(rep.total.totalTokens);
      expect(sumOf(groups, "costMissing")).toBe(rep.total.costMissing);
    }
    expect(rep.byPurpose.map((g) => g.label).sort()).toEqual(
      ["대화", "연결 테스트", "예약", "요약", "제목"].sort(),
    );
    expect(rep.byConnection.find((g) => g.key === "none")?.label).toBe("연결 없음");
    expect(rep.byRuntime.map((g) => g.label).sort()).toEqual(["Claude Code", "Codex"]);
  });

  it("this month only (service zone), today's cost and forecast = total + daily average × days remaining", async () => {
    const t = await start();
    await t.savePrices([
      {
        runtime: "claude-code",
        model: "claude-opus-5-5",
        input: 10,
        output: 0,
        cacheRead: null,
        cacheWrite: null,
      },
    ]);
    const key = t.conn(null, "api_key");
    const at = (ms: number, usd: number) => {
      t.clock.t = ms;
      t.record(t.f.users.owner.id, { connectionId: key }, { inputTokens: usd * 100_000, outputTokens: 0 });
    };
    at(Date.UTC(2026, 9, 31, 14, 59), 100); // 2026-10-31 23:59 KST: last month
    at(Date.UTC(2026, 9, 31, 15, 0), 3); // 2026-11-01 00:00 KST
    at(Date.UTC(2026, 10, 5), 4);
    at(Date.UTC(2026, 10, 10, 14, 59), 2); // 2026-11-10 23:59 KST: yesterday
    at(Date.UTC(2026, 10, 10, 15, 0), 1); // 2026-11-11 00:00 KST: today
    at(Date.UTC(2026, 10, 30, 15, 0), 50); // December in Seoul
    t.clock.t = NOV_11_NOON_KST;
    const rep = await t.report();
    expect(rep).toMatchObject({
      month: "2026-11",
      timeZone: "Asia/Seoul",
      daysInMonth: 30,
      daysElapsed: 11,
      daysRemaining: 19,
    });
    expect(rep.total.costUsd).toBeCloseTo(10, 9);
    expect(rep.today.costUsd).toBeCloseTo(1, 9);
    expect(rep.forecastCostUsd).toBeCloseTo(10 + (10 / 11) * 19, 6); // rounded to a micro-USD
  });

  it("prices: each save is a new version; the history lists them; bad tables are refused", async () => {
    const t = await start();
    const empty = PriceTableResponse.parse(
      (await t.get(t.f.cookies.admin, "/api/admin/usage/prices")).json(),
    );
    expect(empty).toEqual({ current: null, versions: [] });
    await t.savePrices(FIXTURE_PRICES);
    await t.savePrices([FIXTURE_PRICES[0]!]);
    const now = PriceTableResponse.parse((await t.get(t.f.cookies.admin, "/api/admin/usage/prices")).json());
    expect(now.current?.version).toBe(2);
    expect(now.versions.map((v) => [v.version, v.models])).toEqual([
      [2, 1],
      [1, 2],
    ]);
    const bad = [
      { prices: [{ ...FIXTURE_PRICES[0]!, input: -1 }] },
      { prices: [FIXTURE_PRICES[0]!, FIXTURE_PRICES[0]!] },
      { prices: [{ ...FIXTURE_PRICES[0]!, model: "" }] },
      { prices: "x" },
    ];
    for (const body of bad)
      expect((await t.put(t.f.cookies.admin, "/api/admin/usage/prices", body)).statusCode).toBe(400);
    expect(t.log().some((l) => l.msg === "usage.prices_saved" && l.count === 1)).toBe(true);
  });
});

describe("who sees what (#32)", () => {
  it("a user sees only their own usage this month; the son and other members get 403 on admin data", async () => {
    const t = await start();
    const who = await withFixture(t);
    const mine = async (cookie: string) => {
      const r = await t.get(cookie, "/api/usage/me");
      expect(r.statusCode).toBe(200);
      return MyUsage.parse(r.json());
    };
    const wife = await mine(t.f.cookies.owner);
    expect(wife.total.costUsd).toBeCloseTo(FIXTURE.expected.byUserCostUsd.wife!, 9);
    expect(wife.total.requests).toBe(2);
    const son = await mine(t.f.cookies.stranger);
    expect(son.total).toMatchObject({
      costUsd: 0,
      requests: 1,
      totalTokens: 430_000,
      subscriptionRequests: 1,
    });
    const nobody = await mine(t.f.cookies.shared);
    expect(nobody.total.requests).toBe(0);
    // A user id in the query changes nothing: always the caller's own.
    const tricked = await t.get(t.f.cookies.stranger, `/api/usage/me?userId=${who.wife}`);
    expect(MyUsage.parse(tricked.json()).total.requests).toBe(1);
    expect((await t.get("", "/api/usage/me")).statusCode).toBe(401);

    for (const url of ["/api/admin/usage", "/api/admin/usage/prices", "/api/admin/usage/settings"])
      for (const cookie of [t.f.cookies.stranger, t.f.cookies.owner, t.f.cookies.shared])
        expect((await t.get(cookie, url)).statusCode).toBe(403);
    for (const [url, body] of [
      ["/api/admin/usage/prices", { prices: [] }],
      ["/api/admin/usage/settings", { dailyCostThresholdUsd: 1 }],
    ] as const)
      expect((await t.put(t.f.cookies.stranger, url, body)).statusCode).toBe(403);
    // Nothing changed by the refused writes.
    expect(
      PriceTableResponse.parse((await t.get(t.f.cookies.admin, "/api/admin/usage/prices")).json()).current
        ?.version,
    ).toBe(1);
    expect((await t.get(t.f.cookies.admin, "/api/admin/usage/settings")).json()).toEqual({
      dailyCostThresholdUsd: null,
    });
  });
});

describe("daily cost notification (#32, FR-9.5)", () => {
  async function costly(threshold?: number) {
    const t = await start(threshold === undefined ? {} : { threshold });
    await t.savePrices([
      {
        runtime: "claude-code",
        model: "claude-opus-5-5",
        input: 10,
        output: 0,
        cacheRead: null,
        cacheWrite: null,
      },
    ]);
    const key = t.conn(null, "api_key");
    /** One API key row costing `usd`. */
    const spend = (usd: number, userId = t.f.users.owner.id) =>
      t.record(userId, { connectionId: key }, { inputTokens: Math.round(usd * 100_000), outputTokens: 0 });
    return { ...t, spend };
  }

  it("above the threshold → one notification per admin, once that day; the next day can notify again", async () => {
    const t = await costly(1);
    t.spend(0.6);
    expect(t.inbox(t.f.users.admin.id)).toHaveLength(0);
    t.spend(0.6); // today: 1.2 > 1
    const sent = t.inbox(t.f.users.admin.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toBe("오늘 $1.20 · 기준 $1.00 (막지는 않아요)");
    for (let i = 0; i < 5; i++) t.spend(1);
    expect(t.inbox(t.f.users.admin.id)).toHaveLength(1);
    // Members never get it.
    for (const m of [t.f.users.owner.id, t.f.users.stranger.id, t.f.users.shared.id])
      expect(t.inbox(m)).toHaveLength(0);
    expect(t.log().filter((l) => l.msg === "usage.daily_cost_alert")).toHaveLength(1);

    t.clock.t += DAY; // tomorrow starts at 0
    t.spend(0.9);
    expect(t.inbox(t.f.users.admin.id)).toHaveLength(1);
    t.spend(0.2);
    expect(t.inbox(t.f.users.admin.id)).toHaveLength(2);
    t.spend(5);
    expect(t.inbox(t.f.users.admin.id)).toHaveLength(2);
  });

  it("exactly at the threshold, no threshold, or subscription-only usage → no notification", async () => {
    const t = await costly(1);
    t.spend(1);
    expect(t.inbox(t.f.users.admin.id)).toHaveLength(0);
    const sub = t.conn(t.f.users.owner.id, "subscription");
    for (let i = 0; i < 3; i++)
      t.record(t.f.users.owner.id, { connectionId: sub }, { inputTokens: 10_000_000, outputTokens: 0 });
    expect(t.inbox(t.f.users.admin.id)).toHaveLength(0);

    const off = await costly();
    off.spend(1000);
    expect(off.inbox(off.f.users.admin.id)).toHaveLength(0);
    // Turning it off again after setting it.
    const r = await off.put(off.f.cookies.admin, "/api/admin/usage/settings", {
      dailyCostThresholdUsd: null,
    });
    expect(r.json()).toEqual({ dailyCostThresholdUsd: null });
    for (const bad of [
      { dailyCostThresholdUsd: 0 },
      { dailyCostThresholdUsd: -1 },
      { dailyCostThresholdUsd: "5" },
      {},
    ])
      expect((await off.put(off.f.cookies.admin, "/api/admin/usage/settings", bad)).statusCode).toBe(400);
  });

  it("the check claims the day before notifying: a direct service with a failing notifier still sends once", () => {
    const db = createTestDb();
    db.insert(users).values({ id: "u1", email: "u1@example.com", name: "u1", role: "member" }).run();
    db.insert(connections)
      .values({
        id: "key",
        runtime: "claude-code",
        authType: "api_key",
        scope: "personal",
        ownerId: "u1",
        label: "k",
        createdAt: 0,
        updatedAt: 0,
      })
      .run();
    const kv = new Map<string, string>([["usage.daily_cost_threshold_usd", "1"]]);
    let calls = 0;
    const service = new UsageService(
      db,
      { get: (k) => kv.get(k), set: (k, v) => void kv.set(k, v) },
      () => {
        calls++;
        throw new Error("push down");
      },
      undefined,
      { timeZone: "UTC", now: () => NOV_11_NOON_KST },
    );
    const prices = new PriceStore(db, () => NOV_11_NOON_KST);
    prices.save(
      [{ runtime: "claude-code", model: "m", input: 10, output: 0, cacheRead: null, cacheWrite: null }],
      "a",
    );
    const store = new UsageStore(db, () => NOV_11_NOON_KST, {
      prices,
      onRecorded: (at) => service.checkDailyCost(at),
    });
    for (let i = 0; i < 4; i++)
      expect(() =>
        store.record(
          {
            userId: "u1",
            conversationId: null,
            runId: `r${i}`,
            attempt: 1,
            runtime: "claude-code",
            model: "m",
            connectionId: "key",
            purpose: "chat",
          },
          { inputTokens: 100_000, outputTokens: 0 },
        ),
      ).not.toThrow();
    expect(calls).toBe(1);
    expect(kv.get("usage.daily_cost_alerted_day")).toBe("2026-11-11");
  });
});

describe("no budget in v1: usage never blocks a run (#32 완료 기준, FR-9.1)", () => {
  it("far over the daily threshold, runs on an API key connection still start and finish; usage is recorded", async () => {
    const t = await costly();
    async function costly() {
      const s = await start({ threshold: 0.0001 });
      await s.savePrices([
        {
          runtime: "claude-code",
          model: "fake-large",
          input: 1000,
          output: 1000,
          cacheRead: 1000,
          cacheWrite: 1000,
        },
      ]);
      const key = s.conn(s.f.users.owner.id, "api_key");
      s.app.connections!.store.setTestResult(key, "passed", "ok", 1);
      return { ...s, key };
    }
    const c = t.app.conversations!.create(t.f.users.owner.id);
    const runs: Run[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await t.app.inject({
        method: "POST",
        url: `/api/conversations/${c.id}/messages`,
        headers: t.headers(t.f.cookies.owner, true),
        payload: { text: `질문 ${i}` },
      });
      expect(r.statusCode).toBe(201);
      const run = r.json<{ run: Run }>().run;
      for (let k = 0; k < 400 && t.app.runs!.get(run.id)!.endedAt === null; k++)
        await new Promise((res) => setTimeout(res, 5));
      expect(t.app.runs!.get(run.id)!.status).toBe("done");
      runs.push(run);
    }
    const rows = t.db.select().from(usageRecords).all();
    expect(rows).toHaveLength(3);
    expect(
      rows.every(
        (r) => r.authType === "api_key" && r.connectionId === t.key && (r.pricedCostMicros ?? 0) > 0,
      ),
    ).toBe(true);
    expect(t.inbox(t.f.users.admin.id)).toHaveLength(1); // told, once — never stopped
  });

  it("a broken price table or notifier does not fail the run (logged with a fixed code only)", async () => {
    const t = await start({ threshold: 0.0001 });
    await t.savePrices([
      {
        runtime: "claude-code",
        model: "fake-large",
        input: 1000,
        output: 1000,
        cacheRead: 1000,
        cacheWrite: 1000,
      },
    ]);
    const key = t.conn(t.f.users.owner.id, "api_key");
    t.app.connections!.store.setTestResult(key, "passed", "ok", 1);
    // The price lookup fails (e.g. a corrupt table) and so does publishing.
    t.app.usageStore!.prices.priceIn = () => {
      throw new Error("SECRET-broken-table");
    };
    t.app.notifications!.publish = () => {
      throw new Error("SECRET-push");
    };
    const c = t.app.conversations!.create(t.f.users.owner.id);
    const r = await t.app.inject({
      method: "POST",
      url: `/api/conversations/${c.id}/messages`,
      headers: t.headers(t.f.cookies.owner, true),
      payload: { text: "질문" },
    });
    expect(r.statusCode).toBe(201);
    const run = r.json<{ run: Run }>().run;
    for (let k = 0; k < 400 && t.app.runs!.get(run.id)!.endedAt === null; k++)
      await new Promise((res) => setTimeout(res, 5));
    expect(t.app.runs!.get(run.id)!.status).toBe("done");
    expect(t.log().some((l) => l.msg === "usage.record_failed")).toBe(true);
    expect(JSON.stringify(t.log())).not.toContain("SECRET");
    // With the price table working again, a failing notifier is logged and the run still finishes.
    delete (t.app.usageStore!.prices as { priceIn?: unknown }).priceIn;
    const r2 = await t.app.inject({
      method: "POST",
      url: `/api/conversations/${c.id}/messages`,
      headers: t.headers(t.f.cookies.owner, true),
      payload: { text: "질문 2" },
    });
    const run2 = r2.json<{ run: Run }>().run;
    for (let k = 0; k < 400 && t.app.runs!.get(run2.id)!.endedAt === null; k++)
      await new Promise((res) => setTimeout(res, 5));
    expect(t.app.runs!.get(run2.id)!.status).toBe("done");
    expect(t.log().some((l) => l.msg === "usage.alert_failed")).toBe(true);
    expect(JSON.stringify(t.log())).not.toContain("SECRET");
  });

  it("the run path has no usage or budget check: nothing under usage/ is imported by the run manager or access checks", () => {
    const src = path.resolve(here, "../src");
    for (const file of ["runtime/runs.ts", "connections/access.ts", "conversations/routes.ts"]) {
      const text = fs.readFileSync(path.join(src, file), "utf8");
      // Type-only imports of the record contract are fine; no value import of the usage service or prices.
      expect(text).not.toMatch(/from "\.\.\/usage\/(service|prices|routes)\.js"/);
    }
  });
});
