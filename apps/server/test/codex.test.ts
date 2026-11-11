import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  RuntimeFailure,
  SessionGoneError,
  type RuntimeEvent,
  type StartContext,
} from "../src/runtime/adapter.js";
import {
  CA_BUNDLE,
  CODEX_MODELS,
  CodexAdapter,
  codexBinary,
  codexEnv,
  type CodexAdapterOptions,
} from "../src/runtime/codex.js";
import { codexConnectionFor } from "../src/runtime/codex-config.js";
import { CODEX_NOTIFICATION_SCOPE } from "../src/runtime/codex-protocol.js";
import { CODEX_BUILTIN_TOOLS, CODEX_DISABLED_FEATURES } from "../src/runtime/lockdown.js";
import { runIsolated, spawnIsolated, type SpawnIsolatedOptions } from "../src/isolation/sandbox.js";
import { CODEX_EGRESS_HOSTS, EgressService } from "../src/isolation/egress.js";
import { McpTokens } from "../src/isolation/tokens.js";
import { McpService } from "../src/mcp/service.js";
import {
  cx,
  newLog,
  recordingSpawn,
  replaySpawn,
  type RecordedTurn,
  type Recording,
  type ReplayLog,
} from "./helpers/codex-replay.js";
import { offeredTools, promptText, sse, startFakeResponses } from "./helpers/fake-responses.js";
import { runtimeContract } from "./helpers/runtime-contract.js";
import { createFamily } from "./helpers/permission-matrix.js";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { CSRF_HEADER, type Run } from "@agentlee/shared";
import { RuntimeRegistry, type RuntimeAdapter } from "../src/runtime/adapter.js";
import recorded from "./fixtures/codex-contract.json" with { type: "json" };

const isMac = process.platform === "darwin";
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "codex-test-"));
  dirs.push(d);
  return d;
};

const KEY = "sk-proj-TESTKEY" + "x".repeat(30);
/** A trimmed catalog in the shape the binary ships (the real one is checked on macOS below). */
const CATALOG = {
  models: CODEX_MODELS.map((m) => ({
    slug: m.id,
    tool_mode: "code_mode_only",
    multi_agent_version: "v2",
    apply_patch_tool_type: "freeform",
    experimental_supported_tools: ["clock"],
    supports_search_tool: true,
    base_instructions: "You are Codex.",
  })),
};
function adapter(
  rec: Recording,
  o: { noConnection?: boolean; root?: string; replay?: Parameters<typeof replaySpawn>[2] } & Partial<
    Pick<CodexAdapterOptions, "egress">
  > = {},
) {
  const root = o.root ?? tmp();
  const log: ReplayLog = newLog();
  const a = new CodexAdapter({
    connection: () =>
      o.noConnection
        ? undefined
        : { id: "c1", dir: path.join(root, "conn"), auth: { kind: "api_key", apiKey: KEY } },
    spawn: replaySpawn(rec, log, o.replay),
    bundledCatalog: async () => CATALOG,
    executable: "/nonexistent/codex",
    ...(o.egress ? { egress: o.egress } : {}),
  });
  return { a, log, root };
}

const ctx = (
  over: Partial<Omit<StartContext, "mcp">> & { mcp?: StartContext["mcp"] | undefined } = {},
): StartContext => ({
  conversationId: "c-1",
  userId: "u-mom",
  history: [],
  systemPrompt: "You are Agent Lee.",
  model: "gpt-6.1-sol",
  tools: ["echo_time"],
  mcp: { url: "http://127.0.0.1:45678/mcp", token: "run-token-abc" },
  ...(over as Partial<StartContext>),
});

async function collect(events: AsyncIterable<RuntimeEvent>) {
  const out: RuntimeEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}
const run = async (msgs: RecordedTurn | Record<string, unknown>[]) => {
  const { a, log } = adapter({ x: msgs as RecordedTurn });
  const s = await a.start(ctx());
  const seen: RuntimeEvent[] = [];
  const done = (async () => {
    for await (const e of s.turn({ text: "x", model: "gpt-6.1-sol" }).events) seen.push(e);
  })();
  return { done, seen, log };
};
const interrupts = (log: ReplayLog) => log.requests.filter((r) => r.method === "turn/interrupt").length;

// --- Contract (#12) against recorded runtime messages ---------------------------------------------------
// The fixture is a HAND-MADE placeholder in the shapes of app-server 0.165.0 until a real recording exists
// (test/record-codex.ts needs credentials, docs/ops.md).
const contract = recorded as unknown as { prompts: Record<string, string>; recording: Recording };
runtimeContract("Codex (recorded — placeholder)", () => adapter(contract.recording).a, {
  short: contract.prompts.short!,
  long: contract.prompts.long!,
  remember: contract.prompts.remember!,
  recall: contract.prompts.recall!,
  recallCheck: (answer) => /토마토/.test(answer),
});

