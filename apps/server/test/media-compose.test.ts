import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPOSE_LIMITS,
  CSRF_HEADER,
  DEFAULT_MEDIA_SETTINGS,
  FILE_LIMITS,
  MEDIA_TOOL_HINTS,
  type ComposeJob,
  type ComposeTimeline,
  type FileKind,
  type MediaSettings,
  type Run,
} from "@agentlee/shared";
import { COMPOSE_VIDEO_TOOL, MEDIA_TOOLS } from "@agentlee/mcp-tools/media";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { SettingsStore } from "../src/db/settings-store.js";
import { MEDIA_SETTINGS_KEY } from "../src/media/settings.js";
import { knownSecrets } from "../src/secrets/known.js";
import {
  checkTimeline,
  clipArgs,
  concatList,
  cueText,
  isPlanError,
  planTimeline,
  toAss,
  toVtt,
  type InputInfo,
  type Plan,
} from "../src/media/compose-plan.js";
import {
  fixtureComposer,
  judgeInput,
  judgeResult,
  mixPcm,
  sandboxedComposer,
  type Composer,
  type ComposeOutcome,
} from "../src/media/compose-run.js";
import { compose as composeNotification } from "../src/notifications/compose.js";
import { codexRunConfig } from "../src/runtime/lockdown.js";
import { RuntimeRegistry } from "../src/runtime/adapter.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import { storagePaths } from "../src/storage/paths.js";
import { createFamily } from "./helpers/permission-matrix.js";

vi.setConfig({ testTimeout: 120_000 });

/**
 * 멀티미디어 합성 (#238 stage 4-1): `compose_video` queues a job at once (no card, no cost); the engine runs one at a
 * time, puts the conversation's own files together with the real local ffmpeg (tiny synthetic inputs made here) in
 * the sandbox, checks the result and stores it. Never the network, never a real external API.
 */

const FFMPEG = "/opt/homebrew/bin/ffmpeg";
const FFPROBE = "/opt/homebrew/bin/ffprobe";
const HAVE_FFMPEG = process.platform === "darwin" && fs.existsSync(FFMPEG) && fs.existsSync(FFPROBE);

const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const LOCAL = { host: "localhost:3000" };
const WRITE = { ...LOCAL, origin: "http://localhost:3000", [CSRF_HEADER]: "1" };

