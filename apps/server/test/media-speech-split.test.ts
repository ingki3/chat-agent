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
import {
  FIXTURE_OPENROUTER_KEY_PREFIX,
  fixtureOpenRouterFetch,
  FIXTURE_CORRUPT_MARK,
  fixtureMp3Frames,
  fixtureSpeechAudio,
  silentMp3,
} from "../src/media/fixture.js";
import { OPENROUTER_SPEECH_URL } from "../src/media/openrouter.js";
import {
  joinOptions,
  makeSpeechWorkdir,
  decodeOptions,
  decodeVerdict,
  judgeProbe,
  probeOptions,
  probeOutputBytes,
  removeSpeechWorkdir,
  sandboxedSpeechAudio,
  speechTools,
  sweepSpeechScratch,
  type SpeechAudio,
} from "../src/media/speech-audio.js";
import {
  looksCut,
  resplitSpeech,
  SPEECH_SPLIT,
  speechSeconds,
  splitSpans,
  splitSpeech,
  type SpeechSplitLimits,
} from "../src/media/speech-split.js";
import { codexRunConfig, speechCallBudgetMs } from "../src/runtime/lockdown.js";
import { boundMicros, speechCostBound } from "../src/media/cost.js";
import { knownSecrets } from "../src/secrets/known.js";
import { McpTokens } from "../src/isolation/tokens.js";
import { RuntimeRegistry } from "../src/runtime/adapter.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import { storagePaths } from "../src/storage/paths.js";
import { createFamily } from "./helpers/permission-matrix.js";

vi.setConfig({ testTimeout: 60_000 });

/**
 * Long scripts for `speech_generate` (#248): split at sentence and paragraph boundaries, every piece its own
 * reserved generation, measured, re-split once when the provider cut it, joined into one MP3. OpenRouter is a fake
 * `fetchImpl` around the scripted fixture (synthetic keys) — never the network. Most cases use a fake measure/join
 * (the piece's length is written into its bytes); the real sandboxed ffmpeg (decoding) runs on macOS with Homebrew's
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
/** A fake TTS answer: a real MP3 head plus the length the fake decoder "plays". */
const fakeMp3 = (seconds: number) =>
  Buffer.concat([silentMp3(2), Buffer.from(`${MARK}${seconds.toFixed(3)};`, "latin1")]);
const durOf = (b: Buffer): number | undefined => {
  const m = /DUR=([0-9.]+);/.exec(b.toString("latin1"));
  return m ? Number(m[1]) : undefined;
};

/** In a fake answer: the fake decoder fails on it (corrupt), finds another form, or cannot run. */
const CORRUPT = "CORRUPT;";
const UNSUPPORTED = "UNSUPPORTED;";
const MEASURE_FAILED = "MEASURE-FAILED;";

/**
 * A fake measure/join with the real one's semantics: the "decoded" length from the bytes, a decoding error for a
 * corrupt answer; the join recorded (order and bit rate) and its bytes concatenated.
 */
