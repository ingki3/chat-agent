import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CSRF_HEADER, type Message, type Run, type Share } from "@agentlee/shared";
import { buildApp, type BuildOptions } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { openDb, runMigrations, type Db } from "../src/db/client.js";
import { RuntimeRegistry } from "../src/runtime/adapter.js";
import { ClaudeAdapter } from "../src/runtime/claude.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import { inProcessExtractor, ocrCapability } from "../src/files/extract.js";
import { SourceStore } from "../src/web/sources.js";
import { CitationStore } from "../src/citations/store.js";
import { createFamily } from "./helpers/permission-matrix.js";
import { createBackup, deletedFolders } from "../src/backup/backup.js";
import { ConversationPurge, RECONCILE_PENDING_KEY } from "../src/conversations/purge.js";
import { ConversationStore } from "../src/conversations/store.js";
import { noteStarted } from "../src/runtime/forget.js";
import { readKey } from "../src/secrets/markers.js";
import { CODEX_MODELS, CodexAdapter } from "../src/runtime/codex.js";
import { newLog, replaySpawn } from "./helpers/codex-replay.js";
import { findSnippet, verifyStats } from "../src/citations/verify.js";

/**
 * Deleting a conversation (#54, PRD NFR 개인정보 · FR-2.1): afterwards nothing of it is in the database or under
 * `data/` (the encrypted backups live outside it) — rows, files on disk, extracted text, artifacts, sources, shares
 * and their snapshots and receipts, notifications, runtime session state, and the bytes in the database file and its
 * WAL. A fork made from it is the forker's own and stays.
 */

type App = Awaited<ReturnType<typeof buildApp>>;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const IN_PROCESS = inProcessExtractor(() => ocrCapability(path.join(os.tmpdir(), "agentlee-test-ocr-lang")));

/** Markers of what the original holds: `SHARED_*` is in the snapshot (and so in the fork), `PRIVATE_*` is not. */
const tag = (name: string) => `${name}-${crypto.randomUUID().slice(0, 8)}`;

type World = Awaited<ReturnType<typeof world>>;

async function world(
  o: {
    dataDir?: string;
    db?: Db;
    forget?: (id: string, dir: string) => Promise<void>;
    script?: ConstructorParameters<typeof FakeRuntime>[0];
    extra?: Partial<BuildOptions>;
  } = {},
) {
  const dataDir = o.dataDir ?? fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "agentlee-delete-"));
  if (!o.dataDir) cleanups.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.mkdirSync(dataDir, { recursive: true });
  // The data folder's own database file: what the checks below read byte for byte, WAL included.
  const db = o.db ?? openDb(path.join(dataDir, "agentlee.db"));
  if (!o.db) {
    runMigrations(db);
    cleanups.push(() => db.$client.close());
  }
  const fake = new FakeRuntime(o.script ?? { script: (input) => [{ text: `답: ${input.text}` }] });
  // Its sessions live in memory; the on-disk state of a real runtime's session is Claude's layout (planted below).
  const claude = new ClaudeAdapter({ connection: () => undefined });
  const fakeForget = fake.forget.bind(fake);
  fake.forget = async (id: string, dir?: string, opts?: { stillOrphan?: () => boolean }) => {
    await fakeForget(id);
    if (o.forget) await o.forget(id, dir!);
    else await claude.forget(id, dir!, opts);
  };
  // What it keeps on disk, for the start-up reconciliation: Claude's layout too.
  (fake as { storedSessions?: (dir: string) => string[] }).storedSessions = (dir) =>
    claude.storedSessions(dir);
  const runtimes = new RuntimeRegistry();
  runtimes.register(fake);
  const app: App = await buildApp(loadConfig({ NODE_ENV: "test", DATA_DIR: dataDir }), {
    db,
    logger: false,
    runtimes,
    runs: { flushMs: 0 },
    extract: { runner: IN_PROCESS },
    purge: { retryMs: 20, maxRetryMs: 40 },
    ...o.extra,
  });
  cleanups.push(() => app.close());
  const f = await createFamily(app);
  await app.ready();
  const as = (cookie: string) => {
    const h = { host: "localhost:3000", cookie, origin: "http://localhost:3000", [CSRF_HEADER]: "1" };
    return {
      get: (url: string) => app.inject({ url, headers: { host: "localhost:3000", cookie } }),
      send: (method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload: object = {}) =>
        app.inject({ method, url, headers: h, payload }),
    };
  };
  const owner = as(f.cookies.owner);
  const viewer = as(f.cookies.shared);
  const waitRun = async (id: string) => {
    for (let i = 0; i < 500; i++) {
      const r = (await owner.get(`/api/runs/${id}`)).json<Run>();
      if (r.endedAt !== null) return r;
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error("run did not finish");
  };
  const say = async (conversationId: string, text: string, fileIds?: string[]) => {
    const r = await owner.send("POST", `/api/conversations/${conversationId}/messages`, {
      text,
      ...(fileIds ? { fileIds } : {}),
    });
    expect(r.statusCode).toBe(201);
    const body = r.json<{ message: Message; assistant: Message; run: Run }>();
    await waitRun(body.run.id);
    return body;
  };
  const upload = async (conversationId: string, text: string) => {
    const tmp = app.files!.tempFile();
    fs.writeFileSync(tmp, text);
    const row = await app.files!.add({
      userId: f.users.owner.id,
      conversationId,
      uploadId: crypto.randomUUID(),
      name: "메모.txt",
      kind: "txt",
      bytes: Buffer.byteLength(text),
      sha256: crypto.createHash("sha256").update(text).digest("hex"),
      tmp,
    });
    app.fileExtracts!.enqueue(row.id); // as the upload route does
    return row.id;
  };
  const sources = new SourceStore(db);
  const citations = new CitationStore(db);
  const cite = (conversationId: string, runId: string, url: string, body: string) => {
    const scope = { userId: f.users.owner.id, conversationId, runId };
    const src = sources.addPage(scope, {
      url,
      finalUrl: url,
      title: url,
      site: "example.com",
      contentType: "text/html",
      body,
      truncated: false,
    })!;
    citations.cite(scope, { sourceId: src.id, snippet: body.slice(0, 40) });
  };
  /**
   * A runtime session of the conversation as a real runtime keeps it: a row, and Claude's files in the connection
   * folder of the owner (`runtimes/<connection>/<user>/config/projects/…/<id>.jsonl`, our note in `-meta`).
   */
  const session = (conversationId: string, text: string) => {
    const id = crypto.randomUUID();
    const dir = path.join(dataDir, "runtimes", "conn-1", f.users.owner.id);
    const project = path.join(dir, "config", "projects", "-work");
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, `${id}.jsonl`), JSON.stringify({ message: text }));
    fs.mkdirSync(`${dir}-meta`, { recursive: true });
    fs.writeFileSync(
      path.join(`${dir}-meta`, `${id}.json`),
      JSON.stringify({ systemPrompt: text, costUsd: 0 }),
    );
    db.$client
      .prepare(
        `INSERT INTO runtime_sessions (id, conversation_id, runtime, connection_id, external_session_id,
           conversation_revision) VALUES (?, ?, 'claude-code', 'conn-1', ?, 0)`,
      )
      .run(crypto.randomUUID(), conversationId, id);
    return { id, file: path.join(project, `${id}.jsonl`), meta: path.join(`${dir}-meta`, `${id}.json`) };
  };
  return { app, db, f, dataDir, owner, viewer, say, upload, cite, session, waitRun };
}

