import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { BackupsResponse, CSRF_HEADER } from "@agentlee/shared";
import { buildApp, type BuildOptions } from "../src/app.js";
import { initStorage, openServerStorage } from "../src/bootstrap.js";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { createMasterKey, encrypt, loadMasterKey } from "../src/crypto/secrets.js";
import { MIGRATIONS_DIR, openDb } from "../src/db/client.js";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import {
  BACKUP_CODES,
  createBackup,
  DB_FILE,
  MANIFEST_FILE,
  nextRunAt,
  pruneBackups,
  sha256File,
  type Manifest,
} from "../src/backup/backup.js";
import { FileWriteLock } from "../src/backup/lock.js";
import {
  CANDIDATE_ID_FILE,
  OLD_ID_FILE,
  restoreBackup,
  RestoreError,
  restoreJournalPath,
  verifyBackup,
  type RestoreCode,
} from "../src/backup/restore.js";
import { appliedMigrations, checkSchema, codeMigrations } from "../src/backup/schema.js";
import { BACKUP_CODES as LOGGABLE_BACKUP_CODES } from "../src/observability/policy.js";
import { RuntimeFailure, RuntimeRegistry, type StartContext } from "../src/runtime/adapter.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import {
  acquireDataLock,
  caseInsensitive,
  dataLockPath,
  DataLockHeld,
  realDataDir,
  sameDataDir,
} from "../src/storage/data-lock.js";
import { storagePaths } from "../src/storage/paths.js";
import { createFamily } from "./helpers/permission-matrix.js";

type App = Awaited<ReturnType<typeof buildApp>>;
const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const DAY = 86_400_000;
const LOCAL = { host: "localhost:3000" };
const PW = "matrix-password-1";
/** A fake credential: after a restore it must decrypt with the recovered key and reach the runtime unchanged. */
const KEY_SECRET = `sk-ant-BACKUPFAKEKEY${"b".repeat(20)}0037`;

function tmp(): string {
  // realpath: macOS's /var → /private/var, so path checks compare like with like.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-backup-")));
  closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Fails a test unless the run's credential decrypts (wrong key → `runtime_auth`), and records what it got. */
class CredentialRuntime extends FakeRuntime {
  readonly secrets: string[] = [];
  resolveSecret: ((ctx: StartContext) => string | undefined) | undefined;
  constructor() {
    super({ needsConnection: true });
  }
  override async start(ctx: StartContext) {
    let secret: string | undefined;
    try {
      secret = this.resolveSecret?.(ctx);
    } catch {
      secret = undefined;
    }
    if (!secret) throw new RuntimeFailure("runtime_auth");
    this.secrets.push(secret);
    return super.start(ctx);
  }
}

function capture() {
  const lines: string[] = [];
  const stream = new Writable({ write: (c, _e, cb) => (lines.push(String(c)), cb()) });
  return {
    stream,
    records: () =>
      lines
        .join("")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

/** A server on a real data folder (file database), like index.ts builds it. */
async function start(o: {
  dataDir: string;
  keyPath: string;
  backupDir?: string;
  backup?: BuildOptions["backup"];
}) {
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: o.dataDir,
    MASTER_KEY_PATH: o.keyPath,
    ...(o.backupDir ? { BACKUP_DIR: o.backupDir } : {}),
  });
  const storage = initStorage(config);
  const runtime = new CredentialRuntime();
  const runtimes = new RuntimeRegistry();
  runtimes.register(runtime);
  const log = capture();
  const app = await buildApp(config, {
    db: storage.db,
    masterKey: storage.masterKey,
    logStream: log.stream,
    runtimes,
    runs: { flushMs: 0 },
    notifications: { sender: async () => {} },
    mcp: {
      runSkill: async (_skill, input) => {
        const text = String(input.text);
        return {
          ok: true,
          output: {
            characters: [...text].length,
            sha256: crypto.createHash("sha256").update(text, "utf8").digest("hex"),
            reversed: [...text].reverse().join(""),
          },
        };
      },
    },
    connectionTest: { timeoutMs: 5000 },
    ...(o.backup ? { backup: o.backup } : {}),
  });
  runtime.resolveSecret = (ctx) =>
    app.connections!.store.resolve(ctx.connectionId, app.users!.byId(ctx.userId), "claude-code", {
      test: true,
      version: ctx.connectionVersion,
    })?.secret;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await app.close();
    storage.db.$client.close();
  };
  closers.push(close);
  return { app, storage, runtime, log, close };
}

const send = (app: App, cookie: string, method: "GET" | "POST" | "DELETE", url: string, payload?: object) =>
  app.inject({
    method,
    url,
    headers: {
      ...LOCAL,
      cookie,
      ...(method === "GET" ? {} : { origin: "http://localhost:3000", [CSRF_HEADER]: "1" }),
    },
    ...(method === "GET" ? {} : { payload: payload ?? {} }),
  });

async function login(app: App, email: string): Promise<string> {
  const r = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    headers: { ...LOCAL, origin: "http://localhost:3000", [CSRF_HEADER]: "1" },
    payload: { email, password: PW },
  });
  expect(r.statusCode).toBe(200);
  return String(r.headers["set-cookie"]).split(";")[0]!;
}

async function backupNow(app: App, adminCookie: string): Promise<string> {
  const r = await send(app, adminCookie, "POST", "/api/admin/backups");
  expect(r.statusCode, r.body).toBe(201);
  return r.json<{ item: { id: string } }>().item.id;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    out.push(p);
    if (e.isDirectory()) out.push(...walk(p));
  }
  return out;
}

const restoreCode = (fn: () => unknown): RestoreCode | "ok" => {
  try {
    fn();
    return "ok";
  } catch (e) {
    if (e instanceof RestoreError) return e.code;
    throw e;
  }
};

/** Rewrites a backup's database and makes its manifest match again (hashes, schema) — a valid-looking backup. */
function tamperDb(backup: string, change: (db: Database.Database) => void) {
  const file = path.join(backup, DB_FILE);
  const db = new Database(file);
  change(db);
  const rows = db.prepare("SELECT created_at AS c FROM __drizzle_migrations ORDER BY created_at").all() as {
    c: number;
  }[];
  db.close();
  const m = JSON.parse(fs.readFileSync(path.join(backup, MANIFEST_FILE), "utf8")) as Manifest;
  m.db = { ...m.db, bytes: fs.statSync(file).size, sha256: sha256File(file) };
  m.schema = { migrations: rows.length, lastMigrationAt: rows.at(-1) ? Number(rows.at(-1)!.c) : null };
  fs.writeFileSync(path.join(backup, MANIFEST_FILE), JSON.stringify(m));
}

/** One installation: data folder, key outside it, backups outside both. */
function layout() {
  const root = tmp();
  return {
    root,
    dataDir: path.join(root, "data"),
    keyPath: path.join(root, "keys", "master.key"),
    backupDir: path.join(root, "backups"),
  };
}

describe("rehearsal: restore into a separate folder with the recovered key (#37 완료 기준)", () => {
  it("brings back login, conversations, attachments, artifacts and connections that still pass their test", async () => {
    const L = layout();
    createMasterKey(L.keyPath);
    const one = await start(L);
    const f = await createFamily(one.app);
    const owner = f.users.owner;
    // Conversation with messages.
    const conv = one.app.conversations!.create(owner.id, { title: "리허설 대화" });
    one.app.conversations!.append(conv.id, {
      role: "user",
      parts: [{ type: "text", text: "REHEARSAL-QUESTION" }],
    });
    one.app.conversations!.append(conv.id, {
      role: "assistant",
      parts: [{ type: "text", text: "REHEARSAL-ANSWER" }],
      status: "complete",
    });
    // Attachment in the file store, written the way every file writer must (inside the lock).
    const attachment = path.join(storagePaths(L.dataDir).conversationFiles(owner.id, conv.id), "note.txt");
    await one.app.fileWrites.write(async () => {
      fs.mkdirSync(path.dirname(attachment), { recursive: true, mode: 0o700 });
      fs.writeFileSync(attachment, "ATTACHMENT-BYTES", { mode: 0o600 });
    });
    // An upload through the API (#22): its row and its file.
    const uploaded = await one.app.inject({
      method: "POST",
      url: `/api/conversations/${conv.id}/files`,
      headers: {
        ...LOCAL,
        cookie: f.cookies.owner,
        origin: "http://localhost:3000",
        [CSRF_HEADER]: "1",
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent("리허설.txt"),
      },
      payload: "UPLOADED-BYTES",
    });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    const fileId = uploaded.json<{ id: string }>().id;
    // Artifact.
    const { artifact } = one.app.artifacts!.create(
      { userId: owner.id, conversationId: conv.id, runId: "r" },
      { kind: "markdown", title: "리허설 문서", content: "# REHEARSAL-ARTIFACT" },
    );
    // Encrypted personal connection that passes its test.
    const created = await send(one.app, f.cookies.owner, "POST", "/api/connections", {
      runtime: "claude-code",
      authType: "api_key",
      secret: KEY_SECRET,
    });
    expect(created.statusCode).toBe(201);
    const connId = created.json<{ connection: { id: string } }>().connection.id;
    const tested = await send(one.app, f.cookies.owner, "POST", `/api/connections/${connId}/test`);
    expect(tested.json<{ result: { status: string } }>().result.status).toBe("passed");

    const id = await backupNow(one.app, f.cookies.admin);
    await one.close();

    // Disaster: the Mac's data and key are gone. The key comes back from its offline copy (docs/ops.md §3).
    const offlineCopy = fs.readFileSync(L.keyPath, "utf8");
    fs.rmSync(path.dirname(L.keyPath), { recursive: true });
    fs.rmSync(L.dataDir, { recursive: true });
    const recoveredKey = path.join(L.root, "new-keys", "master.key");
    fs.mkdirSync(path.dirname(recoveredKey), { mode: 0o700 });
    fs.writeFileSync(recoveredKey, offlineCopy, { mode: 0o600 });
    const target = path.join(L.root, "restored");
    const r = restoreBackup({
      backup: path.join(L.backupDir, id),
      target,
      key: loadMasterKey(recoveredKey),
      backupDir: L.backupDir,
      keyPaths: [recoveredKey],
    });
    expect(r).toMatchObject({ pending: 0, previous: undefined });
    // Owner-only, like a fresh data folder.
    expect(fs.statSync(target).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(target, DB_FILE)).mode & 0o777).toBe(0o600);
    for (const p of walk(target)) {
      const st = fs.statSync(p);
      expect(st.mode & 0o777, p).toBe(st.isDirectory() ? 0o700 : 0o600);
    }

    const two = await start({ dataDir: target, keyPath: recoveredKey, backupDir: L.backupDir });
    // Login (the password hash came back).
    const cookie = await login(two.app, owner.email);
    // Conversations and messages.
    const list = await send(two.app, cookie, "GET", "/api/conversations");
    expect(list.body).toContain(conv.id);
    const msgs = await send(two.app, cookie, "GET", `/api/conversations/${conv.id}/messages`);
    expect(msgs.body).toContain("REHEARSAL-QUESTION");
    expect(msgs.body).toContain("REHEARSAL-ANSWER");
    // Attachment.
    const restored = path.join(storagePaths(target).conversationFiles(owner.id, conv.id), "note.txt");
    expect(fs.readFileSync(restored, "utf8")).toBe("ATTACHMENT-BYTES");
    const original = await send(two.app, cookie, "GET", `/api/files/${fileId}/content`);
    expect(original.statusCode).toBe(200);
    expect(original.body).toBe("UPLOADED-BYTES");
    // Artifact.
    const art = await send(two.app, cookie, "GET", `/api/artifacts/${artifact.id}`);
    expect(art.statusCode).toBe(200);
    const raw = await send(two.app, cookie, "GET", `/a/${artifact.id}/v/1/raw`);
    expect(raw.statusCode).toBe(200);
    expect(raw.body).toContain("REHEARSAL-ARTIFACT");
    // Encrypted connection: listed (masked), its test passes with the recovered key, the runtime got the same key.
    const conns = await send(two.app, cookie, "GET", "/api/connections");
    expect(conns.body).toContain(connId);
    expect(conns.body).not.toContain(KEY_SECRET);
    const again = await send(two.app, cookie, "POST", `/api/connections/${connId}/test`);
    expect(again.json<{ result: { status: string; code: string } }>().result).toMatchObject({
      status: "passed",
      code: "ok",
    });
    expect(two.runtime.secrets).toEqual([KEY_SECRET]);
  });

  it("the restored data with a different key: the server refuses to start (its secrets do not decrypt)", async () => {
    // The control of the rehearsal: the test above passes because the key was recovered, not by accident.
    const L = layout();
    createMasterKey(L.keyPath);
    const one = await start(L);
    const f = await createFamily(one.app);
    const created = await send(one.app, f.cookies.owner, "POST", "/api/connections", {
      runtime: "claude-code",
      authType: "api_key",
      secret: KEY_SECRET,
    });
    const connId = created.json<{ connection: { id: string } }>().connection.id;
    const id = await backupNow(one.app, f.cookies.admin);
    await one.close();
    const target = path.join(L.root, "restored");
    restoreBackup({ backup: path.join(L.backupDir, id), target, key: loadMasterKey(L.keyPath) });
    const otherKey = path.join(L.root, "other", "master.key");
    createMasterKey(otherKey);
    await expect(start({ dataDir: target, keyPath: otherKey })).rejects.toThrow(
      /secret failed authentication/,
    );
    // With the key it was made with, the same connection passes.
    const two = await start({ dataDir: target, keyPath: L.keyPath });
    const cookie = await login(two.app, f.users.owner.email);
    const r = await send(two.app, cookie, "POST", `/api/connections/${connId}/test`);
    expect(r.json<{ result: { status: string } }>().result.status).toBe("passed");
  });
});

