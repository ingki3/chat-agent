import fs from "node:fs";
import path from "node:path";

/**
 * Canonical absolute path: resolves symlinks of the nearest existing ancestor (realpath.native also returns
 * the on-disk letter case on case-insensitive file systems) and appends the not-yet-existing remainder.
 */
export function canonicalPath(p: string): string {
  let current = path.resolve(p);
  const rest: string[] = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    rest.unshift(path.basename(current));
    current = parent;
  }
  const real = fs.existsSync(current) ? fs.realpathSync.native(current) : current;
  return path.join(real, ...rest);
}

/** True when `child` is `parent` itself or anywhere below it, after resolving symlinks and case. */
export function isInside(child: string, parent: string): boolean {
  const norm = (p: string) =>
    process.platform === "darwin" || process.platform === "win32" ? p.toLowerCase() : p;
  const c = norm(canonicalPath(child));
  const pr = norm(canonicalPath(parent));
  const rel = path.relative(pr, c);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
