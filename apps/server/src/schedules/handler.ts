import { publicParts, type MessagePart, type RunChoice, type ScheduleRunCode } from "@agentlee/shared";
import { RunAccessDenied, type RunAccess } from "../connections/access.js";
import { RUNTIME_LABEL } from "../connections/store.js";
import type { ConversationStore, MessageRow } from "../conversations/store.js";
import { logEvent, type EventLogger } from "../logging.js";
import type { PublishInput } from "../notifications/compose.js";
import type { RuntimeRegistry } from "../runtime/adapter.js";
import {
  IdempotencyConflictError,
  RunBusyError,
  ShuttingDownError,
  type RunManager,
  type RunRow as ChatRunRow,
} from "../runtime/runs.js";
import { scrubKnown } from "../secrets/known.js";
import type { ExecuteOutcome, RunOutcome, ScheduleHandler, ScheduleRunContext } from "./engine.js";
import type { ScheduleRow, ScheduleStore } from "./store.js";

/** How long one attempt's conversation run may take before it is stopped (`timeout`). */
export const RUN_TIMEOUT_MS = 20 * 60_000;
/** The connection warning comes this long before the next run (FR-11.8: "다음 실행 전"). */
export const WARNING_LEAD_MS = 3600_000;

/** Where a notification publishes to (NotificationService.publish). */
export type Publisher = {
  publish(userId: string, input: PublishInput, opts?: { dedupeKey?: string }): string | undefined;
};

/** The notification keys (#56): one per run, one warning per occurrence. */
export const runNotificationKey = (runId: string) => `schedule-run:${runId}`;
export const warningKey = (scheduleId: string, at: number) => `schedule-warning:${scheduleId}@${at}`;
/** The idempotency key of an attempt's conversation run: begun at most once per attempt, whoever asks again. */
export const attemptKey = (runId: string, attempt: number) => `schedule:${runId}:${attempt}`;

/** The run's code (the history's fixed code, FR-8.5) for a conversation run's failure code. */
export function scheduleCodeOf(chatCode: string | null): ScheduleRunCode {
  switch (chatCode) {
    case "no_runtime":
    case "no_connection":
    case "runtime_auth":
      return "runtime_unavailable";
    case "server_restart":
    case "interrupted":
      return "interrupted";
    case "timeout":
      return "timeout";
    case "not_allowed":
      return "not_allowed";
    default:
      return "run_failed";
  }
}

/**
 * What the failure message and notification say (FR-8.4·8.6) — fixed text per code, never the runtime's own error
 * text (it may hold user data). The conversation run's code is more precise; the run's code is the fallback.
 */
const REASON: Record<string, string> = {
  no_runtime: "쓸 수 있는 런타임이 없어요",
  no_connection: "이 런타임을 쓸 수 있는 연결이 없어요 — 설정 → 내 런타임 연결을 확인해 주세요",
  runtime_auth: "런타임 로그인이 만료됐거나 키가 맞지 않아요",
  runtime_unavailable: "런타임 연결을 쓸 수 없어요 — 설정 → 내 런타임 연결을 확인해 주세요",
  not_allowed: "이 예약의 런타임·모델을 지금은 쓸 수 없어요 — 예약을 수정해 주세요",
  usage_limit: "사용 한도에 도달했어요",
  context_too_large: "프롬프트가 너무 길어서 이 모델에 보낼 수 없어요",
  runtime_policy: "런타임이 허용되지 않은 도구를 쓰려고 해서 멈췄어요",
  timeout: "제한 시간 안에 끝나지 않았어요",
  interrupted: "실행이 중단됐어요(서버 재시작 또는 중지)",
  server_restart: "서버 재시작으로 중단됐어요",
  busy: "이 예약의 대화에서 다른 응답이 진행 중이었어요",
  run_failed: "응답 중 오류가 났어요",
  handler_error: "실행을 시작하지 못했어요",
};
export const reasonText = (chatCode: string | null, code: ScheduleRunCode | null) =>
  REASON[chatCode ?? ""] ?? REASON[code ?? ""] ?? REASON.run_failed!;

