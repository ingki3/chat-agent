import type { WebWorker } from "../web/service.js";

/**
 * Citation fixtures (#25): pretend pages and search results, and the scenarios that cite them. Used by the
 * FakeRuntime (`/cite <scenario>`, FAKE_RUNTIME=1 — the e2e run) and by the Claude and Codex replay tests, so the
 * same scenario goes through every runtime. No network: the pages are served by `fixtureWebWorker` instead of
 * the sandboxed web worker, for these URLs only. The citation check itself (the `cite` tool, the stored text,
 * the note at the end of the run) is the real one.
 *
 * Scenario inputs may refer to an earlier call's result: `"$<i>.<path>"` is that value of the i-th call's output
 * (`"$0.sourceId"`, `"$0.items.1.sourceId"`). A reference that does not resolve stays as written.
 */

export const FIXTURE_HOST = "fixture.agentlee.test";
const u = (p: string) => `https://${FIXTURE_HOST}${p}`;

export type FixturePage = { url: string; title: string; site: string; publishedAt?: string; text: string };

export const FIXTURE_PAGES: readonly FixturePage[] = [
  {
    url: u("/news/chips-a.html"),
    title: "10월 반도체 수출 32% 증가",
    site: "가나다 신문",
    publishedAt: "2026-11-10T09:00:00+09:00",
    text: "산업통상자원부는 10일 낸 자료에서 10월 반도체 수출이 전년 같은 달보다 32% 늘어난 142억 달러로 집계됐다고 밝혔다.\n메모리 가격 회복이 증가를 이끌었다. 업계는 연말까지 증가세가 이어질 것으로 본다.",
  },
  {
    url: u("/stats/chips-b.html"),
    title: "10월 수출입 동향",
    site: "라마바 통계",
    publishedAt: "2026-11-11T08:00:00+09:00",
    text: "10월 반도체 수출 증가율은 28%로, 일부 언론 보도와 차이가 있다.\n이는 선적 기준과 통관 기준의 차이 때문이다.",
  },
  {
    url: u("/blog/battery.html"),
    title: "전고체 배터리 양산 전망",
    site: "개인 블로그",
    text: "전고체 배터리는 2027년 양산이 목표라고 한다. 다만 공식 발표는 아직 없다.",
  },
];

/** Search results by query: links only (no page text), as a search provider returns them. */
export const FIXTURE_SEARCH: Readonly<
  Record<string, { url: string; title: string; site: string; snippet: string }[]>
> = {
  "전고체 배터리 양산": [
    {
      url: u("/news/battery-plan.html"),
      title: "전고체 배터리 양산 계획 발표",
      site: "사아자 일보",
      snippet: "전고체 배터리 양산 계획이 발표됐다",
    },
  ],
};

export type CitationCall = {
  tool: "web_search" | "web_fetch" | "sources_list" | "cite";
  input: Record<string, unknown>;
};
export type CitationScenario = { calls: CitationCall[]; answer: string };

const [A, B, C] = FIXTURE_PAGES as [FixturePage, FixturePage, FixturePage];

