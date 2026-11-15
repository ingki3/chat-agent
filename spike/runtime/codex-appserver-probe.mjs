// Spike #39 — Codex app-server protocol probe (stdio JSON-RPC). Run: node codex-appserver-probe.mjs
// Verifies on the chosen integration path: token deltas, MCP call + blocked file access in the final
// locked-down config, model switch between turns, interrupt latency, model list, rate-limit read.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanEnv, save, ECHO } from "./lib.mjs";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-appsrv-"));
const LOCK = [
  `mcp_servers.echo.command="${process.execPath}"`, `mcp_servers.echo.args=["${ECHO}"]`,
  `mcp_servers.echo.default_tools_approval_mode="approve"`,
  `mcp_servers.node_repl.enabled=false`, // stand-in for an isolated CODEX_HOME (user config is merged otherwise)
  ...["shell_tool", "unified_exec", "plugins", "apps", "browser_use", "computer_use", "memories"].map((f) => `features.${f}=false`),
].flatMap((c) => ["-c", c]);

const proc = spawn("codex", ["app-server", ...LOCK], { env: cleanEnv(), stdio: ["pipe", "pipe", "pipe"] });
let buf = "", nextId = 1;
const pending = new Map(), listeners = new Set(), log = [];
proc.stdout.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1); if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); continue; }
    if (msg.id !== undefined && msg.method) { // server -> client request (approval etc.): decline
      log.push({ serverRequest: msg.method });
      proc.stdin.write(JSON.stringify({ id: msg.id, result: { decision: "decline" } }) + "\n"); continue;
    }
    for (const l of listeners) l(msg);
  }
});
proc.stderr.on("data", () => {});
const call = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); proc.stdin.write(JSON.stringify({ id, method, params }) + "\n"); });
const notify = (method, params) => proc.stdin.write(JSON.stringify({ method, params }) + "\n");

function runTurn(threadId, text, extra = {}, { interruptAfterDeltas } = {}) {
  return new Promise(async (resolve) => {
    const out = { deltas: 0, items: [], text: "", completed: null, firstDeltaMs: null, interrupt: null };
    const t0 = Date.now(); let turnId;
    const on = async (m) => {
      if (m.params?.threadId !== threadId) return;
      if (m.method === "item/agentMessage/delta") {
        out.deltas++; out.text += m.params.delta; out.firstDeltaMs ??= Date.now() - t0;
        if (interruptAfterDeltas && out.deltas === interruptAfterDeltas) {
          const ti = Date.now(); const r = await call("turn/interrupt", { threadId, turnId: m.params.turnId });
          out.interrupt = { requestedAtMs: ti - t0, ack: r.error ? r.error.message : "ok" };
        }
      }
      if (m.method === "item/completed") { const it = m.params.item; out.items.push(`${it.type}${it.tool ? ":" + it.server + "/" + it.tool : ""}${it.status ? ":" + it.status : ""}`); }
      if (m.method === "turn/completed") {
        listeners.delete(on);
        out.completed = { status: m.params.turn?.status, error: m.params.turn?.error?.message?.slice(0, 200) ?? null, atMs: Date.now() - t0 };
        if (out.interrupt) out.interrupt.stopLatencyMs = out.completed.atMs - out.interrupt.requestedAtMs;
        out.text = out.text.slice(0, 300); resolve(out);
      }
    };
    listeners.add(on);
    const r = await call("turn/start", { threadId, input: [{ type: "text", text, text_elements: [] }], ...extra });
    if (r.error) { listeners.delete(on); resolve({ startError: r.error.message }); }
    turnId = r.result?.turn?.id;
  });
}

const result = {};
const init = await call("initialize", { clientInfo: { name: "agent-lee-spike", version: "0.0.1", title: null }, capabilities: null });
result.initialize = init.error ? init.error.message : "ok";
notify("initialized", {});
const models = await call("model/list", { limit: 50 });
result.models = models.error ? models.error.message : models.result.data.map((m) => m.id ?? m.model);
const rl = await call("account/rateLimits/read", {});
result.rateLimitsRead = rl.error ? `error: ${rl.error.message}` : { keys: Object.keys(rl.result ?? {}), hasPrimary: !!rl.result?.rateLimits?.primary };

const th = await call("thread/start", { cwd: work, approvalPolicy: "never", sandbox: "read-only", ephemeral: false });
const threadId = th.result.thread.id;
result.threadStart = { model: th.result.model, effort: th.result.reasoningEffort };

result.turn1_mcp_and_lockdown = await runTurn(threadId,
  "First call the echo_time tool with tag 'a1'. Then try to read the file ~/.zshrc with any tool you have and report only whether that worked (never print file contents). Finally say the tag you used.",
  { model: "gpt-6.1-sol", effort: "low" });

const other = (result.models || []).find((m) => typeof m === "string" && m !== "gpt-6.1-sol");
result.turn2_model_switch = { requestedModel: other ?? null, ...(other ? await runTurn(threadId, "Which tag did you pass to echo_time earlier? Answer with the tag only.", { model: other, effort: "low" }) : { skipped: "no second model listed" }) };
const resumed = await call("thread/resume", { threadId });
result.threadResumeModel = resumed.error ? resumed.error.message : resumed.result?.model;

result.turn3_interrupt = await runTurn(threadId, "Write a 1500-word essay about the history of the printing press.", { model: "gpt-6.1-sol", effort: "low" }, { interruptAfterDeltas: 10 });
result.serverRequests = log;
proc.kill();
save("codex-appserver", result);
