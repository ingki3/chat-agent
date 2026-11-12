import { describe, expect, it } from "vitest";
import { ChartSpec, chartShapeOk, TableData, type FinanceMeta } from "@agentlee/shared";
import { FINANCE_CHART_TOOL, FINANCE_TOOLS } from "@agentlee/mcp-tools/finance";
import type { MessagePart } from "@agentlee/shared";
import { RAW_JOB_LIMITS } from "../src/web/service.js";
import { finalize } from "../src/finance/records.js";
import { financeEvidence, financeNote } from "../src/finance/checker.js";
import { run as runWorker, RAW_LIMITS } from "../../../packages/mcp-tools/web/worker.mjs";
import {
  buildFinanceArtifacts,
  fetchDataset,
  fxOn,
  rangeStart,
  type BuiltArtifacts,
  type ChartInput,
  type FinanceDataset,
} from "../src/finance/chart.js";
import { FinanceService, splitJobs } from "../src/finance/service.js";
import { fakeBars, fixtureFinanceWorker } from "../src/runtime/fake-finance.js";
import {
  chartPage,
  chartSvg,
  escapeHtml,
  serveVersion,
  tableHtml,
  zoomWindows,
} from "../src/artifacts/serve.js";
import { encodeBody } from "../src/artifacts/store.js";

/**
 * Finance table and chart artifacts (#31): one data set → the table and the chart. Completion criterion: the chart's
 * end points are the table's values ("차트 끝점 값 = 표 값").
 */

const SATURDAY = Date.parse("2026-11-14T10:00:00+09:00");
const service = (now = SATURDAY) =>
  new FinanceService(
    fixtureFinanceWorker(() => now),
    async () => ({ url: "http://127.0.0.1:9", port: 9 }),
    {
      now: () => now,
    },
  );
const run = (svc: FinanceService) => async (tool: string, input: Record<string, unknown>) =>
  svc.run(
    FINANCE_TOOLS.find((t) => t.name === tool)!,
    input,
  );

async function dataset(input: ChartInput, now = SATURDAY): Promise<FinanceDataset> {
  const r = await fetchDataset(input, run(service(now)), () => true, now);
  if (!r.ok) throw new Error(r.code);
  return r.data;
}

/** The table cell of a column for a symbol's last row. */
function lastCell(t: TableData, symbol: string, column: string) {
  const col = t.columns.indexOf(column);
  const sym = t.columns.indexOf("종목");
  const rows = t.rows.filter((r) => r[sym] === symbol);
  expect(col, column).toBeGreaterThanOrEqual(0);
  return rows.at(-1)![col];
}
/** Every non-null value a chart draws for a symbol, by series set, with the label it is drawn at. */
function chartPoints(spec: ChartSpec) {
  const sets = [
    { label: spec.seriesLabel ?? "", series: spec.series },
    ...(spec.views ?? []).map((v) => ({ label: v.label, series: v.series })),
  ];
  return sets.map((s) => ({
    label: s.label,
    series: s.series.map((x) => {
      let i = x.values.length - 1;
      while (i >= 0 && x.values[i] === null) i--;
      return { name: x.name, last: x.values[i], at: spec.labels[i], ohlc: x.ohlc?.[i] };
    }),
  }));
}
const COLUMN: Record<string, Record<string, string>> = {
  compare: { "원화 기준": "수익률 원화 기준(%)", "달러 기준": "수익률 달러 기준(%)", "": "수익률(%)" },
  line: { "원화 기준": "종가(KRW)", "달러 기준": "종가(USD)", "": "종가" },
};
function checkEndPoints(b: BuiltArtifacts, kind: "compare" | "line") {
  const t = b.table.data;
  let checked = 0;
  for (const set of chartPoints(b.chart.spec))
    for (const s of set.series) {
      const col = COLUMN[kind]![set.label]!;
      expect(s.last, `${set.label} ${s.name}`).toBe(lastCell(t, s.name, col));
      // …and it is drawn at that row's date.
      expect(s.at).toBe(lastCell(t, s.name, "날짜"));
      checked++;
    }
  return checked;
}

