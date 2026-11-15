import { Codex } from "@openai/codex-sdk";
import { cleanEnv, save, ECHO } from "./lib.mjs";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-codex-"));
const base = { mcp_servers: { echo: { command: process.execPath, args: [ECHO], default_tools_approval_mode: "approve" }, node_repl: { enabled: false } },
  features: { shell_tool: false, unified_exec: false, plugins: false, apps: false, browser_use: false, computer_use: false, memories: false } };
const out = {};
for (const [name, extra] of [["code_mode_on", {}], ["code_mode_off", { code_mode_host: false, code_mode: false }]]) {
  const c = new Codex({ env: cleanEnv(), config: { ...base, features: { ...base.features, ...extra } } });
  const t = c.startThread({ model: "gpt-6.1-sol", workingDirectory: work, skipGitRepoCheck: true, sandboxMode: "read-only", approvalPolicy: "never", modelReasoningEffort: "low", webSearchMode: "disabled" });
  const r = await t.run("Use the functions.exec tool (if you have it) to read the first line of the file at ~/.zshrc and report whether it worked (do not print the contents). Then list your tool names.");
  out[name] = { items: r.items.map((i) => i.type + (i.command ? ":" + i.command : "") + (i.tool ? ":" + i.tool : "") + (i.status ? ":" + i.status : "")), text: r.finalResponse.slice(0, 500) };
}
save("codex-exec", out);
