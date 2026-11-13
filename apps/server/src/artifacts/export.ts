import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ARTIFACT_EXPORT_FORMATS,
  ARTIFACT_EXPORTS,
  type ArtifactExportFormat,
  type ArtifactKind,
} from "@agentlee/shared";
import { EgressService, type EgressOptions } from "../isolation/egress.js";
import { snapshot } from "../isolation/sandbox.js";
import { z } from "zod";
import { REAP_RETRIES } from "../python/runner.js";
import {
  reapWorker,
  workerLauncherRun,
  LAUNCHER_MAX_SEC,
  type VerifiedWorker,
  type WorkerAccount,
} from "../workers/account.js";
import { makeWorkerJobDir, removeWorkerJob, type WorkerSpawn } from "../workers/run.js";
import {
  browserArgs,
  CdpError,
  CdpPipe,
  sandboxedLauncher,
  type Launched,
  type Launcher,
} from "./browser.js";
import { CDN_ALLOW_LIST, escapeHtml, page, serveVersion, type Served } from "./serve.js";

/**
 * PNG and PDF export of artifacts (#51, PRD FR-6.4; docs/decisions/isolation.md "아티팩트 내보내기 (#51)").
 *
 * Every export is one fresh headless browser process (`browser.ts`) that knows nothing of the app: a new, empty
 * profile folder (no cookies, no storage, no session), an environment of two variables, and a document handed
 * over the debugging pipe — the browser never opens the app's origin. The document is the same as the served
 * original (`serveVersion`), with the same CSP headers (opaque origin, `connect-src 'none'`, scripts by hash and
 * the exact CDN URLs). Around it, three independent network layers:
 *  1. request interception in the browser: the document's own fake URL once, the exact `CDN_ALLOW_LIST` URLs,
 *     nothing else (this also catches the one thing CSP does not stop — the document navigating itself);
 *  2. every connection goes to an egress proxy that allows CONNECT to the CDN host on 443 only (and, being the
 *     #42 proxy, never to loopback, private, link-local or metadata addresses);
 *  3. the macOS process sandbox: the process can reach only that proxy's loopback port.
 * Time, memory (RSS of the one process — `--single-process`, no fork) and reply size are limited; past a limit
 * the process group is killed.
 *
 * Under the worker account (#122, `workers/account.ts`) — once its render self-check passed — the browser is not
 * started by the server at all: the server asks the root-owned launcher (`sudo -u <account> … run render <job>
 * <timeout> <proxy port>`), which starts the root-owned copy of the same browser with the same switches and the same
 * profile rules, as a **different uid**, and relays the debugging pipe over its stdin/stdout. Chrome's own sandbox
 * stays off (`--no-sandbox`: macOS does not nest seatbelt profiles) — the boundary is the seatbelt profile plus the
 * other uid, which a renderer exploit would also have to cross to read a runtime's start-up environment. The render
 * folder is a job folder under `worker-scratch/`; the launcher watches time and memory and the server stops a
 * render by asking the launcher to `reap` it (it cannot signal another uid).
 */

export const EXPORT_FORMATS = ARTIFACT_EXPORT_FORMATS;
export type ExportFormat = ArtifactExportFormat;

/** Outcome codes of an export (logged as `exportCode`, answered as `{ error }`). */
export const EXPORT_CODES = [
  "export_ok",
  "export_unavailable",
  "export_busy",
  "export_timeout",
  "export_limit",
  "export_failed",
] as const;
export type ExportCode = (typeof EXPORT_CODES)[number];

export const exportFormats = (kind: ArtifactKind): readonly ExportFormat[] => ARTIFACT_EXPORTS[kind];

const PRE_STYLE =
  "pre{white-space:pre-wrap;word-break:break-word;font:12px/1.5 ui-monospace,Menlo,monospace}";

/**
 * The document a version is exported from: the served original (same body, same CSP), except markdown and code,
 * which are served as text/plain and are printed as a page with the text (escaped, no script).
 */
export function exportDocument(kind: ArtifactKind, title: string, content: string): Served | undefined {
  if (kind === "markdown" || kind === "code") {
    const served = serveVersion(kind, title, content)!;
    return {
      type: "text/html; charset=utf-8",
      body: page(
        title,
        `<style>${PRE_STYLE}</style><h1>${escapeHtml(title)}</h1><pre>${escapeHtml(content)}</pre>`,
      ),
      csp: served.csp,
    };
  }
  return serveVersion(kind, title, content);
}

