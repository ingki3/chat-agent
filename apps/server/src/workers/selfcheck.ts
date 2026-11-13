import { spawn, type ChildProcessByStdio } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { exportDocument, type Renderer } from "../artifacts/export.js";
import type { FileRow } from "../files/store.js";
import type { OcrCapability } from "../files/extract.js";
import { AccountSelfCheckGate, type SelfCheckResult } from "../python/selfcheck.js";
import {
  leaderUid,
  parseWorkerProbe,
  reapWorker,
  workerLauncherProbe,
  workerLeaderFile,
  WORKER_KINDS,
  type LauncherKind,
  type VerifiedWorker,
  type WorkerAccount,
  type WorkerKind,
  type WorkerProbeResult,
} from "./account.js";
import { docAsAccount } from "./docgen.js";
import { extractAsAccount, type AccountJobHooks } from "./extract.js";
import { makeWorkerJobDir, removeWorkerJob } from "./run.js";

/**
 * The worker account's self-check (#122), one per worker kind — the authoritative check (the launcher's `verify` is
 * advisory). A kind is run through the account only after its check passed on this machine; until then (and when it
 * fails) it keeps the same-uid sandbox and the admin status says it is not isolated by account.
 *
 * 1. `probe`: as the account, inside that kind's sandbox profile (its reads, writes and network, the program
 *    swapped for /usr/bin/perl — node has no sysctl binding), the probe's uid differs from the server's and the
 *    `KERN_PROCARGS2` of a server-uid sibling holding a synthetic secret in its environment cannot be read (the
 *    kernel still shows the sibling, with the server's uid — a vanished pid is not "blocked").
 * 2. `run`: a real job through the normal path (the same functions a request uses): extract — a server-owned text
 *    file copied into a job folder and extracted, under `extract` and again under `ocr` (its limits); docgen — a
 *    DOCX made and opened; render — a page rendered to PNG through the launcher's relayed debugging pipe (the egress
 *    proxy, the profile folder, the fixed switches). The output must be what that input gives.
 * 3. `identity`: every job's run record (`.ctl/<job>/leader`, written by the launcher) names the probe's uid and is
 *    owned by it — the job really ran as the account.
 */

export type WorkerProbeRunner = (p: {
  account: WorkerAccount;
  kind: LauncherKind;
  jobId: string;
  siblingPid: number;
  port?: number | undefined;
  signal?: AbortSignal | undefined;
}) => Promise<WorkerProbeResult>;

/** The port the render probe's profile allows (the probe connects nowhere; the profile is the point). */
const PROBE_PORT = 9;

/**
 * The real probe: `sudo … launcher probe …`, one strict verdict line. On abort or its own timeout it asks the
 * launcher to reap the recorded probe child and settles at once (python_run's `launcherProbeRunner`).
 */
export function launcherWorkerProbeRunner(
  o: {
    spawnProbe?: (command: string, args: string[]) => ChildProcessByStdio<null, Readable, Readable>;
    reap?: (account: WorkerAccount, jobId: string) => void;
    timeoutMs?: number;
  } = {},
): WorkerProbeRunner {
  const spawnProbe =
    o.spawnProbe ??
    ((command: string, args: string[]) =>
      spawn(command, args, { env: {}, stdio: ["ignore", "pipe", "pipe"] }));
  const reap = o.reap ?? ((account: WorkerAccount, jobId: string) => reapWorker(account, jobId));
  return ({ account, kind, jobId, siblingPid, port, signal }) =>
    new Promise<WorkerProbeResult>((resolve, reject) => {
      if (signal?.aborted) return reject(new Error("aborted"));
      const { command, args } = workerLauncherProbe(account, kind, jobId, siblingPid, port);
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
      const timer = setTimeout(() => stop("the launcher probe timed out"), o.timeoutMs ?? 30_000);
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (c: Buffer) => (out += dec.write(c)));
      child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8").slice(0, 2000)));
      child.on("error", (e) => settle(() => reject(e)));
      child.on("close", (code) =>
        settle(() => {
          out += dec.end();
          const r = parseWorkerProbe(out, code);
          if (!r)
            reject(new Error(`launcher probe gave no verdict (${err.trim().slice(0, 200) || "no output"})`));
          else resolve(r);
        }),
      );
    });
}

/**
 * Step 1 for one launcher kind: a server-uid sibling with a synthetic secret in its environment, the probe as the
 * account. Passes only when the probe's uid is a real, different uid, the sibling is seen with the server's uid,
 * and its start-up environment could not be read.
 */
