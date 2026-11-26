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
 * runs here. From the validated timeline and the lengths of the job's copies of its inputs, it works out every number
 * the composition uses — frames (30 per second) and samples (48 000 per second, 1600 per frame) — and builds every
 * ffmpeg argument list itself (the model only ever gives the timeline; review R1–R4):
 *
 * - **clips**: each one rendered once, at the output size and 30 fps, to exactly its frame count (`trim`/`tpad`/`loop`/
 *   `zoompan`, PTS from the frame number), split into its own frames only (`body`, the final H.264) and the frames a
 *   transition overlaps (`head`/`tail`, lossless FFV1); its sound is a slice of its input's PCM (below);
 * - **lengths are decoded, never read from metadata** (the re-plan after review r3): when the tool is called the lengths
 *   are ffprobe's estimates (the call's answer and its 5-minute check); when the job runs, each input is decoded once
 *   from its start (`ingestArgs`, no input seeking) — its sound to 48 kHz PCM from the container's start (the sample
 *   count is its length), its picture counted at 30 fps from the same start — and the plan is made again from those;
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
  /**
   * Its length in seconds (video, audio — the later of its picture's and its sound's end); null for an image. When the
   * tool is called: ffprobe's estimate; when the job runs: decoded (`ingestArgs`).
   */
  durationSec: number | null;
  /** Where its sound ends, from the file's start (estimated, then decoded); null without sound. */
  audioSec?: number | null;
  /**
   * Review r5 (restored in r8): an MP4/MOV's presentation 0 on its `-copyts` timeline (seconds) — the earliest first
   * sample of its picture and sound tracks, a track with an edit list counting from the movie's 0 — so a codec's
   * reorder delay without an edit list (a B-frame MP4 whose only track's first picture is at 0.0667 s) is not taken for
   * a gap, and sound that starts before the first picture is kept. 0 when there is nothing to take away; never negative
   * (a preroll before 0 is cut).
   */
  originSec?: number;
  /**
   * Review r8: an MP4/MOV's first picture and sound tracks as the file describes them (`mp4Timeline`; without an edit
   * list, its samples' own end where ffprobe says one). Every graph reads them through `presentTrack` only.
   */
  videoTrack?: TrackEdit | null;
  audioTrack?: TrackEdit | null;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number | null;
  height: number | null;
};

/**
 * Review r8: one MP4/MOV track as its file describes it. With an edit list (re-plan 2: at most a leading empty edit,
 * then one media edit at rate 1): nothing until `lead` (movie seconds), then its media from `mediaTime` (its own
 * seconds) to `end` on the movie's timeline (null: a fragmented file's, not known up front). Without one: its samples
 * at their own times, to `end` when known (ffprobe's start + duration of a sound track — review r4) — else to its last
 * sample's end.
 */
export type TrackEdit = { edited: boolean; lead: number; mediaTime: number; end: number | null };

/**
 * Review r8: how one track is presented on its input's timeline (seconds from `InputInfo.originSec`) — the only source
 * of every ingest and clip graph's mapping, for picture and sound alike:
 *
 * - `shift`: added to a sample's time as decoded (`-copyts -ignore_editlist`) to give its time on that timeline;
 * - `start`: nothing of the track before it — silence, black (a leading empty edit's end) — cut whatever the shift (a
 *   sample before its edit's media time lands before it; a picture's sample already on screen at that time comes in
 *   at it);
 * - `end`: nothing after it, cut on that timeline before any trim of the clip (null: its last sample's end).
 */
export type TrackPresentation = { shift: number; start: number; end: number | null };

export function presentTrack(track: TrackEdit | null | undefined, originSec = 0): TrackPresentation {
  const o = originSec;
  if (!track) return { shift: 0 - o, start: 0, end: null };
  if (!track.edited) return { shift: 0 - o, start: 0, end: track.end != null ? track.end - o : null };
  return {
    shift: track.lead - track.mediaTime - o,
    start: Math.max(0, track.lead - o),
    end: track.end != null ? track.end - o : null,
  };
}

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
  /** Review r8: its picture track's presentation (`presentTrack`), on its input's timeline. */
  picture?: TrackPresentation;
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

/**
 * A clip's frames when the timeline alone says it (an image's `durationSec`, a video's `durationSec` or trim) — null
 * when it is the video's own length (known only once decoded).
 */
