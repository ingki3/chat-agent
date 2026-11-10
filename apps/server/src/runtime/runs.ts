import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { and, asc, eq, gt, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { publicParts, StreamEvent, type MessagePart, type Run, type RuntimeId } from "@agentlee/shared";
import type { ConversationStore, MessageRow } from "../conversations/store.js";
import type { Db } from "../db/client.js";
import { runEvents, runs } from "../db/schema.js";
import type { AppEvents } from "../events.js";
import { SessionGoneError, type RuntimeRegistry, type RuntimeSession, type RuntimeTurn } from "./adapter.js";

export type RunRow = typeof runs.$inferSelect;
/** In-memory state of a run that is being executed by this process. */
type Live = {
  conversationId: string;
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

export const EVENT_RETENTION_MS = 3600_000;
export const DEFAULT_RUNTIME: RuntimeId = "claude-code";

export class ShuttingDownError extends Error {
  constructor() {
    super("the server is shutting down");
  }
}

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
};

export type RunManagerOptions = {
  now?: () => number;
  /** How often partial replies are written to the message row while streaming. */
  flushMs?: number;
  /** After interrupt(), how long the runtime gets to stop before the run is ended without it. */
  interruptGraceMs?: number;
  systemPrompt?: string;
};

/**
 * Run manager (#12): one run at a time per conversation, persisted status and events, replay for reconnects,
 * interrupt, and recovery after a restart. Runs are independent of HTTP requests — a browser that goes away
 * does not stop the run; reopening the stream replays what was missed (`Last-Event-ID`).
 */
export class RunManager {
  private readonly live = new Map<string, Live>();
  /** Set by shutdown(): no new run may start after that. */
  private stopping = false;
  private readonly now: () => number;
  private readonly flushMs: number;

  constructor(
    private readonly db: Db,
    private readonly conversations: ConversationStore,
    private readonly registry: RuntimeRegistry,
    events: AppEvents,
    private readonly opts: RunManagerOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.flushMs = opts.flushMs ?? 500;
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
        const runtime =
          (assistant.runtime as RuntimeId | null) ??
          (conv.lastRuntime as RuntimeId | null) ??
          DEFAULT_RUNTIME;
        const adapter = this.registry.get(runtime) ?? this.registry.get(this.registry.ids()[0]!);
        const models = adapter?.capabilities().models ?? [];
        const model = models.find((m) => m.id === assistant.model) ?? models[0];
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
          effort:
            (model && assistant.model === model.id ? assistant.effort : null) ?? model?.defaultEffort ?? null,
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
          });
        // Nothing to run it with: fail right here, so the conversation is free again at once.
        if (!adapter) this.finish(run, "failed", "no_runtime");
        return { run, user, assistant, reused: false };
      })
      .immediate();
    // The persisted status decides: a run that already failed inside the transaction (no runtime) is not started.
    const run = this.get(created.run.id)!;
    if (!created.reused && run.status === "queued") {
      this.live.set(run.id, {
        conversationId: run.conversationId,
        emitter: new EventEmitter(),
        parts: [],
        interruptRequested: false,
        settled: false,
      });
      // Detached from the request: the run outlives the HTTP connection. Nothing may escape as a rejection.
      setImmediate(() => {
        this.execute(run.id).catch(() => this.settle(run.id, "failed", "runtime_error"));
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
      // Not awaited: the request returns at once; the grace timer ends the run if the runtime never stops.
      fireInterrupt(live);
    } else if (!live) {
      const r = this.get(id);
      if (r && (r.status === "queued" || r.status === "running")) this.finish(r, "interrupted", null);
    }
    return this.get(id);
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
    const lives = [...this.live.values()];
    this.live.clear();
    for (const live of lives) {
      clearTimeout(live.graceTimer);
      live.settled = true;
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
    const row = this.get(runId);
    if (!row) return this.drop(runId, live);
    this.conversations.updateMessage(row.assistantMessageId, { parts: live.parts });
    this.finish(row, status, code);
    void closeSession(live);
  }

  /** Forgets a live run without recording anything (its rows are being deleted with the conversation). */
  private drop(runId: string, live: Live): void {
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
    this.db.update(runs).set({ status, errorCode, endedAt: this.now() }).where(eq(runs.id, r.id)).run();
    const live = this.live.get(r.id);
    this.live.delete(r.id);
    live?.emitter.emit("end");
  }

  private async openSession(
    run: RunRow,
    history: MessageRow[],
  ): Promise<{ session: RuntimeSession; sessionRowId: string; revision: number }> {
    const adapter = this.registry.get(run.runtime as RuntimeId)!;
    const conv = this.conversations.get(run.conversationId)!;
    const ctx = {
      conversationId: run.conversationId,
      history: history.map((m) => ({ role: m.role, parts: publicParts(m.parts as MessagePart[]) })),
      systemPrompt: this.opts.systemPrompt ?? "",
      model: run.model,
      effort: run.effort ?? undefined,
      tools: [],
    };
    // Resume only a session that saw exactly this history (#45 refines the matching and summarising), and only
    // on runtimes that can resume at all.
    const lastSeen = history.at(-1)?.id ?? null;
    const prev = !adapter.capabilities().canResume
      ? undefined
      : this.conversations
          .sessions(run.conversationId)
          .find(
            (s) =>
              s.runtime === run.runtime &&
              s.conversationRevision === conv.revision &&
              s.lastMessageId === lastSeen,
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
    const session = await adapter.start(ctx);
    try {
      // The history may have changed (edit, delete) while the session was opening: then this fails.
      const row = this.conversations.saveSession({
        conversationId: run.conversationId,
        runtime: run.runtime,
        externalSessionId: session.externalSessionId,
        lastMessageId: lastSeen,
        conversationRevision: conv.revision,
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
    try {
      const { session, sessionRowId, revision } = await this.openSession(
        run,
        before.filter((m) => m !== lastUser),
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
          parts.push({ type: "tool_call", id: ev.callId, name: ev.name, input });
          this.emit(runId, { type: "tool_start", messageId, callId: ev.callId, name: ev.name, input });
          flush(true);
        } else if (ev.type === "tool_end") {
          const extra = ev.isError ? { isError: true } : {};
          const output = ev.output ?? null;
          parts.push({ type: "tool_result", callId: ev.callId, output, ...extra });
          this.emit(runId, { type: "tool_end", messageId, callId: ev.callId, output, ...extra });
          flush(true);
        } else if (ev.type === "usage") {
          this.emit(runId, {
            type: "usage",
            messageId,
            inputTokens: ev.inputTokens,
            outputTokens: ev.outputTokens,
            ...(ev.costUsd === undefined ? {} : { costUsd: ev.costUsd }),
          }); // stored per run/attempt by #44
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
    } catch {
      // Only interrupts we asked for count as "stopped"; any other error is a failure (spike #39).
      outcome = live.interruptRequested
        ? { status: "interrupted", code: null }
        : { status: "failed", code: "runtime_error" };
    }
    this.settle(runId, outcome.status, outcome.code);
  }
}
