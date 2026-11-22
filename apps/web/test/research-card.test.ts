import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { ResearchJob } from "@agentlee/shared";
import { ResearchCard } from "../src/chat/ResearchCard.js";

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
