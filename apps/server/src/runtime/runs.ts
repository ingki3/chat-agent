import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { and, asc, eq, gt, inArray, isNotNull, lt, sql } from "drizzle-orm";
import {
  publicParts,
  StreamEvent,
  type FinanceSource,
  type MessagePart,
  type Run,
  type RunChoice,
  type RuntimeId,
} from "@agentlee/shared";
import type { RunSettings, RunSettingsInput } from "../connections/access.js";
import type { ConversationStore, MessageRow } from "../conversations/store.js";
import type { Db } from "../db/client.js";
import { runEvents, runs, users } from "../db/schema.js";
import type { AppEvents } from "../events.js";
import { McpTokens } from "../isolation/tokens.js";
import {
  RuntimeFailure,
  SessionGoneError,
  type RuntimeRegistry,
  type RuntimeSession,
  type RuntimeTurn,
  type StartContext,
  type UsageReport,
  usageReport,
} from "./adapter.js";
import type { UsageAttempt, UsagePurpose } from "../usage/store.js";
import { logEvent, type EventLogger } from "../logging.js";
import { classifyError, runFailureCategory, type ErrorLog } from "../observability/errors.js";
import { registerToolNames, toolLabel } from "../observability/policy.js";
import { OUR_TOOL_PREFIX } from "./lockdown.js";
import { assembleInstructions, defaultTemplates, type Templates } from "../instructions/assemble.js";
import { carriedSources, financeNote } from "../finance/checker.js";

export type RunRow = typeof runs.$inferSelect;

/**
 * Our MCP server's tools are trusted names for the log and the recent-error list (#46): registered bare and as
 * runtimes report them (`mcp__agentlee__<name>`). Returns the list unchanged.
 */
function trustOurTools(names: string[]): string[] {
  registerToolNames(names.flatMap((n) => [n, `${OUR_TOOL_PREFIX}${n}`]));
  return names;
}
/** In-memory state of a run that is being executed by this process. */
type Live = {
  conversationId: string;
  /** The run's runtime connection (#17), if any. */
  connectionId: string | null;
  /**
   * Given to the adapter as `StartContext.signal`: stopping the connection (disconnect, new key) aborts opening the
   * session, so the adapter kills its process instead of carrying on into the removed folder (#17).
   */
  abort: AbortController;
  /** Settles when `execute` has returned (the session open, if any, has settled too). */
  done: Promise<void>;
  emitter: EventEmitter;
  session?: RuntimeSession;
  turn?: RuntimeTurn;
  /** The reply so far (internal parts included) — saved when the run ends, however it ends. */
  parts: MessagePart[];
  interruptRequested: boolean;
  /** Ended (finished, force-stopped or its conversation deleted): later runtime events are ignored. */
  settled: boolean;
  graceTimer?: NodeJS.Timeout;
  /** Set once the session is being closed, so it is closed exactly once whoever ends the run. */
  closing?: Promise<void>;
  /**
   * The run's current attempt (#44): 0 before the first one. An attempt is one session open + the turn sent on it
   * for this reply. The run manager opens one per run today; a retry or a runtime/model fallback inside the same
   * run (#19) must call `nextAttempt` before it opens its session, so its usage gets a row of its own. Reconnects
   * of the browser's stream are not attempts (nothing is sent to the runtime).
   */
  attempt: number;
  /** What the run's usage is recorded as (#44): `chat`, or `schedule` for scheduled runs (#33). */
  purpose: UsagePurpose;
  /** The last usage report of each attempt (last one wins, see `UsageReport`) — the log record's totals (#46). */
  usage: Map<number, UsageReport>;
  /** Open tool calls: name and start time, for the tool's duration. */
  tools: Map<string, { name: string; startedAt: number }>;
  /** What made the run fail, for the log (class name and code only are ever written). */
  failure?: unknown;
  /** The finance note of the answer before this one (#30): a follow-up that states figures is checked too. */
  financeCarry?: FinanceSource[] | undefined;
};

/**
 * Closes the run's session once — later calls share the first close — and resolves after at most `ms`.
 * The adapter's close() is called inside a promise, so even a synchronous throw cannot escape (e.g. from the
 * interrupt grace timer, where it would be an uncaught exception).
 */
function closeSession(live: Live, ms = 2000): Promise<void> {
  const session = live.session;
  if (!session) return Promise.resolve();
  live.closing ??= new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    Promise.resolve()
      .then(() => session.close())
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer);
        resolve();
      });
  });
  return live.closing;
}

/** Asks the runtime to stop without waiting for it (an adapter's interrupt may never return). */
function fireInterrupt(live: Live): void {
  try {
    void live.turn?.interrupt().catch(() => {});
  } catch {
    // synchronous throw from the adapter: the grace timer / settle path ends the run anyway
  }
}

