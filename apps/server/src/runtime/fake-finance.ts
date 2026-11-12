import type { FinanceWorker } from "../finance/service.js";
import { RAW_JOB_LIMITS, type RawResponse } from "../web/service.js";
import {
  closeInstant,
  FX_TIME_ZONE,
  isTradingDay,
  localDate,
  openInstant,
  zonedInstant,
} from "../finance/calendar.js";

/**
 * SYNTHETIC finance data for the FakeRuntime mode and tests (#31) — never real prices. The 6-month comparison
 * ("AAPL, 005930 6개월 비교 차트") needs daily histories of a US and a Korean stock and the USD/KRW daily closes;
 * until real recordings exist (they wait on the user's network run, docs/ops.md §19.5) this answers the finance
 * tools' own URLs (Yahoo chart API, Naver price pages and search) with deterministic random walks in the shapes of
 * the live APIs. `fixtureFinanceWorker` serves **only** these: any other URL fails as unreachable, so in the
 * FakeRuntime mode no synthetic number is ever mixed with a real one and nothing reaches the network.
 *
 * A series is the same whatever day it is asked: it walks from a fixed start (2025-01-02) one trading day at a time
 * with a PRNG seeded by the symbol, and ends at the latest session that has closed by `now`.
 */

type Series = { kind: "US" | "KRX" | "FX"; start: number; vol: number; drift: number; digits: number };
const SERIES: Record<string, Series> = {
  AAPL: { kind: "US", start: 190, vol: 0.016, drift: 0.0012, digits: 2 },
  NVDA: { kind: "US", start: 120, vol: 0.028, drift: 0.0016, digits: 2 },
  MSFT: { kind: "US", start: 410, vol: 0.013, drift: 0.0005, digits: 2 },
  "KRW=X": { kind: "FX", start: 1380, vol: 0.004, drift: 0.00008, digits: 2 },
  "005930": { kind: "KRX", start: 56000, vol: 0.018, drift: 0.0022, digits: -2 },
  "000660": { kind: "KRX", start: 170000, vol: 0.024, drift: 0.0018, digits: -2 },
};
/** Names the fake Naver search knows (code, name, market). */
const KR_NAMES: readonly [string, string, string][] = [
  ["005930", "삼성전자", "KOSPI"],
  ["005935", "삼성전자우", "KOSPI"],
  ["000660", "SK하이닉스", "KOSPI"],
];

