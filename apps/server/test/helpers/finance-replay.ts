import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FinanceWorker } from "../../src/finance/service.js";
import type { RawResponse, RawStep } from "../../src/web/service.js";

/**
 * Recorded (or synthetic) answers of the finance tools' data sources (#30), replayed instead of the network.
 *
 * A fixture (`test/fixtures/finance/<name>.json`) is one tool call: the tool, its input, the moment it is asked
 * (`now`, which decides 장중 / 종가 and the latest trading day) and the HTTP answers it gets, by URL. Session
 * values never appear: Yahoo's crumb is `{crumb}` and the OpenDART key `{key}` in the stored URLs, cookie and
 * crumb steps are not stored (the replay skips them), and no headers are kept.
 *
 * `synthetic: true` fixtures are hand-made in the shapes of the live APIs; `pnpm tsx apps/server/test/record-finance.ts`
 * replaces one with a real recording (docs/ops.md §19.5).
 */

export type Exchange = { url: string; status: number; contentType: string; body: unknown };
export type FinanceFixture = {
  tool: string;
  input: Record<string, unknown>;
  /** ISO time with offset: when the call is made. */
  now: string;
  synthetic: boolean;
  note?: string;
  recordedAt?: string;
  exchanges: Exchange[];
};

export const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/finance");

/** A URL as stored: session values replaced by fixed placeholders. */
export function storedUrl(url: string): string {
  return url.replace(/([?&]crumb=)[^&]*/g, "$1{crumb}").replace(/([?&]crtfc_key=)[^&]*/g, "$1{key}");
}

export function loadFixtures(dir = FIXTURE_DIR): { name: string; fixture: FinanceFixture }[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({
      name: f.replace(/\.json$/, ""),
      fixture: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as FinanceFixture,
    }));
}

/**
 * A worker that answers from fixtures. `requested` collects every URL a job asked for (cookie and crumb steps
 * included), so a test can check them against the tool's allow-list; a URL no fixture has fails the job as the
 * network would (`web_unreachable`) and is listed in `missing`.
 */
export function replayWorker(exchanges: readonly Exchange[]) {
  const requested: RawStep[] = [];
  const missing: string[] = [];
  const used = new Set<Exchange>();
  const worker: FinanceWorker = async (job) => {
    const responses: RawResponse[] = [];
    for (const step of job.steps) {
      requested.push(step);
      if (step.mode) continue;
      const want = storedUrl(step.url);
      const ex = exchanges.find((e) => e.url === want);
      if (!ex) {
        missing.push(want);
        return { ok: false, code: "web_unreachable" };
      }
      used.add(ex);
      responses.push({
        status: ex.status,
        contentType: ex.contentType,
        body: typeof ex.body === "string" ? ex.body : JSON.stringify(ex.body),
      });
    }
    return { ok: true, responses };
  };
  return { worker, requested, missing, unused: () => exchanges.filter((e) => !used.has(e)) };
}
