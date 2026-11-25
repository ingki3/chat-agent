import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { FILE_LIMITS } from "@agentlee/shared";
import { ffmpegOf, type Ffmpeg } from "../audio/packages.js";
import { runIsolated, type RunIsolatedOptions, type RunResult } from "../isolation/sandbox.js";
import { removeTree } from "../python/service.js";
import { storagePaths } from "../storage/paths.js";

/**
 * The audio side of a long `speech_generate` (#248): every piece's MP3 is measured (ffprobe) and the pieces are
 * joined into one MP3 (ffmpeg). The programs are `audio_transcribe`'s ffmpeg (`AUDIO_FFMPEG`, default Homebrew's —
 * `ffmpegOf`, ops §46) and the ffprobe beside it, each run as its own sandboxed process group (`runIsolated`, #42):
 * no network, no child processes, a fixed environment, a time, memory and output limit; it reads only the call's
 * `in/` folder and writes only its `out/`. Without them (not macOS, no ffmpeg/ffprobe) there is no `SpeechAudio`:
 * a text that fits one piece is made as before (unmeasured), a longer one is refused before anything is paid.
 *
 * Working folders: `<DATA_DIR>/speech-scratch/<uuid>/{in,out}`, removed when the call ends (and at server start).
 */
export type Mp3Info = { seconds: number; codec: string; sampleRate: number; channels: number };
export type Reencode = { bitrateK: number; sampleRate: number; channels: number };

export type SpeechAudio = {
  /** A fresh, owner-only working folder with `in/` and `out/` (the caller removes it: `removeSpeechWorkdir`). */
  workdir(): string;
  /** The length and stream of one MP3 in the folder (`in/` or `out/`); undefined when it does not read as audio. */
  probe(file: string, signal?: AbortSignal): Promise<Mp3Info | undefined>;
  /**
   * The files (in `in/`, in this order) joined into one MP3 in `out/`: stream copy (same codec, rate and channels
   * throughout), or re-encoded. Its path, or undefined when ffmpeg failed.
   */
  join(
    job: { workdir: string; files: string[]; reencode?: Reencode | undefined },
    signal?: AbortSignal,
  ): Promise<string | undefined>;
};

export const SPEECH_AUDIO_LIMITS = {
  probeTimeoutMs: 20_000,
  joinTimeoutMs: 180_000,
  memoryBytes: 1024 * 1024 * 1024,
} as const;

/** `speech-scratch/<uuid>` under the data folder (resolved, never a link), with `in/` and `out/`. */
export function makeSpeechWorkdir(dataDir: string): string {
  const root = storagePaths(dataDir).speechScratch;
  let st = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!st) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    st = fs.lstatSync(root);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("speech-scratch is not a folder");
  const dir = path.join(root, crypto.randomUUID());
  fs.mkdirSync(dir, { mode: 0o700 });
  const real = fs.realpathSync.native(dir);
  fs.mkdirSync(path.join(real, "in"), { mode: 0o700 });
  fs.mkdirSync(path.join(real, "out"), { mode: 0o700 });
  return real;
}

export const removeSpeechWorkdir = (dir: string): boolean => removeTree(dir);

/** Removes the working folders an earlier process left (server start). Never throws. */
export function sweepSpeechScratch(dataDir: string): boolean {
  const root = storagePaths(dataDir).speechScratch;
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return true;
  }
  let ok = true;
  for (const n of names) if (!removeTree(path.join(root, n))) ok = false;
  return ok;
}

/** ffmpeg (as `audio_transcribe` finds it) and the ffprobe in the same folder; undefined when either is missing. */
export function speechTools(
  configured: string | undefined,
  dataDir: string,
  platform: NodeJS.Platform = process.platform,
): { ffmpeg: Ffmpeg; ffprobe: string } | undefined {
  // The sandbox is macOS only (runIsolated fails closed elsewhere).
  if (platform !== "darwin") return undefined;
  const ff = ffmpegOf(configured, dataDir);
  if (!ff.ok) return undefined;
  let probe: string;
  try {
    probe = fs.realpathSync.native(path.join(path.dirname(ff.ffmpeg.exe), "ffprobe"));
  } catch {
    return undefined;
  }
  const st = fs.statSync(probe, { throwIfNoEntry: false });
  if (!st?.isFile() || (st.mode & 0o111) === 0) return undefined;
  // It must load its libraries from the same read-only program folders.
  if (!ff.ffmpeg.trusted.some((t) => probe.startsWith(t + path.sep))) return undefined;
  return { ffmpeg: ff.ffmpeg, ffprobe: probe };
}