describe("one data set → table and chart (#31)", () => {
  it('"AAPL, 005930 6개월 비교": every chart end point is a table value, in both bases', async () => {
    const ds = await dataset({ symbols: ["AAPL", "005930"], chart: "compare", range: "6mo" });
    const b = buildFinanceArtifacts(ds);
    expect(TableData.safeParse(b.table.data).success).toBe(true);
    expect(ChartSpec.safeParse(b.chart.spec).success && chartShapeOk(b.chart.spec)).toBe(true);
    expect(b.chart.spec.seriesLabel).toBe("원화 기준");
    expect(b.chart.spec.views?.map((v) => v.label)).toEqual(["달러 기준"]);
    expect(checkEndPoints(b, "compare")).toBe(4);
    // Every value, not just the last: the chart is the table's column.
    const t = b.table.data;
    const [di, si, ki] = ["날짜", "종목", "수익률 원화 기준(%)"].map((c) => t.columns.indexOf(c)) as [
      number,
      number,
      number,
    ];
    for (const s of b.chart.spec.series)
      s.values.forEach((v, i) => {
        const row = t.rows.find((r) => r[si] === s.name && r[di] === b.chart.spec.labels[i]);
        expect(v).toBe(row ? row[ki] : null);
      });
  });

  it("price lines and a single-currency chart: end points = the 종가 / converted 종가 columns", async () => {
    const mixed = buildFinanceArtifacts(await dataset({ symbols: ["AAPL", "005930"], chart: "line" }));
    expect(checkEndPoints(mixed, "line")).toBe(4);
    const one = buildFinanceArtifacts(
      await dataset({ symbols: ["AAPL", "NVDA"], chart: "line", range: "3mo" }),
    );
    expect(one.chart.spec.views).toBeUndefined(); // one currency: no exchange rate, no basis switch
    expect(one.table.data.columns).not.toContain("USD/KRW");
    expect(checkEndPoints(one, "line")).toBe(2);
  });

  it("candle: OHLC per day from the table, close = 종가", async () => {
    const b = buildFinanceArtifacts(await dataset({ symbols: ["005930"], chart: "candle", range: "1mo" }));
    expect(b.chart.spec.type).toBe("candle");
    const [p] = chartPoints(b.chart.spec)[0]!.series;
    expect(p!.ohlc).toEqual(["시가", "고가", "저가", "종가"].map((c) => lastCell(b.table.data, "005930", c)));
    expect(p!.last).toBe(lastCell(b.table.data, "005930", "종가"));
    // Candles need one symbol.
    expect(
      (
        await fetchDataset(
          { symbols: ["005930", "AAPL"], chart: "candle" },
          run(service()),
          () => true,
          SATURDAY,
        )
      ).ok,
    ).toBe(false);
  });

  it("every row names its source and as-of; converted values name the rate's as-of too", async () => {
    const b = buildFinanceArtifacts(await dataset({ symbols: ["AAPL", "005930"] }));
    const t = b.table.data;
    const col = (c: string) => t.columns.indexOf(c);
    for (const r of t.rows) {
      expect(r[col("출처")]).toMatch(/^(Yahoo Finance|네이버 증권)$/);
      expect(r[col("기준 시각")]).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2} (ET|KST) 종가$/);
      expect(r[col("환율 출처·기준 시각")]).toMatch(
        /^Yahoo Finance · \d{4}-\d{2}-\d{2} \d{2}:\d{2} ET 종가$/,
      );
    }
    // Friday's close on Saturday (#30 rule), the last row of each.
    expect(lastCell(t, "AAPL", "기준 시각")).toBe("2026-11-13 16:00 ET 종가");
    expect(lastCell(t, "005930", "기준 시각")).toBe("2026-11-13 15:30 KST 종가");
    expect(b.chart.spec.sources).toEqual([
      expect.stringMatching(/^AAPL: Yahoo Finance · 2026-05-1\d ~ 2026-11-13 16:00 ET 종가$/),
      expect.stringMatching(/^005930: 네이버 증권 · 2026-05-1\d ~ 2026-11-13 15:30 KST 종가$/),
    ]);
    expect(b.chart.spec.notes?.[0]).toMatch(
      /^환율: Yahoo Finance USD\/KRW 일별 종가 .* \(2026-11-13 17:00 ET 종가\)$/,
    );
  });

  it("a converted value uses the latest daily rate on or before its date, never one after", async () => {
    const ds = await dataset({ symbols: ["AAPL", "005930"], range: "1mo" });
    if (ds.kind === "financials" || !ds.fx) throw new Error("no fx");
    const b = buildFinanceArtifacts(ds);
    const t = b.table.data;
    const c = (n: string) => t.columns.indexOf(n);
    for (const r of t.rows) {
      const fx = fxOn(ds.fx, String(r[c("날짜")]));
      expect(r[c("USD/KRW")]).toBe(fx?.close ?? null);
      if (r[c("통화")] === "USD" && fx)
        expect(r[c("종가(KRW)")]).toBe(Math.round((r[c("종가")] as number) * fx.close));
      if (r[c("통화")] === "KRW" && fx)
        expect(r[c("종가(USD)")]).toBe(Number(((r[c("종가")] as number) / fx.close).toFixed(2)));
    }
    expect(fxOn(ds.fx, "1999-01-01")).toBeUndefined();
  });

  it("the model's summary: stamped first/last closes and returns that match the table", async () => {
    const b = buildFinanceArtifacts(await dataset({ symbols: ["AAPL", "005930"] }));
    const items = (b.summary as { items: Record<string, { value: number; asOf: string } & FinanceMeta>[] })
      .items;
    expect(items).toHaveLength(2);
    const aapl = items[0]!;
    expect(aapl.lastClose!.value).toBe(lastCell(b.table.data, "AAPL", "종가"));
    expect(aapl.returnPercentKrw!.value).toBe(lastCell(b.table.data, "AAPL", "수익률 원화 기준(%)"));
    expect(aapl.lastClose).toMatchObject({ source: "Yahoo Finance", asOf: "2026-11-13T16:00:00-05:00" });
  });

  it("financials: US only, bars per fiscal period with the 값 column", async () => {
    expect(
      (await fetchDataset({ symbols: ["005930"], chart: "financials" }, run(service()), () => true, SATURDAY))
        .ok,
    ).toBe(false);
    const ds: FinanceDataset = {
      kind: "financials",
      metric: "revenue",
      period: "annual",
      symbols: [
        {
          symbol: "AAPL",
          currency: "USD",
          rows: ["2024-09-28", "2025-09-27"].map((p, i) => ({
            period: p,
            value: 100 + i,
            meta: {
              source: "Yahoo Finance",
              asOf: `${p}T00:00:00-04:00`,
              timeZone: "America/New_York",
              delayed: false,
              kind: "reported",
              label: `Yahoo Finance · ${p} 보고치`,
            },
          })),
        },
      ],
    };
    const b = buildFinanceArtifacts(ds);
    expect(b.chart.spec.type).toBe("bar");
    expect(b.chart.spec.series[0]!.values.at(-1)).toBe(lastCell(b.table.data, "AAPL", "값"));
  });

  it("permissions per part: a US symbol needs us-stock-skill, mixing needs kr-stock-skill for the rate", async () => {
    const only = (skill: string) => (s: string) => s === skill;
    const r1 = await fetchDataset({ symbols: ["AAPL"] }, run(service()), only("kr-stock-skill"), SATURDAY);
    expect(r1).toEqual({ ok: false, code: "finance_not_allowed" });
    const r2 = await fetchDataset({ symbols: ["AAPL"] }, run(service()), only("us-stock-skill"), SATURDAY);
    expect(r2.ok).toBe(true);
    const r3 = await fetchDataset(
      { symbols: ["AAPL"], currency: "KRW" },
      run(service()),
      only("us-stock-skill"),
      SATURDAY,
    );
    expect(r3).toEqual({ ok: false, code: "finance_not_allowed" });
  });

  it("range starts by Seoul's calendar; synthetic data is the same whenever it is asked", () => {
    expect(rangeStart("6mo", SATURDAY)).toBe("2026-05-14");
    expect(rangeStart("1mo", Date.parse("2026-03-31T12:00:00+09:00"))).toBe("2026-02-28");
    const a = fakeBars("AAPL", SATURDAY);
    const b = fakeBars("AAPL", Date.parse("2026-11-20T10:00:00+09:00"));
    expect(b.slice(0, a.length)).toEqual(a);
    expect(a.at(-1)!.date).toBe("2026-11-13");
  });
});

