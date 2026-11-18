import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, openDb } from "../src/db/client.js";

/**
 * Migration 0031 (#146): `memory_proposals` is rebuilt (a 기억 정리 bundle has no conversation). The rebuild runs with
 * foreign keys on (the migrator's transaction ignores `PRAGMA foreign_keys`), so it must never drop the parent table
 * while a child refers to it — the conversation tool's cards of before stay whole. Existing user messages get their
 * processing sequence in order, and new ones from the trigger.
 */

const closers: (() => unknown)[] = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
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

describe("migration 0031 (기억 정리)", () => {
  it("keeps every card and decision of before, numbers existing user messages, and numbers new ones", () => {
    const db = openDb(":memory:");
    closers.push(() => db.$client.close());
    migrate(db, { migrationsFolder: migrationsUpTo(30) });
    const sql = db.$client;
    sql.prepare("insert into users (id, email, name, role) values ('u1', 'u1@x.test', 'u1', 'member')").run();
    sql.prepare("insert into conversations (id, owner_id, title) values ('c1', 'u1', 't')").run();
    sql.prepare("insert into conversations (id, owner_id, title) values ('c2', 'u1', 't')").run();
    const msg = (id: string, c: string, seq: number, role: string, at: number) =>
      sql
        .prepare(
          "insert into messages (id, conversation_id, seq, role, parts, revision, created_at) values (?, ?, ?, ?, '[]', 1, ?)",
        )
        .run(id, c, seq, role, at);
    msg("m1", "c1", 1, "user", 10);
    msg("m2", "c1", 2, "assistant", 11);
    msg("m3", "c2", 1, "user", 10);
    msg("m4", "c1", 3, "user", 20);
    sql
      .prepare(
        `insert into memory_proposals (id, owner_id, conversation_id, run_id, mode, forced, base, applied, created_at, updated_at)
         values ('p1', 'u1', 'c1', 'r1', 'review', null, '{"memory":0}', '{}', 1, 1)`,
      )
      .run();
    sql
      .prepare(
        `insert into memory_proposal_decisions (proposal_id, idx, doc, action, item_id, text, before, sources, status, updated_at)
         values ('p1', 0, 'memory', 'add', null, '블랙커피', null, '[]', 'pending', 1)`,
      )
      .run();
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    expect(sql.prepare("select id, origin, conversation_id from memory_proposals").all()).toEqual([
      { id: "p1", origin: "tool", conversation_id: "c1" },
    ]);
    expect(sql.prepare("select proposal_id, text, merge_ids from memory_proposal_decisions").all()).toEqual([
      { proposal_id: "p1", text: "블랙커피", merge_ids: null },
    ]);
    // The decisions still go with their bundle (the foreign key was carried over to the rebuilt table).
    expect(sql.prepare("pragma foreign_key_check").all()).toEqual([]);
    sql.prepare("delete from memory_proposals where id = 'p1'").run();
    expect(sql.prepare("select count(*) as n from memory_proposal_decisions").get()).toEqual({ n: 0 });
    // Existing user messages numbered by time (then conversation, then position); assistant ones not at all.
    expect(sql.prepare("select message_id, seq from memory_message_seq order by seq").all()).toEqual([
      { message_id: "m1", seq: 1 },
      { message_id: "m3", seq: 2 },
      { message_id: "m4", seq: 3 },
    ]);
    // A new one continues the counter — never reusing a number, even after a deletion.
    sql.prepare("delete from messages where id = 'm4'").run();
    msg("m5", "c2", 2, "user", 30);
    expect(sql.prepare("select seq from memory_message_seq where message_id = 'm5'").get()).toEqual({
      seq: 4,
    });
  });
});

/**
 * Migration 0033 (#188): the admin's former system-wide settings become each user's own — the switch (on only where
 * both the old global and the old per-user switch were on), the time, the connection·model; the old single pair
 * becomes the one allowed pair; the server-wide switch stays on (the old global moved into each user's switch).
 * Checkpoints, the queue, the run records and the prompt versions are untouched; the newest version is the default.
 */
