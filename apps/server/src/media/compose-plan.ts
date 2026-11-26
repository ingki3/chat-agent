import path from "node:path";
import {
  COMPOSE_LIMITS,
  composeFrame,
  type ComposeTimeline,
  type FileKind,
  type MediaToolCode,
} from "@agentlee/shared";

/**
 * 멀티미디어 합성's plan (#238 stage 4-1, docs/decisions/media-generation.md §15) — pure: no file is read and no program
 * runs here. From the validated timeline and what ffprobe said about the job's copies of its inputs, it works out every
 * number the composition uses — frames (30 per second) and samples (48 000 per second, 1600 per frame) — and builds every
 * ffmpeg argument list itself (the model only ever gives the timeline; review R1–R4):
 *
 * - **clips**: each one rendered once, at the output size and 30 fps, to exactly its frame count (`trim`/`tpad`/`loop`/
 *   `zoompan`, PTS from the frame number), split into its own frames only (`body`, the final H.264) and the frames a
 *   transition overlaps (`head`/`tail`, lossless FFV1) — and its sound to exactly frames × 1600 samples of PCM (silence
 *   without sound);
 * - **transitions**: one `xfade` of a clip's tail and the next clip's head (two small inputs, the same frame count): the
 *   overlap is a whole number of frames, shorter than both clips;
 * - **the picture** is then the bodies and transitions one after another (the concat demuxer, stream copy: every piece is
 *   the same encoder with the same settings), held on its last frame when the narration runs longer;
 * - **the sound**: the clips' PCM crossfaded where their pictures are, the narration placed at its samples (both mixed by
 *   `compose-run.ts`, sample-exact), then one ffmpeg graph — the clips' own sound and the music ducked under the
 *   narration (`sidechaincompress`), the music looped and faded, `loudnorm` — to AAC of exactly the picture's samples;
 * - **the file**: picture copied + AAC + the subtitles (ASS, `toAss`) as a `mov_text` track.
 */

export const FPS = COMPOSE_LIMITS.fps;
export const RATE = COMPOSE_LIMITS.sampleRate;
export const SPF = RATE / FPS;
/** Encoder and filter threads of every run (several jobs never run at once; this bounds one run's memory). */
export const FF_THREADS = 2;

export type InputKind = "image" | "video" | "audio";
const KIND_OF: Partial<Record<FileKind, InputKind>> = {
  png: "image",
  jpg: "image",
  webp: "image",
  mp4: "video",
  mp3: "audio",
  m4a: "audio",
  wav: "audio",
};
/** The demuxer each accepted kind is read with — named, never guessed from the bytes. */
export const DEMUXER: Partial<Record<FileKind, string>> = {
  png: "png_pipe",
  jpg: "jpeg_pipe",
  webp: "webp_pipe",
  mp4: "mov",
  mp3: "mp3",
  m4a: "mov",
  wav: "wav",
};
export const inputKindOf = (k: FileKind): InputKind | undefined => KIND_OF[k];

/** What ffprobe said about one input copy (`in/<name>`). */
export type InputInfo = {
  fileId: string;
  fileKind: FileKind;
  kind: InputKind;
  /** The copy's name in `in/` (server-made: `in-<n>.<kind>`). */
  name: string;
  /** Seconds (video, audio); null for an image. */
  durationSec: number | null;
  /**
   * Review r1: where its first sound stream ends, from the file's start (its own start and length — a video's sound
   * may be shorter than its picture); null without sound.
   */
  audioSec?: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number | null;
  height: number | null;
};

