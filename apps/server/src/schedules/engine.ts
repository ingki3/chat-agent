import type { Schedule, ScheduleRunCode, ScheduleTrigger } from "@agentlee/shared";
import { logEvent, type EventLogger } from "../logging.js";
import { runCode, timingOf, toSchedule, type RunRow, type ScheduleStore } from "./store.js";
import { latestOccurrence, nextOccurrence } from "./time.js";

/** FR-8.6: a failed run is tried again once, this long after the failure. */
export const RETRY_MS = 2 * 60_000;
/** Starts in all, the retry included (a start the server died in counts too). */
export const MAX_ATTEMPTS = 2;
/** An occurrence taken more than this after its time is the missed catch-up, not a regular start. */
export const LATE_MS = 60_000;

/** What a handler step sees. The same `runId` on every call for one run (resumed steps too). */
export type ScheduleRunContext = {
  runId: string;
  runKey: string;
  scheduleId: string;
  ownerId: string;
  schedule: Schedule;
  scheduledAt: number;
  trigger: ScheduleTrigger;
  /** 1 for the first start, 2 for the retry. */
  attempt: number;
  /** Aborted when the server stops. */
  signal: AbortSignal;
};

export type ExecuteOutcome =
  { ok: true; outputRef?: string | null } | { ok: false; code: ScheduleRunCode; outputRef?: string | null };
export type RunOutcome = {
  status: "succeeded" | "failed";
  code: ScheduleRunCode | null;
  outputRef: string | null;
};

/**
 * What runs a schedule (#33 contract; the real one — a runtime run in the schedule's conversation — is #56).
 * Three explicit steps; the engine records each one's end in the run row, so a restart resumes after the last
 * recorded step and never repeats an earlier one:
 * 1. `execute` — once per attempt. A failure with a retry left is retried 2 minutes later; the result and the
 *    notification come only from the last attempt.
 * 2. `saveResult` — stores the result (or the failure reason) for the user. **Idempotent per `runId`**: a crash
 *    after it stored but before the engine recorded it calls it again, and it must not store twice.
 * 3. `notify` — publishes the notification (skipped when the schedule's notification is off). **Idempotent per
 *    `runId`** in the same way.
 * Throwing from `execute` is a failure (`handler_error`); throwing from the other two leaves the run where it is
 * and the step is tried again later (2 minutes, or the next start).
 */
export interface ScheduleHandler {
  execute(ctx: ScheduleRunContext): Promise<ExecuteOutcome>;
  saveResult(ctx: ScheduleRunContext, outcome: RunOutcome): Promise<{ resultRef: string | null }>;
  notify(ctx: ScheduleRunContext, outcome: RunOutcome, saved: { resultRef: string | null }): Promise<void>;
}

export type ScheduleEngineOptions = {
  now?: () => number;
  retryMs?: number;
  /** The timer never sleeps longer than this (drift, a sleeping Mac, a clock change): it wakes and looks again. */
  maxSleepMs?: number;
  /** `stop()` waits this long for runs in progress (they are aborted); the rest are recovered at the next start. */
  stopGraceMs?: number;
  log?: EventLogger;
  /** Whether this process still holds the data folder (the data lock, #37). False → the engine stops. */
  owned?: () => boolean;
};

const REF = /^[A-Za-z0-9._:@-]{1,128}$/;
const ref = (v: string | null | undefined) => (typeof v === "string" && REF.test(v) ? v : null);

/**
 * The schedule engine (#33, PRD FR-8.6·8.7, AC-5): one in-process timer over persistent state. Every occurrence is
 * a row with a unique run key before anything runs, so a restart, a second timer or a late wake-up can never run an
 * occurrence twice. After the server was off, each schedule runs only its most recent missed occurrence (once).
 */
export class ScheduleEngine {
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private stopped = false;
  private readonly active = new Map<string, { work: Promise<void>; abort: AbortController }>();
  /** Runs whose save / notify step failed: not before this time (in memory; a restart tries at once). */
  private readonly backoff = new Map<string, number>();
  private readonly now: () => number;
  private readonly retryMs: number;
  private readonly maxSleepMs: number;

  constructor(
    private readonly store: ScheduleStore,
    private readonly handler: ScheduleHandler,
    private readonly opts: ScheduleEngineOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.retryMs = opts.retryMs ?? RETRY_MS;
    this.maxSleepMs = opts.maxSleepMs ?? 60_000;
  }

