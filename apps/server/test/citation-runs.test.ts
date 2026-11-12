import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  CSRF_HEADER,
  CitationNotePart,
  type CitationStatus,
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
import {
  CITATION_SCENARIOS,
  FIXTURE_PAGES,
  fixtureWebWorker,
  type CitationScenarioName,
} from "../src/runtime/fake-citations.js";
import { RunManager } from "../src/runtime/runs.js";
import { replayQuery, sdk, type ReplayLog } from "./helpers/claude-replay.js";
import { cx, newLog, replaySpawn } from "./helpers/codex-replay.js";
import { liveCall } from "./helpers/live-mcp.js";
import { createFamily } from "./helpers/permission-matrix.js";

/**
 * The citation check under the run manager (#25): every answer that used web tools or cited sources ends with
 * the server's citation note — each `[n]` with the status the server gave it, and the paragraphs without one —
 * however the run ended (also after a restart), in every runtime. The scenarios (fake-citations.ts) are the same
 * for the FakeRuntime, the e2e run and the Claude / Codex replays: conflict, insufficient sources, partial
 * missing, existing-source reuse.
 */

type App = Awaited<ReturnType<typeof buildApp>>;
const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "citation-runs-"));
  closers.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

const stubProxy = {
  endpoint: async () => ({ port: 9, url: "http://127.0.0.1:9", close: async () => {} }),
  close: async () => {},
};

