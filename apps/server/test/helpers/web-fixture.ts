import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import type { AddressInfo } from "node:net";
import { startEgressProxy, type RunningEgress } from "../../src/isolation/egress.js";
import type { WebWorker } from "../../src/web/service.js";
// The worker itself (plain JS), run in-process here; the macOS test runs it in the sandbox.
import { run as runWorker } from "../../../../packages/mcp-tools/web/worker.mjs";

/**
 * A pretend internet for the web tools (#50). One loopback HTTP server plays every public site; the real web
 * egress proxy (public mode, ports 80/443) sits in front, with name resolution and the upstream connection
 * stubbed:
 * - `public.test`, `news.test` → 93.184.216.34 (a public address) → the fixture server
 * - `rebind.test` → public on the first lookup, 127.0.0.1 afterwards (DNS rebinding)
 * - `mixed.test` → a public and a private address in one answer
 * - `private.test` → 192.168.1.10
 * The upstream connector only ever connects for the public address; any other address it is asked for is
 * recorded in `leaks` (the test fails if it is not empty) and goes nowhere.
 */
export const PUBLIC_IP = "93.184.216.34";
/** A public address whose server accepts TCP and then says nothing (a stalled TLS handshake). */
export const STALL_IP = "93.184.216.35";
const tlsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/tls");
/** Self-signed, test-only certificate for `public.test` and IP 93.184.216.34 (it is its own root). */
export const TEST_CA = fs.readFileSync(path.join(tlsDir, "test-only.crt"), "utf8");
const TEST_KEY = fs.readFileSync(path.join(tlsDir, "test-only.key"), "utf8");

export const ARTICLE = `<!doctype html><html><head><meta charset="utf-8">
<title>문서 제목 | 예시 신문</title>
<meta property="og:title" content="한국 반도체 수출 &quot;사상 최대&quot;">
<meta property="og:site_name" content="예시 신문">
<meta property="article:published_time" content="2026-11-10T09:30:00+09:00">
<style>.x{color:red}</style><script>window.secret = "SCRIPT_TEXT_MUST_NOT_APPEAR";</script>
</head><body>
<nav>메뉴 홈 정치 경제 NAV_TEXT</nav>
<article><h1>한국 반도체 수출 사상 최대</h1>
<p>11월 반도체 수출이 전년 대비 32% 늘어 사상 최대를 기록했다.</p>
<p>산업통상자원부는 10일 이같이 밝혔다 &amp; 덧붙였다&#46;</p>
<!-- COMMENT_TEXT -->
</article>
<footer>FOOTER_TEXT 저작권</footer></body></html>`;

export type FixtureRoute = { status?: number; headers?: Record<string, string | string[]>; body?: string };

export type WebFixture = {
  proxy: RunningEgress;
  worker: WebWorker;
  /** Addresses the proxy was asked to connect to that are not the public fixture address. */
  leaks: string[];
  /** Every address:port the proxy connected to. */
  connects: string[];
  /** The worker with the test root trusted (HTTPS to the fixture). */
  tlsWorker: WebWorker;
  /** Request headers the fixture saw, by path. */
  seen: Map<string, http.IncomingHttpHeaders>;
  /** Redirects a test sets: path → Location (a target only the site knows — #113). */
  redirects: Map<string, string>;
  /** Answers a test sets: path → status, headers (e.g. Set-Cookie), body. */
  routes: Map<string, FixtureRoute>;
  lookups: Map<string, number>;
  close(): Promise<void>;
};

