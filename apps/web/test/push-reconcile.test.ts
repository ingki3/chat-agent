import { describe, expect, it } from "vitest";
import { reconcileAction } from "../src/push-reconcile.js";

describe("reconciling the browser subscription with the server (#34)", () => {
  const base = { hasSubscription: true, current: false, match: false, marker: null, sessionTag: "tag-A" };

  it("keeps a registration that matches the browser", () => {
    expect(reconcileAction({ ...base, current: true, match: true })).toBe("none");
  });
  it("replaces this session's registration of an older subscription", () => {
    expect(reconcileAction({ ...base, current: true, match: false })).toBe("replace");
  });
  it("registers again only for the session whose re-registration failed", () => {
    expect(reconcileAction({ ...base, marker: { sessionTag: "tag-A" } })).toBe("register");
  });
  it("session expired, then another account (or a new login) signs in: stays off", () => {
    expect(reconcileAction({ ...base, sessionTag: "tag-B", marker: { sessionTag: "tag-A" } })).toBe("none");
    expect(reconcileAction({ ...base, marker: { sessionTag: null } })).toBe("none");
  });
  it("removes the server row when the browser has no usable subscription", () => {
    expect(reconcileAction({ ...base, hasSubscription: false, current: true })).toBe("remove");
    expect(reconcileAction({ ...base, hasSubscription: false, marker: { sessionTag: "tag-A" } })).toBe(
      "none",
    );
  });
  it("does not opt a device in by itself (turned off elsewhere)", () => {
    expect(reconcileAction(base)).toBe("none");
  });
});
