import type { FileViewResponse, ViewSegment, ViewTarget } from "@agentlee/shared";

/**
 * The file viewer's layout (#24) as pure functions: the served segments grouped into what the screen draws —
 * pages (with their line or word boxes), runs of lines, paragraphs and their notes, tables by row and column,
 * sheets, slides — and which pieces of text are highlighted. The components only draw these; every piece of text
 * is rendered as text.
 */

export type Piece = { text: string; hit: boolean; focus: boolean };

/** A highlighted range of one segment's text: the passage (`hit`) or the named line / cell (`focus`). */
export type Highlight = { start: number; end: number; kind: "hit" | "focus" };

/** The highlights of segment `seq` under `target` (none for a target that highlights nothing). */
export function highlightsOf(seq: number, target: ViewTarget | null | undefined): Highlight[] {
  if (!target) return [];
  const out: Highlight[] = [];
  if (target.status === "exact" && target.range?.seq === seq)
    out.push({ start: target.range.start, end: target.range.end, kind: "hit" });
  if ((target.status === "exact" || target.status === "unit") && target.focus?.seq === seq)
    out.push({ start: target.focus.start, end: target.focus.end, kind: "focus" });
  return out;
}

/** Whether the segment is (a piece of) the located unit. */
export const isTargetUnit = (seq: number, target: ViewTarget | null | undefined) =>
  !!target && (target.status === "exact" || target.status === "unit") && target.seqs.includes(seq);

/**
 * `text[start, end)` cut at every highlight edge: each piece says whether a passage or a focus covers it. Ranges
 * outside the slice are clipped; an empty slice is no pieces.
 */
export function pieces(text: string, hl: readonly Highlight[], start = 0, end = text.length): Piece[] {
  const cuts = new Set([start, end]);
  for (const h of hl) {
    if (h.start > start && h.start < end) cuts.add(h.start);
    if (h.end > start && h.end < end) cuts.add(h.end);
  }
  const at = [...cuts].sort((a, b) => a - b);
  const out: Piece[] = [];
  for (let i = 0; i + 1 < at.length; i++) {
    const [a, b] = [at[i]!, at[i + 1]!];
    if (a >= b) continue;
    const covers = (k: Highlight["kind"]) => hl.some((h) => h.kind === k && h.start <= a && h.end >= b);
    const piece = { text: text.slice(a, b), hit: covers("hit"), focus: covers("focus") };
    const last = out.at(-1);
    if (last && last.hit === piece.hit && last.focus === piece.focus) last.text += piece.text;
    else out.push(piece);
  }
  return out;
}

/** One cell of a table row or sheet row: its column and where its text is in the segment. */
export type Cell = { col: number; seq: number; start: number; end: number; ref?: string };

/** The cells of a row's segments (its marks with a column), in column order; none when it has no marks. */
export function cellsOf(segs: readonly ViewSegment[]): Cell[] {
  const out: Cell[] = [];
  for (const s of segs)
    for (const m of s.marks)
      if (m.col !== undefined)
        out.push({
          col: m.col,
          seq: s.seq,
          start: m.start,
          end: m.end,
          ...(m.range ? { ref: m.range } : {}),
        });
  return out.sort((a, b) => a.col - b.col);
}

/**
 * Cells by column (1…max): every piece of a column in reading order (a cell split around a footnote is two pieces
 * of one column), empty for the gaps of merged cells; null when the row is wider than a grid draws.
 */
export function columns(cells: readonly Cell[]): Cell[][] | null {
  const max = cells.reduce((m, c) => Math.max(m, c.col), 0);
  if (max > GRID_COLS) return null;
  const out: Cell[][] = Array.from({ length: max }, () => []);
  for (const c of cells) out[c.col - 1]!.push(c);
  return out;
}

/** One line of a run of lines (its number when the marks still say it). */
export type Line = { line: number | undefined; start: number; end: number };

/** The lines of a run: by its marks, or — marks lost — the text split at line breaks with no numbers. */
export function linesOf(s: ViewSegment): Line[] {
  const marked = s.marks.filter((m) => m.line !== undefined);
  if (marked.length) return marked.map((m) => ({ line: m.line, start: m.start, end: m.end }));
  const out: Line[] = [];
  let at = 0;
  for (const part of s.text.split("\n")) {
    out.push({ line: undefined, start: at, end: at + part.length });
    at += part.length + 1;
  }
  return out;
}

