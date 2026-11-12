import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CSRF_HEADER,
  FILE_ACCEPT,
  FILE_KINDS,
  FILE_LIMITS,
  fileKindOf,
  type FileKind,
  type UploadedFile,
} from "@agentlee/shared";
import { buildApp, type BuildOptions } from "../src/app.js";
import { initStorage } from "../src/bootstrap.js";
import { loadConfig } from "../src/config.js";
import { createTestDb } from "../src/db/client.js";
import { DB_FILE, MANIFEST_FILE, type Manifest } from "../src/backup/backup.js";
import { contentMatches } from "../src/files/detect.js";
import { FILE_CODES, FILE_CSP, INLINE_KINDS } from "../src/files/routes.js";
import { cleanName } from "../src/files/store.js";
import { FILE_CODES as LOGGABLE_FILE_CODES } from "../src/observability/policy.js";
import { RuntimeRegistry } from "../src/runtime/adapter.js";
import { FakeRuntime } from "../src/runtime/fake.js";
import { TEXT_COLUMNS } from "../src/secrets/columns.js";
import { RESCRUB_TABLES } from "../src/secrets/rescrub.js";
import { knownSecrets } from "../src/secrets/known.js";
import { createFamily } from "./helpers/permission-matrix.js";

type App = Awaited<ReturnType<typeof buildApp>>;
const closers: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
});

const LOCAL = { host: "localhost:3000" };
const WRITE = { ...LOCAL, origin: "http://localhost:3000", [CSRF_HEADER]: "1" };
const MB = 1024 * 1024;

function tmp(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-files-")));
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

/** An app on its own data folder; `file`: a file database there (like the real server), else in memory. */
async function newApp(o: { file?: boolean; dataDir?: string; extra?: Partial<BuildOptions> } = {}) {
  const dataDir = o.dataDir ?? path.join(tmp(), "data");
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    MASTER_KEY_PATH: path.join(path.dirname(dataDir), "keys", "master.key"),
    ...(o.file ? { BACKUP_DIR: path.join(path.dirname(dataDir), "backups") } : {}),
  });
  const storage = o.file ? initStorage(config) : undefined;
  const db = storage?.db ?? createTestDb();
  const runtimes = new RuntimeRegistry();
  runtimes.register(new FakeRuntime());
  const log = logCapture();
  const app = await buildApp(config, {
    db,
    ...(storage ? { masterKey: storage.masterKey } : {}),
    runtimes,
    logStream: log.stream,
    ...o.extra,
  });
  closers.push(async () => {
    await app.close();
    storage?.db.$client.close();
  });
  const f = await createFamily(app);
  return { app, f, dataDir, db, log: log.lines };
}

function upload(
  app: App,
  cookie: string,
  conversationId: string,
  name: string,
  body: Buffer | string,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: `/api/conversations/${conversationId}/files`,
    headers: {
      ...WRITE,
      cookie,
      "content-type": "application/octet-stream",
      "x-file-name": encodeURIComponent(name),
      "x-upload-id": crypto.randomUUID(),
      ...headers,
    },
    payload: body,
  });
}

// ---- Minimal real files of each kind ----

