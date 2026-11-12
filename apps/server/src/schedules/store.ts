import crypto from "node:crypto";
import type {
  ChatSettings,
  Schedule,
  ScheduleRun,
  ScheduleRunCode,
  ScheduleRunStatus,
  ScheduleTiming,
  ScheduleTrigger,
} from "@agentlee/shared";
import { isCalendarDate, SCHEDULE_RUN_CODES } from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { scrubKnown } from "../secrets/known.js";
import { CronError, isValidTimeZone, nextOccurrence } from "./time.js";

/** Why a schedule cannot be stored (400). */
export class ScheduleInputError extends Error {
  constructor(
    readonly code:
      "invalid_time_zone" | "invalid_date" | "cron_invalid" | "schedule_in_past" | "schedule_never",
  ) {
    super(code);
  }
}

export type ScheduleRow = {
  id: string;
  owner_id: string;
  name: string;
  prompt: string;
  type: ScheduleTiming["type"];
  date: string | null;
  time: string | null;
  weekdays: string | null;
  cron: string | null;
  time_zone: string;
  skills: string;
  notify: number;
  runtime: ChatSettings["runtime"];
  model: string;
  effort: string | null;
  use_shared: number;
  paused: number;
  conversation_id: string | null;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
};

export type RunRow = {
  id: string;
  schedule_id: string;
  run_key: string;
  trigger: ScheduleTrigger;
  scheduled_at: number;
  status: ScheduleRunStatus;
  attempts: number;
  retry_at: number | null;
  started_at: number | null;
  finished_at: number | null;
  outcome: "succeeded" | "failed" | null;
  error_code: string | null;
  output_ref: string | null;
  result_ref: string | null;
  result_saved_at: number | null;
  notified_at: number | null;
  created_at: number;
};

export type NewSchedule = {
  name: string;
  prompt: string;
  timing: ScheduleTiming;
  timeZone: string;
  skills: string[];
  notify: boolean;
  settings: ChatSettings;
};

/** The run key (#33): one occurrence of one schedule is one run, whoever inserts it. */
export const occurrenceKey = (scheduleId: string, scheduledAt: number) => `${scheduleId}@${scheduledAt}`;
/** "바로 실행" has keys of its own: it never takes (or is taken for) an occurrence. */
export const manualKey = (scheduleId: string, at: number) => `${scheduleId}@manual:${at}`;

export function timingOf(r: ScheduleRow): ScheduleTiming {
  switch (r.type) {
    case "once":
      return { type: "once", date: r.date!, time: r.time! };
    case "daily":
      return { type: "daily", time: r.time! };
    case "weekdays":
      return { type: "weekdays", time: r.time! };
    case "weekly":
      return { type: "weekly", time: r.time!, weekdays: JSON.parse(r.weekdays ?? "[]") as number[] };
    case "cron":
      return { type: "cron", cron: r.cron! };
  }
}

