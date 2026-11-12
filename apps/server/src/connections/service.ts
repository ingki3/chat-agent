import type { ConnectionTestResult, RuntimeId, StreamEvent } from "@agentlee/shared";
import type { UserStore } from "../auth/users.js";
import { logEvent, type EventLogger } from "../logging.js";
import type { PublishInput } from "../notifications/compose.js";
import type { RuntimeRegistry } from "../runtime/adapter.js";
import type { RunRow } from "../runtime/runs.js";
import { RunAccess } from "./access.js";
import type { ImportFailure } from "./import.js";
import { ConnectionRuleError, RUNTIME_LABEL, type ConnectionRow, type ConnectionStore } from "./store.js";
import type { ConnectionTester } from "./tester.js";

/** Notice code: the personal connection hit its limit and a shared one is available — continue there? */
export const SHARED_OFFER_CODE = "personal_limit_use_shared";
export const CONNECTION_LOST_CODE = "connection_lost";
/** Notice code: a subscription login (Claude token, ChatGPT login) expired — log in again (#18). */
export const SUBSCRIPTION_EXPIRED_CODE = "subscription_expired";
/** Notice code: a subscription hit its plan's limit — another runtime can take over (#18, PRD FR-9.2). */
export const SUBSCRIPTION_LIMIT_CODE = "subscription_limit";
export const SUBSCRIPTION_LIMIT_MESSAGE = "지금 이 런타임은 한도에 걸렸어요";

/** What to do about an expired subscription login, per runtime (FR-11.8). */
const RELOGIN: Record<RuntimeId, string> = {
  "claude-code":
    "Claude 구독 토큰이 만료됐어요 — 터미널에서 `claude setup-token`으로 새 토큰을 만들어 설정 → 내 런타임 연결에 붙여 넣어 주세요. 그동안 다른 런타임으로 이어갈 수 있어요.",
  codex:
    "ChatGPT 로그인이 만료됐어요 — 설정 → 내 런타임 연결에서 ‘다시 로그인’을 눌러 주세요. 그동안 다른 런타임으로 이어갈 수 있어요.",
};

/**
 * Connections as the rest of the server uses them (#17): run checks (`access`), tests, disconnecting, and what
 * happens when a run fails on a connection — an expired credential marks it `expired` and notifies the owner
 * (`connection_lost`) or, for a shared one, the admins (`system_warning`); a personal limit offers the shared one.
 */
/**
 * How long a connection counts as limited after the provider refused it for its usage limit (#19): until the reset
 * time it gave — at least a minute and at most a week ahead — else a cooldown of five hours, the length of Claude's
 * shortest subscription window, so new conversations do not walk back into a limit that is still there. A reply that
 * finishes on it (picked by hand) or a passed connection test ends it earlier.
 */
export const LIMIT_COOLDOWN_MS = 5 * 60 * 60_000;
const LIMIT_MAX_MS = 7 * 24 * 60 * 60_000;
export function limitUntil(resetsAt: number | undefined, now: number): number {
  if (resetsAt === undefined || !Number.isFinite(resetsAt)) return now + LIMIT_COOLDOWN_MS;
  return Math.min(Math.max(resetsAt, now + 60_000), now + LIMIT_MAX_MS);
}

export class ConnectionService {
  readonly access: RunAccess;
  /** Running connection tests: how to cancel one, and its end (disconnect waits for it before removing folders). */
  private readonly testing = new Map<string, { abort: AbortController; done: Promise<unknown> }>();
  private runs: { stopConnection(id: string): Promise<void> } | undefined;
  private notify: ((userId: string, input: PublishInput) => void) | undefined;
  /** `.env` values this start could not import (admin status, `GET /api/admin/connections`). */
  importFailures: ImportFailure[] = [];

  constructor(
    readonly store: ConnectionStore,
    private readonly users: Pick<UserStore, "byId">,
    private readonly tester: ConnectionTester,
    private readonly registry: Pick<RuntimeRegistry, "get">,
    private readonly log: EventLogger | undefined,
  ) {
    this.access = new RunAccess(users, store);
  }

  /** Late wiring: the run manager and the notification service are built after this service. */
  attach(deps: {
    runs?: { stopConnection(id: string): Promise<void> };
    notify?: (userId: string, input: PublishInput) => void;
  }): void {
    if (deps.runs) this.runs = deps.runs;
    if (deps.notify) this.notify = deps.notify;
  }

