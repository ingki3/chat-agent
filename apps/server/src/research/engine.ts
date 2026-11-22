import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import {
  locatorLabel,
  RESEARCH_LIMITS,
  ResearchBackendId,
  type FileLocator,
  type MessagePart,
  type ResearchErrorCode,
  type ResearchPlan,
  type ResearchScope,
  type ResearchStatus,
  sourceTypeOf,
} from "@agentlee/shared";
import type { ArtifactStore } from "../artifacts/store.js";
import type { UserStore } from "../auth/users.js";
import type { CitationStore } from "../citations/store.js";
import { RunAccessDenied, type RunSettings, type RunSettingsInput } from "../connections/access.js";
import {
  settingsOf,
  type ConversationRow,
  type ConversationStore,
  type MessageRow,
} from "../conversations/store.js";
import type { Db } from "../db/client.js";
import type { FileStore } from "../files/store.js";
import type { FileTools } from "../files/text.js";
import { assembleInstructions, seoulDate, type Templates } from "../instructions/assemble.js";
import type { McpTokens } from "../isolation/tokens.js";
import { logEvent, type EventLogger } from "../logging.js";
import type { DocSet } from "../memory/inject.js";
import type { PublishInput } from "../notifications/compose.js";
import type { RuntimeAdapter, RuntimeRegistry, UsageReport } from "../runtime/adapter.js";
import type { SessionRef } from "../runtime/runs.js";
import { closestPassage } from "../citations/passages.js";
import { scrubKnown } from "../secrets/known.js";
import type { UsageAttempt } from "../usage/store.js";
import type { SourceStore } from "../web/sources.js";
import { ResearchBackends } from "./backend.js";
import { realClock, type Clock } from "./clock.js";
import {
  defaultResearchPrompts,
  parseGaps,
  parseNotes,
  parsePlan,
  planTurn,
  reflectTurn,
  stepPrompt,
  subagentTurn,
  writerTurn,
  type AttachedFile,
  type RawNote,
  type ResearchPromptId,
  type ResearchPrompts,
} from "./prompts.js";
import { cleanReport, mdText, renderReport, type ReportCitation } from "./report.js";
import { runStep, type StepResult, type StepSpec } from "./step.js";
import {
  fileIdsOf,
  planOf,
  sourceCount,
  stateOf,
  type JobPatch,
  type JobState,
  type QuestionRecord,
  type ResearchJobRow,
  type ResearchNote,
  type ResearchStore,
} from "./store.js";

/**
 * 깊이 조사 (#211, PRD FR-17, docs/decisions/deep-research.md): the server orchestrates the job — not the model.
 * 1. `start`: the question (and its files) become a user message and a card message (`research` part); the lead
 *    writes the plan (or asks one clarifying question) in a tool-less step. Nothing is searched.
 * 2. `approve` (with the card's edits): the 30-minute deadline is set (planning time taken off) and the sub-researchers
 *    run, at most `concurrency` at once, each with its own tool-call and time limit, writing `NOTE` lines; the server
 *    keeps only notes whose passage it finds in the page or file (`verifyNote`). The lead may add gap questions, at
 *    most `maxDepth` rounds — only while enough time is left (else straight to writing: the forced wrap-up).
 * 3. The writer cites every sentence with `cite` / `file_cite`; the server removes what has no verified citation
 *    (report.ts), adds the source list and "한계", stores the report as a markdown artifact and the card's message
 *    gets the summary and the artifact. The owner is notified (research_done / research_failed).
 * Every step is a one-off session (step.ts). The job's row is its checkpoint, written after every step: a restart
 * resumes the job from there (`recover`), or ends it — past its deadline it is written up from what was verified.
 */

type Limits = { -readonly [K in keyof typeof RESEARCH_LIMITS]: (typeof RESEARCH_LIMITS)[K] };

export type ResearchNotify = {
  publish(userId: string, input: PublishInput, opts?: { dedupeKey?: string }): string | undefined;
  wants?(userId: string, kind: "research_done" | "research_failed"): boolean;
};

export type ResearchEngineDeps = {
  db: Db;
  store: ResearchStore;
  conversations: ConversationStore;
  registry: RuntimeRegistry;
  /** The runtime / model / connection check of a run (#17). Without it: the adapter's first model, no connection. */
  access?: { resolve(input: RunSettingsInput): RunSettings } | undefined;
  users: Pick<UserStore, "byId">;
  mcp?: { endpoint(): Promise<{ url: string }>; toolNamesFor(userId: string): string[] } | undefined;
  mcpTokens: McpTokens;
  citations: CitationStore;
  sources: SourceStore;
  artifacts: ArtifactStore;
  files?: FileStore | undefined;
  fileTools?: FileTools | undefined;
  memory?: { docSet(userId: string): DocSet } | undefined;
  /** A chat run is in progress in the conversation (a job is not started then). */
  activeRun?: ((conversationId: string) => boolean) | undefined;
  notifications: () => ResearchNotify | undefined;
  usage?: { record(a: UsageAttempt, u: UsageReport): void } | undefined;
  forgetSession?: ((ref: SessionRef) => void) | undefined;
  log?: EventLogger | undefined;
  clock?: Clock | undefined;
  prompts?: ResearchPrompts | undefined;
  templates?: Templates | undefined;
  /** Tests: other limits (a short cap, fewer sub-researchers). */
  limits?: Partial<Limits> | undefined;
  backends?: ResearchBackends | undefined;
};

export type ResearchErrorKind =
  | "research_claude_only"
  | "research_busy"
  | "research_state"
  | "run_in_progress"
  | "no_runtime"
  | "backend_unavailable"
  | "invalid_attachment"
  | "forbidden"
  | "shutting_down";

/** A request the engine refuses (nothing was changed). */
export class ResearchError extends Error {
  constructor(
    readonly code: ResearchErrorKind,
    readonly status: number,
  ) {
    super(code);
  }
}

/** Fixed texts per failure code (never a runtime's own words). */
export const RESEARCH_FAILURE_TEXT: Record<ResearchErrorCode | "stopped", string> = {
  no_connection: "Claude 연결이 없어요 — 설정 → 내 런타임 연결을 확인해 주세요",
  runtime_auth: "런타임 로그인이 만료됐거나 키가 맞지 않아요",
  usage_limit: "사용 한도에 도달했어요",
  runtime_error: "조사 중 오류가 났어요",
  plan_failed: "계획을 세우지 못했어요",
  no_findings: "확인된 근거를 하나도 찾지 못했어요",
  server_restart: "서버 재시작으로 중단됐어요",
  conversation_gone: "대화가 삭제됐어요",
  not_allowed: "이 계정은 지금 Claude를 쓸 수 없어요",
  runtime_changed: "대화가 Codex로 바뀌어 멈췄어요",
  stopped: "중지했어요",
};

