import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  CitationNotePart,
  CITATION_LIMITS,
  CITATION_STATUS_TEXT,
  citationMarkers,
  citationUnits,
  citationVerified,
  FINANCE_DISCLAIMER,
  sentenceEndMarkers,
  uncitedUnits,
  type MessagePart,
} from "@agentlee/shared";
import { SELFTEST_SKILL } from "@agentlee/mcp-tools/skills";
import { UserStore } from "../src/auth/users.js";
import { citationNote } from "../src/citations/checker.js";
import { CitationStore, CiteRefused } from "../src/citations/store.js";
import { findSnippet, normalizeSnippet, normalizeWithMap, verifyStats } from "../src/citations/verify.js";
import { ConversationStore } from "../src/conversations/store.js";
import { createTestDb, type Db } from "../src/db/client.js";
import { citations, sources } from "../src/db/schema.js";
import { McpTokens } from "../src/isolation/tokens.js";
import { McpService } from "../src/mcp/service.js";
import { sanitizeRecord } from "../src/logging.js";
import { FIXTURE_PAGES, fixtureWebWorker } from "../src/runtime/fake-citations.js";
import { SourceStore } from "../src/web/sources.js";
import { callOurTool } from "./helpers/live-mcp.js";

/**
 * The citation check (#25, PRD FR-5.2, 수용 기준 3): the snippet must really be in the stored page text, the scope
 * comes from the run token only, and the end-of-run note never lets a failed or missing citation pass as normal.
 */

const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const BODY =
  "산업통상자원부는 10일 10월 반도체 수출이 전년 같은 달보다 32% 늘어난 142억 달러로 집계됐다고 밝혔다.\n" +
  'He said "Semiconductor exports rose 132% in October" — a record. 성장률은 3.5%였다. ＡＢＣ전자는 "최대 실적"이라고 했다.';

