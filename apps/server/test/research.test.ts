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
import { RETRY_MARK, TURN_MARK } from "../src/research/prompts.js";
import {
  RuntimeRegistry,
  type RuntimeAdapter,
  type RuntimeEvent,
  type RuntimeSession,
  type StartContext,
} from "../src/runtime/adapter.js";
import { fixtureWebWorker, FIXTURE_PAGES, type FixturePage } from "../src/runtime/fake-citations.js";
import type { WebWorker } from "../src/web/service.js";
import { SourceStore } from "../src/web/sources.js";

/** The citation fixture pages and `extra` ones (#234), answered in-process. */
const withPages = (extra: readonly (FixturePage & { finalUrl?: string })[]): WebWorker => {
  const base = fixtureWebWorker();
  return async (job, proxy) => {
    const p = job.op === "fetch" ? extra.find((x) => x.url === job.url) : undefined;
    return p
      ? {
          ok: true,
          finalUrl: p.finalUrl ?? p.url,
          title: p.title,
          site: p.site,
          contentType: "text/html",
          text: p.text,
          truncated: false,
        }
      : base(job, proxy);
  };
};
import { RESEARCH_FIXTURE } from "../src/runtime/fake-research.js";
import {
  defaultScript,
  FakeRuntime,
  releaseGate,
  type FakeScript,
  type FakeStep,
} from "../src/runtime/fake.js";
import { createFamily, shareWithShared } from "./helpers/permission-matrix.js";
import { McpTokens } from "../src/isolation/tokens.js";

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
    /** More fixture pages (#234), answered in-process like the citation fixtures (`finalUrl`: a redirect's target). */
    pages?: (FixturePage & { finalUrl?: string })[];
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
      web: {
        worker: withPages(o.pages ?? []),
        fetchProxy: stubProxy as never,
        providers: ["duckduckgo"],
      },
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
    expect(tools).toContainEqual(["web_search", "web_fetch", "web_find"]);
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
    const subs = t.counting.turns.filter((x) => x.startsWith(TURN_MARK.subagent));
    // Each rests on one page only: each is researched once more (#234), within the same bound.
    expect(subs.filter((x) => !x.includes(RETRY_MARK))).toHaveLength(6);
    expect(subs.filter((x) => x.includes(RETRY_MARK))).toHaveLength(6);
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
              subQuestions: [
                { question: "첨부 자료의 매출", scope: "files" },
                { question: "첨부 자료의 증가율", scope: "files" },
              ],
            }),
          },
        ];
      // The lead asks for a web gap: the server keeps it within the approved sources (files only).
      if (x.startsWith(TURN_MARK.reflect))
        return [{ text: '{"gaps":[{"question":"웹에서 업계 매출 전망","scope":"web"}]}' }];
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
    // A files-only plan never searches the web — the gap question too was kept to the files.
    expect(t.fake.contexts.flatMap((c) => c.tools).filter((x) => x.startsWith("web_"))).toEqual([]);
    expect(sourcesOf(t.db, c.id)).toBe(0);
    const v = ResearchJob.parse((await t.api(t.f.cookies.owner, "GET", `/api/research/${done.id}`)).json());
    expect(v.questions.map((q) => [q.round, q.scope])).toEqual([
      [0, "files"],
      [0, "files"],
      [1, "files"],
    ]);
    const content = t.app.artifacts!.version(JSON.parse(done.result!).artifactId, 1)!.content;
    // The fake writer cites file notes with file_cite: the report lists the file with its passage.
    // The verified place of the passage (the check's own locator, not a page the model named).
    expect(content).toMatch(/📎 실적\.txt · \S/);
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
    const asked = t2.counting.turns.filter(
      (x) => x.startsWith(TURN_MARK.subagent) && !x.includes(RETRY_MARK),
    );
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

/** A runtime that never stops a writer's turn, nor closes its session, until `release()` (#212 review 1). */
class Hanging extends Counting {
  private releases: (() => void)[] = [];
  private released = false;
  release() {
    this.released = true;
    for (const r of this.releases.splice(0)) r();
  }
  override async start(ctx: StartContext): Promise<RuntimeSession> {
    const s = await super.start(ctx);
    if (!ctx.systemPrompt.includes("보고서 작성자")) return s;
    const hang = () => new Promise<void>((r) => (this.released ? r() : this.releases.push(r)));
    return {
      ...s,
      close: async () => {
        await hang();
        await s.close();
      },
      turn: (input) => {
        this.turns.push(input.text);
        return {
          events: (async function* (): AsyncGenerator<RuntimeEvent> {
            await hang();
            yield* [];
          })(),
          interrupt: async () => {},
        };
      },
    };
  }
}

