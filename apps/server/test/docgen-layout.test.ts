import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DocContent, type DocBlock } from "@agentlee/shared";
import { loadConfig } from "../src/config.js";
import {
  DOC_FONT_PACKAGE,
  DOC_PACKAGES,
  DOC_WORKER_DIR,
  docLibraries,
  docRunnerKind,
  inProcessDocRunner,
} from "../src/docgen/runner.js";
import { readPdfItems, readPptx } from "./helpers/doc-parse.js";

/**
 * Document generation, review round 1 (#49): nothing of a document is lost to layout (PDF table cells, PPTX
 * paragraphs and headings), only XML-safe text goes in and every XML part is parsed after making, the in-process
 * runner is never a production path, and every worker library is a production dependency.
 */

const runner = inProcessDocRunner();
const make = async (kind: "pdf" | "pptx" | "docx" | "xlsx", blocks: DocBlock[], title = "레이아웃 시험") => {
  const r = await runner({ kind, doc: { title, blocks }, images: {} });
  if (!r.ok) throw new Error(r.code);
  return r.data;
};
const strip = (s: string) => s.replace(/\s+/g, "");
const count = (s: string, c: string) => s.split(c).length - 1;

describe("PDF tables keep every character of every cell", () => {
  /** The table's text on the pages (page numbers and the title left out), whitespace removed. */
  async function tableText(buf: Buffer, title: string) {
    const items = await readPdfItems(buf);
    return strip(
      items
        .filter((i) => i.y > 50 && i.str !== title && !/^\d+ \/ \d+$/.test(i.str))
        .map((i) => i.str)
        .join(""),
    );
  }

  it("30 columns × 1 row of 1,000 characters each: all 30,000 characters (each cell its own letter)", async () => {
    const letters = Array.from({ length: 30 }, (_, i) => String.fromCharCode(0xac00 + i * 28));
    const buf = await make("pdf", [
      { type: "table", columns: letters.map((_, i) => `c${i}`), rows: [letters.map((l) => l.repeat(1000))] },
    ]);
    const text = await tableText(buf, "레이아웃 시험");
    for (const l of letters) expect(count(text, l), l).toBe(1000);
    for (let i = 0; i < 30; i++) expect(text).toContain(`c${i}`);
  });

  it("one cell of 499 lines: all 499 lines", async () => {
    const buf = await make("pdf", [{ type: "table", columns: ["줄"], rows: [["가\n".repeat(499)]] }]);
    expect(count(await tableText(buf, "레이아웃 시험"), "가")).toBe(499);
  });

  it("a long header and many rows: every cell's whole text, in order within its column", async () => {
    const rows = Array.from({ length: 120 }, (_, r) => [`행${r}`, `값${r}-${"나".repeat(r % 7)}`, r * 3]);
    const header = ["머리".repeat(400), "둘", "셋"];
    const buf = await make("pdf", [{ type: "table", columns: header, rows }]);
    const text = await tableText(buf, "레이아웃 시험");
    expect(count(text, "머리")).toBe(400);
    for (const r of rows) for (const c of r) expect(text).toContain(strip(String(c)));
  });

  it("a long cell without spaces is kept whole too", async () => {
    const buf = await make("pdf", [{ type: "table", columns: ["a"], rows: [["x".repeat(1000)]] }]);
    expect(count(await tableText(buf, "레이아웃 시험"), "x")).toBe(1000);
  });
});

