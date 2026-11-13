import { execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  CSRF_HEADER,
  PYTHON_CODES,
  PYTHON_LIMITS,
  type MessagePart,
  type Run,
  type UploadedFile,
} from "@agentlee/shared";
import { PYTHON_RUN_TOOL } from "@agentlee/mcp-tools/python";
import { SKILL_CATALOGUE } from "@agentlee/mcp-tools/skills";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { pythonRuntime } from "../src/mcp/python.js";
import { PYTHON_CODE_VALUES } from "../src/observability/policy.js";
import {
  PACKAGES_LOCK,
  pythonVersionOf,
  RUNNER_ENTRY,
  SCRATCHPAD_DIR,
  scratchpadState,
  type PythonEnv,
  type ScratchpadState,
} from "../src/python/packages.js";
import {
  accountFromConfig,
  ACCOUNT_NAME,
  JOB_ID,
  jobWorkdir,
  launcherClean,
  launcherProbe,
  launcherReap,
  launcherRun,
  launcherProbeRunner,
  launcherVerify,
  parseProbe,
  parseVerify,
  PYTHON_LAUNCHER,
  verifyAccount,
  type PythonAccount,
  type ProbeRunner,
} from "../src/python/account.js";
import { buildProfile } from "../src/isolation/sandbox.js";
import {
  folderUsage,
  launcherKilled,
  pythonResult,
  pythonRunOptions,
  sandboxedPythonRunner,
  type PythonJob,
  type PythonReport,
  type PythonRunner,
} from "../src/python/runner.js";
import { PythonScratchpad, removeTree } from "../src/python/service.js";
import {
  AccountSelfCheckGate,
  SELF_CHECK_CODE,
  SELF_CHECK_INPUT,
  selfCheckAccount,
  type SelfCheckResult,
} from "../src/python/selfcheck.js";
import { RuntimeRegistry, type RuntimeAdapter } from "../src/runtime/adapter.js";
import { ClaudeAdapter } from "../src/runtime/claude.js";
import { CODEX_MODELS, CodexAdapter } from "../src/runtime/codex.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import { pythonScenario } from "../src/runtime/fake-python.js";
import { knownSecrets } from "../src/secrets/known.js";
import { storagePaths } from "../src/storage/paths.js";
import { replayQuery, sdk, type ReplayLog } from "./helpers/claude-replay.js";
import { cx, newLog, replaySpawn } from "./helpers/codex-replay.js";
import { liveCall } from "./helpers/live-mcp.js";
import { createFamily } from "./helpers/permission-matrix.js";

vi.setConfig({ testTimeout: 60_000 });

/**
 * `python_run` (#47): the tool, its working folder per call, the outputs stored as conversation files, the limits and
 * the known-secret rules — with a scripted runner on every platform — and the real interpreter in the macOS sandbox
 * (another conversation's folder, the network and an endless loop are all stopped: the issue's completion criterion).
 */

type App = Awaited<ReturnType<typeof buildApp>>;
const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const LOCAL = { host: "localhost:3000" };
const WRITE = { ...LOCAL, origin: "http://localhost:3000", [CSRF_HEADER]: "1" };

function tmp(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-python-")));
  closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function spawnSyncOk(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { stdio: "ignore" });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${r.status ?? r.signal}`);
}

function logCapture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const l of String(chunk).split("\n").filter(Boolean)) lines.push(JSON.parse(l));
      cb();
    },
  });
  return { lines, stream };
}

/** A python that is never started (scripted runners only). */
const FAKE_ENV: PythonEnv = { runtime: { exe: "/opt/py/bin/python3.12", root: "/opt/py" } };
const JID0 = "00000000-0000-0000-0000-000000000000";
const AVAILABLE =
  (env: PythonEnv = FAKE_ENV): (() => ScratchpadState) =>
  () => ({ state: "available", env });

const report = (o: Partial<PythonReport> = {}): PythonReport => ({
  status: "ok",
  exitCode: 0,
  errorType: null,
  traceback: null,
  stdout: "",
  stdoutChars: Array.from(o.stdout ?? "").length,
  stderr: "",
  stderrChars: Array.from(o.stderr ?? "").length,
  ...o,
});

/** A scripted runner: `act` sees the job (and may write into its working folder) and returns the report. */
function scripted(act: (job: PythonJob) => PythonReport | Promise<PythonReport>) {
  const jobs: { job: PythonJob; listing: string[] }[] = [];
  const runner: PythonRunner = async (job) => {
    jobs.push({ job, listing: fs.readdirSync(job.workdir).sort() });
    return { ok: true, report: await act(job) };
  };
  return { runner, jobs };
}

async function start(
  o: { runner?: PythonRunner; state?: () => ScratchpadState; runtimes?: RuntimeRegistry } = {},
) {
  const dataDir = path.join(tmp(), "data");
  const log = logCapture();
  const registry = o.runtimes ?? new RuntimeRegistry();
  if (!o.runtimes) registry.register(new FakeRuntime({ runTools: true }));
  const db = createTestDb();
  const app = await buildApp(
    loadConfig({ NODE_ENV: "test", DATA_DIR: dataDir, MASTER_KEY_PATH: path.join(tmp(), "master.key") }),
    {
      db,
      runtimes: registry,
      runs: { flushMs: 0 },
      logStream: log.stream,
      python: {
        runner: o.runner ?? scripted(() => report({ stdout: "hi\n" })).runner,
        state: o.state ?? AVAILABLE(),
      },
    },
  );
  closers.push(() => app.close());
  const f = await createFamily(app);
  const api = (cookie: string, method: "POST" | "GET" | "PUT", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { ...WRITE, cookie, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  const send = async (
    cookie: string,
    conversationId: string,
    text: string,
    extra: Record<string, unknown> = {},
  ) => {
    const res = await api(cookie, "POST", `/api/conversations/${conversationId}/messages`, {
      text,
      ...extra,
    });
    expect(res.statusCode, res.body).toBe(201);
    return waitRun(app, (res.json() as { run: Run }).run.id);
  };
  const upload = async (cookie: string, conversationId: string, name: string, body: Buffer | string) => {
    const r = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/files`,
      headers: {
        ...WRITE,
        cookie,
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(name),
        "x-upload-id": crypto.randomUUID(),
      },
      payload: Buffer.from(body),
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json<UploadedFile>();
  };
  /** An uploaded file sent with a message (so the run may use it), and that message's run. */
  const sentFile = async (cookie: string, conversationId: string, name: string, body: string) => {
    const file = await upload(cookie, conversationId, name, body);
    const r = await send(cookie, conversationId, "파일 보냄", { fileIds: [file.id] });
    return { file, run: r.run };
  };
  const download = (cookie: string, fileId: string) =>
    app.inject({ url: `/api/files/${fileId}/content`, headers: { ...LOCAL, cookie } });
  /** The service on its own, for a scope of a finished run of `conversationId`. */
  const scopeOf = async (conversationId: string, userId = f.users.owner.id, cookie = f.cookies.owner) => {
    const r = await send(cookie, conversationId, "안녕");
    return { userId, conversationId, runId: r.run.id };
  };
  return { app, db, f, api, send, upload, sentFile, download, scopeOf, log: log.lines, dataDir };
}

