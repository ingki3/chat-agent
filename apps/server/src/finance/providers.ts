import { frameExternal } from "@agentlee/shared";
import type { RawResponse, RawStep } from "../web/service.js";
import { localDate, previousTradingDay, SESSIONS, zonedInstant } from "./calendar.js";
import {
  dateStamp,
  dayStamp,
  filingStamp,
  marketStamp,
  num,
  round,
  txt,
  val,
  rowMeta,
  type Stamp,
} from "./records.js";

/**
 * What each finance tool asks for and how it reads the answer (#30). `plan` turns the validated input into exact
 * URLs (only of the tool's own hosts — the service checks again, the proxy refuses anything else); `parse` turns
 * the response bodies into data whose numbers are stamped (records.ts). A tool may need a second round (SEC: the
 * ticker's CIK first). Pure functions of (input, responses, now): the snapshot tests replay recorded or synthetic
 * responses (apps/server/test/fixtures/finance).
 */

export type FinanceCode =
  | "finance_bad_input"
  | "finance_not_allowed"
  | "finance_unconfigured"
  | "finance_unavailable"
  | "finance_blocked"
  | "finance_unreachable"
  | "finance_timeout"
  | "finance_http_error"
  | "finance_rate_limited"
  | "finance_not_found"
  | "finance_bad_response"
  | "finance_busy"
  | "finance_failed";

export type FinanceCtx = {
  now: number;
  /** OPENDART_API_KEY, SEC_USER_AGENT (from `.env`, SKILL_SECRET_NAMES). */
  secrets: Readonly<Record<string, string>>;
};
export type Plan = { steps: RawStep[] } | { refuse: FinanceCode };
export type Parsed =
  { ok: true; data: Record<string, unknown> } | { ok: false; code: FinanceCode } | { next: Plan };
export type ToolImpl = {
  plan(input: Record<string, unknown>, ctx: FinanceCtx): Plan;
  /** `rounds[i]` are the responses of round i, in step order (cookie / capture steps return none). */
  parse(rounds: RawResponse[][], input: Record<string, unknown>, ctx: FinanceCtx): Parsed;
};

const fail = (code: FinanceCode): Parsed => ({ ok: false, code });

