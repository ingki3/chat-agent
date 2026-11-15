import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

/**
 * Outbound HTTP for web fetch and renderers (#42, used by #50/#51): http/https only, and never to loopback,
 * private, link-local (incl. cloud metadata 169.254.169.254), CGNAT, multicast or reserved addresses. The check
 * happens on the address actually connected to (custom DNS lookup), so DNS rebinding cannot slip through, and
 * again on every redirect hop.
 */

const V4_BLOCKED: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const v4num = (ip: string) => ip.split(".").reduce((a, o) => (a << 8) + Number(o), 0) >>> 0;
function inV4(ip: string, [base, bits]: [string, number]): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (v4num(ip) & mask) === (v4num(base) & mask);
}

/** Expands an IPv6 address to 8 numbers (handles `::` and an embedded IPv4 tail). */
function v6parts(ip: string): number[] | undefined {
  let s = ip.toLowerCase().split("%")[0]!;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const n = v4num(v4[1]!);
    s = s.slice(0, -v4[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  const fill = s.includes("::") ? 8 - h.length - t.length : 0;
  const all = [...h, ...Array(fill).fill("0"), ...t].map((x) => parseInt(x, 16));
  return all.length === 8 && all.every((x) => x >= 0 && x <= 0xffff) ? all : undefined;
}

/** True when an address must never be contacted from the server. Unparseable input counts as blocked. */
export function isBlockedAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return V4_BLOCKED.some((r) => inV4(ip, r)) || ip === "255.255.255.255";
  if (kind !== 6) return true;
  const p = v6parts(ip);
  if (!p) return true;
  const v4tail = () => `${p[6]! >> 8}.${p[6]! & 255}.${p[7]! >> 8}.${p[7]! & 255}`;
  // Two translation forms carry an IPv4 address that decides: IPv4-mapped (::ffff:0:0/96) and the NAT64
  // well-known prefix (64:ff9b::/96 exactly — RFC 6052). Everything else is judged on the IPv6 address alone.
  if (inV6(p, V6_MAPPED, 96) || inV6(p, V6_NAT64_WKP, 96)) return isBlockedAddress(v4tail());
  // Allow-list: only global unicast (2000::/3, RFC 4291) may be reached — this refuses ::, ::1, the deprecated
  // IPv4-compatible form, 100::/64 discard, 64:ff9b:1::/48 local-use NAT64 (RFC 8215), fc00::/7 unique local,
  // fec0::/10 site local, fe80::/10 link local and ff00::/8 multicast, and anything not yet assigned.
  if (!inV6(p, [0x2000], 3)) return true;
  // ...minus the special-purpose ranges inside it (IANA IPv6 special-purpose address registry).
  return V6_SPECIAL.some(([prefix, bits]) => inV6(p, prefix, bits));
}

const V6_MAPPED = [0, 0, 0, 0, 0, 0xffff];
const V6_NAT64_WKP = [0x64, 0xff9b, 0, 0, 0, 0];
/** Non-global ranges inside 2000::/3, refused whatever they map to. */
const V6_SPECIAL: [number[], number][] = [
  [[0x2001, 0], 23], // IETF protocol assignments: Teredo 2001::/32, benchmarking, ORCHID, AMT, AS112, …
  [[0x2001, 0xdb8], 32], // documentation
  [[0x2002], 16], // 6to4 (deprecated; its embedded IPv4 is not checked — refused outright)
  [[0x3fff, 0], 20], // documentation (RFC 9637)
  [[0x5f00], 16], // SRv6 SIDs (RFC 9602)
];

/** True when the first `bits` bits of the address `p` (8 groups) equal those of `prefix` (missing groups = 0). */
function inV6(p: number[], prefix: number[], bits: number): boolean {
  for (let i = 0; i < 8 && bits > 0; i++, bits -= 16) {
    const take = Math.min(16, bits);
    const mask = (0xffff << (16 - take)) & 0xffff;
    if ((p[i]! & mask) !== ((prefix[i] ?? 0) & mask)) return false;
  }
  return true;
}

export class BlockedRequestError extends Error {
  constructor(readonly reason: string) {
    super(`request blocked: ${reason}`);
  }
}

export type SafeResponse = { url: string; status: number; headers: http.IncomingHttpHeaders; body: Buffer };

export type SafeFetchOptions = {
  maxRedirects?: number;
  timeoutMs?: number;
  maxBytes?: number;
  headers?: Record<string, string>;
  /** POST with this body (no redirects are followed for a POST). Default: GET. */
  body?: string;
  /** Tests only: resolve names here instead of DNS. */
  resolve?: (host: string) => Promise<string[]>;
  /** Tests only: address policy override (default: not `isBlockedAddress`). */
  allow?: (address: string, host: string) => boolean;
};

function checkUrl(u: URL): void {
  if (u.protocol !== "http:" && u.protocol !== "https:")
    throw new BlockedRequestError(`scheme ${u.protocol}`);
  if (u.username || u.password) throw new BlockedRequestError("credentials in URL");
}

/**
 * GET (or POST with `body`) with the address policy applied to every hop. Redirects are followed manually and
 * re-checked (GET only).
 */
export async function safeFetch(input: string, o: SafeFetchOptions = {}): Promise<SafeResponse> {
  let url = new URL(input);
  for (let hop = 0; hop <= (o.maxRedirects ?? 5); hop++) {
    checkUrl(url);
    const res = await request(url, o);
    const loc = res.headers.location;
    if (o.body === undefined && res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url);
      continue;
    }
    return res;
  }
  throw new BlockedRequestError("too many redirects");
}

