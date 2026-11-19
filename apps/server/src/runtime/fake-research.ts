import { TURN_MARK } from "../research/prompts.js";
import { FIXTURE_PAGES, type FixturePage } from "./fake-citations.js";
import type { FakeStep } from "./fake.js";

/**
 * 깊이 조사 (#211) as the FakeRuntime answers it — the e2e run (FAKE_RUNTIME=1) and the server tests. Each step is
 * recognised by its turn's first line (`TURN_MARK`); the tools are the real ones on the citation fixture pages (no
 * network), so the server's checks are the real ones:
 * - plan: two sub-questions on the October chip exports (a question with "모호" first asks one clarifying question);
 * - sub-researchers: real `web_fetch` calls, `NOTE` lines with the fetched `sourceId`s — one note quotes words the page
 *   does not have (the server drops it); "느린 조사" in the question makes each take 2.5 s (the progress e2e);
 * - reflection: no gaps;
 * - writer: real `cite` calls for the notes it was given and one with a passage no page has, then a report in which
 *   one sentence leans on that failed citation and one has none — both are removed by the server.
 */

const [A, B] = FIXTURE_PAGES as [FixturePage, FixturePage];
export const RESEARCH_FIXTURE = {
  growth:
    "산업통상자원부는 10일 10월 반도체 수출이 전년 같은 달보다 32% 늘어난 142억 달러로 집계됐다고 밝혔다.",
  memory: "메모리 가격 회복이 증가를 이끌었다.",
  stats: "10월 반도체 수출 증가율은 28%로, 일부 언론 보도와 차이가 있다.",
  wrong: "10월 반도체 수출이 50% 늘었다.",
} as const;

const note = (claim: string, ref: string, quote: string) =>
  `NOTE ${JSON.stringify({ claim, sourceId: ref, quote })}\n`;

export function researchSteps(t: string): FakeStep[] | undefined {
  if (t.startsWith(TURN_MARK.plan)) {
    if (/모호/.test(t) && !/사용자의 답:/.test(t))
      return [{ text: JSON.stringify({ clarify: "어느 기간의 수출을 알고 싶은지 알려 주세요." }) }];
    return [
      { delayMs: 300 },
      {
        text: JSON.stringify({
          title: "10월 반도체 수출 조사",
          estimateMinutes: 8,
          subQuestions: [
            { question: "10월 반도체 수출 증가율은 얼마인가", scope: "web" },
            { question: "수출 증가의 배경은 무엇인가", scope: "web" },
          ],
        }),
      },
      { usage: { inputTokens: 120, outputTokens: 40, costUsd: 0.0003 } },
    ];
  }
  if (t.startsWith(TURN_MARK.subagent)) {
    const slow = /느린 조사/.test(t) ? [{ delayMs: 2500 }] : [];
    if (/증가율/.test(t))
      return [
        ...slow,
        { call: "web_fetch", input: { url: A.url } },
        { call: "web_fetch", input: { url: B.url } },
        {
          textRefs:
            note("가나다 신문은 32% 증가로 보도했다", "{{$0.sourceId}}", RESEARCH_FIXTURE.growth) +
            note("라마바 통계는 28%로 집계했다", "{{$1.sourceId}}", RESEARCH_FIXTURE.stats) +
            note("수출이 50% 늘었다", "{{$0.sourceId}}", RESEARCH_FIXTURE.wrong) +
            "DONE",
        },
      ];
    return [
      ...slow,
      { call: "web_fetch", input: { url: A.url } },
      {
        textRefs:
          note("메모리 가격 회복이 증가를 이끌었다", "{{$0.sourceId}}", RESEARCH_FIXTURE.memory) + "DONE",
      },
    ];
  }
  if (t.startsWith(TURN_MARK.reflect)) return [{ text: '{"gaps": []}' }];
  if (t.startsWith(TURN_MARK.writer)) {
    // The notes as the writer got them: one JSON object per line inside the notes block.
    const notes = [...t.matchAll(/^\{"note".*\}$/gm)].flatMap((m) => {
      try {
        return [JSON.parse(m[0]) as { sourceId?: string; fileId?: string; quote: string }];
      } catch {
        return [];
      }
    });
    const steps: FakeStep[] = [];
    for (const n of notes)
      if (n.sourceId) steps.push({ call: "cite", input: { sourceId: n.sourceId, snippet: n.quote } });
      else if (n.fileId) steps.push({ call: "file_cite", input: { fileId: n.fileId, snippet: n.quote } });
    const first = notes.find((n) => n.sourceId)?.sourceId ?? "none";
    steps.push({ call: "cite", input: { sourceId: first, snippet: RESEARCH_FIXTURE.wrong } });
    const k = notes.length;
    // The marker of the note quoting `words` (its cite was the i-th call: number i + 1).
    const cited = (words: string) => {
      const i = notes.findIndex((n) => n.quote.includes(words));
      return i === -1 ? "" : `[${i + 1}]`;
    };
    steps.push({
      text: [
        "## 요약",
        "",
        `10월 반도체 수출은 크게 늘었어요${cited("142억")}. 증가율은 자료마다 달라요${cited("28%")}.`,
        "",
        "## 증가율",
        "",
        `가나다 신문은 32% 증가로 보도했어요${cited("32%")}. 라마바 통계는 28%로 집계했어요${cited("28%")}.`,
        `한 보도는 50% 늘었다고 했어요[${k + 1}].`,
        "",
        "## 배경",
        "",
        `- 메모리 가격 회복이 증가를 이끌었어요${cited("메모리")}.`,
        "- 미국 수출 비중이 가장 컸어요.",
      ].join("\n"),
    });
    return steps;
  }
  return undefined;
}
