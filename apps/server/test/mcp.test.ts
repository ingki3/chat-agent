import crypto from "node:crypto";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CSRF_HEADER, type Run } from "@agentlee/shared";
import { SELFTEST_SKILL } from "@agentlee/mcp-tools/skills";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { McpTokens } from "../src/isolation/tokens.js";
import { McpService, sandboxedSkillRunner, skillPolicy, type SkillRunner } from "../src/mcp/service.js";
import {
  RuntimeRegistry,
  type RuntimeAdapter,
  type RuntimeEvent,
  type RuntimeSession,
  type StartContext,
} from "../src/runtime/adapter.js";
import { claudeLockdown, codexMcpEnv, codexRunConfig, mcpLoopbackPort } from "../src/runtime/lockdown.js";
import { createFamily } from "./helpers/permission-matrix.js";

const isMac = process.platform === "darwin";
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

type User = { id: string; name: string; active: boolean };
function setup(
  opts: { runSkill?: SkillRunner; users?: User[]; concurrency?: { total: number; perRun: number } } = {},
) {
  const users = new Map((opts.users ?? [{ id: "u-mom", name: "엄마", active: true }]).map((u) => [u.id, u]));
  const tokens = new McpTokens();
  const svc = new McpService(
    tokens,
    { byId: (id: string) => users.get(id) as never },
    {
      now: () => new Date("2026-11-11T03:04:05Z"),
      timeZone: "Asia/Seoul",
      ...(opts.runSkill ? { runSkill: opts.runSkill } : {}),
      ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
    },
  );
  closers.push(() => svc.close());
  const issue = (userId = "u-mom", runId = "r1", conversationId = "c1") =>
    tokens.issue({ userId, conversationId, runId });
  return { svc, tokens, users, issue };
}

async function connect(url: string, token: string | undefined) {
  const client = new Client({ name: "agentlee-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: token === undefined ? {} : { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  closers.push(() => client.close());
  return client;
}

const textOf = (r: unknown) =>
  JSON.parse((r as { content: { type: string; text: string }[] }).content[0]!.text) as Record<
    string,
    unknown
  >;

/** Raw request with full control over headers (fetch would not let us forge Host). */
function raw(
  url: string,
  o: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: u.port,
        path: u.pathname,
        method: o.method ?? "POST",
        headers: o.headers ?? {},
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on("error", (e: NodeJS.ErrnoException) =>
      e.code === "ECONNRESET" || e.code === "EPIPE"
        ? resolve({ status: 0, body: "", headers: {} })
        : reject(e),
    );
    req.end(o.body);
  });
}

const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
});

