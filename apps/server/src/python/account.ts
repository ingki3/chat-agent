import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { PYTHON_LIMITS } from "@agentlee/shared";
import { storagePaths } from "../storage/paths.js";
import type { PythonEnv } from "./packages.js";

/**
 * The dedicated, unprivileged macOS account `python_run` runs as (#47 review rounds 2-3). The macOS sandbox cannot
 * stop code from reading the start-up environment (argv + env, `KERN_PROCARGS2`) of other processes of the **same
 * user**, and the server's runtimes keep their keys there. So the interpreter must run as a **different uid**: a
 * hidden account that owns nothing of the server. Privilege is dropped through a fixed, root-owned launcher that a
 * narrow sudoers rule lets this server run with no password.
 *
 * The launcher trusts no path from this server (the caller is the server uid): the server passes only an
 * operation and a **job id** (a UUID). The interpreter, the root-owned runner.py copy, the packages dir and the
 * scratch root all come from a root-owned config file the launcher reads and whose integrity it checks. So the
 * server builds the sudo command from the job id alone, and derives the per-job work dir as `<scratch>/<jobId>`.
 *
 * None of this is reached unless the startup self-check (`verifyAccount`) proves, on this machine, that the child
 * runs with a different uid than the server and that from inside its sandbox it cannot read `KERN_PROCARGS2` of a
 * sibling server-uid process. Fail closed: without that proof the tool is not offered.
 */

/** The one path the sudoers rule allows; the server never runs any other command through sudo. */
export const PYTHON_LAUNCHER = "/usr/local/libexec/agentlee-python-run";
/** The root-owned config the launcher reads (installed beside the launcher at setup). */
export const PYTHON_CONF = "/usr/local/etc/agentlee-python.conf";
/** A macOS short account name (the hidden `python_run` account, e.g. `_agentleepy`). */
export const ACCOUNT_NAME = /^[a-z_][a-z0-9_-]{0,30}$/;
/** A job id: a v4-shaped UUID (what `crypto.randomUUID()` makes); the only token the launcher accepts. */
export const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type PythonAccount = { user: string; launcher: string };

/** The account from the configuration, or undefined when it is unset or malformed. */
export function accountFromConfig(
  user: string | undefined,
  launcher = PYTHON_LAUNCHER,
): PythonAccount | undefined {
  if (!user || !ACCOUNT_NAME.test(user)) return undefined;
  return { user, launcher };
}

/** The scratch root under DATA_DIR; every working folder is `<scratch>/<jobId>`. */
export const scratchRoot = (dataDir: string): string => storagePaths(dataDir).scratch;

/** The work folder of a job. `jobId` must be a UUID. */
export function jobWorkdir(dataDir: string, jobId: string): string {
  if (!JOB_ID.test(jobId)) throw new Error(`bad job id: ${JSON.stringify(jobId)}`);
  return path.join(scratchRoot(dataDir), jobId);
}

type Argv = { command: string; args: string[] };

const sudo = (account: PythonAccount, sub: string[]): Argv => ({
  command: "/usr/bin/sudo",
  // -n: never prompt (the sudoers rule is NOPASSWD). -u: drop to the account. --: end of sudo options.
  args: ["-n", "-u", account.user, "--", account.launcher, ...sub],
});

const assertJob = (jobId: string): string => {
  if (!JOB_ID.test(jobId)) throw new Error(`bad job id: ${JSON.stringify(jobId)}`);
  return jobId;
};

/** `sudo … launcher run <jobId> <timeoutSec>`. */
export function launcherRun(account: PythonAccount, jobId: string, timeoutSec: number): Argv {
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > 600) throw new Error("bad timeout");
  return sudo(account, ["run", assertJob(jobId), String(timeoutSec)]);
}

/** `sudo … launcher reap <jobId>`: kills the job's process group, from control state the sandbox cannot write. */
export function launcherReap(account: PythonAccount, jobId: string): Argv {
  return sudo(account, ["reap", assertJob(jobId)]);
}

