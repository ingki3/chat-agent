import { DREAMING_STAGGER_MIN, DREAMING_TIME_ZONE } from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { logEvent, type EventLogger } from "../logging.js";
import { localDay, resolveLocal } from "../schedules/time.js";
import type { DreamingRunner, RunResult } from "./runner.js";
import type { DayRow, DreamingStore } from "./store.js";

/**
 * The 기억 정리 schedule (#146, docs/memory-spec.md §6·§9): one in-process timer over persistent rounds.
 *
 * - **When**: the admin's HH:MM in Asia/Seoul, each user (in user id order among those it runs for) 5 minutes after
 *   the one before. A regular round starts within a minute of its time (AC-14) — the timer wakes for it.
 * - **Not now**: an answer of that user still running → again in 10 minutes, at most 6 times (then the day is
 *   skipped). The server was off at the time → one catch-up round after the start, the same day. Past midnight that
 *   day has no round any more. Turned on after its time that day → none that day.
 * - **Failure** (no connection, expired, limit, model error, time-out): nothing moves; tried once more 30 minutes
 *   later, then the next day. The admins are told once, only when the day's last attempt of every user is over and
 *   some failed — how many users, no names or content.
 * - **Once**: a round per user and day (`dreaming_days`) and an attempt per key (`dreaming:<user>:<date>:<attempt>`);
 *   a restart fails what was running (no double apply — the run's outcome is written in the same transaction as its
 *   changes, only while it is still running) and waits for the retry.
 * - **Pause** (spec §7·§9): turned off, the user deactivated, or the chosen connection gone (the admin screen says
 *   "연결을 다시 고르세요") — no round, nothing failed; on resume a backlog older than 7 days is passed over.
 */

export const DREAMING_RETRY_MS = 30 * 60_000;
export const DREAMING_BUSY_MS = 10 * 60_000;
export const DREAMING_MAX_BUSY = 6;
export const DREAMING_MAX_ATTEMPTS = 2;
/** Started later than this after its time: a catch-up round, not a regular one. */
export const DREAMING_LATE_MS = 60_000;

export type DreamingEngineDeps = {
  db: Db;
  store: DreamingStore;
  runner: Pick<DreamingRunner, "run" | "connectionProblem">;
  /** Whether the user has an answer running (any of their conversations). */
  busy?: (userId: string) => boolean;
  /** The day's last attempt failed for `users` users: tell the admins (once per date — the caller dedupes). */
  alert?: (date: string, users: number, tooLarge: number) => void;
  now?: () => number;
  log?: EventLogger | undefined;
  /** Whether this process still holds the data folder (#37): false → no new round. */
  owned?: () => boolean;
  maxSleepMs?: number;
};