export async function startWebFixture(): Promise<WebFixture> {
  const seen = new Map<string, http.IncomingHttpHeaders>();
  const redirects = new Map<string, string>();
  const routes = new Map<string, FixtureRoute>();
  const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://fixture");
    seen.set(url.pathname, req.headers);
    const redirect = (to: string, code = 302) => res.writeHead(code, { location: to }).end();
    const set = redirects.get(url.pathname);
    if (set !== undefined) return redirect(set);
    const route = routes.get(url.pathname);
    if (route)
      return res
        .writeHead(route.status ?? 200, { "content-type": "application/json", ...route.headers })
        .end(route.body ?? "{}");
    switch (url.pathname) {
      case "/article.html":
        return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(ARTICLE);
      case "/euckr.html": {
        const body = Buffer.from(
          // "<title>한글</title><p>안녕하세요</p>" in EUC-KR
          "3c7469746c653ec7d1b1db3c2f7469746c653e3c703ebec8b3e7c7cfbcbcbfe43c2f703e",
          "hex",
        );
        return res.writeHead(200, { "content-type": "text/html; charset=euc-kr" }).end(body);
      }
      case "/plain.txt":
        return res.writeHead(200, { "content-type": "text/plain" }).end("그냥 글자\n두 번째 줄");
      case "/data.json":
        return res.writeHead(200, { "content-type": "application/json" }).end('{"a":1,"b":["x"]}');
      case "/doc.pdf":
        return res.writeHead(200, { "content-type": "application/pdf" }).end("%PDF-1.7 ...");
      case "/empty.html":
        return res
          .writeHead(200, { "content-type": "text/html" })
          .end("<html><body><script>x</script></body></html>");
      case "/missing":
        return res.writeHead(404, { "content-type": "text/html" }).end("<p>없음</p>");
      case "/big":
        // Declared too large.
        return res
          .writeHead(200, { "content-type": "text/plain", "content-length": String(50 * 1024 * 1024) })
          .end("x");
      case "/big-chunked": {
        res.writeHead(200, { "content-type": "text/plain" });
        const chunk = Buffer.alloc(256 * 1024, 97);
        let sent = 0;
        const pump = () => {
          while (sent < 8 * 1024 * 1024) {
            sent += chunk.length;
            if (!res.write(chunk)) return void res.once("drain", pump);
          }
          res.end();
        };
        res.on("error", () => {});
        return pump();
      }
      case "/bomb": {
        // 64 MB of zeros in a small gzip.
        const z = zlib.gzipSync(Buffer.alloc(64 * 1024 * 1024));
        return res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" }).end(z);
      }
      case "/fat-header.gz": {
        // A gzip whose FNAME header field is 3 MB + 64 bytes and whose content is "ok": the wire limit must hold
        // although the decompressed body is tiny. Sent chunked (no Content-Length).
        const content = Buffer.from("ok");
        const head = Buffer.from([0x1f, 0x8b, 8, 8, 0, 0, 0, 0, 0, 255]);
        const name = Buffer.concat([Buffer.alloc(3 * 1024 * 1024 + 64, 97), Buffer.from([0])]);
        const tail = Buffer.alloc(8);
        tail.writeUInt32LE(zlib.crc32(content), 0);
        tail.writeUInt32LE(content.length, 4);
        const gz = Buffer.concat([head, name, zlib.deflateRawSync(content), tail]);
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        res.on("error", () => {});
        for (let i = 0; i < gz.length; i += 64 * 1024) res.write(gz.subarray(i, i + 64 * 1024));
        return res.end();
      }
      case "/small-header.gz": {
        // The same shape within the limit decompresses fine (the format is right).
        const content = Buffer.from("ok");
        const head = Buffer.from([0x1f, 0x8b, 8, 8, 0, 0, 0, 0, 0, 255]);
        const tail = Buffer.alloc(8);
        tail.writeUInt32LE(zlib.crc32(content), 0);
        tail.writeUInt32LE(content.length, 4);
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        return res.end(Buffer.concat([head, Buffer.from("name\0"), zlib.deflateRawSync(content), tail]));
      }
      case "/close-after.txt":
        // 2.5 MB in one write, then the server closes: the proxy must deliver every byte before hanging up.
        res.writeHead(200, { "content-type": "text/plain", connection: "close" });
        return res.end(Buffer.alloc(2_500_000, 98));
      case "/gzip.html":
        return res
          .writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" })
          .end(zlib.gzipSync(Buffer.from(ARTICLE)));
      case "/slow":
        return void setTimeout(() => res.writeHead(200, { "content-type": "text/plain" }).end("늦음"), 3000);
      case "/loop":
        return redirect("/loop");
      case "/to-article":
        return redirect("http://news.test/article.html", 301);
      case "/to-private":
        return redirect("http://private.test/secret");
      case "/to-private-ip":
        return redirect("http://10.0.0.5/admin");
      case "/to-loopback":
        return redirect("http://127.0.0.1:3000/api/conversations");
      case "/to-loopback-80":
        return redirect("http://127.0.0.1/api/conversations");
      case "/to-metadata":
        return redirect("http://169.254.169.254/latest/meta-data/");
      case "/to-localhost":
        return redirect("http://localhost/");
      case "/to-decimal":
        return redirect("http://2130706433/");
      case "/to-v6":
        return redirect("http://[::1]/");
      case "/to-mapped":
        return redirect("http://[::ffff:127.0.0.1]/");
      case "/to-file":
        return redirect("file:///etc/passwd");
      case "/to-rebind":
        // Same name again: the second lookup answers 127.0.0.1.
        return redirect("http://rebind.test/article.html");
      default:
        return res.writeHead(404).end();
    }
  };
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const secure = https.createServer({ key: TEST_KEY, cert: TEST_CA }, handler);
  await new Promise<void>((r) => secure.listen(0, "127.0.0.1", () => r()));
  const tlsPort = (secure.address() as AddressInfo).port;
  const stalled = new Set<net.Socket>();
  const stall = net.createServer((s) => {
    stalled.add(s);
    s.on("error", () => {});
    s.on("close", () => stalled.delete(s));
  });
  await new Promise<void>((r) => stall.listen(0, "127.0.0.1", () => r()));
  const stallPort = (stall.address() as AddressInfo).port;

  const lookups = new Map<string, number>();
  const leaks: string[] = [];
  const connects: string[] = [];
  const proxy = await startEgressProxy({
    allow: "public",
    ports: [80, 443],
    lookup: async (host) => {
      const n = (lookups.get(host) ?? 0) + 1;
      lookups.set(host, n);
      switch (host) {
        case "public.test":
        case "news.test":
          return [PUBLIC_IP];
        case "rebind.test":
          return n === 1 ? [PUBLIC_IP] : ["127.0.0.1"];
        case "mixed.test":
          return [PUBLIC_IP, "10.1.2.3"];
        case "private.test":
          return ["192.168.1.10"];
        case "stall.test":
          return [STALL_IP];
        // Mixed answers with non-global IPv6 (#50 review): any blocked answer refuses the name.
        case "mixed6.test":
          return [PUBLIC_IP, "fec0::1"];
        case "nat64local.test":
          return ["64:ff9b:1::a00:1"];
        case "teredo.test":
          return ["2001::5efe:a00:1", PUBLIC_IP];
        default:
          throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      }
    },
    connect: (ip, p) => {
      connects.push(`${ip}:${p}`);
      if (ip === PUBLIC_IP) return net.connect(p === 443 ? tlsPort : port, "127.0.0.1");
      if (ip === STALL_IP) return net.connect(stallPort, "127.0.0.1");
      leaks.push(`${ip}:${p}`);
      // Nowhere: a socket that fails at once.
      return net.connect(1, "127.0.0.1");
    },
  });
  const worker: WebWorker = (job, p) => runWorker(job, { proxy: p.url });
  const tlsWorker: WebWorker = (job, p) => runWorker(job, { proxy: p.url, ca: TEST_CA });
  return {
    proxy,
    worker,
    tlsWorker,
    leaks,
    connects,
    seen,
    redirects,
    routes,
    lookups,
    close: async () => {
      await proxy.close();
      server.closeAllConnections();
      secure.closeAllConnections();
      for (const s of stalled) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      await new Promise<void>((r) => secure.close(() => r()));
      await new Promise<void>((r) => stall.close(() => r()));
    },
  };
}
