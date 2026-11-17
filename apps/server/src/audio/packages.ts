import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { isInside } from "../fs-safety.js";
import { pythonRuntime, type PythonRuntime } from "../mcp/python.js";
import { pythonVersionOf } from "../python/packages.js";
import { storagePaths } from "../storage/paths.js";

/**
 * Where `audio_transcribe` (#173) gets its programs from — the same rules as `python_run` (#47, python/packages.ts):
 *
 * - the interpreter is `SKILL_PYTHON` (a self-contained CPython 3.12 — the pinned wheels are built for it);
 * - the packages (`apps/server/audio/requirements.lock`: mlx-audio and what it needs, exact versions and wheel hashes,
 *   every file at least two weeks old) are installed by `pnpm audio:install` into
 *   `<DATA_DIR>/audio-packages/<lock hash>-py3.12/` with pip's `--target`, then made read-only;
 * - the model weights (`apps/server/audio/models.json`: Hugging Face repo, commit, every file's size and SHA-256) are
 *   downloaded by the same command into `<DATA_DIR>/audio-models/<manifest hash>/<key>/`, checked, made read-only —
 *   never the admin's `~/.cache/huggingface`, and never at run time (the runs have no network: `HF_HUB_OFFLINE=1`
 *   and the sandbox);
 * - ffmpeg (`AUDIO_FFMPEG`, default Homebrew's) converts uploads to 16 kHz mono WAV in its own sandbox.
 *
 * Nothing here installs anything on its own: without the folders the tool answers `audio_not_installed`.
 */

/** Folder of the interpreter-side script, the lock and the model manifest (the same from src/ and dist/). */
export const AUDIO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../audio");
export const AUDIO_ENTRY = path.join(AUDIO_DIR, "transcribe.py");
export const AUDIO_LOCK = path.join(AUDIO_DIR, "requirements.lock");
export const AUDIO_MODELS = path.join(AUDIO_DIR, "models.json");
export const PYTHON_VERSION = "3.12";
const MANIFEST = ".agentlee-audio.json";
/** Where ffmpeg is looked for when `AUDIO_FFMPEG` is not set. */
export const DEFAULT_FFMPEG = "/opt/homebrew/bin/ffmpeg";

