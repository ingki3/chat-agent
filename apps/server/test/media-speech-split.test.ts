import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CSRF_HEADER,
  DEFAULT_MEDIA_SETTINGS,
  MEDIA_TOOL_CODES,
  MEDIA_TOOL_HINTS,
  MEDIA_TOOL_LIMITS,
  type MediaSettings,
  type Run,
} from "@agentlee/shared";
import { SPEECH_GENERATE_TOOL } from "@agentlee/mcp-tools/media";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { FIXTURE_OPENROUTER_KEY_PREFIX, fixtureOpenRouterFetch, silentMp3 } from "../src/media/fixture.js";
import { isMp3 } from "../src/media/generate.js";
import { OPENROUTER_SPEECH_URL } from "../src/media/openrouter.js";
import {
  joinOptions,
  makeSpeechWorkdir,
  probeOptions,
  removeSpeechWorkdir,
  sandboxedSpeechAudio,
  speechTools,
  sweepSpeechScratch,
  type Mp3Info,
  type SpeechAudio,
} from "../src/media/speech-audio.js";
import {
  looksCut,
  resplitSpeech,
  SPEECH_SPLIT,
  speechSeconds,
  splitSpeech,
  type SpeechSplitLimits,
} from "../src/media/speech-split.js";
import { codexRunConfig } from "../src/runtime/lockdown.js";
import { RuntimeRegistry } from "../src/runtime/adapter.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import { storagePaths } from "../src/storage/paths.js";
import { createFamily } from "./helpers/permission-matrix.js";

vi.setConfig({ testTimeout: 60_000 });

/**
 * Long scripts for `speech_generate` (#248): split at sentence and paragraph boundaries, every piece its own
 * reserved generation, measured, re-split once when the provider cut it, joined into one MP3. OpenRouter is a fake
 * `fetchImpl` around the scripted fixture (synthetic keys) — never the network. Most cases use a fake ffprobe/ffmpeg
 * (the piece's length is written into its bytes); the real sandboxed ffprobe/ffmpeg run on macOS with Homebrew's
 * ffmpeg (skipped otherwise) on MP3s made locally.
 */

const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const KEY = `${FIXTURE_OPENROUTER_KEY_PREFIX}-synthetic-0000000000000000000split`;
const PIECE_COST = 0.0003;

function tmp(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-speech-split-")));
  closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Short pieces for tests: ~10 s each (the provider's "cut" at 14.5 s). */
const LIMITS: SpeechSplitLimits = {
  ...SPEECH_SPLIT,
  targetSeconds: 10,
  providerCutSeconds: 14.5,
  nearCutSeconds: 14,
  shortCheckMinSeconds: 2,
  maxPieces: 6,
};

/** Sentences of about 3.5 s each (slow rate): three fit a piece. */
const SENTENCES = [
  "오늘은 아침부터 하늘이 맑았어요.",
  "우리는 공원에 가서 산책을 했어요.",
  "점심에는 따뜻한 국수를 먹었어요.",
  "오후에는 도서관에서 책을 읽었어요.",
  "저녁에는 가족과 함께 이야기했어요.",
  "밤에는 별을 보며 하루를 마쳤어요.",
  "내일도 좋은 하루가 되면 좋겠어요.",
];
const LONG = `${SENTENCES.slice(0, 4).join(" ")}\n\n${SENTENCES.slice(4).join(" ")}`;

const MARK = "DUR=";
/** A fake TTS answer: a real MP3 head plus the length the fake ffprobe reads. */
const fakeMp3 = (seconds: number) =>
  Buffer.concat([silentMp3(2), Buffer.from(`${MARK}${seconds.toFixed(3)};`, "latin1")]);
const durOf = (b: Buffer): number | undefined => {
  const m = /DUR=([0-9.]+);/.exec(b.toString("latin1"));
  return m ? Number(m[1]) : undefined;
};

/** A fake ffprobe/ffmpeg: lengths from the bytes, the join recorded (order and mode) and its bytes concatenated. */
function fakeAudio(dataDir: () => string) {
  const joins: { names: string[]; reencode: unknown }[] = [];
  const audio: SpeechAudio = {
    workdir: () => makeSpeechWorkdir(dataDir()),
    async probe(file) {
      const d = durOf(fs.readFileSync(file));
      return d === undefined
        ? undefined
        : ({ seconds: d, codec: "mp3", sampleRate: 44100, channels: 2 } satisfies Mp3Info);
    },
    async join(job) {
      joins.push({ names: job.files.map((f) => path.basename(f)), reencode: job.reencode });
      const sum = job.files.reduce((a, f) => a + (durOf(fs.readFileSync(f)) ?? 0), 0);
      const out = path.join(job.workdir, "out", `joined-${joins.length}.mp3`);
      fs.writeFileSync(out, fakeMp3(sum));
      return out;
    },
  };
  return { audio, joins };
}

type Post = { input: string; body: Record<string, unknown> };

/**
 * The fake OpenRouter: the fixture's model records and prices; every speech POST answers `answer(input, n)`
 * (default: an MP3 as long as the text at the typical rate) with its own generation id `gen-piece-<n>`, whose record
 * costs `PIECE_COST`.
 */
function fakeOpenRouter(
  answer: (input: string, n: number) => Response | Buffer | Promise<Response | Buffer> = (input) =>
    fakeMp3(speechSeconds(input, LIMITS.typical)),
) {
  const inner = fixtureOpenRouterFetch();
  const posts: Post[] = [];
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    urls.push(u);
    if (init?.method === "POST" && u === OPENROUTER_SPEECH_URL) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      const n = posts.length;
      posts.push({ input: String(body.input), body });
      const a = await answer(String(body.input), n);
      if (a instanceof Response) return a;
      return new Response(new Uint8Array(a), {
        headers: { "content-type": "audio/mpeg", "x-generation-id": `gen-piece-${n}` },
      });
    }
    const g = /\/generation\?id=(gen-piece-\d+)$/.exec(u);
    if (g) return Response.json({ data: { id: g[1], total_cost: PIECE_COST } });
    return inner(url, init);
  }) as typeof fetch;
  return { fetchImpl, posts, urls };
}