export async function probeWorker(o: {
  account: WorkerAccount;
  kind: LauncherKind;
  dataDir: string;
  serverUid: number;
  run?: WorkerProbeRunner;
  clean?: (account: WorkerAccount, jobId: string) => void;
  signal?: AbortSignal | undefined;
}): Promise<{ ok: true; uid: number } | { ok: false; reason: string }> {
  const secret = `AGENTLEE-WORKER-SELFCHECK-${crypto.randomBytes(12).toString("hex")}`;
  let made: { jobId: string; dir: string } | undefined;
  let sibling: ReturnType<typeof spawn> | undefined;
  try {
    made = makeWorkerJobDir(o.dataDir);
    sibling = spawn(process.execPath, ["-e", "setInterval(() => {}, 1 << 30)"], {
      env: { PATH: process.env.PATH ?? "", AGENTLEE_SELFCHECK: secret },
      stdio: "ignore",
    });
    sibling.unref();
    const pid = sibling.pid;
    if (!pid) return { ok: false, reason: "could not start the self-check sibling" };
    await new Promise((r) => setTimeout(r, 150));
    if (o.signal?.aborted) return { ok: false, reason: "aborted" };
    const res = await (o.run ?? defaultProbe)({
      account: o.account,
      kind: o.kind,
      jobId: made.jobId,
      siblingPid: pid,
      port: o.kind === "render" ? PROBE_PORT : undefined,
      signal: o.signal,
    });
    if (res.uid === o.serverUid)
      return { ok: false, reason: `the account runs as the server's uid (${res.uid})` };
    if (res.uid <= 0) return { ok: false, reason: `the account resolved to uid ${res.uid}` };
    if (res.siblingUid !== o.serverUid)
      return { ok: false, reason: "the probe did not see the server's sibling" };
    if (!res.readBlocked)
      return { ok: false, reason: "the account could read another process's start-up environment" };
    return { ok: true, uid: res.uid };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  } finally {
    try {
      sibling?.kill("SIGKILL");
    } catch {
      // already gone
    }
    if (made) removeWorkerJob(o.account, o.dataDir, made.jobId, o.clean);
  }
}
const defaultProbe: WorkerProbeRunner = launcherWorkerProbeRunner();

/**
 * Step 2 of a kind: real jobs through the normal path as `worker`. Reports every job id to `onJob` (before its
 * folder goes) and answers undefined when the output is right, else why not.
 */
export type WorkerJobCheck = (
  worker: VerifiedWorker,
  onJob: (jobId: string) => void,
  signal: AbortSignal | undefined,
) => Promise<string | undefined>;

export const SELF_CHECK_TEXT = "Agent Lee worker self-check\n둘째 줄\n";

/** extract: a server-owned text file, extracted under `extract` and again under `ocr`. */
export function extractJobCheck(
  dataDir: string,
  ocr: () => OcrCapability,
  tmpDir = os.tmpdir,
  /** Tests only: the launcher stand-in. */
  hooks: Pick<AccountJobHooks, "spawn" | "clean"> = {},
): WorkerJobCheck {
  return async (worker, onJob, signal) => {
    const src = fs.mkdtempSync(path.join(tmpDir(), "agentlee-worker-check-"));
    try {
      const data = Buffer.from(SELF_CHECK_TEXT, "utf8");
      const sha256 = crypto.createHash("sha256").update(data).digest("hex");
      const file = path.join(src, "input.txt");
      fs.writeFileSync(file, data, { mode: 0o600 });
      const row = { kind: "txt", bytes: data.length, sha256 } as FileRow;
      for (const forceOcrKind of [false, true]) {
        const r = await extractAsAccount(
          worker,
          dataDir,
          { file: row, path: file, signal: signal ?? new AbortController().signal },
          ocr,
          { ...hooks, onJob, forceOcrKind },
        );
        if (!r.ok) return `${forceOcrKind ? "ocr" : "extract"}: ${r.code}`;
        const text = r.segments.map((s) => s.text).join("\n");
        if (r.sha256 !== sha256 || text !== SELF_CHECK_TEXT.trimEnd())
          return `${forceOcrKind ? "ocr" : "extract"}: unexpected text`;
      }
      return undefined;
    } finally {
      fs.rmSync(src, { recursive: true, force: true });
    }
  };
}