const statedFrames = (c: ComposeTimeline["clips"][number], kind: InputKind): number | null =>
  kind === "image"
    ? frames(c.durationSec ?? 0)
    : c.durationSec !== undefined
      ? frames(c.durationSec)
      : c.trim
        ? frames(c.trim.endSec - c.trim.startSec)
        : null;

/**
 * What the call can judge without any media length (review r4 — every length-dependent judgement waits for the run's
 * decoded lengths, `planTimeline`): the timeline's own rules (`checkTimeline`), every fileId an input of a kind for its
 * place, the options of its kind (an image's 0.5–30 s, no trim or volume; no Ken Burns on a video), transitions against
 * the lengths the timeline states, and the 5-minute cap when every clip's length is stated.
 */
export function checkInputs(t: ComposeTimeline, inputs: ReadonlyMap<string, InputInfo>): PlanError | null {
  const early = checkTimeline(t);
  if (early) return early;
  const stated: (number | null)[] = [];
  for (const [i, c] of t.clips.entries()) {
    const info = inputs.get(c.fileId);
    const where = `clips[${i}]`;
    if (!info) return err("compose_input_missing", `${where}.fileId`);
    if (info.kind === "image") {
      if (c.durationSec === undefined)
        return err("compose_invalid_timeline", `${where}.durationSec: required for an image`);
      if (c.durationSec > 30 || c.durationSec < COMPOSE_LIMITS.minImageSeconds)
        return err("compose_invalid_timeline", `${where}.durationSec: an image shows 0.5–30 s`);
      if (c.trim) return err("compose_invalid_timeline", `${where}.trim: only for a video`);
      if (c.volume !== undefined)
        return err("compose_invalid_timeline", `${where}.volume: an image has no sound`);
    } else {
      if (info.kind !== "video" || !info.hasVideo)
        return err(
          "compose_input_kind",
          `${where}.fileId: a clip is an image (png/jpg/webp) or a video (mp4/mov)`,
        );
      if (c.kenBurns) return err("compose_invalid_timeline", `${where}.kenBurns: only for an image`);
      const n = statedFrames(c, "video");
      if (n !== null && n < 1)
        return err("compose_invalid_timeline", `${where}: a clip is at least one frame (1/30 s)`);
    }
    stated.push(statedFrames(c, info.kind));
  }
  // The clips' total when every length is stated (else null: judged at the run).
  let total: number | null = 0;
  for (const [i, c] of t.clips.entries()) {
    const a = stated[i] ?? null;
    total = total === null || a === null ? null : total + a;
    if (!c.transition) continue;
    const d = frames(c.transition.durationSec);
    const b = stated[i + 1] ?? null;
    if ((a !== null && d >= a) || (b !== null && d >= b))
      return err(
        "compose_invalid_timeline",
        `clips[${i}].transition.durationSec: shorter than both clips it joins`,
      );
    if (total !== null) total -= d;
  }
  // A clip between two transitions must hold both (review r5: three 1 s images with two 0.7 s transitions).
  for (const [i, c] of t.clips.entries()) {
    const n = stated[i] ?? null;
    const into = i > 0 && t.clips[i - 1]!.transition ? frames(t.clips[i - 1]!.transition!.durationSec) : 0;
    const out = c.transition ? frames(c.transition.durationSec) : 0;
    if (n !== null && into + out > n)
      return err(
        "compose_invalid_timeline",
        `clips[${i}]: its transitions in and out together must not be longer than the clip`,
      );
  }
  if (total !== null && total > COMPOSE_LIMITS.maxSeconds * FPS)
    return err(
      "compose_too_long",
      `the clips are ${(total / FPS).toFixed(1)} s (at most ${COMPOSE_LIMITS.maxSeconds})`,
    );
  for (const [i, n] of (t.narration ?? []).entries()) {
    const info = inputs.get(n.fileId);
    if (!info) return err("compose_input_missing", `narration[${i}].fileId`);
    if (!info.hasAudio || info.kind === "image")
      return err("compose_input_kind", `narration[${i}].fileId: audio (mp3/m4a/wav) or a video with sound`);
  }
  if (t.music) {
    const info = inputs.get(t.music.fileId);
    if (!info) return err("compose_input_missing", "music.fileId");
    if (!info.hasAudio || info.kind === "image")
      return err("compose_input_kind", "music.fileId: audio (mp3/m4a/wav) or a video with sound");
  }
  return null;
}