const settingsWith = (more: Partial<MediaSettings> = {}): MediaSettings => {
  const s = structuredClone(DEFAULT_MEDIA_SETTINGS);
  s.kinds.speech = { enabled: true, model: "fixture/voice-one" };
  return { ...s, ...more };
};

async function start(
  o: {
    answer?: Parameters<typeof fakeOpenRouter>[0];
    audio?: "fake" | "none" | SpeechAudio;
    settings?: Partial<MediaSettings>;
  } = {},
) {
  const dataDir = path.join(tmp(), "data");
  const registry = new RuntimeRegistry();
  registry.register(new FakeRuntime({ runTools: true }));
  const db = createTestDb();
  const or = fakeOpenRouter(o.answer);
  const fake = fakeAudio(() => dataDir);
  const audio = o.audio === "none" ? undefined : o.audio && o.audio !== "fake" ? o.audio : fake.audio;
  const app = await buildApp(
    loadConfig({
      NODE_ENV: "test",
      DATA_DIR: dataDir,
      MASTER_KEY_PATH: path.join(tmp(), "master.key"),
      OPENROUTER_API_KEY: KEY,
    }),
    {
      db,
      runtimes: registry,
      runs: { flushMs: 0 },
      media: { fetchImpl: or.fetchImpl, sleep: async () => {}, speechAudio: () => audio, split: LIMITS },
    },
  );
  closers.push(() => app.close());
  const f = await createFamily(app);
  app.media!.settings.set(settingsWith(o.settings));
  const conv = app.conversations!.create(f.users.owner.id);
  const res = await app.inject({
    method: "POST",
    url: `/api/conversations/${conv.id}/messages`,
    headers: {
      host: "localhost:3000",
      origin: "http://localhost:3000",
      [CSRF_HEADER]: "1",
      cookie: f.cookies.owner,
      "content-type": "application/json",
    },
    payload: { text: "안녕" },
  });
  expect(res.statusCode, res.body).toBe(201);
  const runId = (res.json() as { run: Run }).run.id;
  await vi.waitFor(() => expect(app.runs!.get(runId)!.endedAt).not.toBeNull());
  // A run that is "still running" (the generator works only for an open run).
  db.$client.prepare("UPDATE runs SET ended_at = NULL WHERE id = ?").run(runId);
  const scope = { userId: f.users.owner.id, conversationId: conv.id, runId };
  const rows = () =>
    db.$client
      .prepare(
        "SELECT run_id, cost_usd, estimated_cost_micros, media_generation_id, media_settlement FROM usage_records WHERE purpose = 'media' ORDER BY id",
      )
      .all() as {
      run_id: string;
      cost_usd: number | null;
      estimated_cost_micros: number | null;
      media_generation_id: string | null;
      media_settlement: string;
    }[];
  const files = () => app.files!.list(conv.id);
  const speak = (input: Record<string, unknown>, opts?: { alive?: () => boolean }) =>
    app.media!.tools.run("speech", scope, input, opts);
  const scratch = () => {
    try {
      return fs.readdirSync(storagePaths(dataDir).speechScratch);
    } catch {
      return [];
    }
  };
  return { app, db, f, scope, rows, files, speak, scratch, dataDir, joins: fake.joins, ...or };
}

