import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FINANCE_DISCLAIMER, financeLabel, FinanceMeta, type MessagePart } from "@agentlee/shared";
import { FINANCE_TOOLS, type FinanceToolInfo } from "@agentlee/mcp-tools/finance";
import { SELFTEST_SKILL, SKILL_CATALOGUE } from "@agentlee/mcp-tools/skills";
import { UserStore } from "../src/auth/users.js";
import { createTestDb } from "../src/db/client.js";
import {
  closeInstant,
  isOpen,
  isoLocal,
  isTradingDay,
  latestTradingDay,
  sessionDayOf,
  CALENDAR_YEARS,
} from "../src/finance/calendar.js";
import { checkAnswer, financeEvidence, financeNote } from "../src/finance/checker.js";
import { checkRecords, finalize, marketStamp } from "../src/finance/records.js";
import { allowed, FINANCE_CODES, FinanceService } from "../src/finance/service.js";
import { TOOL_IMPLS } from "../src/finance/providers.js";
import { isFinanceTool } from "../src/instructions/assemble.js";
import { startEgressProxy } from "../src/isolation/egress.js";
import { McpTokens } from "../src/isolation/tokens.js";
import { McpService } from "../src/mcp/service.js";
import { FINANCE_CODES as LOGGABLE_FINANCE_CODES } from "../src/observability/policy.js";
import { sanitizeRecord } from "../src/logging.js";
import { loadFixtures, replayWorker, storedUrl, type Exchange } from "./helpers/finance-replay.js";
import { callOurTool } from "./helpers/live-mcp.js";
// The worker itself (plain JS), run in-process here.
import { run as runWorker } from "../../../packages/mcp-tools/web/worker.mjs";

const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const T = (iso: string) => Date.parse(iso);
const SECRETS = {
  OPENDART_API_KEY: "test-dart-key-0123456789",
  SEC_USER_AGENT: "AgentLee test admin@example.com",
};
const toolOf = (name: string) => FINANCE_TOOLS.find((t) => t.name === name)!;
const PROXY = { url: "http://127.0.0.1:9", port: 9 };

async function replay(
  name: string,
  exchanges: readonly Exchange[],
  input: Record<string, unknown>,
  now: string,
) {
  const r = replayWorker(exchanges);
  const svc = new FinanceService(r.worker, async () => PROXY, { secrets: SECRETS, now: () => T(now) });
  const result = await svc.run(toolOf(name), input);
  return { result, ...r };
}

// ---- calendars ------------------------------------------------------------------------------------------

