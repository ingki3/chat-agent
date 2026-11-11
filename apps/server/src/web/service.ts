import fs from "node:fs";
import net from "node:net";
import type { SkillResult, ToolScope } from "@agentlee/mcp-tools";
import type { SearchHit } from "@agentlee/mcp-tools/skills";
import { WEB_WORKER_DIR, WEB_WORKER_ENTRY } from "@agentlee/mcp-tools/web";
import { defuseExternal, frameExternal } from "@agentlee/shared";
import { EgressService, isPrivateName } from "../isolation/egress.js";
import { isBlockedAddress } from "../isolation/net.js";
import { runIsolated } from "../isolation/sandbox.js";
import { cut, SOURCE_LIMITS, type SourceStore } from "./sources.js";

/**
 * Web search and fetch for the runtimes (#50, PRD FR-5.1·5.2·5.7, network policy #42).
 *
 * The page is fetched and parsed by a sandboxed node worker (`@agentlee/mcp-tools/web` worker.mjs): it reads only
 * its own folder, cannot fork, gets no environment of ours (no cookies, no keys) and has one loopback port — the
 * web egress proxy. That proxy accepts CONNECT to ports 80/443 of any *public* name or address: it resolves the
 * name itself, refuses loopback, private, link-local, CGNAT, metadata and reserved answers, and connects to the
 * address it checked. Every redirect hop is a new CONNECT, so redirects and DNS rebinding get the same check.
 * The server checks the URL before starting anything (scheme, credentials, port, address literals in every
 * spelling, `localhost`-type names) so obvious refusals cost no process.
 *
 * What comes back is stored as a source of the conversation (`sources`) and the model gets the source id, title,
 * site, URL and a bounded excerpt inside an `<external_content>` block — not the whole body.
 */

/** Outcome codes of the web tools (logged as `webCode`, shown to the model as `{ error }`). */
export const WEB_CODES = [
  "web_bad_input",
  "web_bad_url",
  "web_blocked",
  "web_unreachable",
  "web_timeout",
  "web_tls",
  "web_too_large",
  "web_too_many_redirects",
  "web_unsupported_type",
  "web_http_error",
  "web_bad_content",
  "web_no_text",
  "web_search_blocked",
  "web_search_unavailable",
  "web_unavailable",
  "web_limit",
  "web_failed",
  "web_busy",
  "web_not_allowed",
] as const;
export type WebCode = (typeof WEB_CODES)[number];
const KNOWN = new Set<string>(WEB_CODES);
const code = (c: unknown): WebCode => (typeof c === "string" && KNOWN.has(c) ? (c as WebCode) : "web_failed");

/** Characters of page text the model gets back from one fetch (the stored body is longer). */
export const EXCERPT_CHARS = 10_000;
export const MAX_URL = SOURCE_LIMITS.url;

/**
 * The server-side check of a URL the model asked for: http/https, no credentials, port 80/443, and the host is
 * neither an address that must not be reached (in any spelling — the WHATWG parser already turned decimal,
 * octal and hex IPv4 into dotted form, and IPv4-mapped IPv6 into hex) nor a name that is never public.
 */
export function checkUrl(raw: string): { ok: true; url: URL } | { ok: false; code: WebCode } {
  if (raw.length > MAX_URL) return { ok: false, code: "web_bad_url" };
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, code: "web_bad_url" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, code: "web_bad_url" };
  if (u.username || u.password) return { ok: false, code: "web_bad_url" };
  if (u.port && u.port !== "80" && u.port !== "443") return { ok: false, code: "web_bad_url" };
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (!host) return { ok: false, code: "web_bad_url" };
  if (net.isIP(host))
    return isBlockedAddress(host) ? { ok: false, code: "web_blocked" } : { ok: true, url: u };
  // A numeric last label that is not a dotted IPv4 (the parser refused it, or it is not an address at all).
  if (/(^|\.)(\d+|0x[0-9a-f]*)\.?$/i.test(host)) return { ok: false, code: "web_blocked" };
  if (isPrivateName(host)) return { ok: false, code: "web_blocked" };
  return { ok: true, url: u };
}

/** A worker job and what comes back (worker.mjs). */
export type WorkerJob =
  { op: "fetch"; url: string } | { op: "search"; provider: "duckduckgo"; query: string; max: number };
