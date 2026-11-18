import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  ChartSpec,
  CSRF_HEADER,
  FINANCE_DISCLAIMER,
  TableData,
  type FinanceNotePart,
  type MessagePart,
  type Run,
} from "@agentlee/shared";
import { SELFTEST_SKILL } from "@agentlee/mcp-tools/skills";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import Database from "better-sqlite3";
import { createTestDb, openDb, runMigrations, type Db } from "../src/db/client.js";
import { KnownSecrets, knownSecrets, scrubKnown } from "../src/secrets/known.js";
import { carriesKnownSecret, decodedViews, FinanceService } from "../src/finance/service.js";
import { z } from "zod";
import { CLEANUP_PENDING_KEY, StoredRescrub } from "../src/secrets/rescrub.js";
import { COMPACTED_KEY, compactOnce } from "../src/secrets/compact.js";
import { readKey, setKey } from "../src/secrets/markers.js";
import { fetchDataset } from "../src/finance/chart.js";
import { FINANCE_TOOLS } from "@agentlee/mcp-tools/finance";
import { RuntimeRegistry, type RuntimeAdapter } from "../src/runtime/adapter.js";
import { ClaudeAdapter } from "../src/runtime/claude.js";
import { CODEX_MODELS, CodexAdapter } from "../src/runtime/codex.js";
import { FakeRuntime, type FakeScript } from "../src/runtime/fake.js";
import { fixtureFinanceWorker } from "../src/runtime/fake-finance.js";
import { replayQuery, sdk, type ReplayLog } from "./helpers/claude-replay.js";
import { cx, newLog, replaySpawn } from "./helpers/codex-replay.js";
import { callOurTool, liveCall } from "./helpers/live-mcp.js";
import { createFamily } from "./helpers/permission-matrix.js";

/**
 * Finance table and chart under the run manager (#31, M4 completion criterion): "AAPL, 005930 6개월 비교 차트" →
 * a `table` artifact, a `chart` artifact, the table part in the answer and the finance note — with sources and
 * as-of times — in **both runtimes** (Claude Code and Codex replayed from their recorded protocols, #25/#48, with a
 * real call of our `finance_chart`) and in the FakeRuntime. No network: the finance tools' URLs are answered by
 * the synthetic histories of `fake-finance.ts`, asked on a Saturday.
 */

type App = Awaited<ReturnType<typeof buildApp>>;
const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "finance-chart-"));
  closers.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

const SATURDAY = Date.parse("2026-11-14T10:00:00+09:00");

async function start(runtimes: RuntimeRegistry, o: { db?: Db; env?: Record<string, string> } = {}) {
  const db = o.db ?? createTestDb();
  const app = await buildApp(loadConfig({ NODE_ENV: "test", ...o.env }), {
    db,
    logger: false,
    runtimes,
    ...(o.masterKey ? { masterKey: o.masterKey } : {}),
    runs: { flushMs: 0 },
    mcp: {
      skills: [SELFTEST_SKILL],
      egress: () => ({
        endpoint: async () => ({ port: 9, url: "http://127.0.0.1:9", close: async () => {} }),
        close: async () => {},
      }),
      finance: { worker: fixtureFinanceWorker(() => SATURDAY), now: () => SATURDAY },
    },
  });
  closers.push(() => app.close());
  const f = await createFamily(app);
  const headers = (cookie: string) => ({
    host: "localhost:3000",
    cookie,
    origin: "http://localhost:3000",
    [CSRF_HEADER]: "1",
    "content-type": "application/json",
  });
  const send = async (cookie: string, conversationId: string, text: string, runtime?: string) => {
    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      headers: headers(cookie),
      payload: { text, ...(runtime ? { runtime } : {}) },
    });
    expect(res.statusCode, res.body).toBe(201);
    return waitRun(app, (res.json() as { run: Run }).run.id);
  };
  return { app, db, f, send, headers };
}

async function waitRun(app: App, id: string) {
  for (let i = 0; i < 1000; i++) {
    const r = app.runs!.get(id)!;
    if (r.endedAt !== null) {
      const parts = app.conversations!.messageById(r.assistantMessageId)!.parts as MessagePart[];
      return { run: r, parts, note: parts.find((p): p is FinanceNotePart => p.type === "finance_note") };
    }
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error("run did not end");
}

/**
 * What every runtime's answer must carry: a table and a chart artifact of this run, the table part with exactly
 * the table artifact's rows, sources and as-of on every row and under the chart, the note with the disclaimer, and
 * the chart's end points equal to the table's last values.
 */
function checkAnswer(app: App, r: Awaited<ReturnType<typeof waitRun>>, label: string) {
  expect(r.run.status, label).toBe("done");
  const results = r.parts.flatMap((p) => (p.type === "tool_result" ? [p] : []));
  expect(
    results.map((x) => x.isError ?? false),
    label,
  ).toEqual([false]);
  const refs = r.parts.flatMap((p) => (p.type === "artifact_ref" ? [p] : []));
  const arts = refs.map((x) => app.artifacts!.get(x.artifactId)!);
  expect(arts.map((a) => a.kind).sort(), label).toEqual(["chart", "table"]);
  const table = arts.find((a) => a.kind === "table")!;
  const chart = arts.find((a) => a.kind === "chart")!;
  const t = TableData.parse(JSON.parse(app.artifacts!.version(table.id, 1)!.content));
  const spec = ChartSpec.parse(JSON.parse(app.artifacts!.version(chart.id, 1)!.content));
  // The table part is the table artifact, row for row.
  const part = r.parts.find((p) => p.type === "table");
  expect(part, label).toMatchObject({ type: "table", artifactId: table.id });
  if (part?.type !== "table") throw new Error("no table part");
  expect(part.columns.map((c) => c.label)).toEqual(t.columns);
  expect(part.rows.map((row) => t.columns.map((_, i) => row[`c${i}`]))).toEqual(t.rows);
  // Sources and as-of: on every row, under the chart, in the note.
  const ci = (c: string) => t.columns.indexOf(c);
  for (const row of t.rows) {
    expect(row[ci("출처")]).toBeTruthy();
    expect(row[ci("기준 시각")]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} (ET|KST) 종가$/);
  }
  expect(spec.sources).toHaveLength(2);
  expect(spec.notes?.join(" ")).toMatch(/환율: Yahoo Finance USD\/KRW/);
  expect(r.note, label).toMatchObject({
    sources: expect.arrayContaining([
      expect.objectContaining({ label: "Yahoo Finance · 2026-11-13 16:00 ET 종가" }),
      expect.objectContaining({ label: "네이버 증권 · 2026-11-13 15:30 KST 종가" }),
    ]),
    disclaimer: FINANCE_DISCLAIMER,
  });
  // Chart end points = table values (both bases).
  const last = (sym: string, col: string) => t.rows.filter((x) => x[ci("종목")] === sym).at(-1)![ci(col)];
  for (const [set, col] of [
    [spec.series, "수익률 원화 기준(%)"],
    [spec.views![0]!.series, "수익률 달러 기준(%)"],
  ] as const)
    for (const s of set) expect(s.values.at(-1), `${label} ${s.name} ${col}`).toBe(last(s.name, col));
  return { table, chart, t, spec };
}

