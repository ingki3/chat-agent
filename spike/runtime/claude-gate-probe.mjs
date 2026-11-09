// Spike #39 — which mechanism reliably gates a built-in tool in the Claude Agent SDK?
import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { cleanEnv, save } from "./lib.mjs";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-gate-"));
async function run(prompt, extra) {
  const cb = [], hook = [];
  const opts = { cwd: work, env: cleanEnv(), settingSources: [], model: "claude-opus-5-5",
    canUseTool: async (name, input) => { cb.push(name); return { behavior: "deny", message: "blocked by policy" }; }, ...extra(hook) };
  const out = { toolUses: [], toolResults: [], callbacks: cb, hookCalls: hook };
  for await (const m of query({ prompt, options: opts })) {
    if (m.type === "assistant") for (const b of m.message.content) if (b.type === "tool_use") out.toolUses.push(b.name);
    if (m.type === "user" && Array.isArray(m.message?.content)) for (const b of m.message.content) if (b.type === "tool_result") out.toolResults.push(JSON.stringify(b.content).slice(0, 120));
  }
  return out;
}
const readOnly = "Run the shell command `echo agentlee-probe` with the Bash tool and report its output.";
const writing = "Run the shell command `touch agentlee-written.txt` with the Bash tool and report whether it worked.";
const denyHook = (hook) => ({ hooks: { PreToolUse: [{ hooks: [async (input) => { hook.push(input.tool_name); return input.tool_name.startsWith("mcp__") ? {} : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "blocked by Agent Lee" } }; }] }] } });
const res = {};
res.callback_readonly_cmd = await run(readOnly, () => ({ tools: ["Bash"] }));
res.callback_writing_cmd = await run(writing, () => ({ tools: ["Bash"] }));
res.wroteFile = fs.existsSync(path.join(work, "agentlee-written.txt"));
res.hook_readonly_cmd = await run(readOnly, (h) => ({ tools: ["Bash"], ...denyHook(h) }));
res.disallowed_readonly_cmd = await run(readOnly, () => ({ tools: ["Bash"], disallowedTools: ["Bash"] }));
res.empty_tools = await run(readOnly, () => ({ tools: [] }));
save("claude-gate", res);