export type WorkerOutput = { ok: true; [k: string]: unknown } | { ok: false; code: string };
/** Runs the worker with the given egress proxy. Default: the sandboxed process. Tests run it in-process. */
export type WebWorker = (job: WorkerJob, proxy: { url: string; port: number }) => Promise<WorkerOutput>;

export const WORKER_LIMITS = {
  timeoutMs: 30_000,
  maxOutputBytes: 4 * 1024 * 1024,
  maxRssBytes: 256 * 1024 * 1024,
};

/**
 * The worker in the sandbox: reads its own folder and node only, writes nothing, no children, no inherited
 * environment, network = the one proxy port. Fails closed (`web_unavailable`) where there is no sandbox.
 */
export function sandboxedWorker(node = fs.realpathSync(process.execPath)): WebWorker {
  return async (job, proxy) => {
    let r;
    try {
      r = await runIsolated({
        command: node,
        args: [WEB_WORKER_ENTRY],
        cwd: WEB_WORKER_DIR,
        env: { AGENTLEE_WEB_WORKER: "1", AGENTLEE_PROXY: proxy.url },
        read: [WEB_WORKER_DIR],
        trusted: [],
        write: [],
        network: { loopbackPorts: [proxy.port] },
        stdin: JSON.stringify(job),
        ...WORKER_LIMITS,
      });
    } catch {
      return { ok: false, code: "web_unavailable" };
    }
    if (r.killed === "timeout") return { ok: false, code: "web_timeout" };
    if (r.killed) return { ok: false, code: "web_limit" };
    try {
      const out = JSON.parse(r.stdout) as WorkerOutput;
      return out && typeof out === "object" ? out : { ok: false, code: "web_failed" };
    } catch {
      return { ok: false, code: "web_failed" };
    }
  };
}

/** A search provider: query → results (untrusted text, bounded on the way into `sources`). */
export type SearchProvider = {
  name: string;
  search(
    query: string,
    max: number,
    scope: ToolScope,
  ): Promise<{ ok: true; hits: SearchHit[] } | { ok: false; code: string }>;
};

export type Proxy = Pick<EgressService, "endpoint" | "close">;

/** Provider names `WEB_SEARCH_PROVIDERS` may list (docs/decisions/isolation.md "웹 검색·가져오기 (#50)"). */
export const SEARCH_PROVIDER_NAMES = ["google-news", "duckduckgo"] as const;
export type SearchProviderName = (typeof SEARCH_PROVIDER_NAMES)[number];
export const DUCKDUCKGO_HOSTS = ["html.duckduckgo.com"] as const;

/** DuckDuckGo's HTML results page, fetched by the worker through a proxy that reaches that host only. */
export function duckDuckGoProvider(worker: WebWorker, proxy: Proxy): SearchProvider {
  return {
    name: "duckduckgo",
    async search(query, max) {
      let p;
      try {
        p = await proxy.endpoint();
      } catch {
        return { ok: false, code: "web_unavailable" };
      }
      const r = await worker({ op: "search", provider: "duckduckgo", query, max }, p);
      if (!r.ok)
        return { ok: false, code: code(r.code) === "web_failed" ? "web_search_unavailable" : code(r.code) };
      const results = Array.isArray(r.results) ? (r.results as unknown[]) : [];
      return { ok: true, hits: results.flatMap((x) => hitOf(x)) };
    },
  };
}

/** A worker / skill result item as a search hit, or nothing when it has no usable link and title. */
function hitOf(x: unknown): SearchHit[] {
  if (!x || typeof x !== "object") return [];
  const o = x as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const url = s(o.url);
  const title = s(o.title);
  if (!url || !title) return [];
  const snippet = s(o.snippet);
  const site = s(o.site);
  const publishedAt = s(o.publishedAt);
  return [
    {
      url,
      title,
      ...(snippet ? { snippet } : {}),
      ...(site ? { site } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    },
  ];
}

/** A link of a search result we keep: an absolute http(s) URL of bounded length (no credentials). */
function linkOf(raw: string): URL | undefined {
  if (raw.length > MAX_URL) return undefined;
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password ? u : undefined;
  } catch {
    return undefined;
  }
}
const siteOf = (u: URL) => u.hostname.replace(/^www\./, "");
/** ISO date when the text is a date (RFC 822 in RSS, ISO elsewhere); undefined otherwise. */
const isoOf = (s: string | undefined) => {
  if (!s) return undefined;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
};

