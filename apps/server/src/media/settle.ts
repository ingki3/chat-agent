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

/** Tries of the start-up recovery, and the wait between them. */
export const RECOVER_TRIES = 3;
export const RECOVER_WAIT_MS = 200;

export class MediaRecoveryError extends Error {
  constructor() {
    super("media reservations of the previous process could not be taken up");
    this.name = "MediaRecoveryError";
  }
}

/**
 * Start-up recovery of a previous process's `reserved` rows (#238 review r4) — synchronously while the app is built,
 * so before the server takes any request and no media call of this process exists: all `reserved` rows are taken
 * up, in one transaction (no clock compared: one server holds the data folder's lock). A failure is tried again
 * (`RECOVER_TRIES`, `RECOVER_WAIT_MS` apart — a short write lock passes); if it still fails the start fails, loudly
 * (`media.recovery_failed`), rather than leave rows reserved for good.
 */
export function recoverMediaReservations(
  usage: Pick<UsageStore, "recoverReservedMedia">,
  o: { log?: EventLogger | undefined; tries?: number; waitMs?: number } = {},
): number {
  const tries = o.tries ?? RECOVER_TRIES;
  for (let i = 1; ; i++) {
    try {
      return usage.recoverReservedMedia();
    } catch {
      if (i >= tries) {
        logEvent(o.log, "error", "media.recovery_failed", { mediaCode: "media_usage_failed" });
        throw new MediaRecoveryError();
      }
      // A synchronous wait: this runs while the app is built, nothing else is waiting on this thread yet.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, o.waitMs ?? RECOVER_WAIT_MS);
    }
  }
}