/** A ZIP (stored, no compression) with these entries — enough for the central-directory check. */
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const n = Buffer.from(name, "utf8");
    const data = Buffer.from(text, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(n.length, 26);
    locals.push(local, n, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(n.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const CT = "[Content_Types].xml";
const ooxml = (main: string) => zip({ [CT]: "<Types/>", [main]: "<x/>" });
/** An OLE compound file whose directory has `stream` (HWP: FileHeader; a Word .doc: WordDocument). */
function ole(stream: string): Buffer {
  const b = Buffer.alloc(2048);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(b, 0);
  const at = 512 + 128; // second directory entry of sector 0
  const name = Buffer.from(`${stream}\0`, "utf16le");
  name.copy(b, at);
  b.writeUInt16LE(name.length, at + 64);
  return b;
}
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj <<>> endobj\n%%EOF\n");

const SAMPLES: Record<FileKind, { name: string; body: Buffer }> = {
  pdf: { name: "보고서.pdf", body: PDF },
  hwp: { name: "과제안내.hwp", body: ole("FileHeader") },
  hwpx: {
    name: "과제안내.hwpx",
    body: zip({ mimetype: "application/hwp+zip", "Contents/content.hpf": "<opf/>" }),
  },
  docx: { name: "문서.docx", body: ooxml("word/document.xml") },
  xlsx: { name: "표.xlsx", body: ooxml("xl/workbook.xml") },
  pptx: { name: "발표.pptx", body: ooxml("ppt/presentation.xml") },
  csv: { name: "성적.csv", body: Buffer.from("이름,점수\n철수,90\n") },
  txt: { name: "메모.txt", body: Buffer.from("그냥 메모\n") },
  md: { name: "정리.md", body: Buffer.from("# 제목\n\n본문 <b>굵게</b>\n") },
  png: { name: "사진.png", body: PNG },
  jpg: { name: "사진.JPEG", body: JPG },
};

describe("supported formats (FR-4.2) and type detection — extension and content", () => {
  it("the allowed list is the PRD's formats, nothing active or executable", () => {
    expect(Object.keys(FILE_KINDS).sort()).toEqual(
      ["csv", "docx", "hwp", "hwpx", "jpg", "md", "pdf", "png", "pptx", "txt", "xlsx"].sort(),
    );
    for (const ext of ["svg", "html", "htm", "xml", "xhtml", "js", "exe", "zip", "gif", "doc", "webp", ""])
      expect(fileKindOf(`a.${ext}`), ext).toBeUndefined();
    expect(fileKindOf("사진.JPG")).toBe("jpg");
    expect(fileKindOf("archive.tar.md")).toBe("md");
    expect(fileKindOf(".pdf")).toBeUndefined();
    expect(FILE_ACCEPT.split(",")).toContain(".hwpx");
    expect(FILE_ACCEPT).not.toMatch(/svg|html/);
    // Only raster images may be shown inline.
    expect([...INLINE_KINDS].sort()).toEqual(["jpg", "png"]);
  });

  it("every sample is accepted as its own kind and refused as any other (a disguised extension)", () => {
    const dir = tmp();
    const failures: string[] = [];
    for (const [kind, s] of Object.entries(SAMPLES) as [FileKind, { body: Buffer }][]) {
      const file = path.join(dir, kind);
      fs.writeFileSync(file, s.body);
      for (const claimed of Object.keys(SAMPLES) as FileKind[]) {
        // Plain-text formats are the same thing under three names.
        const text = (k: FileKind) => ["txt", "md", "csv"].includes(k);
        const want = claimed === kind || (text(claimed) && text(kind));
        if (contentMatches(file, claimed) !== want) failures.push(`${kind} as ${claimed}: expected ${want}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("refuses active content and binaries disguised as text, and look-alike containers", () => {
    const dir = tmp();
    const check = (body: Buffer | string, claimed: FileKind) => {
      const file = path.join(dir, crypto.randomUUID());
      fs.writeFileSync(file, body);
      return contentMatches(file, claimed);
    };
    for (const markup of [
      "<!DOCTYPE html><script>alert(1)</script>",
      "<html><body>x</body></html>",
      "\ufeff  \n<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>",
      "<?xml version='1.0'?><x/>",
      "<script>fetch('/api')</script>",
    ])
      for (const k of ["txt", "md", "csv"] as const) expect(check(markup, k), `${k}: ${markup}`).toBe(false);
    expect(check(Buffer.from("MZ\x90\x00\x03"), "txt")).toBe(false); // Windows executable
    expect(check(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]), "txt")).toBe(false); // ELF
    expect(check(Buffer.from("plain\0text"), "txt")).toBe(false); // NUL: binary (or UTF-16)
    expect(check(Buffer.from("%PDF-1.4"), "txt")).toBe(false);
    // A Word .doc (OLE without FileHeader) is not HWP; a plain ZIP is no office file; a docx is no xlsx.
    expect(check(ole("WordDocument"), "hwp")).toBe(false);
    expect(check(zip({ "a.txt": "x" }), "docx")).toBe(false);
    expect(check(ooxml("word/document.xml"), "xlsx")).toBe(false);
    expect(check(Buffer.from("PK\x03\x04garbage"), "docx")).toBe(false);
    // Text in any 8-bit encoding (a CP949 CSV from Excel) passes, a BOM too.
    expect(check(Buffer.from([0xc0, 0xcc, 0xb8, 0xa7, 0x2c, 0x31, 0x0a]), "csv")).toBe(true);
    expect(check("\ufeff# 제목", "md")).toBe(true);
  });

  it("file names: path parts, control and bidi characters dropped, long names cut keeping the extension", () => {
    expect(cleanName("../../etc/passwd")).toBe("passwd");
    expect(cleanName("C:\\Users\\x\\보고서.pdf")).toBe("보고서.pdf");
    expect(cleanName("evil\u202egnp.exe.txt")).toBe("evilgnp.exe.txt");
    expect(cleanName("a\x00b\x1fc.txt")).toBe("abc.txt");
    const long = cleanName(`${"가".repeat(300)}.hwpx`);
    expect(Array.from(long).length).toBe(FILE_LIMITS.nameChars);
    expect(long.endsWith(".hwpx")).toBe(true);
  });
});

describe("upload (FR-4.1·4.6, #22 완료 기준)", () => {
  it("every supported kind uploads; the server decides the media type; stored under generated ids only", async () => {
    const { app, f, dataDir } = await newApp();
    const conv = app.conversations!.create(f.users.owner.id);
    for (const [kind, s] of Object.entries(SAMPLES)) {
      const r = await upload(app, f.cookies.owner, conv.id, s.name, s.body, {
        // What the browser claims does not matter.
        "x-claimed-type": "text/html",
      });
      expect(r.statusCode, `${kind}: ${r.body}`).toBe(201);
      const file = r.json<UploadedFile>();
      expect(file).toMatchObject({
        conversationId: conv.id,
        messageId: null,
        name: s.name,
        kind,
        mediaType: FILE_KINDS[kind as FileKind].mediaType,
        bytes: s.body.length,
      });
      const stored = path.join(dataDir, "files", f.users.owner.id, conv.id, file.id);
      expect(fs.readFileSync(stored).equals(s.body)).toBe(true);
      expect(fs.statSync(stored).mode & 0o777).toBe(0o600);
    }
    // Nothing on disk carries a user's file name.
    const names = fs.readdirSync(path.join(dataDir, "files"), { recursive: true }).map(String);
    for (const s of Object.values(SAMPLES)) expect(names.some((n) => n.includes(s.name))).toBe(false);
    const list = await app.inject({
      url: `/api/conversations/${conv.id}/files`,
      headers: { ...LOCAL, cookie: f.cookies.owner },
    });
    expect(list.json<{ items: UploadedFile[] }>().items).toHaveLength(Object.keys(SAMPLES).length);
  });

  it("51MB is refused (413) by its Content-Length — nothing is stored", async () => {
    const { app, f, dataDir } = await newApp();
    const conv = app.conversations!.create(f.users.owner.id);
    const r = await upload(app, f.cookies.owner, conv.id, "big.txt", Buffer.alloc(51 * MB, 0x61));
    expect(r.statusCode).toBe(413);
    expect(r.json()).toEqual({ error: "file_too_large" });
    expect(app.files!.list(conv.id)).toEqual([]);
    expect(fs.existsSync(path.join(dataDir, "files", f.users.owner.id))).toBe(false);
    // Exactly the limit is fine.
    const ok = await upload(app, f.cookies.owner, conv.id, "max.txt", Buffer.alloc(FILE_LIMITS.bytes, 0x61));
    expect(ok.statusCode, ok.body).toBe(201);
  });

  it("a declared Content-Length over the limit is answered at once, before the body is sent", async () => {
    const { app, f, dataDir } = await newApp();
    const conv = app.conversations!.create(f.users.owner.id);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    const req = http.request({
      host: "127.0.0.1",
      port,
      method: "POST",
      path: `/api/conversations/${conv.id}/files`,
      headers: {
        host: `localhost:${port}`,
        origin: `http://localhost:${port}`,
        [CSRF_HEADER]: "1",
        cookie: f.cookies.owner,
        "content-type": "application/octet-stream",
        "x-file-name": "big.txt",
        "x-upload-id": crypto.randomUUID(),
        "content-length": String(51 * MB),
      },
    });
    req.on("error", () => undefined);
    // Only 1KB of the declared 51MB is ever sent.
    req.write(Buffer.alloc(1024, 0x61));
    const status = await Promise.race([
      new Promise<number>((resolve) => req.on("response", (res) => (res.resume(), resolve(res.statusCode!)))),
      new Promise<string>((resolve) => setTimeout(() => resolve("no answer"), 3000)),
    ]);
    req.destroy();
    expect(status).toBe(413);
    expect(fs.existsSync(path.join(dataDir, "uploads-tmp"))).toBe(false);
  });

  it("51MB without a Content-Length (chunked) is cut off while streaming: never more than the limit on disk", async () => {
    const { app, f, dataDir } = await newApp();
    const conv = app.conversations!.create(f.users.owner.id);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const port = (app.server.address() as AddressInfo).port;
    // The largest the temp file ever got, sampled while the body streams in.
    let largest = 0;
    const tmpDir = path.join(dataDir, "uploads-tmp");
    const sampler = setInterval(() => {
      try {
        for (const n of fs.readdirSync(tmpDir))
          largest = Math.max(largest, fs.statSync(path.join(tmpDir, n)).size);
      } catch {
        // not there yet
      }
    }, 2);
    const result = await new Promise<{ status?: number; body?: string; reset?: boolean; sent: number }>(
      (resolve) => {
        let sent = 0;
        const req = http.request({
          host: "127.0.0.1",
          port,
          method: "POST",
          path: `/api/conversations/${conv.id}/files`,
          headers: {
            host: `localhost:${port}`,
            origin: `http://localhost:${port}`,
            [CSRF_HEADER]: "1",
            cookie: f.cookies.owner,
            "content-type": "application/octet-stream",
            "x-file-name": "big.txt",
            "x-upload-id": crypto.randomUUID(),
            "transfer-encoding": "chunked",
          },
        });
        req.on("response", (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () => resolve({ status: res.statusCode!, body, sent }));
        });
        req.on("error", () => resolve({ reset: true, sent }));
        const chunk = Buffer.alloc(MB, 0x61);
        const pump = () => {
          while (sent < 60 * MB) {
            sent += chunk.length;
            if (!req.write(chunk)) return void req.once("drain", pump);
          }
          req.end();
        };
        pump();
      },
    );
    clearInterval(sampler);
    if (!result.reset) {
      expect(result.status).toBe(413);
      expect(JSON.parse(result.body!)).toEqual({ error: "file_too_large" });
    }
    expect(largest).toBeLessThanOrEqual(FILE_LIMITS.bytes);
    expect(app.files!.list(conv.id)).toEqual([]);
    // The temp file is gone, and so is any trace in the store.
    expect(fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : []).toEqual([]);
    expect(fs.existsSync(path.join(dataDir, "files", f.users.owner.id))).toBe(false);
  });

  it("the 21st file of a conversation is refused (409); a new conversation starts again at 0", async () => {
    const { app, f } = await newApp();
    const conv = app.conversations!.create(f.users.owner.id);
    for (let i = 0; i < FILE_LIMITS.perConversation; i++)
      expect((await upload(app, f.cookies.owner, conv.id, `${i}.txt`, `file ${i}`)).statusCode).toBe(201);
    const r = await upload(app, f.cookies.owner, conv.id, "21.txt", "one too many");
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: "too_many_files" });
    expect(app.files!.count(conv.id)).toBe(FILE_LIMITS.perConversation);
    const other = app.conversations!.create(f.users.owner.id);
    expect((await upload(app, f.cookies.owner, other.id, "a.txt", "a")).statusCode).toBe(201);
  });

  it("21 uploads at once: exactly 20 are stored, one is refused — the count is checked atomically", async () => {
    // Every upload passes the early count check and is held right before its commit until all 21 are there.
    let arrived = 0;
    let release!: () => void;
    const all = new Promise<void>((r) => (release = r));
    const { app, f, dataDir } = await newApp({
      extra: {
        files: {
          beforeCommit: async () => {
            if (++arrived === FILE_LIMITS.perConversation + 1) release();
            await all;
          },
        },
      },
    });
    const conv = app.conversations!.create(f.users.owner.id);
    const results = await Promise.all(
      Array.from({ length: FILE_LIMITS.perConversation + 1 }, (_, i) =>
        upload(app, f.cookies.owner, conv.id, `${i}.txt`, `concurrent ${i}`),
      ),
    );
    expect(arrived).toBe(FILE_LIMITS.perConversation + 1);
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([...Array(FILE_LIMITS.perConversation).fill(201), 409]);
    expect(app.files!.count(conv.id)).toBe(FILE_LIMITS.perConversation);
    // The refused one left no file behind.
    expect(fs.readdirSync(path.join(dataDir, "files", f.users.owner.id, conv.id))).toHaveLength(
      FILE_LIMITS.perConversation,
    );
  });

  it("a disguised extension is refused (415) and nothing is kept", async () => {
    const { app, f, dataDir } = await newApp();
    const conv = app.conversations!.create(f.users.owner.id);
    for (const [name, body] of [
      ["사진.pdf", PNG],
      ["보고서.docx", SAMPLES.xlsx.body],
      ["숙제.hwp", ole("WordDocument")],
      ["readme.txt", Buffer.from("MZ\x90\x00 program")],
      ["page.md", Buffer.from("<!doctype html><script>alert(1)</script>")],
      ["image.png", Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>")],
    ] as const) {
      const r = await upload(app, f.cookies.owner, conv.id, name, body);
      expect(r.statusCode, name).toBe(415);
      expect(r.json()).toEqual({ error: "file_type_mismatch" });
    }
    for (const name of ["x.svg", "x.html", "x.exe", "noext"]) {
      const r = await upload(app, f.cookies.owner, conv.id, name, "x");
      expect(r.statusCode, name).toBe(415);
      expect(r.json()).toEqual({ error: "file_type_unsupported" });
    }
    expect(app.files!.list(conv.id)).toEqual([]);
    expect(fs.existsSync(path.join(dataDir, "files", f.users.owner.id))).toBe(false);
    expect(fs.readdirSync(path.join(dataDir, "uploads-tmp"))).toEqual([]);
  });

  it("refuses a missing name, a JSON body and an empty file; CSRF and login as usual", async () => {
    const { app, f } = await newApp();
    const conv = app.conversations!.create(f.users.owner.id);
    expect((await upload(app, f.cookies.owner, conv.id, "a.txt", "", {})).json()).toEqual({
      error: "file_empty",
    });
    const noName = await upload(app, f.cookies.owner, conv.id, "a.txt", "x", { "x-file-name": "" });
    expect(noName.statusCode).toBe(400);
    const json = await upload(app, f.cookies.owner, conv.id, "a.txt", "{}", {
      "content-type": "application/json",
    });
    expect(json.statusCode).toBe(400);
    const badEncoding = await upload(app, f.cookies.owner, conv.id, "a.txt", "x", {
      "x-file-name": "%E0%A4%A",
    });
    expect(badEncoding.statusCode).toBe(400);
    const noCsrf = await app.inject({
      method: "POST",
      url: `/api/conversations/${conv.id}/files`,
      headers: {
        ...LOCAL,
        cookie: f.cookies.owner,
        "content-type": "application/octet-stream",
        "x-file-name": "a.txt",
        "x-upload-id": crypto.randomUUID(),
      },
      payload: "x",
    });
    expect(noCsrf.statusCode).toBe(403);
    // Someone else's conversation: refused before a byte is read.
    expect((await upload(app, f.cookies.stranger, conv.id, "a.txt", "x")).statusCode).toBe(403);
    expect(app.files!.list(conv.id)).toEqual([]);
  });

  it("logs fixed codes only — never the file name or its content", async () => {
    const { app, f, log } = await newApp();
    const conv = app.conversations!.create(f.users.owner.id);
    await upload(app, f.cookies.owner, conv.id, "비밀계획-NAME-MARK.txt", "CONTENT-MARK");
    await upload(app, f.cookies.owner, conv.id, "위장-NAME-MARK.pdf", "CONTENT-MARK");
    const events = log.filter((l) => l.msg === "file.uploaded");
    expect(events.map((e) => e.fileCode)).toEqual(["file_ok", "file_type_mismatch"]);
    const all = JSON.stringify(log);
    expect(all).not.toContain("NAME-MARK");
    expect(all).not.toContain("CONTENT-MARK");
    expect([...LOGGABLE_FILE_CODES].sort()).toEqual([...FILE_CODES].sort());
  });

  it("a known secret in a file name is scrubbed before it is stored; the column is rescrubbed", async () => {
    const { app, f } = await newApp();
    const conv = app.conversations!.create(f.users.owner.id);
    const secret = `sk-ant-FILENAMESECRET${"z".repeat(24)}`;
    knownSecrets.add(secret);
    closers.push(() => knownSecrets.remove(secret));
    const r = await upload(app, f.cookies.owner, conv.id, `키-${secret}.txt`, "x");
    expect(r.statusCode).toBe(201);
    const row = app.files!.get(r.json<UploadedFile>().id)!;
    expect(row.name).not.toContain(secret);
    expect(r.body).not.toContain(secret);
    expect(TEXT_COLUMNS["files.name"]).toMatchObject({ rescrub: "text" });
    expect(RESCRUB_TABLES.find((t) => t.table === "files")?.columns).toEqual([
      { name: "name", kind: "text" },
    ]);
  });
});

describe("serving the original (#22 범위: 권한, attachment, nosniff, 활성 콘텐츠 금지)", () => {
  async function withFiles() {
    const t = await newApp();
    const conv = t.app.conversations!.create(t.f.users.owner.id);
    const up = async (name: string, body: Buffer | string) =>
      (await upload(t.app, t.f.cookies.owner, conv.id, name, body)).json<UploadedFile>();
    return { ...t, conv, up };
  }
  const get = (app: App, cookie: string | undefined, url: string) =>
    app.inject({ url, headers: { ...LOCAL, ...(cookie ? { cookie } : {}) } });

  it("another user's file URL is 403 — the admin too; before login 401; unknown 404", async () => {
    const { app, f, up } = await withFiles();
    const file = await up("숙제.pdf", PDF);
    for (const url of [`/api/files/${file.id}`, `/api/files/${file.id}/content`]) {
      expect((await get(app, f.cookies.owner, url)).statusCode, url).toBe(200);
      expect((await get(app, f.cookies.stranger, url)).statusCode, url).toBe(403);
      expect((await get(app, f.cookies.admin, url)).statusCode, url).toBe(403);
      expect((await get(app, undefined, url)).statusCode, url).toBe(401);
    }
    expect((await get(app, f.cookies.owner, "/api/files/nope/content")).statusCode).toBe(404);
    const del = await app.inject({
      method: "DELETE",
      url: `/api/files/${file.id}`,
      headers: { ...WRITE, cookie: f.cookies.stranger },
    });
    expect(del.statusCode).toBe(403);
    const list = await get(app, f.cookies.stranger, `/api/conversations/${file.conversationId}/files`);
    expect(list.statusCode).toBe(403);
  });

  it("a download by default: attachment with a safe name, nosniff, a sandboxing CSP, the stored bytes", async () => {
    const { app, f, up } = await withFiles();
    const file = await up('보고서 "최종";\r\n.pdf', PDF);
    const r = await get(app, f.cookies.owner, `/api/files/${file.id}/content`);
    expect(r.statusCode).toBe(200);
    expect(r.rawPayload.equals(PDF)).toBe(true);
    expect(r.headers["content-type"]).toBe("application/pdf");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["content-security-policy"]).toBe(FILE_CSP);
    expect(String(r.headers["content-security-policy"])).toMatch(/^sandbox;/);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.headers["cross-origin-resource-policy"]).toBe("same-origin");
    const cd = String(r.headers["content-disposition"]);
    expect(cd).toMatch(/^attachment; filename="[^"\r\n]*\.pdf"; filename\*=UTF-8''[^\s"]+\.pdf$/);
    expect(decodeURIComponent(cd.split("filename*=UTF-8''")[1]!)).toBe("보고서 _최종_;.pdf");
  });

  it("?inline=1 shows PNG/JPG in the page; anything else stays a download (no active content inline)", async () => {
    const { app, f, up } = await withFiles();
    const png = await up("사진.png", PNG);
    const r = await get(app, f.cookies.owner, `/api/files/${png.id}/content?inline=1`);
    expect(String(r.headers["content-disposition"])).toMatch(/^inline; /);
    expect(r.headers["content-type"]).toBe("image/png");
    for (const [name, body] of [
      ["a.pdf", PDF],
      ["a.md", "# <b>x</b>"],
      ["a.txt", "plain"],
      ["a.hwpx", SAMPLES.hwpx.body],
    ] as const) {
      const file = await up(name, body);
      const res = await get(app, f.cookies.owner, `/api/files/${file.id}/content?inline=1`);
      expect(String(res.headers["content-disposition"]), name).toMatch(/^attachment; /);
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  it("a file replaced by a link (or changed size) behind the store's back is not served", async () => {
    const { app, f, up, dataDir } = await withFiles();
    const file = await up("a.txt", "original");
    const stored = path.join(dataDir, "files", f.users.owner.id, file.conversationId, file.id);
    const elsewhere = path.join(path.dirname(dataDir), "secret.txt");
    fs.writeFileSync(elsewhere, "ELSEWHERE");
    fs.rmSync(stored);
    fs.symlinkSync(elsewhere, stored);
    const r = await get(app, f.cookies.owner, `/api/files/${file.id}/content`);
    expect(r.statusCode).toBe(404);
    expect(r.body).not.toContain("ELSEWHERE");
  });
});

describe("sending, deleting and the conversation's lifetime", () => {
  it("files sent with a message become its file_ref parts; another conversation's or an already sent file is 400", async () => {
    const { app, f } = await newApp();
    const conv = app.conversations!.create(f.users.owner.id);
    const a = (await upload(app, f.cookies.owner, conv.id, "a.pdf", PDF)).json<UploadedFile>();
    const b = (await upload(app, f.cookies.owner, conv.id, "b.png", PNG)).json<UploadedFile>();
    const send = (convId: string, fileIds: string[], key = crypto.randomUUID()) =>
      app.inject({
        method: "POST",
        url: `/api/conversations/${convId}/messages`,
        headers: { ...WRITE, cookie: f.cookies.owner, "idempotency-key": key },
        payload: { text: "이 파일 봐 줘", fileIds },
      });
    const r = await send(conv.id, [a.id, b.id]);
    expect(r.statusCode, r.body).toBe(201);
    const msg = r.json<{ message: { id: string; parts: unknown[] } }>().message;
    expect(msg.parts).toEqual([
      { type: "text", text: "이 파일 봐 줘" },
      { type: "file_ref", fileId: a.id, name: "a.pdf" },
      { type: "file_ref", fileId: b.id, name: "b.png" },
    ]);
    expect(app.files!.get(a.id)!.messageId).toBe(msg.id);
    // Wait for the run to end before the next send (one run per conversation).
    for (let i = 0; i < 200 && app.runs!.active(conv.id); i++) await new Promise((x) => setTimeout(x, 10));
    const again = await send(conv.id, [a.id]);
    expect(again.statusCode).toBe(400);
    expect(again.json()).toEqual({ error: "invalid_attachment" });
    const other = app.conversations!.create(f.users.owner.id);
    const foreign = await send(other.id, [b.id]);
    expect(foreign.statusCode).toBe(400);
    // Nothing was created by the refused sends.
    expect(app.conversations!.messagePage(other.id, { limit: 10 }).items).toEqual([]);
    // A sent file stays (409 on delete); an unsent one can be removed.
    const delSent = await app.inject({
      method: "DELETE",
      url: `/api/files/${a.id}`,
      headers: { ...WRITE, cookie: f.cookies.owner },
    });
    expect(delSent.statusCode).toBe(409);
    expect(delSent.json()).toEqual({ error: "file_attached" });
  });

  it("removing an unsent file removes its row and its bytes", async () => {
    const { app, f, dataDir } = await newApp();
    const conv = app.conversations!.create(f.users.owner.id);
    const a = (await upload(app, f.cookies.owner, conv.id, "a.txt", "a")).json<UploadedFile>();
    const r = await app.inject({
      method: "DELETE",
      url: `/api/files/${a.id}`,
      headers: { ...WRITE, cookie: f.cookies.owner },
    });
    expect(r.statusCode).toBe(200);
    expect(app.files!.get(a.id)).toBeUndefined();
    expect(fs.existsSync(path.join(dataDir, "files", f.users.owner.id))).toBe(false);
  });

  it("deleting a conversation deletes its files and rows; other conversations keep theirs", async () => {
    const { app, f, dataDir } = await newApp();
    const conv = app.conversations!.create(f.users.owner.id);
    const keep = app.conversations!.create(f.users.owner.id);
    await upload(app, f.cookies.owner, conv.id, "a.txt", "a");
    await upload(app, f.cookies.owner, conv.id, "b.pdf", PDF);
    const kept = (await upload(app, f.cookies.owner, keep.id, "c.txt", "c")).json<UploadedFile>();
    const r = await app.inject({
      method: "DELETE",
      url: `/api/conversations/${conv.id}`,
      headers: { ...WRITE, cookie: f.cookies.owner },
    });
    expect(r.statusCode).toBe(200);
    expect(app.files!.list(conv.id)).toEqual([]);
    expect(fs.existsSync(path.join(dataDir, "files", f.users.owner.id, conv.id))).toBe(false);
    expect(app.files!.get(kept.id)).toBeDefined();
    expect(fs.existsSync(path.join(dataDir, "files", f.users.owner.id, keep.id, kept.id))).toBe(true);
  });

  it("start-up sweep: cut-off uploads and files without a row (a deleted user) go; anything else stays", async () => {
    const root = tmp();
    const dataDir = path.join(root, "data");
    const one = await newApp({ file: true, dataDir });
    const conv = one.app.conversations!.create(one.f.users.owner.id);
    const kept = (await upload(one.app, one.f.cookies.owner, conv.id, "a.txt", "a")).json<UploadedFile>();
    const strangerConv = one.app.conversations!.create(one.f.users.stranger.id);
    const gone = (
      await upload(one.app, one.f.cookies.stranger, strangerConv.id, "s.txt", "s")
    ).json<UploadedFile>();
    // A user removed from the database: rows go by cascade, the folder is left for the sweep.
    one.app.users!.deactivate(one.f.users.stranger.id);
    one.db.$client.prepare("DELETE FROM users WHERE id = ?").run(one.f.users.stranger.id);
    expect(one.app.files!.get(gone.id)).toBeUndefined();
    await closers.pop()!();
    const orphan = path.join(dataDir, "files", one.f.users.owner.id, conv.id, crypto.randomUUID());
    fs.writeFileSync(orphan, "crash between rename and insert");
    const foreign = path.join(dataDir, "files", one.f.users.owner.id, conv.id, "not-ours.txt");
    fs.writeFileSync(foreign, "left alone");
    fs.mkdirSync(path.join(dataDir, "uploads-tmp"), { recursive: true });
    fs.writeFileSync(path.join(dataDir, "uploads-tmp", "x.part"), "cut off");

    const two = await newAppOn(dataDir);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(foreign)).toBe(true);
    expect(fs.existsSync(path.join(dataDir, "uploads-tmp"))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, "files", one.f.users.stranger.id))).toBe(false);
    expect(fs.readFileSync(path.join(dataDir, "files", one.f.users.owner.id, conv.id, kept.id), "utf8")).toBe(
      "a",
    );
    expect(two.log.some((l) => l.msg === "file.swept" && l.count === 2)).toBe(true);
  });
});