/** Starts the run's next attempt (#44) and returns its number. */
function nextAttempt(live: Live): number {
  return ++live.attempt;
}

/** The run's totals over its attempts, for the log record: each attempt's last report. */
function usageTotals(live: Live): { inputTokens: number; outputTokens: number; costUsd?: number } {
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | undefined;
  for (const u of live.usage.values()) {
    inputTokens += u.inputTokens ?? 0;
    outputTokens += u.outputTokens ?? 0;
    if (u.costUsd !== undefined) costUsd = (costUsd ?? 0) + u.costUsd;
  }
  return { inputTokens, outputTokens, ...(costUsd === undefined ? {} : { costUsd }) };
}

export const EVENT_RETENTION_MS = 3600_000;
export const DEFAULT_RUNTIME: RuntimeId = "claude-code";

export class ShuttingDownError extends Error {
  constructor() {
    super("the server is shutting down");
  }
}

/** The run ended while its session was being opened; nothing more to do. */
class RunEndedError extends Error {}

export class RunBusyError extends Error {
  constructor() {
    super("a run is already in progress for this conversation");
  }
}
export class IdempotencyConflictError extends Error {
  constructor() {
    super("idempotency key already used for another request");
  }
}

export function toRun(r: RunRow): Run {
  return {
    id: r.id,
    conversationId: r.conversationId,
    assistantMessageId: r.assistantMessageId,
    status: r.status,
    errorCode: r.errorCode ?? null,
    runtime: r.runtime,
    model: r.model,
    effort: r.effort ?? null,
    connectionId: r.connectionId ?? null,
    createdAt: r.createdAt,
    endedAt: r.endedAt ?? null,
  };
}

/** Messages the browser sees for a failure — never the runtime's own error text (may hold user data). */
const FAILURE_TEXT: Record<string, string> = {
  no_runtime: "쓸 수 있는 런타임이 없어요 — 관리자에게 문의하세요.",
  runtime_error: "응답 중 오류가 났어요. 다시 시도해 주세요.",
  server_restart: "서버 재시작으로 중단됐어요. 다시 생성해 주세요.",
  usage_limit: "사용 한도에 도달했어요.",
  runtime_auth: "런타임 로그인이 만료됐거나 키가 맞지 않아요 — 관리자에게 문의하세요.",
  no_connection:
    "이 런타임을 쓸 수 있는 연결이 없어요 — 설정 → 내 런타임 연결에서 연결하거나 관리자에게 문의하세요.",
  runtime_policy: "런타임이 허용되지 않은 도구를 쓰려고 해서 멈췄어요.",
};

export type RunManagerOptions = {
  now?: () => number;
  /** How often partial replies are written to the message row while streaming. */
  flushMs?: number;
  /** After interrupt(), how long the runtime gets to stop before the run is ended without it. */
  interruptGraceMs?: number;
  /**
   * Instruction templates (#20). Default: the repository's `apps/server/instructions/`, read at construction so a
   * broken template stops the server at startup, not on the first run.
   */
  instructions?: Templates;
  /**
   * Our MCP server (#43). Without it, runtimes get no tools. `toolNames()` is everything it offers (for the log),
   * `toolNamesFor(user)` what one user's run gets (FR-1.6, #21).
   */
  mcp?: {
    endpoint(): Promise<{ url: string }>;
    toolNames(): string[];
    toolNamesFor(userId: string): string[];
  };
  /** Token store shared with the MCP server. Default: a private one (then no MCP server can check its tokens). */
  mcpTokens?: McpTokens;
  /** Structured log (#46): run and tool outcomes with IDs, durations, codes and cost — never content. */
  log?: EventLogger;
  /** Recent errors for the admin screen (#46). */
  errors?: ErrorLog;
  /**
   * Usage storage (#44): every usage event is written at once — keyed on (run, attempt), the last report of an
   * attempt wins — so a run that is stopped or fails keeps what its runtime reported until then.
   */
  usage?: { record(a: UsageAttempt, u: UsageReport): void };
  /**
   * Runtime connections (#17). `resolve` checks the run's runtime, model, effort and connection (throws
   * `RunAccessDenied` → 403, inside the begin transaction so nothing is created) and picks the connection;
   * `runFailed` reacts to a failed run on a connection (expiry, limits) with notices for the stream.
   * Without it every model of the adapter is allowed and no connection is chosen (tests of the run manager alone).
   */
  connections?: {
    resolve(input: RunSettingsInput): RunSettings;
    runFailed(run: RunRow, code: string): StreamEvent[];
  };
};

/**
 * Run manager (#12): one run at a time per conversation, persisted status and events, replay for reconnects,
 * interrupt, and recovery after a restart. Runs are independent of HTTP requests — a browser that goes away
 * does not stop the run; reopening the stream replays what was missed (`Last-Event-ID`).
 */
