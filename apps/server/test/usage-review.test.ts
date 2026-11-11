import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { AdminUsageReport, CSRF_HEADER, type ModelPrice } from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb, MIGRATIONS_DIR, openDb, runMigrations } from "../src/db/client.js";
import { notifications, usageRecords } from "../src/db/schema.js";
import { costOf, PriceStore } from "../src/usage/prices.js";
import { UsageService } from "../src/usage/service.js";
import { UsageStore, type UsageAttempt } from "../src/usage/store.js";
import { createFamily } from "./helpers/permission-matrix.js";

/** #32 review round 1: rows from before 0013, exact cost arithmetic, 미제공 carried everywhere. */

type App = Awaited<ReturnType<typeof buildApp>>;
const closers: (() => unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const NOV_11_NOON_KST = Date.UTC(2026, 10, 11, 3, 0, 0);
const PRICE: ModelPrice = {
  runtime: "claude-code",
  model: "m",
  input: "1",
  output: "2",
  cacheRead: null,
  cacheWrite: null,
};

/** $0.29 per million input tokens: 50 tokens cost exactly 14.5 micro-USD (a float product gives 14.499999…). */
const PRICE29: ModelPrice = { ...PRICE, model: "m29", input: "0.29", output: "0" };

async function start(threshold: number | null) {
  const db = createTestDb();
  const app: App = await buildApp(loadConfig({ NODE_ENV: "test" }), {
    db,
    logger: false,
    notifications: { sender: async () => {} },
    usage: { now: () => NOV_11_NOON_KST },
  });
  closers.push(() => app.close());
  const f = await createFamily(app);
  const put = (url: string, payload: object) =>
    app.inject({
      method: "PUT",
      url,
      headers: {
        host: "localhost:3000",
        cookie: f.cookies.admin,
        origin: "http://localhost:3000",
        [CSRF_HEADER]: "1",
        "content-type": "application/json",
      },
      payload,
    });
  expect((await put("/api/admin/usage/prices", { prices: [PRICE, PRICE29] })).statusCode).toBe(200);
  expect((await put("/api/admin/usage/settings", { dailyCostThresholdUsd: threshold })).statusCode).toBe(200);
  const key = app.connections!.store.create({
    runtime: "claude-code",
    authType: "api_key",
    scope: "shared",
    owner: null,
    createdBy: f.users.admin.id,
    secret: `sk-ant-reviewfake${"k".repeat(24)}`,
  }).id;
  let seq = 0;
  const record = (o: Partial<UsageAttempt>, report: Parameters<UsageStore["record"]>[1]) =>
    app.usageStore!.record(
      {
        userId: f.users.owner.id,
        conversationId: null,
        runId: `run-${++seq}`,
        attempt: 1,
        runtime: "claude-code",
        model: "m",
        connectionId: key,
        purpose: "chat",
        ...o,
      },
      report,
    );
  const alerts = () =>
    db
      .select()
      .from(notifications)
      .all()
      .filter((n) => n.kind === "daily_cost").length;
  const report = async () =>
    AdminUsageReport.parse(
      (
        await app.inject({
          url: "/api/admin/usage",
          headers: { host: "localhost:3000", cookie: f.cookies.admin },
        })
      ).json(),
    );
  return { app, db, f, record, alerts, report };
}

describe("exact cost arithmetic (integer micro-USD)", () => {
  it("100k input × $1 + 100k output × $2 is exactly $0.30 (300000 micro-USD, no float residue)", () => {
    const t = { inputTokens: 100_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(costOf(t, PRICE)).toBe(300_000);
    expect(0.1 * 1 + 0.1 * 2).not.toBe(0.3); // what a float sum would have stored
    // Fractional prices are rounded once, to the nearest micro-USD.
    expect(costOf({ ...t, outputTokens: 0 }, { ...PRICE, input: "0.3" })).toBe(30_000);
    // 7 × 0.1 is 0.7000000000000001 in floats and 1001 × 1.1 is 1101.1000000000001: always a whole micro-USD.
    expect(costOf({ ...t, inputTokens: 7, outputTokens: 0 }, { ...PRICE, input: "0.1" })).toBe(1);
    expect(costOf({ ...t, inputTokens: 1001, outputTokens: 0 }, { ...PRICE, input: "1.1" })).toBe(1101);
  });

  it.each([
    [0.3, 0], // equal: not above
    [0.300001, 0], // just above the cost
    [0.299999, 1], // just below the cost
  ])("a cost of exactly $0.30 with threshold $%s → %s notification(s)", async (threshold, want) => {
    const t = await start(threshold);
    t.record({}, { inputTokens: 100_000, outputTokens: 100_000 });
    expect(t.alerts()).toBe(want);
  });

  it("threshold $0.30: one more micro-USD above it notifies", async () => {
    const t = await start(0.3);
    t.record({}, { inputTokens: 100_000, outputTokens: 100_000 });
    expect(t.alerts()).toBe(0);
    t.record({}, { inputTokens: 1, outputTokens: 0 }); // 1 token × $1 / 1M = 1 micro-USD
    expect(t.alerts()).toBe(1);
    const rep = await t.report();
    expect(rep.total.costMicroUsd).toBe(300_001);
    expect(rep.today.costMicroUsd).toBe(300_001);
  });

  it("sums are exact: ten $0.10 rows are $1.00 to the micro", async () => {
    const t = await start(null);
    for (let i = 0; i < 10; i++) t.record({}, { inputTokens: 100_000, outputTokens: 0 });
    const rep = await t.report();
    expect(rep.total.costMicroUsd).toBe(1_000_000);
    expect(rep.total.costUsd).toBe(1);
  });
});

describe("exact decimal prices (review round 2): no float anywhere between the price and the micro-USD", () => {
  const none = { cacheReadTokens: 0, cacheWriteTokens: 0 };
  const at = (inputTokens: number, input: string) =>
    costOf({ inputTokens, outputTokens: 0, ...none }, { ...PRICE, input, output: null });

  it("50 tokens × $0.29/M = 14.5 micro-USD → 15 (half up), though 50 × 0.29 is 14.499999999999998 in floats", () => {
    expect(50 * 0.29).toBeLessThan(14.5);
    expect(at(50, "0.29")).toBe(15);
  });

  it.each([
    [1, "0.5", 1], // exactly half → up
    [1, "0.499999", 0], // just below half → down
    [3, "0.166667", 1], // 0.500001 → up
    [3, "0.166666", 0], // 0.499998 → down
    [2, "0.75", 2], // 1.5 → 2
    [1_000_000_000, "0.000001", 1000], // smallest price step, large token count
    [7, "0.1", 1], // 0.7 → 1
    [1001, "1.1", 1101], // 1101.1 → 1101
    [100_000, "9999.999999", 1_000_000_000], // 999999999.9 → 1000000000
  ])("%s tokens × $%s/M → %s micro-USD", (tokens, price, want) => expect(at(tokens, price)).toBe(want));

  it("a price that is not an accepted decimal is not costed (미제공), never guessed", () => {
    expect(at(10, "1e3")).toBeNull();
    expect(at(10, "0.0000001")).toBeNull();
    expect(at(10, "-1")).toBeNull();
  });

  it("667 rows of 50 tokens × $0.29/M = $0.010005 → the $0.01 alert fires at the 667th row, not before", async () => {
    const t = await start(0.01);
    for (let i = 0; i < 666; i++) t.record({ model: "m29" }, { inputTokens: 50, outputTokens: 0 });
    expect(t.alerts()).toBe(0); // 666 × 15 = 9990 micro-USD
    t.record({ model: "m29" }, { inputTokens: 50, outputTokens: 0 });
    expect(t.alerts()).toBe(1); // 10005 > 10000
    expect((await t.report()).today.costMicroUsd).toBe(10_005);
  });

  it("1000 such rows sum to exactly $0.015", async () => {
    const t = await start(null);
    for (let i = 0; i < 1000; i++) t.record({ model: "m29" }, { inputTokens: 50, outputTokens: 0 });
    const rep = await t.report();
    expect(rep.total.costMicroUsd).toBe(15_000);
    expect(rep.total.costUsd).toBe(0.015);
  });

  it("the admin API takes prices as decimal strings with at most 6 decimals, and thresholds with at most 6", async () => {
    const t = await start(null);
    const put = (url: string, payload: object) =>
      t.app.inject({
        method: "PUT",
        url,
        headers: {
          host: "localhost:3000",
          cookie: t.f.cookies.admin,
          origin: "http://localhost:3000",
          [CSRF_HEADER]: "1",
          "content-type": "application/json",
        },
        payload,
      });
    for (const input of [0.29, "0.2900001", "1e3", "-1", " 1", "01", "10000.000001", "1.", ".5"])
      expect((await put("/api/admin/usage/prices", { prices: [{ ...PRICE, input }] })).statusCode).toBe(400);
    for (const input of ["0", "0.29", "10000", "1.234567"])
      expect((await put("/api/admin/usage/prices", { prices: [{ ...PRICE, input }] })).statusCode).toBe(200);
    for (const v of [0.0000001, 1.0000001])
      expect((await put("/api/admin/usage/settings", { dailyCostThresholdUsd: v })).statusCode).toBe(400);
    expect((await put("/api/admin/usage/settings", { dailyCostThresholdUsd: 0.000001 })).statusCode).toBe(
      200,
    );
  });
});

describe("미제공 is carried to today, the forecast and tokens", () => {
  it("only unpriced API key rows: today and the total say how many have no cost, not $0", async () => {
    const t = await start(null);
    t.record({ model: "unlisted" }, { inputTokens: 1000, outputTokens: 10 });
    const rep = await t.report();
    expect(rep.total).toMatchObject({ apiKeyRequests: 1, costMissing: 1, costMicroUsd: 0 });
    expect(rep.today).toMatchObject({ apiKeyRequests: 1, costMissing: 1, costMicroUsd: 0 });
    expect(rep.forecastCostUsd).toBe(0); // over the costed rows only; the screen shows 미제공 from `total`
  });

  it("a record with no reported tokens keeps NULL tokens (미제공), and totals count it as missing", async () => {
    const t = await start(null);
    t.record({}, {});
    t.record({}, { inputTokens: 10, outputTokens: 5 });
    const rep = await t.report();
    const none = rep.recent.find((r) => r.totalTokens === null)!;
    expect(none).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null });
    expect(rep.total).toMatchObject({ totalTokens: 15, tokensMissing: 1, costMissing: 1 });
    for (const g of [rep.byUser, rep.byRuntime, rep.byModel, rep.byConnection, rep.byPurpose])
      expect(g.reduce((n, x) => n + x.tokensMissing, 0)).toBe(1);
  });
});

