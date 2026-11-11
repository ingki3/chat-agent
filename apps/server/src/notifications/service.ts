import crypto from "node:crypto";
import { and, count, desc, eq, inArray, isNull, lt, ne } from "drizzle-orm";
import webpush from "web-push";
import type {
  Notification,
  NotificationKind,
  NotificationPrefs,
  PushDevice,
  PushPayload,
  PushSubscriptionRequest,
} from "@agentlee/shared";
import { sessionIdOf, type UserRow, type UserStore } from "../auth/users.js";
import { can } from "../authz/policy.js";
import type { ResourceRegistry } from "../authz/resources.js";
import { decrypt, encrypt } from "../crypto/secrets.js";
import type { Db } from "../db/client.js";
import { notificationPrefs, notifications, pushSubscriptions, sessions } from "../db/schema.js";
import { logEvent, type EventLogger } from "../logging.js";
import { classifyError } from "../observability/policy.js";
import { ADMIN_KINDS, bundle, compose, SHARED_BODY, type PublishInput } from "./compose.js";
import { validPushEndpoint } from "./endpoint.js";
import { DEFAULT_TIME_ZONE, inQuietHours, isTimeZone } from "./quiet.js";
import type { VapidKeys } from "./vapid.js";

type Row = typeof notifications.$inferSelect;

export type PushTarget = { endpoint: string; keys: { p256dh: string; auth: string } };
/** Sends one encrypted push. Throws an error with `statusCode` when the push service refuses it. */
export type PushSender = (target: PushTarget, payload: string) => Promise<void>;

export type NotificationServiceOptions = {
  /** Push transport override (tests). Default: `web-push` with the VAPID keys. */
  sender?: PushSender;
  now?: () => number;
  /** How often held/queued pushes are checked (quiet hours ending). Default 60 s. */
  flushMs?: number;
};

