import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { Writable } from "node:stream";
import type JSZipType from "jszip";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CSRF_HEADER,
  REFERENCE_LIMITS,
  ReferencesResponse,
  type CitationEntry,
  type CitationStatus,
  type MessagePart,
} from "@agentlee/shared";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb, type Db } from "../src/db/client.js";
import { messages, notificationPrefs, sources } from "../src/db/schema.js";
import { inProcessDocRunner, type DocRunner } from "../src/docgen/runner.js";
import { DocSlots } from "../src/docgen/slots.js";
import { RuntimeRegistry } from "../src/runtime/adapter.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import { cleanUrl, collectReferences, plainLine, referenceDate, urlKey } from "../src/references/collect.js";
import { buildExport, downloadName } from "../src/references/routes.js";
import { docxHoldsSecret } from "../src/references/docx-check.js";
import { KNOWN_PLACEHOLDER, knownSecrets, scrubKnown } from "../src/secrets/known.js";
import { readDocx } from "./helpers/doc-parse.js";
import { createFamily, type Family } from "./helpers/permission-matrix.js";

/**
 * 참고문헌 내보내기 (#26, PRD FR-5.6): the history's cited sources, once each, in APA 7 / MLA 9 / the school format;
 * failed sources listed but left out by default; copy text, `.txt` and `.docx` (the #49 worker); the conversation's
 * read permission; known secrets scrubbed from everything written out — the `.docx` too (a binary body, which the
 * response scrub does not see).
 */

const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const LOCAL = { host: "localhost:3000" };

function tmp(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-refs-")));
  closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function logCapture() {
  const lines: Record<string, unknown>[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      for (const l of String(chunk).split("\n").filter(Boolean)) lines.push(JSON.parse(l));
      cb();
    },
  });
  return { lines, stream };
}

async function start(o: { runner?: DocRunner } = {}) {
  const runtimes = new RuntimeRegistry();
  runtimes.register(new FakeRuntime({ runTools: true }));
  const db = createTestDb();
  const log = logCapture();
  const app = await buildApp(
    loadConfig({
      NODE_ENV: "test",
      DATA_DIR: path.join(tmp(), "data"),
      MASTER_KEY_PATH: path.join(tmp(), "k"),
    }),
    {
      db,
      runtimes,
      runs: { flushMs: 0 },
      logStream: log.stream,
      docs: { runner: o.runner ?? inProcessDocRunner() },
    },
  );
  closers.push(() => app.close());
  const f = await createFamily(app);
  const get = (who: keyof Family["cookies"] | null, url: string) =>
    app.inject({ url, headers: { ...LOCAL, ...(who ? { cookie: f.cookies[who] } : {}) } });
  return { app, db, f, get, log: log.lines };
}

/** A runner held until `release()`: how many runs started, the most at once; `fail(code)` for later runs. */
function gated() {
  let release: () => void = () => {};
  const gate = new Promise<void>((res) => (release = res));
  let started = 0;
  let open = 0;
  let peak = 0;
  let failing: string | undefined;
  const runner: DocRunner = async (job) => {
    if (failing) return { ok: false, code: failing };
    started++;
    open++;
    peak = Math.max(peak, open);
    try {
      await gate;
      return await inProcessDocRunner()(job);
    } finally {
      open--;
    }
  };
  return {
    runner,
    release: () => release(),
    peak: () => peak,
    fail: (code: string) => (failing = code),
    started: async (n: number) => {
      for (let i = 0; i < 500 && started < n; i++) await new Promise((res) => setTimeout(res, 10));
      expect(started).toBe(n);
    },
  };
}

