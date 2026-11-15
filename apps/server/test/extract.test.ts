import crypto from "node:crypto";
import fs from "node:fs";
import zlib from "node:zlib";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { FileLocator, locatorLabel, fileCitationLabel } from "@agentlee/shared";
import { run } from "../extract/worker.mjs";
import { openZip, resolvePart, safeEntryName } from "../extract/zip.mjs";
import { parseXml } from "../extract/xml.mjs";
import { Segments } from "../extract/segments.mjs";
import { extractRunOptions, ocrCapability, packageFolders, workerResult } from "../src/files/extract.js";
import { runIsolated } from "../src/isolation/sandbox.js";

/**
 * The extractor (#48): each format's fixture with the locators it must produce, the hostile fixtures (zip bomb
 * with honest and with lying sizes, XXE, billion laughs, zip slip, a part reference out of the package) refused
 * with their codes, the limits, and the sandboxed run itself (macOS). Fixtures: fixtures/extract (made by
 * make-fixtures.py).
 */

const FIX = path.resolve(import.meta.dirname, "../../../fixtures/extract");
const fixture = (name: string) => path.join(FIX, name);
const require = createRequire(import.meta.url);
const pdfjsDir = path.dirname(fs.realpathSync(require.resolve("pdfjs-dist/package.json")));
const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-extract-")));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

/** OCR here: tesseract.js and the pinned language data (no download). Its tests say why they skip without it. */
const ocr = ocrCapability(path.join(tmpRoot, "ocr-lang"));
const OCR_SKIP = ocr.available ? "" : `OCR unavailable on this machine: ${ocr.reason} (docs/ops.md §26)`;
if (OCR_SKIP) console.warn(`[extract.test] skipping OCR fixtures — ${OCR_SKIP}`);