describe("snippet check: normalisation without fuzzy matches", () => {
  const found = (s: string, body = BODY) => findSnippet(body, s).found;

  it("whitespace, quote styles, NFKC, case, invisible characters and decomposed Hangul are normalised", () => {
    // A line break and double spaces in either text.
    expect(found("142억 달러로 집계됐다고 밝혔다. He said")).toBe(true);
    expect(found("32%  늘어난   142억 달러")).toBe(true);
    // Curly vs straight quotes, any style.
    expect(found("He said “Semiconductor exports rose 132% in October”")).toBe(true);
    expect(found("He said 'Semiconductor exports rose 132% in October'")).toBe(true);
    expect(found("ABC전자는 「최대 실적」이라고 했다")).toBe(true);
    // Fullwidth letters (NFKC) and case.
    expect(found('abc전자는 "최대 실적"')).toBe(true);
    expect(found("SEMICONDUCTOR EXPORTS ROSE 132%")).toBe(true);
    // The dash style.
    expect(found('October" - a record')).toBe(true);
    // A zero-width space and a soft hyphen inside the snippet; Hangul written decomposed (NFD).
    expect(found("반도\u200B체 수\u00AD출이 전년")).toBe(true);
    expect(found("반도체 수출이 전년 같은 달보다".normalize("NFD"))).toBe(true);
    expect(found("반도체 수출이 전년 같은 달보다", BODY.normalize("NFD"))).toBe(true);
    // Spaces of every width (round 3: an explicit fold instead of NFKC).
    expect(found("반도체 수출이 전년 같은 달보다", "반도체\u00A0수출이\u3000전년\u2009같은 달보다")).toBe(
      true,
    );
    // Quote marks and ellipses the model put around the passage.
    expect(found("“…반도체 수출이 전년 같은 달보다...”")).toBe(true);
  });

  it("the quote is the passage as it stands in the page", () => {
    expect(findSnippet(BODY, "abc전자는 「최대 실적」")).toEqual({
      found: true,
      quote: 'ＡＢＣ전자는 "최대 실적',
    });
    const m = findSnippet(BODY, "142억 달러로 집계됐다고 밝혔다. He said");
    expect(m).toEqual({ found: true, quote: "142억 달러로 집계됐다고 밝혔다. He said" });
  });

  it("no partial, fuzzy, joined or reordered matches", () => {
    // One character different, a paraphrase, a reordering.
    expect(found("반도체 수출이 전년 같은 달보다 33% 늘어난")).toBe(false);
    expect(found("반도체 수출이 작년보다 32% 늘었다")).toBe(false);
    expect(found("32% 늘어난 반도체 수출이 전년 같은 달보다")).toBe(false);
    // Two real passages joined with an ellipsis.
    expect(found("반도체 수출이 전년 … 142억 달러로 집계됐다고")).toBe(false);
    expect(found("반도체 수출이 전년...142억 달러로")).toBe(false);
    // Starts like the page and then goes on with something it does not say.
    expect(found("142억 달러로 집계됐다고 밝혔다. 역대 최대다")).toBe(false);
    // Inside a number or a word: "32%" is not in "132%", "3" is not "3.5", no word cut in half.
    expect(found("exports rose 32% in October")).toBe(false);
    expect(found("Semiconductor exports rose 13")).toBe(false);
    expect(found("성장률은 3였다")).toBe(false);
    expect(found("다. 성장률은 3")).toBe(false);
    expect(found("emiconductor exports rose")).toBe(false);
    expect(found("Semiconductor export")).toBe(false);
    expect(found("도체 수출이 전년 같은")).toBe(false);
    // A Korean particle after the end is fine.
    expect(found("10월 반도체 수출")).toBe(true);
  });

  it("not inside a decimal, a thousands group or after a sign (review #97)", () => {
    expect(found("32% increased this year", "Sales: 1.32% increased this year.")).toBe(false);
    expect(found("1.32% increased this year", "Sales: 1.32% increased this year.")).toBe(true);
    expect(found("234 units sold worldwide", "In total 1,234 units sold worldwide.")).toBe(false);
    expect(found("1,234 units sold worldwide", "In total 1,234 units sold worldwide.")).toBe(true);
    expect(found("32% 감소했다고 밝혔다", "매출은 -32% 감소했다고 밝혔다.")).toBe(false);
    expect(found("32% 감소했다고 밝혔다", "매출은 −32% 감소했다고 밝혔다.")).toBe(false);
    expect(found("32% 감소했다고 밝혔다", "매출은 32% 감소했다고 밝혔다.")).toBe(true);
    // A sentence end before a number is not a decimal point.
    expect(found("32% 늘었다고 밝혔다", "끝났다. 32% 늘었다고 밝혔다.")).toBe(true);
  });

  it("HTML entities, line-end hyphens (not joined) and inline footnote numbers in the page (review #97)", () => {
    const page =
      "기온은 &minus;5도로 떨어졌다 &amp; 눈이 왔다. 수치는 &#8722;3&nbsp;% 였다. 값은 &#x2212;7이다.";
    expect(found("기온은 −5도로 떨어졌다 & 눈이 왔다", page)).toBe(true);
    expect(found("기온은 -5도로 떨어졌다", page)).toBe(true);
    expect(found("수치는 -3 % 였다", page)).toBe(true);
    expect(found("값은 −7이다.", page)).toBe(true);
    expect(
      findSnippet(page, "기온은 −5도로 떨어졌다").found && findSnippet(page, "기온은 −5도로 떨어졌다"),
    ).toEqual({
      found: true,
      quote: "기온은 &minus;5도로 떨어졌다",
    });
    // An unknown or broken entity stays as written.
    expect(found("a &bogus; b c d e", "x a &bogus; b c d e")).toBe(true);
    // Round 3: a hyphen at a line end is never joined — it stays a hyphen and a space (x−y is not xy, re-sign is
    // not resign). A wrapped word then shows as not found (⚠️), which is acceptable.
    const wrapped =
      "Semicon-\nductor exports rose sharply. They re-\nsign the deal. Then x\u2212\ny was used.";
    expect(found("Semiconductor exports rose sharply", wrapped)).toBe(false);
    expect(found("Semicon- ductor exports rose sharply", wrapped)).toBe(true);
    expect(found("They resign the deal", wrapped)).toBe(false);
    expect(found("Then xy was used", wrapped)).toBe(false);
    expect(found("Then x- y was used", wrapped)).toBe(true);
    expect(found("Semiconductor exports rose", "Semicon-\r\nductor exports rose.")).toBe(false);
    // Round 4: footnote marks are never removed — the page is compared as written. A quote that leaves one out is
    // not found (⚠️); one that keeps it is.
    const notes = "수출이 크게 늘었다[3]. 업계는 반겼다²³. 정부는 지원을 약속했다[12][13].";
    expect(found("수출이 크게 늘었다. 업계는 반겼다.", notes)).toBe(false);
    expect(found("정부는 지원을 약속했다.", notes)).toBe(false);
    expect(found("수출이 크게 늘었다[3]. 업계는", notes)).toBe(true);
    expect(found("업계는 반겼다²³. 정부는", notes)).toBe(true);
    expect(found("said so. Then they left", "They said so.¹ Then they left.")).toBe(false);
    // Different array elements are different text.
    expect(found("the value of arr[2] is used", "the value of arr[1] is used here.")).toBe(false);
    expect(found("the value of arr is used", "the value of arr[1] is used here.")).toBe(false);
    expect(found("the value of arr[1] is used", "the value of arr[1] is used here.")).toBe(true);
    // Superscripts after a digit or a unit are exponents (and no NFKC: ² is not 2).
    expect(found("참가자는 10만 명이었다", "참가자는 10²만 명이었다.")).toBe(false);
    expect(found("참가자는 102만 명이었다", "참가자는 10²만 명이었다.")).toBe(false);
    expect(found("참가자는 10²만 명이었다", "참가자는 10²만 명이었다.")).toBe(true);
    expect(found("넓이는 (10) 제곱미터였다", "넓이는 (10)² 제곱미터였다.")).toBe(false);
    expect(found("넓이는 (10)2 제곱미터였다", "넓이는 (10)² 제곱미터였다.")).toBe(false);
    expect(found("물 분자는 H2O 이다", "물 분자는 H₂O 이다.")).toBe(false);
    expect(found("첫째는 1 항목이다", "첫째는 ① 항목이다.")).toBe(false);
    expect(found("넓이는 10 제곱미터였다", "넓이는 10² 제곱미터였다.")).toBe(false);
    expect(found("업계는 반겼다정부는 지원했다", "업계는 반겼다²정부는 지원했다.")).toBe(false);
    expect(found("면적은 32m³ 이었다", "면적은 32m² 이었다.")).toBe(false);
    expect(found("면적은 32m 이었다", "면적은 32m² 이었다.")).toBe(false);
    expect(found("면적은 32m² 이었다", "면적은 32m² 이었다.")).toBe(true);
    expect(found("값은 1234원이었다", "값은 12[3]34원이었다.")).toBe(false);
    expect(found("값은 12원이었다", "값은 12[3]원이었다.")).toBe(false);
    expect(found("값은 34원이었다고", "값은 [3]34원이었다고 했다.")).toBe(false);
  });

  it("a match neither starts nor ends inside a token (round 4)", () => {
    // The three review cases: the quote stops right before a superscript or subscript.
    expect(found("면적은 정확히 32m", "면적은 정확히 32m² 이었다.")).toBe(false);
    expect(found("넓이는 정확히 (10)", "넓이는 정확히 (10)² 이었다.")).toBe(false);
    expect(found("이 물질의 화학식은 H", "이 물질의 화학식은 H₂O 이다.")).toBe(false);
    // Modifier letters and marks count too; the start mirrors the end.
    expect(found("value was abcdefgh", "the value was abcdefghʰ ok")).toBe(false);
    // A combining mark that does not compose (x + U+0333) is part of the token.
    expect(found("value was abcdefgx", "the value was abcdefgx\u0333 ok")).toBe(false);
    expect(found("value was abcdefgx\u0333", "the value was abcdefgx\u0333 ok")).toBe(true);
    expect(found("conductor exports rose", "Semiconductor exports rose.")).toBe(false);
    expect(found("도체 수출이 전년 같은", "반도체 수출이 전년 같은 달.")).toBe(false);
    expect(found("% 늘었다고 밝혔다", "매출은 132% 늘었다고 밝혔다.")).toBe(false);
    expect(found("₂O 분자가 있었다", "그 안에 H₂O 분자가 있었다.")).toBe(false);
    // Positive controls: whole tokens, a Korean particle, a quote that ends its sentence.
    expect(found("면적은 정확히 32m²", "면적은 정확히 32m² 이었다.")).toBe(true);
    expect(found("이 물질의 화학식은 H₂O", "이 물질의 화학식은 H₂O 이다.")).toBe(true);
    expect(found("10월 반도체 수출", "10월 반도체 수출이 늘었다.")).toBe(true);
    expect(found("수출이 크게 늘었다.", "수출이 크게 늘었다.[3] 업계는")).toBe(true);
    expect(found("Exports rose sharply.", "Exports rose sharply.²")).toBe(true);
    // …but a full stop is not a sentence end inside a decimal.
    expect(found("성장률은 무려 3.", "성장률은 무려 3.5%였다.")).toBe(false);
  });

  it("at the stored body cap one check stays well inside one event-loop turn, and repeats hit the cache", () => {
    const base =
      "산업통상자원부는 10일 10월 반도체 수출이 전년 같은 달보다 32% 늘어난 142억 달러로 집계됐다. Exports “rose”. ";
    const body = base.repeat(Math.ceil(400_000 / base.length)).slice(0, 400_000);
    normalizeWithMap(base); // warm the character caches the first page would warm
    let t = performance.now();
    expect(findSnippet(body, "없는 구절이에요 정말로", "perf-key").found).toBe(false);
    const first = performance.now() - t;
    const normalized = verifyStats.normalized;
    t = performance.now();
    expect(findSnippet(body, "없는 다른 구절이에요", "perf-key").found).toBe(false);
    const again = performance.now() - t;
    expect(verifyStats.normalized).toBe(normalized + 1); // the snippet only: the page came from the cache
    // Measured 25–35 ms here (400k characters); generous bounds for slower CI machines.
    expect(first).toBeLessThan(250);
    expect(again).toBeLessThan(25);
    // A changed body under the same key is normalised again, not served from the cache.
    expect(findSnippet(`${body} 끝에 붙인 새 문장입니다`, "끝에 붙인 새 문장입니다", "perf-key").found).toBe(
      true,
    );
  });

  it("composed and decomposed accents are the same text (round 2)", () => {
    const nfc = "Le café prices rose sharply in Paris.";
    expect(found("café prices rose sharply", nfc.normalize("NFD"))).toBe(true);
    expect(found("café prices rose sharply".normalize("NFD"), nfc)).toBe(true);
    expect(found("cafe prices rose sharply", nfc)).toBe(false);
  });

  it("a snippet must say something: fewer than 8 normalised characters prove nothing", () => {
    expect(findSnippet(BODY, "  “32%”  ")).toEqual({ found: false, reason: "too_short" });
    expect(findSnippet(BODY, "반도체 수출이")).toEqual({ found: false, reason: "too_short" });
    expect(normalizeSnippet("  “Hello  World” ")).toBe("hello world");
  });
});