/** Devices per account; registering another one drops the oldest. */
const MAX_DEVICES = 20;
/** Inbox entries older than this are removed. */
export const RETENTION_MS = 90 * 24 * 3600_000;
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function webPushSender(vapid: VapidKeys, subject: string): PushSender {
  return async (target, payload) => {
    await webpush.sendNotification(target, payload, {
      vapidDetails: { subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      // Undelivered pushes (device off) are kept by the push service for a day, then dropped.
      TTL: 24 * 3600,
      timeout: 15_000,
    });
  };
}

export class SubscriptionError extends Error {
  constructor(readonly code: "invalid_request" | "session_changed") {
    super(code);
  }
}

/**
 * Notifications (#34, FR-13): the inbox, quiet hours and web push.
 *
 * `publish(userId, input)` is the one entry point for every publishing point (schedules #33/#56, shares #29/#52,
 * connections #17, cost #32, system warnings #35). It stores the inbox entry and pushes it to the user's
 * devices — or holds it during quiet hours and sends everything held as one push when they end. Held entries are
 * rows in the database, so they survive a restart (`recover` + the first `flushDue` at start).
 *
 * Right before every push the recipient and the resource are checked again (account active, admin kinds to
 * admins only, the resource still readable — e.g. the share was not revoked); when that fails the push is
 * cancelled and the entry hidden.
 */
export class NotificationService {
  private readonly now: () => number;
  private readonly sender: PushSender;
  private readonly inflight = new Set<Promise<void>>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly db: Db,
    private readonly masterKey: Buffer,
    private readonly users: UserStore,
    private readonly resources: ResourceRegistry,
    readonly vapid: VapidKeys,
    subject: string,
    private readonly log: EventLogger | undefined,
    private readonly opts: NotificationServiceOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.sender = opts.sender ?? webPushSender(vapid, subject);
  }

  // ---- publishing ----

  /**
   * Stores a notification for `userId` and pushes it (now, or bundled after quiet hours). Returns its id, or
   * undefined when the user may not receive it (inactive, not an admin for an admin kind, resource not readable).
   */
  publish(userId: string, input: PublishInput): string | undefined {
    const c = compose(input);
    const ref = "ref" in input && input.ref ? input.ref : undefined;
    const user = this.users.byId(userId);
    if (!user || !this.allowed(user, c.kind, ref?.kind ?? null, ref?.id ?? null)) {
      logEvent(this.log, "info", "push.cancelled", { userId, notificationKind: c.kind });
      return undefined;
    }
    // A result the recipient sees only through a share: its content stays off the lock screen (FR-13.5).
    let body = c.body;
    if (ref && c.kind !== "share_received" && this.resources.load(ref.kind, ref.id)?.ownerId !== userId)
      body = SHARED_BODY;
    const t = this.now();
    const row: Row = {
      id: crypto.randomUUID(),
      userId,
      kind: c.kind,
      title: c.title,
      body,
      url: c.url,
      refKind: ref?.kind ?? null,
      refId: ref?.id ?? null,
      // The test button sends at once, quiet hours or not.
      pushState: c.kind === "test" ? "sending" : inQuietHours(this.prefs(userId), t) ? "held" : "queued",
      createdAt: t,
      readAt: null,
    };
    this.db.insert(notifications).values(row).run();
    if (row.pushState === "sending") this.track(this.push(userId, [row]));
    else if (row.pushState === "queued") this.track(this.deliver(userId));
    return row.id;
  }

  /** Who may receive what — checked when publishing, right before pushing, and on every inbox read. */
  private allowed(user: UserRow, kind: string, refKind: string | null, refId: string | null): boolean {
    if (!user.active) return false;
    if (ADMIN_KINDS.has(kind as NotificationKind) && user.role !== "admin") return false;
    if (refKind === null || refId === null) return true;
    try {
      const r = this.resources.load(refKind, refId);
      return !!r && can(user, "read", r);
    } catch {
      return false; // unknown resource kind: fail closed
    }
  }

  private track(p: Promise<void>) {
    const done = p.catch((e: unknown) => {
      logEvent(this.log, "error", "push.failed", { err: e, errorCode: classifyError(e).code });
    });
    this.inflight.add(done);
    void done.finally(() => this.inflight.delete(done));
  }

  /** Resolves when every push started so far has finished (tests, shutdown). */
  async settled(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  /**
   * Sends what is waiting for `userId` — unless quiet hours are on. Everything waiting goes out together: one
   * entry as itself, several as one bundle ("알림 3개가 와 있어요").
   */
  async deliver(userId: string): Promise<void> {
    const t = this.now();
    if (inQuietHours(this.prefs(userId), t)) return;
    const user = this.users.byId(userId);
    // Claim synchronously: a concurrent deliver() for the same user finds nothing left to send.
    const claimed = this.db.$client
      .transaction(() => {
        const rows = this.db
          .select()
          .from(notifications)
          .where(and(eq(notifications.userId, userId), inArray(notifications.pushState, ["queued", "held"])))
          .orderBy(notifications.createdAt)
          .all();
        const ok: Row[] = [];
        for (const r of rows) {
          const allowed = !!user && this.allowed(user, r.kind, r.refKind, r.refId);
          this.db
            .update(notifications)
            .set({ pushState: allowed ? "sending" : "cancelled" })
            .where(eq(notifications.id, r.id))
            .run();
          if (allowed) ok.push(r);
          else logEvent(this.log, "info", "push.cancelled", { userId, notificationKind: r.kind });
        }
        return ok;
      })
      .immediate();
    if (claimed.length) await this.push(userId, claimed);
  }

  /** Pushes `rows` (already claimed as `sending`) to every device of the user, then records the outcome. */
  private async push(userId: string, rows: Row[]): Promise<void> {
    const first = rows[0]!;
    const payload: PushPayload =
      rows.length === 1
        ? { title: first.title, body: first.body, url: first.url, id: first.id, tag: first.id }
        : { ...bundle(rows.map((r) => r.title)), tag: `bundle-${first.id}` };
    const targets = this.targets(userId);
    const json = JSON.stringify(payload);
    let delivered = 0;
    await Promise.all(
      targets.map(async ({ id, target }) => {
        try {
          await this.sender(target, json);
          delivered++;
          this.db
            .update(pushSubscriptions)
            .set({ lastSentAt: this.now() })
            .where(eq(pushSubscriptions.id, id))
            .run();
        } catch (e) {
          const status = (e as { statusCode?: unknown }).statusCode;
          if (status === 404 || status === 410) {
            // The browser dropped the subscription (uninstalled, permission revoked, expired).
            this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id)).run();
            logEvent(this.log, "info", "push.subscription_gone", { userId, httpStatus: status });
          } else {
            logEvent(this.log, "warn", "push.failed", {
              userId,
              errorCode: classifyError(e, { code: "network_error", category: "network" }).code,
              ...(typeof status === "number" ? { httpStatus: status } : {}),
            });
          }
        }
      }),
    );
    this.db
      .update(notifications)
      .set({ pushState: delivered > 0 ? "sent" : "unsent" })
      .where(
        and(
          inArray(
            notifications.id,
            rows.map((r) => r.id),
          ),
          eq(notifications.pushState, "sending"),
        ),
      )
      .run();
    logEvent(this.log, "info", delivered > 0 ? "push.sent" : "push.unsent", {
      userId,
      count: rows.length,
      devices: delivered,
      ...(rows.length === 1 ? { notificationKind: first.kind } : {}),
    });
  }

  /** Devices whose login session is still valid. Ones whose session ran out are removed here. */
  private targets(userId: string): { id: string; target: PushTarget }[] {
    const t = this.now();
    const rows = this.db
      .select({ sub: pushSubscriptions, expiresAt: sessions.expiresAt })
      .from(pushSubscriptions)
      .innerJoin(sessions, eq(sessions.id, pushSubscriptions.sessionId))
      .where(eq(pushSubscriptions.userId, userId))
      .all();
    const out: { id: string; target: PushTarget }[] = [];
    for (const { sub, expiresAt } of rows) {
      if (expiresAt <= t) {
        this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id)).run();
        continue;
      }
      try {
        out.push({ id: sub.id, target: JSON.parse(decrypt(sub.secret, this.masterKey, `push:${sub.id}`)) });
      } catch {
        this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id)).run();
      }
    }
    return out;
  }

  /**
   * At startup: pushes cut off by a restart go back to the queue. Then `flushDue` sends whatever is due (queued,
   * or held for quiet hours that ended while the server was down).
   */
  recover(): void {
    this.db
      .update(notifications)
      .set({ pushState: "queued" })
      .where(eq(notifications.pushState, "sending"))
      .run();
  }

  /** Delivers for every user with something waiting (quiet hours still on → stays held). */
  async flushDue(): Promise<void> {
    this.db
      .delete(notifications)
      .where(lt(notifications.createdAt, this.now() - RETENTION_MS))
      .run();
    const waiting = this.db
      .selectDistinct({ userId: notifications.userId })
      .from(notifications)
      .where(inArray(notifications.pushState, ["queued", "held"]))
      .all();
    for (const { userId } of waiting) await this.deliver(userId);
  }

  start(): void {
    this.recover();
    const tick = () => this.track(this.flushDue());
    tick();
    this.timer = setInterval(tick, this.opts.flushMs ?? 60_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.settled();
  }

  // ---- inbox ----

  /** The user's inbox, newest first. Entries whose resource the user can no longer read are left out. */
  list(userId: string, limit = 50): { items: Notification[]; unread: number } {
    const user = this.users.byId(userId);
    if (!user) return { items: [], unread: 0 };
    const rows = this.db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), ne(notifications.pushState, "cancelled")))
      .orderBy(desc(notifications.createdAt), desc(notifications.id))
      .limit(limit)
      .all()
      .filter((r) => this.allowed(user, r.kind, r.refKind, r.refId));
    return { items: rows.map(toNotification), unread: this.unread(userId) };
  }

  unread(userId: string): number {
    const user = this.users.byId(userId);
    if (!user) return 0;
    const unread = and(
      eq(notifications.userId, userId),
      isNull(notifications.readAt),
      ne(notifications.pushState, "cancelled"),
    );
    const withRef = this.db
      .select({ kind: notifications.kind, refKind: notifications.refKind, refId: notifications.refId })
      .from(notifications)
      .where(unread)
      .all();
    return withRef.filter((r) => this.allowed(user, r.kind, r.refKind, r.refId)).length;
  }

  get(id: string): Row | undefined {
    return this.db.select().from(notifications).where(eq(notifications.id, id)).get();
  }

  /**
   * One entry of the user's inbox, under the same rule as `list`: hidden (undefined) when it was cancelled, or
   * the user may no longer see it (share revoked, no longer an admin for an admin kind).
   */
  visible(userId: string, id: string): Row | undefined {
    const user = this.users.byId(userId);
    const r = this.get(id);
    if (!user || !r || r.userId !== userId || r.pushState === "cancelled") return undefined;
    return this.allowed(user, r.kind, r.refKind, r.refId) ? r : undefined;
  }

  /** Marks one visible entry read; returns it, or undefined when it is hidden (nothing changes then). */
  markRead(userId: string, id: string): Row | undefined {
    if (!this.visible(userId, id)) return undefined;
    this.db
      .update(notifications)
      .set({ readAt: this.now() })
      .where(and(eq(notifications.id, id), eq(notifications.userId, userId), isNull(notifications.readAt)))
      .run();
    return this.get(id);
  }

  markAllRead(userId: string): void {
    this.db
      .update(notifications)
      .set({ readAt: this.now() })
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .run();
  }

  // ---- settings ----

  prefs(userId: string): NotificationPrefs {
    const row = this.db.select().from(notificationPrefs).where(eq(notificationPrefs.userId, userId)).get();
    return row
      ? { quietStart: row.quietStart, quietEnd: row.quietEnd, timeZone: row.timeZone }
      : { quietStart: null, quietEnd: null, timeZone: DEFAULT_TIME_ZONE };
  }

  setPrefs(userId: string, p: NotificationPrefs): NotificationPrefs {
    const value = {
      quietStart: p.quietStart,
      quietEnd: p.quietEnd,
      timeZone: isTimeZone(p.timeZone) ? p.timeZone : DEFAULT_TIME_ZONE,
      updatedAt: this.now(),
    };
    this.db
      .insert(notificationPrefs)
      .values({ userId, ...value })
      .onConflictDoUpdate({ target: notificationPrefs.userId, set: value })
      .run();
    // Quiet hours may just have been switched off or moved: send what is no longer held.
    this.track(this.deliver(userId));
    return this.prefs(userId);
  }

  // ---- devices ----

  /**
   * Registers this browser for the signed-in user and session. The same endpoint registered before (by another
   * account on this browser, or again after a key change) is replaced, so a device only ever gets one account's
   * notifications.
   */
  subscribe(userId: string, sessionToken: string, req: PushSubscriptionRequest): string {
    if (!validPushEndpoint(req.endpoint)) throw new SubscriptionError("invalid_request");
    // A re-registration made for another session (the browser has since signed in elsewhere) is refused.
    if (req.sessionTag !== undefined && req.sessionTag !== this.sessionTag(sessionToken))
      throw new SubscriptionError("session_changed");
    const sessionId = sessionIdOf(sessionToken);
    const id = crypto.randomUUID();
    const secret = encrypt(
      JSON.stringify({ endpoint: req.endpoint, keys: req.keys } satisfies PushTarget),
      this.masterKey,
      `push:${id}`,
    );
    const endpointHash = sha256(req.endpoint);
    this.db.$client
      .transaction(() => {
        this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.endpointHash, endpointHash)).run();
        // Replacing this session's own older registration happens in the same transaction.
        if (req.replaces)
          this.db
            .delete(pushSubscriptions)
            .where(
              and(
                eq(pushSubscriptions.id, req.replaces),
                eq(pushSubscriptions.userId, userId),
                eq(pushSubscriptions.sessionId, sessionId),
              ),
            )
            .run();
        this.db
          .insert(pushSubscriptions)
          .values({
            id,
            userId,
            sessionId,
            endpointHash,
            secret,
            // eslint-disable-next-line no-control-regex -- strip control characters from the label
            label: req.label.replace(/[\u0000-\u001f\u007f-\u009f]/g, ""),
            createdAt: this.now(),
            lastSentAt: null,
          })
          .run();
        const n =
          this.db
            .select({ n: count() })
            .from(pushSubscriptions)
            .where(eq(pushSubscriptions.userId, userId))
            .get()?.n ?? 0;
        if (n > MAX_DEVICES) {
          const oldest = this.db
            .select({ id: pushSubscriptions.id })
            .from(pushSubscriptions)
            .where(eq(pushSubscriptions.userId, userId))
            .orderBy(pushSubscriptions.createdAt)
            .limit(n - MAX_DEVICES)
            .all();
          this.db
            .delete(pushSubscriptions)
            .where(
              inArray(
                pushSubscriptions.id,
                oldest.map((o) => o.id),
              ),
            )
            .run();
        }
      })
      .immediate();
    return id;
  }

  devices(userId: string, sessionToken: string | undefined): PushDevice[] {
    const current = sessionToken ? sessionIdOf(sessionToken) : undefined;
    return this.db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId))
      .orderBy(pushSubscriptions.createdAt)
      .all()
      .map((s) => ({
        id: s.id,
        label: s.label,
        createdAt: s.createdAt,
        lastSentAt: s.lastSentAt,
        current: s.sessionId === current,
      }));
  }

  /** Opaque, stable for one login session, different for every other (HMAC of the session id). */
  sessionTag(sessionToken: string): string {
    return crypto
      .createHmac("sha256", this.masterKey)
      .update(`push-session:${sessionIdOf(sessionToken)}`)
      .digest("base64url")
      .slice(0, 32);
  }

  /** Whether this session has a device registered with exactly this endpoint (given as its SHA-256). */
  sessionHasEndpoint(userId: string, sessionToken: string, endpointHash: string): boolean {
    return !!this.db
      .select({ id: pushSubscriptions.id })
      .from(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.userId, userId),
          eq(pushSubscriptions.sessionId, sessionIdOf(sessionToken)),
          eq(pushSubscriptions.endpointHash, endpointHash),
        ),
      )
      .get();
  }

  device(id: string): { id: string; userId: string } | undefined {
    return this.db
      .select({ id: pushSubscriptions.id, userId: pushSubscriptions.userId })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.id, id))
      .get();
  }

  removeDevice(id: string): void {
    this.db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id)).run();
  }
}

export function toNotification(r: Row): Notification {
  return {
    id: r.id,
    kind: r.kind as NotificationKind,
    title: r.title,
    body: r.body,
    url: r.url,
    createdAt: r.createdAt,
    readAt: r.readAt,
  };
}
