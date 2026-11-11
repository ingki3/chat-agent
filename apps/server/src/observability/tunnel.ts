import http from "node:http";
import net from "node:net";
import type { TunnelState } from "@agentlee/shared";

/** Where `cloudflared`'s metrics server listens: a loopback IP literal and a port, nothing else. */
export type MetricsAddress = { host: string; port: number };

/**
 * Parses `CLOUDFLARED_METRICS` (#35): `http://127.0.0.1:<port>` (any 127.0.0.0/8 address) or `http://[::1]:<port>`,
 * with no user, path, query or fragment. Host *names* are refused — even `localhost` — so no name lookup can turn
 * it into another machine. Anything else is undefined (config refuses to start with it).
 */
export function parseMetricsAddress(value: string): MetricsAddress | undefined {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" || u.username || u.password || u.search || u.hash) return undefined;
  if (u.pathname !== "/" && u.pathname !== "") return undefined;
  if (!u.port) return undefined;
  const host = u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname;
  if (!isLoopbackIp(host)) return undefined;
  const port = Number(u.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host, port };
}

/** A loopback IP literal: 127.0.0.0/8 or ::1. */
export function isLoopbackIp(host: string): boolean {
  if (net.isIPv4(host)) return host.split(".")[0] === "127";
  if (net.isIPv6(host)) return host === "::1" || host === "0:0:0:0:0:0:0:1";
  return false;
}

export type TunnelStatus = { state: TunnelState; readyConnections: number | null };

/**
 * Asks `cloudflared`'s own metrics server (`GET /ready`, JSON `{ status, readyConnections }`) how many connections
 * the tunnel has to Cloudflare (FR-10.4). Loopback only: the address is checked again here, the request goes to
 * the IP literal with `node:http` (no proxy, no name lookup, redirects are not followed), and only the
 * connection count is read from the answer. Unset → `unconfigured`.
 */
export async function tunnelStatus(
  address: MetricsAddress | undefined,
  opts: { timeoutMs?: number } = {},
): Promise<TunnelStatus> {
  if (!address) return { state: "unconfigured", readyConnections: null };
  if (!isLoopbackIp(address.host) || !Number.isInteger(address.port))
    return { state: "unreachable", readyConnections: null };
  const answer = await new Promise<{ status: number; body: string } | undefined>((resolve) => {
    const req = http.request(
      {
        host: address.host,
        port: address.port,
        path: "/ready",
        method: "GET",
        family: net.isIPv6(address.host) ? 6 : 4,
        timeout: opts.timeoutMs ?? 1500,
        agent: false,
        headers: { accept: "application/json" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          body += c;
          if (body.length > 4096) req.destroy();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", () => resolve(undefined));
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(undefined));
    req.end();
  });
  if (!answer) return { state: "unreachable", readyConnections: null };
  let ready: number | null = null;
  try {
    const v = (JSON.parse(answer.body) as { readyConnections?: unknown }).readyConnections;
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) ready = v;
  } catch {
    // not cloudflared's JSON: the status code alone decides
  }
  if (answer.status === 200 && (ready === null || ready > 0)) return { state: "ok", readyConnections: ready };
  if (answer.status === 200 || answer.status === 503) return { state: "down", readyConnections: ready ?? 0 };
  return { state: "unreachable", readyConnections: null };
}
