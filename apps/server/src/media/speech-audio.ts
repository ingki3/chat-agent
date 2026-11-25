import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FILE_LIMITS, MEDIA_TOOL_LIMITS } from "@agentlee/shared";
import { ffmpegOf, type Ffmpeg } from "../audio/packages.js";
import { walkMp3 } from "./mp3.js";
import { runIsolated, type RunIsolatedOptions, type RunResult } from "../isolation/sandbox.js";
import { removeTree } from "../python/service.js";
import { storagePaths } from "../storage/paths.js";

/**
 * The audio side of a long `speech_generate` (#248): every piece's MP3 is checked and measured, and the pieces are
 * joined into one MP3, by `audio_transcribe`'s ffmpeg (`AUDIO_FFMPEG`, default Homebrew's — `ffmpegOf`, ops §46),
 * each run as its own sandboxed process group (`runIsolated`, #42): no network, no child processes, a fixed
 * environment, a time, memory and output limit; it reads only the call's folders. Without it (not macOS, no ffmpeg)
 * there is no `SpeechAudio`, and no speech is made at all (`media_audio_unavailable`, before anything is paid).
 *
 * **What is taken, and how it is measured (#251 re-plan 3):**
 * 1. the form, over the whole file, in this process (`mp3.ts`): MPEG Layer III with one sample rate and one channel
 *    count, frames to the end — else `unsupported` (another layer, a rate or channel change) or `corrupt` (not a
 *    clean frame stream). Its frames bound the length from above: over the cap (`maxSeconds`) is `too_long`, and
 *    nothing is decoded;
 * 2. the length, exactly: ffmpeg decodes the whole file at its own rate — no resampling, no cut-off before its end —
 *    strictly (`-xerror -err_detect explode`: the first decoding error stops it: `corrupt`), into the null muxer,
 *    and reports how much audio it played (`-progress`: `out_time_us` = samples ÷ rate, exact). Samples are counted
 *    as integers (`round(out_time_us × rate ÷ 10⁶)`). No PCM is stored; the output is a few progress lines;
 * 3. a run that could not be done (no sandbox, a spawn failure, a time or memory limit) is `failed` — never
 *    `corrupt`.
 *
 * The join (`join`): the pieces — all of one form (the caller checks) — each decoded to the same PCM inside one
 * ffmpeg (`aformat` s16 mono at their own rate), concatenated in order (`concat` filter) and encoded once.
 *
 * Working folders: `<DATA_DIR>/speech-scratch/<uuid>/{in,out}`, removed when the call ends (and at server start).
 */
/** A measurement: the decoded length, or why there is none. */
export type Measured =
  | { ok: true; seconds: number; samples: number; sampleRate: number; channels: 1 | 2 }
  | { ok: false; reason: "corrupt" | "unsupported" | "too_long" | "failed" };

export type SpeechAudio = {
  /** A fresh, owner-only working folder with `in/` and `out/` (the caller removes it: `removeSpeechWorkdir`). */
  workdir(): string;
  /**
   * One MP3 of the working folder (`in/` or `out/`): its form checked over the whole file, then decoded to its end;
   * its length from the decoded samples. `maxSeconds`: longer is `too_long`.
   */
  measure(file: string, o: { maxSeconds: number; signal?: AbortSignal | undefined }): Promise<Measured>;
  /**
   * The files (in `in/`, in this order, of one form at `sampleRate`) joined into one MP3 in `out/`: decoded to the
   * same PCM, concatenated, encoded once (`bitrateK`, mono, at that rate). Its path, or undefined when ffmpeg failed.
   */
  join(
    job: { workdir: string; files: string[]; bitrateK: number; sampleRate: number },
    signal?: AbortSignal,
  ): Promise<string | undefined>;
};

export const SPEECH_AUDIO_LIMITS = {
  measureTimeoutMs: MEDIA_TOOL_LIMITS.speechMeasureTimeoutMs,
  joinTimeoutMs: MEDIA_TOOL_LIMITS.speechJoinTimeoutMs,
  memoryBytes: 1024 * 1024 * 1024,
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

/** The ffmpeg run that decodes one file to its end to measure it (exported for the profile tests). */
export function measureOptions(tools: { ffmpeg: Ffmpeg }, file: string): RunIsolatedOptions {
  const dir = path.dirname(file);
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
      // MP3 only — never probed as something else.
      "-f",
      "mp3",
      "-i",
      file,
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      // Decoded at its own rate (no `-ar`), to its end (no `-t`), into nothing: only how much it played is kept.
      "-c:a",
      "pcm_s16le",
      "-stats_period",
      "5",
      "-progress",
      "pipe:1",
      "-f",
      "null",
      "-",
    ],
    cwd: dir,
    env: { HOME: dir, LANG: "en_US.UTF-8" },
    read: [dir],
    write: [],
    trusted: tools.ffmpeg.trusted,
    network: "none",
    noFlagChanges: true,
    timeoutMs: SPEECH_AUDIO_LIMITS.measureTimeoutMs,
    maxRssBytes: SPEECH_AUDIO_LIMITS.memoryBytes,
    maxOutputBytes: 256 * 1024,
  };
}

