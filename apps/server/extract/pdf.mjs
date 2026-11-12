// PDF (#48): text by page with each line's box (pdf.js, no rendering — no canvas, no fonts loaded, no scripts:
// `isEvalSupported: false`, XFA off), and OCR of pages that have no text but a picture (a scan). Limits: pages
// read (`maxPages`; the rest is `truncated`), pages OCR'd (`maxOcrPages`; the rest is `ocr: "partial"`) and image
// size (`maxImagePixels`: larger images are not decoded at all).
import { ExtractError } from "./errors.mjs";
import { grayPng, toGray } from "./image.mjs";

export const PDF_LIMITS = { maxPages: 500, maxOcrPages: 30, maxImagePixels: 40_000_000 };

/** A page with fewer visible characters than this and a picture is treated as a scan. */
const MIN_TEXT = 8;

const r4 = (x) => Math.round(Math.min(1, Math.max(0, x)) * 10000) / 10000;

/**
 * Points in page space (PDF units) → the box around them as `[x, y, w, h]`, fractions of the page as shown (rotation
 * applied), top-left origin. Every corner is mapped (review #107 12차): two diagonal corners of a rotated or skewed
 * shape do not bound it.
 */
function normPoints(vp, points) {
  // The viewport's matrix maps page space to its pixels (scale 1, rotation applied, origin top left).
  const [m0, m1, m2, m3, m4, m5] = vp.transform;
  const xs = [];
  const ys = [];
  for (const [x, y] of points) {
    xs.push(m0 * x + m2 * y + m4);
    ys.push(m1 * x + m3 * y + m5);
  }
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  return [
    r4(left / vp.width),
    r4(top / vp.height),
    r4((Math.max(...xs) - left) / vp.width),
    r4((Math.max(...ys) - top) / vp.height),
  ];
}

/** A rectangle in page space (PDF units) → `[x, y, w, h]` (`normPoints` of its four corners). */
function normBox(vp, x0, y0, x1, y1) {
  return normPoints(vp, [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]);
}

/** A page's text items as lines: `{ text, marks }` with one mark (and box) per line. */
function pageLines(items, vp) {
  const lines = [];
  let cur = null;
  let lastY = null;
  let lastEnd = null;
  const flush = () => {
    if (cur && cur.text.trim()) lines.push(cur);
    cur = null;
  };
  for (const it of items) {
    if (typeof it.str !== "string") continue;
    const [, , , , e, f] = it.transform;
    const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 1;
    if (cur && lastY !== null && Math.abs(f - lastY) > size * 0.5) flush();
    if (it.str) {
      if (!cur) cur = { text: "", box: null };
      // A gap wider than a third of the font size between two pieces of one line is a space.
      if (
        cur.text &&
        lastEnd !== null &&
        e - lastEnd > size * 0.3 &&
        !/\s$/.test(cur.text) &&
        !/^\s/.test(it.str)
      )
        cur.text += " ";
      cur.text += it.str;
      const x0 = e;
      const x1 = e + (it.width || 0);
      const y0 = f - size * 0.2;
      const y1 = f + (it.height || size);
      cur.box = cur.box
        ? [
            Math.min(cur.box[0], x0),
            Math.min(cur.box[1], y0),
            Math.max(cur.box[2], x1),
            Math.max(cur.box[3], y1),
          ]
        : [x0, y0, x1, y1];
      lastEnd = x1;
      lastY = f;
    }
    if (it.hasEOL) flush();
  }
  flush();
  let text = "";
  const marks = [];
  for (const l of lines) {
    if (text) text += "\n";
    const s = text.length;
    text += l.text;
    marks.push([s, text.length, { bbox: normBox(vp, ...l.box) }]);
  }
  return { text, marks };
}

const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

/** The largest picture drawn on the page with the matrix it is drawn with (image space → page space). */
async function largestImage(page, OPS) {
  const ops = await page.getOperatorList();
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let best = null;
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (Array.isArray(args?.[0]) && args[0].length === 6) ctm = mul(ctm, args[0]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject) {
      const area = Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]);
      if (!best || area > best.area) best = { area, ctm, ref: args[0] };
    }
  }
  if (!best) return undefined;
  let img = best.ref;
  if (typeof img === "string") {
    const objs = img.startsWith("g_") ? page.commonObjs : page.objs;
    try {
      img = objs.get(img);
    } catch {
      return undefined;
    }
  }
  return img?.data ? { img, ctm: best.ctm } : undefined;
}

