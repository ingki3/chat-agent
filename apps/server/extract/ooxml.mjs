// Office documents (#48): DOCX paragraphs and tables, XLSX sheets and cells, PPTX slides — read from the archive
// (zip.mjs, size limits) as XML (xml.mjs, no DTD). Parts are found through their relationships, each target
// resolved inside the package (`resolvePart`: one that leaves it refuses the file). Only text is read: no
// embedded objects, no macros, nothing is run.
import { ExtractError } from "./errors.mjs";
import { colName, colNumber, joinMarked } from "./segments.mjs";
import { attr, nsAttr, parseXml, xmlText } from "./xml.mjs";
import { resolvePart } from "./zip.mjs";

const part = (zip, name) => {
  const b = zip.read(name);
  if (!b) throw new ExtractError("extract_invalid");
  return xmlText(b);
};
const optionalPart = (zip, name) => {
  const b = zip.read(name);
  return b ? xmlText(b) : undefined;
};
const dirOf = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const relsOf = (p) => `${dirOf(p) ? dirOf(p) + "/" : ""}_rels/${p.slice(p.lastIndexOf("/") + 1)}.rels`;

/** Relationships of a part: id → resolved part name (external targets are left out). */
export function relationships(zip, partName) {
  const xml = optionalPart(zip, relsOf(partName));
  const out = new Map();
  if (!xml) return out;
  parseXml(xml, {
    open(name, a) {
      if (name !== "Relationship" || a.TargetMode === "External") return;
      if (!a.Id || a.Target === undefined) return;
      out.set(a.Id, resolvePart(dirOf(partName), a.Target));
    },
  });
  return out;
}

/** The main part the package points at (`_rels/.rels` officeDocument), or the conventional name. */
function mainPart(zip, fallback) {
  const xml = optionalPart(zip, "_rels/.rels");
  let found;
  if (xml)
    parseXml(xml, {
      open(name, a) {
        if (name === "Relationship" && /\/officeDocument$/.test(a.Type ?? "") && a.TargetMode !== "External")
          found ??= resolvePart("", a.Target ?? "");
      },
    });
  return found && zip.has(found) ? found : fallback;
}

// ---- DOCX ------------------------------------------------------------------------------------------------------

/**
 * Body paragraphs (`paragraph N`, counting non-empty ones in document order) and table rows (`table T · row R`,
 * top-level tables counted from 1; each cell a mark with its grid column, merged cells by `gridSpan`). Text inside
 * nested tables and text boxes joins the cell or paragraph it is in. Deleted text and field codes are left out.
 */
export function docx(zip, out) {
  const xml = part(zip, mainPart(zip, "word/document.xml"));
  let block = 0;
  let paragraph = 0;
  let table = 0;
  let row = 0;
  let tbl = 0;
  let pDepth = 0;
  let inText = false;
  let buf = "";
  let cellParas = [];
  let cells = [];
  let col = 1;
  let span = 1;
  const paraDone = () => {
    if (tbl === 0) {
      if (buf.trim()) {
        paragraph++;
        block++;
        out.add(block, { kind: "paragraph", paragraph }, buf);
      }
    } else cellParas.push(buf);
    buf = "";
  };
  parseXml(xml, {
    open(name, a) {
      if (name === "p") {
        if (pDepth > 0) buf += "\n";
        pDepth++;
      } else if (name === "t") inText = true;
      else if ((name === "tab" || name === "ptab") && pDepth) buf += "\t";
      else if ((name === "br" || name === "cr") && pDepth) buf += "\n";
      else if (name === "tbl") {
        // A table inside a paragraph's text box still belongs to the current cell or paragraph.
        tbl++;
        if (tbl === 1) {
          table++;
          row = 0;
        }
      } else if (name === "tr" && tbl === 1) {
        row++;
        cells = [];
        col = 1;
      } else if (name === "tc" && tbl === 1) {
        cellParas = [];
        span = 1;
      } else if (name === "gridSpan" && tbl === 1)
        span = Math.max(1, Math.min(64, Number(attr(a, "val")) || 1));
    },
    close(name) {
      if (name === "t") inText = false;
      else if (name === "p") {
        pDepth--;
        if (pDepth === 0) paraDone();
      } else if (name === "tc" && tbl === 1) {
        cells.push({ text: cellParas.join("\n").trim(), fields: { col } });
        col += span;
      } else if (name === "tr" && tbl === 1) {
        const filled = cells.filter((c) => c.text);
        if (filled.length) {
          block++;
          const { text, marks } = joinMarked(filled, " | ");
          out.add(block, { kind: "table", table, row }, text, marks);
        }
      } else if (name === "tbl") tbl--;
    },
    text(t) {
      if (inText && pDepth) buf += t;
    },
  });
  return { units: block };
}

// ---- XLSX ------------------------------------------------------------------------------------------------------

