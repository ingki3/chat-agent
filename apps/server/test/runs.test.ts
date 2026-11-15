import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { CSRF_HEADER, Message, StartRunResponse, type Run, type StreamEvent } from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { runs as runsTable } from "../src/db/schema.js";
import {
  ExitUnconfirmedError,
  RuntimeFailure,
  RuntimeRegistry,
  SessionGoneError,
  type RuntimeAdapter,
  type RuntimeEvent,
  type RuntimeSession,
} from "../src/runtime/adapter.js";
import { FakeRuntime, type FakeScript } from "../src/runtime/fake.js";
import { EVENT_RETENTION_MS, RunManager } from "../src/runtime/runs.js";
import { createFamily } from "./helpers/permission-matrix.js";
import { runtimeContract } from "./helpers/runtime-contract.js";

type App = Awaited<ReturnType<typeof buildApp>>;
const apps: App[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close();
});

runtimeContract("FakeRuntime", () => new FakeRuntime(), {
  short: "안녕 반가워",
  long: "/long 100",
  remember: "내 이름은 토마토야",
  recall: "기억나?",
  recallCheck: (answer) => /2번째/.test(answer),
});

let clock = 0;
async function start(
  opts: {
    script?: FakeScript;
    heartbeatMs?: number;
    noRuntime?: boolean;
    adapter?: RuntimeAdapter;
    canResume?: boolean;
    graceMs?: number;
    beforeListen?: (app: App) => void;
  } = {},
) {
  const db = createTestDb();
  const runtimes = new RuntimeRegistry();
  const fake = new FakeRuntime({
    ...(opts.script ? { script: opts.script } : {}),
    ...(opts.canResume === undefined ? {} : { canResume: opts.canResume }),
  });
  if (opts.adapter) runtimes.register(opts.adapter);
  else if (!opts.noRuntime) runtimes.register(fake);
  clock = Date.now();
  const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
    db,
    logger: false,
    runtimes,
    runs: { flushMs: 0, interruptGraceMs: opts.graceMs ?? 3000 },
    sse: { heartbeatMs: opts.heartbeatMs ?? 1000 },
  });
  apps.push(app);
  opts.beforeListen?.(app);
  const f = await createFamily(app);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const headers = (cookie: string, extra: Record<string, string> = {}) => ({
    host: "localhost:3000",
    cookie,
    origin: "http://localhost:3000",
    [CSRF_HEADER]: "1",
    "content-type": "application/json",
    ...extra,
  });
  const as = (cookie: string) => ({
    get: (url: string) => app.inject({ url, headers: { host: "localhost:3000", cookie } }),
    post: (url: string, payload: object = {}, extra: Record<string, string> = {}) =>
      app.inject({ method: "POST", url, headers: headers(cookie, extra), payload }),
  });
  const mom = as(f.cookies.owner);
  const conversation = () => app.conversations!.create(f.users.owner.id);
  const send = async (conversationId: string, text: string, extra: Record<string, string> = {}) =>
    mom.post(`/api/conversations/${conversationId}/messages`, { text }, extra);
  /** Opens the event stream (real HTTP, since it is SSE) and collects frames. */
  const stream = (
    runId: string,
    opts2: { cookie?: string; lastEventId?: number; signal?: AbortSignal } = {},
  ) =>
    openEvents(
      `${base}/api/runs/${runId}/events`,
      {
        cookie: opts2.cookie ?? f.cookies.owner,
        ...(opts2.lastEventId === undefined ? {} : { "last-event-id": String(opts2.lastEventId) }),
      },
      opts2.signal,
    );
  const waitRun = async (id: string, done = (r: Run) => r.endedAt !== null) => {
    for (let i = 0; i < 400; i++) {
      const r = (await mom.get(`/api/runs/${id}`)).json<Run>();
      if (done(r)) return r;
      await new Promise((res) => setTimeout(res, 10));
    }
    throw new Error("run did not finish");
  };
  return { app, db, f, fake, mom, as, conversation, send, stream, waitRun, base };
}

type Frame = { id?: number; event?: string; data?: StreamEvent; comment?: string };
async function openEvents(url: string, headers: Record<string, string>, signal?: AbortSignal) {
  const res = await fetch(url, {
    headers: { host: "localhost:3000", ...headers },
    ...(signal ? { signal } : {}),
  });
  const frames: Frame[] = [];
  let buf = "";
  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  const parse = () => {
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const f: Frame = {};
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) f.comment = line.slice(1).trim();
        else if (line.startsWith("id: ")) f.id = Number(line.slice(4));
        else if (line.startsWith("event: ")) f.event = line.slice(7);
        else if (line.startsWith("data: ")) f.data = JSON.parse(line.slice(6)) as StreamEvent;
      }
      frames.push(f);
    }
  };
  /** Reads until `until(frames)` is true or the stream ends. */
  const read = async (until: (f: Frame[]) => boolean = () => false) => {
    while (reader && !until(frames)) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) return { frames, ended: true };
      buf += decoder.decode(value, { stream: true });
      parse();
    }
    return { frames, ended: false };
  };
  return { status: res.status, frames, read, cancel: () => reader?.cancel().catch(() => {}) };
}
const events = (frames: Frame[]) => frames.filter((f) => f.data).map((f) => f.data!);
const textOf = (frames: Frame[]) =>
  events(frames)
    .flatMap((e) => (e.type === "delta" ? [e.text] : []))
    .join("");

describe("runs: send and stream", () => {
  it("streams a reply, saves it, and keeps reasoning out of the stream and the API", async () => {
    const { mom, conversation, send, stream, waitRun } = await start();
    const c = conversation();
    const r = await send(c.id, "사과 바나나");
    expect(r.statusCode).toBe(201);
    const body = StartRunResponse.parse(r.json());
    expect(body.message?.parts).toEqual([{ type: "text", text: "사과 바나나" }]);
    expect(body.assistant).toMatchObject({ role: "assistant", runtime: "claude-code", model: "fake-large" });

    const s = await stream(body.run.id);
    expect(s.status).toBe(200);
    const { frames, ended } = await s.read();
    expect(ended).toBe(true);
    const evs = events(frames);
    expect(evs.at(-1)).toEqual({ type: "done", messageId: body.assistant.id, status: "complete" });
    expect(textOf(frames)).toMatch(/사과 바나나/);
    expect(evs.some((e) => e.type === "usage")).toBe(true);
    // Ids are 1..n without gaps.
    expect(frames.filter((f) => f.data).map((f) => f.id)).toEqual(evs.map((_, i) => i + 1));
    expect(JSON.stringify(frames)).not.toMatch(/되풀이한다/);

    expect((await waitRun(body.run.id)).status).toBe("done");
    const list = (await mom.get(`/api/conversations/${c.id}/messages`)).json().items as Message[];
    const reply = list.at(-1)!;
    expect(reply).toMatchObject({ status: "complete", role: "assistant" });
    expect(reply.parts).toEqual([{ type: "text", text: textOf(frames) }]);
    expect(JSON.stringify(list)).not.toMatch(/되풀이한다/);
  });

  it("same Idempotency-Key twice → one run, one user message; reused on another conversation → 409", async () => {
    const { app, conversation, send, waitRun } = await start();
    const c = conversation();
    const k = { "idempotency-key": "key-12345678" };
    const [a, b] = await Promise.all([send(c.id, "한 번만", k), send(c.id, "한 번만", k)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(a.json().run.id).toBe(b.json().run.id);
    await waitRun(a.json().run.id);
    const again = await send(c.id, "한 번만", k);
    expect(again.statusCode).toBe(200);
    expect(again.json().run.id).toBe(a.json().run.id);
    const users = app.conversations!.messages(c.id, { limit: 100 }).filter((m) => m.role === "user");
    expect(users).toHaveLength(1);
    expect((await send(conversation().id, "x", k)).statusCode).toBe(409);
    expect((await send(c.id, "x", { "idempotency-key": "bad key!" })).statusCode).toBe(400);
  });

  it("allows one run per conversation at a time", async () => {
    const { conversation, send, waitRun } = await start({ script: () => [{ delayMs: 200 }, { text: "끝" }] });
    const c = conversation();
    const first = await send(c.id, "하나");
    const second = await send(c.id, "둘");
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: "run_in_progress" });
    // Another conversation is not blocked.
    expect((await send(conversation().id, "다른 대화")).statusCode).toBe(201);
    await waitRun(first.json().run.id);
    expect((await send(c.id, "셋")).statusCode).toBe(201);
  });

  it("fails cleanly without a runtime, and without leaking runtime error text", async () => {
    const none = await start({ noRuntime: true });
    const r = await none.send(none.conversation().id, "x");
    expect(r.json().run).toMatchObject({ status: "failed", errorCode: "no_runtime" });

    const broken = await start({ script: () => [{ text: "잠시" }, { fail: "SECRET internal stack" }] });
    const run = (await broken.send(broken.conversation().id, "x")).json().run as Run;
    const { frames } = await (await broken.stream(run.id)).read();
    expect(events(frames).find((e) => e.type === "error")).toMatchObject({ code: "runtime_error" });
    expect(JSON.stringify(frames)).not.toMatch(/SECRET/);
    expect((await broken.waitRun(run.id)).status).toBe("failed");
  });

  it("turns a usage-limit signal into a notice and a failed run", async () => {
    const { conversation, send, stream } = await start({ script: () => [{ limit: "한도 도달" }] });
    const run = (await send(conversation().id, "x")).json().run as Run;
    const evs = events((await (await stream(run.id)).read()).frames);
    expect(evs.map((e) => e.type)).toEqual(["notice", "error", "done"]);
    expect(evs[1]).toMatchObject({ code: "usage_limit" });
  });
});

