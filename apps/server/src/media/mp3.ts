/**
 * The one audio form `speech_generate` takes from a provider (#251 re-plan 3, narrowed in r7): an MPEG-1/2/2.5
 * **Layer III** stream with **one** sample rate and **one** channel count — checked here over the whole file, from
 * frame headers only, in this process. This is a **form** check and nothing else: whether the audio is intact is
 * decided by ffmpeg's strict decode alone (`speech-audio.ts`). So bytes that are not frames — an ID3v1, APEv2 or
 * Lyrics tag, padding, junk — are stepped over, never judged.
 *
 * Frames are found the way a decoder syncs: a header counts as a frame only when another valid header follows at
 * the length it gives (or the file ends there), and once in step the walk goes frame to frame without looking inside
 * them — sync-like bytes in frame data are never read as headers. Of the frames found, any other layer (MP2, MP1),
 * or a change of version, rate or channel count, is `unsupported`; no Layer III frame at all (WAV, anything else) is
 * `unsupported` too.
 */

/** Bit rates (kbit/s) by index, per version family and layer; sample rates by version (3: MPEG-1, 2: 2, 0: 2.5). */
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

type Header = {
  version: number;
  /** 3 = Layer I, 2 = Layer II, 1 = Layer III (the header's own coding). */
  layer: number;
  rate: number;
  channels: 1 | 2;
  /** The frame's length in bytes; undefined for a free-format frame (its header does not say). */
  len: number | undefined;
  crc: boolean;
};

/** The MPEG audio header at `p`, or undefined when there is none (a reserved or invalid field). */
function header(b: Buffer, p: number): Header | undefined {
  if (p + 4 > b.length || b[p] !== 0xff || (b[p + 1]! & 0xe0) !== 0xe0) return undefined;
  const version = (b[p + 1]! >> 3) & 3;
  const layer = (b[p + 1]! >> 1) & 3;
  const bi = (b[p + 2]! >> 4) & 15;
  const si = (b[p + 2]! >> 2) & 3;
  if (version === 1 || layer === 0 || bi === 15 || si === 3) return undefined;
  const rate = RATES[version]![si]!;
  const pad = (b[p + 2]! >> 1) & 1;
  const v1 = version === 3;
  const name = layer === 3 ? "l1" : layer === 2 ? "l2" : "l3";
  const kbps = KBPS[`${v1 ? "v1" : "v2"}-${name}`]![bi]!;
  let len: number | undefined;
  if (bi !== 0) {
    if (layer === 3) len = (Math.floor((12 * kbps * 1000) / rate) + pad) * 4;
    else if (layer === 1 && !v1) len = Math.floor((72 * kbps * 1000) / rate) + pad;
    else len = Math.floor((144 * kbps * 1000) / rate) + pad;
  }
  return {
    version,
    layer,
    rate,
    channels: ((b[p + 3]! >> 6) & 3) === 3 ? 1 : 2,
    len,
    crc: (b[p + 1]! & 1) === 0,
  };
}

export type Mp3Walk =
  | {
      ok: true;
      /** The frames found, in order (`info`: a leading Xing/Info frame — a length header, no audio). */
      frames: { start: number; end: number; info: boolean }[];
      sampleRate: number;
      channels: 1 | 2;
      samplesPerFrame: 1152 | 576;
    }
  | { ok: false; reason: "unsupported" };

/** Whether the frame at `p` is a Xing/Info header frame: the tag right after its side information (ffmpeg's place). */
function infoFrame(b: Buffer, p: number, h: Header): boolean {
  const side = h.version === 3 ? (h.channels === 1 ? 17 : 32) : h.channels === 1 ? 9 : 17;
  const at = p + 4 + (h.crc ? 2 : 0) + side;
  const tag = b.toString("latin1", at, at + 4);
  return tag === "Xing" || tag === "Info";
}

/** Whether `count` valid headers follow one another from `p`, each where the previous one's frame ends (or EOF). */
function chained(b: Buffer, p: number, count: number): boolean {
  for (let i = 0; i < count; i++) {
    if (p === b.length) return true;
    const h = header(b, p);
    if (!h || h.len === undefined || p + h.len > b.length) return false;
    p += h.len;
  }
  return true;
}

export function walkMp3(b: Buffer): Mp3Walk {
  let p = 0;
  if (b.length >= 10 && b.toString("latin1", 0, 3) === "ID3") {
    const size = ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f);
    // A footer (flag 0x10) adds 10 bytes.
    const skip = 10 + size + (b[5]! & 0x10 ? 10 : 0);
    if (skip <= b.length) p = skip;
  }
  const frames: { start: number; end: number; info: boolean }[] = [];
  let form: Header | undefined;
  let inStep = false;
  while (p + 4 <= b.length) {
    const h = header(b, p);
    const next = h?.len !== undefined ? p + h.len : undefined;
    // In step: the previous frame ended here and this header is valid — a frame. Out of step (the start, or after
    // bytes that were no frame): a frame only when the file ends where it ends, or two more headers follow in step.
    if (h && next !== undefined && next <= b.length && (inStep || next === b.length || chained(b, next, 2))) {
      if (h.layer !== 1) return { ok: false, reason: "unsupported" };
      if (!form) form = h;
      else if (form.version !== h.version || form.rate !== h.rate || form.channels !== h.channels)
        return { ok: false, reason: "unsupported" };
      frames.push({ start: p, end: next, info: frames.length === 0 && infoFrame(b, p, h) });
      p = next;
      inStep = true;
      continue;
    }
    // Not a frame here (a tag, padding, junk, a cut frame): one byte on — never a verdict on the audio.
    inStep = false;
    p++;
  }
  if (!form) return { ok: false, reason: "unsupported" };
  return {
    ok: true,
    frames,
    sampleRate: form.rate,
    channels: form.channels,
    samplesPerFrame: form.version === 3 ? 1152 : 576,
  };
}
