import crypto from "node:crypto";
import { sentWithActive } from "../files/store.js";
import { EventEmitter } from "node:events";
import { and, asc, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import {
  redactSecrets,
  type CitationNotePart,
  type FinanceNotePart,
  StreamEvent,
  TableData,
  type MessagePart,
  type Run,
  type RunChoice,
  type RuntimeId,
} from "@agentlee/shared";
import type { RunSettings, RunSettingsInput } from "../connections/access.js";
import { RUNTIME_LABEL } from "../connections/store.js";
import { settingsOf, type ConversationStore, type MessageRow } from "../conversations/store.js";
import type { StartSettings } from "../users/defaults.js";
import type { Db } from "../db/client.js";
import { runEvents, runs, users } from "../db/schema.js";
import type { AppEvents } from "../events.js";
import { McpTokens } from "../isolation/tokens.js";
import {
  RuntimeFailure,
  SessionGoneError,
  type ContextReferences,
  type RuntimeAdapter,
  type RuntimeRegistry,
  type RuntimeSession,
  type RuntimeTurn,
  type StartContext,
  type UsageReport,
  usageReport,
} from "./adapter.js";
import type { UsageAttempt, UsagePurpose } from "../usage/store.js";
import { logEvent, type EventLogger } from "../logging.js";
import {
  scrubEventSequence,
  scrubKnown,
  scrubKnownDeep,
  scrubParts,
  StreamScrubber,
} from "../secrets/known.js";
import { classifyError, runFailureCategory, type ErrorLog } from "../observability/errors.js";
import { registerToolNames, toolLabel } from "../observability/policy.js";
import { OUR_TOOL_PREFIX } from "./lockdown.js";
import { assembleInstructions, defaultTemplates, type Templates } from "../instructions/assemble.js";
import { financeNote, storedEvidence, type AnswerEvidence } from "../finance/checker.js";
import { FinanceResultStore } from "../finance/results.js";
import { citationNote } from "../citations/checker.js";
import { CitationStore } from "../citations/store.js";
import { ArtifactStore } from "../artifacts/store.js";
import { FINANCE_CHART_TOOL } from "@agentlee/mcp-tools/finance";
import { SummaryStore } from "../conversations/summaries.js";
import {
  citedSources,
  contextHistory,
  contextWindowOf,
  DEFAULT_CONTEXT_OPTIONS,
  messagesToFold,
  messageText,
  needsSummary,
  overflows,
  REFERENCE_LIMIT,
  SUMMARY_DIVIDER,
  SUMMARY_INSTRUCTIONS,
  SUMMARY_REQUEST,
  trimToFit,
  type ContextOptions,
  type SummaryRef,
} from "./context.js";

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
  /** The turn being run — the reply's, or the summary's before it (#45): an interrupt stops either. */
  turn?: RuntimeTurn | undefined;
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
  /** What the provider said about a usage limit this run hit (#19). */
  limitInfo?: { resetsAt?: number; retryAfterMs?: number; modelFamily?: string };
  /** Finance results of the recent conversation (#30): a follow-up that states figures is checked too. */
  financeCarry?: AnswerEvidence | undefined;
  /**
   * Known-secret scrubbers of the text and reasoning streams (review round 23): what may still turn into a secret
   * with the next chunk is held back here, and goes out (scrubbed) at the next tool event or when the run ends.
   */
  scrub: { text: StreamScrubber; reasoning: StreamScrubber };
  /**
   * What `begin` decided about the summary (#45): a new one is due (its divider was written, `dividerId`). Absent
   * when the run was begun without a divider point (then `execute` decides on its own, without a divider).
   */
  summaryPlan?: { summarize: boolean; dividerId?: string | undefined };
};

/** The context a run's fresh session would get (#45): the summary, the messages after it, and the full history. */
type RunContext = {
  /** Active messages before the turn's input, in order — what the session's checkpoint refers to. */
  history: MessageRow[];
  summary: (SummaryRef & { id: string }) | null;
  /** What the fresh session gets as messages: those after the summary (or the newest that fit, see trimToFit). */
  messages: MessageRow[];
  /**
   * `messages` were cut to fit (#45, review #106): only a fresh session may get this context, and that session is
   * never resumed (it does not hold the history a full context would).
   */
  trimmed: boolean;
  /** The turn's own user message (its attachments are the conversation's too). */
  inputMessageId: string | null;
};

/** What `runs.idempotency_key` holds: the client's key hashed (it is only ever compared). */
export const idempotencyHash = (key: string) =>
  "sha256:" + crypto.createHash("sha256").update(key, "utf8").digest("hex");

/**
 * What a runtime is handed, scrubbed again right before it is handed over (round 24): the history and prompt were
 * built before awaits (the MCP endpoint, a resume attempt) during which a secret may have been registered.
 */
function rescrub(ctx: StartContext): StartContext {
  ctx.history = ctx.history.map((m) => ({ ...m, parts: scrubParts(m.parts) }));
  ctx.systemPrompt = scrubKnown(ctx.systemPrompt);
  if (ctx.summary) ctx.summary = { ...ctx.summary, text: scrubKnown(ctx.summary.text) };
  if (ctx.references) ctx.references = scrubKnownDeep(ctx.references);
  return ctx;
}