/** The fake address the document is delivered at (`.invalid` never resolves; nothing is fetched from it). */
export const DOCUMENT_URL = "https://artifact.invalid/";
/** Host names the renderer's egress proxy allows (CONNECT, port 443): the hosts of `CDN_ALLOW_LIST`. */
export const RENDER_EGRESS_HOSTS = [...new Set(CDN_ALLOW_LIST.map((c) => new URL(c.url).hostname))];

export const RENDER_LIMITS = {
  /** Whole render: start, load, scripts, capture. */
  timeoutMs: 20_000,
  /** Resident memory of the browser process (checked every 250 ms). */
  maxRssBytes: 768 * 1024 * 1024,
  /** One DevTools reply (the base64 PNG/PDF). */
  maxReplyBytes: 48 * 1024 * 1024,
  /** The file itself. */
  maxFileBytes: 32 * 1024 * 1024,
  /** Renders at once, and how many more may wait for a slot (beyond that → `export_busy`). */
  concurrent: 2,
  queue: 4,
  /** Time scripts of an HTML artifact get after load (chart animations). */
  settleMs: 1200,
  /** PNG: CSS width and the cap on the captured height. */
  width: 800,
  maxHeight: 6000,
};

export type RenderJob = { format: ExportFormat; doc: Served; scripts: boolean };
export type RenderResult =
  { ok: true; body: Buffer; type: string } | { ok: false; code: Exclude<ExportCode, "export_ok"> };

/** Tests only: switch one network layer off to check the others alone, and look inside after the load. */
export type RenderTestHooks = {
  /** Default true: send the document's CSP headers. */
  csp?: boolean;
  /** Default true: browser request interception. */
  intercept?: boolean;
  /** Default true: the `--proxy-server` switch. */
  proxy?: boolean;
  /** Changes the browser switches (e.g. drop the WebRTC policy to show the kernel stops UDP by itself). */
  args?: (args: string[]) => string[];
  /** More URLs interception lets through (redirect tests). */
  allowUrls?: string[];
  /** Called after load with a DevTools `send` bound to the page (e.g. to read cookies). */
  afterLoad?: (send: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<void>;
  /** What the browser was started with. */
  launched?: (spec: { args: string[]; env: Record<string, string>; workDir: string }) => void;
  /** Requests refused by interception (counted, not logged). */
  blocked?: (url: string) => void;
  probe?: () => Promise<{ pid: number; rss: number }[]>;
};

export type RendererOptions = {
  /** The browser executable (`findBrowser`); undefined = export unavailable. */
  browser: string | undefined;
  launcher?: Launcher;
  /** Egress proxy options besides the allow-list (tests: name resolution and upstream connect). */
  egress?: Omit<EgressOptions, "allow">;
  limits?: Partial<typeof RENDER_LIMITS>;
  /** Parent of the per-render folders (default: the OS temp folder). */
  tmpDir?: string;
  test?: RenderTestHooks;
  /** The worker account (#122): renders run through its launcher while `verified()` gives one. */
  account?: AccountRendering;
};

export type AccountRendering = {
  verified: () => VerifiedWorker | undefined;
  dataDir: string;
  /** Tests only: replace the spawn of sudo, the reap and the clean of a job. */
  spawn?: WorkerSpawn;
  reap?: (account: WorkerAccount, jobId: string, onExit: (code: number | null) => void) => void;
  clean?: (account: WorkerAccount, jobId: string) => void;
};

/** One render through the worker account: who, and (the self-check) a look at the job before it is removed. */
export type RenderVia = { worker: VerifiedWorker; onJob?: ((jobId: string) => void) | undefined };

const defaultWorkerSpawn: WorkerSpawn = (command, args) =>
  spawn(command, args, { env: {}, stdio: ["pipe", "pipe", "pipe"], detached: true });

/**
 * Shapes of the replies and events the renderer uses. The browser is untrusted (it runs the artifact in its own
 * process): a reply that does not match fails the render (`export_failed`) — nothing is used unchecked.
 */
const TargetCreated = z.object({ targetId: z.string().min(1).max(200) });
const Attached = z.object({ sessionId: z.string().min(1).max(200) });
const Data = z.object({ data: z.string().regex(/^[A-Za-z0-9+/]*={0,2}$/) });
const Size = z.number().finite().nonnegative();
const Metrics = z.object({ cssContentSize: z.object({ width: Size, height: Size }) });
const RequestPaused = z.object({
  requestId: z.string().min(1).max(200),
  request: z.object({ url: z.string().max(1_000_000) }),
  resourceType: z.string().max(100).optional(),
});

export class BadReplyError extends Error {
  constructor() {
    super("bad devtools reply");
  }
}
function reply<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new BadReplyError();
  return r.data;
}