describe("Codex adapter (#16): event translation", () => {
  it("turns app-server messages into our events: text, reasoning, our tools, usage with cache (this turn only)", async () => {
    const { a } = adapter({
      "몇 시야?": [
        cx.item("started", { type: "userMessage", id: "u1" }),
        cx.reasoning("생각 중"),
        cx.mcp("started", { id: "call_1", tool: "echo_time" }),
        // The thread total runs on from earlier turns: 5000 before this turn.
        cx.usage(cx.tokens(5100, 4000, 20), cx.tokens(100, 0, 5)),
        cx.mcp("completed", { id: "call_1", tool: "echo_time", result: { now: "t", userName: "엄마" } }),
        cx.item("started", { type: "agentMessage", id: "m1" }),
        cx.delta("지금은 "),
        cx.delta("9시예요."),
        cx.usage(cx.tokens(5300, 4150, 30), cx.tokens(200, 150, 10)),
        cx.rateLimits(null),
        cx.completed("completed"),
      ],
    });
    const s = await a.start(ctx());
    const ev = await collect(s.turn({ text: "몇 시야?", model: "gpt-6.1-sol" }).events);
    expect(ev).toEqual([
      { type: "reasoning_delta", text: "생각 중" },
      { type: "tool_start", callId: "call_1", name: "echo_time", input: {} },
      { type: "tool_end", callId: "call_1", output: { now: "t", userName: "엄마" } },
      { type: "text_delta", text: "지금은 " },
      { type: "text_delta", text: "9시예요." },
      { type: "usage", inputTokens: 300, outputTokens: 15, cacheReadTokens: 150, cacheWriteTokens: 0 },
    ]);
  });

  it("a multi-byte character split across stdout chunks stays whole", async () => {
    const root = tmp();
    const log = newLog();
    const inner = replaySpawn({ x: cx.answer("안녕하세요 반가워요 ") }, log);
    const a = new CodexAdapter({
      connection: () => ({ id: "c", dir: path.join(root, "conn"), auth: { kind: "api_key", apiKey: KEY } }),
      bundledCatalog: async () => CATALOG,
      executable: "/nonexistent/codex",
      spawn: (s) => {
        const child = inner(s);
        const bytes = new PassThrough();
        // Re-deliver the app-server's output one byte at a time.
        child.stdout.on("data", (d: Buffer) => {
          for (const b of d) bytes.write(Buffer.from([b]));
        });
        return Object.assign(Object.create(child) as object, {
          stdin: child.stdin,
          stdout: bytes,
          pid: undefined,
          once: child.once.bind(child),
          kill: child.kill.bind(child),
        }) as typeof child;
      },
    });
    const ev = await collect((await a.start(ctx())).turn({ text: "x", model: "gpt-6.1-sol" }).events);
    expect(ev.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("")).toBe(
      "안녕하세요 반가워요 ",
    );
  });

  it("tool errors stay tool errors", async () => {
    const { done, seen } = await run([
      cx.mcp("started", { id: "t", tool: "echo_time" }),
      cx.mcp("completed", { id: "t", tool: "echo_time", failed: "skill_busy" }),
      cx.completed("completed"),
    ]);
    await done;
    expect(seen[1]).toEqual({ type: "tool_end", callId: "t", output: "skill_busy", isError: true });
  });

  it("anything but the run's own tools on our server stops the turn (runtime_policy) and interrupts codex", async () => {
    const foreign = [
      cx.mcp("started", { id: "f", server: "gmail", tool: "search" }), // another MCP server
      cx.mcp("started", { id: "f", server: "gmail", tool: "echo_time" }), // …even with one of our tool names
      cx.mcp("started", { id: "f", server: "agentlee__extra", tool: "echo_time" }),
      cx.mcp("started", { id: "f", server: "codex", tool: "list_mcp_resources" }), // a built-in
      cx.mcp("started", { id: "f", tool: "read_mcp_resource" }), // our server, but not a tool of this run
      cx.mcp("started", { id: "f", tool: "skill_selftest" }), // our tool, but not allowed for this run
      cx.item("started", { type: "commandExecution", id: "c", command: "ls" }),
      cx.item("started", { type: "fileChange", id: "c" }),
      cx.item("started", { type: "collabAgentToolCall", id: "c", tool: "spawnAgent" }), // a sub-agent
      cx.item("started", { type: "webSearch", id: "c" }),
      cx.item("started", { type: "dynamicToolCall", id: "c", tool: "x" }),
      cx.item("started", { type: "imageView", id: "c", path: "/etc/passwd" }),
      // A message about another thread (a sub-agent's).
      { method: "item/agentMessage/delta", params: { threadId: "other", turnId: "t", delta: "x" } },
    ];
    for (const m of foreign) {
      const { done, seen, log } = await run({
        threadId: cx.threadId,
        turnId: cx.turnId,
        messages: [cx.delta("a "), m, cx.delta("never "), cx.completed("completed")],
        interruptAt: 2,
      });
      await expect(done).rejects.toMatchObject({ code: "runtime_policy" });
      expect(seen.some((e) => e.type === "tool_start")).toBe(false);
      expect(seen).not.toContainEqual({ type: "text_delta", text: "never " });
      expect(interrupts(log)).toBe(1);
    }
  });

  it("a request from the app-server (approval, user input, elicitation) is refused and stops the turn", async () => {
    const { a, log } = adapter(
      { x: { ...cx.answer("a b c d e f g h"), interruptAt: 9 } },
      { replay: { serverRequestAt: { prompt: "x", method: "item/commandExecution/requestApproval" } } },
    );
    const s = await a.start(ctx());
    await expect(collect(s.turn({ text: "x", model: "gpt-6.1-sol" }).events)).rejects.toMatchObject({
      code: "runtime_policy",
    });
    expect(interrupts(log)).toBe(1);
  });

  const status = (name: string, threadId: string | null) => ({
    method: "mcpServer/startupStatus/updated",
    params: { threadId, name, status: "ready", error: null, failureReason: null },
  });
  const threadStarted = (id: string) => ({ method: "thread/started", params: { thread: { id, turns: [] } } });

  it("another MCP server, or another thread, while the session opens fails it (runtime_policy)", async () => {
    // Ours, globally (threadId null) or on our thread, and our own thread/started: fine.
    const ok = adapter(
      {},
      {
        replay: {
          atStart: [status("agentlee", null)],
          afterOpen: [threadStarted(cx.threadId), status("agentlee", cx.threadId), status("agentlee", null)],
        },
      },
    );
    await expect(ok.a.start(ctx())).resolves.toBeDefined();
    for (const replay of [
      { atStart: [status("agentlee", null), status("claude.ai Gmail", null)] },
      { afterOpen: [status("claude.ai Gmail", cx.threadId)] },
      { atStart: [threadStarted("01a1c86a-0000-7000-8000-00000000beef")] }, // a thread before ours: not ours
      { afterOpen: [threadStarted("01a1c86a-0000-7000-8000-00000000beef")] },
      { afterOpen: [status("agentlee", "01a1c86a-0000-7000-8000-00000000beef")] },
    ]) {
      const bad = adapter({}, { replay });
      await expect(bad.a.start(ctx()), JSON.stringify(replay)).rejects.toMatchObject({
        code: "runtime_policy",
      });
      expect(bad.log.kills).toBe(1);
    }
  });

  it("a resume knows its thread from the first message: another thread right after initialize fails it", async () => {
    const other = "01a1c86a-0000-7000-8000-00000000beef";
    const root = tmp();
    const first = adapter({ x: cx.answer("ok") }, { root });
    const s = await first.a.start(ctx());
    await collect(s.turn({ text: "x", model: "gpt-6.1-sol" }).events);
    await s.close();
    // Control: messages about our own thread right after initialize are fine.
    const fine = adapter({}, { root, replay: { atStart: [threadStarted(s.externalSessionId)] } });
    await expect(fine.a.resume(s.externalSessionId, ctx())).resolves.toBeDefined();
    for (const m of [
      threadStarted(other),
      { method: "thread/status/changed", params: { threadId: other, status: { type: "active" } } },
      status("agentlee", other),
    ]) {
      const again = adapter({}, { root, replay: { atStart: [m] } });
      await expect(again.a.resume(s.externalSessionId, ctx()), JSON.stringify(m)).rejects.toMatchObject({
        code: "runtime_policy",
      });
      expect(again.log.kills).toBe(1);
    }
  });

  it("items are checked whenever they come: a command while the session opens, a foreign tool between turns", async () => {
    const command = cx.item("started", { type: "commandExecution", id: "c", command: "ls" });
    const opening = adapter({}, { replay: { afterOpen: [command] } });
    await expect(opening.a.start(ctx())).rejects.toMatchObject({ code: "runtime_policy" });
    expect(opening.log.kills).toBe(1);

    const foreign = cx.mcp("started", { id: "f", server: "gmail", tool: "search" });
    const { a, log } = adapter(
      { x: cx.answer("ok "), y: cx.answer("never ") },
      { replay: { afterTurn: [foreign] } },
    );
    const s = await a.start(ctx());
    await collect(s.turn({ text: "x", model: "gpt-6.1-sol" }).events);
    await new Promise((r) => setTimeout(r, 20));
    expect(log.kills).toBe(1);
    expect(() => s.turn({ text: "y", model: "gpt-6.1-sol" })).toThrow(
      expect.objectContaining({ code: "runtime_policy" }),
    );
    // Our own tool between turns is no breach.
    const ours = adapter(
      { x: cx.answer("ok "), y: cx.answer("fine ") },
      { replay: { afterTurn: [cx.mcp("completed", { id: "t", tool: "echo_time" })] } },
    );
    const s2 = await ours.a.start(ctx());
    await collect(s2.turn({ text: "x", model: "gpt-6.1-sol" }).events);
    await new Promise((r) => setTimeout(r, 20));
    expect(await collect(s2.turn({ text: "y", model: "gpt-6.1-sol" }).events)).toContainEqual({
      type: "text_delta",
      text: "fine ",
    });
  });

  it("an MCP server that joins during a turn stops it at once (runtime_policy, interrupted)", async () => {
    for (const late of [status("claude.ai Gmail", null), status("claude.ai Gmail", cx.threadId)]) {
      const { done, seen, log } = await run({
        threadId: cx.threadId,
        turnId: cx.turnId,
        messages: [cx.delta("a "), late, cx.delta("never "), cx.completed("completed")],
        interruptAt: 2,
      });
      await expect(done).rejects.toMatchObject({ code: "runtime_policy" });
      expect(seen).not.toContainEqual({ type: "text_delta", text: "never " });
      expect(interrupts(log)).toBe(1);
    }
  });

  it("an MCP server that joins between turns closes the session: the next turn fails closed", async () => {
    const { a, log } = adapter(
      { x: cx.answer("ok "), y: cx.answer("never ") },
      { replay: { afterTurn: [status("claude.ai Gmail", null)] } },
    );
    const s = await a.start(ctx());
    await collect(s.turn({ text: "x", model: "gpt-6.1-sol" }).events);
    await new Promise((r) => setTimeout(r, 20));
    expect(log.kills).toBe(1);
    expect(() => s.turn({ text: "y", model: "gpt-6.1-sol" })).toThrow(
      expect.objectContaining({ code: "runtime_policy" }),
    );
  });

  it("notification shapes of 0.165.0: thread ids read where each type keeps them; null = global", async () => {
    const other = "01a1c86a-0000-7000-8000-00000000beef";
    const fine = [
      threadStarted(cx.threadId),
      status("agentlee", null),
      status("agentlee", cx.threadId),
      { method: "warning", params: { threadId: null, message: "x" } },
      { method: "account/rateLimits/updated", params: { rateLimits: {} } },
      { method: "thread/status/changed", params: { threadId: cx.threadId, status: { type: "active" } } },
    ];
    const { done, seen } = await run([...fine, cx.delta("ok"), cx.completed("completed")]);
    await done;
    expect(seen).toEqual([{ type: "text_delta", text: "ok" }]);
    const refused = [
      threadStarted(other), // the id is in params.thread.id
      { method: "warning", params: { threadId: other, message: "x" } },
      { method: "thread/status/changed", params: { threadId: other, status: { type: "active" } } },
      status("agentlee", other),
      { method: "item/agentMessage/delta", params: { turnId: cx.turnId, delta: "x" } }, // threadId missing
      { method: "thread/started", params: {} },
      { method: "brand/new/notification", params: {} }, // not in the pinned protocol
      { method: "process/outputDelta", params: { processId: "p", delta: "x" } },
    ];
    for (const m of refused) {
      const r = await run({
        threadId: cx.threadId,
        turnId: cx.turnId,
        messages: [m, cx.delta("never "), cx.completed("completed")],
        interruptAt: 1,
      });
      await expect(r.done, JSON.stringify(m)).rejects.toMatchObject({ code: "runtime_policy" });
      expect(r.seen).toEqual([]);
    }
  });

  it("usage limits end the turn as a limit; a refused credential fails at once as runtime_auth; other errors fail", async () => {
    const limit = await run([cx.error("usageLimitExceeded"), cx.completed("failed", "usageLimitExceeded")]);
    await limit.done;
    expect(limit.seen.filter((e) => e.type === "limit")).toHaveLength(1);

    const reached = await run([cx.rateLimits("rate_limit_reached"), cx.completed("failed", "other")]);
    await reached.done;
    expect(reached.seen.filter((e) => e.type === "limit")).toHaveLength(1);
    // "Reached" after a turn that still completed: that turn is not limited.
    const after = await run([cx.delta("ok"), cx.rateLimits("rate_limit_reached"), cx.completed("completed")]);
    await after.done;
    expect(after.seen.some((e) => e.type === "limit")).toBe(false);

    const tooMany = await run([
      cx.error({ responseTooManyFailedAttempts: { httpStatusCode: 429 } }),
      cx.completed("failed", { responseTooManyFailedAttempts: { httpStatusCode: 429 } }),
    ]);
    await tooMany.done;
    expect(tooMany.seen.filter((e) => e.type === "limit")).toHaveLength(1);

    // The real binary reports a 401 as "will retry" first and retries for ~40 s: we do not wait for that.
    const auth = await run({
      threadId: cx.threadId,
      turnId: cx.turnId,
      messages: [
        cx.error({ responseStreamDisconnected: { httpStatusCode: 401 } }, true),
        ...Array.from({ length: 50 }, () =>
          cx.error({ responseStreamDisconnected: { httpStatusCode: 401 } }, true),
        ),
        cx.completed("interrupted"),
      ],
      interruptAt: 51,
    });
    await expect(auth.done).rejects.toMatchObject({ code: "runtime_auth" });
    expect(interrupts(auth.log)).toBe(1);
    await expect((await run([cx.completed("failed", "unauthorized")])).done).rejects.toMatchObject({
      code: "runtime_auth",
    });

    await expect((await run([cx.completed("failed", "internalServerError")])).done).rejects.toMatchObject({
      code: "runtime_error",
    });
    // An interrupt nobody asked for is not "stopped".
    await expect((await run([cx.completed("interrupted")])).done).rejects.toMatchObject({
      code: "runtime_error",
    });
    // The process going away mid-turn.
    await expect(
      (await run({ threadId: cx.threadId, turnId: cx.turnId, messages: [cx.delta("a")], exited: true })).done,
    ).rejects.toMatchObject({ code: "runtime_error" });
  });

  it("an interrupt we asked for ends the turn quietly — also while a tool runs", async () => {
    const { a, log } = adapter({
      long: {
        threadId: cx.threadId,
        turnId: cx.turnId,
        messages: [
          cx.mcp("started", { id: "slow", tool: "echo_time" }),
          ...Array.from({ length: 200 }, (_, i) => cx.delta(`w${i} `)),
          // What 0.165.0 sends when a tool call is interrupted: no item/completed, the turn is "interrupted".
          cx.completed("interrupted"),
        ],
        interruptAt: 201,
      },
    });
    const turn = (await a.start(ctx())).turn({ text: "long", model: "gpt-6.1-sol" });
    const ev: RuntimeEvent[] = [];
    for await (const e of turn.events) {
      ev.push(e);
      if (ev.length === 3) void turn.interrupt();
    }
    expect(interrupts(log)).toBe(1);
    expect(log.requests.find((r) => r.method === "turn/interrupt")!.params).toMatchObject({
      threadId: expect.any(String),
      turnId: expect.any(String),
    });
    expect(ev.length).toBeLessThan(10);
  });
});