type Live = {
  conversationId: string;
  /** The owner's stop, the conversation's deletion, shutdown: every step ends. */
  abort: AbortController;
  /** The hard cap: armed once the job runs after approval. */
  cap?: AbortController | undefined;
  cancelCap?: (() => void) | undefined;
};

type RunCtx = {
  adapter: RuntimeAdapter;
  model: string;
  effort: string | null;
  connectionId: string | null;
  connectionVersion: number | null;
};

const ACTIVE: ResearchStatus[] = ["planning", "researching", "writing"];
/** The writer needs at least this much: less, and the report is the verified passages themselves. */
const MIN_WRITE_MS = 30_000;
const REFLECT_MS = 90_000;
/** Unverified claims kept per sub-question (for its retry and the lead's reflection). */
const UNVERIFIED_KEPT = 5;
/**
 * Runtime failures a weak sub-question is retried after (#234): a passing error. The account's state — its login,
 * its usage, its connection, its permission, the conversation switched — would only fail again.
 */
const RETRYABLE: ReadonlySet<string> = new Set<ResearchErrorCode>(["runtime_error"]);

function anySignal(...signals: AbortSignal[]): AbortSignal {
  const c = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      c.abort();
      break;
    }
    s.addEventListener("abort", () => c.abort(), { once: true });
  }
  return c.signal;
}