describe("common MCP server (#43)", () => {
  it("is on its own loopback port, starts once, and offers echo_time + the verification skill", async () => {
    const { svc, issue } = setup();
    const [a, b] = await Promise.all([svc.endpoint(), svc.endpoint()]);
    expect(a).toBe(b);
    expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    const client = await connect(a.url, issue());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["echo_time", "skill_selftest"]);
    expect(svc.toolNames()).toEqual(["echo_time", "skill_selftest"]);
  });

  it("echo_time answers with the server time and the token's user", async () => {
    const { svc, issue } = setup({
      users: [
        { id: "u-mom", name: "엄마", active: true },
        { id: "u-son", name: "아들", active: true },
      ],
    });
    const { url } = await svc.endpoint();
    const mom = await connect(url, issue("u-mom"));
    const r = textOf(await mom.callTool({ name: "echo_time", arguments: {} }));
    expect(r).toMatchObject({ now: "2026-11-11T03:04:05.000Z", timeZone: "Asia/Seoul", userName: "엄마" });
    expect(String(r.local)).toContain("12");
    // A different run's token answers for its own user only.
    const son = await connect(url, issue("u-son", "r2", "c2"));
    expect(textOf(await son.callTool({ name: "echo_time", arguments: {} })).userName).toBe("아들");
  });

  it("refuses calls without a token, with an unknown, revoked or expired token, or for a deactivated user", async () => {
    const { svc, tokens, users, issue } = setup();
    const { url } = await svc.endpoint();
    const send = (auth?: string) =>
      raw(url, {
        headers: {
          host: new URL(url).host,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          ...(auth ? { authorization: auth } : {}),
        },
        body: INIT,
      });
    const good = issue();
    expect((await send(`Bearer ${good}`)).status).toBe(200);

    const none = await send();
    expect(none.status).toBe(401);
    expect(none.headers["www-authenticate"]).toBe("Bearer");
    expect((await send(`Bearer ${crypto.randomBytes(32).toString("base64url")}`)).status).toBe(401);
    expect((await send(`Basic ${good}`)).status).toBe(401);
    expect((await send(`Bearer ${good} x`)).status).toBe(401);
    await expect(connect(url, undefined)).rejects.toThrow();

    // Ends with the run.
    const r2 = issue("u-mom", "r2");
    tokens.revokeRun("r2");
    expect((await send(`Bearer ${r2}`)).status).toBe(401);
    expect((await send(`Bearer ${good}`)).status).toBe(200); // other runs unaffected

    // Expired.
    const shortTokens = new McpTokens(() => clock);
    let clock = 1000;
    const svc2 = new McpService(shortTokens, { byId: (id: string) => users.get(id) as never });
    closers.push(() => svc2.close());
    const url2 = (await svc2.endpoint()).url;
    const t = shortTokens.issue({ userId: "u-mom", conversationId: "c1", runId: "r9" }, 500);
    const send2 = (auth: string) =>
      raw(url2, {
        headers: {
          host: new URL(url2).host,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: auth,
        },
        body: INIT,
      });
    expect((await send2(`Bearer ${t}`)).status).toBe(200);
    clock = 1500;
    expect((await send2(`Bearer ${t}`)).status).toBe(401);

    // Deactivated user: the token stops working at once.
    users.get("u-mom")!.active = false;
    expect((await send(`Bearer ${good}`)).status).toBe(401);
  });

  it("refuses other hosts (DNS rebinding), browser origins, other methods and paths, and oversized bodies", async () => {
    const { svc, issue } = setup();
    const { url, port } = await svc.endpoint();
    const token = issue();
    const base = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    };
    const ok = await raw(url, { headers: { ...base, host: `127.0.0.1:${port}` }, body: INIT });
    expect(ok.status).toBe(200);
    expect((await raw(url, { headers: { ...base, host: `localhost:${port}` }, body: INIT })).status).toBe(
      200,
    );
    for (const host of [`evil.example:${port}`, `127.0.0.1:${port + 1}`, "127.0.0.1", `chat.2prostream.com`])
      expect((await raw(url, { headers: { ...base, host }, body: INIT })).status, host).toBe(403);
    expect(
      (
        await raw(url, {
          headers: { ...base, host: `127.0.0.1:${port}`, origin: "http://evil.example" },
          body: INIT,
        })
      ).status,
    ).toBe(403);
    expect((await raw(url, { method: "GET", headers: { ...base, host: `127.0.0.1:${port}` } })).status).toBe(
      405,
    );
    expect(
      (await raw(url, { method: "DELETE", headers: { ...base, host: `127.0.0.1:${port}` } })).status,
    ).toBe(405);
    expect(
      (
        await raw(url.replace("/mcp", "/other"), {
          headers: { ...base, host: `127.0.0.1:${port}` },
          body: INIT,
        })
      ).status,
    ).toBe(404);
    const big = await raw(url, {
      headers: { ...base, host: `127.0.0.1:${port}` },
      body: Buffer.alloc(1024 * 1024 + 10, 0x20),
    });
    expect([0, 413]).toContain(big.status);
    expect(
      (await raw(url, { headers: { ...base, host: `127.0.0.1:${port}` }, body: "{not json" })).status,
    ).toBe(400);
  });

  it("drops a tool result when the run ended while the tool was working", async () => {
    let release!: () => void;
    const started = new Promise<void>((r) => (release = r));
    let finish!: () => void;
    const gate = new Promise<void>((r) => (finish = r));
    const { svc, tokens, issue } = setup({
      runSkill: async () => {
        release();
        await gate;
        return { ok: true, output: { secret: "should not arrive" } };
      },
    });
    const { url } = await svc.endpoint();
    const client = await connect(url, issue());
    const call = client.callTool({ name: "skill_selftest", arguments: { text: "hi" } });
    await started;
    tokens.revokeRun("r1");
    finish();
    const r = (await call) as { isError?: boolean };
    expect(r.isError).toBe(true);
    expect(textOf(r)).toEqual({ error: "unauthorized" });
  });

  it("a skill runs with the calling token's own scope (user, conversation, run)", async () => {
    const scopes: unknown[] = [];
    const { svc, issue } = setup({
      users: [
        { id: "u-mom", name: "엄마", active: true },
        { id: "u-son", name: "아들", active: true },
      ],
      runSkill: async (_s, _i, scope) => {
        scopes.push(scope);
        return { ok: true, output: {} };
      },
    });
    const { url } = await svc.endpoint();
    await (
      await connect(url, issue("u-son", "r2", "c2"))
    ).callTool({ name: "skill_selftest", arguments: { text: "a" } });
    await (
      await connect(url, issue("u-mom", "r1", "c1"))
    ).callTool({ name: "skill_selftest", arguments: { text: "b" } });
    expect(scopes).toEqual([
      { userId: "u-son", conversationId: "c2", runId: "r2" },
      { userId: "u-mom", conversationId: "c1", runId: "r1" },
    ]);
  });

  it("caps concurrent skill processes per run and in total; refused calls never start one", async () => {
    let running = 0;
    let release!: () => void;
    let gate = new Promise<void>((r) => (release = r));
    const { svc, issue } = setup({
      concurrency: { total: 3, perRun: 2 },
      runSkill: async () => {
        running++;
        await gate;
        running--;
        return { ok: true, output: { done: true } };
      },
    });
    const { url } = await svc.endpoint();
    const r1 = await connect(url, issue("u-mom", "r1"));
    const r2 = await connect(url, issue("u-mom", "r2", "c2"));
    const call = (c: Client) =>
      c.callTool({ name: "skill_selftest", arguments: { text: "x" } }) as Promise<unknown>;
    const busy = (r: unknown) =>
      (r as { isError?: boolean }).isError === true && textOf(r).error === "skill_busy";
    const first = [call(r1), call(r1)];
    for (let i = 0; running < 2; i++) {
      if (i === 100) throw new Error(`stuck at running=${running}`);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(busy(await call(r1))).toBe(true); // per run
    const third = call(r2);
    for (let i = 0; running < 3; i++) {
      if (i === 100) throw new Error(`stuck at running=${running} (2)`);
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(busy(await call(r2))).toBe(true); // total
    expect(running).toBe(3);
    release();
    for (const r of await Promise.all([...first, third])) expect(textOf(r)).toEqual({ done: true });
    gate = new Promise<void>((r) => (release = r));
    release();
    expect(textOf(await call(r1))).toEqual({ done: true }); // slots are given back
  });

  it("skill policy: its own folder only, no node install folder, no writes, no network", () => {
    const p = skillPolicy(SELFTEST_SKILL, { text: "x" }, { node: "/opt/node/bin/node" });
    expect(p).toMatchObject({
      command: "/opt/node/bin/node",
      args: [SELFTEST_SKILL.entry],
      read: [SELFTEST_SKILL.dir],
      trusted: [],
      write: [],
      network: "none",
      env: {},
    });
  });

  it("validates skill input before starting the skill", async () => {
    let calls = 0;
    const { svc, issue } = setup({
      runSkill: async () => {
        calls++;
        return { ok: true, output: {} };
      },
    });
    const client = await connect((await svc.endpoint()).url, issue());
    const r = (await client.callTool({ name: "skill_selftest", arguments: { text: "x".repeat(2001) } })) as {
      isError?: boolean;
    };
    expect(r.isError).toBe(true);
    expect(calls).toBe(0);
  });

  describe.skipIf(!isMac)("verification skill through the allow-listed sandbox path (macOS)", () => {
    it("runs sandboxed and returns its result", async () => {
      const { svc, issue } = setup();
      const client = await connect((await svc.endpoint()).url, issue());
      const text = "가족 비서 테스트 ✓";
      const r = textOf(await client.callTool({ name: "skill_selftest", arguments: { text } }));
      expect(r).toEqual({
        characters: [...text].length,
        sha256: crypto.createHash("sha256").update(text).digest("hex"),
        reversed: [...text].reverse().join(""),
      });
    });

    it("the sandboxed skill cannot read outside its folder, open the network or start processes", async () => {
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "skill-"));
      closers.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
      fs.writeFileSync(path.join(dir, "secret.txt"), "OUTSIDE");
      const probe = (code: string) => {
        const sd = fs.mkdtempSync(path.join(dir, "s-"));
        const entry = path.join(sd, "main.mjs");
        fs.writeFileSync(entry, code);
        return sandboxedSkillRunner()(
          { ...SELFTEST_SKILL, dir: sd, entry },
          {},
          {
            userId: "u",
            conversationId: "c",
            runId: "r",
          },
        );
      };
      const out = async (code: string) => {
        const r = await probe(code);
        return r.ok ? (r.output as { r: string }).r : r.code;
      };
      const secret = JSON.stringify(path.join(dir, "secret.txt"));
      expect(
        await out(
          `import fs from "node:fs";let r;try{r=fs.readFileSync(${secret},"utf8")}catch(e){r="ERR "+e.code}process.stdout.write(JSON.stringify({r}))`,
        ),
      ).toMatch(/^ERR/);
      // A server that really answers: reachable from here, not from the skill.
      const target = http.createServer((_q, res) => res.end("OPEN"));
      await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
      closers.push(() => new Promise((r) => target.close(r)));
      const tport = (target.address() as import("node:net").AddressInfo).port;
      expect(await (await fetch(`http://127.0.0.1:${tport}/`)).text()).toBe("OPEN");
      expect(
        await out(
          `fetch("http://127.0.0.1:${tport}/").then(r=>r.text(),e=>"ERR "+(e.cause?.code??e.message)).then(r=>process.stdout.write(JSON.stringify({r})))`,
        ),
      ).toMatch(/^ERR/);
      // node's own install folder is not readable (only the executable itself).
      const nodeHome = path.dirname(path.dirname(fs.realpathSync(process.execPath)));
      const readme = fs.readdirSync(nodeHome).find((n) => fs.statSync(path.join(nodeHome, n)).isFile());
      if (readme) {
        const file = JSON.stringify(path.join(nodeHome, readme));
        expect(fs.readFileSync(path.join(nodeHome, readme)).length).toBeGreaterThan(0);
        expect(
          await out(
            `import fs from "node:fs";let r;try{fs.readFileSync(${file});r="READ"}catch(e){r="ERR "+e.code}process.stdout.write(JSON.stringify({r}))`,
          ),
        ).toMatch(/^ERR/);
      }
      expect(
        await out(
          `import cp from "node:child_process";let r;try{cp.execFileSync("/bin/echo",["x"]);r="SPAWNED"}catch(e){r="ERR "+(e.code??e.message)}process.stdout.write(JSON.stringify({r}))`,
        ),
      ).toMatch(/^ERR/);
      expect(await out(`process.stdout.write("not json")`)).toBe("skill_bad_output");
      expect(await out(`process.exit(3)`)).toBe("skill_failed");
    });
  });

  describe.skipIf(isMac)("verification skill elsewhere", () => {
    it("fails closed without the macOS sandbox", async () => {
      const { svc, issue } = setup();
      const client = await connect((await svc.endpoint()).url, issue());
      const r = (await client.callTool({ name: "skill_selftest", arguments: { text: "x" } })) as {
        isError?: boolean;
      };
      expect(r.isError).toBe(true);
      expect(textOf(r)).toEqual({ error: "skill_unavailable" });
    });
  });

  it("close() stops the server and later endpoint() calls fail", async () => {
    const { svc, issue } = setup();
    const { url } = await svc.endpoint();
    await svc.close();
    await expect(connect(url, issue())).rejects.toThrow();
    await expect(svc.endpoint()).rejects.toThrow(/closed/);
  });
});