/** A second server on an existing data folder (file database), like a restart. */
async function newAppOn(dataDir: string) {
  const config = loadConfig({
    NODE_ENV: "test",
    DATA_DIR: dataDir,
    MASTER_KEY_PATH: path.join(path.dirname(dataDir), "keys", "master.key"),
  });
  const storage = initStorage(config);
  const log = logCapture();
  const app = await buildApp(config, { db: storage.db, masterKey: storage.masterKey, logStream: log.stream });
  closers.push(async () => {
    await app.close();
    storage.db.$client.close();
  });
  await app.ready();
  return { app, log: log.lines };
}

describe("backups and the file-write lock (#37 integration)", () => {
  it("a backup holds the uploaded files and refuses to finish when a referenced one is missing", async () => {
    const { app, f, dataDir } = await newApp({ file: true });
    const conv = app.conversations!.create(f.users.owner.id);
    const a = (await upload(app, f.cookies.owner, conv.id, "a.pdf", PDF)).json<UploadedFile>();
    const backup = () =>
      app.inject({
        method: "POST",
        url: "/api/admin/backups",
        headers: { ...WRITE, cookie: f.cookies.admin },
      });
    const r = await backup();
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json<{ item: { id: string } }>().item.id;
    const dir = path.join(path.dirname(dataDir), "backups", id);
    const rel = `files/${f.users.owner.id}/${conv.id}/${a.id}`;
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_FILE), "utf8")) as Manifest;
    expect(manifest.files.map((x) => x.path)).toEqual([rel]);
    expect(manifest.files[0]!.sha256).toBe(crypto.createHash("sha256").update(PDF).digest("hex"));
    expect(fs.readFileSync(path.join(dir, rel)).equals(PDF)).toBe(true);
    expect(fs.existsSync(path.join(dir, DB_FILE))).toBe(true);
    // The row is there, the file is not: the backup fails instead of saving a broken copy.
    fs.rmSync(path.join(dataDir, rel));
    const broken = await backup();
    expect(broken.statusCode).toBe(500);
    expect(broken.json()).toEqual({ error: "backup_failed" });
  });

  it("an upload and a conversation delete wait while a backup holds the lock", async () => {
    const { app, f, dataDir } = await newApp();
    const conv = app.conversations!.create(f.users.owner.id);
    const first = (await upload(app, f.cookies.owner, conv.id, "a.txt", "a")).json<UploadedFile>();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    const backup = app.fileWrites.exclusive(async () => {
      entered();
      await held;
    });
    await inside;
    let uploaded = false;
    const pending = upload(app, f.cookies.owner, conv.id, "b.txt", "b").then((r) => ((uploaded = true), r));
    await new Promise((r) => setTimeout(r, 100));
    // Received and checked, but neither the row nor the file is in the store while the backup copies.
    expect(uploaded).toBe(false);
    expect(app.files!.count(conv.id)).toBe(1);
    expect(fs.readdirSync(path.join(dataDir, "files", f.users.owner.id, conv.id))).toEqual([first.id]);
    let deleted = false;
    const del = app
      .inject({
        method: "DELETE",
        url: `/api/conversations/${conv.id}`,
        headers: { ...WRITE, cookie: f.cookies.owner },
      })
      .then(() => (deleted = true));
    await new Promise((r) => setTimeout(r, 50));
    expect(deleted).toBe(false);
    expect(app.conversations!.get(conv.id)).toBeDefined();
    release();
    await backup;
    expect((await pending).statusCode).toBe(201);
    await del;
    expect(app.conversations!.get(conv.id)).toBeUndefined();
  });
});

