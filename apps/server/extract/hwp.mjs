// Hangul documents (#23, PRD FR-4.4): HWP 5.0 (an OLE compound file of zlib record streams — cfb.mjs) and HWPX
// (OWPML: a ZIP of XML parts — zip.mjs, xml.mjs). No dependency, nothing is run: only the body text, tables and
// notes are read. Both formats go through one builder, so they produce the same units:
//
// - a body paragraph (not empty): `paragraph N`, counted from 1 over the whole document (all sections);
// - a row of a top-level table: `table T · row R` — tables counted from 1 in document order, the row and each
//   cell's column (a mark) from the cell's own address, so a merged cell is in its first row and column. Only when
//   every address and span fits the table's size without overlap; otherwise the table is one unit `table T` (no
//   row or column claimed);
// - a footnote / endnote: its own unit at its place in the reading order, with the place of the block it is
//   anchored in and `footnote` / `endnote` — the number the document stores for it (none claimed when none).
// Units come in reading order: a paragraph with a note, a table or a left-out part inside is split around it
// (its pieces keep the paragraph's locator, marked `split`). Text in nested tables, text boxes and table captions
// joins the cell or paragraph that holds it, where it is. Headers, footers and hidden comments are left out (like
// DOCX headers) — each goes out as a hidden unit at its place, which the server scrubs with the kept text and
// never stores (review #120). In an OWPML `hp:switch` only `hp:default` is read — recursively, and inside left-out
// parts too; an `hp:case` is content for other renderers and is not read at all, like an unread picture (review
// #120 4차, docs/decisions/hwp.md). No page
// numbers: a stable page mapping is not implemented (pages come from layout).
//
// Refused with a fixed code and no text: password, DRM and certificate encryption (`extract_encrypted`), HWP
// distribution documents (`extract_distribution`), HWP versions other than 5 (`extract_unsupported`). HWPX parts
// listed as encrypted in `META-INF/manifest.xml` refuse the file (`extract_encrypted`).
import zlib from "node:zlib";
import { openCfb } from "./cfb.mjs";
import { ExtractError } from "./errors.mjs";
import { parseXml, xmlText } from "./xml.mjs";
import { resolvePart } from "./zip.mjs";

export const HWP_LIMITS = {
  /** Bytes one section stream may hold once inflated. */
  maxStreamBytes: 64 * 1024 * 1024,
  /** Bytes all section streams may hold together once inflated. */
  maxTotalBytes: 256 * 1024 * 1024,
  /** Records in one section stream. */
  maxRecords: 4_000_000,
  /** Record nesting (levels) and builder nesting (paragraph in a cell in a table in a paragraph …). */
  maxDepth: 256,
  /** Sections read. */
  maxSections: 1000,
};

/** The document is cut off here: a limit of `Segments` was reached (it said so — `truncated`, `endsEarly`). */
class Stop extends Error {}

// ---- the builder (both formats) ------------------------------------------------------------------------------

/**
 * Text in reading order. Items: strings, and markers where something else comes in the reading order — a part
 * that is left out (`{ hidden }`: a header, a footer, a hidden comment), a note (`{ note }`) or a
 * top-level table (`{ table }`). Blocks (a paragraph of a cell, a text box) are joined with a line break.
 */
class Seq {
  constructor() {
    this.items = [];
    this.any = false;
    this.nl = false;
  }

  text(s) {
    if (!s) return;
    if (this.nl && s.trim()) {
      this.items.push("\n");
      this.nl = false;
    }
    this.items.push(s);
    if (s.trim()) this.any = true;
  }

  mark(m) {
    this.items.push(m);
  }

  /** Another block (its markers kept), on a line of its own. */
  block(other) {
    if (!other.any) {
      for (const x of other.items) if (typeof x !== "string") this.items.push(x);
      return;
    }
    if (this.any) this.items.push("\n");
    this.items.push(...other.items);
    this.any = true;
    this.nl = true;
  }

  /** All its text, markers included (a left-out part's whole text). */
  flat() {
    return this.items
      .map((x) =>
        typeof x === "string"
          ? x
          : x.hidden !== undefined
            ? `\n${x.hidden}\n`
            : x.note
              ? `\n${x.note.seq.flat()}\n`
              : x.table
                ? `\n${x.table.cells.map((c) => c.seq.flat()).join("\n")}\n`
                : "",
      )
      .join("");
  }
}

