// PPTX (PowerPoint) from a checked document (#49) with `pptxgenjs`, 16:9. The title slide (title, subtitle,
// author), then a slide per heading with the paragraphs and lists under it; each table gets its own slides (header
// repeated on each), each picture its own slide, and the references end the deck.
//
// PowerPoint does not flow text from one slide to the next and nothing here shrinks text on open, so all text is laid
// out here, with an upper bound that holds for any font a viewer may substitute: every character is counted one
// em wide (a tab four), and every line has an exact line spacing written into the file (`LINE` × size). Text boxes
// get explicit insets, table cells explicit margins and column widths. Paragraphs, list items and table cells are
// cut between lines onto continuation slides ("(계속)"); a table whose columns are too narrow for two characters at
// the smallest legible size is refused (`doc_too_large`), and so is a deck over `MAX_SLIDES`. Nothing of the
// document is dropped. A heading with nothing under it still gets its slide; a heading too long for the title box
// opens the body instead.
import { DEFAULT_REFERENCES_TITLE, DocError, cellText, imageOf } from "./common.mjs";

const FONT = "맑은 고딕";
const W = 13.333;
const MARGIN = 0.5;
const INSET = 0.1;
const TITLE_Y = 0.3;
const TITLE_H = 0.95;
const TITLE_SIZE = 24;
const BODY_Y = 1.3;
const BODY_H = 5.8;
const BODY_SIZE = 18;
const PARA_GAP_PT = 6;
/** Exact line spacing, as a multiple of the font size (written into the file as points). */
const LINE = 1.25;
/** Bullet indent pptxgenjs writes (`marL`, 27 pt). */
const BULLET_PT = 27;
/** Table cell margins (inches) and the font sizes a table may use, largest first — never below 8 pt. */
const CELL_MARGIN = 0.04;
const TABLE_SIZES = [12, 11, 10, 9, 8];
/** A table's header may take at most this share of the body height (it is repeated on every slide). */
const HEADER_SHARE = 0.5;
/** Slides one deck may have (the sandbox's memory limit holds a deck this size with room to spare). */
export const MAX_SLIDES = 500;

const pt = (inches) => inches * 72;
/** Width of one character in em — an upper bound for any font: one em, a tab four. */
export const charEm = (c) => (c === "\t" ? 4 : 1);
const lineHeight = (size) => size * LINE;

/**
 * Lines of `text` at `size` points in `widthPt`: hard breaks kept (`hard`: the line starts after a line break of
 * the text), long runs wrapped between characters. Joining the lines (with "\n" before each hard one) gives back
 * the text exactly.
 */
export function wrapLines(text, size, widthPt) {
  const out = [];
  text.split("\n").forEach((segment, k) => {
    let line = "";
    let em = 0;
    let first = true;
    for (const c of segment) {
      const w = charEm(c);
      if (line && (em + w) * size > widthPt) {
        out.push({ text: line, hard: first && k > 0 });
        first = false;
        line = "";
        em = 0;
      }
      line += c;
      em += w;
    }
    out.push({ text: line, hard: first && k > 0 });
  });
  return out;
}
const joinLines = (lines) => lines.map((l, i) => (i && l.hard ? `\n${l.text}` : l.text)).join("");