function fakeAudio(dataDir: () => string) {
  const joins: { names: string[]; bitrateK: number }[] = [];
  const audio: SpeechAudio = {
    workdir: () => makeSpeechWorkdir(dataDir()),
    async measure(file, m) {
      const b = fs.readFileSync(file);
      if (b.includes(CORRUPT, 0, "latin1")) return { ok: false, reason: "corrupt" };
      if (b.includes(UNSUPPORTED, 0, "latin1")) return { ok: false, reason: "unsupported" };
      if (b.includes(MEASURE_FAILED, 0, "latin1")) return { ok: false, reason: "failed" };
      const d = durOf(b);
      // Not one of our fake MP3s (WAV, …): the decoder's report would show another codec.
      if (d === undefined) return { ok: false, reason: "unsupported" };
      if (d > m.maxSeconds) return { ok: false, reason: "too_long" };
      const rate = Number(/RATE=(\d+);/.exec(b.toString("latin1"))?.[1] ?? 44100);
      const samples = Math.round(d * rate);
      return { ok: true, samples, seconds: samples / rate, sampleRate: rate, channels: 1 };
    },
    async join(job) {
      joins.push({ names: job.files.map((f) => path.basename(f)), bitrateK: job.bitrateK });
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
    audio?: "fake" | "none" | "fixture" | SpeechAudio;
    settings?: Partial<MediaSettings>;
    split?: SpeechSplitLimits;
    now?: () => number;
  } = {},
) {
  const dataDir = path.join(tmp(), "data");
  const registry = new RuntimeRegistry();
  registry.register(new FakeRuntime({ runTools: true }));
  const db = createTestDb();
  const or = fakeOpenRouter(o.answer);
  const fake = fakeAudio(() => dataDir);
  const audio =
    o.audio === "none"
      ? undefined
      : o.audio === "fixture"
        ? fixtureSpeechAudio(dataDir)
        : o.audio && o.audio !== "fake"
          ? o.audio
          : fake.audio;
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
      ...(o.now ? { usage: { now: o.now } } : {}),
      media: {
        fetchImpl: or.fetchImpl,
        sleep: async () => {},
        speechAudio: () => audio,
        split: o.split ?? LIMITS,
        ...(o.now ? { now: o.now } : {}),
      },
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
        "SELECT run_id, cost_usd, estimated_cost_micros, media_generation_id, media_settlement, created_at FROM usage_records WHERE purpose = 'media' ORDER BY id",
      )
      .all() as {
      created_at: number;
      run_id: string;
      cost_usd: number | null;
      estimated_cost_micros: number | null;
      media_generation_id: string | null;
      media_settlement: string;
    }[];
  const files = () => app.files!.list(conv.id);
  const speak = (input: Record<string, unknown>, opts?: { alive?: () => boolean; signal?: AbortSignal }) =>
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
    for (const c of ["media_too_long", "media_audio_unavailable", "media_truncated"] as const) {
      expect(MEDIA_TOOL_CODES).toContain(c);
      expect(MEDIA_TOOL_HINTS[c]).toBeTruthy();
    }
    const toml = codexRunConfig({
      model: "gpt-test",
      tools: ["speech_generate"],
      mcp: { url: "http://127.0.0.1:4000/mcp", token: "t" },
    }).join("\n");
    const sec = Number(/tool_timeout_sec = (\d+)/.exec(toml)![1]);
    // The whole call: its budget, the last piece and its measurement, two joins (the second re-encodes a result
    // over 50MB), the final measurement, the cost lookups — all from the limits the server enforces.
    const l = MEDIA_TOOL_LIMITS;
    expect(speechCallBudgetMs()).toBeGreaterThanOrEqual(
      l.speechCallTimeoutMs + l.speechTimeoutMs + 2 * l.speechJoinTimeoutMs + 2 * l.speechMeasureTimeoutMs,
    );
    expect(sec * 1000).toBeGreaterThanOrEqual(speechCallBudgetMs());
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
    // Joined in order (from the same PCM, encoded once at 128 kbit/s).
    expect(t.joins).toEqual([
      { names: pieces.map((_, i) => `piece-${String(i).padStart(3, "0")}.mp3`), bitrateK: 128 },
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
    // Every piece's own row with its own bound, before the first answer came: the one sent `reserved`, the rest
    // `pending_send` (never billed).
    expect(t.rows()).toHaveLength(pieces.length);
    expect(t.rows().map((x) => x.media_settlement)).toEqual([
      "reserved",
      ...pieces.slice(1).map(() => "pending_send"),
    ]);
    expect(t.rows().every((x) => x.estimated_cost_micros! > 0)).toBe(true);
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

  it("no ffmpeg on this server: nothing is made — not even a text of one piece — before anything is asked", async () => {
    const t = await start({ audio: "none" });
    expect(await t.speak({ text: LONG })).toMatchObject({ ok: false, code: "media_audio_unavailable" });
    const r = await t.speak({ text: SENTENCES[0]! });
    expect(r).toMatchObject({ ok: false, code: "media_audio_unavailable" });
    expect(!r.ok && r.hint).toMatch(/ffmpeg/);
    expect(t.urls).toEqual([]);
    expect(t.rows()).toEqual([]);
    // The FAKE_RUNTIME's scripted decoder measures a clean MP3 by its frames.
    const t2 = await start({ audio: "fixture", answer: () => silentMp3(2) });
    // (A text short enough not to be judged by its length: the fake answers are 2 frames long.)
    expect(await t2.speak({ text: "안녕." })).toMatchObject({
      ok: true,
      output: { chunks: 1, durationSeconds: 0.05 },
    });
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
      measure: fake.audio.measure,
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

  it("ffmpeg runs sandboxed: reads only the input's folder, writes only out/, no network; none off macOS", () => {
    const tools = {
      ffmpeg: { exe: "/opt/x/bin/ffmpeg", trusted: ["/opt/x/bin"] },
      ffprobe: "/opt/x/bin/ffprobe",
    };
    const w = "/data/speech-scratch/abc";
    const d = decodeOptions(tools, `${w}/in/piece-000.mp3`);
    expect(d).toMatchObject({
      command: "/opt/x/bin/ffmpeg",
      read: [`${w}/in`],
      write: [],
      network: "none",
      noFlagChanges: true,
      trusted: ["/opt/x/bin"],
    });
    // A strict decode of the whole file into nothing: its exit status is the verdict (no log is read).
    expect(d.args).toEqual(expect.arrayContaining(["-xerror", "-err_detect", "explode", "null"]));
    expect(d.args).not.toContain("-t");
    // ffprobe: every stream and every decoded frame, as JSON; its report bounded by the audio's length.
    const p = probeOptions(tools, `${w}/in/piece-000.mp3`, 600);
    expect(p).toMatchObject({ command: "/opt/x/bin/ffprobe", read: [`${w}/in`], write: [], network: "none" });
    expect(p.args.join(" ")).toContain("frame=stream_index,channels,nb_samples,duration");
    expect(p.args).toEqual(expect.arrayContaining(["-of", "json=c=1"]));
    expect(p.maxOutputBytes).toBe(probeOutputBytes(600));
    expect(probeOutputBytes(600)).toBeGreaterThan(600 * 42 * 80);
    const j = joinOptions(tools, {
      workdir: w,
      files: [`${w}/in/piece-000.mp3`, `${w}/in/piece-001.mp3`],
      out: `${w}/out/s.mp3`,
      bitrateK: 64,
      sampleRate: 22050,
    });
    expect(j).toMatchObject({ read: [`${w}/in`], write: [`${w}/out`], network: "none", noFlagChanges: true });
    expect(j.args).toEqual(expect.arrayContaining(["libmp3lame", "64k", "-ac", "1", "-fs"]));
    // Each piece to the same PCM (s16 mono at the pieces' rate), then concatenated — no resampling.
    expect(j.args.join(" ")).toContain(
      "[0:a:0]aformat=sample_fmts=s16:channel_layouts=mono:sample_rates=22050[p0];[1:a:0]aformat=sample_fmts=s16:channel_layouts=mono:sample_rates=22050[p1];[p0][p1]concat=n=2:v=0:a=1[a]",
    );
    expect(j.args).not.toContain("copy");
    expect(speechTools(undefined, "/data", "linux")).toBeUndefined();
    expect(speechTools("/nope/ffmpeg", "/data", "darwin")).toBeUndefined();
    expect(sandboxedSpeechAudio({ dataDir: "/data", platform: "linux" })).toBeUndefined();
  });
});

// ---------------------------------------------------------------- review round 1 (#251)

/** The fixture speech model's price lines (its bound: input bytes × $0.000015 × 1.2). */
const FIXTURE_ENDPOINTS = [
  { provider_name: "Fixture", tag: "fixture", pricing: { prompt: "0.000015", completion: "0" } },
];
const microsOf = (text: string) => boundMicros(speechCostBound(FIXTURE_ENDPOINTS, { text })!);

describe("speech_generate: review round 1 regressions (#251)", () => {
  it("P2: a restart with pieces never sent removes their rows; only the sent one keeps its bound", async () => {
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
    // The start-up recovery as a new process runs it (this process "stopped" while the first piece was out).
    expect(t.app.usageStore!.recoverReservedMedia()).toBe(pieces.length);
    expect(t.rows()).toEqual([expect.objectContaining({ media_settlement: "unconfirmed" })]);
    expect(t.app.media!.budget.remaining(t.f.users.owner.id).pendingUsd).toBeCloseTo(
      t.rows()[0]!.estimated_cost_micros! / 1_000_000,
      6,
    );
    // The call that was "lost" goes on: its next piece has no unsent row any more — nothing more is sent.
    release();
    expect(await call).toMatchObject({ ok: false, code: "media_failed" });
    expect(t.posts).toHaveLength(1);
    expect(t.rows()).toHaveLength(1);
    expect(t.files()).toEqual([]);
  });

  it("P2 (r3 re-plan): a call that runs past midnight counts every piece — retry pieces too — for its start day", async () => {
    // 23:59:59 in Seoul; the first answer comes at 00:00:01 the next day and is cut, so a retry follows.
    const before = Date.parse("2026-11-25T14:59:59.000Z");
    const after = Date.parse("2026-11-25T15:00:01.000Z");
    let clock = after;
    const t = await start({
      now: () => clock,
      answer: (input, n) => {
        if (n === 0) clock = after;
        return fakeMp3(n === 0 ? 14.5 : speechSeconds(input, LIMITS.typical));
      },
    });
    // The new day is already spent to its limit: the call is not checked against it.
    t.app.usageStore!.recordMedia({
      userId: t.f.users.owner.id,
      conversationId: t.scope.conversationId,
      runId: "next-day",
      callId: "c1",
      model: "fixture/voice-one",
      costUsd: 49.9999,
    });
    clock = before;
    const r = await t.speak({ text: LONG });
    expect(r.ok).toBe(true);
    const pieces = splitSpeech(LONG, LIMITS);
    expect(t.posts).toHaveLength(pieces.length + resplitSpeech(pieces[0]!, LIMITS).length);
    const mine = t.rows().filter((x) => !x.run_id.startsWith("next-day"));
    expect(mine).toHaveLength(t.posts.length);
    expect(mine.every((x) => x.created_at === before)).toBe(true);
    // The start day holds the call's cost; the next day only what it had.
    const b = t.app.media!.budget;
    expect(b.remaining(t.f.users.owner.id, before).spentUsd).toBeCloseTo(PIECE_COST * t.posts.length, 9);
    expect(b.remaining(t.f.users.owner.id, after).spentUsd).toBe(49.9999);
  });
  it("P2: the up-front check sums exactly the integer micro-USD the rows hold", async () => {
    const pieces = splitSpeech(LONG, LIMITS);
    const each = pieces.map(microsOf);
    const headroom = Math.max(
      ...pieces.map((p) => resplitSpeech(p, LIMITS).reduce((a, q) => a + microsOf(q), 0)),
    );
    const need = each.reduce((a, b) => a + b, 0) + headroom;
    const spend = async (left: number) => {
      const t = await start();
      t.app.usageStore!.recordMedia({
        userId: t.f.users.owner.id,
        conversationId: t.scope.conversationId,
        runId: "earlier",
        callId: "c1",
        model: "fixture/voice-one",
        costUsd: (50_000_000 - left) / 1_000_000,
      });
      expect(Math.round(t.app.media!.budget.remaining(t.f.users.owner.id).remainingUsd * 1_000_000)).toBe(
        left,
      );
      return t;
    };
    // Exactly what is needed is left: it goes, and every row holds its piece's integer bound.
    const ok = await spend(need);
    expect((await ok.speak({ text: LONG })).ok).toBe(true);
    expect(
      ok
        .rows()
        .filter((x) => !x.run_id.startsWith("earlier"))
        .map((x) => x.estimated_cost_micros),
    ).toEqual(each);
    // One micro-USD less: refused before any request.
    const short = await spend(need - 1);
    expect(await short.speak({ text: LONG })).toMatchObject({ ok: false, code: "media_budget" });
    expect(short.posts).toEqual([]);
  });

  it("P2: a secret registered during the call blocks the next piece carrying it (never sent)", async () => {
    const secret = "zqSYNTHETIC7Xk2Lp9Wm4split251";
    const text = `${SENTENCES.slice(0, 4).join(" ")}\n\n${SENTENCES[4]} 암호는 ${secret} 이에요. ${SENTENCES[5]}`;
    const pieces = splitSpeech(text, LIMITS);
    expect(pieces[0]).not.toContain(secret);
    expect(pieces.some((p) => p.includes(secret))).toBe(true);
    const t = await start({
      answer: (input, n) => {
        if (n === 0) knownSecrets.add(secret, { fresh: true });
        return fakeMp3(speechSeconds(input, LIMITS.typical));
      },
    });
    expect(await t.speak({ text })).toMatchObject({ ok: false, code: "media_secret_blocked" });
    expect(t.posts.every((p) => !p.input.includes(secret))).toBe(true);
    expect(t.files()).toEqual([]);
    // Only the pieces sent keep a row; the blocked one and the rest are released.
    expect(t.rows()).toHaveLength(t.posts.length);
    expect(t.app.media!.budget.remaining(t.f.users.owner.id).pendingUsd).toBe(0);
  });

  it("P2: a retry that would pass the call's cap on paid requests is not made", async () => {
    const pieces = splitSpeech(LONG, LIMITS);
    // The cap: the first split's pieces and nothing more.
    const t = await start({
      split: { ...LIMITS, maxRequests: pieces.length },
      answer: (input, n) => fakeMp3(n === 0 ? 14.5 : speechSeconds(input, LIMITS.typical)),
    });
    const r = await t.speak({ text: LONG });
    expect(r).toMatchObject({ ok: false, code: "media_truncated" });
    expect(!r.ok && r.hint).toMatch(/요청 수를 넘어/);
    expect(!r.ok && r.hint).toMatch(/이미 나간 비용은 기록/);
    expect(t.posts).toHaveLength(1);
    expect(t.rows()).toEqual([expect.objectContaining({ cost_usd: PIECE_COST })]);
    // With room for the retry it goes through.
    const t2 = await start({
      split: { ...LIMITS, maxRequests: pieces.length + resplitSpeech(pieces[0]!, LIMITS).length },
      answer: (input, n) => fakeMp3(n === 0 ? 14.5 : speechSeconds(input, LIMITS.typical)),
    });
    expect((await t2.speak({ text: LONG })).ok).toBe(true);
    expect(SPEECH_SPLIT.maxRequests).toBeGreaterThan(SPEECH_SPLIT.maxPieces);
  });

  it("P3: a run stopped through the MCP tool aborts the join under way (media_cancelled)", async () => {
    let dataDir = "";
    let joining!: () => void;
    const inJoin = new Promise<void>((res) => (joining = res));
    let aborted = false;
    const fake = fakeAudio(() => dataDir);
    const slowJoin: SpeechAudio = {
      workdir: () => makeSpeechWorkdir(dataDir),
      measure: fake.audio.measure,
      join: (_job, signal) =>
        new Promise((res) => {
          joining();
          const done = () => res(undefined);
          const abort = () => {
            aborted = true;
            done();
          };
          if (signal?.aborted) abort();
          signal?.addEventListener("abort", abort);
          setTimeout(done, 10_000).unref();
        }),
    };
    const t = await start({ audio: slowJoin });
    dataDir = t.dataDir;
    const { url } = await t.app.mcp!.endpoint();
    const token = t.app.runs!.mcpTokens.issue(t.scope);
    const started = Date.now();
    const call = fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "speech_generate", arguments: { text: LONG } },
      }),
    });
    await inJoin;
    t.app.runs!.mcpTokens.revokeRun(t.scope.runId);
    const res = await call;
    await res.text();
    // The join was stopped by the revocation itself (not by its own time limit); the stopped run's call answers
    // nothing to the model (its token is gone), stores nothing and leaves no working folder.
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(8_000);
    await vi.waitFor(() => expect(t.scratch()).toEqual([]));
    expect(t.app.media!.budget.remaining(t.f.users.owner.id).pendingUsd).toBe(0);
    expect(t.files()).toEqual([]);
  });

  it("P3: an aborted measurement or join is media_cancelled (generator signal)", async () => {
    let dataDir = "";
    const stop = new AbortController();
    const fake = fakeAudio(() => dataDir);
    const aborting: SpeechAudio = {
      workdir: () => makeSpeechWorkdir(dataDir),
      measure: fake.audio.measure,
      async join() {
        stop.abort();
        return undefined;
      },
    };
    const t = await start({ audio: aborting });
    dataDir = t.dataDir;
    expect(await t.speak({ text: LONG }, { signal: stop.signal })).toMatchObject({
      ok: false,
      code: "media_cancelled",
    });
  });

  it("P1: the start-up sweep never follows a linked speech-scratch root or a link inside it", () => {
    const data = tmp();
    const outside = tmp();
    fs.writeFileSync(path.join(outside, "keep.txt"), "family data");
    const victim = path.join(outside, "11111111-2222-4333-8444-555555555555");
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, "keep.txt"), "x");
    const root = storagePaths(data).speechScratch;
    fs.symlinkSync(outside, root);
    expect(sweepSpeechScratch(data)).toBe(false);
    expect(fs.existsSync(path.join(outside, "keep.txt"))).toBe(true);
    expect(fs.existsSync(path.join(victim, "keep.txt"))).toBe(true);
    expect(() => makeSpeechWorkdir(data)).toThrow();
    // A real root: a link inside is removed as a link (its target stays); a folder not of ours is left.
    fs.unlinkSync(root);
    fs.mkdirSync(root, { mode: 0o700 });
    fs.symlinkSync(victim, path.join(root, "22222222-2222-4333-8444-555555555555"));
    fs.mkdirSync(path.join(root, "not-ours"));
    const w = makeSpeechWorkdir(data);
    fs.writeFileSync(path.join(w, "in", "piece-000.mp3"), "x");
    expect(sweepSpeechScratch(data)).toBe(false);
    expect(fs.readdirSync(root)).toEqual(["not-ours"]);
    expect(fs.existsSync(path.join(victim, "keep.txt"))).toBe(true);
    fs.rmdirSync(path.join(root, "not-ours"));
    expect(sweepSpeechScratch(data)).toBe(true);
    // A missing root is nothing to do.
    expect(sweepSpeechScratch(tmp())).toBe(true);
  });

  it("P3: sentences typed without a space, grapheme-safe cuts, lossless spans", () => {
    const glued = SENTENCES.join("");
    const pieces = splitSpeech(glued, LIMITS);
    expect(pieces.length).toBeGreaterThan(1);
    // Every piece ends a sentence (the boundary without a space was found).
    expect(pieces.every((p) => /[.!?]$/.test(p))).toBe(true);
    // A decimal point is not a sentence end.
    expect(splitSpans("값은 3.14입니다. ".repeat(20), LIMITS).every((sp) => sp.end > 0)).toBe(true);
    for (const p of splitSpeech("값은 3.14입니다. ".repeat(20), LIMITS)) expect(p).not.toMatch(/^14/);
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const whole = (text: string) => {
      const spans = splitSpans(text, LIMITS);
      // The spans cover the source exactly, in order: nothing lost, nothing repeated.
      expect(spans[0]!.start).toBe(0);
      expect(spans.at(-1)!.end).toBe(text.length);
      for (let i = 1; i < spans.length; i++) expect(spans[i]!.start).toBe(spans[i - 1]!.end);
      expect(spans.map((sp) => text.slice(sp.start, sp.end)).join("")).toBe(text);
      // What is sent is each span with its edge whitespace trimmed (blank ones dropped).
      if (spans.length > 1)
        expect(splitSpeech(text, LIMITS)).toEqual(
          spans.map((sp) => text.slice(sp.start, sp.end).trim()).filter(Boolean),
        );
      // Every cut is a grapheme boundary of the source.
      const ends = new Set([...seg.segment(text)].map((g) => g.index + g.segment.length));
      for (const sp of spans) expect(ends.has(sp.end)).toBe(true);
      return spans;
    };
    // Combining accents (e + U+0301) and ZWJ family emoji, without any space or punctuation.
    const accents = "é".repeat(300);
    expect(whole(accents).length).toBeGreaterThan(1);
    const family = "\u{1F468}‍\u{1F469}‍\u{1F467}".repeat(200);
    expect(whole(family).length).toBeGreaterThan(1);
    for (const p of splitSpeech(family, LIMITS)) {
      expect(p.startsWith("‍")).toBe(false);
      expect(p.endsWith("‍")).toBe(false);
    }
    whole(`  ${LONG}\n\n  ${glued}  `);
    whole(SENTENCES.join("\n\n\n"));
  });
});

