import crypto from "node:crypto";

/** The Cloudflare API (v4). Production always uses this; tests pass a loopback mock server instead. */
export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/**
 * Fixed failure codes of a Cloudflare call — the only thing stored or shown (never a message from Cloudflare, a
 * header or the token):
 * - `cf_unauthorized`: 401/403 — the token is wrong, expired or lacks the Access app & policy permission;
 * - `cf_not_found`: 404 — the account, application or policy id is wrong;
 * - `cf_rate_limited`: 429 (with `retryAfterMs` from `Retry-After`);
 * - `cf_unavailable`: 5xx, a network error or the time limit;
 * - `cf_bad_response`: an answer that is not the documented shape.
 */
export type CloudflareCode =
  "cf_unauthorized" | "cf_not_found" | "cf_rate_limited" | "cf_unavailable" | "cf_bad_response";

export class CloudflareError extends Error {
  constructor(
    readonly code: CloudflareCode,
    readonly status: number | null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(code);
  }
}

/** Where the managed policy lives: a reusable policy (`/access/policies/:id`) or one scoped to the app. */
export type PolicyScope = "reusable" | "app";

export type AccessTarget = {
  accountId: string;
  appId: string;
  policyId: string;
  scope: PolicyScope;
};

/** A policy as Cloudflare returns it (only `include` is read and changed; the rest is written back untouched). */
export type RawPolicy = Record<string, unknown> & { include?: unknown };

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const ID = /^[A-Za-z0-9-]{1,64}$/;
/** Read-only fields of a policy answer: not sent back in the PUT. */
const READ_ONLY = ["id", "uid", "created_at", "updated_at", "reusable", "app_count", "apps"];
const MAX_BODY = 1_000_000;

export const validId = (s: string) => ID.test(s);
export const normalizeEmail = (e: string) => e.trim().toLowerCase();

/** One include rule as an email, or undefined for any other kind of rule (group, domain, everyone, …). */
export function ruleEmail(rule: unknown): string | undefined {
  if (!rule || typeof rule !== "object") return undefined;
  const r = rule as { email?: unknown };
  if (Object.keys(rule).length !== 1 || !r.email || typeof r.email !== "object") return undefined;
  const e = (r.email as { email?: unknown }).email;
  return typeof e === "string" && e.includes("@") ? normalizeEmail(e) : undefined;
}

/** Canonical JSON (keys sorted at every level), so a revision does not depend on key order. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v ?? null);
}

/**
 * The policy's revision: a hash of the whole policy as Cloudflare returned it (include, exclude, require, name,
 * `updated_at`…). Cloudflare has no conditional write, so the server compares this right before writing: anything
 * changed in the dashboard since the preview — not just the email list — means "preview again".
 */
export const policyRevision = (p: RawPolicy) =>
  crypto.createHash("sha256").update(canonical(p)).digest("hex").slice(0, 32);

export type PolicySnapshot = {
  raw: RawPolicy;
  revision: string;
  /** The email rules' emails, in the policy's order (normalised; duplicates dropped). */
  emails: string[];
  /** Include rules that are not a single email (kept as they are; counted on the screen). */
  otherRules: unknown[];
  decision: string | null;
  name: string | null;
  reusable: boolean | null;
};

export function snapshot(raw: RawPolicy): PolicySnapshot {
  if (raw.include !== undefined && !Array.isArray(raw.include))
    throw new CloudflareError("cf_bad_response", null);
  const include = (raw.include as unknown[] | undefined) ?? [];
  const emails: string[] = [];
  const otherRules: unknown[] = [];
  for (const rule of include) {
    const e = ruleEmail(rule);
    if (e === undefined) otherRules.push(rule);
    else if (!emails.includes(e)) emails.push(e);
  }
  return {
    raw,
    revision: policyRevision(raw),
    emails,
    otherRules,
    decision: typeof raw.decision === "string" ? raw.decision : null,
    name: typeof raw.name === "string" ? raw.name : null,
    reusable: typeof raw.reusable === "boolean" ? raw.reusable : null,
  };
}

/** The policy body to PUT: the live one with its include emails replaced by `emails`, other rules first, kept. */
export function withEmails(snap: PolicySnapshot, emails: string[]): RawPolicy {
  const body: RawPolicy = {};
  for (const [k, v] of Object.entries(snap.raw)) if (!READ_ONLY.includes(k)) body[k] = v;
  body.include = [...snap.otherRules, ...emails.map((email) => ({ email: { email } }))];
  return body;
}

/**
 * A minimal Cloudflare Access client for one application and one policy (#36, FR-15.2): read the application, read
 * and replace the policy, revoke one user's Access sessions. Bearer token in the `Authorization` header only — never
 * in a URL, a log line or an error. Fixed base URL (`CLOUDFLARE_API`; tests pass a loopback mock), no redirects, a
 * time limit per call and a size limit on the answer.
 */
export class CloudflareAccessClient {
  private readonly base: string;
  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;

