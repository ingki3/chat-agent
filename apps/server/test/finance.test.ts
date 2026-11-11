import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
import {
  checkAnswer,
  FINANCE_CONTEXT_MESSAGES,
  financeContext,
  financeEvidence,
  figuresOf,
  financeNote,
} from "../src/finance/checker.js";
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
const TLS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/tls");
/** Self-signed, test-only certificate for `public.test` (web-fixture.ts). */
const TEST_CA = fs.readFileSync(path.join(TLS_DIR, "test-only.crt"), "utf8");
const TEST_KEY = fs.readFileSync(path.join(TLS_DIR, "test-only.key"), "utf8");
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

  it("a value from before the close is never relabelled as the close (review #93 round 1)", () => {
    const at = (t: string, now: string, closed?: boolean) =>
      marketStamp({
        market: "US",
        t: T(t),
        now: T(now),
        source: "Yahoo Finance",
        ...(closed ? { closed } : {}),
      });
    // 15:40 seen at 16:01: still the 15:40 value, delayed and stale — the close is not known yet.
    expect(at("2026-11-13T15:40:00-05:00", "2026-11-13T16:01:00-05:00")).toMatchObject({
      kind: "intraday",
      asOf: "2026-11-13T15:40:00-05:00",
      delayed: true,
      stale: true,
    });
    // On Saturday a Friday 15:59 value is not Friday's close either.
    expect(at("2026-11-13T15:59:00-05:00", "2026-11-14T10:00:00+09:00")).toMatchObject({
      kind: "intraday",
      asOf: "2026-11-13T15:59:00-05:00",
      stale: true,
    });
    // The source says it is the close, or the time is at/after the close: 종가.
    expect(at("2026-11-13T15:59:59-05:00", "2026-11-14T10:00:00+09:00", true)).toMatchObject({
      kind: "close",
      asOf: "2026-11-13T16:00:00-05:00",
      delayed: false,
    });
    expect(at("2026-11-13T16:00:00-05:00", "2026-11-13T16:01:00-05:00")).toMatchObject({ kind: "close" });
    expect(at("2026-11-13T16:00:00-05:00", "2026-11-13T16:01:00-05:00")).not.toHaveProperty("stale");
    // A real-time source (no delay) is still "delayed" once its value is behind the session's end.
    expect(
      marketStamp({
        market: "KRX",
        t: T("2026-11-12T15:20:00+09:00"),
        now: T("2026-11-12T16:00:00+09:00"),
        source: "네이버 증권",
        delayMinutes: 0,
      }),
    ).toMatchObject({ kind: "intraday", asOf: "2026-11-12T15:20:00+09:00", delayed: true, stale: true });
    // FX: on a weekday an old tick stays intraday and stale; on the weekend the last tick is the close.
    expect(
      marketStamp({
        market: "FX",
        t: T("2026-11-12T08:00:00-05:00"),
        now: T("2026-11-12T12:00:00-05:00"),
        source: "Yahoo Finance",
      }),
    ).toMatchObject({ kind: "intraday", delayed: true, stale: true });
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

  it("every configured secret is scrubbed from a result, however short (SEC_USER_AGENT may be 5 characters)", async () => {
    const f = fixtures.find((x) => x.name === "sec_form4")!.fixture;
    const ua = "ab cd";
    const echoed = f.exchanges.map((e) => ({
      ...e,
      body: { ...(e.body as Record<string, unknown>), name: `Apple Inc. (asked by ${ua})` },
    }));
    const r = replayWorker(echoed);
    const svc = new FinanceService(r.worker, async () => PROXY, {
      secrets: { SEC_USER_AGENT: ua },
      now: () => T(f.now),
    });
    const out = await svc.run(toolOf("sec_form4"), f.input);
    expect(out.ok).toBe(true);
    expect(JSON.stringify(out)).not.toContain(ua);
    expect(JSON.stringify(out)).toContain("[redacted]");
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

  it("the worker's raw job: cookies and the crumb stay inside, reflected ones are scrubbed, TLS on every hop", async () => {
    const seen: string[] = [];
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      seen.push(`${req.url} cookie=${req.headers.cookie ?? ""}`);
      if (req.url === "/cookie")
        return res.writeHead(404, { "set-cookie": "A3=s3ss10n; Path=/" }).end("nope");
      if (req.url === "/crumb")
        return req.headers.cookie === "A3=s3ss10n"
          ? res.writeHead(200, { "content-type": "text/plain" }).end("cRuMb.42/x")
          : res.writeHead(401).end();
      if (req.url === "/data?crumb=cRuMb.42%2Fx")
        // A server that reflects the session: plain, JSON-escaped, unicode-escaped and URL-encoded.
        return res
          .writeHead(200, { "content-type": "application/json; charset=utf-8" })
          .end(
            '{"ok":1,"a":"cRuMb.42/x","b":"cRuMb.42\\/x","c":"\\u0073\\u0033ss10n","d":"cRuMb.42%2Fx","price":206000}',
          );
      if (req.url === "/downgrade")
        return res.writeHead(302, { location: "http://public.test:443/ua" }).end();
      res.writeHead(400).end();
    };
    const tlsSite = https.createServer({ key: TEST_KEY, cert: TEST_CA }, handler);
    const plain = http.createServer(handler);
    for (const srv of [tlsSite, plain]) {
      await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
      closers.push(() => new Promise((r) => srv.close(r)));
    }
    const tlsPort = (tlsSite.address() as AddressInfo).port;
    const plainPort = (plain.address() as AddressInfo).port;
    const proxy = await startEgressProxy({
      allow: ["public.test"],
      ports: [80, 443],
      lookup: async () => ["93.184.216.34"],
      connect: (_ip, p) => net.connect(p === 443 ? tlsPort : plainPort, "127.0.0.1"),
    });
    closers.push(() => proxy.close());
    const o = { proxy: proxy.url, ca: TEST_CA };
    const r = (await runWorker(
      {
        op: "raw",
        steps: [
          { url: "https://public.test/cookie", mode: "cookie" },
          { url: "https://public.test/crumb", mode: "capture", capture: "crumb" },
          { url: "https://public.test/data?crumb={crumb}" },
        ],
      },
      o,
    )) as { ok: boolean; responses: { body: string }[] };
    expect(r).toEqual({
      ok: true,
      responses: [
        {
          status: 200,
          contentType: "application/json",
          body: '{"ok":1,"a":"[redacted]","b":"[redacted]","c":"[redacted]","d":"[redacted]","price":206000}',
        },
      ],
    });
    expect(JSON.stringify(r)).not.toMatch(/s3ss10n|cRuMb/);
    expect(seen).toEqual([
      "/cookie cookie=",
      "/crumb cookie=A3=s3ss10n",
      "/data?crumb=cRuMb.42%2Fx cookie=A3=s3ss10n",
    ]);
    // No plain http, neither asked for nor by a redirect to `http://allowed-host:443/` (the proxy would let that
    // port through): refused before anything is sent.
    seen.length = 0;
    for (const steps of [
      [{ url: "http://public.test/data", headers: { "user-agent": "AgentLee x@example.com" } }],
      [{ url: "https://public.test/downgrade", headers: { "user-agent": "AgentLee x@example.com" } }],
    ])
      expect(await runWorker({ op: "raw", steps }, o)).toEqual({ ok: false, code: "web_blocked" });
    expect(seen).toEqual(["/downgrade cookie="]);
    // Off the allow-list: refused by the proxy.
    expect(await runWorker({ op: "raw", steps: [{ url: "https://other.test/x" }] }, o)).toEqual({
      ok: false,
      code: "web_blocked",
    });
    expect(await runWorker({ op: "raw", steps: [] }, o)).toEqual({ ok: false, code: "web_bad_input" });
    // General web fetch keeps plain http.
    expect(await runWorker({ op: "fetch", url: "http://public.test/cookie" }, o)).toMatchObject({
      ok: false,
      code: "web_http_error",
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
  const meta = (source: string, asOf: string, timeZone: string, kind = "close") =>
    ({ source, asOf, timeZone, delayed: false, kind }) as FinanceMeta;
  const yahoo = meta("Yahoo Finance", "2026-11-13T16:00:00-05:00", "America/New_York");
  const naver = meta("네이버 증권", "2026-11-13T15:30:00+09:00", "Asia/Seoul");
  const live = meta("네이버 증권", "2026-11-12T10:14:00+09:00", "Asia/Seoul", "intraday");
  const src = (m: FinanceMeta) => ({ ...m, label: financeLabel(m) });
  const usOut = finalize("us_quote", { symbol: "AAPL", price: { value: 349.8, ...yahoo } });
  const krOut = finalize("kr_quote", {
    code: "005930",
    name: "삼성전자",
    price: { value: 206000, ...naver },
  });
  const parts = (text: string, outputs: unknown[], name = "mcp__agentlee__us_quote"): MessagePart[] => [
    ...outputs.flatMap((output, i): MessagePart[] => [
      { type: "tool_call", id: `c${i}`, name, input: {} },
      { type: "tool_result", callId: `c${i}`, output },
    ]),
    { type: "text", text },
  ];
  const ev = (outputs: unknown[]) => financeEvidence(parts("", outputs));
  const check = (text: string, outputs: unknown[] = [usOut, krOut]) => checkAnswer(text, ev(outputs));

  it("names a source and an as-of date — in any of the usual spellings", () => {
    expect(check("AAPL 349.8달러")).toEqual(["source", "as_of"]);
    expect(check("AAPL 349.8달러 (Yahoo Finance)")).toEqual(["as_of"]);
    expect(check("AAPL 349.8달러 (11월 13일 종가)")).toEqual(["source"]);
    for (const ok of [
      "야후 파이낸스 기준 2026-11-13 종가 349.80달러",
      "Yahoo · 2026.11.13 종가 349.8",
      "네이버 기준 11/13 종가 206,000원",
      "네이버 증권 2026년 11월 13일 206,000원",
    ])
      expect(check(ok), ok).toEqual([]);
    // Another day is not the as-of date.
    expect(check("Yahoo 기준 11월 12일 349.8달러")).toEqual(["as_of"]);
    expect(check("Yahoo 기준 11/130 349.8달러")).toEqual(["as_of"]);
    // No figures, nothing to check.
    expect(check("조회하지 못했어요.")).toEqual([]);
  });

  it("every figure needs its own source and as-of — one cited value does not cover the others", () => {
    // Review #93 round 1: Yahoo and Naver numbers, only Yahoo cited.
    expect(check("Yahoo 2026-11-13 기준 AAPL 349.8달러. 삼성전자 206,000원.")).toEqual(["source", "as_of"]);
    // The other value's source with its date, but not the value's own: still missing.
    expect(check("삼성전자 206,000원 (Yahoo Finance · 2026-11-13).")).toEqual(["source"]);
    expect(check("Yahoo 기준 11월 13일 AAPL 349.8달러, 네이버 증권 기준 삼성전자 206,000원.")).toEqual([]);
    // A header (or footnote) sentence without figures covers its paragraph — not the next one.
    expect(check("Yahoo Finance · 2026-11-13 16:00 ET 종가 기준\n- AAPL 349.8달러\n- 합계 350달러")).toEqual(
      [],
    );
    expect(check("AAPL 349.8달러\n(출처: Yahoo Finance, 11월 13일 종가)")).toEqual([]);
    expect(check("Yahoo Finance · 2026-11-13 종가\n\n삼성전자 206,000원")).toEqual(["source", "as_of"]);
  });

  it("an intraday value needs its time with its zone", () => {
    const out = finalize("kr_quote", { code: "005930", price: { value: 198100, ...live } });
    expect(check("네이버 증권 11월 12일 198,100원", [out])).toEqual(["as_of"]);
    expect(check("네이버 증권 11월 12일 10:14 198,100원", [out])).toEqual(["as_of"]);
    expect(check("네이버 증권 11월 12일 10:14 KST 장중 198,100원", [out])).toEqual([]);
  });

  it("identifiers are not figures: forms, codes, tickers, index names, dates, ordinals", () => {
    const disclosure = finalize("sec_8k", {
      items: [
        {
          n: 1,
          form: "8-K",
          url: "x",
          ...meta("SEC EDGAR", "2026-11-09T16:30:40-05:00", "America/New_York", "filing"),
        },
      ],
    });
    for (const t of [
      "8-K 공시를 조회하지 못했어요.",
      "Form 4와 13F-HR, 10-Q 공시는 없어요.",
      "005930(삼성전자)과 KODEX 200, S&P 500 정보를 찾지 못했어요.",
      "3분기 실적 발표는 2027년 1월 28일이에요.",
      "두 번째 질문에 답하면, [1] 항목은 item 2.02예요.",
    ])
      expect(check(t, [disclosure, krOut]), t).toEqual([]);
    expect(figuresOf("1. AAPL 349.8달러\n2. 삼성전자 206,000원").map((f) => f.n)).toEqual([349.8, 206000]);
    // A result's own codes and names count as identifiers too.
    expect(
      checkAnswer(
        "373220(LG에너지솔루션) 시세를 못 가져왔어요.",
        ev([finalize("kr_quote", { code: "373220" })]),
      ),
    ).toEqual([]);
    expect(
      checkAnswer(
        "KODEX 200(069500) 시세를 못 가져왔어요.",
        ev([finalize("kr_etf", { code: "069500", name: "KODEX 200" })]),
      ),
    ).toEqual([]);
  });

  it("the note: sources of the run's finance results, what was missing, and always the disclaimer", () => {
    const n = financeNote(parts("AAPL은 349.8달러예요.", [usOut]))!;
    expect(n).toEqual({
      type: "finance_note",
      sources: [src(yahoo)],
      missing: ["source", "as_of"],
      disclaimer: FINANCE_DISCLAIMER,
    });
    expect(
      financeNote(parts("Yahoo Finance · 2026-11-13 16:00 ET 종가 349.8달러", [usOut]))!.missing,
    ).toEqual([]);
    // A result without stamps (the kr-stock-skill fallback) or with flagged records: tool_meta.
    expect(
      financeNote(parts("206,000원", [{ value: 206000 }], "mcp__agentlee__skill_kr-stock-skill"))!.missing,
    ).toContain("tool_meta");
    const flagged = finalize("us_quote", { price: { value: 1, ...yahoo, asOf: null } });
    // The flagged value has no stamp to cite: its figure is unsourced too.
    expect(financeNote(parts("Yahoo 2026-11-13 1달러", [flagged]))!.missing).toEqual([
      "source",
      "as_of",
      "tool_meta",
    ]);
    // Errors carry no numbers; a non-finance tool is not a finance answer.
    expect(financeEvidence(parts("x", [{ error: "finance_not_found" }])).sources).toEqual([]);
    expect(financeNote(parts("3 results", [{ results: [] }], "mcp__agentlee__web_search"))).toBeUndefined();
    // Nothing written: no note.
    expect(financeNote(parts("", [usOut]))).toBeUndefined();
  });

  it("follow-ups: finance results anywhere in the recent conversation keep it checked", () => {
    const history = [
      { role: "user", parts: [{ type: "text", text: "AAPL, 005930 현재가" }] },
      { role: "assistant", parts: parts("AAPL 349.8달러, 삼성전자 206,000원", [usOut, krOut]) },
      { role: "user", parts: [{ type: "text", text: "종가라는 뜻이야?" }] },
      { role: "assistant", parts: [{ type: "text", text: "네, 정규장 마감 가격이에요." }] },
      { role: "user", parts: [{ type: "text", text: "두 주 가격은?" }] },
    ];
    const ctx = financeContext(history)!;
    expect(ctx.sources).toEqual([src(yahoo), src(naver)]);
    expect(financeNote([{ type: "text", text: "349.8달러와 206,000원이에요." }], ctx)).toMatchObject({
      sources: [src(yahoo), src(naver)],
      missing: ["source", "as_of"],
    });
    expect(
      financeNote(
        [{ type: "text", text: "Yahoo 11월 13일 종가 349.8달러, 네이버 증권 11월 13일 종가 206,000원." }],
        ctx,
      )!.missing,
    ).toEqual([]);
    expect(financeNote([{ type: "text", text: "천만에요!" }], ctx)).toBeUndefined();
    // Out of the window: no longer a finance conversation.
    const old = [
      ...history.slice(0, 2),
      ...Array.from({ length: FINANCE_CONTEXT_MESSAGES }, () => history[3]!),
    ];
    expect(financeContext(old)).toBeUndefined();
    expect(financeContext(history.slice(2))).toBeUndefined();
  });
});
