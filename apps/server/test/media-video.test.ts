import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CSRF_HEADER,
  DEFAULT_MEDIA_SETTINGS,
  FILE_LIMITS,
  type MediaSettings,
  type Run,
  type VideoJob,
} from "@agentlee/shared";
import { MEDIA_TOOLS, VIDEO_GENERATE_TOOL } from "@agentlee/mcp-tools/media";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { compose } from "../src/notifications/compose.js";
import { videoCostBound, videoPricing } from "../src/media/cost.js";
import { FIXTURE_OPENROUTER_KEY_PREFIX, fixtureMp4, fixtureOpenRouterFetch } from "../src/media/fixture.js";
import {
  MEDIA_CATALOG_URLS,
  OPENROUTER_VIDEOS_URL,
  videoPriceText,
  VIDEO_JOB_ID,
  videoContentUrl,
  videoGet,
  videoStatusUrl,
} from "../src/media/openrouter.js";
import { VideoJobs } from "../src/media/video-jobs.js";
import {
  isPlanError,
  planVideo,
  replanVideo,
  videoModelVerdict,
  videoRecordOf,
} from "../src/media/video-plan.js";
import {
  fixtureVideoProbe,
  KNOWN_GOOD_MP4,
  judgeVideoProbe,
  sandboxedVideoProbe,
  videoProbeOptions,
  type VideoProbe,
} from "../src/media/video-probe.js";
import { RuntimeRegistry } from "../src/runtime/adapter.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import { createFamily } from "./helpers/permission-matrix.js";
import crypto from "node:crypto";
import { SettingsStore } from "../src/db/settings-store.js";
import { OPENROUTER_KEY_SETTING } from "../src/media/keys.js";
import { newestJob } from "../../web/src/chat/video-card.js";

vi.setConfig({ testTimeout: 60_000 });

/**
 * 영상 생성 (#238 stage 3): `video_generate` makes a confirmation card only; the owner's approval reserves the bound
 * and submits; the engine polls, downloads, checks and stores — against a fake job server (pending → in_progress →
 * completed / failed / expired), with synthetic keys only. Never the network.
 */

const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const LOCAL = { host: "localhost:3000" };
const WRITE = { ...LOCAL, origin: "http://localhost:3000", [CSRF_HEADER]: "1" };
const KEY = `${FIXTURE_OPENROUTER_KEY_PREFIX}-synthetic-0000000000000000000000vid`;
const rid = (n: number) => `gen-vid-17894808${String(n).padStart(2, "0")}-Ab3dEf9hIjKlMnOpQrSt`;

