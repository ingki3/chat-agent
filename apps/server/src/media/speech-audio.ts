import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FILE_LIMITS, MEDIA_TOOL_LIMITS } from "@agentlee/shared";
import { ffmpegOf, type Ffmpeg } from "../audio/packages.js";
import { runIsolated, type RunIsolatedOptions, type RunResult } from "../isolation/sandbox.js";
import { removeTree } from "../python/service.js";
import { storagePaths } from "../storage/paths.js";

/**
 * The audio side of a long `speech_generate` (#248): every piece's MP3 is measured and the pieces are joined into one
 * MP3, both by `audio_transcribe`'s ffmpeg (`AUDIO_FFMPEG`, default Homebrew's — `ffmpegOf`, ops §46), each run as its
 * own sandboxed process group (`runIsolated`, #42): no network, no child processes, a fixed environment, a time,
 * memory and output limit; it reads only the folder of its input and writes only the call's `out/`. Without it (not
 * macOS, no ffmpeg) there is no `SpeechAudio`, and no speech is made at all — every piece must be measured
 * (`media_audio_unavailable`, before anything is paid).
 *
 * **Measuring is decoding (#251 re-plan 2):** a file is decoded to its end, strictly (`-xerror`, `-err_detect
 * explode`: the first decoding error stops it), into 1 kHz mono 8-bit PCM — one byte per millisecond of audio,
 * whatever its rate (also when the rate changes inside the file) — and its length is the output's size. No header,
 * container `duration` or packet count is used. A decoding error is `corrupt` (the caller stores nothing). The
 * encoder's delay and padding (≈ 0.1–0.2 s) are in the count where the file does not say how to trim them.
 *
 * Working folders: `<DATA_DIR>/speech-scratch/<uuid>/{in,out}`, removed when the call ends (and at server start).
 */
/** A measurement: the decoded length, or why there is none — `corrupt` (a decoding error) or it could not run. */
export type Measured = { ok: true; seconds: number } | { ok: false; corrupt: boolean };

export type SpeechAudio = {
  /** A fresh, owner-only working folder with `in/` and `out/` (the caller removes it: `removeSpeechWorkdir`). */
  workdir(): string;
  /** One MP3 of the working folder (`in/` or `out/`) decoded to its end; its length from the decoded samples. */
  measure(file: string, signal?: AbortSignal): Promise<Measured>;
  /**
   * The files (in `in/`, in this order) joined into one MP3 in `out/`, always re-encoded (`bitrateK`, mono, 44.1 kHz
   * — a piece's own stream may even change inside it). Its path, or undefined when ffmpeg failed.
   */
  join(
    job: { workdir: string; files: string[]; bitrateK: number },
    signal?: AbortSignal,
  ): Promise<string | undefined>;
};

export const SPEECH_AUDIO_LIMITS = {
  measureTimeoutMs: MEDIA_TOOL_LIMITS.speechMeasureTimeoutMs,
  joinTimeoutMs: MEDIA_TOOL_LIMITS.speechJoinTimeoutMs,
  memoryBytes: 1024 * 1024 * 1024,
  /** The measuring output's rate: one byte (u8 sample) per millisecond. */
  measureRate: 1000,
  /** The longest audio a measurement decodes (4 h — more than any 50MB MP3 a call can store): 14.4MB of PCM. */
  measureMaxSeconds: 4 * 3600,
} as const;

/**
 * The `speech-scratch` folder, checked: a real folder (not a link) whose resolved path is exactly
 * `<resolved DATA_DIR>/speech-scratch`. `missing` when it does not exist; `bad` for anything else (a link, a file,
 * a folder that resolves elsewhere, an error reading it) — nothing below such a root is touched.
 */
function scratchRoot(dataDir: string): { ok: string } | "missing" | "bad" {
  const root = storagePaths(dataDir).speechScratch;
  let st: fs.Stats | undefined;
  try {
    st = fs.lstatSync(root, { throwIfNoEntry: false });
  } catch {
    return "bad";
  }
  if (!st) return "missing";
  if (st.isSymbolicLink() || !st.isDirectory()) return "bad";
  try {
    const real = fs.realpathSync.native(root);
    const want = path.join(fs.realpathSync.native(dataDir), path.basename(root));
    return real === want ? { ok: real } : "bad";
  } catch {
    return "bad";
  }
}