describe("Codex adapter (#16): settings it hands to the app-server", () => {
  it("own CODEX_HOME with only our config: features off, our MCP server with only the run's tools, strict loading", async () => {
    const { a, log, root } = adapter({ x: cx.answer("ok") });
    await collect((await a.start(ctx())).turn({ text: "x", model: "gpt-6.1-sol", effort: "low" }).events);
    const home = path.join(root, "conn", "codex-home");
    const toml = fs.readFileSync(path.join(home, "config.toml"), "utf8");
    for (const f of CODEX_DISABLED_FEATURES) expect(toml).toContain(`\n${f} = false\n`);
    expect(toml).toContain("\ncode_mode_host = false\n");
    expect(toml).toContain("\nmulti_agent = false\n");
    expect(toml).not.toContain("mcp_servers"); // per run, on the command line (below)
    expect(toml).toContain('cli_auth_credentials_store = "ephemeral"');
    expect(toml).toContain('approval_policy = "never"');
    expect(toml).toContain("project_doc_max_bytes = 0");
    expect(toml).toContain("include_environment_context = false");
    expect(toml).not.toContain("run-token-abc");
    expect(toml).not.toContain("TESTKEY");
    expect(toml).not.toContain("model_provider"); // the OpenAI API — the test provider is never set here
    // Our catalog: tool mode direct (no code-mode host process), no sub-agents, no apply_patch, only our models.
    const cat = JSON.parse(fs.readFileSync(path.join(home, "agentlee-models.json"), "utf8")) as {
      models: Record<string, unknown>[];
    };
    expect(cat.models.map((m) => m.slug)).toEqual(CODEX_MODELS.map((m) => m.id));
    for (const m of cat.models)
      expect(m).toMatchObject({
        tool_mode: "direct",
        multi_agent_version: "disabled",
        apply_patch_tool_type: null,
        experimental_supported_tools: [],
        supports_search_tool: false,
      });
    // Process: the binary, strict config, stdio, and this run's settings: the model and our MCP server only, with
    // only the run's tools, auto-approved, required. Never the token.
    expect(log.spawns[0]!.args).toEqual([
      "app-server",
      "--strict-config",
      "--listen",
      "stdio://",
      "-c",
      'model="gpt-6.1-sol"',
      "-c",
      'mcp_servers.agentlee={ url = "http://127.0.0.1:45678/mcp", bearer_token_env_var = "AGENTLEE_MCP_TOKEN", default_tools_approval_mode = "approve", enabled_tools = ["echo_time"], required = true }',
    ]);
    expect(JSON.stringify(log.spawns[0]!.args)).not.toContain("run-token-abc");
    // Requests: the key only in account/login/start (over stdin); thread with our instructions; turn with effort.
    const methods = log.requests.map((r) => r.method);
    expect(methods.slice(0, 3)).toEqual(["initialize", "account/login/start", "thread/start"]);
    expect(log.requests[1]!.params).toEqual({ type: "apiKey", apiKey: KEY });
    expect(log.requests[2]!.params).toMatchObject({
      model: "gpt-6.1-sol",
      approvalPolicy: "never",
      sandbox: "read-only",
      baseInstructions: "You are Agent Lee.",
    });
    expect(log.requests.find((r) => r.method === "turn/start")!.params).toMatchObject({
      model: "gpt-6.1-sol",
      effort: "low",
      input: [{ type: "text", text: "x", text_elements: [] }],
    });
  });

  it("environment: only ours, no credential at all, MCP token for bearer_token_env_var, folders inside the connection", async () => {
    const { a, log, root } = adapter({ x: cx.answer("ok") });
    await collect((await a.start(ctx())).turn({ text: "x", model: "gpt-6.1-sol" }).events);
    const env = log.spawns[0]!.env;
    expect(Object.keys(env).sort()).toEqual(
      [...Object.keys(codexEnv({ dir: "/x" })), "AGENTLEE_MCP_TOKEN"].sort(),
    );
    expect(env.AGENTLEE_MCP_TOKEN).toBe("run-token-abc");
    expect(JSON.stringify(env)).not.toContain("TESTKEY");
    for (const k of ["HOME", "TMPDIR", "CODEX_HOME"])
      expect(env[k]!.startsWith(path.join(root, "conn"))).toBe(true);
    expect(env.CODEX_CA_CERTIFICATE).toBe(CA_BUNDLE);
    for (const k of Object.keys(process.env)) if (!(k in env)) expect(env[k]).toBeUndefined();
    // Nothing on disk holds the key.
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const n of fs.readdirSync(d)) {
        const p = path.join(d, n);
        if (fs.lstatSync(p).isDirectory()) walk(p);
        else if (fs.readFileSync(p).includes("TESTKEY")) hits.push(p);
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });

  it("the process is spawned sandboxed: its connection folder (+ CA roots) only, loopback MCP + proxy ports only", async () => {
    const { a, log, root } = adapter(
      { x: cx.answer("ok") },
      { egress: { endpoint: async () => ({ port: 41111, url: "http://127.0.0.1:41111" }) } },
    );
    await collect((await a.start(ctx())).turn({ text: "x", model: "gpt-6.1-sol" }).events);
    expect(log.spawns[0]).toMatchObject({
      command: "/nonexistent/codex",
      read: [path.join(root, "conn"), CA_BUNDLE],
      write: [path.join(root, "conn", "codex-home"), path.join(root, "conn", "tmp")],
      network: { loopbackPorts: [45678, 41111] },
      cwd: path.join(root, "conn", "work"),
    });
    expect(log.spawns[0]!.exec ?? []).toEqual([]);
    expect(log.spawns[0]!.trusted ?? []).toEqual([]);
    expect(log.spawns[0]!.env.HTTPS_PROXY).toBe("http://127.0.0.1:41111");
    expect(log.spawns[0]!.env.NO_PROXY).toBe("127.0.0.1,localhost");
  });

  it("without our MCP server: no MCP section, no token, no MCP port", async () => {
    const { a, log, root } = adapter({ x: cx.answer("ok") });
    await collect(
      (await a.start(ctx({ mcp: undefined, tools: [] }))).turn({ text: "x", model: "gpt-6.1-sol" }).events,
    );
    expect(fs.readFileSync(path.join(root, "conn", "codex-home", "config.toml"), "utf8")).not.toContain(
      "mcp_servers",
    );
    expect(log.spawns[0]!.args.join(" ")).not.toContain("mcp_servers");
    expect(log.spawns[0]!.env.AGENTLEE_MCP_TOKEN).toBeUndefined();
    expect(log.spawns[0]!.network).toEqual({ loopbackPorts: [] });
  });

  it("instruction and skill files are removed before every start (a `$name` would pull a SKILL.md into the prompt)", async () => {
    const { a, root } = adapter({ x: cx.answer("ok") });
    const conn = path.join(root, "conn");
    const planted = [
      "codex-home/AGENTS.md",
      "codex-home/AGENTS.override.md",
      "codex-home/skills/x/SKILL.md",
      "codex-home/prompts/x.md",
      "home/.agents/skills/x/SKILL.md",
      "work/AGENTS.md",
      "work/.agents/skills/x/SKILL.md",
      "work/.codex/skills/x/SKILL.md",
    ];
    for (const f of planted) {
      fs.mkdirSync(path.dirname(path.join(conn, f)), { recursive: true });
      fs.writeFileSync(path.join(conn, f), "MARKER");
    }
    // What another session of the same user may be using right now stays.
    for (const f of ["tmp/in-use", "work/in-use", "codex-home/sessions/x.jsonl"]) {
      fs.mkdirSync(path.dirname(path.join(conn, f)), { recursive: true });
      fs.writeFileSync(path.join(conn, f), "x");
    }
    await a.start(ctx());
    for (const f of planted) expect(fs.existsSync(path.join(conn, f))).toBe(false);
    for (const f of ["tmp/in-use", "work/in-use", "codex-home/sessions/x.jsonl"])
      expect(fs.existsSync(path.join(conn, f))).toBe(true);
  });

  it("history goes into a fresh thread's developer instructions only; a resume sends the same base instructions", async () => {
    const { a, log } = adapter({ x: cx.answer("ok"), y: cx.answer("ok") });
    const history = [{ role: "user" as const, parts: [{ type: "text" as const, text: "내 이름은 토마토" }] }];
    const s = await a.start(ctx({ history }));
    await collect(s.turn({ text: "x", model: "gpt-6.1-sol" }).events);
    await s.close();
    const start = log.requests.find((r) => r.method === "thread/start")!.params;
    expect(start.developerInstructions).toContain("내 이름은 토마토");
    expect(start.baseInstructions).toBe("You are Agent Lee.");
    const s2 = await a.resume(s.externalSessionId, ctx({ history, systemPrompt: "changed later" }));
    await collect(s2.turn({ text: "y", model: "gpt-6.1-sol" }).events);
    const resume = log.requests.find((r) => r.method === "thread/resume")!.params;
    expect(resume.threadId).toBe(s.externalSessionId);
    // The thread keeps its history (no second copy) and the instructions it started with.
    expect(resume.developerInstructions).toBeUndefined();
    expect(resume.baseInstructions).toBe("You are Agent Lee.");
  });

  it("changes the model between turns (turn/start carries it); refuses unknown models and efforts", async () => {
    const { a, log } = adapter({ x: cx.answer("ok"), y: cx.answer("ok") });
    const s = await a.start(ctx());
    await collect(s.turn({ text: "x", model: "gpt-6.1-sol" }).events);
    await s.setModel("gpt-6-luna");
    await collect(s.turn({ text: "y", model: "gpt-6-luna", effort: "max" }).events);
    const turns = log.requests.filter((r) => r.method === "turn/start").map((r) => r.params);
    expect(turns.map((t) => [t.model, t.effort])).toEqual([
      ["gpt-6.1-sol", "low"], // unset → the model's default, said explicitly (codex would keep the last one)
      ["gpt-6-luna", "max"],
    ]);
    await expect(s.setModel("gpt-x")).rejects.toBeInstanceOf(RuntimeFailure);
    expect(() => s.turn({ text: "y", model: "gpt-6-luna", effort: "ultra" })).toThrow(RuntimeFailure); // luna: ≤ max
    expect(() => s.turn({ text: "y", model: "gpt-6.1-sol", effort: "minimal" })).toThrow(RuntimeFailure);
    await expect(a.start(ctx({ model: "claude-haiku-5-5" }))).rejects.toBeInstanceOf(RuntimeFailure);
    await expect(adapter({}, { noConnection: true }).a.start(ctx())).rejects.toMatchObject({
      code: "no_connection",
    });
  });

  it("resuming a thread the runtime does not have, or without our metadata, is SessionGoneError", async () => {
    const { a, root } = adapter({ x: cx.answer("ok") });
    await expect(a.resume("01a1c86a-c0b6-7ea2-a83e-ebd779e7ca01", ctx())).rejects.toBeInstanceOf(
      SessionGoneError,
    );
    await expect(a.resume("../../etc/passwd", ctx())).rejects.toBeInstanceOf(SessionGoneError);
    const s = await a.start(ctx());
    await collect(s.turn({ text: "x", model: "gpt-6.1-sol" }).events);
    await s.close();
    fs.rmSync(path.join(root, "conn-meta"), { recursive: true });
    await expect(a.resume(s.externalSessionId, ctx())).rejects.toBeInstanceOf(SessionGoneError);
  });

  it("closing the session kills the process", async () => {
    const { a, log } = adapter({ x: cx.answer("ok") });
    const s = await a.start(ctx());
    await s.close();
    expect(log.kills).toBe(1);
    expect(() => s.turn({ text: "x", model: "gpt-6.1-sol" })).toThrow();
  });
});

