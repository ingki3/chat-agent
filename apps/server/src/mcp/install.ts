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

/**
 * Reads one file of a source skill folder: a regular file reached without any symlink below the skill folder,
 * with a single link and a sane size. Opened with O_NOFOLLOW and checked on the descriptor.
 */
function readSourceFile(base: string, rel: string): Buffer {
  const full = path.join(base, rel);
  let real: string;
  try {
    real = fs.realpathSync.native(full);
  } catch {
    throw new SkillInstallError(`missing file ${rel}`);
  }
  if (real !== full) throw new SkillInstallError(`${rel} goes through a symlink`);
  const fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new SkillInstallError(`${rel} is not a regular file`);
    if (st.nlink > 1) throw new SkillInstallError(`${rel} is hard-linked`);
    if (st.size > MAX_FILE_BYTES) throw new SkillInstallError(`${rel} is too large`);
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
export function installSkill(spec: SkillSpec, sourceDir: string, root: string): Manifest {
  checkSpec(spec);
  const base = fs.realpathSync.native(sourceDir);
  const contents = spec.files.map((rel) => [rel, readSourceFile(base, rel)] as const);
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
export function checkInstalled(spec: SkillSpec, root: string): { state: InstallState; dir?: string } {
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
    for (const rel of listed)
      if (sha256(readSourceFile(real, rel)) !== manifest.files[rel]) return { state: "broken" };
    return { state: "installed", dir: real };
  } catch {
    return { state: "broken" };
  }
}

/** The installed, intact skills of `specs` in `root`, and the state of each definition. */
export function loadInstalledSkills(
  root: string,
  specs: readonly SkillSpec[],
): { skills: BundledSkill[]; states: Record<string, InstallState> } {
  const skills: BundledSkill[] = [];
  const states: Record<string, InstallState> = {};
  for (const spec of specs) {
    const r = checkInstalled(spec, root);
    states[spec.name] = r.state;
    if (r.dir) skills.push({ ...spec, dir: r.dir, entry: path.join(r.dir, spec.files[0]!) });
  }
  return { skills, states };
}