describe("restore refuses clearly and changes nothing (#37)", () => {
  async function made() {
    const L = layout();
    createMasterKey(L.keyPath);
    const one = await start(L);
    const f = await createFamily(one.app);
    await send(one.app, f.cookies.owner, "POST", "/api/connections", {
      runtime: "claude-code",
      authType: "api_key",
      secret: KEY_SECRET,
    });
    const attachment = path.join(L.dataDir, "files", "u1", "c1", "a.txt");
    fs.mkdirSync(path.dirname(attachment), { recursive: true, mode: 0o700 });
    fs.writeFileSync(attachment, "A", { mode: 0o600 });
    const id = await backupNow(one.app, f.cookies.admin);
    await one.close();
    return { ...L, backup: path.join(L.backupDir, id), key: loadMasterKey(L.keyPath) };
  }
  const nothingWritten = (root: string, target: string) => {
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.readdirSync(root).filter((n) => n.includes(".restore-"))).toEqual([]);
  };

  it("wrong key: wrong_key before anything is read or written", async () => {
    const t = await made();
    const target = path.join(t.root, "restored");
    expect(restoreCode(() => restoreBackup({ backup: t.backup, target, key: crypto.randomBytes(32) }))).toBe(
      "wrong_key",
    );
    nothingWritten(t.root, target);
    // The right key passes the same check.
    expect(restoreCode(() => verifyBackup(t.backup, t.key))).toBe("ok");
  });

  it("incompatible schema: newer → schema_newer, a different migration → schema_mismatch", async () => {
    const t = await made();
    const target = path.join(t.root, "restored");
    const newer = path.join(t.root, "newer");
    fs.cpSync(t.backup, newer, { recursive: true });
    tamperDb(newer, (db) =>
      db
        .prepare("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('future', 9999999999999)")
        .run(),
    );
    expect(restoreCode(() => restoreBackup({ backup: newer, target, key: t.key }))).toBe("schema_newer");
    nothingWritten(t.root, target);
    const other = path.join(t.root, "other");
    fs.cpSync(t.backup, other, { recursive: true });
    tamperDb(other, (db) =>
      db
        .prepare(
          "UPDATE __drizzle_migrations SET hash = 'other-branch' WHERE created_at = (SELECT MAX(created_at) FROM __drizzle_migrations)",
        )
        .run(),
    );
    expect(restoreCode(() => restoreBackup({ backup: other, target, key: t.key }))).toBe("schema_mismatch");
    nothingWritten(t.root, target);
  });

  it("schema check: an older backup is accepted (missing migrations applied), newer or different refused", () => {
    const code = codeMigrations();
    expect(code.length).toBeGreaterThan(2);
    expect(checkSchema(code, code)).toEqual({ ok: true, pending: 0 });
    expect(checkSchema(code.slice(0, -2), code)).toEqual({ ok: true, pending: 2 });
    expect(checkSchema([], code)).toEqual({ ok: true, pending: code.length });
    expect(checkSchema([...code, { hash: "x", createdAt: code.at(-1)!.createdAt + 1 }], code)).toEqual({
      ok: false,
      code: "schema_newer",
    });
    expect(checkSchema([{ ...code[0]!, hash: "x" }], code)).toEqual({ ok: false, code: "schema_mismatch" });
    // A migration the code does not have, between known ones (another branch's file).
    expect(checkSchema([code[0]!, { hash: "x", createdAt: code[0]!.createdAt + 1 }], code)).toEqual({
      ok: false,
      code: "schema_mismatch",
    });
  });

  it("damaged files, a tampered manifest, a running server and unsafe targets are refused", async () => {
    const t = await made();
    const target = path.join(t.root, "restored");
    const broken = path.join(t.root, "broken");
    fs.cpSync(t.backup, broken, { recursive: true });
    fs.appendFileSync(path.join(broken, DB_FILE), "x");
    // `check` (read-only) catches it too, not only the copy step.
    expect(restoreCode(() => verifyBackup(broken, t.key))).toBe("backup_corrupt");
    expect(restoreCode(() => restoreBackup({ backup: broken, target, key: t.key }))).toBe("backup_corrupt");
    const escape = path.join(t.root, "escape");
    fs.cpSync(t.backup, escape, { recursive: true });
    const m = JSON.parse(fs.readFileSync(path.join(escape, MANIFEST_FILE), "utf8")) as Manifest;
    m.files.push({ path: "files/../../evil", bytes: 0, sha256: "0".repeat(64) });
    fs.writeFileSync(path.join(escape, MANIFEST_FILE), JSON.stringify(m));
    expect(restoreCode(() => restoreBackup({ backup: escape, target, key: t.key }))).toBe("manifest_invalid");
    nothingWritten(t.root, target);
    // A server still holding the target's lock (the cross-process case is below).
    fs.mkdirSync(target, { mode: 0o700 });
    const held = acquireDataLock(target, "server");
    expect(restoreCode(() => restoreBackup({ backup: t.backup, target, key: t.key }))).toBe("server_running");
    held.release();
    // Into the backup folder, or over the key: refused.
    expect(
      restoreCode(() =>
        restoreBackup({
          backup: t.backup,
          target: path.join(t.backupDir, "x"),
          key: t.key,
          backupDir: t.backupDir,
        }),
      ),
    ).toBe("target_unsafe");
    expect(
      restoreCode(() =>
        restoreBackup({
          backup: t.backup,
          target: path.dirname(t.keyPath),
          key: t.key,
          keyPaths: [t.keyPath],
        }),
      ),
    ).toBe("target_unsafe");
  });

  it("in place: the old data folder is moved aside, never deleted; the new one is owner-only", async () => {
    const t = await made();
    fs.mkdirSync(t.dataDir, { recursive: true });
    fs.writeFileSync(path.join(t.dataDir, "marker"), "old");
    // A backup copied around (external disk, another Mac) may have lost its modes: the restore sets them again.
    for (const p of walk(t.backup)) fs.chmodSync(p, fs.statSync(p).isDirectory() ? 0o755 : 0o644);
    const r = restoreBackup({
      backup: t.backup,
      target: t.dataDir,
      key: t.key,
      now: () => Date.UTC(2026, 10, 11),
    });
    expect(r.previous).toBe(`${t.dataDir}.before-restore-20261111T000000Z`);
    expect(fs.readFileSync(path.join(r.previous!, "marker"), "utf8")).toBe("old");
    expect(fs.existsSync(path.join(t.dataDir, "marker"))).toBe(false);
    expect(fs.existsSync(path.join(t.dataDir, DB_FILE))).toBe(true);
    expect(fs.readFileSync(path.join(t.dataDir, "files", "u1", "c1", "a.txt"), "utf8")).toBe("A");
    for (const p of [t.dataDir, ...walk(t.dataDir)]) {
      const st = fs.statSync(p);
      expect(st.mode & 0o777, p).toBe(st.isDirectory() ? 0o700 : 0o600);
    }
  });
});

