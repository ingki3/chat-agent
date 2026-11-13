import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { PYTHON_LIMITS, type PythonCode } from "@agentlee/shared";
import { runIsolated, type RunIsolatedOptions, type RunResult } from "../isolation/sandbox.js";
import { launcherReap, launcherRun, type PythonAccount } from "./account.js";
import { RUNNER_ENTRY, SCRATCHPAD_DIR, type PythonEnv } from "./packages.js";

/**
 * How `python_run` code runs (#47, PRD NFR 격리): `apps/server/scratchpad/runner.py` under the configured standalone
 * python, in its own sandboxed process (#42) —
 *
 * - **reads** the interpreter's install folder, the runner's folder and the pinned package folder (program folders,
 *   trusted, read-only), and its working folder; nothing else — no other conversation's working folder, no stored
 *   file, no home folder;
 * - **writes** its working folder only (`scratch/<user>/<conversation>/<call>`, made fresh for the call);
 * - **no network** (not even loopback), **no child processes** (no `process-fork`), an environment of a few fixed
 *   variables — no secret, nothing inherited from the server;
 * - **limits**: wall clock and CPU time, resident memory, output, the size of one file (RLIMIT_FSIZE) and of the
 *   whole working folder (watched here while it runs: over it, the process is killed — `python_disk_limit`).
 *
 * There is no other way to run it: no in-process or unsandboxed variant, whatever the configuration
 * (`ISOLATION_IN_PROCESS_FOR_TESTS`, `FAKE_RUNTIME`). Tests that do not need a real interpreter give the service a
 * runner of their own; off macOS the sandboxed runner answers `python_unavailable`.
 *
 * In production (`env.account`, #47 round 2) the process does not run as the server's uid: the server spawns
 * `sudo -n -u <account> <launcher> run …` and the root-owned launcher drops to the account and execs
 * `sandbox-exec` + python. The server cannot signal that other-uid process group, so on timeout/abort it stops the
 * run by spawning the launcher's `reap` (also under sudo); the launcher itself also enforces the wall-clock
 * timeout. The data path — which folder, which files — is still the server's; the launcher only receives validated
 * paths. `dataDir` is needed to build (and re-validate) the sudo command.
 */

export type PythonJob = {
  code: string;
  /** The call's working folder (absolute, canonical): the code's current folder, its only writable place. */
  workdir: string;
  /** fileId → local file name in the working folder (the code's `FILES`). */
  files: Record<string, string>;
  /** Bytes of the input copies (the working folder may grow by `PYTHON_LIMITS.workBytes` beyond them). */
  inputBytes: number;
  env: PythonEnv;
  /** DATA_DIR, so the server can derive the work dir and read outputs. */
  dataDir: string;
  /** The job id (a UUID): the work dir is `<scratch>/<jobId>`, and the launcher takes only this token. */
  jobId: string;
};

export const PythonReport = z.strictObject({
  status: z.enum(["ok", "error"]),
  exitCode: z.number().int(),
  errorType: z.string().max(100).nullable(),
  traceback: z.string().nullable(),
  stdout: z.string(),
  stdoutChars: z.number().int().nonnegative(),
  stderr: z.string(),
  stderrChars: z.number().int().nonnegative(),
});
export type PythonReport = z.infer<typeof PythonReport>;

export type PythonRunResult = { ok: true; report: PythonReport } | { ok: false; code: PythonCode };

/** Runs one job. `signal`: the server is shutting down (the process is stopped). */
export type PythonRunner = (job: PythonJob, signal?: AbortSignal) => Promise<PythonRunResult>;

/** The process limits (shared numbers: `PYTHON_LIMITS`). */
export const PYTHON_PROCESS_LIMITS = {
  timeoutMs: PYTHON_LIMITS.timeoutMs,
  maxRssBytes: PYTHON_LIMITS.memoryBytes,
  /**
   * The report: two captured streams as JSON (an escaped control character takes 6 bytes, a character up to 4) and
   * the traceback — and a little more.
   */
  maxOutputBytes: PYTHON_LIMITS.captureChars * 2 * 6 + 256 * 1024,
};