describe("runs: reconnect, keep-alive, interrupt", () => {
  it("reconnecting with Last-Event-ID replays the rest without duplicates or gaps", async () => {
    const { conversation, send, stream, waitRun, base, f } = await start({
      script: () => Array.from({ length: 30 }, (_, i) => [{ text: `${i} ` }, { delayMs: 5 }]).flat(),
    });
    const run = (await send(conversation().id, "x")).json().run as Run;
    const first = await stream(run.id);
    await first.read((f) => f.filter((x) => x.data).length >= 7);
    await first.cancel();
    const lastId = first.frames.filter((x) => x.data).at(-1)!.id!;
    const second = await stream(run.id, { lastEventId: lastId });
    const rest = (await second.read()).frames.filter((x) => x.data);
    await waitRun(run.id);
    const full = (await (await stream(run.id)).read()).frames.filter((x) => x.data);
    const stitched = [...first.frames.filter((x) => x.data && x.id! <= lastId), ...rest];
    expect(stitched.map((x) => x.id)).toEqual(full.map((x) => x.id));
    expect(stitched.map((x) => x.data)).toEqual(full.map((x) => x.data));
    // ?lastEventId= works too (EventSource cannot set headers on the first connect).
    const viaQuery = await openEvents(`${base}/api/runs/${run.id}/events?lastEventId=${lastId}`, {
      cookie: f.cookies.owner,
    });
    expect((await viaQuery.read()).frames.filter((x) => x.data).map((x) => x.id)).toEqual(
      rest.map((x) => x.id),
    );
  });

  it("keeps the connection alive through a long silent tool call", async () => {
    const { conversation, send, stream } = await start({
      heartbeatMs: 100,
      script: () => [{ text: "시작 " }, { tool: "slow", ms: 1500 }, { text: "끝" }],
    });
    const run = (await send(conversation().id, "x")).json().run as Run;
    const { frames, ended } = await (await stream(run.id)).read();
    expect(ended).toBe(true);
    const toolStart = frames.findIndex((f) => f.data?.type === "tool_start");
    const toolEnd = frames.findIndex((f) => f.data?.type === "tool_end");
    // Keep-alive comments flowed while the tool was silent.
    expect(frames.slice(toolStart, toolEnd).filter((f) => f.comment === "hb").length).toBeGreaterThanOrEqual(
      10,
    );
    expect(events(frames).at(-1)).toMatchObject({ type: "done", status: "complete" });
  });

  it("interrupt stops the reply and keeps the partial text as stopped", async () => {
    const { mom, conversation, send, stream, waitRun } = await start({
      script: () => Array.from({ length: 200 }, (_, i) => [{ text: `w${i} ` }, { delayMs: 10 }]).flat(),
    });
    const c = conversation();
    const run = (await send(c.id, "x")).json().run as Run;
    const s = await stream(run.id);
    await s.read((f) => f.filter((x) => x.data?.type === "delta").length >= 5);
    const r = await mom.post(`/api/runs/${run.id}/interrupt`);
    expect(r.statusCode).toBe(200);
    const end = await waitRun(run.id);
    expect(end.status).toBe("interrupted");
    const { frames } = await s.read();
    expect(events(frames).at(-1)).toMatchObject({ type: "done", status: "stopped" });
    const reply = app_last(await mom.get(`/api/conversations/${c.id}/messages`));
    expect(reply.status).toBe("stopped");
    const saved = (reply.parts[0] as { text: string }).text;
    expect(saved.length).toBeGreaterThan(0);
    expect(saved.split(" ").length).toBeLessThan(200);
    // Interrupting again is harmless.
    expect((await mom.post(`/api/runs/${run.id}/interrupt`)).json().status).toBe("interrupted");
  });

  it("keeps running when the browser goes away; reopening shows the whole reply", async () => {
    const { conversation, send, stream, waitRun } = await start({
      script: () => Array.from({ length: 20 }, (_, i) => [{ text: `${i} ` }, { delayMs: 10 }]).flat(),
    });
    const run = (await send(conversation().id, "x")).json().run as Run;
    const s = await stream(run.id);
    await s.read((f) => f.filter((x) => x.data).length >= 2);
    await s.cancel();
    expect((await waitRun(run.id)).status).toBe("done");
    const again = await (await stream(run.id)).read();
    expect(textOf(again.frames).trim().split(" ")).toHaveLength(20);
  });
});