/** `sudo … launcher clean <jobId>`: removes the job's work dir as the account (restores modes). */
export function launcherClean(account: PythonAccount, jobId: string): Argv {
  return sudo(account, ["clean", assertJob(jobId)]);
}

/** `sudo … launcher probe <jobId> <siblingPid>` (the self-check). */
export function launcherProbe(account: PythonAccount, jobId: string, siblingPid: number): Argv {
  if (!Number.isInteger(siblingPid) || siblingPid <= 1) throw new Error("bad sibling pid");
  return sudo(account, ["probe", assertJob(jobId), String(siblingPid)]);
}

/**
 * `<launcher> verify <account>` — run directly, **not** through sudo (#47 round 5): the launcher's read-only setup
 * report. It reads its root-owned config and runs the very trust checks `run` runs (chains, trees, ACLs, exact
 * config format) plus whether the account can traverse to and write the scratch root, so `pnpm python:setup-check`
 * never applies rules of its own that could disagree with the launcher's.
 */
export function launcherVerify(account: PythonAccount): Argv {
  if (!ACCOUNT_NAME.test(account.user)) throw new Error("bad account name");
  return { command: account.launcher, args: ["verify", account.user] };
}

export type VerifyCheck = { name: string; ok: boolean; reason?: string };
export type VerifyReport = { ok: boolean; checks: VerifyCheck[]; scratch?: string };

/**
 * `verify` is **advisory**: it can miss ACL corner cases. The authoritative check is the self-check run as the
 * account (`verifyAccount` — at server start and in `pnpm python:check`).
 *
 * The launcher's `verify` output → a report. Fail closed: `ok` only with exit code 0, a final `result ok`, at least
 * one check, every check `ok`, and no line it does not understand.
 */
export function parseVerify(out: string, exitCode: number | null): VerifyReport {
  const checks: VerifyCheck[] = [];
  let scratch: string | undefined;
  let result: string | undefined;
  let strange = false;
  for (const line of out.split("\n")) {
    if (line === "") continue;
    let m: RegExpExecArray | null;
    if ((m = /^check (.+?) (ok|fail)(?: (.*))?$/.exec(line)))
      checks.push(
        m[2] === "ok" && m[3] === undefined
          ? { name: m[1]!, ok: true }
          : { name: m[1]!, ok: false, reason: m[3] ?? "failed" },
      );
    else if ((m = /^scratch (\/.*)$/.exec(line))) scratch = m[1];
    else if ((m = /^result (ok|fail)$/.exec(line))) result = m[1];
    else if (/^advisory /.test(line)) continue;
    else strange = true;
  }
  const ok = exitCode === 0 && result === "ok" && !strange && checks.length > 0 && checks.every((c) => c.ok);
  return { ok, checks, ...(scratch ? { scratch } : {}) };
}

/** Runs the launcher's `verify` (no sudo) and parses it. A launcher that cannot be started is a failed report. */
export function runLauncherVerifySync(account: PythonAccount): VerifyReport & { error?: string } {
  try {
    const { command, args } = launcherVerify(account);
    const r = spawnSync(command, args, { env: {}, encoding: "utf8", timeout: 60_000 });
    if (r.error) return { ok: false, checks: [], error: r.error.message };
    return parseVerify(r.stdout ?? "", r.status);
  } catch (e) {
    return { ok: false, checks: [], error: (e as Error).message };
  }
}

/**
 * What the probe saw: its uid and whether a server-uid sibling's KERN_PROCARGS2 was blocked. (What a real job needs
 * is checked by running one — `selfCheckAccount`, #121 round 8.)
 */
export type ProbeResult = { uid: number; readBlocked: boolean };
/** Runs the launcher's `probe` against a sibling process and returns what it saw. Injected in tests. */
export type ProbeRunner = (p: {
  account: PythonAccount;
  jobId: string;
  siblingPid: number;
  secret: string;
  dataDir: string;
  /** Shutdown: stop the probe (it rejects). */
  signal?: AbortSignal | undefined;
}) => Promise<ProbeResult>;