describe("what a backup holds (#37)", () => {
  it("never the master key: no key file, no key bytes in any form; config keeps the folders apart", async () => {
    const L = layout();
    const key = createMasterKey(L.keyPath);
    const one = await start(L);
    const f = await createFamily(one.app);
    await send(one.app, f.cookies.owner, "POST", "/api/connections", {
      runtime: "claude-code",
      authType: "api_key",
      secret: KEY_SECRET,
    });
    const id = await backupNow(one.app, f.cookies.admin);
    const files = walk(path.join(L.backupDir, id)).filter((p) => fs.statSync(p).isFile());
    expect(files.map((p) => path.basename(p)).sort()).toEqual([DB_FILE, MANIFEST_FILE].sort());
    const forms = [key, Buffer.from(key.toString("base64")), Buffer.from(key.toString("hex"))];
    for (const p of files) {
      const bytes = fs.readFileSync(p);
      for (const form of forms) expect(bytes.includes(form), p).toBe(false);
      // Credentials stay encrypted.
      expect(bytes.includes(KEY_SECRET), p).toBe(false);
    }
    // The connection's ciphertext is there (encrypted, not dropped).
    const db = new Database(path.join(L.backupDir, id, DB_FILE), { readonly: true });
    expect(
      (db.prepare("SELECT secret FROM connections").get() as { secret: string }).secret.startsWith("v1:"),
    ).toBe(true);
    db.close();
    // The configuration refuses layouts that would put the key or the data into the backups.
    const cfg = (env: Record<string, string>) => () =>
      loadConfig({ NODE_ENV: "test", DATA_DIR: L.dataDir, MASTER_KEY_PATH: L.keyPath, ...env });
    expect(cfg({ BACKUP_DIR: path.dirname(L.keyPath) })).toThrow(/must not contain the master key/);
    expect(cfg({ BACKUP_DIR: L.root })).toThrow(/outside DATA_DIR/);
    expect(cfg({ BACKUP_DIR: path.join(L.dataDir, "backups") })).toThrow(/outside DATA_DIR/);
    expect(cfg({ BACKUP_DIR: path.join(REPO_ROOT, "backups") })).toThrow(/outside the repository/);
    expect(cfg({ BACKUP_DIR: L.backupDir })).not.toThrow();
    // Tests without BACKUP_DIR make no backups (never the home folder); elsewhere the default is outside the repo.
    expect(loadConfig({ NODE_ENV: "test" }).backupDir).toBeUndefined();
    expect(loadConfig({ NODE_ENV: "development" }).backupDir).toBe(
      path.join(os.homedir(), "agentlee-backups"),
    );
  });

  it("leaves out runtime folders, the login quarantine, skills and temp files", async () => {
    const L = layout();
    createMasterKey(L.keyPath);
    const one = await start(L);
    const f = await createFamily(one.app);
    for (const [rel, text] of [
      ["runtimes/conn-1/user-1/config/session.json", "RUNTIME-STATE"],
      ["runtimes/logins/login-1/codex-home/auth.json", "LOGIN-TOKENS"],
      ["runtimes/.quarantine/login-x/auth.json", "QUARANTINED"],
      ["skills/selftest/index.js", "SKILL-CODE"],
      ["files/u1/c1/kept.txt", "KEPT"],
    ] as const) {
      fs.mkdirSync(path.dirname(path.join(L.dataDir, rel)), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(L.dataDir, rel), text, { mode: 0o600 });
    }
    const id = await backupNow(one.app, f.cookies.admin);
    const rels = walk(path.join(L.backupDir, id)).map((x) => path.relative(path.join(L.backupDir, id), x));
    expect(rels.filter((r) => fs.statSync(path.join(L.backupDir, id, r)).isFile()).sort()).toEqual(
      [DB_FILE, MANIFEST_FILE, "files/u1/c1/kept.txt"].sort(),
    );
    const all = Buffer.concat(
      walk(path.join(L.backupDir, id))
        .filter((x) => fs.statSync(x).isFile())
        .map((x) => fs.readFileSync(x)),
    );
    for (const s of ["RUNTIME-STATE", "LOGIN-TOKENS", "QUARANTINED", "SKILL-CODE"])
      expect(all.includes(s), s).toBe(false);
  });

  it("owner-only permissions: folder 700, every backup folder 700, every file 600 — a loose folder is tightened", async () => {
    const L = layout();
    createMasterKey(L.keyPath);
    fs.mkdirSync(L.backupDir, { mode: 0o755 });
    fs.chmodSync(L.backupDir, 0o755);
    const one = await start(L);
    const f = await createFamily(one.app);
    fs.mkdirSync(path.join(L.dataDir, "files", "u", "c"), { recursive: true });
    fs.writeFileSync(path.join(L.dataDir, "files", "u", "c", "a.bin"), "a", { mode: 0o644 });
    fs.chmodSync(path.join(L.dataDir, "files", "u", "c", "a.bin"), 0o644);
    const id = await backupNow(one.app, f.cookies.admin);
    expect(fs.statSync(L.backupDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(L.backupDir, id)).mode & 0o777).toBe(0o700);
    const entries = walk(path.join(L.backupDir, id));
    expect(entries.length).toBeGreaterThan(4);
    for (const p of entries) {
      const st = fs.statSync(p);
      expect(st.mode & 0o777, p).toBe(st.isDirectory() ? 0o700 : 0o600);
    }
  });
});

describe("consistent point in time (#37)", () => {
  it("a file write during the backup waits for it; the snapshot has rows and files of one moment", async () => {
    const L = layout();
    createMasterKey(L.keyPath);
    let during: (() => Promise<void>) | undefined;
    const one = await start({ ...L, backup: { afterDbSnapshot: async () => during?.() } });
    const f = await createFamily(one.app);
    const file = path.join(L.dataDir, "files", "u", "c", "late.txt");
    const settingsRow = (db: Database.Database) =>
      db.prepare("SELECT value FROM settings WHERE key = 'test.attachment'").get() as
        { value: string } | undefined;
    let writer: Promise<void> | undefined;
    let writerDone = false;
    during = async () => {
      during = undefined;
      // An attachment writer: its row and its file, together, inside the lock — while the backup is copying.
      writer = one.app.fileWrites.write(async () => {
        one.storage.settings.set("test.attachment", "late.txt");
        await new Promise((r) => setTimeout(r, 5));
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, "LATE", { mode: 0o600 });
      });
      void writer.then(() => (writerDone = true));
      // A database-only write meanwhile (not locked): after the snapshot, so not in it.
      one.storage.settings.set("test.db_only", "after-snapshot");
      await new Promise((r) => setTimeout(r, 50));
      expect(writerDone).toBe(false);
    };
    const first = await backupNow(one.app, f.cookies.admin);
    await writer;
    expect(writerDone).toBe(true);
    const snap = (id: string) => new Database(path.join(L.backupDir, id, DB_FILE), { readonly: true });
    const a = snap(first);
    expect(settingsRow(a)).toBeUndefined();
    expect(a.prepare("SELECT 1 FROM settings WHERE key = 'test.db_only'").get()).toBeUndefined();
    a.close();
    expect(fs.existsSync(path.join(L.backupDir, first, "files", "u", "c", "late.txt"))).toBe(false);
    // The next backup has both halves.
    const second = await backupNow(one.app, f.cookies.admin);
    const b = snap(second);
    expect(settingsRow(b)?.value).toBe("late.txt");
    b.close();
    expect(fs.readFileSync(path.join(L.backupDir, second, "files", "u", "c", "late.txt"), "utf8")).toBe(
      "LATE",
    );
  });

  it("the lock: writers run together, a backup waits for them and lets none in until it is done", async () => {
    const lock = new FileWriteLock();
    const order: string[] = [];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const w1 = lock.write(async () => (order.push("w1+"), await sleep(20), order.push("w1-")));
    const w2 = lock.write(async () => (order.push("w2+"), await sleep(10), order.push("w2-")));
    const ex = lock.exclusive(async () => (order.push("b+"), await sleep(20), order.push("b-")));
    await sleep(1);
    const w3 = lock.write(async () => order.push("w3"));
    await Promise.all([w1, w2, ex, w3]);
    expect(order).toEqual(["w1+", "w2+", "w2-", "w1-", "b+", "b-", "w3"]);
  });
});

describe("retention: 7 days (#37 완료 기준)", () => {
  it("backups older than 7 days are deleted; a deleted conversation ends up in no backup", async () => {
    const L = layout();
    createMasterKey(L.keyPath);
    // 03:30 Seoul on 2026-11-12.
    let clock = Date.UTC(2026, 10, 11, 18, 30);
    const one = await start({ ...L, backup: { now: () => clock } });
    const f = await createFamily(one.app);
    const conv = one.app.conversations!.create(f.users.owner.id, { title: "곧 지울 대화" });
    one.app.conversations!.append(conv.id, {
      role: "user",
      parts: [{ type: "text", text: "DELETE-ME-37-UNIQUE" }],
    });
    const holders = () =>
      fs
        .readdirSync(L.backupDir)
        .filter((id) => fs.readFileSync(path.join(L.backupDir, id, DB_FILE)).includes("DELETE-ME-37-UNIQUE"));
    const ids: string[] = [];
    for (let day = 0; day <= 9; day++) {
      if (day === 2) {
        // Deleted on day 1 evening (after that day's backup).
        const r = await send(one.app, f.cookies.owner, "DELETE", `/api/conversations/${conv.id}`);
        expect(r.statusCode).toBeLessThan(300);
      }
      ids.push(await backupNow(one.app, f.cookies.admin));
      const listed = BackupsResponse.parse(
        (await send(one.app, f.cookies.admin, "GET", "/api/admin/backups")).json(),
      ).items.map((i) => i.id);
      // Exactly the last 7 days' backups.
      expect(listed).toEqual(ids.slice(Math.max(0, day - 6)).reverse());
      expect(fs.readdirSync(L.backupDir).sort()).toEqual([...listed].sort());
      // Days 0 and 1 hold it until they age out (day 1's on day 8); later ones never did (VACUUM INTO keeps no
      // freed pages).
      expect(holders().sort(), `day ${day}`).toEqual(ids.slice(Math.max(0, day - 6), 2).sort());
      clock += DAY;
    }
    expect(holders()).toEqual([]);
  });

  it("expires every backup older than 7 days — the newest and damaged ones too; other folders are left", () => {
    const dir = tmp();
    const make = (id: string, createdAt: number, valid = true) => {
      fs.mkdirSync(path.join(dir, id), { mode: 0o700 });
      if (valid)
        fs.writeFileSync(
          path.join(dir, id, MANIFEST_FILE),
          JSON.stringify({
            format: 1,
            id,
            createdAt,
            schema: { migrations: 1, lastMigrationAt: 1 },
            db: { file: DB_FILE, bytes: 1, sha256: "0".repeat(64) },
            files: [],
            skipped: 0,
            keyCheck: "v1:x",
          }),
        );
    };
    const t0 = Date.UTC(2026, 0, 1);
    make("20260101-000000Z-aaaaaa", t0);
    make("20260102-000000Z-bbbbbb", t0 + DAY);
    make("20260103-000000Z-cccccc", t0 + 2 * DAY, false);
    fs.mkdirSync(path.join(dir, "not-a-backup"));
    make("20260125-000000Z-dddddd", t0 + 24 * DAY);
    expect(pruneBackups(dir, t0 + 30 * DAY)).toBe(3);
    expect(fs.readdirSync(dir).sort()).toEqual(["20260125-000000Z-dddddd", "not-a-backup"]);
    expect(pruneBackups(dir, t0 + 31 * DAY)).toBe(1);
    expect(fs.readdirSync(dir)).toEqual(["not-a-backup"]);
  });
});

