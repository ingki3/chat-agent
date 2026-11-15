import { z } from "zod";

/**
 * Where a piece of an uploaded file's text is (#48, PRD FR-4.3·4.5): the common locator of extraction, the file
 * tools (`file_list`, `file_read`, `file_search`), file citations and — next — the file viewer (#24), which opens
 * the file at the locator and highlights it.
 *
 * - `fileRevision`: the SHA-256 (hex) of the stored bytes the locator was made from. A locator of other bytes
 *   does not apply (uploads never change; the revision makes that checkable).
 * - `kind` says which fields matter:
 *   `page` (PDF text: `page`, maybe `bbox`, `charRange`) · `line` (TXT/MD: `line`) · `paragraph` (DOCX, HWP,
 *   HWPX: `paragraph`, counted from 1 over the body's non-empty paragraphs) · `table` (DOCX, HWP, HWPX: `table`,
 *   `row`, maybe `col`; top-level tables counted from 1, a merged cell in its first row and column) · `cell_range` (XLSX/CSV: `sheet` for XLSX, `row`, `range` like `B2` or `A2:C2`, maybe `col`) ·
 *   `slide` (PPTX: `slide`, in the order shown) · `ocr_box` (scanned PDF pages and images: `bbox`, `page` for a
 *   PDF).
 * - HWP/HWPX notes (#23): a footnote's or endnote's text is its own unit with the place of the paragraph or table
 *   row it is anchored in and `footnote` / `endnote` — the number the document stores for it (left out when it
 *   stores none).
 * - Numbers count from 1. `bbox` is `[x, y, width, height]` as fractions of the page or image (0–1, origin at the
 *   top left), whatever its size or rotation. `charRange` is `[start, end)` in UTF-16 units of the unit's
 *   extracted text (what `file_read` returns for that page, line, paragraph … ).
 */
export const LOCATOR_KINDS = [
  "page",
  "line",
  "paragraph",
  "table",
  "cell_range",
  "slide",
  "ocr_box",
] as const;
export const LocatorKind = z.enum(LOCATOR_KINDS);
export type LocatorKind = z.infer<typeof LocatorKind>;

const n = z.number().int().positive();
const frac = z.number().min(0).max(1);

export const FileLocator = z.object({
  fileId: z.string().min(1).max(64),
  fileRevision: z.string().regex(/^[0-9a-f]{64}$/),
  kind: LocatorKind,
  page: n.optional(),
  line: n.optional(),
  paragraph: n.optional(),
  table: n.optional(),
  row: n.optional(),
  col: n.optional(),
  sheet: z.string().max(200).optional(),
  range: z
    .string()
    .regex(/^[A-Z]{1,3}[0-9]{1,7}(?::[A-Z]{1,3}[0-9]{1,7})?$/)
    .optional(),
  slide: n.optional(),
  footnote: n.optional(),
  endnote: n.optional(),
  bbox: z.tuple([frac, frac, frac, frac]).optional(),
  charRange: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
});
export type FileLocator = z.infer<typeof FileLocator>;

/** The kind-specific part of a locator (what an extractor produces before the file's id and revision are known). */
export type UnitLocator = Omit<FileLocator, "fileId" | "fileRevision">;

/**
 * How a locator reads after the file name (PRD FR-4.4·4.5): "12쪽", "3번째 표 · 2행", "12번째 문단", "성적 · B2",
 * "2번째 슬라이드", "5번째 줄", "12쪽 · 사진 속 글자", "4번째 문단 · 각주 1", "2번째 표 · 3행 · 미주 2".
 */
export function locatorLabel(l: Pick<FileLocator, "kind"> & Partial<FileLocator>): string {
  const place = placeLabel(l);
  const note = l.footnote ? `각주 ${l.footnote}` : l.endnote ? `미주 ${l.endnote}` : "";
  return [place, note].filter(Boolean).join(" · ");
}

function placeLabel(l: Pick<FileLocator, "kind"> & Partial<FileLocator>): string {
  switch (l.kind) {
    case "page":
      return l.page ? `${l.page}쪽` : "";
    case "line":
      return l.line ? `${l.line}번째 줄` : "";
    case "paragraph":
      return l.paragraph ? `${l.paragraph}번째 문단` : "";
    case "table":
      return [l.table && `${l.table}번째 표`, l.row && `${l.row}행`, l.col && `${l.col}열`]
        .filter(Boolean)
        .join(" · ");
    case "cell_range":
      return [l.sheet, l.range ?? (l.row ? `${l.row}행` : undefined)].filter(Boolean).join(" · ");
    case "slide":
      return l.slide ? `${l.slide}번째 슬라이드` : "";
    case "ocr_box":
      return [l.page && `${l.page}쪽`, "사진 속 글자"].filter(Boolean).join(" · ");
  }
}

/** "보고서.pdf · 12쪽" — a file citation as the answer shows it. */
export function fileCitationLabel(name: string, l: Pick<FileLocator, "kind"> & Partial<FileLocator>): string {
  const where = locatorLabel(l);
  return where ? `${name} · ${where}` : name;
}