export type PlanClip = {
  input: string;
  fileKind: FileKind;
  kind: "image" | "video";
  frames: number;
  /** Video: where in the source it starts, and how many seconds of it are used (the rest holds its last frame). */
  startSec: number;
  useSec: number;
  fit: "letterbox" | "crop";
  kenBurns: "in" | "out" | "left" | "right" | null;
  volume: number;
  hasAudio: boolean;
  /**
   * Review r1: frames at its end that only hold its last picture (the last clip, held for the narration) — a Ken
   * Burns move ends at the clip's own length, then holds.
   */
  still?: number;
  /** Frames overlapped with the clip before (its transition) and after (this clip's transition). */
  head: number;
  tail: number;
  transition: string | null;
  /** Where its picture starts in the result (frames). */
  at: number;
};
export type PlanNarration = { input: string; fileKind: FileKind; startSample: number; maxSamples: number };
export type PlanMusic = {
  input: string;
  fileKind: FileKind;
  volume: number;
  loop: boolean;
  fadeInSec: number;
  fadeOutSec: number;
  duck: boolean;
};
export type Plan = {
  width: number;
  height: number;
  frames: number;
  samples: number;
  clips: PlanClip[];
  narration: PlanNarration[];
  music: PlanMusic | null;
  subtitles: number;
  /** Frames the last clip was held for the narration (user decision 4). */
  held: number;
};

export type PlanError = { code: MediaToolCode; hint: string };
export const isPlanError = (p: unknown): p is PlanError =>
  typeof p === "object" && p !== null && "code" in p && "hint" in p;

const err = (code: MediaToolCode, hint: string): PlanError => ({ code, hint });
const frames = (sec: number) => Math.round(sec * FPS);

/**
 * What can be judged from the timeline alone, before any file is touched (the tool's first answer): a transition on
 * the last clip, a trim that ends before it starts, subtitles out of order or overlapping.
 */
export function checkTimeline(t: ComposeTimeline): PlanError | null {
  const last = t.clips.length - 1;
  if (t.clips[last]!.transition)
    return err(
      "compose_invalid_timeline",
      `clips[${last}].transition: the last clip has no next clip to go into`,
    );
  for (const [i, c] of t.clips.entries())
    if (c.trim && c.trim.endSec <= c.trim.startSec)
      return err("compose_invalid_timeline", `clips[${i}].trim: endSec must be after startSec`);
  let prevEnd = 0;
  for (const [i, s] of (t.subtitles ?? []).entries()) {
    if (s.endSec <= s.startSec)
      return err("compose_invalid_timeline", `subtitles[${i}]: endSec must be after startSec`);
    if (s.startSec < prevEnd - 1e-9)
      return err(
        "compose_invalid_timeline",
        `subtitles[${i}]: starts before subtitles[${i - 1}] ends (in order, no overlap)`,
      );
    prevEnd = s.endSec;
  }
  return null;
}

