// The extractor's output (#48): text units with where they are. One segment is one page (PDF), slide (PPTX),
// paragraph or table row (DOCX), row (XLSX/CSV) or a run of lines (TXT/MD), with
// - `unit`: its number in the file's natural order (page, slide, line, row, document block) — what `file_read`
//   ranges over;
// - `loc`: the locator fields of the whole segment (`UnitLocator`, packages/shared locators.ts);
// - `text`;
// - `marks`: `[start, end, fields]` — finer places inside the text (a line's bbox on a page, a cell's column and
//   reference in a row, an OCR word's box, one line of a run of lines). A match inside a mark takes its fields.
// - `endsEarly`: text the extractor did not take follows right after this unit (a limit — `boundary` / `end`).
// The collector keeps at most `maxChars` characters and `maxSegments` segments; past that it says `truncated` and
// stops: the file's text ends there. A unit is never cut anywhere else (review #107 6차) — the server scrubs known
// secrets out of the whole, uncut text first and only then caps a long unit for display (files/scrub.ts).

import { ExtractError } from "./errors.mjs";

export const SEGMENT_LIMITS = { maxChars: 2_000_000, maxSegments: 20_000, maxHiddenChars: 2_000_000 };

export class Segments {
  constructor(limits = SEGMENT_LIMITS) {
    this.limits = limits;
    this.items = [];
    this.kept = 0;
    this.chars = 0;
    this.hiddenChars = 0;
    this.truncated = false;
  }

  /** Adds one segment; false (and `truncated`) once a limit is reached. Empty text is skipped. */
  add(unit, loc, text, marks) {
    // Closed once a limit cut the text: the document ends there, nothing may follow it (review #107 7차 — a
    // surrogate pair kept back one character of room, and the next unit filled it: the text no longer ended where
    // it was cut, so a secret cut off there was not at the end any more).
    if (this.truncated) return false;
    if (!text || !text.trim()) return true;
    if (this.kept >= this.limits.maxSegments || this.chars >= this.limits.maxChars) {
      this.end();
      return false;
    }
    let t = text;
    let m = marks;
    // Only the file's total: what is past it is never read, so the text simply ends here.
    const room = this.limits.maxChars - this.chars;
    if (t.length > room) {
      // Never half a surrogate pair.
      let cut = room;
      if (cut > 0 && /[\uD800-\uDBFF]/.test(t[cut - 1])) cut--;
      t = t.slice(0, cut);
      m = m?.filter(([s]) => s < cut).map(([s, e, f]) => [s, Math.min(e, cut), f]);
    }
    this.chars += t.length;
    this.kept++;
    this.items.push(m?.length ? { unit, loc, text: t, marks: m } : { unit, loc, text: t });
    if (t.length < text.length) this.end();
    return !this.truncated;
  }

  /**
   * Text the extractor reads but leaves out (an HWP header, a footer, a hidden comment — #23, review
   * #120): a **hidden** unit at its place in the reading order. The server scrubs known secrets over the kept and
   * hidden text together and stores only the kept units; hidden text is never stored, shown or logged. It does not
   * count against the kept text's limits (it never pushes kept text out); its own total past `maxHiddenChars`
   * refuses the file (`extract_too_large`) rather than drop any of it.
   */
  hidden(text) {
    if (this.truncated || !text || !text.trim()) return;
    this.hiddenChars += text.length;
    if (this.hiddenChars > (this.limits.maxHiddenChars ?? SEGMENT_LIMITS.maxHiddenChars))
      throw new ExtractError("extract_too_large");
    this.items.push({ hidden: true, text });
  }

  /**
   * Whether a limit is reached, for a loop about to read **more input**: then that input is cut off, and the
   * result says so (`truncated`) — review #107: the loops stopped before `add` could notice.
   */
  stopHere() {
    if (!this.full) return false;
    this.end();
    return true;
  }

  /**
   * Text is left out right after the last unit taken: it gets `endsEarly` (review #107 9차 — the server masks a
   * cut-off secret at exactly that point, on save and in the rescrub). Every place the extractor drops text it has
   * read, or stops before text it would read, goes through here or `end` (docs/decisions/isolation.md).
   */
  boundary() {
    const last = this.items.at(-1);
    if (last) last.endsEarly = true;
  }

  /** A limit ends the document here: `boundary`, `truncated`, and the collector is closed. */
  end() {
    this.boundary();
    this.truncated = true;
  }

  get full() {
    return this.truncated || this.kept >= this.limits.maxSegments || this.chars >= this.limits.maxChars;
  }
}

/** Joins pieces with a separator and records each piece's range as a mark with its fields. */
export function joinMarked(pieces, sep) {
  let text = "";
  const marks = [];
  for (const p of pieces) {
    if (text) text += sep;
    const s = text.length;
    text += p.text;
    marks.push([s, text.length, p.fields]);
  }
  return { text, marks };
}

/** Column letters of a 1-based column number (1 → A, 28 → AB). */
export function colName(n) {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/** 1-based column number of a cell reference's letters (`B2` → 2); 0 when there are none. */
export function colNumber(ref) {
  const m = /^([A-Z]{1,3})/.exec(ref ?? "");
  if (!m) return 0;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