async function start(runtimes: RuntimeRegistry) {
  const db = createTestDb();
  const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
    db,
    logger: false,
    runtimes,
    runs: { flushMs: 0 },
    // No network: the fixture pages and searches are answered in-process; the providers' proxies are stubs.
    web: { worker: fixtureWebWorker(), fetchProxy: stubProxy as never, providers: ["duckduckgo"] },
    mcp: { skills: [SELFTEST_SKILL], egress: () => stubProxy },
  });
  closers.push(() => app.close());
  const f = await createFamily(app);
  const api = (cookie: string, method: "POST" | "PATCH" | "GET", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: {
        host: "localhost:3000",
        cookie,
        origin: "http://localhost:3000",
        [CSRF_HEADER]: "1",
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  const send = async (cookie: string, conversationId: string, text: string, runtime?: string) => {
    const res = await api(cookie, "POST", `/api/conversations/${conversationId}/messages`, {
      text,
      ...(runtime ? { runtime } : {}),
    });
    expect(res.statusCode, res.body).toBe(201);
    return waitRun(app, (res.json() as { run: Run }).run.id);
  };
  return { app, db, f, send, api };
}

async function waitRun(app: App, id: string) {
  for (let i = 0; i < 500; i++) {
    const r = app.runs!.get(id)!;
    if (r.endedAt !== null) {
      const parts = app.conversations!.messageById(r.assistantMessageId)!.parts as MessagePart[];
      const events = app.runs!.eventsAfter(id, -1).map((e) => e.data);
      const text = parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
      return {
        run: r,
        parts,
        events,
        text,
        note: parts.find((p): p is CitationNotePart => p.type === "citation_note"),
      };
    }
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error("run did not end");
}

const fake = (script: FakeScript = defaultScript) => {
  const r = new RuntimeRegistry();
  r.register(new FakeRuntime({ script, runTools: true }));
  return r;
};

type Result = Awaited<ReturnType<typeof waitRun>>;
const statuses = (r: Result) => r.note?.citations.map((c) => [c.n, c.status] as [number, CitationStatus]);
const missingText = (r: Result) => r.note?.missing.map((m) => r.text.slice(m.start, m.end));

/** What each scenario must come to, whichever runtime wrote it. */
function expectScenario(name: CitationScenarioName | "reuse-fresh", r: Result, label = name) {
  expect(r.run.status, label).toBe("done");
  expect(r.note, label).toBeDefined();
  // What the browser parses (Message schema): a note that does not fit would break the whole message list.
  expect(CitationNotePart.parse(r.note), label).toEqual(r.note);
  // The note is the last part and went out on the stream before `done`.
  expect(r.parts.at(-1), label).toEqual(r.note);
  expect(r.events.map((e: StreamEvent) => e.type).slice(-2), label).toEqual(["part_update", "done"]);
  switch (name) {
    case "conflict":
      expect(statuses(r), label).toEqual([
        [1, "verified"],
        [2, "verified"],
        [3, "verified"],
      ]);
      expect(
        r.note!.citations.map((c) => c.site),
        label,
      ).toEqual(["가나다 신문", "라마바 통계", "라마바 통계"]);
      expect(r.note!.citations[0]!.quote, label).toBe(
        "산업통상자원부는 10일 10월 반도체 수출이 전년 같은 달보다 32% 늘어난 142억 달러로 집계됐다고 밝혔다.",
      );
      // The heading is not checked; every paragraph has its marker.
      expect(r.note!.missing, label).toEqual([]);
      break;
    case "insufficient":
      expect(statuses(r), label).toEqual([
        [1, "verified"],
        [2, "snippet_not_found"],
        [3, "fetch_failed"],
      ]);
      expect(r.note!.citations[1]!.quote, label).toBe("전고체 배터리는 2026년 양산이 확정됐다");
      // "출처가 충분하지 않아요." is the research-mode statement, not a claim.
      expect(r.note!.missing, label).toEqual([]);
      break;
    case "partial":
      expect(statuses(r), label).toEqual([[1, "verified"]]);
      expect(missingText(r), label).toEqual([
        "업계는 내년에도 두 자릿수 증가를 예상해요.",
        "- 미국 수출 비중이 가장 컸어요",
      ]);
      break;
    case "reuse":
      // Pages of the earlier answer, checked again; [3] was never cited in this answer.
      expect(statuses(r), label).toEqual([
        [1, "verified"],
        [2, "verified"],
        [3, "unknown_source"],
      ]);
      expect(
        r.note!.citations.map((c) => c.url),
        label,
      ).toEqual([FIXTURE_PAGES[0]!.url, FIXTURE_PAGES[1]!.url, null]);
      break;
    case "reuse-fresh":
      // No earlier sources in this conversation: nothing to reuse, nothing passes as normal.
      expect(statuses(r), label).toEqual([
        [1, "unknown_source"],
        [2, "unknown_source"],
        [3, "unknown_source"],
      ]);
      break;
  }
}

describe("citation check under the run manager (#25, FakeRuntime)", () => {
  it("the four fixture scenarios: conflict, insufficient sources, partial missing, existing-source reuse", async () => {
    const { app, f, send } = await start(fake());
    const c = app.conversations!.create(f.users.owner.id);
    expectScenario("conflict", await send(f.cookies.owner, c.id, "/cite conflict"));
    expectScenario("reuse", await send(f.cookies.owner, c.id, "/cite reuse"));
    for (const name of ["insufficient", "partial"] as const) {
      const conv = app.conversations!.create(f.users.owner.id);
      expectScenario(name, await send(f.cookies.owner, conv.id, `/cite ${name}`));
    }
    const fresh = app.conversations!.create(f.users.owner.id);
    expectScenario("reuse-fresh", await send(f.cookies.owner, fresh.id, "/cite reuse"));
  });

  it("a source id of another conversation or another user cited through the run's token: unknown_source", async () => {
    const { app, f, send, api } = await start(fake());
    const a = app.conversations!.create(f.users.owner.id);
    await send(f.cookies.owner, a.id, "/cite conflict");
    const list = await api(f.cookies.owner, "GET", `/api/conversations/${a.id}/sources`);
    const id = (list.json() as { items: { id: string }[] }).items[0]!.id;
    const snippet = CITATION_SCENARIOS.conflict.calls[2]!.input.snippet as string;
    // Same user, other conversation.
    const b = app.conversations!.create(f.users.owner.id);
    const other = await send(f.cookies.owner, b.id, `/cite-id ${id} ${snippet}`);
    expect(statuses(other)).toEqual([[1, "unknown_source"]]);
    expect(other.note!.citations[0]).toMatchObject({ sourceId: null, title: null, url: null, quote: null });
    // Another user.
    const theirs = app.conversations!.create(f.users.stranger.id);
    const stranger = await send(f.cookies.stranger, theirs.id, `/cite-id ${id} ${snippet}`);
    expect(statuses(stranger)).toEqual([[1, "unknown_source"]]);
    // In its own conversation the same call is verified.
    const own = await send(f.cookies.owner, a.id, `/cite-id ${id} ${snippet}`);
    expect(statuses(own)).toEqual([[1, "verified"]]);
  });

  it("no web tool and no citation: array indexing gets no note, a made-up sentence-end [n] is unknown", async () => {
    const { app, f, send } = await start(fake());
    const c = app.conversations!.create(f.users.owner.id);
    // The fake echoes the message.
    expect((await send(f.cookies.owner, c.id, "배열 a[1] 은 두 번째 값")).note).toBeUndefined();
    const made = await send(f.cookies.owner, c.id, "최신 수출은 32% 증가했다[1].");
    expect(statuses(made)).toEqual([[1, "unknown_source"]]);
    expect(made.note!.missing).toEqual([]);
  });

  it("research mode feeds the instructions of the next run (and cite's rules are in them)", async () => {
    const runtimes = new RuntimeRegistry();
    const rt = new FakeRuntime({ runTools: true });
    runtimes.register(rt);
    const { app, f, send, api } = await start(runtimes);
    const c = app.conversations!.create(f.users.owner.id);
    // The owner has the finance tools too (finance@3): the research section is what is looked at.
    const sections = (r: Result) => r.run.instructions!.split(",").filter((s) => !s.startsWith("finance@"));
    expect(sections(await send(f.cookies.owner, c.id, "/cite insufficient"))).toEqual(["common@3"]);
    const on = await api(f.cookies.owner, "PATCH", `/api/conversations/${c.id}`, { researchMode: true });
    expect(on.statusCode).toBe(200);
    expect(sections(await send(f.cookies.owner, c.id, "/cite insufficient"))).toEqual([
      "common@3",
      "research@2",
    ]);
    const prompt = rt.systemPrompts.at(-1)!;
    expect(prompt).toContain("# 자료 조사 모드");
    expect(prompt).toContain("`cite`로 검증한 표시");
    expect(prompt).toContain("`sources_list`");
    await api(f.cookies.owner, "PATCH", `/api/conversations/${c.id}`, { researchMode: false });
    expect(sections(await send(f.cookies.owner, c.id, "/cite insufficient"))).toEqual(["common@3"]);
    expect(rt.systemPrompts.at(-1)).not.toContain("# 자료 조사 모드");
  });

  it("a partial answer recovered after a restart gets the citation note", async () => {
    const hang: FakeScript = (input, memory) => [
      ...defaultScript({ ...input, text: "/cite insufficient" }, memory),
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
      if (parts.some((p) => p.type === "text" && p.text.includes("공식 발표"))) break;
      await new Promise((res) => setTimeout(res, 10));
    }
    const manager = new RunManager(db, app.conversations!, new RuntimeRegistry(), app.appEvents);
    expect(manager.recover()).toBe(1);
    expect(manager.get(r.run.id)).toMatchObject({ status: "failed", errorCode: "server_restart" });
    const parts = app.conversations!.messageById(r.assistant.id)!.parts as MessagePart[];
    const note = parts.find((p): p is CitationNotePart => p.type === "citation_note");
    expect(note?.citations.map((x) => x.status)).toEqual(["verified", "snippet_not_found", "fetch_failed"]);
    expect(manager.eventsAfter(r.run.id, -1).map((e) => e.data.type)).toContain("part_update");
    // Recovering again (another restart) does not add a second note.
    expect(parts.filter((p) => p.type === "citation_note")).toHaveLength(1);
  });

  it("a stopped answer keeps its note too", async () => {
    const slow: FakeScript = (input, memory) => [
      ...defaultScript({ ...input, text: "/cite partial" }, memory),
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
    for (let i = 0; i < 300; i++) {
      const parts = app.conversations!.messageById(r.assistant.id)!.parts as MessagePart[];
      if (parts.some((p) => p.type === "text")) break;
      await new Promise((res) => setTimeout(res, 10));
    }
    await app.runs!.interrupt(r.run.id);
    const done = await waitRun(app, r.run.id);
    expect(done.run.status).toBe("interrupted");
    expect(missingText(done)).toEqual([
      "업계는 내년에도 두 자릿수 증가를 예상해요.",
      "- 미국 수출 비중이 가장 컸어요",
    ]);
  });
});

// ---- both runtimes ------------------------------------------------------------------------------------------

/** One scenario as the runtime's recorded protocol: real calls of our tools, then the answer. */
const claudeTurn = (name: CitationScenarioName): SDKMessage[] => [
  sdk.init({ session: crypto.randomUUID() }),
  ...CITATION_SCENARIOS[name].calls.map(
    (c, i) => liveCall(String(i), c.tool, c.input) as unknown as SDKMessage,
  ),
  sdk.delta(CITATION_SCENARIOS[name].answer),
  sdk.result(),
];
const codexTurn = (name: CitationScenarioName) => ({
  threadId: cx.threadId,
  turnId: cx.turnId,
  messages: [
    ...CITATION_SCENARIOS[name].calls.map(
      (c, i) => liveCall(String(i), c.tool, c.input) as unknown as Record<string, unknown>,
    ),
    cx.delta(CITATION_SCENARIOS[name].answer),
    cx.usage(cx.tokens(10, 0, 2), cx.tokens(10, 0, 2)),
    cx.completed("completed"),
  ],
});
const NAMES = Object.keys(CITATION_SCENARIOS) as CitationScenarioName[];

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
    query: replayQuery(Object.fromEntries(NAMES.map((n) => [`/cite ${n}`, claudeTurn(n)])), log, 1),
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
    spawn: replaySpawn(Object.fromEntries(NAMES.map((n) => [`/cite ${n}`, codexTurn(n)])), newLog(), {
      delayMs: 1,
    }),
    bundledCatalog: async () => ({
      models: CODEX_MODELS.map((m) => ({ slug: m.id, tool_mode: "code_mode_only", base_instructions: "x" })),
    }),
    executable: "/nonexistent/codex",
  });
}

