import type { UserStore } from "../auth/users.js";
import type { ConnectionStore } from "../connections/store.js";
import type { ConnectionRequest } from "./adapter.js";
import { ClaudeAdapter, type ClaudeConnection } from "./claude.js";

/**
 * Claude Code connections from the database (#17). The run's connection is resolved and re-checked for this user
 * (connected, passed — or under test — and allowed). A Claude subscription is used for an admin's own runs only
 * (PRD D2): checked when it is registered, and again here in case the account is no longer an admin.
 * Folders are per connection *and* user: `data/runtimes/<connection id>/<user id>/` (review #80).
 */
export function claudeConnectionFor(
  store: Pick<ConnectionStore, "resolve">,
  users: Pick<UserStore, "byId">,
  ctx: ConnectionRequest,
): ClaudeConnection | undefined {
  const user = users.byId(ctx.userId);
  const r = store.resolve(ctx.connectionId, user, "claude-code", {
    test: ctx.connectionTest === true,
    version: ctx.connectionVersion,
  });
  if (!r) return undefined;
  if (r.authType === "subscription")
    return user?.role === "admin"
      ? { id: r.id, dir: r.dir, auth: { kind: "oauth_token", token: r.secret } }
      : undefined;
  return { id: r.id, dir: r.dir, auth: { kind: "api_key", apiKey: r.secret } };
}

export function claudeFromStore(
  store: ConnectionStore,
  users: UserStore,
  egress: { endpoint(): Promise<{ port: number; url: string }> },
): ClaudeAdapter {
  return new ClaudeAdapter({ connection: (ctx) => claudeConnectionFor(store, users, ctx), egress });
}
