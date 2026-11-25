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
  fixtureSpeechAudio,
  mp3Frames,
  silentMp3,
} from "../src/media/fixture.js";
import { isMp3 } from "../src/media/generate.js";
import { OPENROUTER_SPEECH_URL } from "../src/media/openrouter.js";
import {
  joinOptions,
  makeSpeechWorkdir,
  mp3PacketSeconds,
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
      l.speechCallTimeoutMs + l.speechTimeoutMs + 2 * l.speechJoinTimeoutMs + 2 * l.speechProbeTimeoutMs,
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

  it("no ffprobe/ffmpeg on this server: nothing is made — not even a text of one piece — before anything is asked", async () => {
    const t = await start({ audio: "none" });
    expect(await t.speak({ text: LONG })).toMatchObject({ ok: false, code: "media_audio_unavailable" });
    const r = await t.speak({ text: SENTENCES[0]! });
    expect(r).toMatchObject({ ok: false, code: "media_audio_unavailable" });
    expect(!r.ok && r.hint).toMatch(/ffprobe/);
    expect(t.urls).toEqual([]);
    expect(t.rows()).toEqual([]);
    // The FAKE_RUNTIME's scripted ffprobe/ffmpeg measures the fixture's MP3 by its frames.
    const t2 = await start({ audio: "fixture" });
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
      probe: fake.audio.probe,
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
      probe: fake.audio.probe,
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
  it("P2: a length is counted from the audio frames, never the container's estimate", () => {
    // ffprobe: `-count_packets` and the packet count — no `format=duration` asked for at all.
    const o = probeOptions(
      { ffmpeg: { exe: "/opt/x/bin/ffmpeg", trusted: ["/opt/x/bin"] }, ffprobe: "/opt/x/bin/ffprobe" },
      "/d/in/piece-000.mp3",
    );
    expect(o.args).toContain("-count_packets");
    expect(o.args.join(" ")).toContain("nb_read_packets");
    expect(o.args.join(" ")).not.toContain("format=duration");
    expect(mp3PacketSeconds(11_330, 44_100)).toBeCloseTo(295.97, 2);
    expect(mp3PacketSeconds(100, 22_050)).toBeCloseTo((100 * 576) / 22_050, 6);
    // The scripted ffprobe walks every frame by its own header (VBR), and skips a leading Xing/Info frame.
    const vbr = vbrWithoutHeader(14.6);
    const f = mp3Frames(vbr)!;
    expect((f.frames.length * f.samplesPerFrame) / f.sampleRate).toBeCloseTo(14.6, 1);
    const xing = mp3Frame(9);
    xing.write("Xing", 36, "latin1");
    expect(mp3Frames(Buffer.concat([xing, vbr]))!.frames).toHaveLength(f.frames.length);
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
  realIt(
    "a header-less VBR MP3 near the mark: the real ffprobe counts its frames and the piece is re-split",
    async () => {
      // A few loud (dear) frames first, then silence (cheap ones), VBR without a Xing/Info header: ffprobe's container
      // duration estimates it far shorter than its 14.6 s.
      const vbr = (() => {
        const out = path.join(tmp(), "vbr.mp3");
        const r = spawnSync(realTools!.ffmpeg.exe, [
          "-nostdin",
          "-v",
          "error",
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
          out,
        ]);
        expect(r.status).toBe(0);
        const est = spawnSync(
          realTools!.ffprobe,
          ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out],
          {
            encoding: "utf8",
          },
        );
        // The estimate a header-based measurement would have used: well under the mark.
        expect(Number(est.stdout)).toBeLessThan(LIMITS.nearCutSeconds);
        return fs.readFileSync(out);
      })();
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
        probe: (f, sg) => real().probe(f, sg),
        join: (j, sg) => real().join(j, sg),
      };
      const t = await start({
        audio: lazy,
        answer: (input, n) =>
          n === 0 ? vbr : tone(Math.round(speechSeconds(input, LIMITS.typical) * 10) / 10),
      });
      dataDir = t.dataDir;
      const pieces = splitSpeech(LONG, LIMITS);
      const again = resplitSpeech(pieces[0]!, LIMITS);
      const r = await t.speak({ text: LONG });
      expect(r.ok).toBe(true);
      expect(t.posts.map((p) => p.input)).toEqual([pieces[0], ...again, ...pieces.slice(1)]);
    },
  );
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