/** The plan of a checked timeline over its probed inputs (by fileId), or why it does not hold. */
export function planTimeline(t: ComposeTimeline, inputs: ReadonlyMap<string, InputInfo>): Plan | PlanError {
  const early = checkTimeline(t);
  if (early) return early;
  const { width, height } = composeFrame(t.output?.resolution ?? "720p", t.output?.aspectRatio ?? "16:9");
  const clips: PlanClip[] = [];
  for (const [i, c] of t.clips.entries()) {
    const info = inputs.get(c.fileId);
    if (!info) return err("compose_input_missing", `clips[${i}].fileId`);
    const where = `clips[${i}]`;
    if (info.kind === "image") {
      if (c.durationSec === undefined)
        return err("compose_invalid_timeline", `${where}.durationSec: required for an image`);
      if (c.durationSec > 30 || c.durationSec < COMPOSE_LIMITS.minImageSeconds)
        return err("compose_invalid_timeline", `${where}.durationSec: an image shows 0.5–30 s`);
      if (c.trim) return err("compose_invalid_timeline", `${where}.trim: only for a video`);
      if (c.volume !== undefined)
        return err("compose_invalid_timeline", `${where}.volume: an image has no sound`);
      clips.push({
        input: info.name,
        fileKind: info.fileKind,
        kind: "image",
        frames: frames(c.durationSec),
        startSec: 0,
        useSec: 0,
        fit: c.fit ?? "letterbox",
        kenBurns: c.kenBurns ?? null,
        volume: 0,
        hasAudio: false,
        head: 0,
        tail: 0,
        transition: null,
        at: 0,
      });
      continue;
    }
    if (info.kind !== "video" || !info.hasVideo)
      return err(
        "compose_input_kind",
        `${where}.fileId: a clip is an image (png/jpg/webp) or a video (mp4/mov)`,
      );
    if (c.kenBurns) return err("compose_invalid_timeline", `${where}.kenBurns: only for an image`);
    const length = info.durationSec ?? 0;
    const start = c.trim?.startSec ?? 0;
    const end = c.trim ? Math.min(c.trim.endSec, length) : length;
    // Review r2: the start must be inside the source; whether the selection makes a frame is checked below.
    if (start >= length - 1e-6)
      return err(
        "compose_invalid_timeline",
        `${where}.trim.startSec: the video is ${length.toFixed(2)} s long`,
      );
    if (c.trim && c.trim.endSec > length + 0.05)
      return err(
        "compose_invalid_timeline",
        `${where}.trim.endSec: the video is ${length.toFixed(2)} s long`,
      );
    const source = end - start;
    const dur = c.durationSec ?? source;
    const n = frames(dur);
    // A video clip may be short (review r1): one frame at least — the 0.5 s minimum is an image's.
    if (n < 1) return err("compose_invalid_timeline", `${where}: a clip is at least one frame (1/30 s)`);
    clips.push({
      input: info.name,
      fileKind: info.fileKind,
      kind: "video",
      frames: n,
      startSec: start,
      useSec: Math.min(source, n / FPS),
      fit: c.fit ?? "letterbox",
      kenBurns: null,
      volume: c.volume ?? 1,
      hasAudio: info.hasAudio,
      head: 0,
      tail: 0,
      transition: null,
      at: 0,
    });
  }
  // Transitions (review R1): a whole number of frames, shorter than both clips. A clip between two transitions may be
  // all transition (review r1: its own part is then empty and left out).
  for (const [i, c] of t.clips.entries()) {
    if (!c.transition) continue;
    const d = frames(c.transition.durationSec);
    const a = clips[i]!;
    const b = clips[i + 1]!;
    if (d >= a.frames || d >= b.frames)
      return err(
        "compose_invalid_timeline",
        `clips[${i}].transition.durationSec: shorter than both clips it joins`,
      );
    a.tail = d;
    a.transition = c.transition.type;
    b.head = d;
  }
  for (const [i, c] of clips.entries())
    if (c.frames - c.head - c.tail < 0)
      return err(
        "compose_invalid_timeline",
        `clips[${i}]: its transitions in and out together must not be longer than the clip`,
      );
  let total = 0;
  for (const c of clips) {
    c.at = total - c.head;
    total = c.at + c.frames;
  }
  // Narration (user decision 4: longer than the pictures — the last one holds).
  const narration: PlanNarration[] = [];
  let needed = total;
  for (const [i, n] of (t.narration ?? []).entries()) {
    const info = inputs.get(n.fileId);
    if (!info) return err("compose_input_missing", `narration[${i}].fileId`);
    if (!info.hasAudio || info.kind === "image")
      return err("compose_input_kind", `narration[${i}].fileId: audio (mp3/m4a/wav) or a video with sound`);
    const startSample = Math.round(n.startSec * RATE);
    narration.push({
      input: info.name,
      fileKind: info.fileKind,
      startSample,
      maxSamples: COMPOSE_LIMITS.maxSeconds * RATE - startSample,
    });
    // Review r1: the sound's own end (a video's sound can be shorter than its picture).
    const sound = info.audioSec ?? info.durationSec ?? 0;
    needed = Math.max(needed, Math.ceil((n.startSec + sound) * FPS - 1e-6));
  }
  const max = COMPOSE_LIMITS.maxSeconds * FPS;
  if (needed > max || total > max)
    return err(
      "compose_too_long",
      `the video would be ${(Math.max(needed, total) / FPS).toFixed(1)} s (at most ${COMPOSE_LIMITS.maxSeconds})`,
    );
  const held = needed - total;
  if (held > 0) {
    const last = clips[clips.length - 1]!;
    last.frames += held;
    last.still = held;
  }
  total = needed;
  for (const n of narration) n.maxSamples = Math.max(0, total * SPF - n.startSample);
  let music: PlanMusic | null = null;
  if (t.music) {
    const info = inputs.get(t.music.fileId);
    if (!info) return err("compose_input_missing", "music.fileId");
    if (!info.hasAudio || info.kind === "image")
      return err("compose_input_kind", "music.fileId: audio (mp3/m4a/wav) or a video with sound");
    music = {
      input: info.name,
      fileKind: info.fileKind,
      volume: t.music.volume ?? 0.3,
      loop: t.music.loop ?? true,
      fadeInSec: t.music.fadeInSec ?? 0,
      fadeOutSec: t.music.fadeOutSec ?? 0,
      duck: t.music.duck ?? true,
    };
    if (music.fadeInSec + music.fadeOutSec > total / FPS)
      return err("compose_invalid_timeline", "music: fadeInSec + fadeOutSec are longer than the video");
  }
  const subs = t.subtitles ?? [];
  for (const [i, s] of subs.entries())
    if (s.endSec > total / FPS + 1e-6)
      return err(
        "compose_invalid_timeline",
        `subtitles[${i}].endSec: the video is ${(total / FPS).toFixed(2)} s long`,
      );
  return {
    width,
    height,
    frames: total,
    samples: total * SPF,
    clips,
    narration,
    music,
    subtitles: subs.length,
    held,
  };
}