describe("schedule and admin routes (#37)", () => {
  it("daily at 03:30 Asia/Seoul", () => {
    // 03:29 KST = 18:29 UTC the day before.
    expect(nextRunAt(Date.UTC(2026, 10, 11, 18, 29, 10))).toBe(Date.UTC(2026, 10, 11, 18, 30));
    expect(nextRunAt(Date.UTC(2026, 10, 11, 18, 30))).toBe(Date.UTC(2026, 10, 12, 18, 30));
    expect(nextRunAt(Date.UTC(2026, 10, 11, 18, 31))).toBe(Date.UTC(2026, 10, 12, 18, 30));
    expect(nextRunAt(Date.UTC(2026, 10, 11, 3, 0))).toBe(Date.UTC(2026, 10, 11, 18, 30));
  });

  it("the scheduler runs the backup at its time, and a missed one soon after start; close stops it", async () => {
    const L = layout();
    createMasterKey(L.keyPath);
    const realStart = Date.now();
    // 500 ms before 03:30 Seoul — room for the start itself (migrations, routes), which takes about 50 ms.
    const base = Date.UTC(2026, 10, 11, 18, 30) - 500;
    const one = await start({
      ...L,
      backup: { schedule: true, now: () => base + (Date.now() - realStart), catchUpMs: 24 * 3600_000 },
    });
    await one.app.ready();
    expect(one.app.backups!.status().nextRunAt).toBe(Date.UTC(2026, 10, 11, 18, 30));
    for (let i = 0; i < 200 && one.app.backups!.list().length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(one.app.backups!.list()).toHaveLength(1);
    for (let i = 0; i < 100 && one.app.backups!.status().running; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(one.app.backups!.status()).toMatchObject({
      nextRunAt: Date.UTC(2026, 10, 12, 18, 30),
      last: { code: "backup_ok" },
    });
    const logged = one.log.records().filter((r) => r.msg === "backup.finished");
    expect(logged.map((r) => [r.backupTrigger, r.backupCode])).toEqual([["scheduled", "backup_ok"]]);
    await one.close();
    expect(one.app.backups!.status().nextRunAt).toBeNull();
    expect((await one.app.backups!.run("manual")).ok).toBe(false);

    // Catch-up: no backup in the last day → one shortly after start.
    const M = layout();
    createMasterKey(M.keyPath);
    const two = await start({ ...M, backup: { schedule: true, catchUpMs: 20 } });
    await two.app.ready();
    for (let i = 0; i < 200 && two.app.backups!.list().length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(two.app.backups!.list()).toHaveLength(1);
  });

  it("list and 지금 백업 for the admin; a second one while running is 409; fixed codes in the log", async () => {
    const L = layout();
    createMasterKey(L.keyPath);
    let release: (() => void) | undefined;
    const one = await start({
      ...L,
      backup: { afterDbSnapshot: () => new Promise<void>((r) => (release = r)) },
    });
    const f = await createFamily(one.app);
    const empty = BackupsResponse.parse(
      (await send(one.app, f.cookies.admin, "GET", "/api/admin/backups")).json(),
    );
    expect(empty).toMatchObject({
      available: true,
      running: false,
      items: [],
      schedule: { time: "03:30", timeZone: "Asia/Seoul", retentionDays: 7 },
      schemaMigrations: codeMigrations().length,
    });
    const first = send(one.app, f.cookies.admin, "POST", "/api/admin/backups");
    for (let i = 0; i < 100 && !release; i++) await new Promise((r) => setTimeout(r, 5));
    const busy = await send(one.app, f.cookies.admin, "POST", "/api/admin/backups");
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({ error: "backup_running" });
    expect(
      BackupsResponse.parse((await send(one.app, f.cookies.admin, "GET", "/api/admin/backups")).json())
        .running,
    ).toBe(true);
    release!();
    expect((await first).statusCode).toBe(201);
    const after = BackupsResponse.parse(
      (await send(one.app, f.cookies.admin, "GET", "/api/admin/backups")).json(),
    );
    expect(after.items).toHaveLength(1);
    expect(after.items[0]).toMatchObject({ valid: true, migrations: codeMigrations().length });
    expect(after.last?.code).toBe("backup_ok");
    // Family: 403 (the full matrix is permissions.test.ts).
    expect((await send(one.app, f.cookies.owner, "GET", "/api/admin/backups")).statusCode).toBe(403);
    expect((await send(one.app, f.cookies.owner, "POST", "/api/admin/backups")).statusCode).toBe(403);
    const recs = one.log.records().filter((r) => String(r.msg).startsWith("backup."));
    expect(recs.map((r) => [r.msg, r.backupTrigger, r.backupCode])).toEqual([
      ["backup.finished", "manual", "backup_ok"],
    ]);
    for (const r of recs) expect(JSON.stringify(r)).not.toContain(L.root);
    expect(new Set(BACKUP_CODES)).toEqual(LOGGABLE_BACKUP_CODES);
  });
});

// ---- Review round 1 (#37 PR #99) ----

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "backup", "child.ts");
const CLI = path.join(REPO_ROOT, "apps", "server", "src", "cli", "restore.ts");

/** A separate Node process running TypeScript (the real lock, the real CLI). */
function spawnTs(file: string, args: string[], env: Record<string, string> = {}, node: string[] = []) {
  const child = spawn(
    process.execPath,
    [...node, "--conditions=development", "--import", "tsx", file, ...args],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += String(d)));
  child.stderr.on("data", (d) => (err += String(d)));
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) =>
    child.on("exit", (code, signal) => r({ code, signal })),
  );
  closers.push(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  });
  return {
    child,
    exited,
    out: () => out,
    err: () => err,
    waitFor: async (text: string) => {
      for (let i = 0; i < 1500 && !out.includes(text); i++) {
        if (child.exitCode !== null) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      if (!out.includes(text)) throw new Error(`child never printed ${text}: ${out} ${err}`);
    },
  };
}
const tryLock = async (dataDir: string, kind = "server") => {
  const c = spawnTs(CHILD, ["try-lock", dataDir, kind]);
  await c.exited;
  return c.out().trim();
};

describe(
  "data folder lock across processes (#37 review P1, round 2: kernel lock)",
  { timeout: 60_000 },
  () => {
    it("a second server refuses to start, a restore refuses, and kill -9 releases the lock", async () => {
      const L = layout();
      createMasterKey(L.keyPath);
      const holder = spawnTs(CHILD, ["lock", L.dataDir, "server"]);
      await holder.waitFor("locked");
      // Another process: refused, whatever it is (the holder's role comes from the side file).
      expect(await tryLock(L.dataDir, "server")).toBe("held:server");
      expect(await tryLock(L.dataDir, "restore")).toBe("held:server");
      // This process starting a server: refused before the database is opened.
      const cfg = loadConfig({ NODE_ENV: "test", DATA_DIR: L.dataDir, MASTER_KEY_PATH: L.keyPath });
      expect(() => openServerStorage(cfg)).toThrow(DataLockHeld);
      expect(fs.existsSync(path.join(L.dataDir, DB_FILE))).toBe(false);
      // A restore: server_running, nothing written.
      const backup = await (async () => {
        const M = layout();
        createMasterKey(M.keyPath);
        const one = await start(M);
        const f = await createFamily(one.app);
        const id = await backupNow(one.app, f.cookies.admin);
        await one.close();
        return { dir: path.join(M.backupDir, id), key: loadMasterKey(M.keyPath) };
      })();
      expect(
        restoreCode(() => restoreBackup({ backup: backup.dir, target: L.dataDir, key: backup.key })),
      ).toBe("server_running");
      expect(fs.existsSync(path.join(L.dataDir, DB_FILE))).toBe(false);
      // kill -9: the system drops the holder's lock — no stale-lock logic involved.
      holder.child.kill("SIGKILL");
      await holder.exited;
      expect(await tryLock(L.dataDir)).toBe("acquired");
      const opened = openServerStorage(cfg);
      expect(await tryLock(L.dataDir)).toBe("held:server");
      opened.storage.db.$client.close();
      opened.release();
      expect(await tryLock(L.dataDir)).toBe("acquired");
      // The lock file is owner-only and never a symlink.
      expect(fs.statSync(dataLockPath(L.dataDir)).mode & 0o777).toBe(0o600);
      const other = path.join(tmp(), "data");
      fs.symlinkSync(path.join(tmp(), "elsewhere.db"), dataLockPath(other));
      expect(() => acquireDataLock(other, "server")).toThrow(/regular file/);
    });

    it("a holder that drops its handle keeps the lock (garbage collection never releases it)", async () => {
      const dir = path.join(tmp(), "data");
      const holder = spawnTs(CHILD, ["lock-drop", dir], {}, ["--expose-gc"]);
      await holder.waitFor("locked");
      await new Promise((r) => setTimeout(r, 100));
      expect(await tryLock(dir)).toBe("held:server");
    });

    it("contenders racing in a loop never hold it together", async () => {
      const dir = path.join(tmp(), "data");
      const sentinel = path.join(path.dirname(dir), "inside");
      const racers = [0, 1, 2].map(() => spawnTs(CHILD, ["race", dir, sentinel, "150"]));
      const results = await Promise.all(racers.map(async (r) => (await r.exited, r.out().trim())));
      for (const r of racers) expect(r.err()).toBe("");
      const counts = results.map((o) => {
        expect(o).not.toContain("OVERLAP");
        return Number(/acquired=(\d+)/.exec(o)![1]);
      });
      // Every racer got it sometimes; the total proves the loop really contended.
      expect(counts.every((n) => n > 0)).toBe(true);
    });

    it("a symlinked DATA_DIR shares the real folder's lock and journal", async () => {
      const root = tmp();
      const real = path.join(root, "data");
      fs.mkdirSync(real, { mode: 0o700 });
      const alias = path.join(root, "alias");
      fs.symlinkSync(real, alias);
      expect(dataLockPath(alias)).toBe(dataLockPath(real));
      expect(restoreJournalPath(alias)).toBe(restoreJournalPath(real));
      const holder = spawnTs(CHILD, ["lock", alias, "server"]);
      await holder.waitFor("locked");
      expect(await tryLock(real, "restore")).toBe("held:server");
      expect(() => acquireDataLock(real, "restore")).toThrow(DataLockHeld);
      holder.child.kill("SIGKILL");
      await holder.exited;
      const viaReal = acquireDataLock(real, "server");
      expect(await tryLock(alias, "restore")).toBe("held:server");
      viaReal.release();
      // A restore through the alias replaces the real folder; the alias stays a link to it.
      const M = layout();
      createMasterKey(M.keyPath);
      const one = await start(M);
      const f = await createFamily(one.app);
      const id = await backupNow(one.app, f.cookies.admin);
      await one.close();
      fs.writeFileSync(path.join(real, "marker"), "old");
      restoreBackup({ backup: path.join(M.backupDir, id), target: alias, key: loadMasterKey(M.keyPath) });
      expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
      expect(fs.existsSync(path.join(real, DB_FILE))).toBe(true);
      expect(fs.existsSync(path.join(real, "marker"))).toBe(false);
      expect(fs.readdirSync(root).filter((n) => n.startsWith("data.before-restore-"))).toHaveLength(1);
    });
  },
);

