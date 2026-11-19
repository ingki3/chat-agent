import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CSRF_HEADER, ResearchJob, type MessagePart } from "@agentlee/shared";
import { SELFTEST_SKILL } from "@agentlee/mcp-tools/skills";
import { buildApp, type BuildOptions } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb, type Db } from "../src/db/client.js";
import { inProcessExtractor, ocrCapability } from "../src/files/extract.js";
import { compose } from "../src/notifications/compose.js";
import { ManualClock } from "../src/research/clock.js";
import { TURN_MARK } from "../src/research/prompts.js";
import {
  RuntimeRegistry,
  type RuntimeAdapter,
  type RuntimeSession,
  type StartContext,
} from "../src/runtime/adapter.js";
import { fixtureWebWorker, FIXTURE_PAGES } from "../src/runtime/fake-citations.js";
import { RESEARCH_FIXTURE } from "../src/runtime/fake-research.js";
import { defaultScript, FakeRuntime, type FakeScript, type FakeStep } from "../src/runtime/fake.js";
import { createFamily, shareWithShared } from "./helpers/permission-matrix.js";

/**
 * 깊이 조사 (#211) end to end on the FakeRuntime (`fake-research.ts`): the plan card before any search, approval
 * (with edits), sub-researchers in parallel (bounded), the server's note check, the writer's citations and the removal
 * of what does not verify, the markdown report and the card's message, the notifications (quiet hours, per-kind
 * switches), the 30-minute cap on a manual clock (the forced wrap-up), stop, the restart, attachments, Codex
 * conversations and who may do what. No network: the fixture pages are answered in-process.
 */

type App = Awaited<ReturnType<typeof buildApp>>;
const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "research-"));
  closers.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

const stubProxy = {
  endpoint: async () => ({ port: 9, url: "http://127.0.0.1:9", close: async () => {} }),
  close: async () => {},
};
const MIN = 60_000;
const [A] = FIXTURE_PAGES as [{ url: string }];

/** Counts the sub-researchers running at once (around the fake's turns). */
class Counting implements RuntimeAdapter {
  active = 0;
  max = 0;
  turns: string[] = [];
  constructor(readonly inner: FakeRuntime) {}
  get id() {
    return this.inner.id;
  }
  capabilities() {
    return this.inner.capabilities();
  }
  private wrap(s: RuntimeSession): RuntimeSession {
    return {
      externalSessionId: s.externalSessionId,
      setModel: (m) => s.setModel(m),
      close: () => s.close(),
      turn: (input) => {
        this.turns.push(input.text);
        const t = s.turn(input);
        if (!input.text.startsWith(TURN_MARK.subagent)) return t;
        this.active++;
        this.max = Math.max(this.max, this.active);
        const done = () => void this.active--;
        async function* events() {
          try {
            yield* t.events;
          } finally {
            done();
          }
        }
        return { events: events(), interrupt: () => t.interrupt() };
      },
    };
  }
  async start(ctx: StartContext) {
    return this.wrap(await this.inner.start(ctx));
  }
  async resume(id: string, ctx: StartContext) {
    return this.wrap(await this.inner.resume(id, ctx));
  }
}

/** The default research script, with `over` answering first where it returns steps. */
const scripted =
  (over: (text: string) => FakeStep[] | undefined): FakeScript =>
  (input, memory) =>
    over(input.text) ?? defaultScript(input, memory);

