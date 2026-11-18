import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CSRF_HEADER, InstructionsResponse, MyDreaming, type RuntimeId } from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { dreamingDate } from "../src/dreaming/engine.js";
import { DREAMING_MARKER } from "../src/dreaming/prompt.js";
import { RuntimeRegistry, type RuntimeAdapter } from "../src/runtime/adapter.js";
import { ClaudeAdapter } from "../src/runtime/claude.js";
import { claudeConnectionFor } from "../src/runtime/claude-config.js";
import { CODEX_MODELS, CodexAdapter } from "../src/runtime/codex.js";
import { codexConnectionFor } from "../src/runtime/codex-config.js";
import { replayQuery, sdk, type ReplayLog } from "./helpers/claude-replay.js";
import { cx, newLog, replaySpawn } from "./helpers/codex-replay.js";
import { createFamily } from "./helpers/permission-matrix.js";

/**
 * #146 completion criterion (PRD FR-16.5, AC-14): a 기억 정리 run through both real runtimes' recorded protocols —
 * the Claude Agent SDK replay and the codex app-server replay — answering a tool-less JSON completion: a proposal in
 * 검토 후 반영, applied in 자동 반영, the session opened without our MCP server or tools and forgotten afterwards. And the
 * connection rule (spec §7): only the admin's shared API key connection, for the target user's folder, whatever the
 * user's own allow-list says — never a personal connection or a subscription.
 */

const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});
const LOCAL = { host: "localhost:3000" };
const WRITE = { ...LOCAL, origin: "http://localhost:3000", [CSRF_HEADER]: "1" };

/** The model's answer: one MEMORY line from each message's "기억: …". */
function answerFor(prompt: string): string {
  if (!prompt.startsWith(DREAMING_MARKER)) return "안녕하세요";
  const data = JSON.parse(prompt.slice(prompt.indexOf("{"))) as { messages: { id: string; text: string }[] };
  return JSON.stringify({
    decisions: data.messages.flatMap((m) => {
      const x = /기억:\s*(.+)/.exec(m.text);
      return x ? [{ action: "add", doc: "memory", text: x[1], sources: [m.id] }] : [];
    }),
  });
}
const anyPrompt = <T>(turn: (prompt: string) => T) =>
  new Proxy({} as Record<string, T>, {
    get: (_t, k) => (typeof k === "string" ? turn(k) : undefined),
    has: () => true,
  });
const unwired = (a: RuntimeAdapter): RuntimeAdapter => ({
  id: a.id,
  capabilities: () => ({ ...a.capabilities(), needsConnection: false }),
  start: (c) => a.start(c),
  resume: (id, c) => a.resume(id, c),
  ...(a.forget ? { forget: a.forget.bind(a) } : {}),
});

async function start() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "dreaming-rt-"));
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
          auth: { kind: "api_key", apiKey: "sk-ant-api03-TESTKEY-" + "d".repeat(20) },
        }),
        query: replayQuery(
          anyPrompt((p): SDKMessage[] => [
            sdk.init({ session: crypto.randomUUID() }),
            sdk.delta(answerFor(p)),
            sdk.result(),
          ]),
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
          auth: { kind: "api_key", apiKey: "sk-proj-TESTKEY" + "d".repeat(30) },
        }),
        spawn: replaySpawn(
          anyPrompt((p) => ({
            threadId: cx.threadId,
            turnId: cx.turnId,
            messages: [
              cx.delta(answerFor(p)),
              cx.usage(cx.tokens(900, 0, 40), cx.tokens(900, 0, 40)),
              cx.completed("completed"),
            ],
          })),
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
  const db = createTestDb();
  const app = await buildApp(loadConfig({ NODE_ENV: "test", DATA_DIR: path.join(root, "data") }), {
    db,
    logger: false,
    runtimes,
    runs: { flushMs: 0 },
  });
  closers.push(() => app.close());
  await app.ready();
  const f = await createFamily(app);
  const api = (method: "GET" | "POST" | "PUT", url: string, payload?: object) =>
    app.inject({
      method,
      url,
      headers: { ...(method === "GET" ? LOCAL : WRITE), cookie: f.cookies.owner },
      ...(method === "GET" ? {} : { payload: payload ?? {} }),
    });
  let n = 0;
  const round = async (runtime: RuntimeId, model: string, text: string) => {
    app.dreaming!.store.setConfig({
      enabled: true,
      tokenCap: 300_000,
      allowed: [{ runtime, connectionId: null, model }],
    });
    app.dreaming!.store.setSettings(f.users.owner.id, {
      enabled: true,
      time: "03:00",
      runtime,
      connectionId: null,
      model,
    });
    const c = app.conversations!.create(f.users.owner.id, {}).id;
    app.conversations!.append(c, { role: "user", parts: [{ type: "text", text }] });
    return app.dreaming!.runner.run({
      userId: f.users.owner.id,
      date: dreamingDate(Date.now()),
      attempt: ++n,
      trigger: "manual",
      idemKey: `rt:${n}`,
    });
  };
  const memory = async () =>
    (
      InstructionsResponse.parse((await api("GET", "/api/instructions")).json()).docs.find(
        (d) => d.kind === "memory",
      )!.items ?? []
    ).map((i) => i.text);
  return { app, db, f, api, round, memory, claudeLog, codexLog };
}

