import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { initStorage } from "../src/bootstrap.js";
import { loadConfig } from "../src/config.js";
import {
  createMasterKey,
  decrypt,
  encrypt,
  KEY_LEN,
  loadMasterKey,
  mask,
  SecretError,
} from "../src/crypto/secrets.js";
import { createTestDb, openDb, runMigrations } from "../src/db/client.js";
import { SettingsStore } from "../src/db/settings-store.js";
import { assertSafeId, ensureLayout, storagePaths } from "../src/storage/paths.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-st-"));
const key = () => Buffer.alloc(KEY_LEN, 7);

describe("secrets", () => {
  it("round-trips with a fresh IV each time", () => {
    const a = encrypt("sk-test-1234", key());
    const b = encrypt("sk-test-1234", key());
    expect(a).not.toBe(b);
    expect(decrypt(a, key())).toBe("sk-test-1234");
  });

  it("detects tampering, wrong key and wrong context", () => {
    const payload = encrypt("secret-value", key(), "connection:abc");
    const raw = Buffer.from(payload.slice(3), "base64");
    raw[raw.length - 1]! ^= 0x01;
    expect(() => decrypt(`v1:${raw.toString("base64")}`, key(), "connection:abc")).toThrow(SecretError);
    expect(() => decrypt(payload, Buffer.alloc(KEY_LEN, 9), "connection:abc")).toThrow(SecretError);
    expect(() => decrypt(payload, key(), "connection:other")).toThrow(SecretError);
    expect(() => decrypt("v0:abcd", key())).toThrow(SecretError);
  });

  it("masks to the last 4 characters", () => {
    expect(mask("sk-ant-abcdef1234")).toBe("••••1234");
    expect(mask("abc")).toBe("••••");
  });

  it("rejects a symlinked key and a key directory writable by others", () => {
    const dir = tmp();
    const real = path.join(dir, "real.key");
    createMasterKey(real);
    const link = path.join(dir, "link.key");
    fs.symlinkSync(real, link);
    expect(() => loadMasterKey(link)).toThrow(/symlink/);
    const open = path.join(tmp(), "open");
    fs.mkdirSync(open, { mode: 0o777 });
    fs.chmodSync(open, 0o777);
    const k = path.join(open, "master.key");
    fs.writeFileSync(k, Buffer.alloc(KEY_LEN, 1).toString("base64"), { mode: 0o600 });
    expect(() => loadMasterKey(k)).toThrow(/not writable by others/);
  });

  it("creates a mode-600 key file, refuses to overwrite, and rejects loose permissions", () => {
    const file = path.join(tmp(), "k", "master.key");
    const created = createMasterKey(file);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(loadMasterKey(file).equals(created)).toBe(true);
    expect(() => createMasterKey(file)).toThrow(/already exists/);
    fs.chmodSync(file, 0o644);
    expect(() => loadMasterKey(file)).toThrow(/mode 600/);
  });
});

describe("database", () => {
  it("applies migrations to an in-memory database", () => {
    const db = createTestDb();
    const tables = db.$client
      .prepare(
        "select name from sqlite_master where type='table' and name not like '%migrations%' order by name",
      )
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual([
      "artifact_versions",
      "artifacts",
      "citations",
      "connection_limits",
      "connections",
      "conversation_summaries",
      "conversations",
      "error_log",
      "file_extracts",
      "file_segments",
      "files",
      "finance_results",
      "messages",
      "notification_prefs",
      "notifications",
      "price_tables",
      "push_session_state",
      "push_subscriptions",
      "run_events",
      "runs",
      "runtime_policies",
      "runtime_sessions",
      "schedule_attempts",
      "schedule_proposals",
      "schedule_results",
      "schedule_runs",
      "schedules",
      "sessions",
      "settings",
      "sources",
      "upload_cancellations",
      "usage_records",
      "users",
      "watchlist_items",
    ]);
    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("uses WAL on file databases and migrations are idempotent", () => {
    const file = path.join(tmp(), "a.db");
    const db = openDb(file);
    runMigrations(db);
    runMigrations(db);
    expect(db.$client.pragma("journal_mode", { simple: true })).toBe("wal");
    db.$client.close();
  });

  it("never writes secret plaintext to the database or its WAL", () => {
    const dir = tmp();
    const file = path.join(dir, "s.db");
    const db = openDb(file);
    runMigrations(db);
    const store = new SettingsStore(db, key());
    store.setSecret("cloudflare.apiToken", "CF-SECRET-PLAINTEXT-9876");
    store.set("cloudflare.accountName", "family");
    expect(store.get("cloudflare.apiToken")).toBe("CF-SECRET-PLAINTEXT-9876");
    // Before checkpoint: the change lives in the WAL, which must not hold the plaintext either.
    const walBytes = () => Buffer.concat(fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f))));
    expect(fs.existsSync(`${file}-wal`)).toBe(true);
    expect(walBytes().includes("family")).toBe(true); // sanity: the scan does see stored values
    expect(walBytes().includes("CF-SECRET-PLAINTEXT-9876")).toBe(false);
    db.$client.pragma("wal_checkpoint(TRUNCATE)");
    db.$client.close();
    const bytes = Buffer.concat(fs.readdirSync(dir).map((f) => fs.readFileSync(path.join(dir, f))));
    expect(bytes.includes("CF-SECRET-PLAINTEXT-9876")).toBe(false);
    expect(bytes.includes("family")).toBe(true);
  });
});

