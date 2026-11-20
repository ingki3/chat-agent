import { afterAll } from "vitest";
import { closeRenderers } from "../../src/artifacts/export.js";

// #170: a test file never leaves an export browser behind — no render starts after it ends, and whatever still runs
// is killed (process group, SIGKILL) and its folder removed. A worker that dies abruptly is covered by the watchdog.
afterAll(() => {
  closeRenderers();
});