describe("PPTX text never runs off a slide, and every heading has its slide", () => {
  const BODY_Y = 1188720; // 1.3 in, in EMU
  const TITLE_Y = 274320; // 0.3 in
  /** Estimated height (pt) of a body's paragraphs at 18 pt — the same rules the generator packs by. */
  async function heights(buf: Buffer) {
    const { wrapLines } = (await import(path.join(DOC_WORKER_DIR, "pptx.mjs"))) as {
      wrapLines(t: string, size: number): { text: string }[];
    };
    const p = await readPptx(buf);
    return p.slides.map((_, i) => {
      const body = p.shapeAt(i, BODY_Y);
      return body ? body.reduce((h, t) => h + wrapLines(t, 18).length * 18 * 1.2 + 6, 0) : 0;
    });
  }
  const BOX_PT = 5.8 * 72;

  it("one 7,800-character paragraph: cut over several slides, each within the body box, nothing lost", async () => {
    const text = "가나다라마바사아자차".repeat(780);
    const buf = await make("pptx", [
      { type: "heading", text: "긴 문단" },
      { type: "paragraph", text },
    ]);
    const p = await readPptx(buf);
    expect(p.slides.length).toBeGreaterThan(5);
    const bodies = p.slides.map((_, i) => (p.shapeAt(i, BODY_Y) ?? []).join(""));
    expect(bodies.join("")).toBe(text);
    for (const h of await heights(buf)) expect(h).toBeLessThanOrEqual(BOX_PT);
    expect(p.shapeAt(2, TITLE_Y)).toEqual(["긴 문단 (계속)"]);
  });

  it("a list item with 150 line breaks: continued over slides, each within the box, every line kept", async () => {
    const item = Array.from({ length: 150 }, (_, i) => `${i}번 줄`).join("\n");
    const buf = await make("pptx", [{ type: "list", items: [item, "다음 항목"] }]);
    const p = await readPptx(buf);
    const lines = p.slides.flatMap((_, i) => p.shapeAt(i, BODY_Y) ?? []);
    expect(lines).toEqual([...item.split("\n"), "다음 항목"]);
    for (const h of await heights(buf)) expect(h).toBeLessThanOrEqual(BOX_PT);
    expect(p.slides.length).toBeGreaterThan(5);
  });

  it("heading A → heading B → paragraph, and a trailing heading: every heading is on a slide", async () => {
    const buf = await make("pptx", [
      { type: "heading", text: "제목 A" },
      { type: "heading", text: "제목 B" },
      { type: "paragraph", text: "본문" },
      { type: "heading", text: "마지막 제목" },
    ]);
    const p = await readPptx(buf);
    const titles = p.slides.map((_, i) => p.shapeAt(i, TITLE_Y)?.join(""));
    expect(titles.slice(1)).toEqual(["제목 A", "제목 B", "마지막 제목"]);
    expect(p.shapeAt(2, BODY_Y)).toEqual(["본문"]);
  });

  it("a heading too long for the title box opens the body instead (and is kept whole)", async () => {
    const long = "아주 긴 제목 ".repeat(40).trim();
    const buf = await make("pptx", [
      { type: "heading", text: long },
      { type: "paragraph", text: "본문" },
    ]);
    const p = await readPptx(buf);
    expect(p.text.replace(/\n/g, "")).toContain(long);
    for (const h of await heights(buf)) expect(h).toBeLessThanOrEqual(BOX_PT);
  });

  it("an ordered list keeps its numbers across a continuation slide", async () => {
    const items = Array.from({ length: 40 }, (_, i) => `항목 ${i + 1}`);
    const p = await readPptx(await make("pptx", [{ type: "list", ordered: true, items }]));
    const lines = p.slides.flatMap((_, i) => p.shapeAt(i, BODY_Y) ?? []);
    expect(lines).toEqual(items.map((t, i) => `${i + 1}. ${t}`));
  });
});

