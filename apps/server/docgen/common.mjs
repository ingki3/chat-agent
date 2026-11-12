// Shared pieces of the document generator (#49): refusal codes, picture headers, sizes and text helpers.

export class DocError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/** Largest picture drawn (width × height) — DOC_LIMITS.imagePixels: a small file can be a huge picture. */
export const MAX_PIXELS = 40_000_000;
const MAX_SIDE = 20_000;

/**
 * Width and height of a PNG (IHDR) or JPEG (first SOF marker) from its header — only the header is read here; the
 * libraries embed the bytes as they are (PDF decodes a PNG once, within MAX_PIXELS). Refused: not that format
 * (`doc_image_unsupported`), or bigger than MAX_PIXELS (`doc_image_too_large`).
 */
export function imageInfo(buf, kind) {
  let width;
  let height;
  let decodes = false;
  if (kind === "png") {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (buf.length < 33 || !sig.every((b, i) => buf[i] === b) || buf.toString("latin1", 12, 16) !== "IHDR")
      throw new DocError("doc_image_unsupported");
    width = buf.readUInt32BE(16);
    height = buf.readUInt32BE(20);
    decodes = pngDecodes(buf);
  } else if (kind === "jpg") {
    if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) throw new DocError("doc_image_unsupported");
    let i = 2;
    for (;;) {
      while (i < buf.length && buf[i] === 0xff) i++;
      if (i + 8 >= buf.length) throw new DocError("doc_image_unsupported");
      const marker = buf[i];
      // SOF0–SOF15 except DHT (C4), JPG (C8) and DAC (CC): the frame header with the size.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        height = buf.readUInt16BE(i + 4);
        width = buf.readUInt16BE(i + 6);
        break;
      }
      // Markers without a length (RSTn, SOI, TEM); anything else has one.
      if ((marker >= 0xd0 && marker <= 0xd8) || marker === 0x01) {
        i++;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) throw new DocError("doc_image_unsupported");
      i += 1 + buf.readUInt16BE(i + 1);
    }
  } else throw new DocError("doc_image_unsupported");
  if (!width || !height) throw new DocError("doc_image_unsupported");
  if (width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS)
    throw new DocError("doc_image_too_large");
  return { kind, buf, width, height, decodes };
}

/**
 * Whether pdfkit must decode this PNG's pixels to embed it (alpha channel, transparency chunk, 16-bit samples or
 * interlacing) — that costs memory per pixel (PDF_DECODED_PIXELS); any other PNG is embedded as it is compressed.
 */
function pngDecodes(buf) {
  const depth = buf[24];
  const colorType = buf[25];
  const interlace = buf[28];
  if (colorType === 4 || colorType === 6 || depth === 16 || interlace === 1) return true;
  for (let at = 8; at + 8 <= buf.length;) {
    const len = buf.readUInt32BE(at);
    const type = buf.toString("latin1", at + 4, at + 8);
    if (type === "tRNS") return true;
    if (type === "IDAT" || type === "IEND") return false;
    at += 12 + len;
  }
  return false;
}

/** The size of a `w × h` picture scaled down (never up) to fit `maxW × maxH`. */
export function fit(w, h, maxW, maxH) {
  const s = Math.min(1, maxW / w, maxH / h);
  return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}

/** A cell as text (numbers as JavaScript prints them, null as empty). */
export const cellText = (c) => (c === null || c === undefined ? "" : String(c));

/** The picture of an image block (the server sent every one the document names). */
export function imageOf(ctx, block) {
  const img = ctx.images.get(block.fileId);
  if (!img) throw new DocError("doc_image_not_found");
  return img;
}

export const DEFAULT_REFERENCES_TITLE = "참고문헌";

/**
 * Volume budgets of DOCX, XLSX and PDF (review #110 4) — what the worker's memory grows with, measured per format
 * (docs/ops.md §29.3): every line of text (a text, or each line after a break in it — table cells' lines included),
 * every table cell (header cells included) and every picture placement (by the size of its file: a picture placed
 * twice is embedded or decoded twice). Over `max` the document is refused before anything is made (`doc_too_large`).
 * PPTX keeps its own count while it lays out (pptx.mjs `MAX_VOLUME`).
 */
export const VOLUME = {
  // Units ≈ 3 KB: a line, a cell 3, a picture 0.1 a KB (Word keeps one copy of the file per placement).
  docx: { line: 1, cell: 3, image: (kb) => 0.1 * kb, max: 120_000 },
  // Units ≈ 12 KB: a picture 1 a KB (exceljs holds ~12 bytes per byte of each placement), lines and cells little.
  xlsx: { line: 0.02, cell: 0.25, image: (kb) => kb, max: 34_000 },
  // Units ≈ 1 MB. A JPEG is embedded as its compressed bytes (never decoded): about 10–15 MB per MB of file per
  // placement, counted 16. A PNG costs more than its size (pdfkit reads it whole — a 9 MB PNG took 340 MB, 2.4 MB ones
  // ~50 MB each — and decodes it when it has alpha, transparency, 16 bits or interlacing): 20 a MB plus 2 a MB².
  // Pages are written out as they end, so lines and cells cost little.
  pdf: {
    line: 0.0005,
    cell: 0.007,
    image: (kb, img) => (img.kind === "jpg" ? 16 * (kb / 1024) : 20 * (kb / 1024) + 2 * (kb / 1024) ** 2),
    max: 450,
  },
};

const linesOf = (t) => (t ? t.split("\n").length : 1);

/** The document's volume under `w` (see `VOLUME`). */
export function volumeOf(doc, images, w) {
  let v = 0;
  const text = (t) => (v += w.line * linesOf(t));
  text(doc.title);
  if (doc.subtitle) text(doc.subtitle);
  if (doc.author) text(doc.author);
  for (const b of doc.blocks) {
    if (b.text !== undefined) text(b.text);
    if (b.caption) text(b.caption);
    if (b.title) text(b.title);
    for (const i of b.items ?? []) text(i);
    if (b.type === "table") {
      v += w.cell * b.columns.length * (b.rows.length + 1);
      for (const c of b.columns) text(c);
      for (const r of b.rows) for (const c of r) text(cellText(c));
    }
    if (b.type === "image") {
      const img = images.get(b.fileId);
      if (img) v += w.image(Math.ceil(img.buf.length / 1024), img);
    }
  }
  return v;
}

/** Refuses a document over its format's volume budget. */
export function checkVolume(kind, doc, images) {
  if (volumeOf(doc, images, VOLUME[kind]) > VOLUME[kind].max) throw new DocError("doc_too_large");
}
