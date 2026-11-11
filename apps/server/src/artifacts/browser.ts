import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { spawnIsolated, type SpawnIsolatedOptions } from "../isolation/sandbox.js";

/**
 * The headless browser behind PNG/PDF export (#51): Playwright's Chrome Headless Shell (the build pinned by the
 * repo's `@playwright/test`, installed with `pnpm exec playwright install --only-shell chromium`), started as its
 * own process for every render and driven over `--remote-debugging-pipe` (fd 3 in, fd 4 out — no listening port
 * another local process could use).
 */

/** Folder names of the shell inside a Playwright `chromium_headless_shell-<revision>` folder, per platform. */
const SHELL_DIRS: Record<string, string> = {
  "darwin-arm64": "chrome-headless-shell-mac-arm64",
  "darwin-x64": "chrome-headless-shell-mac-x64",
  "linux-x64": "chrome-headless-shell-linux64",
  "linux-arm64": "chrome-headless-shell-linux-arm64",
};

/** Playwright's browser cache: `PLAYWRIGHT_BROWSERS_PATH`, else its per-platform default. */
export function playwrightCache(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== "0")
    return env.PLAYWRIGHT_BROWSERS_PATH;
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "ms-playwright");
  return path.join(env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "ms-playwright");
}

/**
 * The browser executable: `configured` (EXPORT_BROWSER) when given, else the newest completely installed
 * `chromium_headless_shell-<rev>` in Playwright's cache. Undefined when there is none (export is then off).
 */
export function findBrowser(configured?: string, cache = playwrightCache()): string | undefined {
  if (configured) return fs.existsSync(configured) ? fs.realpathSync(configured) : undefined;
  const dir = SHELL_DIRS[`${process.platform}-${process.arch}`];
  if (!dir) return undefined;
  let names: string[];
  try {
    names = fs.readdirSync(cache);
  } catch {
    return undefined;
  }
  const revs = names
    .map((n) => /^chromium_headless_shell-(\d+)$/.exec(n))
    .filter((m): m is RegExpExecArray => !!m)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const m of revs) {
    const root = path.join(cache, m[0]);
    const exe = path.join(root, dir, "chrome-headless-shell");
    if (fs.existsSync(path.join(root, "INSTALLATION_COMPLETE")) && fs.existsSync(exe))
      return fs.realpathSync(exe);
  }
  return undefined;
}

/**
 * Command-line switches of every render. One process (`--single-process`: no renderer, GPU or network helper
 * processes — the sandbox forbids fork, and the memory limit then covers the whole browser). Chrome's own sandbox
 * is off because the process already runs inside ours (macOS does not nest seatbelt profiles). All traffic goes
 * to `proxy` (the allow-listed egress proxy), loopback included (`<-loopback>` removes Chrome's implicit bypass);
 * WebRTC may not send UDP around it. No background services (updates, sync, metrics, safe browsing).
 */
export function browserArgs(userDataDir: string, proxy: string | undefined): string[] {
  return [
    "--single-process",
    "--no-zygote",
    "--no-sandbox",
    "--remote-debugging-pipe",
    `--user-data-dir=${userDataDir}`,
    "--headless",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-sync",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    "--metrics-recording-only",
    "--no-pings",
    "--mute-audio",
    "--hide-scrollbars",
    "--disable-features=site-per-process,IsolateOrigins,Translate,MediaRouter,OptimizationHints,InterestFeedContentSuggestions,AutofillServerCommunication",
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
    "--disable-quic",
    ...(proxy ? [`--proxy-server=${proxy}`, "--proxy-bypass-list=<-loopback>"] : []),
    "about:blank",
  ];
}

export type LaunchSpec = {
  /** The browser executable (its folder is read-only and trusted: a program, not family data). */
  browser: string;
  args: string[];
  /** The complete environment (nothing inherited). */
  env: Record<string, string>;
  /** The render's own fresh folder: the only place the browser may write. */
  workDir: string;
  /** Loopback port of the egress proxy: the browser's only network. */
  proxyPort: number;
};

