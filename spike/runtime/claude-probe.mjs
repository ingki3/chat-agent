// Spike #39 — Claude Agent SDK capability probes. Run: node claude-probe.mjs [test...]
import { query } from "@anthropic-ai/claude-agent-sdk";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanEnv, save, ECHO } from "./lib.mjs";

const OPUS = "claude-opus-5-5", HAIKU = "claude-haiku-5-5";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-claude-"));
const permLog = [];

// Locked-down base: no built-in tools, no filesystem settings, only our MCP server.
function base(extra = {}) {
  return {
    cwd: work,
    env: cleanEnv({ AGENTLEE_RUN_TOKEN: "run-123", CLAUDE_AGENT_SDK_CLIENT_APP: "agent-lee-spike/0.0.1" }),
    settingSources: [],
    tools: [],
    mcpServers: { echo: { type: "stdio", command: process.execPath, args: [ECHO], env: { AGENTLEE_RUN_TOKEN: "run-123" } } },
    canUseTool: async (name, input) => {
      permLog.push(name);
      return name.startsWith("mcp__echo__") ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "blocked by Agent Lee policy" };
    },
    model: OPUS,
    ...extra,
  };
}

async function run(prompt, opts, { stopAfterDeltas } = {}) {
  const q = query({ prompt, options: opts });
  const out = { deltas: 0, text: "", toolUses: [], toolResults: [], sessionId: null, result: null, initTools: null, initMcp: null, model: null, errors: [] };
  try {
    for await (const m of q) {
      if (m.type === "system" && m.subtype === "init") { out.sessionId = m.session_id; out.initTools = m.tools; out.initMcp = m.mcp_servers; out.model = m.model; }
      if (m.type === "stream_event" && m.event?.type === "content_block_delta" && m.event.delta?.type === "text_delta") {
        out.deltas++; if (stopAfterDeltas && out.deltas === stopAfterDeltas) { out.interruptAt = Date.now(); await q.interrupt(); out.interruptAckAt = Date.now(); }
      }
      if (m.type === "assistant") (out.assistantModels ??= new Set()).add(m.message.model);
      if (m.type === "assistant") for (const b of m.message.content) {
        if (b.type === "text") out.text += b.text;
        if (b.type === "tool_use") out.toolUses.push(b.name);
      }
      if (m.type === "user" && Array.isArray(m.message?.content)) for (const b of m.message.content)
        if (b.type === "tool_result") out.toolResults.push(JSON.stringify(b.content).slice(0, 160));
      if (m.type === "result") out.result = { subtype: m.subtype, is_error: m.is_error, cost: m.total_cost_usd, usage: m.usage, modelUsage: m.modelUsage, num_turns: m.num_turns };
    }
  } catch (e) { out.errors.push(String(e?.message ?? e).slice(0, 400)); }
  out.endAt = Date.now();
  out.text = out.text.slice(0, 400);
  out.assistantModels = [...(out.assistantModels ?? [])];
  return out;
}

const tests = {
  async stream() {
    const r = await run("Count from 1 to 30 separated by spaces. Then call the echo_time tool with tag 'c1' and report its output.", base({ includePartialMessages: true }));
    save("claude-stream", r); return r;
  },
  async resume() {
    const first = await tests.stream();
    const r = await run("What tag did you pass to echo_time earlier in this conversation? Answer with the tag only.", base({ resume: first.sessionId }));
    save("claude-resume", { resumedFrom: first.sessionId, ...r }); return r;
  },
  async lockdown() {
    permLog.length = 0;
    const r = await run("Use any tool you have to run the shell command `ls ~` and to read ~/.zshrc, then tell me the first line of that file. If you cannot, say exactly which tools you have.", base());
    save("claude-lockdown", { initTools: r.initTools, toolUses: r.toolUses, text: r.text, permissionCallbacks: [...permLog] });
    // Control A: Bash exposed but gated by canUseTool -> callback must be consulted and deny.
    permLog.length = 0;
    const a = await run("Run the shell command `echo agentlee-probe` with the Bash tool and report its output.", base({ tools: ["Bash"] }));
    // Control B: same, but Bash also listed in allowedTools -> auto-approved without the callback.
    const cb = [...permLog]; permLog.length = 0;
    const b = await run("Run the shell command `echo agentlee-probe` with the Bash tool and report its output.", base({ tools: ["Bash"], allowedTools: ["Bash"] }));
    save("claude-lockdown-controls", {
      gatedByCallback: { toolUses: a.toolUses, callbacks: cb, toolResults: a.toolResults },
      allowedToolsBypass: { toolUses: b.toolUses, callbacks: [...permLog], toolResults: b.toolResults },
    });
  },
  async isolation() {
    const ask = "Do your instructions or context mention the word 'graphify'? Answer YES or NO only.";
    const isolated = await run(ask, base());
    const withUser = await run(ask, base({ settingSources: ["user"] }));
    save("claude-isolation", { isolated: isolated.text, withUserSettings: withUser.text, errors: [...isolated.errors, ...withUser.errors] });
  },
  async configdir() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-cfg-"));
    const o = base(); o.env = { ...o.env, CLAUDE_CONFIG_DIR: dir };
    const r = await run("Say OK.", o);
    save("claude-configdir", { dir: "<tmp>/agentlee-cfg-*", filesAfter: fs.readdirSync(dir), text: r.text, result: r.result, errors: r.errors });
  },
  async effort() {
    const res = {};
    for (const [model, effort] of [[OPUS, "low"], [OPUS, "max"], [HAIKU, "low"], [HAIKU, "max"]]) {
      const r = await run("Say OK.", base({ model, effort }));
      res[`${model}:${effort}`] = { text: r.text, answeredBy: r.assistantModels, subtype: r.result?.subtype, errors: r.errors };
    }
    save("claude-effort", res);
  },
  async setmodel() {
    // Streaming-input session: turn 1 on Opus, setModel(Haiku), turn 2.
    let push; const queue = [];
    const input = (async function* () { while (true) { const msg = await new Promise((r) => (queue.length ? r(queue.shift()) : (push = r))); if (!msg) return; yield msg; } })();
    const send = (text) => { const m = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, session_id: "" }; push ? (push(m), (push = null)) : queue.push(m); };
    const q = query({ prompt: input, options: base() });
    const turns = []; let turn = 0;
    send("Remember the word PINEAPPLE. Reply with 'noted'.");
    for await (const m of q) {
      if (m.type === "result") {
        Object.assign((turns[turn] ??= {}), { turn, subtype: m.subtype, sessionId: m.session_id });
        turn++;
        if (turn === 1) { await q.setModel(HAIKU); send("What word did I ask you to remember? One word."); }
        else { push && push(null); break; }
      }
      if (m.type === "assistant") { const t = (turns[turn] ??= {}); t.text = (t.text ?? "") + m.message.content.filter((b) => b.type === "text").map((b) => b.text).join(""); t.answeredBy = m.message.model; }
    }
    save("claude-setmodel", turns);
  },
  async interrupt() {
    const t0 = Date.now();
    const r = await run("Write a 1500-word essay about the history of the printing press.", base({ includePartialMessages: true }), { stopAfterDeltas: 15 });
    save("claude-interrupt", { deltas: r.deltas, subtype: r.result?.subtype, interruptToEndMs: r.endAt - r.interruptAt, interruptAckMs: r.interruptAckAt - r.interruptAt, errors: r.errors }); return r;
  },
};

const which = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(tests);
for (const t of which) { console.log(`-- ${t}`); try { await tests[t](); } catch (e) { save(`claude-${t}`, { fatal: String(e?.stack ?? e).slice(0, 800) }); } }
