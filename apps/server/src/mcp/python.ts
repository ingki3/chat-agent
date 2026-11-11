import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isInside } from "../fs-safety.js";

/**
 * The python that runs python skills (#21). It must start without forking and without reading anything outside
 * its own install folder, because the sandbox allows exactly that folder (trusted, read-only) and no
 * `process-fork`:
 *
 * - **Framework builds** (Homebrew `python@3.x`, python.org): `bin/python3.x` re-launches
 *   `Resources/Python.app/…/Python` with posix_spawn — refused by the sandbox (checked on macOS 27). Its
 *   extension modules also load libssl and others from other Homebrew folders.
 * - **Self-contained builds** (python-build-standalone, as installed by `uv python install 3.12`): one folder,
 *   OpenSSL and friends linked in, only system libraries outside — works in the sandbox (checked: stdlib HTTPS
 *   through the egress proxy, fork refused).
 *
 * So the configured interpreter (`SKILL_PYTHON`) must be `<root>/bin/python3…` of such a build; anything else is
 * refused and python skills are not offered.
 */
export type PythonRuntime = { exe: string; root: string };

export function pythonRuntime(
  configured: string | undefined,
): { ok: true; runtime: PythonRuntime } | { ok: false; reason: string } {
  if (!configured) return { ok: false, reason: "SKILL_PYTHON is not set" };
  if (!path.isAbsolute(configured)) return { ok: false, reason: "SKILL_PYTHON must be an absolute path" };
  let exe: string;
  try {
    exe = fs.realpathSync.native(configured);
  } catch {
    return { ok: false, reason: "SKILL_PYTHON does not exist" };
  }
  const st = fs.statSync(exe);
  if (!st.isFile() || (st.mode & 0o111) === 0) return { ok: false, reason: "SKILL_PYTHON is not executable" };
  if (!/^python3(\.\d+)?$/.test(path.basename(exe)) || path.basename(path.dirname(exe)) !== "bin")
    return { ok: false, reason: "SKILL_PYTHON must be <install>/bin/python3.x" };
  const root = path.dirname(path.dirname(exe));
  if (/\.framework(\/|$)/i.test(root))
    return {
      ok: false,
      reason: "framework python builds re-launch themselves (fork); use a standalone build",
    };
  // The whole install folder becomes readable to skills: it must be the interpreter's own folder only.
  if (root.split(path.sep).filter(Boolean).length < 3 || isInside(os.homedir(), root))
    return { ok: false, reason: "SKILL_PYTHON's install folder is too broad" };
  if (!fs.existsSync(path.join(root, "lib"))) return { ok: false, reason: "no lib folder next to bin" };
  return { ok: true, runtime: { exe, root } };
}
