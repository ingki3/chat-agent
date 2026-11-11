import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  GOOGLE_NEWS_SKILL,
  KR_STOCK_SKILL,
  SELFTEST_SKILL,
  type BundledSkill,
  type SkillSpec,
} from "@agentlee/mcp-tools/skills";
import { McpTokens } from "../src/isolation/tokens.js";
import { McpService, type SkillRunner } from "../src/mcp/service.js";
import {
  RuntimeFailure,
  type RuntimeAdapter,
  type RuntimeEvent,
  type StartContext,
} from "../src/runtime/adapter.js";
import { ClaudeAdapter } from "../src/runtime/claude.js";
import { CODEX_MODELS, CodexAdapter } from "../src/runtime/codex.js";
import { replayQuery, sdk, type ReplayLog } from "./helpers/claude-replay.js";
import { cx, newLog, replaySpawn } from "./helpers/codex-replay.js";
import { liveCall } from "./helpers/live-mcp.js";

/**
 * #21 completion criterion: the same tool call through both runtimes gives the same result. Each runtime is
 * scripted (its recorded protocol), but the tool call itself is real: the scripted Claude CLI asks the PreToolUse
 * hook the adapter configured and calls our MCP server from the adapter's `mcpServers`; the scripted codex
 * app-server calls it only for tools in the adapter's `enabled_tools`, with the token from its environment. So
 * the adapters' tool paths, the run-scoped token, the per-user tool list and the MCP server are all the real ones.
 * A recording of the real runtimes doing this needs credentials (test/record-*.ts, docs/ops.md) and is deferred.
 */

const isMac = process.platform === "darwin";
const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "skills-contract-"));
  closers.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const at = (spec: SkillSpec): BundledSkill => ({ ...spec, dir: "/nonexistent", entry: "/nonexistent/x" });

const PROMPT = "도구를 써 줘";
type Call = { id: string; tool: string; args: Record<string, unknown> };

