import type { PublicPart, RuntimeId } from "@agentlee/shared";
import type { McpConnection } from "./lockdown.js";

/**
 * Runtime adapter contract (PRD FR-11 table, spike #39). The server never runs an agent loop itself; each
 * runtime (Claude Agent SDK #15, codex app-server #16) implements this and translates its own events into
 * `RuntimeEvent`. The run manager (runs.ts) is the only caller.
 */

export type ModelCapability = {
  id: string;
  label: string;
  /** Accepted reasoning-effort values; empty = the model takes no effort setting. */
  efforts: string[];
  defaultEffort?: string;
};

export type RuntimeCapabilities = {
  models: ModelCapability[];
  /** Model can change inside an existing session (`setModel`) without starting a new one. */
  canSwitchModelInSession: boolean;
  /** Session can be resumed by id (`resume`). */
  canResume: boolean;
  /** Calls our MCP server (real runtimes). False: the run gets no tools and no MCP port is opened for it. */
  usesTools: boolean;
  /**
   * Runs need a runtime connection (#17): the run manager picks one before the run starts (personal first, then
   * shared) and fails it with `no_connection` when there is none. Default false (the development FakeRuntime).
   */
  needsConnection?: boolean;
};

/** What a fresh session gets: the server's history (summarised by #45 when long) and the turn's settings. */
export type StartContext = {
  conversationId: string;
  /** Who the run is for. */
  userId: string;
  /**
   * The connection the run manager chose for this run (#17). Adapters resolve it — credential and folder — through
   * their `connection` option, which checks again that this user may use it.
   */
  connectionId?: string | undefined;
  /** The connection's credential version the run (or test) was accepted with (#17). */
  connectionVersion?: number | undefined;
  /** A connection test (#17): the connection may still be untested or failed. Set by the server only. */
  connectionTest?: boolean;
  /**
   * Cancels opening the session (a connection test that is cancelled by a disconnect or a new key, #17). Once it
   * fires, the adapter must not create anything more in the connection folder, must kill a process it started, and
   * must settle `start()` / `resume()` (with an error) only after that process has exited.
   */
  signal?: AbortSignal;
  /** Prior history, public parts only (reasoning never crosses into another session — PRD FR-3.5). */
  history: { role: "user" | "assistant" | "system"; parts: PublicPart[] }[];
  systemPrompt: string;
  model: string;
  effort?: string | undefined;
  /** Allowed tools of our MCP server, without the `mcp__agentlee__` prefix (#43, skills #21). */
  tools: string[];
  /**
   * Our MCP server for this run: loopback URL + a token scoped to this user, conversation and run (#42/#43).
   * Adapters turn it into runtime settings with `claudeLockdown` / `codexConfigToml` + `codexMcpEnv`.
   */
  mcp?: McpConnection;
};

/** What an adapter's connection resolver is asked: whose run, which connection, and whether it is a test. */
export type ConnectionRequest = Pick<
  StartContext,
  "userId" | "connectionId" | "connectionVersion" | "connectionTest"
>;

/** Normalised events. `reasoning_delta` is stored but never streamed to the browser. */
export type RuntimeEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_start"; callId: string; name: string; input?: unknown }
  | { type: "tool_end"; callId: string; output?: unknown; isError?: boolean }
  | {
      type: "usage";
      /** All input tokens of the turn, cached ones included. */
      inputTokens: number;
      outputTokens: number;
      /** Of `inputTokens`: read from / written to the prompt cache, when the runtime reports it. */
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      costUsd?: number;
    }
  /** Informational (e.g. "fell back to …"). */
  | { type: "notice"; level: "info" | "warn"; code: string; message: string }
  /** Quota / rate limit reached: the turn ends as failed with this code. */
  | { type: "limit"; code: string; message: string };

export type TurnInput = { text: string; model: string; effort?: string | undefined };

/**
 * One turn. `events` ends when the turn is over. After `interrupt()`, the iterator must finish promptly; the
 * run manager — not the adapter — decides that an interrupted turn is "stopped" (spike: Claude reports
 * `error_during_execution` for its own interrupts, which only counts as stopped when we asked for it).
 */
export interface RuntimeTurn {
  events: AsyncIterable<RuntimeEvent>;
  interrupt(): Promise<void>;
}

export interface RuntimeSession {
  /** The runtime's own id (Claude session id / Codex thread id), stored in runtime_sessions. */
  readonly externalSessionId: string;
  turn(input: TurnInput): RuntimeTurn;
  setModel(model: string): Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeAdapter {
  readonly id: RuntimeId;
  capabilities(): RuntimeCapabilities;
  start(ctx: StartContext): Promise<RuntimeSession>;
  /** Re-opens a session by id. Throws `SessionGoneError` if the runtime no longer has it. */
  resume(externalSessionId: string, ctx: StartContext): Promise<RuntimeSession>;
}

export class SessionGoneError extends Error {
  constructor() {
    super("runtime session is gone");
  }
}

/** Adapters by runtime id. Production registers the real ones (#15, #16); FAKE_RUNTIME=1 adds FakeRuntime. */
export class RuntimeRegistry {
  private readonly adapters = new Map<RuntimeId, RuntimeAdapter>();
  register(a: RuntimeAdapter): void {
    this.adapters.set(a.id, a);
  }
  get(id: RuntimeId): RuntimeAdapter | undefined {
    return this.adapters.get(id);
  }
  ids(): RuntimeId[] {
    return [...this.adapters.keys()];
  }
}

/**
 * A failure the adapter can name. The run fails with this code (shown to the user through FAILURE_TEXT) instead
 * of the generic `runtime_error`. Never put secrets or runtime output in `code`.
 */
export class RuntimeFailure extends Error {
  constructor(readonly code: "runtime_auth" | "no_connection" | "runtime_policy" | "runtime_error") {
    super(code);
  }
}