describe("the same citation scenarios in both runtimes (#25 completion criterion, 수용 기준 11)", () => {
  it("Claude Code and Codex: real cite calls through our MCP server, the same note for each scenario", async () => {
    const runtimes = new RuntimeRegistry();
    runtimes.register(unwired(claude()));
    runtimes.register(unwired(codex()));
    const { app, f, send } = await start(runtimes);
    const notes: Record<string, unknown[]> = {};
    for (const rt of ["claude-code", "codex"]) {
      const c = app.conversations!.create(f.users.owner.id);
      const conflict = await send(f.cookies.owner, c.id, "/cite conflict", rt);
      expect(conflict.run.runtime).toBe(rt);
      // The tools really answered through our MCP server.
      const results = conflict.parts.flatMap((p) => (p.type === "tool_result" ? [p] : []));
      expect(
        results.map((o) => o.isError ?? false),
        rt,
      ).toEqual([false, false, false, false, false]);
      expectScenario("conflict", conflict, `${rt} conflict`);
      const reuse = await send(f.cookies.owner, c.id, "/cite reuse", rt);
      expectScenario("reuse", reuse, `${rt} reuse`);
      const rest = [];
      for (const name of ["insufficient", "partial"] as const) {
        const conv = app.conversations!.create(f.users.owner.id);
        const r = await send(f.cookies.owner, conv.id, `/cite ${name}`, rt);
        expectScenario(name, r, `${rt} ${name}`);
        rest.push(r);
      }
      // Source ids differ per conversation; everything else is the same in both runtimes.
      notes[rt] = [conflict, reuse, ...rest].map((r) =>
        JSON.parse(JSON.stringify(r.note, (k, v: unknown) => (k === "sourceId" && v ? "<id>" : v))),
      );
    }
    expect(notes.codex).toEqual(notes["claude-code"]);
  });
});
