import crypto from "node:crypto";
import path from "node:path";
import type { SubscriptionLogin, SubscriptionLoginStatus } from "@agentlee/shared";
import type { UserStore } from "../auth/users.js";
import { logEvent, type EventLogger } from "../logging.js";
import type { DeviceLogin, DeviceLoginResult } from "../runtime/codex-login.js";
import { LoginEnded } from "../runtime/codex-login.js";
import { serializeCredential } from "./chatgpt.js";
import { ConnectionRuleError, type ConnectionRow, type ConnectionStore } from "./store.js";

/** Starts a device-code login in a folder (runtime/codex-login.ts; a scripted app-server in tests). */
export type DeviceLoginProvider = { start(dir: string): Promise<DeviceLogin> };

type Entry = {
  view: SubscriptionLogin;
  userId: string;
  login?: DeviceLogin;
  /** Its app-server is still starting (the slot is taken: counted against the limits). */
  starting?: boolean;
  /** The user cancelled it (or a newer login of theirs replaced it): never stored, whatever comes back. */
  cancelRequested?: boolean;
  /** Settles once its process has exited and its folder is gone; the slot is held until then. */
  gone?: Promise<void>;
  released?: boolean;
  /** Removed from memory this long after it ended (the page polls for the outcome). */
  endedAt?: number;
};

const KEEP_ENDED_MS = 10 * 60_000;
const MAX_ACTIVE = 4;

/**
 * Codex ChatGPT logins through the web screen (#18, PRD D2 / FR-11.2): each family member logs in with their own
 * account, for a personal connection of their own. The browser starts one, shows the code and the sign-in link,
 * and polls; the server waits for app-server (`codex-login.ts`), then stores the tokens encrypted — a new
 * connection, or the new credential of the connection it logs in again on (replaced: runs on the old login stop,
 * and it is tested again). Only the account's email is ever shown. Logins live in memory only: a restart ends
 * them (nothing was stored yet).
 */
export class SubscriptionLoginService {
  private readonly logins = new Map<string, Entry>();
  /** Starts of one user run one after another (each cancels the one before). */
  private readonly userStarts = new Map<string, Promise<unknown>>();
  private closed = false;

  constructor(
    private readonly store: ConnectionStore,
    private readonly users: Pick<UserStore, "byId">,
    private readonly provider: DeviceLoginProvider | undefined,
    private readonly dataDir: string,
    private readonly hooks: {
      /** A connection's credential was replaced by a new login: runs and a test on the old one stop. */
      replaced(id: string): Promise<void>;
      log?: EventLogger | undefined;
      now?: () => number;
      /** Logins waiting at once, for everyone (each is an app-server process). Default 4. */
      maxActive?: number;
    },
  ) {}

  private now() {
    return (this.hooks.now ?? Date.now)();
  }

  private purge() {
    const t = this.now();
    for (const [id, e] of this.logins)
      if (e.endedAt !== undefined && t - e.endedAt > KEEP_ENDED_MS) this.logins.delete(id);
  }

  /**
   * Starts a login for `userId` — for a new connection, or `connectionId` (their own Codex login connection) to log
   * in again. One login per user at a time: an earlier one still waiting is cancelled. Starts of one user are
   * serialised, and a login takes its slot (per user and against the global limit) before its process starts.
   */
  async start(
    userId: string,
    input: { runtime: "codex"; label?: string | undefined; connectionId?: string | undefined },
  ): Promise<SubscriptionLogin> {
    const before = this.userStarts.get(userId) ?? Promise.resolve();
    const mine = before.catch(() => undefined).then(() => this.startNow(userId, input));
    this.userStarts.set(userId, mine);
    try {
      return await mine;
    } finally {
      if (this.userStarts.get(userId) === mine) this.userStarts.delete(userId);
    }
  }

  /**
   * Logins that hold a slot: starting, waiting for the code, or cancelled but whose process has not exited and been
   * cleaned up yet — a slot is a live process.
   */
  private holding(): Entry[] {
    return [...this.logins.values()].filter((e) => !e.released);
  }

