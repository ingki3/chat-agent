import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GOOGLE_NEWS_SKILL,
  KR_STOCK_SKILL,
  SELFTEST_SKILL,
  type BundledSkill,
} from "@agentlee/mcp-tools/skills";
import { UserStore } from "../src/auth/users.js";
import { ConversationStore } from "../src/conversations/store.js";
import { createTestDb } from "../src/db/client.js";
import { GATE_LINE_MAX, runIsolated, serveGate, type GateFailure } from "../src/isolation/sandbox.js";
import { McpTokens } from "../src/isolation/tokens.js";
import { pythonRuntime } from "../src/mcp/python.js";
import { sanitizeRecord } from "../src/logging.js";
import {
  McpService,
  sandboxedSkillRunner,
  SKILL_NET_BOOT,
  SKILL_SECRET_BLOCKED,
  SKILL_SENDS_MAX,
  skillPolicy,
  SkillRefused,
  skillSendGate,
  type SkillPolicyContext,
  type SkillRunner,
} from "../src/mcp/service.js";
import { EGRESS_WINDOW } from "../src/secrets/egress.js";
import { knownSecrets } from "../src/secrets/known.js";
import { callOurTool } from "./helpers/live-mcp.js";

/**
 * Networked skills called directly as tools (#129): every request a networked python skill sends — as the script
 * composed it and urllib encoded it — is approved on fd 3 before it goes out; one carrying a known or configured
 * secret (whole, or any 16-character window, raw or in one common encoding, optionally inside one transport layer)
 * is refused, and the call fails (`skill_failed` to the model, `skill_secret_blocked` in the log). The skill's own
 * key is allowed at its declared place only. Redirects are refused. Synthetic secrets only.
 */

const TOKEN = "synthSkill4Pq8Wn2Xc6Vb9Lm3Kj7Hd5Gf1";
const KOREAN = "합성스킬비밀-SYNTHETIC-4c8e2b-끝";
const SHORT = "GATEQZ4417";
/** Review #132 round 1: a secret that only the composed query (`<query> site:<site> when:1d`) spells. */
const COMPOSED = "private-prefix_zzSYNTH9 site:example.com_private-suffix";
const SECRETS = [TOKEN, KOREAN, SHORT, COMPOSED];
/** The Alpha Vantage key: a `.env` skill secret (configured), declared by kr-stock at `apikey=` on its host. */
const AV_KEY = "AVKEY7Q2W9";
const AV_HOST = "www.alphavantage.co";

const news: BundledSkill = { ...GOOGLE_NEWS_SKILL, dir: "/nonexistent", entry: "/nonexistent/news.py" };
const stock: BundledSkill = { ...KR_STOCK_SKILL, dir: "/nonexistent", entry: "/nonexistent/kr_stock.py" };
const SECRETS_ENV = { ALPHAVANTAGE_API_KEY: AV_KEY };
const ctx: SkillPolicyContext = {
  node: process.execPath,
  python: { exe: "/opt/py/bin/python3.12", root: "/opt/py" },
  secrets: SECRETS_ENV,
  proxy: { url: "http://127.0.0.1:9", port: 9 },
};

