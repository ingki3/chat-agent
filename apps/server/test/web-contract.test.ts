import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { SELFTEST_SKILL } from "@agentlee/mcp-tools/skills";
import { UserStore } from "../src/auth/users.js";
import { ConversationStore } from "../src/conversations/store.js";
import { createTestDb } from "../src/db/client.js";
import { McpTokens } from "../src/isolation/tokens.js";
import { McpService } from "../src/mcp/service.js";
import type { RuntimeAdapter, RuntimeEvent, StartContext } from "../src/runtime/adapter.js";
import { ClaudeAdapter } from "../src/runtime/claude.js";
import { CODEX_MODELS, CodexAdapter } from "../src/runtime/codex.js";
import { SourceStore } from "../src/web/sources.js";
import type { SearchProvider } from "../src/web/service.js";
import { replayQuery, sdk, type ReplayLog } from "./helpers/claude-replay.js";
import { cx, newLog, replaySpawn } from "./helpers/codex-replay.js";
import { liveCall } from "./helpers/live-mcp.js";
import { startWebFixture } from "./helpers/web-fixture.js";

/**
 * #50 completion criterion: in both runtimes, search → fetch → sources stored. Each runtime is scripted (its
 * recorded protocol), the tool calls are real: the scripted Claude CLI goes through the PreToolUse hook and the
 * `mcpServers` the adapter configured, the scripted codex app-server through `enabled_tools` and the token in its
 * environment — to our MCP server, whose web_fetch runs the real worker through the real web egress proxy (name
 * resolution and upstream stubbed: tests/helpers/web-fixture.ts). The search provider is a stub (live providers
 * need the network and, for google-news, an installed skill). Real-runtime recordings need credentials: deferred.
 */

const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "web-contract-"));
  closers.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

const PROMPT = "반도체 수출 뉴스 찾아서 읽어 줘";
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

async function setup() {
  const fx = await startWebFixture();
  closers.push(() => fx.close());
  const db = createTestDb();
  const users = new UserStore(db);
  const conversations = new ConversationStore(db);
  const sources = new SourceStore(db);
  const son = users.create({
    email: "son@example.com",
    name: "아들",
    role: "member",
    passwordHash: "x",
    youth: true,
  });
  const provider: SearchProvider = {
    name: "test-news",
    search: async (q) => ({
      ok: true,
      hits: [
        {
          url: "http://public.test/article.html",
          title: `${q} — 예시 신문`,
          site: "예시 신문",
          snippet: "11월 반도체 수출이 사상 최대",
        },
      ],
    }),
  };
  const tokens = new McpTokens();
  const svc = new McpService(tokens, users, {
    skills: [SELFTEST_SKILL],
    web: {
      sources,
      worker: fx.worker,
      fetchProxy: { endpoint: async () => fx.proxy, close: async () => {} },
      searchProviders: [provider],
    },
  });
  closers.push(() => svc.close());

  const turn = async (adapter: RuntimeAdapter) => {
    const c = conversations.create(son.id);
    const { url } = await svc.endpoint();
    const runId = crypto.randomUUID();
    const ctx: StartContext = {
      conversationId: c.id,
      userId: son.id,
      history: [],
      systemPrompt: "You are Agent Lee.",
      model: adapter.capabilities().models[0]!.id,
      tools: svc.toolNamesFor(son.id),
      mcp: { url, token: tokens.issue({ userId: son.id, conversationId: c.id, runId }) },
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
    return { conversationId: c.id, runId, results, failure, fx };
  };
  return { turn, sources, fx };
}

const CALLS: Call[] = [
  { id: "t1", tool: "web_search", args: { query: "반도체 수출", maxResults: 3 } },
  { id: "t2", tool: "web_fetch", args: { url: "http://public.test/article.html" } },
  // The runtime may be talked into this by a page; our server refuses it in both.
  { id: "t3", tool: "web_fetch", args: { url: "http://169.254.169.254/latest/meta-data/" } },
];

/** A tool result as JSON (the adapters hand our MCP text content through). */
const json = (r: { output: unknown }) => {
  const o = r.output;
  const text = typeof o === "string" ? o : JSON.stringify(o);
  return JSON.parse(text) as Record<string, unknown>;
};

describe("web search → fetch → sources through both runtimes (#50)", () => {
  it("Claude Code and Codex: same results, and both conversations end with the same stored sources", async () => {
    const { turn, sources, fx } = await setup();
    const a = await turn(claude(CALLS));
    const b = await turn(codex(CALLS));
    for (const r of [a, b]) {
      expect(r.failure).toBeUndefined();
      const search = json(r.results.t1!);
      const page = json(r.results.t2!);
      const rows = sources.list(r.conversationId);
      expect(rows.map((x) => [x.kind, x.url, x.runId])).toEqual([
        ["search", "http://public.test/article.html", r.runId],
        ["page", "http://public.test/article.html", r.runId],
      ]);
      expect((search.results as { sourceId: string }[])[0]!.sourceId).toBe(rows[0]!.id);
      expect(page).toMatchObject({
        sourceId: rows[1]!.id,
        site: "예시 신문",
        finalUrl: "http://public.test/article.html",
      });
      expect(rows[1]!.body).toContain("11월 반도체 수출이 전년 대비 32% 늘어 사상 최대를 기록했다.");
      expect(rows[1]!.bodyHash).toBe(crypto.createHash("sha256").update(rows[1]!.body!).digest("hex"));
      expect(r.results.t3!.isError).toBe(true);
      expect(json(r.results.t3!)).toEqual({ error: "web_blocked" });
    }
    // The same tool answers from both runtimes, apart from the per-conversation source ids.
    const noIds = (r: typeof a) =>
      JSON.parse(JSON.stringify(r.results, (k, v: unknown) => (k === "sourceId" ? "<id>" : v))) as unknown;
    expect(noIds(b)).toEqual(noIds(a));
    expect(fx.leaks).toEqual([]);
  });
});
