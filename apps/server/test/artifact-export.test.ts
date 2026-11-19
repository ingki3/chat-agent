import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { type Readable, Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ARTIFACT_EXPORTS, type ArtifactKind } from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import {
  browserArgs,
  findBrowser,
  killLiveRenders,
  liveRenderCount,
  onRenderReapIncomplete,
  parseMessage,
  browserPattern,
  cmdlinePattern,
  parsePs,
  psListing,
  type PsRun,
  reapAfterWatchdog,
  reapingRenderCount,
  releaseRenderDir,
  renderReaped,
  setRenderReapForTests,
  signalRender,
  trackRender,
  makeRenderDir,
  removeRenderDir,
  renderLockPath,
  SWEEP_PL,
  SWEEP_STOP_WAIT_MS,
  startRenderSweeps,
  WATCHDOG_EXIT,
  type Launched,
  type RenderDir,
  rendererSandbox,
  sandboxedLauncher,
  sweepRenderDirs,
  unsandboxedLauncher,
  watchdogPrefix,
  type Launcher,
} from "../src/artifacts/browser.js";
import {
  closeRenderers,
  DOCUMENT_URL,
  EXPORT_CODES,
  RENDER_EGRESS_HOSTS,
  Renderer,
  exportDocument,
  type RenderJob,
  type RendererOptions,
  type RenderResult,
} from "../src/artifacts/export.js";
import { CDN_ALLOW_LIST } from "../src/artifacts/serve.js";
import { EXPORT_CODES as LOGGABLE_EXPORT_CODES } from "../src/observability/policy.js";
import { buildProfile, runIsolated, snapshot } from "../src/isolation/sandbox.js";
import { REPO_ROOT } from "../src/config.js";
import { createFamily } from "./helpers/permission-matrix.js";

/**
 * PNG/PDF export (#51). The browser tests start the real Chrome Headless Shell from Playwright's cache: on macOS in
 * the real process sandbox (the production launcher), elsewhere (Linux CI) without it — every layer inside the
 * browser is the same, the kernel layer has its own macOS test. CI installs the shell (`ci.yml`); a developer
 * machine without it skips these (with a note), CI never does.
 */

const darwin = process.platform === "darwin";
const BROWSER = findBrowser();
if (!BROWSER && process.env.CI) throw new Error("CI must install the headless shell (playwright install)");
const PROD_LAUNCHER: Launcher = darwin ? sandboxedLauncher : unsandboxedLauncher;

const closers: (() => Promise<unknown>)[] = [];
// The cleanup has its own budget (#207): on a loaded machine removing a test's folders (one holds 40 000 files) took
// longer than the default 10 s.
afterEach(async () => {
  while (closers.length) await closers.pop()!();
}, 60_000);

/** "The app": a local server on 127.0.0.1 that records every request it gets (path and cookie header). */
const app = {
  port: 0,
  hits: [] as { url: string; cookie: string | undefined }[],
  server: undefined as http.Server | undefined,
};
beforeAll(async () => {
  app.server = http.createServer((req, res) => {
    app.hits.push({ url: req.url ?? "", cookie: req.headers.cookie });
    if (req.url === "/redirect-to-api")
      return void res.writeHead(302, { location: "/api/after-redirect" }).end();
    res
      .writeHead(200, { "content-type": "text/plain", "access-control-allow-origin": "*" })
      .end("APP-SECRET");
  });
  await new Promise<void>((r) => app.server!.listen(0, "127.0.0.1", () => r()));
  app.port = (app.server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => app.server!.close(() => r())));

/** The egress proxy's name resolution and upstream connections, recorded (nothing reaches the internet). */
function spyEgress() {
  const lookups: string[] = [];
  const connects: string[] = [];
  return {
    lookups,
    connects,
    egress: {
      lookup: async (host: string) => {
        lookups.push(host);
        return ["93.184.216.34"];
      },
      connect: (ip: string, port: number) => {
        connects.push(`${ip}:${port}`);
        // A port nothing listens on: the tunnel fails at once.
        return net.connect({ host: "127.0.0.1", port: 9 });
      },
    },
  };
}

/**
 * The tests' own budgets (#207), apart from the product's limits (`RENDER_LIMITS`): on a loaded CI runner one render
 * took longer than the product's 20 s cap, and one `ps` sample longer than its 2 s, so renders whose test is about
 * something else failed (`export_timeout` / `export_limit` where `ok` was asserted, or a navigation that never came).
 * Here a render is bounded by its test's own time limit instead; the limits themselves are tested with their own
 * values (the time limit, the watchdog's cap, the memory limit and its fail-closed rule). A test that sets a limit
 * keeps it.
 */
const TEST_RENDER_MS = 60_000;
const TEST_SAMPLE_MS = 15_000;
/** Tests that drive the real browser: room for a couple of renders at their own budget on a loaded machine (#207). */
const SLOW = { timeout: 120_000 };

function renderer(o: Partial<RendererOptions> = {}) {
  const spy = spyEgress();
  const blocked: string[] = [];
  const r = new Renderer({
    browser: BROWSER,
    launcher: PROD_LAUNCHER,
    egress: spy.egress,
    ...o,
    limits: { timeoutMs: TEST_RENDER_MS, sampleTimeoutMs: TEST_SAMPLE_MS, ...o.limits },
    test: { blocked: (u) => blocked.push(u), ...o.test },
  });
  closers.push(() => r.close());
  return { r, blocked, ...spy };
}

const chart = JSON.stringify({
  type: "bar",
  title: "월별 매출",
  labels: ["1월", "2월", "3월", "4월"],
  series: [
    { name: "매출", values: [3, 7, 5, 9] },
    { name: "비용", values: [2, 4, 4, 6] },
  ],
});
const job = (kind: ArtifactKind, content: string, format: "png" | "pdf"): RenderJob => ({
  format,
  doc: exportDocument(kind, "샘플", content)!,
  scripts: kind === "html",
});
const isPng = (b: Buffer) =>
  b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const pngSize = (b: Buffer) => ({ width: b.readUInt32BE(16), height: b.readUInt32BE(20) });
const isPdf = (b: Buffer) => b.subarray(0, 5).toString("latin1") === "%PDF-";
const ok = (r: RenderResult) => {
  if (!r.ok) throw new Error(`render failed: ${r.code}`);
  return r.body;
};

/**
 * Every way a document can ask for the app (loopback), the home network, metadata or another host. `outside: false`
 * (the control with every layer off) leaves out the addresses beyond this machine: with nothing in the way those
 * really go out, and an address that does not answer holds the page's load back (#207) — the control is about the
 * navigation to the app.
 */
function attackHtml(port: number, { outside = true } = {}) {
  const app = `http://127.0.0.1:${port}`;
  const far = (html: string) => (outside ? html : "");
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${app}/api/css">
<link rel="prefetch" href="${app}/api/prefetch">
<script src="${app}/api/script.js"></script>
</head><body><h1>공격 문서</h1>
<img src="${app}/api/img">${far(`<img src="http://10.0.0.1/x.png"><img src="http://192.168.1.1/x.png">
<img src="http://169.254.169.254/latest/meta-data/">`)}<img src="http://localhost:${port}/api/localhost">
<img src="http://[::1]:${port}/api/v6">${far(`<img src="https://example.org/public.png">`)}
<iframe src="${app}/api/frame"></iframe>
<script>
  fetch("${app}/api/conversations", { credentials: "include" }).catch(() => {});
  ${far(`fetch("http://10.0.0.1/api/x").catch(() => {});`)}
  navigator.sendBeacon && navigator.sendBeacon("${app}/api/beacon", "x");
  try { new WebSocket("ws://127.0.0.1:${port}/api/ws"); } catch (e) {}
  // CSP does not stop a document from navigating itself: the renderer must. (Its own code, called once the page has
  // loaded, see selfNavigation — not on a timer of its own.)
  window.go = () => setTimeout(() => { location.href = "${app}/api/nav"; });
</script></body></html>`;
}

/**
 * Polls until `cond()` holds; throws past `ms` (below the tests' render budget, so a wait that never ends fails the
 * render — `export_failed` — instead of leaving it, and the test, hanging).
 */
async function until(cond: () => boolean, ms = 25_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * A document that navigates itself (its `go()`), started by the test after the load, then waited for (#207). With
 * the document's own timer (e.g. 50 ms) the navigation raced the renderer: on a loaded machine it could land while the
 * renderer still waited for the fonts — "Inspected target navigated or closed", `export_failed` where `ok` was
 * asserted — or only after the capture, so the navigation the test was about never happened. Here the test calls
 * `go()` once the page is loaded and waits until the page asked for a URL ending in `suffix` (the renderer saw the
 * request: refused or let through), the main frame then showed another page (the error page, or the app when every
 * layer is off) and loaded it, and `also()` holds. The capture then takes a page that no longer changes.
 */
function selfNavigation(suffix: string, also: () => boolean = () => true) {
  let requested = false;
  let navigated = false;
  let loaded = false;
  return {
    events: (method: string, params: Record<string, unknown>) => {
      if (method === "Fetch.requestPaused") {
        const url = (params.request as { url?: unknown } | undefined)?.url;
        if (typeof url === "string" && url.endsWith(suffix)) requested = true;
      } else if (method === "Page.frameNavigated") {
        const frame = params.frame as { parentId?: unknown; url?: unknown } | undefined;
        if (frame && frame.parentId === undefined && frame.url !== DOCUMENT_URL) navigated = true;
      } else if (method === "Page.loadEventFired" && navigated) loaded = true;
    },
    afterLoad: async (send: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => {
      // Per render (one renderer may render the document more than once).
      requested = navigated = loaded = false;
      // `go()` navigates in a task of its own, after this reply.
      await send("Runtime.evaluate", { expression: "go()" });
      await until(() => requested && loaded && also());
    },
  };
}

describe.skipIf(!BROWSER)("isolated renderer (real headless shell)", SLOW, () => {
  it("samples: a chart PNG and a document PDF (also table, markdown and code PDFs, and an SVG PNG)", async () => {
    const { r } = renderer();
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-export-sample-"));
    closers.push(async () => fs.rmSync(out, { recursive: true, force: true }));

    const png = ok(await r.render(job("chart", chart, "png")));
    expect(isPng(png)).toBe(true);
    // 800 CSS px at device scale 2, the content's own height (not a fixed viewport).
    expect(pngSize(png).width).toBe(1600);
    expect(pngSize(png).height).toBeGreaterThan(400);
    expect(pngSize(png).height).toBeLessThan(1200);
    fs.writeFileSync(path.join(out, "chart.png"), png);

    const doc = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>문서</title></head><body>
<h1>가족 여행 계획</h1><p>첫째 날: 바다</p><p id="s"></p>
<script>document.getElementById("s").textContent = "스크립트가 그린 줄";</script></body></html>`;
    const pdf = ok(await r.render(job("html", doc, "pdf")));
    expect(isPdf(pdf)).toBe(true);
    expect(pdf.toString("latin1")).toMatch(/\/Type\s*\/Page\b/);
    fs.writeFileSync(path.join(out, "document.pdf"), pdf);

    const table = JSON.stringify({ columns: ["종목", "가격"], rows: [["삼성전자", 70000]] });
    expect(isPdf(ok(await r.render(job("table", table, "pdf"))))).toBe(true);
    expect(isPdf(ok(await r.render(job("markdown", "# 제목\n\n- 항목 <b>굵게</b>", "pdf"))))).toBe(true);
    expect(isPdf(ok(await r.render(job("code", "print('hi')", "pdf"))))).toBe(true);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#2f6fb0"/></svg>`;
    expect(isPng(ok(await r.render(job("svg", svg, "png"))))).toBe(true);
    expect(fs.readdirSync(out).sort()).toEqual(["chart.png", "document.pdf"]);
  }, 180_000); // six real renders: their own budget on a loaded machine (#207)

  it("an artifact asking for the app (127.0.0.1:<port>/api/…), private IPs, metadata or other hosts gets nothing", async () => {
    app.hits.length = 0;
    const { r, blocked, lookups, connects } = renderer({ test: selfNavigation("/api/nav") });
    for (const format of ["pdf", "png"] as const) {
      const res = await r.render(job("html", attackHtml(app.port), format));
      // The render itself still finishes — it just never reached anything.
      expect(res).toMatchObject({ ok: true });
    }
    expect(app.hits).toEqual([]);
    expect(lookups).toEqual([]);
    expect(connects).toEqual([]);
    // The one request CSP cannot stop — the document navigating itself to the app — was refused by the renderer.
    expect(blocked).toContain(`http://127.0.0.1:${app.port}/api/nav`);
  });

  // Each network layer alone (the others off) stops the same document: no single mistake opens the way.
  describe("each layer alone", () => {
    /**
     * `reaches`: the navigation is expected to reach the app — the render waits for it to land. `outside`: see
     * `attackHtml`.
     */
    const run = async (o: Partial<RendererOptions>, { reaches = false, outside = true } = {}) => {
      app.hits.length = 0;
      const wait = selfNavigation("/api/nav", () => !reaches || app.hits.some((h) => h.url === "/api/nav"));
      const t = renderer({ ...o, test: { ...wait, ...o.test } });
      const html = attackHtml(app.port, { outside });
      expect(await t.r.render(job("html", html, "pdf"))).toMatchObject({ ok: true });
      return { hits: app.hits.map((h) => h.url).sort(), ...t };
    };

    it("control: with every layer off and no sandbox, the document does reach the app (the probe works)", async () => {
      const { hits } = await run(
        {
          launcher: unsandboxedLauncher,
          test: { csp: false, intercept: false, proxy: false },
        },
        { reaches: true, outside: false },
      );
      // (Subresources are also held back by Chrome's own local-network rules; the navigation is not.)
      expect(hits).toContain("/api/nav");
    });

    it("CSP alone does not stop the document navigating itself to the app (why the other layers exist)", async () => {
      const { hits } = await run(
        { launcher: unsandboxedLauncher, test: { intercept: false, proxy: false } },
        { reaches: true },
      );
      expect(hits).toEqual(["/api/nav"]);
    });

    it("request interception alone", async () => {
      const { hits, blocked } = await run({
        launcher: unsandboxedLauncher,
        test: { csp: false, proxy: false },
      });
      expect(hits).toEqual([]);
      expect(blocked).toEqual(
        expect.arrayContaining([
          `http://127.0.0.1:${app.port}/api/conversations`,
          `http://127.0.0.1:${app.port}/api/nav`,
          "http://10.0.0.1/api/x",
          "http://169.254.169.254/latest/meta-data/",
          "https://example.org/public.png",
        ]),
      );
    });

    it("the egress proxy alone (loopback included: Chrome may not bypass it for 127.0.0.1 or localhost)", async () => {
      const { hits, lookups, connects } = await run({
        launcher: unsandboxedLauncher,
        test: { csp: false, intercept: false },
      });
      expect(hits).toEqual([]);
      // Only the CDN host may be resolved or reached; example.org, private and loopback addresses never are.
      expect(lookups.filter((h) => !RENDER_EGRESS_HOSTS.includes(h))).toEqual([]);
      expect(connects).toEqual([]);
    });

    it.skipIf(!darwin)(
      "the macOS process sandbox alone (no CSP, no interception, no proxy switch)",
      async () => {
        const { hits } = await run({
          launcher: sandboxedLauncher,
          test: { csp: false, intercept: false, proxy: false },
        });
        expect(hits).toEqual([]);
      },
      SLOW.timeout,
    );
  });

  it("the pinned CDN script is the one thing let through — to the proxy, which reaches its host only", async () => {
    const other = "https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js";
    const html = `<!doctype html><script src="${CDN_ALLOW_LIST[0]!.url}"></script><script src="${other}"></script><p>x</p>`;
    const { r, lookups } = renderer();
    expect((await r.render(job("html", html, "pdf"))).ok).toBe(true);
    expect([...new Set(lookups)]).toEqual(["cdn.jsdelivr.net"]);
    // Without CSP (which already refuses the other version), interception refuses it: same host, other path.
    const bare = renderer({ test: { csp: false } });
    expect((await bare.r.render(job("html", html, "pdf"))).ok).toBe(true);
    expect(bare.blocked).toContain(other);
    expect(bare.blocked).not.toContain(CDN_ALLOW_LIST[0]!.url);
  });

  it("no app cookies or session: empty fresh profile, two environment variables, nothing kept afterwards", async () => {
    const seen: { env: Record<string, string>; workDir: string; profileEntries: string[] }[] = [];
    const inside: unknown[] = [];
    const { r } = renderer({
      test: {
        launched: ({ env, workDir, args }) => {
          const profile = args.find((a) => a.startsWith("--user-data-dir="))!.split("=")[1]!;
          seen.push({ env, workDir, profileEntries: fs.readdirSync(profile) });
        },
        afterLoad: async (send) => {
          inside.push(await send("Storage.getCookies"));
          inside.push(await send("Runtime.evaluate", { expression: "location.href" }));
          inside.push(await send("Runtime.evaluate", { expression: "String(self.origin)" }));
        },
      },
    });
    const html = `<!doctype html><script>try { document.cookie = "planted=1"; } catch (e) {}</script><p>x</p>`;
    expect((await r.render(job("html", html, "pdf"))).ok).toBe(true);
    expect((await r.render(job("html", html, "pdf"))).ok).toBe(true);
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(Object.keys(s.env).sort()).toEqual(["HOME", "TMPDIR"]);
      expect(s.profileEntries).toEqual([]);
      expect(fs.existsSync(s.workDir)).toBe(false);
    }
    expect(seen[0]!.workDir).not.toBe(seen[1]!.workDir);
    // The browser's cookie jar is empty (the opaque-origin document cannot even plant one), and the page is the
    // fake document address — never the app's origin.
    expect(inside[0]).toEqual({ cookies: [] });
    expect(inside[3]).toEqual({ cookies: [] });
    expect(JSON.stringify(inside[1])).toContain(DOCUMENT_URL);
    // The same sandboxing CSP as the served original: an opaque origin.
    expect(inside[2]).toMatchObject({ result: { value: "null" } });
  });

  it("time limit: a document that never stops is killed (export_timeout), with its process", async () => {
    let pid: number | undefined;
    const launcher: Launcher = (s) => {
      const l = PROD_LAUNCHER(s);
      pid = l.child.pid;
      return l;
    };
    const { r } = renderer({ launcher, limits: { timeoutMs: 3000 } });
    const started = Date.now();
    const res = await r.render(job("html", "<!doctype html><script>for(;;){}</script>", "pdf"));
    expect(res).toEqual({ ok: false, code: "export_timeout" });
    expect(Date.now() - started).toBeLessThan(8000);
    expect(alive(pid!)).toBe(false);
  });

  it("memory limit: above it the browser is killed (export_limit); unmeasurable counts as above (fail closed)", async () => {
    // An HTML document (its scripts get time to settle): the monitor samples while it renders.
    const doc = job("html", "<!doctype html><p>메모리</p>", "png");
    const small = renderer({ limits: { maxRssBytes: 20 * 1024 * 1024 } });
    expect(await small.r.render(doc)).toEqual({ ok: false, code: "export_limit" });
    const blind = renderer({ test: { probe: async () => [] } });
    expect(await blind.r.render(doc)).toEqual({ ok: false, code: "export_limit" });
    const fine = renderer();
    expect((await fine.r.render(job("chart", chart, "png"))).ok).toBe(true);
  });

  it("reply and file size limits, and at most `concurrent` renders at once", async () => {
    const big = renderer({ limits: { maxReplyBytes: 2000 } });
    expect(await big.r.render(job("chart", chart, "png"))).toEqual({ ok: false, code: "export_limit" });
    const file = renderer({ limits: { maxFileBytes: 100 } });
    expect(await file.r.render(job("chart", chart, "png"))).toEqual({ ok: false, code: "export_limit" });
    // One at a time, one more waits for the slot, the third is turned away.
    let running = 0;
    let most = 0;
    const counting: Launcher = (s) => {
      const l = PROD_LAUNCHER(s);
      most = Math.max(most, ++running);
      l.child.once("exit", () => running--);
      return l;
    };
    const one = renderer({ launcher: counting, limits: { concurrent: 1, queue: 1 } });
    const results = await Promise.all([1, 2, 3].map(() => one.r.render(job("chart", chart, "png"))));
    expect(results.map((r) => (r.ok ? "ok" : r.code))).toEqual(["ok", "ok", "export_busy"]);
    expect(most).toBe(1);
  });
});

