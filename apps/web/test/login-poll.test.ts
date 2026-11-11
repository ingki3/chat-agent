import { describe, expect, it } from "vitest";
import type { SubscriptionLogin } from "@agentlee/shared";
import { ApiError } from "../src/api.js";
import { EXPIRY_GRACE_MS, pollStep } from "../src/login-poll.js";

const login = (status: SubscriptionLogin["status"]): SubscriptionLogin => ({
  id: "l1",
  runtime: "codex",
  status,
  verificationUrl: null,
  userCode: null,
  expiresAt: 1000,
  connectionId: null,
  code: null,
});

describe("polling a waiting ChatGPT login (#18)", () => {
  const base = { now: 500, expiresAt: 1000 };
  it("ends when the server says so", () => {
    expect(pollStep({ ...base, result: { login: login("completed"), connection: null } }).kind).toBe("done");
    expect(pollStep({ ...base, result: { login: login("timeout"), connection: null } }).kind).toBe("done");
  });
  it("stops at once when the server no longer knows the login (restart) or the session is gone", () => {
    for (const status of [404, 401, 403])
      expect(pollStep({ ...base, error: new ApiError(status, "not_found") })).toEqual({ kind: "gone" });
  });
  it("retries passing failures (network, 5xx) — but not past the login's expiry", () => {
    expect(pollStep({ ...base, error: new TypeError("Failed to fetch") })).toEqual({ kind: "wait" });
    expect(pollStep({ ...base, error: new ApiError(503, "unavailable") })).toEqual({ kind: "wait" });
    const late = { now: 1000 + EXPIRY_GRACE_MS + 1, expiresAt: 1000 };
    expect(pollStep({ ...late, error: new TypeError("Failed to fetch") })).toEqual({ kind: "expired" });
    expect(pollStep({ ...late, result: { login: login("pending"), connection: null } })).toEqual({
      kind: "expired",
    });
  });
  it("decides expiry on the page's clock alone, without any answer (a poll that hangs)", () => {
    expect(pollStep({ now: 1000 + EXPIRY_GRACE_MS + 1, expiresAt: 1000 })).toEqual({ kind: "expired" });
    expect(pollStep({ now: 500, expiresAt: 1000 })).toEqual({ kind: "wait" });
  });
  it("keeps waiting while the login is pending and in time", () => {
    expect(pollStep({ ...base, result: { login: login("pending"), connection: null } })).toEqual({
      kind: "wait",
    });
  });
});
