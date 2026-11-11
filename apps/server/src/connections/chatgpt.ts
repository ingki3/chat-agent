import { logEvent, type EventLogger } from "../logging.js";
import { safeFetch } from "../isolation/net.js";
import { RuntimeFailure } from "../runtime/adapter.js";
import type { ConnectionStore } from "./store.js";

/**
 * ChatGPT login credentials of a Codex connection (#18). Facts from the pinned @openai/codex 0.165.0 (its protocol
 * bindings and the strings in its binary — docs/decisions/runtime-capabilities.md §2.5):
 *  - the device-code login talks to `auth.openai.com` (`/api/accounts/deviceauth/usercode`, `…/deviceauth/token`,
 *    then `/oauth/token`) and the user signs in at `https://auth.openai.com/codex/device`;
 *  - Codex's public OAuth client id is `app_EMoamEEZ73f0CkXaXp7hrann`; a token refresh is a POST of
 *    `{client_id, grant_type: "refresh_token", refresh_token, scope}` to `https://auth.openai.com/oauth/token`;
 *  - app-server takes ChatGPT tokens from its client (`account/login/start {type:"chatgptAuthTokens"}`, held in
 *    memory) and, when one is refused, asks the client for a new one (server request
 *    `account/chatgptAuthTokens/refresh`) — it never refreshes them itself in that mode.
 * So the refresh token never enters a runtime process: the server keeps it (encrypted, store.ts) and refreshes here.
 */

export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_TOKEN_URL = `${CHATGPT_ISSUER}/oauth/token`;
export const CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** What is stored (encrypted) for a ChatGPT login. */
export type ChatgptCredential = {
  v: 1;
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  accountId: string;
  planType: string | null;
};

/** What a runtime process gets: the access token and account only — never the refresh token. */
export type ChatgptTokens = { accessToken: string; accountId: string; planType: string | null };

const TOKEN = /^[\x21-\x7e]{8,16384}$/;
const ACCOUNT = /^[A-Za-z0-9_.:-]{1,200}$/;

export function serializeCredential(c: ChatgptCredential): string {
  return JSON.stringify(c);
}

export function parseCredential(secret: string): ChatgptCredential | undefined {
  try {
    const c = JSON.parse(secret) as Partial<ChatgptCredential>;
    if (
      c.v !== 1 ||
      typeof c.accessToken !== "string" ||
      !TOKEN.test(c.accessToken) ||
      typeof c.refreshToken !== "string" ||
      !TOKEN.test(c.refreshToken) ||
      typeof c.accountId !== "string" ||
      !ACCOUNT.test(c.accountId)
    )
      return undefined;
    return {
      v: 1,
      accessToken: c.accessToken,
      refreshToken: c.refreshToken,
      idToken: typeof c.idToken === "string" ? c.idToken : null,
      accountId: c.accountId,
      planType: typeof c.planType === "string" ? c.planType : null,
    };
  } catch {
    return undefined;
  }
}

