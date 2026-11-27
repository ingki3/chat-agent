import crypto from "node:crypto";
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
import { SettingsStore } from "../src/db/settings-store.js";
import { MediaAdminService } from "../src/media/service.js";
import {
  INITIAL_REVISION,
  MEDIA_SETTINGS_KEY,
  MEDIA_SETTINGS_REVISION_KEY,
  MediaSettingsStore,
} from "../src/media/settings.js";
import { OPENROUTER_KEY_STATUS_SETTING } from "../src/media/keys.js";
import { OpenRouterKeys, OPENROUTER_KEY_SETTING } from "../src/media/keys.js";
import {
  checkKey,
  fetchCatalog,
  MEDIA_CATALOG_URLS,
  OPENROUTER_KEY_URL,
  OPENROUTER_MAX_BYTES,
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

async function start(
  o: {
    envKey?: string;
    fetchImpl?: typeof fetch;
    now?: () => number;
  } = {},
) {
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
  /**
   * Media writes name what the screen showed (review r5): unless a test gives them, the current key generation and
   * settings version are filled in (and plain settings are wrapped), as the screen does.
   */
  const fill = (method: string, url: string, payload: unknown): unknown => {
    const keyWrite =
      (url === "/api/admin/media/key" && (method === "PUT" || method === "DELETE")) ||
      url === "/api/admin/media/key/check";
    if (keyWrite) {
      const body = (payload ?? {}) as Record<string, unknown>;
      return "expectedGeneration" in body
        ? body
        : { ...body, expectedGeneration: app.media!.admin.generation() };
    }
    if (url === "/api/admin/media/settings" && method === "PUT") {
      const body = payload as Record<string, unknown>;
      return body && "settings" in body && "expectedRevision" in body
        ? body
        : { settings: body, expectedRevision: app.media!.settings.revision() };
    }
    return payload;
  };
  const api = (cookie: string, method: "GET" | "PUT" | "POST" | "DELETE", url: string, raw?: unknown) => {
    const payload = fill(method, url, raw);
    return app.inject({
      method,
      url,
      headers: { ...WRITE, cookie, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  };
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
      await checkKey(GOOD_KEY, answer({ data: { limit: null, limit_remaining: null, usage: 3.5 } })),
    ).toEqual({ limitUsd: null, limitRemainingUsd: null, usageUsd: 3.5 });
    // Review r1: only an explicit null is "unlimited" — a missing or malformed figure is no passed check.
    for (const data of [
      {},
      { limit: null },
      { limit_remaining: 5 },
      { limit: "100", limit_remaining: 5 },
      { limit: 100, limit_remaining: "abc" },
      { limit: 100, limit_remaining: 5, usage: "x" },
    ])
      await expect(checkKey(GOOD_KEY, answer({ data }))).rejects.toMatchObject({ code: "failed" });
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
    const image = MediaCatalog.omit({ generation: true }).parse(await get("image"));
    expect(image.models.map((m) => m.id)).toEqual(["fixture/image-one", "fixture/image-two"]);
    expect(image.models[0]).toMatchObject({
      price: "$0.04/image",
      options: ["aspect_ratio: 1:1·16:9·9:16", "resolution: 1K·2K", "seed"],
    });
    expect(image.models[1]!.price).toBeNull();
    const speech = await get("speech");
    expect(speech.models[0]).toMatchObject({
      id: "fixture/voice-one",
      // Not in the speech list: from the general Models API (`output_modalities=speech`); its unit unconfirmed.
      price: "$0.000015/입력 단위 (단위 미확정: 글자·토큰·초 중 모델마다 다름)",
      options: ["voice: alloy·nova", "response_format: mp3·pcm", "speed: 0.7–1.2"],
    });
    // Music: the general list filtered by audio output — a text-only model there is left out.
    const music = await get("music");
    // A voice-chat model (it lists voices) is listed after the music models and says what it is.
    expect(music.models.map((m) => m.id)).toEqual(["fixture/music-clip", "fixture/voice-chat"]);
    expect(music.models[0]!.price).toBe("$0.04/request");
    expect(music.models[0]!.voiceChat).toBeUndefined();
    expect(music.models[1]).toMatchObject({ voiceChat: true, options: ["음성 대화 모델(음악 생성용 아님)"] });
    const video = await get("video");
    expect(video.models[0]).toMatchObject({
      id: "fixture/video-one",
      price: "$0.05/초, $0.08/초 (1080p)",
      maxDurationSec: 12,
    });
    expect(video.models[0]!.options).toContain("길이: 4·6·8·12초");
    // Image prices from each model's endpoint records (built from the id), speech prices from the Models API.
    expect(rec.requests.map((r) => r.url)).toEqual([
      MEDIA_CATALOG_URLS.image,
      "https://openrouter.ai/api/v1/images/models/fixture/image-one/endpoints",
      "https://openrouter.ai/api/v1/images/models/fixture/image-two/endpoints",
      MEDIA_CATALOG_URLS.speech,
      "https://openrouter.ai/api/v1/models?output_modalities=speech",
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
      generation: expect.any(String),
    });
    expect(m.settings).toEqual({
      kinds: {
        image: { enabled: false, model: null },
        speech: { enabled: false, model: null },
        music: { enabled: false, model: null },
        video: { enabled: false, model: null },
      },
      dailyCostLimitUsd: 50,
      perRunLimits: { image: 4, speech: 3, music: 1, video: 1, compose: 1 },
      videoDefaultSec: 8,
      // #238 stage 4: 멀티미디어 합성 is off until the admin turns it on (no model, no key, no cost).
      composeEnabled: false,
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
      generation: expect.any(String),
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
    // Image: the list and one price read per model (2); speech: the list and the Models API prices.
    expect(t.requests.length - before).toBe(7);
    await t.api(t.f.cookies.admin, "GET", "/api/admin/media/catalog/image");
    expect(t.requests.length - before).toBe(7);
    await t.api(t.f.cookies.admin, "GET", "/api/admin/media/catalog/image?fresh=1");
    expect(t.requests.length - before).toBe(10);
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
    expect(budget.remaining(owner)).toEqual({
      limitUsd: 50,
      spentUsd: 0,
      remainingUsd: 50,
      uncosted: 0,
      pendingUsd: 0,
    });
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
      pendingUsd: 0,
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
    expect(budget.remaining(owner)).toEqual({
      limitUsd: 50,
      spentUsd: 0,
      remainingUsd: 50,
      uncosted: 0,
      pendingUsd: 0,
    });
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
      pendingUsd: 0,
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

// ---------------------------------------------------------------- review round 1 (#244)

describe("media: review round 1 regressions (#244)", () => {
  /** A JSON-ish body streamed in `chunks` pieces of `piece`, with no Content-Length; counts reads and cancel. */
  function streamed(piece: string, chunks: number) {
    const bytes = new TextEncoder().encode(piece);
    const seen = { pulls: 0, cancelled: false };
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        seen.pulls += 1;
        if (seen.pulls > chunks) c.close();
        else c.enqueue(bytes);
      },
      cancel() {
        seen.cancelled = true;
      },
    });
    const fetchImpl = (async () =>
      new Response(body, { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    return { fetchImpl, seen };
  }

  it("8 MiB is counted in bytes while streaming (no Content-Length, multibyte): cancelled on the way", async () => {
    // 1 MiB of "가" (3 bytes each) per chunk: 12 chunks are ~2.9 M characters but 12 MiB of bytes.
    const piece = "가".repeat(Math.ceil((1024 * 1024) / 3));
    expect(piece.length * 12).toBeLessThan(OPENROUTER_MAX_BYTES);
    const big = streamed(piece, 12);
    await expect(openRouterGet(OPENROUTER_KEY_URL, { fetchImpl: big.fetchImpl })).rejects.toMatchObject({
      code: "failed",
    });
    expect(big.seen.cancelled).toBe(true);
    expect(big.seen.pulls).toBeLessThanOrEqual(10);
    // A declared length over the cap is refused before reading.
    const declared = (async () =>
      new Response("{}", {
        headers: { "content-length": String(OPENROUTER_MAX_BYTES + 1) },
      })) as unknown as typeof fetch;
    await expect(openRouterGet(OPENROUTER_KEY_URL, { fetchImpl: declared })).rejects.toMatchObject({
      code: "failed",
    });
    // Under the cap, multibyte text across chunk boundaries comes back whole.
    const json = JSON.stringify({
      data: { limit: null, limit_remaining: null, note: "가나다".repeat(1000) },
    });
    const bytes = new TextEncoder().encode(json);
    const split = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
            c.close();
          },
        }),
      )) as unknown as typeof fetch;
    expect(await openRouterGet(OPENROUTER_KEY_URL, { fetchImpl: split })).toEqual(JSON.parse(json));
  });

  /** The service on a real database, with a settings store whose status write can be made to fail. */
  function service(o: { fetchImpl?: typeof fetch; bootId?: string } = {}) {
    const db = createTestDb();
    const real = new SettingsStore(db, crypto.randomBytes(32));
    let failStatus = false;
    const removes: string[][] = [];
    const settings = {
      get: (k: string) => real.get(k),
      setSecret: (k: string, v: string) => real.setSecret(k, v),
      set: (k: string, v: string) => {
        if (failStatus && k === OPENROUTER_KEY_STATUS_SETTING) throw new Error("disk full");
        real.set(k, v);
      },
    };
    const keys = new OpenRouterKeys(real, undefined);
    const svc = new MediaAdminService({
      settings,
      transaction: (fn) => db.transaction(() => fn()),
      remove: (k) => {
        removes.push(k);
        db.$client.prepare(`DELETE FROM settings WHERE key IN (${k.map(() => "?").join(", ")})`).run(...k);
      },
      keys,
      store: new MediaSettingsStore(real),
      fetchImpl: o.fetchImpl ?? fixtureOpenRouterFetch(),
      ...(o.bootId ? { bootId: o.bootId } : {}),
    });
    return { db, real, svc, keys, removes, fail: (on: boolean) => (failStatus = on) };
  }
  const yes = () => true;
  const KEY_B = `${FIXTURE_OPENROUTER_KEY_PREFIX}-second-00000000000000000000bbbb`;

  it("key and check are saved in one transaction: a failed second write keeps the old key and its check", async () => {
    const t = service();
    await t.svc.registerKey(GOOD_KEY, t.svc.generation(), yes);
    const before = t.svc.view().key;
    expect(before).toMatchObject({ source: "admin", last4: "abcd", limitRemainingUsd: 87.5 });
    t.fail(true);
    await expect(t.svc.registerKey(KEY_B, t.svc.generation(), yes)).rejects.toThrow("disk full");
    expect(t.keys.resolve()).toEqual({ key: GOOD_KEY, source: "admin" });
    expect(t.svc.view().key).toEqual(before);
    t.fail(false);
    // Delete is one statement for both rows.
    await t.svc.deleteKey(t.svc.generation(), yes);
    expect(t.removes).toEqual([[OPENROUTER_KEY_SETTING, OPENROUTER_KEY_STATUS_SETTING]]);
    expect(
      t.db
        .select()
        .from(settingsTable)
        .all()
        .filter((r) => r.key.startsWith("media.openrouter")),
    ).toEqual([]);
  });

  it("a malformed /key answer is media_key_check_failed and keeps the old key and check", async () => {
    let broken = false;
    const inner = fixtureOpenRouterFetch();
    const fetchImpl = (async (u: string | URL | Request, init?: RequestInit) =>
      broken && String(u) === OPENROUTER_KEY_URL
        ? Response.json({ data: {} })
        : inner(u, init)) as typeof fetch;
    const t = await start({ fetchImpl });
    await t.api(t.f.cookies.admin, "PUT", "/api/admin/media/key", { key: GOOD_KEY });
    broken = true;
    const r = await t.api(t.f.cookies.admin, "PUT", "/api/admin/media/key", { key: KEY_B });
    expect(r.statusCode).toBe(502);
    expect(r.json()).toEqual({ error: "media_key_check_failed" });
    const check = await t.api(t.f.cookies.admin, "POST", "/api/admin/media/key/check", {});
    expect(check.json()).toEqual({ error: "media_key_check_failed" });
    const m = MediaAdmin.parse((await t.api(t.f.cookies.admin, "GET", "/api/admin/media")).json());
    expect(m.key).toMatchObject({ source: "admin", last4: "abcd", limitUsd: 100, limitRemainingUsd: 87.5 });
  });

  it("a catalog read that started before the key changed is neither cached nor returned", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const inner = fixtureOpenRouterFetch();
    let hold = false;
    const fetchImpl = (async (u: string | URL | Request, init?: RequestInit) => {
      if (hold && String(u) === MEDIA_CATALOG_URLS.image) await gate;
      return inner(u, init);
    }) as typeof fetch;
    const t = service({ fetchImpl });
    await t.svc.registerKey(GOOD_KEY, t.svc.generation(), yes);
    hold = true;
    const pending = t.svc.catalog("image");
    await t.svc.deleteKey(t.svc.generation(), yes);
    release();
    await expect(pending).rejects.toMatchObject({ code: "media_key_changed", status: 409 });
    hold = false;
    await expect(t.svc.catalog("image")).rejects.toMatchObject({ code: "media_no_key" });
    // A new key reads its own list (the old one's cache, if any, is not used).
    await t.svc.registerKey(KEY_B, t.svc.generation(), yes);
    expect((await t.svc.catalog("image")).models.length).toBe(2);
  });

  it("a cached catalog is used only with the key it was read with", async () => {
    const rec = recordingFetch();
    const t = service({ fetchImpl: rec.fetchImpl });
    await t.svc.registerKey(GOOD_KEY, t.svc.generation(), yes);
    await t.svc.catalog("speech");
    const n = rec.requests.length;
    await t.svc.catalog("speech");
    expect(rec.requests.length).toBe(n);
    await t.svc.registerKey(KEY_B, t.svc.generation(), yes);
    await t.svc.catalog("speech");
    const last = rec.requests.at(-2)!;
    expect(last.url).toBe(MEDIA_CATALOG_URLS.speech);
    expect(new Headers(last.init.headers).get("authorization")).toBe(`Bearer ${KEY_B}`);
  });

  it("a switched-off kind given a new model is still checked; keeping, clearing or limits stay offline", async () => {
    const t = await start();
    await t.api(t.f.cookies.admin, "PUT", "/api/admin/media/key", { key: GOOD_KEY });
    const put = (b: unknown) => t.api(t.f.cookies.admin, "PUT", "/api/admin/media/settings", b);
    const off = await put(withKind("image", "fixture/not-there", false));
    expect(off.statusCode).toBe(409);
    expect(off.json()).toEqual({ error: "media_model_unknown", kind: "image" });
    expect((await put(withKind("image", "fixture/image-one", false))).statusCode).toBe(200);
    const n = t.requests.length;
    // Same model, still off; then on → checked; then off with the model kept → offline; then cleared → offline.
    expect(
      (await put({ ...withKind("image", "fixture/image-one", false), dailyCostLimitUsd: 9 })).statusCode,
    ).toBe(200);
    expect(t.requests.length).toBe(n);
    expect((await put(withKind("image", "fixture/image-one", true))).statusCode).toBe(200);
    expect(t.requests.length).toBe(n + 1);
    expect((await put(withKind("image", "fixture/image-one", false))).statusCode).toBe(200);
    expect((await put(withKind("image", null, false))).statusCode).toBe(200);
    expect(t.requests.length).toBe(n + 1);
  });

  it(".env's key check is kept in memory, bound to that key: a rotated .env key shows no old balance", async () => {
    const envA = `${FIXTURE_OPENROUTER_KEY_PREFIX}-envA-000000000000000000000aaa`;
    const t = await start({ envKey: envA });
    const r = await t.api(t.f.cookies.admin, "POST", "/api/admin/media/key/check", {});
    expect(MediaAdmin.parse(r.json()).key).toMatchObject({ source: "env", limitRemainingUsd: 87.5 });
    // Nothing of it is stored: a restart with another .env key starts with no check.
    expect(
      t.db
        .select()
        .from(settingsTable)
        .all()
        .some((x) => x.key === OPENROUTER_KEY_STATUS_SETTING),
    ).toBe(false);
    const envB = `${FIXTURE_OPENROUTER_KEY_PREFIX}-envB-000000000000000000000bbb`;
    const svc = new MediaAdminService({
      settings: { get: () => undefined, set: () => {}, setSecret: () => {} },
      transaction: (fn) => fn(),
      remove: () => {},
      keys: new OpenRouterKeys(undefined, envB),
      store: new MediaSettingsStore(undefined),
      fetchImpl: fixtureOpenRouterFetch(),
    });
    expect(svc.view().key).toMatchObject({ source: "env", checkedAt: null, limitRemainingUsd: null });
  });

  it("a re-report without a cost never erases a known cost; a $0 correction does replace it", async () => {
    const t = await start();
    const store = new UsageStore(t.db);
    const owner = t.f.users.owner.id;
    const rec = (costUsd: number | null) =>
      store.recordMedia({
        userId: owner,
        conversationId: null,
        runId: "r",
        callId: "c",
        model: "m/x",
        costUsd,
      });
    rec(40);
    expect(t.app.media!.budget.remaining(owner)).toMatchObject({
      spentUsd: 40,
      remainingUsd: 10,
      uncosted: 0,
      pendingUsd: 0,
    });
    rec(null);
    expect(t.app.media!.budget.remaining(owner)).toMatchObject({
      spentUsd: 40,
      remainingUsd: 10,
      uncosted: 0,
      pendingUsd: 0,
    });
    rec(0);
    expect(t.app.media!.budget.remaining(owner)).toMatchObject({
      spentUsd: 0,
      remainingUsd: 50,
      uncosted: 0,
      pendingUsd: 0,
    });
    // A first report without a cost, then one with it.
    store.recordMedia({
      userId: owner,
      conversationId: null,
      runId: "r",
      callId: "d",
      model: "m/x",
      costUsd: null,
    });
    expect(t.app.media!.budget.remaining(owner).uncosted).toBe(1);
    store.recordMedia({
      userId: owner,
      conversationId: null,
      runId: "r",
      callId: "d",
      model: "m/x",
      costUsd: 2,
    });
    expect(t.app.media!.budget.remaining(owner)).toMatchObject({ spentUsd: 2, uncosted: 0, pendingUsd: 0 });
  });

  it("allows(): only an omitted or explicit 0 estimate is 'unknown'; negative and non-finite are refused", async () => {
    const t = await start();
    const b = t.app.media!.budget;
    const u = t.f.users.owner.id;
    expect(b.allows(u)).toBe(true);
    expect(b.allows(u, 0)).toBe(true);
    expect(b.allows(u, 49.99)).toBe(true);
    for (const bad of [-1, -0.000001, NaN, Infinity, -Infinity])
      expect(b.allows(u, bad), String(bad)).toBe(false);
  });

  it("round 2: an old key's delayed 401 or outage after a new key is media_key_changed, not the new key's error", async () => {
    for (const status of [401, 503]) {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => (release = r));
      const inner = fixtureOpenRouterFetch();
      let hold = false;
      const fetchImpl = (async (u: string | URL | Request, init?: RequestInit) => {
        if (hold && String(u) === MEDIA_CATALOG_URLS.video) {
          await gate;
          return new Response("{}", { status });
        }
        return inner(u, init);
      }) as typeof fetch;
      const t = service({ fetchImpl });
      await t.svc.registerKey(GOOD_KEY, t.svc.generation(), yes);
      hold = true;
      const pending = t.svc.catalog("video");
      await t.svc.registerKey(KEY_B, t.svc.generation(), yes);
      release();
      await expect(pending, String(status)).rejects.toMatchObject({ code: "media_key_changed", status: 409 });
      // The same key's own failure still maps as before.
      const again = t.svc.catalog("video", true);
      await expect(again).rejects.toMatchObject({
        code: status === 401 ? "media_key_invalid" : "media_catalog_failed",
      });
    }
  });

  it("round 2: a non-OK answer's body is cancelled before the error", async () => {
    for (const status of [401, 403, 503]) {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(c) {
          c.enqueue(new TextEncoder().encode("x".repeat(1024)));
        },
        cancel() {
          cancelled = true;
        },
      });
      const fetchImpl = (async () => new Response(body, { status })) as unknown as typeof fetch;
      await expect(openRouterGet(OPENROUTER_KEY_URL, { fetchImpl })).rejects.toMatchObject({
        code: status === 503 ? "failed" : "unauthorized",
      });
      expect(cancelled, String(status)).toBe(true);
    }
  });

  it("round 2: a UTF-8 BOM before the JSON is dropped (as Response.text() does), within the byte cap", async () => {
    const bytes = new Uint8Array([
      0xef,
      0xbb,
      0xbf,
      ...new TextEncoder().encode('{"data":{"limit":null,"limit_remaining":null}}'),
    ]);
    const fetchImpl = (async () => new Response(bytes)) as unknown as typeof fetch;
    expect(await checkKey(GOOD_KEY, fetchImpl)).toEqual({
      limitUsd: null,
      limitRemainingUsd: null,
      usageUsd: null,
    });
  });

  it("round 3: the generation is <process id>:<key changes> — deterministic, and independent of the key", async () => {
    const a = service({ bootId: "boot01" });
    const b = service({ bootId: "boot01" });
    const gens = async (t: ReturnType<typeof service>, key: string) => {
      const out = [t.svc.view().key.generation];
      await t.svc.registerKey(key, t.svc.generation(), yes);
      out.push(t.svc.view().key.generation);
      await t.svc.deleteKey(t.svc.generation(), yes);
      out.push(t.svc.view().key.generation);
      return out;
    };
    expect(await gens(a, GOOD_KEY)).toEqual(["boot01:0", "boot01:1", "boot01:2"]);
    // Another key, same process id: the very same generations (nothing of the key goes into them).
    expect(await gens(b, KEY_B)).toEqual(["boot01:0", "boot01:1", "boot01:2"]);
    // The default process id is random hex.
    expect(service().svc.view().key.generation).toMatch(/^[0-9a-f]{12}:0$/);
  });

  it("round 3: a catalog answers with the generation it was read with; a read for another generation is refused", async () => {
    const t = service({ bootId: "boot02" });
    await t.svc.registerKey(GOOD_KEY, t.svc.generation(), yes);
    expect((await t.svc.catalog("image")).generation).toBe("boot02:1");
    expect((await t.svc.catalog("image", false, "boot02:1")).generation).toBe("boot02:1");
    await expect(t.svc.catalog("image", false, "boot02:0")).rejects.toMatchObject({
      code: "media_key_changed",
      status: 409,
    });
    await expect(t.svc.catalog("image", true, "other:1")).rejects.toMatchObject({
      code: "media_key_changed",
    });
    // Through the route too (and a malformed generation is a bad request).
    const app = await start();
    await app.api(app.f.cookies.admin, "PUT", "/api/admin/media/key", { key: GOOD_KEY });
    const view = MediaAdmin.parse((await app.api(app.f.cookies.admin, "GET", "/api/admin/media")).json());
    const ok = await app.api(
      app.f.cookies.admin,
      "GET",
      `/api/admin/media/catalog/image?generation=${encodeURIComponent(view.key.generation)}`,
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect(MediaCatalog.parse(ok.json()).generation).toBe(view.key.generation);
    const stale = await app.api(app.f.cookies.admin, "GET", "/api/admin/media/catalog/image?generation=x:0");
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: "media_key_changed" });
    const bad = await app.api(app.f.cookies.admin, "GET", "/api/admin/media/catalog/image?generation=%20");
    expect(bad.statusCode).toBe(400);
  });

  it("round 5/9: settings saves name their revision — a stale one is media_settings_changed and saves nothing", async () => {
    const t = await start();
    const put = (settings: unknown, expectedRevision: string) =>
      t.api(t.f.cookies.admin, "PUT", "/api/admin/media/settings", { settings, expectedRevision });
    const view = () => MediaAdmin.parse(t.app.media!.admin.view());
    const r0 = view().settingsRevision;
    expect(r0).toBe(INITIAL_REVISION);
    // $20 saved from r0 → r1; then only the image count changed, made from r1 → r2: both kept.
    const twenty = { ...DEFAULT_MEDIA_SETTINGS, dailyCostLimitUsd: 20 };
    expect((await put(twenty, r0)).statusCode).toBe(200);
    const r1 = view().settingsRevision;
    expect(r1).not.toBe(r0);
    const count = { ...twenty, perRunLimits: { ...twenty.perRunLimits, image: 2 } };
    expect((await put(count, r1)).statusCode).toBe(200);
    const r2 = view().settingsRevision;
    expect(new Set([r0, r1, r2]).size).toBe(3);
    expect(view()).toMatchObject({ settings: { dailyCostLimitUsd: 20, perRunLimits: { image: 2 } } });
    // A form still showing the old $50 (made from r1) cannot put it back.
    const stale = await put({ ...DEFAULT_MEDIA_SETTINGS, perRunLimits: { ...count.perRunLimits } }, r1);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: "media_settings_changed" });
    expect(view()).toMatchObject({ settingsRevision: r2, settings: { dailyCostLimitUsd: 20 } });
    // The body must name a revision.
    expect(
      (await t.api(t.f.cookies.admin, "PUT", "/api/admin/media/settings", { settings: twenty })).statusCode,
    ).toBe(400);
  });

  it("round 9: a restored backup never lets an open draft's base match by accident", async () => {
    const t = await start();
    const put = (settings: unknown, expectedRevision: string) =>
      t.api(t.f.cookies.admin, "PUT", "/api/admin/media/settings", { settings, expectedRevision });
    const rev = () => t.app.media!.settings.revision();
    const row = (k: string) =>
      t.db
        .select()
        .from(settingsTable)
        .all()
        .find((x) => x.key === k)?.value;
    // R1 saved (the backup is taken here), then R2 saved; a draft is open on R2.
    expect((await put({ ...DEFAULT_MEDIA_SETTINGS, dailyCostLimitUsd: 10 }, rev())).statusCode).toBe(200);
    const r1 = rev();
    const backup = { settings: row(MEDIA_SETTINGS_KEY)!, revision: row(MEDIA_SETTINGS_REVISION_KEY)! };
    expect((await put({ ...DEFAULT_MEDIA_SETTINGS, dailyCostLimitUsd: 20 }, r1)).statusCode).toBe(200);
    const r2 = rev();
    // The backup is restored (the rows go back to R1), and someone saves from it → R3.
    t.app.media!.settings.set(JSON.parse(backup.settings), backup.revision);
    expect(rev()).toBe(r1);
    expect((await put({ ...DEFAULT_MEDIA_SETTINGS, dailyCostLimitUsd: 30 }, r1)).statusCode).toBe(200);
    const r3 = rev();
    expect(r3).not.toBe(r2);
    // The draft based on R2 is refused (a counter would have matched: v1 → v2 → restore v1 → v2).
    const draft = await put({ ...DEFAULT_MEDIA_SETTINGS, dailyCostLimitUsd: 99 }, r2);
    expect(draft.statusCode).toBe(409);
    expect(t.app.media!.settings.get().dailyCostLimitUsd).toBe(30);
  });

  it("round 5: the revision is checked again inside the write's transaction", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const inner = fixtureOpenRouterFetch();
    let hold = false;
    const fetchImpl = (async (u: string | URL | Request, init?: RequestInit) => {
      if (hold && String(u) === MEDIA_CATALOG_URLS.image) await gate;
      return inner(u, init);
    }) as typeof fetch;
    const t = service({ fetchImpl });
    await t.svc.registerKey(GOOD_KEY, t.svc.generation(), yes);
    hold = true;
    const pending = t.svc.saveSettings(withKind("image", "fixture/image-one"), INITIAL_REVISION, yes);
    await new Promise((r) => setTimeout(r, 10));
    // Another writer saves while the catalog is read (not through this queue).
    t.real.set(MEDIA_SETTINGS_REVISION_KEY, "someone-else");
    release();
    await expect(pending).rejects.toMatchObject({ code: "media_settings_changed", status: 409 });
    expect(t.svc.view().settings).toEqual(DEFAULT_MEDIA_SETTINGS);
  });

  it("round 5: key writes name the generation shown — another one changes nothing (no delete of an unseen key)", async () => {
    const t = await start();
    const g0 = t.app.media!.admin.generation();
    await t.api(t.f.cookies.admin, "PUT", "/api/admin/media/key", { key: GOOD_KEY, expectedGeneration: g0 });
    const g1 = t.app.media!.admin.generation();
    // Another tab replaced it with B (g1 → g2); this screen still shows g1.
    await t.api(t.f.cookies.admin, "PUT", "/api/admin/media/key", { key: KEY_B, expectedGeneration: g1 });
    const before = t.requests.length;
    const del = await t.api(t.f.cookies.admin, "DELETE", "/api/admin/media/key", { expectedGeneration: g1 });
    expect(del.statusCode).toBe(409);
    expect(del.json()).toEqual({ error: "media_key_changed" });
    expect(t.app.media!.keys.resolve()).toEqual({ key: KEY_B, source: "admin" });
    const check = await t.api(t.f.cookies.admin, "POST", "/api/admin/media/key/check", {
      expectedGeneration: g1,
    });
    expect(check.statusCode).toBe(409);
    const reg = await t.api(t.f.cookies.admin, "PUT", "/api/admin/media/key", {
      key: GOOD_KEY,
      expectedGeneration: g1,
    });
    expect(reg.statusCode).toBe(409);
    // Refused before OpenRouter is asked, nothing changed.
    expect(t.requests.length).toBe(before);
    expect(t.app.media!.keys.resolve()).toEqual({ key: KEY_B, source: "admin" });
    // A write without the generation is a bad request.
    expect(
      (
        await t.app.inject({
          method: "DELETE",
          url: "/api/admin/media/key",
          headers: { ...WRITE, cookie: t.f.cookies.admin, "content-type": "application/json" },
          payload: {},
        })
      ).statusCode,
    ).toBe(400);
  });
});
