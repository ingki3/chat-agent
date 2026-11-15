import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOGLE_NEWS_SKILL, SELFTEST_SKILL } from "@agentlee/mcp-tools/skills";
import { UserStore } from "../src/auth/users.js";
import { ConversationStore } from "../src/conversations/store.js";
import { createTestDb } from "../src/db/client.js";
import { FINANCE_TOOLS } from "@agentlee/mcp-tools/finance";
import { carriesKnownSecret, FINANCE_CALL_MS, FinanceService } from "../src/finance/service.js";
import { serveGate } from "../src/isolation/sandbox.js";
import { McpTokens } from "../src/isolation/tokens.js";
import { sanitizeRecord } from "../src/logging.js";
import { McpService, SKILL_NET_BOOT, skillPolicy } from "../src/mcp/service.js";
import type { SkillResult } from "@agentlee/mcp-tools";
import { carriesSecret, EGRESS_WINDOW, SEARCH_DECOY } from "../src/secrets/egress.js";
import { knownSecrets } from "../src/secrets/known.js";
import {
  blockedByEgress,
  duckDuckGoProvider,
  guardWorker,
  WebService,
  type SearchProvider,
  type WebWorker,
  type WorkerJob,
} from "../src/web/service.js";
import { SourceStore } from "../src/web/sources.js";
import { callOurTool } from "./helpers/live-mcp.js";
import { startWebFixture, TEST_CA, type WebFixture } from "./helpers/web-fixture.js";
import { run as runWorker } from "../../../packages/mcp-tools/web/worker.mjs";

/**
 * The web tools' egress guard (#113): no web_search / web_fetch request — URL (host, path, query, fragment), a
 * search query, a raw step's headers, any redirect hop — carries a known secret, whole or as a 16-character window,
 * raw or in one common encoding (optionally inside one transport layer). Synthetic secrets only.
 */

/** Mixed-case token, an all-lowercase hex key (fits a host name raw), a short gate-like code, a non-ASCII value. */
const TOKEN = "synthEgress9Qw3Zx7Lp2Vn5Kt8Rb4Hm6Jc1";
const HEXKEY = "a3f9c2e17b4d8a60e5f1c9b2d7a4e3f8";
const SHORT = "GATEXY7731";
const KOREAN = "합성비밀값-SYNTHETIC-7d3f9a-끝";
const SECRETS = [TOKEN, HEXKEY, SHORT, KOREAN];

/** What is sent: each whole secret, and a 16-character window from the middle of each long one. */
const PAYLOADS: Record<string, string> = {
  "token whole": TOKEN,
  "token window": TOKEN.slice(10, 10 + EGRESS_WINDOW),
  "hex key whole": HEXKEY,
  "hex key window": HEXKEY.slice(7, 7 + EGRESS_WINDOW),
  "short whole": SHORT,
  "korean whole": KOREAN,
  "korean window": KOREAN.slice(3, 3 + EGRESS_WINDOW),
};

const utf8 = (s: string) => [...Buffer.from(s, "utf8")];
const cps = (s: string) => [...s].map((c) => c.codePointAt(0)!);
const units = (s: string) => Array.from({ length: s.length }, (_, i) => s.charCodeAt(i));
const h2 = (n: number) => n.toString(16).padStart(2, "0");

/** One encoding each. */
const ENCODINGS: Record<string, (s: string) => string> = {
  raw: (s) => s,
  percent: (s) => encodeURIComponent(s),
  "percent every byte": (s) =>
    utf8(s)
      .map((b) => `%${h2(b).toUpperCase()}`)
      .join(""),
  "json \\uXXXX": (s) =>
    units(s)
      .map((u) => `\\u${u.toString(16).padStart(4, "0")}`)
      .join(""),
  "js \\u{X}": (s) =>
    cps(s)
      .map((c) => `\\u{${c.toString(16)}}`)
      .join(""),
  "python \\xHH bytes": (s) =>
    utf8(s)
      .map((b) => `\\x${h2(b)}`)
      .join(""),
  "python \\U": (s) =>
    cps(s)
      .map((c) => `\\U${c.toString(16).padStart(8, "0")}`)
      .join(""),
  octal: (s) =>
    utf8(s)
      .map((b) => `\\${b.toString(8)}`)
      .join(""),
  base64: (s) => Buffer.from(s).toString("base64"),
  base64url: (s) => Buffer.from(s).toString("base64url"),
  "base64 misaligned in a run": (s) => `zz${Buffer.from(s).toString("base64").replace(/=+$/, "")}`,
  hex: (s) => Buffer.from(s).toString("hex"),
  HEX: (s) => Buffer.from(s).toString("hex").toUpperCase(),
  // One encoding inside one transport layer.
  "percent(base64)": (s) => encodeURIComponent(Buffer.from(s).toString("base64")),
  "percent(json \\uXXXX)": (s) =>
    encodeURIComponent(
      units(s)
        .map((u) => `\\u${u.toString(16).padStart(4, "0")}`)
        .join(""),
    ),
  "percent every byte(hex)": (s) =>
    utf8(Buffer.from(s).toString("hex"))
      .map((b) => `%${h2(b)}`)
      .join(""),
  "json string(python \\xHH)": (s) =>
    JSON.stringify(
      utf8(s)
        .map((b) => `\\x${h2(b)}`)
        .join(""),
    ).slice(1, -1),
  "json string(octal)": (s) =>
    JSON.stringify(
      utf8(s)
        .map((b) => `\\${b.toString(8)}`)
        .join(""),
    ).slice(1, -1),
};

/** Where in a page URL the payload goes (`e` is already encoded). */
const PARTS: Record<string, (e: string) => string> = {
  query: (e) => `http://news.test/search?q=${e}&lang=ko`,
  path: (e) => `http://news.test/a/${e}/b`,
  fragment: (e) => `http://news.test/page#${e}`,
};
/** A host label carries only lowercase letters, digits and hyphens: the hex key raw, and any secret as hex. */
const HOST_CASES: Record<string, string> = {
  "hex key raw": HEXKEY,
  "hex key window raw": HEXKEY.slice(5, 5 + EGRESS_WINDOW),
  "token window as hex": Buffer.from(TOKEN.slice(4, 4 + EGRESS_WINDOW)).toString("hex"),
  "short as hex": Buffer.from(SHORT).toString("hex"),
};

