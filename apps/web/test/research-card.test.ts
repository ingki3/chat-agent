import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { safeParseResearchJob, type ResearchJob } from "@agentlee/shared";
import { newest, Progress, ResearchCard, sinceText, stageText } from "../src/chat/ResearchCard.js";

/** The 깊이 조사 card's failure line (#234): every server failure code has its own text. */

const job = (errorCode: ResearchJob["errorCode"]): ResearchJob => ({
  id: "j1",
  conversationId: "c1",
  messageId: "m1",
  status: "failed",
  question: "질문",
  clarify: null,
  plan: null,
  stage: "end",
  round: 0,
  questions: [],
  sources: 0,
  elapsedMs: 0,
  deadlineAt: null,
  files: 0,
  result: null,
  errorCode,
  createdAt: 0,
  approvedAt: null,
  endedAt: 1,
  owned: true,
  version: 1,
});

const render = (j: ResearchJob) => {
  const client = new QueryClient();
  client.setQueryData(["research", j.id], j);
  return renderToStaticMarkup(
    createElement(QueryClientProvider, { client }, createElement(ResearchCard, { jobId: j.id })),
  );
};

describe("ResearchCard: failure text", () => {
  it("runtime_policy has its own line (the runtime tried a tool it was not offered)", () => {
    expect(render(job("runtime_policy"))).toContain("허용되지 않은 도구를 쓰려고 해서 멈췄어요");
  });
  it("other codes keep theirs; an unknown one falls back to the generic text", () => {
    expect(render(job("no_findings"))).toContain("확인된 근거를 하나도 찾지 못했어요");
    expect(render(job(null))).toContain("깊이 조사를 마치지 못했어요");
  });
});

/** The two counts the card shows (#233): what was verified, and what the report cites — different keys, different words. */
describe("research card counts", () => {
  it("labels verified material and the report's cited sources apart", () => {
    const done: ResearchJob = {
      ...job(null),
      status: "done",
      sources: 3,
      questions: [
        {
          id: "q1",
          question: "하위 질문",
          scope: "web",
          round: 0,
          status: "done",
          notes: 2,
          dropped: 0,
          sources: 3,
        },
      ],
      result: { artifactId: "a1", version: 1, removed: 2, citations: 2, timedOut: false, fallback: false },
    };
    const html = render(done);
    expect(html).toContain("검증한 자료 3개");
    expect(html).toContain("보고서에 인용한 출처 2개 · 확인하지 못해 뺀 문장 2개");
    expect(html).not.toMatch(/· 출처 \d/);
  });
});

const NOW = Date.now();

const pjob = (over: Partial<ResearchJob> = {}): ResearchJob => ({
  id: "j1",
  conversationId: "c1",
  messageId: "m1",
  status: "researching",
  question: "10월 반도체 수출",
  clarify: null,
  plan: null,
  stage: "research",
  phase: "researching",
  phaseProgress: null,
  lastActivityAt: NOW - 5000,
  round: 0,
  questions: [
    {
      id: "q1",
      question: "증가율은 얼마인가",
      scope: "web",
      round: 0,
      status: "running",
      sources: 1,
      notes: 2,
      dropped: 1,
      activity: { kind: "fetch", label: "페이지 읽는 중 · 1번째 페이지", at: NOW - 5000 },
    },
    {
      id: "q2",
      question: "배경은 무엇인가",
      scope: "web",
      round: 0,
      status: "waiting",
      sources: 0,
      notes: 0,
      dropped: 0,
      activity: null,
    },
  ],
  sources: 1,
  elapsedMs: 60_000,
  deadlineAt: NOW + 29 * 60_000,
  files: 0,
  result: null,
  errorCode: null,
  createdAt: NOW - 120_000,
  approvedAt: NOW - 60_000,
  endedAt: null,
  owned: true,
  version: 4,
  ...over,
});

const renderProgress = (j: ResearchJob) =>
  renderToStaticMarkup(
    createElement(QueryClientProvider, { client: new QueryClient() }, createElement(Progress, { job: j })),
  );

