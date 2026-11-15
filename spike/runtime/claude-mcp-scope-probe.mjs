// Spike #39 — do claude.ai account connectors leak into SDK sessions, and how to shut them out?
import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { cleanEnv, save, ECHO } from "./lib.mjs";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-mcpscope-"));
const OURS = "mcp__echo__";
async function run(prompt, extra = {}) {
  const hookCalls = [];
  const opts = { cwd: work, env: cleanEnv(), settingSources: [], tools: [], model: "claude-opus-5-5",
    mcpServers: { echo: { type: "stdio", command: process.execPath, args: [ECHO] } },
    hooks: { PreToolUse: [{ hooks: [async (i) => { hookCalls.push(i.tool_name); return i.tool_name.startsWith(OURS) ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "blocked by Agent Lee" } }; }] }] },
    ...extra };
  const out = { mcpServers: null, nonOursTools: null, toolUses: [], toolResults: [], hookCalls };
  for await (const m of query({ prompt, options: opts })) {
    if (m.type === "system" && m.subtype === "init") { out.mcpServers = m.mcp_servers.map((s) => `${s.name}:${s.status}`); out.nonOursTools = m.tools.filter((t) => !t.startsWith(OURS)).length; }
    if (m.type === "assistant") for (const b of m.message.content) if (b.type === "tool_use") out.toolUses.push(b.name);
    if (m.type === "user" && Array.isArray(m.message?.content)) for (const b of m.message.content) if (b.type === "tool_result") out.toolResults.push(JSON.stringify(b.content).slice(0, 100));
  }
  return out;
}
const ask = "Call the claude.ai Claude Docs `guide` tool (any arguments) if you have it, and report whether the call succeeded. If you do not have it, say so.";
save("claude-mcp-scope", {
  default_with_hook: await run(ask),
  strictMcpConfig: await run(ask, { strictMcpConfig: true }),
});
