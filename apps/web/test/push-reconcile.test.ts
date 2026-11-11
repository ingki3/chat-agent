import { describe, expect, it } from "vitest";
import { reconcileAction } from "../src/push-reconcile.js";

describe("reconciling the browser subscription with the server (#34)", () => {
  const cur = { endpointHash: "aaa" };
  it("keeps a registration that matches the browser", () => {
    expect(reconcileAction({ endpointHash: "aaa", current: cur, pending: false })).toBe("none");
    expect(reconcileAction({ endpointHash: "aaa", current: cur, pending: true })).toBe("none");
  });
  it("replaces a registration of an older subscription (renewal not registered)", () => {
    expect(reconcileAction({ endpointHash: "bbb", current: cur, pending: false })).toBe("replace");
  });
  it("registers again after the worker's re-registration failed (e.g. 403) and the server lost the device", () => {
    expect(reconcileAction({ endpointHash: "bbb", current: undefined, pending: true })).toBe("register");
  });
  it("removes the server row when the browser has no usable subscription", () => {
    expect(reconcileAction({ endpointHash: null, current: cur, pending: false })).toBe("remove");
    expect(reconcileAction({ endpointHash: null, current: undefined, pending: true })).toBe("none");
  });
  it("does not opt a device in by itself (turned off elsewhere, new login, another account)", () => {
    expect(reconcileAction({ endpointHash: "bbb", current: undefined, pending: false })).toBe("none");
  });
});
