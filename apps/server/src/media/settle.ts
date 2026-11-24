import { logEvent, type EventLogger } from "../logging.js";
import type { UsageStore } from "../usage/store.js";
import { generationCost } from "./generate.js";
import type { OpenRouterKeys } from "./keys.js";

/**
 * Late cost settlement (#238 review r2–r3): a generation that answered without a cost and whose cost lookups right
 * after the call found nothing waits as `awaiting_cost` with OpenRouter's generation id. This settler looks those up
 * again with a backoff (1 min, 2, 4 … up to 6 h between tries) — also after a restart, since the id and the tries
 * are on the row — and settles the same row when the cost comes. After `MAX_TRIES` tries or `MAX_AGE_MS` the row is
 * `unconfirmed` for good (its reserved bound stays in that day's budget; the usage screen counts it as 미제공).
 *
 * A row a previous process left `reserved` (it stopped between sending and settling) is taken up at start by
 * `recoverMediaReservations`, before the server takes requests: with its generation id (written as soon as the 2xx
 * headers came) it waits for its cost like any other; without one it is `unconfirmed`, keeping its reserved amount.
 */
export const SETTLE_INTERVAL_MS = 60_000;
export const SETTLE_FIRST_MS = 15_000;
export const MAX_TRIES = 12;
export const MAX_AGE_MS = 3 * 24 * 3600_000;
export const BATCH = 100;

export class MediaSettler {
  private timer: NodeJS.Timeout | undefined;
  private first: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  private readonly abort = new AbortController();
  private readonly now: () => number;

  constructor(
    private readonly o: {
      usage: Pick<UsageStore, "dueMedia" | "settleMedia" | "triedMedia" | "unconfirmMedia">;
      keys: Pick<OpenRouterKeys, "resolve">;
      fetchImpl?: typeof fetch | undefined;
      now?: () => number;
      log?: EventLogger | undefined;
    },
  ) {
    this.now = o.now ?? Date.now;
  }

  /** One pass over the rows due now (tests call it directly). Never throws; does nothing once stopped. */
  runOnce(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.running ??= this.pass().finally(() => (this.running = undefined));
    return this.running;
  }

  private async pass(): Promise<void> {
    try {
      const at = this.now();
      const key = this.o.keys.resolve();
      // The rows whose backoff has passed (or that are to be given up), at most a batch — due ones first. Without
      // a key nothing can be looked up: only the rows to be given up are taken (review r4).
      const rows = this.o.usage.dueMedia(at, {
        maxTries: MAX_TRIES,
        maxAgeMs: MAX_AGE_MS,
        limit: BATCH,
        giveUpOnly: !key,
      });
      for (const r of rows) {
        if (this.stopped) return;
        if (!key || !r.generationId || r.tries >= MAX_TRIES || at - r.createdAt > MAX_AGE_MS) {
          this.o.usage.unconfirmMedia(r.runKey);
          continue;
        }
        const cost = await generationCost(r.generationId, key.key, this.o.fetchImpl, this.abort.signal);
        // Stopped meanwhile: the row stays as it is (looked up again at the next start).
        if (this.stopped) return;
        if (cost !== null) this.o.usage.settleMedia(r.runKey, cost);
        else this.o.usage.triedMedia(r.runKey, r.tries + 1);
      }
    } catch {
      logEvent(this.o.log, "warn", "media.usage_failed", {
        mediaCode: "media_usage_failed",
        mediaStep: "settle",
      });
    }
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.first = setTimeout(() => void this.runOnce(), SETTLE_FIRST_MS);
    this.first.unref();
    this.timer = setInterval(() => void this.runOnce(), SETTLE_INTERVAL_MS);
    this.timer.unref();
  }

  /** No new lookup starts; the one under way is aborted; waits for the pass to end. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.first) clearTimeout(this.first);
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.abort.abort();
    await this.running;
  }
}

/** Tries of one start-up recovery attempt, and the wait between them. */
export const RECOVER_TRIES = 3;
export const RECOVER_WAIT_MS = 200;
/** Background retries after a failed start-up recovery: 5 s, 10 s, 20 s … up to 5 min apart. */
export const RECOVER_RETRY_FIRST_MS = 5_000;
export const RECOVER_RETRY_MAX_MS = 5 * 60_000;

/**
 * One recovery of a previous process's `reserved` rows (#238 review r4–r5): all of them, in one transaction (no
 * clock compared: only the lock-holding server runs this, before any media call of its own). Tried `tries` times,
 * `waitMs` apart (a short write lock passes). The count, or null when it did not succeed (logged).
 */
export function recoverMediaReservations(
  usage: Pick<UsageStore, "recoverReservedMedia">,
  o: { log?: EventLogger | undefined; tries?: number; waitMs?: number } = {},
): number | null {
  const tries = o.tries ?? RECOVER_TRIES;
  for (let i = 1; ; i++) {
    try {
      return usage.recoverReservedMedia();
    } catch {
      if (i >= tries) {
        logEvent(o.log, "error", "media.recovery_failed", { mediaCode: "media_usage_failed" });
        return null;
      }
      // A synchronous wait: the first attempt runs while the app is built, before it takes any request.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, o.waitMs ?? RECOVER_WAIT_MS);
    }
  }
}

/**
 * The start-up recovery and what happens when it fails (#238 review r5; the user's decision: chat stays available,
 * media bookkeeping waits). Only the lock-holding server start runs it (`app.ts`, `opts.dataLock`). It is tried
 * while the app is built; if it fails the server starts anyway, but **new paid media calls are refused**
 * (`media_recovering`) while it is retried in the background with a backoff — the block is in place before any
 * media call, so no new reservation mixes into the rows being recovered. On success the block is lifted.
 */
export class MediaRecovery {
  private pending = false;
  private stopped = false;
  private timer: NodeJS.Timeout | undefined;
  private retries = 0;

  constructor(
    private readonly o: {
      usage: Pick<UsageStore, "recoverReservedMedia">;
      log?: EventLogger | undefined;
      waitMs?: number;
      /** Tests: the background retries are driven by hand (`retryNow`). */
      background?: boolean;
    },
  ) {}

  /** Whether new paid media calls must wait (the recovery has not succeeded yet). */
  recovering(): boolean {
    return this.pending;
  }

  /** The start-up attempt (synchronous). False: it failed, the block is on and retries are scheduled. */
  runAtStart(): boolean {
    if (this.attemptOnce()) return true;
    this.pending = true;
    this.schedule();
    return false;
  }

  /** One more attempt now; lifts the block on success. */
  retryNow(): boolean {
    if (!this.pending) return true;
    if (!this.attemptOnce()) return false;
    this.pending = false;
    logEvent(this.o.log, "info", "media.recovered", {});
    return true;
  }

  private attemptOnce(): boolean {
    return (
      recoverMediaReservations(this.o.usage, {
        log: this.o.log,
        waitMs: this.o.waitMs ?? RECOVER_WAIT_MS,
      }) !== null
    );
  }

  private schedule(): void {
    if (this.stopped || this.o.background === false || !this.pending) return;
    const delay = Math.min(RECOVER_RETRY_MAX_MS, RECOVER_RETRY_FIRST_MS * 2 ** this.retries++);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.retryNow()) this.schedule();
    }, delay);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
