import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  RuntimeFailure,
  SessionGoneError,
  type RuntimeEvent,
  type StartContext,
} from "../src/runtime/adapter.js";
import { ClaudeAdapter, claudeEnv, type ClaudeAuth } from "../src/runtime/claude.js";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { claudeConnectionFor } from "../src/runtime/claude-config.js";
import { UserStore } from "../src/auth/users.js";
import { ConnectionStore } from "../src/connections/store.js";
import { createTestDb } from "../src/db/client.js";
import { AppEvents } from "../src/events.js";
import { runIsolated, type SpawnIsolatedOptions } from "../src/isolation/sandbox.js";
import { CLAUDE_EGRESS_HOSTS, EgressService } from "../src/isolation/egress.js";
import {
  recordingQuery,
  replayQuery,
  sdk,
  type RecordedTurn,
  type Recording,
  type ReplayLog,
} from "./helpers/claude-replay.js";
import { runtimeContract } from "./helpers/runtime-contract.js";
import recorded from "./fixtures/claude-contract.json" with { type: "json" };

const isMac = process.platform === "darwin";
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "claude-test-"));
  dirs.push(d);
  return d;
};

const KEY = "sk-ant-api03-TESTKEY-" + "x".repeat(20);
function adapter(rec: Recording, o: { auth?: ClaudeAuth; noConnection?: boolean; root?: string } = {}) {
  const root = o.root ?? tmp();
  const log: ReplayLog = { options: [], prompts: [], interrupts: 0, closes: 0 };
  const spawns: SpawnIsolatedOptions[] = [];
  const a = new ClaudeAdapter({
    connection: () =>
      o.noConnection
        ? undefined
        : { id: "c1", dir: path.join(root, "conn"), auth: o.auth ?? { kind: "api_key", apiKey: KEY } },
    query: replayQuery(rec, log),
    spawn: (s) => {
      spawns.push(s);
      throw new Error("not spawned in replay");
    },
  });
  return { a, log, spawns, root };
}

const ctx = (over: Partial<StartContext> = {}): StartContext => ({
  conversationId: "c-1",
  userId: "u-mom",
  history: [],
  systemPrompt: "You are Agent Lee.",
  model: "claude-haiku-5-5",
  tools: ["echo_time"],
  mcp: { url: "http://127.0.0.1:45678/mcp", token: "run-token-abc" },
  ...over,
});

