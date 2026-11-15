import "../env.js";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SKILL_SPECS } from "@agentlee/mcp-tools/skills";
import { loadConfig } from "../config.js";
import { checkInstalled, findSource, installSkill } from "../mcp/install.js";
import { pythonRuntime } from "../mcp/python.js";
import { installPackages, pythonRuntimeEnv, scratchpadState } from "../python/packages.js";
import { sandboxedPythonRunner } from "../python/runner.js";
import { removeTree } from "../python/service.js";
import {
  accountFromConfig,
  jobWorkdir,
  PYTHON_LAUNCHER,
  runLauncherCleanSync,
  runLauncherVerifySync,
} from "../python/account.js";
import { selfCheckAccount } from "../python/selfcheck.js";
import type { PythonEnv } from "../python/packages.js";
import { storagePaths } from "../storage/paths.js";

/**
 * `pnpm skills:install [name…]` copies allow-listed skills (those wrapped in SKILL_SPECS) from the admin's skill
 * folders (SKILL_SOURCES, default ~/.agents/skills:~/.claude/skills) into the server's own `<DATA_DIR>/skills`
 * — only the files each definition lists. `pnpm skills:status` shows what the server would offer.
 * Restart the server afterwards. Prints names and states only (never file contents or secrets).
 *
 * `pnpm python:install` installs the pinned `python_run` packages (#47) for SKILL_PYTHON into
 * `<DATA_DIR>/python-packages/`. `pnpm python:setup-check` only diagnoses (never runs sudo): it runs the launcher's
 * read-only `verify` and compares its scratch root with DATA_DIR/scratch. `pnpm python:check` runs the account self-check and a fixed snippet through the real launcher.
 */
const config = loadConfig();
const root = storagePaths(config.dataDir).skills;
const [cmd, ...names] = process.argv.slice(2);

