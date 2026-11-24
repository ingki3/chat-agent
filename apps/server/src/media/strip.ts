/**
 * Reference images leave this server (`image_generate`'s `input_references`, #238): only what draws the picture
 * goes. Without a new dependency the image is not re-encoded; its metadata is dropped structurally instead — text,
 * EXIF, XMP, ICC profiles, comments and anything a format does not need to decode the pixels (also inside WebP
 * animation frames) — and what is left is checked for known secrets by the caller (`textRuns`). Every declared
 * length is checked against the file (a truncated or padded-wrong container is refused), the required parts must
 * be there, and the number of chunks, segments and frames is capped so a small file cannot make the parser build
 * huge lists. A file that does not pass is refused (null), never sent as it is.
 */

/** Pieces one image may have (chunks, segments, frame sub-chunks) — legitimate images have far fewer. */
export const MAX_PARTS = 4096;
/** Text runs collected from one image (the egress check's input). */
export const MAX_RUNS = 20_000;

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** PNG chunks kept: the critical ones and the ancillary ones that only say how to draw (no free text, no ICC). */
const PNG_KEEP = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "gAMA",
  "cHRM",
  "sRGB",
  "sBIT",
  "bKGD",
  "pHYs",
  "acTL",
  "fcTL",
  "fdAT",
]);

export function stripPng(b: Buffer): Buffer | null {
  if (b.length < 8 || !b.subarray(0, 8).equals(PNG_SIG)) return null;
  const out: Buffer[] = [PNG_SIG];
  let p = 8;
  let parts = 0;
  let idat = false;
  let ended = false;
  while (p + 12 <= b.length) {
    if (++parts > MAX_PARTS) return null;
    const len = b.readUInt32BE(p);
    const type = b.toString("latin1", p + 4, p + 8);
    const end = p + 12 + len;
    if (!/^[A-Za-z]{4}$/.test(type) || end > b.length) return null;
    // IHDR first, exactly 13 bytes.
    if ((parts === 1) !== (type === "IHDR") || (type === "IHDR" && len !== 13)) return null;
    if (type === "IDAT") idat = true;
    if (PNG_KEEP.has(type)) out.push(b.subarray(p, end));
    p = end;
    if (type === "IEND") {
      ended = true;
      break; // anything after IEND is dropped
    }
  }
  return ended && idat ? Buffer.concat(out) : null;
}

/** JPEG: every APPn segment but a plain JFIF / Adobe header, and every comment, dropped; nothing after EOI. */
export function stripJpeg(b: Buffer): Buffer | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const out: Buffer[] = [b.subarray(0, 2)];
  let p = 2;
  let parts = 0;
  let frame = false;
  let scan = false;
  for (;;) {
    if (++parts > MAX_PARTS) return null;
    if (p + 2 > b.length || b[p] !== 0xff) return null;
    let m = b[p + 1]!;
    // Fill bytes before a marker (bounded like everything else).
    let fill = 0;
    while (m === 0xff && p + 2 < b.length) {
      if (++fill > 64) return null;
      p++;
      m = b[p + 1]!;
    }
    if (m === 0xd9) {
      out.push(b.subarray(p, p + 2));
      return frame && scan ? Buffer.concat(out) : null;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      out.push(b.subarray(p, p + 2));
      p += 2;
      continue;
    }
    if (p + 4 > b.length) return null;
    const len = b.readUInt16BE(p + 2);
    const end = p + 2 + len;
    if (len < 2 || end > b.length) return null;
    const seg = b.subarray(p, end);
    const id = b.toString("latin1", p + 4, Math.min(end, p + 10));
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) frame = true;
    const keep =
      m === 0xe0
        ? id.startsWith("JFIF\0") && len <= 16 // no thumbnail
        : m === 0xee
          ? id.startsWith("Adobe") && len <= 14
          : !(m >= 0xe1 && m <= 0xef) && m !== 0xfe;
    if (keep) out.push(seg);
    p = end;
    if (m === 0xda) {
      if (!frame) return null;
      scan = true;
      // Entropy-coded data up to the next marker (0xFF followed by neither 0x00 nor a restart marker).
      let q = p;
      while (q + 1 < b.length) {
        if (b[q] === 0xff) {
          const n = b[q + 1]!;
          if (n !== 0x00 && !(n >= 0xd0 && n <= 0xd7) && n !== 0xff) break;
        }
        q++;
      }
      if (q + 1 >= b.length) return null;
      out.push(b.subarray(p, q));
      p = q;
    }
  }
}