/** Python's `urllib.parse.quote_plus`. */
const quotePlus = (s: string) =>
  encodeURIComponent(s)
    .replace(/%20/g, "+")
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
/** The request google_news_search.py sends for a query (its `build_url` + `fetch_rss`), as the gate sees it. */
const newsWire = (q: string, headers: Record<string, string> = {}) =>
  JSON.stringify({
    host: "news.google.com",
    data:
      `GET /rss/search?q=${quotePlus(q)}&hl=ko&gl=KR&ceid=KR%3Ako HTTP/1.1\r\nAccept-Encoding: identity\r\n` +
      `Host: news.google.com\r\nUser-Agent: SimpleClaw google-news-search-skill/1.0\r\n` +
      Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}\r\n`)
        .join("") +
      "Connection: close\r\n\r\n",
  });
/** kr_stock.py's Alpha Vantage request. */
const avWire = (query: string, host = AV_HOST) =>
  JSON.stringify({
    host,
    data: `GET /query?${query} HTTP/1.1\r\nAccept-Encoding: identity\r\nHost: ${host}\r\nUser-Agent: kr-stock-skill/2.0\r\nConnection: close\r\n\r\n`,
  });
const approves = (skill: BundledSkill, input: Record<string, unknown>, ...lines: string[]) => {
  const g = skillSendGate(skill, input, SECRETS_ENV);
  return lines.map((l) => g.approve(l));
};

const PAYLOADS: Record<string, string> = {
  "token whole": TOKEN,
  "token window": TOKEN.slice(9, 9 + EGRESS_WINDOW),
  "korean whole": KOREAN,
  "korean window": KOREAN.slice(2, 2 + EGRESS_WINDOW),
  "short whole": SHORT,
  "configured key whole": AV_KEY,
};
const h2 = (n: number) => n.toString(16).padStart(2, "0");
/** What the model could put in a query (the script then percent-encodes it — the transport layer). */
const ENCODINGS: Record<string, (s: string) => string> = {
  raw: (s) => s,
  percent: (s) => encodeURIComponent(s),
  "percent every byte": (s) => [...Buffer.from(s)].map((b) => `%${h2(b).toUpperCase()}`).join(""),
  base64: (s) => Buffer.from(s).toString("base64"),
  base64url: (s) => Buffer.from(s).toString("base64url"),
  "base64 spaced": (s) =>
    Buffer.from(s)
      .toString("base64")
      .replace(/(.{4})/g, "$1 "),
  hex: (s) => Buffer.from(s).toString("hex"),
  HEX: (s) => Buffer.from(s).toString("hex").toUpperCase(),
};
const ORDINARY_QUERIES = [
  "반도체 수출 전망 2026 when:1d",
  "금리 site:yna.co.kr when:7d",
  "GATE 4417 QZ",
  TOKEN.slice(9, 9 + EGRESS_WINDOW - 1), // 15 characters: below the window
  Buffer.from("plain words in base64").toString("base64"),
];

beforeEach(() => {
  for (const s of SECRETS) knownSecrets.add(s, { fresh: true });
});
afterEach(() => {
  for (const s of SECRETS) knownSecrets.remove(s);
});

describe("skillSendGate: the request as it goes on the wire", () => {
  for (const [name, payload] of Object.entries(PAYLOADS))
    for (const [enc, encode] of Object.entries(ENCODINGS))
      it(`google-news query: ${name} as ${enc}`, () => {
        expect(approves(news, {}, newsWire(`뉴스 ${encode(payload)} when:1d`))).toEqual([false]);
      });

  it("review #132 round 1: a window formed only by the script's composition is refused", () => {
    // {query: "zzSYNTH9", site: "example.com"} → q = "zzSYNTH9 site:example.com when:1d" (24 characters of it).
    expect(approves(news, {}, newsWire("zzSYNTH9 site:example.com when:1d"))).toEqual([false]);
    expect(approves(news, {}, newsWire("zzSYNTH9 site:example.com when:30d"))).toEqual([false]);
    expect(approves(news, {}, newsWire(COMPOSED))).toEqual([false]);
  });

  it("headers and the body are checked; the host must be the skill's", () => {
    expect(approves(news, {}, newsWire("ordinary", { "X-Debug": TOKEN.slice(3, 19) }))).toEqual([false]);
    const withBody = JSON.stringify({
      host: "news.google.com",
      data: `POST /x HTTP/1.1\r\nHost: news.google.com\r\nContent-Length: 40\r\n\r\nk=${Buffer.from(TOKEN).toString("base64")}`,
    });
    expect(approves(news, {}, withBody)).toEqual([false]);
    expect(approves(news, {}, newsWire("ordinary").replace('"news.google.com"', '"evil.example"'))).toEqual([
      false,
    ]);
    // The UTF-8 bytes of a non-ASCII secret, as http.client sends them (Latin-1 text per byte).
    const bytes = Buffer.from(KOREAN, "utf8").toString("latin1");
    expect(approves(news, {}, newsWire("ordinary", { Cookie: `sid=${bytes}` }))).toEqual([false]);
  });

  for (const query of ORDINARY_QUERIES)
    it(`ordinary query goes on: ${query}`, () => {
      expect(approves(news, {}, newsWire(query))).toEqual([true]);
    });

  it("review #132 round 1 P2: local-only control values are not on the wire, so not checked", () => {
    knownSecrets.add("published", { fresh: true });
    knownSecrets.add("relevance", { fresh: true });
    try {
      // The skill gets `--sort=published` / `--sort=relevance`; the request does not carry them.
      expect(approves(news, { query: "ordinary", sort: "published" }, newsWire("ordinary when:1d"))).toEqual([
        true,
      ]);
    } finally {
      knownSecrets.remove("published");
      knownSecrets.remove("relevance");
    }
  });

  it("the CONNECT to the proxy is a request like any other", () => {
    const connect = (host: string) =>
      JSON.stringify({ host, data: `CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n` });
    expect(approves(news, {}, connect("news.google.com"))).toEqual([true]);
    expect(approves(news, {}, connect("m.stock.naver.com"))).toEqual([false]);
  });

  describe("the skill's own key: at its declared place only", () => {
    const alpha = { command: "alpha-quote", code: "AAPL" };
    const q = `function=GLOBAL_QUOTE&symbol=AAPL&datatype=json&apikey=${AV_KEY}`;
    it("allowed as the apikey parameter on its host", () => {
      expect(approves(stock, alpha, avWire(q))).toEqual([true]);
    });
    it("refused anywhere else", () => {
      expect(approves(stock, alpha, avWire(q, "m.stock.naver.com"))).toEqual([false]); // another allowed host
      expect(approves(stock, alpha, avWire(`function=X&key=${AV_KEY}`))).toEqual([false]); // another parameter
      expect(approves(stock, alpha, avWire(`${q}&apikey=${AV_KEY}`))).toEqual([false]); // a second pair
      expect(approves(stock, alpha, avWire(`${q}&s=${TOKEN}`))).toEqual([false]); // another secret beside it
      const inHeader = JSON.stringify({
        host: AV_HOST,
        data: `GET /query?function=X HTTP/1.1\r\nHost: ${AV_HOST}\r\nX-Key: ${AV_KEY}\r\n\r\n`,
      });
      expect(approves(stock, alpha, inHeader)).toEqual([false]);
      // Not for a call that does not get the key (`when`): the stock command.
      expect(approves(stock, { command: "stock", code: "005930" }, avWire(q))).toEqual([false]);
    });
  });

  it("malformed lines, too many sends, and anything after a refusal are refused", () => {
    expect(approves(news, {}, "not json")).toEqual([false]);
    expect(approves(news, {}, JSON.stringify({ host: "news.google.com", data: "garbage" }))).toEqual([false]);
    expect(approves(news, {}, newsWire(TOKEN), newsWire("ordinary"))).toEqual([false, false]);
    const many = approves(news, {}, ...Array.from({ length: SKILL_SENDS_MAX + 1 }, () => newsWire("x")));
    expect(many.slice(0, SKILL_SENDS_MAX).every(Boolean)).toBe(true);
    expect(many.at(-1)).toBe(false);
  });

  it("deny(): a failure of the gate itself is the same final refusal (#135)", () => {
    const g = skillSendGate(news, {}, SECRETS_ENV);
    expect(g.approve(newsWire("ordinary"))).toBe(true);
    expect(g.denied).toBe(false);
    g.deny();
    expect(g.denied).toBe(true);
    expect(g.approve(newsWire("ordinary"))).toBe(false);
  });
});

describe("serveGate: the line limit comes first, and a failure is final (#135)", () => {
  /** A socket stand-in: what the server answers is collected; the child's bytes are emitted as `data`. */
  const socket = () => {
    const written: string[] = [];
    const d = new Duplex({
      read() {},
      write(chunk: Buffer, _enc, cb) {
        written.push(chunk.toString());
        cb();
      },
    });
    const seen: string[] = [];
    const failures: GateFailure[] = [];
    serveGate(
      d,
      (l) => (seen.push(l), true),
      (why) => failures.push(why),
    );
    const send = (s: string | Buffer) => d.emit("data", Buffer.from(s));
    return { d, written, seen, failures, send };
  };

  it("a line of exactly the limit is handed over; one byte more is refused even with its newline", () => {
    const at = socket();
    at.send("x".repeat(GATE_LINE_MAX) + "\n");
    expect(at.seen).toHaveLength(1);
    expect(at.written).toEqual(["1\n"]);
    expect(at.failures).toEqual([]);

    // Review #132 round 2: the over-long line used to be approved when its newline came in the same chunk.
    const over = socket();
    over.send("x".repeat(GATE_LINE_MAX + 1) + "\nok\n");
    expect(over.seen).toEqual([]);
    expect(over.written).toEqual(["0\n"]);
    expect(over.failures).toEqual(["overflow"]);
    over.send("later\n"); // nothing after it is read
    expect(over.seen).toEqual([]);
    expect(over.written).toEqual(["0\n"]);
  });

  it("lines before an over-long one are answered in order; the over-long one, split across chunks, is refused", () => {
    const g = socket();
    g.send("a\nb\n" + "x".repeat(GATE_LINE_MAX / 2));
    expect(g.seen).toEqual(["a", "b"]);
    g.send("x".repeat(GATE_LINE_MAX / 2 + 1)); // no newline yet: refused as soon as it is too long
    expect(g.failures).toEqual(["overflow"]);
    g.send("\n");
    expect(g.seen).toEqual(["a", "b"]);
    expect(g.written).toEqual(["1\n", "1\n", "0\n"]);
  });

  it("a socket error is a failure (once); nothing after it is approved", () => {
    const g = socket();
    g.d.emit("error", new Error("EPIPE"));
    g.d.emit("error", new Error("EPIPE"));
    expect(g.failures).toEqual(["error"]);
    g.send("late\n");
    expect(g.seen).toEqual([]);
    expect(g.written).toEqual([]);
  });
});

describe.skipIf(process.platform !== "darwin")(
  "runIsolated: the gate's line limit in the sandbox (#135)",
  () => {
    /** bash builtins only (the profile forbids fork): one line of `n` bytes on fd 3, then the verdict on stdout. */
    const ask = (n: number) => {
      const seen: number[] = [];
      const failures: GateFailure[] = [];
      const r = runIsolated({
        command: "/bin/bash",
        args: ["-c", `printf '%*s\\n' ${n} '' >&3; read -r -u 3 v; echo "got:$v"`],
        cwd: os.tmpdir(),
        env: {},
        read: [],
        write: [],
        timeoutMs: 10_000,
        maxOutputBytes: 10_000,
        gate: (l) => (seen.push(l.length), true),
        gateFailed: (why) => failures.push(why),
      });
      return r.then((res) => ({ ...res, seen, failures }));
    };

    it("a line of the limit is approved; one byte more is refused before the gate sees it and stops the child", async () => {
      const at = await ask(GATE_LINE_MAX);
      expect(at.seen).toEqual([GATE_LINE_MAX]);
      expect(at.failures).toEqual([]);
      expect(at.stdout).toBe("got:1\n");
      const over = await ask(GATE_LINE_MAX + 1);
      expect(over.seen).toEqual([]);
      expect(over.failures).toEqual(["overflow"]);
      expect(over.killed).toBe("output");
      expect(over.stdout).not.toBe("got:1\n");
    });
  },
);

describe("sandboxedSkillRunner: what needs no proxy is checked before the proxy is prepared (#135)", () => {
  const s = { userId: "u", conversationId: "c", runId: "r" };
  const counted = () => {
    let proxies = 0;
    return {
      get proxies() {
        return proxies;
      },
      proxy: async () => {
        proxies++;
        return { url: "http://127.0.0.1:9", port: 9 };
      },
    };
  };

  it("a changed pinned copy, a missing key, no python, a networked node skill: no proxy", async () => {
    const c = counted();
    const python = { exe: "/opt/py/bin/python3.12", root: "/opt/py" };
    const run = sandboxedSkillRunner({ python, secrets: {}, proxy: c.proxy });
    expect(await run({ ...news, verify: () => false }, { query: "x" }, s)).toEqual({
      ok: false,
      code: "skill_changed",
    });
    expect(await run(stock, { command: "alpha-quote", code: "AAPL" }, s)).toEqual({
      ok: false,
      code: "skill_unconfigured",
    });
    expect(await sandboxedSkillRunner({ proxy: c.proxy })(news, { query: "x" }, s)).toEqual({
      ok: false,
      code: "skill_unavailable",
    });
    const nodeNet: BundledSkill = { ...SELFTEST_SKILL, hosts: ["example.com"] };
    expect(await run(nodeNet, { text: "x" }, s)).toEqual({ ok: false, code: "skill_unavailable" });
    expect(c.proxies).toBe(0);
  });
});

describe("skillPolicy", () => {
  const refusal = (f: () => unknown) => {
    try {
      f();
      return undefined;
    } catch (e) {
      return e instanceof SkillRefused ? e.code : String(e);
    }
  };

  it("arguments are not pre-checked (the gate sees what is sent); the key is the process's env only", () => {
    expect(skillPolicy(news, { query: "x", sort: "published" }, ctx).args).toContain("--sort=published");
    const p = skillPolicy(stock, { command: "alpha-quote", code: "AAPL" }, ctx);
    expect(p.env.ALPHAVANTAGE_API_KEY).toBe(AV_KEY);
    expect(p.args.join(" ")).not.toContain(AV_KEY);
  });

  it("every networked python skill runs under the network boot; a networked node skill is refused", () => {
    for (const s of [news, stock]) {
      const input = s === news ? { query: "x" } : { command: "stock", code: "005930" };
      expect(skillPolicy(s, input, ctx).args.slice(0, 6)).toEqual([
        "-I",
        "-S",
        "-B",
        "-c",
        SKILL_NET_BOOT,
        s.entry,
      ]);
    }
    const noNet: BundledSkill = { ...news, hosts: [] };
    expect(skillPolicy(noNet, { query: "x" }, ctx).args.slice(0, 4)).toEqual(["-I", "-S", "-B", noNet.entry]);
    const nodeNet: BundledSkill = { ...SELFTEST_SKILL, hosts: ["example.com"] };
    expect(refusal(() => skillPolicy(nodeNet, { text: "x" }, ctx))).toBe("skill_unavailable");
  });
});

describe("on our MCP server: the skill tool answers an ordinary failure; only the log says why", () => {
  it("a refused send", async () => {
    const db = createTestDb();
    const users = new UserStore(db);
    const mom = users.create({ email: "mom@example.com", name: "엄마", role: "member", passwordHash: "x" });
    const c = new ConversationStore(db).create(mom.id);
    const scope = { userId: mom.id, conversationId: c.id, runId: crypto.randomUUID() };
    const tokens = new McpTokens();
    const logs: Record<string, unknown>[] = [];
    const push = (o: Record<string, unknown>, msg: string) => logs.push({ ...o, msg });
    // As the sandboxed runner ends when the gate refused a send.
    const runSkill: SkillRunner = async (_s, input) =>
      String(input.query).includes("secret")
        ? { ok: false, code: SKILL_SECRET_BLOCKED }
        : { ok: true, output: { ok: true, items: [] } };
    const svc = new McpService(tokens, users, {
      skills: [SELFTEST_SKILL, news],
      python: ctx.python,
      log: { info: push, warn: push, error: push } as never,
      runSkill,
    });
    try {
      const { url } = await svc.endpoint();
      const call = async (args: unknown) => {
        const r = await callOurTool(url, tokens.issue(scope), "skill_google-news-search-skill", args);
        return { isError: r.isError, text: r.content[0]?.text ?? "" };
      };
      const blocked = await call({ query: "find secret words" });
      expect(blocked.isError).toBe(true);
      expect(JSON.parse(blocked.text)).toEqual({ error: "skill_failed" });
      const ordinary = await call({ query: "반도체 수출" });
      expect(ordinary.isError).toBe(false);
      const line = JSON.stringify(logs.map((l) => sanitizeRecord(l)));
      expect(line.match(/"skillCode":"skill_secret_blocked"/g)).toHaveLength(1);
      expect(line).not.toMatch(/find|secret words|반도체/);
    } finally {
      await svc.close();
    }
  });
});

/** A python on this machine (any: the boot is standard library only), for the real-boot tests. */
const PYTHON = [
  process.env.TEST_SKILL_PYTHON,
  "/opt/homebrew/bin/python3",
  "/usr/local/bin/python3",
  "/usr/bin/python3",
].find((p): p is string => !!p && fs.existsSync(p));

/**
 * What google_news_search.py and kr_stock.py do, reduced: compose the query from several arguments plus constants,
 * `urlencode`, one `urlopen` (an `HTTPError` / `URLError` is a failure report on stdout, exit 1).
 */
const SCRIPT = `
import json, sys, urllib.error, urllib.parse, urllib.request
base, mode, a, b = sys.argv[1:5]
if mode == "news":
    url = base + "/rss/search?" + urllib.parse.urlencode({"q": " ".join([a, "site:" + b, "when:1d"]), "hl": "ko"})
else:
    import os
    url = base + "/query?" + urllib.parse.urlencode({"function": "GLOBAL_QUOTE", "symbol": a, "apikey": os.environ["AV"]})
try:
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "probe/1.0"}), timeout=5) as r:
        print(json.dumps({"ok": True, "body": r.read().decode()}))
