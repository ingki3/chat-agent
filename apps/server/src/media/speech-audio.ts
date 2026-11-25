import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { FILE_LIMITS, MEDIA_TOOL_LIMITS } from "@agentlee/shared";
import { ffmpegOf, type Ffmpeg } from "../audio/packages.js";
import { runIsolated, type RunIsolatedOptions, type RunResult } from "../isolation/sandbox.js";
import { removeTree } from "../python/service.js";
import { storagePaths } from "../storage/paths.js";

/**
 * The audio side of a long `speech_generate` (#248): every piece's MP3 is checked and measured, and the pieces are
 * joined into one MP3, by `audio_transcribe`'s ffmpeg (`AUDIO_FFMPEG`, default Homebrew's — `ffmpegOf`, ops §46) and
 * the ffprobe beside it, each run as its own sandboxed process group (`runIsolated`, #42): no network, no child
 * processes, a fixed environment, a time, memory and output limit; it reads only the call's folders. Without them
 * (not macOS, no ffmpeg/ffprobe) there is no `SpeechAudio`, and no speech is made at all (`media_audio_unavailable`,
 * before anything is paid).
 *
 * **How an answer is judged (#251 re-plan 4 — nothing of our own interprets audio bytes or log text):**
 * 1. integrity, from the strict decoder's **exit status only**: ffmpeg decodes the whole file (`-xerror -err_detect
 *    explode`, into the null muxer). Exit 0: clean. A run that did not really run — the runner failing to start it,
 *    a kill or time/memory/output limit, a signal, or an exit status that means one (sandbox-exec 71, 126, 127,
 *    ENOMEM 244, ffmpeg's own "received a signal" 255) — is `failed`; any other exit status is `corrupt`. Its log is
 *    never read;
 * 2. form and length, from what the decoder reports per frame: ffprobe decodes the file again and lists, as JSON,
 *    every stream (type, codec, attached-picture flag) and every decoded audio frame (channels, `nb_samples`, and its
 *    duration in the stream's time base — the frame's own rate is `nb_samples ÷ duration`). Taken: exactly one audio
 *    stream, codec `mp3`, no other stream but attached pictures, every frame at one rate and one channel count.
 *    Anything else is `unsupported`. The length is the integer sum of `nb_samples` — decoded samples, with the
 *    encoder's delay and padding already taken off by the decoder (as ffmpeg plays it). Over `maxSeconds` is
 *    `too_long`. The report is bounded (`probeOutputBytes`); one that does not read as that structure is `failed`.
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

/** ffmpeg as `audio_transcribe` finds it and the ffprobe beside it (macOS only — the sandbox); undefined without. */
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

const PIECE = /^piece-\d{3}\.mp3$/;

