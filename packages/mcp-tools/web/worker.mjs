// Web worker (#50): fetches one web page — or one search-results page — and turns it into readable text. It runs
// in the sandbox (#42): no files but its own folder, no child processes, no environment but what the server
// gives, and no network except one loopback port, the server's egress proxy. Every hop (the first request and
// each redirect) is a new CONNECT through that proxy, which resolves the name itself and refuses loopback,
// private, link-local and metadata addresses — so neither a redirect nor DNS rebinding reaches this machine or
// the home network. Nothing of the server's (cookies, keys) exists here to be sent.
//
// stdin: one JSON job. stdout: one JSON result, `{ ok: true, ... }` or `{ ok: false, code }` (fixed codes).
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import zlib from "node:zlib";

export const LIMITS = {
  /** Body bytes, before and after decompression. */
  maxBytes: 3 * 1024 * 1024,
  /** Characters of extracted text kept. */
  maxChars: 400_000,
  maxRedirects: 5,
  /** The whole job, every hop included. */
  totalMs: 20_000,
};

/** Content types we read. PDF and the rest are refused (`web_unsupported_type`). */
const TYPES = new Map([
  ["text/html", "html"],
  ["application/xhtml+xml", "html"],
  ["text/plain", "text"],
  ["text/markdown", "text"],
  ["application/json", "json"],
]);

/** Fixed refusal codes (the server maps them; the model sees them). */
export class WebError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const HEADERS = {
  "user-agent": "Mozilla/5.0 (compatible; AgentLee/1.0; family assistant)",
  accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.1",
  "accept-language": "ko-KR,ko;q=0.9,en;q=0.8",
  "accept-encoding": "gzip, deflate, br",
};

/**
 * Checks one hop's URL. Ports other than 80/443 are refused (the proxy opens no others).
 * @param {URL} u
 */
export function checkHop(u) {
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new WebError("web_bad_url");
  if (u.username || u.password) throw new WebError("web_bad_url");
  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  if (port !== 80 && port !== 443) throw new WebError("web_bad_url");
  if (!u.hostname) throw new WebError("web_bad_url");
  return port;
}

/**
 * A raw TCP stream to host:port through the proxy (CONNECT). The proxy's answer decides: 200 tunnel, 403 refused
 * by policy, anything else unreachable.
 * @param {URL} proxy @param {string} host @param {number} port @param {number} timeoutMs
 * @returns {Promise<import("node:net").Socket>}
 */
function tunnel(proxy, host, port, timeoutMs) {
  const target = `${host.includes(":") ? `[${host}]` : host}:${port}`;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port),
      method: "CONNECT",
      path: target,
      headers: { host: target },
      agent: false,
      timeout: timeoutMs,
    });
    req.on("connect", (res, socket) => {
      socket.setTimeout(0);
      if (res.statusCode === 200) return resolve(socket);
      socket.destroy();
      reject(new WebError(res.statusCode === 403 ? "web_blocked" : "web_unreachable"));
    });
    req.on("timeout", () => req.destroy(new WebError("web_timeout")));
    req.on("error", (e) => reject(e instanceof WebError ? e : new WebError("web_unreachable")));
    req.end();
  });
}

/**
 * One GET through a fresh tunnel. Resolves with status, headers and the (bounded, decompressed) body.
 * @param {URL} url @param {{ proxy: URL, deadline: number, maxBytes: number, headers?: Record<string,string> }} o
 */
