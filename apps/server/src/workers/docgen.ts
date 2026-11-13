import {
  DOC_WORKER_LIMITS,
  workerResult,
  type DocJob,
  type DocRunner,
  type DocRunResult,
} from "../docgen/runner.js";
import type { VerifiedWorker } from "./account.js";
import type { AccountJobHooks } from "./extract.js";
import { makeWorkerJobDir, removeWorkerJob, runWorkerJob } from "./run.js";

/**
 * One document as the worker account (#122). The job (the document and its pictures, read by the server through
 * the file store's checks) goes on stdin, the file comes back on stdout — as in the same-uid sandbox. The job
 * folder only stages stdin (the launcher writes it as the account); the worker's profile cannot read it (it reads
 * its program tree only, writes nothing). No library path travels with the job: the worker takes them from its
 * root-owned program tree.
 */
export async function docAsAccount(
  v: VerifiedWorker,
  dataDir: string,
  job: DocJob,
  hooks: AccountJobHooks = {},
): Promise<DocRunResult> {
  let made: { jobId: string; dir: string } | undefined;
  try {
    made = makeWorkerJobDir(dataDir);
    const r = await runWorkerJob({
      account: v.account,
      kind: "docgen",
      jobId: made.jobId,
      timeoutMs: DOC_WORKER_LIMITS.timeoutMs,
      maxOutputBytes: DOC_WORKER_LIMITS.maxOutputBytes,
      stdin: JSON.stringify({ ...job, modules: {}, fonts: {} }),
      ...(hooks.spawn ? { spawn: hooks.spawn } : {}),
    });
    hooks.onJob?.(made.jobId);
    return workerResult(r);
  } catch {
    return { ok: false, code: "doc_unavailable" };
  } finally {
    if (made) removeWorkerJob(v.account, dataDir, made.jobId, hooks.clean);
  }
}

/** The document runner the app uses: the account once its self-check passed, else the same-uid sandbox. */
export function accountOrSandboxDocRunner(
  verified: () => VerifiedWorker | undefined,
  fallback: DocRunner,
  dataDir: string,
): DocRunner {
  return (job) => {
    const v = verified();
    return v ? docAsAccount(v, dataDir, job) : fallback(job);
  };
}
