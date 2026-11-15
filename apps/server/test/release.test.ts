import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, listBackups } from "../src/backup/backup.js";
import { FileWriteLock } from "../src/backup/lock.js";
import { verifyBackup } from "../src/backup/restore.js";
import { loadConfig } from "../src/config.js";
import { createMasterKey } from "../src/crypto/secrets.js";
import { openDb, runMigrations } from "../src/db/client.js";
import {
  checkBackup,
  migrateData,
  predeployBackup,
  ReleaseError,
  releaseSummary,
} from "../src/release/ops.js";
import { acquireDataLock } from "../src/storage/data-lock.js";
import { ensureLayout } from "../src/storage/paths.js";

/** The installed-release helpers of scripts/release.sh (#143): config summary, pre-deploy backup, data move. */

const closers: (() => void)[] = [];
afterEach(() => {
  while (closers.length) closers.pop()!();
});

function tmp(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-release-")));
  closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const sha = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

/** A row with only the required columns (placeholder values; foreign keys off) plus `fixed`. */
function insertRow(sqlite: Database.Database, table: string, fixed: Record<string, string | number>) {
  const cols = sqlite
    .prepare(`SELECT name, "notnull" AS nn, dflt_value AS d FROM pragma_table_info('${table}')`)
    .all() as { name: string; nn: number; d: string | null }[];
  const names = [
    ...new Set([...cols.filter((c) => c.nn && c.d === null).map((c) => c.name), ...Object.keys(fixed)]),
  ];
  sqlite
    .prepare(`INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`)
    .run(...names.map((n) => fixed[n] ?? `x-${n}`));
}

/** A data folder with a migrated database, one upload file and two runtime sessions. */
function dataFolder(root: string) {
  const dataDir = path.join(root, "data");
  const paths = ensureLayout(dataDir);
  const db = openDb(paths.db);
  runMigrations(db);
  const sqlite = db.$client;
  sqlite.pragma("foreign_keys = OFF");
  for (const id of ["s1", "s2"]) insertRow(sqlite, "runtime_sessions", { id });
  sqlite.prepare("CREATE TABLE IF NOT EXISTS release_probe (v TEXT)").run();
  sqlite.prepare("INSERT INTO release_probe VALUES ('committed')").run();
  return { dataDir, paths, db };
}

describe("releaseSummary", () => {
  const base = (root: string, env: Record<string, string>) => {
    const release = path.join(root, "releases", "20261115-000000-abcdefabcdef");
    fs.mkdirSync(release, { recursive: true });
    fs.writeFileSync(path.join(root, "env"), "", { mode: 0o600 });
    fs.symlinkSync(path.join(root, "env"), path.join(release, ".env"));
    const full = { NODE_ENV: "production", MASTER_KEY_PATH: path.join(root, "key", "master.key"), ...env };
    return () => releaseSummary(loadConfig(full, release), { repoRoot: release, env: full });
  };

  it("accepts absolute DATA_DIR and BACKUP_DIR outside the releases folder", () => {
    const root = tmp();
    const s = base(root, {
      DATA_DIR: path.join(root, "data"),
      BACKUP_DIR: path.join(root, "backups"),
      PORT: "3917",
    })();
    expect(s).toMatchObject({
      port: 3917,
      dataDir: path.join(root, "data"),
      database: "absent",
      workerRunUser: false,
    });
  });

  it("refuses unset, relative or in-release data and backup folders", () => {
    const root = tmp();
    expect(base(root, { BACKUP_DIR: path.join(root, "backups") })).toThrow(/DATA_DIR is not set/);
    expect(base(tmp(), { DATA_DIR: "./data", BACKUP_DIR: "/nonexistent/b" })).toThrow(
      /DATA_DIR must be an absolute path/,
    );
    const r3 = tmp();
    expect(base(r3, { DATA_DIR: path.join(r3, "releases", "data"), BACKUP_DIR: path.join(r3, "b") })).toThrow(
      /DATA_DIR must be outside the releases folder/,
    );
  });

  it("refuses a release without its .env link", () => {
    const root = tmp();
    const release = path.join(root, "releases", "r");
    fs.mkdirSync(release, { recursive: true });
    const env = { NODE_ENV: "production", DATA_DIR: path.join(root, "d"), BACKUP_DIR: path.join(root, "b") };
    expect(() => releaseSummary(loadConfig(env, release), { repoRoot: release, env })).toThrow(
      /\.env not found/,
    );
  });
});

describe("predeployBackup", () => {
  it("backs up a database a running server holds, read-only, in the restore tool's format", async () => {
    const root = tmp();
    const { dataDir, paths, db } = dataFolder(root);
    fs.mkdirSync(path.join(paths.files, "u1", "c1"), { recursive: true });
    const key = createMasterKey(path.join(root, "key", "master.key"));
    // The "server": the data folder's lock held and a write transaction open (not committed) in WAL mode.
    const lock = acquireDataLock(dataDir, "server");
    closers.push(() => lock.release());
    db.$client.pragma("wal_checkpoint(TRUNCATE)");
    const mainBefore = sha(paths.db);
    db.$client.exec("BEGIN IMMEDIATE");
    db.$client.prepare("INSERT INTO release_probe VALUES ('uncommitted')").run();
    const backupDir = path.join(root, "backups");
    const r = await predeployBackup({ dataDir, backupDir, masterKey: key });
    db.$client.exec("ROLLBACK");
    expect(r).toBeDefined();
    expect(listBackups(backupDir).map((b) => b.id)).toEqual([r!.id]);
    expect(fs.readdirSync(backupDir).filter((n) => !n.startsWith(".predeploy.lock"))).toEqual([r!.id]); // no staging left behind
    expect(verifyBackup(r!.dir, key).pending).toBe(0);
    const snap = new Database(path.join(r!.dir, "agentlee.db"), { readonly: true });
    expect(snap.prepare("SELECT v FROM release_probe").all()).toEqual([{ v: "committed" }]);
    snap.close();
    expect(sha(paths.db)).toBe(mainBefore); // the live database file was not written
    expect(lock.held()).toBe(true);
    db.$client.close();
  });

  it("takes the files to copy from the snapshot, not the live database (#148 review P1)", async () => {
    const root = tmp();
    const { dataDir, paths, db } = dataFolder(root);
    const key = createMasterKey(path.join(root, "key", "master.key"));
    const backupDir = path.join(root, "backups");
    const upload = (id: string) => {
      insertRow(db.$client, "files", { id, user_id: "u1", conversation_id: "c1" });
      fs.mkdirSync(path.join(paths.files, "u1", "c1"), { recursive: true });
      fs.writeFileSync(path.join(paths.files, "u1", "c1", id), `body ${id}`);
    };
    upload("f1");
    // The server deletes the row right after the snapshot (file still there): the backup still carries the file
    // its database references.
    const r = await predeployBackup({
      dataDir,
      backupDir,
      masterKey: key,
      afterSnapshot: () => db.$client.prepare("DELETE FROM files WHERE id = 'f1'").run(),
    });
    expect(fs.readFileSync(path.join(r!.dir, "files", "u1", "c1", "f1"), "utf8")).toBe("body f1");
    const snap = new Database(path.join(r!.dir, "agentlee.db"), { readonly: true });
    expect(snap.prepare("SELECT id FROM files").all()).toEqual([{ id: "f1" }]);
    snap.close();

    // Purged in between (row and file gone): a backup whose database references a missing file is refused, never
    // saved as a valid one.
    upload("f2");
    const err = await predeployBackup({
      dataDir,
      backupDir,
      masterKey: key,
      afterSnapshot: () => {
        db.$client.prepare("DELETE FROM files WHERE id = 'f2'").run();
        fs.rmSync(path.join(paths.files, "u1", "c1", "f2"));
      },
    }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "backup_failed" });
    expect(listBackups(backupDir).map((b) => b.id)).toEqual([r!.id]);
    expect(
      fs.readdirSync(backupDir).filter((n) => n.startsWith(".") && !n.startsWith(".predeploy.lock")),
    ).toEqual([]);
    db.$client.close();
  });

  it("runs one pre-deploy backup per BACKUP_DIR: a second one refuses and never removes the first's staging (round 3)", async () => {
    const root = tmp();
    const { dataDir, db } = dataFolder(root);
    db.$client.close();
    const key = createMasterKey(path.join(root, "key", "master.key"));
    const backupDir = path.join(root, "backups");
    let second: Promise<unknown> | undefined;
    let stagingSeen: string[] = [];
    const first = await predeployBackup({
      dataDir,
      backupDir,
      masterKey: key,
      afterSnapshot: () => {
        // Another run on the same BACKUP_DIR (another release root, a direct CLI call) while this one is mid-way.
        second = predeployBackup({ dataDir, backupDir, masterKey: key }).catch((e: unknown) => e);
        stagingSeen = fs.readdirSync(backupDir).filter((n) => n.startsWith(".predeploy-"));
      },
    });
    expect(await second).toMatchObject({ code: "backup_running" });
    expect(stagingSeen).toHaveLength(1); // the first run's staging survived the second one's start
    expect(verifyBackup(first!.dir, key).pending).toBe(0);
    const later = await predeployBackup({ dataDir, backupDir, masterKey: key, now: () => Date.now() + 2000 });
    expect(
      listBackups(backupDir)
        .map((b) => b.id)
        .sort(),
    ).toEqual([first!.id, later!.id].sort());
  });

  it("clears staging left by a killed run and keeps the snapshot owner-only under any umask (round 2)", async () => {
    const root = tmp();
    const { dataDir, db } = dataFolder(root);
    db.$client.close();
    const key = createMasterKey(path.join(root, "key", "master.key"));
    const backupDir = path.join(root, "backups");
    fs.mkdirSync(path.join(backupDir, ".predeploy-deadbeef"), { recursive: true });
    fs.writeFileSync(path.join(backupDir, ".predeploy-deadbeef", "live-snapshot.db"), "stale copy");
    const modes: string[] = [];
    const old = process.umask(0o022);
    try {
      const r = await predeployBackup({
        dataDir,
        backupDir,
        masterKey: key,
        afterSnapshot: () => {
          for (const n of fs.readdirSync(backupDir).filter((x) => x.startsWith(".predeploy-"))) {
            const dir = path.join(backupDir, n);
            modes.push(
              `${n === ".predeploy-deadbeef" ? "stale" : "staging"} ${(fs.statSync(dir).mode & 0o777).toString(8)}`,
            );
            modes.push(
              `snapshot ${(fs.statSync(path.join(dir, "live-snapshot.db")).mode & 0o777).toString(8)}`,
            );
          }
        },
      });
      expect(modes).toEqual(["staging 700", "snapshot 600"]);
      expect(fs.readdirSync(backupDir).filter((n) => !n.startsWith(".predeploy.lock"))).toEqual([r!.id]);
    } finally {
      process.umask(old);
    }
  });

  it("checks whether a release can restore a backup (rollback hint, #148 review P2)", async () => {
    const root = tmp();
    const { dataDir, db } = dataFolder(root);
    const key = createMasterKey(path.join(root, "key", "master.key"));
    const backupDir = path.join(root, "backups");
    const ok = await predeployBackup({ dataDir, backupDir, masterKey: key });
    expect(checkBackup(backupDir, ok!.id, key)).toEqual({ pending: 0 });
    db.$client
      .prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('future', ?)")
      .run(Date.now() + 1e9);
    // A backup with a migration this code does not know — what the target of a multi-step rollback refuses.
    const newer = await createBackup({
      sqlite: db.$client,
      dataDir,
      backupDir,
      masterKey: key,
      lock: new FileWriteLock(),
      now: () => Date.now() + 2000,
    });
    db.$client.close();
    expect(() => checkBackup(backupDir, newer.id, key)).toThrow(
      expect.objectContaining({ code: "schema_newer" }),
    );
    expect(() => checkBackup(backupDir, "../x", key)).toThrow(expect.objectContaining({ code: "usage" }));
    expect(() => checkBackup(backupDir, "20261115-000000Z-000000", key)).toThrow(
      expect.objectContaining({ code: "backup_not_found" }),
    );
  });

  it("is a no-op without a database and stops on a database newer than the release", async () => {
    const root = tmp();
    const key = createMasterKey(path.join(root, "key", "master.key"));
    expect(
      await predeployBackup({
        dataDir: path.join(root, "none"),
        backupDir: path.join(root, "b"),
        masterKey: key,
      }),
    ).toBeUndefined();
    const { dataDir, db } = dataFolder(root);
    db.$client
      .prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('future', ?)")
      .run(Date.now() + 1e9);
    db.$client.close();
    const backupDir = path.join(root, "backups");
    const err = await predeployBackup({ dataDir, backupDir, masterKey: key }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReleaseError);
    expect((err as ReleaseError).code).toBe("schema_newer");
    expect(fs.readdirSync(backupDir).filter((n) => n.startsWith(".predeploy-"))).toEqual([]);
  });
});