/**
 * Turns a stream of paragraph / control / list events into units, **in reading order**. Frames: `para` (a
 * paragraph being read) and `ctrl` (a table, a note, a part to leave out, or anything else whose text joins the
 * paragraph that holds it — `inline`). A control's lists hold paragraphs: a top-level table's lists are its cells
 * (after the table body — a caption list comes before it and is inline), a note's list its text. An HWP
 * paragraph's text is split at its control characters, and each control's text comes at its own one.
 *
 * A left-out part is not dropped silently: its text goes out as a **hidden** unit at its place in the reading
 * order (`Segments.hidden`). The server scrubs known secrets over kept and hidden text together, in this order,
 * and stores only the kept units (files/extract.ts `save`, review #120) — so a secret split between a kept unit
 * and a left-out part, either way round, is found whole.
 */
export class HwpBuilder {
  constructor(out, limits = HWP_LIMITS) {
    this.out = out;
    this.limits = limits;
    this.stack = [];
    this.block = 0;
    this.paragraph = 0;
    this.tables = 0;
  }

  push(f) {
    if (this.stack.length >= this.limits.maxDepth) throw new ExtractError("extract_invalid");
    this.stack.push(f);
  }

  /** The innermost frame of a type (from the top). */
  find(pred) {
    for (let i = this.stack.length - 1; i >= 0; i--) if (pred(this.stack[i])) return this.stack[i];
    return undefined;
  }

  openPara() {
    this.push({ type: "para", seq: new Seq(), pending: null, next: 0 });
  }

  text(s) {
    const top = this.stack.at(-1);
    if (top?.type === "para") top.seq.text(s);
  }

  /** HWP: the paragraph's text, split at its extended control characters (one more piece than controls). */
  paraPieces(pieces) {
    const top = this.stack.at(-1);
    if (top?.type !== "para") return;
    top.pending = pieces;
    top.next = 0;
  }

  /** HWP: the text up to the paragraph's next control (or all that is left). */
  flushPending(p, all = false) {
    if (!p.pending) return;
    const until = all ? p.pending.length : Math.min(p.pending.length, p.next + 1);
    for (; p.next < until; p.next++) p.seq.text(p.pending[p.next]);
  }

  /** A marker in the innermost paragraph being read — or, between paragraphs, out right away. */
  place(m) {
    const p = this.find((f) => f.type === "para");
    if (p) return p.seq.mark(m);
    if (m.hidden !== undefined) this.out.hidden(m.hidden);
    else if (m.note) this.emitSeq({ kind: "paragraph" }, m.note.seq);
  }

  /** Text that is left out here (a header, a hidden comment …): hidden, at this place. */
  hidden(text) {
    if (text.trim()) this.place({ hidden: text });
  }

  closePara() {
    const p = this.stack.pop();
    if (p?.type !== "para") throw new ExtractError("extract_invalid");
    this.flushPending(p, true);
    const parent = this.stack.at(-1);
    if (!parent) return this.emitBody(p);
    if (parent.type !== "ctrl") throw new ExtractError("extract_invalid");
    switch (parent.kind) {
      case "skip":
        parent.seq.block(p.seq);
        return;
      case "note":
        parent.note.seq.block(p.seq);
        return;
      case "table":
        if (parent.cell) {
          parent.cell.seq.block(p.seq);
          return;
        }
      // A caption (before the table body) joins the paragraph that holds the table.
      // falls through
      default: {
        const holder = this.holderOf(parent);
        if (holder) holder.seq.block(p.seq);
        else this.place({ hidden: p.seq.flat() });
      }
    }
  }

  /** The paragraph that holds a control frame. */
  holderOf(ctrl) {
    const i = this.stack.indexOf(ctrl);
    for (let j = i - 1; j >= 0; j--) if (this.stack[j].type === "para") return this.stack[j];
    return undefined;
  }