function sharedStrings(zip, rels) {
  const name = [...rels.values()].find((p) => /sharedStrings\.xml$/i.test(p)) ?? "xl/sharedStrings.xml";
  const xml = optionalPart(zip, name);
  const out = [];
  if (!xml) return out;
  let cur = null;
  let inT = false;
  let phonetic = 0;
  parseXml(xml, {
    open(n) {
      if (n === "si") cur = "";
      else if (n === "rPh") phonetic++;
      else if (n === "t") inT = true;
    },
    close(n) {
      if (n === "si") {
        out.push(cur ?? "");
        cur = null;
      } else if (n === "rPh") phonetic--;
      else if (n === "t") inT = false;
    },
    text(t) {
      if (inT && cur !== null && !phonetic) cur += t;
    },
  });
  return out;
}

/**
 * Every sheet in workbook order, one segment per row with a value: `cell_range` with the sheet's name, the row and
 * its range (`A2:C2`); each cell a mark with its column and reference (`B2`). Values as stored (shared and inline
 * strings, numbers, booleans, cached formula results), not formatted.
 */
export function xlsx(zip, out) {
  const wbName = mainPart(zip, "xl/workbook.xml");
  const rels = relationships(zip, wbName);
  const sheets = [];
  parseXml(part(zip, wbName), {
    open(n, a) {
      if (n === "sheet")
        sheets.push({
          // The whole name: the server scrubs it whole and only then caps it for display (review #107 9차).
          name: String(a.name ?? ""),
          no: sheets.length + 1,
          target: rels.get(nsAttr(a, "id")),
        });
    },
  });
  const strings = sharedStrings(zip, rels);
  for (const sh of sheets) {
    if (out.stopHere()) break;
    if (!sh.target) continue;
    const xml = optionalPart(zip, sh.target);
    if (!xml) continue;
    let rowNo = 0;
    let cells = [];
    let cell = null;
    let inV = false;
    let inIs = 0;
    let inT = false;
    let nextCol = 1;
    parseXml(xml, {
      open(n, a) {
        if (n === "row") {
          rowNo = Number(a.r) > 0 ? Number(a.r) : rowNo + 1;
          cells = [];
          nextCol = 1;
        } else if (n === "c") {
          const ref = /^[A-Z]{1,3}[0-9]{1,7}$/.test(a.r ?? "") ? a.r : `${colName(nextCol)}${rowNo}`;
          cell = { ref, type: a.t ?? "n", v: "", is: "" };
          nextCol = colNumber(ref) + 1;
        } else if (n === "v") inV = true;
        else if (n === "is") inIs++;
        else if (n === "t" && inIs) inT = true;
      },
      close(n) {
        if (n === "v") inV = false;
        else if (n === "is") inIs--;
        else if (n === "t") inT = false;
        else if (n === "c" && cell) {
          let value;
          if (cell.type === "s") value = strings[Number(cell.v)] ?? "";
          else if (cell.type === "inlineStr") value = cell.is;
          else if (cell.type === "b") value = cell.v === "1" ? "TRUE" : cell.v === "0" ? "FALSE" : cell.v;
          else value = cell.v;
          value = value.trim();
          if (value) cells.push({ text: value, fields: { col: colNumber(cell.ref), range: cell.ref } });
          cell = null;
        } else if (n === "row" && cells.length) {
          const { text, marks } = joinMarked(cells, " | ");
          const first = cells[0].fields.range;
          const last = cells[cells.length - 1].fields.range;
          const range = first === last ? first : `${first}:${last}`;
          // `sheetNo`: the sheet's place in the workbook — what the model sees instead of its name (file text).
          out.add(
            rowNo,
            { kind: "cell_range", sheet: sh.name, sheetNo: sh.no, row: rowNo, range },
            text,
            marks,
          );
        }
      },
      text(t) {
        if (!cell) return;
        if (inV) cell.v += t;
        else if (inT) cell.is += t;
      },
    });
  }
  return { units: sheets.length };
}

// ---- PPTX ------------------------------------------------------------------------------------------------------

/** Slides in the order shown (`sldIdLst`), one segment each: its paragraphs, one per line. */
export function pptx(zip, out) {
  const presName = mainPart(zip, "ppt/presentation.xml");
  const rels = relationships(zip, presName);
  const order = [];
  parseXml(part(zip, presName), {
    open(n, a) {
      if (n === "sldId") order.push(nsAttr(a, "id"));
    },
  });
  let slide = 0;
  for (const rid of order) {
    const target = rels.get(rid);
    slide++;
    if (out.stopHere()) break;
    if (!target) continue;
    const xml = optionalPart(zip, target);
    if (!xml) continue;
    const paras = [];
    let buf = null;
    let inT = false;
    parseXml(xml, {
      open(n) {
        if (n === "p") buf = "";
        else if (n === "t") inT = true;
        else if (n === "br" && buf !== null) buf += "\n";
      },
      close(n) {
        if (n === "t") inT = false;
        else if (n === "p" && buf !== null) {
          if (buf.trim()) paras.push(buf);
          buf = null;
        }
      },
      text(t) {
        if (inT && buf !== null) buf += t;
      },
    });
    out.add(slide, { kind: "slide", slide }, paras.join("\n"));
  }
  return { units: order.length };
}
