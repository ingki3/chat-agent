import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setImmediate as yieldNow } from "node:timers/promises";
import { z } from "zod";
import { COMPOSE_LIMITS, type ComposeJobCode, type ComposeTimeline, type FileKind } from "@agentlee/shared";
import { runIsolated, type RunIsolatedOptions, type RunResult } from "../isolation/sandbox.js";
import { removeTree } from "../python/service.js";
import { storagePaths } from "../storage/paths.js";
import {
  audioArgs,
  clipArgs,
  concatList,
  cueText,
  FPS,
  ingestArgs,
  inputKindOf,
  muxArgs,
  pieces,
  planTimeline,
  probeArgs,
  DEMUXER,
  RATE,
  sourcePcm,
  SPF,
  toAss,
  transitionArgs,
  verifyArgs,
  workUnits,
  isPlanError,
  type InputInfo,
  type Plan,
} from "./compose-plan.js";
import { decodeVerdict, makeScratchDir, speechTools, sweepScratch } from "./speech-audio.js";
import { KNOWN_GOOD_MP4, MP4_BRANDS } from "./video-probe.js";

/**
 * 멀티미디어 합성's programs (#238 stage 4-1): `audio_transcribe`'s ffmpeg (`AUDIO_FFMPEG`, default Homebrew's) and the
 * ffprobe beside it, every run its own sandboxed process group (`runIsolated`, #42): no network, no child processes, a
 * fixed environment, the job's remaining time, 2 GiB of memory, two threads; it reads only the job's `in/` and `work/`
 * and writes only `work/` (the mux: `out/`). The arguments are `compose-plan.ts`'s. Without ffmpeg/ffprobe (not macOS)
 * there is no `Composer`, and `compose_video` is not offered.
 *
 * Working folders: `<DATA_DIR>/compose-scratch/<job id>/{in,work,out}` — the job's copies of its inputs, the pieces, the
 * result — removed when the job ends (and every one at the engine's start).
 */
/** A composition's end: the checked MP4 and the plan it was made from (lengths decoded), or why there is none. */
export type ComposeOutcome =
  { ok: true; file: string; bytes: number; plan: Plan } | { ok: false; code: ComposeJobCode };
export type ProbeOutcome =
  | { ok: true; info: Omit<InputInfo, "fileId" | "name"> }
  | { ok: false; reason: "unreadable" | "kind" | "failed" };

export type Composer = {
  /** A fresh job folder with `in/`, `work/` and `out/` (its name is the job's id). */
  workdir(): string;
  /** One input copy (`in/<name>`) probed: its kind (as its file row says, read with that demuxer), streams, length. */
  probe(file: string, fileKind: FileKind, signal?: AbortSignal): Promise<ProbeOutcome>;
  /**
   * The whole composition in the job folder; the checked MP4 in `out/` (review R5). The inputs' lengths are decoded
   * first and the plan made from them (the re-plan after review r3: what the call worked out was an estimate).
   */
  compose(job: {
    dir: string;
    timeline: ComposeTimeline;
    /** The inputs as the call found them (kinds, streams, names in `in/`; their lengths are estimates). */
    inputs: readonly InputInfo[];
    signal: AbortSignal;
    deadlineAt: number;
    onProgress: (fraction: number) => void;
  }): Promise<ComposeOutcome>;
  /** Whether a tiny composition works here, in the same sandbox, checked like a real one. */
  ready(signal?: AbortSignal): Promise<boolean>;
};

export const COMPOSE_RUN_LIMITS = {
  memoryBytes: 2 * 1024 * 1024 * 1024,
  probeTimeoutMs: 60_000,
  stderrBytes: 256 * 1024,
} as const;

const JOB_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `compose-scratch/<uuid>/{in,work,out}` under the data folder (checked like `speech-scratch`). */
export function makeComposeWorkdir(dataDir: string): string {
  const dir = makeScratchDir(dataDir, storagePaths(dataDir).composeScratch);
  for (const d of ["in", "work", "out"]) fs.mkdirSync(path.join(dir, d), { mode: 0o700 });
  return dir;
}
export const removeComposeWorkdir = (dir: string): boolean => {
  if (!JOB_NAME.test(path.basename(dir))) return false;
  try {
    return removeTree(dir);
  } catch {
    return false;
  }
};
/** Every job folder not kept (the engine's start: none is in use; later sweeps keep the jobs under way). */
export const sweepComposeScratch = (
  dataDir: string,
  keep: (name: string) => boolean = () => false,
): boolean => sweepScratch(dataDir, storagePaths(dataDir).composeScratch, keep);