/** OCR of one page's picture: words with boxes mapped from image pixels to the page. */
async function ocrPage(page, vp, OPS, ocr) {
  const found = await largestImage(page, OPS);
  if (!found) return undefined;
  const { img, ctm } = found;
  const gray = toGray(img);
  if (!gray) return undefined;
  const { text, marks } = await ocr.recognize(grayPng(gray, img.width, img.height));
  // Image space is the unit square, its first row at the top (v = 1).
  const toPage = (px, py) => {
    const u = px / img.width;
    const v = 1 - py / img.height;
    return [ctm[0] * u + ctm[2] * v + ctm[4], ctm[1] * u + ctm[3] * v + ctm[5]];
  };
  return {
    text,
    // A word's four corners through the picture's matrix (rotated, skewed or flipped) and the page's rotation.
    marks: marks.map(([s, e, { box }]) => [
      s,
      e,
      {
        bbox: normPoints(vp, [
          toPage(box[0], box[1]),
          toPage(box[2], box[1]),
          toPage(box[2], box[3]),
          toPage(box[0], box[3]),
        ]),
      },
    ]),
  };
}

/**
 * Reads a PDF into `out`: `page` segments (text pages, each line a mark with its box) and `ocr_box` segments
 * (scanned pages, each word a mark with its box). Returns `{ units, truncated, ocr }`.
 */
export async function pdf(buf, out, { pdfjs, assets, ocr, limits = PDF_LIMITS }) {
  let task;
  let doc;
  try {
    task = pdfjs.getDocument({
      data: new Uint8Array(buf.buffer, buf.byteOffset, buf.length),
      cMapUrl: assets.cmaps,
      cMapPacked: true,
      standardFontDataUrl: assets.standardFonts,
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
      enableXfa: false,
      isOffscreenCanvasSupported: false,
      isImageDecoderSupported: false,
      maxImageSize: limits.maxImagePixels,
      stopAtErrors: false,
      verbosity: 0,
    });
    doc = await task.promise;
  } catch (e) {
    await task?.destroy();
    if (e?.name === "PasswordException") throw new ExtractError("extract_encrypted");
    throw new ExtractError("extract_invalid");
  }
  let state = "none";
  let ocrPages = 0;
  let engine;
  try {
    const pages = doc.numPages;
    const n = Math.min(pages, limits.maxPages);
    for (let p = 1; p <= n; p++) {
      if (out.stopHere()) break;
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const { text, marks } = pageLines(content.items, vp);
      if (text.replace(/\s/g, "").length >= MIN_TEXT) out.add(p, { kind: "page", page: p }, text, marks);
      else if (!ocr || ocrPages >= limits.maxOcrPages) {
        // A page without text: a scan if it has a picture — one this server cannot read (no OCR) or will not (past
        // the OCR page limit). Its few characters are kept; what the picture holds is not read: a boundary there.
        const scan = (await largestImage(page, pdfjs.OPS)) !== undefined;
        if (text.trim()) out.add(p, { kind: "page", page: p }, text, marks);
        if (scan) {
          out.boundary();
          state = !ocr ? "unavailable" : "partial";
        }
      } else {
        engine ??= await ocr.create();
        const read = await ocrPage(page, vp, pdfjs.OPS, engine);
        if (read) {
          ocrPages++;
          if (state === "none") state = "done";
        }
        // Two content layers (review #107 12차 decision): the page's own few characters (never dropped — 10차),
        // then what OCR read, in Tesseract's own order (block, paragraph, line, word — never re-sorted here).
        // The own layer ends early when OCR text follows: the layers never join in one match, and a value cut
        // off at the boundary is masked by the tail rule. A value split across the two layers is out of scope
        // (docs/decisions/isolation.md).
        if (text.trim()) out.add(p, { kind: "page", page: p }, text, marks);
        if (read && read.text.trim()) {
          if (text.trim()) out.boundary();
          out.add(p, { kind: "ocr_box", page: p }, read.text, read.marks);
        }
      }
      page.cleanup();
    }
    // Pages past the limit are not read: the document ends early after the last page taken.
    if (pages > n) out.end();
    return { units: pages, ocr: state };
  } finally {
    await engine?.close();
    await task.destroy();
  }
}