// ---------------------------------------------------------------- review round 2 (#251)

describe("speech_generate: review round 2 regressions (#251)", () => {
  it("P2 (r3 re-plan): midnight right after the up-front check — every row is written for the start day, checked once", async () => {
    const before = Date.parse("2026-11-25T14:59:59.999Z");
    const after = before + 1;
    let clock = before;
    const t = await start({ settings: { dailyCostLimitUsd: 0.05 }, now: () => clock });
    const budget = t.app.media!.budget;
    const check = budget.allowsMicros.bind(budget);
    let checks = 0;
    vi.spyOn(budget, "allowsMicros").mockImplementation((u, m, at) => {
      const r = check(u, m, at);
      checks++;
      clock = after;
      return r;
    });
    const r = await t.speak({ text: LONG });
    expect(r.ok).toBe(true);
    expect(checks).toBe(1);
    expect(t.rows()).toHaveLength(splitSpeech(LONG, LIMITS).length);
    expect(t.rows().every((x) => x.created_at === before && x.cost_usd === PIECE_COST)).toBe(true);
  });

  it("P2 (r3 re-plan): an image call checked just before midnight counts for that day too", async () => {
    const before = Date.parse("2026-11-25T14:59:59.999Z");
    const after = before + 1;
    let clock = before;
    const t = await start({ now: () => clock });
    const s = settingsWith();
    s.kinds.image = { enabled: true, model: "fixture/image-one" };
    t.app.media!.settings.set(s);
    const budget = t.app.media!.budget;
    const allows = budget.allows.bind(budget);
    vi.spyOn(budget, "allows").mockImplementation((u, m, at) => {
      const r = allows(u, m, at);
      clock = after;
      return r;
    });
    expect((await t.app.media!.tools.run("image", t.scope, { prompt: "고양이" })).ok).toBe(true);
    expect(t.rows()).toEqual([expect.objectContaining({ created_at: before, cost_usd: 0.04 })]);
  });
  it("P3: a run revoked, given a token again and watched again keeps its new watcher when the old call ends", () => {
    let clock = 1_000;
    const tokens = new McpTokens(() => clock);
    const scope = { userId: "u1", conversationId: "c1", runId: "r1" };
    tokens.issue(scope);
    const first = vi.fn();
    const unsubFirst = tokens.onRevoke("r1", first);
    tokens.revokeRun("r1");
    expect(first).toHaveBeenCalledTimes(1);
    // The same run gets a token again; a new call watches it; then the old call ends (its unsubscribe runs last).
    tokens.issue(scope);
    const second = vi.fn();
    const unsubSecond = tokens.onRevoke("r1", second);
    expect(second).not.toHaveBeenCalled();
    unsubFirst();
    tokens.revokeRun("r1");
    expect(second).toHaveBeenCalledTimes(1);
    unsubSecond();
    // And the other order: the new call ends first, the old one after — nothing left behind, nothing thrown.
    tokens.issue(scope);
    const third = vi.fn();
    const unsubThird = tokens.onRevoke("r1", third);
    unsubThird();
    unsubFirst();
    tokens.revokeRun("r1");
    expect(third).not.toHaveBeenCalled();
    clock += 1;
  });

  it("P3: a piece not sent yet is no request in the usage records; it becomes one when sent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const t = await start({
      answer: async (input, n) => {
        if (n === 0) await gate;
        return fakeMp3(speechSeconds(input, LIMITS.typical));
      },
    });
    const pieces = splitSpeech(LONG, LIMITS);
    const counts = () =>
      (
        t.db.$client
          .prepare("SELECT request_count FROM usage_records WHERE purpose = 'media' ORDER BY id")
          .all() as { request_count: number }[]
      ).map((x) => x.request_count);
    const call = t.speak({ text: LONG });
    await vi.waitFor(() => expect(t.posts).toHaveLength(1));
    expect(counts()).toEqual([1, ...pieces.slice(1).map(() => 0)]);
    // Still counted as pending (their bounds hold the budget).
    expect(t.app.media!.budget.remaining(t.f.users.owner.id).pendingUsd).toBeGreaterThan(0);
    release();
    expect((await call).ok).toBe(true);
    expect(counts()).toEqual(pieces.map(() => 1));
  });

  it("P3: addresses, dotted initials and titles are not sentence ends — not even on a piece boundary", () => {
    const sentences = [
      "Dr. Smith went to the U.S. Army base today.",
      "He visited the U.S.A. office after lunch.",
      "He read https://www.Example.COM/path at home.",
      "Then he wrote to mr.Kim@Example.COM again.",
      "Later he met Prof. Lee and Mrs. Park there.",
    ];
    const text = sentences.join(" ");
    // A target each sentence fits and no two do: every sentence end is a piece boundary, and nothing else is.
    const target = Math.max(...sentences.map((x) => speechSeconds(x, LIMITS.slow))) + 0.1;
    for (let i = 1; i < sentences.length; i++)
      expect(speechSeconds(`${sentences[i - 1]} ${sentences[i]}`, LIMITS.slow)).toBeGreaterThan(target);
    expect(splitSpeech(text, LIMITS, target)).toEqual(sentences);
    // Without spaces too: the URL's own periods and initials are not cut.
    const glued = "He read https://www.Example.COM/path.Then the U.S.A.Army came.";
    for (const p of splitSpeech(glued, LIMITS, 3)) {
      expect(p.endsWith("www.")).toBe(false);
      expect(p.endsWith("Example.")).toBe(false);
      expect(p.endsWith("U.S.")).toBe(false);
    }
    // A real sentence end typed without a space still is one.
    expect(splitSpans("오늘은 정말 맑고 좋았어요.Then we all went home.", LIMITS, 3).length).toBeGreaterThan(
      1,
    );
  });
});

