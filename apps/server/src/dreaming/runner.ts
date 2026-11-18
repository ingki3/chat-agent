import crypto from "node:crypto";
import {
  utf8Bytes,
  type DreamingChoice,
  type DreamingCounts,
  type DreamingProblem,
  type DreamingRunStatus,
  type DreamingTrigger,
  type MemoryListKind,
  type RuntimeId,
} from "@agentlee/shared";
import type { UserStore } from "../auth/users.js";
import type { ConnectionStore } from "../connections/store.js";
import { systemUsable } from "../connections/store.js";
import type { Db } from "../db/client.js";
import { logEvent, type EventLogger } from "../logging.js";
import type { MemoryProposals } from "../memory/proposals.js";
import { triesRuleChange } from "../memory/rules.js";
import type { MemoryStore } from "../memory/store.js";
import {
  RuntimeFailure,
  usageReport,
  type RuntimeRegistry,
  type RuntimeSession,
  type RuntimeTurn,
  type UsageReport,
} from "../runtime/adapter.js";
import type { SessionRef } from "../runtime/runs.js";
import type { UsageAttempt } from "../usage/store.js";
import { ALLOWED, gatherInput, resumeCheckpoint, type PackedInput } from "./input.js";
import { dreamingRequest, dreamingSystemPrompt, parseDreamingOutput, type DocItems } from "./prompt.js";
import { emptyCounts, type DreamingStore } from "./store.js";
import { checkDecisions, itemRef, type Checked, type DocCtx } from "./validate.js";

/**
 * One 기억 정리 attempt (#146, PRD FR-16.5·16.6, docs/memory-spec.md §3–§10):
 * 1. claim the attempt (idempotency key `dreaming:<user>:<date>:<attempt>` — never twice, even across a restart);
 * 2. expire bundles whose documents changed (their sources go to the queue), leave out documents that have a bundle
 *    waiting for review, and gather the input (queue first, then new messages after the checkpoint, ≤ 60,000 chars);
 * 3. ask the model of the user's chosen shared API key connection (one the admin allowed), **without tools**, in a one-off session of the target user's
 *    folder — forgotten right after (`RuntimeAdapter.forget` through the deletion jobs), usage recorded as `dreaming`;
 * 4. check the decisions (spec §4) and, in **one transaction**: re-check the sources and the documents, make the
 *    bundle (검토 후 반영) or apply it (자동 반영 — not from a source that reads like an instruction), move the queue
 *    and the checkpoint (forward only), and record the outcome (counts only);
 * 5. notify the user (counts only, unless turned off).
 * A failure (no connection, expired, limit, model error, time-out) changes nothing but the record — the engine tries
 * again 30 minutes later, once.
 */

const KINDS: MemoryListKind[] = ["user", "memory"];
/** Bytes kept for the answer under the run's token cap. */
const OUTPUT_RESERVE = 16_000;
/** An answer longer than this is not a decision list: the run fails (model error). */
const OUTPUT_MAX = 100_000;

export type DreamingFailureCode =
  "no_connection" | "connection_limited" | "runtime_auth" | "model_error" | "timeout" | "too_large";

export type RunRequest = {
  userId: string;
  date: string;
  attempt: number;
  trigger: DreamingTrigger;
  idemKey: string;
  /** 미리 실행 (the caller's own data): this prompt instead of the saved one, and nothing is applied or moved. */
  preview?: { content?: string | undefined };
  /** Not run, only recorded as skipped with this code (the day's answers kept it busy, spec §6). */
  skip?: "busy";
};

export type RunResult = {
  runId: string;
  status: DreamingRunStatus;
  code: string | null;
  counts: DreamingCounts;
  /** 미리 실행: the decisions that passed the checks (the caller's own content). */
  decisions?: Checked[];
};