/** Ordinary requests that must go out unchanged while all the secrets above are registered. */
const ORDINARY = [
  "http://public.test/article.html",
  "http://news.test/search?q=%EB%B0%98%EB%8F%84%EC%B2%B4%20%EC%88%98%EC%B6%9C&page=2",
  `http://news.test/x/${Buffer.from("ordinary text that is not a secret at all").toString("base64")}`,
  `http://news.test/x?h=${Buffer.from("another ordinary sentence").toString("hex")}`,
  // 15 characters of a secret: below the window.
  `http://news.test/x?q=${TOKEN.slice(10, 25)}`,
  `http://news.test/x?q=${Buffer.from(TOKEN.slice(10, 25)).toString("base64")}`,
  // The secret with every 8th character changed: no 16 characters of it left in a row.
  `http://news.test/x?q=${TOKEN.replace(/./g, (c, i) => (i % 8 === 7 ? "_" : c))}`,
  "http://news.test/u0041/x41/101/a\\b?q=\\u0041\\x41#frag",
  "http://a3f9c2e1.news.test/",
];
const ORDINARY_QUERIES = [
  "반도체 수출 전망 2026",
  "weather seoul tomorrow",
  "GATE 7731 XY",
  "synthEgress9Qw3 Zx7Lp2Vn5Kt8Rb4", // 15 + 15 characters, not 16 in a row
  Buffer.from("plain words").toString("base64"),
];

let fx: WebFixture;
beforeEach(async () => {
  for (const s of SECRETS) knownSecrets.add(s, { fresh: true });
  fx = await startWebFixture();
});
afterEach(async () => {
  for (const s of SECRETS) knownSecrets.remove(s);
  await fx.close();
  expect(fx.leaks).toEqual([]);
});

function scope() {
  const db = createTestDb();
  const users = new UserStore(db);
  const mom = users.create({ email: "mom@example.com", name: "엄마", role: "member", passwordHash: "x" });
  const c = new ConversationStore(db).create(mom.id);
  return {
    users,
    sources: new SourceStore(db),
    scope: { userId: mom.id, conversationId: c.id, runId: crypto.randomUUID() },
  };
}

/** A WebService on the fixture whose worker jobs are recorded. */
function web(f: ReturnType<typeof scope>, o: { providers?: SearchProvider[]; worker?: WebWorker } = {}) {
  const jobs: WorkerJob[] = [];
  const inner = o.worker ?? fx.worker;
  const svc = new WebService({
    sources: f.sources,
    providers: o.providers ?? [],
    worker: async (job, p) => (jobs.push(job), inner(job, p)),
    fetchProxy: { endpoint: async () => fx.proxy, close: async () => {} },
  });
  return { svc, jobs };
}

/** Every window of every secret (all of a short one). */
const WINDOWS = SECRETS.flatMap((s) => {
  const w = Math.min(EGRESS_WINDOW, s.length);
  return Array.from({ length: s.length - w + 1 }, (_, i) => s.slice(i, i + w));
});

/**
 * Views of a text decoded here, independently of the guard's own `decodedViews` (review #127 round 1: a capture
 * check must not share the guard's blind spots): lenient percent and JSON-escape decoding, and every base64 / hex run
 * (whitespace removed) at every alignment.
 */
function independentViews(text: string): string[] {
  const out = new Set([text]);
  const layers = [text];
  try {
    layers.push(decodeURIComponent(text));
  } catch {
    layers.push(text.replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16))));
  }
  try {
    layers.push(JSON.parse(`"${text.replace(/"/g, '\\"')}"`) as string);
  } catch {
    // not one JSON string
  }
  for (const layer of layers) {
    out.add(layer);
    const solid = layer.replace(/\s+/g, "");
    for (const [run] of solid.matchAll(/[A-Za-z0-9+/_-]{8,}/g))
      for (let k = 0; k < 4; k++) {
        const b = Buffer.from(run.slice(k).replace(/-/g, "+").replace(/_/g, "/"), "base64");
        out.add(b.toString("utf8")).add(b.toString("latin1"));
      }
    for (const [run] of solid.matchAll(/[0-9a-f]{8,}/gi))
      for (let k = 0; k < 2; k++) {
        const b = Buffer.from(run.slice(k, run.length - ((run.length - k) % 2)), "hex");
        out.add(b.toString("utf8")).add(b.toString("latin1"));
      }
  }
  return [...out];
}

/** Nothing of any secret in any recorded job: no window in any independent view, and no encoded form of one. */
function expectClean(jobs: unknown[]) {
  const text = JSON.stringify(jobs);
  const leaves: string[] = [];
  const walk = (x: unknown): void => {
    if (typeof x === "string") leaves.push(x);
    else if (x && typeof x === "object") for (const v of Object.values(x)) walk(v);
  };
  walk(jobs);
  const views = [...independentViews(text), ...leaves.flatMap(independentViews)];
  for (const view of views) for (const w of WINDOWS) expect(view).not.toContain(w);
  for (const w of WINDOWS)
    for (const [name, enc] of Object.entries(ENCODINGS))
      if (name !== "base64 misaligned in a run") expect(text, name).not.toContain(enc(w));
}

/** The guard's refusal as the model sees it: an ordinary refused page; only the log knows why. */
function expectBlocked(r: SkillResult, msg: string) {
  expect(r, msg).toEqual({ ok: false, code: "web_blocked" });
  expect(blockedByEgress(r), msg).toBe(true);
}

const cases = Object.entries(PAYLOADS).flatMap(([p, payload]) =>
  Object.entries(ENCODINGS).map(([e, enc]) => ({ name: `${p} · ${e}`, encoded: enc(payload) })),
);

