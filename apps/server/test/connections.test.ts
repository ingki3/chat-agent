import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Connection, CSRF_HEADER, RuntimeOption, type Run } from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb, type Db } from "../src/db/client.js";
import { SettingsStore } from "../src/db/settings-store.js";
import { importEnvConnections } from "../src/connections/import.js";
import { CONNECTION_LOST_CODE, SHARED_OFFER_CODE } from "../src/connections/service.js";
import { TEST_MARKER } from "../src/connections/tester.js";
import {
  RuntimeRegistry,
  type RuntimeAdapter,
  type RuntimeEvent,
  type RuntimeSession,
  type StartContext,
} from "../src/runtime/adapter.js";
import { defaultScript, FakeRuntime, type FakeScript } from "../src/runtime/fake.js";
import { createFamily, type Family } from "./helpers/permission-matrix.js";

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

/** Known fake credentials: none of them may ever show up in a response, a log line or the database in clear. */
const KEYS = {
  ownerClaude: `sk-ant-OWNERFAKEKEY${"o".repeat(20)}0001`,
  sharedClaude: `sk-ant-SHAREDFAKEKEY${"s".repeat(20)}0002`,
  adminSub: `sk-ant-oat01-ADMINFAKETOKEN${"t".repeat(20)}0003`,
  strangerClaude: `sk-ant-STRANGERFAKEKEY${"x".repeat(20)}0004`,
  replaced: `sk-ant-REPLACEDFAKEKEY${"r".repeat(20)}0005`,
  memberCodex: `sk-MEMBERFAKECODEX${"c".repeat(20)}0006`,
};

/**
 * Fake script: `/authfail` = the provider refused the credential; `/slowauth` = the same after 300 ms (a run still
 * in flight on an old key); everything else as the default script.
 */
const script: FakeScript = (input, memory) =>
  input.text === "/authfail"
    ? [{ fail: "refused", code: "runtime_auth" }]
    : input.text === "/slowauth"
      ? [{ delayMs: 300 }, { fail: "refused", code: "runtime_auth" }]
      : defaultScript(input, memory);

function capture() {
  const lines: string[] = [];
  const stream = new Writable({ write: (c, _e, cb) => (lines.push(String(c)), cb()) });
  return { stream, text: () => lines.join("") };
}