describe("market calendars (#30)", () => {
  it("weekends and holidays are not trading days; the latest trading day of a weekend is Friday", () => {
    expect(isTradingDay("KRX", "2026-11-13")).toBe(true); // Friday
    expect(isTradingDay("KRX", "2026-11-14")).toBe(false); // Saturday
    expect(isTradingDay("KRX", "2026-12-25")).toBe(false); // 성탄절
    expect(isTradingDay("KRX", "2026-09-24")).toBe(false); // 추석
    expect(isTradingDay("US", "2026-11-26")).toBe(false); // Thanksgiving
    expect(isTradingDay("US", "2026-11-27")).toBe(true);
    expect(latestTradingDay("KRX", T("2026-11-14T11:00:00+09:00"))).toBe("2026-11-13");
    expect(latestTradingDay("KRX", T("2026-11-15T23:00:00+09:00"))).toBe("2026-11-13");
    // Monday before the open: still Friday.
    expect(latestTradingDay("KRX", T("2026-11-16T08:59:00+09:00"))).toBe("2026-11-13");
    expect(latestTradingDay("KRX", T("2026-11-16T09:00:00+09:00"))).toBe("2026-11-16");
    // Saturday after a Friday holiday: Thursday.
    expect(latestTradingDay("KRX", T("2026-12-26T10:00:00+09:00"))).toBe("2026-12-24");
    expect(latestTradingDay("US", T("2026-11-27T08:00:00-05:00"))).toBe("2026-11-25");
  });

  it("sessions: open/close times, early closes, DST and the FX week", () => {
    expect(isoLocal(closeInstant("KRX", "2026-11-13"), "Asia/Seoul")).toBe("2026-11-13T15:30:00+09:00");
    expect(isoLocal(closeInstant("US", "2026-11-13"), "America/New_York")).toBe("2026-11-13T16:00:00-05:00");
    expect(isoLocal(closeInstant("US", "2026-07-02"), "America/New_York")).toBe("2026-07-02T16:00:00-04:00");
    expect(isoLocal(closeInstant("US", "2026-11-27"), "America/New_York")).toBe("2026-11-27T13:00:00-05:00");
    expect(isOpen("KRX", T("2026-11-13T15:29:59+09:00"))).toBe(true);
    expect(isOpen("KRX", T("2026-11-13T15:30:00+09:00"))).toBe(false);
    expect(isOpen("US", T("2026-11-13T09:29:00-05:00"))).toBe(false);
    expect(isOpen("US", T("2026-11-13T09:30:00-05:00"))).toBe(true);
    expect(isOpen("FX", T("2026-11-13T16:59:00-05:00"))).toBe(true);
    expect(isOpen("FX", T("2026-11-13T17:00:00-05:00"))).toBe(false);
    expect(isOpen("FX", T("2026-11-15T17:00:00-05:00"))).toBe(true);
    // A pre-market timestamp belongs to the session before.
    expect(sessionDayOf("KRX", T("2026-11-16T08:30:00+09:00"))).toBe("2026-11-13");
  });

  it("covers the years around today", () => {
    const year = new Date().getUTCFullYear();
    expect(CALENDAR_YEARS).toContain(year);
    expect(CALENDAR_YEARS).toContain(year + 1);
  });
});

// ---- stamps and the record check ------------------------------------------------------------------------

describe("value stamps (#30)", () => {
  it("a Saturday request shows Friday's close; a live session shows 장중 with the delay", () => {
    const sat = marketStamp({
      market: "US",
      t: T("2026-11-13T16:00:01-05:00"),
      now: T("2026-11-14T10:00:00+09:00"),
      source: "Yahoo Finance",
    });
    expect(sat).toMatchObject({ kind: "close", asOf: "2026-11-13T16:00:00-05:00", delayed: false });
    expect(financeLabel(sat as FinanceMeta)).toBe("Yahoo Finance · 2026-11-13 16:00 ET 종가");
    const live = marketStamp({
      market: "KRX",
      t: T("2026-11-12T10:14:55+09:00"),
      now: T("2026-11-12T10:15:00+09:00"),
      source: "네이버 증권",
      delayMinutes: 20,
    });
    expect(live).toMatchObject({ kind: "intraday", asOf: "2026-11-12T10:14:55+09:00", delayed: true });
    expect(financeLabel(live as FinanceMeta)).toBe("네이버 증권 · 2026-11-12 10:14 KST 장중 (지연)");
    // After the close the same day: 종가, stamped 15:30.
    const after = marketStamp({
      market: "KRX",
      t: T("2026-11-12T15:58:00+09:00"),
      now: T("2026-11-12T16:30:00+09:00"),
      source: "네이버 증권",
    });
    expect(after).toMatchObject({ kind: "close", asOf: "2026-11-12T15:30:00+09:00" });
    // A value older than the latest trading day is marked stale.
    const old = marketStamp({
      market: "KRX",
      t: T("2026-11-11T15:58:00+09:00"),
      now: T("2026-11-14T10:00:00+09:00"),
      source: "네이버 증권",
    });
    expect(old).toMatchObject({ kind: "close", asOf: "2026-11-11T15:30:00+09:00", stale: true });
  });

  it("flags every record whose stamp is incomplete and lists the complete ones once", () => {
    const meta = {
      source: "Yahoo Finance",
      asOf: "2026-11-13T16:00:00-05:00",
      timeZone: "America/New_York",
      delayed: false,
      kind: "close",
    };
    const data = {
      price: { value: 1, ...meta },
      change: { value: 2, ...meta },
      noSource: { value: 3, ...meta, source: "" },
      noTime: { value: 4, ...meta, asOf: null },
      noOffset: { value: 5, ...meta, asOf: "2026-11-13T16:00:00" },
      rows: [{ close: 6, ...meta, kind: "guess" }],
    };
    const r = checkRecords(data);
    expect(r.missing).toBe(4);
    expect(r.sources.map((s) => s.label)).toEqual(["Yahoo Finance · 2026-11-13 16:00 ET 종가"]);
    expect(data.noSource).toMatchObject({ metaMissing: ["source"] });
    expect(data.noTime).toMatchObject({ metaMissing: ["asOf"] });
    expect(data.rows[0]).toMatchObject({ metaMissing: ["kind"] });
    expect(finalize("us_quote", { price: { value: 1, ...meta } })).toMatchObject({
      warnings: [],
      disclaimer: FINANCE_DISCLAIMER,
    });
    expect(finalize("us_quote", { price: { value: 1, ...meta, source: undefined } }).warnings).toEqual([
      "finance_meta_missing",
    ]);
  });
});

