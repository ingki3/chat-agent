import crypto from "node:crypto";
import { TEST_MARKER, TEST_SKILL_TOOL, TEST_TOOL } from "../connections/tester.js";
import { FINANCE_DISCLAIMER, financeLabel, type FinanceMeta, type RuntimeId } from "@agentlee/shared";
import { OUR_TOOL_PREFIX, type McpConnection } from "./lockdown.js";
import { CITATION_SCENARIOS, resolveRefs, type CitationScenarioName } from "./fake-citations.js";
import { SUMMARY_MARKER } from "./context.js";
import { docScenario } from "./fake-docs.js";
import { pythonScenario, type PythonScenario } from "./fake-python.js";
import { FILE_SCENARIOS, type FileScenarioName } from "./fake-files.js";
import {
  RuntimeFailure,
  SessionGoneError,
  type RuntimeAdapter,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeSession,
  type RuntimeTurn,
  type StartContext,
  type TurnInput,
  type UsageReport,
} from "./adapter.js";

/**
 * Scripted runtime for tests and local development (FAKE_RUNTIME=1). Behaviour per turn comes from a script;
 * the default script answers by echoing, and understands commands typed as the message for manual testing:
 *   /tool <seconds>   a tool call that stays silent for that long (keep-alive check, #12)
 *   /error            the turn fails
 *   /limit            a usage-limit signal
 *   /long <n>         n words, slowly (to try the stop button)
 *   /artifact <kind> <title>          (next lines: the content; JSON for chart, table, document)
 *   /artifact-slow <kind> <title>     the same, then 4 s more of reply after the artifact is stored
 *   /artifact-update <id> <field>     (next lines: the new content of that field — content, chart, table, document)
 *                     real calls of our MCP tools `artifact_create` / `artifact_update` with the run's token
 *                     (needs `runTools`, as the FAKE_RUNTIME=1 server registers it; #27)
 *   /finance [cited]   scripted finance tool results (AAPL, 005930 — fixed numbers, no network) and an answer that
 *                     leaves out (or, with `cited`, states) the sources and as-of dates: the run manager's finance
 *                     check then adds its note (#30)
 *   "AAPL, 005930 6개월 비교 차트" (symbols + 차트; 비교·캔들·가격·재무, 1개월·3개월·6개월·1년)   a real call of our
 *                     `finance_chart` (#31): the table and chart artifacts, the table part and the finance note
 *                     come from the server (FAKE_RUNTIME=1 answers the finance URLs with synthetic data)
 *   /watchlist, "내 관심 종목"   a real call of our `watchlist_get` (#31)
 *   /burst <n>        n words as fast as possible, in paragraphs (rendering performance, #14)
 *   /md               markdown sample: GFM table, code blocks, KaTeX math, links (#14)
 *   /xss              hostile markup that must never run (#14)
 *   /secrettool       a tool call whose input and output carry secret-looking fields (#14)
 *   /cite <scenario>   real calls of our web and citation tools on the fixture pages (`fake-citations.ts`:
 *                     conflict, insufficient, partial, reuse) and the scenario's answer with `[n]` markers: the run
 *                     manager's citation check then adds its note (#25)
 *   /cite-id <sourceId> <snippet>   one real `cite` of that id (e.g. another conversation's) and a cited sentence
 *   "매일 아침 8시 관심 종목 브리핑" (매일/평일 + 시 + 브리핑·예약·알려줘)   a real call of our `schedule_create` with a
 *                     daily (or weekday) schedule at that hour, then a reply pointing at the confirmation card (#55)
 *   /doc <kind> [<fileId>]   "이 내용을 <kind> 보고서로" (#49): real calls of `doc_create` (the report of
 *                     `fake-docs.ts`, with the picture `fileId` when given) and `artifact_create` (a `document`
 *                     artifact of that file); kind docx|xlsx|pptx|pdf, or hwp for the refusal
 *   /python <scenario> [<fileId>]   a real call of our `python_run` (#47) with the fixed code of `fake-python.ts`
 *                     (sum — of the given CSV, writing 합계.csv —, loop, net) and a short answer
 *   /file-<scenario>   real calls of our file tools on the conversation's first upload (`fake-files.ts`: page12,
 *                     missing) and the scenario's answer with `[n]` markers (#48)
 *   /file-cite <fileId> <snippet>   one real `file_cite` of that id (e.g. another user's file) and a cited sentence
 *
 * The run manager's summary request (`SUMMARY_REQUEST`, #45) is answered with `fakeSummary` of what the session
 * was given — deterministic, so tests can tell which messages a summary covers.
 */