export type VerifyResult = { ok: true; uid: number } | { ok: false; reason: string };

/**
 * The startup self-check (#47 rounds 2-3). Makes a scratch job folder, starts a sibling process of the **server's**
 * uid with a synthetic secret in its environment, and has the launcher's probe (as the account, inside the sandbox)
 * report its own uid and whether it could read that sibling's `KERN_PROCARGS2`. Passes only when the uid differs
 * from the server's and the read is blocked (EPERM, with the probe's own positive control succeeding). Fail closed.
 */
export async function verifyAccount(opts: {
  account: PythonAccount;
  dataDir: string;
  serverUid: number;
  run?: ProbeRunner;
  log?: (line: string) => void;
  /** Shutdown: no probe starts after it; a running one is stopped. */
  signal?: AbortSignal | undefined;
  /** Removes the probe's job dir and run record as the account (default: the launcher's `clean`). */
  clean?: (account: PythonAccount, jobId: string) => void;
}): Promise<VerifyResult> {
  const run = opts.run ?? defaultProbeRunner;
  const secret = `AGENTLEE-SELFCHECK-${crypto.randomBytes(12).toString("hex")}`;
  const jobId = crypto.randomUUID();
  const workdir = jobWorkdir(opts.dataDir, jobId);
  let sibling: ReturnType<typeof spawn> | undefined;
  try {
    fs.mkdirSync(workdir, { recursive: true, mode: 0o700 });
    // A harmless sibling of the server's uid holding the secret in its environment (never on argv or a file).
    sibling = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
      env: { PATH: process.env.PATH ?? "", AGENTLEE_SELFCHECK: secret },
      stdio: "ignore",
    });
    sibling.unref();
    const pid = sibling.pid;
    if (!pid) return { ok: false, reason: "could not start the self-check sibling" };
    await new Promise((r) => setTimeout(r, 150));
    if (opts.signal?.aborted) return { ok: false, reason: "aborted" };
    const res = await run({
      account: opts.account,
      jobId,
      siblingPid: pid,
      secret,
      dataDir: opts.dataDir,
      signal: opts.signal,
    });
    if (res.uid === opts.serverUid)
      return { ok: false, reason: `the account runs as the server's uid (${res.uid})` };
    if (res.uid <= 0) return { ok: false, reason: `the account resolved to uid ${res.uid}` };
    if (!res.readBlocked)
      return { ok: false, reason: "the account could read another process's start-up environment" };
    // A sibling that had already exited (even a zombie the kernel still lists with its uid) also refuses
    // KERN_PROCARGS2: "blocked" only counts while the server's own sibling is still running (review #131).
    if (sibling.exitCode !== null || sibling.signalCode !== null)
      return { ok: false, reason: "the self-check sibling exited before the probe finished" };
    return { ok: true, uid: res.uid };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  } finally {
    // Best-effort, each on its own: the sibling, the probe's job dir + run record as the account, then ours.
    try {
      sibling?.kill("SIGKILL");
    } catch {
      // already gone
    }
    try {
      (opts.clean ?? runLauncherCleanSync)(opts.account, jobId);
    } catch {
      // the server's own removal below is the backstop
    }
    try {
      fs.rmSync(workdir, { recursive: true, force: true });
    } catch {
      // left for the next start's sweep
    }
  }
}

/**
 * The launcher probe's output → a result (#121 round 8: strict). Exit code 0, and stdout exactly ONE line (plus its
 * newline) of exactly `uid=<n> procargs=<blocked|readable|error control|error sibling|error errno=<n>>` — no prefix, no second
 * verdict, nothing else — with `<n>` a valid unsigned 32-bit uid. Only `procargs=blocked` (EPERM or EINVAL while the kernel still shows the sibling with another uid — #122 finding, with the probe's
 * own positive control having passed) is a blocked read. Undefined otherwise (a failure, fail closed).
 */