describe("Codex adapter (#16) under the run manager: how runs end", () => {
  /** The adapter behind the default runtime id, so a plain message runs on it. */
  async function runWith(turn: RecordedTurn) {
    const codex = adapter({ 질문: turn }).a;
    const wrapped: RuntimeAdapter = {
      id: "claude-code",
      capabilities: () => codex.capabilities(),
      start: (c) => codex.start(c),
      resume: (id, c) => codex.resume(id, c),
    };
    const runtimes = new RuntimeRegistry();
    runtimes.register(wrapped);
    const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
      db: createTestDb(),
      logger: false,
      runtimes,
      runs: { flushMs: 0 },
    });
    try {
      const f = await createFamily(app);
      const c = app.conversations!.create(f.users.owner.id);
      const res = await app.inject({
        method: "POST",
        url: `/api/conversations/${c.id}/messages`,
        headers: {
          host: "localhost:3000",
          cookie: f.cookies.owner,
          origin: "http://localhost:3000",
          [CSRF_HEADER]: "1",
          "content-type": "application/json",
        },
        payload: { text: "질문" },
      });
      const id = (res.json() as { run: Run }).run.id;
      for (let i = 0; i < 300; i++) {
        const r = app.runs!.get(id)!;
        if (r.endedAt !== null) return r;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("run did not end");
    } finally {
      await app.close();
    }
  }
  const t = (messages: Record<string, unknown>[]): RecordedTurn => ({
    threadId: cx.threadId,
    turnId: cx.turnId,
    messages,
    interruptAt: messages.length - 1,
  });

  it("done, usage limit, refused credential, foreign tool, other failure", async () => {
    expect(await runWith(cx.answer("네 "))).toMatchObject({ status: "done", errorCode: null });
    expect(
      await runWith(t([cx.error("usageLimitExceeded"), cx.completed("failed", "usageLimitExceeded")])),
    ).toMatchObject({ status: "failed", errorCode: "usage_limit" });
    expect(
      await runWith(
        t([
          cx.error({ responseStreamDisconnected: { httpStatusCode: 401 } }, true),
          cx.completed("interrupted"),
        ]),
      ),
    ).toMatchObject({ status: "failed", errorCode: "runtime_auth" });
    expect(
      await runWith(
        t([cx.mcp("started", { id: "f", server: "gmail", tool: "search" }), cx.completed("interrupted")]),
      ),
    ).toMatchObject({ status: "failed", errorCode: "runtime_policy" });
    expect(await runWith(t([cx.completed("failed", "internalServerError")]))).toMatchObject({
      status: "failed",
      errorCode: "runtime_error",
    });
  });
});