// ---------------------------------------------------------------- review round 3 (#251)

describe("speech_generate: review round 3 regressions (#251)", () => {
  it("P3: a sentence end before a URL that starts after a space or a line break is still a sentence end", () => {
    const first = "The work on the new site was finished.";
    for (const gap of [" ", "\n", "\n\n"]) {
      const second = "https://example.com/path is where it lives now.";
      const text = `${first}${gap}${second}`;
      const target = Math.max(speechSeconds(first, LIMITS.slow), speechSeconds(second, LIMITS.slow)) + 0.1;
      expect(speechSeconds(text, LIMITS.slow)).toBeGreaterThan(target);
      expect(splitSpeech(text, LIMITS, target)).toEqual([first, second]);
    }
    // The URL's own periods and slashes still stay together.
    const own = "Read https://www.Example.COM/path today.";
    expect(splitSpeech(`${own} ${own}`, LIMITS, speechSeconds(own, LIMITS.slow) + 0.1)).toEqual([own, own]);
  });

  it("P3: one grapheme cluster longer than a piece is refused before anything is asked", async () => {
    // 1,300 Hangul leading jamo (U+1100) form a single grapheme cluster: no cut can bring it under the target.
    const blob = "\u1100".repeat(1300);
    expect([...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(blob)]).toHaveLength(1);
    const t = await start({ split: SPEECH_SPLIT });
    const r = await t.speak({ text: `안녕하세요. ${blob}` });
    expect(r).toMatchObject({ ok: false, code: "media_too_long" });
    expect(!r.ok && r.hint).toMatch(/나눌 수 없을 만큼 긴 한 글자/);
    expect(t.urls).toEqual([]);
    expect(t.rows()).toEqual([]);
  });

  for (const which of ["usage", "media"] as const)
    it(`P3: one media clock (only ${which}.now given): reservation, updates and the settler's backoff agree`, async () => {
      // A week ago: a clock apart from the real one, given on one side only.
      let clock = Date.now() - 7 * 24 * 3600_000;
      let record = false;
      const inner = fixtureOpenRouterFetch();
      const dataDir = path.join(tmp(), "data");
      const lookups: string[] = [];
      const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (init?.method === "POST" && u === OPENROUTER_SPEECH_URL)
          return new Response(new Uint8Array(silentMp3()), {
            headers: { "content-type": "audio/mpeg", "x-generation-id": "gen-clock-0001" },
          });
        if (u.includes("/generation?id=gen-clock-0001")) {
          lookups.push(u);
          return record
            ? Response.json({ data: { id: "gen-clock-0001", total_cost: PIECE_COST } })
            : Response.json({ error: { code: 404 } }, { status: 404 });
        }
        return inner(url, init);
      }) as typeof fetch;
      const registry = new RuntimeRegistry();
      registry.register(new FakeRuntime({ runTools: true }));
      const db = createTestDb();
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
          ...(which === "usage" ? { usage: { now: () => clock } } : {}),
          media: {
            fetchImpl,
            sleep: async () => {},
            speechAudio: () => fixtureSpeechAudio(dataDir),
            ...(which === "media" ? { now: () => clock } : {}),
          },
        },
      );
      closers.push(() => app.close());
      const f = await createFamily(app);
      app.media!.settings.set(settingsWith());
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
      const runId = (res.json() as { run: Run }).run.id;
      await vi.waitFor(() => expect(app.runs!.get(runId)!.endedAt).not.toBeNull());
      db.$client.prepare("UPDATE runs SET ended_at = NULL WHERE id = ?").run(runId);
      const scope = { userId: f.users.owner.id, conversationId: conv.id, runId };
      expect((await app.media!.tools.run("speech", scope, { text: "안녕하세요." })).ok).toBe(true);
      const row = () =>
        db.$client
          .prepare(
            "SELECT created_at, updated_at, media_settlement, cost_usd FROM usage_records WHERE purpose = 'media'",
          )
          .get() as {
          created_at: number;
          updated_at: number;
          media_settlement: string;
          cost_usd: number | null;
        };
      // Answered without a cost: waits for it, on the injected clock.
      expect(row()).toMatchObject({
        created_at: clock,
        updated_at: clock,
        media_settlement: "awaiting_cost",
      });
      const tried = lookups.length;
      // Before the backoff (1 min) nothing is looked up; the row is not given up as "too old" either.
      clock += 30_000;
      await app.media!.settler.runOnce();
      expect(lookups).toHaveLength(tried);
      expect(row().media_settlement).toBe("awaiting_cost");
      // After it: looked up and settled.
      record = true;
      clock += 31_000;
      await app.media!.settler.runOnce();
      expect(lookups).toHaveLength(tried + 1);
      expect(row()).toMatchObject({ media_settlement: "settled", cost_usd: PIECE_COST });
    });
});

// ---------------------------------------------------------------- review round 4 (#251)

/** One MPEG-1 Layer III frame header (44.1 kHz, joint stereo) at this bit-rate index, padded to its length. */
function mp3Frame(bitrateIndex: number): Buffer {
  const kbps = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320][bitrateIndex]!;
  const frame = Buffer.alloc(Math.floor((144 * kbps * 1000) / 44100));
  frame.set([0xff, 0xfb, (bitrateIndex << 4) | 0, 0x64]);
  return frame;
}

