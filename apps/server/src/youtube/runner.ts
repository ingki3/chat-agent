import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { YOUTUBE_LIMITS, type YoutubeCode } from "@agentlee/shared";
import { runIsolated, type RunIsolatedOptions, type RunResult, type TreeProc } from "../isolation/sandbox.js";
import { SYSTEM_CA_BUNDLE } from "../mcp/service.js";
import { YOUTUBE_DIR, YOUTUBE_ENTRY, type YoutubeEnv } from "./packages.js";

/**
 * How `youtube_audio_fetch` runs its programs (#191, PRD NFR 격리). Every step is its own sandboxed process group
 * (#42), killed whole on a limit, with a fixed environment and no secret:
 *
 * 1. **probe** — the pinned python runs `fetch.py` (yt-dlp): the video's metadata, no download. Its only way out is
 *    the egress proxy (a loopback port) that lets HTTPS through to YouTube's hosts only. It may start one program,
 *    the pinned deno (YouTube's JS challenge — `fork`, `exec` = that one binary, which inherits the profile and has
 *    no permission of its own: `deno run` without `--allow-*`). Writes only its `yt/` folder (HOME, deno's cache,
 *    the info JSON).
 * 2. **download** — the same process shape: the one audio-only format the server chose, into `yt/dl/`.
 * 3. **convert** — ffmpeg (audio_transcribe's, #173) reads only `yt/dl/`, writes only `out/` the M4A (stream copy, or
 *    AAC when the source is Opus), cut to the section; no network, no children.
 *
 * Tests give the service a runner of their own (a fake yt-dlp); off macOS this one answers
 * `youtube_server_unavailable`.
 */

export type Fail = { ok: false; code: YoutubeCode };

/** One audio-only format of the probe (what the server chooses from). */
export const AudioFormat = z.object({
  format_id: z.string().regex(/^[A-Za-z0-9_.-]{1,40}$/),
  ext: z.string().max(10).optional(),
  acodec: z.string().max(60).optional(),
  vcodec: z.string().max(60).optional(),
  abr: z.number().optional(),
  tbr: z.number().optional(),
  filesize: z.number().optional(),
  filesize_approx: z.number().optional(),
  protocol: z.string().max(40).optional(),
  language_preference: z.number().optional(),
  format_note: z.string().max(200).optional(),
  has_drm: z.union([z.boolean(), z.string()]).optional(),
});
export type AudioFormat = z.infer<typeof AudioFormat>;

/** The probe's summary (`fetch.py summary`): untrusted text from YouTube — bounded here, framed by the service. */
export const ProbeInfo = z.object({
  id: z.string().max(64),
  type: z.string().max(40),
  extractor_key: z.string().max(60).optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  channel: z.string().optional(),
  uploader: z.string().optional(),
  upload_date: z.string().optional(),
  duration: z.number().optional(),
  live_status: z.string().max(40).optional(),
  is_live: z.boolean().optional(),
  was_live: z.boolean().optional(),
  availability: z.string().max(40).optional(),
  age_limit: z.number().optional(),
  formats: z.array(z.unknown()).max(200),
});
export type ProbeInfo = z.infer<typeof ProbeInfo>;

export type ProbeJob = {
  env: YoutubeEnv;
  workdir: string;
  url: string;
  proxy: { url: string; port: number };
};
export type DownloadJob = {
  env: YoutubeEnv;
  workdir: string;
  formatId: string;
  proxy: { url: string; port: number };
  /** Tests only: a lower download limit (default `YOUTUBE_LIMITS.maxBytes`). */
  maxBytes?: number;
};
export type ConvertJob = {
  env: YoutubeEnv;
  workdir: string;
  /** The downloaded file (`yt/dl/audio.<ext>`). */
  input: string;
  /** Stream copy (AAC source) or encode to AAC (anything else). */
  copy: boolean;
  start?: number | undefined;
  end?: number | undefined;
};

export type YoutubeRunner = {
  /**
   * The circuit breaker (#191 review 2): true while a process of an earlier run that left its group is still alive
   * (or could not be confirmed dead) — no new run starts then. Optional: scripted runners have none.
   */
  paused?(): boolean;
  probe(job: ProbeJob, signal?: AbortSignal): Promise<{ ok: true; info: ProbeInfo } | Fail>;
  download(job: DownloadJob, signal?: AbortSignal): Promise<{ ok: true; file: string; bytes: number } | Fail>;
  /** The download → `out/audio.m4a`. */
  convert(job: ConvertJob, signal?: AbortSignal): Promise<{ ok: true; file: string; bytes: number } | Fail>;
};

/** Where a call's programs read and write, below its working folder. */
export const youtubeFolders = (workdir: string) => ({
  yt: path.join(workdir, "yt"),
  home: path.join(workdir, "yt", "home"),
  dl: path.join(workdir, "yt", "dl"),
  info: path.join(workdir, "yt", "info.json"),
  out: path.join(workdir, "out"),
});