function tmp(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-media-video-")));
  closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Veo 3.1 Fast's shape (the real catalog, 2026-11-26): sound variants, tiers, 4K. */
const VEO = {
  id: "test/veo",
  name: "Test Veo",
  supported_durations: [4, 6, 8],
  supported_resolutions: ["720p", "1080p", "4K"],
  supported_aspect_ratios: ["16:9", "9:16"],
  generate_audio: true,
  pricing_skus: {
    duration_seconds_with_audio: "0.12",
    duration_seconds_with_audio_4k: "0.30",
    duration_seconds_without_audio: "0.10",
    duration_seconds_with_audio_720p: "0.10",
    duration_seconds_without_audio_4k: "0.25",
    duration_seconds_without_audio_720p: "0.08",
  },
};
/** 8 s at 720p: the dearest SKU that may apply ($0.12/s, unsuffixed with sound) × 8 × 1.2. */
const VEO_8S_MICROS = 1_152_000;

type Req = { url: string; method: string; body: Record<string, unknown> | undefined };

/** A fake job server; every behaviour can be replaced. */
function fakeServer(
  o: {
    catalog?: () => Record<string, unknown>[];
    submit?: (body: Record<string, unknown>, n: number) => Response | Promise<Response>;
    poll?: (id: string, n: number) => Response | Promise<Response>;
    content?: (id: string) => Response | Promise<Response>;
  } = {},
) {
  const requests: Req[] = [];
  const polls = new Map<string, number>();
  let submits = 0;
  const fixture = fixtureOpenRouterFetch();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    requests.push({ url, method: init?.method ?? "GET", body });
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${KEY}`)
      return Response.json({ error: { code: 401 } }, { status: 401 });
    if (url === MEDIA_CATALOG_URLS.video) return Response.json({ data: (o.catalog ?? (() => [VEO]))() });
    if (init?.method === "POST" && url === OPENROUTER_VIDEOS_URL) {
      submits += 1;
      return o.submit
        ? o.submit(body ?? {}, submits)
        : Response.json({ id: rid(submits), status: "pending" }, { status: 202 });
    }
    const m = /^https:\/\/openrouter\.ai\/api\/v1\/videos\/([^/?]+)(\/content\?index=0)?$/.exec(url);
    if (m && !m[2]) {
      const n = (polls.get(m[1]!) ?? 0) + 1;
      polls.set(m[1]!, n);
      if (o.poll) return o.poll(m[1]!, n);
      return n === 1
        ? Response.json({ id: m[1], status: "in_progress", progress: 40 })
        : Response.json({ id: m[1], status: "completed", usage: { cost: 0.8, is_byok: false } });
    }
    if (m && m[2])
      return o.content
        ? o.content(m[1]!)
        : new Response(new Uint8Array(fixtureMp4()), { headers: { "content-type": "video/mp4" } });
    return fixture(input, init);
  }) as typeof fetch;
  return {
    fetchImpl,
    requests,
    posts: () => requests.filter((r) => r.method === "POST" && r.url === OPENROUTER_VIDEOS_URL),
  };
}

const videoOn = (more: Partial<MediaSettings> = {}): MediaSettings => {
  const s = structuredClone(DEFAULT_MEDIA_SETTINGS);
  s.kinds.video = { enabled: true, model: "test/veo" };
  return { ...s, ...more };
};

async function start(
  o: {
    server?: ReturnType<typeof fakeServer>;
    probe?: () => VideoProbe | undefined;
    engine?: boolean;
    limits?: ConstructorParameters<typeof VideoJobs>[0]["limits"];
    clock?: { t: number };
  } = {},
) {
  const dataDir = path.join(tmp(), "data");
  const registry = new RuntimeRegistry();
  registry.register(new FakeRuntime({ runTools: true }));
  const db = createTestDb();
  const server = o.server ?? fakeServer();
  const clock = o.clock;
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
      media: {
        fetchImpl: server.fetchImpl,
        sleep: async () => {},
        ...(clock ? { now: () => clock.t } : {}),
        video: {
          start: o.engine ?? true,
          probe: o.probe ?? (() => fixtureVideoProbe()),
          // The engine is driven by hand (`tick`): no timer fires on its own.
          limits: { tickMs: 3_600_000, ...o.limits },
        },
      },
    },
  );
  closers.push(() => app.close());
  await app.ready();
  const f = await createFamily(app);
  app.media!.settings.set(videoOn());
  const api = (cookie: string, method: "POST" | "GET", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { ...WRITE, cookie, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  const send = async (conversationId: string, text: string) => {
    const res = await api(f.cookies.owner, "POST", `/api/conversations/${conversationId}/messages`, { text });
    expect(res.statusCode, res.body).toBe(201);
    const runId = (res.json() as { run: Run }).run.id;
    for (let i = 0; i < 2000 && app.runs!.get(runId)!.endedAt === null; i++)
      await new Promise((r) => setTimeout(r, 10));
    return app.runs!.get(runId)!;
  };
  /** A run of the owner that is still open (the tool works only for an open run). */
  const scopeOf = async (conversationId?: string) => {
    const conv = conversationId ?? app.conversations!.create(f.users.owner.id).id;
    const r = await send(conv, "안녕");
    db.$client.prepare("UPDATE runs SET ended_at = NULL WHERE id = ?").run(r.id);
    return { userId: f.users.owner.id, conversationId: conv, runId: r.id };
  };
  const video = app.media!.video;
  const card = async (
    input: Record<string, unknown> = { prompt: "노을 진 바다 위 작은 배" },
    conv?: string,
  ) => {
    const scope = await scopeOf(conv);
    const r = await app.media!.tools.run("video", scope, input);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const jobId = (r as { output: { jobId: string } }).output.jobId;
    return { scope, jobId, output: (r as { output: Record<string, unknown> }).output };
  };
  const approve = (id: string, version: number, cookie = f.cookies.owner) =>
    api(cookie, "POST", `/api/video-jobs/${id}/approve`, { version });
  const job = (id: string) => video.get(id)!;
  const usage = () =>
    db.$client
      .prepare(
        "SELECT run_id, media_settlement s, estimated_cost_micros e, priced_cost_micros p, created_at c FROM usage_records WHERE purpose = 'media'",
      )
      .all() as { run_id: string; s: string; e: number; p: number | null; c: number }[];
  /** Polls until the job ends (or `n` passes), each pass a tick of the engine. */
  /** Every running job and every waiting notification due now (the engine's state is the rows). */
  const dueNow = () =>
    db.$client
      .prepare(
        "UPDATE video_jobs SET next_at = CASE WHEN next_at IS NULL THEN NULL ELSE 0 END, notify_next_at = CASE WHEN notify_next_at IS NULL THEN NULL ELSE 0 END",
      )
      .run();
  const due = (id: string) =>
    db.$client.prepare("SELECT next_at AS at, failures FROM video_jobs WHERE id = ?").get(id) as {
      at: number;
      failures: number;
    };
  const drive = async (id: string, n = 10) => {
    for (let i = 0; i < n; i++) {
      await video.tick();
      await video.idle();
      if (["done", "failed", "expired", "dismissed"].includes(job(id).status)) break;
      // Every job (and notification) is due again at once.
      dueNow();
    }
    return job(id);
  };
  return { app, db, f, api, server, video, card, approve, job, usage, drive, dueNow, due, scopeOf, dataDir };
}

// ---------------------------------------------------------------- the bound and the options (pure)

describe("video cost bound (review item 1)", () => {
  it("takes the dearest per-second SKU that may apply: sound variants, the tier's own and the unsuffixed ones", () => {
    expect(videoCostBound(VEO.pricing_skus, { resolution: "720p", durationSec: 8 })).toBeCloseTo(
      0.12 * 8 * 1.2,
    );
    // 1080p: no 1080p SKU — the unsuffixed ones (with sound $0.12) apply.
    expect(videoCostBound(VEO.pricing_skus, { resolution: "1080p", durationSec: 4 })).toBeCloseTo(
      0.12 * 4 * 1.2,
    );
    // Cents per second (Grok), and an input SKU never sent (images) is left out.
    const grok = {
      cents_per_image_input: "1",
      cents_per_video_output_second_480p: "8",
      cents_per_video_output_second_720p: "14",
      cents_per_video_output_second_1080p: "25",
    };
    expect(videoCostBound(grok, { resolution: "720p", durationSec: 5 })).toBeCloseTo(0.14 * 5 * 1.2);
    // Long and reference variants count (the dearest), a minimum per generation too.
    const heygen = {
      duration_seconds_1080p: "0.1",
      long_duration_seconds_1080p: "0.105",
      reference_duration_seconds_1080p: "0.18",
      reference_input_images: "0.04",
    };
    expect(videoCostBound(heygen, { resolution: "1080p", durationSec: 10 })).toBeCloseTo(0.18 * 10 * 1.2);
    expect(
      videoCostBound(
        { cents_per_second_output: "28", minimum_cents_per_generation: "560" },
        { resolution: "720p", durationSec: 2 },
      ),
    ).toBeCloseTo(5.6 * 1.2);
    // Continuations and video inputs are never sent.
    expect(
      videoCostBound(
        { cents_per_second_output_720p: "17", cents_per_second_video_continuation_720p: "41" },
        { resolution: "720p", durationSec: 1 },
      ),
    ).toBeCloseTo(0.17 * 1.2);
  });

  it("no bound: tokens, megapixels, unreadable or negative prices, nothing for the tier, an empty list", () => {
    const at = { resolution: "720p", durationSec: 8 };
    expect(videoCostBound({ video_tokens: "0.000007" }, at)).toBeNull();
    expect(videoCostBound({ duration_seconds: "0.1", video_tokens_1080p: "0.00001" }, at)).toBeNull();
    expect(videoCostBound({ cents_per_megapixel_second_precise: "3.5" }, at)).toBeNull();
    expect(videoCostBound({ duration_seconds: "abc" }, at)).toBeNull();
    expect(videoCostBound({ duration_seconds: "-1" }, at)).toBeNull();
    expect(videoCostBound({ duration_seconds_1080p: "0.2" }, at)).toBeNull();
    expect(videoCostBound({ duration_seconds_8k_future: "0.2" }, at)).toBeNull();
    expect(videoCostBound({}, at)).toBeNull();
    expect(videoCostBound(null, at)).toBeNull();
    expect(videoPricing({ video_tokens: "0.000007" }, ["720p"])).toEqual({
      ok: false,
      reason: "token_priced",
    });
    expect(videoPricing({ duration_seconds_4k: "0.4" }, ["720p"])).toEqual({ ok: false, reason: "no_price" });
    expect(videoPricing(VEO.pricing_skus, ["720p"])).toEqual({ ok: true });
  });
});

describe("video card options (review item 10)", () => {
  const rec = (over: Record<string, unknown> = {}) =>
    videoRecordOf({ data: [{ ...VEO, ...over }] }, "test/veo")!;

  it("length: the longest ≤ the default, else the shortest; asked: the shortest ≥, else the longest", () => {
    const r = rec({ supported_durations: [-1, 4, 6, 8, 10, 12, 4] });
    expect(r.durations).toEqual([4, 6, 8, 10, 12]);
    const p = (ask: number | undefined, def = 8) => {
      const x = planVideo(r, { durationSec: ask }, def);
      return isPlanError(x) ? x : x.durationSec;
    };
    expect(p(undefined)).toBe(8);
    expect(p(undefined, 5)).toBe(4);
    expect(p(undefined, 2)).toBe(4);
    expect(p(9)).toBe(10);
    expect(p(30)).toBe(12);
    expect(p(1)).toBe(4);
  });

  it("resolution: 720p by default (else the lowest), ≤ 1080p only; aspect ratio: 16:9 by default, listed only", () => {
    const r = rec();
    expect(r.resolutions).toEqual(["720p", "1080p"]);
    expect(planVideo(r, {}, 8)).toMatchObject({ resolution: "720p", aspectRatio: "16:9", audio: true });
    expect(planVideo(r, { resolution: "1080p", aspectRatio: "9:16" }, 8)).toMatchObject({
      resolution: "1080p",
      aspectRatio: "9:16",
    });
    expect(planVideo(r, { resolution: "4K" }, 8)).toMatchObject({ code: "media_bad_option" });
    expect(planVideo(r, { aspectRatio: "1:1" }, 8)).toMatchObject({ code: "media_bad_option" });
    expect(planVideo(rec({ supported_resolutions: ["480p", "1080p"] }), {}, 8)).toMatchObject({
      resolution: "480p",
    });
    expect(planVideo(rec({ supported_resolutions: ["2K", "4K"] }), {}, 8)).toEqual({
      code: "media_video_unsupported",
    });
    expect(planVideo(rec({ supported_durations: null }), {}, 8)).toEqual({ code: "media_video_unsupported" });
    // None listed: none sent; asked for one — refused.
    expect(planVideo(rec({ supported_aspect_ratios: null }), {}, 8)).toMatchObject({ aspectRatio: null });
    expect(planVideo(rec({ supported_aspect_ratios: null }), { aspectRatio: "16:9" }, 8)).toMatchObject({
      code: "media_bad_option",
    });
    expect(planVideo(rec({ generate_audio: null }), {}, 8)).toMatchObject({ audio: null });
    expect(planVideo(rec({ pricing_skus: { video_tokens: "0.1" } }), {}, 8)).toEqual({
      code: "media_no_price",
    });
    expect(planVideo(r, {}, 8)).toMatchObject({ micros: VEO_8S_MICROS });
  });

  it("approval: the card's exact combination must still be offered", () => {
    const c = { durationSec: 8, resolution: "720p", aspectRatio: "16:9" };
    expect(replanVideo(rec(), c)).toMatchObject({ micros: VEO_8S_MICROS });
    expect(replanVideo(rec({ supported_durations: [4, 6] }), c)).toBeNull();
    expect(replanVideo(rec({ supported_resolutions: ["1080p"] }), c)).toBeNull();
    expect(replanVideo(rec({ supported_aspect_ratios: ["9:16"] }), c)).toBeNull();
    expect(replanVideo(rec({ supported_aspect_ratios: null }), c)).toBeNull();
    expect(videoModelVerdict(rec({ pricing_skus: { video_tokens: "1" } }))).toEqual({
      ok: false,
      reason: "token_priced",
    });
    expect(videoModelVerdict(rec({ supported_resolutions: ["4K"] }))).toEqual({
      ok: false,
      reason: "unsupported",
    });
  });
});

describe("video ids, URLs and the MP4 check (review items 7–8)", () => {
  it("builds status and content URLs only from a validated id; refuses redirects without following them", async () => {
    expect(VIDEO_JOB_ID.test(rid(1))).toBe(true);
    for (const bad of [
      "abc123",
      "gen-vid-1-short",
      `${rid(1)}/../x`,
      "gen-vid-1789480874-Ab3dEf9hIjKlMnOpQrS!",
    ])
      expect(videoStatusUrl(bad)).toBeNull();
    expect(videoContentUrl(rid(1))).toBe(`${OPENROUTER_VIDEOS_URL}/${rid(1)}/content?index=0`);
    let redirect: RequestRedirect | undefined;
    const fetchImpl = (async (_u: string | URL | Request, init?: RequestInit) => {
      redirect = init?.redirect;
      return new Response(null, { status: 302, headers: { location: "https://elsewhere.example/v.mp4" } });
    }) as typeof fetch;
    await expect(
      videoGet(videoContentUrl(rid(1))!, { apiKey: KEY, fetchImpl, timeoutMs: 1000 }),
    ).rejects.toMatchObject({
      status: -2,
    });
    expect(redirect).toBe("manual");
    await expect(
      videoGet("https://openrouter.ai/api/v1/videos/models", { apiKey: KEY, fetchImpl, timeoutMs: 1000 }),
    ).rejects.toMatchObject({ status: -1 });
  });

  it("ffprobe's report: an MP4 brand, the mp4 family and a video stream — not QuickTime, not audio only", () => {
    const report = (brand: string, streams: unknown[], format = "mov,mp4,m4a,3gp,3g2,mj2") =>
      JSON.stringify({ format: { format_name: format, tags: { major_brand: brand } }, streams });
    const v = { codec_type: "video", disposition: { attached_pic: 0 } };
    expect(judgeVideoProbe(report("isom", [v, { codec_type: "audio" }]))).toBe("ok");
    expect(judgeVideoProbe(report("mp42", [v]))).toBe("ok");
    expect(judgeVideoProbe(report("qt  ", [v]))).toBe("not_mp4");
    expect(judgeVideoProbe(report("isom", [{ codec_type: "audio" }]))).toBe("not_mp4");
    expect(judgeVideoProbe(report("isom", [{ codec_type: "video", disposition: { attached_pic: 1 } }]))).toBe(
      "not_mp4",
    );
    expect(judgeVideoProbe(report("isom", [v], "matroska,webm"))).toBe("not_mp4");
    expect(judgeVideoProbe("not json")).toBe("not_mp4");
    const opts = videoProbeOptions("/opt/ffprobe", ["/opt"], "/data/video-scratch/x/video.mp4");
    expect(opts).toMatchObject({ network: "none", read: ["/data/video-scratch/x"], write: [] });
    // Without the sandbox (not macOS) there is no probe at all.
    expect(sandboxedVideoProbe({ dataDir: "/nonexistent", platform: "linux" })).toBeUndefined();
  });
});

// ---------------------------------------------------------------- the card, the approval and the job

describe("video_generate and its jobs (#238 stage 3)", () => {
  it("the tool makes a card only — no reservation, no POST; the defaults and the bound are on it", async () => {
    const t = await start();
    expect(MEDIA_TOOLS).toContain(VIDEO_GENERATE_TOOL);
    expect(VIDEO_GENERATE_TOOL.description).toContain("NOT made yet");
    const { output, jobId } = await t.card();
    expect(output).toMatchObject({
      status: "awaiting_approval",
      model: "test/veo",
      durationSec: 8,
      resolution: "720p",
      aspectRatio: "16:9",
      audio: true,
      estimateUsd: VEO_8S_MICROS / 1e6,
    });
    expect(t.server.posts()).toHaveLength(0);
    expect(t.usage()).toHaveLength(0);
    const res = await t.api(t.f.cookies.owner, "GET", `/api/video-jobs/${jobId}`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "awaiting_approval",
      version: 0,
      prompt: "노을 진 바다 위 작은 배",
    });
    // Someone else (a family member, the admin): nothing of it.
    expect((await t.api(t.f.cookies.stranger, "GET", `/api/video-jobs/${jobId}`)).statusCode).toBe(403);
    expect((await t.api(t.f.cookies.admin, "GET", `/api/video-jobs/${jobId}`)).statusCode).toBe(403);
    // Asked for: the nearest supported length, 1080p.
    const longer = await t.card({ prompt: "산", durationSec: 7, resolution: "1080p", aspectRatio: "9:16" });
    expect(longer.output).toMatchObject({ durationSec: 8, resolution: "1080p", aspectRatio: "9:16" });
    expect(
      await t.app.media!.tools.run("video", await t.scopeOf(), { prompt: "산", resolution: "2160p" }),
    ).toMatchObject({ ok: false, code: "media_bad_option" });
  });

  it("approved: pending → in_progress → completed; the cost settled, the MP4 stored and served inline, notified", async () => {
    const t = await start();
    const { jobId } = await t.card();
    const res = await t.approve(jobId, 0);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ status: "pending", version: 2 });
    // The submit: the card's options and the request policy — no sound flag, no callback, no frames.
    const sent = t.server.posts()[0]!.body!;
    expect(sent).toEqual({
      model: "test/veo",
      prompt: "노을 진 바다 위 작은 배",
      duration: 8,
      resolution: "720p",
      aspect_ratio: "16:9",
      provider: { data_collection: "deny" },
    });
    // The bound is held from the approval on.
    expect(t.usage()).toEqual([expect.objectContaining({ s: "video_job", e: VEO_8S_MICROS, p: null })]);
    await t.video.tick();
    await t.video.idle();
    expect(t.job(jobId)).toMatchObject({ status: "pending" });
    const done = await t.drive(jobId);
    expect(done).toMatchObject({ status: "done", costMicros: 800_000, progress: 100 });
    expect(t.usage()).toEqual([expect.objectContaining({ s: "settled", p: 800_000 })]);
    const view = (await t.api(t.f.cookies.owner, "GET", `/api/video-jobs/${jobId}`)).json() as VideoJob;
    expect(view).toMatchObject({
      status: "done",
      costUsd: 0.8,
      file: { name: expect.stringMatching(/^video-.*\.mp4$/) },
    });
    const file = t.app.files!.get(view.file!.fileId)!;
    expect(file).toMatchObject({ kind: "mp4", messageId: view.messageId, bytes: fixtureMp4().length });
    const inline = await t.api(t.f.cookies.owner, "GET", `/api/files/${file.id}/content?inline=1`);
    expect(inline.statusCode).toBe(200);
    expect(inline.headers["content-type"]).toBe("video/mp4");
    expect(String(inline.headers["content-disposition"])).toMatch(/^inline/);
    // The download folder is gone.
    expect(fs.readdirSync(path.join(t.dataDir, "video-scratch"))).toEqual([]);
    const notes = t.db.$client
      .prepare("SELECT kind, body, url FROM notifications WHERE user_id = ?")
      .all(t.f.users.owner.id) as { kind: string; body: string; url: string }[];
    expect(notes).toEqual([
      {
        kind: "video_done",
        body: "영상이 완성됐어요. 눌러서 대화에서 보세요.",
        url: `/c/${view.conversationId}`,
      },
    ]);
    // The SSE stream of an ended job: its state once, then closed.
    const sse = await t.api(t.f.cookies.owner, "GET", `/api/video-jobs/${jobId}/events`);
    expect(sse.body).toContain("event: job");
  });

  it("an uploaded MP4 is never inline — only a video job's checked result", async () => {
    const t = await start();
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const up = await t.app.inject({
      method: "POST",
      url: `/api/conversations/${conv.id}/files`,
      headers: {
        ...WRITE,
        cookie: t.f.cookies.owner,
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent("clip.mp4"),
        "x-upload-id": "6f1c2a4e-8a51-4c2e-9d0e-0d5f7c1a2b3c",
      },
      payload: fixtureMp4(),
    });
    expect(up.statusCode, up.body).toBe(201);
    const id = (up.json() as { id: string }).id;
    const res = await t.api(t.f.cookies.owner, "GET", `/api/files/${id}/content?inline=1`);
    expect(String(res.headers["content-disposition"])).toMatch(/^attachment/);
  });

  it("double approval: the second (same version) is refused, one POST only; dismiss needs the version too", async () => {
    const t = await start();
    const { jobId } = await t.card();
    const [a, b] = await Promise.all([t.approve(jobId, 0), t.approve(jobId, 0)]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect([a, b].find((r) => r.statusCode === 409)!.json()).toMatchObject({ error: "video_job_changed" });
    expect(t.server.posts()).toHaveLength(1);
    expect(t.usage()).toHaveLength(1);
    const other = await t.card();
    expect(
      (await t.api(t.f.cookies.owner, "POST", `/api/video-jobs/${other.jobId}/dismiss`, { version: 3 }))
        .statusCode,
    ).toBe(409);
    const d = await t.api(t.f.cookies.owner, "POST", `/api/video-jobs/${other.jobId}/dismiss`, {
      version: 0,
    });
    expect(d.json()).toMatchObject({ status: "dismissed" });
    expect((await t.approve(other.jobId, 1)).json()).toMatchObject({ error: "video_job_changed" });
    // Someone else cannot approve.
    const third = await t.card();
    expect((await t.approve(third.jobId, 0, t.f.cookies.stranger)).statusCode).toBe(403);
  });

  it("a card expires after 24 hours, or when the admin changes the settings, model or key", async () => {
    const clock = { t: Date.UTC(2026, 10, 26, 3, 0, 0) };
    const t = await start({ clock });
    const { jobId } = await t.card();
    clock.t += 24 * 3600_000;
    const r = await t.approve(jobId, 0);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({
      error: "video_job_expired",
      job: { status: "expired", errorCode: "video_card_expired" },
    });
    // The engine's pass expires waiting cards too.
    const second = await t.card();
    clock.t += 24 * 3600_000 + 1;
    await t.video.tick();
    expect(t.job(second.jobId)).toMatchObject({ status: "expired", errorCode: "video_card_expired" });
    // A settings save (any field) while it waits.
    const third = await t.card();
    t.app.media!.settings.set(videoOn({ dailyCostLimitUsd: 40 }));
    expect((await t.approve(third.jobId, 0)).json()).toMatchObject({
      error: "video_job_expired",
      job: { errorCode: "video_settings_changed" },
    });
    // The key (its mark): the admin saving one over `.env`'s (the same value — still a change of key).
    const fourth = await t.card();
    await t.app.media!.admin.registerKey(KEY, t.app.media!.admin.generation(), () => true);
    expect((await t.approve(fourth.jobId, 0)).json()).toMatchObject({
      job: { errorCode: "video_settings_changed" },
    });
    expect(t.server.posts()).toHaveLength(0);
  });

  it("dearer at approval: the card is re-priced (version + 1) and nothing is sent; approved again, it goes", async () => {
    let price = "0.12";
    const server = fakeServer({
      catalog: () => [{ ...VEO, pricing_skus: { ...VEO.pricing_skus, duration_seconds_with_audio: price } }],
    });
    const t = await start({ server });
    const { jobId } = await t.card();
    price = "0.20";
    const r = await t.approve(jobId, 0);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({
      error: "video_estimate_changed",
      job: { version: 1, estimateUsd: 0.2 * 8 * 1.2 },
    });
    expect(t.server.posts()).toHaveLength(0);
    expect(t.usage()).toHaveLength(0);
    expect((await t.approve(jobId, 1)).json()).toMatchObject({ status: "pending" });
    expect(t.usage()[0]!.e).toBe(1_920_000);
  });

  it("no longer offered at approval (its length gone): the card expires, nothing sent", async () => {
    let durations = [4, 6, 8];
    const server = fakeServer({ catalog: () => [{ ...VEO, supported_durations: durations }] });
    const t = await start({ server });
    const { jobId } = await t.card();
    durations = [4, 6];
    expect((await t.approve(jobId, 0)).json()).toMatchObject({
      error: "video_job_expired",
      job: { status: "expired", errorCode: "video_options_changed" },
    });
    expect(t.server.posts()).toHaveLength(0);
  });

  it("budget: a card dearer than what is left is not made; at approval the day is the approval's", async () => {
    const clock = { t: Date.UTC(2026, 10, 26, 14, 59, 59) }; // 23:59:59 in Seoul
    const t = await start({ clock });
    t.app.media!.settings.set(videoOn({ dailyCostLimitUsd: 1 }));
    expect(await t.app.media!.tools.run("video", await t.scopeOf(), { prompt: "산" })).toMatchObject({
      ok: false,
      code: "media_budget",
    });
    t.app.media!.settings.set(videoOn({ dailyCostLimitUsd: 2 }));
    const { jobId } = await t.card();
    // Another card's bound takes the rest of today (approved first).
    const other = await t.card();
    expect((await t.approve(other.jobId, 0)).statusCode).toBe(200);
    const r = await t.approve(jobId, 0);
    expect(r.json()).toMatchObject({ error: "video_budget" });
    // After midnight, the new day's budget: the reservation is written with the approval's moment.
    clock.t += 2_000;
    expect((await t.approve(jobId, 0)).json()).toMatchObject({ status: "pending" });
    const rows = t.usage().sort((a, b) => a.c - b.c);
    expect(rows.map((x) => x.c)).toEqual([
      Date.UTC(2026, 10, 26, 14, 59, 59),
      Date.UTC(2026, 10, 26, 15, 0, 1),
    ]);
  });

  it("slots: two jobs per user at once (DB-counted); a slot frees when a job ends", async () => {
    const t = await start();
    const cards = [await t.card(), await t.card(), await t.card()];
    expect((await t.approve(cards[0]!.jobId, 0)).statusCode).toBe(200);
    expect((await t.approve(cards[1]!.jobId, 0)).statusCode).toBe(200);
    expect((await t.approve(cards[2]!.jobId, 0)).json()).toMatchObject({ error: "video_busy" });
    await t.drive(cards[0]!.jobId);
    expect((await t.approve(cards[2]!.jobId, 0)).statusCode).toBe(200);
  });

  it("the provider fails it (moderation): failed with a fixed code, the bound kept (unconfirmed), notified", async () => {
    const server = fakeServer({
      poll: (id, n) =>
        n === 1
          ? Response.json({ id, status: "pending" })
          : Response.json({ id, status: "failed", error: "Generated video rejected by content moderation." }),
    });
    const t = await start({ server });
    const { jobId } = await t.card({ prompt: "산 위의 구름" });
    await t.approve(jobId, 0);
    expect(await t.drive(jobId)).toMatchObject({
      status: "failed",
      errorCode: "video_moderated",
      fileId: null,
    });
    expect(t.usage()).toEqual([expect.objectContaining({ s: "unconfirmed", e: VEO_8S_MICROS, p: null })]);
    const n = t.db.$client.prepare("SELECT kind, body FROM notifications").all() as {
      kind: string;
      body: string;
    }[];
    expect(n).toEqual([{ kind: "video_failed", body: "영상을 만들지 못했어요 — 내용 검사에서 거부됐어요" }]);
    // Never the provider's words.
    expect(
      JSON.stringify((await t.api(t.f.cookies.owner, "GET", `/api/video-jobs/${jobId}`)).json()),
    ).not.toContain("rejected by content moderation");
  });

  it("expired at OpenRouter, gone there (410), 404 retried, and 429 backing off with Retry-After", async () => {
    let mode: "expired" | "404" | "410" | "429" = "expired";
    const server = fakeServer({
      poll: (id) =>
        mode === "expired"
          ? Response.json({ id, status: "expired", error: "Job exceeded maximum time to live" })
          : mode === "404" || mode === "410"
            ? Response.json({ error: { code: Number(mode) } }, { status: Number(mode) })
            : Response.json({ error: { code: 429 } }, { status: 429, headers: { "retry-after": "90" } }),
    });
    const clock = { t: Date.UTC(2026, 10, 26, 3, 0, 0) };
    const t = await start({ server, clock });
    const a = await t.card();
    await t.approve(a.jobId, 0);
    expect(await t.drive(a.jobId)).toMatchObject({ status: "failed", errorCode: "video_remote_expired" });
    mode = "404";
    const b = await t.card();
    await t.approve(b.jobId, 0);
    // A 404 may be another account's answer or not stored yet: tried again until the deadline.
    t.dueNow();
    expect(await t.drive(b.jobId, 3)).toMatchObject({ status: "pending", failures: 3 });
    mode = "410";
    expect(await t.drive(b.jobId)).toMatchObject({ status: "failed", errorCode: "video_lost" });
    mode = "429";
    const c = await t.card();
    await t.approve(c.jobId, 0);
    clock.t += 30_000;
    await t.video.tick();
    await t.video.idle();
    expect(t.due(c.jobId)).toEqual({ at: clock.t + 90_000, failures: 1 });
    expect(t.job(c.jobId).status).toBe("pending");
  });

  it("not finished within 60 minutes of the approval: video_timeout, the bound kept", async () => {
    const server = fakeServer({ poll: (id) => Response.json({ id, status: "in_progress" }) });
    const clock = { t: Date.UTC(2026, 10, 26, 3, 0, 0) };
    const t = await start({ server, clock });
    const { jobId } = await t.card();
    await t.approve(jobId, 0);
    expect(t.job(jobId).deadlineAt).toBe(clock.t + 3600_000);
    clock.t += 3600_000;
    await t.video.tick();
    expect(t.job(jobId)).toMatchObject({ status: "failed", errorCode: "video_timeout" });
    expect(t.usage()[0]!.s).toBe("unconfirmed");
  });

  it("the submit: a 4xx releases the bound; a 5xx, no answer or an unreadable 202 keeps it — never resent", async () => {
    let mode: "400" | "402" | "503" | "net" | "junk" = "400";
    const server = fakeServer({
      submit: () => {
        if (mode === "net") throw new TypeError("fetch failed");
        if (mode === "junk") return Response.json({ id: "not-a-job" }, { status: 202 });
        return Response.json({ error: { code: Number(mode) } }, { status: Number(mode) });
      },
    });
    const t = await start({ server });
    const outcome = async () => {
      const { jobId } = await t.card();
      const r = await t.approve(jobId, 0);
      expect(r.statusCode).toBe(200);
      return r.json() as VideoJob;
    };
    expect(await outcome()).toMatchObject({ status: "failed", errorCode: "video_rejected" });
    mode = "402";
    expect(await outcome()).toMatchObject({ status: "failed", errorCode: "video_payment" });
    expect(t.usage()).toHaveLength(0);
    for (const m of ["503", "net", "junk"] as const) {
      mode = m;
      expect(await outcome()).toMatchObject({ status: "failed", errorCode: "video_unconfirmed" });
    }
    expect(t.usage().map((u) => u.s)).toEqual(["unconfirmed", "unconfirmed", "unconfirmed"]);
    expect(t.server.posts()).toHaveLength(5);
  });

  it("restart: submitting is never resent (video_unconfirmed); pending is polled on and finishes", async () => {
    const t = await start();
    const a = await t.card();
    const b = await t.card();
    await t.approve(a.jobId, 0);
    // b died between the reservation and the answer: as a previous process left it.
    await t.approve(b.jobId, 0);
    t.db.$client
      .prepare("UPDATE video_jobs SET status = 'submitting', remote_id = NULL WHERE id = ?")
      .run(b.jobId);
    t.db.$client.prepare("UPDATE video_jobs SET notified_at = NULL").run();
    await t.video.stop();
    const next = new VideoJobs({
      db: t.db,
      files: () => t.app.files,
      conversations: t.app.conversations!,
      keys: t.app.media!.keys,
      settings: t.app.media!.settings,
      budget: t.app.media!.budget,
      usage: t.app.usageStore,
      users: t.app.users!,
      notifications: () => t.app.notifications,
      probe: () => fixtureVideoProbe(),
      dataDir: t.dataDir,
      fetchImpl: t.server.fetchImpl,
      limits: { tickMs: 3_600_000 },
    });
    next.start();
    closers.push(() => next.stop());
    expect(next.get(b.jobId)).toMatchObject({ status: "failed", errorCode: "video_unconfirmed" });
    await next.idle();
    for (let i = 0; i < 5 && next.get(a.jobId)!.status !== "done"; i++) {
      t.dueNow();
      await next.tick();
      await next.idle();
    }
    expect(next.get(a.jobId)).toMatchObject({ status: "done" });
    expect(t.server.posts()).toHaveLength(2);
  });

  it("a download over the disk guard, a redirect, or a file that is not an MP4: failed, the reported cost kept", async () => {
    let mode: "big" | "redirect" | "png" = "big";
    const server = fakeServer({
      content: () =>
        mode === "big"
          ? new Response(new Uint8Array(4096), { headers: { "content-type": "video/mp4" } })
          : mode === "redirect"
            ? new Response(null, { status: 302, headers: { location: "https://cdn.example/v.mp4" } })
            : new Response(new Uint8Array(Buffer.from("\x89PNG\r\n\x1a\n0000000000")), {
                headers: { "content-type": "video/mp4" },
              }),
    });
    const t = await start({ server, limits: { maxBytes: 1024 } });
    for (const [m, code] of [
      ["big", "video_too_large"],
      ["redirect", "video_download_failed"],
      ["png", "video_not_mp4"],
    ] as const) {
      mode = m;
      const { jobId } = await t.card();
      await t.approve(jobId, 0);
      expect(await t.drive(jobId)).toMatchObject({ status: "failed", errorCode: code, costMicros: 800_000 });
    }
    expect(t.usage().map((u) => [u.s, u.p])).toEqual([
      ["settled", 800_000],
      ["settled", 800_000],
      ["settled", 800_000],
    ]);
    expect(t.db.$client.prepare("SELECT count(*) n FROM files").get()).toEqual({ n: 0 });
    expect(fs.readdirSync(path.join(t.dataDir, "video-scratch"))).toEqual([]);
  });

  it("a deleted conversation: its job's bound kept (unconfirmed), the job gone, its poll stopped", async () => {
    const t = await start();
    const { jobId, scope } = await t.card();
    await t.approve(jobId, 0);
    await t.app.inject({
      method: "DELETE",
      url: `/api/conversations/${scope.conversationId}`,
      headers: { ...WRITE, cookie: t.f.cookies.owner },
    });
    expect(t.video.get(jobId)).toBeUndefined();
    expect(t.usage()).toEqual([expect.objectContaining({ s: "unconfirmed", e: VEO_8S_MICROS })]);
    const polls = t.server.requests.length;
    await t.video.tick();
    await t.video.idle();
    expect(t.server.requests.length).toBe(polls);
  });

  it("file places: an approved job holds one — an upload is refused at 19 files + 1 held; no place, no approval", async () => {
    const t = await start();
    const { jobId, scope } = await t.card();
    const conv = scope.conversationId;
    const insert = t.db.$client.prepare(
      `INSERT INTO files (id, user_id, conversation_id, message_id, upload_id, name, kind, media_type, bytes, sha256, created_at)
       VALUES (?, ?, ?, NULL, ?, 'f.txt', 'txt', 'text/plain', 1, 'x', 0)`,
    );
    for (let i = 0; i < FILE_LIMITS.perConversation - 1; i++)
      insert.run(`f-${i}`, t.f.users.owner.id, conv, `u-${i}`);
    expect((await t.approve(jobId, 0)).statusCode).toBe(200);
    expect(t.app.files!.placesTaken(conv)).toBe(FILE_LIMITS.perConversation);
    const up = await t.app.inject({
      method: "POST",
      url: `/api/conversations/${conv}/files`,
      headers: {
        ...WRITE,
        cookie: t.f.cookies.owner,
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent("a.txt"),
        "x-upload-id": "7f1c2a4e-8a51-4c2e-9d0e-0d5f7c1a2b3c",
      },
      payload: "hello",
    });
    expect(up.json()).toMatchObject({ error: "too_many_files" });
    // Its own file takes the place it held.
    expect(await t.drive(jobId)).toMatchObject({ status: "done" });
    expect(t.app.files!.count(conv)).toBe(FILE_LIMITS.perConversation);
    const another = await t.card(undefined, conv);
    expect((await t.approve(another.jobId, 0)).json()).toMatchObject({ error: "video_file_limit" });
  });

  it("nothing is approved without ffprobe, without the engine, or while the media recovery runs", async () => {
    const t = await start({ probe: () => undefined });
    const { jobId } = await t.card();
    expect((await t.approve(jobId, 0)).json()).toMatchObject({ error: "video_probe_unavailable" });
    const u = await start({ engine: false });
    const c = await u.card();
    expect((await u.approve(c.jobId, 0)).json()).toMatchObject({ error: "video_engine_unavailable" });
    const v = await start();
    const d = await v.card();
    vi.spyOn(v.app.media!.recovery, "recovering").mockReturnValue(true);
    expect((await v.approve(d.jobId, 0)).json()).toMatchObject({ error: "video_recovering" });
    expect([...t.server.posts(), ...u.server.posts(), ...v.server.posts()]).toHaveLength(0);
  });

  it("a prompt carrying a known secret makes no card; one registered after the card ends it unsent", async () => {
    const t = await start();
    const secret = "sk-test-verysecretvalue-heron-basalt-cobalt";
    const late = "late-registered-marker-pelican-quartz";
    const { knownSecrets } = await import("../src/secrets/known.js");
    const { jobId } = await t.card({ prompt: `바다 위 배 ${late}` });
    knownSecrets.add(late, { fresh: true });
    try {
      const r = await t.approve(jobId, 0);
      expect(r.json()).toMatchObject({ status: "failed", errorCode: "video_blocked" });
      knownSecrets.add(secret, { fresh: true });
      expect(
        await t.app.media!.tools.run("video", await t.scopeOf(), { prompt: `배 ${secret}` }),
      ).toMatchObject({
        ok: false,
        code: "media_secret_blocked",
      });
    } finally {
      knownSecrets.remove(late);
      knownSecrets.remove(secret);
    }
    expect(t.server.posts()).toHaveLength(0);
  });

  it("the admin: a token-priced video model is refused when chosen; a per-second one is saved", async () => {
    const server = fakeServer({
      catalog: () => [VEO, { ...VEO, id: "test/tokens", pricing_skus: { video_tokens: "0.000007" } }],
    });
    const t = await start({ server });
    const admin = t.app.media!.admin;
    const save = (model: string) =>
      admin.saveSettings(
        { ...videoOn(), kinds: { ...videoOn().kinds, video: { enabled: true, model } } },
        t.app.media!.settings.revision(),
        () => true,
      );
    await expect(save("test/tokens")).rejects.toMatchObject({
      code: "media_model_video_token_priced",
      kind: "video",
    });
    await expect(save("test/veo")).resolves.toMatchObject({
      settings: { kinds: { video: { model: "test/veo" } } },
    });
  });

  it("notifications: fixed words only, never the prompt", () => {
    expect(compose({ kind: "video_done", url: "/c/x" })).toMatchObject({
      title: "영상 생성",
      body: "영상이 완성됐어요. 눌러서 대화에서 보세요.",
    });
    expect(compose({ kind: "video_failed", reason: "60분 안에 끝나지 않았어요", url: "/c/x" }).body).toBe(
      "영상을 만들지 못했어요 — 60분 안에 끝나지 않았어요",
    );
  });
});

// ---------------------------------------------------------------- review round 1 (#255)

describe("video jobs — review r1 regressions", () => {
  const dueOf = (t: Awaited<ReturnType<typeof start>>, id: string) => t.due(id);

  it("P1: a probe that cannot check a known-good MP4 here refuses the approval before anything is reserved or sent", async () => {
    let readyCalls = 0;
    let ready = false;
    const probe: VideoProbe = {
      check: async () => "ok",
      ready: async () => {
        readyCalls += 1;
        return ready;
      },
    };
    const t = await start({ probe: () => probe });
    const { jobId } = await t.card();
    expect((await t.approve(jobId, 0)).json()).toMatchObject({ error: "video_probe_unavailable" });
    expect(t.server.posts()).toHaveLength(0);
    expect(t.usage()).toHaveLength(0);
    ready = true;
    expect((await t.approve(jobId, 0)).json()).toMatchObject({ status: "pending" });
    // An ok holds a while (not asked again for the next approval).
    const other = await t.card();
    await t.approve(other.jobId, 0);
    expect(readyCalls).toBe(2);
    // The fixture probe's readiness really writes and checks the known-good MP4 in video-scratch.
    expect(await fixtureVideoProbe(t.dataDir).ready()).toBe(true);
    expect(KNOWN_GOOD_MP4.subarray(4, 8).toString("latin1")).toBe("ftyp");
    expect(fs.readdirSync(path.join(t.dataDir, "video-scratch"))).toEqual([]);
  });

  it("P2: a rescrub changing a waiting card's prompt ends it (video_blocked, version + 1) — the old approval sends nothing", async () => {
    const t = await start();
    const { jobId } = await t.card();
    // The background rescrub's write: any change of a waiting card's prompt (the trigger of 0039).
    t.db.$client
      .prepare("UPDATE video_jobs SET prompt = ? WHERE id = ?")
      .run("노을 진 [REDACTED] 위 작은 배", jobId);
    expect(t.job(jobId)).toMatchObject({ status: "failed", errorCode: "video_blocked", version: 1 });
    expect((await t.approve(jobId, 0)).json()).toMatchObject({ error: "video_job_changed" });
    expect(t.server.posts()).toHaveLength(0);
    // A job already sent is left alone.
    const sent = await t.card();
    await t.approve(sent.jobId, 0);
    t.db.$client.prepare("UPDATE video_jobs SET prompt = 'x' WHERE id = ?").run(sent.jobId);
    expect(t.job(sent.jobId).status).toBe("pending");
  });

  it("P2: the model's default for sound changed: the card is refreshed and approved again", async () => {
    let audio: boolean | null = true;
    const t = await start({ server: fakeServer({ catalog: () => [{ ...VEO, generate_audio: audio }] }) });
    const { jobId } = await t.card();
    audio = false;
    const r = await t.approve(jobId, 0);
    expect(r.statusCode).toBe(409);
    expect(r.json()).toMatchObject({ error: "video_card_refreshed", job: { audio: false, version: 1 } });
    expect(t.server.posts()).toHaveLength(0);
    expect((await t.approve(jobId, 1)).json()).toMatchObject({ status: "pending", audio: false });
  });

  it("P2: a status answer about another job changes nothing — neither status nor cost; asked again later", async () => {
    const t = await start({
      server: fakeServer({
        poll: () => Response.json({ id: rid(99), status: "completed", usage: { cost: 0 } }),
      }),
    });
    const { jobId } = await t.card();
    await t.approve(jobId, 0);
    await t.video.tick();
    t.dueNow();
    await t.video.tick();
    await t.video.idle();
    expect(t.job(jobId)).toMatchObject({ status: "pending", costMicros: null });
    expect(t.usage()).toEqual([expect.objectContaining({ s: "video_job", p: null, e: VEO_8S_MICROS })]);
    expect(dueOf(t, jobId)!.failures).toBeGreaterThanOrEqual(1);
  });

  it("P2: a refused submit whose release fails is held by its work until the release is committed", async () => {
    const t = await start({
      limits: { retryMs: 20 },
      server: fakeServer({ submit: () => Response.json({ error: { code: 402 } }, { status: 402 }) }),
    });
    const { jobId } = await t.card();
    const release = vi.spyOn(t.app.usageStore!, "releaseVideoMedia").mockImplementation(() => {
      throw new Error("SQLITE_BUSY");
    });
    expect((await t.approve(jobId, 0)).json()).toMatchObject({ status: "submitting" });
    expect(t.usage()).toEqual([expect.objectContaining({ s: "video_job" })]);
    // Never ended without its release: a pass leaves it to the work holding the refusal.
    await t.video.tick();
    expect(t.job(jobId).status).toBe("submitting");
    release.mockRestore();
    await vi.waitFor(
      () => expect(t.job(jobId)).toMatchObject({ status: "failed", errorCode: "video_payment" }),
      {
        timeout: 5000,
      },
    );
    expect(t.usage()).toEqual([]);
  });

  it("P2: a session ended during the model lookup: refused before the card is re-priced, and no card in the answer", async () => {
    let price = "0.12";
    let onLookup = () => {};
    const t = await start({
      server: fakeServer({
        catalog: () => {
          onLookup();
          return [{ ...VEO, pricing_skus: { ...VEO.pricing_skus, duration_seconds_with_audio: price } }];
        },
      }),
    });
    const { jobId } = await t.card();
    price = "0.50";
    onLookup = () => t.app.users!.deactivate(t.f.users.owner.id);
    const r = await t.approve(jobId, 0);
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: "forbidden" });
    expect(t.job(jobId)).toMatchObject({
      status: "awaiting_approval",
      version: 0,
      estimateMicros: VEO_8S_MICROS,
    });
  });

  it("P2: a rolled-back conversation delete never stops another conversation's job", async () => {
    let gate: () => void = () => {};
    let held = false;
    const t = await start({
      server: fakeServer({
        poll: async (id) => {
          if (held) await new Promise<void>((r) => (gate = r));
          return Response.json({ id, status: "in_progress", progress: 10 });
        },
      }),
    });
    const a = await t.card();
    await t.approve(a.jobId, 0);
    const b = await t.card();
    t.app.conversations!.onDelete((id) => {
      if (id === a.scope.conversationId) throw new Error("hook refused");
    });
    held = true;
    t.dueNow();
    const pass = t.video.tick();
    await new Promise((r) => setTimeout(r, 20));
    expect(() => t.app.conversations!.delete(a.scope.conversationId)).toThrow("hook refused");
    t.app.conversations!.delete(b.scope.conversationId);
    gate();
    await pass;
    await t.video.idle();
    expect(t.job(a.jobId)).toMatchObject({ status: "in_progress", progress: 10 });
  });

  it("P2: the deadline holds during the check and the file lock: past it, video_timeout — the settled cost stays", async () => {
    const clock = { t: Date.UTC(2026, 10, 26, 3, 0, 0) };
    const probe: VideoProbe = {
      ready: async () => true,
      check: async () => {
        clock.t += 61 * 60_000;
        return "ok";
      },
    };
    const t = await start({ clock, probe: () => probe });
    const { jobId } = await t.card();
    await t.approve(jobId, 0);
    expect(await t.drive(jobId)).toMatchObject({
      status: "failed",
      errorCode: "video_timeout",
      costMicros: 800_000,
    });
    expect(t.usage()).toEqual([expect.objectContaining({ s: "settled", p: 800_000 })]);
    expect(t.db.$client.prepare("SELECT count(*) n FROM files").get()).toEqual({ n: 0 });
  });

  it("P2: notified_at only once published — a failed publish is tried again (same dedupe key, one row)", async () => {
    const t = await start();
    const publish = vi.spyOn(t.app.notifications!, "publishOutcome").mockImplementationOnce(() => {
      throw new Error("notifications table busy");
    });
    const { jobId } = await t.card();
    await t.approve(jobId, 0);
    await t.drive(jobId);
    expect(t.job(jobId)).toMatchObject({ status: "done", notifiedAt: null });
    expect(t.db.$client.prepare("SELECT count(*) n FROM notifications").get()).toEqual({ n: 0 });
    // Its own backoff: not before its retry time.
    expect(t.job(jobId)).toMatchObject({ notifyTries: 1 });
    await t.video.tick();
    expect(publish).toHaveBeenCalledTimes(1);
    t.dueNow();
    await t.video.tick();
    expect(t.job(jobId).notifiedAt).not.toBeNull();
    expect(t.db.$client.prepare("SELECT kind FROM notifications").all()).toEqual([{ kind: "video_done" }]);
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("P2: the content's 429 keeps its Retry-After, and the failures in a row count across completed polls", async () => {
    const clock = { t: Date.UTC(2026, 10, 26, 3, 0, 0) };
    const t = await start({
      clock,
      server: fakeServer({
        poll: (id) => Response.json({ id, status: "completed", usage: { cost: 0.8 } }),
        content: () =>
          Response.json({ error: { code: 429 } }, { status: 429, headers: { "retry-after": "90" } }),
      }),
    });
    const { jobId } = await t.card();
    await t.approve(jobId, 0);
    for (const n of [1, 2]) {
      t.dueNow();
      await t.video.tick();
      await t.video.idle();
      expect(dueOf(t, jobId)).toEqual({ at: clock.t + 90_000, failures: n });
    }
    expect(t.job(jobId)).toMatchObject({ status: "downloading", costMicros: 800_000 });
  });

  it("P2: the admin's list shows per-second prices in dollars — cents divided by 100", () => {
    expect(
      videoPriceText({
        cents_per_image_input: "1",
        cents_per_video_output_second_480p: "8",
        cents_per_video_output_second_720p: "14",
        cents_per_video_output_second_1080p: "25",
      }),
    ).toBe("$0.08/초 (480p), $0.14/초 (720p), $0.25/초 (1080p)");
    expect(videoPriceText(VEO.pricing_skus)).toBe("$0.12/초, $0.3/초 (4k), $0.1/초 (720p)");
    expect(videoPriceText({ video_tokens: "0.000007" })).toBeNull();
  });

  it("P3: the engine expires a waiting card when the settings change, and its open stream hears it", async () => {
    const t = await start();
    const { jobId } = await t.card();
    const heard: string[] = [];
    const off = t.video.subscribe(jobId, () => heard.push(t.job(jobId).status));
    t.app.media!.settings.set(videoOn({ dailyCostLimitUsd: 30 }));
    await t.video.tick();
    off();
    expect(t.job(jobId)).toMatchObject({ status: "expired", errorCode: "video_settings_changed" });
    expect(heard).toContain("expired");
  });

  it("P3: a length over 600 s is no input error — it becomes the model's longest; a list's long lengths are kept", async () => {
    const t = await start({
      server: fakeServer({ catalog: () => [{ ...VEO, supported_durations: [4, 8, 900] }] }),
    });
    // 900 s at $0.12 is over the default $50 a day.
    t.app.media!.settings.set(videoOn({ dailyCostLimitUsd: 1000 }));
    const r = await t.app.media!.tools.run("video", await t.scopeOf(), { prompt: "강", durationSec: 601 });
    expect(r).toMatchObject({ ok: true, output: { durationSec: 900 } });
    const s = await t.app.media!.tools.run("video", await t.scopeOf(), { prompt: "강", durationSec: 5000 });
    expect(s).toMatchObject({ ok: true, output: { durationSec: 900 } });
    // Review r2: any positive safe integer — no cap of its own before the model's list.
    const u = await t.app.media!.tools.run("video", await t.scopeOf(), { prompt: "강", durationSec: 86_401 });
    expect(u).toMatchObject({ ok: true, output: { durationSec: 900 } });
    expect(
      await t.app.media!.tools.run("video", await t.scopeOf(), { prompt: "강", durationSec: 1e12 }),
    ).toMatchObject({ ok: true, output: { durationSec: 900 } });
  });
});

// ---------------------------------------------------------------- review round 2 (#255)

describe("video jobs — review r2 regressions", () => {
  it("A: a 202 whose `pending` write fails: no 500; the received id is written once the database is back, never resent", async () => {
    const t = await start({ limits: { retryMs: 20 } });
    const { jobId } = await t.card();
    t.db.$client.exec(
      "CREATE TRIGGER r2_fail_pending BEFORE UPDATE OF status ON video_jobs WHEN NEW.status='pending' BEGIN SELECT RAISE(ABORT,'transient write failure'); END",
    );
    const r = await t.approve(jobId, 0);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ status: "submitting" });
    // Its submit's work is still under way (it keeps the id): a pass leaves it alone.
    t.dueNow();
    await t.video.tick();
    expect(t.job(jobId).status).toBe("submitting");
    t.db.$client.exec("DROP TRIGGER r2_fail_pending");
    await vi.waitFor(() => expect(t.job(jobId)).toMatchObject({ status: "pending", remoteId: rid(1) }), {
      timeout: 5000,
    });
    expect(await t.drive(jobId)).toMatchObject({ status: "done" });
    expect(t.server.posts()).toHaveLength(1);
  });

  it("A: a `submitting` row whose submit is not under way here and has no id: video_unconfirmed, never resent", async () => {
    const t = await start();
    const { jobId } = await t.card();
    await t.approve(jobId, 0);
    t.db.$client
      .prepare("UPDATE video_jobs SET status = 'submitting', remote_id = NULL WHERE id = ?")
      .run(jobId);
    t.dueNow();
    await t.video.tick();
    expect(t.job(jobId)).toMatchObject({ status: "failed", errorCode: "video_unconfirmed" });
    expect(t.usage()).toEqual([expect.objectContaining({ s: "unconfirmed" })]);
    expect(t.server.posts()).toHaveLength(1);
  });

  it("B: a refused submit whose release failed, then its conversation deleted: the reservation goes with it", async () => {
    const t = await start({
      server: fakeServer({ submit: () => Response.json({ error: { code: 402 } }, { status: 402 }) }),
    });
    const { jobId, scope } = await t.card();
    const other = await t.card();
    await t.approve(other.jobId, 0);
    const spy = vi.spyOn(t.app.usageStore!, "releaseMedia").mockImplementation(() => {
      throw new Error("transient write failure");
    });
    expect((await t.approve(jobId, 0)).json()).toMatchObject({ errorCode: "video_payment" });
    spy.mockRestore();
    // A job of another conversation stays as it is; this conversation's unresolved reservation is resolved.
    t.app.conversations!.delete(scope.conversationId);
    expect(t.usage().map((u) => u.s)).toEqual([]);
    expect(
      t.db.$client.prepare("SELECT count(*) n FROM usage_records WHERE media_settlement = 'video_job'").get(),
    ).toEqual({
      n: 0,
    });
  });

  it("C: a session ended while the provider answered: the job goes on, the answer carries no card", async () => {
    let onSubmit = () => {};
    const t = await start({
      server: fakeServer({
        submit: (_b, n) => {
          onSubmit();
          return Response.json({ id: rid(n), status: "pending" }, { status: 202 });
        },
      }),
    });
    const { jobId } = await t.card();
    onSubmit = () => t.app.users!.deactivate(t.f.users.owner.id);
    const r = await t.approve(jobId, 0);
    expect(r.statusCode).toBe(403);
    expect(r.json()).toEqual({ error: "forbidden" });
    expect(t.job(jobId)).toMatchObject({ status: "pending", remoteId: rid(1) });
  });

  it("D: at the deadline a job waiting for the file lock ends at once (slot and place free); nothing is stored", async () => {
    const t = await start({
      limits: { deadlineMs: 600, pollMs: 0 },
      server: fakeServer({ poll: (id) => Response.json({ id, status: "completed", usage: { cost: 0.8 } }) }),
    });
    const { jobId, scope } = await t.card();
    await t.approve(jobId, 0);
    let unlock!: () => void;
    const locked = t.app.fileWrites.exclusive(() => new Promise<void>((r) => (unlock = r)));
    const store = vi.spyOn(t.app.files!, "addGenerated");
    const pass = t.video.tick();
    try {
      await vi.waitFor(() => expect(store).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, Math.max(0, t.job(jobId).deadlineAt! - Date.now()) + 100));
      // The next pass ends it in the database while the write still waits: its slot and file place are free.
      await t.video.tick();
      expect(t.job(jobId)).toMatchObject({
        status: "failed",
        errorCode: "video_timeout",
        costMicros: 800_000,
      });
      expect(t.app.files!.placesTaken(scope.conversationId)).toBe(0);
    } finally {
      unlock();
      await locked;
      await pass;
      await t.video.idle();
    }
    expect(t.job(jobId)).toMatchObject({ status: "failed", errorCode: "video_timeout", fileId: null });
    expect(t.db.$client.prepare("SELECT count(*) n FROM files").get()).toEqual({ n: 0 });
    expect(t.usage()).toEqual([expect.objectContaining({ s: "settled", p: 800_000 })]);
  });

  it("E: a lookup error while publishing is not a refusal — notified_at stays empty and it is published later", async () => {
    const t = await start();
    const { jobId, scope } = await t.card();
    await t.approve(jobId, 0);
    const original = t.app.resources.load.bind(t.app.resources);
    let transient = true;
    const spy = vi.spyOn(t.app.resources, "load").mockImplementation((kind, id) => {
      if (transient && kind === "conversation" && id === scope.conversationId) {
        transient = false;
        throw new Error("transient resource read failure");
      }
      return original(kind, id);
    });
    await t.drive(jobId);
    expect(transient).toBe(false);
    expect(t.job(jobId).notifiedAt).toBeNull();
    t.dueNow();
    await t.video.tick();
    spy.mockRestore();
    expect(t.job(jobId).notifiedAt).not.toBeNull();
    expect(t.db.$client.prepare("SELECT kind FROM notifications").all()).toEqual([{ kind: "video_done" }]);
    // A refusal for good (another user's key, the account gone): done, not tried again.
    expect(
      t.app.notifications!.publishOutcome(
        t.f.users.stranger.id,
        { kind: "video_done", url: "/c/x" },
        {
          dedupeKey: `video:${jobId}:end`,
        },
      ),
    ).toEqual({ status: "refused" });
  });

  it("F: a notified_at write that fails never throws out of a pass; the next pass marks it (one notification)", async () => {
    const t = await start();
    const { jobId } = await t.card();
    await t.approve(jobId, 0);
    t.db.$client.exec(
      "CREATE TRIGGER r2_notify BEFORE UPDATE OF notified_at ON video_jobs BEGIN SELECT RAISE(ABORT,'transient marker write'); END",
    );
    await t.drive(jobId);
    expect(t.job(jobId).notifiedAt).toBeNull();
    await expect(t.video.tick()).resolves.toBeUndefined();
    // A pass whose own reads fail does not throw either.
    const select = vi.spyOn(t.db, "select").mockImplementationOnce(() => {
      throw new Error("SQLITE_BUSY");
    });
    expect(() => t.video.tick()).not.toThrow();
    select.mockRestore();
    t.db.$client.exec("DROP TRIGGER r2_notify");
    t.dueNow();
    await t.video.tick();
    expect(t.job(jobId).notifiedAt).not.toBeNull();
    expect(t.db.$client.prepare("SELECT count(*) n FROM notifications").get()).toEqual({ n: 1 });
  });

  it("G: the end text says the confirmed cost when there is one, the bound only when none", async () => {
    const { videoEndText } = await import("@agentlee/shared");
    expect(videoEndText("video_timeout", 0.8)).toContain("실제 비용이 기록돼 있어요");
    expect(videoEndText("video_timeout", 0.8)).not.toContain("최대");
    expect(videoEndText("video_timeout", null)).toContain("최대 비용으로 기록");
    expect(videoEndText("video_payment", null)).toContain("비용은 나가지 않았어요");
  });
});

// ---------------------------------------------------------------- review round 3 (#255): the engine on its rows

describe("video jobs — review r3 regressions (the engine's state is the rows)", () => {
  const other = `${KEY}-alternate`;
  /** The fake job server for `KEY`; a second synthetic key OpenRouter takes too (its job requests: 404). */
  const twoKeys = (base = fakeServer()) => {
    const check = fixtureOpenRouterFetch();
    const asOther: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new Headers(init?.headers).get("authorization") === `Bearer ${other}`) {
        asOther.push(String(input));
        if (String(input).includes("/videos/")) return new Response(null, { status: 404 });
        return check(input, init);
      }
      return base.fetchImpl(input, init);
    }) as typeof fetch;
    return { server: { ...base, fetchImpl }, asOther };
  };

  it("1: a job polls only with the key it was approved under — another key in between is never asked, the job waits", async () => {
    const clock = { t: Date.UTC(2026, 10, 26, 3, 0, 0) };
    const { server, asOther } = twoKeys();
    const t = await start({ server, clock });
    const { jobId } = await t.card();
    await t.approve(jobId, 0);
    const admin = t.app.media!.admin;
    await admin.registerKey(other, admin.generation(), () => true);
    t.dueNow();
    await t.video.tick();
    await t.video.idle();
    expect(asOther.filter((u) => u.includes("/videos/"))).toEqual([]);
    expect(t.job(jobId)).toMatchObject({ status: "pending" });
    // Never `video_lost` for another key's answer; the deadline ends it, its bound kept.
    clock.t += 3600_000;
    await t.video.tick();
    expect(t.job(jobId)).toMatchObject({ status: "failed", errorCode: "video_timeout" });
    expect(t.usage()).toEqual([expect.objectContaining({ s: "unconfirmed", e: VEO_8S_MICROS })]);
  });

  it("2: a key saved and deleted between two passes expires the waiting cards — the mark never comes back", async () => {
    const { server } = twoKeys();
    const t = await start({ server });
    const { jobId } = await t.card();
    const before = t.app.media!.keys.mark();
    const admin = t.app.media!.admin;
    await admin.registerKey(other, admin.generation(), () => true);
    await admin.deleteKey(admin.generation(), () => true);
    expect(t.app.media!.keys.mark()).not.toBe(before);
    expect(t.job(jobId)).toMatchObject({
      status: "expired",
      errorCode: "video_settings_changed",
      version: 1,
    });
    expect((await t.approve(jobId, 0)).json()).toMatchObject({ error: "video_job_expired" });
    expect(t.server.posts()).toHaveLength(0);
  });

  it("3: deadlines come first: an end write that failed is done by a later pass, even while the file lock is held", async () => {
    const t = await start({
      limits: { deadlineMs: 500, pollMs: 0 },
      server: fakeServer({ poll: (id) => Response.json({ id, status: "completed", usage: { cost: 0.8 } }) }),
    });
    const { jobId, scope } = await t.card();
    await t.approve(jobId, 0);
    let unlock!: () => void;
    const locked = t.app.fileWrites.exclusive(() => new Promise<void>((r) => (unlock = r)));
    const writing = vi.spyOn(t.app.files!, "addGenerated");
    t.dueNow();
    const pass = t.video.tick();
    try {
      await vi.waitFor(() => expect(writing).toHaveBeenCalled());
      t.db.$client.exec(
        "CREATE TRIGGER r3_end BEFORE UPDATE OF status ON video_jobs WHEN NEW.error_code='video_timeout' BEGIN SELECT RAISE(ABORT,'transient end write'); END",
      );
      await new Promise((r) => setTimeout(r, Math.max(0, t.job(jobId).deadlineAt! - Date.now()) + 100));
      await t.video.tick();
      expect(t.job(jobId).status).toBe("downloading");
      t.db.$client.exec("DROP TRIGGER r3_end");
      await t.video.tick();
      expect(t.job(jobId)).toMatchObject({
        status: "failed",
        errorCode: "video_timeout",
        costMicros: 800_000,
      });
      expect(t.app.files!.placesTaken(scope.conversationId)).toBe(0);
    } finally {
      unlock();
      await locked;
      await pass;
      await t.video.idle();
    }
    expect(t.job(jobId)).toMatchObject({ status: "failed", fileId: null });
    expect(t.db.$client.prepare("SELECT count(*) n FROM files").get()).toEqual({ n: 0 });
  });

  it("4: failing notifications back off on their own rows — 50 of one conversation never starve another's", async () => {
    const t = await start();
    const a = await t.card();
    const b = await t.card();
    const ended = (id: string) =>
      t.db.$client
        .prepare(
          "UPDATE video_jobs SET status='failed', error_code='video_timeout', approved_at=?, ended_at=? WHERE id=?",
        )
        .run(Date.now() - 1000, Date.now(), id);
    ended(a.jobId);
    const seed = t.job(a.jobId);
    for (let i = 1; i < 50; i++) ended(t.video.createCard({ ...seed }));
    const good = t.video.createCard({ ...t.job(b.jobId) });
    ended(good);
    const real = t.app.resources.load.bind(t.app.resources);
    vi.spyOn(t.app.resources, "load").mockImplementation((k, id) => {
      if (k === "conversation" && id === seed.conversationId) throw new Error("unreadable single ref");
      return real(k, id);
    });
    for (let i = 0; i < 3; i++) await t.video.tick();
    expect(t.job(good).notifiedAt).not.toBeNull();
    expect(t.db.$client.prepare("SELECT count(*) n FROM notifications").get()).toEqual({ n: 1 });
  });

  it("5: the start never throws; until its recovery succeeded nothing is approved; start again is harmless", async () => {
    const t = await start({ engine: false });
    const { jobId } = await t.card();
    const update = vi.spyOn(t.db, "update").mockImplementationOnce(() => {
      throw new Error("one transient write");
    });
    expect(() => t.video.start()).not.toThrow();
    update.mockRestore();
    expect(t.video.started).toBe(true);
    expect((await t.approve(jobId, 0)).json()).toMatchObject({ error: "video_recovering" });
    t.video.start();
    await t.video.tick();
    expect((await t.approve(jobId, 0)).json()).toMatchObject({ status: "pending" });
    // A first read that fails at the app's own start does not fail `ready()` either.
    const db = createTestDb();
    const app = await buildApp(
      loadConfig({
        NODE_ENV: "test",
        DATA_DIR: path.join(tmp(), "data"),
        MASTER_KEY_PATH: path.join(tmp(), "key"),
        OPENROUTER_API_KEY: KEY,
      }),
      {
        db,
        media: {
          fetchImpl: fakeServer().fetchImpl,
          video: { start: true, probe: () => fixtureVideoProbe() },
        },
      },
    );
    closers.push(() => app.close());
    const real = db.$client.prepare.bind(db.$client);
    let injected = false;
    vi.spyOn(db.$client, "prepare").mockImplementation((q, ...args) => {
      if (!injected && /"video_jobs"/.test(String(q))) {
        injected = true;
        throw new Error("transient first video read");
      }
      return real(q as string, ...(args as []));
    });
    await expect(app.ready()).resolves.toBeDefined();
    expect(injected).toBe(true);
    expect(app.media!.video.started).toBe(true);
  });

  it("6: the end notification opens the conversation (a regenerated reply cannot leave it pointing nowhere)", async () => {
    const t = await start();
    const { jobId, scope } = await t.card();
    await t.approve(jobId, 0);
    await t.drive(jobId);
    expect(t.db.$client.prepare("SELECT url FROM notifications WHERE kind = 'video_done'").get()).toEqual({
      url: `/c/${scope.conversationId}`,
    });
  });

  it("7: while video is on, every settings save judges its model again; turning it off is always allowed", async () => {
    const t = await start({
      server: fakeServer({ catalog: () => [{ ...VEO, pricing_skus: { video_tokens: "0.000007" } }] }),
    });
    const m = t.app.media!;
    await expect(
      m.admin.saveSettings(videoOn({ dailyCostLimitUsd: 23 }), m.settings.revision(), () => true),
    ).rejects.toMatchObject({ code: "media_model_video_token_priced" });
    const off = videoOn({ dailyCostLimitUsd: 23 });
    off.kinds.video = { enabled: false, model: VEO.id };
    await expect(m.admin.saveSettings(off, m.settings.revision(), () => true)).resolves.toMatchObject({
      settings: { kinds: { video: { enabled: false } } },
    });
  });
});

// ---------------------------------------------------------------- review round 4 (#255)

describe("video jobs — review r4 regressions", () => {
  const second = `${KEY}-second`;
  /** Every request answered for `KEY` by the fake server; which key each video request carried, recorded. */
  const recordingKeys = (base = fakeServer()) => {
    const used: { url: string; key: string }[] = [];
    const fetchImpl = (async (u: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      const auth = headers.get("authorization") ?? "";
      if (String(u).startsWith(OPENROUTER_VIDEOS_URL))
        used.push({
          url: String(u),
          key: auth === `Bearer ${second}` ? "second" : auth === `Bearer ${KEY}` ? "env" : "?",
        });
      headers.set("authorization", `Bearer ${KEY}`);
      return base.fetchImpl(u, { ...init, headers });
    }) as typeof fetch;
    return { server: { ...base, fetchImpl }, used };
  };

  it("1 (P1): a key read that fails at approval refuses it — never another account's key; nothing reserved", async () => {
    const { server, used } = recordingKeys();
    let arm = false;
    const t = await start({
      server,
      probe: () => ({
        ...fixtureVideoProbe(),
        ready: async () => {
          arm = true;
          return true;
        },
      }),
    });
    const { admin, keys } = t.app.media!;
    await admin.registerKey(second, admin.generation(), () => true);
    const { jobId } = await t.card();
    expect(t.job(jobId).keyMark).toBe(keys.mark());
    const original = SettingsStore.prototype.get;
    let faults = 0;
    const spy = vi.spyOn(SettingsStore.prototype, "get").mockImplementation(function (
      this: SettingsStore,
      k: string,
    ) {
      if (arm && faults < 2 && k === OPENROUTER_KEY_SETTING) {
        faults++;
        throw new Error("one transient read");
      }
      return original.call(this, k);
    });
    try {
      expect((await t.approve(jobId, 0)).json()).toMatchObject({ error: "video_key_unavailable" });
      expect(t.usage()).toHaveLength(0);
      expect(used.filter((u) => u.url === OPENROUTER_VIDEOS_URL)).toEqual([]);
      expect(t.job(jobId).status).toBe("awaiting_approval");
    } finally {
      spy.mockRestore();
    }
    // Read again: the card's own (admin) key, and only it.
    expect((await t.approve(jobId, 0)).json()).toMatchObject({ status: "pending" });
    expect(used.filter((u) => u.url === OPENROUTER_VIDEOS_URL).map((u) => u.key)).toEqual(["second"]);
  });

  it("2: a 402 whose refusal writes fail is kept by its submit's work — released once the database is back", async () => {
    const clock = { t: Date.now() };
    const t = await start({
      clock,
      limits: { retryMs: 20 },
      server: fakeServer({ submit: () => new Response(null, { status: 402 }) }),
    });
    const { jobId } = await t.card();
    t.db.$client.exec(
      "CREATE TRIGGER temp_refuse BEFORE UPDATE OF status ON video_jobs WHEN NEW.error_code='video_payment' BEGIN SELECT RAISE(ABORT,'transient write'); END",
    );
    await t.approve(jobId, 0);
    // Past its lease, still not judged "not under way" while its work keeps the refusal.
    clock.t = t.due(jobId).at + 1;
    await t.video.tick();
    expect(t.job(jobId).status).toBe("submitting");
    t.db.$client.exec("DROP TRIGGER temp_refuse");
    await vi.waitFor(
      () => expect(t.job(jobId)).toMatchObject({ status: "failed", errorCode: "video_payment" }),
      {
        timeout: 5000,
      },
    );
    expect(t.usage()).toEqual([]);
    expect(t.server.posts()).toHaveLength(1);
  });

  it("3: the admin changes the key while the status is asked: the cost is settled, the content waits for its key", async () => {
    let answer!: () => void;
    const base = fakeServer({
      poll: (id) =>
        new Promise<Response>((r) => {
          answer = () => r(Response.json({ id, status: "completed", usage: { cost: 0.8 } }));
        }),
    });
    const other = `${KEY}-replacement`;
    const check = fixtureOpenRouterFetch();
    const server = {
      ...base,
      fetchImpl: (async (u: string | URL | Request, init?: RequestInit) =>
        new Headers(init?.headers).get("authorization") === `Bearer ${other}`
          ? check(u, init)
          : base.fetchImpl(u, init)) as typeof fetch,
    };
    const t = await start({ server });
    const { jobId } = await t.card();
    await t.approve(jobId, 0);
    t.dueNow();
    const pass = t.video.tick();
    await vi.waitFor(() => expect(answer).toBeTypeOf("function"));
    const { admin } = t.app.media!;
    await admin.registerKey(other, admin.generation(), () => true);
    answer();
    await pass;
    await t.video.idle();
    expect(base.requests.filter((r) => r.url.includes("/content?"))).toHaveLength(0);
    expect(t.job(jobId)).toMatchObject({ status: "downloading", costMicros: 800_000 });
  });

  it("4: a `done` commit that fails once is not the job's end — it is stored by a later pass", async () => {
    const t = await start({
      server: fakeServer({ poll: (id) => Response.json({ id, status: "completed", usage: { cost: 0.8 } }) }),
    });
    const { jobId } = await t.card();
    await t.approve(jobId, 0);
    let once = true;
    t.db.$client.function("r4_fault", () => {
      if (once) {
        once = false;
        throw new Error("one transient commit failure");
      }
      return 0;
    });
    t.db.$client.exec(
      "CREATE TRIGGER r4_bad_commit BEFORE UPDATE OF status ON video_jobs WHEN new.status='done' BEGIN SELECT r4_fault(); END",
    );
    t.dueNow();
    await t.video.tick();
    await t.video.idle();
    expect(once).toBe(false);
    expect(t.job(jobId)).toMatchObject({ status: "downloading", fileId: null });
    t.db.$client.exec("DROP TRIGGER r4_bad_commit");
    expect(await t.drive(jobId)).toMatchObject({ status: "done", costMicros: 800_000 });
    expect(t.db.$client.prepare("SELECT count(*) n FROM files").get()).toEqual({ n: 1 });
    expect(t.server.posts()).toHaveLength(1);
  });

  it("5: a download cut at the deadline ends as video_timeout (its settled cost kept)", async () => {
    const base = fakeServer({
      poll: (id) => Response.json({ id, status: "completed", usage: { cost: 0.8 } }),
    });
    const server = {
      ...base,
      fetchImpl: (async (u: string | URL | Request, init?: RequestInit) => {
        if (String(u).includes("/content?"))
          return new Response(
            new ReadableStream({
              start(c) {
                init!.signal!.addEventListener("abort", () => c.error(new Error("connection aborted")), {
                  once: true,
                });
              },
            }),
          );
        return base.fetchImpl(u, init);
      }) as typeof fetch,
    };
    const t = await start({ server, limits: { deadlineMs: 800, pollMs: 0 } });
    const { jobId } = await t.card();
    await t.approve(jobId, 0);
    t.dueNow();
    await t.video.tick();
    await t.video.idle();
    expect(t.job(jobId)).toMatchObject({ status: "failed", errorCode: "video_timeout", costMicros: 800_000 });
  });

  it("6: a visible status or progress change is a new version (an older answer never wins on the card)", async () => {
    const t = await start();
    const { jobId } = await t.card();
    await t.approve(jobId, 0);
    const before = t.video.view(t.job(jobId));
    t.dueNow();
    await t.video.tick();
    const after = t.video.view(t.job(jobId));
    expect(after).toMatchObject({ status: "in_progress", progress: 40 });
    expect(after.version).toBeGreaterThan(before.version);
    expect(newestJob(after, before).status).toBe("in_progress");
  });

  it("7: a key save that rolls back never shows the waiting card an expiry", async () => {
    const t = await start();
    const { jobId } = await t.card();
    const seen: string[] = [];
    const off = t.video.subscribe(jobId, () => seen.push(t.job(jobId).status));
    const { admin, keys } = t.app.media!;
    const mark = keys.mark();
    t.db.$client.exec(`CREATE TABLE r4_parent (id INTEGER PRIMARY KEY);
      CREATE TABLE r4_child (id INTEGER REFERENCES r4_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER r4_defer AFTER UPDATE OF status ON video_jobs WHEN new.status='expired' BEGIN INSERT INTO r4_child VALUES(123); END`);
    try {
      await expect(admin.registerKey(KEY, admin.generation(), () => true)).rejects.toThrow();
      await new Promise((r) => setImmediate(r));
      expect(t.job(jobId)).toMatchObject({ status: "awaiting_approval", version: 0 });
      expect(keys.mark()).toBe(mark);
      expect(seen).toEqual([]);
    } finally {
      off();
      t.db.$client.exec("DROP TRIGGER r4_defer");
    }
    // A save that commits: the card hears its expiry.
    await admin.registerKey(KEY, admin.generation(), () => true);
    await new Promise((r) => setImmediate(r));
    expect(t.job(jobId).status).toBe("expired");
  });

  it("8: a start sweep that fails is tried again later — around the folders of downloads under way", async () => {
    const t = await start({ engine: false });
    const root = path.join(t.dataDir, "video-scratch");
    const old = path.join(root, crypto.randomUUID());
    fs.mkdirSync(old, { recursive: true });
    fs.writeFileSync(path.join(old, "video.mp4"), "partial");
    const orig = fs.readdirSync;
    const spy = vi.spyOn(fs, "readdirSync").mockImplementation(function (p: fs.PathLike, ...args: unknown[]) {
      if (p === root) throw new Error("one transient scratch read");
      return (orig as (...a: unknown[]) => unknown)(p, ...args);
    } as typeof fs.readdirSync);
    try {
      t.video.start();
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(old)).toBe(true);
    // Approvals are taken (the recovery itself succeeded); the next pass removes the old folder.
    const { jobId } = await t.card();
    expect((await t.approve(jobId, 0)).statusCode).toBe(200);
    await t.video.tick();
    expect(fs.existsSync(old)).toBe(false);
  });

  it("9: settings saved with very many waiting cards: one statement, video turned off", async () => {
    const t = await start();
    const { jobId } = await t.card();
    const db = t.db.$client;
    const columns = (db.prepare("PRAGMA table_info(video_jobs)").all() as { name: string }[]).map(
      (r) => r.name,
    );
    db.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<32766) INSERT INTO video_jobs (${columns.join(",")}) SELECT ${columns
        .map((k) => (k === "id" ? "('copy-' || i)" : `s.${k}`))
        .join(",")} FROM video_jobs s, n WHERE s.id=?`,
    ).run(jobId);
    const { settings, admin } = t.app.media!;
    const off = settings.get();
    off.kinds.video.enabled = false;
    await expect(admin.saveSettings(off, settings.revision(), () => true)).resolves.toBeDefined();
    expect(settings.get().kinds.video.enabled).toBe(false);
    expect(db.prepare("SELECT count(*) n FROM video_jobs WHERE status = 'awaiting_approval'").get()).toEqual({
      n: 0,
    });
  });
});