describe("Codex connection from .env (#16, until #17)", () => {
  const users = new Map([
    ["mom", { id: "mom", role: "member", email: "mom@family.test", active: true }],
    ["son", { id: "son", role: "member", email: "son@family.test", active: true }],
    ["gone", { id: "gone", role: "member", email: "gone@family.test", active: false }],
  ]);
  const store = { byId: (id: string) => users.get(id) as never };
  const cfg = { dataDir: "/data", codex: { apiKey: "sk-k" } };
  it("the API key for every active member, each in their own folder", () => {
    const a = codexConnectionFor(cfg, store, "mom")!;
    const b = codexConnectionFor(cfg, store, "son")!;
    expect(a).toMatchObject({
      id: "codex-api-key",
      dir: "/data/runtimes/codex-api-key/mom",
      auth: { apiKey: "sk-k" },
    });
    expect(a.id).toBe(b.id);
    expect(path.relative(a.dir, b.dir).startsWith("..")).toBe(true);
    expect(path.relative(b.dir, a.dir).startsWith("..")).toBe(true);
  });
  it("no key, inactive or unknown users: no connection", () => {
    expect(codexConnectionFor({ dataDir: "/data" }, store, "mom")).toBeUndefined();
    expect(codexConnectionFor(cfg, store, "gone")).toBeUndefined();
    expect(codexConnectionFor(cfg, store, "nobody")).toBeUndefined();
  });
});

