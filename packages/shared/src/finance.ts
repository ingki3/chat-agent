import { z } from "zod";

/**
 * Finance values (#30, PRD FR-7.6·7.8). Every number a finance tool returns carries where it came from and as of
 * when: `{ source, asOf, timeZone, delayed, kind }`. `asOf` is an ISO time *with its offset* in the market's own
 * time zone (`2026-11-13T15:30:00+09:00`), so it can be shown as "15:30 KST" without guessing.
 */

/** 종가 · 장중 · 보고치(재무) · 추정치(컨센서스) · 공시 · 계산값(기술 지표). */
export const FinanceKind = z.enum(["close", "intraday", "reported", "estimate", "filing", "computed"]);
export type FinanceKind = z.infer<typeof FinanceKind>;

/** ISO 8601 date-time with an explicit offset (or Z). */
export const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

export const FinanceMeta = z.object({
  source: z.string().trim().min(1).max(80),
  asOf: z.string().regex(ISO_WITH_OFFSET),
  timeZone: z.string().min(1).max(64),
  delayed: z.boolean(),
  kind: FinanceKind,
});
export type FinanceMeta = z.infer<typeof FinanceMeta>;

/** One distinct source + as-of of an answer, with its human label ("네이버 증권 · 2026-11-13 15:30 KST 종가"). */
export const FinanceSource = FinanceMeta.extend({ label: z.string().min(1).max(160) });
export type FinanceSource = z.infer<typeof FinanceSource>;

/** Attached under every answer that used a finance tool (FR-7.8). */
export const FINANCE_DISCLAIMER =
  "투자 판단의 참고 자료일 뿐이며 투자 권유가 아닙니다. Agent Lee는 매수·매도 같은 거래를 하지 않습니다.";

/**
 * What the finance output check found missing in an answer: no source named, no as-of date, or a tool value
 * that came back without its metadata (or from a finance tool that does not report it).
 */
export const FinanceMissing = z.enum(["source", "as_of", "tool_meta"]);
export type FinanceMissing = z.infer<typeof FinanceMissing>;

export const FINANCE_NOTE_MAX_SOURCES = 12;

const KIND_LABEL: Record<FinanceKind, string> = {
  close: "종가",
  intraday: "장중",
  reported: "보고치",
  estimate: "추정치",
  filing: "공시",
  computed: "계산값",
};
const ZONE_LABEL: Record<string, string> = {
  "Asia/Seoul": "KST",
  "America/New_York": "ET",
  UTC: "UTC",
};

/** "Yahoo Finance · 2026-11-13 16:00 ET 종가", "네이버 증권 · 2026-11-13 10:12 KST 장중 (지연)". */
export function financeLabel(m: FinanceMeta): string {
  const date = m.asOf.slice(0, 10);
  const time = m.asOf.slice(11, 16);
  const zone = ZONE_LABEL[m.timeZone] ?? m.timeZone;
  // Reported figures belong to a period, not a moment, and a filing known by its date only has no time.
  const dateOnly =
    m.kind === "reported" ||
    m.kind === "estimate" ||
    (m.kind === "filing" && m.asOf.slice(11, 19) === "00:00:00");
  const when = dateOnly ? date : `${date} ${time} ${zone}`;
  return `${m.source} · ${when} ${KIND_LABEL[m.kind]}${m.delayed ? " (지연)" : ""}`;
}

// ---- 관심 종목 (#31, FR-7.7) ----------------------------------------------------------------------------------

/** KR = KOSPI/KOSDAQ (6-digit KRX code), US = a US ticker. */
export const WatchMarket = z.enum(["KR", "US"]);
export type WatchMarket = z.infer<typeof WatchMarket>;
export const KR_CODE = /^\d{6}$/;
export const US_TICKER = /^[A-Z][A-Z0-9.-]{0,9}$/;
/**
 * A 관심 종목 US ticker: at most 7 characters. A deliberate watchlist cap, not a market rule — kept below the shortest
 * known secret (8, `secrets/known.ts`) so a watchlist symbol can never be one and no answer of the watchlist API can
 * tell a guessed secret from any other refused value (review #111). Common tickers (`AAPL`, `BRK-B`, `RITM-PA`) fit;
 * a rare longer symbol (Nasdaq allows up to 8 characters) cannot be put on the watchlist — it still works in the
 * finance tools (`US_TICKER`).
 */
export const WATCH_US_TICKER = /^[A-Z][A-Z0-9.-]{0,6}$/;
export const WATCH_SYMBOL_MAX = 7;
/** A watchlist symbol of a market: a 6-digit code (KR) or a ticker in capitals of at most 7 characters (US). */
export const symbolOk = (market: WatchMarket, symbol: string) =>
  (market === "KR" ? KR_CODE : WATCH_US_TICKER).test(symbol);
/** "005930" → KR, "AAPL" → US (6 digits are always a KRX code). */
export function marketOf(symbol: string): WatchMarket | undefined {
  if (KR_CODE.test(symbol)) return "KR";
  if (US_TICKER.test(symbol)) return "US";
  return undefined;
}

/** At most this many symbols on one person's list. */
export const WATCHLIST_MAX = 50;

// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const NAME = /^[^\0-\x1f\x7f]*$/u;

export const WatchlistItem = z.object({
  id: z.string(),
  market: WatchMarket,
  symbol: z.string(),
  name: z.string().nullable(),
  createdAt: z.number(),
});
export type WatchlistItem = z.infer<typeof WatchlistItem>;

/**
 * `GET /api/watchlist`: the caller's own list (owner only, FR-1.5) and the markets they may use — a market whose
 * finance skill is not allowed for them (e.g. the son's hidden finance skills, #30) is not offered.
 */
export const WatchlistResponse = z.object({ items: z.array(WatchlistItem), markets: z.array(WatchMarket) });
export type WatchlistResponse = z.infer<typeof WatchlistResponse>;

/**
 * The symbol's own rules (market pattern, never a known secret) are the server's single check, answered with one
 * code (`watchlist_bad_symbol`) whatever failed — not here, so a bad pattern and a secret look the same.
 */
export const AddWatchlistRequest = z.strictObject({
  market: WatchMarket,
  symbol: z.string().min(1).max(40),
  name: z.string().trim().max(60).regex(NAME).optional(),
});
export type AddWatchlistRequest = z.infer<typeof AddWatchlistRequest>;

export const WatchlistSearchQuery = z.object({ q: z.string().trim().min(1).max(40) });
/** One search hit (KR: Naver 증권 search; US: the ticker as typed — there is no US name search). */
export const WatchlistSearchHit = z.object({
  market: WatchMarket,
  symbol: z.string(),
  name: z.string().nullable(),
  exchange: z.string().nullable(),
});
export type WatchlistSearchHit = z.infer<typeof WatchlistSearchHit>;
export const WatchlistSearchResponse = z.object({ items: z.array(WatchlistSearchHit) });
export type WatchlistSearchResponse = z.infer<typeof WatchlistSearchResponse>;
