import fs from "node:fs";
import path from "node:path";
import type { Options, Query, SDKMessage, SDKUserMessage, query } from "@anthropic-ai/claude-agent-sdk";
import { callOurTool, isLiveCall } from "./live-mcp.js";

/**
 * Recorded Claude Agent SDK conversations, replayed in CI instead of the real CLI (#15: "CI는 녹화 이벤트
 * 재생, 로컬은 실제 키로 수동 1회 기록"). A recording maps the turn's prompt text to the SDK messages the
 * real runtime produced for it (see `recordingQuery`).
 */
export type RecordedTurn = {
  messages: SDKMessage[];
  /** Index in `messages` at which interrupt() was called (what follows is what the runtime sent after it). */
  interruptAt?: number;
  /** The SDK threw this at the end (e.g. after an interrupted turn), after the last message. */
  thrown?: string;
};
/** Prompt text → the turn the runtime produced. A bare array is a turn without interrupt or error. */
export type Recording = Record<string, RecordedTurn | SDKMessage[]>;
const turnOf = (t: RecordedTurn | SDKMessage[]): RecordedTurn => (Array.isArray(t) ? { messages: t } : t);

/** Also records what the adapter asked for, so tests can check the options it passed. */
export type ReplayLog = { options: Options[]; prompts: string[]; interrupts: number; closes: number };

const firstText = async (prompt: AsyncIterable<SDKUserMessage>): Promise<string> => {
  const first = await prompt[Symbol.asyncIterator]().next();
  const c = (first.value as SDKUserMessage | undefined)?.message.content;
  return typeof c === "string" ? c : JSON.stringify(c);
};

/**
 * Replays a recording. An interrupt jumps to what the runtime really sent after the interrupt in the recording
 * (`interruptAt`), then ends the way it ended (`thrown`). A turn recorded without an interrupt cannot be
 * interrupted in replay — that fails loudly instead of inventing an ending.
 */
export function replayQuery(rec: Recording, log: ReplayLog, delayMs = 5): typeof query {
  return ((params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    const options = params.options ?? {};
    log.options.push(options);
    let interrupted = false;
    let wake: (() => void) | undefined;
    const sleep = () =>
      new Promise<void>((r) => {
        wake = r;
        setTimeout(r, delayMs);
      });
    async function* gen(): AsyncGenerator<SDKMessage> {
      const text = await firstText(params.prompt as AsyncIterable<SDKUserMessage>);
      log.prompts.push(text);
      const recorded = rec[text];
      if (!recorded) throw new Error(`no recording for prompt: ${text.slice(0, 40)}`);
      const turn = turnOf(recorded);
      // Like the CLI: a session gets its transcript file in the config folder.
      const cfg = options.env?.CLAUDE_CONFIG_DIR;
      const id = options.sessionId ?? options.resume;
      if (cfg && id) {
        fs.mkdirSync(path.join(cfg, "projects", "replay"), { recursive: true });
        fs.appendFileSync(path.join(cfg, "projects", "replay", `${id}.jsonl`), "{}\n");
      }
      let i = 0;
      let jumped = false;
      while (i < turn.messages.length) {
        if (interrupted && !jumped) {
          if (turn.interruptAt === undefined) throw new Error("replay: this recording was not interrupted");
          jumped = true;
          i = Math.max(i, turn.interruptAt);
          continue;
        }
        await sleep();
        if (interrupted && !jumped) continue;
        const next = turn.messages[i++]!;
        if (isLiveCall(next)) {
          yield* liveToolCall(options, next.id, next.tool, next.args);
          continue;
        }
        yield next;
      }
      if (turn.thrown) throw new Error(turn.thrown);
    }
    const g = gen();
    return Object.assign(g, {
      interrupt: async () => {
        log.interrupts++;
        interrupted = true;
        wake?.();
        return undefined;
      },
      setModel: async () => {},
      close: () => {
        log.closes++;
      },
    }) as unknown as Query;
  }) as typeof query;
}

/**
 * What the CLI does for a tool call of the model: asks the PreToolUse hook the adapter configured, and if it
 * allows, calls the tool on the MCP server from `options.mcpServers` (#21 contract test, `liveCall`).
 */
async function* liveToolCall(
  options: Options,
  id: string,
  tool: string,
  args: unknown,
): AsyncGenerator<SDKMessage> {
  const name = `mcp__agentlee__${tool}`;
  yield sdk.toolUse(id, name, args);
  const hook = (
    options.hooks?.PreToolUse?.[0]?.hooks?.[0] as
      ((input: unknown, id: string, o: { signal: AbortSignal }) => Promise<unknown>) | undefined
  )?.bind(null);
  const decision = (await hook?.(
    {
      hook_event_name: "PreToolUse",
      tool_name: name,
      tool_input: args,
      mcp_server: { name: "agentlee", source: "dynamic" },
    },
    id,
    { signal: new AbortController().signal },
  )) as { hookSpecificOutput?: { permissionDecision?: string } } | undefined;
  if (decision?.hookSpecificOutput?.permissionDecision !== "allow") {
    yield sdk.toolResult(id, "denied by hook", true);
    return;
  }
  const server = options.mcpServers?.agentlee as
    { url: string; headers: { Authorization: string } } | undefined;
  if (!server) throw new Error("replay: no agentlee MCP server configured");
  const r = await callOurTool(server.url, server.headers.Authorization.slice("Bearer ".length), tool, args);
  yield {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: r.content, is_error: r.isError }],
    },
  } as unknown as SDKMessage;
}

