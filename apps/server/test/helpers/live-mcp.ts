import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { resolveRefs } from "../../src/runtime/fake-citations.js";

/**
 * A tool call the scripted runtimes (claude-replay / codex-replay) make for real against our MCP server, through
 * what the adapter configured (#21 contract test): Claude's `mcpServers` + PreToolUse hook, Codex's `-c
 * mcp_servers.agentlee=…` (url, enabled_tools) + the token in its environment. Put `liveCall(...)` in a recording
 * where the runtime would call the tool; the replay turns it into the runtime's own tool-call messages carrying
 * the server's real answer.
 */
export const LIVE_CALL = "agentlee_live_call";
export type LiveCall = {
  type: typeof LIVE_CALL;
  method: typeof LIVE_CALL;
  id: string;
  tool: string;
  args: unknown;
};
export const liveCall = (id: string, tool: string, args: unknown): LiveCall => ({
  type: LIVE_CALL,
  method: LIVE_CALL,
  id,
  tool,
  args,
});
export const isLiveCall = (m: unknown): m is LiveCall =>
  !!m && typeof m === "object" && (m as { type?: unknown }).type === LIVE_CALL;

/** Answers of earlier live calls by call id (JSON text parsed), for `"$<id>.<path>"` references in later args. */
const answers = new Map<string, unknown>();

/**
 * The args of a live call with `"$<id>.<path>"` resolved against earlier live calls' answers (e.g. the sourceId
 * a web_fetch returned, cited by the next call — fake-citations.ts `resolveRefs`).
 */
export const liveArgs = (args: unknown): unknown => resolveRefs(args, (id) => answers.get(id));

export type ToolAnswer = { content: { type: string; text?: string }[]; isError: boolean };

/** One MCP tools/call with a bearer token, as a runtime's MCP client does it. */
export async function callOurTool(
  url: string,
  token: string,
  tool: string,
  args: unknown,
  id?: string,
): Promise<ToolAnswer> {
  const client = new Client({ name: "scripted-runtime", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  await client.connect(transport);
  try {
    const r = (await client.callTool({ name: tool, arguments: args as Record<string, unknown> })) as {
      content?: { type: string; text?: string }[];
      isError?: boolean;
    };
    const answer = { content: r.content ?? [], isError: r.isError === true };
    if (id !== undefined) {
      const text = answer.content.find((c) => c.type === "text")?.text;
      try {
        answers.set(id, text === undefined ? undefined : (JSON.parse(text) as unknown));
      } catch {
        answers.delete(id);
      }
    }
    return answer;
  } catch (e) {
    // The SDK reports protocol errors (unknown tool, invalid arguments) as exceptions on some paths.
    return { content: [{ type: "text", text: (e as Error).message }], isError: true };
  } finally {
    await client.close();
  }
}
