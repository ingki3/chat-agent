// PDF from a checked document (#49) with `pdfkit`, A4. Korean needs a font in the file: Gothic A1 (regular and
// bold, SIL Open Font License 1.1, the pinned `@expo-google-fonts/gothic-a1` package) is embedded as a subset of
// the glyphs used, with a ToUnicode map so the text can be searched and copied. Page numbers at the foot.
import { DEFAULT_REFERENCES_TITLE, cellText, fit, imageOf } from "./common.mjs";

const MARGIN = 56;

export async function buildPdf(doc, ctx) {
  const PDFDocument = await ctx.lib("pdfkit");
  const pdf = new PDFDocument({
    size: "A4",
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    bufferPages: true,
    lang: "ko-KR",
    displayTitle: true,
    font: ctx.fonts.regular,
    info: {
      Title: doc.title,
      Author: doc.author ?? "Agent Lee",
      ...(doc.subtitle ? { Subject: doc.subtitle } : {}),
    },
  });
  const chunks = [];
  pdf.on("data", (c) => chunks.push(c));
  const ended = new Promise((resolve, reject) => {
    pdf.on("end", resolve);
    pdf.on("error", reject);
  });
  pdf.registerFont("R", ctx.fonts.regular);
  pdf.registerFont("B", ctx.fonts.bold);
  const width = () => pdf.page.width - pdf.page.margins.left - pdf.page.margins.right;
  const bottom = () => pdf.page.height - pdf.page.margins.bottom;
  const say = (text, font, size, opts = {}) =>
    pdf
      .font(font)
      .fontSize(size)
      .text(text, { lineGap: 3, ...opts });

  say(doc.title, "B", 22);
  if (doc.subtitle) say(doc.subtitle, "R", 14, { paragraphGap: 2 });
  if (doc.author) pdf.fillColor("#666666").font("R").fontSize(11).text(doc.author).fillColor("black");
  pdf.moveDown(1);

  const numbered = (items, prefix) =>
    items.forEach((item, i) => say(`${prefix(i)} ${item}`, "R", 11, { indent: 0, paragraphGap: 3 }));

  for (const b of doc.blocks) {
    switch (b.type) {
      case "heading":
        pdf.moveDown(0.4);
        say(b.text, "B", [17, 14, 12][(b.level ?? 1) - 1], { paragraphGap: 4 });
        break;
      case "paragraph":
        say(b.text, "R", 11, { paragraphGap: 8 });
        break;
      case "list":
        numbered(b.items, (i) => (b.ordered ? `${i + 1}.` : "•"));
        pdf.moveDown(0.5);
        break;
      case "table": {
        if (b.caption) say(b.caption, "B", 11, { paragraphGap: 4 });
        pdf.font("R").fontSize(9.5);
        pdf.table({
          data: [
            b.columns.map((c) => ({ text: c, font: { src: "B" } })),
            ...b.rows.map((r) => r.map((c) => cellText(c))),
          ],
          rowStyles: (i) => (i === 0 ? { backgroundColor: "#eeeeee" } : {}),
          defaultStyle: { padding: 4, border: 0.5, borderColor: "#999999" },
        });
        pdf.x = pdf.page.margins.left;
        pdf.moveDown(1);
        break;
      }
      case "image": {
        const img = imageOf(ctx, b);
        // 72 points per inch at 96 dpi; never wider than the text, never taller than half a page.
        const size = fit(
          (img.width * 72) / 96,
          (img.height * 72) / 96,
          width(),
          (pdf.page.height - 2 * MARGIN) / 2,
        );
        if (pdf.y + size.height > bottom()) pdf.addPage();
        const y = pdf.y;
        pdf.image(img.buf, pdf.page.margins.left + (width() - size.width) / 2, y, size);
        pdf.y = y + size.height + 6;
        pdf.x = pdf.page.margins.left;
        if (b.caption) say(b.caption, "R", 10, { align: "center", paragraphGap: 8 });
        else pdf.moveDown(0.6);
        break;
      }
      case "references":
        pdf.moveDown(0.4);
        say(b.title ?? DEFAULT_REFERENCES_TITLE, "B", 17, { paragraphGap: 4 });
        numbered(b.items, (i) => `[${i + 1}]`);
        break;
    }
  }

  // Page numbers: written in the bottom margin of every buffered page (no new page is started).
  const range = pdf.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i);
    const keep = pdf.page.margins.bottom;
    pdf.page.margins.bottom = 0;
    pdf
      .font("R")
      .fontSize(9)
      .fillColor("#888888")
      .text(`${i + 1} / ${range.count}`, pdf.page.margins.left, pdf.page.height - MARGIN / 2 - 6, {
        width: width(),
        align: "center",
        lineBreak: false,
      });
    pdf.page.margins.bottom = keep;
  }
  pdf.end();
  await ended;
  return Buffer.concat(chunks);
}