describe("the egress predicate (secrets/egress.ts)", () => {
  it("every secret in every encoding is found; ordinary text is not", () => {
    for (const c of cases) expect(carriesSecret([c.encoded]), c.name).toBe(true);
    for (const t of [...ORDINARY, ...ORDINARY_QUERIES]) expect(carriesSecret([t]), t).toBe(false);
  });

  it("a value registered later is found by the next check (the window cache follows the registry)", () => {
    const late = "lateRegisteredSynthetic0123456789";
    expect(carriesSecret([`x=${late.slice(3, 19)}`])).toBe(false);
    knownSecrets.add(late, { fresh: true });
    try {
      expect(carriesSecret([`x=${late.slice(3, 19)}`])).toBe(true);
    } finally {
      knownSecrets.remove(late);
    }
    expect(carriesSecret([`x=${late.slice(3, 19)}`])).toBe(false);
  });

  it("a JSON credential's structure is not a secret of its own; its secret strings are", () => {
    const cred = JSON.stringify({ access_token: "credSyntheticAccessTok3n99", token_type: "Bearer" });
    knownSecrets.addCredential(cred);
    try {
      expect(carriesSecret(['{"access_token":"x","token_type":"Bearer"}'])).toBe(false);
      expect(carriesSecret(["q=SyntheticAccessTok3n"])).toBe(true);
    } finally {
      knownSecrets.remove(cred);
      knownSecrets.remove("credSyntheticAccessTok3n99");
    }
  });

  it("finance uses the same predicate: a window of a registered secret in a finance header is refused", () => {
    const step = (v: string) => ({ url: "https://api.example.test/x", headers: { accept: v } });
    expect(carriesKnownSecret(step(Buffer.from(TOKEN.slice(2, 18)).toString("base64")), "us_quote")).toBe(
      true,
    );
    expect(carriesKnownSecret(step("application/json"), "us_quote")).toBe(false);
  });
});

describe("web_fetch: every part of every hop", () => {
  it("the first request: secret × encoding × part (query, path, fragment) never makes a job", async () => {
    const f = scope();
    const { svc, jobs } = web(f);
    for (const c of cases)
      for (const [part, at] of Object.entries(PARTS)) {
        const r = await svc.fetch({ url: at(c.encoded) }, f.scope);
        expectBlocked(r, `${c.name} in ${part}`);
      }
    expect(jobs).toEqual([]);
    expect(f.sources.list(f.scope.conversationId)).toEqual([]);
  });

  it("the host name", async () => {
    const f = scope();
    const { svc, jobs } = web(f);
    for (const [name, label] of Object.entries(HOST_CASES)) {
      const r = await svc.fetch({ url: `https://${label}.news.test/` }, f.scope);
      expectBlocked(r, name);
    }
    expect(jobs).toEqual([]);
    expect(fx.lookups.size).toBe(0);
  });

  it("redirect hops: a target only the site knows is checked before it is requested — first and second hop", async () => {
    const f = scope();
    const { svc, jobs } = web(f);
    let n = 0;
    for (const c of cases)
      for (const [part, at] of Object.entries(PARTS))
        for (const depth of [1, 2]) {
          const id = `h${n++}`;
          // A Location header is ASCII: a non-ASCII target goes as a browser would send it (UTF-8 percent-encoded).
          const raw = at(c.encoded);
          const target = /[^ -~]/.test(raw) ? encodeURI(raw) : raw;
          if (depth === 1) fx.redirects.set(`/${id}`, target);
          else {
            fx.redirects.set(`/${id}`, `http://news.test/${id}-next`);
            fx.redirects.set(`/${id}-next`, target);
          }
          const before = jobs.length;
          const r = await svc.fetch({ url: `http://public.test/${id}` }, f.scope);
          expectBlocked(r, `${c.name} in ${part}, hop ${depth}`);
          // One job per hop that went out; the hop carrying the secret is not one of them.
          expect(jobs.length - before, `${c.name} in ${part}, hop ${depth}`).toBe(depth);
        }
    expectClean(jobs);
    // The site saw only the hops before the secret one.
    for (const path of fx.seen.keys()) expect(path).toMatch(/^\/h\d+(-next)?$/);
  }, 60_000);

  it("a redirect to a secret in the host name is not even looked up", async () => {
    const f = scope();
    const { svc, jobs } = web(f);
    fx.redirects.set("/to-host", `http://${HEXKEY}.news.test/`);
    expectBlocked(await svc.fetch({ url: "http://public.test/to-host" }, f.scope), "host");
    expect(jobs).toHaveLength(1);
    expect([...fx.lookups.keys()]).toEqual(["public.test"]);
  });

  it("negative controls: ordinary pages and redirects work with every secret registered", async () => {
    const f = scope();
    const { svc, jobs } = web(f);
    const r = await svc.fetch({ url: "http://public.test/article.html" }, f.scope);
    expect(r.ok).toBe(true);
    fx.redirects.set("/ordinary", "http://news.test/to-article");
    const r2 = await svc.fetch({ url: "http://public.test/ordinary" }, f.scope);
    expect(r2).toMatchObject({ ok: true, output: { finalUrl: "http://news.test/article.html" } });
    expect(jobs.map((j) => (j as { url: string }).url)).toEqual([
      "http://public.test/article.html",
      "http://public.test/ordinary",
      "http://news.test/to-article",
      "http://news.test/article.html",
    ]);
    // Ordinary URLs reach the worker (they may then fail upstream — never with the guard's code).
    const seen: string[] = [];
    const { svc: probe } = web(f, {
      worker: async (job) => (
        seen.push((job as { url: string }).url),
        { ok: false, code: "web_unreachable" }
      ),
    });
    for (const u of ORDINARY) {
      const out = await probe.fetch({ url: u }, f.scope);
      expect(out, u).toEqual({ ok: false, code: "web_unreachable" });
      expect(blockedByEgress(out), u).toBe(false);
    }
    expect(seen).toHaveLength(ORDINARY.length);
  });

  it("redirect limits and checks still hold when the server follows the hops", async () => {
    const f = scope();
    const { svc } = web(f);
    expect(await svc.fetch({ url: "http://public.test/loop" }, f.scope)).toEqual({
      ok: false,
      code: "web_too_many_redirects",
    });
    expect(await svc.fetch({ url: "http://public.test/to-localhost" }, f.scope)).toEqual({
      ok: false,
      code: "web_blocked",
    });
    expect(await svc.fetch({ url: "http://public.test/to-file" }, f.scope)).toEqual({
      ok: false,
      code: "web_bad_url",
    });
    expect(fx.leaks).toEqual([]);
  });
});

