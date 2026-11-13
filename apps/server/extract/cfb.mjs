// OLE compound file (CFB, [MS-CFB]) reader of the extractor (#23) for HWP 5.0. No dependency: the header, the
// sector allocation table (FAT, through the DIFAT), the directory and the mini stream are read here from the
// buffer — nothing is written, nothing is run. Every chain is followed with a visited set and a length bound, so
// a cycle or a pointer past the file refuses the file (`extract_invalid`) instead of looping; a directory tree
// that loops or nests too deep is refused the same way. A stream's size may not be more than the file holds.
//
// Read: version 3 (512-byte sectors) and 4 (4096-byte sectors), the mini stream for streams under the cutoff.
// Streams are found by their path from the root (`BodyText/Section0`), names as stored (case-sensitive).
import { ExtractError } from "./errors.mjs";

const SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const ENDOFCHAIN = 0xfffffffe;
const FREESECT = 0xffffffff;
const NOSTREAM = 0xffffffff;
const MAX_REGSECT = 0xfffffffa;

export const CFB_LIMITS = {
  /** Directory entries read (an HWP has tens; BinData pictures add one each). */
  maxEntries: 20_000,
  /** Storage nesting (HWP uses two levels). */
  maxDepth: 16,
};

const invalid = () => new ExtractError("extract_invalid");

