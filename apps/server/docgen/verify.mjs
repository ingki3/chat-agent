// The generated file re-opened (#49) before it is handed back: an office file is unzipped and its main parts must be
// there and hold the title (and, for tables, as many tables or sheets as the document has); a PDF must have its
// header, end marker and at least one page. A file that fails is never stored (`doc_invalid`).
import { DocError } from "./common.mjs";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
/** The text of an XML part: tags removed, entities decoded, runs joined. */
export function xmlText(xml) {
  return xml
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
      e[0] === "#"
        ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
        : (ENTITIES[e] ?? m),
    );
}

const MAIN = {
  docx: ["word/document.xml"],
  xlsx: ["xl/workbook.xml"],
  pptx: ["ppt/presentation.xml", "ppt/slides/slide1.xml"],
};

export async function verify(kind, buf, doc, ctx) {
  const tables = doc.blocks.filter((b) => b.type === "table").length;
  if (kind === "pdf") {
    const head = buf.subarray(0, 8).toString("latin1");
    const tail = buf.subarray(Math.max(0, buf.length - 1024)).toString("latin1");
    const pages = (buf.toString("latin1").match(/\/Type \/Page\b(?!s)/g) ?? []).length;
    if (!head.startsWith("%PDF-") || !tail.includes("%%EOF") || pages < 1) throw new DocError("doc_invalid");
    return { pages };
  }
  const JSZip = await ctx.lib("jszip");
  let zip;
  try {
    zip = await JSZip.loadAsync(buf);
  } catch {
    throw new DocError("doc_invalid");
  }
  const read = async (name) => {
    const f = zip.file(name);
    if (!f) throw new DocError("doc_invalid");
    return f.async("string");
  };
  await read("[Content_Types].xml");
  const main = await Promise.all(MAIN[kind].map(read));
  const names = Object.keys(zip.files);
  let text;
  const checks = {};
  if (kind === "docx") {
    text = xmlText(main[0]);
    checks.tables = (main[0].match(/<w:tbl>/g) ?? []).length;
    if (checks.tables !== tables) throw new DocError("doc_invalid");
  } else if (kind === "pptx") {
    text = xmlText(main[1]);
    checks.slides = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length;
  } else {
    const shared = zip.file("xl/sharedStrings.xml") ? await read("xl/sharedStrings.xml") : "";
    const first = zip.file("xl/worksheets/sheet1.xml") ? await read("xl/worksheets/sheet1.xml") : "";
    text = xmlText(shared) + xmlText(first);
    checks.sheets = (main[0].match(/<sheet\b/g) ?? []).length;
    if (checks.sheets !== 1 + tables) throw new DocError("doc_invalid");
  }
  if (!text.includes(doc.title)) throw new DocError("doc_invalid");
  return checks;
}
