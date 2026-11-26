import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { runIsolated, type RunIsolatedOptions } from "../isolation/sandbox.js";
import { removeTree } from "../python/service.js";
import { storagePaths } from "../storage/paths.js";
import { decodeVerdict, makeScratchDir, speechTools, sweepScratch } from "./speech-audio.js";

/**
 * The check of a finished video before it is stored (#238 stage 3, review item 8; user decision 3: the MP4 form only
 * — a deliberately crafted MP4 is out of scope). ffprobe — the one beside `audio_transcribe`'s ffmpeg, run sandboxed
 * like speech's (`runIsolated`: no network, a fixed environment, a time and memory limit, it reads only the job's
 * folder) — reports the container and the streams; the file is taken only when:
 * - the container is ISO BMFF as ffprobe names it (`format_name` lists `mp4`),
 * - its `major_brand` is an MP4 one (`isom`, `iso2`–`iso9`, `mp41`, `mp42`, `avc1`, `dash`, `mp4v`, `M4V `, `msnv`,
 *   `av01`) — not QuickTime's `qt  `,
 * - and it has at least one video stream (not just a cover picture).
 * Anything else, or a report that does not parse, is `not_mp4`; a run that did not really run is `failed`. Without
 * ffprobe there is no `VideoProbe`, and no job is approved (`video_probe_unavailable` — nothing is paid).
 *
 * Working folders: `<DATA_DIR>/video-scratch/<uuid>`, one per download, removed when the job is done with it (and at
 * the engine's start).
 */
export type VideoProbeVerdict = "ok" | "not_mp4" | "failed";
export type VideoProbe = { check(file: string, signal?: AbortSignal): Promise<VideoProbeVerdict> };

export const MP4_BRANDS: ReadonlySet<string> = new Set([
  "isom",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "iso7",
  "iso8",
  "iso9",
  "mp41",
  "mp42",
  "avc1",
  "dash",
  "mp4v",
  "m4v ",
  "msnv",
  "av01",
]);

export const VIDEO_PROBE_LIMITS = { timeoutMs: 60_000, memoryBytes: 1024 * 1024 * 1024 } as const;

export const makeVideoWorkdir = (dataDir: string): string =>
  makeScratchDir(dataDir, storagePaths(dataDir).videoScratch);
export const removeVideoWorkdir = (dir: string): boolean => removeTree(dir);
/** The folders of the last process (the engine's start; nothing is downloading then). */
export const sweepVideoScratch = (dataDir: string): boolean =>
  sweepScratch(dataDir, storagePaths(dataDir).videoScratch);

const Report = z.object({
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
        disposition: z.object({ attached_pic: z.number().int() }).partial().optional(),
      }),
    )
    .max(64)
    .optional(),
});

/** ffprobe's report judged (exported for tests). */
export function judgeVideoProbe(stdout: string): "ok" | "not_mp4" {
  let r: z.infer<typeof Report>;
  try {
    const p = Report.safeParse(JSON.parse(stdout));
    if (!p.success) return "not_mp4";
    r = p.data;
  } catch {
    return "not_mp4";
  }
  const names = (r.format?.format_name ?? "").split(",");
  const brand = (r.format?.tags?.major_brand ?? "").toLowerCase().padEnd(4, " ");
  const video = (r.streams ?? []).filter(
    (s) => s.codec_type === "video" && s.disposition?.attached_pic !== 1,
  ).length;
  return names.includes("mp4") && MP4_BRANDS.has(brand) && video >= 1 ? "ok" : "not_mp4";
}

/** The ffprobe run (exported for tests). */
export function videoProbeOptions(ffprobe: string, trusted: string[], file: string): RunIsolatedOptions {
  const dir = path.dirname(file);
  return {
    command: ffprobe,
    args: [
      "-v",
      "error",
      "-hide_banner",
      "-show_entries",
      "format=format_name:format_tags=major_brand:stream=codec_type:stream_disposition=attached_pic",
      "-of",
      "json",
      file,
    ],
    cwd: dir,
    env: { HOME: dir, LANG: "en_US.UTF-8" },
    read: [dir],
    write: [],
    trusted,
    network: "none",
    noFlagChanges: true,
    timeoutMs: VIDEO_PROBE_LIMITS.timeoutMs,
    maxRssBytes: VIDEO_PROBE_LIMITS.memoryBytes,
    maxOutputBytes: 64 * 1024,
  };
}

/** The `VideoProbe` the app uses: the sandboxed ffprobe (undefined without it — macOS only). */
export function sandboxedVideoProbe(o: {
  dataDir: string;
  ffmpegPath?: string | undefined;
  platform?: NodeJS.Platform;
  run?: typeof runIsolated;
}): VideoProbe | undefined {
  const tools = speechTools(o.ffmpegPath, o.dataDir, o.platform);
  if (!tools) return undefined;
  const run = o.run ?? runIsolated;
  return {
    async check(file, signal) {
      const st = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!st?.isFile() || st.nlink !== 1) return "failed";
      let r;
      try {
        r = await run({
          ...videoProbeOptions(tools.ffprobe, tools.ffmpeg.trusted, file),
          ...(signal ? { signal } : {}),
        });
      } catch {
        return "failed";
      }
      const v = decodeVerdict(r);
      if (v === "failed") return "failed";
      // A file ffprobe cannot read is not an MP4 this server takes.
      return v === "ok" ? judgeVideoProbe(r.stdout) : "not_mp4";
    },
  };
}

/**
 * The FAKE_RUNTIME (e2e) and test probe — no program runs: the file's first box must be `ftyp` with an MP4 brand, and
 * a `moov` box must follow somewhere (the fixture's tiny MP4 has one; a real decoder is not modelled).
 */
export function fixtureVideoProbe(): VideoProbe {
  return {
    async check(file) {
      let b: Buffer;
      try {
        b = fs.readFileSync(file);
      } catch {
        return "failed";
      }
      if (b.length < 16 || b.toString("latin1", 4, 8) !== "ftyp") return "not_mp4";
      const brand = b.toString("latin1", 8, 12).toLowerCase();
      return MP4_BRANDS.has(brand) && b.includes("moov", 0, "latin1") ? "ok" : "not_mp4";
    },
  };
}
