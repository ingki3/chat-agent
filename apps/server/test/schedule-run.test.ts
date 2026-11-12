import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  Conversation,
  CSRF_HEADER,
  Schedule,
  ScheduleRun,
  type Message,
  type MessagePart,
  type Notification,
} from "@agentlee/shared";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb, type Db } from "../src/db/client.js";
import { RuntimeRegistry } from "../src/runtime/adapter.js";
import { defaultScript, FakeRuntime, type FakeScript, type FakeStep } from "../src/runtime/fake.js";
import type { ScheduleHandler, ScheduleRunContext } from "../src/schedules/engine.js";
import { RuntimeScheduleHandler } from "../src/schedules/handler.js";
import { clock } from "../src/notifications/compose.js";
import { knownSecrets } from "../src/secrets/known.js";
import { createFamily, type Family } from "./helpers/permission-matrix.js";

/**
 * #56: a schedule run is a turn of the schedule's own result conversation, run by the RunManager on the FakeRuntime —
 * success, failure, retry then failure (and retry then success) leave the conversation, the run history and the
 * notification consistent (PRD FR-8.3·8.4·8.6); a crash at any step leaves exactly one message, one conversation run
 * per attempt, one result and one notification; the connection warning comes once per occurrence (FR-11.8).
 */
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const never = () => new Promise<never>(() => {});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(ok: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await sleep(5);
  }
}

type Who = keyof Family["cookies"];
type Wrap = (inner: RuntimeScheduleHandler) => ScheduleHandler;

/** A FakeRuntime turn counter shared by the apps of one test (a "restarted" server is another app on the same DB). */
function scripted(turns: (n: number, text: string) => FakeStep[]) {
  let n = 0;
  const script: FakeScript = (input) => turns(++n, input.text);
  return { script, turns: () => n };
}

async function world(
  o: {
    db?: Db;
    script?: FakeScript;
    wrap?: Wrap;
    needsConnection?: boolean;
    runTools?: boolean;
    runTimeoutMs?: number;
    family?: boolean;
  } = {},
) {
  const db = o.db ?? createTestDb();
  const runtimes = new RuntimeRegistry();
  const runtime = new FakeRuntime({
    script: o.script ?? defaultScript,
    needsConnection: o.needsConnection ?? false,
    ...(o.runTools ? { runTools: true } : {}),
  });
  runtimes.register(runtime);
  const box: { h?: ScheduleHandler } = {};
  const handler: ScheduleHandler = {
    execute: (c) => box.h!.execute(c),
    saveResult: (c, r) => box.h!.saveResult(c, r),
    notify: (c, r, s) => box.h!.notify(c, r, s),
  };
  const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
    db,
    logger: false,
    runtimes,
    runs: { flushMs: 0, interruptGraceMs: 50 },
    notifications: { sender: async () => {} },
    schedules: { handler, start: true, engine: { retryMs: 40, maxSleepMs: 20, stopGraceMs: 0 } },
  });
  closers.push(() => app.close());
  const inner = new RuntimeScheduleHandler({
    store: app.schedules!.store,
    conversations: app.conversations!,
    runs: app.runs!,
    notifications: () => app.notifications,
    runTimeoutMs: o.runTimeoutMs ?? 20_000,
  });
  box.h = o.wrap ? o.wrap(inner) : inner;
  await app.ready();
  const f = o.family === false ? undefined : await createFamily(app);
  return { app, db, f, inner, runtime, ...helpers(app, db, f) };
}

function helpers(app: FastifyInstance, db: Db, f: Family | undefined) {
  const req = (who: Who, method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: object) =>
    app.inject({
      method,
      url,
      headers: {
        host: "localhost:3000",
        cookie: f!.cookies[who],
        ...(method === "GET" ? {} : { origin: "http://localhost:3000", [CSRF_HEADER]: "1" }),
      },
      ...(method === "GET" ? {} : { payload: body ?? {} }),
    });
  const sql = db.$client;
  const runRow = (id: string) =>
    sql.prepare(`select * from schedule_runs where id = ?`).get(id) as {
      status: string;
      attempts: number;
      error_code: string | null;
      output_ref: string | null;
      result_ref: string | null;
      notified_at: number | null;
    };
  const finished = (id: string) => ["succeeded", "failed"].includes(runRow(id)?.status);
  const notes = (userId: string) =>
    sql
      .prepare(`select * from notifications where user_id = ? and kind like 'schedule_%' order by created_at`)
      .all(userId) as { kind: string; title: string; body: string; url: string; dedupe_key: string }[];
  const messagesOf = (conversationId: string, all = false) =>
    sql
      .prepare(`select * from messages where conversation_id = ? ${all ? "" : "and active = 1"} order by seq`)
      .all(conversationId)
      .map((m) => {
        const r = m as { id: string; role: string; status: string; parts: string; active: number };
        return { ...r, parts: JSON.parse(r.parts) as MessagePart[] };
      });
  const chatRuns = (conversationId: string) =>
    sql.prepare(`select * from runs where conversation_id = ? order by created_at`).all(conversationId) as {
      id: string;
      status: string;
      error_code: string | null;
    }[];
  const text = (parts: MessagePart[]) => parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
  return { req, sql, runRow, finished, notes, messagesOf, chatRuns, text };
}