  constructor(
    private readonly token: string,
    opts: { base?: string; fetch?: FetchLike; timeoutMs?: number } = {},
  ) {
    this.base = (opts.base ?? CLOUDFLARE_API).replace(/\/+$/, "");
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private async call(method: "GET" | "PUT" | "POST", path: string, body?: unknown): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetch(`${this.base}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new CloudflareError("cf_unavailable", null);
    }
    if (res.status === 429) {
      await res.body?.cancel().catch(() => {});
      throw new CloudflareError("cf_rate_limited", 429, retryAfter(res.headers.get("retry-after")));
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel().catch(() => {});
      throw new CloudflareError("cf_unauthorized", res.status);
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      throw new CloudflareError("cf_not_found", 404);
    }
    if (res.status >= 500) {
      await res.body?.cancel().catch(() => {});
      throw new CloudflareError("cf_unavailable", res.status);
    }
    const text = await readLimited(res);
    let json: { success?: unknown; result?: unknown };
    try {
      json = JSON.parse(text) as typeof json;
    } catch {
      throw new CloudflareError("cf_bad_response", res.status);
    }
    if (!res.ok || json.success !== true) throw new CloudflareError("cf_bad_response", res.status);
    return json.result;
  }

  private static path(t: Pick<AccessTarget, "accountId">, rest: string) {
    if (!validId(t.accountId)) throw new CloudflareError("cf_not_found", null);
    return `/accounts/${t.accountId}/access${rest}`;
  }

  private policyPath(t: AccessTarget) {
    if (!validId(t.appId) || !validId(t.policyId)) throw new CloudflareError("cf_not_found", null);
    return CloudflareAccessClient.path(
      t,
      t.scope === "reusable" ? `/policies/${t.policyId}` : `/apps/${t.appId}/policies/${t.policyId}`,
    );
  }

  /** The application (`name`, `aud`, and the ids of its policies when the answer lists them). */
  async app(
    t: Pick<AccessTarget, "accountId" | "appId">,
  ): Promise<{ name: string | null; aud: string | null; policyIds: string[] | null }> {
    if (!validId(t.appId)) throw new CloudflareError("cf_not_found", null);
    const r = await this.call("GET", CloudflareAccessClient.path(t, `/apps/${t.appId}`));
    if (!r || typeof r !== "object") throw new CloudflareError("cf_bad_response", null);
    const o = r as { name?: unknown; aud?: unknown; policies?: unknown };
    return {
      name: typeof o.name === "string" ? o.name : null,
      aud: typeof o.aud === "string" ? o.aud : null,
      policyIds: Array.isArray(o.policies)
        ? o.policies.flatMap((p) =>
            p && typeof p === "object" && typeof (p as { id?: unknown }).id === "string"
              ? [(p as { id: string }).id]
              : [],
          )
        : null,
    };
  }

  /**
   * Finds the policy and where it is written: first as the application's own policy (its answer's `reusable` says
   * whether it is in fact a reusable one), then as a reusable policy.
   */
  async locatePolicy(t: Omit<AccessTarget, "scope">): Promise<{ scope: PolicyScope; snap: PolicySnapshot }> {
    try {
      const snap = await this.policy({ ...t, scope: "app" });
      return { scope: snap.reusable ? "reusable" : "app", snap };
    } catch (e) {
      if (!(e instanceof CloudflareError) || e.code !== "cf_not_found") throw e;
    }
    return { scope: "reusable", snap: await this.policy({ ...t, scope: "reusable" }) };
  }

  async policy(t: AccessTarget): Promise<PolicySnapshot> {
    const r = await this.call("GET", this.policyPath(t));
    if (!r || typeof r !== "object" || Array.isArray(r)) throw new CloudflareError("cf_bad_response", null);
    return snapshot(r as RawPolicy);
  }

  /** Replaces the policy with `body` (the full policy — Cloudflare's PUT is not a patch). */
  async putPolicy(t: AccessTarget, body: RawPolicy): Promise<PolicySnapshot> {
    const r = await this.call("PUT", this.policyPath(t), body);
    if (!r || typeof r !== "object" || Array.isArray(r)) throw new CloudflareError("cf_bad_response", null);
    return snapshot(r as RawPolicy);
  }

  /**
   * Ends the Access sessions of one email (`POST …/access/organizations/revoke_user`). That needs the
   * "Access: Organizations, Identity Providers, and Groups" edit permission, which the minimal token does not have:
   * then `unavailable`, and the screen shows the delay (the Access session lasts until it expires).
   */
  async revokeUser(
    t: Pick<AccessTarget, "accountId">,
    email: string,
  ): Promise<"revoked" | "unavailable" | "failed"> {
    try {
      await this.call("POST", CloudflareAccessClient.path(t, "/organizations/revoke_user"), { email });
      return "revoked";
    } catch (e) {
      if (e instanceof CloudflareError && (e.code === "cf_unauthorized" || e.code === "cf_not_found"))
        return "unavailable";
      return "failed";
    }
  }
}

/**
 * The answer's body as text, at most `MAX_BODY` bytes: counted while it streams, and the stream is cancelled as soon
 * as it goes over (an oversized answer is never read to its end). Over the limit → `cf_bad_response`.
 */
async function readLimited(res: Response): Promise<string> {
  if (!res.body) return "";
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY) {
    await res.body.cancel().catch(() => {});
    throw new CloudflareError("cf_bad_response", res.status);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY) {
        await reader.cancel().catch(() => {});
        throw new CloudflareError("cf_bad_response", res.status);
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof CloudflareError) throw e;
    throw new CloudflareError("cf_unavailable", res.status);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** `Retry-After` in ms (seconds or an HTTP date), bounded to [1 s, 5 min]; 30 s when absent or unreadable. */
export function retryAfter(v: string | null, now = Date.now()): number {
  let ms = 30_000;
  if (v && /^\d+$/.test(v.trim())) ms = Number(v.trim()) * 1000;
  else if (v) {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) ms = t - now;
  }
  return Math.min(Math.max(ms, 1000), 5 * 60_000);
}