describe("review #102: links, the database check, a failing fsync, detection gaps", () => {
  for (const linked of ["user", "conversation"] as const)
    it(`a ${linked} folder replaced by a link: nothing outside is read, written or deleted`, async () => {
      const { app, f, dataDir } = await newApp();
      const conv = app.conversations!.create(f.users.owner.id);
      const a = (await upload(app, f.cookies.owner, conv.id, "a.txt", "INSIDE!")).json<UploadedFile>();
      const userDir = path.join(dataDir, "files", f.users.owner.id);
      const convDir = path.join(userDir, conv.id);
      // Outside the store: a folder laid out like the store's, holding a file of the same id and size.
      const outside = path.join(path.dirname(dataDir), "outside");
      const outsideConv = linked === "user" ? path.join(outside, conv.id) : outside;
      fs.mkdirSync(outsideConv, { recursive: true });
      const victim = path.join(outsideConv, a.id);
      fs.writeFileSync(victim, "OUTSIDE");
      fs.rmSync(linked === "user" ? userDir : convDir, { recursive: true });
      fs.symlinkSync(outside, linked === "user" ? userDir : convDir);

      const read = await app.inject({
        url: `/api/files/${a.id}/content`,
        headers: { ...LOCAL, cookie: f.cookies.owner },
      });
      expect(read.statusCode).toBe(404);
      expect(read.body).not.toContain("OUTSIDE");
      // Nothing is written through the link either.
      const up = await upload(app, f.cookies.owner, conv.id, "b.txt", "NEW-BYTES");
      expect(up.statusCode).toBe(500);
      expect(fs.readdirSync(outsideConv)).toEqual([a.id]);
      // Neither the file's delete nor the conversation's touches the outside file.
      const delFile = await app.inject({
        method: "DELETE",
        url: `/api/files/${a.id}`,
        headers: { ...WRITE, cookie: f.cookies.owner },
      });
      expect(delFile.statusCode).toBe(200);
      const delConv = await app.inject({
        method: "DELETE",
        url: `/api/conversations/${conv.id}`,
        headers: { ...WRITE, cookie: f.cookies.owner },
      });
      expect(delConv.statusCode).toBe(200);
      expect(fs.readFileSync(victim, "utf8")).toBe("OUTSIDE");
      // The start-up sweep does not walk into it.
      expect(app.files!.sweep()).toBe(0);
      expect(fs.readFileSync(victim, "utf8")).toBe("OUTSIDE");
    });

  it("an agentlee.db that links to another database: the start-up clean-up does not run", async () => {
    const root = tmp();
    // The other installation's database and key.
    await newApp({ file: true, dataDir: path.join(root, "other", "data") });
    await closers.pop()!();
    const dataDir = path.join(root, "main", "data");
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(root, "main", "keys"), { mode: 0o700 });
    fs.copyFileSync(
      path.join(root, "other", "keys", "master.key"),
      path.join(root, "main", "keys", "master.key"),
    );
    fs.symlinkSync(path.join(root, "other", "data", DB_FILE), path.join(dataDir, DB_FILE));
    const orphan = path.join(dataDir, "files", crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID());
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, "this folder's file");
    const two = await newAppOn(dataDir);
    expect(fs.existsSync(orphan)).toBe(true);
    expect(two.log.some((l) => l.msg === "file.sweep_skipped")).toBe(true);
    expect(two.log.some((l) => l.msg === "file.swept")).toBe(false);
  });

  it("fsync fails (ENOSPC): the upload fails, no descriptor stays open, no temp file is left", async () => {
    const { app, f, dataDir } = await newApp();
    const conv = app.conversations!.create(f.users.owner.id);
    const openFds = () => fs.readdirSync("/dev/fd").length;
    // Warm up (first upload opens what stays open anyway: folders, lazy modules).
    await upload(app, f.cookies.owner, conv.id, "warm.txt", "warm");
    const before = openFds();
    const spy = vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("no space"), { code: "ENOSPC" });
    });
    closers.push(() => spy.mockRestore());
    const r = await upload(app, f.cookies.owner, conv.id, "a.txt", "will not fit");
    expect(spy).toHaveBeenCalled();
    expect(r.statusCode).toBeGreaterThanOrEqual(500);
    expect(app.files!.count(conv.id)).toBe(1);
    expect(fs.readdirSync(path.join(dataDir, "uploads-tmp"))).toEqual([]);
    expect(openFds()).toBe(before);
  });

  it("detection: long blanks or a leading comment do not hide markup; %PDF- must be at the start", () => {
    const dir = tmp();
    const check = (body: string, claimed: FileKind) => {
      const file = path.join(dir, crypto.randomUUID());
      fs.writeFileSync(file, body);
      return contentMatches(file, claimed);
    };
    expect(check(`${" ".repeat(9000)}<script>alert(1)</script>`, "txt")).toBe(false);
    expect(check(`${"\n".repeat(2 * 1024 * 1024)}<html>`, "md")).toBe(false);
    expect(check("<!-- hi --><!---->\n  <svg onload='x'/>", "md")).toBe(false);
    expect(check("<html><!-- %PDF- --></html>", "pdf")).toBe(false);
    expect(check(" %PDF-1.7", "pdf")).toBe(false);
    // Markdown that opens with a comment and then is markdown still passes; so does HTML later in a document.
    expect(check("<!-- toc -->\n# 제목\n<b>굵게</b>", "md")).toBe(true);
    expect(check("# 제목\n\n<html> 태그 설명", "md")).toBe(true);
  });
});

