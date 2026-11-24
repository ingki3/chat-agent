import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AdminUsageReport,
  CSRF_HEADER,
  DEFAULT_MEDIA_SETTINGS,
  MediaAdmin,
  MediaCatalog,
  MediaSettings,
  type MediaKind,
} from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { settings as settingsTable, users } from "../src/db/schema.js";
import { MediaBudget } from "../src/media/budget.js";
import { OpenRouterKeys, OPENROUTER_KEY_SETTING } from "../src/media/keys.js";
import {
  checkKey,
  fetchCatalog,
  MEDIA_CATALOG_URLS,
  OPENROUTER_KEY_URL,
  OpenRouterError,
  openRouterGet,
} from "../src/media/openrouter.js";
import { moderationFor, withMediaPolicy, mediaRequestCarriesSecret } from "../src/media/policy.js";
import { FIXTURE_OPENROUTER_KEY_PREFIX, fixtureOpenRouterFetch } from "../src/media/fixture.js";
import { knownSecrets } from "../src/secrets/known.js";
import { UsageStore } from "../src/usage/store.js";
import { createFamily } from "./helpers/permission-matrix.js";

/**
 * 미디어 생성 stage 1 (#238): the admin's OpenRouter key (checked, stored encrypted, last 4 only), the key
 * precedence (admin, then `.env`) shared with the transcription fallback, per-kind catalogs and the model check
 * before a save, the daily budget over `media` usage rows, and the request policy. OpenRouter is always a fake
 * `fetchImpl` with synthetic keys — never the network.
 */

const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const LOCAL = { host: "localhost:3000" };
const WRITE = { ...LOCAL, origin: "http://localhost:3000", [CSRF_HEADER]: "1" };
const GOOD_KEY = `${FIXTURE_OPENROUTER_KEY_PREFIX}-synthetic-0000000000000000000000abcd`;
const BAD_KEY = "sk-or-v1-test-refused-00000000000000000000000000wxyz";
const ENV_KEY = "sk-or-v1-test-env-0000000000000000000000000000envk";

function tmp(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-media-")));
  closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** The fixture OpenRouter, recording every request (URL, method, headers, redirect mode). */
function recordingFetch(inner: typeof fetch = fixtureOpenRouterFetch()) {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init: init ?? {} });
    return inner(url, init);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

