import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ACCOUNT_NAME, JOB_ID, parseVerify, type VerifyReport } from "../python/account.js";
import { storagePaths } from "../storage/paths.js";

/**
 * The dedicated, unprivileged macOS account the sandboxed workers run as (#122) — the extractor
 * (`extract/worker.mjs`), the document worker (`docgen/worker.mjs`) and the headless browser behind PNG/PDF export.
 * The macOS sandbox cannot stop a process from reading the start-up environment (argv + env, `KERN_PROCARGS2`) of
 * other processes of the **same user**, and the runtimes keep their keys there (`runtime/claude.ts`,
 * `runtime/lockdown.ts`). These workers parse untrusted bytes (uploads, artifact documents), so a worker exploit
 * under the server's uid could read them. Under a **different uid** it cannot.
 *
 * It is the python_run design (#121, `python/account.ts`) applied to fixed programs: a root-owned launcher
 * (`ops/workers/agentlee-worker-run`) that a narrow NOPASSWD sudoers rule lets the server run as the account. The
 * server passes only an operation, a worker kind, a job id (a UUID), a timeout and — render only — the egress
 * proxy's loopback port. node, the worker programs and their libraries (one root-owned copy, `pnpm workers:bundle`),
 * the browser and the scratch root come from the launcher's root-owned config. **A second account and launcher**,
 * not python's: python runs code the model wrote; these workers hold other family members' files. Sharing a uid
 * (and a scratch ACL) would let one escaped python job reach a running extraction's input — two accounts keep the
 * two apart, and python's launcher stays exactly as reviewed.
 *
 * Each kind is used through the account only after the self-check for that kind passed on this machine
 * (`workers/selfcheck.ts`). Until then it keeps today's same-uid sandbox and the admin status says so.
 */

/** The one path the sudoers rule allows; the server runs no other command through sudo for workers. */
export const WORKER_LAUNCHER = "/usr/local/libexec/agentlee-worker-run";
/** The root-owned config the launcher reads. */
export const WORKER_CONF = "/usr/local/etc/agentlee-worker.conf";

/** The kinds the launcher runs. `ocr` is the extractor with OCR's larger limits (same program and profile). */
export const LAUNCHER_KINDS = ["extract", "ocr", "docgen", "render"] as const;
export type LauncherKind = (typeof LAUNCHER_KINDS)[number];
/** The workers as the admin sees them (one self-check and one gate each; `extract` covers `ocr`). */
export const WORKER_KINDS = ["extract", "docgen", "render"] as const;
export type WorkerKind = (typeof WORKER_KINDS)[number];

/** The longest timeout (seconds) the launcher accepts per kind (its `%KIND` table). */
export const LAUNCHER_MAX_SEC: Record<LauncherKind, number> = {
  extract: 60,
  ocr: 300,
  docgen: 60,
  render: 60,
};

export type WorkerAccount = { user: string; launcher: string };
/** An account whose self-check passed for a kind: what the runners use. */
export type VerifiedWorker = { account: WorkerAccount; uid: number };

/** The account from the configuration, or undefined when it is unset or malformed. */
export function workerAccountFromConfig(
  user: string | undefined,
  launcher = WORKER_LAUNCHER,
): WorkerAccount | undefined {
  if (!user || !ACCOUNT_NAME.test(user)) return undefined;
  return { user, launcher };
}

/** The worker scratch root under DATA_DIR; every job folder is `<root>/<jobId>`. */
export const workerScratchRoot = (dataDir: string): string => storagePaths(dataDir).workerScratch;

export function workerJobDir(dataDir: string, jobId: string): string {
  if (!JOB_ID.test(jobId)) throw new Error(`bad job id: ${JSON.stringify(jobId)}`);
  return path.join(workerScratchRoot(dataDir), jobId);
}

/** The run record the launcher keeps for a job (`.ctl/<jobId>/leader`: `pid uid sec usec`). */
export function workerLeaderFile(dataDir: string, jobId: string): string {
  if (!JOB_ID.test(jobId)) throw new Error(`bad job id: ${JSON.stringify(jobId)}`);
  return path.join(workerScratchRoot(dataDir), ".ctl", jobId, "leader");
}

type Argv = { command: string; args: string[] };

const sudo = (account: WorkerAccount, sub: string[]): Argv => ({
  command: "/usr/bin/sudo",
  // -n: never prompt (the sudoers rule is NOPASSWD). -u: drop to the account. --: end of sudo options.
  args: ["-n", "-u", account.user, "--", account.launcher, ...sub],
});

const assertJob = (jobId: string): string => {
  if (!JOB_ID.test(jobId)) throw new Error(`bad job id: ${JSON.stringify(jobId)}`);
  return jobId;
};
const assertKind = (kind: string): LauncherKind => {
  if (!(LAUNCHER_KINDS as readonly string[]).includes(kind))
    throw new Error(`bad kind: ${JSON.stringify(kind)}`);
  return kind as LauncherKind;
};
const assertPort = (port: number | undefined, kind: LauncherKind): string[] => {
  if (kind !== "render") {
    if (port !== undefined) throw new Error("a port is for render only");
    return [];
  }
  if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("bad port");
  return [String(port)];
};

/** `sudo … launcher run <kind> <jobId> <timeoutSec> [<port>]`. */
export function workerLauncherRun(
  account: WorkerAccount,
  kind: LauncherKind,
  jobId: string,
  timeoutSec: number,
  port?: number,
): Argv {
  const k = assertKind(kind);
  if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > LAUNCHER_MAX_SEC[k])
    throw new Error("bad timeout");
  return sudo(account, ["run", k, assertJob(jobId), String(timeoutSec), ...assertPort(port, k)]);
}