export type Block =
  /** A PDF page's text (`page`) or the text read from its picture / an image (`ocr`). */
  | { kind: "page"; key: string; page: number | undefined; ocr: boolean; seg: ViewSegment }
  | { kind: "lines"; key: string; seg: ViewSegment }
  | { kind: "paragraph"; key: string; seg: ViewSegment; note: "footnote" | "endnote" | undefined }
  | {
      kind: "table";
      key: string;
      table: number | undefined;
      rows: { row: number | undefined; segs: ViewSegment[] }[];
      notes: ViewSegment[];
    }
  | {
      kind: "sheet";
      key: string;
      sheet: string | undefined;
      rows: { row: number | undefined; seg: ViewSegment }[];
    }
  | { kind: "slide"; key: string; seg: ViewSegment };

/**
 * The segments in order as blocks. Consecutive rows of one table are one table (the pieces of a split row one row;
 * a note anchored in a row listed under the table); consecutive rows of one sheet one sheet.
 */
export function blocks(items: readonly ViewSegment[]): Block[] {
  const out: Block[] = [];
  for (const s of items) {
    const l = s.locator;
    const key = `s${s.seq}`;
    const last = out.at(-1);
    switch (l.kind) {
      case "page":
      case "ocr_box":
        out.push({ kind: "page", key, page: l.page, ocr: l.kind === "ocr_box", seg: s });
        break;
      case "line":
        out.push({ kind: "lines", key, seg: s });
        break;
      case "paragraph":
        out.push({
          kind: "paragraph",
          key,
          seg: s,
          note: l.footnote !== undefined ? "footnote" : l.endnote !== undefined ? "endnote" : undefined,
        });
        break;
      case "table": {
        const t =
          last?.kind === "table" && last.table === l.table
            ? last
            : (out[out.push({ kind: "table", key, table: l.table, rows: [], notes: [] }) - 1] as Extract<
                Block,
                { kind: "table" }
              >);
        if (l.footnote !== undefined || l.endnote !== undefined) t.notes.push(s);
        else {
          const row = t.rows.at(-1);
          if (row && row.row === l.row) row.segs.push(s);
          else t.rows.push({ row: l.row, segs: [s] });
        }
        break;
      }
      case "cell_range": {
        const sh =
          last?.kind === "sheet" && last.sheet === l.sheet
            ? last
            : (out[out.push({ kind: "sheet", key, sheet: l.sheet, rows: [] }) - 1] as Extract<
                Block,
                { kind: "sheet" }
              >);
        sh.rows.push({ row: l.row, seg: s });
        break;
      }
      case "slide":
        out.push({ kind: "slide", key, seg: s });
        break;
    }
  }
  return out;
}

/** "A", "B" … "Z", "AA" — a sheet column's letters. */
export function colName(n: number): string {
  let s = "";
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

/** Columns a grid draws at most; a wider row is drawn as its cells only. */
export const GRID_COLS = 30;

/** A box `[x, y, w, h]` (fractions) as CSS percentages. */
export const boxStyle = (b: readonly [number, number, number, number]) => ({
  left: `${b[0] * 100}%`,
  top: `${b[1] * 100}%`,
  width: `${Math.max(b[2] * 100, 0.4)}%`,
  height: `${Math.max(b[3] * 100, 0.4)}%`,
});

/**
 * The windows loaded so far (review #123): the opening one — the one loaded without a paging parameter, which
 * carries the locator's resolution wherever later windows put it in the list — and every segment once, in order.
 */
export function loadedView<P>(data: {
  pages: readonly FileViewResponse[];
  pageParams: readonly (P | undefined)[];
}): {
  opening: FileViewResponse | undefined;
  items: ViewSegment[];
} {
  const at = data.pageParams.indexOf(undefined);
  const seen = new Set<number>();
  const items: ViewSegment[] = [];
  for (const p of data.pages)
    for (const x of p.items)
      if (!seen.has(x.seq)) {
        seen.add(x.seq);
        items.push(x);
      }
  return { opening: at === -1 ? undefined : data.pages[at], items };
}