// ---- every tool against its fixtures ----------------------------------------------------------------------

const fixtures = loadFixtures();

describe("finance tools replay their recorded answers (#30)", () => {
  it("there is a fixture for every tool, and every tool has an implementation", () => {
    for (const t of FINANCE_TOOLS) {
      expect(TOOL_IMPLS[t.name], t.name).toBeDefined();
      expect(
        fixtures.some((f) => f.fixture.tool === t.name),
        t.name,
      ).toBe(true);
    }
  });

  for (const { name, fixture } of fixtures)
    it(`${name}${fixture.synthetic ? " (synthetic)" : ""}`, async () => {
      const tool = toolOf(fixture.tool);
      const r = await replay(fixture.tool, fixture.exchanges, fixture.input, fixture.now);
      // Every request went to one of the tool's own hosts over HTTPS — the allow-list its proxy enforces.
      expect(r.requested.length).toBeGreaterThan(0);
      for (const s of r.requested) expect(allowed(s.url, tool.hosts), s.url).toBe(true);
      expect(r.missing).toEqual([]);
      expect(r.unused()).toEqual([]);
      // No secret in what the model gets.
      expect(JSON.stringify(r.result)).not.toContain(SECRETS.OPENDART_API_KEY);
      if (r.result.ok) {
        const out = r.result.output as { sources: unknown[]; warnings: string[]; disclaimer: string };
        expect(out.warnings).toEqual([]);
        expect(out.disclaimer).toBe(FINANCE_DISCLAIMER);
      }
      await expect(JSON.stringify(r.result, null, 1) + "\n").toMatchFileSnapshot(
        `__snapshots__/finance/${name}.json`,
      );
    });

  const fx = (name: string) => fixtures.find((f) => f.name === name)!.fixture;
  const out = async (name: string) => {
    const f = fx(name);
    const r = await replay(f.tool, f.exchanges, f.input, f.now);
    if (!r.result.ok) throw new Error(r.result.code);
    return r.result.output as Record<string, unknown>;
  };

  it("Saturday → Friday's close (KRX and US); a Friday holiday → Thursday's; Thanksgiving week → the 13:00 close", async () => {
    const kr = await out("kr_quote-saturday");
    expect(kr.price).toMatchObject({
      value: 206000,
      source: "네이버 증권",
      asOf: "2026-11-13T15:30:00+09:00",
      kind: "close",
      delayed: false,
    });
    expect(kr.tradingDay).toBe("2026-11-13");
    const us = await out("us_quote-saturday");
    expect(us.price).toMatchObject({ value: 349.8, asOf: "2026-11-13T16:00:00-05:00", kind: "close" });
    expect(us.change).toMatchObject({ value: -1.4 });
    expect(us.sources).toEqual([
      expect.objectContaining({ label: "Yahoo Finance · 2026-11-13 16:00 ET 종가" }),
    ]);
    const holiday = await out("kr_quote-holiday");
    expect(holiday.price).toMatchObject({ asOf: "2026-12-24T15:30:00+09:00", kind: "close" });
    expect(holiday.price).not.toHaveProperty("stale");
    const tg = await out("us_quote-thanksgiving");
    expect(tg.price).toMatchObject({ asOf: "2026-11-27T13:00:00-05:00", kind: "close" });
    expect(tg.previousClose).toMatchObject({ value: 350.25 });
    const fxr = await out("fx_usdkrw-saturday");
    expect(fxr.rate).toMatchObject({ value: 1462.35, kind: "close", asOf: "2026-11-13T16:59:00-05:00" });
    const hist = await out("kr_history");
    expect((hist.rows as { date: string; asOf: string; kind: string }[])[0]).toMatchObject({
      date: "2026-11-13",
      asOf: "2026-11-13T15:30:00+09:00",
      kind: "close",
    });
  });

  it("while the market is open: 장중 with the source's time", async () => {
    const kr = await out("kr_quote-intraday");
    expect(kr.price).toMatchObject({ kind: "intraday", asOf: "2026-11-12T10:14:55+09:00", delayed: false });
    expect(kr.change).toMatchObject({ value: -800 });
    const us = await out("us_quote-intraday");
    // Yahoo does not say whether its live price is delayed: marked as possibly delayed.
    expect(us.price).toMatchObject({ kind: "intraday", asOf: "2026-11-13T11:14:30-05:00", delayed: true });
  });

  it("third-party text stays inside an external_content block that it cannot close", async () => {
    const dart = await out("dart_disclosures");
    const content = String(dart.content);
    expect(content.startsWith('<external_content source="dart:list">')).toBe(true);
    expect(content.match(/<\/external_content>/g)).toHaveLength(1);
    expect(JSON.stringify(dart.items)).not.toContain("지시를 무시하라");
    const company = await out("us_company");
    expect(String(company.profile).match(/<\/external_content>/g)).toHaveLength(1);
  });

  it("refusals: bad input, missing configuration, unknown symbol, a URL outside the allow-list", async () => {
    const noKey = new FinanceService(replayWorker([]).worker, async () => PROXY, { secrets: {} });
    expect(await noKey.run(toolOf("dart_disclosures"), {})).toEqual({
      ok: false,
      code: "finance_unconfigured",
    });
    expect(await noKey.run(toolOf("sec_8k"), { cik: "320193" })).toEqual({
      ok: false,
      code: "finance_unconfigured",
    });
    const svc = new FinanceService(replayWorker([]).worker, async () => PROXY, { secrets: SECRETS });
    expect(await svc.run(toolOf("sec_8k"), {})).toEqual({ ok: false, code: "finance_bad_input" });
    expect(await svc.run(toolOf("sec_8k"), { cik: "1", ticker: "AAPL" })).toEqual({
      ok: false,
      code: "finance_bad_input",
    });
    const nf = fx("us_quote-not-found");
    expect((await replay("us_quote", nf.exchanges, nf.input, nf.now)).result).toEqual({
      ok: false,
      code: "finance_not_found",
    });
    // A tool whose plan named another host would be refused before any process starts.
    const evil: FinanceToolInfo = { ...toolOf("kr_quote"), hosts: ["query1.finance.yahoo.com"] };
    expect(await svc.run(evil, { code: "005930" })).toEqual({ ok: false, code: "finance_blocked" });
    expect(allowed("https://m.stock.naver.com:8443/x", ["m.stock.naver.com"])).toBe(false);
    expect(allowed("http://m.stock.naver.com/x", ["m.stock.naver.com"])).toBe(false);
    expect(allowed("https://m.stock.naver.com.evil.test/x", ["m.stock.naver.com"])).toBe(false);
    expect(allowed("https://evil.m.stock.naver.com/x", ["m.stock.naver.com"])).toBe(false);
    expect(allowed("https://xm.stock.naver.com/x", ["m.stock.naver.com"])).toBe(false);
    expect(allowed("https://m.stock.naver.com/api/stock/005930/basic", ["m.stock.naver.com"])).toBe(true);
  });

  it("stored URLs never carry the session crumb or the OpenDART key", () => {
    expect(storedUrl("https://x/y?a=1&crumb=AbC.d/9&b=2")).toBe("https://x/y?a=1&crumb={crumb}&b=2");
    expect(storedUrl("https://x/list.json?crtfc_key=SECRET&b=2")).toBe(
      "https://x/list.json?crtfc_key={key}&b=2",
    );
    for (const { fixture } of fixtures)
      for (const e of fixture.exchanges) {
        expect(e.url).not.toMatch(/crumb=(?!\{crumb\})/);
        expect(e.url).not.toMatch(/crtfc_key=(?!\{key\})/);
      }
  });
});