  /**
   * `kind`: `table`, `footnote`, `endnote`, `skip` (left out: hidden) or `inline`. A table is top-level only right
   * inside a body paragraph (deeper ones are inline). `o.number`: a note's own number as the document stores it
   * (none claimed when it is not a positive integer); `o.rows` / `o.cols`: a table's size.
   */
  openCtrl(kind, o = {}) {
    const top = this.stack.at(-1);
    if (top?.type === "para") this.flushPending(top);
    let k = kind;
    if (k === "table" && !(this.stack.length === 1 && this.stack[0].type === "para")) k = "inline";
    const f = { type: "ctrl", kind: k, cell: null, body: false };
    if (k === "table") {
      f.table = ++this.tables;
      f.cells = [];
      f.rows = o.rows;
      f.cols = o.cols;
    } else if (k === "footnote" || k === "endnote") {
      f.kind = "note";
      const no = Number(o.number);
      f.note = { kind: k, no: Number.isInteger(no) && no > 0 && no < 1e6 ? no : undefined, seq: new Seq() };
    } else if (k === "skip") f.seq = new Seq();
    this.push(f);
  }

  /** The table body was read (HWP): lists after it are cells; its size. */
  tableBody(rows, cols) {
    const top = this.stack.at(-1);
    if (top?.type !== "ctrl") return;
    top.body = true;
    if (top.kind === "table") {
      top.rows = rows;
      top.cols = cols;
    }
  }

  /** A list starts in the innermost control: a cell of a top-level table (after its body), or text. */
  openList({ cell = false } = {}) {
    const ctrl = this.find((f) => f.type === "ctrl");
    if (!ctrl) return;
    ctrl.cell = null;
    if (ctrl.kind === "table" && (cell || ctrl.body)) {
      ctrl.cell = { row: NaN, col: NaN, rowSpan: 1, colSpan: 1, seq: new Seq() };
      ctrl.cells.push(ctrl.cell);
    }
  }

  /** The current cell's address (0-based, as stored) and span — checked against the table when it is emitted. */
  cellAddress(row, col, rowSpan, colSpan) {
    const ctrl = this.find((f) => f.type === "ctrl");
    if (!ctrl?.cell) return;
    Object.assign(ctrl.cell, { row, col });
    if (rowSpan !== undefined) Object.assign(ctrl.cell, { rowSpan, colSpan });
  }

  cellSpan(rowSpan, colSpan) {
    const ctrl = this.find((f) => f.type === "ctrl");
    if (!ctrl?.cell) return;
    Object.assign(ctrl.cell, { rowSpan, colSpan });
  }

  closeList() {
    const ctrl = this.find((f) => f.type === "ctrl");
    if (ctrl) ctrl.cell = null;
  }

  closeCtrl() {
    const f = this.stack.pop();
    if (f?.type !== "ctrl") throw new ExtractError("extract_invalid");
    // Each at its place in the paragraph that holds it (a top-level table: the body paragraph).
    if (f.kind === "skip") this.hidden(f.seq.flat());
    else if (f.kind === "table") this.place({ table: f });
    else if (f.kind === "note") this.place({ note: f.note });
  }

  add(loc, text, marks) {
    this.block++;
    if (!this.out.add(this.block, loc, text, marks)) throw new Stop();
  }

  noteLoc(base, n) {
    return n.no ? { ...base, [n.kind]: n.no } : base;
  }

  /**
   * A sequence in reading order: its text pieces as units with `loc` (marked `split` when there is more than one —
   * no exact range inside the whole is claimed then), its markers where they are: hidden text, notes (anchored at
   * `loc`), tables.
   */
  emitSeq(loc, seq) {
    const parts = [""];
    for (const x of seq.items) {
      if (typeof x === "string") parts[parts.length - 1] += x;
      else parts.push(x, "");
    }
    const texts = parts.filter((x) => typeof x === "string" && x.trim()).length;
    const own = texts > 1 ? { ...loc, split: true } : loc;
    for (const x of parts) {
      if (typeof x === "string") {
        if (x.trim()) this.add(own, x.trim());
      } else this.emitMarker(x, loc);
    }
  }

  emitMarker(x, anchor) {
    if (x.hidden !== undefined) this.out.hidden(x.hidden);
    else if (x.note) this.emitSeq(this.noteLoc(anchor, x.note), x.note.seq);
    else if (x.table) this.emitTable(x.table);
  }

  emitBody(p) {
    let here = { kind: "paragraph" };
    if (p.seq.any) {
      this.paragraph++;
      here = { kind: "paragraph", paragraph: this.paragraph };
    }
    this.emitSeq(here, p.seq);
  }

