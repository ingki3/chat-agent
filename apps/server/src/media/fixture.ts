import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  MEDIA_CATALOG_URLS,
  OPENROUTER_API,
  OPENROUTER_IMAGES_URL,
  OPENROUTER_KEY_URL,
  OPENROUTER_SPEECH_URL,
  SPEECH_PRICING_URL,
} from "./openrouter.js";
import { makeSpeechWorkdir, type Measured, type SpeechAudio } from "./speech-audio.js";

/**
 * A scripted OpenRouter for the e2e run and manual testing with FAKE_RUNTIME=1 (#238): the server never reaches
 * openrouter.ai there. A key starting with `sk-or-v1-e2e` is accepted (limit $100, $87.5 left); any other is
 * refused (401). The catalogs are small made-up lists in OpenRouter's documented shapes (OpenAPI spec, 2026-11-24):
 * the image list names each model's per-endpoint records by URL (prices there), the speech list has no prices
 * (the general Models API with `output_modalities=speech` has them), the music list mixes a music model and a
 * voice-chat model (`supported_voices`). `POST /images` answers a small PNG (`usage.cost` $0.04), `POST
 * /audio/speech` a short MP3 with an `X-Generation-Id` whose record costs $0.0003.
 */
export const FIXTURE_OPENROUTER_KEY_PREFIX = "sk-or-v1-e2e";
export const FIXTURE_IMAGE_COST = 0.04;
export const FIXTURE_SPEECH_COST = 0.0003;
export const FIXTURE_GENERATION_ID = "gen-fixture-speech-0001";

const CATALOGS: Record<string, unknown> = {
  [MEDIA_CATALOG_URLS.image]: {
    data: [
      {
        id: "fixture/image-one",
        name: "Fixture Image One",
        architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
        supported_parameters: {
          aspect_ratio: { type: "enum", values: ["1:1", "16:9", "9:16"] },
          resolution: { type: "enum", values: ["1K", "2K"] },
          seed: { type: "boolean" },
        },
        supports_streaming: false,
        endpoints: "/api/v1/images/models/fixture/image-one/endpoints",
      },
      {
        id: "fixture/image-two",
        name: "Fixture Image Two",
        supported_parameters: {},
        endpoints: "/api/v1/images/models/fixture/image-two/endpoints",
      },
    ],
  },
  [`${OPENROUTER_API}/images/models/fixture/image-one/endpoints`]: {
    id: "fixture/image-one",
    endpoints: [
      {
        provider_name: "Fixture",
        provider_slug: "fixture",
        provider_tag: "fixture",
        allowed_passthrough_parameters: [],
        supports_streaming: false,
        supported_parameters: {
          aspect_ratio: { type: "enum", values: ["1:1", "16:9", "9:16"] },
          moderation: { type: "enum", values: ["auto", "low"] },
        },
        pricing: [
          { billable: "input_text", unit: "token", cost_usd: 0.000005 },
          { billable: "output_image", unit: "image", cost_usd: FIXTURE_IMAGE_COST },
        ],
      },
    ],
  },
  [MEDIA_CATALOG_URLS.speech]: {
    data: [
      {
        id: "fixture/voice-one",
        name: "Fixture Voice",
        input_modalities: [{ type: "text" }],
        output_modalities: [
          {
            type: "speech",
            supported_parameters: {
              voice: { type: "enum", values: ["alloy", "nova"] },
              response_format: { type: "enum", values: ["mp3", "pcm"] },
              speed: { type: "range", min: 0.7, max: 1.2 },
            },
          },
        ],
        endpoints: [],
      },
    ],
  },
  [`${OPENROUTER_API}/audio/speech/models/fixture/voice-one`]: {
    id: "fixture/voice-one",
    name: "Fixture Voice",
    input_modalities: [{ type: "text" }],
    output_modalities: [
      {
        type: "speech",
        supported_parameters: {
          voice: { type: "enum", values: ["alloy", "nova"] },
          response_format: { type: "enum", values: ["mp3", "pcm"] },
          instructions: { type: "unknown" },
        },
      },
    ],
    endpoints: [],
  },
  // The speech model's endpoints in the general Models API: its prices for a call's upper bound.
  [`${OPENROUTER_API}/models/fixture/voice-one/endpoints`]: {
    data: {
      id: "fixture/voice-one",
      name: "Fixture Voice",
      endpoints: [
        { provider_name: "Fixture", tag: "fixture", pricing: { prompt: "0.000015", completion: "0" } },
      ],
    },
  },
  [SPEECH_PRICING_URL]: {
    data: [
      {
        id: "fixture/voice-one",
        name: "Fixture Voice",
        architecture: { input_modalities: ["text"], output_modalities: ["speech"] },
        pricing: { prompt: "0.000015", completion: "0" },
        endpoints: ["/api/v1/audio/speech"],
      },
    ],
  },
  [MEDIA_CATALOG_URLS.music]: {
    data: [
      {
        id: "fixture/music-clip",
        name: "Fixture Music Clip",
        architecture: { input_modalities: ["text"], output_modalities: ["text", "audio"] },
        pricing: { prompt: "0", completion: "0", request: "0.04" },
        supported_voices: null,
      },
      {
        id: "fixture/voice-chat",
        name: "Fixture Voice Chat",
        architecture: { input_modalities: ["text", "audio"], output_modalities: ["text", "audio"] },
        pricing: { prompt: "0.0000025", completion: "0.00001" },
        supported_voices: ["alloy", "echo"],
      },
      {
        id: "fixture/text-only",
        name: "Not audio",
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      },
    ],
  },
  [MEDIA_CATALOG_URLS.video]: {
    data: [
      {
        id: "fixture/video-one",
        name: "Fixture Video",
        supported_durations: [4, 6, 8, 12],
        supported_resolutions: ["720p", "1080p"],
        supported_aspect_ratios: ["16:9", "9:16"],
        pricing_skus: { "per-video-second": "0.50", "per-video-second-1080p": "0.75" },
      },
    ],
  },
  [`${OPENROUTER_API}/generation?id=${FIXTURE_GENERATION_ID}`]: {
    data: { id: FIXTURE_GENERATION_ID, model: "fixture/voice-one", total_cost: FIXTURE_SPEECH_COST },
  },
};

