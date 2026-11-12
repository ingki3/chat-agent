import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CSRF_HEADER, Schedule, ScheduleRun, type ScheduleTiming } from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb, type Db } from "../src/db/client.js";
import { RuntimeRegistry } from "../src/runtime/adapter.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import { MAX_ATTEMPTS, RETRY_MS, ScheduleEngine, type ExecuteOutcome } from "../src/schedules/engine.js";
import {
  FakeScheduleHandler,
  fakeOutbox,
  type FakeOutbox,
  type FakeScheduleHandlerOptions,
} from "../src/schedules/fake.js";
import { manualKey, occurrenceKey, ScheduleStore, type RunRow } from "../src/schedules/store.js";
import { nextOccurrence } from "../src/schedules/time.js";
import { knownSecrets } from "../src/secrets/known.js";
import { acquireDataLock } from "../src/storage/data-lock.js";
import { createFamily } from "./helpers/permission-matrix.js";

/**
 * #33 schedule engine on a fake clock: the five types, the one missed catch-up, the retry 2 minutes later, crash
 * recovery at each step, overlap, "바로 실행", the run key, daylight saving (America/New_York) and start accuracy.
 */
const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const SEOUL = "Asia/Seoul";
const NY = "America/New_York";
/** 2026-11-12 00:00 KST, a Thursday. */
const THU = Date.UTC(2026, 10, 11, 15);
/** 08:00 KST on THU's day + n. */
const at8 = (n: number) => THU + n * DAY + 8 * H;
const SETTINGS = {
  runtime: "claude-code",
  model: "claude-opus-5-5",
  effort: null,
  useShared: false,
} as const;

const engines: ScheduleEngine[] = [];
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const e of engines.splice(0)) await e.stop();
  while (closers.length) await closers.pop()!();
  vi.useRealTimers();
});

