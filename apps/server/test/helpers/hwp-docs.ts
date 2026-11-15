import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { openCfb } from "../../extract/cfb.mjs";

/**
 * Small HWP and HWPX documents built in a test (#23, review #120): HWPX from section XML (into the package of
 * `sample.hwpx`), HWP from section records (written over the uncompressed section stream of `report.hwp`, padded
 * with a record the extractor skips). Used for the left-out-part matrix — every excluded kind × where the secret is.
 */

const FIX = path.resolve(import.meta.dirname, "../../../../fixtures/extract");

// ---- HWPX -----------------------------------------------------------------------------------------------------

export const xp = (inner: string) => `<hp:p><hp:run>${inner}</hp:run></hp:p>`;
export const xt = (s: string) => `<hp:t>${s}</hp:t>`;
/** A part the extractor leaves out (hidden): `header`, `footer`, `hiddenComment`. */
export const xskip = (kind: string, text: string) =>
  `<hp:ctrl><hp:${kind}><hp:subList>${xp(xt(text))}</hp:subList></hp:${kind}></hp:ctrl>`;
export const xnote = (text: string, number = 1) =>
  `<hp:ctrl><hp:footNote number="${number}"><hp:subList>${xp(xt(text))}</hp:subList></hp:footNote></hp:ctrl>`;
export const xtable = (cell: string) =>
  `<hp:tbl rowCnt="1" colCnt="1"><hp:tr><hp:tc><hp:subList>${xp(cell)}</hp:subList>` +
  `<hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc></hp:tr></hp:tbl>`;

/** An HWPX package whose only section holds `body` (paragraph XML). */
export async function hwpxDoc(body: string): Promise<Buffer> {
  const z = await JSZip.loadAsync(fs.readFileSync(path.join(FIX, "sample.hwpx")));
  z.file(
    "Contents/section0.xml",
    `<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" ` +
      `xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">${body}</hs:sec>`,
  );
  const hpf = await z.file("Contents/content.hpf")!.async("string");
  z.file("Contents/content.hpf", hpf.replace(/<opf:itemref idref="section1"[^>]*\/>/g, ""));
  z.remove("Contents/section1.xml");
  return z.generateAsync({ type: "nodebuffer" });
}

// ---- HWP 5.0 --------------------------------------------------------------------------------------------------

export function rec(tag: number, level: number, body: Buffer): Buffer {
  const long = body.length >= 0xfff;
  const h = Buffer.alloc(long ? 8 : 4);
  h.writeUInt32LE((tag | (level << 10) | ((long ? 0xfff : body.length) << 20)) >>> 0);
  if (long) h.writeUInt32LE(body.length, 4);
  return Buffer.concat([h, body]);
}
const CODE: Record<string, number> = { "tbl ": 11, "fn  ": 17, "en  ": 17, head: 16, foot: 16, tcmt: 15 };
const id = (cid: string) => Buffer.from(cid, "latin1").readUInt32BE(0);
/** Text of a paragraph: a string, or a control's character (`{ ctrl }`) at its place. */
export type Piece = string | { ctrl: string };
function chars(pieces: Piece[]): Buffer {
  return Buffer.concat([
    ...pieces.map((p) => {
      if (typeof p === "string") return Buffer.from(p, "utf16le");
      const b = Buffer.alloc(16);
      b.writeUInt16LE(CODE[p.ctrl]!, 0);
      b.writeUInt32LE(id(p.ctrl), 2);
      b.writeUInt16LE(CODE[p.ctrl]!, 14);
      return b;
    }),
    Buffer.from("\r", "utf16le"),
  ]);
}
/** A paragraph at `level`: its text and then its controls' records (built at level + 1). */
export const hpara = (level: number, pieces: Piece[], controls: ((level: number) => Buffer)[] = []) =>
  Buffer.concat([
    rec(66, level, Buffer.alloc(24)),
    rec(67, level + 1, chars(pieces)),
    ...controls.map((c) => c(level + 1)),
  ]);