describe("runtime connection settings (#43, used by #15/#16)", () => {
  const mcp = { url: "http://127.0.0.1:43123/mcp", token: "tok-abc" };
  it("Claude: our server over HTTP with the run token as bearer", () => {
    const o = claudeLockdown({ cwd: "/srv/w", env: {}, mcp, tools: [] });
    expect(o.mcpServers).toEqual({
      agentlee: { type: "http", url: mcp.url, headers: { Authorization: "Bearer tok-abc" } },
    });
  });
  it("Codex: URL in config.toml, token only in the environment", () => {
    const toml = codexRunConfig({ model: "m", mcp, tools: ["echo_time"] }).join("\n");
    expect(toml).toContain(`url = "${mcp.url}"`);
    expect(toml).toContain('bearer_token_env_var = "AGENTLEE_MCP_TOKEN"');
    expect(toml).not.toContain("tok-abc");
    expect(codexMcpEnv(mcp)).toEqual({ AGENTLEE_MCP_TOKEN: "tok-abc" });
  });
  it("the sandbox opens exactly our loopback port; anything but 127.0.0.1 is refused", () => {
    expect(mcpLoopbackPort(mcp)).toBe(43123);
    for (const url of [
      "http://localhost:1/mcp",
      "http://10.0.0.1:1/mcp",
      "https://127.0.0.1:1/mcp",
      "http://127.0.0.1/mcp",
    ])
      expect(() => mcpLoopbackPort({ url, token: "t" }), url).toThrow();
    expect(() =>
      claudeLockdown({ cwd: "/", env: {}, mcp: { url: "http://evil.example:1/mcp", token: "t" }, tools: [] }),
    ).toThrow();
  });
});