async function hop(url, o) {
  const port = checkHop(url);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const left = () => Math.max(1, o.deadline - Date.now());
  const raw = await tunnel(o.proxy, host, port, left());
  /** @type {import("node:net").Socket} */
  let sock = raw;
  if (url.protocol === "https:") {
    sock = await new Promise((resolve, reject) => {
      const t = tls.connect({
        socket: raw,
        // The certificate is checked against the target (name or address) — not the tunnel's peer, the proxy.
        host,
        // SNI only for names (an IP literal is not a valid server name).
        ...(net.isIP(host) ? {} : { servername: host }),
        ALPNProtocols: ["http/1.1"],
        ...(o.ca ? { ca: o.ca } : {}),
      });
      let settled = false;
      const end = (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (e) {
          t.destroy();
          raw.destroy();
          reject(e);
        } else resolve(t);
      };
      // The handshake is part of the job's time too: a peer that stalls it ends the job at the deadline.
      const timer = setTimeout(() => end(new WebError("web_timeout")), left());
      t.once("secureConnect", () => end());
      t.once("error", () => end(new WebError("web_tls")));
      t.once("close", () => end(new WebError("web_tls")));
    });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      req.destroy(new WebError("web_timeout"));
    }, left());
    /** @type {import("node:stream").Readable | undefined} */
    let stream;
    let done = false;
    /**
     * A limit that was hit. Recorded before anything is destroyed: destroying the request or socket (or the peer
     * resetting it meanwhile) emits errors of its own, and the reason must not become `web_unreachable`.
     */
    let limit;
    const fail = (e) => {
      if (done) return;
      done = true;
      if (limit) e = limit;
      clearTimeout(timer);
      // Both ends: the response (raw bytes) and the decompressor, so neither keeps reading.
      stream?.destroy();
      req.destroy();
      sock.destroy();
      reject(e instanceof WebError ? e : new WebError("web_unreachable"));
    };
    const req = http.request(
      {
        method: "GET",
        host,
        port,
        path: `${url.pathname}${url.search}`,
        headers: { ...HEADERS, ...o.headers, host: url.host },
        createConnection: () => sock,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          clearTimeout(timer);
          res.resume();
          sock.destroy();
          return resolve({ status, headers: res.headers, body: Buffer.alloc(0) });
        }
        const len = Number(res.headers["content-length"]);
        if (Number.isFinite(len) && len > o.maxBytes) return fail(new WebError("web_too_large"));
        const enc = String(res.headers["content-encoding"] ?? "identity").toLowerCase();
        // Bytes on the wire are counted on their own: the limit holds before decompression as well (a gzip
        // header can carry megabytes that decompress to nothing).
        let wire = 0;
        res.on("data", (c) => {
          wire += c.length;
          if (wire > o.maxBytes) {
            limit ??= new WebError("web_too_large");
            fail(limit);
          }
        });
        stream = res;
        // Decompressed size is bounded as well (a small gzip can expand to gigabytes).
        const zopts = { maxOutputLength: o.maxBytes + 1 };
        if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip(zopts));
        else if (enc === "deflate") stream = res.pipe(zlib.createInflate(zopts));
        else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress(zopts));
        else if (enc !== "identity") return fail(new WebError("web_unsupported_type"));
        const chunks = [];
        let size = 0;
        stream.on("data", (c) => {
          size += c.length;
          if (size > o.maxBytes) {
            limit ??= new WebError("web_too_large");
            return fail(limit);
          }
          chunks.push(c);
        });
        stream.on("end", () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          sock.destroy();
          resolve({ status, headers: res.headers, body: Buffer.concat(chunks) });
        });
        stream.on("error", (e) =>
          fail(e && e.code === "ERR_BUFFER_TOO_LARGE" ? new WebError("web_too_large") : e),
        );
        res.on("error", fail);
      },
    );
    req.on("error", fail);
    req.end();
  });
}

/**
 * GET with redirects followed by hand: every hop is checked again and goes through a new CONNECT (the proxy
 * re-resolves and re-checks the address).
 * @param {string} input @param {{ proxy: string, limits?: Partial<typeof LIMITS>, headers?: Record<string,string>, httpsOnly?: boolean, ca?: string }} o
 */
export async function get(input, o) {
  const limits = { ...LIMITS, ...o.limits };
  const proxy = new URL(o.proxy);
  const deadline = Date.now() + limits.totalMs;
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new WebError("web_bad_url");
  }
  for (let n = 0; n <= limits.maxRedirects; n++) {
    if (Date.now() >= deadline) throw new WebError("web_timeout");
    // Raw jobs (finance, #30) send a contact header and session cookies: TLS on every hop, the first one and each
    // redirect (`http://allowed-host:443/` would otherwise pass the proxy's host and port check in clear text).
    if (o.httpsOnly && url.protocol !== "https:") throw new WebError("web_blocked");
    const r = await hop(url, {
      proxy,
      deadline,
      maxBytes: limits.maxBytes,
      ...(o.headers ? { headers: o.headers } : {}),
      // Tests only (in-process): extra trusted roots. The sandboxed process never gets this.
      ...(o.ca ? { ca: o.ca } : {}),
    });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.location;
      if (!loc) throw new WebError("web_http_error");
      try {
        url = new URL(String(loc), url);
      } catch {
        throw new WebError("web_bad_url");
      }
      continue;
    }
    return { url, ...r };
  }
  throw new WebError("web_too_many_redirects");
}

