import { MEDIA_CATALOG_URLS, OPENROUTER_KEY_URL } from "./openrouter.js";

/**
 * A scripted OpenRouter for the e2e run and manual testing with FAKE_RUNTIME=1 (#238): the server never reaches
 * openrouter.ai there. A key starting with `sk-or-v1-e2e` is accepted (limit $100, $87.5 left); any other is
 * refused (401). The catalogs are small made-up lists in OpenRouter's documented shapes.
 */
export const FIXTURE_OPENROUTER_KEY_PREFIX = "sk-or-v1-e2e";

const CATALOGS: Record<string, unknown> = {
  [MEDIA_CATALOG_URLS.image]: {
    data: [
      {
        id: "fixture/image-one",
        name: "Fixture Image One",
        supported_parameters: {
          aspect_ratio: { type: "enum", values: ["1:1", "16:9", "9:16"] },
          resolution: { type: "enum", values: ["1K", "2K"] },
          seed: { type: "boolean" },
        },
        endpoints: [{ pricing: [{ billable: "output_image", unit: "image", cost_usd: 0.04 }] }],
      },
      { id: "fixture/image-two", name: "Fixture Image Two", supported_parameters: {} },
    ],
  },
  [MEDIA_CATALOG_URLS.speech]: {
    data: [
      {
        id: "fixture/voice-one",
        name: "Fixture Voice",
        output_modalities: [
          {
            type: "speech",
            supported_parameters: {
              voice: { type: "enum", values: ["alloy", "nova"] },
              response_format: { type: "enum", values: ["mp3", "pcm"] },
              speed: { type: "range", min: 0.7, max: 1.2 },
            },
          },
        ],
        endpoints: [{ pricing: { characters: "0.000015" } }],
      },
    ],
  },
  [MEDIA_CATALOG_URLS.music]: {
    data: [
      {
        id: "fixture/music-clip",
        name: "Fixture Music Clip",
        architecture: { input_modalities: ["text"], output_modalities: ["text", "audio"] },
        pricing: { request: "0.04" },
      },
      {
        id: "fixture/text-only",
        name: "Not audio",
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      },
    ],
  },
  [MEDIA_CATALOG_URLS.video]: {
    data: [
      {
        id: "fixture/video-one",
        name: "Fixture Video",
        supported_durations: [4, 6, 8, 12],
        supported_resolutions: ["720p", "1080p"],
        supported_aspect_ratios: ["16:9", "9:16"],
        pricing_skus: { "per-video-second": "0.50", "per-video-second-1080p": "0.75" },
      },
    ],
  },
};

export function fixtureOpenRouterFetch(): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const ok = auth.startsWith(`Bearer ${FIXTURE_OPENROUTER_KEY_PREFIX}`);
    if (!ok) return Response.json({ error: { code: 401, message: "No auth" } }, { status: 401 });
    if (url === OPENROUTER_KEY_URL)
      return Response.json({ data: { label: "e2e", limit: 100, limit_remaining: 87.5, usage: 12.5 } });
    const body = CATALOGS[url];
    if (body) return Response.json(body);
    return Response.json({ error: { code: 404 } }, { status: 404 });
  }) as typeof fetch;
}
