import { z } from "zod";

/**
 * File uploads (#22, PRD FR-4.1·4.2·4.6). The client checks these before it sends anything (FR-4.6: "업로드 전에
 * 알려준다"); the server checks every one of them again — the size while the body streams in, the count in the
 * same statement that adds the row, and the type by extension *and* content.
 */
export const FILE_LIMITS = {
  /** Per file (FR-4.6 초안: 50MB — inside Cloudflare's 100MB request limit). */
  bytes: 50 * 1024 * 1024,
  /** Per conversation (FR-4.6 초안: 20개), attached or not yet sent. */
  perConversation: 20,
  /** Characters of a file name kept (code points). */
  nameChars: 200,
} as const;

/**
 * The supported formats (FR-4.2): PDF, HWP/HWPX, DOCX, XLSX/CSV, PPTX, TXT/MD and PNG/JPG images. Nothing else is
 * accepted — in particular no SVG, HTML or XML (active content), no archives and no executables. `exts` are the
 * extensions a name may end with; `mediaType` is what the server answers with (never the browser's guess).
 */
export const FILE_KINDS = {
  pdf: { exts: ["pdf"], mediaType: "application/pdf", label: "PDF" },
  hwp: { exts: ["hwp"], mediaType: "application/x-hwp", label: "한글(HWP)" },
  hwpx: { exts: ["hwpx"], mediaType: "application/hwp+zip", label: "한글(HWPX)" },
  docx: {
    exts: ["docx"],
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    label: "Word",
  },
  xlsx: {
    exts: ["xlsx"],
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    label: "Excel",
  },
  pptx: {
    exts: ["pptx"],
    mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    label: "PowerPoint",
  },
  csv: { exts: ["csv"], mediaType: "text/csv", label: "CSV" },
  txt: { exts: ["txt"], mediaType: "text/plain", label: "텍스트" },
  md: { exts: ["md", "markdown"], mediaType: "text/markdown", label: "마크다운" },
  png: { exts: ["png"], mediaType: "image/png", label: "PNG 이미지" },
  jpg: { exts: ["jpg", "jpeg"], mediaType: "image/jpeg", label: "JPG 이미지" },
} as const satisfies Record<string, { exts: readonly string[]; mediaType: string; label: string }>;

export const FileKind = z.enum(
  Object.keys(FILE_KINDS) as [keyof typeof FILE_KINDS, ...(keyof typeof FILE_KINDS)[]],
);
export type FileKind = z.infer<typeof FileKind>;

/** `accept` for the file picker: every allowed extension. */
export const FILE_ACCEPT = Object.values(FILE_KINDS)
  .flatMap((k) => k.exts.map((e) => `.${e}`))
  .join(",");

/** Lower-cased extension of a name (after the last dot), or "" when it has none. */
export function fileExtension(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** The kind a name claims by its extension; undefined when the extension is not supported. */
export function fileKindOf(name: string): FileKind | undefined {
  const ext = fileExtension(name);
  if (!ext) return undefined;
  for (const [kind, k] of Object.entries(FILE_KINDS))
    if ((k.exts as readonly string[]).includes(ext)) return kind as FileKind;
  return undefined;
}

/**
 * Why an upload was refused (`{ error }`). Status: 413 `file_too_large`, 409 `too_many_files`, 415 the type codes,
 * 400 `file_empty` / `invalid_request`.
 */
export const FILE_ERRORS = [
  "file_too_large",
  "too_many_files",
  "file_type_unsupported",
  "file_type_mismatch",
  "file_empty",
  "file_attached",
  "upload_cancelled",
  "too_many_cancels",
] as const;
export type FileError = (typeof FILE_ERRORS)[number];

/** Header that carries the file name of an upload, percent-encoded UTF-8 (the body is the raw bytes). */
export const FILE_NAME_HEADER = "x-file-name";
/**
 * Header with the upload's own id (a UUID the client makes before it sends anything, review #102 6차): the client
 * can cancel it on the server (`DELETE /api/uploads/:uploadId`) before it knows the file's id — whether the upload
 * is still under way or already stored.
 */
export const UPLOAD_ID_HEADER = "x-upload-id";

/** One uploaded file as the API returns it. */
export const UploadedFile = z.object({
  id: z.string(),
  conversationId: z.string(),
  /** The user message it was sent with; null while it is only in the composer. */
  messageId: z.string().nullable(),
  /** The client's upload id (`UPLOAD_ID_HEADER`). */
  uploadId: z.string().nullable(),
  name: z.string(),
  kind: FileKind,
  mediaType: z.string(),
  bytes: z.number().int().nonnegative(),
  createdAt: z.number(),
});
export type UploadedFile = z.infer<typeof UploadedFile>;
export const FileListResponse = z.object({ items: z.array(UploadedFile) });
export type FileListResponse = z.infer<typeof FileListResponse>;