// ---- the store: scope from the token only ----------------------------------------------------------------------

function family(db: Db = createTestDb()) {
  const users = new UserStore(db);
  const mom = users.create({ email: "mom@example.com", name: "엄마", role: "member", passwordHash: "x" });
  const dad = users.create({ email: "dad@example.com", name: "아빠", role: "admin", passwordHash: "x" });
  const conversations = new ConversationStore(db);
  const c = conversations.create(mom.id);
  const other = conversations.create(mom.id);
  const dads = conversations.create(dad.id);
  const store = new SourceStore(db);
  const page = (scope: { userId: string; conversationId: string; runId: string }, i = 0) => {
    const p = FIXTURE_PAGES[i]!;
    return store.addPage(scope, {
      url: p.url,
      finalUrl: p.url,
      title: p.title,
      site: p.site,
      publishedAt: p.publishedAt,
      contentType: "text/html",
      body: p.text,
      truncated: false,
    })!;
  };
  const run = (conversationId: string, userId = mom.id) => ({
    userId,
    conversationId,
    runId: crypto.randomUUID(),
  });
  return { db, users, mom, dad, c, other, dads, sources: store, page, run, cites: new CitationStore(db) };
}

const SNIP = "10월 반도체 수출이 전년 같은 달보다 32% 늘어난";

