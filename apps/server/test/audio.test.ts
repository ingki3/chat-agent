import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUDIO_CODES,
  AUDIO_EXTERNAL_NOTICE,
  AUDIO_FALLBACK_MODEL,
  AUDIO_LIMITS,
  CSRF_HEADER,
  type MessagePart,
  type Run,
  type UploadedFile,
} from "@agentlee/shared";
import { AUDIO_TRANSCRIBE_TOOL } from "@agentlee/mcp-tools/audio";
import { SKILL_CATALOGUE, SKILL_SECRET_NAMES } from "@agentlee/mcp-tools/skills";
import { buildApp } from "../src/app.js";
import { capSpeakers, clock, mergeTranscript, transcriptMarkdown } from "../src/audio/merge.js";
import { OPENROUTER_TRANSCRIBE_URL, openRouterClient, requestTexts } from "../src/audio/openrouter.js";
import {
  AUDIO_DIR,
  AUDIO_LOCK,
  audioState,
  ffmpegOf,
  installAudioModels,
  modelFileUrl,
  modelManifest,
  modelsDir,
  type AudioEnv,
  type AudioState,
} from "../src/audio/packages.js";
import {
  chunkOptions,
  convertOptions,
  modelsEnvVars,
  modelsOptions,
  modelsReport,
  sandboxedAudioRunner,
  wavSeconds,
  workFolders,
  type AudioRunner,
  type Segment,
  type SpeakerTurn,
} from "../src/audio/runner.js";
import { AudioFallbackSwitch, AudioTranscriber, makeAudioWorkdir } from "../src/audio/service.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { buildProfile } from "../src/isolation/sandbox.js";
import { AUDIO_CODE_VALUES } from "../src/observability/policy.js";
import { codexRunConfig } from "../src/runtime/lockdown.js";
import { RuntimeRegistry } from "../src/runtime/adapter.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import { knownSecrets } from "../src/secrets/known.js";
import { pythonRuntime } from "../src/mcp/python.js";
import { createFamily } from "./helpers/permission-matrix.js";

vi.setConfig({ testTimeout: 60_000 });

/**
 * `audio_transcribe` (#173): the tool, its scope and file rules, the merge of speaker turns and words, the stored
 * transcript, the OpenRouter fallback (off unless switched on, a mock — never the network, a synthetic key), the
 * sandbox profiles, and — on macOS with ffmpeg — the real conversion in its sandbox. The real models run only in
 * the `AUDIO_LIVE=1` manual test at the end.
 */

type App = Awaited<ReturnType<typeof buildApp>>;
const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const LOCAL = { host: "localhost:3000" };
const WRITE = { ...LOCAL, origin: "http://localhost:3000", [CSRF_HEADER]: "1" };

function tmp(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-audio-")));
  closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function logCapture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const l of String(chunk).split("\n").filter(Boolean)) lines.push(JSON.parse(l));
      cb();
    },
  });
  return { lines, stream };
}

/** Programs that are never started (scripted runners only). */
const FAKE_ENV: AudioEnv = {
  runtime: { exe: "/opt/py/bin/python3.12", root: "/opt/py" },
  packages: "/data/audio-packages/p",
  models: { stt: "/data/audio-models/m/stt", diarizer: "/data/audio-models/m/diarizer" },
  ffmpeg: {
    exe: "/opt/homebrew/Cellar/ffmpeg/8/bin/ffmpeg",
    trusted: ["/opt/homebrew/Cellar", "/opt/homebrew/opt"],
  },
};
const AVAILABLE: () => AudioState = () => ({ state: "available", env: FAKE_ENV });

/** A minimal M4A: an ISO base media header (`ftyp M4A `) — enough for the upload check; ffmpeg is scripted. */
const M4A = Buffer.concat([
  Buffer.from([0, 0, 0, 0x18]),
  Buffer.from("ftypM4A ", "latin1"),
  Buffer.alloc(512, 0),
]);

/** Host and guest talking in turns; Whisper's words with their own times. */
const TURNS: SpeakerTurn[] = [
  { speaker: 3, start: 0, end: 5.2 },
  { speaker: 0, start: 5.4, end: 12.7 },
  { speaker: 3, start: 13.3, end: 16 },
];
const WORDS: Segment[] = [
  { start: 0, end: 4.9, text: "안녕하세요. 저는 사회자 유나입니다." },
  { start: 5.4, end: 12.5, text: "네, 반갑습니다. 저는 기상 전문가입니다." },
  { start: 13.3, end: 16, text: "그렇군요. 우산을 챙겨야겠네요." },
];

type Calls = { convert: number; diarize: number; transcribe: number; chunks: number; inputs: string[] };

/** A scripted runner: fake ffmpeg, fake diarizer, fake STT. */
function scripted(
  o: {
    seconds?: number;
    turns?: SpeakerTurn[] | "fail";
    words?: Segment[] | "fail" | "timeout";
    convert?: "decode_failed";
    chunkCount?: number;
    block?: Promise<void>;
  } = {},
) {
  const calls: Calls = { convert: 0, diarize: 0, transcribe: 0, chunks: 0, inputs: [] };
  const runner: AudioRunner = {
    async convert(job) {
      calls.convert++;
      calls.inputs.push(fs.readFileSync(job.input).subarray(4, 8).toString("latin1"));
      if (o.block) await o.block;
      if (o.convert) return { ok: false, code: "audio_decode_failed" };
      const out = workFolders(job.workdir).out;
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, "audio.wav"), "x");
      return { ok: true, wav: path.join(out, "audio.wav"), seconds: o.seconds ?? 16 };
    },
    async diarize() {
      calls.diarize++;
      return o.turns === "fail" ? { ok: false, code: "audio_failed" } : { ok: true, turns: o.turns ?? TURNS };
    },
    async transcribe() {
      calls.transcribe++;
      if (o.words === "fail") return { ok: false, code: "audio_failed" };
      if (o.words === "timeout") return { ok: false, code: "audio_timeout" };
      return { ok: true, segments: o.words ?? WORDS };
    },
    async chunks(job) {
      calls.chunks++;
      const dir = workFolders(job.workdir).chunks;
      fs.mkdirSync(dir, { recursive: true });
      const n = o.chunkCount ?? 2;
      return {
        ok: true,
        chunks: Array.from({ length: n }, (_, i) => {
          const file = path.join(dir, `chunk-00${i}.mp3`);
          fs.writeFileSync(file, `mp3-${i}`);
          return { file, start: i * AUDIO_LIMITS.fallbackChunkSeconds };
        }),
      };
    },
  };
  return { runner, calls };
}