// ---- both runtimes, recorded protocols ----------------------------------------------------------------------

const PROMPT = "AAPL, 005930 6개월 비교 차트";
const CALL = {
  id: "c1",
  tool: "finance_chart",
  args: { symbols: ["AAPL", "005930"], chart: "compare", range: "6mo" },
};
const ANSWER =
  "AAPL과 삼성전자(005930)의 최근 반년 수익률을 같은 데이터로 표와 차트로 만들었어요. 출처와 기준 시각은 표의 열과 차트 아래에 있어요(Yahoo Finance · 2026-11-13 16:00 ET 종가, 네이버 증권 · 2026-11-13 15:30 KST 종가).";

const unwired = (a: RuntimeAdapter): RuntimeAdapter => ({
  id: a.id,
  capabilities: () => ({ ...a.capabilities(), needsConnection: false }),
  start: (c) => a.start(c),
  resume: (id, c) => a.resume(id, c),
});

function claude(): RuntimeAdapter {
  const root = tmp();
  const log: ReplayLog = { options: [], prompts: [], interrupts: 0, closes: 0 };
  return new ClaudeAdapter({
    connection: () => ({
      id: "c1",
      dir: path.join(root, "conn"),
      auth: { kind: "api_key", apiKey: "sk-ant-api03-TESTKEY-" + "x".repeat(20) },
    }),
    query: replayQuery(
      {
        [PROMPT]: [
          sdk.init({ session: crypto.randomUUID() }),
          liveCall(CALL.id, CALL.tool, CALL.args) as unknown as SDKMessage,
          sdk.delta(ANSWER),
          sdk.result(),
        ],
      },
      log,
      1,
    ),
    spawn: () => {
      throw new Error("not spawned in replay");
    },
  });
}

function codex(): RuntimeAdapter {
  const root = tmp();
  return new CodexAdapter({
    connection: () => ({
      id: "c1",
      dir: path.join(root, "conn"),
      auth: { kind: "api_key", apiKey: "sk-proj-TESTKEY" + "x".repeat(30) },
    }),
    spawn: replaySpawn(
      {
        [PROMPT]: {
          threadId: cx.threadId,
          turnId: cx.turnId,
          messages: [
            liveCall(CALL.id, CALL.tool, CALL.args) as unknown as Record<string, unknown>,
            cx.delta(ANSWER),
            cx.usage(cx.tokens(10, 0, 2), cx.tokens(10, 0, 2)),
            cx.completed("completed"),
          ],
        },
      },
      newLog(),
      { delayMs: 1 },
    ),
    bundledCatalog: async () => ({
      models: CODEX_MODELS.map((m) => ({ slug: m.id, tool_mode: "code_mode_only", base_instructions: "x" })),
    }),
    executable: "/nonexistent/codex",
  });
}

describe('"AAPL, 005930 6개월 비교 차트" — M4 completion criterion (#31)', () => {
  it("Claude Code and Codex: a table and a chart artifact with sources and as-of, the table part, the note", async () => {
    const runtimes = new RuntimeRegistry();
    runtimes.register(unwired(claude()));
    runtimes.register(unwired(codex()));
    const { app, f, send } = await start(runtimes);
    for (const rt of ["claude-code", "codex"]) {
      const c = app.conversations!.create(f.users.owner.id);
      const r = await send(f.cookies.owner, c.id, PROMPT, rt);
      expect(r.run.runtime).toBe(rt);
      checkAnswer(app, r, rt);
      expect(r.note!.missing, rt).toEqual([]);
    }
  });

  it("FakeRuntime: the plain request makes the same artifacts (as the e2e does)", async () => {
    const runtimes = new RuntimeRegistry();
    runtimes.register(new FakeRuntime({ runTools: true }));
    const { app, f, send } = await start(runtimes);
    const c = app.conversations!.create(f.users.owner.id);
    const r = await send(f.cookies.owner, c.id, PROMPT);
    const { table, chart } = checkAnswer(app, r, "fake");
    // The artifacts belong to this conversation and answer; the owner opens them, the admin does not.
    expect(table.conversationId).toBe(c.id);
    for (const [who, status] of [
      ["owner", 200],
      ["admin", 403],
      ["stranger", 403],
    ] as const) {
      const res = await app.inject({
        url: `/a/${chart.id}/v/1/raw`,
        headers: { host: "localhost:3000", cookie: f.cookies[who] },
      });
      expect(res.statusCode, who).toBe(status);
      if (status === 200) {
        expect(res.body).toContain('<label for="cv1">달러 기준</label>');
        // No script but the Escape bridge of the app's frame (#28): the switches are CSS.
        expect(res.body.match(/<script/g)).toHaveLength(1);
      }
    }
    // The table's CSV download.
    const csv = await app.inject({
      url: `/a/${table.id}/v/1/download`,
      headers: { host: "localhost:3000", cookie: f.cookies.owner },
    });
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.body.split("\r\n")[0]).toContain("출처,기준 시각");
  });
});

// ---- who may use them ---------------------------------------------------------------------------------------