function fakeClock(start: number) {
  vi.useFakeTimers({
    now: start,
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
}
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);
const advanceTo = (t: number) => advance(Math.max(0, t - Date.now()));

type World = { db: Db; store: ScheduleStore; owner: string };
function world(): World {
  const db = createTestDb();
  const owner = crypto.randomUUID();
  db.$client
    .prepare("insert into users (id, email, name, role) values (?, ?, ?, 'member')")
    .run(owner, "o@t", "o");
  return { db, store: new ScheduleStore(db), owner };
}

function schedule(w: World, timing: ScheduleTiming, o: { timeZone?: string; notify?: boolean } = {}) {
  return w.store.create(
    w.owner,
    {
      name: "아침 브리핑",
      prompt: "관심 종목 정리",
      timing,
      timeZone: o.timeZone ?? SEOUL,
      skills: [],
      notify: o.notify ?? true,
      settings: SETTINGS,
    },
    Date.now(),
  );
}

/** One server process: an engine and its handler (the outbox outlives it, as a real handler's rows would). */
function proc(w: World, o: FakeScheduleHandlerOptions & { outbox?: FakeOutbox } = {}) {
  const handler = new FakeScheduleHandler({ ...o, outbox: o.outbox ?? fakeOutbox() });
  const engine = new ScheduleEngine(w.store, handler, { stopGraceMs: 0 });
  engines.push(engine);
  return { handler, engine };
}

const runsOf = (w: World, id: string): RunRow[] => w.store.runs(id, 10_000).reverse();
const steps = (h: FakeScheduleHandler) => h.calls.map((c) => `${c.step}#${c.attempt}`);

describe("the five types on a fake clock (start within ±1 minute, measured)", () => {
  beforeEach(() => fakeClock(THU));

  it("once, daily, weekdays, weekly and cron each run at their times for a week — once each", async () => {
    const w = world();
    const once = schedule(w, { type: "once", date: "2026-11-14", time: "10:00" });
    const daily = schedule(w, { type: "daily", time: "08:00" });
    const weekdays = schedule(w, { type: "weekdays", time: "08:00" });
    const weekly = schedule(w, { type: "weekly", time: "09:00", weekdays: [0, 3] });
    const cron = schedule(w, { type: "cron", cron: "0 */6 * * *" });
    const { engine, handler } = proc(w);
    engine.start();
    await advance(7 * DAY);
    const times = (id: string) => runsOf(w, id).map((r) => r.scheduled_at);
    expect(times(once.id)).toEqual([THU + 2 * DAY + 10 * H]);
    expect(w.store.byId(once.id)!.next_run_at).toBeNull();
    expect(times(daily.id)).toEqual([0, 1, 2, 3, 4, 5, 6].map(at8));
    // Thu, Fri, (Sat, Sun skipped), Mon, Tue, Wed
    expect(times(weekdays.id)).toEqual([0, 1, 4, 5, 6].map(at8));
    // Sunday 15th and Wednesday 18th, 09:00
    expect(times(weekly.id)).toEqual([THU + 3 * DAY + 9 * H, THU + 6 * DAY + 9 * H]);
    // strictly after the creation (THU 00:00 itself is not one), up to and including a week later
    expect(times(cron.id)).toEqual(Array.from({ length: 28 }, (_, i) => THU + (i + 1) * 6 * H));
    const all = [once, daily, weekdays, weekly, cron].flatMap((s) => runsOf(w, s.id));
    expect(all.every((r) => r.status === "succeeded" && r.attempts === 1 && r.trigger === "regular")).toBe(
      true,
    );
    // Accuracy (AC-5): start − scheduled for every run; within ±1 minute (on the fake clock: exactly on time).
    const late = all.map((r) => r.started_at! - r.scheduled_at);
    expect(Math.max(...late)).toBeLessThanOrEqual(MIN);
    expect(Math.min(...late)).toBeGreaterThanOrEqual(0);
    // every run executed once, saved once, notified once
    expect(handler.calls.filter((c) => c.step === "execute")).toHaveLength(all.length);
    expect(handler.outbox.results.size).toBe(all.length);
    expect(handler.outbox.notifications.size).toBe(all.length);
  });

  it("a timer that wakes early or late still starts within the minute (the timer never sleeps past 1 minute)", async () => {
    const w = world();
    const s = schedule(w, { type: "daily", time: "08:00" });
    // The clock jumps (a sleeping Mac): Date moves without the timers firing in between.
    const { engine } = proc(w);
    engine.start();
    await advanceTo(at8(0) - 30_000);
    vi.setSystemTime(at8(0) + 20_000); // 50 s jump, timers not yet fired
    await advance(MIN);
    const [r] = runsOf(w, s.id);
    expect(r!.scheduled_at).toBe(at8(0));
    expect(r!.started_at! - r!.scheduled_at).toBeLessThanOrEqual(MIN);
    expect(r!.trigger).toBe("regular");
  });
});

describe("missed runs (FR-8.7): only the most recent one, once", () => {
  beforeEach(() => fakeClock(THU));

  it("three occurrences missed while the server was off → one run at start, of the latest", async () => {
    const w = world();
    const s = schedule(w, { type: "daily", time: "08:00" });
    // Server off from Thursday 00:00 to Sunday 02:00: Thu, Fri and Sat 08:00 missed.
    vi.setSystemTime(THU + 3 * DAY + 2 * H);
    const { engine, handler } = proc(w);
    engine.start();
    await advance(0);
    let runs = runsOf(w, s.id);
    expect(runs.map((r) => [r.scheduled_at, r.trigger, r.status])).toEqual([[at8(2), "missed", "succeeded"]]);
    expect(handler.calls.filter((c) => c.step === "execute")).toHaveLength(1);
    expect(w.store.byId(s.id)!.next_run_at).toBe(at8(3));
    await advanceTo(at8(3) + MIN);
    runs = runsOf(w, s.id);
    expect(runs.map((r) => [r.scheduled_at, r.trigger])).toEqual([
      [at8(2), "missed"],
      [at8(3), "regular"],
    ]);
  });

  it("AC-5 measurement: stopped 5 minutes before, started 10 minutes later → one run right after start", async () => {
    const w = world();
    const s = schedule(w, { type: "daily", time: "08:00" });
    const a = proc(w);
    a.engine.start();
    await advanceTo(at8(0) - 5 * MIN);
    await a.engine.stop();
    await advance(10 * MIN);
    const b = proc(w);
    b.engine.start();
    await advance(0);
    const runs = runsOf(w, s.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.trigger).toBe("missed");
    expect(runs[0]!.started_at).toBe(at8(0) + 5 * MIN);
    await advance(2 * H);
    expect(runsOf(w, s.id)).toHaveLength(1);
  });

  it("an unstarted occurrence a crash left pending is superseded by the newest one", async () => {
    const w = world();
    const s = schedule(w, { type: "daily", time: "08:00" });
    // Taken but never claimed (the process died in between), then the server stayed off for two days.
    w.store.takeOccurrence(w.store.byId(s.id)!, at8(0), "regular", at8(1), at8(0));
    vi.setSystemTime(at8(2) + H);
    const { engine } = proc(w);
    engine.start();
    await advance(0);
    expect(runsOf(w, s.id).map((r) => [r.scheduled_at, r.status, r.error_code])).toEqual([
      [at8(0), "skipped", "superseded"],
      [at8(2), "succeeded", null],
    ]);
  });
});

describe("missed runs after a long stop with a retry pending", () => {
  beforeEach(() => fakeClock(THU));

  it("a retry left waiting while the server was off for days gives way to the newest occurrence", async () => {
    const w = world();
    const s = schedule(w, { type: "daily", time: "08:00" });
    const a = proc(w, {
      script: (ctx) => (ctx.attempt === 1 ? { ok: false, code: "run_failed" } : { ok: true }),
    });
    a.engine.start();
    await advanceTo(at8(0) + MIN);
    await a.engine.stop();
    vi.setSystemTime(at8(2) + H);
    const b = proc(w);
    b.engine.start();
    await advance(0);
    expect(runsOf(w, s.id).map((r) => [r.scheduled_at, r.trigger, r.status, r.error_code])).toEqual([
      [at8(0), "regular", "skipped", "superseded"],
      [at8(2), "missed", "succeeded", null],
    ]);
    expect(b.handler.calls.filter((c) => c.step === "execute")).toHaveLength(1);
  });
});

describe("retry (FR-8.6): once, 2 minutes after the failure", () => {
  beforeEach(() => fakeClock(THU));

  const failFirst = (ctx: { attempt: number }): ExecuteOutcome =>
    ctx.attempt === 1 ? { ok: false, code: "run_failed" } : { ok: true };

  it("fails, waits exactly 2 minutes, succeeds; result and notification only from the last attempt", async () => {
    const w = world();
    const s = schedule(w, { type: "daily", time: "08:00" });
    const { engine, handler } = proc(w, { script: failFirst });
    engine.start();
    await advanceTo(at8(0));
    let [r] = runsOf(w, s.id);
    expect([r!.status, r!.attempts, r!.retry_at, r!.error_code]).toEqual([
      "pending",
      1,
      at8(0) + RETRY_MS,
      "run_failed",
    ]);
    await advanceTo(at8(0) + RETRY_MS - 1);
    expect(runsOf(w, s.id)[0]!.status).toBe("pending");
    await advance(1);
    [r] = runsOf(w, s.id);
    expect(RETRY_MS).toBe(2 * MIN);
    expect(handler.calls.map((c) => [c.step, c.attempt, c.at])).toEqual([
      ["execute", 1, at8(0)],
      ["execute", 2, at8(0) + 2 * MIN],
      ["save", 2, at8(0) + 2 * MIN],
      ["notify", 2, at8(0) + 2 * MIN],
    ]);
    expect([r!.status, r!.attempts, r!.error_code]).toEqual(["succeeded", 2, null]);
    await advance(H);
    expect(handler.calls.filter((c) => c.step === "execute")).toHaveLength(2);
  });

  it("fails twice → failed with the reason saved and a failure notification; no third attempt", async () => {
    const w = world();
    const s = schedule(w, { type: "daily", time: "08:00" });
    const { engine, handler } = proc(w, { script: () => ({ ok: false, code: "runtime_unavailable" }) });
    engine.start();
    await advanceTo(at8(0) + RETRY_MS + 10 * MIN);
    const [r] = runsOf(w, s.id);
    expect(MAX_ATTEMPTS).toBe(2);
    expect([r!.status, r!.attempts, r!.error_code]).toEqual(["failed", 2, "runtime_unavailable"]);
    expect(steps(handler)).toEqual(["execute#1", "execute#2", "save#2", "notify#2"]);
    expect(handler.outbox.results.get(r!.id)).toMatchObject({
      status: "failed",
      code: "runtime_unavailable",
    });
    expect(handler.outbox.notifications.get(r!.id)?.status).toBe("failed");
  });

  it("a throwing handler is a failure (handler_error); an unknown code becomes handler_error", async () => {
    const w = world();
    const s = schedule(w, { type: "daily", time: "08:00" });
    const { engine } = proc(w, {
      script: (ctx) => {
        if (ctx.attempt === 1) throw new Error("boom");
        return { ok: false, code: "made_up" as never };
      },
    });
    engine.start();
    await advanceTo(at8(0) + RETRY_MS);
    expect(runsOf(w, s.id).map((r) => [r.status, r.error_code])).toEqual([["failed", "handler_error"]]);
  });

  it("notifications off: the result is still saved, nothing is published", async () => {
    const w = world();
    const s = schedule(w, { type: "daily", time: "08:00" }, { notify: false });
    const { engine, handler } = proc(w);
    engine.start();
    await advanceTo(at8(0));
    expect(steps(handler)).toEqual(["execute#1", "save#1"]);
    expect(runsOf(w, s.id)[0]!.status).toBe("succeeded");
  });
});

describe("crash recovery at each step (the run left running, then a new process)", () => {
  beforeEach(() => fakeClock(THU));

  /** Process A dies at `hang` during the 08:00 run; process B starts 30 s later with the same outbox. */
  async function crashAt(
    hang: FakeScheduleHandlerOptions["hang"],
    script?: FakeScheduleHandlerOptions["script"],
  ) {
    const w = world();
    const s = schedule(w, { type: "daily", time: "08:00" });
    const outbox = fakeOutbox();
    const a = proc(w, { outbox, hang, ...(script ? { script } : {}) });
    a.engine.start();
    await advanceTo(at8(0) + (script ? RETRY_MS : 0) + 1000);
    await a.engine.stop(); // the process dies: its pending step never returns
    const left = runsOf(w, s.id)[0]!;
    // What process A left behind, captured before the restart (copies — B must not be able to change them).
    const before = {
      results: structuredClone([...outbox.results]),
      notifications: structuredClone([...outbox.notifications]),
    };
    await advance(30_000);
    const restart = Date.now();
    const b = proc(w, { outbox });
    b.engine.start();
    await advance(0);
    return { w, s, outbox, a: a.handler, b: b.handler, left, restart, before };
  }
  /** Each side effect really happened exactly once for the run. */
  const onceEach = (outbox: FakeOutbox, runId: string) => {
    expect(outbox.saveWrites.get(runId)).toBe(1);
    expect(outbox.publishes.get(runId)).toBe(1);
    expect([...outbox.saveWrites.keys(), ...outbox.publishes.keys()]).toEqual([runId, runId]);
  };

  it("just after start: the start counts as the attempt — the one retry 2 minutes after the restart", async () => {
    const { w, s, b, left, restart, outbox } = await crashAt({ execute: true });
    expect([left.status, left.attempts, left.outcome]).toEqual(["running", 1, null]);
    let [r] = runsOf(w, s.id);
    expect([r!.status, r!.retry_at, r!.error_code]).toEqual(["pending", restart + RETRY_MS, "interrupted"]);
    expect(b.calls).toEqual([]);
    await advance(RETRY_MS);
    [r] = runsOf(w, s.id);
    expect(steps(b)).toEqual(["execute#2", "save#2", "notify#2"]);
    expect([r!.status, r!.attempts]).toEqual(["succeeded", 2]);
    expect(outbox.results.size).toBe(1);
    expect(outbox.notifications.size).toBe(1);
    onceEach(outbox, runsOf(w, s.id)[0]!.id);
  });

  it("just after the retry's start: no attempt left → failed `interrupted`, saved and notified, not run again", async () => {
    const fail1 = (ctx: { attempt: number }): ExecuteOutcome =>
      ctx.attempt === 1 ? { ok: false, code: "run_failed" } : (new Promise<never>(() => {}) as never);
    const { w, s, b, outbox } = await crashAt(undefined, fail1);
    await advance(10 * MIN);
    const [r] = runsOf(w, s.id);
    expect([r!.status, r!.attempts, r!.error_code]).toEqual(["failed", 2, "interrupted"]);
    expect(steps(b)).toEqual(["save#2", "notify#2"]);
    expect(outbox.results.get(r!.id)?.status).toBe("failed");
    expect(outbox.notifications.get(r!.id)?.status).toBe("failed");
  });

  it("before the result is saved: resumes at the save step — not executed again", async () => {
    const { w, s, a, b, left, outbox } = await crashAt({ save: true });
    expect([left.status, left.outcome, left.result_saved_at]).toEqual(["running", "succeeded", null]);
    expect(steps(a)).toEqual(["execute#1", "save#1"]);
    expect(steps(b)).toEqual(["save#1", "notify#1"]);
    const [r] = runsOf(w, s.id);
    expect([r!.status, r!.attempts]).toEqual(["succeeded", 1]);
    expect(r!.result_saved_at).not.toBeNull();
    expect(outbox.results.size).toBe(1);
    expect(outbox.notifications.size).toBe(1);
    onceEach(outbox, runsOf(w, s.id)[0]!.id);
  });

  it("saved by the handler but not yet recorded: the save is called again and stores nothing twice", async () => {
    const { w, s, b, outbox, before } = await crashAt({ saved: true });
    // A had stored the result (and published nothing) before it died.
    expect(before.results).toHaveLength(1);
    expect(before.notifications).toHaveLength(0);
    expect(steps(b)).toEqual(["save#1", "notify#1"]);
    const [r] = runsOf(w, s.id);
    expect([...outbox.results]).toEqual(before.results);
    onceEach(outbox, r!.id);
    expect(r!.status).toBe("succeeded");
  });

  it("before the notification: resumes at the notify step — saved once, notified once", async () => {
    const { w, s, b, left, outbox } = await crashAt({ notify: true });
    expect(left.result_saved_at).not.toBeNull();
    expect(left.notified_at).toBeNull();
    expect(steps(b)).toEqual(["notify#1"]);
    expect(outbox.results.size).toBe(1);
    expect(outbox.notifications.size).toBe(1);
    expect(runsOf(w, s.id)[0]!.status).toBe("succeeded");
  });

  it("published but not yet recorded: notify is called again and publishes nothing twice", async () => {
    const { w, s, b, outbox, before } = await crashAt({ notified: true });
    expect(before.notifications).toHaveLength(1);
    expect(steps(b)).toEqual(["notify#1"]);
    const [r] = runsOf(w, s.id);
    expect([...outbox.notifications]).toEqual(before.notifications);
    expect([...outbox.results]).toEqual(before.results);
    onceEach(outbox, r!.id);
    expect(r!.status).toBe("succeeded");
  });

  it("every step recorded as done is skipped on resume: only the finish is left", async () => {
    const w = world();
    const s = schedule(w, { type: "daily", time: "08:00" });
    const outbox = fakeOutbox();
    const a = proc(w, { outbox, hang: { notified: true } });
    a.engine.start();
    await advanceTo(at8(0) + 1000);
    await a.engine.stop();
    // As if the process died right after recording the notification.
    w.db.$client.prepare("update schedule_runs set notified_at = ?").run(Date.now());
    const b = proc(w, { outbox });
    b.engine.start();
    await advance(0);
    expect(b.handler.calls).toEqual([]);
    expect(runsOf(w, s.id)[0]!.status).toBe("succeeded");
  });

  it("a save step that throws is tried again later (not lost, not repeated once done)", async () => {
    const w = world();
    const s = schedule(w, { type: "daily", time: "08:00" });
    const { engine, handler } = proc(w);
    let failSave = true;
    const save = handler.saveResult.bind(handler);
    handler.saveResult = async (ctx, outcome) => {
      if (failSave) {
        failSave = false;
        throw new Error("disk");
      }
      return save(ctx, outcome);
    };
    engine.start();
    await advanceTo(at8(0));
    expect(runsOf(w, s.id)[0]!.status).toBe("running");
    await advance(RETRY_MS);
    expect(runsOf(w, s.id)[0]!.status).toBe("succeeded");
    expect(steps(handler).filter((x) => x.startsWith("execute"))).toHaveLength(1);
  });
});

describe("a step that returns after shutdown or a lost lock (review 1)", () => {
  beforeEach(() => fakeClock(THU));

  /** The 08:00 run with `step` held open until the test lets it return. */
  async function held(step: "execute" | "saveResult" | "notify", ownedFlag?: { v: boolean }) {
    const w = world();
    const s = schedule(w, { type: "daily", time: "08:00" });
    const handler = new FakeScheduleHandler();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = handler[step].bind(handler) as (...a: unknown[]) => Promise<unknown>;
    (handler as unknown as Record<string, unknown>)[step] = async (...a: unknown[]) => {
      await gate;
      return orig(...a);
    };
    const engine = new ScheduleEngine(w.store, handler, {
      stopGraceMs: 0,
      ...(ownedFlag ? { owned: () => ownedFlag.v } : {}),
    });
    engines.push(engine);
    engine.start();
    await advanceTo(at8(0) + 1000);
    const before = { ...runsOf(w, s.id)[0]! };
    return { w, s, handler, engine, release, before };
  }

  for (const step of ["execute", "saveResult", "notify"] as const) {
    it(`${step} returning after shutdown: no later step, the row untouched`, async () => {
      const { w, s, handler, engine, release, before } = await held(step);
      await engine.stop();
      release();
      await advance(10 * MIN);
      expect(handler.calls.at(-1)!.step).toBe(step === "saveResult" ? "save" : step);
      expect(runsOf(w, s.id)[0]).toEqual(before);
      expect(before.status).toBe("running");
    });

    it(`${step} returning after the data lock was lost: no later step, the row untouched, the engine stops`, async () => {
      const owned = { v: true };
      const { w, s, handler, engine, release, before } = await held(step, owned);
      owned.v = false;
      release();
      await advance(10 * MIN);
      expect(handler.calls.at(-1)!.step).toBe(step === "saveResult" ? "save" : step);
      expect(runsOf(w, s.id)[0]).toEqual(before);
      expect(engine.running).toBe(false);
    });
  }

  it("the next process resumes what the late step left", async () => {
    const { w, s, engine, release, handler } = await held("saveResult");
    await engine.stop();
    release();
    await advance(MIN);
    const b = proc(w, { outbox: handler.outbox });
    b.engine.start();
    await advance(0);
    expect(steps(b.handler)).toEqual(["save#1", "notify#1"]);
    const [r] = runsOf(w, s.id);
    expect(r!.status).toBe("succeeded");
    expect(handler.outbox.saveWrites.get(r!.id)).toBe(1);
    expect(handler.outbox.publishes.get(r!.id)).toBe(1);
  });
});

describe("overlap, run now and the run key", () => {
  beforeEach(() => fakeClock(THU + 8 * H - MIN));

  it("an occurrence while the previous run is still going is skipped and recorded (건너뜀)", async () => {
    const w = world();
    const s = schedule(w, { type: "cron", cron: "* 8 * * *" });
    let first = true;
    const { engine } = proc(w, {
      script: async () => {
        if (first) {
          first = false;
          await new Promise((r) => setTimeout(r, 90_000)); // 08:00 → 08:01:30
        }
        return { ok: true };
      },
    });
    engine.start();
    await advanceTo(THU + 8 * H + 3 * MIN + 30_000);
    expect(
      runsOf(w, s.id).map((r) => [(r.scheduled_at - THU - 8 * H) / MIN, r.status, r.error_code]),
    ).toEqual([
      [0, "succeeded", null],
      [1, "skipped", "overlap"],
      [2, "succeeded", null],
      [3, "succeeded", null],
    ]);
  });

  it("a run waiting for its retry is not finished either: the next occurrence is skipped", async () => {
    const w = world();
    const s = schedule(w, { type: "cron", cron: "* 8 * * *" });
    const { engine } = proc(w, {
      script: (ctx) =>
        ctx.attempt === 1 && ctx.scheduledAt === THU + 8 * H
          ? { ok: false, code: "run_failed" }
          : { ok: true },
    });
    engine.start();
    await advanceTo(THU + 8 * H + 2 * MIN);
    expect(runsOf(w, s.id).map((r) => [r.status, r.error_code])).toEqual([
      ["succeeded", null], // 08:00, retried at 08:02
      ["skipped", "overlap"], // 08:01
      ["skipped", "overlap"], // 08:02 (the retry was pending at the tick)
    ]);
  });

  it("run now: its own run key, runs at once, and does not take the occurrence of the same time", async () => {
    const w = world();
    const s = schedule(w, { type: "daily", time: "08:00" });
    const T = THU + 8 * H;
    const m = w.store.manual(s.id, T)!;
    expect(m.run_key).toBe(manualKey(s.id, T));
    expect(m.run_key).not.toBe(occurrenceKey(s.id, T));
    // While it is not finished another "run now" is refused (overlap).
    expect(w.store.manual(s.id, T + 1)).toBeUndefined();
    const { engine, handler } = proc(w);
    engine.start();
    await advance(0);
    expect(w.store.run(m.id)!.status).toBe("succeeded");
    expect(handler.calls[0]!.at).toBe(T - MIN);
    // The 08:00 occurrence (same time as the manual run's key) still becomes its own run.
    await advanceTo(T);
    expect(runsOf(w, s.id).map((r) => [r.trigger, r.scheduled_at, r.status])).toEqual([
      ["manual", T, "succeeded"],
      ["regular", T, "succeeded"],
    ]);
  });

  it("the run key is unique: the same occurrence can never become two runs", async () => {
    const w = world();
    const s = schedule(w, { type: "daily", time: "08:00" });
    const T = THU + 8 * H;
    const row = w.store.byId(s.id)!;
    expect(w.store.takeOccurrence(row, T, "regular", T + DAY, T)).toBeDefined();
    expect(w.store.takeOccurrence(row, T, "regular", T + DAY, T)).toBeUndefined();
    expect(runsOf(w, s.id)).toHaveLength(1);
    // A state rewound to before the occurrence (an older copy, a second timer): still one run, executed once.
    const { engine, handler } = proc(w);
    engine.start();
    await advance(MIN);
    w.db.$client.prepare("update schedules set next_run_at = ? where id = ?").run(T, s.id);
    engine.kick();
    await advance(MIN);
    expect(runsOf(w, s.id)).toHaveLength(1);
    expect(handler.calls.filter((c) => c.step === "execute")).toHaveLength(1);
  });

  it("paused: nothing runs; resumed: from the next occurrence on, nothing caught up", async () => {
    const w = world();
    const s = schedule(w, { type: "daily", time: "08:00" });
    w.store.update(s.id, { paused: true }, Date.now());
    const { engine } = proc(w);
    engine.start();
    await advance(2 * DAY + 2 * H); // Saturday 09:59: Thursday's to Saturday's 08:00 passed while paused
    expect(runsOf(w, s.id)).toHaveLength(0);
    const resumed = w.store.update(s.id, { paused: false }, Date.now())!;
    expect(resumed.next_run_at).toBe(nextOccurrence({ type: "daily", time: "08:00" }, SEOUL, Date.now()));
    engine.kick();
    await advance(MIN);
    expect(runsOf(w, s.id)).toHaveLength(0);
  });
});

describe("daylight saving on the engine (America/New_York, FR-8.7)", () => {
  it("spring forward: 02:30 (does not exist) runs once at 03:00 EDT; a cron inside the gap runs once", async () => {
    fakeClock(Date.UTC(2026, 2, 7, 12));
    const w = world();
    const daily = schedule(w, { type: "daily", time: "02:30" }, { timeZone: NY });
    const cron = schedule(w, { type: "cron", cron: "*/20 2 * * *" }, { timeZone: NY });
    const { engine } = proc(w);
    engine.start();
    await advance(2 * DAY);
    const iso = (id: string) => runsOf(w, id).map((r) => new Date(r.scheduled_at).toISOString());
    expect(iso(daily.id)).toEqual(["2026-03-08T07:00:00.000Z", "2026-03-09T06:30:00.000Z"]);
    expect(iso(cron.id)).toEqual([
      "2026-03-08T07:00:00.000Z",
      "2026-03-09T06:00:00.000Z",
      "2026-03-09T06:20:00.000Z",
      "2026-03-09T06:40:00.000Z",
    ]);
    for (const r of [...runsOf(w, daily.id), ...runsOf(w, cron.id)])
      expect(r.started_at! - r.scheduled_at).toBeLessThanOrEqual(MIN);
  });

  it("fall back: 01:30 (exists twice) runs once, at the first (EDT) — not again an hour later", async () => {
    fakeClock(Date.UTC(2026, 9, 31, 12));
    const w = world();
    const daily = schedule(w, { type: "daily", time: "01:30" }, { timeZone: NY });
    const cron = schedule(w, { type: "cron", cron: "0,30 1 * * *" }, { timeZone: NY });
    const { engine } = proc(w);
    engine.start();
    await advance(2 * DAY);
    const iso = (id: string) => runsOf(w, id).map((r) => new Date(r.scheduled_at).toISOString());
    expect(iso(daily.id)).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-02T06:30:00.000Z"]);
    expect(iso(cron.id)).toEqual([
      "2026-11-01T05:00:00.000Z",
      "2026-11-01T05:30:00.000Z",
      "2026-11-02T06:00:00.000Z",
      "2026-11-02T06:30:00.000Z",
    ]);
  });
});

describe("start accuracy on the real clock", () => {
  it("a minute occurrence starts within ±1 minute of its time (measured)", async () => {
    const w = world();
    // A shifted clock puts the next minute boundary 300 ms away; the timers are real.
    const real = Date.now();
    const shift = Math.ceil(real / MIN) * MIN - 300 - real;
    const now = () => Date.now() + shift;
    const s = w.store.create(
      w.owner,
      {
        name: "n",
        prompt: "p",
        timing: { type: "cron", cron: "* * * * *" },
        timeZone: SEOUL,
        skills: [],
        notify: true,
        settings: SETTINGS,
      },
      now(),
    );
    const engine = new ScheduleEngine(w.store, new FakeScheduleHandler({ now }), { now, stopGraceMs: 0 });
    engines.push(engine);
    engine.start();
    for (let i = 0; i < 100 && !runsOf(w, s.id).length; i++) await new Promise((r) => setTimeout(r, 20));
    const [r] = runsOf(w, s.id);
    const late = r!.started_at! - r!.scheduled_at;
    expect(late).toBeGreaterThanOrEqual(0);
    expect(late).toBeLessThanOrEqual(MIN);
    // In practice: a few milliseconds (the timer wakes at the occurrence itself).
    expect(late).toBeLessThan(1000);
  });
});

describe("the data folder must be ours", () => {
  beforeEach(() => fakeClock(THU));

  it("not held at start: the engine does not run; lost while running: it stops before the next occurrence", async () => {
    const w = world();
    const s = schedule(w, { type: "daily", time: "08:00" });
    const handler = new FakeScheduleHandler();
    const refused = new ScheduleEngine(w.store, handler, { owned: () => false, stopGraceMs: 0 });
    engines.push(refused);
    refused.start();
    expect(refused.running).toBe(false);
    let held = true;
    const e = new ScheduleEngine(w.store, handler, { owned: () => held, stopGraceMs: 0 });
    engines.push(e);
    e.start();
    await advanceTo(at8(0));
    expect(runsOf(w, s.id)).toHaveLength(1);
    held = false;
    await advanceTo(at8(1) + MIN);
    expect(runsOf(w, s.id)).toHaveLength(1);
    expect(e.running).toBe(false);
  });

  it("the real data lock reports whether it is still held", () => {
    vi.useRealTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-sched-lock-"));
    try {
      const data = path.join(dir, "data");
      fs.mkdirSync(data);
      const lock = acquireDataLock(data, "server");
      expect(lock.held()).toBe(true);
      lock.release();
      expect(lock.held()).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("schedule API (owner only) and the app lifecycle", () => {
  async function app(o: { start?: boolean; dataLock?: { held: () => boolean } } = {}) {
    const runtimes = new RuntimeRegistry();
    runtimes.register(new FakeRuntime());
    const handler = new FakeScheduleHandler();
    const a = await buildApp(loadConfig({ NODE_ENV: "test" }), {
      db: createTestDb(),
      logger: false,
      runtimes,
      schedules: { handler, ...(o.start ? { start: true } : {}) },
      ...(o.dataLock ? { dataLock: o.dataLock } : {}),
    });
    closers.push(() => a.close());
    await a.ready();
    const f = await createFamily(a);
    const req = (cookie: string, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: object) =>
      a.inject({
        method,
        url,
        headers: {
          host: "localhost:3000",
          cookie,
          ...(method === "GET" ? {} : { origin: "http://localhost:3000", [CSRF_HEADER]: "1" }),
        },
        ...(body ? { payload: body } : {}),
      });
    return { a, f, req, handler };
  }
  const create = { name: "아침 브리핑", prompt: "관심 종목", timing: { type: "daily", time: "08:00" } };

  it("create fills the defaults (FR-8.2), checks given settings like the chip, lists only the caller's own", async () => {
    const { f, req } = await app();
    const r = await req(f.cookies.owner, "POST", "/api/schedules", create);
    expect(r.statusCode).toBe(201);
    const s = Schedule.parse(r.json());
    expect([s.timeZone, s.notify, s.paused, s.skills]).toEqual([SEOUL, true, false, []]);
    // The fake runtime's first model (the FR-12.6 fallback from the service default)
    expect(s.settings).toMatchObject({ runtime: "claude-code", model: "fake-large" });
    expect(s.nextRunAt).toBe(nextOccurrence({ type: "daily", time: "08:00" }, SEOUL, Date.now()));
    const bad = await req(f.cookies.owner, "POST", "/api/schedules", {
      ...create,
      model: "fake-small",
      effort: "high",
    });
    expect([bad.statusCode, bad.json().error]).toEqual([403, "effort_not_allowed"]);
    const codex = await req(f.cookies.owner, "POST", "/api/schedules", { ...create, runtime: "codex" });
    expect([codex.statusCode, codex.json().error]).toEqual([403, "runtime_not_allowed"]);
    const skill = await req(f.cookies.owner, "POST", "/api/schedules", { ...create, skills: ["nope"] });
    expect([skill.statusCode, skill.json().error]).toEqual([403, "skill_not_allowed"]);
    for (const [timing, code] of [
      [{ type: "cron", cron: "61 * * * *" }, "cron_invalid"],
      [{ type: "cron", cron: "0 0 31 2 *" }, "schedule_never"],
      [{ type: "once", date: "2020-01-01", time: "08:00" }, "schedule_in_past"],
      // dates that do not exist are refused (never normalised to another day)
      [{ type: "once", date: "2027-02-29", time: "08:00" }, "invalid_request"],
      [{ type: "once", date: "2027-02-30", time: "08:00" }, "invalid_request"],
      [{ type: "once", date: "2027-04-31", time: "08:00" }, "invalid_request"],
      [{ type: "once", date: "2027-13-01", time: "08:00" }, "invalid_request"],
    ] as const) {
      const x = await req(f.cookies.owner, "POST", "/api/schedules", { ...create, timing });
      expect([x.statusCode, x.json().error]).toEqual([400, code]);
    }
    const leap = await req(f.cookies.owner, "POST", "/api/schedules", {
      ...create,
      timing: { type: "once", date: "2028-02-29", time: "08:00" },
    });
    expect(leap.statusCode).toBe(201);
    expect(Schedule.parse(leap.json()).nextRunAt).toBe(Date.UTC(2028, 1, 28, 23));
    await req(f.cookies.owner, "DELETE", `/api/schedules/${leap.json().id}`);
    const tz = await req(f.cookies.owner, "POST", "/api/schedules", { ...create, timeZone: "Mars/Base" });
    expect([tz.statusCode, tz.json().error]).toEqual([400, "invalid_time_zone"]);
    expect((await req(f.cookies.owner, "GET", "/api/schedules")).json().schedules).toHaveLength(1);
    expect((await req(f.cookies.stranger, "GET", "/api/schedules")).json().schedules).toHaveLength(0);
    expect((await req(f.cookies.admin, "GET", `/api/schedules/${s.id}`)).statusCode).toBe(403);
    const paused = await req(f.cookies.owner, "PATCH", `/api/schedules/${s.id}`, { paused: true });
    expect(Schedule.parse(paused.json())).toMatchObject({ paused: true, nextRunAt: null });
  });

  it("the prompt is scrubbed of known secrets on write and by the rescrub of a secret registered later", async () => {
    const { a, f, req } = await app();
    const early = `sk-sched-${crypto.randomBytes(16).toString("base64url")}`;
    knownSecrets.add(early);
    const late = `late-sched-${crypto.randomBytes(16).toString("base64url")}`;
    const r = await req(f.cookies.owner, "POST", "/api/schedules", {
      ...create,
      name: `이름 ${early}`,
      prompt: `키는 ${early} 그리고 ${late}`,
    });
    expect(r.statusCode).toBe(201);
    const row = () => JSON.stringify(a.schedules!.store.byId(r.json().id));
    expect(row()).not.toContain(early);
    expect(row()).toContain(late);
    knownSecrets.add(late);
    await new Promise((res) => setTimeout(res, 150));
    await a.storedRescrub!.idle();
    expect(row()).not.toContain(late);
  });

  it("run now: 201 with its run, 409 while it is not finished; the engine runs it when started", async () => {
    const idle = await app();
    const s = (await idle.req(idle.f.cookies.owner, "POST", "/api/schedules", create)).json();
    const first = await idle.req(idle.f.cookies.owner, "POST", `/api/schedules/${s.id}/run`);
    expect(first.statusCode).toBe(201);
    expect(ScheduleRun.parse(first.json().run)).toMatchObject({ trigger: "manual", status: "pending" });
    // No engine running in a test app unless asked: it stays pending, and a second one is refused.
    expect(idle.a.schedules!.engine!.running).toBe(false);
    const second = await idle.req(idle.f.cookies.owner, "POST", `/api/schedules/${s.id}/run`);
    expect([second.statusCode, second.json().error]).toEqual([409, "schedule_busy"]);

    const live = await app({ start: true });
    const t = (await live.req(live.f.cookies.owner, "POST", "/api/schedules", create)).json();
    expect((await live.req(live.f.cookies.owner, "POST", `/api/schedules/${t.id}/run`)).statusCode).toBe(201);
    await live.a.schedules!.engine!.idle();
    for (let i = 0; i < 50; i++) {
      const runs = (await live.req(live.f.cookies.owner, "GET", `/api/schedules/${t.id}/runs`)).json().runs;
      if (runs[0]?.status === "succeeded") break;
      await new Promise((res) => setTimeout(res, 10));
    }
    const runs = (await live.req(live.f.cookies.owner, "GET", `/api/schedules/${t.id}/runs`)).json().runs;
    expect(runs.map((x: { status: string }) => x.status)).toEqual(["succeeded"]);
    expect(live.handler.calls.map((c) => c.step)).toEqual(["execute", "save", "notify"]);
    // Closing the app stops the engine.
    await live.a.close();
    expect(live.a.schedules!.engine!.running).toBe(false);
  });

  it("an app given a data lock that is not held never starts the engine", async () => {
    const { a } = await app({ start: true, dataLock: { held: () => false } });
    expect(a.schedules!.engine!.running).toBe(false);
  });
});
