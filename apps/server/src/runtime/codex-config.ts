import type { UserStore } from "../auth/users.js";
import type { ConnectionStore } from "../connections/store.js";
import type { ConnectionRequest } from "./adapter.js";
import { CodexAdapter, type CodexConnection } from "./codex.js";

/**
 * Codex connections from the database (#17): OpenAI API keys, personal or shared. Each member's own ChatGPT login
 * (PRD D2) comes with #18 — app-server's `chatgptDeviceCode` login or injected `chatgptAuthTokens`, both in memory
 * like the key. Folders are per connection *and* user: `data/runtimes/<connection id>/<user id>/` (review #80).
 */
export function codexConnectionFor(
  store: Pick<ConnectionStore, "resolve">,
  users: Pick<UserStore, "byId">,
  ctx: ConnectionRequest,
): CodexConnection | undefined {
  const r = store.resolve(ctx.connectionId, users.byId(ctx.userId), "codex", {
    test: ctx.connectionTest === true,
    version: ctx.connectionVersion,
  });
  if (!r || r.authType !== "api_key") return undefined;
  return { id: r.id, dir: r.dir, auth: { kind: "api_key", apiKey: r.secret } };
}

export function codexFromStore(
  store: ConnectionStore,
  users: UserStore,
  egress: { endpoint(): Promise<{ port: number; url: string }> },
): CodexAdapter {
  return new CodexAdapter({ connection: (ctx) => codexConnectionFor(store, users, ctx), egress });
}
