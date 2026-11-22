import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SELFTEST_SKILL } from "@agentlee/mcp-tools/skills";
import { UserStore } from "../src/auth/users.js";
import { findSnippet, GAP_MARK, PAGE_GAP } from "../src/citations/verify.js";
import { ConversationStore } from "../src/conversations/store.js";
import { createTestDb } from "../src/db/client.js";
import { docLibraries } from "../src/docgen/runner.js";
import { inProcessExtractor, type OcrCapability } from "../src/files/extract.js";
import { McpTokens } from "../src/isolation/tokens.js";
import { McpService } from "../src/mcp/service.js";
import { extractorPdfReader, PDF_TEXT_CHARS, type PdfReader } from "../src/web/pdf.js";
import { EXCERPT_CHARS, workerLimitsOf } from "../src/web/service.js";
import { pdfTitle, SourceStore, toSource } from "../src/web/sources.js";
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

/** A grey square as a PNG (made here: zlib's deflate and CRC) — a "scanned" page's picture. */
function grayPng(size = 64): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const rows = Buffer.concat(
    Array.from({ length: size }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(size, 128)])),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A synthetic PDF made here with pdfkit (pinned, already a dependency): one page per entry, Korean font embedded — a
 * text, or `{ scan: true }` for a page that is only a picture.
 */
