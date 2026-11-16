import crypto from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import type {
  AccessOverview,
  AccessPreview,
  AccessPreviewChange,
  AccessRegisterRequest,
  AccessRegistration,
  AccessSync,
  AdminEmailChange,
  AppAccessEmail,
} from "@agentlee/shared";
import { mask } from "../crypto/secrets.js";
import type { Db } from "../db/client.js";
import { accessSyncs, adminEmailChanges, sessions, users } from "../db/schema.js";
import type { SettingsStore } from "../db/settings-store.js";
import type { AppEvents } from "../events.js";
import { normalizeEmail, type UserRow, type UserStore } from "../auth/users.js";
import {
  CloudflareAccessClient,
  CloudflareError,
  withEmails,
  type AccessTarget,
  type FetchLike,
  type PolicySnapshot,
} from "./cloudflare.js";

const CONFIG_KEY = "access.sync.config";
const TOKEN_KEY = "access.sync.token";
const OPEN = ["pending", "applying", "failed"] as const;
const OPEN_CHANGE = ["pending", "added", "switched"] as const;
/** A rate-limited write is retried by the server itself this many times; after that only by the admin. */
const AUTO_RETRIES = 3;

type SyncRow = typeof accessSyncs.$inferSelect;
type ChangeRow = typeof adminEmailChanges.$inferSelect;
type StoredConfig = Omit<AccessRegistration, "tokenMasked"> & { tokenLast4: string };

/** A refusal with its HTTP status and fixed code (ACCESS_ERRORS). */
export class AccessSyncError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export type AccessSyncOptions = {
  /** Cloudflare API base (tests: a loopback mock server). Default: https://api.cloudflare.com/client/v4. */
  apiBase?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => number;
  /** Tests: the wait before an automatic retry of a rate-limited write (default: `Retry-After`). */
  retryDelay?: (retryAfterMs: number) => number;
};

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();
const sameSet = (a: string[], b: string[]) => {
  const x = sorted(a);
  const y = sorted(b);
  return x.length === y.length && x.every((v, i) => v === y[i]);
};
const minus = (a: string[], b: string[]) => sorted(a.filter((x) => !b.includes(x)));

/**
 * Cloudflare Access sync (#36, PRD FR-15.2–15.7). The app's active users (and the admin's new email during a change)
 * are the wanted include-email list of one registered policy; every write is previewed (live list + revision → final
 * list and real delta), confirmed on the same revision, recorded (`access_syncs`) and retried idempotently — a retry
 * first reads the live list, so a write that did land is never repeated. Without a token: manual mode (the list and
 * the steps; the admin marks it done).
 */
