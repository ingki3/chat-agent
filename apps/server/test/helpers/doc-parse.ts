import { createRequire } from "node:module";
import crypto from "node:crypto";
import zlib from "node:zlib";
import type ExcelJSType from "exceljs";
import type JSZipType from "jszip";

/**
 * Readers for generated documents (#49 fixture tests) — independent of the generator: the office files are
 * unzipped and their text elements read (Word `<w:t>`, PowerPoint `<a:t>`), XLSX is loaded with exceljs, and the
 * PDF's text is extracted with pdf.js (it decodes the embedded font's ToUnicode map, as a viewer does).
 */

// Loaded with Node's own require (not an ESM import): the e2e runner's loader cannot link these CommonJS packages.
const require = createRequire(import.meta.url);
const JSZip = require("jszip") as typeof JSZipType;
const ExcelJS = require("exceljs") as typeof ExcelJSType;

const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()]!,
  );

/** The text elements `<prefix:t>` of an XML part, in order. */
export function textElements(xml: string, prefix: "w" | "a"): string[] {
  const re = new RegExp(`<${prefix}:t(?:\\s[^>]*)?>([^<]*)</${prefix}:t>`, "g");
  return [...xml.matchAll(re)].map((m) => decode(m[1]!));
}

export async function readDocx(buf: Buffer) {
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file("word/document.xml")!.async("string");
  const paragraphs = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) =>
    textElements(m[0], "w").join(""),
  );
  const tables = [...xml.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>/g)].map((t) =>
    [...t[0].matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((r) =>
      [...r[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((c) => textElements(c[0], "w").join("")),
    ),
  );
  const media = Object.keys(zip.files).filter((n) => n.startsWith("word/media/") && !n.endsWith("/"));
  return { xml, paragraphs, tables, media, text: paragraphs.join("\n") };
}

export async function readPptx(buf: Buffer) {
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  const xml = await Promise.all(names.map((n) => zip.file(n)!.async("string")));
  const slides = xml.map((x) => textElements(x, "a"));
  const media = Object.keys(zip.files).filter((n) => n.startsWith("ppt/media/") && !n.endsWith("/"));
  /** Per slide: the shape at `y` EMU (e.g. the body box) as its paragraphs' texts. */
  const shapeAt = (i: number, y: number): string[] | undefined => {
    const sp = [...xml[i]!.matchAll(/<p:sp>[\s\S]*?<\/p:sp>/g)].find((m) =>
      new RegExp(`<a:off x="\\d+" y="${y}"/>`).test(m[0]),
    );
    return sp && [...sp[0].matchAll(/<a:p>[\s\S]*?<\/a:p>/g)].map((p) => textElements(p[0], "a").join(""));
  };
  return { slides, xml, media, shapeAt, text: slides.map((s) => s.join("\n")).join("\n") };
}

export async function readXlsx(buf: Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

/** Every text item of a PDF with its position (pdf.js), for checks of what a page really holds. */
export async function readPdfItems(buf: Buffer) {
  const pdfjs = (await import(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"))) as {
    getDocument(o: object): { promise: Promise<PdfDoc>; destroy(): Promise<void> };
  };
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  const items: { str: string; x: number; y: number; page: number }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    for (const it of content.items as { str?: string; transform?: number[] }[])
      if (it.str) items.push({ str: it.str, x: it.transform![4]!, y: it.transform![5]!, page: i });
  }
  await task.destroy();
  return items;
}

export async function readPdf(buf: Buffer) {
  const pdfjs = (await import(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"))) as {
    getDocument(o: object): { promise: Promise<PdfDoc>; destroy(): Promise<void> };
  };
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((it) => ("str" in it ? it.str : "")).join(""));
  }
  const meta = await doc.getMetadata();
  await task.destroy();
  return { pages, text: pages.join("\n"), info: meta.info as Record<string, unknown> };
}
type PdfDoc = {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: ({ str: string } | object)[] }> }>;
  getMetadata(): Promise<{ info: unknown }>;
};

/** A real PNG (RGB, `w × h`, one colour) — small, decodable by every library. */
export function png(w: number, h: number, rgb: [number, number, number] = [40, 90, 160]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3)]);
  for (let x = 0; x < w; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A PNG with an alpha channel (RGBA, one colour): pdfkit has to decode its pixels. Small however large. */
export function pngRgba(w: number, h: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6; // RGBA
  const row = Buffer.alloc(1 + w * 4, 0x80);
  row[0] = 0;
  const raw = zlib.deflateSync(Buffer.concat(Array.from({ length: h }, () => row)));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", raw),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A JPEG of `bytes` bytes that says it is `w × h`: real markers (SOI, APP0, SOF0, SOS, EOI) around random scan data.
 * Nothing here decodes it (the worker reads the frame header; pdfkit embeds the bytes as they are).
 */
export function jpegOfSize(w: number, h: number, bytes: number): Buffer {
  const seg = (marker: number, body: number[]) =>
    Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body]);
  const head = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    seg(0xc0, [8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]),
    seg(0xda, [3, 1, 0, 2, 0x11, 3, 0x11, 0, 0x3f, 0]),
  ]);
  const scan = crypto.randomBytes(bytes - head.length - 2);
  for (let i = 0; i < scan.length; i++) if (scan[i] === 0xff) scan[i] = 0xfe;
  return Buffer.concat([head, scan, Buffer.from([0xff, 0xd9])]);
}

/** A PNG whose header claims `w × h` (the pixels are not there): for the picture-size limit. */
export function pngHeader(w: number, h: number): Buffer {
  const b = png(1, 1);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