/** Every row of every table, as text. */
function dumpDb(db: Db): string {
  const tables = db.$client
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all() as { name: string }[];
  return tables
    .map((t) => `${t.name}: ${JSON.stringify(db.$client.prepare(`SELECT * FROM "${t.name}"`).all())}`)
    .join("\n");
}

/** Files under `dir` (recursively, links not followed) whose bytes contain `marker`. */
function filesWith(dir: string, marker: string): string[] {
  const out: string[] = [];
  const needle = Buffer.from(marker, "utf8");
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && fs.readFileSync(p).includes(needle)) out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out;
}

/** The conversation, built up: two turns, files with extracted text, an artifact, sources, a snapshot share. */
async function fullConversation(w: World) {
  const m = {
    sharedAsk: tag("SHARED-ASK"),
    sharedFile: tag("SHARED-FILE"),
    sharedArt: tag("SHARED-ART"),
    privateAsk: tag("PRIVATE-ASK"),
    privateFile: tag("PRIVATE-FILE"),
    privateArt: tag("PRIVATE-ART"),
    privateSrc: tag("PRIVATE-SRC"),
    sharedSrc: tag("SHARED-SRC"),
    privateSummary: tag("PRIVATE-SUMMARY"),
    privateNote: tag("PRIVATE-NOTE"),
    privateSession: tag("PRIVATE-SESSION"),
  };
  const c = w.app.conversations!.create(w.f.users.owner.id, { title: "과학 보고서" });
  const f1 = await w.upload(c.id, `첫 파일 ${m.sharedFile}`);
  const t1 = await w.say(c.id, `질문 ${m.sharedAsk}`, [f1]);
  const { artifact } = w.app.artifacts!.create(
    { userId: w.f.users.owner.id, conversationId: c.id, runId: t1.run.id },
    { kind: "markdown", title: "표", content: `v1 ${m.sharedArt}` },
  );
  w.cite(c.id, t1.run.id, "https://a.example/1", `사과는 빨갛다고 한다 ${m.sharedSrc} 그렇다고 한다.`);
  const f2 = await w.upload(c.id, `둘째 파일 ${m.privateFile}`);
  const t2 = await w.say(c.id, `질문 ${m.privateAsk}`, [f2]);
  w.app.artifacts!.update(
    { userId: w.f.users.owner.id, conversationId: c.id, runId: t2.run.id },
    artifact.id,
    { content: `v2 ${m.privateArt}` },
  );
  w.cite(c.id, t2.run.id, "https://b.example/2", `바나나는 노랗다고 한다 ${m.privateSrc} 그렇다고 한다.`);
  await w.app.fileExtracts!.idle();
  expect(dumpDb(w.db)).toContain(m.privateFile); // extracted: the text is in file_segments
  w.db.$client
    .prepare(
      `INSERT INTO conversation_summaries (id, conversation_id, through_message_id, through_seq, covered_hash, summary,
         runtime, model) VALUES (?, ?, ?, 1, 'h', ?, 'claude-code', 'fake-large')`,
    )
    .run(crypto.randomUUID(), c.id, t1.assistant.id, `요약 ${m.privateSummary}`);
  const rt = w.session(c.id, `세션 ${m.privateSession}`);
  // The snapshot share: turn 1 only. The viewer opens it (read receipt) and forks it.
  const sr = await w.owner.send("POST", `/api/conversations/${c.id}/shares`, {
    target: { audience: "users", userIds: [w.f.users.shared.id] },
    mode: "snapshot",
    boundaryMessageId: t1.assistant.id,
  });
  expect(sr.statusCode).toBe(201);
  const share = sr.json<Share>();
  expect((await w.viewer.get(`/api/shares/${share.id}/view`)).statusCode).toBe(200);
  const fr = await w.viewer.send("POST", `/api/shares/${share.id}/fork`);
  expect(fr.statusCode).toBe(201);
  const fork = fr.json<{ conversation: { id: string } }>().conversation;
  // A schedule result's notification quotes the reply; the viewer got "가족이 공유했어요".
  w.app.notifications!.publish(w.f.users.owner.id, {
    kind: "schedule_succeeded",
    scheduleName: "아침 요약",
    summary: `결과 ${m.privateNote}`,
    url: `/c/${c.id}#m-${t2.assistant.id}`,
    ref: { kind: "conversation", id: c.id },
  });
  return { c, m, f1, f2, t1, t2, artifact, share, fork, rt };
}

