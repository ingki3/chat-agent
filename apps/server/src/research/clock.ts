/**
 * Time for 깊이 조사 (#211): the job's deadlines and every step's time limit go through this, so tests run the
 * 30-minute cap on a manual clock instead of waiting (or faking every timer of the process).
 */
export type Clock = {
  now(): number;
  /**
   * A clock that only goes forward (ms, any origin) — for spacing things out (#232: the progress broadcasts), never
   * a date. Setting the wall clock does not move it.
   */
  monotonic(): number;
  /** Calls `fn` once after `ms`; returns a cancel function. Never keeps the process alive. */
  timer(ms: number, fn: () => void): () => void;
};

export const realClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  timer(ms, fn) {
    const t = setTimeout(fn, Math.max(0, ms));
    t.unref();
    return () => clearTimeout(t);
  },
};

/** A clock that moves only when told (`advance`) — timers that come due fire in order. Tests only. */
export class ManualClock implements Clock {
  private t: number;
  /** The monotonic clock: moved by `advance` only (a test may set the wall clock `t` back without it). */
  private mono = 0;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  constructor(start = Date.UTC(2026, 10, 19, 1, 0, 0)) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  monotonic(): number {
    return this.mono;
  }

  /** Timers run on the monotonic clock, as `setTimeout` does: setting the wall clock moves none of them. */
  timer(ms: number, fn: () => void): () => void {
    const id = ++this.seq;
    this.timers.set(id, { at: this.mono + Math.max(0, ms), fn });
    return () => void this.timers.delete(id);
  }

  /** Moves time on by `ms`, firing every timer due on the way (each at its own time). */
  advance(ms: number): void {
    const end = this.mono + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      const at = Math.max(this.mono, next[1].at);
      this.t += at - this.mono;
      this.mono = at;
      next[1].fn();
    }
    this.t += end - this.mono;
    this.mono = end;
  }

  /** Sets the wall clock by `ms` (an NTP step, a user changing the time): the monotonic clock and timers stay. */
  shiftWall(ms: number): void {
    this.t += ms;
  }

  pending(): number {
    return this.timers.size;
  }
}
