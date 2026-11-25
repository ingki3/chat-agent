import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CSRF_HEADER,
  DEFAULT_MEDIA_SETTINGS,
  MEDIA_TOOL_CODES,
  MEDIA_TOOL_HINTS,
  type MediaSettings,
  type MessagePart,
  type Run,
} from "@agentlee/shared";
import { IMAGE_GENERATE_TOOL, MEDIA_TOOLS, SPEECH_GENERATE_TOOL } from "@agentlee/mcp-tools/media";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import zlib from "node:zlib";
import { byteRange, FILE_CSP } from "../src/files/routes.js";
import { imageCostBound, speechCostBound } from "../src/media/cost.js";
import { imageSize, MAX_PARTS, MAX_RUNS, stripImage, textRuns } from "../src/media/strip.js";
import { MAX_TRIES, MediaRecovery, MediaSettler, recoverMediaReservations } from "../src/media/settle.js";
import Database from "better-sqlite3";
import { openDb, runMigrations } from "../src/db/client.js";
import { compose } from "../src/notifications/compose.js";
import { usageRecords } from "../src/db/schema.js";
import { addRow, emptyTotals, UsageService } from "../src/usage/service.js";
import { mediaRunKey, UsageStore } from "../src/usage/store.js";
import {
  FIXTURE_GENERATION_ID,
  FIXTURE_IMAGE_COST,
  FIXTURE_OPENROUTER_KEY_PREFIX,
  FIXTURE_SPEECH_COST,
  fixtureOpenRouterFetch,
  fixtureSpeechAudio,
  silentMp3,
  solidPng,
} from "../src/media/fixture.js";
import { imageKindOf, isMp3 } from "../src/media/generate.js";
import {
  fetchCatalog,
  imageEndpointsUrl,
  MEDIA_CATALOG_URLS,
  OPENROUTER_IMAGES_URL,
  OPENROUTER_SPEECH_URL,
  SPEECH_PRICING_URL,
} from "../src/media/openrouter.js";
import { MEDIA_TOOL_CODE_VALUES } from "../src/observability/policy.js";
import { codexRunConfig } from "../src/runtime/lockdown.js";
import { RuntimeRegistry } from "../src/runtime/adapter.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import { knownSecrets } from "../src/secrets/known.js";
import { createFamily } from "./helpers/permission-matrix.js";

vi.setConfig({ testTimeout: 60_000 });

/**
 * 미디어 생성 stage 2 (#238): `image_generate` / `speech_generate` — offered only while the kind is on, every check
 * before a call (switch, key, per-run limit, daily budget with in-flight reservations, egress guard, youth
 * moderation, the request policy), the stored file linked to the reply, the cost as OpenRouter reported it — and the
 * catalog prices in OpenRouter's documented shapes. OpenRouter is always the scripted fixture or a fake `fetchImpl`
 * with synthetic keys — never the network.
 */

type App = Awaited<ReturnType<typeof buildApp>>;
const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const LOCAL = { host: "localhost:3000" };
const WRITE = { ...LOCAL, origin: "http://localhost:3000", [CSRF_HEADER]: "1" };
const KEY = `${FIXTURE_OPENROUTER_KEY_PREFIX}-synthetic-0000000000000000000000tool`;