export async function buildPptx(doc, ctx) {
  const PptxGenJS = await ctx.lib("pptxgenjs");
  const pres = new PptxGenJS();
  pres.layout = "LAYOUT_WIDE";
  pres.title = doc.title;
  pres.author = doc.author ?? "Agent Lee";
  if (doc.subtitle) pres.subject = doc.subtitle;
  const boxW = W - 2 * MARGIN;
  const textPt = pt(boxW - 2 * INSET);
  let slides = 0;
  const newSlide = () => {
    if (++slides > MAX_SLIDES) throw new DocError("doc_too_large");
    return pres.addSlide();
  };
  /** Text box options: explicit insets and exact line spacing (what the layout above assumes). */
  const box = (o, size) => ({
    fontFace: FONT,
    fontSize: size,
    inset: INSET,
    lineSpacing: lineHeight(size),
    ...o,
  });
  /** Height (pt) of paragraphs of `text` at `size` in the text width, with the gap after each paragraph. */
  const textHeight = (text, size, widthPt = textPt) =>
    wrapLines(text, size, widthPt).reduce(
      (h, l, i) => h + lineHeight(size) + (i === 0 || l.hard ? PARA_GAP_PT : 0),
      0,
    );
  const inner = (hIn) => pt(hIn - 2 * INSET);
  /** The largest of `sizes` at which `text` fits `hIn` inches of height. */
  const sizeFor = (text, hIn, sizes) => sizes.find((s) => textHeight(text, s) <= inner(hIn)) ?? null;

  const first = newSlide();
  const titleSize = sizeFor(doc.title, 3, [36, 30, 24, 20, 16, 14, 12]);
  if (!titleSize) throw new DocError("doc_too_large");
  first.addText(
    doc.title,
    box(
      {
        x: MARGIN,
        y: 1.2,
        w: boxW,
        h: 3,
        bold: true,
        align: "center",
        valign: "bottom",
        paraSpaceAfter: PARA_GAP_PT,
      },
      titleSize,
    ),
  );
  const sub = [doc.subtitle, doc.author].filter(Boolean).join("\n");
  if (sub) {
    const subSize = sizeFor(sub, 2.4, [18, 16, 14, 12]);
    if (!subSize) throw new DocError("doc_too_large");
    first.addText(
      sub,
      box(
        {
          x: MARGIN,
          y: 4.4,
          w: boxW,
          h: 2.4,
          color: "555555",
          align: "center",
          valign: "top",
          paraSpaceAfter: PARA_GAP_PT,
        },
        subSize,
      ),
    );
  }

  /** A slide with `title` in the title box (`title` fits it: `fitsTitle`). */
  const titled = (title) => {
    const s = newSlide();
    if (title)
      s.addText(
        title,
        box(
          {
            x: MARGIN,
            y: TITLE_Y,
            w: boxW,
            h: TITLE_H,
            bold: true,
            valign: "middle",
            paraSpaceAfter: PARA_GAP_PT,
          },
          TITLE_SIZE,
        ),
      );
    return s;
  };
  const fitsTitle = (t) => textHeight(t, TITLE_SIZE) <= inner(TITLE_H);
  /** A continuation slide's title: the title and "(계속)", or "(계속)" alone when both do not fit the box. */
  const continued = (t) => (t && fitsTitle(`${t} (계속)`) ? `${t} (계속)` : "(계속)");

  let heading = "";
  /** The current heading is on a slide already (a heading with nothing under it still gets one). */
  let shown = true;
  /** Paragraphs and list items waiting for the current heading's slides: `{ text, bullet?, bold? }`. */
  let pending = [];
  const budget = inner(BODY_H);

  const flush = () => {
    if (!pending.length) return;
    const pages = [];
    let cur = [];
    let used = 0;
    for (const p of pending) {
      const width = p.bullet ? textPt - BULLET_PT : textPt;
      const cost = (l, i) => lineHeight(BODY_SIZE) + (i === 0 || l.hard ? PARA_GAP_PT : 0);
      let lines = wrapLines(p.text, BODY_SIZE, width);
      let cont = false;
      while (lines.length) {
        let take = 0;
        let h = 0;
        while (take < lines.length && used + h + cost(lines[take], take) <= budget) {
          h += cost(lines[take], take);
          take++;
        }
        // Nothing fits, or only one line of a longer paragraph: the paragraph goes on on the next slide.
        if (cur.length && (take === 0 || (take === 1 && lines.length > 1))) {
          pages.push(cur);
          cur = [];
          used = 0;
          continue;
        }
        if (take === 0) throw new DocError("doc_too_large");
        // Only a paragraph's first piece carries the bullet (a later piece has the whole width, more than it needs).
        cur.push({ ...p, text: joinLines(lines.slice(0, take)), bullet: cont ? undefined : p.bullet });
        used += h;
        lines = lines.slice(take);
        cont = true;
      }
    }
    if (cur.length) pages.push(cur);
    pages.forEach((chunk, i) => {
      const s = titled(i ? continued(heading) : heading);
      s.addText(
        chunk.map((l, j) => ({
          text: l.text,
          options: {
            ...(l.bullet ? { bullet: l.bullet } : {}),
            ...(l.bold ? { bold: true } : {}),
            breakLine: j < chunk.length - 1,
            paraSpaceAfter: PARA_GAP_PT,
            lineSpacing: lineHeight(BODY_SIZE),
          },
        })),
        box({ x: MARGIN, y: BODY_Y, w: boxW, h: BODY_H, valign: "top" }, BODY_SIZE),
      );
    });
    pending = [];
    shown = true;
  };
  /** The current heading's own slide, if nothing has shown it yet. */
  const headingSlide = () => {
    if (!shown && heading) titled(heading);
    shown = true;
  };
  const setHeading = (text) => {
    flush();
    headingSlide();
    if (fitsTitle(text)) {
      heading = text;
      shown = false;
    } else {
      // Too long for the title box: the heading opens the body (cut and continued like any text).
      heading = "";
      pending.push({ text, bold: true });
    }
  };

  /**
   * A table on as many slides as it needs: columns of equal width, the largest size at which a column holds two
   * characters, every cell cut between lines; a row that does not fit what is left of a slide goes on on the next
   * one (continuation rows), and the header row is repeated — and counted — on each slide.
   */
  const table = (b, title) => {
    const n = b.columns.length;
    const colPt = pt(boxW) / n;
    const innerPt = colPt - 2 * pt(CELL_MARGIN);
    const size = TABLE_SIZES.find((s) => Math.floor(innerPt / s) >= 2);
    if (!size) throw new DocError("doc_too_large");
    const lh = lineHeight(size);
    const pad = 2 * pt(CELL_MARGIN) + 1; // margins and a border
    const avail = pt(BODY_H);
    const head = b.columns.map((c) => wrapLines(c, size, innerPt));
    const headH = Math.max(...head.map((l) => l.length)) * lh + pad;
    if (headH > avail * HEADER_SHARE) throw new DocError("doc_too_large");
    const headRow = b.columns.map((c) => ({
      text: c,
      options: { bold: true, fill: { color: "EEEEEE" }, lineSpacing: lh },
    }));
    const pagesOf = [];
    let rows = [];
    let used = headH;
    const out = () => {
      pagesOf.push(rows);
      rows = [];
      used = headH;
    };
    for (const r of b.rows) {
      const cells = r.map((c) => wrapLines(cellText(c), size, innerPt));
      const k = Math.max(...cells.map((l) => l.length));
      let at = 0;
      while (at < k) {
        const room = Math.floor((avail - used - pad) / lh);
        // Nothing fits, or only one line of a longer row: the row goes on on the next slide.
        if (rows.length && (room < 1 || (room < 2 && k - at > 1))) {
          out();
          continue;
        }
        if (room < 1) throw new DocError("doc_too_large");
        const take = Math.min(room, k - at);
        rows.push(
          cells.map((l) => ({ text: joinLines(l.slice(at, at + take)), options: { lineSpacing: lh } })),
        );
        used += take * lh + pad;
        at += take;
      }
    }
    if (rows.length || !pagesOf.length) out();
    pagesOf.forEach((page, i) => {
      const s = titled(i ? continued(title) : title);
      s.addTable([headRow, ...page], {
        x: MARGIN,
        y: BODY_Y,
        w: boxW,
        colW: Array.from({ length: n }, () => boxW / n),
        fontFace: FONT,
        fontSize: size,
        lineSpacing: lh,
        margin: CELL_MARGIN,
        valign: "top",
        border: { type: "solid", pt: 0.5, color: "999999" },
      });
    });
  };

  for (const b of doc.blocks) {
    switch (b.type) {
      case "heading":
        setHeading(b.text);
        break;
      case "paragraph":
        pending.push({ text: b.text });
        break;
      case "list":
        // Numbers are written out: an automatic numbering would start again at 1 on a continuation slide.
        b.items.forEach((item, i) =>
          pending.push(b.ordered ? { text: `${i + 1}. ${item}` } : { text: item, bullet: true }),
        );
        break;
      case "table": {
        flush();
        let title = heading;
        if (b.caption) {
          headingSlide();
          if (fitsTitle(b.caption)) title = b.caption;
          else {
            pending.push({ text: b.caption, bold: true });
            flush();
            title = "";
          }
        }
        shown = true;
        table(b, title);
        break;
      }
      case "image": {
        flush();
        const img = imageOf(ctx, b);
        shown = true;
        const s = titled(heading);
        // The caption's own height (laid out like the body), the picture fills the rest.
        const capPt = b.caption ? textHeight(b.caption, 14) + pt(2 * INSET) : 0;
        if (capPt > pt(BODY_H) / 2) throw new DocError("doc_too_large");
        const area = { w: boxW, h: BODY_H - capPt / 72 - (capPt ? 0.1 : 0) };
        // Inches at 96 dpi, never larger than the area.
        const exact = fitExact(img.width, img.height, area.w, area.h);
        s.addImage({
          data: `image/${img.kind === "png" ? "png" : "jpeg"};base64,${img.buf.toString("base64")}`,
          x: MARGIN + (area.w - exact.w) / 2,
          y: BODY_Y,
          w: exact.w,
          h: exact.h,
        });
        if (b.caption)
          s.addText(
            b.caption,
            box(
              {
                x: MARGIN,
                y: BODY_Y + exact.h + 0.1,
                w: boxW,
                h: capPt / 72,
                italic: true,
                align: "center",
                valign: "top",
                paraSpaceAfter: PARA_GAP_PT,
              },
              14,
            ),
          );
        break;
      }
      case "references":
        setHeading(b.title ?? DEFAULT_REFERENCES_TITLE);
        b.items.forEach((item, i) => pending.push({ text: `[${i + 1}] ${item}` }));
        flush();
        break;
    }
  }
  flush();
  headingSlide();
  return Buffer.from(await pres.write({ outputType: "nodebuffer" }));
}

/** Inches of a `w × h` pixel picture at 96 dpi scaled down (never up) to fit `maxW × maxH` inches. */
function fitExact(w, h, maxW, maxH) {
  const s = Math.min(1 / 96, maxW / w, maxH / h);
  return { w: w * s, h: h * s };
}