describe("web_search: the query and the provider request", () => {
  const queries = cases.map((c) => c.encoded);

  it("no provider (ours or a skill) gets a query that carries a secret: the decoy takes the ordinary path", async () => {
    const f = scope();
    const asked: string[] = [];
    const provider: SearchProvider = {
      name: "spy",
      search: async (q) => (
        asked.push(q),
        { ok: true, hits: [{ url: "https://news.test/a", title: "decoy hit, never shown" }] }
      ),
    };
    const { svc, jobs } = web(f, { providers: [provider, provider] });
    for (const [i, q] of queries.entries()) {
      const r = await svc.search({ query: q }, f.scope);
      // An ordinary empty answer for the model's own query: the same shape as a search that found nothing.
      expect(r, cases[i]!.name).toMatchObject({
        ok: true,
        output: { provider: "spy", query: q, results: [] },
      });
      expect(blockedByEgress(r), cases[i]!.name).toBe(true);
    }
    expect(asked).toEqual(queries.map(() => SEARCH_DECOY));
    expect(jobs).toEqual([]);
    expect(f.sources.list(f.scope.conversationId)).toEqual([]);
    expectClean(asked);
    for (const q of ORDINARY_QUERIES) {
      const r = await svc.search({ query: q }, f.scope);
      expect(r.ok, q).toBe(true);
      expect(blockedByEgress(r), q).toBe(false);
    }
    expect(asked.slice(queries.length)).toEqual(ORDINARY_QUERIES);
  });

  it("the decoy shares the ordinary failures: every provider failing gives the ordinary code", async () => {
    const f = scope();
    const failing: SearchProvider = {
      name: "down",
      search: async () => ({ ok: false, code: "web_unreachable" }),
    };
    const { svc } = web(f, { providers: [failing] });
    const blocked = await svc.search({ query: TOKEN }, f.scope);
    const ordinary = await svc.search({ query: "x".repeat(TOKEN.length) }, f.scope);
    expect(blocked).toEqual(ordinary);
    expect(blockedByEgress(blocked)).toBe(true);
  });

  it("the DuckDuckGo provider's own job is guarded too (its URL is checked, not only the query)", async () => {
    const jobs: WorkerJob[] = [];
    const ddg = duckDuckGoProvider(async (job) => (jobs.push(job), { ok: true, results: [] }), {
      endpoint: async () => fx.proxy,
      close: async () => {},
    });
    const f = scope();
    for (const [i, q] of queries.entries())
      expect(await ddg.search(q, 5, f.scope), cases[i]!.name).toEqual({
        ok: false,
        code: "web_secret_blocked",
      });
    expect(jobs).toEqual([]);
    expect(await ddg.search("반도체 수출", 5, f.scope)).toEqual({ ok: true, hits: [] });
    expect(jobs).toHaveLength(1);
  });

  it("guardWorker covers a raw job's headers", async () => {
    let ran = 0;
    const w = guardWorker(async () => (ran++, { ok: true }));
    const job = (accept: string): WorkerJob => ({
      op: "raw",
      steps: [{ url: "https://api.example.test/", headers: { accept } }],
    });
    for (const c of cases)
      expect(await w(job(c.encoded), { url: "http://127.0.0.1:9", port: 9 }), c.name).toEqual({
        ok: false,
        code: "web_secret_blocked",
      });
    expect(ran).toBe(0);
    expect(await w(job("application/json"), { url: "http://127.0.0.1:9", port: 9 })).toEqual({ ok: true });
    expect(ran).toBe(1);
  });
});

describe("on our MCP server: an ordinary answer, nothing echoed, the reason only in the log", () => {
  it("web_fetch and web_search", async () => {
    const f = scope();
    const tokens = new McpTokens();
    const logs: Record<string, unknown>[] = [];
    const log = {
      info: (o: Record<string, unknown>, msg: string) => logs.push({ ...o, msg }),
      warn: (o: Record<string, unknown>, msg: string) => logs.push({ ...o, msg }),
      error: (o: Record<string, unknown>, msg: string) => logs.push({ ...o, msg }),
    };
    const asked: string[] = [];
    const svc = new McpService(tokens, f.users, {
      skills: [SELFTEST_SKILL],
      python: { exe: "/opt/py/bin/python3.12", root: "/opt/py" },
      log: log as never,
      web: {
        sources: f.sources,
        worker: fx.worker,
        fetchProxy: { endpoint: async () => fx.proxy, close: async () => {} },
        searchProviders: [{ name: "spy", search: async (q) => (asked.push(q), { ok: true, hits: [] }) }],
      },
    });
    try {
      const { url } = await svc.endpoint();
      const call = async (tool: string, args: unknown) => {
        const r = await callOurTool(url, tokens.issue(f.scope), tool, args);
        return { isError: r.isError, text: r.content[0]?.text ?? "" };
      };
      const window = TOKEN.slice(8, 24);
      const fetched = await call("web_fetch", {
        url: `http://news.test/x?k=${Buffer.from(window).toString("base64")}`,
      });
      const searched = await call("web_search", { query: `find ${window} please` });
      // The model sees an ordinary refusal and an ordinary empty search — never which value matched.
      expect(fetched.isError).toBe(true);
      expect(JSON.parse(fetched.text)).toEqual({ error: "web_blocked" });
      expect(searched.isError).toBe(false);
      expect(JSON.parse(searched.text)).toMatchObject({ results: [] });
      expect(searched.text).not.toContain("web_secret_blocked");
      expect(asked).toEqual([SEARCH_DECOY]);
      expect(fx.lookups.size).toBe(0);
      const line = JSON.stringify(logs.map((l) => sanitizeRecord(l)));
      expect(line.match(/"webCode":"web_secret_blocked"/g)).toHaveLength(2);
      expect(line).not.toContain(window);
      expect(line).not.toContain(Buffer.from(window).toString("base64"));
      expect(line).not.toMatch(/news\.test|find|please/);
    } finally {
      await svc.close();
    }
  });
});