// ---- drawing: views, zoom, candles, tooltips, escaping ----------------------------------------------------

const HOSTILE = `<script>alert(1)</script>"'><img src=x onerror=alert(1)>`;

describe("chart page (#31)", () => {
  it("a basis switch and zoom made of radio buttons and CSS — no script; the first set over all is shown first", async () => {
    const b = buildFinanceArtifacts(await dataset({ symbols: ["AAPL", "005930"] }));
    const html = chartPage(b.chart.title, b.chart.spec);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('<input type="radio" name="cv" id="cv0" checked>');
    expect(html).toContain('<input type="radio" name="cz" id="cz0" checked>');
    expect(html).toMatch(/<label for="cv1">달러 기준<\/label>/);
    expect(zoomWindows(b.chart.spec).map((z) => z.label)).toEqual(["전체", "3개월", "1개월"]);
    expect(html.match(/<div class="cv /g)).toHaveLength(6);
    expect(html).toContain("#cv0:checked~#cz0:checked~.views .v0.z0{display:block}");
    // Tooltips: one hover band per date naming every series' value.
    expect(html).toMatch(
      /<rect class="hit"[^>]*><title>2026-11-13\nAAPL: [\d,.-]+ %\n005930: [\d,.-]+ %<\/title>/,
    );
    // Sources and the rate under the chart.
    expect(html).toContain('<ul class="src" aria-label="출처·기준 시각"><li>AAPL: Yahoo Finance');
    // The served page: no script but the Escape bridge in the app's frame.
    const served = serveVersion("chart", b.chart.title, JSON.stringify(b.chart.spec), {
      escapeBridge: true,
    })!;
    expect(served.body.match(/<script>/g)).toHaveLength(1);
    expect(served.csp).toHaveLength(1);
    // The download SVG carries the sources too.
    expect(chartSvg(b.chart.spec)).toMatch(/<text[^>]*>출처 AAPL: Yahoo Finance/);
  });

  it("candles: wicks and bodies, rising red and falling blue", async () => {
    const b = buildFinanceArtifacts(await dataset({ symbols: ["005930"], chart: "candle", range: "1mo" }));
    const svg = chartSvg(b.chart.spec);
    const n = b.chart.spec.labels.length;
    expect(svg.match(/class="candle"/g)).toHaveLength(n);
    expect(svg.match(/class="wick"/g)).toHaveLength(n);
    expect(svg).toMatch(/fill="#d9443a"/);
  });

  it("every text of a chart is escaped: title, labels, series, views, sources, notes, units", () => {
    const spec: ChartSpec = {
      type: "line",
      title: HOSTILE,
      xLabel: HOSTILE,
      yLabel: HOSTILE,
      unit: "<u>",
      labels: [HOSTILE, "b"],
      series: [{ name: HOSTILE, values: [1, 2] }],
      seriesLabel: HOSTILE.slice(0, 40),
      views: [{ label: HOSTILE.slice(0, 40), unit: "<i>", series: [{ name: HOSTILE, values: [3, 4] }] }],
      sources: [HOSTILE],
      notes: [HOSTILE],
    };
    expect(encodeBody("chart", { chart: spec }).content).toBeTruthy();
    for (const out of [
      chartPage("t", spec),
      chartSvg(spec),
      serveVersion("chart", HOSTILE, JSON.stringify(spec))!.body,
    ])
      expect(out).not.toMatch(/<script|<img|<u>|<i>|onerror=alert\(1\)>/);
    expect(chartPage("t", spec)).toContain(escapeHtml(HOSTILE.slice(0, 16)));
    const t = tableHtml({ columns: [HOSTILE], rows: [[HOSTILE]] });
    expect(t).not.toMatch(/<script|<img/);
  });

  it("the store refuses a chart whose views or candles do not fit its labels", () => {
    const bad = (chart: unknown) => () => encodeBody("chart", { chart });
    const base = { type: "line", labels: ["a", "b"], series: [{ name: "s", values: [1, 2] }] };
    expect(bad({ ...base, views: [{ label: "v", series: [{ name: "s", values: [1] }] }] })).toThrow();
    expect(bad({ ...base, type: "candle" })).toThrow(); // no OHLC
    expect(bad({ ...base, series: [{ name: "s", values: [1, 2], ohlc: [[1, 2, 0, 1], null] }] })).toThrow();
    expect(
      encodeBody("chart", {
        chart: {
          ...base,
          type: "candle",
          series: [{ name: "s", values: [1, 2], ohlc: [[1, 2, 0, 1], null] }],
        },
      }).content,
    ).toContain("ohlc");
  });
});

// ---- review #111: the worker's job contract, the checker reads finance_chart's numbers ---------------------

describe("every supported range fits the real worker's job contract (review #111)", () => {
  it("each job the finance tools send passes worker.mjs's own input check, for every range and market", async () => {
    const jobs: number[] = [];
    const fixture = fixtureFinanceWorker(() => SATURDAY);
    const svc = new FinanceService(
      async (job, proxy) => {
        jobs.push(job.steps.length);
        // The real worker, against a closed port: a job it refuses is `web_bad_input` before any connection.
        const real = (await runWorker(job, { proxy: "http://127.0.0.1:9" })) as {
          ok: boolean;
          code?: string;
        };
        expect(real.code, JSON.stringify(job.steps.map((s) => s.url))).not.toBe("web_bad_input");
        return fixture(job, proxy);
      },
      async () => ({ url: "http://127.0.0.1:9", port: 9 }),
      { now: () => SATURDAY },
    );
    for (const range of ["1mo", "3mo", "6mo", "1y"] as const) {
      const r = await fetchDataset({ symbols: ["AAPL", "005930"], range }, run(svc), () => true, SATURDAY);
      expect(r.ok, range).toBe(true);
    }
    expect(Math.max(...jobs)).toBeLessThanOrEqual(RAW_JOB_LIMITS.maxSteps);
    expect(RAW_JOB_LIMITS.maxSteps).toBe(RAW_LIMITS.maxSteps);
    expect(RAW_JOB_LIMITS.maxBytes).toBe(RAW_LIMITS.maxBytes);
    // 1y of KRX is 5 pages of 60: two jobs, joined in order.
    expect(
      splitJobs(Array.from({ length: 5 }, (_, i) => ({ url: `https://x/${i}` })))!.map((j) => j.length),
    ).toEqual([4, 1]);
    // Session steps share one job's cookie jar: such a plan is never split.
    expect(
      splitJobs([
        { url: "https://x", mode: "cookie" },
        ...Array.from({ length: 4 }, () => ({ url: "https://y" })),
      ]),
    ).toBe(undefined);
    const ds = await dataset({ symbols: ["005930"], range: "1y" });
    if (ds.kind === "financials") throw new Error("kind");
    expect(ds.symbols[0]!.rows.length).toBeGreaterThan(200);
  });

  it("the synthetic worker refuses what the real one refuses", async () => {
    const w = fixtureFinanceWorker(() => SATURDAY);
    const step = { url: "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?range=1mo&interval=1d" };
    expect(
      await w({ op: "raw", steps: Array.from({ length: 5 }, () => step) }, { url: "x", port: 9 }),
    ).toEqual({
      ok: false,
      code: "web_bad_input",
    });
    expect(await w({ op: "raw", steps: [] }, { url: "x", port: 9 })).toEqual({
      ok: false,
      code: "web_bad_input",
    });
  });
});

describe("the finance note checks finance_chart's own numbers (review #111)", () => {
  async function chartParts(text: string) {
    const b = buildFinanceArtifacts(await dataset({ symbols: ["AAPL", "005930"] }));
    const out = finalize(FINANCE_CHART_TOOL.name, b.summary);
    const item = (out as unknown as { items: Record<string, { value: number }>[] }).items[0]!;
    const parts: MessagePart[] = [
      {
        type: "tool_call",
        id: "c1",
        name: "mcp__agentlee__finance_chart",
        input: { symbols: ["AAPL", "005930"] },
      },
      { type: "tool_result", callId: "c1", output: out },
      {
        type: "text",
        text: text
          .replace("{close}", String(item.lastClose!.value))
          .replace("{ret}", String(item.returnPercent!.value)),
      },
    ];
    return parts;
  }
  const missing = (parts: MessagePart[]) => financeNote(parts, undefined)?.missing;

  it("a close or a return with its own source and date passes; the wrong source or date is flagged", async () => {
    expect(financeEvidence(await chartParts("x")).values.length).toBeGreaterThan(10);
    expect(
      missing(await chartParts("AAPL 종가는 {close}달러예요 (Yahoo Finance · 2026-11-13 16:00 ET 종가).")),
    ).toEqual([]);
    expect(
      missing(await chartParts("AAPL 종가는 {close}달러예요 (네이버 증권 · 2026-11-13 15:30 KST 종가).")),
    ).not.toEqual([]);
    expect(
      missing(await chartParts("AAPL 종가는 {close}달러예요 (Yahoo Finance · 2026-11-12 16:00 ET 종가).")),
    ).not.toEqual([]);
    expect(
      missing(await chartParts("AAPL 수익률은 {ret}%예요 (Yahoo Finance · 2026-11-13 16:00 ET 종가).")),
    ).toEqual([]);
    expect(
      missing(await chartParts("AAPL 수익률은 {ret}%예요 (네이버 증권 · 2026-11-13 15:30 KST 종가).")),
    ).not.toEqual([]);
    expect(
      missing(await chartParts("AAPL 수익률은 {ret}%예요 (Yahoo Finance · 2026-11-10 16:00 ET 종가).")),
    ).not.toEqual([]);
  });

  it("a financial value with its own date passes; another date or source is flagged", () => {
    const meta = (p: string) => ({
      source: "Yahoo Finance",
      asOf: `${p}T00:00:00-04:00`,
      timeZone: "America/New_York",
      delayed: false,
      kind: "reported" as const,
      label: `Yahoo Finance · ${p} 보고치`,
    });
    const b = buildFinanceArtifacts({
      kind: "financials",
      metric: "revenue",
      period: "annual",
      symbols: [
        {
          symbol: "AAPL",
          currency: "USD",
          rows: [
            { period: "2024-09-28", value: 391035, meta: meta("2024-09-28") },
            { period: "2025-09-27", value: 416161, meta: meta("2025-09-27") },
          ],
        },
      ],
    });
    const out = finalize(FINANCE_CHART_TOOL.name, b.summary);
    const parts = (text: string): MessagePart[] => [
      {
        type: "tool_call",
        id: "c1",
        name: "finance_chart",
        input: { symbols: ["AAPL"], chart: "financials" },
      },
      { type: "tool_result", callId: "c1", output: out },
      { type: "text", text },
    ];
    expect(missing(parts("AAPL 매출은 416,161달러예요 (Yahoo Finance · 2025-09-27 보고치)."))).toEqual([]);
    expect(missing(parts("AAPL 매출은 416,161달러예요 (Yahoo Finance · 2024-09-28 보고치)."))).not.toEqual(
      [],
    );
    expect(missing(parts("AAPL 매출은 416,161달러예요 (네이버 증권 · 2025-09-27 보고치)."))).not.toEqual([]);
  });
});

describe("a candle day without open/high/low (review #111 round 2, P3)", () => {
  it("draws no candle for it, and says so in the tooltip and under the chart", () => {
    const meta = {
      source: "Yahoo Finance",
      asOf: "2026-11-13T16:00:00-05:00",
      timeZone: "America/New_York",
      delayed: false,
      kind: "close" as const,
      label: "Yahoo Finance · 2026-11-13 16:00 ET 종가",
    };
    const b = buildFinanceArtifacts({
      kind: "candle",
      range: "1mo",
      currency: undefined,
      fx: undefined,
      symbols: [
        {
          symbol: "AAPL",
          market: "US",
          currency: "USD",
          rows: [
            { date: "2026-11-12", open: 10, high: 12, low: 9, close: 11, meta },
            { date: "2026-11-13", open: null, high: null, low: null, close: 20, meta },
          ],
        },
      ],
    });
    const svg = chartSvg(b.chart.spec);
    expect(svg.match(/class="candle"/g)).toHaveLength(1);
    expect(svg).toContain("AAPL: 20 USD (시가·고가·저가 없음)");
    expect(b.chart.spec.notes).toContain("시가·고가·저가가 없는 날은 캔들 없이 종가만 있어요(툴팁에 표시).");
    // A complete candle chart has neither.
    const full = buildFinanceArtifacts({
      kind: "candle",
      range: "1mo",
      currency: undefined,
      fx: undefined,
      symbols: [
        {
          symbol: "AAPL",
          market: "US",
          currency: "USD",
          rows: [{ date: "2026-11-12", open: 10, high: 12, low: 9, close: 11, meta }],
        },
      ],
    });
    expect(chartSvg(full.chart.spec)).not.toContain("없음");
    expect(full.chart.spec.notes ?? []).not.toContain(
      "시가·고가·저가가 없는 날은 캔들 없이 종가만 있어요(툴팁에 표시).",
    );
  });
});