/** A runtime that, like the real ones, calls our MCP server during its turn. */
class ToolCallingRuntime implements RuntimeAdapter {
  readonly id = "claude-code" as const;
  contexts: StartContext[] = [];
  constructor(private readonly usesTools = true) {}
  capabilities() {
    return {
      models: [{ id: "m", label: "M", efforts: [] }],
      canSwitchModelInSession: false,
      canResume: false,
      usesTools: this.usesTools,
    };
  }
  async start(ctx: StartContext): Promise<RuntimeSession> {
    this.contexts.push(ctx);
    return {
      externalSessionId: `tc-${crypto.randomUUID()}`,
      setModel: async () => {},
      close: async () => {},
      turn: () => ({
        interrupt: async () => {},
        events: (async function* (): AsyncGenerator<RuntimeEvent> {
          if (!ctx.mcp) {
            yield { type: "text_delta", text: "no tools" };
            return;
          }
          const client = await connect(ctx.mcp.url, ctx.mcp.token);
          yield { type: "tool_start", callId: "1", name: "echo_time" };
          const r = textOf(await client.callTool({ name: "echo_time", arguments: {} }));
          yield { type: "tool_end", callId: "1", output: r };
          yield { type: "text_delta", text: `안녕하세요 ${String(r.userName)}님` };
        })(),
      }),
    };
  }
  resume(): Promise<RuntimeSession> {
    throw new Error("no resume");
  }
}