// ---------------------------------------------------------------- subtitles

/** A cue's text as both tracks carry it: plain lines, no tags, no override codes, no cue arrow, no blank line. */
export function cueText(raw: string): string {
  return (
    raw
      .normalize("NFC")
      .replace(/\r\n?/g, "\n")
      // eslint-disable-next-line no-control-regex -- control characters are not part of a cue
      .replace(/[\0-\x09\x0b-\x1f\x7f-\x9f]/g, "")
      // Only real markup (`<b>`, `</i>`, `<font color=…>`, `<br>` …) is removed — a plain "<" or ">" is text (review r2).
      .replace(/<\/?(?:b|i|u|s|font|br)(?:\s[^<>]*)?\/?>/gi, "")
      // Only an override block (`{\an8}`, `{\i1}`) is control syntax; plain braces are text (review r1).
      .replace(/\{\\[^}]*\}/g, "")
      .replace(/\\/g, "＼")
      .replace(/-->/g, "→")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n")
  );
}

const clock = (sec: number, sep: "," | ".") => {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms % 1000, 3)}`;
};

type Cue = { startSec: number; endSec: number; text: string };
const cues = (subs: readonly Cue[]) =>
  subs.map((s) => ({ ...s, text: cueText(s.text) })).filter((s) => s.text);

/** ASS time: `H:MM:SS.cc`. */
const assClock = (sec: number) => {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360_000);
  const m = Math.floor((cs % 360_000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${h}:${p(m)}:${p(s)}.${p(cs % 100)}`;
};

/**
 * The subtitles the mux turns into the MP4's `mov_text` track (review r2): ASS, because its decoder takes text as it is
 * — "<", ">" and "&" are plain characters there (ffmpeg's SRT decoder drops anything that looks like a tag, its WebVTT
 * decoder mangles braces). The cue text has no backslash (`cueText`) and no override block, so nothing in it is ASS
 * syntax; its lines are joined with ASS's own line break.
 */
export function toAss(subs: readonly Cue[]): string {
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    "PlayResX: 384",
    "PlayResY: 288",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,Arial,16,&Hffffff,&Hffffff,&H0,&H0,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,0",
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...cues(subs).map(
      (s) =>
        `Dialogue: 0,${assClock(s.startSec)},${assClock(s.endSec)},Default,,0,0,0,,${s.text.split("\n").join("\\N")}`,
    ),
    "",
  ].join("\n");
}

