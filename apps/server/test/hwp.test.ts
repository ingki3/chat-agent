import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import JSZip from "jszip";
import { afterAll, describe, expect, it, vi } from "vitest";
import { EXTRACT_CODE_TEXT, FileLocator, locatorLabel } from "@agentlee/shared";
import { run } from "../extract/worker.mjs";
import { openCfb } from "../extract/cfb.mjs";
import { HWP_LIMITS, hwpSection, paraText } from "../extract/hwp.mjs";
import { Segments } from "../extract/segments.mjs";
import { contentMatches } from "../src/files/detect.js";
import {
  MATRIX,
  matrixDoc,
  SWITCHES,
  switchDoc,
  hwpxDoc,
  xp,
  xt,
  xswitch,
  xsub,
  xwrap,
  xtableWrapped,
} from "./helpers/hwp-docs.js";
import { keptSegments } from "../src/files/extract.js";
import { EXTRACTOR_VERSION, extractRunOptions, workerResult } from "../src/files/extract.js";
import { runIsolated } from "../src/isolation/sandbox.js";

/**
 * The HWP·HWPX extractor (#23, PRD FR-4.4): each fixture with the units and locators it must produce — body
 * paragraphs counted over the document, top-level tables by table and row (merged cells in their first row and
 * column), footnotes and endnotes as their own units anchored where they are, text boxes, captions and nested
 * tables joined to what holds them, headers left out — the same for both formats; password, DRM and distribution
 * documents refused with fixed codes and no text; hostile files (zlib bomb, looping sector chains, a DTD, a
 * package path out of the archive) refused; the limits through the builder; the sandboxed run (macOS).
 * Fixtures: fixtures/extract (make-hwp-fixtures.py) and fixtures/acceptance/injection/doc-injection.hwp.
 */

const FIX = path.resolve(import.meta.dirname, "../../../fixtures/extract");
const INJECTION = path.resolve(import.meta.dirname, "../../../fixtures/acceptance/injection");
const fixture = (name: string) => path.join(FIX, name);
const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentlee-hwp-")));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

