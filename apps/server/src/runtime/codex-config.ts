import type { UserStore } from "../auth/users.js";
import { parseCredential, type ChatgptTokenService } from "../connections/chatgpt.js";
import type { ConnectionStore } from "../connections/store.js";
import type { ConnectionRequest } from "./adapter.js";
import { CodexAdapter, type CodexConnection } from "./codex.js";

type Egress = { endpoint(): Promise<{ port: number; url: string }> };

/**
 * Codex connections from the database (#17): OpenAI API keys (personal or shared), and each member's own ChatGPT
 * login (#18, personal only — PRD D2): its access token goes to app-server as `chatgptAuthTokens` (memory only,
 * like the key); when app-server asks for new tokens the server refreshes them (`ChatgptTokenService`) and stores
 * them encrypted with a new credential version. Folders are per connection *and* user:
 * `data/runtimes/<connection id>/<user id>/` (review #80).
 */
export function codexConnectionFor(
  store: Pick<ConnectionStore, "resolve">,
  users: Pick<UserStore, "byId">,
  ctx: ConnectionRequest,
  tokens?: Pick<ChatgptTokenService, "refresh">,
): CodexConnection | undefined {
  const r = store.resolve(ctx.connectionId, users.byId(ctx.userId), "codex", {
    test: ctx.connectionTest === true,
    version: ctx.connectionVersion,
  });
  if (!r) return undefined;
  if (r.authType === "api_key") return { id: r.id, dir: r.dir, auth: { kind: "api_key", apiKey: r.secret } };
  const cred = parseCredential(r.secret);
  if (!cred || !tokens) return undefined;
  let have = r.version;
  return {
    id: r.id,
    dir: r.dir,
    auth: {
      kind: "chatgpt",
      accessToken: cred.accessToken,
      accountId: cred.accountId,
      planType: cred.planType,
      refresh: async () => {
        const t = await tokens.refresh(r.id, have);
        have = t.version;
        return { accessToken: t.accessToken, accountId: t.accountId, planType: t.planType };
      },
    },
  };
}

export function codexFromStore(
  store: ConnectionStore,
  users: UserStore,
  egress: Egress,
  chatgpt: { tokens: Pick<ChatgptTokenService, "refresh">; egress: Egress },
): CodexAdapter {
  return new CodexAdapter({
    connection: (ctx) => codexConnectionFor(store, users, ctx, chatgpt.tokens),
    egress,
    chatgptEgress: chatgpt.egress,
  });
}