const RUNTIMES: [RuntimeId, string][] = [
  ["claude-code", "claude-opus-5-5"],
  ["codex", CODEX_MODELS[0]!.id],
];

describe("기억 정리 through both runtimes' recorded protocols (#146)", () => {
  for (const [runtime, model] of RUNTIMES)
    it(`${runtime}: a tool-less JSON answer → a proposal (review) → 반영; applied at once (auto)`, async () => {
      const t = await start();
      const fact = `수요일엔 수영 ${crypto.randomBytes(3).toString("hex")}`;
      const r = await t.round(runtime, model, `기억: ${fact}`);
      expect(r, JSON.stringify(r)).toMatchObject({
        status: "proposed",
        counts: { proposed: 1, newMessages: 1 },
      });
      // The session had no MCP server and no tools of ours, and the fixed rules in its instructions.
      if (runtime === "claude-code") {
        const o = t.claudeLog.options.at(-1)! as Options & { mcpServers?: object; allowedTools?: string[] };
        expect(Object.keys(o.mcpServers ?? {})).toEqual([]);
        expect(o.allowedTools ?? []).toEqual([]);
        expect(String(o.systemPrompt)).toContain("고정 규칙");
      } else {
        const started = t.codexLog.requests.findLast((x) => x.method === "thread/start")!;
        expect(String(started.params.baseInstructions)).toContain("고정 규칙");
        expect(JSON.stringify(started.params)).not.toContain("agentlee");
      }
      const mine = MyDreaming.parse((await t.api("GET", "/api/dreaming")).json());
      const b = mine.proposals[0]!;
      expect(b.decisions).toMatchObject([{ action: "add", doc: "memory", text: fact, status: "pending" }]);
      expect((await t.api("POST", `/api/memory-proposals/${b.id}/accept`, { indexes: [0] })).statusCode).toBe(
        200,
      );
      expect(await t.memory()).toEqual([fact]);
      // 자동 반영.
      expect((await t.api("PUT", "/api/memory-prefs", { applyMode: "auto" })).statusCode).toBe(200);
      const fact2 = `토요일엔 등산 ${crypto.randomBytes(3).toString("hex")}`;
      expect(await t.round(runtime, model, `기억: ${fact2}`)).toMatchObject({
        status: "applied",
        counts: { applied: 1 },
      });
      expect(await t.memory()).toEqual([fact, fact2]);
      // Usage per target user, `dreaming`.
      const u = t.db.$client
        .prepare("select purpose, runtime from usage_records where user_id = ? and purpose = 'dreaming'")
        .all(t.f.users.owner.id);
      if (runtime === "codex") expect(u).toContainEqual({ purpose: "dreaming", runtime });
      // The one-off session is handed to the deletion jobs to be forgotten.
      await t.app.purge!.idle();
    });
});

describe("the connection of a system task (spec §7)", () => {
  it("only the admin's shared API key connection, for the target user's folder — whatever their own allow-list", async () => {
    const t = await start();
    const store = t.app.connections!.store;
    const users = t.app.users!;
    const son = t.f.users.owner;
    // The son may not use shared connections at all.
    store.setPolicy(son.id, {
      runtime: "claude-code",
      allowed: false,
      models: "all",
      efforts: "all",
      allowPersonal: false,
      allowShared: false,
    });
    const shared = store.create({
      runtime: "claude-code",
      authType: "api_key",
      scope: "shared",
      owner: null,
      createdBy: t.f.users.admin.id,
      secret: `sk-ant-api03-SHAREDDREAM${"s".repeat(24)}`,
    });
    t.db.$client.prepare("update connections set status = 'passed' where id = ?").run(shared.id);
    const personal = store.create({
      runtime: "claude-code",
      authType: "api_key",
      scope: "personal",
      owner: son,
      createdBy: son.id,
      secret: `sk-ant-api03-PERSONALDREAM${"p".repeat(24)}`,
    });
    t.db.$client.prepare("update connections set status = 'passed' where id = ?").run(personal.id);
    const sys = (connectionId: string, userId = son.id) =>
      claudeConnectionFor(store, users, { userId, connectionId, systemTask: "dreaming" });
    // The ordinary resolver refuses him; the system task does not ask his allow-list.
    expect(claudeConnectionFor(store, users, { userId: son.id, connectionId: shared.id })).toBeUndefined();
    const got = sys(shared.id);
    expect(got).toMatchObject({ id: shared.id, auth: { kind: "api_key" } });
    expect(got!.dir.endsWith(path.join("runtimes", shared.id, son.id))).toBe(true);
    expect(sys(personal.id)).toBeUndefined();
    expect(
      codexConnectionFor(store, users, { userId: son.id, connectionId: shared.id, systemTask: "dreaming" }),
    ).toBeUndefined();
    // Disconnected → nothing (no fallback to another connection).
    t.db.$client.prepare("update connections set disconnected_at = 1 where id = ?").run(shared.id);
    expect(sys(shared.id)).toBeUndefined();
  });
});