describe("review #127 round 1: encodings, registration and hops the first version missed", () => {
  const W = TOKEN.slice(10, 10 + EGRESS_WINDOW);

  it("base64 / hex broken by spaces or lines (MIME 76 columns, CRLF) — a window across a line too", async () => {
    const spaced = (t: string) => t.replace(/(.{4})/g, "$1 ").trim();
    const mime = (t: string) => t.replace(/(.{76})/g, "$1\r\n");
    const b64 = Buffer.from(W).toString("base64");
    const hex = Buffer.from(W).toString("hex");
    // A long body whose window of the token straddles the first line break (offset chosen so it does).
    const long = Buffer.from(`${"x".repeat(51)}${TOKEN}${"y".repeat(60)}`).toString("base64");
    expect(mime(long).split("\r\n")[0]!.length).toBe(76);
    const texts = [
      spaced(b64),
      spaced(hex),
      hex.replace(/(..)/g, "$1 "),
      mime(long),
      mime(long).replace(/\r/g, ""),
    ];
    for (const t of texts) {
      expect(carriesSecret([t]), JSON.stringify(t)).toBe(true);
      // Inside one transport layer as it would sit in a URL or a JSON body.
      expect(carriesSecret([`https://news.test/x?b=${encodeURIComponent(t)}`]), t).toBe(true);
      expect(carriesSecret([JSON.stringify(t).slice(1, -1)]), t).toBe(true);
    }
    const f = scope();
    const { svc, jobs } = web(f);
    for (const t of texts)
      expectBlocked(await svc.fetch({ url: `http://news.test/x?b=${encodeURIComponent(t)}` }, f.scope), t);
    expect(jobs).toEqual([]);
    // Ordinary spaced base64 / hex still goes.
    expect(carriesSecret([spaced(Buffer.from("plain words of no account").toString("base64"))])).toBe(false);
  });

  it("a plain secret that starts with [ or { is windowed; only an addCredential JSON document is not", () => {
    const bracket = "[not-json-synthBracketSecret0123456789]";
    const brace = "{also-not-json-synthBraceSecret987654}";
    knownSecrets.add(bracket, { fresh: true });
    knownSecrets.addCredential(brace); // not JSON: a secret string like any other
    try {
      expect(carriesSecret([`q=${bracket.slice(10, 26)}`])).toBe(true);
      expect(carriesSecret([`q=${brace.slice(14, 30)}`])).toBe(true);
    } finally {
      knownSecrets.remove(bracket);
      knownSecrets.remove(brace);
    }
  });

  it("a long secret (registered in pieces) is windowed across the piece boundaries", () => {
    const long = crypto.randomBytes(24_576).toString("base64url"); // 32,768 characters: two matcher pieces
    expect(long.length).toBe(32_768);
    knownSecrets.add(long, { fresh: true });
    try {
      for (const at of [16_376, 16_368, 16_383, 0, 32_752])
        expect(carriesSecret([`q=${long.slice(at, at + EGRESS_WINDOW)}`]), String(at)).toBe(true);
    } finally {
      knownSecrets.remove(long);
    }
    expect(carriesSecret([`q=${long.slice(16_376, 16_392)}`])).toBe(false);
  });

  it("a configured value too short for the run decoders is matched as base64 / hex all the same", () => {
    for (const v of ["k", "Q9z", "ab3Xy", "7Hq2vW1"]) {
      const b = Buffer.from(v);
      const forms = [
        b.toString("base64"),
        b.toString("base64").replace(/=+$/, ""),
        b.toString("base64url"),
        b.toString("hex"),
        b.toString("hex").toUpperCase(),
        encodeURIComponent(b.toString("base64")),
      ];
      for (const t of forms) {
        expect(carriesSecret([`https://h.test/p?x=${t}`], { config: [v] }), `${v} ${t}`).toBe(true);
        expect(carriesSecret([`https://h.test/p?x=${t}`]), `${v} ${t} unconfigured`).toBe(false);
      }
    }
  });

  it("a registered JWT is matched whole and by windows of its payload and signature — not by its public header", () => {
    const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const header = b64u({ alg: "HS256", typ: "JWT" });
    const mine = `${header}.${b64u({ sub: "synthetic-user-4417", n: "a8Kq2" })}.${crypto.randomBytes(32).toString("base64url")}`;
    const other = `${header}.${b64u({ sub: "someone-else", n: 1 })}.${crypto.randomBytes(32).toString("base64url")}`;
    knownSecrets.add(mine, { fresh: true });
    try {
      expect(carriesSecret([`https://jwt.example.test/?token=${other}`])).toBe(false);
      // Its public header at the very end of a request is not a cut-off secret (review #127 round 2: no tail rule).
      expect(carriesSecret([`https://docs.test/?header=${header}`])).toBe(false);
      expect(carriesSecret([`https://docs.test/?q=${header.slice(0, 8)}`])).toBe(false);
      expect(carriesSecret([`https://docs.test/?header=${header}.`])).toBe(false);
      expect(carriesSecret([`https://jwt.example.test/?token=${mine}`])).toBe(true);
      const sig = mine.split(".")[2]!;
      expect(carriesSecret([`q=${sig.slice(5, 21)}`])).toBe(true);
      const payload = mine.split(".")[1]!;
      expect(carriesSecret([`q=${payload.slice(12, 28)}`])).toBe(true);
    } finally {
      knownSecrets.remove(mine);
    }
  });
});