describe("recording helper: turns are kept however they end, and replay as recorded", () => {
  it("normal end, interrupt point and process exit are all recorded; the recording replays the same", async () => {
    const source: Recording = {
      ok: cx.answer("one two"),
      cut: {
        threadId: cx.threadId,
        turnId: cx.turnId,
        messages: [
          ...Array.from({ length: 50 }, (_, i) => cx.delta(`w${i} `)),
          cx.delta("tail after interrupt "),
          cx.completed("interrupted"),
        ],
        interruptAt: 50,
      },
      gone: { threadId: cx.threadId, turnId: cx.turnId, messages: [cx.delta("a ")], exited: true },
    };
    const rec: Recording = {};
    const pending: Promise<unknown>[] = [];
    const root = tmp();
    const a = new CodexAdapter({
      connection: () => ({ id: "c", dir: path.join(root, "conn"), auth: { kind: "api_key", apiKey: KEY } }),
      spawn: recordingSpawn(replaySpawn(source, newLog()), rec, pending),
      bundledCatalog: async () => CATALOG,
      executable: "/nonexistent/codex",
    });
    const s1 = await a.start(ctx());
    await collect(s1.turn({ text: "ok", model: "gpt-6.1-sol" }).events);
    await s1.close();
    const s2 = await a.start(ctx());
    const turn = s2.turn({ text: "cut", model: "gpt-6.1-sol" });
    let n = 0;
    for await (const e of turn.events) if (e.type === "text_delta" && ++n === 3) void turn.interrupt();
    await s2.close();
    const s3 = await a.start(ctx());
    await expect(collect(s3.turn({ text: "gone", model: "gpt-6.1-sol" }).events)).rejects.toMatchObject({
      code: "runtime_error",
    });
    await Promise.all(pending);
    const ok = rec.ok as RecordedTurn;
    expect(ok.messages.at(-1)).toMatchObject({ method: "turn/completed" });
    expect(ok.threadId).toBeTruthy();
    expect(ok.turnId).toBeTruthy();
    const cut = rec.cut as RecordedTurn;
    expect(cut.interruptAt).toBeGreaterThan(0);
    expect(cut.interruptAt).toBeLessThan(10);
    expect(JSON.stringify(cut.messages)).toContain("tail after interrupt"); // the real tail, not an invented one
    expect(cut.messages.at(-1)).toMatchObject({ method: "turn/completed" });
    expect((rec.gone as RecordedTurn).exited).toBe(true);
    // Replaying the recording behaves the same.
    const again = adapter(rec).a;
    const t2 = (await again.start(ctx())).turn({ text: "cut", model: "gpt-6.1-sol" });
    let m = 0;
    const ev: RuntimeEvent[] = [];
    for await (const e of t2.events) {
      ev.push(e);
      if (e.type === "text_delta" && ++m === 2) void t2.interrupt();
    }
    expect(ev.length).toBeLessThan(15);
    expect(ev).toContainEqual({ type: "text_delta", text: "tail after interrupt " });
  });

  it("a turn recorded without an interrupt refuses to be interrupted in replay (no invented endings)", async () => {
    const { a, log } = adapter({ x: cx.answer("a b c d e f g h i j k l m n o p") });
    const t = (await a.start(ctx())).turn({ text: "x", model: "gpt-6.1-sol" });
    await expect(
      (async () => {
        for await (const e of t.events) if (e.type === "text_delta") void t.interrupt();
      })(),
    ).resolves.toBeUndefined(); // our interrupt: the process ending then is not a failure…
    expect(log.errors).toEqual(["replay: this recording was not interrupted"]); // …but the replay says why
  });
});

// --- The real binary under the real sandbox (macOS) --------------------------------------------------------
const realBin = isMac ? codexBinary() : undefined;
const online = !!realBin && spawnSync("/usr/bin/nc", ["-z", "-G", "3", "api.openai.com", "443"]).status === 0;