/** Appends text to the reply; returns the index among the *public* parts (what the message API shows). */
function appendText(parts: MessagePart[], type: "text" | "reasoning", text: string): number {
  const last = parts.at(-1);
  if (last && last.type === type) last.text += text;
  else parts.push({ type, text });
  return parts.filter((p) => p.type !== "reasoning").length - 1;
}

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
  context_too_large: "메시지가 너무 길어서 이 모델에 보낼 수 없어요. 나눠서 보내 주세요.",
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
    runFailed(
      run: RunRow,
      code: string,
      info?: { resetsAt?: number; retryAfterMs?: number; modelFamily?: string },
    ): StreamEvent[];
    runSucceeded?(run: RunRow): void;
  };
  /**
   * Start settings of a conversation that has none yet (#19, FR-12.6): the user's defaults with the fallback order.
   * Without it such a conversation answers as before #19 (the reply's or last runtime, the first allowed model).
   */
  startSettings?: (userId: string) => StartSettings | null;
  /** The context builder's limits (#45): summary ratio, recent messages kept, reserve. Default DEFAULT_CONTEXT_OPTIONS. */
  context?: Partial<ContextOptions>;
  /**
   * Files the run made with `doc_create` (#49): those linked to its reply message (files/store.ts `generatedOf`).
   * Each gets a download chip (`file_ref`) under the reply when the run ends.
   */
  generatedFiles?: (conversationId: string, messageId: string) => { id: string; name: string }[];
  /** The conversation's uploaded files for a fresh session's context (#45), from the file store (#22). */
  contextFiles?: (
    conversationId: string,
  ) => (ContextReferences["files"][number] & { messageId: string | null })[];
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
  /** Finance results per conversation (#30): follow-ups anywhere later are checked against them. */
  private readonly financeResults: FinanceResultStore;
  /** Citations the `cite` tool registered (#25): the citation note at the end of a run is built from them. */
  private readonly citations: CitationStore;
  /** Artifacts (#28): a reply gets a card (`artifact_ref`) for each artifact its run made or changed. */
  private readonly artifacts: ArtifactStore;
  /** Conversation summaries (#45). */
  readonly summaries: SummaryStore;
  private readonly contextOpts: ContextOptions;

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
    this.financeResults = new FinanceResultStore(db);
    // Rows from before keys were hashed (round 27): hashed once, in place.
    for (const r of db.$client
      .prepare(
        "select id, idempotency_key as k from runs where idempotency_key is not null and idempotency_key not like 'sha256:%'",
      )
      .all() as { id: string; k: string }[])
      db.$client.prepare("update runs set idempotency_key = ? where id = ?").run(idempotencyHash(r.k), r.id);
    this.citations = new CitationStore(db);
    this.artifacts = new ArtifactStore(db);
    this.summaries = new SummaryStore(db, this.now);
    this.contextOpts = { ...DEFAULT_CONTEXT_OPTIONS, ...opts.context };
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

  /** The run started with this idempotency key (stored as its SHA-256 only, round 27: the key is client text). */
  byIdempotencyKey(userId: string, key: string): RunRow | undefined {
    return this.db
      .select()
      .from(runs)
      .where(and(eq(runs.userId, userId), eq(runs.idempotencyKey, idempotencyHash(key))))
      .get();
  }

  /** Marks runs left over from a previous process as failed. Call once at startup, before serving. */
  recover(): number {
    const stale = this.db
      .select()
      .from(runs)
      .where(inArray(runs.status, ["queued", "running"]))
      .all();
    for (const r of stale) {
      // The partial answer kept from before the restart gets the common finance check (#30) and the citation
      // check (#25) too.
      const msg = this.conversations.messageById(r.assistantMessageId);
      if (msg) {
        // Scrubbed again: a secret registered since it was stored (updateMessage scrubs too).
        const parts = scrubParts(msg.parts as MessagePart[]);
        this.attachNoteTo(r, parts, this.financeResults.context(r.conversationId, msg.seq));
        this.conversations.updateMessage(msg.id, { parts });
      }
      this.finish(r, "failed", "server_restart");
    }
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
    /** The reply being regenerated (#19): its runtime and model, used only when the conversation has no settings. */
    previous?: { runtime: RuntimeId | null; model: string | null; effort: string | null } | undefined;
    /**
     * Creates the messages; calls `divider` where a switch divider belongs (#19) — before the new user message, or
     * before the regenerated reply. The settings are resolved first, so the divider names who really answers.
     */
    prepare: (divider: () => void) => { user: MessageRow | null; assistant: MessageRow };
    /**
     * The text of the user message about to be written (send, edit), counted in the summary decision at the divider
     * point (#45). A regenerate needs none: its user message is already in the history.
     */
    inputText?: string | undefined;
  }): { run: RunRow; user: MessageRow | null; assistant: MessageRow; reused: boolean } {
    if (this.stopping) throw new ShuttingDownError();
    const decided: { plan?: NonNullable<Live["summaryPlan"]> } = {};
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
        let conv = this.conversations.get(input.conversationId)!;
        // The conversation's settings (#19) decide the next reply. One that had none (nothing was usable when it was
        // created, or it is older than #19 and never answered) gets its start settings now, fallback included.
        if (!settingsOf(conv) && this.opts.startSettings) {
          const start = this.opts.startSettings(input.userId);
          if (start) {
            this.conversations.setSettings(conv.id, start.settings, {
              fallback: start.fallback,
              ...(start.limitedUntil !== undefined ? { limitedUntil: start.limitedUntil } : {}),
            });
            conv = this.conversations.get(conv.id)!;
          }
        }
        const base = settingsOf(conv);
        // An explicit choice of the request (#17) is for this reply only; otherwise the conversation's settings.
        // Without settings (the run manager alone in tests): the reply's own runtime, then the last one used.
        const choice = input.choice ?? {};
        const runtime =
          choice.runtime ??
          base?.runtime ??
          input.previous?.runtime ??
          (conv.lastRuntime as RuntimeId | null) ??
          DEFAULT_RUNTIME;
        // An explicitly chosen runtime is never swapped for another one.
        const adapter =
          this.registry.get(runtime) ??
          (choice.runtime || base ? undefined : this.registry.get(this.registry.ids()[0]!));
        const models = adapter?.capabilities().models ?? [];
        const current =
          base && base.runtime === adapter?.id
            ? { model: base.model, effort: base.effort }
            : { model: input.previous?.model ?? null, effort: input.previous?.effort ?? null };
        const requested: RunChoice =
          choice.useShared === undefined && base?.useShared && base.runtime === adapter?.id
            ? { ...choice, useShared: true }
            : choice;
        // #17: the user's policy decides (403 for explicit choices it does not allow); throwing rolls back prepare().
        const settings =
          adapter && this.opts.connections
            ? this.opts.connections.resolve({
                userId: input.userId,
                runtime: adapter.id,
                capabilities: adapter.capabilities(),
                requested,
                current,
              })
            : undefined;
        const model = settings?.model ?? models.find((m) => m.id === current.model) ?? models[0];
        const effort = settings
          ? settings.effort
          : ((model && current.model === model.id ? current.effort : null) ?? model?.defaultEffort ?? null);
        const { user, assistant } = input.prepare(() => {
          if (!adapter || !model) return;
          // "앞부분을 요약했어요" where a new summary is due (#45, FR-3.6): decided here, written by `execute`.
          const due = this.summaryDue(input.conversationId, adapter, model.id, input.inputText);
          const plan: NonNullable<Live["summaryPlan"]> = { summarize: due.summarize };
          decided.plan = plan;
          if (due.summarize)
            plan.dividerId = this.conversations.append(input.conversationId, {
              role: "system",
              parts: [{ type: "divider", kind: "summary", label: SUMMARY_DIVIDER }],
            }).id;
          // `── 여기부터 … ──` when this reply is answered by another runtime, model or effort than the last (#19);
          // a switch to another runtime that hands over an existing summary says so (FR-3.5).
          this.conversations.syncSwitchDivider(input.conversationId, {
            runtime: adapter.id,
            model: model.id,
            effort,
            label: [RUNTIME_LABEL[adapter.id] ?? adapter.id, model.label].join(" · "),
            summarized: due.inUse && !due.summarize,
          });
        });
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
          effort,
          connectionId: settings?.connectionId ?? null,
          connectionVersion: settings?.connectionVersion ?? null,
          useShared: settings?.useShared ?? false,
          idempotencyKey: input.idempotencyKey ? idempotencyHash(input.idempotencyKey) : null,
          summaryDividerId: decided.plan?.dividerId ?? null,
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
        scrub: { text: new StreamScrubber(), reasoning: new StreamScrubber() },
        ...(decided.plan ? { summaryPlan: decided.plan } : {}),
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

  /**
   * Events after `afterSeq`, in order — scrubbed again on the way out (round 24): a secret registered after an
   * event was stored never comes back in a replay or a resumed stream.
   */
  eventsAfter(id: string, afterSeq: number): { seq: number; data: StreamEvent }[] {
    // The whole run as one stream (round 25: deltas joined must not rebuild a secret), then the part asked for.
    const all = this.db
      .select()
      .from(runEvents)
      .where(eq(runEvents.runId, id))
      .orderBy(asc(runEvents.seq))
      .all()
      .map((e) => ({ seq: e.seq, data: e.data as StreamEvent }));
    return scrubEventSequence(all).filter((e) => e.seq > afterSeq);
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
    // Last net for every event stored and streamed (review round 23): no known secret, whatever produced it.
    // Text deltas were scrubbed with their holdback already; `tail: false` keeps them as they are.
    const data = StreamEvent.parse(scrubKnownDeep(event, { tail: false }));
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
    this.releaseHeld(row, live);
    this.attachNoteTo(row, live.parts, live.financeCarry);
    this.conversations.updateMessage(row.assistantMessageId, { parts: live.parts });
    this.finish(row, status, code);
    void closeSession(live);
  }

  /**
   * The server's notes at the end of an answer, however the run ended (also when it is recovered after a
   * restart): appended to `parts` and streamed before `done`. A broken check never breaks the reply.
   * - The common finance output check (#30): an answer that used a finance tool — or one stating figures while
   *   finance results are in the recent conversation — gets the finance note (sources, as-of times, what the
   *   answer left out, disclaimer).
   * - The citation check (#25): an answer that used web tools or cited sources gets the citation note (each
   *   `[n]` with its server-checked status, paragraphs without a citation).
   */
  private attachNoteTo(row: RunRow, parts: MessagePart[], context: AnswerEvidence | undefined): void {
    this.syncArtifactRefs(row, parts);
    this.syncFileRefs(row, parts);
    this.syncFinanceTables(row, parts);
    if (!parts.some((p) => p.type === "finance_note")) {
      // This answer's finance results stay for the rest of the conversation's checks.
      try {
        const ev = storedEvidence(parts);
        if (ev)
          this.financeResults.save(
            { messageId: row.assistantMessageId, conversationId: row.conversationId, runId: row.id },
            ev,
          );
      } catch {
        // a storage failure never breaks the reply; the note below is still attached
      }
      try {
        const note = financeNote(parts, context);
        if (note) this.pushNote(row, parts, note);
      } catch {
        // no note rather than no reply
      }
    }
    if (!parts.some((p) => p.type === "citation_note")) {
      try {
        const note = citationNote(row.id, parts, this.citations);
        if (note) this.pushNote(row, parts, note);
      } catch {
        // no note rather than no reply
      }
    }
  }

  /**
   * The reply's artifact cards (#28): one `artifact_ref` per artifact this run created or changed, naming the
   * newest version the run wrote. Taken from the stored versions (what our MCP tools wrote for this run's token),
   * never from the runtime's own report; a card already there is moved on to a newer version. Never breaks a reply.
   */
  private syncArtifactRefs(row: RunRow, parts: MessagePart[]): void {
    let refs: { artifactId: string; version: number }[];
    try {
      refs = this.artifacts.refsOfRun(row.conversationId, row.id);
    } catch {
      return;
    }
    for (const ref of refs) {
      const part: MessagePart = { type: "artifact_ref", artifactId: ref.artifactId, version: ref.version };
      const at = parts.findIndex((p) => p.type === "artifact_ref" && p.artifactId === ref.artifactId);
      if (at === -1) {
        parts.push(part);
      } else if ((parts[at] as { version?: number }).version !== ref.version) {
        parts[at] = part;
      } else continue;
      const i = at === -1 ? parts.length - 1 : at;
      const partIndex = parts.slice(0, i + 1).filter((p) => p.type !== "reasoning").length - 1;
      this.emit(row.id, { type: "part_update", messageId: row.assistantMessageId, partIndex, part });
    }
  }

  /**
   * The reply's file chips (#49): one `file_ref` per file this run made with `doc_create` — taken from the file
   * store (rows our tool wrote for this run's reply), never from the runtime's own report. Never breaks a reply.
   */
  private syncFileRefs(row: RunRow, parts: MessagePart[]): void {
    let made: { id: string; name: string }[];
    try {
      made = this.opts.generatedFiles?.(row.conversationId, row.assistantMessageId) ?? [];
    } catch {
      return;
    }
    for (const f of made) {
      if (parts.some((p) => p.type === "file_ref" && p.fileId === f.id)) continue;
      const part: MessagePart = { type: "file_ref", fileId: f.id, name: f.name };
      parts.push(part);
      const partIndex = parts.filter((p) => p.type !== "reasoning").length - 1;
      this.emit(row.id, { type: "part_update", messageId: row.assistantMessageId, partIndex, part });
    }
  }

  /**
   * The finance table of the reply (#31): for each `finance_chart` result, its `table` artifact as a `table` part
   * (sortable, a source and an as-of column on every row) — read from the version **this run stored** (never from
   * the runtime's report: the result only names which artifact), so the part and the artifact are the same data.
   * One part per artifact, naming the version it shows (`artifactVersion`): when this run stores a newer version
   * (an `artifact_update` later in the same run), the part is replaced in place and streamed again, like the card
   * (review #111). Another run's versions never touch this answer (`refsOfRun` is this run's). Never breaks a reply.
   */
  private syncFinanceTables(row: RunRow, parts: MessagePart[]): void {
    try {
      const calls = new Set(
        parts.flatMap((p) =>
          p.type === "tool_call" && p.name.replace(OUR_TOOL_PREFIX, "") === FINANCE_CHART_TOOL.name
            ? [p.id]
            : [],
        ),
      );
      if (!calls.size) return;
      const refs = this.artifacts.refsOfRun(row.conversationId, row.id);
      const ids = new Set<string>();
      for (const p of parts) {
        if (p.type !== "tool_result" || p.isError || !calls.has(p.callId)) continue;
        const out = (typeof p.output === "string" ? safeJson(p.output) : p.output) as {
          table?: { artifactId?: unknown };
        } | null;
        const id = out?.table?.artifactId;
        if (typeof id === "string") ids.add(id);
      }
      for (const id of ids) {
        const ref = refs.find((r) => r.artifactId === id);
        const a = ref && this.artifacts.get(id);
        if (!ref || !a || a.kind !== "table") continue;
        const at = parts.findIndex((q) => q.type === "table" && q.artifactId === id);
        if (at !== -1 && (parts[at] as { artifactVersion?: number }).artifactVersion === ref.version)
          continue;
        const v = this.artifacts.version(id, ref.version);
        const data = v && TableData.safeParse(JSON.parse(v.content));
        if (!data?.success) continue;
        const part: MessagePart = {
          type: "table",
          artifactId: id,
          artifactVersion: ref.version,
          columns: data.data.columns.map((label, i) => ({ key: `c${i}`, label })),
          rows: data.data.rows.map((r) => Object.fromEntries(r.map((cell, i) => [`c${i}`, cell]))),
        };
        if (at === -1) parts.push(part);
        else parts[at] = part;
        const i = at === -1 ? parts.length - 1 : at;
        const partIndex = parts.slice(0, i + 1).filter((q) => q.type !== "reasoning").length - 1;
        this.emit(row.id, { type: "part_update", messageId: row.assistantMessageId, partIndex, part });
      }
    } catch {
      // no table part rather than no reply (the artifact card is there)
    }
  }

  private pushNote(row: RunRow, parts: MessagePart[], note: FinanceNotePart | CitationNotePart): void {
    parts.push(note);
    const partIndex = parts.filter((p) => p.type !== "reasoning").length - 1;
    this.emit(row.id, { type: "part_update", messageId: row.assistantMessageId, partIndex, part: note });
  }

  /**
   * The text the known-secret scrubbers still hold (it might have become a secret with the next chunk): scrubbed
   * as finished text, appended and streamed — only when the run ends (round 24: never at a tool event).
   */
  private releaseHeld(row: RunRow, live: Live): void {
    const reasoning = live.scrub.reasoning.end();
    if (reasoning) appendText(live.parts, "reasoning", reasoning);
    const text = live.scrub.text.end();
    if (!text) return;
    const partIndex = appendText(live.parts, "text", text);
    this.emit(row.id, { type: "delta", messageId: row.assistantMessageId, partIndex, text });
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
    // However the run ended (failed at once, stopped before or during its summary, recovered after a restart): a
    // summary divider whose summary was never stored leaves the history (#45).
    if (r.summaryDividerId && !this.summaries.ofRun(r.conversationId, r.id))
      this.conversations.deactivate(r.conversationId, r.summaryDividerId);
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
  private recordUsage(
    run: RunRow,
    live: Live,
    attempt: number,
    report: UsageReport,
    /** A summary attempt (#45): its own purpose and model. */
    as?: { purpose: UsagePurpose; model: string },
  ): void {
    try {
      this.opts.usage?.record(
        {
          userId: run.userId,
          conversationId: run.conversationId,
          runId: run.id,
          attempt,
          runtime: run.runtime,
          model: as?.model ?? run.model,
          connectionId: run.connectionId,
          purpose: as?.purpose ?? live.purpose,
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
        purpose: as?.purpose ?? live.purpose,
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

  /** The model's context window (#45). */
  private windowOf(adapter: RuntimeAdapter, model: string): number {
    return contextWindowOf(adapter.capabilities().models.find((m) => m.id === model));
  }

  /**
   * Whether the next reply's fresh context needs a new summary, and whether it uses one at all (#45). `begin` asks
   * at the divider point: the history then is every active message before the turn's input (a regenerate keeps its
   * user message active, so a trailing user message is the input and left out).
   */
  private summaryDue(
    conversationId: string,
    adapter: RuntimeAdapter,
    model: string,
    inputText: string | undefined,
  ): { summarize: boolean; inUse: boolean } {
    const active = this.conversations.messages(conversationId, { limit: 10_000 });
    const trailingUser = active.at(-1)?.role === "user" ? active.at(-1) : undefined;
    const history = trailingUser ? active.slice(0, -1) : active;
    const input = inputText ?? (trailingUser ? messageText(trailingUser.parts as MessagePart[]) : "");
    const current = this.summaries.current(conversationId, history);
    const summarize =
      needsSummary(history, current, this.windowOf(adapter, model), this.contextOpts, input) &&
      messagesToFold(history, current, this.contextOpts).length > 0;
    return { summarize, inUse: summarize || current !== null };
  }

  /**
   * The context of the run's fresh session (#45, FR-3.6): the current summary and the messages after it. When a new
   * summary is due (decided by `begin`, or here for a run begun without a divider point) it is written first, with
   * the summary model on the run's connection. A summary that cannot be written never breaks the reply: its divider
   * goes, and the session gets the newest messages that fit.
   */
  private async contextFor(
    run: RunRow,
    live: Live,
    history: MessageRow[],
    input: { text: string; messageId: string | null },
  ): Promise<RunContext> {
    const adapter = this.registry.get(run.runtime as RuntimeId)!;
    const window = this.windowOf(adapter, run.model);
    const opts = this.contextOpts;
    // The user's message is never cut: when it alone (with the reserve) does not fit the window, the run fails before
    // anything is sent or summarised (review #106 round 2).
    if (overflows([], null, window, opts, input.text)) throw new RuntimeFailure("context_too_large");
    const current = this.summaries.current(run.conversationId, history);
    // Decided again with the turn's real message (review #106): `begin` may not have known it, or not at all.
    const summarize =
      live.summaryPlan?.summarize === true || needsSummary(history, current, window, opts, input.text);
    const fold = summarize ? messagesToFold(history, current, opts) : [];
    let written: RunContext["summary"] = null;
    let failed = false;
    let ended: unknown;
    if (fold.length) {
      try {
        written = await this.writeSummary(run, live, adapter, current, fold, history);
      } catch (e) {
        if (e instanceof RunEndedError || live.settled || live.interruptRequested) ended = e;
        else {
          failed = true;
          logEvent(this.opts.log, "warn", "context.summary_failed", {
            userId: run.userId,
            conversationId: run.conversationId,
            runId: run.id,
            runtime: run.runtime,
            errorCode: "summary_failed",
            err: e,
          });
        }
      }
    }
    // No new summary: its divider (if `begin` wrote one) is taken back before anything refers to it.
    const dividerId = live.summaryPlan?.dividerId;
    if (!written && dividerId) {
      this.conversations.deactivate(run.conversationId, dividerId);
      history = history.filter((m) => m.id !== dividerId);
    }
    if (ended !== undefined) throw ended;
    let summary = written ?? current;
    let messages = history.filter((m) => !summary || m.seq > summary.throughSeq);
    // A summary that could not be written, or a context that would not fit the window with the turn's message even
    // so: the newest messages that fit go to a *fresh* session — one that holds more would get the whole history
    // again by being resumed — and that session is marked trimmed, so it is never resumed either (review #106 round
    // 2: once the decision changes, e.g. a higher ratio after a restart, it would pass for the full history).
    let trimmed = false;
    if (failed || overflows(messages, summary, window, opts, input.text)) {
      messages = trimToFit(history, summary, window, opts, input.text);
      trimmed = true;
      // The summary itself and the message do not fit together: the newest messages that fit without it.
      if (summary && overflows(messages, summary, window, opts, input.text)) {
        summary = null;
        messages = trimToFit(history, null, window, opts, input.text);
      }
    }
    return { history, summary, messages, trimmed, inputMessageId: input.messageId };
  }

  /**
   * The summary model (#45): the runtime's cheap model when this user may use it on the run's own connection
   * (RunAccess decides, as for a run), otherwise the run's model.
   */
  private summaryModel(run: RunRow, adapter: RuntimeAdapter): { model: string; effort: string | null } {
    const caps = adapter.capabilities();
    const cheap = caps.models.find((m) => m.cheap);
    if (cheap && cheap.id !== run.model) {
      if (!this.opts.connections) return { model: cheap.id, effort: cheap.defaultEffort ?? null };
      try {
        const s = this.opts.connections.resolve({
          userId: run.userId,
          runtime: adapter.id,
          capabilities: caps,
          requested: { model: cheap.id, ...(run.connectionId ? { connectionId: run.connectionId } : {}) },
          current: { model: null, effort: null },
        });
        if ((s.connectionId ?? null) === (run.connectionId ?? null))
          return { model: s.model.id, effort: s.effort };
      } catch {
        // not allowed for this user (or not on this connection): the run's own model
      }
    }
    return { model: run.model, effort: run.effort };
  }

  /**
   * Writes the summary of `fold` on top of `previous` (#45): a session of its own on the run's connection, no tools,
   * the summary instructions. Its usage is a separate attempt of the run with purpose `summary` (#44). The text is
   * scrubbed when stored (SummaryStore).
   */
  private async writeSummary(
    run: RunRow,
    live: Live,
    adapter: RuntimeAdapter,
    previous: SummaryRef | null,
    fold: MessageRow[],
    history: MessageRow[],
  ): Promise<SummaryRef & { id: string }> {
    const { model, effort } = this.summaryModel(run, adapter);
    const attempt = nextAttempt(live);
    const startedAt = this.now();
    const ctx = rescrub({
      conversationId: run.conversationId,
      userId: run.userId,
      connectionId: run.connectionId ?? undefined,
      connectionVersion: run.connectionVersion ?? undefined,
      signal: live.abort.signal,
      history: contextHistory(fold),
      ...(previous
        ? { summary: { text: previous.summary, throughMessageId: previous.throughMessageId } }
        : {}),
      systemPrompt: SUMMARY_INSTRUCTIONS,
      model,
      effort: effort ?? undefined,
      tools: [],
    });
    if (live.settled || live.interruptRequested || this.stopping) throw new RunEndedError();
    const session = await adapter.start(ctx);
    let text = "";
    try {
      if (live.settled || live.interruptRequested) throw new RunEndedError();
      const turn = session.turn({ text: SUMMARY_REQUEST, model, effort: effort ?? undefined });
      live.turn = turn;
      for await (const ev of turn.events) {
        if (live.settled) break;
        if (ev.type === "text_delta") text += ev.text;
        else if (ev.type === "usage") {
          const report = usageReport(ev);
          live.usage.set(attempt, report);
          this.recordUsage(run, live, attempt, report, { purpose: "summary", model });
        } else if (ev.type === "limit") throw new Error("summary_limit");
      }
    } finally {
      live.turn = undefined;
      await session.close().catch(() => {});
    }
    if (live.settled || live.interruptRequested) throw new RunEndedError();
    if (!text.trim()) throw new Error("empty_summary");
    const u = live.usage.get(attempt);
    logEvent(this.opts.log, "info", "context.summarized", {
      userId: run.userId,
      conversationId: run.conversationId,
      runId: run.id,
      runtime: run.runtime,
      attempt,
      purpose: "summary",
      durationMs: this.now() - startedAt,
      count: fold.length,
      ...(u?.inputTokens !== undefined ? { inputTokens: u.inputTokens } : {}),
      ...(u?.outputTokens !== undefined ? { outputTokens: u.outputTokens } : {}),
    });
    return this.summaries.save({
      conversationId: run.conversationId,
      through: fold.at(-1)!,
      history,
      summary: text,
      runtime: run.runtime,
      model,
      runId: run.id,
    });
  }

  /**
   * The conversation's files, artifacts and cited sources for a fresh session (#45). Files only of the messages that
   * are the history now, or of the turn's own message — an edit or regenerate takes those of the cut part away
   * (review #106). Never breaks the run.
   */
  private referencesOf(conversationId: string, context: RunContext): ContextReferences {
    let artifacts: ContextReferences["artifacts"] = [];
    try {
      artifacts = this.artifacts
        .list(conversationId)
        .slice(0, REFERENCE_LIMIT)
        .map((a) => ({ id: a.id, title: a.title, kind: a.kind, version: a.latestVersion }));
    } catch {
      // none rather than no reply
    }
    let files: ContextReferences["files"] = [];
    try {
      const active = new Set(context.history.map((m) => m.id));
      if (context.inputMessageId) active.add(context.inputMessageId);
      files = (this.opts.contextFiles?.(conversationId) ?? [])
        .filter((f) => sentWithActive(f, (id) => active.has(id)))
        .slice(-REFERENCE_LIMIT)
        .map((f) => ({ id: f.id, name: f.name }));
    } catch {
      // none rather than no reply
    }
    return { files, artifacts, sources: citedSources(context.history) };
  }

  private async openSession(
    run: RunRow,
    context: RunContext,
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
    const summary = context.summary;
    const ctx: StartContext = {
      conversationId: run.conversationId,
      userId: run.userId,
      connectionId: run.connectionId ?? undefined,
      connectionVersion: run.connectionVersion ?? undefined,
      signal: live.abort.signal,
      // The server's history (#45: after the summary when there is one), public parts only — scrubbed again on the
      // way to the runtime: a secret registered after a message was stored (round 23).
      history: contextHistory(context.messages),
      ...(summary ? { summary: { text: summary.summary, throughMessageId: summary.throughMessageId } } : {}),
      references: this.referencesOf(run.conversationId, context),
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
    // Resume only a session that reflects exactly this history (#45): the same runtime, the same connection (a
    // session lives in its connection's folder, #17), the conversation revision and last message it has seen, the
    // instructions it started with (runtimes keep their start prompt: a new date, mode or template version needs a
    // fresh session), and the summary its context started from (a new summary means the context reached its limit).
    // A model-only change resumes it only on a runtime that can switch models inside a session (`setModel`).
    // The checkpoint is the last message a runtime gets anything from: the server's own dividers (a switch, a
    // summary) written since are not part of what it knows, so they do not make a session stale.
    const lastSeen = context.history.findLast((m) => m.role !== "system")?.id ?? null;
    const prev = !caps.canResume
      ? undefined
      : this.conversations
          .sessions(run.conversationId)
          .find(
            (s) =>
              s.runtime === run.runtime &&
              (s.connectionId ?? null) === (run.connectionId ?? null) &&
              s.conversationRevision === conv.revision &&
              s.lastMessageId === lastSeen &&
              s.instructionsHash === instructions.hash &&
              (s.summaryId ?? null) === (summary?.id ?? null) &&
              !s.trimmed &&
              (s.model === null || s.model === run.model || caps.canSwitchModelInSession),
          );
    // A cut context goes to a fresh session only; the session that holds the whole history is not used again.
    if (prev && context.trimmed) this.conversations.invalidateSession(prev.id);
    else if (prev) {
      let resumed: RuntimeSession | undefined;
      try {
        resumed = await adapter.resume(prev.externalSessionId, rescrub(ctx));
        if (prev.model !== null && prev.model !== run.model) {
          await resumed.setModel(run.model);
          this.conversations.setSessionModel(prev.id, run.model);
        }
        return { session: resumed, sessionRowId: prev.id, revision: conv.revision };
      } catch (e) {
        if (resumed) await resumed.close().catch(() => {});
        // Gone, or the model could not be switched in it: a fresh session (any other failure fails the run).
        if (!(e instanceof SessionGoneError) && !resumed) throw e;
        this.conversations.invalidateSession(prev.id);
      }
    }
    // The run may have ended while resume() was pending (interrupt, delete, shutdown): open nothing new then.
    if (live.settled || live.interruptRequested || this.stopping) throw new RunEndedError();
    const session = await adapter.start(rescrub(ctx));
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
        model: run.model,
        summaryId: summary?.id ?? null,
        trimmed: context.trimmed,
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
    const self = all.find((m) => m.id === messageId);
    live.financeCarry = this.financeResults.context(run.conversationId, self?.seq ?? Number.MAX_SAFE_INTEGER);
    const inputText = (lastUser?.parts as MessagePart[] | undefined)
      ?.flatMap((p) => (p.type === "text" ? [scrubKnown(p.text)] : []))
      .join("\n");

    const parts = live.parts;
    let lastFlush = this.now();
    const flush = (force = false) => {
      if (live.settled || (!force && this.now() - lastFlush < this.flushMs)) return;
      lastFlush = this.now();
      this.conversations.updateMessage(messageId, { parts });
    };

    let outcome: { status: "done" | "interrupted" | "failed"; code: string | null } = {
      status: "done",
      code: null,
    };
    try {
      // The context of a fresh session (#45): a summary may be written first (an attempt of its own).
      const context = await this.contextFor(
        run,
        live,
        before.filter((m) => m !== lastUser),
        { text: inputText ?? "", messageId: lastUser?.id ?? null },
      );
      if (live.settled) return;
      // One attempt = this session open + the turn below (#44).
      const attempt = nextAttempt(live);
      const { session, sessionRowId, revision } = await this.openSession(run, context, live);
      live.session = session;
      // Interrupted or deleted while the session was opening.
      if (live.settled) return void closeSession(live);
      if (live.interruptRequested) return this.settle(runId, "interrupted", null);
      // Scrubbed again right before it goes: a secret registered while the session was opening (round 24).
      const turn = session.turn({
        text: scrubKnown(inputText ?? ""),
        model: run.model,
        effort: run.effort ?? undefined,
      });
      live.turn = turn;
      for await (const ev of turn.events) {
        if (live.settled) break; // force-stopped or deleted: whatever arrives now is ignored
        // Known secrets (round 23): text streams through a holdback scrubber, so a secret split across chunks
        // never goes out in pieces. What it holds stays held across tool events, usage and notices (round 24: a
        // key split by a tool call is still one key) and goes out only when the run ends.
        if (ev.type === "text_delta") {
          const text = live.scrub.text.push(ev.text);
          if (text) {
            const partIndex = appendText(parts, "text", text);
            this.emit(runId, { type: "delta", messageId, partIndex, text });
          }
          flush();
        } else if (ev.type === "reasoning_delta") {
          const text = live.scrub.reasoning.push(ev.text);
          if (text) appendText(parts, "reasoning", text); // stored, never streamed
        } else if (ev.type === "tool_start") {
          // Missing input/output become null: JSON would drop an undefined key and the stored part would no
          // longer match the schema. Known secrets, then secret-looking values, never leave the runtime (FR-3.4).
          const input = redactSecrets(scrubKnownDeep(ev.input ?? null));
          live.tools.set(ev.callId, { name: ev.name, startedAt: this.now() });
          parts.push({ type: "tool_call", id: ev.callId, name: ev.name, input });
          this.emit(runId, { type: "tool_start", messageId, callId: ev.callId, name: ev.name, input });
          flush(true);
        } else if (ev.type === "tool_end") {
          const extra = ev.isError ? { isError: true } : {};
          const output = redactSecrets(scrubKnownDeep(ev.output ?? null));
          this.toolEnded(run, live, ev.callId, ev.isError === true);
          parts.push({ type: "tool_result", callId: ev.callId, output, ...extra });
          this.emit(runId, { type: "tool_end", messageId, callId: ev.callId, output, ...extra });
          // An artifact tool has written by now: its card shows while the reply goes on (#28).
          this.syncArtifactRefs(run, parts);
          this.syncFinanceTables(run, parts);
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
          live.limitInfo = {
            ...(ev.resetsAt !== undefined ? { resetsAt: ev.resetsAt } : {}),
            ...(ev.retryAfterMs !== undefined ? { retryAfterMs: ev.retryAfterMs } : {}),
            ...(ev.modelFamily !== undefined ? { modelFamily: ev.modelFamily } : {}),
          };
          this.emit(runId, { type: "notice", level: "warn", code: ev.code, message: ev.message });
          outcome = { status: "failed", code: "usage_limit" };
        }
      }
      if (live.settled) return;
      this.releaseHeld(run, live);
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
      for (const ev of this.opts.connections?.runFailed(
        run,
        outcome.code ?? "runtime_error",
        live.limitInfo ?? {},
      ) ?? [])
        this.emit(runId, ev);
    // A reply that finished on a connection ends its usage limit (#19).
    if (outcome.status === "done" && run.connectionId && !live.settled)
      this.opts.connections?.runSucceeded?.(run);
    this.settle(runId, outcome.status, outcome.code);
  }
}

function safeJson(t: string): unknown {
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return null;
  }
}