async function collect(events: AsyncIterable<RuntimeEvent>) {
  const out: RuntimeEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

// --- Contract (#12) against recorded real-runtime events -------------------------------------------------
const contract = recorded as unknown as { prompts: Record<string, string>; recording: Recording };
runtimeContract("Claude Code (recorded)", () => adapter(contract.recording).a, {
  short: contract.prompts.short!,
  long: contract.prompts.long!,
  remember: contract.prompts.remember!,
  recall: contract.prompts.recall!,
  recallCheck: (answer) => /토마토/.test(answer),
});

describe("Claude adapter (#15): event translation", () => {
  it("turns SDK messages into our events: text, reasoning, our tools (prefix removed), usage with cache", async () => {
    const { a } = adapter({
      "몇 시야?": [
        sdk.init({ session: "s" }),
        sdk.delta("생각 중", "thinking"),
        sdk.toolUse("tu_1", "mcp__agentlee__echo_time", {}),
        sdk.toolResult("tu_1", '{"now":"2026-11-11T00:00:00Z","userName":"엄마"}'),
        sdk.delta("지금은 "),
        sdk.delta("9시예요."),
        sdk.result(),
      ],
    });
    const s = await a.start(ctx());
    const ev = await collect(s.turn({ text: "몇 시야?", model: "claude-haiku-5-5" }).events);
    expect(ev).toEqual([
      { type: "reasoning_delta", text: "생각 중" },
      { type: "tool_start", callId: "tu_1", name: "echo_time", input: {} },
      { type: "tool_end", callId: "tu_1", output: { now: "2026-11-11T00:00:00Z", userName: "엄마" } },
      { type: "text_delta", text: "지금은 " },
      { type: "text_delta", text: "9시예요." },
      {
        type: "usage",
        inputTokens: 1212,
        outputTokens: 34,
        cacheReadTokens: 1000,
        cacheWriteTokens: 200,
        costUsd: 0.0021,
      },
    ]);
  });

  it("tool errors stay tool errors", async () => {
    const { a } = adapter({
      x: [
        sdk.init({ session: "s" }),
        sdk.toolUse("t", "mcp__agentlee__skill_selftest", { text: "a" }),
        sdk.toolResult("t", "skill_busy", true),
        sdk.result(),
      ],
    });
    const ev = await collect((await a.start(ctx())).turn({ text: "x", model: "claude-haiku-5-5" }).events);
    expect(ev[1]).toEqual({ type: "tool_end", callId: "t", output: "skill_busy", isError: true });
  });

  it("a session with another MCP server, or with any tool that is not ours, is stopped at init (fail closed)", async () => {
    for (const init of [
      sdk.init({
        session: "s",
        mcp: [
          { name: "agentlee", status: "connected" },
          { name: "claude.ai Google Drive", status: "connected" },
        ],
      }),
      sdk.init({ session: "s", tools: ["mcp__agentlee__echo_time", "Bash"] }),
      sdk.init({ session: "s", tools: ["mcp__claude_ai_Gmail__search"] }),
    ]) {
      const { a } = adapter({ x: [init, sdk.delta("should not arrive"), sdk.result()] });
      const s = await a.start(ctx());
      const seen: RuntimeEvent[] = [];
      await expect(
        (async () => {
          for await (const e of s.turn({ text: "x", model: "claude-haiku-5-5" }).events) seen.push(e);
        })(),
      ).rejects.toMatchObject({ code: "runtime_policy" });
      expect(seen).toEqual([]);
    }
  });

  it("usage limits end the turn as a limit; login problems fail as runtime_auth; other errors fail", async () => {
    const run = async (msgs: SDKMessage[]) => {
      const { a } = adapter({ x: msgs });
      return collect((await a.start(ctx())).turn({ text: "x", model: "claude-haiku-5-5" }).events);
    };
    expect(await run([sdk.init({ session: "s" }), sdk.rateLimit("rejected"), sdk.result()])).toContainEqual(
      expect.objectContaining({ type: "limit" }),
    );
    expect(
      (await run([sdk.init({ session: "s" }), sdk.rateLimit("allowed"), sdk.result()])).some(
        (e) => e.type === "limit",
      ),
    ).toBe(false);
    expect(
      await run([sdk.init({ session: "s" }), sdk.assistantError("rate_limit"), sdk.result()]),
    ).toContainEqual(expect.objectContaining({ type: "limit" }));
    await expect(
      run([
        sdk.init({ session: "s" }),
        sdk.assistantError("authentication_failed"),
        sdk.result({ isError: true }),
      ]),
    ).rejects.toMatchObject({ code: "runtime_auth" });
    await expect(
      run([sdk.init({ session: "s" }), sdk.result({ isError: true, subtype: "error_during_execution" })]),
    ).rejects.toBeInstanceOf(RuntimeFailure);
    await expect(run([sdk.init({ session: "s" }), sdk.delta("cut off")])).rejects.toBeInstanceOf(
      RuntimeFailure,
    ); // no result
  });

  it("an interrupt we asked for ends the turn quietly (error_during_execution is not a failure then)", async () => {
    const { a, log } = adapter({
      long: {
        messages: [
          sdk.init({ session: "s" }),
          ...Array.from({ length: 200 }, (_, i) => sdk.delta(`w${i} `)),
          // What the runtime sends after an interrupt (spike #39): an error result for the cut-off turn.
          sdk.result({ isError: true, subtype: "error_during_execution" }),
        ],
        interruptAt: 201,
      },
    });
    const turn = (await a.start(ctx())).turn({ text: "long", model: "claude-haiku-5-5" });
    const ev: RuntimeEvent[] = [];
    for await (const e of turn.events) {
      ev.push(e);
      if (ev.length === 3) void turn.interrupt();
    }
    expect(log.interrupts).toBe(1);
    expect(ev.length).toBeLessThan(10);
  });
});

describe("Claude adapter (#15): settings it hands to the SDK", () => {
  it("locked down: no built-ins, no settings files, only our MCP server with the run token, hook allows only ours", async () => {
    const { a, log, root } = adapter({ x: sdk.answer("s", "ok") });
    const s = await a.start(ctx());
    await collect(s.turn({ text: "x", model: "claude-haiku-5-5", effort: "low" }).events);
    const o = log.options[0]! as Options & {
      hooks: { PreToolUse: { hooks: ((i: { tool_name: string }) => Promise<unknown>)[] }[] };
    };
    expect(o.tools).toEqual([]);
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.mcpServers).toEqual({
      agentlee: {
        type: "http",
        url: "http://127.0.0.1:45678/mcp",
        headers: { Authorization: "Bearer run-token-abc" },
      },
    });
    expect(o.model).toBe("claude-haiku-5-5");
    expect(o.effort).toBe("low");
    expect(o.sessionId).toBe(s.externalSessionId);
    expect(o.includePartialMessages).toBe(true);
    const hook = o.hooks.PreToolUse[0]!.hooks[0]!;
    expect(await hook({ tool_name: "Bash" })).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    });
    expect(
      await hook({
        tool_name: "mcp__agentlee__echo_time",
        mcp_server: { name: "agentlee", source: "dynamic" },
      } as never),
    ).toMatchObject({
      hookSpecificOutput: { permissionDecision: "allow" },
    });
    // Environment: only ours, the credential only here, every folder inside the connection folder.
    const env = o.env as Record<string, string>;
    expect(Object.keys(env).sort()).toEqual(
      Object.keys(claudeEnv({ id: "c1", dir: "/x", auth: { kind: "api_key", apiKey: "k" } })).sort(),
    );
    expect(env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    for (const k of ["HOME", "TMPDIR", "CLAUDE_CODE_TMPDIR", "CLAUDE_CONFIG_DIR"])
      expect(env[k]!.startsWith(path.join(root, "conn"))).toBe(true);
    for (const k of Object.keys(process.env)) if (!(k in env)) expect(env[k]).toBeUndefined();
  });

  it("subscription token goes in CLAUDE_CODE_OAUTH_TOKEN; no MCP server when the run has none", async () => {
    const { a, log } = adapter(
      { x: sdk.answer("s", "ok") },
      { auth: { kind: "oauth_token", token: "oat-123" } },
    );
    await collect(
      (await a.start(ctx({ mcp: undefined, tools: [] }))).turn({ text: "x", model: "claude-haiku-5-5" })
        .events,
    );
    const env = log.options[0]!.env as Record<string, string>;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oat-123");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(log.options[0]!.mcpServers).toEqual({});
  });

  it("the CLI process is spawned sandboxed: its connection folder only, HTTPS + our MCP port, no other network", async () => {
    const { a, log, spawns, root } = adapter({ x: sdk.answer("s", "ok") });
    await collect((await a.start(ctx())).turn({ text: "x", model: "claude-haiku-5-5" }).events);
    const bin = path.join(root, "claude-bin");
    fs.writeFileSync(bin, "");
    expect(() =>
      log.options[0]!.spawnClaudeCodeProcess!({
        command: bin,
        args: ["--x"],
        env: {},
        signal: new AbortController().signal,
      } as never),
    ).toThrow(/not spawned/);
    expect(spawns[0]).toMatchObject({
      command: bin,
      args: ["--x"],
      read: [path.join(root, "conn")],
      write: [path.join(root, "conn")],
      network: { loopbackPorts: [45678] },
      env: log.options[0]!.env,
    });
    expect(spawns[0]!.trusted ?? []).toEqual([]);
  });

  it("history goes into a fresh session's system prompt only", async () => {
    const { a, log } = adapter({ x: sdk.answer("s", "ok"), y: sdk.answer("s", "ok") });
    const history = [{ role: "user" as const, parts: [{ type: "text" as const, text: "내 이름은 토마토" }] }];
    const s = await a.start(ctx({ history }));
    await collect(s.turn({ text: "x", model: "claude-haiku-5-5" }).events);
    expect(log.options[0]!.systemPrompt).toContain("내 이름은 토마토");
    const s2 = await a.resume(s.externalSessionId, ctx({ history }));
    await collect(s2.turn({ text: "y", model: "claude-haiku-5-5" }).events);
    expect(log.options[1]!.resume).toBe(s.externalSessionId);
    // A resume sends exactly the prompt the session started with (history included once, not re-derived).
    expect(log.options[1]!.systemPrompt).toBe(log.options[0]!.systemPrompt);
  });

  it("prompts go verbatim (no @file expansion, no slash commands)", async () => {
    const { a, log } = adapter({ "@../secret.txt /login": sdk.answer("s", "ok") });
    await collect(
      (await a.start(ctx())).turn({ text: "@../secret.txt /login", model: "claude-haiku-5-5" }).events,
    );
    expect(log.options[0]!.verbatimPrompts).toBe(true);
  });

  it("reports per-turn cost although the SDK's total runs on across resumes", async () => {
    const withCost = (session: string, total: number): SDKMessage[] => [
      sdk.init({ session }),
      sdk.delta("ok"),
      { ...(sdk.result() as object), total_cost_usd: total } as SDKMessage,
    ];
    const { a } = adapter({ one: withCost("s", 1), two: withCost("s", 1.25) });
    const s1 = await a.start(ctx());
    const c1 = (await collect(s1.turn({ text: "one", model: "claude-haiku-5-5" }).events)).find(
      (e) => e.type === "usage",
    );
    const s2 = await a.resume(s1.externalSessionId, ctx());
    const c2 = (await collect(s2.turn({ text: "two", model: "claude-haiku-5-5" }).events)).find(
      (e) => e.type === "usage",
    );
    expect(c1).toMatchObject({ costUsd: 1 });
    expect((c2 as { costUsd: number }).costUsd).toBeCloseTo(0.25, 10);
  });

  it("a usage limit stays a limit even when the runtime then reports an error result", async () => {
    const { a } = adapter({
      x: [
        sdk.init({ session: "s" }),
        sdk.assistantError("rate_limit"),
        sdk.result({ isError: true, subtype: "success" }),
      ],
    });
    const ev = await collect((await a.start(ctx())).turn({ text: "x", model: "claude-haiku-5-5" }).events);
    expect(ev.filter((e) => e.type === "limit")).toHaveLength(1);
  });

  it("a session without our saved metadata cannot be resumed (its system prompt is unknown)", async () => {
    const { a, root } = adapter({ x: sdk.answer("s", "ok") });
    const s = await a.start(ctx());
    await collect(s.turn({ text: "x", model: "claude-haiku-5-5" }).events);
    fs.rmSync(path.join(root, "conn-meta"), { recursive: true });
    await expect(a.resume(s.externalSessionId, ctx())).rejects.toBeInstanceOf(SessionGoneError);
  });

  it("the CLI gets the SDK's own non-secret variables, the proxy, and nothing from the server's environment", async () => {
    const root = tmp();
    const log: ReplayLog = { options: [], prompts: [], interrupts: 0, closes: 0 };
    const spawns: SpawnIsolatedOptions[] = [];
    const a = new ClaudeAdapter({
      connection: () => ({ id: "c1", dir: path.join(root, "conn"), auth: { kind: "api_key", apiKey: KEY } }),
      query: replayQuery({ x: sdk.answer("s", "ok") }, log),
      egress: { endpoint: async () => ({ port: 41111, url: "http://127.0.0.1:41111" }) },
      spawn: (o) => {
        spawns.push(o);
        throw new Error("not spawned");
      },
    });
    await collect((await a.start(ctx())).turn({ text: "x", model: "claude-haiku-5-5" }).events);
    const env = log.options[0]!.env as Record<string, string>;
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:41111");
    expect(() =>
      log.options[0]!.spawnClaudeCodeProcess!({
        command: process.execPath,
        args: [],
        env: {
          ...env,
          CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
          CLAUDE_AGENT_SDK_VERSION: "0.3.312",
          SECRET_FROM_SERVER: "x",
          PATH: "/evil",
        },
      } as never),
    ).toThrow();
    expect(spawns[0]!.env.CLAUDE_CODE_ENTRYPOINT).toBe("sdk-ts");
    expect(spawns[0]!.env.CLAUDE_AGENT_SDK_VERSION).toBe("0.3.312");
    expect(spawns[0]!.env.SECRET_FROM_SERVER).toBeUndefined();
    expect(spawns[0]!.env.PATH).toBe("/usr/bin:/bin");
    expect(spawns[0]!.network).toEqual({ loopbackPorts: [45678, 41111] });
  });

  it("refuses unknown models and effort values the model does not take; no connection → no_connection", async () => {
    const { a } = adapter({});
    await expect(a.start(ctx({ model: "gpt-x" }))).rejects.toBeInstanceOf(RuntimeFailure);
    await expect(a.start(ctx({ effort: "max" }))).rejects.toBeInstanceOf(RuntimeFailure); // haiku: low..high
    const s = await a.start(ctx());
    expect(() => s.turn({ text: "x", model: "claude-haiku-5-5", effort: "ultra" })).toThrow(RuntimeFailure);
    await expect(adapter({}, { noConnection: true }).a.start(ctx())).rejects.toMatchObject({
      code: "no_connection",
    });
  });

  it("resuming a session the runtime does not have is SessionGoneError", async () => {
    const { a } = adapter({});
    await expect(a.resume("00000000-0000-4000-8000-000000000000", ctx())).rejects.toBeInstanceOf(
      SessionGoneError,
    );
    await expect(a.resume("../../etc/passwd", ctx())).rejects.toBeInstanceOf(SessionGoneError);
  });
});

