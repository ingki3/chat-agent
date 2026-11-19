/**
 * Time for 깊이 조사 (#211): the job's deadlines and every step's time limit go through this, so tests run the
 * 30-minute cap on a manual clock instead of waiting (or faking every timer of the process).
 */
export type Clock = {
  now(): number;
  /** Calls `fn` once after `ms`; returns a cancel function. Never keeps the process alive. */
  timer(ms: number, fn: () => void): () => void;
};

export const realClock: Clock = {
  now: () => Date.now(),
  timer(ms, fn) {
    const t = setTimeout(fn, Math.max(0, ms));
    t.unref();
    return () => clearTimeout(t);
  },
};

/** A clock that moves only when told (`advance`) — timers that come due fire in order. Tests only. */
export class ManualClock implements Clock {
  private t: number;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  constructor(start = Date.UTC(2026, 10, 19, 1, 0, 0)) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  timer(ms: number, fn: () => void): () => void {
    const id = ++this.seq;
    this.timers.set(id, { at: this.t + Math.max(0, ms), fn });
    return () => void this.timers.delete(id);
  }

  /** Moves time on by `ms`, firing every timer due on the way (each at its own time). */
  advance(ms: number): void {
    const end = this.t + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const e of this.timers) if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
    }
    this.t = end;
  }

  pending(): number {
    return this.timers.size;
  }
}