export type FakeStep =
  | { text: string }
  | { reasoning: string }
  | { delayMs: number }
  | { tool: string; ms: number; input?: unknown; output?: unknown; isError?: boolean }
  /**
   * A real call of one of our MCP server's tools with this run's token (StartContext.mcp). Input strings
   * `"$<i>.<path>"` are values of the i-th call's output of this turn (fake-citations.ts `resolveRefs`).
   */
  | { call: string; input: Record<string, unknown> }
  | { usage: UsageReport }
  | { notice: string }
  | { limit: string; resetsAt?: number; retryAfterMs?: number; modelFamily?: string }
  | { fail: string; code?: RuntimeFailure["code"] };

export type FakeScript = (input: TurnInput, memory: string[]) => FakeStep[];

/**
 * The connection test prompt (#17), answered like a real runtime would: our tool, the verification skill (its
 * output computed the way the skill does) and a short reply. A fake without tools has no MCP server to ask.
 */
function connectionTestSteps(text: string): FakeStep[] {
  const nonce = /with text "([^"]*)"/.exec(text)?.[1] ?? "";
  return [
    { tool: TEST_TOOL, ms: 0, output: { now: new Date().toISOString() } },
    {
      tool: TEST_SKILL_TOOL,
      ms: 0,
      output: {
        characters: [...nonce].length,
        sha256: crypto.createHash("sha256").update(nonce, "utf8").digest("hex"),
        reversed: [...nonce].reverse().join(""),
      },
    },
    { text: "OK" },
    // A test costs something too (#44): recorded with purpose `connection_test`.
    { usage: { inputTokens: 40, outputTokens: 1, costUsd: 0.0002 } },
  ];
}

/** `/artifact …` and `/artifact-update …` (see the header comment), or undefined for any other text. */
function artifactSteps(t: string): FakeStep[] | undefined {
  const nl = t.indexOf("\n");
  const head = nl === -1 ? t : t.slice(0, nl);
  const body = nl === -1 ? "" : t.slice(nl + 1);
  const json = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return s;
    }
  };
  const created = /^\/artifact(-slow)?\s+(\w+)\s+(.+)$/.exec(head);
  if (created) {
    const slow = !!created[1];
    const kind = created[2]!;
    const title = created[3]!;
    const field = ["chart", "table", "document"].includes(kind) ? kind : "content";
    return [
      { text: "아티팩트를 만들게요. " },
      {
        call: "artifact_create",
        input: { kind, title, [field]: field === "content" ? body : json(body) },
      },
      // `/artifact-slow`: the reply goes on for a few seconds after the artifact exists (#28: an open page joins
      // the run while it is still streaming).
      ...(slow ? [{ delayMs: 4000 }] : []),
      { text: "만들었어요." },
    ];
  }
  const m = /^\/artifact-update\s+(\S+)\s+(content|chart|table|document)$/.exec(head);
  if (m)
    return [
      { text: "새 버전을 만들게요. " },
      {
        call: "artifact_update",
        input: { artifactId: m[1]!, [m[2]!]: m[2] === "content" ? body : json(body) },
      },
      { text: "고쳤어요." },
    ];
  return undefined;
}

const parseOr = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return { error: text }; // the MCP SDK's own input validation answers in words
  }
};