const create = {
  name: "아침 브리핑",
  prompt: "관심 종목 정리해줘",
  timing: { type: "daily", time: "08:00" },
};

/** Makes a schedule of the owner and presses "바로 실행"; returns both. */
async function runNow(t: Awaited<ReturnType<typeof world>>, body: object = create) {
  const made = await t.req("owner", "POST", "/api/schedules", body);
  expect(made.statusCode).toBe(201);
  const s = Schedule.parse(made.json());
  const r = await t.req("owner", "POST", `/api/schedules/${s.id}/run`);
  expect(r.statusCode).toBe(201);
  return { s, run: ScheduleRun.parse(r.json().run) };
}

const reply = (...lines: string[]): FakeStep[] => [
  { text: lines.join("\n") },
  { usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.01 } },
];
const fail: FakeStep[] = [{ usage: { inputTokens: 3, outputTokens: 0 } }, { fail: "boom" }];

describe("schedule runs in the result conversation (#56)", () => {
  it("success: a new message in the owner's schedule conversation, the history, '새 결과' and one notification", async () => {
    const t = await world({ script: () => reply("첫 줄 요약", "둘째 줄", "셋째 줄은 알림에 없음") });
    const { s, run } = await runNow(t);
    await until(() => t.finished(run.id) && t.runRow(run.id).notified_at !== null);
    const row = t.runRow(run.id);
    expect(row).toMatchObject({ status: "succeeded", attempts: 1, error_code: null });
    // The schedule now names its conversation: the owner's, kind schedule, titled with the schedule's name.
    const sched = Schedule.parse((await t.req("owner", "GET", `/api/schedules/${s.id}`)).json());
    const convId = sched.conversationId!;
    const conv = Conversation.parse((await t.req("owner", "GET", `/api/conversations/${convId}`)).json());
    expect(conv).toMatchObject({ kind: "schedule", title: "아침 브리핑", newResult: true });
    // The prompt as the user's message, the reply right after it — the run's result reference.
    const msgs = (await t.req("owner", "GET", `/api/conversations/${convId}/messages`)).json<{
      items: Message[];
    }>().items;
    expect(msgs.map((m) => [m.role, m.status])).toEqual([
      ["user", "complete"],
      ["assistant", "complete"],
    ]);
    expect(t.text(msgs[0]!.parts)).toBe("관심 종목 정리해줘");
    expect(row.result_ref).toBe(msgs[1]!.id);
    // The conversation run is the run's output; its usage counts for the owner as `schedule` (#44) and its cost
    // reaches the history (#55).
    const [chat] = t.chatRuns(convId);
    expect(row.output_ref).toBe(chat!.id);
    const usage = t.sql
      .prepare(`select user_id, purpose from usage_records where run_id = ?`)
      .all(chat!.id) as { user_id: string; purpose: string }[];
    expect(usage).toEqual([{ user_id: t.f!.users.owner.id, purpose: "schedule" }]);
    t.sql.prepare(`update usage_records set priced_cost_micros = 7000 where run_id = ?`).run(chat!.id);
    const hist = (await t.req("owner", "GET", `/api/schedules/${s.id}/runs`)).json().runs as unknown[];
    expect(ScheduleRun.parse(hist[0]).costUsd).toBeCloseTo(0.007, 8);
    // One notification: title = the name, body = the first two lines, link = the result message (FR-8.4).
    const [n, ...more] = t.notes(t.f!.users.owner.id);
    expect(more).toEqual([]);
    expect(n).toMatchObject({
      kind: "schedule_succeeded",
      title: "아침 브리핑",
      body: "첫 줄 요약\n둘째 줄…",
      url: `/c/${convId}#m-${msgs[1]!.id}`,
    });
    const inbox = (await t.req("owner", "GET", "/api/notifications")).json<{ items: Notification[] }>().items;
    expect(inbox.map((x) => x.kind)).toContain("schedule_succeeded");
    // The sidebar's "새 결과" until the owner opens it; only the owner may clear it, the admin sees nothing.
    expect((await t.req("admin", "GET", `/api/conversations/${convId}`)).statusCode).toBe(403);
    expect((await t.req("admin", "POST", `/api/conversations/${convId}/result-seen`)).statusCode).toBe(403);
    const list = (await t.req("owner", "GET", "/api/conversations")).json<{ items: Conversation[] }>().items;
    expect(list.find((c) => c.id === convId)?.newResult).toBe(true);
    expect(conv.newResultMessageId).toBe(msgs[1]!.id);
    // Seen for another (older) message: a newer result stays marked.
    const stale = await t.req("owner", "POST", `/api/conversations/${convId}/result-seen`, {
      messageId: msgs[0]!.id,
    });
    expect(Conversation.parse(stale.json()).newResult).toBe(true);
    const bad = await t.req("owner", "POST", `/api/conversations/${convId}/result-seen`, { messageId: 1 });
    expect(bad.statusCode).toBe(400);
    const seen = await t.req("owner", "POST", `/api/conversations/${convId}/result-seen`, {
      messageId: msgs[1]!.id,
    });
    expect(Conversation.parse(seen.json())).toMatchObject({ newResult: false, newResultMessageId: null });
  });

  it("each run is a new message of the same conversation; the finance check applies to the result (#30)", async () => {
    const t = await world({ script: defaultScript });
    const { s, run } = await runNow(t, { ...create, prompt: "/finance" });
    await until(() => t.finished(run.id));
    const second = ScheduleRun.parse((await t.req("owner", "POST", `/api/schedules/${s.id}/run`)).json().run);
    await until(() => t.finished(second.id));
    const convId = t.app.schedules!.store.byId(s.id)!.conversation_id!;
    const msgs = t.messagesOf(convId);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    for (const m of msgs.filter((x) => x.role === "assistant"))
      expect(m.parts.some((p) => p.type === "finance_note")).toBe(true);
    expect(t.notes(t.f!.users.owner.id)).toHaveLength(2);
  });

  it("retry then failure: one message, its reply retried in place, a failure message with the reason, one failure notification", async () => {
    const t = await world({ script: () => fail });
    const { s, run } = await runNow(t);
    await until(() => t.finished(run.id) && t.runRow(run.id).notified_at !== null);
    expect(t.runRow(run.id)).toMatchObject({ status: "failed", attempts: 2, error_code: "run_failed" });
    const convId = t.app.schedules!.store.byId(s.id)!.conversation_id!;
    // One user message: the retry regenerated the failed reply (kept as an earlier version), then the failure.
    const active = t.messagesOf(convId);
    expect(active.map((m) => [m.role, m.status])).toEqual([
      ["user", "complete"],
      ["assistant", "error"],
      ["assistant", "complete"],
    ]);
    expect(t.text(active[2]!.parts)).toBe(
      "**예약 실행 실패** — 응답 중 오류가 났어요.\n\n2분 뒤 한 번 더 시도했지만 실패했어요.",
    );
    expect(t.messagesOf(convId, true).filter((m) => m.role === "user")).toHaveLength(1);
    expect(t.chatRuns(convId).map((r) => [r.status, r.error_code])).toEqual([
      ["failed", "runtime_error"],
      ["failed", "runtime_error"],
    ]);
    expect(t.runRow(run.id).result_ref).toBe(active[2]!.id);
    const attempts = t.app.schedules!.store.attempts(run.id);
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2]);
    // Both attempts' usage is the run's (and the owner's).
    t.sql.prepare(`update usage_records set priced_cost_micros = 1000 where conversation_id = ?`).run(convId);
    const hist = (await t.req("owner", "GET", `/api/schedules/${s.id}/runs`)).json().runs as unknown[];
    expect(ScheduleRun.parse(hist[0]).costUsd).toBeCloseTo(0.002, 8);
    const ns = t.notes(t.f!.users.owner.id);
    expect(ns).toEqual([
      expect.objectContaining({
        kind: "schedule_failed",
        title: "아침 브리핑",
        body: "실행 실패 — 응답 중 오류가 났어요",
        url: `/c/${convId}#m-${active[2]!.id}`,
      }),
    ]);
    expect(
      Conversation.parse((await t.req("owner", "GET", `/api/conversations/${convId}`)).json()).newResult,
    ).toBe(true);
  });

  it("failure then a successful retry: the retry's reply is the result, one success notification", async () => {
    const t = await world({
      script: (() => {
        let n = 0;
        return () => (++n === 1 ? fail : reply("두 번째에 됐어요"));
      })(),
    });
    const { s, run } = await runNow(t);
    await until(() => t.finished(run.id) && t.runRow(run.id).notified_at !== null);
    expect(t.runRow(run.id)).toMatchObject({ status: "succeeded", attempts: 2 });
    const convId = t.app.schedules!.store.byId(s.id)!.conversation_id!;
    const active = t.messagesOf(convId);
    expect(active.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(t.text(active[1]!.parts)).toBe("두 번째에 됐어요");
    expect(t.runRow(run.id).result_ref).toBe(active[1]!.id);
    expect(t.notes(t.f!.users.owner.id).map((n) => [n.kind, n.body])).toEqual([
      ["schedule_succeeded", "두 번째에 됐어요"],
    ]);
  });

  it("runs with the owner's permissions only: a model taken away fails `not_allowed`, nothing is run", async () => {
    const t = await world({ script: () => reply("x") });
    const made = Schedule.parse((await t.req("owner", "POST", "/api/schedules", create)).json());
    t.app.connections!.store.setPolicy(t.f!.users.owner.id, {
      runtime: "claude-code",
      allowed: true,
      models: ["fake-small"],
      efforts: "all",
      allowPersonal: true,
      allowShared: true,
    });
    const run = ScheduleRun.parse((await t.req("owner", "POST", `/api/schedules/${made.id}/run`)).json().run);
    await until(() => t.finished(run.id) && t.runRow(run.id).notified_at !== null);
    expect(t.runRow(run.id)).toMatchObject({ status: "failed", attempts: 2, error_code: "not_allowed" });
    const convId = t.app.schedules!.store.byId(made.id)!.conversation_id!;
    expect(t.chatRuns(convId)).toEqual([]);
    const msgs = t.messagesOf(convId);
    expect(msgs).toHaveLength(1);
    expect(t.text(msgs[0]!.parts)).toContain("예약의 런타임·모델을 지금은 쓸 수 없어요");
    expect(t.notes(t.f!.users.owner.id).map((n) => n.kind)).toEqual(["schedule_failed"]);
  });

  it("a stored conversation that is not the owner's schedule conversation is never written to", async () => {
    const t = await world({ script: () => reply("ok") });
    const made = Schedule.parse((await t.req("owner", "POST", "/api/schedules", create)).json());
    const theirs = t.app.conversations!.create(t.f!.users.stranger.id, { kind: "schedule" });
    const mine = t.app.conversations!.create(t.f!.users.owner.id, {});
    for (const wrong of [theirs.id, mine.id]) {
      t.app.schedules!.store.setConversation(made.id, wrong);
      const run = ScheduleRun.parse(
        (await t.req("owner", "POST", `/api/schedules/${made.id}/run`)).json().run,
      );
      await until(() => t.finished(run.id) && t.runRow(run.id).notified_at !== null);
      expect(t.messagesOf(wrong)).toEqual([]);
      const used = t.app.schedules!.store.byId(made.id)!.conversation_id!;
      expect(used).not.toBe(wrong);
      expect(t.app.conversations!.get(used)).toMatchObject({
        ownerId: t.f!.users.owner.id,
        kind: "schedule",
      });
    }
  });

  it("a conversation run that does not end in time is stopped: `timeout`", async () => {
    const t = await world({ script: () => [{ delayMs: 5000 }, { text: "늦음" }], runTimeoutMs: 60 });
    const { run } = await runNow(t);
    await until(() => t.finished(run.id) && t.runRow(run.id).notified_at !== null);
    expect(t.runRow(run.id)).toMatchObject({ status: "failed", error_code: "timeout", attempts: 2 });
    expect(t.notes(t.f!.users.owner.id)[0]!.body).toBe("실행 실패 — 제한 시간 안에 끝나지 않았어요");
  });

  it("the same attempt asked twice begins one conversation run with one message (idempotent per attempt)", async () => {
    const t = await world({ script: () => [{ delayMs: 50 }, ...reply("한 번")] });
    const made = Schedule.parse((await t.req("owner", "POST", "/api/schedules", create)).json());
    // Claimed at once (as the engine would), so the running engine leaves it to this test.
    const row = t.app.schedules!.store.manual(made.id, Date.now())!;
    expect(t.app.schedules!.store.claim(row.id, Date.now())).toBe(true);
    const ctx: ScheduleRunContext = {
      runId: row.id,
      runKey: row.run_key,
      scheduleId: made.id,
      ownerId: t.f!.users.owner.id,
      schedule: made,
      scheduledAt: row.scheduled_at,
      trigger: "manual",
      attempt: 1,
      signal: new AbortController().signal,
    };
    const [a, b] = await Promise.all([t.inner.execute(ctx), t.inner.execute(ctx)]);
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
    const convId = t.app.schedules!.store.byId(made.id)!.conversation_id!;
    expect(t.chatRuns(convId)).toHaveLength(1);
    expect(t.messagesOf(convId, true).map((m) => m.role)).toEqual(["user", "assistant"]);
    // And saving / notifying again stores nothing twice.
    const out = { status: "succeeded" as const, code: null, outputRef: a.outputRef ?? null };
    const s1 = await t.inner.saveResult(ctx, out);
    const s2 = await t.inner.saveResult(ctx, out);
    expect(s1).toEqual(s2);
    await t.inner.notify(ctx, out, s1);
    await t.inner.notify(ctx, out, s2);
    expect(t.notes(t.f!.users.owner.id)).toHaveLength(1);
  });
});