/** docgen: a DOCX made from a one-line document; it must be a ZIP that the worker re-opened (its checks). */
export function docJobCheck(
  dataDir: string,
  hooks: Pick<AccountJobHooks, "spawn" | "clean"> = {},
): WorkerJobCheck {
  return async (worker, onJob) => {
    const r = await docAsAccount(
      worker,
      dataDir,
      { kind: "docx", doc: { title: "Agent Lee worker self-check", blocks: [] }, images: {} },
      { ...hooks, onJob },
    );
    if (!r.ok) return r.code;
    if (r.data.subarray(0, 2).toString("latin1") !== "PK") return "not a DOCX";
    return undefined;
  };
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** render: a small page to PNG through the renderer's account path (egress proxy, relayed pipe, fixed switches). */
export function renderJobCheck(renderer: Pick<Renderer, "render">): WorkerJobCheck {
  return async (worker, onJob) => {
    const doc = exportDocument("markdown", "Agent Lee worker self-check", "Agent Lee worker self-check")!;
    const r = await renderer.render({ format: "png", doc, scripts: false }, { worker, onJob });
    if (!r.ok) return r.code;
    if (!r.body.subarray(0, 8).equals(PNG)) return "not a PNG";
    return undefined;
  };
}

/** The whole check of one kind (see the file comment). Never throws. */
export async function selfCheckWorker(o: {
  kind: WorkerKind;
  account: WorkerAccount;
  dataDir: string;
  serverUid: number;
  job: WorkerJobCheck;
  probe?: WorkerProbeRunner;
  clean?: (account: WorkerAccount, jobId: string) => void;
  ownerOf?: (file: string) => number;
  signal?: AbortSignal | undefined;
}): Promise<SelfCheckResult> {
  let step = "probe";
  try {
    const p = await probeWorker({
      account: o.account,
      kind: o.kind,
      dataDir: o.dataDir,
      serverUid: o.serverUid,
      ...(o.probe ? { run: o.probe } : {}),
      ...(o.clean ? { clean: o.clean } : {}),
      signal: o.signal,
    });
    if (!p.ok) return { ok: false, step, reason: p.reason };
    if (o.signal?.aborted) return { ok: false, step, reason: "aborted" };
    step = "run";
    const seen: (number | undefined)[] = [];
    const why = await o.job(
      { account: o.account, uid: p.uid },
      (jobId) => seen.push(leaderUid(workerLeaderFile(o.dataDir, jobId), o.ownerOf)),
      o.signal,
    );
    if (why !== undefined) return { ok: false, step, reason: why };
    step = "identity";
    if (!seen.length) return { ok: false, step, reason: "no job was recorded" };
    if (seen.some((u) => u !== p.uid)) return { ok: false, step, reason: "a job did not run as the account" };
    return { ok: true, uid: p.uid };
  } catch (e) {
    return { ok: false, step, reason: e instanceof Error ? e.message : String(e) };
  }
}

/** One worker's isolation as the admin sees it (codes only). */
export type WorkerIsolation = {
  kind: WorkerKind;
  /** `account`: runs as the worker account; `same_uid`: the server's own uid, inside the sandbox only. */
  isolation: "account" | "same_uid";
  state: "ok" | "not_configured" | "checking" | "failed" | "stopped" | "unavailable";
  /** The failed step (`probe`, `run`, `identity`, `exception`), when `failed`. */
  step: string | null;
};

export const WORKER_UNCONFIGURED = "WORKER_RUN_USER not configured";

/**
 * The three gates (#122): one per worker kind, each the python_run gate (`AccountSelfCheckGate`) — absent until its
 * check passed, fail closed on a failure or an exception, aborted on shutdown. Their checks run one after another
 * in the background once the server is ready. Until a kind's gate passes, that kind runs in the same-uid sandbox
 * (today's behaviour — nothing breaks for an install without the account) and `status()` says it is not isolated
 * by account.
 */
export class WorkerGates {
  private readonly gates: Record<WorkerKind, AccountSelfCheckGate<WorkerAccount>>;
  private readonly skipped = new Set<WorkerKind>();
  done: Promise<void> = Promise.resolve();

  constructor(readonly account: WorkerAccount | undefined) {
    this.gates = Object.fromEntries(
      WORKER_KINDS.map((k) => [k, new AccountSelfCheckGate<WorkerAccount>(account, WORKER_UNCONFIGURED)]),
    ) as Record<WorkerKind, AccountSelfCheckGate<WorkerAccount>>;
  }

  verified(kind: WorkerKind): VerifiedWorker | undefined {
    return this.gates[kind].verified;
  }

  /** Not checked at all (e.g. the worker is not available on this server): stays on the sandbox with this reason. */
  skip(kind: WorkerKind, reason: string): void {
    this.skipped.add(kind);
    this.gates[kind].skip(reason);
  }

  status(): WorkerIsolation[] {
    return WORKER_KINDS.map((kind) => {
      const g = this.gates[kind];
      if (g.verified) return { kind, isolation: "account", state: "ok", step: null };
      const why = g.reason;
      const step = /^self-check step ([a-z]+) failed/.exec(why)?.[1];
      const state: WorkerIsolation["state"] =
        why === WORKER_UNCONFIGURED
          ? "not_configured"
          : why.startsWith("checking")
            ? "checking"
            : why.startsWith("self-check stopped")
              ? "stopped"
              : step || why.startsWith("self-check failed")
                ? "failed"
                : "unavailable";
      return { kind, isolation: "same_uid", state, step: state === "failed" ? (step ?? "exception") : null };
    });
  }

  /** The kinds' checks, one after another (never throws). */
  start(
    run: (kind: WorkerKind, signal: AbortSignal) => Promise<SelfCheckResult>,
    log?: (kind: WorkerKind, ok: boolean, detail: string) => void,
  ): Promise<void> {
    if (!this.account) return this.done;
    this.done = (async () => {
      for (const kind of WORKER_KINDS)
        if (!this.skipped.has(kind))
          await this.gates[kind].start(
            (signal) => run(kind, signal),
            (ok, detail) => log?.(kind, ok, detail),
          );
    })();
    return this.done;
  }

  /** Shutdown: aborts every check and waits — at most `boundMs` — for their clean-up. Never throws. */
  async stop(boundMs: number): Promise<void> {
    await Promise.all(WORKER_KINDS.map((k) => this.gates[k].stop(boundMs)));
  }
}