// ---------------------------------------------------------------- the split itself

describe("speech_generate splitting (#248)", () => {
  it("a text that fits is one piece — exactly the text; a long one splits at sentence and paragraph ends", () => {
    expect(splitSpeech("안녕하세요, 반가워요.  ")).toEqual(["안녕하세요, 반가워요.  "]);
    const pieces = splitSpeech(LONG, LIMITS);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      expect(speechSeconds(p, LIMITS.slow)).toBeLessThanOrEqual(LIMITS.targetSeconds);
      // Every piece ends a sentence.
      expect(p).toMatch(/[.!?]$/);
    }
    // Nothing lost or reordered (whitespace aside).
    const flat = (s: string) => s.replace(/\s+/g, "");
    expect(flat(pieces.join(""))).toBe(flat(LONG));
    // The paragraph break is a boundary: no piece holds the end of the first paragraph and the start of the next
    // unless both fit — the first paragraph's last sentence ends a piece.
    expect(pieces.some((p) => p.endsWith(SENTENCES[3]!))).toBe(true);
  });

  it("the production sizing: ~240 s pieces at a slow rate (Korean and English); long texts fit the piece cap", () => {
    const ko = "가".repeat(1000);
    expect(speechSeconds(ko, SPEECH_SPLIT.slow)).toBeCloseTo(1000 / 4.5, 5);
    // 12,000 characters of plain Korean prose fit the call's piece cap.
    const prose = Array.from({ length: 400 }, () => "오늘은 하늘이 맑고 바람이 시원했어요. ")
      .join("")
      .slice(0, MEDIA_TOOL_LIMITS.speechChars);
    const pieces = splitSpeech(prose);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.length).toBeLessThanOrEqual(SPEECH_SPLIT.maxPieces);
    for (const p of pieces)
      expect(speechSeconds(p, SPEECH_SPLIT.slow)).toBeLessThanOrEqual(SPEECH_SPLIT.targetSeconds);
    const en = "The quick brown fox jumps over the lazy dog again and again. ".repeat(80);
    const enPieces = splitSpeech(en);
    expect(enPieces.length).toBe(2);
    // The typical-rate estimate of a full piece stays far from the provider's cut.
    for (const p of [...pieces, ...enPieces])
      expect(speechSeconds(p, SPEECH_SPLIT.typical)).toBeLessThan(SPEECH_SPLIT.providerCutSeconds * 0.7);
  });

  it("a sentence too long for a piece is cut at clause marks, then whitespace, then characters", () => {
    const clauses = Array.from({ length: 8 }, (_, i) => `그리고 ${i}번째 생각은 이렇게 이어지고`).join(", ");
    const pieces = splitSpeech(clauses, LIMITS);
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) expect(speechSeconds(p, LIMITS.slow)).toBeLessThanOrEqual(LIMITS.targetSeconds);
    expect(pieces.slice(0, -1).every((p) => p.endsWith(","))).toBe(true);
    const words = Array.from({ length: 40 }, () => "단어와").join(" ");
    const wp = splitSpeech(words, LIMITS);
    expect(wp.length).toBeGreaterThan(1);
    expect(wp.every((p) => !p.startsWith(" ") && p.split(" ").every((w) => w === "단어와"))).toBe(true);
    const run = "가나다라마바사".repeat(20);
    const rp = splitSpeech(run, LIMITS);
    expect(rp.length).toBeGreaterThan(1);
    expect(rp.join("")).toBe(run);
    // Emoji (surrogate pairs) are never cut in half.
    const emoji = "😀".repeat(400);
    expect(splitSpeech(emoji, LIMITS).join("").match(/😀/gu)?.length).toBe(400);
  });

  it("a cut piece re-splits into at least two; cut detection: near the mark, or far shorter than expected", () => {
    const piece = splitSpeech(LONG, LIMITS)[0]!;
    const again = resplitSpeech(piece, LIMITS);
    expect(again.length).toBeGreaterThanOrEqual(2);
    expect(again.join(" ").replace(/\s+/g, "")).toBe(piece.replace(/\s+/g, ""));
    expect(resplitSpeech("가", LIMITS)).toEqual([]);
    const expected = speechSeconds(piece, LIMITS.typical);
    expect(looksCut(piece, expected, LIMITS)).toBe(false);
    expect(looksCut(piece, 14.2, LIMITS)).toBe(true);
    expect(looksCut(piece, expected * 0.3, LIMITS)).toBe(true);
    // A short text is not judged by its length (it varies too much) — only the mark.
    expect(looksCut("네.", 0.05, LIMITS)).toBe(false);
    expect(looksCut("네.", 0, LIMITS)).toBe(true);
    // Production numbers: 280 s is the mark; a 4-minute piece measured at 3 minutes is fine.
    const full = "가".repeat(1000);
    expect(looksCut(full, 290)).toBe(true);
    expect(looksCut(full, 150)).toBe(false);
    expect(looksCut(full, 60)).toBe(true);
  });
});