/** Runs `fn` over `items`, at most `n` at once. */
async function pool<T>(items: readonly T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

export class ResearchEngine {
  private readonly live = new Map<string, Live>();
  private readonly events = new EventEmitter();
  private readonly clock: Clock;
  private readonly limits: Limits;
  private readonly prompts: ResearchPrompts;
  private readonly backends: ResearchBackends;
  private stopping = false;
  /** Progress streams to end at shutdown; sessions still closing after their step (bounded wait at shutdown). */
  private readonly streams = new Set<() => void>();
  private readonly cleanups = new Set<Promise<void>>();
  /** Every job execution in flight (tests and shutdown wait for them). */
  private readonly running = new Set<Promise<void>>();

  constructor(private readonly deps: ResearchEngineDeps) {
    this.clock = deps.clock ?? realClock;
    this.limits = { ...RESEARCH_LIMITS, ...deps.limits };
    this.prompts = deps.prompts ?? defaultResearchPrompts();
    this.backends = deps.backends ?? new ResearchBackends();
    this.events.setMaxListeners(0);
    // A deleted conversation's jobs stop at once (their rows go with it).
    deps.conversations.onDelete((conversationId) => {
      for (const l of this.live.values()) if (l.conversationId === conversationId) l.abort.abort();
    });
  }

  // ---- reading ----

  get store(): ResearchStore {
    return this.deps.store;
  }

  get(id: string): ResearchJobRow | undefined {
    return this.deps.store.get(id);
  }

  /** Called with the job's id after every change of it (the card's live progress). */
  subscribe(id: string, fn: () => void): () => void {
    const h = (jobId: string) => jobId === id && fn();
    this.events.on("change", h);
    return () => void this.events.off("change", h);
  }

  /** Resolves once every job execution started so far has returned (tests). */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running]);
  }

  // ---- the owner's actions ----

  /** Whether the user has a job planning or running (one at a time, there is no other quota). */
  busy(userId: string): boolean {
    return this.deps.store.withStatus(ACTIVE, userId).length > 0;
  }

  /**
   * A new job: the question (and the files sent with it) as a user message, the card as an assistant message, the job
   * planning. Throws `ResearchError` (or `RunAccessDenied`, `AttachmentError`) with nothing created.
   */
  start(input: {
    conversationId: string;
    userId: string;
    text: string;
    fileIds?: readonly string[] | undefined;
    /** Any text: what is not an available backend is `backend_unavailable` (400). */
    backend?: string | undefined;
  }): { row: ResearchJobRow; user: MessageRow; card: MessageRow } {
    if (this.stopping) throw new ResearchError("shutting_down", 503);
    const { conversations, store, files } = this.deps;
    const user = this.deps.users.byId(input.userId);
    const known = ResearchBackendId.safeParse(input.backend ?? "claude");
    const backend = known.success ? this.backends.get(known.data) : undefined;
    // Stage 1: the built-in backend only (external ones plug in through `ResearchBackend.collect`, TODO #211 2단계).
    if (!backend || backend.id !== "claude" || !backend.available({ youth: user?.youth === true }))
      throw new ResearchError("backend_unavailable", 400);
    const conv = conversations.get(input.conversationId);
    if (!conv || conv.ownerId !== input.userId || !user?.active) throw new ResearchError("forbidden", 403);
    // Claude conversations only (#211 decision 3): a Codex conversation shows the button disabled with the reason.
    if (!onClaude(conv)) throw new ResearchError("research_claude_only", 409);
    this.runCtx(conv, input.userId); // throws RunAccessDenied (403) / no_runtime — before anything is written
    if (this.deps.activeRun?.(conv.id)) throw new ResearchError("run_in_progress", 409);
    const id = crypto.randomUUID();
    const made = this.deps.db.$client
      .transaction(() => {
        if (this.busy(input.userId)) throw new ResearchError("research_busy", 409);
        const fileIds = [...new Set(input.fileIds ?? [])];
        if (fileIds.length && !files) throw new ResearchError("invalid_attachment", 400);
        const refs = files ? files.refs(conv.id, fileIds) : [];
        const userMsg = conversations.append(conv.id, {
          role: "user",
          parts: [{ type: "text", text: input.text }, ...refs],
        });
        files?.attach(conv.id, userMsg.id, fileIds);
        const card = conversations.append(conv.id, {
          role: "assistant",
          parts: [{ type: "research", jobId: id }],
          runtime: "claude-code",
        });
        // The job reads the files of this question and the conversation's earlier ones (#211 decision 5).
        const earlier = (files?.list(conv.id) ?? [])
          .filter((f) => f.messageId !== null && !fileIds.includes(f.id))
          .map((f) => f.id);
        const row = store.create({
          id,
          conversationId: conv.id,
          ownerId: input.userId,
          messageId: card.id,
          question: input.text,
          fileIds: [...fileIds, ...earlier].slice(0, 20),
          backend: backend.id,
        });
        return { row, user: userMsg, card };
      })
      .immediate();
    logEvent(this.deps.log, "info", "research.started", { userId: input.userId, researchId: id });
    this.kick(id);
    return made;
  }

  /** The owner's answer to the clarifying question: planning again, with it (no second question). */
  clarify(id: string, userId: string, answer: string): ResearchJobRow {
    const row = this.owned(id, userId);
    if (row.status !== "clarifying") throw new ResearchError("research_state", 409);
    this.stillClaude(row);
    if (this.busy(userId)) throw new ResearchError("research_busy", 409);
    this.save(id, { status: "planning", clarifyAnswer: answer }, ["clarifying"]);
    this.kick(id);
    return this.get(id)!;
  }

  /**
   * 승인 (with 고치기's edits): the deadline is set — the cap minus the planning time — and the research starts. The
   * edited sub-questions replace the plan's (new ids by the server; no attached files → the web only).
   */
  approve(
    id: string,
    userId: string,
    edits?: { id?: string | undefined; question: string; scope: ResearchScope }[],
  ): ResearchJobRow {
    const row = this.owned(id, userId);
    if (row.status !== "awaiting_approval") throw new ResearchError("research_state", 409);
    const plan = planOf(row);
    if (!plan) throw new ResearchError("research_state", 409);
    this.stillClaude(row);
    if (this.busy(userId)) throw new ResearchError("research_busy", 409);
    const hasFiles = fileIdsOf(row).length > 0;
    const subQuestions = (edits ?? plan.subQuestions).slice(0, this.limits.maxSubQuestions).map((q, i) => ({
      id: `q${i + 1}`,
      question: q.question.trim().slice(0, RESEARCH_LIMITS.subQuestionChars),
      scope: hasFiles ? q.scope : ("web" as const),
    }));
    const approved: ResearchPlan = { ...plan, subQuestions };
    const now = this.clock.now();
    const state: JobState = {
      stage: "research",
      round: 0,
      reflected: -1,
      timedOut: false,
      // What the owner approved: gap questions stay within it (a files-only plan never searches the web).
      scopes: approvedScopes(subQuestions.map((q) => q.scope)),
      questions: subQuestions.map((q): QuestionRecord => ({
        ...q,
        round: 0,
        status: "waiting",
        sources: 0,
        found: [],
        dropped: 0,
      })),
    };
    const ok = this.save(
      id,
      {
        status: "researching",
        plan: approved,
        state,
        approvedAt: now,
        deadlineAt: now + Math.max(this.limits.totalMs - row.activeMs, this.limits.minRoundMs),
      },
      ["awaiting_approval"],
    );
    if (!ok) throw new ResearchError("research_state", 409);
    logEvent(this.deps.log, "info", "research.approved", {
      userId,
      researchId: id,
      count: subQuestions.length,
    });
    this.kick(id);
    return this.get(id)!;
  }

  /** 취소 at the plan card (or the clarifying question, or while planning): nothing more happens. */
  cancel(id: string, userId: string): ResearchJobRow {
    const row = this.owned(id, userId);
    if (!["planning", "clarifying", "awaiting_approval"].includes(row.status))
      throw new ResearchError("research_state", 409);
    this.save(id, { status: "cancelled", endedAt: this.clock.now() }, [
      "planning",
      "clarifying",
      "awaiting_approval",
    ]);
    this.live.get(id)?.abort.abort();
    return this.get(id)!;
  }

  /** 중지 while it runs: every step stops, the job ends as stopped (research_failed notification). */
  stop(id: string, userId: string): ResearchJobRow {
    const row = this.owned(id, userId);
    if (!ACTIVE.includes(row.status)) throw new ResearchError("research_state", 409);
    if (this.save(id, { status: "stopped", endedAt: this.clock.now() }, ACTIVE)) {
      this.live.get(id)?.abort.abort();
      logEvent(this.deps.log, "info", "research.stopped", { userId, researchId: id });
      this.notifyFailed(this.get(id)!, "stopped");
    }
    return this.get(id)!;
  }

  // ---- life cycle ----

  /** At start-up: jobs left planning or running by the previous process carry on from their checkpoint. */
  recover(): number {
    const rows = this.deps.store.withStatus(ACTIVE);
    for (const r of rows) {
      logEvent(this.deps.log, "info", "research.resumed", { userId: r.ownerId, researchId: r.id });
      this.kick(r.id, { recovered: true });
    }
    return rows.length;
  }

  /** On shutdown: every step stops; the jobs keep their state and are resumed by the next start. */
  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const l of this.live.values()) l.abort.abort();
    // Open progress streams end now (a card waiting for approval keeps one open): the server does not wait on them.
    for (const close of [...this.streams]) close();
    await this.idle();
    // Sessions still closing after their step ended: waited for a bounded time (their processes are killed by then).
    await Promise.race([
      Promise.all([...this.cleanups]),
      new Promise<void>((r) => setTimeout(r, 10_000).unref()),
    ]);
  }

  /** A progress stream (routes.ts): closed by `shutdown`. Returns the function that forgets it. */
  addStream(close: () => void): () => void {
    this.streams.add(close);
    return () => void this.streams.delete(close);
  }

  /** A Claude conversation still (a switch to Codex after the plan): refused otherwise (#211 decision 3). */
  private stillClaude(row: ResearchJobRow): void {
    const conv = this.deps.conversations.get(row.conversationId);
    if (!conv || !onClaude(conv)) throw new ResearchError("research_claude_only", 409);
  }

  // ---- internals ----

  private owned(id: string, userId: string): ResearchJobRow {
    const row = this.get(id);
    if (!row) throw new ResearchError("forbidden", 404);
    if (row.ownerId !== userId) throw new ResearchError("forbidden", 403);
    return row;
  }

  /**
   * Writes and tells the subscribers; `from`: only while the job is still in one of these states; `live`: only while
   * that execution is still the job's own (a late step result of an earlier one never changes the job).
   */
  private save(id: string, patch: JobPatch, from?: readonly ResearchStatus[], live?: Live): boolean {
    if (live && (this.live.get(id) !== live || live.abort.signal.aborted)) return false;
    let ok: boolean;
    try {
      ok = this.deps.store.update(id, patch, from);
    } catch {
      ok = false; // the database is going (shutdown): the next start resumes from the last checkpoint
    }
    if (ok) this.events.emit("change", id);
    return ok;
  }

  private kick(id: string, opts: { recovered?: boolean } = {}): void {
    if (this.live.has(id) || this.stopping) return;
    const row = this.get(id);
    if (!row) return;
    const live: Live = { conversationId: row.conversationId, abort: new AbortController() };
    this.live.set(id, live);
    const p = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.execute(id, live, opts))
      .catch((e: unknown) => {
        logEvent(this.deps.log, "error", "research.failed", { researchId: id, err: e });
        if (!live.abort.signal.aborted) this.fail(id, "runtime_error", live);
      })
      .finally(() => {
        live.cancelCap?.();
        if (this.live.get(id) === live) this.live.delete(id);
        this.running.delete(p);
      });
    this.running.add(p);
  }

  private async execute(id: string, live: Live, opts: { recovered?: boolean }): Promise<void> {
    for (;;) {
      if (live.abort.signal.aborted) return;
      const row = this.get(id);
      if (!row) return;
      if (!this.deps.users.byId(row.ownerId)?.active) return void this.fail(id, "not_allowed", live);
      if (row.status === "planning") await this.plan(row, live);
      else if (row.status === "researching" || row.status === "writing") {
        this.armCap(row, live);
        if (row.status === "researching") await this.research(row, live);
        else await this.write(row, live, opts);
      } else return;
      if (live.abort.signal.aborted) return;
      const after = this.get(id);
      // A stage that neither moved on nor was stopped would loop: end it.
      if (after && after.status === row.status) return void this.fail(id, "runtime_error", live);
    }
  }

  /** The hard cap: at the deadline every step of the job stops and the report is written from what was verified. */
  private armCap(row: ResearchJobRow, live: Live): void {
    if (live.cap || row.deadlineAt === null) return;
    live.cap = new AbortController();
    const cap = live.cap;
    live.cancelCap = this.clock.timer(row.deadlineAt - this.clock.now(), () => cap.abort());
  }

  /** The runtime, model and connection a step uses: the conversation's Claude settings, checked for the owner now. */
  private runCtx(conv: ConversationRow, userId: string): RunCtx {
    const adapter = this.deps.registry.get("claude-code");
    if (!adapter) throw new ResearchError("no_runtime", 409);
    const caps = adapter.capabilities();
    const s = settingsOf(conv);
    const mine = s?.runtime === adapter.id ? s : null;
    if (this.deps.access) {
      const r = this.deps.access.resolve({
        userId,
        runtime: adapter.id,
        capabilities: caps,
        requested: mine?.useShared ? { useShared: true } : {},
        current: { model: mine?.model ?? null, effort: mine?.effort ?? null },
      });
      return {
        adapter,
        model: r.model.id,
        effort: r.effort,
        connectionId: r.connectionId,
        connectionVersion: r.connectionVersion,
      };
    }
    const model = caps.models.find((m) => m.id === mine?.model) ?? caps.models[0];
    if (!model) throw new ResearchError("no_runtime", 409);
    return {
      adapter,
      model: model.id,
      effort: mine?.effort ?? model.defaultEffort ?? null,
      connectionId: null,
      connectionVersion: null,
    };
  }

  /** The step's context, or the failure code that ends the job instead. */
  private stepCtx(row: ResearchJobRow): RunCtx | ResearchErrorCode {
    const conv = this.deps.conversations.get(row.conversationId);
    if (!conv) return "conversation_gone";
    // Switched to Codex after the plan (or while the server was down): the job ends, the card says why.
    if (!onClaude(conv)) return "runtime_changed";
    try {
      const ctx = this.runCtx(conv, row.ownerId);
      if (ctx.adapter.capabilities().needsConnection && !ctx.connectionId) return "no_connection";
      return ctx;
    } catch (e) {
      if (e instanceof RunAccessDenied) return "not_allowed";
      if (e instanceof ResearchError) return "no_connection";
      throw e;
    }
  }

  private systemFor(userId: string, tools: readonly string[], prompt: ResearchPromptId): string {
    const u = this.deps.users.byId(userId);
    let docs: DocSet | undefined;
    try {
      docs = this.deps.memory?.docSet(userId);
    } catch {
      docs = undefined;
    }
    const base = assembleInstructions({
      user: { youth: u?.youth === true },
      mode: "research",
      tools,
      now: new Date(this.clock.now()),
      ...(this.deps.templates ? { templates: this.deps.templates } : {}),
      docs: { agentCommon: docs?.agentCommon?.text ?? null, agentAccount: docs?.agentAccount?.text ?? null },
    });
    return `${base.text}\n\n${stepPrompt(this.prompts, prompt)}`;
  }

  /** Of `wanted`, the tools the owner's runs get now (permissions, the server's allow-list). */
  private toolsFor(userId: string, wanted: readonly string[]): string[] {
    const mine = new Set(this.deps.mcp?.toolNamesFor(userId) ?? []);
    return wanted.filter((t) => mine.has(t));
  }

  private files(row: ResearchJobRow): AttachedFile[] {
    const ids = fileIdsOf(row);
    if (!ids.length || !this.deps.fileTools) return [];
    const scope = { conversationId: row.conversationId, userId: row.ownerId };
    return ids.flatMap((fid) => {
      const f = this.deps.fileTools!.fileFor(scope, fid);
      return f ? [{ id: f.id, name: f.name }] : [];
    });
  }

  private step(
    row: ResearchJobRow,
    ctx: RunCtx,
    s: Pick<StepSpec, "text" | "tools" | "ms" | "toolCalls" | "signal"> & {
      name: string;
      prompt: ResearchPromptId;
    },
  ): Promise<StepResult> {
    return runStep(
      {
        stepId: `research:${row.id}:${s.name}`,
        userId: row.ownerId,
        conversationId: row.conversationId,
        adapter: ctx.adapter,
        connectionId: ctx.connectionId,
        connectionVersion: ctx.connectionVersion,
        model: ctx.model,
        effort: ctx.effort,
        systemPrompt: this.systemFor(row.ownerId, s.tools, s.prompt),
        text: s.text,
        tools: s.tools,
        ms: Math.max(1, s.ms),
        toolCalls: s.toolCalls,
        signal: s.signal,
      },
      {
        mcp: this.deps.mcp,
        mcpTokens: this.deps.mcpTokens,
        clock: this.clock,
        usage: this.deps.usage,
        forgetSession: this.deps.forgetSession,
        track: (p) => {
          this.cleanups.add(p);
          void p.finally(() => this.cleanups.delete(p));
        },
        log: this.deps.log,
      },
    );
  }

  // ---- 1. plan ----

  private async plan(row: ResearchJobRow, live: Live): Promise<void> {
    const ctx = this.stepCtx(row);
    if (typeof ctx === "string") return void this.fail(row.id, ctx, live);
    const t0 = this.clock.now();
    const files = this.files(row);
    const r = await this.step(row, ctx, {
      name: `plan:${t0}`,
      prompt: "plan",
      text: planTurn({
        question: row.question,
        files,
        clarify:
          row.clarifyQuestion && row.clarifyAnswer
            ? { question: row.clarifyQuestion, answer: row.clarifyAnswer }
            : null,
      }),
      tools: [],
      ms: this.limits.planMs,
      signal: live.abort.signal,
    });
    if (live.abort.signal.aborted) return;
    const activeMs = row.activeMs + (this.clock.now() - t0);
    if (r.ended === "failed") return void this.fail(row.id, r.error ?? "runtime_error", live);
    const parsed = parsePlan(r.text, { hasFiles: files.length > 0, mayClarify: !row.clarifyQuestion });
    if (!parsed) return void this.fail(row.id, "plan_failed", live);
    if (parsed.kind === "clarify")
      this.save(
        row.id,
        { status: "clarifying", clarifyQuestion: parsed.question, activeMs },
        ["planning"],
        live,
      );
    else this.save(row.id, { status: "awaiting_approval", plan: parsed.plan, activeMs }, ["planning"], live);
  }

  // ---- 2. research ----

  private async research(row: ResearchJobRow, live: Live): Promise<void> {
    const plan = planOf(row);
    if (!plan || row.approvedAt === null || row.deadlineAt === null)
      return void this.fail(row.id, "runtime_error", live);
    const first = this.stepCtx(row);
    if (typeof first === "string") return void this.fail(row.id, first, live);
    const state = stateOf(row);
    // A checkpoint from before the approved scopes were kept: restored from the approved plan.
    state.scopes ??= approvedScopes(plan.subQuestions.map((q) => q.scope));
    // …and every question still to ask (an old checkpoint's gap question too) is held within them.
    for (const q of state.questions)
      if (q.status === "waiting" || q.status === "running") q.scope = clampScope(q.scope, state.scopes);
    const files = this.files(row);
    /**
     * Every new step looks again (review 2): the conversation switched to Codex (or the connection gone) while the job
     * ran ends it — no further Claude step opens.
     */
    let ended: ResearchErrorCode | undefined;
    const fresh = (): RunCtx | undefined => {
      if (ended) return undefined;
      const c = this.stepCtx(this.get(row.id) ?? row);
      if (typeof c !== "string") return c;
      ended = c;
      stage.abort();
      return undefined;
    };
    const researchEnd = Math.min(
      row.approvedAt + this.limits.researchMs,
      row.deadlineAt - this.limits.writeMs - this.limits.wrapUpMs,
    );
    // A restart: what was running is asked again from scratch.
    // A retry (#234) keeps what its first run verified.
    for (const q of state.questions)
      if (q.status === "running")
        Object.assign(
          q,
          q.retried ? { status: "waiting" } : { status: "waiting", found: [], sources: 0, dropped: 0 },
        );
    const stage = new AbortController();
    const cancel = this.clock.timer(researchEnd - this.clock.now(), () => stage.abort());
    const signal = anySignal(live.abort.signal, stage.signal, live.cap!.signal);
    const persist = () => this.save(row.id, { state }, ["researching"], live);
    let error: ResearchErrorCode | undefined;
    try {
      for (;;) {
        // A retry (#234) that is still to run (a restart) starts only with a round's time left; otherwise it keeps
        // what its first run found.
        if (researchEnd - this.clock.now() < this.limits.minRoundMs)
          for (const q of state.questions)
            if (q.status === "waiting" && q.retried) q.status = q.found.length ? "done" : "capped";
        const waiting = state.questions.filter((q) => q.status === "waiting");
        if (waiting.length && this.clock.now() < researchEnd && !signal.aborted)
          await pool(waiting, this.limits.concurrency, async (q) => {
            if (signal.aborted) return;
            const ctx = fresh();
            if (!ctx) return;
            // Held within the approved sources right before it runs (review #237 1차): an old checkpoint's question
            // of any status — a retry may run a done one again — never gets tools the owner did not approve.
            q.scope = clampScope(q.scope, state.scopes);
            q.status = "running";
            persist();
            // A retry (#234) keeps what the first run verified and is told what it found and what failed.
            const before = q.retried ? q.found : [];
            const r = await this.step(row, ctx, {
              name: q.retried ? `${q.id}:retry` : q.id,
              prompt: "subagent",
              text: subagentTurn({
                question: row.question,
                plan,
                sub: q,
                files,
                ...(q.retried ? { retry: { found: before, unverified: q.unverified ?? [] } } : {}),
              }),
              tools: this.toolsFor(row.ownerId, toolsOf(q.scope)),
              ms: Math.min(this.limits.subagentMs, researchEnd - this.clock.now()),
              toolCalls: this.limits.subagentToolCalls,
              signal,
            });
            if (live.abort.signal.aborted) return;
            const raw = parseNotes(r.text, this.limits.notesPerQuestion);
            const checked = await this.verifyNotes(row, raw, new Set(files.map((f) => f.id)));
            const notes = mergeNotes(before, checked.notes, this.limits.notesPerQuestion);
            q.found = notes;
            q.sources = sourceCount(notes);
            q.dropped = (q.retried ? q.dropped : 0) + (raw.length - checked.notes.length);
            q.unverified = mergeUnverified(
              q.retried ? (q.unverified ?? []) : [],
              checked.unverified,
              checked.notes,
            );
            q.repaired = (q.retried ? (q.repaired ?? 0) : 0) + checked.repaired;
            q.status =
              r.ended === "done"
                ? "done"
                : r.ended === "failed"
                  ? notes.length
                    ? "done"
                    : "failed"
                  : "capped";
            // Why it failed: a passing runtime error may be retried once (#234); an account's state may not.
            q.failure = r.ended === "failed" && !notes.length ? (r.error ?? "runtime_error") : undefined;
            if (r.ended === "failed") error ??= r.error;
            persist();
          });
        if (ended) return void this.fail(row.id, ended, live);
        if (live.abort.signal.aborted) return;
        if (signal.aborted || this.clock.now() >= researchEnd) {
          // Cut by the cap (or the research budget): what was not finished is marked, the report says so.
          if (state.questions.some((q) => q.status === "waiting" || q.status === "capped"))
            state.timedOut = true;
          break;
        }
        // Not enough time for another round: straight to writing (the forced wrap-up).
        if (researchEnd - this.clock.now() < this.limits.minRoundMs) break;
        // Weak sub-questions (#234) — no verified note, or one source only — are researched once more with rewritten
        // queries, whether or not the lead names them: within the same budgets, before the lead looks for gaps.
        const weak = state.questions.filter(
          (q) =>
            !q.retried &&
            (q.status === "done" ||
              q.status === "capped" ||
              (q.status === "failed" && RETRYABLE.has(q.failure ?? ""))) &&
            (q.found.length === 0 || q.sources <= 1),
        );
        if (weak.length) {
          for (const q of weak) {
            q.scope = clampScope(q.scope, state.scopes);
            Object.assign(q, { retried: true, status: "waiting", failure: undefined });
          }
          logEvent(this.deps.log, "info", "research.retry", {
            userId: row.ownerId,
            researchId: row.id,
            count: weak.length,
          });
          persist();
          continue;
        }
        // One more gap round than `maxDepth` only while plenty of research time is left (#234).
        const depth =
          this.limits.maxDepth +
          (researchEnd - this.clock.now() >= this.limits.extraRoundMs ? this.limits.extraDepth : 0);
        if (state.round >= depth || state.reflected >= state.round) break;
        const notes = allNotes(state);
        const ctx = fresh();
        if (!ctx) return void this.fail(row.id, ended!, live);
        const r = await this.step(row, ctx, {
          name: `reflect${state.round}`,
          prompt: "reflect",
          text: reflectTurn({
            question: row.question,
            plan,
            scopes: state.scopes ?? ["web"],
            asked: state.questions.map((q) => q.question),
            notes: pickNotes(state, this.limits.maxNotes),
            unverified: state.questions.flatMap((q) => q.unverified ?? []).slice(0, UNVERIFIED_KEPT * 2),
          }),
          tools: [],
          ms: Math.min(REFLECT_MS, researchEnd - this.clock.now()),
          signal,
        });
        if (live.abort.signal.aborted) return;
        state.reflected = state.round;
        const asked = new Set(state.questions.map((q) => q.question));
        const gaps =
          r.ended === "done" && notes.length
            ? parseGaps(r.text, files.length > 0)
                .filter((g) => !asked.has(g.question))
                .map((g) => ({ ...g, scope: clampScope(g.scope, state.scopes) }))
            : [];
        // The reflection took time: the new round starts only if it still fits — `extraRoundMs` for the round past
        // `maxDepth`, `minRoundMs` otherwise (review #237 1차).
        const left = researchEnd - this.clock.now();
        const need =
          state.round + 1 > this.limits.maxDepth ? this.limits.extraRoundMs : this.limits.minRoundMs;
        if (!gaps.length || left < need) {
          persist();
          break;
        }
        state.round++;
        for (const [i, g] of gaps.entries())
          state.questions.push({
            id: `r${state.round}q${i + 1}`,
            question: g.question,
            scope: g.scope,
            round: state.round,
            status: "waiting",
            sources: 0,
            found: [],
            dropped: 0,
          });
        persist();
      }
    } finally {
      cancel();
    }
    for (const q of state.questions)
      if (q.status === "waiting" || q.status === "running") q.status = "capped";
    state.stage = "write";
    if (error && !allNotes(state).length) return void this.fail(row.id, error, live);
    this.save(row.id, { status: "writing", state }, ["researching"], live);
  }

  /**
   * The notes whose passage the server finds in their page (a source of the conversation) or attached file. A web
   * note whose quote is not in its page is repaired first (#234): the page's own passage closest to the quote
   * (`closestPassage` — the same words, every number, no rival passage) replaces it and is checked again, exactly, as
   * any quote. Claims that still fail come back as `unverified` (the retry and the lead see them).
   */
  private async verifyNotes(
    row: ResearchJobRow,
    raw: RawNote[],
    files: ReadonlySet<string>,
  ): Promise<{ notes: ResearchNote[]; unverified: string[]; repaired: number }> {
    const scope = { conversationId: row.conversationId, userId: row.ownerId };
    const out: ResearchNote[] = [];
    const seen = new Set<string>();
    const unverified: string[] = [];
    let repaired = 0;
    for (const n of raw) {
      let note: ResearchNote | undefined;
      try {
        if (n.sourceId) {
          let r = this.deps.citations.recheck(scope, { sourceId: n.sourceId, snippet: n.quote });
          if (r && r.status === "snippet_not_found" && r.source.kind === "page" && r.source.body) {
            const near = closestPassage(r.source.body, scrubKnown(n.quote));
            if (near.kind === "match") {
              const again = this.deps.citations.recheck(scope, {
                sourceId: n.sourceId,
                snippet: near.passage,
              });
              if (again?.status === "verified" && again.quote) {
                r = again;
                repaired++;
              }
            }
          }
          if (r?.status === "verified" && r.quote)
            note = {
              id: "",
              claim: scrubKnown(n.claim),
              quote: r.quote,
              sourceId: r.source.id,
              title: r.source.title,
              sourceType: sourceTypeOf(r.source.finalUrl ?? r.source.url),
            };
        } else if (n.fileId && files.has(n.fileId) && this.deps.fileTools) {
          const f = this.deps.fileTools.fileFor(scope, n.fileId);
          const c = f ? await this.deps.fileTools.check(f, scrubKnown(n.quote), n.page) : undefined;
          if (f && c?.status === "verified" && c.quote)
            note = {
              id: "",
              claim: scrubKnown(n.claim),
              quote: c.quote,
              fileId: f.id,
              title: f.name,
              // The verified place (the check may have found it on another page than the model said), and its page
              // for the writer's `file_cite` (which looks there first).
              ...(placeOf(c.locator) ? { place: placeOf(c.locator) } : {}),
              // The search unit it was found in — what `file_cite`'s `page` names (a TXT unit spans lines: not the line).
              ...(c.unit !== undefined ? { page: c.unit } : {}),
            };
        }
      } catch {
        note = undefined;
      }
      if (!note) {
        if (unverified.length < UNVERIFIED_KEPT) unverified.push(scrubKnown(n.claim).slice(0, 300));
        continue;
      }
      const key = `${note.sourceId ?? note.fileId}\n${note.quote}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(note);
    }
    return {
      notes: out.map((n, i) => ({ ...n, id: `${crypto.randomUUID().slice(0, 8)}-${i}` })),
      unverified,
      repaired,
    };
  }

  // ---- 3. write ----

  private async write(row: ResearchJobRow, live: Live, opts: { recovered?: boolean }): Promise<void> {
    const plan = planOf(row);
    if (!plan || row.deadlineAt === null) return void this.fail(row.id, "runtime_error", live);
    const state = stateOf(row);
    const notes = pickNotes(state, this.limits.maxNotes);
    if (!notes.length) return void this.fail(row.id, opts.recovered ? "server_restart" : "no_findings", live);
    const files = this.files(row);
    const writeEnd = row.deadlineAt - this.limits.wrapUpMs;
    const left = writeEnd - this.clock.now();
    let body = "";
    let removed = 0;
    let sources: (ReportCitation & { k: number })[] = [];
    let fallback = false;
    if (left >= MIN_WRITE_MS && !live.cap?.signal.aborted) {
      const ctx = this.stepCtx(row);
      if (typeof ctx === "string") return void this.fail(row.id, ctx, live);
      const name = `write:${this.clock.now()}`;
      const r = await this.step(row, ctx, {
        name,
        prompt: "writer",
        text: writerTurn({ question: row.question, plan, notes }),
        tools: this.toolsFor(row.ownerId, files.length ? ["cite", "file_cite"] : ["cite"]),
        ms: Math.min(this.limits.writeMs, left),
        signal: anySignal(live.abort.signal, live.cap!.signal),
      });
      if (live.abort.signal.aborted) return;
      if (r.ended === "timeout" || r.ended === "aborted") state.timedOut = true;
      const cites = this.citationsOf(`research:${row.id}:${name}`);
      const cleaned = cleanReport(r.text, cites);
      // What the writer wrote without a verified citation is counted whether its rest is kept or not.
      removed = cleaned.removed;
      if (cleaned.numbering.length) {
        body = cleaned.body;
        sources = cleaned.numbering.map(({ from, to }) => ({ ...cites.get(from)!, k: to }));
      } else fallback = true;
    } else {
      fallback = true;
      state.timedOut = true;
    }
    if (fallback) {
      const fb = this.fallbackBody(row, state, notes);
      body = fb.body;
      sources = fb.sources;
    }
    this.finishReport(row, plan, state, { body, removed, sources, fallback }, live);
  }

  /** The writer's citations by number, as the report shows them. */
  private citationsOf(stepId: string): Map<number, ReportCitation> {
    const out = new Map<number, ReportCitation>();
    for (const c of this.deps.citations.forRun(stepId)) {
      let place: string | undefined;
      if (c.locator)
        try {
          place = locatorLabel(JSON.parse(c.locator) as FileLocator) || undefined;
        } catch {
          place = undefined;
        }
      out.set(c.n, {
        n: c.n,
        verified: c.status === "verified" && (!!c.source || !!c.file),
        kind: c.fileId ? "file" : "web",
        title: c.file?.name ?? c.source?.title ?? "",
        url: c.source ? (c.source.finalUrl ?? c.source.url) : undefined,
        site: c.source?.site,
        place,
        quote: c.quote ?? c.snippet,
      });
    }
    return out;
  }

  /** No time (or nothing verified) from the writer: the verified passages themselves, per sub-question. */
  private fallbackBody(
    row: ResearchJobRow,
    state: JobState,
    notes: ResearchNote[],
  ): { body: string; sources: (ReportCitation & { k: number })[] } {
    const kept = new Set(notes.map((n) => n.id));
    const sources: (ReportCitation & { k: number })[] = [];
    const sections: string[] = [];
    for (const q of state.questions) {
      const mine = q.found.filter((n) => kept.has(n.id));
      if (!mine.length) continue;
      const lines = mine.map((n) => {
        const k = sources.length + 1;
        sources.push({ ...this.describe(row, n), k });
        return `- ${mdText(n.title ?? "", 60) || "출처"}: “${mdText(n.quote, 300)}” [${k}]`;
      });
      sections.push(`## ${mdText(q.question, 120)}\n\n${lines.join("\n")}`);
    }
    return { body: sections.join("\n\n"), sources };
  }

  private describe(row: ResearchJobRow, n: ResearchNote): ReportCitation {
    if (n.sourceId) {
      const s = this.deps.sources.get(row.conversationId, n.sourceId);
      return {
        n: 0,
        verified: true,
        kind: "web",
        title: s?.title ?? n.title ?? "",
        url: s ? (s.finalUrl ?? s.url) : undefined,
        site: s?.site,
        quote: n.quote,
      };
    }
    return {
      n: 0,
      verified: true,
      kind: "file",
      title: n.title ?? "첨부 파일",
      // The verified place only (`page` is the search unit for `file_cite`, not a page shown to anyone).
      place: n.place,
      quote: n.quote,
    };
  }

  private finishReport(
    row: ResearchJobRow,
    plan: ResearchPlan,
    state: JobState,
    r: { body: string; removed: number; sources: (ReportCitation & { k: number })[]; fallback: boolean },
    live: Live,
  ): void {
    const { conversations, artifacts } = this.deps;
    const conv = conversations.get(row.conversationId);
    // Stopped (or gone) meanwhile: no artifact, no message. Nothing below awaits, so no stop can come in between.
    if (!conv || this.get(row.id)?.status !== "writing") return;
    const unanswered = state.questions.filter((q) => !q.found.length).map((q) => q.question);
    const content = renderReport({
      title: plan.title,
      date: seoulDate(new Date(this.clock.now())),
      body: r.body,
      sources: r.sources,
      removed: r.removed,
      timedOut: state.timedOut,
      fallback: r.fallback,
      unanswered,
      questions: state.questions.length,
    });
    const summary = summaryOf(r.body);
    const text = [
      `**깊이 조사 보고서**를 만들었어요 — 하위 질문 ${state.questions.length}개, 확인된 출처 ${r.sources.length}개, 확인하지 못해 뺀 문장 ${r.removed}개.${state.timedOut ? " 시간 상한(30분)으로 일부만 조사했어요." : ""}`,
      ...(summary ? [`보고서 요약 (출처는 보고서에 있어요):\n\n${summary}`] : []),
    ].join("\n\n");
    state.stage = "end";
    const runId = `research:${row.id}`;
    // One transaction (review 1): the report, its link to the card, the card's message and `done` — all or nothing. A
    // report this job made already (a crash right after an older version of this code) is used again, never doubled.
    const ok = this.deps.db.$client
      .transaction(() => {
        if (
          this.get(row.id)?.status !== "writing" ||
          this.live.get(row.id) !== live ||
          live.abort.signal.aborted
        )
          return false;
        const prev = artifacts.list(row.conversationId).find((x) => x.runId === runId);
        const made = prev
          ? artifacts.update({ userId: row.ownerId, conversationId: row.conversationId, runId }, prev.id, {
              title: plan.title,
              content,
            })
          : artifacts.create(
              { userId: row.ownerId, conversationId: row.conversationId, runId },
              { kind: "markdown", title: plan.title, content },
            );
        artifacts.linkMessage(made.artifact.id, row.messageId);
        const parts: MessagePart[] = [
          { type: "research", jobId: row.id },
          { type: "text", text },
          { type: "artifact_ref", artifactId: made.artifact.id, version: made.version.version },
        ];
        const result = {
          artifactId: made.artifact.id,
          version: made.version.version,
          removed: r.removed,
          citations: r.sources.length,
          timedOut: state.timedOut,
          fallback: r.fallback,
        };
        if (conversations.messageById(row.messageId)) conversations.updateMessage(row.messageId, { parts });
        if (
          !this.deps.store.update(row.id, { status: "done", state, result, endedAt: this.clock.now() }, [
            "writing",
          ])
        )
          throw new Error("research job changed while it was being finished");
        return true;
      })
      .immediate();
    if (!ok) return;
    this.events.emit("change", row.id);
    logEvent(this.deps.log, "info", "research.done", {
      userId: row.ownerId,
      researchId: row.id,
      count: r.sources.length,
    });
    const n = this.deps.notifications();
    if (n && (n.wants?.(row.ownerId, "research_done") ?? true))
      n.publish(
        row.ownerId,
        {
          kind: "research_done",
          topic: plan.title,
          url: `/c/${row.conversationId}#m-${row.messageId}`,
          ref: { kind: "conversation", id: row.conversationId },
        },
        { dedupeKey: `research:${row.id}:end` },
      );
  }

  private fail(id: string, code: ResearchErrorCode, live?: Live): void {
    if (!this.save(id, { status: "failed", errorCode: code, endedAt: this.clock.now() }, ACTIVE, live))
      return;
    const row = this.get(id)!;
    logEvent(this.deps.log, "warn", "research.failed", {
      userId: row.ownerId,
      researchId: id,
      researchCode: code,
    });
    this.notifyFailed(row, code);
  }

  private notifyFailed(row: ResearchJobRow, code: ResearchErrorCode | "stopped"): void {
    const n = this.deps.notifications();
    if (!n || !(n.wants?.(row.ownerId, "research_failed") ?? true)) return;
    n.publish(
      row.ownerId,
      {
        kind: "research_failed",
        topic: planOf(row)?.title ?? row.question,
        reason: RESEARCH_FAILURE_TEXT[code],
        url: `/c/${row.conversationId}#m-${row.messageId}`,
        ref: { kind: "conversation", id: row.conversationId },
      },
      { dedupeKey: `research:${row.id}:end` },
    );
  }
}