describe(
  "the swap survives failures and kills (#37 review P1, round 2: journal phases)",
  { timeout: 60_000 },
  () => {
    async function prepared() {
      const L = layout();
      createMasterKey(L.keyPath);
      const one = await start(L);
      const f = await createFamily(one.app);
      // An attachment in the backup: the candidate's manifest covers the file stores too.
      const attachment = path.join(L.dataDir, "files", "u1", "c1", "a.txt");
      fs.mkdirSync(path.dirname(attachment), { recursive: true, mode: 0o700 });
      fs.writeFileSync(attachment, "ATTACHED", { mode: 0o600 });
      const id = await backupNow(one.app, f.cookies.admin);
      // The live data folder the restore replaces: recognisable old content (a 5th user, a marker file).
      one.app.users!.create({ email: "old-only@x", name: "old", role: "member", passwordHash: null });
      await one.close();
      fs.writeFileSync(path.join(L.dataDir, "marker"), "old");
      return { ...L, backup: path.join(L.backupDir, id), key: loadMasterKey(L.keyPath) };
    }
    const leftovers = (root: string) =>
      fs.readdirSync(root).filter((n) => n.includes(".restore-") || n.includes("restore-journal"));
    const asides = (root: string) => fs.readdirSync(root).filter((n) => n.startsWith("data.before-restore-"));
    const startServer = (t: { dataDir: string; keyPath: string }) =>
      openServerStorage(loadConfig({ NODE_ENV: "test", DATA_DIR: t.dataDir, MASTER_KEY_PATH: t.keyPath }));
    const users = (o: ReturnType<typeof startServer>) =>
      (o.storage.db.$client.prepare("SELECT count(*) AS n FROM users").get() as { n: number }).n;
    const expectOld = (t: { root: string; dataDir: string; keyPath: string }) => {
      expect(fs.readFileSync(path.join(t.dataDir, "marker"), "utf8")).toBe("old");
      const o = startServer(t);
      try {
        expect(o.recovered).toBe("none");
        expect(users(o)).toBe(5);
      } finally {
        o.storage.db.$client.close();
        o.release();
      }
      expect(leftovers(t.root)).toEqual([]);
      expect(asides(t.root)).toEqual([]);
    };
    const eio = () => Object.assign(new Error("EIO"), { code: "EIO" });

    it("EIO on the second rename: the old folder is put back, nothing else is left", async () => {
      const t = await prepared();
      let renames = 0;
      expect(() =>
        restoreBackup({
          backup: t.backup,
          target: t.dataDir,
          key: t.key,
          hooks: {
            rename: (from, to) => {
              if (++renames === 2) throw eio();
              fs.renameSync(from, to);
            },
          },
        }),
      ).toThrow("EIO");
      expectOld(t);
    });

    it("EIO on the second rename, then the clean-up dies half-way: a restart keeps the original data", async () => {
      const t = await prepared();
      let renames = 0;
      expect(() =>
        restoreBackup({
          backup: t.backup,
          target: t.dataDir,
          key: t.key,
          hooks: {
            rename: (from, to) => {
              if (++renames === 2) throw eio();
              fs.renameSync(from, to);
            },
            // Deletes the staged database, then fails: a half-deleted candidate stays behind.
            rm: (p) => {
              fs.rmSync(path.join(p, DB_FILE));
              throw eio();
            },
          },
        }),
      ).toThrow("EIO");
      expect(JSON.parse(fs.readFileSync(restoreJournalPath(t.dataDir), "utf8")).phase).toBe("rolling_back");
      const o = startServer(t);
      try {
        expect(o.recovered).toBe("rolled_back");
        expect(users(o)).toBe(5);
      } finally {
        o.storage.db.$client.close();
        o.release();
      }
      expect(fs.readFileSync(path.join(t.dataDir, "marker"), "utf8")).toBe("old");
      expect(leftovers(t.root)).toEqual([]);
    });

    it("the move back fails too: the journal stays rolling_back and the next start moves the old folder back", async () => {
      const t = await prepared();
      let renames = 0;
      expect(() =>
        restoreBackup({
          backup: t.backup,
          target: t.dataDir,
          key: t.key,
          hooks: {
            rename: (from, to) => {
              if (++renames >= 2) throw eio();
              fs.renameSync(from, to);
            },
          },
        }),
      ).toThrow("EIO");
      expect(fs.existsSync(t.dataDir)).toBe(false);
      const o = startServer(t);
      try {
        expect(o.recovered).toBe("rolled_back");
        expect(users(o)).toBe(5);
      } finally {
        o.storage.db.$client.close();
        o.release();
      }
      expect(leftovers(t.root)).toEqual([]);
    });

    it(`killed after "prepared" (nothing moved yet): the next start rolls back`, async () => {
      const t = await prepared();
      const c = spawnTs(CHILD, ["restore", t.backup, t.dataDir, t.keyPath, "prepared"]);
      expect((await c.exited).signal).toBe("SIGKILL");
      expect(fs.existsSync(restoreJournalPath(t.dataDir))).toBe(true);
      const o = startServer(t);
      expect(o.recovered).toBe("rolled_back");
      o.storage.db.$client.close();
      o.release();
      expectOld(t);
    });

    for (const step of ["old_moved", "swapped"] as const)
      it(`killed after "${step}": the next server start finishes the restore`, async () => {
        const t = await prepared();
        const c = spawnTs(CHILD, ["restore", t.backup, t.dataDir, t.keyPath, step]);
        expect((await c.exited).signal).toBe("SIGKILL");
        expect(fs.existsSync(restoreJournalPath(t.dataDir))).toBe(true);
        if (step === "old_moved") expect(fs.existsSync(t.dataDir)).toBe(false);
        const o = startServer(t);
        try {
          expect(o.recovered).toBe("completed");
          expect(users(o)).toBe(4);
        } finally {
          o.storage.db.$client.close();
          o.release();
        }
        expect(fs.existsSync(path.join(t.dataDir, "marker"))).toBe(false);
        expect(fs.existsSync(path.join(t.dataDir, CANDIDATE_ID_FILE))).toBe(false);
        expect(fs.existsSync(path.join(t.root, asides(t.root)[0]!, OLD_ID_FILE))).toBe(false);
        expect(asides(t.root)).toHaveLength(1);
        expect(fs.readFileSync(path.join(t.root, asides(t.root)[0]!, "marker"), "utf8")).toBe("old");
        expect(leftovers(t.root)).toEqual([]);
      });

    it("killed after old_moved with a damaged candidate: rolled back, never promoted", async () => {
      const t = await prepared();
      const c = spawnTs(CHILD, ["restore", t.backup, t.dataDir, t.keyPath, "old_moved"]);
      await c.exited;
      const j = JSON.parse(fs.readFileSync(restoreJournalPath(t.dataDir), "utf8")) as { staging: string };
      fs.appendFileSync(path.join(j.staging, DB_FILE), "x"); // no longer what its marker says
      const o = startServer(t);
      expect(o.recovered).toBe("rolled_back");
      o.storage.db.$client.close();
      o.release();
      expectOld(t);
    });

    it("killed after old_moved, then pnpm db:migrate: it finishes the restore instead of creating a new database", async () => {
      const t = await prepared();
      const c = spawnTs(CHILD, ["restore", t.backup, t.dataDir, t.keyPath, "old_moved"]);
      await c.exited;
      const m = spawnTs(path.join(REPO_ROOT, "apps", "server", "src", "cli", "migrate.ts"), [], {
        NODE_ENV: "development",
        DATA_DIR: t.dataDir,
        MASTER_KEY_PATH: t.keyPath,
        BACKUP_DIR: t.backupDir,
      });
      expect((await m.exited).code, m.err()).toBe(0);
      expect(m.out()).toContain("interrupted restore completed");
      const o = startServer(t);
      try {
        expect(o.recovered).toBe("none");
        expect(users(o)).toBe(4);
      } finally {
        o.storage.db.$client.close();
        o.release();
      }
    });

    // Round 3: a kill at every boundary — after each rename (before the journal records it), after each journal
    // phase, and after each clean-up step. Each start must end with all old data or all new data, nothing lost.
    const BOUNDARIES = [
      ["prepared", "old"],
      ["rename1", "old"],
      ["old_moved", "new"],
      ["rename2", "new"],
      ["swapped", "new"],
      ["done", "new"],
      ["journal_removed", "new"],
      ["cleaned", "new"],
    ] as const;
    for (const [at, expected] of BOUNDARIES)
      it(`killed at "${at}": the next start ends with all ${expected} data`, async () => {
        const t = await prepared();
        const c = spawnTs(CHILD, ["restore", t.backup, t.dataDir, t.keyPath, at]);
        expect((await c.exited).signal).toBe("SIGKILL");
        const o = startServer(t);
        try {
          expect(users(o)).toBe(expected === "old" ? 5 : 4);
        } finally {
          o.storage.db.$client.close();
          o.release();
        }
        expect(fs.existsSync(restoreJournalPath(t.dataDir))).toBe(false);
        expect(fs.existsSync(path.join(t.dataDir, CANDIDATE_ID_FILE))).toBe(false);
        expect(fs.existsSync(path.join(t.dataDir, OLD_ID_FILE))).toBe(false);
        if (expected === "old") {
          expect(fs.readFileSync(path.join(t.dataDir, "marker"), "utf8")).toBe("old");
          expect(asides(t.root)).toEqual([]);
        } else {
          expect(fs.readFileSync(path.join(t.dataDir, "files", "u1", "c1", "a.txt"), "utf8")).toBe(
            "ATTACHED",
          );
          // The old folder is kept, whole.
          expect(fs.readFileSync(path.join(t.root, asides(t.root)[0]!, "marker"), "utf8")).toBe("old");
        }
        expect(leftovers(t.root)).toEqual([]);
        // A second start changes nothing.
        const again = startServer(t);
        expect(again.recovered).toBe("none");
        again.storage.db.$client.close();
        again.release();
      });

    it("killed right after the second rename and the restored database zeroed: back to the old data, never 0 users", async () => {
      const t = await prepared();
      const c = spawnTs(CHILD, ["restore", t.backup, t.dataDir, t.keyPath, "rename2"]);
      await c.exited;
      fs.truncateSync(path.join(t.dataDir, DB_FILE), 0);
      const o = startServer(t);
      try {
        expect(o.recovered).toBe("rolled_back");
        expect(users(o)).toBe(5);
      } finally {
        o.storage.db.$client.close();
        o.release();
      }
      expect(fs.readFileSync(path.join(t.dataDir, "marker"), "utf8")).toBe("old");
      // The damaged candidate is moved aside (it was ours), not deleted and not used.
      const rejected = fs.readdirSync(t.root).filter((n) => n.startsWith("data.restore-rejected-"));
      expect(rejected).toHaveLength(1);
      expect(fs.statSync(path.join(t.root, rejected[0]!, DB_FILE)).size).toBe(0);
    });

    for (const damage of ["deleted", "corrupted", "added"] as const)
      it(`killed after old_moved with a staging file ${damage}: rolled back, never promoted`, async () => {
        const t = await prepared();
        const c = spawnTs(CHILD, ["restore", t.backup, t.dataDir, t.keyPath, "old_moved"]);
        await c.exited;
        const j = JSON.parse(fs.readFileSync(restoreJournalPath(t.dataDir), "utf8")) as { staging: string };
        const file = path.join(j.staging, "files", "u1", "c1", "a.txt");
        if (damage === "deleted") fs.rmSync(file);
        else if (damage === "corrupted") fs.writeFileSync(file, "ATTACHEX");
        // Something the manifest does not list: not the candidate either.
        else fs.writeFileSync(path.join(j.staging, "files", "u1", "c1", "extra.txt"), "?");
        const o = startServer(t);
        expect(o.recovered).toBe("rolled_back");
        o.storage.db.$client.close();
        o.release();
        expectOld(t);
      });

    it("a data folder recovery cannot account for: journal kept, both folders untouched, start refused", async () => {
      const t = await prepared();
      const c = spawnTs(CHILD, ["restore", t.backup, t.dataDir, t.keyPath, "rename1"]);
      await c.exited;
      // Someone put other data at DATA_DIR meanwhile.
      fs.mkdirSync(t.dataDir, { mode: 0o700 });
      fs.writeFileSync(path.join(t.dataDir, DB_FILE), "someone else's");
      // (the lock database's own files aside)
      const entries = () =>
        fs
          .readdirSync(t.root)
          .filter((n) => !n.startsWith(".data.lock"))
          .sort();
      const before = entries();
      const journalBefore = fs.readFileSync(restoreJournalPath(t.dataDir), "utf8");
      expect(() => startServer(t)).toThrow(/restore_unresolved/);
      expect(entries()).toEqual(before);
      expect(fs.readFileSync(restoreJournalPath(t.dataDir), "utf8")).toBe(journalBefore);
      expect(fs.readFileSync(path.join(t.dataDir, DB_FILE), "utf8")).toBe("someone else's");
      expect(fs.existsSync(restoreJournalPath(t.dataDir))).toBe(true);
      // The old folder changed too: still refused (never rolled back to a folder that is not provably the old one).
      fs.rmSync(t.dataDir, { recursive: true });
      const old = fs.readdirSync(t.root).find((n) => n.startsWith("data.before-restore-"))!;
      fs.appendFileSync(path.join(t.root, old, DB_FILE), "x");
      fs.rmSync(
        (JSON.parse(fs.readFileSync(restoreJournalPath(t.dataDir), "utf8")) as { staging: string }).staging,
        { recursive: true },
      );
      expect(() => startServer(t)).toThrow(/restore_unresolved/);
      expect(fs.existsSync(path.join(t.root, old))).toBe(true);
      expect(fs.existsSync(restoreJournalPath(t.dataDir))).toBe(true);
    });

    // Round 4: the old database's WAL.
    const commitInWal = async (dataDir: string) => {
      const c = spawnTs(CHILD, ["commit-die", dataDir]);
      expect((await c.exited).signal).toBe("SIGKILL");
      expect(fs.statSync(path.join(dataDir, `${DB_FILE}-wal`)).size).toBeGreaterThan(0);
    };
    const countUsers = (dir: string) => {
      const db = new Database(path.join(dir, DB_FILE), { readonly: true, fileMustExist: true });
      try {
        return (db.prepare("SELECT count(*) AS n FROM users").get() as { n: number }).n;
      } finally {
        db.close();
      }
    };

    it("a normal restore checkpoints the old database first: the folder kept aside holds every committed row", async () => {
      const t = await prepared();
      await commitInWal(t.dataDir);
      const r = restoreBackup({ backup: t.backup, target: t.dataDir, key: t.key });
      expect(fs.existsSync(`${r.previous!}/${DB_FILE}-wal`)).toBe(false);
      expect(fs.existsSync(`${r.previous!}/${DB_FILE}-shm`)).toBe(false);
      // Its main file alone has the WAL-only user.
      expect(countUsers(r.previous!)).toBe(6);
    });

    it("the old WAL lost after a kill: the checkpoint already saved its rows — rolled back with all 6 users", async () => {
      const t = await prepared();
      await commitInWal(t.dataDir);
      const c = spawnTs(CHILD, ["restore", t.backup, t.dataDir, t.keyPath, "rename1"]);
      await c.exited;
      const old = path.join(t.root, asides(t.root)[0]!);
      fs.rmSync(path.join(old, `${DB_FILE}-wal`), { force: true });
      const o = startServer(t);
      try {
        expect(o.recovered).toBe("rolled_back");
        expect(users(o)).toBe(6);
      } finally {
        o.storage.db.$client.close();
        o.release();
      }
    });

    it("a -wal that appeared in the old folder after it was identified: not the old database — refused, nothing moved", async () => {
      const t = await prepared();
      await commitInWal(t.dataDir);
      const c = spawnTs(CHILD, ["restore", t.backup, t.dataDir, t.keyPath, "rename1"]);
      await c.exited;
      const old = path.join(t.root, asides(t.root)[0]!);
      fs.writeFileSync(path.join(old, `${DB_FILE}-wal`), "not the WAL that was there");
      const journalBefore = fs.readFileSync(restoreJournalPath(t.dataDir), "utf8");
      expect(() => startServer(t)).toThrow(/restore_unresolved/);
      expect(fs.readFileSync(restoreJournalPath(t.dataDir), "utf8")).toBe(journalBefore);
      expect(fs.existsSync(old)).toBe(true);
      expect(fs.existsSync(t.dataDir)).toBe(false);
    });

    it("another process still reading the old database: old_unsettled, nothing changed", async () => {
      const t = await prepared();
      await commitInWal(t.dataDir);
      const reader = spawnTs(CHILD, ["hold-reader", t.dataDir]);
      await reader.waitFor("reading");
      expect(restoreCode(() => restoreBackup({ backup: t.backup, target: t.dataDir, key: t.key }))).toBe(
        "old_unsettled",
      );
      reader.child.kill("SIGKILL");
      await reader.exited;
      expect(fs.statSync(path.join(t.dataDir, `${DB_FILE}-wal`)).size).toBeGreaterThan(0);
      expect(leftovers(t.root)).toEqual([]);
      expect(asides(t.root)).toEqual([]);
      expect(fs.existsSync(path.join(t.dataDir, OLD_ID_FILE))).toBe(false);
    });

    for (const code of ["EIO", "ENOSPC"] as const)
      it(`fsync of a copied file fails with ${code}: the restore fails before the swap, the old data stays`, async () => {
        const t = await prepared();
        const fsynced: string[] = [];
        expect(
          restoreCode(() =>
            restoreBackup({
              backup: t.backup,
              target: t.dataDir,
              key: t.key,
              hooks: {
                fsync: (p) => {
                  fsynced.push(p);
                  if (p.endsWith(path.join("files", "u1", "c1", "a.txt")))
                    throw Object.assign(new Error(code), { code });
                },
              },
            }),
          ),
        ).toBe("not_durable");
        expect(fsynced.some((p) => p.endsWith("a.txt"))).toBe(true);
        expectOld(t);
      });

    // Round 5: a one-time error after the candidate is in place, before `done` is durable.
    const afterSwapFault = (
      which: "parent_fsync" | "swapped_journal" | "done_journal",
      alsoFail?: "move_back",
    ) => {
      let renames = 0;
      let armed = false;
      let journalWrites = 0;
      let fired = false;
      return {
        rename: (from: string, to: string) => {
          if (alsoFail === "move_back" && fired && to.endsWith("/data")) throw eio();
          fs.renameSync(from, to);
          if (++renames === 2) armed = true;
        },
        fsync: (p: string) => {
          if (!armed || fired) return;
          const isJournal = p.endsWith(".restore-journal.json.tmp");
          if (isJournal) journalWrites++;
          const hit =
            which === "parent_fsync"
              ? !isJournal
              : which === "swapped_journal"
                ? isJournal && journalWrites === 1
                : isJournal && journalWrites === 2;
          if (hit) {
            fired = true;
            throw eio();
          }
        },
      };
    };
    const rejectedOf = (root: string) =>
      fs.readdirSync(root).filter((n) => n.startsWith("data.restore-rejected-"));

    for (const which of ["parent_fsync", "swapped_journal", "done_journal"] as const)
      it(`one-time EIO on the ${which} after the second rename: rolled back in place, never a silent swap`, async () => {
        const t = await prepared();
        const hooks = afterSwapFault(which);
        expect(() => restoreBackup({ backup: t.backup, target: t.dataDir, key: t.key, hooks })).toThrow(
          "EIO",
        );
        // The old data is active again, the candidate is aside, no journal.
        expect(fs.existsSync(restoreJournalPath(t.dataDir))).toBe(false);
        expect(rejectedOf(t.root)).toHaveLength(1);
        for (const r of rejectedOf(t.root)) fs.rmSync(path.join(t.root, r), { recursive: true });
        expectOld(t);
      });

    it("EIO after the second rename and the move back fails too: the journal stays and the next start rolls back", async () => {
      const t = await prepared();
      const hooks = afterSwapFault("parent_fsync", "move_back");
      expect(() => restoreBackup({ backup: t.backup, target: t.dataDir, key: t.key, hooks })).toThrow("EIO");
      const j = JSON.parse(fs.readFileSync(restoreJournalPath(t.dataDir), "utf8")) as { phase: string };
      expect(j.phase).toBe("rolling_back");
      const o = startServer(t);
      try {
        expect(o.recovered).toBe("rolled_back");
        expect(users(o)).toBe(5);
      } finally {
        o.storage.db.$client.close();
        o.release();
      }
      expect(fs.readFileSync(path.join(t.dataDir, "marker"), "utf8")).toBe("old");
      expect(fs.existsSync(restoreJournalPath(t.dataDir))).toBe(false);
    });

    it("after the second rename the parent folder is fsynced before the swapped journal", async () => {
      const t = await prepared();
      let renames = 0;
      const after: string[] = [];
      restoreBackup({
        backup: t.backup,
        target: t.dataDir,
        key: t.key,
        hooks: {
          rename: (from, to) => {
            fs.renameSync(from, to);
            renames++;
          },
          fsync: (p) => {
            if (renames === 2) after.push(p);
          },
        },
      });
      expect(after[0]).toBe(t.root);
      expect(after[1]).toMatch(/restore-journal\.json\.tmp$/);
    });

    it("the undo cannot put the old folder back (it vanished): the journal stays, nothing claims success", async () => {
      const t = await prepared();
      const hooks = afterSwapFault("parent_fsync");
      const moved = path.join(t.root, "elsewhere");
      const rename = hooks.rename;
      let n = 0;
      hooks.rename = (from, to) => {
        rename(from, to);
        // Right after the candidate is in place, the old folder disappears (another hand moved it).
        if (++n === 2) fs.renameSync(path.join(t.root, asides(t.root)[0]!), moved);
      };
      expect(() => restoreBackup({ backup: t.backup, target: t.dataDir, key: t.key, hooks })).toThrow("EIO");
      expect(fs.existsSync(restoreJournalPath(t.dataDir))).toBe(true);
      expect(() => startServer(t)).toThrow(/restore_unresolved/);
      expect(fs.existsSync(moved)).toBe(true);
    });

    // Round 6: the undo proves the old folder before moving it back (and again before the journal goes).
    for (const change of ["db", "id", "sidecar"] as const)
      it(`EIO after the second rename and the old folder's ${change} changed: nothing moved back, journal kept`, async () => {
        const t = await prepared();
        const hooks = afterSwapFault("parent_fsync");
        const rename = hooks.rename;
        let n = 0;
        let old = "";
        hooks.rename = (from, to) => {
          rename(from, to);
          if (++n !== 2) return;
          old = path.join(t.root, asides(t.root)[0]!);
          if (change === "db") fs.truncateSync(path.join(old, DB_FILE), 0);
          else if (change === "id") fs.writeFileSync(path.join(old, OLD_ID_FILE), "someone-else");
          else fs.writeFileSync(path.join(old, `${DB_FILE}-wal`), "a WAL that was not there");
        };
        expect(() => restoreBackup({ backup: t.backup, target: t.dataDir, key: t.key, hooks })).toThrow(
          "EIO",
        );
        // The unproven old folder stays where it is; the candidate stays at the target; journal and ids kept.
        expect(fs.existsSync(old)).toBe(true);
        expect(fs.existsSync(path.join(t.dataDir, CANDIDATE_ID_FILE))).toBe(true);
        expect(fs.existsSync(path.join(old, OLD_ID_FILE))).toBe(true);
        const j = JSON.parse(fs.readFileSync(restoreJournalPath(t.dataDir), "utf8")) as { phase: string };
        expect(j.phase).toBe("rolling_back");
        expect(rejectedOf(t.root)).toEqual([]);
        // The next start will not guess.
        expect(() => startServer(t)).toThrow(/restore_unresolved/);
        expect(fs.existsSync(old)).toBe(true);
      });

    it("the old folder changes right after it is moved back: the journal is not removed", async () => {
      const t = await prepared();
      const hooks = afterSwapFault("parent_fsync");
      const rename = hooks.rename;
      let n = 0;
      hooks.rename = (from, to) => {
        rename(from, to);
        // Renames: old aside, candidate in, candidate aside (undo), old back (undo) — then the folder changes.
        if (++n === 4) fs.truncateSync(path.join(t.dataDir, DB_FILE), 0);
      };
      expect(() => restoreBackup({ backup: t.backup, target: t.dataDir, key: t.key, hooks })).toThrow("EIO");
      expect(n).toBe(4);
      expect(fs.existsSync(restoreJournalPath(t.dataDir))).toBe(true);
      expect(() => startServer(t)).toThrow(/restore_unresolved/);
    });

    // Round 7: DATA_DIR is a symlink, and the kill leaves it dangling (its target was moved aside).
    for (const [at, expected] of [
      ["rename1", "rolled_back"],
      ["old_moved", "completed"],
    ] as const)
      it(`through alias → data, killed after ${at}: a restart via the alias ends like one via the real path`, async () => {
        const t = await prepared();
        const alias = path.join(t.root, "alias");
        fs.symlinkSync(t.dataDir, alias);
        const c = spawnTs(CHILD, ["restore", t.backup, alias, t.keyPath, at]);
        expect((await c.exited).signal).toBe("SIGKILL");
        // The link dangles now (data was moved aside) — it must still name the same lock and journal.
        expect(fs.existsSync(alias)).toBe(false);
        expect(dataLockPath(alias)).toBe(dataLockPath(t.dataDir));
        expect(restoreJournalPath(alias)).toBe(restoreJournalPath(t.dataDir));
        const o = startServer({ dataDir: alias, keyPath: t.keyPath });
        try {
          expect(o.recovered).toBe(expected);
          expect(users(o)).toBe(expected === "rolled_back" ? 5 : 4);
        } finally {
          o.storage.db.$client.close();
          o.release();
        }
        expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
        expect(fs.realpathSync(alias)).toBe(t.dataDir);
        expect(fs.existsSync(restoreJournalPath(t.dataDir))).toBe(false);
      });

    // Round 8: a case-insensitive volume (macOS APFS default): `Data` and `data` are one folder.
    for (const [at, expected] of [
      ["rename1", "rolled_back"],
      ["old_moved", "completed"],
    ] as const)
      it(`restore to …/Data with DATA_DIR …/data, killed after ${at}: same result as the same-case run`, async (ctx) => {
        const t = await prepared();
        if (!caseInsensitive(t.root)) return ctx.skip();
        const upper = path.join(t.root, "Data");
        // The on-disk spelling is used for the lock, the journal and its target.
        expect(realDataDir(upper)).toBe(t.dataDir);
        expect(dataLockPath(upper)).toBe(dataLockPath(t.dataDir));
        const c = spawnTs(CHILD, ["restore", t.backup, upper, t.keyPath, at]);
        expect((await c.exited).signal).toBe("SIGKILL");
        const j = JSON.parse(fs.readFileSync(restoreJournalPath(t.dataDir), "utf8")) as { target: string };
        expect(j.target).toBe(t.dataDir);
        const o = startServer(t);
        try {
          expect(o.recovered).toBe(expected);
          expect(users(o)).toBe(expected === "rolled_back" ? 5 : 4);
        } finally {
          o.storage.db.$client.close();
          o.release();
        }
        expect(fs.readdirSync(t.root)).toContain("data");
        expect(fs.readdirSync(t.root)).not.toContain("Data");
      });

    it("a journal whose target is spelled in another case (folder missing right now) is still this folder", async (ctx) => {
      const t = await prepared();
      if (!caseInsensitive(t.root)) return ctx.skip();
      const c = spawnTs(CHILD, ["restore", t.backup, t.dataDir, t.keyPath, "old_moved"]);
      await c.exited;
      const file = restoreJournalPath(t.dataDir);
      const j = JSON.parse(fs.readFileSync(file, "utf8")) as { target: string };
      fs.writeFileSync(file, JSON.stringify({ ...j, target: path.join(t.root, "DATA") }));
      expect(fs.existsSync(t.dataDir)).toBe(false);
      expect(sameDataDir(path.join(t.root, "DATA"), t.dataDir)).toBe(true);
      expect(sameDataDir(path.join(t.root, "other"), t.dataDir)).toBe(false);
      const o = startServer(t);
      try {
        expect(o.recovered).toBe("completed");
        expect(users(o)).toBe(4);
      } finally {
        o.storage.db.$client.close();
        o.release();
      }
      // Moved in under the configured spelling, not the journal's.
      expect(fs.readdirSync(t.root)).toContain("data");
      expect(fs.readdirSync(t.root)).not.toContain("DATA");
    });

    it("the case probe matches the volume (and the folder-name and probe-file paths agree)", () => {
      const root = tmp();
      fs.writeFileSync(path.join(root, "probe-a"), "");
      const truth = fs.existsSync(path.join(root, "PROBE-A"));
      expect(caseInsensitive(root)).toBe(truth);
      const digits = path.join(root, "2026");
      fs.mkdirSync(digits);
      expect(caseInsensitive(digits)).toBe(truth);
      expect(fs.readdirSync(digits)).toEqual([]);
    });

    it("a chain of links resolves to the real folder; a link loop is refused with a clear message", async () => {
      const root = tmp();
      const real = path.join(root, "data");
      fs.symlinkSync(real, path.join(root, "a")); // dangling: data does not exist yet
      fs.symlinkSync("a", path.join(root, "b")); // relative, to a link
      fs.symlinkSync(path.join(root, "b"), path.join(root, "c"));
      expect(realDataDir(path.join(root, "c"))).toBe(real);
      expect(dataLockPath(path.join(root, "c"))).toBe(dataLockPath(real));
      fs.symlinkSync("loop2", path.join(root, "loop1"));
      fs.symlinkSync("loop1", path.join(root, "loop2"));
      expect(() => realDataDir(path.join(root, "loop1"))).toThrow(/symlink loop/);
      expect(() =>
        startServer({ dataDir: path.join(root, "loop1"), keyPath: path.join(root, "k", "master.key") }),
      ).toThrow(/symlink loop/);
    });

    it("an error after done is durable: the restore stands (the journal says done)", async () => {
      const t = await prepared();
      let armed = false;
      const r = restoreBackup({
        backup: t.backup,
        target: t.dataDir,
        key: t.key,
        hooks: {
          step: (st) => {
            if (st === "done") armed = true;
          },
          fsync: () => {
            if (armed) {
              armed = false;
              throw eio();
            }
          },
        },
      });
      expect(r.previous).toBeDefined();
      const o = startServer(t);
      try {
        expect(users(o)).toBe(4);
      } finally {
        o.storage.db.$client.close();
        o.release();
      }
      expect(fs.existsSync(restoreJournalPath(t.dataDir))).toBe(false);
    });

    it("directory fsync: an 'unsupported' answer is ignored, a real error is not", async () => {
      const t = await prepared();
      const dirError = (code: string) => (p: string) => {
        if (fs.lstatSync(p).isDirectory()) throw Object.assign(new Error(code), { code });
      };
      expect(
        restoreCode(() =>
          restoreBackup({
            backup: t.backup,
            target: t.dataDir,
            key: t.key,
            hooks: { fsync: dirError("EIO") },
          }),
        ),
      ).toBe("not_durable");
      expectOld(t);
      expect(
        restoreCode(() =>
          restoreBackup({
            backup: t.backup,
            target: t.dataDir,
            key: t.key,
            hooks: { fsync: dirError("EINVAL") },
          }),
        ),
      ).toBe("ok");
    });

    it("a 0-byte database next to an earlier copy counts as missing", async () => {
      const t = await prepared();
      fs.renameSync(t.dataDir, `${t.dataDir}.before-restore-20261111T000000Z`);
      fs.mkdirSync(t.dataDir, { mode: 0o700 });
      fs.writeFileSync(path.join(t.dataDir, DB_FILE), "");
      expect(() => startServer(t)).toThrow(/earlier one is next to it/);
    });

    it("never a fresh empty database while an older copy sits next to the missing data folder", async () => {
      const t = await prepared();
      fs.renameSync(t.dataDir, `${t.dataDir}.before-restore-20261111T000000Z`);
      expect(() => startServer(t)).toThrow(/earlier one is next to it/);
      expect(fs.existsSync(path.join(t.dataDir, DB_FILE))).toBe(false);
    });
  },
);