/**
 * The reason of a failed run: its conversation run's code, or — no conversation run begun and `run_failed` — the
 * conversation was busy with another reply (the only way `execute` fails like that).
 */
const failureReason = (chat: ChatRunRow | undefined, code: ScheduleRunCode | null) =>
  reasonText(chat?.errorCode ?? (!chat && code === "run_failed" ? "busy" : null), code);

/** The public text of a reply (the notification's summary). */
export const replyText = (m: MessageRow | undefined) =>
  m
    ? publicParts(m.parts as MessagePart[])
        .flatMap((p) => (p.type === "text" ? [p.text] : []))
        .join("\n")
    : "";

export type RuntimeScheduleHandlerDeps = {
  store: ScheduleStore;
  conversations: ConversationStore;
  runs: RunManager;
  /** Late-bound: the notification service is made after the engine (app.ts). */
  notifications: () => Publisher | undefined;
  now?: () => number;
  log?: EventLogger;
  /** Tests: a short limit for an attempt's conversation run. */
  runTimeoutMs?: number;
};

/**
 * The real schedule handler (#56, PRD FR-8.3·8.4·8.6): each run is a turn in the schedule's own result conversation
 * (`kind = schedule`, the owner's), run by the RunManager like a message the owner sent — the context builder (#45),
 * the owner's permissions, defaults and usage (`purpose = schedule`, #44), and the finance and citation checks of
 * every reply (#30, #25). The engine's guarantees (#33) hold per step:
 * - `execute`: the attempt's messages and its row (`schedule_attempts`) are written in the begin transaction; its
 *   conversation run has the idempotency key `schedule:<run>:<attempt>`, so it is begun at most once per attempt.
 *   A process that dies mid-run leaves that run to RunManager.recover (`server_restart`) and the attempt to the
 *   engine's recovery (one retry in all) — the retry regenerates the failed reply; there is never a second turn for
 *   the same attempt, and never more turns than attempts.
 * - `saveResult`: the reply (success) or a failure message, the "새 결과" marker and the `schedule_results` row in one
 *   transaction — found again after a crash, never stored twice.
 * - `notify`: one notification per run (`dedupe_key = schedule-run:<id>`).
 */
export class RuntimeScheduleHandler implements ScheduleHandler {
  private readonly now: () => number;

