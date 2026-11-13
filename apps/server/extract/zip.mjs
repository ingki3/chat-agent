// ZIP reader of the extractor (#48) for the Office formats (DOCX, XLSX, PPTX). No dependency: the central
// directory is read here and each entry is inflated by Node's zlib with a hard output limit — the number of bytes
// an entry *says* it holds is checked before anything is inflated, and the inflater itself stops at that number,
// so an entry whose header lies (a zip bomb that claims 1 KB) cannot produce more. Nothing is ever written to
// disk, and an entry name that could point outside the archive (`../`, `/abs`, `C:`, `\`) refuses the whole file
// (zip slip): an archive that holds one is not a document we read.
//
// Refused: ZIP64, multi-disk archives, encrypted entries, methods other than stored/deflate, duplicate names,
// entries that overlap the central directory or each other's bounds, sizes or CRC-32 that do not match.
import zlib from "node:zlib";
import { ExtractError } from "./errors.mjs";

export const ZIP_LIMITS = {
  /** Entries in the central directory. */
  maxEntries: 5000,
  /** Bytes one entry may hold once inflated. */
  maxEntryBytes: 64 * 1024 * 1024,
  /** Bytes all entries read from one archive may hold together once inflated. */
  maxTotalBytes: 256 * 1024 * 1024,
  /** Inflated / compressed for entries above 1 MiB (an ordinary XML part compresses about 10:1). */
  maxRatio: 400,
};

const EOCD = 0x06054b50;
const CEN = 0x02014b50;
const LOC = 0x04034b50;

/** An entry name that stays inside the archive: relative, `/`-separated, no `..`, no NUL, no drive letter. */
export function safeEntryName(name) {
  if (!name || name.length > 1024) return false;
  if (name.includes("\0") || name.includes("\\")) return false;
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) return false;
  return name.split("/").every((seg) => seg !== ".." && seg !== ".");
}

/**
 * Resolves a part reference (an OOXML relationship target) against the folder of the part that names it, the way
 * OPC does: `/x/y.xml` from the package root, `../y.xml` one folder up. A reference that leaves the package
 * (more `..` than folders, a scheme, a NUL) throws `extract_path_escape`.
 */
export function resolvePart(baseDir, target) {
  let t = String(target ?? "");
  try {
    t = decodeURIComponent(t);
  } catch {
    throw new ExtractError("extract_path_escape");
  }
  if (!t || t.includes("\0") || t.includes("\\") || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(t))
    throw new ExtractError("extract_path_escape");
  const parts = t.startsWith("/") ? [] : baseDir.split("/").filter(Boolean);
  for (const seg of t.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) throw new ExtractError("extract_path_escape");
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Opens an archive held in `buf`. Returns `{ names, has(name), read(name) }`; `read` inflates one entry (checked
 * sizes, CRC) and counts it against the archive's total. Every refusal is an `ExtractError` with a fixed code.
 */
export function openZip(buf, limits = ZIP_LIMITS) {
  if (buf.length < 22) throw new ExtractError("extract_zip_invalid");
  // The end record is in the last 64 KiB + 22 bytes (its comment is at most 65535 bytes).
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--)
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new ExtractError("extract_zip_invalid");
  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const countHere = buf.readUInt16LE(eocd + 8);
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  // ZIP64 (0xFFFF / 0xFFFFFFFF markers) and spanned archives are not read.
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
    throw new ExtractError("extract_zip_invalid");
  if (disk !== 0 || cdDisk !== 0 || countHere !== count) throw new ExtractError("extract_zip_invalid");
  if (count > limits.maxEntries) throw new ExtractError("extract_too_large");
  if (cdOffset + cdSize > eocd) throw new ExtractError("extract_zip_invalid");

  const entries = new Map();
  let declared = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== CEN) throw new ExtractError("extract_zip_invalid");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const end = p + 46 + nameLen + extraLen + commentLen;
    if (end > eocd) throw new ExtractError("extract_zip_invalid");
    const raw = buf.subarray(p + 46, p + 46 + nameLen);
    // Bit 11: UTF-8 names; otherwise CP437 — read as latin1 (the names we look for are ASCII).
    const name = raw.toString(flags & 0x800 ? "utf8" : "latin1");
    p = end;
    if (!safeEntryName(name)) throw new ExtractError("extract_path_escape");
    if (entries.has(name)) throw new ExtractError("extract_zip_invalid");
    if (flags & 0x1) throw new ExtractError("extract_zip_invalid"); // encrypted
    if (method !== 0 && method !== 8) throw new ExtractError("extract_zip_invalid");
    if (csize === 0xffffffff || usize === 0xffffffff || local === 0xffffffff)
      throw new ExtractError("extract_zip_invalid");
    if (method === 0 && csize !== usize) throw new ExtractError("extract_zip_invalid");
    if (usize > limits.maxEntryBytes) throw new ExtractError("extract_too_large");
    if (usize > 1024 * 1024 && usize / Math.max(1, csize) > limits.maxRatio)
      throw new ExtractError("extract_too_large");
    declared += usize;
    if (local + 30 > cdOffset) throw new ExtractError("extract_zip_invalid");
    entries.set(name, { method, crc, csize, usize, local });
  }
  if (declared > limits.maxTotalBytes) throw new ExtractError("extract_too_large");

  let total = 0;
  const read = (name) => {
    const e = entries.get(name);
    if (!e) return undefined;
    if (buf.readUInt32LE(e.local) !== LOC) throw new ExtractError("extract_zip_invalid");
    const lName = buf.readUInt16LE(e.local + 26);
    const lExtra = buf.readUInt16LE(e.local + 28);
    const start = e.local + 30 + lName + lExtra;
    if (start + e.csize > cdOffset) throw new ExtractError("extract_zip_invalid");
    const data = buf.subarray(start, start + e.csize);
    let out;
    if (e.method === 0) out = data;
    else {
      try {
        // The inflater stops at the declared size (+1 to see that there is more): a header that lies cannot
        // make it produce more than what was checked above.
        out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, e.usize + 1) });
      } catch (err) {
        if (err instanceof RangeError || err?.code === "ERR_BUFFER_TOO_LARGE")
          throw new ExtractError("extract_too_large");
        throw new ExtractError("extract_zip_invalid");
      }
    }
    if (out.length !== e.usize)
      throw new ExtractError(out.length > e.usize ? "extract_too_large" : "extract_zip_invalid");
    if (zlib.crc32(out) >>> 0 !== e.crc) throw new ExtractError("extract_zip_invalid");
    total += out.length;
    if (total > limits.maxTotalBytes) throw new ExtractError("extract_too_large");
    return out;
  };
  return { names: [...entries.keys()], has: (n) => entries.has(n), read };
}