// --- The real CLI under the real sandbox (macOS) -------------------------------------------------------
const realBin = (() => {
  try {
    const pkg = path.dirname(
      fs.realpathSync(
        path.join(import.meta.dirname, "../node_modules/@anthropic-ai/claude-agent-sdk/package.json"),
      ),
    );
    const bin = path.join(
      path.dirname(pkg),
      `claude-agent-sdk-${process.platform}-${process.arch}`,
      "claude",
    );
    return fs.existsSync(bin) ? bin : undefined;
  } catch {
    return undefined;
  }
})();
// Needs to reach api.anthropic.com (an invalid key is enough: the API answers 401).
const online =
  isMac && realBin && spawnSync("/usr/bin/nc", ["-z", "-G", "3", "api.anthropic.com", "443"]).status === 0;

describe.skipIf(!isMac || !realBin)("Claude adapter (#15): real CLI in the sandbox (macOS)", () => {
  it.skipIf(!online)(
    "starts without forking, reaches the API only through the egress proxy, a bad key fails as runtime_auth, and the key is never written",
    async () => {
      const root = tmp();
      const connects: string[] = [];
      const egress = new EgressService({
        allow: CLAUDE_EGRESS_HOSTS,
        connect: (ip, port) => {
          connects.push(`${ip}:${port}`);
          return net.connect({ host: ip, port });
        },
      });
      const a = new ClaudeAdapter({
        connection: () => ({ id: "t", dir: path.join(root, "conn"), auth: { kind: "api_key", apiKey: KEY } }),
        egress,
      });
      const s = await a.start(ctx({ mcp: undefined, tools: [] }));
      await expect(collect(s.turn({ text: "hi", model: "claude-haiku-5-5" }).events)).rejects.toMatchObject({
        code: "runtime_auth",
      });
      await s.close();
      await egress.close();
      expect(connects.length).toBeGreaterThan(0); // the API was reached — through the proxy
      const hits: string[] = [];
      const walk = (d: string) => {
        for (const n of fs.readdirSync(d)) {
          const p = path.join(d, n);
          const st = fs.lstatSync(p);
          if (st.isDirectory()) walk(p);
          else if (st.isFile() && fs.readFileSync(p).includes("TESTKEY")) hits.push(p);
        }
      };
      walk(root);
      expect(fs.existsSync(path.join(root, "conn", "config", ".claude.json"))).toBe(true); // it did run
      expect(hits).toEqual([]);
    },
    60_000,
  );

  it.skipIf(!online)(
    "@file in a prompt is not expanded by the real CLI (nothing of the file reaches the session)",
    async () => {
      const root = tmp();
      const egress = new EgressService({ allow: CLAUDE_EGRESS_HOSTS });
      const conn = path.join(root, "conn");
      const a = new ClaudeAdapter({
        connection: () => ({ id: "t", dir: conn, auth: { kind: "api_key", apiKey: KEY } }),
        egress,
      });
      const s = await a.start(ctx({ mcp: undefined, tools: [] }));
      // Inside the CLI's own folder (so the sandbox would allow the read): only verbatim delivery stops it.
      fs.mkdirSync(conn, { recursive: true });
      fs.writeFileSync(path.join(conn, "other-person.txt"), "OTHER-PERSON-MARKER");
      await collect(
        s.turn({ text: "@../other-person.txt summarise", model: "claude-haiku-5-5" }).events,
      ).catch(() => {});
      await s.close();
      await egress.close();
      const found: string[] = [];
      const walk = (d: string) => {
        for (const n of fs.readdirSync(d)) {
          const p = path.join(d, n);
          const st = fs.lstatSync(p);
          if (st.isDirectory()) walk(p);
          else if (
            st.isFile() &&
            n !== "other-person.txt" &&
            fs.readFileSync(p).includes("OTHER-PERSON-MARKER")
          )
            found.push(p);
        }
      };
      walk(conn);
      expect(found).toEqual([]);
    },
    60_000,
  );

  it("its sandbox: a marker in the real home, another family member's folder and child processes are out of reach", async () => {
    const { a, log, spawns, root } = adapter({ x: sdk.answer("s", "ok") });
    await collect((await a.start(ctx())).turn({ text: "x", model: "claude-haiku-5-5" }).events);
    try {
      log.options[0]!.spawnClaudeCodeProcess!({ command: process.execPath, args: [], env: {} } as never);
    } catch {
      /* captured below */
    }
    const policy = spawns[0]!;
    const fakeHome = path.join(root, "real-home");
    fs.mkdirSync(path.join(fakeHome, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, ".claude", "MARKER"), "HOME-MARKER");
    const probe = async (code: string) =>
      (
        await runIsolated({
          ...policy,
          args: ["-e", code],
          cwd: path.join(root, "conn"),
          timeoutMs: 8000,
          maxOutputBytes: 10_000,
        })
      ).stdout;
    const marker = JSON.stringify(path.join(fakeHome, ".claude", "MARKER"));
    expect(
      await probe(
        `try{process.stdout.write(require("fs").readFileSync(${marker},"utf8"))}catch(e){process.stdout.write("ERR "+e.code)}`,
      ),
    ).toMatch(/^ERR/);
    expect(
      await probe(
        `try{const c=require("child_process").spawn("/bin/echo",["x"]);c.on("error",e=>process.stdout.write("ERR "+e.code));c.on("spawn",()=>process.stdout.write("SPAWNED"))}catch(e){process.stdout.write("ERR "+e.code)}`,
      ),
    ).toMatch(/^ERR/);
    // Inside its own folder it works (control).
    fs.writeFileSync(path.join(root, "conn", "own.txt"), "OWN");
    expect(
      await probe(
        `process.stdout.write(require("fs").readFileSync(${JSON.stringify(path.join(root, "conn", "own.txt"))},"utf8"))`,
      ),
    ).toBe("OWN");
  });
});