describe("runs: sessions, permissions, restart, retention", () => {
  it("resumes the runtime session for the next message; an edit starts a new one", async () => {
    const { app, conversation, send, waitRun, mom } = await start();
    const c = conversation();
    const r1 = (await send(c.id, "첫째")).json() as { run: Run; message: Message };
    await waitRun(r1.run.id);
    const r2 = (await send(c.id, "둘째")).json() as { run: Run; assistant: Message };
    await waitRun(r2.run.id);
    const second = app.conversations!.messageById(r2.assistant.id)!;
    expect(JSON.stringify(second.parts)).toMatch(/2번째/);
    expect(app.conversations!.sessions(c.id)).toHaveLength(1);

    const edit = await mom.post(`/api/conversations/${c.id}/messages/${r1.message.id}/edit`, {
      text: "고친 첫째",
    });
    expect(edit.statusCode).toBe(200);
    await waitRun(edit.json().run.id);
    const sessions = app.conversations!.sessions(c.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.conversationRevision).toBe(1);
    const reply = app.conversations!.messageById(edit.json().assistant.id)!;
    expect(JSON.stringify(reply.parts)).not.toMatch(/번째/);
  });

  it("falls back to a fresh session when the runtime lost the old one", async () => {
    const { app, fake, conversation, send, waitRun } = await start();
    const c = conversation();
    await waitRun((await send(c.id, "첫째")).json().run.id);
    const old = app.conversations!.sessions(c.id)[0]!;
    fake.forget(old.externalSessionId);
    const r = (await send(c.id, "둘째")).json();
    expect((await waitRun(r.run.id)).status).toBe("done");
    const now = app.conversations!.sessions(c.id);
    expect(now.map((s) => s.externalSessionId)).not.toContain(old.externalSessionId);
  });

  it("regenerate streams a new reply in place of the old one", async () => {
    const { mom, conversation, send, waitRun, stream } = await start();
    const c = conversation();
    const first = (await send(c.id, "질문")).json();
    await waitRun(first.run.id);
    const r = await mom.post(`/api/conversations/${c.id}/messages/${first.assistant.id}/regenerate`);
    expect(r.statusCode).toBe(200);
    const body = StartRunResponse.parse(r.json());
    expect(body.assistant.replaces).toBe(first.assistant.id);
    const { frames } = await (await stream(body.run.id)).read();
    expect(events(frames).at(-1)).toMatchObject({
      type: "done",
      messageId: body.assistant.id,
      status: "complete",
    });
  });

  it("other users cannot read or stop a run", async () => {
    const { f, as, conversation, send, stream } = await start({
      script: () => [{ delayMs: 300 }, { text: "x" }],
    });
    const run = (await send(conversation().id, "x")).json().run as Run;
    const son = as(f.cookies.shared);
    expect((await son.get(`/api/runs/${run.id}`)).statusCode).toBe(403);
    expect((await son.post(`/api/runs/${run.id}/interrupt`)).statusCode).toBe(403);
    expect((await stream(run.id, { cookie: f.cookies.shared })).status).toBe(403);
    expect((await as(f.cookies.admin).get(`/api/runs/${run.id}`)).statusCode).toBe(403);
  });

  it("deactivating the user closes their open stream and stops their run", async () => {
    const { app, f, conversation, send, stream, waitRun } = await start({
      script: () => Array.from({ length: 300 }, (_, i) => [{ text: `${i} ` }, { delayMs: 10 }]).flat(),
    });
    const run = (await send(conversation().id, "x")).json().run as Run;
    const s = await stream(run.id);
    await s.read((fr) => fr.filter((x) => x.data).length >= 3);
    app.users!.deactivate(f.users.owner.id);
    const { ended } = await s.read();
    expect(ended).toBe(true);
    const row = app.runs!.get(run.id)!;
    for (let i = 0; i < 100 && !row.endedAt; i++) await new Promise((r) => setTimeout(r, 10));
    expect(app.runs!.get(run.id)!.status).toBe("interrupted");
    void waitRun;
  });

  it("closes the stream when the session is revoked, while the run itself goes on", async () => {
    const { app, f, conversation, send, stream } = await start({
      script: () => Array.from({ length: 300 }, (_, i) => [{ text: `${i} ` }, { delayMs: 10 }]).flat(),
    });
    const run = (await send(conversation().id, "x")).json().run as Run;
    const s = await stream(run.id);
    await s.read((fr) => fr.filter((x) => x.data).length >= 3);
    // A password change elsewhere ends every session of the user.
    app.users!.setPassword(f.users.owner.id, f.users.owner.passwordHash!);
    const { ended, frames } = await s.read();
    expect(ended).toBe(true);
    expect(events(frames).some((e) => e.type === "done")).toBe(false);
    expect(app.runs!.get(run.id)!.status).toBe("running");
    await app.runs!.interrupt(run.id);
  });

  it("after a restart, runs that were running are failed with a notice", async () => {
    const { app, db, conversation, send, stream } = await start({ script: () => [{ delayMs: 5000 }] });
    const c = conversation();
    const run = (await send(c.id, "x")).json().run as Run;
    // Simulate the process dying mid-run: a new manager over the same database recovers.
    const manager = new RunManager(db, app.conversations!, new RuntimeRegistry(), app.appEvents);
    db.update(runsTable).set({ status: "running" }).run();
    expect(manager.recover()).toBeGreaterThanOrEqual(1);
    const row = manager.get(run.id)!;
    expect(row).toMatchObject({ status: "failed", errorCode: "server_restart" });
    expect(app.conversations!.messageById(row.assistantMessageId)!.status).toBe("error");
    const evs = manager.eventsAfter(run.id, 0).map((e) => e.data);
    expect(evs.slice(-2)).toEqual([
      { type: "error", code: "server_restart", message: expect.stringMatching(/서버 재시작/) },
      { type: "done", messageId: row.assistantMessageId, status: "error" },
    ]);
    void stream;
  });

  it("keeps events for an hour after the run ends, then answers 410", async () => {
    const { app, db, conversation, send, waitRun, mom } = await start();
    const run = (await send(conversation().id, "x")).json().run as Run;
    await waitRun(run.id);
    expect(app.runs!.purgeEvents()).toBe(0);
    db.update(runsTable)
      .set({ endedAt: Date.now() - EVENT_RETENTION_MS - 1000 })
      .run();
    expect(app.runs!.purgeEvents()).toBeGreaterThan(0);
    expect((await mom.get(`/api/runs/${run.id}/events`)).statusCode).toBe(410);
    void clock;
  });
});

function app_last(res: { json: () => { items: Message[] } }): Message {
  return res.json().items.at(-1)!;
}

/** A runtime that hangs: its turn never ends and interrupt() does nothing (or its session never opens). */
function stuckRuntime(mode: "turn" | "start"): RuntimeAdapter {
  const session: RuntimeSession = {
    externalSessionId: "stuck",
    setModel: async () => {},
    close: async () => {},
    turn: () => ({
      events: (async function* (): AsyncGenerator<RuntimeEvent> {
        yield { type: "text_delta", text: "부분 " };
        yield { type: "text_delta", text: "응답" };
        await new Promise(() => {}); // never ends
      })(),
      interrupt: async () => {
        throw new Error("cannot interrupt");
      },
    }),
  };
  return {
    id: "claude-code",
    capabilities: () => ({
      models: [{ id: "stuck", label: "Stuck", efforts: [] }],
      canSwitchModelInSession: false,
      canResume: false,
    }),
    start: () => (mode === "start" ? new Promise(() => {}) : Promise.resolve(session)),
    resume: () => Promise.reject(new Error("no")),
  };
}

