import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CSRF_HEADER,
  CitationNotePart,
  FileLocator,
  FileViewResponse,
  fileViewPath,
  parseLocParam,
  type MessagePart,
  type Run,
  type UploadedFile,
  type ViewSegment,
} from "@agentlee/shared";
import { SELFTEST_SKILL } from "@agentlee/mcp-tools/skills";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { inProcessExtractor, ocrCapability } from "../src/files/extract.js";
import { prefixHash } from "../src/files/text.js";
import { resolveTarget, viewWindow } from "../src/files/viewer.js";
import { RuntimeRegistry } from "../src/runtime/adapter.js";
import { FakeRuntime, defaultScript } from "../src/runtime/fake.js";
import { ASSIGNMENT_TABLE3_ROW2, REPORT_PAGE12, SCANNED_LINE2 } from "../src/runtime/fake-files.js";
import { knownSecrets } from "../src/secrets/known.js";
import { createFamily, shareWithShared } from "./helpers/permission-matrix.js";
import { hwpxDoc, xnote, xp, xt, xtable } from "./helpers/hwp-docs.js";

/**
 * The file viewer (#24, PRD FR-4.5, 수용 기준 2): `GET /api/files/:id/view` serves the scrubbed extracted text with
 * its finer places and resolves a citation's locator — the passage (`exact`) only when a citation the caller may
 * see gave it and the passage is still exactly there; else the unit (`unit`, with reasons); nothing for other
 * bytes or a unit the file does not have. Every read goes through the share projection (#29).
 */

type App = Awaited<ReturnType<typeof buildApp>>;
const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});
const FIX = path.resolve(import.meta.dirname, "../../../fixtures/extract");
const LOCAL = { host: "localhost:3000" };
const WRITE = { ...LOCAL, origin: "http://localhost:3000", [CSRF_HEADER]: "1" };
const OCR = ocrCapability(path.join(os.tmpdir(), "agentlee-test-ocr-lang"));
const IN_PROCESS = inProcessExtractor(() => OCR);

