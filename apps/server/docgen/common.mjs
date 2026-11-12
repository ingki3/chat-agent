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
  if (kind === "png") {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (buf.length < 33 || !sig.every((b, i) => buf[i] === b) || buf.toString("latin1", 12, 16) !== "IHDR")
      throw new DocError("doc_image_unsupported");
    width = buf.readUInt32BE(16);
    height = buf.readUInt32BE(20);
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
  return { kind, buf, width, height };
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