// ---------------------------------------------------------------------------------------------------------------
// Text extraction — small and dependency-free. Untrusted markup is parsed here, inside the sandbox.

const NAMED = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  middot: "·",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  bull: "•",
  times: "×",
  deg: "°",
};

/** @param {string} s */
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : "";
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Attribute value of the first tag matching `tagRe` whose attributes contain `has`. */
function metaContent(html, attr, value) {
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const a = new RegExp(`\\b${attr}\\s*=\\s*["']?${value.replace(/[.:]/g, "\\$&")}["'\\s/>]`, "i");
    if (!a.test(tag)) continue;
    const c = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    if (c) return decodeEntities(c[1] ?? c[2] ?? c[3] ?? "").trim();
  }
  return undefined;
}

const clean = (s) =>
  decodeEntities(s.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

/** An ISO date from a page's date string, or undefined when it is not a date. */
function isoDate(s) {
  if (!s) return undefined;
  const t = Date.parse(s.trim());
  if (!Number.isFinite(t)) return undefined;
  const y = new Date(t).getUTCFullYear();
  return y >= 1990 && y <= 2100 ? new Date(t).toISOString() : undefined;
}

const DROP = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "object",
  "canvas",
  "select",
  "button",
];
const CHROME = ["nav", "footer", "aside", "form", "header"];
const BLOCK =
  /<\/?(p|div|br|li|ul|ol|h[1-6]|tr|table|section|article|main|blockquote|pre|dd|dt|dl|figure|figcaption|hr)\b[^>]*>/gi;

/** Removes `<tag …>…</tag>` blocks (non-nested match per opening tag; nested leftovers are stripped later). */
function dropBlocks(html, tags) {
  let out = html;
  for (const t of tags) out = out.replace(new RegExp(`<${t}\\b[^>]*>[\\s\\S]*?<\\/${t}\\s*>`, "gi"), " ");
  return out;
}

/** The inner HTML of the longest `<tag>` element, if any (article / main). */
function longest(html, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "gi");
  let best;
  let m;
  while ((m = re.exec(html))) if (!best || m[1].length > best.length) best = m[1];
  return best;
}

/** Readable text of an HTML fragment: block tags become line breaks, everything else goes. */
export function htmlToText(fragment) {
  const t = decodeEntities(
    fragment
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(BLOCK, "\n")
      .replace(/<[^>]*>/g, " "),
  );
  return t
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v\r\u00a0]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * Title, site, publication date and readable text of an HTML page.
 * @param {string} html @param {URL} url
 */
export function extractHtml(html, url) {
  const title =
    metaContent(html, "property", "og:title") ??
    metaContent(html, "name", "twitter:title") ??
    (() => {
      const m = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
      return m ? clean(m[1]) : undefined;
    })() ??
    (() => {
      const m = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html);
      return m ? clean(m[1]) : undefined;
    })();
  const site = metaContent(html, "property", "og:site_name") ?? url.hostname.replace(/^www\./, "");
  const ld = /"datePublished"\s*:\s*"([^"]{6,40})"/.exec(html)?.[1];
  const time = /<time\b[^>]*\bdatetime\s*=\s*["']([^"']{6,40})["']/i.exec(html)?.[1];
  const publishedAt =
    isoDate(metaContent(html, "property", "article:published_time")) ??
    isoDate(metaContent(html, "name", "article:published_time")) ??
    isoDate(metaContent(html, "property", "og:published_time")) ??
    isoDate(metaContent(html, "name", "pubdate")) ??
    isoDate(metaContent(html, "name", "date")) ??
    isoDate(metaContent(html, "itemprop", "datePublished")) ??
    isoDate(ld) ??
    isoDate(time);
  let body = html.replace(/<!--[\s\S]*?-->/g, " ");
  body = dropBlocks(body, ["head", ...DROP]);
  const main = longest(body, "article") ?? longest(body, "main");
  let text = htmlToText(dropBlocks(main ?? body, CHROME));
  // A page whose chrome-free text is nearly empty (an app shell): fall back to everything visible.
  if (text.length < 200 && main === undefined) text = htmlToText(body);
  return { title: title || undefined, site, publishedAt, text };
}

