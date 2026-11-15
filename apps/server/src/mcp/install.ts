import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { BundledSkill, SkillSpec } from "@agentlee/mcp-tools/skills";
import { canonicalPath } from "../fs-safety.js";

/**
 * The server's own skill folder (#21, PRD D5): `<DATA_DIR>/skills/<name>/`. Only allow-listed skills (those with a
 * definition, `SKILL_SPECS`) are installed there, and of each only the files its definition lists — never the rest
 * of the admin's skill folder (venvs, `.env`, `config.json` with keys, tests, backups). The skills are *copied*,
 * not linked: a link would make the sandbox read the admin's real folder, secrets included.
 *
 * `installSkill` copies (run by the admin: `pnpm skills:install`); `loadInstalledSkills` checks what is there at
 * server start and offers only skills that are exactly what was installed.
 */

export const MANIFEST = ".agentlee-skill.json";
/** Skill files are small scripts. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Relative file names a definition may list: plain segments, no `..`, no absolute paths, no backslashes. */
const REL = /^(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/;
const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export class SkillInstallError extends Error {}

type Manifest = { name: string; files: Record<string, string> };

const sha256 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");

/** Refuses definitions whose names or file lists could leave the skill's folder. */
export function checkSpec(spec: Pick<SkillSpec, "name" | "files">): void {
  if (!NAME.test(spec.name)) throw new SkillInstallError(`bad skill name ${JSON.stringify(spec.name)}`);
  if (!spec.files.length) throw new SkillInstallError(`${spec.name}: no files`);
  for (const f of spec.files)
    if (!REL.test(f)) throw new SkillInstallError(`${spec.name}: bad file ${JSON.stringify(f)}`);
}

/** macOS: fail if *any* component of the path is a symlink (not only the last one), as `openInside` does. */
const O_NOFOLLOW_ANY = 0x20000000;

/** Tests only: runs between the path check and the open (to swap a folder for a symlink in between). */
export type OpenHook = (full: string) => void;

/**
 * Opens `full` for reading so that no symlink anywhere on the path is followed, even one swapped in after the
 * check: O_NOFOLLOW_ANY on macOS (the service's platform). Elsewhere (CI) O_NOFOLLOW guards the last component and
 * the kernel's own path of the opened descriptor (`/proc/self/fd`) must be the checked path.
 */
function openNoFollow(full: string): number {
  const base = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;
  if (process.platform === "darwin") return fs.openSync(full, base | O_NOFOLLOW_ANY);
  const fd = fs.openSync(full, base | fs.constants.O_NOFOLLOW);
  let real: string | undefined;
  try {
    real = fs.readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    real = undefined;
  }
  if (real !== full) {
    fs.closeSync(fd);
    throw Object.assign(new Error("path changed"), { code: "ELOOP" });
  }
  return fd;
}

/**
 * Reads one file of a skill folder (`base` is canonical): a regular file reached without any symlink below the
 * folder — checked by path first, then enforced by the open itself (`openNoFollow`) — single-link, a sane size,
 * and the very file that was checked (inode).
 */
function readSourceFile(base: string, rel: string, beforeOpen?: OpenHook): Buffer {
  const full = path.join(base, rel);
  let real: string;
  try {
    real = fs.realpathSync.native(full);
  } catch {
    throw new SkillInstallError(`missing file ${rel}`);
  }
  if (real !== full) throw new SkillInstallError(`${rel} goes through a symlink`);
  beforeOpen?.(full);
  let fd: number;
  try {
    fd = openNoFollow(full);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new SkillInstallError(`${rel} goes through a symlink`);
    throw new SkillInstallError(`cannot open ${rel}`);
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new SkillInstallError(`${rel} is not a regular file`);
    if (st.nlink > 1) throw new SkillInstallError(`${rel} is hard-linked`);
    if (st.size > MAX_FILE_BYTES) throw new SkillInstallError(`${rel} is too large`);
    const now = fs.lstatSync(full, { throwIfNoEntry: false });
    if (!now || now.ino !== st.ino || now.dev !== st.dev) throw new SkillInstallError(`${rel} changed`);
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** The first `<source>/<name>` folder that exists. The top-level entry may be a symlink (the admin's layout). */
export function findSource(name: string, sources: readonly string[]): string | undefined {
  for (const s of sources) {
    const p = path.join(s, name);
    try {
      if (fs.statSync(p).isDirectory()) return fs.realpathSync.native(p);
    } catch {
      // not in this source folder
    }
  }
  return undefined;
}

/**
 * Copies the listed files of one skill from `sourceDir` into `<root>/<name>` (replacing an earlier install in one
 * rename) and writes the manifest with their hashes. Files are read-only. Nothing is linked.
 */
export function installSkill(
  spec: SkillSpec,
  sourceDir: string,
  root: string,
  o: { beforeOpen?: OpenHook } = {},
): Manifest {
  checkSpec(spec);
  const base = fs.realpathSync.native(sourceDir);
  const contents = spec.files.map((rel) => [rel, readSourceFile(base, rel, o.beforeOpen)] as const);
  fs.mkdirSync(root, { recursive: true, mode: 0o755 });
  const rootReal = canonicalPath(root);
  const tmp = fs.mkdtempSync(path.join(rootReal, `.tmp-${spec.name}-`));
  try {
    const manifest: Manifest = { name: spec.name, files: {} };
    for (const [rel, data] of contents) {
      const dst = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o755 });
      fs.writeFileSync(dst, data, { flag: "wx", mode: 0o444 });
      manifest.files[rel] = sha256(data);
    }
    fs.writeFileSync(path.join(tmp, MANIFEST), JSON.stringify(manifest, null, 2) + "\n", {
      flag: "wx",
      mode: 0o444,
    });
    const target = path.join(rootReal, spec.name);
    const old = fs.existsSync(target) ? `${tmp}-old` : undefined;
    if (old) fs.renameSync(target, old);
    fs.renameSync(tmp, target);
    if (old) fs.rmSync(old, { recursive: true, force: true });
    return manifest;
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
}

export type InstallState = "installed" | "not_installed" | "broken";

/** Every entry below `dir` (relative), directories included. */
function listAll(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push(r);
      if (e.isDirectory()) walk(path.join(d, e.name), r);
    }
  };
  walk(dir, "");
  return out;
}

/**
 * Checks one installed skill: a real folder (not a symlink) holding exactly the manifest and the listed files —
 * regular, single-link, no symlink anywhere, same hashes as at install. Anything else is "broken" (not offered).
 */
export function checkInstalled(
  spec: SkillSpec,
  root: string,
): { state: InstallState; dir?: string; manifest?: Manifest; contents?: Map<string, Buffer> } {
  checkSpec(spec);
  const dir = path.join(root, spec.name);
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st) return { state: "not_installed" };
  if (!st.isDirectory()) return { state: "broken" };
  try {
    const real = canonicalPath(dir);
    const manifest = JSON.parse(readSourceFile(real, MANIFEST).toString("utf8")) as Manifest;
    const listed = [...spec.files].sort();
    if (
      manifest.name !== spec.name ||
      JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(listed)
    )
      return { state: "broken" };
    // Nothing else may be in the folder (a key file dropped there would be readable by the skill).
    const dirs = new Set(
      listed.flatMap((f) =>
        f
          .split("/")
          .slice(0, -1)
          .map((_, i, a) => a.slice(0, i + 1).join("/")),
      ),
    );
    for (const e of listAll(real))
      if (e !== MANIFEST && !listed.includes(e) && !dirs.has(e)) return { state: "broken" };
    const contents = new Map<string, Buffer>();
    for (const rel of listed) {
      const data = readSourceFile(real, rel);
      if (sha256(data) !== manifest.files[rel]) return { state: "broken" };
      contents.set(rel, data);
    }
    return { state: "installed", dir: real, manifest, contents };
  } catch {
    return { state: "broken" };
  }
}