describe("file errors fail the backup (#37 review P2)", () => {
  async function app(backup: BuildOptions["backup"] = {}) {
    const L = layout();
    createMasterKey(L.keyPath);
    const one = await start({ ...L, backup });
    const f = await createFamily(one.app);
    const file = path.join(L.dataDir, "files", "u", "c", "a.txt");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, "A", { mode: 0o600 });
    return { ...L, one, f, file };
  }
  const post = (t: Awaited<ReturnType<typeof app>>) =>
    send(t.one.app, t.f.cookies.admin, "POST", "/api/admin/backups");

  it("an unreadable file or folder (EACCES) fails it: nothing listed, nothing left", async () => {
    for (const target of ["file", "dir"] as const) {
      const t = await app();
      const p = target === "file" ? t.file : path.dirname(t.file);
      fs.chmodSync(p, 0o000);
      closers.push(() => fs.chmodSync(p, target === "file" ? 0o600 : 0o700));
      const r = await post(t);
      expect(r.statusCode, target).toBe(500);
      expect(r.json()).toEqual({ error: "backup_failed" });
      expect(fs.readdirSync(t.backupDir)).toEqual([]);
    }
  });

  it("a file deleted during the walk: fine when nothing references it, a failure when the snapshot does", async () => {
    const del = async (rel: string) => {
      if (rel === "files/u/c/a.txt") fs.rmSync(path.join(t.dataDir, rel));
    };
    let referenced: string[] = [];
    const t = await app({ beforeCopy: async (rel) => del(rel), referencedFiles: () => referenced });
    const ok = await post(t);
    expect(ok.statusCode).toBe(201);
    expect(ok.json<{ item: { fileCount: number } }>().item.fileCount).toBe(0);
    fs.writeFileSync(t.file, "A", { mode: 0o600 });
    referenced = ["files/u/c/a.txt"];
    expect((await post(t)).json()).toEqual({ error: "backup_failed" });
    // Referenced and present: copied.
    fs.writeFileSync(t.file, "A", { mode: 0o600 });
    const t2 = await app({ referencedFiles: () => ["files/u/c/a.txt"] });
    expect((await post(t2)).json<{ item: { fileCount: number } }>().item.fileCount).toBe(1);
    // Referenced but never there.
    const t3 = await app({ referencedFiles: () => ["files/u/c/missing.txt"] });
    expect((await post(t3)).json()).toEqual({ error: "backup_failed" });
  });
});