/** A control with one list of one paragraph: a header, footer, hidden comment, footnote (`number`). */
export const hlist =
  (cid: string, text: string, number = 0) =>
  (level: number) => {
    const head = Buffer.alloc(16);
    head.writeUInt32LE(id(cid), 0);
    head.writeUInt32LE(number, 4);
    return Buffer.concat([
      rec(71, level, head),
      rec(72, level + 1, Buffer.alloc(16)),
      hpara(level + 1, [text]),
    ]);
  };
/** A 1×1 table whose cell holds `pieces` (and `controls`). */
export const htable =
  (pieces: Piece[], controls: ((level: number) => Buffer)[] = []) =>
  (level: number) => {
    const head = Buffer.alloc(46);
    head.writeUInt32LE(id("tbl "), 0);
    const table = Buffer.alloc(22);
    table.writeUInt16LE(1, 4);
    table.writeUInt16LE(1, 6);
    const cell = Buffer.alloc(34);
    cell.writeUInt16LE(1, 0);
    cell.writeUInt16LE(1, 12); // column span
    cell.writeUInt16LE(1, 14); // row span
    return Buffer.concat([
      rec(71, level, head),
      rec(77, level + 1, table),
      rec(72, level + 1, cell),
      hpara(level + 1, pieces, controls),
    ]);
  };

/** An HWP 5.0 file whose only section is `section` (records). */
export function hwpDoc(section: Buffer): Buffer {
  const file = Buffer.from(fs.readFileSync(path.join(FIX, "report.hwp")));
  const raw = openCfb(file).read("BodyText/Section0")!;
  const at = file.indexOf(raw);
  if (at < 0 || section.length + 8 > raw.length) throw new Error("section does not fit");
  // A record the extractor skips (tag 0) fills the rest of the stream.
  Buffer.concat([section, rec(0, 0, Buffer.alloc(raw.length - section.length - 8))]).copy(file, at);
  return file;
}

// ---- the left-out-part matrix (review #120) --------------------------------------------------------------------

export const HWP_SKIPS = ["head", "foot", "tcmt"] as const;
export const HWPX_SKIPS = ["header", "footer", "hiddenComment"] as const;
/**
 * Where a secret's base64 `B` is split by a left-out part:
 * - `prefix`: kept text ends with `B[:40]`, the rest is left out;
 * - `suffix`: `B[:8]` is left out, the kept text after it starts with `B[8:]`;
 * - `note`: a footnote right before the left-out part ends with `B[:40]`;
 * - `table`: a table right before the left-out part, its cell ends with `B[:40]`.
 */
export const PLACES = ["prefix", "suffix", "note", "table"] as const;
export type Case = { format: "hwp" | "hwpx"; kind: string; place: (typeof PLACES)[number]; fragment: string };

export async function matrixDoc(c: Omit<Case, "fragment">, b64: string): Promise<Case & { doc: Buffer }> {
  const head = b64.slice(0, 40);
  const rest = b64.slice(40);
  if (c.format === "hwpx") {
    const sk = (t: string) => xskip(c.kind, t);
    const body = {
      prefix: xp(xt(`앞 문장 ${head}`) + sk(rest) + xt(" 뒤 문장.")),
      suffix: xp(xt("앞 문장 ") + sk(b64.slice(0, 8)) + xt(`${b64.slice(8)} 뒤 문장.`)),
      note: xp(xt("앞 문장") + xnote(`각주 ${head}`, 7) + sk(rest) + xt("뒤 문장.")),
      table: xp(xt("앞 문장") + xtable(xt(`셀 ${head}`)) + sk(rest) + xt("뒤 문장.")),
    }[c.place];
    return { ...c, fragment: c.place === "suffix" ? b64.slice(8) : head, doc: await hwpxDoc(body) };
  }
  const sk = (t: string) => hlist(c.kind, t);
  const ctrl = { ctrl: c.kind };
  const section = {
    prefix: hpara(0, [`앞 문장 ${head}`, ctrl, " 뒤 문장."], [sk(rest)]),
    suffix: hpara(0, ["앞 문장 ", ctrl, `${b64.slice(8)} 뒤 문장.`], [sk(b64.slice(0, 8))]),
    note: hpara(
      0,
      ["앞 문장", { ctrl: "fn  " }, ctrl, "뒤 문장."],
      [hlist("fn  ", `각주 ${head}`, 7), sk(rest)],
    ),
    table: hpara(0, ["앞 문장", { ctrl: "tbl " }, ctrl, "뒤 문장."], [htable([`셀 ${head}`]), sk(rest)]),
  }[c.place];
  return { ...c, fragment: c.place === "suffix" ? b64.slice(8) : head, doc: hwpDoc(section) };
}