if (cmd === "install") {
  const unknown = names.filter((n) => !SKILL_SPECS.some((s) => s.name === n));
  if (unknown.length) {
    console.error(`not allow-listed: ${unknown.join(", ")}`);
    process.exit(2);
  }
  let failed = 0;
  for (const spec of SKILL_SPECS.filter((s) => !names.length || names.includes(s.name))) {
    const src = findSource(spec.name, config.skillSources);
    if (!src) {
      console.error(`${spec.name}: not found in ${config.skillSources.join(":")}`);
      failed++;
      continue;
    }
    try {
      const m = installSkill(spec, src, root);
      console.log(`${spec.name}: installed ${Object.keys(m.files).length} file(s) from ${src}`);
    } catch (e) {
      console.error(`${spec.name}: refused — ${(e as Error).message}`);
      failed++;
    }
  }
  process.exit(failed ? 1 : 0);
} else if (cmd === "python-install") {
  const py = pythonRuntime(config.skillPython);
  if (!py.ok) {
    console.error(`python: not usable (${py.reason})`);
    process.exit(1);
  }
  try {
    installPackages(py.runtime, config.dataDir, { log: (l) => console.log(l) });
  } catch (e) {
    console.error(`python_run packages: refused — ${(e as Error).message}`);
    process.exit(1);
  }
  const env = pythonRuntimeEnv(config.skillPython, config.dataDir);
  console.log(`python_run packages: ${env.ok ? "installed" : env.reason}`);
  process.exit(env.ok ? 0 : 1);
} else if (cmd === "python-setup-check") {
  // Diagnosis only — never runs sudo. The trust rules are the launcher's own: its read-only `verify` operation reads
  // the root-owned config and runs exactly the checks `run` runs (#47 round 5), so this command cannot disagree with
  // the launcher. Exit 0 only when everything a run needs is in place (docs/ops.md §35).
  const account = accountFromConfig(config.pythonRunUser);
  const ok: boolean[] = [];
  const report = (label: string, good: boolean, detail = good ? "ok" : "FAIL") => {
    ok.push(good);
    console.log(`${label}: ${detail}`);
  };
  report("PYTHON_RUN", config.pythonRun, config.pythonRun ? "1" : "0 (tool stays off)");
  report("PYTHON_RUN_USER", !!account, account ? account.user : "MISSING or malformed");
  if (account) {
    const v = runLauncherVerifySync(account);
    if (v.error) report(`launcher ${PYTHON_LAUNCHER} verify`, false, `could not run (${v.error})`);
    for (const c of v.checks) report(`  ${c.name}`, c.ok, c.ok ? "ok" : `FAIL (${c.reason})`);
    report(`launcher ${PYTHON_LAUNCHER} verify`, v.ok, v.ok ? "ok" : "FAIL");
    // scratch= must be the server's own DATA_DIR/scratch (the same canonical path).
    let serverScratch: string | undefined;
    try {
      serverScratch = fs.realpathSync.native(storagePaths(config.dataDir).scratch);
    } catch {
      serverScratch = undefined;
    }
    report(
      "  config scratch == DATA_DIR/scratch",
      !!v.scratch && v.scratch === serverScratch,
      v.scratch && v.scratch === serverScratch
        ? "ok"
        : `MISMATCH (config ${v.scratch ?? "?"} vs server ${serverScratch ?? storagePaths(config.dataDir).scratch})`,
    );
  }
  console.log(
    `sudoers: 'sudo -n -u ${account?.user ?? "<account>"} ${PYTHON_LAUNCHER} reap 00000000-0000-0000-0000-000000000000' must not prompt`,
  );
  console.log(
    "note: the scratch ACL is inherited by every job dir, so isolation between jobs is the per-job sandbox profile, not the ACL.",
  );
  console.log(
    "note: verify is advisory (it can miss ACL corner cases); pnpm python:check — the self-check as the account — is authoritative.",
  );
  console.log("then: pnpm python:check");
  process.exit(ok.every(Boolean) ? 0 : 1);
} else if (cmd === "python-check") {
  const base = pythonRuntimeEnv(config.skillPython, config.dataDir);
  if (!base.ok) {
    console.error(`python_run: ${base.reason}`);
    process.exit(1);
  }
  const account = accountFromConfig(config.pythonRunUser);
  let env: PythonEnv = base.env;
  if (account) {
    // The same authoritative self-check the server runs at start: the probe, then a real job end to end.
    const v = await selfCheckAccount({
      account,
      env: base.env,
      dataDir: config.dataDir,
      serverUid: process.getuid?.() ?? -1,
    });
    if (!v.ok) {
      console.error(`account self-check failed at step ${v.step}: ${v.reason}`);
      // Say so plainly when the advisory diagnosis disagrees: the self-check is what decides.
      if (runLauncherVerifySync(account).ok)
        console.error(
          "note: `pnpm python:setup-check` (verify, advisory) passes, but the self-check as the account FAILED — the self-check is authoritative; python_run stays off.",
        );
      process.exit(1);
    }
    console.log(
      `account self-check: ok (uid ${v.uid}, KERN_PROCARGS2 blocked; a real job read its input, imported numpy + pandas and wrote its output)`,
    );
    env = { ...base.env, account, accountUid: v.uid };
  } else {
    console.error("PYTHON_RUN_USER not set — running as the server uid (NOT the production path); see §35");
  }
  const jobId = crypto.randomUUID();
  const workdir = jobWorkdir(config.dataDir, jobId);
  fs.mkdirSync(path.join(workdir, ".tmp"), { recursive: true, mode: 0o700 });
  // The exit code is set, never exited with, inside the try: the working folder goes first (review #121 round 1).
  let code = 1;
  try {
    const r = await sandboxedPythonRunner()({
      code: [
        "import sys, numpy, pandas, socket",
        "print('python', sys.version.split()[0], 'numpy', numpy.__version__, 'pandas', pandas.__version__)",
        "print('sum', int(pandas.Series(numpy.arange(101)).sum()))",
        "try:\n    socket.create_connection(('1.1.1.1', 443), timeout=3); print('network: OPEN')",
        "except OSError:\n    print('network: blocked')",
      ].join("\n"),
      workdir,
      jobId,
      files: {},
      inputBytes: 0,
      env,
      dataDir: config.dataDir,
    });
    if (!r.ok) console.error(`python_run: ${r.code}`);
    else {
      process.stdout.write(r.report.stdout);
      code = r.report.status === "ok" && r.report.stdout.includes("network: blocked") ? 0 : 1;
    }
  } finally {
    if (account) runLauncherCleanSync(account, jobId);
    if (!removeTree(workdir)) {
      console.error(`could not remove ${workdir}`);
      code = 1;
    }
  }
  process.exit(code);
} else if (cmd === "status") {
  const py = pythonRuntime(config.skillPython);
  const pad = scratchpadState(config.skillPython, config.dataDir, { pythonRun: config.pythonRun });
  console.log(`skill folder: ${root}`);
  console.log(`python: ${py.ok ? py.runtime.exe : `not usable (${py.reason})`}`);
  console.log(`python_run: ${pad.state}${pad.state === "available" ? "" : ` (${pad.reason})`}`);
  for (const spec of SKILL_SPECS) console.log(`${spec.name}: ${checkInstalled(spec, root).state}`);
  console.log(`secrets set: ${Object.keys(config.skillSecrets).join(", ") || "none"}`);
} else {
  console.error(
    "usage: skills install [name…] | skills status | skills python-install | skills python-setup-check | skills python-check",
  );
  process.exit(2);
}