function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("renderer without a browser or a sandbox", () => {
  it("no browser → export_unavailable; the codes are exactly the loggable ones", async () => {
    const r = new Renderer({ browser: undefined });
    closers.push(() => r.close());
    expect(await r.render(job("chart", chart, "png"))).toEqual({ ok: false, code: "export_unavailable" });
    expect(new Set(EXPORT_CODES)).toEqual(LOGGABLE_EXPORT_CODES);
  });

  it.skipIf(darwin)(
    "off macOS the production launcher refuses (fail closed: export_unavailable)",
    async () => {
      const r = new Renderer({ browser: process.execPath, egress: spyEgress().egress });
      closers.push(() => r.close());
      expect(await r.render(job("chart", chart, "png"))).toEqual({ ok: false, code: "export_unavailable" });
    },
  );

  it("switches: one process, Chrome's sandbox off inside ours, every request to the proxy (loopback too)", () => {
    const a = browserArgs("/tmp/p", "http://127.0.0.1:1234");
    expect(a).toEqual(
      expect.arrayContaining([
        "--single-process",
        "--remote-debugging-pipe",
        "--user-data-dir=/tmp/p",
        "--proxy-server=http://127.0.0.1:1234",
        "--proxy-bypass-list=<-loopback>",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ]),
    );
    expect(a.some((x) => x.startsWith("--remote-debugging-port"))).toBe(false);
    expect(RENDER_EGRESS_HOSTS).toEqual(["cdn.jsdelivr.net"]);
  });

  it("finds the newest complete headless shell in a Playwright cache; EXPORT_BROWSER wins", () => {
    const cache = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-pw-")));
    const dir = {
      "darwin-arm64": "chrome-headless-shell-mac-arm64",
      "darwin-x64": "chrome-headless-shell-mac-x64",
      "linux-x64": "chrome-headless-shell-linux64",
      "linux-arm64": "chrome-headless-shell-linux-arm64",
    }[`${process.platform}-${process.arch}`];
    if (!dir) return;
    const mk = (rev: number, complete: boolean) => {
      const d = path.join(cache, `chromium_headless_shell-${rev}`, dir);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, "chrome-headless-shell"), "");
      if (complete)
        fs.writeFileSync(path.join(cache, `chromium_headless_shell-${rev}`, "INSTALLATION_COMPLETE"), "");
      return path.join(d, "chrome-headless-shell");
    };
    mk(1200, true);
    const newest = mk(1254, true);
    mk(1300, false);
    expect(findBrowser(undefined, cache)).toBe(newest);
    expect(findBrowser("/nope/chrome", cache)).toBeUndefined();
    expect(findBrowser(newest, path.join(cache, "none"))).toBe(newest);
    expect(findBrowser(undefined, path.join(cache, "none"))).toBeUndefined();
  });
});

// Their own budget (#207): setting up the app and a family (password hashing) took longer than the default 5 s on a
// loaded machine.
describe("export routes (#51)", { timeout: 30_000 }, () => {
  async function setup(render: (j: RenderJob) => Promise<RenderResult>) {
    const lines: Record<string, unknown>[] = [];
    const logStream = new Writable({
      write(chunk, _e, cb) {
        for (const l of String(chunk).split("\n").filter(Boolean)) lines.push(JSON.parse(l));
        cb();
      },
    });
    const jobs: RenderJob[] = [];
    const a = await buildApp(loadConfig({ NODE_ENV: "test" }), {
      db: createTestDb(),
      logStream,
      renderer: {
        render: async (j) => {
          jobs.push(j);
          return render(j);
        },
      },
    });
    closers.push(() => a.close());
    const f = await createFamily(a);
    const c = a.conversations!.create(f.users.owner.id);
    const scope = { userId: f.users.owner.id, conversationId: c.id, runId: crypto.randomUUID() };
    const mk = (kind: ArtifactKind, body: Record<string, unknown>) =>
      a.artifacts!.create(scope, { kind, title: "비밀 제목 SECRET-TITLE", ...body }).artifact.id;
    return { a, f, lines, jobs, mk };
  }
  const get = (a: Awaited<ReturnType<typeof buildApp>>, url: string, cookie?: string) =>
    a.inject({ url, headers: { host: "localhost:3000", ...(cookie ? { cookie } : {}) } });

  it("owner only; the renderer gets the stored version — never the request, its cookie or session", async () => {
    const { a, f, jobs, lines, mk } = await setup(async (j) => ({
      ok: true,
      body: Buffer.from(j.format === "png" ? "PNGDATA" : "%PDF-1.7"),
      type: j.format === "png" ? "image/png" : "application/pdf",
    }));
    const id = mk("chart", { chart: JSON.parse(chart) });
    for (const format of ["png", "pdf"]) {
      const url = `/a/${id}/v/1/${format}`;
      expect((await get(a, url, f.cookies.stranger)).statusCode, url).toBe(403);
      expect((await get(a, url, f.cookies.admin)).statusCode, url).toBe(403);
      expect((await get(a, url, f.cookies.shared)).statusCode, url).toBe(403);
      expect((await get(a, url)).statusCode, url).toBe(401);
      const r = await get(a, url, f.cookies.owner);
      expect(r.statusCode).toBe(200);
      expect(r.headers["content-type"]).toBe(format === "png" ? "image/png" : "application/pdf");
      expect(r.headers["content-disposition"]).toMatch(new RegExp(`^attachment; filename=".*\\.${format}"`));
      expect(r.headers["content-security-policy"]).toMatch(/^sandbox allow-scripts; default-src 'none'/);
      expect(r.headers["cache-control"]).toBe("no-store");
    }
    // Refused callers never reached the renderer.
    expect(jobs.map((j) => j.format)).toEqual(["png", "pdf"]);
    const token = decodeURIComponent(f.cookies.owner.split("=")[1]!.split(";")[0]!);
    for (const j of jobs) {
      expect(Object.keys(j).sort()).toEqual(["doc", "format", "scripts"]);
      expect(JSON.stringify(j)).not.toContain(token);
      expect(j.scripts).toBe(false);
    }
    // The log line: fixed codes only — no title, no content.
    const logged = lines.filter((l) => l.msg === "artifact.exported");
    expect(logged.map((l) => [l.exportFormat, l.exportCode])).toEqual([
      ["png", "export_ok"],
      ["pdf", "export_ok"],
    ]);
    expect(JSON.stringify(lines)).not.toContain("SECRET-TITLE");
  });

  it("formats per kind (404 otherwise), unknown versions 404, failures as statuses with a fixed code", async () => {
    let next: RenderResult = { ok: true, body: Buffer.from("x"), type: "application/pdf" };
    const { a, f, jobs, mk } = await setup(async () => next);
    const ids: Record<ArtifactKind, string> = {
      chart: mk("chart", { chart: JSON.parse(chart) }),
      svg: mk("svg", { content: "<svg xmlns='http://www.w3.org/2000/svg'></svg>" }),
      html: mk("html", { content: "<p>x</p>" }),
      table: mk("table", { table: { columns: ["a"], rows: [["b"]] } }),
      markdown: mk("markdown", { content: "# x" }),
      code: mk("code", { content: "x", language: "python" }),
      document: mk("document", { document: { fileId: "f1", name: "a.pdf", mimeType: "application/pdf" } }),
    };
    for (const [kind, id] of Object.entries(ids) as [ArtifactKind, string][])
      for (const format of ["png", "pdf"] as const) {
        const want = ARTIFACT_EXPORTS[kind].includes(format) ? 200 : 404;
        expect(
          (await get(a, `/a/${id}/v/1/${format}`, f.cookies.owner)).statusCode,
          `${kind} ${format}`,
        ).toBe(want);
      }
    expect(jobs.find((j) => j.doc.body.includes("<p>x</p>"))?.scripts).toBe(true);
    for (const v of ["2", "0", "x"])
      expect((await get(a, `/a/${ids.chart}/v/${v}/png`, f.cookies.owner)).statusCode).toBe(404);
    const statuses: Record<string, number> = {
      export_unavailable: 503,
      export_busy: 503,
      export_timeout: 504,
      export_limit: 413,
      export_failed: 502,
    };
    for (const [code, status] of Object.entries(statuses)) {
      next = { ok: false, code } as RenderResult;
      const r = await get(a, `/a/${ids.chart}/v/1/png`, f.cookies.owner);
      expect(r.statusCode, code).toBe(status);
      expect(r.json()).toEqual({ error: code });
      if (code === "export_busy") expect(r.headers["retry-after"]).toBe("5");
    }
  });

  it("the test environment has no browser by default: export_unavailable", async () => {
    const a = await buildApp(loadConfig({ NODE_ENV: "test" }), { db: createTestDb() });
    closers.push(() => a.close());
    const f = await createFamily(a);
    const c = a.conversations!.create(f.users.owner.id);
    const scope = { userId: f.users.owner.id, conversationId: c.id, runId: crypto.randomUUID() };
    const id = a.artifacts!.create(scope, { kind: "chart", title: "t", chart: JSON.parse(chart) }).artifact
      .id;
    const r = await get(a, `/a/${id}/v/1/png`, f.cookies.owner);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: "export_unavailable" });
  });
});