/** A started browser: its process and the two debugging pipes (fd 3 = commands in, fd 4 = replies out). */
export type Launched = { child: ChildProcess; input: Writable; output: Readable };
export type Launcher = (spec: LaunchSpec) => Launched;

const pipes = (child: ChildProcess): Launched => ({
  child,
  input: child.stdio[3] as Writable,
  output: child.stdio[4] as Readable,
});

/**
 * What the production launcher hands `spawnIsolated` — pure, so its policy (and the profile `buildProfile` makes
 * of it) is checked on every platform, Linux CI included: network = the proxy's loopback port only, reads = the
 * browser's own folder, writes = the render's folder, the given environment only, no fork (the profile never
 * allows it), the two debugging pipes.
 */
export function rendererSandbox(s: LaunchSpec): SpawnIsolatedOptions {
  return {
    command: s.browser,
    args: s.args,
    cwd: s.workDir,
    env: s.env,
    read: [],
    trusted: [path.dirname(s.browser)],
    write: [s.workDir],
    network: { loopbackPorts: [s.proxyPort] },
    extraPipes: 2,
  };
}

/**
 * The browser in the process sandbox (macOS, `isolation/sandbox.ts`): reads its own folder (plus the OS
 * libraries and fonts of `system.sb`), writes only the render's folder, cannot fork, and reaches only the egress
 * proxy's loopback port — a request that slips past every check in the browser is still refused by the kernel.
 * Throws `SandboxUnavailableError` elsewhere (export is then unavailable: fail closed).
 */
export const sandboxedLauncher: Launcher = (s) => {
  const child = spawnIsolated(rendererSandbox(s));
  // Nothing is read from stdout (stderr is drained by spawnIsolated): never let a full pipe block the browser.
  child.stdout.resume();
  return pipes(child);
};

/**
 * The same browser without the process sandbox — **tests only** (Linux CI has no sandbox-exec): everything in
 * the browser (switches, request interception, the egress proxy) is the same; the kernel layer is missing.
 */
export const unsandboxedLauncher: Launcher = (s) =>
  pipes(
    spawn(s.browser, s.args, {
      cwd: s.workDir,
      env: s.env,
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    }),
  );

/**
 * A DevTools protocol reply or event, after `parseMessage`. Everything on the pipe comes from the browser, which
 * runs untrusted documents in its own process (`--single-process --no-sandbox`): a compromised renderer controls
 * fd 4. So every message is checked before use, and anything malformed ends that render — never the server.
 */
export type Message = {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: unknown;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The shape of one pipe message, or undefined when it is not one (wrong JSON type, field types, neither kind). */
export function parseMessage(text: string): Message | undefined {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(v)) return undefined;
  const m: Message = {};
  if (v.id !== undefined) {
    if (!Number.isSafeInteger(v.id) || (v.id as number) < 1) return undefined;
    m.id = v.id as number;
  }
  if (v.method !== undefined) {
    if (typeof v.method !== "string") return undefined;
    m.method = v.method;
  }
  if (v.sessionId !== undefined) {
    if (typeof v.sessionId !== "string") return undefined;
    m.sessionId = v.sessionId;
  }
  for (const k of ["params", "result"] as const)
    if (v[k] !== undefined) {
      const x = v[k];
      if (!isObject(x)) return undefined;
      m[k] = x;
    }
  if (v.error !== undefined) m.error = v.error;
  // A reply has an id; an event has a method; nothing else is a message.
  if ((m.id === undefined) === (m.method === undefined)) return undefined;
  return m;
}

export class CdpError extends Error {
  constructor(readonly code: "closed" | "too_large" | "protocol") {
    super(`cdp ${code}`);
  }
}

/** A promise whose rejection is never "unhandled" (the caller may await it later — or not at all). */
function quiet<T>(p: Promise<T>): Promise<T> {
  p.catch(() => {});
  return p;
}

