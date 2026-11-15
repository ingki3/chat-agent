import {
  FinanceMeta,
  financeLabel,
  marketOf,
  type ChartSeries,
  type ChartSpec,
  type ChartView,
  type TableData,
  type WatchMarket,
} from "@agentlee/shared";
import type { SkillResult } from "@agentlee/mcp-tools";
import { localDate } from "./calendar.js";
import { round, val, type Stamp } from "./records.js";
import type { FinanceCode } from "./providers.js";

/**
 * Finance table and chart from one data set (#31, PRD FR-7.5·7.6, 수용 기준 4). `finance_chart` fetches the prices
 * (or US financial figures) and, when Korean and US stocks are mixed, the USD/KRW daily closes through the finance
 * tools; `buildFinanceArtifacts` then computes every figure **once** — converted closes, returns — and writes the
 * same numbers into the table rows and the chart series. The chart's end points therefore are table cells
 * (test: finance-chart.test.ts "chart end points = table values").
 *
 * Every row keeps its own source and as-of (FR-7.6): the table has 출처 and 기준 시각 columns (and the exchange rate's
 * own as-of where a value was converted), the chart lists the sources and the rate used under the drawing.
 */

export type ChartKind = "compare" | "line" | "candle" | "financials";
export type Range = "1mo" | "3mo" | "6mo" | "1y";
export type Currency = "KRW" | "USD";
export type Metric = "revenue" | "operatingIncome" | "netIncome" | "dilutedEps" | "freeCashFlow";

export type ChartInput = {
  symbols: string[];
  chart?: ChartKind;
  range?: Range;
  currency?: Currency;
  metric?: Metric;
  period?: "annual" | "quarterly";
  title?: string;
};

/** One stamped number of a source row (`meta` is that row's stamp). */
type Meta = FinanceMeta & { label: string };
export type PriceRow = {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  meta: Meta;
};
export type SymbolData = { symbol: string; market: WatchMarket; currency: string; rows: PriceRow[] };
export type FxRow = { date: string; close: number; meta: Meta };
export type FinancialRow = { period: string; value: number | null; meta: Meta };
export type FinancialData = { symbol: string; currency: string; rows: FinancialRow[] };

export type FinanceDataset =
  | {
      kind: "compare" | "line" | "candle";
      range: Range;
      /** The basis shown first (and the chart's own series); the other is a view. */
      currency: Currency | undefined;
      symbols: SymbolData[];
      /** Oldest first; present when values are converted. */
      fx: FxRow[] | undefined;
    }
  | {
      kind: "financials";
      metric: Metric;
      period: "annual" | "quarterly";
      symbols: FinancialData[];
    };

const RANGE_MONTHS: Record<Range, number> = { "1mo": 1, "3mo": 3, "6mo": 6, "1y": 12 };
const RANGE_LABEL: Record<Range, string> = { "1mo": "1개월", "3mo": "3개월", "6mo": "6개월", "1y": "1년" };
/** Trading days asked of Naver per range (a few more than the range has; the cut-off trims them). */
const KR_DAYS: Record<Range, number> = { "1mo": 25, "3mo": 70, "6mo": 135, "1y": 260 };
const METRIC_LABEL: Record<Metric, string> = {
  revenue: "매출",
  operatingIncome: "영업이익",
  netIncome: "순이익",
  dilutedEps: "희석 EPS",
  freeCashFlow: "잉여현금흐름",
};
const CURRENCY_LABEL: Record<Currency, string> = { KRW: "원화 기준", USD: "달러 기준" };

const fail = (code: FinanceCode) => ({ ok: false as const, code });

/** The first date of a range ending `now` (Seoul's calendar date, months back). */
export function rangeStart(range: Range, now: number): string {
  const [y, m, d] = localDate(now, "Asia/Seoul").split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1 - RANGE_MONTHS[range], 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(d, last));
  return t.toISOString().slice(0, 10);
}

const metaOf = (o: Record<string, unknown>): Meta | undefined => {
  const m = FinanceMeta.safeParse(o);
  return m.success ? { ...m.data, label: financeLabel(m.data) } : undefined;
};
const numOrNull = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const rowsOf = (out: unknown): Record<string, unknown>[] => {
  const rows = (out as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows)
    ? (rows.filter((r) => r && typeof r === "object") as Record<string, unknown>[])
    : [];
};

