import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A loopback stand-in for the Cloudflare API (#36) — the Access endpoints the sync uses, nothing else. Tests never
 * reach the real Cloudflare API. Synthetic ids and token only.
 */
export type MockFailure = {
  method?: "GET" | "PUT" | "POST";
  status: number;
  retryAfter?: string;
  /** PUT only: apply the write, then answer with `status` (the answer is "lost"). */
  applyFirst?: boolean;
};

export type MockPolicy = Record<string, unknown> & { include: unknown[] };

export class CloudflareMock {
  readonly accountId = "acc0123456789abcdef";
  readonly appId = "app-0123-4567";
  readonly policyId = "pol-89ab-cdef";
  aud = "a".repeat(64);
  token: string;
  /** Where the policy really lives. */
  reusable = true;
  /** The token may revoke Access sessions (it holds the Organizations permission). */
  allowRevoke = false;
  policy: MockPolicy;
  failures: MockFailure[] = [];
  readonly calls: { method: string; path: string; authorized: boolean }[] = [];
  readonly revoked: string[] = [];
  private server: http.Server | undefined;
  url = "";
  private seq = 0;

  constructor(token: string, emails: string[] = []) {
    this.token = token;
    this.policy = {
      id: this.policyId,
      name: "가족만",
      decision: "allow",
      include: [{ group: { id: "grp-1" } }, ...emails.map((email) => ({ email: { email } }))],
      exclude: [],
      require: [],
      session_duration: "24h",
      reusable: true,
      created_at: "2026-11-15T00:00:00Z",
      updated_at: "2026-11-15T00:00:00Z",
    };
  }

  /** The policy's email rules, as Cloudflare holds them. */
  emails(): string[] {
    return this.policy.include.flatMap((r) => {
      const e = (r as { email?: { email?: string } }).email?.email;
      return e ? [e] : [];
    });
  }

  /** Someone edits the policy in the dashboard. */
  dashboardEdit(emails: string[]): void {
    this.policy = {
      ...this.policy,
      include: [{ group: { id: "grp-1" } }, ...emails.map((email) => ({ email: { email } }))],
      updated_at: `2026-11-16T00:00:${String(++this.seq).padStart(2, "0")}Z`,
    };
  }

  private gate: { method: string; re: RegExp; started: () => void; release: Promise<void> } | undefined;

  /** Holds the next matching request before it is answered (for races): `started` resolves when it arrives. */
  pause(method: string, re: RegExp = /./): { started: Promise<void>; release: () => void } {
    let started!: () => void;
    let release!: () => void;
    const s = new Promise<void>((r) => (started = r));
    const r = new Promise<void>((x) => (release = x));
    this.gate = { method, re, started, release: r };
    return { started: s, release };
  }

  count(method: string, re: RegExp): number {
    return this.calls.filter((c) => c.method === method && re.test(c.path)).length;
  }

  async start(): Promise<this> {
    this.server = http.createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/client/v4`;
    return this;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown) : undefined;
    const method = req.method ?? "GET";
    const path = (req.url ?? "").replace(/^\/client\/v4/, "");
    const authorized = req.headers.authorization === `Bearer ${this.token}`;
    this.calls.push({ method, path, authorized });
    const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };
    const error = (status: number, headers: Record<string, string> = {}) =>
      json(
        status,
        { success: false, errors: [{ code: 10000, message: "mock error" }], result: null },
        headers,
      );
    if (!authorized) return error(403);
    const g = this.gate;
    if (g && g.method === method && g.re.test(path)) {
      this.gate = undefined;
      g.started();
      await g.release;
    }
    const i = this.failures.findIndex((f) => !f.method || f.method === method);
    const failure = i >= 0 ? this.failures.splice(i, 1)[0] : undefined;
    if (failure && !failure.applyFirst)
      return error(failure.status, failure.retryAfter ? { "retry-after": failure.retryAfter } : {});

    const base = `/accounts/${this.accountId}/access`;
    const ok = (result: unknown) => json(200, { success: true, errors: [], messages: [], result });
    if (method === "GET" && path === `${base}/apps/${this.appId}`)
      return ok({ id: this.appId, name: "Agent Lee", aud: this.aud, policies: [{ id: this.policyId }] });
    const appPolicy = path === `${base}/apps/${this.appId}/policies/${this.policyId}`;
    const reusablePolicy = path === `${base}/policies/${this.policyId}`;
    if (appPolicy || reusablePolicy) {
      if (reusablePolicy && !this.reusable) return error(404);
      if (method === "GET") return ok({ ...this.policy, reusable: this.reusable });
      if (method === "PUT") {
        // A reusable policy is written through its own path only (as Cloudflare does).
        if (appPolicy && this.reusable) return error(400);
        const b = body as Record<string, unknown>;
        for (const k of ["id", "created_at", "updated_at", "reusable"]) if (k in b) return error(400);
        this.policy = {
          ...(b as MockPolicy),
          id: this.policyId,
          reusable: this.reusable,
          created_at: this.policy.created_at,
          updated_at: `2026-11-16T01:00:${String(++this.seq).padStart(2, "0")}Z`,
        };
        if (failure) return error(failure.status);
        return ok(this.policy);
      }
    }
    if (method === "POST" && path === `${base}/organizations/revoke_user`) {
      if (!this.allowRevoke) return error(403);
      this.revoked.push((body as { email: string }).email);
      return ok(true);
    }
    return error(404);
  }
}
