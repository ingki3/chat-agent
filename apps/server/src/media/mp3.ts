/**
 * The one audio form `speech_generate` takes from a provider (#251 re-plan 3): an MPEG-1/2/2.5 **Layer III** stream
 * with **one** sample rate and **one** channel count from its first frame to its last — walked here frame by frame
 * over the whole file, in this process (headers only; nothing is decoded). Anything else is refused before it is
 * measured, joined or stored: another layer (MP2, MP1), a free-format or reserved header, a rate or channel change,
 * bytes that are not frames (garbage, a cut last frame). An ID3v2 tag at the start and an ID3v1 tag (`TAG`, 128
 * bytes) at the end are allowed.
 */

/** Layer III bit rates (kbit/s) by index: MPEG-1, then MPEG-2/2.5. Sample rates by version (3: 1, 2: 2, 0: 2.5). */
const KBPS_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const KBPS_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES: Record<number, readonly number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

export type Mp3Walk =
  | {
      ok: true;
      /** Every frame, in order (a leading Xing/Info frame — a length header, no audio — is marked). */
      frames: { start: number; end: number; info: boolean }[];
      sampleRate: number;
      channels: 1 | 2;
      samplesPerFrame: 1152 | 576;
      /** Samples of the audio frames (an upper bound of what decoding plays: encoder delay/padding not taken off). */
      samples: number;
    }
  /** `unsupported`: MPEG audio of another form; `not_mp3`: not a clean frame stream (corrupt). */
  | { ok: false; reason: "unsupported" | "not_mp3" };

export function walkMp3(b: Buffer): Mp3Walk {
  let p = 0;
  if (b.length >= 10 && b.toString("latin1", 0, 3) === "ID3") {
    const size = ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f);
    // A footer (flag 0x10) adds 10 bytes.
    p = 10 + size + (b[5]! & 0x10 ? 10 : 0);
  }
  const end =
    b.length >= 128 && b.toString("latin1", b.length - 128, b.length - 125) === "TAG"
      ? b.length - 128
      : b.length;
  const frames: { start: number; end: number; info: boolean }[] = [];
  let form: { version: number; rate: number; channels: 1 | 2 } | undefined;
  while (p < end) {
    if (p + 4 > end || b[p] !== 0xff || (b[p + 1]! & 0xe0) !== 0xe0) return { ok: false, reason: "not_mp3" };
    const version = (b[p + 1]! >> 3) & 3;
    const layer = (b[p + 1]! >> 1) & 3;
    const bi = (b[p + 2]! >> 4) & 15;
    const si = (b[p + 2]! >> 2) & 3;
    if (version === 1 || layer === 0 || bi === 15 || si === 3) return { ok: false, reason: "not_mp3" };
    // Layer II or I (MP2, MP1), or a free-format frame (no length in its header): not taken.
    if (layer !== 1 || bi === 0) return { ok: false, reason: "unsupported" };
    const rate = RATES[version]![si]!;
    const channels: 1 | 2 = ((b[p + 3]! >> 6) & 3) === 3 ? 1 : 2;
    if (!form) form = { version, rate, channels };
    else if (form.version !== version || form.rate !== rate || form.channels !== channels)
      return { ok: false, reason: "unsupported" };
    const v1 = version === 3;
    const kbps = (v1 ? KBPS_V1 : KBPS_V2)[bi]!;
    const len = Math.floor(((v1 ? 144 : 72) * kbps * 1000) / rate) + ((b[p + 2]! >> 1) & 1);
    if (p + len > end) return { ok: false, reason: "not_mp3" };
    const head = frames.length === 0 ? b.toString("latin1", p, Math.min(p + len, p + 64)) : "";
    frames.push({ start: p, end: p + len, info: /Xing|Info/.test(head) });
    p += len;
  }
  if (!form || !frames.length) return { ok: false, reason: "not_mp3" };
  const samplesPerFrame = form.version === 3 ? 1152 : 576;
  const audioFrames = frames.length - (frames[0]!.info ? 1 : 0);
  return {
    ok: true,
    frames,
    sampleRate: form.rate,
    channels: form.channels,
    samplesPerFrame,
    samples: audioFrames * samplesPerFrame,
  };
}