describe("review #102 round 2: editing keeps the attachments", () => {
  it("an edited message keeps its file_ref parts and its files point to the new version", async () => {
    const { app, f } = await newApp();
    const conv = app.conversations!.create(f.users.owner.id);
    const a = (await upload(app, f.cookies.owner, conv.id, "a.pdf", PDF)).json<UploadedFile>();
    const b = (await upload(app, f.cookies.owner, conv.id, "b.png", PNG)).json<UploadedFile>();
    const post = (url: string, payload: object) =>
      app.inject({
        method: "POST",
        url,
        headers: { ...WRITE, cookie: f.cookies.owner, "idempotency-key": crypto.randomUUID() },
        payload,
      });
    const idle = async () => {
      for (let i = 0; i < 200 && app.runs!.active(conv.id); i++) await new Promise((x) => setTimeout(x, 10));
    };
    const sent = await post(`/api/conversations/${conv.id}/messages`, {
      text: "처음",
      fileIds: [a.id, b.id],
    });
    expect(sent.statusCode, sent.body).toBe(201);
    const first = sent.json<{ message: { id: string } }>().message.id;
    await idle();
    const edited = await post(`/api/conversations/${conv.id}/messages/${first}/edit`, { text: "고친 질문" });
    expect(edited.statusCode, edited.body).toBe(200);
    const msg = edited.json<{ message: { id: string; parts: unknown[] } }>().message;
    expect(msg.id).not.toBe(first);
    expect(msg.parts).toEqual([
      { type: "text", text: "고친 질문" },
      { type: "file_ref", fileId: a.id, name: "a.pdf" },
      { type: "file_ref", fileId: b.id, name: "b.png" },
    ]);
    expect(app.files!.get(a.id)!.messageId).toBe(msg.id);
    expect(app.files!.get(b.id)!.messageId).toBe(msg.id);
    // Edited again: still there.
    await idle();
    const again = await post(`/api/conversations/${conv.id}/messages/${msg.id}/edit`, { text: "또 고침" });
    const third = again.json<{ message: { id: string; parts: { type: string }[] } }>().message;
    expect(third.parts.filter((p) => p.type === "file_ref")).toHaveLength(2);
    expect(app.files!.get(a.id)!.messageId).toBe(third.id);
    // A message without files edits to one without files.
    await idle();
    const plain = await post(`/api/conversations/${conv.id}/messages`, { text: "파일 없음" });
    await idle();
    const plainEdit = await post(
      `/api/conversations/${conv.id}/messages/${plain.json<{ message: { id: string } }>().message.id}/edit`,
      { text: "여전히 없음" },
    );
    expect(plainEdit.json<{ message: { parts: unknown[] } }>().message.parts).toEqual([
      { type: "text", text: "여전히 없음" },
    ]);
  });
});

