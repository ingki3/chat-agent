import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ARTIFACT_EXPORTS, type ArtifactKind } from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import {
  browserArgs,
  findBrowser,
  sandboxedLauncher,
  unsandboxedLauncher,
  type Launcher,
} from "../src/artifacts/browser.js";
import {
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
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

/** "The app": a local server on 127.0.0.1 that records every request it gets (path and cookie header). */
const app = {
  port: 0,
  hits: [] as { url: string; cookie: string | undefined }[],
  server: undefined as http.Server | undefined,
};
beforeAll(async () => {
  app.server = http.createServer((req, res) => {
    app.hits.push({ url: req.url ?? "", cookie: req.headers.cookie });
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

function renderer(o: Partial<RendererOptions> = {}) {
  const spy = spyEgress();
  const blocked: string[] = [];
  const r = new Renderer({
    browser: BROWSER,
    launcher: PROD_LAUNCHER,
    egress: spy.egress,
    ...o,
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

/** Every way a document can ask for the app (loopback), the home network, metadata or another host. */
function attackHtml(port: number) {
  const app = `http://127.0.0.1:${port}`;
  return `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${app}/api/css">
<link rel="prefetch" href="${app}/api/prefetch">
<script src="${app}/api/script.js"></script>
</head><body><h1>공격 문서</h1>
<img src="${app}/api/img"><img src="http://10.0.0.1/x.png"><img src="http://192.168.1.1/x.png">
<img src="http://169.254.169.254/latest/meta-data/"><img src="http://localhost:${port}/api/localhost">
<img src="http://[::1]:${port}/api/v6"><img src="https://example.org/public.png">
<iframe src="${app}/api/frame"></iframe>
<script>
  fetch("${app}/api/conversations", { credentials: "include" }).catch(() => {});
  fetch("http://10.0.0.1/api/x").catch(() => {});
  navigator.sendBeacon && navigator.sendBeacon("${app}/api/beacon", "x");
  try { new WebSocket("ws://127.0.0.1:${port}/api/ws"); } catch (e) {}
  // CSP does not stop a document from navigating itself: the renderer must.
  setTimeout(() => { location.href = "${app}/api/nav"; }, 50);
</script></body></html>`;
}

describe.skipIf(!BROWSER)("isolated renderer (real headless shell)", () => {
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
  }, 60_000);

  it("an artifact asking for the app (127.0.0.1:<port>/api/…), private IPs, metadata or other hosts gets nothing", async () => {
    app.hits.length = 0;
    const { r, blocked, lookups, connects } = renderer();
    for (const format of ["pdf", "png"] as const) {
      const res = await r.render(job("html", attackHtml(app.port), format));
      // The render itself still finishes — it just never reached anything.
      expect(res.ok).toBe(true);
    }
    expect(app.hits).toEqual([]);
    expect(lookups).toEqual([]);
    expect(connects).toEqual([]);
    // The one request CSP cannot stop — the document navigating itself to the app — was refused by the renderer.
    expect(blocked).toContain(`http://127.0.0.1:${app.port}/api/nav`);
  }, 60_000);

  // Each network layer alone (the others off) stops the same document: no single mistake opens the way.
  describe("each layer alone", () => {
    const run = async (o: Partial<RendererOptions>) => {
      app.hits.length = 0;
      const t = renderer(o);
      await t.r.render(job("html", attackHtml(app.port), "pdf"));
      return { hits: app.hits.map((h) => h.url).sort(), ...t };
    };

    it("control: with every layer off and no sandbox, the document does reach the app (the probe works)", async () => {
      const { hits } = await run({
        launcher: unsandboxedLauncher,
        test: { csp: false, intercept: false, proxy: false },
      });
      // (Subresources are also held back by Chrome's own local-network rules; the navigation is not.)
      expect(hits).toContain("/api/nav");
    }, 30_000);

    it("CSP alone does not stop the document navigating itself to the app (why the other layers exist)", async () => {
      const { hits } = await run({ launcher: unsandboxedLauncher, test: { intercept: false, proxy: false } });
      expect(hits).toEqual(["/api/nav"]);
    }, 30_000);

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
    }, 30_000);

    it("the egress proxy alone (loopback included: Chrome may not bypass it for 127.0.0.1 or localhost)", async () => {
      const { hits, lookups, connects } = await run({
        launcher: unsandboxedLauncher,
        test: { csp: false, intercept: false },
      });
      expect(hits).toEqual([]);
      // Only the CDN host may be resolved or reached; example.org, private and loopback addresses never are.
      expect(lookups.filter((h) => !RENDER_EGRESS_HOSTS.includes(h))).toEqual([]);
      expect(connects).toEqual([]);
    }, 30_000);

    it.skipIf(!darwin)(
      "the macOS process sandbox alone (no CSP, no interception, no proxy switch)",
      async () => {
        const { hits } = await run({
          launcher: sandboxedLauncher,
          test: { csp: false, intercept: false, proxy: false },
        });
        expect(hits).toEqual([]);
      },
      30_000,
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
  }, 30_000);

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
  }, 30_000);

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
  }, 30_000);

  it("memory limit: above it the browser is killed (export_limit); unmeasurable counts as above (fail closed)", async () => {
    // An HTML document (its scripts get time to settle): the monitor samples while it renders.
    const doc = job("html", "<!doctype html><p>메모리</p>", "png");
    const small = renderer({ limits: { maxRssBytes: 20 * 1024 * 1024 } });
    expect(await small.r.render(doc)).toEqual({ ok: false, code: "export_limit" });
    const blind = renderer({ test: { probe: async () => [] } });
    expect(await blind.r.render(doc)).toEqual({ ok: false, code: "export_limit" });
    const fine = renderer();
    expect((await fine.r.render(job("chart", chart, "png"))).ok).toBe(true);
  }, 60_000);

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
  }, 60_000);
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

describe("export routes (#51)", () => {
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