async function start(
  o: {
    runner?: AudioRunner;
    state?: () => AudioState;
    fallback?: Parameters<typeof openRouterClient>[0]["fetchImpl"] | "none";
  } = {},
) {
  const dataDir = path.join(tmp(), "data");
  const log = logCapture();
  const registry = new RuntimeRegistry();
  registry.register(new FakeRuntime({ runTools: true }));
  const db = createTestDb();
  const s = o.runner ? { runner: o.runner, calls: undefined } : scripted();
  const app = await buildApp(
    loadConfig({ NODE_ENV: "test", DATA_DIR: dataDir, MASTER_KEY_PATH: path.join(tmp(), "master.key") }),
    {
      db,
      runtimes: registry,
      runs: { flushMs: 0 },
      logStream: log.stream,
      audio: {
        runner: s.runner,
        state: o.state ?? AVAILABLE,
        ...(o.fallback && o.fallback !== "none"
          ? { fallback: openRouterClient({ apiKey: SYNTHETIC_KEY, fetchImpl: o.fallback }) }
          : {}),
      },
    },
  );
  closers.push(() => app.close());
  const f = await createFamily(app);
  const api = (cookie: string, method: "POST" | "GET" | "PUT", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { ...WRITE, cookie, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  const send = async (
    cookie: string,
    conversationId: string,
    text: string,
    extra: Record<string, unknown> = {},
  ) => {
    const res = await api(cookie, "POST", `/api/conversations/${conversationId}/messages`, {
      text,
      ...extra,
    });
    expect(res.statusCode, res.body).toBe(201);
    return waitRun(app, (res.json() as { run: Run }).run.id);
  };
  const upload = async (cookie: string, conversationId: string, name: string, body: Buffer | string) => {
    const r = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/files`,
      headers: {
        ...WRITE,
        cookie,
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(name),
        "x-upload-id": crypto.randomUUID(),
      },
      payload: Buffer.from(body),
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json<UploadedFile>();
  };
  /** An audio file sent with a message (so a run may use it). */
  const sentFile = async (cookie: string, conversationId: string, name = "회의.m4a", body: Buffer = M4A) => {
    const file = await upload(cookie, conversationId, name, body);
    await send(cookie, conversationId, "녹음 보냄", { fileIds: [file.id] });
    return file;
  };
  const scopeOf = async (conversationId: string, userId = f.users.owner.id, cookie = f.cookies.owner) => {
    const r = await send(cookie, conversationId, "안녕");
    return { userId, conversationId, runId: r.run.id };
  };
  const svc = (
    runner: AudioRunner,
    opts: { client?: Parameters<typeof openRouterClient>[0]["fetchImpl"]; on?: boolean } = {},
  ) => {
    const sw = new AudioFallbackSwitch(memorySettings());
    if (opts.on) sw.set(true);
    return new AudioTranscriber({
      db,
      dataDir,
      files: () => app.files,
      runner,
      state: AVAILABLE,
      fallback: {
        switch: sw,
        client: opts.client ? openRouterClient({ apiKey: SYNTHETIC_KEY, fetchImpl: opts.client }) : undefined,
      },
    });
  };
  return { app, db, f, api, send, upload, sentFile, scopeOf, svc, calls: s.calls, log: log.lines, dataDir };
}

function memorySettings() {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k), set: (k: string, v: string) => void m.set(k, v) };
}

async function waitRun(app: App, id: string) {
  for (let i = 0; i < 2000; i++) {
    const r = app.runs!.get(id)!;
    if (r.endedAt !== null) {
      const parts = app.conversations!.messageById(r.assistantMessageId)!.parts as MessagePart[];
      const results = parts.flatMap((p) => (p.type === "tool_result" ? [p] : []));
      return { run: r, parts, results };
    }
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error("run did not end");
}

/** The JSON array inside the `<external_content>` block of `segments`. */
const segmentsOf = (out: unknown) =>
  JSON.parse(
    String((out as { segments: string }).segments)
      .replace(/^<external_content source="[^"]*">\n/, "")
      .replace(/\n<\/external_content>$/, ""),
  ) as { speaker: string | null; start: number; end: number; text: string }[];

/** A synthetic OpenRouter key (never a real one); registered like the server registers `.env` secrets. */
const SYNTHETIC_KEY = "sk-or-v1-SYNTHETIC0000test0000key0000173";
knownSecrets.add(SYNTHETIC_KEY);

/** A mock of OpenRouter's transcription endpoint: records every request, answers verbose_json per piece. */
function mockOpenRouter(answer: (i: number) => Response | Promise<Response> = (i) => verbose(i)) {
  const requests: { url: string; init: RequestInit; form: FormData }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init!, form: init!.body as FormData });
    return answer(requests.length - 1);
  }) as typeof fetch;
  return { fetchImpl, requests };
}
const verbose = (i: number) =>
  Response.json({
    text: `조각 ${i}`,
    segments: [
      { id: 0, start: 1, end: 4, text: ` 조각 ${i} 첫 문장` },
      { id: 1, start: 5, end: 9, text: ` 조각 ${i} 둘째 문장` },
    ],
  });

// ---- the tool and its place in the catalogue ---------------------------------------------------------------

describe("audio_transcribe: the tool (#173)", () => {
  it("is the audio-transcription skill's server tool: strict input, fixed codes, the key's env name", () => {
    expect(SKILL_CATALOGUE.find((e) => e.name === "audio-transcription")).toMatchObject({
      status: "tools",
      finance: false,
      issue: "#173",
      secrets: ["OPENROUTER_API_KEY"],
    });
    expect(SKILL_SECRET_NAMES).toContain("OPENROUTER_API_KEY");
    expect(Object.keys(AUDIO_TRANSCRIBE_TOOL.input).sort()).toEqual([
      "diarize",
      "fileId",
      "language",
      "maxSpeakers",
      "threshold",
    ]);
    for (const c of AUDIO_CODES) expect(AUDIO_CODE_VALUES.has(c), c).toBe(true);
    // The tool tells the model to say so when the words were transcribed outside.
    expect(AUDIO_TRANSCRIBE_TOOL.description).toContain(AUDIO_EXTERNAL_NOTICE);
  });

  it("offered with 'all' (a youth account too — not a finance skill), not without the permission or when off", async () => {
    const t = await start();
    const { app, f, api } = t;
    expect(app.mcp!.toolNamesFor(f.users.owner.id)).toContain("audio_transcribe");
    const son = app.users!.create({
      email: "son@matrix.test",
      name: "아들",
      role: "member",
      passwordHash: "x",
      youth: true,
    });
    expect(app.mcp!.toolNamesFor(son.id)).toContain("audio_transcribe");
    const set = await api(f.cookies.admin, "PUT", `/api/admin/users/${f.users.stranger.id}/skills`, {
      skills: ["python-scratchpad"],
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(app.mcp!.toolNamesFor(f.users.stranger.id)).not.toContain("audio_transcribe");
    // The server switch (#35) takes it from everyone.
    const off = await api(f.cookies.admin, "PUT", "/api/admin/skills/audio-transcription", {
      enabled: false,
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(app.mcp!.toolNamesFor(f.users.owner.id)).not.toContain("audio_transcribe");
    const skills = off.json<{ skills: { name: string; status: string; enabled: boolean }[] }>().skills;
    expect(skills.find((s) => s.name === "audio-transcription")).toMatchObject({
      status: "available",
      enabled: false,
    });
  });

  it("not offered until installed; the admin sees why; tests never read the real install", async () => {
    for (const st of ["not_installed", "needs_python", "needs_ffmpeg", "unavailable"] as const) {
      const t = await start({ state: () => ({ state: st, reason: "x" }) });
      expect(t.app.mcp!.toolNamesFor(t.f.users.owner.id)).not.toContain("audio_transcribe");
      const skills = (await t.api(t.f.cookies.admin, "GET", "/api/admin/skills")).json<{
        skills: { name: string; status: string }[];
      }>().skills;
      expect(skills.find((s) => s.name === "audio-transcription")?.status).toBe(st);
    }
    // The state from the configuration: not macOS; no python; no ffmpeg; nothing installed in a fresh DATA_DIR.
    const data = tmp();
    expect(audioState(undefined, data, undefined, "linux").state).toBe("unavailable");
    expect(audioState(undefined, data, undefined, "darwin").state).toBe("needs_python");
    const py = pythonRuntime(process.env.TEST_SKILL_PYTHON ?? findPython());
    if (py.ok) {
      expect(audioState(py.runtime.exe, data, "/nope/ffmpeg", "darwin").state).toBe("needs_ffmpeg");
      if (fs.existsSync("/opt/homebrew/bin/ffmpeg"))
        expect(audioState(py.runtime.exe, data, undefined, "darwin")).toMatchObject({
          state: "not_installed",
        });
    }
  });
});

// ---- a call ------------------------------------------------------------------------------------------------

describe("audio_transcribe: a call (#173)", () => {
  it("an attached m4a → speaker-labelled segments, the transcript stored as a markdown file of the reply", async () => {
    const s = scripted();
    const t = await start({ runner: s.runner });
    const c = t.app.conversations!.create(t.f.users.owner.id);
    const file = await t.sentFile(t.f.cookies.owner, c.id);
    const r = await t.send(t.f.cookies.owner, c.id, `/audio ${file.id}`);
    const res = r.results[0]!;
    expect(res.isError, JSON.stringify(res.output)).not.toBe(true);
    const out = res.output as Record<string, unknown>;
    expect(out).toMatchObject({
      status: "ok",
      stt: "local",
      externalTranscription: false,
      diarization: "local",
      language: "ko",
      durationSeconds: 16,
      speakers: 2,
      segmentCount: 3,
      segmentsTruncated: false,
    });
    expect(out.notice).toBeUndefined();
    expect(String(out.segments)).toMatch(/^<external_content source="audio_transcribe">/);
    // Renamed by first appearance: the diarizer's raw channel numbers (3, 0) never show.
    expect(segmentsOf(out).map((x) => x.speaker)).toEqual(["speaker_1", "speaker_2", "speaker_1"]);
    expect(segmentsOf(out)[1]).toEqual({ speaker: "speaker_2", start: 5.4, end: 12.5, text: WORDS[1]!.text });
    // The input copy was the uploaded file itself (checked against its hash on the way).
    expect(s.calls.inputs).toEqual(["ftyp"]);
    const tf = out.transcriptFile as { fileId: string; name: string; url: string };
    expect(tf.name).toBe("회의-대본.md");
    const row = t.app.files!.get(tf.fileId)!;
    expect(row).toMatchObject({ kind: "md", conversationId: c.id, messageId: r.run.assistantMessageId });
    const md = (await t.app.inject({ url: tf.url, headers: { ...LOCAL, cookie: t.f.cookies.owner } })).body;
    expect(md).toContain("# 회의 — 대본");
    expect(md).toContain("**[00:00:05] speaker_2:** 네, 반갑습니다.");
    expect(md).not.toContain("외부 전사");
    // The working folder is gone.
    expect(fs.readdirSync(path.join(t.dataDir, "audio-scratch"))).toEqual([]);
    // The log: fixed values only — never the file id, its name or a word.
    const line = t.log.find((l) => l.msg === "audio.finished")!;
    expect(line).toMatchObject({ audioCode: "audio_ok", audioStt: "local", audioDiarization: "local" });
    // (The upload's own extraction line has its file id, as every upload's does — #48; not this tool's.)
    const all = JSON.stringify(t.log.filter((l) => l.msg === "audio.finished" || l.msg === "tool.finished"));
    for (const w of [file.id, "회의", "사회자", "반갑습니다", tf.fileId]) expect(all).not.toContain(w);
  });

  it("diarize: false → no speakers; a failed diarization keeps the words (diarization: failed)", async () => {
    const s = scripted();
    const t = await start({ runner: s.runner });
    const c = t.app.conversations!.create(t.f.users.owner.id);
    const file = await t.sentFile(t.f.cookies.owner, c.id);
    const scope = await t.scopeOf(c.id);
    const off = await t.svc(s.runner).run(scope, { fileId: file.id, diarize: false });
    expect(off.ok).toBe(true);
    const o1 = (off as { output: Record<string, unknown> }).output;
    expect(o1).toMatchObject({ diarization: "off", speakers: 0 });
    expect(segmentsOf(o1).every((x) => x.speaker === null)).toBe(true);
    expect(s.calls.diarize).toBe(0);
    const failing = scripted({ turns: "fail" });
    const r = await t.svc(failing.runner).run(scope, { fileId: file.id });
    expect((r as { output: Record<string, unknown> }).output).toMatchObject({
      diarization: "failed",
      speakers: 0,
    });
  });

  it("refuses other users' and conversations' files, unsent files, non-audio files, bad input — before anything runs", async () => {
    const s = scripted();
    const t = await start({ runner: s.runner });
    const mine = t.app.conversations!.create(t.f.users.owner.id);
    const other = t.app.conversations!.create(t.f.users.owner.id);
    const theirs = t.app.conversations!.create(t.f.users.stranger.id);
    const inOther = await t.sentFile(t.f.cookies.owner, other.id);
    const strangers = await t.sentFile(t.f.cookies.stranger, theirs.id);
    const unsent = await t.upload(t.f.cookies.owner, mine.id, "몰래.m4a", M4A);
    const text = await t.upload(t.f.cookies.owner, mine.id, "메모.txt", "그냥 메모\n");
    await t.send(t.f.cookies.owner, mine.id, "메모", { fileIds: [text.id] });
    const scope = await t.scopeOf(mine.id);
    const svc = t.svc(s.runner);
    for (const id of [inOther.id, strangers.id, unsent.id, "nope"])
      expect(await svc.run(scope, { fileId: id })).toEqual({ ok: false, code: "audio_file_not_found" });
    expect(await svc.run(scope, { fileId: text.id })).toEqual({ ok: false, code: "audio_unsupported_kind" });
    for (const bad of [
      {},
      { fileId: "" },
      { fileId: unsent.id, extra: 1 },
      { fileId: unsent.id, language: "korean" },
      { fileId: unsent.id, maxSpeakers: 9 },
      { fileId: unsent.id, threshold: 0.99 },
    ])
      expect(await svc.run(scope, bad), JSON.stringify(bad)).toEqual({ ok: false, code: "audio_bad_input" });
    // Another user's run scope on my conversation.
    expect(await svc.run({ ...scope, userId: t.f.users.stranger.id }, { fileId: unsent.id })).toEqual({
      ok: false,
      code: "audio_not_allowed",
    });
    expect(s.calls.convert).toBe(0);
    // Not installed: a fixed code, nothing runs.
    const notInstalled = new AudioTranscriber({
      db: t.db,
      dataDir: t.dataDir,
      files: () => t.app.files,
      runner: s.runner,
      state: () => ({ state: "not_installed", reason: "x" }),
      fallback: { switch: new AudioFallbackSwitch(memorySettings()) },
    });
    expect(await notInstalled.run(scope, { fileId: unsent.id })).toEqual({
      ok: false,
      code: "audio_not_installed",
    });
    expect(s.calls.convert).toBe(0);
  });

  it("too long, empty, undecodable: fixed codes; one transcription at a time (audio_busy)", async () => {
    const t = await start();
    const c = t.app.conversations!.create(t.f.users.owner.id);
    const file = await t.sentFile(t.f.cookies.owner, c.id);
    const scope = await t.scopeOf(c.id);
    const long = scripted({ seconds: AUDIO_LIMITS.maxSeconds + 1 });
    expect(await t.svc(long.runner).run(scope, { fileId: file.id })).toEqual({
      ok: false,
      code: "audio_too_long",
    });
    expect(long.calls.transcribe).toBe(0);
    expect(await t.svc(scripted({ seconds: 0 }).runner).run(scope, { fileId: file.id })).toEqual({
      ok: false,
      code: "audio_empty",
    });
    expect(
      await t.svc(scripted({ convert: "decode_failed" }).runner).run(scope, { fileId: file.id }),
    ).toEqual({
      ok: false,
      code: "audio_decode_failed",
    });
    let release!: () => void;
    const blocked = scripted({ block: new Promise<void>((r) => (release = r)) });
    const svc = t.svc(blocked.runner);
    const first = svc.run(scope, { fileId: file.id });
    const strangerConv = t.app.conversations!.create(t.f.users.stranger.id);
    const theirs = await t.sentFile(t.f.cookies.stranger, strangerConv.id);
    const theirScope = await t.scopeOf(strangerConv.id, t.f.users.stranger.id, t.f.cookies.stranger);
    expect(await svc.run(theirScope, { fileId: theirs.id })).toEqual({ ok: false, code: "audio_busy" });
    release();
    expect((await first).ok).toBe(true);
    expect((await svc.run(theirScope, { fileId: theirs.id })).ok).toBe(true);
    expect(fs.readdirSync(path.join(t.dataDir, "audio-scratch"))).toEqual([]);
  });

  it("known secrets are taken out of the words, the returned segments and the stored transcript", async () => {
    const secret = "zzSYNTHaudio173secretvalue";
    knownSecrets.add(secret);
    const s = scripted({ words: [{ start: 0, end: 3, text: `제 비밀번호는 ${secret} 입니다` }] });
    const t = await start({ runner: s.runner });
    const c = t.app.conversations!.create(t.f.users.owner.id);
    const file = await t.sentFile(t.f.cookies.owner, c.id);
    const scope = await t.scopeOf(c.id);
    const r = await t.svc(s.runner).run(scope, { fileId: file.id });
    expect(JSON.stringify(r)).not.toContain(secret);
    const tf = (r as { output: { transcriptFile: { fileId: string } } }).output.transcriptFile;
    const stored = fs.readFileSync(t.app.files!.pathOf(t.app.files!.get(tf.fileId)!), "utf8");
    expect(stored).not.toContain(secret);
    expect(stored).toContain("제 비밀번호는");
  });

  it("the sweep removes working folders left by an earlier process", async () => {
    const t = await start();
    const left = makeAudioWorkdir(t.dataDir);
    fs.writeFileSync(path.join(left, "in", "input.m4a"), "x");
    fs.chmodSync(path.join(left, "in"), 0o500);
    expect(t.svc(scripted().runner).sweep()).toBe(true);
    expect(fs.readdirSync(path.join(t.dataDir, "audio-scratch"))).toEqual([]);
  });
});

// ---- the fallback -------------------------------------------------------------------------------------------

describe("audio_transcribe: the OpenRouter fallback (#173)", () => {
  it("off by default: a local failure is audio_failed / audio_timeout and nothing is sent", async () => {
    const or = mockOpenRouter();
    const t = await start();
    const c = t.app.conversations!.create(t.f.users.owner.id);
    const file = await t.sentFile(t.f.cookies.owner, c.id);
    const scope = await t.scopeOf(c.id);
    const failing = scripted({ words: "fail" });
    // A key but the switch off; the switch on but no key.
    expect(await t.svc(failing.runner, { client: or.fetchImpl }).run(scope, { fileId: file.id })).toEqual({
      ok: false,
      code: "audio_failed",
    });
    expect(await t.svc(failing.runner, { on: true }).run(scope, { fileId: file.id })).toEqual({
      ok: false,
      code: "audio_failed",
    });
    expect(
      await t
        .svc(scripted({ words: "timeout" }).runner, { client: or.fetchImpl })
        .run(scope, { fileId: file.id }),
    ).toEqual({ ok: false, code: "audio_timeout" });
    expect(or.requests).toHaveLength(0);
    expect(failing.calls.chunks).toBe(0);
  });

  it("on, with a key: only after the local Whisper failed — MP3 pieces, times shifted, local speakers, marked external", async () => {
    const or = mockOpenRouter();
    const t = await start();
    const c = t.app.conversations!.create(t.f.users.owner.id);
    const file = await t.sentFile(t.f.cookies.owner, c.id);
    const scope = await t.scopeOf(c.id);
    // Local success with the fallback on: nothing is sent.
    const ok = scripted();
    expect(
      (await t.svc(ok.runner, { client: or.fetchImpl, on: true }).run(scope, { fileId: file.id })).ok,
    ).toBe(true);
    expect(or.requests).toHaveLength(0);
    const turns: SpeakerTurn[] = [
      { speaker: 1, start: 0, end: 300 },
      { speaker: 0, start: 600, end: 900 },
    ];
    const failing = scripted({ words: "fail", turns, chunkCount: 2, seconds: 900 });
    const r = await t
      .svc(failing.runner, { client: or.fetchImpl, on: true })
      .run(scope, { fileId: file.id, language: "en" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const out = (r as { output: Record<string, unknown> }).output;
    expect(out).toMatchObject({
      stt: "openrouter",
      externalTranscription: true,
      notice: AUDIO_EXTERNAL_NOTICE,
      diarization: "local",
      language: "en",
    });
    const segs = segmentsOf(out);
    // Piece 1 starts at 600 s: its times are shifted; the speakers are the local diarizer's.
    expect(segs.map((x) => [x.speaker, x.start])).toEqual([
      ["speaker_1", 1],
      ["speaker_2", 601],
    ]);
    expect(segs[0]!.text).toBe("조각 0 첫 문장 조각 0 둘째 문장");
    expect(or.requests).toHaveLength(2);
    const md = fs.readFileSync(
      t.app.files!.pathOf(t.app.files!.get((out.transcriptFile as { fileId: string }).fileId)!),
      "utf8",
    );
    expect(md).toContain(AUDIO_EXTERNAL_NOTICE);
    // A failed piece fails the call (no partial transcript passed off as whole).
    const bad = mockOpenRouter((i) => (i === 1 ? new Response("{}", { status: 500 }) : verbose(i)));
    expect(
      await t
        .svc(scripted({ words: "fail" }).runner, { client: bad.fetchImpl, on: true })
        .run(scope, { fileId: file.id }),
    ).toEqual({ ok: false, code: "audio_fallback_failed" });
  });

  it("the request: fixed URL, no redirects, the key only in the Authorization header, a fixed form", async () => {
    const or = mockOpenRouter();
    const client = openRouterClient({ apiKey: SYNTHETIC_KEY, fetchImpl: or.fetchImpl });
    const audio = Buffer.from("ID3-fake-mp3-bytes");
    const r = await client({ data: audio, index: 7 }, { language: "ko" });
    expect(r).toEqual({
      ok: true,
      segments: [
        { start: 1, end: 4, text: " 조각 0 첫 문장" },
        { start: 5, end: 9, text: " 조각 0 둘째 문장" },
      ],
    });
    const req = or.requests[0]!;
    expect(req.url).toBe(OPENROUTER_TRANSCRIBE_URL);
    expect(req.url).toBe("https://openrouter.ai/api/v1/audio/transcriptions");
    expect(req.init.method).toBe("POST");
    expect(req.init.redirect).toBe("error");
    expect(req.init.headers).toEqual({ Authorization: `Bearer ${SYNTHETIC_KEY}` });
    const fields = [...req.form.entries()].map(([k, v]) => [
      k,
      typeof v === "string" ? v : `file:${(v as File).name}`,
    ]);
    expect(fields).toEqual([
      ["model", AUDIO_FALLBACK_MODEL],
      ["language", "ko"],
      ["response_format", "verbose_json"],
      ["temperature", "0"],
      ["file", "file:chunk-007.mp3"],
    ]);
    // The key is nowhere but the header: not in the URL, the fields, the file name or the audio.
    const body = Buffer.from(await new Response(req.form).arrayBuffer()).toString("latin1");
    expect(body).not.toContain(SYNTHETIC_KEY);
    expect(body).toContain("ID3-fake-mp3-bytes");
    expect(requestTexts("ko", "chunk-007.mp3").join(" ")).not.toContain(SYNTHETIC_KEY);
    // A language that is not a code, an over-large piece: refused before any request.
    expect(await client({ data: audio, index: 0 }, { language: "ko&x=1" })).toEqual({ ok: false });
    expect(
      await client({ data: Buffer.alloc(AUDIO_LIMITS.fallbackChunkBytes + 1), index: 0 }, { language: "ko" }),
    ).toEqual({
      ok: false,
    });
    expect(or.requests).toHaveLength(1);
    // Text only (no timestamps): one segment for the piece. Errors and bad JSON: a failure.
    const textOnly = openRouterClient({
      apiKey: SYNTHETIC_KEY,
      fetchImpl: (async () => Response.json({ text: " 전체 글 ", duration: 12 })) as typeof fetch,
    });
    expect(await textOnly({ data: audio, index: 0 }, { language: "ko" })).toEqual({
      ok: true,
      segments: [{ start: 0, end: 12, text: "전체 글" }],
    });
    for (const res of [
      new Response("nope", { status: 401 }),
      new Response("not json"),
      Response.json({ segments: "x" }),
    ]) {
      const c2 = openRouterClient({ apiKey: SYNTHETIC_KEY, fetchImpl: (async () => res) as typeof fetch });
      expect(await c2({ data: audio, index: 0 }, { language: "ko" })).toEqual({ ok: false });
    }
    const thrown = openRouterClient({
      apiKey: SYNTHETIC_KEY,
      fetchImpl: (async () => {
        throw new TypeError("redirect");
      }) as typeof fetch,
    });
    expect(await thrown({ data: audio, index: 0 }, { language: "ko" })).toEqual({ ok: false });
  });

  it("the admin switch: off by default, shows whether a key is set (never the key), applies at once", async () => {
    const or = mockOpenRouter();
    const t = await start({ fallback: or.fetchImpl });
    const get = await t.api(t.f.cookies.admin, "GET", "/api/admin/audio");
    expect(get.statusCode).toBe(200);
    expect(get.json()).toEqual({ fallback: false, keyConfigured: true });
    expect(get.body).not.toContain(SYNTHETIC_KEY);
    expect((await t.api(t.f.cookies.owner, "GET", "/api/admin/audio")).statusCode).toBe(403);
    expect((await t.api(t.f.cookies.owner, "PUT", "/api/admin/audio", { fallback: true })).statusCode).toBe(
      403,
    );
    expect((await t.api(t.f.cookies.admin, "PUT", "/api/admin/audio", { fallback: "yes" })).statusCode).toBe(
      400,
    );
    const on = await t.api(t.f.cookies.admin, "PUT", "/api/admin/audio", { fallback: true });
    expect(on.json()).toEqual({ fallback: true, keyConfigured: true });
    const noKey = await start();
    expect((await noKey.api(noKey.f.cookies.admin, "GET", "/api/admin/audio")).json()).toEqual({
      fallback: false,
      keyConfigured: false,
    });
  });
});

// ---- merge ----------------------------------------------------------------------------------------------------

describe("audio_transcribe: merging speaker turns and words (#173)", () => {
  it("each piece goes to the speaker it overlaps most; no overlap → the nearest turn; joined while the speaker stays", () => {
    const turns: SpeakerTurn[] = [
      { speaker: 5, start: 0, end: 10 },
      { speaker: 2, start: 10, end: 20 },
    ];
    const words: Segment[] = [
      { start: 0, end: 3, text: "가" },
      { start: 3.5, end: 6, text: "나" },
      // Mostly in speaker 2's turn.
      { start: 9, end: 14, text: "다" },
      // After every turn: nearest is speaker 2.
      { start: 25, end: 27, text: "라" },
      { start: 30, end: 31, text: "  " },
    ];
    const r = mergeTranscript(words, turns, { maxChars: 100 });
    expect(r.speakers).toBe(2);
    expect(r.segments).toEqual([
      { speaker: "speaker_1", start: 0, end: 6, text: "가 나" },
      { speaker: "speaker_2", start: 9, end: 14, text: "다" },
      { speaker: "speaker_2", start: 25, end: 27, text: "라" },
    ]);
    // Without diarization every speaker is null; join still happens; a long text is cut to maxChars.
    const plain = mergeTranscript([{ start: 0, end: 1, text: "가".repeat(10) }], undefined, { maxChars: 4 });
    expect(plain).toEqual({ speakers: 0, segments: [{ speaker: null, start: 0, end: 1, text: "가가가가" }] });
  });

  it("maxSpeakers folds the rarest voices into the nearest kept speaker", () => {
    const turns: SpeakerTurn[] = [
      { speaker: 0, start: 0, end: 30 },
      { speaker: 1, start: 30, end: 60 },
      // A short laugh channel next to speaker 1.
      { speaker: 2, start: 61, end: 62 },
      { speaker: 0, start: 100, end: 130 },
    ];
    expect(capSpeakers(turns, 2).map((t) => t.speaker)).toEqual([0, 1, 1, 0]);
    expect(capSpeakers(turns, 3)).toEqual(turns);
    const r = mergeTranscript([{ start: 61, end: 62, text: "하하" }], turns, {
      maxSpeakers: 2,
      maxChars: 100,
    });
    expect(r.segments[0]!.speaker).toBe("speaker_1");
  });

  it("the markdown transcript and the clock", () => {
    expect(clock(3725.9)).toBe("01:02:05");
    const md = transcriptMarkdown(
      "회의\n제목",
      [{ speaker: "speaker_1", start: 65, end: 70, text: "줄\n바꿈" }],
      { durationSeconds: 70, speakers: 1, external: true, notice: AUDIO_EXTERNAL_NOTICE },
    );
    expect(md).toBe(
      [
        "# 회의 제목 — 대본",
        "",
        "- 길이: 00:01:10",
        "- 화자: 1명 (자동 구분 — 이름은 추정)",
        `- ${AUDIO_EXTERNAL_NOTICE}`,
        "",
        "**[00:01:05] speaker_1:** 줄 바꿈",
        "",
      ].join("\n"),
    );
  });
});

// ---- programs, profiles and the install ---------------------------------------------------------------------

describe("audio_transcribe: sandbox profiles and the install (#173)", () => {
  const work = "/data/audio-scratch/11111111-1111-4111-8111-111111111111";

  it("ffmpeg reads only the input folder, writes only out/; no network, no flags, its program folders", () => {
    const o = convertOptions({ env: FAKE_ENV, workdir: work, input: `${work}/in/input.m4a` });
    expect(o.command).toBe(FAKE_ENV.ffmpeg.exe);
    expect(o.read).toEqual([`${work}/in`]);
    expect(o.write).toEqual([`${work}/out`]);
    expect(o.trusted).toEqual(FAKE_ENV.ffmpeg.trusted);
    expect(o.network).toBe("none");
    expect(o.noFlagChanges).toBe(true);
    expect(o.gpu).toBeUndefined();
    expect(o.env).toEqual({ HOME: `${work}/out`, LANG: "en_US.UTF-8" });
    // First audio track only, 16 kHz mono PCM, capped at the longest recording + 1 s.
    expect(o.args.join(" ")).toContain(
      `-map 0:a:0 -vn -sn -dn -ac 1 -ar 16000 -c:a pcm_s16le -t ${AUDIO_LIMITS.maxSeconds + 1}`,
    );
    const ch = chunkOptions({ env: FAKE_ENV, workdir: work, wav: `${work}/out/audio.wav` });
    expect(ch.read).toEqual([`${work}/out`]);
    expect(ch.write).toEqual([`${work}/chunks`]);
    expect(ch.args.join(" ")).toContain(
      `-b:a 64k -f segment -segment_time ${AUDIO_LIMITS.fallbackChunkSeconds}`,
    );
  });

  it("python reads only the WAV folder and its program folders, writes only py/, Metal only, offline, no secret", () => {
    const job = {
      env: FAKE_ENV,
      workdir: work,
      wav: `${work}/out/audio.wav`,
      language: "ko",
      threshold: 0.85,
    };
    const o = modelsOptions(job, "diarize");
    expect(o.args).toEqual(["-I", "-S", "-B", path.join(AUDIO_DIR, "transcribe.py")]);
    expect(o.read).toEqual([`${work}/out`]);
    expect(o.write).toEqual([`${work}/py`]);
    expect(o.trusted).toEqual([
      "/opt/py",
      AUDIO_DIR,
      FAKE_ENV.packages,
      FAKE_ENV.models.stt,
      FAKE_ENV.models.diarizer,
    ]);
    expect(o.network).toBe("none");
    expect(o.gpu).toBe(true);
    expect(o.env).toEqual(modelsEnvVars(work));
    expect(o.env).toMatchObject({ HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1", HOME: `${work}/py` });
    expect(Object.keys(o.env).sort()).toEqual(
      [
        "HF_HOME",
        "HF_HUB_DISABLE_TELEMETRY",
        "HF_HUB_OFFLINE",
        "HOME",
        "LANG",
        "LC_ALL",
        "TMPDIR",
        "TOKENIZERS_PARALLELISM",
        "TRANSFORMERS_OFFLINE",
      ].sort(),
    );
    expect(JSON.parse(o.stdin!)).toMatchObject({
      diarize: true,
      stt: false,
      threshold: 0.85,
      language: "ko",
    });
    expect(JSON.parse(modelsOptions(job, "transcribe").stdin!)).toMatchObject({ diarize: false, stt: true });
    expect(o.timeoutMs).toBe(AUDIO_LIMITS.transcribeTimeoutMs);
    expect(o.maxRssBytes).toBe(AUDIO_LIMITS.transcribeMemoryBytes);
  });

  it("gpu adds exactly the two IOKit user clients Metal needs — nothing without it", () => {
    const base = { command: "/bin/echo", read: [], write: [] };
    const without = buildProfile(base);
    const withGpu = buildProfile({ ...base, gpu: true });
    expect(without).not.toContain("iokit");
    expect(withGpu.split("\n").filter((l) => l.includes("iokit"))).toEqual([
      '(allow iokit-open (iokit-user-client-class "AGXDeviceUserClient") (iokit-user-client-class "IOSurfaceRootUserClient"))',
    ]);
    expect(withGpu).not.toContain("network");
    expect(withGpu).not.toContain("mach-lookup");
  });

  it("the python report: stages, limits, garbage", () => {
    const res = (o: object) =>
      ({ code: 0, signal: null, stdout: "", stderr: "", killed: null, ...o }) as never;
    expect(modelsReport(res({ killed: "timeout" }))).toBe("audio_timeout");
    expect(modelsReport(res({ killed: "memory" }))).toBe("audio_memory_limit");
    expect(modelsReport(res({ code: 1 }))).toBe("audio_failed");
    expect(modelsReport(res({ stdout: "nope" }))).toBe("audio_failed");
    expect(
      modelsReport(
        res({ stdout: JSON.stringify({ diarization: null, stt: { ok: false, error: "MemoryError" } }) }),
      ),
    ).toEqual({ diarization: null, stt: { ok: false, error: "MemoryError" } });
  });

  it("the WAV length comes from its data chunk (LIST before it), and only from 16 kHz mono 16-bit", () => {
    const dir = tmp();
    const wav = (rate: number, channels: number, dataBytes: number, list = false) => {
      const fmt = Buffer.alloc(24);
      fmt.write("fmt ", 0, "latin1");
      fmt.writeUInt32LE(16, 4);
      fmt.writeUInt16LE(1, 8);
      fmt.writeUInt16LE(channels, 10);
      fmt.writeUInt32LE(rate, 12);
      fmt.writeUInt32LE(rate * 2 * channels, 16);
      fmt.writeUInt16LE(2 * channels, 20);
      fmt.writeUInt16LE(16, 22);
      const l = list
        ? Buffer.concat([Buffer.from("LIST", "latin1"), Buffer.from([4, 0, 0, 0]), Buffer.from("INFO")])
        : Buffer.alloc(0);
      const dh = Buffer.alloc(8);
      dh.write("data", 0, "latin1");
      dh.writeUInt32LE(dataBytes, 4);
      const body = Buffer.concat([Buffer.from("WAVE", "latin1"), fmt, l, dh, Buffer.alloc(dataBytes)]);
      const riff = Buffer.alloc(8);
      riff.write("RIFF", 0, "latin1");
      riff.writeUInt32LE(body.length, 4);
      const p = path.join(dir, crypto.randomUUID());
      fs.writeFileSync(p, Buffer.concat([riff, body]));
      return p;
    };
    expect(wavSeconds(wav(16000, 1, 64000))).toBe(2);
    expect(wavSeconds(wav(16000, 1, 32000, true))).toBe(1);
    expect(wavSeconds(wav(44100, 1, 32000))).toBeUndefined();
    expect(wavSeconds(wav(16000, 2, 32000))).toBeUndefined();
    const junk = path.join(dir, "junk");
    fs.writeFileSync(junk, "not a wav at all");
    expect(wavSeconds(junk)).toBeUndefined();
  });

  it("the lock pins every package with hashes; the models are pinned to a commit with sizes and SHA-256", () => {
    const lock = fs.readFileSync(AUDIO_LOCK, "utf8");
    const pins = lock.split("\n").filter((l) => /^[a-z0-9]/i.test(l));
    expect(pins.length).toBeGreaterThan(10);
    for (const p of pins) expect(p, p).toMatch(/^[a-z0-9._-]+==[0-9][^ ]* \\$/i);
    expect(lock).toContain("mlx-audio==0.6.4");
    expect(lock).toContain("--exclude-newer 2026-11-03");
    expect((lock.match(/--hash=sha256:[0-9a-f]{64}/g) ?? []).length).toBeGreaterThanOrEqual(pins.length);
    const m = modelManifest();
    expect(m.models.map((x) => x.key).sort()).toEqual(["diarizer", "stt"]);
    expect(m.models.find((x) => x.key === "diarizer")!.repo).toBe("mlx-community/Nemotron-3-Diarization");
    for (const x of m.models)
      expect(
        x.files.some((f) => f.name.endsWith(".safetensors")),
        x.repo,
      ).toBe(true);
  });

  it("the model install checks every file's size and hash; a mismatch installs nothing", async () => {
    const data = tmp();
    const blob = Buffer.from("weights");
    const manifest = {
      models: [
        {
          key: "stt" as const,
          repo: "a/b",
          revision: "0".repeat(40),
          files: [
            {
              name: "w.safetensors",
              bytes: blob.length,
              sha256: crypto.createHash("sha256").update(blob).digest("hex"),
            },
          ],
        },
        {
          key: "diarizer" as const,
          repo: "c/d",
          revision: "1".repeat(40),
          files: [
            { name: "config.json", bytes: 2, sha256: crypto.createHash("sha256").update("{}").digest("hex") },
          ],
        },
      ],
    };
    const urls: string[] = [];
    const serve = (bodies: Record<string, Buffer | string>) =>
      (async (u: string | URL | Request) => {
        urls.push(String(u));
        const name = String(u).split("/").pop()!;
        return new Response(bodies[name] as BodyInit);
      }) as typeof fetch;
    await expect(
      installAudioModels(data, {
        manifest,
        fetchImpl: serve({ "w.safetensors": "weightz", "config.json": "{}" }),
      }),
    ).rejects.toThrow(/differs/);
    expect(fs.readdirSync(path.join(data, "audio-models"))).toEqual([]);
    const dir = await installAudioModels(data, {
      manifest,
      fetchImpl: serve({ "w.safetensors": blob, "config.json": "{}" }),
    });
    expect(dir).toBe(modelsDir(data));
    expect(fs.readFileSync(path.join(dir, "stt", "w.safetensors"), "utf8")).toBe("weights");
    expect(fs.statSync(path.join(dir, "stt", "w.safetensors")).mode & 0o222).toBe(0);
    expect(urls).toContain(modelFileUrl("a/b", "0".repeat(40), "w.safetensors"));
    expect(urls[0]).toMatch(/^https:\/\/huggingface\.co\/a\/b\/resolve\/0{40}\/w\.safetensors$/);
    fs.chmodSync(dir, 0o755);
    for (const k of ["stt", "diarizer"]) fs.chmodSync(path.join(dir, k), 0o755);
  });

  it("ffmpeg's program folders: Homebrew's Cellar and opt; refuses a relative path and a folder holding DATA_DIR", () => {
    expect(ffmpegOf("ffmpeg", "/data")).toMatchObject({ ok: false });
    expect(ffmpegOf("/nope/ffmpeg", "/data")).toMatchObject({ ok: false });
    const dir = tmp();
    const exe = path.join(dir, "bin", "ffmpeg");
    fs.mkdirSync(path.dirname(exe));
    fs.writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });
    expect(ffmpegOf(exe, path.join(dir, "bin", "data"))).toEqual({
      ok: false,
      reason: "ffmpeg's folder is too broad",
    });
    expect(ffmpegOf(exe, path.join(dir, "data"))).toEqual({
      ok: true,
      ffmpeg: { exe, trusted: [path.dirname(exe)] },
    });
    if (fs.existsSync("/opt/homebrew/bin/ffmpeg")) {
      const r = ffmpegOf(undefined, "/data");
      expect(r).toMatchObject({
        ok: true,
        ffmpeg: { trusted: ["/opt/homebrew/Cellar", "/opt/homebrew/opt"] },
      });
    }
  });

  it("Codex gets a longer MCP tool timeout only when the run has audio_transcribe", () => {
    const mcp = { url: "http://127.0.0.1:45678/mcp", token: "t" };
    const without = codexRunConfig({ model: "m", mcp, tools: ["echo_time"] }).join("\n");
    const withAudio = codexRunConfig({ model: "m", mcp, tools: ["echo_time", "audio_transcribe"] }).join(
      "\n",
    );
    expect(without).not.toContain("tool_timeout_sec");
    expect(withAudio).toContain(
      `required = true, tool_timeout_sec = ${AUDIO_LIMITS.callTimeoutMs / 1000 + 60} }`,
    );
  });
});

// ---- the real ffmpeg in its sandbox (macOS with ffmpeg) -------------------------------------------------------

function findPython(): string | undefined {
  const r = spawnSync("uv", ["python", "find", "3.12"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : undefined;
}

const realFfmpeg =
  process.platform === "darwin" ? ffmpegOf(process.env.TEST_AUDIO_FFMPEG, "/nonexistent-data") : undefined;
const ffmpegIt = realFfmpeg?.ok ? it : it.skip;

/** A 16-bit PCM WAV tone (44.1 kHz stereo — so the conversion has work to do). */
function toneWav(seconds: number): Buffer {
  const rate = 44100;
  const n = seconds * rate;
  const data = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 3000);
    data.writeInt16LE(v, i * 4);
    data.writeInt16LE(v, i * 4 + 2);
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "latin1");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8, "latin1");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "latin1");
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

describe("audio_transcribe: the real ffmpeg in its sandbox (macOS, #173)", () => {
  ffmpegIt(
    "converts to 16 kHz mono WAV and cuts MP3 pieces; cannot read outside in/; garbage is audio_decode_failed",
    async () => {
      const env: AudioEnv = { ...FAKE_ENV, ffmpeg: (realFfmpeg as { ffmpeg: AudioEnv["ffmpeg"] }).ffmpeg };
      const data = tmp();
      const runner = sandboxedAudioRunner();
      const workdir = makeAudioWorkdir(data);
      const input = path.join(workdir, "in", "input.wav");
      fs.writeFileSync(input, toneWav(3));
      const c = await runner.convert({ env, workdir, input });
      expect(c).toMatchObject({ ok: true });
      expect((c as { seconds: number }).seconds).toBeCloseTo(3, 1);
      const ch = await runner.chunks({ env, workdir, wav: (c as { wav: string }).wav });
      expect(ch).toMatchObject({ ok: true, chunks: [{ start: 0 }] });
      expect(fs.statSync((ch as { chunks: { file: string }[] }).chunks[0]!.file).size).toBeGreaterThan(1000);
      // A file outside the call's in/ folder (another conversation's upload): the kernel refuses the read.
      const outside = path.join(data, "secret.wav");
      fs.writeFileSync(outside, toneWav(1));
      const w2 = makeAudioWorkdir(data);
      expect(await runner.convert({ env, workdir: w2, input: outside })).toEqual({
        ok: false,
        code: "audio_decode_failed",
      });
      const w3 = makeAudioWorkdir(data);
      fs.writeFileSync(path.join(w3, "in", "input.m4a"), crypto.randomBytes(4096));
      expect(await runner.convert({ env, workdir: w3, input: path.join(w3, "in", "input.m4a") })).toEqual({
        ok: false,
        code: "audio_decode_failed",
      });
    },
  );
});

// ---- the real models (manual: AUDIO_LIVE=1) -------------------------------------------------------------------

/**
 * `AUDIO_LIVE=1 AUDIO_LIVE_DATA_DIR=<a DATA_DIR where pnpm audio:install ran> SKILL_PYTHON=<standalone 3.12>`:
 * two synthetic voices (`say`) through the real sandboxed ffmpeg, Nemotron and Whisper (Metal inside the sandbox).
 * Never in CI; never the network (the fallback is not involved).
 */
const live = process.env.AUDIO_LIVE === "1" && process.platform === "darwin" ? it : it.skip;
describe("audio_transcribe: live models (AUDIO_LIVE=1, #173)", () => {
  live(
    "two voices → two speakers with their words",
    async () => {
      const data = process.env.AUDIO_LIVE_DATA_DIR!;
      const st = audioState(process.env.SKILL_PYTHON, data, process.env.AUDIO_FFMPEG);
      expect(st.state).toBe("available");
      const env = (st as { env: AudioEnv }).env;
      const dir = tmp();
      const say = (voice: string, text: string, out: string) =>
        expect(spawnSync("/usr/bin/say", ["-v", voice, "-o", path.join(dir, out), text]).status).toBe(0);
      say("Yuna", "안녕하세요. 저는 사회자 유나입니다. 오늘은 날씨 이야기를 해 보겠습니다.", "a.aiff");
      say(
        "Rocko (한국어(한국))",
        "네, 반갑습니다. 저는 기상 전문가입니다. 내일은 비가 많이 올 예정입니다.",
        "b.aiff",
      );
      say("Yuna", "그렇군요. 우산을 꼭 챙기셔야겠네요.", "c.aiff");
      const workdir = makeAudioWorkdir(data);
      try {
        const input = path.join(workdir, "in", "input.m4a");
        const ff = spawnSync(env.ffmpeg.exe, [
          ...["-loglevel", "error", "-y"],
          ...["-i", path.join(dir, "a.aiff"), "-i", path.join(dir, "b.aiff"), "-i", path.join(dir, "c.aiff")],
          ...["-filter_complex", "[0][1][2]concat=n=3:v=0:a=1", "-ac", "1", input],
        ]);
        expect(ff.status).toBe(0);
        const runner = sandboxedAudioRunner();
        const c = await runner.convert({ env, workdir, input });
        expect(c.ok).toBe(true);
        const job = { env, workdir, wav: (c as { wav: string }).wav, language: "ko", threshold: 0.85 };
        const d = await runner.diarize(job);
        const w = await runner.transcribe(job);
        expect(d.ok && w.ok).toBe(true);
        const merged = mergeTranscript(
          (w as { segments: Segment[] }).segments,
          (d as { turns: SpeakerTurn[] }).turns,
          {
            maxChars: 2000,
          },
        );
        expect(merged.speakers).toBe(2);
        expect(merged.segments.map((s) => s.speaker)).toEqual(["speaker_1", "speaker_2", "speaker_1"]);
        expect(merged.segments[1]!.text).toContain("기상 전문가");
      } finally {
        fs.rmSync(workdir, { recursive: true, force: true });
      }
    },
    600_000,
  );
});
