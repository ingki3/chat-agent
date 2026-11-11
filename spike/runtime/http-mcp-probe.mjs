// #43: do the pinned runtimes reach our Streamable HTTP MCP server with a bearer token? Run: pnpm build, then
// node http-mcp-probe.mjs [claude|codex|both] (uses the admin subscription logins, like the other probes).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
const { startMcpServer } = await import(new URL("../../packages/mcp-tools/dist/index.js", import.meta.url).href);

const TOKEN = "probe_" + "x".repeat(37);
const seen = [];
const srv = await startMcpServer({
  authenticate: (t) => { seen.push(t === TOKEN ? "good" : "bad"); return t === TOKEN ? { userId: "u", conversationId: "c", runId: "r" } : undefined; },
  userName: () => "테스터",
  skills: [],
  runSkill: async () => ({ ok: false, code: "x" }),
});
const keep = ["PATH", "HOME", "LANG", "TMPDIR", "USER", "SHELL"];
const env = Object.fromEntries(keep.filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
const which = process.argv[2] ?? "both";
const out = {};
const prompt = "Call the echo_time tool once and reply with only the userName field it returned.";

if (which !== "codex") {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "al-probe-"));
  const r = { tools: null, mcp: null, text: "", toolUses: [], errors: [] };
  try {
    for await (const m of query({ prompt, options: {
      cwd: work, env, settingSources: [], tools: [], strictMcpConfig: true, model: "claude-haiku-5-5",
      mcpServers: { agentlee: { type: "http", url: srv.url, headers: { Authorization: `Bearer ${TOKEN}` } } },
      hooks: { PreToolUse: [{ hooks: [async (i) => i.tool_name.startsWith("mcp__agentlee__") ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "ours" } } : { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "no" } }] }] },
    } })) {
      if (m.type === "system" && m.subtype === "init") { r.tools = m.tools; r.mcp = m.mcp_servers; }
      if (m.type === "assistant") for (const b of m.message.content) { if (b.type === "text") r.text += b.text; if (b.type === "tool_use") r.toolUses.push(b.name); }
    }
  } catch (e) { r.errors.push(String(e?.message ?? e).slice(0, 300)); }
  out.claude = r;
}

if (which !== "claude") {
  const r = await new Promise((resolve) => {
    const p = spawn("codex", ["exec", "--skip-git-repo-check", "--json", "-s", "read-only",
      "-c", `mcp_servers.agentlee.url=${JSON.stringify(srv.url)}`,
      "-c", `mcp_servers.agentlee.bearer_token_env_var="AGENTLEE_MCP_TOKEN"`,
      "-c", `mcp_servers.agentlee.default_tools_approval_mode="approve"`,
      prompt], { env: { ...process.env, AGENTLEE_MCP_TOKEN: TOKEN }, cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"] });
    let so = ""; p.stdout.on("data", (c) => (so += c)); p.stderr.on("data", () => {});
    const t = setTimeout(() => p.kill(), 180000);
    p.on("close", (code) => { clearTimeout(t); resolve({ code, events: so.split("\n").filter((l) => /mcp|agent_message/.test(l)).map((l) => l.slice(0, 300)).slice(-6) }); });
  });
  out.codex = r;
}
out.authSeen = [...new Set(seen)];
console.log(JSON.stringify(out, null, 1));
await srv.close();
