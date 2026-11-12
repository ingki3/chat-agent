import { describe, expect, it } from "vitest";
import {
  CronError,
  latestOccurrence,
  nextOccurrence,
  offsetAt,
  parseCron,
  resolveLocal,
} from "../src/schedules/time.js";

/** #33: next / latest occurrence with the FR-8.7 daylight-saving rules (America/New_York 2026). */
const SEOUL = "Asia/Seoul";
const NY = "America/New_York";
const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
/** 2026-11-12 00:00 KST (Thursday). */
const THU = Date.UTC(2026, 10, 11, 15);

describe("occurrences of the five types (Asia/Seoul)", () => {
  it("once, daily, weekdays, weekly and cron", () => {
    expect(iso(nextOccurrence({ type: "once", date: "2026-11-14", time: "10:00" }, SEOUL, THU))).toBe(
      "2026-11-14T01:00:00.000Z",
    );
    // A one-off in the past has none.
    expect(nextOccurrence({ type: "once", date: "2026-11-11", time: "10:00" }, SEOUL, THU)).toBeNull();
    expect(iso(nextOccurrence({ type: "daily", time: "08:00" }, SEOUL, THU))).toBe(
      "2026-11-11T23:00:00.000Z",
    );
    // Friday 09:00 → Monday 08:00
    const fri9 = Date.UTC(2026, 10, 13, 0);
    expect(iso(nextOccurrence({ type: "weekdays", time: "08:00" }, SEOUL, fri9))).toBe(
      "2026-11-15T23:00:00.000Z",
    );
    expect(iso(nextOccurrence({ type: "weekly", time: "09:00", weekdays: [0, 3] }, SEOUL, THU))).toBe(
      "2026-11-15T00:00:00.000Z",
    );
    expect(iso(nextOccurrence({ type: "cron", cron: "15 */6 * * *" }, SEOUL, THU))).toBe(
      "2026-11-11T15:15:00.000Z",
    );
    // Strictly after: an occurrence at `after` itself is not the next one.
    const at8 = Date.UTC(2026, 10, 11, 23);
    expect(iso(nextOccurrence({ type: "daily", time: "08:00" }, SEOUL, at8))).toBe(
      "2026-11-12T23:00:00.000Z",
    );
  });

  it("cron: lists, ranges, steps, Sunday as 7, either day field (vixie), rare dates, bad input", () => {
    const c = parseCron("0,30 9-17/4 * * 1-5");
    expect(c.minutes).toEqual([0, 30]);
    expect(c.hours).toEqual([9, 13, 17]);
    expect(parseCron("0 0 * * 7").weekdays).toEqual(new Set([0]));
    // 13th of the month OR a Friday (both restricted)
    const fri13 = nextOccurrence({ type: "cron", cron: "0 12 13 * 5" }, SEOUL, THU);
    expect(iso(fri13)).toBe("2026-11-13T03:00:00.000Z"); // 2026-11-13 is a Friday and the 13th
    const after = nextOccurrence({ type: "cron", cron: "0 12 13 * 5" }, SEOUL, fri13!);
    expect(iso(after)).toBe("2026-11-20T03:00:00.000Z"); // next Friday
    // 29 February: the next leap year
    expect(iso(nextOccurrence({ type: "cron", cron: "0 0 29 2 *" }, SEOUL, THU))).toBe(
      "2028-02-28T15:00:00.000Z",
    );
    // never
    expect(nextOccurrence({ type: "cron", cron: "0 0 31 2 *" }, SEOUL, THU)).toBeNull();
    for (const bad of [
      "* * * *",
      "60 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * * 13 *",
      "5-1 * * * *",
      "*/0 * * * *",
    ])
      expect(() => parseCron(bad), bad).toThrow(CronError);
  });

  it("latest occurrence in a window (the missed catch-up)", () => {
    const sun2 = THU + 3 * 86_400_000 + 2 * 3_600_000;
    expect(iso(latestOccurrence({ type: "daily", time: "08:00" }, SEOUL, sun2, THU))).toBe(
      "2026-11-13T23:00:00.000Z", // Saturday 08:00 — not Thursday's or Friday's
    );
    expect(latestOccurrence({ type: "daily", time: "08:00" }, SEOUL, THU + 3_600_000, THU)).toBeNull();
  });
});