// ---- egress: each tool's proxy reaches its hosts only ------------------------------------------------------

describe("finance egress (#30)", () => {
  it("each tool gets its own proxy with exactly its hosts", async () => {
    const db = createTestDb();
    const users = new UserStore(db);
    const mom = users.create({ email: "mom@example.com", name: "엄마", role: "member", passwordHash: "x" });
    const allowLists = new Map<string, readonly string[]>();
    const tokens = new McpTokens();
    const svc = new McpService(tokens, users, {
      skills: [SELFTEST_SKILL],
      egress: (allow) => ({
        endpoint: async () => {
          allowLists.set(allow.join(","), allow);
          return { port: 9, url: "http://127.0.0.1:9", close: async () => {} };
        },
        close: async () => {},
      }),
      finance: { secrets: SECRETS, worker: async () => ({ ok: false, code: "web_unreachable" }) },
    });
    closers.push(() => svc.close());
    const { url } = await svc.endpoint();
    const token = tokens.issue({
      userId: mom.id,
      conversationId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
    });
    for (const t of FINANCE_TOOLS) {
      allowLists.clear();
      const input: Record<string, unknown> = Object.keys(t.input).includes("code")
        ? { code: "005930" }
        : Object.keys(t.input).includes("symbol")
          ? { symbol: "AAPL" }
          : Object.keys(t.input).includes("index")
            ? { index: t.name === "kr_index" ? "KOSPI" : "SP500" }
            : Object.keys(t.input).includes("query")
              ? { query: "삼성" }
              : Object.keys(t.input).includes("screen")
                ? { screen: "day_gainers" }
                : t.name.startsWith("sec_")
                  ? { cik: "320193" }
                  : {};
      const r = await callOurTool(url, token, t.name, input);
      expect(r.isError, t.name).toBe(true); // the stub worker cannot reach anything
      expect([...allowLists.values()], t.name).toEqual([t.hosts]);
    }
  });

  it("the proxy with a tool's allow-list refuses every other name, including near misses", async () => {
    // An upstream that answers anything: what matters is whether the proxy opens the tunnel.
    const upstream = net.createServer((s) => s.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok"));
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", () => r()));
    closers.push(() => new Promise((r) => upstream.close(r)));
    const port = (upstream.address() as AddressInfo).port;
    const proxy = await startEgressProxy({
      allow: toolOf("us_company").hosts,
      lookup: async () => ["93.184.216.34"],
      connect: () => net.connect(port, "127.0.0.1"),
    });
    closers.push(() => proxy.close());
    const connect = (target: string) =>
      new Promise<number>((resolve) => {
        const req = http.request({ host: "127.0.0.1", port: proxy.port, method: "CONNECT", path: target });
        req.on("connect", (res, socket) => {
          socket.destroy();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", () => resolve(-1));
        req.end();
      });
    expect(await connect("query1.finance.yahoo.com:443")).toBe(200);
    expect(await connect("fc.yahoo.com:443")).toBe(200);
    for (const t of [
      "query2.finance.yahoo.com:443",
      "finance.yahoo.com:443",
      "query1.finance.yahoo.com.evil.test:443",
      "m.stock.naver.com:443",
      "query1.finance.yahoo.com:80",
      "127.0.0.1:443",
    ])
      expect(await connect(t), t).toBe(403);
  });

  it("the worker's raw job: cookies and the crumb stay inside, only data steps come back", async () => {
    const seen: string[] = [];
    const site = http.createServer((req, res) => {
      seen.push(`${req.url} cookie=${req.headers.cookie ?? ""}`);
      if (req.url === "/cookie")
        return res.writeHead(404, { "set-cookie": "A3=s3ss10n; Path=/" }).end("nope");
      if (req.url === "/crumb")
        return req.headers.cookie === "A3=s3ss10n"
          ? res.writeHead(200, { "content-type": "text/plain" }).end("cRuMb.42/x")
          : res.writeHead(401).end();
      if (req.url === "/data?crumb=cRuMb.42%2Fx")
        return res.writeHead(200, { "content-type": "application/json; charset=utf-8" }).end('{"ok":1}');
      res.writeHead(400).end();
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", () => r()));
    closers.push(() => new Promise((r) => site.close(r)));
    const sitePort = (site.address() as AddressInfo).port;
    const proxy = await startEgressProxy({
      allow: ["fin.test"],
      ports: [80],
      lookup: async () => ["93.184.216.34"],
      connect: () => net.connect(sitePort, "127.0.0.1"),
    });
    closers.push(() => proxy.close());
    const r = (await runWorker(
      {
        op: "raw",
        steps: [
          { url: "http://fin.test/cookie", mode: "cookie" },
          { url: "http://fin.test/crumb", mode: "capture", capture: "crumb" },
          { url: "http://fin.test/data?crumb={crumb}" },
        ],
      },
      { proxy: proxy.url },
    )) as { ok: boolean; responses: unknown[] };
    expect(r).toEqual({
      ok: true,
      responses: [{ status: 200, contentType: "application/json", body: '{"ok":1}' }],
    });
    expect(JSON.stringify(r)).not.toContain("s3ss10n");
    expect(seen).toEqual([
      "/cookie cookie=",
      "/crumb cookie=A3=s3ss10n",
      "/data?crumb=cRuMb.42%2Fx cookie=A3=s3ss10n",
    ]);
    // Off the allow-list: refused by the proxy.
    expect(
      await runWorker({ op: "raw", steps: [{ url: "http://other.test/x" }] }, { proxy: proxy.url }),
    ).toEqual({
      ok: false,
      code: "web_blocked",
    });
    expect(await runWorker({ op: "raw", steps: [] }, { proxy: proxy.url })).toEqual({
      ok: false,
      code: "web_bad_input",
    });
  });
});

// ---- per-user visibility ----------------------------------------------------------------------------------

describe("who gets the finance tools (#30, FR-1.6)", () => {
  function setup() {
    const db = createTestDb();
    const users = new UserStore(db);
    const mom = users.create({ email: "mom@example.com", name: "엄마", role: "member", passwordHash: "x" });
    const son = users.create({
      email: "son@example.com",
      name: "아들",
      role: "member",
      passwordHash: "x",
      youth: true,
    });
    const tokens = new McpTokens();
    const logs: Record<string, unknown>[] = [];
    const exchanges = fixtures.find((f) => f.name === "kr_quote-saturday")!.fixture.exchanges;
    const svc = new McpService(tokens, users, {
      skills: [SELFTEST_SKILL],
      egress: () => ({ endpoint: async () => ({ ...PROXY, close: async () => {} }), close: async () => {} }),
      finance: {
        secrets: SECRETS,
        worker: replayWorker(exchanges).worker,
        now: () => T("2026-11-14T11:00:00+09:00"),
      },
      log: {
        info: (o: Record<string, unknown>, msg: string) => logs.push({ ...o, msg }),
        warn: (o: Record<string, unknown>, msg: string) => logs.push({ ...o, msg }),
      } as never,
    });
    closers.push(() => svc.close());
    return { users, mom, son, tokens, svc, logs };
  }
  const finance = (names: string[]) => names.filter((n) => FINANCE_TOOLS.some((t) => t.name === n));

  it("adults get them; a youth account with the default 'all' does not — not listed, refused when called", async () => {
    const { mom, son, svc, tokens } = setup();
    expect(finance(svc.toolNamesFor(mom.id))).toEqual(FINANCE_TOOLS.map((t) => t.name));
    expect(finance(svc.toolNamesFor(son.id))).toEqual([]);
    expect(svc.toolNamesFor(son.id)).toContain("echo_time");
    for (const e of SKILL_CATALOGUE.filter((x) => x.finance)) {
      expect(svc.allows(mom.id, e.name)).toBe(true);
      expect(svc.allows(son.id, e.name)).toBe(false);
    }
    expect(svc.allows(son.id, "google-news-search-skill")).toBe(true);
    const { url } = await svc.endpoint();
    const t = tokens.issue({
      userId: son.id,
      conversationId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
    });
    const r = await callOurTool(url, t, "kr_quote", { code: "005930" });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).not.toContain("206000");
    const listed = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${t}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    }).then((x) => x.json() as Promise<{ result: { tools: { name: string }[] } }>);
    expect(finance(listed.result.tools.map((x) => x.name))).toEqual([]);
  });

  it("an explicit list turns on exactly the named finance skills, also for a youth account", async () => {
    const { users, son, svc, tokens, logs } = setup();
    users.setSkills(son.id, ["kr-stock-skill"]);
    expect(finance(svc.toolNamesFor(son.id))).toEqual(
      FINANCE_TOOLS.filter((t) => t.skill === "kr-stock-skill").map((t) => t.name),
    );
    const { url } = await svc.endpoint();
    const t = tokens.issue({
      userId: son.id,
      conversationId: crypto.randomUUID(),
      runId: crypto.randomUUID(),
    });
    const ok = await callOurTool(url, t, "kr_quote", { code: "005930" });
    expect(ok.isError).toBe(false);
    expect(JSON.parse(ok.content[0]!.text!)).toMatchObject({ price: { value: 206000, kind: "close" } });
    // Taken away mid-run: the next call is refused.
    users.setSkills(son.id, []);
    const no = await callOurTool(url, t, "kr_quote", { code: "005930" });
    expect(no.isError).toBe(true);
    // Not even listed for that request any more. A call already past the listing (the permission changed
    // between the tool list and the call) is refused by the call itself.
    const host = (
      svc as unknown as { host(): { runTool(n: string, i: unknown, s: unknown): Promise<unknown> } }
    ).host();
    const scope = { userId: son.id, conversationId: crypto.randomUUID(), runId: crypto.randomUUID() };
    expect(await host.runTool("kr_quote", { code: "005930" }, scope)).toEqual({
      ok: false,
      code: "finance_not_allowed",
    });
    // The log: tool, outcome code, ids — never the code asked for or the numbers.
    const fin = logs.filter((l) => l.msg === "finance.finished").map((l) => sanitizeRecord(l));
    expect(fin.map((l) => [l.tool, l.status, l.financeCode])).toEqual([
      ["kr_quote", "ok", undefined],
      ["kr_quote", "error", "finance_not_allowed"],
    ]);
    expect(JSON.stringify(fin)).not.toMatch(/005930|206000/);
  });

  it("finance codes are loggable, and the finance instructions see the new tools", () => {
    expect([...LOGGABLE_FINANCE_CODES].sort()).toEqual([...FINANCE_CODES].sort());
    for (const t of FINANCE_TOOLS) {
      expect(isFinanceTool(t.name)).toBe(true);
      expect(isFinanceTool(`mcp__agentlee__${t.name}`)).toBe(true);
    }
    expect(isFinanceTool("web_fetch")).toBe(false);
  });
});

// ---- the answer check ---------------------------------------------------------------------------------------

describe("finance output check (#30)", () => {
  const meta = (source: string, asOf: string, timeZone: string) =>
    ({ source, asOf, timeZone, delayed: false, kind: "close" }) as FinanceMeta;
  const yahoo = meta("Yahoo Finance", "2026-11-13T16:00:00-05:00", "America/New_York");
  const naver = meta("네이버 증권", "2026-11-13T15:30:00+09:00", "Asia/Seoul");
  const src = (m: FinanceMeta) => ({ ...m, label: financeLabel(m) });
  const parts = (text: string, outputs: unknown[], name = "mcp__agentlee__us_quote"): MessagePart[] => [
    ...outputs.flatMap((output, i): MessagePart[] => [
      { type: "tool_call", id: `c${i}`, name, input: {} },
      { type: "tool_result", callId: `c${i}`, output },
    ]),
    { type: "text", text },
  ];

  it("names a source and an as-of date — in any of the usual spellings", () => {
    const s = [src(yahoo), src(naver)];
    expect(checkAnswer("AAPL 348.51달러", s)).toEqual(["source", "as_of"]);
    expect(checkAnswer("AAPL 348.51달러 (Yahoo Finance)", s)).toEqual(["as_of"]);
    expect(checkAnswer("AAPL 348.51달러 (11월 13일 종가)", s)).toEqual(["source"]);
    for (const ok of [
      "야후 파이낸스 기준 2026-11-13 종가 348.51달러",
      "Yahoo · 2026.11.13 종가 348.51",
      "네이버 기준 11/13 종가 206,000원",
      "네이버 증권 2026년 11월 13일 206,000원",
    ])
      expect(checkAnswer(ok, s), ok).toEqual([]);
    // Another day is not the as-of date.
    expect(checkAnswer("Yahoo 기준 11월 12일 348.51달러", s)).toEqual(["as_of"]);
    expect(checkAnswer("Yahoo 기준 11/130 348.51달러", s)).toEqual(["as_of"]);
    // No figures, nothing to check.
    expect(checkAnswer("조회하지 못했어요.", s)).toEqual([]);
  });

  it("the note: sources of the run's finance results, what was missing, and always the disclaimer", () => {
    const out = finalize("us_quote", { price: { value: 348.51, ...yahoo } });
    const n = financeNote(parts("AAPL은 348.51달러예요.", [out]))!;
    expect(n).toEqual({
      type: "finance_note",
      sources: [src(yahoo)],
      missing: ["source", "as_of"],
      disclaimer: FINANCE_DISCLAIMER,
    });
    expect(financeNote(parts("Yahoo Finance · 2026-11-13 16:00 ET 종가 348.51달러", [out]))!.missing).toEqual(
      [],
    );
    // A result without stamps (the kr-stock-skill fallback) or with flagged records: tool_meta.
    expect(
      financeNote(parts("206,000원", [{ value: 206000 }], "mcp__agentlee__skill_kr-stock-skill"))!.missing,
    ).toContain("tool_meta");
    const flagged = finalize("us_quote", { price: { value: 1, ...yahoo, asOf: null } });
    expect(financeNote(parts("Yahoo 2026-11-13 1달러", [flagged]))!.missing).toEqual([
      "source",
      "as_of",
      "tool_meta",
    ]);
    // Errors carry no numbers; a non-finance tool is not a finance answer.
    expect(financeEvidence(parts("x", [{ error: "finance_not_found" }])).sources).toEqual([]);
    expect(financeNote(parts("3 results", [{ results: [] }], "mcp__agentlee__web_search"))).toBeUndefined();
    // Nothing written: no note.
    expect(financeNote(parts("", [out]))).toBeUndefined();
    // A follow-up stating figures carries the sources of the answer before.
    expect(financeNote([{ type: "text", text: "원화로 약 51만 원이에요." }], [src(yahoo)])).toMatchObject({
      sources: [src(yahoo)],
      missing: ["source", "as_of"],
    });
    expect(financeNote([{ type: "text", text: "천만에요!" }], [src(yahoo)])).toBeUndefined();
  });
});