const EPOCH = "2025-01-02";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const seedOf = (s: string) => [...s].reduce((h, c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261);
const addDays = (ymd: string, n: number) =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (ymd: string) => new Date(`${ymd}T00:00:00Z`).getUTCDay();
const r = (v: number, digits: number) =>
  digits >= 0 ? Number(v.toFixed(digits)) : Math.round(v / 10 ** -digits) * 10 ** -digits;

type Bar = { date: string; open: number; high: number; low: number; close: number; volume: number };

/** Whether `ymd` is a day of the series that has ended by `now`. */
function closedDay(s: Series, ymd: string, now: number): boolean {
  if (s.kind === "FX")
    return weekday(ymd) !== 0 && weekday(ymd) !== 6 && zonedInstant(ymd, "17:00", FX_TIME_ZONE) <= now;
  const m = s.kind === "US" ? "US" : "KRX";
  return isTradingDay(m, ymd) && closeInstant(m, ymd) <= now;
}

/** Every bar of a series from the start up to `now`, oldest first. */
export function fakeBars(symbol: string, now: number): Bar[] {
  const s = SERIES[symbol];
  if (!s) return [];
  const rand = mulberry32(seedOf(symbol));
  const out: Bar[] = [];
  const end = localDate(now, "UTC");
  let close = s.start;
  for (let d = EPOCH; d <= addDays(end, 1); d = addDays(d, 1)) {
    const tradingDay =
      s.kind === "FX"
        ? weekday(d) !== 0 && weekday(d) !== 6
        : isTradingDay(s.kind === "US" ? "US" : "KRX", d);
    if (!tradingDay) continue;
    // Four draws a day, whichever days are asked: a bar never depends on `now`.
    const [a, b, c, e] = [rand(), rand(), rand(), rand()];
    const open = close * (1 + (a - 0.5) * s.vol * 0.6);
    close = close * (1 + s.drift + (b - 0.5) * 2 * s.vol);
    const high = Math.max(open, close) * (1 + c * s.vol * 0.5);
    const low = Math.min(open, close) * (1 - e * s.vol * 0.5);
    if (!closedDay(s, d, now)) continue;
    out.push({
      date: d,
      open: r(open, s.digits),
      high: r(high, s.digits),
      low: r(low, s.digits),
      close: r(close, s.digits),
      volume: Math.round(1e6 * (5 + 20 * a * b)),
    });
  }
  return out;
}

const MONTHS: Record<string, number> = { "1mo": 1, "3mo": 3, "6mo": 6, "1y": 12, "2y": 24, "5y": 60 };
function since(range: string, bars: Bar[]): Bar[] {
  if (range === "5d") return bars.slice(-5);
  const last = bars.at(-1);
  if (!last) return [];
  const [y, m, d] = last.date.split("-").map(Number) as [number, number, number];
  const from = new Date(Date.UTC(y, m - 1 - (MONTHS[range] ?? 3), d)).toISOString().slice(0, 10);
  return bars.filter((b) => b.date > from);
}

const ok = (body: unknown): RawResponse => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/** Yahoo's chart API answer for a series: daily bars over `range`. */
function yahooChart(symbol: string, range: string, now: number): RawResponse | undefined {
  const s = SERIES[symbol];
  if (!s || s.kind === "KRX") return undefined;
  const bars = since(range, fakeBars(symbol, now));
  const last = bars.at(-1);
  if (!last) return undefined;
  const fx = s.kind === "FX";
  const ts = (d: string) => Math.floor((fx ? Date.parse(`${d}T00:00:00Z`) : openInstant("US", d)) / 1000);
  const lastTime = fx ? zonedInstant(last.date, "17:00", FX_TIME_ZONE) : closeInstant("US", last.date);
  return ok({
    chart: {
      result: [
        {
          meta: {
            currency: fx ? "KRW" : "USD",
            symbol,
            exchangeName: fx ? "CCY" : "NMS",
            fullExchangeName: fx ? "CCY" : "NasdaqGS",
            instrumentType: fx ? "CURRENCY" : "EQUITY",
            regularMarketTime: Math.floor(Math.min(lastTime, now) / 1000),
            exchangeTimezoneName: fx ? "Europe/London" : "America/New_York",
            regularMarketPrice: last.close,
            chartPreviousClose: bars[0]!.open,
            previousClose: bars.at(-2)?.close ?? bars[0]!.open,
            dataGranularity: "1d",
            range,
            longName: `${symbol} (SYNTHETIC)`,
          },
          timestamp: bars.map((b) => ts(b.date)),
          indicators: {
            quote: [
              {
                open: bars.map((b) => b.open),
                high: bars.map((b) => b.high),
                low: bars.map((b) => b.low),
                close: bars.map((b) => b.close),
                volume: bars.map((b) => (fx ? 0 : b.volume)),
              },
            ],
          },
        },
      ],
      error: null,
    },
  });
}

const won = (n: number) => n.toLocaleString("en-US");

/** One Naver price page (newest first). */
function naverPrice(code: string, size: number, page: number, now: number): RawResponse | undefined {
  if (SERIES[code]?.kind !== "KRX") return undefined;
  const bars = fakeBars(code, now).reverse();
  const rows = bars.slice((page - 1) * size, page * size).map((b, i) => {
    const prev = bars[(page - 1) * size + i + 1];
    const change = prev ? b.close - prev.close : 0;
    return {
      localTradedAt: b.date,
      closePrice: won(b.close),
      compareToPreviousClosePrice: won(change),
      compareToPreviousPrice: { name: change > 0 ? "RISING" : change < 0 ? "FALLING" : "UNCHANGED" },
      fluctuationsRatio: prev ? ((change / prev.close) * 100).toFixed(2) : "0.00",
      openPrice: won(b.open),
      highPrice: won(b.high),
      lowPrice: won(b.low),
      accumulatedTradingVolume: b.volume,
    };
  });
  return ok(rows);
}

function naverSearch(q: string): RawResponse {
  const items = KR_NAMES.filter(([code, name]) => name.includes(q) || code.startsWith(q)).map(
    ([code, name, typeCode]) => ({ code, name, typeCode, category: "stock", nationCode: "KOR" }),
  );
  return ok({ query: q, items });
}

/** The synthetic answer of one finance URL, or undefined (not one of ours). */
export function fakeFinanceResponse(raw: string, now: number): RawResponse | undefined {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:") return undefined;
  if (u.hostname === "query1.finance.yahoo.com") {
    const m = /^\/v8\/finance\/chart\/([^/]+)$/.exec(u.pathname);
    if (!m || u.searchParams.get("interval") !== "1d") return undefined;
    return yahooChart(decodeURIComponent(m[1]!), u.searchParams.get("range") ?? "3mo", now);
  }
  if (u.hostname === "m.stock.naver.com") {
    const m = /^\/api\/stock\/(\d{6})\/price$/.exec(u.pathname);
    const size = Number(u.searchParams.get("pageSize"));
    const page = Number(u.searchParams.get("page"));
    if (!m || !(size >= 1 && size <= 60) || !(page >= 1 && page <= 10)) return undefined;
    return naverPrice(m[1]!, size, page, now);
  }
  if (u.hostname === "ac.stock.naver.com" && u.pathname === "/ac")
    return naverSearch(u.searchParams.get("q") ?? "");
  return undefined;
}

/**
 * The finance worker of the FakeRuntime mode (and tests): synthetic answers for the URLs above, `web_unreachable`
 * for anything else (no fallback to the network). Cookie and crumb steps answer nothing, as the real worker.
 */
export function fixtureFinanceWorker(now: () => number = Date.now): FinanceWorker {
  return async (job) => {
    // The real worker's input contract (worker.mjs `fetchRaw`, `RAW_JOB_LIMITS`): a job it would refuse is refused here.
    if (!Array.isArray(job.steps) || job.steps.length < 1 || job.steps.length > RAW_JOB_LIMITS.maxSteps)
      return { ok: false, code: "web_bad_input" };
    if (job.steps.some((s) => !s || typeof s !== "object" || typeof s.url !== "string"))
      return { ok: false, code: "web_bad_input" };
    const responses: RawResponse[] = [];
    for (const step of job.steps) {
      if (step.mode) continue;
      const res = fakeFinanceResponse(step.url, now());
      if (!res) return { ok: false, code: "web_unreachable" };
      if (Buffer.byteLength(res.body, "utf8") > RAW_JOB_LIMITS.maxBytes)
        return { ok: false, code: "web_too_large" };
      responses.push(res);
    }
    return { ok: true, responses };
  };
}
