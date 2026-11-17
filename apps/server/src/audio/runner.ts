import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AUDIO_LIMITS, type AudioCode } from "@agentlee/shared";
import { runIsolated, type RunIsolatedOptions, type RunResult } from "../isolation/sandbox.js";
import { AUDIO_DIR, AUDIO_ENTRY, type AudioEnv } from "./packages.js";

/**
 * How `audio_transcribe` runs its programs (#173, PRD NFR 격리). Every step is its own sandboxed process (#42) with
 * its own process group (killed whole on a limit), no network, no child processes and a fixed environment:
 *
 * 1. **convert** — ffmpeg reads the input copy (`in/`) and writes one 16 kHz mono PCM WAV (`out/`), capped at the
 *    longest allowed recording plus a second. This is the only process that parses the uploaded container.
 * 2. **diarize**, then **transcribe** — the pinned python (`transcribe.py`) reads only that WAV, the pinned packages
 *    and models (read-only program folders), writes only its own `py/` folder (HOME, TMPDIR), and reaches the GPU
 *    through Metal (`gpu`: two IOKit user clients). Two processes, so a Whisper crash or memory kill never takes
 *    the speaker turns with it, and the fallback (OpenRouter) needs only the words.
 * 3. **chunks** (fallback only) — ffmpeg re-encodes the WAV to 64 kbps mono MP3 pieces under the provider's limit.
 *
 * Tests give the service a runner of their own (fake STT and diarizer); off macOS this one answers
 * `audio_unavailable`.
 */

export type Segment = { start: number; end: number; text: string };
export type SpeakerTurn = { speaker: number; start: number; end: number };

export type ConvertJob = { env: AudioEnv; workdir: string; input: string };
export type ModelsJob = {
  env: AudioEnv;
  workdir: string;
  wav: string;
  language: string;
  threshold: number;
};
export type Fail = { ok: false; code: AudioCode };

export type AudioRunner = {
  /** The input copy → `out/audio.wav` (16 kHz mono s16) and its length. */
  convert(job: ConvertJob, signal?: AbortSignal): Promise<{ ok: true; wav: string; seconds: number } | Fail>;
  /** Speaker turns of the WAV (Nemotron). */
  diarize(job: ModelsJob, signal?: AbortSignal): Promise<{ ok: true; turns: SpeakerTurn[] } | Fail>;
  /** Timed text of the WAV (MLX Whisper). */
  transcribe(job: ModelsJob, signal?: AbortSignal): Promise<{ ok: true; segments: Segment[] } | Fail>;
  /** The WAV as MP3 pieces of at most `AUDIO_LIMITS.fallbackChunkSeconds`, in order, with their start times. */
  chunks(
    job: { env: AudioEnv; workdir: string; wav: string },
    signal?: AbortSignal,
  ): Promise<{ ok: true; chunks: { file: string; start: number }[] } | Fail>;
};

/** Where a run's code reads and writes, below its working folder. */
export const workFolders = (workdir: string) => ({
  in: path.join(workdir, "in"),
  out: path.join(workdir, "out"),
  py: path.join(workdir, "py"),
  chunks: path.join(workdir, "chunks"),
});

/** The fixed environment of the python process. No secret, nothing inherited. */
export function modelsEnvVars(workdir: string): Record<string, string> {
  const py = workFolders(workdir).py;
  return {
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    HOME: py,
    TMPDIR: path.join(py, "tmp"),
    HF_HOME: path.join(py, "hf"),
    HF_HUB_OFFLINE: "1",
    TRANSFORMERS_OFFLINE: "1",
    HF_HUB_DISABLE_TELEMETRY: "1",
    TOKENIZERS_PARALLELISM: "false",
  };
}

/** The ffmpeg run that makes the WAV (exported for the profile tests). */
export function convertOptions(job: ConvertJob): RunIsolatedOptions {
  const f = workFolders(job.workdir);
  return {
    command: job.env.ffmpeg.exe,
    args: [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      job.input,
      // The first audio track only: no video, subtitles, data or attachments are decoded.
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "-t",
      String(AUDIO_LIMITS.maxSeconds + 1),
      "-f",
      "wav",
      path.join(f.out, "audio.wav"),
    ],
    cwd: f.out,
    env: { HOME: f.out, LANG: "en_US.UTF-8" },
    read: [f.in],
    write: [f.out],
    trusted: job.env.ffmpeg.trusted,
    network: "none",
    noFlagChanges: true,
    timeoutMs: AUDIO_LIMITS.convertTimeoutMs,
    maxRssBytes: AUDIO_LIMITS.convertMemoryBytes,
    maxOutputBytes: 64 * 1024,
  };
}