/** A VBR MP3 without a Xing/Info length header: a few dear frames first, then many cheap ones. */
function vbrWithoutHeader(seconds: number): Buffer {
  const frames = Math.ceil((seconds * 44100) / 1152);
  return Buffer.concat(Array.from({ length: frames }, (_, i) => mp3Frame(i < 20 ? 14 : 1)));
}

describe("speech_generate: review round 4 regressions (#251)", () => {
  it("P2: the scripted decoder walks every frame at its own rate (VBR)", () => {
    const vbr = vbrWithoutHeader(14.6);
    const frames = fixtureMp3Frames(vbr);
    expect(frames.reduce((a, f) => a + f.samples, 0) / 44100).toBeCloseTo(14.6, 1);
  });

  it("P2: a header-less VBR piece near the provider's mark is caught (measured by frames) and re-split", async () => {
    const pieces = splitSpeech(LONG, LIMITS);
    const again = resplitSpeech(pieces[0]!, LIMITS);
    // Its typical-rate estimate is under 10 s; a size-based estimate of this file would be far shorter than 14.6 s.
    const t = await start({
      audio: "fixture",
      answer: (input, n) => {
        if (n === 0) return vbrWithoutHeader(14.6);
        const sec = speechSeconds(input, LIMITS.typical);
        return Buffer.concat(Array.from({ length: Math.ceil((sec * 44100) / 1152) }, () => mp3Frame(9)));
      },
    });
    const r = await t.speak({ text: LONG });
    expect(r.ok).toBe(true);
    expect(t.posts.map((p) => p.input)).toEqual([pieces[0], ...again, ...pieces.slice(1)]);
  });

  it("P3: a paragraph that ends with an address is still a paragraph — never cut inside the address", () => {
    const first = "All the notes for today are on our new page at https://example.com.";
    const second = "Tomorrow we will meet again at the library and read the next chapter together.";
    for (const gap of ["\n\n", "\n", "\n \n  "]) {
      const text = `${first}${gap}${second}`;
      const target = Math.max(speechSeconds(first, LIMITS.slow), speechSeconds(second, LIMITS.slow)) + 0.1;
      expect(speechSeconds(text, LIMITS.slow)).toBeGreaterThan(target);
      const pieces = splitSpeech(text, LIMITS, target);
      expect(pieces).toEqual([first, second]);
      expect(pieces.some((p) => p.endsWith("https:") || p.startsWith("//"))).toBe(false);
    }
  });

  it("P3: a cost corrected after midnight is checked for the day of the call (recordMedia)", async () => {
    const day1 = Date.parse("2026-11-30T14:00:00.000Z");
    const day2 = Date.parse("2026-11-30T15:30:00.000Z");
    let clock = day1;
    const t = await start({ now: () => clock });
    const checked = vi.spyOn(t.app.usage!, "checkDailyCost");
    const row = { userId: t.f.users.owner.id, conversationId: null, runId: "r1", callId: "c1", model: "m" };
    t.app.usageStore!.recordMedia({ ...row, costUsd: null });
    clock = day2;
    t.app.usageStore!.recordMedia({ ...row, costUsd: 0.04 });
    expect(checked.mock.calls.map((c) => c[0])).toEqual([day1, day1]);
  });
});

// ---------------------------------------------------------------- review rounds 5–6 re-plans (#251)

/** One MPEG-2 Layer III frame header (22.05 kHz, mono) at this bit-rate index, padded to its length. */
function mp3Frame22(bitrateIndex: number): Buffer {
  const kbps = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160][bitrateIndex]!;
  const frame = Buffer.alloc(Math.floor((72 * kbps * 1000) / 22050));
  frame.set([0xff, 0xf3, bitrateIndex << 4, 0xc4]);
  return frame;
}

/** The answers' bytes, as a fake measure would say about them. */
const answerWith = (mark: string) => (input: string) =>
  Buffer.concat([fakeMp3(speechSeconds(input, LIMITS.typical)), Buffer.from(mark, "latin1")]);