export const MATRIX: Omit<Case, "fragment">[] = [
  ...HWP_SKIPS.flatMap((kind) => PLACES.map((place) => ({ format: "hwp" as const, kind, place }))),
  ...HWPX_SKIPS.flatMap((kind) => PLACES.map((place) => ({ format: "hwpx" as const, kind, place }))),
];

// ---- alternatives (HWPX `hp:switch`, review #120 4차) -------------------------------------------------------------

/** A switch: one `hp:case` (never read) and its `hp:default` (read; `null`: no default at all). */
export const xswitch = (caseText: string, defaultInner: string | null) =>
  `<hp:switch><hp:case hp:required-namespace="urn:x">${xt(caseText)}</hp:case>` +
  (defaultInner === null ? "" : `<hp:default>${defaultInner}</hp:default>`) +
  `</hp:switch>`;
/**
 * `B[:40]` ends kept text, a switch follows, then " 뒤 문장.":
 * - `default`: the rest is in the default (read), the case holds other words;
 * - `both`: the rest is in the case and in the default;
 * - `case`: the rest is only in the case (never read: out of scope, like a picture's text).
 * `masked`: what of `B` the kept text must not hold; `never`: text that must not appear anywhere (case-only).
 */
export const SWITCHES = ["default", "both", "case"] as const;
export async function switchDoc(v: (typeof SWITCHES)[number], b64: string) {
  const head = b64.slice(0, 40);
  const rest = b64.slice(40);
  const sw = {
    default: xswitch("상관없는 설명", xt(rest)),
    both: xswitch(rest, xt(rest)),
    case: xswitch(rest, xt("다른 글")),
  }[v];
  return {
    doc: await hwpxDoc(xp(xt(`앞 문장 ${head}`) + sw + xt(" 뒤 문장.")) + xp(xt("다음 문단."))),
    masked: v === "case" ? [] : [head, rest],
    never: v === "case" ? [rest] : [],
  };
}

/** `hp:switch` → `hp:default` (an unread case first) around `inner`, `depth` times (review #120 5차). */
export const xwrap = (inner: string, depth = 1): string =>
  depth <= 0
    ? inner
    : xwrap(
        `<hp:switch><hp:case hp:required-namespace="urn:x">${xt("UNREAD")}</hp:case><hp:default>${inner}</hp:default></hp:switch>`,
        depth - 1,
      );
export const xsub = (inner: string) => `<hp:subList>${xp(inner)}</hp:subList>`;
/** A 2×1 table: row 1 holds `first` (plain), row 2 holds `second` with its subList inside a switch's default. */
export const xtableWrapped = (first: string, second: string, depth = 1) =>
  `<hp:tbl rowCnt="2" colCnt="1">` +
  `<hp:tr><hp:tc>${xsub(xt(first))}<hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc></hp:tr>` +
  `<hp:tr><hp:tc>${xwrap(xsub(xt(second)), depth)}<hp:cellAddr colAddr="0" rowAddr="1"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc></hp:tr>` +
  `</hp:tbl>`;
