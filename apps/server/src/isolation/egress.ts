import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { isBlockedAddress } from "./net.js";

/**
 * Egress proxy for sandboxed runtime CLIs (#15, review #80). The sandbox lets a CLI reach only loopback ports;
 * this proxy (HTTPS_PROXY) is one of them. It accepts CONNECT to allow-listed host names on port 443 only,
 * resolves the name itself and refuses loopback, private, link-local and metadata addresses — so the CLI
 * reaches its provider's API and nothing else (not this machine, not the home network). It sees only the TLS
 * stream, never the content.
 */
export type EgressOptions = {
  /**
   * Exact host names allowed (lower case), or `"public"`: any public name or address (web fetch, #50). In both
   * cases the name is resolved here and every answer must be a public address — the policy is on the address.
   */
  allow: readonly string[] | "public";
  /** Ports a tunnel may go to (default 443 only; web fetch also opens 80 for plain http). */
  ports?: readonly number[];
  /** Tests: name resolution and the upstream connection. */
  lookup?: (host: string) => Promise<string[]>;
  connect?: (ip: string, port: number) => net.Socket;
  connectTimeoutMs?: number;
  /** Open tunnels at most (any local process can reach the port: bound its cost). */
  maxTunnels?: number;
  /** A tunnel with no traffic either way for this long is closed. */
  idleMs?: number;
};

export type RunningEgress = { readonly port: number; readonly url: string; close(): Promise<void> };