async function makePdf(pages: (string | { scan: true })[], o: { title?: string } = {}): Promise<Buffer> {
  const require = createRequire(import.meta.url);
  const PDFDocument = (await import(require.resolve("pdfkit"))).default as new (o?: object) => {
    registerFont(n: string, f: string): void;
    font(n: string): unknown;
    fontSize(n: number): unknown;
    text(t: string): unknown;
    image(b: Buffer, o?: object): unknown;
    addPage(): unknown;
    on(e: string, f: (c?: Buffer) => void): void;
    end(): void;
  };
  const doc = new PDFDocument({ autoFirstPage: true, ...(o.title ? { info: { Title: o.title } } : {}) });
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
    if (typeof t === "string") doc.text(t);
    else doc.image(grayPng(), { width: 400 });
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
      site: "public.test",
      sourceType: "other",
    });
    const [row] = f.sources.list(f.c.id);
    expect(row).toMatchObject({ kind: "page", contentType: "application/pdf", title: "2027 시행계획.pdf" });
    expect(String(r.body.content)).toContain("title: 2027 시행계획.pdf");
    expect(row!.body).toContain("수시모집 원서 접수는 2026년 9월 8일부터 12일까지 진행된다.");
  });

  it("a PDF is named by its own metadata title, else by its file name (review #237 13차)", async () => {
    const reader = extractorPdfReader(inProcessExtractor(NO_OCR), tmp());
    const titled = await makePdf(["연구 보고서 본문이다."], { title: "  Annual   Research Report " });
    const plain = await makePdf(["연구 보고서 본문이다."]);
    fx.routes.set("/a/download.pdf", { headers: { "content-type": "application/pdf" }, body: titled });
    fx.routes.set("/b/download.pdf", { headers: { "content-type": "application/pdf" }, body: plain });
    const f = family();
    const { call } = service(f, reader);
    const a = await call("web_fetch", { url: "http://public.test/a/download.pdf" });
    expect(String(a.body.content)).toContain("title: Annual Research Report");
    expect(a.body.title).toBeUndefined();
    const b = await call("web_fetch", { url: "http://public.test/b/download.pdf" });
    expect(String(b.body.content)).toContain("title: download.pdf");
    expect(f.sources.list(f.c.id).map((r) => r.title)).toEqual(["Annual Research Report", "download.pdf"]);
  });

  it("a metadata title loses its control and bidi characters; nothing left → the file name", async () => {
    const reader = extractorPdfReader(inProcessExtractor(NO_OCR), tmp());
    const tricky = await makePdf(["본문 글자가 있는 문서입니다."], {
      title: "\u202Eevil\u0007 Report\u2066",
    });
    const empty = await makePdf(["본문 글자가 있는 다른 문서입니다."], { title: "\u202E\u200F\u0001" });
    expect(await reader(tricky)).toMatchObject({ ok: true, title: "evil Report" });
    expect((await reader(empty)) as { title?: string }).not.toHaveProperty("title");
    fx.routes.set("/c/empty.pdf", { headers: { "content-type": "application/pdf" }, body: empty });
    const f = family();
    await service(f, reader).call("web_fetch", { url: "http://public.test/c/empty.pdf" });
    expect(f.sources.list(f.c.id)[0]!.title).toBe("empty.pdf");
  });

  it("a file-name title loses decoded control and bidi characters; nothing left → the site", async () => {
    expect(pdfTitle(new URL("https://a.test/report%E2%80%AE.pdf"))).toBe("report.pdf");
    expect(pdfTitle(new URL("https://a.test/%E2%80%AE%07"))).toBeUndefined();
    const plain = await makePdf(["이름 없는 문서 본문이다."]);
    fx.routes.set("/g/%E2%80%AE%E2%81%A6", { headers: { "content-type": "application/pdf" }, body: plain });
    const f = family();
    await service(f, extractorPdfReader(inProcessExtractor(NO_OCR), tmp())).call("web_fetch", {
      url: "http://public.test/g/%E2%80%AE%E2%81%A6",
    });
    expect(f.sources.list(f.c.id)[0]!.title).toBe("public.test");
  });

  it("a stored row never changes: another title or final address is a new row; the exact same fetch is the same row", async () => {
    let withTitle = false;
    const real = extractorPdfReader(inProcessExtractor(NO_OCR), tmp());
    const reader: PdfReader = async (b, signal) => {
      const r = await real(b, signal);
      return !r.ok || withTitle ? r : { ok: true, text: r.text, truncated: r.truncated, unread: r.unread };
    };
    const body = await makePdf(["같은 문서의 본문이다."], { title: "Latest Title" });
    for (const p of ["/h/a.pdf", "/h/b.pdf"])
      fx.routes.set(p, { headers: { "content-type": "application/pdf" }, body });
    const f = family();
    const { call } = service(f, reader);
    fx.redirects.set("/h/get", "/h/a.pdf");
    const first = await call("web_fetch", { url: "http://public.test/h/get" });
    // The very same fetch again: the same row.
    expect((await call("web_fetch", { url: "http://public.test/h/get" })).body.sourceId).toBe(
      first.body.sourceId,
    );
    // The redirect now ends at another file: a new row; the first one as it was.
    fx.redirects.set("/h/get", "/h/b.pdf");
    const moved = await call("web_fetch", { url: "http://public.test/h/get" });
    // The same address now with the document's own title: a new row too.
    withTitle = true;
    const titled = await call("web_fetch", { url: "http://public.test/h/get" });
    const ids = [first, moved, titled].map((r) => String(r.body.sourceId));
    expect(new Set(ids).size).toBe(3);
    const byId = new Map(f.sources.list(f.c.id).map((r) => [r.id, r]));
    expect(ids.map((id) => [byId.get(id)!.finalUrl, byId.get(id)!.title])).toEqual([
      ["http://public.test/h/a.pdf", "a.pdf"],
      ["http://public.test/h/b.pdf", "b.pdf"],
      ["http://public.test/h/b.pdf", "Latest Title"],
    ]);
    // Each row's type and date are its own.
    for (const id of ids) expect(byId.get(id)!.contentType).toBe("application/pdf");
  });

  it("a row stored before (a bidi-control title) stays as it was; a new fetch makes a clean row", async () => {
    const body = await makePdf(["오래된 행의 본문이다."]);
    fx.routes.set("/i/report.pdf", { headers: { "content-type": "application/pdf" }, body });
    const f = family();
    const reader = extractorPdfReader(inProcessExtractor(NO_OCR), tmp());
    const text = ((await reader(body)) as { text: string }).text;
    const old = f.sources.addPage(f.scope, {
      url: "http://public.test/i/report.pdf",
      finalUrl: "http://public.test/i/report.pdf",
      title: "report\u202E.pdf",
      site: "public.test",
      contentType: "application/pdf",
      body: text,
      truncated: false,
    })!;
    const r = await service(f, reader).call("web_fetch", { url: "http://public.test/i/report.pdf" });
    expect(r.body.sourceId).not.toBe(old.id);
    expect(f.sources.get(f.c.id, old.id)!.title).toBe("report\u202E.pdf");
    expect(f.sources.get(f.c.id, String(r.body.sourceId))!.title).toBe("report.pdf");
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
    expect(blank).toEqual({ ok: true, text: "", truncated: false, unread: false });
    fx.routes.set("/blank.pdf", { headers: { "content-type": "application/pdf" }, body: empty });
    expect(
      (await service(g, reader).call("web_fetch", { url: "http://public.test/blank.pdf" })).body,
    ).toMatchObject({ error: "web_no_text" });
  });

  it("a page that could not be read (a scan, no OCR) stays a boundary: nothing verifies across it; partial", async () => {
    const bytes = await makePdf([
      "첫 쪽의 마지막 문장은 정부는 지원금을",
      { scan: true },
      "내년부터 지급한다고 밝혔다. 셋째 쪽이다.",
    ]);
    const reader = extractorPdfReader(inProcessExtractor(NO_OCR), tmp());
    const read = await reader(bytes);
    expect(read).toMatchObject({ ok: true, truncated: true, unread: true });
    const text = (read as { text: string }).text;
    expect(text.split("\n\n")).toEqual([
      "첫 쪽의 마지막 문장은 정부는 지원금을",
      PAGE_GAP,
      "내년부터 지급한다고 밝혔다. 셋째 쪽이다.",
    ]);
    expect(findSnippet(text, "정부는 지원금을 내년부터 지급한다고 밝혔다").found).toBe(false);
    expect(findSnippet(text, "내년부터 지급한다고 밝혔다").found).toBe(true);
    fx.routes.set("/scan.pdf", { headers: { "content-type": "application/pdf" }, body: bytes });
    const f = family();
    const r = await service(f, reader).call("web_fetch", { url: "http://public.test/scan.pdf" });
    expect(r.body).toMatchObject({ truncated: true, unreadPages: true });
    // Only scans: no text at all.
    const scans = await makePdf([{ scan: true }, { scan: true }]);
    expect(await reader(scans)).toMatchObject({ ok: true, text: "" });
  });

  it("the stored PDF text is cut before a gap mark, never through it; another page's own U+E000 is kept", async () => {
    const head = "가".repeat(PDF_TEXT_CHARS - 4);
    const reader: PdfReader = async () => ({
      ok: true,
      text: `${head}\n\n${PAGE_GAP}\n\n뒤쪽 글이다.`,
      truncated: false,
      unread: true,
    });
    fx.routes.set("/cut.pdf", { headers: { "content-type": "application/pdf" }, body: "%PDF-1.7 x" });
    fx.routes.set("/pua.txt", {
      headers: { "content-type": "text/plain" },
      body: `개인 영역 문자${GAP_MARK}가 섞인 글이다.`,
    });
    const f = family();
    const { call } = service(f, reader);
    const r = await call("web_fetch", { url: "http://public.test/cut.pdf" });
    expect(r.body).toMatchObject({ truncated: true });
    const rows = f.sources.list(f.c.id);
    expect(rows[0]!.body).toBe(head);
    expect(rows[0]!.body).not.toContain(GAP_MARK);
    await call("web_fetch", { url: "http://public.test/pua.txt" });
    const plain = f.sources.list(f.c.id)[1]!;
    // Not a PDF: its own U+E000 is ordinary text, kept and counted (review #237 6차).
    expect(plain.body).toBe(`개인 영역 문자${GAP_MARK}가 섞인 글이다.`);
    expect(toSource(plain).characters).toBe(plain.body!.length);
  });

  it("a PDF's counts and web_find places are of the visible text (the marks' U+E000 left out)", async () => {
    const stored = `앞쪽 문장이다.\n\n${PAGE_GAP}\n\n뒤쪽의 정시모집 문장이다.`;
    const visible = stored.replaceAll(GAP_MARK, "");
    const reader: PdfReader = async () => ({ ok: true, text: stored, truncated: true, unread: true });
    fx.routes.set("/marks.pdf", { headers: { "content-type": "application/pdf" }, body: "%PDF-1.7 x" });
    const f = family();
    const { call } = service(f, reader);
    const fetched = await call("web_fetch", { url: "http://public.test/marks.pdf" });
    expect(fetched.body.characters).toBe(visible.length);
    expect(f.sources.listFor(f.scope)!.map((r) => toSource(r).characters)).toEqual([visible.length]);
    const found = await call("web_find", { sourceId: String(fetched.body.sourceId), query: "정시모집 문장" });
    expect(found.body.characters).toBe(visible.length);
    const [hit] = found.body.results as { at: number }[];
    expect(hit!.at).toBe(visible.indexOf("뒤쪽"));
    expect(String(found.body.content)).not.toContain(GAP_MARK);
  });

  it("the stored body and the excerpt never end in half a surrogate pair (📅 at both cuts)", async () => {
    // 📅 straddles the 10,000-character excerpt cut and the 400,000-character storage cut.
    const text = `${"가".repeat(9_999)}📅${"나".repeat(PDF_TEXT_CHARS - 10_001 - 1)}📅${"다".repeat(100)}`;
    expect(text.charCodeAt(9_999)).toBeGreaterThanOrEqual(0xd800);
    expect(text.charCodeAt(PDF_TEXT_CHARS - 1)).toBeGreaterThanOrEqual(0xd800);
    const reader: PdfReader = async () => ({ ok: true, text, truncated: false, unread: false });
    fx.routes.set("/pair.pdf", { headers: { "content-type": "application/pdf" }, body: "%PDF-1.7 x" });
    const f = family();
    const r = await service(f, reader).call("web_fetch", { url: "http://public.test/pair.pdf" });
    expect(String(r.body.content).isWellFormed()).toBe(true);
    expect(Number(r.body.excerptCharacters)).toBe(9_999);
    const [row] = f.sources.list(f.c.id);
    expect(row!.body!.isWellFormed()).toBe(true);
    expect(row!.body!.length).toBe(PDF_TEXT_CHARS - 1);
  });

  it("PDF types, octet-stream and untyped answers; the header within the first 1,024 bytes on both sides", async () => {
    const pdfLike = (n: number) => Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(n, 0x20)]);
    const at = (p: string, type: string | undefined, body: Buffer) =>
      fx.routes.set(p, {
        headers: type === undefined ? { "content-type": "" } : { "content-type": type },
        body,
      });
    const fetch = (p: string) =>
      runWorker({ op: "fetch", url: `http://public.test${p}` }, { proxy: fx.proxy.url }) as Promise<
        Record<string, unknown>
      >;
    // Larger than a page (3 MiB): a PDF type and octet-stream get the PDF limit (10 MiB); no type keeps 3 MiB.
    at("/big.pdf", "application/pdf", pdfLike(4 * 1024 * 1024));
    at("/big.bin", "application/octet-stream", pdfLike(4 * 1024 * 1024));
    at("/big-untyped", undefined, pdfLike(4 * 1024 * 1024));
    at("/small-untyped", undefined, pdfLike(1000));
    at("/huge.pdf", "application/pdf", pdfLike(11 * 1024 * 1024));
    expect(await fetch("/big.pdf")).toMatchObject({ ok: true, contentType: "application/pdf" });
    expect(await fetch("/big.bin")).toMatchObject({ ok: true, contentType: "application/pdf" });
    expect(await fetch("/big-untyped")).toEqual({ ok: false, code: "web_too_large" });
    expect(await fetch("/small-untyped")).toMatchObject({ ok: true, contentType: "application/pdf" });
    expect(await fetch("/huge.pdf")).toEqual({ ok: false, code: "web_too_large" });
    // A header after some junk (allowed by the format) — the worker and the server agree; past 1,024 bytes, neither.
    const junk = (n: number) => Buffer.concat([Buffer.alloc(n, 0x41), Buffer.from("%PDF-1.7\n")]);
    at("/junk.pdf", "application/pdf", junk(500));
    at("/late.pdf", "application/pdf", junk(2000));
    const seen: Buffer[] = [];
    const reader: PdfReader = async (b) => {
      seen.push(b);
      return { ok: true, text: "본문 글자가 있는 문서입니다.", truncated: false, unread: false };
    };
    const { call } = service(family(), reader);
    expect((await call("web_fetch", { url: "http://public.test/junk.pdf" })).isError).toBe(false);
    expect(seen).toHaveLength(1);
    expect((await call("web_fetch", { url: "http://public.test/late.pdf" })).body).toMatchObject({
      error: "web_bad_content",
    });
    expect(seen).toHaveLength(1);
  });

  it("a stopped run: a read waiting for a slot never starts; a running extraction gets the stop", async () => {
    const signals: AbortSignal[] = [];
    const held = extractorPdfReader(async ({ signal }) => {
      signals.push(signal);
      await new Promise<void>((r) => (signal.aborted ? r() : signal.addEventListener("abort", () => r())));
      return { ok: false, code: "extract_timeout" };
    }, tmp());
    const a = new AbortController();
    const b = new AbortController();
    const c = new AbortController();
    const first = held(Buffer.from("%PDF-1.7"), a.signal);
    const second = held(Buffer.from("%PDF-1.7"), b.signal);
    const third = held(Buffer.from("%PDF-1.7"), c.signal);
    await new Promise((r) => setTimeout(r, 20));
    expect(signals).toHaveLength(2);
    c.abort();
    expect(await third).toEqual({ ok: false, code: "web_not_allowed" });
    a.abort();
    expect(await first).toEqual({ ok: false, code: "web_not_allowed" });
    expect(signals[0]!.aborted).toBe(true);
    b.abort();
    await second;
    expect(signals).toHaveLength(2);
    // Stopped in the same moment a slot frees (review #237 2차): the stopped one never starts, the next one does.
    const x = new AbortController();
    const y = new AbortController();
    const z = new AbortController();
    const w = new AbortController();
    const r1 = held(Buffer.from("%PDF-1.7"), x.signal);
    const r2 = held(Buffer.from("%PDF-1.7"), y.signal);
    const r3 = held(Buffer.from("%PDF-1.7"), z.signal);
    const r4 = held(Buffer.from("%PDF-1.7"), w.signal);
    await new Promise((r) => setTimeout(r, 20));
    expect(signals).toHaveLength(4);
    z.abort();
    x.abort();
    expect(await r3).toEqual({ ok: false, code: "web_not_allowed" });
    await r1;
    await new Promise((r) => setTimeout(r, 20));
    expect(signals).toHaveLength(5);
    expect(signals.at(-1)).toBe(w.signal);
    y.abort();
    w.abort();
    await Promise.all([r2, r4]);
  });

  it("a run's stop reaches a PDF read at the revocation itself (no polling)", () => {
    const tokens = new McpTokens();
    const seen: string[] = [];
    const off = tokens.onRevoke("run-1", () => seen.push("1"));
    tokens.onRevoke("run-2", () => seen.push("2"));
    tokens.revokeRun("run-1");
    expect(seen).toEqual(["1"]);
    off();
    tokens.revokeRun("run-1");
    expect(seen).toEqual(["1"]);
    // Already stopped: called at once.
    tokens.onRevoke("run-1", () => seen.push("late"));
    expect(seen).toEqual(["1", "late"]);
  });

  it("only a page fetch may hand back 16 MiB; searches and raw jobs keep 4 MiB", () => {
    expect(workerLimitsOf({ op: "fetch", url: "https://a.test/" }).maxOutputBytes).toBe(16 * 1024 * 1024);
    expect(workerLimitsOf({ op: "search", provider: "duckduckgo", query: "x", max: 1 }).maxOutputBytes).toBe(
      4 * 1024 * 1024,
    );
    expect(workerLimitsOf({ op: "raw", steps: [{ url: "https://a.test/" }] }).maxOutputBytes).toBe(
      4 * 1024 * 1024,
    );
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
});