describe("deleting a conversation (#54)", () => {
  it("leaves nothing of it in the database or under data/ — the fork stays, until its owner deletes it too", async () => {
    const w = await world();
    const x = await fullConversation(w);
    // Another conversation of the owner, with its own session and notification: untouched by the delete.
    const other = w.app.conversations!.create(w.f.users.owner.id, { title: "다른 대화" });
    const keepAsk = tag("KEEP-ASK");
    await w.say(other.id, `질문 ${keepAsk}`);
    const keepSession = w.session(other.id, `세션 ${keepAsk}`);
    w.app.notifications!.publish(w.f.users.owner.id, {
      kind: "schedule_succeeded",
      scheduleName: "저녁",
      summary: "다른 결과",
      url: `/c/${other.id}`,
      ref: { kind: "conversation", id: other.id },
    });
    const notes = () =>
      w.db.$client
        .prepare("SELECT user_id AS u, kind, ref_kind AS k, ref_id AS r FROM notifications")
        .all() as {
        u: string;
        kind: string;
        k: string;
        r: string;
      }[];
    expect(notes().filter((n) => n.r === x.c.id || n.r === x.share.id)).toHaveLength(2);
    const ownerFiles = path.join(w.dataDir, "files", w.f.users.owner.id, x.c.id);
    expect(fs.readdirSync(ownerFiles)).toHaveLength(2);
    const before = dumpDb(w.db);
    for (const [k, marker] of Object.entries(x.m))
      if (k !== "privateSession") expect(before, k).toContain(marker);
    expect(filesWith(w.dataDir, x.m.privateSession)).not.toEqual([]);
    // On disk too, before: the database file or its WAL holds the text (what the byte checks below rely on).
    expect(filesWith(w.dataDir, x.m.privateAsk).filter((p) => p.startsWith("agentlee.db"))).not.toEqual([]);
    const count = (sql: string) => (w.db.$client.prepare(sql).get(x.c.id) as { n: number }).n;
    const SCOPED = {
      // The snapshot's list is immutable (a trigger refuses UPDATE): it goes with its share — DELETE, by cascade.
      share_snapshots:
        "SELECT count(*) AS n FROM share_snapshots s JOIN shares h ON h.id = s.share_id WHERE h.conversation_id = ?",
      share_views:
        "SELECT count(*) AS n FROM share_views s JOIN shares h ON h.id = s.share_id WHERE h.conversation_id = ?",
      share_targets:
        "SELECT count(*) AS n FROM share_targets s JOIN shares h ON h.id = s.share_id WHERE h.conversation_id = ?",
      file_segments:
        "SELECT count(*) AS n FROM file_segments s JOIN files f ON f.id = s.file_id WHERE f.conversation_id = ?",
      artifact_versions:
        "SELECT count(*) AS n FROM artifact_versions v JOIN artifacts a ON a.id = v.artifact_id WHERE a.conversation_id = ?",
    };
    for (const [k, q] of Object.entries(SCOPED)) expect(count(q), k).toBeGreaterThan(0);
    const snapshotRows = (
      w.db.$client.prepare("SELECT count(*) AS n FROM share_snapshots").get() as { n: number }
    ).n;

    expect((await w.owner.send("DELETE", `/api/conversations/${x.c.id}`)).statusCode).toBe(200);
    await w.app.purge!.idle();
    await w.app.storedRescrub!.idle();

    expect(
      (w.db.$client.prepare("SELECT count(*) AS n FROM share_snapshots").get() as { n: number }).n,
    ).toBeLessThan(snapshotRows);
    expect(
      (
        w.db.$client
          .prepare("SELECT count(*) AS n FROM share_snapshots WHERE share_id = ?")
          .get(x.share.id) as {
          n: number;
        }
      ).n,
    ).toBe(0);
    // Through the API: gone for the owner and the viewer.
    expect((await w.owner.get(`/api/conversations/${x.c.id}`)).statusCode).toBe(404);
    expect((await w.owner.get(`/api/files/${x.f2}/content`)).statusCode).toBe(404);
    expect((await w.owner.get(`/api/artifacts/${x.artifact.id}`)).statusCode).toBe(404);
    expect((await w.viewer.get(`/api/shares/${x.share.id}/view`)).statusCode).toBe(404);
    // Notifications about it went, whoever had them; the other conversation's stays.
    expect(notes().filter((n) => n.r === x.c.id || n.r === x.share.id)).toEqual([]);
    expect(notes().filter((n) => n.r === other.id)).toHaveLength(1);
    // The runtime session's state went; the other conversation's did not.
    expect(fs.existsSync(x.rt.file)).toBe(false);
    expect(fs.existsSync(x.rt.meta)).toBe(false);
    expect(fs.existsSync(keepSession.file)).toBe(true);
    expect(w.app.purge!.pendingFor()).toBe(0);
    // Its upload folder went.
    expect(fs.existsSync(ownerFiles)).toBe(false);

    // Nowhere: no row of any table, no byte of any file under data/ (database file and WAL included).
    const dump = dumpDb(w.db);
    for (const [k, marker] of Object.entries(x.m))
      if (k.startsWith("private") || k === "sharedSrc") {
        expect(dump, k).not.toContain(marker);
        expect(filesWith(w.dataDir, marker), k).toEqual([]);
      }
    // No row keeps a pointer that names it, except ids-only bookkeeping: usage/cost, the error list, fork provenance.
    for (const table of ["messages", "files", "file_segments", "artifacts", "artifact_versions", "shares"])
      expect(
        dump.split("\n").find((l) => l.startsWith(`${table}:`)),
        table,
      ).not.toContain(x.c.id);
    // The fork is the viewer's: messages, its file's bytes, its artifact — all still there.
    const forkMsgs = (await w.viewer.get(`/api/conversations/${x.fork.id}/messages`)).json<{
      items: Message[];
    }>().items;
    expect(JSON.stringify(forkMsgs)).toContain(x.m.sharedAsk);
    const forkFiles = (await w.viewer.get(`/api/conversations/${x.fork.id}/files`)).json<{
      items: { id: string }[];
    }>().items;
    expect(forkFiles).toHaveLength(1);
    expect((await w.viewer.get(`/api/files/${forkFiles[0]!.id}/content`)).body).toContain(x.m.sharedFile);
    expect(dump).toContain(x.m.sharedArt);
    // The other conversation is whole.
    expect(dump).toContain(keepAsk);

    // The forker deletes the fork: then the shared part is gone as well.
    expect((await w.viewer.send("DELETE", `/api/conversations/${x.fork.id}`)).statusCode).toBe(200);
    await w.app.purge!.idle();
    await w.app.storedRescrub!.idle();
    const after = dumpDb(w.db);
    for (const marker of [x.m.sharedAsk, x.m.sharedFile, x.m.sharedArt]) {
      expect(after).not.toContain(marker);
      expect(filesWith(w.dataDir, marker)).toEqual([]);
    }
    expect(after).toContain(keepAsk);
  }, 30_000);

  it("a run going on is stopped first: its stream ends and nothing it writes afterwards lands anywhere", async () => {
    const marker = tag("RUNNING");
    const w = await world({
      script: {
        script: () =>
          Array.from({ length: 100 }, (_, i) => [{ text: `${marker} ${i} ` }, { delayMs: 10 }]).flat(),
      },
    });
    const c = w.app.conversations!.create(w.f.users.owner.id);
    const r = await w.owner.send("POST", `/api/conversations/${c.id}/messages`, { text: "길게" });
    const run = r.json<{ run: Run }>().run;
    await new Promise((res) => setTimeout(res, 80));
    expect((await w.owner.send("DELETE", `/api/conversations/${c.id}`)).statusCode).toBe(200);
    expect(w.app.runs!.liveCount()).toBe(0);
    await new Promise((res) => setTimeout(res, 200));
    await w.app.purge!.idle();
    await w.app.storedRescrub!.idle();
    expect(w.app.runs!.get(run.id)).toBeUndefined();
    expect(dumpDb(w.db)).not.toContain(marker);
    expect(filesWith(w.dataDir, marker)).toEqual([]);
  });

  it("crash safety: the session jobs are written with the delete, and a restart works off what was left", async () => {
    const dataDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "agentlee-delete-"));
    cleanups.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const db = openDb(path.join(dataDir, "agentlee.db"));
    runMigrations(db);
    cleanups.push(() => db.$client.close());
    const a = await world({ dataDir, db });
    const c = a.app.conversations!.create(a.f.users.owner.id);
    const marker = tag("LEFT");
    const rt = a.session(c.id, marker);
    // The process "dies" right after the commit: the jobs never run in it.
    a.app.purge!.close();
    expect((await a.owner.send("DELETE", `/api/conversations/${c.id}`)).statusCode).toBe(200);
    expect(a.app.conversations!.get(c.id)).toBeUndefined();
    expect(
      db.$client
        .prepare(
          "SELECT runtime, connection_id AS k, external_session_id AS s FROM deletion_jobs WHERE kind = 'runtime_session'",
        )
        .all(),
    ).toEqual([{ runtime: "claude-code", k: "conn-1", s: rt.id }]);
    expect(fs.existsSync(rt.file)).toBe(true);
    await a.app.close();
    // The next start resumes them once ready.
    const b = await buildApp(loadConfig({ NODE_ENV: "test", DATA_DIR: dataDir }), {
      db,
      logger: false,
      runtimes: (() => {
        const r = new RuntimeRegistry();
        const fake = new FakeRuntime();
        const claude = new ClaudeAdapter({ connection: () => undefined });
        fake.forget = (id: string, dir?: string) => claude.forget(id, dir!);
        (fake as { storedSessions?: (dir: string) => string[] }).storedSessions = (dir) =>
          claude.storedSessions(dir);
        r.register(fake);
        return r;
      })(),
    });
    cleanups.push(() => b.close());
    await b.ready();
    await b.purge!.idle();
    expect(fs.existsSync(rt.file)).toBe(false);
    expect(fs.existsSync(rt.meta)).toBe(false);
    expect(b.purge!.pendingFor()).toBe(0);
    await b.storedRescrub!.idle();
    expect(filesWith(dataDir, marker)).toEqual([]);
  });

  it("a session that cannot be forgotten yet is retried with backoff until it is", async () => {
    let fails = 2;
    const calls: string[] = [];
    const w = await world({
      forget: async (id) => {
        calls.push(id);
        if (fails-- > 0) throw new Error("busy");
      },
    });
    const c = w.app.conversations!.create(w.f.users.owner.id);
    const rt = w.session(c.id, "x");
    expect((await w.owner.send("DELETE", `/api/conversations/${c.id}`)).statusCode).toBe(200);
    for (let i = 0; i < 200 && w.app.purge!.pendingFor() > 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(w.app.purge!.pendingFor()).toBe(0);
    expect(calls).toEqual([rt.id, rt.id, rt.id]);
  });

  it("never follows a linked connection folder (the job stays, retried); a disconnected connection is done at once", async () => {
    const outside = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "agentlee-outside-"));
    cleanups.push(() => fs.rmSync(outside, { recursive: true, force: true }));
    const calls: string[] = [];
    const w = await world({ forget: async (id) => void calls.push(id) });
    const c = w.app.conversations!.create(w.f.users.owner.id);
    const rt = w.session(c.id, "x");
    // conn-1 replaced by a link elsewhere: not walked, not touched.
    const conn = path.join(w.dataDir, "runtimes", "conn-1");
    fs.renameSync(conn, path.join(outside, "conn-1"));
    fs.symlinkSync(path.join(outside, "conn-1"), conn);
    const c2 = w.app.conversations!.create(w.f.users.owner.id);
    w.db.$client
      .prepare(
        `INSERT INTO runtime_sessions (id, conversation_id, runtime, connection_id, external_session_id,
           conversation_revision) VALUES (?, ?, 'claude-code', 'gone-conn', ?, 0)`,
      )
      .run(crypto.randomUUID(), c2.id, crypto.randomUUID());
    expect((await w.owner.send("DELETE", `/api/conversations/${c.id}`)).statusCode).toBe(200);
    expect((await w.owner.send("DELETE", `/api/conversations/${c2.id}`)).statusCode).toBe(200);
    await w.app.purge!.idle();
    expect(calls).toEqual([]);
    // The linked one is not done (nothing was removed); the one without a folder is.
    expect(w.app.purge!.pendingFor(c.id)).toBe(1);
    expect(w.app.purge!.pendingFor(c2.id)).toBe(0);
    expect(
      fs.existsSync(
        path.join(outside, "conn-1", w.f.users.owner.id, "config", "projects", "-work", `${rt.id}.jsonl`),
      ),
    ).toBe(true);
  });

  it("an upload folder that cannot be emptied now stays a job — retried until verified gone, and kept out of backups", async () => {
    const w = await world();
    const c = w.app.conversations!.create(w.f.users.owner.id);
    const marker = tag("STUCK-FILE");
    await w.upload(c.id, `파일 ${marker}`);
    await w.app.fileExtracts!.idle();
    const folder = path.join(w.dataDir, "files", w.f.users.owner.id, c.id);
    fs.chmodSync(folder, 0o500); // its files cannot be unlinked now
    cleanups.push(() => {
      if (fs.existsSync(folder)) fs.chmodSync(folder, 0o700);
    });
    expect((await w.owner.send("DELETE", `/api/conversations/${c.id}`)).statusCode).toBe(200);
    await w.app.purge!.idle();
    expect(w.app.conversations!.get(c.id)).toBeUndefined();
    expect(filesWith(folder, marker)).toHaveLength(1);
    // Tried and not done (a retry may already have come meanwhile on a slow machine — still not done).
    const left = w.db.$client
      .prepare("SELECT kind, attempts FROM deletion_jobs WHERE conversation_id = ?")
      .all(c.id) as { kind: string; attempts: number }[];
    expect(left.map((j) => j.kind)).toEqual(["conversation_files"]);
    expect(left[0]!.attempts).toBeGreaterThanOrEqual(1); // A backup meanwhile never copies what is left there.
    expect(deletedFolders(w.db.$client)).toEqual([`files/${w.f.users.owner.id}/${c.id}`]);
    const backupDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "agentlee-bk-"));
    cleanups.push(() => fs.rmSync(backupDir, { recursive: true, force: true }));
    const info = await createBackup({
      sqlite: w.db.$client,
      dataDir: w.dataDir,
      backupDir,
      masterKey: crypto.randomBytes(32),
      lock: w.app.fileWrites,
      now: Date.now,
    });
    expect(filesWith(path.join(backupDir, info.id), marker)).toEqual([]);
    // Writable again: the retry removes the files, checks they are gone, and only then is done.
    fs.chmodSync(folder, 0o700);
    for (let i = 0; i < 300 && w.app.purge!.pendingFor(c.id) > 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(w.app.purge!.pendingFor(c.id)).toBe(0);
    expect(fs.existsSync(folder)).toBe(false);
  });

  it("the citation check's cached page text goes with the conversation", async () => {
    const w = await world();
    const c = w.app.conversations!.create(w.f.users.owner.id);
    const t = await w.say(c.id, "질문");
    const body = `사과는 빨갛다고 한다 ${tag("CACHED")} 그렇다고 한다.`;
    w.cite(c.id, t.run.id, "https://a.example/c", body);
    const hash = crypto.createHash("sha256").update(body, "utf8").digest("hex");
    const cost = () => {
      const before = verifyStats.normalized;
      findSnippet(body, body.slice(0, 30), hash);
      return verifyStats.normalized - before;
    };
    cost();
    const hit = cost(); // the page from the cache: only the snippet is normalised
    expect((await w.owner.send("DELETE", `/api/conversations/${c.id}`)).statusCode).toBe(200);
    expect(cost()).toBeGreaterThan(hit); // normalised again: the cached copy went
  });

  it("a job waits until the dropped runs have really stopped — a timeout is not done", async () => {
    const calls: string[] = [];
    const w = await world({ forget: async (id) => void calls.push(id) });
    const c = w.app.conversations!.create(w.f.users.owner.id);
    const rt = w.session(c.id, "x");
    let stopped = false;
    const quiet = w.app.runs!.quiet.bind(w.app.runs!);
    w.app.runs!.quiet = async (id: string) => stopped && (await quiet(id));
    expect((await w.owner.send("DELETE", `/api/conversations/${c.id}`)).statusCode).toBe(200);
    await w.app.purge!.idle();
    expect(calls).toEqual([]);
    expect(w.app.purge!.pendingFor(c.id)).toBe(2); // the session and the folder
    stopped = true;
    for (let i = 0; i < 300 && w.app.purge!.pendingFor(c.id) > 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([rt.id]);
  });

  it("crash before a session's row was saved: the start-up reconciliation finds its state and forgets it", async () => {
    const dataDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "agentlee-delete-"));
    cleanups.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const db = openDb(path.join(dataDir, "agentlee.db"));
    runMigrations(db);
    cleanups.push(() => db.$client.close());
    const a = await world({ dataDir, db });
    const c = a.app.conversations!.create(a.f.users.owner.id);
    const kept = a.session(c.id, "KEPT");
    // What ClaudeAdapter.start writes first — our note with the conversation's context — and then the process died:
    // no row names it.
    const lost = crypto.randomUUID();
    const marker = tag("LOST-CONTEXT");
    const meta = path.join(dataDir, "runtimes", "conn-1", `${a.f.users.owner.id}-meta`, `${lost}.json`);
    fs.writeFileSync(meta, JSON.stringify({ systemPrompt: marker, costUsd: 0 }));
    await a.app.close();
    const runtimes = new RuntimeRegistry();
    const fake = new FakeRuntime();
    const claude = new ClaudeAdapter({ connection: () => undefined });
    fake.forget = (id: string, dir?: string) => claude.forget(id, dir!);
    (fake as { storedSessions?: (dir: string) => string[] }).storedSessions = (dir) =>
      claude.storedSessions(dir);
    runtimes.register(fake);
    const app = await buildApp(loadConfig({ NODE_ENV: "test", DATA_DIR: dataDir }), {
      db,
      logger: false,
      runtimes,
    });
    cleanups.push(() => app.close());
    await app.ready();
    const b = { app };
    await b.app.purge!.idle();
    expect(fs.existsSync(meta)).toBe(false);
    expect(filesWith(dataDir, marker)).toEqual([]);
    // The session a conversation owns stays.
    expect(fs.existsSync(kept.file)).toBe(true);
    expect(fs.existsSync(kept.meta)).toBe(true);
    expect(b.app.purge!.pendingFor()).toBe(0);
  });

  it("reconciliation: an unreadable folder skips only itself; the pass is marked incomplete and retried until whole", async () => {
    const dataDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "agentlee-delete-"));
    cleanups.push(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const db = openDb(path.join(dataDir, "agentlee.db"));
    runMigrations(db);
    cleanups.push(() => db.$client.close());
    const a = await world({ dataDir, db });
    const owner = a.f.users.owner.id;
    await a.app.close();
    // Two connections, each with a note no row owns; the first one's transcripts folder cannot be read.
    const plant = (conn: string) => {
      const dir = path.join(dataDir, "runtimes", conn, owner);
      fs.mkdirSync(path.join(dir, "config", "projects", "-w"), { recursive: true });
      fs.mkdirSync(`${dir}-meta`, { recursive: true });
      const id = crypto.randomUUID();
      fs.writeFileSync(
        path.join(`${dir}-meta`, `${id}.json`),
        JSON.stringify({ systemPrompt: "x", costUsd: 0 }),
      );
      return { dir, meta: path.join(`${dir}-meta`, `${id}.json`) };
    };
    const first = plant("conn-a");
    const second = plant("conn-b");
    const locked = path.join(first.dir, "config", "projects");
    fs.chmodSync(locked, 0o000);
    cleanups.push(() => {
      if (fs.existsSync(locked)) fs.chmodSync(locked, 0o700);
    });
    const runtimes = new RuntimeRegistry();
    const fake = new FakeRuntime();
    const claude = new ClaudeAdapter({ connection: () => undefined });
    fake.forget = (id: string, dir?: string, o?: { stillOrphan?: () => boolean }) =>
      claude.forget(id, dir!, o);
    (fake as { storedSessions?: (dir: string) => string[] }).storedSessions = (dir) =>
      claude.storedSessions(dir);
    runtimes.register(fake);
    const app = await buildApp(loadConfig({ NODE_ENV: "test", DATA_DIR: dataDir }), {
      db,
      logger: false,
      runtimes,
      purge: { retryMs: 30, maxRetryMs: 60 },
    });
    cleanups.push(() => app.close());
    await app.ready();
    await app.purge!.idle();
    // The readable one is done; the other waits, and the pass says it is incomplete.
    expect(fs.existsSync(second.meta)).toBe(false);
    expect(fs.existsSync(first.meta)).toBe(true);
    expect(readKey(db.$client, RECONCILE_PENDING_KEY)).toBe("1");
    // A session this process starts meanwhile is never taken for an orphan by a later pass.
    const live = crypto.randomUUID();
    noteStarted(live);
    const liveMeta = path.join(`${second.dir}-meta`, `${live}.json`);
    fs.writeFileSync(liveMeta, "{}");
    fs.chmodSync(locked, 0o700);
    for (let i = 0; i < 300 && readKey(db.$client, RECONCILE_PENDING_KEY); i++)
      await new Promise((r) => setTimeout(r, 10));
    await app.purge!.idle();
    expect(readKey(db.$client, RECONCILE_PENDING_KEY)).toBeUndefined();
    expect(fs.existsSync(first.meta)).toBe(false);
    expect(fs.existsSync(liveMeta)).toBe(true);
  });

  it("a job whose backoff cannot be written is held in memory: no tight loop on a failing database", async () => {
    let failing = true;
    let calls = 0;
    const w = await world({
      forget: async () => {
        calls++;
        if (failing) {
          w.db.$client.pragma("query_only = ON"); // the outcome cannot be written either
          throw new Error("busy");
        }
      },
    });
    const c = w.app.conversations!.create(w.f.users.owner.id);
    w.session(c.id, "x");
    w.app.purge!.close(); // started by hand below, after the delete
    expect((await w.owner.send("DELETE", `/api/conversations/${c.id}`)).statusCode).toBe(200);
    const purge = new ConversationPurge(w.db, new ConversationStore(w.db), {
      dataDir: w.dataDir,
      runtimes: w.app.runs!["registry"] as RuntimeRegistry,
      retryMs: 50,
      maxRetryMs: 100,
    });
    cleanups.push(() => purge.close());
    purge.resume();
    await new Promise((r) => setTimeout(r, 300));
    // About one try per backoff (50, 100, 100 ms) — not hundreds.
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(calls).toBeLessThanOrEqual(6);
    failing = false;
    w.db.$client.pragma("query_only = OFF");
    for (let i = 0; i < 100 && purge.pendingFor() > 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(purge.pendingFor()).toBe(0);
  });

  it("20 held jobs never keep a due 21st one from running, and nothing spins meanwhile (#54 r3)", async () => {
    const w = await world();
    const sql = w.db.$client;
    const held = Array.from({ length: 20 }, () => crypto.randomUUID());
    const last = crypto.randomUUID();
    const t = Date.now();
    held.forEach((s, i) =>
      sql
        .prepare(
          `INSERT INTO deletion_jobs (id, kind, conversation_id, user_id, runtime, connection_id, external_session_id,
             attempts, next_at, created_at) VALUES (?, 'runtime_session', '', 'u', 'claude-code', 'c', ?, 0, ?, ?)`,
        )
        .run(crypto.randomUUID(), s, t, t - 1000 + i),
    );
    sql
      .prepare(
        `INSERT INTO deletion_jobs (id, kind, conversation_id, user_id, runtime, connection_id, external_session_id,
           attempts, next_at, created_at) VALUES (?, 'runtime_session', '', 'u', 'claude-code', 'c', ?, 0, ?, ?)`,
      )
      .run(crypto.randomUUID(), last, t, t);
    // The first 20 fail with a database that refuses the write; the 21st succeeds once it is its turn.
    let calls = 0;
    let lastDone = false;
    w.app.purge!.close();
    const runtimes = new RuntimeRegistry();
    const fake = new FakeRuntime();
    fake.forget = async (id: string) => {
      calls++;
      if (id === last) {
        sql.pragma("query_only = OFF");
        lastDone = true;
        return;
      }
      sql.pragma("query_only = ON");
      throw new Error("busy");
    };
    runtimes.register(fake);
    fs.mkdirSync(path.join(w.dataDir, "runtimes", "c", "u"), { recursive: true });
    const purge = new ConversationPurge(w.db, new ConversationStore(w.db), {
      dataDir: w.dataDir,
      runtimes,
      retryMs: 5000,
      maxRetryMs: 5000,
    });
    cleanups.push(() => purge.close());
    cleanups.push(() => void sql.pragma("query_only = OFF"));
    let rounds = 0;
    const work = (purge as unknown as { work: () => Promise<void> }).work.bind(purge);
    (purge as unknown as { work: () => Promise<void> }).work = () => {
      rounds++;
      return work();
    };
    purge.resume();
    for (let i = 0; i < 100 && !lastDone; i++) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 100));
    expect(lastDone).toBe(true);
    expect(calls).toBe(21); // each held one tried once — none again within its 5 s hold
    expect(rounds).toBeLessThanOrEqual(25); // one round per hold, then quiet: no spinning
    expect(
      sql.prepare("SELECT count(*) AS n FROM deletion_jobs WHERE external_session_id = ?").get(last),
    ).toEqual({
      n: 0,
    });
  });

  it("a reconciliation job for a session a row owns by the time it runs is dropped: nothing is removed (#54 r4)", async () => {
    const w = await world();
    const c = w.app.conversations!.create(w.f.users.owner.id);
    const owned = w.session(c.id, "OWNED"); // its row exists (saved after the reconciliation saw its files)
    w.db.$client
      .prepare(
        `INSERT INTO deletion_jobs (id, kind, conversation_id, user_id, runtime, connection_id, external_session_id,
           attempts, next_at, created_at) VALUES (?, 'runtime_session', '', ?, 'claude-code', 'conn-1', ?, 0, 0, 0)`,
      )
      .run(crypto.randomUUID(), w.f.users.owner.id, owned.id);
    w.app.purge!.resume();
    await w.app.purge!.idle();
    expect(w.app.purge!.pendingFor()).toBe(0);
    expect(fs.existsSync(owned.file)).toBe(true);
    expect(fs.existsSync(owned.meta)).toBe(true);
  });

  describe("a reconciliation job and a conversation's own job for the same Codex thread (#54 r5)", () => {
    /** A real CodexAdapter on the replayed app-server, in `runtimes/conn-x/<owner>`, and a purge of its own. */
    async function codexWorld() {
      const w = await world();
      w.app.purge!.close();
      const owner = w.f.users.owner.id;
      const dir = path.join(w.dataDir, "runtimes", "conn-x", owner);
      const log = newLog();
      const codex = new CodexAdapter({
        connection: () => ({ id: "conn-x", dir, auth: { kind: "api_key", apiKey: "sk-test-not-real" } }),
        spawn: replaySpawn({}, log),
        bundledCatalog: async () => ({ models: CODEX_MODELS.map((m) => ({ slug: m.id })) }),
        executable: "/nonexistent/codex",
      });
      const runtimes = new RuntimeRegistry();
      runtimes.register(codex);
      // The conversation's runs are quiet only once the session's process has exited.
      let live: { exited?: () => Promise<void> } | undefined;
      let exitedNow = true;
      const store = new ConversationStore(w.db);
      const purge = new ConversationPurge(w.db, store, {
        dataDir: w.dataDir,
        runtimes,
        runs: { quiet: async () => exitedNow },
        retryMs: 20,
        maxRetryMs: 40,
      });
      cleanups.push(() => purge.close());
      const ctx = (conversationId: string) => ({
        conversationId,
        userId: owner,
        connectionId: "conn-x",
        history: [{ role: "user" as const, parts: [{ type: "text" as const, text: "PRIOR-CONTEXT-r5" }] }],
        systemPrompt: "You are Agent Lee.",
        model: CODEX_MODELS[0]!.id,
        tools: [],
      });
      const reconcileJob = (id: string) =>
        w.db.$client
          .prepare(
            `INSERT INTO deletion_jobs (id, kind, conversation_id, user_id, runtime, connection_id,
               external_session_id, attempts, next_at, created_at)
             VALUES (?, 'runtime_session', '', ?, 'codex', 'conn-x', ?, 0, ?, ?)`,
          )
          .run(crypto.randomUUID(), owner, id, Date.now() + 60_000, Date.now());
      const saveRow = (conversationId: string, id: string) =>
        w.db.$client
          .prepare(
            `INSERT INTO runtime_sessions (id, conversation_id, runtime, connection_id, external_session_id,
               conversation_revision) VALUES (?, ?, 'codex', 'conn-x', ?, 0)`,
          )
          .run(crypto.randomUUID(), conversationId, id);
      const files = (id: string) => [
        ...fs
          .readdirSync(path.join(dir, "codex-home"), { recursive: true })
          .map(String)
          .filter((n) => n.includes(id)),
        ...(fs.existsSync(path.join(`${dir}-meta`, `${id}.json`)) ? ["meta"] : []),
      ];
      const deletes = () => log.requests.filter((r) => r.method === "thread/delete").length;
      return {
        w,
        owner,
        codex,
        purge,
        store,
        ctx,
        reconcileJob,
        saveRow,
        files,
        deletes,
        setLive: (s: typeof live) => {
          live = s;
          exitedNow = !s;
        },
        exitLive: async () => {
          await live?.exited?.();
          exitedNow = true;
        },
      };
    }

    it("saved, closed, resumed, then its conversation deleted: the job becomes the conversation's — forgotten once the process exited, one thread/delete", async () => {
      const x = await codexWorld();
      const c = x.store.create(x.owner);
      const s = await x.codex.start(x.ctx(c.id));
      x.reconcileJob(s.externalSessionId); // seen by a reconciliation while it opened
      x.saveRow(c.id, s.externalSessionId);
      await s.close();
      const resumed = await x.codex.resume(s.externalSessionId, x.ctx(c.id));
      x.setLive(resumed);
      x.store.delete(c.id); // its runs dropped: the resumed process is being stopped
      const jobs = x.w.db.$client
        .prepare("SELECT conversation_id AS c FROM deletion_jobs WHERE external_session_id = ?")
        .all(s.externalSessionId);
      expect(jobs).toEqual([{ c: c.id }]); // one job, the conversation's (no longer a possible orphan)
      await new Promise((r) => setTimeout(r, 120)); // retried meanwhile: the process still runs
      expect(x.deletes()).toBe(0);
      expect(x.files(s.externalSessionId).length).toBeGreaterThan(0);
      await resumed.close();
      await x.exitLive();
      for (let i = 0; i < 300 && x.purge.pendingFor() > 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(x.purge.pendingFor()).toBe(0);
      expect(x.deletes()).toBe(1);
      expect(x.files(s.externalSessionId)).toEqual([]);
    });

    it("a reconciliation job for a live session with no row is kept and retried — not dropped — until it is an orphan", async () => {
      const x = await codexWorld();
      const s = await x.codex.start(x.ctx("c-none"));
      x.w.db.$client.prepare("UPDATE deletion_jobs SET next_at = 0").run();
      x.reconcileJob(s.externalSessionId);
      x.w.db.$client.prepare("UPDATE deletion_jobs SET next_at = 0").run();
      x.purge.resume();
      await new Promise((r) => setTimeout(r, 120));
      expect(x.purge.pendingFor()).toBe(1); // live: not now
      expect(x.deletes()).toBe(0);
      expect(x.files(s.externalSessionId).length).toBeGreaterThan(0);
      await s.close();
      await s.exited!();
      for (let i = 0; i < 300 && x.purge.pendingFor() > 0; i++) await new Promise((r) => setTimeout(r, 10));
      expect(x.purge.pendingFor()).toBe(0);
      expect(x.deletes()).toBe(1);
      expect(x.files(s.externalSessionId)).toEqual([]);
    });
  });
});
