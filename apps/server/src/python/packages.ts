import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pythonRuntime, type PythonRuntime } from "../mcp/python.js";
import { storagePaths } from "../storage/paths.js";
import type { PythonAccount } from "./account.js";

/**
 * Where `python_run` (#47) gets its interpreter and packages from:
 *
 * - the interpreter is the one python skills use (`SKILL_PYTHON`, a self-contained build — `mcp/python.ts`), and
 *   it must be CPython 3.12 (the pinned wheels are built for it);
 * - the packages (numpy, pandas and what they need — `apps/server/scratchpad/requirements.lock`: exact versions,
 *   wheel hashes) are installed once by `pnpm python:install` into `<DATA_DIR>/python-packages/<lock hash>-py3.12/`
 *   with pip's `--target` — never into the interpreter, never system-wide — and made read-only. The run puts that
 *   folder first on `sys.path`; the interpreter starts with `-I -S` (no site-packages, no user site, no PYTHON*
 *   variables), so nothing else is importable.
 *
 * Nothing here installs anything on its own: without the folder the tool answers `python_not_installed`.
 */

/** Folder of the interpreter-side runner and the lock file (the same from src/ and dist/). */
export const SCRATCHPAD_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../scratchpad");
export const RUNNER_ENTRY = path.join(SCRATCHPAD_DIR, "runner.py");
export const PACKAGES_LOCK = path.join(SCRATCHPAD_DIR, "requirements.lock");
/** The python the lock is for. */
export const PYTHON_VERSION = "3.12";
const MANIFEST = ".agentlee-packages.json";

/**
 * The interpreter, the package folder and (in production) the dedicated account a run uses. `packages` undefined =
 * the standard library only; `account` undefined = run as the server's own uid (tests and the CLI self-check only —
 * never offered to the model). `accountUid` is the account's uid, known from the self-check, used to accept its
 * output files.
 */
export type PythonEnv = {
  runtime: PythonRuntime;
  packages?: string | undefined;
  account?: PythonAccount | undefined;
  accountUid?: number | undefined;
};

export type ScratchpadState =
  | { state: "available"; env: PythonEnv }
  /** `PYTHON_RUN` is not 1 (#47 round 2: off by default). */
  | { state: "disabled"; reason: string }
  /** No usable interpreter: `SKILL_PYTHON` missing, not a standalone build, or not 3.12. */
  | { state: "needs_python"; reason: string }
  /** The interpreter is fine, the pinned packages are not installed (`pnpm python:install`). */
  | { state: "not_installed"; reason: string }
  /** No dedicated account configured, or the startup self-check did not pass (#47 round 2). */
  | { state: "needs_account"; reason: string };

/** sha256 of the lock file (hex). */
export function lockHash(): string {
  return crypto.createHash("sha256").update(fs.readFileSync(PACKAGES_LOCK)).digest("hex");
}

/** The folder the lock installs into. */
export function packagesDir(dataDir: string): string {
  return path.join(storagePaths(dataDir).pythonPackages, `${lockHash().slice(0, 16)}-py${PYTHON_VERSION}`);
}

/** `3.12` for `<root>/bin/python3.12`, else the one `lib/python3.N` folder of the install. */
export function pythonVersionOf(rt: PythonRuntime): string | undefined {
  const m = /^python(3\.\d+)$/.exec(path.basename(rt.exe));
  if (m) return m[1];
  try {
    const libs = fs.readdirSync(path.join(rt.root, "lib")).filter((n) => /^python3\.\d+$/.test(n));
    return libs.length === 1 ? libs[0]!.slice("python".length) : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `dir` is a plain folder (no link) holding the manifest of this lock and python. */
function installed(dir: string): boolean {
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st?.isDirectory() || st.isSymbolicLink()) return false;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8")) as Record<string, unknown>;
    return m.lock === lockHash() && m.python === PYTHON_VERSION;
  } catch {
    return false;
  }
}

/**
 * What `python_run` can do on this server now (#47 round 2). Fail closed: `PYTHON_RUN=1`, the interpreter, the
 * packages, a configured account AND a passed self-check are all required before the tool is `available`. The
 * self-check is run once at startup (expensive); its result is passed in as `account` (the verified account with
 * its uid) or its failure reason.
 */
