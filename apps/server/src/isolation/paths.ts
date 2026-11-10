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
 */
export function resolveInside(candidate: string, roots: readonly string[]): string {
  if (!roots.length) throw new PathDeniedError(candidate);
  if (candidate.includes("\0")) throw new PathDeniedError(candidate);
  const full = canonicalPath(path.isAbsolute(candidate) ? candidate : path.join(roots[0]!, candidate));
  if (!roots.some((r) => isInside(full, r))) throw new PathDeniedError(candidate);
  return full;
}