describe("깊이 조사: review 1 (#212)", () => {
  it("a step that does not stop never holds the job past its cap: the writer is cut, the report is the passages", async () => {
    const clock = new ManualClock();
    const db = createTestDb();
    const hanging = new Hanging(
      new FakeRuntime({
        runTools: true,
        script: scripted((x) => (x.startsWith(TURN_MARK.subagent) ? slowNotes() : undefined)),
      }),
    );
    const runtimes = new RuntimeRegistry();
    runtimes.register(hanging);
    const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
      db,
      logger: false,
      runtimes,
      runs: { flushMs: 0 },
      web: { worker: fixtureWebWorker(), fetchProxy: stubProxy as never, providers: ["duckduckgo"] },
      mcp: { skills: [SELFTEST_SKILL], egress: () => stubProxy as never },
      research: { clock },
    });
    closers.push(() => app.close());
    closers.push(() => hanging.release());
    await app.ready();
    const f = await createFamily(app);
    const api = (method: "POST" | "GET", url: string, payload?: unknown) =>
      app.inject({
        method,
        url,
        headers: {
          host: "localhost:3000",
          cookie: f.cookies.owner,
          origin: "http://localhost:3000",
          [CSRF_HEADER]: "1",
          ...(payload === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      });
    const c = app.conversations!.create(f.users.owner.id);
    const r = await api("POST", `/api/conversations/${c.id}/research`, { text: "10월 반도체 수출" });
    const id = (r.json() as { job: { id: string } }).job.id;
    await statusIs(app, id, "awaiting_approval");
    await api("POST", `/api/research/${id}/approve`, {});
    const approvedAt = clock.now();
    await statusIs(app, id, "writing");
    await until(() => hanging.turns.some((x) => x.startsWith(TURN_MARK.writer)), "the writer");
    clock.advance(8 * MIN);
    const done = await statusIs(app, id, "done");
    expect(done.endedAt! - approvedAt).toBeLessThanOrEqual(30 * MIN);
    expect(JSON.parse(done.result!)).toMatchObject({ fallback: true, timedOut: true });
  });

  it("closes a step's session at its timeout, also when its events wait for that close (review 2)", async () => {
    const clock = new ManualClock();
    let closed = 0;
    const inner = new FakeRuntime({
      runTools: true,
      script: scripted((x) => (x.startsWith(TURN_MARK.subagent) ? slowNotes() : undefined)),
    });
    class ClosesOnly extends Counting {
      override async start(ctx: StartContext): Promise<RuntimeSession> {
        const s = await super.start(ctx);
        if (!ctx.systemPrompt.includes("보고서 작성자")) return s;
        let release!: () => void;
        const gone = new Promise<void>((r) => (release = r));
        return {
          ...s,
          close: async () => {
            closed++;
            release();
          },
          turn: (input) => {
            this.turns.push(input.text);
            return {
              events: (async function* (): AsyncGenerator<RuntimeEvent> {
                await gone;
                yield* [];
              })(),
              interrupt: async () => {},
            };
          },
        };
      }
    }
    const adapter = new ClosesOnly(inner);
    const runtimes = new RuntimeRegistry();
    runtimes.register(adapter);
    const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
      db: createTestDb(),
      logger: false,
      runtimes,
      runs: { flushMs: 0 },
      web: { worker: fixtureWebWorker(), fetchProxy: stubProxy as never, providers: ["duckduckgo"] },
      mcp: { skills: [SELFTEST_SKILL], egress: () => stubProxy as never },
      research: { clock },
    });
    closers.push(() => app.close());
    await app.ready();
    const f = await createFamily(app);
    const c = app.conversations!.create(f.users.owner.id);
    const job = app.research!.start({
      conversationId: c.id,
      userId: f.users.owner.id,
      text: "10월 반도체 수출",
    }).row;
    await statusIs(app, job.id, "awaiting_approval");
    app.research!.approve(job.id, f.users.owner.id);
    await until(() => adapter.turns.some((x) => x.startsWith(TURN_MARK.writer)), "the writer");
    clock.advance(8 * MIN);
    await statusIs(app, job.id, "done");
    expect(closed).toBe(1);
  });

  it("opens no further Claude step once the conversation is switched to Codex mid-run (review 2)", async () => {
    const script = scripted((x) =>
      x.startsWith(TURN_MARK.subagent) ? [{ gate: "switch-hold" }] : undefined,
    );
    const t = await start({ script });
    const { conversationId, job } = await begin(t);
    await statusIs(t.app, job.id, "awaiting_approval");
    const subQuestions = Array.from({ length: 4 }, (_, i) => ({ question: `측면 ${i + 1}`, scope: "web" }));
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, { subQuestions });
    await until(() => t.counting.active === 3, "three running sub-researchers");
    t.app.conversations!.setSettings(conversationId, {
      runtime: "codex",
      model: "fake-large",
      effort: null,
      useShared: false,
    });
    // The running ones finish; no fourth sub-researcher, no reflection, no writer.
    releaseGate("switch-hold");
    const failed = await statusIs(t.app, job.id, "failed");
    expect(failed.errorCode).toBe("runtime_changed");
    const asked = t.counting.turns.filter((x) => !x.startsWith(TURN_MARK.plan));
    expect(asked.filter((x) => x.startsWith(TURN_MARK.subagent))).toHaveLength(3);
    expect(asked.filter((x) => !x.startsWith(TURN_MARK.subagent))).toHaveLength(0);
  });

  it("keeps a sub-researcher to its own tools at our MCP server (a cite call is refused there)", async () => {
    const script = scripted((x) =>
      x.startsWith(TURN_MARK.subagent)
        ? [
            { call: "web_fetch", input: { url: A.url } },
            { call: "cite", input: { sourceId: "$0.sourceId", snippet: RESEARCH_FIXTURE.memory } },
            {
              textRefs: `NOTE ${JSON.stringify({ claim: "메모리", sourceId: "{{$0.sourceId}}", quote: RESEARCH_FIXTURE.memory })}\nDONE`,
            },
          ]
        : undefined,
    );
    const t = await start({ script });
    const { job } = await begin(t);
    await statusIs(t.app, job.id, "awaiting_approval");
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    await statusIs(t.app, job.id, "done");
    const sub = t.db.$client
      .prepare("select count(*) as n from citations where run_id like ? and run_id not like ?")
      .get(`research:${job.id}:%`, `research:${job.id}:write%`) as { n: number };
    expect(sub.n).toBe(0);
  });

  it("refuses an approval or an answer after the conversation was switched to Codex, and ends a resumed job", async () => {
    const t = await start();
    const { conversationId, job } = await begin(t);
    await statusIs(t.app, job.id, "awaiting_approval");
    t.app.conversations!.setSettings(conversationId, {
      runtime: "codex",
      model: "fake-large",
      effort: null,
      useShared: false,
    });
    const r = await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: "research_claude_only" });

    const db = createTestDb();
    const hold = scripted((x) => (x.startsWith(TURN_MARK.subagent) ? [{ gate: "codex-hold" }] : undefined));
    const t1 = await start({ db, script: hold });
    const two = await begin(t1);
    await statusIs(t1.app, two.job.id, "awaiting_approval");
    await t1.api(t1.f.cookies.owner, "POST", `/api/research/${two.job.id}/approve`, {});
    await until(() => t1.counting.active === 2, "running sub-researchers");
    await t1.app.close();
    t1.app.conversations!.setSettings(two.conversationId, {
      runtime: "codex",
      model: "fake-large",
      effort: null,
      useShared: false,
    });
    const t2 = await start({ db, family: false });
    const failed = await statusIs(t2.app, two.job.id, "failed");
    expect(failed.errorCode).toBe("runtime_changed");
    expect(t2.counting.turns).toHaveLength(0);
  });

  it("counts what the writer wrote without a citation also when the report falls back to the passages", async () => {
    const script = scripted((x) =>
      x.startsWith(TURN_MARK.writer) ? [{ text: "근거 없는 문장이다. 이것도 근거가 없다." }] : undefined,
    );
    const t = await start({ script });
    const { job } = await begin(t);
    await statusIs(t.app, job.id, "awaiting_approval");
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    const done = await statusIs(t.app, job.id, "done");
    expect(JSON.parse(done.result!)).toMatchObject({ fallback: true, removed: 2 });
  });

  it("finishes once: a report this job already made is used again, not doubled", async () => {
    const t = await start();
    const { conversationId, job } = await begin(t);
    t.app.artifacts!.create(
      { userId: t.f.users.owner.id, conversationId, runId: `research:${job.id}` },
      { kind: "markdown", title: "이전", content: "이전 내용" },
    );
    await statusIs(t.app, job.id, "awaiting_approval");
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    const done = await statusIs(t.app, job.id, "done");
    const mine = t.app.artifacts!.list(conversationId).filter((a) => a.runId === `research:${job.id}`);
    expect(mine).toHaveLength(1);
    expect(JSON.parse(done.result!)).toMatchObject({ artifactId: mine[0]!.id, version: 2 });
  });

  it("shares the report with the card: live share, snapshot (only once the job ended) and a fork read its body", async () => {
    const t = await start();
    const { conversationId, job } = await begin(t);
    const share = (boundaryMessageId: string) =>
      t.api(t.f.cookies.owner, "POST", `/api/conversations/${conversationId}/shares`, {
        target: { audience: "users", userIds: [t.f.users.shared.id] },
        mode: "snapshot",
        boundaryMessageId,
      });
    const planned = await statusIs(t.app, job.id, "awaiting_approval");
    // The card still changes: no snapshot of it yet.
    const early = await share(planned.messageId);
    expect(early.statusCode).toBe(409);
    expect(early.json()).toEqual({ error: "share_run_in_progress" });
    shareWithShared(t.f, conversationId);
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    const done = await statusIs(t.app, job.id, "done");
    const { artifactId } = JSON.parse(done.result!) as { artifactId: string };
    const body = await t.api(t.f.cookies.shared, "GET", `/api/artifacts/${artifactId}/versions/1`);
    expect(body.statusCode, body.body).toBe(200);
    expect(body.body).toContain("10월 반도체 수출 조사");
    const snap = await share(done.messageId);
    expect(snap.statusCode, snap.body).toBe(201);
    const fork = await t.api(
      t.f.cookies.shared,
      "POST",
      `/api/shares/${(snap.json() as { id: string }).id}/fork`,
      {},
    );
    expect(fork.statusCode, fork.body).toBe(201);
    const forked = (fork.json() as { conversation: { id: string } }).conversation.id;
    const list = (
      await t.api(t.f.cookies.shared, "GET", `/api/conversations/${forked}/artifacts`)
    ).json() as {
      items: { id: string }[];
    };
    expect(list.items).toHaveLength(1);
    const copy = await t.api(t.f.cookies.shared, "GET", `/api/artifacts/${list.items[0]!.id}/versions/1`);
    expect(copy.body).toContain("## 출처");
  });

  it("ends a card's open progress stream at shutdown", async () => {
    const t = await start();
    const { job } = await begin(t);
    await statusIs(t.app, job.id, "awaiting_approval");
    const address = await t.app.listen({ port: 0, host: "127.0.0.1" });
    const res = await fetch(`${address}/api/research/${job.id}/events`, {
      headers: { cookie: t.f.cookies.owner, host: "localhost:3000" },
    });
    expect(res.status).toBe(200);
    const t0 = Date.now();
    await t.app.close();
    expect(Date.now() - t0).toBeLessThan(5000);
    await res.body?.cancel().catch(() => {});
  });

  it("refuses an unknown backend and a plan of fewer than two sub-questions", async () => {
    const t = await start();
    const c = t.app.conversations!.create(t.f.users.owner.id);
    const r = await t.api(t.f.cookies.owner, "POST", `/api/conversations/${c.id}/research`, {
      text: "조사",
      backend: "gemini",
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toEqual({ error: "backend_unavailable" });
    const { job } = await begin(t);
    await statusIs(t.app, job.id, "awaiting_approval");
    const one = await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {
      subQuestions: [{ question: "하나만", scope: "web" }],
    });
    expect(one.statusCode).toBe(400);
  });

  it("counts a step's tool calls at our MCP server: only its tools, never past its budget", () => {
    const tokens = new McpTokens();
    tokens.issue({ userId: "u", conversationId: "c", runId: "r" }, 60_000, {
      tools: ["web_fetch"],
      maxCalls: 2,
    });
    expect(tokens.take("r", "cite")).toBe("tool_not_allowed");
    expect(tokens.take("r", "web_fetch")).toBeUndefined();
    expect(tokens.take("r", "web_fetch")).toBeUndefined();
    expect(tokens.take("r", "web_fetch")).toBe("tool_quota");
    // A run without limits (a chat answer) always may.
    tokens.issue({ userId: "u", conversationId: "c", runId: "chat" });
    expect(tokens.take("chat", "anything")).toBeUndefined();
    tokens.revokeRun("r");
    expect(tokens.wasRevoked("r")).toBe(true);
  });
});

