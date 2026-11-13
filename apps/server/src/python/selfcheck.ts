import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyAccount, runLauncherCleanSync, type ProbeRunner, type PythonAccount } from "./account.js";
import type { PythonEnv } from "./packages.js";
import { sandboxedPythonRunner, type PythonJob, type PythonRunner } from "./runner.js";
import { collectOutputs, makeJobWorkdir, removeTree, writeInputCopy } from "./service.js";

/**
 * The account self-check (#47 rounds 2-8) — the **authoritative** check (the launcher's `verify` is advisory).
 * Runs at server start and in `pnpm python:check`; `python_run` is offered only when it passes.
 *
 * 1. `probe`: as the account, inside the job sandbox, the child's uid differs from the server's and a server-uid
 *    sibling's KERN_PROCARGS2 is blocked (`verifyAccount`).
 * 2. A **real job through the normal path** (#121 round 8): the same work-dir creation (`makeJobWorkdir` — `.tmp`
 *    included), a server-owned input copied in exactly as a call copies one (`writeInputCopy`), the same runner
 *    (`sandboxedPythonRunner` → `sudo … launcher run`: the launcher's trust checks as the account, `.ctl`, the run
 *    record, stdin staging, the fixed environment, the memory/time watch, the sandbox profile), a fixed script that
 *    reads that input, imports numpy + pandas from the configured packages and writes an output file; then the
 *    server collects the output exactly as for a real call (`collectOutputs`) and checks the account owns it, and
 *    cleans up through the launcher's `clean`.
 *
 * Any failure → `{ ok: false }` naming the failed step; the tool stays off.
 */

export const SELF_CHECK_INPUT = "a,b\n1,2\n3,4\n";
export const SELF_CHECK_CODE = [
  "import numpy, pandas",
  'df = pandas.read_csv(FILES["selfcheck"])',
  'total = int(df["a"].sum() + df["b"].sum())',
  "n = int(numpy.arange(101).sum())",
  'with open("selfcheck-out.csv", "w") as f:',
  '    f.write("total,%d\\n" % total)',
  'print("selfcheck ok", total, n)',
].join("\n");
const WANT_STDOUT = "selfcheck ok 10 5050\n";
const WANT_OUTPUT = "total,10\n";

export type SelfCheckResult = { ok: true; uid: number } | { ok: false; step: string; reason: string };

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function selfCheckAccount(opts: {
  account: PythonAccount;
  /** The interpreter + packages the server uses (`pythonRuntimeEnv`). */
  env: PythonEnv;
  dataDir: string;
  serverUid: number;
  /** A cleanup step that failed (logged; the check itself still answers). */
  onCleanupError?: (what: string, reason: string) => void;
  /** Tests only: replace the launcher probe / the job runner / the owner lookup of the output / the clean / tmp. */
  probe?: ProbeRunner;
  runner?: PythonRunner;
  ownerOf?: (file: string) => number;
  clean?: (account: PythonAccount, jobId: string) => void;
  tmpDir?: () => string;
  /**
   * Shutdown (#121 round 10): no new step starts once it is aborted; the probe and the job get it (the runner reaps
   * the launcher job on abort), and the cleanup below still runs before this resolves.
   */
  signal?: AbortSignal;
}): Promise<SelfCheckResult> {
  const fail = (step: string, reason: string): SelfCheckResult => ({ ok: false, step, reason });
  // Never throws (#121 round 9): every step's exception becomes { ok: false, step }; cleanup is best-effort, step
  // by step, each in its own try.
  let step = "probe";
  let made: { jobId: string; dir: string } | undefined;
  let src: string | undefined;
  let result: SelfCheckResult;
  const go = (next: string) => {
    step = next;
    if (opts.signal?.aborted) throw new Error("aborted");
  };
  try {
    go("probe");
    const v = await verifyAccount({
      account: opts.account,
      dataDir: opts.dataDir,
      serverUid: opts.serverUid,
      ...(opts.probe ? { run: opts.probe } : {}),
      ...(opts.clean ? { clean: opts.clean } : {}),
      signal: opts.signal,
    });
    if (!v.ok) return (result = fail("probe", v.reason));
    const uid = v.uid;

    go("workdir");
    made = makeJobWorkdir(opts.dataDir);
    const dir = made.dir;

    // The input: a server-owned copy made exactly as a call makes one.
    go("input");
    src = fs.mkdtempSync(path.join((opts.tmpDir ?? os.tmpdir)(), "agentlee-selfcheck-"));
    const data = Buffer.from(SELF_CHECK_INPUT, "utf8");
    const sha256 = crypto.createHash("sha256").update(data).digest("hex");
    const srcFile = path.join(src, "input.csv");
    fs.writeFileSync(srcFile, data, { mode: 0o600 });
    const fd = fs.openSync(srcFile, "r");
    let copied: boolean;
    try {
      copied = writeInputCopy(fd, path.join(dir, "selfcheck-input.csv"), data.length, sha256);
    } finally {
      fs.closeSync(fd);
    }
    if (!copied) return (result = fail("input", "the copy does not match"));

    go("run");
    const job: PythonJob = {
      code: SELF_CHECK_CODE,
      workdir: dir,
      files: { selfcheck: "selfcheck-input.csv" },
      inputBytes: data.length,
      env: { ...opts.env, account: opts.account, accountUid: uid },
      dataDir: opts.dataDir,
      jobId: made.jobId,
    };
    const r = await (opts.runner ?? sandboxedPythonRunner())(job, opts.signal);
    if (!r.ok) return (result = fail("run", r.code));
    go("report");
    if (r.report.status !== "ok" || r.report.stdout !== WANT_STDOUT)
      return (result = fail("report", `${r.report.status} ${r.report.errorType ?? ""}`.trim()));

    // The output, collected as for a real call: the one file, its text, owned by the account (it really ran there).
    go("output");
    const skipped: string[] = [];
    const outs = collectOutputs(
      dir,
      new Map([["selfcheck-input.csv", { bytes: data.length, sha256 }]]),
      (name, why) => skipped.push(`${name}:${why}`),
      new Set([opts.serverUid, uid]),
    );
    if (
      skipped.length ||
      outs.length !== 1 ||
      outs[0]!.rel !== "selfcheck-out.csv" ||
      outs[0]!.text !== WANT_OUTPUT
    )
      return (result = fail("output", skipped.join(",") || `${outs.length} output(s)`));
    const owner = (opts.ownerOf ?? ((f: string) => fs.lstatSync(f).uid))(path.join(dir, "selfcheck-out.csv"));
    if (owner !== uid)
      return (result = fail("output", `the output is owned by uid ${owner}, not the account`));
    return (result = { ok: true, uid });
  } catch (e) {
    return (result = fail(step, message(e)));
  } finally {
    // Best-effort, independent cleanup; a failure is logged, never thrown. The work dir not going is a failed check.
    const cleanupError = (what: string, e: unknown) => {
      try {
        opts.onCleanupError?.(what, message(e));
      } catch {
        // a logger that throws must not undo the answer
      }
    };
    if (src)
      try {
        fs.rmSync(src, { recursive: true, force: true });
      } catch (e) {
        cleanupError("tmp", e);
      }
    if (made) {
      try {
        (opts.clean ?? runLauncherCleanSync)(opts.account, made.jobId);
      } catch (e) {
        cleanupError("launcher-clean", e);
      }
      let removed = false;
      try {
        removed = removeTree(made.dir);
      } catch (e) {
        cleanupError("workdir", e);
      }
      if (!removed) {
        cleanupError("workdir", `could not remove ${made.dir}`);
        // eslint-disable-next-line no-unsafe-finally
        if (result! && result.ok) return fail("cleanup", `could not remove ${made.dir}`);
      }
    }
  }
}

