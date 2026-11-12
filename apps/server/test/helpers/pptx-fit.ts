import { createRequire } from "node:module";
import { docLibraries } from "../../src/docgen/runner.js";
/**
 * An independent check that a generated PPTX never runs text off its boxes (#49 review 2) — written apart from the
 * generator (apps/server/docgen/pptx.mjs) and sharing nothing with it: it re-parses the slide XML and lays every
 * text run out again with a conservative rule of its own — the grapheme width classes below at its run's size,
 * lines broken between graphemes — using the font size, the exact line spacing (`a:lnSpc/a:spcPts`), the
 * paragraph spacing, the bullet margin, the box insets, the table column widths and cell margins written in the file.
 *
 * - a text box: its paragraphs' height ≤ its height less the top and bottom insets, and the box ends on the slide
 * - a table: each row as tall as its tallest cell (lines × spacing + cell margins); the rows' sum, from the table's
 *   top, ends on the slide
 */

const EMU_PER_PT = 12700;
const SLIDE_H_PT = 7.5 * 72;
/** PowerPoint's defaults where the file says nothing. */
const DEFAULT_INSET = { l: 91440, r: 91440, t: 45720, b: 45720 };
const DEFAULT_CELL = { l: 91440, r: 91440, t: 45720, b: 45720 };
const DEFAULT_LINE = 1.2;

const attr = (xml: string, name: string): number | undefined => {
  const m = new RegExp(`\\b${name}="(-?\\d+)"`).exec(xml);
  return m ? Number(m[1]) : undefined;
};
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === "#"
      ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
      : ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[e.toLowerCase()]!,
  );

type Para = { text: string; sizePt: number; linePt: number; afterPt: number; marLPt: number };

/** Paragraphs of a text body: text (line breaks `a:br` as "\n"), size, spacing and left margin. */
function paragraphs(body: string): Para[] {
  return [...body.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((m) => {
    const p = m[1]!;
    const pPr = /<a:pPr[^>]*>([\s\S]*?)<\/a:pPr>|<a:pPr[^>]*\/>/.exec(p)?.[0] ?? "";
    const sizes = [...p.matchAll(/<a:(?:rPr|endParaRPr)\b[^>]*\bsz="(\d+)"/g)].map((s) => Number(s[1]) / 100);
    const sizePt = sizes.length ? Math.max(...sizes) : 18;
    const spc = /<a:lnSpc><a:spcPts val="(\d+)"\/><\/a:lnSpc>/.exec(pPr);
    const after = /<a:spcAft><a:spcPts val="(\d+)"\/><\/a:spcAft>/.exec(pPr);
    const text = [...p.matchAll(/<a:t>([^<]*)<\/a:t>|<a:br\/>/g)]
      .map((t) => (t[1] === undefined ? "\n" : decode(t[1])))
      .join("");
    return {
      text,
      sizePt,
      linePt: spc ? Number(spc[1]) / 100 : sizePt * DEFAULT_LINE,
      afterPt: after ? Number(after[1]) / 100 : 0,
      marLPt: (attr(pPr.split(">")[0] ?? "", "marL") ?? 0) / EMU_PER_PT,
    };
  });
}

/**
 * The width rules of the review-3/4 decisions, implemented here on their own (Unicode properties and a measurement
 * of the embedded font — not the generator's tables):
 * - a code point: a tab four em; an emoji pictograph or a regional indicator two em; one em when it is Hangul, Han, kana, Latin, Greek, Cyrillic, a digit, punctuation,
 *   a symbol or a space and Gothic A1 (regular and bold, measured here with fontkit) does not draw it wider than one
 *   em; anything else two em;
 * - a grapheme: the sum of its code points, except a combining mark half an em, Hangul jamo composing to one
 *   syllable one em, an emoji ZWJ / U+FE0F sequence two em flat, a lone zero-width format character nothing.
 */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export const graphemesOf = (t: string) => Array.from(segmenter.segment(t), (s) => s.segment);
const ONE_EM_CLASS =
  /^[\p{Script=Hangul}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Nd}\p{P}\p{S}\p{Zs}]$/u;

type Font = {
  unitsPerEm: number;
  characterSet: number[];
  glyphForCodePoint(c: number): { advanceWidth: number };
};
let wide: Set<number> | undefined;
/** Code points the embedded font draws wider than one em, in either weight (measured once). */
export function measuredWide(): Set<number> {
  if (wide) return wide;
  const req = createRequire(createRequire(import.meta.url).resolve("pdfkit"));
  const fontkit = req("fontkit") as { openSync(p: string): Font };
  wide = new Set();
  const fonts = docLibraries().fonts;
  for (const file of [fonts.regular, fonts.bold]) {
    const f = fontkit.openSync(file);
    for (const c of f.characterSet) if (f.glyphForCodePoint(c).advanceWidth / f.unitsPerEm > 1) wide.add(c);
  }
  return wide;
}

export function codePointEmOf(c: string): number {
  if (c === "\t") return 4;
  if (/^[\p{Extended_Pictographic}\p{Regional_Indicator}]$/u.test(c)) return 2; // emoji, flag letters
  return ONE_EM_CLASS.test(c) && !measuredWide().has(c.codePointAt(0)!) ? 1 : 2;
}

export function emOf(g: string): number {
  const cs = Array.from(g);
  if (cs.length === 1) return ["\u200b", "\u200c", "\u200d", "\ufeff"].includes(g) ? 0 : codePointEmOf(g);
  if (/\p{Extended_Pictographic}/u.test(g) && (g.includes("\u200d") || g.includes("\ufe0f"))) return 2;
  if (cs.every((c) => /^\p{Script=Hangul}$/u.test(c)) && Array.from(g.normalize("NFC")).length === 1)
    return 1;
  return cs.reduce((em, c) => em + (/^[\p{Mn}\p{Me}]$/u.test(c) ? 0.5 : codePointEmOf(c)), 0);
}