/** Character set from the Content-Type header or a `<meta charset>`; utf-8 when unknown or unsupported. */
function decode(body, contentType) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType ?? "")?.[1];
  const head = body.subarray(0, 4096).toString("latin1");
  const fromMeta =
    /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ??
    /<\?xml[^>]+encoding\s*=\s*["']([\w-]+)/i.exec(head)?.[1];
  for (const label of [fromHeader, fromMeta, "utf-8"]) {
    if (!label) continue;
    try {
      return new TextDecoder(label.toLowerCase(), { fatal: false }).decode(body);
    } catch {
      // unknown label: try the next one
    }
  }
  return body.toString("utf8");
}

/** @param {string} t */
const bounded = (t, max) =>
  t.length > max ? { text: t.slice(0, max), truncated: true } : { text: t, truncated: false };

/**
 * Fetches a page and extracts it.
 * @param {string} input @param {{ proxy: string, limits?: Partial<typeof LIMITS> }} o
 */
export async function fetchPage(input, o) {
  const limits = { ...LIMITS, ...o.limits };
  const r = await get(input, o);
  if (r.status < 200 || r.status >= 300) throw new WebError("web_http_error");
  const ct = String(r.headers["content-type"] ?? "").toLowerCase();
  let mime = ct.split(";")[0].trim();
  if (!mime) {
    // No type: read it only if it is plainly HTML.
    const start = r.body.subarray(0, 512).toString("latin1").trimStart().toLowerCase();
    if (start.startsWith("<!doctype html") || start.startsWith("<html")) mime = "text/html";
  }
  const kind = TYPES.get(mime) ?? (/^application\/[\w.+-]+\+json$/.test(mime) ? "json" : undefined);
  if (!kind) throw new WebError("web_unsupported_type");
  const raw = decode(r.body, ct);
  const finalUrl = r.url.toString();
  if (kind === "html") {
    const page = extractHtml(raw, r.url);
    return { finalUrl, status: r.status, contentType: mime, ...page, ...bounded(page.text, limits.maxChars) };
  }
  let text = raw.replace(/\r\n?/g, "\n");
  if (kind === "json") {
    try {
      text = JSON.stringify(JSON.parse(text), null, 1);
    } catch {
      throw new WebError("web_bad_content");
    }
  }
  return {
    finalUrl,
    status: r.status,
    contentType: mime,
    title: undefined,
    site: r.url.hostname.replace(/^www\./, ""),
    publishedAt: undefined,
    ...bounded(text.trim(), limits.maxChars),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Search: DuckDuckGo's HTML page (opt-in provider, see docs/decisions/isolation.md "웹 검색·가져오기 (#50)").

/** `//duckduckgo.com/l/?uddg=<url>` → the target; anything that is not an http(s) URL → undefined. */
function ddgTarget(href) {
  let h = decodeEntities(href);
  if (h.startsWith("//")) h = `https:${h}`;
  let u;
  try {
    u = new URL(h, "https://html.duckduckgo.com/");
  } catch {
    return undefined;
  }
  if (/(^|\.)duckduckgo\.com$/.test(u.hostname) && u.pathname === "/l/") {
    const t = u.searchParams.get("uddg");
    if (!t) return undefined;
    try {
      u = new URL(t);
    } catch {
      return undefined;
    }
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  // Ads go through duckduckgo.com/y.js — not results.
  if (/(^|\.)duckduckgo\.com$/.test(u.hostname)) return undefined;
  return u.toString();
}

/** Results of a DuckDuckGo HTML page; `web_search_blocked` for its bot challenge. */
export function parseDuckDuckGo(html, max) {
  if (/anomaly-modal|anomaly\.js|challenge-form/.test(html)) throw new WebError("web_search_blocked");
  const results = [];
  const re = /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && results.length < max) {
    const href = /\bhref="([^"]*)"/i.exec(m[0])?.[1];
    const url = href ? ddgTarget(href) : undefined;
    if (!url) continue;
    const title = clean(m[0]);
    // The snippet follows its title link within the same result block.
    const rest = html.slice(re.lastIndex, re.lastIndex + 4000);
    const next = rest.search(/class="[^"]*\bresult__a\b/);
    const block = next >= 0 ? rest.slice(0, next) : rest;
    const sn =
      /<(?:a|div|td)\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i.exec(
        block,
      );
    results.push({ url, title, snippet: sn ? clean(sn[1]) : undefined });
  }
  return results;
}

/**
 * @param {{ query: string, max: number, region?: string }} job @param {{ proxy: string }} o
 */
