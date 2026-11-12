// Text widths the PPTX layout counts with (#49 review 3) — the one table of them. PowerPoint does not flow text and
// a viewer may substitute any font, so the layout uses widths that bound the glyphs of the characters it supports:
//
// - Text is measured in graphemes (user-perceived characters: "é" as e + U+0301, a ZWJ family, a flag, a Hangul
//   jamo sequence) and only ever broken between them.
// - A code point counts one em when it is in `ONE_EM_RANGES` and not one the embedded font draws wider
//   (`WIDER_THAN_ONE_EM`): Hangul, CJK ideographs, kana, Latin, Greek, Cyrillic, digits and the common punctuation
//   and symbols listed here. Any other code point counts two em; a tab four.
// - A grapheme counts the sum of its code points (review #110 4), except: a combining mark adds half an em; Hangul
//   jamo composing to one syllable count one em; an emoji ZWJ / U+FE0F sequence counts two em flat; a zero-width
//   format character (ZWSP, ZWNJ, ZWJ, U+FEFF) standing alone counts nothing.
// - REFUSED: blocks with glyphs known to be far wider than two em (Arabic presentation-form ligatures such as
//   U+FDFD, the per-mille and per-ten-thousand signs, the two- and three-em dashes). A PPTX with one is refused
//   (`doc_unsupported_text`) before anything is made. DOCX, XLSX and PDF are not affected: Word and Excel reflow,
//   and the PDF is laid out with the embedded font's real metrics.

/** [first, last] code points whose graphemes count one em. */
export const ONE_EM_RANGES = [
  [0x0020, 0x007e], // Basic Latin: letters, digits, punctuation
  [0x00a0, 0x00ff], // Latin-1 Supplement
  [0x0100, 0x024f], // Latin Extended-A, -B
  [0x0370, 0x03ff], // Greek
  [0x0400, 0x04ff], // Cyrillic
  [0x1100, 0x11ff], // Hangul Jamo
  [0x1e00, 0x1eff], // Latin Extended Additional
  [0x2010, 0x2027], // dashes, quotation marks, bullet, leader dots, ellipsis
  [0x2032, 0x2037], // primes
  [0x20a0, 0x20bf], // currency signs (₩ €)
  [0x2100, 0x214f], // letterlike symbols (℃ № ™)
  [0x2150, 0x218f], // number forms (Ⅰ Ⅱ ½)
  [0x2190, 0x21ff], // arrows
  [0x2200, 0x22ff], // mathematical operators
  [0x2460, 0x24ff], // enclosed alphanumerics (① ⓐ)
  [0x2500, 0x257f], // box drawing
  [0x25a0, 0x25ff], // geometric shapes (■ ○ ◆)
  [0x2c60, 0x2c7f], // Latin Extended-C
  [0x3000, 0x303f], // CJK symbols and punctuation
  [0x3040, 0x309f], // Hiragana
  [0x30a0, 0x30ff], // Katakana
  [0x3130, 0x318f], // Hangul Compatibility Jamo
  [0x31f0, 0x31ff], // Katakana Phonetic Extensions
  [0x3200, 0x32ff], // enclosed CJK letters and months (㈜)
  [0x3300, 0x33ff], // CJK compatibility (㎏ ㎡)
  [0x3400, 0x4dbf], // CJK Unified Ideographs Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa720, 0xa7ff], // Latin Extended-D
  [0xa960, 0xa97f], // Hangul Jamo Extended-A
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xd7b0, 0xd7ff], // Hangul Jamo Extended-B
  [0xff01, 0xffee], // halfwidth and fullwidth forms
];

/**
 * Code points inside `ONE_EM_RANGES` that the embedded font (Gothic A1, regular or bold) draws wider than one em —
 * counted two em. Measured with fontkit; a test measures every one-em code point again and keeps this list honest.
 */