const FIXTURES = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures", "export");

describe("the DevTools pipe is untrusted: a broken or hostile browser fails its render, never the server", () => {
  it("message shapes: only objects with a positive integer id (reply) or a string method (event)", () => {
    for (const bad of [
      "null",
      "[1]",
      '"x"',
      "1",
      "{oops",
      "{}",
      '{"id":"1","result":{}}',
      '{"id":0,"result":{}}',
      '{"id":1.5,"result":{}}',
      '{"id":1,"method":"x"}',
      '{"method":5}',
      '{"method":"x","params":null}',
      '{"method":"x","params":[1]}',
      '{"id":1,"result":"x"}',
      '{"method":"x","sessionId":7}',
    ])
      expect(parseMessage(bad), bad).toBeUndefined();
    expect(parseMessage('{"id":3,"result":{"a":1}}')).toEqual({ id: 3, result: { a: 1 } });
    expect(parseMessage('{"method":"E","sessionId":"s","params":{}}')).toEqual({
      method: "E",
      sessionId: "s",
      params: {},
    });
  });

  it("in a separate Node process: closed before the navigation reply, malformed JSON, null, wrong id type, an unknown id, bad params, a bad reply, an oversized reply, a hang — the host survives, the browser is gone, the folder removed", () => {
    const modes = [
      "ok",
      "close-before-navigate",
      "null",
      "badjson",
      "array",
      "wrong-id",
      "unknown-id",
      "bad-result",
      "bad-reply",
      "bad-params",
      "huge",
      "hang",
    ];
    const r = spawnSync(
      path.join(REPO_ROOT, "node_modules/.bin/tsx"),
      ["--conditions=development", path.join(FIXTURES, "host.ts"), ...modes],
      { encoding: "utf8", cwd: REPO_ROOT, timeout: 60_000 },
    );
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    const { out, leftovers } = JSON.parse(r.stdout) as {
      out: Record<string, { result: string; alive: boolean; signal: string | null; order: string[] }>;
      leftovers: string[];
    };
    expect(leftovers).toEqual([]);
    const want: Record<string, string> = {
      ok: "ok:%PDF-fake",
      huge: "export_limit",
      hang: "export_timeout",
    };
    for (const m of modes) {
      expect(out[m]!.result, m).toBe(want[m] ?? "export_failed");
      expect(out[m]!.alive, m).toBe(false);
      // A broken browser is killed at once — its group's SIGKILL comes before any polite `Browser.close` is tried —
      // and ends by that signal (asked to close, the stand-in would answer and exit by itself). Checked by order and
      // signal, not by a time a loaded machine stretches (#207). A good one is asked to close first; one that ended
      // by itself is not killed.
      const o = out[m]!.order;
      if (m === "ok") expect(o[0], m).toBe("close");
      else if (m !== "close-before-navigate") expect(o[0], `${m}: ${o.join(",")}`).toBe("kill");
      if (m === "ok" || m === "close-before-navigate") expect(out[m]!.signal, m).toBeNull();
      else expect(out[m]!.signal, m).toBe("SIGKILL");
    }
  }, 90_000);
});

/** Whether any process of group `pgid` still exists. */
function groupAlive(pgid: number) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Polls `done` every 50 ms for at most `ms`; true once it holds. */
async function within(ms: number, done: () => boolean) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (done()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return done();
}

/**
 * Groups this file started (hosts, watchdogs with their browsers, holders) and has not yet seen gone: killed after
 * each test.
 * A group is taken off the list as soon as it is confirmed gone (`gone`), so a reused id is never signalled. Nothing
 * is matched by name.
 */
const startedGroups = new Set<number>();
const track = (l: Launched) => {
  startedGroups.add(l.child.pid!);
  return l;
};
/**
 * How long a test waits for something it caused to be over (a group gone, a folder removed, a lock free). Generous on
 * purpose (#207): what these tests check is that it happens, not how fast a loaded machine gets to it — the bounds
 * that are properties of their own (the time limit, the watchdog's cap, the sweep's stop) keep their own values.
 */
const SETTLE_MS = 15_000;
const gone = async (pgid: number, ms = SETTLE_MS) => {
  const ok = await within(ms, () => !groupAlive(pgid));
  if (ok) startedGroups.delete(pgid);
  return ok;
};
afterEach(() => {
  for (const g of startedGroups) {
    try {
      process.kill(-g, "SIGKILL");
    } catch {
      // gone
    }
  }
  startedGroups.clear();
});

const FAKE_JS = path.join(FIXTURES, "fake-browser.mjs");
/** The stand-in that never answers; it keeps the render's `--user-data-dir` (its identity for the reap, #215). */
const FAKE = (base: string[] = []) => [
  FAKE_JS,
  "orphan",
  ...base.filter((a) => a.startsWith("--user-data-dir=")),
];
const freshRenderDir = () => {
  const d = makeRenderDir(os.tmpdir());
  closers.push(async () => removeRenderDir(d));
  return d;
};
/** The watchdog straight from the unsandboxed launcher, on a fresh folder (or one given). */
function watchdog(
  args: string[],
  o: { env?: Record<string, string>; deadlineSec?: number; browser?: string; dir?: RenderDir } = {},
) {
  const d = o.dir ?? freshRenderDir();
  const l = unsandboxedLauncher({
    browser: o.browser ?? process.execPath,
    args,
    env: o.env ?? {},
    workDir: d.workDir,
    lockFd: d.lockFd,
    proxyPort: 1,
    deadlineSec: o.deadlineSec ?? 30,
  });
  track(l);
  const exited = new Promise<number | null>((r) => l.child.once("exit", (code) => r(code)));
  return { ...d, l, exited };
}
/** The members of a group (`snapshot`: macOS process group, Linux session — the same set for a detached child). */
const members = async (pgid: number) => (await snapshot(pgid, 2000, true)).map((p) => p.pid);
/** A file a stand-in browser writes its pid to (`PIDFILE`), and that pid once written. */
function pidFile() {
  const f = path.join(fs.realpathSync(os.tmpdir()), `agentlee-pid-${crypto.randomUUID()}`);
  closers.push(async () => fs.rmSync(f, { force: true }));
  return { f, pid: () => (fs.existsSync(f) ? Number(fs.readFileSync(f, "utf8")) || undefined : undefined) };
}

