import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { CSRF_HEADER, type Run } from "@agentlee/shared";
import { eq } from "drizzle-orm";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb, type Db } from "../src/db/client.js";
import { usageRecords, users } from "../src/db/schema.js";
import {
  RuntimeRegistry,
  type RuntimeAdapter,
  type RuntimeEvent,
  type RuntimeSession,
  type UsageReport,
} from "../src/runtime/adapter.js";
import { FakeRuntime, type FakeScript } from "../src/runtime/fake.js";
import { UsageStore, type UsageAttempt } from "../src/usage/store.js";
import { createFamily } from "./helpers/permission-matrix.js";

type App = Awaited<ReturnType<typeof buildApp>>;
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

const rows = (db: Db) => db.select().from(usageRecords).all();

describe("usage store (#44): one row per run attempt", () => {
  function store() {
    const db = createTestDb();
    db.insert(users).values({ id: "u1", email: "u1@example.com", name: "u1", role: "member" }).run();
    let clock = 1000;
    const usage = new UsageStore(db, () => clock++);
    const attempt = (n: number, runId = "run-1"): UsageAttempt => ({
      userId: "u1",
      conversationId: "conv-1",
      runId,
      attempt: n,
      runtime: "claude-code",
      model: "opus",
      connectionId: "conn-1",
      purpose: "chat",
    });
    return { db, usage, attempt };
  }

  it("the same attempt twice → one row, and the last report wins (no double counting)", () => {
    const { db, usage, attempt } = store();
    usage.record(attempt(1), { inputTokens: 100, outputTokens: 10, costUsd: 0.01 });
    usage.record(attempt(1), { inputTokens: 100, outputTokens: 10, costUsd: 0.01 }); // duplicate
    expect(rows(db)).toHaveLength(1);
    // A later, larger report of the same attempt replaces the earlier figures.
    usage.record(attempt(1), { inputTokens: 150, outputTokens: 20, cacheReadTokens: 50, costUsd: 0.02 });
    const all = rows(db);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      attempt: 1,
      inputTokens: 150,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheWriteTokens: null,
      costUsd: 0.02,
      requestCount: 1,
      createdAt: 1000,
      updatedAt: 1002,
    });
  });

  it("a retry (a new attempt of the same run) and another run → rows of their own", () => {
    const { db, usage, attempt } = store();
    usage.record(attempt(1), { inputTokens: 100, outputTokens: 0 });
    usage.record(attempt(2), { inputTokens: 120, outputTokens: 30 });
    usage.record(attempt(1, "run-2"), { inputTokens: 5, outputTokens: 5 });
    expect(rows(db).map((r) => [r.runId, r.attempt, r.inputTokens])).toEqual([
      ["run-1", 1, 100],
      ["run-1", 2, 120],
      ["run-2", 1, 5],
    ]);
    expect(usage.forRun("run-1").map((r) => r.attempt)).toEqual([1, 2]);
  });

  it("figures the runtime did not report are NULL, not 0; nonsense values are NULL too", () => {
    const { db, usage, attempt } = store();
    usage.record(attempt(1), {});
    expect(rows(db)[0]).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
      requestCount: 1,
    });
    usage.record(attempt(2), { inputTokens: -1, outputTokens: 1.5, costUsd: Number.NaN, cacheReadTokens: 0 });
    expect(rows(db)[1]).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: 0,
      costUsd: null,
    });
  });
});

/** A runtime whose turn waits until it is interrupted, then reports its usage and ends. */
function stoppingRuntime(report: UsageReport): RuntimeAdapter {
  return {
    id: "claude-code",
    capabilities: () => ({
      models: [{ id: "m", label: "M", efforts: [] }],
      canSwitchModelInSession: false,
      canResume: false,
      usesTools: false,
    }),
    resume: () => Promise.reject(new Error("no resume")),
    start: async (): Promise<RuntimeSession> => ({
      externalSessionId: "s",
      setModel: async () => {},
      close: async () => {},
      turn: () => {
        let stop!: () => void;
        const stopped = new Promise<void>((r) => (stop = r));
        async function* events(): AsyncGenerator<RuntimeEvent> {
          yield { type: "text_delta", text: "부분 " };
          await stopped;
          yield { type: "usage", ...report };
        }
        return { events: events(), interrupt: async () => stop() };
      },
    }),
  };
}