describe("the finance chart tool follows the finance skills (#31, #30, #35)", () => {
  const COMPOSED = ["finance_chart"];
  const composed = (names: string[]) => names.filter((n) => COMPOSED.includes(n));

  it("the son (youth, finance hidden) gets neither tool: not listed, refused when called", async () => {
    const { app, f } = await start(new RuntimeRegistry());
    const son = app.users!.create({
      email: "son@example.com",
      name: "아들",
      role: "member",
      passwordHash: "x",
      youth: true,
    });
    expect(composed(app.mcp!.toolNamesFor(f.users.owner.id))).toEqual(COMPOSED);
    expect(composed(app.mcp!.toolNamesFor(son.id))).toEqual([]);
    const { url } = await app.mcp!.endpoint();
    const c = app.conversations!.create(son.id);
    const token = app.runs!.mcpTokens.issue({
      userId: son.id,
      conversationId: c.id,
      runId: crypto.randomUUID(),
    });
    expect((await callOurTool(url, token, "finance_chart", CALL.args)).isError).toBe(true);
    expect(app.artifacts!.list(c.id)).toEqual([]);
    // A call already past the listing (the permission changed between the tool list and the call) is refused by
    // the call itself.
    const host = (
      app.mcp! as unknown as { host(): { runTool(n: string, i: unknown, s: unknown): Promise<unknown> } }
    ).host();
    const scope = { userId: son.id, conversationId: c.id, runId: crypto.randomUUID() };
    expect(await host.runTool("finance_chart", CALL.args, scope)).toEqual({
      ok: false,
      code: "finance_not_allowed",
    });
  });

  it("the server allow-list off for both stock skills hides them for everyone (#35)", async () => {
    const { app, f } = await start(new RuntimeRegistry());
    app.mcp!.setServerEnabled("kr-stock-skill", false);
    app.mcp!.setServerEnabled("us-stock-skill", false);
    expect(composed(app.mcp!.toolNamesFor(f.users.owner.id))).toEqual([]);
    app.mcp!.setServerEnabled("us-stock-skill", true);
    expect(composed(app.mcp!.toolNamesFor(f.users.owner.id))).toEqual(COMPOSED);
  });

  it("kr-stock-skill only: KR charts work, a US symbol is refused", async () => {
    const { app } = await start(new RuntimeRegistry());
    const son = app.users!.create({
      email: "son2@example.com",
      name: "아들",
      role: "member",
      passwordHash: "x",
      youth: true,
    });
    app.users!.setSkills(son.id, ["kr-stock-skill"]);
    expect(composed(app.mcp!.toolNamesFor(son.id))).toEqual(COMPOSED);
    const { url } = await app.mcp!.endpoint();
    const c = app.conversations!.create(son.id);
    const token = app.runs!.mcpTokens.issue({
      userId: son.id,
      conversationId: c.id,
      runId: crypto.randomUUID(),
    });
    expect((await callOurTool(url, token, "finance_chart", CALL.args)).isError).toBe(true);
    const kr = await callOurTool(url, token, "finance_chart", { symbols: ["005930"], range: "1mo" });
    expect(kr.isError).toBe(false);
  });
});

// ---- review #111 -------------------------------------------------------------------------------------------

/**
 * A database file (WAL), so the raw bytes on disk can be looked at. `bytes()` reads the database, WAL and SHM files
 * as they are — no checkpoint or clean-up of its own (review #111 round 2): what the server leaves is what is seen.
 */
function fileDb() {
  const file = path.join(tmp(), "agentlee.db");
  const db = openDb(file);
  runMigrations(db);
  const files = () => [file, `${file}-wal`, `${file}-shm`];
  const bytes = () => files().flatMap((f) => (fs.existsSync(f) ? [fs.readFileSync(f)] : []));
  const has = (v: string) => bytes().some((b) => b.includes(Buffer.from(v)));
  const inWal = (v: string) =>
    fs.existsSync(`${file}-wal`) && fs.readFileSync(`${file}-wal`).includes(Buffer.from(v));
  const inDb = (v: string) => fs.readFileSync(file).includes(Buffer.from(v));
  return { db, file, bytes, has, inWal, inDb };
}

describe("the rescrub leaves no old value in the files (review #111 round 2, #78)", () => {
  const synthetic = (p: string) => `${p}${crypto.randomUUID().replace(/-/g, "").slice(0, 12).toUpperCase()}`;
  type Setup = Awaited<ReturnType<typeof setup>>;
  async function setup() {
    const f = fileDb();
    const s = await start(new RuntimeRegistry(), { db: f.db });
    await s.app.storedRescrub!.idle();
    return { ...f, ...s };
  }
  /** An ordinary masked column (#78): a conversation title. */
  const titleRow = (t: Setup, late: string) => {
    const c = t.app.conversations!.create(t.f.users.owner.id);
    t.app.conversations!.rename(c.id, `메모 ${late} 끝`);
    return c.id;
  };

  for (const where of ["wal", "db"] as const)
    it(`masked title: old value in the ${where === "wal" ? "WAL (not checkpointed yet)" : "database page (checkpointed)"} → clean files right after idle()`, async () => {
      const t = await setup();
      const late = synthetic("LATE");
      const id = titleRow(t, late);
      if (where === "db") t.db.$client.pragma("wal_checkpoint(TRUNCATE)");
      // The residue really is where this case says (the control: otherwise the case proves nothing).
      expect(where === "wal" ? t.inWal(late) : t.inDb(late) && !t.inWal(late)).toBe(true);
      knownSecrets.add(late);
      try {
        await t.app.storedRescrub!.idle();
        expect(t.has(late)).toBe(false);
        expect(t.app.conversations!.get(id)!.title).not.toContain(late);
      } finally {
        knownSecrets.remove(late);
      }
    });

  it("a reader on an old snapshot blocks the checkpoint: no wait, retried, idle() only once the files are clean", async () => {
    const t = await setup();
    const late = synthetic("LATE");
    titleRow(t, late);
    const reader = new Database(t.file, { timeout: 0 });
    reader.exec("BEGIN");
    reader.prepare("select count(*) from conversations").get();
    const t0 = Date.now();
    knownSecrets.add(late);
    try {
      let done = false;
      const idle = t.app.storedRescrub!.idle().then(() => (done = true));
      for (let i = 0; i < 300 && t.app.storedRescrub!.failed() === 0; i++)
        await new Promise((r) => setTimeout(r, 10));
      expect(t.app.storedRescrub!.failed()).toBeGreaterThan(0); // the checkpoint was busy
      // …and found so at once: the checkpoint never waits for the reader (busy wait 0, not the 5 s busy_timeout).
      expect(Date.now() - t0).toBeLessThan(2500);
      expect(done).toBe(false);
      expect(t.inWal(late)).toBe(true); // the old frame is still there while the reader holds it
      reader.exec("COMMIT");
      reader.close();
      await idle;
      expect(t.has(late)).toBe(false);
    } finally {
      if (reader.open) reader.close();
      knownSecrets.remove(late);
    }
  });
});

