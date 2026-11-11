/**
 * Records one finance fixture from the live data source (#30), for the snapshot tests to replay. Runs the call
 * exactly as the server does — the sandboxed fetch worker through an egress proxy that reaches only the tool's
 * hosts — and replaces `test/fixtures/finance/<name>.json` with what came back (`synthetic: false`).
 *
 *   pnpm --filter @agentlee/server exec tsx --conditions=development test/record-finance.ts <fixture-name>
 *
 * The fixture's tool and input are kept; `now` becomes the time of the recording (it decides 장중 / 종가).
 * Needs macOS (sandbox) and the network; dart_disclosures needs OPENDART_API_KEY and sec_* SEC_USER_AGENT in
 * `.env`. Nothing secret is written: the crumb and the OpenDART key are placeholders in the stored URLs, cookie and
 * crumb steps are not stored, no headers are kept, and the write is refused if a secret value is still in a body.
 * Afterwards: `pnpm vitest run apps/server/test/finance.test.ts -u` and review the snapshot diff (docs/ops.md §19.5).
 */
import fs from "node:fs";
import path from "node:path";
import { config as loadEnv } from "dotenv";
import { FINANCE_TOOLS } from "@agentlee/mcp-tools/finance";
import { isoLocal } from "../src/finance/calendar.js";
import { FinanceService, FINANCE_SECRET_NAMES, type FinanceWorker } from "../src/finance/service.js";
import { EgressService } from "../src/isolation/egress.js";
import { sandboxedWorker } from "../src/web/service.js";
import { FIXTURE_DIR, storedUrl, type Exchange, type FinanceFixture } from "./helpers/finance-replay.js";

loadEnv({ path: path.resolve(import.meta.dirname, "../../../.env"), quiet: true });
const name = process.argv[2];
if (!name || !/^[\w-]+$/.test(name)) {
  console.error("usage: record-finance.ts <fixture-name>   (a file in test/fixtures/finance)");
  process.exit(2);
}
const file = path.join(FIXTURE_DIR, `${name}.json`);
const old = JSON.parse(fs.readFileSync(file, "utf8")) as FinanceFixture;
const tool = FINANCE_TOOLS.find((t) => t.name === old.tool);
if (!tool) throw new Error(`unknown tool ${old.tool}`);
const secrets = Object.fromEntries(
  FINANCE_SECRET_NAMES.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])),
);
const secretValues = Object.values(secrets).filter((v) => v.length >= 1);

const exchanges: Exchange[] = [];
const real = sandboxedWorker();
const recording: FinanceWorker = async (job, proxy) => {
  const r = await real(job, proxy);
  if (r.ok && Array.isArray(r.responses)) {
    const data = job.steps.filter((s) => !s.mode);
    (r.responses as { status: number; contentType: string; body: string }[]).forEach((res, i) => {
      let body: unknown = res.body;
      try {
        body = JSON.parse(res.body);
      } catch {
        // stored as text
      }
      exchanges.push({
        url: storedUrl(data[i]!.url),
        status: res.status,
        contentType: res.contentType,
        body,
      });
    });
  }
  return r;
};

const egress = new EgressService({ allow: tool.hosts });
const now = Date.now();
const svc = new FinanceService(recording, () => egress.endpoint(), { secrets, now: () => now });
try {
  const result = await svc.run(tool, old.input);
  const text = JSON.stringify(exchanges);
  if (secretValues.some((v) => text.includes(v)))
    throw new Error("a secret is in the recording — not written");
  if (!exchanges.length) throw new Error(`nothing recorded (${result.ok ? "ok" : result.code})`);
  const tz =
    tool.name.startsWith("kr_") || tool.name === "dart_disclosures" ? "Asia/Seoul" : "America/New_York";
  const next: FinanceFixture = {
    tool: old.tool,
    input: old.input,
    now: isoLocal(now, tz),
    synthetic: false,
    note: `recorded from the live source on ${new Date(now).toISOString().slice(0, 10)}`,
    recordedAt: new Date(now).toISOString(),
    exchanges,
  };
  fs.writeFileSync(file, JSON.stringify(next, null, 1) + "\n");
  console.log(`${name}: ${exchanges.length} answer(s) recorded (${result.ok ? "ok" : result.code})`);
} finally {
  await egress.close();
}