async function start(script: FakeScript, graceMs = 3000, adapter?: RuntimeAdapter) {
  const db = createTestDb();
  const runtimes = new RuntimeRegistry();
  const fake = new FakeRuntime({ script });
  runtimes.register(adapter ?? fake);
  const lines: string[] = [];
  const logStream = new Writable({ write: (c, _e, cb) => (lines.push(String(c)), cb()) });
  const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
    db,
    logStream,
    runtimes,
    runs: { flushMs: 0, interruptGraceMs: graceMs },
  });
  apps.push(app);
  const f = await createFamily(app);
  const headers = {
    host: "localhost:3000",
    cookie: f.cookies.owner,
    origin: "http://localhost:3000",
    [CSRF_HEADER]: "1",
    "content-type": "application/json",
  };
  const conversation = () => app.conversations!.create(f.users.owner.id);
  const send = async (conversationId: string, text: string) =>
    (
      await app.inject({
        method: "POST",
        url: `/api/conversations/${conversationId}/messages`,
        headers,
        payload: { text },
      })
    ).json<{ run: Run; assistant: { id: string } }>();
  const waitRun = async (id: string, until = (r: { endedAt: number | null }) => r.endedAt !== null) => {
    for (let i = 0; i < 500; i++) {
      const r = app.runs!.get(id)!;
      if (until(r)) return r;
      await new Promise((res) => setTimeout(res, 5));
    }
    throw new Error("run did not reach the state");
  };
  const waitUsage = async (runId: string) => {
    for (let i = 0; i < 500; i++) {
      if (rows(db).some((r) => r.runId === runId)) return;
      await new Promise((res) => setTimeout(res, 5));
    }
    throw new Error("no usage row");
  };
  /** The `run.finished` log record of a run (its totals are each attempt's last report). */
  const finished = (runId: string) =>
    lines
      .join("")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .find((l) => l.msg === "run.finished" && l.runId === runId);
  return { app, db, f, fake, headers, conversation, send, waitRun, waitUsage, finished };
}

