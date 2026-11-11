/**
 * Days and months of the usage screens (#32) in the service time zone (default Asia/Seoul): "this month",
 * "today" and the forecast are calendar days there, not UTC.
 */

type Ymd = { y: number; m: number; d: number };

function partsAt(at: number, timeZone: string): Ymd & { h: number; min: number; s: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const n = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { y: n("year"), m: n("month"), d: n("day"), h: n("hour") % 24, min: n("minute"), s: n("second") };
}

/** Milliseconds the zone is ahead of UTC at `at`. */
function offsetAt(at: number, timeZone: string): number {
  const p = partsAt(at, timeZone);
  const wall = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return wall - (at - (((at % 1000) + 1000) % 1000));
}

/** The instant local midnight starts on y-m-d in the zone. */
function midnight(y: number, m: number, d: number, timeZone: string): number {
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - offsetAt(guess, timeZone);
  return guess - offsetAt(first, timeZone);
}

const pad = (n: number) => String(n).padStart(2, "0");

export type MonthInfo = {
  /** "YYYY-MM". */
  month: string;
  /** "YYYY-MM-DD" of `at`. */
  today: string;
  monthStart: number;
  monthEnd: number;
  dayStart: number;
  dayEnd: number;
  daysInMonth: number;
  /** 1-based day of the month of `at` (= days elapsed, today included). */
  dayOfMonth: number;
};

export function monthInfo(at: number, timeZone: string): MonthInfo {
  const { y, m, d } = partsAt(at, timeZone);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const next = m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
  const tomorrow = new Date(Date.UTC(y, m - 1, d + 1));
  return {
    month: `${y}-${pad(m)}`,
    today: `${y}-${pad(m)}-${pad(d)}`,
    monthStart: midnight(y, m, 1, timeZone),
    monthEnd: midnight(next.y, next.m, 1, timeZone),
    dayStart: midnight(y, m, d, timeZone),
    dayEnd: midnight(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), timeZone),
    daysInMonth,
    dayOfMonth: d,
  };
}

/**
 * Forecast for the month (FR-9.5): the cost so far plus the daily average so far × the days still to come.
 * `dayOfMonth` counts today as an elapsed day.
 */
export function forecastMonth(costSoFar: number, dayOfMonth: number, daysInMonth: number): number {
  const elapsed = Math.max(1, dayOfMonth);
  const remaining = Math.max(0, daysInMonth - dayOfMonth);
  return costSoFar + (costSoFar / elapsed) * remaining;
}