describe("daylight saving (America/New_York, FR-8.7)", () => {
  // 2026: EDT starts Sunday 8 March 02:00 (clocks to 03:00); ends Sunday 1 November 02:00 (back to 01:00).
  const springDay = Math.floor(Date.UTC(2026, 2, 8) / 86_400_000);
  const fallDay = Math.floor(Date.UTC(2026, 10, 1) / 86_400_000);

  it("a nonexistent local time resolves to the first valid instant after the gap (03:00 EDT)", () => {
    expect(offsetAt(Date.UTC(2026, 2, 8, 6, 59), NY)).toBe(-5 * 3_600_000);
    expect(offsetAt(Date.UTC(2026, 2, 8, 7, 0), NY)).toBe(-4 * 3_600_000);
    for (const m of [120, 150, 179])
      expect(iso(resolveLocal(springDay, m, NY))).toBe("2026-03-08T07:00:00.000Z");
    // 03:00 itself and 01:59 are ordinary
    expect(iso(resolveLocal(springDay, 180, NY))).toBe("2026-03-08T07:00:00.000Z");
    expect(iso(resolveLocal(springDay, 119, NY))).toBe("2026-03-08T06:59:00.000Z");
    const daily = { type: "daily", time: "02:30" } as const;
    const first = nextOccurrence(daily, NY, Date.UTC(2026, 2, 7, 12));
    expect(iso(first)).toBe("2026-03-08T07:00:00.000Z");
    expect(iso(nextOccurrence(daily, NY, first!))).toBe("2026-03-09T06:30:00.000Z");
  });

  it("several nonexistent times are one instant (one run): a cron in the gap", () => {
    const cron = { type: "cron", cron: "*/20 2 * * *" } as const;
    const a = nextOccurrence(cron, NY, Date.UTC(2026, 2, 8, 0));
    expect(iso(a)).toBe("2026-03-08T07:00:00.000Z");
    // the next one is the next day's 02:00 — 02:20 and 02:40 of the gap day collapsed into 03:00
    expect(iso(nextOccurrence(cron, NY, a!))).toBe("2026-03-09T06:00:00.000Z");
  });

  it("a repeated local time runs at its first occurrence only (01:30 EDT, not 01:30 EST)", () => {
    expect(iso(resolveLocal(fallDay, 90, NY))).toBe("2026-11-01T05:30:00.000Z");
    const daily = { type: "daily", time: "01:30" } as const;
    const first = nextOccurrence(daily, NY, Date.UTC(2026, 9, 31, 12));
    expect(iso(first)).toBe("2026-11-01T05:30:00.000Z");
    // after the first 01:30 the next is the next day's — the second 01:30 (06:30Z) never comes up
    expect(iso(nextOccurrence(daily, NY, first!))).toBe("2026-11-02T06:30:00.000Z");
    const cron = { type: "cron", cron: "0,30 1-2 * * *" } as const;
    const seen: string[] = [];
    let t: number | null = Date.UTC(2026, 10, 1, 4);
    for (let i = 0; i < 4; i++) seen.push(iso((t = nextOccurrence(cron, NY, t!)))!);
    expect(seen).toEqual([
      "2026-11-01T05:00:00.000Z", // 01:00 EDT
      "2026-11-01T05:30:00.000Z", // 01:30 EDT
      "2026-11-01T07:00:00.000Z", // 02:00 EST (01:00 / 01:30 EST skipped)
      "2026-11-01T07:30:00.000Z",
    ]);
    // the latest occurrence of a window over the repeated hour is still the first 01:30
    expect(iso(latestOccurrence(daily, NY, Date.UTC(2026, 10, 1, 6, 45), Date.UTC(2026, 9, 31)))).toBe(
      "2026-11-01T05:30:00.000Z",
    );
  });
});