describe("the finance table part follows this run's versions only (review #111)", () => {
  const CHART = { symbols: ["AAPL", "005930"], range: "1mo" };
  const NEW_TABLE = {
    columns: ["종목", "종가", "출처", "기준 시각"],
    rows: [["AAPL", 222, "Yahoo Finance", "x"]],
  };
  const script: FakeScript = (input) =>
    input.text === "update"
      ? [
          // Another run changes the same artifact (id from the message).
          {
            call: "artifact_update",
            input: { artifactId: "$x", table: { ...NEW_TABLE, rows: [["AAPL", 333, "Yahoo Finance", "x"]] } },
          },
          { text: "고쳤어요." },
        ]
      : [
          { call: "finance_chart", input: CHART },
          {
            call: "artifact_update",
            input: {
              artifactId: "$0.table.artifactId",
              table: { ...NEW_TABLE, rows: [["AAPL", 111, "Yahoo Finance", "x"]] },
            },
          },
          { call: "artifact_update", input: { artifactId: "$0.table.artifactId", table: NEW_TABLE } },
          { text: "표를 두 번 고쳤어요." },
        ];

  it("updates later in the same run replace the part (v3), streamed as part_update; another run's update does not", async () => {
    const runtimes = new RuntimeRegistry();
    let tableId = "";
    runtimes.register(
      new FakeRuntime({
        runTools: true,
        script: (input, memory) =>
          script(input, memory).map((st) =>
            "call" in st && st.input.artifactId === "$x"
              ? { ...st, input: { ...st.input, artifactId: tableId } }
              : st,
          ),
      }),
    );
    const { app, f, send } = await start(runtimes);
    const c = app.conversations!.create(f.users.owner.id);
    const r = await send(f.cookies.owner, c.id, "chart");
    expect(r.run.status).toBe("done");
    const tables = r.parts.filter((p) => p.type === "table");
    expect(tables).toHaveLength(1);
    const part = tables[0]!;
    if (part.type !== "table") throw new Error("no table");
    tableId = part.artifactId!;
    expect(part.artifactVersion).toBe(3);
    expect(part.rows).toEqual([{ c0: "AAPL", c1: 222, c2: "Yahoo Finance", c3: "x" }]);
    const card = r.parts.find((p) => p.type === "artifact_ref" && p.artifactId === tableId);
    expect(card).toMatchObject({ version: 3 });
    // Streamed: the part was sent for v1 and replaced for v2 and v3 at the same index.
    const updates = app
      .runs!.eventsAfter(r.run.id, -1)
      .map(
        (e) =>
          e.data as { type: string; partIndex?: number; part?: { type: string; artifactVersion?: number } },
      )
      .filter((e) => e.type === "part_update" && e.part?.type === "table");
    expect(updates.map((u) => u.part!.artifactVersion)).toEqual([1, 2, 3]);
    expect(new Set(updates.map((u) => u.partIndex)).size).toBe(1);

    // Another run updates the artifact to v4: this answer keeps v3.
    const before = JSON.stringify(app.conversations!.messageById(r.run.assistantMessageId)!.parts);
    const r2 = await send(f.cookies.owner, c.id, "update");
    expect(r2.run.status).toBe("done");
    expect(app.artifacts!.get(tableId)!.latestVersion).toBe(4);
    expect(JSON.stringify(app.conversations!.messageById(r.run.assistantMessageId)!.parts)).toBe(before);
    expect(r2.parts.some((p) => p.type === "table")).toBe(false);
  });
});

// ---- review #111 round 2: no known secret leaves through a finance request --------------------------------

describe("finance egress guard: no known secret in any outgoing request (review #111 round 2)", () => {
  const GATE = "GATEAB1234"; // synthetic, test-only TEMP_GATE_CODE
  /** Every job a worker was given; and whether any of it carries the secret in any encoding the matcher knows. */
  function capture() {
    const jobs: unknown[] = [];
    const fixture = fixtureFinanceWorker(() => SATURDAY);
    const worker = async (
      job: { op: "raw"; steps: { url: string }[] },
      proxy: { url: string; port: number },
    ) => {
      jobs.push(job);
      return fixture(job, proxy);
    };
    const leaked = () => {
      const t = JSON.stringify(jobs);
      return t.includes(GATE) || scrubKnown(t) !== t;
    };
    return { jobs, worker, leaked };
  }

  it("every finance tool: an input carrying the secret is refused before any job; the tool's own configured secret still goes", async () => {
    const own = "dart-synthetic-key-0123456789";
    knownSecrets.add(GATE);
    knownSecrets.add(own);
    try {
      const cap = capture();
      const svc = new FinanceService(cap.worker, async () => ({ url: "http://127.0.0.1:9", port: 9 }), {
        now: () => SATURDAY,
        secrets: { OPENDART_API_KEY: own },
      });
      const tool = (n: string) => FINANCE_TOOLS.find((t) => t.name === n)!;
      for (const [name, input] of [
        ["us_quote", { symbol: GATE }],
        ["us_history", { symbol: GATE, range: "1mo" }],
        ["kr_search", { query: GATE }],
        ["kr_search", { query: Buffer.from(GATE).toString("base64") }],
        ["us_company", { symbol: GATE }],
      ] as const) {
        expect(await svc.run(tool(name), input), name).toEqual({ ok: false, code: "finance_bad_input" });
      }
      // (SEC without a configured contact is refused even earlier, also without a job.)
      expect((await svc.run(tool("sec_8k"), { ticker: GATE })).ok).toBe(false);
      expect(cap.jobs).toEqual([]);
      // The OpenDART key is the tool's own: its job goes out (the fixture does not answer it).
      await svc.run(tool("dart_disclosures"), {});
      expect(cap.jobs).toHaveLength(1);
      expect(JSON.stringify(cap.jobs)).not.toContain(GATE);
      // And finance_chart with the secret as a symbol: nothing leaves either.
      cap.jobs.length = 0;
      const r = await fetchDataset(
        { symbols: [GATE, "005930"] },
        (n, i) => svc.run(tool(n), i),
        () => true,
        SATURDAY,
      );
      expect(r.ok).toBe(false);
      expect(cap.leaked()).toBe(false);
    } finally {
      knownSecrets.remove(GATE);
      knownSecrets.remove(own);
    }
  });
});

// ---- review #111 round 3 ----------------------------------------------------------------------------------

