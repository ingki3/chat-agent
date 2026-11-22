import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sourceTypeOf } from "@agentlee/shared";
import { SELFTEST_SKILL } from "@agentlee/mcp-tools/skills";
import { UserStore } from "../src/auth/users.js";
import { closestPassage, findPassages, sentenceRanges, termsOf } from "../src/citations/passages.js";
import { ConversationStore } from "../src/conversations/store.js";
import { createTestDb } from "../src/db/client.js";
import { docLibraries } from "../src/docgen/runner.js";
import { inProcessExtractor, type OcrCapability } from "../src/files/extract.js";
import { McpTokens } from "../src/isolation/tokens.js";
import { McpService } from "../src/mcp/service.js";
import { extractorPdfReader, type PdfReader } from "../src/web/pdf.js";
import { EXCERPT_CHARS, pdfTitle } from "../src/web/service.js";
import { SourceStore } from "../src/web/sources.js";
import { callOurTool } from "./helpers/live-mcp.js";
import { startWebFixture, type WebFixture } from "./helpers/web-fixture.js";
import { run as runWorker } from "../../../packages/mcp-tools/web/worker.mjs";

/**
 * 깊이 조사의 조사 한계 (#234): PDF pages through the document extractor, `web_find` over a page's stored text, the
 * passages behind both (and behind the note repair), and the source type. No network: the fixture site only.
 */

const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});
let fx: WebFixture;
beforeEach(async () => {
  fx = await startWebFixture();
  closers.push(() => fx.close());
});
afterEach(() => expect(fx.leaks).toEqual([]));

const NO_OCR = (): OcrCapability => ({ available: false, reason: "test" });
const tmp = () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-webpdf-")));
  closers.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};

/** A synthetic PDF made here with pdfkit (pinned, already a dependency): one page per text, Korean font embedded. */
async function makePdf(pages: string[]): Promise<Buffer> {
  const require = createRequire(import.meta.url);
  const PDFDocument = (await import(require.resolve("pdfkit"))).default as new (o?: object) => {
    registerFont(n: string, f: string): void;
    font(n: string): unknown;
    fontSize(n: number): unknown;
    text(t: string): unknown;
    addPage(): unknown;
    on(e: string, f: (c?: Buffer) => void): void;
    end(): void;
  };
  const doc = new PDFDocument({ autoFirstPage: true });
  doc.registerFont("R", docLibraries().fonts.regular);
  doc.font("R");
  doc.fontSize(11);
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve) => {
    doc.on("data", (c) => chunks.push(c!));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
  });
  for (const [i, t] of pages.entries()) {
    if (i) doc.addPage();
    doc.text(t);
  }
  doc.end();
  return done;
}

function family() {
  const db = createTestDb();
  const users = new UserStore(db);
  const mom = users.create({ email: "mom@example.com", name: "엄마", role: "member", passwordHash: "x" });
  const son = users.create({ email: "son@example.com", name: "아들", role: "member", passwordHash: "x" });
  const conversations = new ConversationStore(db);
  const c = conversations.create(mom.id);
  const other = conversations.create(son.id);
  const scope = { userId: mom.id, conversationId: c.id, runId: crypto.randomUUID() };
  const sonScope = { userId: son.id, conversationId: other.id, runId: crypto.randomUUID() };
  return { db, users, mom, son, c, scope, sonScope, sources: new SourceStore(db) };
}

function service(f: ReturnType<typeof family>, pdf?: PdfReader) {
  const tokens = new McpTokens();
  const svc = new McpService(tokens, f.users, {
    skills: [SELFTEST_SKILL],
    python: { exe: "/opt/py/bin/python3.12", root: "/opt/py" },
    web: {
      sources: f.sources,
      worker: fx.worker,
      fetchProxy: { endpoint: async () => fx.proxy, close: async () => {} },
      searchProviders: [],
      ...(pdf ? { pdf } : {}),
    },
  });
  closers.push(() => svc.close());
  const call = async (tool: string, args: unknown, scope = f.scope) => {
    const { url } = await svc.endpoint();
    const r = await callOurTool(url, tokens.issue(scope), tool, args);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(r.content[0]!.text!) as Record<string, unknown>;
    } catch {
      body = { text: r.content[0]?.text };
    }
    return { isError: r.isError, body };
  };
  return { svc, call };
}