/** A JWT's claims, unverified (only read for its expiry and account id, as Codex itself does). */
export function jwtClaims(token: string): Record<string, unknown> | undefined {
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const v = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** When the access token expires (ms), if it says. */
export function tokenExpiry(token: string): number | undefined {
  const exp = jwtClaims(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
}

function authClaim(token: string | null | undefined): Record<string, unknown> {
  const c = token ? jwtClaims(token)?.["https://api.openai.com/auth"] : undefined;
  return c && typeof c === "object" ? (c as Record<string, unknown>) : {};
}

/**
 * The credential in the `auth.json` a file-store login writes (codex 0.165.0:
 * `{auth_mode, OPENAI_API_KEY, tokens: {id_token, access_token, refresh_token, account_id}, last_refresh}`).
 * Undefined when it is not a complete ChatGPT login.
 */
export function credentialFromAuthJson(text: string): ChatgptCredential | undefined {
  try {
    const j = JSON.parse(text) as { tokens?: Record<string, unknown> | null };
    const t = j.tokens ?? {};
    const idToken =
      typeof t.id_token === "string"
        ? t.id_token
        : typeof (t.id_token as { raw_jwt?: unknown } | null)?.raw_jwt === "string"
          ? ((t.id_token as { raw_jwt: string }).raw_jwt as string)
          : null;
    const access = typeof t.access_token === "string" ? t.access_token : "";
    const accountId =
      (typeof t.account_id === "string" && t.account_id) ||
      (authClaim(access).chatgpt_account_id as string | undefined) ||
      (authClaim(idToken).chatgpt_account_id as string | undefined) ||
      "";
    const plan = authClaim(access).chatgpt_plan_type ?? authClaim(idToken).chatgpt_plan_type;
    return parseCredential(
      serializeCredential({
        v: 1,
        accessToken: access,
        refreshToken: typeof t.refresh_token === "string" ? t.refresh_token : "",
        idToken,
        accountId,
        planType: typeof plan === "string" ? plan : null,
      }),
    );
  } catch {
    return undefined;
  }
}

/** How the server POSTs to the token endpoint (tests replace it). */
export type TokenPost = (url: string, body: string) => Promise<{ status: number; body: string }>;

export const defaultTokenPost: TokenPost = async (url, body) => {
  const r = await safeFetch(url, {
    body,
    headers: { "content-type": "application/json", accept: "application/json" },
    timeoutMs: 20_000,
    maxBytes: 256 * 1024,
    maxRedirects: 0,
  });
  return { status: r.status, body: r.body.toString("utf8") };
};

/**
 * One refresh at the token endpoint. Rejects with `RuntimeFailure("runtime_auth")` when the provider refuses the
 * refresh token (expired, reused, revoked — the user must log in again) and `runtime_error` for anything else
 * (network, server error): the login itself may still be fine.
 */
export async function refreshChatgptTokens(
  refreshToken: string,
  post: TokenPost,
): Promise<{ accessToken: string; refreshToken: string | null; idToken: string | null }> {
  let r: { status: number; body: string };
  try {
    r = await post(
      CHATGPT_TOKEN_URL,
      JSON.stringify({
        client_id: CODEX_OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: "openid profile email",
      }),
    );
  } catch {
    throw new RuntimeFailure("runtime_error");
  }
  if (r.status === 400 || r.status === 401 || r.status === 403) throw new RuntimeFailure("runtime_auth");
  if (r.status !== 200) throw new RuntimeFailure("runtime_error");
  let j: { access_token?: unknown; refresh_token?: unknown; id_token?: unknown };
  try {
    j = JSON.parse(r.body) as typeof j;
  } catch {
    throw new RuntimeFailure("runtime_error");
  }
  if (typeof j.access_token !== "string" || !TOKEN.test(j.access_token))
    throw new RuntimeFailure("runtime_error");
  return {
    accessToken: j.access_token,
    refreshToken: typeof j.refresh_token === "string" && TOKEN.test(j.refresh_token) ? j.refresh_token : null,
    idToken: typeof j.id_token === "string" ? j.id_token : null,
  };
}

/**
 * Refreshes a connection's ChatGPT tokens for a running session and stores the result encrypted with a new
 * credential version (the base version stays: running and queued runs keep working). One refresh per connection
 * at a time; a session that asks after another one already refreshed gets the newer tokens without a second call
 * (OpenAI refresh tokens are single-use).
 */
export class ChatgptTokenService {
  private readonly running = new Map<string, Promise<unknown>>();
  constructor(
    private readonly store: Pick<ConnectionStore, "get" | "subscriptionCredential" | "refreshCredential">,
    private readonly opts: { post?: TokenPost; log?: EventLogger | undefined } = {},
  ) {}

  /**
   * New tokens for connection `id`, whose session holds the credential of version `have`. Rejects with
   * `runtime_auth` when the login can no longer be used (refused, replaced by a new login, disconnected).
   */
  async refresh(id: string, have: number): Promise<ChatgptTokens & { version: number }> {
    const before = this.running.get(id) ?? Promise.resolve();
    const mine = before.catch(() => undefined).then(() => this.refreshNow(id, have));
    this.running.set(id, mine);
    try {
      return await mine;
    } finally {
      if (this.running.get(id) === mine) this.running.delete(id);
    }
  }

  private async refreshNow(id: string, have: number): Promise<ChatgptTokens & { version: number }> {
    const cur = this.store.subscriptionCredential(id);
    // Disconnected, or replaced by a new login since the session started: that session's login is over.
    if (!cur || have < cur.baseVersion) throw new RuntimeFailure("runtime_auth");
    const cred = parseCredential(cur.secret);
    if (!cred) throw new RuntimeFailure("runtime_auth");
    if (cur.version > have) return { ...tokensOf(cred), version: cur.version }; // someone else just refreshed
    let fresh: Awaited<ReturnType<typeof refreshChatgptTokens>>;
    try {
      fresh = await refreshChatgptTokens(cred.refreshToken, this.opts.post ?? defaultTokenPost);
    } catch (e) {
      logEvent(this.opts.log, "warn", "connection.refresh_failed", {
        connectionId: id,
        runtime: "codex",
        errorCode: e instanceof RuntimeFailure ? e.code : "runtime_error",
      });
      throw e;
    }
    const next: ChatgptCredential = {
      ...cred,
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken ?? cred.refreshToken,
      idToken: fresh.idToken ?? cred.idToken,
      accountId: (authClaim(fresh.accessToken).chatgpt_account_id as string | undefined) || cred.accountId,
    };
    const version = this.store.refreshCredential(id, cur.version, serializeCredential(next));
    // Disconnected or replaced while the refresh ran: the new tokens are thrown away.
    if (version === undefined) throw new RuntimeFailure("runtime_auth");
    logEvent(this.opts.log, "info", "connection.refreshed", { connectionId: id, runtime: "codex" });
    return { ...tokensOf(next), version };
  }
}

export function tokensOf(c: ChatgptCredential): ChatgptTokens {
  return { accessToken: c.accessToken, accountId: c.accountId, planType: c.planType };
}
