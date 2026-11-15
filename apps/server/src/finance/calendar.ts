/**
 * Market calendars and local time (#30, PRD FR-7.6): which day is a trading day, when a session opens and
 * closes, and how an instant is written in a market's own time zone with its offset.
 *
 * The rule the finance tools follow: a value is **장중** (intraday) only while its market is open and the value is
 * from today's session; otherwise it is that session's **종가** (close), stamped with the session's close time.
 * On weekends and holidays that is the latest trading day — a Saturday request shows Friday's close.
 *
 * Holidays are a maintained table (docs/ops.md §19.4: add next year's dates each December). A year outside the
 * table falls back to weekends only, and the value's own trading date from the source still decides the label.
 */

export type Market = "KRX" | "US" | "FX";

type Session = { timeZone: string; open: string; close: string };
export const SESSIONS: Record<"KRX" | "US", Session> = {
  KRX: { timeZone: "Asia/Seoul", open: "09:00", close: "15:30" },
  US: { timeZone: "America/New_York", open: "09:30", close: "16:00" },
};
/** FX trades around the clock on weekdays: closed from Friday 17:00 to Sunday 17:00 New York time. */
export const FX_TIME_ZONE = "America/New_York";

/** Years the holiday tables cover. */
export const CALENDAR_YEARS = [2025, 2026, 2027] as const;

/**
 * KRX closed days on weekdays (KRX 휴장일 — public holidays, substitute holidays, election days, 근로자의 날 and
 * the year-end closing day).
 */
const KRX_HOLIDAYS = new Set([
  // 2025
  "2025-01-01",
  "2025-01-27",
  "2025-01-28",
  "2025-01-29",
  "2025-01-30",
  "2025-03-03",
  "2025-05-01",
  "2025-05-05",
  "2025-05-06",
  "2025-06-03",
  "2025-06-06",
  "2025-08-15",
  "2025-10-03",
  "2025-10-06",
  "2025-10-07",
  "2025-10-08",
  "2025-10-09",
  "2025-12-25",
  "2025-12-31",
  // 2026
  "2026-01-01",
  "2026-02-16",
  "2026-02-17",
  "2026-02-18",
  "2026-03-02",
  "2026-05-01",
  "2026-05-05",
  "2026-05-25",
  "2026-06-03",
  "2026-08-17",
  "2026-09-24",
  "2026-09-25",
  "2026-10-05",
  "2026-10-09",
  "2026-12-25",
  "2026-12-31",
  // 2027
  "2027-01-01",
  "2027-02-08",
  "2027-02-09",
  "2027-03-01",
  "2027-05-05",
  "2027-05-13",
  "2027-08-16",
  "2027-09-14",
  "2027-09-15",
  "2027-09-16",
  "2027-10-04",
  "2027-10-11",
  "2027-12-27",
  "2027-12-31",
]);

/** NYSE/Nasdaq full closures on weekdays. */
const US_HOLIDAYS = new Set([
  // 2025
  "2025-01-01",
  "2025-01-09",
  "2025-01-20",
  "2025-02-17",
  "2025-04-18",
  "2025-05-26",
  "2025-06-19",
  "2025-07-04",
  "2025-09-01",
  "2025-11-27",
  "2025-12-25",
  // 2026
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03",
  "2026-09-07",
  "2026-11-26",
  "2026-12-25",
  // 2027
  "2027-01-01",
  "2027-01-18",
  "2027-02-15",
  "2027-03-26",
  "2027-05-31",
  "2027-06-18",
  "2027-07-05",
  "2027-09-06",
  "2027-11-25",
  "2027-12-24",
]);

/** NYSE early closes (13:00 ET). */
const US_EARLY_CLOSE = new Map([
  ["2025-07-03", "13:00"],
  ["2025-11-28", "13:00"],
  ["2025-12-24", "13:00"],
  ["2026-11-27", "13:00"],
  ["2026-12-24", "13:00"],
  ["2027-11-26", "13:00"],
]);

const HOLIDAYS: Record<"KRX" | "US", ReadonlySet<string>> = { KRX: KRX_HOLIDAYS, US: US_HOLIDAYS };

// ---- local time --------------------------------------------------------------------------------------------

