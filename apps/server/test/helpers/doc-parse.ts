import { createRequire } from "node:module";
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

/** The contents of a ZIP's (DOCX, XLSX, PPTX) files whose names match `name`, in name order. */
export async function zipFiles(buf: Buffer, name: RegExp): Promise<Buffer[]> {
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files)
    .filter((n) => name.test(n) && !zip.files[n]!.dir)
    .sort();
  return Promise.all(names.map((n) => zip.file(n)!.async("nodebuffer")));
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

// Baseline JPEG Huffman tables of ITU T.81 Annex K (K.3: luminance DC, K.5: luminance AC) — code counts per length 1–16, then the symbols.
const DC_COUNTS = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_SYMBOLS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_COUNTS = [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_SYMBOLS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71,
  0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
  0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37,
  0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
  0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83,
  0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3,
  0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3,
  0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

/** Canonical Huffman codes (T.81 Annex C): symbol → [code, length]. */
function huffmanCodes(counts: number[], symbols: number[]): Map<number, [number, number]> {
  const codes = new Map<number, [number, number]>();
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++, code <<= 1)
    for (let n = 0; n < counts[len - 1]!; n++) codes.set(symbols[k++]!, [code++, len]);
  return codes;
}

/**
 * A real baseline JPEG (YCbCr, 4:4:4, standard Huffman tables) of `w × h` pixels and exactly `bytes` bytes, that any
 * decoder decodes to a noisy picture. The quantised DCT coefficients are chosen directly (seeded, so the same
 * arguments give the same bytes): each 8 × 8 block gets as many non-zero coefficients as keep the scan on course for
 * `bytes`, so nearly all of the file is entropy-coded picture data; the last few bytes are a comment segment (COM).
 * Throws when `w × h` cannot fill `bytes` (or `bytes` is too small for `w × h`).
 */
export function jpegOfSize(w: number, h: number, bytes: number, seed = 1): Buffer {
  const seg = (marker: number, body: number[] | Buffer) =>
    Buffer.concat([
      Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]),
      Buffer.from(body),
    ]);
  const head = Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    seg(0xdb, [0, ...Array<number>(64).fill(4)]), // one 8-bit quantisation table, every step 4
    seg(0xc0, [8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]),
    seg(0xc4, [0x00, ...DC_COUNTS, ...DC_SYMBOLS]),
    seg(0xc4, [0x10, ...AC_COUNTS, ...AC_SYMBOLS]),
  ]);
  const sos = seg(0xda, [3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0]);
  const dc = huffmanCodes(DC_COUNTS, DC_SYMBOLS);
  const ac = huffmanCodes(AC_COUNTS, AC_SYMBOLS);
  // Room for the scan, leaving a little for the closing COM (≥ 4 bytes) and the controller's last block.
  const budget = bytes - head.length - sos.length - 2 - 1024;
  const blocks = Math.ceil(w / 8) * Math.ceil(h / 8) * 3;
  if (budget < blocks) throw new Error(`jpegOfSize: ${bytes} bytes is too small for ${w} × ${h}`);

  const out = Buffer.alloc(budget + 4096);
  let pos = 0;
  let acc = 0; // pending bits, most significant first
  let nbits = 0;
  const put = (code: number, len: number) => {
    acc = (acc << len) | (code & ((1 << len) - 1));
    nbits += len;
    while (nbits >= 8) {
      const byte = (acc >>> (nbits - 8)) & 0xff;
      nbits -= 8;
      acc &= (1 << nbits) - 1;
      out[pos++] = byte;
      if (byte === 0xff) out[pos++] = 0; // byte stuffing
    }
  };
  // Deterministic PRNG (mulberry32).
  let state = seed >>> 0;
  const rand = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
  const prevDc = [0, 0, 0];
  const BITS_PER_COEFF = 6; // about: a 2–5-bit code plus 1–4 value bits
  for (let b = 0; b < blocks; b++) {
    const c = b % 3;
    // DC: a slow walk around mid-grey, coded as the difference from this component's previous block.
    const dcValue = Math.max(-60, Math.min(60, prevDc[c]! + Math.round((rand() - 0.5) * 6)));
    const diff = dcValue - prevDc[c]!;
    prevDc[c] = dcValue;
    const dcSize = diff === 0 ? 0 : 32 - Math.clz32(Math.abs(diff));
    put(...dc.get(dcSize)!);
    if (dcSize) put(diff > 0 ? diff : diff + (1 << dcSize) - 1, dcSize);
    // AC: the first `n` coefficients in zig-zag order, each ±1…15 — `n` steered by how far the scan is off course.
    const want = ((b + 1) / blocks) * budget - pos;
    const n = Math.max(0, Math.min(63, Math.round((want * 8) / BITS_PER_COEFF)));
    for (let k = 0; k < n; k++) {
      const v = (1 + Math.floor(rand() * 15)) * (rand() < 0.5 ? -1 : 1);
      const size = 32 - Math.clz32(Math.abs(v));
      put(...ac.get(size)!); // run of zeros 0, then `size`
      put(v > 0 ? v : v + (1 << size) - 1, size);
    }
    if (n < 63) put(...ac.get(0x00)!); // end of block
  }
  if (nbits) put((1 << (8 - nbits)) - 1, 8 - nbits); // pad the last byte with 1-bits
  const scan = out.subarray(0, pos);
  let rest = bytes - head.length - sos.length - scan.length - 2;
  if (rest < 0 || pos < budget - 4096)
    throw new Error(`jpegOfSize: ${w} × ${h} cannot be ${bytes} bytes (scan ${pos}, wanted about ${budget})`);
  // Fill the rest with comment segments (each at most 65,535 bytes, at least 4).
  const coms: Buffer[] = [];
  while (rest > 0) {
    const len = rest > 65_537 ? Math.min(65_537, rest - 4) : rest;
    coms.push(seg(0xfe, Buffer.alloc(len - 4, 0x20)));
    rest -= len;
  }
  return Buffer.concat([head, ...coms, sos, scan, Buffer.from([0xff, 0xd9])]);
}

