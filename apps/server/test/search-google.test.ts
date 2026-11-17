import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GOOGLE_NEWS_SKILL,
  isGoogleRedirect,
  SEARCH_GOOGLE_SKILL,
  SELFTEST_SKILL,
  SKILL_SECRET_NAMES,
  type BundledSkill,
} from "@agentlee/mcp-tools/skills";
import { UserStore } from "../src/auth/users.js";
import { isWebTool } from "../src/citations/checker.js";
import { loadConfig } from "../src/config.js";
import { ConversationStore } from "../src/conversations/store.js";
import { createTestDb } from "../src/db/client.js";
import { serveGate } from "../src/isolation/sandbox.js";
import { McpTokens } from "../src/isolation/tokens.js";
import { findSource } from "../src/mcp/install.js";
import {
  McpService,
  SKILL_BODY_MAX,
  SKILL_NET_BOOT,
  SKILL_SECRET_BLOCKED,
  skillSendGate,
  type SkillRunner,
} from "../src/mcp/service.js";
import { SkillSwitches } from "../src/mcp/switches.js";
import { SKILL_CODES } from "../src/observability/policy.js";
import { knownSecrets } from "../src/secrets/known.js";
import { SourceStore } from "../src/web/sources.js";
import type { WebWorker } from "../src/web/service.js";
import { callOurTool } from "./helpers/live-mcp.js";

/**
 * search-google (#171): Google web, news and video search through the Serper API. The key goes out in the
 * `X-API-KEY` header of a request to google.serper.dev — and nowhere else (URL, body, another header, another
 * host); the body of the POST is checked too. Links Serper could not resolve are never sources. As a web_search
 * provider it comes first when installed with its key, follows the user's and the server's skill switches, and a
 * run has at most `maxCallsPerRun` calls. Synthetic keys and local mock servers only — never the real API.
 */

const KEY = "test-serper-key-0000";
const HOST = "google.serper.dev";
const TOKEN = "synthSerper7Pq8Wn2Xc6Vb9Lm3Kj7Hd5Gf1";
const KOREAN = "합성검색비밀-SYNTHETIC-7d1f3a-끝";
const ENV = { SERPER_API_KEY: KEY };

const google: BundledSkill = { ...SEARCH_GOOGLE_SKILL, dir: "/nonexistent", entry: "/nonexistent/serper.py" };

beforeEach(() => {
  for (const s of [TOKEN, KOREAN]) knownSecrets.add(s, { fresh: true });
});
afterEach(() => {
  for (const s of [TOKEN, KOREAN]) knownSecrets.remove(s);
});

/** What serper_search.py's `call` hands to http.client: the head (urllib's header names), then the body. */
const head = (
  o: {
    path?: string;
    host?: string;
    length: number;
    headers?: Record<string, string>;
    key?: string | null;
  } = {
    length: 0,
  },
) =>
  JSON.stringify({
    host: o.host ?? HOST,
    data:
      `POST ${o.path ?? "/search"} HTTP/1.1\r\nAccept-Encoding: identity\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${o.length}\r\nHost: ${o.host ?? HOST}\r\nUser-Agent: Python-urllib/3.12\r\n` +
      (o.key === null ? "" : `X-api-key: ${o.key ?? KEY}\r\n`) +
      Object.entries(o.headers ?? {})
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join("") +
      "Connection: close\r\n\r\n",
  });
const body = (text: string, host = HOST) => JSON.stringify({ host, data: text });
const connect = (host = HOST) =>
  JSON.stringify({ host, data: `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n` });
/** python's json.dumps (ASCII only: non-ASCII as \uXXXX). */
const pyJson = (v: unknown) =>
  JSON.stringify(v).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
/** One whole search call as the gate sees it: CONNECT, head, body. */
const search = (payload: Record<string, unknown>, o: Parameters<typeof head>[0] = { length: 0 }) => {
  const b = pyJson(payload);
  return [connect(o.host), head({ ...o, length: Buffer.byteLength(b, "latin1") }), body(b, o.host)];
};
const approves = (
  lines: string[],
  skill: Pick<BundledSkill, "hosts" | "secrets"> = google,
  secrets: Record<string, string> = ENV,
) => {
  const g = skillSendGate(skill, {}, secrets);
  return lines.map((l) => g.approve(l));
};