/** The ffmpeg run that joins the pieces from PCM, encoded once (exported for the profile tests). */
export function joinOptions(
  tools: { ffmpeg: Ffmpeg },
  job: { workdir: string; files: string[]; bitrateK: number; sampleRate: number; out: string },
): RunIsolatedOptions {
  const inDir = path.join(job.workdir, "in");
  const outDir = path.join(job.workdir, "out");
  const names = job.files.map((f) => path.basename(f));
  // Every piece decoded to the same PCM (s16, mono, the pieces' one rate), then concatenated in order.
  const pcm = names.map(
    (_, i) => `[${i}:a:0]aformat=sample_fmts=s16:channel_layouts=mono:sample_rates=${job.sampleRate}[p${i}]`,
  );
  return {
    command: tools.ffmpeg.exe,
    args: [
      "-nostdin",
      "-hide_banner",
      "-v",
      "error",
      "-xerror",
      ...names.flatMap((n) => ["-f", "mp3", "-i", path.join(inDir, n)]),
      "-filter_complex",
      `${pcm.join(";")};${names.map((_, i) => `[p${i}]`).join("")}concat=n=${names.length}:v=0:a=1[a]`,
      "-map",
      "[a]",
      "-c:a",
      "libmp3lame",
      "-b:a",
      `${job.bitrateK}k`,
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

/** The last `out_time_us` of ffmpeg's progress report, when it ended (`progress=end`); undefined otherwise. */
export function progressMicros(stdout: string): number | undefined {
  if (!/^progress=end$/mu.test(stdout)) return undefined;
  const all = [...stdout.matchAll(/^out_time_us=(\d+)$/gmu)];
  const last = all.at(-1);
  return last ? Number(last[1]) : undefined;
}

/**
 * A finished measuring run that did not succeed, classified: the sandbox or the program not starting (sandbox-exec
 * refusing, exit 71/126/127), or the file not opening, is `failed` (nothing was learnt about the audio); any other
 * error — the strict decoder stopping — is `corrupt`.
 */
export function measureFailure(r: { code: number | null; stderr: string }): "failed" | "corrupt" {
  if (r.code === 71 || r.code === 126 || r.code === 127) return "failed";
  if (/sandbox|Operation not permitted|Permission denied|No such file|exec/iu.test(r.stderr)) return "failed";
  return "corrupt";
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
    async measure(file, m) {
      if (plainSize(file) === undefined) return { ok: false, reason: "failed" };
      // 1. The form, over the whole file (nothing decoded yet).
      const walk = walkMp3(fs.readFileSync(file));
      if (!walk.ok) return { ok: false, reason: walk.reason === "unsupported" ? "unsupported" : "corrupt" };
      // Its frames are the most it can play: over the cap, it is not decoded at all.
      if (walk.samples > m.maxSeconds * walk.sampleRate) return { ok: false, reason: "too_long" };
      // 2. Decoded to its end, strictly, at its own rate.
      const r = await attempt(measureOptions(tools, file), m.signal);
      if (!r || r.killed) return { ok: false, reason: "failed" };
      if (r.code !== 0) return { ok: false, reason: measureFailure(r) };
      if (r.stderr.trim()) return { ok: false, reason: "corrupt" };
      const us = progressMicros(r.stdout);
      if (us === undefined) return { ok: false, reason: "failed" };
      const samples = Math.round((us * walk.sampleRate) / 1_000_000);
      // Decoding never plays more than the frames hold.
      if (samples > walk.samples) return { ok: false, reason: "corrupt" };
      if (samples > m.maxSeconds * walk.sampleRate) return { ok: false, reason: "too_long" };
      return {
        ok: true,
        samples,
        seconds: samples / walk.sampleRate,
        sampleRate: walk.sampleRate,
        channels: walk.channels,
      };
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