export async function searchDuckDuckGo(job, o) {
  const u = new URL("https://html.duckduckgo.com/html/");
  u.searchParams.set("q", job.query);
  u.searchParams.set("kl", job.region ?? "kr-kr");
  const r = await get(u.toString(), { ...o, limits: { maxRedirects: 0, maxBytes: 1024 * 1024 } });
  if (r.status !== 200)
    throw new WebError(r.status === 202 || r.status === 403 ? "web_search_blocked" : "web_http_error");
  return { results: parseDuckDuckGo(decode(r.body, String(r.headers["content-type"] ?? "")), job.max) };
}

// ---------------------------------------------------------------------------------------------------------------
// Raw data requests (finance tools, #30): a few GETs of exact URLs the server built, returned as text for the
// server to parse. The egress proxy of the calling tool lets through its own hosts only.

/** Request headers a step may set (anything else is ignored). */
const STEP_HEADERS = new Set(["user-agent", "accept"]);
/** A captured value (Yahoo's crumb) as it may go into a later URL. */
const CAPTURE = /^[A-Za-z0-9._/~+-]{1,64}$/;
export const RAW_LIMITS = { maxSteps: 4, maxBytes: 3 * 1024 * 1024, maxRedirects: 2 };
/** At most this many session values are remembered per job (each one is scrubbed from every later body). */
const MAX_SEEN = 200;

const reEscape = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A literal as a pattern in which `%xx` escapes match in either case (`%2F` and `%2f`). */
const encodedPattern = (t) =>
  t
    .split(/(%[0-9A-Fa-f]{2})/)
    .map((part) =>
      /^%[0-9A-Fa-f]{2}$/.test(part)
        ? `%[${part[1].toUpperCase()}${part[1].toLowerCase()}][${part[2].toUpperCase()}${part[2].toLowerCase()}]`
        : reEscape(part),
    )
    .join("");

/**
 * A data body with every session value seen during this job (every cookie value sent or set — also ones a later
 * response replaced — and every captured crumb) taken out: a server that reflects them (an echoing API, a profile
 * text) must not hand them to the model. JSON is rewritten in its canonical form first, so an escaped spelling
 * (`\u0041`, `\/`) cannot hide a value; the JSON-escaped and URL-encoded (`%2F` or `%2f`) spellings are scrubbed
 * too. Whatever its length, a value is replaced only as a whole token (no letter or digit on either side), so a
 * short crumb such as `xyz` does not cut into `xyzzy`. In JSON only string values are scrubbed, never keys; a key,
 * number or literal that is a whole session value (a cookie `1` and a price `1`) refuses the response
 * (`web_bad_content` → `finance_bad_response`): it fails closed rather than handing the value on or changing data. Base64 and partial spellings are out of scope (docs/decisions/isolation.md).
 * @param {string} body @param {Iterable<string>} hidden
 */
export function scrubBody(body, hidden) {
  const values = [...new Set(hidden)].filter((v) => typeof v === "string" && v.length > 0);
  if (!values.length) return body;
  // Longest first: a value inside a longer one goes with it.
  values.sort((a, b) => b.length - a.length);
  const patterns = values.flatMap((v) =>
    [...new Set([v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v)])].map(
      (form) => new RegExp(`(?<![A-Za-z0-9])${encodedPattern(form)}(?![A-Za-z0-9])`, "g"),
    ),
  );
  const scrub = (t) => patterns.reduce((acc, re) => acc.replace(re, "[redacted]"), t);
  const hit = (t) => patterns.some((re) => ((re.lastIndex = 0), re.test(t)));
  // Keys are the data's names, not its text: a short session value that happens to be a field name (`raw`) leaves
  // them alone. A key carrying a long session value (8+ characters — a token, not a name) refuses the response.
  const keyHit = (k) =>
    values.some((v) => v.length >= 8 && new RegExp(`(?<![A-Za-z0-9])${reEscape(v)}(?![A-Za-z0-9])`).test(k));
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    return scrub(body); // not JSON: the raw text
  }
  // JSON: only string values are scrubbed — never keys (a crumb `raw` must not rename `{"raw": …}` fields and
  // silently empty the data). A number or literal that is itself a session value is refused (fails closed).
  const walk = (x) => {
    if (typeof x === "string") return scrub(x);
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object")
      return Object.fromEntries(
        Object.entries(x).map(([k, v]) => {
          if (keyHit(k)) throw new WebError("web_bad_content");
          return [k, walk(v)];
        }),
      );
    if (x !== null && hit(String(x))) throw new WebError("web_bad_content");
    return x;
  };
  return JSON.stringify(walk(data));
}