describe("review #102 round 6: cancel by upload id on the server", () => {
  const cancel = (app: App, cookie: string, uploadId: string) =>
    app.inject({ method: "DELETE", url: `/api/uploads/${uploadId}`, headers: { ...WRITE, cookie } });

  it("cancelled before, during or after the upload: nothing is kept; an attached one is 409", async () => {
    let hold: (() => Promise<void>) | undefined;
    const { app, f, dataDir } = await newApp({ extra: { files: { beforeCommit: async () => hold?.() } } });
    const conv = app.conversations!.create(f.users.owner.id);
    const up = (uploadId: string, name = "a.txt") =>
      upload(app, f.cookies.owner, conv.id, name, "bytes", { "x-upload-id": uploadId });
    // Before: refused without reading the body.
    const early = crypto.randomUUID();
    expect((await cancel(app, f.cookies.owner, early)).statusCode).toBe(200);
    const r1 = await up(early);
    expect(r1.statusCode).toBe(409);
    expect(r1.json()).toEqual({ error: "upload_cancelled" });
    // During: received and checked, cancelled right before it would be stored.
    const during = crypto.randomUUID();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let arrived!: () => void;
    const there = new Promise<void>((r) => (arrived = r));
    hold = async () => {
      arrived();
      await held;
    };
    const pending = up(during);
    await there;
    hold = undefined;
    expect((await cancel(app, f.cookies.owner, during)).statusCode).toBe(200);
    release();
    const r2 = await pending;
    expect(r2.statusCode).toBe(409);
    expect(r2.json()).toEqual({ error: "upload_cancelled" });
    // After: stored, then cancelled — the row and the bytes go.
    const after = crypto.randomUUID();
    const r3 = await up(after);
    expect(r3.statusCode).toBe(201);
    const stored = r3.json<UploadedFile>();
    expect(stored.uploadId).toBe(after);
    expect((await cancel(app, f.cookies.owner, after)).statusCode).toBe(200);
    expect(app.files!.get(stored.id)).toBeUndefined();
    expect(app.files!.list(conv.id)).toEqual([]);
    expect(fs.existsSync(path.join(dataDir, "files", f.users.owner.id))).toBe(false);
    // Attached: stays, 409.
    const sentId = crypto.randomUUID();
    const r4 = (await up(sentId)).json<UploadedFile>();
    const send = await app.inject({
      method: "POST",
      url: `/api/conversations/${conv.id}/messages`,
      headers: { ...WRITE, cookie: f.cookies.owner, "idempotency-key": crypto.randomUUID() },
      payload: { text: "보냄", fileIds: [r4.id] },
    });
    expect(send.statusCode).toBe(201);
    const late = await cancel(app, f.cookies.owner, sentId);
    expect(late.statusCode).toBe(409);
    expect(late.json()).toEqual({ error: "file_attached" });
    expect(app.files!.get(r4.id)).toBeDefined();
    // Another user cannot cancel the owner's upload (the id is looked up among the caller's own files).
    const other = crypto.randomUUID();
    const r5 = (await up(other)).json<UploadedFile>();
    expect((await cancel(app, f.cookies.stranger, other)).statusCode).toBe(200);
    expect(app.files!.get(r5.id)).toBeDefined();
    // The id must be a UUID; the same id twice is refused.
    expect((await cancel(app, f.cookies.owner, "not-an-id")).statusCode).toBe(400);
    expect((await up("not-an-id")).statusCode).toBe(400);
    expect((await up(other, "again.txt")).statusCode).toBe(400);
  });

  it("a send naming a cancelled upload's file is refused, even if its row were still there", async () => {
    const { app, f } = await newApp();
    const conv = app.conversations!.create(f.users.owner.id);
    const uploadId = crypto.randomUUID();
    const a = (
      await upload(app, f.cookies.owner, conv.id, "a.txt", "a", { "x-upload-id": uploadId })
    ).json<UploadedFile>();
    // The guard on its own: the upload marked cancelled while its row is (still) there.
    (app.files as unknown as { cancelled: Map<string, number> }).cancelled.set(
      `${f.users.owner.id}/${uploadId}`,
      Date.now(),
    );
    const send = await app.inject({
      method: "POST",
      url: `/api/conversations/${conv.id}/messages`,
      headers: { ...WRITE, cookie: f.cookies.owner, "idempotency-key": crypto.randomUUID() },
      payload: { text: "보냄", fileIds: [a.id] },
    });
    expect(send.statusCode).toBe(400);
    expect(send.json()).toEqual({ error: "invalid_attachment" });
    expect(app.files!.get(a.id)!.messageId).toBeNull();
  });
});