/** The python run of one model step (exported for the profile tests). */
export function modelsOptions(job: ModelsJob, step: "diarize" | "transcribe"): RunIsolatedOptions {
  const f = workFolders(job.workdir);
  const { runtime, packages, models } = job.env;
  return {
    command: runtime.exe,
    // -I: no PYTHON* variables, no user site, no script folder on sys.path. -S: no site-packages. -B: no .pyc.
    args: ["-I", "-S", "-B", AUDIO_ENTRY],
    cwd: f.py,
    env: modelsEnvVars(job.workdir),
    read: [f.out],
    write: [f.py],
    trusted: [runtime.root, AUDIO_DIR, packages, models.stt, models.diarizer],
    network: "none",
    noFlagChanges: true,
    gpu: true,
    stdin: JSON.stringify({
      packages,
      models,
      wav: job.wav,
      language: job.language,
      diarize: step === "diarize",
      stt: step === "transcribe",
      threshold: job.threshold,
      minDuration: AUDIO_LIMITS.minDurationSeconds,
      mergeGap: AUDIO_LIMITS.mergeGapSeconds,
      fileBytes: 64 * 1024 * 1024,
    }),
    timeoutMs: AUDIO_LIMITS.transcribeTimeoutMs,
    maxRssBytes: AUDIO_LIMITS.transcribeMemoryBytes,
    // The report: segments of the longest recording, JSON-escaped — generous, and still bounded.
    maxOutputBytes: 64 * 1024 * 1024,
  };
}

/** The ffmpeg run that cuts the WAV into MP3 pieces for the fallback. */
export function chunkOptions(job: { env: AudioEnv; workdir: string; wav: string }): RunIsolatedOptions {
  const f = workFolders(job.workdir);
  return {
    command: job.env.ffmpeg.exe,
    args: [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      job.wav,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "64k",
      "-f",
      "segment",
      "-segment_time",
      String(AUDIO_LIMITS.fallbackChunkSeconds),
      "-reset_timestamps",
      "1",
      path.join(f.chunks, "chunk-%03d.mp3"),
    ],
    cwd: f.chunks,
    env: { HOME: f.chunks, LANG: "en_US.UTF-8" },
    read: [f.out],
    write: [f.chunks],
    trusted: job.env.ffmpeg.trusted,
    network: "none",
    noFlagChanges: true,
    timeoutMs: AUDIO_LIMITS.convertTimeoutMs,
    maxRssBytes: AUDIO_LIMITS.convertMemoryBytes,
    maxOutputBytes: 64 * 1024,
  };
}

/**
 * Seconds of audio in a 16 kHz mono 16-bit WAV, from its `data` chunk (ffmpeg may put a LIST chunk before it).
 * Undefined when the file is not such a WAV.
 */
export function wavSeconds(file: string): number | undefined {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(Math.min(size, 4096));
    fs.readSync(fd, head, 0, head.length, 0);
    if (
      head.length < 12 ||
      head.toString("latin1", 0, 4) !== "RIFF" ||
      head.toString("latin1", 8, 12) !== "WAVE"
    )
      return undefined;
    let p = 12;
    let fmtOk = false;
    while (p + 8 <= head.length) {
      const id = head.toString("latin1", p, p + 4);
      const len = head.readUInt32LE(p + 4);
      if (id === "fmt ") {
        if (p + 8 + 16 > head.length) return undefined;
        const channels = head.readUInt16LE(p + 10);
        const rate = head.readUInt32LE(p + 12);
        const bits = head.readUInt16LE(p + 22);
        fmtOk = channels === 1 && rate === 16000 && bits === 16;
      } else if (id === "data") {
        if (!fmtOk) return undefined;
        // ffmpeg writes 0xffffffff when it could not seek back; the file's size is then the truth.
        const bytes = len === 0xffffffff || p + 8 + len > size ? size - (p + 8) : len;
        return bytes / 32000;
      }
      p += 8 + len + (len & 1);
    }
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

const Report = z.object({
  diarization: z
    .union([
      z.object({
        ok: z.literal(true),
        segments: z.array(
          z.object({ speaker: z.number().int().min(0).max(63), start: z.number(), end: z.number() }),
        ),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ])
    .nullable(),
  stt: z
    .union([
      z.object({
        ok: z.literal(true),
        segments: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })),
      }),
      z.object({ ok: z.literal(false), error: z.string() }),
    ])
    .nullable(),
});