export function toSchedule(r: ScheduleRow): Schedule {
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    timing: timingOf(r),
    timeZone: r.time_zone,
    skills: JSON.parse(r.skills) as string[],
    notify: !!r.notify,
    settings: { runtime: r.runtime, model: r.model, effort: r.effort, useShared: !!r.use_shared },
    paused: !!r.paused,
    nextRunAt: r.next_run_at,
    conversationId: r.conversation_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const CODES: ReadonlySet<string> = new Set(SCHEDULE_RUN_CODES);
export const runCode = (c: string | null): ScheduleRunCode | null =>
  c === null ? null : CODES.has(c) ? (c as ScheduleRunCode) : "handler_error";

export function toRun(r: RunRow): ScheduleRun {
  return {
    id: r.id,
    trigger: r.trigger,
    status: r.status,
    scheduledAt: r.scheduled_at,
    attempts: r.attempts,
    startedAt: r.started_at,
    retryAt: r.retry_at,
    resultSavedAt: r.result_saved_at,
    finishedAt: r.finished_at,
    errorCode: runCode(r.error_code),
  };
}

/** The next occurrence after `at`; throws the 400 code when there is none. */
export function firstRunAfter(timing: ScheduleTiming, timeZone: string, at: number): number {
  if (!isValidTimeZone(timeZone)) throw new ScheduleInputError("invalid_time_zone");
  // A date that does not exist is refused, never normalised (2027-02-30 is not 2 March).
  if (timing.type === "once" && !isCalendarDate(timing.date)) throw new ScheduleInputError("invalid_date");
  let next: number | null;
  try {
    next = nextOccurrence(timing, timeZone, at);
  } catch (e) {
    if (e instanceof CronError) throw new ScheduleInputError("cron_invalid");
    throw e;
  }
  if (next === null)
    throw new ScheduleInputError(timing.type === "once" ? "schedule_in_past" : "schedule_never");
  return next;
}

/** Schedules and their runs (#33). The engine's state lives here only (rows, never memory). */
export class ScheduleStore {
  constructor(private readonly db: Db) {}

  private get sql() {
    return this.db.$client;
  }

  /** Name and prompt are user text: scrubbed of known secrets before they are stored (round 26). */
  create(ownerId: string, s: NewSchedule, at: number): ScheduleRow {
    const next = firstRunAfter(s.timing, s.timeZone, at);
    const id = crypto.randomUUID();
    const t = s.timing;
    this.sql
      .prepare(
        `insert into schedules (id, owner_id, name, prompt, type, date, time, weekdays, cron, time_zone, skills,
           notify, runtime, model, effort, use_shared, paused, next_run_at, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        id,
        ownerId,
        scrubKnown(s.name),
        scrubKnown(s.prompt),
        t.type,
        t.type === "once" ? t.date : null,
        t.type === "cron" ? null : t.time,
        t.type === "weekly" ? JSON.stringify([...new Set(t.weekdays)].sort((a, b) => a - b)) : null,
        t.type === "cron" ? t.cron.trim().split(/\s+/).join(" ") : null,
        s.timeZone,
        JSON.stringify(s.skills),
        s.notify ? 1 : 0,
        s.settings.runtime,
        s.settings.model,
        s.settings.effort,
        s.settings.useShared ? 1 : 0,
        next,
        at,
        at,
      );
    return this.byId(id)!;
  }

  byId(id: string): ScheduleRow | undefined {
    return this.sql.prepare(`select * from schedules where id = ?`).get(id) as ScheduleRow | undefined;
  }

  listFor(ownerId: string): ScheduleRow[] {
    return this.sql
      .prepare(`select * from schedules where owner_id = ? order by created_at, id`)
      .all(ownerId) as ScheduleRow[];
  }

  /**
   * Pause / resume and the notification switch. Paused: no next occurrence. Resumed: the next one after now — the
   * occurrences of the paused time are not caught up (nothing was missed: they were not wanted).
   */
  update(id: string, patch: { paused?: boolean; notify?: boolean }, at: number): ScheduleRow | undefined {
    const row = this.byId(id);
    if (!row) return undefined;
    let next = row.next_run_at;
    const paused = patch.paused ?? !!row.paused;
    if (paused) next = null;
    else if (row.paused) next = nextOccurrence(timingOf(row), row.time_zone, at);
    this.sql
      .prepare(`update schedules set paused = ?, notify = ?, next_run_at = ?, updated_at = ? where id = ?`)
      .run(paused ? 1 : 0, (patch.notify ?? !!row.notify) ? 1 : 0, next, at, id);
    return this.byId(id);
  }

  delete(id: string): void {
    this.sql.prepare(`delete from schedules where id = ?`).run(id);
  }

  setConversation(id: string, conversationId: string): void {
    this.sql.prepare(`update schedules set conversation_id = ? where id = ?`).run(conversationId, id);
  }

  runs(scheduleId: string, limit = 50): RunRow[] {
    return this.sql
      .prepare(
        `select * from schedule_runs where schedule_id = ? order by scheduled_at desc, created_at desc limit ?`,
      )
      .all(scheduleId, limit) as RunRow[];
  }

  run(id: string): RunRow | undefined {
    return this.sql.prepare(`select * from schedule_runs where id = ?`).get(id) as RunRow | undefined;
  }

  // ---- the engine's operations ----

  /** Active schedules whose next occurrence has come. */
  due(at: number): ScheduleRow[] {
    return this.sql
      .prepare(`select * from schedules where paused = 0 and next_run_at is not null and next_run_at <= ?`)
      .all(at) as ScheduleRow[];
  }

  /** The earliest time anything is due: an occurrence or a retry. */
  nextWake(): number | null {
    const r = this.sql
      .prepare(
        `select min(t) as t from (
           select min(next_run_at) as t from schedules where paused = 0 and next_run_at is not null
           union all select min(coalesce(retry_at, 0)) from schedule_runs where status = 'pending')`,
      )
      .get() as { t: number | null };
    return r.t;
  }

  /** A run of this schedule that has not finished (running, or waiting for its start or its retry). */
  busy(scheduleId: string, except?: string): boolean {
    return !!this.sql
      .prepare(
        `select 1 from schedule_runs where schedule_id = ? and status in ('pending', 'running') and id != ? limit 1`,
      )
      .get(scheduleId, except ?? "");
  }

  /**
   * One occurrence becomes one run (the unique run key: a second insert of the same key does nothing) — pending,
   * or skipped as `overlap` when the schedule's previous run is not finished (FR-8.7 건너뜀) — and the schedule moves
   * on to its next occurrence after it. One transaction: a crash leaves either both or neither.
   */
  takeOccurrence(
    s: ScheduleRow,
    scheduledAt: number,
    trigger: ScheduleTrigger,
    next: number | null,
    at: number,
  ): RunRow | undefined {
    return this.sql.transaction(() => {
      const skip = this.busy(s.id);
      const id = crypto.randomUUID();
      const inserted = this.sql
        .prepare(
          `insert into schedule_runs (id, schedule_id, run_key, trigger, scheduled_at, status, error_code,
             finished_at, created_at)
           values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict (run_key) do nothing`,
        )
        .run(
          id,
          s.id,
          occurrenceKey(s.id, scheduledAt),
          trigger,
          scheduledAt,
          skip ? "skipped" : "pending",
          skip ? "overlap" : null,
          skip ? at : null,
          at,
        ).changes;
      this.sql
        .prepare(
          `update schedules set next_run_at = ? where id = ? and next_run_at is not null and next_run_at <= ?`,
        )
        .run(next, s.id, scheduledAt);
      return inserted ? this.run(id) : undefined;
    })();
  }

  /** "바로 실행": its own run key; refused (undefined) while a run of the schedule is not finished. */
  manual(scheduleId: string, at: number): RunRow | undefined {
    return this.sql.transaction(() => {
      if (this.busy(scheduleId)) return undefined;
      const id = crypto.randomUUID();
      const inserted = this.sql
        .prepare(
          `insert into schedule_runs (id, schedule_id, run_key, trigger, scheduled_at, status, created_at)
           values (?, ?, ?, 'manual', ?, 'pending', ?) on conflict (run_key) do nothing`,
        )
        .run(id, scheduleId, manualKey(scheduleId, at), at, at).changes;
      return inserted ? this.run(id) : undefined;
    })();
  }

  /** Runs to work on now: pending ones whose time has come, and running ones past their execute step. */
  workable(at: number): RunRow[] {
    return this.sql
      .prepare(
        `select * from schedule_runs where (status = 'pending' and coalesce(retry_at, 0) <= ?)
           or (status = 'running' and outcome is not null) order by scheduled_at, created_at`,
      )
      .all(at) as RunRow[];
  }

  /** pending → running, one more attempt. False when someone else took it (or it is gone). */
  claim(id: string, at: number): boolean {
    return (
      this.sql
        .prepare(
          `update schedule_runs set status = 'running', attempts = attempts + 1, started_at = ?, retry_at = null
           where id = ? and status = 'pending'`,
        )
        .run(at, id).changes === 1
    );
  }

  /** A failed attempt with a retry left: back to pending until `retryAt`. */
  retryLater(id: string, code: string, retryAt: number): void {
    this.sql
      .prepare(
        `update schedule_runs set status = 'pending', retry_at = ?, error_code = ? where id = ? and status = 'running'`,
      )
      .run(retryAt, code, id);
  }

  /** The execute step's result (before the result is saved). */
  setOutcome(
    id: string,
    outcome: "succeeded" | "failed",
    code: string | null,
    outputRef: string | null,
  ): void {
    this.sql
      .prepare(
        `update schedule_runs set outcome = ?, error_code = ?, output_ref = ? where id = ? and status = 'running'`,
      )
      .run(outcome, code, outputRef, id);
  }

  resultSaved(id: string, ref: string | null, at: number): void {
    this.sql
      .prepare(
        `update schedule_runs set result_ref = ?, result_saved_at = ? where id = ? and status = 'running'`,
      )
      .run(ref, at, id);
  }

  notified(id: string, at: number): void {
    this.sql
      .prepare(`update schedule_runs set notified_at = ? where id = ? and status = 'running'`)
      .run(at, id);
  }

  finish(id: string, at: number): void {
    this.sql
      .prepare(
        `update schedule_runs set status = outcome, finished_at = ? where id = ? and status = 'running'
           and outcome is not null`,
      )
      .run(at, id);
  }

  /**
   * Server start: runs a previous process left behind.
   * - running without an outcome (the process died while executing): that start counts as an attempt (FR-8.6 —
   *   one retry in all); a retry is left → pending, 2 minutes on; none → failed `interrupted` (its result and
   *   notification steps still follow).
   * - pending (never started, or waiting for its retry — one just recovered above included) while a newer
   *   occurrence of the schedule is already due: replaced by the newest (only the most recent missed occurrence
   *   runs, FR-8.7) → skipped `superseded`.
   * Running rows past their execute step are left: the engine resumes them after their last finished step.
   */
  recover(
    at: number,
    retryMs: number,
    maxAttempts: number,
  ): { retried: number; failed: number; superseded: number } {
    return this.sql.transaction(() => {
      const retried = this.sql
        .prepare(
          `update schedule_runs set status = 'pending', retry_at = ?, error_code = 'interrupted'
           where status = 'running' and outcome is null and attempts < ?`,
        )
        .run(at + retryMs, maxAttempts).changes;
      const failed = this.sql
        .prepare(
          `update schedule_runs set outcome = 'failed', error_code = 'interrupted'
           where status = 'running' and outcome is null`,
        )
        .run().changes;
      const superseded = this.sql
        .prepare(
          `update schedule_runs set status = 'skipped', error_code = 'superseded', finished_at = ?
           where status = 'pending' and trigger != 'manual' and schedule_id in
             (select id from schedules where paused = 0 and next_run_at is not null and next_run_at <= ?)`,
        )
        .run(at, at).changes;
      return { retried, failed, superseded };
    })();
  }
}