  constructor(private readonly deps: RuntimeScheduleHandlerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * The schedule's result conversation: the stored one while it is still the owner's schedule conversation,
   * otherwise a new one (first run, or the owner deleted it) — found or made in one transaction.
   */
  conversationFor(row: ScheduleRow): string {
    const { store, conversations } = this.deps;
    return store.transaction(() => {
      const s = store.byId(row.id) ?? row;
      const c = s.conversation_id ? conversations.get(s.conversation_id) : undefined;
      if (c && c.ownerId === s.owner_id && c.kind === "schedule") return c.id;
      const made = conversations.create(s.owner_id, {
        title: s.name,
        kind: "schedule",
        settings: { runtime: s.runtime, model: s.model, effort: s.effort, useShared: !!s.use_shared },
      });
      store.setConversation(s.id, made.id);
      return made.id;
    });
  }

  async execute(ctx: ScheduleRunContext): Promise<ExecuteOutcome> {
    const { store, conversations, runs } = this.deps;
    const row = store.byId(ctx.scheduleId);
    if (!row || row.owner_id !== ctx.ownerId) return { ok: false, code: "handler_error" };
    const conversationId = this.conversationFor(row);
    // The schedule's runtime·model·effort, checked for its owner as an explicit choice of a run (403 → not_allowed):
    // a schedule never runs with more than its creator may use now.
    const choice: RunChoice = { runtime: row.runtime, ...scheduleRequest(row) };
    const prompt = scrubKnown(row.prompt);
    let chat: ChatRunRow;
    try {
      chat = runs.begin({
        conversationId,
        userId: row.owner_id,
        idempotencyKey: attemptKey(ctx.runId, ctx.attempt),
        choice,
        purpose: "schedule",
        // Only the selected skills (FR-8.2), and of those only what the owner may use at each call (the MCP server
        // checks the user's permissions and the server allow-list too): an empty selection is no skill at all.
        skills: JSON.parse(row.skills) as string[],
        inputText: prompt,
        prepare: (divider) => {
          const turn = this.retryTarget(ctx.runId, conversationId);
          let user: MessageRow | null = null;
          let assistant: MessageRow | undefined;
          // The retry answers the same message again (its failed reply stays as an earlier version).
          if (turn) assistant = conversations.regenerate(conversationId, turn.assistant, divider);
          if (!assistant) {
            divider();
            user = conversations.append(conversationId, {
              role: "user",
              parts: [{ type: "text", text: prompt }],
            });
            assistant = conversations.append(conversationId, {
              role: "assistant",
              parts: [],
              status: "pending",
            });
          }
          store.recordAttempt({
            schedule_run_id: ctx.runId,
            attempt: ctx.attempt,
            conversation_id: conversationId,
            user_message_id: user?.id ?? turn?.user ?? null,
            assistant_message_id: assistant.id,
            created_at: this.now(),
          });
          return { user, assistant };
        },
      }).run;
    } catch (e) {
      if (e instanceof RunAccessDenied) return { ok: false, code: "not_allowed" };
      if (e instanceof ShuttingDownError) return { ok: false, code: "interrupted" };
      if (e instanceof RunBusyError || e instanceof IdempotencyConflictError)
        return { ok: false, code: "run_failed" };
      throw e;
    }
    store.setAttemptRun(ctx.runId, ctx.attempt, chat.id);
    const outputRef = chat.id;
    const ended = await this.waitEnd(chat.id, ctx.signal, this.deps.runTimeoutMs ?? RUN_TIMEOUT_MS);
    if (ended === "aborted") return { ok: false, code: "interrupted", outputRef };
    if (ended === "timeout") {
      await runs.interrupt(chat.id);
      await this.waitEnd(chat.id, ctx.signal, 10_000);
      return { ok: false, code: "timeout", outputRef };
    }
    const done = runs.get(chat.id);
    // Ended without an outcome: the run manager is shutting down (its runs are recovered at the next start). The
    // engine stops right after it — nothing is decided here; the next start counts this as an interrupted attempt.
    if (done && (done.status === "queued" || done.status === "running")) {
      await this.waitEnd("", ctx.signal, 10_000);
      return { ok: false, code: "interrupted", outputRef };
    }
    if (done?.status === "done") return { ok: true, outputRef };
    return {
      ok: false,
      code: done?.status === "interrupted" ? "interrupted" : scheduleCodeOf(done?.errorCode ?? null),
      outputRef,
    };
  }

  /**
   * The reply a retry regenerates: the run's last attempt's, while it is still the conversation's last turn (the
   * owner may have written there since — then the retry is a new message, nothing of theirs is cut).
   */
  private retryTarget(
    runId: string,
    conversationId: string,
  ): { user: string | null; assistant: string } | undefined {
    const last = this.deps.store.attempts(runId).at(-1);
    if (!last || last.conversation_id !== conversationId) return undefined;
    const active = this.deps.conversations.messages(conversationId, { limit: 10_000 });
    const tail = active.findLast((m) => m.role !== "system");
    if (tail?.id !== last.assistant_message_id) return undefined;
    return { user: last.user_message_id, assistant: last.assistant_message_id };
  }

  /** Until the conversation run has ended (or the engine stops, or the time is up). */
  private waitEnd(
    chatRunId: string,
    signal: AbortSignal,
    ms: number,
  ): Promise<"ended" | "aborted" | "timeout"> {
    return new Promise((resolve) => {
      const sub: { off?: (() => void) | undefined } = {};
      let settled = false;
      const finish = (v: "ended" | "aborted" | "timeout") => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        sub.off?.();
        resolve(v);
      };
      const onAbort = () => finish("aborted");
      const timer = setTimeout(() => finish("timeout"), ms);
      timer.unref();
      if (signal.aborted) return finish("aborted");
      signal.addEventListener("abort", onAbort);
      // No run: only the stop signal or the time ends the wait.
      if (!chatRunId) return;
      sub.off = this.deps.runs.subscribe(
        chatRunId,
        () => {},
        () => finish("ended"),
      );
      // Not live in this process: it has ended already.
      if (!sub.off) finish("ended");
    });
  }

