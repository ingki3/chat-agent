import {
  FINANCE_DISCLAIMER,
  FinanceMeta,
  financeLabel,
  type FinanceKind,
  type FinanceSource,
} from "@agentlee/shared";
import {
  closeInstant,
  FX_TIME_ZONE,
  isOpen,
  isoLocal,
  latestTradingDay,
  localDate,
  SESSIONS,
  sessionDayOf,
  zonedInstant,
  type Market,
} from "./calendar.js";

/**
 * Finance records (#30): how a tool stamps its numbers with `{ source, asOf, timeZone, delayed, kind }` and how
 * the service checks every stamp before a result leaves (`finalize`). A record is any object of the result with
 * an own `asOf` key; one whose stamp is incomplete is flagged (`metaMissing`) and the result gets the
 * `finance_meta_missing` warning — the answer check (checker.ts) then marks the answer.
 */

/** A stamp shared by the values observed together (one quote, one row). `asOf` null = not known. */
export type Stamp = {
  source: string;
  asOf: string | null;
  timeZone: string;
  delayed: boolean;
  kind: FinanceKind;
  /** The trading day the value belongs to (markets with sessions). */
  tradingDay?: string;
  /** The value is from before the latest trading day (the source lags). */
  stale?: boolean;
};

export type Value = Stamp & { value: number | null; unit?: string };

/** A value with its stamp (every value carries its own copy: "값마다"). */
export function val(value: number | null | undefined, stamp: Stamp, unit?: string): Value {
  const v = typeof value === "number" && Number.isFinite(value) ? value : null;
  return { value: v, ...(unit ? { unit } : {}), ...rowMeta(stamp), ...(stamp.stale ? { stale: true } : {}) };
}

/** The stamp's metadata as it goes on a value or a row (the trading day and staleness are said once, above). */
export function rowMeta(stamp: Stamp): Omit<Stamp, "tradingDay" | "stale"> {
  return {
    source: stamp.source,
    asOf: stamp.asOf,
    timeZone: stamp.timeZone,
    delayed: stamp.delayed,
    kind: stamp.kind,
  };
}

/**
 * The stamp of a value observed at `t` (ms) on a market, asked at `now`:
 * - 장중 (`intraday`, asOf = `t`) only while the market is open and `t` is from today's session;
 * - otherwise 종가 (`close`) of the trading day `t` belongs to, stamped with that session's close time — on a
 *   weekend or holiday that is the latest trading day (a Saturday request shows Friday's close).
 * `delayMinutes` undefined = the source does not say: an intraday value is then marked delayed (the free feeds
 * may lag). A close is final, never delayed. FX trades around the clock: its value keeps its own time.
 */
export function marketStamp(o: {
  market: Market;
  t: number | undefined;
  now: number;
  source: string;
  delayMinutes?: number | undefined;
  /** Time zone the asOf is written in (FX default: New York, whose 17:00 ends the FX day). */
  timeZone?: string;
}): Stamp {
  const intradayDelay = o.delayMinutes === undefined ? true : o.delayMinutes > 0;
  if (o.market === "FX") {
    const timeZone = o.timeZone ?? FX_TIME_ZONE;
    if (o.t === undefined || !Number.isFinite(o.t))
      return { source: o.source, asOf: null, timeZone, delayed: false, kind: "close" };
    const live = isOpen("FX", o.now) && o.now - o.t < 2 * 3600_000;
    return {
      source: o.source,
      asOf: isoLocal(o.t, timeZone),
      timeZone,
      delayed: live && intradayDelay,
      kind: live ? "intraday" : "close",
    };
  }
  const { timeZone } = SESSIONS[o.market];
  if (o.t === undefined || !Number.isFinite(o.t))
    return { source: o.source, asOf: null, timeZone, delayed: false, kind: "close" };
  const day = sessionDayOf(o.market, o.t);
  const today = localDate(o.now, timeZone);
  const stale = day < latestTradingDay(o.market, o.now);
  if (isOpen(o.market, o.now) && day === today && o.t < closeInstant(o.market, day))
    return {
      source: o.source,
      asOf: isoLocal(o.t, timeZone),
      timeZone,
      delayed: intradayDelay,
      kind: "intraday",
      tradingDay: day,
    };
  return {
    source: o.source,
    asOf: isoLocal(closeInstant(o.market, day), timeZone),
    timeZone,
    delayed: false,
    kind: "close",
    tradingDay: day,
    ...(stale ? { stale } : {}),
  };
}