/** The WebVTT of the card's player (`<track>`): the same cues, `&`, `<` and `>` escaped. */
export function toVtt(subs: readonly Cue[]): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return (
    "WEBVTT\n\n" +
    cues(subs)
      .map((s) => `${clock(s.startSec, ".")} --> ${clock(s.endSec, ".")}\n${esc(s.text)}\n`)
      .join("\n")
  );
}

// ---------------------------------------------------------------- ffmpeg argument lists

const num = (n: number) => String(Math.round(n * 1e6) / 1e6);
/** Every run: no stdin, quiet, local files and the progress pipe only, the filter threads bounded. */
export const FF_COMMON = [
  "-nostdin",
  "-hide_banner",
  "-nostats",
  "-v",
  "error",
  "-filter_threads",
  "1",
  "-filter_complex_threads",
  "1",
];
const input = (o: { demuxer: string; file: string; before?: string[] }) => [
  "-protocol_whitelist",
  "file,pipe",
  "-threads",
  String(FF_THREADS),
  ...(o.before ?? []),
  "-f",
  o.demuxer,
  "-i",
  o.file,
];
/** The one H.264 setting of every picture piece (the concat copies them: they must be alike — review R4). */
export const H264 = [
  "-c:v",
  "libx264",
  "-preset",
  "veryfast",
  "-crf",
  "20",
  "-pix_fmt",
  "yuv420p",
  "-profile:v",
  "high",
  "-level:v",
  "4.1",
  "-g",
  "60",
  "-sc_threshold",
  "0",
  "-threads",
  String(FF_THREADS),
  "-r",
  String(FPS),
  "-video_track_timescale",
  "15360",
  "-an",
  "-sn",
  "-dn",
  "-map_metadata",
  "-1",
  "-f",
  "mp4",
];
const LOSSLESS = ["-c:v", "ffv1", "-threads", String(FF_THREADS), "-an", "-sn", "-dn", "-f", "nut"];
const PCM = ["-c:a", "pcm_s16le", "-ar", String(RATE), "-ac", "2", "-vn", "-sn", "-dn", "-f", "s16le"];
const PROGRESS = ["-progress", "pipe:1"];

/** The file names of a clip's pieces in `work/`. */
export const pieces = (i: number) => ({
  body: `body-${i}.mp4`,
  head: `head-${i}.nut`,
  tail: `tail-${i}.nut`,
  audio: `clip-${i}.pcm`,
});

