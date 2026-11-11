import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  CSRF_HEADER,
  FINANCE_DISCLAIMER,
  type FinanceNotePart,
  type MessagePart,
  type Run,
  type StreamEvent,
} from "@agentlee/shared";
import { SELFTEST_SKILL } from "@agentlee/mcp-tools/skills";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { RuntimeRegistry, type RuntimeAdapter } from "../src/runtime/adapter.js";
import { ClaudeAdapter } from "../src/runtime/claude.js";
import { CODEX_MODELS, CodexAdapter } from "../src/runtime/codex.js";
import { FakeRuntime, type FakeScript, defaultScript } from "../src/runtime/fake.js";
import { RunManager } from "../src/runtime/runs.js";
import { replayQuery, sdk, type ReplayLog } from "./helpers/claude-replay.js";
import { cx, newLog, replaySpawn } from "./helpers/codex-replay.js";
import { loadFixtures, replayWorker } from "./helpers/finance-replay.js";
import { liveCall } from "./helpers/live-mcp.js";
import { createFamily } from "./helpers/permission-matrix.js";

/**
 * The common finance output check under the run manager (#30): every answer that used a finance tool — any
 * user, follow-ups, scheduled runs, either runtime — ends with the server's note (sources, as-of, what the answer
 * left out, the disclaimer). Completion criterion: "AAPL, 005930 현재가" in both runtimes → 출처·기준 시각·면책.
 */

type App = Awaited<ReturnType<typeof buildApp>>;
const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "finance-runs-"));
  closers.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

const SATURDAY = Date.parse("2026-11-14T10:00:00+09:00");
const exchanges = loadFixtures()
  .filter((f) => f.name === "us_quote-saturday" || f.name === "kr_quote-saturday")
  .flatMap((f) => f.fixture.exchanges);

async function start(runtimes: RuntimeRegistry) {
  const db = createTestDb();
  const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
    db,
    logger: false,
    runtimes,
    runs: { flushMs: 0 },
    mcp: {
      skills: [SELFTEST_SKILL],
      egress: () => ({
        endpoint: async () => ({ port: 9, url: "http://127.0.0.1:9", close: async () => {} }),
        close: async () => {},
      }),
      finance: { worker: replayWorker(exchanges).worker, now: () => SATURDAY },
    },
  });
  closers.push(() => app.close());
  const f = await createFamily(app);
  const send = async (cookie: string, conversationId: string, text: string, runtime?: string) => {
    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      headers: {
        host: "localhost:3000",
        cookie,
        origin: "http://localhost:3000",
        [CSRF_HEADER]: "1",
        "content-type": "application/json",
      },
      payload: { text, ...(runtime ? { runtime } : {}) },
    });
    expect(res.statusCode, res.body).toBe(201);
    const run = (res.json() as { run: Run }).run;
    return waitRun(app, run.id);
  };
  return { app, db, f, send };
}

