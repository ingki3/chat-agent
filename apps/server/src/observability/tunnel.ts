import http from "node:http";
import net from "node:net";
import type { TunnelState } from "@agentlee/shared";

/** Where `cloudflared`'s metrics server listens: a loopback IP literal and a port, nothing else. */
export type MetricsAddress = { host: string; port: number };

/** One decimal octet, no leading zeros (0–255). */
const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
/** `127.x.x.x` written as four decimal octets — the only IPv4 spelling accepted (no `127.1`, hex or integers). */
const LOOPBACK_V4 = new RegExp(`^127\\.${OCTET}\\.${OCTET}\\.${OCTET}$`);
/** The whole accepted value: `http://127.x.x.x:<port>` or `http://[::1]:<port>`, an optional trailing `/`. */
const METRICS_URL = new RegExp(`^http://(127\\.${OCTET}\\.${OCTET}\\.${OCTET}|\\[::1\\]):([1-9]\\d{0,4})/?$`);

/**
 * Parses `CLOUDFLARED_METRICS` (#35): `http://127.x.x.x:<port>` (four decimal octets) or `http://[::1]:<port>`, with
 * no user, path, query or fragment. The raw text is checked as written — before any URL normalisation, which would
 * turn `127.1`, `0x7f000001` or `2130706433` into `127.0.0.1` — and host *names* are refused, even `localhost`, so
 * no name lookup can turn it into another machine. Anything else is undefined (config refuses to start with it).
 */
export function parseMetricsAddress(value: string): MetricsAddress | undefined {
  const m = METRICS_URL.exec(value);
  if (!m) return undefined;
  const port = Number(m[2]);
  if (port > 65535) return undefined;
  return { host: m[1] === "[::1]" ? "::1" : m[1]!, port };
}

/** A loopback IP literal as `parseMetricsAddress` gives it: `127.x.x.x` (four decimal octets) or `::1`. */
export function isLoopbackIp(host: string): boolean {
  return host === "::1" || (net.isIPv4(host) && LOOPBACK_V4.test(host));
}

export type TunnelStatus = { state: TunnelState; readyConnections: number | null };

/** The most of `/ready` that is read; a longer answer is not cloudflared's. */
export const MAX_READY_BYTES = 4096;

/**
 * Asks `cloudflared`'s own metrics server (`GET /ready`, JSON `{ status, readyConnections }`) how many connections
 * the tunnel has to Cloudflare (FR-10.4). Loopback only: the address is checked again here, the request goes to
 * the IP literal with `node:http` (no proxy, no name lookup, redirects are not followed). The whole request has one
 * deadline from its start (a slow drip cannot hold the status page) and the body is capped. Only a JSON answer with
 * an integer `readyConnections` counts: ≥ 1 → `ok`, 0 → `down`; anything else → `unreachable`. Unset →
 * `unconfigured`.
 */
export async function tunnelStatus(
  address: MetricsAddress | undefined,
  opts: { timeoutMs?: number } = {},
): Promise<TunnelStatus> {
  if (!address) return { state: "unconfigured", readyConnections: null };
  const unreachable: TunnelStatus = { state: "unreachable", readyConnections: null };
  if (!isLoopbackIp(address.host) || !Number.isInteger(address.port)) return unreachable;
  const deadlineMs = opts.timeoutMs ?? 1500;
  const answer = await new Promise<{ status: number; body: string } | undefined>((resolve) => {
    let settled = false;
    const finish = (v: { status: number; body: string } | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(v);
    };
    const req = http.request(
      {
        host: address.host,
        port: address.port,
        path: "/ready",
        method: "GET",
        family: address.host === "::1" ? 6 : 4,
        agent: false,
        headers: { accept: "application/json" },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          body += c;
          if (body.length > MAX_READY_BYTES) {
            finish(undefined);
            req.destroy();
          }
        });
        res.on("end", () => finish({ status: res.statusCode ?? 0, body }));
        res.on("error", () => finish(undefined));
        res.on("close", () => finish(undefined));
      },
    );
    // One deadline for connect, headers and body together — not an idle timeout a trickle could keep resetting.
    const deadline = setTimeout(() => {
      finish(undefined);
      req.destroy();
    }, deadlineMs);
    req.on("error", () => finish(undefined));
    req.end();
  });
  if (!answer) return unreachable;
  let ready: number | undefined;
  try {
    const v = (JSON.parse(answer.body) as { readyConnections?: unknown } | null)?.readyConnections;
    if (typeof v === "number" && Number.isInteger(v) && v >= 0) ready = v;
  } catch {
    // not cloudflared's JSON
  }
  if (ready === undefined || (answer.status !== 200 && answer.status !== 503)) return unreachable;
  if (answer.status === 200 && ready >= 1) return { state: "ok", readyConnections: ready };
  return { state: "down", readyConnections: ready };
}