const WORKDIR_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `speech-scratch/<uuid>` under the data folder (resolved, never a link), with `in/` and `out/`. */
export function makeSpeechWorkdir(dataDir: string): string {
  let root = scratchRoot(dataDir);
  if (root === "missing") {
    fs.mkdirSync(storagePaths(dataDir).speechScratch, { recursive: true, mode: 0o700 });
    root = scratchRoot(dataDir);
  }
  if (typeof root === "string") throw new Error("speech-scratch is not a folder of DATA_DIR");
  const dir = path.join(root.ok, crypto.randomUUID());
  fs.mkdirSync(dir, { mode: 0o700 });
  const real = fs.realpathSync.native(dir);
  if (real !== dir) throw new Error("speech working folder moved");
  fs.mkdirSync(path.join(real, "in"), { mode: 0o700 });
  fs.mkdirSync(path.join(real, "out"), { mode: 0o700 });
  return real;
}

export const removeSpeechWorkdir = (dir: string): boolean => removeTree(dir);

/**
 * Removes the working folders an earlier process left (server start). Only below a checked root
 * (`scratchRoot`): a missing root is nothing to do (true); a root that is a link, resolves outside DATA_DIR or
 * cannot be read is left alone (false — logged `media.sweep_failed`). Below it, only working folders
 * (`<uuid>`, real folders) are removed whole; any other entry — a link included — is only unlinked itself, never
 * followed. Never throws.
 */
export function sweepSpeechScratch(dataDir: string): boolean {
  const root = scratchRoot(dataDir);
  if (root === "missing") return true;
  if (root === "bad") return false;
  let names: string[];
  try {
    names = fs.readdirSync(root.ok);
  } catch {
    return false;
  }
  let ok = true;
  for (const n of names) {
    const p = path.join(root.ok, n);
    try {
      const st = fs.lstatSync(p);
      if (st.isDirectory() && !st.isSymbolicLink() && WORKDIR_NAME.test(n)) {
        if (!removeTree(p)) ok = false;
      } else if (st.isDirectory() && !st.isSymbolicLink()) {
        // Not one of ours: left for the operator.
        ok = false;
      } else fs.unlinkSync(p);
    } catch {
      ok = false;
    }
  }
  return ok;
}

/** ffmpeg as `audio_transcribe` finds it (macOS only — the sandbox); undefined without it. */
export function speechTools(
  configured: string | undefined,
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): { ffmpeg: Ffmpeg } | undefined {
  // The sandbox is macOS only (runIsolated fails closed elsewhere).
  if (platform !== "darwin") return undefined;
  const ff = ffmpegOf(configured, dataDir);
  return ff.ok ? { ffmpeg: ff.ffmpeg } : undefined;
}

const PIECE = /^piece-\d{3}\.mp3$/;

/** The ffmpeg run that decodes one file to measure it (exported for the profile tests). */
export function measureOptions(tools: { ffmpeg: Ffmpeg }, file: string, out: string): RunIsolatedOptions {
  const dir = path.dirname(file);
  const outDir = path.dirname(out);
  const L = SPEECH_AUDIO_LIMITS;
  return {
    command: tools.ffmpeg.exe,
    args: [
      "-nostdin",
      "-hide_banner",
      "-v",
      "error",
      // The first decoding error stops the run (exit ≠ 0, a line on stderr): the file is corrupt.
      "-xerror",
      "-err_detect",
      "explode",
      "-i",
      file,
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-ac",
      "1",
      "-ar",
      String(L.measureRate),
      "-c:a",
      "pcm_u8",
      "-t",
      String(L.measureMaxSeconds),
      "-f",
      "u8",
      out,
    ],
    cwd: outDir,
    env: { HOME: outDir, LANG: "en_US.UTF-8" },
    read: dir === outDir ? [] : [dir],
    write: [outDir],
    trusted: tools.ffmpeg.trusted,
    network: "none",
    noFlagChanges: true,
    timeoutMs: L.measureTimeoutMs,
    maxRssBytes: L.memoryBytes,
    maxOutputBytes: 64 * 1024,
  };
}