describe("finance raw jobs: every request approved by the server in its wire form (review #127 rounds 1–2)", () => {
  const proxyFor = async () => fx.proxy;
  const tool = (n: string) => FINANCE_TOOLS.find((t) => t.name === n)!;
  const DART_KEY_VALUE = "0123456789abcdef0123456789abcdef01234567"; // synthetic, 40 hex like a real one
  /** The tools' real hosts played by the fixture: each one a path prefix of `public.test` (one TLS test name). */
  const HOSTS: Record<string, string> = {
    "fc.yahoo.com": "/__fc",
    "query1.finance.yahoo.com": "/__q1",
    "opendart.fss.or.kr": "/__dart",
    "ac.stock.naver.com": "/__ac",
  };
  const toFixture = (t: string) =>
    Object.entries(HOSTS).reduce(
      (acc, [h, pre]) =>
        acc
          .replaceAll(`https://${h}/`, `https://public.test${pre}/`)
          .replaceAll(`"host":"${h}"`, `"host":"public.test"`),
      t,
    );
  const fromFixture = (t: string) => {
    let out = t;
    for (const [h, pre] of Object.entries(HOSTS))
      out = out.replaceAll(`https://public.test${pre}/`, `https://${h}/`);
    return out;
  };
  type RawJob = Extract<WorkerJob, { op: "raw" }>;
  type Out = { ok: boolean; pause?: { request: { url: string; headers: Record<string, string> } } };

  /** The real worker (in-process, TLS fixture) behind the host mapping; every job and its answer recorded. */
  function realWorker() {
    const jobs: RawJob[] = [];
    const worker = async (job: RawJob) => {
      jobs.push(job);
      const out = (await runWorker(JSON.parse(toFixture(JSON.stringify(job))), {
        proxy: fx.proxy.url,
        ca: TEST_CA,
      })) as Out;
      const back = JSON.parse(fromFixture(JSON.stringify(out))) as Out;
      // The host header goes back to the real name too (the URL says which).
      if (back.pause) back.pause.request.headers.host = new URL(back.pause.request.url).host;
      return back as never;
    };
    return { jobs, worker };
  }
  const paths = () => [...fx.seen.keys()];

  it("normal flows: each request is approved, then sent exactly — cookie and crumb carried (Yahoo session)", async () => {
    fx.routes.set("/__fc/", { status: 404, headers: { "set-cookie": "A3=d=ordinary-session; Path=/" } });
    fx.routes.set("/__q1/v1/test/getcrumb", {
      headers: { "content-type": "text/plain" },
      body: "Crumb.Ordinary-1",
    });
    fx.routes.set("/__q1/v10/finance/quoteSummary/AAPL", {
      body: '{"quoteSummary":{"result":[],"error":null}}',
    });
    const { jobs, worker } = realWorker();
    const r = await new FinanceService(worker, proxyFor, {}).run(tool("us_company"), { symbol: "AAPL" });
    expect(r).not.toEqual({ ok: false, code: "finance_bad_input" });
    expect(r).not.toEqual({ ok: false, code: "finance_blocked" });
    expect(paths()).toEqual(["/__fc/", "/__q1/v1/test/getcrumb", "/__q1/v10/finance/quoteSummary/AAPL"]);
    const last = fx.seen.get("/__q1/v10/finance/quoteSummary/AAPL")!;
    expect(last.cookie).toBe("A3=d=ordinary-session");
    // Three sends, each approved first: one job to stop before each, the last one finishing.
    expect(jobs.map((j) => j.approve)).toEqual([true, true, true, true]);
    expect(jobs.slice(1).map((j) => j.resume?.approved.url)).toEqual([
      "https://fc.yahoo.com/",
      "https://query1.finance.yahoo.com/v1/test/getcrumb",
      expect.stringContaining("https://query1.finance.yahoo.com/v10/finance/quoteSummary/AAPL?") as never,
    ]);
    expect(jobs[3]!.resume!.approved.url).toContain("crumb=Crumb.Ordinary-1");
  });

  it("repro 3: a crumb from a response body or a cookie from Set-Cookie that is a secret never goes out", async () => {
    for (const [name, route] of Object.entries({
      "crumb from body": { headers: { "content-type": "text/plain" }, body: W16() },
      "Set-Cookie of an ordinary response": {
        headers: { "content-type": "text/plain", "set-cookie": `s=${TOKEN}; Path=/` },
        body: "Crumb.Ordinary-1",
      },
    })) {
      fx.seen.clear();
      fx.routes.set("/__fc/", { status: 404 });
      fx.routes.set("/__q1/v1/test/getcrumb", route);
      const { jobs, worker } = realWorker();
      expect(
        await new FinanceService(worker, proxyFor, {}).run(tool("us_company"), { symbol: "AAPL" }),
        name,
      ).toEqual({
        ok: false,
        code: "finance_bad_input",
      });
      expect(paths(), name).toEqual(["/__fc/", "/__q1/v1/test/getcrumb"]);
      expect(jobs, name).toHaveLength(3);
    }
  });

  it("repro 1: the DART key's allowed place is one exact occurrence — a second crtfc_key carrying a secret is refused", async () => {
    const secrets = { OPENDART_API_KEY: DART_KEY_VALUE };
    const base = "https://opendart.fss.or.kr/api/list.json";
    const d = tool("dart_disclosures");
    expect(
      carriesKnownSecret({ url: `${base}?crtfc_key=${DART_KEY_VALUE}&page_no=1` }, d.name, secrets),
    ).toBe(false);
    for (const extra of [TOKEN, W16(), DART_KEY_VALUE, Buffer.from(TOKEN).toString("base64")])
      expect(
        carriesKnownSecret(
          { url: `${base}?crtfc_key=${DART_KEY_VALUE}&crtfc_key=${extra}` },
          d.name,
          secrets,
        ),
        extra,
      ).toBe(true);
    // Through a redirect from the site, with the real worker.
    fx.redirects.set(
      "/__dart/api/list.json",
      `https://public.test/__dart/api/next.json?crtfc_key=${DART_KEY_VALUE}&crtfc_key=${TOKEN}`,
    );
    const { worker } = realWorker();
    expect(await new FinanceService(worker, proxyFor, { secrets }).run(d, {})).toEqual({
      ok: false,
      code: "finance_bad_input",
    });
    expect(paths()).toEqual(["/__dart/api/list.json"]);
  });

  it("repro 2: a redirect whose path carries \\uXXXX escapes (the parser turns \\ into /) is refused", async () => {
    const esc = [...W16()].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`).join("");
    fx.redirects.set("/__ac/ac", `https://public.test/__ac/x/${esc}`);
    const { worker } = realWorker();
    expect(await new FinanceService(worker, proxyFor, {}).run(tool("kr_search"), { query: "삼성" })).toEqual({
      ok: false,
      code: "finance_bad_input",
    });
    expect(paths()).toEqual(["/__ac/ac"]);
  });

  it("redirects: an ordinary one goes on with the session; a third one, another host or http is refused", async () => {
    fx.redirects.set("/__ac/ac", "https://public.test/__ac/ac2?q=1");
    fx.routes.set("/__ac/ac2", { headers: { "set-cookie": "n=1" }, body: '{"items":[]}' });
    const first = realWorker();
    const jobs = first.jobs;
    let worker = first.worker;
    expect(
      (await new FinanceService(worker, proxyFor, {}).run(tool("kr_search"), { query: "삼성" })).ok,
    ).toBe(true);
    expect(paths()).toEqual(["/__ac/ac", "/__ac/ac2"]);
    expect(jobs).toHaveLength(3);
    for (const [to, code] of [
      ["https://public.test/__ac/ac", "finance_blocked"], // a loop: the third redirect of one step
      ["https://evil.public.test/x", "finance_blocked"],
      ["http://public.test/__ac/ac2", "finance_blocked"],
    ] as const) {
      fx.seen.clear();
      fx.redirects.set("/__ac/ac", to);
      ({ worker } = realWorker());
      expect(
        await new FinanceService(worker, proxyFor, {}).run(tool("kr_search"), { query: "삼성" }),
        to,
      ).toEqual({
        ok: false,
        code,
      });
      expect(
        paths().every((p) => p === "/__ac/ac"),
        to,
      ).toBe(true);
    }
  });

  it("the worker sends only the request it was approved for", async () => {
    fx.routes.set("/raw-a", { body: "{}" });
    const step = { url: "https://public.test/raw-a" };
    const first = (await runWorker(
      { op: "raw", redirect: "manual", approve: true, steps: [step] },
      { proxy: fx.proxy.url, ca: TEST_CA },
    )) as { ok: boolean; pause: { reason: string; request: unknown } };
    expect(first).toMatchObject({ ok: true, pause: { reason: "send", step: 0 } });
    expect(fx.seen.has("/raw-a")).toBe(false);
    // An approval for another request: the worker stops again instead of sending.
    const other = { url: "https://public.test/raw-b", target: "/raw-b", headers: {} };
    const resume = { jar: [], vars: [], seen: [], literal: true };
    const again = (await runWorker(
      { op: "raw", redirect: "manual", approve: true, steps: [step], resume: { ...resume, approved: other } },
      { proxy: fx.proxy.url, ca: TEST_CA },
    )) as { ok: boolean; pause?: unknown };
    expect(again).toMatchObject({ ok: true, pause: { reason: "send" } });
    expect(fx.seen.has("/raw-a")).toBe(false);
    const sent = (await runWorker(
      {
        op: "raw",
        redirect: "manual",
        approve: true,
        steps: [step],
        resume: { ...resume, approved: first.pause.request },
      },
      { proxy: fx.proxy.url, ca: TEST_CA },
    )) as { ok: boolean; pause?: unknown; responses?: unknown[] };
    expect(sent).toMatchObject({ ok: true, responses: [{ status: 200 }] });
    expect(sent.pause).toBeUndefined();
    expect(fx.seen.has("/raw-a")).toBe(true);
  });
});

