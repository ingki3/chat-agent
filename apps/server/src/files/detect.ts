import fs from "node:fs";
import type { FileKind } from "@agentlee/shared";

/**
 * Type detection of an uploaded file (#22): the kind its extension claims must be what its bytes are. Done here
 * without a dependency — every supported format has a fixed signature, and the four ZIP-based ones (DOCX, XLSX,
 * PPTX, HWPX) are told apart by the entries of the ZIP central directory. A file whose content is another format
 * (a PNG named `.pdf`, an executable named `.txt`, an HTML page named `.md`) is refused: `false`.
 *
 * Best effort, not a security boundary: a file can be two formats at once (a PDF with HTML after its header, a
 * DOCX holding an SVG). What keeps such content from running is how files are served — always a download (PNG/JPG
 * may be inline), `nosniff`, a sandboxing CSP (files/routes.ts).
 *
 * - PDF: `%PDF-` at offset 0
 * - PNG: the 8-byte signature · JPG: `FF D8 FF`
 * - HWP (5.0): an OLE compound file whose directory has a `FileHeader` stream (a Word .doc has none)
 * - DOCX / XLSX / PPTX: a ZIP with `[Content_Types].xml` and `word/document.xml` / `xl/workbook.xml` /
 *   `ppt/presentation.xml` · HWPX: a ZIP with `mimetype` and `Contents/content.hpf`. ZIP64 is not read (refused).
 * - TXT / MD / CSV: no NUL byte anywhere (binary, UTF-16), no known binary signature at the start, and not
 *   markup that a browser would run (`<html`, `<svg`, `<?xml`, `<script` … after a BOM, blanks and HTML
 *   comments, however long). Any 8-bit
 *   encoding passes (a CP949 CSV from Excel included).
 */

const HEAD = 8192;
const CHUNK = 1 << 20;

const startsWith = (b: Buffer, sig: readonly number[], at = 0) =>
  b.length >= at + sig.length && sig.every((x, i) => b[at + i] === x);
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPG = [0xff, 0xd8, 0xff];
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
/** Signatures a text file must not start with: every binary format above, and common archives and programs. */
const BINARY = [
  PNG,
  JPG,
  OLE,
  ZIP,
  [0x50, 0x4b, 0x05, 0x06], // empty ZIP
  ascii("%PDF-"),
  ascii("GIF8"),
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  ascii("MZ"), // Windows executable
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xce, 0xfa, 0xed, 0xfe], // Mach-O
  [0xca, 0xfe, 0xba, 0xbe], // fat Mach-O / Java class
  [0x1f, 0x8b], // gzip
  ascii("Rar!"),
  [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], // 7z
  ascii("RIFF"),
  ascii("BM"),
  [0x00, 0x00, 0x01, 0x00], // ico
];
/** Markup a browser would render or run, at the start of a "text" file (lower-cased, after BOM and blanks). */
const ACTIVE_MARKUP = [
  "<!doctype",
  "<html",
  "<head",
  "<body",
  "<svg",
  "<?xml",
  "<script",
  "<iframe",
  "<object",
  "<embed",
  "<meta",
  "<link",
  "<style",
  "<xsl",
];

function readHead(fd: number, size: number): Buffer {
  const b = Buffer.alloc(Math.min(HEAD, size));
  fs.readSync(fd, b, 0, b.length, 0);
  return b;
}

/** Calls `fn` on the file in 1 MiB chunks (offsets are multiples of 128); stops early when it returns true. */
function scan(fd: number, size: number, fn: (chunk: Buffer, offset: number) => boolean): boolean {
  const buf = Buffer.allocUnsafe(CHUNK);
  for (let off = 0; off < size; off += CHUNK) {
    const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - off), off);
    if (n <= 0) break;
    if (fn(buf.subarray(0, n), off)) return true;
  }
  return false;
}

const FILE_HEADER_NAME = Buffer.from("FileHeader\0", "utf16le");
/**
 * HWP 5.0: an OLE file with a `FileHeader` stream. Directory entries are 128 bytes, aligned to 128 from the start of
 * the file (sectors are 512 or 4096 bytes after a header of the same size); the name is the entry's first 64 bytes
 * (UTF-16LE) and its byte length (with the terminator) is at offset 64.
 */