/**
 * The gate the server keeps for `python_run` (#121 round 9): the self-check runs **in the background** after the
 * server is ready (it may take up to the 30 s job limit — never inside a startup hook). Until it passes the tool is
 * absent (`needs_account`, reason "checking: …"); it is offered only once it has passed; a failure — or anything it
 * throws — keeps it off with the failed step as the reason. `start` never throws or rejects.
 */
export class AccountSelfCheckGate {
  private verifiedAccount: { account: PythonAccount; uid: number } | undefined;
  private why: string;
  /** The running check, for tests and shutdown. */
  done: Promise<void> = Promise.resolve();
  private readonly abort = new AbortController();

  constructor(private readonly account: PythonAccount | undefined) {
    this.why = account
      ? "checking: the account self-check has not started"
      : "PYTHON_RUN_USER not configured";
  }

  get verified(): { account: PythonAccount; uid: number } | undefined {
    return this.verifiedAccount;
  }

  get reason(): string {
    return this.why;
  }

  /** Not checked at all (e.g. the interpreter is not ready): stays off with this reason. */
  skip(reason: string): void {
    this.why = reason;
  }

  /**
   * Shutdown (#121 round 10): aborts the running check (its probe/job are stopped, no new step starts) and waits —
   * at most `boundMs` — for it to finish its cleanup. Never throws.
   */
  async stop(boundMs: number): Promise<void> {
    this.abort.abort();
    if (!this.verifiedAccount && this.why.startsWith("checking"))
      this.why = "self-check stopped: shutting down";
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.done,
      new Promise<void>((r) => {
        timer = setTimeout(r, boundMs);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
  }

  start(
    run: (signal: AbortSignal) => Promise<SelfCheckResult>,
    log?: (ok: boolean, detail: string) => void,
  ): Promise<void> {
    const account = this.account;
    if (!account) return this.done;
    if (this.abort.signal.aborted) {
      this.why = "self-check stopped: shutting down";
      return this.done;
    }
    this.why = "checking: the account self-check is running";
    const report = (ok: boolean, detail: string) => {
      try {
        log?.(ok, detail);
      } catch {
        // logging never decides the gate
      }
    };
    this.done = (async () => {
      try {
        const v = await run(this.abort.signal);
        if (this.abort.signal.aborted && !v.ok) {
          this.why = "self-check stopped: shutting down";
          report(false, "aborted");
          return;
        }
        if (v.ok) {
          this.verifiedAccount = { account, uid: v.uid };
          this.why = "";
          report(true, "");
        } else {
          this.why = `self-check step ${v.step} failed: ${v.reason}`;
          report(false, v.step);
        }
      } catch (e) {
        this.why = `self-check failed: ${message(e)}`;
        report(false, "exception");
      }
    })();
    return this.done;
  }
}