/**
 * DevTools protocol over the debugging pipe: NUL-separated JSON messages. Incoming bytes are bounded
 * (`maxBytes` per message): a reply larger than that (a huge screenshot) closes the connection. A malformed
 * message, or a listener that throws on one, closes it too (`protocol`); the render then fails and its process
 * is killed. No promise of this class can reject unhandled (`quiet`), so a browser that dies at any moment
 * cannot take the server down.
 */
export class CdpPipe {
  private next = 1;
  private readonly pending = new Map<number, { resolve: (r: Message) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<(m: Message) => void>();
  private chunks: Buffer[] = [];
  private size = 0;
  private closed: CdpError | undefined;
  private readonly waiters = new Set<(e: CdpError) => void>();
  private readonly closeHandlers = new Set<(e: CdpError) => void>();

  constructor(
    private readonly input: Writable,
    output: Readable,
    private readonly maxBytes: number,
  ) {
    output.on("data", (d: Buffer) => {
      try {
        this.take(d);
      } catch {
        this.close(new CdpError("protocol"));
      }
    });
    output.on("error", () => this.close(new CdpError("closed")));
    output.on("close", () => this.close(new CdpError("closed")));
    input.on("error", () => this.close(new CdpError("closed")));
  }

  private take(d: Buffer) {
    if (this.closed) return;
    let start = 0;
    for (let i = d.indexOf(0); i !== -1; i = d.indexOf(0, start)) {
      this.chunks.push(d.subarray(start, i));
      this.size += i - start;
      if (this.size > this.maxBytes) return this.close(new CdpError("too_large"));
      const text = Buffer.concat(this.chunks).toString("utf8");
      this.chunks = [];
      this.size = 0;
      start = i + 1;
      const m = parseMessage(text);
      if (!m) return this.close(new CdpError("protocol"));
      this.dispatch(m);
      if (this.closed) return;
    }
    const rest = d.subarray(start);
    this.size += rest.length;
    if (this.size > this.maxBytes) return this.close(new CdpError("too_large"));
    if (rest.length) this.chunks.push(rest);
  }

  private dispatch(m: Message) {
    if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      // A reply to nothing we asked: the other side is not following the protocol.
      if (!p) return this.close(new CdpError("protocol"));
      this.pending.delete(m.id);
      if (m.error !== undefined) p.reject(new CdpError("protocol"));
      else p.resolve(m);
      return;
    }
    for (const l of [...this.listeners]) {
      try {
        l(m);
      } catch {
        return this.close(new CdpError("protocol"));
      }
    }
  }

  /** Why the connection ended, if it did. */
  get error(): CdpError | undefined {
    return this.closed;
  }

  /** Called once when the connection ends (the renderer kills the process on a protocol error). */
  onClose(fn: (e: CdpError) => void) {
    if (this.closed) fn(this.closed);
    else this.closeHandlers.add(fn);
  }

  close(e: CdpError) {
    if (this.closed) return;
    this.closed = e;
    this.chunks = [];
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
    for (const w of this.waiters) w(e);
    this.waiters.clear();
    for (const h of this.closeHandlers) h(e);
    this.closeHandlers.clear();
  }

  /** One command; resolves with its `result` object (`{}` when there is none). */
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string) {
    if (this.closed) return quiet(Promise.reject<Record<string, unknown>>(this.closed));
    const id = this.next++;
    return quiet(
      new Promise<Record<string, unknown>>((resolve, reject) => {
        this.pending.set(id, { resolve: (m) => resolve(m.result ?? {}), reject });
        this.input.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
      }),
    );
  }

  /** Calls `fn` for every event (until the returned function is called). */
  on(fn: (m: Message) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** The next event `method` (of `sessionId`); rejects when the connection ends first. */
  wait(method: string, sessionId?: string) {
    return quiet(
      new Promise<Record<string, unknown>>((resolve, reject) => {
        if (this.closed) return reject(this.closed);
        const fail = (e: CdpError) => {
          off();
          reject(e);
        };
        this.waiters.add(fail);
        const off = this.on((m) => {
          if (m.method === method && (!sessionId || m.sessionId === sessionId)) {
            off();
            this.waiters.delete(fail);
            resolve(m.params ?? {});
          }
        });
      }),
    );
  }
}