async function start(o: { adapters?: RuntimeAdapter[]; db?: Db; env?: Record<string, string> } = {}) {
  const db = o.db ?? createTestDb();
  const log = capture();
  const fake = new FakeRuntime({ needsConnection: true, script });
  const codex = new FakeRuntime({ id: "codex", needsConnection: true, script });
  const runtimes = new RuntimeRegistry();
  if (o.adapters) for (const a of o.adapters) runtimes.register(a);
  else {
    runtimes.register(fake);
    runtimes.register(codex);
  }
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-conn-"));
  closers.push(async () => fs.rmSync(dataDir, { recursive: true, force: true }));
  const app = await buildApp(loadConfig({ NODE_ENV: "test", DATA_DIR: dataDir, ...o.env }), {
    db,
    logStream: log.stream,
    runtimes,
    runs: { flushMs: 0 },
    notifications: { sender: async () => {} },
    mcp: {
      // In-process verification skill (the sandboxed runner is macOS only; its own tests are in mcp.test.ts).
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
  });
  closers.push(() => app.close());
  const f = await createFamily(app);
  /** Every response body, for the secret grep. */
  const bodies: string[] = [];
  const req = async (
    cookie: string,
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    url: string,
    payload?: object,
  ) => {
    const r = await app.inject({
      method,
      url,
      headers: {
        host: "localhost:3000",
        cookie,
        ...(method === "GET"
          ? {}
          : { origin: "http://localhost:3000", [CSRF_HEADER]: "1", "content-type": "application/json" }),
      },
      ...(method === "GET" ? {} : { payload: payload ?? {} }),
    });
    bodies.push(r.body);
    return r;
  };
  const as = (who: keyof Family["cookies"]) => ({
    get: (url: string) => req(f.cookies[who], "GET", url),
    post: (url: string, body?: object) => req(f.cookies[who], "POST", url, body),
    patch: (url: string, body: object) => req(f.cookies[who], "PATCH", url, body),
    put: (url: string, body: object) => req(f.cookies[who], "PUT", url, body),
    del: (url: string) => req(f.cookies[who], "DELETE", url),
  });
  const owner = as("owner");
  const admin = as("admin");
  const stranger = as("stranger");
  const addMine = async (
    who: ReturnType<typeof as>,
    secret: string,
    runtime = "claude-code",
    authType = "api_key",
  ) => {
    const r = await who.post("/api/connections", { runtime, authType, secret });
    expect(r.statusCode).toBe(201);
    return Connection.parse(r.json<{ connection: unknown }>().connection);
  };
  const addShared = async (secret: string, runtime = "claude-code") => {
    const r = await admin.post("/api/admin/connections", { runtime, authType: "api_key", secret });
    expect(r.statusCode).toBe(201);
    return Connection.parse(r.json<{ connection: unknown }>().connection);
  };
  const testMine = async (who: ReturnType<typeof as>, id: string) => {
    const r = await who.post(`/api/connections/${id}/test`);
    expect(r.statusCode).toBe(200);
    return r.json<{ result: { status: string; code: string } }>().result;
  };
  const testShared = async (id: string) => {
    const r = await admin.post(`/api/admin/connections/${id}/test`);
    expect(r.statusCode).toBe(200);
    return r.json<{ result: { status: string; code: string } }>().result;
  };
  const send = (who: ReturnType<typeof as>, conversationId: string, body: object) =>
    who.post(`/api/conversations/${conversationId}/messages`, body);
  const waitRun = async (id: string) => {
    for (let i = 0; i < 500; i++) {
      const r = app.runs!.get(id)!;
      if (r.endedAt !== null) return r;
      await new Promise((res) => setTimeout(res, 5));
    }
    throw new Error("run did not end");
  };
  const runOf = (r: { json: <T>() => T }) => r.json<{ run: Run }>().run;
  const events = (runId: string) => app.runs!.eventsAfter(runId, 0).map((e) => e.data);
  return {
    app,
    db,
    f,
    fake,
    codex,
    log,
    bodies,
    owner,
    admin,
    stranger,
    addMine,
    addShared,
    testMine,
    testShared,
    send,
    waitRun,
    runOf,
    events,
    dataDir,
  };
}

describe("connection rules (#17, PRD D2 / FR-11.4)", () => {
  it("shared connections take API keys only: a shared subscription is 400", async () => {
    const t = await start();
    const r = await t.admin.post("/api/admin/connections", {
      runtime: "claude-code",
      authType: "subscription",
      secret: KEYS.adminSub,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: "shared_subscription" });
    expect(t.app.connections!.store.shared()).toEqual([]);
  });

  it("a Claude subscription only on an admin's own account (403 for members, also via the admin)", async () => {
    const t = await start();
    const mine = await t.owner.post("/api/connections", {
      runtime: "claude-code",
      authType: "subscription",
      secret: KEYS.adminSub,
    });
    expect(mine.statusCode).toBe(403);
    expect(mine.json()).toEqual({ error: "subscription_not_allowed" });
    const onBehalf = await t.admin.post(`/api/admin/users/${t.f.users.owner.id}/connections`, {
      runtime: "claude-code",
      authType: "subscription",
      secret: KEYS.adminSub,
    });
    expect(onBehalf.statusCode).toBe(403);
    const adminOwn = await t.addMine(t.admin, KEYS.adminSub, "claude-code", "subscription");
    expect(adminOwn).toMatchObject({
      scope: "personal",
      authType: "subscription",
      ownerId: t.f.users.admin.id,
    });
  });

  it("scope is fixed: no scope in a body, members cannot reach the shared API; Codex login waits for #18", async () => {
    const t = await start();
    const withScope = await t.owner.post("/api/connections", {
      runtime: "claude-code",
      authType: "api_key",
      scope: "shared",
      secret: KEYS.ownerClaude,
    });
    expect(withScope.statusCode).toBe(400);
    expect(withScope.json()).toEqual({ error: "scope_immutable" });
    const c = await t.addMine(t.owner, KEYS.ownerClaude);
    const patch = await t.owner.patch(`/api/connections/${c.id}`, { scope: "shared" });
    expect(patch.statusCode).toBe(400);
    expect(patch.json()).toEqual({ error: "scope_immutable" });
    expect(t.app.connections!.store.get(c.id)!.scope).toBe("personal");
    expect(
      (
        await t.owner.post("/api/admin/connections", {
          runtime: "claude-code",
          authType: "api_key",
          secret: KEYS.sharedClaude,
        })
      ).statusCode,
    ).toBe(403);
    const codexSub = await t.owner.post("/api/connections", {
      runtime: "codex",
      authType: "subscription",
      secret: KEYS.memberCodex,
    });
    expect(codexSub.json()).toEqual({ error: "unsupported_auth" });
    const bad = await t.owner.post("/api/connections", {
      runtime: "claude-code",
      authType: "api_key",
      secret: "x".repeat(30),
    });
    expect(bad.json()).toEqual({ error: "invalid_secret" });
  });

  it("someone else's personal connection: 403 through every route; the admin registers and removes, never reads", async () => {
    const t = await start();
    const c = await t.addMine(t.owner, KEYS.ownerClaude);
    for (const r of [
      await t.stranger.get(`/api/connections/${c.id}`),
      await t.stranger.patch(`/api/connections/${c.id}`, { label: "내 것" }),
      await t.stranger.post(`/api/connections/${c.id}/test`),
      await t.stranger.del(`/api/connections/${c.id}`),
      await t.admin.get(`/api/connections/${c.id}`),
    ])
      expect(r.statusCode).toBe(403);
    const byAdmin = await t.admin.post(`/api/admin/users/${t.f.users.stranger.id}/connections`, {
      runtime: "codex",
      authType: "api_key",
      secret: KEYS.memberCodex,
    });
    expect(byAdmin.statusCode).toBe(201);
    const made = Connection.parse(byAdmin.json<{ connection: unknown }>().connection);
    expect(made).toMatchObject({ ownerId: t.f.users.stranger.id, registeredByAdmin: true, hint: "••••0006" });
    const listed = await t.admin.get(`/api/admin/users/${t.f.users.stranger.id}/connections`);
    expect(listed.json<{ items: unknown[] }>().items).toHaveLength(1);
    // The member sees it as theirs; deleting it through the owner route fails for the admin, works on the admin route.
    expect((await t.stranger.get("/api/connections")).json<{ items: { id: string }[] }>().items[0]!.id).toBe(
      made.id,
    );
    expect(
      (await t.admin.del(`/api/admin/users/${t.f.users.owner.id}/connections/${made.id}`)).statusCode,
    ).toBe(404);
    expect(
      (await t.admin.del(`/api/admin/users/${t.f.users.stranger.id}/connections/${made.id}`)).statusCode,
    ).toBe(200);
    expect((await t.stranger.get("/api/connections")).json<{ items: unknown[] }>().items).toEqual([]);
  });
});

describe("connection test (#17, FR-11.5)", () => {
  it("passes on a working connection; only passed connections reach the picker", async () => {
    const t = await start();
    const c = await t.addMine(t.owner, KEYS.ownerClaude);
    const picker = async () =>
      RuntimeOption.array()
        .parse((await t.owner.get("/api/runtimes")).json<{ items: unknown[] }>().items)
        .find((o) => o.runtime === "claude-code")!;
    expect((await picker()).connections).toEqual([]);
    expect(await t.testMine(t.owner, c.id)).toEqual({
      status: "passed",
      code: "ok",
      checks: { reply: true, streaming: true, tool: true, skill: true },
    });
    expect((await picker()).connections.map((x) => x.id)).toEqual([c.id]);
    // The test ran on the connection, flagged as a test.
    expect(t.fake.contexts.at(-1)).toMatchObject({ connectionId: c.id, connectionTest: true });
    // A new key must be tested again.
    await t.owner.patch(`/api/connections/${c.id}`, { secret: KEYS.replaced });
    expect(t.app.connections!.store.get(c.id)).toMatchObject({ status: "untested", hint: "••••0005" });
    expect((await picker()).connections).toEqual([]);
  });

  it("fails without the tool call or the skill, and on a refused credential", async () => {
    const noTools = new FakeRuntime({
      needsConnection: true,
      script: (i) => (i.text.startsWith(TEST_MARKER) ? [{ text: "OK" }] : [{ text: "?" }]),
    });
    const t = await start({ adapters: [noTools] });
    const c = await t.addMine(t.owner, KEYS.ownerClaude);
    expect(await t.testMine(t.owner, c.id)).toMatchObject({ status: "failed", code: "test_no_tool" });
    const wrongSkill = new FakeRuntime({
      needsConnection: true,
      script: () => [
        { tool: "echo_time", ms: 0, output: { now: new Date().toISOString() } },
        { tool: "skill_selftest", ms: 0, output: { sha256: "0".repeat(64) } },
        { text: "OK" },
      ],
    });
    const t2 = await start({ adapters: [wrongSkill] });
    const c2 = await t2.addMine(t2.owner, KEYS.ownerClaude);
    expect(await t2.testMine(t2.owner, c2.id)).toMatchObject({ status: "failed", code: "test_no_skill" });
    const refused = new FakeRuntime({
      needsConnection: true,
      script: () => [{ fail: "x", code: "runtime_auth" }],
    });
    const t3 = await start({ adapters: [refused] });
    const c3 = await t3.addMine(t3.owner, KEYS.ownerClaude);
    expect(await t3.testMine(t3.owner, c3.id)).toMatchObject({ status: "failed", code: "runtime_auth" });
    expect(t3.app.connections!.store.get(c3.id)!.status).toBe("failed");
  });

  it("with a tool-using runtime, our MCP server must really have answered both calls", async () => {
    /** Calls our MCP server like a real runtime would (honest), or only reports the calls (liar). */
    class McpRuntime implements RuntimeAdapter {
      readonly id = "claude-code" as const;
      seen: StartContext[] = [];
      constructor(private readonly honest: boolean) {}
      capabilities() {
        return {
          models: [{ id: "m", label: "M", efforts: [] }],
          canSwitchModelInSession: false,
          canResume: false,
          usesTools: true,
          needsConnection: true,
        };
      }
      async resume(): Promise<RuntimeSession> {
        throw new Error("no");
      }
      async start(ctx: StartContext): Promise<RuntimeSession> {
        this.seen.push(ctx);
        const honest = this.honest;
        return {
          externalSessionId: "s",
          setModel: async () => {},
          close: async () => {},
          turn: (input) => ({
            interrupt: async () => {},
            events: (async function* (): AsyncGenerator<RuntimeEvent> {
              const nonce = /with text "([^"]*)"/.exec(input.text)![1]!;
              const outputs: Record<string, unknown> = {
                echo_time: { now: new Date().toISOString() },
                skill_selftest: { sha256: crypto.createHash("sha256").update(nonce).digest("hex") },
              };
              if (honest) {
                const client = new Client({ name: "t", version: "0" });
                await client.connect(
                  new StreamableHTTPClientTransport(new URL(ctx.mcp!.url), {
                    requestInit: { headers: { Authorization: `Bearer ${ctx.mcp!.token}` } },
                  }),
                );
                for (const [name, args] of [
                  ["echo_time", {}],
                  ["skill_selftest", { text: nonce }],
                ] as const) {
                  const r = (await client.callTool({ name, arguments: args })) as {
                    content: { text: string }[];
                  };
                  outputs[name] = JSON.parse(r.content[0]!.text) as unknown;
                }
                await client.close();
              }
              for (const name of ["echo_time", "skill_selftest"]) {
                yield { type: "tool_start", callId: name, name: `mcp__agentlee__${name}`, input: {} };
                yield { type: "tool_end", callId: name, output: outputs[name] };
              }
              yield { type: "text_delta", text: "OK" };
            })(),
          }),
        };
      }
    }
    const honest = new McpRuntime(true);
    const t = await start({ adapters: [honest] });
    const c = await t.addMine(t.owner, KEYS.ownerClaude);
    expect(await t.testMine(t.owner, c.id)).toMatchObject({ status: "passed", code: "ok" });
    expect(honest.seen[0]).toMatchObject({ tools: expect.arrayContaining(["echo_time", "skill_selftest"]) });
    // The test's MCP token is revoked afterwards.
    expect(t.app.runs!.mcpTokens.size()).toBe(0);
    const t2 = await start({ adapters: [new McpRuntime(false)] });
    const c2 = await t2.addMine(t2.owner, KEYS.ownerClaude);
    expect(await t2.testMine(t2.owner, c2.id)).toMatchObject({ status: "failed", code: "test_no_tool" });
  });
});

