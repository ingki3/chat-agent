import { expect, it } from "vitest";

// #219 temporary: proves a failing shard fails the aggregate `test` check. Never merged.
it("fails on purpose (#219)", () => {
  expect(1).toBe(2);
});