type Parts = { y: number; m: number; d: number; hh: number; mm: number; ss: number; weekday: number };
const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(timeZone: string): Intl.DateTimeFormat {
  let f = fmtCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    fmtCache.set(timeZone, f);
  }
  return f;
}
const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock parts of an instant in a time zone. */
export function localParts(ms: number, timeZone: string): Parts {
  const p = Object.fromEntries(
    fmt(timeZone)
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    hh: Number(p.hour),
    mm: Number(p.minute),
    ss: Number(p.second),
    weekday: WEEKDAYS[p.weekday!] ?? 0,
  };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** Offset of the time zone at that instant, in minutes east of UTC. */
export function offsetMinutes(ms: number, timeZone: string): number {
  const p = localParts(ms, timeZone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** `2026-11-13T15:30:00+09:00` — the instant written in that time zone, with its offset. */
export function isoLocal(ms: number, timeZone: string): string {
  const p = localParts(ms, timeZone);
  const off = offsetMinutes(ms, timeZone);
  const sign = off < 0 ? "-" : "+";
  const a = Math.abs(off);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.hh)}:${pad(p.mm)}:${pad(p.ss)}${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** The local date (YYYY-MM-DD) of an instant in a time zone. */
export function localDate(ms: number, timeZone: string): string {
  const p = localParts(ms, timeZone);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** The instant of a wall-clock time (`HH:MM`) on a local date in a time zone. */
export function zonedInstant(ymd: string, hhmm: string, timeZone: string): number {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const [hh, mm] = hhmm.split(":").map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  // Two passes settle the offset (it may differ between the guess and the answer around a DST change).
  let t = wall - offsetMinutes(wall, timeZone) * 60_000;
  t = wall - offsetMinutes(t, timeZone) * 60_000;
  return t;
}

const addDays = (ymd: string, n: number): string => {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
};
const weekdayOf = (ymd: string): number => {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

// ---- trading days ------------------------------------------------------------------------------------------

export function isTradingDay(market: "KRX" | "US", ymd: string): boolean {
  const w = weekdayOf(ymd);
  return w !== 0 && w !== 6 && !HOLIDAYS[market].has(ymd);
}

/** The trading day before `ymd` (not `ymd` itself). */
export function previousTradingDay(market: "KRX" | "US", ymd: string): string {
  let d = addDays(ymd, -1);
  for (let i = 0; i < 20 && !isTradingDay(market, d); i++) d = addDays(d, -1);
  return d;
}

export function openInstant(market: "KRX" | "US", ymd: string): number {
  const s = SESSIONS[market];
  return zonedInstant(ymd, s.open, s.timeZone);
}

/** Close of that day's session (early closes included). */
export function closeInstant(market: "KRX" | "US", ymd: string): number {
  const s = SESSIONS[market];
  const early = market === "US" ? US_EARLY_CLOSE.get(ymd) : undefined;
  return zonedInstant(ymd, early ?? s.close, s.timeZone);
}

/** Whether the market's regular session is running at `now`. */
export function isOpen(market: Market, now: number): boolean {
  if (market === "FX") {
    const p = localParts(now, FX_TIME_ZONE);
    if (p.weekday === 6) return false;
    if (p.weekday === 5 && p.hh >= 17) return false;
    if (p.weekday === 0 && p.hh < 17) return false;
    return true;
  }
  const today = localDate(now, SESSIONS[market].timeZone);
  return (
    isTradingDay(market, today) && now >= openInstant(market, today) && now < closeInstant(market, today)
  );
}

/**
 * The latest trading day at `now`: today once its session has opened, otherwise the trading day before
 * (a Saturday → Friday, a Monday before the open → the Friday before, a holiday → the day before it).
 */
export function latestTradingDay(market: "KRX" | "US", now: number): string {
  const today = localDate(now, SESSIONS[market].timeZone);
  return isTradingDay(market, today) && now >= openInstant(market, today)
    ? today
    : previousTradingDay(market, today);
}

/**
 * The trading day a value observed at `t` belongs to: its own local date when that is a trading day and the
 * session had opened, otherwise the trading day before (a pre-market or weekend timestamp shows the last close).
 */
export function sessionDayOf(market: "KRX" | "US", t: number): string {
  const d = localDate(t, SESSIONS[market].timeZone);
  return isTradingDay(market, d) && t >= openInstant(market, d) ? d : previousTradingDay(market, d);
}
