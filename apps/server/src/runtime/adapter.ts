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
   * Called with the session's id as soon as it exists — before the adapter writes anything of it to disk (#54). A
   * `start()` that fails after this left state the caller must have forgotten (RunManager hands it to the deletion
   * jobs); one that succeeds returns the same id. `exited`, when the session already has a process: settles once
   * that process has really exited (a failed `start()` may stop waiting for it before).
   */
  sessionStarted?: ((externalSessionId: string, exited?: () => Promise<void>) => void) | undefined;
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
 * Each id is one the runtime can really use with our tools in this conversation (#53): a file with the file tools, an
 * artifact with `artifact_read` / `artifact_update`, a source with `cite` (when its text is stored).
 */
export type ContextReferences = {
  /** Uploaded files sent with a message (#22's file store). `kind`: pdf, hwp, docx … (#22). */
  files: { id: string; name: string; kind: string }[];
  artifacts: { id: string; title: string; kind: string; version: number }[];
  /**
   * Sources the conversation's answers cited (server-checked citation notes) that are this conversation's sources.
   * `text`: the page text is stored, so `cite` can check a passage against it; without it (a fork's copy, #52, or a
   * search result) the page must be fetched again first.
   */
  sources: { id: string; title: string | null; site: string | null; url: string; text: boolean }[];
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
  /**
   * Stops the session. Waits a bounded time for its processes to exit; when they have not (yet), it rejects with
   * `ExitUnconfirmedError` — the caller must not take the session as gone (#54). `exited()` tells when it really is.
   */
  close(): Promise<void>;
  /** Settles once no process of the session runs any more (after `close`). Absent: nothing runs outside this process. */
  exited?(): Promise<void>;
}

/** `close()` gave up waiting: the session's process had not exited yet (it may still write to its files). */
export class ExitUnconfirmedError extends Error {
  constructor() {
    super("exit_unconfirmed");
    this.name = "ExitUnconfirmedError";
  }
}

export type ForgetOptions = {
  /**
   * For the start-up reconciliation's finds (review #124 round 4): asked again right before anything is removed,
   * inside the adapter's own ordering (Codex: after any opening or resume on that folder has finished) — false when
   * the session is no orphan after all (a row owns it now); then nothing is done. It throws when it cannot tell yet
   * (the session is live in this process): then `forget` rejects with that error, nothing removed, and is retried.
   */
  stillOrphan?: () => boolean;
};

export interface RuntimeAdapter {
  readonly id: RuntimeId;
  capabilities(): RuntimeCapabilities;
  start(ctx: StartContext): Promise<RuntimeSession>;
  /** Re-opens a session by id. Throws `SessionGoneError` if the runtime no longer has it. */
  resume(externalSessionId: string, ctx: StartContext): Promise<RuntimeSession>;
  /**
   * Removes everything the runtime keeps of one of its sessions in the connection folder `dir` (#54: its conversation
   * was deleted) — transcripts, state, our own per-session notes. Called only once no process of that session runs
   * any more. Idempotent: a session (or folder) already gone is done. Throws when it could not finish: the caller
   * tries again later (conversations/purge.ts). Never follows a link; touches nothing outside `dir` and `<dir>-meta`.
   * Runtimes that keep nothing on disk (FakeRuntime) leave it out.
   */
  forget?(externalSessionId: string, dir: string, opts?: ForgetOptions): Promise<void>;
  /**
   * Ids of every session the runtime keeps state of in the connection folder `dir` (#54: the start-up reconciliation
   * forgets those no conversation owns — a session whose row was never saved because the server died in between).
   * Plain folders only.
   */
  storedSessions?(dir: string): string[];
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
  constructor(
    readonly code:
      | "runtime_auth"
      | "no_connection"
      | "runtime_policy"
      | "runtime_error"
      /** The turn's own message does not fit the model's context window (#45; never cut). Raised by the run manager. */
      | "context_too_large",
  ) {
    super(code);
  }
}