function tmp(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-media-tools-")));
  closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type Req = { url: string; method: string; body: Record<string, unknown> | undefined; auth: string | null };

/** The fixture OpenRouter (or `inner`), recording every request with its parsed JSON body. */
function recording(inner: typeof fetch = fixtureOpenRouterFetch()) {
  const requests: Req[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    requests.push({
      url: String(url),
      method: init?.method ?? "GET",
      body,
      auth: new Headers(init?.headers).get("authorization"),
    });
    return inner(url, init);
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const settingsWith = (
  over: Partial<Record<"image" | "speech", string | null>>,
  more: Partial<MediaSettings> = {},
): MediaSettings => {
  const s = structuredClone(DEFAULT_MEDIA_SETTINGS);
  for (const [k, model] of Object.entries(over) as ["image" | "speech", string | null][])
    s.kinds[k] = { enabled: model !== null, model };
  return { ...s, ...more };
};

async function start(o: { fetchImpl?: typeof fetch; key?: string | null } = {}) {
  const dataDir = path.join(tmp(), "data");
  const registry = new RuntimeRegistry();
  registry.register(new FakeRuntime({ runTools: true }));
  const db = createTestDb();
  const rec = recording(o.fetchImpl);
  const app = await buildApp(
    loadConfig({
      NODE_ENV: "test",
      DATA_DIR: dataDir,
      MASTER_KEY_PATH: path.join(tmp(), "master.key"),
      ...(o.key === null ? {} : { OPENROUTER_API_KEY: o.key ?? KEY }),
    }),
    {
      db,
      runtimes: registry,
      runs: { flushMs: 0 },
      // Speech is made only where its length can be measured (#251 r3): the scripted ffprobe/ffmpeg.
      media: {
        fetchImpl: rec.fetchImpl,
        sleep: async () => {},
        speechAudio: () => fixtureSpeechAudio(dataDir),
      },
    },
  );
  closers.push(() => app.close());
  const f = await createFamily(app);
  const api = (cookie: string, method: "POST" | "GET", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { ...WRITE, cookie, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  const send = async (conversationId: string, text: string, cookie = f.cookies.owner) => {
    const res = await api(cookie, "POST", `/api/conversations/${conversationId}/messages`, { text });
    expect(res.statusCode, res.body).toBe(201);
    return waitRun(app, (res.json() as { run: Run }).run.id);
  };
  /** A run of the owner that is "still running" (the generator works only for an open run). */
  const scopeOf = async (conversationId: string) => {
    const r = await send(conversationId, "안녕");
    db.$client.prepare("UPDATE runs SET ended_at = NULL WHERE id = ?").run(r.run.id);
    return { userId: f.users.owner.id, conversationId, runId: r.run.id };
  };
  const enable = (s: MediaSettings) => app.media!.settings.set(s);
  const usageRows = () =>
    db.$client
      .prepare(
        "SELECT run_id, model, cost_usd, priced_cost_micros, estimated_cost_micros, purpose FROM usage_records WHERE purpose = 'media'",
      )
      .all() as {
      run_id: string;
      model: string;
      cost_usd: number | null;
      priced_cost_micros: number | null;
      estimated_cost_micros: number | null;
    }[];
  const posts = () => rec.requests.filter((r) => r.method === "POST");
  return {
    app,
    db,
    f,
    api,
    send,
    scopeOf,
    enable,
    usageRows,
    posts,
    requests: rec.requests,
    fetchImpl: rec.fetchImpl,
  };
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

const outputOf = (r: { results: { output?: unknown }[] }, i = 0) =>
  r.results[i]!.output as Record<string, unknown> & { file?: { fileId: string; kind: string } };

// ---------------------------------------------------------------- catalog prices (documented shapes)

describe("media catalogs: prices in OpenRouter's documented shapes (#238 stage 2)", () => {
  /** A fake OpenRouter answering only these URLs (anything else 404). */
  const answering = (routes: Record<string, unknown>) => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      seen.push(String(url));
      const body = routes[String(url)];
      return body === undefined ? Response.json({}, { status: 404 }) : Response.json(body);
    }) as typeof fetch;
    return { fetchImpl, seen };
  };

  it("images: `endpoints` is a URL string — prices come from each model's endpoint records (built from the id)", async () => {
    const f = answering({
      [MEDIA_CATALOG_URLS.image]: {
        data: [
          {
            id: "bytedance-seed/seedream-4.5",
            name: "Seedream 4.5",
            architecture: { input_modalities: ["text", "image"], output_modalities: ["image"] },
            supported_parameters: { resolution: { type: "enum", values: ["1K", "2K", "4K"] } },
            supports_streaming: false,
            // The documented shape — never followed as given: the URL is built from the id.
            endpoints: "https://evil.example/steal",
          },
          { id: "a/input-only", name: "Input lines only", supported_parameters: {}, endpoints: "/x" },
          { id: "a/megapixel", name: "Per megapixel", supported_parameters: {}, endpoints: "/w" },
          { id: "a/no-record", name: "No record", supported_parameters: {}, endpoints: "/y" },
          { id: "a/variant:free", name: "A variant", supported_parameters: {}, endpoints: "/z" },
        ],
      },
      "https://openrouter.ai/api/v1/images/models/bytedance-seed/seedream-4.5/endpoints": {
        id: "bytedance-seed/seedream-4.5",
        endpoints: [
          {
            provider_name: "Bytedance",
            provider_slug: "bytedance",
            provider_tag: "bytedance",
            supported_parameters: {},
            allowed_passthrough_parameters: [],
            supports_streaming: false,
            pricing: [
              { billable: "input_image", unit: "image", cost_usd: 0.01 },
              { billable: "output_image", unit: "image", cost_usd: 0.05 },
            ],
          },
        ],
      },
      "https://openrouter.ai/api/v1/images/models/a/megapixel/endpoints": {
        endpoints: [
          { pricing: [{ billable: "output_image", unit: "megapixel", cost_usd: 0.02, variant: "4K" }] },
        ],
      },
      "https://openrouter.ai/api/v1/images/models/a/input-only/endpoints": {
        endpoints: [{ pricing: [{ billable: "input_text", unit: "token", cost_usd: 0.000002 }] }],
      },
      "https://openrouter.ai/api/v1/images/models/a/variant%3Afree/endpoints": {
        endpoints: [{ pricing: [{ billable: "output_image", unit: "image", cost_usd: 0 }] }],
      },
    });
    const c = await fetchCatalog("image", { fetchImpl: f.fetchImpl });
    const by = Object.fromEntries(c.models.map((m) => [m.id, m.price]));
    expect(by).toEqual({
      // The first endpoint's output price (the input line is left out when an output line is listed).
      "bytedance-seed/seedream-4.5": "$0.05/image",
      "a/input-only": "$0.000002/token",
      "a/megapixel": "$0.02/megapixel (4K)",
      "a/no-record": null,
      "a/variant:free": null,
    });
    expect(f.seen).not.toContain("https://evil.example/steal");
    expect(f.seen.filter((u) => u.includes("/endpoints"))).toHaveLength(5);
    // A save's model check reads the list alone.
    const before = f.seen.length;
    const bare = await fetchCatalog("image", { fetchImpl: f.fetchImpl, prices: false });
    expect(f.seen.length - before).toBe(1);
    expect(bare.models.every((m) => m.price === null)).toBe(true);
  });

  it("speech: the speech list has no prices — they come from the Models API (per character, per second)", async () => {
    const list = {
      data: [
        { id: "openai/gpt-4o-mini-tts", name: "GPT-4o mini TTS", output_modalities: [], endpoints: [] },
        { id: "bytedance-seed/seed-audio-1-0", name: "Seed Audio", output_modalities: [], endpoints: [] },
        { id: "x/unpriced", name: "Unpriced", output_modalities: [], endpoints: [] },
      ],
    };
    const f = answering({
      [MEDIA_CATALOG_URLS.speech]: list,
      [SPEECH_PRICING_URL]: {
        data: [
          { id: "openai/gpt-4o-mini-tts", pricing: { prompt: "0.0000006", completion: "0" } },
          { id: "bytedance-seed/seed-audio-1-0", pricing: { prompt: "0", completion: "0.0025" } },
          { id: "x/unpriced", pricing: { prompt: "0", completion: "0" } },
        ],
      },
    });
    const c = await fetchCatalog("speech", { fetchImpl: f.fetchImpl });
    expect(Object.fromEntries(c.models.map((m) => [m.id, m.price]))).toEqual({
      // The unit (characters, tokens or seconds) is the model's and not in the answer: not asserted (review r1).
      "openai/gpt-4o-mini-tts": "$0.0000006/입력 단위 (단위 미확정: 글자·토큰·초 중 모델마다 다름)",
      "bytedance-seed/seed-audio-1-0": "$0.0025/출력 단위 (단위 미확정: 글자·토큰·초 중 모델마다 다름)",
      "x/unpriced": null,
    });
    // The price list down: the speech list still answers (prices "목록에 없음").
    const down = answering({ [MEDIA_CATALOG_URLS.speech]: list });
    const c2 = await fetchCatalog("speech", { fetchImpl: down.fetchImpl });
    expect(c2.models.map((m) => m.price)).toEqual([null, null, null]);
  });

  it("music: a voice-chat model (it lists `supported_voices`) is told apart from a music model", async () => {
    const f = answering({
      [MEDIA_CATALOG_URLS.music]: {
        data: [
          {
            id: "openai/gpt-audio",
            name: "GPT Audio",
            architecture: { input_modalities: ["text", "audio"], output_modalities: ["text", "audio"] },
            pricing: { prompt: "0.0000025", completion: "0.00001" },
            supported_voices: ["alloy", "echo"],
            supported_parameters: ["temperature"],
          },
          {
            id: "google/lyria-3-pro-preview",
            name: "Lyria 3 Pro",
            architecture: { input_modalities: ["text", "image"], output_modalities: ["text", "audio"] },
            pricing: { prompt: "0", completion: "0", request: "0.08" },
            supported_voices: null,
          },
        ],
      },
    });
    const c = await fetchCatalog("music", { fetchImpl: f.fetchImpl });
    expect(c.models.map((m) => [m.id, m.price, !!m.voiceChat])).toEqual([
      ["google/lyria-3-pro-preview", "$0.08/request", false],
      ["openai/gpt-audio", "$0.0000025/prompt, $0.00001/completion", true],
    ]);
    expect(c.models[1]!.options[0]).toBe("음성 대화 모델(음악 생성용 아님)");
  });
});

// ---------------------------------------------------------------- the tools

describe("image_generate / speech_generate (#238 stage 2)", () => {
  it("tool descriptions carry the forbidden uses; fixed codes are logged; Codex gets a long enough tool timeout", () => {
    for (const t of MEDIA_TOOLS) {
      expect(t.description).toMatch(/ONLY when the user explicitly asked/);
      expect(t.description).toMatch(/real, identifiable person/);
      expect(t.description).toMatch(/sexual/);
    }
    expect(SPEECH_GENERATE_TOOL.description).toMatch(/never clone or imitate someone's voice/);
    // The speech tool takes no reference audio at all (no voice cloning through input_references).
    expect(Object.keys(SPEECH_GENERATE_TOOL.input).sort()).toEqual(["instructions", "text", "voice"]);
    expect(Object.keys(IMAGE_GENERATE_TOOL.input).sort()).toEqual([
      "aspectRatio",
      "prompt",
      "referenceFileIds",
    ]);
    expect([...MEDIA_TOOL_CODE_VALUES].sort()).toEqual([...MEDIA_TOOL_CODES].sort());
    for (const code of Object.keys(MEDIA_TOOL_HINTS)) expect(MEDIA_TOOL_CODES).toContain(code);
    const toml = codexRunConfig({
      model: "gpt-test",
      tools: ["image_generate"],
      mcp: { url: "http://127.0.0.1:4000/mcp", token: "t" },
    }).join("\n");
    expect(toml).toMatch(/tool_timeout_sec = 2[0-9]{2}/);
  });

  it("offered only while the kind is on with a model and a key — youth too, never in a scheduled run", async () => {
    const t = await start();
    const names = (id: string, skills?: string[]) => t.app.mcp!.toolNamesFor(id, skills);
    expect(names(t.f.users.owner.id)).not.toContain("image_generate");
    t.enable(settingsWith({ image: "fixture/image-one" }));
    expect(names(t.f.users.owner.id)).toContain("image_generate");
    expect(names(t.f.users.owner.id)).not.toContain("speech_generate");
    const son = t.app.users!.create({
      email: "son@matrix.test",
      name: "아들",
      role: "member",
      passwordHash: "x",
      youth: true,
    });
    expect(names(son.id)).toContain("image_generate");
    // A run with a skill scope (a scheduled run): nobody asked there.
    expect(names(t.f.users.owner.id, ["search-google"])).not.toContain("image_generate");
    t.enable(settingsWith({ image: "fixture/image-one", speech: "fixture/voice-one" }));
    expect(names(t.f.users.owner.id)).toEqual(expect.arrayContaining(["image_generate", "speech_generate"]));
    t.enable(settingsWith({ image: null, speech: null }));
    expect(names(t.f.users.owner.id)).not.toContain("image_generate");
  });

  it("without a key the tools are not offered and a call is media_no_key", async () => {
    const t = await start({ key: null });
    t.enable(settingsWith({ image: "fixture/image-one" }));
    expect(t.app.mcp!.toolNamesFor(t.f.users.owner.id)).not.toContain("image_generate");
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    expect(await t.app.media!.tools.run("image", scope, { prompt: "고양이" })).toMatchObject({
      ok: false,
      code: "media_no_key",
    });
  });

  it("an image: one POST with the policy, stored as a PNG of the reply, shown inline, cost recorded", async () => {
    const t = await start();
    t.enable(settingsWith({ image: "fixture/image-one" }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const r = await t.send(conv.id, "/image 노을 진 바다 위 작은 배");
    const out = outputOf(r);
    expect(out).toMatchObject({ status: "ok", model: "fixture/image-one", costUsd: FIXTURE_IMAGE_COST });
    expect(out.file).toMatchObject({ kind: "png" });
    // The request: the fixed URL, the key only in Authorization, data collection denied, no moderation (adult).
    const [post, ...more] = t.posts();
    expect(more).toEqual([]);
    expect(post!.url).toBe(OPENROUTER_IMAGES_URL);
    expect(post!.auth).toBe(`Bearer ${KEY}`);
    expect(post!.body).toEqual({
      model: "fixture/image-one",
      prompt: "노을 진 바다 위 작은 배",
      n: 1,
      response_format: "b64_json",
      provider: { data_collection: "deny" },
    });
    // The reply links the file (an inline preview in the chat).
    expect(r.parts).toContainEqual(expect.objectContaining({ type: "file_ref", fileId: out.fileId }));
    const content = await t.app.inject({
      url: `/api/files/${String(out.fileId)}/content?inline=1`,
      headers: { ...LOCAL, cookie: t.f.cookies.owner },
    });
    expect(content.statusCode).toBe(200);
    expect(content.headers["content-type"]).toBe("image/png");
    expect(String(content.headers["content-disposition"])).toMatch(/^inline; /);
    expect(content.headers["content-security-policy"]).toBe(FILE_CSP);
    expect(imageKindOf(content.rawPayload)).toBe("png");
    // The cost as OpenRouter reported it, one media row for this call.
    const rows = t.usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ model: "fixture/image-one", cost_usd: FIXTURE_IMAGE_COST });
    expect(rows[0]!.run_id).toMatch(new RegExp(`^${r.run.id}#media:`));
  });

  it("a youth account asks for the strictest moderation the model lists", async () => {
    const t = await start();
    t.enable(settingsWith({ image: "fixture/image-one" }));
    t.db.$client.prepare("UPDATE users SET youth = 1 WHERE id = ?").run(t.f.users.owner.id);
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    const r = await t.app.media!.tools.run("image", scope, { prompt: "공룡 그림" });
    expect(r.ok).toBe(true);
    // The fixture model lists moderation: auto | low — "auto" is the stricter.
    expect(t.posts()[0]!.body).toMatchObject({ moderation: "auto", provider: { data_collection: "deny" } });
  });

  it("an aspect ratio the model does not list is refused before any POST; a listed one is sent", async () => {
    const t = await start();
    t.enable(settingsWith({ image: "fixture/image-one" }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    const bad = await t.app.media!.tools.run("image", scope, { prompt: "산", aspectRatio: "4:3" });
    expect(bad).toMatchObject({ ok: false, code: "media_bad_option" });
    expect(!bad.ok && bad.hint).toMatch(/1:1, 16:9, 9:16/);
    expect(t.posts()).toEqual([]);
    const ok = await t.app.media!.tools.run("image", scope, { prompt: "산", aspectRatio: "16:9" });
    expect(ok.ok).toBe(true);
    expect(t.posts()[0]!.body).toMatchObject({ aspect_ratio: "16:9" });
    // Strict input: an unknown argument is refused.
    expect(await t.app.media!.tools.run("image", scope, { prompt: "산", n: 4 })).toMatchObject({
      code: "media_bad_input",
    });
  });

  it("per-run limit: the admin's perRunLimits per kind", async () => {
    const t = await start();
    t.enable(
      settingsWith(
        { image: "fixture/image-one" },
        { perRunLimits: { ...DEFAULT_MEDIA_SETTINGS.perRunLimits, image: 1 } },
      ),
    );
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    expect((await t.app.media!.tools.run("image", scope, { prompt: "하나" })).ok).toBe(true);
    expect(await t.app.media!.tools.run("image", scope, { prompt: "둘" })).toMatchObject({
      ok: false,
      code: "media_quota",
    });
    expect(t.posts()).toHaveLength(1);
    // Another run starts over.
    const next = await t.scopeOf(conv.id);
    expect((await t.app.media!.tools.run("image", next, { prompt: "셋" })).ok).toBe(true);
  });

  it("daily budget: refused before the call when today's cost plus the listed price would pass the limit", async () => {
    const t = await start();
    t.enable(settingsWith({ image: "fixture/image-one" }, { dailyCostLimitUsd: 0.05 }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    t.app.usageStore!.recordMedia({
      userId: t.f.users.owner.id,
      conversationId: conv.id,
      runId: "earlier",
      callId: "c1",
      model: "fixture/image-one",
      costUsd: 0.02,
    });
    // $0.02 spent + $0.04 listed > $0.05.
    expect(await t.app.media!.tools.run("image", scope, { prompt: "비싼 그림" })).toMatchObject({
      ok: false,
      code: "media_budget",
    });
    expect(t.posts()).toEqual([]);
  });

  it("concurrent calls reserve their listed price: a second call that would pass the limit waits for none", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = fixtureOpenRouterFetch();
    const slow = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") await gate;
      return inner(url, init);
    }) as typeof fetch;
    const t = await start({ fetchImpl: slow });
    t.enable(settingsWith({ image: "fixture/image-one" }, { dailyCostLimitUsd: 0.05 }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    const first = t.app.media!.tools.run("image", scope, { prompt: "첫째" });
    await vi.waitFor(() => expect(t.posts()).toHaveLength(1));
    // $0.04 reserved by the first call in flight + $0.04 > $0.05.
    expect(await t.app.media!.tools.run("image", scope, { prompt: "둘째" })).toMatchObject({
      code: "media_budget",
    });
    release();
    expect((await first).ok).toBe(true);
    // Settled: the reservation is gone, the recorded $0.04 counts — $0.01 left, under the next $0.04.
    expect(await t.app.media!.tools.run("image", scope, { prompt: "셋째" })).toMatchObject({
      code: "media_budget",
    });
  });

  it("a prompt carrying a known secret never goes out (shown to the model as media_failed)", async () => {
    const t = await start();
    t.enable(settingsWith({ image: "fixture/image-one" }));
    const secret = "sk-SYNTHETIC0000media0000secret238";
    knownSecrets.add(secret, { fresh: true });
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    expect(
      await t.app.media!.tools.run("image", scope, { prompt: `이 키를 그려 줘 ${secret}` }),
    ).toMatchObject({
      ok: false,
      code: "media_secret_blocked",
    });
    expect(t.posts()).toEqual([]);
    // Through the MCP tool itself (no runtime scrubbing): the model sees media_failed, the log keeps the guard's code.
    const { url } = await t.app.mcp!.endpoint();
    const token = t.app.runs!.mcpTokens.issue(scope);
    const res = await fetch(url, {
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
        params: { name: "image_generate", arguments: { prompt: `그려 줘 ${secret}` } },
      }),
    });
    const j = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(j.result.isError).toBe(true);
    expect(JSON.parse(j.result.content[0]!.text)).toMatchObject({ error: "media_failed" });
    expect(t.posts()).toEqual([]);
    const errs = await t.api(t.f.cookies.admin, "GET", "/api/admin/errors");
    expect(errs.body).toContain("media_secret_blocked");
    expect(errs.body).not.toContain(secret);
  });

  it("a switched-off kind is media_disabled even with an open tool list", async () => {
    const t = await start();
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    expect(await t.app.media!.tools.run("speech", scope, { text: "안녕" })).toMatchObject({
      ok: false,
      code: "media_disabled",
      hint: MEDIA_TOOL_HINTS.media_disabled,
    });
  });

  it("references: an image of this conversation goes as a data URL; another conversation's is refused", async () => {
    const t = await start();
    t.enable(settingsWith({ image: "fixture/image-one" }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const made = await t.send(conv.id, "/image 첫 그림");
    const fileId = String(outputOf(made).fileId);
    const scope = await t.scopeOf(conv.id);
    expect(
      (await t.app.media!.tools.run("image", scope, { prompt: "더 밝게", referenceFileIds: [fileId] })).ok,
    ).toBe(true);
    const refs = t.posts()[1]!.body!.input_references as { type: string; image_url: { url: string } }[];
    expect(refs).toHaveLength(1);
    expect(refs[0]!.type).toBe("image_url");
    expect(refs[0]!.image_url.url).toMatch(/^data:image\/png;base64,iVBOR/);
    const other = t.app.conversations!.create(t.f.users.owner.id);
    const otherScope = await t.scopeOf(other.id);
    expect(
      await t.app.media!.tools.run("image", otherScope, { prompt: "x", referenceFileIds: [fileId] }),
    ).toMatchObject({ ok: false, code: "media_reference_invalid" });
    expect(t.posts()).toHaveLength(2);
  });

  it("OpenRouter refusals: 402 media_payment, 400 media_refused, 429 media_rate_limited — nothing recorded", async () => {
    let status = 402;
    const inner = fixtureOpenRouterFetch();
    const failing = (async (url: string | URL | Request, init?: RequestInit) =>
      init?.method === "POST"
        ? Response.json({ error: { code: status } }, { status })
        : inner(url, init)) as typeof fetch;
    const t = await start({ fetchImpl: failing });
    t.enable(
      settingsWith(
        { image: "fixture/image-one" },
        { perRunLimits: { image: 10, speech: 3, music: 1, video: 1 } },
      ),
    );
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    for (const [s, code] of [
      [402, "media_payment"],
      [400, "media_refused"],
      [429, "media_rate_limited"],
      [500, "media_failed"],
    ] as const) {
      status = s;
      expect(await t.app.media!.tools.run("image", scope, { prompt: "x" }), String(s)).toMatchObject({
        code,
      });
    }
    expect(t.usageRows()).toEqual([]);
  });

  it("an answer that is not a raster image is not stored — but its cost is recorded", async () => {
    const inner = fixtureOpenRouterFetch();
    const svg = (async (url: string | URL | Request, init?: RequestInit) =>
      init?.method === "POST"
        ? Response.json({
            data: [{ b64_json: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>").toString("base64") }],
            usage: { cost: 0.01 },
          })
        : inner(url, init)) as typeof fetch;
    const t = await start({ fetchImpl: svg });
    t.enable(settingsWith({ image: "fixture/image-one" }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    expect(await t.app.media!.tools.run("image", scope, { prompt: "x" })).toMatchObject({
      code: "media_unsupported_model",
    });
    expect(t.app.files!.list(conv.id).filter((f) => f.kind !== "txt")).toEqual([]);
    expect(t.usageRows().map((r) => r.cost_usd)).toEqual([0.01]);
  });

  it("a run that ended while the image was made stores nothing (the cost is still recorded)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const inner = fixtureOpenRouterFetch();
    const slow = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "POST") await gate;
      return inner(url, init);
    }) as typeof fetch;
    const t = await start({ fetchImpl: slow });
    t.enable(settingsWith({ image: "fixture/image-one" }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    const call = t.app.media!.tools.run("image", scope, { prompt: "x" });
    await vi.waitFor(() => expect(t.posts()).toHaveLength(1));
    t.db.$client.prepare("UPDATE runs SET ended_at = 1 WHERE id = ?").run(scope.runId);
    release();
    expect(await call).toMatchObject({ ok: false, code: "media_cancelled" });
    expect(t.app.files!.list(conv.id)).toEqual([]);
    expect(t.usageRows()).toHaveLength(1);
  });

  it("speech: an MP3 of the reply with the model's first voice, its cost from the generation record", async () => {
    const t = await start();
    t.enable(settingsWith({ speech: "fixture/voice-one" }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const r = await t.send(conv.id, "/speech 안녕하세요, 오늘 날씨가 좋네요.");
    const out = outputOf(r);
    expect(out).toMatchObject({
      status: "ok",
      model: "fixture/voice-one",
      voice: "alloy",
      costUsd: FIXTURE_SPEECH_COST,
    });
    expect(out.file).toMatchObject({ kind: "mp3" });
    const [post] = t.posts();
    expect(post!.url).toBe(OPENROUTER_SPEECH_URL);
    expect(post!.body).toEqual({
      model: "fixture/voice-one",
      input: "안녕하세요, 오늘 날씨가 좋네요.",
      response_format: "mp3",
      voice: "alloy",
      provider: { data_collection: "deny" },
    });
    expect(t.requests.map((q) => q.url)).toContain(
      `https://openrouter.ai/api/v1/generation?id=${FIXTURE_GENERATION_ID}`,
    );
    expect(r.parts).toContainEqual(expect.objectContaining({ type: "file_ref", fileId: out.fileId }));
    const content = await t.app.inject({
      url: `/api/files/${String(out.fileId)}/content?inline=1`,
      headers: { ...LOCAL, cookie: t.f.cookies.owner },
    });
    expect(content.headers["content-type"]).toBe("audio/mpeg");
    expect(String(content.headers["content-disposition"])).toMatch(/^inline; /);
    expect(String(content.headers["content-security-policy"])).toContain("media-src 'self'");
    expect(isMp3(content.rawPayload)).toBe(true);
    // One row: first without a cost, then the reported cost on the same row.
    expect(t.usageRows()).toEqual([expect.objectContaining({ cost_usd: FIXTURE_SPEECH_COST })]);
  });

  it("speech: no generation record → the cost stays null (not reported), the file is stored", async () => {
    const inner = fixtureOpenRouterFetch();
    const noRecord = (async (url: string | URL | Request, init?: RequestInit) =>
      String(url).includes("/generation?")
        ? Response.json({ error: { code: 404 } }, { status: 404 })
        : inner(url, init)) as typeof fetch;
    const t = await start({ fetchImpl: noRecord });
    t.enable(settingsWith({ speech: "fixture/voice-one" }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    const r = await t.app.media!.tools.run("speech", scope, {
      text: "안녕",
      voice: "nova",
      instructions: "천천히",
    });
    expect(r).toMatchObject({ ok: true, output: { costUsd: null, voice: "nova" } });
    expect(t.posts()[0]!.body).toMatchObject({ voice: "nova", instructions: "천천히" });
    expect(t.requests.filter((q) => q.url.includes("/generation?"))).toHaveLength(3);
    expect(t.usageRows()).toEqual([expect.objectContaining({ cost_usd: null, priced_cost_micros: null })]);
  });

  it("speech: a voice the model does not list is refused; a PCM-only model is media_unsupported_model", async () => {
    const t = await start();
    t.enable(settingsWith({ speech: "fixture/voice-one" }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    const bad = await t.app.media!.tools.run("speech", scope, { text: "안녕", voice: "Morgan Freeman" });
    expect(bad).toMatchObject({ ok: false, code: "media_bad_option" });
    expect(!bad.ok && bad.hint).toMatch(/alloy, nova/);
    expect(t.posts()).toEqual([]);

    const inner = fixtureOpenRouterFetch();
    const pcmOnly = (async (url: string | URL | Request, init?: RequestInit) =>
      String(url).endsWith("/audio/speech/models/fixture/voice-one")
        ? Response.json({
            id: "fixture/voice-one",
            output_modalities: [
              {
                type: "speech",
                supported_parameters: { response_format: { type: "enum", values: ["pcm"] } },
              },
            ],
            endpoints: [],
          })
        : inner(url, init)) as typeof fetch;
    const t2 = await start({ fetchImpl: pcmOnly });
    t2.enable(settingsWith({ speech: "fixture/voice-one" }));
    const conv2 = t2.app.conversations!.create(t2.f.users.owner.id);
    const scope2 = await t2.scopeOf(conv2.id);
    expect(await t2.app.media!.tools.run("speech", scope2, { text: "안녕" })).toMatchObject({
      code: "media_unsupported_model",
    });
    expect(t2.posts()).toEqual([]);
  });

  it("sniffers: raster kinds and MP3 by content", () => {
    expect(imageKindOf(solidPng(2, 2, [0, 0, 0]))).toBe("png");
    expect(imageKindOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpg");
    expect(imageKindOf(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]))).toBe(
      "webp",
    );
    expect(imageKindOf(Buffer.from("<svg/>"))).toBeUndefined();
    expect(isMp3(silentMp3(1))).toBe(true);
    expect(isMp3(Buffer.from([0xff, 0xfb, 0x90, 0x64]))).toBe(true);
    expect(isMp3(Buffer.from("RIFF0000WAVE"))).toBe(false);
  });
});

// ---------------------------------------------------------------- review round 1 (#246)

/** A PNG with extra chunks after IHDR (`[type, data]`), e.g. a tEXt holding a secret. */
function pngWith(extra: [string, Buffer][]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const base = solidPng(4, 4, [200, 10, 10]);
  const ihdrEnd = 8 + 12 + 13;
  return Buffer.concat([
    base.subarray(0, ihdrEnd),
    ...extra.map(([t, d]) => chunk(t, d)),
    base.subarray(ihdrEnd),
  ]);
}

/** The fixture, with some URLs answered otherwise (a function of the request) and an optional POST gate. */
function overriding(routes: Record<string, (init?: RequestInit) => Response | Promise<Response>>) {
  const inner = fixtureOpenRouterFetch();
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const r = routes[String(url)];
    return r ? r(init) : inner(url, init);
  }) as typeof fetch;
}

const IMAGE_RECORD = "https://openrouter.ai/api/v1/images/models/fixture/image-one/endpoints";
const SPEECH_PRICES = "https://openrouter.ai/api/v1/models/fixture/voice-one/endpoints";
const SPEECH_RECORD = "https://openrouter.ai/api/v1/audio/speech/models/fixture/voice-one";

describe("media tools: review round 1 regressions (#246)", () => {
  it("P1: a single speech call dearer than what is left is refused before any POST", async () => {
    const t = await start();
    t.enable(settingsWith({ speech: "fixture/voice-one" }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    t.app.usageStore!.recordMedia({
      userId: t.f.users.owner.id,
      conversationId: conv.id,
      runId: "earlier",
      callId: "c1",
      model: "fixture/voice-one",
      costUsd: 49.9999,
    });
    // The bound: (UTF-8 bytes + 64) × $0.000015 × 1.2 > the $0.0001 left.
    expect(await t.app.media!.tools.run("speech", scope, { text: "안녕하세요" })).toMatchObject({
      ok: false,
      code: "media_budget",
    });
    expect(t.posts()).toEqual([]);
    expect(t.app.media!.budget.remaining(t.f.users.owner.id).spentUsd).toBe(49.9999);
  });

  it("P1: bounds cover every tier and part; a unit without a bound is no bound", () => {
    const ep = (pricing: unknown[]) => [{ pricing }];
    // Dearest variant of the output, plus the prompt's tokens (bytes as their upper bound), plus references.
    const b = imageCostBound(
      ep([
        { billable: "output_image", unit: "image", cost_usd: 0.04 },
        { billable: "output_image", unit: "image", cost_usd: 0.12, variant: "4K" },
        { billable: "input_text", unit: "token", cost_usd: 0.000001 },
        { billable: "input_image", unit: "image", cost_usd: 0.01 },
      ]),
      { prompt: "abcd", references: [1.5, 2.5] },
    )!;
    expect(b).toBeCloseTo((0.12 + 0.000001 * (4 + 64) + 0.02) * 1.2, 9);
    // The dearest of several endpoints.
    expect(
      imageCostBound(
        [
          { pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.01 }] },
          { pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.05 }] },
        ],
        { prompt: "x", references: [] },
      ),
    ).toBeCloseTo(0.06, 9);
    // Per output token, or no records: no bound.
    expect(
      imageCostBound(ep([{ billable: "output_image", unit: "token", cost_usd: 0.00003 }]), {
        prompt: "x",
        references: [],
      }),
    ).toBeNull();
    expect(imageCostBound([], { prompt: "x", references: [] })).toBeNull();
    // Speech: input prices × bytes, overrides' dearer tier, variable = none; an output price = no bound (#251 r9).
    expect(
      speechCostBound([{ pricing: { prompt: "0.000001", completion: "0.0001" } }], { text: "ab" }),
    ).toBeNull();
    const sp = speechCostBound([{ pricing: { prompt: "0.000001", completion: "0" } }], { text: "ab" })!;
    expect(sp).toBeCloseTo(0.000001 * (2 + 64) * 1.2, 9);
    const over = speechCostBound(
      [{ pricing: { prompt: "0.000001", completion: "0", overrides: [{ prompt: "0.000004" }] } }],
      { text: "ab" },
    )!;
    expect(over).toBeCloseTo(0.000004 * 66 * 1.2, 9);
    expect(speechCostBound([{ pricing: { prompt: "-1", completion: "0" } }], { text: "ab" })).toBeNull();
    expect(speechCostBound([], { text: "ab" })).toBeNull();
  });

  it("P1: a cost never reported keeps holding the reserved bound in the budget", async () => {
    const t = await start({
      fetchImpl: overriding({
        [`https://openrouter.ai/api/v1/generation?id=${FIXTURE_GENERATION_ID}`]: () =>
          Response.json({ error: { code: 404 } }, { status: 404 }),
      }),
    });
    t.enable(settingsWith({ speech: "fixture/voice-one" }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    expect(await t.app.media!.tools.run("speech", scope, { text: "안녕" })).toMatchObject({
      ok: true,
      output: { costUsd: null },
    });
    const [row] = t.usageRows();
    expect(row).toMatchObject({ cost_usd: null, priced_cost_micros: null });
    expect(row!.estimated_cost_micros).toBeGreaterThan(0);
    const b = t.app.media!.budget.remaining(t.f.users.owner.id);
    expect(b.pendingUsd).toBe(row!.estimated_cost_micros! / 1e6);
    expect(b.remainingUsd).toBeCloseTo(50 - b.pendingUsd, 6);
    expect(b.uncosted).toBe(0);
  });

  it("P2: a 2xx whose body fails still settles its cost (speech) or keeps its bound (image)", async () => {
    const t = await start({
      fetchImpl: overriding({
        [OPENROUTER_SPEECH_URL]: () =>
          new Response(new Uint8Array(silentMp3()), {
            // A declared length over the 50MB limit: the body is refused before it is read.
            headers: {
              "content-type": "audio/mpeg",
              "content-length": String(60 * 1024 * 1024),
              "x-generation-id": FIXTURE_GENERATION_ID,
            },
          }),
        [OPENROUTER_IMAGES_URL]: () =>
          new Response("{not json", { headers: { "content-type": "application/json" } }),
      }),
    });
    t.enable(settingsWith({ speech: "fixture/voice-one", image: "fixture/image-one" }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    expect(await t.app.media!.tools.run("speech", scope, { text: "안녕" })).toMatchObject({
      code: "media_failed",
    });
    expect(t.requests.filter((q) => q.url.includes("/generation?"))).toHaveLength(1);
    expect(t.usageRows()).toEqual([expect.objectContaining({ cost_usd: FIXTURE_SPEECH_COST })]);
    expect(await t.app.media!.tools.run("image", scope, { prompt: "산" })).toMatchObject({
      code: "media_failed",
    });
    const image = t.usageRows().find((r) => r.model === "fixture/image-one")!;
    expect(image).toMatchObject({ cost_usd: null });
    expect(image.estimated_cost_micros).toBeGreaterThan(40_000);
    expect(t.app.files!.list(conv.id)).toEqual([]);
  });

  it("P2: a usage write that fails twice is reported to the operator (log and error list)", async () => {
    const t = await start();
    t.enable(settingsWith({ image: "fixture/image-one" }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    const settle = vi.spyOn(t.app.usageStore!, "settleMedia").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect((await t.app.media!.tools.run("image", scope, { prompt: "산" })).ok).toBe(true);
    expect(settle).toHaveBeenCalledTimes(2);
    const errs = await t.api(t.f.cookies.admin, "GET", "/api/admin/errors");
    expect(errs.body).toContain("media_usage_failed");
    // The reserving row stays: the bound holds the budget until someone settles it.
    expect(t.usageRows()[0]!.estimated_cost_micros).toBeGreaterThan(0);
  });

  it("P2: a network failure after sending keeps the bound; a refusal removes it", async () => {
    let mode: "drop" | "refuse" = "drop";
    const t = await start({
      fetchImpl: overriding({
        [OPENROUTER_IMAGES_URL]: () => {
          if (mode === "drop") throw new TypeError("socket hang up");
          return Response.json({ error: { code: 400 } }, { status: 400 });
        },
      }),
    });
    t.enable(settingsWith({ image: "fixture/image-one" }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    expect(await t.app.media!.tools.run("image", scope, { prompt: "a" })).toMatchObject({
      code: "media_failed",
    });
    expect(t.usageRows()).toHaveLength(1);
    mode = "refuse";
    expect(await t.app.media!.tools.run("image", scope, { prompt: "b" })).toMatchObject({
      code: "media_refused",
    });
    expect(t.usageRows()).toHaveLength(1);
  });

  it("P2: a conversation with 20 files is refused before any POST; two calls never both take the last place", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = await start({
      fetchImpl: overriding({
        [OPENROUTER_IMAGES_URL]: async (init) => {
          await gate;
          return fixtureOpenRouterFetch()(OPENROUTER_IMAGES_URL, init);
        },
      }),
    });
    t.enable(
      settingsWith(
        { image: "fixture/image-one" },
        { perRunLimits: { image: 10, speech: 3, music: 1, video: 1 } },
      ),
    );
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    const insert = t.db.$client.prepare(
      `INSERT INTO files (id, user_id, conversation_id, message_id, upload_id, name, kind, media_type, bytes, sha256, created_at)
       VALUES (?, ?, ?, NULL, NULL, 'x.txt', 'txt', 'text/plain', 1, 'x', 1)`,
    );
    for (let i = 0; i < 19; i++) insert.run(`f${i}`, t.f.users.owner.id, conv.id);
    const first = t.app.media!.tools.run("image", scope, { prompt: "하나" });
    await vi.waitFor(() => expect(t.posts()).toHaveLength(1));
    // 19 stored + 1 in flight: no place left.
    expect(await t.app.media!.tools.run("image", scope, { prompt: "둘" })).toMatchObject({
      code: "media_file_limit",
    });
    release();
    expect((await first).ok).toBe(true);
    expect(await t.app.media!.tools.run("image", scope, { prompt: "셋" })).toMatchObject({
      code: "media_file_limit",
    });
    expect(t.posts()).toHaveLength(1);
  });

  it("P2: settings or the key changed during the model lookup — the paid POST is not sent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = await start({
      fetchImpl: overriding({
        [IMAGE_RECORD]: async (init) => {
          await gate;
          return fixtureOpenRouterFetch()(IMAGE_RECORD, init);
        },
      }),
    });
    t.enable(settingsWith({ image: "fixture/image-one" }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    const call = t.app.media!.tools.run("image", scope, { prompt: "산" });
    await vi.waitFor(() => expect(t.requests.some((q) => q.url === IMAGE_RECORD)).toBe(true));
    // The admin saves the settings again (a new revision), even with the same values.
    t.enable(settingsWith({ image: "fixture/image-one" }));
    release();
    expect(await call).toMatchObject({ ok: false, code: "media_changed" });
    expect(t.posts()).toEqual([]);
    expect(t.usageRows()).toEqual([]);
  });

  it("P2: a model lookup that fails is media_lookup_failed — for a youth account nothing is sent unconfirmed", async () => {
    const down = () => Response.json({ error: { code: 503 } }, { status: 503 });
    const t = await start({ fetchImpl: overriding({ [IMAGE_RECORD]: down, [SPEECH_PRICES]: down }) });
    t.enable(settingsWith({ image: "fixture/image-one", speech: "fixture/voice-one" }));
    t.db.$client.prepare("UPDATE users SET youth = 1 WHERE id = ?").run(t.f.users.owner.id);
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    expect(await t.app.media!.tools.run("image", scope, { prompt: "공룡" })).toMatchObject({
      ok: false,
      code: "media_lookup_failed",
      hint: MEDIA_TOOL_HINTS.media_lookup_failed,
    });
    // Speech: its prices could not be read — no bound, no call.
    expect(await t.app.media!.tools.run("speech", scope, { text: "안녕" })).toMatchObject({
      code: "media_lookup_failed",
    });
    expect(t.posts()).toEqual([]);
  });

  it("P2: an explicit voice only from a confirmed list; no list → refused (the default still works)", async () => {
    const t = await start({
      fetchImpl: overriding({
        [SPEECH_RECORD]: () =>
          Response.json({
            id: "fixture/voice-one",
            output_modalities: [
              {
                type: "speech",
                supported_parameters: { response_format: { type: "enum", values: ["mp3"] } },
              },
            ],
            endpoints: [],
          }),
      }),
    });
    t.enable(settingsWith({ speech: "fixture/voice-one" }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    expect(
      await t.app.media!.tools.run("speech", scope, { text: "안녕", voice: "my-cloned-voice" }),
    ).toMatchObject({
      code: "media_bad_option",
    });
    expect(t.posts()).toEqual([]);
    const ok = await t.app.media!.tools.run("speech", scope, { text: "안녕" });
    expect(ok.ok).toBe(true);
    expect(t.posts()[0]!.body).not.toHaveProperty("voice");
  });

  it("P2: secrets — user text is checked before options; hints carry plain values only", async () => {
    const secret = "sk-SYNTHETIC0000hint0000secret246";
    knownSecrets.add(secret, { fresh: true });
    const t = await start({
      fetchImpl: overriding({
        [IMAGE_RECORD]: () =>
          Response.json({
            id: "fixture/image-one",
            endpoints: [
              {
                supported_parameters: { aspect_ratio: { type: "enum", values: ["1:1", secret, "<b>x</b>"] } },
                pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.04 }],
              },
            ],
          }),
      }),
    });
    t.enable(settingsWith({ image: "fixture/image-one" }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    // A prompt with a secret and a wrong option: the secret check answers first, nothing is looked up.
    expect(
      await t.app.media!.tools.run("image", scope, { prompt: `x ${secret}`, aspectRatio: "4:3" }),
    ).toMatchObject({
      code: "media_secret_blocked",
    });
    expect(t.requests.some((q) => q.url === IMAGE_RECORD)).toBe(false);
    const bad = await t.app.media!.tools.run("image", scope, { prompt: "산", aspectRatio: "4:3" });
    expect(bad).toMatchObject({ code: "media_bad_option" });
    expect(!bad.ok && bad.hint).toContain("1:1");
    expect(JSON.stringify(bad)).not.toContain(secret);
    expect(JSON.stringify(bad)).not.toContain("<b>");
  });

  it("P2: references are sent without their metadata; a secret left in the pixels' bytes blocks the call", async () => {
    const secret = "sk-SYNTHETIC0000refs0000secret246";
    knownSecrets.add(secret, { fresh: true });
    let answer = pngWith([["tEXt", Buffer.from(`Comment\0${secret}`, "latin1")]]);
    const t = await start({
      fetchImpl: overriding({
        [OPENROUTER_IMAGES_URL]: () =>
          Response.json({ data: [{ b64_json: answer.toString("base64") }], usage: { cost: 0.04 } }),
      }),
    });
    t.enable(
      settingsWith(
        { image: "fixture/image-one" },
        { perRunLimits: { image: 10, speech: 3, music: 1, video: 1 } },
      ),
    );
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const made = await t.send(conv.id, "/image 첫 그림");
    const withText = String(outputOf(made).fileId);
    // A second stored image whose data chunk itself carries the secret.
    answer = pngWith([["vpAg", Buffer.from(`xx${secret}xx`, "latin1")]]);
    answer = Buffer.concat([
      answer.subarray(0, answer.length - 12),
      pngIdat(secret),
      answer.subarray(answer.length - 12),
    ]);
    const made2 = await t.send(conv.id, "/image 둘째 그림");
    const inPixels = String(outputOf(made2).fileId);
    const scope = await t.scopeOf(conv.id);
    expect(
      (await t.app.media!.tools.run("image", scope, { prompt: "밝게", referenceFileIds: [withText] })).ok,
    ).toBe(true);
    const sent = t.posts().at(-1)!.body!.input_references as { image_url: { url: string } }[];
    const bytes = Buffer.from(sent[0]!.image_url.url.split(",")[1]!, "base64");
    expect(imageKindOf(bytes)).toBe("png");
    expect(bytes.includes(Buffer.from("tEXt"))).toBe(false);
    expect(bytes.toString("latin1")).not.toContain(secret);
    const n = t.posts().length;
    expect(
      await t.app.media!.tools.run("image", scope, { prompt: "밝게", referenceFileIds: [inPixels] }),
    ).toMatchObject({ code: "media_secret_blocked" });
    expect(t.posts()).toHaveLength(n);
  });

  it("P2: vector-only image models are refused before paying, a raster format is asked for explicitly", async () => {
    let formats = ["svg"];
    const t = await start({
      fetchImpl: overriding({
        [IMAGE_RECORD]: () =>
          Response.json({
            id: "fixture/image-one",
            endpoints: [
              {
                supported_parameters: { output_format: { type: "enum", values: formats } },
                pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.08 }],
              },
            ],
          }),
        [MEDIA_CATALOG_URLS.image]: () =>
          Response.json({
            data: [
              {
                id: "recraft/recraft-v4-vector",
                name: "Recraft V4 Vector",
                supported_parameters: { output_format: { type: "enum", values: ["svg"] } },
                endpoints: "/x",
              },
            ],
          }),
      }),
    });
    t.enable(settingsWith({ image: "fixture/image-one" }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    expect(await t.app.media!.tools.run("image", scope, { prompt: "로고" })).toMatchObject({
      code: "media_unsupported_model",
    });
    expect(t.posts()).toEqual([]);
    formats = ["svg", "png", "webp"];
    expect((await t.app.media!.tools.run("image", scope, { prompt: "로고" })).ok).toBe(true);
    expect(t.posts()[0]!.body).toMatchObject({ output_format: "png" });
    // The admin list marks the vector model and a save that picks it is refused.
    const cat = await fetchCatalog("image", {
      fetchImpl: overriding({
        [MEDIA_CATALOG_URLS.image]: () =>
          Response.json({
            data: [
              {
                id: "recraft/recraft-v4-vector",
                supported_parameters: { output_format: { type: "enum", values: ["svg"] } },
              },
            ],
          }),
      }),
      prices: false,
    });
    expect(cat.models[0]).toMatchObject({
      vectorOnly: true,
      options: ["벡터(SVG) 전용 — 이 서버에 저장할 수 없음", "output_format: svg"],
    });
    await expect(
      t.app.media!.admin.saveSettings(
        settingsWith({ image: "recraft/recraft-v4-vector" }),
        t.app.media!.settings.revision(),
        () => true,
      ),
    ).rejects.toMatchObject({ code: "media_model_unsupported" });
  });

  it("#251 r9: a speech model priced on its output is refused — before any request, and when chosen", async () => {
    const inner = fixtureOpenRouterFetch();
    const outputPriced = (async (url: string | URL | Request, init?: RequestInit) =>
      String(url).endsWith("/models/fixture/voice-one/endpoints")
        ? Response.json({
            data: {
              id: "fixture/voice-one",
              endpoints: [{ pricing: { prompt: "0", completion: "0.00001" } }],
            },
          })
        : inner(url, init)) as typeof fetch;
    const t = await start({ fetchImpl: outputPriced });
    // Chosen in 관리자 → 미디어 생성: not saved.
    await expect(
      t.app.media!.admin.saveSettings(
        settingsWith({ speech: "fixture/voice-one" }),
        t.app.media!.settings.revision(),
        () => true,
      ),
    ).rejects.toMatchObject({ code: "media_model_output_priced" });
    // Already chosen (set directly): the call is refused before anything is paid.
    t.enable(settingsWith({ speech: "fixture/voice-one" }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    const r = await t.app.media!.tools.run("speech", scope, { text: "안녕" });
    expect(r).toMatchObject({ ok: false, code: "media_no_price" });
    expect(!r.ok && r.hint).toMatch(/음성의 양/);
    expect(t.posts()).toEqual([]);
    expect(t.usageRows()).toEqual([]);
    // An input-priced model is still chosen as before.
    const t2 = await start();
    await expect(
      t2.app.media!.admin.saveSettings(
        settingsWith({ speech: "fixture/voice-one" }),
        t2.app.media!.settings.revision(),
        () => true,
      ),
    ).resolves.toBeTruthy();
  });

  it("P2: inline audio answers a single byte range (206), a suffix, and 416 beyond the end", async () => {
    const t = await start();
    t.enable(settingsWith({ speech: "fixture/voice-one" }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const r = await t.send(conv.id, "/speech 안녕하세요");
    const id = String(outputOf(r).fileId);
    // The stored file is this server's own encode (#251 re-plan 5), not the fixture's bytes.
    const stored = t.app.files!.get(id)!;
    const size = stored.bytes;
    const get = (range?: string) =>
      t.app.inject({
        url: `/api/files/${id}/content?inline=1`,
        headers: { ...LOCAL, cookie: t.f.cookies.owner, ...(range ? { range } : {}) },
      });
    const whole = await get();
    expect(whole.statusCode).toBe(200);
    expect(whole.headers["accept-ranges"]).toBe("bytes");
    const part = await get("bytes=0-1");
    expect(part.statusCode).toBe(206);
    expect(part.headers["content-range"]).toBe(`bytes 0-1/${size}`);
    expect(part.headers["content-length"]).toBe("2");
    expect(part.rawPayload.equals(whole.rawPayload.subarray(0, 2))).toBe(true);
    const suffix = await get("bytes=-10");
    expect(suffix.statusCode).toBe(206);
    expect(suffix.headers["content-range"]).toBe(`bytes ${size - 10}-${size - 1}/${size}`);
    const open = await get(`bytes=${size - 3}-`);
    expect(open.rawPayload.length).toBe(3);
    const beyond = await get(`bytes=${size}-`);
    expect(beyond.statusCode).toBe(416);
    expect(beyond.headers["content-range"]).toBe(`bytes */${size}`);
    // Several ranges or nonsense: the whole file.
    expect((await get("bytes=0-1,4-5")).statusCode).toBe(200);
    expect((await get("items=0-1")).statusCode).toBe(200);
    // The permission check comes first: another user gets 403, never a part.
    const other = await t.app.inject({
      url: `/api/files/${id}/content?inline=1`,
      headers: { ...LOCAL, cookie: t.f.cookies.stranger, range: "bytes=0-1" },
    });
    expect(other.statusCode).toBe(403);
    expect(byteRange("bytes=5-2", 10)).toBeUndefined();
    expect(byteRange("bytes=0-99", 10)).toEqual({ start: 0, end: 9 });
  });

  it("P3: per-model URLs refuse '.' segments; the price reads get the shared deadline signal", async () => {
    expect(imageEndpointsUrl("./x")).toBeNull();
    expect(imageEndpointsUrl("a/.")).toBeNull();
    expect(imageEndpointsUrl("a/b.c")).toBe("https://openrouter.ai/api/v1/images/models/a/b.c/endpoints");
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/endpoints")) signals.push(init?.signal);
      return fixtureOpenRouterFetch()(url, init);
    }) as typeof fetch;
    await fetchCatalog("image", { apiKey: KEY, fetchImpl });
    expect(signals.length).toBe(2);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  it("strips: PNG text chunks, JPEG APPn/COM segments, WebP EXIF/XMP; printable runs", () => {
    const png = pngWith([
      ["tEXt", Buffer.from("k\0v")],
      ["iTXt", Buffer.from("x")],
      ["eXIf", Buffer.from("y")],
    ]);
    const s1 = stripImage(png, "png")!;
    expect(s1.includes(Buffer.from("tEXt"))).toBe(false);
    expect(s1.includes(Buffer.from("iTXt"))).toBe(false);
    expect(s1.includes(Buffer.from("IDAT"))).toBe(true);
    const seg = (m: number, body: Buffer) => {
      const h = Buffer.from([0xff, m, 0, 0]);
      h.writeUInt16BE(body.length + 2, 2);
      return Buffer.concat([h, body]);
    };
    const jpg = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
      seg(0xe1, Buffer.from("Exif\0\0SECRETEXIF", "latin1")),
      seg(0xfe, Buffer.from("a comment", "latin1")),
      seg(0xdb, Buffer.alloc(65)),
      seg(0xc0, Buffer.from([8, 0, 4, 0, 4, 1, 1, 0x11, 0])),
      seg(0xda, Buffer.alloc(8)),
      Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56]),
      Buffer.from([0xff, 0xd9]),
      Buffer.from("trailing", "latin1"),
    ]);
    const s2 = stripImage(jpg, "jpg")!;
    expect(s2.toString("latin1")).not.toContain("SECRETEXIF");
    expect(s2.toString("latin1")).not.toContain("a comment");
    expect(s2.toString("latin1")).not.toContain("trailing");
    expect(s2.toString("latin1")).toContain("JFIF");
    expect(s2.subarray(-2).equals(Buffer.from([0xff, 0xd9]))).toBe(true);
    const chunk = (fourcc: string, data: Buffer) => {
      const h = Buffer.alloc(8);
      h.write(fourcc, 0, "latin1");
      h.writeUInt32LE(data.length, 4);
      return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    };
    const body = Buffer.concat([
      chunk("VP8X", Buffer.from([0x2c, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
      chunk("VP8 ", Buffer.alloc(10)),
      chunk("EXIF", Buffer.from("SECRETEXIF")),
      chunk("XMP ", Buffer.from("<x:xmpmeta/>")),
    ]);
    const head = Buffer.alloc(12);
    head.write("RIFF", 0, "latin1");
    head.writeUInt32LE(body.length + 4, 4);
    head.write("WEBP", 8, "latin1");
    const s3 = stripImage(Buffer.concat([head, body]), "webp")!;
    expect(s3.toString("latin1")).not.toContain("SECRETEXIF");
    expect(s3.toString("latin1")).not.toContain("xmpmeta");
    expect(s3[20]! & 0x2c).toBe(0);
    expect(s3.readUInt32LE(4)).toBe(s3.length - 8);
    expect(stripImage(Buffer.from("not an image"), "png")).toBeNull();
    expect(textRuns(Buffer.from("\x00\x01abcdefghij\x02xy\x03", "latin1"))).toEqual(["abcdefghij"]);
  });
});

/** An IDAT chunk whose data holds `text` (its bytes are what a reference sends). */
function pngIdat(text: string): Buffer {
  const data = Buffer.from(`\x00${text}\x00`, "latin1");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from("IDAT"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

// ---------------------------------------------------------------- review round 2 (#246)

describe("media tools: review round 2 regressions (#246)", () => {
  it("P1: a missing price is not free — empty lists, missing output or required keys, -1 anywhere", () => {
    const img = (pricing: unknown) => imageCostBound([{ pricing }], { prompt: "x", references: [] });
    expect(img([])).toBeNull();
    expect(img(undefined)).toBeNull();
    // Only input lines: the output's price is missing.
    expect(img([{ billable: "input_text", unit: "token", cost_usd: 0.000001 }])).toBeNull();
    expect(img([{ billable: "output_image", unit: "image", cost_usd: "n/a" }])).toBeNull();
    // An explicit 0 is a confirmed free one.
    expect(img([{ billable: "output_image", unit: "image", cost_usd: 0 }])).toBe(0);
    const sp = (pricing: unknown) => speechCostBound([{ pricing }], { text: "ab" });
    expect(sp({})).toBeNull();
    expect(sp({ prompt: "0.000001" })).toBeNull(); // completion missing
    expect(sp({ prompt: "0", completion: "0" })).toBe(0);
    // A key only in an override counts; a -1 anywhere is no bound — not hidden behind a positive price.
    // …and an output price only in an override is still an output price: no bound.
    expect(sp({ prompt: "0", completion: "0", overrides: [{ audio_output: "0.001" }] })).toBeNull();
    expect(sp({ prompt: "0.000001", completion: "0", overrides: [{ prompt: "-1" }] })).toBeNull();
    expect(sp({ prompt: "0.000001", completion: "-1", overrides: [{ completion: "0.5" }] })).toBeNull();
    expect(sp({ prompt: "abc", completion: "0" })).toBeNull();
    // Condition fields of an override are not prices.
    expect(
      sp({
        prompt: "0.000001",
        completion: "0",
        overrides: [{ prompt: "0.000002", min_prompt_tokens: 200000 }],
      }),
    ).toBeCloseTo(0.000002 * 66 * 1.2, 9);
  });

  it("P1: through the tool, an empty image price list is media_no_price before any POST", async () => {
    const t = await start({
      fetchImpl: overriding({
        [IMAGE_RECORD]: () =>
          Response.json({ id: "fixture/image-one", endpoints: [{ supported_parameters: {}, pricing: [] }] }),
        [SPEECH_PRICES]: () =>
          Response.json({ data: { id: "fixture/voice-one", endpoints: [{ pricing: {} }] } }),
      }),
    });
    t.enable(settingsWith({ image: "fixture/image-one", speech: "fixture/voice-one" }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    expect(await t.app.media!.tools.run("image", scope, { prompt: "산" })).toMatchObject({
      code: "media_no_price",
    });
    expect(await t.app.media!.tools.run("speech", scope, { text: "안녕" })).toMatchObject({
      code: "media_no_price",
    });
    expect(t.posts()).toEqual([]);
    expect(t.usageRows()).toEqual([]);
  });

  it("P2: input references priced per megapixel are reserved on their real area; an oversized one is refused", async () => {
    const record = {
      id: "fixture/image-one",
      endpoints: [
        {
          supported_parameters: {},
          pricing: [
            { billable: "output_image", unit: "image", cost_usd: 0.04 },
            { billable: "input_image", unit: "megapixel", cost_usd: 1 },
          ],
        },
      ],
    };
    let answer = solidPng(64, 64, [1, 2, 3]);
    const t = await start({
      fetchImpl: overriding({
        [IMAGE_RECORD]: () => Response.json(record),
        [OPENROUTER_IMAGES_URL]: () =>
          Response.json({ data: [{ b64_json: answer.toString("base64") }], usage: { cost: 0.04 } }),
      }),
    });
    t.enable(
      settingsWith(
        { image: "fixture/image-one" },
        { perRunLimits: { image: 10, speech: 3, music: 1, video: 1 } },
      ),
    );
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const small = String(outputOf(await t.send(conv.id, "/image 작은 그림")).fileId);
    // A PNG whose header claims 9000×9000 (over the 8192² cap the bound uses).
    const huge = Buffer.from(solidPng(4, 4, [0, 0, 0]));
    huge.writeUInt32BE(9000, 16);
    huge.writeUInt32BE(9000, 20);
    answer = huge;
    const big = String(outputOf(await t.send(conv.id, "/image 큰 그림")).fileId);
    const scope = await t.scopeOf(conv.id);
    const before = t.usageRows().length;
    expect(
      (await t.app.media!.tools.run("image", scope, { prompt: "밝게", referenceFileIds: [small] })).ok,
    ).toBe(true);
    // (0.04 + 1 MP × $1) × 1.2 — the reference's real area rounded up per image (review r3), not 67 MP's worth.
    expect(t.usageRows()[before]!.estimated_cost_micros).toBe(Math.ceil((0.04 + 1) * 1.2 * 1e6));
    const posts = t.posts().length;
    expect(
      await t.app.media!.tools.run("image", scope, { prompt: "밝게", referenceFileIds: [big] }),
    ).toMatchObject({ code: "media_reference_invalid" });
    expect(t.posts()).toHaveLength(posts);
    void record;
  });

  it("P2: a cost that comes late is settled later on the same row (also after a restart); one that never comes is unconfirmed", async () => {
    let costReady = false;
    const t = await start({
      fetchImpl: overriding({
        [`https://openrouter.ai/api/v1/generation?id=${FIXTURE_GENERATION_ID}`]: () =>
          costReady
            ? Response.json({ data: { total_cost: FIXTURE_SPEECH_COST } })
            : Response.json({ error: { code: 404 } }, { status: 404 }),
      }),
    });
    t.enable(settingsWith({ speech: "fixture/voice-one" }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    expect(await t.app.media!.tools.run("speech", scope, { text: "안녕" })).toMatchObject({
      ok: true,
      output: { costUsd: null },
    });
    const state = () =>
      t.db.$client
        .prepare(
          "SELECT media_settlement s, media_generation_id g, media_settle_tries n, cost_usd c FROM usage_records WHERE purpose = 'media'",
        )
        .get() as { s: string; g: string; n: number; c: number | null };
    expect(state()).toMatchObject({ s: "awaiting_cost", g: FIXTURE_GENERATION_ID, n: 0, c: null });
    // A settler of a new process (the id and tries are on the row): not due yet, then one try that finds nothing.
    let now = Date.now();
    const settler = new MediaSettler({
      usage: t.app.usageStore!,
      keys: t.app.media!.keys,
      fetchImpl: t.fetchImpl,
      now: () => now,
    });
    await settler.runOnce();
    expect(state().n).toBe(0);
    now += 2 * 60_000;
    await settler.runOnce();
    expect(state()).toMatchObject({ s: "awaiting_cost", n: 1 });
    costReady = true;
    now += 10 * 60_000;
    await settler.runOnce();
    expect(state()).toMatchObject({ s: "settled", c: FIXTURE_SPEECH_COST });
    expect(t.app.media!.budget.remaining(t.f.users.owner.id)).toMatchObject({
      spentUsd: FIXTURE_SPEECH_COST,
      pendingUsd: 0,
    });
    // One that never comes: after MAX_TRIES it is unconfirmed (its bound stays held).
    t.db.$client
      .prepare(
        "UPDATE usage_records SET media_settlement = 'awaiting_cost', cost_usd = NULL, priced_cost_micros = NULL, media_settle_tries = ?",
      )
      .run(MAX_TRIES);
    await settler.runOnce();
    expect(state().s).toBe("unconfirmed");
    expect(t.app.media!.budget.remaining(t.f.users.owner.id).pendingUsd).toBeGreaterThan(0);
  });

  it("P2: a late settlement checks the day the call was made, and each day alerts once", () => {
    const db = createTestDb();
    db.$client
      .prepare("INSERT INTO users (id, email, name, role) VALUES ('u1', 'u1@x.test', 'u1', 'member')")
      .run();
    const kv = new Map<string, string>([["usage.daily_cost_threshold_usd", "1.5"]]);
    const alerts: [number, string | undefined][] = [];
    const service = new UsageService(
      db,
      { get: (k) => kv.get(k), set: (k, v) => void kv.set(k, v) },
      (amount, _threshold, pastDay) => void alerts.push([amount, pastDay]),
      undefined,
      { timeZone: "Asia/Seoul", now: () => now },
    );
    let now = Date.UTC(2026, 10, 11, 14, 50); // 23:50 in Seoul
    const store = new UsageStore(db, () => now, { onRecorded: (at) => service.checkDailyCost(at) });
    store.recordMedia({
      userId: "u1",
      conversationId: null,
      runId: "a",
      callId: "1",
      model: "m",
      costUsd: 1,
    });
    store.reserveMedia({
      userId: "u1",
      conversationId: null,
      runId: "b",
      callId: "2",
      model: "m",
      estimateUsd: 2,
    });
    now = Date.UTC(2026, 10, 11, 15, 10); // 00:10 the next day
    // Today (the 12th) alerts first with its own cost…
    store.recordMedia({
      userId: "u1",
      conversationId: null,
      runId: "c",
      callId: "3",
      model: "m",
      costUsd: 2,
    });
    expect(alerts).toEqual([[2, undefined]]);
    // …then yesterday's call is settled: the 11th goes over and alerts once, the 12th does not again.
    store.settleMedia(mediaRunKey("b", "2"), 1);
    // The 11th's alert says which day it is (not "today").
    expect(alerts).toEqual([
      [2, undefined],
      [2, "2026-11-11"],
    ]);
    store.recordMedia({
      userId: "u1",
      conversationId: null,
      runId: "d",
      callId: "4",
      model: "m",
      costUsd: 1,
    });
    expect(alerts).toHaveLength(2);
    expect(JSON.parse(kv.get("usage.daily_cost_alerted_day")!)).toEqual(["2026-11-11", "2026-11-12"]);
  });

  it("P2: a 200 that is not a model record is media_lookup_failed; unreadable moderation stops a youth call", async () => {
    let speech: unknown = {};
    let image: unknown = {
      id: "fixture/image-one",
      endpoints: [
        {
          supported_parameters: { moderation: { type: "enum", values: ["blocked-ish"] } },
          pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.04 }],
        },
      ],
    };
    const t = await start({
      fetchImpl: overriding({
        [SPEECH_RECORD]: () => Response.json(speech),
        [IMAGE_RECORD]: () => Response.json(image),
      }),
    });
    t.enable(settingsWith({ image: "fixture/image-one", speech: "fixture/voice-one" }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    expect(await t.app.media!.tools.run("speech", scope, { text: "안녕" })).toMatchObject({
      code: "media_lookup_failed",
    });
    speech = { id: "another/model", output_modalities: [{ type: "speech", supported_parameters: {} }] };
    expect(await t.app.media!.tools.run("speech", scope, { text: "안녕" })).toMatchObject({
      code: "media_lookup_failed",
    });
    // An adult: a moderation option it cannot read is simply not sent.
    expect((await t.app.media!.tools.run("image", scope, { prompt: "산" })).ok).toBe(true);
    expect(t.posts()[0]!.body).not.toHaveProperty("moderation");
    // A youth account: not sent with moderation unconfirmed.
    t.db.$client.prepare("UPDATE users SET youth = 1 WHERE id = ?").run(t.f.users.owner.id);
    expect(await t.app.media!.tools.run("image", scope, { prompt: "산" })).toMatchObject({
      code: "media_lookup_failed",
    });
    image = { endpoints: [{ pricing: [] }] }; // no supported_parameters: not a record
    t.db.$client.prepare("UPDATE users SET youth = 0 WHERE id = ?").run(t.f.users.owner.id);
    expect(await t.app.media!.tools.run("image", scope, { prompt: "산" })).toMatchObject({
      code: "media_lookup_failed",
    });
    expect(t.posts()).toHaveLength(1);
  });

  it("P2: a key swapped and swapped back during the lookup (A→B→A) is a change", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = await start({
      fetchImpl: overriding({
        [IMAGE_RECORD]: async (init) => {
          await gate;
          return fixtureOpenRouterFetch()(IMAGE_RECORD, init);
        },
      }),
    });
    t.enable(settingsWith({ image: "fixture/image-one" }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    const call = t.app.media!.tools.run("image", scope, { prompt: "산" });
    await vi.waitFor(() => expect(t.requests.some((q) => q.url === IMAGE_RECORD)).toBe(true));
    const admin = t.app.media!.admin;
    const B = `${FIXTURE_OPENROUTER_KEY_PREFIX}-synthetic-B000000000000000000000bbbb`;
    await admin.registerKey(B, admin.generation(), () => true);
    await admin.deleteKey(admin.generation(), () => true); // back to the .env key (A)
    expect(t.app.media!.keys.resolve()?.key).toBe(KEY);
    release();
    expect(await call).toMatchObject({ code: "media_changed" });
    expect(t.posts()).toEqual([]);
  });

  it("P2: a stored file frees its in-flight place at once; a refused file place leaves the run its call", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = await start({
      fetchImpl: overriding({
        [`https://openrouter.ai/api/v1/generation?id=${FIXTURE_GENERATION_ID}`]: async () => {
          await gate;
          return Response.json({ data: { total_cost: FIXTURE_SPEECH_COST } });
        },
      }),
    });
    t.enable(
      settingsWith(
        { speech: "fixture/voice-one", image: "fixture/image-one" },
        { perRunLimits: { image: 1, speech: 3, music: 1, video: 1 } },
      ),
    );
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    const insert = t.db.$client.prepare(
      `INSERT INTO files (id, user_id, conversation_id, message_id, upload_id, name, kind, media_type, bytes, sha256, created_at)
       VALUES (?, ?, ?, NULL, NULL, 'x.txt', 'txt', 'text/plain', 1, 'x', 1)`,
    );
    for (let i = 0; i < 18; i++) insert.run(`f${i}`, t.f.users.owner.id, conv.id);
    // The speech file is stored (19 files) while its cost lookup is still held: the 20th place is free.
    const speech = t.app.media!.tools.run("speech", scope, { text: "안녕" });
    await vi.waitFor(() => expect(t.app.files!.count(conv.id)).toBe(19));
    expect((await t.app.media!.tools.run("image", scope, { prompt: "산" })).ok).toBe(true);
    release();
    expect((await speech).ok).toBe(true);
    // Now full: refused for the file place — and the image's per-run call (limit 1, used) is not the reason.
    const next = await t.scopeOf(conv.id);
    expect(await t.app.media!.tools.run("image", next, { prompt: "또" })).toMatchObject({
      code: "media_file_limit",
    });
    t.db.$client.prepare("DELETE FROM files WHERE id = 'f0'").run();
    expect((await t.app.media!.tools.run("image", next, { prompt: "또" })).ok).toBe(true);
  });

  it("P2 strip: WebP frames keep image chunks only; truncated containers and missing PNG parts are refused; caps", () => {
    const chunk = (fourcc: string, data: Buffer) => {
      const h = Buffer.alloc(8);
      h.write(fourcc, 0, "latin1");
      h.writeUInt32LE(data.length, 4);
      return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
    };
    const webp = (chunks: Buffer[]) => {
      const body = Buffer.concat(chunks);
      const head = Buffer.alloc(12);
      head.write("RIFF", 0, "latin1");
      head.writeUInt32LE(body.length + 4, 4);
      head.write("WEBP", 8, "latin1");
      return Buffer.concat([head, body]);
    };
    const frame = chunk(
      "ANMF",
      Buffer.concat([
        Buffer.alloc(16),
        chunk("VP8 ", Buffer.alloc(10)),
        chunk("XMP ", Buffer.from("FRAMESECRET")),
      ]),
    );
    const animated = webp([
      chunk("VP8X", Buffer.from([0x12, 0, 0, 0, 3, 0, 0, 3, 0, 0])),
      chunk("ANIM", Buffer.alloc(6)),
      frame,
    ]);
    const s = stripImage(animated, "webp")!;
    expect(s.toString("latin1")).not.toContain("FRAMESECRET");
    expect(s.toString("latin1")).toContain("ANMF");
    expect(imageSize(s, "webp")).toEqual({ width: 4, height: 4 });
    // Truncated: the RIFF size says more than the file has.
    expect(stripImage(animated.subarray(0, animated.length - 4), "webp")).toBeNull();
    // A frame without an image is refused.
    expect(
      stripImage(
        webp([chunk("ANMF", Buffer.concat([Buffer.alloc(16), chunk("XMP ", Buffer.alloc(4))]))]),
        "webp",
      ),
    ).toBeNull();
    // PNG without IDAT, or with IHDR not first.
    const png = solidPng(2, 2, [0, 0, 0]);
    const idatAt = png.indexOf("IDAT") - 4;
    const idatLen = png.readUInt32BE(idatAt) + 12;
    expect(
      stripImage(Buffer.concat([png.subarray(0, idatAt), png.subarray(idatAt + idatLen)]), "png"),
    ).toBeNull();
    // Too many chunks: refused before building more.
    const many = pngWith(
      Array.from({ length: MAX_PARTS + 1 }, () => ["tIME", Buffer.alloc(7)] as [string, Buffer]),
    );
    expect(stripImage(many, "png")).toBeNull();
    // Text runs: UTF-8 and the shortest configured secret's length; too many runs → refused.
    expect(textRuns(Buffer.from("\x00비밀값입니다\x00", "utf8"), 4)).toEqual(["비밀값입니다"]);
    expect(textRuns(Buffer.from("\x00abcd\x00", "latin1"), 4)).toEqual(["abcd"]);
    expect(textRuns(Buffer.from("abcd\x00".repeat(MAX_RUNS + 1), "latin1"), 4)).toBeNull();
    expect(imageSize(solidPng(7, 3, [0, 0, 0]), "png")).toEqual({ width: 7, height: 3 });
  });

  it("P2 Range: If-Range gets the whole file; the unit is case-insensitive; long numbers do not overflow", () => {
    expect(byteRange("Bytes=0-1", 10)).toEqual({ start: 0, end: 1 });
    expect(byteRange("BYTES=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(byteRange("bytes=0000000000000002-0000000000000003", 10)).toEqual({ start: 2, end: 3 });
    expect(byteRange("bytes=0-99999999999999999999999", 10)).toEqual({ start: 0, end: 9 });
    expect(byteRange("bytes=99999999999999999999999-", 10)).toBe("unsatisfiable");
    expect(byteRange("bytes=-99999999999999999999999", 10)).toEqual({ start: 0, end: 9 });
    expect(byteRange("bytes=00005-00002", 10)).toBeUndefined();
  });

  it("P2 Range: a request with If-Range is answered whole (no validators on this route)", async () => {
    const t = await start();
    t.enable(settingsWith({ speech: "fixture/voice-one" }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const id = String(outputOf(await t.send(conv.id, "/speech 안녕")).fileId);
    const r = await t.app.inject({
      url: `/api/files/${id}/content?inline=1`,
      headers: { ...LOCAL, cookie: t.f.cookies.owner, range: "bytes=0-1", "if-range": '"abc"' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.length).toBe(t.app.files!.get(id)!.bytes);
  });

  it("P3 usage screen: a reservation in progress is 진행 중, not 미제공; an unconfirmed one is 미제공", () => {
    const db = createTestDb();
    db.$client
      .prepare("INSERT INTO users (id, email, name, role) VALUES ('u1', 'u1@x.test', 'u1', 'member')")
      .run();
    const store = new UsageStore(db, () => 1);
    store.reserveMedia({
      userId: "u1",
      conversationId: null,
      runId: "a",
      callId: "1",
      model: "m",
      estimateUsd: 1,
    });
    store.reserveMedia({
      userId: "u1",
      conversationId: null,
      runId: "b",
      callId: "2",
      model: "m",
      estimateUsd: 1,
    });
    store.answeredMedia(mediaRunKey("b", "2"), "gen-x");
    store.reserveMedia({
      userId: "u1",
      conversationId: null,
      runId: "c",
      callId: "3",
      model: "m",
      estimateUsd: 1,
    });
    store.unconfirmMedia(mediaRunKey("c", "3"));
    const t = emptyTotals();
    for (const r of db.select().from(usageRecords).all()) addRow(t, r);
    expect(t).toMatchObject({ requests: 3, costPending: 2, costMissing: 1, costMicroUsd: 0 });
  });
});

// ---------------------------------------------------------------- review round 3 (#246)

describe("media tools: review round 3 regressions (#246)", () => {
  const MP_RECORD = {
    id: "fixture/image-one",
    endpoints: [
      {
        supported_parameters: {},
        pricing: [
          { billable: "output_image", unit: "image", cost_usd: 0.04 },
          { billable: "input_image", unit: "megapixel", cost_usd: 0.015 },
        ],
      },
    ],
  };

  it("P1: small references are reserved per image rounded up to whole megapixels", async () => {
    // Two 64×64 references: billed 1 MP each by a provider that rounds per image ($0.04 + 2 × $0.015 = $0.07).
    expect(
      imageCostBound(MP_RECORD.endpoints, { prompt: "x", references: [0.004096, 0.004096] }),
    ).toBeCloseTo((0.04 + 2 * 0.015) * 1.2, 9);
    expect(imageCostBound(MP_RECORD.endpoints, { prompt: "x", references: [2.1] })).toBeCloseTo(
      (0.04 + 3 * 0.015) * 1.2,
      9,
    );
    const t = await start({ fetchImpl: overriding({ [IMAGE_RECORD]: () => Response.json(MP_RECORD) }) });
    t.enable(
      settingsWith(
        { image: "fixture/image-one" },
        { perRunLimits: { image: 10, speech: 3, music: 1, video: 1 } },
      ),
    );
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const a = String(outputOf(await t.send(conv.id, "/image 하나")).fileId);
    const b = String(outputOf(await t.send(conv.id, "/image 둘")).fileId);
    const scope = await t.scopeOf(conv.id);
    // $0.06 left: more than the old estimate ($0.048), less than what the call can cost ($0.07 → $0.084 bound).
    const spent = t.usageRows().reduce((x, r) => x + (r.cost_usd ?? 0), 0);
    t.app.usageStore!.recordMedia({
      userId: t.f.users.owner.id,
      conversationId: conv.id,
      runId: "earlier",
      callId: "c",
      model: "m",
      costUsd: +(49.94 - spent).toFixed(6),
    });
    const posts = t.posts().length;
    expect(
      await t.app.media!.tools.run("image", scope, { prompt: "합치기", referenceFileIds: [a, b] }),
    ).toMatchObject({ code: "media_budget" });
    expect(t.posts()).toHaveLength(posts);
  });

  it("P2: the generation id is on the row as soon as the 2xx headers came; a previous process's reservations are taken up", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = await start({
      fetchImpl: overriding({
        [OPENROUTER_SPEECH_URL]: () =>
          new Response(
            new ReadableStream({
              async start(c) {
                await gate;
                c.enqueue(new Uint8Array(silentMp3()));
                c.close();
              },
            }),
            { headers: { "content-type": "audio/mpeg", "x-generation-id": FIXTURE_GENERATION_ID } },
          ),
      }),
    });
    t.enable(settingsWith({ speech: "fixture/voice-one" }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    const call = t.app.media!.tools.run("speech", scope, { text: "안녕" });
    const row = () =>
      t.db.$client
        .prepare(
          "SELECT media_settlement s, media_generation_id g FROM usage_records WHERE purpose = 'media'",
        )
        .all() as { s: string; g: string | null }[];
    // The body is still held: the row is reserved, and already carries the id.
    await vi.waitFor(() => expect(row()).toEqual([{ s: "reserved", g: FIXTURE_GENERATION_ID }]));
    release();
    expect((await call).ok).toBe(true);
    // A previous process's rows: one with an id, one without (it stopped before the headers).
    t.app.usageStore!.reserveMedia({
      userId: t.f.users.owner.id,
      conversationId: conv.id,
      runId: "old",
      callId: "1",
      model: "m",
      estimateUsd: 0.5,
    });
    t.app.usageStore!.generationMedia(mediaRunKey("old", "1"), "gen-old-1");
    t.app.usageStore!.reserveMedia({
      userId: t.f.users.owner.id,
      conversationId: conv.id,
      runId: "old",
      callId: "2",
      model: "m",
      estimateUsd: 0.25,
    });
    // Start-up recovery takes up every reserved row (one server holds the data folder's lock).
    expect(recoverMediaReservations(t.app.usageStore!)).toBe(2);
    const states = t.db.$client
      .prepare(
        "SELECT run_id r, media_settlement s, estimated_cost_micros e FROM usage_records WHERE run_id LIKE 'old%' ORDER BY run_id",
      )
      .all();
    expect(states).toEqual([
      { r: mediaRunKey("old", "1"), s: "awaiting_cost", e: 500_000 },
      { r: mediaRunKey("old", "2"), s: "unconfirmed", e: 250_000 },
    ]);
  });

  it("P2: an image model record without its id (or another id) is media_lookup_failed — no POST", async () => {
    let record: Record<string, unknown> = {
      endpoints: [
        { supported_parameters: {}, pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.04 }] },
      ],
    };
    const t = await start({ fetchImpl: overriding({ [IMAGE_RECORD]: () => Response.json(record) }) });
    t.enable(settingsWith({ image: "fixture/image-one" }));
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const scope = await t.scopeOf(conv.id);
    expect(await t.app.media!.tools.run("image", scope, { prompt: "산" })).toMatchObject({
      code: "media_lookup_failed",
    });
    record = { ...record, id: "other/model" };
    expect(await t.app.media!.tools.run("image", scope, { prompt: "산" })).toMatchObject({
      code: "media_lookup_failed",
    });
    // P3: a record of the model whose prices are missing (not only empty) is media_no_price, like an empty list.
    record = { id: "fixture/image-one", endpoints: [{ supported_parameters: {} }] };
    expect(await t.app.media!.tools.run("image", scope, { prompt: "산" })).toMatchObject({
      code: "media_no_price",
    });
    expect(t.posts()).toEqual([]);
  });

  it("P2: secret lengths are counted in UTF-16 units by the registry and the reference scan alike", () => {
    // Four characters outside the BMP: 8 UTF-16 units — the registry's minimum.
    const value = "😀😀😀😀";
    expect(value.length).toBe(8);
    expect(textRuns(Buffer.from(`\x00${value}\x00`, "utf8"), 8)).toEqual([value]);
    // Three of them (6 units) stay under it.
    expect(textRuns(Buffer.from("\x00😀😀😀\x00", "utf8"), 8)).toEqual([]);
    knownSecrets.add(`gate-${value}`, { fresh: true });
    const runs = textRuns(Buffer.from(`\x01\x02gate-${value}\x03`, "utf8"), 8)!;
    expect(runs).toEqual([`gate-${value}`]);
  });

  it("P2: a late daily-cost alert names its day (not 오늘)", () => {
    const n = compose({ kind: "daily_cost", amountUsd: 2, thresholdUsd: 1.5, pastDay: "2026-11-22" });
    expect(n.title).toBe("11월 22일 비용이 기준을 넘었어요");
    expect(n.body).toMatch(/^11월 22일 /);
    const today = compose({ kind: "daily_cost", amountUsd: 2, thresholdUsd: 1.5 });
    expect(today.title).toBe("오늘 비용이 기준을 넘었어요");
  });

  it("P3: the settler starts no new lookup once stopped, and aborts the one under way", async () => {
    let started = 0;
    let aborted = 0;
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      started++;
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => {
          aborted++;
          reject(new Error("aborted"));
        }),
      );
    }) as typeof fetch;
    const db = createTestDb();
    db.$client
      .prepare("INSERT INTO users (id, email, name, role) VALUES ('u1', 'u1@x.test', 'u1', 'member')")
      .run();
    const store = new UsageStore(db, () => 0);
    for (const i of [1, 2, 3]) {
      store.reserveMedia({
        userId: "u1",
        conversationId: null,
        runId: "r",
        callId: String(i),
        model: "m",
        estimateUsd: 1,
      });
      store.answeredMedia(mediaRunKey("r", String(i)), `gen-${i}`);
    }
    const settler = new MediaSettler({
      usage: store,
      keys: { resolve: () => ({ key: KEY, source: "env" }) },
      fetchImpl,
      now: () => 10 * 60_000,
    });
    const pass = settler.runOnce();
    await vi.waitFor(() => expect(started).toBe(1));
    await settler.stop();
    await pass;
    expect(started).toBe(1);
    expect(aborted).toBe(1);
    // Nothing recorded for the aborted one: all three still wait (looked up again at the next start).
    expect(store.dueMedia(10 * 60_000, { maxTries: 12, maxAgeMs: 1e12, limit: 10 })).toHaveLength(3);
    await settler.runOnce();
    expect(started).toBe(1);
  });

  it("P3: due rows are chosen before the batch limit", () => {
    const db = createTestDb();
    db.$client
      .prepare("INSERT INTO users (id, email, name, role) VALUES ('u1', 'u1@x.test', 'u1', 'member')")
      .run();
    const now = 100 * 3600_000;
    const store = new UsageStore(db, () => now);
    for (let i = 0; i < 100; i++) {
      store.reserveMedia({
        userId: "u1",
        conversationId: null,
        runId: "w",
        callId: String(i),
        model: "m",
        estimateUsd: 1,
      });
      store.answeredMedia(mediaRunKey("w", String(i)), `gen-w-${i}`);
    }
    store.reserveMedia({
      userId: "u1",
      conversationId: null,
      runId: "due",
      callId: "0",
      model: "m",
      estimateUsd: 1,
    });
    store.answeredMedia(mediaRunKey("due", "0"), "gen-due");
    // The first 100 by `updated_at`: tried 30 minutes ago, but 8 times — their backoff (4 h 16 min) is not over.
    db.$client
      .prepare("UPDATE usage_records SET updated_at = ?, media_settle_tries = 8 WHERE run_id LIKE 'w#%'")
      .run(now - 30 * 60_000);
    // The 101st: tried more recently (3 minutes ago), once — its 2-minute backoff is over.
    db.$client
      .prepare("UPDATE usage_records SET updated_at = ?, media_settle_tries = 1 WHERE run_id LIKE 'due#%'")
      .run(now - 3 * 60_000);
    // A limit before the backoff check would take the 100 waiting ones and miss it.
    const due = store.dueMedia(now, { maxTries: 12, maxAgeMs: 1e12, limit: 100 });
    expect(due.map((r) => r.runKey)).toEqual([mediaRunKey("due", "0")]);
  });

  it("P3: the recent-request list says 진행 중 for a reservation, like the totals", async () => {
    const t = await start();
    t.app.usageStore!.reserveMedia({
      userId: t.f.users.owner.id,
      conversationId: null,
      runId: "r",
      callId: "1",
      model: "fixture/image-one",
      estimateUsd: 0.05,
    });
    const r = await t.api(t.f.cookies.admin, "GET", "/api/admin/usage");
    expect(r.statusCode, r.body).toBe(200);
    const report = r.json<{
      total: { costPending: number };
      recent: { costPending?: boolean; costUsd: null }[];
    }>();
    expect(report.total.costPending).toBe(1);
    expect(report.recent[0]).toMatchObject({ costPending: true, costUsd: null });
  });
});

// ---------------------------------------------------------------- review round 4 (#246)

describe("media tools: review round 4 regressions (#246)", () => {
  const user = (db: ReturnType<typeof createTestDb>) =>
    db.$client
      .prepare("INSERT INTO users (id, email, name, role) VALUES ('u1', 'u1@x.test', 'u1', 'member')")
      .run();

  it("P2: recovery does not depend on the clock — rows at the same ms or 'in the future' are taken up at start", async () => {
    const db = createTestDb();
    user(db);
    // The previous process's rows, written with a clock ahead of this start (it went backwards) and at its exact ms.
    const startAt = Date.now();
    const old = new UsageStore(db, () => startAt + 60_000);
    old.reserveMedia({
      userId: "u1",
      conversationId: null,
      runId: "a",
      callId: "1",
      model: "m",
      estimateUsd: 0.5,
    });
    old.generationMedia(mediaRunKey("a", "1"), "gen-a-1");
    const same = new UsageStore(db, () => startAt);
    same.reserveMedia({
      userId: "u1",
      conversationId: null,
      runId: "b",
      callId: "1",
      model: "m",
      estimateUsd: 0.2,
    });
    // A new lock-holding server on that database (`dataLock`, as index.ts starts it): recovery runs while the app
    // is built, before any request. Both clocks pinned to the start's ms.
    const dir = tmp();
    const app = await buildApp(
      loadConfig({
        NODE_ENV: "test",
        DATA_DIR: path.join(dir, "data"),
        MASTER_KEY_PATH: path.join(dir, "k"),
      }),
      {
        db,
        dataLock: { held: () => true },
        media: { fetchImpl: fixtureOpenRouterFetch(), now: () => startAt },
        usage: { now: () => startAt },
      },
    );
    closers.push(() => app.close());
    const rows = db.$client
      .prepare(
        "SELECT run_id r, media_settlement s, estimated_cost_micros e FROM usage_records ORDER BY run_id",
      )
      .all();
    expect(rows).toEqual([
      { r: mediaRunKey("a", "1"), s: "awaiting_cost", e: 500_000 },
      { r: mediaRunKey("b", "1"), s: "unconfirmed", e: 200_000 },
    ]);
  });

  it("P2: a recovery attempt that fails says so (null, logged); the next one can succeed; the moves are one transaction", () => {
    let calls = 0;
    const flaky = {
      recoverReservedMedia: () => {
        calls++;
        if (calls === 1) throw new Error("SQLITE_BUSY");
        return 3;
      },
    };
    expect(recoverMediaReservations(flaky)).toBeNull();
    expect(recoverMediaReservations(flaky)).toBe(3);
    expect(calls).toBe(2);
    const down = {
      recoverReservedMedia: () => {
        throw new Error("SQLITE_BUSY");
      },
    };
    const lines: unknown[] = [];
    const log = { info: () => {}, warn: () => {}, error: (...args: unknown[]) => void lines.push(args) };
    expect(recoverMediaReservations(down, { log: log as never })).toBeNull();
    expect(JSON.stringify(lines)).toContain("media.recovery_failed");
    // One transaction: a failure in the second move leaves the first undone too.
    const db = createTestDb();
    user(db);
    const store = new UsageStore(db, () => 1);
    store.reserveMedia({
      userId: "u1",
      conversationId: null,
      runId: "a",
      callId: "1",
      model: "m",
      estimateUsd: 1,
    });
    store.generationMedia(mediaRunKey("a", "1"), "gen-a-1");
    store.reserveMedia({
      userId: "u1",
      conversationId: null,
      runId: "b",
      callId: "1",
      model: "m",
      estimateUsd: 1,
    });
    db.$client.exec(
      "CREATE TRIGGER no_unconfirm BEFORE UPDATE OF media_settlement ON usage_records WHEN NEW.media_settlement = 'unconfirmed' BEGIN SELECT RAISE(ABORT, 'busy'); END",
    );
    expect(() => store.recoverReservedMedia()).toThrow();
    const states = () =>
      (
        db.$client.prepare("SELECT media_settlement s FROM usage_records ORDER BY run_id").all() as {
          s: string;
        }[]
      ).map((r) => r.s);
    expect(states()).toEqual(["reserved", "reserved"]);
    db.$client.exec("DROP TRIGGER no_unconfirm");
    expect(recoverMediaReservations(store)).toBe(2);
    expect(states()).toEqual(["awaiting_cost", "unconfirmed"]);
  });

  it("P3: without a key the settler still gives up the rows to be given up (all of them, up to the batch)", async () => {
    const db = createTestDb();
    user(db);
    const now = 10 * 24 * 3600_000;
    const store = new UsageStore(db, () => now);
    // First by `updated_at`: a row that would need a lookup; then one whose tries are used up.
    store.reserveMedia({
      userId: "u1",
      conversationId: null,
      runId: "look",
      callId: "1",
      model: "m",
      estimateUsd: 1,
    });
    store.answeredMedia(mediaRunKey("look", "1"), "gen-look");
    store.reserveMedia({
      userId: "u1",
      conversationId: null,
      runId: "spent",
      callId: "1",
      model: "m",
      estimateUsd: 1,
    });
    store.answeredMedia(mediaRunKey("spent", "1"), "gen-spent");
    db.$client
      .prepare("UPDATE usage_records SET updated_at = ? WHERE run_id LIKE 'look#%'")
      .run(now - 10 * 60_000);
    db.$client
      .prepare("UPDATE usage_records SET updated_at = ?, media_settle_tries = ? WHERE run_id LIKE 'spent#%'")
      .run(now - 60_000, MAX_TRIES);
    let fetched = 0;
    const settler = new MediaSettler({
      usage: store,
      keys: { resolve: () => undefined },
      fetchImpl: (async () => {
        fetched++;
        return Response.json({});
      }) as unknown as typeof fetch,
      now: () => now,
    });
    await settler.runOnce();
    const states = db.$client
      .prepare("SELECT run_id r, media_settlement s FROM usage_records ORDER BY run_id")
      .all();
    expect(states).toEqual([
      { r: mediaRunKey("look", "1"), s: "awaiting_cost" },
      { r: mediaRunKey("spent", "1"), s: "unconfirmed" },
    ]);
    expect(fetched).toBe(0);
  });
});

// ---------------------------------------------------------------- review round 5 (#246)

describe("media tools: review round 5 — recovery failure keeps the server up (#246)", () => {
  it("a server whose recovery fails starts, chats, refuses media (media_recovering) until a retry succeeds", async () => {
    const db = createTestDb();
    const dir = path.join(tmp(), "data");
    const registry = new RuntimeRegistry();
    registry.register(new FakeRuntime({ runTools: true }));
    // Users first (createFamily needs an app); the trigger is set before the second app is built.
    const first = await buildApp(
      loadConfig({
        NODE_ENV: "test",
        DATA_DIR: dir,
        MASTER_KEY_PATH: path.join(dir, "..", "k"),
        OPENROUTER_API_KEY: KEY,
      }),
      { db, runtimes: registry, runs: { flushMs: 0 } },
    );
    const f = await createFamily(first);
    await first.close();
    new UsageStore(db, () => 1).reserveMedia({
      userId: f.users.owner.id,
      conversationId: null,
      runId: "old",
      callId: "1",
      model: "m",
      estimateUsd: 0.5,
    });
    db.$client.exec(
      "CREATE TRIGGER no_recover BEFORE UPDATE OF media_settlement ON usage_records BEGIN SELECT RAISE(ABORT, 'busy'); END",
    );
    const app = await buildApp(
      loadConfig({
        NODE_ENV: "test",
        DATA_DIR: dir,
        MASTER_KEY_PATH: path.join(dir, "..", "k"),
        OPENROUTER_API_KEY: KEY,
      }),
      {
        db,
        dataLock: { held: () => true },
        runtimes: registry,
        runs: { flushMs: 0 },
        media: {
          fetchImpl: fixtureOpenRouterFetch(),
          sleep: async () => {},
          recovery: { background: false },
        },
      },
    );
    closers.push(() => app.close());
    expect(app.media!.recovery.recovering()).toBe(true);
    // Chat works.
    const conv = app.conversations!.create(f.users.owner.id);
    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conv.id}/messages`,
      headers: { ...WRITE, cookie: f.cookies.owner, "content-type": "application/json" },
      payload: { text: "안녕" },
    });
    expect(res.statusCode, res.body).toBe(201);
    const run = await waitRun(app, (res.json() as { run: Run }).run.id);
    expect(run.run.status).toBe("done");
    // Media waits (a fixed, retryable answer) — nothing is reserved meanwhile.
    app.media!.settings.set(settingsWith({ image: "fixture/image-one" }));
    db.$client.prepare("UPDATE runs SET ended_at = NULL WHERE id = ?").run(run.run.id);
    const scope = { userId: f.users.owner.id, conversationId: conv.id, runId: run.run.id };
    expect(await app.media!.tools.run("image", scope, { prompt: "산" })).toMatchObject({
      ok: false,
      code: "media_recovering",
      hint: MEDIA_TOOL_HINTS.media_recovering,
    });
    const count = () =>
      (
        db.$client.prepare("SELECT count(*) n FROM usage_records WHERE purpose = 'media'").get() as {
          n: number;
        }
      ).n;
    expect(count()).toBe(1);
    // Still failing: still blocked. Then the lock is gone: the retry succeeds and media is allowed again.
    expect(app.media!.recovery.retryNow()).toBe(false);
    expect(app.media!.recovery.recovering()).toBe(true);
    db.$client.exec("DROP TRIGGER no_recover");
    expect(app.media!.recovery.retryNow()).toBe(true);
    expect(app.media!.recovery.recovering()).toBe(false);
    expect(
      (
        db.$client
          .prepare("SELECT media_settlement s FROM usage_records WHERE run_id = ?")
          .get(mediaRunKey("old", "1")) as {
          s: string;
        }
      ).s,
    ).toBe("unconfirmed");
    expect((await app.media!.tools.run("image", scope, { prompt: "산" })).ok).toBe(true);
  });

  it("a buildApp that does not hold the data lock never recovers (another server's calls may be in flight)", async () => {
    const t = await start();
    t.app.usageStore!.reserveMedia({
      userId: t.f.users.owner.id,
      conversationId: null,
      runId: "inflight",
      callId: "1",
      model: "m",
      estimateUsd: 0.5,
    });
    const dir = tmp();
    const other = await buildApp(
      loadConfig({
        NODE_ENV: "test",
        DATA_DIR: path.join(dir, "data"),
        MASTER_KEY_PATH: path.join(dir, "k"),
      }),
      { db: t.db, media: { fetchImpl: fixtureOpenRouterFetch() } },
    );
    closers.push(() => other.close());
    expect(other.media!.recovery.recovering()).toBe(false);
    expect(t.usageRows()).toEqual([expect.objectContaining({ estimated_cost_micros: 500_000 })]);
    expect(
      (
        t.db.$client
          .prepare("SELECT media_settlement s FROM usage_records WHERE purpose = 'media'")
          .get() as { s: string }
      ).s,
    ).toBe("reserved");
  });
});

// ---------------------------------------------------------------- review round 6 (#246)

describe("media tools: review round 6 — background recovery never blocks, only with the lock held (#246)", () => {
  it("a background retry with another connection holding the write lock returns at once; busy_timeout is restored", async () => {
    const dir = tmp();
    const file = path.join(dir, "media.db");
    const db = openDb(file);
    runMigrations(db);
    db.$client
      .prepare("INSERT INTO users (id, email, name, role) VALUES ('u1', 'u1@x.test', 'u1', 'member')")
      .run();
    const store = new UsageStore(db, () => 1);
    store.reserveMedia({
      userId: "u1",
      conversationId: null,
      runId: "old",
      callId: "1",
      model: "m",
      estimateUsd: 1,
    });
    // Another connection holds the write lock.
    const other = new Database(file);
    other.exec("BEGIN IMMEDIATE");
    let held = false;
    const recovery = new MediaRecovery({ usage: store, held: () => held, background: false });
    // The lock was not held at start: nothing touched, media blocked.
    expect(recovery.runAtStart()).toBe(false);
    expect(recovery.recovering()).toBe(true);
    held = true;
    // An unrelated timer due in 20 ms is not held up by the retry.
    const fired = new Promise<number>((r) => {
      const at = Date.now();
      setTimeout(() => r(Date.now() - at), 20);
    });
    const t0 = Date.now();
    expect(recovery.retryNow()).toBe(false);
    expect(Date.now() - t0).toBeLessThan(200);
    expect(await fired).toBeLessThan(500);
    expect(Number(db.$client.pragma("busy_timeout", { simple: true }))).toBe(5000);
    expect(recovery.recovering()).toBe(true);
    // The other writer is done: the next tick succeeds and lifts the block.
    other.exec("COMMIT");
    other.close();
    expect(recovery.retryNow()).toBe(true);
    expect(recovery.recovering()).toBe(false);
    expect(
      (db.$client.prepare("SELECT media_settlement s FROM usage_records").get() as { s: string }).s,
    ).toBe("unconfirmed");
    db.$client.close();
  });

  it("a released data-lock handle touches no row and keeps media blocked", () => {
    const db = createTestDb();
    db.$client
      .prepare("INSERT INTO users (id, email, name, role) VALUES ('u1', 'u1@x.test', 'u1', 'member')")
      .run();
    const store = new UsageStore(db, () => 1);
    store.reserveMedia({
      userId: "u1",
      conversationId: null,
      runId: "old",
      callId: "1",
      model: "m",
      estimateUsd: 1,
    });
    let held = true;
    const spy = vi.spyOn(store, "recoverReservedMedia");
    held = false; // released before the start
    const recovery = new MediaRecovery({ usage: store, held: () => held, background: false });
    expect(recovery.runAtStart()).toBe(false);
    expect(recovery.retryNow()).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(recovery.recovering()).toBe(true);
    expect(
      (db.$client.prepare("SELECT media_settlement s FROM usage_records").get() as { s: string }).s,
    ).toBe("reserved");
    held = true;
    expect(recovery.retryNow()).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