describe("run checks and connection choice (#17, FR-1.6 / FR-11.3, acceptance 9–10)", () => {
  it("another user's personal connection id is 403, and nothing is created", async () => {
    const t = await start();
    const theirs = await t.addMine(t.stranger, KEYS.strangerClaude);
    await t.testMine(t.stranger, theirs.id);
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const r = await t.send(t.owner, conv.id, { text: "안녕", connectionId: theirs.id });
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: "connection_not_allowed" });
    expect(t.app.conversations!.messages(conv.id, {})).toEqual([]);
    // Unknown ids and untested ones of my own are refused the same way.
    expect(
      (await t.send(t.owner, conv.id, { text: "a", connectionId: crypto.randomUUID() })).statusCode,
    ).toBe(403);
    const mine = await t.addMine(t.owner, KEYS.ownerClaude);
    expect((await t.send(t.owner, conv.id, { text: "a", connectionId: mine.id })).statusCode).toBe(403);
  });

  it("models, efforts and runtimes outside the policy are 403 (send, edit and regenerate)", async () => {
    const t = await start();
    const c = await t.addMine(t.owner, KEYS.ownerClaude);
    await t.testMine(t.owner, c.id);
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    expect((await t.send(t.owner, conv.id, { text: "a", model: "no-such-model" })).json()).toEqual({
      error: "model_not_allowed",
    });
    expect(
      (await t.send(t.owner, conv.id, { text: "a", model: "fake-large", effort: "ultra" })).json(),
    ).toEqual({
      error: "effort_not_allowed",
    });
    const put = await t.admin.put(`/api/admin/users/${t.f.users.owner.id}/runtime-policies`, {
      items: [
        {
          runtime: "claude-code",
          allowed: true,
          models: ["fake-large"],
          efforts: ["low"],
          allowPersonal: true,
          allowShared: true,
        },
        {
          runtime: "codex",
          allowed: false,
          models: "all",
          efforts: "all",
          allowPersonal: true,
          allowShared: true,
        },
      ],
    });
    expect(put.statusCode).toBe(200);
    expect(
      (await t.owner.put(`/api/admin/users/${t.f.users.owner.id}/runtime-policies`, {})).statusCode,
    ).toBe(403);
    const denied = [
      [{ model: "fake-small" }, "model_not_allowed"],
      [{ model: "fake-large", effort: "high" }, "effort_not_allowed"],
      [{ runtime: "codex" }, "runtime_not_allowed"],
    ] as const;
    for (const [choice, code] of denied) {
      const r = await t.send(t.owner, conv.id, { text: "a", ...choice });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual({ error: code });
    }
    expect(t.app.conversations!.messages(conv.id, {})).toEqual([]);
    // Allowed: the run uses the allowed effort, and the implicit effort falls back to an allowed one.
    const ok = await t.send(t.owner, conv.id, { text: "a", model: "fake-large", effort: "low" });
    expect(ok.statusCode).toBe(201);
    const run = await t.waitRun(t.runOf(ok).id);
    expect(run).toMatchObject({ status: "done", model: "fake-large", effort: "low", connectionId: c.id });
    const msgs = t.app.conversations!.messages(conv.id, {});
    const reply = msgs.at(-1)!;
    expect(reply.connectionId).toBe(c.id);
    const regen = await t.owner.post(`/api/conversations/${conv.id}/messages/${reply.id}/regenerate`, {
      effort: "medium",
    });
    expect(regen.json()).toEqual({ error: "effort_not_allowed" });
    const edit = await t.owner.post(`/api/conversations/${conv.id}/messages/${msgs[0]!.id}/edit`, {
      text: "b",
      model: "fake-small",
    });
    expect(edit.json()).toEqual({ error: "model_not_allowed" });
  });

  it("personal first, `useShared` picks the shared one; no passed connection → no_connection", async () => {
    const t = await start();
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const none = await t.waitRun(t.runOf(await t.send(t.owner, conv.id, { text: "a" })).id);
    expect(none).toMatchObject({ status: "failed", errorCode: "no_connection", connectionId: null });
    const shared = await t.addShared(KEYS.sharedClaude);
    await t.testShared(shared.id);
    const mine = await t.addMine(t.owner, KEYS.ownerClaude);
    await t.testMine(t.owner, mine.id);
    const first = await t.waitRun(t.runOf(await t.send(t.owner, conv.id, { text: "b" })).id);
    expect(first).toMatchObject({ status: "done", connectionId: mine.id, useShared: false });
    const onShared = await t.waitRun(
      t.runOf(await t.send(t.owner, conv.id, { text: "c", useShared: true })).id,
    );
    expect(onShared).toMatchObject({ status: "done", connectionId: shared.id, useShared: true });
    expect(t.fake.contexts.at(-1)!.connectionId).toBe(shared.id);
    // The personal connection's session (another folder) is never resumed on the shared connection.
    expect(t.fake.resumed).toBe(0);
    expect(t.fake.contexts.at(-1)!.history.length).toBeGreaterThan(0);
    // Not allowed to use shared connections: `useShared` is 403, and the shared one is never picked.
    await t.admin.put(`/api/admin/users/${t.f.users.owner.id}/runtime-policies`, {
      items: [
        {
          runtime: "claude-code",
          allowed: true,
          models: "all",
          efforts: "all",
          allowPersonal: true,
          allowShared: false,
        },
      ],
    });
    expect((await t.send(t.owner, conv.id, { text: "d", useShared: true })).statusCode).toBe(403);
    expect((await t.send(t.owner, conv.id, { text: "d", connectionId: shared.id })).statusCode).toBe(403);
  });

  it("a personal limit offers the shared connection; the confirmation (useShared) is bound to the next run", async () => {
    const t = await start();
    const shared = await t.addShared(KEYS.sharedClaude);
    await t.testShared(shared.id);
    const mine = await t.addMine(t.owner, KEYS.ownerClaude);
    await t.testMine(t.owner, mine.id);
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const limited = await t.waitRun(t.runOf(await t.send(t.owner, conv.id, { text: "/limit" })).id);
    expect(limited).toMatchObject({ status: "failed", errorCode: "usage_limit", connectionId: mine.id });
    const notice = t.events(limited.id).find((e) => e.type === "notice" && e.code === SHARED_OFFER_CODE);
    expect(notice).toBeDefined();
    const reply = t.app.conversations!.messages(conv.id, {}).at(-1)!;
    const again = await t.owner.post(`/api/conversations/${conv.id}/messages/${reply.id}/regenerate`, {
      useShared: true,
    });
    // Regenerating repeats "/limit": the shared connection hits its (fake) limit too, and offers nothing more.
    const run = await t.waitRun(t.runOf(again).id);
    expect(run).toMatchObject({ errorCode: "usage_limit", connectionId: shared.id, useShared: true });
    expect(t.events(run.id).some((e) => e.type === "notice" && e.code === SHARED_OFFER_CODE)).toBe(false);
    const next = await t.waitRun(
      t.runOf(await t.send(t.owner, conv.id, { text: "계속", useShared: true })).id,
    );
    expect(next).toMatchObject({ status: "done", connectionId: shared.id, useShared: true });
  });
});