/**
 * The plan of a timeline over its inputs' lengths (by fileId) — the run's decoded ones (an estimate when the call shows
 * one) — or why it does not hold: every length-dependent rule is judged here (the 5-minute cap, trims, transitions,
 * fades and subtitles against the real lengths). A trim that ends past its picture holds the last frame.
 */
export function planTimeline(t: ComposeTimeline, inputs: ReadonlyMap<string, InputInfo>): Plan | PlanError {
  const early = checkInputs(t, inputs);
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
    // A trim is its own length (review r4: what lies past the picture's end holds its last frame, silence after the
    // sound's) — never cut to a length.
    const end = c.trim ? c.trim.endSec : length;
    // Review r2: the start must be inside the source; whether the selection makes a frame is checked below.
    if (start >= length - 1e-6)
      return err(
        "compose_invalid_timeline",
        `${where}.trim.startSec: the video is ${length.toFixed(2)} s long`,
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
      picture: presentTrack(info.videoTrack, info.originSec ?? 0),
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

/**
 * A cue's text (review r3, r5): the text as given — NFC, line breaks as "\n", control characters (not tabs) out — and
 * nothing else changed (indentation, blank lines, trailing whitespace stay). Each format escapes only its own syntax (`toAss`,
 * `toVtt`).
 */
export function cueText(raw: string): string {
  const text = raw
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    // A tab is text (review r4: "항목\t값"); other control characters are not part of a cue.
    // eslint-disable-next-line no-control-regex -- control characters are not part of a cue
    .replace(/[\0-\x08\x0b-\x1f\x7f-\x9f]/g, "");
  // Indentation, blank lines and trailing whitespace stay (review r5); only a text of nothing but whitespace is none.
  return text.trim() ? text : "";
}

type Cue = { startSec: number; endSec: number; text: string };
type Timed = { start: number; end: number; text: string };

/**
 * Cues in whole `unit`s (ASS: 1/100 s, VTT: 1/1000 s — reviews r3–r5): each keeps a positive length after rounding
 * (at least one unit), none starts before the one before it ended, and none goes past the video's end (`totalSec`:
 * the real length worked out at the run, rounded up to a unit — a cue starting at or after it is left out, one ending
 * after it is cut). Each cue keeps room for the ones after it, so rounding never drops one.
 */
export function timedCues(subs: readonly Cue[], unit: number, totalSec?: number): Timed[] {
  // The video's end in whole units, rounded up (review r5: a cue inside a 31-frame video's last unit is inside it).
  const total = totalSec === undefined ? Infinity : Math.ceil(totalSec * unit - 1e-9);
  const kept = subs
    .map((s) => ({ ...s, text: cueText(s.text) }))
    .filter((s) => s.text && (totalSec === undefined || s.startSec < totalSec));
  const out: Timed[] = [];
  let prev = 0;
  for (const [k, s] of kept.entries()) {
    // Room for every cue after this one: one unit each before the end (review r5 — a cue is never squeezed out by
    // rounding; it takes its unit from the cue before it).
    const last = total - (kept.length - 1 - k);
    const start = Math.min(Math.max(Math.round(s.startSec * unit), prev), last - 1);
    const end = Math.min(Math.max(Math.round(s.endSec * unit), start + 1), last);
    if (start < prev || end <= start) continue;
    out.push({ start, end, text: s.text });
    prev = end;
  }
  return out;
}

const clock = (units: number, unit: 100 | 1000) => {
  const h = Math.floor(units / (3600 * unit));
  const m = Math.floor((units % (3600 * unit)) / (60 * unit));
  const s = Math.floor((units % (60 * unit)) / unit);
  const f = units % unit;
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return unit === 100 ? `${h}:${p(m)}:${p(s)}.${p(f)}` : `${p(h)}:${p(m)}:${p(s)}.${p(f, 3)}`;
};

/** U+2060 WORD JOINER: invisible, it keeps ASS from reading a backslash sequence or an override block. */
const WJ = "\u2060";

/**
 * A cue's text as ASS dialogue (review r3): only what ASS itself would interpret is neutralised — a backslash before
 * N, n or h (line breaks, a hard space) and a "{" that opens an override block ("{\") get an invisible word joiner
 * between; every other character is kept ("C:\temp", "A --> B", "<b>", "&", "{1, 2}"). Lines are joined with ASS's own
 * break.
 */
export function assText(text: string): string {
  const body = text
    .split("\n")
    .map((l) => l.replace(/\\([Nnh])/g, `\\${WJ}$1`).replace(/\{\\/g, `{${WJ}\\`))
    .join("\\N");
  // ASS drops whitespace at the start of a dialogue's text: an invisible word joiner keeps the indentation (review r5).
  return /^\s/.test(body) ? `${WJ}${body}` : body;
}

/**
 * The subtitles the mux turns into the MP4's `mov_text` track (review r2): ASS, because its decoder takes text as it is
 * — "<", ">" and "&" are plain characters there (ffmpeg's SRT decoder drops anything that looks like a tag, its WebVTT
 * decoder mangles braces).
 */
export function toAss(subs: readonly Cue[], totalSec?: number): string {
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
    ...timedCues(subs, 100, totalSec).map(
      (c) => `Dialogue: 0,${clock(c.start, 100)},${clock(c.end, 100)},Default,,0,0,0,,${assText(c.text)}`,
    ),
    "",
  ].join("\n");
}

/**
 * The WebVTT of the card's player (`<track>`): the same cues, the text as given with "&", "<" and ">" as entities (so
 * a "-->" in it is "--&gt;" — never a cue timing).
 */
export function toVtt(subs: readonly Cue[], totalSec?: number): string {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return (
    "WEBVTT\n\n" +
    timedCues(subs, 1000, totalSec)
      .map(
        (c) =>
          // A blank line would end the cue: it carries an invisible word joiner instead (review r5).
          `${clock(c.start, 1000)} --> ${clock(c.end, 1000)}\n${c.text
            .split("\n")
            .map((l) => (l.trim() ? esc(l) : `${esc(l)}${WJ}`))
            .join("\n")}\n`,
      )
      .join("\n")
  );
}

// ---------------------------------------------------------------- ffmpeg argument lists

const num = (n: number) => String(Math.round(n * 1e6) / 1e6);
/** "+0.4" / "-2": an offset added to a timestamp expression. */
const signed = (n: number) => (n < 0 ? `-${num(-n)}` : `+${num(n)}`);
/**
 * Review r9: the pictures' timebase — 1/3 000 000 s holds every 30 fps slot (k/30 = 100 000·k) and the frames of the
 * usual track timescales (1/15360 at 30 fps, 1/90000, 1/600, 1/1000, 1/30000…) as whole ticks. Each shift and cut is a
 * whole number of these ticks (one rounding each): rounded to microseconds instead, a frame at k/30 moved by 1/30
 * could land 1 µs after its slot, and the canvas would show the frame before it.
 */
const PICTURE_TB = 3_000_000;
const ticks = (sec: number) => Math.round(sec * PICTURE_TB);
const tickShift = (sec: number) => {
  const n = ticks(sec);
  return n === 0 ? "" : `,setpts=PTS${n < 0 ? "-" : "+"}${Math.abs(n)}`;
};
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
/**
 * One input, read from its start (never an input seek — re-plan r3), with its demuxer named. An MP4/MOV keeps its
 * presentation timeline (review r4: `-copyts` — ffmpeg would otherwise shift it so the earliest stream starts at 0,
 * dropping a leading empty edit): its 0 is the movie's 0, the same origin for the ingest and every clip, picture and
 * sound; what lies before 0 (a negative preroll, AAC priming) is cut by the graph.
 */
const input = (o: { demuxer: string; file: string }) => [
  // Review r7: its edit list is not applied by the demuxer (that drops the sample already showing at an edit's start);
  // this server maps it itself (`presentTrack`), the same way for the ingest and every clip.
  ...(o.demuxer === "mov" ? ["-copyts", "-ignore_editlist", "1"] : []),
  "-protocol_whitelist",
  "file,pipe",
  "-threads",
  String(FF_THREADS),
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
});

/** The picture of one clip: its pieces (cwd `work/`; the input in `../in/`). Its sound is its input's PCM. */
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
    // The trim on the file's presentation timeline (re-plan r3, review r4). Decoded from its start (no input seeking —
    // a seek to the picture's keyframe would skip sound and frames before it), the picture is laid on a black 30 fps
    // canvas from the timeline's 0 (`overlay`): each slot shows the frame on screen at that moment — the one already
    // showing at the trim's start, nothing (black) before the first frame (a leading empty edit, a picture that
    // starts late), the last one repeated after the picture ends. A picture with alpha (ProRes 4444, QuickTime
    // Animation) is blended over that black by the overlay itself. Then the trim's frames by number, the output size,
    // and held to the clip's length. The graph's trim ends the run (nothing after it is decoded).
    // The canvas starts at the trim's start (review r5): its first slot shows the source frame on screen at that very
    // moment (a frame that began before it), and every later slot samples the source at start + k/30.
    const own = Math.max(1, Math.round(c.useSec * FPS));
    const at = c.picture ?? presentTrack(null);
    const leadIn = at.start - c.startSec;
    // The canvas is the output's size (no frame of the source is kept for its size — review r5: a reference branch
    // buffered every frame before the start); the picture is fitted to it first, its alpha kept for the overlay.
    picture =
      // Fine timebase first (re-plan 2: a 1 s MOV timescale would round the shift), then the track's presentation
      // (`presentTrack`): mapped to its input's timeline and cut at its end there — before the clip's trim (review r8:
      // a trim after that end shows the last frame allowed, held, never one the edit leaves out) — then the trim.
      // Review r9: all of it in whole ticks of `PICTURE_TB`.
      `[0:v]settb=1/${PICTURE_TB}${tickShift(at.shift)}` +
      `${at.end != null ? `,trim=end_pts=${Math.max(1, ticks(at.end))}` : ""}` +
      `${tickShift(-c.startSec)},` +
      `${square},${fit(W, H)},setsar=1,format=yuva420p[src];` +
      `color=c=black:s=${W}x${H}:r=${FPS},format=yuv420p[canvas];` +
      // Before a leading empty edit ends nothing is shown (review r7: the frame showing at the edit's start comes in at
      // its lead, not before).
      `[canvas][src]overlay=eof_action=repeat:repeatlast=1${
        leadIn > 0 ? `:enable='gte(t,${num(leadIn)})'` : ""
      },trim=end_frame=${own},setpts=N,` +
      `format=yuv420p,tpad=stop_mode=clone:stop=-1,${exact}`;
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
  ].join(";");
  return [
    ...FF_COMMON,
    ...PROGRESS,
    ...input({ demuxer: DEMUXER[c.fileKind]!, file }),
    "-filter_complex",
    graph,
    ...outs.flatMap((o) => ["-map", `[${o.label}]`, ...o.args]),
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

/** The PCM of an input's sound, in `work/` (`ingestArgs`). */
export const sourcePcm = (input: string) => `src-${input.replace(/[^A-Za-z0-9-]/g, "_")}.pcm`;

/**
 * One input decoded once from its start (the re-plan after review r3 — the lengths' truth): its first sound to 48 kHz
 * stereo s16 PCM from the container's start (`sourcePcm`; silence before a sound that starts late, nothing lost
 * before a picture that starts late), and — `countPicture` — its first picture counted at 30 fps from the same start
 * (a null output: the progress lines' last `frame=` is the count). Both stop at `capSec` (output `-t`; what is needed
 * plus a margin — the 30-minute limit bounds the rest).
 */
export function ingestArgs(o: {
  inDir: string;
  input: string;
  fileKind: FileKind;
  sound: boolean;
  countPicture: boolean;
  capSec: number;
  /** Review r8: its sound and picture tracks' presentation (`presentTrack`) on its timeline. */
  soundAt?: TrackPresentation;
  pictureAt?: TrackPresentation;
}): string[] {
  const sa = o.soundAt ?? presentTrack(null);
  const pa = o.pictureAt ?? presentTrack(null);
  // The sound mapped to its timeline; before its start nothing (review r8: cut whatever the shift — a lead equal to its
  // edit's media time shifts by 0, yet the media before it is still left out), then silence from 0 to the first sample
  // kept (`first_pts=0`), and nothing past its end (an AAC's padding, an edit's end).
  const shiftA =
    (sa.shift !== 0 ? `asettb=AVTB,asetpts=PTS${signed(sa.shift)}/TB,` : "") +
    (sa.start > 0 ? `atrim=start=${num(sa.start)},` : "");
  const endA = sa.end != null ? `,atrim=end=${num(Math.max(1e-6, sa.end))}` : "";
  const shiftV = ticks(pa.shift) !== 0 ? `settb=1/${PICTURE_TB}${tickShift(pa.shift)},` : "";
  // Review r8: a gap in the sound's timestamps is silence from 1 ms on (`min_hard_comp`; ffmpeg's own 0.1 s would
  // close a shorter one — an MP4 whose first AAC sample is stretched to fill 0.0667 s then plays 45 ms early).
  const cap = num(Math.max(1, o.capSec));
  return [
    ...FF_COMMON,
    ...PROGRESS,
    ...input({ demuxer: DEMUXER[o.fileKind]!, file: path.join(o.inDir, o.input) }),
    ...(o.sound
      ? [
          "-map",
          "0:a:0",
          "-af",
          `${shiftA}aresample=${RATE}:async=1:min_hard_comp=0.001:first_pts=0${endA},aformat=sample_fmts=s16:channel_layouts=stereo`,
          "-t",
          cap,
          ...PCM,
          sourcePcm(o.input),
        ]
      : []),
    ...(o.countPicture
      ? [
          "-map",
          "0:v:0",
          "-vf",
          `${shiftV}fps=${FPS}:start_time=0`,
          "-t",
          cap,
          "-an",
          "-sn",
          "-dn",
          "-f",
          "null",
          "-",
        ]
      : []),
  ];
}

const RAW = ["-f", "s16le", "-ar", String(RATE), "-ac", "2"];
/** The server's mixes (`bed.pcm`, `narration.pcm`) are float (review r5: a clip's gain above 1 is not clipped before the
 * ducking and the loudness normalisation). */
const RAW_FLOAT = ["-f", "f32le", "-ar", String(RATE), "-ac", "2"];
const DUCK = "sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400";

/**
 * The sound (review R3): the clips' PCM (`bed.pcm`), the narration (`narration.pcm`, when there is any) and the music
 * (its input's decoded PCM, `sourcePcm`, looped) mixed — the clips' own sound always ducked under the narration, the music when `duck` — loudness-
 * normalised and encoded to AAC of exactly `plan.samples`.
 */
export function audioArgs(plan: Plan, o: { narration: boolean; music: string | null }): string[] {
  const T = plan.samples;
  const m = plan.music;
  const duckMusic = !!(o.music && m?.duck && o.narration);
  const ins: string[] = ["-protocol_whitelist", "file,pipe", ...RAW_FLOAT, "-i", "bed.pcm"];
  const graph: string[] = [];
  const mix: string[] = [];
  let k = 1;
  if (o.narration) {
    ins.push("-protocol_whitelist", "file,pipe", ...RAW_FLOAT, "-i", "narration.pcm");
    const taps = 2 + (duckMusic ? 1 : 0);
    graph.push(`[${k}:a]asplit=${taps}[nar][scb]${duckMusic ? "[scm]" : ""}`);
    // Review r7: a compressor ends with the shorter of its two inputs — both are padded, its output cut at the target.
    graph.push(`[0:a]apad[bedin];[scb]apad[bedsc];[bedin][bedsc]${DUCK},atrim=end_sample=${T}[bed]`);
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
      o.music,
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
    if (duckMusic)
      graph.push(`[m0]apad[musin];[scm]apad[mussc];[musin][mussc]${DUCK},atrim=end_sample=${T}[mus]`);
    mix.push("[mus]");
  }
  // Loudness normalisation needs 3 s to measure (`loudnorm` gives NaN on less, reviews r1 and r5): a result of 3 s or
  // more is normalised as it is (no padding — padding in front of `loudnorm` cut the end of the sound); a shorter one is
  // only kept from clipping (`alimiter` at −1.5 dBFS, its delay compensated).
  const level =
    T >= 3 * RATE
      ? `loudnorm=I=-16:TP=-1.5:LRA=11,aresample=${RATE}`
      : "alimiter=limit=0.8414:level=0:latency=1";
  const tail = `${level},aformat=sample_fmts=fltp:sample_rates=${RATE}:channel_layouts=stereo,apad,atrim=end_sample=${T},asetpts=N/SR/TB[out]`;
  graph.push(
    mix.length === 1
      ? `${mix[0]}${tail}`
      : `${mix.join("")}amix=inputs=${mix.length}:normalize=0:duration=longest:dropout_transition=0,${tail}`,
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