const PLAN_PAGES = [
  "2027학년도 대학입학전형 시행계획\n이 계획은 대학입학전형의 기본 사항을 정한다.",
  "수시모집 원서 접수는 2026년 9월 8일부터 12일까지 진행된다.\n정시모집 원서 접수는 2026년 12월 29일부터 31일까지이다.",
];

describe("web_fetch reads PDFs with the document extractor (#234)", () => {
  it("the worker hands back a PDF's bytes; the extractor reads its pages; the page is stored and quotable", async () => {
    const bytes = await makePdf(PLAN_PAGES);
    fx.routes.set("/docs/2027%20%EC%8B%9C%ED%96%89%EA%B3%84%ED%9A%8D.pdf", {
      headers: { "content-type": "application/pdf" },
      body: bytes,
    });
    const url = "http://public.test/docs/2027%20%EC%8B%9C%ED%96%89%EA%B3%84%ED%9A%8D.pdf";
    const raw = (await runWorker({ op: "fetch", url }, { proxy: fx.proxy.url })) as Record<string, unknown>;
    expect(raw).toMatchObject({ ok: true, contentType: "application/pdf" });
    expect(Buffer.from(String(raw.pdf), "base64").equals(bytes)).toBe(true);

    const dir = tmp();
    const reader = extractorPdfReader(inProcessExtractor(NO_OCR), dir);
    const read = await reader(bytes);
    expect(read.ok).toBe(true);
    const text = (read as { text: string }).text;
    expect(text).toContain("2027학년도 대학입학전형 시행계획");
    expect(text).toContain("정시모집 원서 접수는 2026년 12월 29일부터 31일까지이다.");
    // Pages in order, the temporary copy gone.
    expect(text.indexOf("시행계획")).toBeLessThan(text.indexOf("수시모집"));
    expect(fs.readdirSync(dir)).toEqual([]);

    const f = family();
    const { svc, call } = service(f, reader);
    expect(svc.toolNamesFor(f.mom.id)).toContain("web_find");
    const r = await call("web_fetch", { url });
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({
      contentType: "application/pdf",
      title: "2027 시행계획.pdf",
      site: "public.test",
      sourceType: "other",
    });
    const [row] = f.sources.list(f.c.id);
    expect(row).toMatchObject({ kind: "page", contentType: "application/pdf" });
    expect(row!.body).toContain("수시모집 원서 접수는 2026년 9월 8일부터 12일까지 진행된다.");
  });

  it("without a reader a PDF is refused as before; a broken PDF is bad content; a PDF without text has no text", async () => {
    const f = family();
    fx.routes.set("/a.pdf", { headers: { "content-type": "application/pdf" }, body: "%PDF-1.7 broken" });
    expect((await service(f).call("web_fetch", { url: "http://public.test/a.pdf" })).body).toMatchObject({
      error: "web_unsupported_type",
    });
    const reader = extractorPdfReader(inProcessExtractor(NO_OCR), tmp());
    expect(await reader(Buffer.from("%PDF-1.7 broken"))).toEqual({ ok: false, code: "web_bad_content" });
    const g = family();
    expect(
      (await service(g, reader).call("web_fetch", { url: "http://public.test/a.pdf" })).body,
    ).toMatchObject({
      error: "web_bad_content",
    });
    // A PDF with no text (an empty page): nothing to store.
    const empty = await makePdf([""]);
    const blank = await reader(empty);
    expect(blank).toEqual({ ok: true, text: "", truncated: false });
    fx.routes.set("/blank.pdf", { headers: { "content-type": "application/pdf" }, body: empty });
    expect(
      (await service(g, reader).call("web_fetch", { url: "http://public.test/blank.pdf" })).body,
    ).toMatchObject({ error: "web_no_text" });
  });

  it("the extractor's failures map to web codes; a reader runs at most two at once", async () => {
    let active = 0;
    let max = 0;
    const slow = extractorPdfReader(async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 20));
      active--;
      return { ok: false, code: "extract_timeout" };
    }, tmp());
    const all = await Promise.all(Array.from({ length: 5 }, () => slow(Buffer.from("%PDF-1.7"))));
    expect(all.every((r) => !r.ok && r.code === "web_timeout")).toBe(true);
    expect(max).toBe(2);
    const unavailable = extractorPdfReader(async () => ({ ok: false, code: "extract_unavailable" }), tmp());
    expect(await unavailable(Buffer.from("%PDF-1.7"))).toEqual({ ok: false, code: "web_unavailable" });
  });

  it("a PDF's title is its file name when it has none", () => {
    expect(pdfTitle(new URL("https://www.kcue.or.kr/down/2027%20plan.pdf"))).toBe("2027 plan.pdf");
    expect(pdfTitle(new URL("https://example.org/"))).toBeUndefined();
    expect(pdfTitle(new URL("https://example.org/%E0%A4%A.pdf"))).toBe("%E0%A4%A.pdf");
  });
});