describe("speech_generate: review rounds 5–6 re-plans — one form, exact decoded length (#251)", () => {
  it("a piece that does not decode cleanly is media_audio_corrupt: no retry, no file, its cost recorded", async () => {
    const t = await start({
      answer: (input, n) =>
        n === 1 ? answerWith(CORRUPT)(input) : fakeMp3(speechSeconds(input, LIMITS.typical)),
    });
    const r = await t.speak({ text: LONG });
    expect(r).toMatchObject({ ok: false, code: "media_audio_corrupt" });
    expect(!r.ok && r.hint).toMatch(/손상/);
    expect(t.posts).toHaveLength(2);
    expect(t.files()).toEqual([]);
    expect(t.rows()).toHaveLength(2);
    expect(t.rows().every((x) => x.cost_usd === PIECE_COST)).toBe(true);
    expect(t.app.media!.budget.remaining(t.f.users.owner.id).pendingUsd).toBe(0);
    expect(t.scratch()).toEqual([]);
  });

  for (const [what, first, code, hint] of [
    ["another form (MP2, a rate change)", answerWith(UNSUPPORTED), "media_audio_unsupported", /형식/],
    ["an abnormally long answer", () => fakeMp3(700), "media_audio_unsupported", /비정상적으로 길어/],
    ["a measurement that could not run", answerWith(MEASURE_FAILED), "media_measure_failed", /확인하지 못해/],
  ] as const)
    it(`${what}: ${code}, no retry, no file, its cost recorded`, async () => {
      const t = await start({ answer: (input, n) => (n === 0 ? first(input) : fakeMp3(1)) });
      const r = await t.speak({ text: LONG });
      expect(r).toMatchObject({ ok: false, code });
      expect(!r.ok && r.hint).toMatch(hint);
      expect(t.posts).toHaveLength(1);
      expect(t.files()).toEqual([]);
      expect(t.rows()).toEqual([expect.objectContaining({ cost_usd: PIECE_COST })]);
    });

  it("every piece of a call in one form: a second piece at another rate is media_audio_unsupported", async () => {
    const t = await start({
      answer: (input, n) =>
        n === 1 ? answerWith("RATE=22050;")(input) : fakeMp3(speechSeconds(input, LIMITS.typical)),
    });
    expect(await t.speak({ text: LONG })).toMatchObject({ ok: false, code: "media_audio_unsupported" });
    expect(t.posts).toHaveLength(2);
    expect(t.files()).toEqual([]);
  });

  it("the decoder's report judged structurally: one mp3 audio stream, one rate and channel count, samples summed", () => {
    const tb = "1/14112000";
    // A frame at `rate`: its duration in the time base for `n` samples.
    const frame = (n: number, rate: number, channels = 1) => ({
      stream_index: 0,
      channels,
      nb_samples: n,
      duration: (n * 14112000) / rate,
    });
    const report = (o: { streams?: unknown[]; frames?: unknown[] }) =>
      JSON.stringify({
        streams: o.streams ?? [
          { index: 0, codec_type: "audio", codec_name: "mp3", sample_rate: "44100", time_base: tb },
        ],
        frames: o.frames ?? [frame(47, 44100), frame(1152, 44100), frame(889, 44100)],
      });
    // The decoder's trimmed first and last frames count as they are: 47 + 1152 + 889.
    expect(judgeProbe(report({}))).toEqual({ ok: true, samples: 2088, sampleRate: 44100, channels: 1 });
    // An attached picture beside the audio is fine; its frame is not counted.
    expect(
      judgeProbe(
        report({
          streams: [
            { index: 0, codec_type: "audio", codec_name: "mp3", sample_rate: "44100", time_base: tb },
            { index: 1, codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } },
          ],
          frames: [frame(1152, 44100), { stream_index: 1 }],
        }),
      ),
    ).toMatchObject({ ok: true, samples: 1152 });
    // A rate change inside (frames at 8 kHz in a stream that says 48 kHz), a channel change: unsupported.
    const mixed = (sr: string) => [
      { index: 0, codec_type: "audio", codec_name: "mp3", sample_rate: sr, time_base: tb },
    ];
    expect(
      judgeProbe(report({ streams: mixed("48000"), frames: [frame(576, 8000), frame(1152, 48000)] })),
    ).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(judgeProbe(report({ frames: [frame(1152, 44100, 2), frame(1152, 44100, 1)] }))).toEqual({
      ok: false,
      reason: "unsupported",
    });
    // Another codec (MP2, WAV's PCM), two audio streams, a real video stream: unsupported.
    for (const streams of [
      [{ index: 0, codec_type: "audio", codec_name: "mp2", sample_rate: "44100", time_base: tb }],
      [
        {
          index: 0,
          codec_type: "audio",
          codec_name: "pcm_s16le",
          sample_rate: "44100",
          time_base: "1/44100",
        },
      ],
      [
        { index: 0, codec_type: "audio", codec_name: "mp3", sample_rate: "44100", time_base: tb },
        { index: 1, codec_type: "audio", codec_name: "mp3", sample_rate: "44100", time_base: tb },
      ],
      [
        { index: 0, codec_type: "audio", codec_name: "mp3", sample_rate: "44100", time_base: tb },
        { index: 1, codec_type: "video", codec_name: "h264", disposition: { attached_pic: 0 } },
      ],
      [],
    ])
      expect(judgeProbe(report({ streams }))).toEqual({ ok: false, reason: "unsupported" });
    // A report that is not the structure (garbage, cut off, a field missing or of another type): not measured.
    for (const bad of [
      "garbage",
      report({}).slice(0, 40),
      report({ frames: [{ stream_index: 0, channels: 1, duration: 368640 }] }),
      report({ frames: [{ stream_index: 0, channels: 1, nb_samples: "N/A", duration: 368640 }] }),
    ])
      expect(judgeProbe(bad)).toEqual({ ok: false, reason: "failed" });
  });

  it("the scripted decoder (FAKE_RUNTIME) has the real one's semantics", async () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "in"));
    fs.mkdirSync(path.join(dir, "out"));
    const audio = fixtureSpeechAudio(dir);
    const write = (name: string, b: Buffer) => {
      const f = path.join(dir, "in", name);
      fs.writeFileSync(f, b);
      return f;
    };
    const m = { maxSeconds: 600 };
    expect(await audio.measure(write("piece-000.mp3", silentMp3()), m)).toEqual({
      ok: true,
      samples: 20 * 1152,
      seconds: (20 * 1152) / 44100,
      sampleRate: 44100,
      channels: 2,
    });
    const mixed = Buffer.concat([mp3Frame22(8), mp3Frame(9)]);
    expect(await audio.measure(write("piece-001.mp3", mixed), m)).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(await audio.measure(write("piece-002.mp3", Buffer.from("x")), m)).toEqual({
      ok: false,
      reason: "unsupported",
    });
    expect(
      await audio.measure(
        write("piece-003.mp3", Buffer.concat([silentMp3(), Buffer.from(FIXTURE_CORRUPT_MARK)])),
        m,
      ),
    ).toEqual({ ok: false, reason: "corrupt" });
    expect(await audio.measure(write("piece-004.mp3", silentMp3()), { maxSeconds: 0.1 })).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  it("integrity from the exit status only: not run, limits, signals, 71/126/127/244/255 are failed; others corrupt", async () => {
    for (const r of [
      undefined,
      { code: 71 },
      { code: 126 },
      { code: 127 },
      { code: 244 },
      { code: 255 },
      { code: null, signal: "SIGTERM" as const },
      { code: 0, killed: "timeout" },
      { code: 0, killed: "output" },
    ])
      expect(decodeVerdict(r)).toBe("failed");
    expect(decodeVerdict({ code: 183 })).toBe("corrupt");
    expect(decodeVerdict({ code: 1 })).toBe("corrupt");
    expect(decodeVerdict({ code: 0 })).toBe("ok");
    // Through the real measuring path with a scripted runner (ffmpeg and ffprobe files of our own, never run).
    const bin = path.join(tmp(), "ff", "bin");
    fs.mkdirSync(bin, { recursive: true });
    for (const n of ["ffmpeg", "ffprobe"])
      fs.writeFileSync(path.join(bin, n), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    const tb = "1/14112000";
    const good = JSON.stringify({
      streams: [{ index: 0, codec_type: "audio", codec_name: "mp3", sample_rate: "8000", time_base: tb }],
      frames: [{ stream_index: 0, channels: 1, nb_samples: 576, duration: 1016064 }],
    });
    type R = {
      code: number | null;
      signal?: NodeJS.Signals | null;
      stdout?: string;
      stderr?: string;
      killed?: null | "timeout";
    };
    const scripted = (decode: R, probe: R = { code: 0, stdout: good }) =>
      sandboxedSpeechAudio({
        dataDir: tmp(),
        platform: "darwin",
        ffmpegPath: path.join(bin, "ffmpeg"),
        run: async (o) => {
          const r = o.command.endsWith("ffprobe") ? probe : decode;
          return { stdout: "", stderr: "", killed: null, signal: null, ...r };
        },
      })!;
    const data = tmp();
    const w = makeSpeechWorkdir(data);
    const file = path.join(w, "in", "piece-000.mp3");
    fs.writeFileSync(file, Buffer.from("anything — the scripted programs decide"));
    const M = { maxSeconds: 600 };
    expect(await scripted({ code: 0 }).measure(file, M)).toEqual({
      ok: true,
      samples: 576,
      seconds: 0.072,
      sampleRate: 8000,
      channels: 1,
    });
    // A log that says "[error]" or "exec" (a title, say) changes nothing: only the exit status counts.
    expect(
      (await scripted({ code: 0, stderr: "title : Status [error] Executive summary" }).measure(file, M)).ok,
    ).toBe(true);
    expect(await scripted({ code: 183, stderr: "title : Executive summary" }).measure(file, M)).toEqual({
      ok: false,
      reason: "corrupt",
    });
    for (const decode of [
      { code: 244 },
      { code: 255 },
      { code: 71 },
      { code: null, signal: "SIGTERM" as const },
    ])
      expect(await scripted(decode).measure(file, M)).toEqual({ ok: false, reason: "failed" });
    // ffprobe's report: cut off by its output bound, garbage, its own failure — not measured.
    for (const probe of [
      { code: 0, stdout: good, killed: "timeout" as const },
      { code: 0, stdout: "not json" },
      { code: 1, stdout: "" },
    ])
      expect(await scripted({ code: 0 }, probe).measure(file, M)).toEqual({ ok: false, reason: "failed" });
    // The 600 s cap on decoded samples.
    const long = (n: number) =>
      JSON.stringify({
        streams: [
          { index: 0, codec_type: "audio", codec_name: "mp3", sample_rate: "8000", time_base: "1/8000" },
        ],
        frames: [{ stream_index: 0, channels: 1, nb_samples: n, duration: n }],
      });
    expect((await scripted({ code: 0 }, { code: 0, stdout: long(4_795_905) }).measure(file, M)).ok).toBe(
      true,
    );
    expect(await scripted({ code: 0 }, { code: 0, stdout: long(600 * 8000 + 1) }).measure(file, M)).toEqual({
      ok: false,
      reason: "too_long",
    });
    removeSpeechWorkdir(w);
  });

  it("the first answer measured fixes the call's form — also when it was cut: a retry at another rate is refused", async () => {
    const t = await start({
      answer: (input, n) =>
        n === 0
          ? Buffer.concat([fakeMp3(14.5), Buffer.from("RATE=22050;", "latin1")])
          : fakeMp3(speechSeconds(input, LIMITS.typical)),
    });
    expect(await t.speak({ text: LONG })).toMatchObject({ ok: false, code: "media_audio_unsupported" });
    expect(t.posts).toHaveLength(2);
    expect(t.files()).toEqual([]);
    expect(t.rows().every((x) => x.cost_usd === PIECE_COST)).toBe(true);
  });

  it("a paid answer that is not MP3 (WAV) is media_audio_unsupported with the cost hint, not a model error", async () => {
    const wav = Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVEfmt ", "latin1"), Buffer.alloc(2000)]);
    const t = await start({ answer: () => wav });
    const r = await t.speak({ text: SENTENCES[0]! });
    expect(r).toMatchObject({ ok: false, code: "media_audio_unsupported" });
    expect(!r.ok && r.hint).toMatch(/비용은 기록/);
    expect(t.rows()).toEqual([expect.objectContaining({ cost_usd: PIECE_COST })]);
  });

  it("a joined result that cannot be measured is media_measure_failed (the cost hint), a gross loss media_failed", async () => {
    let dataDir = "";
    const fake = fakeAudio(() => dataDir);
    let joins = 0;
    const failing: SpeechAudio = {
      workdir: () => makeSpeechWorkdir(dataDir),
      async measure(file, m) {
        return path.basename(path.dirname(file)) === "out"
          ? { ok: false, reason: "failed" }
          : fake.audio.measure(file, m);
      },
      async join(job) {
        joins++;
        return fake.audio.join(job);
      },
    };
    const t = await start({ audio: failing });
    dataDir = t.dataDir;
    const r = await t.speak({ text: LONG });
    expect(r).toMatchObject({ ok: false, code: "media_measure_failed" });
    expect(!r.ok && r.hint).toMatch(/비용은 기록/);
    expect(joins).toBe(1);
  });

  it("estimates and limits compare in whole microseconds: 20 s exactly is 20 s, whatever the classes", () => {
    const text = "a".repeat(300);
    expect(speechSeconds(text, SPEECH_SPLIT.typical)).toBe(20);
    expect(looksCut(text, 1.04)).toBe(true);
    // 52 Hangul + 39 digits + 50 other characters: 8 + 8.67 + 3.33 = exactly 20 s at the typical rate.
    const mixed = "가".repeat(52) + "1".repeat(39) + "a".repeat(50);
    expect(speechSeconds(mixed, SPEECH_SPLIT.typical)).toBe(20);
    expect(looksCut(mixed, 1)).toBe(true);
    expect(looksCut(mixed, 10)).toBe(false);
    expect(looksCut(mixed, 9.999999)).toBe(true);
  });
});

