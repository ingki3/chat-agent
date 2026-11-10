import type { PublicPart, RuntimeId } from "@agentlee/shared";

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
};

/** What a fresh session gets: the server's history (summarised by #45 when long) and the turn's settings. */
export type StartContext = {
  conversationId: string;
  /** Prior history, public parts only (reasoning never crosses into another session — PRD FR-3.5). */
  history: { role: "user" | "assistant" | "system"; parts: PublicPart[] }[];
  systemPrompt: string;
  model: string;
  effort?: string | undefined;
  /** Allowed tools (common MCP server + allow-listed skills, #43/#21). */
  tools: string[];
};

/** Normalised events. `reasoning_delta` is stored but never streamed to the browser. */
export type RuntimeEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_start"; callId: string; name: string; input?: unknown }
  | { type: "tool_end"; callId: string; output?: unknown; isError?: boolean }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd?: number }
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