  /**
   * Runtimes other than `runtime` that `userId` could continue with right now (allowed, with a usable connection or
   * none needed) — the hint of a limit or expiry notice; the switch itself is the conversation's (#19).
   */
  private others(userId: string, runtime: RuntimeId): RuntimeId[] {
    const user = this.users.byId(userId);
    if (!user) return [];
    return (["claude-code", "codex"] as RuntimeId[]).filter((id) => {
      if (id === runtime) return false;
      const adapter = this.registry.get(id);
      if (!adapter) return false;
      const caps = adapter.capabilities();
      if (!this.access.models(this.store.policy(user, id), caps).length) return false;
      return !caps.needsConnection || this.store.usableFor(user, id).length > 0;
    });
  }

  /** A reply finished on the connection: a usage limit it had is over (#19). */
  runSucceeded(run: RunRow): void {
    if (run.connectionId) this.store.clearLimit(run.connectionId);
  }

  /** The run manager's hook for a failed run on a connection: notices for the stream, side effects here. */
  runFailed(run: RunRow, code: string, info: { resetsAt?: number } = {}): StreamEvent[] {
    const c = run.connectionId ? this.store.get(run.connectionId) : undefined;
    if (!c) return [];
    // A usage limit (FR-9.2, FR-12.6): new conversations start elsewhere until it resets (#19).
    if (code === "usage_limit") this.store.markLimited(c.id, limitUntil(info.resetsAt, Date.now()));
    const runtime = c.runtime as RuntimeId;
    const label = RUNTIME_LABEL[runtime] ?? c.runtime;
    const subscription = c.authType === "subscription";
    if (code === "runtime_auth") {
      // Only the first run that finds it broken announces it (passed → expired).
      if (run.connectionVersion !== null && this.store.markExpired(c.id, run.connectionVersion)) {
        logEvent(this.log, "warn", "connection.expired", {
          connectionId: c.id,
          runtime: c.runtime,
          scope: c.scope,
        });
        this.safeNotify(() => {
          if (c.scope === "personal" && c.ownerId)
            this.notify?.(c.ownerId, { kind: "connection_lost", runtimeLabel: label, url: "/settings" });
          else
            for (const admin of this.store.admins())
              this.notify?.(admin, {
                kind: "system_warning",
                message: `공용 ${label} 연결(${c.label})이 끊겼어요 — 키를 확인하고 다시 테스트해 주세요.`,
                url: "/admin",
              });
        });
      }
      const switchTo = this.others(run.userId, runtime);
      return [
        subscription
          ? {
              type: "notice",
              level: "warn",
              code: SUBSCRIPTION_EXPIRED_CODE,
              message: RELOGIN[runtime] ?? `${label} 로그인이 만료됐어요 — 다시 로그인해 주세요.`,
              ...(switchTo.length ? { switchTo } : {}),
            }
          : {
              type: "notice",
              level: "warn",
              code: CONNECTION_LOST_CODE,
              message: `${label} 연결이 끊겼어요 — 다시 로그인하거나 다른 런타임으로 이어가기`,
              ...(switchTo.length ? { switchTo } : {}),
            },
      ];
    }
    const out: StreamEvent[] = [];
    if (code === "usage_limit" && subscription) {
      // The plan's limit (FR-9.2): no cost to show, only that this runtime is out for now — and where to go on.
      const switchTo = this.others(run.userId, runtime);
      out.push({
        type: "notice",
        level: "warn",
        code: SUBSCRIPTION_LIMIT_CODE,
        message: switchTo.length
          ? `${SUBSCRIPTION_LIMIT_MESSAGE} — 다른 런타임으로 바꿔서 이어갈 수 있어요.`
          : `${SUBSCRIPTION_LIMIT_MESSAGE} — 잠시 뒤 다시 시도해 주세요.`,
        ...(switchTo.length ? { switchTo } : {}),
      });
    }
    if (code === "usage_limit" && c.scope === "personal") {
      const user = this.users.byId(run.userId);
      const shared =
        user && this.store.usableFor(user, c.runtime as RuntimeId).find((x) => x.scope === "shared");
      if (shared)
        out.push({
          type: "notice",
          level: "info",
          code: SHARED_OFFER_CODE,
          message: "개인 연결이 사용 한도에 도달했어요. 공용 연결로 이어갈까요?",
        });
    }
    return out;
  }