describe("CitationStore (#25)", () => {
  it("verifies, numbers per run, and keeps the first number for the same snippet", () => {
    const f = family();
    const scope = f.run(f.c.id);
    const src = f.page(scope);
    const a = f.cites.cite(scope, { sourceId: src.id, snippet: SNIP });
    expect(a).toEqual({ n: 1, marker: "[1]", status: "verified", sourceId: src.id });
    // The same passage written differently: still one citation.
    expect(f.cites.cite(scope, { sourceId: src.id, snippet: `“${SNIP}”` }).n).toBe(1);
    const b = f.cites.cite(scope, { sourceId: src.id, snippet: "메모리 가격 회복이 증가를 이끌었다" });
    expect(b).toMatchObject({ n: 2, status: "verified" });
    const c = f.cites.cite(scope, { sourceId: src.id, snippet: "메모리 가격 하락이 감소를 불렀다" });
    expect(c).toMatchObject({ n: 3, status: "snippet_not_found" });
    // Another run of the same conversation numbers from 1 again.
    expect(f.cites.cite(f.run(f.c.id), { sourceId: src.id, snippet: SNIP }).n).toBe(1);
    const rows = f.cites.forRun(scope.runId);
    expect(rows.map((r) => [r.n, r.status, r.quote])).toEqual([
      [1, "verified", "10월 반도체 수출이 전년 같은 달보다 32% 늘어난"],
      [2, "verified", "메모리 가격 회복이 증가를 이끌었다"],
      [3, "snippet_not_found", null],
    ]);
    expect(rows[0]!.source?.id).toBe(src.id);
  });

  it("a search result (no page text) is fetch_failed", () => {
    const f = family();
    const scope = f.run(f.c.id);
    const hit = f.sources.addSearchResult(scope, {
      provider: "test",
      url: "https://news.example/a",
      title: "제목",
      site: "news.example",
      snippet: SNIP,
    })!;
    expect(f.cites.cite(scope, { sourceId: hit.id, snippet: SNIP })).toMatchObject({
      status: "fetch_failed",
    });
  });

  it("another conversation's or another user's source is unknown_source, and its id is not kept", () => {
    const f = family();
    const mine = f.page(f.run(f.other.id));
    const dads = f.page(f.run(f.dads.id, f.dad.id));
    const scope = f.run(f.c.id);
    for (const id of [mine.id, dads.id, "made-up", crypto.randomUUID()]) {
      const r = f.cites.cite(scope, { sourceId: id, snippet: SNIP });
      expect(r, id).toMatchObject({ status: "unknown_source", sourceId: null });
    }
    expect(
      f.db
        .select()
        .from(citations)
        .all()
        .map((r) => r.sourceId),
    ).toEqual([null]);
    // A row of this conversation that is somehow another user's (the owner check is the second line).
    f.db.update(sources).set({ conversationId: f.c.id }).where(eq(sources.id, dads.id)).run();
    expect(f.cites.cite(f.run(f.c.id), { sourceId: dads.id, snippet: SNIP }).status).toBe("unknown_source");
  });

  it("a token whose user does not own the conversation registers nothing", () => {
    const f = family();
    const src = f.page(f.run(f.c.id));
    expect(() => f.cites.cite(f.run(f.c.id, f.dad.id), { sourceId: src.id, snippet: SNIP })).toThrow(
      CiteRefused,
    );
    expect(f.db.select().from(citations).all()).toEqual([]);
  });

  it("an earlier answer's source is cited again and checked again against the stored text", () => {
    const f = family();
    const src = f.page(f.run(f.c.id));
    expect(f.cites.cite(f.run(f.c.id), { sourceId: src.id, snippet: SNIP }).status).toBe("verified");
    // The stored text is what counts — not the earlier result.
    f.db.update(sources).set({ body: "다른 글" }).where(eq(sources.id, src.id)).run();
    expect(f.cites.cite(f.run(f.c.id), { sourceId: src.id, snippet: SNIP }).status).toBe("snippet_not_found");
    f.db.update(sources).set({ body: null }).where(eq(sources.id, src.id)).run();
    expect(f.cites.cite(f.run(f.c.id), { sourceId: src.id, snippet: SNIP }).status).toBe("fetch_failed");
  });

  it("refuses too short a snippet and more than the per-run limit", () => {
    const f = family();
    const scope = f.run(f.c.id);
    const src = f.page(scope);
    expect(() => f.cites.cite(scope, { sourceId: src.id, snippet: "32%" })).toThrow("cite_snippet_too_short");
    for (let i = 0; i < CITATION_LIMITS.perRun; i++)
      f.cites.cite(scope, { sourceId: src.id, snippet: `없는 구절 번호 ${i}입니다` });
    expect(() => f.cites.cite(scope, { sourceId: src.id, snippet: SNIP })).toThrow("cite_limit");
  });
});