/** Uploads a text file to the owner's conversation and waits for its extraction. */
async function uploadText(
  t: Awaited<ReturnType<typeof start>>,
  conversationId: string,
  name: string,
  text: string,
) {
  const up = await t.app.inject({
    method: "POST",
    url: `/api/conversations/${conversationId}/files`,
    headers: {
      host: "localhost:3000",
      origin: "http://localhost:3000",
      [CSRF_HEADER]: "1",
      cookie: t.f.cookies.owner,
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent(name),
      "x-upload-id": crypto.randomUUID(),
    },
    payload: Buffer.from(text),
  });
  expect(up.statusCode, up.body).toBe(201);
  await t.app.fileExtracts!.idle();
  return (up.json() as { id: string }).id;
}

const filesPlan: FakeStep[] = [
  {
    text: JSON.stringify({
      title: "첨부 자료 조사",
      estimateMinutes: 3,
      subQuestions: [
        { question: "첨부 자료의 매출", scope: "files" },
        { question: "첨부 자료의 증가율", scope: "files" },
      ],
    }),
  },
];

describe("깊이 조사: review 3 (#212)", () => {
  it("gives the writer the search unit the passage was verified in, so file_cite lands on the same line", async () => {
    const LINE = "2026년 3분기 매출은 1,234억 원으로 전년보다 12% 늘었다.";
    const lines = ["실적 메모", LINE, ...Array.from({ length: 39 }, (_, i) => `채움 줄 ${i + 1}`), LINE];
    const at: { unit?: number } = {};
    const script = scripted((x) => {
      if (x.startsWith(TURN_MARK.plan)) return filesPlan;
      if (x.startsWith(TURN_MARK.subagent)) {
        const fileId = /\(fileId: ([^)]+)\)/.exec(x)![1]!;
        return [
          { text: `NOTE ${JSON.stringify({ claim: "매출", fileId, page: at.unit, quote: LINE })}\nDONE` },
        ];
      }
      return undefined;
    });
    const t = await start({ script, dataDir: path.join(tmp(), "data") });
    const c = t.app.conversations!.create(t.f.users.owner.id);
    const fileId = await uploadText(t, c.id, "실적.txt", lines.join("\n") + "\n");
    // The unit holding line 42 (a TXT unit spans several lines: its number is not 42).
    const seg = t.app.fileExtracts!.segments(fileId).find((s) => s.text.includes(`채움 줄 39\n${LINE}`));
    at.unit = seg!.unit;
    const { job } = await begin(t, "첨부한 실적 메모를 조사해 줘", { fileIds: [fileId] }, c.id);
    await statusIs(t.app, job.id, "awaiting_approval");
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    await statusIs(t.app, job.id, "done");
    const cited = t.db.$client
      .prepare("select locator from citations where run_id like ? and file_id = ? and status = 'verified'")
      .all(`research:${job.id}:write%`, fileId) as { locator: string }[];
    expect(cited.length).toBeGreaterThan(0);
    for (const r of cited) expect((JSON.parse(r.locator) as { line?: number }).line).toBe(42);
  });

  it("keeps an old checkpoint's queued gap question within the approved files (no web tool)", async () => {
    const db = createTestDb();
    const dataDir = path.join(tmp(), "data");
    const hold = scripted((x) => {
      if (x.startsWith(TURN_MARK.plan)) return filesPlan;
      if (x.startsWith(TURN_MARK.subagent)) return [{ gate: "old-checkpoint" }];
      return undefined;
    });
    const t1 = await start({ db, script: hold, dataDir });
    const c = t1.app.conversations!.create(t1.f.users.owner.id);
    const fileId = await uploadText(t1, c.id, "실적.txt", "실적 메모\n매출이 늘었다는 메모다.\n");
    const { job } = await begin(t1, "첨부한 실적 메모를 조사해 줘", { fileIds: [fileId] }, c.id);
    await statusIs(t1.app, job.id, "awaiting_approval");
    await t1.api(t1.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    await until(() => t1.counting.active === 2, "running sub-researchers");
    await t1.app.close();
    // As a checkpoint from before the approved scopes were kept: none recorded, a web gap question queued.
    const row = db.$client.prepare("select state from research_jobs where id = ?").get(job.id) as {
      state: string;
    };
    const state = JSON.parse(row.state) as Record<string, unknown> & { questions: Record<string, unknown>[] };
    delete state.scopes;
    state.round = 1;
    state.reflected = 0;
    state.questions.push({
      id: "r1q1",
      question: "웹에서 업계 전망",
      scope: "web",
      round: 1,
      status: "waiting",
      sources: 0,
      found: [],
      dropped: 0,
    });
    // …and web questions it had finished without a note (review #237 1차): their automatic retry stays in the files.
    for (const status of ["done", "capped"])
      state.questions.push({
        id: `r1q${status}`,
        question: `웹에서 ${status}`,
        scope: "web",
        round: 1,
        status,
        sources: 0,
        found: [],
        dropped: 0,
      });
    db.$client.prepare("update research_jobs set state = ? where id = ?").run(JSON.stringify(state), job.id);
    const t2 = await start({ db, family: false, dataDir });
    await statusIs(t2.app, job.id, "done", "failed");
    // The finished web questions were retried — within the files.
    const retried = t2.counting.turns.filter((x) => x.includes(RETRY_MARK) && /웹에서 (done|capped)/.test(x));
    expect(retried).toHaveLength(2);
    for (const x of retried) expect(x).toContain("범위: 첨부 파일만");
    expect(t2.fake.contexts.flatMap((x) => x.tools).filter((x) => x.startsWith("web_"))).toEqual([]);
    expect(sourcesOf(db, c.id)).toBe(0);
  });
});