/** A finished process as an outcome code: the limit it hit, or a plain failure. */
export function limitCode(r: RunResult): AudioCode | undefined {
  if (r.killed === "timeout") return "audio_timeout";
  if (r.killed === "memory" || r.killed === "monitor") return "audio_memory_limit";
  if (r.killed) return "audio_failed";
  return undefined;
}

/** The python report of one step, or why there is none. */
export function modelsReport(r: RunResult): z.infer<typeof Report> | AudioCode {
  const limit = limitCode(r);
  if (limit) return limit;
  if (r.code !== 0) return "audio_failed";
  try {
    const p = Report.safeParse(JSON.parse(r.stdout));
    return p.success ? p.data : "audio_failed";
  } catch {
    return "audio_failed";
  }
}

const finite = (s: { start: number; end: number }) =>
  Number.isFinite(s.start) && Number.isFinite(s.end) && s.start >= 0 && s.end >= s.start;

/** The runner the app uses: every step under `runIsolated` (macOS only). */
export function sandboxedAudioRunner(o: { run?: typeof runIsolated } = {}): AudioRunner {
  const run = o.run ?? runIsolated;
  const attempt = async (opts: RunIsolatedOptions, signal?: AbortSignal): Promise<RunResult | Fail> => {
    try {
      return await run({ ...opts, ...(signal ? { signal } : {}) });
    } catch {
      // No sandbox here (not macOS), a hard link in an allowed folder, a spawn failure: nothing ran.
      return { ok: false, code: "audio_unavailable" };
    }
  };
  const isFail = (r: RunResult | Fail): r is Fail => "ok" in r;
  return {
    async convert(job, signal) {
      const f = workFolders(job.workdir);
      fs.mkdirSync(f.out, { recursive: true, mode: 0o700 });
      const r = await attempt(convertOptions(job), signal);
      if (isFail(r)) return r;
      const limit = limitCode(r);
      if (limit) return { ok: false, code: limit === "audio_failed" ? "audio_decode_failed" : limit };
      const wav = path.join(f.out, "audio.wav");
      const st = fs.lstatSync(wav, { throwIfNoEntry: false });
      if (r.code !== 0 || !st?.isFile() || st.nlink !== 1) return { ok: false, code: "audio_decode_failed" };
      const seconds = wavSeconds(wav);
      if (seconds === undefined) return { ok: false, code: "audio_decode_failed" };
      return { ok: true, wav, seconds };
    },
    async diarize(job, signal) {
      fs.mkdirSync(path.join(workFolders(job.workdir).py, "tmp"), { recursive: true, mode: 0o700 });
      const r = await attempt(modelsOptions(job, "diarize"), signal);
      if (isFail(r)) return r;
      const rep = modelsReport(r);
      if (typeof rep === "string") return { ok: false, code: rep };
      if (!rep.diarization?.ok) return { ok: false, code: "audio_failed" };
      return { ok: true, turns: rep.diarization.segments.filter(finite) };
    },
    async transcribe(job, signal) {
      fs.mkdirSync(path.join(workFolders(job.workdir).py, "tmp"), { recursive: true, mode: 0o700 });
      const r = await attempt(modelsOptions(job, "transcribe"), signal);
      if (isFail(r)) return r;
      const rep = modelsReport(r);
      if (typeof rep === "string") return { ok: false, code: rep };
      if (!rep.stt?.ok) return { ok: false, code: "audio_failed" };
      return { ok: true, segments: rep.stt.segments.filter(finite) };
    },
    async chunks(job, signal) {
      const f = workFolders(job.workdir);
      fs.mkdirSync(f.chunks, { recursive: true, mode: 0o700 });
      const r = await attempt(chunkOptions(job), signal);
      if (isFail(r)) return r;
      const limit = limitCode(r);
      if (limit) return { ok: false, code: limit };
      if (r.code !== 0) return { ok: false, code: "audio_failed" };
      const names = fs
        .readdirSync(f.chunks)
        .filter((n) => /^chunk-\d{3}\.mp3$/.test(n))
        .sort();
      if (!names.length) return { ok: false, code: "audio_failed" };
      return {
        ok: true,
        chunks: names.map((n, i) => ({
          file: path.join(f.chunks, n),
          start: i * AUDIO_LIMITS.fallbackChunkSeconds,
        })),
      };
    },
  };
}
