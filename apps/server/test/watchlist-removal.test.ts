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

/**
 * 관심 종목 removed (#187, user decision 2026-11-18): migration 0033 drops `watchlist_items` (0023) and its index —
 * a database that still has rows (production had none) loses only them; the user and everything else stay. No
 * `/api/watchlist*` route is left: the catch-all JSON 404 answers them.
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

describe("migration 0033 (관심 종목 제거)", () => {
  it("drops watchlist_items and its index, keeping the users whose rows they were", () => {
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
    expect(objects(sql)).toEqual(["watchlist_items", "watchlist_items_user_symbol_idx"]);
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    expect(objects(sql)).toEqual([]);
    expect(sql.prepare("select id from users").all()).toEqual([{ id: "u1" }]);
    expect(sql.prepare("pragma foreign_key_check").all()).toEqual([]);
    // Deleting the user afterwards is not held up by a table that is gone.
    sql.prepare("delete from users where id = 'u1'").run();
  });

  it("the 0033 file is the drop and nothing else", () => {
    const text = fs.readFileSync(path.join(MIGRATIONS_DIR, "0033_drop_watchlist.sql"), "utf8").trim();
    expect(text).toBe("DROP TABLE `watchlist_items`;");
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
