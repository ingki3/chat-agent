import fs from "node:fs";
import path from "node:path";
import {
  EXTRACT_LIMITS,
  OCR_KINDS,
  workerResult,
  type ExtractJob,
  type ExtractRunner,
  type OcrCapability,
  type WorkerResult,
} from "../files/extract.js";
import { writeInputCopy } from "../python/service.js";
import type { VerifiedWorker } from "./account.js";
import { makeWorkerJobDir, removeWorkerJob, runWorkerJob, type WorkerSpawn } from "./run.js";

/** The input copy's name in the job folder. */
export const EXTRACT_INPUT = "input";

export type AccountJobHooks = {
  /** Called with the job id once the job ran, before its folder and run record are removed (the self-check). */
  onJob?: (jobId: string) => void;
  /** Tests only. */
  spawn?: WorkerSpawn;
  clean?: (account: VerifiedWorker["account"], jobId: string) => void;
  reap?: (account: VerifiedWorker["account"], jobId: string, onExit: (code: number | null) => void) => void;
  /** docgen: stop the job (reap through the launcher) when aborted — the self-check's shutdown. */
  signal?: AbortSignal | undefined;
  /** The self-check only: run the extractor under the `ocr` kind (its limits) whatever the file's kind. */
  forceOcrKind?: boolean;
};

/**
 * One extraction as the worker account (#122). The stored file is opened without following links, must be a
 * plain file with one link (a hard link could be another family member's file — the rule the same-uid sandbox
 * keeps by refusing hard links in its read paths), and is copied into a fresh job folder as a new server-owned
 * 0600 file whose size and SHA-256 must match the row (`writeInputCopy`, python_run's). The account reads it
 * through the scratch ACL; the launcher's profile lets the worker read that folder and its program tree only. The
 * worker's answer comes back on stdout, as before. The folder goes afterwards, as the account first.
 */
export async function extractAsAccount(
  v: VerifiedWorker,
  dataDir: string,
  job: ExtractJob,
  ocr: () => OcrCapability,
  hooks: AccountJobHooks = {},
): Promise<WorkerResult> {
  const { file } = job;
  let made: { jobId: string; dir: string } | undefined;
  try {
    made = makeWorkerJobDir(dataDir);
    const input = path.join(made.dir, EXTRACT_INPUT);
    let fd: number | undefined;
    try {
      fd = fs.openSync(job.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const st = fs.fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1) return { ok: false, code: "extract_unavailable" };
      if (!writeInputCopy(fd, input, file.bytes, file.sha256)) return { ok: false, code: "extract_changed" };
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    const useOcr = OCR_KINDS.has(file.kind) && ocr().available;
    const limits = useOcr ? EXTRACT_LIMITS.ocr : EXTRACT_LIMITS.text;
    // No library path and no limit override travel with the job: under the account the worker takes its library
    // paths from its root-owned program tree (`AGENTLEE_WORKER_APP`), whatever the job says.
    const stdin = JSON.stringify({
      path: input,
      kind: file.kind,
      bytes: file.bytes,
      modules: {},
      assets: {},
      ocr: useOcr ? { langDir: "" } : null,
    });
    const r = await runWorkerJob({
      account: v.account,
      kind: useOcr || hooks.forceOcrKind ? "ocr" : "extract",
      jobId: made.jobId,
      timeoutMs: limits.timeoutMs,
      maxOutputBytes: EXTRACT_LIMITS.maxOutputBytes,
      stdin,
      signal: job.signal,
      ...(hooks.spawn ? { spawn: hooks.spawn } : {}),
      ...(hooks.reap ? { reap: hooks.reap } : {}),
    });
    hooks.onJob?.(made.jobId);
    return workerResult(r);
  } catch {
    // No launcher / sudo, a job folder that could not be made, a spawn failure: nothing ran.
    return { ok: false, code: "extract_unavailable" };
  } finally {
    if (made) removeWorkerJob(v.account, dataDir, made.jobId, hooks.clean);
  }
}

/**
 * The extractor the app uses (#122): as the worker account once its self-check passed (`verified()`), otherwise
 * the same-uid sandbox (`fallback`, today's `sandboxedExtractor`) — the admin status says which.
 */
export function accountOrSandboxExtractor(
  verified: () => VerifiedWorker | undefined,
  fallback: ExtractRunner,
  dataDir: string,
  ocr: () => OcrCapability,
  /** Called on each same-uid run (the app logs the first per kind). */
  onFallback?: () => void,
): ExtractRunner {
  return (job) => {
    const v = verified();
    if (!v) onFallback?.();
    return v ? extractAsAccount(v, dataDir, job, ocr) : fallback(job);
  };
}