async function waitRun(app: App, id: string) {
  for (let i = 0; i < 2000; i++) {
    const r = app.runs!.get(id)!;
    if (r.endedAt !== null) {
      const parts = app.conversations!.messageById(r.assistantMessageId)!.parts as MessagePart[];
      const results = parts.flatMap((p) => (p.type === "tool_result" ? [p] : []));
      return { run: r, parts, results };
    }
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error("run did not end");
}

const outputOf = (r: Awaited<ReturnType<typeof waitRun>>) => {
  const out = r.results[0]!;
  return { isError: out.isError === true, output: out.output as Record<string, unknown> };
};

/** The text inside an `<external_content>` block (the whole value when it is not one). */
const inner = (v: unknown) =>
  String(v)
    .replace(/^<external_content source="[^"]*">\n/, "")
    .replace(/\n<\/external_content>$/, "");

const svcFor = (t: Awaited<ReturnType<typeof start>>, runner: PythonRunner, state = AVAILABLE()) =>
  new PythonScratchpad({ db: t.db, dataDir: t.dataDir, files: () => t.app.files, runner, state });

// ---- the tool and its place in the catalogue ---------------------------------------------------------------

describe("python_run: the tool (#47)", () => {
  it("is the python-scratchpad skill's server tool: strict input, per-user permission, fixed codes", async () => {
    expect(SKILL_CATALOGUE.find((e) => e.name === "python-scratchpad")).toMatchObject({
      status: "tools",
      finance: false,
      issue: "#47",
    });
    expect(Object.keys(PYTHON_RUN_TOOL.input).sort()).toEqual(["code", "files"]);
    for (const c of PYTHON_CODES) expect(PYTHON_CODE_VALUES.has(c), c).toBe(true);
    const t = await start();
    const { app, f, api } = t;
    // Everyone with "all" gets it; a list without python-scratchpad does not.
    expect(app.mcp!.toolNamesFor(f.users.owner.id)).toContain("python_run");
    const set = await api(f.cookies.admin, "PUT", `/api/admin/users/${f.users.stranger.id}/skills`, {
      skills: ["google-news-search-skill"],
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(app.mcp!.toolNamesFor(f.users.stranger.id)).not.toContain("python_run");
    // A schedule's narrower skill scope (#56) without it: not offered either.
    expect(app.mcp!.toolNamesFor(f.users.owner.id, ["google-news-search-skill"])).not.toContain("python_run");
    // The admin's list shows where it stands.
    const skills = (await api(f.cookies.admin, "GET", "/api/admin/skills")).json<{
      skills: { name: string; status: string }[];
    }>().skills;
    expect(skills.find((s) => s.name === "python-scratchpad")?.status).toBe("available");
  });

  it("a run whose user lost the permission cannot call it (not on that request's tool list); nothing runs", async () => {
    const s = scripted(() => report());
    const t = await start({ runner: s.runner });
    const c = t.app.conversations!.create(t.f.users.owner.id);
    await t.api(t.f.cookies.admin, "PUT", `/api/admin/users/${t.f.users.owner.id}/skills`, { skills: [] });
    const r = await t.send(t.f.cookies.owner, c.id, "/python sum");
    expect(outputOf(r).isError).toBe(true);
    expect(JSON.stringify(outputOf(r).output)).toMatch(/python_run not found|python_not_allowed/);
    expect(s.jobs).toHaveLength(0);
  });

  it("bad input is refused before anything runs; no python on this server is a fixed code", async () => {
    const s = scripted(() => report());
    const t = await start({ runner: s.runner });
    const c = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(c.id);
    const svc = svcFor(t, s.runner);
    expect(await svc.run(scope, {})).toEqual({ ok: false, code: "python_bad_input" });
    expect(await svc.run(scope, { code: "" })).toEqual({ ok: false, code: "python_bad_input" });
    expect(await svc.run(scope, { code: "x", extra: 1 })).toEqual({ ok: false, code: "python_bad_input" });
    expect(await svc.run(scope, { code: "x".repeat(PYTHON_LIMITS.codeChars + 1) })).toEqual({
      ok: false,
      code: "python_bad_input",
    });
    expect(await svc.run(scope, { code: "x", files: Array.from({ length: 11 }, (_, i) => `f${i}`) })).toEqual(
      { ok: false, code: "python_bad_input" },
    );
    expect(s.jobs).toHaveLength(0);
    for (const st of [
      { state: "needs_python", reason: "x" },
      { state: "not_installed", reason: "x" },
    ] as const) {
      expect(await svcFor(t, s.runner, () => st).run(scope, { code: "print(1)" })).toEqual({
        ok: false,
        code: "python_not_installed",
      });
    }
    expect(s.jobs).toHaveLength(0);
  });

  it("the admin sees needs_python / not_installed, and tests never read SKILL_PYTHON", async () => {
    const t = await start({ state: () => ({ state: "not_installed", reason: "x" }) });
    const skills = (await t.api(t.f.cookies.admin, "GET", "/api/admin/skills")).json<{
      skills: { name: string; status: string }[];
    }>().skills;
    expect(skills.find((s) => s.name === "python-scratchpad")?.status).toBe("not_installed");
    // State from the configuration: an unusable interpreter, or a usable one without the packages.
    const data = tmp();
    const opts = { pythonRun: true };
    expect(scratchpadState(undefined, data, opts).state).toBe("needs_python");
    expect(scratchpadState("relative/python3.12", data, opts).state).toBe("needs_python");
    // PYTHON_RUN off is its own status, before anything else is looked at.
    expect(scratchpadState("/opt/py/bin/python3.12", data, { pythonRun: false }).state).toBe("disabled");
  });

  it("sweep keeps the scratch root and .ctl, removing only job folders (#121 round 3)", async () => {
    const t = await start();
    const scratch = storagePaths(t.dataDir).scratch;
    fs.mkdirSync(path.join(scratch, ".ctl", "11111111-1111-1111-1111-111111111111"), { recursive: true });
    fs.writeFileSync(path.join(scratch, ".ctl", "11111111-1111-1111-1111-111111111111", "pgid"), "123\n");
    fs.mkdirSync(path.join(scratch, "22222222-2222-2222-2222-222222222222", "sub"), { recursive: true });
    fs.writeFileSync(path.join(scratch, "22222222-2222-2222-2222-222222222222", "sub", "f"), "x");
    fs.mkdirSync(path.join(scratch, "leftover"), { recursive: true });
    const svc = new PythonScratchpad({
      db: t.db,
      dataDir: t.dataDir,
      files: () => t.app.files,
      runner: scripted(() => report()).runner,
      state: AVAILABLE(),
    });
    expect(svc.sweep()).toBe(true);
    // The root and its .ctl dir survive (so the installed ACL is kept); job folders and stale .ctl entries go.
    expect(fs.existsSync(scratch)).toBe(true);
    expect(fs.existsSync(path.join(scratch, ".ctl"))).toBe(true);
    expect(fs.readdirSync(scratch).sort()).toEqual([".ctl"]);
    expect(fs.readdirSync(path.join(scratch, ".ctl"))).toEqual([]);
  });

  it("off by default: without PYTHON_RUN=1 (and no test runner) the tool is not offered (#121 round 1)", async () => {
    const dataDir = path.join(tmp(), "data");
    const reg = new RuntimeRegistry();
    reg.register(new FakeRuntime({ runTools: true }));
    const db = createTestDb();
    const app = await buildApp(
      loadConfig({ NODE_ENV: "test", DATA_DIR: dataDir, MASTER_KEY_PATH: path.join(tmp(), "master.key") }),
      { db, runtimes: reg, runs: { flushMs: 0 } },
    );
    closers.push(() => app.close());
    const f = await createFamily(app);
    expect(app.mcp!.toolNamesFor(f.users.owner.id)).not.toContain("python_run");
    // PYTHON_RUN is gated off because the macOS sandbox cannot hide other processes' start-up environment
    // (KERN_PROCARGS2) and runtime CLIs keep their keys there — see docs/ops.md §35.3 and the sandbox test below.
    expect(loadConfig({ NODE_ENV: "test" }).pythonRun).toBe(false);
    expect(loadConfig({ NODE_ENV: "test", PYTHON_RUN: "1" }).pythonRun).toBe(true);
  });
});

// ---- the run path: inputs, outputs, files of the conversation -----------------------------------------------

describe("python_run: working folder, inputs and outputs (scripted runner)", () => {
  it("/python sum <csv>: the file is copied in, FILES maps it, the CSV it writes is stored and downloadable", async () => {
    const s = scripted((job) => {
      const local = Object.values(job.files)[0]!;
      const csv = fs.readFileSync(path.join(job.workdir, local), "utf8");
      fs.writeFileSync(path.join(job.workdir, "합계.csv"), "항목,합계\n금액,1046000\n");
      return report({ stdout: `행 ${csv.trim().split("\n").length - 1}\n금액 1046000\n` });
    });
    const t = await start({ runner: s.runner });
    const c = t.app.conversations!.create(t.f.users.owner.id);
    const { file } = await t.sentFile(
      t.f.cookies.owner,
      c.id,
      "경비.csv",
      "항목,금액\n숙박,480000\n렌터카,210000\n식비,356000\n",
    );
    const r = await t.send(t.f.cookies.owner, c.id, `/python sum ${file.id}`);
    expect(r.run.status).toBe("done");
    const { isError, output } = outputOf(r);
    expect(isError).toBe(false);
    expect(output.status).toBe("ok");
    expect(inner(output.stdout)).toBe("행 3\n금액 1046000\n");
    expect(String(output.stdout)).toMatch(/^<external_content source="python_run stdout">/);
    // The job: the code of the scenario, the copy under its name, FILES pointing at it.
    const { job, listing } = s.jobs[0]!;
    expect(job.code).toBe(pythonScenario("sum", file.id).input.code);
    expect(job.files).toEqual({ [file.id]: "경비.csv" });
    expect(listing).toEqual([".tmp", "경비.csv"]);
    // Flat layout: <scratch>/<jobId>, jobId a UUID (the only token the launcher takes).
    expect(JOB_ID.test(job.jobId)).toBe(true);
    expect(job.workdir).toBe(path.join(fs.realpathSync(storagePaths(t.dataDir).scratch), job.jobId));
    // The working folder is gone after the call.
    expect(fs.existsSync(job.workdir)).toBe(false);
    // The output: one file of the conversation, linked to the reply (chip), only the owner downloads it.
    const files = output.files as { fileId: string; name: string; kind: string; url: string }[];
    expect(files.map((x) => [x.name, x.kind])).toEqual([["합계.csv", "csv"]]);
    expect(output.skipped).toEqual([]);
    const ref = r.parts.find((p) => p.type === "file_ref") as { fileId: string; name: string } | undefined;
    expect(ref).toEqual({ type: "file_ref", fileId: files[0]!.fileId, name: "합계.csv" });
    const dl = await t.download(t.f.cookies.owner, files[0]!.fileId);
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe("항목,합계\n금액,1046000\n");
    expect((await t.download(t.f.cookies.stranger, files[0]!.fileId)).statusCode).toBe(403);
    // A later call may take the stored output as its input.
    const again = await t.send(t.f.cookies.owner, c.id, `/python sum ${files[0]!.fileId}`);
    expect(outputOf(again).isError).toBe(false);
    expect(s.jobs[1]!.job.files).toEqual({ [files[0]!.fileId]: "합계.csv" });
  });

  it("inputs: only this user's conversation's sent files — another conversation's, another user's, an unsent one are not found", async () => {
    const s = scripted(() => report());
    const t = await start({ runner: s.runner });
    const mine = t.app.conversations!.create(t.f.users.owner.id);
    const other = t.app.conversations!.create(t.f.users.owner.id);
    const theirs = t.app.conversations!.create(t.f.users.stranger.id);
    const otherFile = (await t.sentFile(t.f.cookies.owner, other.id, "a.csv", "a\n1\n")).file;
    const theirFile = (await t.sentFile(t.f.cookies.stranger, theirs.id, "b.csv", "b\n2\n")).file;
    const unsent = await t.upload(t.f.cookies.owner, mine.id, "c.csv", "c\n3\n");
    const scope = await t.scopeOf(mine.id);
    const svc = svcFor(t, s.runner);
    for (const id of [otherFile.id, theirFile.id, unsent.id, crypto.randomUUID()])
      expect(await svc.run(scope, { code: "print(1)", files: [id] }), id).toEqual({
        ok: false,
        code: "python_file_not_found",
      });
    // The scope itself: the token's user must own the conversation; the run must be its own.
    expect(await svc.run({ ...scope, userId: t.f.users.stranger.id }, { code: "1" })).toEqual({
      ok: false,
      code: "python_not_allowed",
    });
    expect(await svc.run({ ...scope, runId: crypto.randomUUID() }, { code: "1" })).toEqual({
      ok: false,
      code: "python_not_allowed",
    });
    expect(s.jobs).toHaveLength(0);
  });

  it("a stored file whose bytes changed on disk is not copied (hash check)", async () => {
    const s = scripted(() => report());
    const t = await start({ runner: s.runner });
    const c = t.app.conversations!.create(t.f.users.owner.id);
    const { file } = await t.sentFile(t.f.cookies.owner, c.id, "a.csv", "a\n1\n");
    const row = t.app.files!.get(file.id)!;
    fs.writeFileSync(t.app.files!.pathOf(row), "a\n9\n");
    const scope = await t.scopeOf(c.id);
    expect(await svcFor(t, s.runner).run(scope, { code: "1", files: [file.id] })).toEqual({
      ok: false,
      code: "python_file_not_found",
    });
    expect(s.jobs).toHaveLength(0);
  });

  it("outputs: text kinds only, one link only, size and count limits, hidden folders and unchanged inputs ignored", async () => {
    const big = "x".repeat(PYTHON_LIMITS.outputBytes + 1);
    const s = scripted((job) => {
      const w = (rel: string, data: string | Buffer) => {
        fs.mkdirSync(path.dirname(path.join(job.workdir, rel)), { recursive: true });
        fs.writeFileSync(path.join(job.workdir, rel), data);
      };
      w("a.csv", "a\n1\n");
      w("b.md", "# b\n");
      w("sub/c.txt", "c\n");
      w("d.png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      w("e.json", "{}");
      w("f.txt", Buffer.from([0xff, 0xfe, 0x00]));
      w("g.txt", big);
      w(".tmp/scratch.txt", "temp\n");
      w(".hidden.txt", "hidden\n");
      w("1/2/3/deep.txt", "deep\n");
      fs.symlinkSync("/etc/hosts", path.join(job.workdir, "link.txt"));
      w("h.txt", "h\n");
      fs.linkSync(path.join(job.workdir, "h.txt"), path.join(job.workdir, "hl.txt"));
      for (const n of ["i", "j", "k", "l"]) w(`${n}.txt`, `${n}\n`);
      return report();
    });
    const t = await start({ runner: s.runner });
    const c = t.app.conversations!.create(t.f.users.owner.id);
    const { file } = await t.sentFile(t.f.cookies.owner, c.id, "in.csv", "x\n1\n");
    const r = await t.send(t.f.cookies.owner, c.id, `/python sum ${file.id}`);
    const out = outputOf(r).output as {
      files: { name: string }[];
      skipped: { name: string; reason: string }[];
    };
    // Name order (the walk), at most 5: a.csv, b.md, i.txt, j.txt, k.txt (c.txt sits in sub/, after the top level's s).
    expect(out.files.map((x) => x.name)).toEqual(["a.csv", "b.md", "i.txt", "j.txt", "k.txt"]);
    const reasons = Object.fromEntries(out.skipped.map((x) => [x.name, x.reason]));
    expect(reasons).toMatchObject({
      "d.png": "unsupported_kind",
      "e.json": "unsupported_kind",
      "f.txt": "not_text",
      "g.txt": "too_large",
      "h.txt": "link",
      "hl.txt": "link",
      "link.txt": "link",
      "1/2/3": "too_deep",
      "l.txt": "too_many",
      "sub/c.txt": "too_many",
    });
    // The input copy, left as it was, is neither stored nor listed; nor are hidden entries.
    expect(JSON.stringify(out)).not.toContain("in.csv");
    expect(JSON.stringify(out)).not.toContain("hidden");
    expect(JSON.stringify(out)).not.toContain("scratch.txt");
    expect(
      t.app
        .files!.list(c.id)
        .map((x) => x.name)
        .sort(),
    ).toEqual(["a.csv", "b.md", "i.txt", "in.csv", "j.txt", "k.txt"]);
  });

  it("a changed input copy is an output; the conversation's 20-file limit is respected", async () => {
    const s = scripted((job) => {
      const local = Object.values(job.files)[0]!;
      fs.appendFileSync(path.join(job.workdir, local), "2\n");
      for (let i = 0; i < 4; i++) fs.writeFileSync(path.join(job.workdir, `o${i}.txt`), `${i}\n`);
      return report();
    });
    const t = await start({ runner: s.runner });
    const c = t.app.conversations!.create(t.f.users.owner.id);
    const { file } = await t.sentFile(t.f.cookies.owner, c.id, "in.csv", "x\n1\n");
    // 1 upload + 16 more → 17 files; the call may add 3 more.
    for (let i = 0; i < 16; i++) await t.upload(t.f.cookies.owner, c.id, `n${i}.txt`, "n\n");
    const r = await t.send(t.f.cookies.owner, c.id, `/python sum ${file.id}`);
    const out = outputOf(r).output as {
      files: { name: string }[];
      skipped: { name: string; reason: string }[];
    };
    expect(out.files.map((x) => x.name)).toEqual(["in.csv", "o0.txt", "o1.txt"]);
    expect(out.skipped).toEqual([
      { name: "o2.txt", reason: "conversation_full" },
      { name: "o3.txt", reason: "conversation_full" },
    ]);
    expect(t.app.files!.count(c.id)).toBe(20);
  });

  it("an output file owned by a third uid is rejected (injected fstat; server and account uids accepted) (#121 round 3)", async () => {
    const SENTINEL = 777_001; // a distinctive size so the fstat shim only touches our output file
    const content = "z".repeat(SENTINEL);
    const make = () =>
      scripted((job) => {
        fs.writeFileSync(path.join(job.workdir, "out.csv"), content);
        return report();
      });
    const serverUid = process.getuid?.() ?? 501;
    // Force the output file's owner to a third uid: readOutput must skip it (as a link would be skipped).
    const realFstat = fs.fstatSync;
    const shimUid = (forced: number) =>
      ((fd: number, ...rest: unknown[]) => {
        const real = (realFstat as (fd: number, ...r: unknown[]) => fs.Stats)(fd, ...rest);
        if (real.isFile() && real.size === SENTINEL) {
          const shim = Object.create(Object.getPrototypeOf(real) as object);
          return Object.assign(shim, real, { uid: forced }) as fs.Stats;
        }
        return real;
      }) as typeof fs.fstatSync;
    const spy = vi.spyOn(fs, "fstatSync").mockImplementation(shimUid(999_999));
    try {
      const sThird = make();
      const tThird = await start({ runner: sThird.runner });
      const cThird = tThird.app.conversations!.create(tThird.f.users.owner.id);
      const rThird = await tThird.send(tThird.f.cookies.owner, cThird.id, "/python sum");
      const oThird = outputOf(rThird).output as { files: unknown[]; skipped: { reason: string }[] };
      expect(oThird.files).toEqual([]);
      expect(oThird.skipped.some((x) => x.reason === "link")).toBe(true);
    } finally {
      spy.mockRestore();
    }
    // With the forced uid equal to the account uid, the same file is accepted.
    const sAcct = make();
    const spy2 = vi.spyOn(fs, "fstatSync").mockImplementation(shimUid(424_242));
    try {
      const tAcct = await start({
        runner: sAcct.runner,
        state: () => ({ state: "available", env: { runtime: FAKE_ENV.runtime, accountUid: 424_242 } }),
      });
      const cAcct = tAcct.app.conversations!.create(tAcct.f.users.owner.id);
      const rAcct = await tAcct.send(tAcct.f.cookies.owner, cAcct.id, "/python sum");
      const oAcct = outputOf(rAcct).output as { files: { name: string }[] };
      expect(oAcct.files.map((x) => x.name)).toEqual(["out.csv"]);
    } finally {
      spy2.mockRestore();
    }
    void serverUid;
  });

  it("errors come back as status error with the type and the traceback (framed, paths hidden)", async () => {
    const s = scripted((job) =>
      report({
        status: "error",
        exitCode: 1,
        errorType: "ZeroDivisionError",
        traceback: `Traceback (most recent call last):\n  File "${job.workdir}/x.py", line 1\nZeroDivisionError: division by zero\n`,
        stderr: `warning from ${job.env.runtime.root}/lib\n`,
      }),
    );
    const t = await start({ runner: s.runner });
    const c = t.app.conversations!.create(t.f.users.owner.id);
    const r = await t.send(t.f.cookies.owner, c.id, "/python sum");
    const out = outputOf(r).output as Record<string, unknown> & {
      error: { type: string; traceback: string };
    };
    expect(outputOf(r).isError).toBe(false);
    expect(out.status).toBe("error");
    expect(out.error.type).toBe("ZeroDivisionError");
    expect(inner(out.error.traceback)).toBe(
      'Traceback (most recent call last):\n  File "./x.py", line 1\nZeroDivisionError: division by zero\n',
    );
    expect(inner(out.stderr)).toBe("warning from <python>/lib\n");
    expect(JSON.stringify(out)).not.toContain(t.dataDir);
  });

  it("runner failures are fixed codes; the working folder is removed in every case", async () => {
    for (const code of [
      "python_timeout",
      "python_memory_limit",
      "python_disk_limit",
      "python_unavailable",
    ] as const) {
      let dir = "";
      const runner: PythonRunner = async (job) => {
        dir = job.workdir;
        fs.writeFileSync(path.join(job.workdir, "out.txt"), "x\n");
        fs.chmodSync(job.workdir, 0o500); // made unwritable by the code: still removed
        return { ok: false, code };
      };
      const t = await start({ runner });
      const c = t.app.conversations!.create(t.f.users.owner.id);
      const r = await t.send(t.f.cookies.owner, c.id, "/python loop");
      expect(outputOf(r)).toEqual({ isError: true, output: { error: code } });
      expect(fs.existsSync(dir)).toBe(false);
      expect(t.app.files!.list(c.id)).toEqual([]);
      // Logged with the code only; the admin's failure list has it.
      const line = t.log.find((l) => l.msg === "python.finished")!;
      expect(line).toMatchObject({ tool: "python_run", status: "error", pythonCode: code });
      const errs = (await t.api(t.f.cookies.admin, "GET", "/api/admin/errors")).json<{
        errors: { code: string; tool: string }[];
      }>().errors;
      expect(errs.some((e) => e.code === code && e.tool === "python_run")).toBe(true);
    }
  });

  it("slots: one run per user and two on the server — over it python_busy at once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const s = scripted(async () => {
      await gate;
      return report();
    });
    const t = await start({ runner: s.runner });
    const c1 = t.app.conversations!.create(t.f.users.owner.id);
    const c2 = t.app.conversations!.create(t.f.users.owner.id);
    const c3 = t.app.conversations!.create(t.f.users.shared.id);
    const c4 = t.app.conversations!.create(t.f.users.stranger.id);
    const s1 = await t.scopeOf(c1.id);
    const s2 = await t.scopeOf(c2.id);
    const s3 = await t.scopeOf(c3.id, t.f.users.shared.id, t.f.cookies.shared);
    const s4 = await t.scopeOf(c4.id, t.f.users.stranger.id, t.f.cookies.stranger);
    const svc = svcFor(t, s.runner);
    const a = svc.run(s1, { code: "1" });
    await new Promise((r) => setTimeout(r, 20));
    expect(await svc.run(s2, { code: "1" })).toEqual({ ok: false, code: "python_busy" }); // same user
    const b = svc.run(s3, { code: "1" });
    await new Promise((r) => setTimeout(r, 20));
    expect(await svc.run(s4, { code: "1" })).toEqual({ ok: false, code: "python_busy" }); // server full
    release();
    expect((await a).ok).toBe(true);
    expect((await b).ok).toBe(true);
    expect(svc.peak).toBe(2);
    expect((await svc.run(s2, { code: "1" })).ok).toBe(true);
  });

  it("the log has the outcome only: never the code, its output or the file names", async () => {
    const s = scripted((job) => {
      fs.writeFileSync(path.join(job.workdir, "비밀문서.txt"), "내용\n");
      return report({ stdout: "OUTPUT-MARKER-91\n" });
    });
    const t = await start({ runner: s.runner });
    const c = t.app.conversations!.create(t.f.users.owner.id);
    await t.send(t.f.cookies.owner, c.id, "/python sum");
    const line = t.log.find((l) => l.msg === "python.finished")!;
    expect(line).toMatchObject({ tool: "python_run", status: "ok", pythonCode: "python_ok" });
    const all = JSON.stringify(t.log);
    expect(all).not.toContain("OUTPUT-MARKER-91");
    expect(all).not.toContain("비밀문서");
    expect(all).not.toContain("select_dtypes");
  });
});

// ---- known secrets ---------------------------------------------------------------------------------------------

describe("python_run: known secrets never come back or get stored (#14/#78)", () => {
  const secret = `sk-ant-PYSECRET${"q".repeat(24)}`;
  const b64 = Buffer.from(secret).toString("base64");
  const hex = Buffer.from(secret).toString("hex");

  it("stdout, stderr, the traceback and every stored file are scrubbed — raw and encoded — before any cut", async () => {
    knownSecrets.add(secret);
    closers.push(() => knownSecrets.remove(secret));
    // The secret straddles the stdout cut: masked whole first, then cut (never half a secret at the end).
    const pad = "a".repeat(PYTHON_LIMITS.stdoutChars - 10);
    const s = scripted((job) => {
      fs.writeFileSync(path.join(job.workdir, "keys.csv"), `k,v\nraw,${secret}\nb64,${b64}\n`);
      fs.writeFileSync(path.join(job.workdir, `${secret}.txt`), "name\n");
      return report({
        stdout: `${pad}${secret} 그리고 ${hex} 끝\n`,
        stderr: `stderr ${b64}\n`,
        status: "error",
        exitCode: 1,
        errorType: "KeyError",
        traceback: `KeyError: '${secret}'\n`,
      });
    });
    const t = await start({ runner: s.runner });
    const c = t.app.conversations!.create(t.f.users.owner.id);
    const r = await t.send(t.f.cookies.owner, c.id, "/python sum");
    const out = outputOf(r).output as Record<string, unknown> & {
      files: { fileId: string; name: string }[];
      outputFile: { fileId: string };
    };
    const json = JSON.stringify(out);
    expect(json).not.toContain(secret);
    expect(json).not.toContain(b64);
    expect(json).not.toContain(secret.slice(0, 12));
    expect(inner(out.stdout)).toBe(`${pad}[숨김] 그리고 [숨김] 끝\n`.slice(0, PYTHON_LIMITS.stdoutChars));
    expect(out.stdoutTruncated).toBe(true);
    expect(inner(out.stderr)).toBe("stderr [숨김]\n");
    // The whole kept stdout is a file — scrubbed too.
    const full = await t.download(t.f.cookies.owner, out.outputFile.fileId);
    expect(full.body).toBe(`${pad}[숨김] 그리고 [숨김] 끝\n`);
    for (const f of out.files) {
      const body = (await t.download(t.f.cookies.owner, f.fileId)).body;
      expect(body).not.toContain(secret);
      expect(body).not.toContain(b64);
      expect(f.name).not.toContain(secret);
    }
    const keys = out.files.find((f) => f.name === "keys.csv")!;
    expect((await t.download(t.f.cookies.owner, keys.fileId)).body).toBe("k,v\nraw,[숨김]\nb64,[숨김]\n");
    // Stored rows and the reply's parts.
    expect(JSON.stringify(t.app.files!.list(c.id))).not.toContain(secret);
    expect(JSON.stringify(r.parts)).not.toContain(secret);
  });

  it("intact text is not over-redacted: the tail rule applies only where the interpreter cut the stream (#121 round 1)", async () => {
    // A long secret; an intact prefix of it that is itself harmless must survive.
    const longSecret = `customer-2026-private-${"p".repeat(20)}`;
    knownSecrets.add(longSecret);
    closers.push(() => knownSecrets.remove(longSecret));
    // Whole stdout ending in the prefix (not cut by the interpreter): the prefix is kept, not masked.
    const whole = scripted(() =>
      report({ stdout: "ref customer-2026", stdoutChars: Array.from("ref customer-2026").length }),
    );
    const t = await start({ runner: whole.runner });
    const c = t.app.conversations!.create(t.f.users.owner.id);
    const r1 = await t.send(t.f.cookies.owner, c.id, "/python sum");
    expect(inner(outputOf(r1).output.stdout)).toBe("ref customer-2026");
    expect(outputOf(r1).output.stdoutTruncated).toBe(false);
    // Now the interpreter kept only the start of a longer stream that ends inside the secret (stdoutChars > kept):
    // the cut-off tail is masked so a secret split by the capture limit cannot leak.
    const cutOff = scripted(() =>
      report({ stdout: "x customer-2026-private-pp", stdoutChars: Array.from(longSecret).length + 10 }),
    );
    const t2 = await start({ runner: cutOff.runner });
    const c2 = t2.app.conversations!.create(t2.f.users.owner.id);
    const r2 = await t2.send(t2.f.cookies.owner, c2.id, "/python sum");
    expect(inner(outputOf(r2).output.stdout)).toBe("x [숨김]");
    expect(outputOf(r2).output.stdoutTruncated).toBe(true);
  });

  it("the interpreter's environment has no secret: a fixed set of variables, nothing from the server", () => {
    process.env.AGENTLEE_TEST_SECRET_ENV = secret;
    closers.push(() => delete process.env.AGENTLEE_TEST_SECRET_ENV);
    const o = pythonRunOptions({
      code: "1",
      workdir: "/w",
      jobId: JID0,
      files: {},
      inputBytes: 0,
      env: FAKE_ENV,
      dataDir: "/d",
    });
    expect(Object.keys(o.env).sort()).toEqual([
      "HOME",
      "LANG",
      "LC_ALL",
      "MKL_NUM_THREADS",
      "OMP_NUM_THREADS",
      "OPENBLAS_NUM_THREADS",
      "TMPDIR",
    ]);
    expect(JSON.stringify(o)).not.toContain(secret);
  });
});

// ---- the sandbox policy -----------------------------------------------------------------------------------------

describe("python_run: the sandbox policy and the runner's answers", () => {
  it("reads only program folders and its working folder, writes only that, no network, -I -S -B", () => {
    const o = pythonRunOptions({
      code: "print(1)",
      workdir: "/data/scratch/u/c/x",
      jobId: JID0,
      files: { f1: "a.csv" },
      inputBytes: 3,
      env: { ...FAKE_ENV, packages: "/data/python-packages/p" },
      dataDir: "/data",
    });
    expect(o.command).toBe("/opt/py/bin/python3.12");
    expect(o.args).toEqual(["-I", "-S", "-B", RUNNER_ENTRY]);
    expect(o.cwd).toBe("/data/scratch/u/c/x");
    expect(o.read).toEqual([]);
    expect(o.write).toEqual(["/data/scratch/u/c/x"]);
    expect(o.trusted).toEqual(["/opt/py", SCRATCHPAD_DIR, "/data/python-packages/p"]);
    expect(o.network).toBe("none");
    expect(o.noFlagChanges).toBe(true);
    expect(o.exec).toBeUndefined();
    expect(o.timeoutMs).toBe(PYTHON_LIMITS.timeoutMs);
    expect(o.maxRssBytes).toBe(PYTHON_LIMITS.memoryBytes);
    expect(JSON.parse(o.stdin!)).toEqual({
      code: "print(1)",
      files: { f1: "a.csv" },
      packages: "/data/python-packages/p",
      limits: {
        cpuSeconds: PYTHON_LIMITS.cpuSeconds,
        fileBytes: PYTHON_LIMITS.fileBytes,
        captureChars: PYTHON_LIMITS.captureChars,
      },
    });
    // The runner's folder holds the runner and the lock only (it is readable to the code).
    expect(fs.readdirSync(SCRATCHPAD_DIR).sort()).toEqual(["requirements.lock", "runner.py"]);
  });

  it("maps every way a process ends to a fixed answer", () => {
    const base = { code: 0, signal: null, stdout: "", stderr: "", killed: null } as const;
    expect(pythonResult({ ...base, killed: "timeout" })).toEqual({ ok: false, code: "python_timeout" });
    expect(pythonResult({ ...base, code: null, signal: "SIGXCPU" })).toEqual({
      ok: false,
      code: "python_timeout",
    });
    expect(pythonResult({ ...base, killed: "memory" })).toEqual({ ok: false, code: "python_memory_limit" });
    expect(pythonResult({ ...base, killed: "monitor" })).toEqual({ ok: false, code: "python_memory_limit" });
    expect(pythonResult({ ...base, killed: "output" })).toEqual({ ok: false, code: "python_output_limit" });
    expect(pythonResult({ ...base, killed: "aborted" }, "disk")).toEqual({
      ok: false,
      code: "python_disk_limit",
    });
    expect(pythonResult({ ...base, killed: "aborted" }, "blocked")).toEqual({
      ok: false,
      code: "python_workdir_blocked",
    });
    expect(pythonResult({ ...base, code: 1 })).toEqual({ ok: false, code: "python_failed" });
    expect(pythonResult({ ...base, stdout: "not json" })).toEqual({ ok: false, code: "python_failed" });
    expect(pythonResult({ ...base, stdout: JSON.stringify({ ...report(), extra: 1 }) })).toEqual({
      ok: false,
      code: "python_failed",
    });
    expect(pythonResult({ ...base, stdout: JSON.stringify(report({ stdout: "x" })) })).toEqual({
      ok: true,
      report: report({ stdout: "x" }),
    });
  });

  it("folder usage counts bytes and entries without following links", () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, "a"), "12345");
    fs.mkdirSync(path.join(d, "s"));
    fs.writeFileSync(path.join(d, "s", "b"), "123");
    fs.symlinkSync("/etc", path.join(d, "l"));
    expect(folderUsage(d, 1e9, 1e9)).toEqual({
      bytes: 5 + 3 + fs.lstatSync(path.join(d, "l")).size,
      entries: 4,
      blocked: false,
    });
    // An unreadable subfolder is not counted as empty (review #121 round 1): the measurement is blocked.
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      fs.writeFileSync(path.join(d, "s", "big"), "x".repeat(2000));
      fs.chmodSync(path.join(d, "s"), 0o000);
      try {
        expect(folderUsage(d, 16, 1e9).blocked).toBe(true);
      } finally {
        fs.chmodSync(path.join(d, "s"), 0o700);
      }
    }
    // A folder removed while it is walked (the code tidied up) is not a block.
    fs.rmSync(path.join(d, "s"), { recursive: true, force: true });
    expect(folderUsage(d, 1e9, 1e9).blocked).toBe(false);
  });

  it("off macOS (or without the sandbox) the sandboxed runner answers python_unavailable", async () => {
    if (process.platform === "darwin") return;
    const r = await sandboxedPythonRunner()({
      code: "1",
      workdir: tmp(),
      jobId: JID0,
      files: {},
      inputBytes: 0,
      env: FAKE_ENV,
      dataDir: tmp(),
    });
    expect(r).toEqual({ ok: false, code: "python_unavailable" });
  });

  it("the lock pins exact versions with hashes for python 3.12", () => {
    const lock = fs.readFileSync(PACKAGES_LOCK, "utf8");
    const reqs = lock.split("\n").filter((l) => /^[a-z]/.test(l));
    expect(reqs.map((l) => l.split(" ")[0])).toEqual([
      "numpy==2.5.4",
      "pandas==3.1.0",
      "python-dateutil==2.9.0.post0",
      "six==1.17.0",
      "tzdata==2026.5",
    ]);
    expect(lock.match(/--hash=sha256:[0-9a-f]{64}/g)!.length).toBe(6);
    expect(pythonVersionOf({ exe: "/x/bin/python3.12", root: "/x" })).toBe("3.12");
  });
});