describe("Claude connection from the database (#17)", () => {
  function setup() {
    const db = createTestDb();
    const users = new UserStore(db, new AppEvents());
    const store = new ConnectionStore(db, crypto.randomBytes(32), "/data");
    const mk = (email: string, role: "admin" | "member") =>
      users.create({ email, name: email, role, passwordHash: "x" });
    const pass = (id: string) => store.setTestResult(id, "passed", "ok", store.get(id)!.credentialVersion);
    return { db, users, store, mk, pass };
  }
  const apiKey = `sk-ant-${"a".repeat(30)}`;
  const token = `sk-ant-oat01-${"t".repeat(30)}`;

  it("the admin's own subscription for the admin; the shared API key for everyone, a folder per user", () => {
    const { users, store, mk, pass } = setup();
    const admin = mk("admin@family.test", "admin");
    const son = mk("son@family.test", "member");
    const sub = store.create({
      runtime: "claude-code",
      authType: "subscription",
      scope: "personal",
      owner: admin,
      createdBy: admin.id,
      secret: token,
    });
    const shared = store.create({
      runtime: "claude-code",
      authType: "api_key",
      scope: "shared",
      owner: null,
      createdBy: admin.id,
      secret: apiKey,
    });
    pass(sub.id);
    pass(shared.id);
    const ask = (userId: string, connectionId: string) =>
      claudeConnectionFor(store, users, { userId, connectionId });
    expect(ask(admin.id, sub.id)).toMatchObject({ id: sub.id, auth: { kind: "oauth_token", token } });
    // Someone else's personal subscription: never.
    expect(ask(son.id, sub.id)).toBeUndefined();
    const a = ask(admin.id, shared.id)!;
    const b = ask(son.id, shared.id)!;
    expect(b).toMatchObject({
      auth: { kind: "api_key", apiKey },
      dir: `/data/runtimes/${shared.id}/${son.id}`,
    });
    expect(a.id).toBe(b.id);
    expect(path.relative(a.dir, b.dir).startsWith("..")).toBe(true);
    expect(path.relative(b.dir, a.dir).startsWith("..")).toBe(true);
  });

  it("a subscription stops working when its owner is no longer an admin; inactive users never", () => {
    const { users, store, mk, pass } = setup();
    const admin = mk("admin@family.test", "admin");
    mk("admin2@family.test", "admin");
    const sub = store.create({
      runtime: "claude-code",
      authType: "subscription",
      scope: "personal",
      owner: admin,
      createdBy: admin.id,
      secret: token,
    });
    pass(sub.id);
    users.setRole(admin.id, "member");
    expect(claudeConnectionFor(store, users, { userId: admin.id, connectionId: sub.id })).toBeUndefined();
    users.setRole(admin.id, "admin");
    users.deactivate(admin.id);
    expect(claudeConnectionFor(store, users, { userId: admin.id, connectionId: sub.id })).toBeUndefined();
    expect(claudeConnectionFor(store, users, { userId: "nobody", connectionId: sub.id })).toBeUndefined();
  });
});

