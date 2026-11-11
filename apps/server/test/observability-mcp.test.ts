import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { CSRF_HEADER, RecentErrorsResponse, type Run, type StartRunResponse } from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import {
  RuntimeRegistry,
  type RuntimeAdapter,
  type RuntimeEvent,
  type RuntimeSession,
} from "../src/runtime/adapter.js";
import { createFamily } from "./helpers/permission-matrix.js";

// Deliberately no registerToolNames() here: the names must come from the real McpService wiring in buildApp.

type App = Awaited<ReturnType<typeof buildApp>>;
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

/** Reports our MCP tools the way runtimes name them; skill_selftest fails. */
class McpCallingRuntime implements RuntimeAdapter {
  readonly id = "claude-code" as const;
  capabilities() {
    return {
      models: [{ id: "m1", label: "M1", efforts: [] }],
      canSwitchModelInSession: true,
      canResume: false,
    };
  }
  async resume(): Promise<RuntimeSession> {
    throw new Error("no resume");
  }
  async start(): Promise<RuntimeSession> {
    return {
      externalSessionId: "mcp-1",
      setModel: async () => {},
      close: async () => {},
      turn: () => {
        async function* events(): AsyncGenerator<RuntimeEvent> {
          yield { type: "tool_start", callId: "a", name: "mcp__agentlee__echo_time", input: {} };
          yield { type: "tool_end", callId: "a", output: {} };
          yield { type: "tool_start", callId: "b", name: "mcp__agentlee__skill_selftest", input: {} };
          yield { type: "tool_end", callId: "b", output: "x", isError: true };
          yield { type: "tool_start", callId: "c", name: "mcp__agentlee__not_ours", input: {} };
          yield { type: "tool_end", callId: "c", output: "x", isError: true };
          yield { type: "text_delta", text: "done" };
        }
        return { events: events(), interrupt: async () => {} };
      },
    };
  }
}

describe("our MCP tool names", () => {
  it("are kept in the log and the recent-error list without any test-only registration", async () => {
    const lines: string[] = [];
    const runtimes = new RuntimeRegistry();
    runtimes.register(new McpCallingRuntime());
    const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
      db: createTestDb(),
      logStream: new Writable({ write: (c, _e, cb) => (lines.push(String(c)), cb()) }),
      runtimes,
      runs: { flushMs: 0 },
    });
    apps.push(app);
    const f = await createFamily(app);
    const h = (cookie: string) => ({
      host: "localhost:3000",
      cookie,
      origin: "http://localhost:3000",
      [CSRF_HEADER]: "1",
      "content-type": "application/json",
    });
    const conv = app.conversations!.create(f.users.owner.id);
    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conv.id}/messages`,
      headers: h(f.cookies.owner),
      payload: { text: "hi" },
    });
    const runId = res.json<StartRunResponse>().run.id;
    for (let i = 0; i < 400; i++) {
      const r = (await app.inject({ url: `/api/runs/${runId}`, headers: h(f.cookies.owner) })).json<Run>();
      if (r.endedAt !== null) break;
      await new Promise((r2) => setTimeout(r2, 10));
    }
    const tools = lines
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { msg?: string; tool?: string; status?: string })
      .filter((r) => r.msg === "tool.finished")
      .map((r) => [r.tool, r.status]);
    expect(tools).toEqual([
      ["mcp__agentlee__echo_time", "ok"],
      ["mcp__agentlee__skill_selftest", "error"],
      ["other", "error"],
    ]);
    const list = await app.inject({ url: "/api/admin/errors?source=tool", headers: h(f.cookies.admin) });
    const names = RecentErrorsResponse.parse(list.json()).errors.map((e) => e.tool);
    expect(names.sort()).toEqual(["mcp__agentlee__skill_selftest", "other"]);
  });
});