/** Opens a compound file held in `buf`: `{ names, has(path), read(path) }` (`read` → the stream's bytes). */
export function openCfb(buf, limits = CFB_LIMITS) {
  if (buf.length < 512 || !buf.subarray(0, 8).equals(SIGNATURE)) throw invalid();
  const major = buf.readUInt16LE(0x1a);
  const shift = buf.readUInt16LE(0x1e);
  if (buf.readUInt16LE(0x1c) !== 0xfffe) throw invalid();
  if (!((major === 3 && shift === 9) || (major === 4 && shift === 12))) throw invalid();
  if (buf.readUInt16LE(0x20) !== 6) throw invalid();
  const size = 1 << shift;
  const numFat = buf.readUInt32LE(0x2c);
  const firstDir = buf.readUInt32LE(0x30);
  const cutoff = buf.readUInt32LE(0x38);
  const firstMiniFat = buf.readUInt32LE(0x3c);
  const numMiniFat = buf.readUInt32LE(0x40);
  let difatNext = buf.readUInt32LE(0x44);
  const numDifat = buf.readUInt32LE(0x48);
  if (cutoff !== 4096) throw invalid();
  // Sectors after the header (a last sector cut short by the writer still counts: reads are bounded below).
  const sectors = Math.ceil((buf.length - size) / size);
  if (numFat > sectors || numDifat > sectors || numMiniFat > sectors) throw invalid();

  const sectorAt = (n) => {
    if (n > MAX_REGSECT || n >= sectors) throw invalid();
    const start = (n + 1) * size;
    const s = buf.subarray(start, Math.min(buf.length, start + size));
    if (s.length < size) {
      const pad = Buffer.alloc(size);
      s.copy(pad);
      return pad;
    }
    return s;
  };

  // FAT sector numbers: 109 in the header, the rest in the DIFAT chain (last entry of each: the next DIFAT sector).
  const fatSectors = [];
  for (let i = 0; i < 109 && fatSectors.length < numFat; i++) fatSectors.push(buf.readUInt32LE(0x4c + i * 4));
  const seenDifat = new Set();
  for (let d = 0; fatSectors.length < numFat; d++) {
    if (d >= numDifat || difatNext === ENDOFCHAIN || difatNext === FREESECT || seenDifat.has(difatNext))
      throw invalid();
    seenDifat.add(difatNext);
    const s = sectorAt(difatNext);
    const per = size / 4 - 1;
    for (let i = 0; i < per && fatSectors.length < numFat; i++) fatSectors.push(s.readUInt32LE(i * 4));
    difatNext = s.readUInt32LE(per * 4);
  }
  if (new Set(fatSectors).size !== fatSectors.length) throw invalid();
  const fat = new Uint32Array(fatSectors.length * (size / 4));
  fatSectors.forEach((n, i) => {
    const s = sectorAt(n);
    for (let j = 0; j < size / 4; j++) fat[i * (size / 4) + j] = s.readUInt32LE(j * 4);
  });

  /** The sectors of a chain from `start`, each visited once, at most `bound` of them. */
  const chain = (table, start, bound) => {
    const out = [];
    const seen = new Set();
    for (let s = start; s !== ENDOFCHAIN; s = table[s]) {
      if (s >= table.length || seen.has(s) || out.length >= bound) throw invalid();
      seen.add(s);
      out.push(s);
    }
    return out;
  };
  const readChain = (start, bytes) => {
    if (bytes === 0) return Buffer.alloc(0);
    const ids = chain(fat, start, Math.min(sectors, Math.ceil(bytes / size)));
    if (ids.length * size < bytes) throw invalid();
    return Buffer.concat(ids.map(sectorAt)).subarray(0, bytes);
  };

  // Directory: a chain of 128-byte entries.
  const dirIds = chain(fat, firstDir, sectors);
  const dirCount = (dirIds.length * size) / 128;
  if (dirCount > limits.maxEntries) throw new ExtractError("extract_too_large");
  const dir = Buffer.concat(dirIds.map(sectorAt));
  const entry = (i) => {
    if (i >= dirCount) throw invalid();
    const p = i * 128;
    const nameLen = dir.readUInt16LE(p + 64);
    if (nameLen > 64 || nameLen % 2) throw invalid();
    const name = dir.toString("utf16le", p, p + Math.max(0, nameLen - 2));
    const sizeLow = dir.readUInt32LE(p + 120);
    const sizeHigh = dir.readUInt32LE(p + 124);
    // Version 3 leaves the high half undefined (writers put junk there): only version 4 uses it.
    if (major === 4 && sizeHigh !== 0) throw invalid();
    return {
      name,
      type: dir[p + 66],
      left: dir.readUInt32LE(p + 68),
      right: dir.readUInt32LE(p + 72),
      child: dir.readUInt32LE(p + 76),
      start: dir.readUInt32LE(p + 116),
      size: sizeLow,
    };
  };
  const root = entry(0);
  if (root.type !== 5) throw invalid();

  // Paths of every stream: walk each storage's sibling tree (left/right) and into child storages.
  const streams = new Map();
  const seen = new Set([0]);
  const todo = [{ id: root.child, prefix: "", depth: 1 }];
  while (todo.length) {
    const { id, prefix, depth } = todo.pop();
    if (id === NOSTREAM) continue;
    if (seen.has(id) || depth > limits.maxDepth) throw invalid();
    seen.add(id);
    const e = entry(id);
    todo.push({ id: e.left, prefix, depth }, { id: e.right, prefix, depth });
    const path = prefix + e.name;
    if (e.type === 1) todo.push({ id: e.child, prefix: path + "/", depth: depth + 1 });
    else if (e.type === 2) {
      if (streams.has(path)) throw invalid();
      if (e.size > buf.length) throw invalid();
      streams.set(path, e);
    } else if (e.type !== 0) throw invalid();
  }

  let mini;
  const miniParts = () => {
    if (mini) return mini;
    if (root.size > buf.length) throw invalid();
    const data = readChain(root.start, root.size);
    const ids = numMiniFat ? chain(fat, firstMiniFat, numMiniFat) : [];
    const miniFat = new Uint32Array(ids.length * (size / 4));
    ids.forEach((n, i) => {
      const s = sectorAt(n);
      for (let j = 0; j < size / 4; j++) miniFat[i * (size / 4) + j] = s.readUInt32LE(j * 4);
    });
    mini = { data, miniFat };
    return mini;
  };

  const read = (path) => {
    const e = streams.get(path);
    if (!e) return undefined;
    if (e.size >= cutoff) return readChain(e.start, e.size);
    if (e.size === 0) return Buffer.alloc(0);
    const { data, miniFat } = miniParts();
    const ids = chain(miniFat, e.start, Math.ceil(e.size / 64));
    if (ids.length * 64 < e.size) throw invalid();
    const parts = ids.map((n) => {
      if ((n + 1) * 64 > data.length) throw invalid();
      return data.subarray(n * 64, (n + 1) * 64);
    });
    return Buffer.concat(parts).subarray(0, e.size);
  };
  return { names: [...streams.keys()], has: (p) => streams.has(p), read };
}