export const CITATION_SCENARIOS = {
  /** Two sources that disagree: both cited, the answer says so (FR-5.4). Every citation verified. */
  conflict: {
    calls: [
      { tool: "web_fetch", input: { url: A.url } },
      { tool: "web_fetch", input: { url: B.url } },
      // Whitespace (a line break in the page) and quote styles differ from the stored text: still verified.
      {
        tool: "cite",
        input: {
          sourceId: "$0.sourceId",
          snippet: "10월 반도체 수출이 전년 같은 달보다 32% 늘어난 142억 달러로 집계됐다",
        },
      },
      { tool: "cite", input: { sourceId: "$1.sourceId", snippet: "“10월 반도체 수출 증가율은  28%로”" } },
      {
        tool: "cite",
        input: { sourceId: "$1.sourceId", snippet: "이는 선적 기준과 통관 기준의 차이 때문이다." },
      },
    ],
    answer:
      "## 10월 반도체 수출\n\n두 출처의 수치가 서로 달라요. 가나다 신문은 32% 늘었다고 보도했어요[1]. 라마바 통계는 증가율을 28%로 집계했어요[2].\n\n차이는 선적 기준과 통관 기준이 달라서 생겼다고 해요[3].",
  },
  /**
   * Too little to go on: one blog, a claim the page does not make (snippet_not_found), a search result without
   * page text (fetch_failed), and the research-mode statement that the sources are not enough.
   */
  insufficient: {
    calls: [
      { tool: "web_search", input: { query: "전고체 배터리 양산" } },
      { tool: "web_fetch", input: { url: C.url } },
      {
        tool: "cite",
        input: { sourceId: "$1.sourceId", snippet: "전고체 배터리는 2027년 양산이 목표라고 한다" },
      },
      { tool: "cite", input: { sourceId: "$1.sourceId", snippet: "전고체 배터리는 2026년 양산이 확정됐다" } },
      {
        tool: "cite",
        input: { sourceId: "$0.results.0.sourceId", snippet: "전고체 배터리 양산 계획이 발표됐다" },
      },
    ],
    answer:
      "확인한 출처는 개인 블로그 하나뿐이에요[1].\n\n일부에서는 양산 일정이 확정됐다고 해요[2]. 검색 결과에도 양산 계획 기사가 있어요[3].\n\n출처가 충분하지 않아요. 공식 발표를 확인해 보세요.",
  },
  /** Some paragraphs and a list item without a citation; heading, lead-in and the ※ note are not checked. */
  partial: {
    calls: [
      { tool: "web_fetch", input: { url: A.url } },
      { tool: "cite", input: { sourceId: "$0.sourceId", snippet: "메모리 가격 회복이 증가를 이끌었다" } },
    ],
    answer:
      "### 요약\n\n10월 반도체 수출은 메모리 가격 회복 덕에 늘었어요[1].\n\n업계는 내년에도 두 자릿수 증가를 예상해요.\n\n주요 내용:\n- 증가의 배경은 메모리 가격이에요[1]\n- 미국 수출 비중이 가장 컸어요\n\n※ 이 답변은 공개 보도를 바탕으로 했어요.",
  },
  /**
   * A follow-up that cites pages fetched in an earlier answer of the same conversation (after `conflict`): found
   * with sources_list, checked again against the stored text. `[3]` was never cited in this answer.
   */
  reuse: {
    calls: [
      { tool: "sources_list", input: {} },
      {
        tool: "cite",
        input: { sourceId: "$0.items.0.sourceId", snippet: "메모리 가격 회복이 증가를 이끌었다" },
      },
      {
        tool: "cite",
        input: { sourceId: "$0.items.1.sourceId", snippet: "선적 기준과 통관 기준의 차이 때문이다" },
      },
    ],
    answer:
      "앞에서 본 기사에 따르면 메모리 가격 회복이 증가를 이끌었어요[1]. 통계가 다른 것은 집계 기준 때문이에요[2]. 지난 답변의 수치도 같아요[3].",
  },
} satisfies Record<string, CitationScenario>;
export type CitationScenarioName = keyof typeof CITATION_SCENARIOS;

/** Resolves `"$<i>.<path>"` strings of an input against earlier outputs (see the header comment). */
export function resolveRefs(input: unknown, outputs: (id: string) => unknown): unknown {
  if (typeof input === "string") {
    const m = /^\$([\w-]+)\.([\w.]+)$/.exec(input);
    if (!m) return input;
    let v: unknown = outputs(m[1]!);
    for (const k of m[2]!.split(".")) {
      if (!v || typeof v !== "object") return input;
      v = (v as Record<string, unknown>)[k];
    }
    return typeof v === "string" ? v : input;
  }
  if (Array.isArray(input)) return input.map((x) => resolveRefs(x, outputs));
  if (input && typeof input === "object")
    return Object.fromEntries(Object.entries(input).map(([k, v]) => [k, resolveRefs(v, outputs)]));
  return input;
}

/**
 * The web worker with the fixture pages and searches answered in-process (anything else goes to `fallback`, or
 * fails as unreachable). Only for the FakeRuntime mode and tests.
 */
export function fixtureWebWorker(fallback?: WebWorker): WebWorker {
  const pages = new Map(FIXTURE_PAGES.map((p) => [p.url, p]));
  return async (job, proxy) => {
    if (job.op === "fetch") {
      const p = pages.get(job.url);
      if (p)
        return {
          ok: true,
          finalUrl: p.url,
          title: p.title,
          site: p.site,
          ...(p.publishedAt ? { publishedAt: p.publishedAt } : {}),
          contentType: "text/html",
          text: p.text,
          truncated: false,
        };
    }
    if (job.op === "search") {
      const hits = FIXTURE_SEARCH[job.query];
      if (hits) return { ok: true, results: hits };
    }
    return fallback ? fallback(job, proxy) : { ok: false, code: "web_unreachable" };
  };
}