const ModelFile = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  bytes: z.number().int().positive(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
const ModelManifest = z.strictObject({
  models: z
    .array(
      z.strictObject({
        key: z.enum(["stt", "diarizer"]),
        repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
        revision: z.string().regex(/^[0-9a-f]{40}$/),
        files: z.array(ModelFile).min(1),
      }),
    )
    .length(2),
});
export type ModelManifest = z.infer<typeof ModelManifest>;

export function modelManifest(): ModelManifest {
  return ModelManifest.parse(JSON.parse(fs.readFileSync(AUDIO_MODELS, "utf8")));
}

const sha256File = (p: string) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

export function lockHash(): string {
  return sha256File(AUDIO_LOCK);
}
export function manifestHash(): string {
  return sha256File(AUDIO_MODELS);
}

/** The folder the lock installs into. */
export function packagesDir(dataDir: string): string {
  return path.join(storagePaths(dataDir).audioPackages, `${lockHash().slice(0, 16)}-py${PYTHON_VERSION}`);
}

/** The folder the model manifest installs into (`<key>/` below it per model). */
export function modelsDir(dataDir: string): string {
  return path.join(storagePaths(dataDir).audioModels, manifestHash().slice(0, 16));
}

/** ffmpeg and the read-only program folders it loads its libraries from. */
export type Ffmpeg = { exe: string; trusted: string[] };

export type AudioEnv = {
  runtime: PythonRuntime;
  packages: string;
  models: { stt: string; diarizer: string };
  ffmpeg: Ffmpeg;
};

export type AudioState =
  | { state: "available"; env: AudioEnv }
  /** Not macOS: no sandbox, no Metal. */
  | { state: "unavailable"; reason: string }
  | { state: "needs_python"; reason: string }
  | { state: "needs_ffmpeg"; reason: string }
  /** `pnpm audio:install` not run (or for another lock / manifest). */
  | { state: "not_installed"; reason: string };

/**
 * ffmpeg's program folders: a Homebrew build links libraries of other formulae through `<prefix>/opt/<formula>`
 * (links into `<prefix>/Cellar`) — both are readable, nothing else of the prefix. A self-contained build: its own
 * folder. Refused when that folder is too broad (the root, the home folder, or one holding DATA_DIR).
 */
export function ffmpegOf(
  configured: string | undefined,
  dataDir: string,
): { ok: true; ffmpeg: Ffmpeg } | { ok: false; reason: string } {
  const want = configured ?? DEFAULT_FFMPEG;
  if (!path.isAbsolute(want)) return { ok: false, reason: "AUDIO_FFMPEG must be an absolute path" };
  let exe: string;
  try {
    exe = fs.realpathSync.native(want);
  } catch {
    return { ok: false, reason: `ffmpeg not found (${configured ? "AUDIO_FFMPEG" : DEFAULT_FFMPEG})` };
  }
  const st = fs.statSync(exe);
  if (!st.isFile() || (st.mode & 0o111) === 0) return { ok: false, reason: "ffmpeg is not executable" };
  const cellar = exe.indexOf("/Cellar/");
  const trusted =
    cellar > 0 ? [exe.slice(0, cellar) + "/Cellar", exe.slice(0, cellar) + "/opt"] : [path.dirname(exe)];
  const data = path.resolve(dataDir);
  for (const t of trusted)
    if (t.split(path.sep).filter(Boolean).length < 2 || isInside(data, t) || isInside(os.homedir(), t))
      return { ok: false, reason: "ffmpeg's folder is too broad" };
  return { ok: true, ffmpeg: { exe, trusted: trusted.filter((t) => fs.existsSync(t)) } };
}

type Installed = { lock?: string; manifest?: string; python?: string };

function readManifest(dir: string): Installed | undefined {
  const st = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (!st?.isDirectory() || st.isSymbolicLink()) return undefined;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, MANIFEST), "utf8")) as Installed;
  } catch {
    return undefined;
  }
}

/** What `audio_transcribe` can do on this server now. Fail closed: everything must be in place. */
export function audioState(
  skillPython: string | undefined,
  dataDir: string,
  ffmpegPath?: string,
  platform: NodeJS.Platform = process.platform,
): AudioState {
  if (platform !== "darwin") return { state: "unavailable", reason: "macOS only (sandbox-exec, Metal)" };
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
  const packages = packagesDir(dataDir);
  const p = readManifest(packages);
  if (p?.lock !== lockHash() || p.python !== PYTHON_VERSION)
    return { state: "not_installed", reason: "packages not installed (pnpm audio:install)" };
  const models = modelsDir(dataDir);
  if (readManifest(models)?.manifest !== manifestHash())
    return { state: "not_installed", reason: "models not installed (pnpm audio:install)" };
  return {
    state: "available",
    env: {
      runtime: py.runtime,
      packages,
      models: { stt: path.join(models, "stt"), diarizer: path.join(models, "diarizer") },
      ffmpeg: ff.ffmpeg,
    },
  };
}