export class RunManager {
  private readonly live = new Map<string, Live>();
  /**
   * Runtime sessions per connection (#17), by their whole lifetime — opening, running, closing — not only while
   * the run is live: a run that was ended (e.g. after the interrupt grace period) while its session was still
   * opening stays here until that open has failed or the session has closed. `stopConnection` aborts and awaits all
   * of them before the connection's folder may go.
   */
  private readonly sessionsByConnection = new Map<
    string,
    Set<{ abort: AbortController; work: Promise<void> }>
  >();
  /** MCP call tokens: one per run, revoked when the run ends (#42). */
  readonly mcpTokens: McpTokens;
  /** Set by shutdown(): no new run may start after that. */
  private stopping = false;
  private readonly now: () => number;
  private readonly flushMs: number;
  private readonly templates: Templates;

  constructor(
    private readonly db: Db,
    private readonly conversations: ConversationStore,
    private readonly registry: RuntimeRegistry,
    events: AppEvents,
    private readonly opts: RunManagerOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.flushMs = opts.flushMs ?? 500;
    this.mcpTokens = opts.mcpTokens ?? new McpTokens();
    this.templates = opts.instructions ?? defaultTemplates();
    if (opts.mcp) trustOurTools(opts.mcp.toolNames());
    // Deleting a conversation (its runs cascade) stops what is running there first.
    conversations.onDelete((conversationId) => {
      for (const [id, live] of this.live) if (live.conversationId === conversationId) this.drop(id, live);
    });
    // A deactivated user's runs stop (their streams are closed by watchAccess).
    events.on("user-access-changed", (e) => {
      if (e.reason !== "deactivated") return;
      for (const r of this.db
        .select()
        .from(runs)
        .where(and(eq(runs.userId, e.userId), inArray(runs.status, ["queued", "running"])))
        .all())
        void this.interrupt(r.id);
    });
  }

  get(id: string): RunRow | undefined {
    return this.db.select().from(runs).where(eq(runs.id, id)).get();
  }

  active(conversationId: string): RunRow | undefined {
    return this.db
      .select()
      .from(runs)
      .where(and(eq(runs.conversationId, conversationId), inArray(runs.status, ["queued", "running"])))
      .get();
  }

  byIdempotencyKey(userId: string, key: string): RunRow | undefined {
    return this.db
      .select()
      .from(runs)
      .where(and(eq(runs.userId, userId), eq(runs.idempotencyKey, key)))
      .get();
  }

  /** Marks runs left over from a previous process as failed. Call once at startup, before serving. */
  recover(): number {
    const stale = this.db
      .select()
      .from(runs)
      .where(inArray(runs.status, ["queued", "running"]))
      .all();
    for (const r of stale) this.finish(r, "failed", "server_restart");
    return stale.length;
  }

