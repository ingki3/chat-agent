// Plain text (#48): TXT and MD by line, CSV by row and cell. Bytes are UTF-8 (a BOM is dropped); a file that is
// not valid UTF-8 is read as CP949 (EUC-KR) — what Excel and older Korean tools write. Upload detection already
// refused binary content (files/detect.ts).
import { colName, joinMarked } from "./segments.mjs";

export function decodeText(buf) {
  let b = buf;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return new TextDecoder("euc-kr").decode(b);
  }
}

/** Lines per segment (each line is a mark of its own, so a match still names its exact line). */
const LINES_PER_SEGMENT = 40;
const CHARS_PER_SEGMENT = 4000;

/** TXT / MD: runs of up to 40 lines (4000 characters), `line` = the first line; each line a mark. */
export function lines(buf, out) {
  const all = decodeText(buf).split(/\r\n|\n|\r/);
  if (all.length && all[all.length - 1] === "") all.pop();
  let pieces = [];
  let size = 0;
  const flush = () => {
    const filled = pieces.filter((p) => p.text.trim());
    if (filled.length) {
      const { text, marks } = joinMarked(pieces, "\n");
      out.add(pieces[0].fields.line, { kind: "line", line: pieces[0].fields.line }, text, marks);
    }
    pieces = [];
    size = 0;
  };
  for (let i = 0; i < all.length; i++) {
    if (out.stopHere()) break;
    pieces.push({ text: all[i], fields: { line: i + 1 } });
    size += all[i].length + 1;
    if (pieces.length >= LINES_PER_SEGMENT || size >= CHARS_PER_SEGMENT) flush();
  }
  flush();
  return { units: all.length };
}

/** RFC 4180 rows: quoted fields may hold commas, quotes (doubled) and line breaks. */
export function* csvRows(text) {
  let row = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else field += c;
      i++;
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      row.push(field);
      yield row;
      row = [];
      field = "";
      if (c === "\r" && text[i + 1] === "\n") i++;
    } else field += c;
    i++;
  }
  if (field !== "" || row.length) {
    row.push(field);
    yield row;
  }
}

/** CSV: one segment per row with a value, `cell_range` with the row and its range; each cell a mark. */
export function csv(buf, out) {
  let r = 0;
  for (const row of csvRows(decodeText(buf))) {
    r++;
    if (out.stopHere()) break;
    const cells = [];
    row.forEach((v, i) => {
      const t = v.trim();
      if (t) cells.push({ text: t, fields: { col: i + 1, range: `${colName(i + 1)}${r}` } });
    });
    if (!cells.length) continue;
    const { text, marks } = joinMarked(cells, " | ");
    const first = cells[0].fields.range;
    const last = cells[cells.length - 1].fields.range;
    const range = first === last ? first : `${first}:${last}`;
    out.add(r, { kind: "cell_range", row: r, range }, text, marks);
  }
  return { units: r };
}