/** The fixed environment of yt-dlp (and the deno it starts). No secret, nothing inherited, no proxy variable. */
export function ytdlpEnv(workdir: string): Record<string, string> {
  const f = youtubeFolders(workdir);
  return {
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    PATH: "/usr/bin:/bin",
    HOME: f.home,
    TMPDIR: path.join(f.home, "tmp"),
    DENO_DIR: path.join(f.home, "deno"),
    DENO_NO_UPDATE_CHECK: "1",
    DENO_NO_PROMPT: "1",
    NO_COLOR: "1",
    SSL_CERT_FILE: SYSTEM_CA_BUNDLE,
  };
}

/** The sandboxed yt-dlp run of one step (exported for the profile tests). */
export function ytdlpOptions(
  job: { env: YoutubeEnv; workdir: string; proxy: { url: string; port: number } },
  stdin: Record<string, unknown>,
  timeoutMs: number,
): RunIsolatedOptions {
  const f = youtubeFolders(job.workdir);
  const { runtime, packages, deno } = job.env;
  return {
    command: runtime.exe,
    // -I: no PYTHON* variables, no user site, no script folder on sys.path. -S: no site-packages. -B: no .pyc.
    args: ["-I", "-S", "-B", YOUTUBE_ENTRY],
    cwd: f.yt,
    env: ytdlpEnv(job.workdir),
    read: [],
    write: [f.yt],
    trusted: [runtime.root, YOUTUBE_DIR, packages, SYSTEM_CA_BUNDLE],
    // yt-dlp → deno (the JS challenge): the one program it may start.
    exec: [deno],
    fork: true,
    network: { loopbackPorts: [job.proxy.port] },
    noFlagChanges: true,
    stdin: JSON.stringify({ packages, deno, proxy: job.proxy.url, ...stdin }),
    timeoutMs,
    maxRssBytes: YOUTUBE_LIMITS.ytdlpMemoryBytes,
    // The probe's summary (80 formats, a 4,000-character description): bounded.
    maxOutputBytes: 2 * 1024 * 1024,
  };
}

/** The ffmpeg run that makes the M4A (exported for the profile tests). */
export function convertOptions(job: ConvertJob): RunIsolatedOptions {
  const f = youtubeFolders(job.workdir);
  // The section as a start and a length (output options: exact, and unambiguous), never over the longest allowed.
  const from = job.start ?? 0;
  const length = Math.min(job.end !== undefined ? job.end - from : Infinity, YOUTUBE_LIMITS.maxSeconds + 1);
  return {
    command: job.env.ffmpeg.exe,
    args: [
      "-nostdin",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      job.input,
      ...(from > 0 ? ["-ss", String(from)] : []),
      // The first audio track only, no metadata (the title and description reach the model framed, not here).
      "-map",
      "0:a:0",
      "-vn",
      "-sn",
      "-dn",
      "-map_metadata",
      "-1",
      "-map_chapters",
      "-1",
      ...(job.copy ? ["-c:a", "copy"] : ["-c:a", "aac", "-b:a", "128k"]),
      "-t",
      String(Math.round(length * 1000) / 1000),
      "-movflags",
      "+faststart",
      "-f",
      "ipod",
      path.join(f.out, "audio.m4a"),
    ],
    cwd: f.out,
    env: { HOME: f.out, LANG: "en_US.UTF-8" },
    read: [f.dl],
    write: [f.out],
    trusted: job.env.ffmpeg.trusted,
    network: "none",
    noFlagChanges: true,
    timeoutMs: YOUTUBE_LIMITS.convertTimeoutMs,
    maxRssBytes: YOUTUBE_LIMITS.convertMemoryBytes,
    maxOutputBytes: 64 * 1024,
  };
}

/** A finished process as an outcome code: the limit it hit. */
export function limitCode(r: RunResult): YoutubeCode | undefined {
  if (r.killed === "timeout") return "youtube_timeout";
  if (r.killed === "memory" || r.killed === "monitor") return "youtube_memory_limit";
  if (r.killed === "aborted") return "youtube_cancelled";
  if (r.killed) return "youtube_failed";
  return undefined;
}

/** The codes `fetch.py` may answer with (anything else is `youtube_failed`). */
const SCRIPT_CODES: ReadonlySet<string> = new Set<YoutubeCode>([
  "youtube_bot_check",
  "youtube_login_required",
  "youtube_live",
  "youtube_unavailable",
  "youtube_no_audio",
  "youtube_too_large",
  "youtube_bad_input",
  "youtube_failed",
]);

const Report = z.union([
  z.looseObject({
    ok: z.literal(true),
    info: z.unknown().optional(),
    file: z.string().optional(),
    bytes: z.number().optional(),
  }),
  z.object({ ok: z.literal(false), error: z.string().max(60) }),
]);

/** The script's report of one step, or why there is none. */
export function scriptReport(
  r: RunResult,
): { ok: true; info?: unknown; file?: string | undefined; bytes?: number | undefined } | Fail {
  const limit = limitCode(r);
  if (limit) return { ok: false, code: limit };
  if (r.code !== 0) return { ok: false, code: "youtube_failed" };
  try {
    const p = Report.safeParse(JSON.parse(r.stdout));
    if (!p.success) return { ok: false, code: "youtube_failed" };
    if (!p.data.ok)
      return {
        ok: false,
        code: SCRIPT_CODES.has(p.data.error) ? (p.data.error as YoutubeCode) : "youtube_failed",
      };
    return p.data;
  } catch {
    return { ok: false, code: "youtube_failed" };
  }
}