/**
 * Characters one `web_search` answer gives the model at most (the framed block and the `results` list together;
 * the query and fixed keys come on top).
 */
export const SEARCH_OUTPUT_CHARS = 12_000;

/** A search hit as stored and shown: usable link, bounded title/site/snippet, ISO date — or undefined. */
function boundHit(h: SearchHit): (SearchHit & { site: string }) | undefined {
  const url = linkOf(h.url);
  if (!url) return undefined;
  const title = cut(h.title, SOURCE_LIMITS.title);
  if (!title) return undefined;
  const snippet = h.snippet ? cut(h.snippet, SOURCE_LIMITS.snippet) : "";
  const publishedAt = isoOf(h.publishedAt);
  return {
    url: url.toString(),
    title,
    site: cut(h.site ?? siteOf(url), SOURCE_LIMITS.site) || siteOf(url),
    ...(snippet ? { snippet } : {}),
    ...(publishedAt ? { publishedAt } : {}),
  };
}

export type WebServiceOptions = {
  sources: SourceStore;
  /** Search providers in the order they are tried. None: `web_search` is not offered. */
  providers?: readonly SearchProvider[];
  worker?: WebWorker;
  /** The egress proxy for page fetches (tests). Default: any public host, ports 80/443. */
  fetchProxy?: Proxy;
};

export class WebService {
  private readonly worker: WebWorker;
  private readonly fetchProxy: Proxy;
  readonly providers: readonly SearchProvider[];

  constructor(private readonly opts: WebServiceOptions) {
    this.worker = opts.worker ?? sandboxedWorker();
    this.fetchProxy = opts.fetchProxy ?? new EgressService({ allow: "public", ports: [80, 443] });
    this.providers = opts.providers ?? [];
  }

  /** Whether `web_search` can be offered (at least one provider). */
  get canSearch(): boolean {
    return this.providers.length > 0;
  }

  /**
   * Registers one search hit as a source of the conversation. Undefined when its link is not a usable http(s)
   * URL; `id` is missing when the scope does not own the conversation (nothing stored).
   */
  registerHit(provider: string, hit: SearchHit, scope: ToolScope): { url: URL; id?: string } | undefined {
    const url = linkOf(hit.url);
    if (!url) return undefined;
    const row = this.opts.sources.addSearchResult(scope, {
      provider,
      url: url.toString(),
      title: hit.title,
      site: hit.site ?? siteOf(url),
      publishedAt: isoOf(hit.publishedAt),
      snippet: hit.snippet,
    });
    return { url, ...(row ? { id: row.id } : {}) };
  }

  async search(input: { query: string; maxResults?: number }, scope: ToolScope): Promise<SkillResult> {
    const max = input.maxResults ?? 8;
    let last: string = "web_search_unavailable";
    for (const p of this.providers) {
      const r = await p.search(input.query, max, scope);
      if (!r.ok) {
        last = r.code;
        continue;
      }
      return { ok: true, output: this.searchOutput(p.name, input.query, r.hits.slice(0, max), scope) };
    }
    return { ok: false, code: code(last) === "web_failed" ? "web_search_unavailable" : code(last) };
  }