// prettier-ignore
export const WIDER_THAN_ONE_EM = [
  [0x0025, 0x0025],
  [0x00bc, 0x00be],
  [0x00c6, 0x00c6],
  [0x0152, 0x0152],
  [0x019c, 0x019c],
  [0x01a2, 0x01a2],
  [0x01c4, 0x01c7],
  [0x01ca, 0x01cb],
  [0x01e2, 0x01e2],
  [0x01f1, 0x01f3],
  [0x01f6, 0x01f6],
  [0x01fc, 0x01fc],
  [0x03e2, 0x03e2],
  [0x0409, 0x040a],
  [0x0428, 0x0429],
  [0x042e, 0x042e],
  [0x0460, 0x0460],
  [0x046c, 0x046c],
  [0x0478, 0x0479],
  [0x047c, 0x047c],
  [0x047e, 0x047e],
  [0x0488, 0x0489],
  [0x04a6, 0x04a6],
  [0x04d4, 0x04d4],
  [0x2014, 0x2015],
  [0x2026, 0x2026],
  [0x20a7, 0x20a8],
  [0x20af, 0x20af],
  [0x2116, 0x2116],
  [0x2133, 0x2133],
  [0x2153, 0x2154],
  [0x215b, 0x215e],
  [0x2190, 0x2190],
  [0x2192, 0x2192],
  [0x2194, 0x2194],
  [0x2196, 0x219e],
  [0x21a0, 0x21a0],
  [0x21a2, 0x21a4],
  [0x21a6, 0x21a6],
  [0x21a9, 0x21ae],
  [0x21b6, 0x21bd],
  [0x21c0, 0x21c1],
  [0x21c4, 0x21c4],
  [0x21c6, 0x21c7],
  [0x21c9, 0x21c9],
  [0x21cd, 0x21d0],
  [0x21d2, 0x21d2],
  [0x21d4, 0x21d4],
  [0x21d6, 0x21dd],
  [0x21e0, 0x21e0],
  [0x21e2, 0x21e2],
  [0x21e4, 0x21e6],
  [0x21e8, 0x21e8],
  [0x21f0, 0x21f2],
  [0x21f4, 0x21f4],
  [0x21f6, 0x21ff],
  [0x221e, 0x221e],
  [0x2460, 0x24e9],
  [0x24eb, 0x24f4],
  [0x25a0, 0x25a9],
  [0x25ac, 0x25ad],
  [0x25b2, 0x25b3],
  [0x25b6, 0x25b7],
  [0x25bc, 0x25bd],
  [0x25c0, 0x25c1],
  [0x25c6, 0x25c9],
  [0x25cb, 0x25d1],
  [0x25d9, 0x25d9],
  [0x25e2, 0x25e5],
  [0x25ef, 0x25ef],
  [0x3004, 0x3004],
  [0x3007, 0x3007],
  [0x3200, 0x321c],
  [0x3220, 0x3229],
  [0x3231, 0x3232],
  [0x3239, 0x3239],
  [0x3251, 0x325a],
  [0x3260, 0x327b],
  [0x327e, 0x327f],
  [0x328a, 0x3290],
  [0x3294, 0x3294],
  [0x329e, 0x329e],
  [0x32a3, 0x32a8],
  [0x3380, 0x3391],
  [0x3393, 0x33aa],
  [0x33ac, 0x33ad],
  [0x33b0, 0x33c5],
  [0x33c7, 0x33cb],
  [0x33cd, 0x33ce],
  [0x33d0, 0x33d0],
  [0x33d2, 0x33d2],
  [0x33d5, 0x33d6],
  [0x33d8, 0x33d8],
  [0x33dc, 0x33dd],
];

/** [first, last] code points a PPTX refuses (`doc_unsupported_text`): glyphs far wider than two em. */
export const REFUSED_RANGES = [
  [0x2030, 0x2031], // ‰ ‱
  [0x2e3a, 0x2e3b], // ⸺ ⸻ (two- and three-em dashes)
  [0x3392, 0x3392], // CJK compatibility square drawn wider than two em
  [0x33ab, 0x33ab], // CJK compatibility square drawn wider than two em
  [0x33ae, 0x33af], // CJK compatibility square drawn wider than two em
  [0x33c6, 0x33c6], // CJK compatibility square drawn wider than two em
  [0xfb50, 0xfdff], // Arabic Presentation Forms-A (ﷲ ﷺ ﷽ …)
  [0xfe70, 0xfefe], // Arabic Presentation Forms-B (not U+FEFF, the BOM / zero-width no-break space: zero width)
];

export const TAB_EM = 4;
export const WIDE_EM = 2;

/** Conjoining Hangul jamo: a sequence of them (or a syllable and trailing jamo) is one grapheme, one syllable. */
const JAMO_RANGES = [
  [0x1100, 0x11ff],
  [0xa960, 0xa97f],
  [0xd7b0, 0xd7ff],
];
const inRanges = (cp, ranges) => ranges.some(([a, b]) => cp >= a && cp <= b);

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
/** The graphemes of `text`, in order (joined they give `text` back). */
export const graphemes = (text) => Array.from(segmenter.segment(text), (s) => s.segment);

/** Width of one code point in em, by its class: one em, or two (anything outside the one-em ranges). */
export function codePointEm(cp) {
  if (cp === 0x09) return TAB_EM;
  return inRanges(cp, ONE_EM_RANGES) && !inRanges(cp, WIDER_THAN_ONE_EM) && !inRanges(cp, REFUSED_RANGES)
    ? 1
    : WIDE_EM;
}

/** Zero-width format characters: ZWSP, ZWNJ, ZWJ, ZWNBSP/BOM — no width when they stand alone. */
const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0xfeff]);
const MARK = /^[\p{Mn}\p{Me}]$/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const SYLLABLE = /^[\uac00-\ud7a3]$/u;

/**
 * Width of one grapheme in em (review #110 4): the sum of its code points' class widths, except
 * - a combining mark (Mn, Me) adds half an em;
 * - Hangul jamo that compose (NFC) to exactly one syllable count one em;
 * - an emoji sequence (a pictograph with ZWJ or U+FE0F) counts two em flat;
 * - a zero-width format character standing alone counts nothing.
 */
export function graphemeEm(g) {
  const cps = Array.from(g, (c) => c.codePointAt(0));
  if (cps.length === 1) return ZERO_WIDTH.has(cps[0]) ? 0 : codePointEm(cps[0]);
  if (PICTOGRAPHIC.test(g) && (cps.includes(0x200d) || cps.includes(0xfe0f))) return WIDE_EM;
  if (
    cps.every((cp) => inRanges(cp, JAMO_RANGES) || (cp >= 0xac00 && cp <= 0xd7a3)) &&
    SYLLABLE.test(g.normalize("NFC"))
  )
    return 1;
  let em = 0;
  for (const cp of cps) em += MARK.test(String.fromCodePoint(cp)) ? 0.5 : codePointEm(cp);
  return em;
}

/** Whether `text` holds a code point a PPTX cannot bound (REFUSED_RANGES). */
export const hasRefused = (text) => {
  for (const c of text) if (inRanges(c.codePointAt(0), REFUSED_RANGES)) return true;
  return false;
};
