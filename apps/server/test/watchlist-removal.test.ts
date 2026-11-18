import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { CSRF_HEADER } from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb, MIGRATIONS_DIR, openDb } from "../src/db/client.js";
import { RuntimeRegistry } from "../src/runtime/adapter.js";
import { knownSecrets } from "../src/secrets/known.js";

/**
 * 관심 종목 removed (#187, user decision 2026-11-18) — two-phase, like `finance_results` in #190: this release takes
 * every code path away (screen, `/api/watchlist*`, `watchlist_get`, the search) but **keeps the `watchlist_items`
 * table**, so a rollback to pre-#187 code (by hand or the release script's automatic rollback) still finds the table
 * it lists and rescrubs. A later release drops it (docs/ops.md §30.3). Until then a row left from before is only
 * rescrubbed in place; nothing reads or writes it.
 */

const closers: (() => unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

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

const objects = (sql: ReturnType<typeof openDb>["$client"]) =>
  (
    sql.prepare("select name from sqlite_master where name like 'watchlist%' order by name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);

describe("watchlist_items is retained for rollback (#187)", () => {
  it("every migration applies cleanly and none drops the table or its index", () => {
    const db = openDb(":memory:");
    closers.push(() => db.$client.close());
    migrate(db, { migrationsFolder: migrationsUpTo(32) });
    const sql = db.$client;
    sql.prepare("insert into users (id, email, name, role) values ('u1', 'u1@x.test', 'u1', 'member')").run();
    sql
      .prepare(
        "insert into watchlist_items (id, user_id, market, symbol, name) values ('w1', 'u1', 'KR', '005930', ?)",
      )
      .run("삼성전자");
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    expect(objects(sql)).toEqual(["watchlist_items", "watchlist_items_user_symbol_idx"]);
    // A row of a pre-#187 release is still there for that release after a rollback.
    expect(sql.prepare("select id, symbol, name from watchlist_items").all()).toEqual([
      { id: "w1", symbol: "005930", name: "삼성전자" },
    ]);
    for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql")))
      expect(fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"), f).not.toMatch(
        /drop\s+(table|index)[^;]*watchlist/i,
      );
  });

  it("no server code path touches it — only its schema definition and its rescrub rule name it", () => {
    const src = path.resolve(MIGRATIONS_DIR, "../src");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && /watchlist/i.test(fs.readFileSync(p, "utf8")))
          hits.push(path.relative(src, p));
      }
    };
    walk(src);
    expect(hits.sort()).toEqual(["db/schema.ts", "secrets/columns.ts"]);
  });

  it("a row left from before is rescrubbed in place when a secret is registered later", async () => {
    const db = createTestDb();
    const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
      db,
      logger: false,
      runtimes: new RuntimeRegistry(),
    });
    closers.push(() => app.close());
    const late = `LATE${crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
    db.$client
      .prepare("insert into users (id, email, name, role) values ('u1', 'u1@x.test', 'u1', 'member')")
      .run();
    db.$client
      .prepare(
        "insert into watchlist_items (id, user_id, market, symbol, name) values ('w1', 'u1', 'US', 'AAPL', ?)",
      )
      .run(`메모 ${late}`);
    knownSecrets.add(late);
    try {
      await app.storedRescrub!.idle();
      const row = db.$client.prepare("select name from watchlist_items").get() as { name: string };
      expect(row.name).not.toContain(late);
    } finally {
      knownSecrets.remove(late);
    }
  });
});

describe("no 관심 종목 API is left (#187)", () => {
  it("every old /api/watchlist path is the JSON 404 of an unknown API route", async () => {
    const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
      db: createTestDb(),
      logger: false,
      runtimes: new RuntimeRegistry(),
    });
    closers.push(() => app.close());
    for (const [method, url] of [
      ["GET", "/api/watchlist"],
      ["POST", "/api/watchlist"],
      ["GET", "/api/watchlist/search?q=AAPL"],
      ["GET", "/api/watchlist/x"],
      ["DELETE", "/api/watchlist/x"],
    ] as const) {
      const r = await app.inject({
        method,
        url,
        headers: { host: "localhost:3000", origin: "http://localhost:3000", [CSRF_HEADER]: "1" },
      });
      expect([r.statusCode, r.json()], `${method} ${url}`).toEqual([404, { error: "not_found" }]);
    }
  });
});