/** The picture and sound of one clip: its pieces and its PCM (cwd `work/`; the input in `../in/`). */
export function clipArgs(plan: Plan, i: number, inDir: string): string[] {
  const c = plan.clips[i]!;
  const { width: W, height: H } = plan;
  const N = c.frames;
  const p = pieces(i);
  const file = path.join(inDir, c.input);
  // Square pixels first (review r1: a 720×576 picture with SAR 64:45 is 16:9 on screen), then letterbox or crop.
  const square = "scale=w='trunc(iw*sar/2)*2':h=ih,setsar=1";
  const fit = (w: number, h: number) =>
    c.fit === "crop"
      ? `scale=${w}:${h}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${w}:${h}`
      : `scale=${w}:${h}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`;
  const exact = `trim=end_frame=${N},settb=1/${FPS},setpts=N,fps=${FPS}`;
  // Review r2: an image's transparent parts are black (its colour multiplied by its alpha) — never the hidden colour
  // under them.
  const opaque = "format=rgba,premultiply=inplace=1";
  let picture: string;
  if (c.kind === "image") {
    // A Ken Burns move takes the clip's own frames; frames held for the narration repeat its last one (review r1).
    const still = c.still ?? 0;
    const moving = N - still;
    const last = Math.max(1, moving - 1);
    const kb: Record<NonNullable<PlanClip["kenBurns"]>, string> = {
      in: `z='1+0.15*on/${last}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
      out: `z='1.15-0.15*on/${last}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`,
      left: `z='1.15':x='(iw-iw/zoom)*(1-on/${last})':y='ih/2-(ih/zoom/2)'`,
      right: `z='1.15':x='(iw-iw/zoom)*on/${last}':y='ih/2-(ih/zoom/2)'`,
    };
    picture = c.kenBurns
      ? `[0:v]trim=end_frame=1,${opaque},${square},${fit(W * 2, H * 2)},setsar=1,format=yuv420p,zoompan=${kb[c.kenBurns]}:d=${moving}:s=${W}x${H}:fps=${FPS},tpad=stop_mode=clone:stop=-1,${exact}`
      : `[0:v]trim=end_frame=1,${opaque},${square},${fit(W, H)},setsar=1,format=yuv420p,loop=loop=${N - 1}:size=1:start=0,${exact}`;
  } else {
    // The trim on one timeline (reviews r1–r2). The input is opened at the keyframe before the trim's start (`-ss`
    // without accurate seeking), and the trim's start is 0 for picture and sound alike. The picture: its last frame
    // repeated past its end (a picture that ends before the trim's start, or inside it, holds), then 30 fps from 0 —
    // each slot shows the frame on screen at that moment, also the one already showing at the start (a slide of a
    // 1 fps video) and the first one when the picture starts late —, the trim's own frames, then held to the clip's
    // length. The sound: cut exactly at the trim (0 … its length), silence before a sound that starts late.
    const own = Math.max(1, Math.round(c.useSec * FPS));
    picture =
      `[0:v]tpad=stop_mode=clone:stop=-1,fps=${FPS}:start_time=0,trim=end_frame=${own},` +
      `${square},${fit(W, H)},setsar=1,format=yuv420p,tpad=stop_mode=clone:stop=-1,${exact}`;
  }
  const outs: { label: string; from: number; to: number; args: string[] }[] = [];
  if (c.head) outs.push({ label: "hv", from: 0, to: c.head, args: [...LOSSLESS, p.head] });
  // A clip that is all transition (review r1) has no body of its own.
  if (N - c.head - c.tail > 0)
    outs.push({ label: "bv", from: c.head, to: N - c.tail, args: [...H264, p.body] });
  if (c.tail) outs.push({ label: "tv", from: N - c.tail, to: N, args: [...LOSSLESS, p.tail] });
  const graph = [
    outs.length === 1
      ? `${picture}[s0]`
      : `${picture},split=${outs.length}${outs.map((_, k) => `[s${k}]`).join("")}`,
    ...outs.map((o, k) => `[s${k}]trim=start_frame=${o.from}:end_frame=${o.to},setpts=N[${o.label}]`),
    c.kind === "video" && c.hasAudio
      ? `[0:a:0]atrim=start=0:end=${num(Math.max(c.useSec, 1 / FPS))},aresample=${RATE}:async=1:first_pts=0,aformat=sample_fmts=s16:channel_layouts=stereo,volume=${num(c.volume)},apad,atrim=end_sample=${N * SPF}[a]`
      : `anullsrc=r=${RATE}:cl=stereo,atrim=end_sample=${N * SPF},aformat=sample_fmts=s16[a]`,
  ].join(";");
  // No input duration: the graph's trims end the run (an input `-t` would also cut what precedes the seek point).
  const seek = c.kind === "video" ? ["-noaccurate_seek", "-ss", num(c.startSec)] : [];
  return [
    ...FF_COMMON,
    ...PROGRESS,
    ...input({ demuxer: DEMUXER[c.fileKind]!, file, before: seek }),
    "-filter_complex",
    graph,
    ...outs.flatMap((o) => ["-map", `[${o.label}]`, ...o.args]),
    "-map",
    "[a]",
    ...PCM,
    p.audio,
  ];
}

