import path from "node:path";
import type { UserStore } from "../auth/users.js";
import type { Config } from "../config.js";
import { CodexAdapter, type CodexConnection } from "./codex.js";

/**
 * Codex from `.env` credentials, until connections live in the app (#17): the OpenAI API key serves every active
 * family member. Each member's own ChatGPT login (PRD D2) comes with #18 — app-server's `chatgptDeviceCode` login
 * or injected `chatgptAuthTokens`, both in memory like the key.
 */
export function codexConnectionFor(
  config: Pick<Config, "codex" | "dataDir">,
  users: Pick<UserStore, "byId">,
  userId: string,
): CodexConnection | undefined {
  const u = users.byId(userId);
  if (!u?.active || !config.codex) return undefined;
  // One folder per connection *and user*: threads, state and caches of one family member are never in another's
  // sandbox (review #80). The user id is a server-generated UUID.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(u.id)) return undefined;
  return {
    id: "codex-api-key",
    dir: path.join(config.dataDir, "runtimes", "codex-api-key", u.id),
    auth: { kind: "api_key", apiKey: config.codex.apiKey },
  };
}

export function codexFromConfig(
  config: Config,
  users: UserStore,
  egress: { endpoint(): Promise<{ port: number; url: string }> },
): CodexAdapter {
  return new CodexAdapter({ connection: (userId) => codexConnectionFor(config, users, userId), egress });
}
