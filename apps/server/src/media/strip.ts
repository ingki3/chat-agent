/**
 * Reference images leave this server (`image_generate`'s `input_references`, #238): only what draws the picture
 * goes. Without a new dependency the image is not re-encoded; its metadata is dropped structurally instead — text,
 * EXIF, XMP, ICC profiles, comments and anything a format does not need to decode the pixels — and what is left is
 * checked for known secrets by the caller (`printableRuns`). A file that does not parse as its kind is refused
 * (null), never sent as it is.
 */

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
  let ended = false;
  while (p + 12 <= b.length) {
    const len = b.readUInt32BE(p);
    const type = b.toString("latin1", p + 4, p + 8);
    const end = p + 12 + len;
    if (!/^[A-Za-z]{4}$/.test(type) || end > b.length) return null;
    if (PNG_KEEP.has(type)) out.push(b.subarray(p, end));
    p = end;
    if (type === "IEND") {
      ended = true;
      break; // anything after IEND is dropped
    }
  }
  return ended ? Buffer.concat(out) : null;
}

/** JPEG: every APPn segment but a plain JFIF / Adobe header, and every comment, dropped; nothing after EOI. */
export function stripJpeg(b: Buffer): Buffer | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  const out: Buffer[] = [b.subarray(0, 2)];
  let p = 2;
  for (;;) {
    if (p + 2 > b.length || b[p] !== 0xff) return null;
    let m = b[p + 1]!;
    // Fill bytes before a marker.
    while (m === 0xff && p + 2 < b.length) {
      p++;
      m = b[p + 1]!;
    }
    if (m === 0xd9) {
      out.push(b.subarray(p, p + 2));
      return Buffer.concat(out);
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
    const keep =
      m === 0xe0
        ? id.startsWith("JFIF\0") && len <= 16 // no thumbnail
        : m === 0xee
          ? id.startsWith("Adobe") && len <= 14
          : !(m >= 0xe1 && m <= 0xef) && m !== 0xfe;
    if (keep) out.push(seg);
    p = end;
    if (m === 0xda) {
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

/** WebP: only the image chunks; EXIF, XMP, ICC and unknown chunks dropped (and their VP8X flags cleared). */
const WEBP_KEEP = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF"]);

export function stripWebp(b: Buffer): Buffer | null {
  if (b.length < 12 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WEBP")
    return null;
  const size = b.readUInt32LE(4);
  const total = Math.min(b.length, size + 8);
  const chunks: Buffer[] = [];
  let p = 12;
  while (p + 8 <= total) {
    const fourcc = b.toString("latin1", p, p + 4);
    const len = b.readUInt32LE(p + 4);
    const end = p + 8 + len + (len % 2);
    if (p + 8 + len > total) return null;
    if (WEBP_KEEP.has(fourcc)) {
      const c = Buffer.from(b.subarray(p, Math.min(end, total)));
      // VP8X flags: ICC (0x20), EXIF (0x08), XMP (0x04) — the chunks are gone.
      if (fourcc === "VP8X" && len >= 1) c[8] = c[8]! & ~(0x20 | 0x08 | 0x04);
      chunks.push(c);
    }
    p = end;
  }
  if (!chunks.length) return null;
  const body = Buffer.concat(chunks);
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
 * The runs of printable ASCII (at least `min` long) in binary data, for the egress check: a secret written into a
 * file is a printable run; compressed pixel data has only short accidental ones. Null when they add up to more
 * than `maxTotal` characters (not checked in full — the caller refuses such a file, it never goes unchecked).
 */
export function printableRuns(b: Buffer, min = 8, maxTotal = 4 * 1024 * 1024): string[] | null {
  const runs: string[] = [];
  let total = 0;
  let start = -1;
  for (let i = 0; i <= b.length; i++) {
    const c = i < b.length ? b[i]! : 0;
    const printable = c >= 0x20 && c <= 0x7e;
    if (printable && start < 0) start = i;
    else if (!printable && start >= 0) {
      if (i - start >= min) {
        runs.push(b.toString("latin1", start, i));
        total += i - start;
        if (total > maxTotal) return null;
      }
      start = -1;
    }
  }
  return runs;
}