async function start(
  o: {
    script?: FakeScript;
    db?: Db;
    clock?: ManualClock;
    limits?: NonNullable<BuildOptions["research"]>["limits"];
    notificationsNow?: () => number;
    family?: boolean;
    dataDir?: string;
  } = {},
) {
  const db = o.db ?? createTestDb();
  const fake = new FakeRuntime({ runTools: true, script: o.script ?? defaultScript });
  const counting = new Counting(fake);
  const runtimes = new RuntimeRegistry();
  runtimes.register(counting);
  runtimes.register(new FakeRuntime({ id: "codex", runTools: true }));
  const app = await buildApp(
    loadConfig({ NODE_ENV: "test", ...(o.dataDir ? { DATA_DIR: o.dataDir } : {}) }),
    {
      db,
      logger: false,
      runtimes,
      runs: { flushMs: 0 },
      web: { worker: fixtureWebWorker(), fetchProxy: stubProxy as never, providers: ["duckduckgo"] },
      mcp: { skills: [SELFTEST_SKILL], egress: () => stubProxy as never },
      extract: {
        runner: inProcessExtractor(() => ocrCapability(path.join(os.tmpdir(), "agentlee-test-ocr-lang"))),
      },
      research: { ...(o.clock ? { clock: o.clock } : {}), ...(o.limits ? { limits: o.limits } : {}) },
      ...(o.notificationsNow ? { notifications: { now: o.notificationsNow } } : {}),
    },
  );
  closers.push(() => app.close());
  await app.ready();
  const f = o.family === false ? undefined : await createFamily(app);
  const api = (cookie: string, method: "POST" | "GET" | "PUT", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: {
        host: "localhost:3000",
        cookie,
        origin: "http://localhost:3000",
        [CSRF_HEADER]: "1",
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  return { app, db, fake, counting, f: f!, api };
}

async function until<T>(fn: () => T | undefined | false, what = "condition", ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}
const statusIs = (app: App, id: string, ...s: string[]) =>
  until(
    () => {
      const r = app.research!.get(id);
      return r && s.includes(r.status) ? r : undefined;
    },
    `status ${s.join("/")} (now ${app.research!.get(id)?.status})`,
  );

/** Starts a job in a new conversation of the owner; returns the job as the API shows it. */
async function begin(
  t: Awaited<ReturnType<typeof start>>,
  text = "10월 반도체 수출을 깊이 조사해 줘",
  extra: Record<string, unknown> = {},
  conversationId?: string,
) {
  const c = conversationId ?? t.app.conversations!.create(t.f.users.owner.id).id;
  const res = await t.api(t.f.cookies.owner, "POST", `/api/conversations/${c}/research`, { text, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return { conversationId: c, job: ResearchJob.parse(res.json().job) };
}

const sourcesOf = (db: Db, conversationId: string) =>
  (
    db.$client.prepare("select count(*) as n from sources where conversation_id = ?").get(conversationId) as {
      n: number;
    }
  ).n;

describe("깊이 조사: plan → approve → research → verified report", () => {
  it("shows the plan first, searches only after approval, and removes what does not verify", async () => {
    const t = await start();
    const { conversationId, job } = await begin(t);
    expect(job.status).toBe("planning");
    expect(job.owned).toBe(true);
    const planned = await statusIs(t.app, job.id, "awaiting_approval");
    const view = ResearchJob.parse((await t.api(t.f.cookies.owner, "GET", `/api/research/${job.id}`)).json());
    expect(view.plan!.subQuestions.map((q) => q.question)).toEqual([
      "10월 반도체 수출 증가율은 얼마인가",
      "수출 증가의 배경은 무엇인가",
    ]);
    // Decision 2: nothing searched or fetched before approval, and no tool offered to the lead.
    expect(sourcesOf(t.db, conversationId)).toBe(0);
    expect(t.fake.contexts.at(-1)!.tools).toEqual([]);
    expect(planned.deadlineAt).toBeNull();

    // The card holds the question as a user message and the card as the assistant's.
    const msgs = t.app.conversations!.messages(conversationId, { limit: 10 });
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1]!.parts).toEqual([{ type: "research", jobId: job.id }]);

    const ok = await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ResearchJob.parse(ok.json()).status).toBe("researching");
    const done = await statusIs(t.app, job.id, "done");
    const end = ResearchJob.parse((await t.api(t.f.cookies.owner, "GET", `/api/research/${job.id}`)).json());
    // One note quoted words the page does not have: dropped by the server's check.
    expect(end.questions.map((q) => [q.status, q.notes, q.dropped])).toEqual([
      ["done", 2, 1],
      ["done", 1, 0],
    ]);
    expect(end.sources).toBe(2);
    // The sub-researchers got the web tools only; the writer `cite` only (no attachments).
    const tools = t.fake.contexts.map((c) => c.tools);
    expect(tools).toContainEqual(["web_search", "web_fetch"]);
    expect(tools.at(-1)).toEqual(["cite"]);
    // The writer's sentence on the failed citation and its uncited one are gone (decision 4), counted in 한계.
    expect(end.result).toMatchObject({ removed: 2, citations: 3, timedOut: false, fallback: false });
    const a = t.app.artifacts!.get(end.result!.artifactId)!;
    expect(a.kind).toBe("markdown");
    const content = t.app.artifacts!.version(a.id, 1)!.content;
    expect(content).toMatch(/^# 10월 반도체 수출 조사\n/);
    expect(content).not.toContain("50%");
    expect(content).not.toContain("미국 수출 비중");
    expect(content).toContain("가나다 신문은 32% 증가로 보도했어요[");
    expect(content).toContain("## 출처");
    expect(content).toContain("서버가 원문과 대조해 확인하지 못한 문장 2개를 보고서에서 뺐어요.");
    // Markers numbered 1… in order of appearance, every one listed with its passage.
    const marks = [...new Set([...content.matchAll(/\[(\d)\]/g)].map((m) => Number(m[1])))];
    expect(marks).toEqual([1, 2, 3]);
    expect(content).toContain(`(<${A.url}>)`);
    // The card's message: the summary and the report's card.
    const card = t.app.conversations!.messageById(done.messageId)!.parts as MessagePart[];
    expect(card.map((p) => p.type)).toEqual(["research", "text", "artifact_ref"]);
    expect((card[1] as { text: string }).text).toContain("확인하지 못해 뺀 문장 2개");
    expect((card[1] as { text: string }).text).not.toMatch(/\[\d\]/);
    // Usage is recorded per step as 깊이 조사.
    const usage = t.db.$client
      .prepare("select count(*) as n from usage_records where purpose = 'research'")
      .get() as { n: number };
    expect(usage.n).toBeGreaterThanOrEqual(1);
    // Every session opened was closed.
    expect(t.fake.closed).toBe(t.fake.opened);
    // research_done: the title line only, a deep link to the card.
    const inbox = t.app.notifications!.list(t.f.users.owner.id).items;
    expect(inbox).toHaveLength(1);
    expect(inbox[0]).toMatchObject({
      kind: "research_done",
      title: "깊이 조사",
      body: "깊이 조사가 끝났어요: 10월 반도체 수출 조사",
      url: `/c/${conversationId}#m-${done.messageId}`,
    });
  });

  it("streams the job live while it runs (server-sent events), ending with the end", async () => {
    const t = await start();
    const { job } = await begin(t, "느린 조사: 10월 반도체 수출");
    await statusIs(t.app, job.id, "awaiting_approval");
    const address = await t.app.listen({ port: 0, host: "127.0.0.1" });
    const res = await fetch(`${address}/api/research/${job.id}/events`, {
      headers: { cookie: t.f.cookies.owner, host: "localhost:3000" },
    });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const seen: { status: string; running: number; at: number }[] = [];
    const reader = (async () => {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += dec.decode(chunk, { stream: true });
        for (let i = buf.indexOf("\n\n"); i !== -1; i = buf.indexOf("\n\n")) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (!data) continue;
          const j = ResearchJob.parse(JSON.parse(data));
          seen.push({
            status: j.status,
            running: j.questions.filter((q) => q.status === "running").length,
            at: Date.now(),
          });
        }
      }
    })();
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    await reader;
    expect(seen[0]!.status).toBe("awaiting_approval");
    expect(seen.at(-1)!.status).toBe("done");
    // Each change came as it happened: the sub-researchers running, well before the end.
    const running = seen.find((e) => e.running > 0)!;
    expect(running).toBeDefined();
    expect(seen.at(-1)!.at - running.at).toBeGreaterThan(1500);
  });

  it("runs the sub-researchers in parallel, never more than the bound, and takes the owner's edits", async () => {
    const t = await start({
      script: scripted((x) => (x.startsWith(TURN_MARK.subagent) ? slowNotes() : undefined)),
    });
    const { job } = await begin(t);
    await statusIs(t.app, job.id, "awaiting_approval");
    const subQuestions = Array.from({ length: 6 }, (_, i) => ({
      question: `증가율 측면 ${i + 1}`,
      scope: "files",
    }));
    const ok = await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, { subQuestions });
    expect(ok.statusCode, ok.body).toBe(200);
    const plan = ResearchJob.parse(ok.json()).plan!;
    // Edits replace the plan; no attachment → the web only, whatever the card said.
    expect(plan.subQuestions.map((q) => [q.id, q.scope])).toEqual(
      subQuestions.map((_, i) => [`q${i + 1}`, "web"]),
    );
    await statusIs(t.app, job.id, "done");
    expect(t.counting.turns.filter((x) => x.startsWith(TURN_MARK.subagent))).toHaveLength(6);
    expect(t.counting.max).toBe(3);
  });

  it("stops a sub-researcher at its tool-call limit and keeps the notes it wrote", async () => {
    const [, B] = FIXTURE_PAGES as [{ url: string }, { url: string }];
    const script = scripted((x) =>
      x.startsWith(TURN_MARK.subagent)
        ? [
            { call: "web_fetch", input: { url: A.url } },
            {
              textRefs: `NOTE ${JSON.stringify({ claim: "메모리", sourceId: "{{$0.sourceId}}", quote: RESEARCH_FIXTURE.memory })}\n`,
            },
            { call: "web_fetch", input: { url: B.url } },
            { call: "web_fetch", input: { url: A.url } },
            { call: "web_fetch", input: { url: B.url } },
            { text: "DONE" },
          ]
        : undefined,
    );
    // Two calls each: the third one stops the sub-researcher (its token revoked at once, #173's rule).
    const t = await start({ script, limits: { subagentToolCalls: 2 } });
    const { job } = await begin(t);
    await statusIs(t.app, job.id, "awaiting_approval");
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    await statusIs(t.app, job.id, "done");
    const view = ResearchJob.parse((await t.api(t.f.cookies.owner, "GET", `/api/research/${job.id}`)).json());
    expect(view.questions.map((q) => [q.status, q.notes])).toEqual([
      ["capped", 1],
      ["capped", 1],
    ]);
  });

  it("asks one clarifying question at most, and cancels at the card", async () => {
    const t = await start();
    const { job } = await begin(t, "모호한 질문이에요");
    const c = await statusIs(t.app, job.id, "clarifying");
    expect(c.clarifyQuestion).toContain("기간");
    const r = await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/clarify`, {
      answer: "2026년 10월",
    });
    expect(r.statusCode, r.body).toBe(200);
    await statusIs(t.app, job.id, "awaiting_approval");
    expect(t.fake.turnLog.at(-1)!.input).toContain("사용자의 답: 2026년 10월");
    const x = await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/cancel`);
    expect(ResearchJob.parse(x.json()).status).toBe("cancelled");
    // Too late now.
    const again = await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    expect(again.statusCode).toBe(409);
    expect(again.json()).toEqual({ error: "research_state" });
    expect(t.app.notifications!.list(t.f.users.owner.id).items).toHaveLength(0);
  });

  it("researches attached files with file_cite (decision 5)", async () => {
    const dataDir = path.join(tmp(), "data");
    const LINE = "2026년 3분기 매출은 1,234억 원으로 전년보다 12% 늘었다.";
    const script = scripted((x) => {
      if (x.startsWith(TURN_MARK.plan))
        return [
          {
            text: JSON.stringify({
              title: "첨부 자료 조사",
              estimateMinutes: 3,
              subQuestions: [{ question: "첨부 자료의 매출", scope: "files" }],
            }),
          },
        ];
      if (x.startsWith(TURN_MARK.subagent)) {
        const fileId = /\(fileId: ([^)]+)\)/.exec(x)![1]!;
        return [
          { call: "file_read", input: { fileId } },
          { text: `NOTE ${JSON.stringify({ claim: "매출이 늘었다", fileId, quote: LINE })}\nDONE` },
        ];
      }
      return undefined;
    });
    const t = await start({ script, dataDir });
    const c = t.app.conversations!.create(t.f.users.owner.id);
    const up = await t.app.inject({
      method: "POST",
      url: `/api/conversations/${c.id}/files`,
      headers: {
        host: "localhost:3000",
        origin: "http://localhost:3000",
        [CSRF_HEADER]: "1",
        cookie: t.f.cookies.owner,
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent("실적.txt"),
        "x-upload-id": crypto.randomUUID(),
      },
      payload: Buffer.from(`실적 메모\n${LINE}\n`),
    });
    expect(up.statusCode, up.body).toBe(201);
    const fileId = (up.json() as { id: string }).id;
    await t.app.fileExtracts!.idle();
    const { job } = await begin(t, "첨부한 실적 메모를 조사해 줘", { fileIds: [fileId] }, c.id);
    expect(job.files).toBe(1);
    await statusIs(t.app, job.id, "awaiting_approval");
    expect(t.fake.turnLog.at(-1)!.input).toContain(`(fileId: ${fileId})`);
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    const done = await statusIs(t.app, job.id, "done", "failed");
    expect(done.status).toBe("done");
    expect(t.fake.contexts.at(-1)!.tools).toEqual(["cite", "file_cite"]);
    const content = t.app.artifacts!.version(JSON.parse(done.result!).artifactId, 1)!.content;
    // The fake writer cites file notes with file_cite: the report lists the file with its passage.
    expect(content).toContain("📎 실적.txt");
    expect(content).toContain("1,234억");
  });
});