  async saveResult(ctx: ScheduleRunContext, outcome: RunOutcome): Promise<{ resultRef: string | null }> {
    const { store, conversations, runs } = this.deps;
    return store.transaction(() => {
      const prev = store.result(ctx.runId);
      if (prev) return { resultRef: prev.message_id };
      const row = store.byId(ctx.scheduleId);
      const chat = outcome.outputRef ? runs.get(outcome.outputRef) : undefined;
      let conversationId = chat?.conversationId ?? store.attempts(ctx.runId).at(-1)?.conversation_id;
      if (conversationId && !conversations.get(conversationId)) conversationId = undefined;
      if (!conversationId && row) conversationId = this.conversationFor(row);
      let messageId: string | null = null;
      // Whether the result is still in the history (review #116): a reply regenerated or cut off by an edit before this
      // (retried or recovered) save stays the run's reference, but is no "새 결과" — nothing could ever clear it.
      let shown = true;
      if (conversationId) {
        if (outcome.status === "succeeded") {
          const reply = chat ? conversations.message(conversationId, chat.assistantMessageId) : undefined;
          messageId = reply?.id ?? null;
          shown = !reply || reply.active;
        } else {
          const attempts = store.run(ctx.runId)?.attempts ?? ctx.attempt;
          const reason = failureReason(chat, outcome.code);
          const text =
            `**예약 실행 실패** — ${reason}.` +
            (attempts > 1 ? "\n\n2분 뒤 한 번 더 시도했지만 실패했어요." : "");
          messageId = conversations.append(conversationId, {
            role: "assistant",
            parts: [{ type: "text", text }],
          }).id;
        }
        if (shown) conversations.markNewResult(conversationId, messageId);
      }
      store.recordResult({
        schedule_run_id: ctx.runId,
        conversation_id: conversationId ?? null,
        message_id: messageId,
        created_at: this.now(),
      });
      return { resultRef: messageId };
    });
  }

  async notify(
    ctx: ScheduleRunContext,
    outcome: RunOutcome,
    saved: { resultRef: string | null },
  ): Promise<void> {
    const { store, conversations } = this.deps;
    const publisher = this.deps.notifications();
    if (!publisher) return;
    const row = store.byId(ctx.scheduleId);
    const result = store.result(ctx.runId);
    const conversationId = result?.conversation_id ?? null;
    const message =
      conversationId && saved.resultRef ? conversations.message(conversationId, saved.resultRef) : undefined;
    // Straight to the result message (FR-8.4); the schedule's page when the conversation is gone.
    const url = conversationId
      ? `/c/${conversationId}${message ? `#m-${message.id}` : ""}`
      : `/schedules/${ctx.scheduleId}`;
    const ref = conversationId
      ? { kind: "conversation", id: conversationId }
      : { kind: "schedule", id: ctx.scheduleId };
    const scheduleName = scrubKnown(row?.name ?? ctx.schedule.name);
    const chat = outcome.outputRef ? this.deps.runs.get(outcome.outputRef) : undefined;
    const input: PublishInput =
      outcome.status === "succeeded"
        ? { kind: "schedule_succeeded", scheduleName, summary: scrubKnown(replyText(message)), url, ref }
        : {
            kind: "schedule_failed",
            scheduleName,
            reason: failureReason(chat, outcome.code),
            url,
            ref,
          };
    publisher.publish(ctx.ownerId, input, { dedupeKey: runNotificationKey(ctx.runId) });
  }
}

