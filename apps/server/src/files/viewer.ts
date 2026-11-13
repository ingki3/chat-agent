import {
  boundText,
  CITATION_LIMITS,
  FileLocator,
  ViewMark,
  type FileExtract,
  type LocateReason,
  type SegmentRange,
  type ViewSegment,
  type ViewTarget,
} from "@agentlee/shared";
import { scrubKnown } from "../secrets/known.js";
import type { SegmentRow } from "./extract.js";
import { parseMarks, type Mark } from "./scrub.js";
import { isBox, prefixHash, segmentLocator, union } from "./text.js";
import type { FileRow } from "./store.js";

/**
 * The file viewer's server side (#24, PRD FR-4.5): a file's segments as the viewer draws them, and where a locator
 * is — resolved against the text served **now** (scrubbed with the secrets known now, `FileExtracts.segments`).
 *
 * The rule: highlight only what can be stood behind.
 * - The passage itself (`exact`) only when the locator's range fits the unit, the unit kept its finer places (not
 *   `approximate`, not a `split` piece), and a citation the caller may see (`cited`: the owner's conversation, or
 *   the viewer's projection, #29) names this very locator **and** its checked passage is still exactly at that
 *   range. A later secret, hidden now, moves offsets: then the range is not shown (`unverified`).
 * - Otherwise the unit it is in (`unit`, with the reasons) — and one line or cell of it when the locator names
 *   one that the unit's marks still have.
 * - Nothing for a locator of other bytes (`stale`), of another file or of a unit the file does not have.
 */

/** A checked passage of a citation of this file: the locator it was given and the quote stored with it. */
export type CitedPassage = {
  locator: FileLocator;
  quote: string;
  /** `prefixHash` of the unit's text up to the passage's end when it was checked (files/text.ts); absent: older. */
  textHash: string | undefined;
};

type StoredLoc = { split?: unknown };
const storedSplit = (seg: Pick<SegmentRow, "locator">): boolean => {
  try {
    return (JSON.parse(seg.locator) as StoredLoc).split === true;
  } catch {
    return false;
  }
};

/** The known fields of a mark only (cells, lines, boxes) — nothing else a stored mark might carry. */
function viewMarks(marks: readonly Mark[] | null, length: number): ViewMark[] {
  const out: ViewMark[] = [];
  for (const [start, end, f] of marks ?? []) {
    if (!(Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start <= end && end <= length))
      continue;
    const m = ViewMark.safeParse({
      start,
      end,
      ...(isBox(f.bbox) ? { bbox: f.bbox } : {}),
      ...(typeof f.line === "number" ? { line: f.line } : {}),
      ...(typeof f.col === "number" ? { col: f.col } : {}),
      ...(typeof f.range === "string" ? { range: f.range } : {}),
    });
    if (m.success) out.push(m.data);
  }
  return out;
}

/** One segment as the viewer gets it. Its text and locator are already scrubbed (`FileExtracts.segments`). */
export function viewSegment(file: Pick<FileRow, "id" | "sha256">, seg: SegmentRow): ViewSegment {
  const approximate = !!seg.approximate;
  return {
    seq: seg.seq,
    locator: segmentLocator(file, seg),
    text: seg.text,
    // An approximate unit's marks are not served: none of its finer places is true any more.
    marks: approximate ? [] : viewMarks(parseMarks(seg.marks), seg.text.length),
    approximate,
    cut: !!seg.cut,
    split: storedSplit(seg),
  };
}

const sameNote = (a: FileLocator, b: FileLocator) => a.footnote === b.footnote && a.endnote === b.endnote;
/** Sheet names are file text: compared as served (scrubbed with the secrets known now). */
const sheetOf = (l: FileLocator) =>
  l.sheet === undefined ? undefined : scrubKnown(l.sheet, { tail: false });

/** Whether segment `s` (its locator `sl`, its marks) is (a piece of) the unit `loc` names. */
function sameUnit(sl: FileLocator, s: ViewSegment, loc: FileLocator): boolean {
  if (sl.kind !== loc.kind) return false;
  switch (loc.kind) {
    case "page":
      return sl.page === loc.page;
    case "ocr_box":
      return sl.page === loc.page;
    case "line":
      return s.marks.some((m) => m.line === loc.line);
    case "paragraph":
      return sl.paragraph === loc.paragraph && sameNote(sl, loc);
    case "table":
      return sl.table === loc.table && sl.row === loc.row && sameNote(sl, loc);
    case "cell_range":
      return sheetOf(sl) === sheetOf(loc) && sl.row === loc.row;
    case "slide":
      return sl.slide === loc.slide;
  }
}

/**
 * A run of lines that lost its marks (approximate) and surely holds `line`: the run whose first line is the last at
 * or before it, and `line` within the lines its served text still has. The served text is the lower bound of the
 * run's lines (a hidden secret may have taken a line break with it): a line past it may be in the run or not —
 * undecidable, so no run (review #123: never the first run for any later line).
 */
function approximateRun(items: readonly ViewSegment[], line: number): ViewSegment | undefined {
  let best: ViewSegment | undefined;
  for (const s of items)
    if (s.locator.kind === "line" && s.locator.line !== undefined && s.locator.line <= line)
      if (!best || s.locator.line > best.locator.line!) best = s;
  if (!best?.approximate) return undefined;
  const surely = best.text.split("\n").length;
  return line < best.locator.line! + surely ? best : undefined;
}

/** The identifying fields of a locator, for "is this the locator a citation was given". */
function key(l: FileLocator): string {
  return JSON.stringify([
    l.fileId,
    l.fileRevision,
    l.kind,
    l.page ?? null,
    l.line ?? null,
    l.paragraph ?? null,
    l.table ?? null,
    l.row ?? null,
    l.col ?? null,
    sheetOf(l) ?? null,
    l.range ?? null,
    l.slide ?? null,
    l.footnote ?? null,
    l.endnote ?? null,
    l.charRange ?? null,
  ]);
}