/** Price rows of a history tool's output, oldest first, from `start` on; rows without a full stamp are left out. */
export function priceRows(out: unknown, start: string): PriceRow[] {
  return rowsOf(out)
    .flatMap((r): PriceRow[] => {
      const meta = metaOf(r);
      const close = numOrNull(r.close);
      const date = typeof r.date === "string" ? r.date : "";
      if (!meta || close === null || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < start) return [];
      return [{ date, open: numOrNull(r.open), high: numOrNull(r.high), low: numOrNull(r.low), close, meta }];
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

export type ToolRun = (tool: string, input: Record<string, unknown>) => Promise<SkillResult>;

/**
 * Fetches what `input` needs through the finance tools (`run`, each with its own permission and egress), or a
 * fixed code. `allows(skill)`: the caller may use that finance skill now — a Korean symbol needs kr-stock-skill
 * (as does the exchange rate, FR-7.3), a US one us-stock-skill.
 */
export async function fetchDataset(
  input: ChartInput,
  run: ToolRun,
  allows: (skill: "kr-stock-skill" | "us-stock-skill") => boolean,
  now: number,
): Promise<{ ok: true; data: FinanceDataset } | { ok: false; code: FinanceCode }> {
  const symbols = [...new Set(input.symbols)];
  const markets = symbols.map((s) => marketOf(s));
  if (!symbols.length || markets.some((m) => !m)) return fail("finance_bad_input");
  const skillOf = (m: WatchMarket) => (m === "KR" ? "kr-stock-skill" : "us-stock-skill");
  if (markets.some((m) => !allows(skillOf(m!)))) return fail("finance_not_allowed");
  const kind: ChartKind = input.chart ?? (symbols.length > 1 ? "compare" : "line");
  const get = async (tool: string, args: Record<string, unknown>) => {
    const r = await run(tool, args);
    return r.ok ? { ok: true as const, out: r.output } : { ok: false as const, code: r.code as FinanceCode };
  };

  if (kind === "financials") {
    if (markets.some((m) => m !== "US")) return fail("finance_bad_input"); // only US financial statements exist
    const metric = input.metric ?? "revenue";
    const period = input.period ?? "annual";
    const out: FinancialData[] = [];
    for (const symbol of symbols) {
      const r = await get("us_financials", { symbol, period });
      if (!r.ok) return fail(r.code);
      const rows = rowsOf(r.out)
        .flatMap((x): FinancialRow[] => {
          const meta = metaOf(x);
          const p = typeof x.period === "string" ? x.period : "";
          return meta && /^\d{4}-\d{2}-\d{2}$/.test(p)
            ? [{ period: p, value: numOrNull(x[metric]), meta }]
            : [];
        })
        .sort((a, b) => a.period.localeCompare(b.period));
      if (!rows.length) return fail("finance_not_found");
      const currency = (r.out as { currency?: unknown }).currency;
      out.push({ symbol, currency: typeof currency === "string" ? currency : "USD", rows });
    }
    return { ok: true, data: { kind, metric, period, symbols: out } };
  }

  if (kind === "candle" && symbols.length !== 1) return fail("finance_bad_input");
  const range = input.range ?? "6mo";
  const start = rangeStart(range, now);
  const data: SymbolData[] = [];
  for (const [i, symbol] of symbols.entries()) {
    const market = markets[i]!;
    const r =
      market === "KR"
        ? await get("kr_history", { code: symbol, days: KR_DAYS[range] })
        : await get("us_history", { symbol, range, interval: "1d" });
    if (!r.ok) return fail(r.code);
    const rows = priceRows(r.out, start);
    if (!rows.length) return fail("finance_not_found");
    const c = (r.out as { currency?: unknown }).currency;
    data.push({
      symbol,
      market,
      currency: typeof c === "string" ? c : market === "KR" ? "KRW" : "USD",
      rows,
    });
  }
  const currencies = new Set(data.map((d) => d.currency));
  const convertible = data.every((d) => d.currency === "KRW" || d.currency === "USD");
  const needFx =
    convertible && (currencies.size > 1 || (input.currency !== undefined && !currencies.has(input.currency)));
  let fx: FxRow[] | undefined;
  if (needFx) {
    if (!allows("kr-stock-skill")) return fail("finance_not_allowed"); // fx_usdkrw is kr-stock-skill's (FR-7.3)
    const r = await get("fx_usdkrw", { range });
    if (!r.ok) return fail(r.code);
    fx = rowsOf(r.out)
      .flatMap((x): FxRow[] => {
        const meta = metaOf(x);
        const close = numOrNull(x.close);
        const date = typeof x.date === "string" ? x.date : "";
        return meta && close !== null && close > 0 && /^\d{4}-\d{2}-\d{2}$/.test(date)
          ? [{ date, close, meta }]
          : [];
      })
      .sort((a, b) => a.date.localeCompare(b.date));
    if (!fx.length) return fail("finance_not_found");
  }
  const currency: Currency | undefined = needFx
    ? (input.currency ?? (data.some((d) => d.currency === "KRW") ? "KRW" : "USD"))
    : undefined;
  return { ok: true, data: { kind, range, currency, symbols: data, fx } };
}

// ---- one computation for the table and the chart ----------------------------------------------------------

/** The latest daily USD/KRW close on or before `date` (none before the first one: never extrapolated). */
export function fxOn(fx: readonly FxRow[], date: string): FxRow | undefined {
  let found: FxRow | undefined;
  for (const r of fx) {
    if (r.date > date) break;
    found = r;
  }
  return found;
}

/** A value in `to`: as it is in its own currency, otherwise converted with that day's rate (KRW whole won). */
function convert(v: number | null, from: string, to: Currency, rate: number | undefined): number | null {
  if (v === null) return null;
  if (from === to) return v;
  if (rate === undefined) return null;
  return from === "USD" ? round(v * rate, 0) : round(v / rate, 2);
}
const pct = (v: number | null, base: number | null) =>
  v === null || base === null || base === 0 ? null : round((v / base - 1) * 100, 2);

/** "네이버 증권 · 2026-11-13 15:30 KST 종가" → "2026-11-13 15:30 KST 종가". */
const whenOf = (m: Meta) => m.label.slice(m.source.length + 3);

/** One computed row: what the table shows and the chart draws (per basis). */
type Computed = {
  date: string;
  row: PriceRow;
  fx: FxRow | undefined;
  /** Closes, OHLC and returns by basis: the symbol's own currency, and KRW / USD when converted. */
  close: Record<string, number | null>;
  ohlc: Record<string, [number, number, number, number] | null>;
  ret: Record<string, number | null>;
};

function compute(d: SymbolData, fx: readonly FxRow[] | undefined): Computed[] {
  const bases: string[] = [
    d.currency,
    ...(fx ? (["KRW", "USD"] as const).filter((c) => c !== d.currency) : []),
  ];
  const out: Computed[] = d.rows.map((row) => {
    const f = fx ? fxOn(fx, row.date) : undefined;
    const close: Computed["close"] = {};
    const ohlc: Computed["ohlc"] = {};
    for (const b of bases) {
      const conv = (v: number | null) => convert(v, d.currency, b as Currency, f?.close);
      close[b] = b === d.currency ? row.close : conv(row.close);
      const o = b === d.currency ? row.open : conv(row.open);
      const h = b === d.currency ? row.high : conv(row.high);
      const l = b === d.currency ? row.low : conv(row.low);
      const c = close[b]!;
      ohlc[b] = o !== null && h !== null && l !== null && c !== null ? [o, h, l, c] : null;
    }
    return { date: row.date, row, fx: f, close, ohlc, ret: {} };
  });
  for (const b of bases) {
    // The first day with a value in this basis is the base of the return.
    const base = out.find((c) => c.close[b] !== null)?.close[b] ?? null;
    for (const c of out) c.ret[b] = pct(c.close[b] ?? null, base);
  }
  return out;
}

export type BuiltArtifacts = {
  table: { title: string; data: TableData };
  chart: { title: string; spec: ChartSpec };
  /** What the model gets: per symbol the first and last close and the return, each with its stamp. */
  summary: Record<string, unknown>;
};

const stampOf = (m: Meta): Stamp => ({
  source: m.source,
  asOf: m.asOf,
  timeZone: m.timeZone,
  delayed: m.delayed,
  kind: m.kind,
});

/** Table and chart of a data set: every chart value is a cell of the table (same computation, same rounding). */
export function buildFinanceArtifacts(ds: FinanceDataset, titleHint?: string): BuiltArtifacts {
  return ds.kind === "financials" ? buildFinancials(ds, titleHint) : buildPrices(ds, titleHint);
}

function buildPrices(
  ds: Extract<FinanceDataset, { kind: "compare" | "line" | "candle" }>,
  titleHint?: string,
) {
  const names = ds.symbols.map((s) => s.symbol).join(", ");
  const span = RANGE_LABEL[ds.range];
  const what = ds.kind === "compare" ? "수익률 비교" : ds.kind === "candle" ? "캔들 차트" : "가격";
  const chartTitle = titleHint ?? `${names} ${span} ${what}`;
  const computed = ds.symbols.map((s) => ({ s, rows: compute(s, ds.fx) }));
  const fx = !!ds.fx;

  // ---- table: one row per symbol and day, every figure with its source and as-of
  const columns = ["날짜", "종목", "시장", "통화", "시가", "고가", "저가", "종가", "수익률(%)"];
  if (fx)
    columns.push(
      "USD/KRW",
      "종가(KRW)",
      "종가(USD)",
      "수익률 원화 기준(%)",
      "수익률 달러 기준(%)",
      "환율 출처·기준 시각",
    );
  columns.push("출처", "기준 시각");
  const rows: TableData["rows"] = [];
  const all = computed
    .flatMap(({ s, rows: cs }) => cs.map((c) => ({ s, c })))
    .sort((a, b) => a.c.date.localeCompare(b.c.date) || ds.symbols.indexOf(a.s) - ds.symbols.indexOf(b.s));
  for (const { s, c } of all) {
    const r = c.row;
    const cells: (string | number | null)[] = [
      c.date,
      s.symbol,
      s.market,
      s.currency,
      r.open,
      r.high,
      r.low,
      r.close,
      c.ret[s.currency] ?? null,
    ];
    if (fx)
      cells.push(
        c.fx?.close ?? null,
        c.close.KRW ?? null,
        c.close.USD ?? null,
        c.ret.KRW ?? null,
        c.ret.USD ?? null,
        c.fx?.meta.label ?? null,
      );
    cells.push(r.meta.source, whenOf(r.meta));
    rows.push(cells);
  }

  // ---- chart: the same computed values, by basis
  const labels = [...new Set(all.map((x) => x.c.date))].sort();
  const seriesFor = (basis: string | undefined): ChartSeries[] =>
    computed.map(({ s, rows: cs }) => {
      const b = basis ?? s.currency;
      const byDate = new Map(cs.map((c) => [c.date, c]));
      const pick = (c: Computed | undefined) =>
        c ? (ds.kind === "compare" ? (c.ret[b] ?? null) : (c.close[b] ?? null)) : null;
      return {
        name: s.symbol,
        values: labels.map((d) => pick(byDate.get(d))),
        ...(ds.kind === "candle" ? { ohlc: labels.map((d) => byDate.get(d)?.ohlc[b] ?? null) } : {}),
      };
    });
  const unitOf = (basis: string | undefined) =>
    ds.kind === "compare" ? "%" : (basis ?? [...new Set(ds.symbols.map((s) => s.currency))].join("/"));
  const yLabelOf = (basis: string | undefined) =>
    ds.kind === "compare"
      ? `수익률 (%)${basis ? ` · ${CURRENCY_LABEL[basis as Currency]}` : ""}`
      : `가격 (${unitOf(basis)})`;
  const first = ds.currency;
  const other = first ? (first === "KRW" ? "USD" : "KRW") : undefined;
  const views: ChartView[] = other
    ? [
        {
          label: CURRENCY_LABEL[other],
          yLabel: yLabelOf(other),
          unit: unitOf(other),
          series: seriesFor(other),
        },
      ]
    : [];
  const sources = ds.symbols.map((s) => {
    const a = s.rows[0]!.meta;
    const z = s.rows.at(-1)!.meta;
    return `${s.symbol}: ${z.source} · ${a.asOf.slice(0, 10)} ~ ${whenOf(z)}`;
  });
  const notes: string[] = [];
  if (ds.fx) {
    const last = ds.fx.at(-1)!;
    notes.push(
      `환율: ${last.meta.source} USD/KRW 일별 종가 — 각 날짜의 종가를 그날(현지 날짜) 이하의 가장 최근 환율로 환산. 최근 환율 ${last.close} (${whenOf(last.meta)})`,
    );
  }
  if (ds.kind === "compare") notes.push("수익률은 기간 첫 거래일 종가 대비(%)");
  if (
    ds.kind === "candle" &&
    seriesFor(first).some((x) => x.ohlc?.some((q, i) => q === null && x.values[i] !== null))
  )
    notes.push("시가·고가·저가가 없는 날은 캔들 없이 종가만 있어요(툴팁에 표시).");
  const spec: ChartSpec = {
    type: ds.kind === "candle" ? "candle" : "line",
    title: chartTitle,
    xLabel: "날짜",
    yLabel: yLabelOf(first),
    unit: unitOf(first),
    labels,
    series: seriesFor(first),
    ...(views.length ? { seriesLabel: CURRENCY_LABEL[first!], views } : {}),
    sources,
    ...(notes.length ? { notes } : {}),
  };

  // ---- summary for the model: stamped first/last closes and returns (the checker reads these stamps)
  const items = computed.map(({ s, rows: cs }) => {
    const a = cs[0]!;
    const z = cs.at(-1)!;
    const st = stampOf(z.row.meta);
    return {
      symbol: s.symbol,
      market: s.market,
      currency: s.currency,
      firstDate: a.date,
      lastDate: z.date,
      firstClose: val(a.row.close, stampOf(a.row.meta), s.currency),
      lastClose: val(z.row.close, st, s.currency),
      returnPercent: val(z.ret[s.currency] ?? null, st, "%"),
      ...(fx
        ? {
            lastCloseKrw: val(z.close.KRW ?? null, st, "KRW"),
            lastCloseUsd: val(z.close.USD ?? null, st, "USD"),
            returnPercentKrw: val(z.ret.KRW ?? null, st, "%"),
            returnPercentUsd: val(z.ret.USD ?? null, st, "%"),
          }
        : {}),
    };
  });
  const lastFx = ds.fx?.at(-1);
  const summary = {
    chart: ds.kind,
    range: ds.range,
    ...(ds.currency ? { currency: ds.currency } : {}),
    items,
    ...(lastFx
      ? { fx: { pair: "USD/KRW", latest: val(lastFx.close, stampOf(lastFx.meta), "KRW per USD") } }
      : {}),
  };
  return {
    table: { title: `${names} ${span} 가격 표`, data: { columns, rows } },
    chart: { title: chartTitle, spec },
    summary,
  };
}

function buildFinancials(ds: Extract<FinanceDataset, { kind: "financials" }>, titleHint?: string) {
  const names = ds.symbols.map((s) => s.symbol).join(", ");
  const label = METRIC_LABEL[ds.metric];
  const per = ds.period === "annual" ? "연간" : "분기";
  const title = titleHint ?? `${names} ${per} ${label}`;
  const columns = ["회계 기간", "종목", "항목", "값", "통화", "출처", "기준 시각"];
  const all = ds.symbols
    .flatMap((s) => s.rows.map((r) => ({ s, r })))
    .sort(
      (a, b) => a.r.period.localeCompare(b.r.period) || ds.symbols.indexOf(a.s) - ds.symbols.indexOf(b.s),
    );
  const rows: TableData["rows"] = all.map(({ s, r }) => [
    r.period,
    s.symbol,
    label,
    r.value,
    s.currency,
    r.meta.source,
    whenOf(r.meta),
  ]);
  const labels = [...new Set(all.map((x) => x.r.period))].sort();
  const unit = [...new Set(ds.symbols.map((s) => s.currency))].join("/");
  const spec: ChartSpec = {
    type: "bar",
    title,
    xLabel: "회계 기간",
    yLabel: `${label} (${unit})`,
    unit,
    labels,
    series: ds.symbols.map((s) => {
      const by = new Map(s.rows.map((r) => [r.period, r.value]));
      return { name: s.symbol, values: labels.map((p) => by.get(p) ?? null) };
    }),
    sources: ds.symbols.map((s) => `${s.symbol}: ${s.rows.at(-1)!.meta.source} · 보고치 (${per})`),
  };
  const summary = {
    chart: ds.kind,
    metric: ds.metric,
    period: ds.period,
    items: ds.symbols.map((s) => ({
      symbol: s.symbol,
      currency: s.currency,
      periods: s.rows.map((r) => ({ period: r.period, value: val(r.value, stampOf(r.meta), s.currency) })),
    })),
  };
  return { table: { title: `${title} 표`, data: { columns, rows } }, chart: { title, spec }, summary };
}