// ---------------------------------------------------------------- review round 5 (#255)

describe("video jobs — review r5 regressions", () => {
  const refuseWrite = (t: Awaited<ReturnType<typeof start>>) =>
    t.db.$client.exec(
      "CREATE TRIGGER r5_refusal BEFORE UPDATE OF status ON video_jobs WHEN NEW.error_code='video_payment' BEGIN SELECT RAISE(ABORT,'transient write'); END",
    );

  it("1: a conversation deleted while its known 402 is still being recorded: the reservation is released", async () => {
    const t = await start({
      limits: { retryMs: 150 },
      server: fakeServer({ submit: () => new Response(null, { status: 402 }) }),
    });
    const { jobId, scope } = await t.card();
    refuseWrite(t);
    expect((await t.approve(jobId, 0)).json().status).toBe("submitting");
    t.db.$client.exec("DROP TRIGGER r5_refusal");
    const del = await t.app.inject({
      method: "DELETE",
      url: `/api/conversations/${scope.conversationId}`,
      headers: { ...WRITE, cookie: t.f.cookies.owner },
    });
    expect(del.statusCode).toBeLessThan(300);
    expect(t.video.get(jobId)).toBeUndefined();
    await t.video.idle();
    expect(t.usage()).toEqual([]);
    expect(t.server.posts()).toHaveLength(1);
  });

  it("2: a read that fails inside a retry is that retry's failure — the refusal is still recorded, nothing rejects", async () => {
    const t = await start({
      limits: { retryMs: 100 },
      server: fakeServer({ submit: () => new Response(null, { status: 402 }) }),
    });
    const { jobId } = await t.card();
    refuseWrite(t);
    expect((await t.approve(jobId, 0)).json().status).toBe("submitting");
    t.db.$client.exec("DROP TRIGGER r5_refusal");
    const read = t.video.get.bind(t.video);
    const spy = vi
      .spyOn(t.video, "get")
      .mockImplementationOnce(() => {
        throw new Error("transient read");
      })
      .mockImplementation(read);
    try {
      await expect(t.video.idle()).resolves.toBeUndefined();
    } finally {
      spy.mockRestore();
    }
    expect(t.job(jobId)).toMatchObject({ status: "failed", errorCode: "video_payment" });
    expect(t.usage()).toEqual([]);
  });

  it("3: a state read that fails in the file lock's guard: the job stays downloading and is stored by a later pass", async () => {
    const clock = { t: Date.now() };
    const t = await start({
      clock,
      server: fakeServer({ poll: (id) => Response.json({ id, status: "completed", usage: { cost: 0.8 } }) }),
    });
    const { jobId } = await t.card();
    await t.approve(jobId, 0);
    const approved = clock.t;
    const store = t.app.files!;
    const add = store.addGenerated.bind(store);
    const spy = vi.spyOn(store, "addGenerated").mockImplementationOnce((input) =>
      add({
        ...input,
        guard: () => {
          const once = vi.spyOn(t.video, "get").mockImplementationOnce(() => {
            throw new Error("temporary DB read failure in file guard");
          });
          try {
            return input.guard!();
          } finally {
            once.mockRestore();
          }
        },
      }),
    );
    clock.t = approved + 45 * 60_000;
    await t.video.tick();
    await t.video.idle();
    spy.mockRestore();
    expect(t.job(jobId)).toMatchObject({ status: "downloading", fileId: null });
    // A short backoff, not the lease.
    expect(t.due(jobId).at - clock.t).toBeLessThanOrEqual(5 * 60_000);
    for (let i = 0; i < 80 && t.job(jobId).status === "downloading"; i++) {
      clock.t += 5_000;
      await t.video.tick();
      await t.video.idle();
    }
    expect(t.job(jobId)).toMatchObject({ status: "done", costMicros: 800_000 });
    // This process's own lease with no work of it under way (its work ended without clearing it) is taken at once.
    const other = await t.card();
    await t.approve(other.jobId, 0);
    t.db.$client
      .prepare("UPDATE video_jobs SET next_at = ?, lease_boot = ?, lease_until = ? WHERE id = ?")
      .run(clock.t + 60_000, t.video.boot, clock.t + 17 * 60_000, other.jobId);
    await t.video.tick();
    await t.video.idle();
    expect(t.job(other.jobId).status).not.toBe("pending");
  });

  it("4: a terminal answer handled at the deadline ends as video_timeout", async () => {
    const clock = { t: Date.now() };
    const deadline = clock.t + 3_600_000;
    const t = await start({
      clock,
      server: fakeServer({
        poll: (id) => {
          clock.t = deadline;
          return Response.json({ id, status: "expired" });
        },
      }),
    });
    const { jobId } = await t.card();
    await t.approve(jobId, 0);
    clock.t = deadline - 1;
    t.dueNow();
    await t.video.tick();
    await t.video.idle();
    expect(t.job(jobId)).toMatchObject({ status: "failed", errorCode: "video_timeout" });
    expect(t.usage()[0]?.s).toBe("unconfirmed");
  });

  it("5: a retried sweep never removes a readiness check's folder under way", async () => {
    const slot: { probe?: VideoProbe } = {};
    const t = await start({ engine: false, probe: () => slot.probe });
    const root = path.join(t.dataDir, "video-scratch");
    fs.mkdirSync(root, { recursive: true });
    const original = fs.readdirSync;
    const spy = vi.spyOn(fs, "readdirSync").mockImplementation(function (p: fs.PathLike, ...args: unknown[]) {
      if (p === root) throw new Error("temporary scratch error");
      return (original as (...a: unknown[]) => unknown)(p, ...args);
    } as typeof fs.readdirSync);
    try {
      t.video.start();
    } finally {
      spy.mockRestore();
    }
    const probe = fixtureVideoProbe(t.dataDir);
    slot.probe = probe;
    const check = probe.check.bind(probe);
    let readyFile: string | undefined;
    let proceed!: () => void;
    probe.check = async (file, signal) => {
      readyFile = file;
      await new Promise<void>((r) => (proceed = r));
      return check(file, signal);
    };
    const { jobId } = await t.card();
    const approval = t.approve(jobId, 0);
    await vi.waitFor(() => expect(readyFile).toBeTruthy());
    await t.video.tick();
    expect(fs.existsSync(readyFile!)).toBe(true);
    proceed();
    expect((await approval).json()).toMatchObject({ status: "pending" });
  });

  it("6: a working folder whose removal failed is swept by a later pass", async () => {
    const base = fakeServer({
      poll: (id) => Response.json({ id, status: "completed", usage: { cost: 0.8 } }),
    });
    const t = await start({
      server: base,
      probe: () => ({ ready: async () => true, check: async () => "failed" }),
    });
    const { jobId } = await t.card();
    await t.approve(jobId, 0);
    const root = path.join(t.dataDir, "video-scratch");
    const rm = fs.rmSync;
    const spy = vi.spyOn(fs, "rmSync").mockImplementation((file, ...args) => {
      if (typeof file === "string" && path.dirname(file) === root) throw new Error("transient cleanup error");
      return rm(file, ...args);
    });
    try {
      await t.drive(jobId);
    } finally {
      spy.mockRestore();
    }
    expect(fs.readdirSync(root)).toHaveLength(1);
    await t.video.tick();
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

// ---------------------------------------------------------------- review round 6 (#255)

describe("video jobs — review r6 regressions (explicit leases, one end judgement)", () => {
  const completed = (id: string) => Response.json({ id, status: "completed", usage: { cost: 0.8 } });
  const mp4 = () => new Response(new Uint8Array(fixtureMp4()), { headers: { "content-type": "video/mp4" } });
  const contents = (server: ReturnType<typeof fakeServer>) =>
    server.requests.filter((r) => r.url.includes("/content?")).length;

  it("A: a lease of this process whose work ended without clearing it is taken by the next pass, whatever its time left", async () => {
    const base = Date.now();
    const min = 60_000;
    const clock = { t: base };
    const server = fakeServer({
      poll: (id) => completed(id),
      content: () => {
        clock.t = base + 56 * min;
        return mp4();
      },
    });
    const t = await start({ clock, server });
    const { jobId } = await t.card();
    await t.approve(jobId, 0);
    t.db.$client.exec(`
      CREATE TRIGGER r6_commit BEFORE UPDATE OF status ON video_jobs WHEN NEW.status='done' BEGIN SELECT RAISE(ABORT,'temporary commit failure'); END;
      CREATE TRIGGER r6_backoff BEFORE UPDATE OF failures ON video_jobs WHEN NEW.failures>0 BEGIN SELECT RAISE(ABORT,'temporary schedule write failure'); END;
    `);
    clock.t = base + 43 * min;
    t.dueNow();
    await t.video.tick();
    await t.video.idle();
    t.db.$client.exec("DROP TRIGGER r6_commit; DROP TRIGGER r6_backoff");
    expect(t.job(jobId)).toMatchObject({ status: "downloading", leaseBoot: t.video.boot, fileId: null });
    clock.t += 5000;
    await t.video.tick();
    await t.video.idle();
    expect(t.job(jobId)).toMatchObject({ status: "done", costMicros: 800_000, leaseBoot: null });
    expect(contents(server)).toBe(2);
    expect(server.posts()).toHaveLength(1);
  });

  it("B: a held refusal wins over the deadline — released, its own code, never charged", async () => {
    const base = Date.now();
    const clock = { t: base };
    const t = await start({
      clock,
      server: fakeServer({ submit: () => new Response(null, { status: 402 }) }),
      limits: { retryMs: 60_000 },
    });
    const { jobId, scope } = await t.card();
    t.db.$client.exec(
      "CREATE TRIGGER r6_refusal BEFORE UPDATE OF status ON video_jobs WHEN NEW.error_code='video_payment' BEGIN SELECT RAISE(ABORT,'transient write'); END",
    );
    expect((await t.approve(jobId, 0)).json().status).toBe("submitting");
    t.db.$client.exec("DROP TRIGGER r6_refusal");
    clock.t = base + 3_600_000;
    await t.video.tick();
    expect(t.job(jobId)).toMatchObject({ status: "failed", errorCode: "video_payment" });
    expect(t.usage()).toEqual([]);
    t.app.conversations!.delete(scope.conversationId);
    expect(t.usage()).toEqual([]);
  });

  it("B: a submit still without its answer when the conversation goes keeps its bound", async () => {
    let deliver!: (r: Response) => void;
    const t = await start({
      server: fakeServer({ submit: () => new Promise<Response>((r) => (deliver = r)) }),
    });
    const { jobId, scope } = await t.card();
    const sending = t.approve(jobId, 0);
    await vi.waitFor(() => expect(deliver).toBeDefined());
    t.app.conversations!.delete(scope.conversationId);
    deliver(Response.json({ id: rid(1) }, { status: 202 }));
    await sending;
    await t.video.idle();
    await t.video.tick();
    expect(t.usage()).toEqual([expect.objectContaining({ s: "unconfirmed", e: VEO_8S_MICROS })]);
    expect(t.server.posts()).toHaveLength(1);
  });

  it("B: an HTTP 410 handled at the deadline ends as video_timeout", async () => {
    const base = Date.now();
    const clock = { t: base };
    const t = await start({
      clock,
      server: fakeServer({
        poll: () => {
          clock.t = base + 3_600_000;
          return new Response(null, { status: 410 });
        },
      }),
    });
    const { jobId } = await t.card();
    await t.approve(jobId, 0);
    clock.t = base + 3_600_000 - 1;
    t.dueNow();
    await t.video.tick();
    await t.video.idle();
    expect(t.job(jobId)).toMatchObject({ status: "failed", errorCode: "video_timeout" });
    expect(t.usage()[0]?.s).toBe("unconfirmed");
  });

  it("C: an event that cannot be built closes its stream (never left open behind the job)", async () => {
    const clock = { t: Date.now() };
    const t = await start({ clock, server: fakeServer({ poll: (id) => completed(id) }) });
    const { jobId } = await t.card();
    await t.approve(jobId, 0);
    const watching = vi.spyOn(t.video, "subscribe");
    let ended = false;
    const sse = t.api(t.f.cookies.owner, "GET", `/api/video-jobs/${jobId}/events`).then((r) => {
      ended = true;
      return r;
    });
    await vi.waitFor(() => expect(watching).toHaveBeenCalled());
    const get = vi.spyOn(t.app.files!, "get").mockImplementationOnce(() => {
      throw new Error("temporary file lookup failure");
    });
    t.dueNow();
    await t.video.tick();
    await t.video.idle();
    get.mockRestore();
    expect(t.job(jobId).status).toBe("done");
    await vi.waitFor(() => expect(ended).toBe(true));
    const frames = (await sse).body
      .split("\n")
      .filter((l) => l.startsWith("data: "))
      .map((l) => (JSON.parse(l.slice(6)) as { status: string }).status);
    expect(frames[0]).toBe("pending");
    // A new read (the card's fallback) has the end.
    expect((await t.api(t.f.cookies.owner, "GET", `/api/video-jobs/${jobId}`)).json().status).toBe("done");
  });

  it("D: a readiness check's folder whose removal failed is swept by a later pass", async () => {
    const slot = { dir: "" };
    const t = await start({ probe: () => fixtureVideoProbe(slot.dir) });
    slot.dir = t.dataDir;
    const { jobId } = await t.card();
    const root = path.join(t.dataDir, "video-scratch");
    const rm = fs.rmSync;
    const spy = vi.spyOn(fs, "rmSync").mockImplementation((f, ...args) => {
      if (typeof f === "string" && path.dirname(f) === root) throw new Error("temporary cleanup error");
      return rm(f, ...args);
    });
    try {
      expect((await t.approve(jobId, 0)).json().status).toBe("pending");
    } finally {
      spy.mockRestore();
    }
    expect(fs.readdirSync(root)).toHaveLength(1);
    await t.video.tick();
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

// ---------------------------------------------------------------- review round 7 (#255)

describe("video jobs — review r7 regressions (held outcomes)", () => {
  const completed = (id: string) => Response.json({ id, status: "completed", usage: { cost: 0.8 } });
  const restart = (t: Awaited<ReturnType<typeof start>>, server: ReturnType<typeof fakeServer>) => {
    const next = new VideoJobs({
      db: t.db,
      files: () => t.app.files,
      conversations: t.app.conversations!,
      keys: t.app.media!.keys,
      settings: t.app.media!.settings,
      budget: t.app.media!.budget,
      usage: t.app.usageStore,
      users: t.app.users!,
      notifications: () => t.app.notifications,
      probe: () => fixtureVideoProbe(),
      dataDir: t.dataDir,
      fetchImpl: server.fetchImpl,
      limits: { tickMs: 3_600_000 },
    });
    next.start();
    closers.push(() => next.stop());
    return next;
  };

  it("1: a reported cost whose write fails once is recorded by its own retry — not lost to the deadline", async () => {
    const clock = { t: Date.now() };
    const server = fakeServer({ poll: (id) => completed(id) });
    const t = await start({ server, clock, limits: { retryMs: 20 } });
    const { jobId } = await t.card();
    await t.approve(jobId, 0);
    const deadline = t.job(jobId).deadlineAt!;
    clock.t = deadline - 25_000;
    const settle = vi.spyOn(t.app.usageStore!, "settleMedia").mockImplementationOnce(() => {
      throw new Error("temporary write");
    });
    t.dueNow();
    await t.video.tick();
    settle.mockRestore();
    await vi.waitFor(() => expect(t.job(jobId).costMicros).toBe(800_000), { timeout: 5000 });
    expect(t.usage()).toEqual([expect.objectContaining({ s: "settled", p: 800_000 })]);
    // The status was asked once for it: the cost was not asked again.
    expect(server.requests.filter((x) => x.url === videoStatusUrl(rid(1)))).toHaveLength(1);
  });

  it("1: a cost still held at the deadline is recorded with the timeout", async () => {
    const clock = { t: Date.now() };
    const server = fakeServer({ poll: (id) => completed(id) });
    const t = await start({ server, clock, limits: { retryMs: 60_000 } });
    const { jobId } = await t.card();
    await t.approve(jobId, 0);
    const settle = vi.spyOn(t.app.usageStore!, "settleMedia").mockImplementationOnce(() => {
      throw new Error("temporary write");
    });
    t.dueNow();
    await t.video.tick();
    settle.mockRestore();
    clock.t = t.job(jobId).deadlineAt!;
    await t.video.tick();
    expect(t.job(jobId)).toMatchObject({ status: "failed", errorCode: "video_timeout", costMicros: 800_000 });
    expect(t.usage()).toEqual([expect.objectContaining({ s: "settled", p: 800_000 })]);
  });

  it("1: a completed answer handled exactly at the deadline records its cost", async () => {
    const base = Date.now();
    const clock = { t: base };
    const server = fakeServer({
      poll: (id) => {
        clock.t = base + 3_600_000;
        return completed(id);
      },
    });
    const t = await start({ server, clock });
    const { jobId } = await t.card();
    await t.approve(jobId, 0);
    clock.t = base + 3_600_000 - 1;
    t.dueNow();
    await t.video.tick();
    await t.video.idle();
    expect(t.job(jobId)).toMatchObject({ status: "failed", errorCode: "video_timeout", costMicros: 800_000 });
    expect(t.usage()).toEqual([expect.objectContaining({ s: "settled", p: 800_000 })]);
    expect(server.requests.filter((x) => x.url.includes("/content?"))).toHaveLength(0);
  });

  for (const kind of ["402", "202"] as const)
    it(`2: a graceful stop records a held ${kind} before the database goes`, async () => {
      const server = fakeServer({
        submit: () =>
          kind === "402"
            ? new Response(null, { status: 402 })
            : Response.json({ id: rid(1) }, { status: 202 }),
      });
      const t = await start({ server, limits: { retryMs: 30_000 } });
      const { jobId } = await t.card();
      const condition = kind === "402" ? "NEW.error_code='video_payment'" : "NEW.status='pending'";
      t.db.$client.exec(
        `CREATE TRIGGER r7_block BEFORE UPDATE OF status ON video_jobs WHEN ${condition} BEGIN SELECT RAISE(ABORT,'temporary'); END`,
      );
      expect((await t.approve(jobId, 0)).json().status).toBe("submitting");
      t.db.$client.exec("DROP TRIGGER r7_block");
      await t.video.stop();
      if (kind === "402") {
        expect(t.job(jobId)).toMatchObject({ status: "failed", errorCode: "video_payment" });
        expect(t.usage()).toEqual([]);
      } else {
        expect(t.job(jobId)).toMatchObject({ status: "pending", remoteId: rid(1) });
        const next = restart(t, server);
        for (let i = 0; i < 5 && next.get(jobId)!.status !== "done"; i++) {
          t.dueNow();
          await next.tick();
          await next.idle();
        }
        expect(next.get(jobId)!.status).toBe("done");
      }
      expect(server.posts()).toHaveLength(1);
    });

  it("3: the engine stopping while the model is looked up: nothing reserved or sent", async () => {
    const base = fakeServer();
    let hold = false;
    let resume!: () => void;
    const fetchImpl: typeof fetch = async (url, opts) => {
      if (hold && String(url) === MEDIA_CATALOG_URLS.video) await new Promise<void>((r) => (resume = r));
      return base.fetchImpl(url, opts);
    };
    const t = await start({ server: { ...base, fetchImpl } });
    const { jobId } = await t.card();
    hold = true;
    const request = t.approve(jobId, 0);
    await vi.waitFor(() => expect(resume).toBeDefined());
    await t.video.stop();
    resume();
    expect((await request).json()).toMatchObject({ error: "video_engine_unavailable" });
    expect(base.posts()).toHaveLength(0);
    expect(t.usage()).toEqual([]);
    expect(t.job(jobId).status).toBe("awaiting_approval");
  });

  it("4: a long retry leaves no abort listeners behind its waits", async () => {
    const { getEventListeners } = await import("node:events");
    const t = await start({
      limits: { retryMs: 10 },
      server: fakeServer({ submit: () => new Response(null, { status: 402 }) }),
    });
    const { jobId } = await t.card();
    t.db.$client.exec(
      "CREATE TRIGGER r7_refuse BEFORE UPDATE OF status ON video_jobs WHEN NEW.error_code='video_payment' BEGIN SELECT RAISE(ABORT,'temporary'); END",
    );
    expect((await t.approve(jobId, 0)).json().status).toBe("submitting");
    const { stop } = (
      t.video as unknown as { inflight: Map<string, { stop: AbortController }> }
    ).inflight.get(jobId)!;
    await new Promise((r) => setTimeout(r, 400));
    expect(getEventListeners(stop.signal, "abort").length).toBeLessThanOrEqual(1);
    t.db.$client.exec("DROP TRIGGER r7_refuse");
    await vi.waitFor(() => expect(t.job(jobId).errorCode).toBe("video_payment"), { timeout: 5000 });
    expect(t.usage()).toEqual([]);
  });

  it("5: a provenance read that fails before the inline file is opened leaves no descriptor", async () => {
    const t = await start();
    const { jobId } = await t.card();
    await t.approve(jobId, 0);
    const row = await t.drive(jobId);
    const store = t.app.files!;
    const open = vi.spyOn(store, "open");
    const fail = vi.spyOn(store, "isVerifiedVideo").mockImplementationOnce(() => {
      throw new Error("transient read failure");
    });
    try {
      const url = `/api/files/${row.fileId}/content?inline=1`;
      expect((await t.api(t.f.cookies.owner, "GET", url)).statusCode).toBe(500);
      expect(open).not.toHaveBeenCalled();
      expect((await t.api(t.f.cookies.owner, "GET", url)).statusCode).toBe(200);
    } finally {
      fail.mockRestore();
      open.mockRestore();
    }
  });
});

// ---------------------------------------------------------------- review round 8 (#255)

describe("video jobs — review r8 regressions (a held outcome is dropped only once its row reflects it)", () => {
  const completed = (id: string, usd = 0.8) =>
    Response.json({ id, status: "completed", usage: { cost: usd } });
  const noWrite = () => {
    throw new Error("temporary write");
  };
  const restart = (t: Awaited<ReturnType<typeof start>>) => {
    const next = new VideoJobs({
      db: t.db,
      files: () => t.app.files,
      conversations: t.app.conversations!,
      keys: t.app.media!.keys,
      settings: t.app.media!.settings,
      budget: t.app.media!.budget,
      usage: t.app.usageStore,
      users: t.app.users!,
      notifications: () => t.app.notifications,
      probe: () => fixtureVideoProbe(),
      dataDir: t.dataDir,
      fetchImpl: t.server.fetchImpl,
      limits: { tickMs: 3_600_000 },
    });
    next.start();
    closers.push(() => next.stop());
    return next;
  };

  it("1: an accepted id whose commit's read-back failed is recorded — polling resumes", async () => {
    const clock = { t: Date.now() };
    const t = await start({ clock, limits: { retryMs: 10 } });
    const { jobId } = await t.card();
    const read = t.video.get.bind(t.video);
    let injected = 0;
    const spy = vi.spyOn(t.video, "get").mockImplementation((id) => {
      const row = read(id);
      if (row?.status === "pending" && injected === 0) {
        injected++;
        noWrite();
      }
      return row;
    });
    await t.approve(jobId, 0);
    expect(injected).toBe(1);
    spy.mockRestore();
    await t.video.idle();
    expect(await t.drive(jobId)).toMatchObject({ status: "done" });
    expect(t.server.requests.filter((r) => r.url === videoStatusUrl(rid(1))).length).toBeGreaterThan(0);
    expect(t.server.posts()).toHaveLength(1);
  });

  it("2: a conversation deleted while a reported cost is held: the delete settles it first", async () => {
    const server = fakeServer({ poll: (id) => completed(id) });
    const t = await start({ server, limits: { retryMs: 30_000 } });
    const { jobId, scope } = await t.card();
    await t.approve(jobId, 0);
    const settle = vi.spyOn(t.app.usageStore!, "settleMedia").mockImplementationOnce(noWrite);
    t.dueNow();
    await t.video.tick();
    settle.mockRestore();
    expect(t.usage()[0]).toMatchObject({ s: "video_job", p: null });
    const res = await t.app.inject({
      method: "DELETE",
      url: `/api/conversations/${scope.conversationId}`,
      headers: { ...WRITE, cookie: t.f.cookies.owner },
    });
    expect(res.statusCode).toBeLessThan(300);
    await t.video.idle();
    expect(t.video.get(jobId)).toBeUndefined();
    expect(t.usage()).toEqual([expect.objectContaining({ s: "settled", p: 800_000 })]);
  });

  it("2: a delete whose settling of a held cost fails rolls back (the job and its cost stay)", async () => {
    const server = fakeServer({ poll: (id) => completed(id) });
    const t = await start({ server, limits: { retryMs: 30_000 } });
    const { jobId, scope } = await t.card();
    await t.approve(jobId, 0);
    const settle = vi.spyOn(t.app.usageStore!, "settleMedia").mockImplementation(noWrite);
    t.dueNow();
    await t.video.tick();
    expect(() => t.app.conversations!.delete(scope.conversationId)).toThrow();
    settle.mockRestore();
    expect(t.video.get(jobId)).toBeDefined();
  });

  it("3: a cost parsed from a completed answer is held before any further read", async () => {
    const clock = { t: Date.now() };
    let failNext = false;
    const server = fakeServer({
      poll: (id) => {
        failNext = true;
        return completed(id);
      },
    });
    const t = await start({ clock, server, limits: { retryMs: 20 } });
    const { jobId } = await t.card();
    await t.approve(jobId, 0);
    const deadline = t.job(jobId).deadlineAt!;
    const read = t.video.get.bind(t.video);
    const spy = vi.spyOn(t.video, "get").mockImplementation((id) => {
      if (failNext) {
        failNext = false;
        noWrite();
      }
      return read(id);
    });
    clock.t = deadline - 25_000;
    t.dueNow();
    await t.video.tick();
    spy.mockRestore();
    await vi.waitFor(() => expect(t.job(jobId).costMicros).toBe(800_000), { timeout: 5000 });
    expect(t.usage()[0]).toMatchObject({ s: "settled", p: 800_000 });
    expect(server.requests.filter((r) => r.url === videoStatusUrl(rid(1)))).toHaveLength(1);
  });

  it("4: a stop waits for a submit's answer and records the refusal it got meanwhile", async () => {
    let finishCancel: (() => void) | undefined;
    const server = fakeServer({
      submit: () =>
        new Response(
          new ReadableStream({
            cancel() {
              return new Promise<void>((resolve) => (finishCancel = resolve));
            },
          }),
          { status: 402 },
        ),
    });
    const t = await start({ server, limits: { retryMs: 15 } });
    const { jobId } = await t.card();
    const release = vi
      .spyOn(t.app.usageStore!, "releaseVideoMedia")
      .mockImplementationOnce(noWrite)
      .mockImplementationOnce(noWrite);
    const approval = t.approve(jobId, 0);
    await vi.waitFor(() => expect(finishCancel).toBeDefined());
    const stopped = t.video.stop();
    finishCancel!();
    await Promise.all([approval, stopped]);
    release.mockRestore();
    expect(t.job(jobId)).toMatchObject({ status: "failed", errorCode: "video_payment" });
    expect(t.usage()).toEqual([]);
    const next = restart(t);
    await next.tick();
    expect(next.get(jobId)).toMatchObject({ errorCode: "video_payment" });
    expect(server.posts()).toHaveLength(1);
  });

  it("4: a retry's held cost is recorded by the stop's final flush", async () => {
    const server = fakeServer({ poll: (id, n) => completed(id, n === 1 ? 0.8 : 0.99) });
    const t = await start({ server, limits: { retryMs: 30_000 } });
    const { jobId } = await t.card();
    await t.approve(jobId, 0);
    const settle = vi.spyOn(t.app.usageStore!, "settleMedia").mockImplementationOnce(noWrite);
    t.dueNow();
    await t.video.tick();
    await t.video.stop();
    settle.mockRestore();
    expect(t.job(jobId).costMicros).toBe(800_000);
    expect(t.usage()).toEqual([expect.objectContaining({ s: "settled", p: 800_000 })]);
  });

  it("5: a cost recorded by its retry is a new version the open card hears", async () => {
    const t = await start({ server: fakeServer({ poll: (id) => completed(id) }), limits: { retryMs: 20 } });
    const { jobId } = await t.card();
    await t.approve(jobId, 0);
    const seen: (number | null)[] = [];
    const off = t.video.subscribe(jobId, () => seen.push(t.video.view(t.job(jobId)).costUsd));
    const settle = vi.spyOn(t.app.usageStore!, "settleMedia").mockImplementationOnce(noWrite);
    const before = t.job(jobId).version;
    t.dueNow();
    await t.video.tick();
    settle.mockRestore();
    await vi.waitFor(() => expect(t.job(jobId).costMicros).toBe(800_000), { timeout: 5000 });
    off();
    expect(t.job(jobId).version).toBeGreaterThan(before);
    expect(seen).toContain(0.8);
  });
});

// ---------------------------------------------------------------- review round 9 (#255)

describe("video jobs — review r9 regressions (outcomes held at once; one stop budget)", () => {
  const completed = (id: string, usd = 0.8) =>
    Response.json({ id, status: "completed", usage: { cost: usd } });
  const noWrite = () => {
    throw new Error("temporary write");
  };

  it("1: the stop's flush keeps trying an outcome until the row reflects it (an accepted id)", async () => {
    const t = await start({ limits: { retryMs: 30_000 } });
    const { jobId } = await t.card();
    let failed = 0;
    t.db.$client.function("r9_fail", () => {
      if (++failed <= 2) throw new Error("temporary");
      return 0;
    });
    t.db.$client.exec(
      "CREATE TRIGGER r9_accept BEFORE UPDATE OF remote_id ON video_jobs WHEN NEW.remote_id IS NOT NULL BEGIN SELECT r9_fail(); END",
    );
    await t.approve(jobId, 0);
    expect(t.job(jobId)).toMatchObject({ status: "submitting", remoteId: null });
    await t.video.stop();
    expect(failed).toBeGreaterThanOrEqual(3);
    expect(t.job(jobId)).toMatchObject({ status: "pending", remoteId: rid(1) });
    t.db.$client.exec("DROP TRIGGER r9_accept");
  });

  it("1: … and a reported cost", async () => {
    const t = await start({
      server: fakeServer({ poll: (id) => completed(id) }),
      limits: { retryMs: 30_000 },
    });
    const { jobId } = await t.card();
    await t.approve(jobId, 0);
    const settle = vi
      .spyOn(t.app.usageStore!, "settleMedia")
      .mockImplementationOnce(noWrite)
      .mockImplementationOnce(noWrite);
    t.dueNow();
    await t.video.tick();
    await t.video.stop();
    settle.mockRestore();
    expect(t.job(jobId).costMicros).toBe(800_000);
    expect(t.usage()).toEqual([expect.objectContaining({ s: "settled", p: 800_000 })]);
  });

  it("1: an outcome the database never takes within the budget is logged (video.held_lost) — the stop still returns", async () => {
    const t = await start({ limits: { retryMs: 30_000 } });
    const { jobId } = await t.card();
    t.db.$client.exec(
      "CREATE TRIGGER r9_never BEFORE UPDATE OF remote_id ON video_jobs WHEN NEW.remote_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'unwritable'); END",
    );
    await t.approve(jobId, 0);
    const lines: unknown[] = [];
    const log = vi
      .spyOn(t.app.log, "warn")
      .mockImplementation(((...a: unknown[]) => void lines.push(a)) as never);
    try {
      const before = Date.now();
      await t.video.stop();
      expect(Date.now() - before).toBeLessThan(12_000);
      expect(JSON.stringify(lines)).toContain("video.held_lost");
    } finally {
      log.mockRestore();
      t.db.$client.exec("DROP TRIGGER r9_never");
    }
  }, 30_000);

  it("2: a 402 is known the moment its headers come — a delete before its body is let go releases the bound", async () => {
    let finishCancel: (() => void) | undefined;
    const server = fakeServer({
      submit: () =>
        new Response(
          new ReadableStream({
            cancel() {
              return new Promise<void>((resolve) => (finishCancel = resolve));
            },
          }),
          { status: 402 },
        ),
    });
    const t = await start({ server, limits: { retryMs: 5 } });
    const { jobId, scope } = await t.card();
    const approval = t.approve(jobId, 0);
    await vi.waitFor(() => expect(finishCancel).toBeDefined());
    try {
      const del = await t.app.inject({
        method: "DELETE",
        url: `/api/conversations/${scope.conversationId}`,
        headers: { ...WRITE, cookie: t.f.cookies.owner },
      });
      expect(del.statusCode).toBe(200);
    } finally {
      finishCancel!();
    }
    await approval;
    await t.video.idle();
    expect(t.video.get(jobId)).toBeUndefined();
    expect(t.usage()).toEqual([]);
    expect(server.posts()).toHaveLength(1);
  });

  it("3: a stop under a held database lock returns within its one budget", async () => {
    const DatabaseCtor = (await import("better-sqlite3")).default;
    let unblock: ((r: Response) => void) | undefined;
    const server = fakeServer({
      submit: (_b, n) =>
        n === 1
          ? new Promise<Response>((resolve) => (unblock = resolve))
          : Response.json({ id: rid(n) }, { status: 202 }),
    });
    const t = await start({ server, limits: { retryMs: 30_000 } });
    const first = await t.card();
    const second = await t.card();
    const a = t.approve(first.jobId, 0);
    await vi.waitFor(() => expect(unblock).toBeDefined());
    t.db.$client.exec(
      "CREATE TRIGGER r9_once BEFORE UPDATE OF remote_id ON video_jobs BEGIN SELECT RAISE(ABORT,'temporary'); END",
    );
    await t.approve(second.jobId, 0);
    t.db.$client.exec("DROP TRIGGER r9_once");
    if (!t.db.$client.name || t.db.$client.memory) {
      // An in-memory test database has no second connection to hold its lock: the budget is checked without it.
      const before = Date.now();
      await t.video.stop();
      expect(Date.now() - before).toBeLessThan(11_500);
    } else {
      const writer = new DatabaseCtor(t.db.$client.name);
      writer.exec("BEGIN IMMEDIATE");
      try {
        const before = Date.now();
        await t.video.stop();
        expect(Date.now() - before).toBeLessThan(11_500);
      } finally {
        writer.exec("ROLLBACK");
        writer.close();
      }
    }
    // The flush had its part of the budget: the second job's accepted id is recorded.
    expect(t.job(second.jobId)).toMatchObject({ status: "pending", remoteId: rid(2) });
    unblock!(new Response(null, { status: 503 }));
    await a;
  }, 30_000);
});