/**
 * Our own agents: never the global ones, which newer Node versions may route through HTTP(S)_PROXY
 * (NODE_USE_ENV_PROXY) — a proxy would resolve the name itself and the address policy would never see it.
 */
const httpAgent = new http.Agent({ keepAlive: false });
const httpsAgent = new https.Agent({ keepAlive: false });

function request(url: URL, o: SafeFetchOptions): Promise<SafeResponse> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // The lookup the socket actually uses: every resolved address must be allowed, and that address is used.
  const allowed = (a: string) => (o.allow ? o.allow(a, host) : !isBlockedAddress(a));
  const lookup: net.LookupFunction = (hostname, options, cb) => {
    const done = (addrs: string[]) => {
      const bad = addrs.find((a) => !allowed(a));
      if (!addrs.length || bad) return cb(new BlockedRequestError(`address ${bad ?? "none"}`), "", 4);
      const all = (options as dns.LookupOptions).all;
      const list = addrs.map((a) => ({ address: a, family: net.isIP(a) }));
      if (all) (cb as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
      else cb(null, list[0]!.address, list[0]!.family);
    };
    if (net.isIP(hostname)) return done([hostname]);
    const resolve = o.resolve
      ? o.resolve(hostname)
      : dns.promises.lookup(hostname, { all: true }).then((r) => r.map((x) => x.address));
    resolve.then(done, (e: Error) => cb(e as NodeJS.ErrnoException, "", 4));
  };
  if (net.isIP(host) && !allowed(host)) return Promise.reject(new BlockedRequestError(`address ${host}`));
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      url,
      {
        method: o.body === undefined ? "GET" : "POST",
        lookup,
        agent: url.protocol === "https:" ? httpsAgent : httpAgent,
        headers: { "user-agent": "AgentLee/1.0", ...o.headers },
        timeout: o.timeoutMs ?? 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > (o.maxBytes ?? 10 * 1024 * 1024)) {
            req.destroy(new BlockedRequestError("response too large"));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () =>
          resolve({
            url: url.toString(),
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new BlockedRequestError("timeout")));
    req.on("error", reject);
    req.end(o.body);
  });
}