async function start() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "file-viewer-"));
  closers.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  const runtimes = new RuntimeRegistry();
  runtimes.register(new FakeRuntime({ script: defaultScript, runTools: true }));
  const app = await buildApp(loadConfig({ NODE_ENV: "test", DATA_DIR: path.join(dir, "data") }), {
    db: createTestDb(),
    extract: { runner: IN_PROCESS },
    logger: false,
    runtimes,
    runs: { flushMs: 0 },
    mcp: {
      skills: [SELFTEST_SKILL],
      egress: () =>
        ({
          endpoint: async () => ({ port: 9, url: "x", close: async () => {} }),
          close: async () => {},
        }) as never,
    },
  });
  closers.push(() => app.close());
  const f = await createFamily(app);
  const upload = async (conversationId: string, name: string, body?: Buffer) => {
    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/files`,
      headers: {
        ...WRITE,
        cookie: f.cookies.owner,
        "content-type": "application/octet-stream",
        "x-file-name": encodeURIComponent(name),
        "x-upload-id": crypto.randomUUID(),
      },
      payload: body ?? fs.readFileSync(path.join(FIX, name)),
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as UploadedFile;
  };
  const get = (cookie: string | undefined, url: string) =>
    app.inject({ method: "GET", url, headers: { ...LOCAL, ...(cookie ? { cookie } : {}) } });
  const send = async (conversationId: string, text: string, fileIds: string[]) => {
    const res = await app.inject({
      method: "POST",
      url: `/api/conversations/${conversationId}/messages`,
      headers: { ...WRITE, cookie: f.cookies.owner, "content-type": "application/json" },
      payload: { text, fileIds },
    });
    expect(res.statusCode, res.body).toBe(201);
    return waitNote(app, (res.json() as { run: Run }).run.id);
  };
  const view = async (cookie: string, fileId: string, loc?: FileLocator, extra = "") => {
    const r = await get(
      cookie,
      `/api/files/${fileId}/view${loc ? `?loc=${encodeURIComponent(JSON.stringify(loc))}${extra}` : extra ? `?${extra.slice(1)}` : ""}`,
    );
    return {
      status: r.statusCode,
      body: r.statusCode === 200 ? FileViewResponse.parse(r.json()) : undefined,
      raw: r.body,
    };
  };
  return { app, f, upload, get, send, view };
}

async function waitNote(app: App, runId: string) {
  for (let i = 0; i < 3000; i++) {
    const r = app.runs!.get(runId)!;
    if (r.endedAt !== null) {
      const m = app.conversations!.messageById(r.assistantMessageId)!;
      const parts = m.parts as MessagePart[];
      const note = parts.find((p): p is CitationNotePart => p.type === "citation_note");
      return { run: r, note, assistantId: m.id };
    }
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error("run did not end");
}

const seg = (s: ViewSegment[], seq: number) => s.find((x) => x.seq === seq)!;

describe("GET /api/files/:id/view — a citation opens its place (#24)", () => {
  it("보고서.pdf · 12쪽: the cited sentence on page 12 is exact, with its box; the window holds page 12", async () => {
    const { app, f, upload, send, view } = await start();
    const c = app.conversations!.create(f.users.owner.id);
    const file = await upload(c.id, "report.pdf");
    const r = await send(c.id, "/file-page12", [file.id]);
    const loc = r.note!.citations[0]!.locator!;
    expect(loc).toMatchObject({ kind: "page", page: 12 });
    const v = await view(f.cookies.owner, file.id, loc);
    expect(v.status).toBe(200);
    const t = v.body!.target!;
    expect(t.status).toBe("exact");
    expect(t.reasons).toEqual([]);
    const page = seg(v.body!.items, t.seqs[0]!);
    expect(page.locator).toMatchObject({ kind: "page", page: 12 });
    expect(page.text.slice(t.range!.start, t.range!.end)).toBe(REPORT_PAGE12.summary);
    expect(t.bbox).toHaveLength(4);
    // The page's line boxes come with it (the viewer's page map).
    expect(page.marks.length).toBeGreaterThan(1);
    expect(page.marks.every((m) => m.bbox)).toBe(true);
    // A page of the file before and after paging.
    expect(v.body!.items.map((i) => i.locator.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect([v.body!.prev, v.body!.next]).toEqual([null, null]);
    const paged = await view(f.cookies.owner, file.id, undefined, "&from=3&limit=2");
    expect(paged.body!.items.map((i) => i.seq)).toEqual([3, 4]);
    expect([paged.body!.prev, paged.body!.next, paged.body!.target]).toEqual([1, 5, null]);
  });

  it("과제안내.hwp · 3번째 표 · 2행: the row's cell sentence is exact; the address round-trips the locator", async () => {
    const { app, f, upload, send, view } = await start();
    const c = app.conversations!.create(f.users.owner.id);
    const file = await upload(c.id, "assignment.hwp");
    const r = await send(c.id, "/file-table3", [file.id]);
    const cite = r.note!.citations[0]!;
    expect([cite.status, cite.site]).toEqual(["verified", "3번째 표 · 2행 · 2열"]);
    const path = fileViewPath(c.id, file.id, cite.locator!);
    expect(path.startsWith(`/c/${c.id}/files/${file.id}?loc=`)).toBe(true);
    const loc = parseLocParam(new URLSearchParams(path.split("?")[1]).get("loc"))!;
    expect(loc).toEqual(cite.locator);
    const v = await view(f.cookies.owner, file.id, loc);
    const t = v.body!.target!;
    expect(t.status).toBe("exact");
    const row = seg(v.body!.items, t.seqs[0]!);
    expect(row.locator).toMatchObject({ kind: "table", table: 3, row: 2 });
    expect(row.text.slice(t.range!.start, t.range!.end)).toBe(ASSIGNMENT_TABLE3_ROW2);
    expect(row.text.slice(t.focus!.start, t.focus!.end)).toBe(ASSIGNMENT_TABLE3_ROW2);
    expect(row.marks.map((m) => m.col)).toEqual([1, 2]);
    expect(t.bbox).toBeUndefined();
  });

  it.skipIf(!OCR.available)(
    "a scanned PDF: the OCR line is exact and its box is on the page",
    async () => {
      const { app, f, upload, send, view } = await start();
      const c = app.conversations!.create(f.users.owner.id);
      const file = await upload(c.id, "scanned.pdf");
      const r = await send(c.id, "/file-scan", [file.id]);
      const loc = r.note!.citations[0]!.locator!;
      expect(loc).toMatchObject({ kind: "ocr_box", page: 1 });
      const v = (await view(f.cookies.owner, file.id, loc)).body!;
      const t = v.target!;
      const page = seg(v.items, t.seqs[0]!);
      expect(page.text.slice(t.range!.start, t.range!.end)).toBe(SCANNED_LINE2);
      expect(t.status).toBe("exact");
      // The second line of the page, drawn lower than the first.
      expect(t.bbox![1]).toBeGreaterThan(0.1);
      expect(t.bbox![2]).toBeGreaterThan(0);
    },
    120_000,
  );

  it("only what can be stood behind: no range, a range no citation gave, other bytes, another unit, another file", async () => {
    const { app, f, upload, send, view } = await start();
    const c = app.conversations!.create(f.users.owner.id);
    const file = await upload(c.id, "assignment.hwp");
    const other = await upload(c.id, "sample.txt");
    const r = await send(c.id, "/file-table3", [file.id]);
    const loc = r.note!.citations[0]!.locator!;
    const { charRange: _range, ...noRange } = loc;
    void _range;
    const unit = (await view(f.cookies.owner, file.id, noRange)).body!.target!;
    expect([unit.status, unit.reasons]).toEqual(["unit", ["no_range"]]);
    // Still the row, and its cell (column 2).
    expect(unit.seqs).toHaveLength(1);
    expect(unit.focus).toBeDefined();
    // A range of the same row that no citation checked: the row, not the made-up range.
    const made = (await view(f.cookies.owner, file.id, { ...loc, charRange: [0, 5] })).body!.target!;
    expect([made.status, made.reasons, made.range]).toEqual(["unit", ["unverified"], undefined]);
    const outside = (await view(f.cookies.owner, file.id, { ...loc, charRange: [0, 999] })).body!.target!;
    expect([outside.status, outside.reasons]).toEqual(["unit", ["out_of_range"]]);
    const stale = (await view(f.cookies.owner, file.id, { ...loc, fileRevision: "0".repeat(64) })).body!
      .target!;
    expect([stale.status, stale.reasons, stale.seqs]).toEqual(["stale", ["revision_changed"], []]);
    const missing = (await view(f.cookies.owner, file.id, { ...noRange, table: 9 })).body!.target!;
    expect([missing.status, missing.reasons]).toEqual(["not_found", ["unit_missing"]]);
    const elsewhere = (await view(f.cookies.owner, other.id, loc)).body!.target!;
    expect([elsewhere.status, elsewhere.reasons]).toEqual(["not_found", ["other_file"]]);
    // A `loc` that is not a locator is refused.
    expect((await view(f.cookies.owner, file.id, undefined, "&loc=%7B%22x%22%3A1%7D")).status).toBe(400);
  });

  it("[P1] a secret registered after the citation: hidden in what the viewer serves, and the shifted range is not claimed", async () => {
    const { app, f, upload, send, view } = await start();
    const secret = `sk-viewer-${crypto.randomBytes(8).toString("hex")}`;
    const c = app.conversations!.create(f.users.owner.id);
    const passage = "인용할 문장은 바로 여기에 있습니다.";
    const file = await upload(
      c.id,
      "note.txt",
      Buffer.from(`토큰 ${secret} 그리고 ${passage} 그 뒤로도 이 줄은 한참 더 이어지는 꼬리 문장입니다.\n`),
    );
    // `/file-cite <fileId> <snippet>` (FakeRuntime): the passage, verified, line 1 with its range.
    const cited = await send(c.id, `/file-cite ${file.id} ${passage}`, [file.id]);
    const loc = cited.note!.citations[0]!.locator!;
    expect(loc).toMatchObject({ kind: "line", line: 1 });
    expect((await view(f.cookies.owner, file.id, loc)).body!.target!.status).toBe("exact");
    knownSecrets.add(secret);
    closers.push(() => knownSecrets.remove(secret));
    const v = await view(f.cookies.owner, file.id, loc);
    expect(v.raw).not.toContain(secret);
    expect(v.raw).not.toContain(secret.slice(10));
    expect(v.body!.items[0]!.text).toContain("[숨김]");
    const t = v.body!.target!;
    expect([t.status, t.reasons, t.range]).toEqual(["unit", ["unverified"], undefined]);
    // The line itself is still sure.
    expect(t.focus).toBeDefined();
  });
});

describe("the viewer and the share projection (#29)", () => {
  it("a shared viewer opens a file of their projection; a stranger, the admin and an unsent file are refused", async () => {
    const { app, f, upload, send, view, get } = await start();
    const c = app.conversations!.create(f.users.owner.id);
    shareWithShared(f, c.id);
    const file = await upload(c.id, "assignment.hwp");
    const r = await send(c.id, "/file-table3", [file.id]);
    const loc = r.note!.citations[0]!.locator!;
    const shared = await view(f.cookies.shared, file.id, loc);
    expect(shared.status).toBe(200);
    expect(shared.body!.target!.status).toBe("exact");
    expect(shared.body!.file.uploadId).toBeNull();
    for (const who of [f.cookies.stranger, f.cookies.admin])
      expect((await view(who, file.id, loc)).status).toBe(403);
    expect((await get(undefined, `/api/files/${file.id}/view`)).statusCode).toBe(401);
    const unsent = await upload(c.id, "sample.txt");
    expect((await view(f.cookies.owner, unsent.id)).status).toBe(200);
    expect((await view(f.cookies.shared, unsent.id)).status).toBe(403);
  });

  it("a snapshot that ends before the citing answer: the file opens, but no citation outside it makes a range exact", async () => {
    const { app, f, upload, send, view } = await start();
    const c = app.conversations!.create(f.users.owner.id);
    const file = await upload(c.id, "assignment.hwp");
    const r = await send(c.id, "/file-table3", [file.id]);
    const loc = r.note!.citations[0]!.locator!;
    const userMessage = app.runs!.get(r.run.id)!.userMessageId;
    const boundary = app.conversations!.messageById(userMessage)!;
    app.sharing!.store.create({
      ownerId: f.users.owner.id,
      itemKind: "conversation",
      itemId: c.id,
      conversationId: c.id,
      target: { audience: "users", userIds: [f.users.shared.id] },
      mode: "snapshot",
      boundaryMessageId: boundary.id,
      snapshot: app.sharing!.compute(c.id, { live: false, boundarySeq: boundary.seq }),
    });
    const v = await view(f.cookies.shared, file.id, loc);
    expect(v.status).toBe(200);
    expect([v.body!.target!.status, v.body!.target!.reasons]).toEqual(["unit", ["unverified"]]);
    // The owner, whose conversation holds the citation: exact.
    expect((await view(f.cookies.owner, file.id, loc)).body!.target!.status).toBe("exact");
  });
});

describe("review #123", () => {
  it("[P2 1] a secret registered before a repeated sentence: the old range now on the second copy is not claimed", async () => {
    const { app, f, upload, send, view } = await start();
    const c = app.conversations!.create(f.users.owner.id);
    const S = "같은 문장이 이 파일에 두 번 나옵니다.";
    // The secret is S.length + 5 long: hidden as "[숨김]" (4), the text before the first copy shrinks by exactly
    // one copy and its separator — the stored range then lands on the second copy, whose quote is the same.
    const secret = `sk-dup-${crypto.randomBytes(32).toString("hex")}`.slice(0, S.length + 5);
    const file = await upload(c.id, "dup.txt", Buffer.from(`앞 ${secret} 뒤 ${S} ${S}\n`));
    const cited = await send(c.id, `/file-cite ${file.id} ${S}`, [file.id]);
    const loc = cited.note!.citations[0]!.locator!;
    expect((await view(f.cookies.owner, file.id, loc)).body!.target!.status).toBe("exact");
    app.storedRescrub!.close();
    knownSecrets.add(secret);
    closers.push(() => knownSecrets.remove(secret));
    const v = (await view(f.cookies.owner, file.id, loc)).body!;
    // The range really is on the second copy now (what made the old check pass) …
    const text = v.items[0]!.text;
    const [a, b] = loc.charRange!;
    expect(text.slice(a, b)).toBe(S);
    expect(text.indexOf(S)).toBeLessThan(a);
    // … and it is not claimed: only the line.
    expect([v.target!.status, v.target!.reasons, v.target!.range]).toEqual([
      "unit",
      ["unverified"],
      undefined,
    ]);
    expect(JSON.stringify(v)).not.toContain(secret);
  });

  it("[P2 4] a run of lines that lost its places: a line it surely has is the run; a line past what it shows is nothing", async () => {
    const { app, f, upload, view } = await start();
    const c = app.conversations!.create(f.users.owner.id);
    const split = `sk-split-${crypto.randomBytes(6).toString("hex")}`;
    const halves = [split.slice(0, 8), split.slice(8)];
    const file = await upload(c.id, "b.txt", Buffer.from(`첫째 ${halves[0]}\n${halves[1]} 둘째\n셋째 줄\n`));
    await app.fileExtracts!.idle();
    app.storedRescrub!.close();
    knownSecrets.add(`${halves[0]}\n${halves[1]}`);
    closers.push(() => knownSecrets.remove(`${halves[0]}\n${halves[1]}`));
    const rev = (await view(f.cookies.owner, file.id)).body!.extract.fileRevision;
    const at = async (line: number) =>
      (await view(f.cookies.owner, file.id, { fileId: file.id, fileRevision: rev, kind: "line", line })).body!
        .target!;
    const two = await at(2);
    expect([two.status, two.seqs]).toEqual(["unit", [0]]);
    expect(two.reasons).toContain("approximate");
    for (const line of [3, 9999]) {
      const t = await at(line);
      expect([t.status, t.reasons, t.seqs], `line ${line}`).toEqual(["not_found", ["unit_missing"], []]);
    }
  });

  it("[P2 3] an HWPX cell with text after its footnote: two pieces of one column, both served (the screen draws both)", async () => {
    const { app, f, upload, view } = await start();
    const c = app.conversations!.create(f.users.owner.id);
    const doc = await hwpxDoc(xp(xtable(`${xt("각주 앞 글")}${xnote("각주 내용.")}${xt("각주 뒤 글")}`)));
    const file = await upload(c.id, "cell.hwpx", doc);
    await app.fileExtracts!.idle();
    const items = (await view(f.cookies.owner, file.id)).body!.items;
    const row = items.filter((x) => x.locator.kind === "table" && x.locator.footnote === undefined);
    expect(row.map((x) => [x.split, x.marks.map((m) => m.col), x.text])).toEqual([
      [true, [1], "각주 앞 글"],
      [true, [1], "각주 뒤 글"],
    ]);
    expect(items.some((x) => x.locator.footnote === 1 && x.text === "각주 내용.")).toBe(true);
  });

  it("[P3 5] windows before the opening one end where it starts: nothing twice", async () => {
    const { app, f, upload, view } = await start();
    const c = app.conversations!.create(f.users.owner.id);
    const body = Array.from({ length: 200 }, (_, i) => `${i + 1}번째 단락입니다.`).join("\n\n");
    const file = await upload(c.id, "long.md", Buffer.from(body));
    await app.fileExtracts!.idle();
    const all = (await view(f.cookies.owner, file.id, undefined, "&limit=300")).body!.items;
    expect(all.length).toBeGreaterThan(5);
    const rev = (await view(f.cookies.owner, file.id)).body!.extract.fileRevision;
    void rev;
    const first = (await view(f.cookies.owner, file.id, undefined, `&from=${all[3]!.seq}&limit=2`)).body!;
    const before = (
      await view(f.cookies.owner, file.id, undefined, `&from=${first.prev}&to=${first.items[0]!.seq}&limit=2`)
    ).body!;
    expect(before.items.map((x) => x.seq)).toEqual([all[1]!.seq, all[2]!.seq]);
    const edge = (await view(f.cookies.owner, file.id, undefined, `&from=0&to=${all[1]!.seq}&limit=2`)).body!;
    expect(edge.items.map((x) => x.seq)).toEqual([all[0]!.seq]);
  });
});

describe("the viewer and every kind of share (#29, review #123)", () => {
  it("snapshot: a file sent after the boundary is 403; revoked 403; owner deactivated 403", async () => {
    const { app, f, upload, send, view } = await start();
    const c = app.conversations!.create(f.users.owner.id);
    const before = await upload(c.id, "sample.txt");
    const r1 = await send(c.id, "안녕", [before.id]);
    const boundary = app.conversations!.messageById(r1.assistantId)!;
    const after = await upload(c.id, "assignment.hwp");
    await send(c.id, "또", [after.id]);
    const snap = app.sharing!.store.create({
      ownerId: f.users.owner.id,
      itemKind: "conversation",
      itemId: c.id,
      conversationId: c.id,
      target: { audience: "users", userIds: [f.users.shared.id] },
      mode: "snapshot",
      boundaryMessageId: boundary.id,
      snapshot: app.sharing!.compute(c.id, { live: false, boundarySeq: boundary.seq }),
    });
    expect((await view(f.cookies.shared, before.id)).status).toBe(200);
    expect((await view(f.cookies.shared, after.id)).status).toBe(403);
    app.sharing!.store.revoke(snap.id);
    expect((await view(f.cookies.shared, before.id)).status).toBe(403);
    // A live share again, then its owner deactivated: it reaches no one.
    shareWithShared(f, c.id);
    expect((await view(f.cookies.shared, after.id)).status).toBe(200);
    app.users!.deactivate(f.users.owner.id);
    expect((await view(f.cookies.shared, after.id)).status).toBe(403);
    expect((await view(f.cookies.shared, before.id)).status).toBe(403);
  });

  it("an artifact share: only the document's own file opens", async () => {
    const { app, f, upload, send, view } = await start();
    const c = app.conversations!.create(f.users.owner.id);
    const other = await upload(c.id, "sample.txt");
    const r = await send(c.id, "보고서 만들어 줘", [other.id]);
    const doc = await upload(c.id, "report.pdf");
    const { artifact } = app.artifacts!.create(
      { userId: f.users.owner.id, conversationId: c.id, runId: r.run.id },
      {
        kind: "document",
        title: "보고서",
        document: { fileId: doc.id, name: "report.pdf", mimeType: "application/pdf" },
      },
    );
    shareWithShared(f, c.id, { kind: "artifact", id: artifact.id });
    expect((await view(f.cookies.shared, doc.id)).status).toBe(200);
    expect((await view(f.cookies.shared, other.id)).status).toBe(403);
    expect((await view(f.cookies.stranger, doc.id)).status).toBe(403);
  });
});

describe("resolveTarget and viewWindow (pure)", () => {
  const file = { id: "f1", sha256: "a".repeat(64) };
  const base = { fileId: "f1", fileRevision: "a".repeat(64) };
  const s = (
    seq: number,
    locator: Omit<FileLocator, "fileId" | "fileRevision">,
    text: string,
    extra: Partial<ViewSegment> = {},
  ): ViewSegment => ({
    seq,
    locator: { ...base, ...locator },
    text,
    marks: [],
    approximate: false,
    cut: false,
    split: false,
    ...extra,
  });

  it("an approximate unit and a split row: the unit, never a range or a cell", () => {
    const items = [
      s(0, { kind: "page", page: 1 }, "가나다 라마바 사아자", { approximate: true }),
      s(1, { kind: "table", table: 1, row: 2 }, "글꼴 11pt", {
        split: true,
        marks: [{ start: 0, end: 7, col: 2 }],
      }),
      s(2, { kind: "table", table: 1, row: 2, footnote: 2 }, "본문 글꼴 기준."),
      s(3, { kind: "table", table: 1, row: 2 }, "줄 간격 160%", {
        split: true,
        marks: [{ start: 0, end: 9, col: 3 }],
      }),
    ];
    const cited = [
      {
        locator: { ...base, kind: "page" as const, page: 1, charRange: [0, 3] as [number, number] },
        quote: "가나다",
        textHash: prefixHash("가나다 라마바 사아자", 3),
      },
    ];
    const page = resolveTarget(file, { status: "ok" }, items, cited[0]!.locator, cited);
    expect([page.status, page.reasons, page.seqs, page.range]).toEqual([
      "unit",
      ["approximate"],
      [0],
      undefined,
    ]);
    const row = resolveTarget(
      file,
      { status: "ok" },
      items,
      { ...base, kind: "table", table: 1, row: 2, col: 3, charRange: [0, 4] },
      [],
    );
    // Both pieces of the row (not the footnote, a unit of its own), and the named column in the second piece.
    expect([row.status, row.reasons, row.seqs, row.focus]).toEqual([
      "unit",
      ["split"],
      [1, 3],
      { seq: 3, start: 0, end: 9 },
    ]);
    const pending = resolveTarget(file, { status: "pending" }, [], cited[0]!.locator, cited);
    expect([pending.status, pending.reasons]).toEqual(["unreadable", ["pending"]]);
  });

  it("a run of lines: the named line, its range inside it; a run whose marks were lost is the unit", () => {
    const text = "첫 줄\n둘째 줄 인용 구절\n셋째 줄";
    const items = [
      s(0, { kind: "line", line: 1 }, text, {
        marks: [
          { start: 0, end: 3, line: 1 },
          { start: 4, end: 14, line: 2 },
          { start: 15, end: 19, line: 3 },
        ],
      }),
      s(1, { kind: "line", line: 41 }, "x\ny", { approximate: true }),
    ];
    const loc = { ...base, kind: "line" as const, line: 2, charRange: [5, 10] as [number, number] };
    const t = resolveTarget(file, { status: "ok" }, items, loc, [
      { locator: loc, quote: "인용 구절", textHash: prefixHash(text, 14) },
    ]);
    // The same, checked in other text (no hash, or another one): the line, not the range.
    for (const textHash of [undefined, prefixHash("다른 글", 3)])
      expect(
        resolveTarget(file, { status: "ok" }, items, loc, [{ locator: loc, quote: "인용 구절", textHash }])
          .reasons,
      ).toEqual(["unverified"]);
    expect(t.status).toBe("exact");
    expect(text.slice(t.range!.start, t.range!.end)).toBe("인용 구절");
    expect(t.focus).toEqual({ seq: 0, start: 4, end: 14 });
    const lost = resolveTarget(file, { status: "ok" }, items, { ...base, kind: "line", line: 42 }, []);
    expect([lost.status, lost.reasons, lost.seqs]).toEqual(["unit", ["approximate", "no_range"], [1]]);
  });

  it("the window: around the target, from a seq, prev and next", () => {
    const items = Array.from({ length: 50 }, (_, i) =>
      s(i, { kind: "slide", slide: i + 1 }, `slide ${i + 1}`),
    );
    const w = viewWindow(items, { limit: 10, around: 30 });
    expect(w.items.map((x) => x.seq)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect([w.prev, w.next]).toEqual([0, 20]);
    expect(viewWindow(items, { limit: 10, from: 45 })).toMatchObject({ prev: 35, next: null });
  });
});