/** The transition from clip `i` into clip `i + 1`: their tail and head through `xfade`, the final H.264. */
export function transitionArgs(plan: Plan, i: number): string[] {
  const c = plan.clips[i]!;
  const d = c.tail;
  return [
    ...FF_COMMON,
    ...PROGRESS,
    ...input({ demuxer: "nut", file: pieces(i).tail }),
    ...input({ demuxer: "nut", file: pieces(i + 1).head }),
    "-filter_complex",
    `[0:v]settb=1/${FPS},setpts=N,fps=${FPS}[x];[1:v]settb=1/${FPS},setpts=N,fps=${FPS}[y];` +
      `[x][y]xfade=transition=${c.transition}:duration=${num(d / FPS)}:offset=0,trim=end_frame=${d},setpts=N[v]`,
    "-map",
    "[v]",
    ...H264,
    `trans-${i}.mp4`,
  ];
}

/** The pieces of the picture in order (the concat demuxer's list, names in `work/`). */
export function concatList(plan: Plan): string {
  const names: string[] = [];
  for (const [i, c] of plan.clips.entries()) {
    if (c.frames - c.head - c.tail > 0) names.push(pieces(i).body);
    if (c.tail) names.push(`trans-${i}.mp4`);
  }
  return `ffconcat version 1.0\n${names.map((n) => `file '${n}'`).join("\n")}\n`;
}

/** One narration or the music decoded to PCM (48 kHz stereo s16, at most `maxSamples`). */
export function decodeArgs(o: {
  inDir: string;
  input: string;
  fileKind: FileKind;
  maxSamples: number;
  out: string;
}): string[] {
  return [
    ...FF_COMMON,
    ...input({ demuxer: DEMUXER[o.fileKind]!, file: path.join(o.inDir, o.input) }),
    "-map",
    "0:a:0",
    "-af",
    `aresample=${RATE}:async=1:first_pts=0,aformat=sample_fmts=s16:channel_layouts=stereo,atrim=end_sample=${Math.max(1, o.maxSamples)}`,
    ...PCM,
    o.out,
  ];
}

const RAW = ["-f", "s16le", "-ar", String(RATE), "-ac", "2"];
const DUCK = "sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400";

/**
 * The sound (review R3): the clips' PCM (`bed.pcm`), the narration (`narration.pcm`, when there is any) and the music
 * (`music.pcm`) mixed — the clips' own sound always ducked under the narration, the music when `duck` — loudness-
 * normalised and encoded to AAC of exactly `plan.samples`.
 */
export function audioArgs(plan: Plan, o: { narration: boolean; music: boolean }): string[] {
  const T = plan.samples;
  const m = plan.music;
  const duckMusic = !!(o.music && m?.duck && o.narration);
  const ins: string[] = ["-protocol_whitelist", "file,pipe", ...RAW, "-i", "bed.pcm"];
  const graph: string[] = [];
  const mix: string[] = [];
  let k = 1;
  if (o.narration) {
    ins.push("-protocol_whitelist", "file,pipe", ...RAW, "-i", "narration.pcm");
    const taps = 2 + (duckMusic ? 1 : 0);
    graph.push(`[${k}:a]asplit=${taps}[nar][scb]${duckMusic ? "[scm]" : ""}`);
    graph.push(`[0:a][scb]${DUCK}[bed]`);
    mix.push("[bed]", "[nar]");
    k++;
  } else {
    graph.push("[0:a]anull[bed]");
    mix.push("[bed]");
  }
  if (o.music && m) {
    ins.push(
      "-protocol_whitelist",
      "file,pipe",
      ...(m.loop ? ["-stream_loop", "-1"] : []),
      ...RAW,
      "-i",
      "music.pcm",
    );
    const fades = [
      ...(m.fadeInSec > 0 ? [`afade=t=in:st=0:d=${num(m.fadeInSec)}`] : []),
      ...(m.fadeOutSec > 0
        ? [`afade=t=out:st=${num(Math.max(0, T / RATE - m.fadeOutSec))}:d=${num(m.fadeOutSec)}`]
        : []),
    ];
    graph.push(
      `[${k}:a]apad,atrim=end_sample=${T},volume=${num(m.volume)}${fades.map((f) => `,${f}`).join("")}${duckMusic ? "[m0]" : "[mus]"}`,
    );
    if (duckMusic) graph.push(`[m0][scm]${DUCK}[mus]`);
    mix.push("[mus]");
  }
  // loudnorm needs 3 s to measure: a shorter (or silent) sound is padded first (else it gives NaN), then cut back.
  const tail = `apad=whole_len=${Math.max(T, 3 * RATE)},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=${RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end_sample=${T}[out]`;
  graph.push(
    mix.length === 1
      ? `${mix[0]}${tail}`
      : `${mix.join("")}amix=inputs=${mix.length}:normalize=0:duration=first:dropout_transition=0,${tail}`,
  );
  return [
    ...FF_COMMON,
    ...PROGRESS,
    ...ins,
    "-filter_complex",
    graph.join(";"),
    "-map",
    "[out]",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-threads",
    String(FF_THREADS),
    "-vn",
    "-sn",
    "-dn",
    "-map_metadata",
    "-1",
    "-f",
    "mp4",
    "audio.m4a",
  ];
}