describe("only XML-safe text, and every XML part parsed after making", () => {
  it("U+FFFE, U+FFFF, a lone surrogate or a C0 control in any text is refused at input", () => {
    const ok = { title: "t", blocks: [{ type: "paragraph", text: "a\tb\nc\r😀" }] };
    expect(DocContent.safeParse(ok).success).toBe(true);
    for (const bad of ["A￾B", "A￿", "x\uD800y", "y\uDC00", "\u0001", "\u000b", "\u007f"]) {
      const docs = [
        { title: bad, blocks: [] },
        { title: "t", blocks: [{ type: "paragraph", text: bad }] },
        { title: "t", blocks: [{ type: "table", columns: [bad], rows: [] }] },
        { title: "t", blocks: [{ type: "table", columns: ["a"], rows: [[bad]] }] },
        { title: "t", blocks: [{ type: "list", items: [bad] }] },
        { title: "t", blocks: [{ type: "references", items: [bad] }] },
        { title: "t", author: bad, blocks: [] },
      ];
      for (const d of docs) expect(DocContent.safeParse(d).success, JSON.stringify(d)).toBe(false);
    }
  });

  it("the worker's re-open parses every part: a forbidden character or broken XML in any part is doc_invalid", async () => {
    const { verify } = (await import(path.join(DOC_WORKER_DIR, "verify.mjs"))) as {
      verify(kind: string, buf: Buffer, doc: DocContent, ctx: object): Promise<unknown>;
    };
    const libs = docLibraries();
    const lib = async (n: keyof typeof libs.modules) =>
      ((m: { default?: unknown }) => m.default ?? m)(await import(libs.modules[n]));
    const JSZip = (await lib("jszip")) as {
      loadAsync(b: Buffer): Promise<{
        files: Record<string, unknown>;
        file(n: string): { async(t: "string"): Promise<string> } | null;
        file(n: string, d: string): unknown;
        generateAsync(o: { type: "nodebuffer" }): Promise<Buffer>;
      }>;
    };
    const doc: DocContent = { title: "검사", blocks: [{ type: "table", columns: ["a"], rows: [["b"]] }] };
    const parts = {
      docx: "docProps/core.xml",
      xlsx: "xl/styles.xml",
      pptx: "ppt/slides/slide1.xml",
    } as const;
    for (const kind of ["docx", "xlsx", "pptx"] as const) {
      const good = await make(kind, doc.blocks, doc.title);
      await expect(verify(kind, good, doc, { lib })).resolves.toBeTruthy();
      for (const damage of [
        (x: string) => x.replace("검사", "검￾사").replace("</", "￿</"),
        (x: string) => x.replace(/<\/[^>]+>\s*$/, ""),
      ]) {
        const zip = await JSZip.loadAsync(good);
        // Parts other than the main one too (here: one the title check never reads).
        const name = parts[kind];
        zip.file(name, damage(await zip.file(name)!.async("string")));
        const bad = await zip.generateAsync({ type: "nodebuffer" });
        await expect(verify(kind, bad, doc, { lib }), `${kind} ${name}`).rejects.toMatchObject({
          code: "doc_invalid",
        });
      }
    }
  });
});

describe("the in-process runner is never a production path (#49 review 1)", () => {
  const base = {
    DATA_DIR: "/tmp/agentlee-x/data",
    MASTER_KEY_PATH: "/tmp/agentlee-x/master.key",
    BACKUP_DIR: "/tmp/agentlee-bk",
  };
  it("production refuses the test switch; production with FAKE_RUNTIME always uses the sandbox", () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: "production", ISOLATION_IN_PROCESS_FOR_TESTS: "1" }),
    ).toThrow(/ISOLATION_IN_PROCESS_FOR_TESTS/);
    const fakeProd = loadConfig({ ...base, NODE_ENV: "production", FAKE_RUNTIME: "1" });
    expect(docRunnerKind(fakeProd)).toBe("sandbox");
    // Even a config object claiming the switch in production is sandboxed (the check is made twice).
    expect(docRunnerKind({ ...fakeProd, isolationInProcessForTests: true })).toBe("sandbox");
  });

  it("FAKE_RUNTIME alone never picks it; only the explicit switch outside production does", () => {
    for (const env of ["development", "test"] as const) {
      expect(docRunnerKind(loadConfig({ ...base, NODE_ENV: env, FAKE_RUNTIME: "1" }))).toBe("sandbox");
      expect(docRunnerKind(loadConfig({ ...base, NODE_ENV: env, ISOLATION_IN_PROCESS_FOR_TESTS: "1" }))).toBe(
        "in-process",
      );
    }
  });
});

describe("every library the worker loads is a production dependency", () => {
  it("docx, exceljs, pptxgenjs, pdfkit, jszip, saxes and the font are in dependencies, pinned exactly", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8"),
    ) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    for (const name of [...DOC_PACKAGES, DOC_FONT_PACKAGE]) {
      expect(pkg.dependencies[name], name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(pkg.devDependencies[name], name).toBeUndefined();
    }
  });
});
