/** Quiet hours (방해 금지, FR-13.4): "HH:MM" windows in the user's time zone, possibly across midnight. */

export const DEFAULT_TIME_ZONE = "Asia/Seoul";

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Minute of the day (0–1439) at `at` in `timeZone`. */
export function minuteOfDay(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: isTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return (h % 24) * 60 + m;
}

export type QuietHours = { quietStart: string | null; quietEnd: string | null; timeZone: string };

/** True while `at` is inside the window [start, end). 23:00~07:00 wraps midnight. */
export function inQuietHours(prefs: QuietHours | undefined, at: number): boolean {
  if (!prefs?.quietStart || !prefs.quietEnd) return false;
  const s = minutes(prefs.quietStart);
  const e = minutes(prefs.quietEnd);
  if (s === e) return false;
  const m = minuteOfDay(at, prefs.timeZone);
  return s < e ? m >= s && m < e : m >= s || m < e;
}
