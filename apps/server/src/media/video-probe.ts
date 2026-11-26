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
export type VideoProbe = {
  check(file: string, signal?: AbortSignal): Promise<VideoProbeVerdict>;
  /**
   * Review r1 (P1): whether the check really works here — `check` run, in the same sandbox, on a known-good MP4
   * (`KNOWN_GOOD_MP4`) in a fresh working folder, and it says `ok`. A sandbox that cannot start, an ffprobe that cannot
   * read MP4: false (then nothing is approved).
   */
  ready(signal?: AbortSignal): Promise<boolean>;
};

/**
 * A known-good MP4 (1 s, 64×36, VP9 in ISO BMFF, brand `isom`, made once with ffmpeg 8 and no metadata): what the
 * readiness check probes — and what the e2e fixture serves (a browser plays VP9 in MP4).
 */
export const KNOWN_GOOD_MP4 = Buffer.from(
  [
    "AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAAzptb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAD6AABAAABAAAAAAAA",
    "AAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACZXRy",
    "YWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAD6AAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAA",
    "AAAAAAAAAEAAAAAAQAAAACQAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAA+gAAAAAAAEAAAAAAd1tZGlhAAAAIG1kaGQAAAAA",
    "AAAAAAAAAAAAACgAAAAoAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAGIbWluZgAA",
    "ABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABSHN0YmwAAACoc3RzZAAAAAAA",
    "AAABAAAAmHZwMDkAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAQAAkAEgAAABIAAAAAAAAAAEYTGF2YzYyLjExLjEwMCBsaWJ2cHgt",
    "dnA5AAAAAAAAAAAY//8AAAAUdnBjQwEAAAAACoICAgIAAAAAAApmaWVsAQAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAABO",
    "IAAAAAAAAAAYc3R0cwAAAAAAAAABAAAACgAABAAAAAAUc3RzcwAAAAAAAAABAAAAAQAAABxzdHNjAAAAAAAAAAEAAAABAAAACgAA",
    "AAEAAAA8c3RzegAAAAAAAAAAAAAACgAAACoAAAAPAAAADwAAAA8AAAAPAAAADwAAAA8AAAAPAAAADwAAAA8AAAAUc3RjbwAAAAAA",
    "AAABAAADZgAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRv",
    "bwAAABxkYXRhAAAAAQAAAABMYXZmNjIuMy4xMDAAAAAIZnJlZQAAALltZGF0gkmDQgAD8AI2ADgkHBhCAAAwYAAAE7//9AMAAEf/",
    "///U4h/////VDgAAhgBAkpwASUAAAyAAAFRwhgBAkpwASsAAAyAAAFRwhgBAkpwAScAAAyAAAFRwhgBAkpwASKAAAyAAAFRwhgBA",
    "kpwAR4AAAyAAAFRwhgBAkpwARuAAAyAAAFRwhgBAkpwARkAAAyAAAFRwhgBAkpwARcAAAyAAAFRwhgBAkpwARUAAAyAAAFRw",
  ].join(""),
  "base64",
);

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

/**
 * The `video-scratch` folders in use in this process (a download, a readiness check): never swept. Clean-up only —
 * no job's state depends on it. A folder whose removal failed leaves it and is swept later (review r5).
 */
const inUse = new Set<string>();
/** A working folder's removal failed since the last full sweep (the engine's next pass sweeps — review r6). */
let dirty = false;
/** Whether some working folder could not be removed (and is left for a sweep). */
export const scratchDirty = (): boolean => dirty;
export const makeVideoWorkdir = (dataDir: string): string => {
  const dir = makeScratchDir(dataDir, storagePaths(dataDir).videoScratch);
  inUse.add(path.basename(dir));
  return dir;
};
/** Removes a working folder; false (left for a later sweep) when it could not all go. */
export const removeVideoWorkdir = (dir: string): boolean => {
  let ok: boolean;
  try {
    ok = removeTree(dir);
  } catch {
    ok = false;
  }
  inUse.delete(path.basename(dir));
  if (!ok) dirty = true;
  return ok;
};
/** The folders not in use here (the last process's, and removals that failed) — never one in use now. */
export const sweepVideoScratch = (dataDir: string): boolean => {
  const ok = sweepScratch(dataDir, storagePaths(dataDir).videoScratch, (name) => inUse.has(name));
  if (ok) dirty = false;
  return ok;
};

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
  const probe: VideoProbe = {
    ready: (signal) => readyOf(probe, o.dataDir, signal),
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
  return probe;
}

/** `ready` of a probe: `KNOWN_GOOD_MP4` checked in a fresh working folder of `video-scratch` (removed after). */
async function readyOf(probe: VideoProbe, dataDir: string, signal?: AbortSignal): Promise<boolean> {
  let dir: string | undefined;
  try {
    dir = makeVideoWorkdir(dataDir);
    const file = path.join(dir, "ready.mp4");
    fs.writeFileSync(file, KNOWN_GOOD_MP4, { flag: "wx", mode: 0o600 });
    return (await probe.check(file, signal)) === "ok";
  } catch {
    return false;
  } finally {
    if (dir) removeVideoWorkdir(dir);
  }
}

/**
 * The FAKE_RUNTIME (e2e) and test probe — no program runs: the file's first box must be `ftyp` with an MP4 brand, and
 * a `moov` box must follow somewhere (the fixture's tiny MP4 has one; a real decoder is not modelled).
 */
export function fixtureVideoProbe(dataDir?: string): VideoProbe {
  const probe: VideoProbe = {
    ready: (signal) => (dataDir ? readyOf(probe, dataDir, signal) : Promise.resolve(true)),
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
  return probe;
}
