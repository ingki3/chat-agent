// PDF from a checked document (#49) with `pdfkit`, A4. Korean needs a font in the file: Gothic A1 (regular and
// bold, SIL Open Font License 1.1, the pinned `@expo-google-fonts/gothic-a1` package) is embedded as a subset of
// the glyphs used, with a ToUnicode map so the text can be searched and copied. Page numbers at the foot of each page.
import { DEFAULT_REFERENCES_TITLE, DocError, cellText, fit, imageOf } from "./common.mjs";
import { graphemes } from "./widths.mjs";

const MARGIN = 56;
/** Pages one PDF may have (the sandbox's time and memory limits hold a document this size with room to spare). */
export const MAX_PAGES = 1000;
/**
 * Pixels of the pictures pdfkit must decode (`imageInfo().decodes`), all together: about 15 bytes each while the file
 * is made (a 40-megapixel PNG with alpha took 700 MB), so more is refused (`doc_too_large`).
 */
export const PDF_DECODED_PIXELS = 20_000_000;
/** A table row is kept below this share of the page's text height (pdfkit clamps — cuts — a taller row). */
const ROW_SHARE = 0.85;

/**
 * Cuts cell text into pieces that each fit one table row of `inner` points' width and `limit` points' height at
 * `size` (with `pad` around): lines are broken the way the cell wraps (at spaces where a word fits, else between
 * graphemes — never inside one), pieces are cut between lines and each is measured by pdfkit before it is used.
 * Exported for tests.
 */
export function cellSplitter(pdf, { size, inner, pad, limit }) {
  const heightOf = (font, text) => {
    pdf.font(font).fontSize(size);
    return pdf.heightOfString(text || " ", { width: inner }) + 2 * pad;
  };
  const widths = new Map();
  /** Width of one grapheme in `font` (cached: measuring long unbroken text again and again is slow in pdfkit). */
  const charWidth = (font, c) => {
    const key = `${font}\u0000${c}`;
    let w = widths.get(key);
    if (w === undefined) {
      pdf.font(font).fontSize(size);
      w = pdf.widthOfString(c);
      widths.set(key, w);
    }
    return w;
  };
  /**
   * The text as lines of `inner` width, the way the cell will wrap it: at spaces where a word fits, between
   * characters inside a word that does not (Hangul has no spaces to wait for). `hard`: after a line break of the text.
   */
  const lines = (font, text) => {
    const out = [];
    text.split("\n").forEach((para, k) => {
      let line = "";
      let w = 0;
      let hard = k > 0;
      const push = () => {
        out.push({ text: line, hard });
        hard = false;
        line = "";
        w = 0;
      };
      for (const word of para.split(/(?<=\s)/u)) {
        const gs = graphemes(word);
        const ww = gs.reduce((a, c) => a + charWidth(font, c), 0);
        if (line && w + ww > inner && ww <= inner) push();
        // Graphemes, never code points: a cut never falls inside one ("é", a ZWJ sequence, a flag, jamo).
        for (const c of gs) {
          const cw = charWidth(font, c);
          if (line && w + cw > inner && !/\s/u.test(c)) push();
          line += c;
          w += cw;
        }
      }
      push();
    });
    return out;
  };
  /**
   * The text in pieces that each fit one row (cut between lines; a line break the cut falls on is the row break).
   * Each piece is measured by pdfkit itself before it is used; one that is still too tall is cut again.
   */
  const pieces = (font, text) => {
    pdf.font(font).fontSize(size);
    const lineH = pdf.heightOfString("가", { width: inner });
    const per = Math.floor((limit - 2 * pad) / lineH);
    if (per < 1) throw new DocError("doc_too_large");
    const all = lines(font, text);
    if (all.length <= per && heightOf(font, text) <= limit) return [text];
    const out = [];
    const cut = (ls, n) => {
      for (let i = 0; i < ls.length; i += n) {
        const chunk = ls.slice(i, i + n);
        const t = chunk.map((l, j) => (j && l.hard ? `\n${l.text}` : l.text)).join("");
        if (heightOf(font, t) <= limit) out.push(t);
        else if (n > 1) cut(chunk, Math.ceil(n / 2));
        else throw new DocError("doc_too_large");
      }
    };
    cut(all, per);
    return out;
  };
  return { pieces, lines };
}