/** A `w`×`h` PNG of one colour (a real image, so the chat preview shows something). */
export function solidPng(w: number, h: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A short MP3: an ID3 tag and a few silent MPEG-1 Layer III frames (128 kbit/s, 44.1 kHz). */
export function silentMp3(frames = 20): Buffer {
  const id3 = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]);
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x64]);
  return Buffer.concat([id3, ...Array.from({ length: frames }, () => frame)]);
}

export function fixtureOpenRouterFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const ok = auth.startsWith(`Bearer ${FIXTURE_OPENROUTER_KEY_PREFIX}`);
    if (!ok) return Response.json({ error: { code: 401, message: "No auth" } }, { status: 401 });
    if (url === OPENROUTER_KEY_URL)
      return Response.json({ data: { label: "e2e", limit: 100, limit_remaining: 87.5, usage: 12.5 } });
    if (init?.method === "POST" && url === OPENROUTER_IMAGES_URL)
      return Response.json({
        created: 1_764_000_000,
        data: [{ b64_json: solidPng(64, 64, [64, 132, 220]).toString("base64"), media_type: "image/png" }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: FIXTURE_IMAGE_COST },
      });
    if (init?.method === "POST" && url === OPENROUTER_SPEECH_URL)
      return new Response(new Uint8Array(silentMp3()), {
        headers: { "content-type": "audio/mpeg", "x-generation-id": FIXTURE_GENERATION_ID },
      });
    const body = CATALOGS[url];
    if (body) return Response.json(body);
    return Response.json({ error: { code: 404 } }, { status: 404 });
  }) as typeof fetch;
}

/** In a scripted answer: makes the scripted decoder fail on it (a corrupt MP3, as the strict decode would). */
export const FIXTURE_CORRUPT_MARK = "FIXTURE-CORRUPT";

/** Layer III bit rates (kbit/s) by index (MPEG-1, then MPEG-2/2.5) and sample rates by version. */
const KBPS_V1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const KBPS_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const RATES: Record<number, readonly number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

/**
 * The fake's own model of an MP3 (test and FAKE_RUNTIME only — production asks the decoder, `speech-audio.ts`): its
 * MPEG audio frames, walked one after another from the start (after an ID3v2 tag) until something is not a frame.
 * Each frame's layer, rate and channel count; `samples` per frame (1152 MPEG-1, 576 MPEG-2/2.5, Layer III). It does
 * not care about Xing/Info frames (they count as audio here) — the real decoder's exact trimming is not modelled.
 */