function claude(calls: Call[]): RuntimeAdapter {
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
          ...calls.map((c) => liveCall(c.id, c.tool, c.args) as unknown as SDKMessage),
          sdk.delta("끝"),
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

function codex(calls: Call[]): RuntimeAdapter {
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
            ...calls.map((c) => liveCall(c.id, c.tool, c.args) as unknown as Record<string, unknown>),
            cx.delta("끝"),
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

type Users = Record<
  string,
  { id: string; name: string; active: boolean; permissions: { skills: "all" | string[] } }
>;
function setup(runSkill?: SkillRunner, skills: BundledSkill[] = [SELFTEST_SKILL]) {
  const users: Users = {
    "u-mom": { id: "u-mom", name: "엄마", active: true, permissions: { skills: "all" } },
    "u-son": {
      id: "u-son",
      name: "아들",
      active: true,
      permissions: { skills: ["google-news-search-skill"] },
    },
  };
  const tokens = new McpTokens();
  const svc = new McpService(
    tokens,
    { byId: (id: string) => users[id] as never },
    {
      skills,
      python: { exe: "/opt/py/bin/python3.12", root: "/opt/py" },
      ...(runSkill ? { runSkill } : {}),
    },
  );
  closers.push(() => svc.close());
  /** One turn of `adapter` for `userId`, with the run's real tool list and token. */
  const turn = async (adapter: RuntimeAdapter, userId: string) => {
    const { url } = await svc.endpoint();
    const runId = crypto.randomUUID();
    const ctx: StartContext = {
      conversationId: "c-1",
      userId,
      history: [],
      systemPrompt: "You are Agent Lee.",
      model: adapter.capabilities().models[0]!.id,
      tools: svc.toolNamesFor(userId),
      mcp: { url, token: tokens.issue({ userId, conversationId: "c-1", runId }) },
    };
    const s = await adapter.start(ctx);
    const events: RuntimeEvent[] = [];
    let failure: unknown;
    try {
      for await (const e of s.turn({ text: PROMPT, model: ctx.model }).events) events.push(e);
    } catch (e) {
      failure = e;
    } finally {
      await s.close();
      tokens.revokeRun(runId);
    }
    const results = Object.fromEntries(
      events.flatMap((e) =>
        e.type === "tool_end" ? [[e.callId, { output: e.output, isError: e.isError === true }]] : [],
      ),
    );
    const started = events.flatMap((e) => (e.type === "tool_start" ? [e.name] : []));
    return { events, results, started, failure };
  };
  return { svc, turn };
}

describe("the same skill call through both runtimes gives the same result (#21)", () => {
  it("allowed calls: identical tool results from Claude Code and Codex, straight from our MCP server", async () => {
    const seen: string[] = [];
    const runSkill: SkillRunner = async (s, input, scope) => {
      seen.push(`${scope.userId}:${s.name}`);
      return { ok: true, output: { skill: s.name, input, user: scope.userId } };
    };
    const { turn } = setup(runSkill, [SELFTEST_SKILL, at(GOOGLE_NEWS_SKILL), at(KR_STOCK_SKILL)]);
    const calls: Call[] = [
      { id: "t1", tool: "skill_kr-stock-skill", args: { command: "stock", code: "005930" } },
      { id: "t2", tool: "skill_google-news-search-skill", args: { query: "삼성전자", maxResults: 3 } },
      { id: "t3", tool: "skill_selftest", args: { text: "같은 결과" } },
      // Refused by our server in both: arguments that do not fit the skill.
      { id: "t4", tool: "skill_kr-stock-skill", args: { command: "stock", code: "KOSPI" } },
      { id: "t5", tool: "echo_time", args: {} },
    ];
    const a = await turn(claude(calls), "u-mom");
    const b = await turn(codex(calls), "u-mom");
    expect(a.failure).toBeUndefined();
    expect(b.failure).toBeUndefined();
    expect(a.started).toEqual(calls.map((c) => c.tool));
    expect(b.started).toEqual(a.started);
    // echo_time carries the current time: compare it without the clock.
    const timeless = (r: Record<string, { output: unknown; isError: boolean }>) =>
      JSON.parse(
        JSON.stringify(r, (k, v: unknown) => (k === "now" || k === "local" ? "<time>" : v)),
      ) as unknown;
    expect(timeless(b.results)).toEqual(timeless(a.results));
    expect(a.results.t1).toEqual({
      output: { skill: "kr-stock-skill", input: { command: "stock", code: "005930" }, user: "u-mom" },
      isError: false,
    });
    expect(a.results.t4).toEqual({ output: { error: "skill_bad_input" }, isError: true });
    expect((a.results.t5!.output as { userName: string }).userName).toBe("엄마");
    expect(seen).toEqual([
      "u-mom:kr-stock-skill",
      "u-mom:google-news-search-skill",
      "u-mom:selftest",
      "u-mom:kr-stock-skill",
      "u-mom:google-news-search-skill",
      "u-mom:selftest",
    ]);
  });

  it("a hidden finance skill: neither runtime may call it (fail closed), and the server would refuse it too", async () => {
    let ran = 0;
    const { svc, turn } = setup(async () => {
      ran++;
      return { ok: true, output: {} };
    }, [SELFTEST_SKILL, at(GOOGLE_NEWS_SKILL), at(KR_STOCK_SKILL)]);
    expect(svc.toolNamesFor("u-son")).not.toContain("skill_kr-stock-skill");
    const calls: Call[] = [
      { id: "t1", tool: "skill_kr-stock-skill", args: { command: "stock", code: "005930" } },
    ];
    const a = await turn(claude(calls), "u-son");
    const b = await turn(codex(calls), "u-son");
    for (const r of [a, b]) {
      expect(r.failure).toBeInstanceOf(RuntimeFailure);
      expect((r.failure as RuntimeFailure).code).toBe("runtime_policy");
    }
    expect(ran).toBe(0);
  });

  it.skipIf(!isMac)(
    "the real sandboxed verification skill gives the same result through both (macOS)",
    async () => {
      const { turn } = setup();
      const text = "두 런타임 ✓";
      const calls: Call[] = [{ id: "t1", tool: "skill_selftest", args: { text } }];
      const a = await turn(claude(calls), "u-son");
      const b = await turn(codex(calls), "u-son");
      expect(a.results.t1).toEqual({
        output: {
          characters: [...text].length,
          sha256: crypto.createHash("sha256").update(text).digest("hex"),
          reversed: [...text].reverse().join(""),
        },
        isError: false,
      });
      expect(b.results).toEqual(a.results);
    },
  );
});