const PROBE_LINE =
  /^uid=(0|[1-9][0-9]{0,9}) procargs=(blocked|readable|error control|error sibling|error errno=[0-9]{1,5})$/;
export function parseProbe(out: string, exitCode: number | null): ProbeResult | undefined {
  if (exitCode !== 0 || !out.endsWith("\n")) return undefined;
  const lines = out.slice(0, -1).split("\n");
  if (lines.length !== 1) return undefined;
  const m = PROBE_LINE.exec(lines[0]!);
  if (!m) return undefined;
  const uid = Number(m[1]);
  if (!Number.isSafeInteger(uid) || uid > 0xffffffff) return undefined;
  return { uid, readBlocked: m[2] === "blocked" };
}

/**
 * The real probe runner: `sudo … launcher probe …`, one strict verdict line (`parseProbe`). On abort or its own
 * timeout (#121 round 11) it does not signal sudo — sudo cannot forward a SIGKILL, and the probe (as the account)
 * would keep the pipes open — but asks the launcher's `reap` to kill the recorded, verified probe child, destroys
 * its own end of the pipes and settles at once, so the caller's cleanup runs. (The launcher's probe also has its own
 * short wall-clock limit.) `spawnProbe`/`reap` are replaceable in tests.
 */
export function launcherProbeRunner(
  o: {
    spawnProbe?: (command: string, args: string[]) => ChildProcessByStdio<null, Readable, Readable>;
    reap?: (account: PythonAccount, jobId: string) => void;
    timeoutMs?: number;
  } = {},
): ProbeRunner {
  const spawnProbe =
    o.spawnProbe ??
    ((command: string, args: string[]) =>
      spawn(command, args, { env: {}, stdio: ["ignore", "pipe", "pipe"] }));
  const reap =
    o.reap ??
    ((account: PythonAccount, jobId: string) => {
      const r = launcherReap(account, jobId);
      const p = spawn(r.command, r.args, { env: {}, stdio: "ignore", detached: true });
      p.on("error", () => {});
      p.unref();
    });
  return ({ account, jobId, siblingPid, signal }) =>
    new Promise<ProbeResult>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("aborted"));
      const { command, args } = launcherProbe(account, jobId, siblingPid);
      const child = spawnProbe(command, args);
      const dec = new StringDecoder("utf8");
      let out = "";
      let err = "";
      let settled = false;
      const settle = (f: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        f();
      };
      const stop = (why: string) =>
        settle(() => {
          try {
            reap(account, jobId);
          } catch {
            // the launcher's own probe limit still ends it
          }
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          reject(new Error(why));
        });
      const onAbort = () => stop("aborted");
      const timer = setTimeout(
        () => stop("the launcher probe timed out"),
        o.timeoutMs ?? PYTHON_LIMITS.timeoutMs,
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (c: Buffer) => (out += dec.write(c)));
      child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8").slice(0, 2000)));
      child.on("error", (e) => settle(() => reject(e)));
      child.on("close", (code) =>
        settle(() => {
          out += dec.end();
          const r = parseProbe(out, code);
          if (!r)
            reject(new Error(`launcher probe gave no verdict (${err.trim().slice(0, 200) || "no output"})`));
          else resolve(r);
        }),
      );
    });
}
const defaultProbeRunner: ProbeRunner = launcherProbeRunner();

/** Removes a job's work dir through the launcher (as the account), synchronously. Best-effort; never throws. */
export function runLauncherCleanSync(account: PythonAccount, jobId: string): void {
  try {
    const { command, args } = launcherClean(account, jobId);
    spawnSync(command, args, { env: {}, stdio: "ignore" });
  } catch {
    // a bad job id or a missing launcher: the server's own removal is the backstop
  }
}

/** The env for an account PythonEnv carries no interpreter paths: the launcher reads them from its config. */
export type AccountEnv = PythonEnv;