describe("retention when backups keep failing (#37 review P2)", () => {
  it("30 days of failures: the deleted conversation leaves every backup, the admins are told each time", async () => {
    const L = layout();
    createMasterKey(L.keyPath);
    let clock = Date.UTC(2026, 10, 11, 18, 30);
    let failing = false;
    const one = await start({
      ...L,
      backup: {
        now: () => clock,
        afterDbSnapshot: async () => {
          if (failing) throw new Error("disk");
        },
      },
    });
    const f = await createFamily(one.app);
    const conv = one.app.conversations!.create(f.users.owner.id);
    one.app.conversations!.append(conv.id, {
      role: "user",
      parts: [{ type: "text", text: "GONE-IN-7-DAYS-37" }],
    });
    await backupNow(one.app, f.cookies.admin);
    await send(one.app, f.cookies.owner, "DELETE", `/api/conversations/${conv.id}`);
    failing = true;
    const holders = () =>
      fs
        .readdirSync(L.backupDir)
        .filter((id) => fs.readFileSync(path.join(L.backupDir, id, DB_FILE)).includes("GONE-IN-7-DAYS-37"));
    for (let day = 1; day <= 30; day++) {
      clock += DAY;
      expect((await one.app.backups!.run("scheduled")).ok).toBe(false);
      expect(holders().length, `day ${day}`).toBe(day < 7 ? 1 : 0);
    }
    expect(fs.readdirSync(L.backupDir)).toEqual([]);
    const warnings = (userId: string) =>
      one.storage.db.$client
        .prepare("SELECT body, url FROM notifications WHERE user_id = ? AND kind = 'system_warning'")
        .all(userId) as { body: string; url: string }[];
    const mine = warnings(f.users.admin.id);
    expect(mine.filter((n) => n.body.includes("백업에 실패했어요"))).toHaveLength(30);
    expect(mine.filter((n) => n.body.includes("백업이 하나도 남지 않았어요")).length).toBe(30 - 6);
    expect(new Set(mine.map((n) => n.url))).toEqual(new Set(["/admin?tab=backup"]));
    // Members are not told.
    const member = warnings(f.users.owner.id).map((n) => ({ kind: "system_warning", ...n }));
    expect(member.filter((n) => n.kind === "system_warning")).toEqual([]);
  });

  it("a server that was off: expired backups go at start, before any new backup", async () => {
    const L = layout();
    createMasterKey(L.keyPath);
    let clock = Date.UTC(2026, 10, 11, 18, 30);
    const one = await start({ ...L, backup: { now: () => clock } });
    const f = await createFamily(one.app);
    await backupNow(one.app, f.cookies.admin);
    await one.close();
    clock += 10 * DAY;
    const two = await start({ ...L, backup: { now: () => clock, schedule: true, catchUpMs: DAY } });
    await two.app.ready();
    expect(fs.readdirSync(L.backupDir)).toEqual([]);
  });
});

