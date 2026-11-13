import { z } from "zod";
import { UploadedFile } from "./files.js";
import { FileExtract, FileLocator } from "./locators.js";

/**
 * The file viewer (#24, PRD FR-4.5, 수용 기준 2·11): a file citation ("보고서.pdf · 12쪽") opens the file at its
 * locator and highlights the passage. The viewer shows the **extracted, scrubbed** text of the file (never the
 * original bytes as text — a known secret is a placeholder there, #78), laid out by its units: pages with their
 * line or word boxes, paragraphs, tables by row and column, sheets by cell, slides, lines.
 *
 * The server resolves the locator (`ViewTarget`) and says how exactly it could: only a place it can stand behind
 * is highlighted — the passage itself (`exact`), or the unit it is in when the passage's own range cannot be
 * shown (`unit`, with the reasons). A locator of other bytes (`stale`) or of a unit the file does not have
 * (`not_found`) highlights nothing.
 */

const n = z.number().int().positive();
const box = z.tuple([
  z.number().min(0).max(1),
  z.number().min(0).max(1),
  z.number().min(0).max(1),
  z.number().min(0).max(1),
]);

/** A finer place inside a unit's text (`[start, end)`): a line's or OCR word's box, a line number, a cell. */
export const ViewMark = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  bbox: box.optional(),
  line: n.optional(),
  col: n.optional(),
  range: z
    .string()
    .regex(/^[A-Z]{1,3}[0-9]{1,7}(?::[A-Z]{1,3}[0-9]{1,7})?$/)
    .optional(),
});
export type ViewMark = z.infer<typeof ViewMark>;

/** One unit of the file as the viewer draws it. */
export const ViewSegment = z.object({
  /** Its place in the file's order (`from` / `next` page over it). */
  seq: z.number().int().nonnegative(),
  locator: FileLocator,
  text: z.string(),
  marks: z.array(ViewMark),
  /** A known secret's removal cost the unit its finer places: only its own locator (page, row …) holds. */
  approximate: z.boolean(),
  /** The stored copy has a gap (cut for display, or hidden text next to it). */
  cut: z.boolean(),
  /** One piece of a paragraph or table row split in reading order (HWP, #23): its offsets are not the unit's. */
  split: z.boolean(),
});
export type ViewSegment = z.infer<typeof ViewSegment>;

/**
 * How a locator was resolved:
 * - `exact` — the passage itself is highlighted (`range`), with its box when it has one
 * - `unit` — the unit it is in is highlighted (`seqs`, maybe one cell or line of it: `focus`); `reasons` say why
 *   not the passage
 * - `stale` — the locator was made from other bytes of the file: nothing is highlighted
 * - `not_found` — the file has no such unit (or the locator is of another file): nothing is highlighted
 * - `unreadable` — the file's text is not (yet) there: still being read, or it could not be read
 */
export const LOCATE_STATUSES = ["exact", "unit", "stale", "not_found", "unreadable"] as const;
export const LocateStatus = z.enum(LOCATE_STATUSES);
export type LocateStatus = z.infer<typeof LocateStatus>;

/**
 * Why a place is not highlighted as exactly as the locator says (fixed codes, `LOCATE_REASON_TEXT`):
 * - `no_range` — the locator names the unit only (no character range)
 * - `approximate` — a known secret's removal cost the unit its finer places
 * - `split` — a piece of a split paragraph or row: no range of its own
 * - `unverified` — the range is not one of a citation the server checked, or the cited passage is no longer
 *   exactly there (the text changed since: a secret registered later is hidden now)
 * - `out_of_range` — the range does not fit the unit's text
 * - `other_file` — the locator is of another file
 * - `revision_changed` — the locator was made from other bytes
 * - `unit_missing` — no unit of the file is at that place (cut off by a limit, or never there)
 * - `pending` / `failed` — the text is still being read / could not be read
 */
export const LOCATE_REASONS = [
  "no_range",
  "approximate",
  "split",
  "unverified",
  "out_of_range",
  "other_file",
  "revision_changed",
  "unit_missing",
  "pending",
  "failed",
] as const;
export const LocateReason = z.enum(LOCATE_REASONS);
export type LocateReason = z.infer<typeof LocateReason>;

export const LOCATE_REASON_TEXT: Record<LocateReason, string> = {
  no_range: "인용 위치에 구절 범위가 없어 그 위치 전체를 표시했어요.",
  approximate: "비밀 값을 가리면서 세부 위치가 사라져 그 위치 전체를 표시했어요.",
  split: "나뉘어 저장된 문단·행이라 구절 범위 없이 그 위치 전체를 표시했어요.",
  unverified: "인용한 구절이 그 범위에 그대로 있는지 확인되지 않아 그 위치 전체를 표시했어요.",
  out_of_range: "구절 범위가 저장된 글자와 맞지 않아 그 위치 전체를 표시했어요.",
  other_file: "다른 파일의 위치라 강조하지 않았어요.",
  revision_changed: "인용한 뒤 파일 내용이 달라져 위치를 강조하지 않았어요.",
  unit_missing: "인용한 위치를 이 파일의 글자에서 찾지 못했어요.",
  pending: "아직 파일의 글자를 읽는 중이에요.",
  failed: "이 파일의 글자를 읽지 못해 위치를 보여 줄 수 없어요.",
};

/** A range of one segment's text. */
export const SegmentRange = z.object({
  seq: z.number().int().nonnegative(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});
export type SegmentRange = z.infer<typeof SegmentRange>;

export const ViewTarget = z.object({
  status: LocateStatus,
  reasons: z.array(LocateReason),
  /** The segments of the located unit (several for a split paragraph or row); empty when none is highlighted. */
  seqs: z.array(z.number().int().nonnegative()),
  /** `exact`: the passage. */
  range: SegmentRange.optional(),
  /** `unit`: the one line or cell of the unit the locator names, when that much is sure. */
  focus: SegmentRange.optional(),
  /** `exact`: the passage's box on its page or image (fractions, origin top left). */
  bbox: box.optional(),
});
export type ViewTarget = z.infer<typeof ViewTarget>;

/**
 * `GET /api/files/:id/view?loc=&from=&limit=` — the file, its extraction, a window of its segments (around the
 * located unit when `loc` is given and `from` is not) and how the locator resolved (null without `loc`).
 */
export const FileViewResponse = z.object({
  file: UploadedFile,
  extract: FileExtract,
  items: z.array(ViewSegment),
  /** The `from` of the segments before / after this window, or null at the start / end. */
  prev: z.number().int().nullable(),
  next: z.number().int().nullable(),
  target: ViewTarget.nullable(),
});
export type FileViewResponse = z.infer<typeof FileViewResponse>;

/** The viewer's in-app address: `/c/:conversationId/files/:fileId?loc=<locator JSON>`. */
export function fileViewPath(conversationId: string, fileId: string, locator?: FileLocator): string {
  const base = `/c/${encodeURIComponent(conversationId)}/files/${encodeURIComponent(fileId)}`;
  return locator ? `${base}?loc=${encodeURIComponent(JSON.stringify(locator))}` : base;
}

/** The locator of a `loc` query value, or undefined when it is not one. */
export function parseLocParam(raw: string | null | undefined): FileLocator | undefined {
  if (!raw || raw.length > 4096) return undefined;
  try {
    const p = FileLocator.safeParse(JSON.parse(raw));
    return p.success ? p.data : undefined;
  } catch {
    return undefined;
  }
}