const Probe = z.object({
  format: z
    .object({
      format_name: z.string().max(200).optional(),
      duration: z.coerce.number().optional(),
      start_time: z.coerce.number().optional(),
    })
    .optional(),
  streams: z
    .array(
      z.object({
        codec_type: z.string().max(40).optional(),
        codec_name: z.string().max(40).optional(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        duration: z.coerce.number().optional(),
        start_time: z.coerce.number().optional(),
        disposition: z.object({ attached_pic: z.number().int() }).partial().optional(),
      }),
    )
    .max(64)
    .optional(),
});

/** ffprobe's report of an input judged (exported for tests). */
export function judgeInput(stdout: string, fileKind: FileKind): ProbeOutcome {
  const kind = inputKindOf(fileKind);
  if (!kind) return { ok: false, reason: "kind" };
  let r: z.infer<typeof Probe>;
  try {
    const p = Probe.safeParse(JSON.parse(stdout));
    if (!p.success) return { ok: false, reason: "unreadable" };
    r = p.data;
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  const streams = r.streams ?? [];
  const video = streams.filter((s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1);
  const audio = streams.filter((s) => s.codec_type === "audio");
  const v = video[0];
  const side = (n: number | undefined) => n !== undefined && n > 0 && n <= COMPOSE_LIMITS.maxInputSide;
  const duration =
    Number.isFinite(r.format?.duration) && r.format!.duration! > 0 ? r.format!.duration! : null;
  // Review r1: the first sound's end from the file's start — its own start and length (a video's sound may be shorter
  // than its picture, or start later); the file's length when the stream does not say.
  const a = audio[0];
  const origin = Number.isFinite(r.format?.start_time) ? r.format!.start_time! : 0;
  const audioSec = !a
    ? null
    : Number.isFinite(a.duration) && a.duration! > 0
      ? Math.max(0, (Number.isFinite(a.start_time) ? a.start_time! : origin) - origin) + a.duration!
      : duration;
  // Review r4: an MP4/MOV's sound track ends where its presentation timeline says (its edit list — exact): an AAC's
  // last frame decodes past it (padding). Read on the same timeline the ingest uses (`-copyts`).
  const audioEndSec =
    DEMUXER[fileKind] === "mov" && a && Number.isFinite(a.duration) && a.duration! > 0
      ? (Number.isFinite(a.start_time) ? a.start_time! : 0) + a.duration!
      : null;

  if (kind === "image") {
    if (!v || !side(v.width) || !side(v.height)) return { ok: false, reason: "unreadable" };
    return {
      ok: true,
      info: {
        fileKind,
        kind,
        durationSec: null,
        hasVideo: true,
        hasAudio: false,
        width: v.width!,
        height: v.height!,
      },
    };
  }
  if (kind === "video") {
    // A cover picture only (an audio file in an MP4) is not a video — but its sound may still be narration.
    if (v && (!side(v.width) || !side(v.height))) return { ok: false, reason: "unreadable" };
    if (!v && !audio.length) return { ok: false, reason: "unreadable" };
    if (duration === null) return { ok: false, reason: "unreadable" };
    return {
      ok: true,
      info: {
        fileKind,
        kind,
        durationSec: duration,
        hasVideo: !!v,
        hasAudio: audio.length > 0,
        audioSec,
        audioEndSec,
        width: v?.width ?? null,
        height: v?.height ?? null,
      },
    };
  }
  if (!audio.length || duration === null) return { ok: false, reason: "unreadable" };
  return {
    ok: true,
    info: {
      fileKind,
      kind,
      durationSec: duration,
      audioSec,
      audioEndSec,
      hasVideo: false,
      hasAudio: true,
      width: null,
      height: null,
    },
  };
}

const Verify = z.object({
  format: z
    .object({
      format_name: z.string().max(200).optional(),
      tags: z
        .object({ major_brand: z.string().max(16).optional() })
        .partial()
        .optional(),
    })
    .optional(),
  streams: z
    .array(
      z.object({
        codec_type: z.string().max(40).optional(),
        codec_name: z.string().max(40).optional(),
        nb_read_packets: z.coerce.number().int().optional(),
        duration: z.coerce.number().optional(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        disposition: z.object({ attached_pic: z.number().int() }).partial().optional(),
      }),
    )
    .max(16)
    .optional(),
});

/**
 * The result judged (review R5, exported for tests): an MP4 (`isom`-family brand) with exactly one H.264 picture of the
 * plan's size and frame count (±1 frame: one packet per frame), one AAC sound within 0.1 s of the plan's samples, and
 * a `mov_text` subtitle track exactly when the plan has subtitles.
 */
export function judgeResult(stdout: string, plan: Plan, subtitles: boolean): boolean {
  let r: z.infer<typeof Verify>;
  try {
    const p = Verify.safeParse(JSON.parse(stdout));
    if (!p.success) return false;
    r = p.data;
  } catch {
    return false;
  }
  const names = (r.format?.format_name ?? "").split(",");
  const brand = (r.format?.tags?.major_brand ?? "").toLowerCase().padEnd(4, " ");
  if (!names.includes("mp4") || !MP4_BRANDS.has(brand)) return false;
  const s = r.streams ?? [];
  const video = s.filter((x) => x.codec_type === "video" && x.disposition?.attached_pic !== 1);
  const audio = s.filter((x) => x.codec_type === "audio");
  const subs = s.filter((x) => x.codec_type === "subtitle");
  if (video.length !== 1 || audio.length !== 1 || subs.length !== (subtitles ? 1 : 0)) return false;
  const v = video[0]!;
  const a = audio[0]!;
  if (v.codec_name !== "h264" || v.width !== plan.width || v.height !== plan.height) return false;
  if (v.nb_read_packets === undefined || Math.abs(v.nb_read_packets - plan.frames) > 1) return false;
  if (a.codec_name !== "aac" || a.duration === undefined) return false;
  // Review r4: picture and sound end together — the sound within one frame of the picture's frames.
  if (Math.abs(a.duration - plan.samples / (SPF * 30)) > 1 / 30 + 1e-3) return false;
  if (subtitles && subs[0]!.codec_name !== "mov_text") return false;
  return true;
}

/** A regular file with one name (not a link): its size, or undefined. */
function plainSize(file: string): number | undefined {
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  return st?.isFile() && st.nlink === 1 ? st.size : undefined;
}

/**
 * One track of a mix: placed at `start` (samples of the result) for `length` samples, faded in and out over its
 * overlaps; its samples are read from `offset` in `file` — `take` of them at most (the rest, and whatever the file does
 * not have, is silence) — times `gain`.
 */
export type Track = {
  file: string;
  start: number;
  length: number;
  fadeIn: number;
  fadeOut: number;
  offset?: number;
  take?: number;
  gain?: number;
};

/**
 * PCM tracks (48 kHz stereo s16) summed into one of `total` samples, second by second (exported for tests): each at its
 * start, cut to its length, faded in and out linearly over its overlaps (two crossfading clips add up to one), clipped
 * to 16 bits. The clips' sound (`bed.pcm`: their transitions are their crossfades) and the narration (`narration.pcm`).
 */
export async function mixPcm(out: string, total: number, tracks: readonly Track[]): Promise<void> {
  const CHUNK = 48_000;
  const fd = fs.openSync(out, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  const fds = new Map<string, number>();
  try {
    const acc = new Float64Array(CHUNK * 2);
    const outBuf = Buffer.alloc(CHUNK * 4);
    const inBuf = Buffer.alloc(CHUNK * 4);
    for (let c0 = 0; c0 < total; c0 += CHUNK) {
      const n = Math.min(CHUNK, total - c0);
      acc.fill(0, 0, n * 2);
      for (const t of tracks) {
        const from = Math.max(c0, t.start);
        // Only the samples it has: past `take` (and past the file's end) the track is silence.
        const to = Math.min(c0 + n, t.start + Math.min(t.length, t.take ?? t.length));
        if (to <= from) continue;
        const gain = t.gain ?? 1;
        let tfd = fds.get(t.file);
        if (tfd === undefined)
          fds.set(t.file, (tfd = fs.openSync(t.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)));
        const count = to - from;
        const got = fs.readSync(tfd, inBuf, 0, count * 4, ((t.offset ?? 0) + from - t.start) * 4);
        const have = Math.floor(got / 4);
        for (let k = 0; k < have; k++) {
          const p = from - t.start + k;
          let w = gain;
          if (t.fadeIn > 0 && p < t.fadeIn) w = (gain * p) / t.fadeIn;
          if (t.fadeOut > 0 && p >= t.length - t.fadeOut)
            w = Math.min(w, (gain * (t.length - p)) / t.fadeOut);
          const o = (from - c0 + k) * 2;
          acc[o] = acc[o]! + inBuf.readInt16LE(k * 4) * w;
          acc[o + 1] = acc[o + 1]! + inBuf.readInt16LE(k * 4 + 2) * w;
        }
      }
      for (let k = 0; k < n * 2; k++)
        outBuf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(acc[k]!))), k * 2);
      let off = 0;
      while (off < n * 4) off += fs.writeSync(fd, outBuf, off, n * 4 - off);
      await yieldNow();
    }
  } finally {
    fs.closeSync(fd);
    for (const f of fds.values()) fs.closeSync(f);
  }
}

/** A tiny PNG (16×16, one colour): the readiness check's input. */
const READY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAGUlEQVR4nGPUT9jHQApgIUn1qIZRDUNKAwBa4wGLIbQV5gAAAABJRU5ErkJggg==",
  "base64",
);

/** The progress value of an ffmpeg `-progress` line (`out_time_us=`): seconds done, or undefined. */
export const progressSeconds = (line: string): number | undefined => {
  const m = /^out_time_(?:us|ms)=(\d+)$/.exec(line.trim());
  return m ? Number(m[1]) / 1_000_000 : undefined;
};

/** The `Composer` the app uses: the sandboxed ffmpeg and ffprobe (undefined without them). */
export function sandboxedComposer(o: {
  dataDir: string;
  ffmpegPath?: string | undefined;
  platform?: NodeJS.Platform;
  run?: typeof runIsolated;
  /** Tests: every run's peak memory. */
  onPeakRss?: (bytes: number) => void;
}): Composer | undefined {
  const tools = speechTools(o.ffmpegPath, o.dataDir, o.platform);
  if (!tools) return undefined;
  const run = o.run ?? runIsolated;
  const exec = async (
    command: string,
    args: string[],
    p: {
      cwd: string;
      read: string[];
      write: string[];
      timeoutMs: number;
      signal?: AbortSignal | undefined;
      onLine?: (l: string) => void;
      maxOutputBytes?: number;
    },
  ): Promise<RunResult | undefined> => {
    const opts: RunIsolatedOptions = {
      command,
      args,
      cwd: p.cwd,
      env: { HOME: p.cwd, LANG: "en_US.UTF-8" },
      read: p.read,
      write: p.write,
      trusted: tools.ffmpeg.trusted,
      network: "none",
      noFlagChanges: true,
      timeoutMs: Math.max(1000, p.timeoutMs),
      maxRssBytes: COMPOSE_RUN_LIMITS.memoryBytes,
      maxOutputBytes: p.maxOutputBytes ?? COMPOSE_RUN_LIMITS.stderrBytes,
      ...(p.signal ? { signal: p.signal } : {}),
      ...(p.onLine ? { onStdoutLine: p.onLine } : {}),
      ...(o.onPeakRss ? { onPeakRss: o.onPeakRss } : {}),
    };
    try {
      return await run(opts);
    } catch {
      // No sandbox, a hard link in an allowed folder, a spawn failure: nothing ran.
      return undefined;
    }
  };

  const probe: Composer["probe"] = async (file, fileKind, signal) => {
    if (!inputKindOf(fileKind)) return { ok: false, reason: "kind" };
    if (plainSize(file) === undefined) return { ok: false, reason: "failed" };
    const dir = path.dirname(file);
    const r = await exec(tools.ffprobe, probeArgs(file, fileKind), {
      cwd: dir,
      read: [dir],
      write: [],
      timeoutMs: COMPOSE_RUN_LIMITS.probeTimeoutMs,
      signal,
      maxOutputBytes: 64 * 1024,
    });
    const v = decodeVerdict(r);
    if (v === "failed") return { ok: false, reason: "failed" };
    if (v !== "ok") return { ok: false, reason: "unreadable" };
    return judgeInput(r!.stdout, fileKind);
  };

  const compose: Composer["compose"] = async (job) => {
    const inDir = path.join(job.dir, "in");
    const work = path.join(job.dir, "work");
    const outDir = path.join(job.dir, "out");
    const t = job.timeline;
    let done = 0;
    let totalUnits = 1;
    const report = (f: number) => job.onProgress(Math.max(0, Math.min(1, f)));
    /** One ffmpeg run of `weight` units over `seconds` of output (its progress lines move the bar). */
    const step = async (
      args: string[],
      weight: number,
      seconds: number,
      where: { read: string[]; write: string[] },
      onLine?: (l: string) => void,
    ): Promise<ComposeJobCode | null> => {
      if (job.signal.aborted) return "compose_failed";
      const left = job.deadlineAt - Date.now();
      if (left <= 0) return "compose_timeout";
      const r = await exec(tools.ffmpeg.exe, args, {
        cwd: work,
        read: where.read,
        write: where.write,
        timeoutMs: left,
        signal: job.signal,
        onLine: (l) => {
          onLine?.(l);
          const s = progressSeconds(l);
          if (s !== undefined && seconds > 0) report((done + weight * Math.min(1, s / seconds)) / totalUnits);
        },
      });
      done += weight;
      report(done / totalUnits);
      if (r?.killed === "timeout" || Date.now() >= job.deadlineAt) return "compose_timeout";
      return decodeVerdict(r) === "ok" ? null : "compose_failed";
    };
    const local = { read: [inDir, work], write: [work] };
    // 1. Ingest (the re-plan after review r3): every input with sound or used as a clip decoded once from its start —
    //    the sound to PCM (its sample count is its length), the picture counted at 30 fps. Nothing is read from
    //    metadata for a length.
    const byId = new Map(job.inputs.map((i) => [i.fileId, i]));
    const caps = new Map<string, { cap: number; count: boolean }>();
    const use = (fileId: string, cap: number, count: boolean) => {
      const was = caps.get(fileId);
      caps.set(fileId, { cap: Math.max(was?.cap ?? 0, cap), count: (was?.count ?? false) || count });
    };
    const longest = COMPOSE_LIMITS.maxSeconds + 1;
    for (const c of t.clips) {
      const info = byId.get(c.fileId);
      if (!info || info.kind !== "video") continue;
      // What the clip takes from its source: up to the trim's end, or its length from the start (else all of it).
      // Review r4: with a trim and a length, only up to the earlier of the two.
      const end = c.trim
        ? Math.min(c.trim.endSec, c.trim.startSec + (c.durationSec ?? Infinity))
        : (c.durationSec ?? longest);
      use(c.fileId, Math.min(end, COMPOSE_LIMITS.maxSourceSeconds) + 1, true);
    }
    for (const n of t.narration ?? []) use(n.fileId, longest, false);
    if (t.music) use(t.music.fileId, longest, false);
    const truth = new Map<string, InputInfo>();
    for (const info of job.inputs) truth.set(info.fileId, info);
    for (const [fileId, u] of caps) {
      const info = byId.get(fileId)!;
      if (info.kind === "image") continue;
      let pictureFrames: number | undefined;
      const code = await step(
        ingestArgs({
          inDir,
          input: info.name,
          fileKind: info.fileKind,
          sound: info.hasAudio,
          countPicture: u.count && info.hasVideo,
          capSec: u.cap,
          soundEndSec: info.audioEndSec ?? null,
        }),
        0,
        0,
        local,
        (l) => {
          const m = /^frame=(\d+)$/.exec(l.trim());
          if (m) pictureFrames = Number(m[1]);
        },
      );
      if (code) return { ok: false, code };
      let audioSec: number | null = null;
      if (info.hasAudio) {
        const size = plainSize(path.join(work, sourcePcm(info.name)));
        if (size === undefined || size % 4) return { ok: false, code: "compose_failed" };
        audioSec = size / 4 / RATE;
      }
      const pictureSec = u.count && info.hasVideo ? (pictureFrames ?? 0) / FPS : null;
      if (u.count && info.hasVideo && !pictureFrames) return { ok: false, code: "compose_failed" };
      truth.set(fileId, {
        ...info,
        durationSec: Math.max(pictureSec ?? 0, audioSec ?? 0) || (info.durationSec ?? 0),
        audioSec,
      });
    }
    // 2. The plan from the decoded lengths (a narration that is really longer holds the last picture; the 5-minute cap
    //    on the real total).
    const plan = planTimeline(t, truth);
    if (isPlanError(plan))
      return {
        ok: false,
        code: plan.code === "compose_too_long" ? "compose_too_long" : "compose_timeline_mismatch",
      };
    const units = workUnits(plan);
    totalUnits =
      done +
      units.clips.reduce((a, b) => a + b, 0) +
      units.transitions.reduce((a, b) => a + b, 0) +
      units.audio +
      units.mux;
    // 3. Every clip's picture pieces.
    for (const [i, c] of plan.clips.entries()) {
      const code = await step(clipArgs(plan, i, inDir), units.clips[i]!, c.frames / FPS, local);
      if (code) return { ok: false, code };
      const p = pieces(i);
      if (c.frames - c.head - c.tail > 0 && plainSize(path.join(work, p.body)) === undefined)
        return { ok: false, code: "compose_failed" };
      if (
        (c.head && plainSize(path.join(work, p.head)) === undefined) ||
        (c.tail && plainSize(path.join(work, p.tail)) === undefined)
      )
        return { ok: false, code: "compose_failed" };
    }
    // 4. Every transition (then its lossless pieces are no longer needed).
    for (const [i, c] of plan.clips.entries()) {
      if (!c.tail) continue;
      const code = await step(transitionArgs(plan, i), units.transitions[i]!, c.tail / FPS, local);
      if (code) return { ok: false, code };
      if (plainSize(path.join(work, `trans-${i}.mp4`)) === undefined)
        return { ok: false, code: "compose_failed" };
      fs.rmSync(path.join(work, pieces(i).tail), { force: true });
      fs.rmSync(path.join(work, pieces(i + 1).head), { force: true });
    }
    fs.writeFileSync(path.join(work, "list.ffconcat"), concatList(plan), { flag: "wx", mode: 0o600 });
    // 5. The sound: each clip's slice of its input's PCM (from the trim's start, sample-exact; silence where it has
    //    none), crossfaded where its picture is; the narration placed at its samples; the music — then one graph.
    try {
      await mixPcm(
        path.join(work, "bed.pcm"),
        plan.samples,
        plan.clips.flatMap((c) =>
          c.kind === "video" && c.hasAudio
            ? [
                {
                  file: path.join(work, sourcePcm(c.input)),
                  start: c.at * SPF,
                  length: c.frames * SPF,
                  fadeIn: c.head * SPF,
                  fadeOut: c.tail * SPF,
                  offset: Math.round(c.startSec * RATE),
                  take: Math.round(c.useSec * RATE),
                  gain: c.volume,
                },
              ]
            : [],
        ),
      );
      const narration: Track[] = plan.narration
        .filter((n) => n.maxSamples > 0)
        .map((n) => ({
          file: path.join(work, sourcePcm(n.input)),
          start: n.startSample,
          length: n.maxSamples,
          fadeIn: 0,
          fadeOut: 0,
        }));
      if (narration.length) await mixPcm(path.join(work, "narration.pcm"), plan.samples, narration);
      if (plan.music && !plainSize(path.join(work, sourcePcm(plan.music.input))))
        return { ok: false, code: "compose_failed" };
      const code = await step(
        audioArgs(plan, {
          narration: narration.length > 0,
          music: plan.music ? sourcePcm(plan.music.input) : null,
        }),
        units.audio,
        plan.samples / RATE,
        { read: [work], write: [work] },
      );
      if (code) return { ok: false, code };
    } catch {
      return { ok: false, code: "compose_failed" };
    }
    // 6. The file (the subtitles cut to the real length — `timedCues`).
    const subs = (t.subtitles ?? []).length ? toAss(t.subtitles ?? [], plan.frames / FPS) : null;
    const hasSubs = !!subs && subs.includes("\nDialogue:");
    // Review r4: every cue asked for is in the track (none lost to rounding) — else the result is not what was asked.
    const asked = (t.subtitles ?? []).filter((x) => cueText(x.text)).length;
    if (asked !== (subs?.split("\nDialogue:").length ?? 1) - 1)
      return { ok: false, code: "compose_verify_failed" };
    if (hasSubs) fs.writeFileSync(path.join(work, "subs.ass"), subs!, { flag: "wx", mode: 0o600 });
    const result = path.join(outDir, "result.mp4");
    const code = await step(
      muxArgs({ subtitles: hasSubs, out: result, maxBytes: COMPOSE_LIMITS.maxBytes }),
      units.mux,
      plan.frames / FPS,
      { read: [work], write: [outDir] },
    );
    const bytes = plainSize(result);
    if (bytes !== undefined && bytes > COMPOSE_LIMITS.maxBytes)
      return { ok: false, code: "compose_too_large" };
    if (code) return { ok: false, code };
    if (bytes === undefined) return { ok: false, code: "compose_failed" };
    // 7. The check (review R5): never only ffmpeg's exit status.
    const left = job.deadlineAt - Date.now();
    if (left <= 0) return { ok: false, code: "compose_timeout" };
    const v = await exec(tools.ffprobe, verifyArgs(result), {
      cwd: outDir,
      read: [outDir],
      write: [],
      timeoutMs: Math.min(left, COMPOSE_RUN_LIMITS.probeTimeoutMs),
      signal: job.signal,
      maxOutputBytes: 64 * 1024,
    });
    if (decodeVerdict(v) !== "ok" || !judgeResult(v!.stdout, plan, hasSubs))
      return { ok: false, code: "compose_verify_failed" };
    return { ok: true, file: result, bytes, plan };
  };

  const composer: Composer = {
    workdir: () => makeComposeWorkdir(o.dataDir),
    probe,
    compose,
    ready: (signal) => readyOf(composer, signal),
  };
  return composer;
}

/** `ready` of a composer: a 0.5 s 720×720 picture with a subtitle made and checked in a fresh job folder (removed). */
async function readyOf(c: Composer, signal?: AbortSignal): Promise<boolean> {
  let dir: string | undefined;
  try {
    dir = c.workdir();
    const file = path.join(dir, "in", "in-0.png");
    fs.writeFileSync(file, READY_PNG, { flag: "wx", mode: 0o600 });
    const p = await c.probe(file, "png", signal);
    if (!p.ok) return false;
    const r = await c.compose({
      dir,
      timeline: {
        output: { resolution: "720p", aspectRatio: "1:1" },
        clips: [{ fileId: "ready", durationSec: 0.5 }],
        subtitles: [{ startSec: 0, endSec: 0.4, text: "ok" }],
      },
      inputs: [{ ...p.info, fileId: "ready", name: "in-0.png" }],
      signal: signal ?? new AbortController().signal,
      deadlineAt: Date.now() + 120_000,
      onProgress: () => {},
    });
    return r.ok;
  } catch {
    return false;
  } finally {
    if (dir) removeComposeWorkdir(dir);
  }
}

/**
 * The FAKE_RUNTIME (e2e) and test composer — no program runs: inputs are taken by their kind (a video 2 s long with
 * sound, audio 2 s — the same "decoded" at the run), and the "composition" is the known-good MP4 after a few progress
 * steps (`stepMs` apart).
 */
export function fixtureComposer(
  dataDir: string,
  o: { stepMs?: number; outcome?: () => ComposeOutcome | undefined } = {},
): Composer {
  const composer: Composer = {
    workdir: () => makeComposeWorkdir(dataDir),
    async probe(file, fileKind) {
      const kind = inputKindOf(fileKind);
      if (!kind) return { ok: false, reason: "kind" };
      if (plainSize(file) === undefined) return { ok: false, reason: "failed" };
      return {
        ok: true,
        info: {
          fileKind,
          kind,
          durationSec: kind === "image" ? null : 2,
          hasVideo: kind !== "audio",
          hasAudio: kind !== "image",
          width: kind === "audio" ? null : 64,
          height: kind === "audio" ? null : 36,
        },
      };
    },
    async compose(job) {
      for (const f of [0.25, 0.5, 0.75]) {
        if (job.signal.aborted) return { ok: false, code: "compose_failed" };
        job.onProgress(f);
        await new Promise((r) => setTimeout(r, o.stepMs ?? 200));
      }
      const forced = o.outcome?.();
      if (forced && !forced.ok) return forced;
      // The lengths it was given stand for decoded ones.
      const plan = planTimeline(job.timeline, new Map(job.inputs.map((i) => [i.fileId, i])));
      if (isPlanError(plan))
        return {
          ok: false,
          code: plan.code === "compose_too_long" ? "compose_too_long" : "compose_timeline_mismatch",
        };
      const file = path.join(job.dir, "out", "result.mp4");
      fs.writeFileSync(file, KNOWN_GOOD_MP4, { flag: "wx", mode: 0o600 });
      return { ok: true, file, bytes: KNOWN_GOOD_MP4.length, plan };
    },
    ready: async () => true,
  };
  return composer;
}

/** A job id is a fresh UUID made with its folder (`workdir`). */
export const isJobName = (s: string) => JOB_NAME.test(s);
export const randomJobName = () => crypto.randomUUID();