  private safeNotify(fn: () => void) {
    try {
      fn();
    } catch {
      // a notification must never change how the run ends
    }
  }

  /**
   * Runs the connection test as `userId` and records the outcome. The same rules as a run apply — runtime allowed,
   * personal / shared connections allowed, and the test model and effort taken from what the policy allows (the
   * smallest allowed model, listed last, at its lowest allowed effort); the only exception is that the connection
   * need not be `passed` yet. One test per connection at a time (409); disconnecting or a new key cancels it.
   */
  async test(c: ConnectionRow, userId: string): Promise<ConnectionTestResult> {
    if (c.disconnectedAt !== null || !c.secret) throw new ConnectionRuleError(404, "not_found");
    const runtime = c.runtime as RuntimeId;
    const user = this.users.byId(userId);
    if (!user || !this.store.usable(c, user, runtime, { test: true }))
      throw new ConnectionRuleError(403, "connection_not_allowed");
    const adapter = this.registry.get(runtime);
    const model = adapter
      ? this.access.models(this.store.policy(user, runtime), adapter.capabilities()).at(-1)
      : undefined;
    if (adapter && !model) throw new ConnectionRuleError(403, "model_not_allowed");
    if (this.testing.has(c.id)) throw new ConnectionRuleError(409, "test_in_progress");
    const abort = new AbortController();
    const running = this.tester.run({
      connectionId: c.id,
      runtime,
      userId,
      model: model?.id ?? "",
      effort: model?.efforts[0],
      version: c.credentialVersion,
      signal: abort.signal,
    });
    this.testing.set(c.id, { abort, done: running.catch(() => undefined) });
    try {
      const r = await running;
      const status = r.passed ? "passed" : "failed";
      // Recorded only for the tested credential, and never for a cancelled test.
      if (r.code !== "cancelled") this.store.setTestResult(c.id, status, r.code, c.credentialVersion);
      logEvent(this.log, r.passed ? "info" : "warn", "connection.tested", {
        connectionId: c.id,
        runtime: c.runtime,
        scope: c.scope,
        status: r.passed ? "ok" : "error",
        testCode: r.code,
      });
      return { status: this.store.get(c.id)?.status ?? status, code: r.code, checks: r.checks };
    } finally {
      this.testing.delete(c.id);
    }
  }

  /** Cancels a running test of `id` and waits (at most `ms`) until its session is closed and its token revoked. */
  private async cancelTest(id: string, ms = 10_000): Promise<void> {
    const t = this.testing.get(id);
    if (!t) return;
    t.abort.abort();
    await Promise.race([t.done, new Promise<void>((r) => setTimeout(r, ms).unref())]);
  }

  /** A new login replaced the credential of `id` (#18): runs and a test still on the old login stop. */
  async replaced(id: string): Promise<void> {
    await Promise.all([this.runs?.stopConnection(id), this.cancelTest(id)]);
  }

  /** New label and/or key. A new key stops runs and a test that still use the old key. */
  async update(
    id: string,
    patch: { label?: string | undefined; secret?: string | undefined },
  ): Promise<ConnectionRow> {
    const row = this.store.update(id, patch);
    // A new key: runs and a test still using the old one stop.
    if (patch.secret !== undefined) await Promise.all([this.runs?.stopConnection(id), this.cancelTest(id)]);
    return row;
  }

  /**
   * Disconnects: running runs and a running test on it stop, its sessions are never resumed, then its folders go
   * (FR-11.9).
   */
  async disconnect(c: ConnectionRow): Promise<boolean> {
    if (!this.store.disconnect(c.id)) return false;
    // Runs and a test on it stop, and their runtime processes are gone, before the folder is removed.
    await Promise.all([this.runs?.stopConnection(c.id), this.cancelTest(c.id)]);
    this.store.removeFolders(c.id);
    logEvent(this.log, "info", "connection.disconnected", {
      connectionId: c.id,
      runtime: c.runtime,
      scope: c.scope,
    });
    return true;
  }
}