const DAY = 86_400_000;
export const dateOfDay = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);
export const dreamingDate = (at: number) => dateOfDay(localDay(at, DREAMING_TIME_ZONE));
const minuteOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const hhmm = (minute: number) => {
  const m = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

export class DreamingEngine {
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private stopped = false;
  /** When this process started the schedule: a time passed before it was missed while the server was off. */
  private startedAt = 0;
  private readonly active = new Map<string, Promise<void>>();
  private readonly now: () => number;

  constructor(private readonly deps: DreamingEngineDeps) {
    this.now = deps.now ?? Date.now;
  }

  get running(): boolean {
    return this.started && !this.stopped;
  }

  start(): void {
    if (this.started || this.stopped) return;
    if (this.deps.owned && !this.deps.owned()) {
      this.stopped = true;
      return;
    }
    this.started = true;
    this.startedAt = this.now();
    this.deps.store.recover(this.now() + DREAMING_RETRY_MS, DREAMING_MAX_ATTEMPTS);
    this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    await Promise.allSettled([...this.active.values()]);
  }

  /** Resolves when no round is in progress (tests). */
  async idle(): Promise<void> {
    while (this.active.size) await Promise.allSettled([...this.active.values()]);
  }

  /** Looks again soon (settings changed). */
  kick(): void {
    if (this.running) this.arm(0);
  }

  /** Users the rounds are for, in user id order, with their start time today (Asia/Seoul). */
  slots(at = this.now()): { userId: string; at: number; time: string }[] {
    const cfg = this.deps.store.config();
    const day = localDay(at, DREAMING_TIME_ZONE);
    const base = minuteOf(cfg.time);
    return this.eligible().map((userId, i) => {
      const minute = base + DREAMING_STAGGER_MIN * i;
      return { userId, at: resolveLocal(day, minute, DREAMING_TIME_ZONE), time: hhmm(minute) };
    });
  }

  /** Active users whose switch is on, in user id order. */
  private eligible(): string[] {
    return (
      this.deps.db.$client
        .prepare(
          `select u.id as id from users u left join dreaming_users d on d.user_id = u.id
            where u.active = 1 and coalesce(d.enabled, 1) = 1 order by u.id`,
        )
        .all() as { id: string }[]
    ).map((r) => r.id);
  }

  /** Users whose rounds are switched on but who are not active (paused, spec §9). */
  private inactiveOn(): string[] {
    return (
      this.deps.db.$client
        .prepare(
          `select u.id as id from users u left join dreaming_users d on d.user_id = u.id
            where u.active = 0 and coalesce(d.enabled, 1) = 1`,
        )
        .all() as { id: string }[]
    ).map((r) => r.id);
  }

  private arm(delay?: number): void {
    if (!this.running) return;
    clearTimeout(this.timer);
    const now = this.now();
    let wake: number | null = this.deps.store.nextWaiting();
    const cfg = this.deps.store.config();
    if (cfg.enabled) {
      const today = dreamingDate(now);
      for (const s of this.slots(now))
        if (s.at > now && !this.deps.store.day(s.userId, today))
          wake = wake === null ? s.at : Math.min(wake, s.at);
    }
    const max = this.deps.maxSleepMs ?? 30_000;
    const ms = delay ?? (wake === null ? max : Math.max(0, wake - now));
    this.timer = setTimeout(() => this.tick(), Math.min(ms, max));
    this.timer.unref();
  }

  /** One look at what is due (exported for tests with a fake clock). */
  tick(): void {
    this.timer = undefined;
    if (!this.running) return;
    if (this.deps.owned && !this.deps.owned()) {
      void this.stop();
      return;
    }
    try {
      this.plan();
    } catch (e) {
      logEvent(this.deps.log, "error", "dreaming.run_finished", { dreamingStatus: "failed", err: e });
    }
    this.arm();
  }

  private plan(): void {
    const { store } = this.deps;
    const now = this.now();
    const today = dreamingDate(now);
    // Past midnight: an earlier day's round that did not start (a retry, a busy wait) is dropped (spec §6).
    store.expireBefore(today);
    const cfg = store.config();
    for (const u of this.inactiveOn()) store.markPaused(u);
    if (!cfg.enabled) {
      store.pauseWaiting();
      return;
    }
    // The chosen connection is gone: paused — the admin screen says so (spec §7), nothing fails.
    if (this.deps.runner.connectionProblem()) return;
    for (const s of this.slots(now)) {
      if (now < s.at || store.day(s.userId, today)) continue;
      const late = now - s.at;
      if (late <= DREAMING_LATE_MS || s.at < this.startedAt)
        store.insertDay({
          user_id: s.userId,
          date: today,
          state: "waiting",
          trigger: late <= DREAMING_LATE_MS ? "regular" : "catchup",
          scheduled_at: s.at,
          next_at: now,
        });
      // Its time passed while the round could not start (turned on later that day): none today.
      else
        store.insertDay({
          user_id: s.userId,
          date: today,
          state: "missed",
          trigger: "regular",
          scheduled_at: s.at,
          next_at: s.at,
        });
    }
    for (const d of store.dueDays(now)) {
      if (d.date !== today || this.active.has(d.user_id)) continue;
      this.dispatch(d);
    }
    this.checkAlert(today);
  }

  private dispatch(d: DayRow): void {
    const { store } = this.deps;
    const now = this.now();
    // Turned off (for everyone or this user) or deactivated since the round was planned — a retry included: paused,
    // nothing runs and nothing moves (review #160 round 1).
    if (!store.switchedOn(d.user_id)) {
      store.updateDay(d.user_id, d.date, { state: "paused" }, "waiting");
      store.markPaused(d.user_id);
      return;
    }
    if (this.deps.busy?.(d.user_id)) {
      if (d.deferrals < DREAMING_MAX_BUSY)
        store.updateDay(
          d.user_id,
          d.date,
          { deferrals: d.deferrals + 1, next_at: now + DREAMING_BUSY_MS },
          "waiting",
        );
      else this.skipBusy(d);
      return;
    }
    const attempt = d.attempts + 1;
    // Claimed before anything runs: the attempt counts even if the server dies in it.
    if (!store.updateDay(d.user_id, d.date, { state: "running", attempts: attempt }, "waiting")) return;
    const work = this.deps.runner
      .run({
        userId: d.user_id,
        date: d.date,
        attempt,
        trigger: attempt > 1 ? "retry" : d.trigger,
        idemKey: `dreaming:${d.user_id}:${d.date}:${attempt}`,
      })
      .then((r) => this.settle(d, attempt, r))
      .catch((e: unknown) => {
        logEvent(this.deps.log, "error", "dreaming.run_finished", {
          userId: d.user_id,
          dreamingStatus: "failed",
          err: e,
        });
        this.settle(d, attempt, undefined);
      })
      .finally(() => {
        this.active.delete(d.user_id);
        if (this.running) this.arm(0);
      });
    this.active.set(d.user_id, work);
  }

  private skipBusy(d: DayRow): void {
    const { store } = this.deps;
    store.updateDay(d.user_id, d.date, { state: "skipped" }, "waiting");
    void this.deps.runner.run({
      userId: d.user_id,
      date: d.date,
      attempt: 0,
      trigger: d.trigger,
      idemKey: `dreaming:${d.user_id}:${d.date}:busy`,
      skip: "busy",
    });
  }

  private settle(d: DayRow, attempt: number, r: RunResult | undefined): void {
    if (this.stopped && !r) return; // shutdown: the start-up recovery takes it from here
    const { store } = this.deps;
    const failed = !r || r.status === "failed";
    if (failed && r?.code === "interrupted") return;
    if (failed && attempt < DREAMING_MAX_ATTEMPTS)
      store.updateDay(
        d.user_id,
        d.date,
        { state: "waiting", next_at: this.now() + DREAMING_RETRY_MS },
        "running",
      );
    else
      store.updateDay(
        d.user_id,
        d.date,
        {
          state: failed
            ? "failed"
            : r!.code === "paused"
              ? "paused"
              : r!.status === "skipped"
                ? "skipped"
                : "done",
        },
        "running",
      );
    this.checkAlert(d.date);
  }

  /**
   * The admins' alert (spec §6·§8): once the day's round of every user it runs for is over (no slot to come, nothing
   * waiting or running) and some ended failed. The caller dedupes per date, so a restart never sends it twice.
   */
  private checkAlert(date: string): void {
    if (!this.deps.alert) return;
    const days = this.deps.store.days(date);
    if (!days.some((d) => d.state === "failed")) return;
    if (days.some((d) => d.state === "waiting" || d.state === "running")) return;
    if (date === dreamingDate(this.now())) {
      const have = new Set(days.map((d) => d.user_id));
      if (this.slots().some((s) => !have.has(s.userId))) return;
    }
    const n = days.filter((d) => d.state === "failed").length;
    const tooLarge = days.filter(
      (d) => d.state === "failed" && this.deps.store.lastRunOn(d.user_id, date)?.code === "too_large",
    ).length;
    this.deps.alert(date, n, tooLarge);
  }

  /** Today's round state and start time of each user (the admin's status table). */
  status(userId: string): { time: string | null; today: string | null } {
    const s = this.slots().find((x) => x.userId === userId);
    const day = this.deps.store.day(userId, dreamingDate(this.now()));
    return { time: s?.time ?? null, today: day?.state ?? null };
  }
}