// ---------------------------------------------------------------- the tool

describe("speech_generate: long scripts through the tool (#248)", () => {
  it("description, codes and the Codex timeout cover the split", () => {
    expect(SPEECH_GENERATE_TOOL.description).toMatch(/split automatically/);
    expect(SPEECH_GENERATE_TOOL.description).toMatch(/durationSeconds/);
    expect(SPEECH_GENERATE_TOOL.description).toMatch(/chunks/);
    for (const c of ["media_too_long", "media_split_unavailable", "media_truncated"] as const) {
      expect(MEDIA_TOOL_CODES).toContain(c);
      expect(MEDIA_TOOL_HINTS[c]).toBeTruthy();
    }
    const toml = codexRunConfig({
      model: "gpt-test",
      tools: ["speech_generate"],
      mcp: { url: "http://127.0.0.1:4000/mcp", token: "t" },
    }).join("\n");
    const sec = Number(/tool_timeout_sec = (\d+)/.exec(toml)![1]);
    expect(sec * 1000).toBeGreaterThan(
      MEDIA_TOOL_LIMITS.speechCallTimeoutMs + MEDIA_TOOL_LIMITS.speechTimeoutMs,
    );
  });

  it("short text: one request with the text as is, measured, one row, one file", async () => {
    const t = await start();
    const r = await t.speak({ text: "안녕하세요, 오늘 날씨가 좋네요." });
    expect(r).toMatchObject({
      ok: true,
      output: { status: "ok", chunks: 1, costUsd: PIECE_COST, voice: "alloy" },
    });
    const out = (r as { output: { durationSeconds: number } }).output;
    expect(out.durationSeconds).toBeCloseTo(
      speechSeconds("안녕하세요, 오늘 날씨가 좋네요.", LIMITS.typical),
      1,
    );
    expect(t.posts).toHaveLength(1);
    expect(t.posts[0]!.body).toEqual({
      model: "fixture/voice-one",
      input: "안녕하세요, 오늘 날씨가 좋네요.",
      response_format: "mp3",
      voice: "alloy",
      provider: { data_collection: "deny" },
    });
    expect(t.joins).toEqual([]);
    expect(t.rows()).toEqual([
      expect.objectContaining({ cost_usd: PIECE_COST, media_generation_id: "gen-piece-0" }),
    ]);
    expect(t.files()).toHaveLength(1);
    // The working folder is gone.
    expect(t.scratch()).toEqual([]);
  });

  it("long text: pieces in order with the same voice and instructions, one row each, joined into one file", async () => {
    const t = await start({
      settings: { perRunLimits: { ...DEFAULT_MEDIA_SETTINGS.perRunLimits, speech: 1 } },
    });
    const pieces = splitSpeech(LONG, LIMITS);
    expect(pieces.length).toBeGreaterThanOrEqual(3);
    const r = await t.speak({ text: LONG, voice: "nova", instructions: "차분하게" });
    expect(r.ok).toBe(true);
    const out = (r as { output: Record<string, unknown> }).output;
    expect(t.posts.map((p) => p.input)).toEqual(pieces);
    for (const p of t.posts)
      expect(p.body).toMatchObject({
        model: "fixture/voice-one",
        voice: "nova",
        instructions: "차분하게",
        response_format: "mp3",
        provider: { data_collection: "deny" },
      });
    // Joined in order, stream copy (same stream throughout).
    expect(t.joins).toEqual([
      { names: pieces.map((_, i) => `piece-${String(i).padStart(3, "0")}.mp3`), reencode: undefined },
    ]);
    const want = pieces.reduce((a, p) => a + Number(speechSeconds(p, LIMITS.typical).toFixed(3)), 0);
    expect(out).toMatchObject({ chunks: pieces.length, voice: "nova" });
    expect(out.durationSeconds as number).toBeCloseTo(want, 1);
    expect(out.costUsd as number).toBeCloseTo(PIECE_COST * pieces.length, 10);
    // One row per piece, each with its own generation id and its cost.
    expect(t.rows()).toHaveLength(pieces.length);
    expect(t.rows().map((x) => x.media_generation_id)).toEqual(pieces.map((_, i) => `gen-piece-${i}`));
    expect(t.rows().every((x) => x.cost_usd === PIECE_COST && x.media_settlement === "settled")).toBe(true);
    expect(new Set(t.rows().map((x) => x.run_id)).size).toBe(pieces.length);
    // One file; one use of the run's speech limit.
    expect(t.files()).toHaveLength(1);
    expect(await t.speak({ text: "또 한 번" })).toMatchObject({ ok: false, code: "media_quota" });
    expect(t.scratch()).toEqual([]);
  });

  it("a piece cut silently at the provider's mark is re-split and tried once: success", async () => {
    // The first request stops at the mark (as eleven-v4 does at ~290 s); the rest come back whole.
    const t = await start({
      answer: (input, n) => fakeMp3(n === 0 ? 14.5 : speechSeconds(input, LIMITS.typical)),
    });
    const pieces = splitSpeech(LONG, LIMITS);
    const again = resplitSpeech(pieces[0]!, LIMITS);
    const r = await t.speak({ text: LONG });
    expect(r.ok).toBe(true);
    expect(t.posts.map((p) => p.input)).toEqual([pieces[0], ...again, ...pieces.slice(1)]);
    const out = (r as { output: Record<string, unknown> }).output;
    expect(out).toMatchObject({ chunks: again.length + pieces.length - 1 });
    // The cut piece was paid for: its row stays with its cost; the call's cost is every request's.
    expect(t.rows()).toHaveLength(t.posts.length);
    expect(out.costUsd as number).toBeCloseTo(PIECE_COST * t.posts.length, 10);
    // The cut piece is not in the file.
    expect(t.joins[0]!.names).toHaveLength(again.length + pieces.length - 1);
    expect(t.joins[0]!.names).not.toContain("piece-000.mp3");
    expect(t.files()).toHaveLength(1);
  });

  it("cut again after the re-split: media_truncated, no file, the cost of every request sent recorded", async () => {
    // Far shorter than expected, every time (a provider that stops early).
    const t = await start({ answer: () => fakeMp3(0.5) });
    const pieces = splitSpeech(LONG, LIMITS);
    const again = resplitSpeech(pieces[0]!, LIMITS);
    const r = await t.speak({ text: LONG });
    expect(r).toMatchObject({ ok: false, code: "media_truncated" });
    // The first piece, then the first of its smaller pieces — nothing after.
    expect(t.posts.map((p) => p.input)).toEqual([pieces[0], again[0]]);
    expect(t.files()).toEqual([]);
    expect(t.joins).toEqual([]);
    // Only what was sent is left: settled with its cost; every reservation never sent is gone.
    expect(t.rows()).toHaveLength(2);
    expect(t.rows().every((x) => x.cost_usd === PIECE_COST)).toBe(true);
    expect(t.app.media!.budget.remaining(t.f.users.owner.id).pendingUsd).toBe(0);
    expect(t.scratch()).toEqual([]);
  });

  it("a piece failing mid-way: no file, the pieces already made keep their cost, the rest is released", async () => {
    const t = await start({
      answer: (input, n) =>
        n === 1
          ? Response.json({ error: { code: 500 } }, { status: 500 })
          : fakeMp3(speechSeconds(input, LIMITS.typical)),
    });
    const r = await t.speak({ text: LONG });
    expect(r).toMatchObject({ ok: false, code: "media_failed" });
    expect(t.posts).toHaveLength(2);
    expect(t.files()).toEqual([]);
    // The first piece's row with its cost; the refused one (not billed) and the unsent ones removed.
    expect(t.rows()).toEqual([
      expect.objectContaining({ cost_usd: PIECE_COST, media_generation_id: "gen-piece-0" }),
    ]);
    expect(t.app.media!.budget.remaining(t.f.users.owner.id)).toMatchObject({
      spentUsd: PIECE_COST,
      pendingUsd: 0,
    });
    expect(t.scratch()).toEqual([]);
  });

  it("the summed reservation (plus one retry's headroom) over the daily limit is refused before any request", async () => {
    const t = await start({ settings: { dailyCostLimitUsd: 0.01 } });
    // Each piece's bound: (UTF-8 bytes + 64) × $0.000015 × 1.2 ≈ $0.003 — one fits $0.01, all of them do not.
    const r = await t.speak({ text: LONG });
    expect(r).toMatchObject({ ok: false, code: "media_budget" });
    expect(t.posts).toEqual([]);
    expect(t.rows()).toEqual([]);
    // A short text (one piece) still fits.
    expect((await t.speak({ text: SENTENCES[0]! })).ok).toBe(true);
  });

  it("while it runs, every piece holds its reserved bound — reserved before the first request", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const t = await start({
      answer: async (input, n) => {
        if (n === 0) await gate;
        return fakeMp3(speechSeconds(input, LIMITS.typical));
      },
    });
    const pieces = splitSpeech(LONG, LIMITS);
    const call = t.speak({ text: LONG });
    await vi.waitFor(() => expect(t.posts).toHaveLength(1));
    // Every piece's own row, reserved with its own bound, before the first answer came.
    expect(t.rows()).toHaveLength(pieces.length);
    expect(t.rows().every((x) => x.media_settlement === "reserved" && x.estimated_cost_micros! > 0)).toBe(
      true,
    );
    const pending = t.app.media!.budget.remaining(t.f.users.owner.id).pendingUsd;
    expect(pending).toBeCloseTo(t.rows().reduce((a, x) => a + x.estimated_cost_micros!, 0) / 1_000_000, 6);
    release();
    expect((await call).ok).toBe(true);
    expect(t.rows().every((x) => x.media_settlement === "settled")).toBe(true);
    expect(t.app.media!.budget.remaining(t.f.users.owner.id)).toMatchObject({
      pendingUsd: 0,
      spentUsd: Number((PIECE_COST * pieces.length).toFixed(6)),
    });
  });

  it("no ffmpeg on this server: a long text is refused before anything is asked; a short one works unmeasured", async () => {
    const t = await start({ audio: "none" });
    expect(await t.speak({ text: LONG })).toMatchObject({ ok: false, code: "media_split_unavailable" });
    expect(t.urls).toEqual([]);
    expect(t.rows()).toEqual([]);
    const r = await t.speak({ text: SENTENCES[0]! });
    expect(r).toMatchObject({ ok: true, output: { chunks: 1, durationSeconds: null, costUsd: PIECE_COST } });
    expect(t.posts.map((p) => p.input)).toEqual([SENTENCES[0]]);
  });

  it("a text needing more pieces than allowed is media_too_long before anything is asked", async () => {
    const t = await start();
    const long = Array.from({ length: 12 }, () => SENTENCES.join(" ")).join("\n\n");
    expect(splitSpeech(long, LIMITS).length).toBeGreaterThan(LIMITS.maxPieces);
    expect(await t.speak({ text: long })).toMatchObject({ ok: false, code: "media_too_long" });
    expect(t.urls).toEqual([]);
  });

  it("the run stopped mid-way: no further piece is sent, nothing stored, unsent reservations released", async () => {
    let alive = true;
    const t2 = await start({
      answer: (input, n) => {
        if (n === 0) alive = false;
        return fakeMp3(speechSeconds(input, LIMITS.typical));
      },
    });
    const r2 = await t2.speak({ text: LONG }, { alive: () => alive });
    expect(r2).toMatchObject({ ok: false, code: "media_cancelled" });
    expect(t2.posts).toHaveLength(1);
    expect(t2.files()).toEqual([]);
    expect(t2.rows()).toEqual([expect.objectContaining({ cost_usd: PIECE_COST })]);
    expect(t2.scratch()).toEqual([]);
  });

  it("the admin changing the settings mid-way stops before the next piece (media_changed)", async () => {
    const holder: { t?: Awaited<ReturnType<typeof start>> } = {};
    const t = await start({
      answer: (input, n) => {
        if (n === 0) holder.t!.app.media!.settings.set(settingsWith({ dailyCostLimitUsd: 40 }));
        return fakeMp3(speechSeconds(input, LIMITS.typical));
      },
    });
    holder.t = t;
    expect(await t.speak({ text: LONG })).toMatchObject({ ok: false, code: "media_changed" });
    expect(t.posts).toHaveLength(1);
    expect(t.rows()).toHaveLength(1);
    expect(t.files()).toEqual([]);
  });

  it("a joined result that does not add up to its pieces is not stored", async () => {
    let dataDir = "";
    const fake = fakeAudio(() => dataDir);
    const broken: SpeechAudio = {
      workdir: () => makeSpeechWorkdir(dataDir),
      probe: fake.audio.probe,
      async join(job) {
        const out = path.join(job.workdir, "out", "short.mp3");
        fs.writeFileSync(out, fakeMp3(1));
        return out;
      },
    };
    const t = await start({ audio: broken });
    dataDir = t.dataDir;
    expect(await t.speak({ text: LONG })).toMatchObject({ ok: false, code: "media_failed" });
    expect(t.files()).toEqual([]);
    expect(t.rows().every((x) => x.cost_usd === PIECE_COST)).toBe(true);
  });

  it("working folders: owner-only in/ and out/ under speech-scratch, swept at start", () => {
    const data = tmp();
    const w = makeSpeechWorkdir(data);
    expect(fs.statSync(w).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(w).sort()).toEqual(["in", "out"]);
    expect(path.dirname(w)).toBe(fs.realpathSync(storagePaths(data).speechScratch));
    makeSpeechWorkdir(data);
    expect(sweepSpeechScratch(data)).toBe(true);
    expect(fs.readdirSync(storagePaths(data).speechScratch)).toEqual([]);
    expect(removeSpeechWorkdir(path.join(data, "nope"))).toBe(true);
  });

  it("ffprobe/ffmpeg run sandboxed: only in/ read, only out/ written, no network; none off macOS", () => {
    const tools = {
      ffmpeg: { exe: "/opt/x/bin/ffmpeg", trusted: ["/opt/x/bin"] },
      ffprobe: "/opt/x/bin/ffprobe",
    };
    const w = "/data/speech-scratch/abc";
    const p = probeOptions(tools, `${w}/in/piece-000.mp3`);
    expect(p).toMatchObject({
      command: "/opt/x/bin/ffprobe",
      read: [`${w}/in`],
      write: [],
      network: "none",
      noFlagChanges: true,
      trusted: ["/opt/x/bin"],
    });
    const j = joinOptions(tools, { workdir: w, files: [`${w}/in/piece-000.mp3`], out: `${w}/out/s.mp3` });
    expect(j).toMatchObject({ read: [`${w}/in`], write: [`${w}/out`], network: "none", noFlagChanges: true });
    expect(j.args).toEqual(expect.arrayContaining(["-f", "concat", "-safe", "1", "-c:a", "copy", "-fs"]));
    const re = joinOptions(tools, {
      workdir: w,
      files: [`${w}/in/piece-000.mp3`, `${w}/in/piece-001.mp3`],
      out: `${w}/out/s.mp3`,
      reencode: { bitrateK: 64, sampleRate: 44100, channels: 1 },
    });
    expect(re.args).toEqual(expect.arrayContaining(["libmp3lame", "64k", "-ac", "1"]));
    expect(re.args.join(" ")).toContain("[0:a:0][1:a:0]concat=n=2:v=0:a=1[a]");
    expect(speechTools(undefined, "/data", "linux")).toBeUndefined();
    expect(speechTools("/nope/ffmpeg", "/data", "darwin")).toBeUndefined();
    expect(sandboxedSpeechAudio({ dataDir: "/data", platform: "linux" })).toBeUndefined();
  });
});