/** Our tools a sub-researcher of this scope gets. */
export function toolsOf(scope: ResearchScope): string[] {
  const web = ["web_search", "web_fetch", "web_find"];
  const files = ["file_search", "file_read"];
  return scope === "web" ? web : scope === "files" ? files : [...web, ...files];
}

const allNotes = (s: JobState) => s.questions.flatMap((q) => q.found);

/**
 * A retry's notes after the first run's (#234): the same passage of the same source once, at most `max` — and every
 * source the retry newly found keeps at least one place (review #237 1차: twelve notes of page A must not crowd out
 * the retry's page B). Otherwise the first run's notes come first, then the retry's, in order.
 */
export function mergeNotes(before: ResearchNote[], after: ResearchNote[], max: number): ResearchNote[] {
  const key = (n: ResearchNote) => `${n.sourceId ?? n.fileId}\n${n.quote}`;
  const src = (n: ResearchNote) => (n.sourceId ? `s:${n.sourceId}` : `f:${n.fileId}`);
  const seen = new Set<string>();
  const all: ResearchNote[] = [];
  for (const n of [...before, ...after]) {
    if (seen.has(key(n))) continue;
    seen.add(key(n));
    all.push(n);
  }
  if (all.length <= max) return all;
  const old = new Set(before.map(src));
  const kept = new Set<ResearchNote>();
  const fresh = new Set<string>();
  for (const n of all.slice(before.length))
    if (!old.has(src(n)) && !fresh.has(src(n)) && kept.size < max) {
      fresh.add(src(n));
      kept.add(n);
    }
  let room = max - kept.size;
  return all.filter((n) => kept.has(n) || (room > 0 && room-- > 0));
}

