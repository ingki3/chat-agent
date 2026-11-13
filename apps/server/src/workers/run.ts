import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { RunResult } from "../isolation/sandbox.js";
import { launcherKilled, REAP_RETRIES } from "../python/runner.js";
import { removeTree } from "../python/service.js";
import {
  reapWorker,
  runWorkerCleanSync,
  workerJobDir,
  workerLauncherRun,
  workerScratchRoot,
  type LauncherKind,
  type WorkerAccount,
} from "./account.js";

/**
 * Running one worker job through the worker account's launcher (#122): the job folder the server makes, the sudo
 * command, the output cap, the stop by `reap`, the clean-up across uids. The same shape as python_run's
 * `runViaLauncher` (`python/runner.ts`): the launcher enforces the wall clock and resident memory itself (exit
 * 124 / 125); the server's timer is a backstop and — because the server cannot signal the account's process — it
 * stops the run by asking the launcher to `reap` the recorded, verified child.
 */

export class WorkerUnavailableError extends Error {
  constructor(why: string) {
    super(why);
  }
}

/**
 * A fresh job folder `<worker-scratch>/<uuid>` (server-owned, 0700 — the scratch root's inherited ACL lets the
 * account use it). The root is made if missing (it must not be a link).
 */
export function makeWorkerJobDir(dataDir: string): { jobId: string; dir: string } {
  const root = workerScratchRoot(dataDir);
  let st = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!st) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    st = fs.lstatSync(root);
  }
  if (st.isSymbolicLink() || !st.isDirectory())
    throw new WorkerUnavailableError("worker scratch is not a folder");
  const jobId = crypto.randomUUID();
  const dir = workerJobDir(dataDir, jobId);
  if (fs.lstatSync(dir, { throwIfNoEntry: false })) throw new WorkerUnavailableError("job folder exists");
  fs.mkdirSync(dir, { mode: 0o700 });
  return { jobId, dir: fs.realpathSync.native(dir) };
}

/**
 * Removes a job's folder and run record: through the launcher's `clean` first (as the account — it restores modes
 * the job may have cleared), then the server's own removal. Never throws; false when something is left (the next
 * start's sweep tries again).
 */
export function removeWorkerJob(
  account: WorkerAccount,
  dataDir: string,
  jobId: string,
  clean: (account: WorkerAccount, jobId: string) => void = runWorkerCleanSync,
): boolean {
  try {
    clean(account, jobId);
  } catch {
    // the server's removal below is the backstop
  }
  const ctl = path.join(workerScratchRoot(dataDir), ".ctl", jobId);
  const a = removeTree(workerJobDir(dataDir, jobId));
  const b = removeTree(ctl);
  return a && b;
}

/**
 * Removes the job folders left by an earlier process (server start, before any job runs). Keeps the root and its
 * `.ctl` control folder (the installed ACL is on the root and inherited by both). A leftover is removed through the
 * launcher's `clean` when there is an account (by its UUID name), then by the server. Never throws.
 */
export function sweepWorkerScratch(dataDir: string, account?: WorkerAccount): boolean {
  const root = workerScratchRoot(dataDir);
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return true;
  }
  let ok = true;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  for (const n of names) {
    if (n === ".ctl") {
      try {
        for (const j of fs.readdirSync(path.join(root, ".ctl")))
          if (!removeTree(path.join(root, ".ctl", j))) ok = false;
      } catch {
        ok = false;
      }
      continue;
    }
    if (account && uuid.test(n)) runWorkerCleanSync(account, n);
    if (!removeTree(path.join(root, n))) ok = false;
  }
  return ok;
}

export type WorkerSpawn = (command: string, args: string[]) => ChildProcess;
const defaultSpawn: WorkerSpawn = (command, args) =>
  spawn(command, args, { env: {}, stdio: ["pipe", "pipe", "pipe"], detached: true });

/**
 * One stdin → stdout job (extract, ocr, docgen) through `sudo … launcher run <kind> <jobId> <timeout>`. The JSON
 * goes on stdin; stdout and stderr are captured with the same cap the same-uid sandbox uses. Returns a `RunResult`
 * as `runIsolated` would (`killed`: our cap/abort/backstop, or the launcher's own 124 timeout / 125 memory).
 */
export function runWorkerJob(o: {
  account: WorkerAccount;
  kind: Exclude<LauncherKind, "render">;
  jobId: string;
  timeoutMs: number;
  maxOutputBytes: number;
  stdin: string;
  signal?: AbortSignal | undefined;
  /** Tests only: replace the spawn of sudo / the reap. */
  spawn?: WorkerSpawn;
  reap?: (account: WorkerAccount, jobId: string, onExit: (code: number | null) => void) => void;
}): Promise<RunResult> {
  // The launcher's own limit is in whole seconds; the server waits a little longer before it reaps.
  const timeoutSec = Math.ceil(o.timeoutMs / 1000);
  const { command, args } = workerLauncherRun(o.account, o.kind, o.jobId, timeoutSec);
  const reap = o.reap ?? reapWorker;
  return new Promise<RunResult>((resolve, reject) => {
    const child = (o.spawn ?? defaultSpawn)(command, args);
    let out = "";
    let err = "";
    let bytes = 0;
    let killed: RunResult["killed"] = null;
    let done = false;
    const outDec = new StringDecoder("utf8");
    const errDec = new StringDecoder("utf8");
    // reap exits 0 only when it killed the verified process or found it gone; otherwise retry a few times while
    // the run is open, then leave it to the launcher's own wall-clock limit (python_run's rule, #121 round 6).
    const reapOnce = (left: number) =>
      reap(o.account, o.jobId, (code) => {
        if (code !== 0 && left > 0 && !done) setTimeout(() => reapOnce(left - 1), 500).unref();
      });
    const stop = (why: NonNullable<RunResult["killed"]>) => {
      if (killed || done) return;
      killed = why;
      reapOnce(REAP_RETRIES);
    };
    const take = (d: StringDecoder, add: (t: string) => void) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > o.maxOutputBytes) return stop("output");
      add(d.write(chunk));
    };
    child.stdout!.on(
      "data",
      take(outDec, (t) => (out += t)),
    );
    child.stderr!.on(
      "data",
      take(errDec, (t) => (err += t)),
    );
    child.stdin!.on("error", () => {});
    const timer = setTimeout(() => stop("timeout"), o.timeoutMs + 2000);
    const onAbort = () => stop("aborted");
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener("abort", onAbort, { once: true });
    const finish = () => {
      done = true;
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
    };
    child.on("error", (e) => {
      finish();
      reject(e);
    });
    child.on("close", (code, sig) => {
      finish();
      resolve({
        code,
        signal: sig,
        stdout: out + outDec.end(),
        stderr: err + errDec.end(),
        killed: launcherKilled(code, killed),
      });
    });
    child.stdin!.end(o.stdin);
  });
}
