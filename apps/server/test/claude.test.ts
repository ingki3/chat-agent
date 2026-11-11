import { spawnSync } from "node:child_process";
import fs from "node:fs";
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
import { claudeConnectionFor } from "../src/runtime/claude-config.js";
import { runIsolated, type SpawnIsolatedOptions } from "../src/isolation/sandbox.js";
import { replayQuery, sdk, type Recording, type ReplayLog } from "./helpers/claude-replay.js";
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
      long: [
        sdk.init({ session: "s" }),
        ...Array.from({ length: 200 }, (_, i) => sdk.delta(`w${i} `)),
        sdk.result(),
      ],
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
    expect(await hook({ tool_name: "mcp__agentlee__echo_time" })).toMatchObject({
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
      network: { loopbackPorts: [45678], https: true },
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
    expect(log.options[1]!.systemPrompt).not.toContain("토마토");
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
    "starts without forking, reaches the API over HTTPS, a bad key fails as runtime_auth, and the key is never written",
    async () => {
      const root = tmp();
      const a = new ClaudeAdapter({
        connection: () => ({ id: "t", dir: path.join(root, "conn"), auth: { kind: "api_key", apiKey: KEY } }),
      });
      const s = await a.start(ctx({ mcp: undefined, tools: [] }));
      await expect(collect(s.turn({ text: "hi", model: "claude-haiku-5-5" }).events)).rejects.toMatchObject({
        code: "runtime_auth",
      });
      await s.close();
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

describe("Claude connection from .env (#15, until #17)", () => {
  const users = new Map([
    ["admin", { id: "admin", role: "admin", email: "Ingki3@gmail.com", active: true }],
    ["admin2", { id: "admin2", role: "admin", email: "other@family.test", active: true }],
    ["son", { id: "son", role: "member", email: "son@family.test", active: true }],
    ["gone", { id: "gone", role: "member", email: "gone@family.test", active: false }],
  ]);
  const store = { byId: (id: string) => users.get(id) as never };
  const base = { dataDir: "/data", adminEmail: "ingki3@gmail.com" };
  const both = { ...base, claude: { apiKey: "sk-ant-k", oauthToken: "oat" } };
  it("subscription only for the admin themself; the API key for everyone else", () => {
    expect(claudeConnectionFor(both, store, "admin")).toMatchObject({
      id: "claude-admin-subscription",
      auth: { kind: "oauth_token" },
    });
    expect(claudeConnectionFor(both, store, "admin2")).toMatchObject({
      id: "claude-api-key",
      auth: { kind: "api_key" },
    });
    expect(claudeConnectionFor(both, store, "son")).toMatchObject({
      id: "claude-api-key",
      dir: "/data/runtimes/claude-api-key",
    });
  });
  it("without an API key, family members have no Claude connection; inactive users never", () => {
    const sub = { ...base, claude: { oauthToken: "oat" } };
    expect(claudeConnectionFor(sub, store, "son")).toBeUndefined();
    expect(claudeConnectionFor(sub, store, "admin2")).toBeUndefined();
    expect(claudeConnectionFor(both, store, "gone")).toBeUndefined();
    expect(claudeConnectionFor(both, store, "nobody")).toBeUndefined();
    expect(claudeConnectionFor(base, store, "admin")).toBeUndefined();
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