// ---- the tools on our MCP server ---------------------------------------------------------------------------

describe("cite and sources_list on our MCP server (#25)", () => {
  function service(f: ReturnType<typeof family>) {
    const tokens = new McpTokens();
    const logs: Record<string, unknown>[] = [];
    const log = {
      info: (o: Record<string, unknown>, msg: string) => logs.push({ ...o, msg }),
      warn: (o: Record<string, unknown>, msg: string) => logs.push({ ...o, msg }),
      error: (o: Record<string, unknown>, msg: string) => logs.push({ ...o, msg }),
    };
    const svc = new McpService(tokens, f.users, {
      skills: [SELFTEST_SKILL],
      log: log as never,
      web: {
        sources: f.sources,
        citations: f.cites,
        worker: fixtureWebWorker(),
        fetchProxy: {
          endpoint: async () => ({ url: "http://127.0.0.1:9", port: 9 }) as never,
          close: async () => {},
        },
        searchProviders: [],
      },
    });
    closers.push(() => svc.close());
    const call = async (
      scope: { userId: string; conversationId: string; runId: string },
      tool: string,
      args: unknown,
    ) => {
      const { url } = await svc.endpoint();
      const r = await callOurTool(url, tokens.issue(scope), tool, args);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(r.content[0]!.text!) as Record<string, unknown>;
      } catch {
        body = { text: r.content[0]?.text }; // the MCP SDK's own input validation answers in words
      }
      return { isError: r.isError, body };
    };
    return { svc, call, logs };
  }

  it("fetch → cite in the token's conversation; other conversations' ids are unknown_source; logs hold codes only", async () => {
    const f = family();
    const { svc, call, logs } = service(f);
    expect(svc.toolNamesFor(f.mom.id)).toEqual([
      "echo_time",
      "web_fetch",
      "sources_list",
      "cite",
      "skill_selftest",
    ]);
    const scope = f.run(f.c.id);
    const page = await call(scope, "web_fetch", { url: FIXTURE_PAGES[0]!.url });
    const sourceId = page.body.sourceId as string;
    const ok = await call(scope, "cite", { sourceId, snippet: SNIP });
    expect(ok).toMatchObject({
      isError: false,
      body: {
        n: 1,
        marker: "[1]",
        status: "verified",
        sourceId,
        site: "가나다 신문",
        url: FIXTURE_PAGES[0]!.url,
      },
    });
    // The same id through a token of another conversation (same user) and of another user.
    const elsewhere = await call(f.run(f.other.id), "cite", { sourceId, snippet: SNIP });
    expect(elsewhere.body).toMatchObject({ status: "unknown_source", sourceId: null });
    expect(elsewhere.body).not.toHaveProperty("url");
    const dad = await call(f.run(f.dads.id, f.dad.id), "cite", { sourceId, snippet: SNIP });
    expect(dad.body).toMatchObject({ status: "unknown_source", sourceId: null });
    // Strict input: no scope fields can be smuggled in.
    const smuggled = await call(f.run(f.other.id), "cite", {
      sourceId,
      snippet: SNIP,
      conversationId: f.c.id,
    });
    expect(smuggled.isError).toBe(true);
    const short = await call(scope, "cite", { sourceId, snippet: "32%" });
    expect(short).toEqual({ isError: true, body: { error: "cite_snippet_too_short" } });
    // A token for a conversation the user does not own.
    const notMine = await call(f.run(f.c.id, f.dad.id), "cite", { sourceId, snippet: SNIP });
    expect(notMine).toEqual({ isError: true, body: { error: "cite_not_allowed" } });

    const cites = logs.filter((l) => l.msg === "citation.finished").map((l) => sanitizeRecord(l));
    expect(cites.map((l) => l.citeCode)).toEqual([
      "verified",
      "unknown_source",
      "unknown_source",
      "cite_snippet_too_short",
      "cite_not_allowed",
    ]);
    const text = JSON.stringify(logs.map((l) => sanitizeRecord(l)));
    for (const secret of [sourceId, "반도체", "32%", FIXTURE_PAGES[0]!.url, "가나다"])
      expect(text).not.toContain(secret);
  });

  it("sources_list: this conversation's own sources, titles framed as external content", async () => {
    const f = family();
    const { call } = service(f);
    const scope = f.run(f.c.id);
    await call(scope, "web_fetch", { url: FIXTURE_PAGES[0]!.url });
    await call(f.run(f.other.id), "web_fetch", { url: FIXTURE_PAGES[1]!.url });
    const r = await call(f.run(f.c.id), "sources_list", {});
    const items = r.body.items as { sourceId: string; url: string; hasText: boolean }[];
    expect(items.map((i) => [i.url, i.hasText])).toEqual([[FIXTURE_PAGES[0]!.url, true]]);
    expect(r.body.content).toMatch(
      /^<external_content source="sources">\n\[1\] 10월 반도체 수출 32% 증가\n<\/external_content>$/,
    );
    expect(JSON.stringify(r.body.items)).not.toContain("반도체 수출 32% 증가"); // titles only inside the block
    const dad = await call(f.run(f.c.id, f.dad.id), "sources_list", {});
    expect(dad).toEqual({ isError: true, body: { error: "cite_not_allowed" } });
  });
});