const defaultLookup = async (host: string) =>
  (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * Names that are never public, whatever they resolve to (defence in depth — the address check decides anyway):
 * `localhost` and its subdomains, mDNS `.local`, `.internal` (cloud metadata), `.home.arpa`, `.lan`, single-label
 * intranet names.
 */
export function isPrivateName(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (!h.includes(".")) return true;
  return /(^|\.)(localhost|local|internal|home\.arpa|lan|intranet|corp)$/.test(h);
}

/**
 * The CONNECT target `host:port` as (host, port), or undefined when malformed. Names are LDH labels; addresses are
 * a canonical dotted IPv4 or a bracketed IPv6. A name whose last label is numeric or hex (`2130706433`,
 * `0x7f.1`, `0177.0.0.1`) is an address in another spelling: refused unless it is canonical dotted IPv4.
 */
export function parseTarget(target: string): { host: string; port: number } | undefined {
  const m = /^(\[[0-9a-f:.]+\]|[a-z0-9.-]+):(\d{1,5})$/i.exec(target);
  if (!m) return undefined;
  const port = Number(m[2]);
  let host = m[1]!.toLowerCase();
  if (host.startsWith("[")) {
    host = host.slice(1, -1);
    return net.isIPv6(host) ? { host, port } : undefined;
  }
  const last = host.replace(/\.$/, "").split(".").pop() ?? "";
  if (/^(\d+|0x[0-9a-f]*)$/i.test(last) && !net.isIPv4(host)) return undefined;
  if (host.split(".").some((l) => l.length > 63) || host.length > 253) return undefined;
  return { host, port };
}

/** How long a closed upstream's last bytes may take to reach the client before the tunnel is cut. */
const FLUSH_MS = 30_000;

export async function startEgressProxy(o: EgressOptions, port = 0): Promise<RunningEgress> {
  const allow = o.allow === "public" ? undefined : new Set(o.allow.map((h) => h.toLowerCase()));
  const ports = new Set(o.ports ?? [443]);
  const lookup = o.lookup ?? defaultLookup;
  const connect = o.connect ?? ((ip: string, p: number) => net.connect({ host: ip, port: p }));
  const sockets = new Set<net.Socket>();
  let closed = false;
  let tunnels = 0;
  const maxTunnels = o.maxTunnels ?? 64;
  const idleMs = o.idleMs ?? 5 * 60_000;
  const server = http.createServer((_req, res) => {
    // Plain HTTP proxying is never offered.
    res.writeHead(405, { "content-type": "text/plain" }).end("CONNECT only");
  });
  server.on("connect", (req: http.IncomingMessage, client: net.Socket, head: Buffer) => {
    sockets.add(client);
    // Counted from the CONNECT on, so pending lookups count too.
    tunnels++;
    let counted = true;
    const release = () => {
      if (counted) tunnels--;
      counted = false;
    };
    client.on("close", () => {
      sockets.delete(client);
      release();
    });
    client.on("error", () => client.destroy());
    // The peer hanging up shows as the end of its stream first (the socket can stay half-open).
    let gone = false;
    client.on("end", () => {
      gone = true;
      client.destroy();
    });
    client.setTimeout(idleMs, () => client.destroy());
    // A refused socket is closed for good once the answer is out — `end()` alone leaves the read side open
    // (HTTP sockets are half-open), so a client that never hangs up would keep it (review #80).
    const hangUp = (line: string) => {
      client.end(line, () => client.destroy());
      setTimeout(() => client.destroy(), 1000).unref();
    };
    const refuse = (code: number) =>
      hangUp(`HTTP/1.1 ${code} ${code === 403 ? "Forbidden" : "Bad Gateway"}\r\n\r\n`);
    if (closed) return void client.destroy();
    if (tunnels > maxTunnels) {
      hangUp("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      return;
    }
    const t = parseTarget(req.url ?? "");
    if (!t || !ports.has(t.port)) return refuse(403);
    const host = t.host;
    if (allow ? !allow.has(host) : !net.isIP(host) && isPrivateName(host)) return refuse(403);
    void (async () => {
      let ips: string[];
      try {
        // An address literal is its own answer (public mode only — an allow-list names hosts).
        ips = net.isIP(host) ? [host] : await lookup(host);
      } catch {
        return refuse(502);
      }
      // The client may have gone, or the proxy closed, while the name was being resolved: open nothing then.
      if (closed || gone || client.destroyed) return void client.destroy();
      // Any blocked answer refuses the whole name (DNS rebinding to the home network or this machine).
      if (!ips.length || ips.some((ip) => isBlockedAddress(ip))) return refuse(403);
      // The checked address itself is what we connect to — never the name again (no second resolution).
      const upstream = connect(ips[0]!, t.port);
      upstream.setTimeout(idleMs, () => upstream.destroy());
      sockets.add(upstream);
      const timer = setTimeout(() => upstream.destroy(), o.connectTimeoutMs ?? 10_000);
      upstream.on("close", (hadError) => {
        sockets.delete(upstream);
        // A clean close comes after the upstream's end, which the pipe passes on as the client's end — but bytes
        // may still be queued for a slow client. Destroying now would drop them (a response cut short), so wait
        // until they are flushed; an upstream error, or a client that never drains, ends it at once / in time.
        if (hadError || client.destroyed || client.writableFinished) return void client.destroy();
        client.end();
        const flushTimer = setTimeout(() => client.destroy(), FLUSH_MS);
        flushTimer.unref();
        client.once("finish", () => client.destroy());
        client.once("close", () => clearTimeout(flushTimer));
      });
      upstream.on("error", () => {
        clearTimeout(timer);
        if (!client.destroyed) refuse(502);
      });
      upstream.on("connect", () => {
        clearTimeout(timer);
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      client.on("close", () => upstream.destroy());
      if (client.destroyed) upstream.destroy();
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  const bound = (server.address() as AddressInfo).port;
  return {
    port: bound,
    url: `http://127.0.0.1:${bound}`,
    close: () =>
      new Promise<void>((resolve) => {
        closed = true;
        for (const s of sockets) s.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** Starts on first use, shared by all runs (like the MCP service). */
export class EgressService {
  private running: Promise<RunningEgress> | undefined;
  private closed = false;
  constructor(private readonly opts: EgressOptions) {}
  endpoint(): Promise<RunningEgress> {
    if (this.closed) return Promise.reject(new Error("egress closed"));
    this.running ??= startEgressProxy(this.opts).catch((e: unknown) => {
      this.running = undefined;
      throw e;
    });
    return this.running;
  }
  async close(): Promise<void> {
    this.closed = true;
    const r = await this.running?.catch(() => undefined);
    this.running = undefined;
    await r?.close();
  }
}

/** Hosts Claude Code needs with nonessential traffic off: the API (API keys and subscription tokens alike). */
export const CLAUDE_EGRESS_HOSTS = ["api.anthropic.com"] as const;

/**
 * Hosts codex app-server needs with an API key (0.165.0, our config: no model-list fetch, no analytics or update
 * checks): the Responses API, over HTTPS and WebSocket.
 */
export const CODEX_EGRESS_HOSTS = ["api.openai.com"] as const;

/**
 * Hosts a ChatGPT-login session needs (#18, checked on 0.165.0 through this proxy with `chatgptAuthTokens`):
 * `chatgpt.com` only — the ChatGPT backend (`/backend-api/codex/responses`, its model list and workspace routing).
 * No `api.openai.com`, and no `auth.openai.com`: the server refreshes tokens itself (connections/chatgpt.ts).
 */
export const CODEX_CHATGPT_EGRESS_HOSTS = ["chatgpt.com"] as const;

/**
 * Hosts the device-code login process needs (#18, codex-login.ts): `auth.openai.com` (device code, polling, token
 * exchange — checked on 0.165.0: the code request goes there and nowhere else) and `chatgpt.com` (the account
 * read after the login).
 */
export const CODEX_LOGIN_EGRESS_HOSTS = ["auth.openai.com", "chatgpt.com"] as const;