/** The strict ffmpeg decode of one whole file — its exit status is the integrity verdict (exported for tests). */
export function decodeOptions(tools: { ffmpeg: Ffmpeg }, file: string): RunIsolatedOptions {
  const dir = path.dirname(file);
  return {
    command: tools.ffmpeg.exe,
    args: [
      "-nostdin",
      "-hide_banner",
      "-nostats",
      "-v",
      "error",
      // The first decoding error stops the run with a non-zero exit status.
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

/** The bound of ffprobe's report for `maxSeconds` of audio: 50 frames a second at 100 bytes each, and some room. */
export const probeOutputBytes = (maxSeconds: number): number => Math.ceil(maxSeconds * 50 * 100) + 256 * 1024;

/** The ffprobe run that reports the streams and every decoded audio frame (exported for tests). */
export function probeOptions(
  tools: { ffmpeg: Ffmpeg; ffprobe: string },
  file: string,
  maxSeconds: number,
): RunIsolatedOptions {
  const dir = path.dirname(file);
  return {
    command: tools.ffprobe,
    args: [
      "-v",
      "error",
      "-hide_banner",
      "-show_entries",
      "stream=index,codec_type,codec_name,sample_rate,time_base:stream_disposition=attached_pic:frame=stream_index,channels,nb_samples,duration",
      "-of",
      "json=c=1",
      file,
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
    maxOutputBytes: probeOutputBytes(maxSeconds),
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

/**
 * The integrity verdict of a finished strict decode, from its exit status and the runner's own report only (never
 * its log): clean (`ok`); `failed` when it did not really run — not started, killed by a limit or the caller, a
 * signal, or an exit status that means one of those (sandbox-exec 71, 126 cannot execute, 127 not found, 244 ENOMEM,
 * 255 ffmpeg's "received a signal"); `corrupt` for any other non-zero status (the decoder stopped on the audio).
 */
export function decodeVerdict(
  r: { code: number | null; signal?: NodeJS.Signals | null; killed?: unknown } | undefined,
): "ok" | "failed" | "corrupt" {
  if (!r || r.killed || r.signal || r.code === null) return "failed";
  if (r.code === 0) return "ok";
  if ([71, 126, 127, 244, 255].includes(r.code)) return "failed";
  return "corrupt";
}

const Probe = z.object({
  streams: z
    .array(
      z.object({
        index: z.number().int().min(0),
        codec_type: z.string().max(40).optional(),
        codec_name: z.string().max(40).optional(),
        sample_rate: z.coerce.number().int().positive().optional(),
        time_base: z
          .string()
          .regex(/^\d{1,12}\/\d{1,12}$/)
          .optional(),
        disposition: z.object({ attached_pic: z.number().int() }).partial().optional(),
      }),
    )
    .max(16),
  frames: z
    .array(
      z.object({
        stream_index: z.number().int().min(0),
        channels: z.number().int().min(0).max(8).optional(),
        nb_samples: z.number().int().min(0).optional(),
        duration: z.number().int().min(0).optional(),
      }),
    )
    .optional(),
});

/**
 * ffprobe's report judged (exported for tests): the one form taken — one audio stream, `mp3`, nothing else but
 * attached pictures, every decoded frame at the stream's rate (`nb_samples ÷ duration` in its time base) and at
 * one channel count — and its decoded samples summed. `failed` when the report is not that structure.
 */
export function judgeProbe(
  stdout: string,
):
  | { ok: true; samples: number; sampleRate: number; channels: 1 | 2 }
  | { ok: false; reason: "unsupported" | "failed" } {
  let parsed: z.infer<typeof Probe>;
  try {
    const p = Probe.safeParse(JSON.parse(stdout));
    if (!p.success) return { ok: false, reason: "failed" };
    parsed = p.data;
  } catch {
    return { ok: false, reason: "failed" };
  }
  const audio = parsed.streams.filter((st) => st.codec_type === "audio");
  const others = parsed.streams.filter(
    (st) => st.codec_type !== "audio" && !(st.codec_type === "video" && st.disposition?.attached_pic === 1),
  );
  if (audio.length !== 1 || others.length) return { ok: false, reason: "unsupported" };
  const a = audio[0]!;
  if (a.codec_name !== "mp3") return { ok: false, reason: "unsupported" };
  if (!a.sample_rate || !a.time_base) return { ok: false, reason: "failed" };
  const [num, den] = a.time_base.split("/").map(Number) as [number, number];
  if (!num || !den) return { ok: false, reason: "failed" };
  const frames = (parsed.frames ?? []).filter((f) => f.stream_index === a.index);
  let samples = 0;
  let channels: number | undefined;
  for (const f of frames) {
    if (f.nb_samples === undefined || f.channels === undefined || f.duration === undefined)
      return { ok: false, reason: "failed" };
    if (f.nb_samples === 0) continue;
    // The frame's own rate, exactly: nb_samples = rate × duration × num ÷ den.
    if (f.nb_samples * den !== a.sample_rate * f.duration * num) return { ok: false, reason: "unsupported" };
    if (channels === undefined) channels = f.channels;
    else if (channels !== f.channels) return { ok: false, reason: "unsupported" };
    samples += f.nb_samples;
  }
  if (channels !== 1 && channels !== 2) return { ok: false, reason: samples ? "unsupported" : "failed" };
  return { ok: true, samples, sampleRate: a.sample_rate, channels };
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
      // 1. Integrity: the strict decode's exit status.
      const verdict = decodeVerdict(await attempt(decodeOptions(tools, file), m.signal));
      if (verdict !== "ok") return { ok: false, reason: verdict };
      // 2. Form and length: what the decoder reports for every frame.
      const r = await attempt(probeOptions(tools, file, m.maxSeconds), m.signal);
      if (decodeVerdict(r) !== "ok") return { ok: false, reason: "failed" };
      const j = judgeProbe(r!.stdout);
      if (!j.ok) return j;
      // The cap, on the decoded samples.
      if (j.samples > m.maxSeconds * j.sampleRate) return { ok: false, reason: "too_long" };
      return {
        ok: true,
        samples: j.samples,
        seconds: j.samples / j.sampleRate,
        sampleRate: j.sampleRate,
        channels: j.channels,
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