describe("storage layout", () => {
  it("creates owner-only directories", () => {
    const p = ensureLayout(path.join(tmp(), "data"));
    for (const d of [p.root, p.files, p.artifacts, p.runtimes, p.sources]) {
      expect(fs.statSync(d).mode & 0o777).toBe(0o700);
    }
  });

  it("refuses symlinked managed directories and tightens loose permissions", () => {
    const root = path.join(tmp(), "data");
    fs.mkdirSync(root, { mode: 0o700 });
    const outside = tmp();
    fs.symlinkSync(outside, path.join(root, "files"));
    expect(() => ensureLayout(root)).toThrow(/symlink/);
    const root2 = path.join(tmp(), "data");
    fs.mkdirSync(path.join(root2, "artifacts"), { recursive: true });
    fs.chmodSync(path.join(root2, "artifacts"), 0o777);
    ensureLayout(root2);
    expect(fs.statSync(path.join(root2, "artifacts")).mode & 0o777).toBe(0o700);
  });

  it("rejects ids that could escape the layout", () => {
    const p = storagePaths("/srv/data");
    expect(p.conversationFiles("u1", "c_1")).toBe("/srv/data/files/u1/c_1");
    for (const bad of ["..", "../x", "a/b", "a\\\\b", "", "x".repeat(129), "a b"]) {
      expect(() => assertSafeId("user", bad)).toThrow(/unsafe/);
    }
    expect(() => p.runtimeHome("../../etc")).toThrow(/unsafe/);
  });
});

describe("bootstrap", () => {
  it("refuses a master key inside DATA_DIR", () => {
    expect(() => loadConfig({ DATA_DIR: "/srv/data", MASTER_KEY_PATH: "/srv/data/master.key" })).toThrow(
      /outside DATA_DIR/,
    );
    expect(() => loadConfig({ DATA_DIR: "/srv/data", MASTER_KEY_PATH: "/srv/key/master.key" })).not.toThrow();
  });

  it("creates the key in development but requires it in production", () => {
    const dir = tmp();
    const dev = loadConfig({
      NODE_ENV: "development",
      DATA_DIR: path.join(dir, "data"),
      MASTER_KEY_PATH: path.join(dir, "k1", "master.key"),
    });
    const s = initStorage(dev);
    expect(fs.existsSync(dev.masterKeyPath)).toBe(true);
    s.db.$client.close();
    const prod = loadConfig({
      NODE_ENV: "production",
      DATA_DIR: path.join(dir, "data2"),
      MASTER_KEY_PATH: path.join(dir, "k2", "master.key"),
    });
    expect(() => initStorage(prod)).toThrow(/pnpm keygen/);
  });

  it("does not create a new key over existing data in development", () => {
    const dir = tmp();
    const cfg = loadConfig({
      NODE_ENV: "development",
      DATA_DIR: path.join(dir, "data"),
      MASTER_KEY_PATH: path.join(dir, "k", "master.key"),
    });
    initStorage(cfg).db.$client.close();
    fs.rmSync(cfg.masterKeyPath);
    expect(() => initStorage(cfg)).toThrow(/restore the key/);
    expect(fs.existsSync(cfg.masterKeyPath)).toBe(false);
  });
});
