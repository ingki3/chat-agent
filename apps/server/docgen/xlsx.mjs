// XLSX (Excel) from a checked document (#49) with `exceljs`. The first sheet ("문서") holds the title, the text
// blocks in order, the pictures and the references; each table gets its own sheet (header row bold and frozen,
// with a filter), named by its caption, and the first sheet says where it is. Cells keep their type: a number
// stays a number; a string is always a string cell — never a formula, whatever it starts with.
import { DEFAULT_REFERENCES_TITLE, fit, imageOf } from "./common.mjs";

const MAIN = "문서";
/** Characters Excel refuses in a sheet name, and its length limit. */
const BAD_SHEET = /[[\]:*?/\\]/g;
const SHEET_MAX = 31;
const ROW_PX = 20;

export async function buildXlsx(doc, ctx) {
  const ExcelJS = await ctx.lib("exceljs");
  const wb = new ExcelJS.Workbook();
  wb.creator = doc.author ?? "Agent Lee";
  wb.title = doc.title;
  if (doc.subtitle) wb.subject = doc.subtitle;
  const used = new Set([MAIN]);
  const sheetName = (want) => {
    const base =
      want
        .replace(BAD_SHEET, " ")
        .replace(/^'+|'+$/g, "")
        .trim()
        .slice(0, SHEET_MAX) || "표";
    let name = base;
    for (let n = 2; used.has(name.toLowerCase()) || used.has(name); n++)
      name = `${base.slice(0, SHEET_MAX - String(n).length - 1)} ${n}`;
    used.add(name.toLowerCase());
    used.add(name);
    return name;
  };

  const main = wb.addWorksheet(MAIN);
  main.getColumn(1).width = 100;
  const add = (text, font) => {
    const row = main.addRow([text]);
    row.getCell(1).alignment = { wrapText: true, vertical: "top" };
    if (font) row.getCell(1).font = font;
    return row;
  };
  add(doc.title, { bold: true, size: 16 });
  if (doc.subtitle) add(doc.subtitle, { size: 12 });
  if (doc.author) add(doc.author, { color: { argb: "FF666666" } });
  main.addRow([]);

  let tableNo = 0;
  for (const b of doc.blocks) {
    switch (b.type) {
      case "heading":
        add(b.text, { bold: true, size: [14, 12, 11][(b.level ?? 1) - 1] });
        break;
      case "paragraph":
        add(b.text);
        break;
      case "list":
        b.items.forEach((item, i) => add(`${b.ordered ? `${i + 1}.` : "•"} ${item}`));
        break;
      case "table": {
        tableNo++;
        const name = sheetName(b.caption ?? `표 ${tableNo}`);
        add(`표 ${tableNo}${b.caption ? ` · ${b.caption}` : ""} → '${name}' 시트`, { italic: true });
        const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
        const header = ws.addRow(b.columns);
        header.font = { bold: true };
        header.eachCell((c) => {
          c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEEEEEE" } };
        });
        for (const r of b.rows) ws.addRow(r.map((c) => (c === null ? null : c)));
        b.columns.forEach((c, i) => {
          const longest = Math.max(
            String(c).length,
            ...b.rows.map((r) => (r[i] === null ? 0 : String(r[i]).length)),
          );
          ws.getColumn(i + 1).width = Math.min(60, Math.max(8, longest + 2));
        });
        if (b.rows.length)
          ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: b.columns.length } };
        break;
      }
      case "image": {
        const img = imageOf(ctx, b);
        const size = fit(img.width, img.height, 640, 480);
        const id = wb.addImage({ buffer: img.buf, extension: img.kind === "png" ? "png" : "jpeg" });
        const at = main.rowCount;
        main.addImage(id, { tl: { col: 0, row: at }, ext: size });
        const rows = Math.ceil(size.height / ROW_PX) + 1;
        for (let i = 0; i < rows; i++) main.addRow([]);
        if (b.caption) add(b.caption, { italic: true });
        break;
      }
      case "references":
        add(b.title ?? DEFAULT_REFERENCES_TITLE, { bold: true, size: 14 });
        b.items.forEach((item, i) => add(`[${i + 1}] ${item}`));
        break;
    }
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}
