import { logEvent, type EventLogger } from "../logging.js";
import type { UsageStore } from "../usage/store.js";
import { generationCost } from "./generate.js";
import type { OpenRouterKeys } from "./keys.js";

/**
 * Late cost settlement (#238 review r2): a generation that answered without a cost and whose cost lookups right
 * after the call found nothing waits as `awaiting_cost` with OpenRouter's generation id. This settler looks those up
 * again with a backoff (1 min, 2, 4 … up to 6 h between tries) — also after a restart, since the id and the tries
 * are on the row — and settles the same row when the cost comes. After `MAX_TRIES` tries or `MAX_AGE_MS` the row is
 * `unconfirmed` for good (its reserved bound stays in that day's budget; the usage screen counts it as 미제공).
 */
export const SETTLE_INTERVAL_MS = 60_000;
export const SETTLE_FIRST_MS = 15_000;
export const MAX_TRIES = 12;
export const MAX_AGE_MS = 3 * 24 * 3600_000;
const backoff = (tries: number) => Math.min(6 * 3600_000, 60_000 * 2 ** tries);

export class MediaSettler {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private readonly now: () => number;

  constructor(
    private readonly o: {
      usage: Pick<UsageStore, "awaitingMedia" | "settleMedia" | "triedMedia" | "unconfirmMedia">;
      keys: Pick<OpenRouterKeys, "resolve">;
      fetchImpl?: typeof fetch | undefined;
      now?: () => number;
      log?: EventLogger | undefined;
    },
  ) {
    this.now = o.now ?? Date.now;
  }

  /** One pass over the waiting rows (tests call it directly). Never throws. */
  runOnce(): Promise<void> {
    this.running ??= this.pass().finally(() => (this.running = undefined));
    return this.running;
  }

  private async pass(): Promise<void> {
    try {
      const at = this.now();
      const key = this.o.keys.resolve();
      for (const r of this.o.usage.awaitingMedia(100)) {
        if (!r.generationId || r.tries >= MAX_TRIES || at - r.createdAt > MAX_AGE_MS) {
          this.o.usage.unconfirmMedia(r.runKey);
          continue;
        }
        if (at - r.updatedAt < backoff(r.tries) || !key) continue;
        const cost = await generationCost(r.generationId, key.key, this.o.fetchImpl);
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
    if (this.timer) return;
    const first = setTimeout(() => void this.runOnce(), SETTLE_FIRST_MS);
    first.unref();
    this.timer = setInterval(() => void this.runOnce(), SETTLE_INTERVAL_MS);
    this.timer.unref();
    this.stopFirst = () => clearTimeout(first);
  }

  private stopFirst: (() => void) | undefined;

  async stop(): Promise<void> {
    this.stopFirst?.();
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
}
