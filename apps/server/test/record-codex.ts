/**
 * Records the real codex app-server once, for CI to replay (#16). Uses CODEX_API_KEY from `.env`, runs the pinned
 * binary exactly as the server does (sandboxed, locked down, through the egress proxy) and writes
 * test/fixtures/codex-contract.json and codex-tools.json. Recordings hold the app-server's messages only — the
 * key goes over stdin and is never in them (checked before writing, with the run's MCP token).
 *
 *   pnpm --filter @agentlee/server exec tsx --conditions=development test/record-codex.ts
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { McpTokens } from "../src/isolation/tokens.js";
import { McpService } from "../src/mcp/service.js";
import { CODEX_EGRESS_HOSTS, EgressService } from "../src/isolation/egress.js";
import { spawnIsolated } from "../src/isolation/sandbox.js";
import type { RuntimeEvent, StartContext } from "../src/runtime/adapter.js";
import { CodexAdapter } from "../src/runtime/codex.js";
import { recordingSpawn, type Recording } from "./helpers/codex-replay.js";

loadEnv({ path: path.resolve(import.meta.dirname, "../../../.env"), quiet: true });
const apiKey = process.env.CODEX_API_KEY;
if (!apiKey) {
  console.error("Set CODEX_API_KEY in .env first.");
  process.exit(2);
}
const MODEL = process.env.RECORD_MODEL ?? "gpt-6-luna";

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "codex-record-"));
const pending: Promise<unknown>[] = [];
// The binary reaches the API only through the egress proxy, exactly as in the server.
const egress = new EgressService({ allow: CODEX_EGRESS_HOSTS });
const make = (into: Recording) =>
  new CodexAdapter({
    connection: () => ({ id: "record", dir: path.join(root, "conn"), auth: { kind: "api_key", apiKey } }),
    spawn: recordingSpawn(spawnIsolated, into, pending),
    egress,
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
const rec: Recording = {};
{
  const adapter = make(rec);
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
await Promise.all(pending);

// Our MCP tools through the real runtime.
const toolRec: Recording = {};
const tokens = new McpTokens();
const mcp = new McpService(tokens, { byId: () => ({ name: "녹화", active: true }) as never });
const { url } = await mcp.endpoint();
const mcpToken = tokens.issue({ userId: "u-record", conversationId: "record", runId: "record-run" });
const toolPrompt =
  "Call the echo_time tool, then call the skill_selftest tool with text 'agentlee'. Then reply with the userName and the sha256 you got.";
{
  const s = await make(toolRec).start(ctx({ tools: mcp.toolNames(), mcp: { url, token: mcpToken } }));
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
await Promise.all(pending);
await mcp.close();
await egress.close();

const fixtures = path.resolve(import.meta.dirname, "fixtures");
const write = (name: string, data: unknown) => {
  const json = JSON.stringify(data, null, 1);
  if (json.includes(apiKey) || json.includes(mcpToken))
    throw new Error(`refusing to write ${name}: it contains a credential`);
  fs.writeFileSync(path.join(fixtures, name), json + "\n");
};
const note = `recorded ${new Date().toISOString()} with ${MODEL} (codex app-server 0.165.0)`;
write("codex-contract.json", { _note: note, prompts, recording: rec });
write("codex-tools.json", { _note: note, prompt: toolPrompt, recording: toolRec });
fs.rmSync(root, { recursive: true, force: true });
console.log("written to", fixtures);