  /**
   * Starts a reply. `prepare` runs inside the same transaction as the busy check and must create the messages
   * (user message if any, then the pending assistant message). Same idempotency key → the existing run.
   */
  begin(input: {
    conversationId: string;
    userId: string;
    idempotencyKey?: string | undefined;
    /** Runtime, model, effort and connection asked for by the request (#17); checked by `opts.connections`. */
    choice?: RunChoice | undefined;
    /** What its usage is recorded as (#44). Default `chat`; scheduled runs (#33) pass `schedule`. */
    purpose?: UsagePurpose | undefined;
    prepare: () => { user: MessageRow | null; assistant: MessageRow };
  }): { run: RunRow; user: MessageRow | null; assistant: MessageRow; reused: boolean } {
    if (this.stopping) throw new ShuttingDownError();
    const created = this.db.$client
      .transaction(() => {
        if (input.idempotencyKey) {
          const prev = this.byIdempotencyKey(input.userId, input.idempotencyKey);
          if (prev) {
            if (prev.conversationId !== input.conversationId) throw new IdempotencyConflictError();
            return {
              run: prev,
              user: prev.userMessageId ? (this.conversations.messageById(prev.userMessageId) ?? null) : null,
              assistant: this.conversations.messageById(prev.assistantMessageId)!,
              reused: true,
            };
          }
        }
        if (this.active(input.conversationId)) throw new RunBusyError();
        const conv = this.conversations.get(input.conversationId)!;
        const { user, assistant } = input.prepare();
        // Settings: a regenerated reply keeps its runtime and model; otherwise the conversation's last runtime.
        // Per-user defaults and fallbacks come with #19; per-conversation choice with #19/#45.
        const choice = input.choice ?? {};
        const runtime =
          choice.runtime ??
          (assistant.runtime as RuntimeId | null) ??
          (conv.lastRuntime as RuntimeId | null) ??
          DEFAULT_RUNTIME;
        // An explicitly chosen runtime is never swapped for another one.
        const adapter =
          this.registry.get(runtime) ??
          (choice.runtime ? undefined : this.registry.get(this.registry.ids()[0]!));
        const models = adapter?.capabilities().models ?? [];
        // #17: the user's policy decides (403 for explicit choices it does not allow); throwing rolls back prepare().
        const settings =
          adapter && this.opts.connections
            ? this.opts.connections.resolve({
                userId: input.userId,
                runtime: adapter.id,
                capabilities: adapter.capabilities(),
                requested: choice,
                current: { model: assistant.model, effort: assistant.effort },
              })
            : undefined;
        const model = settings?.model ?? models.find((m) => m.id === assistant.model) ?? models[0];
        const run: RunRow = {
          id: crypto.randomUUID(),
          conversationId: input.conversationId,
          userId: input.userId,
          userMessageId: user?.id ?? null,
          assistantMessageId: assistant.id,
          status: "queued",
          errorCode: null,
          runtime: adapter?.id ?? runtime,
          model: model?.id ?? assistant.model ?? "unknown",
          instructions: null,
          effort: settings
            ? settings.effort
            : ((model && assistant.model === model.id ? assistant.effort : null) ??
              model?.defaultEffort ??
              null),
          connectionId: settings?.connectionId ?? null,
          connectionVersion: settings?.connectionVersion ?? null,
          useShared: settings?.useShared ?? false,
          idempotencyKey: input.idempotencyKey ?? null,
          nextEventSeq: 1,
          createdAt: this.now(),
          endedAt: null,
        };
        this.db.insert(runs).values(run).run();
        if (adapter)
          this.conversations.updateMessage(assistant.id, {
            runtime: run.runtime,
            model: run.model,
            effort: run.effort,
            connectionId: run.connectionId,
          });
        // Nothing to run it with: fail right here, so the conversation is free again at once.
        if (!adapter) this.finish(run, "failed", "no_runtime");
        else if (adapter.capabilities().needsConnection && this.opts.connections && !run.connectionId)
          this.finish(run, "failed", "no_connection");
        return { run, user, assistant, reused: false };
      })
      .immediate();
    // The persisted status decides: a run that already failed inside the transaction (no runtime) is not started.
    const run = this.get(created.run.id)!;
    if (!created.reused && run.status === "queued") {
      let executed!: () => void;
      this.live.set(run.id, {
        conversationId: run.conversationId,
        connectionId: run.connectionId,
        abort: new AbortController(),
        done: new Promise<void>((r) => (executed = r)),
        emitter: new EventEmitter(),
        parts: [],
        interruptRequested: false,
        settled: false,
        attempt: 0,
        purpose: input.purpose ?? "chat",
        usage: new Map(),
        tools: new Map(),
      });
      const live = this.live.get(run.id)!;
      if (run.connectionId) {
        const set = this.sessionsByConnection.get(run.connectionId) ?? new Set();
        this.sessionsByConnection.set(run.connectionId, set);
        // Over when execute has returned (an open still pending has settled) and the session is closed.
        const entry = { abort: live.abort, work: live.done.then(() => closeSession(live)) };
        set.add(entry);
        void entry.work.finally(() => {
          set.delete(entry);
          if (!set.size && this.sessionsByConnection.get(run.connectionId!) === set)
            this.sessionsByConnection.delete(run.connectionId!);
        });
      }
      // Detached from the request: the run outlives the HTTP connection. Nothing may escape as a rejection.
      setImmediate(() => {
        this.execute(run.id)
          .catch(() => this.settle(run.id, "failed", "runtime_error"))
          .finally(executed);
      });
    }
    return { ...created, run };
  }

  /**
   * Stops a run; the partial reply is kept as "stopped". Idempotent. A runtime that does not stop within the
   * grace period (or is still opening its session) is not waited for: the run ends without it, and whatever
   * it sends later is ignored — the conversation never stays locked.
   */
  async interrupt(id: string): Promise<RunRow | undefined> {
    const live = this.live.get(id);
    if (live && !live.settled) {
      live.interruptRequested = true;
      live.graceTimer ??= setTimeout(
        () => this.settle(id, "interrupted", null),
        this.opts.interruptGraceMs ?? 3000,
      );
      live.graceTimer.unref();
      // A session still opening can do nothing useful any more: abort it (the adapter kills its process).
      if (!live.session) live.abort.abort();
      // Not awaited: the request returns at once; the grace timer ends the run if the runtime never stops.
      fireInterrupt(live);
    } else if (!live) {
      const r = this.get(id);
      if (r && (r.status === "queued" || r.status === "running")) this.finish(r, "interrupted", null);
    }
    return this.get(id);
  }

