import type { EventEmitter } from "node:events";
import os from "node:os";
import type { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `runIsolated` with `fork`, after the command exited (#191, #208): when the drain deadline, a stop and the time
 * limit end the call, measured from the `exit` itself on a fake clock — the real fork in youtube.test.ts cannot tell
 * "at once" from "just before the deadline", nor a deadline counted from the exit from one counted from the spawn.
 * The child process is a fake (no sandbox-exec), so this runs on any platform.
 */
const h = vi.hoisted(() => ({ children: [] as unknown[] }));

vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter: Emitter } = await import("node:events");
  const { PassThrough: Pipe } = await import("node:stream");
  return {
    ...real,
    spawn: () => {
      const child = Object.assign(new Emitter(), {
        pid: 424_242,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        stdin: new Pipe(),
        stdout: new Pipe(),
        stderr: new Pipe(),
        kill: () => true,
      });
      Object.assign(child, { stdio: [child.stdin, child.stdout, child.stderr] });
      h.children.push(child);
      return child;
    },
  };
});

type FakeChild = EventEmitter & {
  pid: number;
  exitCode: number | null;
  stdout: PassThrough;
  stderr: PassThrough;
};

// The setup file already loaded the sandbox module (through the renderers) with the real child_process: load it anew.
vi.resetModules();
const { FORK_DRAIN_MS, runIsolated } = await import("../src/isolation/sandbox.js");

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let kills: unknown[][] = [];

beforeEach(() => {
  h.children.length = 0;
  Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
  kills = [];
  vi.spyOn(process, "kill").mockImplementation((...args: unknown[]) => (kills.push(args), true));
  // The clock only; setImmediate stays real so pending promise work can be flushed without moving time.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

/** Lets every queued callback and promise reaction run, without advancing the fake clock. */
const flush = () => new Promise<void>((r) => setImmediate(r));

const start = (o: { timeoutMs?: number; signal?: AbortSignal } = {}) => {
  let result: Awaited<ReturnType<typeof runIsolated>> | undefined;
  const call = runIsolated({
    command: process.execPath,
    args: [],
    cwd: os.tmpdir(),
    env: {},
    read: [],
    write: [],
    fork: true,
    timeoutMs: o.timeoutMs ?? 60_000,
    maxOutputBytes: 1024,
    ...(o.signal ? { signal: o.signal } : {}),
  }).then((r) => (result = r));
  const child = h.children.at(-1) as FakeChild;
  /** The command exits; whatever left its group still holds the pipes (no `close`). */
  const exit = () => {
    child.exitCode = 0;
    child.emit("exit", 0, null);
  };
  return { call, child, exit, result: () => result };
};

describe("runIsolated with fork: after the command exits (fake clock, #208)", () => {
  it("the drain deadline counts from the exit: pending at FORK_DRAIN_MS - 1, cut as escaped 1 ms later", async () => {
    const run = start();
    // Time passes before the exit (a slow start): the deadline must not count it.
    await vi.advanceTimersByTimeAsync(1500);
    run.exit();
    // The group is killed at the exit.
    expect(kills).toContainEqual([-run.child.pid, "SIGKILL"]);
    await vi.advanceTimersByTimeAsync(FORK_DRAIN_MS - 1);
    await flush();
    expect(run.result()).toBeUndefined();
    expect(run.child.stdout.destroyed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(run.result()).toMatchObject({ killed: "escaped", code: 0 });
    expect(run.child.stdout.destroyed && run.child.stderr.destroyed).toBe(true);
  });

  it("a stop during the drain ends the call at once, as aborted, without the clock moving", async () => {
    const ctrl = new AbortController();
    const run = start({ signal: ctrl.signal });
    run.exit();
    await vi.advanceTimersByTimeAsync(5);
    const now = Date.now();
    ctrl.abort();
    await flush();
    expect(Date.now()).toBe(now);
    expect(run.result()).toMatchObject({ killed: "aborted" });
    expect(run.child.stdout.destroyed).toBe(true);
    // Nothing is left to fire later (the drain timer and the time limit are cleared).
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the time limit stays armed during the drain and ends the call when it is reached", async () => {
    const run = start({ timeoutMs: 1000 });
    await vi.advanceTimersByTimeAsync(200);
    run.exit();
    await vi.advanceTimersByTimeAsync(799);
    await flush();
    expect(run.result()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(run.result()).toMatchObject({ killed: "timeout" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