export function scratchpadState(
  skillPython: string | undefined,
  dataDir: string,
  opts: {
    pythonRun: boolean;
    /** The verified account (self-check passed), its uid; or the reason it is not usable. */
    account?: { account: PythonAccount; uid: number } | undefined;
    accountReason?: string | undefined;
  },
): ScratchpadState {
  if (!opts.pythonRun) return { state: "disabled", reason: "PYTHON_RUN is not 1" };
  const py = pythonRuntime(skillPython);
  if (!py.ok) return { state: "needs_python", reason: py.reason };
  const v = pythonVersionOf(py.runtime);
  if (v !== PYTHON_VERSION)
    return {
      state: "needs_python",
      reason: `python ${PYTHON_VERSION} required (SKILL_PYTHON is ${v ?? "?"})`,
    };
  const dir = packagesDir(dataDir);
  if (!installed(dir))
    return { state: "not_installed", reason: "packages not installed (pnpm python:install)" };
  if (!opts.account)
    return { state: "needs_account", reason: opts.accountReason ?? "PYTHON_RUN_USER not configured" };
  return {
    state: "available",
    env: {
      runtime: py.runtime,
      packages: dir,
      account: opts.account.account,
      accountUid: opts.account.uid,
    },
  };
}

/**
 * The interpreter and package folder when both are ready (for the account self-check, which needs them before the
 * account is verified) — without the account. Otherwise the reason it is not ready.
 */
export function pythonRuntimeEnv(
  skillPython: string | undefined,
  dataDir: string,
): { ok: true; env: PythonEnv } | { ok: false; reason: string } {
  const py = pythonRuntime(skillPython);
  if (!py.ok) return { ok: false, reason: py.reason };
  if (pythonVersionOf(py.runtime) !== PYTHON_VERSION)
    return { ok: false, reason: `python ${PYTHON_VERSION} required` };
  const dir = packagesDir(dataDir);
  if (!installed(dir)) return { ok: false, reason: "packages not installed (pnpm python:install)" };
  return { ok: true, env: { runtime: py.runtime, packages: dir } };
}

/** Every folder and file below `dir` (not following links) set to `dirMode` / `fileMode`. */
function chmodTree(dir: string, dirMode: number, fileMode: number): void {
  // Folders writable first when opening them up (to reach what is inside), read-only last when closing them.
  const opening = (dirMode & 0o200) !== 0;
  if (opening) fs.chmodSync(dir, dirMode);
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) chmodTree(p, dirMode, fileMode);
    else fs.chmodSync(p, fileMode);
  }
  if (!opening) fs.chmodSync(dir, dirMode);
}

/**
 * `pnpm python:install`: installs the lock into a temporary folder next to the target (pip with exact versions and
 * hashes, wheels only, no dependencies beyond the lock), writes the manifest, makes it read-only and moves it into
 * place. Network: PyPI, from this command only (an admin runs it; the server never does). Throws on failure.
 */
export function installPackages(
  runtime: PythonRuntime,
  dataDir: string,
  o: { log?: (line: string) => void } = {},
): string {
  const v = pythonVersionOf(runtime);
  if (v !== PYTHON_VERSION) throw new Error(`python ${PYTHON_VERSION} required, SKILL_PYTHON is ${v ?? "?"}`);
  const root = storagePaths(dataDir).pythonPackages;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = packagesDir(dataDir);
  const tmp = path.join(root, `.tmp-${crypto.randomUUID()}`);
  try {
    const r = spawnSync(
      runtime.exe,
      [
        "-I",
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-input",
        "--no-deps",
        "--require-hashes",
        "--only-binary=:all:",
        "--no-warn-script-location",
        "--target",
        tmp,
        "-r",
        PACKAGES_LOCK,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`pip exited with ${r.status ?? r.signal}`);
    // Console scripts (f2py, numpy-config) are not needed: nothing is started from this folder.
    fs.rmSync(path.join(tmp, "bin"), { recursive: true, force: true });
    fs.writeFileSync(
      path.join(tmp, MANIFEST),
      JSON.stringify({ lock: lockHash(), python: PYTHON_VERSION, installedAt: new Date().toISOString() }),
    );
    chmodTree(tmp, 0o555, 0o444);
    if (fs.existsSync(dir)) {
      chmodTree(dir, 0o755, 0o644);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.renameSync(tmp, dir);
    o.log?.(`installed into ${dir}`);
    return dir;
  } finally {
    if (fs.existsSync(tmp)) {
      try {
        chmodTree(tmp, 0o755, 0o644);
      } catch {
        // removed below as far as possible
      }
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}
