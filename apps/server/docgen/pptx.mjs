// PPTX (PowerPoint) from a checked document (#49) with `pptxgenjs`, 16:9. The title slide (title, subtitle,
// author), then a slide per heading with the paragraphs and lists under it (continued on more slides when long);
// each table gets its own slide (more when it does not fit, header repeated), each picture its own slide, and the
// references end the deck.
import { DEFAULT_REFERENCES_TITLE, cellText, imageOf } from "./common.mjs";

const FONT = "맑은 고딕";
const W = 13.333;
const MARGIN = 0.5;
const BODY_Y = 1.3;
const BODY_H = 5.8;
/** What one text slide holds before the rest goes on a continuation slide. */
const SLIDE_CHARS = 700;
const SLIDE_LINES = 12;

export async function buildPptx(doc, ctx) {
  const PptxGenJS = await ctx.lib("pptxgenjs");
  const pres = new PptxGenJS();
  pres.layout = "LAYOUT_WIDE";
  pres.title = doc.title;
  pres.author = doc.author ?? "Agent Lee";
  if (doc.subtitle) pres.subject = doc.subtitle;

  const first = pres.addSlide();
  first.addText(doc.title, {
    x: MARGIN,
    y: 2.4,
    w: W - 2 * MARGIN,
    h: 1.4,
    fontFace: FONT,
    fontSize: 36,
    bold: true,
    align: "center",
  });
  const sub = [doc.subtitle, doc.author].filter(Boolean).join("\n");
  if (sub)
    first.addText(sub, {
      x: MARGIN,
      y: 3.9,
      w: W - 2 * MARGIN,
      h: 1.2,
      fontFace: FONT,
      fontSize: 18,
      color: "555555",
      align: "center",
    });

  const titled = (title) => {
    const s = pres.addSlide();
    if (title)
      s.addText(title, {
        x: MARGIN,
        y: 0.35,
        w: W - 2 * MARGIN,
        h: 0.8,
        fontFace: FONT,
        fontSize: 26,
        bold: true,
      });
    return s;
  };

  let heading = "";
  /** Paragraph and list lines waiting for the current heading's slide. */
  let lines = [];
  const flush = () => {
    if (!lines.length) return;
    let chunk = [];
    let chars = 0;
    let part = 0;
    const out = () => {
      if (!chunk.length) return;
      const s = titled(part++ ? `${heading} (계속)` : heading);
      s.addText(
        chunk.map((l, i) => ({
          text: l.text,
          options: {
            ...(l.bullet ? { bullet: l.bullet } : {}),
            breakLine: i < chunk.length - 1,
            paraSpaceAfter: 6,
          },
        })),
        { x: MARGIN, y: BODY_Y, w: W - 2 * MARGIN, h: BODY_H, fontFace: FONT, fontSize: 18, valign: "top" },
      );
      chunk = [];
      chars = 0;
    };
    for (const l of lines) {
      if (chunk.length && (chars + l.text.length > SLIDE_CHARS || chunk.length >= SLIDE_LINES)) out();
      chunk.push(l);
      chars += l.text.length;
    }
    out();
    lines = [];
  };

  for (const b of doc.blocks) {
    switch (b.type) {
      case "heading":
        flush();
        heading = b.text;
        break;
      case "paragraph":
        lines.push({ text: b.text });
        break;
      case "list":
        for (const item of b.items) lines.push({ text: item, bullet: b.ordered ? { type: "number" } : true });
        break;
      case "table": {
        flush();
        const s = titled(b.caption ?? heading);
        const head = b.columns.map((c) => ({ text: c, options: { bold: true, fill: { color: "EEEEEE" } } }));
        s.addTable([head, ...b.rows.map((r) => r.map((c) => ({ text: cellText(c) })))], {
          x: MARGIN,
          y: BODY_Y,
          w: W - 2 * MARGIN,
          fontFace: FONT,
          fontSize: 12,
          border: { type: "solid", pt: 0.5, color: "999999" },
          autoPage: true,
          autoPageRepeatHeader: true,
          autoPageHeaderRows: 1,
          newSlideStartY: BODY_Y,
        });
        break;
      }
      case "image": {
        flush();
        const img = imageOf(ctx, b);
        const s = titled(heading);
        const box = { w: W - 2 * MARGIN, h: b.caption ? BODY_H - 0.6 : BODY_H };
        // Inches at 96 dpi, never larger than the box.
        const exact = fitExact(img.width, img.height, box.w, box.h);
        s.addImage({
          data: `image/${img.kind === "png" ? "png" : "jpeg"};base64,${img.buf.toString("base64")}`,
          x: MARGIN + (box.w - exact.w) / 2,
          y: BODY_Y,
          w: exact.w,
          h: exact.h,
        });
        if (b.caption)
          s.addText(b.caption, {
            x: MARGIN,
            y: BODY_Y + exact.h + 0.1,
            w: box.w,
            h: 0.5,
            fontFace: FONT,
            fontSize: 14,
            italic: true,
            align: "center",
          });
        break;
      }
      case "references": {
        flush();
        const title = b.title ?? DEFAULT_REFERENCES_TITLE;
        const saved = heading;
        heading = title;
        b.items.forEach((item, i) => lines.push({ text: `[${i + 1}] ${item}` }));
        flush();
        heading = saved;
        break;
      }
    }
  }
  flush();
  return Buffer.from(await pres.write({ outputType: "nodebuffer" }));
}

/** Inches of a `w × h` pixel picture at 96 dpi scaled down (never up) to fit `maxW × maxH` inches. */
function fitExact(w, h, maxW, maxH) {
  const s = Math.min(1 / 96, maxW / w, maxH / h);
  return { w: w * s, h: h * s };
}