/**
 * Text extraction of an upload (#48): `pending` until the extractor ran, then `ok` (text with locators; maybe
 * none, maybe `truncated`) or `failed` with a fixed code. `ocr` says whether picture text was read: `none` (not
 * needed), `done`, `partial` (more scanned pages than the limit), `unavailable` (the OCR engine is missing on
 * this server — docs/ops.md §26).
 */
export const EXTRACT_STATUSES = ["pending", "ok", "failed"] as const;
export const ExtractStatus = z.enum(EXTRACT_STATUSES);
export type ExtractStatus = z.infer<typeof ExtractStatus>;

export const OCR_STATES = ["none", "done", "partial", "unavailable"] as const;
export const OcrState = z.enum(OCR_STATES);
export type OcrState = z.infer<typeof OcrState>;

/**
 * Why an extraction failed (fixed codes; the model and the log see these, never file content):
 * - `extract_unsupported` — no extractor for this kind (or an HWP version other than 5)
 * - `extract_too_large` — past a limit: decompressed size (zip bomb), entries, image pixels
 * - `extract_zip_invalid` — a broken or unsupported archive (ZIP64, encrypted entries, sizes or CRC that lie)
 * - `extract_path_escape` — an archive entry or a part reference outside the package (zip slip)
 * - `extract_xml_forbidden` — a DOCTYPE or entity declaration (XXE, billion laughs): never processed
 * - `extract_xml_invalid` — XML that is not well-formed (or nested too deep)
 * - `extract_encrypted` — a password-protected PDF, HWP or HWPX (HWP: also DRM and certificate encryption)
 * - `extract_distribution` — an HWP distribution document (배포용 문서: encrypted, view only)
 * - `extract_invalid` — the file cannot be read as its kind
 * - `ocr_unavailable` — an image, and no OCR engine on this server
 * - `extract_timeout` / `extract_limit` — the extractor ran out of time / memory or output
 * - `extract_unavailable` — the extractor could not run here (no sandbox, a hard-linked file)
 * - `extract_changed` — the bytes read are not the stored file's (its hash differs)
 * - `extract_failed` — anything else
 */
export const EXTRACT_CODES = [
  "extract_unsupported",
  "extract_too_large",
  "extract_zip_invalid",
  "extract_path_escape",
  "extract_xml_forbidden",
  "extract_xml_invalid",
  "extract_encrypted",
  "extract_distribution",
  "extract_invalid",
  "ocr_unavailable",
  "extract_timeout",
  "extract_limit",
  "extract_unavailable",
  "extract_changed",
  "extract_failed",
] as const;
export const ExtractCode = z.enum(EXTRACT_CODES);
export type ExtractCode = z.infer<typeof ExtractCode>;

/** What the screen says for a failed extraction (Korean, fixed). */
export const EXTRACT_CODE_TEXT: Record<ExtractCode, string> = {
  extract_unsupported: "아직 이 형식의 글자는 읽을 수 없어요",
  extract_too_large: "파일이 너무 크거나 복잡해서 읽지 않았어요",
  extract_zip_invalid: "파일이 손상됐거나 지원하지 않는 방식으로 압축됐어요",
  extract_path_escape: "파일 구조가 안전하지 않아 읽지 않았어요",
  extract_xml_forbidden: "파일 구조가 안전하지 않아 읽지 않았어요",
  extract_xml_invalid: "파일이 손상돼 읽을 수 없어요",
  extract_encrypted: "암호가 걸린 파일이라 읽을 수 없어요",
  extract_distribution: "배포용(편집 제한) 문서라 읽을 수 없어요",
  extract_invalid: "파일을 읽을 수 없어요",
  ocr_unavailable: "이 서버에서는 사진 속 글자를 읽을 수 없어요",
  extract_timeout: "읽는 데 시간이 너무 오래 걸려 멈췄어요",
  extract_limit: "읽는 데 자원이 너무 많이 들어 멈췄어요",
  extract_unavailable: "지금은 파일을 읽을 수 없어요",
  extract_changed: "파일을 읽을 수 없어요",
  extract_failed: "파일을 읽을 수 없어요",
};

/** One file's extraction as the API returns it (`GET /api/files/:id/extract`). */
export const FileExtract = z.object({
  fileId: z.string(),
  fileRevision: z.string(),
  status: ExtractStatus,
  code: ExtractCode.nullable(),
  ocr: OcrState,
  /** Pages (PDF), slides (PPTX), sheets (XLSX), blocks (DOCX, HWP, HWPX) … in the file; null when not known. */
  units: z.number().int().nonnegative().nullable(),
  /** Text units stored (pages with text, paragraphs, table rows, lines …). */
  segments: z.number().int().nonnegative(),
  characters: z.number().int().nonnegative(),
  /** True when the file had more than the limits keep (pages, characters). */
  truncated: z.boolean(),
});
export type FileExtract = z.infer<typeof FileExtract>;

/** One unit of text with where it is. */
export const FileSegment = z.object({ locator: FileLocator, text: z.string() });
export type FileSegment = z.infer<typeof FileSegment>;

export const FileTextResponse = z.object({
  extract: FileExtract,
  items: z.array(FileSegment),
  /** The `from` of the next page of segments, or null at the end. */
  next: z.number().int().nullable(),
});
export type FileTextResponse = z.infer<typeof FileTextResponse>;