  /**
   * Whether every cell's address and span fit the table (inside its size, no two cells on one place): only then
   * are rows and columns claimed (review #120 — a cell at row 65535 was "row 1").
   */
  static consistent(t) {
    const int = (x, min) => Number.isInteger(x) && x >= min && x < 65535;
    if (!int(t.rows, 1) || !int(t.cols, 1) || t.rows * t.cols > 1_000_000) return false;
    const taken = new Uint8Array(t.rows * t.cols);
    for (const c of t.cells) {
      if (!int(c.row, 0) || !int(c.col, 0) || !int(c.rowSpan, 1) || !int(c.colSpan, 1)) return false;
      if (c.row + c.rowSpan > t.rows || c.col + c.colSpan > t.cols) return false;
      for (let r = c.row; r < c.row + c.rowSpan; r++)
        for (let k = c.col; k < c.col + c.colSpan; k++) {
          if (taken[r * t.cols + k]) return false;
          taken[r * t.cols + k] = 1;
        }
    }
    return true;
  }

  emitTable(t) {
    if (!HwpBuilder.consistent(t)) {
      // The places cannot be trusted: the table as one unit, its cells in reading order, no row or column claimed.
      const seq = new Seq();
      for (const c of t.cells) seq.block(c.seq);
      this.emitSeq({ kind: "table", table: t.table }, seq);
      return;
    }
    const rows = new Map();
    for (const c of t.cells) {
      if (!rows.has(c.row)) rows.set(c.row, []);
      rows.get(c.row).push(c);
    }
    for (const row of [...rows.keys()].sort((a, b) => a - b))
      this.emitRow(
        { kind: "table", table: t.table, row: row + 1 },
        rows.get(row).sort((a, b) => a.col - b.col),
      );
  }

  /**
   * One row in reading order: its cells joined with " | ", a mark per cell (its column); a marker in a cell (a
   * left-out part, a note) comes where it is, the row's text split around it (pieces marked `split`).
   */
  emitRow(loc, cells) {
    const parts = [];
    let piece = { text: "", marks: [] };
    for (const c of cells) {
      let start = -1;
      const close = () => {
        if (start < 0) return;
        piece.text = piece.text.trimEnd();
        if (piece.text.length > start) piece.marks.push([start, piece.text.length, { col: c.col + 1 }]);
        start = -1;
      };
      for (const x of c.seq.items) {
        if (typeof x === "string") {
          const s = start < 0 ? x.trimStart() : x;
          if (!s) continue;
          if (start < 0) {
            if (piece.text) piece.text += " | ";
            start = piece.text.length;
          }
          piece.text += s;
        } else {
          close();
          parts.push(piece, x);
          piece = { text: "", marks: [] };
        }
      }
      close();
    }
    parts.push(piece);
    const texts = parts.filter((x) => x.text?.trim()).length;
    const own = texts > 1 ? { ...loc, split: true } : loc;
    for (const x of parts) {
      if (x.text !== undefined) {
        if (x.text.trim()) this.add(own, x.text, x.marks.length ? x.marks : undefined);
      } else this.emitMarker(x, loc);
    }
  }

  /** Before reading more input: stop when a limit is reached (`truncated`, the last unit `endsEarly`). */
  more() {
    if (this.out.stopHere()) throw new Stop();
  }
}

/** Runs `fn` with a builder; a `Stop` (a limit) ends the document there. */
function build(out, limits, fn) {
  const b = new HwpBuilder(out, limits);
  try {
    fn(b);
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
  }
  return { units: b.block };
}

// ---- HWP 5.0 -------------------------------------------------------------------------------------------------

const TAG = { PARA_HEADER: 66, PARA_TEXT: 67, CTRL_HEADER: 71, LIST_HEADER: 72, TABLE: 77 };
/** FileHeader properties (HWP 5.0 spec, table 3). */
const PROP = {
  compressed: 1 << 0,
  password: 1 << 1,
  distribution: 1 << 2,
  drm: 1 << 4,
  certEncrypted: 1 << 8,
  certDrm: 1 << 10,
  privacy: 1 << 13,
};
const ENCRYPTED = PROP.password | PROP.drm | PROP.certEncrypted | PROP.certDrm | PROP.privacy;
const SIGNATURE = "HWP Document File";

