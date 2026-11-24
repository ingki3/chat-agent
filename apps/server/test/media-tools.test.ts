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
import { FILE_CSP } from "../src/files/routes.js";
import {
  FIXTURE_GENERATION_ID,
  FIXTURE_IMAGE_COST,
  FIXTURE_OPENROUTER_KEY_PREFIX,
  FIXTURE_SPEECH_COST,
  fixtureOpenRouterFetch,
  silentMp3,
  solidPng,
} from "../src/media/fixture.js";
import { imageKindOf, isMp3 } from "../src/media/generate.js";
import {
  fetchCatalog,
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
      media: { fetchImpl: rec.fetchImpl, sleep: async () => {} },
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
        "SELECT run_id, model, cost_usd, priced_cost_micros, purpose FROM usage_records WHERE purpose = 'media'",
      )
      .all() as {
      run_id: string;
      model: string;
      cost_usd: number | null;
      priced_cost_micros: number | null;
    }[];
  const posts = () => rec.requests.filter((r) => r.method === "POST");
  return { app, db, f, api, send, scopeOf, enable, usageRows, posts, requests: rec.requests };
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
      "openai/gpt-4o-mini-tts": "$0.0000006/character",
      "bytedance-seed/seed-audio-1-0": "$0.0025/second",
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