describe("restore checks every secret and upgrades an older schema (#37 review P2/P3)", () => {
  async function made() {
    const L = layout();
    createMasterKey(L.keyPath);
    const one = await start(L);
    const f = await createFamily(one.app);
    await send(one.app, f.cookies.owner, "POST", "/api/connections", {
      runtime: "claude-code",
      authType: "api_key",
      secret: KEY_SECRET,
    });
    // A push subscription row (encrypted with the master key, AAD push:<id>).
    const session = one.storage.db.$client.prepare("SELECT id FROM sessions LIMIT 1").get() as { id: string };
    one.storage.db.$client
      .prepare(
        "INSERT INTO push_subscriptions (id, user_id, session_id, endpoint_hash, secret, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        "push-1",
        f.users.owner.id,
        session.id,
        "h1",
        encrypt('{"endpoint":"https://push.example/x","keys":{}}', one.storage.masterKey, "push:push-1"),
        "phone",
        1,
      );
    const id = await backupNow(one.app, f.cookies.admin);
    await one.close();
    return { ...L, backup: path.join(L.backupDir, id), key: loadMasterKey(L.keyPath) };
  }

  it("one bad ciphertext (connection, setting, push subscription) with a good key check: secret_unreadable", async () => {
    const t = await made();
    const other = crypto.randomBytes(32);
    const target = path.join(t.root, "restored");
    expect(restoreCode(() => verifyBackup(t.backup, t.key))).toBe("ok");
    const cases: [string, (db: Database.Database) => void][] = [
      [
        "connection",
        (db) => {
          const c = db.prepare("SELECT id, runtime, auth_type AS a FROM connections").get() as {
            id: string;
            runtime: string;
            a: string;
          };
          db.prepare("UPDATE connections SET secret = ?").run(
            encrypt(KEY_SECRET, other, `connection:${c.id}:${c.runtime}:${c.a}`),
          );
        },
      ],
      [
        "setting",
        (db) =>
          db
            .prepare("UPDATE settings SET value = ? WHERE key = 'push.vapid.private' AND encrypted = 1")
            .run(encrypt("x", other, "setting:push.vapid.private")),
      ],
      [
        "push",
        (db) =>
          db
            .prepare("UPDATE push_subscriptions SET secret = ? WHERE id = 'push-1'")
            .run(encrypt("{}", other, "push:push-1")),
      ],
    ];
    for (const [name, change] of cases) {
      const copy = path.join(t.root, `bad-${name}`);
      fs.cpSync(t.backup, copy, { recursive: true });
      tamperDb(copy, change);
      expect(
        restoreCode(() => restoreBackup({ backup: copy, target, key: t.key })),
        name,
      ).toBe("secret_unreadable");
      expect(fs.existsSync(target)).toBe(false);
    }
  });

  it("a backup of an older schema is restored and upgraded to this code's schema", async () => {
    const root = tmp();
    // A database made by an older build: only the migrations before 0015's initial_defaults (later ones, such as
    // 0016 citations, are left out too — an older build had none of them). No `files` table either (#22): the
    // backup's file-reference query must cope with that.
    const code = codeMigrations();
    const older = path.join(root, "older-migrations");
    fs.cpSync(MIGRATIONS_DIR, older, { recursive: true });
    const journalFile = path.join(older, "meta", "_journal.json");
    const journal = JSON.parse(fs.readFileSync(journalFile, "utf8")) as { entries: { tag: string }[] };
    journal.entries = journal.entries.filter((e) => Number(e.tag.slice(0, 4)) < 15);
    const left = code.length - journal.entries.length;
    fs.writeFileSync(journalFile, JSON.stringify(journal));
    const dataDir = path.join(root, "data");
    fs.mkdirSync(dataDir, { mode: 0o700 });
    const db = openDb(path.join(dataDir, DB_FILE));
    migrate(db, { migrationsFolder: older });
    db.$client
      .prepare(
        "INSERT INTO users (id, email, name, role, default_runtime) VALUES ('u1', 'u1@x', 'u1', 'member', 'codex')",
      )
      .run();
    const key = crypto.randomBytes(32);
    const backupDir = path.join(root, "backups");
    const made = await createBackup({
      sqlite: db.$client,
      dataDir,
      backupDir,
      masterKey: key,
      lock: new FileWriteLock(),
      now: Date.now,
    });
    db.$client.close();
    expect(made.migrations).toBe(code.length - left);
    const target = path.join(root, "restored");
    const r = restoreBackup({ backup: path.join(backupDir, made.id), target, key });
    expect(r.pending).toBe(left);
    const restored = new Database(path.join(target, DB_FILE), { readonly: true });
    try {
      expect(appliedMigrations(restored).map((m) => m.hash)).toEqual(code.map((m) => m.hash));
      // 0015 ran on the restored data: the old default runtime became the initial defaults.
      expect(
        JSON.parse((restored.prepare("SELECT initial_defaults AS d FROM users").get() as { d: string }).d),
      ).toMatchObject({ runtime: "codex" });
    } finally {
      restored.close();
    }
  });
});

describe("the CLI checks the key it actually uses (#37 review P2)", { timeout: 60_000 }, () => {
  it("--key inside --target is refused and the key stays where it is", async () => {
    const L = layout();
    createMasterKey(L.keyPath);
    const one = await start(L);
    const f = await createFamily(one.app);
    const id = await backupNow(one.app, f.cookies.admin);
    await one.close();
    const target = path.join(L.root, "rehearsal");
    fs.mkdirSync(target, { mode: 0o700 });
    const inside = path.join(target, "master.key");
    fs.copyFileSync(L.keyPath, inside);
    fs.chmodSync(inside, 0o600);
    const env = {
      NODE_ENV: "development",
      DATA_DIR: L.dataDir,
      MASTER_KEY_PATH: L.keyPath,
      BACKUP_DIR: L.backupDir,
    };
    const c = spawnTs(CLI, ["apply", id, "--target", target, "--key", inside], env);
    const { code } = await c.exited;
    expect(code, c.err()).toBe(1);
    expect(c.err()).toContain("restore failed: target_unsafe");
    expect(fs.readdirSync(target)).toEqual(["master.key"]);
    // The same command with the key outside works.
    const ok = spawnTs(
      CLI,
      ["apply", id, "--target", path.join(L.root, "rehearsal2"), "--key", L.keyPath],
      env,
    );
    expect((await ok.exited).code, ok.err()).toBe(0);
    expect(ok.out()).toContain(`restored: ${id}`);
  });
});

describe("the backup tab reports what a restore left beside the data folder (#37 review 4 P3)", () => {
  it("counts before-restore and restore-rejected folders", async () => {
    const L = layout();
    createMasterKey(L.keyPath);
    const one = await start(L);
    const f = await createFamily(one.app);
    const get = async () =>
      BackupsResponse.parse((await send(one.app, f.cookies.admin, "GET", "/api/admin/backups")).json())
        .leftovers;
    expect(await get()).toEqual({ previous: 0, rejected: 0 });
    fs.mkdirSync(`${L.dataDir}.before-restore-20261111T000000Z`);
    fs.mkdirSync(`${L.dataDir}.restore-rejected-abc123`);
    fs.mkdirSync(`${L.dataDir}.restore-rejected-def456`);
    fs.mkdirSync(path.join(L.root, "other.restore-rejected-x"));
    expect(await get()).toEqual({ previous: 1, rejected: 2 });
  });
});
