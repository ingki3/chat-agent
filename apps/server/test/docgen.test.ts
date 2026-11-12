import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  CSRF_HEADER,
  DOC_CODES,
  DOC_HWP_HINT,
  DOC_LIMITS,
  FILE_KINDS,
  FILE_LIMITS,
  type DocContent,
  type MessagePart,
  type Run,
  type UploadedFile,
} from "@agentlee/shared";
import { DOC_CREATE_TOOL } from "@agentlee/mcp-tools/docgen";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import {
  DOC_WORKER_DIR,
  docLibraries,
  docRunOptions,
  inProcessDocRunner,
  sandboxedDocRunner,
  type DocRunner,
} from "../src/docgen/runner.js";
import { DocGenService, fileNameOf } from "../src/docgen/service.js";
import { DOC_CODE_VALUES } from "../src/observability/policy.js";
import { RuntimeRegistry, type RuntimeAdapter } from "../src/runtime/adapter.js";
import { ClaudeAdapter } from "../src/runtime/claude.js";
import { CODEX_MODELS, CodexAdapter } from "../src/runtime/codex.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import { DOC_FIXTURE, DOC_FIXTURE_TEXT, docScenario } from "../src/runtime/fake-docs.js";
import { knownSecrets } from "../src/secrets/known.js";
import { replayQuery, sdk, type ReplayLog } from "./helpers/claude-replay.js";
import { cx, newLog, replaySpawn } from "./helpers/codex-replay.js";
import { png, pngHeader, readDocx, readPdf, readPptx, readXlsx } from "./helpers/doc-parse.js";
import { liveCall } from "./helpers/live-mcp.js";
import { createFamily } from "./helpers/permission-matrix.js";

// Documents are made for real (fonts, layout, zip) and re-read: generous under a busy machine.
vi.setConfig({ testTimeout: 60_000 });

/**
 * Document generation (#49): `doc_create` makes DOCX, XLSX, PPTX and PDF files from blocks, re-opens them, stores
 * them as files of the conversation linked to the reply, and both runtimes reach it through our MCP server. The
 * fixture tests open every generated file with readers of their own (helpers/doc-parse.ts) and look for the title,
 * the table and the paragraph.
 */

type App = Awaited<ReturnType<typeof buildApp>>;
const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const LOCAL = { host: "localhost:3000" };
const WRITE = { ...LOCAL, origin: "http://localhost:3000", [CSRF_HEADER]: "1" };
const KINDS = ["docx", "xlsx", "pptx", "pdf"] as const;