except urllib.error.HTTPError as e:
    print(json.dumps({"ok": False, "http": e.code})); sys.exit(1)
except urllib.error.URLError as e:
    print(json.dumps({"ok": False, "url_error": str(e.reason)})); sys.exit(1)
`;

describe.skipIf(!PYTHON)("the real boot: every send asked for on fd 3 first", () => {
  let server: http.Server;
  let base: string;
  const asked: string[] = [];
  let dir: string;
  beforeEach(async () => {
    asked.length = 0;
    server = http.createServer((req, res) => {
      asked.push(req.url ?? "");
      if (req.url?.startsWith("/redirect"))
        return res.writeHead(302, { location: `/rss/search?q=${TOKEN}` }).end();
      res.writeHead(200, { "content-type": "text/plain" }).end("fetched");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-gate-"));
    fs.writeFileSync(path.join(dir, "probe.py"), SCRIPT);
  });
  afterEach(() => {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Runs the probe under the boot with the gate on fd 3 (or none: `gate: false`), as the runner does. */
  const run = (
    args: string[],
    gate: ((line: string) => boolean) | false,
    env: Record<string, string> = {},
  ): Promise<{ code: number | null; out: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const child = spawn(
        PYTHON!,
        ["-I", "-S", "-B", "-c", SKILL_NET_BOOT, path.join(dir, "probe.py"), ...args],
        {
          env,
          stdio: gate ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
        },
      );
      if (gate) serveGate(child.stdio[3] as Duplex, gate, () => child.kill("SIGKILL"));
      let out = "";
      child.stdout!.on("data", (d: Buffer) => (out += d.toString()));
      child.on("error", reject);
      child.on("close", (code) => {
        try {
          resolve({ code, out: JSON.parse(out) as Record<string, unknown> });
        } catch (e) {
          reject(e as Error);
        }
      });
      child.stdin!.end();
    });

  const local = (secrets: BundledSkill["secrets"] = []) =>
    ({ hosts: ["127.0.0.1"], secrets }) as Pick<BundledSkill, "hosts" | "secrets"> as BundledSkill;

  it("review #132 round 1 repro: the composed query is refused before it is sent", async () => {
    const g = skillSendGate(local(), {});
    const seen: string[] = [];
    const r = await run([base, "news", "zzSYNTH9", "example.com"], (l) => (seen.push(l), g.approve(l)));
    expect(r.code).toBe(1);
    expect(r.out).toMatchObject({ ok: false });
    expect(g.denied).toBe(true);
    expect(asked).toEqual([]); // nothing reached the site
    // What the gate saw is the exact request, after the script's composition and urllib's encoding.
    const sent = JSON.parse(seen[0]!) as { host: string; data: string };
    expect(sent.host).toBe("127.0.0.1");
    expect(sent.data).toMatch(
      /^GET \/rss\/search\?q=zzSYNTH9\+site%3Aexample\.com\+when%3A1d&hl=ko HTTP\/1\.1\r\n/,
    );
  });

  it("an ordinary request is approved and sent as it was approved", async () => {
    const g = skillSendGate(local(), {});
    const r = await run([base, "news", "반도체", "yna.co.kr"], (l) => g.approve(l));
    expect(r).toEqual({ code: 0, out: { ok: true, body: "fetched" } });
    expect(g.denied).toBe(false);
    expect(g.sends).toBe(1);
    expect(asked).toEqual([`/rss/search?q=${quotePlus("반도체 site:yna.co.kr when:1d")}&hl=ko`]);
  });

  it("the declared key goes out at its place; the same key elsewhere is refused", async () => {
    const key = [{ env: "AV", place: { host: "127.0.0.1", param: "apikey" } }];
    let g = skillSendGate(local(key), {}, { AV: AV_KEY });
    const ok = await run([base, "av", "AAPL", "-"], (l) => g.approve(l), { AV: AV_KEY });
    expect(ok.code).toBe(0);
    expect(asked).toEqual([`/query?function=GLOBAL_QUOTE&symbol=AAPL&apikey=${AV_KEY}`]);
    // The same key in the symbol as well: the one allowed pair is taken out, the other is refused.
    asked.length = 0;
    g = skillSendGate(local(key), {}, { AV: AV_KEY });
    const twice = await run([base, "av", AV_KEY, "-"], (l) => g.approve(l), { AV: AV_KEY });
    expect(twice.code).toBe(1);
    expect(asked).toEqual([]);
  });

  it("a redirect is still refused (one request, approved; the hop never built)", async () => {
    const g = skillSendGate(local(), {});
    const r = await run([`${base}/redirect`, "news", "x", "y.com"], (l) => g.approve(l));
    expect(r.out).toEqual({ ok: false, http: 302 });
    expect(g.sends).toBe(1);
    expect(asked).toHaveLength(1);
  });

  it("without the gate (no fd 3) nothing is sent", async () => {
    const r = await run([base, "news", "x", "y.com"], false);
    expect(r.code).toBe(1);
    expect(r.out).toMatchObject({ ok: false });
    expect(asked).toEqual([]);
  });
});

/** A self-contained python (uv) for the sandbox: `TEST_SKILL_PYTHON`, or none (skipped) — as skills.test.ts. */
const STANDALONE = (() => {
  if (process.platform !== "darwin") return undefined;
  const r = pythonRuntime(process.env.TEST_SKILL_PYTHON);
  return r.ok ? r.runtime : undefined;
})();

describe.skipIf(!STANDALONE)("the sandboxed runner: the gate works inside sandbox-exec (macOS)", () => {
  it("a refused send is skill_secret_blocked; an ordinary one runs", async () => {
    const asked: string[] = [];
    const server = http.createServer((req, res) => {
      asked.push(req.url ?? "");
      res.writeHead(200).end("fetched");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as net.AddressInfo).port;
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skill-gate-sb-")));
    fs.writeFileSync(path.join(dir, "probe.py"), SCRIPT);
    try {
      const spec: BundledSkill = {
        name: "probe",
        description: "probe",
        input: {},
        finance: false,
        kind: "python",
        files: ["probe.py"],
        args: (i) => [`http://127.0.0.1:${port}`, "news", String(i.q), String(i.site)],
        hosts: ["127.0.0.1"],
        secrets: [],
        okExitCodes: [0, 1],
        dir,
        entry: path.join(dir, "probe.py"),
      };
      const run = sandboxedSkillRunner({
        python: STANDALONE,
        proxy: async () => ({ url: `http://127.0.0.1:${port}`, port }),
        limits: { timeoutMs: 20_000, maxOutputBytes: 64 * 1024, maxRssBytes: 512 * 1024 * 1024 },
      });
      const s = { userId: "u", conversationId: "c", runId: "r" };
      expect(await run(spec, { q: "zzSYNTH9", site: "example.com" }, s)).toEqual({
        ok: false,
        code: SKILL_SECRET_BLOCKED,
      });
      expect(asked).toEqual([]);
      const ok = await run(spec, { q: "ordinary", site: "yna.co.kr" }, s);
      expect(ok).toEqual({ ok: true, output: { ok: true, body: "fetched" } });
      expect(asked).toHaveLength(1);
    } finally {
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an over-long request line is the same skill_secret_blocked (#135)", async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "skill-gate-long-")));
    // Writes one line past the limit on fd 3 itself, then reports success: the outcome is still the refusal.
    fs.writeFileSync(
      path.join(dir, "long.py"),
      `import os\nline = b"x" * ${GATE_LINE_MAX + 1} + b"\\n"\nwhile line:\n    line = line[os.write(3, line):]\nprint('{"ok": true}')\n`,
    );
    try {
      const spec: BundledSkill = {
        name: "long",
        description: "long",
        input: {},
        finance: false,
        kind: "python",
        files: ["long.py"],
        args: () => [],
        hosts: ["127.0.0.1"],
        secrets: [],
        dir,
        entry: path.join(dir, "long.py"),
      };
      const run = sandboxedSkillRunner({
        python: STANDALONE,
        proxy: async () => ({ url: "http://127.0.0.1:9", port: 9 }),
        limits: { timeoutMs: 20_000, maxOutputBytes: 64 * 1024, maxRssBytes: 512 * 1024 * 1024 },
      });
      expect(await run(spec, {}, { userId: "u", conversationId: "c", runId: "r" })).toEqual({
        ok: false,
        code: SKILL_SECRET_BLOCKED,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