describe("crash at any step (#56 on the #33 contract)", () => {
  it("the server dies mid-run: the next start retries once — one message, one turn per attempt, one notification", async () => {
    const db = createTestDb();
    const turns = scripted((n) =>
      n === 1 ? [{ delayMs: 10_000 }, { text: "못 끝냄" }] : reply("다시 해서 됐어요"),
    );
    const a = await world({ db, script: turns.script });
    const { s, run } = await runNow(a);
    await until(() => turns.turns() === 1 && a.runRow(run.id).status === "running");
    await sleep(20);
    await a.app.close();
    closers.splice(closers.indexOf(closers.at(-1)!), 1);
    expect(a.runRow(run.id)).toMatchObject({ status: "running", attempts: 1 });

    const b = await world({ db, script: turns.script, family: false });
    await until(() => b.finished(run.id) && b.runRow(run.id).notified_at !== null);
    expect(b.runRow(run.id)).toMatchObject({ status: "succeeded", attempts: 2 });
    const convId = b.app.schedules!.store.byId(s.id)!.conversation_id!;
    // Two attempts, two turns — the first one ended by the restart, never resumed or run again.
    expect(turns.turns()).toBe(2);
    expect(b.chatRuns(convId).map((r) => [r.status, r.error_code])).toEqual([
      ["failed", "server_restart"],
      ["done", null],
    ]);
    expect(b.messagesOf(convId, true).filter((m) => m.role === "user")).toHaveLength(1);
    expect(b.messagesOf(convId).map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(b.notes(a.f!.users.owner.id).map((n) => n.kind)).toEqual(["schedule_succeeded"]);
  });

  const hangs: [string, (hit: () => void) => Wrap][] = [
    ["before the result is saved", (hit) => (h) => ({ ...bind(h), saveResult: () => (hit(), never()) })],
    [
      "after the result was saved, before it was recorded",
      (hit) => (h) => ({
        ...bind(h),
        saveResult: async (c, o) => (await h.saveResult(c, o), hit(), never()),
      }),
    ],
    ["before the notification", (hit) => (h) => ({ ...bind(h), notify: () => (hit(), never()) })],
    [
      "after the notification was published, before it was recorded",
      (hit) => (h) => ({ ...bind(h), notify: async (c, o, s) => (await h.notify(c, o, s), hit(), never()) }),
    ],
  ];
  it.each(hangs)("dies %s: one failure message, one result, one notification", async (_, hang) => {
    const db = createTestDb();
    let reached = false;
    const a = await world({ db, script: () => fail, wrap: hang(() => (reached = true)) });
    const { s, run } = await runNow(a);
    await until(() => reached);
    await a.app.close();
    closers.splice(closers.indexOf(closers.at(-1)!), 1);
    const b = await world({ db, script: () => fail, family: false });
    await until(() => b.finished(run.id));
    const convId = b.app.schedules!.store.byId(s.id)!.conversation_id!;
    const failures = b
      .messagesOf(convId, true)
      .filter((m) => b.text(m.parts).startsWith("**예약 실행 실패**"));
    expect(failures).toHaveLength(1);
    expect(b.runRow(run.id)).toMatchObject({ status: "failed", result_ref: failures[0]!.id });
    expect(
      b.sql.prepare(`select count(*) as n from schedule_results where schedule_run_id = ?`).get(run.id),
    ).toEqual({
      n: 1,
    });
    expect(b.notes(a.f!.users.owner.id).map((n) => n.kind)).toEqual(["schedule_failed"]);
    expect(b.chatRuns(convId)).toHaveLength(2);
  });
});

const bind = (h: RuntimeScheduleHandler): ScheduleHandler => ({
  execute: (c) => h.execute(c),
  saveResult: (c, o) => h.saveResult(c, o),
  notify: (c, o, s) => h.notify(c, o, s),
});

describe("connection warning before the next run (FR-11.8)", () => {
  it("a schedule whose connection is gone is warned about once per occurrence, an hour ahead", async () => {
    // A runtime that needs a connection, and the owner has none: the run would fail `no_connection`.
    const t = await world({ needsConnection: true });
    const owner = t.f!.users.owner.id;
    const at = Date.UTC(2026, 10, 13, 0, 0); // 09:00 in Seoul
    const s = t.app.schedules!.store.create(
      owner,
      {
        name: "주간 정리",
        prompt: "x",
        timing: { type: "daily", time: "09:00" },
        timeZone: "Asia/Seoul",
        skills: [],
        notify: true,
        settings: { runtime: "claude-code", model: "fake-large", effort: "medium", useShared: false },
      },
      at - 3 * 3600_000,
    );
    expect(s.next_run_at).toBe(at);
    const w = t.app.schedules!.warnings!;
    // More than an hour ahead: nothing yet.
    expect(w.check(at - 2 * 3600_000)).toBe(0);
    expect(t.notes(owner)).toEqual([]);
    // Within the hour: one warning, however often it is checked (and after a restart — the key is stored).
    w.check(at - 50 * 60_000);
    w.check(at - 10 * 60_000);
    w.check(at - 10 * 60_000);
    const [n, ...rest] = t.notes(owner);
    expect(rest).toEqual([]);
    expect(n).toMatchObject({
      kind: "schedule_warning",
      title: "주간 정리",
      url: `/schedules/${s.id}`,
      dedupe_key: `schedule-warning:${s.id}@${at}`,
    });
    expect(n!.body).toContain("오전 9:00 실행 전에 확인해 주세요 — Claude Code 연결을 쓸 수 없어요.");
    // The next occurrence is warned about again (once).
    const next = at + 24 * 3600_000;
    t.sql.prepare(`update schedules set next_run_at = ? where id = ?`).run(next, s.id);
    w.check(next - 30 * 60_000);
    w.check(next - 20 * 60_000);
    expect(t.notes(owner)).toHaveLength(2);
    // Paused: none.
    t.sql
      .prepare(`update schedules set paused = 1, next_run_at = ? where id = ?`)
      .run(next + 86_400_000, s.id);
    w.check(next + 86_400_000 - 600_000);
    expect(t.notes(owner)).toHaveLength(2);
    // The owner only: the admin's inbox has none of it.
    expect(t.notes(t.f!.users.admin.id)).toEqual([]);
  });

  it("a usable schedule gets no warning", async () => {
    const t = await world();
    const s = Schedule.parse((await t.req("owner", "POST", "/api/schedules", create)).json());
    expect(t.app.schedules!.warnings!.check(s.nextRunAt! - 600_000)).toBe(0);
    expect(t.notes(t.f!.users.owner.id)).toEqual([]);
    // Taken away by the admin: now it is warned about.
    t.app.connections!.store.setPolicy(t.f!.users.owner.id, {
      runtime: "claude-code",
      allowed: false,
      models: "all",
      efforts: "all",
      allowPersonal: true,
      allowShared: true,
    });
    expect(t.app.schedules!.warnings!.check(s.nextRunAt! - 600_000)).toBe(1);
    expect(t.notes(t.f!.users.owner.id).map((n) => n.kind)).toEqual(["schedule_warning"]);
  });
});

describe("the warning's time (locale-independent, review #116)", () => {
  it("reads 오전/오후 h:mm in the schedule's zone whatever the server locale", () => {
    expect(clock(Date.UTC(2026, 10, 13, 0, 0), "Asia/Seoul")).toBe("오전 9:00");
    expect(clock(Date.UTC(2026, 10, 13, 3, 5), "Asia/Seoul")).toBe("오후 12:05");
    expect(clock(Date.UTC(2026, 10, 13, 15, 0), "Asia/Seoul")).toBe("오전 12:00");
    expect(clock(Date.UTC(2026, 10, 13, 13, 30), "America/New_York")).toBe("오전 8:30");
    expect(clock(Date.UTC(2026, 10, 13, 0, 0), "Mars/Base")).toBe("오전 9:00");
  });
});

describe("known secrets (#78)", () => {
  it("the result, the failure reason and the notification carry no known secret — also one registered after storing", async () => {
    const early = `sk-early-${crypto.randomBytes(12).toString("base64url")}`;
    const late = `late-${crypto.randomBytes(12).toString("base64url")}`;
    knownSecrets.add(early);
    const t = await world({
      script: () => reply(`키 ${early} 그리고 ${late}`, "둘째"),
      // A secret registered after the reply was stored, before the notification.
      wrap: (h) => ({
        ...bind(h),
        notify: async (c, o, s) => {
          knownSecrets.add(late);
          return h.notify(c, o, s);
        },
      }),
    });
    const { s, run } = await runNow(t, { ...create, name: "브리핑" });
    await until(() => t.finished(run.id));
    const convId = t.app.schedules!.store.byId(s.id)!.conversation_id!;
    expect(JSON.stringify(t.messagesOf(convId))).not.toContain(early);
    const all = JSON.stringify(t.notes(t.f!.users.owner.id));
    expect(all).not.toContain(early);
    expect(all).not.toContain(late);
    expect(t.notes(t.f!.users.owner.id)).toHaveLength(1);
  });
});

const CLAUDE_KEY = `sk-ant-SCHEDRUNFAKE${"c".repeat(24)}`;

describe("the schedule's own settings, never more (review #116)", () => {
  it("useShared is the schedule's: set back to personal, the run uses the personal connection; the warning agrees", async () => {
    const t = await world({ needsConnection: true, script: () => reply("ok") });
    const store = t.app.connections!.store;
    const connect = (personal: boolean) => {
      const c = store.create({
        runtime: "claude-code",
        authType: "api_key",
        scope: personal ? "personal" : "shared",
        owner: personal ? t.f!.users.owner : null,
        createdBy: t.f!.users.admin.id,
        secret: CLAUDE_KEY,
      });
      store.setTestResult(c.id, "passed", "ok", 1);
      return c;
    };
    const mine = connect(true);
    const shared = connect(false);
    const made = Schedule.parse(
      (await t.req("owner", "POST", "/api/schedules", { ...create, useShared: true })).json(),
    );
    expect(made.settings.useShared).toBe(true);
    const runOnce = async () => {
      const r = ScheduleRun.parse((await t.req("owner", "POST", `/api/schedules/${made.id}/run`)).json().run);
      await until(() => t.finished(r.id) && t.runRow(r.id).notified_at !== null);
      return r;
    };
    const first = await runOnce();
    const convId = t.app.schedules!.store.byId(made.id)!.conversation_id!;
    const connOf = (runId: string) =>
      (
        t.sql.prepare(`select connection_id as c from runs where id = ?`).get(t.runRow(runId).output_ref) as {
          c: string;
        }
      ).c;
    expect(connOf(first.id)).toBe(shared.id);
    // The conversation now remembers "공용으로 쓰기"; the schedule is set back to personal.
    expect(t.app.conversations!.get(convId)!.useShared).toBe(true);
    const patched = await t.req("owner", "PATCH", `/api/schedules/${made.id}`, { useShared: false });
    expect(patched.statusCode).toBe(200);
    const second = await runOnce();
    expect(t.runRow(second.id).status).toBe("succeeded");
    expect(connOf(second.id)).toBe(mine.id);
    // Shared access revoked while the schedule asks for it: the warning and the run say the same (both refused).
    await t.req("owner", "PATCH", `/api/schedules/${made.id}`, { useShared: true });
    t.app.connections!.store.setPolicy(t.f!.users.owner.id, {
      runtime: "claude-code",
      allowed: true,
      models: "all",
      efforts: "all",
      allowPersonal: true,
      allowShared: false,
    });
    const row = t.app.schedules!.store.byId(made.id)!;
    expect(t.app.schedules!.warnings!.check(row.next_run_at! - 600_000)).toBe(1);
    const third = await runOnce();
    expect(t.runRow(third.id)).toMatchObject({ status: "failed", error_code: "not_allowed" });
    // And back to personal: usable for both.
    await t.req("owner", "PATCH", `/api/schedules/${made.id}`, { useShared: false });
    t.sql.prepare(`update schedules set next_run_at = next_run_at + 86400000 where id = ?`).run(made.id);
    const next = t.app.schedules!.store.byId(made.id)!.next_run_at!;
    expect(t.app.schedules!.warnings!.check(next - 600_000)).toBe(0);
    const fourth = await runOnce();
    expect(t.runRow(fourth.id).status).toBe("succeeded");
    expect(connOf(fourth.id)).toBe(mine.id);
  });

  it("only the selected skills, of those only what the owner may use now — in the tool list and at the call", async () => {
    const t = await world({
      runTools: true,
      script: (input) =>
        input.text === "call kr"
          ? [{ call: "kr_quote", input: { code: "005930" } }, { text: "done" }]
          : reply("ok"),
    });
    const make = async (skills: string[], prompt = "x") => {
      const r = await t.req("owner", "POST", "/api/schedules", { ...create, prompt, skills });
      expect(r.statusCode).toBe(201);
      return Schedule.parse(r.json());
    };
    const runOf = async (made: Schedule) => {
      const r = ScheduleRun.parse((await t.req("owner", "POST", `/api/schedules/${made.id}/run`)).json().run);
      await until(() => t.finished(r.id));
      return { tools: t.runtime.contexts.at(-1)!.tools, made, run: r };
    };
    const toolsOf = async (skills: string[], prompt = "x") => runOf(await make(skills, prompt));
    const finance = (tools: string[]) => tools.filter((x) => /^(kr|us|sec|dart)_|^finance_chart$/.test(x));
    // Nothing selected: no skill and no finance tool (the built-in tools stay).
    const none = await toolsOf([]);
    expect(finance(none.tools)).toEqual([]);
    expect(none.tools.filter((x) => x.startsWith("skill_"))).toEqual([]);
    expect(none.tools).toContain("artifact_create");
    // US only: the us_* tools and the chart, no Korean ones.
    const us = await toolsOf(["us-stock-skill"]);
    expect(finance(us.tools).some((x) => x.startsWith("us_"))).toBe(true);
    expect(finance(us.tools).some((x) => x.startsWith("kr_"))).toBe(false);
    // A direct call of a tool outside the selection is refused (the MCP server checks the run's scope).
    const direct = await toolsOf(["us-stock-skill"], "call kr");
    const convId = t.app.schedules!.store.byId(direct.made.id)!.conversation_id!;
    const result = t
      .messagesOf(convId)
      .at(-1)!
      .parts.find((p) => p.type === "tool_result");
    expect(result).toMatchObject({ isError: true });
    // Not even offered on the MCP server for this run's token.
    expect(JSON.stringify(result)).toContain("Tool kr_quote not found");
    // A permission taken away before the run is honoured: Korean selected but no longer allowed.
    const krMade = await make(["kr-stock-skill"]);
    t.sql
      .prepare(`update users set permissions = ? where id = ?`)
      .run(
        JSON.stringify({ runtimes: ["claude-code", "codex"], models: "all", skills: ["us-stock-skill"] }),
        t.f!.users.owner.id,
      );
    const kr = await runOf(krMade);
    expect(finance(kr.tools)).toEqual([]);
    // And checked again at the call (a permission or scope that changes between the list and the call).
    type Host = {
      runTool(n: string, i: object, s: object): Promise<{ ok: boolean; code?: string }>;
      runSkill(n: string, i: object, s: object): Promise<{ ok: boolean; code?: string }>;
    };
    // Every skill allowed again: only the scope refuses now.
    t.sql
      .prepare(`update users set permissions = ? where id = ?`)
      .run(
        JSON.stringify({ runtimes: ["claude-code", "codex"], models: "all", skills: "all" }),
        t.f!.users.owner.id,
      );
    const host = (t.app.mcp as unknown as { host(): Host }).host();
    const scope = { userId: t.f!.users.owner.id, conversationId: convId, runId: "r" };
    expect(
      await host.runTool("kr_quote", { code: "005930" }, { ...scope, skills: ["us-stock-skill"] }),
    ).toEqual({
      ok: false,
      code: "finance_not_allowed",
    });
    expect(await host.runSkill("selftest", { text: "a" }, { ...scope, skills: [] })).toEqual({
      ok: false,
      code: "skill_not_allowed",
    });
    expect(
      (await host.runSkill("selftest", { text: "a" }, { ...scope, skills: ["selftest"] })).code,
    ).not.toBe("skill_not_allowed");
  });
});

describe("a result that leaves the history takes its '새 결과' along (review #116)", () => {
  it("regenerated, or an earlier message edited: the marker is clean; a stale seen and a newer result are safe", async () => {
    const t = await world({ script: () => reply("결과") });
    const made = Schedule.parse((await t.req("owner", "POST", "/api/schedules", create)).json());
    const runOnce = async () => {
      const r = ScheduleRun.parse((await t.req("owner", "POST", `/api/schedules/${made.id}/run`)).json().run);
      await until(() => t.finished(r.id) && t.runRow(r.id).notified_at !== null);
      return t.runRow(r.id).result_ref!;
    };
    const conv = async () =>
      Conversation.parse(
        (
          await t.req(
            "owner",
            "GET",
            `/api/conversations/${t.app.schedules!.store.byId(made.id)!.conversation_id}`,
          )
        ).json(),
      );
    const chatEnd = async () => {
      const c = await conv();
      await until(() => !t.app.runs!.active(c.id));
    };
    // The view never managed to show it (seen not called); the owner regenerates the result.
    const r1 = await runOnce();
    const c = await conv();
    expect(c).toMatchObject({ newResult: true, newResultMessageId: r1 });
    const regen = await t.req("owner", "POST", `/api/conversations/${c.id}/messages/${r1}/regenerate`, {});
    expect(regen.statusCode).toBe(200);
    await chatEnd();
    expect(await conv()).toMatchObject({ newResult: false, newResultMessageId: null });
    // Again, and this time an earlier message is edited (the result is cut off with it).
    const r2 = await runOnce();
    expect((await conv()).newResultMessageId).toBe(r2);
    const firstUser = t.messagesOf(c.id).find((m) => m.role === "user")!;
    const edit = await t.req("owner", "POST", `/api/conversations/${c.id}/messages/${firstUser.id}/edit`, {
      text: "고쳐서",
    });
    expect(edit.statusCode).toBe(200);
    await chatEnd();
    expect((await conv()).newResult).toBe(false);
    // Another tab: a seen request for a result an edit already cut off changes nothing (and breaks nothing).
    const r3 = await runOnce();
    const user3 = t
      .messagesOf(c.id)
      .filter((m) => m.role === "user")
      .at(-1)!;
    await t.req("owner", "POST", `/api/conversations/${c.id}/messages/${user3.id}/edit`, { text: "다른 탭" });
    await chatEnd();
    const late = await t.req("owner", "POST", `/api/conversations/${c.id}/result-seen`, { messageId: r3 });
    expect(Conversation.parse(late.json()).newResult).toBe(false);
    // Only the result that leaves: a marker on a message before the cut stays.
    const r4 = await runOnce();
    const before = t.messagesOf(c.id).find((m) => m.role === "assistant")!;
    t.app.conversations!.markNewResult(c.id, before.id);
    const tail = t
      .messagesOf(c.id)
      .filter((m) => m.role === "user")
      .at(-1)!;
    expect(tail.id).not.toBe(before.id);
    await t.req("owner", "POST", `/api/conversations/${c.id}/messages/${tail.id}/edit`, { text: "끝만" });
    await chatEnd();
    expect(await conv()).toMatchObject({ newResult: true, newResultMessageId: before.id });
    expect(r4).not.toBe(before.id);
  });
});

describe("a result saved after it left the history is no '새 결과' (review #116)", () => {
  it("save failed → the owner regenerates → the engine's retry saves: referenced, not marked", async () => {
    let failed = false;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = await world({
      script: () => reply("원래 답"),
      wrap: (h) => ({
        ...bind(h),
        saveResult: async (c, o) => {
          if (!failed) {
            failed = true;
            throw new Error("injected");
          }
          await gate;
          return h.saveResult(c, o);
        },
      }),
    });
    const { s, run } = await runNow(t);
    await until(() => failed);
    const convId = t.app.schedules!.store.byId(s.id)!.conversation_id!;
    const answer = t.runRow(run.id).output_ref
      ? t.app.runs!.get(t.runRow(run.id).output_ref!)!.assistantMessageId
      : "";
    const regen = await t.req(
      "owner",
      "POST",
      `/api/conversations/${convId}/messages/${answer}/regenerate`,
      {},
    );
    expect(regen.statusCode).toBe(200);
    await until(() => !t.app.runs!.active(convId));
    release();
    await until(() => t.finished(run.id) && t.runRow(run.id).notified_at !== null);
    expect(t.runRow(run.id).result_ref).toBe(answer);
    expect(t.app.conversations!.message(convId, answer)!.active).toBe(false);
    expect(
      Conversation.parse((await t.req("owner", "GET", `/api/conversations/${convId}`)).json()),
    ).toMatchObject({
      newResult: false,
      newResultMessageId: null,
    });
    // The next run is marked as usual.
    const next = ScheduleRun.parse((await t.req("owner", "POST", `/api/schedules/${s.id}/run`)).json().run);
    await until(() => t.finished(next.id));
    expect(
      Conversation.parse((await t.req("owner", "GET", `/api/conversations/${convId}`)).json()),
    ).toMatchObject({
      newResult: true,
      newResultMessageId: t.runRow(next.id).result_ref,
    });
  });

  it("the server dies before saving → an earlier question is edited → the restart saves: not marked, nothing else touched", async () => {
    const db = createTestDb();
    let reached = false;
    const a = await world({
      db,
      script: () => reply("원래 답"),
      wrap: (h) => ({ ...bind(h), saveResult: () => ((reached = true), never()) }),
    });
    const { s, run } = await runNow(a);
    await until(() => reached);
    await a.app.close();
    closers.splice(closers.indexOf(closers.at(-1)!), 1);
    const convId = a.app.schedules!.store.byId(s.id)!.conversation_id!;
    const user = a.messagesOf(convId).find((m) => m.role === "user")!;
    const answer = a.app.runs!.get(a.runRow(run.id).output_ref!)!.assistantMessageId;
    expect(a.app.conversations!.edit(convId, user.id, "고친 질문")).toBeDefined();
    const b = await world({ db, script: () => reply("x"), family: false });
    await until(() => b.finished(run.id) && b.runRow(run.id).notified_at !== null);
    expect(b.runRow(run.id).result_ref).toBe(answer);
    expect(b.app.conversations!.get(convId)).toMatchObject({ newResultAt: null, newResultMessageId: null });
  });
});