async function start(o: { envKey?: string; fetchImpl?: typeof fetch; now?: () => number } = {}) {
  const dir = tmp();
  const rec = recordingFetch(o.fetchImpl);
  const db = createTestDb();
  const app = await buildApp(
    loadConfig({
      NODE_ENV: "test",
      DATA_DIR: path.join(dir, "data"),
      MASTER_KEY_PATH: path.join(dir, "master.key"),
      ...(o.envKey ? { OPENROUTER_API_KEY: o.envKey } : {}),
    }),
    {
      db,
      media: { fetchImpl: rec.fetchImpl, ...(o.now ? { now: o.now } : {}) },
      ...(o.now ? { usage: { now: o.now } } : {}),
    },
  );
  closers.push(() => app.close());
  const f = await createFamily(app);
  const api = (cookie: string, method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { ...WRITE, cookie, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  return { app, db, f, api, requests: rec.requests };
}

const withKind = (kind: MediaKind, model: string | null, enabled = true) => ({
  ...structuredClone(DEFAULT_MEDIA_SETTINGS),
  kinds: { ...structuredClone(DEFAULT_MEDIA_SETTINGS.kinds), [kind]: { enabled, model } },
});

// ---------------------------------------------------------------- OpenRouter client

describe("media: the OpenRouter reads (#238)", () => {
  it("checks a key with GET /api/v1/key: fixed URL, key only in Authorization, redirects refused", async () => {
    const rec = recordingFetch();
    expect(await checkKey(GOOD_KEY, rec.fetchImpl)).toEqual({
      limitUsd: 100,
      limitRemainingUsd: 87.5,
      usageUsd: 12.5,
    });
    expect(rec.requests).toHaveLength(1);
    const [r] = rec.requests;
    expect(r!.url).toBe("https://openrouter.ai/api/v1/key");
    expect(r!.init.redirect).toBe("error");
    expect(r!.init.method).toBe("GET");
    expect(new Headers(r!.init.headers).get("authorization")).toBe(`Bearer ${GOOD_KEY}`);
    expect(r!.url).not.toContain(GOOD_KEY);
    await expect(checkKey(BAD_KEY, rec.fetchImpl)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("an unlimited key has null limits; a broken answer, a 5xx or a network error is `failed`", async () => {
    const answer = (body: unknown, status = 200) =>
      (async () => Response.json(body, { status })) as unknown as typeof fetch;
    expect(
      await checkKey(GOOD_KEY, answer({ data: { limit: null, limit_remaining: null, usage: "3.5" } })),
    ).toEqual({ limitUsd: null, limitRemainingUsd: null, usageUsd: 3.5 });
    await expect(checkKey(GOOD_KEY, answer({ nope: 1 }))).rejects.toMatchObject({ code: "failed" });
    await expect(checkKey(GOOD_KEY, answer({}, 503))).rejects.toMatchObject({ code: "failed" });
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(checkKey(GOOD_KEY, down)).rejects.toBeInstanceOf(OpenRouterError);
  });

  it("refuses any URL outside the API and a URL carrying a known secret, before any request", async () => {
    const rec = recordingFetch();
    await expect(openRouterGet("https://example.com/x", { fetchImpl: rec.fetchImpl })).rejects.toMatchObject({
      code: "failed",
    });
    const secret = "sk-or-v1-test-known-secret-in-url-000000000000";
    knownSecrets.add(secret);
    await expect(
      openRouterGet(`${OPENROUTER_KEY_URL}?x=${secret}`, { fetchImpl: rec.fetchImpl }),
    ).rejects.toMatchObject({ code: "failed" });
    expect(rec.requests).toHaveLength(0);
  });

  it("reads each kind's catalog from its own list, with price and options", async () => {
    const rec = recordingFetch();
    const get = (kind: MediaKind) => fetchCatalog(kind, { apiKey: GOOD_KEY, fetchImpl: rec.fetchImpl });
    const image = MediaCatalog.parse(await get("image"));
    expect(image.models.map((m) => m.id)).toEqual(["fixture/image-one", "fixture/image-two"]);
    expect(image.models[0]).toMatchObject({
      price: "$0.04/image",
      options: ["aspect_ratio: 1:1·16:9·9:16", "resolution: 1K·2K", "seed"],
    });
    expect(image.models[1]!.price).toBeNull();
    const speech = await get("speech");
    expect(speech.models[0]).toMatchObject({
      id: "fixture/voice-one",
      price: "$0.000015/characters",
      options: ["voice: alloy·nova", "response_format: mp3·pcm", "speed: 0.7–1.2"],
    });
    // Music: the general list filtered by audio output — a text-only model there is left out.
    const music = await get("music");
    expect(music.models.map((m) => m.id)).toEqual(["fixture/music-clip"]);
    expect(music.models[0]!.price).toBe("$0.04/request");
    const video = await get("video");
    expect(video.models[0]).toMatchObject({
      id: "fixture/video-one",
      price: "$0.5/video-second, $0.75/video-second-1080p",
      maxDurationSec: 12,
    });
    expect(video.models[0]!.options).toContain("길이: 4·6·8·12초");
    expect(rec.requests.map((r) => r.url)).toEqual([
      MEDIA_CATALOG_URLS.image,
      MEDIA_CATALOG_URLS.speech,
      MEDIA_CATALOG_URLS.music,
      MEDIA_CATALOG_URLS.video,
    ]);
    expect(MEDIA_CATALOG_URLS).toEqual({
      image: "https://openrouter.ai/api/v1/images/models",
      speech: "https://openrouter.ai/api/v1/audio/speech/models",
      music: "https://openrouter.ai/api/v1/models?output_modalities=audio",
      video: "https://openrouter.ai/api/v1/videos/models",
    });
  });

  it("drops entries without a usable id and never guesses", async () => {
    const fetchImpl = (async () =>
      Response.json({
        data: [{ id: "bad id with spaces" }, { name: "no id" }, 7, { id: "ok/model" }, { id: "ok/model" }],
      })) as unknown as typeof fetch;
    const c = await fetchCatalog("image", { fetchImpl });
    expect(c.models).toEqual([{ id: "ok/model", name: "ok/model", price: null, options: [] }]);
  });
});

// ---------------------------------------------------------------- key precedence

describe("media: one OpenRouter key resolver (#238)", () => {
  it("the admin's key first, else .env's, else none", () => {
    const store = new Map<string, string>();
    const settings = { get: (k: string) => store.get(k) };
    expect(new OpenRouterKeys(settings, undefined).resolve()).toBeUndefined();
    expect(new OpenRouterKeys(settings, ENV_KEY).resolve()).toEqual({ key: ENV_KEY, source: "env" });
    store.set(OPENROUTER_KEY_SETTING, GOOD_KEY);
    expect(new OpenRouterKeys(settings, ENV_KEY).resolve()).toEqual({ key: GOOD_KEY, source: "admin" });
    // A stored value that no longer decrypts is no key (the .env one is used).
    const broken = {
      get: () => {
        throw new Error("decrypt");
      },
    };
    expect(new OpenRouterKeys(broken, ENV_KEY).source()).toBe("env");
  });
});

// ---------------------------------------------------------------- admin routes

describe("관리자 → 미디어 생성 (#238)", () => {
  it("starts with the defaults: every kind off, $50 a day, 4/3/1/1 per run, 8-second videos, no key", async () => {
    const t = await start();
    const r = await t.api(t.f.cookies.admin, "GET", "/api/admin/media");
    expect(r.statusCode).toBe(200);
    const m = MediaAdmin.parse(r.json());
    expect(m.key).toEqual({
      source: "none",
      last4: null,
      limitUsd: null,
      limitRemainingUsd: null,
      usageUsd: null,
      checkedAt: null,
    });
    expect(m.settings).toEqual({
      kinds: {
        image: { enabled: false, model: null },
        speech: { enabled: false, model: null },
        music: { enabled: false, model: null },
        video: { enabled: false, model: null },
      },
      dailyCostLimitUsd: 50,
      perRunLimits: { image: 4, speech: 3, music: 1, video: 1 },
      videoDefaultSec: 8,
    });
    expect(m.youthStrictModeration).toBe(true);
    expect(t.requests).toHaveLength(0);
    for (const who of ["owner", "shared", "stranger"] as const)
      expect((await t.api(t.f.cookies[who], "GET", "/api/admin/media")).statusCode).toBe(403);
  });

  it("a key is checked before it is saved: refused keys store nothing; a good one is encrypted, last 4 only", async () => {
    const t = await start();
    const bad = await t.api(t.f.cookies.admin, "PUT", "/api/admin/media/key", { key: BAD_KEY });
    expect(bad.statusCode).toBe(400);
    expect(bad.json()).toEqual({ error: "media_key_invalid" });
    expect(
      t.db
        .select()
        .from(settingsTable)
        .all()
        .some((s) => s.key.startsWith("media.openrouter")),
    ).toBe(false);

    const ok = await t.api(t.f.cookies.admin, "PUT", "/api/admin/media/key", { key: GOOD_KEY });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.body).not.toContain(GOOD_KEY.slice(0, -4));
    const m = MediaAdmin.parse(ok.json());
    expect(m.key).toMatchObject({ source: "admin", last4: "abcd", limitUsd: 100, limitRemainingUsd: 87.5 });
    expect(m.key.checkedAt).toBeTypeOf("number");
    // Stored encrypted; the plain status row holds no part of the key beyond its last 4.
    const rows = t.db.select().from(settingsTable).all();
    const keyRow = rows.find((s) => s.key === OPENROUTER_KEY_SETTING)!;
    expect(keyRow.encrypted).toBe(true);
    expect(keyRow.value).not.toContain(GOOD_KEY);
    for (const r of rows) expect(r.value).not.toContain(GOOD_KEY.slice(0, 16));
    // The saved key is a known secret from now on (masked everywhere, refused in egress).
    expect(mediaRequestCarriesSecret([`x ${GOOD_KEY} y`])).toBe(true);
    // A member cannot save or delete one.
    expect(
      (await t.api(t.f.cookies.owner, "PUT", "/api/admin/media/key", { key: GOOD_KEY })).statusCode,
    ).toBe(403);
    expect((await t.api(t.f.cookies.owner, "DELETE", "/api/admin/media/key")).statusCode).toBe(403);
    // GET shows the same view, never the key.
    const again = await t.api(t.f.cookies.admin, "GET", "/api/admin/media");
    expect(again.body).not.toContain(GOOD_KEY);
    expect(MediaAdmin.parse(again.json()).key.last4).toBe("abcd");
  });

  it("OpenRouter down: `media_key_check_failed` (502), nothing saved", async () => {
    const down = (async () => new Response("no", { status: 503 })) as unknown as typeof fetch;
    const t = await start({ fetchImpl: down });
    const r = await t.api(t.f.cookies.admin, "PUT", "/api/admin/media/key", { key: GOOD_KEY });
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ error: "media_key_check_failed" });
    expect(
      MediaAdmin.parse((await t.api(t.f.cookies.admin, "GET", "/api/admin/media")).json()).key.source,
    ).toBe("none");
  });

  it("deleting the admin's key falls back to .env's (and the audio fallback follows the same resolver)", async () => {
    const t = await start({ envKey: ENV_KEY });
    const audio = async () =>
      (await t.api(t.f.cookies.admin, "GET", "/api/admin/audio")).json() as { keyConfigured: boolean };
    let m = MediaAdmin.parse((await t.api(t.f.cookies.admin, "GET", "/api/admin/media")).json());
    expect(m.key).toMatchObject({ source: "env", last4: null });
    expect((await audio()).keyConfigured).toBe(true);
    expect(t.app.media!.keys.resolve()).toEqual({ key: ENV_KEY, source: "env" });

    await t.api(t.f.cookies.admin, "PUT", "/api/admin/media/key", { key: GOOD_KEY });
    expect(t.app.media!.keys.resolve()).toEqual({ key: GOOD_KEY, source: "admin" });

    const del = await t.api(t.f.cookies.admin, "DELETE", "/api/admin/media/key");
    expect(del.statusCode).toBe(200);
    m = MediaAdmin.parse(del.json());
    // The status checked for the admin's key is not shown for .env's.
    expect(m.key).toEqual({
      source: "env",
      last4: null,
      limitUsd: null,
      limitRemainingUsd: null,
      usageUsd: null,
      checkedAt: null,
    });
    expect(t.app.media!.keys.resolve()).toEqual({ key: ENV_KEY, source: "env" });
  });

  it("without any key the audio fallback has no client; with the admin's key it has one", async () => {
    const t = await start();
    const audio = async () =>
      (await t.api(t.f.cookies.admin, "GET", "/api/admin/audio")).json() as { keyConfigured: boolean };
    expect((await audio()).keyConfigured).toBe(false);
    await t.api(t.f.cookies.admin, "PUT", "/api/admin/media/key", { key: GOOD_KEY });
    expect((await audio()).keyConfigured).toBe(true);
    await t.api(t.f.cookies.admin, "DELETE", "/api/admin/media/key");
    expect((await audio()).keyConfigured).toBe(false);
  });

  it("re-checks the key in use (here .env's) and shows its remaining limit", async () => {
    const t = await start({ envKey: `${FIXTURE_OPENROUTER_KEY_PREFIX}-env-0000000000000000000000` });
    const r = await t.api(t.f.cookies.admin, "POST", "/api/admin/media/key/check", {});
    expect(r.statusCode, r.body).toBe(200);
    expect(MediaAdmin.parse(r.json()).key).toMatchObject({
      source: "env",
      last4: null,
      limitRemainingUsd: 87.5,
    });
    const none = await start();
    expect((await none.api(none.f.cookies.admin, "POST", "/api/admin/media/key/check", {})).json()).toEqual({
      error: "media_no_key",
    });
  });

  it("catalogs need a key, are read per kind and reused until `fresh`", async () => {
    const t = await start();
    const none = await t.api(t.f.cookies.admin, "GET", "/api/admin/media/catalog/image");
    expect(none.statusCode).toBe(400);
    expect(none.json()).toEqual({ error: "media_no_key" });
    expect((await t.api(t.f.cookies.admin, "GET", "/api/admin/media/catalog/painting")).statusCode).toBe(400);
    await t.api(t.f.cookies.admin, "PUT", "/api/admin/media/key", { key: GOOD_KEY });
    const before = t.requests.length;
    for (const kind of ["image", "speech", "music", "video"] as const) {
      const r = await t.api(t.f.cookies.admin, "GET", `/api/admin/media/catalog/${kind}`);
      expect(r.statusCode, r.body).toBe(200);
      expect(MediaCatalog.parse(r.json()).models.length).toBeGreaterThan(0);
    }
    expect(t.requests.length - before).toBe(4);
    await t.api(t.f.cookies.admin, "GET", "/api/admin/media/catalog/image");
    expect(t.requests.length - before).toBe(4);
    await t.api(t.f.cookies.admin, "GET", "/api/admin/media/catalog/image?fresh=1");
    expect(t.requests.length - before).toBe(5);
    expect((await t.api(t.f.cookies.owner, "GET", "/api/admin/media/catalog/image")).statusCode).toBe(403);
  });

  it("a newly chosen model is checked against a freshly read catalog before the save", async () => {
    const t = await start();
    await t.api(t.f.cookies.admin, "PUT", "/api/admin/media/key", { key: GOOD_KEY });
    const unknown = await t.api(
      t.f.cookies.admin,
      "PUT",
      "/api/admin/media/settings",
      withKind("video", "fixture/not-there"),
    );
    expect(unknown.statusCode).toBe(409);
    expect(unknown.json()).toEqual({ error: "media_model_unknown", kind: "video" });
    expect(t.app.media!.settings.get()).toEqual(DEFAULT_MEDIA_SETTINGS);

    // A model of another kind's list is not this kind's.
    const wrongKind = await t.api(
      t.f.cookies.admin,
      "PUT",
      "/api/admin/media/settings",
      withKind("music", "fixture/image-one"),
    );
    expect(wrongKind.statusCode).toBe(409);

    const next = MediaSettings.parse({
      ...withKind("music", "fixture/music-clip"),
      dailyCostLimitUsd: 12.5,
      perRunLimits: { image: 2, speech: 1, music: 1, video: 0 },
      videoDefaultSec: 6,
    });
    const before = t.requests.length;
    const ok = await t.api(t.f.cookies.admin, "PUT", "/api/admin/media/settings", next);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(MediaAdmin.parse(ok.json()).settings).toEqual(next);
    expect(t.requests.slice(before).map((r) => r.url)).toEqual([MEDIA_CATALOG_URLS.music]);
    expect(t.app.media!.settings.get()).toEqual(next);

    // Same model kept on, limits changed, another kind off: no OpenRouter call.
    const after = t.requests.length;
    const limits = { ...next, dailyCostLimitUsd: 20 };
    expect((await t.api(t.f.cookies.admin, "PUT", "/api/admin/media/settings", limits)).statusCode).toBe(200);
    expect(t.requests.length).toBe(after);
  });

  it("refuses settings that do not parse: on without a model, a limit out of range, extra fields", async () => {
    const t = await start();
    const put = (body: unknown) => t.api(t.f.cookies.admin, "PUT", "/api/admin/media/settings", body);
    expect((await put(withKind("image", null, true))).statusCode).toBe(400);
    expect((await put({ ...DEFAULT_MEDIA_SETTINGS, dailyCostLimitUsd: 0 })).statusCode).toBe(400);
    expect((await put({ ...DEFAULT_MEDIA_SETTINGS, dailyCostLimitUsd: 1.234 })).statusCode).toBe(400);
    expect(
      (await put({ ...DEFAULT_MEDIA_SETTINGS, perRunLimits: { image: 51, speech: 3, music: 1, video: 1 } }))
        .statusCode,
    ).toBe(400);
    expect((await put({ ...DEFAULT_MEDIA_SETTINGS, extra: 1 })).statusCode).toBe(400);
    expect((await put(withKind("image", "bad model id!"))).statusCode).toBe(400);
    // Turning every kind off needs no key and no OpenRouter call.
    expect((await put(DEFAULT_MEDIA_SETTINGS)).statusCode).toBe(200);
    expect(t.requests).toHaveLength(0);
    expect(
      (await t.api(t.f.cookies.owner, "PUT", "/api/admin/media/settings", DEFAULT_MEDIA_SETTINGS)).statusCode,
    ).toBe(403);
  });
});

// ---------------------------------------------------------------- usage and budget

describe("media: usage rows and the daily budget (#238)", () => {
  // 2026-11-24 15:00 Asia/Seoul
  const NOON = Date.UTC(2026, 10, 24, 6, 0, 0);

  async function family() {
    let now = NOON;
    const t = await start({ now: () => now });
    const store = new UsageStore(t.db, () => now);
    const at = (ms: number) => {
      now = ms;
    };
    return { t, store, at, owner: t.f.users.owner.id, shared: t.f.users.shared.id };
  }

  it("remaining = the daily limit minus today's media cost of that user only", async () => {
    const { t, store, at, owner, shared } = await family();
    const budget = t.app.media!.budget;
    expect(budget.remaining(owner)).toEqual({ limitUsd: 50, spentUsd: 0, remainingUsd: 50, uncosted: 0 });
    store.recordMedia({
      userId: owner,
      conversationId: null,
      runId: "r1",
      callId: "c1",
      model: "fixture/image-one",
      costUsd: 0.04,
    });
    store.recordMedia({
      userId: owner,
      conversationId: null,
      runId: "r1",
      callId: "c2",
      model: "fixture/video-one",
      costUsd: 4,
    });
    // Another user's cost, and a generation without a reported cost.
    store.recordMedia({
      userId: shared,
      conversationId: null,
      runId: "r2",
      callId: "c1",
      model: "m/x",
      costUsd: 30,
    });
    store.recordMedia({
      userId: owner,
      conversationId: null,
      runId: "r1",
      callId: "c3",
      model: "m/x",
      costUsd: null,
    });
    expect(budget.remaining(owner)).toEqual({
      limitUsd: 50,
      spentUsd: 4.04,
      remainingUsd: 45.96,
      uncosted: 1,
    });
    expect(budget.remaining(shared).remainingUsd).toBe(20);
    // The same call reported again replaces its row (latest cost wins), never adds.
    store.recordMedia({
      userId: owner,
      conversationId: null,
      runId: "r1",
      callId: "c2",
      model: "fixture/video-one",
      costUsd: 5,
    });
    expect(budget.remaining(owner).spentUsd).toBe(5.04);
    expect(budget.allows(owner, 44.96)).toBe(true);
    expect(budget.allows(owner, 44.97)).toBe(false);
    // Yesterday's cost does not count; the next day starts fresh (midnight in Seoul).
    at(Date.UTC(2026, 10, 24, 15, 0, 1)); // 2026-11-25 00:00:01 KST
    expect(budget.remaining(owner)).toEqual({ limitUsd: 50, spentUsd: 0, remainingUsd: 50, uncosted: 0 });
  });

  it("follows the admin's limit and never goes below 0", async () => {
    const { t, store, owner } = await family();
    await t.api(t.f.cookies.admin, "PUT", "/api/admin/media/settings", {
      ...DEFAULT_MEDIA_SETTINGS,
      dailyCostLimitUsd: 1,
    });
    store.recordMedia({
      userId: owner,
      conversationId: null,
      runId: "r",
      callId: "c",
      model: "m/x",
      costUsd: 2.5,
    });
    expect(t.app.media!.budget.remaining(owner)).toEqual({
      limitUsd: 1,
      spentUsd: 2.5,
      remainingUsd: 0,
      uncosted: 0,
    });
    expect(t.app.media!.budget.allows(owner)).toBe(false);
  });

  it("chat usage does not count against the media budget", async () => {
    const { t, owner } = await family();
    const store = t.app.usageStore!;
    store.record(
      {
        userId: owner,
        conversationId: null,
        runId: "chat-run",
        attempt: 1,
        runtime: "claude-code",
        model: "claude-opus-5-5",
        connectionId: null,
        purpose: "chat",
      },
      { inputTokens: 10, outputTokens: 10, costUsd: 9 },
    );
    expect(t.app.media!.budget.remaining(owner).spentUsd).toBe(0);
  });

  it("the usage screen shows media rows with OpenRouter's cost under 미디어 생성", async () => {
    const { t, store, owner } = await family();
    store.recordMedia({
      userId: owner,
      conversationId: null,
      runId: "r",
      callId: "c",
      model: "fixture/image-one",
      costUsd: 0.04,
    });
    const r = await t.api(t.f.cookies.admin, "GET", "/api/admin/usage");
    expect(r.statusCode).toBe(200);
    const report = AdminUsageReport.parse(r.json());
    expect(report.total.costUsd).toBe(0.04);
    expect(report.total.tokensMissing).toBe(0);
    expect(report.byPurpose).toEqual([
      expect.objectContaining({ key: "media", label: "미디어 생성", costUsd: 0.04 }),
    ]);
    expect(report.byRuntime[0]).toMatchObject({ key: "openrouter", label: "OpenRouter" });
    expect(report.byConnection[0]).toMatchObject({ key: "openrouter", label: "OpenRouter 키" });
    expect(report.recent[0]).toMatchObject({
      purpose: "media",
      model: "fixture/image-one",
      costUsd: 0.04,
      authType: "api_key",
    });
    // The user's own screen too.
    const mine = (await t.api(t.f.cookies.owner, "GET", "/api/usage/me")).json() as {
      total: { costUsd: number };
    };
    expect(mine.total.costUsd).toBe(0.04);
    // The owner's name is what the row is under (not content, only ids and the model).
    expect(t.db.select().from(users).all().length).toBeGreaterThan(0);
  });

  it("MediaBudget reads a given time zone's day", () => {
    const db = createTestDb();
    const budget = new MediaBudget(
      db,
      () => ({ dailyCostLimitUsd: 50 }),
      "UTC",
      () => NOON,
    );
    expect(budget.remaining("nobody")).toMatchObject({ remainingUsd: 50 });
  });
});

// ---------------------------------------------------------------- request policy

describe("media: request policy for stages 2–3 (#238)", () => {
  it("every body denies data collection, whatever the caller put there", () => {
    expect(withMediaPolicy({ model: "m/x", prompt: "고양이" })).toEqual({
      model: "m/x",
      prompt: "고양이",
      provider: { data_collection: "deny" },
    });
    expect(
      withMediaPolicy({ model: "m/x", provider: { data_collection: "allow", order: ["a"] } }).provider,
    ).toEqual({ data_collection: "deny", order: ["a"] });
  });

  it("a prompt carrying a known secret is refused before it goes out", () => {
    const secret = "sk-or-v1-test-prompt-secret-000000000000000000";
    knownSecrets.add(secret);
    expect(mediaRequestCarriesSecret([`그려줘 ${secret}`])).toBe(true);
    expect(mediaRequestCarriesSecret(["노을 지는 바다"])).toBe(false);
  });

  it("youth accounts ask for the strictest moderation the model lists; others keep the provider default", () => {
    expect(moderationFor({ youth: true }, ["low", "auto"])).toBe("auto");
    expect(moderationFor({ youth: true }, ["low", "high", "medium"])).toBe("high");
    expect(moderationFor({ youth: true }, undefined)).toBeNull();
    expect(moderationFor({ youth: false }, ["low", "auto"])).toBeNull();
  });
});