  /**
   * Stops every queued or running run on a connection (it was disconnected or got a new key, #17) and resolves once
   * their runtimes are gone: a session still opening is aborted (the adapter kills its process), an open one is
   * interrupted and closed. Waits at most `ms` per run — by then the adapters have force-killed their processes.
   * Only after this may the connection's folder be removed.
   */
  async stopConnection(connectionId: string, ms = 10_000): Promise<void> {
    // Every session of this connection, including those of runs that have already ended while still opening.
    const mine = [...(this.sessionsByConnection.get(connectionId) ?? [])];
    for (const e of mine) e.abort.abort();
    for (const r of this.db
      .select()
      .from(runs)
      .where(and(eq(runs.connectionId, connectionId), inArray(runs.status, ["queued", "running"])))
      .all())
      void this.interrupt(r.id);
    await Promise.all(
      mine.map((e) => Promise.race([e.work, new Promise<void>((r) => setTimeout(r, ms).unref())])),
    );
  }

  /** Events after `afterSeq`, in order. */
  eventsAfter(id: string, afterSeq: number): { seq: number; data: StreamEvent }[] {
    return this.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, id), gt(runEvents.seq, afterSeq)))
      .orderBy(asc(runEvents.seq))
      .all()
      .map((e) => ({ seq: e.seq, data: e.data as StreamEvent }));
  }

  /** Live event feed of a running run (undefined once it has ended). */
  subscribe(
    id: string,
    onEvent: (seq: number, e: StreamEvent) => void,
    onEnd: () => void,
  ): (() => void) | undefined {
    const live = this.live.get(id);
    if (!live) return undefined;
    live.emitter.on("event", onEvent);
    live.emitter.once("end", onEnd);
    return () => {
      live.emitter.off("event", onEvent);
      live.emitter.off("end", onEnd);
    };
  }

  /** Runs this process is executing right now. */
  liveCount(): number {
    return this.live.size;
  }

  /**
   * On shutdown (preClose): ends every open event stream, stops runtimes and releases their sessions without
   * waiting on a runtime that hangs. The runs themselves are failed by `recover()` on the next start.
   */
  async shutdown(): Promise<void> {
    this.stopping = true;
    const entries = [...this.live.entries()];
    const lives = entries.map(([, l]) => l);
    this.live.clear();
    for (const [id] of entries) this.mcpTokens.revokeRun(id); // runtimes must not call our tools any more
    for (const live of lives) {
      clearTimeout(live.graceTimer);
      live.settled = true;
      if (!live.session) live.abort.abort(); // sessions still opening: their processes go too
      fireInterrupt(live);
      live.emitter.emit("end"); // closes the SSE streams following these runs
    }
    await Promise.all(lives.map((live) => closeSession(live)));
  }

  /** True when the run ended long enough ago that its events were purged. */
  eventsExpired(r: RunRow): boolean {
    return r.endedAt !== null && this.now() - r.endedAt > EVENT_RETENTION_MS;
  }

  /** Deletes events of runs that ended more than an hour ago. */
  purgeEvents(): number {
    const cutoff = this.now() - EVENT_RETENTION_MS;
    const ended = this.db
      .select({ id: runs.id })
      .from(runs)
      .where(and(isNotNull(runs.endedAt), lt(runs.endedAt, cutoff)));
    return this.db.delete(runEvents).where(inArray(runEvents.runId, ended)).run().changes;
  }

  // ---- internals ----

  private emit(runId: string, event: StreamEvent): void {
    const data = StreamEvent.parse(event);
    const seq = this.db.$client
      .transaction(() => {
        const r = this.db
          .update(runs)
          .set({ nextEventSeq: sql`${runs.nextEventSeq} + 1` })
          .where(eq(runs.id, runId))
          .returning({ seq: runs.nextEventSeq })
          .get();
        if (!r) return undefined; // the run is gone (its conversation was deleted)
        const s = r.seq - 1;
        this.db.insert(runEvents).values({ runId, seq: s, data, createdAt: this.now() }).run();
        return s;
      })
      .immediate();
    if (seq !== undefined) this.live.get(runId)?.emitter.emit("event", seq, data);
  }

  /** Ends a live run exactly once: saves the reply so far and records the outcome. Later calls do nothing. */
  private settle(runId: string, status: "done" | "interrupted" | "failed", code: string | null): void {
    const live = this.live.get(runId);
    if (!live || live.settled) return;
    live.settled = true;
    clearTimeout(live.graceTimer);
    // Ended while its session was still opening (the grace period ran out): that open is cancelled.
    if (!live.session) live.abort.abort();
    const row = this.get(runId);
    if (!row) return this.drop(runId, live);
    this.attachFinanceNote(runId, row, live);
    this.conversations.updateMessage(row.assistantMessageId, { parts: live.parts });
    this.finish(row, status, code);
    void closeSession(live);
  }

  /**
   * The common finance output check (#30): an answer that used a finance tool — or a follow-up stating figures
   * after one — gets the server's note (sources, as-of times, what the answer left out, disclaimer), however the
   * run ended. A broken check never breaks the reply.
   */
  private attachFinanceNote(runId: string, row: RunRow, live: Live): void {
    if (live.parts.some((p) => p.type === "finance_note")) return;
    let note;
    try {
      note = financeNote(live.parts, live.financeCarry);
    } catch {
      return;
    }
    if (!note) return;
    live.parts.push(note);
    const partIndex = live.parts.filter((p) => p.type !== "reasoning").length - 1;
    this.emit(runId, { type: "part_update", messageId: row.assistantMessageId, partIndex, part: note });
  }

  /** Forgets a live run without recording anything (its rows are being deleted with the conversation). */
  private drop(runId: string, live: Live): void {
    this.mcpTokens.revokeRun(runId);
    if (!live.session) live.abort.abort();
    live.settled = true;
    clearTimeout(live.graceTimer);
    fireInterrupt(live);
    void closeSession(live);
    this.live.delete(runId);
    live.emitter.emit("end");
  }

  private finish(r: RunRow, status: "done" | "interrupted" | "failed", errorCode: string | null): void {
    const messageStatus = status === "done" ? "complete" : status === "interrupted" ? "stopped" : "error";
    this.conversations.updateMessage(r.assistantMessageId, { status: messageStatus });
    if (status === "failed") {
      const code = errorCode ?? "runtime_error";
      this.emit(r.id, { type: "error", code, message: FAILURE_TEXT[code] ?? FAILURE_TEXT.runtime_error! });
    }
    this.emit(r.id, { type: "done", messageId: r.assistantMessageId, status: messageStatus });
    this.mcpTokens.revokeRun(r.id);
    this.db.update(runs).set({ status, errorCode, endedAt: this.now() }).where(eq(runs.id, r.id)).run();
    const live = this.live.get(r.id);
    this.live.delete(r.id);
    this.record(r, status, errorCode, live);
    live?.emitter.emit("end");
  }

  /** One log record per run, and a recent-error entry when it failed (#46). IDs, codes and numbers only. */
  private record(r: RunRow, status: string, errorCode: string | null, live: Live | undefined): void {
    const ids = { userId: r.userId, conversationId: r.conversationId, runId: r.id, runtime: r.runtime };
    const failed = status === "failed";
    const code = failed ? (errorCode ?? "runtime_error") : undefined;
    logEvent(this.opts.log, failed ? "warn" : "info", "run.finished", {
      ...ids,
      status,
      durationMs: this.now() - r.createdAt,
      ...(code ? { errorCode: code, category: runFailureCategory(code) } : {}),
      ...(live ? usageTotals(live) : {}),
      ...(failed && live?.failure !== undefined ? { err: live.failure } : {}),
    });
    if (code) this.opts.errors?.record({ source: "run", code, category: runFailureCategory(code), ...ids });
  }

  /**
   * Writes an attempt's usage (#44). A storage failure is logged (IDs and codes only) and does not fail the reply.
   */
  private recordUsage(run: RunRow, live: Live, attempt: number, report: UsageReport): void {
    try {
      this.opts.usage?.record(
        {
          userId: run.userId,
          conversationId: run.conversationId,
          runId: run.id,
          attempt,
          runtime: run.runtime,
          model: run.model,
          connectionId: run.connectionId,
          purpose: live.purpose,
        },
        report,
      );
    } catch (e) {
      logEvent(this.opts.log, "warn", "usage.record_failed", {
        userId: run.userId,
        conversationId: run.conversationId,
        runId: run.id,
        runtime: run.runtime,
        attempt,
        purpose: live.purpose,
        err: e,
      });
    }
  }

  private toolEnded(run: RunRow, live: Live, callId: string, isError: boolean): void {
    const t = live.tools.get(callId);
    live.tools.delete(callId);
    const ids = {
      userId: run.userId,
      conversationId: run.conversationId,
      runId: run.id,
      runtime: run.runtime,
    };
    // Only known tool names are logged; whatever else a runtime reports becomes "other".
    const tool = toolLabel(t?.name ?? "other");
    logEvent(this.opts.log, isError ? "warn" : "info", "tool.finished", {
      ...ids,
      tool,
      status: isError ? "error" : "ok",
      ...(t ? { durationMs: this.now() - t.startedAt } : {}),
    });
    if (isError)
      this.opts.errors?.record({ source: "tool", code: "tool_error", category: "tool", tool, ...ids });
  }

  private async openSession(
    run: RunRow,
    history: MessageRow[],
    live: Live,
  ): Promise<{ session: RuntimeSession; sessionRowId: string; revision: number }> {
    const adapter = this.registry.get(run.runtime as RuntimeId)!;
    const conv = this.conversations.get(run.conversationId)!;
    const caps = adapter.capabilities();
    const mcp = caps.usesTools || caps.runTools ? this.opts.mcp : undefined;
    // Per user: a skill the user may not use is not even offered (and the MCP server refuses it anyway).
    const tools = mcp ? trustOurTools(mcp.toolNamesFor(run.userId)) : [];
    // The same instructions for every runtime (#20): built per run from the user, the conversation and the tools.
    const user = this.db.select({ youth: users.youth }).from(users).where(eq(users.id, run.userId)).get();
    const instructions = assembleInstructions({
      user: { youth: user?.youth === true },
      mode: conv.researchMode ? "research" : "normal",
      tools,
      now: new Date(this.now()),
      templates: this.templates,
    });
    this.db
      .update(runs)
      .set({ instructions: instructions.versions.join(",") })
      .where(eq(runs.id, run.id))
      .run();
    const ctx: StartContext = {
      conversationId: run.conversationId,
      userId: run.userId,
      connectionId: run.connectionId ?? undefined,
      connectionVersion: run.connectionVersion ?? undefined,
      signal: live.abort.signal,
      history: history.map((m) => ({ role: m.role, parts: publicParts(m.parts as MessagePart[]) })),
      systemPrompt: instructions.text,
      model: run.model,
      effort: run.effort ?? undefined,
      tools,
    };
    if (mcp) {
      const { url } = await mcp.endpoint(); // a server that cannot start fails the run (no silent tool loss)
      if (live.settled || live.interruptRequested || this.stopping) throw new RunEndedError();
      ctx.mcp = {
        url,
        token: this.mcpTokens.issue({
          userId: run.userId,
          conversationId: run.conversationId,
          runId: run.id,
        }),
      };
    }
    // Resume only a session that saw exactly this history (#45 refines the matching and summarising), was started
    // with exactly these instructions (runtimes keep their start prompt: a new date, mode or template version
    // needs a fresh session), and only on runtimes that can resume at all.
    const lastSeen = history.at(-1)?.id ?? null;
    const prev = !adapter.capabilities().canResume
      ? undefined
      : this.conversations.sessions(run.conversationId).find(
          (s) =>
            s.runtime === run.runtime &&
            // A session lives in its connection's folder: only the same connection may resume it (#17).
            (s.connectionId ?? null) === (run.connectionId ?? null) &&
            s.conversationRevision === conv.revision &&
            s.lastMessageId === lastSeen &&
            s.instructionsHash === instructions.hash,
        );
    if (prev) {
      try {
        return {
          session: await adapter.resume(prev.externalSessionId, ctx),
          sessionRowId: prev.id,
          revision: conv.revision,
        };
      } catch (e) {
        if (!(e instanceof SessionGoneError)) throw e;
        this.conversations.invalidateSession(prev.id);
      }
    }
    // The run may have ended while resume() was pending (interrupt, delete, shutdown): open nothing new then.
    if (live.settled || live.interruptRequested || this.stopping) throw new RunEndedError();
    const session = await adapter.start(ctx);
    try {
      // The history may have changed (edit, delete) while the session was opening: then this fails.
      const row = this.conversations.saveSession({
        conversationId: run.conversationId,
        runtime: run.runtime,
        connectionId: run.connectionId,
        externalSessionId: session.externalSessionId,
        lastMessageId: lastSeen,
        conversationRevision: conv.revision,
        instructionsHash: instructions.hash,
      });
      return { session, sessionRowId: row.id, revision: conv.revision };
    } catch (e) {
      await session.close().catch(() => {});
      throw e;
    }
  }

  private async execute(runId: string): Promise<void> {
    const run = this.get(runId);
    const live = this.live.get(runId);
    if (!run || !live || run.status !== "queued") return;
    if (live.interruptRequested) return this.settle(runId, "interrupted", null);
    this.db.update(runs).set({ status: "running" }).where(eq(runs.id, runId)).run();
    const messageId = run.assistantMessageId;
    this.conversations.updateMessage(messageId, { status: "streaming" });

    // History = active messages before the reply; the turn's input is the last user message.
    const all = this.conversations.messages(run.conversationId, { limit: 10_000 });
    const before = all.filter((m) => m.id !== messageId);
    const lastUser = [...before].reverse().find((m) => m.role === "user");
    live.financeCarry = carriedSources(before);
    const inputText = (lastUser?.parts as MessagePart[] | undefined)
      ?.flatMap((p) => (p.type === "text" ? [p.text] : []))
      .join("\n");

    const parts = live.parts;
    let lastFlush = this.now();
    const flush = (force = false) => {
      if (live.settled || (!force && this.now() - lastFlush < this.flushMs)) return;
      lastFlush = this.now();
      this.conversations.updateMessage(messageId, { parts });
    };
    /** Appends text; returns the index among the *public* parts (what the message API shows). */
    const appendText = (type: "text" | "reasoning", text: string): number => {
      const last = parts.at(-1);
      if (last && last.type === type) last.text += text;
      else parts.push({ type, text });
      return parts.filter((p) => p.type !== "reasoning").length - 1;
    };

    let outcome: { status: "done" | "interrupted" | "failed"; code: string | null } = {
      status: "done",
      code: null,
    };
    // One attempt = this session open + the turn below (#44).
    const attempt = nextAttempt(live);
    try {
      const { session, sessionRowId, revision } = await this.openSession(
        run,
        before.filter((m) => m !== lastUser),
        live,
      );
      live.session = session;
      // Interrupted or deleted while the session was opening.
      if (live.settled) return void closeSession(live);
      if (live.interruptRequested) return this.settle(runId, "interrupted", null);
      const turn = session.turn({ text: inputText ?? "", model: run.model, effort: run.effort ?? undefined });
      live.turn = turn;
      for await (const ev of turn.events) {
        if (live.settled) break; // force-stopped or deleted: whatever arrives now is ignored
        if (ev.type === "text_delta") {
          const partIndex = appendText("text", ev.text);
          this.emit(runId, { type: "delta", messageId, partIndex, text: ev.text });
          flush();
        } else if (ev.type === "reasoning_delta") {
          appendText("reasoning", ev.text); // stored, never streamed
        } else if (ev.type === "tool_start") {
          // Missing input/output become null: JSON would drop an undefined key and the stored part would no
          // longer match the schema.
          const input = ev.input ?? null;
          live.tools.set(ev.callId, { name: ev.name, startedAt: this.now() });
          parts.push({ type: "tool_call", id: ev.callId, name: ev.name, input });
          this.emit(runId, { type: "tool_start", messageId, callId: ev.callId, name: ev.name, input });
          flush(true);
        } else if (ev.type === "tool_end") {
          const extra = ev.isError ? { isError: true } : {};
          const output = ev.output ?? null;
          this.toolEnded(run, live, ev.callId, ev.isError === true);
          parts.push({ type: "tool_result", callId: ev.callId, output, ...extra });
          this.emit(runId, { type: "tool_end", messageId, callId: ev.callId, output, ...extra });
          flush(true);
        } else if (ev.type === "usage") {
          // The attempt's usage so far: replaces the attempt's earlier report, in memory and in storage (#44).
          const report = usageReport(ev);
          live.usage.set(attempt, report);
          this.recordUsage(run, live, attempt, report);
          this.emit(runId, {
            type: "usage",
            messageId,
            inputTokens: ev.inputTokens ?? 0,
            outputTokens: ev.outputTokens ?? 0,
            ...(ev.costUsd === undefined ? {} : { costUsd: ev.costUsd }),
          });
        } else if (ev.type === "notice") {
          this.emit(runId, ev);
        } else if (ev.type === "limit") {
          this.emit(runId, { type: "notice", level: "warn", code: ev.code, message: ev.message });
          outcome = { status: "failed", code: "usage_limit" };
        }
      }
      if (live.settled) return;
      if (live.interruptRequested) outcome = { status: "interrupted", code: null };
      // The session now reflects this reply as well; otherwise it must not be resumed.
      if (outcome.status === "done") this.conversations.touchSession(sessionRowId, messageId, revision);
      else this.conversations.invalidateSession(sessionRowId);
    } catch (e) {
      // Only interrupts we asked for count as "stopped"; any other error is a failure (spike #39). The error's
      // text is never kept: a fixed code goes to the browser, the log keeps the class name and code only.
      // An adapter's named failure (RuntimeFailure: runtime_auth, no_connection, runtime_policy) keeps its code.
      if (live.interruptRequested) outcome = { status: "interrupted", code: null };
      else {
        live.failure = e;
        if (e instanceof RuntimeFailure) outcome = { status: "failed", code: e.code };
        else {
          const c = classifyError(e, { code: "runtime_error", category: "runtime" });
          // A 4xx status on a runtime error is the provider's, not the browser's request: still a runtime error.
          outcome = { status: "failed", code: c.category === "client" ? "runtime_error" : c.code };
        }
      }
    }
    // A failure on a connection (expired credential, personal limit): its notices go out before the error (#17).
    if (outcome.status === "failed" && run.connectionId && !live.settled)
      for (const ev of this.opts.connections?.runFailed(run, outcome.code ?? "runtime_error") ?? [])
        this.emit(runId, ev);
    this.settle(runId, outcome.status, outcome.code);
  }
}
