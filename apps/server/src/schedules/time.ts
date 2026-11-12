import type { ScheduleTiming } from "@agentlee/shared";

/**
 * Next / previous occurrence of a schedule (#33, PRD FR-8.2·8.7), with `Intl` only (no cron library).
 *
 * Occurrences are local wall-clock times (a date and a minute of the day) in the schedule's time zone, turned into
 * instants with the daylight-saving rules of FR-8.7 (the #3 decision):
 * - a local time that does not exist (spring forward, e.g. 02:30 in America/New_York on the second Sunday of
 *   March) runs once, at the first valid instant after the gap (03:00 local);
 * - a local time that exists twice (fall back, 01:30 on the first Sunday of November) runs once, at its first
 *   occurrence (the earlier instant, still daylight time).
 * Because occurrences are enumerated as wall-clock times and each maps to one instant, the second 01:30 never comes
 * up; several nonexistent times map to the same instant and become one run through the run key.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;
/** How far a search goes (a cron for 29 February on a Monday can be years away). */
const MAX_DAYS = 366 * 8 + 2;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Local wall clock at `at` as if it were UTC (ms), to the second. */
function wallAt(at: number, timeZone: string): number {
  const p: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(at))
    if (part.type !== "literal") p[part.type] = Number(part.value);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!);
}

/** UTC offset (ms, local − UTC) of `timeZone` at instant `at`. */
export function offsetAt(at: number, timeZone: string): number {
  const whole = Math.floor(at / 1000) * 1000;
  return wallAt(whole, timeZone) - whole;
}

/** Day number (days since 1970-01-01) of the local date at `at`. */
export function localDay(at: number, timeZone: string): number {
  return Math.floor(wallAt(at, timeZone) / DAY);
}

const dayOf = (date: string) =>
  Math.floor(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / DAY,
  );
const minuteOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * The instant of local `day` at `minute` in `timeZone` (FR-8.7 rules above). The zone's offsets 36 hours either
 * side are the candidates (no zone changes twice within three days); a candidate is valid when the zone really has
 * that offset there. Two valid → the earlier (first occurrence); none → the gap's end.
 */
export function resolveLocal(day: number, minute: number, timeZone: string): number {
  const wall = day * DAY + minute * MINUTE;
  const before = offsetAt(wall - 36 * 3_600_000, timeZone);
  const after = offsetAt(wall + 36 * 3_600_000, timeZone);
  if (before === after) return wall - before;
  const valid = [before, after].map((o) => wall - o).filter((t) => offsetAt(t, timeZone) === wall - t);
  if (valid.length) return Math.min(...valid);
  // Spring forward: the wall time falls in the gap. The transition lies between the two readings of it; find the
  // first instant (to the minute — every zone changes on a whole minute) that already has the later offset.
  let lo = Math.min(wall - before, wall - after);
  let hi = Math.max(wall - before, wall - after);
  const late = offsetAt(hi, timeZone);
  while (hi - lo > MINUTE) {
    const mid = lo + Math.floor((hi - lo) / (2 * MINUTE)) * MINUTE;
    if (offsetAt(mid, timeZone) === late) hi = mid;
    else lo = mid;
  }
  return hi;
}

// ---- cron (5 fields: minute hour day-of-month month day-of-week) ----

export type Cron = {
  minutes: number[];
  hours: number[];
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Vixie cron: neither day field starts with "*" → a day matches either one; otherwise both (the sets). */
  daysRestricted: boolean;
  weekdaysRestricted: boolean;
};

export class CronError extends Error {}