/**
 * Wraps the real SDK and stores what it produced, per prompt (run with real credentials, once). Collecting is
 * separate from the consumer: when the adapter returns early (after `result`), the SDK is still read to its
 * real end, so an error it throws after the result is recorded too. Await `pending` before saving.
 */
export function recordingQuery(
  real: typeof query,
  into: Recording,
  pending: Promise<unknown>[] = [],
): typeof query {
  return ((params: { prompt: AsyncIterable<SDKUserMessage>; options?: Options }) => {
    const turn: RecordedTurn = { messages: [] };
    let key = "";
    const prompt = (async function* () {
      for await (const m of params.prompt) {
        if (!key)
          key = typeof m.message.content === "string" ? m.message.content : JSON.stringify(m.message.content);
        yield m;
      }
    })();
    const q = real({ prompt, ...(params.options ? { options: params.options } : {}) });
    const buffer: SDKMessage[] = [];
    let done = false;
    let failure: unknown;
    let wake: (() => void) | undefined;
    const collector = (async () => {
      try {
        for await (const m of q) {
          turn.messages.push(m);
          buffer.push(m);
          wake?.();
        }
      } catch (e) {
        turn.thrown = e instanceof Error ? e.message : String(e);
        failure = e;
      } finally {
        done = true;
        into[key] = turn;
        wake?.();
      }
    })();
    pending.push(collector);
    const wrapped = (async function* () {
      for (;;) {
        if (buffer.length) {
          yield buffer.shift()!;
          continue;
        }
        if (done) {
          if (failure !== undefined) throw failure;
          return;
        }
        await new Promise<void>((r) => (wake = r));
      }
    })();
    return Object.assign(wrapped, {
      interrupt: () => {
        turn.interruptAt ??= turn.messages.length;
        return q.interrupt();
      },
      setModel: (m?: string) => q.setModel(m),
      close: () => q.close(),
    }) as unknown as Query;
  }) as typeof query;
}

/** Builders for hand-made recordings (shapes as the SDK emits them). */
export const sdk = {
  init: (o: { session: string; tools?: string[]; mcp?: { name: string; status: string }[] }): SDKMessage =>
    ({
      type: "system",
      subtype: "init",
      session_id: o.session,
      tools: o.tools ?? ["mcp__agentlee__echo_time"],
      mcp_servers: o.mcp ?? [{ name: "agentlee", status: "connected" }],
      model: "claude-haiku-5-5",
      apiKeySource: "ANTHROPIC_API_KEY",
    }) as unknown as SDKMessage,
  delta: (text: string, kind: "text" | "thinking" = "text"): SDKMessage =>
    ({
      type: "stream_event",
      event: {
        type: "content_block_delta",
        index: 0,
        delta: kind === "text" ? { type: "text_delta", text } : { type: "thinking_delta", thinking: text },
      },
    }) as unknown as SDKMessage,
  toolUse: (id: string, name: string, input: unknown): SDKMessage =>
    ({
      type: "assistant",
      message: { content: [{ type: "tool_use", id, name, input }] },
    }) as unknown as SDKMessage,
  toolResult: (id: string, text: string, isError = false): SDKMessage =>
    ({
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: isError },
        ],
      },
    }) as unknown as SDKMessage,
  assistantError: (error: string): SDKMessage =>
    ({
      type: "assistant",
      error,
      message: { content: [{ type: "text", text: "error" }] },
    }) as unknown as SDKMessage,
  rateLimit: (status: "allowed" | "rejected"): SDKMessage =>
    ({ type: "rate_limit_event", rate_limit_info: { status } }) as unknown as SDKMessage,
  result: (o: { isError?: boolean; subtype?: string } = {}): SDKMessage =>
    ({
      type: "result",
      subtype: o.subtype ?? (o.isError ? "error_during_execution" : "success"),
      is_error: o.isError ?? false,
      usage: {
        input_tokens: 12,
        output_tokens: 34,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 200,
      },
      total_cost_usd: 0.0021,
    }) as unknown as SDKMessage,
  /** A plain answer streamed word by word. */
  answer: (session: string, text: string): SDKMessage[] => [
    sdk.init({ session }),
    ...text.split(/(?<= )/).map((w) => sdk.delta(w)),
    sdk.result(),
  ],
};