/** A 16-character window of the token. */
function W16() {
  return TOKEN.slice(10, 10 + EGRESS_WINDOW);
}

describe("review #127 round 3", () => {
  it("a Set-Cookie carrying a non-ASCII secret's UTF-8 bytes (a Latin-1 header string) never goes out", async () => {
    const S = "가나다라마바사아자차카타파하가나";
    knownSecrets.add(S, { fresh: true });
    try {
      const latin1 = Buffer.from(S, "utf8").toString("latin1");
      expect(carriesSecret([`sid=${latin1}`])).toBe(true);
      expect(carriesSecret([`sid=${Buffer.from("평범한 쿠키 값", "utf8").toString("latin1")}`])).toBe(false);
      // Through the real worker: the site sets it on the crumb answer; the next request would carry it.
      const tool = FINANCE_TOOLS.find((t) => t.name === "us_company")!;
      fx.routes.set("/__fc/", { status: 404 });
      fx.routes.set("/__q1/v1/test/getcrumb", {
        headers: { "content-type": "text/plain", "set-cookie": `sid=${latin1}; Path=/` },
        body: "Crumb.Ordinary-1",
      });
      const map = (t: string, from: string, to: string) => t.replaceAll(from, to);
      const worker = async (job: unknown) => {
        let j = JSON.stringify(job);
        j = map(j, "https://fc.yahoo.com/", "https://public.test/__fc/");
        j = map(j, "https://query1.finance.yahoo.com/", "https://public.test/__q1/");
        j = j.replace(/"host":"[^"]*"/g, '"host":"public.test"');
        const out = JSON.stringify(await runWorker(JSON.parse(j), { proxy: fx.proxy.url, ca: TEST_CA }));
        const back = JSON.parse(
          map(
            map(out, "https://public.test/__fc/", "https://fc.yahoo.com/"),
            "https://public.test/__q1/",
            "https://query1.finance.yahoo.com/",
          ),
        ) as { pause?: { request: { url: string; headers: Record<string, string> } } };
        if (back.pause) back.pause.request.headers.host = new URL(back.pause.request.url).host;
        return back as never;
      };
      const r = await new FinanceService(worker, async () => fx.proxy, {}).run(tool, { symbol: "AAPL" });
      expect(r).toEqual({ ok: false, code: "finance_bad_input" });
      expect([...fx.seen.keys()]).toEqual(["/__fc/", "/__q1/v1/test/getcrumb"]);
    } finally {
      knownSecrets.remove(S);
    }
  });

  it("a whole finance call shares one time budget across rounds and approval stops", async () => {
    const tool = FINANCE_TOOLS.find((t) => t.name === "us_company")!;
    let t = Date.parse("2026-11-14T03:00:00Z");
    const budgets: number[] = [];
    const worker = async (job: Extract<WorkerJob, { op: "raw" }>) => {
      budgets.push(job.timeoutMs!);
      t += 25_000; // every job takes 25 seconds
      const step = job.resume ? 1 : 0;
      const url = job.steps[step]!.url;
      return {
        ok: true as const,
        responses: [],
        pause: {
          reason: "send",
          step,
          url,
          request: { url, target: "/", headers: {} },
          jar: [],
          vars: [],
          seen: [],
        },
      } as never;
    };
    const svc = new FinanceService(worker, async () => fx.proxy, { now: () => t });
    expect(await svc.run(tool, { symbol: "AAPL" })).toEqual({ ok: false, code: "finance_timeout" });
    expect(budgets).toEqual([FINANCE_CALL_MS, FINANCE_CALL_MS - 25_000, FINANCE_CALL_MS - 50_000]);
  });
});