// ---------------------------------------------------------------- the real ffprobe/ffmpeg (macOS with ffmpeg)

const realTools =
  process.platform === "darwin" ? speechTools(process.env.TEST_AUDIO_FFMPEG, "/nonexistent-data") : undefined;
const realIt = realTools ? it : it.skip;

/** A real MP3 tone of `seconds` (made here with the unsandboxed ffmpeg — test input only). */
const tones = new Map<string, Buffer>();
function tone(seconds: number, rate = 22050): Buffer {
  const key = `${seconds.toFixed(2)}@${rate}`;
  const had = tones.get(key);
  if (had) return had;
  const dir = tmp();
  const out = path.join(dir, "t.mp3");
  const r = spawnSync(realTools!.ffmpeg.exe, [
    "-nostdin",
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${seconds.toFixed(2)}:sample_rate=${rate}`,
    "-ac",
    "1",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "32k",
    out,
  ]);
  expect(r.status).toBe(0);
  const b = fs.readFileSync(out);
  tones.set(key, b);
  return b;
}

describe("speech_generate: the real sandboxed ffprobe and ffmpeg (#248, macOS)", () => {
  realIt("measures each piece, joins them in order into one MP3 of their summed length", async () => {
    let dataDir = "";
    const lazy: SpeechAudio = {
      workdir: () => real().workdir(),
      probe: (f, s) => real().probe(f, s),
      join: (j, s) => real().join(j, s),
    };
    let made: SpeechAudio | undefined;
    const real = () =>
      (made ??= sandboxedSpeechAudio({
        dataDir,
        platform: "darwin",
        ffmpegPath: process.env.TEST_AUDIO_FFMPEG,
      })!);
    const t = await start({
      audio: lazy,
      answer: (input) => tone(Math.round(speechSeconds(input, LIMITS.typical) * 10) / 10),
    });
    dataDir = t.dataDir;
    const pieces = splitSpeech(LONG, LIMITS);
    const r = await t.speak({ text: LONG });
    expect(r.ok).toBe(true);
    const out = (r as { output: { durationSeconds: number; chunks: number; fileId: string } }).output;
    const want = pieces.reduce((a, p) => a + Math.round(speechSeconds(p, LIMITS.typical) * 10) / 10, 0);
    expect(out.chunks).toBe(pieces.length);
    expect(Math.abs(out.durationSeconds - want)).toBeLessThan(0.5);
    const row = t.app.files!.get(out.fileId)!;
    expect(row.kind).toBe("mp3");
    // The stored file itself, measured again.
    const stored = path.join(tmp(), "in");
    fs.mkdirSync(stored);
    const copy = path.join(stored, "piece-000.mp3");
    const fd = t.app.files!.open(row)!;
    const buf = Buffer.alloc(row.bytes);
    fs.readSync(fd, buf, 0, row.bytes, 0);
    fs.closeSync(fd);
    expect(isMp3(buf)).toBe(true);
    fs.writeFileSync(copy, buf);
    const info = await real().probe(copy);
    expect(info?.seconds).toBeCloseTo(out.durationSeconds, 1);
    expect(t.scratch()).toEqual([]);
  });

  realIt(
    "pieces with different streams are re-encoded; a real cut at the mark is caught and re-split",
    async () => {
      let dataDir = "";
      let made: SpeechAudio | undefined;
      const real = () =>
        (made ??= sandboxedSpeechAudio({
          dataDir,
          platform: "darwin",
          ffmpegPath: process.env.TEST_AUDIO_FFMPEG,
        })!);
      const lazy: SpeechAudio = {
        workdir: () => real().workdir(),
        probe: (f, s) => real().probe(f, s),
        join: (j, s) => real().join(j, s),
      };
      const t = await start({
        audio: lazy,
        answer: (input, n) =>
          n === 0
            ? tone(14.6)
            : tone(Math.round(speechSeconds(input, LIMITS.typical) * 10) / 10, n % 2 ? 22050 : 24000),
      });
      dataDir = t.dataDir;
      const pieces = splitSpeech(LONG, LIMITS);
      const again = resplitSpeech(pieces[0]!, LIMITS);
      const r = await t.speak({ text: LONG });
      expect(r.ok).toBe(true);
      expect(t.posts.map((p) => p.input)).toEqual([pieces[0], ...again, ...pieces.slice(1)]);
      const out = (r as { output: { durationSeconds: number; chunks: number } }).output;
      expect(out.chunks).toBe(again.length + pieces.length - 1);
      const want = [...again, ...pieces.slice(1)].reduce(
        (a, p) => a + Math.round(speechSeconds(p, LIMITS.typical) * 10) / 10,
        0,
      );
      expect(Math.abs(out.durationSeconds - want)).toBeLessThan(0.6);
    },
  );
});