describe("upgrading a 0012 database (migration 0013 backfill)", () => {
  /** A migrations folder with only the migrations up to `last`. */
  function migrationsUpTo(last: number) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-mig-"));
    closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8")) as {
      entries: { idx: number; tag: string }[];
    };
    journal.entries = journal.entries.filter((e) => e.idx <= last);
    fs.mkdirSync(path.join(dir, "meta"));
    fs.writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify(journal));
    for (const e of journal.entries)
      fs.copyFileSync(path.join(MIGRATIONS_DIR, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
    return dir;
  }

  it("old rows take their connection's auth type; a missing connection is 'unknown'; no current price is applied", () => {
    const db = openDb(":memory:");
    closers.push(() => db.$client.close());
    migrate(db, { migrationsFolder: migrationsUpTo(12) });
    const sql = db.$client;
    expect(
      sql.prepare("select count(*) n from pragma_table_info('usage_records') where name = 'auth_type'").get(),
    ).toEqual({ n: 0 });
    sql
      .prepare("insert into users (id, email, name, role) values ('u1', 'u1@example.com', 'u1', 'member')")
      .run();
    const conn = sql.prepare(
      "insert into connections (id, runtime, auth_type, scope, owner_id, label, created_at, updated_at) values (?, ?, ?, 'personal', 'u1', ?, 0, 0)",
    );
    conn.run("key", "claude-code", "api_key", "키");
    conn.run("sub", "codex", "subscription", "구독");
    // A disconnected connection keeps its row, and so its auth type.
    conn.run("old-key", "claude-code", "api_key", "옛 키");
    sql.prepare("update connections set secret = null, disconnected_at = 1 where id = 'old-key'").run();
    const row = sql.prepare(
      `insert into usage_records (user_id, conversation_id, run_id, attempt, runtime, model, connection_id, purpose,
         input_tokens, output_tokens, cost_usd, request_count, created_at, updated_at)
       values ('u1', null, ?, 1, ?, 'm', ?, 'chat', ?, ?, ?, 1, ?, ?)`,
    );
    row.run("r-key", "claude-code", "key", 100_000, 100_000, 0.3, NOV_11_NOON_KST, NOV_11_NOON_KST);
    row.run("r-old", "claude-code", "old-key", 1000, 10, null, NOV_11_NOON_KST, NOV_11_NOON_KST);
    row.run("r-sub", "codex", "sub", 400_000, 30_000, null, NOV_11_NOON_KST, NOV_11_NOON_KST);
    row.run("r-orphan", "claude-code", "deleted-conn", 500, 5, 0.01, NOV_11_NOON_KST, NOV_11_NOON_KST);
    row.run("r-none", "claude-code", null, 10, 1, null, NOV_11_NOON_KST, NOV_11_NOON_KST);

    runMigrations(db); // applies 0013
    const by = Object.fromEntries(
      db
        .select()
        .from(usageRecords)
        .all()
        .map((r) => [r.runId, r]),
    );
    expect(by["r-key"]).toMatchObject({ authType: "api_key", priceVersion: null, pricedCostMicros: null });
    expect(by["r-old"]).toMatchObject({ authType: "api_key", priceVersion: null, pricedCostMicros: null });
    expect(by["r-sub"]).toMatchObject({
      authType: "subscription",
      priceVersion: null,
      pricedCostMicros: null,
    });
    expect(by["r-orphan"]).toMatchObject({ authType: "unknown", priceVersion: null, pricedCostMicros: null });
    expect(by["r-none"]).toMatchObject({ authType: null, priceVersion: null, pricedCostMicros: null });

    // A price table saved after the upgrade is not applied to the old rows — not even when one reports again.
    const prices = new PriceStore(db, () => NOV_11_NOON_KST);
    prices.save([PRICE], "admin");
    const store = new UsageStore(db, () => NOV_11_NOON_KST, { prices });
    store.record(
      {
        userId: "u1",
        conversationId: null,
        runId: "r-key",
        attempt: 1,
        runtime: "claude-code",
        model: "m",
        connectionId: "key",
        purpose: "chat",
      },
      { inputTokens: 100_000, outputTokens: 100_000 },
    );
    expect(store.forRun("r-key")[0]).toMatchObject({
      authType: "api_key",
      priceVersion: null,
      pricedCostMicros: null,
    });

    const kv = new Map<string, string>();
    const service = new UsageService(
      db,
      { get: (k) => kv.get(k), set: (k, v) => void kv.set(k, v) },
      () => {},
      undefined,
      {
        timeZone: "Asia/Seoul",
        now: () => NOV_11_NOON_KST,
      },
    );
    const rep = service.admin(prices.currentVersion());
    // Nothing dropped: all five rows counted; the API key and unknown ones are 미제공, not $0 and not missing.
    expect(rep.total).toMatchObject({
      requests: 5,
      apiKeyRequests: 2,
      subscriptionRequests: 1,
      unknownRequests: 1,
      costMissing: 3,
      costMicroUsd: 0,
    });
    for (const groups of [rep.byUser, rep.byRuntime, rep.byModel, rep.byConnection, rep.byPurpose]) {
      expect(groups.reduce((n, g) => n + g.requests, 0)).toBe(5);
      expect(groups.reduce((n, g) => n + g.costMissing, 0)).toBe(3);
      expect(groups.reduce((n, g) => n + g.unknownRequests, 0)).toBe(1);
    }
    expect(rep.byConnection.find((g) => g.key === "deleted-conn")).toMatchObject({
      label: "삭제된 연결",
      costMissing: 1,
    });
    expect(rep.recent.find((r) => r.authType === "unknown")).toMatchObject({ costUsd: null });
  });
});
