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
  /**
   * The model's context window in tokens (#45): a fresh session's history is summarised once it reaches the
   * configured ratio of it. Unset = `DEFAULT_CONTEXT_WINDOW` (context.ts).
   */
  contextWindow?: number;
  /** A cheap model of the runtime: what the conversation summary is written with when the user may use it (#45). */
  cheap?: boolean;
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
   * Runs get our MCP server although `usesTools` is false: the scripted FakeRuntime in development and e2e
   * (FAKE_RUNTIME=1), whose runs may call real tools (artifacts, #27) while its connection test (#17) is answered
   * from its script. Real runtimes never set it.
   */
  runTools?: boolean;
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
  /**
   * Prior history, public parts only (reasoning never crosses into another session — PRD FR-3.5). When the
   * conversation is long (#45) this is only what comes after `summary`.
   */
  history: { role: "user" | "assistant" | "system"; parts: PublicPart[] }[];
  /** The summary of the earlier part (#45, FR-3.6): it stands in for every message up to `throughMessageId`. */
  summary?: { text: string; throughMessageId: string } | undefined;
  /** The conversation's uploaded files, artifacts and cited sources (#45, FR-3.5). Rendered by `renderPriorContext`. */
  references?: ContextReferences | undefined;
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

/**
 * What a fresh session is told about the conversation besides its messages (PRD FR-3.5: "업로드 파일 목록, 이 대화의
 * 아티팩트, 인용 출처"). Titles and names are user, page or model text: they reach the runtime as external content.
 * Whether a file or artifact named here can really be opened by the runtime is #53.
 */
export type ContextReferences = {
  /** Uploaded files sent with a message (#22's file store). */
  files: { id: string; name: string }[];
  artifacts: { id: string; title: string; kind: string; version: number }[];
  /** Sources the conversation's answers cited (server-checked citation notes). */
  sources: { id: string; title: string | null; site: string | null; url: string }[];
};

/** What an adapter's connection resolver is asked: whose run, which connection, and whether it is a test. */
export type ConnectionRequest = Pick<
  StartContext,
  "userId" | "connectionId" | "connectionVersion" | "connectionTest"
>;

/**
 * Usage of one attempt (#44) — one session open + one turn of a run (see runs.ts `Live.attempt`).
 *
 * Rule: a `usage` event is the attempt's **whole usage so far** (cumulative for the attempt), never an increment.
 * A later `usage` event of the same attempt replaces the earlier one — the last one wins — so an adapter may send
 * usage once at the end of the turn (Claude's `result`, Codex's `turn/completed`) or several times as it grows,
 * and a duplicate is harmless. An adapter whose runtime reports increments must add them up itself. The figures
 * are this attempt's only: totals that run on across a session's turns or resumes (Claude `total_cost_usd`, Codex
 * `tokenUsage.total`) are reported as the turn's difference.
 * A figure the runtime does not report is left out (stored as NULL), not sent as 0.
 */
export type UsageReport = {
  /** All input tokens of the attempt, cached ones included. */
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  /** Of `inputTokens`: read from / written to the prompt cache, when the runtime reports it. */
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  /** The runtime's own cost figure in USD, when it reports one (API key connections). */
  costUsd?: number | undefined;
};

/** The figures of a `usage` event, without its type. */
export function usageReport(ev: UsageReport): UsageReport {
  return {
    inputTokens: ev.inputTokens,
    outputTokens: ev.outputTokens,
    cacheReadTokens: ev.cacheReadTokens,
    cacheWriteTokens: ev.cacheWriteTokens,
    costUsd: ev.costUsd,
  };
}

/** Normalised events. `reasoning_delta` is stored but never streamed to the browser. */
export type RuntimeEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_start"; callId: string; name: string; input?: unknown }
  | { type: "tool_end"; callId: string; output?: unknown; isError?: boolean }
  | ({ type: "usage" } & UsageReport)
  /** Informational (e.g. "fell back to …"). */
  | { type: "notice"; level: "info" | "warn"; code: string; message: string }
  /**
   * Quota / rate limit reached: the turn ends as failed with this code. What the provider said about it, if anything
   * (#19 keeps new conversations off it meanwhile): `resetsAt` (ms since epoch) when it ends, `retryAfterMs` after
   * how long to retry, `modelFamily` when it is a model-specific window (`opus` for Claude's `seven_day_opus`).
   */
  | {
      type: "limit";
      code: string;
      message: string;
      resetsAt?: number;
      retryAfterMs?: number;
      modelFamily?: string;
    };

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