describe("a configured finance secret leaves only in its own place (review #111 round 3)", () => {
  // Synthetic, test-only values.
  const DART = "0123456789abcdef0123456789abcdef01234567";
  const DART_SHORT = "DARTAB1234"; // a short one that fits a ticker
  const UA = "review-test contact@example.invalid";

  it("the DART key as a kr_search query, as a us_history symbol, or in a SEC header slot is refused; the real calls go", async () => {
    for (const key of [DART, DART_SHORT]) {
      const jobs: { steps: { url: string; headers?: Record<string, string> }[] }[] = [];
      const svc = new FinanceService(
        async (job) => {
          jobs.push(job as never);
          return { ok: false, code: "web_unreachable" };
        },
        async () => ({ url: "http://127.0.0.1:9", port: 9 }),
        { now: () => SATURDAY, secrets: { OPENDART_API_KEY: key, SEC_USER_AGENT: UA } },
      );
      const tool = (n: string) => FINANCE_TOOLS.find((t) => t.name === n)!;
      expect(await svc.run(tool("kr_search"), { query: key })).toEqual({
        ok: false,
        code: "finance_bad_input",
      });
      expect(await svc.run(tool("kr_search"), { query: `find ${key}` })).toEqual({
        ok: false,
        code: "finance_bad_input",
      });
      if (key === DART_SHORT)
        expect(await svc.run(tool("us_history"), { symbol: key, range: "1mo" })).toEqual({
          ok: false,
          code: "finance_bad_input",
        });
      expect(await svc.run(tool("kr_search"), { query: UA.slice(0, 30) })).toMatchObject({ ok: false });
      expect(jobs).toEqual([]);
      // The real calls: the DART key as its crtfc_key, the SEC contact as its User-Agent.
      await svc.run(tool("dart_disclosures"), {});
      await svc.run(tool("sec_8k"), { cik: "320193" });
      expect(jobs).toHaveLength(2);
      expect(jobs[0]!.steps[0]!.url).toContain(`crtfc_key=${encodeURIComponent(key)}`);
      expect(jobs[1]!.steps.some((x) => x.headers?.["user-agent"] === UA)).toBe(true);
    }
  });

  it("each configured secret is allowed in exactly one place: tool, host and field", () => {
    const config = { OPENDART_API_KEY: DART, SEC_USER_AGENT: UA };
    const dartUrl = `https://opendart.fss.or.kr/api/list.json?crtfc_key=${DART}&page_no=1`;
    const sec = "https://data.sec.gov/submissions/CIK0000320193.json";
    expect(carriesKnownSecret({ url: dartUrl }, "dart_disclosures", config)).toBe(false);
    expect(carriesKnownSecret({ url: dartUrl }, "kr_search", config)).toBe(true); // another tool
    expect(
      carriesKnownSecret(
        { url: `https://opendart.fss.or.kr/api/list.json?corp_code=${DART}` },
        "dart_disclosures",
        config,
      ),
    ).toBe(true); // another parameter
    expect(
      carriesKnownSecret(
        { url: `https://ac.stock.naver.com/ac?crtfc_key=${DART}` },
        "dart_disclosures",
        config,
      ),
    ).toBe(true); // another host
    expect(carriesKnownSecret({ url: sec, headers: { "user-agent": UA } }, "sec_8k", config)).toBe(false);
    expect(carriesKnownSecret({ url: sec, headers: { "user-agent": DART } }, "sec_8k", config)).toBe(true); // DART key in the SEC slot
    expect(carriesKnownSecret({ url: sec, headers: { accept: UA } }, "sec_8k", config)).toBe(true); // another header
    expect(
      carriesKnownSecret(
        { url: "https://query1.finance.yahoo.com/x", headers: { "user-agent": UA } },
        "sec_8k",
        config,
      ),
    ).toBe(true); // another host
    expect(carriesKnownSecret({ url: sec, headers: { "user-agent": UA } }, "us_quote", config)).toBe(true); // another tool
    expect(carriesKnownSecret({ url: `${sec}?q=${encodeURIComponent(UA)}` }, "sec_8k", config)).toBe(true); // in the URL
  });
});