// Recorded with the real runtime and our MCP server (test/record-claude.ts); absent until recorded once.
const toolsFixture = path.join(import.meta.dirname, "fixtures", "claude-tools.json");
describe.skipIf(!fs.existsSync(toolsFixture))(
  "Claude adapter (#15): our MCP tools through the recorded runtime",
  () => {
    it("echo_time and the verification skill come out as common tool events", async () => {
      const f = JSON.parse(fs.readFileSync(toolsFixture, "utf8")) as { prompt: string; recording: Recording };
      const { a } = adapter(f.recording);
      const ev = await collect(
        (await a.start(ctx())).turn({ text: f.prompt, model: "claude-haiku-5-5" }).events,
      );
      const starts = ev.filter((e) => e.type === "tool_start").map((e) => (e as { name: string }).name);
      expect(starts).toEqual(expect.arrayContaining(["echo_time", "skill_selftest"]));
      const ends = ev.filter((e) => e.type === "tool_end");
      expect(ends.length).toBe(starts.length);
      expect(ends.some((e) => JSON.stringify(e).includes("userName"))).toBe(true);
      expect(ends.some((e) => JSON.stringify(e).includes("sha256"))).toBe(true);
    });
  },
);

describe("recording helper (review #80): turns are kept however they end, and replay as recorded", () => {
  it("normal end (adapter returns after result), interrupt point and SDK error are all recorded", async () => {
    const source: Recording = {
      ok: sdk.answer("s", "one two"),
      cut: {
        messages: [
          sdk.init({ session: "s" }),
          ...Array.from({ length: 50 }, (_, i) => sdk.delta(`w${i} `)),
          sdk.delta("tail after interrupt "),
        ],
        interruptAt: 51,
        thrown: "Claude Code process aborted by user",
      },
    };
    const fakeReal = replayQuery(source, { options: [], prompts: [], interrupts: 0, closes: 0 });
    const rec: Recording = {};
    const root = tmp();
    const a = new ClaudeAdapter({
      connection: () => ({ id: "c", dir: path.join(root, "conn"), auth: { kind: "api_key", apiKey: KEY } }),
      query: recordingQuery(fakeReal, rec),
    });
    await collect((await a.start(ctx())).turn({ text: "ok", model: "claude-haiku-5-5" }).events);
    const turn = (await a.start(ctx())).turn({ text: "cut", model: "claude-haiku-5-5" });
    let n = 0;
    await expect(
      (async () => {
        for await (const e of turn.events) if (e.type === "text_delta" && ++n === 3) void turn.interrupt();
      })(),
    ).rejects.toThrow(/aborted/);
    const ok = rec.ok as RecordedTurn;
    expect(ok.messages.at(-1)).toMatchObject({ type: "result" }); // stored although the adapter returned early
    const cut = rec.cut as RecordedTurn;
    expect(cut.interruptAt).toBeGreaterThan(0);
    expect(cut.interruptAt).toBeLessThan(10);
    expect(cut.thrown).toBe("Claude Code process aborted by user");
    // The real tail after the interrupt, not an invented ending.
    expect(JSON.stringify(cut.messages.at(-1))).toContain("tail after interrupt");
    // Replaying the recording behaves the same.
    const again = adapter(rec).a;
    const t2 = (await again.start(ctx())).turn({ text: "cut", model: "claude-haiku-5-5" });
    let m = 0;
    await expect(
      (async () => {
        for await (const e of t2.events) if (e.type === "text_delta" && ++m === 2) void t2.interrupt();
      })(),
    ).rejects.toThrow(/aborted/);
  });

  it("a turn recorded without an interrupt refuses to be interrupted in replay (no invented endings)", async () => {
    const { a } = adapter({ x: sdk.answer("s", "a b c d e f g h i j k l m n o p") });
    const t = (await a.start(ctx())).turn({ text: "x", model: "claude-haiku-5-5" });
    await expect(
      (async () => {
        for await (const e of t.events) if (e.type === "text_delta") void t.interrupt();
      })(),
    ).rejects.toThrow(/not interrupted/);
  });
});

