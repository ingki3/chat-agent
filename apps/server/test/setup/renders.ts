import { afterAll } from "vitest";
import { killLiveRenders } from "../../src/artifacts/browser.js";

// #170: a test file never leaves an export browser behind — whatever is still running when it ends is killed
// (process group, SIGKILL) and its folder removed. A worker that dies abruptly is covered by the watchdog.
afterAll(() => {
  killLiveRenders();
});
