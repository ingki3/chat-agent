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
 * At start (`recover`), a row a previous process left `reserved` (it stopped between sending and settling) is
 * taken up: with its generation id (written as soon as the 2xx headers came) it waits for its cost like any other;
 * without one it is `unconfirmed`, keeping its reserved amount.
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
  /** This process's start: `reserved` rows older than it were a previous process's. */
  private readonly startedAt: number;

  constructor(
    private readonly o: {
      usage: Pick<
        UsageStore,
        "dueMedia" | "settleMedia" | "triedMedia" | "unconfirmMedia" | "recoverReservedMedia"
      >;
      keys: Pick<OpenRouterKeys, "resolve">;
      fetchImpl?: typeof fetch | undefined;
      now?: () => number;
      log?: EventLogger | undefined;
    },
  ) {
    this.now = o.now ?? Date.now;
    this.startedAt = this.now();
  }

  /** Takes up a previous process's `reserved` rows (see the class note). Never throws. */
  recover(): number {
    try {
      return this.o.usage.recoverReservedMedia(this.startedAt);
    } catch {
      logEvent(this.o.log, "warn", "media.usage_failed", {
        mediaCode: "media_usage_failed",
        mediaStep: "settle",
      });
      return 0;
    }
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
      // The rows whose backoff has passed (or that are to be given up), at most a batch — due ones first.
      for (const r of this.o.usage.dueMedia(at, {
        maxTries: MAX_TRIES,
        maxAgeMs: MAX_AGE_MS,
        limit: BATCH,
      })) {
        if (this.stopped) return;
        if (!r.generationId || r.tries >= MAX_TRIES || at - r.createdAt > MAX_AGE_MS) {
          this.o.usage.unconfirmMedia(r.runKey);
          continue;
        }
        if (!key) return;
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
    this.recover();
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