function tmp(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-docgen-")));
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

const fake = () => {
  const r = new RuntimeRegistry();
  const rt = new FakeRuntime({ runTools: true });
  r.register(rt);
  return { registry: r, rt };
};

async function start(o: { runtimes?: RuntimeRegistry; runner?: DocRunner } = {}) {
  const dataDir = path.join(tmp(), "data");
  const log = logCapture();
  const { registry, rt } = fake();
  const db = createTestDb();
  const app = await buildApp(
    loadConfig({ NODE_ENV: "test", DATA_DIR: dataDir, MASTER_KEY_PATH: path.join(tmp(), "master.key") }),
    {
      db,
      runtimes: o.runtimes ?? registry,
      runs: { flushMs: 0 },
      logStream: log.stream,
      docs: { runner: o.runner ?? inProcessDocRunner() },
    },
  );
  closers.push(() => app.close());
  const f = await createFamily(app);
  const api = (cookie: string, method: "POST" | "GET", url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { ...WRITE, cookie, ...(payload === undefined ? {} : { "content-type": "application/json" }) },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });
  const send = async (
    cookie: string,
    conversationId: string,
    text: string,
    extra: Record<string, unknown> = {},
  ) => {
    const res = await api(cookie, "POST", `/api/conversations/${conversationId}/messages`, {
      text,
      ...extra,
    });
    expect(res.statusCode, res.body).toBe(201);
    return waitRun(app, (res.json() as { run: Run }).run.id);
  };
  const upload = async (cookie: string, conversationId: string, name: string, body: Buffer) => {
    const r = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/files`,
      headers: {
        ...WRITE,
        cookie,
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(name),
        "x-upload-id": crypto.randomUUID(),
      },
      payload: body,
    });
    expect(r.statusCode, r.body).toBe(201);
    return r.json<UploadedFile>();
  };
  const download = async (cookie: string, fileId: string) =>
    app.inject({ url: `/api/files/${fileId}/content`, headers: { ...LOCAL, cookie } });
  return { app, db, f, api, send, upload, download, rt, log: log.lines, dataDir };
}

async function waitRun(app: App, id: string) {
  for (let i = 0; i < 1000; i++) {
    const r = app.runs!.get(id)!;
    if (r.endedAt !== null) {
      const parts = app.conversations!.messageById(r.assistantMessageId)!.parts as MessagePart[];
      const results = parts.flatMap((p) => (p.type === "tool_result" ? [p] : []));
      return { run: r, parts, results };
    }
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error("run did not end");
}

/** The `doc_create` result of a run (the first tool result). */
const docResult = (r: Awaited<ReturnType<typeof waitRun>>) => {
  const out = r.results[0]!;
  return { isError: out.isError === true, output: out.output as Record<string, unknown> };
};

/** Every format, opened by its own reader: title, the paragraph and the table cells (and a picture when given). */
async function expectOpens(kind: (typeof KINDS)[number], buf: Buffer, picture = false) {
  const { title, paragraph, cells } = DOC_FIXTURE_TEXT;
  switch (kind) {
    case "docx": {
      const d = await readDocx(buf);
      expect(d.paragraphs[0]).toBe(title);
      expect(d.text).toContain(paragraph);
      expect(d.tables).toHaveLength(1);
      expect(d.tables[0]![0]).toEqual(["항목", "금액(원)", "비고"]);
      expect(d.tables[0]![1]).toEqual(["숙박", "480000", "3박"]);
      expect(d.tables[0]![3]).toEqual(["식비", "356000", "=SUM(B2:B3)"]);
      expect(d.text).toContain("[1] 제주관광공사 (2026). 제주 여행 안내서.");
      expect(d.media.length).toBe(picture ? 1 : 0);
      break;
    }
    case "xlsx": {
      const wb = await readXlsx(buf);
      expect(wb.worksheets.map((w) => w.name)).toEqual(["문서", "항목별 경비"]);
      const main = wb.getWorksheet("문서")!;
      expect(main.getCell("A1").value).toBe(title);
      const texts = main.getColumn(1).values.filter((v) => typeof v === "string") as string[];
      expect(texts.some((t) => t.includes(paragraph))).toBe(true);
      const sheet = wb.getWorksheet("항목별 경비")!;
      expect(sheet.getRow(1).values).toEqual([undefined, "항목", "금액(원)", "비고"]);
      // Numbers stay numbers; a string that looks like a formula stays a string (never a formula cell).
      expect(sheet.getCell("B2").value).toBe(480000);
      expect(sheet.getCell("C4").value).toBe("=SUM(B2:B3)");
      expect(sheet.getCell("C4").formula).toBeUndefined();
      expect(sheet.getCell("C3").value).toBeNull();
      expect(main.getImages().length).toBe(picture ? 1 : 0);
      break;
    }
    case "pptx": {
      const p = await readPptx(buf);
      expect(p.slides[0]).toContain(title);
      expect(p.text).toContain(paragraph);
      for (const c of cells) expect(p.text).toContain(c);
      expect(p.slides.some((s) => s.includes("참고문헌"))).toBe(true);
      expect(p.media.length).toBe(picture ? 1 : 0);
      break;
    }
    case "pdf": {
      const p = await readPdf(buf);
      const flat = p.text.replace(/\s+/g, "");
      expect(flat).toContain(title.replace(/\s+/g, ""));
      expect(flat).toContain(paragraph.replace(/\s+/g, ""));
      for (const c of cells) expect(flat).toContain(c.replace(/\s+/g, ""));
      expect(p.info.Title).toBe(title);
      break;
    }
  }
}

// ---- the generator on its own -----------------------------------------------------------------------------

describe("generated files open with the title, table and paragraph (#49 fixture tests)", () => {
  const runner = inProcessDocRunner();
  for (const kind of KINDS)
    it(`${kind}: generate → open → content matches (with a picture)`, async () => {
      const r = await runner({
        kind,
        doc: {
          ...DOC_FIXTURE,
          blocks: [...DOC_FIXTURE.blocks, { type: "image", fileId: "p1", caption: "사진" }],
        },
        images: { p1: { kind: "png", data: png(64, 48).toString("base64") } },
      });
      expect(r.ok, JSON.stringify(r.ok ? {} : r)).toBe(true);
      if (!r.ok) return;
      expect(r.data.length).toBeGreaterThan(1000);
      await expectOpens(kind, r.data, true);
    });

  it("long content goes on: a PDF of many paragraphs has several pages, a PPTX continues on more slides", async () => {
    const doc: DocContent = {
      title: "긴 문서",
      blocks: Array.from({ length: 60 }, (_, i) => ({
        type: "paragraph" as const,
        text: `${i + 1}번째 문단입니다. `.repeat(12),
      })),
    };
    const pdf = await runner({ kind: "pdf", doc, images: {} });
    expect(pdf.ok && pdf.checks.pages).toBeGreaterThan(3);
    const pptx = await runner({ kind: "pptx", doc, images: {} });
    expect(pptx.ok && pptx.checks.slides).toBeGreaterThan(5);
    if (pdf.ok) expect((await readPdf(pdf.data)).pages.length).toBe(pdf.checks.pages);
  });

  it("pictures: only PNG/JPG headers it can read, and never a huge one (decoded size limit)", async () => {
    const doc = (fileId: string): DocContent => ({ title: "t", blocks: [{ type: "image", fileId }] });
    expect(
      await runner({
        kind: "pdf",
        doc: doc("a"),
        images: { a: { kind: "png", data: pngHeader(10_000, 10_000).toString("base64") } },
      }),
    ).toEqual({ ok: false, code: "doc_image_too_large" });
    expect(
      await runner({
        kind: "docx",
        doc: doc("a"),
        images: { a: { kind: "png", data: Buffer.from("GIF89a....").toString("base64") } },
      }),
    ).toEqual({ ok: false, code: "doc_image_unsupported" });
    // A JPEG frame header is read for its size (no decoding here).
    const jpg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0x27, 0x10, 0x27, 0x10, 3, 0, 0, 0,
    ]);
    expect(
      await runner({
        kind: "pptx",
        doc: doc("a"),
        images: { a: { kind: "jpg", data: jpg.toString("base64") } },
      }),
    ).toEqual({ ok: false, code: "doc_image_too_large" });
    // A picture the document names but the job does not carry.
    expect(await runner({ kind: "docx", doc: doc("b"), images: {} })).toEqual({
      ok: false,
      code: "doc_image_not_found",
    });
  });

  it("the worker re-opens what it made: a file without the title or with a table missing is refused", async () => {
    const { verify } = (await import(path.join(DOC_WORKER_DIR, "verify.mjs"))) as {
      verify(kind: string, buf: Buffer, doc: DocContent, ctx: object): Promise<unknown>;
    };
    const libs = docLibraries();
    const ctx = {
      lib: async (n: keyof typeof libs.modules) => ((m) => m.default ?? m)(await import(libs.modules[n])),
    };
    for (const kind of KINDS) {
      const made = await runner({ kind, doc: DOC_FIXTURE, images: {} });
      if (!made.ok) throw new Error(made.code);
      await expect(verify(kind, made.data, DOC_FIXTURE, ctx)).resolves.toBeTruthy();
      await expect(verify(kind, Buffer.from("not a document"), DOC_FIXTURE, ctx)).rejects.toMatchObject({
        code: "doc_invalid",
      });
    }
    // The title is looked for in the office files' text (a PDF's text is compressed: its structure is checked).
    for (const kind of ["docx", "xlsx", "pptx"] as const) {
      const made = await runner({ kind, doc: DOC_FIXTURE, images: {} });
      if (!made.ok) throw new Error(made.code);
      await expect(
        verify(kind, made.data, { ...DOC_FIXTURE, title: "다른 제목" }, ctx),
      ).rejects.toMatchObject({ code: "doc_invalid" });
    }
    const docx = await runner({ kind: "docx", doc: DOC_FIXTURE, images: {} });
    if (!docx.ok) throw new Error(docx.code);
    const extraTable = { ...DOC_FIXTURE, blocks: [...DOC_FIXTURE.blocks, DOC_FIXTURE.blocks[4]!] };
    await expect(verify("docx", docx.data, extraTable, ctx)).rejects.toMatchObject({ code: "doc_invalid" });
    await expect(
      verify(
        "xlsx",
        ((await runner({ kind: "xlsx", doc: DOC_FIXTURE, images: {} })) as { data: Buffer }).data,
        extraTable,
        ctx,
      ),
    ).rejects.toMatchObject({ code: "doc_invalid" });
  });

  it("file names: the title or the given name, an extension it had replaced by the kind's own, nothing unsafe", () => {
    expect(fileNameOf("제주 가족 여행 보고서", "docx")).toBe("제주 가족 여행 보고서.docx");
    expect(fileNameOf("보고서.pdf", "docx")).toBe("보고서.docx");
    expect(fileNameOf("../../etc/passwd", "pdf")).toBe(".. .. etc passwd.pdf");
    expect(fileNameOf("a\u0000b‮.exe", "xlsx")).toBe("ab.exe.xlsx");
    expect(fileNameOf("   ", "pptx")).toBe("document.pptx");
    expect(fileNameOf("가".repeat(500), "pdf")).toBe(`${"가".repeat(DOC_LIMITS.fileName)}.pdf`);
  });
});

describe("the sandboxed worker (#42)", () => {
  it("reads only its folder, the pinned packages and the font; writes nothing; no network; one env flag", () => {
    const o = docRunOptions({ kind: "pdf", doc: DOC_FIXTURE, images: {} }, "/usr/local/bin/node");
    expect(o.read).toEqual([]);
    expect(o.write).toEqual([]);
    expect(o.network).toBe("none");
    expect(o.env).toEqual({ AGENTLEE_DOC_WORKER: "1" });
    expect(o.trusted![0]).toBe(DOC_WORKER_DIR);
    for (const p of o.trusted!.slice(1)) expect(p).toMatch(/node_modules/);
    const job = JSON.parse(o.stdin!) as { modules: Record<string, string>; fonts: Record<string, string> };
    expect(Object.keys(job.modules).sort()).toEqual([
      "docx",
      "exceljs",
      "jszip",
      "pdfkit",
      "pptxgenjs",
      "saxes",
    ]);
    for (const f of Object.values(job.fonts)) expect(o.trusted!.some((t) => f.startsWith(t))).toBe(true);
  });

  it.runIf(process.platform === "darwin")(
    "macOS: the four formats are made in the sandbox and open",
    async () => {
      const runner = sandboxedDocRunner();
      for (const kind of KINDS) {
        const r = await runner({
          kind,
          doc: { ...DOC_FIXTURE, blocks: [...DOC_FIXTURE.blocks, { type: "image", fileId: "p1" }] },
          images: { p1: { kind: "png", data: png(32, 32).toString("base64") } },
        });
        expect(r.ok, JSON.stringify(r.ok ? {} : r)).toBe(true);
        if (r.ok) await expectOpens(kind, r.data, true);
      }
    },
    120_000,
  );
});

// ---- the tool, the store and the reply ----------------------------------------------------------------------

describe("doc_create through the run (#49, FakeRuntime)", () => {
  it("'이 내용을 DOCX 보고서로': a conversation file linked to the reply, a download chip, a document artifact", async () => {
    const { app, f, send, download, api } = await start();
    const c = app.conversations!.create(f.users.owner.id);
    const r = await send(f.cookies.owner, c.id, "/doc docx");
    expect(r.run.status).toBe("done");
    const out = docResult(r);
    expect(out.isError).toBe(false);
    const fileId = out.output.fileId as string;
    expect(out.output).toMatchObject({
      name: "제주 가족 여행 보고서.docx",
      kind: "docx",
      mediaType: FILE_KINDS.docx.mediaType,
      url: `/api/files/${fileId}/content`,
      document: { fileId, name: "제주 가족 여행 보고서.docx", mimeType: FILE_KINDS.docx.mediaType },
    });
    // Stored with the conversation's files, linked to the reply that made it, not an upload.
    const row = app.files!.get(fileId)!;
    expect(row).toMatchObject({
      conversationId: c.id,
      userId: f.users.owner.id,
      messageId: r.run.assistantMessageId,
      uploadId: null,
      kind: "docx",
    });
    const list = await api(f.cookies.owner, "GET", `/api/conversations/${c.id}/files`);
    expect((list.json() as { items: UploadedFile[] }).items.map((x) => x.id)).toContain(fileId);
    // The reply carries the download chip and the artifact card.
    expect(r.parts.filter((p) => p.type === "file_ref")).toEqual([
      { type: "file_ref", fileId, name: "제주 가족 여행 보고서.docx" },
    ]);
    const card = r.parts.find((p) => p.type === "artifact_ref") as { artifactId: string } | undefined;
    expect(card).toBeDefined();
    const v = await api(f.cookies.owner, "GET", `/api/artifacts/${card!.artifactId}/versions/1`);
    expect(JSON.parse((v.json() as { content: string }).content)).toEqual(out.output.document);
    // Downloaded through #22's original-file route: an attachment of the right type, and it opens.
    const res = await download(f.cookies.owner, fileId);
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain(FILE_KINDS.docx.mediaType);
    expect(String(res.headers["content-disposition"])).toMatch(/^attachment;/);
    await expectOpens("docx", res.rawPayload);
    // Owner only, like every file.
    expect((await download(f.cookies.stranger, fileId)).statusCode).toBe(403);
    // Never a composer file: it cannot be removed with ✕ or attached to another message.
    const del = await app.inject({
      method: "DELETE",
      url: `/api/files/${fileId}`,
      headers: { ...WRITE, cookie: f.cookies.owner },
    });
    expect(del.statusCode).toBe(409);
    const again = await api(f.cookies.owner, "POST", `/api/conversations/${c.id}/messages`, {
      text: "x",
      fileIds: [fileId],
    });
    expect(again.statusCode).toBe(400);
  });

  for (const kind of ["xlsx", "pptx", "pdf"] as const)
    it(`${kind}: made through the run, downloaded and opened`, async () => {
      const { app, f, send, download } = await start();
      const c = app.conversations!.create(f.users.owner.id);
      const out = docResult(await send(f.cookies.owner, c.id, `/doc ${kind}`));
      expect(out.isError, JSON.stringify(out.output)).toBe(false);
      expect(out.output.name).toBe(`제주 가족 여행 보고서.${kind}`);
      const res = await download(f.cookies.owner, out.output.fileId as string);
      expect(res.headers["content-type"]).toContain(FILE_KINDS[kind].mediaType);
      await expectOpens(kind, res.rawPayload);
    });

  it("the next fresh session sees the generated file among the conversation's files (#45)", async () => {
    const { app, f, send, rt } = await start();
    const c = app.conversations!.create(f.users.owner.id);
    const out = docResult(await send(f.cookies.owner, c.id, "/doc pdf"));
    for (const id of rt.transcripts.keys()) rt.forget(id);
    await send(f.cookies.owner, c.id, "그 파일 요약해줘");
    // A fresh session (the runtime lost the old one): the run manager hands it the conversation's references.
    expect(rt.contexts.at(-1)!.references?.files).toEqual([
      { id: out.output.fileId as string, name: "제주 가족 여행 보고서.pdf" },
    ]);
  });

  it("HWP: no file, a guidance message (FR-4.4)", async () => {
    const { app, f, send } = await start();
    const c = app.conversations!.create(f.users.owner.id);
    const r = await send(f.cookies.owner, c.id, "/doc hwp");
    expect(docResult(r)).toEqual({
      isError: true,
      output: { error: "doc_hwp_unsupported", hint: DOC_HWP_HINT },
    });
    expect(app.files!.list(c.id)).toEqual([]);
    expect(r.parts.some((p) => p.type === "file_ref")).toBe(false);
  });

  it("logs the format and a fixed code only — never the title, the blocks or the file name", async () => {
    const { app, f, send, log } = await start();
    const c = app.conversations!.create(f.users.owner.id);
    await send(f.cookies.owner, c.id, "/doc xlsx");
    await send(f.cookies.owner, c.id, "/doc hwp");
    const events = log.filter((l) => l.msg === "doc.finished");
    expect(events.map((e) => [e.docKind, e.docCode])).toEqual([
      ["xlsx", "doc_ok"],
      ["hwp", "doc_hwp_unsupported"],
    ]);
    const all = JSON.stringify(log);
    expect(all).not.toContain("제주");
    expect([...DOC_CODE_VALUES].sort()).toEqual(["doc_ok", ...DOC_CODES].sort());
  });
});

describe("guards: limits, pictures, secrets, validation (#49)", () => {
  /** The service called directly with a run's scope (the MCP layer's own checks are tested above). */
  async function direct(o: { runner?: DocRunner } = {}) {
    const t = await start(o);
    const c = t.app.conversations!.create(t.f.users.owner.id);
    // A finished reply to link files to: one run of the fake.
    const r = await t.send(t.f.cookies.owner, c.id, "안녕");
    const scope = { userId: t.f.users.owner.id, conversationId: c.id, runId: r.run.id };
    const svc = new DocGenService({
      db: t.db,
      files: () => t.app.files,
      runner: o.runner ?? inProcessDocRunner(),
    });
    return { ...t, c, scope, svc };
  }
  const create = (svc: DocGenService, scope: object, input: Record<string, unknown>) =>
    svc.create(scope as never, { kind: "docx", title: "보고서", blocks: [], ...input });

  it("input limits: blocks, text, cells, row width, tables, images — refused before anything is made", async () => {
    let made = 0;
    const counting: DocRunner = async (job) => {
      made++;
      return inProcessDocRunner()(job);
    };
    const { app, db, f, send } = await start({ runner: counting });
    const c = app.conversations!.create(f.users.owner.id);
    const tool = async (input: Record<string, unknown>) => {
      // Straight through our MCP tool's schema and the service, as a runtime's call would go.
      const svc = new DocGenService({ db, files: () => app.files, runner: counting });
      const run = (await send(f.cookies.owner, c.id, "x")).run;
      return svc.create(
        { userId: f.users.owner.id, conversationId: c.id, runId: run.id },
        { kind: "docx", title: "t", blocks: [], ...input },
      );
    };
    const para = (n: number) => ({ type: "paragraph", text: "가".repeat(n) });
    const table = (cols: number, rows: number) => ({
      type: "table",
      columns: Array.from({ length: cols }, (_, i) => `c${i}`),
      rows: Array.from({ length: rows }, () => Array.from({ length: cols }, () => 1)),
    });
    expect(await tool({ blocks: Array.from({ length: DOC_LIMITS.blocks + 1 }, () => para(1)) })).toEqual({
      ok: false,
      code: "doc_too_large",
    });
    expect(await tool({ blocks: [para(DOC_LIMITS.textChars + 1)] })).toEqual({
      ok: false,
      code: "doc_too_large",
    });
    expect(await tool({ blocks: Array.from({ length: 31 }, () => para(DOC_LIMITS.textChars)) })).toEqual({
      ok: false,
      code: "doc_too_large",
    });
    expect(await tool({ blocks: [table(DOC_LIMITS.tableColumns + 1, 1)] })).toEqual({
      ok: false,
      code: "doc_too_large",
    });
    expect(await tool({ blocks: [table(20, DOC_LIMITS.tableRows + 1)] })).toEqual({
      ok: false,
      code: "doc_too_large",
    });
    expect(await tool({ blocks: [table(25, 900)] })).toEqual({ ok: false, code: "doc_too_large" }); // 22,525 cells
    expect(await tool({ blocks: Array.from({ length: DOC_LIMITS.tables + 1 }, () => table(1, 1)) })).toEqual({
      ok: false,
      code: "doc_too_large",
    });
    expect(await tool({ blocks: [{ type: "table", columns: ["a", "b"], rows: [["x"]] }] })).toEqual({
      ok: false,
      code: "doc_bad_input",
    });
    expect(
      await tool({
        blocks: Array.from({ length: DOC_LIMITS.images + 1 }, () => ({
          type: "image",
          fileId: crypto.randomUUID(),
        })),
      }),
    ).toEqual({ ok: false, code: "doc_too_large" });
    expect(await tool({ blocks: [{ type: "script", text: "x" }] })).toEqual({
      ok: false,
      code: "doc_bad_input",
    });
    expect(await tool({ blocks: [{ type: "image", fileId: "https://example.com/a.png" }] })).toEqual({
      ok: false,
      code: "doc_bad_input",
    });
    expect(await tool({ unknown: 1 })).toEqual({ ok: false, code: "doc_bad_input" });
    expect(await tool({ kind: "odt" })).toEqual({ ok: false, code: "doc_bad_input" });
    expect(made).toBe(0);
    // Inside every limit: made.
    expect((await tool({ blocks: [table(20, 50), para(DOC_LIMITS.textChars)] })).ok).toBe(true);
    expect(made).toBe(1);
  });

  it("output: a file over the size limit, an empty one or one that is not its format is never stored", async () => {
    let next: Buffer = Buffer.alloc(0);
    const stub: DocRunner = async () => ({ ok: true, data: next, checks: {} });
    const { app, db, scope, c } = await direct({ runner: stub });
    const svc = new DocGenService({ db, files: () => app.files, runner: stub });
    next = Buffer.alloc(DOC_LIMITS.outputBytes + 1, 1);
    expect(await create(svc, scope, {})).toEqual({ ok: false, code: "doc_output_too_large" });
    next = Buffer.alloc(0);
    expect(await create(svc, scope, {})).toEqual({ ok: false, code: "doc_invalid" });
    next = Buffer.from("%PDF-1.7 this is not a word file");
    expect(await create(svc, scope, {})).toEqual({ ok: false, code: "doc_invalid" });
    expect(app.files!.list(c.id)).toEqual([]);
    // Nothing left behind in the temp folder either.
    expect(
      fs.existsSync(app.files!.paths.uploadsTmp) ? fs.readdirSync(app.files!.paths.uploadsTmp) : [],
    ).toEqual([]);
    // A worker failure keeps its code; an unknown code is doc_failed.
    const failing =
      (code: string): DocRunner =>
      async () => ({ ok: false, code });
    for (const [code, want] of [
      ["doc_timeout", "doc_timeout"],
      ["doc_limit", "doc_limit"],
      ["doc_unavailable", "doc_unavailable"],
      ["weird", "doc_failed"],
    ])
      expect(
        await create(new DocGenService({ db, files: () => app.files, runner: failing(code) }), scope, {}),
      ).toEqual({ ok: false, code: want });
  });

  it("counts against the conversation's file limit (20), like an upload", async () => {
    const { app, scope, c, svc, upload, f } = await direct();
    for (let i = 0; i < FILE_LIMITS.perConversation - 1; i++)
      await upload(f.cookies.owner, c.id, `${i}.txt`, Buffer.from("x"));
    expect((await create(svc, scope, {})).ok).toBe(true);
    expect(await create(svc, scope, {})).toEqual({ ok: false, code: "doc_too_many_files" });
    expect(app.files!.count(c.id)).toBe(FILE_LIMITS.perConversation);
  });

  it("pictures: own PNG sent in this conversation only — never another user's, another conversation's, an unsent one or a PDF", async () => {
    const { app, f, scope, c, svc, upload, send, api } = await direct();
    const own = await upload(f.cookies.owner, c.id, "사진.png", png(40, 30));
    await send(f.cookies.owner, c.id, "사진 보냄", { fileIds: [own.id] });
    const unsent = await upload(f.cookies.owner, c.id, "안보냄.png", png(10, 10));
    const pdf = await upload(f.cookies.owner, c.id, "문서.pdf", Buffer.from("%PDF-1.4\n%%EOF\n"));
    await send(f.cookies.owner, c.id, "pdf 보냄", { fileIds: [pdf.id] });
    const other = app.conversations!.create(f.users.owner.id);
    const elsewhere = await upload(f.cookies.owner, other.id, "다른대화.png", png(10, 10));
    await send(f.cookies.owner, other.id, "x", { fileIds: [elsewhere.id] });
    const theirsConv = app.conversations!.create(f.users.stranger.id);
    const theirs = await upload(f.cookies.stranger, theirsConv.id, "남의것.png", png(10, 10));
    await send(f.cookies.stranger, theirsConv.id, "x", { fileIds: [theirs.id] });
    const big = await upload(
      f.cookies.owner,
      c.id,
      "큰.png",
      Buffer.concat([png(2, 2), Buffer.alloc(DOC_LIMITS.imageBytes)]),
    );
    await send(f.cookies.owner, c.id, "큰 사진", { fileIds: [big.id] });
    const img = (fileId: string) => ({ blocks: [{ type: "image", fileId }] });
    for (const id of [unsent.id, elsewhere.id, theirs.id, crypto.randomUUID()])
      expect(await create(svc, scope, img(id)), id).toEqual({ ok: false, code: "doc_image_not_found" });
    expect(await create(svc, scope, img(pdf.id))).toEqual({ ok: false, code: "doc_image_unsupported" });
    expect(await create(svc, scope, img(big.id))).toEqual({ ok: false, code: "doc_image_too_large" });
    // A file whose bytes changed on disk after it was stored (its hash no longer matches): not used.
    const tampered = await upload(f.cookies.owner, c.id, "바뀐.png", png(10, 10));
    await send(f.cookies.owner, c.id, "x", { fileIds: [tampered.id] });
    const p = app.files!.pathOf(app.files!.get(tampered.id)!);
    const bytes = fs.readFileSync(p);
    bytes[bytes.length - 5]! ^= 0xff;
    fs.writeFileSync(p, bytes);
    expect(await create(svc, scope, img(tampered.id))).toEqual({ ok: false, code: "doc_image_not_found" });
    // The own picture, sent in this conversation: embedded.
    const ok = await create(svc, scope, { kind: "docx", ...img(own.id) });
    expect(ok.ok).toBe(true);
    const made = ok.ok ? (ok.output as { fileId: string }) : undefined;
    const doc = await readDocx(fs.readFileSync(app.files!.pathOf(app.files!.get(made!.fileId)!)));
    expect(doc.media).toHaveLength(1);
    // A picture of a message an edit took out of the history (#45): not used any more.
    const first = app.conversations!.messages(c.id, { limit: 100 }).find((m) => m.role === "user")!;
    const edited = await api(
      f.cookies.owner,
      "POST",
      `/api/conversations/${c.id}/messages/${first.id}/edit`,
      {
        text: "처음부터 다시",
      },
    );
    expect(edited.statusCode, edited.body).toBe(200);
    const run = await waitRun(app, (edited.json() as { run: Run }).run.id);
    const now = { ...scope, runId: run.run.id };
    expect(await create(svc, now, img(own.id))).toEqual({ ok: false, code: "doc_image_not_found" });
  });

  it("a known secret never reaches the file or its name (title, paragraph, cell, number, file name)", async () => {
    const { app, scope, svc } = await direct();
    const secret = `sk-ant-DOCSECRET${"q".repeat(24)}`;
    const digits = "8273645519283746";
    knownSecrets.add(secret);
    knownSecrets.add(digits);
    closers.push(() => {
      knownSecrets.remove(secret);
      knownSecrets.remove(digits);
    });
    for (const kind of KINDS) {
      const r = await create(svc, scope, {
        kind,
        title: `보고서 ${secret}`,
        fileName: `키-${secret}`,
        blocks: [
          { type: "paragraph", text: `열쇠는 ${secret} 입니다` },
          { type: "table", columns: ["k", secret], rows: [[secret, Number(digits)]] },
          { type: "list", items: [`a ${secret}`] },
          { type: "references", items: [secret] },
        ],
      });
      expect(r.ok, kind).toBe(true);
      const out = (r as { output: { fileId: string; name: string } }).output;
      expect(out.name).not.toContain(secret);
      const row = app.files!.get(out.fileId)!;
      expect(row.name).not.toContain(secret);
      const buf = fs.readFileSync(app.files!.pathOf(row));
      const text =
        kind === "docx"
          ? (await readDocx(buf)).xml
          : kind === "pptx"
            ? (await readPptx(buf)).text
            : kind === "pdf"
              ? (await readPdf(buf)).text + JSON.stringify((await readPdf(buf)).info)
              : JSON.stringify((await readXlsx(buf)).worksheets.map((w) => w.getSheetValues()));
      expect(text, kind).not.toContain(secret);
      expect(text, kind).not.toContain(digits);
      expect(text.replace(/\s+/g, ""), kind).toContain("[숨김]");
    }
  });

  it("scope: the token's user must own the conversation and the run must be its own", async () => {
    const { app, f, scope, svc, c } = await direct();
    expect(await create(svc, { ...scope, userId: f.users.stranger.id }, {})).toEqual({
      ok: false,
      code: "doc_not_allowed",
    });
    const other = app.conversations!.create(f.users.owner.id);
    expect(await create(svc, { ...scope, conversationId: other.id }, {})).toEqual({
      ok: false,
      code: "doc_not_allowed",
    });
    expect(await create(svc, { ...scope, runId: crypto.randomUUID() }, {})).toEqual({
      ok: false,
      code: "doc_not_allowed",
    });
    expect(app.files!.list(c.id)).toEqual([]);
    expect(app.files!.list(other.id)).toEqual([]);
  });

  it("the tool is offered to every active user and its input is strict", async () => {
    const { app, f } = await start();
    expect(app.mcp!.toolNamesFor(f.users.owner.id)).toContain("doc_create");
    expect(app.mcp!.toolNamesFor(f.users.stranger.id)).toContain("doc_create");
    expect(Object.keys(DOC_CREATE_TOOL.input).sort()).toEqual([
      "author",
      "blocks",
      "fileName",
      "kind",
      "subtitle",
      "title",
    ]);
  });
});

// ---- both runtimes --------------------------------------------------------------------------------------------

/** "이 내용을 DOCX 보고서로" as each runtime's recorded protocol: real calls of our tools, then the answer. */
const claudeTurn = (kind: string): SDKMessage[] => {
  const sc = docScenario(kind);
  return [
    sdk.init({ session: crypto.randomUUID() }),
    ...sc.calls.map((c, i) => liveCall(String(i), c.tool, c.input) as unknown as SDKMessage),
    sdk.delta(sc.answer),
    sdk.result(),
  ];
};
const codexTurn = (kind: string) => {
  const sc = docScenario(kind);
  return {
    threadId: cx.threadId,
    turnId: cx.turnId,
    messages: [
      ...sc.calls.map((c, i) => liveCall(String(i), c.tool, c.input) as unknown as Record<string, unknown>),
      cx.delta(sc.answer),
      cx.usage(cx.tokens(10, 0, 2), cx.tokens(10, 0, 2)),
      cx.completed("completed"),
    ],
  };
};
const PROMPTS = Object.fromEntries(KINDS.map((k) => [`/doc ${k}`, k]));

const unwired = (a: RuntimeAdapter): RuntimeAdapter => ({
  id: a.id,
  capabilities: () => ({ ...a.capabilities(), needsConnection: false }),
  start: (c) => a.start(c),
  resume: (id, c) => a.resume(id, c),
});

function claude(): RuntimeAdapter {
  const root = tmp();
  const log: ReplayLog = { options: [], prompts: [], interrupts: 0, closes: 0 };
  return new ClaudeAdapter({
    connection: () => ({
      id: "c1",
      dir: path.join(root, "conn"),
      auth: { kind: "api_key", apiKey: "sk-ant-api03-TESTKEY-" + "x".repeat(20) },
    }),
    query: replayQuery(
      Object.fromEntries(Object.entries(PROMPTS).map(([p, k]) => [p, claudeTurn(k)])),
      log,
      1,
    ),
    spawn: () => {
      throw new Error("not spawned in replay");
    },
  });
}

function codex(): RuntimeAdapter {
  const root = tmp();
  return new CodexAdapter({
    connection: () => ({
      id: "c1",
      dir: path.join(root, "conn"),
      auth: { kind: "api_key", apiKey: "sk-proj-TESTKEY" + "x".repeat(30) },
    }),
    spawn: replaySpawn(
      Object.fromEntries(Object.entries(PROMPTS).map(([p, k]) => [p, codexTurn(k)])),
      newLog(),
      {
        delayMs: 1,
      },
    ),
    bundledCatalog: async () => ({
      models: CODEX_MODELS.map((m) => ({ slug: m.id, tool_mode: "code_mode_only", base_instructions: "x" })),
    }),
    executable: "/nonexistent/codex",
  });
}

describe("both runtimes: '이 내용을 DOCX 보고서로' → downloadable and opens (#49 completion criterion)", () => {
  it("Claude Code and Codex call doc_create through our MCP server; every format downloads and opens", async () => {
    const runtimes = new RuntimeRegistry();
    runtimes.register(unwired(claude()));
    runtimes.register(unwired(codex()));
    const { app, f, send, download } = await start({ runtimes });
    for (const rt of ["claude-code", "codex"]) {
      const c = app.conversations!.create(f.users.owner.id);
      for (const kind of KINDS) {
        const r = await send(f.cookies.owner, c.id, `/doc ${kind}`, { runtime: rt });
        expect(r.run.runtime).toBe(rt);
        expect(r.run.status, `${rt} ${kind}`).toBe("done");
        const ref = r.parts.find((p) => p.type === "file_ref") as
          { fileId: string; name: string } | undefined;
        expect(ref?.name, `${rt} ${kind}`).toBe(`제주 가족 여행 보고서.${kind}`);
        expect(
          r.parts.some((p) => p.type === "artifact_ref"),
          `${rt} ${kind}`,
        ).toBe(true);
        const res = await download(f.cookies.owner, ref!.fileId);
        expect(res.statusCode).toBe(200);
        await expectOpens(kind, res.rawPayload);
      }
      expect(app.files!.list(c.id).map((x) => x.kind)).toEqual([...KINDS]);
    }
  }, 120_000);
});