// ---- the answer text: paragraphs, markers, the note -------------------------------------------------------

const kinds = (t: string) => citationUnits(t).map((u) => [u.kind, t.slice(u.start, u.end)]);

describe("paragraphs that need a citation", () => {
  it("headings, list lead-ins, disclaimers, rules and code are not checked; paragraphs, items and tables are", () => {
    const t = [
      "## 제목",
      "",
      "**굵은 제목**",
      "",
      "첫 문단이에요[1].",
      "",
      "주요 내용:",
      "- 첫째 항목[2]",
      "  이어지는 줄",
      "- 둘째 항목",
      "",
      "| a | b |",
      "|---|---|",
      "| 1 | 2 |",
      "",
      "---",
      "",
      "```",
      "x = [3]",
      "```",
      "",
      "※ 공개 자료를 바탕으로 했어요.",
      "",
      FINANCE_DISCLAIMER,
      "",
      "출처가 충분하지 않아요.",
    ].join("\n");
    expect(kinds(t)).toEqual([
      ["heading", "## 제목"],
      ["heading", "**굵은 제목**"],
      ["body", "첫 문단이에요[1]."],
      ["lead_in", "주요 내용:"],
      ["body", "- 첫째 항목[2]\n  이어지는 줄"],
      ["body", "- 둘째 항목"],
      ["body", "| a | b |\n|---|---|\n| 1 | 2 |"],
      ["rule", "---"],
      ["code", "```\nx = [3]\n```"],
      ["disclaimer", "※ 공개 자료를 바탕으로 했어요."],
      ["disclaimer", FINANCE_DISCLAIMER],
      ["disclaimer", "출처가 충분하지 않아요."],
    ]);
    // The code block's [3] is not a marker.
    expect(citationMarkers(t).map((m) => m.n)).toEqual([1, 2]);
    expect(uncitedUnits(t).map((r) => t.slice(r.start, r.end))).toEqual([
      "- 둘째 항목",
      "| a | b |\n|---|---|\n| 1 | 2 |",
    ]);
  });

  it("a disclaimer is only a pure disclaimer: mixed or factual short paragraphs are checked (review #97)", () => {
    for (const t of [
      "※ 반도체 수출은 32% 증가했다.",
      "※ 반도체 수출은 크게 늘었다.",
      "출처가 부족하지만 양산은 확정됐다.",
      "출처가 충분하지 않은데 양산은 확정됐다.",
      "출처가 충분하지 않아요. 양산은 2027년이에요.",
      "출처가 충분하지 않아요. 양산은 확정됐어요.",
      "※ 이 답변은 공개 보도를 바탕으로 했어요. 수출은 늘었어요.",
      `${FINANCE_DISCLAIMER} 삼성전자는 오를 거예요.`,
      "※ 이 답변은 수출이 32% 늘었다는 보도를 바탕으로 했어요.",
      "출처가 부족해요. 2개 기사뿐이에요.",
      // Round 2: prefixes of a notice that go on to state something.
      "출처가 부족합니다만 양산은 확정됐습니다.",
      "※ 최신 정보는 양산이 확정됐다는 소식입니다.",
      "출처가 충분하지 않은데요 양산은 확정됐어요.",
      "출처가 부족하지만요, 양산은 확정이에요.",
      "자료가 부족합니다만, 확인해 보세요.",
      "※ 참고용이지만 양산은 확정됐어요.",
      "공식 발표를 확인해 보니 양산은 확정이에요.",
    ])
      expect(kinds(t)[0]![0], t).toBe("body");
    for (const t of [
      "※ 이 답변은 공개 보도를 바탕으로 했어요.",
      "※ 참고용이에요.",
      "출처가 충분하지 않아요.",
      "출처가 충분하지 않아요. 공식 발표를 확인해 보세요.",
      "자료가 부족해요.",
      "출처가 충분하지 않습니다.",
      "공식 발표를 확인해 보세요.",
      `※ ${FINANCE_DISCLAIMER}`,
    ])
      expect(kinds(t)[0]![0], t).toBe("disclaimer");
  });

  it("sentence-end markers (answers without web tools)", () => {
    const ns = (t: string) => sentenceEndMarkers(t).map((m) => m.n);
    expect(ns("최신 수출은 32% 증가했다[1].")).toEqual([1]);
    expect(ns("늘었다.[2] 그리고")).toEqual([2]);
    expect(ns("늘었다[1][2]. 끝")).toEqual([1, 2]);
    expect(ns("늘었다[3]\n다음")).toEqual([3]);
    expect(ns("늘었다[3]  \n다음")).toEqual([3]);
    expect(ns("늘었다[3]\t")).toEqual([3]);
    // Round 3: prose after ASCII words at a line end is a marker; only expressions are indexing.
    expect(ns("Exports increased this year[1]  \n")).toEqual([1]);
    expect(ns("신제품 이름은 Galaxy Ultra[1]  \n다음")).toEqual([1]);
    // Round 4: a comma, a hyphen or `&` before the name is prose, not an expression.
    expect(ns("지원 운영체제는 Windows, Linux[1]\n")).toEqual([1]);
    expect(ns("사용한 모델은 GPT-4o[1]\n")).toEqual([1]);
    expect(ns("기준 지수는 S&P500[1]\n")).toEqual([1]);
    expect(ns("모델은 X1[2]")).toEqual([2]);
    expect(ns("Exports rose[4].")).toEqual([4]);
    for (const t of [
      "배열 a[1] 은 두 번째",
      "a[1].length",
      "x = a[1]\n",
      "`b[2]`.",
      "[1](http://x).",
      "m[1][2] = 3",
      // Round 3: expressions only.
      "y = foo(a[1]\n",
      "obj.items[1]\n",
      "f(a[1]\n",
      "m[0][1]\n",
      "total += arr[2]  \n",
    ])
      expect(ns(t), t).toEqual([]);
  });

  it("the exclusions are narrow: a colon not before a list, a long 'not enough' paragraph and a long ※ text are body", () => {
    expect(kinds("결론은 이렇습니다:\n\n다음 문단")).toEqual([
      ["body", "결론은 이렇습니다:"],
      ["body", "다음 문단"],
    ]);
    const long = `출처가 충분하지 않지만 ${"반도체 수출은 크게 늘었다. ".repeat(6)}`;
    expect(kinds(long)[0]![0]).toBe("body");
    expect(kinds(`※ ${"가".repeat(300)}`)[0]![0]).toBe("body");
    expect(kinds("※ 참고용이에요. ".repeat(30))[0]![0]).toBe("body");
    // A lead-in of two lines is a paragraph.
    expect(kinds("첫 줄\n둘째 줄:\n- 항목")[0]![0]).toBe("body");
  });

  it("markers: [n] only — not a markdown link, a footnote or inline code", () => {
    expect(citationMarkers("a[1] b[12] c[1](http://x) d[^2] e[0] f[ 3 ]").map((m) => m.n)).toEqual([1, 12]);
    expect(citationMarkers("코드 `x[1]` 와 늘었다[2].").map((m) => m.n)).toEqual([2]);
  });
});