/** A sub-researcher that takes a moment, then writes one verified note. */
function slowNotes(): FakeStep[] {
  return [
    { delayMs: 150 },
    { call: "web_fetch", input: { url: A.url } },
    {
      textRefs: `NOTE ${JSON.stringify({ claim: "메모리", sourceId: "{{$0.sourceId}}", quote: RESEARCH_FIXTURE.memory })}\nDONE`,
    },
  ];
}

describe("깊이 조사: the 30-minute cap, stop and restart", () => {
  it("stops research at its budget and writes up what was verified (forced wrap-up, fake clock)", async () => {
    const clock = new ManualClock();
    // Sub-researchers write their note, then keep going until they are stopped.
    const script = scripted((x) =>
      x.startsWith(TURN_MARK.subagent) ? [...slowNotes().slice(1), { gate: "never" }] : undefined,
    );
    const t = await start({ script, clock });
    const { job } = await begin(t);
    await statusIs(t.app, job.id, "awaiting_approval");
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    await until(() => t.counting.active === 2, "two running sub-researchers");
    // Their notes are written (the fake's steps before the gate take a moment).
    await new Promise((r) => setTimeout(r, 300));
    expect(t.app.research!.get(job.id)!.deadlineAt).toBe(clock.now() + 30 * MIN);
    // Twenty minutes on: the research budget is over — the sub-researchers are stopped, the writer starts.
    clock.advance(20 * MIN);
    const done = await statusIs(t.app, job.id, "done");
    const result = JSON.parse(done.result!) as { timedOut: boolean; fallback: boolean };
    expect(result).toMatchObject({ timedOut: true, fallback: false });
    const view = ResearchJob.parse((await t.api(t.f.cookies.owner, "GET", `/api/research/${job.id}`)).json());
    expect(view.questions.map((q) => q.status)).toEqual(["capped", "capped"]);
    const content = t.app.artifacts!.version(view.result!.artifactId, 1)!.content;
    expect(content).toContain("30분 시간 상한에 걸려 일부만 조사했어요");
    expect(t.fake.closed).toBe(t.fake.opened);
  });

  it("never passes the cap: a writer that does not finish is cut, the verified passages are the report", async () => {
    const clock = new ManualClock();
    const script = scripted((x) =>
      x.startsWith(TURN_MARK.writer)
        ? [{ text: "## 요약\n\n쓰는 중" }, { gate: "never" }]
        : x.startsWith(TURN_MARK.subagent)
          ? slowNotes()
          : undefined,
    );
    const t = await start({ script, clock });
    const { job } = await begin(t);
    await statusIs(t.app, job.id, "awaiting_approval");
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    const approvedAt = clock.now();
    await statusIs(t.app, job.id, "writing");
    await until(() => t.counting.turns.some((x) => x.startsWith(TURN_MARK.writer)), "the writer");
    // The writer's own limit (8 minutes) ends it before the cap; the job is done within 30 minutes of approval.
    clock.advance(8 * MIN);
    const done = await statusIs(t.app, job.id, "done");
    expect(done.endedAt! - approvedAt).toBeLessThanOrEqual(30 * MIN);
    const result = JSON.parse(done.result!) as { timedOut: boolean; fallback: boolean; removed: number };
    expect(result).toMatchObject({ timedOut: true, fallback: true });
    const content = t.app.artifacts!.version(JSON.parse(done.result!).artifactId, 1)!.content;
    expect(content).toContain(`“${RESEARCH_FIXTURE.memory.replace(".", "")}`);
    expect(content).toContain("확인된 원문 구절을 하위 질문별로 그대로 정리했어요");
    expect(content).not.toContain("쓰는 중");
  });

  it("stops at the owner's 중지: every step ends, research_failed says so", async () => {
    const script = scripted((x) => (x.startsWith(TURN_MARK.subagent) ? [{ gate: "never" }] : undefined));
    const t = await start({ script });
    const { job } = await begin(t);
    await statusIs(t.app, job.id, "awaiting_approval");
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    await until(() => t.counting.active === 2, "two running sub-researchers");
    const r = await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/stop`);
    expect(ResearchJob.parse(r.json()).status).toBe("stopped");
    await until(() => t.counting.active === 0, "the sub-researchers to stop");
    await t.app.research!.idle();
    expect(t.app.research!.get(job.id)!.status).toBe("stopped");
    expect(t.fake.closed).toBe(t.fake.opened);
    const inbox = t.app.notifications!.list(t.f.users.owner.id).items;
    expect(inbox.map((n) => [n.kind, n.body])).toEqual([
      ["research_failed", "깊이 조사를 마치지 못했어요: 10월 반도체 수출 조사 — 중지했어요"],
    ]);
  });

  it("resumes after a restart from its checkpoint: a finished sub-question is not asked again", async () => {
    const db = createTestDb();
    const holdSecond = scripted((x) =>
      x.startsWith(TURN_MARK.subagent) && x.includes("배경") ? [{ gate: "restart-hold" }] : undefined,
    );
    const t1 = await start({ db, script: holdSecond });
    const { job } = await begin(t1);
    await statusIs(t1.app, job.id, "awaiting_approval");
    await t1.api(t1.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    await until(
      () => t1.app.research!.get(job.id)!.state.includes('"status":"done"'),
      "the first sub-question",
    );
    await t1.app.close();
    expect(t1.app.research!.get(job.id)!.status).toBe("researching");

    const t2 = await start({ db, family: false });
    const done = await statusIs(t2.app, job.id, "done");
    const asked = t2.counting.turns.filter((x) => x.startsWith(TURN_MARK.subagent));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain("수출 증가의 배경");
    expect(JSON.parse(done.result!)).toMatchObject({ timedOut: false });
  });

  it("past its deadline after a restart, the job is written up from what was verified", async () => {
    const db = createTestDb();
    const clock = new ManualClock();
    const hold = scripted((x) =>
      x.startsWith(TURN_MARK.subagent) && x.includes("배경") ? [{ gate: "late-hold" }] : undefined,
    );
    const t1 = await start({ db, script: hold, clock });
    const { job } = await begin(t1);
    await statusIs(t1.app, job.id, "awaiting_approval");
    await t1.api(t1.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    await until(
      () => t1.app.research!.get(job.id)!.state.includes('"status":"done"'),
      "the first sub-question",
    );
    await t1.app.close();
    // The server was down for 40 minutes.
    clock.advance(40 * MIN);
    const t2 = await start({ db, family: false, clock });
    const done = await statusIs(t2.app, job.id, "done");
    expect(t2.counting.turns).toHaveLength(0);
    expect(JSON.parse(done.result!)).toMatchObject({ timedOut: true, fallback: true });
  });
});

describe("깊이 조사: notifications, Codex conversations and permissions", () => {
  it("keeps the push for after quiet hours, and honours the per-kind switches", async () => {
    const noon = Date.UTC(2026, 10, 19, 3, 0, 0); // 12:00 in Seoul
    const t = await start({ notificationsNow: () => noon });
    const quiet = await t.api(t.f.cookies.owner, "PUT", "/api/notifications/prefs", {
      quietStart: "11:00",
      quietEnd: "13:00",
      timeZone: "Asia/Seoul",
    });
    expect(quiet.statusCode, quiet.body).toBe(200);
    const one = await begin(t);
    await statusIs(t.app, one.job.id, "awaiting_approval");
    await t.api(t.f.cookies.owner, "POST", `/api/research/${one.job.id}/approve`, {});
    await statusIs(t.app, one.job.id, "done");
    const held = t.db.$client
      .prepare("select kind, push_state as s from notifications where user_id = ?")
      .all(t.f.users.owner.id);
    expect(held).toEqual([{ kind: "research_done", s: "held" }]);
    // 완료 off: nothing for the next job (실패 still on).
    const off = await t.api(t.f.cookies.owner, "PUT", "/api/notifications/prefs", { researchDone: false });
    expect(off.json()).toMatchObject({ researchDone: false, researchFailed: true });
    const two = await begin(t);
    await statusIs(t.app, two.job.id, "awaiting_approval");
    await t.api(t.f.cookies.owner, "POST", `/api/research/${two.job.id}/approve`, {});
    await statusIs(t.app, two.job.id, "done");
    expect(t.app.notifications!.list(t.f.users.owner.id).items).toHaveLength(1);
  });

  it("composes the notifications from a title line only", () => {
    const done = compose({ kind: "research_done", topic: "x".repeat(200), url: "/c/1#m-2" });
    expect(done.body).toBe(`깊이 조사가 끝났어요: ${"x".repeat(29)}…`);
    const failed = compose({
      kind: "research_failed",
      topic: "주제\n둘째 줄",
      reason: "중지했어요",
      url: "//evil",
    });
    expect(failed).toMatchObject({
      body: "깊이 조사를 마치지 못했어요: 주제 둘째 줄 — 중지했어요",
      url: "/",
    });
  });

  it("is for Claude conversations only (a Codex conversation is refused)", async () => {
    const t = await start();
    const c = t.app.conversations!.create(t.f.users.owner.id);
    t.app.conversations!.setSettings(c.id, {
      runtime: "codex",
      model: "fake-large",
      effort: null,
      useShared: false,
    });
    const r = await t.api(t.f.cookies.owner, "POST", `/api/conversations/${c.id}/research`, {
      text: "조사해 줘",
    });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: "research_claude_only" });
    expect(t.app.conversations!.messages(c.id, { limit: 10 })).toHaveLength(0);
  });

  it("is for youth accounts too (the Claude backend), one job at a time per user, no quota", async () => {
    const t = await start({
      script: scripted((x) => (x.startsWith(TURN_MARK.plan) ? [{ gate: "plan-hold" }] : undefined)),
    });
    t.app.users!.setYouth(t.f.users.owner.id, true);
    const { job } = await begin(t);
    const second = t.app.conversations!.create(t.f.users.owner.id);
    const busy = await t.api(t.f.cookies.owner, "POST", `/api/conversations/${second.id}/research`, {
      text: "또",
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({ error: "research_busy" });
    // The youth guideline goes to every step.
    await until(() => t.fake.systemPrompts.length > 0, "the plan step");
    expect(t.fake.systemPrompts[0]).toContain("청소년");
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/cancel`);
    await t.app.research!.idle();
    const next = await t.api(t.f.cookies.owner, "POST", `/api/conversations/${second.id}/research`, {
      text: "또",
    });
    expect(next.statusCode, next.body).toBe(201);
  });

  it("lets a shared viewer read the card but not start, approve or stop", async () => {
    const t = await start();
    const { conversationId, job } = await begin(t);
    shareWithShared(t.f, conversationId);
    await statusIs(t.app, job.id, "awaiting_approval");
    const seen = await t.api(t.f.cookies.shared, "GET", `/api/research/${job.id}`);
    expect(seen.statusCode).toBe(200);
    expect(ResearchJob.parse(seen.json()).owned).toBe(false);
    for (const a of ["approve", "cancel", "stop"]) {
      const r = await t.api(t.f.cookies.shared, "POST", `/api/research/${job.id}/${a}`, {});
      expect(r.statusCode, a).toBe(403);
    }
    const s = await t.api(t.f.cookies.shared, "POST", `/api/conversations/${conversationId}/research`, {
      text: "x",
    });
    expect(s.statusCode).toBe(403);
    expect((await t.api(t.f.cookies.stranger, "GET", `/api/research/${job.id}`)).statusCode).toBe(403);
    expect(t.app.research!.get(job.id)!.status).toBe("awaiting_approval");
  });

  it("stops when its conversation is deleted", async () => {
    const script = scripted((x) => (x.startsWith(TURN_MARK.subagent) ? [{ gate: "never" }] : undefined));
    const t = await start({ script });
    const { conversationId, job } = await begin(t);
    await statusIs(t.app, job.id, "awaiting_approval");
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    await until(() => t.counting.active === 2, "two running sub-researchers");
    t.app.conversations!.delete(conversationId);
    await until(() => t.counting.active === 0, "the sub-researchers to stop");
    await t.app.research!.idle();
    expect(t.app.research!.get(job.id)).toBeUndefined();
  });
});