describe("the browser never outlives its owner (#170)", () => {
  /**
   * A host process (`orphan-host.ts`, its own process group, bounded) starts a render that never ends; once it
   * runs, the host is SIGKILLed — no `finally`, no exit hook, no timer of it runs again. The watchdog must kill the
   * browser's whole process group and remove the render folder and its lock by itself, within a bounded time.
   */
  async function orphan(mode: "fake" | "real") {
    const host = spawn(
      process.execPath,
      ["--import", "tsx", "--conditions=development", path.join(FIXTURES, "orphan-host.ts"), mode],
      { cwd: REPO_ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    startedGroups.add(host.pid!);
    let out = "";
    let err = "";
    host.stdout.on("data", (d: Buffer) => (out += d.toString()));
    host.stderr.on("data", (d: Buffer) => (err += d.toString()));
    let hostEnded = false;
    const exited = new Promise<void>((r) =>
      host.once("exit", () => {
        hostEnded = true;
        r();
      }),
    );
    // Starting the host (tsx) and its browser is setup, not the property: its own budget (#207 — over 30 s on a loaded
    // machine). The property is the time from the owner's SIGKILL to nothing left (below). A host that ends before it
    // is ready fails the test at once, with what it said.
    expect(await within(90_000, () => out.includes("\n") || hostEnded), err).toBe(true);
    expect(out.includes("\n") ? "" : `host ended before it was ready: ${err}`).toBe("");
    const info = JSON.parse(out.split("\n")[0]!) as {
      host: number;
      pgid: number;
      members: number[];
      workDir: string;
      spinning?: boolean;
    };
    startedGroups.add(info.pgid);
    expect(info.host).toBe(host.pid);
    // One group: the watchdog leads it, the browser is in it, running; the folder is locked.
    expect(info.members).toContain(info.pgid);
    expect(info.members.length).toBeGreaterThanOrEqual(2);
    expect(path.basename(info.workDir)).toMatch(/^agentlee-render-[A-Za-z0-9]{6}$/);
    expect(fs.existsSync(renderLockPath(info.workDir))).toBe(true);
    expect(groupAlive(info.pgid)).toBe(true);
    if (mode === "real") expect(info.spinning).toBe(true);

    const killedAt = Date.now();
    process.kill(host.pid!, "SIGKILL");
    await exited;
    expect(await gone(host.pid!)).toBe(true);
    expect(await gone(info.pgid)).toBe(true);
    expect(await within(SETTLE_MS, () => !fs.existsSync(info.workDir))).toBe(true);
    expect(fs.existsSync(renderLockPath(info.workDir))).toBe(false);
    for (const pid of info.members) expect(alive(pid), `pid ${pid}`).toBe(false);
    return Date.now() - killedAt;
  }

  it("SIGKILL of the owner: a stand-in browser that ignores pipe EOF is killed, group and folder gone", async () => {
    expect(await orphan("fake")).toBeLessThan(5000);
  }, 150_000);

  it.skipIf(!BROWSER)(
    "SIGKILL of the owner mid-render: the real headless shell (production launcher, its loop confirmed entered over DevTools) is gone too",
    async () => {
      expect(await orphan("real")).toBeLessThan(5000);
    },
    150_000,
  );

  /** A renderer over the stand-in browser that never answers; `launches` lists each started watchdog. */
  function orphanRenderer(o: Partial<RendererOptions> = {}) {
    const launches: { pgid: number; workDir: string; l: Launched }[] = [];
    const launcher: Launcher = (s) => {
      const l = unsandboxedLauncher(s);
      launches.push({ pgid: l.child.pid!, workDir: s.workDir, l });
      track(l);
      return l;
    };
    const r = new Renderer({
      browser: process.execPath,
      launcher,
      egress: spyEgress().egress,
      limits: { timeoutMs: 60_000 },
      ...o,
      test: { args: FAKE, probe: async () => [{ pid: 1, rss: 1 }] },
    });
    closers.push(() => r.close());
    return { r, launches };
  }

  it("the watchdog SIGKILLed alone (the server alive): the server reaps the browser at once (by pid, #215)", async () => {
    const { r, launches } = orphanRenderer();
    const before = liveRenderCount();
    const pending = r.render(job("markdown", "x", "pdf"));
    // Until the browser runs under the watchdog (two members of the one group).
    let seen: number[] = [];
    expect(
      await within(10_000, () => {
        if (launches[0]) void members(launches[0].pgid).then((m) => (seen = m));
        return seen.length >= 2;
      }),
    ).toBe(true);
    const { pgid, workDir } = launches[0]!;
    process.kill(pgid, "SIGKILL"); // the watchdog only
    expect(await pending).toEqual({ ok: false, code: "export_failed" });
    expect(await gone(pgid)).toBe(true);
    for (const pid of seen) expect(alive(pid), `pid ${pid}`).toBe(false);
    // The folder goes once the reap (#215) has confirmed the render's processes gone.
    expect(await within(SETTLE_MS, () => !fs.existsSync(workDir))).toBe(true);
    expect(fs.existsSync(renderLockPath(workDir))).toBe(false);
    expect(liveRenderCount()).toBe(before);
  }, 30_000);

  /** A render whose stand-in browser records its pid, and something done to it right after the spawn. */
  async function rightAfterSpawn(act: (l: Launched) => void) {
    const p = pidFile();
    const launches: { l: Launched; workDir: string }[] = [];
    const launcher: Launcher = (s) => {
      const l = track(unsandboxedLauncher({ ...s, env: { ...s.env, PIDFILE: p.f } }));
      launches.push({ l, workDir: s.workDir });
      act(l); // before the watchdog has even run: no readiness of any kind
      return l;
    };
    const r = new Renderer({
      browser: process.execPath,
      launcher,
      egress: spyEgress().egress,
      limits: { timeoutMs: 60_000 },
      test: { args: FAKE, probe: async () => [{ pid: 1, rss: 1 }] },
    });
    closers.push(() => r.close());
    expect((await r.render(job("markdown", "x", "pdf"))).ok).toBe(false);
    const { l, workDir } = launches[0]!;
    expect(await gone(l.child.pid!)).toBe(true);
    // The browser either never started or is gone — and does not turn up later either.
    await new Promise((done) => setTimeout(done, 500));
    const pid = p.pid();
    if (pid) expect(alive(pid), `browser ${pid}`).toBe(false);
    expect(fs.existsSync(workDir)).toBe(false);
  }

  it("shutdown right after the spawn (before any readiness) leaves no browser", async () => {
    for (let i = 0; i < 5; i++) await rightAfterSpawn(() => void closeRenderers());
  }, 60_000);

  it("the watchdog killed right after the spawn leaves no browser", async () => {
    for (let i = 0; i < 5; i++) await rightAfterSpawn((l) => process.kill(l.child.pid!, "SIGKILL"));
  }, 60_000);

  it("the group is signalled at most once per render: shutdown right after the spawn, or the time limit", async () => {
    const kill = vi.spyOn(process, "kill");
    try {
      const signals = (pgid: number) =>
        kill.mock.calls.filter(([p, sig]) => p === -pgid && sig === "SIGKILL").length;
      // Shut down right after the spawn: `killLiveRenders`, then the render's own failure path — one signal.
      let first: Launched | undefined;
      const r1 = new Renderer({
        browser: process.execPath,
        launcher: (sp) => {
          first = track(unsandboxedLauncher(sp));
          closeRenderers();
          return first;
        },
        egress: spyEgress().egress,
        test: { args: FAKE, probe: async () => [{ pid: 1, rss: 1 }] },
      });
      closers.push(() => r1.close());
      expect((await r1.render(job("markdown", "x", "pdf"))).ok).toBe(false);
      expect(await gone(first!.child.pid!)).toBe(true);
      expect(signals(first!.child.pid!)).toBe(1);
      // The time limit: its kill, then the failed render's kill — one signal.
      let second: Launched | undefined;
      const r2 = new Renderer({
        browser: process.execPath,
        launcher: (sp) => (second = track(unsandboxedLauncher(sp))),
        egress: spyEgress().egress,
        limits: { timeoutMs: 500 },
        test: { args: FAKE, probe: async () => [{ pid: 1, rss: 1 }] },
      });
      closers.push(() => r2.close());
      expect(await r2.render(job("markdown", "x", "pdf"))).toEqual({ ok: false, code: "export_timeout" });
      expect(await gone(second!.child.pid!)).toBe(true);
      await new Promise((done) => setTimeout(done, 200));
      expect(signals(second!.child.pid!)).toBe(1);
    } finally {
      kill.mockRestore();
    }
  }, 30_000);

  it("the group is signalled once even when the time limit and shutdown overlap", async () => {
    let l: Launched | undefined;
    const r = new Renderer({
      browser: process.execPath,
      launcher: (sp) => (l = track(unsandboxedLauncher(sp))),
      egress: spyEgress().egress,
      limits: { timeoutMs: 500 },
      test: { args: FAKE, probe: async () => [{ pid: 1, rss: 1 }] },
    });
    closers.push(() => r.close());
    const real = process.kill.bind(process);
    let overlapped = false;
    const kill = vi.spyOn(process, "kill").mockImplementation((p: number, sig?: string | number) => {
      const res = real(p, sig);
      // The time limit's signal: shut down right then, before the watchdog's exit is seen.
      if (!overlapped && l && p === -l.child.pid! && sig === "SIGKILL") {
        overlapped = true;
        closeRenderers();
      }
      return res;
    });
    try {
      expect((await r.render(job("markdown", "x", "pdf"))).ok).toBe(false);
      expect(overlapped).toBe(true);
      expect(kill.mock.calls.filter(([p, sig]) => p === -l!.child.pid! && sig === "SIGKILL")).toHaveLength(1);
    } finally {
      kill.mockRestore();
    }
    expect(await gone(l!.child.pid!)).toBe(true);
  }, 30_000);

  /**
   * #215: on macOS a group SIGKILL that lands while the watchdog is inside `fork` kills the watchdog and can miss the
   * child being made, which then execs the browser (PPID 1, same group). That kernel window cannot be hit on demand,
   * so the first group signal is made to miss exactly that way — it reaches the watchdog only — once the browser runs.
   * The reap by identity must still kill the browser; the group id itself is signalled once.
   */
  async function missedByTheFirstSignal(trigger: "shutdown" | "memory") {
    const p = pidFile();
    let pgid: number | undefined;
    let browserAfterMiss: boolean | undefined;
    const real = process.kill.bind(process);
    const kill = vi.spyOn(process, "kill").mockImplementation((target: number, sig?: string | number) => {
      if (browserAfterMiss === undefined && pgid && target === -pgid && sig === "SIGKILL") {
        const res = real(pgid, "SIGKILL"); // the watchdog only: the browser is missed
        browserAfterMiss = alive(p.pid()!);
        return res;
      }
      return real(target, sig);
    });
    try {
      let running = false;
      let workDir = "";
      const r = new Renderer({
        browser: process.execPath,
        launcher: (s) => {
          const l = track(unsandboxedLauncher({ ...s, env: { ...s.env, PIDFILE: p.f } }));
          pgid = l.child.pid!;
          workDir = s.workDir;
          return l;
        },
        egress: spyEgress().egress,
        limits: { timeoutMs: 60_000 },
        test: {
          args: FAKE,
          // The memory limit, once the browser runs.
          probe: async () => [{ pid: 1, rss: trigger === "memory" && running ? 1 << 30 : 1 }],
        },
      });
      closers.push(() => r.close());
      const pending = r.render(job("markdown", "x", "pdf"));
      expect(await within(SETTLE_MS, () => !!p.pid() && alive(p.pid()!))).toBe(true);
      running = true;
      if (trigger === "shutdown") {
        closeRenderers();
        // Reaped in place, before any timer could run (an `exit` hook runs none).
        expect(kill.mock.calls.some(([t, sig]) => t === p.pid() && sig === "SIGKILL")).toBe(true);
      }
      expect((await pending).ok).toBe(false);
      expect(browserAfterMiss).toBe(true);
      expect(await within(SETTLE_MS, () => !alive(p.pid()!)), `browser ${p.pid()}`).toBe(true);
      expect(await gone(pgid!)).toBe(true);
      expect(await within(SETTLE_MS, () => reapingRenderCount() === 0)).toBe(true);
      expect(fs.existsSync(workDir)).toBe(false);
      expect(kill.mock.calls.filter(([t, sig]) => t === -pgid! && sig === "SIGKILL")).toHaveLength(1);
    } finally {
      kill.mockRestore();
    }
  }

  it("a browser the group signal missed (forked as it landed, #215) is reaped by identity: shutdown", async () => {
    await missedByTheFirstSignal("shutdown");
  }, 60_000);

  it("a browser the group signal missed (forked as it landed, #215) is reaped by identity: a limit", async () => {
    await missedByTheFirstSignal("memory");
  }, 60_000);

  it("missed browser, the watchdog's exit already seen, then the server exits (separate host, #215): shutdown takes the reap over", async () => {
    const p = pidFile();
    const host = spawn(
      process.execPath,
      ["--import", "tsx", "--conditions=development", path.join(FIXTURES, "reap-host.ts"), p.f],
      { cwd: REPO_ROOT, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    startedGroups.add(host.pid!);
    let out = "";
    let err = "";
    host.stdout.on("data", (d: Buffer) => (out += d.toString()));
    host.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const code = await new Promise<number | null>((r) => host.once("exit", (c) => r(c)));
    const info = JSON.parse(out.trim().split("\n").pop() || "{}") as {
      pgid?: number;
      browser?: number;
      browserAfterMiss?: boolean;
      watchdogExited?: boolean;
      reaping?: number;
      groupSignals?: number;
    };
    expect(code, err).toBe(0);
    if (info.pgid) startedGroups.add(info.pgid);
    // The order the bug needed: the browser outlived the one group signal, the watchdog's exit was seen (untracked
    // as live), and only then did the server exit — no reap timer of it ever ran.
    expect(info).toMatchObject({ browserAfterMiss: true, watchdogExited: true, reaping: 1, groupSignals: 1 });
    // The browser really ran (a positive pid, read before the limit fired) and that very process is gone.
    const browser = info.browser!;
    expect(browser).toBeGreaterThan(0);
    expect(p.pid()).toBe(browser);
    expect(await within(SETTLE_MS, () => !alive(browser)), `browser ${browser}`).toBe(true);
    expect(await gone(info.pgid!)).toBe(true);
  }, 60_000);

  describe("the reap signals by identity only, and completes only on an empty group (#215)", () => {
    /** Sleepers in groups of their own: stand-ins for whatever a listing shows. */
    const sleeper = () => {
      const c = spawn("/bin/sleep", ["30"], { detached: true, stdio: "ignore" });
      startedGroups.add(c.pid!);
      return c.pid!;
    };
    const restores: (() => void)[] = [];
    afterEach(() => {
      for (const r of restores.splice(0)) r();
      onRenderReapIncomplete(undefined);
    });
    const row = (pid: number, pgid: number, args: string, zombie = false) => ({ pid, pgid, zombie, args });
    /** A render being reaped after its watchdog's own end (no group signal: the group id is not ours). */
    /** A watchdog command line as spawned (a script with a new line and a tab) and as macOS `ps` prints it. */
    const spawned = (d: string) => [
      "/usr/bin/perl",
      "-e",
      "use strict;\n\tx();",
      "1",
      "30",
      d,
      "node",
      "fake.mjs",
    ];
    const printed = (d: string) => `/usr/bin/perl -e use strict;\\012\\011x(); 1 30 ${d} node fake.mjs`;
    /** The browser executable these renders launched (argv[0] of their browser). */
    const CHROME = "/opt/chrome/chrome-headless-shell";
    const reapOf = (G: number, dir: RenderDir) => {
      const forget = trackRender(G, dir, { argv: spawned(dir.workDir), browser: CHROME });
      reapAfterWatchdog(G);
      forget();
    };
    const keptAndCleaned = (dir: RenderDir) => {
      releaseRenderDir(dir);
      expect(fs.existsSync(dir.workDir)).toBe(true);
      expect(fs.existsSync(renderLockPath(dir.workDir))).toBe(true);
      expect(dir.lockFd).toBe(-1);
      fs.rmSync(dir.workDir, { recursive: true, force: true });
      fs.rmSync(renderLockPath(dir.workDir), { force: true });
    };

    it("only exact arguments are ours: a reused group id, a look-alike path, another folder, a new render's process are never signalled — and keep the reap from completing", async () => {
      const dir = freshRenderDir();
      const d = dir.workDir;
      const G = 2_000_000_001; // the group id the listing claims
      const [
        foreign,
        elsewhere,
        prefixed,
        lookalike,
        logger,
        unreadable,
        message,
        almost,
        watchdogChild,
        browser,
      ] = [
        sleeper(),
        sleeper(),
        sleeper(),
        sleeper(),
        sleeper(),
        sleeper(),
        sleeper(),
        sleeper(),
        sleeper(),
        sleeper(),
      ];
      let rows = [
        row(foreign, G, "/bin/sleep 30"), // the group id reused by someone else
        row(elsewhere, 7, `${CHROME} --user-data-dir=${d}/profile`), // ours by its arguments, not in the group
        row(prefixed, G, `/bin/sh -c echo /archive${d}/profile`), // the path inside another argument
        row(lookalike, G, `${CHROME} --user-data-dir=${d}X/profile`), // another folder
        row(logger, G, `logger started --user-data-dir=${d}/profile`), // the switch inside a message: another program
        row(unreadable, G, "[chrome-headless-shell]"), // arguments ps could not read
        row(message, G, `logger render directory ${d} retained`), // the folder inside one argument
        row(almost, G, `/usr/bin/perl -e use strict; 1 30 ${d} node fake.mjs`), // not the command line spawned
        row(watchdogChild, G, printed(d)), // exactly the watchdog's (as a child it forked before exec)
        row(browser, G, `${CHROME} --single-process --user-data-dir=${d}/profile about:blank`),
      ];
      const incomplete: number[] = [];
      onRenderReapIncomplete((n) => incomplete.push(n));
      restores.push(setRenderReapForTests({ everyMs: 10, forMs: 1500, list: () => rows }));
      const kill = vi.spyOn(process, "kill");
      try {
        reapOf(G, dir);
        // A new render takes the same group id while the old reap still runs: the old one must leave it alone.
        const second = freshRenderDir();
        const forgetSecond = trackRender(G, second, { browser: CHROME });
        const newcomer = sleeper();
        rows = [...rows, row(newcomer, G, `${CHROME} --user-data-dir=${second.workDir}/profile`)];
        expect(await within(5000, () => !alive(watchdogChild) && !alive(browser))).toBe(true);
        rows = rows.filter((r) => r.pid !== watchdogChild && r.pid !== browser);
        // Live members it cannot attribute stay in the group: never confirmed — given up at the deadline.
        expect(await within(5000, () => incomplete.length > 0)).toBe(true);
        expect(incomplete).toEqual([1]);
        const others = [
          foreign,
          elsewhere,
          prefixed,
          lookalike,
          logger,
          unreadable,
          message,
          almost,
          newcomer,
        ];
        for (const pid of others) expect(alive(pid), `pid ${pid}`).toBe(true);
        const signalled = kill.mock.calls.filter(([, sig]) => sig === "SIGKILL").map(([t]) => t);
        expect(signalled).not.toContain(-G); // after the watchdog's own end: no group signal
        for (const pid of others) expect(signalled).not.toContain(pid);
        keptAndCleaned(dir);
        forgetSecond();
      } finally {
        kill.mockRestore();
      }
    });

    it("an unattributable member alone (`[chrome-headless-shell]`): not signalled, never confirmed — folder and lock kept, counted", async () => {
      const dir = freshRenderDir();
      const G = 2_000_000_011;
      const unreadable = sleeper();
      restores.push(
        setRenderReapForTests({
          everyMs: 10,
          forMs: 300,
          list: () => [row(unreadable, G, "[chrome-headless-shell]")],
        }),
      );
      const incomplete: number[] = [];
      onRenderReapIncomplete((n) => incomplete.push(n));
      reapOf(G, dir);
      await renderReaped(dir);
      expect(incomplete).toEqual([1]);
      expect(alive(unreadable)).toBe(true);
      keptAndCleaned(dir);
    });

    it("complete only on a listing begun after the watchdog could fork no more, showing no live member at all", async () => {
      const dir = freshRenderDir();
      const d = dir.workDir;
      const G = 2_000_000_021;
      // The watchdog live (signalled by pid: still listed, not reaped), then a zombie, then nothing. Not forgotten:
      // its end is learnt from the listings alone (as under shutdown, which sees no exit event).
      const script = [[row(G, G, printed(d))], [row(G, G, "<defunct>", true)], [], []];
      let calls = 0;
      restores.push(setRenderReapForTests({ everyMs: 10, list: () => script[Math.min(calls++, 3)] }));
      const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
      try {
        trackRender(G, dir, { argv: spawned(d) });
        signalRender(G);
        await renderReaped(dir);
        // 1: live leader (killed by pid); 2: leader a zombie — empty, but begun before its end was known; 3: empty.
        expect(calls).toBe(3);
        expect(kill.mock.calls.filter(([t]) => t === G)).toHaveLength(1);
        expect(kill.mock.calls.filter(([t]) => t === -G)).toHaveLength(1); // the one group signal, while live
      } finally {
        kill.mockRestore();
      }
      // Confirmed: the reap is over, nothing tracked any more.
      expect(reapingRenderCount()).toBe(0);
      expect(liveRenderCount()).toBe(0);
    });

    it("the deadline bounds each step: a listing that comes back past it ends the reap — no kill, folder kept, counted", async () => {
      const dir = freshRenderDir();
      const G = 2_000_000_003;
      const target = sleeper();
      const budgets: number[] = [];
      restores.push(
        setRenderReapForTests({
          everyMs: 10,
          forMs: 150,
          list: (ms) => {
            budgets.push(ms);
            const end = performance.now() + 200; // slower than the whole budget
            while (performance.now() < end) {
              // busy
            }
            return [row(target, G, `${CHROME} --user-data-dir=${dir.workDir}/profile`)];
          },
        }),
      );
      const incomplete: number[] = [];
      onRenderReapIncomplete((n) => incomplete.push(n));
      const kill = vi.spyOn(process, "kill");
      try {
        reapOf(G, dir);
        await renderReaped(dir);
        expect(incomplete).toEqual([1]);
        expect(budgets).toHaveLength(1);
        expect(budgets[0]!).toBeLessThanOrEqual(150); // the listing gets what is left, no more
        expect(kill.mock.calls.some(([t]) => t === target)).toBe(false);
        expect(alive(target)).toBe(true);
      } finally {
        kill.mockRestore();
      }
      keptAndCleaned(dir);
    });

    it("shutdown's deadline bounds it too: a slow listing → no kill after it, back within its budget, folder kept, counted", () => {
      const dir = freshRenderDir();
      const G = 2_000_000_005;
      const target = sleeper();
      const budgets: number[] = [];
      restores.push(
        setRenderReapForTests({
          shutdownMs: 100,
          list: (ms) => {
            budgets.push(ms);
            const end = performance.now() + 150;
            while (performance.now() < end) {
              // busy
            }
            return [row(target, G, `${CHROME} --user-data-dir=${dir.workDir}/profile`)];
          },
        }),
      );
      const incomplete: number[] = [];
      onRenderReapIncomplete((n) => incomplete.push(n));
      trackRender(G, dir, { browser: CHROME });
      const kill = vi.spyOn(process, "kill");
      try {
        const t0 = performance.now();
        killLiveRenders();
        expect(performance.now() - t0).toBeLessThan(400); // one listing past the budget, then nothing more
        expect(kill.mock.calls.some(([t]) => t === target)).toBe(false);
      } finally {
        kill.mockRestore();
      }
      expect(budgets).toHaveLength(1);
      expect(budgets[0]!).toBeLessThanOrEqual(100);
      expect(incomplete).toEqual([1]);
      expect(alive(target)).toBe(true);
      expect(fs.existsSync(dir.workDir)).toBe(true);
      expect(fs.existsSync(renderLockPath(dir.workDir))).toBe(true);
      fs.rmSync(dir.workDir, { recursive: true, force: true });
      fs.rmSync(renderLockPath(dir.workDir), { force: true });
    });

    it("a listing is only a whole `ps` run: a full buffer (ENOBUFS, status 0, tail cut), a signal or a cut last line is no listing — shutdown keeps the folder", () => {
      const G = 2_000_000_031;
      // What `ps` printed before its tail was cut: other processes only — the render's browser was in the lost tail.
      const head = "    1     1 Ss   /sbin/launchd\n  500   500 S    /usr/sbin/syslogd\n";
      const enobufs = Object.assign(new Error("spawnSync /bin/ps ENOBUFS"), { code: "ENOBUFS" });
      const runs: [string, PsRun][] = [
        ["ENOBUFS", { status: 0, signal: null, error: enobufs, stdout: head }],
        ["signal", { status: null, signal: "SIGTERM", stdout: head }],
        [
          "cut line",
          { status: 0, signal: null, stdout: `${head}  777   ${G} S    chrome --user-data-dir=/x` },
        ],
        ["failed", { status: 1, signal: null, stdout: head }],
      ];
      for (const [what, run] of runs) {
        expect(psListing(run), what).toBeUndefined();
        const dir = freshRenderDir();
        restores.push(setRenderReapForTests({ shutdownMs: 100, run: () => run }));
        const incomplete: number[] = [];
        onRenderReapIncomplete((n) => incomplete.push(n));
        trackRender(G, dir);
        killLiveRenders();
        expect(incomplete, what).toEqual([1]);
        expect(fs.existsSync(dir.workDir), what).toBe(true);
        expect(fs.existsSync(renderLockPath(dir.workDir)), what).toBe(true);
        fs.rmSync(dir.workDir, { recursive: true, force: true });
        fs.rmSync(renderLockPath(dir.workDir), { force: true });
        for (const r of restores.splice(0)) r();
      }
      // Control: the same output, whole, is a listing — and (the group gone) confirms the render.
      expect(psListing({ status: 0, signal: null, stdout: head })).toHaveLength(2);
      const dir = freshRenderDir();
      restores.push(
        setRenderReapForTests({ shutdownMs: 500, run: () => ({ status: 0, signal: null, stdout: head }) }),
      );
      const incomplete: number[] = [];
      onRenderReapIncomplete((n) => incomplete.push(n));
      trackRender(G, dir);
      killLiveRenders();
      expect(incomplete).toEqual([]);
      expect(fs.existsSync(dir.workDir)).toBe(false);
    });

    it("the watchdog's identity is its whole command line: the real `ps` row of a running watchdog matches what was spawned", async () => {
      const w = watchdog(FAKE());
      let row: { args: string } | undefined;
      expect(
        await within(10_000, () => {
          const r = spawnSync("/bin/ps", ["axww", "-o", "pid=,pgid=,stat=,args="], {
            encoding: "utf8",
            maxBuffer: 64 << 20,
            env: { LC_ALL: "C", LANG: "C" }, // as the reap runs it
          });
          row = psListing({ status: r.status, signal: r.signal, stdout: r.stdout })?.find(
            (x) => x.pid === w.l.child.pid,
          );
          return !!row;
        }),
      ).toBe(true);
      const pattern = cmdlinePattern(w.l.child.spawnargs.join(" "));
      expect(pattern.test(row!.args)).toBe(true);
      // One character changed is another command line.
      expect(pattern.test(row!.args.replace(" 30 ", " 31 "))).toBe(false);
      // Stopped by its owner (stdin closed): a TERM could come before Perl has installed its handler.
      w.l.child.stdin!.end();
      expect(await w.exited).toBe(WATCHDOG_EXIT.stopped);
    });

    it("command lines as `ps` prints them (C locale, byte by byte): each byte only in its own forms", () => {
      const p = cmdlinePattern("perl -e a\nb\t\u0085c 가.mjs /d");
      for (const shown of [
        "perl -e a\\012b\\011M-BM^Ec M-jM-0M^@.mjs /d", // macOS, C locale (as `ps` runs here)
        "perl -e a^Jb^I\\302\\205c \\352\\260\\200.mjs /d",
        "perl -e a\\012b\\011M^Ec 가.mjs /d", // macOS, a UTF-8 locale
        "perl -e a?b???c ???.mjs /d", // Linux, C locale: one `?` per byte
      ])
        expect(p.test(shown), shown).toBe(true);
      for (const other of [
        "perl -e a\\012b\\011M^Ec 나.mjs /d", // another printable character
        "perl -e a\\012b\\011M^Ec M-jM-0M^A.mjs /d", // another byte
        "perl -e a\\011b\\011M^Ec 가.mjs /d", // a tab's escape for the new line
        "perl -e a^Ib\\011M^Ec 가.mjs /d",
        "perl -e a?b???c ?.mjs /d", // one `?` for a three-byte character
        "perl -e a b???c ???.mjs /d", // a space for a control character
        "perl -e a?b???c ???.mjs /d extra",
        "x perl -e a?b???c ???.mjs /d",
      ])
        expect(p.test(other), other).toBe(false);
      // Regular-expression characters in the command line are literal.
      expect(cmdlinePattern("a.b (c)+ x-y").test("axb (c)+ x-y")).toBe(false);
      expect(cmdlinePattern("a.b (c)+ x-y").test("a.b (c)+ x-y")).toBe(true);
    });

    it("the browser's identity: its executable (non-ASCII too, as `ps` prints it) and the profile switch as a token", () => {
      const d = "/t/agentlee-render-AbC123";
      const b = browserPattern("/opt/브라우저/chrome", d);
      const cLocale = "/opt/M-kM-8M^LM-kM^]M-<M-lM^ZM-0M-l\\240M^@/chrome"; // what macOS `ps` printed in the C locale
      for (const exe of [cLocale, "/opt/브라우저/chrome", `/opt/${"?".repeat(12)}/chrome`])
        expect(b.test(`${exe} --single-process --user-data-dir=${d}/profile about:blank`), exe).toBe(true);
      for (const other of [
        `/opt/나우저/chrome --user-data-dir=${d}/profile`, // another executable
        `/opt/브라우저/chrome2 --user-data-dir=${d}/profile`,
        `/opt/브라우저/chrome --user-data-dir=${d}/profileX`, // not a token
        `/opt/브라우저/chrome x--user-data-dir=${d}/profile`,
        `logger /opt/브라우저/chrome --user-data-dir=${d}/profile`,
      ])
        expect(b.test(other), other).toBe(false);
    });

    it("real `ps` (as the reap runs it): a non-ASCII executable and command line with control characters are recognised", async () => {
      const dir = freshRenderDir();
      const exe = "/opt/브라우저/chrome";
      const browser = spawn(
        "/usr/bin/perl",
        ["-e", "sleep 30", "--", `--user-data-dir=${dir.workDir}/profile`],
        {
          argv0: exe,
          detached: true,
          stdio: "ignore",
        },
      );
      const other = spawn("/usr/bin/perl", ["-e", "sleep 30;\n#\u0001 가", "x"], {
        detached: true,
        stdio: "ignore",
      });
      for (const c of [browser, other]) startedGroups.add(c.pid!);
      try {
        for (const env of [
          { LC_ALL: "C", LANG: "C" },
          { LC_ALL: "en_US.UTF-8", LANG: "en_US.UTF-8" },
        ]) {
          let rows: { pid: number; args: string }[] = [];
          expect(
            await within(10_000, () => {
              const r = spawnSync("/bin/ps", ["axww", "-o", "pid=,pgid=,stat=,args="], {
                encoding: "utf8",
                maxBuffer: 64 << 20,
                env,
              });
              rows = psListing({ status: r.status, signal: r.signal, stdout: r.stdout }) ?? [];
              return [browser.pid, other.pid].every((pid) => rows.some((x) => x.pid === pid));
            }),
          ).toBe(true);
          const args = (pid: number) => rows.find((x) => x.pid === pid)!.args;
          expect(
            browserPattern(exe, dir.workDir).test(args(browser.pid!)),
            `${env.LC_ALL}: ${args(browser.pid!)}`,
          ).toBe(true);
          expect(
            cmdlinePattern(other.spawnargs.join(" ")).test(args(other.pid!)),
            `${env.LC_ALL}: ${args(other.pid!)}`,
          ).toBe(true);
        }
      } finally {
        for (const c of [browser, other]) c.kill("SIGKILL");
      }
    });

    it("end to end with the real listing: a browser with a non-ASCII executable, left in its group, is reaped and confirmed", async () => {
      const dir = freshRenderDir();
      const exe = "/opt/브라우저/chrome";
      const browser = spawn(
        "/usr/bin/perl",
        ["-e", "sleep 30", "--", `--user-data-dir=${dir.workDir}/profile`],
        {
          argv0: exe,
          detached: true, // its own group: it stands for the browser left in the render's group
          stdio: "ignore",
        },
      );
      startedGroups.add(browser.pid!);
      expect(await within(5000, () => alive(browser.pid!))).toBe(true);
      restores.push(setRenderReapForTests({ everyMs: 20 }));
      const incomplete: number[] = [];
      onRenderReapIncomplete((n) => incomplete.push(n));
      const forget = trackRender(browser.pid!, dir, { browser: exe });
      reapAfterWatchdog(browser.pid!);
      forget();
      releaseRenderDir(dir); // handed to the reap
      await renderReaped(dir);
      expect(incomplete).toEqual([]);
      expect(await within(5000, () => !alive(browser.pid!))).toBe(true);
      expect(fs.existsSync(dir.workDir)).toBe(false);
    });

    it("ps rows: pid, group, zombie state and the command line", () => {
      const rows = parsePs(
        "  12   12 Ss   /usr/bin/perl -e use strict; 1 30 /t/agentlee-render-abcDEF\n 13 12 Z <defunct>\nnoise\n",
      );
      expect(rows).toEqual([
        {
          pid: 12,
          pgid: 12,
          zombie: false,
          args: "/usr/bin/perl -e use strict; 1 30 /t/agentlee-render-abcDEF",
        },
        { pid: 13, pgid: 12, zombie: true, args: "<defunct>" },
      ]);
    });
  });

  it("a render that fails while its folder is prepared (e.g. a full disk) keeps no descriptor and no folder", async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-prep-")));
    closers.push(async () => fs.rmSync(root, { recursive: true, force: true }));
    const realMkdir = fs.mkdirSync.bind(fs);
    const mkdir = vi.spyOn(fs, "mkdirSync").mockImplementation(((
      p: fs.PathLike,
      o?: fs.MakeDirectoryOptions,
    ) => {
      if (String(p).endsWith(`${path.sep}home`) && String(p).includes(`${path.sep}agentlee-render-`)) {
        throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
      }
      return realMkdir(p, o);
    }) as typeof fs.mkdirSync);
    const fds = () => fs.readdirSync("/dev/fd").length;
    let launches = 0;
    const r = new Renderer({
      browser: process.execPath,
      launcher: (sp) => {
        launches++;
        return track(unsandboxedLauncher(sp));
      },
      egress: spyEgress().egress,
      tmpDir: root,
      test: { args: FAKE, probe: async () => [{ pid: 1, rss: 1 }] },
    });
    closers.push(() => r.close());
    try {
      await r.render(job("markdown", "x", "pdf")); // warm up (the proxy's own descriptors)
      const before = fds();
      for (let i = 0; i < 8; i++)
        expect(await r.render(job("markdown", "x", "pdf"))).toEqual({
          ok: false,
          code: "export_unavailable",
        });
      expect(fds()).toBe(before);
      expect(fs.readdirSync(root)).toEqual([]);
      expect(launches).toBe(0);
    } finally {
      mkdir.mockRestore();
    }
  }, 30_000);

  it("TERM to the watchdog: it stops the browser (still running: killed and reaped) and cleans up", async () => {
    const w = watchdog(FAKE());
    const pgid = w.l.child.pid!;
    let seen: number[] = [];
    expect(
      await within(10_000, () => {
        void members(pgid).then((m) => (seen = m));
        return seen.length >= 2;
      }),
    ).toBe(true);
    process.kill(pgid, "SIGTERM");
    expect(await w.exited).toBe(WATCHDOG_EXIT.stopped);
    expect(await gone(pgid)).toBe(true);
    for (const pid of seen) expect(alive(pid), `pid ${pid}`).toBe(false);
    expect(fs.existsSync(w.workDir)).toBe(false);
    expect(fs.existsSync(renderLockPath(w.workDir))).toBe(false);
  }, 30_000);

  it("the watchdog's own cap (monotonic clock) stops a browser the (living) owner never stops, and cleans up", async () => {
    const started = Date.now();
    const w = watchdog(FAKE(), { deadlineSec: 1 });
    expect(await w.exited).toBe(WATCHDOG_EXIT.stopped);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(await gone(w.l.child.pid!)).toBe(true);
    expect(fs.existsSync(w.workDir)).toBe(false);
    expect(fs.existsSync(renderLockPath(w.workDir))).toBe(false);
  }, 30_000);

  it("a browser that ends by itself: the watchdog removes the folder and lock before it exits 0", async () => {
    const w = watchdog([FAKE_JS, "ok"]);
    expect(await within(SETTLE_MS, () => alive(w.l.child.pid!))).toBe(true);
    w.l.input.end(); // the stand-in ends when its command pipe closes (as after `Browser.close`)
    expect(await w.exited).toBe(WATCHDOG_EXIT.done);
    expect(await gone(w.l.child.pid!)).toBe(true);
    expect(fs.existsSync(w.workDir)).toBe(false);
    expect(fs.existsSync(renderLockPath(w.workDir))).toBe(false);
  }, 30_000);

  it.skipIf(!darwin)(
    "a folder that cannot be removed keeps its lock (server and watchdog alike), so the sweep tries again",
    async () => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-keep-")));
      const stuck: string[] = [];
      const flags = (f: string, on: boolean) =>
        spawnSync("/usr/bin/chflags", [on ? "uchg" : "nouchg", f]).status;
      closers.push(async () => {
        for (const f of stuck) flags(f, false);
        fs.rmSync(root, { recursive: true, force: true });
      });
      /** A render folder holding an immutable file (macOS `uchg`): nothing — not even its owner — removes it. */
      const undeletable = () => {
        const d = makeRenderDir(root);
        closers.push(async () => removeRenderDir(d)); // closes the server's descriptor
        const f = path.join(d.workDir, "stuck");
        fs.writeFileSync(f, "synthetic");
        expect(flags(f, true)).toBe(0);
        stuck.push(f);
        return d;
      };
      const server = undeletable();
      removeRenderDir(server);
      expect(fs.existsSync(server.workDir)).toBe(true);
      expect(fs.existsSync(renderLockPath(server.workDir))).toBe(true);
      const wd = undeletable();
      const w = watchdog([FAKE_JS, "ok"], { dir: wd });
      expect(await within(SETTLE_MS, () => alive(w.l.child.pid!))).toBe(true);
      w.l.input.end();
      expect(await w.exited).toBe(WATCHDOG_EXIT.done);
      expect(fs.existsSync(wd.workDir)).toBe(true);
      expect(fs.existsSync(renderLockPath(wd.workDir))).toBe(true);
      // The server's own clean-up after it (its `finally`) fails the same way, and closes its descriptor: the lock is
      // free only now (flock belongs to the open file, which the server shares with the watchdog and the browser).
      removeRenderDir(wd);
      expect(fs.existsSync(renderLockPath(wd.workDir))).toBe(true);
      // Once removable, the sweep (the locks are free) takes both.
      for (const f of stuck) flags(f, false);
      expect(await sweepRenderDirs(root, { graceSec: 0 })).toEqual({ removed: 2, lockless: 0 });
    },
    30_000,
  );

  it("exit status: a browser that exits 127 by itself is `done`; a browser that cannot be executed is `execFailed`", async () => {
    const own = watchdog([FAKE_JS, "exit127"]);
    expect(await own.exited).toBe(WATCHDOG_EXIT.done);
    const missing = watchdog([], {
      browser: path.join(os.tmpdir(), `no-such-browser-${crypto.randomUUID()}`),
    });
    expect(await missing.exited).toBe(WATCHDOG_EXIT.execFailed);
    for (const w of [own, missing]) {
      expect(fs.existsSync(w.workDir)).toBe(false);
      expect(fs.existsSync(renderLockPath(w.workDir))).toBe(false);
    }
  }, 30_000);

  it("the lock: the watchdog locks the server's own descriptor — a file put at the path is neither locked nor unlinked", async () => {
    /** Whether `file` can be flocked right now (a separate process, without waiting). */
    const lockable = (file: string) =>
      spawnSync("/usr/bin/perl", [
        "-e",
        'open(my $f, "<", $ARGV[0]) or exit 2; flock($f, 6) ? exit 0 : exit 1',
        file,
      ]).status === 0;
    const d = freshRenderDir();
    const lockPath = renderLockPath(d.workDir);
    // The server's file moves away (kept, so its inode cannot be reused); another file takes the path.
    fs.renameSync(lockPath, `${lockPath}.orig`);
    closers.push(async () => fs.rmSync(`${lockPath}.orig`, { force: true }));
    fs.writeFileSync(lockPath, "");
    closers.push(async () => fs.rmSync(lockPath, { force: true }));
    expect(fs.statSync(lockPath).ino).not.toBe(fs.statSync(`${lockPath}.orig`).ino);
    const w = watchdog([FAKE_JS, "ok"], { dir: d });
    expect(await within(SETTLE_MS, () => !lockable(`${lockPath}.orig`))).toBe(true); // the server's file: held
    expect(lockable(lockPath)).toBe(true); // the stand-in at the path: not
    w.l.input.end();
    expect(await w.exited).toBe(WATCHDOG_EXIT.done);
    expect(fs.existsSync(d.workDir)).toBe(false);
    expect(fs.existsSync(lockPath)).toBe(true); // not the file it locked: left alone
    expect(fs.existsSync(`${lockPath}.orig`)).toBe(true);
  }, 30_000);

  it("the lock reaches the browser: fd 5 is the server's file, read-only, and the browser alone still holds the lock", async () => {
    const lockable = (file: string) =>
      spawnSync("/usr/bin/perl", [
        "-e",
        'open(my $f, "<", $ARGV[0]) or exit 2; flock($f, 6) ? exit 0 : exit 1',
        file,
      ]).status === 0;
    const info = path.join(fs.realpathSync(os.tmpdir()), `agentlee-fd5-${crypto.randomUUID()}`);
    closers.push(async () => fs.rmSync(info, { force: true }));
    const d = freshRenderDir();
    const lockPath = renderLockPath(d.workDir);
    closers.push(async () => fs.rmSync(lockPath, { force: true })); // the descriptor is closed by hand below
    const serverIno = fs.fstatSync(d.lockFd).ino;
    const w = watchdog(FAKE(), { dir: d, env: { FD5FILE: info } });
    expect(await within(10_000, () => fs.existsSync(info) && fs.readFileSync(info, "utf8").length > 0)).toBe(
      true,
    );
    const got = JSON.parse(fs.readFileSync(info, "utf8")) as {
      pid: number;
      ino: number | null;
      writable: boolean;
    };
    expect(got.ino).toBe(serverIno);
    expect(got.writable).toBe(false);
    // Only the browser left: the watchdog killed alone, the server's descriptor closed.
    process.kill(w.l.child.pid!, "SIGKILL");
    await w.exited;
    fs.closeSync(d.lockFd);
    d.lockFd = -1;
    expect(alive(got.pid)).toBe(true);
    expect(lockable(lockPath)).toBe(false); // still held — by the browser
    process.kill(-w.l.child.pid!, "SIGKILL"); // the group (the browser is in it)
    expect(await gone(w.l.child.pid!)).toBe(true);
    expect(await within(SETTLE_MS, () => lockable(lockPath))).toBe(true);
  }, 30_000);

  it("the lock: no descriptor 5, or one that is not a regular file, and the watchdog does not start", async () => {
    const d = freshRenderDir();
    const start = (fd5: "ignore" | "pipe") => {
      const [command, ...args] = watchdogPrefix({
        browser: process.execPath,
        args: FAKE(),
        env: {},
        workDir: d.workDir,
        lockFd: d.lockFd,
        proxyPort: 1,
        deadlineSec: 30,
      });
      const child = spawn(command!, [...args, process.execPath, ...FAKE()], {
        detached: true,
        stdio: ["pipe", "ignore", "ignore", "pipe", "pipe", fd5],
      });
      startedGroups.add(child.pid!);
      return new Promise<number | null>((r) => child.once("exit", (code) => r(code)));
    };
    expect(await start("ignore")).toBe(WATCHDOG_EXIT.notStarted);
    expect(await start("pipe")).toBe(WATCHDOG_EXIT.notStarted);
    expect(fs.existsSync(renderLockPath(d.workDir))).toBe(true);
  }, 30_000);

  it("the server's reaction to the watchdog's status: its own codes kill nothing; any other end reaps its processes by pid — no group signal (#215)", async () => {
    // Stand-in watchdogs: a good render, then an exit with the given status; a "browser" in their group (a sleeper
    // carrying the browser's identity: the browser executable launched, with `--user-data-dir=<folder>/profile`).
    let groupSignals = 0;
    const react = async (status: number) => {
      const p = pidFile();
      let pgid = 0;
      const launcher: Launcher = (s) => {
        const child = spawn(
          "/bin/sh",
          [
            "-c",
            `'${process.execPath}' -e 'setTimeout(() => {}, 30000)' -- '--user-data-dir=${s.workDir}/profile' & echo $! > '${p.f}'; exec '${process.execPath}' '${FAKE_JS}' ok-exit`,
          ],
          {
            env: { EXIT_CODE: String(status) },
            detached: true,
            stdio: ["pipe", "pipe", "ignore", "pipe", "pipe"],
          },
        );
        startedGroups.add(child.pid!);
        pgid = child.pid!;
        return { child, input: child.stdio[3] as Writable, output: child.stdio[4] as Readable };
      };
      const r = new Renderer({
        browser: process.execPath,
        launcher,
        egress: spyEgress().egress,
        limits: { settleMs: 0 },
        test: { probe: async () => [{ pid: 1, rss: 1 }] },
      });
      closers.push(() => r.close());
      const kill = vi.spyOn(process, "kill");
      try {
        expect((await r.render(job("markdown", "x", "pdf"))).ok).toBe(true);
        groupSignals += kill.mock.calls.filter(([t, sig]) => t === -pgid && sig === "SIGKILL").length;
      } finally {
        kill.mockRestore();
      }
      const sleeper = p.pid()!;
      expect(sleeper).toBeGreaterThan(0);
      return within(1000, () => !alive(sleeper)).then((dead) => !dead);
    };
    const X = WATCHDOG_EXIT;
    for (const s of [X.done, X.stopped, X.notStarted, X.execFailed])
      expect(await react(s), `status ${s}`).toBe(true);
    expect(await react(1)).toBe(false);
    // The watchdog was already reaped when its end was seen: its group id is never signalled.
    expect(groupSignals).toBe(0);
  }, 60_000);

  it("shutdown: closeRenderers turns queued renders away, starts no new browser, and kills the running one", async () => {
    const { r, launches } = orphanRenderer({ limits: { timeoutMs: 60_000, concurrent: 1, queue: 2 } });
    const before = liveRenderCount();
    const first = r.render(job("markdown", "x", "pdf"));
    const queued = [r.render(job("markdown", "y", "pdf")), r.render(job("markdown", "z", "pdf"))];
    expect(await within(10_000, () => liveRenderCount() === before + 1)).toBe(true);
    expect(closeRenderers()).toBe(before + 1);
    expect(await first).toEqual({ ok: false, code: "export_failed" });
    expect(await Promise.all(queued)).toEqual([
      { ok: false, code: "export_unavailable" },
      { ok: false, code: "export_unavailable" },
    ]);
    // A render asked for after shutdown is refused too; only the first ever started a browser.
    expect(await r.render(job("markdown", "w", "pdf"))).toEqual({ ok: false, code: "export_unavailable" });
    expect(launches).toHaveLength(1);
    expect(await gone(launches[0]!.pgid)).toBe(true);
    expect(fs.existsSync(launches[0]!.workDir)).toBe(false);
    expect(liveRenderCount()).toBe(0);
  }, 30_000);

  it("shutdown while a render waits for its proxy: no browser is started", async () => {
    const { r, launches } = orphanRenderer();
    const pending = r.render(job("markdown", "x", "pdf"));
    r.shutdown();
    expect(await pending).toEqual({ ok: false, code: "export_unavailable" });
    expect(launches).toHaveLength(0);
  }, 30_000);

  it("a browser's own exit code ≥ 126 after a good render is not a watchdog failure: no kill of its group", async () => {
    let l: Launched | undefined;
    const launcher: Launcher = (s) => {
      l = track(unsandboxedLauncher(s));
      return l;
    };
    const r = new Renderer({
      browser: process.execPath,
      launcher,
      egress: spyEgress().egress,
      limits: { settleMs: 0 },
      test: { args: () => [FAKE_JS, "ok-130"], probe: async () => [{ pid: 1, rss: 1 }] },
    });
    closers.push(() => r.close());
    const kill = vi.spyOn(process, "kill");
    try {
      const res = await r.render(job("markdown", "x", "pdf"));
      expect(res.ok).toBe(true);
      await new Promise((done) => setTimeout(done, 300)); // the watchdog's exit is handled by now
      expect(kill.mock.calls.filter(([p]) => p === -l!.child.pid!)).toEqual([]);
    } finally {
      kill.mockRestore();
    }
    expect(await gone(l!.child.pid!)).toBe(true);
  }, 30_000);

  /** A sweep root with old render folders (and their locks) and other things beside them. */
  function sweepRoot() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-sweep-")));
    closers.push(async () => fs.rmSync(root, { recursive: true, force: true }));
    const old = new Date(Date.now() - 3600_000);
    const age = (p: string) => fs.lutimesSync(p, old, old);
    const dir = (name: string, lock: boolean | "fifo" | "link", aged = true) => {
      const d = path.join(root, name);
      fs.mkdirSync(path.join(d, "profile"), { recursive: true });
      fs.writeFileSync(path.join(d, "profile", "x"), "synthetic");
      const l = renderLockPath(d);
      if (lock === true) fs.writeFileSync(l, "");
      if (lock === "fifo") expect(spawnSync("/usr/bin/mkfifo", [l]).status).toBe(0);
      if (lock === "link") fs.symlinkSync(path.join(root, "elsewhere"), l);
      if (lock && aged) age(l);
      if (aged) age(d);
      return d;
    };
    const holdLock = async (file: string) => {
      const holder = spawn(
        "/usr/bin/perl",
        ["-e", '$|=1; open(my $f, "<", $ARGV[0]) or die; flock($f, 2) or die; print "L\\n"; sleep 30', file],
        { detached: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      startedGroups.add(holder.pid!);
      let said = "";
      holder.stdout.on("data", (d: Buffer) => (said += d.toString()));
      expect(await within(SETTLE_MS, () => said.includes("L"))).toBe(true);
      return holder;
    };
    return { root, age, dir, holdLock };
  }

  it("sweep: only a free lock beside an old folder of ours is proof — everything else is kept; lock-less folders are counted", async () => {
    const t = sweepRoot();
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-sweep-target-")));
    closers.push(async () => fs.rmSync(outside, { recursive: true, force: true }));
    fs.writeFileSync(path.join(outside, "keep"), "synthetic");
    const freeLock = t.dir("agentlee-render-aaaaaa", true); // its watchdog and browser are gone
    const heldLock = t.dir("agentlee-render-bbbbbb", true); // someone still holds it
    const noLock = t.dir("agentlee-render-cccccc", false); // pre-watchdog leftover, or died before its lock
    const fifoLock = t.dir("agentlee-render-dddddd", "fifo"); // not a regular file: no proof (and no hang)
    const linkLock = t.dir("agentlee-render-eeeeee", "link"); // a symlink: no proof
    const fresh = t.dir("agentlee-render-ffffff", true, false); // too young to judge
    const other = t.dir("agentlee-other-gggggg", false); // not ours
    const odd = t.dir("agentlee-render-toolong1", true); // not a mkdtemp name of ours
    fs.symlinkSync(outside, path.join(t.root, "agentlee-render-hhhhhh")); // a symlinked "folder"
    fs.writeFileSync(path.join(t.root, "agentlee-render-hhhhhh.lock"), "");
    t.age(path.join(t.root, "agentlee-render-hhhhhh"));
    t.age(path.join(t.root, "agentlee-render-hhhhhh.lock"));
    const strayFree = path.join(t.root, "agentlee-render-iiiiii.lock"); // a lock whose folder is gone
    fs.writeFileSync(strayFree, "");
    t.age(strayFree);
    const strayHeld = path.join(t.root, "agentlee-render-jjjjjj.lock");
    fs.writeFileSync(strayHeld, "");
    t.age(strayHeld);
    const holders = [await t.holdLock(renderLockPath(heldLock)), await t.holdLock(strayHeld)];

    const started = Date.now();
    expect(await sweepRenderDirs(t.root, { graceSec: 600 })).toEqual({ removed: 1, lockless: 1 });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(fs.existsSync(freeLock)).toBe(false);
    expect(fs.existsSync(renderLockPath(freeLock))).toBe(false);
    for (const d of [heldLock, noLock, fifoLock, linkLock, fresh, other, odd])
      expect(fs.existsSync(d), d).toBe(true);
    expect(fs.existsSync(renderLockPath(heldLock))).toBe(true);
    expect(fs.lstatSync(path.join(t.root, "agentlee-render-hhhhhh")).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outside, "keep"), "utf8")).toBe("synthetic");
    expect(fs.existsSync(strayFree)).toBe(false);
    expect(fs.existsSync(strayHeld)).toBe(true);

    // Once the holders are gone, their folder and stray lock go too; the lock-less folder is still only counted.
    for (const h of holders) {
      process.kill(-h.pid!, "SIGKILL");
      expect(await gone(h.pid!)).toBe(true);
    }
    expect(await sweepRenderDirs(t.root, { graceSec: 600 })).toEqual({ removed: 1, lockless: 1 });
    expect(fs.existsSync(heldLock)).toBe(false);
    expect(fs.existsSync(strayHeld)).toBe(false);
    expect(fs.existsSync(noLock)).toBe(true);
    await expect(sweepRenderDirs(path.join(t.root, "none"), { graceSec: 600 })).resolves.toEqual({
      removed: 0,
      lockless: 0,
    });
  }, 60_000);

  it("sweep budget: past it the sweep stops between names and the next one resumes after the last it judged (wrapping)", async () => {
    const t = sweepRoot();
    const ds = ["aaaaaa", "bbbbbb", "cccccc"].map((n) => t.dir(`agentlee-render-${n}`, true));
    // A budget of 0: exactly one name per sweep (folders and their locks are separate names).
    const r1 = await sweepRenderDirs(t.root, { budgetSec: 0 });
    expect(r1).toEqual({ removed: 1, lockless: 0, next: "agentlee-render-aaaaaa" });
    expect(fs.existsSync(ds[0]!)).toBe(false);
    const r2 = await sweepRenderDirs(t.root, { budgetSec: 0, after: "agentlee-render-bbbbbb.lock" });
    expect(r2).toEqual({ removed: 1, lockless: 0, next: "agentlee-render-cccccc" });
    // Resuming past the end wraps around: "bbbbbb" (before the resume point) is judged too.
    expect(await sweepRenderDirs(t.root, { after: r2.next! })).toEqual({ removed: 1, lockless: 0 });
    for (const d of ds) expect(fs.existsSync(d)).toBe(false);
  }, 60_000);

  it("sweep owner: with its owner's pipe already closed the sweep stops before the first name", async () => {
    const t = sweepRoot();
    const d = t.dir("agentlee-render-aaaaaa", true);
    const perl = spawnSync("/usr/bin/perl", ["-e", SWEEP_PL, t.root, "600", String(process.pid), "-", "45"], {
      stdio: ["ignore", "pipe", "ignore"], // stdin: /dev/null — EOF at once
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(perl.stdout).toBe("0 0 -\n");
    expect(fs.existsSync(d)).toBe(true);
  }, 30_000);

  it("sweep lifetime: stop() kills the running sweep, returns within its bound, and nothing is deleted after it", async () => {
    const t = sweepRoot();
    const big = t.dir("agentlee-render-aaaaaa", true);
    const files = path.join(big, "profile");
    for (let i = 0; i < 40_000; i++) fs.writeFileSync(path.join(files, `f${i}`), "");
    t.age(big);
    const count = () => (fs.existsSync(files) ? fs.readdirSync(files).length : 0);
    const stop = startRenderSweeps(t.root, 3600_000, { graceSec: 600 });
    expect(await within(20_000, () => count() < 40_000)).toBe(true); // it is deleting
    const started = Date.now();
    await stop();
    expect(Date.now() - started).toBeLessThan(SWEEP_STOP_WAIT_MS + 500);
    const left = count();
    await new Promise((r) => setTimeout(r, 300));
    expect(count()).toBe(left);
  }, 120_000);
});

describe("the production launcher's sandbox policy (checked on every platform)", () => {
  const spec = () => {
    const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-policy-")));
    const browserDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-browser-")));
    const browser = path.join(browserDir, "chrome-headless-shell");
    fs.writeFileSync(browser, "");
    closers.push(async () => {
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.rmSync(browserDir, { recursive: true, force: true });
    });
    return {
      browser,
      browserDir,
      workDir,
      proxyPort: 41234,
      lockFd: 7,
      deadlineSec: 30,
      env: { HOME: path.join(workDir, "home"), TMPDIR: path.join(workDir, "tmp") },
      args: browserArgs(path.join(workDir, "profile"), "http://127.0.0.1:41234"),
    };
  };

  it("spawn options: the proxy port only, read = the browser's folder, write = the render's folder, its env, two pipes", () => {
    const s = spec();
    const o = rendererSandbox(s);
    expect(o).toEqual({
      command: s.browser,
      args: s.args,
      cwd: s.workDir,
      env: s.env,
      read: [],
      trusted: [s.browserDir],
      write: [s.workDir],
      network: { loopbackPorts: [41234] },
      extraPipes: 2,
      // The watchdog (#170) in front of sandbox-exec, outside the sandbox: owner = this process, the cap, the folder.
      wrap: watchdogPrefix(s),
      // The server's descriptor of the lock, as the watchdog's fd 5.
      inheritFds: [7],
    });
    expect(o.wrap!.slice(0, 2)).toEqual(["/usr/bin/perl", "-e"]);
    expect(o.wrap!.slice(3)).toEqual([String(process.pid), "30", s.workDir]);
  });

  it("the generated profile: deny by default, no fork, no other network, no other writes", () => {
    const s = spec();
    const profile = buildProfile(rendererSandbox(s));
    const lines = profile.trim().split("\n");
    expect(lines.slice(0, 2)).toEqual(["(version 1)", "(deny default)"]);
    expect(profile).not.toMatch(/process-fork/);
    expect(lines.filter((l) => l.includes("network"))).toEqual([
      '(allow network-outbound (remote ip "localhost:41234"))',
    ]);
    expect(lines.filter((l) => l.includes("file-write"))).toEqual([
      `(allow file-read* file-write* (subpath "${s.workDir}"))`,
    ]);
    expect(lines.filter((l) => l.startsWith("(allow process-exec"))).toEqual([
      `(allow process-exec (literal "${s.browser}"))`,
    ]);
    expect(lines.filter((l) => l.includes("(subpath "))).toEqual([
      `(allow file-read* (subpath "${s.browserDir}"))`,
      `(allow file-read* file-write* (subpath "${s.workDir}"))`,
    ]);
    expect(lines.some((l) => l.includes("mach-lookup") || l.includes("(allow network*)"))).toBe(false);
  });
});

/** A UDP listener on 127.0.0.1 that counts what arrives (STUN from WebRTC, anything else). */
/**
 * A UDP listener on 127.0.0.1 that counts what reaches it. It answers a STUN binding request (#207 review) so that a
 * document's STUN attempt that does get through ends at once (a server-reflexive candidate) instead of after Chrome's
 * ~40 s STUN timeout.
 */
async function udpListener() {
  const sock = dgram.createSocket("udp4");
  const got = { n: 0 };
  const COOKIE = 0x2112a442;
  sock.on("message", (m, from) => {
    got.n++;
    if (m.length < 20 || m.readUInt16BE(0) !== 0x0001 || m.readUInt32BE(4) !== COOKIE) return;
    const res = Buffer.alloc(32);
    res.writeUInt16BE(0x0101, 0); // binding success
    res.writeUInt16BE(12, 2);
    res.writeUInt32BE(COOKIE, 4);
    m.copy(res, 8, 8, 20); // transaction id
    res.writeUInt16BE(0x0020, 20); // XOR-MAPPED-ADDRESS
    res.writeUInt16BE(8, 22);
    res.writeUInt16BE(0x0001, 24); // IPv4
    res.writeUInt16BE(from.port ^ (COOKIE >>> 16), 26);
    res.writeUInt32BE((from.address.split(".").reduce((a, b) => a * 256 + Number(b), 0) ^ COOKIE) >>> 0, 28);
    sock.send(res, from.port, from.address);
  });
  await new Promise<void>((r) => sock.bind(0, "127.0.0.1", () => r()));
  closers.push(() => new Promise<void>((r) => sock.close(() => r())));
  return { port: sock.address().port, got };
}

const webrtcHtml = (udpPort: number) => `<!doctype html><p>rtc</p><script>
  const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${udpPort}" }] });
  // How far ICE gathering got: finished (the state, or the final null candidate), and how many STUN attempts failed
  // (a UDP socket refused or closed).
  window.ice = { complete: false, errors: 0 };
  pc.addEventListener("icecandidate", (e) => {
    if (!e.candidate) window.ice.complete = true;
  });
  pc.addEventListener("icecandidateerror", () => window.ice.errors++);
  pc.addEventListener("icegatheringstatechange", () => {
    if (pc.iceGatheringState === "complete") window.ice.complete = true;
  });
  pc.createDataChannel("x");
  pc.createOffer().then((o) => pc.setLocalDescription(o));
</script>`;
type IceState = { complete: boolean; errors: number };
/**
 * After the load: waits until `done(ice)` holds for the document's ICE gathering (`window.ice`), so the capture never
 * ends the browser before the document has tried its UDP (#207 review). Not reached within the deadline (below the
 * render's own budget) → the render fails, and with it the test.
 */
const afterIce =
  (done: (ice: IceState) => boolean) =>
  async (send: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => {
    const end = Date.now() + 45_000;
    for (;;) {
      const r = (await send("Runtime.evaluate", { expression: "window.ice", returnByValue: true })) as {
        result?: { value?: IceState };
      };
      if (r.result?.value && done(r.result.value)) return;
      if (Date.now() > end) throw new Error(`ICE: not reached (${JSON.stringify(r.result?.value)})`);
      await new Promise((d) => setTimeout(d, 50));
    }
  };
const dropWebrtcPolicy = (a: string[]) => a.filter((x) => !x.startsWith("--force-webrtc-ip-handling-policy"));

describe.skipIf(!BROWSER)("more ways out: WebRTC/UDP, redirects, data:/blob:/file:", SLOW, () => {
  it("WebRTC: no UDP leaves the renderer (control: without the policy switch and the sandbox it does)", async () => {
    const control = await udpListener();
    const c = renderer({
      launcher: unsandboxedLauncher,
      test: {
        csp: false,
        intercept: false,
        proxy: false,
        args: dropWebrtcPolicy,
        // Gathering finished (its STUN answered by the listener) and the UDP arrived, before the capture (#207).
        afterLoad: afterIce((ice) => ice.complete && control.got.n > 0),
      },
    });
    expect((await c.r.render(job("html", webrtcHtml(control.port), "pdf"))).ok).toBe(true);
    expect(control.got.n).toBeGreaterThan(0);
    const prod = await udpListener();
    // The same stage: gathering finished (with the policy switch there is no UDP socket to try), then nothing came.
    const p = renderer({ test: { afterLoad: afterIce((ice) => ice.complete) } });
    expect((await p.r.render(job("html", webrtcHtml(prod.port), "pdf"))).ok).toBe(true);
    expect(prod.got.n).toBe(0);
    // QUIC (HTTP/3 over UDP) is off too: everything is TCP to the proxy.
    expect(browserArgs("/p", "http://127.0.0.1:1")).toContain("--disable-quic");
    // RenderDocument off: with it the single-process shell could end itself on a self-navigating document (#207).
    expect(browserArgs("/p", undefined).find((a) => a.startsWith("--disable-features="))).toMatch(
      /[=,]RenderDocument(,|$)/,
    );
  });

  it("redirects: every hop is checked again — an allowed URL that redirects to the app is stopped at the hop", async () => {
    app.hits.length = 0;
    const redirect = `http://127.0.0.1:${app.port}/redirect-to-api`;
    const after = `http://127.0.0.1:${app.port}/api/after-redirect`;
    let blockedHop = false;
    const wait = selfNavigation("/api/after-redirect", () => blockedHop);
    const { r, blocked } = renderer({
      launcher: unsandboxedLauncher,
      test: {
        csp: false,
        proxy: false,
        allowUrls: [redirect],
        ...wait,
        blocked: (u) => {
          blocked.push(u);
          if (u === after) blockedHop = true;
        },
      },
    });
    const html = `<!doctype html><p>r</p><script>window.go = () => setTimeout(() => { location.href = "${redirect}"; });</script>`;
    expect(await r.render(job("html", html, "pdf"))).toMatchObject({ ok: true });
    // The allowed first hop went out (so the test does exercise a redirect); its target never did.
    expect(app.hits.map((h) => h.url)).toEqual(["/redirect-to-api"]);
    expect(blocked).toContain(`http://127.0.0.1:${app.port}/api/after-redirect`);
  });

  it("data:, blob: and file: — a frame, a worker or a navigation from them reaches nothing, and no local file is read", async () => {
    app.hits.length = 0;
    const secretDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-secret-")));
    closers.push(async () => fs.rmSync(secretDir, { recursive: true, force: true }));
    const secret = path.join(secretDir, "secret.html");
    fs.writeFileSync(secret, "<p>FAMILY-SECRET</p>");
    const target = `http://127.0.0.1:${app.port}/api/from-data`;
    const inner = encodeURIComponent(`<script>fetch("${target}");location.href="${target}"</script>`);
    const html = `<!doctype html><p>d</p>
<iframe src="data:text/html,${inner}"></iframe>
<iframe src="file://${secret}"></iframe>
<script>
  const w = new Worker(URL.createObjectURL(new Blob(['fetch("http://127.0.0.1:${app.port}/api/from-blob")'], { type: "text/javascript" })));
  setTimeout(() => { location.href = "file://${secret}"; }, 30);
</script>`;
    const seen: unknown[] = [];
    const { r } = renderer({
      test: {
        csp: false,
        afterLoad: async (send) => {
          seen.push(
            await send("Runtime.evaluate", { expression: "location.href + ' ' + document.body.innerText" }),
          );
        },
      },
    });
    await r.render(job("html", html, "pdf"));
    expect(app.hits).toEqual([]);
    expect(JSON.stringify(seen)).not.toContain("FAMILY-SECRET");
    expect(JSON.stringify(seen)).toContain(DOCUMENT_URL);
  });
});

describe.skipIf(!BROWSER || !darwin)("the macOS kernel layer itself (production launcher)", SLOW, () => {
  it("positive control: with every browser layer off, a document still renders inside the sandbox", async () => {
    const { r } = renderer({
      launcher: sandboxedLauncher,
      test: { csp: false, intercept: false, proxy: false },
    });
    const png = ok(await r.render(job("chart", chart, "png")));
    expect(isPng(png)).toBe(true);
  });

  it("files: the browser itself (asked over DevTools, past every web rule) cannot open a file outside its folders", async () => {
    const secretDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-secret-")));
    closers.push(async () => fs.rmSync(secretDir, { recursive: true, force: true }));
    const secret = path.join(secretDir, "secret.html");
    fs.writeFileSync(secret, "<p>FAMILY-SECRET</p>");
    const read = async (launcher: Launcher) => {
      const seen: unknown[] = [];
      const { r } = renderer({
        launcher,
        test: {
          afterLoad: async (send) => {
            await send("Fetch.disable");
            await send("Page.navigate", { url: `file://${secret}` });
            await new Promise((res) => setTimeout(res, 500));
            seen.push(
              await send("Runtime.evaluate", { expression: "document.body ? document.body.innerText : ''" }),
            );
          },
        },
      });
      await r.render(job("markdown", "x", "pdf"));
      return JSON.stringify(seen);
    };
    expect(await read(unsandboxedLauncher)).toContain("FAMILY-SECRET"); // control
    expect(await read(sandboxedLauncher)).not.toContain("FAMILY-SECRET");
  });

  it("the kernel refuses UDP under the renderer's own profile: a probe's send fails (EPERM), nothing arrives; without the profile it does", async () => {
    // The authoritative check of the kernel rule (#207 review): one process, one datagram, the errno — no inference
    // from how Chrome's ICE behaves.
    const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-probe-")));
    closers.push(async () => fs.rmSync(workDir, { recursive: true, force: true }));
    const node = fs.realpathSync(process.execPath);
    const probe = [path.join(FIXTURES, "net-probe.mjs"), "udp"];
    // Control: the same probe without the profile reaches the listener.
    const open = await udpListener();
    const c = spawnSync(node, [...probe, String(open.port)], { encoding: "utf8", timeout: 20_000 });
    expect(JSON.parse(c.stdout)).toEqual({ udpLocal: "sent" });
    expect(await within(SETTLE_MS, () => open.got.n > 0)).toBe(true);
    // Under the renderer's profile (the one its browser runs in): the send itself is refused by the kernel.
    const shut = await udpListener();
    const policy = rendererSandbox({
      browser: node,
      args: [],
      env: {},
      workDir,
      proxyPort: 9,
      lockFd: -1,
      deadlineSec: 30,
    });
    const r = await runIsolated({
      ...policy,
      command: node,
      args: [...probe, String(shut.port)],
      read: [FIXTURES],
      timeoutMs: 20_000,
      maxOutputBytes: 100_000,
    });
    expect(JSON.parse(r.stdout).udpLocal).toMatch(/^err:(EPERM|EACCES)$/);
    await new Promise((d) => setTimeout(d, 300));
    expect(shut.got.n).toBe(0);
  });

  it("smoke (not authoritative): Chrome in the sandbox with the policy switch dropped and every browser layer off sends no UDP", async () => {
    // A secondary check only: Chrome's gathering never reports "complete" here (after the kernel refuses the send it
    // closes each socket — a 701 candidate error — and stays "gathering"; measured over 50 s), so this render cannot
    // prove that no send came late. The kernel rule itself is checked deterministically by the probe above.
    const l = await udpListener();
    const { r } = renderer({
      launcher: sandboxedLauncher,
      test: {
        csp: false,
        intercept: false,
        proxy: false,
        args: dropWebrtcPolicy,
        afterLoad: afterIce((ice) => ice.complete || ice.errors > 0),
      },
    });
    expect((await r.render(job("html", webrtcHtml(l.port), "pdf"))).ok).toBe(true);
    expect(l.got.n).toBe(0);
  });

  it("the renderer's network policy, probed directly: no DNS, no UDP, no TCP but the proxy port", async () => {
    const l = await udpListener();
    const listen = async () => {
      const srv = net.createServer((c) => c.destroy());
      await new Promise<void>((res) => srv.listen(0, "127.0.0.1", () => res()));
      closers.push(() => new Promise<void>((res) => srv.close(() => res())));
      return (srv.address() as AddressInfo).port;
    };
    const proxyPort = await listen();
    const otherPort = await listen();
    const workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-probe-")));
    closers.push(async () => fs.rmSync(workDir, { recursive: true, force: true }));
    const node = fs.realpathSync(process.execPath);
    const policy = rendererSandbox({
      browser: node,
      args: [],
      env: {},
      workDir,
      proxyPort,
      lockFd: -1,
      deadlineSec: 30,
    });
    const r = await runIsolated({
      ...policy,
      command: node,
      args: [path.join(FIXTURES, "net-probe.mjs"), String(l.port), String(proxyPort), String(otherPort)],
      read: [FIXTURES],
      timeoutMs: 20_000,
      maxOutputBytes: 100_000,
    });
    const out = JSON.parse(r.stdout) as Record<string, string>;
    expect(out.tcpProxy).toBe("ok"); // positive control: the one allowed way works
    expect(out.tcpOther).toMatch(/^err:/);
    expect(out.udpLocal).toMatch(/^err:/);
    expect(out.udpDns).toMatch(/^err:/);
    expect(out.lookup).toMatch(/^err:/);
    expect(l.got.n).toBe(0);
  });
});