/**
 * A sub-question's unverified claims after a run (#234): the earlier ones and the new failures, once each, without
 * those a note of this run now backs (the same claim), at most `UNVERIFIED_KEPT` — a retry that finds nothing does
 * not forget what failed before.
 */
export function mergeUnverified(
  before: readonly string[],
  failed: readonly string[],
  verified: readonly ResearchNote[],
): string[] {
  const flat = (c: string) => c.normalize("NFC").replace(/\s+/gu, " ").trim();
  const backed = new Set(verified.map((n) => flat(n.claim)));
  const out: string[] = [];
  for (const c of [...before, ...failed])
    if (!backed.has(flat(c)) && !out.some((x) => flat(x) === flat(c))) out.push(c);
  return out.slice(0, UNVERIFIED_KEPT);
}

/** At most `max` notes for the lead and the writer, taken in turn from each sub-question (none crowds out another). */
export function pickNotes(s: JobState, max: number): ResearchNote[] {
  const lists = s.questions.map((q) => [...q.found]);
  const out: ResearchNote[] = [];
  for (let i = 0; out.length < max && lists.some((l) => i < l.length); i++)
    for (const l of lists) if (i < l.length && out.length < max) out.push(l[i]!);
  return out;
}

/** The report's "요약" section without its markers (the chat message's preview), bounded. */
export function summaryOf(body: string): string {
  // The heading may keep a verified marker (`## 요약[1]`).
  const m = /(?:^|\n)##\s*요약(?:\s*\[\d{1,3}\])*[ \t]*\n([\s\S]*?)(?=\n##\s|$)/.exec(body);
  const text = (m?.[1] ?? "").replace(/\s*\[\d{1,3}\]/g, "").trim();
  const chars = Array.from(text);
  return chars.length > 700 ? `${chars.slice(0, 699).join("")}…` : text;
}