describe("runs record usage (#44)", () => {
  it("a reply's usage → one chat row with its user, conversation, run, runtime and model; duplicates and replays add nothing", async () => {
    const t = await start(() => [
      { text: "안녕" },
      { usage: { inputTokens: 100, outputTokens: 5, cacheReadTokens: 80, cacheWriteTokens: 0 } },
      // The same attempt reported again (e.g. a runtime that sends its total twice): replaces, not adds.
      {
        usage: { inputTokens: 120, outputTokens: 7, cacheReadTokens: 80, cacheWriteTokens: 0, costUsd: 0.03 },
      },
    ]);
    const c = t.conversation();
    const { run } = await t.send(c.id, "질문");
    expect((await t.waitRun(run.id)).status).toBe("done");
    // Reading the stream again (a reconnect replays from the stored events) records nothing.
    const replay = await t.app.inject({ url: `/api/runs/${run.id}/events`, headers: t.headers });
    expect(replay.statusCode).toBe(200);
    expect(rows(t.db)).toEqual([
      expect.objectContaining({
        userId: t.f.users.owner.id,
        conversationId: c.id,
        runId: run.id,
        attempt: 1,
        runtime: "claude-code",
        model: "fake-large",
        connectionId: null,
        purpose: "chat",
        inputTokens: 120,
        outputTokens: 7,
        cacheReadTokens: 80,
        cacheWriteTokens: 0,
        costUsd: 0.03,
        requestCount: 1,
      }),
    ]);
    // The log record's totals follow the same rule: the last report, not the sum of both.
    expect(t.finished(run.id)).toMatchObject({ inputTokens: 120, outputTokens: 7, costUsd: 0.03 });
  });

  it("a last report without a cost: the row and the log have no cost (last one wins for every figure)", async () => {
    const t = await start(() => [
      { text: "안녕" },
      { usage: { inputTokens: 100, outputTokens: 5, costUsd: 0.03 } },
      { usage: { inputTokens: 100, outputTokens: 5, costUsd: 0.03 } },
      { usage: { inputTokens: 130, outputTokens: 9 } },
    ]);
    const { run } = await t.send(t.conversation().id, "질문");
    await t.waitRun(run.id);
    expect(rows(t.db)).toEqual([
      expect.objectContaining({ inputTokens: 130, outputTokens: 9, costUsd: null }),
    ]);
    const log = t.finished(run.id)!;
    expect(log).toMatchObject({ inputTokens: 130, outputTokens: 9 });
    expect(log).not.toHaveProperty("costUsd");
  });

  it("an interrupted run still records the usage that arrived before it stopped", async () => {
    const t = await start(() => [
      { usage: { inputTokens: 50, outputTokens: 2 } },
      ...Array.from({ length: 300 }, (_, i) => [{ text: `w${i} ` }, { delayMs: 10 }]).flat(),
    ]);
    const { run } = await t.send(t.conversation().id, "x");
    await t.waitUsage(run.id);
    await t.app.runs!.interrupt(run.id);
    expect((await t.waitRun(run.id)).status).toBe("interrupted");
    expect(rows(t.db)).toEqual([
      expect.objectContaining({ runId: run.id, attempt: 1, inputTokens: 50, outputTokens: 2 }),
    ]);
  });

  it("an interrupted run records the final usage the runtime reports while stopping", async () => {
    // Like Claude after interrupt(): the turn ends with a final usage report (error_during_execution + usage).
    const t = await start(
      () => [],
      3000,
      stoppingRuntime({ inputTokens: 70, outputTokens: 3, costUsd: 0.004 }),
    );
    const { run } = await t.send(t.conversation().id, "x");
    await t.waitRun(run.id, (r) => (r as { status: string }).status === "running");
    await new Promise((res) => setTimeout(res, 20));
    await t.app.runs!.interrupt(run.id);
    expect((await t.waitRun(run.id)).status).toBe("interrupted");
    expect(rows(t.db)).toEqual([
      expect.objectContaining({ runId: run.id, inputTokens: 70, outputTokens: 3, costUsd: 0.004 }),
    ]);
  });

  it("a failed run records the usage reported before the failure", async () => {
    const t = await start(() => [{ usage: { inputTokens: 30, outputTokens: 1 } }, { fail: "boom" }]);
    const { run } = await t.send(t.conversation().id, "x");
    expect((await t.waitRun(run.id)).status).toBe("failed");
    expect(rows(t.db)).toEqual([expect.objectContaining({ runId: run.id, inputTokens: 30 })]);
  });

  it("each run of a conversation (a regenerate is a new run) has its own row", async () => {
    const t = await start(() => [{ text: "a" }, { usage: { inputTokens: 1, outputTokens: 1 } }]);
    const c = t.conversation();
    const first = await t.send(c.id, "x");
    await t.waitRun(first.run.id);
    const again = await t.app.inject({
      method: "POST",
      url: `/api/conversations/${c.id}/messages/${first.assistant.id}/regenerate`,
      headers: t.headers,
      payload: {},
    });
    const second = again.json<{ run: Run }>().run;
    await t.waitRun(second.id);
    expect(
      rows(t.db)
        .map((r) => r.runId)
        .sort(),
    ).toEqual([first.run.id, second.id].sort());
  });

  it("a runtime that reports only some figures leaves the rest NULL", async () => {
    const t = await start(() => [{ text: "a" }, { usage: { outputTokens: 3 } }]);
    const { run } = await t.send(t.conversation().id, "x");
    await t.waitRun(run.id);
    expect(rows(t.db)[0]).toMatchObject({
      inputTokens: null,
      outputTokens: 3,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
    });
  });

  it("stores no content: no prompt or reply text, only IDs, names and numbers", async () => {
    const secret = "비밀문장-SECRET-7f3a";
    const t = await start((input) => [
      { text: `답: ${input.text}` },
      { usage: { inputTokens: 10, outputTokens: 2 } },
    ]);
    const { run } = await t.send(t.conversation().id, secret);
    await t.waitRun(run.id);
    expect(JSON.stringify(rows(t.db))).not.toContain("SECRET");
    const columns = t.db.$client
      .prepare("select name from pragma_table_info('usage_records') order by cid")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(columns).toEqual([
      "id",
      "user_id",
      "conversation_id",
      "run_id",
      "attempt",
      "runtime",
      "model",
      "connection_id",
      "purpose",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "cost_usd",
      "request_count",
      "created_at",
      "updated_at",
      "auth_type",
      "price_version",
      "priced_cost_micros",
    ]);
  });

  it("purpose is a run parameter: a scheduled run (#33) records as schedule", async () => {
    const t = await start(() => [{ text: "a" }, { usage: { inputTokens: 2, outputTokens: 2 } }]);
    const c = t.conversation();
    const store = t.app.conversations!;
    const { run } = t.app.runs!.begin({
      conversationId: c.id,
      userId: t.f.users.owner.id,
      purpose: "schedule",
      prepare: () => ({
        user: store.append(c.id, { role: "user", parts: [{ type: "text", text: "매일 아침 요약" }] }),
        assistant: store.append(c.id, { role: "assistant", parts: [], status: "pending" }),
      }),
    });
    await t.waitRun(run.id);
    expect(rows(t.db)).toEqual([expect.objectContaining({ runId: run.id, purpose: "schedule" })]);
  });

  it("usage outlives a deleted conversation (totals must not shrink)", async () => {
    const t = await start(() => [{ text: "a" }, { usage: { inputTokens: 4, outputTokens: 4 } }]);
    const c = t.conversation();
    const { run } = await t.send(c.id, "x");
    await t.waitRun(run.id);
    t.app.conversations!.delete(c.id);
    expect(t.db.select().from(usageRecords).where(eq(usageRecords.runId, run.id)).all()).toHaveLength(1);
  });
});