/** The ffmpeg run that joins the pieces, re-encoded (exported for the profile tests). */
export function joinOptions(
  tools: { ffmpeg: Ffmpeg },
  job: { workdir: string; files: string[]; bitrateK: number; out: string },
): RunIsolatedOptions {
  const inDir = path.join(job.workdir, "in");
  const outDir = path.join(job.workdir, "out");
  const names = job.files.map((f) => path.basename(f));
  return {
    command: tools.ffmpeg.exe,
    args: [
      "-nostdin",
      "-hide_banner",
      "-v",
      "error",
      "-xerror",
      ...names.flatMap((n) => ["-i", path.join(inDir, n)]),
      "-filter_complex",
      `${names.map((_, i) => `[${i}:a:0]`).join("")}concat=n=${names.length}:v=0:a=1[a]`,
      "-map",
      "[a]",
      "-c:a",
      "libmp3lame",
      "-b:a",
      `${job.bitrateK}k`,
      "-ar",
      "44100",
      "-ac",
      "1",
      "-map_metadata",
      "-1",
      // The 50MB file cap as ffmpeg's own output limit (a bigger result is refused by the caller).
      "-fs",
      String(FILE_LIMITS.bytes + 1),
      "-f",
      "mp3",
      job.out,
    ],
    cwd: outDir,
    env: { HOME: outDir, LANG: "en_US.UTF-8" },
    read: [inDir],
    write: [outDir],
    trusted: tools.ffmpeg.trusted,
    network: "none",
    noFlagChanges: true,
    timeoutMs: SPEECH_AUDIO_LIMITS.joinTimeoutMs,
    maxRssBytes: SPEECH_AUDIO_LIMITS.memoryBytes,
    maxOutputBytes: 256 * 1024,
  };
}

/** A regular file with one name (not a link): its size, or undefined. */
function plainSize(file: string): number | undefined {
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  return st?.isFile() && st.nlink === 1 ? st.size : undefined;
}

/** The `SpeechAudio` the app uses: the sandboxed ffmpeg (undefined without it). */
export function sandboxedSpeechAudio(o: {
  dataDir: string;
  ffmpegPath?: string | undefined;
  platform?: NodeJS.Platform;
  run?: typeof runIsolated;
}): SpeechAudio | undefined {
  const tools = speechTools(o.ffmpegPath, o.dataDir, o.platform);
  if (!tools) return undefined;
  const run = o.run ?? runIsolated;
  const attempt = async (opts: RunIsolatedOptions, signal?: AbortSignal): Promise<RunResult | undefined> => {
    try {
      return await run({ ...opts, ...(signal ? { signal } : {}) });
    } catch {
      // No sandbox, a hard link in an allowed folder, a spawn failure: nothing ran.
      return undefined;
    }
  };
  let n = 0;
  return {
    workdir: () => makeSpeechWorkdir(o.dataDir),
    async measure(file, signal) {
      const dir = path.dirname(path.dirname(file));
      if (plainSize(file) === undefined) return { ok: false, corrupt: false };
      const out = path.join(dir, "out", `measure-${++n}.u8`);
      try {
        const r = await attempt(measureOptions(tools, file, out), signal);
        // Not run, or stopped by a limit or the caller: no verdict about the file.
        if (!r || r.killed) return { ok: false, corrupt: false };
        // A decoding error (or anything the strict decoder had to say): corrupt.
        if (r.code !== 0 || r.stderr.trim()) return { ok: false, corrupt: true };
        const size = plainSize(out);
        if (size === undefined) return { ok: false, corrupt: true };
        return { ok: true, seconds: size / SPEECH_AUDIO_LIMITS.measureRate };
      } finally {
        fs.rmSync(out, { force: true });
      }
    },
    async join(job, signal) {
      const inDir = path.join(job.workdir, "in");
      if (!job.files.length) return undefined;
      for (const f of job.files)
        if (path.dirname(f) !== inDir || !PIECE.test(path.basename(f)) || plainSize(f) === undefined)
          return undefined;
      const out = path.join(job.workdir, "out", `speech-${++n}.mp3`);
      const r = await attempt(joinOptions(tools, { ...job, out }), signal);
      if (!r || r.killed || r.code !== 0) return undefined;
      return plainSize(out) === undefined ? undefined : out;
    },
  };
}