describe("migration 0033 (기억 정리 per user)", () => {
  const before = (config: object | null) => {
    const db = openDb(":memory:");
    closers.push(() => db.$client.close());
    migrate(db, { migrationsFolder: migrationsUpTo(32) });
    const sql = db.$client;
    for (const u of ["u1", "u2", "u3"])
      sql
        .prepare("insert into users (id, email, name, role) values (?, ?, ?, 'member')")
        .run(u, `${u}@x.test`, u);
    if (config)
      sql
        .prepare(
          "insert into settings (key, value, encrypted, updated_at) values ('dreaming.config', ?, 0, 1)",
        )
        .run(JSON.stringify(config));
    // u1: a checkpoint of before; u2: turned off by the admin; u3: no row (= on, in #146).
    sql
      .prepare(
        "insert into dreaming_users (user_id, enabled, checkpoint, checkpoint_at, paused_at, updated_at) values ('u1', 1, 5, 100, null, 1), ('u2', 0, 0, null, 50, 1)",
      )
      .run();
    sql
      .prepare(
        "insert into dreaming_prompts (version, content, author_id, restored_from, created_at) values (1, '관리자 프롬프트', 'u1', null, 7)",
      )
      .run();
    sql
      .prepare(
        `insert into dreaming_runs (id, user_id, date, attempt, idem_key, trigger, status, code, counts, runtime, model,
           connection_id, prompt_version, started_at, finished_at)
         values ('r1', 'u1', '2026-11-17', 1, 'dreaming:u1:2026-11-17:1', 'regular', 'unchanged', null, '{}', 'codex', 'm', 'c9', 1, 1, 2)`,
      )
      .run();
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    return sql;
  };
  const users = (sql: ReturnType<typeof before>) =>
    sql
      .prepare(
        "select user_id, enabled, time, runtime, connection_id, model, prompt, checkpoint, paused_at from dreaming_users order by user_id",
      )
      .all();

  it("moves the switch, time, connection and model into each user's settings; the pair becomes the allowed one", () => {
    const sql = before({
      enabled: true,
      time: "04:30",
      connectionId: "c9",
      runtime: "codex",
      model: "m",
      tokenCap: 123_000,
    });
    const row = { time: "04:30", runtime: "codex", connection_id: "c9", model: "m", prompt: null };
    expect(users(sql)).toEqual([
      { user_id: "u1", enabled: 1, ...row, checkpoint: 5, paused_at: null },
      { user_id: "u2", enabled: 0, ...row, checkpoint: 0, paused_at: 50 },
      { user_id: "u3", enabled: 1, ...row, checkpoint: 0, paused_at: null },
    ]);
    const cfg = sql.prepare("select value from settings where key = 'dreaming.config'").get() as {
      value: string;
    };
    expect(JSON.parse(cfg.value)).toEqual({
      enabled: true,
      tokenCap: 123_000,
      allowed: [{ runtime: "codex", connectionId: "c9", model: "m" }],
    });
    // Unchanged: the run record, the prompt versions; new notification preference on by default.
    expect(sql.prepare("select id, prompt_version, connection_id from dreaming_runs").all()).toEqual([
      { id: "r1", prompt_version: 1, connection_id: "c9" },
    ]);
    expect(sql.prepare("select version, content from dreaming_prompts").all()).toEqual([
      { version: 1, content: "관리자 프롬프트" },
    ]);
    sql
      .prepare(
        "insert into notification_prefs (user_id, time_zone, updated_at) values ('u1', 'Asia/Seoul', 1)",
      )
      .run();
    expect(sql.prepare("select memory_failed from notification_prefs").get()).toEqual({ memory_failed: 1 });
  });

  it("globally off (or never set up) → everyone off, nothing allowed, the server-wide switch on", () => {
    const off = before({
      enabled: false,
      time: "03:00",
      connectionId: null,
      runtime: null,
      model: null,
      tokenCap: 300_000,
    });
    expect((users(off) as { enabled: number }[]).map((u) => u.enabled)).toEqual([0, 0, 0]);
    const cfg = off.prepare("select value from settings where key = 'dreaming.config'").get() as {
      value: string;
    };
    expect(JSON.parse(cfg.value)).toEqual({ enabled: true, tokenCap: 300_000, allowed: [] });
    const none = before(null);
    expect(users(none)).toEqual(
      ["u1", "u2", "u3"].map((u) =>
        expect.objectContaining({ user_id: u, enabled: 0, time: "03:00", runtime: null, model: null }),
      ),
    );
    expect(none.prepare("select count(*) as n from settings where key = 'dreaming.config'").get()).toEqual({
      n: 0,
    });
  });
});