/** Every folder and file below `dir` (not following links) set to `dirMode` / `fileMode`. */
export function chmodTree(dir: string, dirMode: number, fileMode: number): void {
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

/** Moves a finished temporary folder into place (read-only), replacing an older copy. */
function publish(tmp: string, dir: string): void {
  chmodTree(tmp, 0o555, 0o444);
  if (fs.existsSync(dir)) {
    chmodTree(dir, 0o755, 0o644);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.renameSync(tmp, dir);
}

function cleanup(tmp: string): void {
  if (!fs.existsSync(tmp)) return;
  try {
    chmodTree(tmp, 0o755, 0o644);
  } catch {
    // removed below as far as possible
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

/** `pnpm audio:install`, packages: the lock with pip (exact versions and hashes, wheels only, nothing else). */
export function installAudioPackages(
  runtime: PythonRuntime,
  dataDir: string,
  o: { log?: (line: string) => void } = {},
): string {
  const v = pythonVersionOf(runtime);
  if (v !== PYTHON_VERSION) throw new Error(`python ${PYTHON_VERSION} required, SKILL_PYTHON is ${v ?? "?"}`);
  const root = storagePaths(dataDir).audioPackages;
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
        "--no-compile",
        "--target",
        tmp,
        "-r",
        AUDIO_LOCK,
      ],
      { stdio: ["ignore", "inherit", "inherit"] },
    );
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`pip exited with ${r.status ?? r.signal}`);
    // Console scripts (mlx_audio.*, hf, tqdm…) are not needed: nothing is started from this folder.
    fs.rmSync(path.join(tmp, "bin"), { recursive: true, force: true });
    fs.writeFileSync(
      path.join(tmp, MANIFEST),
      JSON.stringify({ lock: lockHash(), python: PYTHON_VERSION, installedAt: new Date().toISOString() }),
    );
    publish(tmp, dir);
    o.log?.(`packages installed into ${dir}`);
    return dir;
  } finally {
    cleanup(tmp);
  }
}

/** A Hugging Face file URL at a fixed commit. */
export const modelFileUrl = (repo: string, revision: string, name: string) =>
  `https://huggingface.co/${repo}/resolve/${revision}/${encodeURIComponent(name)}`;

/**
 * `pnpm audio:install`, models: every file of the manifest at its pinned commit, streamed to a temporary folder,
 * its size and SHA-256 checked (a mismatch fails the whole install), then made read-only and moved into place.
 * `fetchImpl` is replaceable in tests (no network there).
 */
export async function installAudioModels(
  dataDir: string,
  o: { log?: (line: string) => void; fetchImpl?: typeof fetch; manifest?: ModelManifest } = {},
): Promise<string> {
  const manifest = o.manifest ?? modelManifest();
  const doFetch = o.fetchImpl ?? fetch;
  const root = storagePaths(dataDir).audioModels;
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = modelsDir(dataDir);
  const tmp = path.join(root, `.tmp-${crypto.randomUUID()}`);
  try {
    for (const m of manifest.models) {
      const into = path.join(tmp, m.key);
      fs.mkdirSync(into, { recursive: true, mode: 0o700 });
      for (const f of m.files) {
        const res = await doFetch(modelFileUrl(m.repo, m.revision, f.name), { redirect: "follow" });
        if (!res.ok || !res.body) throw new Error(`${m.repo}/${f.name}: HTTP ${res.status}`);
        const hash = crypto.createHash("sha256");
        let bytes = 0;
        const count = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            bytes += chunk.length;
            if (bytes > f.bytes) return cb(new Error(`${m.repo}/${f.name}: larger than pinned`));
            hash.update(chunk);
            cb(null, chunk);
          },
        });
        await pipeline(
          Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
          count,
          fs.createWriteStream(path.join(into, f.name), { flags: "wx", mode: 0o600 }),
        );
        if (bytes !== f.bytes || hash.digest("hex") !== f.sha256)
          throw new Error(`${m.repo}/${f.name}: size or SHA-256 differs from models.json`);
        o.log?.(`${m.key}: ${f.name} ok`);
      }
    }
    fs.writeFileSync(
      path.join(tmp, MANIFEST),
      JSON.stringify({ manifest: manifestHash(), installedAt: new Date().toISOString() }),
    );
    publish(tmp, dir);
    o.log?.(`models installed into ${dir}`);
    return dir;
  } finally {
    cleanup(tmp);
  }
}