/** WebP chunks kept at the top level, and inside an animation frame (`ANMF`). */
const WEBP_KEEP = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF"]);
const ANMF_KEEP = new Set(["VP8 ", "VP8L", "ALPH"]);
/** ANMF's own header before its frame chunks (X, Y, width, height, duration, flags). */
const ANMF_HEADER = 16;

type Chunk = { fourcc: string; data: Buffer };

/** RIFF chunks of `b[from, to)`: every declared length and its pad byte inside, at most `MAX_PARTS`. */
function riffChunks(b: Buffer, from: number, to: number, counter: { n: number }): Chunk[] | null {
  const chunks: Chunk[] = [];
  let p = from;
  while (p < to) {
    if (++counter.n > MAX_PARTS || p + 8 > to) return null;
    const fourcc = b.toString("latin1", p, p + 4);
    const len = b.readUInt32LE(p + 4);
    const end = p + 8 + len + (len % 2);
    if (end > to) return null;
    chunks.push({ fourcc, data: b.subarray(p + 8, p + 8 + len) });
    p = end;
  }
  return chunks;
}

const riff = (fourcc: string, data: Buffer) => {
  const h = Buffer.alloc(8);
  h.write(fourcc, 0, "latin1");
  h.writeUInt32LE(data.length, 4);
  return Buffer.concat([h, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};

/** WebP: only the image chunks — inside animation frames too; EXIF, XMP, ICC and unknown chunks dropped. */
export function stripWebp(b: Buffer): Buffer | null {
  if (b.length < 12 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP")
    return null;
  // The RIFF size must be the file's: a truncated or extended container is refused, never cut to fit.
  if (b.readUInt32LE(4) + 8 !== b.length) return null;
  const counter = { n: 0 };
  const top = riffChunks(b, 12, b.length, counter);
  if (!top) return null;
  const kept: Buffer[] = [];
  let image = false;
  for (const c of top) {
    if (!WEBP_KEEP.has(c.fourcc)) continue;
    if (c.fourcc === "VP8X") {
      if (c.data.length < 10) return null;
      const d = Buffer.from(c.data);
      // VP8X flags: ICC (0x20), EXIF (0x08), XMP (0x04) — those chunks are gone.
      d[0] = d[0]! & ~(0x20 | 0x08 | 0x04);
      kept.push(riff("VP8X", d));
    } else if (c.fourcc === "ANMF") {
      if (c.data.length < ANMF_HEADER) return null;
      const off = c.data.byteOffset - b.byteOffset;
      const inner = riffChunks(b, off + ANMF_HEADER, off + c.data.length, counter);
      if (!inner) return null;
      const frame = inner.filter((x) => ANMF_KEEP.has(x.fourcc));
      if (!frame.some((x) => x.fourcc === "VP8 " || x.fourcc === "VP8L")) return null;
      image = true;
      kept.push(
        riff(
          "ANMF",
          Buffer.concat([c.data.subarray(0, ANMF_HEADER), ...frame.map((x) => riff(x.fourcc, x.data))]),
        ),
      );
    } else {
      if (c.fourcc === "VP8 " || c.fourcc === "VP8L") image = true;
      kept.push(riff(c.fourcc, c.data));
    }
  }
  if (!image) return null;
  const body = Buffer.concat(kept);
  const head = Buffer.alloc(12);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(body.length + 4, 4);
  head.write("WEBP", 8, "latin1");
  return Buffer.concat([head, body]);
}

export function stripImage(b: Buffer, kind: "png" | "jpg" | "webp"): Buffer | null {
  try {
    return kind === "png" ? stripPng(b) : kind === "jpg" ? stripJpeg(b) : stripWebp(b);
  } catch {
    return null;
  }
}

/**
 * Width and height of an image from its header (PNG IHDR, JPEG SOFn, WebP VP8X canvas / VP8 / VP8L); null when
 * they cannot be read. A reference's real area is what an input priced per megapixel is reserved for.
 */
export function imageSize(b: Buffer, kind: "png" | "jpg" | "webp"): { width: number; height: number } | null {
  try {
    if (kind === "png") {
      if (b.length < 24 || b.toString("latin1", 12, 16) !== "IHDR") return null;
      return ok(b.readUInt32BE(16), b.readUInt32BE(20));
    }
    if (kind === "jpg") {
      let p = 2;
      for (let n = 0; n < MAX_PARTS && p + 9 < b.length; n++) {
        if (b[p] !== 0xff) return null;
        const m = b[p + 1]!;
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
          p += 2;
          continue;
        }
        const len = b.readUInt16BE(p + 2);
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
          return ok(b.readUInt16BE(p + 7), b.readUInt16BE(p + 5));
        if (m === 0xda || len < 2) return null;
        p += 2 + len;
      }
      return null;
    }
    if (b.length < 30) return null;
    const fourcc = b.toString("latin1", 12, 16);
    if (fourcc === "VP8X") return ok(b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1);
    if (fourcc === "VP8L") {
      if (b[20] !== 0x2f) return null;
      const bits = b.readUInt32LE(21);
      return ok((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    if (fourcc === "VP8 ") {
      if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
      return ok(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
    }
    return null;
  } catch {
    return null;
  }
}

const ok = (width: number, height: number) =>
  width > 0 && height > 0 && Number.isSafeInteger(width) && Number.isSafeInteger(height)
    ? { width, height }
    : null;

/**
 * The text runs in binary data, for the egress check: printable ASCII and well-formed UTF-8 sequences, at least
 * `min` characters long (the shortest secret the server checks for). A secret written into a file is such a run;
 * compressed pixel data has only short accidental ones. Null when there are more than `MAX_RUNS` or they add up to
 * more than `maxTotal` characters — the caller refuses such a file, it never goes unchecked.
 */
export function textRuns(b: Buffer, min = 8, maxTotal = 1024 * 1024): string[] | null {
  const runs: string[] = [];
  let total = 0;
  let start = -1;
  let chars = 0;
  const close = (end: number): boolean => {
    if (start >= 0 && chars >= min) {
      runs.push(b.toString("utf8", start, end));
      total += chars;
      if (runs.length > MAX_RUNS || total > maxTotal) return false;
    }
    start = -1;
    chars = 0;
    return true;
  };
  let i = 0;
  while (i < b.length) {
    const c = b[i]!;
    const n = c >= 0x20 && c <= 0x7e ? 1 : utf8Length(b, i);
    if (n === 0) {
      if (!close(i)) return null;
      i++;
      continue;
    }
    if (start < 0) start = i;
    chars++;
    i += n;
  }
  return close(b.length) ? runs : null;
}

/** The length of a well-formed multi-byte UTF-8 sequence at `i` (2–4), or 0. */
function utf8Length(b: Buffer, i: number): number {
  const c = b[i]!;
  const n = c >= 0xc2 && c <= 0xdf ? 2 : c >= 0xe0 && c <= 0xef ? 3 : c >= 0xf0 && c <= 0xf4 ? 4 : 0;
  if (!n || i + n > b.length) return 0;
  for (let k = 1; k < n; k++) if ((b[i + k]! & 0xc0) !== 0x80) return 0;
  // Overlong / surrogate / out-of-range forms.
  const c1 = b[i + 1]!;
  if (
    (c === 0xe0 && c1 < 0xa0) ||
    (c === 0xed && c1 > 0x9f) ||
    (c === 0xf0 && c1 < 0x90) ||
    (c === 0xf4 && c1 > 0x8f)
  )
    return 0;
  return n;
}