/** The environment of the process: fixed values only. */
export function pythonEnvVars(workdir: string): Record<string, string> {
  return {
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    HOME: workdir,
    TMPDIR: path.join(workdir, ".tmp"),
    // One thread for the numeric libraries: predictable memory, and no thread pools to start.
    OPENBLAS_NUM_THREADS: "1",
    OMP_NUM_THREADS: "1",
    MKL_NUM_THREADS: "1",
  };
}

/** The JSON the interpreter-side runner reads on stdin (the same whichever way the process is started). */
export function jobStdin(job: PythonJob): string {
  return JSON.stringify({
    code: job.code,
    files: job.files,
    packages: job.env.packages ?? null,
    limits: {
      cpuSeconds: PYTHON_LIMITS.cpuSeconds,
      fileBytes: PYTHON_LIMITS.fileBytes,
      captureChars: PYTHON_LIMITS.captureChars,
    },
  });
}

/** The sandbox run of one job as the server's own uid (tests / the CLI self-check; never offered to the model). */
export function pythonRunOptions(job: PythonJob): RunIsolatedOptions {
  const { runtime, packages } = job.env;
  return {
    command: runtime.exe,
    // -I: no PYTHON* variables, no user site, no script folder on sys.path. -S: no site-packages. -B: no .pyc.
    args: ["-I", "-S", "-B", RUNNER_ENTRY],
    cwd: job.workdir,
    env: pythonEnvVars(job.workdir),
    read: [],
    trusted: [runtime.root, SCRATCHPAD_DIR, ...(packages ? [packages] : [])],
    write: [job.workdir],
    network: "none",
    noFlagChanges: true,
    stdin: jobStdin(job),
    ...PYTHON_PROCESS_LIMITS,
  };
}

/**
 * Runs one job through the dedicated-account launcher (#47 round 2): `sudo -n -u <account> <launcher> run …`, the
 * JSON on stdin, stdout/stderr captured with the same output cap. The launcher enforces the wall-clock timeout and
 * the resident-memory limit (its own 250 ms watch — exit 124 / 125); a server-side timer (a little longer) is the
 * backstop and, because the server cannot signal the other-uid group,
 * it stops the run by spawning the launcher's `reap`. Returns a `RunResult`, as `runIsolated` would.
 */
/**
 * Why a launcher run ended: our backstop timer (if it fired) wins; otherwise exit code 124 means the launcher's own
 * wall-clock timer fired (it SIGKILLed the job) — a timeout, distinct from an ordinary non-zero exit (#47 round 4) —
 * and 125 means its memory watch killed the job: over the resident limit, or the memory could not be measured
 * (fail closed) — `python_memory_limit` (#47 round 5).
 */
export const LAUNCHER_EXIT_TIMEOUT = 124;
export const LAUNCHER_EXIT_MEMORY = 125;
export function launcherKilled(code: number | null, prior: RunResult["killed"]): RunResult["killed"] {
  if (prior) return prior;
  if (code === LAUNCHER_EXIT_TIMEOUT) return "timeout";
  if (code === LAUNCHER_EXIT_MEMORY) return "memory";
  return null;
}

/** How many times the server re-asks the launcher's reap when it could not verify (and so did not kill). */
export const REAP_RETRIES = 3;