/** Folder of the pinned copies, inside the skill folder (not a valid skill name, so never taken for a skill). */
export const PINNED = ".pinned";

type PinnedFile = { rel: string; sha: string; size: number; mtimeMs: number; ino: number; dev: number };
type Pin = { dir: string; ino: number; dev: number; files: PinnedFile[]; entries: string[] };

/** The relative folders a file list needs (`a/b/c.py` → `a`, `a/b`). */
const parentsOf = (files: readonly string[]) =>
  new Set(
    files.flatMap((f) =>
      f
        .split("/")
        .slice(0, -1)
        .map((_, i, a) => a.slice(0, i + 1).join("/")),
    ),
  );

/** Removes a pinned copy (its folders are read-only). */
function removePinned(dir: string): void {
  if (!fs.existsSync(dir)) return;
  const walk = (d: string) => {
    fs.chmodSync(d, 0o755);
    for (const e of fs.readdirSync(d, { withFileTypes: true }))
      if (e.isDirectory()) walk(path.join(d, e.name));
  };
  walk(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Checks a pinned copy: the same folder (inode), exactly the expected entries, and each file the same regular
 * single-link file — by inode, size and mtime (cheap), or else by its full hash.
 */
export function verifyPinned(pin: Pin): boolean {
  try {
    const st = fs.lstatSync(pin.dir);
    if (!st.isDirectory() || st.ino !== pin.ino || st.dev !== pin.dev) return false;
    if (JSON.stringify(listAll(pin.dir).sort()) !== JSON.stringify(pin.entries)) return false;
    for (const f of pin.files) {
      const fst = fs.lstatSync(path.join(pin.dir, f.rel));
      if (!fst.isFile() || fst.nlink !== 1) return false;
      const same = fst.ino === f.ino && fst.dev === f.dev && fst.size === f.size && fst.mtimeMs === f.mtimeMs;
      if (!same && sha256(readSourceFile(pin.dir, f.rel)) !== f.sha) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Pins a verified installed skill: its checked contents are written to `<root>/.pinned/<hash of the manifest>/`
 * (content-addressed, files and folders read-only) and the skill runs only from there. An existing pin with the
 * same hash is reused when it is still intact, else rewritten. Returns the pin record for `verifyPinned`.
 */
function pinSkill(manifest: Manifest, contents: Map<string, Buffer>, root: string): Pin {
  const id = sha256(
    Buffer.from(JSON.stringify([manifest.name, Object.entries(manifest.files).sort()]), "utf8"),
  );
  const pinned = path.join(root, PINNED);
  fs.mkdirSync(pinned, { recursive: true, mode: 0o755 });
  const dir = path.join(canonicalPath(pinned), id);
  const rels = [...contents.keys()].sort();
  const entries = [...rels, ...parentsOf(rels)].sort();
  const record = (): Pin => {
    const st = fs.lstatSync(dir);
    return {
      dir,
      ino: st.ino,
      dev: st.dev,
      entries,
      files: rels.map((rel) => {
        const f = fs.lstatSync(path.join(dir, rel));
        return { rel, sha: manifest.files[rel]!, size: f.size, mtimeMs: f.mtimeMs, ino: f.ino, dev: f.dev };
      }),
    };
  };
  if (fs.existsSync(dir)) {
    try {
      const existing = record();
      // Full check of what was there before (a stale pin may have been changed while the server was down).
      if (verifyPinned({ ...existing, files: existing.files.map((f) => ({ ...f, ino: -1 })) }))
        return existing;
    } catch {
      // rewritten below
    }
    removePinned(dir);
  }
  const tmp = fs.mkdtempSync(path.join(canonicalPath(pinned), ".tmp-"));
  try {
    for (const rel of rels) {
      const dst = path.join(tmp, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true, mode: 0o755 });
      fs.writeFileSync(dst, contents.get(rel)!, { flag: "wx", mode: 0o444 });
    }
    for (const d of [...parentsOf(rels)].sort().reverse()) fs.chmodSync(path.join(tmp, d), 0o555);
    fs.chmodSync(tmp, 0o555);
    fs.renameSync(tmp, dir);
  } catch (e) {
    removePinned(tmp);
    throw e;
  }
  return record();
}

/**
 * The installed, intact skills of `specs` in `root` — each pinned (see `pinSkill`) and re-checked before every run
 * (`verify`) — and the state of each definition. Pins no longer used are removed.
 */
export function loadInstalledSkills(
  root: string,
  specs: readonly SkillSpec[],
): { skills: BundledSkill[]; states: Record<string, InstallState> } {
  const skills: BundledSkill[] = [];
  const states: Record<string, InstallState> = {};
  const used = new Set<string>();
  for (const spec of specs) {
    const r = checkInstalled(spec, root);
    states[spec.name] = r.state;
    if (!r.dir || !r.manifest || !r.contents) continue;
    let pin: Pin;
    try {
      pin = pinSkill(r.manifest, r.contents, root);
    } catch {
      states[spec.name] = "broken";
      continue;
    }
    used.add(path.basename(pin.dir));
    skills.push({
      ...spec,
      dir: pin.dir,
      entry: path.join(pin.dir, spec.files[0]!),
      verify: () => verifyPinned(pin),
    });
  }
  const pinned = path.join(root, PINNED);
  if (fs.existsSync(pinned))
    for (const e of fs.readdirSync(pinned)) if (!used.has(e)) removePinned(path.join(pinned, e));
  return { skills, states };
}
