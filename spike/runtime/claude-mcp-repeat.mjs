import { query } from "@anthropic-ai/claude-agent-sdk";
import { cleanEnv, save, ECHO } from "./lib.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-rep-"));
const runs = [];
for (const strict of [false, false, false, true, true, true]) {
  const q = query({ prompt: "Say OK.", options: { cwd: work, env: cleanEnv(), settingSources: [], tools: [], model: "claude-haiku-5-5", strictMcpConfig: strict,
    mcpServers: { echo: { type: "stdio", command: process.execPath, args: [ECHO] } } } });
  for await (const m of q) if (m.type === "system" && m.subtype === "init") { runs.push({ strict, servers: m.mcp_servers.map((s) => `${s.name}:${s.status}`), nonEchoTools: m.tools.filter((t) => !t.startsWith("mcp__echo__")).length }); }
}
save("claude-mcp-repeat", runs);