// ---------------------------------------------------------------- the real ffmpeg (macOS with ffmpeg)

const realTools =
  process.platform === "darwin" ? speechTools(process.env.TEST_AUDIO_FFMPEG, "/nonexistent-data") : undefined;
const realIt = realTools ? it : it.skip;

/** An MP3 made here by the unsandboxed ffmpeg (test input only); its bytes. */
function encode(args: string[]): Buffer {
  const out = path.join(tmp(), "x.mp3");
  const r = spawnSync(realTools!.ffmpeg.exe, ["-nostdin", "-v", "error", ...args, out]);
  expect(r.status).toBe(0);
  return fs.readFileSync(out);
}

/** A real MP3 tone of `seconds` (22.05 kHz mono unless asked otherwise). */
const tones = new Map<string, Buffer>();
function tone(seconds: number, rate = 22050, freq = 440): Buffer {
  const key = `${seconds.toFixed(2)}@${rate}@${freq}`;
  const had = tones.get(key);
  if (had) return had;
  const b = encode([
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=${freq}:duration=${seconds.toFixed(3)}:sample_rate=${rate}`,
    "-ac",
    "1",
    "-c:a",
    "libmp3lame",
    "-b:a",
    "32k",
  ]);
  tones.set(key, b);
  return b;
}

/** The frames' side information scrambled from frame `from` on (headers intact): the decoder errors there. */
function scramble(b: Buffer, from: number, to = Infinity): Buffer {
  const out = Buffer.from(b);
  fixtureMp3Frames(out).forEach((f, i) => {
    if (i >= from && i < to)
      for (let k = f.start + 4; k < Math.min(f.end, f.start + 40); k++) out[k] = (k * 131 + 7) & 0xff;
  });
  return out;
}

/** A sandboxed ffmpeg, made when first used (the data folder is known then). */
function realAudio(dataDir: () => string): SpeechAudio {
  let made: SpeechAudio | undefined;
  const real = () =>
    (made ??= sandboxedSpeechAudio({
      dataDir: dataDir(),
      platform: "darwin",
      ffmpegPath: process.env.TEST_AUDIO_FFMPEG,
    })!);
  return {
    workdir: () => real().workdir(),
    measure: (f, m) => real().measure(f, m),
    join: (j, sg) => real().join(j, sg),
  };
}

describe("speech_generate: the real sandboxed ffmpeg (#248, macOS)", () => {
  /** A working folder of a real `SpeechAudio`, and a way to put a file into its `in/`. */
  const bench = () => {
    const data = tmp();
    const audio = realAudio(() => data);
    const w = audio.workdir();
    let n = 0;
    const put = (b: Buffer) => {
      const f = path.join(w, "in", `piece-${String(n++).padStart(3, "0")}.mp3`);
      fs.writeFileSync(f, b);
      return f;
    };
    closers.push(() => removeSpeechWorkdir(w));
    return { audio, w, put };
  };
  const M = { maxSeconds: 600 };

  realIt(
    "exact lengths at the file's own rate: CBR with ID3 and Xing/Info, a 20 ms file, a header-less VBR",
    async () => {
      const { audio, put } = bench();
      const cbr = encode([
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=5:sample_rate=44100",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "128k",
      ]);
      expect(cbr.toString("latin1", 0, 3)).toBe("ID3");
      expect(await audio.measure(put(cbr), M)).toMatchObject({
        ok: true,
        samples: 220500,
        sampleRate: 44100,
        seconds: 5,
      });
      const short = encode([
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=0.02:sample_rate=44100",
        "-c:a",
        "libmp3lame",
      ]);
      expect(await audio.measure(put(short), M)).toMatchObject({ ok: true, samples: 882, seconds: 0.02 });
      const vbr = encode([
        "-f",
        "lavfi",
        "-i",
        "anoisesrc=d=1:c=white:a=0.9:r=44100",
        "-f",
        "lavfi",
        "-i",
        "anullsrc=r=44100:cl=mono:d=13.6",
        "-filter_complex",
        "[0]aformat=channel_layouts=mono[a];[a][1]concat=n=2:v=0:a=1",
        "-c:a",
        "libmp3lame",
        "-q:a",
        "2",
        "-write_xing",
        "0",
      ]);
      const v = await audio.measure(put(vbr), M);
      expect(v.ok && v.seconds).toBeCloseTo(14.6, 1);
    },
  );

  realIt("another form is unsupported: alternating sample rates, MP2", async () => {
    const { audio, put } = bench();
    const at = (rate: number, d: number) =>
      encode([
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=300:duration=${d}:sample_rate=${rate}`,
        "-ac",
        "1",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "32k",
        "-write_xing",
        "0",
        "-id3v2_version",
        "0",
      ]);
    const alternating = Buffer.concat([at(8000, 2), at(48000, 1), at(8000, 2), at(48000, 1)]);
    expect(await audio.measure(put(alternating), M)).toEqual({ ok: false, reason: "unsupported" });
    const mp2 = encode([
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=300:duration=3:sample_rate=44100",
      "-c:a",
      "mp2",
      "-f",
      "mp2",
    ]);
    expect(await audio.measure(put(mp2), M)).toEqual({ ok: false, reason: "unsupported" });
  });

  realIt(
    "corruption is found to the file's end (a good control first); over the cap is too_long",
    async () => {
      const { audio, put } = bench();
      const good = tone(60, 8000);
      // The control: this environment decodes the clean file.
      expect(await audio.measure(put(good), M)).toMatchObject({ ok: true });
      // Corrupt only in its last seconds.
      const frames = fixtureMp3Frames(good).length;
      expect(await audio.measure(put(scramble(good, frames - 40)), M)).toEqual({
        ok: false,
        reason: "corrupt",
      });
      // Over the cap (decoded samples): too_long.
      expect(await audio.measure(put(good), { maxSeconds: 30 })).toEqual({ ok: false, reason: "too_long" });
    },
  );

  realIt(
    "through the tool: a corrupt piece ends the call (no retry); a rate change is unsupported",
    async () => {
      let dataDir = "";
      const good = tone(8);
      // The control in the same environment: a clean answer goes through.
      const ok = await start({ audio: realAudio(() => dataDir), answer: () => good });
      dataDir = ok.dataDir;
      expect((await ok.speak({ text: SENTENCES[0]! })).ok).toBe(true);
      let dir2 = "";
      const t = await start({ audio: realAudio(() => dir2), answer: () => scramble(good, 30, 150) });
      dir2 = t.dataDir;
      expect(await t.speak({ text: LONG })).toMatchObject({ ok: false, code: "media_audio_corrupt" });
      expect(t.posts).toHaveLength(1);
      expect(t.files()).toEqual([]);
      expect(t.rows()).toEqual([expect.objectContaining({ cost_usd: PIECE_COST })]);
      let dir3 = "";
      const t3 = await start({
        audio: realAudio(() => dir3),
        answer: (input, n) =>
          tone(Math.round(speechSeconds(input, LIMITS.typical) * 10) / 10, n === 0 ? 22050 : 24000),
      });
      dir3 = t3.dataDir;
      expect(await t3.speak({ text: LONG })).toMatchObject({ ok: false, code: "media_audio_unsupported" });
      expect(t3.posts).toHaveLength(2);
    },
  );

  realIt(
    "joined from PCM: the exact summed length, and the last piece's own tone intact to its end",
    async () => {
      let dataDir = "";
      const pieces = splitSpeech(LONG, LIMITS);
      const secs = pieces.map((p) => Math.round(speechSeconds(p, LIMITS.typical) * 10) / 10);
      const t = await start({
        audio: realAudio(() => dataDir),
        // The last piece at 1 kHz, the others at 440 Hz.
        answer: (_input, n) => tone(secs[n]!, 22050, n === pieces.length - 1 ? 1000 : 440),
      });
      dataDir = t.dataDir;
      const r = await t.speak({ text: LONG });
      expect(r.ok).toBe(true);
      const out = (r as { output: { durationSeconds: number; chunks: number; fileId: string } }).output;
      const want = secs.reduce((a, b) => a + b, 0);
      expect(out.chunks).toBe(pieces.length);
      expect(Math.abs(out.durationSeconds - want)).toBeLessThan(0.1);
      // Decode the stored file and count the zero crossings of its last piece's span: 1 kHz all the way.
      const row = t.app.files!.get(out.fileId)!;
      const fd = t.app.files!.open(row)!;
      const buf = Buffer.alloc(row.bytes);
      fs.readSync(fd, buf, 0, row.bytes, 0);
      fs.closeSync(fd);
      const mp3 = path.join(tmp(), "joined.mp3");
      fs.writeFileSync(mp3, buf);
      const pcm = spawnSync(
        realTools!.ffmpeg.exe,
        ["-nostdin", "-v", "error", "-i", mp3, "-ac", "1", "-f", "s16le", "-c:a", "pcm_s16le", "-"],
        {
          maxBuffer: 64 * 1024 * 1024,
        },
      ).stdout as Buffer;
      const rate = 22050;
      const samples = pcm.length / 2;
      const last = secs.at(-1)!;
      // The last piece's span, away from its edges (the encoder's delay and padding).
      const from = Math.round((want - last + 0.1) * rate);
      const to = Math.round((want - 0.1) * rate);
      expect(to).toBeLessThanOrEqual(samples);
      let crossings = 0;
      for (let i = from + 1; i < to; i++)
        if (pcm.readInt16LE((i - 1) * 2) < 0 !== pcm.readInt16LE(i * 2) < 0) crossings++;
      const hz = crossings / 2 / ((to - from) / rate);
      expect(hz).toBeGreaterThan(980);
      expect(hz).toBeLessThan(1020);
      expect(t.scratch()).toEqual([]);
    },
  );

  realIt("a cut at the mark (decoded length) is caught and re-split; a header-less VBR one too", async () => {
    let dataDir = "";
    const vbr = encode([
      "-f",
      "lavfi",
      "-i",
      "anoisesrc=d=1:c=white:a=0.9:r=22050",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=22050:cl=mono:d=13.6",
      "-filter_complex",
      "[0]aformat=channel_layouts=mono[a];[a][1]concat=n=2:v=0:a=1",
      "-c:a",
      "libmp3lame",
      "-q:a",
      "2",
      "-write_xing",
      "0",
    ]);
    for (const first of [tone(14.6), vbr]) {
      const t = await start({
        audio: realAudio(() => dataDir),
        answer: (input, n) =>
          n === 0 ? first : tone(Math.round(speechSeconds(input, LIMITS.typical) * 10) / 10),
      });
      dataDir = t.dataDir;
      const pieces = splitSpeech(LONG, LIMITS);
      const again = resplitSpeech(pieces[0]!, LIMITS);
      const r = await t.speak({ text: LONG });
      expect(r.ok).toBe(true);
      expect(t.posts.map((p) => p.input)).toEqual([pieces[0], ...again, ...pieces.slice(1)]);
    }
  });

  realIt(
    "identical 8 kHz frames joined in six pieces: their decoded samples add up exactly — the join is kept",
    async () => {
      let dataDir = "";
      const unit = encode([
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=300:duration=2:sample_rate=8000",
        "-ac",
        "1",
        "-c:a",
        "libmp3lame",
        "-b:a",
        "16k",
        "-write_xing",
        "0",
        "-id3v2_version",
        "0",
      ]);
      // A text of exactly six pieces.
      const text = [LONG, SENTENCES.slice(0, 4).join(" ")].join("\n\n");
      const pieces = splitSpeech(text, LIMITS);
      expect(pieces).toHaveLength(6);
      const t = await start({
        audio: realAudio(() => dataDir),
        // Each answer: the same frames repeated to about its expected length (no length header at all).
        answer: (input) =>
          Buffer.concat(
            Array.from(
              { length: Math.max(1, Math.round(speechSeconds(input, LIMITS.typical) / 2)) },
              () => unit,
            ),
          ),
      });
      dataDir = t.dataDir;
      const r = await t.speak({ text });
      expect(r.ok).toBe(true);
      expect((r as { output: { chunks: number } }).output.chunks).toBe(6);
    },
  );

  realIt(
    "tags around the audio (APEv2, APEv2 + ID3v1) decode as the audio itself: taken, same samples",
    async () => {
      const { audio, put } = bench();
      const base = tone(3, 22050);
      const plain = await audio.measure(put(base), M);
      expect(plain.ok).toBe(true);
      // An APEv2 tag as taggers write it: a header, one item, a footer.
      const item = Buffer.concat([
        Buffer.from([5, 0, 0, 0, 0, 0, 0, 0]),
        Buffer.from("Title\0Hello", "latin1"),
      ]);
      const apeBlock = (flags: number) => {
        const f = Buffer.alloc(32);
        f.write("APETAGEX", 0, "latin1");
        f.writeUInt32LE(2000, 8);
        f.writeUInt32LE(item.length + 32, 12);
        f.writeUInt32LE(1, 16);
        f.writeUInt32LE(flags >>> 0, 20);
        return f;
      };
      const ape = Buffer.concat([apeBlock(0xa0000000), item, apeBlock(0x80000000)]);
      const id3v1 = Buffer.alloc(128);
      id3v1.write("TAGTitle", 0, "latin1");
      for (const tail of [ape, Buffer.concat([ape, id3v1])]) {
        const m = await audio.measure(put(Buffer.concat([base, tail])), M);
        expect(m).toMatchObject({ ok: true, samples: plain.ok ? plain.samples : -1 });
      }
    },
  );

  realIt(
    "599.49 s of decoded audio is taken; just over 600 s is too_long (the cap is on decoded samples)",
    async () => {
      const { audio, put } = bench();
      const at = (d: number) =>
        encode(["-f", "lavfi", "-i", `anullsrc=r=8000:cl=mono:d=${d}`, "-c:a", "libmp3lame", "-b:a", "8k"]);
      const m = await audio.measure(put(at(599.488125)), M);
      expect(m.ok && m.seconds).toBeGreaterThan(599.4);
      expect(m.ok && m.seconds).toBeLessThan(600);
      expect(await audio.measure(put(at(601)), M)).toEqual({ ok: false, reason: "too_long" });
    },
  );

  realIt(
    'metadata, short files and tags are not judged: titles with "[error]"/"exec", 2 frames + ID3v1, a leading APEv2',
    async () => {
      const { audio, put } = bench();
      for (const title of ["Status [error]", "Executive summary"]) {
        const b = encode([
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=1:sample_rate=44100",
          "-ac",
          "2",
          "-c:a",
          "libmp3lame",
          "-metadata",
          `title=${title}`,
        ]);
        expect(await audio.measure(put(b), M)).toMatchObject({ ok: true, samples: 44100 });
      }
      // Two frames (no length header), then an ID3v1 tag.
      const two = encode([
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=0.02:sample_rate=44100",
        "-c:a",
        "libmp3lame",
        "-write_xing",
        "0",
        "-id3v2_version",
        "0",
      ]);
      const id3v1 = Buffer.alloc(128);
      id3v1.write("TAGTitle", 0, "latin1");
      const twoTagged = await audio.measure(put(Buffer.concat([two, id3v1])), M);
      expect(twoTagged.ok).toBe(true);
      expect(twoTagged).toEqual(await audio.measure(put(two), M));
    },
  );

  realIt(
    "through the tool: a leading APEv2 answer is taken and stored; WAV, MP2 and a rate change are unsupported",
    async () => {
      const base = tone(3, 22050);
      const item = Buffer.concat([
        Buffer.from([5, 0, 0, 0, 0, 0, 0, 0]),
        Buffer.from("Title\0Hello", "latin1"),
      ]);
      const apeBlock = (flags: number) => {
        const f = Buffer.alloc(32);
        f.write("APETAGEX", 0, "latin1");
        f.writeUInt32LE(2000, 8);
        f.writeUInt32LE(item.length + 32, 12);
        f.writeUInt32LE(1, 16);
        f.writeUInt32LE(flags >>> 0, 20);
        return f;
      };
      const leading = Buffer.concat([apeBlock(0xa0000000), item, apeBlock(0x80000000), base]);
      let d1 = "";
      const ok = await start({ audio: realAudio(() => d1), answer: () => leading });
      d1 = ok.dataDir;
      const r = await ok.speak({ text: SENTENCES[0]! });
      expect(r.ok).toBe(true);
      expect(ok.files()).toHaveLength(1);
      const wav = encode([
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=3:sample_rate=22050",
        "-c:a",
        "pcm_s16le",
        "-f",
        "wav",
      ]);
      const mp2 = encode([
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=300:duration=3:sample_rate=44100",
        "-c:a",
        "mp2",
        "-f",
        "mp2",
      ]);
      const at = (rate: number, d: number) =>
        encode([
          "-f",
          "lavfi",
          "-i",
          `sine=frequency=300:duration=${d}:sample_rate=${rate}`,
          "-ac",
          "1",
          "-c:a",
          "libmp3lame",
          "-b:a",
          "32k",
          "-write_xing",
          "0",
          "-id3v2_version",
          "0",
        ]);
      const rateChange = Buffer.concat([at(8000, 2), at(48000, 1)]);
      for (const bad of [wav, mp2, rateChange]) {
        let d = "";
        const t = await start({ audio: realAudio(() => d), answer: () => bad });
        d = t.dataDir;
        expect(await t.speak({ text: SENTENCES[0]! })).toMatchObject({
          ok: false,
          code: "media_audio_unsupported",
        });
        expect(t.posts).toHaveLength(1);
        expect(t.files()).toEqual([]);
      }
    },
  );
});
