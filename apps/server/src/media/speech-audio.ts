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
 * The audio side of a long `speech_generate` (#248): every answer is checked, decoded and measured, and the stored
 * MP3 is always one this server encodes. The programs are `audio_transcribe`'s ffmpeg (`AUDIO_FFMPEG`, default
 * Homebrew's — `ffmpegOf`, ops §46) and the ffprobe beside it, each run as its own sandboxed process group
 * (`runIsolated`, #42): no network, no child processes, a fixed environment, a time, memory and output limit; it
 * reads only the call's folders and writes only its `out/`. Without them (not macOS, no ffmpeg/ffprobe) there is no
 * `SpeechAudio`, and no speech is made at all (`media_audio_unavailable`, before anything is paid).
 *
 * **How an answer is taken (#251 re-plan 5 — the provider's bytes are never stored):**
 * 1. the gate, from ffprobe's stream and container fields only (stable across versions): container `mp3`, exactly
 *    one audio stream, codec `mp3`, no other stream but attached pictures — else `unsupported` (another container
 *    such as WAV/MP4 even around MP3, another codec, no audio at all such as a PNG, a file ffprobe cannot read);
 * 2. the decode: ffmpeg decodes the whole file strictly (`-xerror -err_detect explode`) to mono s16 PCM at one
 *    rate — the call's (its first answer's stream rate), so a rate that changes inside an answer, or between
 *    answers, is converted, not judged — into `out/`. Integrity is its **exit status only** (`decodeVerdict`: a run
 *    that did not really run is `failed`, any other non-zero status `corrupt`); the length is the PCM's size: whole
 *    samples. Over `maxSeconds` is `too_long` (ffmpeg's own `-fs` bounds the file);
 * 3. the stored file: the call's PCM (one piece, or the pieces in order) encoded once by ffmpeg (`encode`) — and
 *    measured again the same way before it is stored.
 *
 * Working folders: `<DATA_DIR>/speech-scratch/<uuid>/{in,out}`, removed when the call ends (and at server start).
 */
/** A measurement: the decoded PCM (`pcm`, in `out/`) and its length, or why there is none. */
export type Measured =
  | { ok: true; seconds: number; samples: number; sampleRate: number; pcm: string }
  | { ok: false; reason: "corrupt" | "unsupported" | "too_long" | "failed" };

export type SpeechAudio = {
  /** A fresh, owner-only working folder with `in/` and `out/` (the caller removes it: `removeSpeechWorkdir`). */
  workdir(): string;
  /**
   * One MP3 of the working folder: gated, then decoded to its end into mono s16 PCM at `sampleRate` (default: its
   * own stream's) in `out/`; its length from that PCM. `maxSeconds`: longer is `too_long`.
   */
  measure(
    file: string,
    o: { maxSeconds: number; sampleRate?: number | undefined; signal?: AbortSignal | undefined },
  ): Promise<Measured>;
  /** PCM files (`out/`, in this order, mono s16 at `sampleRate`) encoded once into one MP3 in `out/`; its path. */
  encode(
    job: { workdir: string; pcms: string[]; bitrateK: number; sampleRate: number },
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

/** ffprobe's gate: the container and the streams, as JSON (exported for tests). */
export function gateOptions(tools: { ffmpeg: Ffmpeg; ffprobe: string }, file: string): RunIsolatedOptions {
  const dir = path.dirname(file);
  return {
    command: tools.ffprobe,
    args: [
      "-v",
      "error",
      "-hide_banner",
      "-show_entries",
      "format=format_name:stream=codec_type,codec_name,sample_rate,channels:stream_disposition=attached_pic",
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
    timeoutMs: SPEECH_AUDIO_LIMITS.measureTimeoutMs,
    maxRssBytes: SPEECH_AUDIO_LIMITS.memoryBytes,
    maxOutputBytes: 64 * 1024,
  };
}

/** The strict decode of one whole file into mono s16 PCM at `sampleRate` (exported for tests). */
export function decodeOptions(
  tools: { ffmpeg: Ffmpeg },
  job: { file: string; pcm: string; sampleRate: number; maxSeconds: number },
): RunIsolatedOptions {
  const dir = path.dirname(job.file);
  const outDir = path.dirname(job.pcm);
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
      "-f",
      "mp3",
      "-i",
      job.file,
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-ac",
      "1",
      "-ar",
      String(job.sampleRate),
      "-c:a",
      "pcm_s16le",
      // A little over the cap: a longer answer is seen as longer, never written without bound.
      "-fs",
      String(Math.ceil((job.maxSeconds + 1) * job.sampleRate) * 2),
      "-f",
      "s16le",
      job.pcm,
    ],
    cwd: outDir,
    env: { HOME: outDir, LANG: "en_US.UTF-8" },
    read: dir === outDir ? [] : [dir],
    write: [outDir],
    trusted: tools.ffmpeg.trusted,
    network: "none",
    noFlagChanges: true,
    timeoutMs: SPEECH_AUDIO_LIMITS.measureTimeoutMs,
    maxRssBytes: SPEECH_AUDIO_LIMITS.memoryBytes,
    maxOutputBytes: 256 * 1024,
  };
}

/** The ffmpeg run that encodes the PCM files, in order, into one MP3 (exported for tests). */
export function encodeOptions(
  tools: { ffmpeg: Ffmpeg },
  job: { workdir: string; pcms: string[]; bitrateK: number; sampleRate: number; out: string },
): RunIsolatedOptions {
  const outDir = path.join(job.workdir, "out");
  return {
    command: tools.ffmpeg.exe,
    args: [
      "-nostdin",
      "-hide_banner",
      "-nostats",
      "-v",
      "error",
      "-f",
      "s16le",
      "-ar",
      String(job.sampleRate),
      "-ac",
      "1",
      // The PCM files one after another, as one input (raw samples: nothing between them).
      "-protocol_whitelist",
      "concat,file",
      "-i",
      `concat:${job.pcms.join("|")}`,
      "-c:a",
      "libmp3lame",
      "-b:a",
      `${job.bitrateK}k`,
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
    read: [],
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

const Gate = z.object({
  format: z.object({ format_name: z.string().max(200).optional() }).optional(),
  streams: z
    .array(
      z.object({
        codec_type: z.string().max(40).optional(),
        codec_name: z.string().max(40).optional(),
        sample_rate: z.coerce.number().int().positive().optional(),
        disposition: z.object({ attached_pic: z.number().int() }).partial().optional(),
      }),
    )
    .max(64)
    .optional(),
});

/**
 * ffprobe's gate judged (exported for tests): container `mp3`, exactly one audio stream, codec `mp3`, no other
 * stream but attached pictures — its stream rate (the call's PCM rate when it is the first answer). Anything else,
 * or a report that is not that structure, is `unsupported` (the file is not an answer this server takes).
 */
export function judgeGate(stdout: string): { ok: true; sampleRate: number } | { ok: false } {
  let g: z.infer<typeof Gate>;
  try {
    const p = Gate.safeParse(JSON.parse(stdout));
    if (!p.success) return { ok: false };
    g = p.data;
  } catch {
    return { ok: false };
  }
  if (g.format?.format_name !== "mp3") return { ok: false };
  const streams = g.streams ?? [];
  const audio = streams.filter((st) => st.codec_type === "audio");
  const others = streams.filter(
    (st) => st.codec_type !== "audio" && !(st.codec_type === "video" && st.disposition?.attached_pic === 1),
  );
  if (audio.length !== 1 || others.length || audio[0]!.codec_name !== "mp3" || !audio[0]!.sample_rate)
    return { ok: false };
  return { ok: true, sampleRate: audio[0]!.sample_rate };
}

/** A regular file with one name (not a link): its size, or undefined. */
function plainSize(file: string): number | undefined {
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  return st?.isFile() && st.nlink === 1 ? st.size : undefined;
}

/** The `SpeechAudio` the app uses: the sandboxed ffmpeg and ffprobe (undefined without them). */
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
      // 1. The gate: ffprobe's container and stream fields.
      const g = await attempt(gateOptions(tools, file), m.signal);
      const gv = decodeVerdict(g);
      if (gv === "failed") return { ok: false, reason: "failed" };
      // A file ffprobe cannot read, or not the one form: not an answer this server takes.
      const gate = gv === "ok" ? judgeGate(g!.stdout) : { ok: false as const };
      if (!gate.ok) return { ok: false, reason: "unsupported" };
      // 2. The strict decode into PCM at the call's rate.
      const sampleRate = m.sampleRate ?? gate.sampleRate;
      const pcm = path.join(path.dirname(path.dirname(file)), "out", `pcm-${++n}.s16`);
      const verdict = decodeVerdict(
        await attempt(decodeOptions(tools, { file, pcm, sampleRate, maxSeconds: m.maxSeconds }), m.signal),
      );
      const size = verdict === "ok" ? plainSize(pcm) : undefined;
      if (verdict !== "ok" || size === undefined || size % 2) {
        fs.rmSync(pcm, { force: true });
        return { ok: false, reason: verdict === "corrupt" ? "corrupt" : "failed" };
      }
      const samples = size / 2;
      if (samples > m.maxSeconds * sampleRate) {
        fs.rmSync(pcm, { force: true });
        return { ok: false, reason: "too_long" };
      }
      return { ok: true, samples, seconds: samples / sampleRate, sampleRate, pcm };
    },
    async encode(job, signal) {
      const outDir = path.join(job.workdir, "out");
      if (!job.pcms.length) return undefined;
      for (const f of job.pcms)
        if (path.dirname(f) !== outDir || plainSize(f) === undefined) return undefined;
      const out = path.join(outDir, `speech-${++n}.mp3`);
      const r = await attempt(encodeOptions(tools, { ...job, out }), signal);
      if (decodeVerdict(r) !== "ok") return undefined;
      return plainSize(out) === undefined ? undefined : out;
    },
  };
}