describe("skillSendGate: the Serper key in its header only (#171)", () => {
  it("an ordinary search and the /resolve that follows go out: the key in X-API-KEY, the JSON body checked", () => {
    const first = search({ q: "삼성전자 실적", gl: "kr", hl: "ko" });
    const resolve = search(
      {
        searchParameters: { q: "삼성전자 실적" },
        organic: [{ title: "a", link: "https://www.google.com/goto?url=x" }],
      },
      { path: "/resolve", length: 0 },
    );
    expect(approves([...first, ...resolve])).toEqual([true, true, true, true, true, true]);
    // The header name in any case, the value with the usual spaces around it.
    expect(approves([head({ length: 0, key: null, headers: { "x-api-key": ` ${KEY} ` } })])).toEqual([true]);
    expect(approves([head({ length: 0, key: null, headers: { "X-API-KEY": KEY } })])).toEqual([true]);
  });

  it("the key anywhere else is refused: URL, body, another header, a second X-API-KEY, another host", () => {
    const twoHosts = { ...google, hosts: [HOST, "other.example"] };
    const refused: [string, string[], Pick<BundledSkill, "hosts" | "secrets">?][] = [
      ["in the URL", [head({ path: `/search?apiKey=${KEY}`, length: 0 })]],
      ["in the URL, instead of the header", [head({ path: `/search?k=${KEY}`, length: 0, key: null })]],
      ["in the body", search({ q: KEY })],
      ["in the body, base64", search({ q: Buffer.from(KEY).toString("base64") })],
      ["in the body, beside the header", search({ q: "x", k: KEY })],
      ["in another header", [head({ length: 0, key: null, headers: { Authorization: `Bearer ${KEY}` } })]],
      ["in another header, beside its own", [head({ length: 0, headers: { "X-Debug": KEY } })]],
      ["in a second X-API-KEY", [head({ length: 0, headers: { "X-API-KEY": KEY } })]],
      // Review #174 round 1 P2: the first header of that name carries something else, the second the key.
      [
        "in the second X-API-KEY, the first another value",
        [head({ length: 0, key: "other", headers: { "x-api-key": KEY } })],
      ],
      ["inside a longer X-API-KEY value", [head({ length: 0, key: `${KEY}x` })]],
      ["on another allowed host", [head({ host: "other.example", length: 0 })], twoHosts],
      ["on a host the skill does not have", [head({ host: "evil.example", length: 0 })]],
      ["CONNECT to another host", [connect("evil.example")]],
    ];
    for (const [why, lines, skill] of refused) expect(approves(lines, skill).at(-1), why).toBe(false);
    // Two headers of the declared name are refused whatever they carry; one without the key is ordinary.
    expect(approves([head({ length: 0, key: "a", headers: { "X-API-KEY": "b" } })])).toEqual([false]);
    expect(approves([head({ length: 0, key: "not-the-key" })])).toEqual([true]);
  });

  it("review #174 round 2: folded lines and malformed field names are refused — the key never hides in a fold", () => {
    const raw = (fields: string) =>
      JSON.stringify({
        host: HOST,
        data: `POST /search HTTP/1.1\r\nHost: ${HOST}\r\n${fields}Content-Length: 0\r\n\r\n`,
      });
    const refused: [string, string][] = [
      // obs-fold: the key is part of X-Debug's value to any parser, not a header of its own.
      ["space fold", `X-Debug: prefix\r\n X-API-KEY: ${KEY}\r\n`],
      ["tab fold", `X-Debug: prefix\r\n\tX-API-KEY: ${KEY}\r\n`],
      ["fold beside the real header", `X-API-KEY: ${KEY}\r\nX-Debug: prefix\r\n X-API-KEY: ${KEY}\r\n`],
      ["a fold without any secret", `X-Debug: prefix\r\n more\r\n`],
      ["space before the colon", `X-API-KEY : ${KEY}\r\n`],
      ["tab before the colon", `X-API-KEY\t: ${KEY}\r\n`],
      ["leading space in the name", ` X-API-KEY: ${KEY}\r\n`],
      ["space inside the name", `X API-KEY: ${KEY}\r\n`],
      ["separator in the name", `X-API(KEY): ${KEY}\r\n`],
      ["non-ASCII in the name", `X-API-KEYé: ${KEY}\r\n`],
      ["empty name", `: ${KEY}\r\n`],
      ["no colon", `X-API-KEY ${KEY}\r\n`],
      ["bare CR inside a line", `X-Debug: a\rX-API-KEY: ${KEY}\r\n`],
      ["bare LF inside a line", `X-Debug: a\nX-API-KEY: ${KEY}\r\n`],
      ["space before the colon of Content-Length", `Content-Length : 5\r\n`],
    ];
    for (const [why, fields] of refused) expect(approves([raw(fields)]), why).toEqual([false]);
    // Controls: the plain header line, and OWS around the value.
    expect(approves([raw(`X-API-KEY: ${KEY}\r\n`)])).toEqual([true]);
    expect(approves([raw(`x-api-key:\t${KEY} \r\n`)])).toEqual([true]);
  });

  it("other secrets in the body are refused — also a non-ASCII one python writes as \\uXXXX escapes", () => {
    expect(approves(search({ q: `뉴스 ${TOKEN}` })).at(-1)).toBe(false);
    expect(approves(search({ q: TOKEN.slice(5, 21) })).at(-1)).toBe(false); // a 16-character window
    const escaped = search({ q: `검색 ${KOREAN}` });
    expect(JSON.parse(escaped[2]!).data).not.toContain(KOREAN); // the wire text has only the escapes
    expect(approves(escaped).at(-1)).toBe(false);
    // A key spelled in a JSON key, not a value.
    expect(approves(search({ [TOKEN]: 1 })).at(-1)).toBe(false);
    // Ordinary queries go on.
    for (const q of ["반도체 수출 전망 2026", '"exact phrase" site:yna.co.kr', TOKEN.slice(0, 15)])
      expect(approves(search({ q, gl: "kr", hl: "ko" })), q).toEqual([true, true, true]);
  });

  it("a body must be announced by one Content-Length and come whole in the next send, to the same host", () => {
    const b = pyJson({ q: "ok" });
    const n = b.length;
    expect(approves([head({ length: n }), body(b)])).toEqual([true, true]);
    // Shorter, longer, split in two, another host, nothing announced.
    expect(approves([head({ length: n }), body(b.slice(0, -1))])).toEqual([true, false]);
    expect(approves([head({ length: n - 1 }), body(b)])).toEqual([true, false]);
    expect(approves([head({ length: n }), body(b.slice(0, 3)), body(b.slice(3))])).toEqual([
      true,
      false,
      false,
    ]);
    expect(
      approves([head({ length: n }), body(b, "evil.example")], { ...google, hosts: [HOST, "evil.example"] }),
    ).toEqual([true, false]);
    expect(approves([head({ length: 0 }), body(b)])).toEqual([true, false]);
    // Chunked, two lengths, a malformed length, over the limit.
    expect(approves([head({ length: n, headers: { "Transfer-Encoding": "chunked" } })])).toEqual([false]);
    expect(approves([head({ length: n, headers: { "Content-Length": String(n) } })])).toEqual([false]);
    expect(
      approves([JSON.stringify({ host: HOST, data: "POST / HTTP/1.1\r\nContent-Length: 1e3\r\n\r\n" })]),
    ).toEqual([false]);
    expect(approves([head({ length: SKILL_BODY_MAX + 1 })])).toEqual([false]);
    // A body in the same send as its head is checked as a body too.
    const inline = (t: string) =>
      JSON.stringify({
        host: HOST,
        data: `POST /search HTTP/1.1\r\nX-API-KEY: ${KEY}\r\nContent-Length: ${t.length}\r\n\r\n${t}`,
      });
    expect(approves([inline(pyJson({ q: "ok" }))])).toEqual([true]);
    expect(approves([inline(pyJson({ q: KEY }))])).toEqual([false]);
    expect(approves([inline(pyJson({ q: `${KOREAN}` }))])).toEqual([false]);
  });

  it("the Alpha Vantage param place is unchanged (#129)", () => {
    const stock = {
      hosts: ["www.alphavantage.co"],
      secrets: [{ env: "AV", place: { host: "www.alphavantage.co", param: "apikey" } }],
    };
    const av = (q: string, extra = "") =>
      JSON.stringify({
        host: "www.alphavantage.co",
        data: `GET /query?${q} HTTP/1.1\r\nHost: www.alphavantage.co\r\n${extra}Connection: close\r\n\r\n`,
      });
    expect(approves([av("function=X&apikey=AVKEY7Q2W9")], stock, { AV: "AVKEY7Q2W9" })).toEqual([true]);
    expect(approves([av("function=X", "X-API-KEY: AVKEY7Q2W9\r\n")], stock, { AV: "AVKEY7Q2W9" })).toEqual([
      false,
    ]);
  });
});