/** A control's 4-character id (`tbl `, `fn  ` …), stored as a little-endian UINT32 of the big-endian chars. */
const ctrlId = (v) => String.fromCharCode((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
const CTRL_KIND = {
  "tbl ": "table",
  "fn  ": "footnote",
  "en  ": "endnote",
  head: "skip",
  foot: "skip",
  tcmt: "skip",
};

/** Control characters that take one code unit (the rest of 0–31 take eight: an inline or extended control). */
const CHAR_CONTROLS = new Set([0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31]);
/** Extended controls: each has a control (CTRL_HEADER) of its own, in the same order (HWP 5.0 spec, table 6). */
const EXTENDED_CONTROLS = new Set([1, 2, 3, 11, 12, 14, 15, 16, 17, 18, 21, 22, 23]);

const loneSurrogates = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * The text of a PARA_TEXT record, split at its extended control characters (one more piece than controls): what
 * comes before each control, so a control's own text (or the cut of a skipped one) goes exactly there. UTF-16LE;
 * tab, line break, hyphen and fixed spaces kept; lone surrogates (half a character) dropped.
 */
export function paraPieces(data) {
  const pieces = [""];
  const n = data.length >> 1;
  for (let i = 0; i < n;) {
    const c = data.readUInt16LE(i * 2);
    if (c >= 32) {
      pieces[pieces.length - 1] += String.fromCharCode(c);
      i++;
    } else if (CHAR_CONTROLS.has(c)) {
      const t = c === 10 ? "\n" : c === 24 ? "-" : c === 30 || c === 31 ? " " : "";
      pieces[pieces.length - 1] += t;
      i++;
    } else {
      if (c === 9) pieces[pieces.length - 1] += "\t";
      else if (EXTENDED_CONTROLS.has(c)) pieces.push("");
      i += 8;
    }
  }
  return pieces.map((p) => p.replace(loneSurrogates, ""));
}

/** The whole text of a PARA_TEXT record. */
export const paraText = (data) => paraPieces(data).join("");

function inflate(data, limit) {
  const opts = { maxOutputLength: Math.max(1, limit) };
  try {
    return zlib.inflateRawSync(data, opts);
  } catch (err) {
    if (err instanceof RangeError || err?.code === "ERR_BUFFER_TOO_LARGE")
      throw new ExtractError("extract_too_large");
    throw new ExtractError("extract_invalid");
  }
}

/** The records of a section stream into the builder (levels → frames). */
function sectionRecords(data, b, limits) {
  const open = []; // { level, close }
  const closeTo = (level) => {
    while (open.length && open.at(-1).level >= level) open.pop().close?.();
  };
  let p = 0;
  let count = 0;
  while (p < data.length) {
    if (p + 4 > data.length) throw new ExtractError("extract_invalid");
    const h = data.readUInt32LE(p);
    p += 4;
    const tag = h & 0x3ff;
    const level = (h >>> 10) & 0x3ff;
    let size = h >>> 20;
    if (size === 0xfff) {
      if (p + 4 > data.length) throw new ExtractError("extract_invalid");
      size = data.readUInt32LE(p);
      p += 4;
    }
    if (p + size > data.length) throw new ExtractError("extract_invalid");
    if (++count > limits.maxRecords) throw new ExtractError("extract_too_large");
    if (level > limits.maxDepth) throw new ExtractError("extract_invalid");
    const body = data.subarray(p, p + size);
    p += size;
    closeTo(level);
    const parent = open.at(-1);
    let close = null;
    if (tag === TAG.PARA_HEADER) {
      // A body paragraph closes: before the next one, see whether a limit was reached.
      if (level === 0) b.more();
      b.openPara();
      close = () => b.closePara();
    } else if (tag === TAG.PARA_TEXT && parent?.tag === TAG.PARA_HEADER) b.paraPieces(paraPieces(body));
    else if (tag === TAG.CTRL_HEADER && parent?.tag === TAG.PARA_HEADER) {
      const id = body.length >= 4 ? ctrlId(body.readUInt32LE(0)) : "";
      const kind = CTRL_KIND[id] ?? "inline";
      // A note: UINT32 its number as the document numbers it (pyhwp `Note.number`).
      const number =
        (kind === "footnote" || kind === "endnote") && body.length >= 8 ? body.readUInt32LE(4) : 0;
      b.openCtrl(kind, { number });
      close = () => b.closeCtrl();
    } else if (tag === TAG.TABLE && parent?.tag === TAG.CTRL_HEADER) {
      // UINT32 properties, UINT16 rows, UINT16 columns …
      b.tableBody(
        body.length >= 8 ? body.readUInt16LE(4) : NaN,
        body.length >= 8 ? body.readUInt16LE(6) : NaN,
      );
    } else if (tag === TAG.LIST_HEADER && parent && parent.tag !== TAG.PARA_HEADER) {
      // UINT16 paragraphs, UINT16, UINT32 flags; a table cell then: UINT16 column, row, column span, row span.
      b.openList();
      if (body.length >= 16)
        b.cellAddress(
          body.readUInt16LE(10),
          body.readUInt16LE(8),
          body.readUInt16LE(14),
          body.readUInt16LE(12),
        );
    }
    open.push({ level, tag, close });
  }
  closeTo(0);
}

/** One inflated section stream on its own (tests). */
export function hwpSection(data, out, limits = HWP_LIMITS) {
  return build(out, limits, (b) => sectionRecords(data, b, limits));
}

/** HWP 5.0: FileHeader checks, then `BodyText/Section<n>` in order. */
export function hwp(buf, out, limits = HWP_LIMITS) {
  const cfb = openCfb(buf, limits.cfb);
  const fh = cfb.read("FileHeader");
  if (!fh || fh.length < 40 || fh.toString("latin1", 0, SIGNATURE.length) !== SIGNATURE)
    throw new ExtractError("extract_invalid");
  const version = fh.readUInt32LE(32);
  if (version >>> 24 !== 5) throw new ExtractError("extract_unsupported");
  const props = fh.readUInt32LE(36);
  if (props & ENCRYPTED) throw new ExtractError("extract_encrypted");
  const sections = (prefix) =>
    cfb.names
      .map((n) => ({ n, m: new RegExp(`^${prefix}/Section(\\d{1,4})$`).exec(n) }))
      .filter((x) => x.m)
      .sort((a, b) => Number(a.m[1]) - Number(b.m[1]))
      .map((x) => x.n);
  const body = sections("BodyText");
  // A distribution document keeps its text encrypted in ViewText (the header says so; some writers only that).
  if (props & PROP.distribution || (!body.length && sections("ViewText").length))
    throw new ExtractError("extract_distribution");
  if (!body.length) throw new ExtractError("extract_invalid");
  if (body.length > limits.maxSections) throw new ExtractError("extract_too_large");
  let total = 0;
  return build(out, limits, (b) => {
    for (const name of body) {
      b.more();
      const raw = cfb.read(name);
      const data = props & PROP.compressed ? inflate(raw, limits.maxStreamBytes + 1) : raw;
      if (data.length > limits.maxStreamBytes) throw new ExtractError("extract_too_large");
      total += data.length;
      if (total > limits.maxTotalBytes) throw new ExtractError("extract_too_large");
      sectionRecords(data, b, limits);
    }
  });
}

// ---- HWPX (OWPML) --------------------------------------------------------------------------------------------

const optionalPart = (zip, name) => {
  const b = zip.read(name);
  return b ? xmlText(b) : undefined;
};

/** Section parts in reading order: the package's spine (`Contents/content.hpf`), or `section<n>.xml` by number. */
function hwpxSections(zip) {
  const hpf = optionalPart(zip, "Contents/content.hpf");
  if (!hpf) throw new ExtractError("extract_invalid");
  const items = new Map();
  const spine = [];
  parseXml(hpf, {
    open(n, a) {
      if (n === "item" && a.id && a.href) items.set(a.id, a.href);
      else if (n === "itemref" && a.idref) spine.push(a.idref);
    },
  });
  const isSection = (p) => /(^|\/)section\d{1,4}\.xml$/i.test(p);
  const resolve = (href) => {
    // Hancom writes hrefs from the package root ("Contents/section0.xml"); OPF reads them from the hpf's folder.
    const fromRoot = resolvePart("", href);
    return zip.has(fromRoot) ? fromRoot : resolvePart("Contents", href);
  };
  const out = [];
  for (const id of spine) {
    const href = items.get(id);
    if (!href) continue;
    const p = resolve(href);
    if (isSection(p) && zip.has(p) && !out.includes(p)) out.push(p);
  }
  if (out.length) return out;
  return zip.names
    .filter((n) => /^Contents\/section\d{1,4}\.xml$/i.test(n))
    .sort((a, b) => Number(/(\d+)\.xml$/i.exec(a)[1]) - Number(/(\d+)\.xml$/i.exec(b)[1]));
}

/** An entry of `META-INF/manifest.xml` with encryption data: the document has a password. */
function hwpxEncrypted(zip) {
  const xml = optionalPart(zip, "META-INF/manifest.xml");
  if (!xml) return false;
  let found = false;
  parseXml(xml, {
    open(n) {
      if (n === "encryption-data") found = true;
    },
  });
  return found;
}

const SKIP = new Set(["header", "footer", "hiddenComment"]);
const NOTE = { footNote: "footnote", endNote: "endnote" };
const INLINE_TEXT = { tab: "\t", lineBreak: "\n", nbSpace: " ", fwSpace: " ", hyphen: "-" };

/** Elements that only choose content (OWPML alternative content): never the owner of what is inside. */
const TRANSPARENT = new Set(["switch", "default"]);

/** An attribute as a whole number (NaN when it is not one: never a guess). */
const num = (v) => (typeof v === "string" && /^[0-9]{1,9}$/.test(v) ? Number(v) : NaN);

/** One section part into the builder. */
function hwpxSection(xml, b) {
  const elems = []; // what each open element did: { name, did }
  let inT = 0;
  // Inside an OWPML `hp:case` (alternative content for other renderers): nothing is read — no frames, no text
  // (review #120 4차). Only a switch's `hp:default` is read, as ordinary content where it is (nested ones too).
  let alt = 0;
  parseXml(xml, {
    open(name, a) {
      // `hp:switch` / `hp:default` are transparent (review #120 5차): what holds an element is the nearest real
      // structure around it, past any (nested) switch and default — as Hancom's model keeps the original parent.
      const owner = elems.findLast((e) => !TRANSPARENT.has(e.name));
      const parent = owner?.name;
      let did = "";
      if (alt || name === "case") {
        alt++;
        elems.push({ name, did: "alt" });
        return;
      }
      if (name === "p") {
        if (elems.every((e) => e.did !== "para")) b.more();
        b.openPara();
        did = "para";
      } else if (name === "t") {
        inT++;
        did = "t";
      } else if (inT && INLINE_TEXT[name] !== undefined) b.text(INLINE_TEXT[name]);
      else if (name === "tbl") {
        b.openCtrl("table", { rows: Number(a.rowCnt), cols: Number(a.colCnt) });
        did = "ctrl";
      } else if (name === "tc") {
        b.openList({ cell: true });
        did = "list";
      } else if (name === "cellAddr") b.cellAddress(num(a.rowAddr), num(a.colAddr));
      else if (name === "cellSpan") b.cellSpan(num(a.rowSpan), num(a.colSpan));
      else if (NOTE[name]) {
        b.openCtrl(NOTE[name], { number: num(a.number) });
        did = "ctrl";
      } else if (SKIP.has(name)) {
        b.openCtrl("skip");
        did = "ctrl";
      } else if (name === "subList") {
        if (parent === "tc") did = "";
        else if (owner?.did === "ctrl") {
          b.openList();
          did = "list";
        } else {
          // A text box, a caption, a shape's text …: its text joins the paragraph that holds it.
          b.openCtrl("inline");
          b.openList();
          did = "inline";
        }
      }
      elems.push({ name, did });
    },
    close() {
      const e = elems.pop();
      if (!e) return;
      if (e.did === "alt") alt--;
      else if (e.did === "para") b.closePara();
      else if (e.did === "t") inT--;
      else if (e.did === "ctrl") b.closeCtrl();
      else if (e.did === "list") b.closeList();
      else if (e.did === "inline") {
        b.closeList();
        b.closeCtrl();
      }
    },
    text(t) {
      if (!alt && inT) b.text(t);
    },
  });
}

/** HWPX: the manifest's encryption check, then each section of the spine in order. */
export function hwpx(zip, out, limits = HWP_LIMITS) {
  if (hwpxEncrypted(zip)) throw new ExtractError("extract_encrypted");
  const sections = hwpxSections(zip);
  if (!sections.length) throw new ExtractError("extract_invalid");
  if (sections.length > limits.maxSections) throw new ExtractError("extract_too_large");
  return build(out, limits, (b) => {
    for (const name of sections) {
      b.more();
      const xml = optionalPart(zip, name);
      if (xml === undefined) continue;
      hwpxSection(xml, b);
    }
  });
}
