import { carriesSecret } from "../secrets/egress.js";

/**
 * The request policy of every media generation (#238), for the stage 2–3 tools to build their bodies with:
 *
 * - every body carries `provider: { data_collection: "deny" }` (providers that store or train on prompts are not
 *   used — OpenRouter routes around them). A caller's own `provider` options stay, but this one cannot be turned
 *   off;
 * - every text that goes out (prompt, instructions, voice, the URL) passes the one egress predicate first: a
 *   request that carries a secret this server knows is never sent (`media_secret_in_prompt`);
 * - youth accounts see the tools (user decision 2026-11-24) but ask for the provider's strictest moderation where
 *   the model has such a parameter (`moderationFor`). The forbidden-use rules in the tool descriptions are the same
 *   for every account.
 */
export const MEDIA_PROVIDER_POLICY = { data_collection: "deny" } as const;

export type MediaRequestContext = { youth: boolean };

/** The body with the policy's provider options on it (they win over the caller's). */
export function withMediaPolicy<T extends Record<string, unknown>>(
  body: T,
): T & { provider: Record<string, unknown> & typeof MEDIA_PROVIDER_POLICY } {
  const own = body.provider;
  const provider =
    typeof own === "object" && own !== null && !Array.isArray(own) ? (own as Record<string, unknown>) : {};
  return { ...body, provider: { ...provider, ...MEDIA_PROVIDER_POLICY } };
}

/** Whether any text of the request carries a known secret (then it must not be sent). */
export function mediaRequestCarriesSecret(texts: readonly string[]): boolean {
  return carriesSecret(texts);
}

/**
 * Moderation values from strictest to loosest, as providers name them (OpenAI's image `moderation`: `auto` is the
 * stricter of `auto`/`low`).
 */
export const STRICTNESS = ["strict", "high", "auto", "medium", "default", "low", "off", "none"];

/**
 * The moderation value to send: for a youth account, the strictest one the model lists (null when it lists none —
 * the provider's default then applies); for everyone else, null (the provider's default).
 */
export function moderationFor(
  ctx: MediaRequestContext,
  values: readonly string[] | undefined,
): string | null {
  if (!ctx.youth || !values?.length) return null;
  const known = STRICTNESS.find((v) => values.includes(v));
  return known ?? null;
}

/** Youth accounts always ask for the strictest moderation (fixed policy, shown on the admin screen). */
export const YOUTH_STRICT_MODERATION = true as const;