/** `jpeg` without its marker segments of the given kinds (e.g. 0xdb DQT, 0xc4 DHT) before the scan. */
export function withoutSegments(jpeg: Buffer, markers: number[]): Buffer {
  const keep: Buffer[] = [jpeg.subarray(0, 2)];
  let i = 2;
  while (jpeg[i] === 0xff && jpeg[i + 1] !== 0xda) {
    const end = i + 2 + jpeg.readUInt16BE(i + 2);
    if (!markers.includes(jpeg[i + 1]!)) keep.push(jpeg.subarray(i, end));
    i = end;
  }
  return Buffer.concat([...keep, jpeg.subarray(i)]);
}

/** A minimal PDF of one page that draws `jpeg` (`w × h`, DeviceRGB, as it is) — for decoding it with pdf.js. */
function pdfOfJpeg(jpeg: Buffer, w: number, h: number): Buffer {
  const parts: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const add = (b: Buffer | string) => {
    const buf = typeof b === "string" ? Buffer.from(b, "latin1") : b;
    parts.push(buf);
    length += buf.length;
  };
  const obj = (n: number, body: (Buffer | string)[]) => {
    offsets[n] = length;
    add(`${n} 0 obj\n`);
    for (const b of body) add(b);
    add("\nendobj\n");
  };
  const draw = `q ${w} 0 0 ${h} 0 0 cm /Im1 Do Q`;
  add("%PDF-1.4\n");
  obj(1, ["<< /Type /Catalog /Pages 2 0 R >>"]);
  obj(2, ["<< /Type /Pages /Kids [3 0 R] /Count 1 >>"]);
  obj(3, [
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>`,
  ]);
  obj(4, [
    `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`,
    jpeg,
    "\nendstream",
  ]);
  obj(5, [`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`]);
  const xref = length;
  add(`xref\n0 6\n0000000000 65535 f \n`);
  for (let n = 1; n <= 5; n++) add(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
  add(`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(parts);
}

export type DecodedImage = { width: number; height: number; data: Uint8Array | Uint8ClampedArray };

/**
 * Every picture a PDF paints, decoded to pixels by pdf.js (its own JPEG and PNG decoders — as a viewer shows them).
 * A picture pdf.js cannot decode is left out.
 */
export async function pdfImages(buf: Buffer): Promise<DecodedImage[]> {
  const pdfjs = (await import(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"))) as {
    getDocument(o: object): { promise: Promise<PdfImageDoc>; destroy(): Promise<void> };
    OPS: Record<string, number>;
  };
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, verbosity: 0 });
  const doc = await task.promise;
  const images: DecodedImage[] = [];
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const ops = await page.getOperatorList();
      for (let k = 0; k < ops.fnArray.length; k++) {
        if (ops.fnArray[k] !== pdfjs.OPS.paintImageXObject) continue;
        const ref = (ops.argsArray[k] as unknown[])[0];
        let img: Partial<DecodedImage> | undefined;
        try {
          img = (
            typeof ref === "string" ? (ref.startsWith("g_") ? page.commonObjs : page.objs).get(ref) : ref
          ) as Partial<DecodedImage> | undefined;
        } catch {
          img = undefined;
        }
        if (img?.data && img.width && img.height)
          images.push({ width: img.width, height: img.height, data: img.data });
      }
    }
  } finally {
    await task.destroy();
  }
  return images;
}
type PdfImageDoc = {
  numPages: number;
  getPage(n: number): Promise<{
    getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[] }>;
    objs: { get(id: string): unknown };
    commonObjs: { get(id: string): unknown };
  }>;
};

/** A JPEG decoded to pixels by pdf.js's JPEG decoder (`w × h` from its frame header), or undefined if it does not decode. */
export async function decodeJpeg(jpeg: Buffer): Promise<DecodedImage | undefined> {
  let i = 2;
  while (i + 8 < jpeg.length && !(jpeg[i] === 0xff && jpeg[i + 1] === 0xc0))
    i += 2 + jpeg.readUInt16BE(i + 2);
  if (i + 8 >= jpeg.length) return undefined;
  const h = jpeg.readUInt16BE(i + 5);
  const w = jpeg.readUInt16BE(i + 7);
  return (await pdfImages(pdfOfJpeg(jpeg, w, h)))[0];
}

/** How many distinct values a decoded picture's samples take — a real (noisy) photo has many, a blank one a few. */
export function distinctSamples(img: DecodedImage): number {
  return new Set(img.data).size;
}

/** A PNG whose header claims `w × h` (the pixels are not there): for the picture-size limit. */
export function pngHeader(w: number, h: number): Buffer {
  const b = png(1, 1);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