function isHwp(fd: number, size: number): boolean {
  return scan(fd, size, (chunk) => {
    for (let p = 0; p + 128 <= chunk.length; p += 128)
      if (
        chunk.readUInt16LE(p + 64) === FILE_HEADER_NAME.length &&
        chunk.subarray(p, p + FILE_HEADER_NAME.length).equals(FILE_HEADER_NAME)
      )
        return true;
    return false;
  });
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const MAX_ENTRIES = 20_000;
/** Names in a ZIP's central directory; undefined when it cannot be read (damaged, ZIP64, not a ZIP). */
export function zipEntries(fd: number, size: number): Set<string> | undefined {
  if (size < 22) return undefined;
  // End of central directory: 22 bytes plus a comment of up to 65535.
  const tailLen = Math.min(size, 22 + 65_535);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);
  let e = -1;
  for (let p = tailLen - 22; p >= 0; p--)
    if (tail.readUInt32LE(p) === EOCD) {
      e = p;
      break;
    }
  if (e < 0) return undefined;
  const count = tail.readUInt16LE(e + 10);
  const cdSize = tail.readUInt32LE(e + 12);
  const cdOffset = tail.readUInt32LE(e + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return undefined; // ZIP64
  if (count > MAX_ENTRIES || cdOffset + cdSize > size) return undefined;
  const cd = Buffer.alloc(cdSize);
  fs.readSync(fd, cd, 0, cdSize, cdOffset);
  const names = new Set<string>();
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL) return undefined;
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    if (p + 46 + nameLen > cd.length) return undefined;
    names.add(cd.subarray(p + 46, p + 46 + nameLen).toString("utf8"));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

const ZIP_KINDS: Partial<Record<FileKind, readonly string[]>> = {
  docx: ["[Content_Types].xml", "word/document.xml"],
  xlsx: ["[Content_Types].xml", "xl/workbook.xml"],
  pptx: ["[Content_Types].xml", "ppt/presentation.xml"],
  hwpx: ["mimetype", "Contents/content.hpf"],
};

const BLANK = new Set([0x20, 0x09, 0x0a, 0x0d, 0x0c]);
/**
 * The first 32 bytes (lower-cased) after a BOM, blanks and HTML comments — however long those are: the whole file
 * is walked if need be (review #102: 8 KiB of blanks or a leading `<!-- -->` hid markup from a head-only check).
 */
function leadAfterBlanks(fd: number, size: number): string {
  const buf = Buffer.allocUnsafe(CHUNK);
  let base = 0;
  let len = 0;
  const at = (p: number) => {
    if (p < base || p >= base + len) {
      base = p;
      len = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - p), p);
    }
    return buf[p - base]!;
  };
  let p = size >= 3 && at(0) === 0xef && at(1) === 0xbb && at(2) === 0xbf ? 3 : 0;
  for (;;) {
    while (p < size && BLANK.has(at(p))) p++;
    // `<!--` … `-->`
    if (p + 4 <= size && at(p) === 0x3c && at(p + 1) === 0x21 && at(p + 2) === 0x2d && at(p + 3) === 0x2d) {
      p += 4;
      while (p + 3 <= size && !(at(p) === 0x2d && at(p + 1) === 0x2d && at(p + 2) === 0x3e)) p++;
      p += 3;
      continue;
    }
    break;
  }
  const out = Buffer.alloc(Math.max(0, Math.min(32, size - p)));
  if (out.length) fs.readSync(fd, out, 0, out.length, p);
  return out.toString("latin1").toLowerCase();
}

function isText(fd: number, size: number, head: Buffer): boolean {
  if (BINARY.some((sig) => startsWith(head, sig))) return false;
  const lead = leadAfterBlanks(fd, size);
  if (ACTIVE_MARKUP.some((m) => lead.startsWith(m))) return false;
  return !scan(fd, size, (chunk) => chunk.includes(0));
}

/**
 * True when the file at `file` really is `claimed`. The file is opened without following a link and must be a
 * regular file.
 */
export function contentMatches(file: string, claimed: FileKind): boolean {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size === 0) return false;
    const size = st.size;
    const head = readHead(fd, size);
    switch (claimed) {
      case "pdf":
        // At the very start (review #102: anywhere in the first 1024 bytes let an HTML page with `%PDF-` pass).
        return startsWith(head, ascii("%PDF-"));
      case "png":
        return startsWith(head, PNG);
      case "jpg":
        return startsWith(head, JPG);
      case "hwp":
        return startsWith(head, OLE) && isHwp(fd, size);
      case "docx":
      case "xlsx":
      case "pptx":
      case "hwpx": {
        if (!startsWith(head, ZIP)) return false;
        const names = zipEntries(fd, size);
        return !!names && ZIP_KINDS[claimed]!.every((n) => names.has(n));
      }
      case "txt":
      case "md":
      case "csv":
        return isText(fd, size, head);
    }
  } finally {
    fs.closeSync(fd);
  }
}
