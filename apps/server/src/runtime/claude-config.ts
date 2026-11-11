import path from "node:path";
import type { UserStore } from "../auth/users.js";
import type { Config } from "../config.js";
import { ClaudeAdapter, type ClaudeConnection } from "./claude.js";

/**
 * Claude Code from `.env` credentials, until connections live in the app (#17). Who may use what (PRD D2):
 * the subscription token only for the admin's own conversations; the API key for every active family member.
 */
export function claudeConnectionFor(
  config: Pick<Config, "claude" | "dataDir" | "adminEmail">,
  users: Pick<UserStore, "byId">,
  userId: string,
): ClaudeConnection | undefined {
  const u = users.byId(userId);
  if (!u?.active || !config.claude) return undefined;
  // One CLI folder per connection *and user*: sessions, caches and transcripts of one family member are never in
  // another's sandbox (review #80). The user id is a server-generated UUID.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(u.id)) return undefined;
  const dir = (id: string) => path.join(config.dataDir, "runtimes", id, u.id);
  if (config.claude.oauthToken && u.role === "admin" && u.email.toLowerCase() === config.adminEmail)
    return {
      id: "claude-admin-subscription",
      dir: dir("claude-admin-subscription"),
      auth: { kind: "oauth_token", token: config.claude.oauthToken },
    };
  if (config.claude.apiKey)
    return {
      id: "claude-api-key",
      dir: dir("claude-api-key"),
      auth: { kind: "api_key", apiKey: config.claude.apiKey },
    };
  return undefined;
}

export function claudeFromConfig(
  config: Config,
  users: UserStore,
  egress: { endpoint(): Promise<{ port: number; url: string }> },
): ClaudeAdapter {
  return new ClaudeAdapter({ connection: (userId) => claudeConnectionFor(config, users, userId), egress });
}
