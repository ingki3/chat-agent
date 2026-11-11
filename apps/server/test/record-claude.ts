/**
 * Records the real Claude Code runtime once, for CI to replay (#15). Uses the credential from `.env`
 * (CLAUDE_OAUTH_TOKEN or CLAUDE_API_KEY), runs the CLI exactly as the server does (sandboxed, locked down),
 * and writes test/fixtures/claude-contract.json and claude-tools.json. Recordings hold SDK messages only — the
 * credential never appears in them (checked before writing).
 *
 *   pnpm --filter @agentlee/server exec tsx --conditions=development test/record-claude.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { config as loadEnv } from "dotenv";
import { McpTokens } from "../src/isolation/tokens.js";
import { McpService } from "../src/mcp/service.js";
import type { RuntimeEvent, StartContext } from "../src/runtime/adapter.js";
import { ClaudeAdapter, type ClaudeAuth } from "../src/runtime/claude.js";
import { recordingQuery, type Recording } from "./helpers/claude-replay.js";

loadEnv({ path: path.resolve(import.meta.dirname, "../../../.env"), quiet: true });
const token = process.env.CLAUDE_OAUTH_TOKEN;
const apiKey = process.env.CLAUDE_API_KEY;
if (!token && !apiKey) {
  console.error("Set CLAUDE_OAUTH_TOKEN or CLAUDE_API_KEY in .env first.");
  process.exit(2);
}
const auth: ClaudeAuth = token ? { kind: "oauth_token", token } : { kind: "api_key", apiKey: apiKey! };
const secret = token ?? apiKey!;
const MODEL = process.env.RECORD_MODEL ?? "claude-haiku-5-5";

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "claude-record-"));
const rec: Recording = {};
const adapter = new ClaudeAdapter({
  connection: () => ({ id: "record", dir: path.join(root, "conn"), auth }),
  query: recordingQuery(query, rec),
});
const ctx = (over: Partial<StartContext> = {}): StartContext => ({
  conversationId: "record",
  userId: "u-record",
  history: [],
  systemPrompt: "You are Agent Lee, a family assistant. Answer briefly.",
  model: MODEL,
  tools: [],
  ...over,
});
const collect = async (events: AsyncIterable<RuntimeEvent>) => {
  const out: RuntimeEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
};
const textOf = (ev: RuntimeEvent[]) => ev.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("");

const prompts = {
  short: "Say hello in Korean in one short sentence.",
  long: "Count from 1 to 200, separated by spaces.",
  remember: "My codename is 토마토. Reply only: OK",
  recall: "What is my codename? Reply with the codename only.",
};

// Contract prompts.
{
  const s = await adapter.start(ctx());
  console.log("short:", textOf(await collect(s.turn({ text: prompts.short, model: MODEL }).events)));
  await s.close();
  const l = await adapter.start(ctx());
  const turn = l.turn({ text: prompts.long, model: MODEL });
  const ev: RuntimeEvent[] = [];
  for await (const e of turn.events) {
    ev.push(e);
    if (ev.filter((x) => x.type === "text_delta").length === 3) void turn.interrupt();
  }
  console.log("long (interrupted):", ev.length, "events");
  await l.close();
  const r1 = await adapter.start(ctx());
  console.log("remember:", textOf(await collect(r1.turn({ text: prompts.remember, model: MODEL }).events)));
  await r1.close();
  const r2 = await adapter.resume(r1.externalSessionId, ctx());
  console.log("recall:", textOf(await collect(r2.turn({ text: prompts.recall, model: MODEL }).events)));
  await r2.close();
}
const contract = { prompts, recording: { ...rec } };

// Our MCP tools through the real runtime.
const toolRec: Recording = {};
const toolAdapter = new ClaudeAdapter({
  connection: () => ({ id: "record", dir: path.join(root, "conn"), auth }),
  query: recordingQuery(query, toolRec),
});
const tokens = new McpTokens();
const mcp = new McpService(tokens, { byId: () => ({ name: "녹화", active: true }) as never });
const { url } = await mcp.endpoint();
let mcpSecret = "";
const toolPrompt =
  "Call the echo_time tool, then call the skill_selftest tool with text 'agentlee'. Then reply with the userName and the sha256 you got.";
{
  const mcpToken = tokens.issue({ userId: "u-record", conversationId: "record", runId: "record-run" });
  mcpSecret = mcpToken;
  const s = await toolAdapter.start(ctx({ tools: mcp.toolNames(), mcp: { url, token: mcpToken } }));
  const ev = await collect(s.turn({ text: toolPrompt, model: MODEL }).events);
  console.log(
    "tools:",
    ev
      .filter((e) => e.type === "tool_start" || e.type === "tool_end")
      .map((e) => e.type + ":" + ("name" in e ? e.name : e.callId)),
  );
  console.log("tool answer:", textOf(ev));
  await s.close();
}
await mcp.close();

const fixtures = path.resolve(import.meta.dirname, "fixtures");
const write = (name: string, data: unknown) => {
  const json = JSON.stringify(data, null, 1);
  if (json.includes(secret) || (mcpSecret && json.includes(mcpSecret)))
    throw new Error(`refusing to write ${name}: it contains the credential`);
  fs.writeFileSync(path.join(fixtures, name), json + "\n");
};
write("claude-contract.json", { _note: `recorded ${new Date().toISOString()} with ${MODEL}`, ...contract });
write("claude-tools.json", {
  _note: `recorded ${new Date().toISOString()} with ${MODEL}`,
  prompt: toolPrompt,
  recording: toolRec,
});
fs.rmSync(root, { recursive: true, force: true });
console.log("written to", fixtures);