describe("disconnects and expiry (#17, FR-11.8 / 11.9)", () => {
  it("a refused credential ends the run with an error and a notice, marks it expired and tells the owner", async () => {
    const t = await start();
    const mine = await t.addMine(t.owner, KEYS.ownerClaude);
    await t.testMine(t.owner, mine.id);
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const run = await t.waitRun(t.runOf(await t.send(t.owner, conv.id, { text: "/authfail" })).id);
    expect(run).toMatchObject({ status: "failed", errorCode: "runtime_auth" });
    const ev = t.events(run.id);
    const types = ev.map((e) => (e.type === "notice" ? `notice:${e.code}` : e.type));
    expect(types.slice(-3)).toEqual([`notice:${CONNECTION_LOST_CODE}`, "error", "done"]);
    expect(t.app.connections!.store.get(mine.id)!.status).toBe("expired");
    expect(t.app.notifications!.list(t.f.users.owner.id).items.map((n) => n.kind)).toEqual([
      "connection_lost",
    ]);
    // Expired: not offered, not used.
    const next = await t.waitRun(t.runOf(await t.send(t.owner, conv.id, { text: "a" })).id);
    expect(next).toMatchObject({ status: "failed", errorCode: "no_connection" });
  });

  it("a shared connection that breaks warns the admins (system_warning), once", async () => {
    const t = await start();
    const shared = await t.addShared(KEYS.sharedClaude);
    await t.testShared(shared.id);
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    await t.waitRun(t.runOf(await t.send(t.owner, conv.id, { text: "/authfail" })).id);
    expect(t.app.notifications!.list(t.f.users.admin.id).items.map((n) => n.kind)).toEqual([
      "system_warning",
    ]);
    expect(t.app.notifications!.list(t.f.users.owner.id).items).toEqual([]);
    expect(t.app.connections!.store.get(shared.id)!.status).toBe("expired");
  });

  it("disconnecting keeps the history and never resumes the connection's sessions", async () => {
    const t = await start();
    const mine = await t.addMine(t.owner, KEYS.ownerClaude);
    await t.testMine(t.owner, mine.id);
    const shared = await t.addShared(KEYS.sharedClaude);
    await t.testShared(shared.id);
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    await t.waitRun(t.runOf(await t.send(t.owner, conv.id, { text: "하나" })).id);
    await t.waitRun(t.runOf(await t.send(t.owner, conv.id, { text: "둘" })).id);
    expect(t.fake.resumed).toBe(1); // same connection, same history: resumed
    const sessions = () => t.app.conversations!.sessions(conv.id);
    expect(sessions().map((s) => s.connectionId)).toEqual([mine.id]);
    // A runtime folder of this connection exists (it is removed on disconnect).
    const folder = path.join(t.dataDir, "runtimes", mine.id);
    fs.mkdirSync(path.join(folder, t.f.users.owner.id), { recursive: true });
    expect((await t.owner.del(`/api/connections/${mine.id}`)).statusCode).toBe(200);
    expect(fs.existsSync(folder)).toBe(false);
    expect(sessions()).toEqual([]);
    expect(t.app.connections!.store.get(mine.id)).toMatchObject({ secret: null });
    // The history stays; the next run goes to the shared connection with a fresh session.
    const before = t.app.conversations!.messages(conv.id, {}).length;
    const run = await t.waitRun(t.runOf(await t.send(t.owner, conv.id, { text: "셋" })).id);
    expect(run).toMatchObject({ status: "done", connectionId: shared.id });
    expect(t.fake.resumed).toBe(1);
    expect(t.app.conversations!.messages(conv.id, {}).length).toBe(before + 2);
    // A disconnected connection is gone from every route.
    expect((await t.owner.get(`/api/connections/${mine.id}`)).statusCode).toBe(404);
    expect((await t.send(t.owner, conv.id, { text: "넷", connectionId: mine.id })).statusCode).toBe(403);
  });

  it("disconnecting stops a run that is using it", async () => {
    const t = await start();
    const mine = await t.addMine(t.owner, KEYS.ownerClaude);
    await t.testMine(t.owner, mine.id);
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const r = t.runOf(await t.send(t.owner, conv.id, { text: "/long 400" }));
    await new Promise((res) => setTimeout(res, 30));
    await t.owner.del(`/api/connections/${mine.id}`);
    expect(await t.waitRun(r.id)).toMatchObject({ status: "interrupted" });
  });
});

