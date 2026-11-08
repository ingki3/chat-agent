// Spike #39 — Codex SDK capability probes. Run: node codex-probe.mjs [test...]
import { Codex } from "@openai/codex-sdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanEnv, save, ECHO } from "./lib.mjs";

const MODEL = "gpt-6.1-sol";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-codex-"));

// Locked-down config: our MCP only; shell/exec/plugins/apps/browser features off; no user config.
const LOCKED = {
  mcp_servers: { echo: { command: process.execPath, args: [ECHO], env: { AGENTLEE_RUN_TOKEN: "run-456" }, default_tools_approval_mode: "approve" } },
  features: { shell_tool: false, unified_exec: false, plugins: false, apps: false, browser_use: false, computer_use: false, memories: false },
};
function codex({ env = {}, config = LOCKED } = {}) {
  return new Codex({ env: cleanEnv(env), config, configOverrides: ["--ignore-user-config"].length ? [] : [] });
}
const threadOpts = (extra = {}) => ({ model: MODEL, workingDirectory: work, skipGitRepoCheck: true, sandboxMode: "read-only", approvalPolicy: "never", networkAccessEnabled: false, webSearchMode: "disabled", modelReasoningEffort: "low", ...extra });

async function run(thread, input, { abortAfterItems } = {}) {
  const ac = new AbortController();
  const out = { events: {}, agentUpdates: 0, items: [], text: "", usage: null, threadId: null, errors: [] };
  try {
    const { events } = await thread.runStreamed(input, { signal: ac.signal });
    for await (const e of events) {
      out.events[e.type] = (out.events[e.type] ?? 0) + 1;
      if (e.type === "thread.started") out.threadId = e.thread_id;
      if (e.type === "item.updated" && e.item.type === "agent_message") out.agentUpdates++;
      if (e.type === "item.completed") {
        out.items.push(e.item.type === "mcp_tool_call" ? `mcp:${e.item.server}/${e.item.tool}:${e.item.status}` : e.item.type === "command_execution" ? `cmd:${e.item.command}:${e.item.status}` : e.item.type);
        if (e.item.type === "agent_message") out.text += e.item.text;
        if (abortAfterItems && out.items.length >= abortAfterItems) ac.abort();
      }
      if (e.type === "turn.completed") out.usage = e.usage;
      if (e.type === "turn.failed" || e.type === "error") out.errors.push(JSON.stringify(e).slice(0, 300));
    }
  } catch (e) { out.errors.push(String(e?.message ?? e).slice(0, 400)); }
  out.text = out.text.slice(0, 400);
  return out;
}

const tests = {
  async stream() {
    const t = codex().startThread(threadOpts());
    const r = await run(t, "Count from 1 to 30 separated by spaces. Then call the echo_time tool with tag 'x1' and report its output.");
    save("codex-stream", { ...r, threadId: t.id ?? r.threadId });
  },
  async resume() {
    const first = JSON.parse(fs.readFileSync(new URL("./results/codex-stream.json", import.meta.url)));
    const t = codex().resumeThread(first.threadId, threadOpts());
    const r = await run(t, "What tag did you pass to echo_time earlier in this conversation? Answer with the tag only.");
    save("codex-resume", { resumedFrom: first.threadId, ...r });
  },
  async modelswitch() {
    // Same thread id resumed with a different reasoning effort (model change across turns).
    const c = codex();
    const t1 = c.startThread(threadOpts());
    const a = await run(t1, "Remember the word PINEAPPLE. Reply 'noted'.");
    const t2 = c.resumeThread(t1.id ?? a.threadId, threadOpts({ modelReasoningEffort: "high" }));
    const b = await run(t2, "What word did I ask you to remember? One word.");
    save("codex-modelswitch", { first: a.text, second: b.text, usage2: b.usage, errors: [...a.errors, ...b.errors] });
  },
  async lockdown() {
    const t = codex().startThread(threadOpts());
    const r = await run(t, "Use any tool you have to run the shell command `ls ~` and to read ~/.zshrc, then tell me the first line of that file. If you cannot, list exactly which tools you have.");
    save("codex-lockdown", r);
  },
  async readonly_default() {
    // Control: default features (shell on) with read-only sandbox — does it still read files outside cwd?
    const t = codex({ config: { features: { plugins: false, apps: false } } }).startThread(threadOpts());
    const r = await run(t, "Run `head -1 ~/.zshrc` and tell me only whether it succeeded (do not print the content).");
    save("codex-readonly-default", { items: r.items, text: r.text, errors: r.errors });
  },
  async codexhome() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-codexhome-"));
    const t = codex({ env: { CODEX_HOME: home } }).startThread(threadOpts());
    const r = await run(t, "Say OK.");
    save("codex-codexhome", { home, filesAfter: fs.readdirSync(home), text: r.text, errors: r.errors });
  },
  async effort() {
    const res = {};
    for (const eff of ["minimal", "low", "high", "max"]) {
      const t = codex().startThread(threadOpts({ modelReasoningEffort: eff }));
      const r = await run(t, "Say OK.");
      res[eff] = { text: r.text, errors: r.errors, reasoning: r.usage?.reasoning_output_tokens };
    }
    save("codex-effort", res);
  },
  async abort() {
    const t0 = Date.now();
    const t = codex().startThread(threadOpts());
    const r = await run(t, "Call echo_time three times with tags a, b, c, one at a time, then write a 600-word essay on the printing press.", { abortAfterItems: 1 });
    save("codex-abort", { items: r.items, ms: Date.now() - t0, events: r.events, errors: r.errors });
  },
};

const which = process.argv.slice(2).filter((a) => a !== "lockdown2").length || process.argv.includes("lockdown2") ? process.argv.slice(2).filter((a) => a !== "lockdown2") : Object.keys(tests);
const _unused = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(tests);
for (const t of which) { console.log(`-- ${t}`); try { await tests[t](); } catch (e) { save(`codex-${t}`, { fatal: String(e?.stack ?? e).slice(0, 800) }); } }

// lockdown2: same as lockdown but also disable MCP servers inherited from the user's config.toml
// (stand-in for a fully isolated CODEX_HOME, which needs its own login).
if (process.argv.includes("lockdown2")) {
  const c = new Codex({ env: cleanEnv(), config: { ...LOCKED, mcp_servers: { ...LOCKED.mcp_servers, node_repl: { enabled: false } } } });
  const t = c.startThread(threadOpts());
  const r = await run(t, "Use any tool you have to run the shell command `ls ~` and to read ~/.zshrc, then tell me the first line of that file. If you cannot, list exactly which tools you have.");
  save("codex-lockdown2", r);
}
