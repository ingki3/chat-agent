import { DREAMING_CONCURRENCY, DREAMING_TIME_ZONE, type DreamingChoice } from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { logEvent, type EventLogger } from "../logging.js";
import { localDay, resolveLocal } from "../schedules/time.js";
import type { DreamingRunner, RunResult } from "./runner.js";
import type { DayRow, DreamingStore } from "./store.js";

/**
 * The 기억 정리 schedule (#146, #188, docs/memory-spec.md §6·§9): one in-process timer over persistent rounds.
 *
 * - **When**: each user's own HH:MM in Asia/Seoul. A regular round is due at its time — the timer wakes for it — and
 *   starts within a minute (AC-14) while fewer than `DREAMING_CONCURRENCY` rounds run; users sharing a time beyond
 *   that start one after another as the running ones end (due time, then user id order), still as regular rounds.
 * - **Not now**: an answer of that user still running → again in 10 minutes, at most 6 times (then the day is
 *   skipped). The server was off at the time → one catch-up round after the start, the same day. Past midnight that
 *   day has no round any more. Turned on after its time that day → none that day.
 * - **Failure** (no connection, expired, limit, model error, time-out): nothing moves; tried once more 30 minutes
 *   later, then the next day. The user is told once when the day's last attempt failed (a fixed reason, no content).
 * - **Once**: a round per user and day (`dreaming_days`) and an attempt per key (`dreaming:<user>:<date>:<attempt>`);
 *   a restart fails what was running (no double apply — the run's outcome is written in the same transaction as its
 *   changes, only while it is still running) and waits for the retry.
 * - **Pause** (spec §7·§9): turned off (server-wide or by the user), the user deactivated, or the user's chosen pair
 *   no longer usable (deleted, disconnected, not allowed any more — "다시 고르세요") — no round, nothing failed; on
 *   resume a backlog older than 7 days is passed over. An allowed shared connection deleted or disconnected while
 *   users chose it is the server's setup broken: the admins are told once a day (how many users, no names).
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
  runner: Pick<DreamingRunner, "run" | "problemOf" | "choiceProblem" | "canStart"> &
    Partial<Pick<DreamingRunner, "onRelease">>;
  /** Whether the user has an answer running (any of their conversations). */
  busy?: (userId: string) => boolean;
  /** The user's round of `date` failed at its last attempt (`code`): tell them (once — the caller dedupes too). */
  failed?: (userId: string, date: string, code: string | null) => void;
  /** Allowed shared connections are gone while `users` users chose them: tell the admins (once per date). */
  alert?: (date: string, users: number) => void;
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

export class DreamingEngine {
  private timer: NodeJS.Timeout | undefined;
  private started = false;
  private stopped = false;
  /** When this process started the schedule: a time passed before it was missed while the server was off. */
  private startedAt = 0;
  private readonly active = new Map<string, Promise<void>>();
  /** Failure notices and admin alerts already handed to the caller by this process (`<user>:<date>`, `<date>`). */
  private readonly told = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: DreamingEngineDeps) {
    this.now = deps.now ?? Date.now;
    // A slot freed by any run (미리 실행, 지금 실행 included): look again at the rounds waiting for one.
    deps.runner.onRelease?.(() => this.kick());
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
    const day = localDay(at, DREAMING_TIME_ZONE);
    return this.eligible()
      .filter((u) => this.deps.runner.problemOf(u.id) === null)
      .map((u) => ({
        userId: u.id,
        at: resolveLocal(day, minuteOf(u.time), DREAMING_TIME_ZONE),
        time: u.time,
      }));
  }

  /** Active users whose own switch is on (no row = off), in user id order. */
  private eligible(): { id: string; time: string }[] {
    return this.deps.db.$client
      .prepare(
        `select u.id as id, d.time as time from users u join dreaming_users d on d.user_id = u.id
          where u.active = 1 and d.enabled = 1 order by u.id`,
      )
      .all() as { id: string; time: string }[];
  }

  /** Users whose rounds are switched on but who are not active (paused, spec §9). */
  private inactiveOn(): string[] {
    return (
      this.deps.db.$client
        .prepare(
          `select u.id as id from users u join dreaming_users d on d.user_id = u.id
            where u.active = 0 and d.enabled = 1`,
        )
        .all() as { id: string }[]
    ).map((r) => r.id);
  }

  private arm(delay?: number): void {
    if (!this.running) return;
    clearTimeout(this.timer);
    const now = this.now();
    // A round due but not started (all slots busy, its pair unusable) is looked at again when a run ends (arm(0)),
    // when settings change (kick) or at the longest sleep — never in a tight loop.
    let wake: number | null = this.deps.store.nextWaiting(now);
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
    this.checkSetup(today, cfg.allowed);
    // A user whose chosen pair is unusable has no slot: paused — their screen says "다시 고르세요", nothing fails.
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
    // Due rounds in order (due time, then user id), in the runner's slots shared with 미리 실행 and 지금 실행 (at
    // most DREAMING_CONCURRENCY at once, one per user); the rest wait their turn.
    for (const d of store.dueDays(now)) {
      if (this.active.size >= DREAMING_CONCURRENCY) break;
      if (d.date !== today || this.active.has(d.user_id)) continue;
      if (!this.deps.runner.canStart(d.user_id)) continue;
      if (this.deps.runner.problemOf(d.user_id)) continue;
      this.dispatch(d);
    }
    this.notifyFailed(today);
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
    this.notifyFailed(d.date);
  }

  /** The user's notice (spec §8): their round of `date` ended failed — once per user and date. */
  private notifyFailed(date: string): void {
    if (!this.deps.failed) return;
    for (const d of this.deps.store.days(date)) {
      if (d.state !== "failed" || this.told.has(`${d.user_id}:${date}`)) continue;
      this.told.add(`${d.user_id}:${date}`);
      this.deps.failed(d.user_id, date, this.deps.store.lastRunOn(d.user_id, date)?.code ?? null);
    }
  }

  /**
   * The admins' alert (spec §7·§8): an allowed shared connection was deleted or disconnected while users who are on
   * chose it — the server's setup is broken (not the user's to fix). Once a day; the caller dedupes too.
   */
  private checkSetup(date: string, allowed: readonly DreamingChoice[]): void {
    if (!this.deps.alert || this.told.has(date)) return;
    const gone = allowed.filter((a) => this.deps.runner.choiceProblem(a) === "missing");
    if (!gone.length) return;
    const users = this.eligible().filter((u) => {
      const s = this.deps.store.settingsOf(u.id);
      return gone.some(
        (g) => g.runtime === s.runtime && g.connectionId === s.connectionId && g.model === s.model,
      );
    }).length;
    if (!users) return;
    this.told.add(date);
    this.deps.alert(date, users);
  }

  /** Today's round state and start time of a user (their screen, the admin's status table). */
  status(userId: string): { time: string | null; today: string | null } {
    const s = this.slots().find((x) => x.userId === userId);
    const day = this.deps.store.day(userId, dreamingDate(this.now()));
    return { time: s?.time ?? null, today: day?.state ?? null };
  }
}
