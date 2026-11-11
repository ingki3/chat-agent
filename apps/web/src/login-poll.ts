import type { Connection, SubscriptionLogin } from "@agentlee/shared";
import { ApiError } from "./api.js";

/** How long past its `expiresAt` the page still waits for the server's own verdict (clock skew, a slow poll). */
export const EXPIRY_GRACE_MS = 30_000;

export type LoginPoll = { login: SubscriptionLogin; connection: Connection | null };

/**
 * What the settings page does after one poll of a waiting ChatGPT login (#18):
 * - `done`: the server says it ended (completed, failed, cancelled, timeout);
 * - `gone`: the server no longer knows it (404 — e.g. it restarted, logins live in memory) or the session is over
 *   (401/403): stop and ask to start again;
 * - `expired`: past `expiresAt` (plus a grace) and still not ended: stop and ask to start again;
 * - `wait`: still waiting, or a passing failure (network, 5xx): ask again next time.
 */
export function pollStep(o: {
  now: number;
  expiresAt: number | null;
  result?: LoginPoll;
  error?: unknown;
}): { kind: "done"; result: LoginPoll } | { kind: "gone" } | { kind: "expired" } | { kind: "wait" } {
  if (o.result && o.result.login.status !== "pending") return { kind: "done", result: o.result };
  if (o.error instanceof ApiError && [401, 403, 404].includes(o.error.status)) return { kind: "gone" };
  if (o.expiresAt !== null && o.now > o.expiresAt + EXPIRY_GRACE_MS) return { kind: "expired" };
  return { kind: "wait" };
}