describe("runs give runtimes our MCP server (#43)", () => {
  async function run(adapter: ToolCallingRuntime) {
    const runtimes = new RuntimeRegistry();
    runtimes.register(adapter);
    const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
      db: createTestDb(),
      logger: false,
      runtimes,
      runs: { flushMs: 0 },
    });
    closers.push(() => app.close());
    const f = await createFamily(app);
    const conv = app.conversations!.create(f.users.owner.id);
    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conv.id}/messages`,
      headers: {
        host: "localhost:3000",
        cookie: f.cookies.owner,
        origin: "http://localhost:3000",
        [CSRF_HEADER]: "1",
        "content-type": "application/json",
      },
      payload: { text: "몇 시야?" },
    });
    expect(res.statusCode).toBe(201);
    const runId = res.json<{ run: Run }>().run.id;
    let r: Run | undefined;
    for (let i = 0; i < 400; i++) {
      r = app.runs!.get(runId) as unknown as Run;
      if (r?.endedAt) break;
      await new Promise((x) => setTimeout(x, 10));
    }
    const messages = app.conversations!.messagePage(conv.id, { limit: 10 }).items;
    return { app, f, run: r!, reply: messages.at(-1)! };
  }

  it("a run's runtime calls echo_time with its token; the token dies with the run", async () => {
    const adapter = new ToolCallingRuntime();
    const { app, reply } = await run(adapter);
    expect(JSON.stringify(reply.parts)).toContain("안녕하세요 owner님");
    const ctx = adapter.contexts[0]!;
    expect(ctx.tools).toEqual(["echo_time", "skill_selftest"]);
    expect(ctx.mcp!.url).toBe((await app.mcp!.endpoint()).url);
    await expect(connect(ctx.mcp!.url, ctx.mcp!.token)).rejects.toThrow(); // revoked when the run finished
  });

  it("runtimes that use no tools get neither tools nor a token, and no MCP port is opened", async () => {
    const adapter = new ToolCallingRuntime(false);
    const { app, reply } = await run(adapter);
    expect(JSON.stringify(reply.parts)).toContain("no tools");
    expect(adapter.contexts[0]!.tools).toEqual([]);
    expect(adapter.contexts[0]!.mcp).toBeUndefined();
    expect(app.runs!.mcpTokens.size()).toBe(0);
    expect(app.mcp!.started).toBe(false);
  });
});