/** The passage as `findSnippetAt` quotes it (citations/verify.ts): whitespace collapsed, trimmed, bounded. */
const quoteOf = (text: string) => boundText(text.replace(/\s+/g, " ").trim(), CITATION_LIMITS.snippet);

/**
 * Where `loc` is in `items` (every segment of the file, in order) — see the file comment. `extract` is the
 * file's extraction state; `cited` the checked passages of citations of this file the caller may see.
 */
export function resolveTarget(
  file: Pick<FileRow, "id" | "sha256">,
  extract: Pick<FileExtract, "status">,
  items: readonly ViewSegment[],
  loc: FileLocator,
  cited: readonly CitedPassage[],
): ViewTarget {
  const none = (status: ViewTarget["status"], reason: LocateReason): ViewTarget => ({
    status,
    reasons: [reason],
    seqs: [],
  });
  if (loc.fileId !== file.id) return none("not_found", "other_file");
  if (loc.fileRevision !== file.sha256) return none("stale", "revision_changed");
  if (extract.status === "pending") return none("unreadable", "pending");
  if (extract.status !== "ok") return none("unreadable", "failed");

  let hits = items.filter((s) => sameUnit(s.locator, s, loc));
  if (!hits.length && loc.kind === "line" && loc.line !== undefined) {
    const run = approximateRun(items, loc.line);
    if (run) hits = [run];
  }
  if (!hits.length) return none("not_found", "unit_missing");

  const seqs = hits.map((s) => s.seq);
  const reasons = new Set<LocateReason>();
  if (hits.some((s) => s.approximate)) reasons.add("approximate");
  if (hits.some((s) => s.split)) reasons.add("split");
  const only = hits.length === 1 ? hits[0]! : undefined;

  // The line or cell the locator names, while the unit's marks still have it.
  let focus: SegmentRange | undefined;
  for (const s of hits) {
    if (s.approximate || focus) continue;
    const m =
      loc.kind === "line"
        ? s.marks.find((x) => x.line === loc.line)
        : loc.kind === "table" && loc.col !== undefined
          ? s.marks.find((x) => x.col === loc.col)
          : loc.kind === "cell_range" && loc.range !== undefined
            ? s.marks.find((x) => x.range === loc.range)
            : undefined;
    if (m) focus = { seq: s.seq, start: m.start, end: m.end };
  }

  // The passage: `charRange` is within the unit's text — within the named line for a run of lines.
  let range: SegmentRange | undefined;
  if (!loc.charRange) reasons.add("no_range");
  else if (only && !only.approximate && !only.split) {
    const [a, b] = loc.charRange;
    const base = loc.kind === "line" ? focus : { seq: only.seq, start: 0, end: only.text.length };
    if (!base || a >= b || base.start + b > base.end) reasons.add("out_of_range");
    else range = { seq: only.seq, start: base.start + a, end: base.start + b };
  }
  if (range) {
    const k = key(loc);
    const at = quoteOf(only!.text.slice(range.start, range.end));
    const before = prefixHash(only!.text, range.end);
    // A citation the caller may see gave this locator, and the unit's text up to the passage's end is still the text
    // it was checked in (review #123: the same quote elsewhere after a shift is not the cited place).
    if (!cited.some((c) => key(c.locator) === k && c.quote === at && c.textHash === before)) {
      reasons.add("unverified");
      range = undefined;
    }
  }
  if (range && only) {
    const over = only.marks.filter(
      (m) => m.start < Math.max(range.end, range.start + 1) && m.end > range.start,
    );
    const bbox =
      loc.kind === "page" || loc.kind === "ocr_box"
        ? union(over.flatMap((m) => (m.bbox ? [m.bbox] : [])))
        : undefined;
    return {
      status: "exact",
      reasons: [],
      seqs,
      range,
      ...(focus ? { focus } : {}),
      ...(bbox ? { bbox } : {}),
    };
  }
  return { status: "unit", reasons: [...reasons], seqs, ...(focus ? { focus } : {}) };
}

/** Segments one view answer holds by default / at most, and how many come before the located unit. */
export const VIEW_LIMIT = 100;
export const VIEW_MAX = 300;
export const VIEW_BEFORE = 20;

/**
 * The window of segments to send: from the first with `seq >= from` when `from` is given (up to `to`, exclusive,
 * when given), else around the target (a few before it), else from the start. `prev` / `next`: the `from` of the windows before / after it.
 */
export function viewWindow(
  items: readonly ViewSegment[],
  opts: { from?: number | undefined; to?: number | undefined; limit: number; around?: number | undefined },
): { items: ViewSegment[]; prev: number | null; next: number | null } {
  let start = 0;
  if (opts.from !== undefined) {
    start = items.findIndex((s) => s.seq >= opts.from!);
    if (start === -1) start = items.length;
  } else if (opts.around !== undefined) {
    const at = items.findIndex((s) => s.seq === opts.around);
    start = Math.max(0, at - VIEW_BEFORE);
  }
  let end = Math.min(items.length, start + opts.limit);
  // `to` (exclusive): a window before one already shown ends where that one starts (review #123: no overlap).
  if (opts.to !== undefined) {
    const stop = items.findIndex((s) => s.seq >= opts.to!);
    if (stop !== -1) end = Math.max(start, Math.min(end, stop));
  }
  return {
    items: items.slice(start, end),
    prev: start > 0 ? items[Math.max(0, start - opts.limit)]!.seq : null,
    next: end < items.length ? items[end]!.seq : null,
  };
}