describe("review #80 round 2", () => {
  it("a tool call from an MCP server that joined after init stops the turn (runtime_policy)", async () => {
    const { a, log } = adapter({
      x: {
        messages: [
          sdk.init({ session: "s" }),
          ...Array.from({ length: 40 }, (_, i) => sdk.delta(`w${i} `)),
          sdk.result(),
        ],
        interruptAt: 41,
      },
    });
    const turn = (await a.start(ctx())).turn({ text: "x", model: "claude-haiku-5-5" });
    const hook = (
      log.options[0] as unknown as {
        hooks: {
          PreToolUse: {
            hooks: ((i: unknown) => Promise<{ hookSpecificOutput: { permissionDecision: string } }>)[];
          }[];
        };
      }
    ).hooks.PreToolUse[0]!.hooks[0]!;
    let n = 0;
    await expect(
      (async () => {
        for await (const e of turn.events)
          if (e.type === "text_delta" && ++n === 2) {
            const r = await hook({
              tool_name: "mcp__claude_ai_Gmail__search",
              mcp_server: { name: "claude.ai Gmail", source: "claudeai" },
            });
            expect(r.hookSpecificOutput.permissionDecision).toBe("deny");
          }
      })(),
    ).rejects.toMatchObject({ code: "runtime_policy" });
    expect(log.interrupts).toBe(1);
  });

  it("our own tools do not trip the stop", async () => {
    const { a, log } = adapter({ x: sdk.answer("s", "a b c d e f") });
    const turn = (await a.start(ctx())).turn({ text: "x", model: "claude-haiku-5-5" });
    const hook = (
      log.options[0] as unknown as {
        hooks: { PreToolUse: { hooks: ((i: unknown) => Promise<unknown>)[] }[] };
      }
    ).hooks.PreToolUse[0]!.hooks[0]!;
    await hook({
      tool_name: "mcp__agentlee__echo_time",
      mcp_server: { name: "agentlee", source: "dynamic" },
    });
    await expect(collect(turn.events)).resolves.toBeDefined();
    expect(log.interrupts).toBe(0);
  });

  it("recording keeps reading after the adapter returns: an error result followed by an SDK exception is all recorded", async () => {
    const source: Recording = {
      cut: {
        messages: [
          sdk.init({ session: "s" }),
          ...Array.from({ length: 20 }, (_, i) => sdk.delta(`w${i} `)),
          {
            ...(sdk.result({ isError: true, subtype: "error_during_execution" }) as object),
            total_cost_usd: 7,
          } as SDKMessage,
        ],
        interruptAt: 21,
        thrown: "Claude Code process aborted by user",
      },
    };
    const rec: Recording = {};
    const pending: Promise<unknown>[] = [];
    const root = tmp();
    const a = new ClaudeAdapter({
      connection: () => ({ id: "c", dir: path.join(root, "conn"), auth: { kind: "api_key", apiKey: KEY } }),
      query: recordingQuery(
        replayQuery(source, { options: [], prompts: [], interrupts: 0, closes: 0 }),
        rec,
        pending,
      ),
    });
    const turn = (await a.start(ctx())).turn({ text: "cut", model: "claude-haiku-5-5" });
    let n = 0;
    const ev: RuntimeEvent[] = [];
    for await (const e of turn.events) {
      ev.push(e);
      if (e.type === "text_delta" && ++n === 3) void turn.interrupt();
    }
    await Promise.all(pending);
    const cut = rec.cut as RecordedTurn;
    expect(cut.messages.at(-1)).toMatchObject({ type: "result", total_cost_usd: 7 });
    expect(cut.thrown).toBe("Claude Code process aborted by user");
    expect(ev.find((e) => e.type === "usage")).toMatchObject({ costUsd: 7 });
  });
});

