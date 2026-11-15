import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CSRF_HEADER, MemoryProposal, type MessagePart, type Run, type RuntimeId } from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { RuntimeRegistry, type RuntimeAdapter } from "../src/runtime/adapter.js";
import { ClaudeAdapter } from "../src/runtime/claude.js";
import { CODEX_MODELS, CodexAdapter } from "../src/runtime/codex.js";
import { fixtureWebWorker } from "../src/runtime/fake-citations.js";
import { MEMORY_INJECTION_TEXT, memoryScenario } from "../src/runtime/fake-memory.js";
import { replayQuery, sdk, type ReplayLog } from "./helpers/claude-replay.js";
import { cx, newLog, replaySpawn, type ReplayLog as CodexLog } from "./helpers/codex-replay.js";
import { liveCall } from "./helpers/live-mcp.js";
import { createFamily } from "./helpers/permission-matrix.js";

/**
 * #145 completion criterion (PRD FR-16.4): with both real runtimes' recorded protocols — the Claude Agent SDK replay
 * and the codex app-server replay — calling our MCP server for real: "기억해줘" → the card → 반영 → a new conversation
 * on the other runtime has it in its instructions (the prompt the adapter really sent); "잊어줘" the same way back; and
 * a web page saying "기억해" (INJ-6) never applied even in 자동 반영.
 */

const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});
const LOCAL = { host: "localhost:3000" };
const WRITE = { ...LOCAL, origin: "http://localhost:3000", [CSRF_HEADER]: "1" };
const stubProxy = {
  endpoint: async () => ({ port: 9, url: "http://127.0.0.1:9", close: async () => {} }),
  close: async () => {},
};

const scriptFor = (prompt: string) => memoryScenario(prompt) ?? { calls: [], answer: `알겠어요: ${prompt}` };
const anyPrompt = <T>(turn: (prompt: string) => T) =>
  new Proxy({} as Record<string, T>, {
    get: (_t, k) => (typeof k === "string" ? turn(k) : undefined),
    has: () => true,
  });
const claudePrior = (log: ReplayLog) =>
  String(log.options.findLast((o: Options) => o.sessionId !== undefined)?.systemPrompt ?? "");
const codexPrior = (log: CodexLog) =>
  String(log.requests.findLast((r) => r.method === "thread/start")?.params.baseInstructions ?? "");
const unwired = (a: RuntimeAdapter): RuntimeAdapter => ({
  id: a.id,
  capabilities: () => ({ ...a.capabilities(), needsConnection: false }),
  start: (c) => a.start(c),
  resume: (id, c) => a.resume(id, c),
});