export function runViaLauncher(
  job: PythonJob,
  account: PythonAccount,
  limits: { timeoutMs: number; maxOutputBytes: number },
  signal?: AbortSignal,
): Promise<RunResult> {
  // The launcher's own timeout is in whole seconds; the server waits a little longer before it reaps.
  const timeoutSec = Math.ceil(limits.timeoutMs / 1000);
  const { command, args } = launcherRun(account, job.jobId, timeoutSec);
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, args, { env: {}, stdio: ["pipe", "pipe", "pipe"], detached: true });
    const pid = child.pid!;
    let out = "";
    let err = "";
    let bytes = 0;
    let killed: RunResult["killed"] = null;
    let done = false;
    const outDec = new StringDecoder("utf8");
    const errDec = new StringDecoder("utf8");
    // The server's uid cannot signal the account's process group; the launcher's reap (under sudo) can. reap exits
    // 0 only when it killed the verified process or found it already gone; anything else (no record yet, identity
    // not verifiable) is not a success: retry a few times while the run is still open, then leave it to the
    // launcher's own wall-clock limit (#121 round 6).
    const reapOnce = (left: number) => {
      try {
        const r = launcherReap(account, job.jobId);
        const p = spawn(r.command, r.args, { env: {}, stdio: "ignore", detached: true });
        p.on("error", () => {});
        p.on("exit", (code) => {
          if (code !== 0 && left > 0 && !done) setTimeout(() => reapOnce(left - 1), 500).unref();
        });
        p.unref();
      } catch {
        // a bad job id: nothing to reap; the launcher's own timeout still stops the run
      }
    };
    const reap = () => {
      reapOnce(REAP_RETRIES);
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // the other-uid process is sudo's job to reap; ignore EPERM
      }
    };
    const stop = (why: NonNullable<RunResult["killed"]>) => {
      if (killed || done) return;
      killed = why;
      reap();
    };
    const take = (d: StringDecoder, add: (t: string) => void) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limits.maxOutputBytes) return stop("output");
      add(d.write(chunk));
    };
    child.stdout.on(
      "data",
      take(outDec, (t) => (out += t)),
    );
    child.stderr.on(
      "data",
      take(errDec, (t) => (err += t)),
    );
    child.stdin.on("error", () => {});
    const timer = setTimeout(() => stop("timeout"), limits.timeoutMs + 2000);
    const onAbort = () => stop("aborted");
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    child.on("close", (code, sig) => {
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        code,
        signal: sig,
        stdout: out + outDec.end(),
        stderr: err + errDec.end(),
        killed: launcherKilled(code, killed),
      });
    });
    child.stdin.end(jobStdin(job));
  });
}

/**
 * Bytes and entries below `dir` (not following links); counting stops once either is over its limit. A file counts
 * by its length (a sparse file at its full size). `blocked`: some folder or entry could not be read (the code took
 * its permissions away) — the measurement is incomplete, so the run must stop (review #121 round 1: an unreadable
 * folder used to count as empty).
 */
export function folderUsage(
  dir: string,
  maxBytes: number,
  maxEntries: number,
): { bytes: number; entries: number; blocked: boolean } {
  let bytes = 0;
  let entries = 0;
  const stack = [dir];
  const gone = (e: unknown) => (e as { code?: unknown }).code === "ENOENT";
  while (stack.length && bytes <= maxBytes && entries <= maxEntries) {
    const d = stack.pop()!;
    let names: string[];
    try {
      names = fs.readdirSync(d);
    } catch (e) {
      // Removed since it was listed (the code tidied up): nothing to count. Unreadable: incomplete — blocked.
      if (gone(e)) continue;
      return { bytes, entries, blocked: true };
    }
    for (const n of names) {
      entries++;
      let st: fs.Stats | undefined;
      try {
        st = fs.lstatSync(path.join(d, n), { throwIfNoEntry: false });
      } catch {
        return { bytes, entries, blocked: true };
      }
      if (!st) continue;
      if (st.isDirectory()) stack.push(path.join(d, n));
      else bytes += st.size;
      if (bytes > maxBytes || entries > maxEntries) break;
    }
  }
  return { bytes, entries, blocked: false };
}

