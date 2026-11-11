import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  DEFAULT_PERMISSIONS,
  type Connection,
  type ConnectionAuthType,
  type ConnectionScope,
  type ConnectionStatus,
  type RuntimeId,
  type RuntimePolicy,
} from "@agentlee/shared";
import type { UserRow } from "../auth/users.js";
import { decrypt, encrypt, mask } from "../crypto/secrets.js";
import type { Db } from "../db/client.js";
import { connections, runtimePolicies, runtimeSessions, users } from "../db/schema.js";

export type ConnectionRow = typeof connections.$inferSelect;

/**
 * A rule the request broke. `status` 400 = the request itself is wrong (e.g. a shared subscription), 403 = the
 * caller may not do it (e.g. a Claude subscription on a member's account).
 */
export class ConnectionRuleError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code: string,
  ) {
    super(code);
  }
}

/** Provider formats of each credential. A value that does not look like one is refused (400 `invalid_secret`). */
const SECRET_FORMAT: Record<RuntimeId, Partial<Record<ConnectionAuthType, RegExp>>> = {
  // Anthropic API key; the Claude subscription's long-lived token from `claude setup-token`.
  "claude-code": { api_key: /^sk-ant-[A-Za-z0-9_-]{20,}$/, subscription: /^[A-Za-z0-9_.-]{20,}$/ },
  // OpenAI API key. Each member's own ChatGPT login (device code in the web screen) comes with #18.
  codex: { api_key: /^sk-[A-Za-z0-9_-]{20,}$/ },
};

export const RUNTIME_LABEL: Record<RuntimeId, string> = { "claude-code": "Claude Code", codex: "Codex" };

const AUTH_LABEL: Record<ConnectionAuthType, string> = { api_key: "API 키", subscription: "구독" };

/** AAD of a stored credential: a ciphertext copied to another row, runtime or auth type does not decrypt. */
const aad = (c: Pick<ConnectionRow, "id" | "runtime" | "authType">) =>
  `connection:${c.id}:${c.runtime}:${c.authType}`;

/** Connection ids are server-generated UUIDs; anything else is never used as a folder name. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type EffectivePolicy = Omit<RuntimePolicy, "runtime">;

export function toConnection(c: ConnectionRow): Connection {
  return {
    id: c.id,
    runtime: c.runtime as RuntimeId,
    authType: c.authType,
    scope: c.scope,
    ownerId: c.ownerId ?? null,
    label: c.label,
    hint: c.hint ?? null,
    status: c.status,
    lastTestAt: c.lastTestAt ?? null,
    lastTestCode: c.lastTestCode ?? null,
    // `env-import`: brought over from `.env` (connections/import.ts), not registered by someone else.
    registeredByAdmin:
      c.scope === "personal" && !!c.createdBy && c.createdBy !== c.ownerId && c.createdBy !== "env-import",
    createdAt: c.createdAt,
  };
}

/** What an adapter gets for a run: the connection's own folder for this user, and the decrypted credential. */
export type ResolvedConnection = {
  id: string;
  dir: string;
  authType: ConnectionAuthType;
  secret: string;
};

/**
 * Runtime connections and per-user runtime policies (#17). The only place credentials are encrypted and decrypted;
 * nothing here ever returns a credential except `resolve`, which only adapters call when a run starts.
 */