describe("migrateData", () => {
  /** Every entry with type, mode, size and content hash — to prove the original is untouched. */
  function snapshot(dir: string): string[] {
    const out: string[] = [];
    const walk = (rel: string) => {
      const abs = path.join(dir, rel);
      const st = fs.lstatSync(abs);
      if (st.isSymbolicLink()) out.push(`${rel} link ${fs.readlinkSync(abs)}`);
      else if (st.isDirectory()) {
        out.push(`${rel} dir ${(st.mode & 0o7777).toString(8)}`);
        for (const n of fs.readdirSync(abs).sort()) walk(path.join(rel, n));
      } else out.push(`${rel} file ${(st.mode & 0o7777).toString(8)} ${sha(abs)}`);
    };
    walk(".");
    return out;
  }

  function oldData(root: string) {
    const { dataDir, paths, db } = dataFolder(root);
    db.$client.close();
    // A Claude session keyed by the absolute working folder (the path dependence the move has to handle).
    const conn = path.join(paths.runtimes, "conn1", "user1");
    const projects = path.join(conn, "config", "projects", conn.replace(/[^A-Za-z0-9]/g, "-") + "-work");
    fs.mkdirSync(projects, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(projects, "s1.jsonl"), "{}\n", { mode: 0o600 });
    fs.mkdirSync(path.join(paths.files, "u1", "c1"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(paths.files, "u1", "c1", "f1"), "file body", { mode: 0o600 });
    fs.mkdirSync(path.join(dataDir, "shared"), { mode: 0o750 });
    fs.chmodSync(path.join(dataDir, "shared"), 0o750);
    fs.writeFileSync(path.join(dataDir, "shared", "r"), "r", { mode: 0o640 });
    fs.chmodSync(path.join(dataDir, "shared", "r"), 0o640);
    fs.symlinkSync("../files", path.join(dataDir, "shared", "link"));
    return dataDir;
  }

  it("copies with modes kept, checks integrity, invalidates runtime sessions and leaves the original as it was", () => {
    const root = tmp();
    const from = oldData(root);
    const before = snapshot(from);
    const to = path.join(root, "home", "data");
    const r = migrateData({ from, to });
    expect(r).toMatchObject({ from, to, sessionsInvalidated: 2 });
    expect(r.files).toBeGreaterThanOrEqual(4);
    expect(snapshot(from)).toEqual(before);
    const copy = snapshot(to).filter((l) => !l.startsWith("agentlee.db"));
    expect(copy).toEqual(before.filter((l) => !l.startsWith("agentlee.db")));
    const db = new Database(path.join(to, "agentlee.db"), { readonly: true });
    expect(db.prepare("SELECT count(*) AS n FROM runtime_sessions WHERE invalidated = 1").get()).toEqual({
      n: 2,
    });
    expect(db.prepare("SELECT v FROM release_probe").all()).toEqual([{ v: "committed" }]);
    db.close();
    expect(fs.readdirSync(path.dirname(to)).filter((n) => n.includes("migrating"))).toEqual([]);
  });

  it("refuses a database that is a link, leaving the original byte for byte (#148 review P2)", () => {
    const root = tmp();
    const from = oldData(root);
    const elsewhere = path.join(root, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.renameSync(path.join(from, "agentlee.db"), path.join(elsewhere, "agentlee.db"));
    fs.symlinkSync(path.join(elsewhere, "agentlee.db"), path.join(from, "agentlee.db"));
    const before = sha(path.join(elsewhere, "agentlee.db"));
    const to = path.join(root, "home", "data");
    expect(() => migrateData({ from, to })).toThrow(expect.objectContaining({ code: "db_not_plain" }));
    expect(sha(path.join(elsewhere, "agentlee.db"))).toBe(before);
    expect(fs.existsSync(to)).toBe(false);
    // A link as a side file too.
    fs.rmSync(path.join(from, "agentlee.db"));
    fs.renameSync(path.join(elsewhere, "agentlee.db"), path.join(from, "agentlee.db"));
    fs.symlinkSync(path.join(elsewhere, "x"), path.join(from, "agentlee.db-wal"));
    expect(() => migrateData({ from, to })).toThrow(expect.objectContaining({ code: "db_not_plain" }));
  });

  it("refuses while a server holds the old folder, into a non-empty target, or a relative path", () => {
    const root = tmp();
    const from = oldData(root);
    const lock = acquireDataLock(from, "server");
    const to = path.join(root, "home", "data");
    expect(() => migrateData({ from, to })).toThrow(expect.objectContaining({ code: "server_running" }));
    lock.release();
    expect(fs.existsSync(to)).toBe(false);
    fs.mkdirSync(to, { recursive: true });
    fs.writeFileSync(path.join(to, "x"), "x");
    expect(() => migrateData({ from, to })).toThrow(expect.objectContaining({ code: "target_exists" }));
    expect(() => migrateData({ from: "data", to: path.join(root, "t2") })).toThrow(
      expect.objectContaining({ code: "usage" }),
    );
    expect(() => migrateData({ from, to: path.join(from, "inner") })).toThrow(
      expect.objectContaining({ code: "target_unsafe" }),
    );
  });
});