async function waitRun(app: Awaited<ReturnType<typeof buildApp>>, id: string) {
  for (let i = 0; i < 1000; i++) {
    const r = app.runs!.get(id)!;
    if (r.endedAt !== null)
      return { parts: app.conversations!.messageById(r.assistantMessageId)!.parts as MessagePart[] };
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error("run did not end");
}

/** A source row of the conversation (a fetched page unless `kind: "search"`). */
function source(
  db: Db,
  c: { conversationId: string; userId: string },
  s: {
    url: string;
    title: string;
    site: string;
    finalUrl?: string;
    publishedAt?: string;
    kind?: "page" | "search";
  },
  fetchedAt = Date.UTC(2026, 10, 12, 16, 30), // 2026-11-13 01:30 in Seoul
): string {
  const id = crypto.randomUUID();
  db.insert(sources)
    .values({
      id,
      userId: c.userId,
      conversationId: c.conversationId,
      runId: crypto.randomUUID(),
      kind: s.kind ?? "page",
      provider: "web_fetch",
      url: s.url,
      finalUrl: s.finalUrl ?? null,
      title: s.title,
      site: s.site,
      publishedAt: s.publishedAt ?? null,
      fetchedAt,
      body: s.kind === "search" ? null : "본문",
    })
    .run();
  return id;
}

const entry = (
  n: number,
  status: CitationStatus,
  sourceId: string | null,
  extra: Partial<CitationEntry> = {},
): CitationEntry => ({
  n,
  status,
  sourceId,
  title: null,
  site: null,
  url: null,
  publishedAt: null,
  quote: null,
  ...extra,
});

/** An answer whose server note lists these citations (stored as the run end writes it). */
function answer(
  app: Awaited<ReturnType<typeof start>>["app"],
  conversationId: string,
  list: CitationEntry[],
) {
  const parts: MessagePart[] = [
    { type: "text", text: list.map((e) => `문장 [${e.n}].`).join(" ") },
    { type: "citation_note", citations: list, missing: [], markers: [] },
  ];
  return app.conversations!.append(conversationId, { role: "assistant", parts });
}

function conversation(t: Awaited<ReturnType<typeof start>>, who: "owner" | "stranger" = "owner") {
  const c = t.app.conversations!.create(t.f.users[who].id);
  t.app.conversations!.rename(c.id, "반도체 수출 조사");
  t.app.conversations!.append(c.id, { role: "user", parts: [{ type: "text", text: "질문" }] });
  return { id: c.id, scope: { conversationId: c.id, userId: t.f.users[who].id } };
}

/**
 * Three web sources: A verified (cited twice — once through a fetch that redirected from another address to it,
 * once fetched directly), B failed, C a search result.
 */
function fixture(t: Awaited<ReturnType<typeof start>>, who: "owner" | "stranger" = "owner") {
  const c = conversation(t, who);
  const a = source(t.db, c.scope, {
    url: "http://www.fixture.agentlee.test/news/chips-a.html?utm_source=x#top",
    finalUrl: "https://fixture.agentlee.test/news/chips-a.html",
    title: "10월 반도체 수출 32% 증가",
    site: "가나다 신문",
    publishedAt: "2026-11-10",
  });
  const a2 = source(t.db, c.scope, {
    url: "https://fixture.agentlee.test/news/chips-a.html#second",
    title: "10월 반도체 수출 32% 증가 (다시 가져옴)",
    site: "가나다 신문",
  });
  const b = source(t.db, c.scope, {
    url: "https://fixture.agentlee.test/news/chips-b.html",
    title: "Chip Exports Hit A Record High",
    site: "Example Times",
    publishedAt: "2026-11-09T23:30:00-05:00",
  });
  const s = source(t.db, c.scope, {
    url: "https://search.example/result",
    title: "검색 결과 페이지",
    site: "search.example",
    kind: "search",
  });
  answer(t.app, c.id, [
    entry(1, "snippet_not_found", a2),
    entry(2, "snippet_not_found", b),
    entry(3, "fetch_failed", s),
    entry(4, "unknown_source", null),
  ]);
  answer(t.app, c.id, [entry(1, "verified", a)]);
  // A later citation of A that fails does not undo the verified one.
  answer(t.app, c.id, [entry(1, "snippet_not_found", a)]);
  return { ...c, a, a2, b, s };
}

const refs = async (
  t: Awaited<ReturnType<typeof start>>,
  id: string,
  q = "",
  who: "owner" | "stranger" = "owner",
) => {
  const r = await t.get(who, `/api/conversations/${id}/references${q}`);
  expect(r.statusCode, r.body).toBe(200);
  return ReferencesResponse.parse(r.json());
};

describe("gathering the sources", () => {
  it("one entry per address; verified wins; first-cited order; unknown markers name nothing", async () => {
    const t = await start();
    const c = fixture(t);
    const { sources: list, truncated } = collectReferences(t.db, c.id);
    expect(truncated).toBe(false);
    expect(list.map((s) => (s.kind === "web" ? [s.title, s.url, s.status] : []))).toEqual([
      // A and A2 are one page — A's fetch was redirected to A2's address (and A2's #fragment does not count): the
      // verified row wins.
      ["10월 반도체 수출 32% 증가", "https://fixture.agentlee.test/news/chips-a.html", "verified"],
      [
        "Chip Exports Hit A Record High",
        "https://fixture.agentlee.test/news/chips-b.html",
        "snippet_not_found",
      ],
      ["검색 결과 페이지", "https://search.example/result", "fetch_failed"],
    ]);
    const first = list[0]!;
    expect(first).toMatchObject({ verified: true, publishedAt: "2026-11-10", accessedAt: "2026-11-13" });
    // A time is the date the source states, in its own offset (23:30 at -05:00 on the 9th stays the 9th).
    expect(list[1]).toMatchObject({ verified: false, publishedAt: "2026-11-09" });
    // Ids are opaque: never the address.
    for (const s of list) expect(s.id).toMatch(/^r_[0-9a-f]{24}$/);
  });

  it("only the history counts: a regenerated answer's sources are gone", async () => {
    const t = await start();
    const c = conversation(t);
    const x = source(t.db, c.scope, { url: "https://old.example/a", title: "옛 답의 출처", site: "old" });
    const old = answer(t.app, c.id, [entry(1, "verified", x)]);
    expect(collectReferences(t.db, c.id).sources).toHaveLength(1);
    t.db.update(messages).set({ active: false }).where(eq(messages.id, old.id)).run();
    expect(collectReferences(t.db, c.id).sources).toEqual([]);
  });

  it("another conversation's source row is never read (the note's own fields stand)", async () => {
    const t = await start();
    const mine = conversation(t);
    const theirs = conversation(t);
    const foreign = source(t.db, theirs.scope, {
      url: "https://private.example/secret-page",
      title: "다른 대화의 비공개 제목",
      site: "private",
    });
    answer(t.app, mine.id, [
      entry(1, "verified", foreign, { title: "노트의 제목", site: "노트", url: "https://note.example/p" }),
    ]);
    const [s] = collectReferences(t.db, mine.id).sources;
    expect(s).toMatchObject({
      kind: "web",
      title: "노트의 제목",
      url: "https://note.example/p",
      accessedAt: null,
    });
  });

  it("file citations (#48 note entries, fixture rows): one entry per file, places in order, fileId when given", async () => {
    const t = await start();
    const c = conversation(t);
    // #107's shape (citations/checker.ts): no source id, no address, the file name as title; a verified passage
    // also carries the place label as site and the locator (with the file's id); a failed one carries neither.
    const rev = "a".repeat(64);
    const file = (n: number, status: CitationStatus, name: string, page: number | null, fileId: string) => ({
      ...entry(n, status, null, { title: name, site: page ? `${page}쪽` : null }),
      ...(status === "verified" && page
        ? { locator: { fileId, fileRevision: rev, kind: "page", page } }
        : {}),
    });
    const msg = answer(t.app, c.id, []);
    const [report, ledger, same1, same2] = [1, 2, 3, 4].map(() => crypto.randomUUID()) as [
      string,
      string,
      string,
      string,
    ];
    t.db
      .update(messages)
      .set({
        parts: [
          { type: "text", text: "본문" },
          {
            type: "citation_note",
            missing: [],
            markers: [],
            citations: [
              file(1, "verified", "과학 보고서.pdf", 3, report),
              file(2, "verified", "과학 보고서.pdf", 5, report),
              file(3, "verified", "과학 보고서.pdf", 3, report),
              // A failed passage of the same file has no locator (no id): it joins that file's entry.
              file(4, "snippet_not_found", "과학 보고서.pdf", null, report),
              file(5, "snippet_not_found", "가계부.xlsx", null, ledger),
              file(6, "verified", "같은 이름.pdf", 1, same1),
              file(7, "verified", "같은 이름.pdf", 2, same2),
            ],
          },
        ],
      })
      .where(eq(messages.id, msg.id))
      .run();
    const list = collectReferences(t.db, c.id).sources;
    expect(list.map((s) => (s.kind === "file" ? [s.fileName, s.locators, s.verified] : []))).toEqual([
      ["과학 보고서.pdf", ["3쪽", "5쪽"], true],
      ["가계부.xlsx", [], false],
      // Two files of the same name are two entries when the entries say which file.
      ["같은 이름.pdf", ["1쪽"], true],
      ["같은 이름.pdf", ["2쪽"], true],
    ]);
    const e = buildExport(t.db, c.id, "apa", false);
    expect(e.lines).toEqual([
      "같은 이름.pdf [Unpublished document; 1쪽]. (n.d.).",
      "같은 이름.pdf [Unpublished document; 2쪽]. (n.d.).",
      "과학 보고서.pdf [Unpublished document; 3쪽, 5쪽]. (n.d.).",
    ]);
    expect(e.excluded).toBe(1);
  });

  it("plain text: control, bidirectional and invisible characters go; lines stay one line", () => {
    const ch = (...c: number[]) => String.fromCharCode(...c);
    expect(plainLine(`제목${ch(0x202e)}은\n두 줄${ch(0x200b)}\t${ch(0x7)}끝${ch(0xd800)}`, 100)).toBe(
      `제목은 두 줄 끝${ch(0xfffd)}`,
    );
    expect(plainLine("가".repeat(50), 10)).toBe("가".repeat(10));
  });

  it("addresses: http(s) only, no user name or password, no fragment; only safe normalisation in the key", () => {
    expect(cleanUrl("https://user:pw@example.com/a#frag")).toBe("https://example.com/a");
    expect(cleanUrl("javascript:alert(1)")).toBeNull();
    expect(cleanUrl("file:///etc/passwd")).toBeNull();
    // The same: host case, a default port, a fragment.
    expect(urlKey("https://Example.COM:443/a?q=1#f")).toBe(urlKey("https://example.com/a?q=1"));
    expect(urlKey("http://example.com:80/a")).toBe(urlKey("http://example.com/a"));
    // Different documents as far as we know: scheme, www., trailing slash, query, path, port.
    const base = urlKey("https://example.com/a");
    for (const other of [
      "http://example.com/a",
      "https://www.example.com/a",
      "https://example.com/a/",
      "https://example.com/a?utm_source=x",
      "https://example.com/A",
      "https://example.com:8443/a",
    ])
      expect(urlKey(other), other).not.toBe(base);
  });

  it("addresses that only look alike stay two sources; a stored redirect merges them", async () => {
    const t = await start();
    const c = conversation(t);
    const forms = [
      "https://site.example/doc",
      "https://site.example/doc/",
      "https://www.site.example/doc",
      "http://site.example/doc",
    ];
    const ids = forms.map((url, i) =>
      source(t.db, c.scope, { url, title: `문서 ${i}`, site: "site", publishedAt: `2026-01-0${i + 1}` }),
    );
    answer(t.app, c.id, [
      entry(1, "verified", ids[0]!),
      entry(2, "snippet_not_found", ids[1]!),
      entry(3, "fetch_failed", ids[2]!),
      entry(4, "verified", ids[3]!),
    ]);
    const list = collectReferences(t.db, c.id).sources;
    expect(list.map((s) => (s.kind === "web" ? [s.url, s.title, s.status] : []))).toEqual([
      ["https://site.example/doc", "문서 0", "verified"],
      ["https://site.example/doc/", "문서 1", "snippet_not_found"],
      ["https://www.site.example/doc", "문서 2", "fetch_failed"],
      ["http://site.example/doc", "문서 3", "verified"],
    ]);
    // A fetch of the http address that ended at the https one is the https document. The http page fetched
    // directly (no redirect) is a document of its own: `http://…/doc` now has two destinations and joins neither.
    const redirected = source(t.db, c.scope, {
      url: "http://site.example/doc",
      finalUrl: "https://site.example/doc",
      title: "문서 (리디렉션)",
      site: "site",
    });
    answer(t.app, c.id, [entry(1, "snippet_not_found", redirected)]);
    const merged = collectReferences(t.db, c.id).sources;
    expect(merged.map((s) => (s.kind === "web" ? [s.title, s.status] : []))).toEqual([
      ["문서 0", "verified"],
      ["문서 1", "snippet_not_found"],
      ["문서 2", "fetch_failed"],
      ["문서 3", "verified"],
    ]);
  });

  it("a start address with two destinations never joins them: each document keeps its own status", async () => {
    const t = await start();
    const c = conversation(t);
    const nov12 = source(t.db, c.scope, {
      url: "https://news.example/latest",
      finalUrl: "https://news.example/nov-12",
      title: "11월 12일 기사",
      site: "news",
    });
    const nov13 = source(t.db, c.scope, {
      url: "https://news.example/latest",
      finalUrl: "https://news.example/nov-13",
      title: "11월 13일 기사",
      site: "news",
    });
    // A search result that names only the start address: which document it is cannot be told — its own entry.
    const lead = source(t.db, c.scope, {
      url: "https://news.example/latest",
      title: "최신 기사",
      site: "news",
      kind: "search",
    });
    answer(t.app, c.id, [
      entry(1, "verified", nov12),
      entry(2, "snippet_not_found", nov13),
      entry(3, "fetch_failed", lead),
    ]);
    const list = collectReferences(t.db, c.id).sources;
    expect(list.map((x) => (x.kind === "web" ? [x.url, x.status] : []))).toEqual([
      ["https://news.example/nov-12", "verified"],
      ["https://news.example/nov-13", "snippet_not_found"],
      ["https://news.example/latest", "fetch_failed"],
    ]);
    // A page fetched straight at `/latest` (no redirect) and a fetch of `/latest` that ended at `/nov-13`: two
    // documents, each with its own status (the direct one is not swallowed by the redirect, review #115 round 3).
    const e2 = conversation(t);
    const direct = source(t.db, e2.scope, {
      url: "https://news.example/latest",
      title: "12일 본문",
      site: "news",
    });
    const moved = source(t.db, e2.scope, {
      url: "https://news.example/latest",
      finalUrl: "https://news.example/nov-13",
      title: "13일 본문",
      site: "news",
    });
    answer(t.app, e2.id, [entry(1, "verified", direct), entry(2, "snippet_not_found", moved)]);
    expect(
      collectReferences(t.db, e2.id).sources.map((x) => (x.kind === "web" ? [x.title, x.url, x.status] : [])),
    ).toEqual([
      ["12일 본문", "https://news.example/latest", "verified"],
      ["13일 본문", "https://news.example/nov-13", "snippet_not_found"],
    ]);
    // With one destination the start address is followed (a chain of stored rows: a → b → c).
    const d = conversation(t);
    const ab = source(t.db, d.scope, {
      url: "https://x.example/a",
      finalUrl: "https://x.example/b",
      title: "AB",
      site: "x",
    });
    const bc = source(t.db, d.scope, {
      url: "https://x.example/b",
      finalUrl: "https://x.example/c",
      title: "BC",
      site: "x",
    });
    const a = source(t.db, d.scope, {
      url: "https://x.example/a",
      title: "A 검색",
      site: "x",
      kind: "search",
    });
    answer(t.app, d.id, [
      entry(1, "snippet_not_found", ab),
      entry(2, "verified", bc),
      entry(3, "fetch_failed", a),
    ]);
    const chain = collectReferences(t.db, d.id).sources;
    expect(chain.map((x) => (x.kind === "web" ? [x.url, x.status] : []))).toEqual([
      ["https://x.example/c", "verified"],
    ]);
  });

  it("dates: the date the source states (its own offset, real calendar dates); anything else n.d.", () => {
    expect(referenceDate("2026-11-10")).toBe("2026-11-10");
    expect(referenceDate("2026-11")).toBe("2026-11");
    expect(referenceDate("2026-11-10T15:30:00Z")).toBe("2026-11-10");
    expect(referenceDate("2026-11-09T23:30:00-05:00")).toBe("2026-11-09");
    expect(referenceDate("2026-11-10T00:30:00+09:00")).toBe("2026-11-10");
    expect(referenceDate("어제")).toBeNull();
    expect(referenceDate("2026-13-01")).toBeNull();
    expect(referenceDate("2026-02-31")).toBeNull();
    expect(referenceDate("2026-02-29")).toBeNull();
    expect(referenceDate("2024-02-29")).toBe("2024-02-29");
    expect(referenceDate("2026-02-31T10:00:00Z")).toBeNull();
    expect(referenceDate("2026-04-31T10:00:00+09:00")).toBeNull();
    expect(referenceDate("0001-01-01")).toBeNull();
  });

  it("access dates are the fetch day in the user's time zone (notification settings), Asia/Seoul by default", async () => {
    const t = await start();
    const c = conversation(t);
    // 2026-11-12 16:30 UTC: the 13th in Seoul, the 12th in New York.
    const x = source(t.db, c.scope, { url: "https://tz.example/", title: "시간대", site: "tz" });
    answer(t.app, c.id, [entry(1, "verified", x)]);
    expect((await refs(t, c.id, "?style=school")).text).toContain("(접속일: 2026. 11. 13.)");
    t.db
      .insert(notificationPrefs)
      .values({ userId: t.f.users.owner.id, timeZone: "America/New_York", updatedAt: Date.now() })
      .run();
    expect((await refs(t, c.id, "?style=school")).text).toContain("(접속일: 2026. 11. 12.)");
    // Any zone the settings name (Kiritimati, UTC+14: the 13th too).
    expect(collectReferences(t.db, c.id, "Pacific/Kiritimati").sources[0]).toMatchObject({
      accessedAt: "2026-11-13",
    });
  });
});

describe("the export API", () => {
  it("failed sources are listed but left out by default; the toggle includes them (snapshots per style)", async () => {
    const t = await start();
    const c = fixture(t);
    const apa = await refs(t, c.id);
    expect(apa.excluded).toBe(2);
    expect(apa.items.map((i) => [i.included, i.verified, i.status])).toEqual([
      [true, true, "verified"],
      // APA order among the excluded too: Korean first.
      [false, false, "fetch_failed"],
      [false, false, "snippet_not_found"],
    ]);
    expect(apa.text).toMatchInlineSnapshot(
      `"10월 반도체 수출 32% 증가. (2026, November 10). 가나다 신문. https://fixture.agentlee.test/news/chips-a.html"`,
    );
    const all = await refs(t, c.id, "?includeUnverified=1");
    expect(all.excluded).toBe(0);
    expect(all.items.every((i) => i.included)).toBe(true);
    expect(all.text).toMatchInlineSnapshot(`
      "10월 반도체 수출 32% 증가. (2026, November 10). 가나다 신문. https://fixture.agentlee.test/news/chips-a.html
      검색 결과 페이지. (n.d.). search.example. https://search.example/result
      Chip Exports Hit A Record High. (2026, November 9). Example Times. https://fixture.agentlee.test/news/chips-b.html"
    `);
    expect((await refs(t, c.id, "?style=mla&includeUnverified=1")).text).toMatchInlineSnapshot(`
      ""10월 반도체 수출 32% 증가." 가나다 신문, 10 Nov. 2026, fixture.agentlee.test/news/chips-a.html. Accessed 13 Nov. 2026.
      "검색 결과 페이지." search.example, search.example/result. Accessed 13 Nov. 2026.
      "Chip Exports Hit A Record High." Example Times, 9 Nov. 2026, fixture.agentlee.test/news/chips-b.html. Accessed 13 Nov. 2026."
    `);
    expect((await refs(t, c.id, "?style=school&includeUnverified=1")).text).toMatchInlineSnapshot(`
      "1. 저자 미상, 「10월 반도체 수출 32% 증가」, 가나다 신문, 2026. 11. 10., https://fixture.agentlee.test/news/chips-a.html (접속일: 2026. 11. 13.)
      2. 저자 미상, 「Chip Exports Hit A Record High」, Example Times, 2026. 11. 9., https://fixture.agentlee.test/news/chips-b.html (접속일: 2026. 11. 13.)
      3. 저자 미상, 「검색 결과 페이지」, search.example, 날짜 없음, https://search.example/result (접속일: 2026. 11. 13.)"
    `);
    // Off: the school format numbers the included entries only; the excluded ones are shown without a number.
    const school = await refs(t, c.id, "?style=school");
    expect(school.items.map((i) => i.text.slice(0, 3))).toEqual(["1. ", "저자 ", "저자 "]);
  });

  it("bad queries are 400; an empty conversation is an empty list (download: 409 references_empty)", async () => {
    const t = await start();
    const c = conversation(t);
    expect((await t.get("owner", `/api/conversations/${c.id}/references?style=chicago`)).statusCode).toBe(
      400,
    );
    expect(
      (await t.get("owner", `/api/conversations/${c.id}/references?includeUnverified=yes`)).statusCode,
    ).toBe(400);
    expect(await refs(t, c.id)).toMatchObject({ items: [], text: "", excluded: 0, truncated: false });
    const d = await t.get("owner", `/api/conversations/${c.id}/references/download`);
    expect(d.statusCode).toBe(409);
    expect(d.json()).toEqual({ error: "references_empty" });
    // Only failed sources: still nothing to download while the toggle is off.
    const x = source(t.db, c.scope, { url: "https://x.example/", title: "실패", site: "x" });
    answer(t.app, c.id, [entry(1, "snippet_not_found", x)]);
    expect((await t.get("owner", `/api/conversations/${c.id}/references/download`)).statusCode).toBe(409);
    expect(
      (await t.get("owner", `/api/conversations/${c.id}/references/download?includeUnverified=1`)).statusCode,
    ).toBe(200);
  });

  it("someone else's conversation: 403 for members and the admin, 401 without login, 404 when missing", async () => {
    const t = await start();
    const c = fixture(t);
    for (const url of [
      `/api/conversations/${c.id}/references`,
      `/api/conversations/${c.id}/references/download`,
    ]) {
      for (const who of ["stranger", "admin", "shared"] as const) {
        const r = await t.get(who, url);
        expect(r.statusCode, `${who} ${url}`).toBe(403);
        expect(r.body).not.toContain("반도체");
      }
      expect((await t.get(null, url)).statusCode).toBe(401);
      expect((await t.get("owner", url.replace(c.id, "missing"))).statusCode).toBe(404);
    }
  });

  it(".txt: the copied text, UTF-8, an attachment with the fixed name", async () => {
    const t = await start();
    const c = fixture(t);
    const r = await t.get("owner", `/api/conversations/${c.id}/references/download?style=mla&format=txt`);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toBe("text/plain; charset=utf-8");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["cache-control"]).toBe("no-store");
    // The server's fixed name (no title): 참고문헌-<형식>-<access day in the user's zone>.
    expect(String(r.headers["content-disposition"])).toMatch(
      /^attachment; filename="references-MLA-\d{4}-\d{2}-\d{2}\.txt"; filename\*=UTF-8''/,
    );
    expect(decodeURIComponent(String(r.headers["content-disposition"]).split("''")[1]!)).toMatch(
      /^참고문헌-MLA-\d{4}-\d{2}-\d{2}\.txt$/,
    );
    expect(r.body).toBe(`${(await refs(t, c.id, "?style=mla")).text}\n`);
  });

  it(".docx: made by the #49 worker from text blocks — the title, the conversation and every entry", async () => {
    const t = await start();
    const c = fixture(t);
    const r = await t.get(
      "owner",
      `/api/conversations/${c.id}/references/download?style=school&format=docx&includeUnverified=1`,
    );
    expect(r.statusCode, r.body).toBe(200);
    expect(r.headers["content-type"]).toBe(
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    expect(String(r.headers["content-disposition"])).toMatch(/\.docx"; filename\*=/);
    const d = await readDocx(r.rawPayload);
    const lines = (await refs(t, c.id, "?style=school&includeUnverified=1")).text.split("\n");
    expect(d.paragraphs[0]).toBe("참고문헌");
    expect(d.paragraphs[1]).toBe("반도체 수출 조사 · 학교용 간단 형식");
    expect(d.paragraphs.filter((p) => /^\d+\. /.test(p))).toEqual(lines);
    const log = t.log.find((l) => l.msg === "references.exported");
    expect(log).toMatchObject({ docKind: "docx", docCode: "doc_ok", count: 3 });
    // Never an entry, a title or an address in the log.
    expect(JSON.stringify(t.log)).not.toMatch(/반도체|fixture\.agentlee/);
  });

  it(".docx: one worker slot per user — the same user waits, another user does not; a failure is clean", async () => {
    const held = gated();
    const t = await start({ runner: held.runner });
    const mine = fixture(t);
    const theirs = fixture(t, "stranger");
    const url = (id: string) => `/api/conversations/${id}/references/download?format=docx`;
    const first = t.get("owner", url(mine.id));
    await held.started(1);
    // The same user's second `.docx` while the first is being made: busy.
    const second = await t.get("owner", url(mine.id));
    expect(second.statusCode).toBe(503);
    expect(second.json()).toEqual({ error: "references_busy" });
    expect(second.headers["retry-after"]).toBe("5");
    // Another user is not blocked by it.
    const other = t.get("stranger", url(theirs.id));
    await held.started(2);
    // .txt needs no slot.
    expect((await t.get("owner", url(mine.id).replace("docx", "txt"))).statusCode).toBe(200);
    held.release();
    expect((await first).statusCode).toBe(200);
    expect((await other).statusCode).toBe(200);
    held.fail("doc_timeout");
    const failed = await t.get("owner", url(mine.id));
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ error: "references_unavailable" });
  });

  it("doc_create and the export share the server's two worker slots: never more than 2 at once", async () => {
    const held = gated();
    const t = await start({ runner: held.runner });
    const a = fixture(t);
    const b = fixture(t, "stranger");
    const url = (id: string) => `/api/conversations/${id}/references/download?format=docx`;
    const exports = [t.get("owner", url(a.id)), t.get("stranger", url(b.id))];
    await held.started(2);
    // A third user's `doc_create` (FakeRuntime `/doc docx`, the real tool) while both slots are taken: doc_busy.
    const c = t.app.conversations!.create(t.f.users.shared.id);
    const sent = await t.app.inject({
      method: "POST",
      url: `/api/conversations/${c.id}/messages`,
      headers: { ...LOCAL, cookie: t.f.cookies.shared, origin: "http://localhost:3000", [CSRF_HEADER]: "1" },
      payload: { text: "/doc docx" },
    });
    expect(sent.statusCode, sent.body).toBe(201);
    const run = await waitRun(t.app, (sent.json() as { run: { id: string } }).run.id);
    const result = run.parts.find((p) => p.type === "tool_result");
    expect(JSON.stringify(result)).toContain("doc_busy");
    expect(held.peak()).toBe(2);
    held.release();
    for (const r of await Promise.all(exports)) expect(r.statusCode).toBe(200);
    // Once free, doc_create runs.
    const again = await t.app.inject({
      method: "POST",
      url: `/api/conversations/${c.id}/messages`,
      headers: { ...LOCAL, cookie: t.f.cookies.shared, origin: "http://localhost:3000", [CSRF_HEADER]: "1" },
      payload: { text: "/doc docx" },
    });
    const done = await waitRun(t.app, (again.json() as { run: { id: string } }).run.id);
    expect(JSON.stringify(done.parts.find((p) => p.type === "tool_result"))).not.toContain("doc_busy");
    expect(held.peak()).toBe(2);
  });

  it("DocSlots: 2 at once on the server, 1 per user, released after a failure too", async () => {
    let open = 0;
    let peak = 0;
    const waits: (() => void)[] = [];
    const slots = new DocSlots(async () => {
      open++;
      peak = Math.max(peak, open);
      await new Promise<void>((res) => waits.push(res));
      open--;
      return { ok: false, code: "doc_failed" };
    });
    const job = { kind: "docx" as const, doc: { title: "t", blocks: [] }, images: {} };
    const a = slots.run("a", job);
    expect(await slots.run("a", job)).toBeUndefined();
    const b = slots.run("b", job);
    expect(await slots.run("c", job)).toBeUndefined();
    while (waits.length) waits.shift()!();
    expect(await a).toMatchObject({ ok: false });
    expect(await b).toMatchObject({ ok: false });
    expect(peak).toBe(2);
    const c = slots.run("c", job);
    while (!waits.length) await new Promise((res) => setTimeout(res, 1));
    waits.shift()!();
    expect(await c).toMatchObject({ ok: false });
  });
});

