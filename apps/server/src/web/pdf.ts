import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FileRow } from "../files/store.js";
import { keptSegments, type ExtractRunner } from "../files/extract.js";
import type { WebCode } from "./service.js";

/**
 * PDF pages of `web_fetch` (#234). The web worker never parses a PDF: it hands the bytes back (worker.mjs
 * `fetchPage`), and the server reads their text with the document extractor of uploads (#48, `files/extract.ts`) —
 * the same pinned pdf.js in the same sandbox (no network, nothing writable, its own time and memory limits; as the
 * worker account when that is set up, #122). OCR is off for web PDFs (a scan is `web_no_text`): it would hold a
 * page fetch for minutes.
 *
 * The bytes are written to a fresh 0600 file in a server-owned folder (`uploads-tmp`, emptied at start) for the
 * extractor to read, and removed right after. Known secrets are masked over the text as for uploads (`keptSegments`);
 * the source store masks them again on write.
 */

export type PdfText = { ok: true; text: string; truncated: boolean } | { ok: false; code: WebCode };
export type PdfReader = (bytes: Buffer) => Promise<PdfText>;

/** Characters of a PDF's text stored as its source at most (the page limit of the web worker, `LIMITS.maxChars`). */
export const PDF_TEXT_CHARS = 400_000;
/** PDF extractions at once (each is a process with its own memory cap); more wait. */
export const PDF_CONCURRENCY = 2;

/** The extractor's codes as the web tools' (`WEB_CODES`). */
function webCode(code: string): WebCode {
  if (code === "extract_timeout") return "web_timeout";
  if (code === "extract_too_large" || code === "extract_limit") return "web_too_large";
  if (code === "extract_unavailable") return "web_unavailable";
  return "web_bad_content";
}

export function extractorPdfReader(runner: ExtractRunner, tmpDir: string): PdfReader {
  let active = 0;
  const waiting: (() => void)[] = [];
  const slot = async () => {
    while (active >= PDF_CONCURRENCY) await new Promise<void>((r) => waiting.push(r));
    active++;
    return () => {
      active--;
      waiting.shift()?.();
    };
  };
  return async (bytes) => {
    const release = await slot();
    let file: string | undefined;
    try {
      fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
      file = path.join(fs.realpathSync(tmpDir), `web-pdf-${crypto.randomUUID()}.pdf`);
      fs.writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      const r = await runner({
        // Only what the runners read: the kind, the size and hash (the worker account's input copy checks both).
        file: { kind: "pdf", bytes: bytes.length, sha256 } as FileRow,
        path: file,
        signal: new AbortController().signal,
      });
      if (!r.ok) return { ok: false, code: webCode(r.code) };
      // Pages in order, a blank line between them; known secrets masked over the whole text first.
      const text = keptSegments(r.segments)
        .map((k) => k.scrubbed.text.trim())
        .filter(Boolean)
        .join("\n\n");
      return { ok: true, text, truncated: r.truncated };
    } catch {
      return { ok: false, code: "web_unavailable" };
    } finally {
      if (file) fs.rmSync(file, { force: true });
      release();
    }
  };
}
