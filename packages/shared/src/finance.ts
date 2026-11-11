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