describe("known secrets never leave in an export", () => {
  it("titles, sites, addresses and the conversation title are scrubbed — in the list, .txt and .docx", async () => {
    const secret = `sk-refs-${crypto.randomBytes(12).toString("hex")}`;
    knownSecrets.add(secret, { fresh: true });
    closers.push(() => knownSecrets.remove(secret));
    const t = await start();
    const c = conversation(t);
    t.app.conversations!.rename(c.id, `조사 ${secret}`);
    const x = source(t.db, c.scope, {
      url: `https://leak.example/p?token=${secret}`,
      title: `제목 ${secret}`,
      site: `사이트 ${secret.slice(0, 10)}${String.fromCharCode(0x200b)}${secret.slice(10)}`,
    });
    // A title cut at its limit inside a secret: the cut-off part is masked where the field ends (the finished
    // line would hold it mid-line, where only whole secrets are found).
    const long = source(t.db, c.scope, {
      url: "https://long.example/p",
      title: `${"가".repeat(REFERENCE_LIMITS.title - 10)}${secret}`,
      site: "긴 제목",
    });
    answer(t.app, c.id, [entry(1, "verified", x), entry(2, "verified", long)]);

    for (const style of ["apa", "mla", "school"] as const) {
      const e = buildExport(t.db, c.id, style, false);
      expect(e.lines).toHaveLength(2);
      for (const line of e.lines) {
        expect(line).not.toContain(secret.slice(0, 10));
        expect(line).toContain(KNOWN_PLACEHOLDER);
        // A secret split by an invisible character is joined by the plain-text step — and scrubbed after it.
        expect(line).not.toContain(secret.slice(10));
      }
    }
    const docx = await t.get("owner", `/api/conversations/${c.id}/references/download?format=docx`);
    expect(docx.statusCode).toBe(200);
    const d = await readDocx(docx.rawPayload);
    expect(d.xml).not.toContain(secret);
    expect(d.xml).not.toContain(encodeURIComponent(secret));
    expect(d.text).toContain(KNOWN_PLACEHOLDER);
    expect(decodeURIComponent(String(docx.headers["content-disposition"]).split("''")[1]!)).not.toContain(
      secret,
    );
    // The zip as bytes too (document properties, every part).
    expect(docx.rawPayload.includes(Buffer.from(secret))).toBe(false);
  });

  it("a secret registered while the .docx is being made: the file is made again from the scrubbed input", async () => {
    const late = `late-secret-${crypto.randomBytes(10).toString("hex")}`;
    closers.push(() => knownSecrets.remove(late));
    const held = gated();
    const t = await start({ runner: held.runner });
    const c = conversation(t);
    const x = source(t.db, c.scope, { url: "https://late.example/p", title: `제목 ${late}`, site: "late" });
    answer(t.app, c.id, [entry(1, "verified", x)]);
    const pending = t.get("owner", `/api/conversations/${c.id}/references/download?format=docx`);
    await held.started(1);
    knownSecrets.add(late, { fresh: true });
    held.release();
    const r = await pending;
    expect(r.statusCode, r.body).toBe(200);
    await held.started(2);
    const d = await readDocx(r.rawPayload);
    expect(d.xml).not.toContain(late);
    expect(d.text).toContain(KNOWN_PLACEHOLDER);
  });

  it("registered again during the second run too: a retryable error, no file", async () => {
    const one = `race-one-${crypto.randomBytes(10).toString("hex")}`;
    const two = `race-two-${crypto.randomBytes(10).toString("hex")}`;
    closers.push(
      () => knownSecrets.remove(one),
      () => knownSecrets.remove(two),
    );
    let calls = 0;
    const t = await start({
      runner: async (job) => {
        calls++;
        knownSecrets.add(calls === 1 ? one : two, { fresh: true });
        return inProcessDocRunner()(job);
      },
    });
    const c = conversation(t);
    const x = source(t.db, c.scope, { url: "https://race.example/p", title: `${one} ${two}`, site: "race" });
    answer(t.app, c.id, [entry(1, "verified", x)]);
    const r = await t.get("owner", `/api/conversations/${c.id}/references/download?format=docx`);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: "references_retry" });
    expect(r.headers["retry-after"]).toBe("1");
    expect(calls).toBe(2);
  });

  it("the fixed name itself registered (absurd, but cheap): a bare attachment with no file name", async () => {
    const day = "2026-11-13";
    const t = await start();
    const c = fixture(t);
    const ok = await t.get("owner", `/api/conversations/${c.id}/references/download?format=txt`);
    const name = decodeURIComponent(String(ok.headers["content-disposition"]).split("''")[1]!);
    expect(name).toMatch(/^참고문헌-APA-\d{4}-\d{2}-\d{2}\.txt$/);
    const both = [name, name.replace(/\.txt$/, ".docx")];
    for (const v of both) knownSecrets.add(v, { fresh: true });
    closers.push(() => both.forEach((v) => knownSecrets.remove(v)));
    for (const format of ["txt", "docx"]) {
      const r = await t.get("owner", `/api/conversations/${c.id}/references/download?format=${format}`);
      expect(r.statusCode).toBe(200);
      expect(r.headers["content-disposition"]).toBe("attachment");
    }
    expect(downloadName("school", day, "docx")).toEqual({
      full: "참고문헌-학교용-2026-11-13.docx",
      ascii: "references-school-2026-11-13.docx",
    });
  });

  for (const [label, raw, inXml] of [
    ["&amp;", "&", "&amp;"],
    ["&lt;", "<", "&lt;"],
  ] as const)
    it(`XML writing cannot make a registered value: ${label} in the file is checked and the input masked`, async () => {
      const hex = crypto.randomBytes(10).toString("hex");
      const registered = `sk-review${inXml}refs-${hex}`;
      knownSecrets.add(registered, { fresh: true });
      closers.push(() => knownSecrets.remove(registered));
      let calls = 0;
      const t = await start({
        runner: async (job) => {
          calls++;
          return inProcessDocRunner()(job);
        },
      });
      const c = conversation(t);
      // The title as typed holds no known secret; its XML form does.
      const title = `제목 sk-review${raw}refs-${hex}`;
      expect(scrubKnown(title)).toBe(title);
      const x = source(t.db, c.scope, { url: "https://xml.example/p", title, site: "xml" });
      answer(t.app, c.id, [entry(1, "verified", x)]);
      const r = await t.get("owner", `/api/conversations/${c.id}/references/download?format=docx`);
      expect(r.statusCode, r.body).toBe(200);
      expect(calls).toBe(2);
      const d = await readDocx(r.rawPayload);
      expect(d.xml).not.toContain(registered);
      expect(d.text).toContain(KNOWN_PLACEHOLDER);
      expect(await docxHoldsSecret(r.rawPayload)).toBe(false);
    });

  it("an XML hit that masking cannot explain (or one that stays): a retryable error, no file", async () => {
    const t = await start({
      runner: async (job) => {
        const made = await inProcessDocRunner()(job);
        // Every file the worker makes carries a registered value no input string holds.
        knownSecrets.add("Malgun Gothic", { fresh: true });
        return made;
      },
    });
    closers.push(() => knownSecrets.remove("Malgun Gothic"));
    const c = fixture(t);
    const r = await t.get("owner", `/api/conversations/${c.id}/references/download?format=docx`);
    expect(r.statusCode).toBe(503);
    expect(r.json()).toEqual({ error: "references_retry" });
  });

  it("docxHoldsSecret reads every XML part: raw text, text content and decoded attribute values", async () => {
    const JSZip = createRequire(import.meta.url)("jszip") as typeof JSZipType;
    const secret = `attr&secret-${crypto.randomBytes(8).toString("hex")}`;
    knownSecrets.add(secret, { fresh: true });
    closers.push(() => knownSecrets.remove(secret));
    const zipOf = async (xml: string) => {
      const z = new JSZip();
      z.file("word/document.xml", "<w:document/>");
      z.file("docProps/custom.xml", xml);
      return z.generateAsync({ type: "nodebuffer" });
    };
    // Only in an attribute, and only once its entity is decoded (raw: `&amp;`; tags hold no text).
    const inAttr = secret.replace("&", "&amp;");
    expect(await docxHoldsSecret(await zipOf(`<p name="${inAttr}"/>`))).toBe(true);
    expect(await docxHoldsSecret(await zipOf(`<p name='${inAttr}'/>`))).toBe(true);
    // In text split by tags: the text content joins it.
    const [a, b] = [secret.slice(0, 10), secret.slice(10)];
    expect(await docxHoldsSecret(await zipOf(`<p><r>${a.replace("&", "&amp;")}</r><r>${b}</r></p>`))).toBe(
      true,
    );
    expect(await docxHoldsSecret(await zipOf(`<p name="nothing">plain</p>`))).toBe(false);
    expect(await docxHoldsSecret(Buffer.from("not a zip"))).toBe(true);
  });

  it("whole values only: a secret whose first characters are the worker's font name does not block every export", async () => {
    const long = `Malgun Gothic-${crypto.randomBytes(8).toString("hex")}`;
    knownSecrets.add(long, { fresh: true });
    closers.push(() => knownSecrets.remove(long));
    const t = await start();
    const c = fixture(t);
    const r = await t.get("owner", `/api/conversations/${c.id}/references/download?format=docx`);
    expect(r.statusCode, r.body).toBe(200);
    // The font name registered in full is still found (the "hit no input explains" test above: 503).
    knownSecrets.add("Malgun Gothic", { fresh: true });
    closers.push(() => knownSecrets.remove("Malgun Gothic"));
    const blocked = await t.get("owner", `/api/conversations/${c.id}/references/download?format=docx`);
    expect(blocked.statusCode).toBe(503);
    expect(blocked.json()).toEqual({ error: "references_retry" });
  });

  describe("a value registered while the file's parts are being read", () => {
    /** The XML parts of a generated `.docx`, in the order they are read. */
    const partNames = async () => {
      const made = await inProcessDocRunner()({
        kind: "docx",
        doc: { title: "참고문헌", subtitle: "t", blocks: [{ type: "paragraph", text: "x" }] },
        images: {},
      });
      if (!made.ok) throw new Error(made.code);
      const JSZip = createRequire(import.meta.url)("jszip") as typeof JSZipType;
      const zip = await JSZip.loadAsync(made.data);
      return Object.keys(zip.files).filter((n) => /\.(xml|rels)$/i.test(n));
    };
    /** The part the server reads first, or last (`[Content_Types].xml` — the review's case). */
    const pick = (names: string[], which: "early" | "late") => {
      expect(names.at(-1)).toBe("[Content_Types].xml");
      return which === "early" ? names[0]! : names.at(-1)!;
    };
    /**
     * Registers `value` (once) when the server's reader (`readParts`, docx-check.ts) reads the part `name` — through
     * the ZIP entry's `async`. Reads by the document worker's own re-open (same library) do not count.
     */
    const registerDuring = async (name: string, value: string) => {
      const JSZip = createRequire(import.meta.url)("jszip") as typeof JSZipType;
      const z = new JSZip();
      z.file("probe.xml", "<p/>");
      const proto = Object.getPrototypeOf(z.file("probe.xml")) as { async: (...a: unknown[]) => unknown };
      const original = proto.async;
      let done = false;
      const spy = vi.spyOn(proto, "async").mockImplementation(function (
        this: { name: string },
        ...a: unknown[]
      ) {
        if (!done && this.name === name && /docx-check/.test(new Error().stack ?? "")) {
          done = true;
          knownSecrets.add(value, { fresh: true });
        }
        return original.apply(this, a);
      });
      closers.push(
        () => spy.mockRestore(),
        () => knownSecrets.remove(value),
        () => expect(done, `${name} was read by the server`).toBe(true),
      );
    };

    for (const which of ["early", "late"] as const)
      it(`${which} part, the value in the body (a source title): masked, made again, never raw`, async () => {
        const names = await partNames();
        const part = pick(names, which);
        const value = `read-race-${which}-${crypto.randomBytes(8).toString("hex")}`;
        const t = await start();
        const c = conversation(t);
        const x = source(t.db, c.scope, {
          url: "https://read.example/p",
          title: `제목 ${value}`,
          site: "read",
        });
        answer(t.app, c.id, [entry(1, "verified", x)]);
        await registerDuring(part, value);
        const r = await t.get("owner", `/api/conversations/${c.id}/references/download?format=docx`);
        expect(r.statusCode, r.body).toBe(200);
        const d = await readDocx(r.rawPayload);
        expect(d.xml).not.toContain(value);
        expect(d.text).toContain(KNOWN_PLACEHOLDER);
      });

    for (const which of ["early", "late"] as const)
      it(`${which} part, the value only in the metadata (docProps): refused`, async () => {
        const names = await partNames();
        expect(names).toContain("docProps/core.xml");
        const part = pick(names, which);
        const t = await start();
        const c = fixture(t);
        // The document's creator (docProps/core.xml) — no input string holds it.
        await registerDuring(part, "Agent Lee");
        const r = await t.get("owner", `/api/conversations/${c.id}/references/download?format=docx`);
        expect(r.statusCode).toBe(503);
        expect(r.json()).toEqual({ error: "references_retry" });
      });
  });

  it("registered while the worker runs, in a field that was cut: the raw field is checked again (101-char title)", async () => {
    // 33 characters, the last 33 of a 101-character conversation title — cut at 100, 32 of them would be left.
    const secret = `cut-${crypto.randomBytes(16).toString("hex")}`.slice(0, 33);
    expect(secret).toHaveLength(33);
    closers.push(() => knownSecrets.remove(secret));
    const held = gated();
    const t = await start({ runner: held.runner });
    const c = fixture(t);
    const title = `${"가".repeat(101 - 33)}${secret}`;
    expect(title).toHaveLength(101);
    t.app.conversations!.rename(c.id, title);
    const pending = t.get("owner", `/api/conversations/${c.id}/references/download?format=docx`);
    await held.started(1);
    knownSecrets.add(secret, { fresh: true });
    held.release();
    const r = await pending;
    expect(r.statusCode, r.body).toBe(200);
    const d = await readDocx(r.rawPayload);
    // Not even the cut part: the finished subtitle ("… · APA 7") hides where the field was cut.
    expect(d.xml).not.toContain(secret.slice(0, 32));
    expect(d.xml).not.toContain(secret.slice(0, 8));
    expect(d.paragraphs[1]).toBe(`${"가".repeat(101 - 33)}${KNOWN_PLACEHOLDER} · APA 7`);
  });

  describe("the download name never comes from the title (review #115 round 6)", () => {
    const names = (cd: string) => ({
      ascii: /filename="([^"]*)"/.exec(cd)?.[1] ?? "",
      full: decodeURIComponent(/filename\*=UTF-8''(.*)$/.exec(cd)?.[1] ?? ""),
    });
    const hex = crypto.randomBytes(12).toString("hex");
    const TITLES = {
      normal: "과학 숙제",
      slashes: `${"/".repeat(68)}sk-norm/x/${hex}`,
      emoji: "👨‍👩‍👧 가족 여행 🇰🇷 조사",
      long: `${"가".repeat(68)}late-name-${hex}`,
    };
    for (const [label, title] of Object.entries(TITLES))
      for (const [style, tag] of [
        ["apa", "APA"],
        ["mla", "MLA"],
        ["school", "학교용"],
      ] as const)
        it(`${label} title, ${style}: 참고문헌-${tag}-<day> for .txt and .docx, no title text in either name`, async () => {
          // A registered value that would rename a title ending in a date (round 6) changes nothing here.
          const dated = `2026-11-13-private-passphrase-${hex}`;
          knownSecrets.add(dated, { fresh: true });
          closers.push(() => knownSecrets.remove(dated));
          const t = await start();
          const c = fixture(t);
          t.app.conversations!.rename(c.id, title);
          for (const format of ["txt", "docx"]) {
            const r = await t.get(
              "owner",
              `/api/conversations/${c.id}/references/download?style=${style}&format=${format}`,
            );
            expect(r.statusCode, r.body).toBe(200);
            const { ascii, full } = names(String(r.headers["content-disposition"]));
            expect(full).toMatch(new RegExp(`^참고문헌-${tag}-\\d{4}-\\d{2}-\\d{2}\\.${format}$`));
            expect(ascii).toMatch(
              new RegExp(
                `^references-${style === "school" ? "school" : tag}-\\d{4}-\\d{2}-\\d{2}\\.${format}$`,
              ),
            );
            for (const piece of [title.slice(-8), "과학", "sk-norm", "가족", "late-name"])
              for (const v of [ascii, full]) expect(v).not.toContain(piece);
          }
        });

    it("the date is the access day in the user's time zone", async () => {
      const t = await start({});
      const c = fixture(t);
      t.db
        .insert(notificationPrefs)
        .values({ userId: t.f.users.owner.id, timeZone: "Pacific/Kiritimati", updatedAt: Date.now() })
        .run();
      const r = await t.get("owner", `/api/conversations/${c.id}/references/download?format=txt`);
      const { full } = names(String(r.headers["content-disposition"]));
      const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Kiritimati" }).format(new Date());
      // (A run right at midnight there may see the next day: allow it.)
      const next = new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Kiritimati" }).format(
        new Date(Date.now() + 60_000),
      );
      expect([`참고문헌-APA-${day}.txt`, `참고문헌-APA-${next}.txt`]).toContain(full);
    });
  });
});
