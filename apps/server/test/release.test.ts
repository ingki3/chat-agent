import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { listBackups } from "../src/backup/backup.js";
import { verifyBackup } from "../src/backup/restore.js";
import { loadConfig } from "../src/config.js";
import { createMasterKey } from "../src/crypto/secrets.js";
import { openDb, runMigrations } from "../src/db/client.js";
import { migrateData, predeployBackup, ReleaseError, releaseSummary } from "../src/release/ops.js";
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

/** A data folder with a migrated database, one upload file and two runtime sessions. */
function dataFolder(root: string) {
  const dataDir = path.join(root, "data");
  const paths = ensureLayout(dataDir);
  const db = openDb(paths.db);
  runMigrations(db);
  const sqlite = db.$client;
  sqlite.pragma("foreign_keys = OFF");
  const cols = sqlite
    .prepare("SELECT name, \"notnull\" AS nn, dflt_value AS d FROM pragma_table_info('runtime_sessions')")
    .all() as {
    name: string;
    nn: number;
    d: string | null;
  }[];
  const required = cols.filter((c) => c.nn && c.d === null);
  for (const id of ["s1", "s2"]) {
    const values = required.map((c) => (c.name === "id" ? id : `x-${c.name}`));
    sqlite
      .prepare(
        `INSERT INTO runtime_sessions (${required.map((c) => c.name).join(",")}) VALUES (${required.map(() => "?").join(",")})`,
      )
      .run(...values);
  }
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
    expect(fs.readdirSync(backupDir)).toEqual([r!.id]); // no staging left behind
    expect(verifyBackup(r!.dir, key).pending).toBe(0);
    const snap = new Database(path.join(r!.dir, "agentlee.db"), { readonly: true });
    expect(snap.prepare("SELECT v FROM release_probe").all()).toEqual([{ v: "committed" }]);
    snap.close();
    expect(sha(paths.db)).toBe(mainBefore); // the live database file was not written
    expect(lock.held()).toBe(true);
    db.$client.close();
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