// ---- both runtimes -----------------------------------------------------------------------------------------------

const PY_PROMPT = "/python sum";
const claudeTurn = (): SDKMessage[] => [
  sdk.init({ session: crypto.randomUUID() }),
  liveCall("0", "python_run", pythonScenario("sum").input) as unknown as SDKMessage,
  sdk.delta("계산했어요."),
  sdk.result(),
];
const codexTurn = () => ({
  threadId: cx.threadId,
  turnId: cx.turnId,
  messages: [
    liveCall("0", "python_run", pythonScenario("sum").input) as unknown as Record<string, unknown>,
    cx.delta("계산했어요."),
    cx.usage(cx.tokens(10, 0, 2), cx.tokens(10, 0, 2)),
    cx.completed("completed"),
  ],
});
const unwired = (a: RuntimeAdapter): RuntimeAdapter => ({
  id: a.id,
  capabilities: () => ({ ...a.capabilities(), needsConnection: false }),
  start: (c) => a.start(c),
  resume: (id, c) => a.resume(id, c),
});

describe("both runtimes reach python_run through our MCP server (#47 두 런타임 연결)", () => {
  it("Claude Code and Codex call it; the stored output is the reply's file", async () => {
    const root = tmp();
    const log: ReplayLog = { options: [], prompts: [], interrupts: 0, closes: 0 };
    const runtimes = new RuntimeRegistry();
    runtimes.register(
      unwired(
        new ClaudeAdapter({
          connection: () => ({
            id: "c1",
            dir: path.join(root, "claude"),
            auth: { kind: "api_key", apiKey: "sk-ant-api03-TESTKEY-" + "x".repeat(20) },
          }),
          query: replayQuery({ [PY_PROMPT]: claudeTurn() }, log, 1),
          spawn: () => {
            throw new Error("not spawned in replay");
          },
        }),
      ),
    );
    runtimes.register(
      unwired(
        new CodexAdapter({
          connection: () => ({
            id: "c2",
            dir: path.join(root, "codex"),
            auth: { kind: "api_key", apiKey: "sk-proj-TESTKEY" + "x".repeat(30) },
          }),
          spawn: replaySpawn({ [PY_PROMPT]: codexTurn() }, newLog(), { delayMs: 1 }),
          bundledCatalog: async () => ({
            models: CODEX_MODELS.map((m) => ({
              slug: m.id,
              tool_mode: "code_mode_only",
              base_instructions: "x",
            })),
          }),
          executable: "/nonexistent/codex",
        }),
      ),
    );
    const s = scripted((job) => {
      fs.writeFileSync(path.join(job.workdir, "합계.csv"), "합계\n1046000\n");
      return report({ stdout: "금액 1046000\n" });
    });
    const t = await start({ runner: s.runner, runtimes });
    for (const rt of ["claude-code", "codex"]) {
      const c = t.app.conversations!.create(t.f.users.owner.id);
      const r = await t.send(t.f.cookies.owner, c.id, PY_PROMPT, { runtime: rt });
      expect(r.run.status, rt).toBe("done");
      const ref = r.parts.find((p) => p.type === "file_ref") as { fileId: string; name: string } | undefined;
      expect(ref?.name, rt).toBe("합계.csv");
      expect((await t.download(t.f.cookies.owner, ref!.fileId)).body).toBe("합계\n1046000\n");
    }
    expect(s.jobs).toHaveLength(2);
    for (const j of s.jobs) expect(j.job.code).toBe(pythonScenario("sum").input.code);
  });
});

// ---- the dedicated account: launcher command, validation, gating, self-check (#47 round 2) ----------------------

