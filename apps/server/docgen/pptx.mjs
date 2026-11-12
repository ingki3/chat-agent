// PPTX (PowerPoint) from a checked document (#49) with `pptxgenjs`, 16:9. The title slide (title, subtitle,
// author), then a slide per heading with the paragraphs and lists under it; each table gets its own slide (more
// when it does not fit, header repeated), each picture its own slide, and the references end the deck.
//
// PowerPoint does not flow text from one slide to the next and nothing here shrinks text on open, so the text is
// laid out here: every paragraph and list item is wrapped into estimated lines (a Hangul or other wide character
// counts one em, anything else 0.6 em — wider than real glyphs, so the estimate errs on the safe side) and the lines
// are packed into slides by height; a paragraph that does not fit is cut between lines and continues on the next
// slide ("(계속)"). A heading with nothing under it still gets its slide; a heading too long for the title box goes
// into the body instead. Nothing of the document is dropped.
import { DEFAULT_REFERENCES_TITLE, cellText, imageOf } from "./common.mjs";

const FONT = "맑은 고딕";
const W = 13.333;
const MARGIN = 0.5;
const TITLE_Y = 0.3;
const TITLE_H = 0.95;
const TITLE_SIZE = 26;
const BODY_Y = 1.3;
const BODY_H = 5.8;
const BODY_SIZE = 18;
const PARA_GAP_PT = 6;
/** Text box width in points, less the box's insets (0.1 in each side) and a bullet's indent. */
const TEXT_PT = (W - 2 * MARGIN) * 72 - 14.4 - 27;
/** Of the body box's height, what the estimate may fill (the rest is a safety margin). */
const BODY_BUDGET_PT = (BODY_H * 72 - 7.2) * 0.9;
const LINE = 1.2;

/** Wide characters: Hangul, CJK, kana, full-width forms — one em each. */
const WIDE = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿︰-﹏＀-￯]|[\u{20000}-\u{3fffd}]/u;
const charEm = (c) => (WIDE.test(c) ? 1 : c === " " ? 0.35 : 0.6);

/**
 * Lines of `text` at `size` points in `widthPt`: hard breaks kept (`hard`: the line starts after a line break of
 * the text), long runs wrapped between characters. Joining the lines (with "\n" before each hard one) gives back
 * the text exactly.
 */
export function wrapLines(text, size, widthPt = TEXT_PT) {
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

  /** The largest of `sizes` at which `text` fits `hIn` inches of height. */
  const sizeFor = (text, hIn, sizes) =>
    sizes.find((s) => wrapLines(text, s, boxW * 72 - 14.4).length * s * LINE <= hIn * 72 - 7.2) ?? null;

  const first = pres.addSlide();
  const titleSize = sizeFor(doc.title, 3, [36, 30, 24, 20, 16, 14, 12]);
  first.addText(doc.title, {
    x: MARGIN,
    y: 1.2,
    w: boxW,
    h: 3,
    fontFace: FONT,
    fontSize: titleSize ?? 12,
    bold: true,
    align: "center",
    valign: "bottom",
  });
  const sub = [doc.subtitle, doc.author].filter(Boolean).join("\n");
  if (sub)
    first.addText(sub, {
      x: MARGIN,
      y: 4.4,
      w: boxW,
      h: 2.4,
      fontFace: FONT,
      fontSize: sizeFor(sub, 2.4, [18, 16, 14, 12]) ?? 12,
      color: "555555",
      align: "center",
      valign: "top",
    });

  /** A slide with `title` in the title box (`title` fits it: `fitsTitle`). */
  const titled = (title) => {
    const s = pres.addSlide();
    if (title)
      s.addText(title, {
        x: MARGIN,
        y: TITLE_Y,
        w: boxW,
        h: TITLE_H,
        fontFace: FONT,
        fontSize: TITLE_SIZE,
        bold: true,
        valign: "middle",
      });
    return s;
  };
  const fitsTitle = (t) => wrapLines(t, TITLE_SIZE, boxW * 72 - 14.4).length <= 2;

  let heading = "";
  /** The current heading is on a slide already (a heading with nothing under it still gets one). */
  let shown = true;
  /** Paragraphs and list items waiting for the current heading's slides: `{ text, bullet?, bold? }`. */
  let pending = [];

  const flush = () => {
    if (!pending.length) return;
    const slides = [];
    let cur = [];
    let used = 0;
    // Each line costs its height; a line after a hard break is its own paragraph in the file (pptxgenjs splits
    // the text there), so it also costs the paragraph gap.
    const cost = (l, i) => BODY_SIZE * LINE + (i === 0 || l.hard ? PARA_GAP_PT : 0);
    for (const p of pending) {
      let lines = wrapLines(p.text, BODY_SIZE);
      let cont = false;
      while (lines.length) {
        let take = 0;
        let h = 0;
        while (take < lines.length && used + h + cost(lines[take], take) <= BODY_BUDGET_PT) {
          h += cost(lines[take], take);
          take++;
        }
        // Nothing fits, or only one line of a longer paragraph: the paragraph starts on the next slide.
        if (cur.length && (take === 0 || (take === 1 && lines.length > 1))) {
          slides.push(cur);
          cur = [];
          used = 0;
          continue;
        }
        take = Math.max(take, 1);
        // A continued paragraph keeps its text; only its first piece carries the bullet.
        cur.push({ ...p, text: joinLines(lines.slice(0, take)), bullet: cont ? undefined : p.bullet });
        used += h;
        lines = lines.slice(take);
        cont = true;
      }
    }
    if (cur.length) slides.push(cur);
    slides.forEach((chunk, i) => {
      const s = titled(i ? (heading ? `${heading} (계속)` : "(계속)") : heading);
      s.addText(
        chunk.map((l, j) => ({
          text: l.text,
          options: {
            ...(l.bullet ? { bullet: l.bullet } : {}),
            ...(l.bold ? { bold: true } : {}),
            breakLine: j < chunk.length - 1,
            paraSpaceAfter: PARA_GAP_PT,
          },
        })),
        { x: MARGIN, y: BODY_Y, w: boxW, h: BODY_H, fontFace: FONT, fontSize: BODY_SIZE, valign: "top" },
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
        const s = titled(title);
        const head = b.columns.map((c) => ({ text: c, options: { bold: true, fill: { color: "EEEEEE" } } }));
        s.addTable([head, ...b.rows.map((r) => r.map((c) => ({ text: cellText(c) })))], {
          x: MARGIN,
          y: BODY_Y,
          w: boxW,
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
        shown = true;
        const s = titled(heading);
        // The caption's own height (estimated like the body), the picture fills the rest.
        const capLines = b.caption ? wrapLines(b.caption, 14, boxW * 72 - 14.4).length : 0;
        const capH = capLines ? Math.min(BODY_H - 1, (capLines * 14 * LINE + 10) / 72) : 0;
        const box = { w: boxW, h: BODY_H - capH - (capLines ? 0.1 : 0) };
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
            h: capH,
            fontFace: FONT,
            fontSize: 14,
            italic: true,
            align: "center",
            valign: "top",
          });
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