describe("web_find searches a fetched page's whole stored text (#234)", () => {
  const long = [
    "<html><head><title>긴 시행계획</title></head><body><article>",
    `<p>${"이 문서는 앞부분의 일반 안내이다. ".repeat(700)}</p>`,
    "<p>정시모집 원서 접수는 2026년 12월 29일부터 31일까지이다. 접수는 대학별 누리집에서 한다.</p>",
    "<p>수시모집 합격자 발표는 2026년 12월 12일까지 마친다.</p>",
    "</article></body></html>",
  ].join("");

  it("finds a phrase beyond the excerpt, then passages with most of the words; ids of other users are unknown", async () => {
    fx.routes.set("/long.html", { headers: { "content-type": "text/html; charset=utf-8" }, body: long });
    const f = family();
    const { call } = service(f);
    const fetched = await call("web_fetch", { url: "http://public.test/long.html" });
    const sourceId = String(fetched.body.sourceId);
    expect(Number(fetched.body.characters)).toBeGreaterThan(EXCERPT_CHARS);
    expect(String(fetched.body.content)).not.toContain("정시모집");

    const phrase = await call("web_find", { sourceId, query: "정시모집   원서 접수" });
    expect(phrase.isError).toBe(false);
    expect(phrase.body).toMatchObject({ sourceId, status: "find_found", matches: 1 });
    const results = phrase.body.results as { n: number; at: number; phrase: boolean }[];
    expect(results).toHaveLength(1);
    expect(results[0]!.phrase).toBe(true);
    expect(results[0]!.at).toBeGreaterThan(EXCERPT_CHARS);
    const content = String(phrase.body.content);
    expect(content).toContain("정시모집 원서 접수는 2026년 12월 29일부터 31일까지이다.");
    expect(content.match(/<\/external_content>/g)).toHaveLength(1);

    // Keywords, not a phrase: the sentence with most of them (a particle on the page's word is fine).
    const words = await call("web_find", { sourceId, query: "합격자 발표 수시모집" });
    expect(String(words.body.content)).toContain("수시모집 합격자 발표는 2026년 12월 12일까지 마친다.");
    const none = await call("web_find", { sourceId, query: "등록금 환불" });
    expect(none.body).toMatchObject({ status: "find_none", matches: 0, results: [] });

    // Another conversation's (another user's) token cannot read this page; an unknown id is unknown.
    expect((await call("web_find", { sourceId, query: "정시모집" }, f.sonScope)).body).toMatchObject({
      error: "unknown_source",
    });
    expect((await call("web_find", { sourceId: "nope", query: "정시모집" })).body).toMatchObject({
      error: "unknown_source",
    });
    expect((await call("web_find", { sourceId, query: "a\u0007b" })).isError).toBe(true);
  });

  it("findPassages: best first, no overlaps, context bounded", () => {
    const text =
      "가격이 올랐다. 수출이 늘었다.\n반도체 수출이 32% 늘었다. 메모리 가격이 회복됐다.\n" +
      "다른 이야기다. ".repeat(50) +
      "반도체 수출 증가는 메모리 가격 회복 덕분이다.";
    const r = findPassages(text, "반도체 수출", 5);
    expect(r.passages[0]!.phrase).toBe(true);
    expect(r.passages.map((p) => p.text.includes("반도체 수출"))).toEqual(r.passages.map(() => true));
    for (const [i, a] of r.passages.entries())
      for (const b of r.passages.slice(i + 1)) expect(a.end <= b.start || b.end <= a.start).toBe(true);
    for (const p of r.passages) expect(p.text.length).toBeLessThanOrEqual(700);
    expect(findPassages(text, "   ", 5)).toEqual({ total: 0, passages: [] });
  });
});