describe("search results: real links only (#171)", () => {
  it("isGoogleRedirect: Google's goto / url redirects (and non-URLs), not ordinary Google pages", () => {
    for (const u of [
      "https://www.google.com/goto?url=https%3A%2F%2Fa.example%2F",
      "https://google.com/goto?url=x",
      "https://www.google.co.kr/url?q=https://a.example/",
      "https://www.google.com/url?sa=t&url=x",
      "HTTPS://WWW.GOOGLE.COM/GOTO?url=x",
      "https://news.google.com/goto?url=x",
      "not a url",
    ])
      expect(isGoogleRedirect(u), u).toBe(true);
    for (const u of [
      "https://support.google.com/websearch/answer/1",
      "https://www.yna.co.kr/view/AKR1",
      "https://example.com/goto?url=x",
      "https://www.youtube.com/watch?v=abc",
    ])
      expect(isGoogleRedirect(u), u).toBe(false);
  });

  it("searchHits: organic, news and videos; a redirect left over or an item without link/title is not a source", () => {
    const out = {
      searchParameters: { q: "x", type: "search" },
      organic: [
        { title: "A", link: "https://a.example/1", snippet: "snip a", position: 1, date: "Nov 10, 2026" },
        { title: "Wrapped", link: "https://www.google.com/goto?url=https%3A%2F%2Fb.example%2F", position: 2 },
        { title: "No link", position: 3 },
        { link: "https://c.example/", position: 4 },
        "junk",
      ],
      news: [
        { title: "N", link: "https://news.example/n", source: "연합뉴스", date: "5시간 전", snippet: "s" },
      ],
      videos: [{ title: "V", link: "https://www.youtube.com/watch?v=1", channel: "ch", source: "YouTube" }],
      credits: 1,
    };
    expect(SEARCH_GOOGLE_SKILL.searchHits!(out).map((h) => h.hit)).toEqual([
      { url: "https://a.example/1", title: "A", publishedAt: "Nov 10, 2026", snippet: "snip a" },
      { url: "https://news.example/n", title: "N", site: "연합뉴스", publishedAt: "5시간 전", snippet: "s" },
      { url: "https://www.youtube.com/watch?v=1", title: "V", site: "YouTube" },
    ]);
    expect(SEARCH_GOOGLE_SKILL.searchHits!({ error: "HTTP 403" })).toEqual([]);
    expect(SEARCH_GOOGLE_SKILL.searchHits!(null)).toEqual([]);
    expect(SEARCH_GOOGLE_SKILL.searchHits!([out])).toEqual([]);
    // Bounded however long the answer is.
    const many = {
      organic: Array.from({ length: 50 }, (_, i) => ({ title: `t${i}`, link: `https://x.example/${i}` })),
    };
    expect(SEARCH_GOOGLE_SKILL.searchHits!(many)).toHaveLength(30);
  });
});

/** A database with an adult who may use every skill, one with a list, and the adult's conversation. */
function family() {
  const db = createTestDb();
  const users = new UserStore(db);
  const mom = users.create({ email: "mom@example.com", name: "엄마", role: "member", passwordHash: "x" });
  const son = users.create({ email: "son@example.com", name: "아들", role: "member", passwordHash: "x" });
  users.setSkills(son.id, ["google-news-search-skill"]);
  const conversations = new ConversationStore(db);
  const c = conversations.create(mom.id);
  const sc = conversations.create(son.id);
  return { users, mom, son, c, sc, sources: new SourceStore(db) };
}