describe("깊이 조사: fewer gaps — note repair and the automatic retry (#234)", () => {
  const notes = (...n: { claim: string; ref: string; quote: string }[]) =>
    n.map((x) => `NOTE ${JSON.stringify({ claim: x.claim, sourceId: x.ref, quote: x.quote })}`).join("\n") +
    "\nDONE";
  const stateOf = (t: Awaited<ReturnType<typeof start>>, id: string) =>
    JSON.parse(t.app.research!.get(id)!.state) as {
      questions: {
        id: string;
        question: string;
        retried?: boolean;
        unverified?: { key: string; claim: string }[];
        found: { quote: string; sourceId?: string; sourceType?: string }[];
      }[];
    };

  it("a quote that does not match exactly is never rewritten: dropped, its claim only a hint for the retry", async () => {
    const formOnly =
      "“산업통상자원부는 10일 10 월 반도체 수출이 전년 같은 달보다 32% 늘어난 142억 달러로 집계됐다고 밝혔다”";
    const retries: string[] = [];
    const script = scripted((x) => {
      if (!(x.startsWith(TURN_MARK.subagent) && /증가율/.test(x))) return undefined;
      if (x.includes(RETRY_MARK)) {
        retries.push(x);
        return [{ text: "DONE" }];
      }
      return [
        { call: "web_fetch", input: { url: A.url } },
        { call: "web_fetch", input: { url: FIXTURE_PAGES[1]!.url } },
        {
          textRefs: notes(
            // Only a space differs (review #237 4차: still never rewritten — correctness before recall).
            { claim: "산업부는 32% 증가로 발표했다", ref: "{{$0.sourceId}}", quote: formOnly },
            { claim: "통계는 28%다", ref: "{{$1.sourceId}}", quote: RESEARCH_FIXTURE.stats },
            { claim: "수출이 50% 늘었다", ref: "{{$0.sourceId}}", quote: RESEARCH_FIXTURE.wrong },
          ),
        },
      ];
    });
    const t = await start({ script });
    const { job } = await begin(t);
    await statusIs(t.app, job.id, "awaiting_approval");
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    await statusIs(t.app, job.id, "done");
    const q1 = stateOf(t, job.id).questions[0]!;
    expect(q1.found.map((n) => n.quote)).toEqual([RESEARCH_FIXTURE.stats]);
    expect(q1.unverified?.map((c) => c.claim)).toEqual(["산업부는 32% 증가로 발표했다", "수출이 50% 늘었다"]);
    expect(q1.found[0]!.sourceType).toBe("other");
    // One source left: retried, and told which claims failed.
    expect(retries).toHaveLength(1);
    expect(retries[0]).toContain("산업부는 32% 증가로 발표했다");
    expect(retries[0]).toContain("서버는 구절을 고쳐 주지 않는다");
    const writer = t.counting.turns.find((x) => x.startsWith(TURN_MARK.writer))!;
    expect(writer).not.toContain("산업부는 32% 증가로 발표했다");
    const end = ResearchJob.parse((await t.api(t.f.cookies.owner, "GET", `/api/research/${job.id}`)).json());
    expect(end.questions[0]).toEqual(
      expect.objectContaining({ notes: 1, dropped: 2, sources: 1, status: "done" }),
    );
    // The server-only bookkeeping is not part of the API's job — in the raw answer, before any schema parse.
    const raw = (await t.api(t.f.cookies.owner, "GET", `/api/research/${job.id}`)).json() as {
      questions: Record<string, unknown>[];
    };
    for (const q of raw.questions)
      expect(Object.keys(q).sort()).toEqual(
        ["dropped", "id", "notes", "question", "round", "scope", "sources", "status"].sort(),
      );
  });

  it("a sub-question with one source (or none) is researched once more with rewritten queries; its notes are kept", async () => {
    const [, B] = FIXTURE_PAGES as [unknown, { url: string }];
    const retries: string[] = [];
    const script = scripted((x) => {
      if (!x.startsWith(TURN_MARK.subagent) || !/배경/.test(x)) return undefined;
      if (!x.includes(RETRY_MARK))
        return [
          { call: "web_fetch", input: { url: A.url } },
          {
            textRefs: notes(
              {
                claim: "메모리 가격 회복이 이끌었다",
                ref: "{{$0.sourceId}}",
                quote: RESEARCH_FIXTURE.memory,
              },
              {
                claim: "미국 수출 비중이 가장 컸다",
                ref: "{{$0.sourceId}}",
                quote: "미국 수출 비중이 가장 컸다",
              },
            ),
          },
        ];
      retries.push(x);
      return [
        { call: "web_fetch", input: { url: B.url } },
        { call: "web_fetch", input: { url: A.url } },
        {
          textRefs: notes(
            // Already kept from the first run: not counted twice.
            { claim: "메모리 가격 회복이 이끌었다", ref: "{{$1.sourceId}}", quote: RESEARCH_FIXTURE.memory },
            {
              claim: "기준 차이가 있다",
              ref: "{{$0.sourceId}}",
              quote: "이는 선적 기준과 통관 기준의 차이 때문이다.",
            },
          ),
        },
      ];
    });
    const t = await start({ script });
    const { job } = await begin(t);
    await statusIs(t.app, job.id, "awaiting_approval");
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    await statusIs(t.app, job.id, "done");
    // Once, for the weak one only (the growth question rests on two pages); told what failed and what it has.
    expect(retries).toHaveLength(1);
    expect(retries[0]).toContain("미국 수출 비중이 가장 컸다");
    expect(retries[0]).toContain("다른 검색어");
    expect(retries[0]).toContain(RESEARCH_FIXTURE.memory);
    const subs = t.counting.turns.filter((x) => x.startsWith(TURN_MARK.subagent));
    expect(subs.filter((x) => x.includes(RETRY_MARK))).toHaveLength(1);
    const q2 = stateOf(t, job.id).questions[1]!;
    expect(q2.retried).toBe(true);
    expect(q2.found.map((n) => n.quote)).toEqual([
      RESEARCH_FIXTURE.memory,
      "이는 선적 기준과 통관 기준의 차이 때문이다.",
    ]);
    const end = ResearchJob.parse((await t.api(t.f.cookies.owner, "GET", `/api/research/${job.id}`)).json());
    expect(end.questions.map((q) => [q.status, q.notes, q.sources, q.dropped])).toEqual([
      ["done", 2, 2, 1],
      ["done", 2, 2, 1],
    ]);
    // Raw API answer (no schema parse): the retry's bookkeeping and the notes stay on the server.
    const raw = JSON.stringify((await t.api(t.f.cookies.owner, "GET", `/api/research/${job.id}`)).json());
    for (const k of ["retried", "unverified", "failure", "skipped", "found", "claimKey"])
      expect(raw).not.toContain(`"${k}"`);
    expect(raw).not.toContain("미국 수출 비중이 가장 컸다");
    // The lead's reflection saw the claims that could not be verified.
    const reflect = t.counting.turns.find((x) => x.startsWith(TURN_MARK.reflect))!;
    expect(reflect).toContain("원문에서 확인하지 못해 뺀 주장");
  });

  it("no retry when a round no longer fits in the research time", async () => {
    const t = await start({ limits: { minRoundMs: 21 * MIN } });
    const { job } = await begin(t);
    await statusIs(t.app, job.id, "awaiting_approval");
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    await statusIs(t.app, job.id, "done");
    const subs = t.counting.turns.filter((x) => x.startsWith(TURN_MARK.subagent));
    expect(subs).toHaveLength(2);
    expect(subs.some((x) => x.includes(RETRY_MARK))).toBe(false);
  });
  it("a claim whose quote differs from the page in any way never stands: not in the notes, the writer or the report", async () => {
    const page: FixturePage = {
      url: "https://fixture.agentlee.test/gov/policy.html",
      title: "정책 발표",
      site: "정부 누리집",
      text: [
        "정부는 내년부터 지원금을 지급하지 않는다고 밝혔다.",
        "부산시는 2026년 예산을 늘린다고 밝혔다.",
        "수출은 전년보다 −5% 줄었다.",
        "원고가 피고를 먼저 고소했다.",
        "이 상품의 가격은 $50 이상이다.",
        "올해 지원 기준은 소득 < 500만원이다.",
        "이 기체의 성분은 CO 라고 밝혔다.",
        "We agreed to resign today.",
        "선수들의 출발 순서는 1 2 12 순이다.",
        "허용 길이는 3.5미터이다.",
        "수식의 조건은 x! = y 이다.",
        "The selector is .menu .item in this stylesheet.",
        "표시 가격은 50 이상이다.",
        "측정값은 기준값 50 부근이다.",
      ].join("\n"),
    };
    // Review #237 1–4차: each was once "repaired" to the page's sentence and kept with the model's altered claim; a
    // quote is now never rewritten.
    const inverted = [
      { claim: "정부는 내년부터 지원금을 지급한다", quote: "정부는 내년부터 지원금을 지급한다고 밝혔다" },
      { claim: "서울시는 2026년 예산을 늘린다", quote: "서울시는 2026년 예산을 늘린다고 밝혔다" },
      { claim: "수출은 전년보다 5% 늘었다", quote: "수출은 전년보다 +5% 줄었다" },
      { claim: "피고가 원고를 먼저 고소했다", quote: "원고를 피고가 먼저 고소했다" },
      { claim: "가격은 €50 이상이다", quote: "이 상품의 가격은 €50 이상이다" },
      { claim: "소득 500만원 초과가 지원 대상이다", quote: "올해 지원 기준은 소득 > 500만원이다" },
      { claim: "성분은 코발트(Co)다", quote: "이 기체의 성분은 Co 라고 밝혔다" },
      { claim: "They agreed to sign again today", quote: "We agreed to re-sign today" },
      // Review #237 3차.
      { claim: "12번 선수가 먼저 출발한다", quote: "선수들의 출발 순서는 12 1 2 순이다" },
      { claim: "허용 길이는 3에서 5미터다", quote: "허용 길이는 3…5미터이다" },
      { claim: "x와 y는 달라야 한다", quote: "수식의 조건은 x != y 이다" },
      { claim: "두 클래스가 모두 있어야 적용된다", quote: "The selector is .menu.item in this stylesheet" },
      { claim: "표시 가격은 ₹50 이상이다", quote: "표시 가격은 50이상이다" },
      { claim: "측정값은 ≠ 50 이다", quote: "측정값은 기준값 50부근이다" },
    ];
    // Twelve notes a run at most: the first eight in the first run, the rest in the (one-source) retry.
    const script = scripted((x) => {
      if (!x.startsWith(TURN_MARK.subagent) || !/배경/.test(x)) return undefined;
      const mine = x.includes(RETRY_MARK) ? inverted.slice(8) : inverted.slice(0, 8);
      return [
        { call: "web_fetch", input: { url: page.url } },
        { call: "web_fetch", input: { url: A.url } },
        {
          textRefs: notes(
            { claim: "메모리 가격 회복이 이끌었다", ref: "{{$1.sourceId}}", quote: RESEARCH_FIXTURE.memory },
            ...mine.map((n) => ({ ...n, ref: "{{$0.sourceId}}" })),
          ),
        },
      ];
    });
    const t = await start({ script, pages: [page] });
    const { job } = await begin(t);
    await statusIs(t.app, job.id, "awaiting_approval");
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    const done = await statusIs(t.app, job.id, "done");
    const q2 = stateOf(t, job.id).questions[1]!;
    expect(q2.found.map((n) => n.quote)).toEqual([RESEARCH_FIXTURE.memory]);
    // The first five (the kept list's cap); none of the eight reached the notes, the writer or the report.
    expect(q2.unverified?.map((c) => c.claim)).toEqual(inverted.slice(0, 5).map((n) => n.claim));
    const writer = t.counting.turns.find((x) => x.startsWith(TURN_MARK.writer))!;
    const content = t.app.artifacts!.version(JSON.parse(done.result!).artifactId, 1)!.content;
    for (const n of inverted) {
      expect(writer).not.toContain(n.claim);
      expect(content).not.toContain(n.claim);
      expect(content).not.toContain(n.quote);
    }
  });

  it("a retry that finds nothing keeps the claims that failed; the lead sees them", async () => {
    const script = scripted((x) =>
      x.startsWith(TURN_MARK.subagent) && /배경/.test(x) && !x.includes(RETRY_MARK)
        ? [
            { call: "web_fetch", input: { url: A.url } },
            {
              textRefs: notes({
                claim: "미국 수출 비중이 가장 컸다",
                ref: "{{$0.sourceId}}",
                quote: "미국 수출 비중이 가장 컸다",
              }),
            },
          ]
        : undefined,
    );
    const t = await start({ script });
    const { job } = await begin(t);
    await statusIs(t.app, job.id, "awaiting_approval");
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    await statusIs(t.app, job.id, "done");
    expect(stateOf(t, job.id).questions[1]!.unverified?.map((c) => c.claim)).toEqual([
      "미국 수출 비중이 가장 컸다",
    ]);
    const reflect = t.counting.turns.find((x) => x.startsWith(TURN_MARK.reflect))!;
    expect(reflect).toContain("미국 수출 비중이 가장 컸다");
  });

  it("no verified note but claims that failed: the lead's gap question to check them is added and run", async () => {
    const gapRuns: string[] = [];
    const script = scripted((x) => {
      if (x.startsWith(TURN_MARK.reflect))
        return [
          {
            text: JSON.stringify({
              gaps: [{ question: "확인 못 한 증가율을 1차 자료로 확인", scope: "web" }],
            }),
          },
        ];
      if (!x.startsWith(TURN_MARK.subagent)) return undefined;
      if (x.includes("확인 못 한 증가율") && !x.includes(RETRY_MARK)) {
        gapRuns.push(x);
        return [
          { call: "web_fetch", input: { url: A.url } },
          {
            textRefs: notes({
              claim: "메모리 가격 회복",
              ref: "{{$0.sourceId}}",
              quote: RESEARCH_FIXTURE.memory,
            }),
          },
        ];
      }
      if (x.includes(RETRY_MARK)) return [{ text: "DONE" }];
      return [
        { call: "web_fetch", input: { url: A.url } },
        {
          textRefs: notes({
            claim: "수출이 50% 늘었다",
            ref: "{{$0.sourceId}}",
            quote: RESEARCH_FIXTURE.wrong,
          }),
        },
      ];
    });
    const t = await start({ script });
    const { job } = await begin(t);
    await statusIs(t.app, job.id, "awaiting_approval");
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    await statusIs(t.app, job.id, "done");
    expect(gapRuns).toHaveLength(1);
    expect(stateOf(t, job.id).questions.some((q) => q.question.includes("확인 못 한 증가율"))).toBe(true);
  });

  it("one page reached by two URLs is one source: the question is still retried (review #237 7차)", async () => {
    const via: FixturePage & { finalUrl: string } = {
      url: "https://fixture.agentlee.test/r/chips-a",
      finalUrl: A.url,
      title: "10월 반도체 수출 32% 증가",
      site: "가나다 신문",
      text: (FIXTURE_PAGES[0] as { text: string }).text,
    };
    const retries: string[] = [];
    const script = scripted((x) => {
      if (!(x.startsWith(TURN_MARK.subagent) && /배경/.test(x))) return undefined;
      if (x.includes(RETRY_MARK)) {
        retries.push(x);
        return [{ text: "DONE" }];
      }
      return [
        { call: "web_fetch", input: { url: A.url } },
        { call: "web_fetch", input: { url: via.url } },
        {
          textRefs: notes(
            { claim: "메모리 가격 회복", ref: "{{$0.sourceId}}", quote: RESEARCH_FIXTURE.memory },
            { claim: "32% 증가", ref: "{{$1.sourceId}}", quote: RESEARCH_FIXTURE.growth },
          ),
        },
      ];
    });
    const t = await start({ script, pages: [via] });
    const { job } = await begin(t);
    await statusIs(t.app, job.id, "awaiting_approval");
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    await statusIs(t.app, job.id, "done");
    const q2 = stateOf(t, job.id).questions[1]!;
    // Two source rows (two URLs), one page.
    expect(new Set(q2.found.map((n) => n.sourceId)).size).toBe(2);
    const end = ResearchJob.parse((await t.api(t.f.cookies.owner, "GET", `/api/research/${job.id}`)).json());
    expect(end.questions[1]!.sources).toBe(1);
    expect(retries).toHaveLength(1);
  });

  it("a source row moved to another page by a later fetch counts with that page (review #237 16차)", async () => {
    const oldUrl = "https://fixture.agentlee.test/docs/old.pdf";
    const newUrl = "https://agency.gov/docs/new.pdf";
    let oldFetches = 0;
    const text = (FIXTURE_PAGES[0] as { text: string }).text;
    const moving = {
      url: oldUrl,
      title: "보고서",
      site: "기관",
      text,
      // The first fetch ends at the old address; later ones redirect to the agency's new one.
      get finalUrl() {
        return oldFetches++ === 0 ? oldUrl : newUrl;
      },
    };
    const direct = { url: newUrl, finalUrl: newUrl, title: "보고서", site: "기관", text };
    const script = scripted((x) => {
      if (!(x.startsWith(TURN_MARK.subagent) && /배경/.test(x))) return undefined;
      if (!x.includes(RETRY_MARK))
        return [
          { call: "web_fetch", input: { url: oldUrl } },
          { textRefs: notes({ claim: "메모리", ref: "{{$0.sourceId}}", quote: RESEARCH_FIXTURE.memory }) },
        ];
      return [
        { call: "web_fetch", input: { url: oldUrl } },
        { call: "web_fetch", input: { url: newUrl } },
        { textRefs: notes({ claim: "32%", ref: "{{$1.sourceId}}", quote: RESEARCH_FIXTURE.growth }) },
      ];
    });
    const t = await start({ script, pages: [moving, direct] });
    const { job } = await begin(t);
    await statusIs(t.app, job.id, "awaiting_approval");
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    await statusIs(t.app, job.id, "done");
    const q2 = stateOf(t, job.id).questions[1]!;
    expect(q2.found).toHaveLength(2);
    expect(new Set(q2.found.map((n) => n.sourceId)).size).toBe(2);
    expect(q2.found.map((n) => n.sourceType)).toEqual(["government", "government"]);
    const end = ResearchJob.parse((await t.api(t.f.cookies.owner, "GET", `/api/research/${job.id}`)).json());
    expect(end.questions[1]!.sources).toBe(1);
  });

  it("the runtime's own refusal (runtime_policy) is kept and never retried", async () => {
    const script = scripted((x) =>
      x.startsWith(TURN_MARK.subagent) ? [{ fail: "policy", code: "runtime_policy" as const }] : undefined,
    );
    const t = await start({ script });
    const { job } = await begin(t);
    await statusIs(t.app, job.id, "awaiting_approval");
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    const failed = await statusIs(t.app, job.id, "failed");
    expect(t.counting.turns.filter((x) => x.includes(RETRY_MARK))).toHaveLength(0);
    expect(failed.errorCode).toBe("runtime_policy");
  });

  it("a passing runtime error is retried once; an account's state (login) never — even with a note kept", async () => {
    for (const [first, retried, status] of [
      [[{ fail: "boom" }], true, "done"],
      [[{ fail: "login", code: "runtime_auth" as const }], false, "failed"],
      // It kept a note from one page, then the login failed: one source, yet no retry (review #237 2차).
      [
        [
          { call: "web_fetch", input: { url: A.url } },
          {
            textRefs: `NOTE ${JSON.stringify({ claim: "메모리", sourceId: "{{$0.sourceId}}", quote: RESEARCH_FIXTURE.memory })}\n`,
          },
          { fail: "login", code: "runtime_auth" as const },
        ],
        false,
        "done",
      ],
    ] as const) {
      const script = scripted((x) =>
        x.startsWith(TURN_MARK.subagent) && /배경/.test(x) && !x.includes(RETRY_MARK)
          ? (first as unknown as FakeStep[])
          : undefined,
      );
      const t = await start({ script });
      const { job } = await begin(t);
      await statusIs(t.app, job.id, "awaiting_approval");
      await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
      await statusIs(t.app, job.id, "done");
      const retries = t.counting.turns.filter(
        (x) => x.startsWith(TURN_MARK.subagent) && x.includes(RETRY_MARK) && /배경/.test(x),
      );
      expect(retries.length, JSON.stringify(first)).toBe(retried ? 1 : 0);
      expect(stateOf(t, job.id).questions[1]!.status as unknown, JSON.stringify(first)).toBe(status);
    }
    // Several whole jobs in a row: more time than the default under a full-suite load.
  }, 30_000);

  it("nothing verified: the job fails with how the last runs ended (a retry's login failure, not the first error)", async () => {
    const script = scripted((x) =>
      x.startsWith(TURN_MARK.subagent)
        ? x.includes(RETRY_MARK)
          ? [{ fail: "login", code: "runtime_auth" }]
          : [{ fail: "boom" }]
        : undefined,
    );
    const t = await start({ script });
    const { job } = await begin(t);
    await statusIs(t.app, job.id, "awaiting_approval");
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    const failed = await statusIs(t.app, job.id, "failed");
    expect(failed.errorCode).toBe("runtime_auth");
  });

  it("nothing verified and every retry ended cleanly: the job ends as no_findings, not the first runtime error", async () => {
    const script = scripted((x) =>
      x.startsWith(TURN_MARK.subagent)
        ? x.includes(RETRY_MARK)
          ? [{ text: "DONE" }]
          : [{ fail: "boom" }]
        : undefined,
    );
    const t = await start({ script });
    const { job } = await begin(t);
    await statusIs(t.app, job.id, "awaiting_approval");
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    const failed = await statusIs(t.app, job.id, "failed");
    expect(failed.errorCode).toBe("no_findings");
  });

  it("a runtime error whose retry was skipped for time is still the job's error", async () => {
    const clock = new ManualClock();
    let approvedAt = 0;
    const script = scripted((x) => {
      if (!x.startsWith(TURN_MARK.subagent)) return undefined;
      if (!x.includes(RETRY_MARK)) return [{ fail: "boom" }];
      // The first retry ends cleanly and leaves 2.5 minutes: the second is skipped when its slot comes.
      clock.advance(approvedAt + 20 * MIN - 2.5 * MIN - clock.now());
      return [{ text: "DONE" }];
    });
    const t = await start({ script, clock, limits: { concurrency: 1 } });
    const { job } = await begin(t);
    await statusIs(t.app, job.id, "awaiting_approval");
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    approvedAt = t.app.research!.get(job.id)!.approvedAt!;
    const failed = await statusIs(t.app, job.id, "failed");
    expect(t.counting.turns.filter((x) => x.includes(RETRY_MARK))).toHaveLength(1);
    expect(failed.errorCode).toBe("runtime_error");
  });

  it("resumed after a restart, research that then ran and found nothing is no_findings, not server_restart", async () => {
    const db = createTestDb();
    const hold = scripted((x) => (x.startsWith(TURN_MARK.subagent) ? [{ gate: "nothing-hold" }] : undefined));
    const t1 = await start({ db, script: hold });
    const { job } = await begin(t1);
    await statusIs(t1.app, job.id, "awaiting_approval");
    await t1.api(t1.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    await until(() => t1.counting.active === 2, "running sub-researchers");
    await t1.app.close();
    const nothing = scripted((x) => (x.startsWith(TURN_MARK.subagent) ? [{ text: "DONE" }] : undefined));
    const t2 = await start({ db, family: false, script: nothing });
    const failed = await statusIs(t2.app, job.id, "failed");
    expect(t2.counting.turns.filter((x) => x.includes(RETRY_MARK))).toHaveLength(2);
    expect(failed.errorCode).toBe("no_findings");
  });

  /** A job held in research, closed, its checkpoint rewritten by `edit` — then resumed. */
  async function resumedWith(
    edit: (
      state: { questions: Record<string, unknown>[] } & Record<string, unknown>,
      ctx: { db: Db; conversationId: string; ownerId: string },
    ) => void,
    approvedAgo?: number,
  ) {
    const db = createTestDb();
    const hold = scripted((x) => (x.startsWith(TURN_MARK.subagent) ? [{ gate: "edit-hold" }] : undefined));
    const t1 = await start({ db, script: hold });
    const { job } = await begin(t1);
    await statusIs(t1.app, job.id, "awaiting_approval");
    await t1.api(t1.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    await until(() => t1.counting.active === 2, "running sub-researchers");
    await t1.app.close();
    const row = db.$client.prepare("select state from research_jobs where id = ?").get(job.id) as {
      state: string;
    };
    const state = JSON.parse(row.state) as { questions: Record<string, unknown>[] } & Record<string, unknown>;
    edit(state, { db, conversationId: job.conversationId, ownerId: t1.f.users.owner.id });
    db.$client.prepare("update research_jobs set state = ? where id = ?").run(JSON.stringify(state), job.id);
    if (approvedAgo !== undefined)
      db.$client
        .prepare("update research_jobs set approved_at = ? where id = ?")
        .run(Date.now() - approvedAgo, job.id);
    const t2 = await start({ db, family: false });
    return { t2, job, db };
  }

  it("a checkpoint whose notes have no page key: the page is read from the source rows before the retry decision", async () => {
    const { t2, job } = await resumedWith((state, { db, conversationId, ownerId }) => {
      // One page, two source rows (a redirect's URL and the final URL), as the code before #234 stored them.
      const store = new SourceStore(db);
      const scope = { userId: ownerId, conversationId, runId: "research:old" };
      const page = (url: string) =>
        store.addPage(scope, {
          url,
          finalUrl: A.url,
          title: "10월 반도체 수출",
          site: "가나다 신문",
          contentType: "text/html",
          body: (FIXTURE_PAGES[0] as { text: string }).text,
          truncated: false,
        })!.id;
      const a = page(A.url);
      const b = page("https://fixture.agentlee.test/r/chips-a");
      expect(a).not.toBe(b);
      Object.assign(state.questions[0]!, { status: "done", retried: true });
      Object.assign(state.questions[1]!, {
        status: "done",
        sources: 2,
        found: [
          { id: "n1", claim: "메모리", quote: RESEARCH_FIXTURE.memory, sourceId: a, title: "t" },
          { id: "n2", claim: "32%", quote: RESEARCH_FIXTURE.growth, sourceId: b, title: "t" },
        ],
      });
    });
    await statusIs(t2.app, job.id, "done");
    const retries = t2.counting.turns.filter((x) => x.includes(RETRY_MARK));
    expect(retries).toHaveLength(1);
    expect(retries[0]).toContain("수출 증가의 배경");
    const after = JSON.parse(t2.app.research!.get(job.id)!.state) as { questions: { sources: number }[] };
    expect(after.questions[1]!.sources).toBe(1);
  });

  it("restored notes of one passage of one page reached by two URLs become one note (no retry needed)", async () => {
    const [, B] = FIXTURE_PAGES as [unknown, { url: string; text: string }];
    const { t2, job } = await resumedWith((state, { db, conversationId, ownerId }) => {
      const store = new SourceStore(db);
      const scope = { userId: ownerId, conversationId, runId: "research:old" };
      const page = (url: string, finalUrl: string, body: string) =>
        store.addPage(scope, {
          url,
          finalUrl,
          title: "t",
          site: "s",
          contentType: "text/html",
          body,
          truncated: false,
        })!.id;
      const a = page(A.url, A.url, (FIXTURE_PAGES[0] as { text: string }).text);
      const a2 = page(
        "https://fixture.agentlee.test/r/chips-a",
        A.url,
        (FIXTURE_PAGES[0] as { text: string }).text,
      );
      const b = page(B.url, B.url, B.text);
      Object.assign(state.questions[0]!, { status: "done", retried: true });
      Object.assign(state.questions[1]!, {
        status: "done",
        sources: 3,
        found: [
          { id: "n1", claim: "메모리", quote: RESEARCH_FIXTURE.memory, sourceId: a, title: "t" },
          { id: "n2", claim: "메모리", quote: RESEARCH_FIXTURE.memory, sourceId: a2, title: "t" },
          { id: "n3", claim: "통계", quote: RESEARCH_FIXTURE.stats, sourceId: b, title: "t" },
        ],
      });
    });
    await statusIs(t2.app, job.id, "done");
    expect(t2.counting.turns.filter((x) => x.includes(RETRY_MARK))).toHaveLength(0);
    const after = JSON.parse(t2.app.research!.get(job.id)!.state) as {
      questions: { sources: number; found: { id: string }[] }[];
    };
    expect(after.questions[1]!.found.map((n) => n.id)).toEqual(["n1", "n3"]);
    expect(after.questions[1]!.sources).toBe(2);
  });

  it("every restored checkpoint is normalised — notes that already carry their page key, in research or writing", async () => {
    for (const stage of ["research", "write"] as const) {
      const { t2, job } = await resumedWith((state, { db, conversationId, ownerId }) => {
        const store = new SourceStore(db);
        const scope = { userId: ownerId, conversationId, runId: "research:old" };
        const add = (url: string) =>
          store.addPage(scope, {
            url,
            finalUrl: A.url,
            title: "t",
            site: "s",
            contentType: "text/html",
            body: (FIXTURE_PAGES[0] as { text: string }).text,
            truncated: false,
          })!.id;
        const a = add(A.url);
        const a2 = add(`https://fixture.agentlee.test/r/${stage}`);
        const key = `u:${A.url}`;
        for (const q of state.questions) Object.assign(q, { status: "done", retried: true });
        Object.assign(state.questions[1]!, {
          sources: 2,
          found: [
            {
              id: "n1",
              claim: "메모리",
              quote: RESEARCH_FIXTURE.memory,
              sourceId: a,
              sourceKey: key,
              title: "t",
            },
            {
              id: "n2",
              claim: "메모리",
              quote: `${RESEARCH_FIXTURE.memory} `,
              sourceId: a2,
              sourceKey: key,
              title: "t",
            },
          ],
        });
        if (stage === "write") {
          state.stage = "write";
          db.$client
            .prepare("update research_jobs set status = 'writing' where conversation_id = ?")
            .run(conversationId);
        }
      });
      await statusIs(t2.app, job.id, "done");
      const writer = t2.counting.turns.find((x) => x.startsWith(TURN_MARK.writer))!;
      // The writer got the passage once.
      expect(writer.split(RESEARCH_FIXTURE.memory).length - 1, stage).toBe(1);
      const after = JSON.parse(t2.app.research!.get(job.id)!.state) as {
        questions: { sources: number; found: { id: string }[] }[];
      };
      expect(
        after.questions[1]!.found.map((n) => n.id),
        stage,
      ).toEqual(["n1"]);
      expect(after.questions[1]!.sources, stage).toBe(1);
    }
  }, 30_000);

  it("resumed where only the reflection then runs (nothing found): no_findings, not server_restart", async () => {
    const { t2, job } = await resumedWith((state) => {
      for (const q of state.questions)
        Object.assign(q, { status: "done", retried: true, found: [], sources: 0 });
    });
    const failed = await statusIs(t2.app, job.id, "failed");
    expect(t2.counting.turns.filter((x) => x.startsWith(TURN_MARK.subagent))).toHaveLength(0);
    expect(t2.counting.turns.filter((x) => x.startsWith(TURN_MARK.reflect))).toHaveLength(1);
    expect(failed.errorCode).toBe("no_findings");
  });

  it("failing with a question skipped for time keeps its state (skipped, the time limit) with the error", async () => {
    const { t2, job, db } = await resumedWith((state) => {
      Object.assign(state.questions[0]!, { status: "done", retried: true, found: [], sources: 0 });
      Object.assign(state.questions[1]!, {
        status: "waiting",
        retried: true,
        failure: "runtime_error",
        found: [],
        sources: 0,
      });
    }, 21 * MIN);
    const failed = await statusIs(t2.app, job.id, "failed");
    expect(failed.errorCode).toBe("runtime_error");
    const row = db.$client.prepare("select state from research_jobs where id = ?").get(job.id) as {
      state: string;
    };
    const saved = JSON.parse(row.state) as {
      timedOut: boolean;
      questions: { status: string; skipped?: string }[];
    };
    expect(saved.timedOut).toBe(true);
    expect(saved.questions[1]).toMatchObject({ status: "capped", skipped: "time" });
  });

  it('resumed with no research time left: what was waiting is under the time limit, not "no evidence"', async () => {
    const db = createTestDb();
    const hold = scripted((x) =>
      x.startsWith(TURN_MARK.subagent) && x.includes("배경") ? [{ gate: "late-budget-hold" }] : undefined,
    );
    const t1 = await start({ db, script: hold });
    const { job } = await begin(t1);
    await statusIs(t1.app, job.id, "awaiting_approval");
    await t1.api(t1.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    await until(
      () => t1.counting.active === 1 && t1.app.research!.get(job.id)!.state.includes('"status":"done"'),
      "q1 done",
    );
    await t1.app.close();
    // The research budget (20 minutes) already spent; the deadline still ahead for the writer.
    db.$client
      .prepare("update research_jobs set approved_at = ? where id = ?")
      .run(Date.now() - 21 * MIN, job.id);
    const t2 = await start({ db, family: false });
    const end = await statusIs(t2.app, job.id, "done");
    expect(t2.counting.turns.filter((x) => x.startsWith(TURN_MARK.subagent))).toHaveLength(0);
    const after = JSON.parse(end.state) as { timedOut: boolean; questions: { skipped?: string }[] };
    expect(after.timedOut).toBe(true);
    expect(after.questions[1]!.skipped).toBe("time");
    const report = t2.app.artifacts!.version(JSON.parse(end.result!).artifactId, 1)!.content;
    expect(report).not.toContain("수출 증가의 배경은 무엇인가");
  });

  it("time is checked again after the reflection: no new round, or no extra round, that no longer fits", async () => {
    // The clock is put just above a threshold before the reflection (in the background question's retry, the last
    // step before it); the reflection then takes one minute (inside its 90 s) and names a gap.
    for (const [limits, before, rounds] of [
      // 3.5 minutes left before (a round fits), 2.5 after: no new round — the gap is not even added.
      [{}, 3.5 * MIN, 0],
      [{}, 4.5 * MIN, 1],
      // No regular gap round (maxDepth 0): the extra one needs 8 minutes — 8.5 before, 7.5 after.
      [{ maxDepth: 0 }, 8.5 * MIN, 0],
      [{ maxDepth: 0 }, 9.5 * MIN, 1],
    ] as const) {
      const clock = new ManualClock();
      const t0 = clock.now();
      let approvedAt = 0;
      const script = scripted((x) => {
        if (x.startsWith(TURN_MARK.subagent) && x.includes(RETRY_MARK) && /배경/.test(x)) {
          clock.advance(approvedAt + 20 * MIN - before - clock.now());
          return [{ text: "DONE" }];
        }
        if (!x.startsWith(TURN_MARK.reflect)) return undefined;
        clock.advance(MIN);
        return [{ text: JSON.stringify({ gaps: [{ question: "새 각도의 보강 질문", scope: "web" }] }) }];
      });
      const t = await start({ script, clock, limits });
      const { job } = await begin(t);
      await statusIs(t.app, job.id, "awaiting_approval");
      await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
      approvedAt = t.app.research!.get(job.id)!.approvedAt ?? t0;
      await until(() => {
        const s = t.app.research!.get(job.id)!.status;
        if (s === "writing") clock.advance(MIN);
        return s === "done" || s === "failed";
      }, "the end");
      const label = `${JSON.stringify(limits)} ${before / MIN}`;
      const gap = t.counting.turns.filter(
        (x) => x.startsWith(TURN_MARK.subagent) && x.includes("새 각도") && !x.includes(RETRY_MARK),
      );
      expect(gap, label).toHaveLength(rounds);
      // Not merely left unasked: when it does not fit, the gap question is never added.
      expect(
        stateOf(t, job.id).questions.some((q) => q.question.includes("새 각도")),
        label,
      ).toBe(rounds > 0);
    }
    // Several whole jobs in a row: more time than the default under a full-suite load.
  }, 30_000);

  it("each queued retry checks the time when it gets its slot: a fourth one behind three does not start late", async () => {
    let moved = false;
    let started = 0;
    const clock = new ManualClock();
    let approvedAt = 0;
    const script = scripted((x) => {
      if (!(x.startsWith(TURN_MARK.subagent) && x.includes(RETRY_MARK))) return undefined;
      // The third retry to start (the pool is full) moves the clock to 2.5 minutes before the end of research.
      if (++started === 3 && !moved) {
        moved = true;
        clock.advance(approvedAt + 20 * MIN - 2.5 * MIN - clock.now());
      }
      return [{ text: "DONE" }];
    });
    const t = await start({ script, clock });
    const { job } = await begin(t);
    await statusIs(t.app, job.id, "awaiting_approval");
    const subQuestions = Array.from({ length: 4 }, (_, i) => ({ question: `측면 ${i + 1}`, scope: "web" }));
    await t.api(t.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, { subQuestions });
    approvedAt = t.app.research!.get(job.id)!.approvedAt!;
    await until(() => {
      const s = t.app.research!.get(job.id)!.status;
      if (s === "writing") clock.advance(MIN);
      return s === "done" || s === "failed";
    }, "the end");
    const retries = t.counting.turns.filter(
      (x) => x.startsWith(TURN_MARK.subagent) && x.includes(RETRY_MARK),
    );
    expect(retries).toHaveLength(3);
  });

  it("a retry still waiting after a restart starts only with a round's time left", async () => {
    const db = createTestDb();
    const hold = scripted((x) =>
      x.startsWith(TURN_MARK.subagent) && x.includes("배경") ? [{ gate: "retry-restart-hold" }] : undefined,
    );
    const t1 = await start({ db, script: hold });
    const { job } = await begin(t1);
    await statusIs(t1.app, job.id, "awaiting_approval");
    await t1.api(t1.f.cookies.owner, "POST", `/api/research/${job.id}/approve`, {});
    await until(
      () => t1.counting.active === 1 && t1.app.research!.get(job.id)!.state.includes('"status":"done"'),
      "q1 done",
    );
    await t1.app.close();
    const row = db.$client.prepare("select state from research_jobs where id = ?").get(job.id) as {
      state: string;
    };
    const state = JSON.parse(row.state) as { questions: Record<string, unknown>[] };
    // As if the server stopped right after it queued the background question's retry.
    Object.assign(state.questions[1]!, { status: "waiting", retried: true, found: [], sources: 0 });
    // …and a third-round gap question queued (review #237 2차).
    state.questions.push({
      id: "r3q1",
      question: "늦은 보강 질문",
      scope: "web",
      round: 3,
      status: "waiting",
      sources: 0,
      found: [],
      dropped: 0,
    });
    // 45 seconds of research left.
    const approvedAt = Date.now() - (20 * MIN - 45_000);
    db.$client
      .prepare("update research_jobs set state = ?, approved_at = ? where id = ?")
      .run(JSON.stringify(state), approvedAt, job.id);
    const t2 = await start({ db, family: false });
    const end = await statusIs(t2.app, job.id, "done", "failed");
    expect(t2.counting.turns.filter((x) => x.startsWith(TURN_MARK.subagent))).toHaveLength(0);
    // Skipped for lack of time (review #237 3차): under the time limit, not "근거를 찾지 못한 하위 질문".
    const after = JSON.parse(end.state) as {
      timedOut: boolean;
      questions: { id: string; skipped?: string }[];
    };
    expect(after.timedOut).toBe(true);
    expect(after.questions.find((q) => q.id === "r3q1")!.skipped).toBe("time");
    expect(end.status).toBe("done");
    const report = t2.app.artifacts!.version(JSON.parse(end.result!).artifactId, 1)!.content;
    expect(report).not.toContain("늦은 보강 질문");
    expect(JSON.parse(end.result!)).toMatchObject({ timedOut: true });
  });
});