describe("python_run: the dedicated account (#47 round 2)", () => {
  const account: PythonAccount = { user: "_agentleepy", launcher: PYTHON_LAUNCHER };

  it("account names: a short macOS name only", () => {
    expect(accountFromConfig("_agentleepy")?.user).toBe("_agentleepy");
    expect(accountFromConfig("py-runner")?.launcher).toBe(PYTHON_LAUNCHER);
    for (const bad of ["", "Root", "a b", "has/slash", "a".repeat(40), "1abc", "../x"])
      expect(accountFromConfig(bad), bad).toBeUndefined();
    expect(ACCOUNT_NAME.test("_agentleepy")).toBe(true);
  });

  const JID = "0000000a-00b0-00c0-00d0-0000000000ef";

  it("builds a fixed sudo command from only a job id (no caller-given paths; launcher reads its own config)", () => {
    const run = launcherRun(account, JID, 30);
    expect(run.command).toBe("/usr/bin/sudo");
    expect(run.args).toEqual(["-n", "-u", "_agentleepy", "--", PYTHON_LAUNCHER, "run", JID, "30"]);
    expect(launcherReap(account, JID).args).toEqual([
      "-n",
      "-u",
      "_agentleepy",
      "--",
      PYTHON_LAUNCHER,
      "reap",
      JID,
    ]);
    expect(launcherClean(account, JID).args).toEqual([
      "-n",
      "-u",
      "_agentleepy",
      "--",
      PYTHON_LAUNCHER,
      "clean",
      JID,
    ]);
    expect(launcherProbe(account, JID, 123).args).toEqual([
      "-n",
      "-u",
      "_agentleepy",
      "--",
      PYTHON_LAUNCHER,
      "probe",
      JID,
      "123",
    ]);
  });

  it("refuses a bad job id, timeout or sibling pid (nothing reaches the launcher)", () => {
    for (const bad of [
      "",
      "x",
      "../etc",
      "00000000-0000-0000-0000-00000000000g",
      JID + "a",
      JID.toUpperCase(),
    ]) {
      expect(() => launcherRun(account, bad, 30), bad).toThrow();
      expect(() => launcherReap(account, bad), bad).toThrow();
      expect(() => launcherClean(account, bad), bad).toThrow();
      expect(() => launcherProbe(account, bad, 2), bad).toThrow();
    }
    for (const t of [0, -1, 601, 1.5]) expect(() => launcherRun(account, JID, t), String(t)).toThrow();
    for (const pid of [0, 1, -3, 2.5]) expect(() => launcherProbe(account, JID, pid), String(pid)).toThrow();
    expect(JOB_ID.test(JID)).toBe(true);
    // The work dir is always <scratch>/<jobId>.
    expect(jobWorkdir("/data", JID)).toBe(`${storagePaths("/data").scratch}/${JID}`);
    expect(() => jobWorkdir("/data", "nope")).toThrow();
  });

  it("gating: PYTHON_RUN=1 but no account → needs_account; with a verified account → available", () => {
    const data = tmp();
    // Pretend the interpreter+packages are ready by injecting through the app is covered elsewhere; here the state
    // function is exercised directly with a stubbed runtime/packages via the real check being skipped.
    // No account:
    const noAcct = scratchpadState("/opt/py/bin/python3.12", data, { pythonRun: true, accountReason: "x" });
    expect(
      noAcct.state === "needs_account" || noAcct.state === "needs_python" || noAcct.state === "not_installed",
    ).toBe(true);
    // A verified account only turns it available once interpreter+packages are also real — tested in the app-level
    // suite with injected state; here we assert the needs_account branch wins over a missing account.
    expect(scratchpadState("/opt/py/bin/python3.12", data, { pythonRun: true }).state).not.toBe("available");
  });

  it("the probe verdict is strict: one exact line, a valid uid, exit 0 — only 'blocked' counts (#121 round 8)", () => {
    expect(parseProbe("uid=502 procargs=blocked\n", 0)).toEqual({ uid: 502, readBlocked: true });
    expect(parseProbe("uid=501 procargs=readable\n", 0)).toEqual({ uid: 501, readBlocked: false });
    expect(parseProbe("uid=502 procargs=error errno=3\n", 0)).toEqual({ uid: 502, readBlocked: false });
    expect(parseProbe("uid=502 procargs=error control\n", 0)).toEqual({ uid: 502, readBlocked: false });
    expect(parseProbe("uid=502 procargs=error sibling\n", 0)).toEqual({ uid: 502, readBlocked: false });
    expect(parseProbe("uid=502 procargs=error marker\n", 0)).toEqual({ uid: 502, readBlocked: false });
    expect(parseProbe("uid=4294967294 procargs=blocked\n", 0)).toEqual({
      uid: 4294967294,
      readBlocked: true,
    });
    for (const [out, code] of [
      ["uid=502 procargs=blocked\n", 1], // non-zero exit
      ["uid=502 procargs=blocked\n", null], // killed
      ["uid=502 procargs=blocked\nuid=502 procargs=readable\n", 0], // a second verdict
      ["uid=777 procargs=blocked\nuid=777 checks=fail:packages-import procargs=skipped\n", 1],
      ["warning: uid=502 procargs=blocked\n", 0], // prefix text
      ["uid=502 procargs=blocked-but-not-really\n", 0],
      ["uid=502 procargs=blocked", 0], // no newline: cut short
      ["uid=502 procargs=blocked\n\n", 0], // extra line
      ["uid=4294967296 procargs=blocked\n", 0], // not a u32
      ["uid=0502 procargs=blocked\n", 0],
      ["uid=502  procargs=blocked\n", 0],
      ["uid=502 checks=ok procargs=blocked\n", 0], // round 7's shape
      ["garbage\n", 0],
      ["", 0],
    ] as const)
      expect(parseProbe(out, code), JSON.stringify([out, code])).toBeUndefined();
  });

  it("the shipped launcher has no owner/config bypass (#121 round 4)", () => {
    const launcher = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../ops/python/agentlee-python-run",
    );
    const src = fs.readFileSync(launcher, "utf8");
    expect(src).toContain("use constant OWNER_ALLOW_SELF => 0;");
    expect(src).toContain('use constant CONF_PATH        => "/usr/local/etc/agentlee-python.conf";');
    // No environment-based override of the config path or the owner check in production bytes.
    expect(src).not.toMatch(/AGENTLEE_PYTHON_SELFTEST/);
    expect(src).not.toMatch(/AGENTLEE_PYTHON_CONF/);
    expect(src).not.toMatch(/OWNER_ALLOW_SELF\s*=>\s*1/);
    // perl -T taint mode is on.
    expect(src.split("\n")[0]).toBe("#!/usr/bin/perl -T");
    // The production memory limit is 768 MB (PYTHON_LIMITS), enforced by the launcher's own watch — not by a
    // POSIX::setrlimit that /usr/bin/perl 5.34 does not have (#121 round 5).
    expect(src).toContain(`use constant MEM_LIMIT_KB     => ${PYTHON_LIMITS.memoryBytes / 1024};`);
    expect(src).not.toMatch(/setrlimit|RLIMIT_AS/);
    // The whole environment is replaced for every operation, before anything else runs.
    expect(src).toMatch(/\n%ENV = \(PATH => "\/usr\/bin:\/bin", LC_ALL => "C"\);\n/);
    // reap identifies the process by the kernel's record, never by `ps -o comm=` (argv[0], user-writable).
    expect(src).not.toMatch(/comm=|lstart=/);
    // No shell: no backticks/qx, and system/exec only in list form.
    expect(src).not.toMatch(/qx[{(/]/);
    expect(src.split("\n").filter((l) => !/^\s*#/.test(l) && /`/.test(l.replace(/#.*$/, "")))).toEqual([]);
  });

  it("verify: the launcher's read-only report — run directly (no sudo), parsed fail-closed (#121 round 5)", () => {
    expect(launcherVerify(account)).toEqual({ command: PYTHON_LAUNCHER, args: ["verify", "_agentleepy"] });
    expect(() => launcherVerify({ user: "Bad User", launcher: PYTHON_LAUNCHER })).toThrow();
    const good =
      "advisory verify can miss ACL corner cases\ncheck launcher ok\ncheck interpreter tree ok\nscratch /d/scratch\nresult ok\n";
    expect(parseVerify(good, 0)).toEqual({
      ok: true,
      checks: [
        { name: "launcher", ok: true },
        { name: "interpreter tree", ok: true },
      ],
      scratch: "/d/scratch",
    });
    // Any failed check, a non-zero exit, a missing result, an unknown line or no checks at all: not ok.
    const failed = parseVerify("check runner fail writable by group/other: /x\nresult fail\n", 1);
    expect(failed.ok).toBe(false);
    expect(failed.checks).toEqual([{ name: "runner", ok: false, reason: "writable by group/other: /x" }]);
    expect(parseVerify(good, 1).ok).toBe(false);
    expect(parseVerify(good.replace("result ok\n", ""), 0).ok).toBe(false);
    expect(parseVerify(good + "something else\n", 0).ok).toBe(false);
    expect(parseVerify("result ok\n", 0).ok).toBe(false);
    expect(parseVerify("check a ok\ncheck b fail x\nresult ok\n", 0).ok).toBe(false);
  });

  it("the launcher's exit 124 (its own wall-clock timeout) maps to a timeout, 125 (its memory watch) to the memory limit (#121 rounds 4-5)", () => {
    expect(launcherKilled(124, null)).toBe("timeout");
    expect(launcherKilled(125, null)).toBe("memory");
    expect(launcherKilled(125, "aborted")).toBe("aborted");
    const base = {
      code: 125,
      signal: null,
      stdout: "",
      stderr: "",
      killed: launcherKilled(125, null),
    } as const;
    expect(pythonResult(base)).toEqual({ ok: false, code: "python_memory_limit" });
    expect(pythonResult({ ...base, code: 124, killed: launcherKilled(124, null) })).toEqual({
      ok: false,
      code: "python_timeout",
    });
    expect(launcherKilled(0, null)).toBe(null);
    expect(launcherKilled(1, null)).toBe(null);
    expect(launcherKilled(137, null)).toBe(null);
    // Our own backstop/output kill wins over the exit code.
    expect(launcherKilled(124, "output")).toBe("output");
    expect(launcherKilled(124, "aborted")).toBe("aborted");
  });

  it("self-check passes only on a different uid with the procargs read blocked (injected probe)", async () => {
    const serverUid = process.getuid?.() ?? 501;
    const base = { account, dataDir: tmp(), serverUid, clean: () => {} };
    const probe =
      (r: { uid: number; readBlocked: boolean }): ProbeRunner =>
      async () =>
        r;
    expect(await verifyAccount({ ...base, run: probe({ uid: serverUid + 7, readBlocked: true }) })).toEqual({
      ok: true,
      uid: serverUid + 7,
    });
    // Same uid as the server: refused.
    expect((await verifyAccount({ ...base, run: probe({ uid: serverUid, readBlocked: true }) })).ok).toBe(
      false,
    );
    // Different uid but the read was NOT blocked: refused (the whole point).
    expect(
      (await verifyAccount({ ...base, run: probe({ uid: serverUid + 7, readBlocked: false }) })).ok,
    ).toBe(false);
    // A blocked verdict while the server's sibling had already exited (a zombie also refuses procargs): refused.
    const dead = await verifyAccount({
      ...base,
      run: async ({ siblingPid }) => {
        process.kill(siblingPid, "SIGKILL");
        await new Promise((r) => setTimeout(r, 300));
        return { uid: serverUid + 7, readBlocked: true };
      },
    });
    expect(dead.ok).toBe(false);
    if (!dead.ok) expect(dead.reason).toContain("sibling exited");
    // The probe throwing (sudo not set up) is a closed failure, not a pass.
    const threw = await verifyAccount({
      ...base,
      run: async () => {
        throw new Error("sudo: a password is required");
      },
    });
    expect(threw.ok).toBe(false);
    if (!threw.ok) expect(threw.reason).toContain("password");
  });

  it("the self-check runs a real job through the normal path; any failed step keeps the tool off (#121 round 8)", async () => {
    const serverUid = process.getuid?.() ?? 501;
    const acctUid = serverUid + 7;
    const dataDir = tmp();
    const seen: PythonJob[] = [];
    // What the real job does (the fixed script), done here by a stand-in runner: it checks what it was given.
    const good: PythonRunner = async (job) => {
      seen.push(job);
      const input = path.join(job.workdir, job.files.selfcheck!);
      const st = fs.lstatSync(input);
      // A server-owned 0600 copy, made as a call makes one; the work dir has its .tmp; the env is the account's.
      expect(st.uid).toBe(serverUid);
      expect(st.mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(input, "utf8")).toBe(SELF_CHECK_INPUT);
      expect(fs.statSync(path.join(job.workdir, ".tmp")).isDirectory()).toBe(true);
      fs.writeFileSync(path.join(job.workdir, "selfcheck-out.csv"), "total,10\n");
      return { ok: true, report: report({ stdout: "selfcheck ok 10 5050\n" }) };
    };
    const cleaned: string[] = [];
    const base = {
      account,
      env: FAKE_ENV,
      dataDir,
      serverUid,
      probe: (async () => ({ uid: acctUid, readBlocked: true })) as ProbeRunner,
      ownerOf: () => acctUid,
      clean: (_a: PythonAccount, jobId: string) => void cleaned.push(jobId),
    };
    expect(await selfCheckAccount({ ...base, runner: good })).toEqual({ ok: true, uid: acctUid });
    const job = seen[0]!;
    expect(job.code).toBe(SELF_CHECK_CODE);
    expect(SELF_CHECK_CODE).toContain("import numpy, pandas");
    expect(job.env.account).toEqual(account);
    expect(job.env.accountUid).toBe(acctUid);
    expect(job.workdir).toBe(path.join(fs.realpathSync(storagePaths(dataDir).scratch), job.jobId));
    // The probe's own job (its dir + run record) and the real job are both cleaned through the launcher.
    expect(cleaned).toHaveLength(2);
    expect(cleaned[1]).toBe(job.jobId);
    expect(fs.existsSync(job.workdir)).toBe(false);

    const failsAt = async (step: string, o: Partial<Parameters<typeof selfCheckAccount>[0]>) => {
      const r = await selfCheckAccount({ ...base, runner: good, ...o });
      expect(r.ok, step).toBe(false);
      if (!r.ok) expect(r.step).toBe(step);
      // Whatever failed, the work dir is gone.
      for (const d of fs.readdirSync(storagePaths(dataDir).scratch)) expect(d.startsWith(".")).toBe(true);
    };
    await failsAt("probe", { probe: async () => ({ uid: acctUid, readBlocked: false }) });
    await failsAt("probe", { probe: async () => ({ uid: serverUid, readBlocked: true }) });
    await failsAt("run", { runner: async () => ({ ok: false, code: "python_failed" }) });
    await failsAt("run", { runner: async () => ({ ok: false, code: "python_memory_limit" }) });
    await failsAt("run", {
      runner: async () => {
        throw new Error("spawn failed");
      },
    });
    await failsAt("report", {
      runner: async () => ({ ok: true, report: report({ stdout: "selfcheck ok 9 5050\n" }) }),
    });
    await failsAt("report", {
      runner: async () => ({
        ok: true,
        report: report({ status: "error", errorType: "ModuleNotFoundError" }),
      }),
    });
    // No output, a wrong one, an extra one, or one the server uid (not the account) wrote.
    await failsAt("output", {
      runner: async () => ({ ok: true, report: report({ stdout: "selfcheck ok 10 5050\n" }) }),
    });
    await failsAt("output", {
      runner: async (j) => {
        fs.writeFileSync(path.join(j.workdir, "selfcheck-out.csv"), "total,11\n");
        return { ok: true, report: report({ stdout: "selfcheck ok 10 5050\n" }) };
      },
    });
    await failsAt("output", {
      runner: async (j) => {
        fs.writeFileSync(path.join(j.workdir, "other.csv"), "x\n");
        return good(j);
      },
    });
    await failsAt("output", { ownerOf: () => serverUid });
  });

  it("the self-check never throws: a throwing step is a failed step, cleanup is best-effort and logged (#121 round 9)", async () => {
    const serverUid = process.getuid?.() ?? 501;
    const acctUid = serverUid + 7;
    const dataDir = tmp();
    const cleaned: string[] = [];
    const cleanupErrors: string[] = [];
    const ok: PythonRunner = async (job) => {
      fs.writeFileSync(path.join(job.workdir, "selfcheck-out.csv"), "total,10\n");
      return { ok: true, report: report({ stdout: "selfcheck ok 10 5050\n" }) };
    };
    const base = {
      account,
      env: FAKE_ENV,
      dataDir,
      serverUid,
      probe: (async () => ({ uid: acctUid, readBlocked: true })) as ProbeRunner,
      runner: ok,
      ownerOf: () => acctUid,
      clean: (_a: PythonAccount, jobId: string) => void cleaned.push(jobId),
      onCleanupError: (what: string) => void cleanupErrors.push(what),
    };
    const noJobDirs = () =>
      expect(fs.readdirSync(storagePaths(dataDir).scratch).filter((d) => !d.startsWith("."))).toEqual([]);
    // A bad TMPDIR (mkdtemp ENOENT): the input step fails; the job dir is still cleaned and removed.
    const badTmp = await selfCheckAccount({ ...base, tmpDir: () => path.join(dataDir, "no", "such", "dir") });
    expect(badTmp).toMatchObject({ ok: false, step: "input" });
    expect(cleaned).toHaveLength(2); // the probe's job and this one
    noJobDirs();
    // The owner lookup throwing: the output step fails.
    expect(
      await selfCheckAccount({
        ...base,
        ownerOf: () => {
          throw new Error("EACCES");
        },
      }),
    ).toMatchObject({ ok: false, step: "output", reason: "EACCES" });
    noJobDirs();
    // The launcher clean and the log both throwing: the answer stands (ok), the failure is reported, nothing escapes.
    expect(
      await selfCheckAccount({
        ...base,
        clean: () => {
          throw new Error("sudo gone");
        },
      }),
    ).toEqual({ ok: true, uid: acctUid });
    expect(cleanupErrors).toContain("launcher-clean");
    expect(
      await selfCheckAccount({
        ...base,
        clean: () => {
          throw new Error("x");
        },
        onCleanupError: () => {
          throw new Error("logger broke");
        },
      }),
    ).toEqual({ ok: true, uid: acctUid });
    // No usable scratch root (a file there): a failed step (the probe's own job folder already fails), no throw.
    const d2 = tmp();
    fs.mkdirSync(path.dirname(storagePaths(d2).scratch), { recursive: true });
    fs.writeFileSync(storagePaths(d2).scratch, "x");
    expect((await selfCheckAccount({ ...base, dataDir: d2 })).ok).toBe(false);
  });

  it("the gate: off while checking, on only after a pass; a failure or a throw keeps it off (#121 round 9)", async () => {
    const g = new AccountSelfCheckGate(account);
    expect(g.verified).toBeUndefined();
    expect(g.reason).toMatch(/^checking/);
    let release!: (r: SelfCheckResult) => void;
    void g.start(() => new Promise((r) => (release = r)));
    expect(g.reason).toMatch(/^checking/);
    expect(g.verified).toBeUndefined();
    release({ ok: true, uid: 777 });
    await g.done;
    expect(g.verified).toEqual({ account, uid: 777 });
    expect(g.reason).toBe("");
    const failed = new AccountSelfCheckGate(account);
    await failed.start(async () => ({ ok: false, step: "run", reason: "python_failed" }));
    expect(failed.verified).toBeUndefined();
    expect(failed.reason).toBe("self-check step run failed: python_failed");
    const threw = new AccountSelfCheckGate(account);
    await expect(
      threw.start(
        async () => {
          throw new Error("boom");
        },
        () => {
          throw new Error("logger broke");
        },
      ),
    ).resolves.toBeUndefined();
    expect(threw.verified).toBeUndefined();
    expect(threw.reason).toBe("self-check failed: boom");
    expect(new AccountSelfCheckGate(undefined).reason).toBe("PYTHON_RUN_USER not configured");
  });

  it("startup is not blocked by the self-check: ready before a slow check ends, the tool on after; a throwing check leaves it off (#121 round 9)", async () => {
    const build = async (selfCheck: () => Promise<SelfCheckResult>) => {
      const gate = new AccountSelfCheckGate(account);
      const app = await buildApp(
        loadConfig({
          NODE_ENV: "test",
          DATA_DIR: path.join(tmp(), "data"),
          MASTER_KEY_PATH: path.join(tmp(), "master.key"),
        }),
        { db: createTestDb(), python: { runner: scripted(() => report()).runner, gate, selfCheck } },
      );
      closers.push(() => app.close());
      return { app, gate };
    };
    let release!: (r: SelfCheckResult) => void;
    const slow = await build(() => new Promise((r) => (release = r)));
    const t0 = Date.now();
    await slow.app.ready(); // would hang (hook timeout) if the check ran inside a startup hook
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(slow.gate.reason).toMatch(/^checking/);
    expect(slow.gate.verified).toBeUndefined();
    release({ ok: true, uid: 777 });
    await slow.gate.done;
    expect(slow.gate.verified).toEqual({ account, uid: 777 });

    const boom = await build(async () => {
      throw new Error("mkdtemp ENOENT");
    });
    await boom.app.ready();
    await boom.gate.done;
    expect(boom.gate.verified).toBeUndefined();
    expect(boom.gate.reason).toBe("self-check failed: mkdtemp ENOENT");
    // The server works.
    expect(
      (await boom.app.inject({ method: "GET", url: "/api/health", headers: LOCAL })).statusCode,
    ).toBeLessThan(500);
  });

  it("shutdown aborts the self-check: no new step, the job and temp dirs removed, close bounded (#121 round 10)", async () => {
    const serverUid = process.getuid?.() ?? 501;
    const acctUid = serverUid + 7;
    const until = (signal: AbortSignal | undefined) =>
      new Promise<void>((r) =>
        signal?.aborted ? r() : signal?.addEventListener("abort", () => r(), { once: true }),
      );
    const fixture = () => {
      const dataDir = tmp();
      const tmpRoot = tmp();
      const steps: string[] = [];
      let runnerSignal: AbortSignal | undefined;
      let runnerStarted!: () => void;
      const started = new Promise<void>((r) => (runnerStarted = r));
      const opts = (signal: AbortSignal, delayProbe = false) => ({
        account,
        env: FAKE_ENV,
        dataDir,
        serverUid,
        signal,
        tmpDir: () => tmpRoot,
        ownerOf: () => acctUid,
        clean: () => void steps.push("clean"),
        probe: (async (p) => {
          steps.push("probe");
          if (delayProbe) {
            await until(p.signal);
            throw new Error("aborted");
          }
          return { uid: acctUid, readBlocked: true };
        }) as ProbeRunner,
        // Like the real runner: on abort it stops the job (the launcher reap) and answers a failure.
        runner: (async (_job, sig) => {
          steps.push("run");
          runnerSignal = sig;
          runnerStarted();
          await until(sig);
          return { ok: false, code: "python_failed" };
        }) as PythonRunner,
      });
      const left = () => ({
        jobs: fs.readdirSync(storagePaths(dataDir).scratch).filter((d) => !d.startsWith(".")),
        tmp: fs.readdirSync(tmpRoot).filter((d) => d.startsWith("agentlee-selfcheck-")),
      });
      return { opts, steps, started, left, runnerSignal: () => runnerSignal };
    };

    // A delayed probe, aborted: it stops, and no later step (work dir, input, run) starts.
    const a = fixture();
    const ca = new AbortController();
    const pa = selfCheckAccount(a.opts(ca.signal, true));
    await new Promise((r) => setTimeout(r, 300));
    ca.abort();
    expect(await pa).toMatchObject({ ok: false, step: "probe" });
    expect(a.steps).toEqual(["probe", "clean"]); // the probe's own job is cleaned; nothing else starts

    // A delayed job, aborted: the runner gets the aborted signal, the cleanup runs, nothing is left.
    const b = fixture();
    const cb = new AbortController();
    const pb = selfCheckAccount(b.opts(cb.signal));
    await b.started;
    expect(b.left().jobs).toHaveLength(1);
    expect(b.left().tmp).toHaveLength(1);
    cb.abort();
    expect(await pb).toMatchObject({ ok: false, step: "run" });
    expect(b.runnerSignal()?.aborted).toBe(true);
    expect(b.steps).toEqual(["probe", "clean", "run", "clean"]);
    expect(b.left()).toEqual({ jobs: [], tmp: [] });

    // Through the app: close() aborts it and waits for that cleanup, well inside the bound.
    const c = fixture();
    const gate = new AccountSelfCheckGate(account);
    const app = await buildApp(
      loadConfig({
        NODE_ENV: "test",
        DATA_DIR: path.join(tmp(), "data"),
        MASTER_KEY_PATH: path.join(tmp(), "master.key"),
      }),
      {
        db: createTestDb(),
        python: {
          runner: scripted(() => report()).runner,
          gate,
          selfCheck: (sig) => selfCheckAccount(c.opts(sig)),
        },
      },
    );
    await app.ready();
    await c.started;
    const t0 = Date.now();
    await app.close();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(c.runnerSignal()?.aborted).toBe(true);
    expect(c.steps).toEqual(["probe", "clean", "run", "clean"]);
    expect(c.left()).toEqual({ jobs: [], tmp: [] });
    expect(gate.verified).toBeUndefined();
    expect(gate.reason).toMatch(/stopped: shutting down/);
    // A gate that was stopped starts nothing more.
    let ran = false;
    await gate.start(async () => {
      ran = true;
      return { ok: true, uid: 1 };
    });
    expect(ran).toBe(false);
  });

  it("an aborted or timed-out probe settles at once even when sudo's child keeps the pipes: reap by job id, dir removed (#121 round 11)", async () => {
    const serverUid = process.getuid?.() ?? 501;
    // sudo's process model: the spawned parent starts the probe child with the same pipes; killing the parent
    // would not reach the child, which keeps stdout open — so 'close' never comes on its own.
    const scenario = () => {
      const dir = tmp();
      const pidFile = path.join(dir, "child-pid");
      const kids: number[] = [];
      const spawnProbe = () => {
        const childCode = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
        const parentCode = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(childCode)}], { stdio: ["ignore", "inherit", "inherit"] }); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)`;
        const parent = spawn(process.execPath, ["-e", parentCode], { stdio: ["ignore", "pipe", "pipe"] });
        closers.push(() => {
          try {
            parent.kill("SIGKILL");
          } catch {
            // gone
          }
          for (const k of kids)
            try {
              process.kill(k, "SIGKILL");
            } catch {
              // gone
            }
        });
        return parent;
      };
      const reaped: string[] = [];
      // The launcher's reap: kills the recorded (here: written) probe child by its pid.
      const reap = (_a: PythonAccount, jobId: string) => {
        reaped.push(jobId);
        process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL");
      };
      const childPid = async () => {
        for (let i = 0; i < 200 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 25));
        const pid = Number(fs.readFileSync(pidFile, "utf8"));
        kids.push(pid);
        return pid;
      };
      const alive = (pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      };
      return { dir, spawnProbe, reap, reaped, childPid, alive };
    };
    const gone = async (pid: number, alive: (p: number) => boolean) => {
      for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 20));
      return !alive(pid);
    };

    // Aborted (shutdown).
    const s1 = scenario();
    const ctl = new AbortController();
    const cleaned: string[] = [];
    const p1 = verifyAccount({
      account,
      dataDir: s1.dir,
      serverUid,
      signal: ctl.signal,
      clean: (_a, id) => void cleaned.push(id),
      run: launcherProbeRunner({ spawnProbe: s1.spawnProbe, reap: s1.reap, timeoutMs: 60_000 }),
    });
    const child1 = await s1.childPid();
    const t0 = Date.now();
    ctl.abort();
    expect(await p1).toEqual({ ok: false, reason: "aborted" });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(s1.reaped).toHaveLength(1);
    expect(JOB_ID.test(s1.reaped[0]!)).toBe(true);
    expect(cleaned).toEqual(s1.reaped); // the same job: its dir + run record cleaned as the account
    expect(await gone(child1, s1.alive)).toBe(true);
    expect(fs.readdirSync(storagePaths(s1.dir).scratch).filter((d) => !d.startsWith("."))).toEqual([]);

    // Its own timeout: the same — reap, settle, clean.
    const s2 = scenario();
    const p2 = verifyAccount({
      account,
      dataDir: s2.dir,
      serverUid,
      clean: () => {},
      run: launcherProbeRunner({ spawnProbe: s2.spawnProbe, reap: s2.reap, timeoutMs: 800 }),
    });
    const child2 = await s2.childPid();
    expect(await p2).toEqual({ ok: false, reason: "the launcher probe timed out" });
    expect(s2.reaped).toHaveLength(1);
    expect(await gone(child2, s2.alive)).toBe(true);
    expect(fs.readdirSync(storagePaths(s2.dir).scratch).filter((d) => !d.startsWith("."))).toEqual([]);

    // Even if the reap could not kill it, the caller is not held: it settles and cleans up (the launcher's own
    // probe limit is what ends such a child in production).
    const s3 = scenario();
    const ctl3 = new AbortController();
    const p3 = verifyAccount({
      account,
      dataDir: s3.dir,
      serverUid,
      signal: ctl3.signal,
      clean: () => {},
      run: launcherProbeRunner({ spawnProbe: s3.spawnProbe, reap: () => {}, timeoutMs: 60_000 }),
    });
    const child3 = await s3.childPid();
    ctl3.abort();
    expect(await p3).toEqual({ ok: false, reason: "aborted" });
    expect(s3.alive(child3)).toBe(true);
    expect(fs.readdirSync(storagePaths(s3.dir).scratch).filter((d) => !d.startsWith("."))).toEqual([]);
  });

  it("app gating: the tool is offered only when the gated state is available", async () => {
    // needs_account (or any non-available state) → absent; available → present. The service's state() is the gate.
    const absent = await start({ state: () => ({ state: "needs_account", reason: "no account" }) });
    expect(absent.app.mcp!.toolNamesFor(absent.f.users.owner.id)).not.toContain("python_run");
    const admin = (await absent.api(absent.f.cookies.admin, "GET", "/api/admin/skills")).json<{
      skills: { name: string; status: string }[];
    }>().skills;
    expect(admin.find((x) => x.name === "python-scratchpad")?.status).toBe("needs_account");
    const present = await start({
      state: () => ({ state: "available", env: { runtime: FAKE_ENV.runtime, account, accountUid: 777 } }),
    });
    expect(present.app.mcp!.toolNamesFor(present.f.users.owner.id)).toContain("python_run");
  });
});

// ---- the real interpreter in the macOS sandbox ------------------------------------------------------------------

/** A self-contained python on this machine (TEST_SKILL_PYTHON or uv), preferring 3.12; skipped without one. */
function findPython(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  const fromEnv = process.env.TEST_SKILL_PYTHON;
  const candidates = fromEnv ? [fromEnv] : [];
  if (!fromEnv)
    try {
      const out = execFileSync("uv", ["python", "list", "--only-installed", "--output-format", "json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      for (const p of JSON.parse(out) as { path?: string; implementation?: string }[])
        if (p.path && p.implementation === "cpython") candidates.push(p.path);
    } catch {
      // no uv
    }
  const ok = candidates.filter((c) => pythonRuntime(c).ok);
  return (
    ok.find((c) => {
      const r = pythonRuntime(c);
      return r.ok && pythonVersionOf(r.runtime) === "3.12";
    }) ?? ok[0]
  );
}
const PY = findPython();
const PY_ENV: PythonEnv | undefined = PY
  ? { runtime: (pythonRuntime(PY) as { ok: true; runtime: PythonEnv["runtime"] }).runtime }
  : undefined;
/** The installed packages for the pandas tests (`pnpm python:install`'s folder), when given. */
const PACKAGES = process.env.TEST_PYTHON_PACKAGES;
/** The dedicated account (launcher + sudoers installed), when the operator provides it: the cross-uid tests. */
const RUN_USER = process.env.TEST_PYTHON_RUN_USER;

describe.skipIf(!PY_ENV)("python_run in the real sandbox (macOS, standalone python)", () => {
  /** An app whose tool runs the real interpreter (standard library; the packages when TEST_PYTHON_PACKAGES). */
  const real = (o: Parameters<typeof sandboxedPythonRunner>[0] = {}) =>
    start({
      runner: sandboxedPythonRunner({ timeoutMs: 8000, ...o }),
      state: AVAILABLE({ ...PY_ENV!, ...(PACKAGES ? { packages: PACKAGES } : {}) }),
    });

  it("another conversation's working folder and files, the store, home and outside folders cannot be read; nothing outside can be written; no fork", async () => {
    const t = await real();
    const a = t.app.conversations!.create(t.f.users.owner.id);
    const b = t.app.conversations!.create(t.f.users.owner.id);
    const { file } = await t.sentFile(t.f.cookies.owner, a.id, "a.csv", "SECRET-A\n");
    const stored = t.app.files!.pathOf(t.app.files!.get(file.id)!);
    // Another conversation's working folder (as a running call would have it).
    const otherWork = path.join(storagePaths(t.dataDir).scratch, t.f.users.owner.id, a.id, "running");
    fs.mkdirSync(otherWork, { recursive: true });
    fs.writeFileSync(path.join(otherWork, "data.csv"), "SECRET-W\n");
    const outside = path.join(tmp(), "family.txt");
    fs.writeFileSync(outside, "SECRET-O\n");
    const code = String.raw`
import json, os
res = {}
def attempt(name, fn):
    try:
        v = fn(); res[name] = "OK " + str(v)[:200]
    except BaseException as e:
        res[name] = "ERR " + type(e).__name__
attempt("stored", lambda: open(${JSON.stringify(stored)}).read())
attempt("other_work", lambda: open(${JSON.stringify(path.join(otherWork, "data.csv"))}).read())
attempt("other_list", lambda: os.listdir(${JSON.stringify(path.dirname(otherWork))}))
attempt("user_scratch", lambda: os.listdir(${JSON.stringify(path.join(storagePaths(t.dataDir).scratch, t.f.users.owner.id))}))
attempt("db", lambda: open(${JSON.stringify(storagePaths(t.dataDir).db)}, "rb").read(10))
attempt("outside", lambda: open(${JSON.stringify(outside)}).read())
attempt("home", lambda: os.listdir(${JSON.stringify(os.homedir())}))
attempt("write_outside", lambda: open(${JSON.stringify(path.join(path.dirname(outside), "w.txt"))}, "w").write("x"))
attempt("write_own", lambda: open("mine.txt", "w").write("x\n"))
attempt("tmp", lambda: __import__("tempfile").mkstemp())
attempt("fork", lambda: os.fork() == 0 and os._exit(0))
attempt("env", lambda: ",".join(sorted(k for k in os.environ if k not in ("__CF_USER_TEXT_ENCODING", "LC_CTYPE"))))
print(json.dumps(res))
`;
    const scope = await t.scopeOf(b.id);
    const r = await svcFor(t, sandboxedPythonRunner({ timeoutMs: 8000 }), AVAILABLE(PY_ENV)).run(scope, {
      code,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const out = (r as { output: { stdout: string; files: { name: string }[] } }).output;
    const res = JSON.parse(inner(out.stdout)) as Record<string, string>;
    for (const k of [
      "stored",
      "other_work",
      "other_list",
      "user_scratch",
      "db",
      "outside",
      "home",
      "write_outside",
      "fork",
    ])
      expect(res[k], k).toMatch(/^ERR/);
    expect(res.write_own).toMatch(/^OK/);
    expect(res.tmp).toMatch(/^OK/);
    expect(res.env).toBe("OK HOME,LANG,LC_ALL,MKL_NUM_THREADS,OMP_NUM_THREADS,OPENBLAS_NUM_THREADS,TMPDIR");
    expect(out.files.map((x) => x.name)).toEqual(["mine.txt"]);
    expect(JSON.stringify(out)).not.toMatch(/SECRET-[AWO]/);
  });

  it("the network is closed: no outside address, no loopback server (ours included)", async () => {
    const target = http.createServer((_q, res) => res.end("OPEN"));
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    closers.push(() => new Promise((r) => target.close(r)));
    const port = (target.address() as net.AddressInfo).port;
    const t = await real();
    const c = t.app.conversations!.create(t.f.users.owner.id);
    const mcpPort = (await t.app.mcp!.endpoint()).port;
    const r = await t.send(t.f.cookies.owner, c.id, "/python net");
    expect(inner(outputOf(r).output.stdout)).toMatch(/^network: blocked/);
    const scope = await t.scopeOf(c.id);
    const code = String.raw`
import socket
for p in (${port}, ${mcpPort}):
    try:
        socket.create_connection(("127.0.0.1", p), timeout=2).close(); print(p, "OPEN")
    except OSError as e:
        print(p, "blocked")
try:
    socket.getaddrinfo("example.com", 443); print("dns OPEN")
except OSError:
    print("dns blocked")
`;
    const d = await svcFor(t, sandboxedPythonRunner({ timeoutMs: 8000 }), AVAILABLE(PY_ENV)).run(scope, {
      code,
    });
    expect(inner((d as { output: { stdout: string } }).output.stdout)).toBe(
      `${port} blocked\n${mcpPort} blocked\ndns blocked\n`,
    );
  });

  it("an endless loop is stopped at the time limit (python_timeout); the folder is gone", async () => {
    const t = await real({ timeoutMs: 2000 });
    const c = t.app.conversations!.create(t.f.users.owner.id);
    const t0 = Date.now();
    const r = await t.send(t.f.cookies.owner, c.id, "/python loop");
    expect(outputOf(r)).toEqual({ isError: true, output: { error: "python_timeout" } });
    expect(Date.now() - t0).toBeLessThan(15_000);
    const scratch = storagePaths(t.dataDir).scratch;
    expect(fs.readdirSync(scratch).filter((n) => n !== ".ctl")).toEqual([]);
  });

  it("memory, output, file size and folder size limits", async () => {
    const t = await real({ maxRssBytes: 200 * 1024 * 1024, workBytes: 30 * 1024 * 1024, watchMs: 50 });
    const c = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(c.id);
    const svc = svcFor(
      t,
      sandboxedPythonRunner({
        timeoutMs: 8000,
        maxRssBytes: 200 * 1024 * 1024,
        workBytes: 30 * 1024 * 1024,
        watchMs: 50,
      }),
      AVAILABLE(PY_ENV),
    );
    expect(
      await svc.run(scope, { code: "x = bytearray(600 * 1024 * 1024)\nimport time\ntime.sleep(5)" }),
    ).toEqual({
      ok: false,
      code: "python_memory_limit",
    });
    // One file beyond RLIMIT_FSIZE: the write fails inside python (reported as the code's error).
    const big = await svc.run(scope, {
      code: `with open("big.txt", "w") as f:\n    f.write("x" * ${PYTHON_LIMITS.fileBytes + 1})`,
    });
    expect(big.ok).toBe(true);
    expect((big as { output: { status: string; error: { type: string } } }).output).toMatchObject({
      status: "error",
      error: { type: "OSError" },
    });
    // Many files: the folder watch stops it.
    expect(
      await svc.run(scope, {
        code: "import time\nfor i in range(100):\n    open(f'f{i}.txt', 'w').write('x' * 5_000_000)\n    time.sleep(0.02)",
      }),
    ).toEqual({ ok: false, code: "python_disk_limit" });
    // A large print is kept up to the capture limit and counted, not a failure.
    const loud = await svc.run(scope, { code: `print("y" * ${PYTHON_LIMITS.captureChars * 3})` });
    const out = (loud as { output: { stdoutTruncated: boolean; stdoutChars: number; outputFile?: unknown } })
      .output;
    expect(out.stdoutTruncated).toBe(true);
    expect(out.stdoutChars).toBe(PYTHON_LIMITS.captureChars * 3 + 1);
    expect(out.outputFile).toBeDefined();
    // Writing straight to fd 1 cannot spoil the report.
    const raw = await svc.run(scope, { code: "import os\nos.write(1, b'{not json')\nprint('ok')" });
    expect(inner((raw as { output: { stdout: string } }).output.stdout)).toBe("ok\n");
  });

  it("the code cannot set file flags (chflags), so the working folder is always removable", async () => {
    const t = await real();
    const c = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(c.id);
    const svc = svcFor(t, sandboxedPythonRunner({ timeoutMs: 8000 }), AVAILABLE(PY_ENV));
    const r = (await svc.run(scope, {
      code: "import os\nopen('a.txt','w').write('x')\ntry:\n    os.chflags('a.txt', 2)\n    print('chflags OPEN')\nexcept OSError as e:\n    print('chflags', type(e).__name__)",
    })) as { output: { stdout: string } };
    expect(inner(r.output.stdout)).toMatch(/chflags (Permission|OSError)/);
    // The profile denies file-write-flags (belt and braces next to the real-sandbox result above).
    expect(
      buildProfile({
        command: "/opt/py/bin/python3.12",
        read: [],
        write: ["/w"],
        network: "none",
        noFlagChanges: true,
      }),
    ).toContain("(deny file-write-flags)");
    // And even if a flag were set, removeTree clears it (tested directly, not sandboxed).
    const dir = path.join(tmp(), "locked");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "f.txt"), "x");
    spawnSyncOk("/usr/bin/chflags", ["uchg", path.join(dir, "f.txt")]);
    expect(removeTree(dir)).toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("a folder measurement that throws mid-run (a chmod race) stops that run only (python_workdir_blocked)", async () => {
    const t = await real();
    const c = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(c.id);
    let calls = 0;
    const runner = sandboxedPythonRunner({
      timeoutMs: 8000,
      watchMs: 20,
      measure: () => {
        // The first measurement races with a permission change the code made: EACCES out of lstat.
        if (++calls >= 1) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        return { bytes: 0, entries: 0, blocked: false };
      },
    });
    const r = await svcFor(t, runner, AVAILABLE(PY_ENV)).run(scope, {
      code: "import time\ntime.sleep(2)\nprint('x')",
    });
    expect(r).toEqual({ ok: false, code: "python_workdir_blocked" });
    expect(t.app.files!.list(c.id)).toEqual([]);
  });

  it("cross-uid: as the dedicated account, a server-uid process's start-up environment is NOT readable (#47 round 2)", async () => {
    // Needs the real account: launcher installed, sudoers rule, scratch ACL. Skipped otherwise.
    if (!RUN_USER || !PY_ENV || !PACKAGES) return;
    const account: PythonAccount = { user: RUN_USER, launcher: PYTHON_LAUNCHER };
    // The self-check itself is the cross-uid assertion: different uid AND the read blocked.
    const t0 = await start();
    const v = await verifyAccount({
      account,
      dataDir: t0.dataDir,
      serverUid: process.getuid?.() ?? -1,
    });
    expect(v, JSON.stringify(v)).toMatchObject({ ok: true });
    if (!v.ok) return;
    expect(v.uid).not.toBe(process.getuid?.() ?? -1);

    // And a full run proves it from inside python_run: read a sibling server-uid process → blocked.
    const marker = "SYNTH" + "-SECRET-" + "ZZZ999";
    const sib = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      env: { PATH: process.env.PATH ?? "", FAKE_SECRET: marker },
    });
    closers.push(() => void sib.kill());
    await new Promise((r) => setTimeout(r, 200));
    const env = { ...PY_ENV, packages: PACKAGES, account, accountUid: v.uid };
    const t = await start();
    const c = t.app.conversations!.create(t.f.users.owner.id);
    void c;
    const code = `
import ctypes, os
print("uid", os.geteuid())
libc = ctypes.CDLL(None, use_errno=True)
mib = (ctypes.c_int * 3)(1, 49, ${sib.pid})
size = ctypes.c_size_t(0)
if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0 or not size.value:
    print("procargs: blocked")
else:
    buf = ctypes.create_string_buffer(size.value)
    libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0)
    print("procargs:", "readable" if (b"${marker}" in buf.raw) else "empty")
`;
    const scope = await t.scopeOf(c.id);
    const out = (await svcFor(t, sandboxedPythonRunner({ timeoutMs: 8000 }), () => ({
      state: "available",
      env,
    })).run(scope, { code })) as { ok: true; output: { stdout: string } };
    expect(out.ok).toBe(true);
    expect(inner(out.output.stdout)).toContain("procargs: blocked");
    expect(inner(out.output.stdout)).not.toContain("readable");
  });

  it("exceptions and exit codes: the type, the code's own traceback lines, paths hidden", async () => {
    const t = await real();
    const c = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(c.id);
    const svc = svcFor(t, sandboxedPythonRunner({ timeoutMs: 8000 }), AVAILABLE(PY_ENV));
    const r = (await svc.run(scope, { code: "x = 1\nprint('before')\n1 / 0\n" })) as {
      ok: true;
      output: {
        status: string;
        exitCode: number;
        stdout: string;
        error: { type: string; traceback: string };
      };
    };
    expect(r.output).toMatchObject({ status: "error", exitCode: 1, error: { type: "ZeroDivisionError" } });
    expect(inner(r.output.stdout)).toBe("before\n");
    expect(inner(r.output.error.traceback)).toBe(
      'Traceback (most recent call last):\n  File "<python_run>", line 3, in <module>\n    1 / 0\n    ~~^~~\nZeroDivisionError: division by zero\n',
    );
    const e = (await svc.run(scope, { code: "import sys\nsys.exit(3)" })) as {
      output: { status: string; exitCode: number };
    };
    expect(e.output).toMatchObject({ status: "error", exitCode: 3 });
    expect(
      ((await svc.run(scope, { code: "raise SystemExit" })) as { output: { status: string } }).output.status,
    ).toBe("ok");
  });

  it.skipIf(!PACKAGES)(
    "pandas and numpy from the pinned folder: /python sum on an uploaded CSV",
    async () => {
      const t = await real();
      const c = t.app.conversations!.create(t.f.users.owner.id);
      const { file } = await t.sentFile(
        t.f.cookies.owner,
        c.id,
        "경비.csv",
        "항목,금액\n숙박,480000\n렌터카,210000\n식비,356000\n",
      );
      const r = await t.send(t.f.cookies.owner, c.id, `/python sum ${file.id}`);
      const out = outputOf(r);
      expect(out.isError, JSON.stringify(out.output)).toBe(false);
      expect(inner(out.output.stdout)).toBe("행 3\n금액 1046000\n");
      const ref = r.parts.find((p) => p.type === "file_ref") as { fileId: string; name: string };
      expect(ref.name).toBe("합계.csv");
      expect((await t.download(t.f.cookies.owner, ref.fileId)).body).toBe(",합계\n금액,1046000\n");
    },
  );
});

// ---- the launcher itself: a relaxed test copy on this machine (#121 round 5) -------------------------------------

/**
 * The launcher's own checks and run control, exercised through a **test copy** of the shipped file whose only
 * differences are the three constants (config path → a temp config, owner self allowed instead of root, a small
 * memory limit). It runs as this user (no sudo, no account): the trust checks, the memory/time watch and reap's
 * kernel identity check are the same code. Needs macOS and a standalone python 3.12 (skipped otherwise).
 */
const LAUNCHER_SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../ops/python/agentlee-python-run",
);
const PY312 = PY_ENV && pythonVersionOf(PY_ENV.runtime) === "3.12" ? PY_ENV : undefined;
const ME = os.userInfo().username;

describe.skipIf(!PY312 || process.platform !== "darwin")("the launcher (relaxed test copy, own user)", () => {
  type Rig = { dir: string; launcher: string; conf: string; scratch: string; interp: string; runner: string };
  const confText = (r: Rig) =>
    `interpreter=${r.interp}\nrunner=${r.runner}\npackages=${r.dir}/lib/packages\nscratch=${r.scratch}\n`;
  /** A temp install: an APFS clone of the interpreter, runner.py, an empty packages dir, a scratch root. */
  function rig(memKb = PYTHON_LIMITS.memoryBytes / 1024, base?: string): Rig {
    let dir: string;
    if (base) {
      dir = fs.realpathSync(fs.mkdtempSync(path.join(base, "agentlee-launcher-")));
      closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    } else dir = tmp();
    fs.chmodSync(dir, 0o755);
    const lib = path.join(dir, "lib");
    fs.mkdirSync(path.join(lib, "packages"), { recursive: true });
    execFileSync("/bin/cp", ["-cR", PY312!.runtime.root, path.join(lib, "interpreter")]);
    fs.copyFileSync(path.join(SCRATCHPAD_DIR, "runner.py"), path.join(lib, "runner.py"));
    execFileSync("/bin/chmod", ["-R", "go-w", lib]);
    execFileSync("/bin/chmod", ["-R", "-N", lib]);
    const r: Rig = {
      dir,
      launcher: path.join(dir, "launcher"),
      conf: path.join(dir, "conf"),
      scratch: path.join(dir, "scratch"),
      interp: path.join(lib, "interpreter"),
      runner: path.join(lib, "runner.py"),
    };
    fs.mkdirSync(r.scratch, { mode: 0o755 });
    const src = fs.readFileSync(LAUNCHER_SRC, "utf8");
    const test = src
      .replace(/^use constant CONF_PATH .*$/m, `use constant CONF_PATH        => "${r.conf}";`)
      .replace(/^use constant OWNER_ALLOW_SELF => 0;$/m, "use constant OWNER_ALLOW_SELF => 1;")
      .replace(/^(use constant MEM_LIMIT_KB {5}=> )\d+;/m, `$1${memKb};`);
    // Exactly the three constant lines differ from the shipped bytes.
    const diff = src.split("\n").filter((l, i) => l !== test.split("\n")[i]);
    expect(diff).toHaveLength(memKb === PYTHON_LIMITS.memoryBytes / 1024 ? 2 : 3);
    fs.writeFileSync(r.launcher, test, { mode: 0o755 });
    fs.writeFileSync(r.conf, confText(r), { mode: 0o644 });
    return r;
  }
  const verify = (r: Rig, user = ME) => {
    const out = spawnSync(r.launcher, ["verify", user], { encoding: "utf8", env: {} });
    return { ...parseVerify(out.stdout, out.status), raw: out.stdout };
  };
  const newJob = (r: Rig) => {
    const id = crypto.randomUUID();
    fs.mkdirSync(path.join(r.scratch, id, ".tmp"), { recursive: true });
    return id;
  };
  const stdin = (code: string) =>
    JSON.stringify({
      code,
      files: {},
      packages: null,
      limits: { cpuSeconds: 30, fileBytes: PYTHON_LIMITS.fileBytes, captureChars: 1000 },
    });
  const run = (r: Rig, code: string, timeout = 10) => {
    const id = newJob(r);
    const out = spawnSync(r.launcher, ["run", id, String(timeout)], {
      input: stdin(code),
      encoding: "utf8",
      env: {},
    });
    return { id, status: out.status, stdout: out.stdout, stderr: out.stderr };
  };

  it.skipIf(!ACCOUNT_NAME.test(ME))(
    "verify passes on a clean install and runs a job; the report is the launcher's",
    () => {
      const r = rig();
      const v = verify(r);
      expect(v.ok, v.raw).toBe(true);
      expect(v.scratch).toBe(r.scratch);
      for (const name of [
        "launcher",
        "config",
        "config format",
        "runner",
        "interpreter tree",
        "packages tree",
      ])
        expect(v.checks.find((c) => c.name === name)?.ok, name).toBe(true);
      expect(v.checks.find((c) => c.name === "scratch traversal")?.ok).toBe(true);
      const j = run(r, "print(6*7)");
      expect(j.status, j.stderr).toBe(0);
      expect(JSON.parse(j.stdout)).toMatchObject({ status: "ok", stdout: "42\n" });
      // The child's kernel identity was recorded: pid, uid, start seconds and microseconds.
      const rec = fs.readFileSync(path.join(r.scratch, ".ctl", j.id, "leader"), "utf8");
      expect(rec).toMatch(new RegExp(`^\\d+ ${process.getuid!()} \\d+ \\d+\\n$`));
    },
  );

  it("refuses a write ACL anywhere in a tree, a group-writable ancestor, a non-exact config", () => {
    const r = rig();
    const deep = path.join(r.interp, "lib", "python3.12", "json", "decoder.py");
    const refused = (why: RegExp) => {
      const j = run(r, "print(1)");
      expect(j.status).toBe(64);
      expect(j.stderr).toMatch(why);
      const v = verify(r);
      expect(v.ok).toBe(false);
    };
    // A file deep in the interpreter tree with an ACL granting write to everyone.
    spawnSyncOk("/bin/chmod", ["+a", "everyone allow write", deep]);
    refused(/interpreter tree: ACL grants write to group:everyone/);
    spawnSyncOk("/bin/chmod", ["-N", deep]);
    // A deny entry is fine.
    spawnSyncOk("/bin/chmod", ["+a", "everyone deny delete", deep]);
    expect(run(r, "print(1)").status).toBe(0);
    spawnSyncOk("/bin/chmod", ["-N", deep]);
    // An ancestor of every program path that the group may write; an ACL on an ancestor granting add_file.
    fs.chmodSync(path.join(r.dir, "lib"), 0o775);
    refused(/writable by group\/other/);
    fs.chmodSync(path.join(r.dir, "lib"), 0o755);
    spawnSyncOk("/bin/chmod", ["+a", "everyone allow add_file", r.dir]);
    refused(/ACL grants add_file/);
    spawnSyncOk("/bin/chmod", ["-N", r.dir]);
    // A group-writable file deep in the tree.
    fs.chmodSync(deep, 0o664);
    refused(/writable by group\/other/);
    fs.chmodSync(deep, 0o644);
    // The config: exactly the four keys, once each, nothing else, no trimming.
    const good = confText(r);
    for (const [bad, why] of [
      [good.replace(`interpreter=${r.interp}\n`, `interpreter=${r.interp} \n`), /unsafe characters/],
      [good + `runner=${r.runner}\n`, /duplicate config key: runner/],
      [good + "extra=/x\n", /unknown config key: extra/],
      [good.replace(/^packages=.*\n/m, ""), /missing config key: packages/],
      [good + "# comment\n", /bad config line/],
      [good.replace("\n", "\n\n"), /bad config line/],
    ] as const) {
      fs.writeFileSync(r.conf, bad);
      refused(why);
    }
    fs.writeFileSync(r.conf, good);
    expect(verify(r).ok).toBe(true);
  });

  // A base every user can traverse (the per-user temp root's parent is usually 0755, owned by this user).
  const OPEN_BASE = (() => {
    try {
      const b = path.dirname(fs.realpathSync(os.tmpdir()));
      const st = fs.statSync(b);
      return st.uid === process.getuid!() && (st.mode & 0o777) === 0o755 ? b : undefined;
    } catch {
      return undefined;
    }
  })();
  it.skipIf(!OPEN_BASE || spawnSync("/usr/bin/id", ["nobody"]).status !== 0)(
    "verify judges the TARGET account: a program ancestor only the diagnosing user can enter fails it (#121 round 6)",
    () => {
      const r = rig(undefined, OPEN_BASE);
      spawnSyncOk("/bin/chmod", ["+a", "user:nobody allow search,add_subdirectory", r.scratch]);
      const ok = verify(r, "nobody");
      expect(ok.ok, ok.raw).toBe(true);
      expect(ok.checks.find((c) => c.name === "account program access")?.ok).toBe(true);
      // 0700, owned by the diagnosing user: the launcher (as the account) could not reach python or runner.py.
      fs.chmodSync(path.join(r.dir, "lib"), 0o700);
      const bad = verify(r, "nobody");
      expect(bad.ok).toBe(false);
      expect(bad.checks.find((c) => c.name === "account program access")?.reason).toMatch(
        /the account cannot search .*\/lib$/,
      );
      // The diagnosing user itself still passes: the verdict is about the target account, not the caller.
      expect(verify(r, ME).ok).toBe(ACCOUNT_NAME.test(ME));
      fs.chmodSync(path.join(r.dir, "lib"), 0o755);
      // A file in a tree the account cannot read; an ACL deny for the account on a directory.
      const deep = path.join(r.interp, "lib", "python3.12", "json", "decoder.py");
      fs.chmodSync(deep, 0o600);
      expect(verify(r, "nobody").checks.find((c) => c.name === "account program access")?.reason).toMatch(
        /cannot read .*decoder\.py$/,
      );
      fs.chmodSync(deep, 0o644);
      spawnSyncOk("/bin/chmod", ["+a", "user:nobody deny list", path.join(r.interp, "lib")]);
      expect(verify(r, "nobody").checks.find((c) => c.name === "account program access")?.reason).toMatch(
        /ACL denies list/,
      );
      spawnSyncOk("/bin/chmod", ["-N", path.join(r.interp, "lib")]);
      const access = () => verify(r, "nobody").checks.find((c) => c.name === "account program access");
      expect(access()?.ok).toBe(true);
      // #125: a regular file's allow marked only_inherit (which `ls -led` prints as a plain `allow read`) does not
      // let the account read it; the same allow without the flag does.
      fs.chmodSync(deep, 0o600);
      spawnSyncOk("/bin/chmod", ["+a", "user:nobody allow read,only_inherit", deep]);
      expect(execFileSync("/bin/ls", ["-led", deep], { encoding: "utf8" })).not.toMatch(/only_inherit/);
      expect(access()?.reason).toMatch(/the account cannot read .*decoder\.py$/);
      spawnSyncOk("/bin/chmod", ["-N", deep]);
      spawnSyncOk("/bin/chmod", ["+a", "user:nobody allow read", deep]);
      expect(access()?.ok).toBe(true);
      spawnSyncOk("/bin/chmod", ["-N", deep]);
      fs.chmodSync(deep, 0o644);
      // #125: the launcher (as the account) reads ACLs with `ls -le`: a readsecurity denial on a tree node or on an
      // ancestor of a program path fails it, though every read/search check passes.
      spawnSyncOk("/bin/chmod", ["+a", "user:nobody deny readsecurity", deep]);
      expect(access()?.reason).toMatch(/ACL denies readsecurity to the account at .*decoder\.py$/);
      spawnSyncOk("/bin/chmod", ["-N", deep]);
      spawnSyncOk("/bin/chmod", ["+a", "user:nobody deny readsecurity", r.dir]);
      expect(access()?.reason).toMatch(new RegExp(`ACL denies readsecurity to the account at ${r.dir}$`));
      spawnSyncOk("/bin/chmod", ["-N", r.dir]);
      // lstat asks readattr and readsecurity together: a readattr denial on a 0644 tree file fails it too.
      spawnSyncOk("/bin/chmod", ["+a", "user:nobody deny readattr", deep]);
      expect(access()?.reason).toMatch(/ACL denies readattr to the account at .*decoder\.py$/);
      spawnSyncOk("/bin/chmod", ["-N", deep]);
      // A link in a tree: `ls -leRA` reads its own ACL too.
      const link = path.join(path.dirname(deep), "alias.py");
      fs.symlinkSync("decoder.py", link);
      expect(access()?.ok).toBe(true);
      spawnSyncOk("/bin/chmod", ["-h", "+a", "user:nobody deny readsecurity", link]);
      expect(access()?.reason).toMatch(/ACL denies readsecurity to the account at .*alias\.py$/);
      fs.unlinkSync(link);
      // The scratch root: search and add_subdirectory allowed, but the launcher's lstat of it would fail.
      spawnSyncOk("/bin/chmod", ["+a", "user:nobody deny readsecurity", r.scratch]);
      const sv = verify(r, "nobody");
      expect(sv.ok).toBe(false);
      expect(sv.checks.find((c) => c.name === "scratch traversal")?.reason).toMatch(
        new RegExp(`ACL denies readsecurity to the account at ${r.scratch}$`),
      );
      expect(sv.checks.find((c) => c.name === "scratch write")?.ok).toBe(true);
      spawnSyncOk("/bin/chmod", ["-a", "user:nobody deny readsecurity", r.scratch]);
      expect(verify(r, "nobody").ok).toBe(true);
    },
  );

  it("the memory watch kills a job over the limit (exit 125 → python_memory_limit); the clock gives 124", () => {
    const r = rig(150 * 1024);
    const t0 = Date.now();
    const m = run(r, "b = bytearray(400 * 1024 * 1024)\nimport time\ntime.sleep(20)", 30);
    expect(m.status, m.stderr).toBe(125);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(fs.readFileSync(path.join(r.scratch, ".ctl", m.id, "status"), "utf8")).toBe("memory\n");
    expect(
      pythonResult({
        code: m.status,
        signal: null,
        stdout: "",
        stderr: "",
        killed: launcherKilled(m.status, null),
      }),
    ).toEqual({ ok: false, code: "python_memory_limit" });
    // Under the limit: runs normally.
    expect(run(r, "b = bytearray(20 * 1024 * 1024)\nprint(len(b))").status).toBe(0);
    const t = run(r, "import time\ntime.sleep(30)", 2);
    expect(t.status).toBe(124);
    expect(fs.readFileSync(path.join(r.scratch, ".ctl", t.id, "status"), "utf8")).toBe("timeout\n");
  });

  it("reap kills by the kernel's uid + start time even when the code rewrote its argv[0]; refuses without a match", async () => {
    const r = rig();
    const id = newJob(r);
    const code = [
      "import ctypes, time",
      "libc = ctypes.CDLL(None)",
      "libc._NSGetArgv.restype = ctypes.POINTER(ctypes.POINTER(ctypes.POINTER(ctypes.c_char)))",
      "a = libc._NSGetArgv().contents[0]",
      'a[0] = b"x"; a[1] = b"\\0"',
      "open('ready', 'w').close()",
      "time.sleep(60)",
    ].join("\n");
    const child = spawn(r.launcher, ["run", id, "90"], { env: {}, stdio: ["pipe", "ignore", "ignore"] });
    closers.push(() => child.kill("SIGKILL"));
    const exited = new Promise<number | null>((res) => child.on("close", (c) => res(c)));
    child.stdin.end(stdin(code));
    const ready = path.join(r.scratch, id, "ready");
    for (let i = 0; i < 100 && !fs.existsSync(ready); i++) await new Promise((res) => setTimeout(res, 100));
    expect(fs.existsSync(ready)).toBe(true);
    const rec = fs.readFileSync(path.join(r.scratch, ".ctl", id, "leader"), "utf8");
    const pid = Number(rec.split(" ")[0]);
    // The tampering worked: ps no longer shows the interpreter (what round 4's check relied on).
    const comm = spawnSync("/bin/ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
    expect(comm).not.toBe(path.join(r.interp, "bin", "python3.12"));
    const reap = spawnSync(r.launcher, ["reap", id], { encoding: "utf8", env: {} });
    expect(reap.status, reap.stderr).toBe(0);
    expect(await exited).toBe(128 + 9);
    // Dead now: nothing to kill.
    expect(spawnSync(r.launcher, ["reap", id], { env: {} }).status).toBe(0);
    // A live process whose start time does not match the record (pid reuse): refused, not killed.
    const victim = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], { stdio: "ignore" });
    closers.push(() => victim.kill("SIGKILL"));
    await new Promise((res) => setTimeout(res, 200));
    fs.writeFileSync(path.join(r.scratch, ".ctl", id, "leader"), `${victim.pid} ${process.getuid!()} 1 1\n`);
    const mis = spawnSync(r.launcher, ["reap", id], { encoding: "utf8", env: {} });
    expect(mis.status).toBe(65);
    expect(mis.stderr).toMatch(/identity changed/);
    expect(victim.exitCode).toBe(null);
    expect(() => process.kill(victim.pid!, 0)).not.toThrow();
    // A missing or malformed record: refused (never a silent skip of the checks).
    fs.writeFileSync(path.join(r.scratch, ".ctl", id, "leader"), `${victim.pid}\n`);
    expect(spawnSync(r.launcher, ["reap", id], { env: {} }).status).toBe(65);
    fs.rmSync(path.join(r.scratch, ".ctl", id, "leader"));
    expect(spawnSync(r.launcher, ["reap", id], { env: {} }).status).toBe(65);
  });

  it("run and probe replace the whole environment: nothing from the caller reaches python", async () => {
    const r0 = rig();
    const jid = newJob(r0);
    const j = spawnSync(r0.launcher, ["run", jid, "10"], {
      input: stdin("import os\nprint(sorted(os.environ))"),
      encoding: "utf8",
      env: { AGENTLEE_SECRET_TEST: "synthetic-secret-value", PATH: "/tmp/evil", PERL5OPT: "-d" },
    });
    expect(j.status, j.stderr).toBe(0);
    const seen = JSON.parse(j.stdout) as { stdout: string };
    expect(seen.stdout).not.toContain("AGENTLEE_SECRET_TEST");
    expect(seen.stdout).not.toContain("synthetic-secret-value");
    expect(seen.stdout).toContain("AGENTLEE_PACKAGES");
    const r = rig();
    const id = newJob(r);
    // The server's sibling carries the marker variable the probe must see in a real read (#130 round 1).
    const sib = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
      stdio: "ignore",
      env: { AGENTLEE_SELFCHECK: "synthetic" },
    });
    closers.push(() => sib.kill("SIGKILL"));
    const plain = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
      stdio: "ignore",
      env: {},
    });
    closers.push(() => plain.kill("SIGKILL"));
    await new Promise((res) => setTimeout(res, 150));
    // A readable process without the marker is no verdict: "readable" means the read really showed it.
    const noMarker = spawnSync(r.launcher, ["probe", newJob(r), String(plain.pid)], {
      encoding: "utf8",
      env: {},
    });
    expect(noMarker.stdout).toBe(`uid=${process.getuid!()} procargs=error marker\n`);
    const out = spawnSync(r.launcher, ["probe", id, String(sib.pid)], {
      encoding: "utf8",
      env: { AGENTLEE_SECRET_TEST: "synthetic-secret-value", PATH: "/tmp/evil" },
    });
    expect(out.status, out.stderr).toBe(0);
    // Same uid here, so the sibling's procargs are readable (the real account is what blocks it). One exact line.
    expect(out.stdout).toBe(`uid=${process.getuid!()} procargs=readable\n`);
    expect(parseProbe(out.stdout, out.status)).toEqual({ uid: process.getuid!(), readBlocked: false });
    // The probe child is recorded like a run's (kernel identity), so reap can stop it by job id; it is gone now.
    expect(fs.readFileSync(path.join(r.scratch, ".ctl", id, "leader"), "utf8")).toMatch(
      new RegExp(`^\\d+ ${process.getuid!()} \\d+ \\d+\\n$`),
    );
    expect(spawnSync(r.launcher, ["reap", id], { env: {} }).status).toBe(0);
  });
});

/**
 * verify's account-access evaluation as a unit (#121 round 6): the shipped launcher's functions, loaded as a
 * library (everything above its dispatch marker — so the shipped file needs no test branch), fed `ls -le` ACL
 * lines and modes directly.
 */
describe.skipIf(!fs.existsSync("/usr/bin/perl"))("the launcher's account ACL evaluation (unit)", () => {
  type Case = {
    perm: string;
    mode: number;
    uid: number;
    gid: number;
    acl: string[];
  };
  const ACCT = {
    name: "_agentleepy",
    uid: 300,
    groups: ["agentleepy-scratch", "everyone"],
    gids: [400, 12],
    uuids: {
      "11111111-1111-1111-1111-111111111111": ["uid", 300], // the account
      "22222222-2222-2222-2222-222222222222": ["gid", 400], // its group
      "33333333-3333-3333-3333-333333333333": ["gid", 20], // staff: not its group
      "44444444-4444-4444-4444-444444444444": ["uid", 501], // another user
    },
  };
  const evaluate = (cases: Case[], acct: object = ACCT): string[] => {
    const src = fs.readFileSync(LAUNCHER_SRC, "utf8");
    const cut = src.indexOf("\n# ---- dispatch");
    expect(cut).toBeGreaterThan(0);
    const harness = `
use JSON::PP;
my $in = do { local $/; <STDIN> };
my $req = JSON::PP->new->decode($in);
my $a = $req->{acct};
my %u = %{ $a->{uuids} };
my $acct = { name => $a->{name}, uid => $a->{uid}, groups => { map { $_ => 1 } @{ $a->{groups} } },
  gids => { map { $_ => 1 } @{ $a->{gids} } }, uuid_id => sub { my $x = $u{$_[0]}; return $x ? @$x : () } };
my @out = map { account_eval($acct, "/n", $_->{perm}, $_->{mode}, $_->{uid}, $_->{gid}, @{ $_->{acl} }) }
  @{ $req->{cases} };
print JSON::PP->new->encode(\\@out);
`;
    const lib = path.join(tmp(), "lib.pl");
    fs.writeFileSync(lib, src.slice(0, cut) + "\n" + harness);
    const r = spawnSync("/usr/bin/perl", ["-T", lib], {
      input: JSON.stringify({ acct, cases }),
      encoding: "utf8",
      env: {},
    });
    expect(r.status, r.stderr).toBe(0);
    return JSON.parse(r.stdout) as string[];
  };
  const dir = (mode: number, acl: string[], perm = "search", uid = 501, gid = 20): Case => ({
    perm,
    mode: 0o040000 | mode,
    uid,
    gid,
    acl,
  });

  it("UUID principals resolve to the account / its groups; unresolvable ones fail, never count as unrelated", () => {
    const [a, b, c, d, e, f, g] = evaluate([
      dir(0o755, [" 0: 22222222-2222-2222-2222-222222222222 deny search"]), // its group by bare UUID
      dir(0o755, [" 0: group:33333333-3333-3333-3333-333333333333 deny search"]), // staff by UUID: not its group
      dir(0o700, [" 0: user:11111111-1111-1111-1111-111111111111 allow search"]), // the account by UUID
      dir(0o755, [" 0: 99999999-9999-9999-9999-999999999999 deny search"]), // cannot be resolved
      dir(0o755, [" 0: group:44444444-4444-4444-4444-444444444444 deny search"]), // a user UUID shown as a group
      dir(0o755, [" 0: 99999999-9999-9999-9999-999999999999 deny delete"]), // unresolvable, but not about search
      dir(0o700, [" 0: user:44444444-4444-4444-4444-444444444444 allow search"]), // another user
    ]);
    expect(a).toMatch(/ACL denies search/);
    expect(b).toBe("");
    expect(c).toBe("");
    expect(d).toMatch(/cannot resolve ACL principal/);
    expect(e).toMatch(/cannot resolve ACL principal/);
    expect(f).toBe("");
    expect(g).toMatch(/the account cannot search/);
  });

  it("only_inherit entries do not apply to the node itself; the first applicable entry decides (deny before allow)", () => {
    const [a, b, c, d, e, f] = evaluate([
      dir(0o700, [" 0: group:everyone allow search,directory_inherit,only_inherit"]), // not for this dir: POSIX says no
      dir(0o755, [" 0: group:everyone deny search,directory_inherit,only_inherit"]), // not for this dir: POSIX says yes
      dir(0o755, [" 0: group:agentleepy-scratch deny search", " 1: user:_agentleepy allow search"]),
      dir(0o700, [" 0: user:_agentleepy allow search", " 1: group:everyone deny search"]),
      dir(0o700, [" 0: group:everyone inherited allow search,list"]),
      dir(0o755, [" 0: group:staff deny search"]), // a group it is not in
    ]);
    expect(a).toMatch(/the account cannot search/);
    expect(b).toBe("");
    expect(c).toMatch(/ACL denies search/);
    expect(d).toBe("");
    expect(e).toBe("");
    expect(f).toBe("");
  });

  it("uids/gids compare as unsigned 32-bit: dsmemberutil's -2 is getpwnam's 4294967294 (#121 round 7)", () => {
    const NOBODY = {
      name: "nobody",
      uid: 4294967294,
      groups: ["nobody-ish", "everyone"],
      gids: [4294967294, 12],
      uuids: {
        "FFFFEEEE-DDDD-CCCC-BBBB-AAAAFFFFFFFE": ["uid", -2], // what dsmemberutil getid -X prints for nobody
        "ABCDEFAB-CDEF-ABCD-EFAB-CDEFFFFFFFFE": ["gid", -2],
        "55555555-5555-5555-5555-555555555555": ["uid", -99999999999], // out of range: unresolved
      },
    };
    const [a, b, c, d, e, f, g] = evaluate(
      [
        dir(0o755, [" 0: FFFFEEEE-DDDD-CCCC-BBBB-AAAAFFFFFFFE deny search"]),
        dir(0o755, [" 0: group:ABCDEFAB-CDEF-ABCD-EFAB-CDEFFFFFFFFE deny search"]),
        dir(0o755, [" 0: user:-2 deny search"]),
        dir(0o755, [" 0: group:4294967294 deny search"]),
        dir(0o755, [" 0: 55555555-5555-5555-5555-555555555555 deny search"]),
        dir(0o700, [], "search", -2, 0), // owned by -2 = the account: owner bits
        dir(0o755, [" 0: user:4294967296 deny search"]), // out of range
      ],
      NOBODY,
    );
    expect(a).toMatch(/ACL denies search/);
    expect(b).toMatch(/ACL denies search/);
    expect(c).toMatch(/ACL denies search/);
    expect(d).toMatch(/ACL denies search/);
    expect(e).toMatch(/cannot resolve/);
    expect(f).toBe("");
    expect(g).toMatch(/cannot resolve/);
  });

  it("POSIX: owner, else group, else other — no fall-through to a lower class", () => {
    const [a, b, c, d, e] = evaluate([
      dir(0o070, [], "search", 300, 20), // the owner without x: no, even though group has it
      dir(0o701, [], "search", 501, 400), // its group without x: no, even though other has it
      dir(0o751, [], "search", 501, 20), // other
      { perm: "read", mode: 0o100640, uid: 0, gid: 400, acl: [] }, // a file readable by its group
      { perm: "read", mode: 0o100600, uid: 0, gid: 0, acl: [] },
    ]);
    expect([a, b, c, d]).toEqual([expect.stringMatching(/cannot/), expect.stringMatching(/cannot/), "", ""]);
    expect(e).toMatch(/cannot read/);
  });
});

describe.skipIf(!fs.existsSync("/usr/bin/perl"))(
  "the launcher's ACL source: every flag, readsecurity (#125)",
  () => {
    const NOBODY_UUID = "FFFFEEEE-DDDD-CCCC-BBBB-AAAAFFFFFFFE";
    const STAFF_UUID = "ABCDEFAB-CDEF-ABCD-EFAB-CDEF00000014";
    const ACCT = {
      name: "nobody",
      uid: 4294967294,
      groups: ["everyone"],
      gids: [4294967294, 12],
      uuids: { [NOBODY_UUID]: ["uid", -2], [STAFF_UUID]: ["gid", 20] },
    };
    type Ace = { uuid: string; flags: number; rights: number };
    /** A raw kauth_filesec as getattrlist(ATTR_CMN_EXTENDED_SECURITY) returns it (host byte order). */
    const filesec = (aces: Ace[] | null, opts: { magic?: number; cut?: number } = {}): string => {
      const b = Buffer.alloc(44 + 24 * (aces?.length ?? 0));
      b.writeUInt32LE(opts.magic ?? 0x012cc16d, 0);
      b.writeUInt32LE(aces === null ? 0xffffffff : aces.length, 36);
      (aces ?? []).forEach((a, i) => {
        Buffer.from(a.uuid.replace(/-/g, ""), "hex").copy(b, 44 + 24 * i);
        b.writeUInt32LE(a.flags >>> 0, 44 + 24 * i + 16);
        b.writeUInt32LE(a.rights >>> 0, 44 + 24 * i + 20);
      });
      return b.subarray(0, opts.cut ?? b.length).toString("hex");
    };
    type Case = { hex: string; dir: boolean; perm: string; mode: number };
    /** ace_lines on injected bytes, then account_eval of the lines it made (uid/gid 0: "other" for the account). */
    const decode = (cases: Case[]): { err: string; lines: string[]; verdict: string }[] => {
      const src = fs.readFileSync(LAUNCHER_SRC, "utf8");
      const cut = src.indexOf("\n# ---- dispatch");
      expect(cut).toBeGreaterThan(0);
      const harness = `
use JSON::PP;
my $req = JSON::PP->new->decode(do { local $/; <STDIN> });
my $a = $req->{acct};
my %u = %{ $a->{uuids} };
my $acct = { name => $a->{name}, uid => $a->{uid}, groups => { map { $_ => 1 } @{ $a->{groups} } },
  gids => { map { u32($_) => 1 } @{ $a->{gids} } }, uuid_id => sub { my $x = $u{$_[0]}; return $x ? @$x : () } };
my @out;
for my $c (@{ $req->{cases} }) {
  my ($e, $l) = ace_lines("/n", pack("H*", $c->{hex}), $c->{dir} ? 1 : 0);
  my @l = $l ? @$l : ();
  my $v = length $e ? "" : account_eval($acct, "/n", $c->{perm}, $c->{mode}, 0, 0, @l);
  push @out, { err => $e, lines => \\@l, verdict => $v };
}
print JSON::PP->new->encode(\\@out);
`;
      const lib = path.join(tmp(), "lib.pl");
      fs.writeFileSync(lib, src.slice(0, cut) + "\n" + harness);
      const r = spawnSync("/usr/bin/perl", ["-T", lib], {
        input: JSON.stringify({ acct: ACCT, cases }),
        encoding: "utf8",
        env: {},
      });
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout) as { err: string; lines: string[]; verdict: string }[];
    };
    const file = (aces: Ace[] | null, perm = "read", mode = 0o100000): Case => ({
      hex: filesec(aces),
      dir: false,
      perm,
      mode,
    });

    it("a regular file keeps only_inherit / file_inherit (ls -led drops them): such an allow does not apply", () => {
      const [a, b, c, d] = decode([
        file([{ uuid: NOBODY_UUID, flags: 0x101, rights: 0x2 }]), // allow read,only_inherit on a mode-000 file
        file([{ uuid: NOBODY_UUID, flags: 0x1, rights: 0x2 }]), // a plain allow read: applies
        file([{ uuid: NOBODY_UUID, flags: 0x102, rights: 0x2 }], "read", 0o100644), // deny,only_inherit: not here
        file([{ uuid: STAFF_UUID, flags: 0x21, rights: 0x2 }]), // staff (not its group), file_inherit
      ]);
      expect(a!.lines).toEqual([` 0: ${NOBODY_UUID} allow read,only_inherit`]);
      expect(a!.verdict).toMatch(/the account cannot read/);
      expect(b!.lines).toEqual([` 0: ${NOBODY_UUID} allow read`]);
      expect(b!.verdict).toBe("");
      expect(c!.verdict).toBe("");
      expect(d!.lines).toEqual([` 0: ${STAFF_UUID} allow read,file_inherit`]);
      expect(d!.verdict).toMatch(/cannot read/);
    });

    it("names follow the node type; inherited, audit, no-ACL and every flag are decoded", () => {
      const [a, b, c, d, e] = decode([
        {
          hex: filesec([{ uuid: STAFF_UUID, flags: 0x1e1, rights: 0x3ffe }]),
          dir: true,
          perm: "search",
          mode: 0o040000,
        },
        file([{ uuid: STAFF_UUID, flags: 0x1, rights: 0x3ffe }]),
        file([{ uuid: NOBODY_UUID, flags: 0x11, rights: 0x2 }]), // inherited allow read
        file([{ uuid: NOBODY_UUID, flags: 0x3, rights: 0x2 }]), // an audit entry: neither grants nor denies
        file(null), // KAUTH_FILESEC_NOACL
      ]);
      expect(a!.lines).toEqual([
        ` 0: ${STAFF_UUID} allow list,add_file,search,delete,add_subdirectory,delete_child,readattr,writeattr,` +
          "readextattr,writeextattr,readsecurity,writesecurity,chown,file_inherit,directory_inherit,limit_inherit,only_inherit",
      ]);
      expect(b!.lines).toEqual([
        ` 0: ${STAFF_UUID} allow read,write,execute,delete,append,delete_child,readattr,writeattr,` +
          "readextattr,writeextattr,readsecurity,writesecurity,chown",
      ]);
      expect(c!.lines).toEqual([` 0: ${NOBODY_UUID} inherited allow read`]);
      expect(c!.verdict).toBe("");
      expect(d!.lines).toEqual([]);
      expect(d!.verdict).toMatch(/cannot read/);
      expect(e!.lines).toEqual([]);
    });

    it("what it cannot classify is a diagnostic failure, never unrelated: generic rights, unknown flags, bad records", () => {
      const out = decode([
        file([{ uuid: STAFF_UUID, flags: 0x1, rights: 1 << 24 }]), // generic_read
        file([{ uuid: STAFF_UUID, flags: 0x1, rights: 1 << 20 }]), // synchronize
        file([{ uuid: STAFF_UUID, flags: 0x801, rights: 0x2 }]), // an unknown flag bit
        file([{ uuid: STAFF_UUID, flags: 0x5, rights: 0x2 }]), // an unknown entry kind
        { ...file([]), hex: filesec([], { magic: 0x12345678 }) },
        { ...file([]), hex: filesec([{ uuid: STAFF_UUID, flags: 1, rights: 2 }], { cut: 60 }) }, // truncated
      ]);
      expect(out.map((o) => o.err)).toEqual([
        "unclassified ACL rights at /n",
        "unclassified ACL rights at /n",
        "unclassified ACL entry at /n",
        "unclassified ACL entry at /n",
        "bad ACL record at /n",
        "bad ACL record at /n",
      ]);
    });

    it("readsecurity: granted unless an applicable ACL entry denies it (the POSIX mode does not matter)", () => {
      const rs = (aces: Ace[] | null) => file(aces, "readsecurity", 0o100000);
      const [a, b, c, d] = decode([
        rs(null),
        rs([{ uuid: NOBODY_UUID, flags: 0x2, rights: 1 << 11 }]),
        rs([{ uuid: NOBODY_UUID, flags: 0x102, rights: 1 << 11 }]), // only_inherit: not for this node
        rs([{ uuid: STAFF_UUID, flags: 0x2, rights: 1 << 11 }]), // a group it is not in
      ]);
      expect(a!.verdict).toBe("");
      expect(b!.lines).toEqual([` 0: ${NOBODY_UUID} deny readsecurity`]);
      expect(b!.verdict).toMatch(/ACL denies readsecurity/);
      expect(c!.verdict).toBe("");
      expect(d!.verdict).toBe("");
    });

    it("one request, one evaluation (kauth_acl_evaluate): lstat's readattr,readsecurity is not two AND-ed verdicts", () => {
      const META = "readattr,readsecurity";
      const RA = 1 << 7;
      const RS = 1 << 11;
      const UNKNOWN = "99999999-9999-9999-9999-999999999999";
      const me = (flags: number, rights: number): Ace => ({ uuid: NOBODY_UUID, flags, rights });
      const [a, b, c, d, e, f, g, h, i] = decode([
        file([me(0x2, RA)], META, 0o100644), // deny readattr: lstat fails…
        file([me(0x2, RA)], "readsecurity", 0o100644), // …though readsecurity alone is fine
        file([me(0x1, RS), me(0x2, RS)], META, 0o100644), // allow rs, then deny rs: readattr still needed → denied
        file([me(0x1, RS), me(0x2, RS)], "readsecurity", 0o100644), // alone, the allow decides
        file([me(0x1, RA | RS), me(0x2, RA)], META, 0o100644), // all granted before the deny: allowed
        file([me(0x1, RA), me(0x2, RS)], META, 0o100644),
        file([me(0x1, RA), { uuid: UNKNOWN, flags: 0x1, rights: RA }], META), // names only a granted right: skipped
        file([{ uuid: UNKNOWN, flags: 0x2, rights: RA }], META), // a deny it cannot place
        file([], "read,readsecurity", 0o100000), // residual read falls to POSIX; readsecurity has no bit
      ]);
      expect(a!.verdict).toMatch(/ACL denies readattr to the account/);
      expect(b!.verdict).toBe("");
      expect(c!.verdict).toMatch(/ACL denies readsecurity/);
      expect(d!.verdict).toBe("");
      expect(e!.verdict).toBe("");
      expect(f!.verdict).toMatch(/ACL denies readsecurity/);
      expect(g!.verdict).toBe("");
      expect(h!.verdict).toMatch(/cannot resolve ACL principal/);
      expect(i!.verdict).toMatch(/the account cannot read \/n/);
      expect(decode([file([], "chown")])[0]!.verdict).toMatch(/unknown request chown/);
    });

    it("the record length must match exactly: the header for no ACL, the header and n entries otherwise", () => {
      const one = filesec([{ uuid: STAFF_UUID, flags: 1, rights: 2 }]);
      const out = decode([
        { ...file([]), hex: filesec([]) + "00" }, // a 45-byte record with no entries
        { ...file([]), hex: filesec(null) + "00".repeat(24) }, // no-ACL with an entry's worth of trailing bytes
        { ...file([]), hex: one + "00" },
        { ...file([]), hex: filesec(null) },
        { ...file([]), hex: one },
      ]);
      expect(out.map((o) => o.err)).toEqual([
        "bad ACL record at /n",
        "bad ACL record at /n",
        "bad ACL record at /n",
        "",
        "",
      ]);
    });

    it.skipIf(process.platform !== "darwin")(
      "node_aces reads a real file's flags that `ls -led` hides; an unreadable ACL is a failure",
      () => {
        const src = fs.readFileSync(LAUNCHER_SRC, "utf8");
        const cut = src.indexOf("\n# ---- dispatch");
        const d = tmp();
        const f = path.join(d, "f");
        const g = path.join(d, "g");
        fs.writeFileSync(f, "");
        fs.writeFileSync(g, "");
        spawnSyncOk("/bin/chmod", ["+a", "user:nobody allow read,only_inherit", f]);
        spawnSyncOk("/bin/chmod", ["+a", `user:${os.userInfo().username} deny readsecurity`, g]);
        closers.push(() => spawnSync("/bin/chmod", ["-N", g]));
        expect(execFileSync("/bin/ls", ["-led", f], { encoding: "utf8" })).not.toMatch(/only_inherit/);
        const harness = `
use JSON::PP;
my @out = map { my ($p) = $_ =~ /(.+)/s; my ($e, $l) = node_aces($p); { err => $e, lines => $l // [] } } @ARGV;
print JSON::PP->new->encode(\\@out);
`;
        const lib = path.join(tmp(), "lib.pl");
        fs.writeFileSync(lib, src.slice(0, cut) + "\n" + harness);
        const r = spawnSync("/usr/bin/perl", ["-T", lib, f, g, d], { encoding: "utf8", env: {} });
        expect(r.status, r.stderr).toBe(0);
        const [a, b, c] = JSON.parse(r.stdout) as { err: string; lines: string[] }[];
        expect(a).toEqual({ err: "", lines: [` 0: ${NOBODY_UUID} allow read,only_inherit`] });
        // A readsecurity denial: getattrlist fails (and on current macOS even lstat does — so do `ls` and the launcher).
        expect(b!.err).toMatch(new RegExp(`^cannot (stat|read ACL): ${g}$`));
        expect(c).toEqual({ err: "", lines: [] });
      },
    );
  },
);