/**
 * A table that never loses text: columns of equal width, the font made smaller for many columns, and every cell
 * whose text is taller than a row may be cut at character boundaries into pieces that each fit — the pieces of a
 * row go on continuation rows (the header's too, still shaded), which pdfkit moves to the next page as needed.
 * A text that cannot be laid out at all (one character wider or taller than a row) is refused (`doc_too_large`),
 * and so is any row pdfkit would still clamp — the file is never made with part of a cell missing.
 */
function drawTable(pdf, b, tableWidth) {
  const n = b.columns.length;
  const colWidth = tableWidth / n;
  const pad = n > 10 ? 2 : 4;
  const inner = colWidth - 2 * pad;
  const size = Math.max(5, Math.min(9.5, inner / 1.1));
  const limit = pdf.page.contentHeight * ROW_SHARE;
  const { pieces } = cellSplitter(pdf, { size, inner, pad, limit });
  /** One table row as rows that fit: piece k of every cell on the k-th row. */
  const split = (cells, font) => {
    const parts = cells.map((c) => pieces(font, c));
    const k = Math.max(...parts.map((p) => p.length));
    return Array.from({ length: k }, (_, i) => parts.map((p) => p[i] ?? ""));
  };
  const head = split(b.columns, "B");
  const rows = [
    ...head.map((r) => r.map((text) => ({ text, font: { src: "B" } }))),
    ...b.rows.flatMap((r) => split(r.map(cellText), "R")),
  ];
  pdf.font("R").fontSize(size);
  // pdfkit warns (and cuts the row to the page) when a row is taller than a page: that must never pass.
  const warn = console.warn;
  let clamped = false;
  console.warn = (...args) => {
    if (String(args[0]).includes("clamped")) clamped = true;
    else warn(...args);
  };
  try {
    pdf.table({
      data: rows,
      columnStyles: () => ({ width: colWidth }),
      rowStyles: (i) => (i < head.length ? { backgroundColor: "#eeeeee" } : {}),
      defaultStyle: { padding: pad, border: 0.5, borderColor: "#999999" },
    });
  } finally {
    console.warn = warn;
  }
  if (clamped) throw new DocError("doc_too_large");
}

export async function buildPdf(doc, ctx) {
  let decoded = 0;
  for (const img of ctx.images.values()) if (img.decodes) decoded += img.width * img.height;
  if (decoded > PDF_DECODED_PIXELS) throw new DocError("doc_too_large");
  const PDFDocument = await ctx.lib("pdfkit");
  const pdf = new PDFDocument({
    size: "A4",
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    // Pages are not buffered: each is written out (compressed) when the next starts, so memory does not grow with
    // the page count (buffering all pages of a long table took about 2.8 MB a page).
    bufferPages: false,
    lang: "ko-KR",
    displayTitle: true,
    font: ctx.fonts.regular,
    info: {
      Title: doc.title,
      Author: doc.author ?? "Agent Lee",
      ...(doc.subtitle ? { Subject: doc.subtitle } : {}),
    },
  });
  // Pages are counted as they are started: past MAX_PAGES the document is refused at once (before more is drawn).
  let pages = 1;
  pdf.on("pageAdded", () => {
    if (++pages > MAX_PAGES) throw new DocError("doc_too_large");
    pageNumber(pages);
  });
  const chunks = [];
  pdf.on("data", (c) => chunks.push(c));
  const ended = new Promise((resolve, reject) => {
    pdf.on("end", resolve);
    pdf.on("error", reject);
  });
  pdf.registerFont("R", ctx.fonts.regular);
  pdf.registerFont("B", ctx.fonts.bold);
  /** The page number in the bottom margin of the page just started (the text position and style are kept). */
  const pageNumber = (n) => {
    const { x, y } = pdf;
    const keep = pdf.page.margins.bottom;
    const kept = { font: pdf._font, size: pdf._fontSize, source: pdf._fontSource, family: pdf._fontFamily };
    pdf.page.margins.bottom = 0;
    pdf
      .font("R")
      .fontSize(9)
      .fillColor("#888888")
      .text(`— ${n} —`, pdf.page.margins.left, pdf.page.height - MARGIN / 2 - 6, {
        width: pdf.page.width - pdf.page.margins.left - pdf.page.margins.right,
        align: "center",
        lineBreak: false,
      });
    pdf.page.margins.bottom = keep;
    pdf.fillColor("black");
    Object.assign(pdf, { _font: kept.font, _fontSource: kept.source, _fontFamily: kept.family });
    pdf.fontSize(kept.size);
    pdf.x = x;
    pdf.y = y;
  };
  pageNumber(1);
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
        drawTable(pdf, b, width());
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

  pdf.end();
  await ended;
  return Buffer.concat(chunks);
}
