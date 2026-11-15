import fs from "node:fs";
import path from "node:path";
import { isInside } from "../fs-safety.js";

/** IDs used in paths must be simple tokens; this blocks traversal ("..", "/", "\\") by construction. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export function assertSafeId(kind: string, id: string): string {
  if (!SAFE_ID.test(id)) throw new Error(`unsafe ${kind} id: ${JSON.stringify(id)}`);
  return id;
}

/** File-store layout under DATA_DIR (PRD D6). */
export function storagePaths(dataDir: string) {
  const root = path.resolve(dataDir);
  return {
    root,
    db: path.join(root, "agentlee.db"),
    files: path.join(root, "files"),
    artifacts: path.join(root, "artifacts"),
    runtimes: path.join(root, "runtimes"),
    /** The server's own skill folder (#21): allow-listed skills copied by `pnpm skills:install`. */
    skills: path.join(root, "skills"),
    sources: path.join(root, "sources"),
    /**
     * Uploads being received (#22): streamed here first, moved into `files/` once checked. Same file system as
     * `files/` (a rename), outside every backup root; emptied at server start.
     */
    uploadsTmp: path.join(root, "uploads-tmp"),
    /**
     * The OCR language models (#48), copied from their pinned packages on first use so the extractor reads both
     * from one folder. Derived data, outside every backup root.
     */
    ocrLang: path.join(root, "ocr-lang"),
    /**
     * `python_run` working folders (#47): `scratch/<user>/<conversation>/<call>`, one per call, removed when the
     * call ends (and the whole folder at server start). Outside every backup root.
     */
    scratch: path.join(root, "scratch"),
    /**
     * Sandboxed-worker job folders (#122): `worker-scratch/<job id>`, one per extraction, document or render run
     * through the worker account's launcher (input copies, the browser profile); removed when the job ends and every
     * left-over at server start. Its own root and ACL (the worker account's group), apart from python's `scratch`.
     */
    workerScratch: path.join(root, "worker-scratch"),
    /** `python_run` packages (#47): `python-packages/<lock hash>/`, made by `pnpm python:install`. Derived data. */
    pythonPackages: path.join(root, "python-packages"),
    conversationFiles: (userId: string, conversationId: string) =>
      path.join(root, "files", assertSafeId("user", userId), assertSafeId("conversation", conversationId)),
    runtimeHome: (connectionId: string) =>
      path.join(root, "runtimes", assertSafeId("connection", connectionId)),
    uploadedFile: (userId: string, conversationId: string, fileId: string) =>
      path.join(
        root,
        "files",
        assertSafeId("user", userId),
        assertSafeId("conversation", conversationId),
        assertSafeId("file", fileId),
      ),
    artifactDir: (artifactId: string) => path.join(root, "artifacts", assertSafeId("artifact", artifactId)),
  };
}

export type StoragePaths = ReturnType<typeof storagePaths>;

/** Creates the layout with owner-only permissions. Safe to call on every start. */
export function ensureLayout(dataDir: string): StoragePaths {
  const p = storagePaths(dataDir);
  fs.mkdirSync(p.root, { recursive: true, mode: 0o700 });
  for (const dir of [p.root, p.files, p.artifacts, p.runtimes, p.sources]) {
    if (dir !== p.root) {
      const st = fs.lstatSync(dir, { throwIfNoEntry: false });
      if (st?.isSymbolicLink()) throw new Error(`storage directory must not be a symlink: ${dir}`);
      if (st && !st.isDirectory()) throw new Error(`storage path is not a directory: ${dir}`);
      if (!st) fs.mkdirSync(dir, { mode: 0o700 });
      if (!isInside(dir, p.root)) throw new Error(`storage directory escapes DATA_DIR: ${dir}`);
    }
    // Tighten permissions of pre-existing directories too (owner only).
    if ((fs.statSync(dir).mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  }
  return p;
}
