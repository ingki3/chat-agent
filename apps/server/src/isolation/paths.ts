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

/**
 * Opens a file inside the roots and checks the opened descriptor itself: same file as the checked path (no swap
 * in between), a regular file, a single link. Prefer this over resolveInside + open for reading or writing.
 */
export async function openInside(
  candidate: string,
  roots: readonly string[],
  flags: "r" | "r+" | "w" | "wx" = "r",
): Promise<fs.promises.FileHandle> {
  const full = resolveInside(candidate, roots);
  const noFollow = fs.constants.O_NOFOLLOW;
  const mode = {
    r: fs.constants.O_RDONLY,
    "r+": fs.constants.O_RDWR,
    w: fs.constants.O_WRONLY | fs.constants.O_CREAT,
    wx: fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
  }[flags];
  const fh = await fs.promises.open(full, mode | noFollow, 0o600);
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