export class ConnectionStore {
  private readonly now: () => number;
  constructor(
    private readonly db: Db,
    private readonly masterKey: Buffer,
    private readonly dataDir: string,
    opts: { now?: () => number } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  /** Runs `fn` in one immediate transaction of this database (rolled back if it throws). */
  transaction<T>(fn: () => T): T {
    return this.db.$client.transaction(fn).immediate();
  }

  // ---- reading ----

  get(id: string): ConnectionRow | undefined {
    return this.db.select().from(connections).where(eq(connections.id, id)).get();
  }

  /** A user's personal connections that are still connected. */
  personal(ownerId: string): ConnectionRow[] {
    return this.db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.scope, "personal"),
          eq(connections.ownerId, ownerId),
          isNull(connections.disconnectedAt),
        ),
      )
      .orderBy(asc(connections.createdAt))
      .all();
  }

  /** Family shared connections that are still connected. */
  shared(): ConnectionRow[] {
    return this.db
      .select()
      .from(connections)
      .where(and(eq(connections.scope, "shared"), isNull(connections.disconnectedAt)))
      .orderBy(asc(connections.createdAt))
      .all();
  }

  // ---- writing ----

  /**
   * Registers a connection. Rules (PRD D2, FR-11.1/11.4), checked here so that every route goes through them:
   * - shared connections take API keys only (400 `shared_subscription`);
   * - a Claude subscription only on an admin's own account (403 `subscription_not_allowed`);
   * - a Codex subscription (ChatGPT login) is not available yet (#18, 400 `unsupported_auth`);
   * - the credential must look like the provider's (400 `invalid_secret`).
   */
  create(input: {
    runtime: RuntimeId;
    authType: ConnectionAuthType;
    scope: ConnectionScope;
    owner: Pick<UserRow, "id" | "role" | "active"> | null;
    createdBy: string;
    label?: string | undefined;
    secret: string;
  }): ConnectionRow {
    if (input.scope === "shared" && input.authType !== "api_key")
      throw new ConnectionRuleError(400, "shared_subscription");
    if (input.scope === "personal" && !input.owner?.active) throw new ConnectionRuleError(404, "not_found");
    if (input.scope === "shared" && input.owner) throw new ConnectionRuleError(400, "invalid_request");
    if (input.authType === "subscription" && input.runtime === "claude-code" && input.owner?.role !== "admin")
      throw new ConnectionRuleError(403, "subscription_not_allowed");
    const format = SECRET_FORMAT[input.runtime][input.authType];
    if (!format) throw new ConnectionRuleError(400, "unsupported_auth");
    const secret = input.secret.trim();
    if (!format.test(secret)) throw new ConnectionRuleError(400, "invalid_secret");
    const t = this.now();
    const id = crypto.randomUUID();
    const row: ConnectionRow = {
      id,
      runtime: input.runtime,
      authType: input.authType,
      scope: input.scope,
      ownerId: input.owner?.id ?? null,
      createdBy: input.createdBy,
      label:
        input.label ??
        `${RUNTIME_LABEL[input.runtime]} ${AUTH_LABEL[input.authType]}${input.scope === "shared" ? " (공용)" : ""}`,
      secret: encrypt(secret, this.masterKey, aad({ id, runtime: input.runtime, authType: input.authType })),
      credentialVersion: 1,
      hint: mask(secret),
      status: "untested",
      lastTestAt: null,
      lastTestCode: null,
      disconnectedAt: null,
      createdAt: t,
      updatedAt: t,
    };
    this.db.insert(connections).values(row).run();
    return row;
  }

  /** New label and/or credential. A new credential must be tested again before it is used. */
  update(id: string, patch: { label?: string | undefined; secret?: string | undefined }): ConnectionRow {
    const c = this.get(id);
    if (!c || c.disconnectedAt !== null) throw new ConnectionRuleError(404, "not_found");
    const set: Partial<ConnectionRow> = { updatedAt: this.now() };
    if (patch.label !== undefined) set.label = patch.label;
    if (patch.secret !== undefined) {
      const secret = patch.secret.trim();
      const format = SECRET_FORMAT[c.runtime as RuntimeId]?.[c.authType];
      if (!format?.test(secret)) throw new ConnectionRuleError(400, "invalid_secret");
      set.secret = encrypt(secret, this.masterKey, aad(c));
      set.credentialVersion = c.credentialVersion + 1;
      set.hint = mask(secret);
      set.status = "untested";
      set.lastTestAt = null;
      set.lastTestCode = null;
    }
    this.db.update(connections).set(set).where(eq(connections.id, id)).run();
    return this.get(id)!;
  }

  /**
   * Disconnects (FR-11.9): the row stays (messages and runs refer to it), the credential is wiped, every runtime
   * session made with it is invalidated — never resumed again — and its runtime folders are removed.
   * Returns false when it was already disconnected.
   */
  disconnect(id: string): boolean {
    const c = this.get(id);
    if (!c || c.disconnectedAt !== null) return false;
    const t = this.now();
    this.db.$client
      .transaction(() => {
        this.db
          .update(connections)
          .set({ secret: null, disconnectedAt: t, updatedAt: t })
          .where(eq(connections.id, id))
          .run();
        this.db
          .update(runtimeSessions)
          .set({ invalidated: true, updatedAt: t })
          .where(eq(runtimeSessions.connectionId, id))
          .run();
      })
      .immediate();
    return true;
  }

  /** Removes the connection's runtime folders (sessions, caches). Best effort: a running CLI may still hold them. */
  removeFolders(id: string): void {
    if (!SAFE_ID.test(id)) return;
    try {
      fs.rmSync(path.join(this.dataDir, "runtimes", id), { recursive: true, force: true });
    } catch {
      // still in use: the sessions are invalidated anyway, and the folder is never used again
    }
  }

  /**
   * Records a test outcome — only for the credential version that was tested: a key replaced or a connection
   * disconnected meanwhile keeps its own state.
   */
  setTestResult(
    id: string,
    status: Extract<ConnectionStatus, "passed" | "failed">,
    code: string,
    testedVersion: number,
  ): boolean {
    const t = this.now();
    return (
      this.db
        .update(connections)
        .set({ status, lastTestAt: t, lastTestCode: code, updatedAt: t })
        .where(
          and(
            eq(connections.id, id),
            eq(connections.credentialVersion, testedVersion),
            isNull(connections.disconnectedAt),
          ),
        )
        .run().changes > 0
    );
  }

  /**
   * The provider refused the credential during a run: `expired` — only when the refused version (`version`, the one
   * the run was bound to) is still the current one, so an old key's failure never expires its replacement. True
   * only for the first report (passed → expired).
   */
  markExpired(id: string, version: number): boolean {
    const t = this.now();
    return (
      this.db
        .update(connections)
        .set({ status: "expired", lastTestCode: "runtime_auth", updatedAt: t })
        .where(
          and(
            eq(connections.id, id),
            eq(connections.credentialVersion, version),
            eq(connections.status, "passed"),
            isNull(connections.disconnectedAt),
          ),
        )
        .run().changes > 0
    );
  }

  // ---- policies ----

  /** What `user` may use of `runtime`: their policy row, or their `permissions` with everything else allowed. */
  policy(user: Pick<UserRow, "id" | "permissions">, runtime: RuntimeId): EffectivePolicy {
    const row = this.db
      .select()
      .from(runtimePolicies)
      .where(and(eq(runtimePolicies.userId, user.id), eq(runtimePolicies.runtime, runtime)))
      .get();
    if (row)
      return {
        allowed: row.allowed,
        models: row.models,
        efforts: row.efforts,
        allowPersonal: row.allowPersonal,
        allowShared: row.allowShared,
      };
    const p = user.permissions ?? DEFAULT_PERMISSIONS;
    return {
      allowed: p.runtimes.includes(runtime),
      models: p.models,
      efforts: "all",
      allowPersonal: true,
      allowShared: true,
    };
  }

  setPolicy(userId: string, p: RuntimePolicy): void {
    const values = {
      allowed: p.allowed,
      models: p.models,
      efforts: p.efforts,
      allowPersonal: p.allowPersonal,
      allowShared: p.allowShared,
      updatedAt: this.now(),
    };
    this.db
      .insert(runtimePolicies)
      .values({ userId, runtime: p.runtime, ...values })
      .onConflictDoUpdate({ target: [runtimePolicies.userId, runtimePolicies.runtime], set: values })
      .run();
  }

  // ---- who may use what ----

  /**
   * Whether `user` may run with `c`: connected, the right runtime, `passed`, allowed by the user's policy, and either
   * their own personal connection or a shared one. The single rule for the picker, the run check, the connection
   * test and the adapters' resolver. A test differs in one point only: the connection need not be `passed` yet.
   */
  usable(
    c: ConnectionRow,
    user: Pick<UserRow, "id" | "active" | "permissions">,
    runtime: RuntimeId,
    opts: { test?: boolean } = {},
  ): boolean {
    if (!user.active || c.disconnectedAt !== null || c.secret === null || c.runtime !== runtime) return false;
    if (!opts.test && c.status !== "passed") return false;
    const policy = this.policy(user, runtime);
    if (!policy.allowed) return false;
    if (c.scope === "personal") return c.ownerId === user.id && policy.allowPersonal;
    return policy.allowShared;
  }

  /** Connections `user` may pick for `runtime`: personal ones first (FR-11.3), then shared ones. */
  usableFor(user: Pick<UserRow, "id" | "active" | "permissions">, runtime: RuntimeId): ConnectionRow[] {
    return [...this.personal(user.id), ...this.shared()].filter((c) => this.usable(c, user, runtime));
  }

  /**
   * The credential and folder for a run. Checks `usable` again (the connection may have been disconnected, have
   * expired or the policy changed since the run was accepted). The folder is per connection *and* user.
   */
  resolve(
    connectionId: string | undefined,
    user: Pick<UserRow, "id" | "active" | "permissions"> | undefined,
    runtime: RuntimeId,
    opts: { test?: boolean; version?: number | undefined } = {},
  ): ResolvedConnection | undefined {
    if (!connectionId || !user || !SAFE_ID.test(connectionId) || !SAFE_ID.test(user.id)) return undefined;
    const c = this.get(connectionId);
    if (!c?.secret || !this.usable(c, user, runtime, opts)) return undefined;
    // Bound to the version the run or test was accepted with: a replaced key is never used for it.
    if (opts.version !== undefined && c.credentialVersion !== opts.version) return undefined;
    return {
      id: c.id,
      dir: path.join(this.dataDir, "runtimes", c.id, user.id),
      authType: c.authType,
      secret: decrypt(c.secret, this.masterKey, aad(c)),
    };
  }

  /** Active admins (recipients of shared-connection warnings). */
  admins(): string[] {
    return this.db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.role, "admin"), eq(users.active, true)))
      .all()
      .map((u) => u.id);
  }
}