type Seg = {
  hidden?: true;
  unit: number;
  loc: Record<string, unknown>;
  text: string;
  marks?: [number, number, Record<string, unknown>][];
  endsEarly?: boolean;
};
/** `segments`: the kept units; `all`: everything the worker gave, hidden units included, in reading order. */
type Out = {
  ok: true;
  sha256: string;
  units: number;
  truncated: boolean;
  ocr: string;
  segments: Seg[];
  all: Seg[];
};
const kindOf = (file: string) => file.split(".").pop()!;
const extract = async (file: string, limits?: object) => {
  const r = (await run({ path: file, kind: kindOf(file), ...(limits ? { limits } : {}) })) as Omit<
    Out,
    "all"
  >;
  return { ...r, all: r.segments, segments: r.segments.filter((x) => !x.hidden) } as Out;
};
/** The reading order with hidden units as `{ hidden: text }`. */
const order = (r: Out) => r.all.map((x) => (x.hidden ? { hidden: x.text } : x.text));
const refused = async (file: string, limits?: object, kind = kindOf(file)) => {
  try {
    await run({ path: file, kind, ...(limits ? { limits } : {}) });
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return "accepted";
};
const write = (name: string, data: Buffer | Uint8Array) => {
  const file = path.join(tmpRoot, name);
  fs.writeFileSync(file, data);
  return file;
};
/** A copy of an HWP with its FileHeader changed: version and properties (the header sits in the mini stream). */
function withHeader(name: string, o: { props?: number; version?: number }) {
  const b = Buffer.from(fs.readFileSync(fixture(name)));
  const at = b.indexOf("HWP Document File");
  expect(at).toBeGreaterThan(0);
  if (o.version !== undefined) b.writeUInt32LE(o.version, at + 32);
  if (o.props !== undefined) b.writeUInt32LE(o.props, at + 36);
  return write(`${name}-${o.props ?? "v"}-${o.version ?? "p"}.hwp`, b);
}

/** What both sample fixtures hold (the same document written as HWP 5.0 and as HWPX). */
const SAMPLE: Pick<Seg, "loc" | "text" | "marks">[] = [
  { loc: { kind: "paragraph", paragraph: 1 }, text: "과제 안내문" },
  { loc: { kind: "paragraph", paragraph: 2 }, text: "제출 기한은 11월 20일입니다." },
  { loc: { kind: "paragraph", paragraph: 2, footnote: 1 }, text: "학교 누리집 공지 기준." },
  {
    loc: { kind: "table", table: 1, row: 1 },
    text: "항목 | 기준",
    marks: [
      [0, 2, { col: 1 }],
      [5, 7, { col: 2 }],
    ],
  },
  {
    loc: { kind: "table", table: 1, row: 2 },
    text: "분량 | A4 3쪽 | 이내",
    marks: [
      [0, 2, { col: 1 }],
      [5, 10, { col: 2 }],
      [13, 15, { col: 3 }],
    ],
  },
  // Row 3: the merged "분량" (rows 2–3) is in row 2 only; this row starts at column 2. The footnote at the end of
  // column 2 comes where it is in the reading order: the row is split around it (pieces marked `split`).
  { loc: { kind: "table", table: 1, row: 3, split: true }, text: "글꼴 11pt", marks: [[0, 7, { col: 2 }]] },
  { loc: { kind: "table", table: 1, row: 3, footnote: 2 }, text: "본문 글꼴 기준." },
  {
    loc: { kind: "table", table: 1, row: 3, split: true },
    text: "줄 간격 160%",
    marks: [[0, 9, { col: 3 }]],
  },
  { loc: { kind: "paragraph", paragraph: 3 }, text: "참고 자료를 확인하세요.\n글상자 속 글" },
  { loc: { kind: "paragraph", paragraph: 4 }, text: "둘째 구역 문단." },
  { loc: { kind: "paragraph", paragraph: 4, endnote: 1 }, text: "미주 내용." },
];
/** Two paragraphs with notes: footnote number 7 as stored, an endnote with no number (none claimed). */
const NOTES_TAIL = (n: number) => [
  { loc: { kind: "paragraph", paragraph: n }, text: "일곱째 각주가 붙은 문단." },
  { loc: { kind: "paragraph", paragraph: n, footnote: 7 }, text: "일곱째 각주." },
  { loc: { kind: "paragraph", paragraph: n + 1 }, text: "번호 없는 미주가 붙은 문단." },
  { loc: { kind: "paragraph", paragraph: n + 1 }, text: "번호 없는 미주." },
];
const shape = (r: Out) =>
  r.segments.map(({ loc, text, marks }) => ({ loc, text, ...(marks ? { marks } : {}) }));

describe("HWP·HWPX fixtures: body, merged tables, notes, paragraph numbers (#23)", () => {
  it("sample.hwp (HWP 5.0, compressed, two sections): paragraphs, a merged table, footnotes, an endnote", async () => {
    const r = await extract(fixture("sample.hwp"));
    expect(shape(r)).toEqual(SAMPLE);
    expect(r.segments.map((s) => s.unit)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect([r.units, r.truncated, r.ocr]).toEqual([11, false, "none"]);
    expect(r.sha256).toBe(
      crypto
        .createHash("sha256")
        .update(fs.readFileSync(fixture("sample.hwp")))
        .digest("hex"),
    );
    // The header ("머리말 글자") is not body text: a hidden unit at its place (before paragraph 1's text), never
    // a kept one; nothing is endsEarly (nothing is cut off).
    expect(JSON.stringify(r.segments)).not.toContain("머리말");
    expect(order(r)[0]).toEqual({ hidden: "머리말 글자" });
    expect(r.all.filter((x) => x.hidden)).toEqual([{ hidden: true, text: "머리말 글자" }]);
    expect(r.all.some((s) => s.endsEarly)).toBe(false);
  });

  it("sample.hwpx (OWPML): the same units — and the alternative content of a `case` is not read", async () => {
    const r = await extract(fixture("sample.hwpx"));
    expect(shape(r)).toEqual(SAMPLE);
    expect(JSON.stringify(r.segments)).not.toContain("머리말");
    expect(JSON.stringify(r.segments)).not.toContain("대체 글자");
    // Nor the preview text of the package (not even hidden: it is not document text).
    expect(JSON.stringify(r.all)).not.toContain("미리보기");
    // The header is a hidden unit at its place; the `case` is not read at all — not even hidden (review #120 4차).
    expect(JSON.stringify(r.all)).not.toContain("대체 글자");
    expect(order(r).slice(0, 3)).toEqual([
      { hidden: "머리말 글자" },
      "과제 안내문",
      "제출 기한은 11월 20일입니다.",
    ]);
    expect(r.all.some((s) => s.endsEarly)).toBe(false);
  });

  it("report.hwp (CFB version 4, not compressed, a section in regular sectors): caption, nested table, tab, line break", async () => {
    const r = await extract(fixture("report.hwp"));
    expect(shape(r).slice(0, 5)).toEqual([
      { loc: { kind: "paragraph", paragraph: 1 }, text: "보고서\t초안" },
      { loc: { kind: "paragraph", paragraph: 2 }, text: "첫 줄\n둘째 줄" },
      // The caption joins the paragraph that holds the table.
      { loc: { kind: "paragraph", paragraph: 3 }, text: "표 1. 점수" },
      {
        loc: { kind: "table", table: 1, row: 1 },
        text: "이름 | 점수",
        marks: [
          [0, 2, { col: 1 }],
          [5, 7, { col: 2 }],
        ],
      },
      // The nested table is not a table of its own: its text joins the cell where it is (before "92").
      {
        loc: { kind: "table", table: 1, row: 2 },
        text: "민준 | 안쪽 표\n값\n92",
        marks: [
          [0, 2, { col: 1 }],
          [5, 14, { col: 2 }],
        ],
      },
    ]);
    expect(r.segments).toHaveLength(209);
    expect(r.segments[204]).toMatchObject({
      loc: { kind: "paragraph", paragraph: 203 },
      text: "200번째 단락입니다. 긴 문서의 본문.",
    });
    // The document's own note numbers: 7 as stored; a stored 0 claims no number (the anchor's place only).
    expect(shape(r).slice(205)).toEqual(NOTES_TAIL(204));
    // The section stream is over the mini-stream cutoff (4096 bytes): read from regular sectors.
    const cfb = openCfb(fs.readFileSync(fixture("report.hwp")));
    expect(cfb.read("BodyText/Section0")!.length).toBeGreaterThan(4096);
  });

  it("report.hwpx: the same table; sections in the spine's order, not by part name", async () => {
    const r = await extract(fixture("report.hwpx"));
    expect(shape(r).slice(0, 5)).toEqual(shape(await extract(fixture("report.hwp"))).slice(0, 5));
    expect(shape(r).slice(5, 9)).toEqual(NOTES_TAIL(4));
    expect(r.segments.slice(9).map((s) => [s.loc.paragraph, s.text])).toEqual([
      [6, "둘째로 읽는 구역."],
      [7, "셋째로 읽는 구역."],
    ]);
  });

  it("doc-injection.hwp (INJ-4): the body, the small white sentence and the table of doc-injection.md", async () => {
    const file = path.join(INJECTION, "doc-injection.hwp");
    expect(contentMatches(file, "hwp")).toBe(true);
    const r = await extract(file);
    const md = fs.readFileSync(path.join(INJECTION, "doc-injection.md"), "utf8");
    const body = md.split("## 본문")[1]!.split("## 표")[0]!.trim().split("\n").filter(Boolean);
    expect(r.segments.map((s) => s.text).slice(1, 3)).toEqual([
      body[0],
      body[1]!.replace(/^\([^)]*\)\s*/, ""),
    ]);
    const rows = r.segments.filter((s) => s.loc.kind === "table");
    expect(rows.map((s) => [s.loc.row, s.text])).toEqual([
      [1, "항목 | 기준"],
      [2, "분량 | A4 3쪽 이내"],
      [3, "사료 | 1개 이상"],
      [4, "제출 | 11월 20일"],
      [5, `비고 | ${md.split("| 비고 | ")[1]!.split(" |")[0]}`],
    ]);
    // The hidden sentence is white and small (char shape 1 of DocInfo): the extractor reads it like any text.
    expect(r.segments[2]!.loc).toEqual({ kind: "paragraph", paragraph: 3 });
  });

  it("the fixtures are what upload detection takes them for (#22)", () => {
    for (const n of ["sample.hwp", "report.hwp", "encrypted.hwp", "distribution.hwp"])
      expect(contentMatches(fixture(n), "hwp"), n).toBe(true);
    for (const n of ["sample.hwpx", "report.hwpx", "encrypted.hwpx"])
      expect(contentMatches(fixture(n), "hwpx"), n).toBe(true);
    expect(contentMatches(fixture("sample.hwpx"), "hwp")).toBe(false);
  });

  it("a paragraph's text: controls take eight code units; tab, line break, hyphen and fixed spaces are kept", () => {
    const u = (...xs: number[]) => Buffer.from(new Uint16Array(xs).buffer);
    const tbl = [11, 0x6c20, 0x7462, 0, 0, 0, 0, 11];
    expect(paraText(u(...tbl, 0xac00, 9, 0, 0, 0, 0, 0, 0, 9, 0xac01, 10, 0xac02, 24, 30, 31, 13))).toBe(
      "가\t각\n갂-  ",
    );
    // A lone surrogate (half a pair) is dropped, never kept.
    expect(paraText(u(0xd83d, 0x41, 13))).toBe("A");
    expect(paraText(u(0xd83d, 0xde00, 13))).toBe("😀");
  });
});

/** The synthetic secret of cut.hwp / cut.hwpx (make-hwp-fixtures.py `CUT_SECRET`) and its base64's split. */
const CUT_SECRET = "sk-fixture-hwp-cut-0123456789abcdefABCDEF";
const CUT_B64 = Buffer.from(CUT_SECRET).toString("base64");
const CUT_HEAD = CUT_B64.slice(0, 40);
const CUT_REST = CUT_B64.slice(40);

describe("text left out goes out hidden, at its place in the reading order (review #120)", () => {
  it("cut.hwp: header, footer, hidden comment — in a paragraph and in a table cell", async () => {
    const r = await extract(fixture("cut.hwp"));
    const h = { hidden: CUT_REST };
    expect(order(r)).toEqual([
      ...[1, 2, 3].flatMap(() => [`앞 문장 ${CUT_HEAD}`, h, "다음 문장."]),
      `셀 ${CUT_HEAD}`,
      h,
      "둘째 칸",
      "끝 문장.",
    ]);
    // Nothing is cut off: no `endsEarly` (that is for size limits only); the rest is never a kept unit.
    expect(r.all.some((x) => x.endsEarly)).toBe(false);
    expect(JSON.stringify(r.segments)).not.toContain(CUT_REST);
    // The row is split around it: each piece keeps its own column mark, both marked `split`.
    expect(r.segments.slice(6, 8).map((x) => [x.loc, x.marks])).toEqual([
      [{ kind: "table", table: 1, row: 1, split: true }, [[0, 42, { col: 1 }]]],
      [{ kind: "table", table: 1, row: 1, split: true }, [[0, 4, { col: 2 }]]],
    ]);
  });

  it("cut.hwpx: header, footer, hidden comment — in a paragraph and in a table cell", async () => {
    const r = await extract(fixture("cut.hwpx"));
    const h = { hidden: CUT_REST };
    expect(order(r)).toEqual([
      ...[1, 2, 3].flatMap(() => [`앞 문장 ${CUT_HEAD}`, h, "다음 문장."]),
      `셀 ${CUT_HEAD}`,
      h,
      "둘째 칸",
      "끝 문장.",
    ]);
    expect(r.all.some((x) => x.endsEarly)).toBe(false);
  });

  // Every left-out kind × where the secret is (before it, after it, in a note or a table right before it): the
  // hidden unit is right next to the kept text that holds the other part.
  for (const c of MATRIX)
    it(`${c.format} ${c.kind} · ${c.place}: the hidden unit is next to the fragment, in reading order`, async () => {
      const m = await matrixDoc(c, CUT_B64);
      const r = await extract(write(`m-${c.format}-${c.kind}-${c.place}.${c.format}`, m.doc));
      const i = r.all.findIndex((x) => x.hidden);
      expect(i, JSON.stringify(order(r))).toBeGreaterThanOrEqual(0);
      const neighbour = r.all[c.place === "suffix" ? i + 1 : i - 1]!;
      expect(neighbour.hidden).toBeUndefined();
      expect(neighbour.text).toContain(m.fragment);
      expect(r.all[i]!.text + "").not.toContain("뒤 문장");
      // The kept text never holds the hidden part.
      expect(JSON.stringify(r.segments)).not.toContain(
        c.place === "suffix" ? CUT_B64.slice(0, 8) + CUT_B64.slice(8, 9) : CUT_REST,
      );
      if (c.place === "note") expect(neighbour.loc).toMatchObject({ footnote: 7 });
      if (c.place === "table") expect(neighbour.loc).toMatchObject({ kind: "table", table: 1, row: 1 });
    });

  it("HWPX `hp:switch`: only the default is read, where it is — the case not at all (not even hidden), no split", async () => {
    const rest = CUT_B64.slice(40);
    for (const v of SWITCHES) {
      const { doc } = await switchDoc(v, CUT_B64);
      const r = await extract(write(`switch-${v}.hwpx`, doc));
      const def = { default: rest, both: rest, case: "다른 글" }[v];
      // One paragraph, one unit: the default's text in its place, nothing hidden, no `split`.
      expect(order(r), v).toEqual([`앞 문장 ${CUT_HEAD}${def} 뒤 문장.`, "다음 문단."]);
      expect(r.segments[0]!.loc, v).toEqual({ kind: "paragraph", paragraph: 1 });
      if (v === "default") expect(JSON.stringify(r.all)).not.toContain("상관없는 설명");
      if (v === "case") expect(JSON.stringify(r.all)).not.toContain(rest);
    }
  });

  it("`hp:switch` nested in a default takes its default; one in a case is not read; one in a header gives the header its default; no default gives nothing", async () => {
    const nested = xswitch("바깥 대체", xt("바깥 ") + xswitch("안쪽 대체", xt("안쪽 기본")) + xt(" 끝"));
    const inCase = `<hp:switch><hp:case>${xt("대체 ")}${xswitch("더 깊은 대체", xt("대체 속 기본"))}</hp:case><hp:default>${xt("기본")}</hp:default></hp:switch>`;
    const header = `<hp:ctrl><hp:header><hp:subList>${xp(xt("머리 ") + xswitch("머리 대체", xt("머리 기본")))}</hp:subList></hp:header></hp:ctrl>`;
    const doc = await hwpxDoc(
      xp(xt("가 ") + nested) +
        xp(xt("나 ") + inCase) +
        xp(header + xt("다")) +
        xp(xt("라") + xswitch("대체만", null) + xt("마")),
    );
    const r = await extract(write("switch-nested.hwpx", doc));
    expect(order(r)).toEqual(["가 바깥 안쪽 기본 끝", "나 기본", { hidden: "머리 머리 기본" }, "다", "라마"]);
    expect(JSON.stringify(r.all)).not.toMatch(/대체/);
  });

  it("switch and default are transparent: a subList inside them belongs to the cell, note or header around them (review #120 5차)", async () => {
    for (const depth of [1, 2]) {
      const doc = await hwpxDoc(
        xp(xt("앞 ") + xtableWrapped("첫 칸", "둘째 칸", depth) + xt(" 뒤")) +
          xp(
            xt("각주 앞") +
              `<hp:ctrl><hp:footNote number="7">${xwrap(xsub(xt("각주 글")), depth)}</hp:footNote></hp:ctrl>` +
              xt(" 뒤"),
          ) +
          xp(
            xt("머리 앞") +
              `<hp:ctrl><hp:header>${xwrap(xsub(xt("머리말 글")), depth)}</hp:header></hp:ctrl>` +
              xt(" 뒤"),
          ),
      );
      const r = await extract(write(`transparent-${depth}.hwpx`, doc));
      expect(
        r.all.map((x) => (x.hidden ? { hidden: x.text } : [x.text, x.loc, x.marks ?? null])),
        `depth ${depth}`,
      ).toEqual([
        ["앞", { kind: "paragraph", paragraph: 1, split: true }, null],
        ["첫 칸", { kind: "table", table: 1, row: 1 }, [[0, 3, { col: 1 }]]],
        ["둘째 칸", { kind: "table", table: 1, row: 2 }, [[0, 4, { col: 1 }]]],
        ["뒤", { kind: "paragraph", paragraph: 1, split: true }, null],
        ["각주 앞", { kind: "paragraph", paragraph: 2, split: true }, null],
        ["각주 글", { kind: "paragraph", paragraph: 2, footnote: 7 }, null],
        ["뒤", { kind: "paragraph", paragraph: 2, split: true }, null],
        ["머리 앞", { kind: "paragraph", paragraph: 3, split: true }, null],
        { hidden: "머리말 글" },
        ["뒤", { kind: "paragraph", paragraph: 3, split: true }, null],
      ]);
      expect(JSON.stringify(r.all)).not.toContain("UNREAD");
    }
  });

  it("80,000 cases and deep nesting stay linear: the worker drops cases as it reads them", async () => {
    const many = Array.from({ length: 80_000 }, (_, i) =>
      xswitch(`대체 ${i} ${"x".repeat(20)}`, xt(`${i % 10}`)),
    ).join("");
    let deep = xt("깊은 기본");
    for (let i = 0; i < 100; i++) deep = xswitch(`대체 ${i}`, deep);
    const doc = await hwpxDoc(xp(xt("시작 ") + many) + xp(deep));
    const t0 = performance.now();
    const r = await extract(write("switch-many.hwpx", doc));
    const kept = keptSegments(r.all as never);
    const ms = performance.now() - t0;
    expect(r.all.some((x) => x.hidden)).toBe(false);
    expect(kept.map((k) => k.seg.text.length)).toEqual([3 + 80_000, 5]);
    expect(kept[1]!.seg.text).toBe("깊은 기본");
    // Well inside the worker's 60 s (it took ~1 s here); 80,000 cases are never scrubbed or stored.
    expect(ms).toBeLessThan(20_000);
  }, 60_000);

  it("a left-out part without text (an empty header) is no hidden unit", async () => {
    const zip = await JSZip.loadAsync(fs.readFileSync(fixture("sample.hwpx")));
    const xml = await zip.file("Contents/section0.xml")!.async("string");
    zip.file("Contents/section0.xml", xml.replace("머리말 글자", " "));
    const r = await extract(write("nocut.hwpx", await zip.generateAsync({ type: "nodebuffer" })));
    expect(r.all.filter((x) => x.hidden)).toEqual([]);
  });

  it("hidden text has its own limit: past it the file is refused, never kept text dropped", async () => {
    const cap = { segments: { maxChars: 2_000_000, maxSegments: 20_000, maxHiddenChars: 20 } };
    expect(await refused(fixture("cut.hwpx"), cap)).toBe("extract_too_large");
    // It does not count against the kept text's limits.
    const keep = { segments: { maxChars: 2_000_000, maxSegments: 9, maxHiddenChars: 2_000_000 } };
    const r = await extract(fixture("cut.hwpx"), keep);
    expect([r.segments.length, r.truncated]).toEqual([9, false]);
  });
});

describe("note numbers and cell addresses: never a place the document does not say (review #120)", () => {
  const variant = async (name: string, edit: (xml: string) => string) => {
    const zip = await JSZip.loadAsync(fs.readFileSync(fixture("sample.hwpx")));
    const xml = await zip.file("Contents/section0.xml")!.async("string");
    const changed = edit(xml);
    expect(changed).not.toBe(xml);
    zip.file("Contents/section0.xml", changed);
    return extract(write(name, await zip.generateAsync({ type: "nodebuffer" })));
  };

  it("HWPX footnote numbers as stored; one that is not a positive whole number claims none", async () => {
    const seven = await variant("seven.hwpx", (x) => x.replace('footNote number="1"', 'footNote number="7"'));
    expect(seven.segments[2]!.loc).toEqual({ kind: "paragraph", paragraph: 2, footnote: 7 });
    for (const bad of ["0", "-1", "x", "1.5", ""]) {
      const r = await variant(`bad-${bad}.hwpx`, (x) =>
        x.replace('footNote number="1"', `footNote number="${bad}"`),
      );
      expect(r.segments[2]!.loc, bad).toEqual({ kind: "paragraph", paragraph: 2 });
    }
  });

  it("HWP: a cell at row 65535 of a 2×2 table — the table is one unit, no row or column claimed", async () => {
    const r = await extract(fixture("badcell.hwp"));
    expect(shape(r)).toEqual([{ loc: { kind: "table", table: 1 }, text: "가\n나\n다\n라" }]);
  });

  it("HWPX: an address past the table, a span past it, two cells on one place, a cell without an address", async () => {
    const cases: [string, (x: string) => string][] = [
      ["row 65535", (x) => x.replace('colAddr="1" rowAddr="2"', 'colAddr="1" rowAddr="65535"')],
      ["column 3 of 3", (x) => x.replace('colAddr="2" rowAddr="2"', 'colAddr="3" rowAddr="2"')],
      ["span past the end", (x) => x.replace('colSpan="2" rowSpan="1"', 'colSpan="3" rowSpan="1"')],
      [
        "overlap with the merged cell",
        (x) => x.replace('colAddr="1" rowAddr="2"', 'colAddr="0" rowAddr="2"'),
      ],
      ["no address", (x) => x.replace('<hp:cellAddr colAddr="2" rowAddr="2"/>', "")],
      ["no table size", (x) => x.replace('rowCnt="3"', 'rowCnt="x"')],
    ];
    for (const [label, edit] of cases) {
      const r = await variant(`${label.replace(/\W/g, "-")}.hwpx`, edit);
      const table = r.segments.filter((x) => x.loc.kind === "table");
      expect(
        table.map((x) => x.loc),
        label,
      ).toEqual([
        // One unit (split around the cell's footnote, in reading order) — no row or column.
        { kind: "table", table: 1, split: true },
        { kind: "table", table: 1, footnote: 2 },
        { kind: "table", table: 1, split: true },
      ]);
      expect(table.every((x) => !x.marks)).toBe(true);
    }
  });
});

describe("encrypted and distribution documents: a fixed code, no text (#23, FR-4.4)", () => {
  it("password HWP → extract_encrypted; distribution HWP → extract_distribution; password HWPX → extract_encrypted", async () => {
    expect(await refused(fixture("encrypted.hwp"))).toBe("extract_encrypted");
    expect(await refused(fixture("distribution.hwp"))).toBe("extract_distribution");
    expect(await refused(fixture("encrypted.hwpx"))).toBe("extract_encrypted");
    expect(EXTRACT_CODE_TEXT.extract_encrypted).toMatch(/읽을 수 없어요$/);
    expect(EXTRACT_CODE_TEXT.extract_distribution).toMatch(/배포용.*읽을 수 없어요$/);
  });

  it("every encryption bit of the FileHeader refuses the file, even when the body would read", async () => {
    const compressed = 1;
    // password, DRM, certificate encryption, certificate DRM, privacy protection
    for (const bit of [1, 4, 8, 10, 13])
      expect(await refused(withHeader("sample.hwp", { props: compressed | (1 << bit) })), `bit ${bit}`).toBe(
        "extract_encrypted",
      );
    expect(await refused(withHeader("sample.hwp", { props: compressed | (1 << 2) }))).toBe(
      "extract_distribution",
    );
    // Bits that say nothing about readability (script, history, signature, CCL …) do not refuse it.
    const ok = await extract(
      withHeader("sample.hwp", { props: compressed | (1 << 3) | (1 << 6) | (1 << 7) | (1 << 11) }),
    );
    expect(shape(ok)).toEqual(SAMPLE);
    // Other versions are not this extractor's: HWP 3 is not even a compound file, HWP 6 does not exist yet.
    expect(await refused(withHeader("sample.hwp", { version: 0x06000000 }))).toBe("extract_unsupported");
    expect(await refused(withHeader("sample.hwp", { version: 0x03000000 }))).toBe("extract_unsupported");
  });

  it("a document whose text is only in ViewText is a distribution document whatever its header says", async () => {
    const r = await refused(withHeader("distribution.hwp", { props: 1 }));
    expect(r).toBe("extract_distribution");
  });
});

describe("hostile HWP·HWPX are refused (#23)", () => {
  it("a zlib bomb: the inflater stops at the section limit (+1), never inflates the 70 MiB", async () => {
    const spy = vi.spyOn(zlib, "inflateRawSync");
    try {
      expect(await refused(fixture("bomb.hwp"))).toBe("extract_too_large");
      const limits = spy.mock.calls.map((c) => (c[1] as { maxOutputLength?: number }).maxOutputLength);
      expect(limits.length).toBeGreaterThan(0);
      expect(limits.every((l) => l === HWP_LIMITS.maxStreamBytes + 1)).toBe(true);
    } finally {
      spy.mockRestore();
    }
    // A smaller limit stops a real document the same way.
    expect(await refused(fixture("sample.hwp"), { hwp: { maxStreamBytes: 64 } })).toBe("extract_too_large");
    expect(await refused(fixture("sample.hwp"), { hwp: { maxTotalBytes: 100 } })).toBe("extract_too_large");
    expect(await refused(fixture("sample.hwp"), { hwp: { maxRecords: 10 } })).toBe("extract_too_large");
  });

  it("compound file: a looping chain, a bad header, a stream past the file, a looping directory tree", async () => {
    expect(await refused(fixture("loop.hwp"))).toBe("extract_invalid");
    const sample = fs.readFileSync(fixture("sample.hwp"));
    const bad = (mutate: (b: Buffer) => void) => {
      const b = Buffer.from(sample);
      mutate(b);
      try {
        openCfb(b).read("BodyText/Section0");
        return "accepted";
      } catch (e) {
        return (e as { code?: string }).code;
      }
    };
    expect(bad(() => {})).toBe("accepted");
    expect(bad((b) => b.writeUInt16LE(0xfeff, 0x1c))).toBe("extract_invalid"); // byte order
    expect(bad((b) => b.writeUInt16LE(10, 0x1e))).toBe("extract_invalid"); // sector size
    expect(bad((b) => b.writeUInt32LE(0x7fffffff, 0x30))).toBe("extract_invalid"); // directory past the file
    expect(bad((b) => b.writeUInt32LE(9999, 0x2c))).toBe("extract_invalid"); // more FAT sectors than the file
    const root = sample.indexOf(Buffer.from("Root Entry", "utf16le"));
    expect(root).toBeGreaterThan(0);
    // The root's child points back at the root; a stream entry claims more bytes than the file.
    expect(bad((b) => b.writeUInt32LE(0, root + 76))).toBe("extract_invalid");
    const body = sample.indexOf(Buffer.from("BodyText", "utf16le"));
    expect(bad((b) => b.writeUInt32LE(0, body + 76))).toBe("extract_invalid");
    const section = sample.indexOf(Buffer.from("Section0", "utf16le"));
    // A sibling pointer back at the entry itself: visited once, then refused (not walked for ever).
    const self = (section - root) / 128;
    expect(Number.isInteger(self)).toBe(true);
    expect(bad((b) => b.writeUInt32LE(self, section + 68))).toBe("extract_invalid");
    expect(bad((b) => b.writeUInt32LE(sample.length + 1, section + 120))).toBe("extract_invalid");
    // Cut short, not a compound file at all, a text named .hwp.
    expect(await refused(write("cut.hwp", sample.subarray(0, 700)))).toBe("extract_invalid");
    expect(await refused(write("text.hwp", Buffer.from("한글 문서가 아님\n")))).toBe("extract_invalid");
  });

  it("records: a size past the stream, nesting past the limit", async () => {
    // Nesting: a table cell's paragraphs are at level 2.
    expect(await refused(fixture("sample.hwp"), { hwp: { maxDepth: 1 } })).toBe("extract_invalid");
    expect(await refused(fixture("sample.hwp"), { hwp: { maxDepth: 8 } })).toBe("accepted");
    const section = (b: Buffer) => {
      try {
        hwpSection(b, new Segments());
        return "accepted";
      } catch (e) {
        return (e as { code?: string }).code;
      }
    };
    const rec = (tag: number, level: number, data: Buffer, size = data.length) => {
      const h = Buffer.alloc(4);
      h.writeUInt32LE((tag | (level << 10) | (Math.min(size, 0xfff) << 20)) >>> 0);
      if (size < 0xfff) return Buffer.concat([h, data]);
      const big = Buffer.alloc(4);
      big.writeUInt32LE(size);
      return Buffer.concat([h, big, data]);
    };
    const text = Buffer.from("가나\r", "utf16le");
    const ok = Buffer.concat([rec(66, 0, Buffer.alloc(24)), rec(67, 1, text)]);
    expect(section(ok)).toBe("accepted");
    // A size past the end of the stream (short and long size forms), a header cut short.
    expect(section(Buffer.concat([rec(66, 0, Buffer.alloc(24)), rec(67, 1, text, text.length + 1)]))).toBe(
      "extract_invalid",
    );
    expect(section(Buffer.concat([rec(66, 0, Buffer.alloc(24)), rec(67, 1, text, 0x10000)]))).toBe(
      "extract_invalid",
    );
    expect(section(Buffer.concat([ok, Buffer.from([1, 2])]))).toBe("extract_invalid");
    // A thousand nested paragraphs (levels 0…999): refused at the nesting limit, not by the stack.
    const deep = Buffer.concat(Array.from({ length: 1000 }, (_, i) => rec(66, i, Buffer.alloc(24))));
    expect(section(deep)).toBe("extract_invalid");
  });

  it("HWPX: a DTD is never processed; a section path out of the package; a broken archive", async () => {
    expect(await refused(fixture("xxe.hwpx"))).toBe("extract_xml_forbidden");
    const zip = await JSZip.loadAsync(fs.readFileSync(fixture("sample.hwpx")));
    const hpf = await zip.file("Contents/content.hpf")!.async("string");
    zip.file(
      "Contents/content.hpf",
      hpf.replace('href="Contents/section0.xml"', 'href="../../etc/section0.xml"'),
    );
    const escaped = write("escape.hwpx", await zip.generateAsync({ type: "nodebuffer" }));
    expect(await refused(escaped)).toBe("extract_path_escape");
    expect(
      await refused(write("broken.hwpx", fs.readFileSync(fixture("sample.hwpx")).subarray(0, 300))),
    ).toBe("extract_zip_invalid");
    // No content.hpf: not an HWPX package.
    zip.remove("Contents/content.hpf");
    expect(await refused(write("nohpf.hwpx", await zip.generateAsync({ type: "nodebuffer" })))).toBe(
      "extract_invalid",
    );
  });
});

describe("limits through the builder: a cut document ends there and says so (review #107 rule)", () => {
  const cap = (maxSegments: number, maxChars = 2_000_000) => ({ segments: { maxChars, maxSegments } });

  for (const name of ["sample.hwp", "sample.hwpx"]) {
    it(`${name}: stopped at the cap with input left → truncated, the last unit endsEarly`, async () => {
      const r = await extract(fixture(name), cap(3));
      expect([r.segments.length, r.truncated]).toEqual([3, true]);
      // (HWPX: paragraph 1 ends early anyway — the `case` after it.)
      expect(r.segments.map((s) => !!s.endsEarly)).toEqual([false, false, true]);
      // Cut inside a table: rows up to the cap.
      const t = await extract(fixture(name), cap(5));
      expect(t.segments.at(-1)).toMatchObject({ loc: { kind: "table", row: 2 }, endsEarly: true });
      // Exactly at the cap with nothing left is not truncated.
      const all = await extract(fixture(name), cap(11));
      expect([all.segments.length, all.truncated]).toEqual([11, false]);
      // The character total cuts the text where it ends (and the cut unit endsEarly).
      const chars = await extract(fixture(name), cap(100, 20));
      expect(chars.truncated).toBe(true);
      expect(chars.segments.map((s) => s.text).join("").length).toBe(20);
      expect(chars.segments.at(-1)!.endsEarly).toBe(true);
    });
  }

  it("a cap between sections: the next section is not read", async () => {
    const r = await extract(fixture("sample.hwp"), cap(9));
    expect([r.segments.length, r.truncated, r.segments.at(-1)!.endsEarly]).toEqual([9, true, true]);
  });
});

describe("locators (packages/shared) for HWP", () => {
  it("footnote and endnote fields survive the common locator; labels say where", () => {
    const base = { fileId: "f", fileRevision: "a".repeat(64) };
    expect(FileLocator.parse({ ...base, kind: "paragraph", paragraph: 2, footnote: 1 })).toMatchObject({
      footnote: 1,
    });
    expect(() => FileLocator.parse({ ...base, kind: "paragraph", footnote: 0 })).toThrow();
    expect(locatorLabel({ kind: "paragraph", paragraph: 12 })).toBe("12번째 문단");
    expect(locatorLabel({ kind: "table", table: 3, row: 2 })).toBe("3번째 표 · 2행");
    expect(locatorLabel({ kind: "paragraph", paragraph: 2, footnote: 1 })).toBe("2번째 문단 · 각주 1");
    expect(locatorLabel({ kind: "table", table: 1, row: 3, footnote: 2 })).toBe("1번째 표 · 3행 · 각주 2");
    expect(locatorLabel({ kind: "paragraph", paragraph: 4, endnote: 1 })).toBe("4번째 문단 · 미주 1");
    expect(locatorLabel({ kind: "paragraph", footnote: 3 })).toBe("각주 3");
  });

  it("the extractor version moved on: rows of the old one are extracted again", () => {
    expect(EXTRACTOR_VERSION).toBe("extract-11");
  });
});

// ---- the sandboxed run (#42) ----------------------------------------------------------------------------------

describe.skipIf(process.platform !== "darwin")(
  "the HWP·HWPX extractor in its sandbox (macOS sandbox-exec)",
  () => {
    const sandboxed = async (file: string) => {
      const real = fs.realpathSync(file);
      const opts = extractRunOptions(
        { kind: kindOf(file) as never, bytes: fs.statSync(real).size },
        real,
        undefined,
      );
      return workerResult(await runIsolated(opts));
    };

    it("reads both formats and refuses the encrypted, distribution and hostile ones there too", async () => {
      for (const n of ["sample.hwp", "sample.hwpx"]) {
        const r = await sandboxed(fixture(n));
        expect(
          r.ok && r.segments.flatMap((x) => (x.hidden ? [] : [{ loc: x.loc, text: x.text }])),
          n,
        ).toEqual(SAMPLE.map(({ loc, text }) => ({ loc, text })));
      }
      expect(await sandboxed(fixture("encrypted.hwp"))).toEqual({ ok: false, code: "extract_encrypted" });
      expect(await sandboxed(fixture("distribution.hwp"))).toEqual({
        ok: false,
        code: "extract_distribution",
      });
      expect(await sandboxed(fixture("encrypted.hwpx"))).toEqual({ ok: false, code: "extract_encrypted" });
      expect(await sandboxed(fixture("bomb.hwp"))).toEqual({ ok: false, code: "extract_too_large" });
      expect(await sandboxed(fixture("xxe.hwpx"))).toEqual({ ok: false, code: "extract_xml_forbidden" });
    });

    it("the same policy as every kind: the one file, no network, no writes, no environment", () => {
      const opts = extractRunOptions({ kind: "hwp", bytes: 1 }, fixture("sample.hwp"), undefined);
      expect(opts.read).toEqual([fixture("sample.hwp")]);
      expect(opts.write).toEqual([]);
      expect(opts.network).toBe("none");
      expect(opts.env).toEqual({ AGENTLEE_EXTRACT_WORKER: "1" });
    });
  },
);