describe("runs: robustness (review #74)", () => {
  it("replays nothing when access was revoked between the request check and the stream", async () => {
    const { f, conversation, send, waitRun, base } = await start({
      // After the resource check, before the handler: end the session.
      beforeListen: (a) =>
        a.addHook("preHandler", async (req) => {
          if (req.headers["x-revoke"] && req.ctx.sessionToken) a.users!.deleteSession(req.ctx.sessionToken);
        }),
    });
    const run = (await send(conversation().id, "x")).json().run as Run;
    await waitRun(run.id);
    const r = await openEvents(`${base}/api/runs/${run.id}/events`, {
      cookie: f.cookies.owner,
      "x-revoke": "1",
    });
    const { frames, ended } = await r.read();
    expect(ended).toBe(true);
    expect(frames.filter((x) => x.data)).toEqual([]);
  }, 10_000);

  it("deleting the conversation during a run stops it cleanly", async () => {
    const { app, fake, conversation, send, stream } = await start({
      script: () => Array.from({ length: 200 }, (_, i) => [{ text: `${i} ` }, { delayMs: 10 }]).flat(),
    });
    const c = conversation();
    const run = (await send(c.id, "x")).json().run as Run;
    const s = await stream(run.id);
    await s.read((fr) => fr.filter((x) => x.data).length >= 3);
    const t0 = Date.now();
    app.conversations!.delete(c.id);
    expect((await s.read()).ended).toBe(true);
    // Promptly — not when the (2-second) reply would have finished on its own.
    expect(Date.now() - t0).toBeLessThan(500);
    await new Promise((r) => setTimeout(r, 100)); // let the runtime notice; nothing may throw meanwhile
    expect(app.runs!.liveCount()).toBe(0);
    expect(app.runs!.get(run.id)).toBeUndefined();
    expect(fake.closed).toBe(fake.opened);
  });

  it("a runtime that ignores interrupt is not waited for: the run ends after the grace period", async () => {
    const { app, mom, conversation, send, waitRun } = await start({
      adapter: stuckRuntime("turn"),
      graceMs: 150,
    });
    const c = conversation();
    const run = (await send(c.id, "x")).json().run as Run;
    for (let i = 0; i < 100 && !app.conversations!.messageById(run.assistantMessageId)!.searchText; i++)
      await new Promise((r) => setTimeout(r, 10));
    await mom.post(`/api/runs/${run.id}/interrupt`);
    expect((await waitRun(run.id)).status).toBe("interrupted");
    const reply = app.conversations!.messageById(run.assistantMessageId)!;
    expect(reply.status).toBe("stopped");
    expect(JSON.stringify(reply.parts)).toMatch(/부분/);
    // The conversation is free again.
    expect((await send(c.id, "다음")).statusCode).toBe(201);
    expect(app.runs!.liveCount()).toBe(1); // only the new run
  });

  it("an interrupt while the runtime is still opening its session also ends the run", async () => {
    const { mom, conversation, send, waitRun } = await start({
      adapter: stuckRuntime("start"),
      graceMs: 100,
    });
    const run = (await send(conversation().id, "x")).json().run as Run;
    await new Promise((r) => setTimeout(r, 30));
    await mom.post(`/api/runs/${run.id}/interrupt`);
    expect((await waitRun(run.id)).status).toBe("interrupted");
  });

  it("delta part indexes match the message API even with reasoning in between", async () => {
    const { mom, conversation, send, stream, waitRun } = await start({
      script: () => [
        { reasoning: "생각" },
        { text: "첫 문단" },
        { reasoning: "더 생각" },
        { text: "둘째 문단" },
      ],
    });
    const c = conversation();
    const run = (await send(c.id, "x")).json().run as Run;
    const { frames } = await (await stream(run.id)).read();
    await waitRun(run.id);
    const reply = (await mom.get(`/api/conversations/${c.id}/messages`)).json().items.at(-1) as Message;
    for (const e of events(frames))
      if (e.type === "delta") expect((reply.parts[e.partIndex] as { text: string }).text).toContain(e.text);
    expect(reply.parts).toEqual([
      { type: "text", text: "첫 문단" },
      { type: "text", text: "둘째 문단" },
    ]);
  });

  it("keeps nothing in memory for a run that failed at once, and closes every session it opened", async () => {
    const none = await start({ noRuntime: true });
    await none.send(none.conversation().id, "x");
    expect(none.app.runs!.liveCount()).toBe(0);

    const { app, fake, conversation, send, waitRun } = await start();
    const c = conversation();
    await waitRun((await send(c.id, "하나")).json().run.id);
    await waitRun((await send(c.id, "둘")).json().run.id);
    expect(fake.opened).toBe(2);
    expect(fake.closed).toBe(2);
    expect(app.runs!.liveCount()).toBe(0);
  });

  it("revokes MCP tokens of running runs on shutdown", async () => {
    let token: string | undefined;
    const adapter: RuntimeAdapter = {
      id: "claude-code",
      capabilities: () => ({
        models: [{ id: "c", label: "C", efforts: [] }],
        canSwitchModelInSession: false,
        canResume: false,
        usesTools: true,
      }),
      resume: () => Promise.reject(new Error("no")),
      start: async (ctx) => {
        token = ctx.mcp?.token;
        return {
          externalSessionId: "t",
          setModel: async () => {},
          close: async () => {},
          turn: () => ({
            events: (async function* (): AsyncGenerator<RuntimeEvent> {
              yield* [] as RuntimeEvent[];
              await new Promise(() => {});
            })(),
            interrupt: async () => {},
          }),
        };
      },
    };
    const { app, conversation, send } = await start({ adapter });
    await send(conversation().id, "x");
    for (let i = 0; i < 100 && !token; i++) await new Promise((r) => setTimeout(r, 10));
    expect(app.runs!.mcpTokens.verify(token)).toBeDefined();
    await app.runs!.shutdown();
    expect(app.runs!.mcpTokens.verify(token)).toBeUndefined();
  });

  it("closes running sessions on shutdown", async () => {
    const { app, fake, conversation, send } = await start({ script: () => [{ delayMs: 5000 }] });
    await send(conversation().id, "x");
    for (let i = 0; i < 100 && fake.opened === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await app.runs!.shutdown();
    expect(fake.closed).toBe(fake.opened);
    expect(app.runs!.liveCount()).toBe(0);
  });

  it("never resumes on a runtime that cannot resume", async () => {
    const { app, conversation, send, waitRun } = await start({ canResume: false });
    const c = conversation();
    expect((await waitRun((await send(c.id, "하나")).json().run.id)).status).toBe("done");
    expect((await waitRun((await send(c.id, "둘")).json().run.id)).status).toBe("done");
    expect(app.conversations!.sessions(c.id).length).toBeGreaterThanOrEqual(1);
  });
});

/** An adapter whose start, interrupt and close the test controls. Counts closes per session. */
function controlledRuntime(o: {
  startDelayMs?: number;
  interruptHangs?: boolean;
  events?: RuntimeEvent[];
  endless?: boolean;
}) {
  const stats = { opened: 0, closes: 0 };
  const adapter: RuntimeAdapter = {
    id: "claude-code",
    capabilities: () => ({
      models: [{ id: "c", label: "C", efforts: [] }],
      canSwitchModelInSession: false,
      canResume: false,
    }),
    resume: () => Promise.reject(new Error("no")),
    start: async () => {
      await new Promise((r) => setTimeout(r, o.startDelayMs ?? 0));
      stats.opened++;
      return {
        externalSessionId: `ctl-${stats.opened}`,
        setModel: async () => {},
        close: async () => {
          stats.closes++;
        },
        turn: () => ({
          events: (async function* () {
            for (const e of o.events ?? [{ type: "text_delta", text: "x" } as RuntimeEvent]) yield e;
            if (o.endless) await new Promise(() => {});
          })(),
          interrupt: () => (o.interruptHangs ? new Promise<void>(() => {}) : Promise.resolve()),
        }),
      };
    },
  };
  return { adapter, stats };
}

describe("runs: robustness, round 2 (review #74)", () => {
  it("a tool call without input or output is stored as null and the history still loads", async () => {
    const { adapter } = controlledRuntime({
      events: [
        { type: "tool_start", callId: "t1", name: "noop" },
        { type: "tool_end", callId: "t1" },
        { type: "text_delta", text: "끝" },
      ],
    });
    const { mom, conversation, send, waitRun } = await start({ adapter });
    const c = conversation();
    await waitRun((await send(c.id, "x")).json().run.id);
    const r = await mom.get(`/api/conversations/${c.id}/messages`);
    expect(r.statusCode).toBe(200);
    expect(r.json().items.at(-1).parts.slice(0, 2)).toEqual([
      { type: "tool_call", id: "t1", name: "noop", input: null },
      { type: "tool_result", callId: "t1", output: null },
    ]);
  });

  it("closes a session that finished opening after its conversation was deleted", async () => {
    const { adapter, stats } = controlledRuntime({ startDelayMs: 150 });
    const { app, conversation, send } = await start({ adapter });
    // The delete never saw this session (its row could not be saved): it is handed over to be forgotten (#54).
    const orphans: unknown[] = [];
    app.purge!.orphan = (ref) => void orphans.push(ref);
    const c = conversation();
    await send(c.id, "x");
    await new Promise((r) => setTimeout(r, 30));
    app.conversations!.delete(c.id);
    await new Promise((r) => setTimeout(r, 300));
    expect(stats.opened).toBe(1);
    expect(stats.closes).toBe(1);
    expect(app.runs!.liveCount()).toBe(0);
    expect(orphans).toEqual([
      expect.objectContaining({ conversationId: c.id, runtime: "claude-code", externalSessionId: "ctl-1" }),
    ]);
  });

  it("a start that fails after its session existed hands it over to be forgotten (#54 review)", async () => {
    const adapter: RuntimeAdapter = {
      id: "claude-code",
      capabilities: () => ({
        models: [{ id: "c", label: "C", efforts: [] }],
        canSwitchModelInSession: false,
        canResume: false,
      }),
      resume: () => Promise.reject(new Error("no")),
      start: async (ctx) => {
        ctx.sessionStarted?.("half-open-1");
        throw new RuntimeFailure("runtime_policy");
      },
    };
    const { app, conversation, send, waitRun } = await start({ adapter });
    const handed: unknown[] = [];
    app.purge!.orphan = (ref) => void handed.push(ref);
    const c = conversation();
    const run = (await send(c.id, "x")).json().run as Run;
    expect((await waitRun(run.id)).status).toBe("failed");
    expect(handed).toEqual([
      expect.objectContaining({ conversationId: c.id, externalSessionId: "half-open-1" }),
    ]);
  });

  it("a session whose row cannot be written is handed over too, while the conversation still exists (#54 r3)", async () => {
    const { adapter, stats } = controlledRuntime({});
    const { app, db, conversation, send, waitRun } = await start({ adapter });
    const handed: unknown[] = [];
    app.purge!.orphan = (ref) => void handed.push(ref);
    db.$client.exec(
      "CREATE TRIGGER fail_sessions BEFORE INSERT ON runtime_sessions BEGIN SELECT RAISE(ABORT, 'no'); END;",
    );
    const c = conversation();
    const run = (await send(c.id, "x")).json().run as Run;
    expect((await waitRun(run.id)).status).toBe("failed");
    db.$client.exec("DROP TRIGGER fail_sessions");
    expect(app.conversations!.get(c.id)).toBeDefined();
    expect(stats.closes).toBe(1);
    expect(handed).toEqual([expect.objectContaining({ conversationId: c.id, externalSessionId: "ctl-1" })]);
  });

  it("a failed start's process counts until it has exited: quiet waits for it (#54 r3)", async () => {
    let exit!: () => void;
    const gone = new Promise<void>((r) => (exit = r));
    const adapter: RuntimeAdapter = {
      id: "claude-code",
      capabilities: () => ({
        models: [{ id: "c", label: "C", efforts: [] }],
        canSwitchModelInSession: false,
        canResume: false,
      }),
      resume: () => Promise.reject(new Error("no")),
      start: async (ctx) => {
        ctx.sessionStarted?.("half-open-2", () => gone);
        throw new RuntimeFailure("runtime_policy");
      },
    };
    const { app, conversation, send, waitRun } = await start({ adapter });
    app.purge!.orphan = () => {};
    const c = conversation();
    const run = (await send(c.id, "x")).json().run as Run;
    expect((await waitRun(run.id)).status).toBe("failed");
    expect(await app.runs!.quiet(c.id, 100)).toBe(false);
    exit();
    expect(await app.runs!.quiet(c.id, 1000)).toBe(true);
  });

  it("quiet (#54 review) is true only once the session's process has really exited — not when close gave up", async () => {
    let exit!: () => void;
    const gone = new Promise<void>((r) => (exit = r));
    const adapter: RuntimeAdapter = {
      id: "claude-code",
      capabilities: () => ({
        models: [{ id: "c", label: "C", efforts: [] }],
        canSwitchModelInSession: false,
        canResume: false,
      }),
      resume: () => Promise.reject(new Error("no")),
      start: async () => ({
        externalSessionId: "slow-exit",
        setModel: async () => {},
        close: async () => {
          throw new ExitUnconfirmedError();
        },
        exited: () => gone,
        turn: () => {
          let stop!: () => void;
          const stopped = new Promise<void>((r) => (stop = r));
          return {
            events: (async function* () {
              yield { type: "text_delta", text: "x" } as RuntimeEvent;
              await stopped;
            })(),
            interrupt: async () => stop(),
          };
        },
      }),
    };
    const { app, conversation, send } = await start({ adapter });
    const c = conversation();
    await send(c.id, "x");
    await new Promise((r) => setTimeout(r, 50));
    app.conversations!.delete(c.id);
    expect(await app.runs!.quiet(c.id, 100)).toBe(false);
    exit();
    expect(await app.runs!.quiet(c.id, 1000)).toBe(true);
  });

  it("a hanging interrupt blocks neither the request nor shutdown", async () => {
    const { adapter, stats } = controlledRuntime({ interruptHangs: true, endless: true });
    const { app, mom, conversation, send, waitRun } = await start({ adapter, graceMs: 100 });
    const run = (await send(conversation().id, "x")).json().run as Run;
    for (let i = 0; i < 100 && stats.opened === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const t0 = Date.now();
    expect((await mom.post(`/api/runs/${run.id}/interrupt`)).statusCode).toBe(200);
    expect(Date.now() - t0).toBeLessThan(500);
    expect((await waitRun(run.id)).status).toBe("interrupted");
    // Another run that hangs, then shutdown.
    const run2 = (await send(conversation().id, "y")).json().run as Run;
    for (let i = 0; i < 100 && stats.opened < 2; i++) await new Promise((r) => setTimeout(r, 10));
    const t1 = Date.now();
    await app.runs!.shutdown();
    expect(Date.now() - t1).toBeLessThan(2500);
    expect(stats.closes).toBe(2);
    void run2;
  });

  it("shutdown ends open event streams", async () => {
    const { app, conversation, send, stream } = await start({
      script: () => Array.from({ length: 300 }, (_, i) => [{ text: `${i} ` }, { delayMs: 10 }]).flat(),
    });
    const run = (await send(conversation().id, "x")).json().run as Run;
    const s = await stream(run.id);
    await s.read((fr) => fr.filter((x) => x.data).length >= 2);
    await app.runs!.shutdown();
    expect((await s.read()).ended).toBe(true);
  });

  it("closes a session exactly once when shutdown and delete overlap", async () => {
    const { adapter, stats } = controlledRuntime({ interruptHangs: true, endless: true });
    const { app, conversation, send } = await start({ adapter });
    const c = conversation();
    await send(c.id, "x");
    for (let i = 0; i < 100 && stats.opened === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const down = app.runs!.shutdown();
    app.conversations!.delete(c.id);
    await down;
    await new Promise((r) => setTimeout(r, 50));
    expect(stats.closes).toBe(1);
  });
});

describe("runs: robustness, round 3 (review #74)", () => {
  it("refuses new runs once shutdown has started", async () => {
    const { app, conversation, send } = await start();
    await app.runs!.shutdown();
    const r = await send(conversation().id, "x");
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: "shutting_down" });
    expect(app.runs!.liveCount()).toBe(0);
  });

  it("a session whose close() throws synchronously cannot crash the grace timer or shutdown", async () => {
    let opened = 0;
    const adapter: RuntimeAdapter = {
      id: "claude-code",
      capabilities: () => ({
        models: [{ id: "c", label: "C", efforts: [] }],
        canSwitchModelInSession: false,
        canResume: false,
      }),
      resume: () => Promise.reject(new Error("no")),
      start: async () => {
        opened++;
        return {
          externalSessionId: `x-${opened}`,
          setModel: async () => {},
          close: () => {
            throw new Error("sync close failure");
          },
          turn: () => ({
            events: (async function* (): AsyncGenerator<RuntimeEvent> {
              yield { type: "text_delta", text: "a" };
              await new Promise(() => {});
            })(),
            interrupt: () => new Promise<void>(() => {}),
          }),
        };
      },
    };
    const { app, mom, conversation, send, waitRun } = await start({ adapter, graceMs: 50 });
    const run = (await send(conversation().id, "x")).json().run as Run;
    for (let i = 0; i < 100 && opened === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await mom.post(`/api/runs/${run.id}/interrupt`);
    expect((await waitRun(run.id)).status).toBe("interrupted"); // grace timer → settle → close threw, contained
    await send(conversation().id, "y");
    for (let i = 0; i < 100 && opened < 2; i++) await new Promise((r) => setTimeout(r, 10));
    await expect(app.runs!.shutdown()).resolves.toBeUndefined();
  });
});

describe("runs: robustness, round 4 (review #74)", () => {
  function goneOnResume() {
    const stats = { starts: 0, resumes: 0 };
    const session = (id: string): RuntimeSession => ({
      externalSessionId: id,
      setModel: async () => {},
      close: async () => {},
      turn: () => ({
        events: (async function* (): AsyncGenerator<RuntimeEvent> {
          yield { type: "text_delta", text: "ok" };
        })(),
        interrupt: async () => {},
      }),
    });
    const adapter: RuntimeAdapter = {
      id: "claude-code",
      capabilities: () => ({
        models: [{ id: "c", label: "C", efforts: [] }],
        canSwitchModelInSession: false,
        canResume: true,
      }),
      start: async () => session(`s-${++stats.starts}`),
      // Slow, then "the runtime lost it" — the run ends meanwhile.
      resume: async () => {
        stats.resumes++;
        await new Promise((r) => setTimeout(r, 150));
        throw new SessionGoneError();
      },
    };
    return { adapter, stats };
  }

  for (const how of ["interrupt", "delete", "shutdown"] as const)
    it(`does not open a new session after the run ended during resume (${how})`, async () => {
      const { adapter, stats } = goneOnResume();
      const { app, mom, conversation, send, waitRun } = await start({ adapter, graceMs: 30 });
      const c = conversation();
      await waitRun((await send(c.id, "하나")).json().run.id);
      expect(stats.starts).toBe(1);
      const run = (await send(c.id, "둘")).json().run as Run;
      for (let i = 0; i < 100 && stats.resumes === 0; i++) await new Promise((r) => setTimeout(r, 5));
      if (how === "interrupt") await mom.post(`/api/runs/${run.id}/interrupt`);
      if (how === "delete") app.conversations!.delete(c.id);
      if (how === "shutdown") await app.runs!.shutdown();
      await new Promise((r) => setTimeout(r, 300));
      expect(stats.starts).toBe(1);
      expect(app.runs!.liveCount()).toBe(0);
    });
});

describe("runs: MCP call tokens (#42)", () => {
  it("each run gets a token scoped to its user and conversation, revoked when the run ends", async () => {
    let seen: string | undefined;
    let duringRun: unknown;
    const tokensRef: { tokens?: { verify: (t: string | undefined) => unknown } } = {};
    const adapter: RuntimeAdapter = {
      id: "claude-code",
      capabilities: () => ({
        models: [{ id: "c", label: "C", efforts: [] }],
        canSwitchModelInSession: false,
        canResume: false,
        usesTools: true,
      }),
      resume: () => Promise.reject(new Error("no")),
      start: async (ctx) => {
        seen = ctx.mcp?.token;
        duringRun = tokensRef.tokens?.verify(ctx.mcp?.token);
        return {
          externalSessionId: "m",
          setModel: async () => {},
          close: async () => {},
          turn: () => ({
            events: (async function* (): AsyncGenerator<RuntimeEvent> {
              yield { type: "text_delta", text: "ok" };
            })(),
            interrupt: async () => {},
          }),
        };
      },
    };
    const { app, f, conversation, send, waitRun } = await start({ adapter });
    tokensRef.tokens = app.runs!.mcpTokens;
    const c = conversation();
    const run = (await send(c.id, "x")).json().run as Run;
    await waitRun(run.id);
    expect(seen).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(duringRun).toMatchObject({ userId: f.users.owner.id, conversationId: c.id, runId: run.id });
    expect(app.runs!.mcpTokens.verify(seen)).toBeUndefined();
  });
});

describe("runs: chat screen support (#14)", () => {
  it("tool inputs and outputs reach neither the stream nor the history with their secret fields", async () => {
    const { mom, conversation, send, stream, waitRun } = await start();
    const c = conversation();
    const run = (await send(c.id, "/secrettool")).json().run as Run;
    const { frames } = await (await stream(run.id)).read();
    await waitRun(run.id);
    const list = (await mom.get(`/api/conversations/${c.id}/messages`)).json().items as Message[];
    for (const blob of [JSON.stringify(frames), JSON.stringify(list)]) {
      expect(blob).toContain("web_search");
      expect(blob).toContain("단진자 주기");
      expect(blob).not.toMatch(/sk-fake-secret-123|hunter2|tok-fake-456/);
    }
    const start_ = events(frames).find((e) => e.type === "tool_start");
    expect(start_).toMatchObject({
      input: { query: "단진자 주기", apiKey: "[숨김]", nested: { password: "[숨김]" } },
    });
  });

  it("numeric secrets and keys inside strings are removed from the stream, the API and the stored row; ordinary data stays", async () => {
    const script: FakeScript = () => [
      {
        tool: "login",
        ms: 0,
        input: {
          user: "kim",
          otp: 123456,
          password: 1234,
          pin: 9876,
          tokenizer: "cl100k_base",
          tokenSymbol: "ETH",
        },
        output: "request failed with key sk-proj-abcdefgh1234 (401)",
        isError: true,
      },
      { usage: { inputTokens: 3, outputTokens: 4 } },
    ];
    const { app, mom, conversation, send, stream, waitRun } = await start({ script });
    const c = conversation();
    const run = (await send(c.id, "x")).json().run as Run;
    const { frames } = await (await stream(run.id)).read();
    await waitRun(run.id);
    const api = (await mom.get(`/api/conversations/${c.id}/messages`)).json().items as Message[];
    const stored = app.conversations!.messages(c.id, { limit: 100 });
    for (const blob of [JSON.stringify(frames), JSON.stringify(api), JSON.stringify(stored)]) {
      expect(blob).not.toMatch(/123456|1234[^0-9]|9876|sk-proj-abcdefgh1234/);
      expect(blob).toContain("cl100k_base");
      expect(blob).toContain("ETH");
      expect(blob).toContain("request failed with key [숨김] (401)");
    }
    const reply = api.at(-1)!;
    expect(reply.parts[0]).toMatchObject({
      type: "tool_call",
      input: { user: "kim", otp: "[숨김]", password: "[숨김]", pin: "[숨김]", tokenizer: "cl100k_base" },
    });
  });

  it("JSON held in strings is redacted field by field in the stream, the API and the stored row; prose is kept", async () => {
    const script: FakeScript = () => [
      {
        tool: "http",
        ms: 0,
        input: '{"url":"https://api.example","password":"hunter2","otp":123456}',
        output: 'login failed: {"password":"hunter2","otp":123456} — Basic authentication is an HTTP scheme',
      },
    ];
    const { app, mom, conversation, send, stream, waitRun } = await start({ script });
    const c = conversation();
    const run = (await send(c.id, "x")).json().run as Run;
    const { frames } = await (await stream(run.id)).read();
    await waitRun(run.id);
    const api = (await mom.get(`/api/conversations/${c.id}/messages`)).json().items as Message[];
    const stored = app.conversations!.messages(c.id, { limit: 100 });
    for (const blob of [JSON.stringify(frames), JSON.stringify(api), JSON.stringify(stored)]) {
      expect(blob).not.toMatch(/hunter2|123456/);
      expect(blob).toContain("api.example");
      expect(blob).toContain("Basic authentication is an HTTP scheme");
    }
    const parts = api.at(-1)!.parts;
    expect(parts[0]).toMatchObject({
      input: '{"url":"https://api.example","password":"[숨김]","otp":"[숨김]"}',
    });
  });

  it("JSON printed into tool output is redacted in place in the stored row; other numbers keep their exact lexeme", async () => {
    const script: FakeScript = () => [
      {
        tool: "shell",
        ms: 0,
        input: '{"accountId":9007199254740993,"password":"hunter2"}',
        output: 'stdout: {"password":\n "hunter2","otp":[123456]}\nexit 0',
      },
    ];
    const { app, mom, conversation, send, stream, waitRun } = await start({ script });
    const c = conversation();
    const run = (await send(c.id, "x")).json().run as Run;
    const { frames } = await (await stream(run.id)).read();
    await waitRun(run.id);
    const api = (await mom.get(`/api/conversations/${c.id}/messages`)).json().items as Message[];
    const stored = app.conversations!.messages(c.id, { limit: 100 });
    for (const blob of [JSON.stringify(frames), JSON.stringify(api), JSON.stringify(stored)]) {
      expect(blob).not.toMatch(/hunter2|123456/);
      expect(blob).toContain("9007199254740993");
    }
    const parts = stored.at(-1)!.parts as { type: string; input?: unknown; output?: unknown }[];
    expect(parts[0]!.input).toBe('{"accountId":9007199254740993,"password":"[숨김]"}');
    expect(parts[1]!.output).toBe('stdout: {"password":\n "[숨김]","otp":"[숨김]"}\nexit 0');
  });

  it("escaped JSON keys and JSON inside JSON strings are redacted in the stored row", async () => {
    const BSL = String.fromCharCode(92);
    const doubly = JSON.stringify({ body: '{"token":"tok-double-777","n":1}' });
    const script: FakeScript = () => [
      {
        tool: "shell",
        ms: 0,
        input: '{"pass\\u0077ord":"hunter2","\\u006ftp":[123456],"user":"kim"}',
        output: {
          stdout: '{"password":"hunter3","otp":[654321]}',
          nested: doubly,
          code: 0,
          // Codex round 5: a JSON string value that is cut off (no closing quote) as raw text.
          raw: '{"stdout":"{\\"password\\":\\"hunter4\\",\\"otp\\":[111222]}',
          // Codex round 6: JSON-stringified values printed into text, starting with [ and {.
          printed: [
            "stdout: " + JSON.stringify('[{"password":"hunter5","otp":[333444]}]'),
            "stdout: " + JSON.stringify('{"password":"hunter6","otp":[555666]}'),
            'x="{"password":"hunter7"}"',
            // Codex round 7: a broken quoted prefix, then real JSON.
            'stdout: "[\\"ok\\"] suffix {"password":"hunter8","otp":[777888]}',
          ].join("\n"),
          // Codex round 8: shapes passes A and B miss — caught by the fail-closed sweep.
          // Codex round 9: escaped whitespace, \u0022 quotes, values that start with the placeholder.
          round9: [
            "stdout: " + JSON.stringify(' {"password":\n"hunter2","otp":\t"123456"}'),
            "stdout: " +
              JSON.stringify(' {"password":"hunter2","otp":[123456]}').replaceAll('\\"', "\\u0022"),
            "stdout: " + JSON.stringify(' {"password":"[숨김]hunter2","otp":"[숨김]123456"}'),
          ].join("\n"),
          // Codex round 10: the colon written as \u003a.
          round10:
            "stdout: " + JSON.stringify(' {"password":"hunter2","otp":[123456]}').replaceAll(":", "\\u003a"),
          // Codex round 11: names after \u0022 quotes, punctuation in names, names over 64 characters.
          round11a:
            "stdout: " +
            JSON.stringify(' {"pin":"1234","auth":"reviewLeak123"}').replaceAll('\\"', "\\u0022"),
          round11b: "stdout: " + JSON.stringify(' {"pass.word":"hunter2"}'),
          round11c:
            "stdout: " + JSON.stringify(" " + JSON.stringify({ ["x".repeat(57) + "Password"]: "hunter2" })),
          prose: JSON.stringify({ message: "password: 다음에 실제 값을 넣으세요.", count: 1 }),
          // Codex round 12: separators and escapes inside quoted keys; quoted prose in arrays and values.
          round12a: "stdout: " + JSON.stringify(" " + JSON.stringify({ "api:key": "hunter2" })),
          round12b: "stdout: " + JSON.stringify(" " + JSON.stringify({ "api\bkey": "hunter2" })),
          round12c: "stdout: " + JSON.stringify(' {"api\\u000akey":"hunter2"}'),
          // Codex round 13: an escaped backslash written as \u005c; a raw line break inside a secret value.
          round13a: JSON.stringify(
            " " + JSON.stringify(" " + JSON.stringify({ "api:key": "hunter2" })),
          ).replace("\\\\", "\\u005c"),
          round13b: '{"password":"prefix' + String.fromCharCode(10) + 'hunter2"}',
          // Codex round 14: hex digits of an inner unicode escape escaped one layer out; a broken scalar.
          round14a: JSON.stringify(
            " " +
              JSON.stringify(" " + JSON.stringify({ "api:key": "hunter2" })).replace(
                BSL + '"',
                BSL + "u0022",
              ),
          ).replace("u0022", "u0" + BSL + "u003022"),
          round14b: '{"password":123hunter2,"user":"kim"}',
          // Codex round 15: the tag spelled as an escape; Python-style dicts; ten layers of stringify.
          round15a:
            '"' +
            ["u007b", "u0022api:key", "u0022:", "u0022", "ufdd0hunter2", "u0022}"]
              .map((x) => BSL + x)
              .join("") +
            '"',
          round15b: "{'api:key':'hunter2'}",
          round15c: (() => {
            let x = JSON.stringify({ "api:key": "hunter2" });
            for (let k = 0; k < 10; k++) x = JSON.stringify(" " + x);
            return x;
          })(),
          // Codex round 16: a Python string wrapping a dict; a quote behind nine escaped backslashes.
          round16a: "'{" + BSL + "'api:key" + BSL + "': " + BSL + "'hunter2" + BSL + '\', "x": "y"}\'',
          round16b: (() => {
            const q = BSL + "u005c".repeat(9) + "u0022";
            return `{${q}api:key${q}:${q}hunter2${q}}`;
          })(),
          // Codex round 17: Python repr() keys with \xHH escapes, raw and stringified.
          round17a: "{'api" + BSL + "x00key': 'hunter2'}",
          round17b: JSON.stringify("{'pass" + BSL + "x77ord': 'hunter2'}"),
          // Codex round 18: \N{…} names we cannot decode, raw and stringified.
          round18a: "{'api" + BSL + "N{KELVIN SIGN}ey': 'hunter2'}",
          round18b: JSON.stringify("{'p" + BSL + "N{LATIN CAPITAL LETTER I WITH DOT ABOVE}n': 'hunter2'}"),
          // Codex round 19: an N-escape name longer than the window (88 characters).
          round19: JSON.stringify(
            "{'api" +
              BSL +
              "N{BOX DRAWINGS LIGHT DIAGONAL UPPER CENTRE TO MIDDLE RIGHT AND MIDDLE LEFT TO LOWER CENTRE}ey': 'hunter2'}",
          ),
          // Codex round 20: an escape no decoder here knows (Ruby), a bare assignment found on a decoded layer, a
          // form feed between the key and the colon.
          round20a: '{"api' + BSL + 'ekey" => "hunter2"}',
          round20b: JSON.stringify("pass" + BSL + "x77ord='hunter2'"),
          round20c: "{'pass" + BSL + "x77ord'" + String.fromCharCode(12) + ": 'hunter2'}",
          // Codex round 21: a Ruby octal above 377, a non-ASCII bare key, a computed key after a comment.
          round21a: '{"' + BSL + '560assword" => "hunter2"}',
          round21b: JSON.stringify("({pass한word: 'hunter2'})"),
          round21c: '({["password"] /* field */: "hunter2"})',
          regex21: "정규식 /" + BSL + "d{2}:" + BSL + "d{2}/로 시각을 검사하세요.",
          // Codex round 22: Java \uuuu after a semicolon, a concatenated computed key, an INI key with a dot.
          round22a: "a=1;p" + BSL + 'uuuu0061ssword="hunter2";',
          round22b: JSON.stringify('({["pass" + "word"]: "hunter2"})'),
          round22c: "pass.word=hunter2",
          regex22: "정규식 /(" + BSL + "d{2}:" + BSL + "d{2})/로 시각을 검사하세요.",
          prose12: JSON.stringify({
            message: ["password: 다음에 실제 값을 넣으세요."],
            note: '참고, "password: 다음에"',
            count: 1,
          }),
          broken: [
            'stdout: {"note":"broken {"password":"hunter9","otp":[999000]}',
            "stdout: {" + JSON.stringify('{"password":"hunter9","otp":[999000]}'),
            "stdout: " + JSON.stringify(' {"password":"hunter9","otp":[999000]}'),
          ].join("\n"),
        },
      },
    ];
    const { app, mom, conversation, send, stream, waitRun } = await start({ script });
    const c = conversation();
    const run = (await send(c.id, "x")).json().run as Run;
    const { frames } = await (await stream(run.id)).read();
    await waitRun(run.id);
    const api = (await mom.get(`/api/conversations/${c.id}/messages`)).json().items as Message[];
    const stored = app.conversations!.messages(c.id, { limit: 100 });
    for (const blob of [JSON.stringify(frames), JSON.stringify(api), JSON.stringify(stored)]) {
      expect(blob).not.toMatch(/hunter[2-9]|123456|654321|111222|333444|555666|777888|999000|tok-double-777/);
      expect(blob).toContain("kim");
    }
    const parts = stored.at(-1)!.parts as { type: string; input?: unknown; output?: unknown }[];
    expect(parts[0]!.input).toBe('{"pass\\u0077ord":"[숨김]","\\u006ftp":"[숨김]","user":"kim"}');
    const output = parts[1]!.output as {
      stdout: string;
      nested: string;
      code: number;
      raw: string;
      printed: string;
      broken: string;
      round9: string;
      round10: string;
      round11a: string;
      round11b: string;
      round11c: string;
      prose: string;
      round12a: string;
      round12b: string;
      round12c: string;
      prose12: string;
      round13a: string;
      round13b: string;
      round14a: string;
      round14b: string;
      round15a: string;
      round15b: string;
      round15c: string;
      round16a: string;
      round16b: string;
      round17a: string;
      round17b: string;
      round18a: string;
      round18b: string;
      round19: string;
      round20a: string;
      round20b: string;
      round20c: string;
      round21a: string;
      round21b: string;
      round21c: string;
      regex21: string;
      round22a: string;
      round22b: string;
      round22c: string;
      regex22: string;
    };
    for (const v of [output.round22a, output.round22b, output.round22c]) expect(v).not.toContain("hunter2");
    expect(output.regex22).toBe("정규식 /(" + BSL + "d{2}:" + BSL + "d{2})/로 시각을 검사하세요.");
    for (const v of [output.round21a, output.round21b, output.round21c]) expect(v).not.toContain("hunter2");
    expect(output.regex21).toBe("정규식 /" + BSL + "d{2}:" + BSL + "d{2}/로 시각을 검사하세요.");
    for (const v of [output.round20a, output.round20b, output.round20c]) expect(v).not.toContain("hunter2");
    expect(output.round19).not.toContain("hunter2");
    for (const v of [output.round18a, output.round18b]) expect(v).not.toContain("hunter2");
    for (const v of [output.round17a, output.round17b]) expect(v).not.toContain("hunter2");
    for (const v of [output.round16a, output.round16b]) expect(v).not.toContain("hunter2");
    for (const v of [output.round15a, output.round15b, output.round15c]) expect(v).not.toContain("hunter2");
    expect(output.round14a).not.toContain("hunter2");
    expect(output.round14b).toBe('{"password":[숨김]');
    expect(output.round13a).not.toContain("hunter2");
    expect(output.round13b).toBe('{"password":[숨김]');
    for (const v of [output.round12a, output.round12b, output.round12c]) expect(v).not.toContain("hunter2");
    expect(output.prose12).toBe(
      JSON.stringify({
        message: ["password: 다음에 실제 값을 넣으세요."],
        note: '참고, "password: 다음에"',
        count: 1,
      }),
    );
    for (const v of [output.round11a, output.round11b, output.round11c])
      expect(v).not.toMatch(/1234|reviewLeak123|hunter2/);
    expect(output.prose).toBe(JSON.stringify({ message: "password: 다음에 실제 값을 넣으세요.", count: 1 }));
    // Where A and B cannot parse, the sweep hides everything after the separator to the end of the value
    // (round 10): the later lines of these fields go with it.
    expect(output.broken).toBe('stdout: {"note":"broken {"password":[숨김]');
    expect(output.round9).toBe('stdout: " {\\"password\\":[숨김]');
    expect(output.round10).toBe('stdout: " {\\"password\\"\\u003a[숨김]');
    expect(output.printed.split("\n")).toEqual([
      "stdout: " + JSON.stringify('[{"password":"[숨김]","otp":"[숨김]"}]'),
      "stdout: " + JSON.stringify('{"password":"[숨김]","otp":"[숨김]"}'),
      'x="{"password":"[숨김]"}"',
      'stdout: "[\\"ok\\"] suffix {"password":"[숨김]","otp":"[숨김]"}',
    ]);
    expect(output.raw).toBe('{"stdout":"{\\"password\\":\\"[숨김]\\",\\"otp\\":\\"[숨김]\\"}');
    expect(output.stdout).toBe('{"password":"[숨김]","otp":"[숨김]"}');
    expect(JSON.parse(output.nested)).toEqual({ body: '{"token":"[숨김]","n":1}' });
    expect(output.code).toBe(0);
  });

  it("FakeRuntime /md, /xss and /burst produce the scripted text", async () => {
    const { conversation, send, stream } = await start();
    const read = async (text: string) => {
      const run = (await send(conversation().id, text)).json().run as Run;
      return textOf((await (await stream(run.id)).read()).frames);
    };
    expect(await read("/md")).toContain("| 길이 (m) | 주기 (s) |");
    expect(await read("/xss")).toContain("javascript:");
    const burst = await read("/burst 120");
    expect(burst).toContain("단어1 ");
    expect(burst).toContain("**단어120**");
  });
});