const SERPER_OUT = {
  searchParameters: { q: "반도체", gl: "kr", hl: "ko", type: "search" },
  organic: [
    { title: "반도체 기사", link: "https://a.example/chip", snippet: "수출 증가", position: 1 },
    { title: "중계 링크", link: "https://www.google.com/goto?url=https%3A%2F%2Fb.example%2F", position: 2 },
  ],
  credits: 1,
};
const NEWS_OUT = {
  ok: true,
  items: [
    { rank: 1, title: "뉴스 하나", link: "https://news.google.com/rss/articles/abc", source: "연합뉴스" },
  ],
};

describe("McpService: the search-google tool and the `google` web_search provider (#171)", () => {
  const closers: (() => Promise<unknown> | unknown)[] = [];
  afterEach(async () => {
    while (closers.length) await closers.pop()!();
  });

  const setup = (
    o: {
      secrets?: Record<string, string>;
      switches?: SkillSwitches;
      result?: (name: string) => unknown;
    } = {},
  ) => {
    const f = family();
    const calls: { name: string; input: Record<string, unknown>; runId: string }[] = [];
    const runSkill: SkillRunner = async (s, input, scope) => {
      calls.push({ name: s.name, input, runId: scope.runId });
      const out = o.result?.(s.name) ?? (s.name === google.name ? SERPER_OUT : NEWS_OUT);
      return typeof out === "string" ? { ok: false, code: out } : { ok: true, output: structuredClone(out) };
    };
    const tokens = new McpTokens();
    const svc = new McpService(tokens, f.users, {
      skills: [
        SELFTEST_SKILL,
        google,
        { ...GOOGLE_NEWS_SKILL, dir: "/nonexistent", entry: "/nonexistent/n.py" },
      ],
      python: { exe: "/opt/py/bin/python3.12", root: "/opt/py" },
      secrets: o.secrets ?? ENV,
      runSkill,
      ...(o.switches ? { switches: o.switches } : {}),
      web: {
        sources: f.sources,
        // The default order (WEB_SEARCH_PROVIDERS unset).
        worker: (async () => ({ ok: false, code: "web_failed" })) as unknown as WebWorker,
        fetchProxy: {
          endpoint: async () => ({ url: "http://127.0.0.1:9", port: 9 }) as never,
          close: async () => {},
        },
        providers: ["google", "google-news"],
      },
    });
    closers.push(() => svc.close());
    const scope = { userId: f.mom.id, conversationId: f.c.id, runId: crypto.randomUUID() };
    const call = async (tool: string, args: unknown, s = scope) => {
      const { url } = await svc.endpoint();
      const r = await callOurTool(url, tokens.issue(s), tool, args);
      const text = r.content[0]!.text!;
      let out: Record<string, unknown>;
      try {
        out = JSON.parse(text) as Record<string, unknown>;
      } catch {
        out = { text }; // the MCP layer's own refusal (a tool not in this user's list)
      }
      return { isError: r.isError, out };
    };
    return { f, svc, calls, scope, call };
  };

  it("as a tool: Serper's JSON with a sourceId on each real link; a redirect left over gets none", async () => {
    const { f, call, calls } = setup();
    const r = await call("skill_search-google", { query: "반도체", type: "news", tbs: "d" });
    expect(r.isError).toBe(false);
    expect(calls).toEqual([
      {
        name: "search-google",
        input: { query: "반도체", type: "news", tbs: "d" },
        runId: expect.any(String),
      },
    ]);
    const rows = f.sources.list(f.c.id);
    expect(rows.map((x) => [x.kind, x.provider, x.url])).toEqual([
      ["search", "search-google", "https://a.example/chip"],
    ]);
    const organic = r.out.organic as { sourceId?: unknown }[];
    expect(organic.map((o) => o.sourceId)).toEqual([rows[0]!.id, undefined]);
  });

  it("as a provider: first in the default order, its real links as results; the request is a plain web search", async () => {
    const { f, call, calls } = setup();
    const r = await call("web_search", { query: "반도체", maxResults: 5 });
    expect(r.out).toMatchObject({ provider: "google", results: [{ n: 1, url: "https://a.example/chip" }] });
    expect((r.out.results as unknown[]).length).toBe(1); // the redirect is not a result
    expect(calls.map((c) => [c.name, c.input])).toEqual([
      ["search-google", { query: "반도체", type: "search", num: 5 }],
    ]);
    expect(f.sources.list(f.c.id).map((x) => x.provider)).toEqual(["google"]);
  });

  it("without SERPER_API_KEY the provider does not exist: google-news answers", async () => {
    const { call, calls } = setup({ secrets: {} });
    expect((await call("web_search", { query: "반도체" })).out).toMatchObject({ provider: "google-news" });
    expect(calls.map((c) => c.name)).toEqual(["google-news-search-skill"]);
  });

  it("follows the skill switches: a user without the skill, the server switch off, a run's skill scope", async () => {
    const switches = new SkillSwitches();
    const { f, svc, call, calls } = setup({ switches });
    // The son's list does not name search-google: no tool, and web_search skips Google for him.
    expect(svc.toolNamesFor(f.son.id)).not.toContain("skill_search-google");
    const sonScope = { userId: f.son.id, conversationId: f.sc.id, runId: crypto.randomUUID() };
    expect((await call("web_search", { query: "반도체" }, sonScope)).out).toMatchObject({
      provider: "google-news",
    });
    const refused = await call("skill_search-google", { query: "x" }, sonScope);
    expect(refused.isError).toBe(true);
    // A schedule's run that selected only google-news.
    const scoped = {
      userId: f.mom.id,
      conversationId: f.c.id,
      runId: crypto.randomUUID(),
      skills: ["google-news-search-skill"],
    };
    expect((await call("web_search", { query: "반도체" }, scoped)).out).toMatchObject({
      provider: "google-news",
    });
    // The server switch off: nobody.
    svc.setServerEnabled("search-google", false);
    expect(svc.toolNamesFor(f.mom.id)).not.toContain("skill_search-google");
    expect((await call("web_search", { query: "반도체" })).out).toMatchObject({ provider: "google-news" });
    expect(calls.map((c) => c.name)).toEqual(Array(3).fill("google-news-search-skill"));
    svc.setServerEnabled("search-google", true);
    expect((await call("web_search", { query: "반도체" })).out).toMatchObject({ provider: "google" });
  });

  it("at most 5 calls per run, tool and provider together; then skill_quota / the next provider; a new run starts over", async () => {
    const { call, calls, scope } = setup();
    for (let i = 0; i < 3; i++)
      expect((await call("skill_search-google", { query: `q${i}` })).isError).toBe(false);
    for (let i = 0; i < 2; i++)
      expect((await call("web_search", { query: `w${i}` })).out).toMatchObject({ provider: "google" });
    expect((await call("skill_search-google", { query: "more" })).out).toEqual({ error: "skill_quota" });
    expect((await call("web_search", { query: "more" })).out).toMatchObject({ provider: "google-news" });
    expect(calls.filter((c) => c.name === "search-google")).toHaveLength(5);
    // Refused calls are not counted for anyone else: a new run has its 5 again.
    const next = { ...scope, runId: crypto.randomUUID() };
    expect((await call("web_search", { query: "again" }, next)).out).toMatchObject({ provider: "google" });
    expect(SKILL_CODES.has("skill_quota")).toBe(true);
  });

  it("a failed search falls back; a send the gate refused does not (no other provider gets that query)", async () => {
    let code = "skill_timeout";
    const { call, calls } = setup({ result: (name) => (name === "search-google" ? code : undefined) });
    expect((await call("web_search", { query: "반도체" })).out).toMatchObject({ provider: "google-news" });
    code = SKILL_SECRET_BLOCKED;
    calls.length = 0;
    expect((await call("web_search", { query: "반도체" })).out).toEqual({ error: "web_search_unavailable" });
    expect(calls.map((c) => c.name)).toEqual(["search-google"]);
  });

  it("citations: the tool is a web tool (its answer gets the citation check, like google-news)", () => {
    expect(isWebTool("mcp__agentlee__skill_search-google")).toBe(true);
    expect(isWebTool("skill_search-google")).toBe(true);
  });

  it("config: SERPER_API_KEY is a skill secret read from .env; WEB_SEARCH_PROVIDERS accepts google", () => {
    expect(SKILL_SECRET_NAMES).toContain("SERPER_API_KEY");
    expect(loadConfig({ NODE_ENV: "test", SERPER_API_KEY: KEY }).skillSecrets).toEqual({
      SERPER_API_KEY: KEY,
    });
    expect(() => loadConfig({ NODE_ENV: "test", SERPER_API_KEY: "has space x" })).toThrow(/SERPER_API_KEY/);
    expect(loadConfig({ NODE_ENV: "test", WEB_SEARCH_PROVIDERS: "google" }).webSearchProviders).toEqual([
      "google",
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------

/** A python on this machine (the boot is standard library only), for the real-boot tests. */
const PYTHON = [
  process.env.TEST_SKILL_PYTHON,
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3",
  "/usr/bin/python3",
].find((p): p is string => !!p && fs.existsSync(p));

/** serper_search.py's `call`, reduced (CI has no admin skill folder): POST JSON, key in X-API-KEY. */
const PROBE = `
import json, os, sys, urllib.error, urllib.request
base, q = sys.argv[1:3]
req = urllib.request.Request(base + "/search", data=json.dumps({"q": q, "gl": "kr"}).encode(),
    headers={"X-API-KEY": os.environ["SERPER_API_KEY"], "Content-Type": "application/json"}, method="POST")
try:
    with urllib.request.urlopen(req, timeout=5) as r:
        print(json.dumps({"ok": True, "body": r.read().decode()}))
except urllib.error.HTTPError as e:
    print(json.dumps({"ok": False, "http": e.code})); sys.exit(1)
except urllib.error.URLError as e:
    print(json.dumps({"ok": False, "url_error": str(e.reason)})); sys.exit(1)
`;

/** The admin's real script, when this machine has it (~/.claude/skills or ~/.agents/skills) — read only. */
const REAL_SCRIPT = (() => {
  const dir = findSource("search-google", [
    path.join(os.homedir(), ".agents", "skills"),
    path.join(os.homedir(), ".claude", "skills"),
  ]);
  const f = dir && path.join(dir, "scripts", "serper_search.py");
  return f && fs.existsSync(f) ? f : undefined;
})();

describe.skipIf(!PYTHON)("the real boot: a Serper-style POST through the gate (local mock server)", () => {
  let server: http.Server;
  let base: string;
  let dir: string;
  const seen: { url: string; key: string | undefined; body: string }[] = [];
  /** What the mock answers /search with; /resolve answers `resolved` (or the same links when null). */
  let organic: { title: string; link: string }[] = [];
  let resolved: string | null = null;
  beforeEach(async () => {
    seen.length = 0;
    server = http.createServer((req, res) => {
      let b = "";
      req.on("data", (d: Buffer) => (b += d.toString()));
      req.on("end", () => {
        seen.push({ url: req.url ?? "", key: req.headers["x-api-key"] as string | undefined, body: b });
        if (req.headers["x-api-key"] !== KEY)
          return res.writeHead(403).end(JSON.stringify({ message: "Unauthorized.", statusCode: 403 }));
        if (req.url === "/resolve") {
          const got = JSON.parse(b) as { organic: { title: string; link: string }[] };
          if (resolved !== null)
            got.organic = got.organic.map((o) =>
              o.link.includes("goto?url=") ? { ...o, link: resolved! } : o,
            );
          return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(got));
        }
        const q = (JSON.parse(b || "{}") as { q?: string }).q;
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ searchParameters: { q, type: "search" }, organic, credits: 1 }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "serper-gate-"));
    fs.writeFileSync(path.join(dir, "probe.py"), PROBE);
  });
  afterEach(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The skill as declared, on the mock's host. */
  const local = {
    hosts: ["127.0.0.1"],
    secrets: [{ env: "SERPER_API_KEY", place: { host: "127.0.0.1", header: "X-API-KEY" } }],
  };

  const run = (script: string, args: string[], gate: (line: string) => boolean) =>
    new Promise<{ code: number | null; out: string }>((resolve, reject) => {
      const child = spawn(PYTHON!, ["-I", "-S", "-B", "-c", SKILL_NET_BOOT, script, ...args], {
        env: { SERPER_API_KEY: KEY },
        stdio: ["pipe", "pipe", "pipe", "pipe"],
      });
      serveGate(child.stdio[3] as Duplex, gate, () => child.kill("SIGKILL"));
      let out = "";
      child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, out }));
      child.stdin!.end();
    });

  it("the key goes out in its header and the body as approved; the key in the body is refused before the body is sent", async () => {
    let g = skillSendGate(local, {}, ENV);
    const lines: string[] = [];
    const ok = await run(path.join(dir, "probe.py"), [base, "반도체"], (l) => (lines.push(l), g.approve(l)));
    expect(ok.code).toBe(0);
    expect(g.denied).toBe(false);
    // http.client sends the head and the body in two sends: both were asked for.
    expect(g.sends).toBe(2);
    expect(JSON.parse(lines[0]!).data).toMatch(
      /^POST \/search HTTP\/1\.1\r\n[\s\S]*\r\nX-api-key: test-serper-key-0000\r\n/i,
    );
    expect(JSON.parse(lines[1]!).data).toBe('{"q": "\\ubc18\\ub3c4\\uccb4", "gl": "kr"}');
    expect(seen).toEqual([{ url: "/search", key: KEY, body: '{"q": "\\ubc18\\ub3c4\\uccb4", "gl": "kr"}' }]);
    // The key as the query: the body carries it — refused, the server got nothing at all.
    seen.length = 0;
    g = skillSendGate(local, {}, ENV);
    const bad = await run(path.join(dir, "probe.py"), [base, KEY], (l) => g.approve(l));
    expect(bad.code).toBe(1);
    expect(g.denied).toBe(true);
    expect(seen).toEqual([]);
    // A known non-ASCII secret, which python writes as \\uXXXX escapes.
    g = skillSendGate(local, {}, ENV);
    expect((await run(path.join(dir, "probe.py"), [base, `x ${KOREAN}`], (l) => g.approve(l))).code).toBe(1);
    expect(seen).toEqual([]);
  });

  describe.skipIf(!REAL_SCRIPT)(
    "the admin's serper_search.py itself, pointed at the mock (read-only copy)",
    () => {
      /** A copy of the real script with Serper's base URL replaced by the mock's (the only change). */
      const script = () => {
        const src = fs.readFileSync(REAL_SCRIPT!, "utf8");
        expect(src).toContain("https://google.serper.dev");
        const f = path.join(dir, "serper_search.py");
        fs.writeFileSync(f, src.split("https://google.serper.dev").join(base));
        return f;
      };
      const args = (q: string) => SEARCH_GOOGLE_SKILL.args({ query: q })!;

      it("--raw prints JSON; a Google redirect is resolved through /resolve and the real link becomes the source", async () => {
        organic = [
          { title: "A", link: "https://a.example/1" },
          { title: "B", link: "https://www.google.com/goto?url=https%3A%2F%2Fb.example%2F2" },
        ];
        resolved = "https://b.example/2";
        const g = skillSendGate(local, {}, ENV);
        const r = await run(script(), args("반도체"), (l) => g.approve(l));
        expect(r.code).toBe(0);
        expect(g.denied).toBe(false);
        expect(seen.map((s) => [s.url, s.key])).toEqual([
          ["/search", KEY],
          ["/resolve", KEY],
        ]);
        expect(JSON.parse(seen[0]!.body)).toEqual({ q: "반도체", gl: "kr", hl: "ko" });
        const out: unknown = JSON.parse(r.out);
        expect(SEARCH_GOOGLE_SKILL.searchHits!(out).map((h) => h.hit.url)).toEqual([
          "https://a.example/1",
          "https://b.example/2",
        ]);
      });

      it("a redirect /resolve could not turn into a link stays out of the sources", async () => {
        organic = [
          { title: "A", link: "https://a.example/1" },
          { title: "B", link: "https://www.google.com/goto?url=https%3A%2F%2Fb.example%2F2" },
        ];
        resolved = null;
        const g = skillSendGate(local, {}, ENV);
        const r = await run(script(), args("반도체"), (l) => g.approve(l));
        expect(r.code).toBe(0);
        expect(SEARCH_GOOGLE_SKILL.searchHits!(JSON.parse(r.out)).map((h) => h.hit.url)).toEqual([
          "https://a.example/1",
        ]);
      });

      it("the key in the query is refused at its body: Serper never gets the request", async () => {
        organic = [];
        const g = skillSendGate(local, {}, ENV);
        const r = await run(script(), args(`x ${KEY}`), (l) => g.approve(l));
        expect(g.denied).toBe(true);
        expect(r.code).toBe(1);
        expect(seen).toEqual([]);
      });
    },
  );
});

// ---------------------------------------------------------------------------------------------------------------

/**
 * A CONNECT proxy as the skill's egress proxy is (#174 review round 1 P1): it answers every CONNECT and pipes the
 * tunnel to the local mock (whatever host was asked for), recording the CONNECT lines.
 */
async function connectProxy(port: () => number) {
  const connects: string[] = [];
  const sockets = new Set<net.Socket>();
  const srv = net.createServer((c) => {
    sockets.add(c);
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      c.off("data", onData);
      connects.push(buf.subarray(0, buf.indexOf("\r\n")).toString());
      const up = net.connect(port(), "127.0.0.1", () => {
        c.write("HTTP/1.1 200 Connection established\r\n\r\n");
        const rest = buf.subarray(end + 4);
        if (rest.length) up.write(rest);
        c.pipe(up);
        up.pipe(c);
      });
      sockets.add(up);
      up.on("error", () => c.destroy());
    };
    c.on("data", onData);
    c.on("error", () => {});
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  return {
    connects,
    port: (srv.address() as net.AddressInfo).port,
    close: () => {
      for (const s of sockets) s.destroy();
      srv.close();
    },
  };
}

/** http.client through a proxy tunnel, as urllib drives it for HTTPS_PROXY (lazy connect inside the first send). */
const TUNNEL_PROBE = `
import http.client, json, os, sys
proxy_port, q = int(sys.argv[1]), sys.argv[2]
mode = sys.argv[3] if len(sys.argv) > 3 else ""
key = os.environ["SERPER_API_KEY"]
headers = {"X-API-KEY": key, "Content-Type": "application/json"}
if mode in ("fold", "tabfold"):
    # http.client accepts an obs-fold in a value (CRLF + SP/HTAB): the key rides in X-Debug's value.
    headers = {"X-Debug": "prefix\\r\\n" + (" " if mode == "fold" else "\\t") + "X-API-KEY: " + key, "Content-Type": "application/json"}
conn = http.client.HTTPConnection("127.0.0.1", proxy_port, timeout=5)
conn.set_tunnel("google.serper.dev", 443)
try:
    conn.request("POST", "/search", body=json.dumps({"q": q}).encode(), headers=headers)
    r = conn.getresponse()
    print(json.dumps({"ok": True, "status": r.status, "body": r.read().decode()}))
except OSError as e:
    print(json.dumps({"ok": False, "error": type(e).__name__})); sys.exit(1)
`;

describe.skipIf(!PYTHON)("through a CONNECT proxy, as in production (#174 review round 1 P1)", () => {
  const closers: (() => unknown)[] = [];
  afterEach(() => {
    while (closers.length) closers.pop()!();
  });
  const declared = {
    hosts: [HOST],
    secrets: [{ env: "SERPER_API_KEY", place: { host: HOST, header: "X-API-KEY" } }],
  };
  /** Runs a script under the boot with the gate on fd 3, recording every line the gate is asked. */
  const run = (args: string[], env: Record<string, string>, gate: ReturnType<typeof skillSendGate>) =>
    new Promise<{ code: number | null; out: string; asked: { host: string; data: string }[] }>(
      (resolve, reject) => {
        const asked: { host: string; data: string }[] = [];
        const child = spawn(PYTHON!, ["-I", "-S", "-B", "-c", SKILL_NET_BOOT, ...args], {
          env: { SERPER_API_KEY: KEY, ...env },
          stdio: ["pipe", "pipe", "pipe", "pipe"],
        });
        serveGate(
          child.stdio[3] as Duplex,
          (l) => (asked.push(JSON.parse(l) as { host: string; data: string }), gate.approve(l)),
          () => child.kill("SIGKILL"),
        );
        let out = "";
        child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, out, asked }));
        child.stdin!.end();
      },
    );
  /** The order the gate saw: CONNECT, then each request's head, then its body. */
  const order = (asked: { data: string }[]) =>
    asked.map((a) => (/^CONNECT /.test(a.data) ? "CONNECT" : /^POST /.test(a.data) ? "head" : "body"));

  it("the CONNECT is asked for before the head, never between the head and its body", async () => {
    const got: { host?: string; key?: string; body: string }[] = [];
    const mock = http.createServer((req, res) => {
      let b = "";
      req.on("data", (d: Buffer) => (b += d.toString()));
      req.on("end", () => {
        got.push({ host: req.headers.host, key: req.headers["x-api-key"] as string, body: b });
        res.writeHead(200).end('{"organic": []}');
      });
    });
    await new Promise<void>((r) => mock.listen(0, "127.0.0.1", () => r()));
    closers.push(() => mock.close());
    const proxy = await connectProxy(() => (mock.address() as net.AddressInfo).port);
    closers.push(proxy.close);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serper-tunnel-"));
    closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, "probe.py"), TUNNEL_PROBE);
    const g = skillSendGate(declared, {}, ENV);
    const r = await run([path.join(dir, "probe.py"), String(proxy.port), "반도체"], {}, g);
    expect(order(r.asked)).toEqual(["CONNECT", "head", "body"]);
    expect(r.asked.every((a) => a.host === HOST)).toBe(true);
    expect(g.denied).toBe(false);
    expect(JSON.parse(r.out)).toMatchObject({ ok: true, status: 200 });
    expect(proxy.connects).toEqual([`CONNECT ${HOST}:443 HTTP/1.1`]);
    expect(got).toEqual([{ host: `${HOST}:443`, key: KEY, body: '{"q": "\\ubc18\\ub3c4\\uccb4"}' }]);
    // The body check still holds through the tunnel: the key in the query never arrives.
    got.length = 0;
    const g2 = skillSendGate(declared, {}, ENV);
    const bad = await run([path.join(dir, "probe.py"), String(proxy.port), KEY], {}, g2);
    expect(order(bad.asked)).toEqual(["CONNECT", "head", "body"]);
    expect(g2.denied).toBe(true);
    expect(bad.code).toBe(1);
    expect(got).toEqual([]);
    // Review #174 round 2 repro: the key folded into another header's value, as http.client really sends it.
    for (const mode of ["fold", "tabfold"]) {
      const g3 = skillSendGate(declared, {}, ENV);
      const folded = await run([path.join(dir, "probe.py"), String(proxy.port), "ok", mode], {}, g3);
      expect(order(folded.asked), mode).toEqual(["CONNECT", "head"]);
      expect(folded.asked[1]!.data, mode).toContain(
        `X-Debug: prefix\r\n${mode === "fold" ? " " : "\t"}X-API-KEY: ${KEY}\r\n`,
      );
      expect(g3.denied, mode).toBe(true);
      expect(folded.code, mode).toBe(1);
      expect(got, mode).toEqual([]);
    }
  });

  /** A CA and a google.serper.dev certificate it signed (openssl), so the unmodified script's TLS verifies. */
  const OPENSSL = (() => {
    try {
      execFileSync("openssl", ["version"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!REAL_SCRIPT || !OPENSSL)(
    "the admin's serper_search.py, unmodified: HTTPS_PROXY → CONNECT → TLS to google.serper.dev → /search and /resolve",
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "serper-tls-"));
      closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
      const o = (...a: string[]) => execFileSync("openssl", a, { cwd: dir, stdio: "ignore" });
      fs.writeFileSync(
        path.join(dir, "ca.cnf"),
        "[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=agentlee test CA\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n",
      );
      fs.writeFileSync(
        path.join(dir, "leaf.ext"),
        "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:google.serper.dev\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid\n",
      );
      o(
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        "ca.key",
        "-out",
        "ca.pem",
        "-days",
        "1",
        "-config",
        "ca.cnf",
      );
      o(
        "req",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        "leaf.key",
        "-out",
        "leaf.csr",
        "-subj",
        "/CN=google.serper.dev",
      );
      o(
        "x509",
        "-req",
        "-in",
        "leaf.csr",
        "-CA",
        "ca.pem",
        "-CAkey",
        "ca.key",
        "-CAcreateserial",
        "-out",
        "leaf.pem",
        "-days",
        "1",
        "-extfile",
        "leaf.ext",
      );
      const got: { url?: string; key?: string; body: string }[] = [];
      const mock = https.createServer(
        {
          key: fs.readFileSync(path.join(dir, "leaf.key")),
          cert: fs.readFileSync(path.join(dir, "leaf.pem")),
        },
        (req, res) => {
          let b = "";
          req.on("data", (d: Buffer) => (b += d.toString()));
          req.on("end", () => {
            got.push({ url: req.url, key: req.headers["x-api-key"] as string, body: b });
            const parsed = JSON.parse(b || "{}") as Record<string, unknown>;
            const answer =
              req.url === "/resolve"
                ? { ...parsed, organic: [{ title: "B", link: "https://b.example/2" }] }
                : {
                    searchParameters: { q: parsed.q },
                    organic: [
                      { title: "B", link: "https://www.google.com/goto?url=https%3A%2F%2Fb.example%2F2" },
                    ],
                    credits: 1,
                  };
            res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(answer));
          });
        },
      );
      await new Promise<void>((r) => mock.listen(0, "127.0.0.1", () => r()));
      closers.push(() => mock.close());
      const proxy = await connectProxy(() => (mock.address() as net.AddressInfo).port);
      closers.push(proxy.close);
      const g = skillSendGate(SEARCH_GOOGLE_SKILL, { query: "반도체" }, ENV);
      // As skillPolicy runs it (minus the sandbox): the pinned script, its arguments, HTTPS_PROXY, a CA file.
      const r = await run(
        [REAL_SCRIPT!, ...SEARCH_GOOGLE_SKILL.args({ query: "반도체" })!],
        {
          HTTPS_PROXY: `http://127.0.0.1:${proxy.port}`,
          https_proxy: `http://127.0.0.1:${proxy.port}`,
          SSL_CERT_FILE: path.join(dir, "ca.pem"),
          LANG: "en_US.UTF-8",
          LC_ALL: "en_US.UTF-8",
        },
        g,
      );
      expect(g.denied).toBe(false);
      expect(r.code).toBe(0);
      expect(order(r.asked)).toEqual(["CONNECT", "head", "body", "CONNECT", "head", "body"]);
      expect(proxy.connects).toEqual([`CONNECT ${HOST}:443 HTTP/1.1`, `CONNECT ${HOST}:443 HTTP/1.1`]);
      expect(got.map((x) => [x.url, x.key])).toEqual([
        ["/search", KEY],
        ["/resolve", KEY],
      ]);
      expect(SEARCH_GOOGLE_SKILL.searchHits!(JSON.parse(r.out)).map((h) => h.hit.url)).toEqual([
        "https://b.example/2",
      ]);
    },
    30_000,
  );
});