export class AccessSyncService {
  private readonly now: () => number;
  private chain: Promise<unknown> = Promise.resolve();
  private retryTimer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(
    private readonly db: Db,
    private readonly userStore: UserStore,
    private readonly settings: SettingsStore,
    private readonly events: AppEvents,
    private readonly opts: AccessSyncOptions & { aud?: string | undefined } = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  // ---------------------------------------------------------------- registration

  private storedConfig(): StoredConfig | null {
    const raw = this.settings.get(CONFIG_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as StoredConfig;
    } catch {
      return null;
    }
  }

  registration(): AccessRegistration | null {
    const c = this.storedConfig();
    if (!c || this.settings.get(TOKEN_KEY) === undefined) return null;
    const { tokenLast4, ...rest } = c;
    return { ...rest, tokenMasked: mask(`xxxx${tokenLast4}`) };
  }

  private connection(): { client: CloudflareAccessClient; target: AccessTarget } | null {
    const c = this.storedConfig();
    const token = c ? this.settings.get(TOKEN_KEY) : undefined;
    if (!c || !token) return null;
    return {
      client: this.client(token),
      target: { accountId: c.accountId, appId: c.appId, policyId: c.policyId, scope: c.scope },
    };
  }

  private client(token: string) {
    return new CloudflareAccessClient(token, {
      ...(this.opts.apiBase ? { base: this.opts.apiBase } : {}),
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
      ...(this.opts.timeoutMs ? { timeoutMs: this.opts.timeoutMs } : {}),
    });
  }

  /**
   * Registers (or replaces) the token and the application/policy (FR-15.2, 15.6): checked against Cloudflare first —
   * the application exists (and its AUD is this server's `CF_ACCESS_AUD`, when set), the policy is an Allow policy of
   * it — then stored: the token encrypted (only its last 4 characters are ever shown), the ids in plain settings.
   */
  async register(input: AccessRegisterRequest): Promise<AccessRegistration> {
    const token = input.token ?? this.settings.get(TOKEN_KEY);
    if (!token) throw new AccessSyncError(400, "access_token_required");
    const client = this.client(token);
    const ids = { accountId: input.accountId, appId: input.appId, policyId: input.policyId };
    try {
      const app = await client.app(ids);
      if (this.opts.aud && app.aud && app.aud !== this.opts.aud)
        throw new AccessSyncError(409, "access_app_mismatch");
      if (app.policyIds && !app.policyIds.includes(input.policyId))
        throw new AccessSyncError(409, "access_policy_not_in_app");
      const { scope, snap } = await client.locatePolicy(ids);
      if (snap.decision !== null && snap.decision !== "allow")
        throw new AccessSyncError(409, "access_policy_not_allow");
      const stored: StoredConfig = {
        ...ids,
        scope,
        appName: app.name,
        policyName: snap.name,
        registeredAt: this.now(),
        tokenLast4: token.slice(-4),
      };
      this.settings.setSecret(TOKEN_KEY, token);
      this.settings.set(CONFIG_KEY, JSON.stringify(stored));
      return this.registration()!;
    } catch (e) {
      if (e instanceof CloudflareError) throw new AccessSyncError(502, e.code);
      throw e;
    }
  }

  /** Back to manual mode: the token is deleted (the ids too). */
  unregister(): void {
    this.db.$client.prepare("DELETE FROM settings WHERE key IN (?, ?)").run(CONFIG_KEY, TOKEN_KEY);
  }

  // ---------------------------------------------------------------- the wanted list

  private openChange(): ChangeRow | undefined {
    return this.db
      .select()
      .from(adminEmailChanges)
      .where(inArray(adminEmailChanges.state, [...OPEN_CHANGE]))
      .orderBy(desc(adminEmailChanges.createdAt))
      .get();
  }

  /** The emails the app wants in the policy: active accounts, and the admin's new email while it is being added. */
  appEmails(): AppAccessEmail[] {
    const out = new Map<string, AppAccessEmail>();
    for (const u of this.userStore.list())
      if (u.active) out.set(u.email, { email: u.email, name: u.name, role: u.role, source: "user" });
    const ch = this.openChange();
    if (ch && (ch.state === "pending" || ch.state === "added") && !out.has(ch.newEmail)) {
      const u = this.userStore.byId(ch.userId);
      out.set(ch.newEmail, {
        email: ch.newEmail,
        name: u?.name ?? "",
        role: "admin",
        source: "admin_email_change",
      });
    }
    return [...out.values()].sort((a, b) => a.email.localeCompare(b.email));
  }

  private wanted(): string[] {
    return sorted(this.appEmails().map((e) => e.email));
  }

  private activeAdminEmails(): string[] {
    return this.userStore
      .list()
      .filter((u) => u.active && u.role === "admin")
      .map((u) => u.email);
  }

  /** FR-15.2: a final list without a current (active) admin's email is refused — the admin would lock themselves out. */
  private protect(final: string[], admins = this.activeAdminEmails()): void {
    if (admins.some((e) => !final.includes(e))) throw new AccessSyncError(409, "admin_email_protected");
  }

  /** The wanted list after `change` would be saved (it is not saved here). */
  private wantedAfter(change: AccessPreviewChange | undefined): { emails: string[]; admins: string[] } {
    const base = this.wanted();
    let admins = this.activeAdminEmails();
    if (!change) return { emails: base, admins };
    if (change.kind === "create") {
      const taken = this.userStore.byEmail(change.email) || this.reserved(change.email);
      if (taken) throw new AccessSyncError(409, "email_taken");
      return { emails: sorted([...base, change.email]), admins };
    }
    const u = this.userStore.byId(change.userId);
    if (!u || !u.active) throw new AccessSyncError(404, "not_found");
    if (change.kind === "update") {
      const email = normalizeEmail(change.email);
      if (email === u.email) return { emails: base, admins };
      // An admin's email leaves the list only through the FR-15.7 procedure.
      if (u.role === "admin") throw new AccessSyncError(409, "admin_email_protected");
      const other = this.userStore.byEmail(email);
      if ((other && other.id !== u.id) || this.reserved(email)) throw new AccessSyncError(409, "email_taken");
      return { emails: sorted([...base.filter((e) => e !== u.email), email]), admins };
    }
    // deactivate: a deactivated admin is no longer a current one — unless it is the last one (the user routes refuse
    // that deactivation too: `last_admin` / `cannot_change_self`).
    if (admins.some((e) => e !== u.email)) admins = admins.filter((e) => e !== u.email);
    return { emails: base.filter((e) => e !== u.email), admins };
  }

  /** An email held by an open admin email change (not usable for another account meanwhile). */
  reserved(email: string): boolean {
    const ch = this.openChange();
    return !!ch && ch.newEmail === normalizeEmail(email);
  }

  // ---------------------------------------------------------------- sync rows

  private toSync(r: SyncRow): AccessSync {
    return {
      id: r.id,
      status: r.status,
      reasons: r.reasons,
      mode: r.mode ?? null,
      added: r.added ?? [],
      removed: r.removed ?? [],
      errorCode: r.errorCode ?? null,
      attempts: r.attempts,
      retryAt: r.retryAt ?? null,
      revokes: (r.revokes ?? []) as AccessSync["revokes"],
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      appliedAt: r.appliedAt ?? null,
    };
  }

  private openRow(): SyncRow | undefined {
    return this.db
      .select()
      .from(accessSyncs)
      .where(inArray(accessSyncs.status, [...OPEN]))
      .orderBy(desc(accessSyncs.createdAt))
      .get();
  }

  private lastApplied(): SyncRow | undefined {
    return this.db
      .select()
      .from(accessSyncs)
      .where(eq(accessSyncs.status, "applied"))
      .orderBy(desc(accessSyncs.appliedAt))
      .get();
  }

  private update(id: string, patch: Partial<SyncRow>): SyncRow {
    this.db
      .update(accessSyncs)
      .set({ ...patch, updatedAt: this.now() })
      .where(eq(accessSyncs.id, id))
      .run();
    return this.db.select().from(accessSyncs).where(eq(accessSyncs.id, id)).get()!;
  }

  /**
   * The app's users changed in a way the Access list must follow (`reason`: user_created, email_changed,
   * deactivated, admin_email_requested, admin_email_cancelled, admin_email_switched): the open sync records it, or a
   * new `pending` one is opened. Synchronous, so it can run inside the transaction of the change itself.
   */
  changed(reason: string): void {
    const open = this.openRow();
    if (open) {
      if (!open.reasons.includes(reason)) this.update(open.id, { reasons: [...open.reasons, reason] });
      return;
    }
    const t = this.now();
    this.db
      .insert(accessSyncs)
      .values({
        id: crypto.randomUUID(),
        status: "pending",
        reasons: [reason],
        attempts: 0,
        createdAt: t,
        updatedAt: t,
      })
      .run();
  }

  private ensureOpen(reason: string): SyncRow {
    if (!this.openRow()) this.changed(reason);
    return this.openRow()!;
  }

  overview(): AccessOverview {
    const reg = this.registration();
    const open = this.openRow();
    const last = this.lastApplied();
    const ch = this.openChange() ?? this.latestChange();
    return {
      mode: reg ? "auto" : "manual",
      registration: reg,
      appEmails: this.appEmails(),
      open: open ? this.toSync(open) : null,
      lastApplied: last ? this.toSync(last) : null,
      dirty: !last || !sameSet(last.finalEmails ?? [], this.wanted()),
      adminEmailChange: ch ? this.toChange(ch) : null,
    };
  }

  // ---------------------------------------------------------------- preview / apply / retry

  /** One Cloudflare write at a time (apply, retry, the automatic retry). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  /**
   * FR-15.2 preview: the live list and its revision, the final list once `change` is saved, and the real delta — this
   * change's own part and the differences already there (drift). Refuses a change that drops a current admin email.
   */
  async preview(change?: AccessPreviewChange): Promise<AccessPreview> {
    const { emails: final, admins } = this.wantedAfter(change);
    this.protect(final, admins);
    const base = this.wanted();
    const own = { add: minus(final, base), remove: minus(base, final) };
    const conn = this.connection();
    if (!conn)
      return {
        mode: "manual",
        revision: null,
        policyName: null,
        accessEmails: null,
        otherRules: 0,
        final,
        add: own.add,
        remove: own.remove,
        change: own,
        drift: null,
      };
    let live: PolicySnapshot;
    try {
      live = await conn.client.policy(conn.target);
    } catch (e) {
      if (e instanceof CloudflareError) throw new AccessSyncError(502, e.code);
      throw e;
    }
    return {
      mode: "auto",
      revision: live.revision,
      policyName: live.name,
      accessEmails: sorted(live.emails),
      otherRules: live.otherRules.length,
      final,
      add: minus(final, live.emails),
      remove: minus(live.emails, final),
      change: own,
      drift: { add: minus(base, live.emails), remove: minus(live.emails, base) },
    };
  }

  /**
   * The admin confirmed a preview: written only if the policy is still at `revision` and the app's list is still
   * `final` (else 409 — preview again; nothing is written and the open sync stays as it was). A Cloudflare failure
   * leaves the app's change saved and the sync `failed` ("Access에 반영 안 됨 — 다시 시도").
   */
  apply(input: { revision: string; final: string[] }): Promise<AccessSync> {
    return this.exclusive(async () => {
      const conn = this.connection();
      if (!conn) throw new AccessSyncError(409, "access_not_registered");
      const wanted = this.wanted();
      if (!sameSet(wanted, input.final)) throw new AccessSyncError(409, "access_preview_stale");
      this.protect(wanted);
      const row = this.ensureOpen("manual_sync");
      return this.toSync(await this.attempt(conn, row, wanted, input.revision, "confirm"));
    });
  }

  /** "다시 시도" (and the automatic retry of a rate-limited write): the open sync, on the revision it was confirmed on. */
  retry(auto = false): Promise<AccessSync> {
    return this.exclusive(async () => {
      const conn = this.connection();
      if (!conn) throw new AccessSyncError(409, "access_not_registered");
      const row = this.openRow();
      if (!row || row.status === "pending" || !row.baseRevision || !row.finalEmails)
        throw new AccessSyncError(409, "access_nothing_to_retry");
      if (auto && (row.errorCode !== "cf_rate_limited" || row.status !== "failed")) return this.toSync(row);
      const wanted = this.wanted();
      if (!sameSet(wanted, row.finalEmails))
        return this.toSync(
          this.update(row.id, { status: "failed", errorCode: "access_preview_stale", retryAt: null }),
        );
      this.protect(wanted);
      return this.toSync(await this.attempt(conn, row, wanted, row.baseRevision, auto ? "auto" : "retry"));
    });
  }

  /**
   * One write. Reads the live policy first: already equal to `final` → applied without writing (an earlier attempt
   * that landed — its answer lost, or the process stopped right after — is recognised, never repeated); moved from
   * `revision` → a confirm is refused (409), a retry fails `access_revision_changed`; otherwise the policy is
   * written with only its email rules replaced.
   */
  private async attempt(
    conn: { client: CloudflareAccessClient; target: AccessTarget },
    row: SyncRow,
    final: string[],
    revision: string,
    trigger: "confirm" | "retry" | "auto",
  ): Promise<SyncRow> {
    const fail = (code: string, retryAfterMs: number | null = null) => {
      const attempts = row.attempts + 1;
      const retryAt =
        code === "cf_rate_limited" && retryAfterMs !== null && attempts <= AUTO_RETRIES
          ? this.now() + (this.opts.retryDelay ?? ((ms: number) => ms))(retryAfterMs)
          : null;
      const failed = this.update(row.id, {
        status: "failed",
        errorCode: code,
        attempts,
        retryAt,
        mode: "auto",
      });
      if (retryAt !== null) this.armRetry(failed);
      return failed;
    };
    let live: PolicySnapshot;
    try {
      live = await conn.client.policy(conn.target);
    } catch (e) {
      if (e instanceof CloudflareError) {
        // A confirm that could not even read the policy: the change is saved, the sync waits for a retry with the
        // revision the admin confirmed.
        this.update(row.id, { baseRevision: revision, finalEmails: final });
        return fail(e.code, e.retryAfterMs);
      }
      throw e;
    }
    const landed = sameSet(live.emails, final);
    if (!landed && live.revision !== revision) {
      if (trigger === "confirm") throw new AccessSyncError(409, "access_revision_changed");
      return this.update(row.id, {
        status: "failed",
        errorCode: "access_revision_changed",
        attempts: row.attempts + 1,
        retryAt: null,
      });
    }
    // The delta of this sync is fixed by its first real look at the live list.
    const added = landed && row.added ? row.added : minus(final, live.emails);
    const removed = landed && row.removed ? row.removed : minus(live.emails, final);
    row = this.update(row.id, {
      status: "applying",
      mode: "auto",
      baseRevision: revision,
      finalEmails: final,
      added,
      removed,
      errorCode: null,
      retryAt: null,
    });
    if (!landed) {
      try {
        // Kept emails keep their place; new ones go after them.
        const order = [
          ...live.emails.filter((e) => final.includes(e)),
          ...final.filter((e) => !live.emails.includes(e)),
        ];
        const written = await conn.client.putPolicy(conn.target, withEmails(live, order));
        if (!sameSet(written.emails, final)) return fail("cf_bad_response");
      } catch (e) {
        if (e instanceof CloudflareError) return fail(e.code, e.retryAfterMs);
        throw e;
      }
    }
    // Access sessions of removed emails (deactivated accounts, an old email): ended where the token may do it.
    const results = new Map((row.revokes ?? []).map((r) => [r.email, r.result]));
    for (const email of removed)
      if (results.get(email) !== "revoked")
        results.set(email, await conn.client.revokeUser(conn.target, email));
    const revokes = [...results].map(([email, result]) => ({ email, result }));
    const applied = this.update(row.id, {
      status: "applied",
      attempts: row.attempts + 1,
      revokes,
      appliedAt: this.now(),
    });
    this.afterApplied(final);
    return applied;
  }

  /** Manual mode (FR-15.4): the admin changed the dashboard by hand to `final` — recorded as applied. */
  manualDone(final: string[]): AccessSync {
    if (this.connection()) throw new AccessSyncError(409, "access_manual_mode");
    const wanted = this.wanted();
    if (!sameSet(wanted, final)) throw new AccessSyncError(409, "access_preview_stale");
    this.protect(wanted);
    const last = this.lastApplied();
    const before = last?.finalEmails ?? [];
    const row = this.ensureOpen("manual_sync");
    const applied = this.update(row.id, {
      status: "applied",
      mode: "manual",
      finalEmails: wanted,
      added: minus(wanted, before),
      removed: minus(before, wanted),
      errorCode: null,
      retryAt: null,
      attempts: row.attempts + 1,
      appliedAt: this.now(),
    });
    this.afterApplied(wanted);
    return this.toSync(applied);
  }

  /** The admin email change moves on once an applied list holds the new email (step 2) or no longer the old one (5). */
  private afterApplied(final: string[]): void {
    const ch = this.openChange();
    if (!ch) return;
    if (ch.state === "pending" && final.includes(ch.newEmail)) this.setChange(ch.id, "added");
    else if (ch.state === "switched" && !final.includes(ch.oldEmail)) this.setChange(ch.id, "done");
  }

  private armRetry(row: SyncRow): void {
    if (this.closed || row.retryAt === null || row.retryAt === undefined) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = undefined;
        void this.retry(true).catch(() => {});
      },
      Math.max(0, row.retryAt - this.now()),
    );
    this.retryTimer.unref();
  }

  /**
   * Start-up: a sync found `applying` was cut off mid-write — it becomes `failed` / `interrupted` (its retry reads the
   * live list first). A rate-limited one waiting for its automatic retry gets its timer back.
   */
  start(): void {
    for (const r of this.db.select().from(accessSyncs).where(eq(accessSyncs.status, "applying")).all())
      this.update(r.id, { status: "failed", errorCode: "interrupted", retryAt: null });
    const open = this.openRow();
    if (open?.status === "failed" && open.retryAt) this.armRetry(open);
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.retryTimer);
  }

  // ---------------------------------------------------------------- admin email change (FR-15.7)

  private toChange(r: ChangeRow): AdminEmailChange {
    return {
      id: r.id,
      userId: r.userId,
      oldEmail: r.oldEmail,
      newEmail: r.newEmail,
      state: r.state,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      switchedAt: r.switchedAt ?? null,
    };
  }

  private latestChange(): ChangeRow | undefined {
    return this.db.select().from(adminEmailChanges).orderBy(desc(adminEmailChanges.createdAt)).get();
  }

  private setChange(id: string, state: ChangeRow["state"], extra: Partial<ChangeRow> = {}): void {
    this.db
      .update(adminEmailChanges)
      .set({ state, updatedAt: this.now(), ...extra })
      .where(eq(adminEmailChanges.id, id))
      .run();
  }

  /** Step 1: the change is saved as pending; the admin keeps the old email for now. */
  requestAdminEmail(admin: UserRow, email: string): AdminEmailChange {
    const newEmail = normalizeEmail(email);
    return this.db.$client
      .transaction(() => {
        if (this.openChange()) throw new AccessSyncError(409, "admin_email_change_open");
        const u = this.userStore.byId(admin.id);
        if (!u || !u.active || u.role !== "admin") throw new AccessSyncError(403, "forbidden");
        if (newEmail === u.email) throw new AccessSyncError(400, "admin_email_same");
        if (this.userStore.byEmail(newEmail)) throw new AccessSyncError(409, "email_taken");
        const t = this.now();
        const row = {
          id: crypto.randomUUID(),
          userId: u.id,
          oldEmail: u.email,
          newEmail,
          state: "pending" as const,
          createdAt: t,
          updatedAt: t,
        };
        this.db.insert(adminEmailChanges).values(row).run();
        this.changed("admin_email_requested");
        return this.toChange({ ...row, switchedAt: null });
      })
      .immediate();
  }

  /** Cancel before the switch: the new email leaves the wanted list again (the next sync removes it). */
  cancelAdminEmail(admin: UserRow): AdminEmailChange {
    return this.db.$client
      .transaction(() => {
        const ch = this.openChange();
        if (!ch || ch.userId !== admin.id) throw new AccessSyncError(409, "admin_email_no_change");
        if (ch.state !== "pending" && ch.state !== "added")
          throw new AccessSyncError(409, "admin_email_step");
        this.setChange(ch.id, "cancelled");
        this.changed("admin_email_cancelled");
        return this.toChange(
          this.db.select().from(adminEmailChanges).where(eq(adminEmailChanges.id, ch.id)).get()!,
        );
      })
      .immediate();
  }

  /**
   * Step 3 check (`GET /api/access/admin-email/confirm`): this request carries the admin's existing app session and
   * an Access login with the change's new email, after the new email was added. Anything else: not ready.
   */
  confirmState(
    sessionToken: string | undefined,
    accessEmail: string | undefined,
  ): {
    change: ChangeRow;
    user: UserRow;
  } | null {
    if (!sessionToken || accessEmail === undefined) return null;
    const user = this.userStore.sessionUser(sessionToken);
    const ch = this.openChange();
    if (!user || !ch || ch.userId !== user.id || ch.state !== "added") return null;
    if (user.role !== "admin" || user.email !== ch.oldEmail || accessEmail !== ch.newEmail) return null;
    return { change: ch, user };
  }

  /**
   * Steps 3–4: verified through Access with the new email from the admin's existing session → the account's email
   * switches and every session of it ends, in one transaction (with the change's state and the open sync). The caller
   * starts the new session. A failure before the commit leaves the old email in use.
   */
  switchAdminEmail(
    sessionToken: string | undefined,
    accessEmail: string | undefined,
    edge: boolean,
  ): UserRow {
    if (!edge || accessEmail === undefined) throw new AccessSyncError(403, "admin_email_verify_edge");
    const ready = this.confirmState(sessionToken, accessEmail);
    if (!ready) {
      const ch = this.openChange();
      if (ch && ch.state === "added" && accessEmail !== ch.newEmail)
        throw new AccessSyncError(403, "admin_email_verify_mismatch");
      throw new AccessSyncError(409, "admin_email_step");
    }
    const { change, user } = ready;
    this.db.$client
      .transaction(() => {
        const ch = this.db.select().from(adminEmailChanges).where(eq(adminEmailChanges.id, change.id)).get();
        const u = this.userStore.byId(user.id);
        if (ch?.state !== "added" || !u || u.email !== ch.oldEmail)
          throw new AccessSyncError(409, "admin_email_step");
        const other = this.userStore.byEmail(ch.newEmail);
        if (other && other.id !== u.id) throw new AccessSyncError(409, "email_taken");
        this.db
          .update(users)
          .set({ email: ch.newEmail, updatedAt: this.now() })
          .where(and(eq(users.id, u.id), eq(users.email, ch.oldEmail)))
          .run();
        this.db.delete(sessions).where(eq(sessions.userId, u.id)).run();
        this.setChange(ch.id, "switched", { switchedAt: this.now() });
        this.changed("admin_email_switched");
      })
      .immediate();
    this.events.emit("user-access-changed", { userId: user.id, reason: "session_ended" });
    return this.userStore.byId(user.id)!;
  }
}