  /**
   * The answer of one search, at most SEARCH_OUTPUT_CHARS as the MCP text the model gets (`JSON.stringify` of the
   * whole answer — escapes and the defused block counted, not raw lengths). Results are normalised and bounded
   * once and the same values are stored and shown; results are taken in order until the next one would go over
   * the cap, and only the taken ones are stored.
   *
   * Each result's contribution is measured exactly (the JSON-escaped length of its defused line in the block and
   * of its `results` entry), so selection is one pass. The assembled answer is then measured once more: a tag
   * split across two lines would only be defused in the joined text, so in that rare case the last result is
   * dropped until the real length fits.
   */
  private searchOutput(provider: string, query: string, raw: readonly SearchHit[], scope: ToolScope) {
    const source = `search:${provider}`;
    const esc = (t: string) => JSON.stringify(t).length - 2;
    const lineOf = (hit: SearchHit & { site: string }, n: number) =>
      [
        `[${n}] ${hit.title}`,
        `site: ${hit.site}${hit.publishedAt ? ` · ${hit.publishedAt}` : ""}`,
        `url: ${hit.url}`,
        ...(hit.snippet ? [hit.snippet] : []),
      ].join("\n");
    const entry = (hit: SearchHit & { site: string }, n: number, sourceId: string | null) => ({
      n,
      sourceId,
      url: hit.url,
      site: hit.site,
      publishedAt: hit.publishedAt ?? null,
    });
    const assemble = (hits: (SearchHit & { site: string })[], ids: (string | null)[]) => ({
      provider,
      query,
      results: hits.map((h, i) => entry(h, i + 1, ids[i] ?? null)),
      // Titles and snippets are the search engine's (and the pages') words: data, never instructions.
      content: frameExternal({
        source,
        content: hits.map((h, i) => lineOf(h, i + 1)).join("\n\n") || "(no results)",
      }),
    });
    // A source id is a UUID: measured with one of the same length, before anything is stored.
    const PLACEHOLDER = "00000000-0000-4000-8000-000000000000";
    const base = JSON.stringify({
      ...assemble([], []),
      content: frameExternal({ source, content: "" }),
    }).length;
    const taken: (SearchHit & { site: string })[] = [];
    let total = base;
    for (const r of raw) {
      const hit = boundHit(r);
      if (!hit) continue;
      const n = taken.length + 1;
      const cost =
        esc(defuseExternal(lineOf(hit, n))) +
        (n > 1 ? esc("\n\n") : 0) +
        JSON.stringify(entry(hit, n, PLACEHOLDER)).length +
        (n > 1 ? 1 : 0);
      if (total + cost > SEARCH_OUTPUT_CHARS) break;
      total += cost;
      taken.push(hit);
    }
    const placeholders = () => taken.map(() => PLACEHOLDER);
    while (taken.length && JSON.stringify(assemble(taken, placeholders())).length > SEARCH_OUTPUT_CHARS)
      taken.pop();
    const ids = taken.map((hit) => this.registerHit(provider, hit, scope)?.id ?? null);
    return assemble(taken, ids);
  }

  async fetch(input: { url: string }, scope: ToolScope): Promise<SkillResult> {
    const checked = checkUrl(input.url);
    if (!checked.ok) return checked;
    let proxy;
    try {
      proxy = await this.fetchProxy.endpoint();
    } catch {
      return { ok: false, code: "web_unavailable" };
    }
    const r = await this.worker({ op: "fetch", url: checked.url.toString() }, proxy);
    if (!r.ok) return { ok: false, code: code(r.code) };
    const text = typeof r.text === "string" ? r.text : "";
    const finalUrl = typeof r.finalUrl === "string" ? linkOf(r.finalUrl) : undefined;
    if (!finalUrl) return { ok: false, code: "web_failed" };
    if (!text.trim()) return { ok: false, code: "web_no_text" };
    const s = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const site = s(r.site) ?? siteOf(finalUrl);
    const row = this.opts.sources.addPage(scope, {
      url: checked.url.toString(),
      finalUrl: finalUrl.toString(),
      title: s(r.title) ?? site,
      site,
      publishedAt: isoOf(s(r.publishedAt)),
      contentType: s(r.contentType) ?? "text/plain",
      body: text,
      truncated: r.truncated === true,
    });
    if (!row) return { ok: false, code: "web_not_allowed" };
    const excerpt = text.length > EXCERPT_CHARS ? text.slice(0, EXCERPT_CHARS) : text;
    return {
      ok: true,
      output: {
        sourceId: row.id,
        url: row.url,
        finalUrl: row.finalUrl,
        title: row.title,
        site: row.site,
        publishedAt: row.publishedAt,
        contentType: row.contentType,
        characters: text.length,
        excerptCharacters: excerpt.length,
        truncated: row.truncated,
        content: frameExternal({ source: row.finalUrl ?? row.url, content: excerpt }),
      },
    };
  }

  async close(): Promise<void> {
    await this.fetchProxy.close();
  }
}