function field(src: string, min: number, max: number): number[] {
  const out = new Set<number>();
  for (const item of src.split(",")) {
    const m = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(item);
    if (!m) throw new CronError("cron_invalid");
    let lo = min;
    let hi = max;
    if (m[1] !== "*") {
      lo = Number(m[2]);
      hi = m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? max : lo;
    }
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (lo < min || hi > max || lo > hi || step < 1) throw new CronError("cron_invalid");
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new CronError("cron_invalid");
  const [mi, h, dom, mon, dow] = parts as [string, string, string, string, string];
  return {
    minutes: field(mi, 0, 59),
    hours: field(h, 0, 23),
    days: new Set(field(dom, 1, 31)),
    months: new Set(field(mon, 1, 12)),
    // 7 is Sunday too
    weekdays: new Set(field(dow, 0, 7).map((d) => d % 7)),
    // Vixie cron (entry.c DOM_STAR / DOW_STAR): a field starting with "*" — `*/2` included — is "star"; its set
    // (every other day for `*/2`) is still what it matches.
    daysRestricted: !dom.startsWith("*"),
    weekdaysRestricted: !dow.startsWith("*"),
  };
}

// ---- occurrences ----

export type Timing = ScheduleTiming;

type Compiled = {
  /** Minutes of the day (ascending) on which `day` has occurrences; empty when none. */
  minutesOn: (day: number) => readonly number[];
  /** A one-off: its only day (the search stays there). */
  onlyDay?: number;
};

const weekdayOf = (day: number) => (((day + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday

function compile(timing: Timing): Compiled {
  switch (timing.type) {
    case "once": {
      const d = dayOf(timing.date);
      const m = [minuteOf(timing.time)];
      return { minutesOn: (day) => (day === d ? m : []), onlyDay: d };
    }
    case "daily": {
      const m = [minuteOf(timing.time)];
      return { minutesOn: () => m };
    }
    case "weekdays": {
      const m = [minuteOf(timing.time)];
      return { minutesOn: (day) => (weekdayOf(day) >= 1 && weekdayOf(day) <= 5 ? m : []) };
    }
    case "weekly": {
      const m = [minuteOf(timing.time)];
      const days = new Set(timing.weekdays);
      return { minutesOn: (day) => (days.has(weekdayOf(day)) ? m : []) };
    }
    case "cron": {
      const c = parseCron(timing.cron);
      const m: number[] = [];
      for (const h of c.hours) for (const mi of c.minutes) m.push(h * 60 + mi);
      return {
        minutesOn: (day) => {
          const date = new Date(day * DAY);
          if (!c.months.has(date.getUTCMonth() + 1)) return [];
          const dom = c.days.has(date.getUTCDate());
          const dow = c.weekdays.has(weekdayOf(day));
          // Neither field starts with "*": either one; otherwise both (a "*" field's set — every day, or every n-th —
          // is still applied, so `*/2` alone is every other day).
          const ok = c.daysRestricted && c.weekdaysRestricted ? dom || dow : dom && dow;
          return ok ? m : [];
        },
      };
    }
  }
}

/** Throws `CronError` for an expression the parser does not take. */
export function checkTiming(timing: Timing): void {
  compile(timing);
}

/** The first occurrence strictly after `after`, or null (a past one-off, a cron that never matches). */
export function nextOccurrence(timing: Timing, timeZone: string, after: number): number | null {
  const c = compile(timing);
  const first = localDay(after, timeZone) - 1;
  const from = c.onlyDay !== undefined ? Math.max(first, c.onlyDay) : first;
  const to = c.onlyDay !== undefined ? c.onlyDay : first + MAX_DAYS;
  for (let day = from; day <= to; day++)
    for (const minute of c.minutesOn(day)) {
      const t = resolveLocal(day, minute, timeZone);
      if (t > after) return t;
    }
  return null;
}

/** The latest occurrence in [notBefore, atOrBefore], or null. */
export function latestOccurrence(
  timing: Timing,
  timeZone: string,
  atOrBefore: number,
  notBefore: number,
): number | null {
  if (atOrBefore < notBefore) return null;
  const c = compile(timing);
  const last = localDay(atOrBefore, timeZone) + 1;
  const first = localDay(notBefore, timeZone) - 1;
  for (let day = last; day >= first; day--) {
    if (c.onlyDay !== undefined && day !== c.onlyDay) continue;
    const minutes = c.minutesOn(day);
    for (let i = minutes.length - 1; i >= 0; i--) {
      const t = resolveLocal(day, minutes[i]!, timeZone);
      if (t <= atOrBefore && t >= notBefore) return t;
    }
  }
  return null;
}