/** The close of a given trading day (a history row) — or the live stamp when that day is today's open session. */
export function dayStamp(o: {
  market: "KRX" | "US";
  day: string;
  now: number;
  source: string;
  /** When the row is today's open session: the time of its last value (default `now`). */
  liveAt?: number;
}): Stamp {
  const { timeZone } = SESSIONS[o.market];
  const today = localDate(o.now, timeZone);
  if (o.day === today && isOpen(o.market, o.now))
    return {
      source: o.source,
      asOf: isoLocal(o.liveAt ?? o.now, timeZone),
      timeZone,
      delayed: true,
      kind: "intraday",
      tradingDay: o.day,
    };
  return {
    source: o.source,
    asOf: isoLocal(closeInstant(o.market, o.day), timeZone),
    timeZone,
    delayed: false,
    kind: "close",
    tradingDay: o.day,
  };
}

/** A figure of a period or a date (financial statements, estimates): stamped with that date. */
export function dateStamp(source: string, ymd: string, timeZone: string, kind: FinanceKind): Stamp {
  return {
    source,
    asOf: isoLocal(zonedInstant(ymd, "00:00", timeZone), timeZone),
    timeZone,
    delayed: false,
    kind,
  };
}

/** A filing: stamped with when it was filed. */
export function filingStamp(source: string, t: number | undefined, timeZone: string): Stamp {
  return {
    source,
    asOf: t !== undefined && Number.isFinite(t) ? isoLocal(t, timeZone) : null,
    timeZone,
    delayed: false,
    kind: "filing",
  };
}

export { FX_TIME_ZONE };

// ---- the check before a result leaves --------------------------------------------------------------------

const META_KEYS = ["source", "asOf", "timeZone", "delayed", "kind"] as const;

/**
 * Checks every record (object with an own `asOf`) of a tool's data: a complete stamp adds its source to the
 * result's `sources`; an incomplete one gets `metaMissing: [fields]` and counts as missing.
 */
export function checkRecords(data: unknown): { sources: FinanceSource[]; missing: number } {
  const sources = new Map<string, FinanceSource>();
  let missing = 0;
  const walk = (x: unknown, depth: number) => {
    if (depth > 8 || !x || typeof x !== "object") return;
    if (Array.isArray(x)) {
      for (const y of x) walk(y, depth + 1);
      return;
    }
    const o = x as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(o, "asOf")) {
      const r = FinanceMeta.safeParse(Object.fromEntries(META_KEYS.map((k) => [k, o[k]])));
      if (r.success) {
        const label = financeLabel(r.data);
        if (!sources.has(label)) sources.set(label, { ...r.data, label });
      } else {
        o.metaMissing = [...new Set(r.error.issues.map((i) => String(i.path[0])))];
        missing++;
      }
    }
    for (const [k, v] of Object.entries(o)) if (k !== "metaMissing") walk(v, depth + 1);
  };
  walk(data, 0);
  return { sources: [...sources.values()], missing };
}

/** The result a finance tool returns: its data, the distinct sources of its numbers, warnings and the disclaimer. */
export function finalize(tool: string, data: Record<string, unknown>) {
  const { sources, missing } = checkRecords(data);
  return {
    tool,
    ...data,
    sources,
    warnings: missing ? ["finance_meta_missing"] : [],
    disclaimer: FINANCE_DISCLAIMER,
  };
}

// ---- untrusted values ------------------------------------------------------------------------------------

/** A short third-party string: control characters out, whitespace collapsed, bounded. */
export function txt(v: unknown, max = 80): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v
    // eslint-disable-next-line no-control-regex -- removing control characters is the point
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t ? t.slice(0, max) : undefined;
}

/** A number from a source: numbers as they are, "206,000" / "-1,700" / "3.57" / "1.2%" as numbers, else null. */
export function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v && typeof v === "object" && "raw" in v) return num((v as { raw: unknown }).raw);
  if (typeof v !== "string") return null;
  const t = v.replace(/[,%\s]/g, "");
  if (!/^[+-]?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/** Rounds a computed figure for display (no float noise in the output). */
export const round = (v: number | null, digits = 4): number | null =>
  v === null || !Number.isFinite(v) ? null : Number(v.toFixed(digits));
