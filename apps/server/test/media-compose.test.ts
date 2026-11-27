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
  checkInputs,
  checkTimeline,
  clipArgs,
  H264,
  audioArgs,
  transitionArgs,
  timedCues,
  concatList,
  cueText,
  isPlanError,
  planTimeline,
  toAss,
  toVtt,
  ingestArgs,
  pictureEnd,
  presentTrack,
  q,
  qSec,
  secTicks,
  toSamples,
  toTicks,
  type InputInfo,
  type Plan,
  type TrackPresentation,
} from "../src/media/compose-plan.js";
import {
  fixtureComposer,
  isAnimatedWebp,
  judgeInput,
  judgeResult,
  mixPcm,
  mp4Timeline,
  sandboxedComposer,
  type Composer,
  type ComposeOutcome,
} from "../src/media/compose-run.js";
import { compose as composeNotification } from "../src/notifications/compose.js";
import { codexRunConfig } from "../src/runtime/lockdown.js";
import { RuntimeRegistry } from "../src/runtime/adapter.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import { storagePaths } from "../src/storage/paths.js";
import { runIsolated } from "../src/isolation/sandbox.js";
import { createFamily } from "./helpers/permission-matrix.js";
import { silentMp3 } from "../src/media/fixture.js";
import { newestComposeJob } from "../../web/src/chat/compose-card.js";

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
      | "alphaRed"
      | "early"
      | "vbr"
      | "sync121"
      | "edit"
      | "one"
      | "vbr100"
      | "prores"
      | "qtrleRed"
      | "qtrleBlue"
      | "noel"
      | "silent1"
      | "silent29"
      | "loud"
      | "rb"
      | "anim",
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
  // Re-plan r3 inputs: sound from 0, picture from 1.2 s (3 s in all); a VBR MP3 written to a pipe (no length header —
  // ffprobe can only estimate it): 5 s of noise, then 5 s of a quiet tone.
  ff(
    ...[
      "-f",
      "lavfi",
      "-i",
      "sine=f=440:r=48000:d=3",
      "-itsoffset",
      "1.2",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=s=64x64:r=30:d=1.8",
    ],
    ...[
      "-map",
      "1:v",
      "-map",
      "0:a",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      path.join(dir, "early.mp4"),
    ],
  );
  fs.writeFileSync(
    path.join(dir, "vbr.mp3"),
    execFileSync(
      FFMPEG,
      [
        ...["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "anoisesrc=r=44100:d=5:a=0.3"],
        ...[
          "-f",
          "lavfi",
          "-i",
          "sine=f=330:r=44100:d=5,volume=0.2",
          "-filter_complex",
          "[0:a][1:a]concat=n=2:v=0:a=1",
        ],
        ...["-c:a", "libmp3lame", "-q:a", "2", "-f", "mp3", "-"],
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    ),
  );
  // Review r4 inputs. A 121-frame MOV: black, then white at 2.0 s with a tone from 2.0 s (PCM sound).
  ff(
    ...["-f", "lavfi", "-i", "nullsrc=s=64x64:r=30:d=4.0333,format=gray,geq=lum='if(gte(T\\,2)\\,255\\,0)'"],
    ...["-f", "lavfi", "-i", "aevalsrc='if(gte(t\\,2)\\,0.5*sin(2*PI*440*t)\\,0)':s=48000:d=4.0333"],
    ...[
      "-frames:v",
      "121",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "pcm_s16le",
      path.join(dir, "sync121.mov"),
    ],
  );
  // An MP4 whose tracks start after a leading empty edit (3.5 s): 2 s of white with a tone.
  ff(
    ...["-itsoffset", "3.5", "-f", "lavfi", "-i", "color=c=white:s=64x64:r=30:d=2"],
    ...["-itsoffset", "3.5", "-f", "lavfi", "-i", "sine=f=440:r=48000:d=2"],
    ...["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(dir, "edit.mp4")],
  );
  // Exactly 1 s of 44.1 kHz AAC in M4A (its last frame padded).
  ff("-f", "lavfi", "-i", "sine=f=440:r=44100:d=1", "-c:a", "aac", path.join(dir, "one.m4a"));
  // 100 s of VBR MP3 written to a pipe: 5 s of noise, then 95 s of a quiet tone (ffprobe overestimates it).
  fs.writeFileSync(
    path.join(dir, "vbr100.mp3"),
    execFileSync(
      FFMPEG,
      [
        ...["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "anoisesrc=r=44100:d=5:a=0.3"],
        ...["-f", "lavfi", "-i", "sine=f=330:r=44100:d=95,volume=0.05"],
        ...[
          "-filter_complex",
          "[0:a][1:a]concat=n=2:v=0:a=1",
          "-c:a",
          "libmp3lame",
          "-q:a",
          "2",
          "-f",
          "mp3",
          "-",
        ],
      ],
      { maxBuffer: 64 * 1024 * 1024 },
    ),
  );
  // Pictures with alpha: half-transparent red in ProRes 4444; fully transparent QuickTime Animation (hidden red, blue).
  ff(
    ...["-f", "lavfi", "-i", "color=c=red@0.5:s=64x64:r=30:d=1,format=rgba"],
    ...["-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", path.join(dir, "prores.mov")],
  );
  for (const c of ["red", "blue"])
    ff(
      ...["-f", "lavfi", "-i", `color=c=${c}@0.0:s=64x64:r=30:d=1,format=rgba`],
      ...["-c:v", "qtrle", "-pix_fmt", "argb", path.join(dir, `qtrle-${c}.mov`)],
    );
  // Review r5 inputs. H.264 with B-frames and no edit list (its first picture at 0.0667 s — a reorder delay, no gap).
  ff(
    ...["-f", "lavfi", "-i", "color=c=red:s=64x64:r=30:d=1", "-c:v", "libx264", "-bf", "2"],
    ...["-pix_fmt", "yuv420p", "-use_editlist", "0", path.join(dir, "noel.mp4")],
  );
  // Silent WAVs (1 s, 2.9 s); a loud 500 Hz tone in PCM under a black picture; red until exactly 1.000 s, then blue.
  for (const d of ["1", "2.9"])
    ff(
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=48000:cl=stereo,atrim=duration=${d}`,
      "-c:a",
      "pcm_s16le",
      path.join(dir, `silent-${d}.wav`),
    );
  ff(
    ...[
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=64x64:r=30:d=1",
      "-f",
      "lavfi",
      "-i",
      "sine=f=500:r=48000:d=1,volume=0.9",
    ],
    ...[
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "pcm_s16le",
      "-shortest",
      path.join(dir, "loud.mov"),
    ],
  );
  ff(
    ...[
      "-f",
      "lavfi",
      "-i",
      "nullsrc=s=64x64:r=30:d=2,format=rgb24,geq=r='if(lt(T\\,1)\\,255\\,0)':g=0:b='if(gte(T\\,1)\\,255\\,0)'",
    ],
    ...["-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(dir, "rb.mp4")],
  );
  // An animated WebP's header (VP8X with its animation flag, an ANIM chunk) — enough for the check that refuses it.
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x02;
  const anim = Buffer.alloc(6);
  const chunk = (id: string, body: Buffer) => {
    const h = Buffer.alloc(8);
    h.write(id, 0, "latin1");
    h.writeUInt32LE(body.length, 4);
    return Buffer.concat([h, body]);
  };
  const body = Buffer.concat([Buffer.from("WEBP", "latin1"), chunk("VP8X", vp8x), chunk("ANIM", anim)]);
  const riff = Buffer.alloc(8);
  riff.write("RIFF", 0, "latin1");
  riff.writeUInt32LE(body.length, 4);
  fs.writeFileSync(path.join(dir, "anim.webp"), Buffer.concat([riff, body]));
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
    early: path.join(dir, "early.mp4"),
    sync121: path.join(dir, "sync121.mov"),
    edit: path.join(dir, "edit.mp4"),
    one: path.join(dir, "one.m4a"),
    vbr100: path.join(dir, "vbr100.mp3"),
    prores: path.join(dir, "prores.mov"),
    qtrleRed: path.join(dir, "qtrle-red.mov"),
    qtrleBlue: path.join(dir, "qtrle-blue.mov"),
    noel: path.join(dir, "noel.mp4"),
    silent1: path.join(dir, "silent-1.wav"),
    silent29: path.join(dir, "silent-2.9.wav"),
    loud: path.join(dir, "loud.mov"),
    rb: path.join(dir, "rb.mp4"),
    anim: path.join(dir, "anim.webp"),
    vbr: path.join(dir, "vbr.mp3"),
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
    const over = { clips: [{ fileId: "a", durationSec: 1 }], narration: [{ fileId: "n", startSec: 299 }] };
    const two = ins(info("a", { kind: "image" }), info("n", { kind: "audio", durationSec: 2, audioSec: 2 }));
    // Review r4: the call judges nothing that depends on a length (`checkInputs`); the run's plan (decoded lengths) does.
    expect(checkInputs(over, two)).toBeNull();
    expect(planTimeline(over, two)).toMatchObject({ code: "compose_too_long" });
    // Stated lengths alone over 5 minutes: refused at the call already.
    expect(
      checkInputs({ clips: Array.from({ length: 11 }, () => ({ fileId: "a", durationSec: 30 })) }, two),
    ).toMatchObject({ code: "compose_too_long" });
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
    // Review r4: a trim past the picture's end holds its last frame (never refused on a length).
    expect(bad({ clips: [{ fileId: "v", trim: { startSec: 1, endSec: 5 } }] })).toMatchObject({
      frames: 120,
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

  it("subtitles: the text as given; each format escapes only its own syntax (review r3)", () => {
    // Only line endings and control characters change (review r5: blank lines and indentation stay).
    expect(cueText("  <b>안녕</b> {\\an8}세계\r\n\r\n둘째 --> 줄 \\N C:\\temp ")).toBe(
      "  <b>안녕</b> {\\an8}세계\n\n둘째 --> 줄 \\N C:\\temp ",
    );
    const subs = [
      { startSec: 0.25, endSec: 1, text: "A & B < C" },
      { startSec: 62, endSec: 63, text: "끝 {1, 2}" },
      { startSec: 64, endSec: 65, text: "첫 줄\n둘째, 줄 \\N {\\i1}" },
    ];
    // ASS: a word joiner only inside "\N" / "\n" / "\h" and "{\"; lines joined with ASS's own break.
    expect(
      toAss(subs)
        .split("\n")
        .filter((l) => l.startsWith("Dialogue:")),
    ).toEqual([
      "Dialogue: 0,0:00:00.25,0:00:01.00,Default,,0,0,0,,A & B < C",
      "Dialogue: 0,0:01:02.00,0:01:03.00,Default,,0,0,0,,끝 {1, 2}",
      "Dialogue: 0,0:01:04.00,0:01:05.00,Default,,0,0,0,,첫 줄\\N둘째, 줄 \\\u2060N {\u2060\\i1}",
    ]);
    // VTT: entities for & < > (a "-->" in a cue is "--&gt;").
    expect(toVtt([{ startSec: 0, endSec: 1, text: "A & B --> C" }])).toBe(
      "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nA &amp; B --&gt; C\n",
    );
  });

  it("short cues keep a positive length in whole units, never overlap after rounding, end with the video (review r3)", () => {
    const subs = [
      { startSec: 1.071, endSec: 1.074, text: "짧다" },
      { startSec: 1.0745, endSec: 1.0749, text: "더 짧다" },
      { startSec: 2, endSec: 9, text: "끝을 넘는다" },
      { startSec: 9.5, endSec: 9.9, text: "끝 뒤" },
    ];
    expect(timedCues(subs, 100, 3).map((c) => [c.start, c.end])).toEqual([
      [107, 108],
      [108, 109],
      [200, 300],
    ]);
    expect(timedCues(subs, 1000, 3).map((c) => [c.start, c.end])).toEqual([
      [1071, 1074],
      [1075, 1076],
      [2000, 3000],
    ]);
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
    // Float out (review r5): the same values, never clipped.
    expect(out.length).toBe(150 * 8);
    for (const i of [0, 49, 50, 75, 99, 100, 149])
      expect(Math.round(out.readFloatLE(i * 8) * 32768)).toBe(1000);
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
    expect(vtt.body).toBe("WEBVTT\n\n00:00:00.000 --> 00:00:01.500\n첫 장면 &lt;b&gt;안녕&lt;/b&gt;\n");
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
    // Review r4: a read made now (place 2) is older than the change — its version is lower, so the card keeps the new one.
    const stale = t.jobs.view(t.job(j2));
    const heard: (number | null)[] = [];
    const off = t.jobs.subscribe(j2, () => heard.push(t.jobs.view(t.job(j2)).queuePosition));
    expect(
      (await t.api(t.f.cookies.shared, "DELETE", `/api/conversations/${first.conversationId}`)).statusCode,
    ).toBeLessThan(300);
    off();
    expect(heard).toContain(1);
    const fresh = t.jobs.view(t.job(j2));
    expect(fresh.version).toBeGreaterThan(stale.version);
    expect(newestComposeJob(fresh, stale).queuePosition).toBe(1);
    release!();
    await t.jobs.idle();
  });
  it("re-plan r3: a job prepared later but asked earlier goes first — the jobs it passes hear their new place", async () => {
    let releaseRun: (() => void) | undefined;
    const running = new Promise<void>((r) => (releaseRun = r));
    let releaseProbe: (() => void) | undefined;
    const slowProbe = new Promise<void>((r) => (releaseProbe = r));
    let probes = 0;
    const t = await start({
      composer: (d) => {
        const base = fixtureComposer(d, { stepMs: 1 });
        return {
          ...base,
          // The second call's probe (A's) waits; everyone else's is quick.
          probe: async (file, kind, signal) => (
            (probes += 1) === 2 ? await slowProbe : undefined,
            base.probe(file, kind, signal)
          ),
          compose: async (job) => (await running, base.compose(job)),
        };
      },
    });
    const run = await t.scopeOf("owner");
    const a = await t.scopeOf("shared");
    const b = await t.scopeOf("stranger");
    const [ir, ia, ib] = [
      await t.putFile(run, inputsOrFake().png, "png"),
      await t.putFile(a, inputsOrFake().png, "png"),
      await t.putFile(b, inputsOrFake().png, "png"),
    ];
    await t.queue(run, { clips: [{ fileId: ir, durationSec: 1 }] });
    await new Promise((r) => setTimeout(r, 20));
    const callA = t.queue(a, { clips: [{ fileId: ia, durationSec: 1 }] });
    await new Promise((r) => setTimeout(r, 20));
    const jb = await t.queue(b, { clips: [{ fileId: ib, durationSec: 1 }] });
    expect(t.jobs.view(t.job(jb)).queuePosition).toBe(1);
    const heard: (number | null)[] = [];
    const off = t.jobs.subscribe(jb, () => heard.push(t.jobs.view(t.job(jb)).queuePosition));
    releaseProbe!();
    await callA;
    off();
    expect(t.jobs.view(t.job(jb)).queuePosition).toBe(2);
    expect(heard).toContain(2);
    releaseRun!();
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
    expect(planTimeline({ clips: [{ fileId: "v", trim: { startSec: 1.5, endSec: 1.6 } }] }, I)).toMatchObject(
      {
        hint: expect.stringContaining("trim.startSec"),
      },
    );
  });

  it("a trimmed video is decoded from its start — no input seeking — and its frames counted on the container's timeline (re-plan r3)", () => {
    const p = planTimeline(
      { clips: [{ fileId: "v", trim: { startSec: 2, endSec: 3 } }] },
      ins(info("v", { kind: "video", durationSec: 4 })),
    ) as Plan;
    const a = clipArgs(p, 0, "/in");
    expect(a).not.toContain("-ss");
    expect(a).not.toContain("-noaccurate_seek");
    const g = a[a.indexOf("-filter_complex") + 1]!;
    // The canvas starts at the trim's start (review r5): the source shifted by it, then 30 frames.
    // Review r12: the selected part (2–3 s) cut on the input's timeline before the trim's shift.
    expect(g).toContain("[0:v]settb=1/3000000,trim=end_pts=9000000,setpts=PTS-6000000,");
    expect(g).toContain("overlay=eof_action=repeat:repeatlast=1,format=yuv420p,trim=end_frame=30,");
    // The picture only: its sound is a slice of the input's decoded PCM.
    expect(g).not.toContain("[0:a");
    expect(a).not.toContain("pcm_s16le");
  });
});

describe("review r8: one presentation per track (pure)", () => {
  // What a graph built from a presentation shows and plays (the intent `clipArgs` and `ingestArgs` encode): at time u
  // of the input's timeline, the latest picture sample mapped at or before u and before the end — none (black) before
  // the start; a sound sample at its mapped time when that is in [start, end).
  // The cases are written in seconds; every one is a whole number of 1/3 000 000 s, so exact as such.
  type Secs = { edited: boolean; lead: number; mediaTime: number; end: number | null };
  const qOf = (x: number) => q(Math.round(x * 3_000_000), 3_000_000);
  const ex = (t: Secs) => ({
    edited: t.edited,
    lead: qOf(t.lead),
    mediaTime: qOf(t.mediaTime),
    end: t.end == null ? null : qOf(t.end),
  });
  type P = { shift: number; start: number; end: number | null };
  const secs = (p: TrackPresentation): P => ({
    shift: qSec(p.shift),
    start: qSec(p.start),
    end: p.end ? qSec(p.end) : null,
  });
  const shown = (p: P, frames: number[], u: number) => {
    if (u < p.start - 1e-9) return "black";
    let k = -1;
    frames.forEach((m, i) => {
      const at = m + p.shift;
      if (at <= u + 1e-9 && (p.end == null || at < p.end - 1e-9)) k = i;
    });
    return k < 0 ? "black" : `F${k}`;
  };
  const heard = (p: P, m: number) => {
    const at = m + p.shift;
    return at >= p.start - 1e-9 && (p.end == null || at < p.end - 1e-9) ? Math.round(at * 1e4) / 1e4 : null;
  };
  const none = { edited: false, lead: 0, mediaTime: 0, end: null };
  // The kinds of track (re-plan 2's accepted edit lists), each with its origin as `judgeInput` sets it.
  const cases: {
    name: string;
    track: Secs;
    origin: number;
    frames: number[];
    want: P;
    // [u, picture shown at u] — before, across and after the edit's end
    see: [number, string][];
    // [media time, where it is heard (null: not)]
    hear: [number, number | null][];
  }[] = [
    {
      name: "no edit list, B-frame delay, picture only (origin = its first picture)",
      track: none,
      origin: 1 / 15,
      frames: [1 / 15, 1 + 1 / 15, 2 + 1 / 15],
      want: { shift: -1 / 15, start: 0, end: null },
      see: [
        [0, "F0"],
        [1.5, "F1"],
        [9, "F2"],
      ],
      hear: [
        [1 / 15, 0],
        [1, 0.9333],
      ],
    },
    {
      name: "no edit list, sound earlier than the picture (origin 0: the sound before it kept)",
      track: { ...none, end: 2 },
      origin: 0,
      frames: [1 / 15, 1 + 1 / 15],
      want: { shift: 0, start: 0, end: 2 },
      see: [
        [0, "black"],
        [0.1, "F0"],
        [1.9, "F1"],
        [5, "F1"],
      ],
      hear: [
        [0, 0],
        [0.05, 0.05],
        [1.99, 1.99],
        [2, null],
      ],
    },
    {
      name: "a leading empty edit only (5.5 s file, 1.5 s lead)",
      track: { edited: true, lead: 1.5, mediaTime: 0, end: 5.5 },
      origin: 0,
      frames: [0, 1, 2, 3, 4],
      want: { shift: 1.5, start: 1.5, end: 5.5 },
      see: [
        [1, "black"],
        [1.5, "F0"],
        [2.6, "F1"],
        [5.4, "F3"],
        [5.6, "F3"],
        [9, "F3"],
      ],
      hear: [
        [0, 1.5],
        [3.9, 5.4],
        [4, null],
      ],
    },
    {
      name: "a media time > 0 (AVFoundation's 0.4–1.5 s)",
      track: { edited: true, lead: 0, mediaTime: 0.4, end: 1.1 },
      origin: 0,
      frames: [0, 1, 2],
      want: { shift: -0.4, start: 0, end: 1.1 },
      see: [
        [0, "F0"],
        [0.59, "F0"],
        [0.6, "F1"],
        [1.2, "F1"],
        [3, "F1"],
      ],
      hear: [
        [0.3, null],
        [0.4, 0],
        [1.49, 1.09],
        [1.5, null],
      ],
    },
    {
      name: "a lead equal to its media time (0.25 s: shift 0, the media before it still left out)",
      track: { edited: true, lead: 0.25, mediaTime: 0.25, end: 1.75 },
      origin: 0,
      frames: [0, 1, 2],
      want: { shift: 0, start: 0.25, end: 1.75 },
      see: [
        [0.1, "black"],
        [0.25, "F0"],
        [1, "F1"],
        [1.8, "F1"],
      ],
      hear: [
        [0.05, null],
        [0.2, null],
        [0.25, 0.25],
        [1.74, 1.74],
        [1.75, null],
      ],
    },
    {
      name: "a lead and a media time (1 s, 0.4 s)",
      track: { edited: true, lead: 1, mediaTime: 0.4, end: 2.1 },
      origin: 0,
      frames: [0, 1, 2],
      want: { shift: 0.6, start: 1, end: 2.1 },
      see: [
        [0.5, "black"],
        [1, "F0"],
        [1.6, "F1"],
        [3, "F1"],
      ],
      hear: [
        [0.3, null],
        [0.4, 1],
        [1.49, 2.09],
        [1.5, null],
      ],
    },
    {
      name: "a fragmented file's zero-length media edit (its end not known up front)",
      track: { edited: true, lead: 0, mediaTime: 1 / 15, end: null },
      origin: 0,
      frames: [1 / 15, 1 + 1 / 15, 2 + 1 / 15],
      want: { shift: -1 / 15, start: 0, end: null },
      see: [
        [0, "F0"],
        [1, "F1"],
        [99, "F2"],
      ],
      hear: [
        [0, null],
        [1 / 15, 0],
        [3, 2.9333],
      ],
    },
  ];

  it("presentTrack — every kind of track, picture and sound, before / across / after its edit's end", () => {
    for (const c of cases) {
      const p = secs(presentTrack(ex(c.track), qOf(c.origin)));
      expect([c.name, p.shift]).toEqual([c.name, expect.closeTo(c.want.shift, 9)]);
      expect([c.name, p.start, p.end]).toEqual([c.name, c.want.start, c.want.end]);
      for (const [u, f] of c.see) expect([c.name, u, shown(p, c.frames, u)]).toEqual([c.name, u, f]);
      for (const [m, at] of c.hear) expect([c.name, m, heard(p, m)]).toEqual([c.name, m, at]);
    }
    // Not an MP4/MOV (read without `-copyts`): as decoded.
    expect(secs(presentTrack(null))).toEqual({ shift: 0, start: 0, end: null });
    // Exact: 1/30 s of a 15360 timescale is 100 000 ticks, not 99 999 (review r10 — ffprobe's "0.033333").
    expect(
      toTicks(presentTrack(ex({ edited: false, lead: 0, mediaTime: 0, end: null }), q(512, 15360)).shift),
    ).toBe(-100_000);
  });

  it("the clip's picture graph comes from it only: mapped, cut at its end on the input's timeline, then trimmed", () => {
    for (const c of cases) {
      const p = presentTrack(ex(c.track), qOf(c.origin));
      const end = p.end ? qSec(p.end) : 2;
      // A trim before, across and after the edit's end.
      for (const startSec of [0, Math.max(0, end - 0.1), end + 0.5]) {
        const plan = planTimeline(
          { clips: [{ fileId: "v", trim: { startSec, endSec: startSec + 0.4 } }] },
          ins(info("v", { kind: "video", durationSec: 10, videoTrack: ex(c.track), origin: qOf(c.origin) })),
        ) as Plan;
        expect([c.name, startSec, plan.clips[0]!.picture]).toEqual([c.name, startSec, p]);
        const g = clipArgs(plan, 0, "/in");
        const graph = g[g.indexOf("-filter_complex") + 1]!;
        const head = graph.slice(0, graph.indexOf("[src]"));
        // Review r9/r10: whole ticks of 1/3 000 000 s, each converted once from its exact value.
        const sh = toTicks(p.shift);
        const map = sh !== 0 ? `,setpts=PTS${sh < 0 ? "-" : "+"}${Math.abs(sh)}` : "";
        // Review r12: cut where the edit ends or the selected part does, whichever is first.
        const chosen = secTicks(startSec) + secTicks(plan.clips[0]!.pickSec!);
        const cut = `,trim=end_pts=${p.end ? Math.min(toTicks(p.end), chosen) : chosen}`;
        const trim = startSec ? `,setpts=PTS-${secTicks(startSec)},` : "";
        // Its end does not move with the trim; the trim's shift comes after it.
        expect([c.name, startSec, head.startsWith(`[0:v]settb=1/3000000${map}`)]).toEqual([
          c.name,
          startSec,
          true,
        ]);
        expect([c.name, startSec, head.includes(cut)]).toEqual([c.name, startSec, true]);
        expect([c.name, startSec, head.indexOf(cut) < head.indexOf(trim || "scale")]).toEqual([
          c.name,
          startSec,
          true,
        ]);
        expect([c.name, startSec, head.includes(trim)]).toEqual([c.name, startSec, true]);
        // The leading empty edit's end as the canvas's frame number (review r10).
        // Review r13: a chosen part that ends by then shows none of the picture.
        const leadIn = toTicks(p.start) - secTicks(startSec);
        const cutTicks = Number(/,trim=end_pts=(\d+)/.exec(head)![1]);
        const off = toTicks(p.start) > 0 && cutTicks <= toTicks(p.start);
        expect([c.name, startSec, graph.includes(":enable='0'")]).toEqual([c.name, startSec, off]);
        expect([c.name, startSec, graph.includes(":enable='gte(n,")]).toEqual([
          c.name,
          startSec,
          !off && leadIn > 0,
        ]);
        if (!off && leadIn > 0) expect(graph).toContain(`:enable='gte(n,${Math.ceil(leadIn / 100_000)})'`);
        expect(graph).not.toContain("trim=end=");
        expect(graph).not.toMatch(/setpts=PTS[-+][0-9.]*\.[0-9]/);
      }
    }
  });

  it("the ingest's sound graph comes from it only: the lead cut whatever the shift, then its end", () => {
    for (const c of cases) {
      const p = presentTrack(ex(c.track), qOf(c.origin));
      const a = ingestArgs({
        inDir: "/in",
        input: "in-0.mp4",
        fileKind: "mp4",
        sound: true,
        countPicture: true,
        capSec: 5,
        soundAt: p,
        pictureAt: p,
      });
      const af = a[a.indexOf("-af") + 1]!;
      const vf = a[a.indexOf("-vf") + 1]!;
      expect([c.name, af.includes("asetpts=PTS")]).toEqual([c.name, toTicks(p.shift) !== 0]);
      expect([c.name, af.includes(`,atrim=start_pts=${toSamples(p.start)},`)]).toEqual([
        c.name,
        toSamples(p.start) > 0,
      ]);
      expect([c.name, af.includes(`,atrim=end_sample=`)]).toEqual([c.name, !!p.end]);
      expect([c.name, vf.includes("setpts=PTS")]).toEqual([c.name, toTicks(p.shift) !== 0]);
      // Gaps in its timestamps are silence (an `empty_moov` file's stretched first AAC sample).
      expect(af).toContain("aresample=48000:async=1:min_hard_comp=0.001:first_pts=0");
    }
    // The 0.25 s case: no shift, yet nothing before 0.25 s.
    const eq = presentTrack(ex({ edited: true, lead: 0.25, mediaTime: 0.25, end: 1.75 }));
    const a = ingestArgs({
      inDir: "/in",
      input: "x",
      fileKind: "mp4",
      sound: true,
      countPicture: false,
      capSec: 2,
      soundAt: eq,
    });
    expect(a[a.indexOf("-af") + 1]).toMatch(
      /^asettb=1\/3000000,aresample=48000,aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo,atrim=start_pts=12000,aresample=48000:async=1:/,
    );
    expect(a[a.indexOf("-af") + 1]).toMatch(/,atrim=end_sample=84000$/);
  });
});

describe("review r10: no time in a graph is a decimal of seconds (pure)", () => {
  // Every shift, cut and switch-on time is whole ticks, samples or frames — each converted once from an exact value.
  const decimalTimes = (g: string) =>
    [
      /(?:a?setpts)=PTS[-+][0-9]*\.[0-9]/,
      /\ba?trim=[^,;[]*\b(?:start|end|duration)=/,
      /enable='[^']*\bt\b/,
      /afade=[^,;[]*:(?:st|d)=/,
      /PTS[-+][^,;[]*\/TB/,
    ].filter((r) => r.test(g));
  it("clips (every kind of track, awkward trims), the ingest, transitions and the sound", () => {
    const tracks = [
      { edited: false, lead: q(0), mediaTime: q(0), end: null },
      { edited: true, lead: q(100, 1000), mediaTime: q(1024, 15360), end: q(4100, 1000) },
      { edited: true, lead: q(250, 600), mediaTime: q(7, 30000), end: q(1001 * 50, 30000) },
      { edited: true, lead: q(0), mediaTime: q(6554, 16384), end: null },
    ];
    const origins = [q(0), q(512, 15360), q(1, 3)];
    const graphs: string[] = [];
    for (const track of tracks)
      for (const origin of origins)
        for (const startSec of [0, 1 / 30, 0.1, 0.4, 1.2345, 2 / 3]) {
          const I = ins(
            info("v", { kind: "video", durationSec: 9, videoTrack: track, audioTrack: track, origin }),
            info("a", { kind: "image" }),
            info("m", { kind: "audio", durationSec: 9, audioSec: 9 }),
          );
          const plan = planTimeline(
            {
              clips: [
                {
                  fileId: "v",
                  trim: { startSec, endSec: startSec + 1 },
                  transition: { type: "fade", durationSec: 0.3 },
                },
                { fileId: "a", durationSec: 1 },
              ],
              music: { fileId: "m", fadeInSec: 0.35, fadeOutSec: 0.45 },
            },
            I,
          ) as Plan;
          for (const i of [0, 1]) {
            const a = clipArgs(plan, i, "/in");
            graphs.push(a[a.indexOf("-filter_complex") + 1]!);
          }
          const tr = transitionArgs(plan, 0);
          graphs.push(tr[tr.indexOf("-filter_complex") + 1]!);
          const au = audioArgs(plan, { narration: true, music: "m.pcm" });
          graphs.push(au[au.indexOf("-filter_complex") + 1]!);
          const at = presentTrack(track, origin);
          const ing = ingestArgs({
            inDir: "/in",
            input: "v",
            fileKind: "mp4",
            sound: true,
            countPicture: true,
            capSec: 3,
            soundAt: at,
            pictureAt: at,
          });
          graphs.push(ing[ing.indexOf("-af") + 1]!, ing[ing.indexOf("-vf") + 1]!);
        }
    for (const g of graphs) expect([g, decimalTimes(g)]).toEqual([g, []]);
    // The guard itself sees the old forms.
    for (const old of [
      "[0:v]settb=AVTB,setpts=PTS-0.033333/TB,",
      "trim=end=0.5,",
      "atrim=start=0.25,",
      "overlay=enable='gte(t,0.066667)'",
      "afade=t=in:st=0:d=0.35",
    ])
      expect([old, decimalTimes(old).length > 0]).toEqual([old, true]);
  });
});

describe("review r11: samples counted at 48 kHz, pieces of their planned length, fades in samples (pure)", () => {
  const PIN = /aresample=48000,aformat=sample_fmts=(?:fltp|s16):sample_rates=48000:channel_layouts=stereo,$/;
  // Every filter that counts samples, and what stands right before it.
  const unpinned = (g: string) => {
    const bad: string[] = [];
    for (const m of g.matchAll(
      /\b(?:atrim=[^,;[]*\b(?:start_pts|end_pts|start_sample|end_sample)=|afade=[^,;[]*\b(?:ss|ns)=|apad=[^,;[]*whole_len)/g,
    ))
      if (!PIN.test(g.slice(0, m.index))) bad.push(g.slice(Math.max(0, m.index - 60), m.index + 30));
    return bad;
  };
  it("every sample-counting filter of the sound and the ingest has 48 kHz stereo pinned right before it", () => {
    const I = ins(
      info("a", { kind: "image" }),
      info("v", {
        kind: "video",
        durationSec: 9,
        audioTrack: { edited: true, lead: q(1, 4), mediaTime: q(1, 4), end: q(7, 4) },
        origin: q(0),
      }),
      info("m", { kind: "audio", durationSec: 9, audioSec: 9 }),
    );
    const graphs: string[] = [];
    for (const sec of [1, 2.9, 3, 3.8, 4])
      for (const duck of [true, false])
        for (const narration of [true, false]) {
          const plan = planTimeline(
            {
              clips: [{ fileId: "a", durationSec: sec }],
              music: { fileId: "m", duck, fadeInSec: 0.3, fadeOutSec: 0.2 },
            },
            I,
          ) as Plan;
          const au = audioArgs(plan, { narration, music: "m.pcm" });
          graphs.push(au[au.indexOf("-filter_complex") + 1]!);
        }
    for (const at of [
      presentTrack(I.get("v")!.audioTrack, q(0)),
      presentTrack({ edited: false, lead: q(0), mediaTime: q(0), end: q(3) }),
      presentTrack(null),
    ]) {
      const a = ingestArgs({
        inDir: "/in",
        input: "v",
        fileKind: "mp4",
        sound: true,
        countPicture: false,
        capSec: 3,
        soundAt: at,
      });
      graphs.push(a[a.indexOf("-af") + 1]!);
    }
    for (const g of graphs) expect([g, unpinned(g)]).toEqual([g, []]);
    expect(graphs.join(";").match(/atrim=end_sample=/g)!.length).toBeGreaterThan(40);
    // The guard sees the old form (a compressor straight into a sample cut).
    expect(
      unpinned("[bedin][bedsc]sidechaincompress=threshold=0.03,atrim=end_sample=192000[bed]"),
    ).toHaveLength(1);
  });

  it("fades that exactly fill the length are taken (0.4 + 0.2 s of 0.6 s); a fade that rounds to 0 samples is left out", () => {
    const I = ins(info("a", { kind: "image" }), info("m", { kind: "audio", durationSec: 9, audioSec: 9 }));
    const full = planTimeline(
      { clips: [{ fileId: "a", durationSec: 0.6 }], music: { fileId: "m", fadeInSec: 0.4, fadeOutSec: 0.2 } },
      I,
    );
    expect(isPlanError(full)).toBe(false);
    const g = audioArgs(full as Plan, { narration: false, music: "m.pcm" });
    expect(g[g.indexOf("-filter_complex") + 1]).toContain("afade=t=in:ss=0:ns=19200");
    expect(g[g.indexOf("-filter_complex") + 1]).toContain("afade=t=out:ss=19200:ns=9600");
    expect(
      planTimeline(
        {
          clips: [{ fileId: "a", durationSec: 0.6 }],
          music: { fileId: "m", fadeInSec: 0.41, fadeOutSec: 0.2 },
        },
        I,
      ),
    ).toMatchObject({ code: "compose_invalid_timeline" });
    const tiny = planTimeline(
      {
        clips: [{ fileId: "a", durationSec: 1 }],
        music: { fileId: "m", fadeInSec: 0.00001, fadeOutSec: 0.000001 },
      },
      I,
    ) as Plan;
    const t = audioArgs(tiny, { narration: false, music: "m.pcm" });
    expect(t[t.indexOf("-filter_complex") + 1]).not.toContain("afade");
  });

  it("the concat list gives each piece its planned length in whole microseconds — no drift over 40 pieces", () => {
    const I = ins(info("a", { kind: "image" }));
    const plan = planTimeline(
      {
        clips: Array.from({ length: 40 }, (_, i) => ({
          fileId: "a",
          durationSec: 0.5,
          ...(i < 39 ? { transition: { type: "fade" as const, durationSec: 7 / 30 } } : {}),
        })),
      },
      I,
    ) as Plan;
    const list = concatList(plan);
    const ds = [...list.matchAll(/^duration (\d+\.\d{6})$/gm)].map((m) => Math.round(Number(m[1]) * 1e6));
    // Each piece starts where its frames so far end, to the microsecond.
    let frames = 0;
    let at = 0;
    const lengths: number[] = [];
    for (const c of plan.clips) {
      if (c.frames - c.head - c.tail > 0) lengths.push(c.frames - c.head - c.tail);
      if (c.tail) lengths.push(c.tail);
    }
    expect(ds).toHaveLength(lengths.length);
    for (const [k, n] of lengths.entries()) {
      at += ds[k]!;
      frames += n;
      expect([k, at]).toEqual([k, Math.round((frames * 1e6) / 30)]);
    }
    expect(frames).toBe(plan.frames);
  });
});

describe("review r12: the narration's end in whole samples; pieces without B-frames (pure)", () => {
  it("a narration placed at the same sample ends at the same frame, however its start is written", () => {
    const I = ins(info("a", { kind: "image" }), info("n", { kind: "audio", durationSec: 1, audioSec: 1 }));
    for (const startSec of [0.06667, 2 / 30]) {
      const p = planTimeline(
        { clips: [{ fileId: "a", durationSec: 0.5 }], narration: [{ fileId: "n", startSec }] },
        I,
      ) as Plan;
      // 3 200 + 48 000 = 51 200 samples = 32 frames exactly.
      expect([startSec, p.frames]).toEqual([startSec, 32]);
    }
    // 16 000 samples at 299.66667 s (sample 14 384 000) end at exactly 300 s — not too long.
    const J = ins(
      info("a", { kind: "image" }),
      info("n", { kind: "audio", durationSec: 1 / 3, audioSec: 16_000 / 48_000 }),
    );
    for (const startSec of [299.66667, 299 + 2 / 3]) {
      const p = planTimeline(
        {
          clips: Array.from({ length: 10 }, () => ({ fileId: "a", durationSec: 29 })),
          narration: [{ fileId: "n", startSec }],
        },
        J,
      );
      expect([startSec, isPlanError(p) ? p.code : (p as Plan).frames]).toEqual([startSec, 9000]);
    }
  });

  it("every H.264 piece is encoded without B-frames (one decoding delay for all)", () => {
    const i = H264.indexOf("-bf");
    expect(H264[i + 1]).toBe("0");
  });
});

describe("review r13: the picture's real end, an empty chosen part (pure)", () => {
  it("the last frame's end is the latest pts + duration in its time base (B-frames: not the last line)", () => {
    const f = pictureEnd();
    for (const l of [
      "packet|pts=256|duration=128",
      "packet|pts=15616|duration=128",
      "packet|pts=15360|duration=128",
      "packet|pts=N/A|duration=128",
      "stream|time_base=1/15360",
    ])
      f.line(l);
    expect(f.end()).toEqual(q(15744, 15360));
    expect(pictureEnd().end()).toBeNull();
  });

  it("review r14: the lines are read field by field — a trailing delimiter, side data, other keys", () => {
    const f = pictureEnd();
    for (const l of [
      "packet|pts=256|duration=128|",
      "packet|duration=128|pts=15616",
      "packet|pts=|duration=128",
      "side_data|side_data_type=Display Matrix|rotation=-90",
      "stream|time_base=1/15360|",
      "stream|side_data_type=Display Matrix|",
      "",
    ])
      f.line(l);
    expect(f.end()).toEqual(q(15744, 15360));
    // No time base: no end (the job then fails, never guesses).
    const g = pictureEnd();
    g.line("packet|pts=10|duration=1");
    expect(g.end()).toBeNull();
  });

  it("a chosen part that ends by the picture's first showing keeps the overlay off; one after it switches it on", () => {
    const track = { edited: true, lead: q(1), mediaTime: q(2, 5), end: q(21, 10) };
    for (const [endSec, on] of [
      [0.999, "enable='0'"],
      [1, "enable='0'"],
      [1.01, "enable='gte(n,30)'"],
    ] as const) {
      const plan = planTimeline(
        {
          clips: [{ fileId: "v", trim: { startSec: 0, endSec } }],
          narration: [{ fileId: "n", startSec: 0 }],
        },
        ins(
          info("v", { kind: "video", durationSec: 2.1, videoTrack: track, origin: q(0) }),
          info("n", { kind: "audio", durationSec: 2, audioSec: 2 }),
        ),
      ) as Plan;
      const a = clipArgs(plan, 0, "/in");
      expect([endSec, a[a.indexOf("-filter_complex") + 1]!.includes(on)]).toEqual([endSec, true]);
    }
  });
});

describe("review r5: the call's own judgements (pure)", () => {
  it("transitions that together outrun a stated clip are refused at the call — no file length needed", () => {
    const I = ins(info("a", { kind: "image" }));
    const three = {
      clips: [
        { fileId: "a", durationSec: 1, transition: { type: "fade" as const, durationSec: 0.7 } },
        { fileId: "a", durationSec: 1, transition: { type: "fade" as const, durationSec: 0.7 } },
        { fileId: "a", durationSec: 1 },
      ],
    };
    expect(checkInputs(three, I)).toMatchObject({
      code: "compose_invalid_timeline",
      hint: expect.stringContaining("clips[1]"),
    });
    // A video of its own (unknown) length: judged at the run.
    const V = ins(info("a", { kind: "image" }), info("v", { kind: "video" }));
    expect(
      checkInputs(
        {
          clips: [
            { fileId: "a", durationSec: 1, transition: { type: "fade", durationSec: 0.7 } },
            { fileId: "v", transition: { type: "fade", durationSec: 0.7 } },
            { fileId: "a", durationSec: 1 },
          ],
        },
        V,
      ),
    ).toBeNull();
  });

  it("the tool refuses it before anything is reserved", async () => {
    const t = await start();
    const scope = await t.scopeOf();
    const img = await t.putFile(scope, inputsOrFake().png, "png");
    const r = await t.call(scope, {
      clips: [
        { fileId: img, durationSec: 1, transition: { type: "fade", durationSec: 0.7 } },
        { fileId: img, durationSec: 1, transition: { type: "fade", durationSec: 0.7 } },
        { fileId: img, durationSec: 1 },
      ],
    });
    expect(r).toMatchObject({ ok: false, code: "compose_invalid_timeline" });
    expect(t.db.$client.prepare("SELECT count(*) n FROM compose_jobs").get()).toEqual({ n: 0 });
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
      "ffconcat version 1.0\nfile 'body-0.mp4'\nduration 0.500000\nfile 'trans-0.mp4'\nduration 0.500000\n" +
        "file 'trans-1.mp4'\nduration 0.500000\nfile 'body-2.mp4'\nduration 0.500000\n",
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
    early: w("e.mp4", "mp4"),
    sync121: w("s121.mov", "mp4"),
    edit: w("ed.mp4", "mp4"),
    one: w("one.m4a", "m4a"),
    vbr100: w("v100.mp3", "mp3"),
    prores: w("pr.mov", "mp4"),
    qtrleRed: w("qr.mov", "mp4"),
    qtrleBlue: w("qb.mov", "mp4"),
    noel: w("noel.mp4", "mp4"),
    silent1: w("s1.wav", "wav"),
    silent29: w("s29.wav", "wav"),
    loud: w("loud.mov", "mp4"),
    rb: w("rb.mp4", "mp4"),
    anim: w("anim.webp", "webp"),
    vbr: w("vbr.mp3", "mp3"),
  };
}

// ---------------------------------------------------------------- the real ffmpeg, in the sandbox

/** Re-plan 2 test helpers: an MP4's boxes found and rewritten in place (the edit list of its first picture track). */
function boxesOf(b: Buffer, from: number, to: number) {
  const out: { type: string; at: number; start: number; end: number }[] = [];
  for (let at = from; at + 8 <= to;) {
    let len = b.readUInt32BE(at);
    let hdr = 8;
    if (len === 1) {
      len = Number(b.readBigUInt64BE(at + 8));
      hdr = 16;
    } else if (len === 0) len = to - at;
    out.push({ type: b.toString("latin1", at + 4, at + 8), at, start: at + hdr, end: at + len });
    at += len;
  }
  return out;
}
/** Where the first picture (or `soun`: sound) track's `elst` entries start in `b` (version 0), and how many there are. */
function videoElst(b: Buffer, handler = "vide"): { entries: number; count: number } {
  const moov = boxesOf(b, 0, b.length).find((x) => x.type === "moov")!;
  for (const trak of boxesOf(b, moov.start, moov.end).filter((x) => x.type === "trak")) {
    const kids = boxesOf(b, trak.start, trak.end);
    const mdia = kids.find((x) => x.type === "mdia")!;
    const hdlr = boxesOf(b, mdia.start, mdia.end).find((x) => x.type === "hdlr")!;
    if (b.toString("latin1", hdlr.start + 8, hdlr.start + 12) !== handler) continue;
    const edts = kids.find((x) => x.type === "edts")!;
    const elst = boxesOf(b, edts.start, edts.end).find((x) => x.type === "elst")!;
    if (b[elst.start] !== 0) throw new Error("elst version 1");
    return { entries: elst.start + 8, count: b.readUInt32BE(elst.start + 4) };
  }
  throw new Error(`no ${handler} track`);
}
/** A copy of `src` whose first picture (or `handler`) track's edit list entries are rewritten by `edit` (same count). */
function rewriteElst(
  src: string,
  out: string,
  edit: (
    e: { duration: number; media: number; rate: number }[],
  ) => { duration: number; media: number; rate: number }[],
  handler = "vide",
) {
  const b = Buffer.from(fs.readFileSync(src));
  const { entries, count } = videoElst(b, handler);
  const now = Array.from({ length: count }, (_, k) => ({
    duration: b.readUInt32BE(entries + k * 12),
    media: b.readInt32BE(entries + k * 12 + 4),
    rate: b.readInt16BE(entries + k * 12 + 8),
  }));
  const next = edit(now);
  if (next.length !== count) throw new Error("same count only");
  next.forEach((e, k) => {
    b.writeUInt32BE(e.duration, entries + k * 12);
    b.writeInt32BE(e.media, entries + k * 12 + 4);
    b.writeInt16BE(e.rate, entries + k * 12 + 8);
  });
  fs.writeFileSync(out, b);
}
/** A copy of `src` (its `moov` last) whose `moov` header is the 16-byte (64-bit size) form. */
function bigMoov(src: string, out: string) {
  const b = fs.readFileSync(src);
  const moov = boxesOf(b, 0, b.length).find((x) => x.type === "moov")!;
  if (moov.end !== b.length || moov.start - moov.at !== 8) throw new Error("moov not last");
  const head = Buffer.alloc(16);
  head.writeUInt32BE(1, 0);
  head.write("moov", 4, "latin1");
  head.writeBigUInt64BE(BigInt(moov.end - moov.at + 8), 8);
  fs.writeFileSync(out, Buffer.concat([b.subarray(0, moov.at), head, b.subarray(moov.start)]));
}

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
    // The call stored its inputs (their lengths estimates); the run decodes them and plans again.
    expect((JSON.parse(queued.planJson!) as { inputs: InputInfo[] }).inputs).toHaveLength(6);
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
      timeline: { output: { resolution: "1080p" }, clips },
      inputs: [...infos.values()],
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

  // ---- the re-plan after review r3: lengths decoded, no input seeking, subtitles as given
  const loudness = (pcm: number[], from: number, to: number) =>
    Math.max(0, ...pcm.slice(Math.round(from * 48_000), Math.round(to * 48_000)).map(Math.abs));

  it("re-plan r3: sound that starts before the picture is kept — untrimmed and trimmed", async () => {
    const t = await start({ composer: real });
    const s1 = await t.scopeOf();
    const f1 = await t.putFile(s1, inputs().early, "mp4");
    const whole = await composeOne(t, s1, { clips: [{ fileId: f1 }] });
    // 3 s (the sound's end), the sound from the very start.
    expect(Number(probeJson(whole).streams.find((x) => x.codec_type === "video")!.nb_read_packets)).toBe(90);
    const pcm = pcmOf(whole);
    expect(loudness(pcm, 0, 0.1)).toBeGreaterThan(1000);
    expect(loudness(pcm, 1, 1.1)).toBeGreaterThan(1000);
    const s2 = await t.scopeOf();
    const f2 = await t.putFile(s2, inputs().early, "mp4");
    const part = await composeOne(t, s2, { clips: [{ fileId: f2, trim: { startSec: 0, endSec: 0.8 } }] });
    const pcm2 = pcmOf(part);
    expect(loudness(pcm2, 0.05, 0.75)).toBeGreaterThan(1000);
    expect(Number(probeJson(part).streams.find((x) => x.codec_type === "video")!.nb_read_packets)).toBe(24);
  });

  it("re-plan r3: a VBR MP3 without a length header — narration and music by their decoded length", async () => {
    const est = Number(
      execFileSync(FFPROBE, [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        inputs().vbr,
      ]).toString(),
    );
    const t = await start({ composer: real });
    const s1 = await t.scopeOf();
    const img = await t.putFile(s1, inputs().png, "png");
    const nar = await t.putFile(s1, inputs().vbr, "mp3");
    const id = await t.queue(s1, {
      clips: [{ fileId: img, durationSec: 1 }],
      narration: [{ fileId: nar, startSec: 0 }],
    });
    await t.drive();
    const done = t.job(id);
    expect(done.status, String(done.errorCode)).toBe("done");
    // Decoded: about 10 s (whatever ffprobe estimated) — the picture held that long and the tone heard to its end.
    expect(done.durationMs).toBeGreaterThan(9_900);
    expect(done.durationMs).toBeLessThan(10_200);
    const out = t.app.files!.pathOf(t.app.files!.get(done.fileId!)!);
    expect(loudness(pcmOf(out), 9.5, 9.8)).toBeGreaterThan(300);
    console.log(
      `VBR MP3: ffprobe estimate ${est.toFixed(3)} s, decoded result ${(done.durationMs / 1000).toFixed(3)} s`,
    );
    // As music (not looped) under a 10 s picture: heard to its real end.
    const s2 = await t.scopeOf();
    const img2 = await t.putFile(s2, inputs().png, "png");
    const mus = await t.putFile(s2, inputs().vbr, "mp3");
    const out2 = await composeOne(t, s2, {
      clips: [{ fileId: img2, durationSec: 10 }],
      music: { fileId: mus, volume: 1, loop: false },
    });
    expect(loudness(pcmOf(out2), 9.5, 9.8)).toBeGreaterThan(300);
  });

  it("re-plan r3: a long-GOP 1080p trim at 50 s — the frame at 50 s, decoded from the start (time and memory measured)", async () => {
    const dir = tmp();
    const gop = path.join(dir, "gop60.mp4");
    execFileSync(FFMPEG, [
      ...["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=60"],
      ...["-f", "lavfi", "-i", "sine=f=440:r=48000:d=60", "-c:v", "libx264", "-preset", "ultrafast"],
      ...[
        "-g",
        "1800",
        "-keyint_min",
        "1800",
        "-sc_threshold",
        "0",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        gop,
      ],
    ]);
    let peak = 0;
    const t = await start({
      composer: (d) =>
        sandboxedComposer({ dataDir: d, ffmpegPath: FFMPEG, onPeakRss: (b) => (peak = Math.max(peak, b)) }),
    });
    const s1 = await t.scopeOf();
    const f = await t.putFile(s1, gop, "mp4");
    const t0 = Date.now();
    const out = await composeOne(t, s1, {
      output: { resolution: "1080p" },
      clips: [{ fileId: f, trim: { startSec: 50, endSec: 51 } }],
    });
    const ms = Date.now() - t0;
    console.log(`60 s-GOP 1080p, trim 50–51 s: ${ms} ms (job), peak RSS ${(peak / 2 ** 20).toFixed(0)} MiB`);
    expect(ms).toBeLessThan(120_000);
    expect(peak).toBeLessThan(2 * 1024 ** 3);
    // Its first frame is the source's frame at 50 s (decoded outside the server, accurately).
    const ref = execFileSync(FFMPEG, [
      ...["-hide_banner", "-v", "error", "-ss", "50", "-i", gop, "-frames:v", "1"],
      ...["-vf", "scale=160:90", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    ]);
    const got = frameAt(out, 0);
    expect(got.reduce((n, v, i) => n + Math.abs(v - ref[i]!), 0) / got.length).toBeLessThan(6);
  }, 600_000);

  it("re-plan r3: special characters round-trip — the MP4's track and the card's VTT decode to the text given", async () => {
    const t = await start({ composer: real });
    const scope = await t.scopeOf();
    const img = await t.putFile(scope, inputs().png, "png");
    const texts = [
      "C:\\temp 폴더",
      "A --> B",
      "1 < 2 & 3 > 2",
      "{1, 2} <b>굵게</b> &amp;",
      "줄 하나\n줄 둘",
      "역슬래시 \\N 그대로 {\\i1}",
    ];
    const id = await t.queue(scope, {
      clips: [{ fileId: img, durationSec: 6 }],
      subtitles: texts.map((text, i) => ({ startSec: i, endSec: i + 0.9, text })),
    });
    await t.drive();
    const done = t.job(id);
    expect(done.status, String(done.errorCode)).toBe("done");
    const out = t.app.files!.pathOf(t.app.files!.get(done.fileId!)!);
    // mov_text samples straight from the file (a 2-byte length, then UTF-8; style boxes after it are not text).
    const packets = execFileSync(FFPROBE, [
      ...["-v", "error", "-select_streams", "s", "-show_packets", "-show_data", "-of", "json", out],
    ]).toString();
    const fromMp4 = (JSON.parse(packets) as { packets: { data: string }[] }).packets
      .map((p) =>
        Buffer.from(
          p.data
            .split("\n")
            .map((l) => l.slice(10, 49).replace(/\s/g, ""))
            .join(""),
          "hex",
        ),
      )
      .filter((b) => b.length > 2 && b.readUInt16BE(0) > 0)
      // The word joiner ASS needs between "\" and N is invisible — what is shown is the text given.
      .map((b) =>
        b
          .subarray(2, 2 + b.readUInt16BE(0))
          .toString("utf8")
          .replace(/\u2060/g, ""),
      );
    expect(fromMp4).toEqual(texts);
    const vtt = (await t.api(t.f.cookies.owner, "GET", `/api/compose-jobs/${id}/subtitles.vtt`)).body;
    const fromVtt = vtt
      .split("\n\n")
      .slice(1)
      .map((b) => b.split("\n").slice(1).filter(Boolean).join("\n"))
      .filter(Boolean)
      .map((x) => x.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
    expect(fromVtt).toEqual(texts);
  });

  // ---- review r4, with the real ffmpeg
  it("review r4: a 121-frame MOV keeps its sync — picture and sound change at 2.0 s, and end together", async () => {
    const t = await start({ composer: real });
    const s1 = await t.scopeOf();
    const f = await t.putFile(s1, inputs().sync121, "mp4");
    const out = await composeOne(t, s1, { clips: [{ fileId: f }] });
    const p = probeJson(out);
    const v = p.streams.find((x) => x.codec_type === "video")!;
    const a = p.streams.find((x) => x.codec_type === "audio")!;
    expect(Number(v.nb_read_packets)).toBe(121);
    expect(Math.abs(Number(a.duration) - 121 / 30)).toBeLessThan(1 / 30);
    const light = colours(out);
    expect(light.slice(0, 60).every((c) => c === "black")).toBe(true);
    expect(light[60]).not.toBe("black");
    const pcm = pcmOf(out);
    const first = pcm.findIndex((x) => Math.abs(x) > 1000) / 48_000;
    expect(Math.abs(first - 2)).toBeLessThan(1 / 30);
  });

  it("review r4: an MP4's leading empty edit is kept — its presentation timeline, for the whole file and a trim", async () => {
    const t = await start({ composer: real });
    const s1 = await t.scopeOf();
    const f = await t.putFile(s1, inputs().edit, "mp4");
    const whole = await composeOne(t, s1, { clips: [{ fileId: f }] });
    // 5.5 s: 3.5 s of nothing (black, silent), then the white picture and the tone.
    expect(Number(probeJson(whole).streams.find((x) => x.codec_type === "video")!.nb_read_packets)).toBe(165);
    const c = colours(whole);
    expect(c[30]).toBe("black");
    expect(c[110]).not.toBe("black");
    const s2 = await t.scopeOf();
    const f2 = await t.putFile(s2, inputs().edit, "mp4");
    const part = await composeOne(t, s2, { clips: [{ fileId: f2, trim: { startSec: 3.4, endSec: 3.9 } }] });
    const c2 = colours(part);
    expect(c2.length).toBe(15);
    expect(c2.slice(0, 3).every((x) => x === "black")).toBe(true);
    expect(c2.slice(4).every((x) => x !== "black")).toBe(true);
    const pcm = pcmOf(part);
    expect(loudness(pcm, 0, 0.08)).toBeLessThan(300);
    expect(loudness(pcm, 0.15, 0.45)).toBeGreaterThan(1000);
    // A trim near the end the call could not know about is taken (its length is judged after decoding).
    const s3 = await t.scopeOf();
    const f3 = await t.putFile(s3, inputs().edit, "mp4");
    const end = await composeOne(t, s3, { clips: [{ fileId: f3, trim: { startSec: 4.3, endSec: 5 } }] });
    expect(colours(end).every((x) => x !== "black")).toBe(true);
  });

  it("review r4: a 1 s 44.1 kHz AAC counts as 1 s (its padding cut at the track's end)", async () => {
    const t = await start({ composer: real });
    const s1 = await t.scopeOf();
    const img = await t.putFile(s1, inputs().png, "png");
    const one = await t.putFile(s1, inputs().one, "m4a");
    const id = await t.queue(s1, {
      clips: [{ fileId: img, durationSec: 0.5 }],
      narration: [{ fileId: one, startSec: 0 }],
    });
    await t.drive();
    expect(t.job(id)).toMatchObject({ status: "done", durationMs: 1000 });
  });

  it("review r4: length-dependent rules wait for the decoded lengths — a VBR MP3 overestimated, subtitles and fades by its real end", async () => {
    const t = await start({ composer: real });
    // 100 s that ffprobe takes for far longer: the call does not refuse it (no length is judged then).
    const est = Number(
      execFileSync(FFPROBE, [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        inputs().vbr100,
      ]).toString(),
    );
    const s0 = await t.scopeOf();
    const img0 = await t.putFile(s0, inputs().png, "png");
    const long = await t.putFile(s0, inputs().vbr100, "mp3");
    const r = await t.call(s0, {
      clips: [{ fileId: img0, durationSec: 1 }],
      narration: [{ fileId: long, startSec: 0 }],
    });
    expect(r.ok, `${JSON.stringify(r)} (ffprobe ${est} s)`).toBe(true);
    await t.api(t.f.cookies.owner, "DELETE", `/api/conversations/${s0.conversationId}`);
    // 10 s that ffprobe takes for 6.6 s: subtitles at 8–9 s and fades of 6 s in all fit its real length.
    const s1 = await t.scopeOf();
    const img = await t.putFile(s1, inputs().png, "png");
    const nar = await t.putFile(s1, inputs().vbr, "mp3");
    const mus = await t.putFile(s1, inputs().wav, "wav");
    const out = await composeOne(t, s1, {
      clips: [{ fileId: img, durationSec: 1 }],
      narration: [{ fileId: nar, startSec: 0 }],
      music: { fileId: mus, fadeInSec: 3, fadeOutSec: 3 },
      subtitles: [{ startSec: 8, endSec: 9, text: "끝 무렵" }],
    });
    expect(
      Number(probeJson(out).streams.find((x) => x.codec_type === "video")!.nb_read_packets),
    ).toBeGreaterThan(295);
    // Too long once decoded: the job fails with its own code (the slot and the file place freed).
    const s2 = await t.scopeOf();
    const img2 = await t.putFile(s2, inputs().png, "png");
    const nar2 = await t.putFile(s2, inputs().vbr, "mp3");
    const id = await t.queue(s2, {
      clips: [{ fileId: img2, durationSec: 1 }],
      narration: [{ fileId: nar2, startSec: 295 }],
    });
    await t.drive();
    expect(t.job(id)).toMatchObject({ status: "failed", errorCode: "compose_too_long" });
    expect(t.app.files!.placesTaken(s2.conversationId)).toBe(2);
  });

  it("review r4: video with alpha is flattened over black (ProRes 4444, QuickTime Animation)", async () => {
    const t = await start({ composer: real });
    const s1 = await t.scopeOf();
    const pr = await t.putFile(s1, inputs().prores, "mp4");
    const out = await composeOne(t, s1, { clips: [{ fileId: pr }] });
    const px = frameAt(out, 0.5);
    const centre = (45 * 160 + 80) * 3;
    expect(px[centre]!).toBeGreaterThan(100);
    expect(px[centre]!).toBeLessThan(160);
    const s2 = await t.scopeOf();
    const a = await t.putFile(s2, inputs().qtrleRed, "mp4");
    const b = await t.putFile(s2, inputs().qtrleBlue, "mp4");
    const out2 = await composeOne(t, s2, { clips: [{ fileId: a }, { fileId: b }] });
    expect(new Set(colours(out2))).toEqual(new Set(["black"]));
  });

  it("review r4: a cue in the video's last 1/100 s and a tab survive in both tracks", async () => {
    const t = await start({ composer: real });
    const s1 = await t.scopeOf();
    const img = await t.putFile(s1, inputs().png, "png");
    const id = await t.queue(s1, {
      clips: [{ fileId: img, durationSec: 1 }],
      subtitles: [
        { startSec: 0.1, endSec: 0.5, text: "항목\t값" },
        { startSec: 0.996, endSec: 0.999, text: "끝" },
      ],
    });
    await t.drive();
    const done = t.job(id);
    expect(done.status, String(done.errorCode)).toBe("done");
    const out = t.app.files!.pathOf(t.app.files!.get(done.fileId!)!);
    const packets = JSON.parse(
      execFileSync(FFPROBE, [
        "-v",
        "error",
        "-select_streams",
        "s",
        "-show_packets",
        "-show_data",
        "-of",
        "json",
        out,
      ]).toString(),
    ) as { packets: { data: string; pts_time: string }[] };
    const texts = packets.packets
      .map((p) =>
        Buffer.from(
          p.data
            .split("\n")
            .map((l) => l.slice(10, 49).replace(/\s/g, ""))
            .join(""),
          "hex",
        ),
      )
      .filter((b) => b.length > 2 && b.readUInt16BE(0) > 0)
      .map((b) => b.subarray(2, 2 + b.readUInt16BE(0)).toString("utf8"));
    expect(texts).toEqual(["항목\t값", "끝"]);
    const vtt = (await t.api(t.f.cookies.owner, "GET", `/api/compose-jobs/${id}/subtitles.vtt`)).body;
    expect(vtt).toContain("\n항목\t값\n");
    expect(vtt).toContain("\n끝\n");
  });

  it("review r4: a trim with a shorter length decodes only what it shows", async () => {
    const calls: string[][] = [];
    const t = await start({
      composer: (d) =>
        sandboxedComposer({
          dataDir: d,
          ffmpegPath: FFMPEG,
          run: (o) => {
            calls.push(o.args);
            return runIsolated(o);
          },
        }),
    });
    const s1 = await t.scopeOf();
    const f = await t.putFile(s1, inputs().long, "mp4");
    calls.length = 0;
    await composeOne(t, s1, { clips: [{ fileId: f, trim: { startSec: 0, endSec: 300 }, durationSec: 1 }] });
    const ingest = calls.find((a) => a.includes("-vf") && a.includes("null"))!;
    expect(ingest[ingest.indexOf("-t") + 1]).toBe("2");
  });

  // ---- review r5, with the real ffmpeg
  it("review r5: one presentation timeline — a B-frame MP4 without an edit list starts at its first picture", async () => {
    const m = inputs();
    // The explicit empty edit is read from the file's own boxes; a reorder delay without an edit list is none.
    expect(mp4Timeline(m.edit)).toMatchObject({
      ok: true,
      video: { edited: true, lead: 3.5 },
      audio: { edited: true, lead: expect.closeTo(3.478, 3) },
    });
    expect(mp4Timeline(m.noel)).toEqual({
      ok: true,
      video: {
        edited: false,
        lead: 0,
        mediaTime: 0,
        end: null,
        exact: { edited: false, lead: { n: 0, d: 1 }, mediaTime: { n: 0, d: 1 }, end: null },
      },
      audio: null,
    });
    const t = await start({ composer: real });
    const s1 = await t.scopeOf();
    const f = await t.putFile(s1, m.noel, "mp4");
    const out = await composeOne(t, s1, { clips: [{ fileId: f }] });
    expect(colours(out)).toEqual(Array(30).fill("red"));
    // A normal libx264 B-frame MP4 with its edit list: its length, nothing added.
    const s2 = await t.scopeOf();
    const g = await t.putFile(s2, m.bframes, "mp4");
    const out2 = await composeOne(t, s2, { clips: [{ fileId: g }] });
    expect(Number(probeJson(out2).streams.find((x) => x.codec_type === "video")!.nb_read_packets)).toBe(60);
  });

  it("review r5: a 300 s B-frame MP4 without an edit list is exactly 5 minutes (not refused)", async () => {
    const dir = tmp();
    const long = path.join(dir, "noel300.mp4");
    execFileSync(FFMPEG, [
      ...["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=32x32:r=30:d=300"],
      ...[
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-bf",
        "2",
        "-pix_fmt",
        "yuv420p",
        "-use_editlist",
        "0",
        long,
      ],
    ]);
    const t = await start({ composer: real });
    const s1 = await t.scopeOf();
    const f = await t.putFile(s1, long, "mp4");
    const id = await t.queue(s1, { clips: [{ fileId: f }] });
    await t.drive();
    const done = t.job(id);
    expect(done.status, String(done.errorCode)).toBe("done");
    expect(done.durationMs).toBe(300_000);
  }, 600_000);

  it("review r5: silent narration (WAV, the speech fixture's silent MP3) of 1–2.9 s makes a sound track", async () => {
    const t = await start({ composer: real });
    const silentMp3File = path.join(tmp(), "silent.mp3");
    fs.writeFileSync(silentMp3File, silentMp3(40));
    for (const [src, kind, sec] of [
      [inputs().silent1, "wav", 1],
      [inputs().silent29, "wav", 2.9],
      [silentMp3File, "mp3", 1],
    ] as const) {
      const s = await t.scopeOf();
      const img = await t.putFile(s, inputs().png, "png");
      const nar = await t.putFile(s, src, kind);
      const id = await t.queue(s, {
        clips: [{ fileId: img, durationSec: sec }],
        narration: [{ fileId: nar, startSec: 0 }],
      });
      await t.drive();
      expect([src, t.job(id).status, t.job(id).errorCode]).toEqual([src, "done", null]);
    }
  });

  it("review r5: a clip's gain above 1 is not clipped before the mix (no added harmonics)", async () => {
    const t = await start({ composer: real });
    const s1 = await t.scopeOf();
    const f = await t.putFile(s1, inputs().loud, "mp4");
    const out = await composeOne(t, s1, { clips: [{ fileId: f, volume: 2 }] });
    const pcm = pcmOf(out).slice(12_000, 36_000);
    const level = (hz: number) => {
      let re = 0;
      let im = 0;
      for (let i = 0; i < pcm.length; i++) {
        re += pcm[i]! * Math.cos((2 * Math.PI * hz * i) / 48_000);
        im += pcm[i]! * Math.sin((2 * Math.PI * hz * i) / 48_000);
      }
      return Math.hypot(re, im);
    };
    const dbc = 20 * Math.log10(level(1500) / level(500));
    expect(dbc).toBeLessThan(-40);
  });

  it("review r5: cues at a 31-frame video's end and back-to-back cues in the last 1/20 s all reach the MP4", async () => {
    const t = await start({ composer: real });
    for (const [sec, cues] of [
      [31 / 30, [{ startSec: 1.031, endSec: 1.032, text: "끝" }]],
      [
        1,
        [
          { startSec: 0.955, endSec: 0.995, text: "하나" },
          { startSec: 0.996, endSec: 0.999, text: "둘" },
        ],
      ],
    ] as const) {
      const s = await t.scopeOf();
      const img = await t.putFile(s, inputs().png, "png");
      const id = await t.queue(s, { clips: [{ fileId: img, durationSec: sec }], subtitles: cues });
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
      for (const c of cues) expect(srt).toContain(c.text);
    }
  });

  it("review r5: a trim's first frame is the one on screen at its start (0.990 s: still red)", async () => {
    const t = await start({ composer: real });
    const s1 = await t.scopeOf();
    const f = await t.putFile(s1, inputs().rb, "mp4");
    const out = await composeOne(t, s1, {
      clips: [{ fileId: f, trim: { startSec: 0.99, endSec: 1.023333 } }],
    });
    expect(colours(out)).toEqual(["red"]);
  });

  it("review r5: subtitles keep indentation, blank lines and a trailing tab (MP4 and VTT)", async () => {
    const t = await start({ composer: real });
    const s1 = await t.scopeOf();
    const img = await t.putFile(s1, inputs().png, "png");
    const text = "    들여쓰기\n\n빈 줄 뒤\t";
    const id = await t.queue(s1, {
      clips: [{ fileId: img, durationSec: 1 }],
      subtitles: [{ startSec: 0, endSec: 0.9, text }],
    });
    await t.drive();
    const done = t.job(id);
    expect(done.status, String(done.errorCode)).toBe("done");
    const out = t.app.files!.pathOf(t.app.files!.get(done.fileId!)!);
    const packets = JSON.parse(
      execFileSync(FFPROBE, [
        "-v",
        "error",
        "-select_streams",
        "s",
        "-show_packets",
        "-show_data",
        "-of",
        "json",
        out,
      ]).toString(),
    ) as { packets: { data: string }[] };
    const fromMp4 = packets.packets
      .map((p) =>
        Buffer.from(
          p.data
            .split("\n")
            .map((l) => l.slice(10, 49).replace(/\s/g, ""))
            .join(""),
          "hex",
        ),
      )
      .filter((b) => b.length > 2 && b.readUInt16BE(0) > 0)
      .map((b) =>
        b
          .subarray(2, 2 + b.readUInt16BE(0))
          .toString("utf8")
          .replace(/⁠/g, ""),
      );
    expect(fromMp4).toEqual([text]);
    const vtt = (await t.api(t.f.cookies.owner, "GET", `/api/compose-jobs/${id}/subtitles.vtt`)).body;
    const cue = vtt.split("\n").slice(3, -1).join("\n").replace(/⁠/g, "");
    expect(cue).toBe(text);
  });

  it("review r5: an animated WebP is refused at the call with its own code", async () => {
    expect(isAnimatedWebp(inputs().anim)).toBe(true);
    expect(isAnimatedWebp(inputs().png)).toBe(false);
    const t = await start({ composer: real });
    const s1 = await t.scopeOf();
    const f = await t.putFile(s1, inputs().anim, "webp");
    expect(await t.call(s1, { clips: [{ fileId: f, durationSec: 1 }] })).toMatchObject({
      ok: false,
      code: "compose_input_animated",
      hint: MEDIA_TOOL_HINTS.compose_input_animated,
    });
  });

  // ---- re-plan 2 (review r6), with the real ffmpeg
  it("re-plan 2: edit lists this server does not present are refused at the call (compose_input_edited)", async () => {
    const dir = tmp();
    const m = inputs();
    // edit.mp4's picture track: [empty 3.5 s, media 2 s] — taken. Its variants are not.
    expect(mp4Timeline(m.edit)).toMatchObject({ ok: true, video: { edited: true, lead: 3.5, end: 5.5 } });
    expect(mp4Timeline(m.noel)).toMatchObject({ ok: true, video: { edited: false, end: null } });
    const shapes: Record<string, (e: { duration: number; media: number; rate: number }[]) => typeof e> = {
      // two media edits
      twoMedia: (e) => [{ ...e[0]!, media: 0 }, e[1]!],
      // an empty edit after the media
      emptyAfter: (e) => [{ ...e[1]! }, { ...e[0]! }],
      // played at rate 2
      rate2: (e) => [e[0]!, { ...e[1]!, rate: 2 }],
    };
    const t = await start({ composer: real });
    for (const [name, edit] of Object.entries(shapes)) {
      const file = path.join(dir, `${name}.mp4`);
      rewriteElst(m.edit, file, edit);
      expect([name, mp4Timeline(file)]).toEqual([name, { ok: false, reason: "unsupported" }]);
      const s = await t.scopeOf();
      const f = await t.putFile(s, file, "mp4");
      expect(await t.call(s, { clips: [{ fileId: f }] })).toMatchObject({
        ok: false,
        code: "compose_input_edited",
        hint: MEDIA_TOOL_HINTS.compose_input_edited,
      });
    }
    // A box that does not add up: unparsable, refused the same way.
    const broken = path.join(dir, "broken.mp4");
    const b = Buffer.from(fs.readFileSync(m.edit));
    const { entries } = videoElst(b);
    b.writeUInt32BE(0xffff, entries - 4); // the entry count, far past the box
    fs.writeFileSync(broken, b);
    expect(mp4Timeline(broken)).toEqual({ ok: false, reason: "unparsable" });
  });

  it("re-plan 2: a 64-bit moov header is read like the usual one (its empty edit kept: 5.5 s)", async () => {
    const big = path.join(tmp(), "big.mp4");
    bigMoov(inputs().edit, big);
    expect(mp4Timeline(big)).toMatchObject({ ok: true, video: { lead: 3.5, end: 5.5 } });
    const t = await start({ composer: real });
    const s1 = await t.scopeOf();
    const f = await t.putFile(s1, big, "mp4");
    const out = await composeOne(t, s1, { clips: [{ fileId: f }] });
    expect(Number(probeJson(out).streams.find((x) => x.codec_type === "video")!.nb_read_packets)).toBe(165);
    const c = colours(out);
    expect(c[100]).toBe("black");
    expect(c[110]).not.toBe("black");
  });

  it("re-plan 2: a picture is cut at its media edit's end (1.0 s of a longer track) — 299 s + 1 s is exactly 5 minutes", async () => {
    const dir = tmp();
    const src = path.join(dir, "long-last.mp4");
    execFileSync(FFMPEG, [
      ...["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64:r=30:d=1.1"],
      ...["-c:v", "libx264", "-bf", "2", "-pix_fmt", "yuv420p", src],
    ]);
    // Its edit says 1.000 s are presented (the frames after it, and a last frame's own duration, are not).
    const cut = path.join(dir, "cut.mp4");
    rewriteElst(src, cut, (e) => e.map((x) => ({ ...x, duration: 1000 })));
    expect(mp4Timeline(cut)).toMatchObject({ ok: true, video: { end: 1 } });
    const t = await start({ composer: real });
    const s1 = await t.scopeOf();
    const f = await t.putFile(s1, cut, "mp4");
    const out = await composeOne(t, s1, { clips: [{ fileId: f }] });
    expect(Number(probeJson(out).streams.find((x) => x.codec_type === "video")!.nb_read_packets)).toBe(30);
    // 299 s of a still and this 1 s: exactly 300 s, made.
    const s2 = await t.scopeOf();
    const img = await t.putFile(s2, inputs().png, "png");
    const f2 = await t.putFile(s2, cut, "mp4");
    const id = await t.queue(s2, {
      clips: [...Array.from({ length: 10 }, () => ({ fileId: img, durationSec: 29.9 })), { fileId: f2 }],
    });
    await t.drive();
    expect(t.job(id)).toMatchObject({ status: "done", durationMs: 300_000 });
  }, 600_000);

  it("re-plan 2: a 1 fps MOV with timescale 1 — a trim at 0.4 s changes picture exactly at output frame 18", async () => {
    const mov = path.join(tmp(), "ts1.mov");
    execFileSync(FFMPEG, [
      ...["-hide_banner", "-v", "error", "-f", "lavfi", "-i"],
      "nullsrc=s=64x64:r=1:d=3,format=rgb24,geq=r='if(lt(T\\,1)\\,255\\,0)':g=0:b='if(gte(T\\,1)\\,255\\,0)'",
      ...["-c:v", "libx264", "-pix_fmt", "yuv420p", "-video_track_timescale", "1", mov],
    ]);
    const t = await start({ composer: real });
    const s1 = await t.scopeOf();
    const f = await t.putFile(s1, mov, "mp4");
    const out = await composeOne(t, s1, { clips: [{ fileId: f, trim: { startSec: 0.4, endSec: 1.5 } }] });
    const c = colours(out);
    expect(c.slice(0, 18).every((x) => x === "red")).toBe(true);
    expect(c.slice(18).every((x) => x === "blue")).toBe(true);
  });

  it("re-plan 2: a short continuous narration keeps its last 100 ms (5 runs)", async () => {
    const wav = path.join(tmp(), "tone29.wav");
    execFileSync(FFMPEG, [
      ...["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "sine=f=440:r=48000:d=2.9"],
      ...["-c:a", "pcm_s16le", "-ac", "2", wav],
    ]);
    const t = await start({ composer: real });
    for (let k = 0; k < 5; k++) {
      const s = await t.scopeOf();
      const img = await t.putFile(s, inputs().png, "png");
      const nar = await t.putFile(s, wav, "wav");
      const out = await composeOne(t, s, {
        clips: [{ fileId: img, durationSec: 2.9 }],
        narration: [{ fileId: nar, startSec: 0 }],
      });
      expect([k, loudness(pcmOf(out), 2.8, 2.89) > 1000]).toEqual([k, true]);
    }
  });

  it("re-plan 2: the card's VTT keeps a cue in a 31-frame video's last fraction (its end from the frames)", async () => {
    const t = await start({ composer: real });
    const s1 = await t.scopeOf();
    const img = await t.putFile(s1, inputs().png, "png");
    const id = await t.queue(s1, {
      clips: [{ fileId: img, durationSec: 31 / 30 }],
      subtitles: [{ startSec: 1.0331, endSec: 1.0332, text: "영상 끝" }],
    });
    await t.drive();
    expect(t.job(id).status).toBe("done");
    const vtt = (await t.api(t.f.cookies.owner, "GET", `/api/compose-jobs/${id}/subtitles.vtt`)).body;
    expect(vtt).toContain("\n영상 끝\n");
  });

  // ---- review r7, with the real ffmpeg
  it("review r7: ducked clip sound and music keep their last 50 ms under a shorter narration (5 runs each)", async () => {
    const dir = tmp();
    const tone = path.join(dir, "tone1.mov");
    execFileSync(FFMPEG, [
      ...["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=30:d=1"],
      ...["-f", "lavfi", "-i", "sine=f=440:r=48000:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p"],
      ...["-c:a", "pcm_s16le", "-shortest", tone],
    ]);
    const half = path.join(dir, "silent-0.5.wav");
    execFileSync(FFMPEG, [
      ...[
        "-hide_banner",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=stereo,atrim=duration=0.5",
      ],
      ...["-c:a", "pcm_s16le", half],
    ]);
    const toneWav = path.join(dir, "tone1.wav");
    execFileSync(FFMPEG, [
      ...["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "sine=f=440:r=48000:d=1"],
      ...["-c:a", "pcm_s16le", toneWav],
    ]);
    const t = await start({ composer: real });
    for (let k = 0; k < 5; k++) {
      const s = await t.scopeOf();
      const v = await t.putFile(s, tone, "mp4");
      const n = await t.putFile(s, half, "wav");
      const out = await composeOne(t, s, { clips: [{ fileId: v }], narration: [{ fileId: n, startSec: 0 }] });
      expect(["clip", k, loudness(pcmOf(out), 0.95, 0.999) > 1000]).toEqual(["clip", k, true]);
      const s2 = await t.scopeOf();
      const img = await t.putFile(s2, inputs().png, "png");
      const n2 = await t.putFile(s2, half, "wav");
      const mus = await t.putFile(s2, toneWav, "wav");
      const out2 = await composeOne(t, s2, {
        clips: [{ fileId: img, durationSec: 1 }],
        narration: [{ fileId: n2, startSec: 0 }],
        music: { fileId: mus, volume: 1, loop: false, duck: true },
      });
      expect(["music", k, loudness(pcmOf(out2), 0.95, 0.999) > 1000]).toEqual(["music", k, true]);
    }
  }, 600_000);

  it("review r7: a fragmented MP4 (delay_moov, empty_moov) plays through — its length and its four scenes", async () => {
    const dir = tmp();
    const scenes = path.join(dir, "scenes.png");
    void scenes;
    const t = await start({ composer: real });
    for (const flags of ["delay_moov+frag_keyframe", "empty_moov+frag_keyframe"]) {
      const file = path.join(dir, `${flags.split("+")[0]}.mp4`);
      execFileSync(FFMPEG, [
        ...["-hide_banner", "-v", "error", "-f", "lavfi", "-i"],
        "nullsrc=s=64x64:r=30:d=4,format=rgb24,geq=r='if(lt(T\\,1)+between(T\\,2\\,2.999)\\,255\\,0)':g='if(gte(T\\,2)\\,255\\,0)':b='if(between(T\\,1\\,2.999)\\,255\\,0)'",
        ...["-c:v", "libx264", "-bf", "2", "-g", "30", "-pix_fmt", "yuv420p", "-movflags", flags, file],
      ]);
      const s = await t.scopeOf();
      const f = await t.putFile(s, file, "mp4");
      const out = await composeOne(t, s, { clips: [{ fileId: f }] });
      const c = colours(out);
      const runs = c.map((x) => (x.startsWith("other(25") ? "white" : x));
      expect([flags, runs.length]).toEqual([flags, 120]);
      expect([flags, runs[15], runs[45], runs[75], runs[105]]).toEqual([
        flags,
        "red",
        "blue",
        "white",
        "green",
      ]);
    }
  });

  it("review r7: a media edit starting inside a sample (AVFoundation-style 0.4–1.5 s of a 1 fps MOV) keeps that sample — with and without a lead", async () => {
    const dir = tmp();
    const t = await start({ composer: real });
    for (const lead of [0, 1]) {
      const src = path.join(dir, `src-${lead}.mov`);
      execFileSync(FFMPEG, [
        ...["-hide_banner", "-v", "error", ...(lead ? ["-itsoffset", "1"] : []), "-f", "lavfi", "-i"],
        "nullsrc=s=64x64:r=1:d=3,format=rgb24,geq=r='if(lt(T\\,1)\\,255\\,0)':g=0:b='if(gte(T\\,1)\\,255\\,0)'",
        ...["-c:v", "libx264", "-bf", "0", "-pix_fmt", "yuv420p", "-video_track_timescale", "16384", src],
      ]);
      // The export's edit: media time 0.4 s (6554 / 16384), 1.1 s shown (the movie's timescale is 1000).
      const edited = path.join(dir, `edited-${lead}.mov`);
      rewriteElst(src, edited, (e) =>
        e.map((x) => (x.media === -1 ? x : { ...x, media: 6554, duration: 1100 })),
      );
      expect(mp4Timeline(edited)).toMatchObject({
        ok: true,
        video: { edited: true, lead, mediaTime: expect.closeTo(0.4, 3), end: expect.closeTo(lead + 1.1, 3) },
      });
      const s = await t.scopeOf();
      const f = await t.putFile(s, edited, "mp4");
      const out = await composeOne(t, s, { clips: [{ fileId: f }] });
      const c = colours(out);
      expect([lead, c.length]).toEqual([lead, 30 * lead + 33]);
      expect(c.slice(0, 30 * lead).every((x) => x === "black")).toBe(true);
      expect(c.slice(30 * lead, 30 * lead + 18).every((x) => x === "red")).toBe(true);
      expect(c.slice(30 * lead + 18).every((x) => x === "blue")).toBe(true);
    }
  });

  // ---- review r8, with the real ffmpeg
  it("review r8: a MOV without an edit list keeps its sound before the first picture (30 fps: 55 ms, 2 fps: 0.4 s)", async () => {
    const dir = tmp();
    const t = await start({ composer: real });
    for (const [rate, until, d] of [
      [30, 0.055, 2],
      [2, 0.4, 4],
    ] as const) {
      const mov = path.join(dir, `slate-${rate}.mov`);
      execFileSync(FFMPEG, [
        ...["-hide_banner", "-v", "error", "-f", "lavfi", "-i"],
        `aevalsrc=if(lt(t\\,${until})\\,sin(2*PI*550*t)*0.5\\,0):s=48000:d=${d}`,
        ...["-f", "lavfi", "-i", `color=c=red:s=64x64:r=${rate}:d=${d}`, "-map", "1:v", "-map", "0:a"],
        ...["-c:v", "libx264", "-bf", "2", "-x264-params", "b-adapt=0", "-pix_fmt", "yuv420p"],
        ...["-c:a", "pcm_s16le", "-use_editlist", "0", mov],
      ]);
      // A reorder delay without an edit list: the picture's first sample is late, the sound's is at 0.
      expect(mp4Timeline(mov)).toMatchObject({
        ok: true,
        video: { edited: false },
        audio: { edited: false },
      });
      const s = await t.scopeOf();
      const f = await t.putFile(s, mov, "mp4");
      const out = await composeOne(t, s, { clips: [{ fileId: f }] });
      expect([rate, loudness(pcmOf(out), 0, until - 0.005) > 1000]).toEqual([rate, true]);
      const c = colours(out);
      expect([rate, c.at(-1)]).toEqual([rate, "red"]);
    }
  });

  it("review r8: a leading empty edit as long as its media time (PCM 0.25 s, AAC 28 ms) leaves the media before it out", async () => {
    const dir = tmp();
    const t = await start({ composer: real });
    for (const [codec, lead] of [
      ["pcm_s16le", 0.25],
      ["aac", 0.028],
    ] as const) {
      const src = path.join(dir, `lead-${codec}.mov`);
      execFileSync(FFMPEG, [
        ...["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=64x64:r=30:d=2"],
        ...["-itsoffset", String(lead), "-f", "lavfi", "-i", "sine=f=440:r=48000:d=2"],
        ...["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", codec, src],
      ]);
      // The export's sound edit: nothing until `lead`, then its media from `lead` (in the track's 48 kHz units).
      const eq = path.join(dir, `equal-${codec}.mov`);
      rewriteElst(
        src,
        eq,
        (e) =>
          [
            { duration: Math.round(lead * 1000), media: -1, rate: 1 },
            { duration: 2000 - Math.round(lead * 1000), media: Math.round(lead * 48_000), rate: 1 },
          ].slice(-e.length),
        "soun",
      );
      expect(mp4Timeline(eq)).toMatchObject({
        ok: true,
        audio: { edited: true, lead: expect.closeTo(lead, 6), mediaTime: expect.closeTo(lead, 6) },
      });
      const s = await t.scopeOf();
      const f = await t.putFile(s, eq, "mp4");
      const out = await composeOne(t, s, { clips: [{ fileId: f }] });
      const pcm = pcmOf(out);
      expect([codec, loudness(pcm, 0, lead - 0.002)]).toEqual([codec, expect.any(Number)]);
      expect([codec, loudness(pcm, 0, lead - 0.002) < 50]).toEqual([codec, true]);
      expect([codec, loudness(pcm, lead + 0.1, 1.5) > 1000]).toEqual([codec, true]);
    }
  });

  it("review r8: a trim after the picture's edit end (0.5 s of 2 s with 2 s of sound) holds the last frame allowed", async () => {
    const dir = tmp();
    const src = path.join(dir, "shortv-src.mov");
    execFileSync(FFMPEG, [
      ...["-hide_banner", "-v", "error", "-f", "lavfi", "-i"],
      "nullsrc=s=64x64:r=30:d=2,format=rgb24,geq=r='if(gte(T\\,0.5)\\,255\\,0)':g='if(gte(T\\,0.5)\\,255\\,0)':b=255",
      ...[
        "-f",
        "lavfi",
        "-i",
        "sine=f=440:r=48000:d=2",
        "-c:v",
        "libx264",
        "-bf",
        "0",
        "-pix_fmt",
        "yuv420p",
      ],
      ...["-c:a", "pcm_s16le", src],
    ]);
    // Blue for 0.5 s, then white: the picture's edit presents the blue only.
    const mov = path.join(dir, "shortv.mov");
    rewriteElst(src, mov, (e) => e.map((x) => (x.media === -1 ? x : { ...x, duration: 500 })));
    expect(mp4Timeline(mov)).toMatchObject({ ok: true, video: { end: 0.5 }, audio: { end: 2 } });
    const t = await start({ composer: real });
    for (const [trim, n] of [
      [null, 60],
      [{ startSec: 0, endSec: 0.4 }, 12],
      [{ startSec: 0.3, endSec: 1 }, 21],
      [{ startSec: 0.6, endSec: 1.4 }, 24],
    ] as const) {
      const s = await t.scopeOf();
      const f = await t.putFile(s, mov, "mp4");
      const out = await composeOne(t, s, { clips: [{ fileId: f, ...(trim ? { trim } : {}) }] });
      expect([trim, colours(out)]).toEqual([trim, Array(n).fill("blue")]);
    }
  });

  it("review r8: an empty_moov MP4 with sound plays its picture and its sound together (the sound's 2 frames first kept)", async () => {
    const dir = tmp();
    const file = path.join(dir, "frag-sound.mp4");
    execFileSync(FFMPEG, [
      ...["-hide_banner", "-v", "error", "-f", "lavfi", "-i"],
      "nullsrc=s=64x64:r=30:d=4,format=rgb24,geq=r='if(between(T\\,2\\,2.499)\\,255\\,0)':g='if(between(T\\,2\\,2.499)\\,255\\,0)':b='if(between(T\\,2\\,2.499)\\,255\\,0)'",
      ...["-f", "lavfi", "-i", "aevalsrc=if(between(t\\,2\\,2.499)\\,sin(2*PI*550*t)*0.5\\,0):s=48000:d=4"],
      ...["-c:v", "libx264", "-bf", "2", "-g", "30", "-pix_fmt", "yuv420p", "-c:a", "aac"],
      ...["-movflags", "empty_moov+frag_keyframe", file],
    ]);
    const t = await start({ composer: real });
    const s = await t.scopeOf();
    const f = await t.putFile(s, file, "mp4");
    const out = await composeOne(t, s, { clips: [{ fileId: f }] });
    const c = colours(out).map((x) => (x.startsWith("other(25") ? "white" : x));
    const pcm = pcmOf(out);
    const sound = pcm.findIndex((v) => Math.abs(v) > 1000) / 48_000;
    const picture = c.indexOf("white") / 30;
    // The file's sound track starts at 0 (the muxer stretches its first AAC sample over the picture's reorder delay):
    // that 0.0667 s is kept, and the flash and the beep stay together.
    expect(c.length).toBe(122);
    expect(Math.abs(sound - picture)).toBeLessThan(1 / 30);
  });

  // ---- review r9, with the real ffmpeg
  it("review r9: a red·green·blue frame cycle keeps every frame — trimmed at k/30, and untrimmed with 0, 1 or 2 B-frames", async () => {
    const dir = tmp();
    const t = await start({ composer: real });
    for (const bf of [0, 1, 2]) {
      const file = path.join(dir, `rgb-bf${bf}.mp4`);
      execFileSync(FFMPEG, [
        ...["-hide_banner", "-v", "error", "-f", "lavfi", "-i"],
        "nullsrc=s=64x64:r=30:d=2,format=rgb24,geq=r='if(eq(mod(N\\,3)\\,0)\\,255\\,0)':g='if(eq(mod(N\\,3)\\,1)\\,255\\,0)':b='if(eq(mod(N\\,3)\\,2)\\,255\\,0)'",
        ...["-f", "lavfi", "-i", "sine=f=500:r=48000:d=2", "-c:v", "libx264", "-bf", String(bf)],
        ...["-x264-params", "b-adapt=0", "-pix_fmt", "yuv420p", "-c:a", "aac", file],
      ]);
      // The source's own frames, in presentation order.
      const src = colours(file);
      expect([bf, src.length, new Set(src.slice(0, 3)).size]).toEqual([bf, 60, 3]);
      const whole = await (async () => {
        const s = await t.scopeOf();
        const f = await t.putFile(s, file, "mp4");
        return colours(await composeOne(t, s, { clips: [{ fileId: f }] }));
      })();
      expect([bf, "whole", whole]).toEqual([bf, "whole", src]);
      for (const k of [1, 2, 3, 12, 31]) {
        const s = await t.scopeOf();
        const f = await t.putFile(s, file, "mp4");
        const out = await composeOne(t, s, {
          clips: [{ fileId: f, trim: { startSec: k / 30, endSec: k / 30 + 0.7 } }],
        });
        expect([bf, k, colours(out)]).toEqual([bf, k, src.slice(k, k + 21)]);
      }
    }
  }, 600_000);

  // ---- review r10, with the real ffmpeg
  // A red·green·blue cycle of single frames at `rate`, H.264 (`bf` B-frames), with or without its edit list and sound.
  const cycle = (
    file: string,
    o: { rate: string; bf: number; editlist?: boolean; sound?: boolean; offset?: number },
  ) =>
    execFileSync(FFMPEG, [
      ...["-hide_banner", "-v", "error"],
      ...(o.offset ? ["-itsoffset", String(o.offset)] : []),
      ...["-f", "lavfi", "-i"],
      `nullsrc=s=64x64:r=${o.rate}:d=2,format=rgb24,geq=r='if(eq(mod(N\\,3)\\,0)\\,255\\,0)':g='if(eq(mod(N\\,3)\\,1)\\,255\\,0)':b='if(eq(mod(N\\,3)\\,2)\\,255\\,0)'`,
      ...(o.sound ? ["-f", "lavfi", "-i", "sine=f=500:r=48000:d=2", "-c:a", "aac"] : []),
      ...["-c:v", "libx264", "-bf", String(o.bf), "-x264-params", "b-adapt=0", "-pix_fmt", "yuv420p"],
      ...(o.editlist === false ? ["-use_editlist", "0"] : []),
      file,
    ]);

  it("review r10: a picture without an edit list whose first frame is at 512/15360 (and a 60 fps one) keeps every frame", async () => {
    const dir = tmp();
    const t = await start({ composer: real });
    const one = path.join(dir, "noel-bf1.mp4");
    cycle(one, { rate: "30", bf: 1, editlist: false });
    expect(mp4Timeline(one)).toMatchObject({ ok: true, video: { edited: false }, audio: null });
    const src = colours(one);
    const s1 = await t.scopeOf();
    const f1 = await t.putFile(s1, one, "mp4");
    expect(colours(await composeOne(t, s1, { clips: [{ fileId: f1 }] }))).toEqual(src);
    // 60 fps to 30: every other frame.
    const sixty = path.join(dir, "noel-60.mp4");
    cycle(sixty, { rate: "60", bf: 2, editlist: false });
    const src60 = colours(sixty);
    expect(src60.length).toBe(120);
    const s2 = await t.scopeOf();
    const f2 = await t.putFile(s2, sixty, "mp4");
    const out = colours(await composeOne(t, s2, { clips: [{ fileId: f2 }] }));
    expect(out).toEqual(src60.filter((_, k) => k % 2 === 0));
  });

  it("review r10: a picture starting 0.1 s late (a leading empty edit), trimmed at 1/30 s — two black frames, then its first", async () => {
    const dir = tmp();
    const file = path.join(dir, "late-0.1.mp4");
    cycle(file, { rate: "30", bf: 2, sound: true, offset: 0.1 });
    expect(mp4Timeline(file)).toMatchObject({ ok: true, video: { edited: true, lead: 0.1 } });
    // Its own frames from its first: the same cycle made without the offset.
    const ref = path.join(dir, "early.mp4");
    cycle(ref, { rate: "30", bf: 2, sound: true });
    const src = colours(ref);
    const t = await start({ composer: real });
    const s = await t.scopeOf();
    const f = await t.putFile(s, file, "mp4");
    const out = colours(
      await composeOne(t, s, { clips: [{ fileId: f, trim: { startSec: 1 / 30, endSec: 0.7 } }] }),
    );
    expect(out).toEqual(["black", "black", ...src.slice(0, 18)]);
  });

  it("review r10: 24, 25 and 29.97 fps sources — each output frame is the one on screen at k/30 (whole and trimmed at 1/30)", async () => {
    const dir = tmp();
    const t = await start({ composer: real });
    for (const [rate, num, den] of [
      ["24", 24, 1],
      ["25", 25, 1],
      ["30000/1001", 30000, 1001],
    ] as const) {
      const file = path.join(dir, `rgb-${num}.mp4`);
      cycle(file, { rate, bf: 2, sound: true });
      const src = colours(file);
      // The frame on screen at time n/30 (+ the trim): the last one that began at or before it, exactly.
      const at = (n: number, from: number) =>
        src[Math.min(src.length - 1, Math.floor(((n + from) * num) / (30 * den)))];
      for (const from of [0, 1]) {
        const s = await t.scopeOf();
        const f = await t.putFile(s, file, "mp4");
        const out = colours(
          await composeOne(t, s, {
            clips: [{ fileId: f, ...(from ? { trim: { startSec: from / 30, endSec: 1.5 } } : {}) }],
          }),
        );
        expect([rate, from, out]).toEqual([rate, from, out.map((_, n) => at(n, from))]);
      }
    }
  }, 600_000);

  // ---- review r11, with the real ffmpeg
  it("review r11: with a narration (0.5 s of silence), clip sound and music — ducked or not — last to the end of a 3, 3.8 and 4 s result", async () => {
    const dir = tmp();
    const half = path.join(dir, "silent-0.5.wav");
    execFileSync(FFMPEG, [
      ...[
        "-hide_banner",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=48000:cl=stereo,atrim=duration=0.5",
      ],
      ...["-c:a", "pcm_s16le", half],
    ]);
    const t = await start({ composer: real });
    for (const sec of [3, 3.8, 4]) {
      const mov = path.join(dir, `tone-${sec}.mp4`);
      execFileSync(FFMPEG, [
        ...["-hide_banner", "-v", "error", "-f", "lavfi", "-i", `color=c=black:s=64x64:r=30:d=${sec}`],
        ...["-f", "lavfi", "-i", `sine=f=440:r=48000:d=${sec}`, "-c:v", "libx264", "-pix_fmt", "yuv420p"],
        ...["-c:a", "aac", "-shortest", mov],
      ]);
      const wav = path.join(dir, `music-${sec}.wav`);
      execFileSync(FFMPEG, [
        ...["-hide_banner", "-v", "error", "-f", "lavfi", "-i", `sine=f=330:r=48000:d=${sec + 1}`],
        ...["-c:a", "pcm_s16le", wav],
      ]);
      const s = await t.scopeOf();
      const v = await t.putFile(s, mov, "mp4");
      const n = await t.putFile(s, half, "wav");
      const out = await composeOne(t, s, { clips: [{ fileId: v }], narration: [{ fileId: n, startSec: 0 }] });
      const pcm = pcmOf(out);
      expect(["clip", sec, pcm.length / 48_000]).toEqual(["clip", sec, expect.closeTo(sec, 1)]);
      expect(["clip", sec, loudness(pcm, sec - 0.1, sec - 0.01) > 1000]).toEqual(["clip", sec, true]);
      for (const duck of [true, false]) {
        const s2 = await t.scopeOf();
        const img = await t.putFile(s2, inputs().png, "png");
        const n2 = await t.putFile(s2, half, "wav");
        const mus = await t.putFile(s2, wav, "wav");
        const out2 = await composeOne(t, s2, {
          clips: [{ fileId: img, durationSec: sec }],
          narration: [{ fileId: n2, startSec: 0 }],
          music: { fileId: mus, volume: 1, loop: false, duck },
        });
        const p2 = pcmOf(out2);
        expect(["music", sec, duck, loudness(p2, sec - 0.1, sec - 0.01) > 1000]).toEqual([
          "music",
          sec,
          duck,
          true,
        ]);
      }
    }
  }, 600_000);

  it("review r11: 40 images joined by 39 seven-frame fades (4-frame pieces between) — every frame of the file at exactly k/30", async () => {
    const t = await start({ composer: real });
    const s = await t.scopeOf();
    const m = inputs();
    const red = await t.putFile(s, m.png, "png");
    const blue = await t.putFile(s, m.alphaBlue, "png");
    const id = await t.queue(s, {
      clips: Array.from({ length: 40 }, (_, i) => ({
        fileId: i % 2 ? blue : red,
        // 4-frame bodies between the fades (a 4-frame MP4 reports 0.133008 s).
        durationSec: i === 0 || i === 39 ? 0.5 : 18 / 30,
        ...(i < 39 ? { transition: { type: "fade", durationSec: 7 / 30 } } : {}),
      })),
    });
    await t.drive();
    const done = t.job(id);
    expect(done.status, String(done.errorCode)).toBe("done");
    const out = t.app.files!.pathOf(t.app.files!.get(done.fileId!)!);
    const j = JSON.parse(
      execFileSync(FFPROBE, [
        ...[
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=time_base:packet=pts",
          "-of",
          "json",
          out,
        ],
      ]).toString(),
    ) as { streams: { time_base: string }[]; packets: { pts: number }[] };
    const [tn, td] = j.streams[0]!.time_base.split("/").map(Number) as [number, number];
    const pts = j.packets.map((x) => x.pts).sort((a, b) => a - b);
    expect(pts.length).toBe(2 * 15 + 38 * 18 - 39 * 7);
    // Frame k at k/30: pts · tn / td = k / 30, in whole numbers.
    const off = pts.map((p, k) => p * tn * 30 - k * td).filter((x) => x !== 0);
    expect(off).toEqual([]);
  }, 600_000);

  // ---- review r12, with the real ffmpeg
  it("review r12: a clip held for a narration holds the source's last frame (60 and 120 fps exact 1 s, 30 fps trimmed to 1.010 s)", async () => {
    const dir = tmp();
    const nar = path.join(dir, "silent-2.wav");
    execFileSync(FFMPEG, [
      ...["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo,atrim=duration=2"],
      ...["-c:a", "pcm_s16le", nar],
    ]);
    const t = await start({ composer: real });
    for (const [rate, d, trim, want] of [
      // The last frame blue: red ×(rate − 1), blue ×1 in exactly 1 s.
      [60, 1, null, [30, 30]],
      [120, 1, null, [30, 30]],
      // Blue from 1.000 s; the part up to 1.010 s includes its first blue frame.
      [30, 2, { startSec: 0, endSec: 1.01 }, [30, 30]],
      [30, 1, null, [29, 31]],
    ] as const) {
      const file = path.join(dir, `last-${rate}-${d}.mp4`);
      const blueFrom = d === 1 ? `gte(N\\,${rate - 1})` : `gte(T\\,1)`;
      execFileSync(FFMPEG, [
        ...["-hide_banner", "-v", "error", "-f", "lavfi", "-i"],
        `nullsrc=s=64x64:r=${rate}:d=${d},format=rgb24,geq=r='if(${blueFrom}\\,0\\,255)':g=0:b='if(${blueFrom}\\,255\\,0)'`,
        ...["-c:v", "libx264", "-pix_fmt", "yuv420p", file],
      ]);
      const s = await t.scopeOf();
      const f = await t.putFile(s, file, "mp4");
      const n = await t.putFile(s, nar, "wav");
      const out = colours(
        await composeOne(t, s, {
          clips: [{ fileId: f, ...(trim ? { trim } : {}) }],
          narration: [{ fileId: n, startSec: 0 }],
        }),
      );
      expect([rate, d, out]).toEqual([
        rate,
        d,
        [...Array(want[0]).fill("red"), ...Array(want[1]).fill("blue")],
      ]);
    }
  });

  it("review r12: a 1-frame cut then a 30-frame one, and photos whose first body is 1 frame — the MP4 says 30 fps and its true length", async () => {
    const t = await start({ composer: real });
    const m = inputs();
    const meta = (file: string) =>
      JSON.parse(
        execFileSync(FFPROBE, [
          ...[
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=duration,avg_frame_rate,nb_frames",
          ],
          ...["-of", "json", file],
        ]).toString(),
      ).streams[0] as { duration: string; avg_frame_rate: string; nb_frames: string };
    const s1 = await t.scopeOf();
    const v = await t.putFile(s1, m.video, "mp4");
    const a = await composeOne(t, s1, {
      clips: [
        { fileId: v, trim: { startSec: 0, endSec: 1 / 30 } },
        { fileId: v, trim: { startSec: 0, endSec: 1 } },
      ],
    });
    expect(meta(a)).toEqual({ duration: "1.033333", avg_frame_rate: "30/1", nb_frames: "31" });
    const s2 = await t.scopeOf();
    const img = await t.putFile(s2, m.png, "png");
    const blue = await t.putFile(s2, m.alphaBlue, "png");
    // 16 frames, 15 of them fading into the next: a 1-frame first body.
    const b = await composeOne(t, s2, {
      clips: [
        { fileId: img, durationSec: 16 / 30, transition: { type: "fade", durationSec: 0.5 } },
        { fileId: blue, durationSec: 1 },
      ],
    });
    expect(meta(b)).toEqual({ duration: "1.033333", avg_frame_rate: "30/1", nb_frames: "31" });
  });

  // ---- review r13, with the real ffmpeg
  it("review r13: choosing only a leading empty edit (to 0.999 s, 1 s) and holding it shows none of the picture; to 1.01 s holds its first frame", async () => {
    const dir = tmp();
    const src = path.join(dir, "src-lead.mov");
    execFileSync(FFMPEG, [
      ...["-hide_banner", "-v", "error", "-itsoffset", "1", "-f", "lavfi", "-i"],
      "nullsrc=s=64x64:r=1:d=3,format=rgb24,geq=r='if(lt(T\\,1)\\,255\\,0)':g=0:b='if(gte(T\\,1)\\,255\\,0)'",
      ...["-c:v", "libx264", "-bf", "0", "-pix_fmt", "yuv420p", "-video_track_timescale", "16384", src],
    ]);
    // Nothing until 1 s, then its media from 0.4 s: the red frame (media 0) is already on screen at the edit's start.
    const mov = path.join(dir, "lead.mov");
    rewriteElst(src, mov, (e) => e.map((x) => (x.media === -1 ? x : { ...x, media: 6554, duration: 1100 })));
    expect(mp4Timeline(mov)).toMatchObject({ ok: true, video: { edited: true, lead: 1 } });
    const nar = path.join(dir, "silent-2.wav");
    execFileSync(FFMPEG, [
      ...["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo,atrim=duration=2"],
      ...["-c:a", "pcm_s16le", nar],
    ]);
    const t = await start({ composer: real });
    for (const [endSec, want] of [
      [0.999, Array(60).fill("black")],
      [1, Array(60).fill("black")],
      [1.01, [...Array(30).fill("black"), ...Array(30).fill("red")]],
    ] as const) {
      const s = await t.scopeOf();
      const f = await t.putFile(s, mov, "mp4");
      const n = await t.putFile(s, nar, "wav");
      const out = await composeOne(t, s, {
        clips: [{ fileId: f, trim: { startSec: 0, endSec } }],
        narration: [{ fileId: n, startSec: 0 }],
      });
      expect([endSec, colours(out)]).toEqual([endSec, want]);
    }
  });

  it("review r13: a 120 fps file of 121 frames (its last 1.000–1.008 s) keeps that frame — held, and as a trim's start", async () => {
    const dir = tmp();
    const nar = path.join(dir, "silent-2.wav");
    execFileSync(FFMPEG, [
      ...["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo,atrim=duration=2"],
      ...["-c:a", "pcm_s16le", nar],
    ]);
    const t = await start({ composer: real });
    for (const flags of [
      ["-use_editlist", "0"],
      ["-movflags", "empty_moov+frag_keyframe"],
    ]) {
      const file = path.join(dir, `tail120-${flags[0]}.mp4`);
      execFileSync(FFMPEG, [
        ...["-hide_banner", "-v", "error", "-f", "lavfi", "-i"],
        "nullsrc=s=64x64:r=120:d=1.00833,format=rgb24,geq=r='if(gte(N\\,120)\\,0\\,255)':g=0:b='if(gte(N\\,120)\\,255\\,0)'",
        ...["-frames:v", "121", "-c:v", "libx264", "-bf", "2", "-pix_fmt", "yuv420p", ...flags, file],
      ]);
      const s = await t.scopeOf();
      const f = await t.putFile(s, file, "mp4");
      const n = await t.putFile(s, nar, "wav");
      const out = await composeOne(t, s, { clips: [{ fileId: f }], narration: [{ fileId: n, startSec: 0 }] });
      expect([flags, colours(out)]).toEqual([flags, [...Array(30).fill("red"), ...Array(30).fill("blue")]]);
      const s2 = await t.scopeOf();
      const f2 = await t.putFile(s2, file, "mp4");
      const one = await composeOne(t, s2, {
        clips: [{ fileId: f2, trim: { startSec: 1, endSec: 1 + 1 / 30 } }],
      });
      expect([flags, colours(one)]).toEqual([flags, ["blue"]]);
    }
  });

  it("review r13: a clip of 1.020 s by its length cuts the source's sound there, as a trim to 1.020 s does", async () => {
    const dir = tmp();
    const mov = path.join(dir, "late-sound.mov");
    execFileSync(FFMPEG, [
      ...["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "color=c=black:s=64x64:r=30:d=2"],
      ...["-f", "lavfi", "-i", "aevalsrc=if(gte(t\\,1.02)\\,sin(2*PI*550*t)*0.5\\,0):s=48000:d=2"],
      ...["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", mov],
    ]);
    const t = await start({ composer: real });
    for (const clip of [{ durationSec: 1.02 }, { trim: { startSec: 0, endSec: 1.02 } }]) {
      const s = await t.scopeOf();
      const f = await t.putFile(s, mov, "mp4");
      const out = await composeOne(t, s, { clips: [{ fileId: f, ...clip }] });
      const pcm = pcmOf(out);
      expect([clip, loudness(pcm, 0.5, 1.0) < 50]).toEqual([clip, true]);
      expect([clip, loudness(pcm, 1.022, 1.031) < 50]).toEqual([clip, true]);
    }
  });

  // ---- review r14, with the real ffmpeg
  it("review r14: a rotated 120 fps file of 121 frames (no edit list, fragmented) keeps its last frame — held, and as a trim's start", async () => {
    const dir = tmp();
    const nar = path.join(dir, "silent-2.wav");
    execFileSync(FFMPEG, [
      ...["-hide_banner", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo,atrim=duration=2"],
      ...["-c:a", "pcm_s16le", nar],
    ]);
    const plain = path.join(dir, "tail120.mp4");
    execFileSync(FFMPEG, [
      ...["-hide_banner", "-v", "error", "-f", "lavfi", "-i"],
      "nullsrc=s=64x64:r=120:d=1.00833,format=rgb24,geq=r='if(gte(N\\,120)\\,0\\,255)':g=0:b='if(gte(N\\,120)\\,255\\,0)'",
      ...[
        "-frames:v",
        "121",
        "-c:v",
        "libx264",
        "-bf",
        "2",
        "-pix_fmt",
        "yuv420p",
        "-use_editlist",
        "0",
        plain,
      ],
    ]);
    const t = await start({ composer: real });
    for (const flags of [
      ["-use_editlist", "0"],
      ["-movflags", "empty_moov+frag_keyframe"],
    ]) {
      // Rotation side data: ffprobe's compact line for the stream then ends with a delimiter.
      const file = path.join(dir, `rot-${flags[0]}.mp4`);
      execFileSync(FFMPEG, [
        ...[
          "-hide_banner",
          "-v",
          "error",
          "-display_rotation",
          "90",
          "-i",
          plain,
          "-c",
          "copy",
          ...flags,
          file,
        ],
      ]);
      const s = await t.scopeOf();
      const f = await t.putFile(s, file, "mp4");
      const n = await t.putFile(s, nar, "wav");
      const out = await composeOne(t, s, { clips: [{ fileId: f }], narration: [{ fileId: n, startSec: 0 }] });
      expect([flags, colours(out)]).toEqual([flags, [...Array(30).fill("red"), ...Array(30).fill("blue")]]);
      const s2 = await t.scopeOf();
      const f2 = await t.putFile(s2, file, "mp4");
      const one = await composeOne(t, s2, {
        clips: [{ fileId: f2, trim: { startSec: 1, endSec: 1 + 1 / 30 } }],
      });
      expect([flags, colours(one)]).toEqual([flags, ["blue"]]);
    }
  });

  it("review r14: when the picture's packet scan fails or says nothing usable, the job fails (compose_failed) — never a guessed length; the slot is free", async () => {
    let mode: "fail" | "empty" | "real" = "fail";
    const t = await start({
      composer: (d) =>
        sandboxedComposer({
          dataDir: d,
          ffmpegPath: FFMPEG,
          run: (o) =>
            mode !== "real" && o.args.includes("packet=pts,duration:stream=time_base")
              ? Promise.resolve({
                  code: mode === "fail" ? 1 : 0,
                  signal: null,
                  stdout: "",
                  stderr: mode === "fail" ? "scan failed" : "",
                  killed: null,
                })
              : runIsolated(o),
        }),
    });
    for (const m of ["fail", "empty"] as const) {
      mode = m;
      const s = await t.scopeOf();
      const f = await t.putFile(s, inputs().noel, "mp4");
      const id = await t.queue(s, { clips: [{ fileId: f }] });
      await t.drive();
      expect([m, t.job(id)]).toMatchObject([m, { status: "failed", errorCode: "compose_failed" }]);
      // No result kept: only the input's place.
      expect([m, t.app.files!.placesTaken(s.conversationId)]).toEqual([m, 1]);
    }
    // The slot was freed: the next job runs to the end.
    mode = "real";
    const s3 = await t.scopeOf();
    const f3 = await t.putFile(s3, inputs().noel, "mp4");
    const id3 = await t.queue(s3, { clips: [{ fileId: f3 }] });
    await t.drive();
    expect(t.job(id3).status).toBe("done");
  });

  it("readiness: a tiny composition checked in the same sandbox", async () => {
    const dataDir = path.join(tmp(), "data");
    fs.mkdirSync(dataDir, { recursive: true });
    expect(await sandboxedComposer({ dataDir, ffmpegPath: FFMPEG })!.ready()).toBe(true);
    expect(fs.readdirSync(storagePaths(dataDir).composeScratch)).toEqual([]);
  });
});