  get running(): boolean {
    return this.started && !this.stopped;
  }

  /** Recovers what a previous process left, then takes what is due (the missed catch-up) and arms the timer. */
  start(): void {
    if (this.started || this.stopped) return;
    if (this.opts.owned && !this.opts.owned()) {
      logEvent(this.opts.log, "warn", "schedule.engine_stopped", { scheduleCode: "storage_not_owned" });
      this.stopped = true;
      return;
    }
    this.started = true;
    const r = this.store.recover(this.now(), this.retryMs, MAX_ATTEMPTS);
    if (r.retried + r.failed + r.superseded)
      logEvent(this.opts.log, "warn", "schedule.recovered", { count: r.retried + r.failed + r.superseded });
    this.tick();
  }

  /** Looks again soon (a new or resumed schedule, "바로 실행"). */
  kick(): void {
    if (!this.running) return;
    this.arm(0);
  }

  /** No new run after this; runs in progress are aborted and waited for (up to `stopGraceMs`). */
  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    const works = [...this.active.values()];
    for (const a of works) a.abort.abort();
    const grace = this.opts.stopGraceMs ?? 5000;
    if (!works.length || grace <= 0) return;
    await Promise.race([
      Promise.allSettled(works.map((a) => a.work)),
      new Promise<void>((r) => setTimeout(r, grace).unref()),
    ]);
  }

  /** Resolves when no run is in progress (tests). */
  async idle(): Promise<void> {
    while (this.active.size) await Promise.allSettled([...this.active.values()].map((a) => a.work));
  }

  private arm(delay?: number): void {
    if (!this.running) return;
    clearTimeout(this.timer);
    const now = this.now();
    let wake = this.store.nextWake();
    for (const t of this.backoff.values()) wake = wake === null ? t : Math.min(wake, t);
    let ms = delay ?? (wake === null ? this.maxSleepMs : wake - now);
    // Something due that could not be taken (it is being worked on, or failed): look again a little later.
    if (delay === undefined && ms <= 0) ms = 1000;
    this.timer = setTimeout(() => this.tick(), Math.min(Math.max(0, ms), this.maxSleepMs));
    this.timer.unref();
  }

  private tick(): void {
    this.timer = undefined;
    if (!this.running) return;
    if (this.opts.owned && !this.opts.owned()) {
      logEvent(this.opts.log, "warn", "schedule.engine_stopped", { scheduleCode: "storage_not_owned" });
      void this.stop();
      return;
    }
    const now = this.now();
    for (const s of this.store.due(now)) {
      try {
        const timing = timingOf(s);
        // The most recent occurrence that has come — the only one of several missed ones that runs (FR-8.7).
        const due = latestOccurrence(timing, s.time_zone, now, s.next_run_at!) ?? s.next_run_at!;
        const trigger: ScheduleTrigger = now - due > LATE_MS ? "missed" : "regular";
        const run = this.store.takeOccurrence(s, due, trigger, nextOccurrence(timing, s.time_zone, due), now);
        if (run?.status === "skipped")
          logEvent(this.opts.log, "info", "schedule.run_skipped", {
            scheduleId: s.id,
            runId: run.id,
            scheduleTrigger: trigger,
            scheduleCode: "overlap",
          });
      } catch (e) {
        logEvent(this.opts.log, "error", "schedule.run_skipped", {
          scheduleId: s.id,
          scheduleCode: "schedule_invalid",
          err: e,
        });
      }
    }
    for (const r of this.store.workable(now)) {
      if (this.active.has(r.id) || (this.backoff.get(r.id) ?? 0) > now) continue;
      this.dispatch(r);
    }
    this.arm();
  }

  private context(r: RunRow, attempt: number, signal: AbortSignal): ScheduleRunContext | undefined {
    const s = this.store.byId(r.schedule_id);
    if (!s) return undefined;
    return {
      runId: r.id,
      runKey: r.run_key,
      scheduleId: s.id,
      ownerId: s.owner_id,
      schedule: toSchedule(s),
      scheduledAt: r.scheduled_at,
      trigger: r.trigger,
      attempt,
      signal,
    };
  }

  private dispatch(r: RunRow): void {
    const abort = new AbortController();
    const fresh = r.status === "pending";
    const attempt = fresh ? r.attempts + 1 : r.attempts;
    const ctx = this.context(r, attempt, abort.signal);
    if (!ctx) return;
    if (fresh) {
      const at = this.now();
      // Claimed before anything runs: the start is on disk (a crash from here on counts as this attempt).
      if (!this.store.claim(r.id, at)) return;
      logEvent(this.opts.log, "info", "schedule.run_started", {
        scheduleId: r.schedule_id,
        runId: r.id,
        scheduleTrigger: r.trigger,
        attempt,
        lateMs: at - (r.retry_at ?? r.scheduled_at),
      });
    }
    const work = this.work(r.id, ctx, fresh)
      .catch((e: unknown) =>
        logEvent(this.opts.log, "error", "schedule.step_failed", {
          runId: r.id,
          scheduleStep: "engine",
          err: e,
        }),
      )
      .finally(() => {
        this.active.delete(r.id);
        this.arm();
      });
    this.active.set(r.id, { work, abort });
  }

  private stepFailed(runId: string, step: "save" | "notify", e: unknown): void {
    this.backoff.set(runId, this.now() + this.retryMs);
    logEvent(this.opts.log, "warn", "schedule.step_failed", { runId, scheduleStep: step, err: e });
  }

  /**
   * Whether this process may still touch the run: not stopped, and still holding the data folder (#33 review 1).
   * Checked before every step and after every await — a step that returns after shutdown or a lost lock records
   * nothing and starts no further step; the row stays as it was and the next start resumes it.
   */
  private alive(): boolean {
    if (this.stopped) return false;
    if (this.opts.owned && !this.opts.owned()) {
      logEvent(this.opts.log, "warn", "schedule.engine_stopped", { scheduleCode: "storage_not_owned" });
      void this.stop();
      return false;
    }
    return true;
  }

  private async work(id: string, ctx: ScheduleRunContext, fresh: boolean): Promise<void> {
    if (!this.alive()) return;
    if (fresh) {
      let ex: ExecuteOutcome;
      try {
        ex = await this.handler.execute(ctx);
      } catch {
        ex = { ok: false, code: "handler_error" };
      }
      // Stopped meanwhile: nothing is recorded — the next start sees a start without an outcome (an attempt).
      if (!this.alive()) return;
      const code = ex.ok ? null : (runCode(ex.code) ?? "handler_error");
      if (!ex.ok && ctx.attempt < MAX_ATTEMPTS) {
        this.store.retryLater(id, code!, this.now() + this.retryMs);
        logEvent(this.opts.log, "warn", "schedule.run_finished", {
          scheduleId: ctx.scheduleId,
          runId: id,
          attempt: ctx.attempt,
          scheduleCode: code!,
          scheduleStatus: "retrying",
        });
        return;
      }
      this.store.setOutcome(id, ex.ok ? "succeeded" : "failed", code, ref(ex.outputRef));
    }
    const row = this.store.run(id);
    if (!row || row.status !== "running" || !row.outcome) return;
    const outcome: RunOutcome = {
      status: row.outcome,
      code: runCode(row.error_code),
      outputRef: row.output_ref,
    };
    let resultRef = row.result_ref;
    if (row.result_saved_at === null) {
      if (!this.alive()) return;
      try {
        resultRef = ref((await this.handler.saveResult(ctx, outcome)).resultRef);
      } catch (e) {
        if (!this.alive()) return;
        return this.stepFailed(id, "save", e);
      }
      if (!this.alive()) return;
      this.store.resultSaved(id, resultRef, this.now());
    }
    if (row.notified_at === null) {
      if (!this.alive()) return;
      // The switch as it is now (it may have been turned off since the run started).
      if (this.store.byId(ctx.scheduleId)?.notify)
        try {
          await this.handler.notify(ctx, outcome, { resultRef });
        } catch (e) {
          if (!this.alive()) return;
          return this.stepFailed(id, "notify", e);
        }
      if (!this.alive()) return;
      this.store.notified(id, this.now());
    }
    if (!this.alive()) return;
    this.backoff.delete(id);
    this.store.finish(id, this.now());
    logEvent(this.opts.log, outcome.status === "succeeded" ? "info" : "warn", "schedule.run_finished", {
      scheduleId: ctx.scheduleId,
      runId: id,
      attempt: ctx.attempt,
      scheduleCode: outcome.code ?? "schedule_ok",
      scheduleStatus: outcome.status,
    });
  }
}