export function fixtureMp3Frames(
  b: Buffer,
): { start: number; end: number; layer: number; rate: number; channels: 1 | 2; samples: number }[] {
  let p = 0;
  if (b.length >= 10 && b.toString("latin1", 0, 3) === "ID3")
    p = 10 + (((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f));
  const out: { start: number; end: number; layer: number; rate: number; channels: 1 | 2; samples: number }[] =
    [];
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff || (b[p + 1]! & 0xe0) !== 0xe0) break;
    const version = (b[p + 1]! >> 3) & 3;
    const layer = (b[p + 1]! >> 1) & 3;
    const bi = (b[p + 2]! >> 4) & 15;
    const si = (b[p + 2]! >> 2) & 3;
    if (version === 1 || layer === 0 || bi === 0 || bi === 15 || si === 3) break;
    const rate = RATES[version]![si]!;
    const v1 = version === 3;
    const kbps = (v1 ? KBPS_V1 : KBPS_V2)[bi]!;
    // (Layer I/II lengths are not modelled: such a frame is taken with the Layer III length — enough to report it.)
    const len = Math.floor(((v1 ? 144 : 72) * kbps * 1000) / rate) + ((b[p + 2]! >> 1) & 1);
    if (p + len > b.length) break;
    out.push({
      start: p,
      end: p + len,
      layer,
      rate,
      channels: ((b[p + 3]! >> 6) & 3) === 3 ? 1 : 2,
      samples: v1 ? 1152 : 576,
    });
    p += len;
  }
  return out;
}

/** One silent MPEG Layer III frame at `rate` (any of the nine MPEG-1/2/2.5 rates), mono. */
function silentFrame(rate: number): Buffer {
  const version = [3, 2, 0].find((v) => RATES[v]!.includes(rate));
  if (version === undefined) throw new Error(`no MPEG rate ${rate}`);
  const si = RATES[version]!.indexOf(rate);
  const v1 = version === 3;
  const bi = 9;
  const len = Math.floor(((v1 ? 144 : 72) * (v1 ? KBPS_V1 : KBPS_V2)[bi]! * 1000) / rate);
  const f = Buffer.alloc(len);
  f.set([0xff, 0xe2 | (version << 3) | (1 << 1) | 1, (bi << 4) | (si << 2), 0xc4]);
  return f;
}

/**
 * A scripted ffprobe/ffmpeg (measure, encode) for the FAKE_RUNTIME (e2e) server and tests, with the real one's
 * semantics (#251 re-plan 5) on its own small model (`fixtureMp3Frames`): `corrupt` for `FIXTURE_CORRUPT_MARK`;
 * `unsupported` when there is no Layer III frame at all, or another layer among the frames it follows; the "decode" converts every frame's samples to the call's
 * rate (the first answer's) and writes that many PCM samples (silence) into `out/`; `too_long` over the cap. The
 * "encode" writes silent frames for the PCM files' samples. It does not model the decoder's delay/padding trimming
 * or Xing/Info frames — boundary tests use counts the real decoder confirmed. No program runs.
 */
export function fixtureSpeechAudio(dataDir: string): SpeechAudio {
  let n = 0;
  return {
    workdir: () => makeSpeechWorkdir(dataDir),
    async measure(file, m): Promise<Measured> {
      const b = fs.readFileSync(file);
      if (b.includes(FIXTURE_CORRUPT_MARK, 0, "latin1")) return { ok: false, reason: "corrupt" };
      const frames = fixtureMp3Frames(b);
      const first = frames[0];
      // No Layer III frame, or another layer among them: the fake does not model how the real decoder plays mixed
      // layers (it cannot even follow MP2 frames' lengths) — it refuses them; real-decoder tests cover that case.
      if (!first || frames.some((f) => f.layer !== 1)) return { ok: false, reason: "unsupported" };
      const sampleRate = m.sampleRate ?? first.rate;
      const samples = Math.round(frames.reduce((a, f) => a + (f.samples * sampleRate) / f.rate, 0));
      if (samples > m.maxSeconds * sampleRate) return { ok: false, reason: "too_long" };
      const pcm = path.join(path.dirname(path.dirname(file)), "out", `pcm-${++n}.s16`);
      fs.writeFileSync(pcm, Buffer.alloc(samples * 2), { mode: 0o600 });
      return { ok: true, samples, seconds: samples / sampleRate, sampleRate, pcm };
    },
    async encode(job) {
      const samples = job.pcms.reduce((a, f) => a + fs.statSync(f).size / 2, 0);
      const frame = silentFrame(job.sampleRate);
      const spf = job.sampleRate >= 32000 ? 1152 : 576;
      const out = path.join(job.workdir, "out", `speech-${++n}.mp3`);
      fs.writeFileSync(out, Buffer.concat(Array.from({ length: Math.round(samples / spf) }, () => frame)), {
        mode: 0o600,
      });
      return out;
    },
  };
}
