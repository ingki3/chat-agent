import "../env.js";
import fs from "node:fs";
import { loadConfig } from "../config.js";
import { Renderer } from "../artifacts/export.js";
import { ocrCapability } from "../files/extract.js";
import { storagePaths } from "../storage/paths.js";
import {
  runWorkerVerifySync,
  WORKER_CONF,
  WORKER_KINDS,
  WORKER_LAUNCHER,
  workerAccountFromConfig,
} from "../workers/account.js";
import { bundleWorkers } from "../workers/bundle.js";
import { docJobCheck, extractJobCheck, renderJobCheck, selfCheckWorker } from "../workers/selfcheck.js";

/**
 * The sandboxed workers' account (#122, docs/ops.md §41). None of these runs sudo.
 *
 * - `pnpm workers:bundle <out>` — the program bundle (node, the worker programs and their pinned libraries, the
 *   OCR data, the headless shell) for the administrator to install root-owned.
 * - `pnpm workers:setup-check` — diagnosis only: the launcher's read-only `verify` (the same trust checks a run
 *   makes, advisory) and that its scratch root is DATA_DIR/worker-scratch.
 * - `pnpm workers:check` — the authoritative self-check of every worker kind, as the server runs it at start.
 */
const config = loadConfig();
const [cmd, ...rest] = process.argv.slice(2);
const account = workerAccountFromConfig(config.workerRunUser);

if (cmd === "bundle") {
  const out = rest[0];
  if (!out || rest.length !== 1) {
    console.error("usage: workers bundle <new folder>");
    process.exit(2);
  }
  try {
    const r = bundleWorkers(out, { browser: config.exportBrowser });
    console.log(`bundle: ${out} (${r.nodes} entries) — install it root-owned as docs/ops.md §41.2 says`);
  } catch (e) {
    console.error(`bundle: refused — ${(e as Error).message}`);
    process.exit(1);
  }
} else if (cmd === "setup-check") {
  const ok: boolean[] = [];
  const report = (label: string, good: boolean, detail = good ? "ok" : "FAIL") => {
    ok.push(good);
    console.log(`${label}: ${detail}`);
  };
  report("WORKER_RUN_USER", !!account, account ? account.user : "MISSING or malformed");
  if (account) {
    const v = runWorkerVerifySync(account);
    if (v.error) report(`launcher ${WORKER_LAUNCHER} verify`, false, `could not run (${v.error})`);
    for (const c of v.checks) report(`  ${c.name}`, c.ok, c.ok ? "ok" : `FAIL (${c.reason})`);
    report(`launcher ${WORKER_LAUNCHER} verify (${WORKER_CONF})`, v.ok, v.ok ? "ok" : "FAIL");
    let serverScratch: string | undefined;
    try {
      serverScratch = fs.realpathSync.native(storagePaths(config.dataDir).workerScratch);
    } catch {
      serverScratch = undefined;
    }
    report(
      "  config scratch == DATA_DIR/worker-scratch",
      !!v.scratch && v.scratch === serverScratch,
      v.scratch && v.scratch === serverScratch
        ? "ok"
        : `MISMATCH (config ${v.scratch ?? "?"} vs server ${serverScratch ?? storagePaths(config.dataDir).workerScratch})`,
    );
  }
  console.log(
    `sudoers: 'sudo -n -u ${account?.user ?? "<account>"} ${WORKER_LAUNCHER} reap 00000000-0000-0000-0000-000000000000' must not prompt`,
  );
  console.log(
    "note: verify is advisory; pnpm workers:check — the self-check as the account — is authoritative.",
  );
  console.log("then: pnpm workers:check");
  process.exit(ok.every(Boolean) ? 0 : 1);
} else if (cmd === "check") {
  if (!account) {
    console.error(
      "WORKER_RUN_USER not set — every worker runs in the same-uid sandbox (NOT isolated by account); see §41",
    );
    process.exit(1);
  }
  const renderer = new Renderer({
    browser: undefined,
    account: { verified: () => undefined, dataDir: config.dataDir },
  });
  let code = 0;
  try {
    const ocr = () => ocrCapability(storagePaths(config.dataDir).ocrLang);
    for (const kind of WORKER_KINDS) {
      const v = await selfCheckWorker({
        kind,
        account,
        dataDir: config.dataDir,
        serverUid: process.getuid?.() ?? -1,
        job:
          kind === "extract"
            ? extractJobCheck(config.dataDir, ocr)
            : kind === "docgen"
              ? docJobCheck(config.dataDir)
              : renderJobCheck(renderer),
      });
      if (v.ok)
        console.log(`${kind}: ok (uid ${v.uid}, KERN_PROCARGS2 blocked; a real job ran as the account)`);
      else {
        code = 1;
        console.error(
          `${kind}: self-check failed at step ${v.step}: ${v.reason} — stays in the same-uid sandbox`,
        );
      }
    }
    if (code && runWorkerVerifySync(account).ok)
      console.error(
        "note: `pnpm workers:setup-check` (verify, advisory) passes, but a self-check as the account FAILED — the self-check decides.",
      );
    console.log("restart the server: the checks run once at start and their result is kept.");
  } finally {
    await renderer.close();
  }
  process.exit(code);
} else {
  console.error("usage: workers bundle <out> | workers setup-check | workers check");
  process.exit(2);
}
