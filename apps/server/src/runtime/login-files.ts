import fs from "node:fs";
import path from "node:path";

/**
 * Files in a login folder (#18 review), which a login process can write to: the server never follows a link
 * there. Every path component below the trusted folder is checked with `lstat`; files are opened with
 * `O_NOFOLLOW` and checked on the open descriptor (`fstat`: a regular file, one link, a sane size, the same file
 * that was checked) before anything is read or overwritten; and the folder the file sits in must still be the one
 * that was checked (a component swapped for a link after the check is caught by comparing device and inode).
 * Anything that is not a plain file or folder (a link, a socket, …) is removed itself — its target never.
 */

const MAX_TOKENS_FILE = 1024 * 1024;
const { O_RDONLY, O_RDWR, O_NOFOLLOW } = fs.constants;

/** Test hooks: run between the checks and the open (to swap a path component). */
export type LoginFileHooks = { beforeOpen?: (file: string) => void };

type Id = { dev: number; ino: number };
const same = (a: Id, b: Id) => a.dev === b.dev && a.ino === b.ino;

/**
 * `rel` below `root` (one or more components): each must be a real folder (not a link), and the last a regular
 * file. Returns the folder chain's identities and the file's, or undefined.
 */
export function checkPath(root: string, rel: string[]): { dirs: [string, Id][]; file: fs.Stats } | undefined {
  const dirs: [string, Id][] = [];
  let cur = root;
  try {
    const st = fs.lstatSync(root);
    if (!st.isDirectory()) return undefined;
    dirs.push([root, st]);
    for (const part of rel.slice(0, -1)) {
      cur = path.join(cur, part);
      const s = fs.lstatSync(cur);
      if (!s.isDirectory()) return undefined; // a link (or anything else) in the way: never followed
      dirs.push([cur, s]);
    }
    const file = fs.lstatSync(path.join(cur, rel.at(-1)!));
    return file.isFile() ? { dirs, file } : undefined;
  } catch {
    return undefined;
  }
}

/** The folders checked before the open are still the same ones (no component swapped for a link meanwhile). */
export function stillSame(dirs: [string, Id][]): boolean {
  try {
    return dirs.every(([p, id]) => {
      const s = fs.lstatSync(p);
      return s.isDirectory() && same(s, id);
    });
  } catch {
    return false;
  }
}

/**
 * Opens `root/rel…` without following any link, and calls `use` with the descriptor if it is a regular file with
 * one link and at most `MAX_TOKENS_FILE` bytes. Returns `use`'s value, or undefined when the checks fail.
 */
function withFile<T>(
  root: string,
  rel: string[],
  flags: number,
  use: (fd: number, st: fs.Stats) => T,
  hooks: LoginFileHooks = {},
): T | undefined {
  const checked = checkPath(root, rel);
  if (!checked) return undefined;
  const file = path.join(root, ...rel);
  hooks.beforeOpen?.(file);
  let fd: number;
  try {
    fd = fs.openSync(file, flags | O_NOFOLLOW);
  } catch {
    return undefined; // a link at the last component (ELOOP), or gone
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > MAX_TOKENS_FILE) return undefined;
    if (!same(st, checked.file) || !stillSame(checked.dirs)) return undefined;
    return use(fd, st);
  } finally {
    fs.closeSync(fd);
  }
}

/** Reads a tokens file safely (see above). Undefined when it is missing or not a plain, single-link file. */
export function readLoginFile(root: string, rel: string[], hooks?: LoginFileHooks): string | undefined {
  return withFile(
    root,
    rel,
    O_RDONLY,
    (fd, st) => {
      const buf = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) {
        const n = fs.readSync(fd, buf, off, st.size - off, off);
        if (n === 0) break;
        off += n;
      }
      return buf.subarray(0, off).toString("utf8");
    },
    hooks,
  );
}

/**
 * Overwrites a tokens file with zeros through its own descriptor, then removes it — only when it passed the
 * checks. A file with more than one link is not overwritten (the other name is not ours): its name is removed.
 * A link is removed itself. Returns what was done.
 */
export function shredLoginFile(
  root: string,
  rel: string[],
  hooks?: LoginFileHooks,
): "shredded" | "unlinked" | "missing" | "refused" {
  const file = path.join(root, ...rel);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return "missing";
  }
  const checked = checkPath(root, rel);
  // Not a plain file (a link, …): the entry itself is removed when the folders above it are real; its target, or
  // anything behind a linked folder, is never touched.
  if (!checked) return removeEntryIfDirect(root, rel) ? "unlinked" : "refused";
  if (st.nlink !== 1) return removeEntryIfDirect(root, rel) ? "unlinked" : "refused";
  const done = withFile(
    root,
    rel,
    O_RDWR,
    (fd, s) => {
      fs.writeSync(fd, Buffer.alloc(s.size), 0, s.size, 0);
      fs.fsyncSync(fd);
      return true;
    },
    hooks,
  );
  if (!done) return "refused";
  return removeEntryIfDirect(root, rel) ? "shredded" : "refused";
}

/** Unlinks `root/rel…` (never following it) when every folder above it is a real folder of the tree. */
function removeEntryIfDirect(root: string, rel: string[]): boolean {
  let cur = root;
  try {
    for (const part of [".", ...rel.slice(0, -1)]) {
      cur = part === "." ? root : path.join(cur, part);
      if (!fs.lstatSync(cur).isDirectory()) return false;
    }
    fs.unlinkSync(path.join(cur, rel.at(-1)!)); // unlink never follows a link
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes a login folder tree without following links: links and other non-folders are unlinked themselves,
 * real folders are emptied and removed. `root` itself must be a real folder (a link there is only unlinked).
 */
export function removeLoginTree(root: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(root);
  } catch {
    return;
  }
  if (!st.isDirectory()) {
    try {
      fs.unlinkSync(root);
    } catch {
      // gone
    }
    return;
  }
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    // unreadable: try to remove it as it is
  }
  for (const n of names) {
    const p = path.join(root, n);
    try {
      if (fs.lstatSync(p).isDirectory()) removeLoginTree(p);
      else fs.unlinkSync(p);
    } catch {
      // gone meanwhile
    }
  }
  try {
    fs.rmdirSync(root);
  } catch {
    // something appeared meanwhile: best effort, the next start tries again
  }
}