/**
 * Runs the steps in order with one cookie jar (cookies set by a response go with the later requests of this job
 * only). A step is `{ url, headers?, mode? }`:
 * - `mode: "cookie"`: only its cookies are kept (any status), nothing is returned;
 * - `mode: "capture", capture: <name>`: its body (one short token) replaces `{<name>}` in the later URLs and is
 *   not returned (a session token, never handed back);
 * - otherwise its `{ status, contentType, body }` is returned, in order.
 * Cookie and captured values never leave this process.
 * @param {{ steps?: unknown }} job @param {{ proxy: string, ca?: string }} o
 */
export async function fetchRaw(job, o) {
  const steps = job.steps;
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > RAW_LIMITS.maxSteps)
    throw new WebError("web_bad_input");
  const jar = new Map();
  const vars = new Map();
  /** Every session value of the job, kept after the jar replaced it. */
  const seen = new Set();
  const responses = [];
  for (const step of steps) {
    if (!step || typeof step !== "object" || typeof step.url !== "string")
      throw new WebError("web_bad_input");
    const url = step.url.replace(/\{(\w{1,20})\}/g, (m, k) =>
      vars.has(k) ? encodeURIComponent(vars.get(k)) : m,
    );
    /** @type {Record<string,string>} */
    const headers = {};
    for (const [k, v] of Object.entries(step.headers ?? {}))
      if (STEP_HEADERS.has(k.toLowerCase()) && typeof v === "string" && /^[\x20-\x7e]{1,200}$/.test(v))
        headers[k.toLowerCase()] = v;
    if (!headers.accept) headers.accept = "application/json,text/plain;q=0.9,*/*;q=0.1";
    if (jar.size) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    const r = await get(url, {
      ...o,
      headers,
      httpsOnly: true,
      limits: { maxBytes: RAW_LIMITS.maxBytes, maxRedirects: RAW_LIMITS.maxRedirects },
    });
    const set = r.headers["set-cookie"];
    for (const c of Array.isArray(set) ? set : set ? [set] : []) {
      const m = /^([!#$%&'*+.^_`|~0-9A-Za-z-]{1,64})=([^;\s]{0,4096})/.exec(String(c));
      if (!m) continue;
      if (seen.size < MAX_SEEN) seen.add(m[2]);
      if (jar.has(m[1]) || jar.size < 20) jar.set(m[1], m[2]);
    }
    if (step.mode === "cookie") continue;
    const ct = String(r.headers["content-type"] ?? "").toLowerCase();
    const body = decode(r.body, ct);
    if (step.mode === "capture") {
      const v = body.trim();
      if (r.status !== 200) throw new WebError("web_http_error");
      if (typeof step.capture !== "string" || !CAPTURE.test(v)) throw new WebError("web_bad_content");
      vars.set(step.capture, v);
      seen.add(v);
      continue;
    }
    responses.push({
      status: r.status,
      contentType: ct.split(";")[0].trim(),
      body: scrubBody(body, [...seen, ...jar.values(), ...vars.values()]),
    });
  }
  return { responses };
}

/** Runs one job. Never throws: a fixed code on failure (no message, which could carry page text). */
export async function run(job, o) {
  try {
    if (job.op === "fetch") return { ok: true, ...(await fetchPage(job.url, o)) };
    if (job.op === "raw") return { ok: true, ...(await fetchRaw(job, o)) };
    if (job.op === "search" && job.provider === "duckduckgo")
      return { ok: true, ...(await searchDuckDuckGo(job, o)) };
    return { ok: false, code: "web_bad_input" };
  } catch (e) {
    return { ok: false, code: e instanceof WebError ? e.code : "web_failed" };
  }
}

// As a process (the sandbox sets AGENTLEE_WEB_WORKER=1): the job on stdin, the proxy from AGENTLEE_PROXY.
if (process.env.AGENTLEE_WEB_WORKER === "1") {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", async () => {
    let job;
    try {
      job = JSON.parse(raw);
    } catch {
      job = {};
    }
    const out = await run(job, { proxy: process.env.AGENTLEE_PROXY ?? "http://127.0.0.1:9" });
    process.stdout.write(JSON.stringify(out), () => process.exit(0));
  });
}
