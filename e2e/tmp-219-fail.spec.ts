import { expect, test } from "@playwright/test";

// #219 temporary: proves a failing shard fails the aggregate `e2e` check. Never merged.
test("fails on purpose (#219)", () => {
  expect(1).toBe(2);
});
