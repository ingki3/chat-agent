// File extractor (#48): reads one uploaded file and prints its text with locators. It runs in the sandbox (#42):
// it may read the one file, its own folder, the pinned libraries it imports and (for OCR) the language data —
// nothing else; it writes nothing, starts no process, has no network and gets no environment but what the server
// passes. The server enforces time and memory; the limits here (decompressed size, pages, characters, image
// pixels) bound the work inside them.
//
// stdin: one JSON job `{ path, kind, bytes, modules: { pdfjs, tesseract }, assets, ocr: { langDir } | null }`.
// stdout: one JSON result — `{ ok: true, sha256, units, truncated, ocr, segments }` or `{ ok: false, code }`.
import crypto from "node:crypto";
import fs from "node:fs";
import { ExtractError } from "./errors.mjs";
import { hwp, hwpx, HWP_LIMITS } from "./hwp.mjs";
import { imageSize } from "./image.mjs";
import { docx, pptx, xlsx } from "./ooxml.mjs";
import { pdf, PDF_LIMITS } from "./pdf.mjs";
import { createOcr } from "./ocr.mjs";
import { Segments } from "./segments.mjs";
import { csv, lines } from "./text.mjs";
import { openZip } from "./zip.mjs";

/** Largest file read (the upload limit, FILE_LIMITS.bytes). */
const MAX_BYTES = 50 * 1024 * 1024;

/** Runs one job in this process. Exported for tests (the server always runs it sandboxed). */
export async function run(job, deps = {}) {
  const buf = deps.buffer ?? fs.readFileSync(job.path);
  if (buf.length > MAX_BYTES || (job.bytes !== undefined && buf.length !== job.bytes))
    throw new ExtractError("extract_changed");
  const sha256 = crypto.createHash("sha256").update(buf).digest("hex");
  const out = new Segments(job.limits?.segments);
  const tesseract = async () => deps.tesseract ?? (await import(job.modules.tesseract));
  const ocr = job.ocr
    ? { create: async () => createOcr({ tesseract: await tesseract(), langDir: job.ocr.langDir }) }
    : null;
  let r;
  switch (job.kind) {
    case "pdf": {
      const pdfjs = deps.pdfjs ?? (await import(job.modules.pdfjs));
      r = await pdf(buf, out, {
        pdfjs,
        assets: job.assets,
        ocr,
        limits: { ...PDF_LIMITS, ...job.limits?.pdf },
      });
      break;
    }
    case "docx":
      r = docx(openZip(buf, job.limits?.zip), out);
      break;
    case "xlsx":
      r = xlsx(openZip(buf, job.limits?.zip), out);
      break;
    case "pptx":
      r = pptx(openZip(buf, job.limits?.zip), out);
      break;
    case "hwp":
      r = hwp(buf, out, { ...HWP_LIMITS, ...job.limits?.hwp });
      break;
    case "hwpx":
      r = hwpx(openZip(buf, job.limits?.zip), out, { ...HWP_LIMITS, ...job.limits?.hwp });
      break;
    case "csv":
      r = csv(buf, out);
      break;
    case "txt":
    case "md":
      r = lines(buf, out);
      break;
    case "png":
    case "jpg": {
      const size = imageSize(buf);
      if (!size || !size.width || !size.height) throw new ExtractError("extract_invalid");
      const max = job.limits?.pdf?.maxImagePixels ?? PDF_LIMITS.maxImagePixels;
      if (size.width * size.height > max) throw new ExtractError("extract_too_large");
      if (!ocr) throw new ExtractError("ocr_unavailable");
      const engine = await ocr.create();
      try {
        const { text, marks } = await engine.recognize(buf);
        const r4 = (x) => Math.round(Math.min(1, Math.max(0, x)) * 10000) / 10000;
        out.add(
          1,
          { kind: "ocr_box" },
          text,
          marks.map(([s, e, { box }]) => [
            s,
            e,
            {
              bbox: [
                r4(box[0] / size.width),
                r4(box[1] / size.height),
                r4((box[2] - box[0]) / size.width),
                r4((box[3] - box[1]) / size.height),
              ],
            },
          ]),
        );
      } finally {
        await engine.close();
      }
      r = { units: 1, ocr: "done" };
      break;
    }
    default:
      throw new ExtractError("extract_unsupported");
  }
  return {
    ok: true,
    sha256,
    units: r.units ?? null,
    truncated: out.truncated,
    ocr: r.ocr ?? "none",
    segments: out.items,
  };
}

async function main() {
  // pdf.js and tesseract.js talk on the console: none of it may mix with the result on stdout.
  for (const k of ["log", "info", "warn", "debug"]) console[k] = () => {};
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let result;
  try {
    result = await run(JSON.parse(input));
  } catch (e) {
    result = { ok: false, code: e instanceof ExtractError ? e.code : "extract_failed" };
  }
  process.stdout.write(JSON.stringify(result), () => process.exit(0));
}

if (process.env.AGENTLEE_EXTRACT_WORKER === "1") void main();