export type DreamingRunnerDeps = {
  db: Db;
  store: DreamingStore;
  memory: MemoryStore;
  proposals: MemoryProposals;
  registry: RuntimeRegistry;
  connections: Pick<ConnectionStore, "get" | "limitedUntil"> | undefined;
  users: Pick<UserStore, "byId">;
  usage?: { record(a: UsageAttempt, u: UsageReport): void } | undefined;
  /** A one-off session's runtime state, to be forgotten (conversations/purge.ts `orphan`). */
  forgetSession?: ((ref: SessionRef) => void) | undefined;
  notify?:
    | ((userId: string, kind: "memory_proposal" | "memory_applied", count: number, runId: string) => void)
    | undefined;
  now?: () => number;
  log?: EventLogger | undefined;
  timeoutMs?: number;
};

class Failed extends Error {
  constructor(readonly code: DreamingFailureCode) {
    super(code);
  }
}
/** The attempt was recorded as over meanwhile (a restart failed it): nothing of it is written. */
class Gone extends Error {}

export class DreamingRunner {
  private readonly now: () => number;

  constructor(private readonly deps: DreamingRunnerDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * Why the user's rounds cannot run now although their switch may be on (the engine pauses them — spec §7): the
   * server-wide switch is off, nothing chosen, or the chosen pair is no longer allowed or its connection is gone.
   */
  problemOf(userId: string): DreamingProblem | null {
    const { store } = this.deps;
    if (!store.config().enabled) return "server_off";
    const s = store.settingsOf(userId);
    if (!s.runtime || !s.model) return "no_choice";
    if (!store.allows(s)) return "unavailable";
    return this.choiceProblem({ runtime: s.runtime, connectionId: s.connectionId, model: s.model })
      ? "unavailable"
      : null;
  }

  /** Whether a connection·model pair can be used at all: its connection deleted / disconnected, or not shared API key. */
  choiceProblem(c: DreamingChoice): "missing" | "not_allowed" | null {
    const adapter = this.deps.registry.get(c.runtime);
    if (!adapter) return "missing";
    if (!adapter.capabilities().needsConnection) return null; // the FakeRuntime (development, e2e)
    if (!c.connectionId) return "missing";
    const row = this.deps.connections?.get(c.connectionId);
    if (!row || row.disconnectedAt !== null || row.secret === null) return "missing";
    if (row.scope !== "shared" || row.authType !== "api_key" || row.runtime !== c.runtime)
      return "not_allowed";
    return null;
  }

  async run(req: RunRequest): Promise<RunResult | undefined> {
    const { store } = this.deps;
    const cfg = store.settingsOf(req.userId);
    const runId = crypto.randomUUID();
    const prompt = store.promptOf(req.userId);
    const claimed = store.claimRun({
      id: runId,
      user_id: req.userId,
      date: req.date,
      attempt: req.attempt,
      idem_key: req.idemKey,
      trigger: req.trigger,
      runtime: cfg.runtime,
      model: cfg.model,
      connection_id: cfg.connectionId,
      prompt_version: req.preview?.content !== undefined ? null : prompt.version,
      started_at: this.now(),
    });
    if (!claimed) return undefined;
    logEvent(this.deps.log, "info", "dreaming.run_started", {
      userId: req.userId,
      runId,
      attempt: req.attempt,
      dreamingTrigger: req.trigger,
    });
    const counts = emptyCounts();
    const end = (
      status: DreamingRunStatus,
      code: string | null,
      extra: Partial<RunResult> = {},
    ): RunResult => {
      logEvent(this.deps.log, status === "failed" ? "warn" : "info", "dreaming.run_finished", {
        userId: req.userId,
        runId,
        attempt: req.attempt,
        dreamingTrigger: req.trigger,
        dreamingStatus: status,
        ...(code ? { dreamingCode: code } : {}),
        count: counts.applied + counts.proposed,
      });
      return { runId, status, code, counts, ...extra };
    };
    if (req.skip) {
      store.finishRun(runId, "skipped", req.skip, counts);
      return end("skipped", req.skip);
    }
    try {
      return await this.attempt(req, runId, counts, end, prompt.content);
    } catch (e) {
      if (e instanceof Gone) return end("failed", "interrupted");
      const code = e instanceof Failed ? e.code : "model_error";
      try {
        store.finishRun(runId, "failed", code, counts);
      } catch {
        // the database is going: the start-up recovery fails the attempt
      }
      return end("failed", code);
    }
  }

  private async attempt(
    req: RunRequest,
    runId: string,
    counts: DreamingCounts,
    end: (status: DreamingRunStatus, code: string | null, extra?: Partial<RunResult>) => RunResult,
    savedPrompt: string,
  ): Promise<RunResult> {
    const { store, proposals, memory, db } = this.deps;
    const preview = req.preview !== undefined;
    const user = this.deps.users.byId(req.userId);
    if (!user?.active) {
      if (!store.finishRun(runId, "skipped", "inactive", counts)) throw new Gone();
      return end("skipped", "inactive");
    }
    // Turned off (for everyone or this user) since the round was planned: nothing runs (review #160 round 1).
    if (!preview && !store.switchedOn(req.userId)) {
      if (!store.finishRun(runId, "skipped", "paused", counts)) throw new Gone();
      return end("skipped", "paused");
    }
    // Runtime, model and connection (spec §7: the user's choice among the admin's allowed shared API key connections
    // only — no fallback).
    const cfg = store.settingsOf(req.userId);
    const tokenCap = store.config().tokenCap;
    if (!store.allows(cfg)) throw new Failed("no_connection");
    const adapter = cfg.runtime ? this.deps.registry.get(cfg.runtime) : undefined;
    if (!adapter || !cfg.model) throw new Failed("no_connection");
    const caps = adapter.capabilities();
    const model = caps.models.find((m) => m.id === cfg.model);
    if (!model || (model.contextWindow ?? 200_000) < 200_000) throw new Failed("no_connection");
    let connectionId: string | null = null;
    if (caps.needsConnection) {
      const row = cfg.connectionId ? this.deps.connections?.get(cfg.connectionId) : undefined;
      if (!row || !(row.scope === "shared" && row.authType === "api_key" && row.disconnectedAt === null))
        throw new Failed("no_connection");
      if (row.status === "expired") throw new Failed("runtime_auth");
      if (!systemUsable(row, cfg.runtime!)) throw new Failed("no_connection");
      const until = this.deps.connections!.limitedUntil(row.id, model.id);
      if (until !== null && until > this.now()) throw new Failed("connection_limited");
      connectionId = row.id;
    }

    // Before the input: bundles whose documents changed expire (their sources are queued again), and documents with a
    // bundle still waiting for review are left out — their new input stays queued for them (spec §5). The expiry is
    // only planned here: it is written with the run's outcome, so a run that fails changes nothing (review #160).
    const stale = preview ? { ids: new Set<string>(), requeue: [] } : proposals.staleDreaming(req.userId);
    const blocked = preview
      ? new Set<MemoryListKind>()
      : proposals.pendingDreamingDocs(req.userId, stale.ids);
    const editable = KINDS.filter((k) => !blocked.has(k));
    if (!editable.length) {
      this.commit(req.userId, runId, () => ({ status: "skipped", code: "pending_review" }), counts);
      return end("skipped", "pending_review");
    }
    const state = store.state(req.userId);
    const resumed = state.paused_at !== null || state.checkpoint_at === null;
    const resume = resumed
      ? resumeCheckpoint(db, req.userId, state.checkpoint, this.now())
      : { checkpoint: state.checkpoint, skippedOld: false };
    counts.skippedOld = resume.skippedOld;

    const docs: DocCtx[] = KINDS.map((k) => {
      const doc = memory.ensure(req.userId, k);
      return { kind: k, doc, items: memory.items(doc), editable: editable.includes(k) };
    });
    const docItems: DocItems[] = docs.map((d) => ({
      kind: d.kind,
      editable: d.editable,
      items: d.items.map((i, n) => ({ ref: itemRef(d.kind, n), text: i.text })),
    }));
    const system = dreamingSystemPrompt(req.preview?.content ?? savedPrompt);
    const skeleton = dreamingRequest(docItems, []);
    const maxBytes = tokenCap - utf8Bytes(system) - utf8Bytes(skeleton) - OUTPUT_RESERVE;
    if (maxBytes < 1000) throw new Failed("too_large");
    const input: PackedInput = gatherInput(db, {
      userId: req.userId,
      checkpoint: resume.checkpoint,
      docs: editable,
      maxBytes,
      suspicious: triesRuleChange,
      extraQueue: stale.requeue,
    });
    if (input.tooLarge) throw new Failed("too_large");
    counts.newMessages = input.messages.filter((m) => !m.queued).length;
    counts.queuedMessages = input.messages.filter((m) => m.queued).length;
    counts.cut = input.cut;
    if (!input.messages.length) {
      if (preview) {
        if (!store.finishRun(runId, "skipped", "no_input", counts)) throw new Gone();
        return end("skipped", "no_input", { decisions: [] });
      }
      // Nothing to do: recorded as skipped — the checkpoint passes what had no words of the user's (spec §6).
      this.commit(
        req.userId,
        runId,
        () => {
          this.moveQueue(req.userId, input, blocked, []);
          store.advance(req.userId, Math.max(resume.checkpoint, input.lastNewSeq ?? 0), resumed);
          return { status: "skipped", code: "no_input" };
        },
        counts,
      );
      return end("skipped", "no_input");
    }

    // The model, without tools — the request as it will really be sent checked against the cap once more.
    const request = dreamingRequest(docItems, input.messages);
    if (utf8Bytes(system) + utf8Bytes(request) + OUTPUT_RESERVE > tokenCap) throw new Failed("too_large");
    const text = await this.ask(adapter.id, {
      runId,
      userId: req.userId,
      connectionId,
      model: model.id,
      effort: model.defaultEffort ?? model.efforts[0],
      system,
      request,
      timeoutMs: this.deps.timeoutMs ?? 10 * 60_000,
    });

    const raw = parseDreamingOutput(text);
    const checked = raw
      ? checkDecisions(raw, {
          docs,
          messages: input.messages,
          fits: (d, ops) => proposals.fits(d, ops),
          rejected: proposals.rejectedDreaming(req.userId),
        })
      : ({ ok: false } as const);
    counts.decisions = raw?.length ?? 0;
    if (!checked.ok) counts.refused = { format: 1 };
    else counts.refused = { ...checked.refused };

    if (preview) {
      const status: DreamingRunStatus = !checked.ok
        ? "refused"
        : checked.decisions.length
          ? "proposed"
          : counts.decisions
            ? "refused"
            : "unchanged";
      counts.proposed = checked.ok ? checked.decisions.length : 0;
      if (!store.finishRun(runId, status, null, counts)) throw new Gone();
      return end(status, null, { decisions: checked.ok ? checked.decisions : [] });
    }

    // One transaction: re-checks, the bundle or the change, queue, checkpoint, the record (spec §5).
    const outcome = this.commit(
      req.userId,
      runId,
      () => {
        if (!this.deps.users.byId(req.userId)?.active) return { status: "skipped", code: "inactive" };
        // Turned off while the model was thinking: nothing is applied, proposed or moved (review #160 round 1).
        if (!store.switchedOn(req.userId)) return { status: "skipped", code: "paused" };
        let ds = checked.ok ? checked.decisions : [];
        const late = new Set<MemoryListKind>();
        // A document changed while the model was thinking: its decisions are not applied; their sources wait in the
        // queue for that document (the next run sees the new version).
        for (const d of docs) {
          const now = memory.doc(req.userId, d.kind);
          if ((now?.version ?? 0) !== d.doc.version) late.add(d.kind);
        }
        if (late.size) {
          const n = ds.filter((d) => late.has(d.doc)).length;
          if (n) counts.refused.blocked = (counts.refused.blocked ?? 0) + n;
          ds = ds.filter((d) => !late.has(d.doc));
        }
        // Sources again, right before (spec §3 / §10.3: a message deleted or edited meanwhile).
        const ok = ds.filter((d) => d.sources.every((s) => this.stillAllowed(req.userId, s)));
        if (ok.length < ds.length)
          counts.refused.source = (counts.refused.source ?? 0) + ds.length - ok.length;
        ds = ok;
        let applied = 0;
        let pending = 0;
        if (ds.length) {
          const mode = proposals.mode(req.userId);
          const base: Partial<Record<MemoryListKind, number>> = {};
          for (const d of docs) if (ds.some((x) => x.doc === d.kind)) base[d.kind] = d.doc.version;
          const r = proposals.createDreamingBundle({
            ownerId: req.userId,
            runId,
            mode,
            forced: mode === "auto" && ds.some((d) => d.suspicious) ? "suspicious" : null,
            base,
            decisions: ds.map((d) => ({
              doc: d.doc,
              action: d.action,
              itemId: d.itemId,
              mergeIds: d.mergeIds,
              text: d.text,
              before: d.before,
              sources: d.sources,
              targetSources: d.targetSources,
              auto: mode === "auto" && !d.suspicious,
            })),
          });
          applied = r.applied;
          pending = r.pending;
        }
        counts.applied = applied;
        counts.proposed = pending;
        this.moveQueue(req.userId, input, new Set([...blocked, ...late]), input.messages);
        store.advance(req.userId, Math.max(resume.checkpoint, input.lastNewSeq ?? 0), resumed);
        const status: DreamingRunStatus = pending
          ? "proposed"
          : applied
            ? "applied"
            : !checked.ok || Object.values(counts.refused).some((n) => (n ?? 0) > 0)
              ? "refused"
              : "unchanged";
        return { status, code: null };
      },
      counts,
    );
    if (outcome.status === "proposed")
      this.deps.notify?.(req.userId, "memory_proposal", counts.proposed, runId);
    if (counts.applied > 0) this.deps.notify?.(req.userId, "memory_applied", counts.applied, runId);
    return end(outcome.status, outcome.code);
  }

  /**
   * Runs `fn` and records its outcome in one transaction; an attempt already over writes nothing. The run's planned
   * expiry (spec §5: bundles whose documents changed) is written here too, first — only with an outcome. A paused or
   * inactive outcome writes nothing but the record.
   */
  private commit(
    userId: string,
    runId: string,
    fn: () => { status: DreamingRunStatus; code: string | null },
    counts: DreamingCounts,
  ): { status: DreamingRunStatus; code: string | null } {
    return this.deps.db.$client
      .transaction(() => {
        const sp = "dreaming_outcome";
        this.deps.db.$client.exec(`savepoint ${sp}`);
        this.deps.proposals.expireStaleDreaming(userId);
        const r = fn();
        if (r.code === "paused" || r.code === "inactive") this.deps.db.$client.exec(`rollback to ${sp}`);
        this.deps.db.$client.exec(`release ${sp}`);
        if (!this.deps.store.finishRun(runId, r.status, r.code, counts)) throw new Gone();
        return r;
      })
      .immediate();
  }

  /**
   * The queue after an outcome (spec §6): entries taken up and stale ones go; the new messages that went in are queued
   * for each document left out this time (a bundle waiting for review, or changed meanwhile).
   */
  private moveQueue(
    userId: string,
    input: PackedInput,
    leftOut: ReadonlySet<MemoryListKind>,
    included: PackedInput["messages"],
  ): void {
    const { store } = this.deps;
    for (const q of [...input.takenQueue, ...input.staleQueue]) store.dequeue(userId, q.messageId, q.doc);
    for (const m of included)
      for (const k of leftOut) if (!m.queued || m.docs.has(k)) store.enqueue(userId, m.source.messageId, k);
  }

  private stillAllowed(userId: string, s: { messageId: string; revision: number }): boolean {
    const r = this.deps.db.$client
      .prepare(
        `select m.revision as revision from messages m join conversations c on c.id = m.conversation_id
          where m.id = @id and ${ALLOWED}`,
      )
      .get({ id: s.messageId, u: userId }) as { revision: number } | undefined;
    return !!r && r.revision === s.revision;
  }

  /** One turn of a fresh, tool-less session; its state is forgotten right after, however it ended (spec §6). */
  private async ask(
    runtime: RuntimeId,
    a: {
      runId: string;
      userId: string;
      connectionId: string | null;
      model: string;
      effort: string | undefined;
      system: string;
      request: string;
      timeoutMs: number;
    },
  ): Promise<string> {
    const adapter = this.deps.registry.get(runtime)!;
    const abort = new AbortController();
    let session: RuntimeSession | undefined;
    let turn: RuntimeTurn | undefined;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
      void turn?.interrupt().catch(() => {});
    }, a.timeoutMs);
    timer.unref();
    let text = "";
    let limited = false;
    let startedId: string | undefined;
    try {
      session = await adapter.start({
        // Not a conversation: a one-off system task (no MCP server, no tools, nothing resumed).
        conversationId: crypto.randomUUID(),
        userId: a.userId,
        ...(a.connectionId ? { connectionId: a.connectionId } : {}),
        systemTask: "dreaming",
        signal: abort.signal,
        history: [],
        systemPrompt: a.system,
        model: a.model,
        effort: a.effort,
        tools: [],
        // Known as soon as it exists: a start that fails after this still left state to forget (review #160).
        sessionStarted: (id) => {
          startedId = id;
        },
      });
      startedId = session.externalSessionId;
      if (timedOut) throw new Failed("timeout");
      turn = session.turn({ text: a.request, model: a.model, effort: a.effort });
      for await (const ev of turn.events) {
        if (ev.type === "text_delta") {
          text += ev.text;
          if (text.length > OUTPUT_MAX) {
            await turn.interrupt().catch(() => {});
            throw new Failed("model_error");
          }
        } else if (ev.type === "usage") this.recordUsage(runtime, a, usageReport(ev));
        else if (ev.type === "limit") limited = true;
      }
    } catch (e) {
      if (e instanceof Failed) throw e;
      if (timedOut) throw new Failed("timeout");
      if (limited) throw new Failed("connection_limited");
      if (e instanceof RuntimeFailure)
        throw new Failed(
          e.code === "runtime_auth"
            ? "runtime_auth"
            : e.code === "no_connection"
              ? "no_connection"
              : "model_error",
        );
      throw new Failed("model_error");
    } finally {
      clearTimeout(timer);
      if (session) await session.close().catch(() => {});
      // The one-off session's runtime state goes, however it ended — a start that failed half-way included.
      if (startedId)
        this.deps.forgetSession?.({
          conversationId: "",
          runtime,
          connectionId: a.connectionId,
          userId: a.userId,
          externalSessionId: startedId,
        });
    }
    if (timedOut) throw new Failed("timeout");
    if (limited) throw new Failed("connection_limited");
    return text;
  }

  private recordUsage(
    runtime: RuntimeId,
    a: { runId: string; userId: string; connectionId: string | null; model: string },
    report: UsageReport,
  ): void {
    try {
      this.deps.usage?.record(
        {
          userId: a.userId,
          conversationId: null,
          runId: a.runId,
          attempt: 1,
          runtime,
          model: a.model,
          connectionId: a.connectionId,
          purpose: "dreaming",
        },
        report,
      );
    } catch (e) {
      logEvent(this.deps.log, "warn", "usage.record_failed", {
        userId: a.userId,
        runId: a.runId,
        runtime,
        attempt: 1,
        purpose: "dreaming",
        err: e,
      });
    }
  }
}