const Probe = z.object({
  streams: z
    .array(
      z.object({
        codec_name: z.string().max(40),
        sample_rate: z.coerce.number().int().positive(),
        channels: z.number().int().min(1).max(8),
      }),
    )
    .min(1),
  format: z.object({ duration: z.coerce.number().positive().finite() }),
});

const PIECE = /^piece-\d{3}\.mp3$/;

/** The ffprobe run of one file (exported for the profile tests). */
export function probeOptions(tools: { ffmpeg: Ffmpeg; ffprobe: string }, file: string): RunIsolatedOptions {
  const dir = path.dirname(file);
  return {
    command: tools.ffprobe,
    args: [
      "-v",
      "error",
      "-hide_banner",
      "-select_streams",
      "a:0",
      "-show_entries",
      "format=duration:stream=codec_name,sample_rate,channels",
      "-of",
      "json",
      file,
    ],
    cwd: dir,
    env: { HOME: dir, LANG: "en_US.UTF-8" },
    read: [dir],
    write: [],
    trusted: tools.ffmpeg.trusted,
    network: "none",
    noFlagChanges: true,
    timeoutMs: SPEECH_AUDIO_LIMITS.probeTimeoutMs,
    maxRssBytes: SPEECH_AUDIO_LIMITS.memoryBytes,
    maxOutputBytes: 64 * 1024,
  };
}

/** The ffmpeg run that joins the pieces (exported for the profile tests). */
export function joinOptions(
  tools: { ffmpeg: Ffmpeg },
  job: { workdir: string; files: string[]; reencode?: Reencode | undefined; out: string },
): RunIsolatedOptions {
  const inDir = path.join(job.workdir, "in");
  const outDir = path.join(job.workdir, "out");
  const names = job.files.map((f) => path.basename(f));
  const head = ["-nostdin", "-hide_banner", "-loglevel", "error"];
  // The 50MB file cap as ffmpeg's own output limit (a bigger result is refused by the caller).
  const tail = ["-map_metadata", "-1", "-fs", String(FILE_LIMITS.bytes + 1), "-f", "mp3", job.out];
  const args = job.reencode
    ? [
        ...head,
        ...names.flatMap((n) => ["-i", path.join(inDir, n)]),
        "-filter_complex",
        `${names.map((_, i) => `[${i}:a:0]`).join("")}concat=n=${names.length}:v=0:a=1[a]`,
        "-map",
        "[a]",
        "-c:a",
        "libmp3lame",
        "-b:a",
        `${job.reencode.bitrateK}k`,
        "-ar",
        String(job.reencode.sampleRate),
        "-ac",
        String(job.reencode.channels),
        ...tail,
      ]
    : [
        ...head,
        // The concat demuxer with its safe mode on: the list names plain relative files of `in/` only.
        "-f",
        "concat",
        "-safe",
        "1",
        "-i",
        path.join(inDir, "list.txt"),
        "-map",
        "0:a:0",
        "-c:a",
        "copy",
        ...tail,
      ];
  return {
    command: tools.ffmpeg.exe,
    args,
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

/** The `SpeechAudio` the app uses: the sandboxed ffprobe and ffmpeg (undefined without them). */
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
  let joins = 0;
  return {
    workdir: () => makeSpeechWorkdir(o.dataDir),
    async probe(file, signal) {
      if (plainSize(file) === undefined) return undefined;
      const r = await attempt(probeOptions(tools, file), signal);
      if (!r || r.killed || r.code !== 0) return undefined;
      try {
        const p = Probe.safeParse(JSON.parse(r.stdout));
        if (!p.success) return undefined;
        const s = p.data.streams[0]!;
        return {
          seconds: p.data.format.duration,
          codec: s.codec_name,
          sampleRate: s.sample_rate,
          channels: s.channels,
        };
      } catch {
        return undefined;
      }
    },
    async join(job, signal) {
      const inDir = path.join(job.workdir, "in");
      if (!job.files.length) return undefined;
      for (const f of job.files)
        if (path.dirname(f) !== inDir || !PIECE.test(path.basename(f)) || plainSize(f) === undefined)
          return undefined;
      if (!job.reencode)
        fs.writeFileSync(
          path.join(inDir, "list.txt"),
          job.files.map((f) => `file '${path.basename(f)}'\n`).join(""),
          { mode: 0o600 },
        );
      const out = path.join(job.workdir, "out", `speech-${++joins}.mp3`);
      const r = await attempt(joinOptions(tools, { ...job, out }), signal);
      if (!r || r.killed || r.code !== 0) return undefined;
      return plainSize(out) === undefined ? undefined : out;
    },
  };
}