describe("citationNote", () => {
  const f = family();
  const scope = f.run(f.c.id);
  const src = f.page(scope);
  f.cites.cite(scope, { sourceId: src.id, snippet: SNIP });
  f.cites.cite(scope, { sourceId: src.id, snippet: "없는 구절을 인용했어요" });
  f.cites.cite(scope, { sourceId: "made-up", snippet: "아무 구절이나 적었어요" });
  const text = (t: string): MessagePart[] => [{ type: "text", text: t }];

  it("each marker with its server status; a marker no cite produced is unknown_source", () => {
    const note = citationNote(scope.runId, text("가[1]. 나[2]. 다[3]. 라[4]."), f.cites)!;
    expect(note.citations).toEqual([
      {
        n: 1,
        status: "verified",
        sourceId: src.id,
        title: FIXTURE_PAGES[0]!.title,
        site: "가나다 신문",
        url: FIXTURE_PAGES[0]!.url,
        publishedAt: FIXTURE_PAGES[0]!.publishedAt,
        quote: SNIP,
      },
      expect.objectContaining({
        n: 2,
        status: "snippet_not_found",
        sourceId: src.id,
        quote: "없는 구절을 인용했어요",
      }),
      {
        n: 3,
        status: "unknown_source",
        sourceId: null,
        title: null,
        site: null,
        url: null,
        publishedAt: null,
        quote: null,
      },
      {
        n: 4,
        status: "unknown_source",
        sourceId: null,
        title: null,
        site: null,
        url: null,
        publishedAt: null,
        quote: null,
      },
    ]);
    expect(note.missing).toEqual([]);
    // Only verified reads as normal.
    expect(note.citations.map((c) => citationVerified(c.status))).toEqual([true, false, false, false]);
    expect(CITATION_STATUS_TEXT.verified).not.toContain("⚠️");
    for (const s of ["snippet_not_found", "fetch_failed", "unknown_source"] as const)
      expect(CITATION_STATUS_TEXT[s].startsWith("⚠️ ")).toBe(true);
  });

  it("fits the shared schema even with long titles and quotes of characters outside the BMP", () => {
    const s2 = f.run(f.c.id);
    const emoji = "😀".repeat(400);
    const row = f.sources.addPage(s2, {
      url: "https://e.example/x",
      finalUrl: "https://e.example/x",
      title: emoji,
      site: emoji,
      contentType: "text/html",
      body: `${emoji} 끝`,
      truncated: false,
    })!;
    f.cites.cite(s2, { sourceId: row.id, snippet: "😀".repeat(250) });
    const note = citationNote(s2.runId, text("가[1]."), f.cites)!;
    expect(note.citations[0]!.status).toBe("verified");
    expect(CitationNotePart.parse(note)).toEqual(note);
    expect(note.citations[0]!.quote).toBe("😀".repeat(250));
  });

  it("marks the body paragraphs without a marker", () => {
    const t = "## 요약\n\n가[1].\n\n나는 출처가 없어요.\n\n※ 참고용이에요.";
    const note = citationNote(scope.runId, text(t), f.cites)!;
    expect(note.missing.map((r) => t.slice(r.start, r.end))).toEqual(["나는 출처가 없어요."]);
  });

  it("a short progress note before the first tool call is not flagged; facts before it and notes after it are", () => {
    const call: MessagePart[] = [
      { type: "tool_call", id: "t", name: "web_fetch", input: {} },
      { type: "tool_result", callId: "t", output: {}, isError: false },
    ];
    const missingOf = (parts: MessagePart[]) => {
      const t = parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
      return citationNote(scope.runId, parts, f.cites)!.missing.map((r) => t.slice(r.start, r.end));
    };
    expect(missingOf([...text("자료를 찾아 비교해 볼게요.\n\n"), ...call, ...text("가[1].")])).toEqual([]);
    expect(missingOf([...text("Let me search for that.\n\n"), ...call, ...text("가[1].")])).toEqual([]);
    // A statement before the tool call, a note with a figure, two sentences, or a note after the call: checked.
    expect(missingOf([...text("반도체 수출은 늘었어요.\n\n"), ...call, ...text("가[1].")])).toEqual([
      "반도체 수출은 늘었어요.",
    ]);
    expect(missingOf([...text("2026년 자료를 찾아볼게요.\n\n"), ...call, ...text("가[1].")])).toHaveLength(1);
    expect(
      missingOf([...text("수출이 늘었어요. 더 찾아볼게요.\n\n"), ...call, ...text("가[1].")]),
    ).toHaveLength(1);
    // Round 2: a fact joined to the note.
    for (const note of [
      "양산이 확정됐으니 자료를 더 찾아볼게요.",
      "양산이 확정돼서 더 찾아볼게요.",
      "Exports rose, so let me check.",
      // Round 3: a complement clause that carries a fact.
      "양산이 확정됐음을 알려드리겠습니다.",
      "양산이 확정됐다는 소식을 확인해 볼게요.",
      "양산이 확정이라는 기사를 찾아볼게요.",
    ])
      expect(missingOf([...text(`${note}\n\n`), ...call, ...text("가[1].")]), note).toHaveLength(1);
    expect(missingOf([...call, ...text("가[1].\n\n더 찾아볼게요.")])).toEqual(["더 찾아볼게요."]);
  });

  it("applies when the run used a web tool or cited — and not otherwise", () => {
    const fresh = crypto.randomUUID();
    // No web tool, no citation, no [n] that stands where a citation stands: no note.
    for (const t of [
      "그냥 답이에요.",
      "배열 a[1] 은 두 번째 값",
      "a[1].length 는 3",
      "x = a[1]\n",
      "`b[2]`.",
      "[1](http://x).",
    ])
      expect(citationNote(fresh, text(t), f.cites), t).toBeUndefined();
    // A sentence that ends in [n] without any citation pretends to cite: checked, unknown, nothing else marked.
    const fake = citationNote(fresh, text("최신 수출은 32% 증가했다[1].\n\n출처 없는 다른 문단."), f.cites)!;
    expect(fake.citations).toEqual([
      expect.objectContaining({ n: 1, status: "unknown_source", sourceId: null }),
    ]);
    expect(fake.markers).toEqual([{ n: 1, start: 15, end: 18 }]);
    expect(fake.missing).toEqual([]);
    const withFetch: MessagePart[] = [
      { type: "tool_call", id: "t", name: "mcp__agentlee__web_fetch", input: {} },
      { type: "tool_result", callId: "t", output: { error: "web_blocked" }, isError: true },
      ...text("가져오지 못했지만 이렇다고 해요."),
    ];
    const note = citationNote(fresh, withFetch, f.cites)!;
    expect(note.citations).toEqual([]);
    expect(note.missing).toHaveLength(1);
    // Codex reports tool names without the prefix.
    expect(
      citationNote(fresh, [{ ...withFetch[0]!, name: "web_search" } as MessagePart, ...text("x")], f.cites),
    ).toBeDefined();
    // Nothing written: nothing to note.
    expect(citationNote(scope.runId, [], f.cites)).toBeUndefined();
  });
});
