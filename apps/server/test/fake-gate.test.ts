import { describe, expect, it } from "vitest";
import { fakeGateCount, releaseGate, waitGate } from "../src/runtime/fake.js";

/** FakeRuntime's `/gate` and `/release` (#103): e2e tests order a reply's end; nothing is kept once used. */
describe("FakeRuntime gates", () => {
  it("a release frees its waiters and forgets the name", async () => {
    const before = fakeGateCount();
    const a = waitGate("g1", new AbortController().signal);
    const b = waitGate("g1", new AbortController().signal);
    expect(fakeGateCount()).toBe(before + 1);
    releaseGate("g1");
    await Promise.all([a, b]);
    expect(fakeGateCount()).toBe(before);
  });

  it("a release that comes first is taken by the next wait, then forgotten", async () => {
    const before = fakeGateCount();
    releaseGate("g2");
    expect(fakeGateCount()).toBe(before + 1);
    await waitGate("g2", new AbortController().signal);
    expect(fakeGateCount()).toBe(before);
  });

  it("a stopped reply leaves its gate (the name goes with its last waiter)", async () => {
    const before = fakeGateCount();
    const one = new AbortController();
    const two = new AbortController();
    const a = waitGate("g3", one.signal);
    const b = waitGate("g3", two.signal);
    one.abort();
    await a;
    expect(fakeGateCount()).toBe(before + 1);
    two.abort();
    await b;
    expect(fakeGateCount()).toBe(before);
  });
});