function tmp(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-compose-")));
  closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Synthetic inputs, made once with the real ffmpeg (outside the server). */
let media:
  | Record<
      | "png"
      | "wide"
      | "video"
      | "mute"
      | "mp3"
      | "wav"
      | "pdf"
      | "late"
      | "shortSound"
      | "anamorphic"
      | "long"
      | "n3"
      | "rgb1fps"
      | "vfr"
      | "bframes"
      | "v1a4"
      | "frame30"
      | "alphaBlue"
      | "alphaRed",
      string
    >
  | undefined;
function inputs() {
  if (media) return media;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-compose-in-")));
  const ff = (...a: string[]) => execFileSync(FFMPEG, ["-hide_banner", "-v", "error", "-y", ...a]);
  ff("-f", "lavfi", "-i", "color=c=red:s=64x48", "-frames:v", "1", path.join(dir, "a.png"));
  ff("-f", "lavfi", "-i", "color=c=blue:s=96x32", "-frames:v", "1", path.join(dir, "wide.png"));
  ff(
    ...["-f", "lavfi", "-i", "testsrc2=s=96x64:r=25:d=1.5", "-f", "lavfi", "-i", "sine=f=440:r=44100:d=1.5"],
    ...["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path.join(dir, "v.mp4")],
  );
  ff(
    "-f",
    "lavfi",
    "-i",
    "testsrc2=s=64x96:r=24:d=1",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    path.join(dir, "m.mp4"),
  );
  ff("-f", "lavfi", "-i", "sine=f=660:r=22050:d=2.3", "-c:a", "libmp3lame", path.join(dir, "n.mp3"));
  ff("-f", "lavfi", "-i", "sine=f=220:r=48000:d=1", "-c:a", "pcm_s16le", path.join(dir, "music.wav"));
  fs.writeFileSync(path.join(dir, "x.pdf"), "%PDF-1.4\n%synthetic\n");
  // Review r1 inputs: a MOV whose sound starts 0.625 s after its picture; an MP4 with 4 s of picture and 1 s of sound;
  // a 720×576 picture shown 16:9 (SAR 64:45); a 310 s video (1 fps, tiny); 3 s of narration.
  ff(
    ...[
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=96x64:r=25:d=2",
      "-itsoffset",
      "0.625",
      "-f",
      "lavfi",
      "-i",
      "sine=f=440:r=44100:d=1",
    ],
    ...[
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      path.join(dir, "late.mov"),
    ],
  );
  ff(
    ...["-f", "lavfi", "-i", "testsrc2=s=96x64:r=25:d=4", "-f", "lavfi", "-i", "sine=f=440:r=44100:d=1"],
    ...[
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      path.join(dir, "short.mp4"),
    ],
  );
  ff(
    ...["-f", "lavfi", "-i", "color=c=green:s=720x576:r=25:d=1,setsar=64/45"],
    ...["-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "ana.mp4")],
  );
  ff(
    ...["-f", "lavfi", "-i", "testsrc2=s=32x32:r=1:d=310"],
    ...["-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "10", path.join(dir, "long.mp4")],
  );
  ff("-f", "lavfi", "-i", "sine=f=330:r=48000:d=3", "-c:a", "libmp3lame", path.join(dir, "n3.mp3"));
  // Review r2 inputs. Colours by time: red, then blue, then green (the frame on screen decides a trim's first frame).
  const rgb = (cut1: number, cut2: number) =>
    `format=rgb24,geq=r='if(lt(T\\,${cut1})\\,255\\,0)':g='if(gte(T\\,${cut2})\\,255\\,0)':b='if(between(T\\,${cut1}\\,${cut2 - 0.001})\\,255\\,0)'`;
  // 1 fps (a slide every second), one keyframe.
  ff(
    "-f",
    "lavfi",
    "-i",
    `nullsrc=s=64x64:r=1:d=3,${rgb(1, 2)}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "30",
    path.join(dir, "rgb1fps.mp4"),
  );
  // Variable frame rate: frames at 0, 0.7 and 2.3 s (red, blue, green), kept as they are.
  const vfr = path.join(dir, "vfr");
  fs.mkdirSync(vfr);
  for (const [c, n] of [
    ["red", "r"],
    ["blue", "b"],
    ["lime", "g"],
  ] as const)
    ff("-f", "lavfi", "-i", `color=c=${c}:s=64x64`, "-frames:v", "1", path.join(vfr, `${n}.png`));
  fs.writeFileSync(
    path.join(vfr, "list.txt"),
    "ffconcat version 1.0\nfile 'r.png'\nduration 0.7\nfile 'b.png'\nduration 1.6\nfile 'g.png'\nduration 1\nfile 'g.png'\n",
  );
  ff(
    "-f",
    "concat",
    "-i",
    path.join(vfr, "list.txt"),
    "-fps_mode",
    "vfr",
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    path.join(dir, "vfr.mp4"),
  );
  // 30 fps with B-frames (x264's default), red until 1 s, then blue (green never).
  ff(
    "-f",
    "lavfi",
    "-i",
    `nullsrc=s=64x64:r=30:d=2,${rgb(1, 9)}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-bf",
    "3",
    path.join(dir, "bframes.mp4"),
  );
  // 1 s of picture with 4 s of sound; exactly 1 s at 30 fps (30 frames).
  ff(
    ...["-f", "lavfi", "-i", "testsrc2=s=64x64:r=30:d=1", "-f", "lavfi", "-i", "sine=f=440:r=48000:d=4"],
    ...["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(dir, "v1a4.mp4")],
  );
  ff(
    "-f",
    "lavfi",
    "-i",
    `nullsrc=s=64x64:r=30:d=1,${rgb(0.95, 9)}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    path.join(dir, "frame30.mp4"),
  );
  // Fully transparent PNGs whose hidden colours differ.
  ff(
    "-f",
    "lavfi",
    "-i",
    "color=c=blue@0.0:s=64x64,format=rgba",
    "-frames:v",
    "1",
    path.join(dir, "alpha-blue.png"),
  );
  ff(
    "-f",
    "lavfi",
    "-i",
    "color=c=red@0.0:s=64x64,format=rgba",
    "-frames:v",
    "1",
    path.join(dir, "alpha-red.png"),
  );
  media = {
    late: path.join(dir, "late.mov"),
    shortSound: path.join(dir, "short.mp4"),
    anamorphic: path.join(dir, "ana.mp4"),
    long: path.join(dir, "long.mp4"),
    n3: path.join(dir, "n3.mp3"),
    rgb1fps: path.join(dir, "rgb1fps.mp4"),
    vfr: path.join(dir, "vfr.mp4"),
    bframes: path.join(dir, "bframes.mp4"),
    v1a4: path.join(dir, "v1a4.mp4"),
    frame30: path.join(dir, "frame30.mp4"),
    alphaBlue: path.join(dir, "alpha-blue.png"),
    alphaRed: path.join(dir, "alpha-red.png"),
    png: path.join(dir, "a.png"),
    wide: path.join(dir, "wide.png"),
    video: path.join(dir, "v.mp4"),
    mute: path.join(dir, "m.mp4"),
    mp3: path.join(dir, "n.mp3"),
    wav: path.join(dir, "music.wav"),
    pdf: path.join(dir, "x.pdf"),
  };
  return media;
}

const composeOn = (more: Partial<MediaSettings> = {}): MediaSettings => ({
  ...structuredClone(DEFAULT_MEDIA_SETTINGS),
  composeEnabled: true,
  ...more,
});

async function start(
  o: {
    composer?: (dataDir: string) => Composer | undefined;
    engine?: boolean;
    limits?: Record<string, unknown>;
    settings?: MediaSettings;
  } = {},
) {
  const dataDir = path.join(tmp(), "data");
  fs.mkdirSync(dataDir, { recursive: true });
  const registry = new RuntimeRegistry();
  registry.register(new FakeRuntime({ runTools: true }));
  const db = createTestDb();
  const made = (o.composer ?? ((d: string) => fixtureComposer(d, { stepMs: 5 })))(dataDir);
  const app = await buildApp(
    loadConfig({ NODE_ENV: "test", DATA_DIR: dataDir, MASTER_KEY_PATH: path.join(tmp(), "master.key") }),
    {
      db,
      runtimes: registry,
      runs: { flushMs: 0 },
      media: {
        compose: {
          start: o.engine ?? true,
          composer: () => made,
          // The engine is driven by hand (`tick`): no timer fires on its own.
          limits: { tickMs: 3_600_000, ...o.limits },
        },
      },
    },
  );
  closers.push(() => app.close());
  await app.ready();
  const f = await createFamily(app);
  app.media!.settings.set(o.settings ?? composeOn());
  const jobs = app.media!.compose;
  if (o.engine ?? true) await jobs.checkReady();
  const api = (cookie: string, method: "POST" | "GET" | "DELETE", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { ...WRITE, cookie, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  const send = async (conversationId: string, text: string, cookie = f.cookies.owner) => {
    const res = await api(cookie, "POST", `/api/conversations/${conversationId}/messages`, { text });
    expect(res.statusCode, res.body).toBe(201);
    const runId = (res.json() as { run: Run }).run.id;
    for (let i = 0; i < 2000 && app.runs!.get(runId)!.endedAt === null; i++)
      await new Promise((r) => setTimeout(r, 10));
    return app.runs!.get(runId)!;
  };
  /** A run of the user that is still open (the tool works only for an open run). */
  const scopeOf = async (
    who: "owner" | "shared" | "stranger" | "admin" = "owner",
    conversationId?: string,
  ) => {
    const user = f.users[who];
    const conv = conversationId ?? app.conversations!.create(user.id).id;
    const r = await send(conv, "안녕", f.cookies[who]);
    db.$client.prepare("UPDATE runs SET ended_at = NULL WHERE id = ?").run(r.id);
    return { userId: user.id, conversationId: conv, runId: r.id, messageId: r.assistantMessageId };
  };
  /** A file of the conversation made in the run's reply (an active message): its id. */
  const putFile = async (
    scope: { userId: string; conversationId: string; messageId: string },
    src: string,
    kind: FileKind,
  ) => {
    const bytes = fs.readFileSync(src);
    const tmpFile = app.files!.tempFile();
    fs.writeFileSync(tmpFile, bytes);
    const row = await app.files!.addGenerated({
      userId: scope.userId,
      conversationId: scope.conversationId,
      messageId: scope.messageId,
      name: `input.${kind}`,
      kind,
      bytes: bytes.length,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      tmp: tmpFile,
    });
    return row.id;
  };
  const call = (scope: { userId: string; conversationId: string; runId: string }, timeline: unknown) =>
    app.media!.tools.run("compose", scope, { timeline });
  const queue = async (
    scope: { userId: string; conversationId: string; runId: string },
    timeline: unknown,
  ) => {
    const r = await call(scope, timeline);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return (r as { output: { jobId: string } }).output.jobId;
  };
  const job = (id: string) => jobs.get(id)!;
  /** One engine pass and the job it started, to its end. */
  const drive = async () => {
    await jobs.tick();
    await jobs.idle();
  };
  const scratch = () => {
    const root = storagePaths(dataDir).composeScratch;
    return fs.existsSync(root) ? fs.readdirSync(root) : [];
  };
  return {
    app,
    db,
    f,
    api,
    jobs,
    scopeOf,
    putFile,
    call,
    queue,
    job,
    drive,
    scratch,
    dataDir,
    composer: made,
  };
}

const probeJson = (file: string) =>
  JSON.parse(
    execFileSync(FFPROBE, [
      "-v",
      "error",
      "-count_packets",
      "-show_entries",
      "format=format_name:stream=codec_type,codec_name,width,height,nb_read_packets,duration",
      "-of",
      "json",
      file,
    ]).toString(),
  ) as {
    format: { format_name: string };
    streams: {
      codec_type: string;
      codec_name: string;
      width?: number;
      height?: number;
      nb_read_packets?: string;
      duration?: string;
    }[];
  };

// ---------------------------------------------------------------- the plan (pure)

const info = (fileId: string, o: Partial<InputInfo> & Pick<InputInfo, "kind">): InputInfo => ({
  fileId,
  fileKind: o.kind === "image" ? "png" : o.kind === "video" ? "mp4" : "mp3",
  name: `in-${fileId}.x`,
  durationSec: o.kind === "image" ? null : 2,
  hasVideo: o.kind !== "audio",
  hasAudio: o.kind !== "image",
  width: o.kind === "audio" ? null : 64,
  height: o.kind === "audio" ? null : 64,
  ...o,
});
const ins = (...xs: InputInfo[]) => new Map(xs.map((x) => [x.fileId, x]));

describe("the plan (review R1–R3)", () => {
  it("whole frames; a transition overlaps the clips by its frames: offset = length so far − overlap", () => {
    const p = planTimeline(
      {
        clips: [
          { fileId: "a", durationSec: 2, transition: { type: "fade", durationSec: 0.5 } },
          { fileId: "v", transition: { type: "wipeleft", durationSec: 0.4 } },
          { fileId: "b", durationSec: 1.01 },
        ],
      },
      ins(info("a", { kind: "image" }), info("v", { kind: "video" }), info("b", { kind: "image" })),
    ) as Plan;
    expect(isPlanError(p)).toBe(false);
    expect(p.clips.map((c) => [c.frames, c.head, c.tail, c.at])).toEqual([
      [60, 0, 15, 0],
      [60, 15, 12, 45],
      [30, 12, 0, 93],
    ]);
    expect(p.frames).toBe(60 + 60 + 30 - 15 - 12);
    expect(p.samples).toBe(p.frames * 1600);
    expect([p.width, p.height]).toEqual([1280, 720]);
  });

  it("narration longer than the pictures holds the last one (user decision 4), still within 5 minutes", () => {
    const p = planTimeline(
      { clips: [{ fileId: "a", durationSec: 1 }], narration: [{ fileId: "n", startSec: 0.5 }] },
      ins(info("a", { kind: "image" }), info("n", { kind: "audio", durationSec: 2.3 })),
    ) as Plan;
    expect(p.held).toBe(Math.ceil(2.8 * 30) - 30);
    expect(p.frames).toBe(Math.ceil(2.8 * 30));
    expect(p.clips[0]!.frames).toBe(p.frames);
    expect(p.narration[0]).toMatchObject({ startSample: 24_000, maxSamples: p.samples - 24_000 });
    const long = planTimeline(
      { clips: [{ fileId: "a", durationSec: 1 }], narration: [{ fileId: "n", startSec: 299 }] },
      ins(info("a", { kind: "image" }), info("n", { kind: "audio", durationSec: 2 })),
    );
    expect(long).toMatchObject({ code: "compose_too_long" });
  });

  it("refuses what does not hold, saying where (review R1, R5)", () => {
    const I = ins(
      info("a", { kind: "image" }),
      info("v", { kind: "video", durationSec: 3 }),
      info("n", { kind: "audio" }),
      info("mute", { kind: "video", hasAudio: false }),
    );
    const bad = (t: unknown) => planTimeline(t as ComposeTimeline, I);
    expect(
      bad({ clips: [{ fileId: "a", durationSec: 1, transition: { type: "fade", durationSec: 0.5 } }] }),
    ).toMatchObject({
      code: "compose_invalid_timeline",
      hint: expect.stringContaining("clips[0].transition"),
    });
    expect(bad({ clips: [{ fileId: "a" }] })).toMatchObject({ hint: expect.stringContaining("durationSec") });
    expect(bad({ clips: [{ fileId: "a", durationSec: 31 }] })).toMatchObject({
      code: "compose_invalid_timeline",
    });
    expect(bad({ clips: [{ fileId: "a", durationSec: 1, trim: { startSec: 0, endSec: 1 } }] })).toMatchObject(
      {
        hint: expect.stringContaining("trim"),
      },
    );
    expect(bad({ clips: [{ fileId: "v", kenBurns: "in" }] })).toMatchObject({
      hint: expect.stringContaining("kenBurns"),
    });
    expect(bad({ clips: [{ fileId: "v", trim: { startSec: 1, endSec: 5 } }] })).toMatchObject({
      hint: expect.stringContaining("trim.endSec"),
    });
    // A transition as long as a clip; two transitions together longer than the clip between them.
    expect(
      bad({
        clips: [
          { fileId: "a", durationSec: 0.5, transition: { type: "fade", durationSec: 0.5 } },
          { fileId: "a", durationSec: 2 },
        ],
      }),
    ).toMatchObject({ hint: expect.stringContaining("shorter than both") });
    expect(
      bad({
        clips: [
          { fileId: "a", durationSec: 2, transition: { type: "fade", durationSec: 1 } },
          { fileId: "a", durationSec: 2, transition: { type: "fade", durationSec: 1.5 } },
          { fileId: "a", durationSec: 2 },
        ],
      }),
    ).toMatchObject({ hint: expect.stringContaining("clips[1]") });
    expect(bad({ clips: [{ fileId: "n" }] })).toMatchObject({ code: "compose_input_kind" });
    expect(
      bad({ clips: [{ fileId: "a", durationSec: 1 }], narration: [{ fileId: "mute", startSec: 0 }] }),
    ).toMatchObject({
      code: "compose_input_kind",
    });
    expect(bad({ clips: [{ fileId: "zz", durationSec: 1 }] })).toMatchObject({
      code: "compose_input_missing",
    });
    // 40 clips of 8 s: over 5 minutes.
    expect(bad({ clips: Array.from({ length: 40 }, () => ({ fileId: "a", durationSec: 8 })) })).toMatchObject(
      {
        code: "compose_too_long",
      },
    );
    // Subtitles: in order, no overlap, within the video.
    expect(
      checkTimeline({
        clips: [{ fileId: "a", durationSec: 3 }],
        subtitles: [
          { startSec: 0, endSec: 1.5, text: "a" },
          { startSec: 1, endSec: 2, text: "b" },
        ],
      }),
    ).toMatchObject({ hint: expect.stringContaining("subtitles[1]") });
    expect(
      bad({
        clips: [{ fileId: "a", durationSec: 1 }],
        subtitles: [{ startSec: 0.5, endSec: 1.5, text: "x" }],
      }),
    ).toMatchObject({
      hint: expect.stringContaining("subtitles[0].endSec"),
    });
  });

  it("subtitles: one text for both tracks — no tags, no override codes, no cue arrow; VTT escapes", () => {
    expect(cueText("  <b>안녕</b> {\\an8}세계\r\n\r\n둘째 --> 줄 \\N ")).toBe("안녕 세계\n둘째 → 줄 ＼N");
    // Review r1: plain braces are text — only an override block (`{\…}`) is control syntax.
    expect(cueText("집합 {1, 2}와 한국어")).toBe("집합 {1, 2}와 한국어");
    expect(toVtt([{ startSec: 0, endSec: 1, text: "집합 {1, 2}" }])).toContain("\n집합 {1, 2}\n");
    const subs = [
      { startSec: 0.25, endSec: 1, text: "A & B < C" },
      { startSec: 61.5, endSec: 3725.004, text: "<i></i>" },
      { startSec: 62, endSec: 63, text: "끝" },
    ];
    // A cue that is only tags is dropped; a lone "<" is text; lines joined with ASS's own break (review r2: the mux
    // reads ASS, which takes "<", ">" and "&" as they are).
    const ass = toAss([...subs, { startSec: 64, endSec: 65, text: "첫 줄\n둘째, 줄" }]);
    expect(ass.split("\n").filter((l) => l.startsWith("Dialogue:"))).toEqual([
      "Dialogue: 0,0:00:00.25,0:00:01.00,Default,,0,0,0,,A & B < C",
      "Dialogue: 0,0:01:02.00,0:01:03.00,Default,,0,0,0,,끝",
      "Dialogue: 0,0:01:04.00,0:01:05.00,Default,,0,0,0,,첫 줄\\N둘째, 줄",
    ]);
    expect(toVtt([{ startSec: 0, endSec: 1, text: "A & B > C" }])).toBe(
      "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nA &amp; B &gt; C\n",
    );
  });

  it("the arguments are the server's own: named demuxers, local files and the progress pipe only", () => {
    const p = planTimeline(
      {
        clips: [{ fileId: "a", durationSec: 1, kenBurns: "left", fit: "crop" }],
        output: { resolution: "1080p", aspectRatio: "9:16" },
      },
      ins(info("a", { kind: "image" })),
    ) as Plan;
    const args = clipArgs(p, 0, "/in");
    expect(args).toContain("png_pipe");
    expect(args[args.indexOf("-protocol_whitelist") + 1]).toBe("file,pipe");
    expect(args.join(" ")).toContain("zoompan=");
    // Ken Burns works on a frame twice the output's size, then zooms down to it.
    expect(args.join(" ")).toContain("crop=2160:3840");
    expect(args.join(" ")).toContain("s=1080x1920");
    expect([p.width, p.height]).toEqual([1080, 1920]);
  });

  it("the clips' sound: two crossfading clips add up to one, sample-exact", async () => {
    const dir = tmp();
    const pcm = (file: string, n: number, v: number) => {
      const b = Buffer.alloc(n * 4);
      for (let i = 0; i < n; i++) {
        b.writeInt16LE(v, i * 4);
        b.writeInt16LE(v, i * 4 + 2);
      }
      fs.writeFileSync(path.join(dir, file), b);
    };
    pcm("a.pcm", 100, 1000);
    pcm("b.pcm", 100, 1000);
    await mixPcm(path.join(dir, "out.pcm"), 150, [
      { file: path.join(dir, "a.pcm"), start: 0, length: 100, fadeIn: 0, fadeOut: 50 },
      { file: path.join(dir, "b.pcm"), start: 50, length: 100, fadeIn: 50, fadeOut: 0 },
    ]);
    const out = fs.readFileSync(path.join(dir, "out.pcm"));
    expect(out.length).toBe(150 * 4);
    for (const i of [0, 49, 50, 75, 99, 100, 149]) expect(out.readInt16LE(i * 4)).toBe(1000);
  });

  it("ffprobe's reports judged: an input of the right kind; the result's streams and lengths (review R5, R11)", () => {
    expect(
      judgeInput(JSON.stringify({ streams: [{ codec_type: "video", width: 64, height: 48 }] }), "png"),
    ).toMatchObject({
      ok: true,
      info: { kind: "image", width: 64 },
    });
    expect(
      judgeInput(JSON.stringify({ streams: [{ codec_type: "video", width: 9000, height: 48 }] }), "png"),
    ).toEqual({
      ok: false,
      reason: "unreadable",
    });
    expect(
      judgeInput(JSON.stringify({ format: { duration: "2.5" }, streams: [{ codec_type: "audio" }] }), "mp3"),
    ).toMatchObject({
      ok: true,
      info: { kind: "audio", durationSec: 2.5 },
    });
    expect(judgeInput("{}", "pdf")).toEqual({ ok: false, reason: "kind" });
    const plan = { width: 1280, height: 720, frames: 60, samples: 96_000 } as Plan;
    const report = (o: { packets?: number; audio?: number; subs?: boolean; brand?: string }) =>
      JSON.stringify({
        format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", tags: { major_brand: o.brand ?? "isom" } },
        streams: [
          {
            codec_type: "video",
            codec_name: "h264",
            width: 1280,
            height: 720,
            nb_read_packets: String(o.packets ?? 60),
          },
          { codec_type: "audio", codec_name: "aac", duration: String(o.audio ?? 2) },
          ...(o.subs ? [{ codec_type: "subtitle", codec_name: "mov_text" }] : []),
        ],
      });
    expect(judgeResult(report({}), plan, false)).toBe(true);
    expect(judgeResult(report({ packets: 61 }), plan, false)).toBe(true);
    expect(judgeResult(report({ packets: 62 }), plan, false)).toBe(false);
    expect(judgeResult(report({ audio: 2.2 }), plan, false)).toBe(false);
    expect(judgeResult(report({ subs: true }), plan, true)).toBe(true);
    expect(judgeResult(report({}), plan, true)).toBe(false);
    expect(judgeResult(report({ brand: "qt  " }), plan, false)).toBe(false);
  });
});

// ---------------------------------------------------------------- the tool, the queue, the engine (fixture composer)

describe("compose_video: the call and the queue", () => {
  it("offered only with the admin's switch on and the local readiness; no model or key needed (review R9)", async () => {
    const t = await start({ settings: structuredClone(DEFAULT_MEDIA_SETTINGS) });
    const names = () => t.app.mcp!.toolNamesFor(t.f.users.owner.id);
    expect(MEDIA_TOOLS).toContain(COMPOSE_VIDEO_TOOL);
    expect(names()).not.toContain("compose_video");
    const scope = await t.scopeOf();
    expect(await t.call(scope, { clips: [{ fileId: "x", durationSec: 1 }] })).toMatchObject({
      ok: false,
      code: "compose_disabled",
      hint: MEDIA_TOOL_HINTS.compose_disabled,
    });
    t.app.media!.settings.set(composeOn());
    expect(names()).toContain("compose_video");
    // A stored settings row from before stage 4 (no compose fields) reads with the defaults.
    new SettingsStore(t.db, crypto.randomBytes(32)).set(
      MEDIA_SETTINGS_KEY,
      JSON.stringify({
        ...DEFAULT_MEDIA_SETTINGS,
        composeEnabled: undefined,
        perRunLimits: { image: 4, speech: 3, music: 1, video: 1 },
      }),
    );
    expect(t.app.media!.settings.get()).toMatchObject({
      composeEnabled: false,
      perRunLimits: { compose: 1 },
    });
    // Not ready here (no ffmpeg): not offered, and a call is refused.
    const u = await start({ composer: () => ({ ...fixtureComposer(tmp()), ready: async () => false }) });
    expect(u.app.mcp!.toolNamesFor(u.f.users.owner.id)).not.toContain("compose_video");
    expect(
      (
        await u.app.inject({
          method: "GET",
          url: "/api/admin/media",
          headers: { ...LOCAL, cookie: u.f.cookies.admin },
        })
      ).json(),
    ).toMatchObject({
      compose: { ready: false },
    });
    // The Codex tool budget covers the preparation.
    const toml = codexRunConfig({
      model: "m",
      tools: ["compose_video"],
      mcp: { url: "http://127.0.0.1:4000/mcp", token: "t" },
    }).join("\n");
    expect(toml).toMatch(/tool_timeout_sec = (1[5-9][0-9]|2[0-9]{2})/);
  });

  it("queues at once; the job runs, is stored as a file of the reply, plays inline and notifies (fixture)", async () => {
    const t = await start();
    const scope = await t.scopeOf();
    const img = await t.putFile(scope, inputsOrFake().png, "png");
    const r = await t.call(scope, {
      clips: [{ fileId: img, durationSec: 2 }],
      subtitles: [{ startSec: 0, endSec: 1.5, text: "첫 장면 <b>안녕</b>" }],
    });
    expect(r).toMatchObject({
      ok: true,
      output: { status: "queued", queuePosition: 1, durationSec: 2, width: 1280, height: 720 },
    });
    const id = (r as { output: { jobId: string } }).output.jobId;
    expect(t.job(id)).toMatchObject({ status: "queued", subtitles: true, messageId: scope.messageId });
    // The queued job holds a file place (review R8).
    expect(t.app.files!.placesTaken(scope.conversationId)).toBe(2);
    expect(t.scratch()).toEqual([id]);
    await t.drive();
    const done = t.job(id);
    expect(done).toMatchObject({ status: "done", progress: 100 });
    expect(t.scratch()).toEqual([]);
    const file = t.app.files!.get(done.fileId!)!;
    expect(file).toMatchObject({
      kind: "mp4",
      messageId: scope.messageId,
      conversationId: scope.conversationId,
    });
    expect(t.app.files!.placesTaken(scope.conversationId)).toBe(2);
    expect(t.app.files!.isVerifiedVideo(file.id)).toBe(true);
    const view = (await t.api(t.f.cookies.owner, "GET", `/api/compose-jobs/${id}`)).json() as ComposeJob;
    expect(view).toMatchObject({
      status: "done",
      file: { fileId: file.id },
      subtitles: true,
      errorCode: null,
    });
    const inline = await t.api(t.f.cookies.owner, "GET", `/api/files/${file.id}/content?inline=1`);
    expect(inline.statusCode).toBe(200);
    expect(String(inline.headers["content-disposition"])).toMatch(/^inline/);
    const vtt = await t.api(t.f.cookies.owner, "GET", `/api/compose-jobs/${id}/subtitles.vtt`);
    expect(vtt.statusCode).toBe(200);
    expect(vtt.headers["content-type"]).toMatch(/^text\/vtt/);
    expect(vtt.body).toBe("WEBVTT\n\n00:00:00.000 --> 00:00:01.500\n첫 장면 안녕\n");
    // Not someone else's.
    expect((await t.api(t.f.cookies.stranger, "GET", `/api/compose-jobs/${id}`)).statusCode).toBe(403);
    expect((await t.api(t.f.cookies.shared, "GET", `/api/compose-jobs/${id}/subtitles.vtt`)).statusCode).toBe(
      403,
    );
    const n = t.db.$client
      .prepare("SELECT kind, body, url FROM notifications WHERE user_id = ?")
      .all(scope.userId) as {
      kind: string;
      body: string;
      url: string;
    }[];
    expect(n).toEqual([
      {
        kind: "compose_done",
        body: expect.stringContaining("합성한 영상"),
        url: `/c/${scope.conversationId}`,
      },
    ]);
    expect(t.job(id).notifiedAt).not.toBeNull();
    // The run's per-run limit (default 1).
    expect(await t.call(scope, { clips: [{ fileId: img, durationSec: 1 }] })).toMatchObject({
      ok: false,
      code: "media_quota",
    });
  });

  it("one per user, the waiting ones capped — refused at once (user decision 3)", async () => {
    expect(COMPOSE_LIMITS.slots).toEqual({ running: 1, waiting: 3, perUser: 1 });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    // The family has four accounts: with one running, a cap of 2 waiting is reached by the fourth.
    const t = await start({
      limits: { slots: { running: 1, waiting: 2, perUser: 1 } },
      composer: (d) => {
        const base = fixtureComposer(d, { stepMs: 1 });
        return { ...base, compose: async (job) => (await gate, base.compose(job)) };
      },
    });
    const make = async (who: "owner" | "shared" | "stranger" | "admin") => {
      const s = await t.scopeOf(who);
      return { s, img: await t.putFile(s, inputsOrFake().png, "png") };
    };
    const a = await make("owner");
    await t.queue(a.s, { clips: [{ fileId: a.img, durationSec: 1 }] });
    await new Promise((r) => setTimeout(r, 20));
    const a2 = await t.scopeOf("owner");
    const img2 = await t.putFile(a2, inputsOrFake().png, "png");
    expect(await t.call(a2, { clips: [{ fileId: img2, durationSec: 1 }] })).toMatchObject({
      ok: false,
      code: "compose_busy",
    });
    const b = await make("shared");
    const c = await make("stranger");
    await t.queue(b.s, { clips: [{ fileId: b.img, durationSec: 1 }] });
    await t.queue(c.s, { clips: [{ fileId: c.img, durationSec: 1 }] });
    const d = await make("admin");
    expect(await t.call(d.s, { clips: [{ fileId: d.img, durationSec: 1 }] })).toMatchObject({
      ok: false,
      code: "compose_busy",
    });
    // Refused calls leave nothing: no row, no folder.
    expect(t.db.$client.prepare("SELECT count(*) n FROM compose_jobs").get()).toEqual({ n: 3 });
    expect(t.scratch()).toHaveLength(3);
    // One runs at a time; the others wait their turn in order.
    const first = t.db.$client.prepare("SELECT id FROM compose_jobs ORDER BY created_at, id").all() as {
      id: string;
    }[];
    const views = first.map((r) => t.jobs.view(t.job(r.id)));
    expect(views.map((v) => [v.status, v.queuePosition])).toEqual([
      ["running", null],
      ["queued", 1],
      ["queued", 2],
    ]);
    release!();
    await t.jobs.idle();
    for (let i = 0; i < 3; i++) await t.drive();
    expect(first.map((r) => t.job(r.id).status)).toEqual(["done", "done", "done"]);
  });

  it("refuses inputs that are not this conversation's, of the wrong kind, a secret, a bad timeline — before anything", async () => {
    const t = await start();
    const scope = await t.scopeOf();
    const other = await t.scopeOf();
    const img = await t.putFile(scope, inputsOrFake().png, "png");
    const foreign = await t.putFile(other, inputsOrFake().png, "png");
    const pdf = await t.putFile(scope, inputsOrFake().pdf, "pdf");
    const audio = await t.putFile(scope, inputsOrFake().mp3, "mp3");
    expect(await t.call(scope, { clips: [{ fileId: foreign, durationSec: 1 }] })).toMatchObject({
      code: "compose_input_missing",
      hint: expect.stringContaining("clips[0].fileId"),
    });
    expect(await t.call(scope, { clips: [{ fileId: pdf, durationSec: 1 }] })).toMatchObject({
      code: "compose_input_kind",
    });
    expect(await t.call(scope, { clips: [{ fileId: audio }] })).toMatchObject({ code: "compose_input_kind" });
    expect(await t.call(scope, { clips: [] })).toMatchObject({
      code: "compose_invalid_timeline",
      hint: expect.stringContaining("clips"),
    });
    expect(await t.call(scope, { clips: [{ fileId: img, durationSec: 1, extra: 1 }] })).toMatchObject({
      code: "compose_invalid_timeline",
    });
    expect(
      await t.call(scope, {
        clips: [{ fileId: img, durationSec: 1, transition: { type: "fade", durationSec: 0.5 } }],
      }),
    ).toMatchObject({ code: "compose_invalid_timeline", hint: expect.stringContaining("last clip") });
    // A known secret in a subtitle: no job (review R12).
    const secret = "sk-or-v1-synthetic-compose-0000000000000000000000000000";
    knownSecrets.add(secret);
    closers.push(() => knownSecrets.remove(secret));
    expect(
      await t.call(scope, {
        clips: [{ fileId: img, durationSec: 1 }],
        subtitles: [{ startSec: 0, endSec: 1, text: `키 ${secret}` }],
      }),
    ).toMatchObject({ ok: false, code: "media_secret_blocked" });
    expect(t.db.$client.prepare("SELECT count(*) n FROM compose_jobs").get()).toEqual({ n: 0 });
    expect(t.scratch()).toEqual([]);
    // A run that ended: not allowed.
    t.db.$client.prepare("UPDATE runs SET ended_at = 1 WHERE id = ?").run(scope.runId);
    expect(await t.call(scope, { clips: [{ fileId: img, durationSec: 1 }] })).toMatchObject({
      code: "media_not_allowed",
    });
  });

  it("the conversation's last file place: refused (media_file_limit)", async () => {
    const t = await start();
    const scope = await t.scopeOf();
    const img = await t.putFile(scope, inputsOrFake().png, "png");
    for (let i = 1; i < FILE_LIMITS.perConversation; i++) await t.putFile(scope, inputsOrFake().png, "png");
    expect(await t.call(scope, { clips: [{ fileId: img, durationSec: 1 }] })).toMatchObject({
      code: "media_file_limit",
    });
  });

  it("a restart: every job not ended of the last process is interrupted and notified; its folders go", async () => {
    const t = await start({ engine: false });
    const scope = await t.scopeOf();
    const insert = (status: string) => {
      const id = crypto.randomUUID();
      fs.mkdirSync(path.join(storagePaths(t.dataDir).composeScratch, id, "in"), { recursive: true });
      t.db.$client
        .prepare(
          `INSERT INTO compose_jobs (id, conversation_id, owner_id, message_id, run_id, status, timeline_json, duration_ms,
             width, height, clips, subtitles, boot, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, '{}', 1000, 1280, 720, 1, 0, 'oldboot', 1, 1)`,
        )
        .run(id, scope.conversationId, scope.userId, scope.messageId, scope.runId, status);
      return id;
    };
    const ids = ["preparing", "queued", "running"].map(insert);
    expect(t.app.files!.placesTaken(scope.conversationId)).toBe(3);
    t.jobs.start();
    await t.jobs.tick();
    for (const id of ids)
      expect(t.job(id)).toMatchObject({ status: "failed", errorCode: "compose_interrupted" });
    expect(t.app.files!.placesTaken(scope.conversationId)).toBe(0);
    expect(t.scratch()).toEqual([]);
    const n = t.db.$client
      .prepare("SELECT kind, body FROM notifications WHERE user_id = ?")
      .all(scope.userId) as {
      kind: string;
      body: string;
    }[];
    expect(n).toHaveLength(3);
    expect(n.every((x) => x.kind === "compose_failed" && x.body.includes("서버 재시작"))).toBe(true);
    // Never run again by itself.
    await t.drive();
    expect(ids.map((id) => t.job(id).status)).toEqual(["failed", "failed", "failed"]);
  });

  it("a deleted conversation stops its job and keeps nothing; an input deleted after the call still composes", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const t = await start({
      composer: (d) => {
        const base = fixtureComposer(d, { stepMs: 5 });
        return {
          ...base,
          compose: async (job) => {
            await Promise.race([gate, new Promise((r) => job.signal.addEventListener("abort", r))]);
            return base.compose(job);
          },
        };
      },
    });
    const scope = await t.scopeOf();
    const img = await t.putFile(scope, inputsOrFake().png, "png");
    const id = await t.queue(scope, { clips: [{ fileId: img, durationSec: 1 }] });
    void t.jobs.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.job(id).status).toBe("running");
    expect(
      (await t.api(t.f.cookies.owner, "DELETE", `/api/conversations/${scope.conversationId}`)).statusCode,
    ).toBeLessThan(300);
    await t.jobs.idle();
    expect(t.jobs.get(id)).toBeUndefined();
    expect(t.scratch()).toEqual([]);
    expect(
      t.db.$client
        .prepare("SELECT count(*) n FROM files WHERE conversation_id = ?")
        .get(scope.conversationId),
    ).toEqual({ n: 0 });
    // The copy is the job's own: the original going away changes nothing.
    const s2 = await t.scopeOf();
    const img2 = await t.putFile(s2, inputsOrFake().png, "png");
    const id2 = await t.queue(s2, { clips: [{ fileId: img2, durationSec: 1 }] });
    fs.rmSync(t.app.files!.pathOf(t.app.files!.get(img2)!));
    t.db.$client.prepare("DELETE FROM files WHERE id = ?").run(img2);
    release!();
    await t.drive();
    expect(t.job(id2).status).toBe("done");
  });

  it("30 minutes at most (a short limit here): compose_timeout; a composition that fails is compose_failed", async () => {
    const t = await start({
      limits: { timeoutMs: 30 },
      composer: (d) => fixtureComposer(d, { stepMs: 50 }),
    });
    const scope = await t.scopeOf();
    const img = await t.putFile(scope, inputsOrFake().png, "png");
    const id = await t.queue(scope, { clips: [{ fileId: img, durationSec: 1 }] });
    await t.drive();
    expect(t.job(id)).toMatchObject({ status: "failed", errorCode: "compose_timeout" });
    expect(t.scratch()).toEqual([]);
    let outcome: ComposeOutcome | undefined = { ok: false, code: "compose_verify_failed" };
    const u = await start({ composer: (d) => fixtureComposer(d, { stepMs: 1, outcome: () => outcome }) });
    const s = await u.scopeOf();
    const i2 = await u.putFile(s, inputsOrFake().png, "png");
    const j = await u.queue(s, { clips: [{ fileId: i2, durationSec: 1 }] });
    await u.drive();
    expect(u.job(j)).toMatchObject({ status: "failed", errorCode: "compose_verify_failed" });
    outcome = undefined;
    expect(
      composeNotification({ kind: "compose_failed", reason: "결과 확인 실패", url: "/c/x" }).body,
    ).toContain("결과 확인 실패");
  });
});

describe("review r1: the engine's state (fixture composer)", () => {
  it("P1: a failed `done` write ends the job (compose_store_failed) and frees the one running slot", async () => {
    const t = await start();
    const a = await t.scopeOf("owner");
    const b = await t.scopeOf("shared");
    const ia = await t.putFile(a, inputsOrFake().png, "png");
    const ib = await t.putFile(b, inputsOrFake().png, "png");
    const files = t.app.files!;
    const orig = files.addGenerated.bind(files);
    // The first composition's `done` write fails once (the database, for now).
    const spy = vi.spyOn(files, "addGenerated").mockImplementationOnce(async (input) =>
      orig({
        ...input,
        video: {
          ...input.video!,
          commit: () => {
            throw new Error("synthetic write failure");
          },
        },
      }),
    );
    const ja = await t.queue(a, { clips: [{ fileId: ia, durationSec: 1 }] });
    await t.jobs.idle();
    const jb = await t.queue(b, { clips: [{ fileId: ib, durationSec: 1 }] });
    for (let i = 0; i < 3; i++) await t.drive();
    spy.mockRestore();
    expect(t.job(ja)).toMatchObject({ status: "failed", errorCode: "compose_store_failed", fileId: null });
    expect(t.job(jb).status).toBe("done");
    expect(t.app.files!.placesTaken(a.conversationId)).toBe(1);
  });

  it("a job whose end could not be written at all is reaped by the next pass (never a stuck slot)", async () => {
    const t = await start();
    const a = await t.scopeOf();
    const id = crypto.randomUUID();
    t.db.$client
      .prepare(
        `INSERT INTO compose_jobs (id, conversation_id, owner_id, message_id, run_id, status, timeline_json, duration_ms,
           width, height, clips, subtitles, boot, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'running', '{}', 1000, 1280, 720, 1, 0, ?, 1, 1)`,
      )
      .run(id, a.conversationId, a.userId, a.messageId, a.runId, t.jobs.boot);
    await t.drive();
    expect(t.job(id)).toMatchObject({ status: "failed", errorCode: "compose_failed" });
  });

  it("deleting a conversation whose job waits removes its input copies at once", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const t = await start({
      composer: (d) => {
        const base = fixtureComposer(d, { stepMs: 1 });
        return { ...base, compose: async (job) => (await gate, base.compose(job)) };
      },
    });
    const a = await t.scopeOf("owner");
    const b = await t.scopeOf("shared");
    const ia = await t.putFile(a, inputsOrFake().png, "png");
    const ib = await t.putFile(b, inputsOrFake().png, "png");
    const ja = await t.queue(a, { clips: [{ fileId: ia, durationSec: 1 }] });
    await new Promise((r) => setTimeout(r, 20));
    const jb = await t.queue(b, { clips: [{ fileId: ib, durationSec: 1 }] });
    expect([t.job(ja).status, t.job(jb).status]).toEqual(["running", "queued"]);
    expect(t.scratch().sort()).toEqual([ja, jb].sort());
    const del = await t.api(t.f.cookies.shared, "DELETE", `/api/conversations/${b.conversationId}`);
    expect(del.statusCode).toBeLessThan(300);
    expect(t.scratch()).toEqual([ja]);
    release!();
    await t.jobs.idle();
    expect(t.job(ja).status).toBe("done");
  });

  it("a failed preparing→queued write: the call fails with a fixed code and the user is not left busy", async () => {
    const t = await start();
    const a = await t.scopeOf();
    const img = await t.putFile(a, inputsOrFake().png, "png");
    t.db.$client
      .exec(`CREATE TRIGGER fail_queue BEFORE UPDATE OF status ON compose_jobs WHEN NEW.status = 'queued'
      BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;`);
    expect(await t.call(a, { clips: [{ fileId: img, durationSec: 1 }] })).toMatchObject({
      ok: false,
      code: "media_failed",
    });
    t.db.$client.exec("DROP TRIGGER fail_queue");
    expect(t.db.$client.prepare("SELECT count(*) n FROM compose_jobs").get()).toEqual({ n: 0 });
    expect(t.scratch()).toEqual([]);
    // Its clean-up failing too: the row is reaped by the engine's next pass.
    t.db.$client
      .exec(`CREATE TRIGGER fail_queue BEFORE UPDATE OF status ON compose_jobs WHEN NEW.status = 'queued'
      BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END;
      CREATE TRIGGER fail_delete BEFORE DELETE ON compose_jobs BEGIN SELECT RAISE(ABORT, 'synthetic'); END;`);
    const b = await t.scopeOf();
    const img2 = await t.putFile(b, inputsOrFake().png, "png");
    expect(await t.call(b, { clips: [{ fileId: img2, durationSec: 1 }] })).toMatchObject({
      code: "media_failed",
    });
    t.db.$client.exec("DROP TRIGGER fail_queue; DROP TRIGGER fail_delete;");
    expect(t.db.$client.prepare("SELECT status FROM compose_jobs").all()).toEqual([{ status: "preparing" }]);
    await t.drive();
    expect(t.db.$client.prepare("SELECT count(*) n FROM compose_jobs").get()).toEqual({ n: 0 });
    const c = await t.scopeOf();
    const img3 = await t.putFile(c, inputsOrFake().png, "png");
    expect((await t.call(c, { clips: [{ fileId: img3, durationSec: 1 }] })).ok).toBe(true);
  });

  it("the deadline holds through the store: a store waiting past it commits nothing and frees the slot at once", async () => {
    const t = await start({ limits: { timeoutMs: 100 }, composer: (d) => fixtureComposer(d, { stepMs: 1 }) });
    const a = await t.scopeOf();
    const img = await t.putFile(a, inputsOrFake().png, "png");
    const files = t.app.files!;
    const orig = files.addGenerated.bind(files);
    // The file lock is held (a backup, say) for 400 ms.
    vi.spyOn(files, "addGenerated").mockImplementationOnce(async (input) => {
      await new Promise((r) => setTimeout(r, 400));
      return orig(input);
    });
    const id = await t.queue(a, { clips: [{ fileId: img, durationSec: 1 }] });
    await new Promise((r) => setTimeout(r, 250));
    expect(t.job(id)).toMatchObject({ status: "failed", errorCode: "compose_timeout" });
    await t.jobs.idle();
    expect(t.job(id)).toMatchObject({ status: "failed", errorCode: "compose_timeout", fileId: null });
    expect(t.db.$client.prepare("SELECT count(*) n FROM files WHERE kind = 'mp4'").get()).toEqual({ n: 0 });
    expect(t.scratch()).toEqual([]);
  });

  it("a filesystem error never reaches the model with its path: a fixed code", async () => {
    const t = await start({
      composer: (d) => ({
        ...fixtureComposer(d),
        workdir: () => {
          throw new Error("EACCES: permission denied, mkdir '/synthetic/secret/compose-scratch/x'");
        },
      }),
    });
    const a = await t.scopeOf();
    const img = await t.putFile(a, inputsOrFake().png, "png");
    const r = await t.call(a, { clips: [{ fileId: img, durationSec: 1 }] });
    expect(r).toMatchObject({ ok: false, code: "media_failed" });
    expect(JSON.stringify(r)).not.toContain("/synthetic");
  });
});

describe("review r2: the engine's one running slot", () => {
  it("a read that fails at any step of a run never leaves the slot held: the next user's job still runs", async () => {
    // Fail the k-th database read the engine makes after a job is queued — each k is another step of the run loop
    // (the pass, the reap, the queue's next, the cards told, the run's reads, the store's guard…).
    for (let k = 1; k <= 14; k++) {
      const t = await start({ composer: (d) => fixtureComposer(d, { stepMs: 1 }) });
      const a = await t.scopeOf("owner");
      const b = await t.scopeOf("shared");
      const ia = await t.putFile(a, inputsOrFake().png, "png");
      const ib = await t.putFile(b, inputsOrFake().png, "png");
      const ja = await t.queue(a, { clips: [{ fileId: ia, durationSec: 1 }] });
      // Right after the call: the engine's pass it scheduled has not run yet.
      const orig = t.db.select.bind(t.db);
      let n = 0;
      const spy = vi.spyOn(t.db, "select").mockImplementation(((...args: Parameters<typeof orig>) => {
        n += 1;
        if (n === k) throw new Error("synthetic read failure");
        return orig(...args);
      }) as typeof t.db.select);
      await t.jobs.idle();
      await new Promise((r) => setTimeout(r, 20));
      await t.jobs.idle();
      spy.mockRestore();
      // A few passes later, A has ended one way or the other — and B runs to its end.
      for (let i = 0; i < 4; i++) await t.drive();
      const jb = await t.queue(b, { clips: [{ fileId: ib, durationSec: 1 }] });
      for (let i = 0; i < 4; i++) await t.drive();
      expect([k, ["done", "failed"].includes(t.job(ja).status)]).toEqual([k, true]);
      expect([k, t.job(jb).status]).toEqual([k, "done"]);
      expect(
        t.db.$client.prepare("SELECT count(*) n FROM compose_jobs WHERE status = 'running'").get(),
      ).toEqual({ n: 0 });
      await t.app.close();
    }
  }, 300_000);

  it("a waiting job's card hears it moved up when the one before it is deleted", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => (release = r));
    const t = await start({
      composer: (d) => {
        const base = fixtureComposer(d, { stepMs: 1 });
        return { ...base, compose: async (job) => (await gate, base.compose(job)) };
      },
    });
    const run = await t.scopeOf("owner");
    const first = await t.scopeOf("shared");
    const second = await t.scopeOf("stranger");
    const [ir, i1, i2] = [
      await t.putFile(run, inputsOrFake().png, "png"),
      await t.putFile(first, inputsOrFake().png, "png"),
      await t.putFile(second, inputsOrFake().png, "png"),
    ];
    await t.queue(run, { clips: [{ fileId: ir, durationSec: 1 }] });
    await new Promise((r) => setTimeout(r, 20));
    await t.queue(first, { clips: [{ fileId: i1, durationSec: 1 }] });
    const j2 = await t.queue(second, { clips: [{ fileId: i2, durationSec: 1 }] });
    expect(t.jobs.view(t.job(j2)).queuePosition).toBe(2);
    const heard: (number | null)[] = [];
    const off = t.jobs.subscribe(j2, () => heard.push(t.jobs.view(t.job(j2)).queuePosition));
    expect(
      (await t.api(t.f.cookies.shared, "DELETE", `/api/conversations/${first.conversationId}`)).statusCode,
    ).toBeLessThan(300);
    off();
    expect(heard).toContain(1);
    release!();
    await t.jobs.idle();
  });
});

describe("review r2: the plan (pure)", () => {
  it("the last frame of a video is a valid trim; a start at the source's end is not", () => {
    const I = ins(info("v", { kind: "video", durationSec: 1 }));
    expect(
      planTimeline({ clips: [{ fileId: "v", trim: { startSec: 29 / 30, endSec: 1 } }] }, I),
    ).toMatchObject({
      frames: 1,
    });
    expect(planTimeline({ clips: [{ fileId: "v", trim: { startSec: 1, endSec: 1.01 } }] }, I)).toMatchObject({
      hint: expect.stringContaining("trim.startSec"),
    });
  });

  it("only real markup leaves a cue; plain < > stay (both tracks)", () => {
    expect(cueText("1 < 2 이고 4 > 3")).toBe("1 < 2 이고 4 > 3");
    expect(cueText('<b>굵게</b> <I>기울임</I> <font color="red">빨강</font> 줄<br>바꿈 <3')).toBe(
      "굵게 기울임 빨강 줄바꿈 <3",
    );
    expect(toVtt([{ startSec: 0, endSec: 1, text: "1 < 2 & 4 > 3" }])).toContain(
      "\n1 &lt; 2 &amp; 4 &gt; 3\n",
    );
  });

  it("a trimmed video is opened at the keyframe before its start, and its frames counted from that start", () => {
    const p = planTimeline(
      { clips: [{ fileId: "v", trim: { startSec: 2, endSec: 3 } }] },
      ins(info("v", { kind: "video", durationSec: 4 })),
    ) as Plan;
    const a = clipArgs(p, 0, "/in");
    expect(a.slice(a.indexOf("-noaccurate_seek"), a.indexOf("-noaccurate_seek") + 3)).toEqual([
      "-noaccurate_seek",
      "-ss",
      "2",
    ]);
    expect(a).not.toContain("-t");
    const g = a[a.indexOf("-filter_complex") + 1]!;
    expect(g).toContain("fps=30:start_time=0,trim=end_frame=30,");
    expect(g).toContain("atrim=start=0:end=1,");
  });
});

describe("review r1: the plan (pure)", () => {
  it("trims point into the source by its own length; a short video clip is fine; 0.5 s is an image's minimum", () => {
    const I = ins(
      info("long", { kind: "video", durationSec: 310 }),
      info("v", { kind: "video", durationSec: 2 }),
      info("a", { kind: "image" }),
    );
    const p = planTimeline({ clips: [{ fileId: "long", trim: { startSec: 301, endSec: 302 } }] }, I) as Plan;
    expect(isPlanError(p)).toBe(false);
    expect([p.frames, p.clips[0]!.startSec]).toEqual([30, 301]);
    const short = planTimeline({ clips: [{ fileId: "v", trim: { startSec: 0.1, endSec: 0.4 } }] }, I) as Plan;
    expect(short.frames).toBe(9);
    expect(planTimeline({ clips: [{ fileId: "a", durationSec: 0.3 }] }, I)).toMatchObject({
      code: "compose_invalid_timeline",
    });
    expect(planTimeline({ clips: [{ fileId: "v", trim: { startSec: 300, endSec: 301 } }] }, I)).toMatchObject(
      {
        hint: expect.stringContaining("trim.startSec"),
      },
    );
    // The tool's own schema takes such a trim (the 5-minute cap is the output's).
    expect(
      COMPOSE_VIDEO_TOOL.input.timeline.safeParse({
        clips: [{ fileId: "x", trim: { startSec: 301, endSec: 302 } }],
      }).success,
    ).toBe(true);
  });

  it("a clip that is all transition (its two transitions meet) has no body of its own", () => {
    const p = planTimeline(
      {
        clips: [
          { fileId: "a", durationSec: 1, transition: { type: "fade", durationSec: 0.5 } },
          { fileId: "a", durationSec: 1, transition: { type: "fade", durationSec: 0.5 } },
          { fileId: "a", durationSec: 1 },
        ],
      },
      ins(info("a", { kind: "image" })),
    ) as Plan;
    expect(isPlanError(p)).toBe(false);
    expect(p.frames).toBe(60);
    expect(concatList(p)).toBe(
      "ffconcat version 1.0\nfile 'body-0.mp4'\nfile 'trans-0.mp4'\nfile 'trans-1.mp4'\nfile 'body-2.mp4'\n",
    );
    expect(clipArgs(p, 1, "/in")).not.toContain("body-1.mp4");
  });

  it("narration ends with its sound (not the video's picture); a held last image keeps still after its move", () => {
    const p = planTimeline(
      {
        clips: [{ fileId: "a", durationSec: 1, kenBurns: "in" }],
        narration: [{ fileId: "s", startSec: 0 }],
      },
      ins(info("a", { kind: "image" }), info("s", { kind: "video", durationSec: 4, audioSec: 1.02 })),
    ) as Plan;
    expect(p.frames).toBe(31);
    const q = planTimeline(
      { clips: [{ fileId: "a", durationSec: 1, kenBurns: "in" }], narration: [{ fileId: "n", startSec: 0 }] },
      ins(info("a", { kind: "image" }), info("n", { kind: "audio", durationSec: 3, audioSec: 3 })),
    ) as Plan;
    expect(q.clips[0]).toMatchObject({ frames: 90, still: 60 });
    const g = clipArgs(q, 0, "/in").join(" ");
    expect(g).toContain(":d=30:");
    expect(g).toContain("tpad=stop_mode=clone");
  });
});

/** The real inputs when ffmpeg is here; else files of the right kinds (the fixture composer never reads them). */
function inputsOrFake() {
  if (HAVE_FFMPEG) return inputs();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-compose-fake-"));
  const w = (n: string, b: string) => (fs.writeFileSync(path.join(dir, n), b), path.join(dir, n));
  return {
    png: w("a.png", "png"),
    wide: w("w.png", "png"),
    video: w("v.mp4", "mp4"),
    mute: w("m.mp4", "mp4"),
    mp3: w("n.mp3", "mp3"),
    wav: w("m.wav", "wav"),
    pdf: w("x.pdf", "%PDF"),
    late: w("l.mp4", "mp4"),
    shortSound: w("s.mp4", "mp4"),
    anamorphic: w("an.mp4", "mp4"),
    long: w("lo.mp4", "mp4"),
    n3: w("n3.mp3", "mp3"),
    rgb1fps: w("r1.mp4", "mp4"),
    vfr: w("vf.mp4", "mp4"),
    bframes: w("bf.mp4", "mp4"),
    v1a4: w("v14.mp4", "mp4"),
    frame30: w("f30.mp4", "mp4"),
    alphaBlue: w("ab.png", "png"),
    alphaRed: w("ar.png", "png"),
  };
}

// ---------------------------------------------------------------- the real ffmpeg, in the sandbox

describe.skipIf(!HAVE_FFMPEG)("the real composition (local ffmpeg, sandboxed)", () => {
  const real = (d: string) => sandboxedComposer({ dataDir: d, ffmpegPath: FFMPEG });

  it("images, videos (with and without sound), narration held past the pictures, music, subtitles → a checked MP4", async () => {
    const t = await start({ composer: real, limits: { progressMs: 0 } });
    expect(t.app.mcp!.toolNamesFor(t.f.users.owner.id)).toContain("compose_video");
    const scope = await t.scopeOf();
    const m = inputs();
    const img = await t.putFile(scope, m.png, "png");
    const wide = await t.putFile(scope, m.wide, "png");
    const vid = await t.putFile(scope, m.video, "mp4");
    const mute = await t.putFile(scope, m.mute, "mp4");
    const nar = await t.putFile(scope, m.mp3, "mp3");
    const mus = await t.putFile(scope, m.wav, "wav");
    const id = await t.queue(scope, {
      output: { resolution: "720p", aspectRatio: "16:9" },
      clips: [
        { fileId: img, durationSec: 1.5, kenBurns: "in", transition: { type: "fade", durationSec: 0.5 } },
        { fileId: vid, fit: "crop", volume: 0.8, transition: { type: "slideleft", durationSec: 0.4 } },
        { fileId: mute, durationSec: 1.2 },
        { fileId: wide, durationSec: 1 },
      ],
      narration: [{ fileId: nar, startSec: 3 }],
      music: { fileId: mus, volume: 0.3, fadeInSec: 0.5, fadeOutSec: 0.5 },
      subtitles: [
        { startSec: 0.2, endSec: 1, text: "첫 장면" },
        { startSec: 1.2, endSec: 3, text: "둘째 장면" },
      ],
    });
    const queued = t.job(id);
    // 45 + 45 + 36 + 30 − 15 − 12 = 129 frames; the narration starts at 3 s and is 2.3009 s long (ffprobe: the MP3's
    // own length) → 160 frames (the last picture held for 31).
    const frames = 160;
    expect(queued.durationMs).toBe(Math.round((frames / 30) * 1000));
    expect((JSON.parse(queued.planJson!) as Plan).held).toBe(frames - 129);
    // Progress from ffmpeg's own progress lines (review R6), written as it goes.
    const seen: number[] = [];
    const off = t.jobs.subscribe(id, () => seen.push(t.jobs.get(id)?.progress ?? -1));
    await t.drive();
    off();
    expect(seen.some((p) => p > 0 && p < 100)).toBe(true);
    expect(seen.at(-1)).toBe(100);
    const done = t.job(id);
    expect(done, String(done.errorCode)).toMatchObject({ status: "done" });
    const file = t.app.files!.get(done.fileId!)!;
    const p = probeJson(t.app.files!.pathOf(file));
    expect(p.format.format_name).toContain("mp4");
    const v = p.streams.find((s) => s.codec_type === "video")!;
    const a = p.streams.find((s) => s.codec_type === "audio")!;
    const s = p.streams.find((x) => x.codec_type === "subtitle")!;
    expect([v.codec_name, v.width, v.height, Number(v.nb_read_packets)]).toEqual(["h264", 1280, 720, frames]);
    expect(a.codec_name).toBe("aac");
    expect(Math.abs(Number(a.duration) - frames / 30)).toBeLessThan(0.1);
    expect(s.codec_name).toBe("mov_text");
    expect(t.scratch()).toEqual([]);
  });

  it("letterbox and crop at 1080p 9:16; a silent composition (images only) still has its sound track", async () => {
    const t = await start({ composer: real });
    const scope = await t.scopeOf();
    const m = inputs();
    const wide = await t.putFile(scope, m.wide, "png");
    const id = await t.queue(scope, {
      output: { resolution: "1080p", aspectRatio: "9:16" },
      clips: [
        { fileId: wide, durationSec: 0.5 },
        { fileId: wide, durationSec: 0.5, fit: "crop" },
      ],
    });
    await t.drive();
    const done = t.job(id);
    expect(done.status, String(done.errorCode)).toBe("done");
    const p = probeJson(t.app.files!.pathOf(t.app.files!.get(done.fileId!)!));
    const v = p.streams.find((x) => x.codec_type === "video")!;
    expect([v.width, v.height, Number(v.nb_read_packets)]).toEqual([1080, 1920, 30]);
    expect(p.streams.find((x) => x.codec_type === "audio")?.codec_name).toBe("aac");
    expect(p.streams.some((x) => x.codec_type === "subtitle")).toBe(false);
  });

  it("40 clips at 1080p with transitions: within 2 GiB per run (review R4 — measured)", async () => {
    let peak = 0;
    const dataDir = path.join(tmp(), "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const c = sandboxedComposer({
      dataDir,
      ffmpegPath: FFMPEG,
      onPeakRss: (b) => (peak = Math.max(peak, b)),
    })!;
    const dir = c.workdir();
    const m = inputs();
    fs.copyFileSync(m.png, path.join(dir, "in", "in-0.png"));
    fs.copyFileSync(m.video, path.join(dir, "in", "in-1.mp4"));
    const pi = await c.probe(path.join(dir, "in", "in-0.png"), "png");
    const pv = await c.probe(path.join(dir, "in", "in-1.mp4"), "mp4");
    expect(pi.ok && pv.ok).toBe(true);
    const infos = new Map<string, InputInfo>([
      ["i", { ...(pi as { info: Omit<InputInfo, "fileId" | "name"> }).info, fileId: "i", name: "in-0.png" }],
      ["v", { ...(pv as { info: Omit<InputInfo, "fileId" | "name"> }).info, fileId: "v", name: "in-1.mp4" }],
    ]);
    const clips = Array.from({ length: COMPOSE_LIMITS.maxClips }, (_, k) => ({
      fileId: k % 2 ? "v" : "i",
      ...(k % 2 ? {} : { durationSec: 1, kenBurns: (["in", "out", "left", "right"] as const)[(k / 2) % 4] }),
      ...(k < COMPOSE_LIMITS.maxClips - 1
        ? { transition: { type: "dissolve" as const, durationSec: 0.3 } }
        : {}),
    }));
    const plan = planTimeline({ output: { resolution: "1080p" }, clips }, infos);
    if (isPlanError(plan)) throw new Error(plan.hint);
    const t0 = Date.now();
    const r = await c.compose({
      dir,
      plan,
      srt: null,
      signal: new AbortController().signal,
      deadlineAt: Date.now() + 10 * 60_000,
      onProgress: () => {},
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    console.log(
      `40 clips 1080p: ${plan.frames} frames in ${Date.now() - t0} ms, peak RSS ${(peak / 2 ** 20).toFixed(0)} MiB`,
    );
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThan(2 * 1024 ** 3);
  }, 600_000);

  // ---- review r1, with the real ffmpeg
  const frameAt = (file: string, sec: number) =>
    execFileSync(FFMPEG, [
      ...["-hide_banner", "-v", "error", "-ss", String(sec), "-i", file, "-frames:v", "1"],
      ...["-vf", "scale=160:90", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    ]);
  const pcmOf = (file: string) => {
    const b = execFileSync(
      FFMPEG,
      [
        "-hide_banner",
        "-v",
        "error",
        "-i",
        file,
        "-map",
        "0:a:0",
        "-ac",
        "1",
        "-ar",
        "48000",
        "-f",
        "s16le",
        "-",
      ],
      {
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    return Array.from({ length: b.length / 2 }, (_, i) => b.readInt16LE(i * 2));
  };
  const composeOne = async (
    t: Awaited<ReturnType<typeof start>>,
    scope: { userId: string; conversationId: string; runId: string },
    timeline: unknown,
  ) => {
    const id = await t.queue(scope, timeline);
    await t.drive();
    const done = t.job(id);
    expect(done.status, String(done.errorCode)).toBe("done");
    return t.app.files!.pathOf(t.app.files!.get(done.fileId!)!);
  };

  it("review r1: a MOV whose sound starts 0.625 s late keeps it late (one time origin, silence before)", async () => {
    const t = await start({ composer: real });
    const s1 = await t.scopeOf();
    const mov = await t.putFile(s1, inputs().late, "mp4");
    const out = await composeOne(t, s1, { clips: [{ fileId: mov }] });
    const pcm = pcmOf(out);
    const first = pcm.findIndex((v) => Math.abs(v) > 1000) / 48_000;
    expect(first).toBeGreaterThan(0.55);
    expect(first).toBeLessThan(0.7);
  });

  it("review r1: a held Ken Burns image stops moving at its own length; narration from a video ends with its sound", async () => {
    const t = await start({ composer: real });
    const s1 = await t.scopeOf();
    const img = await t.putFile(s1, inputs().png, "png");
    const n3 = await t.putFile(s1, inputs().n3, "mp3");
    const out = await composeOne(t, s1, {
      clips: [{ fileId: img, durationSec: 1, kenBurns: "in" }],
      narration: [{ fileId: n3, startSec: 0 }],
    });
    const a = frameAt(out, 1.1);
    const b = frameAt(out, 2.8);
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff += Math.abs(a[i]! - b[i]!);
    expect(diff / a.length).toBeLessThan(1);
    // 4 s of picture with 1 s of sound, as narration over a 1 s picture: about 1 s, not 4.
    const s2 = await t.scopeOf();
    const img2 = await t.putFile(s2, inputs().png, "png");
    const vid = await t.putFile(s2, inputs().shortSound, "mp4");
    const id = await t.queue(s2, {
      clips: [{ fileId: img2, durationSec: 1 }],
      narration: [{ fileId: vid, startSec: 0 }],
    });
    expect(t.job(id).durationMs).toBeLessThan(1200);
    await t.drive();
    expect(t.job(id).status).toBe("done");
  });

  it("review r1: non-square pixels shown by their aspect; plain braces in subtitles; short and far trims; all-transition clips", async () => {
    const t = await start({ composer: real });
    const s1 = await t.scopeOf();
    const ana = await t.putFile(s1, inputs().anamorphic, "mp4");
    const out = await composeOne(t, s1, {
      clips: [{ fileId: ana }],
      subtitles: [{ startSec: 0, endSec: 0.9, text: "집합 {1, 2}와 한국어" }],
    });
    // 720×576 at SAR 64:45 is 16:9: it fills the 1280×720 frame (no side bars) — the left edge is green.
    const f = frameAt(out, 0.5);
    const at = (x: number, y: number) => [
      f[(y * 160 + x) * 3]!,
      f[(y * 160 + x) * 3 + 1]!,
      f[(y * 160 + x) * 3 + 2]!,
    ];
    expect(at(3, 45)[1]).toBeGreaterThan(80);
    const srt = execFileSync(FFMPEG, [
      "-hide_banner",
      "-v",
      "error",
      "-i",
      out,
      "-map",
      "0:s:0",
      "-f",
      "srt",
      "-",
    ]).toString();
    expect(srt).toContain("집합 {1, 2}와 한국어");
    const id = (
      t.db.$client
        .prepare("SELECT id FROM compose_jobs WHERE conversation_id = ?")
        .get(s1.conversationId) as {
        id: string;
      }
    ).id;
    expect((await t.api(t.f.cookies.owner, "GET", `/api/compose-jobs/${id}/subtitles.vtt`)).body).toContain(
      "집합 {1, 2}와 한국어",
    );
    // A far trim of a 310 s source, a 0.3 s trim, and a middle image that is all transition.
    const s2 = await t.scopeOf();
    const long = await t.putFile(s2, inputs().long, "mp4");
    const vid = await t.putFile(s2, inputs().video, "mp4");
    const img = await t.putFile(s2, inputs().png, "png");
    const out2 = await composeOne(t, s2, {
      clips: [
        {
          fileId: long,
          trim: { startSec: 301, endSec: 302 },
          transition: { type: "fade", durationSec: 0.5 },
        },
        { fileId: img, durationSec: 1, transition: { type: "dissolve", durationSec: 0.5 } },
        { fileId: vid, trim: { startSec: 0.1, endSec: 0.8 } },
        { fileId: vid, trim: { startSec: 0.1, endSec: 0.4 } },
      ],
    });
    // 30 + 30 + 21 + 9 − 15 − 15 frames.
    const v = probeJson(out2).streams.find((x) => x.codec_type === "video")!;
    expect(Number(v.nb_read_packets)).toBe(60);
  });

  // ---- review r2, with the real ffmpeg
  const colourOf = (px: number[]) =>
    px[0]! > 150 && px[1]! < 90 && px[2]! < 90
      ? "red"
      : px[2]! > 150 && px[0]! < 90 && px[1]! < 90
        ? "blue"
        : px[1]! > 150 && px[0]! < 90 && px[2]! < 90
          ? "green"
          : px[0]! < 30 && px[1]! < 30 && px[2]! < 30
            ? "black"
            : `other(${px.join(",")})`;
  /** The colour at the centre of every frame of the result (decoded outside the server). */
  const colours = (file: string) => {
    const b = execFileSync(FFMPEG, [
      ...[
        "-hide_banner",
        "-v",
        "error",
        "-i",
        file,
        "-vf",
        "scale=16:16",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        "-",
      ],
    ]);
    const n = b.length / (16 * 16 * 3);
    return Array.from({ length: n }, (_, i) => {
      const o = i * 16 * 16 * 3 + (8 * 16 + 8) * 3;
      return colourOf([b[o]!, b[o + 1]!, b[o + 2]!]);
    });
  };

  it("review r2: a trim starts with the frame on screen at its start — 1 fps, variable frame rate, B-frames, the last frame", async () => {
    const t = await start({ composer: real });
    const m = inputs();
    // `null`: the frame at a change itself (within one 1/30 s slot of it) may be either.
    const cases: { src: string; trim: [number, number]; want: (string | null)[] }[] = [
      { src: m.rgb1fps, trim: [0.1, 0.4], want: Array(9).fill("red") },
      { src: m.rgb1fps, trim: [1.1, 1.4], want: Array(9).fill("blue") },
      { src: m.rgb1fps, trim: [2.1, 2.4], want: Array(9).fill("green") },
      { src: m.rgb1fps, trim: [0.9, 1.1], want: [...Array(3).fill("red"), ...Array(3).fill("blue")] },
      { src: m.vfr, trim: [0.5, 0.6], want: Array(3).fill("red") },
      { src: m.vfr, trim: [0.8, 0.9], want: Array(3).fill("blue") },
      { src: m.vfr, trim: [2.2, 2.4], want: [...Array(3).fill("blue"), null, "green", "green"] },
      { src: m.bframes, trim: [0.9, 1.1], want: [...Array(3).fill("red"), ...Array(3).fill("blue")] },
      // The last frame of an exactly-1 s, 30 fps video (review r2, P3).
      { src: m.frame30, trim: [29 / 30, 1], want: ["blue"] },
    ];
    for (const c of cases) {
      const scope = await t.scopeOf();
      const f = await t.putFile(scope, c.src, "mp4");
      const out = await composeOne(t, scope, {
        clips: [{ fileId: f, trim: { startSec: c.trim[0], endSec: c.trim[1] } }],
      });
      const got = colours(out);
      expect([path.basename(c.src), c.trim, got]).toEqual([
        path.basename(c.src),
        c.trim,
        c.want.map((w, k) => w ?? got[k]),
      ]);
    }
  });

  it("review r2: a trim past a picture that ended holds its last frame, the sound cut exactly at the trim", async () => {
    const t = await start({ composer: real });
    const scope = await t.scopeOf();
    const f = await t.putFile(scope, inputs().v1a4, "mp4");
    const out = await composeOne(t, scope, { clips: [{ fileId: f, trim: { startSec: 2, endSec: 3 } }] });
    const v = probeJson(out).streams.find((x) => x.codec_type === "video")!;
    expect(Number(v.nb_read_packets)).toBe(30);
    // The last frame of the picture (0.967 s), held: every frame alike.
    const [f0, f1, f2] = [0.1, 0.5, 0.9].map((sec) => frameAt(out, sec));
    const diff = (a: Buffer, b: Buffer) => a.reduce((n, v, i) => n + Math.abs(v - b[i]!), 0) / a.length;
    expect(diff(f0!, f1!)).toBeLessThan(2);
    expect(diff(f0!, f2!)).toBeLessThan(2);
    // The sine of 2–3 s plays from the very start to the end (no silence before or after).
    const pcm = pcmOf(out);
    const loud = (from: number, to: number) =>
      Math.max(...pcm.slice(Math.round(from * 48_000), Math.round(to * 48_000)).map(Math.abs));
    expect(loud(0, 0.05)).toBeGreaterThan(1000);
    expect(loud(0.9, 0.98)).toBeGreaterThan(1000);
  });

  it("review r2: transparent PNGs are black where transparent — never their hidden colours", async () => {
    const t = await start({ composer: real });
    const scope = await t.scopeOf();
    const a = await t.putFile(scope, inputs().alphaBlue, "png");
    const b = await t.putFile(scope, inputs().alphaRed, "png");
    const out = await composeOne(t, scope, {
      clips: [
        { fileId: a, durationSec: 0.5 },
        { fileId: b, durationSec: 0.5, kenBurns: "in" },
      ],
    });
    expect(new Set(colours(out))).toEqual(new Set(["black"]));
  });

  it("review r2: subtitles keep plain < > & and braces — the MP4's track and the card's VTT decode to the text given", async () => {
    const t = await start({ composer: real });
    const scope = await t.scopeOf();
    const img = await t.putFile(scope, inputs().png, "png");
    const texts = ["1 < 2 이고 4 > 3", "집합 {1, 2}와 A & B", "<3 하트 -> 끝"];
    const id = await t.queue(scope, {
      clips: [{ fileId: img, durationSec: 3 }],
      subtitles: texts.map((text, i) => ({ startSec: i, endSec: i + 0.9, text })),
    });
    await t.drive();
    const done = t.job(id);
    expect(done.status, String(done.errorCode)).toBe("done");
    const out = t.app.files!.pathOf(t.app.files!.get(done.fileId!)!);
    const srt = execFileSync(FFMPEG, [
      "-hide_banner",
      "-v",
      "error",
      "-i",
      out,
      "-map",
      "0:s:0",
      "-f",
      "srt",
      "-",
    ]).toString();
    const fromMp4 = srt
      .split(/\r?\n\r?\n/)
      .map((b) => b.split(/\r?\n/).slice(2).join("\n"))
      .filter(Boolean);
    expect(fromMp4).toEqual(texts);
    const vtt = (await t.api(t.f.cookies.owner, "GET", `/api/compose-jobs/${id}/subtitles.vtt`)).body;
    const fromVtt = vtt
      .split("\n\n")
      .slice(1)
      .map((b) => b.split("\n").slice(1).filter(Boolean).join("\n"))
      .filter(Boolean)
      .map((x) => x.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
    expect(fromVtt).toEqual(texts);
    // Escaped in the VTT itself: no raw "<", ">" or bare "&" in a cue.
    const cueLines = vtt.split("\n").filter((l) => l && !l.includes("-->") && l !== "WEBVTT");
    expect(cueLines.join("\n")).not.toMatch(/[<>]|&(?!lt;|gt;|amp;)/);
  });

  it("readiness: a tiny composition checked in the same sandbox", async () => {
    const dataDir = path.join(tmp(), "data");
    fs.mkdirSync(dataDir, { recursive: true });
    expect(await sandboxedComposer({ dataDir, ffmpegPath: FFMPEG })!.ready()).toBe(true);
    expect(fs.readdirSync(storagePaths(dataDir).composeScratch)).toEqual([]);
  });
});