/** The file: the picture's pieces copied in order, the AAC, the subtitles as `mov_text` (cwd `work/`). */
export function muxArgs(o: { subtitles: boolean; out: string; maxBytes: number }): string[] {
  return [
    ...FF_COMMON,
    ...PROGRESS,
    "-protocol_whitelist",
    "file,pipe",
    "-f",
    "concat",
    "-safe",
    "1",
    "-i",
    "list.ffconcat",
    "-protocol_whitelist",
    "file,pipe",
    "-f",
    "mov",
    "-i",
    "audio.m4a",
    ...(o.subtitles ? ["-protocol_whitelist", "file,pipe", "-f", "ass", "-i", "subs.ass"] : []),
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    ...(o.subtitles ? ["-map", "2:s:0", "-c:s", "mov_text", "-metadata:s:s:0", "language=kor"] : []),
    "-c:v",
    "copy",
    "-c:a",
    "copy",
    "-map_metadata",
    "-1",
    "-map_chapters",
    "-1",
    "-movflags",
    "+faststart",
    "-fs",
    String(o.maxBytes + 1),
    "-f",
    "mp4",
    o.out,
  ];
}

/** ffprobe of one input copy: its container, streams, sizes and length (JSON). */
export function probeArgs(file: string, fileKind: FileKind): string[] {
  return [
    "-v",
    "error",
    "-hide_banner",
    "-protocol_whitelist",
    "file,pipe",
    "-f",
    DEMUXER[fileKind]!,
    "-show_entries",
    "format=format_name,duration,start_time:stream=codec_type,codec_name,width,height,duration,start_time:stream_disposition=attached_pic",
    "-of",
    "json",
    file,
  ];
}

/** ffprobe of the result (review R5): container, brand, streams, the picture's packets (one per frame), lengths. */
export function verifyArgs(file: string): string[] {
  return [
    "-v",
    "error",
    "-hide_banner",
    "-protocol_whitelist",
    "file,pipe",
    "-count_packets",
    "-show_entries",
    "format=format_name,duration:format_tags=major_brand:stream=codec_type,codec_name,nb_read_packets,duration,width,height:stream_disposition=attached_pic",
    "-of",
    "json",
    file,
  ];
}

/** How the stages weigh in the progress bar: each clip's and transition's frames, then the sound and the mux. */
export function workUnits(plan: Plan): {
  clips: number[];
  transitions: number[];
  audio: number;
  mux: number;
} {
  return {
    clips: plan.clips.map((c) => c.frames),
    transitions: plan.clips.map((c) => c.tail * 2),
    audio: Math.max(30, Math.round(plan.frames / 10)),
    mux: Math.max(30, Math.round(plan.frames / 20)),
  };
}