  private async startNow(
    userId: string,
    input: { runtime: "codex"; label?: string | undefined; connectionId?: string | undefined },
  ): Promise<SubscriptionLogin> {
    this.purge();
    if (this.closed || !this.provider) throw new ConnectionRuleError(400, "unsupported_auth");
    const user = this.users.byId(userId);
    if (!user?.active) throw new ConnectionRuleError(404, "not_found");
    const policy = this.store.policy(user, input.runtime);
    if (!policy.allowed || !policy.allowPersonal)
      throw new ConnectionRuleError(403, "connection_not_allowed");
    let target: ConnectionRow | undefined;
    if (input.connectionId !== undefined) {
      target = this.store.get(input.connectionId);
      // Only the caller's own, connected ChatGPT login connection — anything else is not there for them.
      if (
        !target ||
        target.disconnectedAt !== null ||
        target.scope !== "personal" ||
        target.ownerId !== userId ||
        target.runtime !== input.runtime ||
        target.authType !== "subscription"
      )
        throw new ConnectionRuleError(404, "not_found");
    }
    // The user's earlier login is cancelled, and this start waits until its process is gone (starts of one user
    // are serialised, so nothing of theirs starts meanwhile).
    const earlier = this.holding().filter((e) => e.userId === userId);
    for (const e of earlier) {
      e.cancelRequested = true;
      e.login?.cancel();
    }
    await Promise.all(earlier.map((e) => e.gone));
    if (this.closed) throw new ConnectionRuleError(409, "login_unavailable");
    // Everything from here to the reservation below is synchronous: no other start can slip in between.
    if (this.holding().length >= (this.hooks.maxActive ?? MAX_ACTIVE))
      throw new ConnectionRuleError(409, "login_busy");

    const id = crypto.randomUUID();
    // The login process's folder: inside the connection's own folder when logging in again, else its own.
    const dir = path.join(this.dataDir, "runtimes", target ? target.id : "logins", `login-${id}`);
    const entry: Entry = {
      userId,
      view: {
        id,
        runtime: input.runtime,
        status: "pending",
        verificationUrl: null,
        userCode: null,
        expiresAt: null,
        connectionId: target?.id ?? null,
        code: null,
      },
      starting: true,
    };
    this.logins.set(id, entry); // the slot is taken from now on
    let login: DeviceLogin;
    try {
      login = await this.provider.start(dir);
    } catch (e) {
      this.logins.delete(id); // nothing was left running (the provider cleans up a start that fails)
      throw e instanceof LoginEnded ? new ConnectionRuleError(409, "login_unavailable") : e;
    }
    entry.gone = login.result
      .then(
        () => {},
        () => {},
      )
      .then(() => {
        entry.released = true; // the slot is given back only now
      });
    if (this.closed || entry.cancelRequested) {
      login.cancel();
      await entry.gone;
      this.logins.delete(id);
      throw new ConnectionRuleError(409, "login_unavailable");
    }
    delete entry.starting;
    entry.login = login;
    entry.view = {
      ...entry.view,
      verificationUrl: login.verificationUrl,
      userCode: login.userCode,
      expiresAt: login.expiresAt,
    };
    logEvent(this.hooks.log, "info", "connection.login_started", {
      userId,
      runtime: input.runtime,
      ...(target ? { connectionId: target.id } : {}),
    });
    void login.result.then(
      (r) => this.finish(entry, input, r),
      (e: unknown) => this.end(entry, e instanceof LoginEnded ? e.code : "login_error"),
    );
    return { ...entry.view };
  }

  private async finish(
    entry: Entry,
    input: { runtime: "codex"; label?: string | undefined; connectionId?: string | undefined },
    r: DeviceLoginResult,
  ) {
    try {
      const user = this.users.byId(entry.userId);
      if (!user?.active || this.closed) return this.end(entry, "login_error");
      // Cancel and store have one winner: a cancel that came first means nothing is stored (checked right before
      // the synchronous write below); a cancel after it finds the login completed.
      if (entry.cancelRequested) return this.end(entry, "cancelled");
      const credential = serializeCredential(r.credential);
      let c: ConnectionRow;
      if (entry.view.connectionId) {
        c = this.store.replaceLogin(entry.view.connectionId, credential, r.email);
        await this.hooks.replaced(c.id);
      } else
        c = this.store.createLogin({
          runtime: input.runtime,
          owner: user,
          createdBy: user.id,
          label: input.label,
          credential,
          email: r.email,
        });
      logEvent(this.hooks.log, "info", "connection.created", {
        connectionId: c.id,
        runtime: c.runtime,
        scope: c.scope,
        authType: c.authType,
      });
      entry.view = { ...entry.view, connectionId: c.id };
      this.end(entry, "completed");
    } catch {
      // e.g. disconnected meanwhile: nothing is stored
      this.end(entry, "login_error");
    }
  }

  private end(entry: Entry, code: "completed" | LoginEnded["code"]) {
    const status: SubscriptionLoginStatus =
      code === "completed"
        ? "completed"
        : code === "cancelled"
          ? "cancelled"
          : code === "timeout"
            ? "timeout"
            : "failed";
    // The code and link are of no use any more: never shown again.
    entry.view = {
      ...entry.view,
      status,
      verificationUrl: null,
      userCode: null,
      code: code === "completed" ? null : code,
    };
    entry.endedAt = this.now();
    delete entry.login;
    logEvent(this.hooks.log, code === "completed" ? "info" : "warn", "connection.login_finished", {
      userId: entry.userId,
      runtime: entry.view.runtime,
      loginCode: code,
      ...(entry.view.connectionId ? { connectionId: entry.view.connectionId } : {}),
    });
  }

  /** The caller's own login (anyone else's is not there: 404). */
  get(userId: string, id: string): SubscriptionLogin {
    this.purge();
    const e = this.logins.get(id);
    if (!e || e.userId !== userId) throw new ConnectionRuleError(404, "not_found");
    return { ...e.view };
  }

  /** Cancels the caller's own login; resolves once it has ended (its process and folder are gone). */
  async cancel(userId: string, id: string): Promise<SubscriptionLogin> {
    const e = this.logins.get(id);
    if (!e || e.userId !== userId) throw new ConnectionRuleError(404, "not_found");
    const login = e.login;
    if (login && e.view.status === "pending") {
      e.cancelRequested = true; // from now on nothing of this login is stored (`finish`)
      login.cancel();
      await login.result.catch(() => undefined);
      // `end` runs on the result's own handler; give it its turn.
      await new Promise<void>((r) => setImmediate(r));
    }
    return { ...e.view };
  }

  /** Server shutdown: every waiting login is cancelled and its folder removed. */
  async close(): Promise<void> {
    this.closed = true;
    for (const e of this.logins.values()) e.cancelRequested = true;
    const waiting = [...this.logins.values()].flatMap((e) => (e.login ? [e.login] : []));
    for (const l of waiting) l.cancel();
    await Promise.all(waiting.map((l) => l.result.catch(() => undefined)));
  }
}
