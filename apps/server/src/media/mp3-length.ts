/**
 * An MP3's length from its frame headers (#251 r12) — used **only** as a one-directional cross-check of the decoded
 * length (`speech-audio.ts`): ffmpeg resamples when frames change rate, and two decodes at different rates can lose
 * the same audio, so neither is the answer's own length. Each MPEG audio frame's header gives its samples (Layer I
 * 384, Layer II 1152, Layer III 1152 at MPEG-1 rates and 576 at MPEG-2/2.5) and its own rate; their sum is what the
 * frames hold. It is normally a little **more** than what decoding plays (encoder delay and padding, a Xing/Info
 * frame), never less — so a sum far above the decoded length means audio lost in decoding, and a walk that misses
 * frames (a misparse that undercounts) can never make a file look shortened.
 *
 * Frames are found as a decoder syncs: a header counts only when another valid header follows at the length it
 * gives (or the file ends exactly there); once in step the walk goes frame to frame and never reads inside a frame.
 * Out of step (an ID3v2 tag at the start is skipped by its size; tags, padding or junk anywhere else) it moves on byte
 * by byte, and a frame is taken there only when two more headers follow in step — so bytes of a tag are not counted.
 */

const KBPS: Record<string, readonly number[]> = {
  "v1-l1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "v1-l2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "v1-l3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "v2-l1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "v2-l2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "v2-l3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const RATES: Record<number, readonly number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

/** The frame at `p`: its length in bytes and its seconds; undefined when there is no valid header there. */
function frameAt(b: Buffer, p: number): { len: number; seconds: number } | undefined {
  if (p + 4 > b.length || b[p] !== 0xff || (b[p + 1]! & 0xe0) !== 0xe0) return undefined;
  const version = (b[p + 1]! >> 3) & 3;
  const layer = (b[p + 1]! >> 1) & 3; // 3 = Layer I, 2 = Layer II, 1 = Layer III
  const bi = (b[p + 2]! >> 4) & 15;
  const si = (b[p + 2]! >> 2) & 3;
  // Reserved fields, or a free-format frame (its header gives no length): not a frame here.
  if (version === 1 || layer === 0 || bi === 0 || bi === 15 || si === 3) return undefined;
  const rate = RATES[version]![si]!;
  const pad = (b[p + 2]! >> 1) & 1;
  const v1 = version === 3;
  const name = layer === 3 ? "l1" : layer === 2 ? "l2" : "l3";
  const kbps = KBPS[`${v1 ? "v1" : "v2"}-${name}`]![bi]!;
  let len: number;
  let samples: number;
  if (layer === 3) {
    len = (Math.floor((12 * kbps * 1000) / rate) + pad) * 4;
    samples = 384;
  } else if (layer === 2) {
    len = Math.floor((144 * kbps * 1000) / rate) + pad;
    samples = 1152;
  } else {
    len = Math.floor(((v1 ? 144 : 72) * kbps * 1000) / rate) + pad;
    samples = v1 ? 1152 : 576;
  }
  return { len, seconds: samples / rate };
}

/** Whether `count` frames follow one another from `p`, each where the previous one ends (or the file ends). */
function chained(b: Buffer, p: number, count: number): boolean {
  for (let i = 0; i < count; i++) {
    if (p === b.length) return true;
    const f = frameAt(b, p);
    if (!f || p + f.len > b.length) return false;
    p += f.len;
  }
  return true;
}

/** The seconds the frames of this MP3 hold, from their headers (see above). */
export function headerSeconds(b: Buffer): number {
  let p = 0;
  if (b.length >= 10 && b.toString("latin1", 0, 3) === "ID3") {
    const size = ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f);
    const skip = 10 + size + (b[5]! & 0x10 ? 10 : 0);
    if (skip <= b.length) p = skip;
  }
  let seconds = 0;
  let inStep = false;
  while (p + 4 <= b.length) {
    const f = frameAt(b, p);
    const next = f ? p + f.len : undefined;
    if (f && next !== undefined && next <= b.length && (inStep || next === b.length || chained(b, next, 2))) {
      seconds += f.seconds;
      p = next;
      inStep = true;
      continue;
    }
    inStep = false;
    p++;
  }
  return seconds;
}