async function waitRun(app: App, id: string) {
  for (let i = 0; i < 500; i++) {
    const r = app.runs!.get(id)!;
    if (r.endedAt !== null) {
      const parts = app.conversations!.messageById(r.assistantMessageId)!.parts as MessagePart[];
      const events = app.runs!.eventsAfter(id, -1).map((e) => e.data);
      return {
        run: r,
        parts,
        events,
        note: parts.find((p): p is FinanceNotePart => p.type === "finance_note"),
      };
    }
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error("run did not end");
}

const fake = (script: FakeScript = defaultScript) => {
  const r = new RuntimeRegistry();
  r.register(new FakeRuntime({ script }));
  return r;
};

describe("finance output check under the run manager (#30)", () => {
  it("an answer that used a finance tool gets the note — flagged when it left out source and as-of", async () => {
    const { app, f, send } = await start(fake());
    const c = app.conversations!.create(f.users.owner.id);
    const a = await send(f.cookies.owner, c.id, "/finance");
    expect(a.run.status).toBe("done");
    expect(a.note).toEqual({
      type: "finance_note",
      sources: [
        expect.objectContaining({ label: "Yahoo Finance · 2026-11-13 16:00 ET 종가" }),
        expect.objectContaining({ label: "네이버 증권 · 2026-11-13 15:30 KST 종가" }),
      ],
      missing: ["source", "as_of"],
      disclaimer: FINANCE_DISCLAIMER,
    });
    // The note is the last part, and it went out on the stream before `done`.
    expect(a.parts.at(-1)).toEqual(a.note);
    const types = a.events.map((e: StreamEvent) => e.type);
    expect(types.slice(-2)).toEqual(["part_update", "done"]);
    const c2 = app.conversations!.create(f.users.owner.id);
    const b = await send(f.cookies.owner, c2.id, "/finance cited");
    expect(b.note?.missing).toEqual([]);
    expect(b.note?.disclaimer).toBe(FINANCE_DISCLAIMER);
  });

  it("follow-ups that state figures are checked against the answer before; other answers get no note", async () => {
    const { app, f, send } = await start(fake());
    const c = app.conversations!.create(f.users.owner.id);
    await send(f.cookies.owner, c.id, "/finance");
    // The fake echoes the message: a follow-up with a figure in it.
    const follow = await send(f.cookies.owner, c.id, "원화로 51만 원 정도");
    expect(follow.note).toMatchObject({
      sources: [
        expect.objectContaining({ source: "Yahoo Finance" }),
        expect.objectContaining({ source: "네이버 증권" }),
      ],
      disclaimer: FINANCE_DISCLAIMER,
    });
    const plain = app.conversations!.create(f.users.owner.id);
    expect((await send(f.cookies.owner, plain.id, "안녕 반가워 2번")).note).toBeUndefined();
  });

  it("an answer without figures in between does not end the finance context (four turns)", async () => {
    const { app, f, send } = await start(fake());
    const c = app.conversations!.create(f.users.owner.id);
    expect((await send(f.cookies.owner, c.id, "/finance")).note).toBeDefined();
    // An explanation without figures: nothing to check, no note.
    expect((await send(f.cookies.owner, c.id, "종가라는 뜻이야?")).note).toBeUndefined();
    // The figures come back two answers later: still checked, with the earlier results' sources.
    const later = await send(f.cookies.owner, c.id, "두 주 가격은 349.80달러와 206,000원");
    expect(later.note).toMatchObject({
      sources: [
        expect.objectContaining({ source: "Yahoo Finance" }),
        expect.objectContaining({ source: "네이버 증권" }),
      ],
      missing: ["source", "as_of"],
      disclaimer: FINANCE_DISCLAIMER,
    });
  });

  it("a partial finance answer recovered after a restart gets the note", async () => {
    const hang: FakeScript = (input, memory) => [
      ...defaultScript({ ...input, text: "/finance" }, memory),
      { delayMs: 60_000 },
    ];
    const { app, db, f } = await start(fake(hang));
    const c = app.conversations!.create(f.users.owner.id);
    const r = app.runs!.begin({
      conversationId: c.id,
      userId: f.users.owner.id,
      prepare: () => ({
        user: app.conversations!.append(c.id, { role: "user", parts: [{ type: "text", text: "x" }] }),
        assistant: app.conversations!.append(c.id, { role: "assistant", parts: [], status: "pending" }),
      }),
    });
    for (let i = 0; i < 300; i++) {
      const parts = app.conversations!.messageById(r.assistant.id)!.parts as MessagePart[];
      if (parts.some((p) => p.type === "text" && p.text.includes("206,000"))) break;
      await new Promise((res) => setTimeout(res, 10));
    }
    // The process dies mid-run: a new manager over the same database recovers it.
    const manager = new RunManager(db, app.conversations!, new RuntimeRegistry(), app.appEvents);
    expect(manager.recover()).toBe(1);
    const row = manager.get(r.run.id)!;
    expect(row).toMatchObject({ status: "failed", errorCode: "server_restart" });
    const parts = app.conversations!.messageById(r.assistant.id)!.parts as MessagePart[];
    const note = parts.find((p): p is FinanceNotePart => p.type === "finance_note");
    expect(note).toMatchObject({ missing: ["source", "as_of"], disclaimer: FINANCE_DISCLAIMER });
    expect(note!.sources).toHaveLength(2);
    expect(manager.eventsAfter(r.run.id, -1).map((e) => e.data.type)).toContain("part_update");
  });

  it("scheduled runs (purpose schedule) go through the same check", async () => {
    const { app, f } = await start(fake());
    const c = app.conversations!.create(f.users.owner.id);
    const r = app.runs!.begin({
      conversationId: c.id,
      userId: f.users.owner.id,
      purpose: "schedule",
      prepare: () => ({
        user: app.conversations!.append(c.id, { role: "user", parts: [{ type: "text", text: "/finance" }] }),
        assistant: app.conversations!.append(c.id, { role: "assistant", parts: [], status: "pending" }),
      }),
    });
    const done = await waitRun(app, r.run.id);
    expect(done.note?.disclaimer).toBe(FINANCE_DISCLAIMER);
    expect(done.note?.sources).toHaveLength(2);
  });

  it("a stopped answer keeps its note too", async () => {
    const slow: FakeScript = (input, memory) => [
      ...defaultScript({ ...input, text: "/finance" }, memory).slice(0, 2),
      { text: "AAPL 348.51달러, " },
      { delayMs: 5000 },
      { text: "끝" },
    ];
    const { app, f } = await start(fake(slow));
    const c = app.conversations!.create(f.users.owner.id);
    const r = app.runs!.begin({
      conversationId: c.id,
      userId: f.users.owner.id,
      prepare: () => ({
        user: app.conversations!.append(c.id, { role: "user", parts: [{ type: "text", text: "x" }] }),
        assistant: app.conversations!.append(c.id, { role: "assistant", parts: [], status: "pending" }),
      }),
    });
    for (let i = 0; i < 200; i++) {
      const parts = app.conversations!.messageById(r.assistant.id)!.parts as MessagePart[];
      if (parts.some((p) => p.type === "text")) break;
      await new Promise((res) => setTimeout(res, 10));
    }
    await app.runs!.interrupt(r.run.id);
    const done = await waitRun(app, r.run.id);
    expect(done.run.status).toBe("interrupted");
    expect(done.note?.missing).toEqual(["source", "as_of"]);
  });
});

// ---- both runtimes ------------------------------------------------------------------------------------------

const PROMPT = "AAPL, 005930 현재가";
const CALLS = [
  { id: "f1", tool: "us_quote", args: { symbol: "AAPL" } },
  { id: "f2", tool: "kr_quote", args: { code: "005930" } },
];
/** Claude answers citing the labels; Codex leaves them out — the server's note is there either way. */
const CLAUDE_ANSWER =
  "AAPL은 349.80달러(Yahoo Finance · 2026-11-13 16:00 ET 종가), 삼성전자(005930)는 206,000원(네이버 증권 · 2026-11-13 15:30 KST 종가)이에요. 오늘은 토요일이라 금요일 종가예요.";
const CODEX_ANSWER = "AAPL은 349.80달러, 삼성전자는 206,000원이에요.";

/** The adapter as the default runtime id's stand-in (connection choice is tested in connections.test.ts). */
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
          ...CALLS.map((c) => liveCall(c.id, c.tool, c.args) as unknown as SDKMessage),
          sdk.delta(CLAUDE_ANSWER),
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
            ...CALLS.map((c) => liveCall(c.id, c.tool, c.args) as unknown as Record<string, unknown>),
            cx.delta(CODEX_ANSWER),
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

describe('"AAPL, 005930 현재가" in both runtimes (#30 completion criterion)', () => {
  it("Claude Code and Codex: real finance tool calls, Friday's close on Saturday, sources, as-of and the disclaimer", async () => {
    const runtimes = new RuntimeRegistry();
    runtimes.register(unwired(claude()));
    runtimes.register(unwired(codex()));
    const { app, f, send } = await start(runtimes);
    const results: Record<string, Awaited<ReturnType<typeof send>>> = {};
    for (const rt of ["claude-code", "codex"]) {
      const c = app.conversations!.create(f.users.owner.id);
      results[rt] = await send(f.cookies.owner, c.id, PROMPT, rt);
    }
    for (const [rt, r] of Object.entries(results)) {
      expect(r.run.status, rt).toBe("done");
      expect(r.run.runtime).toBe(rt);
      // The tools really answered through our MCP server (scripted runtime → adapter's MCP config → our server).
      const outputs = r.parts.flatMap((p) => (p.type === "tool_result" ? [p] : []));
      expect(
        outputs.map((o) => o.isError ?? false),
        rt,
      ).toEqual([false, false]);
      const [us, kr] = outputs.map(
        (o) => o.output as Record<string, { value: number; asOf: string; kind: string }>,
      );
      expect(us!.price).toMatchObject({ value: 349.8, asOf: "2026-11-13T16:00:00-05:00", kind: "close" });
      expect(kr!.price).toMatchObject({ value: 206000, asOf: "2026-11-13T15:30:00+09:00", kind: "close" });
      expect(r.note, rt).toMatchObject({
        sources: [
          expect.objectContaining({ label: "Yahoo Finance · 2026-11-13 16:00 ET 종가" }),
          expect.objectContaining({ label: "네이버 증권 · 2026-11-13 15:30 KST 종가" }),
        ],
        disclaimer: FINANCE_DISCLAIMER,
      });
    }
    expect(results["claude-code"]!.note!.missing).toEqual([]);
    expect(results.codex!.note!.missing).toEqual(["source", "as_of"]);
  });

  it("the son (youth, default skills) is not offered the finance tools in either runtime", async () => {
    const runtimes = new RuntimeRegistry();
    runtimes.register(unwired(claude()));
    const { app } = await start(runtimes);
    const son = app.users!.create({
      email: "son@example.com",
      name: "아들",
      role: "member",
      passwordHash: "x",
      youth: true,
    });
    expect(app.mcp!.toolNamesFor(son.id).filter((t) => /^(kr|us|fx|dart|sec)_/.test(t))).toEqual([]);
  });
});