/** The JSON body of a 200 answer, or the code for what went wrong. */
function json(r: RawResponse | undefined): { ok: true; v: unknown } | { ok: false; code: FinanceCode } {
  if (!r) return { ok: false, code: "finance_bad_response" };
  if (r.status === 404) return { ok: false, code: "finance_not_found" };
  if (r.status === 429) return { ok: false, code: "finance_rate_limited" };
  if (r.status !== 200) return { ok: false, code: "finance_http_error" };
  try {
    return { ok: true, v: JSON.parse(r.body) as unknown };
  } catch {
    return { ok: false, code: "finance_bad_response" };
  }
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined;
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const ms = (s: unknown): number | undefined => {
  if (typeof s !== "string") return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : undefined;
};
const sec = (v: unknown): number | undefined => {
  const n = num(v);
  return n === null ? undefined : n * 1000;
};

// ---- Naver 증권 (kr-stock-skill's source) -------------------------------------------------------------------

const NAVER = "네이버 증권";
const NAVER_API = "https://m.stock.naver.com/api";

/** Signed change: Naver gives the size and the direction separately on the basic API (signed on history rows). */
function signed(size: number | null, direction: unknown): number | null {
  if (size === null) return null;
  const d = typeof direction === "string" ? direction : "";
  if (d === "FALLING" || d === "LOWER_LIMIT") return -Math.abs(size);
  if (d === "RISING" || d === "UPPER_LIMIT") return Math.abs(size);
  return size;
}

function naverBasic(
  r: RawResponse | undefined,
  ctx: FinanceCtx,
  want: "stock" | "etf" | "index",
  code: string,
): Parsed {
  const j = json(r);
  if (!j.ok) return fail(j.code);
  const b = obj(j.v);
  if (!b || num(b.closePrice) === null) return fail("finance_not_found");
  const end = b.stockEndType;
  if (want === "index" ? end !== "index" : want === "etf" ? end !== "etf" : end !== "stock" && end !== "etf")
    return fail("finance_not_found");
  const ex = obj(b.stockExchangeType);
  const delay = typeof ex?.delayTime === "number" ? ex.delayTime : undefined;
  const stamp = marketStamp({
    market: "KRX",
    t: ms(b.localTradedAt),
    now: ctx.now,
    source: NAVER,
    delayMinutes: delay,
    closed: b.marketStatus === "CLOSE",
  });
  const dir = obj(b.compareToPreviousPrice)?.name;
  const unit = want === "index" ? "pt" : "KRW";
  const pct = num(b.fluctuationsRatio);
  return {
    ok: true,
    data: {
      market: "KRX",
      code: txt(b.itemCode, 12) ?? code,
      name: txt(b.stockName, 60) ?? null,
      exchange: txt(b.stockExchangeName, 20) ?? txt(ex?.name, 20) ?? null,
      type: end,
      currency: want === "index" ? null : "KRW",
      price: val(num(b.closePrice), stamp, unit),
      change: val(signed(num(b.compareToPreviousClosePrice), dir), stamp, unit),
      changePercent: val(signed(pct, dir), stamp, "%"),
      tradingDay: stamp.tradingDay ?? null,
      url: `https://m.stock.naver.com/domestic/${want === "index" ? "index" : "stock"}/${encodeURIComponent(code)}/total`,
    },
  };
}

const krQuote = (want: "stock" | "etf"): ToolImpl => ({
  plan: (i) => ({ steps: [{ url: `${NAVER_API}/stock/${String(i.code)}/basic` }] }),
  parse: (rounds, i, ctx) => naverBasic(rounds[0]?.[0], ctx, want, String(i.code)),
});

const krIndex: ToolImpl = {
  plan: (i) => ({ steps: [{ url: `${NAVER_API}/index/${String(i.index)}/basic` }] }),
  parse: (rounds, i, ctx) => naverBasic(rounds[0]?.[0], ctx, "index", String(i.index)),
};

const krHistory: ToolImpl = {
  plan: (i) => ({
    steps: [{ url: `${NAVER_API}/stock/${String(i.code)}/price?pageSize=${Number(i.days ?? 20)}&page=1` }],
  }),
  parse: (rounds, i, ctx) => {
    const j = json(rounds[0]?.[0]);
    if (!j.ok) return fail(j.code);
    if (!Array.isArray(j.v)) return fail("finance_bad_response");
    if (!j.v.length) return fail("finance_not_found");
    const rows = j.v.slice(0, Number(i.days ?? 20)).flatMap((x) => {
      const o = obj(x);
      const day = typeof o?.localTradedAt === "string" ? o.localTradedAt.slice(0, 10) : "";
      if (!o || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return [];
      const s = dayStamp({ market: "KRX", day, now: ctx.now, source: NAVER });
      const meta = rowMeta(s);
      return [
        {
          date: day,
          open: num(o.openPrice),
          high: num(o.highPrice),
          low: num(o.lowPrice),
          close: num(o.closePrice),
          change: num(o.compareToPreviousClosePrice),
          changePercent: num(o.fluctuationsRatio),
          volume: num(o.accumulatedTradingVolume),
          ...meta,
        },
      ];
    });
    return { ok: true, data: { market: "KRX", code: String(i.code), currency: "KRW", unit: "KRW", rows } };
  },
};

const krSearch: ToolImpl = {
  plan: (i) => ({
    steps: [
      {
        url: `https://ac.stock.naver.com/ac?q=${encodeURIComponent(String(i.query))}&target=stock`,
      },
    ],
  }),
  parse: (rounds) => {
    const j = json(rounds[0]?.[0]);
    if (!j.ok) return fail(j.code);
    const items = arr(obj(j.v)?.items)
      .flatMap((x) => {
        const o = obj(x);
        const code = txt(o?.code, 12);
        if (!o || !code || !/^\d{6}$/.test(code) || o.nationCode !== "KOR") return [];
        return [
          {
            code,
            name: txt(o.name, 60) ?? null,
            market: txt(o.typeCode, 12) ?? null,
            category: txt(o.category, 12) ?? null,
          },
        ];
      })
      .slice(0, 10);
    return { ok: true, data: { items } };
  },
};

// ---- Yahoo Finance (us-stock-skill's source: yfinance) --------------------------------------------------------

const YAHOO = "Yahoo Finance";
const Q1 = "https://query1.finance.yahoo.com";
const enc = encodeURIComponent;
/** The session steps quoteSummary / timeseries / screener need: cookie, then crumb (`{crumb}` in the URL). */
const SESSION: RawStep[] = [
  { url: "https://fc.yahoo.com/", mode: "cookie" },
  { url: `${Q1}/v1/test/getcrumb`, mode: "capture", capture: "crumb" },
];

type Chart = {
  meta: Obj;
  timestamps: number[];
  quote: { open: unknown[]; high: unknown[]; low: unknown[]; close: unknown[]; volume: unknown[] };
};

function chartOf(r: RawResponse | undefined): { ok: true; c: Chart } | { ok: false; code: FinanceCode } {
  const j = json(r);
  if (!j.ok) return j;
  const chart = obj(obj(j.v)?.chart);
  if (chart?.error) return { ok: false, code: "finance_not_found" };
  const res = obj(arr(chart?.result)[0]);
  const meta = obj(res?.meta);
  if (!res || !meta || num(meta.regularMarketPrice) === null) return { ok: false, code: "finance_not_found" };
  const q = obj(arr(obj(res.indicators)?.quote)[0]) ?? {};
  return {
    ok: true,
    c: {
      meta,
      timestamps: arr(res.timestamp).map((t) => Number(t) * 1000),
      quote: {
        open: arr(q.open),
        high: arr(q.high),
        low: arr(q.low),
        close: arr(q.close),
        volume: arr(q.volume),
      },
    },
  };
}

/** The close before the session `day` (from the daily bars), or the chart's previous close. */
function previousClose(c: Chart, market: "US" | "FX", day: string | undefined): number | null {
  const tz = market === "US" ? SESSIONS.US.timeZone : "UTC";
  for (let i = c.timestamps.length - 1; i >= 0; i--) {
    const d = localDate(c.timestamps[i]!, tz);
    const close = num(c.quote.close[i]);
    if (close === null) continue;
    if (day === undefined ? i < c.timestamps.length - 1 : d < day) return close;
  }
  return num(c.meta.previousClose) ?? num(c.meta.chartPreviousClose);
}

function quoteData(c: Chart, ctx: FinanceCtx, unit: string, symbol: string) {
  const m = c.meta;
  const stamp = marketStamp({ market: "US", t: sec(m.regularMarketTime), now: ctx.now, source: YAHOO });
  const price = num(m.regularMarketPrice);
  const prev = previousClose(c, "US", stamp.tradingDay);
  const change = price !== null && prev !== null ? round(price - prev) : null;
  const pct = change !== null && prev ? round((change / prev) * 100, 3) : num(m.regularMarketChangePercent);
  return {
    market: "US",
    symbol: txt(m.symbol, 12) ?? symbol,
    name: txt(m.longName, 80) ?? txt(m.shortName, 80) ?? null,
    exchange: txt(m.fullExchangeName, 30) ?? txt(m.exchangeName, 30) ?? null,
    currency: txt(m.currency, 6) ?? null,
    price: val(price, stamp, unit),
    previousClose: val(prev, stamp, unit),
    change: val(change, stamp, unit),
    changePercent: val(pct, stamp, "%"),
    dayHigh: val(num(m.regularMarketDayHigh), stamp, unit),
    dayLow: val(num(m.regularMarketDayLow), stamp, unit),
    volume: val(num(m.regularMarketVolume), stamp, unit === "pt" ? undefined : "shares"),
    fiftyTwoWeekHigh: val(num(m.fiftyTwoWeekHigh), stamp, unit),
    fiftyTwoWeekLow: val(num(m.fiftyTwoWeekLow), stamp, unit),
    tradingDay: stamp.tradingDay ?? null,
  };
}

const chartUrl = (symbol: string, range: string, interval: string) =>
  `${Q1}/v8/finance/chart/${enc(symbol)}?range=${range}&interval=${interval}&includePrePost=false`;

const usQuote: ToolImpl = {
  plan: (i) => ({ steps: [{ url: chartUrl(String(i.symbol), "5d", "1d") }] }),
  parse: (rounds, i, ctx) => {
    const c = chartOf(rounds[0]?.[0]);
    if (!c.ok) return fail(c.code);
    const unit = txt(c.c.meta.currency, 6) ?? "USD";
    return { ok: true, data: quoteData(c.c, ctx, unit, String(i.symbol)) };
  },
};

export const US_INDEX_SYMBOLS: Record<string, string> = {
  SP500: "^GSPC",
  NASDAQ: "^IXIC",
  DOW: "^DJI",
  RUSSELL2000: "^RUT",
  VIX: "^VIX",
};

const usIndex: ToolImpl = {
  plan: (i) => ({ steps: [{ url: chartUrl(US_INDEX_SYMBOLS[String(i.index)]!, "5d", "1d") }] }),
  parse: (rounds, i, ctx) => {
    const c = chartOf(rounds[0]?.[0]);
    if (!c.ok) return fail(c.code);
    const data: Record<string, unknown> = quoteData(c.c, ctx, "pt", US_INDEX_SYMBOLS[String(i.index)]!);
    delete data.currency;
    return { ok: true, data: { index: String(i.index), ...data } };
  },
};

const fxUsdKrw: ToolImpl = {
  plan: () => ({ steps: [{ url: chartUrl("KRW=X", "5d", "1d") }] }),
  parse: (rounds, _i, ctx) => {
    const c = chartOf(rounds[0]?.[0]);
    if (!c.ok) return fail(c.code);
    const m = c.c.meta;
    const stamp = marketStamp({ market: "FX", t: sec(m.regularMarketTime), now: ctx.now, source: YAHOO });
    const rate = num(m.regularMarketPrice);
    const prev = previousClose(c.c, "FX", undefined);
    const change = rate !== null && prev !== null ? round(rate - prev) : null;
    return {
      ok: true,
      data: {
        pair: "USD/KRW",
        rate: val(rate, stamp, "KRW per USD"),
        previous: val(prev, stamp, "KRW per USD"),
        change: val(change, stamp, "KRW"),
        changePercent: val(change !== null && prev ? round((change / prev) * 100, 3) : null, stamp, "%"),
        use: "한·미 주식 비교와 원화 환산에만 쓴다 (PRD FR-7.3).",
      },
    };
  },
};

const HISTORY_ROWS = 260;

const usHistory: ToolImpl = {
  plan: (i) => ({
    steps: [{ url: chartUrl(String(i.symbol), String(i.range ?? "3mo"), String(i.interval ?? "1d")) }],
  }),
  parse: (rounds, i, ctx) => {
    const c = chartOf(rounds[0]?.[0]);
    if (!c.ok) return fail(c.code);
    const { meta, timestamps, quote } = c.c;
    const tz = SESSIONS.US.timeZone;
    const interval = String(i.interval ?? "1d");
    const last = sec(meta.regularMarketTime);
    const rows: Obj[] = [];
    for (let k = timestamps.length - 1; k >= 0 && rows.length < HISTORY_ROWS; k--) {
      const close = num(quote.close[k]);
      if (close === null) continue;
      const start = localDate(timestamps[k]!, tz);
      let stamp: Stamp;
      if (interval === "1d")
        stamp = dayStamp({
          market: "US",
          day: start,
          now: ctx.now,
          source: YAHOO,
          ...(last ? { liveAt: last } : {}),
        });
      else if (k === timestamps.length - 1)
        // The running week / month ends with the latest value.
        stamp = marketStamp({ market: "US", t: last, now: ctx.now, source: YAHOO });
      else {
        // A finished week / month closes on the trading day before the next period starts.
        const next = localDate(timestamps[k + 1]!, tz);
        stamp = dayStamp({ market: "US", day: previousTradingDay("US", next), now: ctx.now, source: YAHOO });
      }
      const m = rowMeta(stamp);
      rows.push({
        date: start,
        open: round(num(quote.open[k])),
        high: round(num(quote.high[k])),
        low: round(num(quote.low[k])),
        close: round(close),
        volume: num(quote.volume[k]),
        ...m,
      });
    }
    return {
      ok: true,
      data: {
        market: "US",
        symbol: txt(meta.symbol, 12) ?? String(i.symbol),
        currency: txt(meta.currency, 6) ?? null,
        interval,
        rows,
        ...(timestamps.length > HISTORY_ROWS ? { truncated: true } : {}),
      },
    };
  },
};

// Technical indicators, computed here from the daily closes (oldest first).
const sma = (xs: number[], n: number) =>
  xs.length >= n ? xs.slice(-n).reduce((a, b) => a + b, 0) / n : null;
function emaSeries(xs: number[], n: number): number[] {
  const k = 2 / (n + 1);
  const out: number[] = [];
  xs.forEach((x, idx) => out.push(idx === 0 ? x : x * k + out[idx - 1]! * (1 - k)));
  return out;
}
/** Wilder's RSI. */
function rsi(xs: number[], n = 14): number | null {
  if (xs.length <= n) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = xs[i]! - xs[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  for (let i = n + 1; i < xs.length; i++) {
    const d = xs[i]! - xs[i - 1]!;
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
  }
  if (loss === 0) return 100;
  return 100 - 100 / (1 + gain / loss);
}

const usTechnicals: ToolImpl = {
  plan: (i) => ({ steps: [{ url: chartUrl(String(i.symbol), "1y", "1d") }] }),
  parse: (rounds, i, ctx) => {
    const c = chartOf(rounds[0]?.[0]);
    if (!c.ok) return fail(c.code);
    const closes = c.c.quote.close.map(num).filter((x): x is number => x !== null);
    if (closes.length < 30) return fail("finance_not_found");
    const quote = marketStamp({
      market: "US",
      t: sec(c.c.meta.regularMarketTime),
      now: ctx.now,
      source: YAHOO,
    });
    const computed: Stamp = { ...quote, source: `${YAHOO} (Agent Lee 계산)`, kind: "computed" };
    const e12 = emaSeries(closes, 12);
    const e26 = emaSeries(closes, 26);
    const macdLine = closes.map((_, k) => e12[k]! - e26[k]!);
    const signal = emaSeries(macdLine, 9);
    const unit = txt(c.c.meta.currency, 6) ?? "USD";
    return {
      ok: true,
      data: {
        market: "US",
        symbol: txt(c.c.meta.symbol, 12) ?? String(i.symbol),
        price: val(num(c.c.meta.regularMarketPrice), quote, unit),
        sma20: val(round(sma(closes, 20)), computed, unit),
        sma50: val(round(sma(closes, 50)), computed, unit),
        sma200: val(round(sma(closes, 200)), computed, unit),
        rsi14: val(round(rsi(closes), 2), computed),
        macd: val(round(macdLine.at(-1) ?? null), computed),
        macdSignal: val(round(signal.at(-1) ?? null), computed),
        macdHistogram: val(round((macdLine.at(-1) ?? 0) - (signal.at(-1) ?? 0)), computed),
        bars: closes.length,
        tradingDay: quote.tradingDay ?? null,
      },
    };
  },
};

/** quoteSummary with the session steps; the result's first module object. */
function summaryPlan(symbol: string, modules: string[]): Plan {
  return {
    steps: [
      ...SESSION,
      { url: `${Q1}/v10/finance/quoteSummary/${enc(symbol)}?modules=${modules.join(",")}&crumb={crumb}` },
    ],
  };
}
function summaryOf(r: RawResponse | undefined): { ok: true; s: Obj } | { ok: false; code: FinanceCode } {
  const j = json(r);
  if (!j.ok) return j;
  const qs = obj(obj(j.v)?.quoteSummary);
  const s = obj(arr(qs?.result)[0]);
  if (!s) return { ok: false, code: "finance_not_found" };
  return { ok: true, s };
}
/** The price module's stamp (regularMarketTime) — what price-based figures are as of. */
/**
 * Yahoo's `marketState` outside the regular session (pre-market, after-hours, closed): the regular-market price it
 * gives is then that session's close.
 */
const yahooClosed = (state: unknown) =>
  typeof state === "string" && ["PRE", "PREPRE", "POST", "POSTPOST", "CLOSED"].includes(state);

function priceStamp(s: Obj, ctx: FinanceCtx): { stamp: Stamp; price: Obj } {
  const price = obj(s.price) ?? {};
  return {
    price,
    stamp: marketStamp({
      market: "US",
      t: sec(price.regularMarketTime),
      now: ctx.now,
      source: YAHOO,
      closed: yahooClosed(price.marketState),
    }),
  };
}
const today = (ctx: FinanceCtx) => localDate(ctx.now, SESSIONS.US.timeZone);
const ymdOf = (v: unknown): string | undefined => {
  const t = sec(v);
  return t === undefined ? undefined : new Date(t).toISOString().slice(0, 10);
};

const usCompany: ToolImpl = {
  plan: (i) => summaryPlan(String(i.symbol), ["assetProfile", "price"]),
  parse: (rounds, i, ctx) => {
    const r = summaryOf(rounds[0]?.[0]);
    if (!r.ok) return fail(r.code);
    const p = obj(r.s.assetProfile) ?? {};
    const { stamp, price } = priceStamp(r.s, ctx);
    const summary = txt(p.longBusinessSummary, 800);
    return {
      ok: true,
      data: {
        market: "US",
        symbol: txt(price.symbol, 12) ?? String(i.symbol),
        name: txt(price.longName, 80) ?? txt(price.shortName, 80) ?? null,
        sector: txt(p.sector, 60) ?? null,
        industry: txt(p.industry, 80) ?? null,
        country: txt(p.country, 60) ?? null,
        website: txt(p.website, 120) ?? null,
        employees: val(
          num(p.fullTimeEmployees),
          dateStamp(YAHOO, today(ctx), SESSIONS.US.timeZone, "reported"),
          "people",
        ),
        marketCap: val(num(price.marketCap), stamp, txt(price.currency, 6) ?? "USD"),
        // The company's own words, as Yahoo has them: data, not instructions.
        ...(summary ? { profile: frameExternal({ source: "yahoo:assetProfile", content: summary }) } : {}),
      },
    };
  },
};

const FIN_TYPES = ["TotalRevenue", "OperatingIncome", "NetIncome", "DilutedEPS", "FreeCashFlow"] as const;
const FIN_KEYS: Record<(typeof FIN_TYPES)[number], string> = {
  TotalRevenue: "revenue",
  OperatingIncome: "operatingIncome",
  NetIncome: "netIncome",
  DilutedEPS: "dilutedEps",
  FreeCashFlow: "freeCashFlow",
};

const usFinancials: ToolImpl = {
  plan: (i, ctx) => {
    const period = String(i.period ?? "annual");
    const back = period === "annual" ? 6 : 2;
    // Day precision: the URL (and a recording of it) is the same all day.
    const p2 = Math.floor(Date.parse(`${localDate(ctx.now, "UTC")}T00:00:00Z`) / 1000) + 86_400;
    const p1 = p2 - back * 366 * 86_400;
    const types = FIN_TYPES.map((t) => `${period}${t}`).join(",");
    const s = enc(String(i.symbol));
    return {
      steps: [
        ...SESSION,
        {
          url: `${Q1}/ws/fundamentals-timeseries/v1/finance/timeseries/${s}?symbol=${s}&type=${types}&period1=${p1}&period2=${p2}&crumb={crumb}`,
        },
      ],
    };
  },
  parse: (rounds, i) => {
    const j = json(rounds[0]?.[0]);
    if (!j.ok) return fail(j.code);
    const period = String(i.period ?? "annual");
    const byDate = new Map<string, Obj>();
    let currency: string | undefined;
    for (const series of arr(obj(obj(j.v)?.timeseries)?.result)) {
      const s = obj(series);
      const type = String(arr(obj(s?.meta)?.type)[0] ?? "");
      const base = type.replace(/^(annual|quarterly)/, "") as (typeof FIN_TYPES)[number];
      const key = FIN_KEYS[base];
      if (!s || !key) continue;
      for (const pt of arr(s[type])) {
        const o = obj(pt);
        const d = typeof o?.asOfDate === "string" ? o.asOfDate : "";
        if (!o || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
        currency ??= txt(o.currencyCode, 6);
        const row = byDate.get(d) ?? { period: d, periodType: txt(o.periodType, 6) ?? null };
        row[key] = num(obj(o.reportedValue)?.raw ?? null);
        byDate.set(d, row);
      }
    }
    if (!byDate.size) return fail("finance_not_found");
    const rows = [...byDate.values()]
      .sort((a, b) => String(b.period).localeCompare(String(a.period)))
      .map((row) => {
        const m = rowMeta(dateStamp(YAHOO, String(row.period), SESSIONS.US.timeZone, "reported"));
        return { ...row, ...m };
      });
    return {
      ok: true,
      data: { market: "US", symbol: String(i.symbol), period, currency: currency ?? null, rows },
    };
  },
};

const usEarnings: ToolImpl = {
  plan: (i) => summaryPlan(String(i.symbol), ["earningsHistory", "calendarEvents", "price"]),
  parse: (rounds, i, ctx) => {
    const r = summaryOf(rounds[0]?.[0]);
    if (!r.ok) return fail(r.code);
    const tz = SESSIONS.US.timeZone;
    const history = arr(obj(r.s.earningsHistory)?.history).flatMap((x) => {
      const o = obj(x);
      const q = ymdOf(obj(o?.quarter)?.raw);
      if (!o || !q) return [];
      const m = rowMeta(dateStamp(YAHOO, q, tz, "reported"));
      const surprise = num(o.surprisePercent);
      return [
        {
          quarterEnd: q,
          epsActual: num(o.epsActual),
          epsEstimate: num(o.epsEstimate),
          surprisePercent: surprise === null ? null : round(surprise * 100, 2),
          ...m,
        },
      ];
    });
    const e = obj(obj(r.s.calendarEvents)?.earnings) ?? {};
    const next = ymdOf(obj(arr(e.earningsDate)[0])?.raw);
    const est = dateStamp(`${YAHOO} 컨센서스`, today(ctx), tz, "estimate");
    const { price } = priceStamp(r.s, ctx);
    const cur = txt(price.currency, 6) ?? "USD";
    return {
      ok: true,
      data: {
        market: "US",
        symbol: txt(price.symbol, 12) ?? String(i.symbol),
        history: history.reverse(),
        nextEarningsDate: next ?? null,
        nextEarningsDateIsEstimate: e.isEarningsDateEstimate === true,
        nextEpsEstimate: val(num(e.earningsAverage), est, cur),
        nextEpsLow: val(num(e.earningsLow), est, cur),
        nextEpsHigh: val(num(e.earningsHigh), est, cur),
        nextRevenueEstimate: val(num(e.revenueAverage), est, cur),
      },
    };
  },
};

const usValuation: ToolImpl = {
  plan: (i) => summaryPlan(String(i.symbol), ["summaryDetail", "defaultKeyStatistics", "price"]),
  parse: (rounds, i, ctx) => {
    const r = summaryOf(rounds[0]?.[0]);
    if (!r.ok) return fail(r.code);
    const sd = obj(r.s.summaryDetail) ?? {};
    const ks = obj(r.s.defaultKeyStatistics) ?? {};
    const { stamp, price } = priceStamp(r.s, ctx);
    const cur = txt(price.currency, 6) ?? "USD";
    const pct = (v: unknown) => {
      const n = num(v);
      return n === null ? null : round(n * 100, 3);
    };
    return {
      ok: true,
      data: {
        market: "US",
        symbol: txt(price.symbol, 12) ?? String(i.symbol),
        price: val(num(price.regularMarketPrice), stamp, cur),
        marketCap: val(num(price.marketCap) ?? num(sd.marketCap), stamp, cur),
        trailingPE: val(num(sd.trailingPE), stamp, "x"),
        forwardPE: val(num(sd.forwardPE) ?? num(ks.forwardPE), stamp, "x"),
        priceToBook: val(num(ks.priceToBook), stamp, "x"),
        priceToSales: val(num(sd.priceToSalesTrailing12Months), stamp, "x"),
        evToEbitda: val(num(ks.enterpriseToEbitda), stamp, "x"),
        dividendYield: val(pct(sd.dividendYield), stamp, "%"),
        beta: val(num(sd.beta) ?? num(ks.beta), stamp),
        tradingDay: stamp.tradingDay ?? null,
      },
    };
  },
};

const usScreener: ToolImpl = {
  plan: (i) => ({
    steps: [
      ...SESSION,
      {
        url: `${Q1}/v1/finance/screener/predefined/saved?scrIds=${String(i.screen)}&count=${Number(i.count ?? 10)}&crumb={crumb}`,
      },
    ],
  }),
  parse: (rounds, i, ctx) => {
    const j = json(rounds[0]?.[0]);
    if (!j.ok) return fail(j.code);
    const res = obj(arr(obj(obj(j.v)?.finance)?.result)[0]);
    if (!res) return fail("finance_not_found");
    const rows = arr(res.quotes)
      .slice(0, Number(i.count ?? 10))
      .flatMap((x) => {
        const o = obj(x);
        const symbol = txt(o?.symbol, 12);
        if (!o || !symbol) return [];
        const delay = num(o.exchangeDataDelayedBy);
        const s = marketStamp({
          market: "US",
          t: sec(o.regularMarketTime),
          now: ctx.now,
          source: YAHOO,
          delayMinutes: delay ?? undefined,
          closed: yahooClosed(o.marketState),
        });
        const m = rowMeta(s);
        return [
          {
            symbol,
            name: txt(o.shortName, 80) ?? null,
            price: num(o.regularMarketPrice),
            changePercent: round(num(o.regularMarketChangePercent), 3),
            marketCap: num(o.marketCap),
            currency: txt(o.currency, 6) ?? null,
            ...m,
          },
        ];
      });
    return { ok: true, data: { screen: String(i.screen), title: txt(res.title, 60) ?? null, rows } };
  },
};

// ---- OpenDART (dart-investment-monitor's source) ------------------------------------------------------------

const DART = "OpenDART";
export const DART_KEY = "OPENDART_API_KEY";
const ymdCompact = (ymd: string) => ymd.replace(/-/g, "");
const addDays = (ymd: string, n: number) => {
  const t = Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
};

/** DART answers 200 with its own status: 000 ok, 013 nothing found, 010/011/012/901 key problems, 020 over limit. */
const DART_STATUS: Record<string, FinanceCode> = {
  "010": "finance_unconfigured",
  "011": "finance_unconfigured",
  "012": "finance_unconfigured",
  "901": "finance_unconfigured",
  "020": "finance_rate_limited",
  "100": "finance_bad_input",
  "101": "finance_bad_input",
};

const dartDisclosures: ToolImpl = {
  plan: (i, ctx) => {
    const key = ctx.secrets[DART_KEY];
    if (!key) return { refuse: "finance_unconfigured" };
    const end = localDate(ctx.now, "Asia/Seoul");
    const begin = addDays(end, -(Number(i.days ?? 7) - 1));
    const q = new URLSearchParams({
      crtfc_key: key,
      bgn_de: ymdCompact(begin),
      end_de: ymdCompact(end),
      page_no: "1",
      page_count: String(Number(i.count ?? 20)),
      ...(i.corpCode ? { corp_code: String(i.corpCode) } : {}),
      ...(i.type ? { pblntf_ty: String(i.type) } : {}),
    });
    return { steps: [{ url: `https://opendart.fss.or.kr/api/list.json?${q.toString()}` }] };
  },
  parse: (rounds) => {
    const j = json(rounds[0]?.[0]);
    if (!j.ok) return fail(j.code);
    const o = obj(j.v);
    const status = typeof o?.status === "string" ? o.status : "";
    if (status === "013")
      return {
        ok: true,
        data: { items: [], content: frameExternal({ source: "dart:list", content: "(no filings)" }) },
      };
    if (status !== "000") return fail(DART_STATUS[status] ?? "finance_failed");
    const items: Obj[] = [];
    const lines: string[] = [];
    for (const x of arr(o?.list)) {
      const r = obj(x);
      const no = txt(r?.rcept_no, 14);
      const day = typeof r?.rcept_dt === "string" && /^\d{8}$/.test(r.rcept_dt) ? r.rcept_dt : "";
      if (!r || !no || !/^\d{14}$/.test(no) || !day) continue;
      const ymd = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
      const n = items.length + 1;
      const m = rowMeta(dateStamp(DART, ymd, "Asia/Seoul", "filing"));
      items.push({
        n,
        corpCode: txt(r.corp_code, 8) ?? null,
        stockCode: txt(r.stock_code, 6) || null,
        receiptNo: no,
        url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${no}`,
        ...m,
      });
      lines.push(
        `[${n}] ${txt(r.corp_name, 60) ?? "?"} · ${txt(r.report_nm, 160) ?? "?"} · 제출인 ${txt(r.flr_nm, 60) ?? "?"} · 접수 ${ymd}`,
      );
    }
    return {
      ok: true,
      data: {
        totalCount: num(o?.total_count),
        items,
        // Company names and report titles are the filers' words: data, never instructions.
        content: frameExternal({ source: "dart:list", content: lines.join("\n") || "(no filings)" }),
      },
    };
  },
};

// ---- SEC EDGAR (market-disclosure-monitor's source) ---------------------------------------------------------

const SEC = "SEC EDGAR";
export const SEC_UA = "SEC_USER_AGENT";
const SEC_FORMS: Record<string, readonly string[]> = {
  sec_8k: ["8-K", "8-K/A"],
  sec_form4: ["4", "4/A"],
  sec_13f: ["13F-HR", "13F-HR/A"],
};

function secHeaders(ctx: FinanceCtx): Record<string, string> | undefined {
  const ua = ctx.secrets[SEC_UA];
  // SEC requires a User-Agent naming the requester and a contact (https://www.sec.gov/os/accessing-edgar-data).
  return ua && /^[\x20-\x7e]{5,200}$/.test(ua) ? { "user-agent": ua } : undefined;
}
const submissionsStep = (cik: string, h: Record<string, string>): RawStep => ({
  url: `https://data.sec.gov/submissions/CIK${cik.padStart(10, "0")}.json`,
  headers: h,
});

/**
 * Acceptance times in the submissions API end in `Z` but are EDGAR's own clock, US Eastern (the filing index pages
 * show the same digits as "Accepted"): read as New York wall time.
 */
function edgarTime(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):(\d{2})/.exec(v);
  return m ? zonedInstant(m[1]!, m[2]!, "America/New_York") + Number(m[3]) * 1000 : undefined;
}

const secFilings = (tool: keyof typeof SEC_FORMS): ToolImpl => ({
  plan: (i, ctx) => {
    if ((i.ticker === undefined) === (i.cik === undefined)) return { refuse: "finance_bad_input" };
    const h = secHeaders(ctx);
    if (!h) return { refuse: "finance_unconfigured" };
    if (i.cik !== undefined) return { steps: [submissionsStep(String(i.cik), h)] };
    return { steps: [{ url: "https://www.sec.gov/files/company_tickers.json", headers: h }] };
  },
  parse: (rounds, i, ctx) => {
    // Round 1 with a ticker: find its CIK, then ask for the submissions.
    if (i.ticker !== undefined && rounds.length === 1) {
      const j = json(rounds[0]?.[0]);
      if (!j.ok) return fail(j.code);
      const want = String(i.ticker).toUpperCase();
      const hit = Object.values(obj(j.v) ?? {}).find((x) => obj(x)?.ticker === want);
      const cik = num(obj(hit)?.cik_str);
      if (cik === null) return fail("finance_not_found");
      return { next: { steps: [submissionsStep(String(Math.trunc(cik)), secHeaders(ctx)!)] } };
    }
    const j = json(rounds.at(-1)?.[0]);
    if (!j.ok) return fail(j.code);
    const d = obj(j.v);
    const recent = obj(obj(d?.filings)?.recent);
    if (!d || !recent) return fail("finance_not_found");
    const cik = String(Math.trunc(num(d.cik) ?? 0));
    const forms = new Set(SEC_FORMS[tool]);
    const col = (k: string) => arr(recent[k]);
    const items: Obj[] = [];
    const lines: string[] = [];
    const count = Number(i.count ?? 10);
    col("form").forEach((f, k) => {
      if (items.length >= count || typeof f !== "string" || !forms.has(f)) return;
      const acc = txt(col("accessionNumber")[k], 25);
      const doc = txt(col("primaryDocument")[k], 120);
      if (!acc || !/^\d{10}-\d{2}-\d{6}$/.test(acc)) return;
      const n = items.length + 1;
      const filedDay = txt(col("filingDate")[k], 10);
      const t = edgarTime(col("acceptanceDateTime")[k]);
      const stamp =
        t !== undefined
          ? filingStamp(SEC, t, "America/New_York")
          : filingStamp(SEC, filedDay ? Date.parse(`${filedDay}T12:00:00Z`) : undefined, "America/New_York");
      const folder = `https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, "")}`;
      const docOk = doc && /^[\w./-]+$/.test(doc) && !doc.includes("..");
      items.push({
        n,
        form: f,
        accessionNumber: acc,
        filingDate: filedDay ?? null,
        reportDate: txt(col("reportDate")[k], 10) || null,
        ...(tool === "sec_8k" ? { items: txt(col("items")[k], 60) ?? null } : {}),
        url: docOk ? `${folder}/${doc}` : `${folder}/`,
        ...stamp,
      });
      lines.push(
        `[${n}] ${f} · ${filedDay ?? "?"}${tool === "sec_8k" ? ` · items ${txt(col("items")[k], 60) ?? "-"}` : ""} · ${txt(col("primaryDocDescription")[k], 120) ?? ""}`.trim(),
      );
    });
    return {
      ok: true,
      data: {
        cik,
        company: txt(d.name, 80) ?? null,
        tickers: arr(d.tickers)
          .flatMap((x) => (txt(x, 12) ? [txt(x, 12)!] : []))
          .slice(0, 5),
        items,
        content: frameExternal({ source: "sec:submissions", content: lines.join("\n") || "(no filings)" }),
      },
    };
  },
});

export const TOOL_IMPLS: Readonly<Record<string, ToolImpl>> = {
  kr_quote: krQuote("stock"),
  kr_index: krIndex,
  kr_history: krHistory,
  kr_search: krSearch,
  kr_etf: krQuote("etf"),
  fx_usdkrw: fxUsdKrw,
  us_quote: usQuote,
  us_index: usIndex,
  us_company: usCompany,
  us_history: usHistory,
  us_financials: usFinancials,
  us_earnings: usEarnings,
  us_valuation: usValuation,
  us_technicals: usTechnicals,
  us_screener: usScreener,
  dart_disclosures: dartDisclosures,
  sec_8k: secFilings("sec_8k"),
  sec_form4: secFilings("sec_form4"),
  sec_13f: secFilings("sec_13f"),
};