describe("credentials never leave the server in clear (#17, FR-11.6)", () => {
  it("no fake key in any response, log line or database row", async () => {
    const t = await start();
    const own = await t.addMine(t.owner, KEYS.ownerClaude);
    await t.testMine(t.owner, own.id);
    await t.owner.patch(`/api/connections/${own.id}`, { secret: KEYS.replaced });
    await t.testMine(t.owner, own.id);
    const shared = await t.addShared(KEYS.sharedClaude);
    await t.testShared(shared.id);
    const sub = await t.addMine(t.admin, KEYS.adminSub, "claude-code", "subscription");
    await t.testMine(t.admin, sub.id);
    await t.admin.post(`/api/admin/users/${t.f.users.stranger.id}/connections`, {
      runtime: "codex",
      authType: "api_key",
      secret: KEYS.memberCodex,
    });
    // A refused attempt with a key in it must not echo it either.
    await t.owner.post("/api/connections", {
      runtime: "claude-code",
      authType: "subscription",
      secret: KEYS.strangerClaude,
    });
    await t.owner.post("/api/connections", {
      runtime: "claude-code",
      authType: "api_key",
      scope: "x",
      secret: KEYS.strangerClaude,
    });
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    await t.waitRun(t.runOf(await t.send(t.owner, conv.id, { text: "안녕" })).id);
    await t.waitRun(t.runOf(await t.send(t.owner, conv.id, { text: "/authfail" })).id);
    await t.owner.get("/api/connections");
    await t.owner.get("/api/runtimes");
    await t.admin.get("/api/admin/connections");
    await t.admin.get(`/api/admin/users/${t.f.users.stranger.id}/connections`);
    await t.admin.del(`/api/admin/connections/${shared.id}`);

    const tables = t.db.$client
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((r) => (r as { name: string }).name);
    const dbDump = tables
      .map((name) => JSON.stringify(t.db.$client.prepare(`SELECT * FROM "${name}"`).all()))
      .join("\n");
    const haystacks = { responses: t.bodies.join("\n"), log: t.log.text(), db: dbDump };
    expect(t.log.text()).toContain("connection.tested"); // the log was really captured
    expect(dbDump).toContain("v1:"); // and the credentials are stored, encrypted
    for (const [where, text] of Object.entries(haystacks))
      for (const [name, key] of Object.entries(KEYS)) {
        // The key, and any long part of it, never appears.
        expect(text.includes(key), `${name} in ${where}`).toBe(false);
        expect(text.includes(key.slice(7, 27)), `${name} (part) in ${where}`).toBe(false);
      }
    // Hints show the last 4 characters only.
    expect(t.bodies.join("\n")).toContain("••••0005");
  });
});