const KIND: Record<string, string> = { jpeg: "jpg" };
type Job = { limits?: unknown; ocr?: boolean };
function job(name: string, o: Job = {}) {
  const ext = name.split(".").pop()!;
  return {
    path: fixture(name),
    kind: KIND[ext] ?? ext,
    modules: {
      pdfjs: pathToFileURL(path.join(pdfjsDir, "legacy/build/pdf.mjs")).href,
      tesseract: pathToFileURL(fs.realpathSync(require.resolve("tesseract.js"))).href,
    },
    assets: {
      cmaps: path.join(pdfjsDir, "cmaps") + "/",
      standardFonts: path.join(pdfjsDir, "standard_fonts") + "/",
    },
    ocr: o.ocr !== false && ocr.available ? { langDir: ocr.langDir } : null,
    ...(o.limits ? { limits: o.limits } : {}),
  };
}
type Seg = {
  unit: number;
  loc: Record<string, unknown>;
  text: string;
  marks?: [number, number, Record<string, unknown>][];
};
type Out = { ok: true; sha256: string; units: number; truncated: boolean; ocr: string; segments: Seg[] };
const extract = async (name: string, o: Job = {}) => (await run(job(name, o))) as Out;
const refused = async (name: string, o: Job = {}) => {
  try {
    await run(job(name, o));
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return "accepted";
};
const sha = (name: string) =>
  crypto
    .createHash("sha256")
    .update(fs.readFileSync(fixture(name)))
    .digest("hex");
/** The text of a mark (a line, a cell, a word). */
const markText = (s: Seg, i: number) => s.text.slice(s.marks![i]![0], s.marks![i]![1]);
const near = (a: number[], b: number[], tol = 0.02) => a.every((x, i) => Math.abs(x - b[i]!) <= tol);

describe("extractor fixtures: text with locators per format (#48)", () => {
  it("PDF text: a segment per page, a mark (and box) per line; page 12 of 12", async () => {
    const r = await extract("report.pdf");
    expect(r.ok).toBe(true);
    expect(r.sha256).toBe(sha("report.pdf"));
    expect(r.units).toBe(12);
    expect(r.truncated).toBe(false);
    expect(r.ocr).toBe("none");
    expect(r.segments.map((s) => s.loc)).toEqual(
      Array.from({ length: 12 }, (_, i) => ({ kind: "page", page: i + 1 })),
    );
    const p12 = r.segments[11]!;
    expect(p12.unit).toBe(12);
    expect(p12.text).toBe(
      "Report page 12\nSummary: the river clean-up removed 340 kg of waste.\nVolunteers from 12 schools joined in March 2026.",
    );
    expect(p12.marks!.map((_, i) => markText(p12, i))).toEqual(p12.text.split("\n"));
    // Helvetica 12 pt from (72, 720) with 20 pt leading on a 612 × 792 page: x = 72/612, the second line's top
    // at 792 − (700 + 12) = 80 → 80/792.
    const box = p12.marks![1]![2].bbox as number[];
    expect(near(box.slice(0, 2), [72 / 612, 80 / 792], 0.01)).toBe(true);
    expect(box[2]).toBeGreaterThan(0.4);
    expect(box[2]).toBeLessThan(0.6);
  });

  it("PDF with an embedded Korean font", async () => {
    const r = await extract("korean.pdf");
    expect(r.segments).toHaveLength(1);
    expect(r.segments[0]!.loc).toEqual({ kind: "page", page: 1 });
    expect(r.segments[0]!.text).toBe("한글 보고서 첫 줄\n과제 제출은 금요일까지입니다.");
  });

  it("PDF page limit: the first pages only, truncated", async () => {
    const r = await extract("report.pdf", { limits: { pdf: { maxPages: 5 } } });
    expect(r.segments.map((s) => s.unit)).toEqual([1, 2, 3, 4, 5]);
    expect(r.units).toBe(12);
    expect(r.truncated).toBe(true);
  });

  it.skipIf(!!OCR_SKIP)("scanned PDF: OCR of the page picture, a box per word on the page", async () => {
    const r = await extract("scanned.pdf");
    expect(r.ocr).toBe("done");
    expect(r.segments).toHaveLength(1);
    const s = r.segments[0]!;
    expect(s.loc).toEqual({ kind: "ocr_box", page: 1 });
    expect(s.text).toBe("Agent Lee scan test 2026\n가족 과제 안내문 확인");
    expect(markText(s, 0)).toBe("Agent");
    // Drawn at (120, 120) px on a 1224 × 1584 px scan of the whole page.
    expect(near((s.marks![0]![2].bbox as number[]).slice(0, 2), [120 / 1224, 120 / 1584], 0.02)).toBe(true);
    expect(markText(s, 5)).toBe("가족");
  });

  it("scanned PDF without OCR: no text, reported as ocr unavailable (not a failure)", async () => {
    const r = await extract("scanned.pdf", { ocr: false });
    expect(r.ok).toBe(true);
    expect(r.ocr).toBe("unavailable");
    expect(r.segments).toEqual([]);
  });

  it.skipIf(!!OCR_SKIP)("PNG and JPG: OCR words with boxes (fractions of the image)", async () => {
    for (const name of ["photo.png", "photo.jpg"]) {
      const r = await extract(name);
      expect(r.ocr, name).toBe("done");
      const s = r.segments[0]!;
      expect(s.loc, name).toEqual({ kind: "ocr_box" });
      expect(s.text, name).toBe("Receipt total 45000 won\n영수증 합계 확인");
      expect(markText(s, 3), name).toBe("won");
      // "영수증" drawn at (120, 150) on 1000 × 300.
      expect(near((s.marks![4]![2].bbox as number[]).slice(0, 2), [0.12, 0.5], 0.03), name).toBe(true);
    }
  });

  it("an image without OCR is refused as ocr_unavailable", async () => {
    expect(await refused("photo.png", { ocr: false })).toBe("ocr_unavailable");
  });

  it("DOCX: non-empty body paragraphs numbered, tables by table and row, a mark per cell with its column", async () => {
    const r = await extract("sample.docx");
    expect(r.segments.map((s) => [s.unit, s.loc, s.text])).toEqual([
      [1, { kind: "paragraph", paragraph: 1 }, "과제 안내"],
      [2, { kind: "paragraph", paragraph: 2 }, "제출 기한은 11월 30일입니다."],
      [3, { kind: "table", table: 1, row: 1 }, "항목 | 배점"],
      [4, { kind: "table", table: 1, row: 2 }, "보고서 | 40점"],
      [5, { kind: "table", table: 1, row: 3 }, "발표 | 60점"],
      [6, { kind: "paragraph", paragraph: 3 }, "문의는 담임 선생님께 & 메일로."],
    ]);
    expect(r.segments[3]!.marks).toEqual([
      [0, 3, { col: 1 }],
      [6, 9, { col: 2 }],
    ]);
  });

  it("XLSX: sheets in workbook order, a row per segment, a mark per cell with its reference", async () => {
    const r = await extract("sample.xlsx");
    expect(r.units).toBe(2);
    expect(r.segments.map((s) => [s.loc, s.text])).toEqual([
      // `sheetNo`: the sheet's place in the workbook (the model's id for it — its name is file text).
      [{ kind: "cell_range", sheet: "성적", sheetNo: 1, row: 1, range: "A1:B1" }, "이름 | 점수"],
      [{ kind: "cell_range", sheet: "성적", sheetNo: 1, row: 2, range: "A2:B2" }, "민준 | 92"],
      // Rich text (two runs) joined; a formula's cached value; C3 after an empty B3.
      [{ kind: "cell_range", sheet: "성적", sheetNo: 1, row: 3, range: "A3:C3" }, "서연 | 88"],
      // An absolute relationship target (/xl/worksheets/sheet2.xml) and an inline string.
      [{ kind: "cell_range", sheet: "메모", sheetNo: 2, row: 2, range: "B2" }, "다음 주 월요일까지 & 제출"],
    ]);
    expect(r.segments[2]!.marks![1]).toEqual([5, 7, { col: 3, range: "C3" }]);
  });

  it("PPTX: slides in the order shown (sldIdLst), not by file name", async () => {
    const r = await extract("sample.pptx");
    expect(r.segments.map((s) => [s.loc, s.text])).toEqual([
      [{ kind: "slide", slide: 1 }, "발표 제목\n환경 동아리 2026"],
      [{ kind: "slide", slide: 2 }, "두 번째 장: 실험 방법\n물 200mL를 끓인다"],
      [{ kind: "slide", slide: 3 }, "결론 <요약>"],
    ]);
  });

  it("CSV (quoted fields), TXT and MD (a mark per line)", async () => {
    const csv = await extract("sample.csv");
    expect(csv.segments.map((s) => [s.loc, s.text])).toEqual([
      [{ kind: "cell_range", row: 1, range: "A1:C1" }, "이름 | 점수 | 비고"],
      [{ kind: "cell_range", row: 2, range: "A2:C2" }, "민준 | 92 | 우수, 발표"],
      [{ kind: "cell_range", row: 3, range: "A3:C3" }, '서연 | 88 | "인용" 포함'],
    ]);
    const txt = await extract("sample.txt");
    expect(txt.segments).toHaveLength(1);
    expect(txt.segments[0]!.loc).toEqual({ kind: "line", line: 1 });
    expect(txt.segments[0]!.marks!.map((m) => m[2])).toEqual([
      { line: 1 },
      { line: 2 },
      { line: 3 },
      { line: 4 },
    ]);
    expect(markText(txt.segments[0]!, 1)).toBe("둘째 줄에는 숫자 42가 있습니다.");
    const md = await extract("sample.md");
    expect(md.segments[0]!.text).toBe("# 제목\n\n본문 문단입니다.\n- 항목 하나");
  });

  it("CP949 text (not UTF-8) is decoded", async () => {
    const file = path.join(tmpRoot, "cp949.txt");
    // "한글" in CP949.
    fs.writeFileSync(file, Buffer.from([0xc7, 0xd1, 0xb1, 0xdb, 0x0a]));
    const r = (await run({ ...job("sample.txt"), path: file })) as Out;
    expect(r.segments[0]!.text).toBe("한글");
  });

  it("HWP/HWPX have their own extractor (#23, hwp.test.ts): a text file claimed as one is not read", async () => {
    const hwp = await run({ ...job("sample.txt"), kind: "hwp" }).catch((e: { code: string }) => e.code);
    expect(hwp).toBe("extract_invalid");
    const hwpx = await run({ ...job("sample.txt"), kind: "hwpx" }).catch((e: { code: string }) => e.code);
    expect(hwpx).toBe("extract_zip_invalid");
  });

  it("the bytes read must be the stored file's size", async () => {
    const r = await run({ ...job("sample.txt"), bytes: 1 }).catch((e: { code: string }) => e.code);
    expect(r).toBe("extract_changed");
  });
});

describe("the segment cap through each format's own loop (review #107: input left is truncation)", () => {
  const cap = (maxSegments: number) => ({
    segments: { maxChars: 2_000_000, maxSegments },
  });
  const write = (name: string, text: string) => {
    const file = path.join(tmpRoot, name);
    fs.writeFileSync(file, text);
    return file;
  };
  const runOn = async (file: string, kind: string, limits: object) =>
    (await run({ ...job("sample.txt"), path: file, kind, limits })) as Out;

  it("CSV, TXT, PDF, XLSX, PPTX, DOCX: stopped at the cap with input left → truncated", async () => {
    const csv = write("rows.csv", Array.from({ length: 5 }, (_, i) => `r${i},${i}`).join("\n") + "\n");
    const r1 = await runOn(csv, "csv", cap(3));
    expect([r1.segments.length, r1.truncated]).toEqual([3, true]);
    const txt = write("lines.txt", Array.from({ length: 81 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
    const r2 = await runOn(txt, "txt", cap(2));
    expect([r2.segments.length, r2.truncated]).toEqual([2, true]);
    const r3 = (await run({ ...job("report.pdf"), limits: cap(5) })) as Out;
    expect([r3.segments.length, r3.truncated]).toEqual([5, true]);
    const r4 = (await run({ ...job("sample.xlsx"), limits: cap(2) })) as Out;
    expect([r4.segments.length, r4.truncated]).toEqual([2, true]);
    const r5 = (await run({ ...job("sample.pptx"), limits: cap(2) })) as Out;
    expect([r5.segments.length, r5.truncated]).toEqual([2, true]);
    const r6 = (await run({ ...job("sample.docx"), limits: cap(2) })) as Out;
    expect([r6.segments.length, r6.truncated]).toEqual([2, true]);
  });

  it("exactly at the cap with nothing left is not truncated", async () => {
    const csv = write("three.csv", "a,1\nb,2\nc,3\n");
    const r = await runOn(csv, "csv", cap(3));
    expect([r.segments.length, r.truncated]).toEqual([3, false]);
    const pptx = (await run({ ...job("sample.pptx"), limits: cap(3) })) as Out;
    expect([pptx.segments.length, pptx.truncated]).toEqual([3, false]);
    const pdf = (await run({ ...job("report.pdf"), limits: cap(12) })) as Out;
    expect([pdf.segments.length, pdf.truncated]).toEqual([12, false]);
  });
});

describe("hostile fixtures are refused (#48)", () => {
  it("zip bomb: 300 MB in one entry — honest sizes refused before inflating, lying sizes stopped by the inflater", async () => {
    expect(await refused("bomb.docx")).toBe("extract_too_large");
    expect(await refused("bomb-lying.docx")).toBe("extract_too_large");
  });

  it("the inflater itself stops at the declared size; a declared size over the limit is never inflated", () => {
    const spy = vi.spyOn(zlib, "inflateRawSync");
    try {
      const lying = openZip(fs.readFileSync(fixture("bomb-lying.docx")));
      expect(() => lying.read("word/document.xml")).toThrow(/extract_too_large/);
      const call = spy.mock.calls.at(-1)!;
      // Declared 1024 bytes: at most 1025 come out, however much the data holds.
      expect((call[1] as zlib.ZlibOptions).maxOutputLength).toBe(1025);
      spy.mockClear();
      // Honest 300 MB entry, with a total limit that would allow it: refused on the declared size alone.
      const limits = { maxEntries: 5000, maxEntryBytes: 64 << 20, maxTotalBytes: 1 << 30, maxRatio: 1e9 };
      expect(() => openZip(fs.readFileSync(fixture("bomb.docx")), limits)).toThrow(/extract_too_large/);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("XXE (external entity) and billion laughs (internal entities): no DTD is ever processed", async () => {
    expect(await refused("xxe.docx")).toBe("extract_xml_forbidden");
    expect(await refused("laughs.xlsx")).toBe("extract_xml_forbidden");
  });

  it("zip slip (an entry ../../evil.xml) and a relationship target out of the package", async () => {
    expect(await refused("slip.docx")).toBe("extract_path_escape");
    expect(await refused("escape.pptx")).toBe("extract_path_escape");
  });

  it("entry names and part references: only relative paths inside the archive", () => {
    for (const bad of ["../x", "a/../../x", "/etc/passwd", "C:/x", "a\\b", "a\0b", "./a", ""])
      expect(safeEntryName(bad), JSON.stringify(bad)).toBe(false);
    expect(safeEntryName("word/document.xml")).toBe(true);
    expect(resolvePart("ppt", "slides/slide1.xml")).toBe("ppt/slides/slide1.xml");
    expect(resolvePart("ppt/slides", "../media/a.png")).toBe("ppt/media/a.png");
    expect(resolvePart("xl", "/xl/worksheets/sheet2.xml")).toBe("xl/worksheets/sheet2.xml");
    for (const bad of [
      "../../x",
      "../../../etc/passwd",
      "file:///etc/passwd",
      "http://x/y",
      "%2e%2e/%2e%2e/x",
    ])
      expect(() => resolvePart("ppt", bad), bad).toThrow(/extract_path_escape/);
  });

  it("XML: DOCTYPE and any entity of its own refused; malformed and too deep is invalid", () => {
    const parse = (x: string, depth?: number) => {
      try {
        parseXml(x, {}, depth ? { maxDepth: depth } : {});
        return "ok";
      } catch (e) {
        return (e as { code: string }).code;
      }
    };
    expect(parse('<!DOCTYPE a SYSTEM "http://x/a.dtd"><a/>')).toBe("extract_xml_forbidden");
    expect(parse("<a>&ext;</a>")).toBe("extract_xml_forbidden");
    expect(parse('<a b="&ext;"/>')).toBe("extract_xml_forbidden");
    expect(parse("<a>&lt;&#65;&#x42;&amp;</a>")).toBe("ok");
    expect(parse("<a><b></a></b>")).toBe("extract_xml_invalid");
    expect(parse("<a>")).toBe("extract_xml_invalid");
    expect(parse("<a>&amp</a>")).toBe("extract_xml_invalid");
    expect(parse("<a><a><a/></a></a>", 2)).toBe("extract_xml_invalid");
    const texts: string[] = [];
    parseXml("<a><![CDATA[<b>&x;</b>]]></a>", { text: (t: string) => texts.push(t) });
    expect(texts).toEqual(["<b>&x;</b>"]);
  });

  it("ZIP: ZIP64 markers, encrypted entries, a wrong CRC and an entry total over the limit are refused", () => {
    const good = fs.readFileSync(fixture("sample.docx"));
    const eocd = good.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const cd = good.readUInt32LE(eocd + 16);
    const code = (b: Buffer, limits?: object) => {
      try {
        const z = openZip(b, limits);
        for (const n of z.names) z.read(n);
        return "ok";
      } catch (e) {
        return (e as { code: string }).code;
      }
    };
    expect(code(good)).toBe("ok");
    const zip64 = Buffer.from(good);
    zip64.writeUInt32LE(0xffffffff, eocd + 16);
    expect(code(zip64)).toBe("extract_zip_invalid");
    const encrypted = Buffer.from(good);
    encrypted.writeUInt16LE(encrypted.readUInt16LE(cd + 8) | 1, cd + 8);
    expect(code(encrypted)).toBe("extract_zip_invalid");
    const crc = Buffer.from(good);
    crc.writeUInt32LE((crc.readUInt32LE(cd + 16) ^ 1) >>> 0, cd + 16);
    expect(code(crc)).toBe("extract_zip_invalid");
    expect(code(good, { maxEntries: 5000, maxEntryBytes: 64 << 20, maxTotalBytes: 100, maxRatio: 400 })).toBe(
      "extract_too_large",
    );
    expect(
      code(good, { maxEntries: 1, maxEntryBytes: 64 << 20, maxTotalBytes: 1 << 30, maxRatio: 400 }),
    ).toBe("extract_too_large");
  });

  it("text limits: only the file's total cuts (its text ends there), and says so; a unit is never cut otherwise", () => {
    // A unit longer than the server's 200k display cap is kept whole: the server scrubs before it caps (review #107 6차).
    const whole = new Segments({ maxChars: 1_000_000, maxSegments: 5 });
    whole.add(1, { kind: "line", line: 1 }, "y".repeat(300_000));
    expect([whole.items[0]!.text.length, whole.truncated]).toEqual([300_000, false]);
    const out = new Segments({ maxChars: 10, maxSegments: 2 });
    expect(out.add(1, { kind: "line", line: 1 }, "abcd")).toBe(true);
    expect(out.add(2, { kind: "line", line: 2 }, "efghijklm", [[0, 9, { line: 2 }]])).toBe(false);
    expect(out.items[1]).toEqual({
      unit: 2,
      loc: { kind: "line", line: 2 },
      text: "efghij",
      marks: [[0, 6, { line: 2 }]],
      // Text was left out right after it: the cut-off-secret rule applies at this end (review #107 9차).
      endsEarly: true,
    });
    expect(out.truncated).toBe(true);
    // Never half a surrogate pair.
    const pair = new Segments({ maxChars: 3, maxSegments: 5 });
    pair.add(1, { kind: "line", line: 1 }, "ab😀c");
    expect(pair.items[0]!.text).toBe("ab");
  });
});

describe("locators (packages/shared)", () => {
  it("the common locator type and its labels", () => {
    const base = { fileId: "f", fileRevision: "a".repeat(64) };
    expect(
      FileLocator.parse({ ...base, kind: "page", page: 12, bbox: [0.1, 0.2, 0.3, 0.05], charRange: [3, 9] }),
    ).toBeTruthy();
    expect(() => FileLocator.parse({ ...base, kind: "page", bbox: [0, 0, 2, 0] })).toThrow();
    expect(() => FileLocator.parse({ ...base, kind: "cell_range", range: "B2;drop" })).toThrow();
    expect(locatorLabel({ kind: "page", page: 12 })).toBe("12쪽");
    expect(locatorLabel({ kind: "table", table: 3, row: 2 })).toBe("3번째 표 · 2행");
    expect(locatorLabel({ kind: "paragraph", paragraph: 12 })).toBe("12번째 문단");
    expect(locatorLabel({ kind: "cell_range", sheet: "성적", range: "B2" })).toBe("성적 · B2");
    expect(locatorLabel({ kind: "slide", slide: 2 })).toBe("2번째 슬라이드");
    expect(locatorLabel({ kind: "line", line: 5 })).toBe("5번째 줄");
    expect(locatorLabel({ kind: "ocr_box", page: 3 })).toBe("3쪽 · 사진 속 글자");
    expect(fileCitationLabel("보고서.pdf", { kind: "page", page: 12 })).toBe("보고서.pdf · 12쪽");
  });
});

// ---- the sandboxed run (#42) ----------------------------------------------------------------------------------

describe.skipIf(process.platform !== "darwin")("the extractor in its sandbox (macOS sandbox-exec)", () => {
  const sandboxed = async (name: string, kind: string, o: { stdinPath?: string } = {}) => {
    const file = fixture(name);
    const real = fs.realpathSync(file);
    const opts = extractRunOptions({ kind: kind as never, bytes: fs.statSync(file).size }, real, ocr);
    if (o.stdinPath) {
      const j = JSON.parse(opts.stdin!) as Record<string, unknown>;
      opts.stdin = JSON.stringify({ ...j, path: o.stdinPath, bytes: fs.statSync(o.stdinPath).size });
    }
    return workerResult(await runIsolated(opts));
  };

  it("reads the PDF, the workbook and (with OCR) the picture — inside the sandbox", async () => {
    const pdf = await sandboxed("report.pdf", "pdf");
    expect(pdf.ok && pdf.segments.length).toBe(12);
    const xlsx = await sandboxed("sample.xlsx", "xlsx");
    expect(xlsx.ok && xlsx.segments[0]!.loc).toEqual({
      kind: "cell_range",
      sheet: "성적",
      sheetNo: 1,
      row: 1,
      range: "A1:B1",
    });
    if (ocr.available) {
      const png = await sandboxed("photo.png", "png");
      expect(png.ok && png.segments[0]!.text).toBe("Receipt total 45000 won\n영수증 합계 확인");
    }
  });

  it("the hostile fixtures are refused there too", async () => {
    expect(await sandboxed("bomb-lying.docx", "docx")).toEqual({ ok: false, code: "extract_too_large" });
    expect(await sandboxed("xxe.docx", "docx")).toEqual({ ok: false, code: "extract_xml_forbidden" });
  });

  it("the worker cannot read any other file — another family member's upload next to the allowed one", async () => {
    const other = path.join(tmpRoot, "other-user-file.txt");
    fs.writeFileSync(other, "가족의 다른 파일");
    // The policy allows sample.txt; the job names the other file.
    const r = await sandboxed("sample.txt", "txt", { stdinPath: other });
    expect(r).toEqual({ ok: false, code: "extract_failed" });
    // Control: the same file named in the policy is read.
    const opts = extractRunOptions({ kind: "txt", bytes: fs.statSync(other).size }, other, undefined);
    const ok = workerResult(await runIsolated(opts));
    expect(ok.ok && ok.segments[0]!.text).toBe("가족의 다른 파일");
  });

  it("no network, no writes, no environment: the policy", () => {
    const opts = extractRunOptions({ kind: "pdf", bytes: 1 }, fixture("report.pdf"), ocr);
    expect(opts.network).toBe("none");
    expect(opts.write).toEqual([]);
    expect(opts.env).toEqual({ AGENTLEE_EXTRACT_WORKER: "1" });
    expect(opts.read).toEqual([fixture("report.pdf"), ...(ocr.available ? [ocr.langDir] : [])]);
    // Program folders only (pinned packages and the worker), never a data folder.
    for (const t of opts.trusted ?? []) expect(t).toMatch(/node_modules|apps\/server\/extract$/);
    expect(packageFolders(["tesseract.js"]).some((p) => p.includes("tesseract.js-core@"))).toBe(true);
  });

  it("time and memory limits stop it (fixed codes)", async () => {
    const opts = extractRunOptions(
      { kind: "pdf", bytes: fs.statSync(fixture("report.pdf")).size },
      fixture("report.pdf"),
      undefined,
    );
    expect(workerResult(await runIsolated({ ...opts, timeoutMs: 1 }))).toEqual({
      ok: false,
      code: "extract_timeout",
    });
    // The memory monitor's own kill is tested in isolation.test.ts; here: how its outcomes map.
    for (const killed of ["memory", "monitor", "output", "aborted"] as const)
      expect(workerResult({ code: null, signal: "SIGKILL", stdout: "", stderr: "", killed })).toEqual({
        ok: false,
        code: "extract_limit",
      });
    expect(workerResult({ code: 0, signal: null, stdout: "not json", stderr: "", killed: null })).toEqual({
      ok: false,
      code: "extract_failed",
    });
  });
});