/** The conversation answers with Claude (or has no settings yet: Claude is the service default). */
function onClaude(conv: ConversationRow): boolean {
  return (settingsOf(conv)?.runtime ?? "claude-code") === "claude-code";
}

/** The sources a set of approved scopes allows. */
export function approvedScopes(scopes: readonly ResearchScope[]): ("web" | "files")[] {
  const out = new Set<"web" | "files">();
  for (const s of scopes) {
    if (s === "web" || s === "both") out.add("web");
    if (s === "files" || s === "both") out.add("files");
  }
  return [...out];
}

/** A gap question's scope, held within what the owner approved (an older checkpoint without it: as asked). */
export function clampScope(
  scope: ResearchScope,
  allowed: readonly ("web" | "files")[] | undefined,
): ResearchScope {
  if (!allowed?.length) return scope;
  const web = allowed.includes("web");
  const files = allowed.includes("files");
  if (web && files) return scope;
  return web ? "web" : "files";
}

/** A verified file passage's place as the report shows it ("3쪽", "표 2 · B3"). */
function placeOf(locator: unknown): string | undefined {
  if (!locator || typeof locator !== "object" || !("kind" in locator)) return undefined;
  try {
    return locatorLabel(locator as FileLocator) || undefined;
  } catch {
    return undefined;
  }
}
