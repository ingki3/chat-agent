import crypto from "node:crypto";
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
// O_NONBLOCK: a name swapped for a FIFO after the checks must not block the event loop on open (review #91 3차);
// the descriptor's type is checked right after, before any read or write.
const { O_RDONLY, O_RDWR, O_NOFOLLOW, O_NONBLOCK } = fs.constants;

/** Test hooks: run between the checks and the open (to swap a path component). */
export type LoginFileHooks = {
  beforeOpen?: (file: string) => void;
  /** Called for each folder of a tree walk, right before it is listed (to swap something in mid-walk). */
  beforeList?: (dir: string) => void;
};

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
    fd = fs.openSync(file, flags | O_NOFOLLOW | O_NONBLOCK);
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
  o: { keepName?: boolean } = {},
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
  // `keepName`: the folder may still have a live writer, so nothing is removed by name here (a swapped folder above
  // it would make that name point elsewhere) — the zeroed file goes with the folder, after quarantine.
  if (!checked) return !o.keepName && removeEntryIfDirect(root, rel) ? "unlinked" : "refused";
  if (st.nlink !== 1) return !o.keepName && removeEntryIfDirect(root, rel) ? "unlinked" : "refused";
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
  if (o.keepName) return "shredded";
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
 * Removes a folder tree without following links: links and other non-folders are unlinked themselves, real
 * folders are emptied and removed. Works by path (Node has no openat/fdopendir), so it is only safe on a tree
 * nobody else can change meanwhile — a login folder goes through `disposeLoginFolder` (quarantine) first.
 */
export function removeLoginTree(root: string, hooks: LoginFileHooks = {}): void {
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
  hooks.beforeList?.(root);
  try {
    names = fs.readdirSync(root);
  } catch {
    // unreadable: try to remove it as it is
  }
  for (const n of names) {
    const p = path.join(root, n);
    try {
      if (fs.lstatSync(p).isDirectory()) removeLoginTree(p, hooks);
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

/**
 * The server's quarantine for login folders: `DATA_DIR/runtimes/.quarantine`, owner-only. No sandbox profile
 * allows writing there — a login process may write only its own `codex-home` and `tmp`, session processes only
 * theirs (checked against `buildProfile` in the tests) — and its name never matches a connection or login folder.
 */
export function quarantineDir(dataDir: string): string {
  return path.join(dataDir, "runtimes", ".quarantine");
}

function ensureQuarantine(q: string): boolean {
  try {
    fs.mkdirSync(q, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(q);
    if (!st.isDirectory()) return false;
    fs.chmodSync(q, 0o700);
    return true;
  } catch {
    return false;
  }
}

/**
 * Disposes of a login folder that a login process could write to — maybe one still alive (review #91 3차):
 *  1. the whole folder is renamed into the quarantine (one atomic `rename` on the same file system; the folder's
 *     own entry is not writable by the process — its parent is not in its profile);
 *  2. sandbox-exec's write rules are path rules (`(subpath …)` of `codex-home` and `tmp`): once the tree is under
 *     the quarantine, a writer still alive can no longer create, link or rename anything in it, even through
 *     descriptors it holds — the check is on the path the object has now;
 *  3. only then is the tokens file zeroed and the tree walked and removed, never following a link (a link planted
 *     before the rename is unlinked itself).
 * If the rename fails the folder is left as it is (never walked in place) and the next start tries again.
 */
export function disposeLoginFolder(dir: string, quarantine: string, hooks?: LoginFileHooks): boolean {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return true; // nothing there
  }
  if (!st.isDirectory()) {
    try {
      fs.unlinkSync(dir); // a link where the folder should be: only the link goes
    } catch {
      // gone
    }
    return true;
  }
  if (!ensureQuarantine(quarantine)) return false;
  const target = path.join(quarantine, `${path.basename(dir)}-${crypto.randomUUID()}`);
  try {
    fs.renameSync(dir, target);
  } catch {
    return false;
  }
  shredLoginFile(target, ["codex-home", "auth.json"], hooks);
  removeLoginTree(target, hooks);
  return true;
}

/** Startup: whatever an earlier disposal left in the quarantine (it died mid-walk) is removed. */
export function emptyQuarantine(quarantine: string, hooks?: LoginFileHooks): void {
  let names: string[];
  try {
    if (!fs.lstatSync(quarantine).isDirectory()) return;
    names = fs.readdirSync(quarantine);
  } catch {
    return;
  }
  for (const n of names) {
    const p = path.join(quarantine, n);
    shredLoginFile(p, ["codex-home", "auth.json"], hooks);
    removeLoginTree(p, hooks);
  }
}