describe("the closest passage for a quote that did not verify (#234 note repair)", () => {
  const page =
    "산업통상자원부는 10일 10월 반도체 수출이 전년 같은 달보다 32% 늘어난 142억 달러로 집계됐다고 밝혔다.\n" +
    "메모리 가격 회복이 증가를 이끌었다. 업계는 연말까지 증가세가 이어질 것으로 본다.";

  it("match: the page's own sentence for a quote with changed punctuation and endings", () => {
    const r = closestPassage(
      page,
      "산업통상자원부는 10일, 10월 반도체 수출이 전년 같은 달보다 32% 늘어난 142억 달러로 집계됐다",
    );
    expect(r).toEqual({
      kind: "match",
      passage:
        "산업통상자원부는 10일 10월 반도체 수출이 전년 같은 달보다 32% 늘어난 142억 달러로 집계됐다고 밝혔다.",
      recall: expect.any(Number),
    });
    // Two sentences the model joined with "…": the window of both.
    const joined = closestPassage(
      page,
      "메모리 가격 회복이 증가를 이끌었다 … 업계는 연말까지 증가세가 이어질 것으로",
    );
    expect(joined).toMatchObject({
      kind: "match",
      passage: "메모리 가격 회복이 증가를 이끌었다. 업계는 연말까지 증가세가 이어질 것으로 본다.",
    });
  });

  it("no match: other figures, too few shared words, or too short a quote", () => {
    expect(closestPassage(page, "10월 반도체 수출이 전년 같은 달보다 50% 늘어난 142억 달러")).toEqual({
      kind: "none",
    });
    expect(closestPassage(page, "메모리 반도체 가격이 크게 올라 수익이 늘었다")).toEqual({ kind: "none" });
    expect(closestPassage(page, "수출 증가")).toEqual({ kind: "none" });
  });

  it("ambiguous: two different passages match about as well — neither is taken", () => {
    const twins = "서울시는 2026년 예산을 늘린다고 밝혔다.\n부산시는 2026년 예산을 늘린다고 밝혔다.";
    expect(closestPassage(twins, "시는 2026년 예산을 늘린다고 밝혔다")).toEqual({ kind: "ambiguous" });
    // The very same sentence twice is one passage, not a rival.
    const same = "서울시는 2026년 예산을 늘린다고 밝혔다.\n서울시는 2026년 예산을 늘린다고 밝혔다.";
    expect(closestPassage(same, "서울시는 2026년, 예산을 늘린다고 밝혔다")).toMatchObject({ kind: "match" });
  });

  it("sentences: split at line breaks and sentence ends, not inside numbers or dates; long ones cut at clauses", () => {
    const t = "2026. 11. 12. 발표했다. 금리는 3.5%다! 다음 줄\n둘째 줄";
    expect(sentenceRanges(t).map((r) => t.slice(r.start, r.end))).toEqual([
      "2026. 11. 12.",
      "발표했다.",
      "금리는 3.5%다!",
      "다음 줄",
      "둘째 줄",
    ]);
    const long = `${"가나다라 ".repeat(60)}, ${"마바사 ".repeat(60)}`;
    expect(sentenceRanges(long).every((r) => r.end - r.start <= 400)).toBe(true);
    expect(termsOf("수출이 반도체를 Node.js로")).toEqual(["수출", "반도체", "node", "js"]);
  });
});

describe("source type by domain (#234)", () => {
  it("government, academic, organization, other", () => {
    expect(
      [
        "https://www.moe.go.kr/a.pdf",
        "https://www.whitehouse.gov/",
        "https://www.gov.uk/x",
        "https://ec.europa.eu/",
        "https://www.snu.ac.kr/",
        "https://www.kice.re.kr/",
        "https://mit.edu/",
        "https://www.ox.ac.uk/",
        "https://www.kcue.or.kr/",
        "https://wikipedia.org/",
        "https://blog.naver.com/",
        "https://ac.example.com/",
        "not a url",
      ].map(sourceTypeOf),
    ).toEqual([
      "government",
      "government",
      "government",
      "government",
      "academic",
      "academic",
      "academic",
      "academic",
      "organization",
      "organization",
      "other",
      "other",
      "other",
    ]);
  });
});
