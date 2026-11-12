// DOCX (Word) from a checked document (#49) with `docx`: title, headings, paragraphs, lists, tables with a header
// row, pictures with captions, and the references as a numbered list. Korean text uses 맑은 고딕 (Word's default
// Korean font on Windows; others substitute their own) — the text itself is plain Unicode.
import { DEFAULT_REFERENCES_TITLE, cellText, fit, imageOf } from "./common.mjs";

const FONT = { ascii: "Malgun Gothic", hAnsi: "Malgun Gothic", eastAsia: "맑은 고딕", cs: "Malgun Gothic" };
/** Content width of an A4 page with 2.54 cm margins, in pixels at 96 dpi (what ImageRun sizes are in). */
const PAGE_WIDTH_PX = 600;
/** The same width in twentieths of a point (A4 11906 − 2 × 1440): tables are laid out in it. */
const PAGE_WIDTH_DXA = 9026;
const MAX_IMAGE_HEIGHT_PX = 700;

export async function buildDocx(doc, ctx) {
  const d = await ctx.lib("docx");
  const { AlignmentType, Document, HeadingLevel, ImageRun, LevelFormat, Packer, Paragraph, ShadingType } = d;
  const { Table, TableCell, TableRow, TextRun, WidthType } = d;

  /** A paragraph's runs: line breaks inside the text become breaks, not new paragraphs. */
  const runs = (text, opts = {}) =>
    text.split(/\r?\n/).map((t, i) => new TextRun({ text: t, ...(i ? { break: 1 } : {}), ...opts }));
  const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];

  const children = [new Paragraph({ heading: HeadingLevel.TITLE, children: runs(doc.title) })];
  if (doc.subtitle)
    children.push(new Paragraph({ heading: HeadingLevel.SUBTITLE, children: runs(doc.subtitle) }));
  if (doc.author) children.push(new Paragraph({ children: runs(doc.author, { color: "666666" }) }));

  // Each ordered list (and the references) restarts its numbering: one numbering instance per list.
  let instance = 0;
  const numbered = (items) => {
    instance++;
    for (const item of items)
      children.push(
        new Paragraph({ numbering: { reference: "ordered", level: 0, instance }, children: runs(item) }),
      );
  };

  for (const b of doc.blocks) {
    switch (b.type) {
      case "heading":
        children.push(new Paragraph({ heading: HEADINGS[(b.level ?? 1) - 1], children: runs(b.text) }));
        break;
      case "paragraph":
        children.push(new Paragraph({ children: runs(b.text), spacing: { after: 120 } }));
        break;
      case "list":
        if (b.ordered) numbered(b.items);
        else
          for (const item of b.items)
            children.push(new Paragraph({ bullet: { level: 0 }, children: runs(item) }));
        break;
      case "table": {
        if (b.caption) children.push(new Paragraph({ children: runs(b.caption, { bold: true }) }));
        const colWidth = Math.floor(PAGE_WIDTH_DXA / b.columns.length);
        const cell = (text, header) =>
          new TableCell({
            width: { size: colWidth, type: WidthType.DXA },
            children: [new Paragraph({ children: runs(text, header ? { bold: true } : {}) })],
            ...(header ? { shading: { type: ShadingType.CLEAR, fill: "EEEEEE", color: "auto" } } : {}),
          });
        children.push(
          new Table({
            width: { size: PAGE_WIDTH_DXA, type: WidthType.DXA },
            columnWidths: b.columns.map(() => colWidth),
            rows: [
              new TableRow({ tableHeader: true, children: b.columns.map((c) => cell(c, true)) }),
              ...b.rows.map((r) => new TableRow({ children: r.map((c) => cell(cellText(c), false)) })),
            ],
          }),
          new Paragraph({ children: [] }),
        );
        break;
      }
      case "image": {
        const img = imageOf(ctx, b);
        children.push(
          new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new ImageRun({
                type: img.kind === "png" ? "png" : "jpg",
                data: img.buf,
                transformation: fit(img.width, img.height, PAGE_WIDTH_PX, MAX_IMAGE_HEIGHT_PX),
              }),
            ],
          }),
        );
        if (b.caption)
          children.push(
            new Paragraph({ alignment: AlignmentType.CENTER, children: runs(b.caption, { italics: true }) }),
          );
        break;
      }
      case "references":
        children.push(
          new Paragraph({
            heading: HeadingLevel.HEADING_1,
            children: runs(b.title ?? DEFAULT_REFERENCES_TITLE),
          }),
        );
        // "[n] …" as text, like the citations it lists (not a list numbering a viewer might continue).
        b.items.forEach((item, i) =>
          children.push(
            new Paragraph({ indent: { left: 440, hanging: 440 }, children: runs(`[${i + 1}] ${item}`) }),
          ),
        );
        break;
    }
  }

  const document = new Document({
    title: doc.title,
    creator: doc.author ?? "Agent Lee",
    ...(doc.subtitle ? { subject: doc.subtitle } : {}),
    styles: { default: { document: { run: { font: FONT, size: 22 } } } },
    numbering: {
      config: [
        {
          reference: "ordered",
          levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START }],
        },
      ],
    },
    sections: [{ children }],
  });
  return Buffer.from(await Packer.toBuffer(document));
}