describe(".env import (#17, docs/ops.md §11)", () => {
  it("imports CLAUDE_API_KEY / CODEX_API_KEY as shared and CLAUDE_OAUTH_TOKEN as the admin's own, once", async () => {
    const db = createTestDb();
    const env = {
      CLAUDE_API_KEY: KEYS.sharedClaude,
      CLAUDE_OAUTH_TOKEN: KEYS.adminSub,
      CODEX_API_KEY: KEYS.memberCodex,
      ADMIN_EMAIL: "admin@matrix.test",
    };
    const t = await start({ db, env });
    // First start: no admin yet when the app was built — the subscription waits for the next start.
    const store = t.app.connections!.store;
    expect(store.shared().map((c) => [c.runtime, c.authType])).toEqual([
      ["claude-code", "api_key"],
      ["codex", "api_key"],
    ]);
    expect(store.personal(t.f.users.admin.id)).toEqual([]);
    const settings = new SettingsStore(db, crypto.randomBytes(32));
    const again = importEnvConnections(
      loadConfig({ NODE_ENV: "test", ...env }),
      store,
      t.app.users!,
      settings,
      undefined,
    );
    expect(again.created.map((c) => [c.scope, c.authType, c.ownerId])).toEqual([
      ["personal", "subscription", t.f.users.admin.id],
    ]);
    expect(
      importEnvConnections(
        loadConfig({ NODE_ENV: "test", ...env }),
        store,
        t.app.users!,
        settings,
        undefined,
      ),
    ).toEqual({ created: [], failed: [] });
    expect(store.shared()).toHaveLength(2);
  });
});

