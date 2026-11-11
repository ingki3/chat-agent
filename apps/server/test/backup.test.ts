import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { BackupsResponse, CSRF_HEADER } from "@agentlee/shared";
import { buildApp, type BuildOptions } from "../src/app.js";
import { initStorage } from "../src/bootstrap.js";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { createMasterKey, loadMasterKey } from "../src/crypto/secrets.js";
import {
  BACKUP_CODES,
  DB_FILE,
  MANIFEST_FILE,
  nextRunAt,
  pruneBackups,
  sha256File,
  type Manifest,
} from "../src/backup/backup.js";
import { FileWriteLock } from "../src/backup/lock.js";
import { restoreBackup, RestoreError, verifyBackup, type RestoreCode } from "../src/backup/restore.js";
import { checkSchema, codeMigrations } from "../src/backup/schema.js";
import { BACKUP_CODES as LOGGABLE_BACKUP_CODES } from "../src/observability/policy.js";
import { RuntimeFailure, RuntimeRegistry, type StartContext } from "../src/runtime/adapter.js";
import { FakeRuntime } from "../src/runtime/fake.js";
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
      masterKeyPath: recoveredKey,
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
    // A server still serving the target (its pid file names a live process).
    fs.mkdirSync(target, { mode: 0o700 });
    fs.writeFileSync(path.join(target, "server.pid"), `${process.ppid}\n`);
    expect(restoreCode(() => restoreBackup({ backup: t.backup, target, key: t.key }))).toBe("server_running");
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
          masterKeyPath: t.keyPath,
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

  it("leaves out runtime folders, the login quarantine, skills, temp files and the pid file", async () => {
    const L = layout();
    createMasterKey(L.keyPath);
    const one = await start(L);
    const f = await createFamily(one.app);
    const p = storagePaths(L.dataDir);
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
    fs.writeFileSync(p.serverPid, "1\n");
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

  it("keeps the newest valid backup even when it is old (failed backups never leave none)", () => {
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
    expect(pruneBackups(dir, t0 + 30 * DAY)).toBe(2);
    expect(fs.readdirSync(dir).sort()).toEqual(["20260102-000000Z-bbbbbb", "not-a-backup"]);
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
    // 50 ms before 03:30 Seoul.
    const base = Date.UTC(2026, 10, 11, 18, 30) - 50;
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