/** One `tools/call` to our MCP server (stateless JSON-RPC over HTTP), as a runtime would make it. */
async function callOurTool(
  mcp: McpConnection | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<{ output: unknown; isError: boolean }> {
  if (!mcp) return { output: { error: "no_mcp" }, isError: true };
  try {
    const res = await fetch(mcp.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${mcp.token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    const j = (await res.json()) as {
      result?: { content?: { text?: string }[]; isError?: boolean };
      error?: unknown;
    };
    const text = j.result?.content?.[0]?.text;
    return {
      output: text === undefined ? (j.error ?? { error: `http_${res.status}` }) : parseOr(text),
      isError: !!j.error || !!j.result?.isError,
    };
  } catch {
    return { output: { error: "mcp_unreachable" }, isError: true };
  }
}

/** A finance tool result in the shape the finance tools return (records with stamps, `sources`, disclaimer). */
function financeResult(tool: string, data: Record<string, unknown>, meta: FinanceMeta) {
  const value = (v: number, unit: string) => ({ value: v, unit, ...meta });
  return {
    tool,
    ...data,
    price: value(data.price as number, data.currency as string),
    sources: [{ ...meta, label: financeLabel(meta) }],
    warnings: [],
    disclaimer: FINANCE_DISCLAIMER,
  };
}

/** `/finance [cited]` (see the header comment). Fixed numbers of Friday 2026-11-13, asked on the weekend. */
function financeSteps(cited: boolean): FakeStep[] {
  const us: FinanceMeta = {
    source: "Yahoo Finance",
    asOf: "2026-11-13T16:00:00-05:00",
    timeZone: "America/New_York",
    delayed: false,
    kind: "close",
  };
  const kr: FinanceMeta = {
    source: "네이버 증권",
    asOf: "2026-11-13T15:30:00+09:00",
    timeZone: "Asia/Seoul",
    delayed: false,
    kind: "close",
  };
  return [
    {
      tool: `${OUR_TOOL_PREFIX}us_quote`,
      ms: 0,
      input: { symbol: "AAPL" },
      output: financeResult("us_quote", { symbol: "AAPL", currency: "USD", price: 348.51 }, us),
    },
    {
      tool: `${OUR_TOOL_PREFIX}kr_quote`,
      ms: 0,
      input: { code: "005930" },
      output: financeResult("kr_quote", { code: "005930", currency: "KRW", price: 206000 }, kr),
    },
    {
      text: cited
        ? "AAPL은 348.51달러(Yahoo Finance · 2026-11-13 16:00 ET 종가), 삼성전자는 206,000원(네이버 증권 · 2026-11-13 15:30 KST 종가)이에요."
        : "AAPL은 348.51달러, 삼성전자는 206,000원이에요.",
    },
  ];
}
/**
 * A finance chart request in plain words (#31): "AAPL, 005930 6개월 비교 차트", "NVDA 캔들 차트 3개월". Symbols are
 * 6-digit codes and capital tickers; the rest picks the chart and the range. Undefined for any other text.
 */
export function financeChartSteps(t: string): FakeStep[] | undefined {
  if (!/차트/.test(t)) return undefined;
  const symbols = [...new Set(t.match(/\b(\d{6}|[A-Z][A-Z0-9.-]{0,9})\b/g) ?? [])]
    .filter((x) => x !== "USD" && x !== "KRW")
    .slice(0, 5);
  if (!symbols.length) return undefined;
  const range = /1\s*년/.test(t)
    ? "1y"
    : /3\s*개월/.test(t)
      ? "3mo"
      : /1\s*개월|한\s*달/.test(t)
        ? "1mo"
        : "6mo";
  const chart = /캔들/.test(t)
    ? "candle"
    : /재무|매출|이익/.test(t)
      ? "financials"
      : /비교|수익률/.test(t) || symbols.length > 1
        ? "compare"
        : "line";
  const currency = /달러\s*기준|USD/.test(t) ? "USD" : undefined;
  return [
    { text: "표와 차트를 만들게요. " },
    {
      call: "finance_chart",
      input: {
        symbols,
        chart,
        ...(chart === "financials" ? {} : { range }),
        ...(currency ? { currency } : {}),
      },
    },
    {
      text: "같은 데이터로 표와 차트를 만들었어요. 모든 값의 출처와 기준 시각은 표의 열과 차트 아래에 적었어요.",
    },
  ];
}

/** Markdown the chat screen must render (FR-3.2). */
export const FAKE_MARKDOWN = [
  "## 단진자 정리\n\n",
  "주기는 진폭이 작을 때 $T = 2\\pi\\sqrt{L/g}$ 로 근사해요.\n\n",
  "$$\ng = \\frac{4\\pi^2 L}{T^2}\n$$\n\n",
  "| 길이 (m) | 주기 (s) |\n|---:|---:|\n| 0.5 | 1.42 |\n| 1.0 | 2.01 |\n\n",
  "```python\nimport math\nprint(2 * math.pi * math.sqrt(1.0 / 9.8))\n```\n\n",
  "- **굵게**, *기울임*, `인라인 코드`, ~~취소선~~\n- [참고 링크](https://example.com/pendulum)\n",
];

/** Hostile output: none of it may run or reach the DOM as markup (FR-3.2 sanitize). */
export const FAKE_XSS = [
  '<img src="x" onerror="window.__xss=1">\n\n',
  "<script>window.__xss=1</script>\n\n",
  "[눌러 보세요](javascript:window.__xss=1) ",
  '<a href="javascript:window.__xss=1">raw</a>\n\n',
  "![그림](javascript:window.__xss=1)\n\n",
  "$\\href{javascript:window.__xss=1}{수식 링크}$\n\n",
  '<iframe src="javascript:window.__xss=1"></iframe> 끝',
];

/** `/cite <scenario>` and `/cite-id <sourceId> <snippet>` (see the header comment), or undefined. */
function citationSteps(t: string): FakeStep[] | undefined {
  const named = /^\/cite\s+(\w+)$/.exec(t);
  if (named && Object.hasOwn(CITATION_SCENARIOS, named[1]!)) {
    const sc = CITATION_SCENARIOS[named[1] as CitationScenarioName];
    return [...sc.calls.map((c) => ({ call: c.tool, input: c.input })), { text: sc.answer }];
  }
  const file = /^\/file-(\w+)$/.exec(t);
  if (file && Object.hasOwn(FILE_SCENARIOS, file[1]!)) {
    const sc = FILE_SCENARIOS[file[1] as FileScenarioName];
    return [...sc.calls.map((c) => ({ call: c.tool, input: c.input })), { text: sc.answer }];
  }
  const fileById = /^\/file-cite\s+(\S+)\s+([\s\S]+)$/.exec(t);
  if (fileById)
    return [
      { call: "file_cite", input: { fileId: fileById[1]!, snippet: fileById[2]! } },
      { text: "그 파일에 따르면 그렇다고 해요[1]." },
    ];
  const byId = /^\/cite-id\s+(\S+)\s+([\s\S]+)$/.exec(t);
  if (byId)
    return [
      { call: "cite", input: { sourceId: byId[1]!, snippet: byId[2]! } },
      { text: "그 자료에 따르면 그렇다고 해요[1]." },
    ];
  return undefined;
}

/**
 * The FakeRuntime's summary (#45): every earlier text of the session (a previous summary included) in order, each
 * on one line and cut to 40 characters.
 */
export const fakeSummary = (memory: readonly string[]): string =>
  `요약: ${memory
    .filter((m) => !m.startsWith(SUMMARY_MARKER))
    .map((m) => m.replace(/\s+/g, " ").slice(0, 40).trim())
    .join(" / ")}`;

/**
 * A schedule request in plain words (#55, FR-8.1): "매일 아침 8시 관심 종목 브리핑", "평일 저녁 7시에 … 알려줘". A
 * real `schedule_create` call (the card), or undefined for any other text.
 */
export function scheduleSteps(t: string): FakeStep[] | undefined {
  const m = /^(매일|평일)\s*(아침|오전|낮|오후|저녁|밤)?\s*(\d{1,2})시(?:\s*(\d{1,2})분)?에?\s+(.+)$/.exec(t);
  if (!m || !/(브리핑|예약|알려|정리)/.test(m[5]!)) return undefined;
  let hour = Number(m[3]);
  if (["오후", "저녁", "밤"].includes(m[2] ?? "") && hour < 12) hour += 12;
  if (hour > 23 || Number(m[4] ?? 0) > 59) return undefined;
  const time = `${String(hour).padStart(2, "0")}:${String(Number(m[4] ?? 0)).padStart(2, "0")}`;
  const what = m[5]!.replace(/(해\s*줘|해\s*주세요|알려\s*줘|예약해\s*줘)[.!]*$/u, "").trim();
  const name = `${m[2] ? `${m[2]} ` : ""}${what}`.slice(0, 100);
  return [
    { text: "이렇게 예약해 둘까요? " },
    {
      call: "schedule_create",
      input: {
        name,
        prompt: `${what}해줘`,
        timing: { type: m[1] === "평일" ? "weekdays" : "daily", time },
        timeZone: "Asia/Seoul",
      },
    },
    { text: "아래 확인 카드에서 **만들기**를 누르면 예약이 만들어져요." },
  ];
}

export const defaultScript: FakeScript = (input, memory) => {
  const t = input.text.trim();
  if (t.startsWith(SUMMARY_MARKER))
    return [
      { text: fakeSummary(memory) },
      { usage: { inputTokens: 20 * memory.length, outputTokens: 30, costUsd: 0.0001 } },
    ];
  if (t.startsWith(TEST_MARKER)) return connectionTestSteps(t);
  const cite = citationSteps(t);
  if (cite) return cite;
  const fin = /^\/finance(\s+cited)?$/.exec(t);
  if (fin) return financeSteps(!!fin[1]);
  const artifact = artifactSteps(t);
  if (artifact) return artifact;
  const schedule = scheduleSteps(t);
  if (schedule) return schedule;
  const doc = /^\/doc\s+(docx|xlsx|pptx|pdf|hwp|hwpx)(?:\s+(\S+))?$/.exec(t);
  if (doc) {
    const sc = docScenario(doc[1]!, doc[2]);
    return [
      { text: "문서를 만들게요. " },
      ...sc.calls.map((c) => ({ call: c.tool, input: c.input })),
      { text: sc.answer },
    ];
  }
  const py = /^\/python\s+(sum|loop|net)(?:\s+(\S+))?$/.exec(t);
  if (py) {
    const sc = pythonScenario(py[1] as PythonScenario, py[2]);
    return [{ text: "계산해 볼게요. " }, { call: "python_run", input: sc.input }, { text: sc.answer }];
  }
  const chart = financeChartSteps(t);
  if (chart) return chart;
  if (t === "/watchlist" || t === "내 관심 종목")
    return [
      { text: "관심 종목을 볼게요. " },
      { call: "watchlist_get", input: {} },
      { text: "관심 종목 목록을 가져왔어요." },
    ];
  if (t === "/md") return FAKE_MARKDOWN.flatMap((text) => [{ text }, { delayMs: 15 }]);
  if (t === "/xss") return FAKE_XSS.map((text) => ({ text }));
  if (t === "/secrettool")
    return [
      { text: "검색할게요. " },
      {
        tool: "web_search",
        ms: 200,
        input: { query: "단진자 주기", apiKey: "sk-fake-secret-123", nested: { password: "hunter2" } },
        output: { results: 3, token: "tok-fake-456" },
      },
      { text: "3건 찾았어요." },
    ];
  const burst = /^\/burst\s+(\d+)/.exec(t);
  if (burst) {
    const n = Number(burst[1]);
    const steps: FakeStep[] = [];
    for (let i = 1; i <= n; i++) {
      steps.push({ text: i % 60 === 0 ? `**단어${i}**\n\n` : `단어${i} ` });
      if (i % 20 === 0) steps.push({ delayMs: 1 });
    }
    return steps;
  }
  const m = /^\/(tool|error|limit|long)\b\s*(\d+)?/.exec(t);
  if (m?.[1] === "tool")
    return [
      { text: "도구를 실행할게요. " },
      { tool: "slow_tool", ms: Number(m[2] ?? 5) * 1000, output: { ok: true } },
      { text: "끝났어요." },
    ];
  if (m?.[1] === "error") return [{ text: "잠시만요…" }, { fail: "fake failure" }];
  if (m?.[1] === "limit") return [{ limit: "사용 한도에 도달했어요 (가짜)" }];
  const words =
    m?.[1] === "long"
      ? Array.from({ length: Number(m[2] ?? 200) }, (_, i) => `단어${i + 1}`)
      : [`(가짜 응답 · ${input.model}${input.effort ? ` · ${input.effort}` : ""})`, ...t.split(/\s+/)];
  return [
    { reasoning: "사용자의 말을 되풀이한다." },
    ...words.flatMap((w) => [{ text: `${w} ` }, { delayMs: m?.[1] === "long" ? 50 : 15 }]),
    { text: memory.length > 1 ? `\n(이 세션에서 ${memory.length}번째 메시지예요)` : "" },
    { usage: { inputTokens: 10 * memory.length, outputTokens: words.length } },
  ];
};

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

export class FakeRuntime implements RuntimeAdapter {
  readonly id: RuntimeId;
  /** Sessions opened and closed — tests check that the run manager releases every session it opens. */
  opened = 0;
  closed = 0;
  /** Sessions resumed (not started). */
  resumed = 0;
  /** resume() calls, including those that found no session (the run manager must not even try some, #45). */
  resumeAttempts = 0;
  /** setModel() calls: model-only changes inside a resumed session (#45). */
  readonly setModels: { sessionId: string; model: string }[] = [];
  /**
   * What each session knows, in order (#45 contract tests): its start context (the summary, then each history
   * message with text) and every turn after it — the input, then the reply's text.
   */
  readonly transcripts = new Map<string, { role: string; text: string }[]>();
  /** Per turn: the session and what it knew right before the turn's input. */
  readonly turnLog: {
    sessionId: string;
    model: string;
    input: string;
    before: { role: string; text: string }[];
  }[] = [];
  /** System prompts of the sessions started, in order — tests check what the run manager assembled (#20). */
  readonly systemPrompts: string[] = [];
  /** Every StartContext passed to start/resume (tests check the connection the run manager chose). */
  readonly contexts: StartContext[] = [];
  /** Sessions this "runtime" remembers (forget() simulates a runtime that lost them). */
  private readonly sessions = new Map<
    string,
    { model: string; memory: string[]; mcp?: McpConnection | undefined }
  >();

  constructor(
    private readonly opts: {
      id?: RuntimeId;
      script?: FakeScript;
      models?: RuntimeCapabilities["models"];
      canResume?: boolean;
      usesTools?: boolean;
      /** Runs get our MCP server (for `call` steps) while the connection test stays scripted (FAKE_RUNTIME=1). */
      runTools?: boolean;
      /** Act like a real runtime that needs a connection (#17). */
      needsConnection?: boolean;
      /** `canSwitchModelInSession` (default true): false = a model change needs a fresh session (#45). */
      canSwitchModel?: boolean;
    } = {},
  ) {
    this.id = opts.id ?? "claude-code";
  }

  capabilities(): RuntimeCapabilities {
    return {
      models: this.opts.models ?? [
        {
          id: "fake-large",
          label: "Fake Large",
          efforts: ["low", "medium", "high"],
          defaultEffort: "medium",
        },
        { id: "fake-small", label: "Fake Small", efforts: [] },
      ],
      canSwitchModelInSession: this.opts.canSwitchModel ?? true,
      canResume: this.opts.canResume ?? true,
      usesTools: this.opts.usesTools ?? false,
      ...(this.opts.runTools ? { runTools: true } : {}),
      needsConnection: this.opts.needsConnection ?? false,
    };
  }

  /** Its sessions live in memory only: forgetting one (a test, or a deleted conversation, #54) drops it. */
  async forget(externalSessionId: string): Promise<void> {
    this.sessions.delete(externalSessionId);
  }

  async start(ctx: StartContext): Promise<RuntimeSession> {
    this.contexts.push(ctx);
    const id = `fake-${crypto.randomUUID()}`;
    this.systemPrompts.push(ctx.systemPrompt);
    const memory = [
      ...(ctx.summary ? [ctx.summary.text] : []),
      ...ctx.history.flatMap((h) => h.parts.map((p) => (p.type === "text" ? p.text : ""))),
    ].filter(Boolean);
    this.sessions.set(id, { model: ctx.model, memory, mcp: ctx.mcp });
    this.transcripts.set(id, [
      ...(ctx.summary ? [{ role: "summary", text: ctx.summary.text.trim() }] : []),
      ...ctx.history.flatMap((h) => {
        const text = h.parts
          .flatMap((p) => (p.type === "text" ? [p.text] : []))
          .join("\n")
          .trim();
        return text ? [{ role: h.role, text }] : [];
      }),
    ]);
    return this.session(id);
  }

  async resume(externalSessionId: string, ctx?: StartContext): Promise<RuntimeSession> {
    if (ctx) this.contexts.push(ctx);
    this.resumeAttempts++;
    if (this.opts.canResume === false) throw new Error("this runtime cannot resume");
    const known = this.sessions.get(externalSessionId);
    if (!known) throw new SessionGoneError();
    // Every run has its own MCP token: the resumed session calls tools with this run's.
    known.mcp = ctx?.mcp;
    this.resumed++;
    return this.session(externalSessionId);
  }

  private session(id: string): RuntimeSession {
    this.opened++;
    const state = this.sessions.get(id)!;
    const script = this.opts.script ?? defaultScript;
    return {
      externalSessionId: id,
      setModel: async (model) => {
        if (this.opts.canSwitchModel === false)
          throw new Error("this runtime cannot switch models in a session");
        this.setModels.push({ sessionId: id, model });
        state.model = model;
      },
      close: async () => {
        this.closed++;
      },
      turn: (input): RuntimeTurn => {
        const transcript = this.transcripts.get(id) ?? [];
        this.transcripts.set(id, transcript);
        this.turnLog.push({ sessionId: id, model: input.model, input: input.text, before: [...transcript] });
        transcript.push({ role: "user", text: input.text.trim() });
        const reply = { role: "assistant", text: "" };
        let raw = "";
        transcript.push(reply);
        state.memory.push(input.text);
        const ctrl = new AbortController();
        const steps = script({ ...input, model: input.model || state.model }, state.memory);
        async function* events(): AsyncGenerator<RuntimeEvent> {
          let seq = 0;
          const outputs: unknown[] = [];
          for (const step of steps) {
            if (ctrl.signal.aborted) return;
            if ("text" in step) {
              raw += step.text;
              reply.text = raw.trim();
              if (step.text) yield { type: "text_delta", text: step.text };
            } else if ("reasoning" in step) yield { type: "reasoning_delta", text: step.reasoning };
            else if ("delayMs" in step) await sleep(step.delayMs, ctrl.signal);
            else if ("tool" in step) {
              const callId = `call-${++seq}`;
              yield { type: "tool_start", callId, name: step.tool, input: step.input ?? { ms: step.ms } };
              await sleep(step.ms, ctrl.signal);
              if (ctrl.signal.aborted) return;
              yield {
                type: "tool_end",
                callId,
                output: step.output,
                ...(step.isError ? { isError: true } : {}),
              };
            } else if ("call" in step) {
              const callId = `call-${++seq}`;
              const input = resolveRefs(step.input, (i) => outputs[Number(i)]) as Record<string, unknown>;
              yield { type: "tool_start", callId, name: `${OUR_TOOL_PREFIX}${step.call}`, input };
              const r = await callOurTool(state.mcp, step.call, input);
              outputs.push(r.output);
              if (ctrl.signal.aborted) return;
              yield { type: "tool_end", callId, output: r.output, ...(r.isError ? { isError: true } : {}) };
            } else if ("usage" in step) yield { type: "usage", ...step.usage };
            else if ("notice" in step)
              yield { type: "notice", level: "info", code: "fake", message: step.notice };
            else if ("limit" in step) {
              yield {
                type: "limit",
                code: "usage_limit",
                message: step.limit,
                ...(step.resetsAt === undefined ? {} : { resetsAt: step.resetsAt }),
                ...(step.retryAfterMs === undefined ? {} : { retryAfterMs: step.retryAfterMs }),
                ...(step.modelFamily === undefined ? {} : { modelFamily: step.modelFamily }),
              };
              return;
            } else if ("fail" in step) throw step.code ? new RuntimeFailure(step.code) : new Error(step.fail);
          }
        }
        return { events: events(), interrupt: async () => ctrl.abort() };
      },
    };
  }
}
