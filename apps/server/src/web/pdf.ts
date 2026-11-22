import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PAGE_GAP, stripGapMarks } from "../citations/verify.js";
import type { FileRow } from "../files/store.js";
import { keptSegments, type ExtractRunner } from "../files/extract.js";
import type { WebCode } from "./service.js";

/**
 * PDF pages of `web_fetch` (#234). The web worker never parses a PDF: it hands the bytes back (worker.mjs
 * `fetchPage`), and the server reads their text with the document extractor of uploads (#48, `files/extract.ts`) —
 * the same pinned pdf.js in the same sandbox (no network, nothing writable, its own time and memory limits; as the
 * worker account when that is set up, #122). OCR is off for web PDFs: it would hold a page fetch for minutes. A page
 * without text (a scan, or a page number the extractor skipped) leaves `PAGE_GAP` on its own line where it stood —
 * no passage runs across it — and the text is reported as partial (`unread`, `truncated`).
 *
 * The bytes are written to a fresh 0600 file in a server-owned folder (`uploads-tmp`, emptied at start) for the
 * extractor to read, and removed right after. Known secrets are masked over the text as for uploads (`keptSegments`);
 * the source store masks them again on write.
 */

export type PdfText =
  { ok: true; text: string; truncated: boolean; unread: boolean } | { ok: false; code: WebCode };
/** `signal`: the calling run was stopped — a waiting read never starts, a running extraction is stopped. */
export type PdfReader = (bytes: Buffer, signal?: AbortSignal) => Promise<PdfText>;

/** Characters of a PDF's text stored as its source at most (the page limit of the web worker, `LIMITS.maxChars`). */
export const PDF_TEXT_CHARS = 400_000;
/** PDF extractions at once (each is a process with its own memory cap); more wait. */
export const PDF_CONCURRENCY = 2;
/** Where a PDF's header may start (worker.mjs `PDF_SNIFF_BYTES` — the same rule on both sides). */
export const PDF_SNIFF_BYTES = 1024;
export const isPdfBytes = (b: Buffer) => b.subarray(0, PDF_SNIFF_BYTES).toString("latin1").includes("%PDF-");

/** The extractor's codes as the web tools' (`WEB_CODES`). */
function webCode(code: string): WebCode {
  if (code === "extract_timeout") return "web_timeout";
  if (code === "extract_too_large" || code === "extract_limit") return "web_too_large";
  if (code === "extract_unavailable") return "web_unavailable";
  return "web_bad_content";
}

export function extractorPdfReader(runner: ExtractRunner, tmpDir: string): PdfReader {
  let active = 0;
  const waiting = new Set<() => void>();
  /** A slot, or false once `signal` aborted while waiting for one. */
  /** The next waiter, when a slot is free (one that gave up passes its turn on). */
  const wakeNext = () => {
    if (active < PDF_CONCURRENCY) waiting.values().next().value?.();
  };
  const slot = async (signal: AbortSignal): Promise<false | (() => void)> => {
    while (active >= PDF_CONCURRENCY) {
      if (signal.aborted) return false;
      await new Promise<void>((resolve) => {
        const wake = () => {
          waiting.delete(wake);
          signal.removeEventListener("abort", wake);
          resolve();
        };
        waiting.add(wake);
        signal.addEventListener("abort", wake, { once: true });
      });
    }
    // Checked again the moment the slot is taken: a read stopped meanwhile never starts (review #237 2차).
    if (signal.aborted) {
      wakeNext();
      return false;
    }
    active++;
    return () => {
      active--;
      wakeNext();
    };
  };
  return async (bytes, signal = new AbortController().signal) => {
    const release = await slot(signal);
    if (!release) return { ok: false, code: "web_not_allowed" };
    let file: string | undefined;
    try {
      fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
      file = path.join(fs.realpathSync(tmpDir), `web-pdf-${crypto.randomUUID()}.pdf`);
      fs.writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
      const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
      // Stopped while the copy was written: no extractor is started.
      if (signal.aborted) return { ok: false, code: "web_not_allowed" };
      const r = await runner({
        // Only what the runners read: the kind, the size and hash (the worker account's input copy checks both).
        file: { kind: "pdf", bytes: bytes.length, sha256 } as FileRow,
        path: file,
        signal,
      });
      if (signal.aborted) return { ok: false, code: "web_not_allowed" };
      if (!r.ok) return { ok: false, code: webCode(r.code) };
      // Pages in order, a blank line between them; known secrets masked over the whole text first. Where a page was
      // not read (a scan ends the unit before it early; a page without a unit is skipped), `PAGE_GAP` stands.
      const parts: string[] = [];
      let unread = r.ocr === "unavailable" || r.ocr === "partial";
      let last = 0;
      let cut = false;
      for (const k of keptSegments(r.segments)) {
        const page = k.seg.unit;
        if (cut || page > last + 1) {
          parts.push(PAGE_GAP);
          unread = true;
        }
        const text = stripGapMarks(k.scrubbed.text).trim();
        if (text) parts.push(text);
        last = Math.max(last, page);
        cut = k.endsEarly || k.gap;
      }
      if (parts.length && (cut || (typeof r.units === "number" && r.units > last))) {
        parts.push(PAGE_GAP);
        unread = true;
      }
      const text = parts.every((p) => p === PAGE_GAP) ? "" : parts.join("\n\n");
      return { ok: true, text, truncated: r.truncated || unread, unread };
    } catch {
      return { ok: false, code: "web_unavailable" };
    } finally {
      if (file) fs.rmSync(file, { force: true });
      release();
    }
  };
}