/** A regular, non-empty file (not a link, one name): its size, or undefined. */
function plainFile(file: string): number | undefined {
  const st = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!st?.isFile() || st.nlink !== 1 || st.size === 0) return undefined;
  return st.size;
}

/**
 * Which of these processes are still alive with the same start time (`ps -p`, C locale) — a reused pid is not them.
 * Fail closed: when ps cannot answer, all of them count as alive.
 */
export function stillAlive(procs: readonly TreeProc[]): TreeProc[] {
  if (!procs.length) return [];
  const r = spawnSync("/bin/ps", ["-o", "pid=,lstart=", "-p", procs.map((p) => p.pid).join(",")], {
    env: { LC_ALL: "C" },
    encoding: "utf8",
    timeout: 2000,
  });
  if (r.error || r.signal) return [...procs];
  const now = new Map<number, string>();
  for (const l of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\S.*\S)\s*$/.exec(l);
    if (m) now.set(Number(m[1]), m[2]!);
  }
  return procs.filter((p) => now.get(p.pid) === p.start);
}

/** The runner the app uses: every step under `runIsolated` (macOS only). */
export function sandboxedYoutubeRunner(
  o: { run?: typeof runIsolated; alive?: typeof stillAlive } = {},
): YoutubeRunner {
  const run = o.run ?? runIsolated;
  const alive = o.alive ?? stillAlive;
  // Processes of earlier runs that left their group and survived the kill: while any is alive, nothing new runs.
  let survivors: TreeProc[] = [];
  const attempt = async (opts: RunIsolatedOptions, signal?: AbortSignal): Promise<RunResult | Fail> => {
    let r: RunResult;
    try {
      r = await run({ ...opts, ...(signal ? { signal } : {}) });
    } catch {
      // No sandbox here (not macOS), a hard link in an allowed folder, a spawn failure: nothing ran.
      return { ok: false, code: "youtube_server_unavailable" };
    }
    if (r.survivors?.length) survivors = [...survivors, ...r.survivors];
    // A process left the group: whatever the run printed, it failed (its processes were killed).
    if (r.escaped || r.killed === "escaped") return { ok: false, code: "youtube_escaped" };
    return r;
  };
  const isFail = (r: RunResult | Fail): r is Fail => "ok" in r;
  const prepare = (workdir: string) => {
    const f = youtubeFolders(workdir);
    for (const d of [f.yt, f.home, path.join(f.home, "tmp"), f.dl])
      fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    return f;
  };
  return {
    paused() {
      if (survivors.length) survivors = alive(survivors);
      return survivors.length > 0;
    },
    async probe(job, signal) {
      const f = prepare(job.workdir);
      const r = await attempt(
        ytdlpOptions(job, { mode: "probe", url: job.url, info: f.info }, YOUTUBE_LIMITS.probeTimeoutMs),
        signal,
      );
      if (isFail(r)) return r;
      const rep = scriptReport(r);
      if (!rep.ok) return rep;
      const info = ProbeInfo.safeParse(rep.info);
      return info.success ? { ok: true, info: info.data } : { ok: false, code: "youtube_failed" };
    },
    async download(job, signal) {
      const f = prepare(job.workdir);
      const r = await attempt(
        ytdlpOptions(
          job,
          {
            mode: "download",
            info: f.info,
            out: f.dl,
            formatId: job.formatId,
            maxBytes: job.maxBytes ?? YOUTUBE_LIMITS.maxBytes,
          },
          YOUTUBE_LIMITS.downloadTimeoutMs,
        ),
        signal,
      );
      if (isFail(r)) return r;
      const rep = scriptReport(r);
      if (!rep.ok) return rep;
      const name = rep.file ?? "";
      if (!/^audio\.[a-z0-9]{1,8}$/.test(name)) return { ok: false, code: "youtube_failed" };
      const file = path.join(f.dl, name);
      const bytes = plainFile(file);
      if (bytes === undefined) return { ok: false, code: "youtube_failed" };
      if (bytes > (job.maxBytes ?? YOUTUBE_LIMITS.maxBytes)) return { ok: false, code: "youtube_too_large" };
      return { ok: true, file, bytes };
    },
    async convert(job, signal) {
      const f = youtubeFolders(job.workdir);
      fs.mkdirSync(f.out, { recursive: true, mode: 0o700 });
      const r = await attempt(convertOptions(job), signal);
      if (isFail(r)) return r;
      const limit = limitCode(r);
      if (limit) return { ok: false, code: limit === "youtube_failed" ? "youtube_convert_failed" : limit };
      const file = path.join(f.out, "audio.m4a");
      const bytes = r.code === 0 ? plainFile(file) : undefined;
      if (bytes === undefined) return { ok: false, code: "youtube_convert_failed" };
      if (bytes > YOUTUBE_LIMITS.maxBytes) return { ok: false, code: "youtube_too_large" };
      return { ok: true, file, bytes };
    },
  };
}