/** `sudo … launcher probe <kind> <jobId> <siblingPid> [<port>]` (the self-check). */
export function workerLauncherProbe(
  account: WorkerAccount,
  kind: LauncherKind,
  jobId: string,
  siblingPid: number,
  port?: number,
): Argv {
  const k = assertKind(kind);
  if (!Number.isInteger(siblingPid) || siblingPid <= 1) throw new Error("bad sibling pid");
  return sudo(account, ["probe", k, assertJob(jobId), String(siblingPid), ...assertPort(port, k)]);
}

/** `sudo … launcher reap <jobId>`: kills the job's recorded child, verified by its kernel identity. */
export function workerLauncherReap(account: WorkerAccount, jobId: string): Argv {
  return sudo(account, ["reap", assertJob(jobId)]);
}

/** `sudo … launcher clean <jobId>`: removes the job's folder as the account (restores modes first). */
export function workerLauncherClean(account: WorkerAccount, jobId: string): Argv {
  return sudo(account, ["clean", assertJob(jobId)]);
}

/** `<launcher> verify <account>` — run directly (no sudo): the launcher's read-only, advisory setup report. */
export function workerLauncherVerify(account: WorkerAccount): Argv {
  if (!ACCOUNT_NAME.test(account.user)) throw new Error("bad account name");
  return { command: account.launcher, args: ["verify", account.user] };
}

/** Runs the launcher's `verify` (no sudo) and parses it (python's strict parser: the same report format). */
export function runWorkerVerifySync(account: WorkerAccount): VerifyReport & { error?: string } {
  try {
    const { command, args } = workerLauncherVerify(account);
    const r = spawnSync(command, args, { env: {}, encoding: "utf8", timeout: 120_000 });
    if (r.error) return { ok: false, checks: [], error: r.error.message };
    return parseVerify(r.stdout ?? "", r.status);
  } catch (e) {
    return { ok: false, checks: [], error: (e as Error).message };
  }
}

/** Asks the launcher to reap a job (detached, never awaited); `onExit` gets its exit code. Never throws. */
export function reapWorker(
  account: WorkerAccount,
  jobId: string,
  onExit?: (code: number | null) => void,
): void {
  try {
    const r = workerLauncherReap(account, jobId);
    const p = spawn(r.command, r.args, { env: {}, stdio: "ignore", detached: true });
    p.on("error", () => onExit?.(null));
    p.on("exit", (code) => onExit?.(code));
    p.unref();
  } catch {
    // a bad job id: nothing to reap; the launcher's own timeout still stops the run
  }
}

/** Removes a job's folder through the launcher (as the account), synchronously. Best-effort; never throws. */
export function runWorkerCleanSync(account: WorkerAccount, jobId: string): void {
  try {
    const { command, args } = workerLauncherClean(account, jobId);
    spawnSync(command, args, { env: {}, stdio: "ignore", timeout: 60_000 });
  } catch {
    // a bad job id or a missing launcher: the server's own removal is the backstop
  }
}

/**
 * The launcher probe's output → a result. Exit code 0 and stdout exactly ONE line (plus its newline):
 * `uid=<n> sibling=<n> procargs=<blocked|readable>` or `uid=<n> procargs=error <control|sibling|errno=<n>>` — no
 * prefix, no second verdict. Undefined otherwise (a failure, fail closed).
 */
const U32 = "(0|[1-9][0-9]{0,9})";
const PROBE_LINE = new RegExp(
  `^uid=${U32} (?:sibling=${U32} procargs=(blocked|readable)|procargs=error (?:control|sibling|errno=[0-9]{1,5}))$`,
);
export type WorkerProbeResult = { uid: number; siblingUid?: number; readBlocked: boolean };
export function parseWorkerProbe(out: string, exitCode: number | null): WorkerProbeResult | undefined {
  if (exitCode !== 0 || !out.endsWith("\n")) return undefined;
  const lines = out.slice(0, -1).split("\n");
  if (lines.length !== 1) return undefined;
  const m = PROBE_LINE.exec(lines[0]!);
  if (!m) return undefined;
  const uid = Number(m[1]);
  if (!Number.isSafeInteger(uid) || uid > 0xffffffff) return undefined;
  if (m[2] === undefined) return { uid, readBlocked: false };
  const siblingUid = Number(m[2]);
  if (!Number.isSafeInteger(siblingUid) || siblingUid > 0xffffffff) return undefined;
  return { uid, siblingUid, readBlocked: m[3] === "blocked" };
}

/**
 * The launcher's run record of a job → its uid, when the record is well-formed and the file is owned by `uid`
 * (the account wrote it: the job really ran there). Undefined otherwise.
 */
export function leaderUid(
  file: string,
  ownerOf: (f: string) => number = (f) => fs.lstatSync(f).uid,
): number | undefined {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile()) return undefined;
    const m = /^([0-9]{1,10}) ([0-9]{1,10}) ([0-9]{1,20}) ([0-9]{1,7})\n$/.exec(
      fs.readFileSync(file, "utf8"),
    );
    if (!m) return undefined;
    const uid = Number(m[2]);
    return ownerOf(file) === uid ? uid : undefined;
  } catch {
    return undefined;
  }
}