describe.skipIf(!realBin)("Codex adapter (#16): the pinned binary in the sandbox (macOS)", () => {
  it("is the pinned 0.165.0 and its shipped catalog agrees with our model table", async () => {
    const home = tmp();
    const v = await runIsolated({
      command: realBin!,
      args: ["--version"],
      cwd: home,
      env: { PATH: "/usr/bin:/bin", HOME: home, CODEX_HOME: home },
      read: [home],
      write: [home],
      timeoutMs: 10_000,
      maxOutputBytes: 10_000,
    });
    expect(v.stdout.trim()).toBe("codex-cli 0.165.0");
    const r = await runIsolated({
      command: realBin!,
      args: ["debug", "models", "--bundled"],
      cwd: home,
      env: { PATH: "/usr/bin:/bin", HOME: home, CODEX_HOME: home },
      read: [home],
      write: [home],
      network: "none",
      timeoutMs: 20_000,
      maxOutputBytes: 8 * 1024 * 1024,
    });
    const cat = JSON.parse(r.stdout) as {
      models: {
        slug: string;
        supported_reasoning_levels: { effort: string }[];
        default_reasoning_level: string;
      }[];
    };
    for (const m of CODEX_MODELS) {
      const c = cat.models.find((x) => x.slug === m.id)!;
      expect(c).toBeDefined();
      expect(c.supported_reasoning_levels.map((l) => l.effort)).toEqual(m.efforts);
      expect(c.default_reasoning_level).toBe(m.defaultEffort);
      // The fields our catalog overrides exist under these names in this version.
      for (const k of [
        "tool_mode",
        "multi_agent_version",
        "apply_patch_tool_type",
        "experimental_supported_tools",
        "supports_search_tool",
      ])
        expect(Object.keys(c)).toContain(k);
    }
  }, 30_000);

  it("the notification table matches the protocol bindings the pinned binary generates", async () => {
    const out = tmp();
    const r = await runIsolated({
      command: realBin!,
      args: ["app-server", "generate-ts", "--out", out],
      cwd: out,
      env: { PATH: "/usr/bin:/bin", HOME: out, CODEX_HOME: out },
      read: [out],
      write: [out],
      network: "none",
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
    });
    expect(r.code).toBe(0);
    const union = fs.readFileSync(path.join(out, "ServerNotification.ts"), "utf8");
    const entries = [...union.matchAll(/"method": "([^"]+)", "params": (\w+)/g)].map((m) => [m[1]!, m[2]!]);
    expect(entries.length).toBeGreaterThan(50);
    const derived: Record<string, string> = {};
    for (const [method, type] of entries) {
      const file = [path.join(out, "v2", `${type}.ts`), path.join(out, `${type}.ts`)].find((f) =>
        fs.existsSync(f),
      )!;
      const body = fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => !l.startsWith("//") && !l.startsWith("import"))
        .join(" ");
      derived[method] = /threadId: string \| null/.test(body)
        ? "threadOrGlobal"
        : /threadId: string/.test(body)
          ? "thread"
          : /\bthread: Thread\b/.test(body)
            ? "threadObject"
            : "global";
    }
    // On a mismatch, this is the table to put in src/runtime/codex-protocol.ts.
    expect(CODEX_NOTIFICATION_SCOPE).toEqual(derived);
  }, 60_000);

  /** The real binary, sandboxed, against a local fake Responses API and our real MCP server. */
  async function realRun(
    script: Parameters<typeof startFakeResponses>[0],
    o: { tools?: string[]; slowSkillMs?: number } = {},
  ) {
    const root = tmp();
    const tokens = new McpTokens();
    const mcp = new McpService(
      tokens,
      { byId: () => ({ name: "엄마", active: true }) as never },
      o.slowSkillMs
        ? {
            runSkill: async () => {
              await new Promise((r) => setTimeout(r, o.slowSkillMs));
              return { ok: true, output: { slow: true } };
            },
          }
        : {},
    );
    const { url } = await mcp.endpoint();
    const fake = await startFakeResponses(script);
    const spawns: SpawnIsolatedOptions[] = [];
    const a = new CodexAdapter({
      connection: () => ({ id: "t", dir: path.join(root, "conn"), auth: { kind: "api_key", apiKey: KEY } }),
      provider: { baseUrl: fake.baseUrl },
      spawn: (s) => {
        spawns.push(s);
        return spawnIsolated(s);
      },
    });
    const token = tokens.issue({ userId: "u-mom", conversationId: "c-1", runId: "r-1" });
    const c = ctx({ tools: o.tools ?? ["echo_time"], mcp: { url, token } });
    return {
      a,
      c,
      fake,
      root,
      token,
      spawns,
      close: async () => {
        await fake.close();
        await mcp.close();
      },
    };
  }

  it("runs without forking: offers only our tools, calls our MCP server, streams text, reports usage", async () => {
    const r = await realRun((n) =>
      n === 0
        ? sse.call("echo_time", {}, "mcp__agentlee")
        : sse.text("지금은 아홉 시예요.", { reasoning: "생각" }),
    );
    try {
      const s = await r.a.start(r.c);
      const ev = await collect(s.turn({ text: "몇 시야?", model: "gpt-6.1-sol", effort: "low" }).events);
      await s.close();
      // Exactly the MCP resource helpers and the run's tool — no exec, shell, apply_patch, sub-agents, skills.
      for (const body of r.fake.requests)
        expect(offeredTools(body)).toEqual(
          [...CODEX_BUILTIN_TOOLS.map((t) => `functions.${t}`), "mcp__agentlee.echo_time"].sort(),
        );
      expect(ev).toContainEqual({
        type: "tool_start",
        callId: expect.any(String),
        name: "echo_time",
        input: {},
      });
      const end = ev.find((e) => e.type === "tool_end") as { output: { userName?: string } };
      expect(end.output.userName).toBe("엄마");
      expect(
        ev
          .filter((e) => e.type === "text_delta")
          .map((e) => (e as { text: string }).text)
          .join(""),
      ).toBe("지금은 아홉 시예요.");
      expect(ev).toContainEqual({ type: "reasoning_delta", text: "생각" });
      expect(ev.find((e) => e.type === "usage")).toEqual({
        type: "usage",
        inputTokens: 200,
        outputTokens: 14,
        cacheReadTokens: 80,
        cacheWriteTokens: 0,
      });
      // What the model saw: our instructions; none of codex's own, no environment details.
      const prompt = promptText(r.fake.requests[0]!);
      expect(prompt).toContain("You are Agent Lee.");
      expect(prompt).not.toContain("You are Codex");
      expect(prompt).not.toContain("environment_context");
      expect(prompt).not.toContain("skills_instructions");
      // Neither the key nor the run's MCP token is on disk.
      const hits: string[] = [];
      const walk = (d: string) => {
        for (const n of fs.readdirSync(d)) {
          const p = path.join(d, n);
          const st = fs.lstatSync(p);
          if (st.isDirectory()) walk(p);
          else if (
            st.isFile() &&
            (fs.readFileSync(p).includes("TESTKEY") || fs.readFileSync(p).includes(r.token))
          )
            hits.push(p);
        }
      };
      walk(r.root);
      expect(hits).toEqual([]);
    } finally {
      await r.close();
    }
  }, 60_000);

  it("a prompt with @file, $skill, /command or !shell reaches the model as plain text, nothing expanded", async () => {
    const r = await realRun(() => sse.text("ok"));
    try {
      const conn = path.join(r.root, "conn");
      // Inside its own folder, so the OS sandbox would allow reading: only codex's settings stop it. The skill
      // is planted before the start (the start removes it — nothing can write it there afterwards).
      fs.mkdirSync(conn, { recursive: true });
      fs.writeFileSync(path.join(conn, "other.txt"), "OTHER-MARKER");
      for (const d of [
        "work/.agents/skills/planted",
        "home/.agents/skills/planted",
        "codex-home/skills/planted",
      ]) {
        fs.mkdirSync(path.join(conn, d), { recursive: true });
        fs.writeFileSync(
          path.join(conn, d, "SKILL.md"),
          "---\nname: planted\ndescription: x\n---\nSKILL-MARKER\n",
        );
      }
      const s = await r.a.start(r.c);
      const text = "@../other.txt @other.txt $planted /init !cat ../other.txt";
      await collect(s.turn({ text, model: "gpt-6.1-sol" }).events);
      await s.close();
      for (const body of r.fake.requests) {
        const p = promptText(body);
        expect(p).not.toContain("OTHER-MARKER");
        expect(p).not.toContain("SKILL-MARKER");
        expect(p).not.toContain("<skill>");
      }
      expect(promptText(r.fake.requests[0]!)).toContain(JSON.stringify(text).slice(1, -1));
    } finally {
      await r.close();
    }
  }, 60_000);

  it("resumes a thread in a new process: history once, same instructions, earlier turns kept", async () => {
    const r = await realRun(() => sse.text("OK"));
    try {
      const history = [{ role: "user" as const, parts: [{ type: "text" as const, text: "HISTORY-MARKER" }] }];
      const s = await r.a.start({ ...r.c, history });
      await collect(s.turn({ text: "FIRST-TURN", model: "gpt-6.1-sol" }).events);
      await s.close();
      const s2 = await r.a.resume(s.externalSessionId, { ...r.c, history });
      expect(s2.externalSessionId).toBe(s.externalSessionId);
      await collect(s2.turn({ text: "SECOND-TURN", model: "gpt-6-luna" }).events);
      await s2.close();
      const last = r.fake.requests.at(-1)!;
      const p = promptText(last);
      expect(p.split("HISTORY-MARKER").length - 1).toBe(1);
      expect(p.split("You are Agent Lee.").length - 1).toBe(1);
      expect(p).toContain("FIRST-TURN");
      expect(last.model).toBe("gpt-6-luna");
      await expect(r.a.resume("01a1c86a-c0b6-7ea2-a83e-ebd779e7ca02", r.c)).rejects.toBeInstanceOf(
        SessionGoneError,
      );
    } finally {
      await r.close();
    }
  }, 60_000);

  it("two sessions of the same user at once (two conversations) both run, each with its own tools", async () => {
    const r = await realRun(() => sse.text("OK"), { tools: ["echo_time", "skill_selftest"] });
    try {
      const [s1, s2] = await Promise.all([
        r.a.start({ ...r.c, tools: ["echo_time"] }),
        r.a.start({ ...r.c, tools: ["skill_selftest"] }),
      ]);
      const [e1, e2] = await Promise.all([
        collect(s1.turn({ text: "one", model: "gpt-6.1-sol" }).events),
        collect(s2.turn({ text: "two", model: "gpt-6.1-sol" }).events),
      ]);
      expect(e1.some((e) => e.type === "text_delta")).toBe(true);
      expect(e2.some((e) => e.type === "text_delta")).toBe(true);
      const toolsOf = (word: string) =>
        offeredTools(r.fake.requests.find((b) => promptText(b).includes(`"${word}"`))!).filter((t) =>
          t.startsWith("mcp__"),
        );
      expect(toolsOf("one")).toEqual(["mcp__agentlee.echo_time"]);
      expect(toolsOf("two")).toEqual(["mcp__agentlee.skill_selftest"]);
      await Promise.all([s1.close(), s2.close()]);
    } finally {
      await r.close();
    }
  }, 60_000);

  it("an interrupt while our tool runs stops the turn promptly", async () => {
    const r = await realRun(
      (n) => (n === 0 ? sse.call("skill_selftest", { text: "a" }, "mcp__agentlee") : sse.text("after")),
      { tools: ["echo_time", "skill_selftest"], slowSkillMs: 20_000 },
    );
    try {
      const s = await r.a.start(r.c);
      const turn = s.turn({ text: "slow", model: "gpt-6.1-sol" });
      let at = 0;
      const ev: RuntimeEvent[] = [];
      for await (const e of turn.events) {
        ev.push(e);
        if (e.type === "tool_start") {
          at = Date.now();
          void turn.interrupt();
        }
      }
      expect(at).toBeGreaterThan(0);
      expect(Date.now() - at).toBeLessThan(3000);
      expect(ev.some((e) => e.type === "text_delta")).toBe(false);
      await s.close();
    } finally {
      await r.close();
    }
  }, 60_000);

  it.skipIf(!online)(
    "reaches the API only through the egress proxy; a bad key fails at once as runtime_auth; the key is never written",
    async () => {
      const root = tmp();
      const connects: string[] = [];
      const egress = new EgressService({
        allow: CODEX_EGRESS_HOSTS,
        connect: (ip, port) => {
          connects.push(`${ip}:${port}`);
          return net.connect({ host: ip, port });
        },
      });
      const a = new CodexAdapter({
        connection: () => ({ id: "t", dir: path.join(root, "conn"), auth: { kind: "api_key", apiKey: KEY } }),
        egress,
      });
      try {
        const s = await a.start(ctx({ mcp: undefined, tools: [] }));
        const t0 = Date.now();
        await expect(collect(s.turn({ text: "hi", model: "gpt-6.1-sol" }).events)).rejects.toMatchObject({
          code: "runtime_auth",
        });
        expect(Date.now() - t0).toBeLessThan(15_000); // not the binary's ~40 s of retries
        await s.close();
      } finally {
        await egress.close();
      }
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
      expect(fs.existsSync(path.join(root, "conn", "codex-home", "sessions"))).toBe(true); // it did run
      expect(fs.existsSync(path.join(root, "conn", "codex-home", "auth.json"))).toBe(false);
      expect(hits).toEqual([]);
    },
    60_000,
  );

  it("its sandbox: the real home, another family member's folder, its own work/home folders (writing) and child processes are out of reach", async () => {
    const { a, log, root } = adapter({ x: cx.answer("ok") });
    await collect((await a.start(ctx())).turn({ text: "x", model: "gpt-6.1-sol" }).events);
    const policy = { ...log.spawns[0]!, command: process.execPath };
    const fakeHome = path.join(root, "real-home");
    fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, ".codex", "auth.json"), "HOME-MARKER");
    const other = path.join(root, "other-user");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "x"), "OTHER-MARKER");
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
    for (const f of [path.join(fakeHome, ".codex", "auth.json"), path.join(other, "x")])
      expect(
        await probe(
          `try{process.stdout.write(require("fs").readFileSync(${JSON.stringify(f)},"utf8"))}catch(e){process.stdout.write("ERR "+e.code)}`,
        ),
      ).toMatch(/^ERR/);
    expect(
      await probe(
        `try{const c=require("child_process").spawn("/bin/echo",["x"]);c.on("error",e=>process.stdout.write("ERR "+e.code));c.on("spawn",()=>process.stdout.write("SPAWNED"))}catch(e){process.stdout.write("ERR "+e.code)}`,
      ),
    ).toMatch(/^ERR/);
    // It cannot plant instruction or skill files where codex would look for them.
    for (const d of ["work", "home"])
      expect(
        await probe(
          `try{require("fs").writeFileSync(${JSON.stringify(path.join(root, "conn", d, "AGENTS.md"))},"x");process.stdout.write("WROTE")}catch(e){process.stdout.write("ERR "+e.code)}`,
        ),
      ).toMatch(/^ERR/);
    fs.writeFileSync(path.join(root, "conn", "own.txt"), "OWN");
    expect(
      await probe(
        `process.stdout.write(require("fs").readFileSync(${JSON.stringify(path.join(root, "conn", "own.txt"))},"utf8"))`,
      ),
    ).toBe("OWN");
  });
});

// Recorded with the real runtime and our MCP server (test/record-codex.ts); absent until recorded once.
const toolsFixture = path.join(import.meta.dirname, "fixtures", "codex-tools.json");
describe.skipIf(!fs.existsSync(toolsFixture))(
  "Codex adapter (#16): our MCP tools through the recorded runtime",
  () => {
    it("echo_time and the verification skill come out as common tool events", async () => {
      const f = JSON.parse(fs.readFileSync(toolsFixture, "utf8")) as { prompt: string; recording: Recording };
      const { a } = adapter(f.recording);
      const ev = await collect(
        (await a.start(ctx({ tools: ["echo_time", "skill_selftest"] }))).turn({
          text: f.prompt,
          model: "gpt-6-luna",
        }).events,
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
