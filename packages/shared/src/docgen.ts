import { z } from "zod";

/**
 * Document generation (#49, PRD FR-4.4·4.7·5.6): the agent makes a report, a table or a slide deck as a real file
 * — DOCX, XLSX, PPTX or PDF — through the common MCP tool `doc_create`, from structured blocks (never from code or
 * markup it writes). The file is stored with the conversation's files (#22), downloaded through the original-file
 * route and can be linked as a `document` artifact (#27). No HWP output in v1 (FR-4.4): the tool answers with a
 * guidance message instead.
 */

export const DOC_KINDS = ["docx", "xlsx", "pptx", "pdf"] as const;
export const DocKind = z.enum(DOC_KINDS);
export type DocKind = z.infer<typeof DocKind>;
/** Formats the tool names but never makes (FR-4.4): it answers with `DOC_HWP_HINT`. */
export const DOC_REFUSED_KINDS = ["hwp", "hwpx"] as const;

/** What the model is told when it asks for HWP (fixed words, FR-4.4). */
export const DOC_HWP_HINT =
  "한글(HWP·HWPX) 파일은 만들 수 없어요. 같은 내용을 DOCX(한글에서도 열려요)나 PDF로 만들 수 있어요 — kind를 docx 또는 pdf로 다시 요청하세요.";

/** What the model is told when a PPTX holds characters whose width cannot be bounded (fixed words, #49). */
export const DOC_UNSUPPORTED_TEXT_HINT =
  "슬라이드(PPTX)에는 ‰·‱, 두세 칸 대시(⸺ ⸻), 아랍어 표현형 합자(ﷺ ﷽ 등)를 넣을 수 없어요. 그 글자를 다른 표기로 바꾸거나(예: ‰ → 퍼밀), docx·pdf로 만드세요.";

/**
 * Bounds of one `doc_create` call. The MCP request itself is at most 1 MB (packages/mcp-tools MAX_BODY_BYTES); these
 * keep one document's work small and predictable inside that. The output limit is below the upload limit
 * (FILE_LIMITS.bytes), and a generated file takes one of the conversation's `FILE_LIMITS.perConversation` places.
 */
export const DOC_LIMITS = {
  title: 200,
  fileName: 120,
  blocks: 300,
  /** One paragraph, heading, list item, caption or reference. */
  textChars: 10_000,
  /** All text of the document (every string counted, cells included). */
  totalChars: 300_000,
  listItems: 200,
  tables: 30,
  tableColumns: 30,
  tableRows: 1_000,
  cellChars: 1_000,
  /** Cells of all tables together. */
  totalCells: 20_000,
  images: 10,
  /** One image as stored (its upload). */
  imageBytes: 10 * 1024 * 1024,
  imagesTotalBytes: 25 * 1024 * 1024,
  /** Decoded size of one image (width × height): refused above it (a small file can be a huge picture). */
  imagePixels: 40_000_000,
  references: 200,
  /** The generated file. */
  outputBytes: 25 * 1024 * 1024,
} as const;

/**
 * Only characters an XML 1.0 document may hold (the office formats are XML): no C0 controls but tab, line feed and
 * carriage return, no DEL, no lone surrogate (as code points, `u` flag) and no U+FFFE / U+FFFF. Refused, never
 * changed: the file says what was asked or is not made.
 */
// eslint-disable-next-line no-control-regex -- refusing control characters is the point (tab and newlines allowed)
const TEXT = /^[^\0-\x08\x0b\x0c\x0e-\x1f\x7f\ud800-\udfff\ufffe\uffff]*$/u;
// eslint-disable-next-line no-control-regex -- a single line: no control characters at all except tab
const LINE = /^[^\0-\x08\x0a-\x1f\x7f\ud800-\udfff\ufffe\uffff]*$/u;
const text = (max: number = DOC_LIMITS.textChars) => z.string().max(max).regex(TEXT);
const line = (max: number) => z.string().max(max).regex(LINE);

/** A file of this conversation (#22): its id as the file list or an upload returned it. */
export const DocFileId = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  .describe("id of a PNG or JPG file of this conversation (an upload sent with a message)");