/** Lines of one paragraph in `widthPt`, by those classes, broken between graphemes. */
export function linesAtOneEm(text: string, sizePt: number, widthPt: number): number {
  let lines = 0;
  for (const seg of text.split("\n")) {
    let em = 0;
    let n = 1;
    for (const g of graphemesOf(seg)) {
      const w = emOf(g);
      if (em > 0 && (em + w) * sizePt > widthPt) {
        n++;
        em = 0;
      }
      em += w;
    }
    lines += n;
  }
  return lines;
}

const heightOf = (paras: Para[], widthPt: number) =>
  paras.reduce((h, p) => h + linesAtOneEm(p.text, p.sizePt, widthPt - p.marLPt) * p.linePt + p.afterPt, 0);

export type Overflow = { slide: number; what: string; needPt: number; havePt: number };

/** Every text box and table of every slide that would not hold its text (empty when all fit). */
export function overflows(slides: string[]): Overflow[] {
  const out: Overflow[] = [];
  slides.forEach((xml, i) => {
    for (const sp of xml.matchAll(/<p:sp>([\s\S]*?)<\/p:sp>/g)) {
      const s = sp[1]!;
      const off = /<a:off x="(-?\d+)" y="(-?\d+)"\/>/.exec(s);
      const ext = /<a:ext cx="(\d+)" cy="(\d+)"\/>/.exec(s);
      const body = /<p:txBody>([\s\S]*?)<\/p:txBody>/.exec(s)?.[1];
      if (!off || !ext || !body) continue;
      const bodyPr = /<a:bodyPr[^>]*>/.exec(body)?.[0] ?? "";
      const ins = {
        l: attr(bodyPr, "lIns") ?? DEFAULT_INSET.l,
        r: attr(bodyPr, "rIns") ?? DEFAULT_INSET.r,
        t: attr(bodyPr, "tIns") ?? DEFAULT_INSET.t,
        b: attr(bodyPr, "bIns") ?? DEFAULT_INSET.b,
      };
      const widthPt = (Number(ext[1]) - ins.l - ins.r) / EMU_PER_PT;
      const havePt = (Number(ext[2]) - ins.t - ins.b) / EMU_PER_PT;
      const paras = paragraphs(body);
      const needPt = heightOf(paras, widthPt);
      const what = `box "${paras
        .map((p) => p.text)
        .join(" ")
        .slice(0, 30)}"`;
      if (needPt > havePt + 0.01) out.push({ slide: i + 1, what, needPt, havePt });
      const bottomPt = (Number(off[2]) + Number(ext[2])) / EMU_PER_PT;
      if (bottomPt > SLIDE_H_PT)
        out.push({ slide: i + 1, what: `${what} below the slide`, needPt: bottomPt, havePt: SLIDE_H_PT });
    }
    for (const gf of xml.matchAll(/<p:graphicFrame>([\s\S]*?)<\/p:graphicFrame>/g)) {
      const g = gf[1]!;
      const top = Number(/<a:off x="-?\d+" y="(-?\d+)"\/>/.exec(g)![1]) / EMU_PER_PT;
      const cols = [...g.matchAll(/<a:gridCol w="(\d+)"\/>/g)].map((c) => Number(c[1]));
      let total = 0;
      for (const tr of g.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)) {
        let row = 0;
        [...tr[1]!.matchAll(/<a:tc>([\s\S]*?)<\/a:tc>/g)].forEach((tc, j) => {
          const tcPr = /<a:tcPr[^>]*>/.exec(tc[1]!)?.[0] ?? "";
          const m = {
            l: attr(tcPr, "marL") ?? DEFAULT_CELL.l,
            r: attr(tcPr, "marR") ?? DEFAULT_CELL.r,
            t: attr(tcPr, "marT") ?? DEFAULT_CELL.t,
            b: attr(tcPr, "marB") ?? DEFAULT_CELL.b,
          };
          const widthPt = (cols[j]! - m.l - m.r) / EMU_PER_PT;
          const body = /<a:txBody>([\s\S]*?)<\/a:txBody>/.exec(tc[1]!)?.[1] ?? "";
          row = Math.max(row, heightOf(paragraphs(body), widthPt) + (m.t + m.b) / EMU_PER_PT);
        });
        total += row;
      }
      if (top + total > SLIDE_H_PT + 0.01)
        out.push({ slide: i + 1, what: "table", needPt: top + total, havePt: SLIDE_H_PT });
    }
  });
  return out;
}

/** Each table column's text over all slides, in order (cells of one column joined; paragraphs by "\n"). */
export function tableColumns(slides: string[]): string[][] {
  const tables: string[][][] = [];
  for (const xml of slides)
    for (const gf of xml.matchAll(/<a:tbl>([\s\S]*?)<\/a:tbl>/g))
      tables.push(
        [...gf[1]!.matchAll(/<a:tr\b[^>]*>([\s\S]*?)<\/a:tr>/g)].map((tr) =>
          [...tr[1]!.matchAll(/<a:tc>([\s\S]*?)<\/a:tc>/g)].map((tc) =>
            paragraphs(/<a:txBody>([\s\S]*?)<\/a:txBody>/.exec(tc[1]!)?.[1] ?? "")
              .map((p) => p.text)
              .join("\n"),
          ),
        ),
      );
  return tables;
}