/** Whether a measurement is over the limits (or could not be made). */
const over = (u: ReturnType<typeof folderUsage>, maxBytes: number) =>
  u.blocked ? "blocked" : u.bytes > maxBytes || u.entries > PYTHON_LIMITS.workEntries ? "disk" : undefined;

/** The process's answer as a result: a limit it hit, its report, or `python_failed`. */
export function pythonResult(r: RunResult, folder?: "disk" | "blocked"): PythonRunResult {
  if (folder === "disk") return { ok: false, code: "python_disk_limit" };
  if (folder === "blocked") return { ok: false, code: "python_workdir_blocked" };
  if (r.killed === "timeout" || r.signal === "SIGXCPU") return { ok: false, code: "python_timeout" };
  if (r.killed === "memory" || r.killed === "monitor") return { ok: false, code: "python_memory_limit" };
  if (r.killed === "output") return { ok: false, code: "python_output_limit" };
  if (r.killed) return { ok: false, code: "python_failed" };
  if (r.code !== 0) return { ok: false, code: "python_failed" };
  try {
    const report = PythonReport.safeParse(JSON.parse(r.stdout));
    return report.success ? { ok: true, report: report.data } : { ok: false, code: "python_failed" };
  } catch {
    return { ok: false, code: "python_failed" };
  }
}

/**
 * The runner the app uses: the job under `runIsolated`, its working folder watched every `watchMs`. Tests may lower
 * the limits (never raise them in the app: it passes none).
 */
export function sandboxedPythonRunner(
  o: {
    watchMs?: number;
    timeoutMs?: number;
    maxRssBytes?: number;
    workBytes?: number;
    /** Tests only: replaces the folder measurement (a failing one must stop only its run). */
    measure?: typeof folderUsage;
  } = {},
): PythonRunner {
  return async (job, signal) => {
    const stop = new AbortController();
    const onAbort = () => stop.abort();
    if (signal?.aborted) stop.abort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    let folder: "disk" | "blocked" | undefined;
    const maxBytes = job.inputBytes + Math.min(o.workBytes ?? Infinity, PYTHON_LIMITS.workBytes);
    const measure = o.measure ?? folderUsage;
    const watch = setInterval(() => {
      // Never throws out of the timer (that would take the server down): any failure stops this run only.
      try {
        folder ??= over(measure(job.workdir, maxBytes, PYTHON_LIMITS.workEntries), maxBytes);
      } catch {
        folder ??= "blocked";
      }
      if (folder) stop.abort();
    }, o.watchMs ?? 200);
    let r: RunResult;
    try {
      const timeoutMs = Math.min(o.timeoutMs ?? Infinity, PYTHON_PROCESS_LIMITS.timeoutMs);
      if (job.env.account) {
        // Production: run as the dedicated account through the root-owned launcher (a different uid).
        r = await runViaLauncher(
          job,
          job.env.account,
          { timeoutMs, maxOutputBytes: PYTHON_PROCESS_LIMITS.maxOutputBytes },
          stop.signal,
        );
      } else {
        // Tests / the CLI self-check: the server's own uid, directly under sandbox-exec (never offered to a model).
        const run = pythonRunOptions(job);
        r = await runIsolated({
          ...run,
          timeoutMs,
          maxRssBytes: Math.min(o.maxRssBytes ?? Infinity, run.maxRssBytes!),
          signal: stop.signal,
        });
      }
    } catch {
      // No sandbox here (not macOS), a hard link in the working folder, a spawn failure: nothing ran.
      return { ok: false, code: "python_unavailable" };
    } finally {
      clearInterval(watch);
      signal?.removeEventListener("abort", onAbort);
    }
    // One last look: a folder that went over the limit between two checks is still over it.
    if (!folder)
      try {
        folder = over(measure(job.workdir, maxBytes, PYTHON_LIMITS.workEntries), maxBytes);
      } catch {
        folder = "blocked";
      }
    return pythonResult(r, folder);
  };
}
