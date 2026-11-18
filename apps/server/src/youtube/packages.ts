import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pythonRuntime, type PythonRuntime } from "../mcp/python.js";
import { pythonVersionOf } from "../python/packages.js";
import { storagePaths } from "../storage/paths.js";
import {
  ffmpegOf,
  installPinnedPackages,
  PYTHON_VERSION,
  readManifest,
  sha256File,
  type Ffmpeg,
} from "../audio/packages.js";

/**
 * Where `youtube_audio_fetch` (#191) gets its programs from — the rules of `audio_transcribe` (#173):
 *
 * - the interpreter is `SKILL_PYTHON` (a self-contained CPython 3.12);
 * - yt-dlp, its JS challenge scripts (yt-dlp-ejs) and the JS runtime it runs them with (deno — the PyPI wheel holds
 *   the binary) are pinned in `apps/server/youtube/requirements.lock` (exact versions and wheel hashes) and installed
 *   by `pnpm youtube:install` into `<DATA_DIR>/youtube-packages/<lock hash>-py3.12/` (pip `--target`, read-only;
 *   `bin/deno` is the only program kept). Never the admin's Homebrew yt-dlp or anything on PATH. yt-dlp may be newer
 *   than the usual two weeks (≥ 3 days — docs/decisions/isolation.md "유튜브 음성 받기 (#191)");
 * - ffmpeg is `audio_transcribe`'s (`AUDIO_FFMPEG`, default Homebrew's — ops §46).
 *
 * Nothing here installs anything on its own: without the folder the tool answers `youtube_not_installed`.
 */

/** Folder of the interpreter-side script and the lock (the same from src/ and dist/). */
export const YOUTUBE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../youtube");
export const YOUTUBE_ENTRY = path.join(YOUTUBE_DIR, "fetch.py");
export const YOUTUBE_LOCK = path.join(YOUTUBE_DIR, "requirements.lock");
/** The JS runtime inside the installed folder (the deno wheel's script). */
export const DENO_IN_PACKAGES = "bin/deno";

export const youtubeLockHash = () => sha256File(YOUTUBE_LOCK);

/** The folder the lock installs into. */
export function youtubePackagesDir(dataDir: string): string {
  return path.join(
    storagePaths(dataDir).youtubePackages,
    `${youtubeLockHash().slice(0, 16)}-py${PYTHON_VERSION}`,
  );
}

export type YoutubeEnv = {
  runtime: PythonRuntime;
  /** The installed packages folder (on `sys.path` of the script). */
  packages: string;
  /** The pinned deno binary in it. */
  deno: string;
  ffmpeg: Ffmpeg;
};

export type YoutubeState =
  | { state: "available"; env: YoutubeEnv }
  /** Not macOS: no sandbox. */
  | { state: "unavailable"; reason: string }
  | { state: "needs_python"; reason: string }
  | { state: "needs_ffmpeg"; reason: string }
  /** `pnpm youtube:install` not run (or for another lock). */
  | { state: "not_installed"; reason: string };

/** What `youtube_audio_fetch` can do on this server now. Fail closed: everything must be in place. */
export function youtubeState(
  skillPython: string | undefined,
  dataDir: string,
  ffmpegPath?: string,
  platform: NodeJS.Platform = process.platform,
): YoutubeState {
  if (platform !== "darwin") return { state: "unavailable", reason: "macOS only (sandbox-exec)" };
  const py = pythonRuntime(skillPython);
  if (!py.ok) return { state: "needs_python", reason: py.reason };
  const v = pythonVersionOf(py.runtime);
  if (v !== PYTHON_VERSION)
    return {
      state: "needs_python",
      reason: `python ${PYTHON_VERSION} required (SKILL_PYTHON is ${v ?? "?"})`,
    };
  const ff = ffmpegOf(ffmpegPath, dataDir);
  if (!ff.ok) return { state: "needs_ffmpeg", reason: ff.reason };
  const packages = youtubePackagesDir(dataDir);
  const m = readManifest(packages);
  if (m?.lock !== youtubeLockHash() || m.python !== PYTHON_VERSION)
    return { state: "not_installed", reason: "packages not installed (pnpm youtube:install)" };
  const deno = path.join(packages, DENO_IN_PACKAGES);
  const st = fs.lstatSync(deno, { throwIfNoEntry: false });
  if (!st?.isFile() || (st.mode & 0o111) === 0)
    return { state: "not_installed", reason: "deno missing from the packages (pnpm youtube:install)" };
  return { state: "available", env: { runtime: py.runtime, packages, deno, ffmpeg: ff.ffmpeg } };
}

/** `pnpm youtube:install`: the lock with pip (exact versions and hashes, wheels only), deno kept as a program. */
export function installYoutubePackages(
  runtime: PythonRuntime,
  dataDir: string,
  o: { log?: (line: string) => void } = {},
): string {
  return installPinnedPackages(runtime, {
    root: storagePaths(dataDir).youtubePackages,
    dir: youtubePackagesDir(dataDir),
    lock: YOUTUBE_LOCK,
    executables: [DENO_IN_PACKAGES],
    log: o.log,
  });
}