describe("Claude adapter: a cancel while the session opens or runs (#17 review round 2)", () => {
  it("a cancel during the slow start writes nothing into the folder and starts no CLI", async () => {
    const root = tmp();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let queries = 0;
    const a = new ClaudeAdapter({
      connection: () => ({ id: "c1", dir: path.join(root, "conn"), auth: { kind: "api_key", apiKey: KEY } }),
      egress: { endpoint: async () => (await gate, { port: 1, url: "http://127.0.0.1:1" }) },
      query: (() => {
        queries++;
        throw new Error("no query expected");
      }) as never,
    });
    const abort = new AbortController();
    const starting = a.start(ctx({ signal: abort.signal }));
    await new Promise((r) => setTimeout(r, 10));
    abort.abort();
    fs.rmSync(path.join(root, "conn"), { recursive: true, force: true }); // what the disconnect does
    release();
    await expect(starting).rejects.toThrow();
    expect(queries).toBe(0);
    expect(fs.existsSync(path.join(root, "conn"))).toBe(false);
    expect(fs.existsSync(path.join(root, "conn-meta"))).toBe(false);
  });

  it("a cancel during a turn kills the CLI", async () => {
    const root = tmp();
    const kills: string[] = [];
    let exited = false;
    const a = new ClaudeAdapter({
      connection: () => ({ id: "c1", dir: path.join(root, "conn"), auth: { kind: "api_key", apiKey: KEY } }),
      spawn: () => {
        const ev = new EventEmitter();
        return Object.assign(ev, {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          killed: false,
          exitCode: null,
          kill: (sig: string) => {
            kills.push(sig);
            setTimeout(() => {
              exited = true;
              ev.emit("exit", null, sig);
            }, 20);
            return true;
          },
        }) as never;
      },
      // Like the SDK: starts the CLI through spawnClaudeCodeProcess, and close() ends the process.
      query: ((p: { options: Options }) => {
        const proc = p.options.spawnClaudeCodeProcess!({
          command: process.execPath,
          args: [],
          cwd: root,
          env: {},
          signal: new AbortController().signal,
        });
        async function* gen(): AsyncGenerator<SDKMessage> {
          yield* await new Promise<SDKMessage[]>(() => {}); // never answers
        }
        return Object.assign(gen(), {
          interrupt: async () => {},
          close: () => void proc.kill("SIGTERM"),
          setModel: async () => {},
        });
      }) as never,
    });
    const abort = new AbortController();
    const s = await a.start(ctx({ signal: abort.signal }));
    s.turn({ text: "안녕", model: "claude-haiku-5-5" });
    abort.abort();
    // The abort alone ends the CLI (the test runner closes the session afterwards, but must not have to).
    for (let i = 0; i < 100 && !exited; i++) await new Promise((r) => setTimeout(r, 5));
    expect(kills.length).toBeGreaterThanOrEqual(1);
    expect(exited).toBe(true);
    await s.close();
    expect(() => s.turn({ text: "또", model: "claude-haiku-5-5" })).toThrow();
  });

  it("close() returns only after the CLI has exited", async () => {
    const root = tmp();
    let exited = false;
    const a = new ClaudeAdapter({
      connection: () => ({ id: "c1", dir: path.join(root, "conn"), auth: { kind: "api_key", apiKey: KEY } }),
      spawn: () => {
        const ev = new EventEmitter();
        return Object.assign(ev, {
          stdin: new PassThrough(),
          stdout: new PassThrough(),
          killed: false,
          exitCode: null,
          kill: (sig: string) => {
            setTimeout(() => {
              exited = true;
              ev.emit("exit", null, sig);
            }, 20);
            return true;
          },
        }) as never;
      },
      query: ((p: { options: Options }) => {
        const proc = p.options.spawnClaudeCodeProcess!({
          command: process.execPath,
          args: [],
          cwd: root,
          env: {},
          signal: new AbortController().signal,
        });
        async function* gen(): AsyncGenerator<SDKMessage> {
          yield* await new Promise<SDKMessage[]>(() => {}); // never answers
        }
        return Object.assign(gen(), {
          interrupt: async () => {},
          close: () => void proc.kill("SIGTERM"),
          setModel: async () => {},
        });
      }) as never,
    });
    const s = await a.start(ctx());
    s.turn({ text: "안녕", model: "claude-haiku-5-5" });
    await s.close();
    expect(exited).toBe(true);
  });
});
