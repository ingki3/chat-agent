// Document generator (#49): turns one checked document (title and blocks) into a DOCX, XLSX, PPTX or PDF file,
// re-opens what it made and prints it. It runs in the sandbox (#42): it may read its own folder, the pinned
// libraries it imports and the font — nothing else (the pictures come in on stdin, read by the server through the
// file store's checks); it writes nothing, starts no process, has no network and gets no environment but one flag.
// The server enforces time, memory and output size; the limits here (picture size) bound the work inside them.
//
// stdin: one JSON job `{ kind, doc, images: { [fileId]: { kind: "png" | "jpg", data: base64 } }, modules, fonts }`.
// stdout: one JSON result — `{ ok: true, data: base64, checks }` or `{ ok: false, code }`.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildDocx } from "./docx.mjs";
import { buildPdf } from "./pdf.mjs";
import { buildPptx } from "./pptx.mjs";
import { buildXlsx } from "./xlsx.mjs";
import { DocError, imageInfo } from "./common.mjs";
import { verify } from "./verify.mjs";

const BUILDERS = { docx: buildDocx, xlsx: buildXlsx, pptx: buildPptx, pdf: buildPdf };

/** Runs one job in this process. Exported for tests and the FakeRuntime mode (the server runs it sandboxed). */
export async function run(job) {
  const build = BUILDERS[job.kind];
  if (!build) throw new DocError("doc_bad_input");
  const images = new Map();
  for (const [id, img] of Object.entries(job.images ?? {}))
    images.set(id, imageInfo(Buffer.from(img.data, "base64"), img.kind));
  const lib = async (name) => {
    const m = await import(job.modules[name]);
    return m.default ?? m;
  };
  const buf = await build(job.doc, { images, lib, fonts: job.fonts });
  const checks = await verify(job.kind, buf, job.doc, { lib });
  return { buf, checks };
}

/**
 * Under the worker account (#122) the launcher sets `AGENTLEE_WORKER_APP` to the root-owned program tree this file
 * runs from: the library paths and the fonts then come from that tree's `manifest.json` (`pnpm workers:bundle`),
 * never from the job — the caller cannot pick code to import. A manifest path is relative to the tree and may not
 * leave it. Without the variable the job is used as given.
 */
export function fromApp(job, app = process.env.AGENTLEE_WORKER_APP) {
  if (!app) return job;
  const m = JSON.parse(fs.readFileSync(path.join(app, "manifest.json"), "utf8")).docgen;
  const at = (rel) => {
    if (typeof rel !== "string" || !rel || path.isAbsolute(rel) || rel.split("/").includes(".."))
      throw new DocError("doc_failed");
    return path.join(app, rel);
  };
  return {
    kind: job.kind,
    doc: job.doc,
    images: job.images,
    modules: Object.fromEntries(
      Object.entries(m.modules).map(([k, rel]) => [k, pathToFileURL(at(rel)).href]),
    ),
    fonts: { regular: at(m.fonts.regular), bold: at(m.fonts.bold) },
  };
}

async function main() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  let out;
  try {
    const { buf, checks } = await run(fromApp(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
    out = { ok: true, data: buf.toString("base64"), checks };
  } catch (e) {
    out = { ok: false, code: e instanceof DocError ? e.code : "doc_failed" };
  }
  process.stdout.write(JSON.stringify(out));
}

if (process.env.AGENTLEE_DOC_WORKER === "1") await main();
