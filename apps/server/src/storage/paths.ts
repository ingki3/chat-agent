import fs from "node:fs";
import path from "node:path";

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
    sources: path.join(root, "sources"),
    backups: path.join(root, "backups"),
    conversationFiles: (userId: string, conversationId: string) =>
      path.join(root, "files", assertSafeId("user", userId), assertSafeId("conversation", conversationId)),
    runtimeHome: (connectionId: string) =>
      path.join(root, "runtimes", assertSafeId("connection", connectionId)),
    artifactDir: (artifactId: string) => path.join(root, "artifacts", assertSafeId("artifact", artifactId)),
  };
}

export type StoragePaths = ReturnType<typeof storagePaths>;

/** Creates the layout with owner-only permissions. Safe to call on every start. */
export function ensureLayout(dataDir: string): StoragePaths {
  const p = storagePaths(dataDir);
  for (const dir of [p.root, p.files, p.artifacts, p.runtimes, p.sources, p.backups]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return p;
}