describe("old free space and an interrupted clean-up (review #111 round 3)", () => {
  const synthetic = (p: string) => `${p}${crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
  /** A database file written by the previous release: secure_delete OFF, a long title shortened (old bytes left). */
  function legacyDb(late: string, title: string) {
    const file = path.join(tmp(), "agentlee.db");
    const db = openDb(file);
    runMigrations(db);
    db.$client.pragma("secure_delete = OFF");
    db.$client
      .prepare(
        "insert into users (id, email, name, role) values ('u', 'u@example.invalid', 'review', 'member')",
      )
      .run();
    db.$client
      .prepare("insert into conversations (id, owner_id, title) values ('c', 'u', ?)")
      .run(late.repeat(6));
    db.$client.pragma("wal_checkpoint(TRUNCATE)");
    db.$client.prepare("update conversations set title = ? where id = 'c'").run(title);
    db.$client.pragma("wal_checkpoint(TRUNCATE)");
    db.$client.close();
    const has = () =>
      [file, `${file}-wal`, `${file}-shm`].some(
        (f) => fs.existsSync(f) && fs.readFileSync(f).includes(Buffer.from(late)),
      );
    return { file, has };
  }

  for (const kind of ["already masked", "still in the row"] as const)
    it(`a database from before secure_delete (old title ${kind}): clean after start-up and the rescrub`, async () => {
      const late = synthetic("LEGACY");
      const { file, has } = legacyDb(late, kind === "already masked" ? "이미 가림" : `짧게 ${late}`);
      expect(has()).toBe(true); // control: the old bytes are in the file's free space
      const db = openDb(file);
      const { app } = await start(new RuntimeRegistry(), { db });
      knownSecrets.add(late);
      try {
        await app.storedRescrub!.idle();
        expect(has()).toBe(false); // read as they are: no checkpoint or clean-up of the test's own
        expect(
          (db.$client.prepare("select title from conversations where id = 'c'").get() as { title: string })
            .title,
        ).not.toContain(late);
        expect(db.$client.prepare("select value from settings where key = ?").get(COMPACTED_KEY)).toEqual({
          value: "1",
        });
      } finally {
        knownSecrets.remove(late);
      }
    });

  it("the compaction runs once per database", () => {
    const file = path.join(tmp(), "agentlee.db");
    const db = openDb(file);
    runMigrations(db);
    expect(compactOnce(db)).toBe("done");
    expect(compactOnce(db)).toBe("skipped");
    expect(db.$client.pragma("auto_vacuum", { simple: true })).toBe(2);
    db.$client.close();
  });

  it("a blocked checkpoint survives a restart: resumed from the persisted marker, idle() waits until the files are clean", async () => {
    const file = path.join(tmp(), "agentlee.db");
    let db = openDb(file);
    runMigrations(db);
    const late = synthetic("RESTART");
    db.$client
      .prepare(
        "insert into users (id, email, name, role) values ('u', 'u@example.invalid', 'review', 'member')",
      )
      .run();
    db.$client.prepare("insert into conversations (id, owner_id, title) values ('c', 'u', ?)").run(late);
    db.$client.pragma("wal_checkpoint(TRUNCATE)");
    const reader = new Database(file, { timeout: 0 });
    reader.exec("BEGIN");
    reader.prepare("select * from conversations").get();
    const has = () =>
      [file, `${file}-wal`, `${file}-shm`].some(
        (f) => fs.existsSync(f) && fs.readFileSync(f).includes(Buffer.from(late)),
      );
    const reg = new KnownSecrets();
    try {
      let scrub = new StoredRescrub(db, { registry: reg, delayMs: 1, retryMs: 20, maxRetryMs: 40 });
      reg.add(late);
      for (let i = 0; i < 200 && scrub.failed() === 0; i++) await new Promise((r) => setTimeout(r, 5));
      expect(scrub.failed()).toBeGreaterThan(0);
      expect(
        db.$client.prepare("select 1 as x from settings where key = ?").get(CLEANUP_PENDING_KEY),
      ).toEqual({ x: 1 });
      scrub.close();
      await scrub.idle();
      db.$client.close();
      // Restart: the rows are clean, nothing is pending to look for — the marker alone resumes the clean-up.
      db = openDb(file);
      scrub = new StoredRescrub(db, { registry: reg, delayMs: 1, retryMs: 20, maxRetryMs: 40 });
      let done = false;
      const idle = scrub.idle().then(() => (done = true));
      await new Promise((r) => setTimeout(r, 200));
      expect(done).toBe(false);
      expect(has()).toBe(true); // still in the WAL while the reader holds it
      reader.exec("ROLLBACK");
      reader.close();
      await idle;
      expect(has()).toBe(false);
      expect(
        db.$client.prepare("select 1 from settings where key = ?").get(CLEANUP_PENDING_KEY),
      ).toBeUndefined();
      scrub.close();
    } finally {
      if (reader.open) reader.close();
      db.$client.close();
    }
  });
});

// ---- review #111 round 4 ----------------------------------------------------------------------------------

describe("the one-time compaction is done only when the file is clean (review #111 round 4)", () => {
  const synthetic = (p: string) => `${p}${crypto.randomUUID().replace(/-/g, "").slice(0, 10).toUpperCase()}`;
  /** A database from before secure_delete with old bytes in free space (Codex's repro), and a reader on it. */
  function legacy() {
    const file = path.join(tmp(), "agentlee.db");
    const late = synthetic("R4LEGACY");
    const db = openDb(file);
    runMigrations(db);
    db.$client.pragma("secure_delete = OFF");
    db.$client
      .prepare(
        "insert into users (id, email, name, role) values ('u', 'u@example.invalid', 'review', 'member')",
      )
      .run();
    db.$client
      .prepare("insert into conversations (id, owner_id, title) values ('c', 'u', ?)")
      .run(late.repeat(6));
    db.$client.pragma("wal_checkpoint(TRUNCATE)");
    db.$client.prepare("update conversations set title = 'already masked' where id = 'c'").run();
    db.$client.pragma("wal_checkpoint(TRUNCATE)");
    const has = () =>
      [file, `${file}-wal`, `${file}-shm`].some(
        (f) => fs.existsSync(f) && fs.readFileSync(f).includes(Buffer.from(late)),
      );
    const key = (k: string) =>
      (db.$client.prepare("select value from settings where key = ?").get(k) as { value: string } | undefined)
        ?.value;
    return { file, db, late, has, key };
  }
  const holdReader = (file: string) => {
    const reader = new Database(file, { timeout: 0 });
    reader.exec("BEGIN");
    reader.prepare("select * from conversations").get();
    return reader;
  };

  it("a reader during the first compaction: pending, idle() waits, released → clean, both markers settled", async () => {
    const l = legacy();
    expect(l.has()).toBe(true);
    const reader = holdReader(l.file);
    try {
      const { app } = await start(new RuntimeRegistry(), { db: l.db });
      expect(l.key(COMPACTED_KEY)).toBe("vacuumed");
      expect(l.key(CLEANUP_PENDING_KEY)).toBe("1");
      let done = false;
      const idle = app.storedRescrub!.idle().then(() => (done = true));
      await new Promise((r) => setTimeout(r, 250));
      expect(done).toBe(false);
      expect(l.has()).toBe(true); // the old page is still the file's until the checkpoint
      reader.exec("ROLLBACK");
      reader.close();
      await idle;
      expect(l.has()).toBe(false);
      expect(l.key(COMPACTED_KEY)).toBe("1");
      expect(l.key(CLEANUP_PENDING_KEY)).toBeUndefined();
    } finally {
      if (reader.open) reader.close();
    }
  });

  it("a restart while it is still blocked: the compaction is not skipped, and finishes once the reader goes", async () => {
    const l = legacy();
    const reader = holdReader(l.file);
    try {
      const masterKey = crypto.randomBytes(32); // the same server key across the restart
      const first = await start(new RuntimeRegistry(), { db: l.db, masterKey });
      expect(l.key(COMPACTED_KEY)).toBe("vacuumed");
      await first.app.close(); // shuts down with the clean-up unfinished
      l.db.$client.close();
      const db2 = openDb(l.file);
      closers.push(() => db2.$client.close()); // after the app below (closers run last first)
      const key = (k: string) =>
        (
          db2.$client.prepare("select value from settings where key = ?").get(k) as
            { value: string } | undefined
        )?.value;
      expect(key(COMPACTED_KEY)).toBe("vacuumed");
      // The same server again (its family already exists in the database).
      const secondApp = await buildApp(loadConfig({ NODE_ENV: "test" }), {
        db: db2,
        logger: false,
        runtimes: new RuntimeRegistry(),
        masterKey,
      });
      closers.push(() => secondApp.close());
      const second = { app: secondApp };
      let done = false;
      const idle = second.app.storedRescrub!.idle().then(() => (done = true));
      await new Promise((r) => setTimeout(r, 250));
      expect(done).toBe(false);
      expect(l.has()).toBe(true);
      reader.exec("ROLLBACK");
      reader.close();
      await idle;
      expect(l.has()).toBe(false);
      expect(key(COMPACTED_KEY)).toBe("1");
      expect(key(CLEANUP_PENDING_KEY)).toBeUndefined();
    } finally {
      if (reader.open) reader.close();
    }
  });

  it("a process killed during the VACUUM (state needed, rewrite rolled back): the next start compacts again", async () => {
    const l = legacy();
    // As left by a kill mid-VACUUM: the markers were committed before it, the rewrite itself never was.
    l.db.$client
      .prepare("insert into settings (key, value) values (?, 'needed'), (?, '1')")
      .run(COMPACTED_KEY, CLEANUP_PENDING_KEY);
    expect(l.has()).toBe(true);
    const { app } = await start(new RuntimeRegistry(), { db: l.db });
    await app.storedRescrub!.idle();
    expect(l.has()).toBe(false);
    expect(l.key(COMPACTED_KEY)).toBe("1");
    expect(l.key(CLEANUP_PENDING_KEY)).toBeUndefined();
  });

  /** VACUUM made to fail as with a full disk until `lift()` (Codex's capacity repro uses the page limit below too). */
  function full(db: Db) {
    const exec = db.$client.exec.bind(db.$client);
    let attempts = 0;
    db.$client.exec = ((text: string) => {
      if (text.trim().toUpperCase() === "VACUUM") {
        attempts++;
        throw new Database.SqliteError("database or disk is full", "SQLITE_FULL");
      }
      return exec(text);
    }) as typeof db.$client.exec;
    return {
      attempts: () => attempts,
      lift: () => {
        db.$client.exec = ((text: string) => {
          if (text.trim().toUpperCase() === "VACUUM") attempts++;
          return exec(text);
        }) as typeof db.$client.exec;
      },
    };
  }
  const fast = { compactRetryMs: 40, maxCompactRetryMs: 160 };

  it("no room for the VACUUM: the server starts, stays `needed`, retries with backoff while running, idle() waits; room again → clean, `1`", async () => {
    const l = legacy();
    const disk = full(l.db);
    const logs: string[] = [];
    const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
      db: l.db,
      runtimes: new RuntimeRegistry(),
      rescrub: fast,
      logStream: { write: (c: string) => void logs.push(String(c)) } as never,
    });
    closers.push(() => app.close());
    expect((await app.inject({ url: "/api/health", headers: { host: "localhost:3000" } })).statusCode).toBe(
      200,
    );
    expect(l.key(COMPACTED_KEY)).toBe("needed");
    let done = false;
    const idle = app.storedRescrub!.idle().then(() => (done = true));
    await new Promise((r) => setTimeout(r, 400));
    expect(done).toBe(false); // still needed: idle() waits
    expect(l.has()).toBe(true);
    // Retried in the running server, with backoff (40, 80, 160, 160… ms): a handful, not a flood — one log line each.
    const failures = logs.filter((x) => (JSON.parse(x) as { msg: string }).msg === "storage.compact_failed");
    expect(disk.attempts()).toBeGreaterThanOrEqual(3);
    expect(disk.attempts()).toBeLessThanOrEqual(6);
    expect(failures).toHaveLength(disk.attempts());
    for (const f of failures) {
      expect(JSON.parse(f)).toMatchObject({ err: { type: "SqliteError" } });
      expect(f).not.toContain("disk is full"); // the class only, never the message
    }
    disk.lift(); // space freed while the server runs
    await idle;
    expect(l.has()).toBe(false);
    expect(l.key(COMPACTED_KEY)).toBe("1");
    expect(l.key(CLEANUP_PENDING_KEY)).toBeUndefined();
  });

  it("a real SQLITE_FULL (page limit) at start-up: the server starts, and the in-process retry compacts once the limit is lifted", async () => {
    const l = legacy();
    // No free pages left for a write to reuse (a migration that rebuilds a table, 0031, leaves some behind).
    l.db.$client.exec("VACUUM");
    const pages = l.db.$client.pragma("page_count", { simple: true }) as number;
    l.db.$client.pragma(`max_page_count = ${pages}`);
    const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
      db: l.db,
      logger: false,
      runtimes: new RuntimeRegistry(),
      rescrub: fast,
    });
    closers.push(() => app.close());
    expect(l.key(COMPACTED_KEY)).toBe("needed");
    expect(l.has()).toBe(true);
    l.db.$client.pragma("max_page_count = 1073741823");
    await app.storedRescrub!.idle();
    expect(l.has()).toBe(false);
    expect(l.key(COMPACTED_KEY)).toBe("1");
    expect(l.db.$client.pragma("integrity_check", { simple: true })).toBe("ok");
  });

  it("a checkpoint that succeeds while the VACUUM is still needed does not mark the compaction done", async () => {
    const l = legacy();
    const disk = full(l.db);
    const reg = new KnownSecrets();
    // As after a failed start-up attempt (`needed`), and something else needs a checkpoint (a masked row): the
    // checkpoint runs first and succeeds — no reader — before the VACUUM's retry is due.
    l.db.$client
      .prepare("insert into settings (key, value) values (?, 'needed'), (?, '1')")
      .run(COMPACTED_KEY, CLEANUP_PENDING_KEY);
    const scrub = new StoredRescrub(l.db, {
      registry: reg,
      delayMs: 1,
      compactRetryMs: 400,
      maxCompactRetryMs: 400,
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(disk.attempts()).toBe(0);
    expect(l.key(CLEANUP_PENDING_KEY)).toBeUndefined(); // the checkpoint did succeed
    expect(l.key(COMPACTED_KEY)).toBe("needed"); // …and that alone finished nothing
    expect(l.has()).toBe(true);
    await new Promise((r) => setTimeout(r, 400));
    expect(disk.attempts()).toBeGreaterThanOrEqual(1); // the VACUUM was retried (and failed again)
    expect(l.key(COMPACTED_KEY)).toBe("needed");
    disk.lift();
    await scrub.idle();
    expect(l.key(COMPACTED_KEY)).toBe("1");
    expect(l.has()).toBe(false);
    scrub.close();
  });
});

describe("a fragment of a configured secret never leaves in a search query (review #111 round 4)", () => {
  const KEY = "0123456789abcdefFEDCBA987654321001234567"; // synthetic DART key
  it("whole key, mid, prefix and encoded fragments as a kr_search query are refused before any job; same-shape ordinary queries go", async () => {
    const jobs: { steps: { url: string }[] }[] = [];
    const svc = new FinanceService(
      async (job) => {
        jobs.push(job as never);
        return {
          ok: true,
          responses: job.steps.map(() => ({
            status: 200,
            body: '{"items":[]}',
            contentType: "application/json",
          })),
        };
      },
      async () => ({ url: "http://127.0.0.1:9", port: 9 }),
      { now: () => SATURDAY, secrets: { OPENDART_API_KEY: KEY } },
    );
    const search = FINANCE_TOOLS.find((t) => t.name === "kr_search")!;
    const same = (x: string) => x.replace(/[0-9A-Za-z+/=]/g, "Q");
    const fragments = [
      KEY,
      `find ${KEY.slice(8, 24)} suffix`,
      KEY.slice(0, 16),
      Buffer.from(KEY.slice(0, 24)).toString("base64"), // an encoded fragment within the 40-character cap
    ];
    for (const q of fragments) {
      expect(z.strictObject(search.input).safeParse({ query: q }).success, q).toBe(true);
      const fragment = q.startsWith("find ") ? q.slice(5, -7) : q;
      const before = jobs.length;
      expect(await svc.run(search, { query: q }), q).toEqual({ ok: false, code: "finance_bad_input" });
      expect(jobs.length, q).toBe(before);
      expect((await svc.run(search, { query: q.replace(fragment, same(fragment)) })).ok, q).toBe(true);
      expect(jobs.length, q).toBe(before + 1);
    }
    const sent = decodeURIComponent(jobs.flatMap((j) => j.steps.map((x) => x.url)).join(" "));
    for (let i = 0; i + 16 <= KEY.length; i++) expect(sent).not.toContain(KEY.slice(i, i + 16));
    expect(sent).not.toContain(Buffer.from(KEY).toString("base64").slice(0, 40));
  });
});

// ---- review #111 round 5 ----------------------------------------------------------------------------------

describe("configured-secret windows are found in decoded views too (review #111 round 5)", () => {
  const KEY = "0123456789abcdefFEDCBA987654321001234567"; // synthetic 40-character DART key
  const halves = [KEY.slice(0, 20), KEY.slice(20)];
  const other = ["QRSTUVWXYZqrstuvwxyz", "zyxwvutsrqZYXWVUTSRQ"]; // same length, never the key
  const encodings: Record<string, (x: string) => string> = {
    base64: (x) => Buffer.from(x).toString("base64"),
    base64url: (x) => Buffer.from(x).toString("base64url"),
    hex: (x) => Buffer.from(x).toString("hex"),
    "percent-encoded base64": (x) => encodeURIComponent(Buffer.from(x).toString("base64") + "="),
  };

  it("each encoded half as a kr_search query is refused before any job, a same-shape ordinary one goes, and no join of the sent queries rebuilds a window", async () => {
    const jobs: { steps: { url: string }[] }[] = [];
    const svc = new FinanceService(
      async (job) => {
        jobs.push(job as never);
        return {
          ok: true,
          responses: job.steps.map(() => ({
            status: 200,
            body: '{"items":[]}',
            contentType: "application/json",
          })),
        };
      },
      async () => ({ url: "http://127.0.0.1:9", port: 9 }),
      { now: () => SATURDAY, secrets: { OPENDART_API_KEY: KEY } },
    );
    const search = FINANCE_TOOLS.find((t) => t.name === "kr_search")!;
    for (const [name, enc] of Object.entries(encodings))
      for (const [i, half] of halves.entries()) {
        const q = enc(half);
        const ordinary = enc(other[i]!);
        expect(q.length, name).toBe(ordinary.length);
        expect(z.strictObject(search.input).safeParse({ query: q }).success, `${name} is a valid input`).toBe(
          true,
        );
        const before = jobs.length;
        expect(await svc.run(search, { query: q }), `${name} ${i}`).toEqual({
          ok: false,
          code: "finance_bad_input",
        });
        expect(jobs.length, `${name} ${i}`).toBe(before);
        expect((await svc.run(search, { query: ordinary })).ok, `${name} ${i} ordinary`).toBe(true);
        expect(jobs.length, `${name} ${i} ordinary`).toBe(before + 1);
      }
    // Every sent query, decoded every way we know, joined: never a 16-character window of the key.
    const queries = jobs.flatMap((j) => j.steps.map((x) => new URL(x.url).searchParams.get("q") ?? ""));
    const decoded = queries.flatMap((q) => decodedViews(q));
    for (const joined of [queries.join(""), decoded.join(""), ...decoded])
      for (let i = 0; i + 16 <= KEY.length; i++) expect(joined).not.toContain(KEY.slice(i, i + 16));
  });

  it("the real DART and SEC calls still go out", async () => {
    const UA = "review-test contact@example.invalid";
    const jobs: { steps: { url: string; headers?: Record<string, string> }[] }[] = [];
    const svc = new FinanceService(
      async (job) => {
        jobs.push(job as never);
        return { ok: false, code: "web_unreachable" };
      },
      async () => ({ url: "http://127.0.0.1:9", port: 9 }),
      { now: () => SATURDAY, secrets: { OPENDART_API_KEY: KEY, SEC_USER_AGENT: UA } },
    );
    const tool = (n: string) => FINANCE_TOOLS.find((t) => t.name === n)!;
    await svc.run(tool("dart_disclosures"), {});
    await svc.run(tool("sec_8k"), { cik: "320193" });
    expect(jobs).toHaveLength(2);
    // A half, encoded, in another tool: refused before any job.
    expect(await svc.run(tool("kr_search"), { query: Buffer.from(halves[0]!).toString("base64") })).toEqual({
      ok: false,
      code: "finance_bad_input",
    });
    expect(jobs).toHaveLength(2);
  });
});

// ---- review #111 round 6 ----------------------------------------------------------------------------------

describe("settling the clean-up markers can fail too (review #111 round 6)", () => {
  it("a write failure while settling: no unhandled rejection, stays pending, idle() waits, retried until clean and `1`", async () => {
    const db = createTestDb();
    const sql = db.$client;
    setKey(sql, COMPACTED_KEY, "vacuumed");
    setKey(sql, CLEANUP_PENDING_KEY, "1");
    // Codex's injection: the marker update refuses with SQLITE_FULL — here until the fault is cleared.
    const prepare = sql.prepare.bind(sql);
    let failures = 0;
    let faulty = true;
    sql.prepare = ((text: string) => {
      const stmt = prepare(text);
      if (faulty && text.startsWith("update settings set value = '1'"))
        stmt.run = () => {
          failures++;
          throw new Database.SqliteError("synthetic write capacity failure", "SQLITE_FULL");
        };
      return stmt;
    }) as typeof sql.prepare;
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => void unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    const logs: string[] = [];
    const scrub = new StoredRescrub(db, {
      registry: new KnownSecrets(),
      delayMs: 1,
      retryMs: 10,
      maxRetryMs: 20,
      log: {
        warn: (o: Record<string, unknown>, msg: string) => void logs.push(msg),
        info: () => {},
      } as never,
    });
    try {
      let done = false;
      const idle = scrub.idle().then(() => (done = true));
      await new Promise((r) => setTimeout(r, 150));
      expect(failures).toBeGreaterThanOrEqual(2); // retried with backoff
      expect(done).toBe(false); // idle() waits while the markers are not settled
      expect(readKey(sql, COMPACTED_KEY)).toBe("vacuumed");
      expect(readKey(sql, CLEANUP_PENDING_KEY)).toBe("1");
      expect(logs.filter((m) => m === "secrets.rescrub_cleanup_failed")).toHaveLength(failures);
      faulty = false; // the fault is cleared
      await idle;
      expect(readKey(sql, COMPACTED_KEY)).toBe("1");
      expect(readKey(sql, CLEANUP_PENDING_KEY)).toBeUndefined();
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      scrub.close();
      sql.prepare = prepare;
    }
  });
});
