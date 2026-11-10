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
type Live = { emitter: EventEmitter; turn?: RuntimeTurn; interruptRequested: boolean };

export const EVENT_RETENTION_MS = 3600_000;
export const DEFAULT_RUNTIME: RuntimeId = "claude-code";

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
  systemPrompt?: string;
};

/**
 * Run manager (#12): one run at a time per conversation, persisted status and events, replay for reconnects,
 * interrupt, and recovery after a restart. Runs are independent of HTTP requests — a browser that goes away
 * does not stop the run; reopening the stream replays what was missed (`Last-Event-ID`).
 */
export class RunManager {
  private readonly live = new Map<string, Live>();
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
    if (!created.reused && created.run.status === "queued") {
      this.live.set(created.run.id, { emitter: new EventEmitter(), interruptRequested: false });
      // Detached from the request: the run outlives the HTTP connection.
      setImmediate(() => void this.execute(created.run.id));
    }
    return { ...created, run: this.get(created.run.id)! };
  }

  /** Stops a run; the partial reply is kept as "stopped". Idempotent. */
  async interrupt(id: string): Promise<RunRow | undefined> {
    const live = this.live.get(id);
    if (live) {
      live.interruptRequested = true;
      await live.turn?.interrupt();
    } else {
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
          .get()!;
        const s = r.seq - 1;
        this.db.insert(runEvents).values({ runId, seq: s, data, createdAt: this.now() }).run();
        return s;
      })
      .immediate();
    this.live.get(runId)?.emitter.emit("event", seq, data);
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
    // Resume only a session that saw exactly this history (#45 refines the matching and summarising).
    const lastSeen = history.at(-1)?.id ?? null;
    const prev = this.conversations
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
    const row = this.conversations.saveSession({
      conversationId: run.conversationId,
      runtime: run.runtime,
      externalSessionId: session.externalSessionId,
      lastMessageId: lastSeen,
      conversationRevision: conv.revision,
    });
    return { session, sessionRowId: row.id, revision: conv.revision };
  }

  private async execute(runId: string): Promise<void> {
    const run = this.get(runId);
    const live = this.live.get(runId);
    if (!run || !live || run.status !== "queued") return;
    if (live.interruptRequested) return this.finish(run, "interrupted", null);
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

    const parts: MessagePart[] = [];
    let lastFlush = this.now();
    const flush = (force = false) => {
      if (!force && this.now() - lastFlush < this.flushMs) return;
      lastFlush = this.now();
      this.conversations.updateMessage(messageId, { parts });
    };
    const appendText = (type: "text" | "reasoning", text: string): number => {
      const last = parts.at(-1);
      if (last && last.type === type) last.text += text;
      else parts.push({ type, text });
      return parts.length - 1;
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
      if (live.interruptRequested) {
        outcome = { status: "interrupted", code: null };
      } else {
        const turn = session.turn({
          text: inputText ?? "",
          model: run.model,
          effort: run.effort ?? undefined,
        });
        live.turn = turn;
        for await (const ev of turn.events) {
          if (ev.type === "text_delta") {
            const partIndex = appendText("text", ev.text);
            this.emit(runId, { type: "delta", messageId, partIndex, text: ev.text });
            flush();
          } else if (ev.type === "reasoning_delta") {
            appendText("reasoning", ev.text); // stored, never streamed
          } else if (ev.type === "tool_start") {
            parts.push({ type: "tool_call", id: ev.callId, name: ev.name, input: ev.input });
            this.emit(runId, {
              type: "tool_start",
              messageId,
              callId: ev.callId,
              name: ev.name,
              input: ev.input,
            });
            flush(true);
          } else if (ev.type === "tool_end") {
            parts.push({
              type: "tool_result",
              callId: ev.callId,
              output: ev.output,
              ...(ev.isError ? { isError: true } : {}),
            });
            this.emit(runId, {
              type: "tool_end",
              messageId,
              callId: ev.callId,
              output: ev.output,
              ...(ev.isError ? { isError: true } : {}),
            });
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
        if (live.interruptRequested) outcome = { status: "interrupted", code: null };
        // The session now reflects this reply as well.
        if (outcome.status === "done") this.conversations.touchSession(sessionRowId, messageId, revision);
        else this.conversations.invalidateSession(sessionRowId);
      }
    } catch {
      // Only interrupts we asked for count as "stopped"; any other error is a failure (spike #39).
      outcome = live.interruptRequested
        ? { status: "interrupted", code: null }
        : { status: "failed", code: "runtime_error" };
    }
    this.conversations.updateMessage(messageId, { parts });
    this.finish(this.get(runId)!, outcome.status, outcome.code);
  }
}
