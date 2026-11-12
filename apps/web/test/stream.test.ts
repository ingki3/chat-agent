import { describe, expect, it } from "vitest";
import { FrameBatcher, type Scheduler } from "../src/chat/stream.js";

/** A scheduler driven by the test: `tick()` runs what is due, like the next animation frame. */
function manual() {
  let due: (() => void) | null = null;
  let scheduled = 0;
  const schedule: Scheduler = (fn) => {
    scheduled++;
    due = fn;
    return () => {
      if (due === fn) due = null;
    };
  };
  const tick = () => {
    const fn = due;
    due = null;
    fn?.();
  };
  return { schedule, tick, scheduled: () => scheduled };
}

describe("FrameBatcher", () => {
  it("hands over everything that arrived within a frame in one commit", () => {
    const clock = manual();
    const commits: number[][] = [];
    const b = new FrameBatcher<number>((evs) => commits.push(evs), clock.schedule);
    for (let i = 0; i < 1000; i++) b.push(i);
    expect(commits).toEqual([]); // nothing rendered per event
    expect(clock.scheduled()).toBe(1); // one frame asked for, not one per event
    clock.tick();
    expect(commits).toHaveLength(1);
    expect(commits[0]).toHaveLength(1000);
    b.push(1000);
    b.push(1001);
    clock.tick();
    expect(commits.map((c) => c.length)).toEqual([1000, 2]);
  });

  it("flush() hands over at once and cancels the pending frame; dispose() drops the rest", () => {
    const clock = manual();
    const commits: number[][] = [];
    const b = new FrameBatcher<number>((evs) => commits.push(evs), clock.schedule);
    b.push(1);
    b.flush();
    clock.tick();
    expect(commits).toEqual([[1]]);
    b.push(2);
    b.dispose();
    clock.tick();
    expect(commits).toEqual([[1]]);
  });
});