export const DocCell = z.union([
  z.string().max(DOC_LIMITS.cellChars).regex(TEXT),
  z.number().finite(),
  z.null(),
]);
export type DocCell = z.infer<typeof DocCell>;

export const DocBlock = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("heading"),
    text: line(DOC_LIMITS.textChars).min(1),
    level: z.number().int().min(1).max(3).optional().describe("1 (default) to 3"),
  }),
  z.strictObject({ type: z.literal("paragraph"), text: text().min(1) }),
  z.strictObject({
    type: z.literal("list"),
    items: z.array(text().min(1)).min(1).max(DOC_LIMITS.listItems),
    ordered: z.boolean().optional(),
  }),
  z.strictObject({
    type: z.literal("table"),
    columns: z.array(line(DOC_LIMITS.cellChars)).min(1).max(DOC_LIMITS.tableColumns),
    rows: z.array(z.array(DocCell).max(DOC_LIMITS.tableColumns)).max(DOC_LIMITS.tableRows),
    caption: line(DOC_LIMITS.title).optional(),
  }),
  z.strictObject({
    type: z.literal("image"),
    fileId: DocFileId,
    caption: line(DOC_LIMITS.title).optional(),
  }),
  z.strictObject({
    type: z.literal("references"),
    title: line(DOC_LIMITS.title).optional().describe('default "참고문헌"'),
    items: z.array(text().min(1)).min(1).max(DOC_LIMITS.references),
  }),
]);
export type DocBlock = z.infer<typeof DocBlock>;

/** The document as the generator gets it (checked: `docInputProblem` is undefined). */
export const DocContent = z.strictObject({
  title: line(DOC_LIMITS.title).trim().min(1),
  subtitle: line(DOC_LIMITS.title).optional(),
  author: line(100).optional(),
  blocks: z.array(DocBlock).max(DOC_LIMITS.blocks),
});
export type DocContent = z.infer<typeof DocContent>;

/**
 * The limits the schema cannot express (totals across blocks, row widths). Undefined when the document fits;
 * otherwise the code: `doc_bad_input` (a row wider than its columns) or `doc_too_large`.
 */
export function docInputProblem(doc: DocContent): "doc_bad_input" | "doc_too_large" | undefined {
  let chars = doc.title.length + (doc.subtitle?.length ?? 0) + (doc.author?.length ?? 0);
  let cells = 0;
  let tables = 0;
  let images = 0;
  for (const b of doc.blocks) {
    switch (b.type) {
      case "heading":
      case "paragraph":
        chars += b.text.length;
        break;
      case "list":
        for (const i of b.items) chars += i.length;
        break;
      case "references":
        chars += b.title?.length ?? 0;
        for (const i of b.items) chars += i.length;
        break;
      case "image":
        images++;
        chars += b.caption?.length ?? 0;
        break;
      case "table":
        tables++;
        if (b.rows.some((r) => r.length !== b.columns.length)) return "doc_bad_input";
        cells += b.columns.length * (b.rows.length + 1);
        chars += b.caption?.length ?? 0;
        for (const c of b.columns) chars += c.length;
        for (const r of b.rows) for (const c of r) chars += typeof c === "string" ? c.length : 0;
        break;
    }
  }
  if (tables > DOC_LIMITS.tables || images > DOC_LIMITS.images) return "doc_too_large";
  if (cells > DOC_LIMITS.totalCells || chars > DOC_LIMITS.totalChars) return "doc_too_large";
  return undefined;
}

/** Outcome codes of `doc_create` (shown to the model as `{ error }`, logged as `docCode`). */
export const DOC_CODES = [
  "doc_not_allowed",
  "doc_bad_input",
  "doc_too_large",
  "doc_unsupported_text",
  "doc_hwp_unsupported",
  "doc_image_not_found",
  "doc_image_unsupported",
  "doc_image_too_large",
  "doc_output_too_large",
  "doc_too_many_files",
  "doc_invalid",
  "doc_failed",
  "doc_timeout",
  "doc_limit",
  "doc_busy",
  "doc_unavailable",
] as const;
export type DocCode = (typeof DOC_CODES)[number];
