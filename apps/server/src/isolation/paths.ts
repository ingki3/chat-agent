import fs from "node:fs";
import path from "node:path";
import { canonicalPath, isInside } from "../fs-safety.js";

export class PathDeniedError extends Error {
  constructor(readonly requested: string) {
    super("path is outside the allowed folders");
  }
}

/**
 * Resolves `candidate` (absolute or relative to the first root) and returns its canonical path if it lies inside
 * one of `roots` after resolving `..`, symlinks and letter case — otherwise throws. Use for every path that comes
 * from a runtime, a skill or a user (#42).
 *
 * A path check cannot tell a hard link from the original, so an existing regular file with more than one link
 * is refused: it may be another family member's file under a second name. (Inside the process sandbox, linking
 * to a file outside the allowed folders is itself refused, so such links can only come from outside.)
 */
export function resolveInside(candidate: string, roots: readonly string[]): string {
  if (!roots.length) throw new PathDeniedError(candidate);
  if (candidate.includes("\0")) throw new PathDeniedError(candidate);
  const full = canonicalPath(path.isAbsolute(candidate) ? candidate : path.join(roots[0]!, candidate));
  if (!roots.some((r) => isInside(full, r))) throw new PathDeniedError(candidate);
  const st = fs.statSync(full, { throwIfNoEntry: false });
  if (st?.isFile() && st.nlink > 1) throw new PathDeniedError(candidate);
  return full;
}

/** macOS: fail if *any* component of the path is a symlink (not just the last one). */
const O_NOFOLLOW_ANY = 0x20000000;

export class UnsupportedPlatformError extends Error {
  constructor() {
    super("safe file opening needs macOS (O_NOFOLLOW_ANY)");
  }
}

/** Every regular file below `dir` with more than one link (a hard link may be another family member's file). */
export function findHardLinks(dir: string, limit = 50_000): string[] {
  const found: string[] = [];
  let seen = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (++seen > limit) throw new Error(`too many files under ${dir}`);
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && fs.lstatSync(full).nlink > 1) found.push(full);
    }
  };
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (st?.isDirectory()) walk(dir);
  else if (st?.isFile() && st.nlink > 1) found.push(dir);
  return found;
}

/**
 * Opens a file inside the roots. The checked path is canonical (no symlinks), and the open uses
 * O_NOFOLLOW_ANY: if a directory on the way was swapped for a symlink after the check, the open fails instead of
 * following it outside. The opened descriptor is then checked again (regular file, single link, same inode).
 * Fails closed where O_NOFOLLOW_ANY does not exist (the service runs on macOS).
 */
export async function openInside(
  candidate: string,
  roots: readonly string[],
  flags: "r" | "r+" | "w" | "wx" = "r",
  /** Tests only: runs between the path check and the open (to simulate a swap). */
  beforeOpen?: (full: string) => void,
): Promise<fs.promises.FileHandle> {
  if (process.platform !== "darwin") throw new UnsupportedPlatformError();
  const full = resolveInside(candidate, roots);
  const noFollow = O_NOFOLLOW_ANY;
  const mode = {
    r: fs.constants.O_RDONLY,
    "r+": fs.constants.O_RDWR,
    w: fs.constants.O_WRONLY | fs.constants.O_CREAT,
    wx: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
  }[flags];
  beforeOpen?.(full);
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(full, mode | noFollow, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") throw new PathDeniedError(candidate);
    throw e;
  }
  try {
    const st = await fh.stat();
    const now = fs.lstatSync(full);
    if (!st.isFile() || st.nlink > 1 || st.ino !== now.ino || st.dev !== now.dev)
      throw new PathDeniedError(candidate);
    if (flags === "w") await fh.truncate(0);
    return fh;
  } catch (e) {
    await fh.close();
    throw e instanceof PathDeniedError ? e : new PathDeniedError(candidate);
  }
}