describe("web_search → Google News: redirects are refused, not followed (review #127 round 3)", () => {
  const skill = { ...GOOGLE_NEWS_SKILL, dir: "/nonexistent", entry: "/nonexistent/google_news_search.py" };

  it("the provider and the skill tool both run the skill with redirects refused (#129)", async () => {
    const f = scope();
    const seen: string[] = [];
    const tokens = new McpTokens();
    const svc = new McpService(tokens, f.users, {
      skills: [SELFTEST_SKILL, skill],
      python: { exe: "/opt/py/bin/python3.12", root: "/opt/py" },
      runSkill: async (s, input) => {
        seen.push(String(input.query));
        // As a refused redirect ends: the script's own failure report.
        expect(s.name).toBe(GOOGLE_NEWS_SKILL.name);
        return { ok: true, output: { ok: false, items: [] } };
      },
      web: {
        sources: f.sources,
        providers: ["google-news"],
        worker: fx.worker,
        fetchProxy: { endpoint: async () => fx.proxy, close: async () => {} },
      },
    });
    try {
      const { url } = await svc.endpoint();
      const r = await callOurTool(url, tokens.issue(f.scope), "web_search", { query: "반도체" });
      expect(JSON.parse(r.content[0]!.text!)).toEqual({ error: "web_search_unavailable" });
      await callOurTool(url, tokens.issue(f.scope), "skill_google-news-search-skill", { query: "반도체" });
      expect(seen).toEqual(["반도체", "반도체"]);
    } finally {
      await svc.close();
    }
    // One policy for both: a python skill with hosts always gets the boot.
    const policy = skillPolicy(
      skill,
      { query: "x" },
      {
        node: process.execPath,
        python: { exe: "/opt/py/bin/python3.12", root: "/opt/py" },
        proxy: { url: "http://127.0.0.1:9", port: 9 },
      },
    );
    expect(policy.args.slice(0, 6)).toEqual(["-I", "-S", "-B", "-c", SKILL_NET_BOOT, skill.entry]);
  });

  const python = ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/usr/bin/python3"].find((p) =>
    fs.existsSync(p),
  );
  it.skipIf(!python)(
    "the boot refuses a 302 to a secret-bearing URL for urlopen and a built opener",
    async () => {
      const asked: string[] = [];
      const server = http.createServer((req, res) => {
        asked.push(req.url ?? "");
        if (req.url === "/start") return res.writeHead(302, { location: `/rss/search?q=${TOKEN}` }).end();
        res.writeHead(200, { "content-type": "text/plain" }).end("followed");
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      const port = (server.address() as net.AddressInfo).port;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "noredir-"));
      try {
        const script = path.join(dir, "probe.py");
        fs.writeFileSync(
          script,
          [
            "import sys, urllib.request, urllib.error",
            "for open_ in (urllib.request.urlopen, urllib.request.build_opener().open):",
            "    try:",
            "        print(open_(sys.argv[1], timeout=5).read().decode())",
            "    except urllib.error.HTTPError as e:",
            "        print('HTTPError', e.code)",
          ].join("\n"),
        );
        // As the runner does: the gate on fd 3 (here approving every send — the redirect is what is refused).
        const run = (boot: boolean) =>
          new Promise<{ stdout: string }>((resolve, reject) => {
            const child = spawn(
              python!,
              [
                "-I",
                "-S",
                "-B",
                ...(boot ? ["-c", SKILL_NET_BOOT] : []),
                script,
                `http://127.0.0.1:${port}/start`,
              ],
              { env: {}, stdio: ["pipe", "pipe", "pipe", "pipe"] },
            );
            serveGate(
              child.stdio[3] as Duplex,
              () => true,
              () => child.kill("SIGKILL"),
            );
            let stdout = "";
            child.stdout!.on("data", (d: Buffer) => (stdout += d.toString()));
            child.on("error", reject);
            child.on("close", () => resolve({ stdout }));
            child.stdin!.end();
          });
        const refused = await run(true);
        expect(refused.stdout.trim().split("\n")).toEqual(["HTTPError 302", "HTTPError 302"]);
        expect(asked).toEqual(["/start", "/start"]);
        // Control: without the boot the redirect is followed (what the provider must not do).
        asked.length = 0;
        const followed = await run(false);
        expect(followed.stdout.trim().split("\n")).toEqual(["followed", "followed"]);
        expect(asked).toEqual(["/start", `/rss/search?q=${TOKEN}`, "/start", `/rss/search?q=${TOKEN}`]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
        server.close();
      }
    },
  );
});