async function start() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "memory-tool-"));
  closers.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const claudeLog: ReplayLog = { options: [], prompts: [], interrupts: 0, closes: 0 };
  const codexLog = newLog();
  const runtimes = new RuntimeRegistry();
  runtimes.register(
    unwired(
      new ClaudeAdapter({
        connection: () => ({
          id: "c1",
          dir: path.join(root, "claude"),
          auth: { kind: "api_key", apiKey: "sk-ant-api03-TESTKEY-" + "m".repeat(20) },
        }),
        query: replayQuery(
          anyPrompt((p): SDKMessage[] => {
            const sc = scriptFor(p);
            return [
              sdk.init({ session: crypto.randomUUID() }),
              ...sc.calls.map((c, i) => liveCall(String(i), c.tool, c.input) as unknown as SDKMessage),
              sdk.delta(sc.answer),
              sdk.result(),
            ];
          }),
          claudeLog,
          1,
        ),
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
          auth: { kind: "api_key", apiKey: "sk-proj-TESTKEY" + "m".repeat(30) },
        }),
        spawn: replaySpawn(
          anyPrompt((p) => {
            const sc = scriptFor(p);
            return {
              threadId: cx.threadId,
              turnId: cx.turnId,
              messages: [
                ...sc.calls.map(
                  (c, i) => liveCall(String(i), c.tool, c.input) as unknown as Record<string, unknown>,
                ),
                cx.delta(sc.answer),
                cx.usage(cx.tokens(10, 0, 2), cx.tokens(10, 0, 2)),
                cx.completed("completed"),
              ],
            };
          }),
          codexLog,
          { delayMs: 1 },
        ),
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
  const app = await buildApp(loadConfig({ NODE_ENV: "test", DATA_DIR: path.join(root, "data") }), {
    db: createTestDb(),
    logger: false,
    runtimes,
    runs: { flushMs: 0 },
    web: { worker: fixtureWebWorker(), fetchProxy: stubProxy as never, providers: ["duckduckgo"] },
  });
  closers.push(() => app.close());
  const f = await createFamily(app);
  const owner = f.cookies.owner;
  const api = (method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: { ...(method === "GET" ? LOCAL : WRITE), cookie: owner },
      ...(method === "GET" ? {} : { payload: payload ?? {} }),
    });
  /** A new conversation on `runtime`, `text` sent; the reply's tool outputs once the run is done. */
  const send = async (runtime: RuntimeId, text: string) => {
    const cid = app.conversations!.create(f.users.owner.id).id;
    expect((await api("PUT", `/api/conversations/${cid}/settings`, { runtime })).statusCode).toBe(200);
    const res = await api("POST", `/api/conversations/${cid}/messages`, { text });
    expect(res.statusCode, res.body).toBe(201);
    const runId = (res.json() as { run: Run }).run.id;
    for (let i = 0; i < 3000; i++) {
      const r = app.runs!.get(runId)!;
      if (r.endedAt !== null) {
        expect(r.status, r.errorCode ?? "").toBe("done");
        expect(r.runtime).toBe(runtime);
        const parts = app.conversations!.messageById(r.assistantMessageId)!.parts as MessagePart[];
        return parts.flatMap((p) =>
          p.type === "tool_result"
            ? [{ output: p.output as Record<string, unknown>, isError: !!p.isError }]
            : [],
        );
      }
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error("run did not end");
  };
  const prior = (runtime: RuntimeId) => (runtime === "codex" ? codexPrior(codexLog) : claudePrior(claudeLog));
  const accept = async (id: string) => {
    const r = await api("POST", `/api/memory-proposals/${id}/accept`, { indexes: [0] });
    expect(r.statusCode, r.body).toBe(200);
    return MemoryProposal.parse(r.json());
  };
  return { app, api, send, prior, accept };
}

const DIRECTIONS: [RuntimeId, RuntimeId][] = [
  ["claude-code", "codex"],
  ["codex", "claude-code"],
];

describe("기억해줘·잊어줘 through both runtimes' recorded protocols (#145)", () => {
  for (const [from, to] of DIRECTIONS)
    it(`${from}: 기억해줘 → card → 반영 → a new ${to} conversation has it; 잊어줘 on ${to} → gone on ${from}`, async () => {
      const t = await start();
      const fact = `금요일 저녁엔 탁구 ${crypto.randomBytes(3).toString("hex")}`;
      const [r] = await t.send(from, `기억해줘: ${fact}`);
      expect(r).toMatchObject({ isError: false, output: { status: "pending", pending: 1 } });
      // Not before the card is accepted.
      await t.send(to, "안녕");
      expect(t.prior(to)).not.toContain(fact);
      const c = await t.accept(String(r!.output.proposalId));
      expect(c.decisions[0]!.status).toBe("accepted");
      await t.send(to, "안녕");
      expect(t.prior(to)).toContain(fact);
      // 잊어줘 on the other runtime: memory_list's id, then the delete.
      const [list, del] = await t.send(to, "기억 1번 잊어줘");
      expect(list!.output).toMatchObject({ memory: [{ text: fact }] });
      expect(del).toMatchObject({ isError: false, output: { status: "pending" } });
      await t.accept(String(del!.output.proposalId));
      await t.send(from, "안녕");
      expect(t.prior(from)).not.toContain(fact);
    });

  for (const runtime of ["claude-code", "codex"] as const)
    it(`${runtime}: a page saying 기억해 (INJ-6) is not applied, even in 자동 반영`, async () => {
      const t = await start();
      expect((await t.api("PUT", "/api/memory-prefs", { applyMode: "auto" })).statusCode).toBe(200);
      const [fetched, proposed] = await t.send(runtime, "/memory-inject");
      expect(fetched!.isError).toBe(false);
      expect(proposed).toMatchObject({ output: { status: "pending", applied: 0 } });
      await t.send(runtime, "안녕");
      expect(t.prior(runtime)).not.toContain(MEMORY_INJECTION_TEXT);
      // An ordinary request in auto mode is applied at once on this runtime.
      const [ok] = await t.send(runtime, "기억해줘: 점심은 가볍게");
      expect(ok).toMatchObject({ output: { status: "applied", applied: 1 } });
      await t.send(runtime, "안녕");
      expect(t.prior(runtime)).toContain("점심은 가볍게");
    });
});