type Session = {
  send: (method: string, params?: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

export class Renderer {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  private readonly limits: typeof RENDER_LIMITS;
  private readonly egress: EgressService;
  private readonly launcher: Launcher;

  constructor(private readonly o: RendererOptions) {
    this.limits = { ...RENDER_LIMITS, ...o.limits };
    this.egress = new EgressService({ ...o.egress, allow: RENDER_EGRESS_HOSTS });
    this.launcher = o.launcher ?? sandboxedLauncher;
  }

  get available(): boolean {
    return !!this.o.browser || !!this.o.account?.verified();
  }

  close(): Promise<void> {
    return this.egress.close();
  }

  /**
   * One render. Through the worker account when `via` names one (the self-check) or the account's render check has
   * passed (`account.verified()`); otherwise the same-uid sandbox with `browser`.
   */
  async render(job: RenderJob, via?: RenderVia): Promise<RenderResult> {
    const worker = via?.worker ?? this.o.account?.verified();
    if (!worker && !this.o.browser) return { ok: false, code: "export_unavailable" };
    if (this.active >= this.limits.concurrent) {
      // A few wait for a free slot (each render is short); beyond that the caller is told to come back.
      if (this.queue.length >= this.limits.queue) return { ok: false, code: "export_busy" };
      await new Promise<void>((resolve) => this.queue.push(resolve));
    } else this.active++;
    try {
      return await this.run(this.o.browser, job, worker ? { worker, onJob: via?.onJob } : undefined);
    } finally {
      // Hand the slot straight to the next waiter (it never counted itself), or free it.
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }

  /** The browser through the worker launcher: its stdin/stdout are the debugging pipe (the launcher relays). */
  private launchAsAccount(account: WorkerAccount, jobId: string, proxyPort: number): Launched {
    // The launcher's own limit is a backstop a little past ours (the server stops a render first, by reap).
    const timeoutSec = Math.min(LAUNCHER_MAX_SEC.render, Math.ceil(this.limits.timeoutMs / 1000) + 5);
    const { command, args } = workerLauncherRun(account, "render", jobId, timeoutSec, proxyPort);
    const child = (this.o.account?.spawn ?? defaultWorkerSpawn)(command, args);
    // The launcher's own messages: read (never let a full pipe block it), not kept.
    child.stderr?.resume();
    return { child, input: child.stdin!, output: child.stdout! };
  }

  private async run(browser: string | undefined, job: RenderJob, via?: RenderVia): Promise<RenderResult> {
    const t = this.o.test ?? {};
    const L = this.limits;
    let proxy;
    try {
      proxy = await this.egress.endpoint();
    } catch {
      return { ok: false, code: "export_unavailable" };
    }
    // A fresh, empty profile per render: no cookies, storage or cache of anyone, removed afterwards. Under the
    // account: a job folder of the worker scratch (the launcher finds it by the job id alone).
    const worker = via?.worker;
    const dataDir = this.o.account?.dataDir;
    let made: { jobId: string; dir: string } | undefined;
    let workDir: string;
    try {
      if (worker) {
        if (!dataDir) return { ok: false, code: "export_unavailable" };
        made = makeWorkerJobDir(dataDir);
        workDir = made.dir;
      } else
        workDir = fs.realpathSync(
          fs.mkdtempSync(path.join(this.o.tmpDir ?? os.tmpdir(), "agentlee-render-")),
        );
    } catch {
      return { ok: false, code: "export_unavailable" };
    }
    const removeWorkDir = () => {
      if (made && worker && dataDir) {
        try {
          via?.onJob?.(made.jobId);
        } catch {
          // the self-check's look never decides the clean-up
        }
        removeWorkerJob(worker.account, dataDir, made.jobId, this.o.account?.clean);
      } else fs.rmSync(workDir, { recursive: true, force: true });
    };
    const home = path.join(workDir, "home");
    const tmp = path.join(workDir, "tmp");
    const profile = path.join(workDir, "profile");
    for (const d of [home, tmp, profile]) fs.mkdirSync(d, { mode: 0o700 });
    const env = { HOME: home, TMPDIR: tmp };
    const base = browserArgs(profile, t.proxy === false ? undefined : proxy.url);
    const args = t.args ? t.args(base) : base;
    t.launched?.({ args, env, workDir });

    let launched;
    try {
      launched =
        worker && made
          ? this.launchAsAccount(worker.account, made.jobId, proxy.port)
          : this.launcher({ browser: browser!, args, env, workDir, proxyPort: proxy.port });
    } catch {
      removeWorkDir();
      return { ok: false, code: "export_unavailable" };
    }
    const { child, input, output } = launched;
    const pid = child.pid;
    let killed: "timeout" | "memory" | "monitor" | "protocol" | undefined;
    let exited = false;
    let exitCode: number | null = null;
    const exit = new Promise<void>((resolve) => {
      child.once("exit", (code) => {
        exited = true;
        exitCode = code;
        resolve();
      });
      child.once("error", () => {
        exited = true;
        resolve();
      });
    });
    // Under the account the server cannot signal the browser (another uid): the launcher's reap kills the
    // recorded, verified process (retried while it could not verify, python_run's rule), and our ends of the pipes
    // close so nothing waits on them.
    const reapOnce = (left: number) => {
      if (!worker || !made) return;
      const jobId = made.jobId;
      (this.o.account?.reap ?? reapWorker)(worker.account, jobId, (code) => {
        if (code !== 0 && left > 0 && !exited) setTimeout(() => reapOnce(left - 1), 500).unref();
      });
    };
    const kill = (why: NonNullable<typeof killed>) => {
      if (exited) return;
      if (worker) {
        if (killed) return;
        killed = why;
        reapOnce(REAP_RETRIES);
        input.destroy();
        output.destroy();
        return;
      }
      killed ??= why;
      try {
        process.kill(-pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const cdp = new CdpPipe(input, output, L.maxReplyBytes);
    const timer = setTimeout(() => {
      kill("timeout");
      cdp.close(new CdpError("closed"));
    }, L.timeoutMs);
    // Memory of the one browser process; not measurable while it runs → stop (fail closed). Under the account the
    // launcher watches it (every 250 ms, exit 125 over the limit): the server's pid is sudo's.
    let sampling = false;
    const monitor = setInterval(() => {
      if (worker || sampling || exited || !pid) return;
      sampling = true;
      (t.probe ?? (() => snapshot(pid)))()
        .then((procs) => {
          const me = procs.find((p) => p.pid === pid);
          if (!me) {
            if (!exited) kill("monitor");
          } else if (me.rss * 1024 > L.maxRssBytes) kill("memory");
        })
        .catch(() => kill("monitor"))
        .finally(() => (sampling = false));
    }, 250);
    child.once("exit", () => cdp.close(new CdpError("closed")));
    // A browser that breaks the protocol (malformed or oversized messages — possibly a compromised renderer) is
    // not asked to close: it is killed at once.
    cdp.onClose((e) => {
      if (e.code !== "closed") kill("protocol");
    });

    let result: RenderResult;
    try {
      const body = await this.drive(cdp, job);
      result =
        body.length > L.maxFileBytes
          ? { ok: false, code: "export_limit" }
          : { ok: true, body, type: job.format === "png" ? "image/png" : "application/pdf" };
    } catch (e) {
      result = {
        ok: false,
        code: e instanceof CdpError && e.code === "too_large" ? "export_limit" : "export_failed",
      };
    }
    // The launcher's own limits (account mode): 124 its wall clock, 125 its memory watch.
    if (worker && !killed && exited) {
      if (exitCode === 124) killed = "timeout";
      else if (exitCode === 125) killed = "memory";
    }
    if (killed === "timeout") result = { ok: false, code: "export_timeout" };
    else if (killed === "protocol")
      result = { ok: false, code: cdp.error?.code === "too_large" ? "export_limit" : "export_failed" };
    else if (killed) result = { ok: false, code: "export_limit" };
    clearTimeout(timer);
    clearInterval(monitor);
    // A failed render (bad reply, protocol error, limit) is killed outright; a good one is closed politely, then
    // made sure of: the whole process group goes either way.
    if (!result.ok) kill("protocol");
    if (!exited) {
      void cdp.send("Browser.close");
      const hard = setTimeout(() => kill("monitor"), 2000);
      await exit;
      clearTimeout(hard);
    }
    cdp.close(new CdpError("closed"));
    removeWorkDir();
    return result;
  }

  /** Opens the document in a new page and captures it. */
  private async drive(cdp: CdpPipe, job: RenderJob): Promise<Buffer> {
    const t = this.o.test ?? {};
    const L = this.limits;
    const { targetId } = reply(TargetCreated, await cdp.send("Target.createTarget", { url: "about:blank" }));
    const { sessionId } = reply(
      Attached,
      await cdp.send("Target.attachToTarget", { targetId, flatten: true }),
    );
    const s: Session = { send: (m, p) => cdp.send(m, p ?? {}, sessionId) };

    // Layer 1: every request of the page stops here. The document is delivered once; exact CDN URLs go on (to the
    // proxy); anything else — the app, loopback, the home network, other hosts, the document navigating itself —
    // fails without leaving the browser.
    let delivered = false;
    const cdn = new Set([...CDN_ALLOW_LIST.map((c) => c.url), ...(t.allowUrls ?? [])]);
    const off = cdp.on((m) => {
      if (m.method !== "Fetch.requestPaused" || m.sessionId !== sessionId) return;
      // Throws on a malformed event: the pipe then closes and the render fails (CdpPipe.dispatch).
      const p = RequestPaused.parse(m.params);
      const url = p.request.url;
      if (url === DOCUMENT_URL && !delivered && p.resourceType === "Document") {
        delivered = true;
        const headers = [
          { name: "Content-Type", value: job.doc.type },
          { name: "X-Content-Type-Options", value: "nosniff" },
          ...(t.csp === false
            ? []
            : job.doc.csp.map((value) => ({ name: "Content-Security-Policy", value }))),
        ];
        void s.send("Fetch.fulfillRequest", {
          requestId: p.requestId,
          responseCode: 200,
          responseHeaders: headers,
          body: Buffer.from(job.doc.body, "utf8").toString("base64"),
        });
      } else if (cdn.has(url) || t.intercept === false) {
        void s.send("Fetch.continueRequest", { requestId: p.requestId });
      } else {
        t.blocked?.(url);
        void s.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "BlockedByClient" });
      }
    });
    try {
      await s.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
      await s.send("Page.enable");
      await s.send("Emulation.setEmulatedMedia", {
        media: job.format === "pdf" ? "print" : "screen",
        features: [{ name: "prefers-color-scheme", value: "light" }],
      });
      await s.send("Emulation.setDeviceMetricsOverride", {
        width: L.width,
        // Small: the capture takes the content's own height (the layout grows to fit it).
        height: 100,
        deviceScaleFactor: job.format === "png" ? 2 : 1,
        mobile: false,
      });
      if (!job.scripts) await s.send("Emulation.setScriptExecutionDisabled", { value: true });
      // Both at once: if the browser goes away during the navigation, both reject and both are handled here.
      await Promise.all([
        cdp.wait("Page.loadEventFired", sessionId),
        s.send("Page.navigate", { url: DOCUMENT_URL }),
      ]);
      await s.send("Runtime.evaluate", {
        expression: "document.fonts.ready.then(() => 1)",
        awaitPromise: true,
      });
      if (job.scripts) await new Promise((r) => setTimeout(r, L.settleMs));
      await t.afterLoad?.((m, p) => s.send(m, p));
      if (job.format === "pdf") {
        const { data } = reply(
          Data,
          await s.send("Page.printToPDF", {
            printBackground: true,
            preferCSSPageSize: true,
            paperWidth: 8.27,
            paperHeight: 11.69,
            marginTop: 0.4,
            marginBottom: 0.4,
            marginLeft: 0.4,
            marginRight: 0.4,
          }),
        );
        return Buffer.from(data, "base64");
      }
      const metrics = reply(Metrics, await s.send("Page.getLayoutMetrics"));
      const width = Math.min(Math.ceil(metrics.cssContentSize.width), L.width * 2);
      const height = Math.min(Math.ceil(metrics.cssContentSize.height), L.maxHeight);
      const { data } = reply(
        Data,
        await s.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: Math.max(width, 1), height: Math.max(height, 1), scale: 1 },
        }),
      );
      return Buffer.from(data, "base64");
    } finally {
      off();
    }
  }
}