/**
 * What a schedule's run asks for — the same for the run and for the connection warning, so both resolve the same
 * connection. `useShared` is always explicit: a schedule set back to personal never inherits the conversation's
 * earlier "공용으로 쓰기" (review #116).
 */
export function scheduleRequest(row: ScheduleRow): Omit<RunChoice, "runtime"> {
  return { model: row.model, ...(row.effort ? { effort: row.effort } : {}), useShared: !!row.use_shared };
}

/** Whether `row`'s next run would find a usable runtime and connection for its owner (FR-11.8). */
export function scheduleUsable(
  row: ScheduleRow,
  deps: { registry: RuntimeRegistry; access: RunAccess },
): boolean {
  const adapter = deps.registry.get(row.runtime);
  if (!adapter) return false;
  const caps = adapter.capabilities();
  try {
    const s = deps.access.resolve({
      userId: row.owner_id,
      runtime: adapter.id,
      capabilities: caps,
      requested: scheduleRequest(row),
      current: { model: null, effort: null },
    });
    return !caps.needsConnection || s.connectionId !== null;
  } catch (e) {
    if (e instanceof RunAccessDenied) return false;
    throw e;
  }
}

export type ScheduleWarningsOptions = {
  store: ScheduleStore;
  usable: (row: ScheduleRow) => boolean;
  notifications: () => Publisher | undefined;
  now?: () => number;
  leadMs?: number;
  intervalMs?: number;
  /** Whether this process still holds the data folder (#37): otherwise nothing is checked or published. */
  owned?: () => boolean;
  log?: EventLogger;
};

/**
 * "연결이 끊긴 예약은 다음 실행 전에 알린다" (#56, FR-11.8): every minute, the active schedules whose next run is within
 * the hour are checked as their run would be (`scheduleUsable`); one that would find no usable connection gets one
 * notification — once per occurrence (`dedupe_key = schedule-warning:<id>@<ms>`), across restarts.
 */
export class ScheduleWarnings {
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => number;

  constructor(private readonly opts: ScheduleWarningsOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** One look-ahead; returns how many schedules are warned about (now, or already for this occurrence). */
  check(at = this.now()): number {
    if (this.opts.owned && !this.opts.owned()) return 0;
    const publisher = this.opts.notifications();
    if (!publisher) return 0;
    let n = 0;
    for (const row of this.opts.store.upcomingBetween(at, at + (this.opts.leadMs ?? WARNING_LEAD_MS))) {
      try {
        if (this.opts.usable(row)) continue;
        const key = warningKey(row.id, row.next_run_at!);
        const id = publisher.publish(
          row.owner_id,
          {
            kind: "schedule_warning",
            scheduleName: scrubKnown(row.name),
            runtimeLabel: RUNTIME_LABEL[row.runtime] ?? row.runtime,
            at: row.next_run_at!,
            timeZone: row.time_zone,
            url: `/schedules/${row.id}`,
            ref: { kind: "schedule", id: row.id },
          },
          { dedupeKey: key },
        );
        if (id) n++;
      } catch (e) {
        logEvent(this.opts.log, "warn", "schedule.step_failed", {
          scheduleId: row.id,
          scheduleStep: "warn",
          err: e,
        });
      }
    }
    return n;
  }

  start(): void {
    if (this.timer) return;
    const tick = () => void Promise.resolve().then(() => this.check());
    tick();
    this.timer = setInterval(tick, this.opts.intervalMs ?? 60_000);
    this.timer.unref();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