/** The 깊이 조사 card's live progress (#232): phase, each sub-question's latest call and counts, last activity. */
describe("research card progress (#232)", () => {
  it("shows the running sub-question's latest call, notes and unverified counts, and the last activity", () => {
    const html = renderProgress(pjob());
    expect(html).toContain('data-testid="research-activity"');
    expect(html).toContain("페이지 읽는 중 · 1번째 페이지");
    // `dropped` counts every note left out (unverified, a duplicate, over the cap): 제외, never 확인 못 함.
    expect(html).toContain("노트 2개 · 제외 1개");
    expect(html).not.toContain("확인 못 함");
    // A sub-question still waiting has no counts of notes yet, and no activity line.
    expect(html.match(/data-testid="research-activity"/g)).toHaveLength(1);
    expect(html).toContain("배경은 무엇인가 <span");
    expect(html).toContain('data-testid="research-last-activity"');
    expect(html).toMatch(/마지막 활동 \d+초 전/);
    expect(html).toContain('class="research-pulse"');
    expect(html).toContain('data-phase="researching"');
  });

  it("names the phase: reflection, a gap round, the writer's section k/n, the check", () => {
    expect(stageText(pjob({ phase: "reflecting" }))).toBe("보강할 곳 찾는 중");
    expect(stageText(pjob({ round: 1 }))).toBe("보강 조사 1단계");
    expect(stageText(pjob({ status: "writing", phase: "writing" }))).toBe("보고서 쓰는 중");
    expect(
      stageText(pjob({ status: "writing", phase: "writing", phaseProgress: { done: 1, total: 4 } })),
    ).toBe("보고서 쓰는 중 — 섹션 2/4");
    expect(stageText(pjob({ status: "writing", phase: "outlining" }))).toBe("보고서 개요 잡는 중");
    expect(stageText(pjob({ status: "writing", phase: "verifying" }))).toBe("출처 확인하는 중");
    // An older server without a phase: from the status.
    expect(stageText(pjob({ status: "writing", phase: undefined }))).toBe("보고서 쓰는 중");
    expect(renderProgress(pjob({ phase: "reflecting" }))).toContain("보강할 곳 찾는 중");
  });

  it("counts the time since the last activity, never below zero", () => {
    expect(sinceText(NOW - 4_200, NOW)).toBe("4초 전");
    expect(sinceText(NOW + 2_000, NOW)).toBe("방금");
    expect(sinceText(NOW + 3_600_000, NOW)).toBe("방금");
    expect(sinceText(NOW - 300, NOW)).toBe("방금");
    expect(sinceText(NOW - 125_000, NOW)).toBe("2분 전");
  });

  it("of two states of the same version keeps the later live one, whatever order they arrive in", () => {
    // Same version, same millisecond: only the server's order (seq) tells them apart.
    const older = pjob({ seq: 10 });
    const later = pjob({ seq: 11 });
    expect(newest(later, older)).toBe(later); // a stale read after the stream
    expect(newest(older, later)).toBe(later);
    expect(newest(later, pjob({ version: 5, seq: 1 })).version).toBe(5);
    expect(newest(pjob({ version: 5, seq: 1 }), later).version).toBe(5);
  });

  it("from a server without seq, keeps the later live activity of two of the same version", () => {
    const older = pjob({ lastActivityAt: NOW - 9000 });
    const later = pjob({ lastActivityAt: NOW - 1000 });
    delete older.seq;
    delete later.seq;
    expect(newest(later, older)).toBe(later);
    expect(newest(older, later)).toBe(later);
  });

  it("of two of the same version where only one has seq, keeps the one with seq, whichever arrives last", () => {
    const live = pjob({ seq: 7, lastActivityAt: NOW - 9000 });
    const read = pjob({ lastActivityAt: NOW - 1000 });
    delete read.seq;
    expect(newest(live, read)).toBe(live);
    expect(newest(read, live)).toBe(live);
  });

  it("treats seq 0 (no live progress on the server) like none: the later activity wins", () => {
    const zero = pjob({ seq: 0, lastActivityAt: NOW - 9000 });
    const later = pjob({ lastActivityAt: NOW - 1000 });
    delete later.seq;
    expect(newest(zero, later)).toBe(later);
    expect(newest(later, zero)).toBe(later);
    expect(newest(pjob({ seq: 0, lastActivityAt: NOW - 1000 }), zero).lastActivityAt).toBe(NOW - 1000);
  });

  it("a bad activity line is dropped on reading, never the whole job update", () => {
    const j = pjob();
    const bad = {
      ...j,
      questions: [
        { ...j.questions[0]!, activity: { kind: "fetch", label: "x".repeat(300), at: 1 } },
        j.questions[1],
      ],
    };
    const r = safeParseResearchJob(JSON.parse(JSON.stringify(bad)));
    expect(r.success).toBe(true);
    expect(r.data!.questions[0]!.activity).toBeNull();
    expect(r.data!.questions[0]!.notes).toBe(2);
    // A good one is kept; a bad job is still refused.
    expect(safeParseResearchJob(JSON.parse(JSON.stringify(j))).data!.questions[0]!.activity!.label).toBe(
      "페이지 읽는 중 · 1번째 페이지",
    );
    expect(safeParseResearchJob({ ...j, version: "x" }).success).toBe(false);
    // A short label that is not one of the fixed ones (an old server's "읽는 중: <host>"): the line only is dropped.
    const old = {
      ...j,
      questions: [
        { ...j.questions[0]!, activity: { kind: "fetch", label: "읽는 중: example.test", at: 1 } },
        j.questions[1],
      ],
    };
    const o = safeParseResearchJob(JSON.parse(JSON.stringify(old)));
    expect(o.success).toBe(true);
    expect(o.data!.questions[0]!.activity).toBeNull();
    expect(o.data!.questions[0]!.question).toBe("증가율은 얼마인가");
  });

  it("across a restart (another boot) the arriving state wins — a clock gone back or a lower seq does not matter", () => {
    const before = pjob({ boot: "aaaa1111", seq: 50, lastActivityAt: NOW });
    const after = pjob({ boot: "bbbb2222", seq: 1, lastActivityAt: NOW - 60_000 });
    expect(newest(before, after)).toBe(after);
    // Within one process: the higher seq, whichever arrives last.
    const same1 = pjob({ boot: "bbbb2222", seq: 2 });
    const same2 = pjob({ boot: "bbbb2222", seq: 3 });
    expect(newest(same2, same1)).toBe(same2);
    expect(newest(same1, same2)).toBe(same2);
    // A newer version wins over any boot.
    expect(newest(pjob({ boot: "x", seq: 9, version: 6 }), after).version).toBe(6);
    // An older server (no boot): seq, then the later activity.
    const plainA = pjob({ lastActivityAt: NOW - 1000 });
    const plainB = pjob({ lastActivityAt: NOW - 9000 });
    delete plainA.seq;
    delete plainB.seq;
    expect(newest(plainA, plainB)).toBe(plainA);
    expect(newest(plainB, plainA)).toBe(plainA);
  });

  it("when only one of the two says its process (boot), the later activity wins (a tie: the arriving one)", () => {
    const cached = pjob({ seq: 50, lastActivityAt: NOW - 5000 });
    const fresh = pjob({ boot: "cccc3333", seq: 1, lastActivityAt: NOW - 1000 });
    expect(newest(cached, fresh)).toBe(fresh);
    expect(newest(fresh, cached)).toBe(fresh);
    const tieA = pjob({ seq: 50, lastActivityAt: NOW });
    const tieB = pjob({ boot: "cccc3333", seq: 1, lastActivityAt: NOW });
    expect(newest(tieA, tieB)).toBe(tieB);
    expect(newest(tieB, tieA)).toBe(tieA);
  });

  it("says each sub-question's state in words for a screen reader (the icon is hidden from it)", () => {
    const states = ["waiting", "running", "done", "capped", "failed"] as const;
    const html = renderProgress(
      pjob({
        questions: states.map((status, i) => ({
          id: `q${i}`,
          question: `질문 ${i}`,
          scope: "web" as const,
          round: 0,
          status,
          sources: 0,
          notes: 0,
          dropped: 0,
          activity: null,
        })),
      }),
    );
    for (const text of ["대기", "진행 중", "완료", "한도 도달", "실패"])
      expect(html).toContain(`<span class="sr-only">${text}: </span>`);
    expect(html).toMatch(/<span aria-hidden="true" class="research-icon">/);
  });

  it("a sub-question waiting again (its retry queued) still shows what its first run kept and left out", () => {
    const base = pjob().questions[1]!;
    const queued = renderProgress(
      pjob({ questions: [{ ...base, status: "waiting", notes: 1, dropped: 2, sources: 1 }] }),
    );
    expect(queued).toContain("검증한 자료 1개 · 노트 1개 · 제외 2개");
    // A question not yet run has no note counts at all.
    const fresh = renderProgress(pjob({ questions: [{ ...base, status: "waiting" }] }));
    expect(fresh).toContain("검증한 자료 0개");
    expect(fresh).not.toContain("노트");
    // Nothing left out: no 제외.
    const clean = renderProgress(pjob({ questions: [{ ...base, status: "done", notes: 2, dropped: 0 }] }));
    expect(clean).toContain("노트 2개");
    expect(clean).not.toContain("제외");
  });
});