describe("review #84 round 1", () => {
  const policy = (
    o: Partial<{
      allowed: boolean;
      models: "all" | string[];
      efforts: "all" | string[];
      allowPersonal: boolean;
      allowShared: boolean;
    }>,
  ) => ({
    items: [
      {
        runtime: "claude-code",
        allowed: true,
        models: "all",
        efforts: "all",
        allowPersonal: true,
        allowShared: true,
        ...o,
      },
    ],
  });

  it("P1: leaving the effort out never bypasses the effort policy (send, edit, regenerate)", async () => {
    const t = await start();
    const c = await t.addMine(t.owner, KEYS.ownerClaude);
    await t.testMine(t.owner, c.id);
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const done = await t.waitRun(
      t.runOf(await t.send(t.owner, conv.id, { text: "a", model: "fake-large" })).id,
    );
    const msgs = t.app.conversations!.messages(conv.id, {});
    // fake-large takes an effort, but none of its values is allowed: it is not runnable at all.
    await t.admin.put(
      `/api/admin/users/${t.f.users.owner.id}/runtime-policies`,
      policy({ models: ["fake-large"], efforts: [] }),
    );
    for (const r of [
      await t.send(t.owner, conv.id, { text: "b" }),
      await t.send(t.owner, conv.id, { text: "b", model: "fake-large" }),
      await t.owner.post(`/api/conversations/${conv.id}/messages/${msgs[0]!.id}/edit`, { text: "c" }),
      await t.owner.post(`/api/conversations/${conv.id}/messages/${msgs[1]!.id}/regenerate`, {}),
    ])
      expect(r.statusCode).toBe(403);
    expect(t.app.conversations!.messages(conv.id, {})).toHaveLength(2);
    expect(t.app.runs!.get(done.id)!.effort).toBe("medium");
    // Explicitly named: refused for its effort.
    expect((await t.send(t.owner, conv.id, { text: "b", model: "fake-large" })).json()).toEqual({
      error: "effort_not_allowed",
    });
    // A model without any effort setting stays usable under the same effort policy.
    await t.admin.put(`/api/admin/users/${t.f.users.owner.id}/runtime-policies`, policy({ efforts: [] }));
    const small = await t.waitRun(t.runOf(await t.send(t.owner, conv.id, { text: "d" })).id);
    expect(small).toMatchObject({ status: "done", model: "fake-small", effort: null });
    expect((await t.send(t.owner, conv.id, { text: "e", model: "fake-large" })).statusCode).toBe(403);
    const picker = RuntimeOption.array().parse(
      (await t.owner.get("/api/runtimes")).json<{ items: unknown[] }>().items,
    );
    expect(picker.find((o) => o.runtime === "claude-code")!.models.map((m) => m.id)).toEqual(["fake-small"]);
  });

  it("P1: the connection test follows the same policy, and tests with an allowed model and effort", async () => {
    const t = await start();
    const c = await t.addMine(t.owner, KEYS.ownerClaude);
    const url = `/api/connections/${c.id}/test`;
    await t.admin.put(`/api/admin/users/${t.f.users.owner.id}/runtime-policies`, policy({ allowed: false }));
    expect((await t.owner.post(url)).json()).toEqual({ error: "connection_not_allowed" });
    await t.admin.put(
      `/api/admin/users/${t.f.users.owner.id}/runtime-policies`,
      policy({ allowPersonal: false }),
    );
    expect((await t.owner.post(url)).statusCode).toBe(403);
    await t.admin.put(
      `/api/admin/users/${t.f.users.owner.id}/runtime-policies`,
      policy({ models: ["fake-large"], efforts: [] }),
    );
    expect((await t.owner.post(url)).json()).toEqual({ error: "model_not_allowed" });
    expect(t.fake.contexts).toEqual([]); // no session was opened for any of these
    expect(t.app.connections!.store.get(c.id)!.status).toBe("untested");
    await t.admin.put(
      `/api/admin/users/${t.f.users.owner.id}/runtime-policies`,
      policy({ models: ["fake-large"], efforts: ["high", "medium"] }),
    );
    expect(await t.testMine(t.owner, c.id)).toMatchObject({ status: "passed" });
    // The smallest allowed model at its lowest allowed effort (catalog order: low, medium, high).
    expect(t.fake.contexts.at(-1)).toMatchObject({ model: "fake-large", effort: "medium" });
    // Shared connections: the admin's own policy applies to the admin's test as well.
    const shared = await t.addShared(KEYS.sharedClaude);
    await t.admin.put(
      `/api/admin/users/${t.f.users.admin.id}/runtime-policies`,
      policy({ allowShared: false }),
    );
    expect((await t.admin.post(`/api/admin/connections/${shared.id}/test`)).statusCode).toBe(403);
  });

  it("P2: an old key's auth failure does not expire the replaced key", async () => {
    const t = await start();
    const c = await t.addMine(t.owner, KEYS.ownerClaude);
    await t.testMine(t.owner, c.id);
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const old = t.runOf(await t.send(t.owner, conv.id, { text: "/slowauth" }));
    expect(t.app.runs!.get(old.id)!.connectionVersion).toBe(1);
    // The key is replaced underneath the run (the store write alone: the old run's failure races the stop that a
    // PATCH does, see below).
    t.app.connections!.store.update(c.id, { secret: KEYS.replaced });
    expect(await t.testMine(t.owner, c.id)).toMatchObject({ status: "passed" });
    expect(await t.waitRun(old.id)).toMatchObject({ status: "failed", errorCode: "runtime_auth" });
    expect(t.app.connections!.store.get(c.id)).toMatchObject({ status: "passed", credentialVersion: 2 });
    expect(t.app.notifications!.list(t.f.users.owner.id).items).toEqual([]);
    // The current key failing still expires it.
    const now = await t.waitRun(t.runOf(await t.send(t.owner, conv.id, { text: "/authfail" })).id);
    expect(now.connectionVersion).toBe(2);
    expect(t.app.connections!.store.get(c.id)!.status).toBe("expired");
    // A run is never given another version's credential (the adapters' resolver refuses it).
    const store = t.app.connections!.store;
    const user = t.app.users!.byId(t.f.users.owner.id);
    expect(store.resolve(c.id, user, "claude-code", { test: true, version: 1 })).toBeUndefined();
    expect(store.resolve(c.id, user, "claude-code", { test: true, version: 2 })?.secret).toBe(KEYS.replaced);
    // Through the API, a new key stops the runs still using the old one.
    await t.testMine(t.owner, c.id);
    const busy = t.runOf(await t.send(t.owner, conv.id, { text: "/long 400" }));
    await new Promise((r) => setTimeout(r, 30));
    await t.owner.patch(`/api/connections/${c.id}`, { secret: KEYS.ownerClaude });
    expect(await t.waitRun(busy.id)).toMatchObject({ status: "interrupted" });
  });

  it("P2: disconnecting or replacing the key cancels a running test (session closed, token revoked)", async () => {
    const slow = new FakeRuntime({
      needsConnection: true,
      usesTools: true,
      script: (i, m) => (i.text.startsWith(TEST_MARKER) ? [{ delayMs: 10_000 }, ...defaultScript(i, m)] : []),
    });
    const t = await start({ adapters: [slow] });
    for (const how of ["disconnect", "new key"] as const) {
      const c = await t.addMine(t.owner, how === "disconnect" ? KEYS.ownerClaude : KEYS.strangerClaude);
      const began = Date.now();
      const testing = t.owner.post(`/api/connections/${c.id}/test`);
      for (let i = 0; i < 200 && slow.contexts.length < (how === "disconnect" ? 1 : 2); i++)
        await new Promise((r) => setTimeout(r, 5));
      expect(t.app.runs!.mcpTokens.size()).toBe(1);
      if (how === "disconnect") expect((await t.owner.del(`/api/connections/${c.id}`)).statusCode).toBe(200);
      else
        expect((await t.owner.patch(`/api/connections/${c.id}`, { secret: KEYS.replaced })).statusCode).toBe(
          200,
        );
      // By the time the request returns, the runtime can no longer call our tools and its session is closed.
      expect(t.app.runs!.mcpTokens.size()).toBe(0);
      expect(slow.closed).toBe(slow.opened);
      const r = await testing;
      expect(r.json<{ result: { code: string } }>().result.code).toBe("cancelled");
      expect(Date.now() - began).toBeLessThan(5000);
      if (how === "new key") expect(t.app.connections!.store.get(c.id)!.status).toBe("untested");
    }
  });

  it("P2 (round 2): a disconnect during a slow start waits until the adapter has stopped, then removes the folder", async () => {
    let exitedAt = 0;
    let folder = "";
    class SlowStart implements RuntimeAdapter {
      readonly id = "claude-code" as const;
      started = 0;
      capabilities() {
        return {
          models: [{ id: "m", label: "M", efforts: [] }],
          canSwitchModelInSession: false,
          canResume: false,
          usesTools: false,
          needsConnection: true,
        };
      }
      async resume(): Promise<RuntimeSession> {
        throw new Error("no");
      }
      async start(ctx: StartContext): Promise<RuntimeSession> {
        this.started++;
        fs.mkdirSync(folder, { recursive: true });
        // Like an app-server still initialising: it only stops when told, and exiting takes a moment.
        await new Promise<void>((resolve) =>
          ctx.signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        await new Promise((r) => setTimeout(r, 100));
        exitedAt = Date.now();
        throw new Error("killed");
      }
    }
    const slow = new SlowStart();
    const t = await start({ adapters: [slow] });
    const c = await t.addMine(t.owner, KEYS.ownerClaude);
    folder = path.join(t.dataDir, "runtimes", c.id, t.f.users.owner.id);
    const testing = t.owner.post(`/api/connections/${c.id}/test`);
    for (let i = 0; i < 200 && !slow.started; i++) await new Promise((r) => setTimeout(r, 5));
    expect((await t.owner.del(`/api/connections/${c.id}`)).statusCode).toBe(200);
    const returnedAt = Date.now();
    expect(exitedAt).toBeGreaterThan(0);
    expect(returnedAt).toBeGreaterThanOrEqual(exitedAt);
    expect(fs.existsSync(path.join(t.dataDir, "runtimes", c.id))).toBe(false);
    expect((await testing).json<{ result: { code: string } }>().result.code).toBe("cancelled");
  });

  it("P2 (round 3): a disconnect waits for the run's session to be closed, even on a runtime that ignores the signal", async () => {
    let closedAt = 0;
    class SlowClose implements RuntimeAdapter {
      readonly id = "claude-code" as const;
      capabilities() {
        return {
          models: [{ id: "m", label: "M", efforts: [] }],
          canSwitchModelInSession: false,
          canResume: false,
          usesTools: false,
          needsConnection: true,
        };
      }
      async resume(): Promise<RuntimeSession> {
        throw new Error("no");
      }
      async start(): Promise<RuntimeSession> {
        let stop = false;
        return {
          externalSessionId: "s",
          setModel: async () => {},
          // Ends its process slowly.
          close: async () => {
            await new Promise((r) => setTimeout(r, 150));
            closedAt = Date.now();
          },
          turn: () => ({
            interrupt: async () => void (stop = true),
            events: (async function* (): AsyncGenerator<RuntimeEvent> {
              while (!stop) {
                yield { type: "text_delta", text: "a " };
                await new Promise((r) => setTimeout(r, 5));
              }
            })(),
          }),
        };
      }
    }
    const t = await start({ adapters: [new SlowClose()] });
    const c = await t.addMine(t.owner, KEYS.ownerClaude);
    t.app.connections!.store.setTestResult(c.id, "passed", "ok", 1);
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const run = t.runOf(await t.send(t.owner, conv.id, { text: "a" }));
    await new Promise((r) => setTimeout(r, 30));
    expect((await t.owner.del(`/api/connections/${c.id}`)).statusCode).toBe(200);
    expect(closedAt).toBeGreaterThan(0); // closed before the disconnect answered
    expect(t.app.runs!.get(run.id)!.status).toBe("interrupted");
  });

  it("P2: the .env import writes the connection and its flag together; a failure leaves neither", async () => {
    const db = createTestDb();
    const t = await start({ db });
    const store = t.app.connections!.store;
    const config = loadConfig({ NODE_ENV: "test", CLAUDE_API_KEY: KEYS.sharedClaude });
    const real = new SettingsStore(db, crypto.randomBytes(32));
    const broken = {
      get: (k: string) => real.get(k),
      set: () => {
        throw new Error("disk full");
      },
    };
    expect(importEnvConnections(config, store, t.app.users!, broken, undefined)).toEqual({
      created: [],
      failed: [{ item: "claude_api_key", code: "import_failed" }],
    });
    expect(store.shared()).toEqual([]);
    expect(importEnvConnections(config, store, t.app.users!, real, undefined).created).toHaveLength(1);
    expect(importEnvConnections(config, store, t.app.users!, real, undefined).created).toEqual([]);
    expect(store.shared()).toHaveLength(1);
  });
});

describe("review #84 round 2: the .env import recovers", () => {
  /** A (re)start of the server on an existing database, with these `.env` values. */
  async function boot(db: Db, env: Record<string, string>) {
    const fake = new FakeRuntime({ needsConnection: true });
    const codex = new FakeRuntime({ id: "codex", needsConnection: true });
    const runtimes = new RuntimeRegistry();
    runtimes.register(fake);
    runtimes.register(codex);
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-boot-"));
    closers.push(async () => fs.rmSync(dataDir, { recursive: true, force: true }));
    const app = await buildApp(loadConfig({ NODE_ENV: "test", DATA_DIR: dataDir, ...env }), {
      db,
      logger: false,
      runtimes,
      notifications: { sender: async () => {} },
      connectionTest: { timeoutMs: 5000 },
    });
    closers.push(() => app.close());
    await app.ready();
    return app;
  }
  const settle = async (check: () => boolean) => {
    for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  };
  const env = { CLAUDE_API_KEY: KEYS.sharedClaude, CODEX_API_KEY: KEYS.memberCodex };

  it("a failure in the middle imports nothing; the next start imports all and tests them", async () => {
    const db = createTestDb();
    const t = await start({ db }); // the family (an admin to run the tests)
    const store = t.app.connections!.store;
    const real = new SettingsStore(db, crypto.randomBytes(32));
    // The Claude key goes in, then writing the Codex flag fails: the whole import is rolled back.
    const failing = {
      get: (k: string) => real.get(k),
      set: (k: string, v: string) => {
        if (k.includes("codex")) throw new Error("db error");
        real.set(k, v);
      },
    };
    const r = importEnvConnections(
      loadConfig({ NODE_ENV: "test", ...env }),
      store,
      t.app.users!,
      failing,
      undefined,
    );
    expect(r.created).toEqual([]);
    expect(r.failed.map((f) => f.code)).toEqual(["import_failed", "import_failed"]);
    expect(store.shared()).toEqual([]);
    // Restart with the error gone: both are imported and tested.
    const app = await boot(db, env);
    const s2 = app.connections!.store;
    await settle(() => s2.shared().every((c) => c.status === "passed") && s2.shared().length === 2);
    expect(s2.shared().map((c) => [c.runtime, c.status])).toEqual([
      ["claude-code", "passed"],
      ["codex", "passed"],
    ]);
  });

  it("an imported connection whose test never ran is tested on the next start", async () => {
    const db = createTestDb();
    const t = await start({ db });
    const store = t.app.connections!.store;
    const settings = new SettingsStore(db, crypto.randomBytes(32));
    // Imported, then the process stopped before the test ran.
    importEnvConnections(loadConfig({ NODE_ENV: "test", ...env }), store, t.app.users!, settings, undefined);
    expect(store.shared().map((c) => c.status)).toEqual(["untested", "untested"]);
    const app = await boot(db, env);
    const s2 = app.connections!.store;
    await settle(() => s2.shared().every((c) => c.status === "passed"));
    expect(s2.shared().map((c) => c.status)).toEqual(["passed", "passed"]);
    expect(s2.shared()).toHaveLength(2); // not imported twice
  });

  it("a value the rules refuse is skipped (not marked), the rest is imported, the server starts and the admin sees it", async () => {
    const db = createTestDb();
    const t = await start({ db });
    // A malformed key in `.env`: the config accepts it, the importer refuses it, and the server still starts.
    const app = await boot(db, { CLAUDE_API_KEY: KEYS.sharedClaude, CODEX_API_KEY: "sk-bad" });
    expect(app.connections!.store.shared().map((c) => c.runtime)).toEqual(["claude-code"]);
    const r = await app.inject({
      url: "/api/admin/connections",
      headers: { host: "localhost:3000", cookie: t.f.cookies.admin },
    });
    expect(r.json<{ importFailures: unknown }>().importFailures).toEqual([
      { item: "codex_api_key", code: "invalid_secret" },
    ]);
    // Fixed and restarted: imported now.
    const again = await boot(db, { CLAUDE_API_KEY: KEYS.sharedClaude, CODEX_API_KEY: KEYS.memberCodex });
    expect(again.connections!.store.shared().map((c) => c.runtime)).toEqual(["claude-code", "codex"]);
    expect(again.connections!.importFailures).toEqual([]);
  });
});
