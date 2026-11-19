import crypto from "node:crypto";
import {
  EXTRACT_CODE_TEXT,
  FileLocator,
  frameExternal,
  locatorLabel,
  type CitationStatus,
  type FileExtract,
  type UnitLocator,
} from "@agentlee/shared";
import type { ToolScope } from "@agentlee/mcp-tools";
import { findSnippetAt } from "../citations/verify.js";
import type { ConversationStore } from "../conversations/store.js";
import { scrubKnown, scrubKnownDeep } from "../secrets/known.js";
import { toFileExtract, type FileExtracts, type SegmentRow } from "./extract.js";
import type { Mark } from "./scrub.js";
import type { FileRow, FileStore } from "./store.js";

/**
 * What the file tools read (#48): the extracted text of the run's conversation's uploads, with locators.
 *
 * - **Scope** (`inScope`, one place for every tool): the conversation is the token user's, the file is that
 *   conversation's and that user's (the #22 rules), and it went with a message that is still **active** — one an
 *   edit or a regeneration cut off is history, not this run's (review #107; #106 builds the context with the
 *   same rule: files of active messages, the current input included). Unsent composer files are not read either.
 *   Anything else is "not found". Older versions stay readable to their owner through the file routes (archive
 *   access), not through a run.
 * - **Secrets** (review #107): every segment is scrubbed with the secrets known now (`FileExtracts.segments`), and
 *   every tool output once more as a whole (`scrubKnownDeep`) — file names, text and locators.
 * - **File text stays inside `<external_content>`** (review #107): what the model sees outside the block is fixed
 *   or server-made — ids, numbers, codes, labels built from numbers. An XLSX sheet's name is file text: outside
 *   the block a sheet is `sheet-<n>` (its place in the workbook, "2번째 시트"); its name appears only inside.
 */

/** Characters of text one `file_read` returns at most (the model reads on with `next.cursor`). */
export const READ_CHARS = 30_000;
/** How long a tool waits for an extraction still running before it answers `pending`. */
export const PENDING_WAIT_MS = 20_000;
/** Lines one stored segment of a TXT/MD file holds at most (extract/text.mjs). */
const LINES_PER_SEGMENT = 40;
/** The label of a place that cannot be told (an approximate run of lines). */
const NO_PLACE = "위치 알 수 없음";

const marksOf = (seg: Pick<SegmentRow, "marks">): Mark[] => {
  if (!seg.marks) return [];
  try {
    const m = JSON.parse(seg.marks) as unknown;
    return Array.isArray(m) ? (m as Mark[]) : [];
  } catch {
    return [];
  }
};
/** `split`: one piece of a paragraph or row the extractor split in reading order (HWP, #23) — no exact range. */
type StoredLoc = UnitLocator & { sheetNo?: number; split?: boolean };
/** A cited place: the locator, and the cited unit's sheet number for an XLSX cell (stored with the citation). */
/**
 * `textHash` (#24): SHA-256 (hex) of the cited unit's served text up to the passage's end, when the citation was
 * checked — the viewer claims the range exact only while that text is still the same (a secret registered later
 * moves offsets). Stored with the citation, never shown to the model or in a note.
 */
export type CitedLocator = FileLocator & { sheetNo?: number | undefined; textHash?: string | undefined };

/** The `textHash` of a unit's text up to `end`. */
export const prefixHash = (text: string, end: number) =>
  crypto.createHash("sha256").update(text.slice(0, end), "utf8").digest("hex");
const locOf = (seg: Pick<SegmentRow, "locator">): StoredLoc => JSON.parse(seg.locator) as StoredLoc;

export const isBox = (b: unknown): b is [number, number, number, number] =>
  Array.isArray(b) && b.length === 4 && b.every((x) => typeof x === "number" && x >= 0 && x <= 1);

export function union(
  boxes: [number, number, number, number][],
): [number, number, number, number] | undefined {
  if (!boxes.length) return undefined;
  const x0 = Math.min(...boxes.map((b) => b[0]));
  const y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[0] + b[2]));
  const y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
  const r = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 10000) / 10000;
  return [r(x0), r(y0), r(x1 - x0), r(y1 - y0)];
}

const valid = (l: Record<string, unknown>): FileLocator | undefined => {
  const p = FileLocator.safeParse(l);
  return p.success ? p.data : undefined;
};

/** The model's id of a sheet: its place in the workbook (never its name, which is file text). */
export const sheetId = (n: number) => `sheet-${n}`;
const SHEET_ID = /^sheet-([1-9][0-9]{0,4})$/;

/**
 * A locator as the model sees it: the sheet's name replaced by its id (`sheet-2`), and the label built from
 * numbers only ("2번째 시트 · B2"). Everything else of a locator is server-made (kinds, numbers, cell references
 * checked by the schema).
 */
export function forModel(
  loc: FileLocator,
  sheetNo: number | undefined,
): { locator: FileLocator; label: string } {
  if (loc.sheet === undefined) return { locator: loc, label: locatorLabel(loc) || NO_PLACE };
  const { sheet: _name, ...rest } = loc;
  void _name;
  const locator = sheetNo ? { ...rest, sheet: sheetId(sheetNo) } : rest;
  return { locator, label: locatorLabel({ ...rest, ...(sheetNo ? { sheet: `${sheetNo}번째 시트` } : {}) }) };
}

/** The locator of a whole segment (a page, a row, a slide …). */
export function segmentLocator(file: Pick<FileRow, "id" | "sha256">, seg: SegmentRow): FileLocator {
  const { sheetNo: _n, ...loc } = locOf(seg);
  void _n;
  return (
    valid({ ...loc, fileId: file.id, fileRevision: file.sha256 }) ?? {
      fileId: file.id,
      fileRevision: file.sha256,
      kind: loc.kind,
    }
  );
}

/**
 * The locator of `[start, end)` of a segment's text: the segment's own fields, made exact by the marks it
 * overlaps — the boxes of the lines or OCR words (one box around them), the cell (column, reference) or the line
 * it is in — and the character range (within that line, for a run of lines). Undefined when the place cannot be
 * told: a run of lines whose marks a secret's removal cost (`approximate`, files/scrub.ts) — its first line is not
 * where the passage is. An approximate page, row or slide keeps its own locator only (no box, no range).
 */
export function locate(
  file: Pick<FileRow, "id" | "sha256">,
  seg: SegmentRow,
  start: number,
  end: number,
): FileLocator | undefined {
  const own = segmentLocator(file, seg);
  if (seg.approximate) return own.kind === "line" ? undefined : own;
  const base = { ...own } as Record<string, unknown>;
  const marks = marksOf(seg);
  const over = marks.filter(([s, e]) => s < Math.max(end, start + 1) && e > start);
  const kind = base.kind;
  if (kind === "page" || kind === "ocr_box") {
    const box = union(over.map((m) => m[2].bbox).filter(isBox));
    if (box) base.bbox = box;
    base.charRange = [start, end];
  } else if (kind === "line") {
    const line = over[0] ?? marks.find(([s, e]) => s <= start && start <= e);
    if (!line || typeof line[2].line !== "number") return undefined;
    base.line = line[2].line;
    base.charRange = [Math.max(0, start - line[0]), Math.max(0, Math.min(end, line[1]) - line[0])];
  } else if ((kind === "table" || kind === "cell_range") && over.length === 1) {
    const f = over[0]![2];
    if (typeof f.col === "number") base.col = f.col;
    if (kind === "cell_range" && typeof f.range === "string") base.range = f.range;
    base.charRange = [start, end];
  } else base.charRange = [start, end];
  // A piece of a split paragraph or row (review #120): its offsets are not the whole unit's — none claimed.
  if (locOf(seg).split === true) delete base.charRange;
  return valid(base) ?? own;
}

const TERMINATOR = /[.!?。！？]/u;

/** The sentence(s) around `[start, end)`: from after the previous sentence end or line break to the next. */
export function sentenceAround(text: string, start: number, end: number, max = 400): [number, number] {
  let s = start;
  while (
    s > 0 &&
    s > start - max &&
    text[s - 1] !== "\n" &&
    !(TERMINATOR.test(text[s - 1]!) && /\s/.test(text[s] ?? ""))
  )
    s--;
  while (s < start && /\s/.test(text[s]!)) s++;
  let e = end;
  while (e < text.length && e < end + max && text[e] !== "\n") {
    e++;
    if (TERMINATOR.test(text[e - 1]!) && (e === text.length || /\s/.test(text[e]!))) break;
  }
  return [s, e];
}

/** One UTF-16 unit to one: lower case where that keeps the length (so offsets still fit the original). */
function fold(s: string): string {
  let out = "";
  for (const ch of s) {
    const l = ch.toLowerCase();
    out += l.length === ch.length ? l : ch;
  }
  return out;
}

type Result = { ok: true; output: unknown } | { ok: false; code: string };
/**
 * Every output once more through the secrets known now (names, text, locators — review #107): full matches only —
 * the text was scrubbed with the cut-off rule where the text really ends early (`scrubFile`); the end of a string
 * here is not the end of the file (review #107 8차).
 */
const clean = (r: Result): Result =>
  r.ok ? { ok: true, output: scrubKnownDeep(r.output, { tail: false }) } : r;

/** One part of a `file_read`: a unit (or one line of a run of lines) and where it is in the file's order. */
type Part = { seq: number; sub: number; locator: FileLocator; sheetNo: number | undefined; text: string };
/** `file_read`'s cursor: `<seq>.<sub>.<offset>` — the part and the character inside it to go on from. */
const CURSOR = /^(\d{1,9})\.(\d{1,6})\.(\d{1,9})$/;

export class FileTools {
  constructor(
    private readonly store: FileStore,
    private readonly extracts: FileExtracts,
    private readonly conversations: Pick<ConversationStore, "get">,
    /** How long a call waits for an extraction still running (tests shorten it). */
    private readonly waitMs = PENDING_WAIT_MS,
  ) {}

  /**
   * Whether a run of `scope` may read file `f` — the one rule of every file tool (see the file comment): the
   * token user's conversation, the user's file in it, sent with a message that is still active.
   */
  private inScope(scope: Pick<ToolScope, "conversationId" | "userId">, f: FileRow): boolean {
    return (
      f.conversationId === scope.conversationId &&
      f.userId === scope.userId &&
      this.store.isActiveAttachment(f)
    );
  }

  private ownConversation(scope: Pick<ToolScope, "conversationId" | "userId">): boolean {
    const c = this.conversations.get(scope.conversationId);
    return !!c && c.ownerId === scope.userId;
  }

  /** The file when the run may read it, or undefined. */
  fileFor(scope: Pick<ToolScope, "conversationId" | "userId">, fileId: string): FileRow | undefined {
    if (!this.ownConversation(scope)) return undefined;
    const f = this.store.get(fileId);
    return f && this.inScope(scope, f) ? f : undefined;
  }

  /** The files the run may read; undefined when the conversation is not the token user's. */
  filesFor(scope: ToolScope): FileRow[] | undefined {
    if (!this.ownConversation(scope)) return undefined;
    return this.store.list(scope.conversationId).filter((f) => this.inScope(scope, f));
  }

  list(scope: ToolScope): Result {
    const rows = this.filesFor(scope);
    if (!rows) return { ok: false, code: "file_not_allowed" };
    const items = rows.map((f, i) => {
      const extract = toFileExtract(f, this.extracts.get(f.id));
      const first = extract.status === "ok" ? this.extracts.segments(f.id, 0, 1)[0] : undefined;
      return {
        n: i + 1,
        fileId: f.id,
        kind: f.kind,
        bytes: f.bytes,
        extract: this.describe(extract),
        firstLocator: first ? forModel(segmentLocator(f, first), locOf(first).sheetNo).locator : null,
      };
    });
    return clean({
      ok: true,
      output: {
        items,
        content: frameExternal({
          source: "files",
          content:
            rows.map((f, i) => `[${i + 1}] ${f.id} · ${scrubKnown(f.name, { tail: false })}`).join("\n") ||
            "(no files)",
        }),
      },
    });
  }

  /** The extraction state as the model sees it, with the fixed words for a failure. */
  private describe(e: FileExtract) {
    return {
      status: e.status,
      ...(e.code ? { code: e.code, message: EXTRACT_CODE_TEXT[e.code] } : {}),
      ocr: e.ocr,
      units: e.units,
      parts: e.segments,
      truncated: e.truncated,
    };
  }

  /** Waits (bounded) for a pending extraction; the row as it is then. */
  private async ready(f: FileRow) {
    const row = await this.extracts.settled(f.id, this.waitMs);
    return toFileExtract(f, row);
  }

  /**
   * The file's text from `from` to `to` (its natural units; `sheet`: one XLSX sheet, by id `sheet-<n>` or name),
   * in file order, at most `READ_CHARS` characters. `cursor` (from `next`) goes on exactly where the last call
   * stopped — inside a long unit, and on to the next sheet — with the same range and sheet.
   */
  async read(
    scope: ToolScope,
    input: {
      fileId: string;
      from?: number | undefined;
      to?: number | undefined;
      sheet?: string | undefined;
      cursor?: string | undefined;
    },
  ): Promise<Result> {
    const f = this.fileFor(scope, input.fileId);
    if (!f) return { ok: false, code: "file_not_found" };
    const extract = await this.ready(f);
    if (extract.status !== "ok")
      return clean({ ok: true, output: { fileId: f.id, extract: this.describe(extract) } });
    const from = input.from ?? 1;
    const to = input.to ?? Number.MAX_SAFE_INTEGER;
    if (to < from) return { ok: false, code: "file_bad_input" };
    let at = { seq: -1, sub: 0, offset: 0 };
    if (input.cursor !== undefined) {
      const m = CURSOR.exec(input.cursor);
      if (!m) return { ok: false, code: "file_bad_input" };
      at = { seq: Number(m[1]), sub: Number(m[2]), offset: Number(m[3]) };
    }
    // `sheet` is an id only (`sheet-<n>`, its place in the workbook) — never a name, which is file text and can
    // look like an id (review #107 2차: a first sheet named "sheet-2").
    let wantSheet: number | undefined;
    if (input.sheet !== undefined) {
      const m = SHEET_ID.exec(input.sheet);
      if (!m) return { ok: false, code: "file_bad_input" };
      wantSheet = Number(m[1]);
    }
    const parts: Part[] = [];
    for (const seg of this.extracts.segments(f.id)) {
      const loc = locOf(seg);
      if (wantSheet !== undefined && loc.sheetNo !== wantSheet) continue;
      if (loc.kind === "line") {
        // A run of lines: each line on its own, those in the range only.
        const marks = marksOf(seg);
        if (!marks.length) {
          // Its lines' places were lost (approximate): the whole run, without a line number.
          // No line is claimed for it (its first line is not where its text is).
          if (seg.unit <= to && seg.unit + LINES_PER_SEGMENT > from) {
            const { line: _first, ...where } = segmentLocator(f, seg);
            void _first;
            parts.push({ seq: seg.seq, sub: 0, locator: where, sheetNo: undefined, text: seg.text });
          }
          continue;
        }
        marks.forEach(([s, e, fields], sub) => {
          const line = Number(fields.line);
          if (line < from || line > to) return;
          const text = seg.text.slice(s, e);
          if (!text.trim()) return;
          parts.push({
            seq: seg.seq,
            sub,
            locator: { ...segmentLocator(f, seg), line },
            sheetNo: undefined,
            text,
          });
        });
      } else if (seg.unit >= from && seg.unit <= to)
        parts.push({
          seq: seg.seq,
          sub: 0,
          locator: segmentLocator(f, seg),
          sheetNo: loc.sheetNo,
          text: seg.text,
        });
    }
    // Resume after the cursor: earlier parts skipped, the cursor's part from its offset.
    const start = parts.findIndex((p) => p.seq > at.seq || (p.seq === at.seq && p.sub >= at.sub));
    const todo = start === -1 ? [] : parts.slice(start);
    const shown: (Part & { offset: number; end: number })[] = [];
    let used = 0;
    let next: { cursor: string } | null = null;
    for (const p of todo) {
      const offset = p.seq === at.seq && p.sub === at.sub ? Math.min(at.offset, p.text.length) : 0;
      const room = READ_CHARS - used;
      if (room <= 0) {
        next = { cursor: `${p.seq}.${p.sub}.${offset}` };
        break;
      }
      let end = Math.min(p.text.length, offset + room);
      // Never half a surrogate pair.
      if (end < p.text.length && end > offset && /[\uD800-\uDBFF]/.test(p.text[end - 1]!)) end--;
      shown.push({ ...p, offset, end });
      used += end - offset;
      if (end < p.text.length) {
        next = { cursor: `${p.seq}.${p.sub}.${end}` };
        break;
      }
    }
    return clean({
      ok: true,
      output: {
        fileId: f.id,
        extract: this.describe(extract),
        items: shown.map((p) => {
          const m = forModel(p.locator, p.sheetNo);
          return {
            locator: m.locator,
            label: m.label,
            characters: p.end - p.offset,
            ...(p.offset > 0 || p.end < p.text.length ? { range: [p.offset, p.end] } : {}),
          };
        }),
        next,
        content: frameExternal({
          source: `file:${f.id}`,
          content:
            shown
              .map((p) => {
                const own = locatorLabel(p.locator) || NO_PLACE;
                const model = forModel(p.locator, p.sheetNo).label;
                // The sheet's own name only here, inside the block.
                const head = own === model ? own : `${model} — ${p.locator.sheet}`;
                const cont = p.offset > 0 ? ` (계속, ${p.offset}자부터)` : "";
                return `[${head}${cont}]\n${p.text.slice(p.offset, p.end)}`;
              })
              .join("\n\n") || "(no text in this range)",
        }),
      },
    });
  }

  async search(
    scope: ToolScope,
    input: { query: string; fileId?: string | undefined; maxResults?: number | undefined },
  ): Promise<Result> {
    const all = this.filesFor(scope);
    if (!all) return { ok: false, code: "file_not_allowed" };
    const targets = input.fileId ? all.filter((f) => f.id === input.fileId) : all;
    if (input.fileId && !targets.length) return { ok: false, code: "file_not_found" };
    const terms = [...new Set(fold(input.query).split(/\s+/).filter(Boolean))];
    if (!terms.length) return { ok: false, code: "file_bad_input" };
    const max = input.maxResults ?? 8;
    type Hit = { file: FileRow; seg: SegmentRow; score: number; at: number; len: number; order: number };
    const hits: Hit[] = [];
    let order = 0;
    const pending: string[] = [];
    for (const f of targets) {
      const extract = input.fileId ? await this.ready(f) : toFileExtract(f, this.extracts.get(f.id));
      if (extract.status === "pending") pending.push(f.id);
      if (extract.status !== "ok") continue;
      for (const seg of this.extracts.segments(f.id)) {
        order++;
        const t = fold(seg.text);
        let score = 0;
        let at = -1;
        for (const term of terms) {
          let i = t.indexOf(term);
          if (i === -1) {
            score = 0;
            break;
          }
          if (at === -1) at = i;
          for (; i !== -1; i = t.indexOf(term, i + term.length)) score++;
        }
        if (score) hits.push({ file: f, seg, score, at, len: terms[0]!.length, order });
      }
    }
    hits.sort((a, b) => b.score - a.score || a.order - b.order);
    const top = hits.slice(0, max).map((h) => {
      const [s, e] = sentenceAround(h.seg.text, h.at, h.at + h.len);
      const locator = locate(h.file, h.seg, s, e);
      const sheetNo = locOf(h.seg).sheetNo;
      return {
        file: h.file,
        locator,
        model: locator ? forModel(locator, sheetNo) : undefined,
        text: h.seg.text.slice(s, e),
        // No place told → none shown, in the block too (review #107 2차).
        own: locator ? locatorLabel(locator) || NO_PLACE : NO_PLACE,
      };
    });
    return clean({
      ok: true,
      output: {
        hits: top.map((h, i) => ({
          n: i + 1,
          fileId: h.file.id,
          locator: h.model?.locator ?? null,
          label: h.model?.label ?? null,
        })),
        ...(pending.length ? { pending } : {}),
        content: frameExternal({
          source: "file_search",
          content:
            top
              .map(
                (h, i) => `(결과 ${i + 1}) ${scrubKnown(h.file.name, { tail: false })} · ${h.own}\n${h.text}`,
              )
              .join("\n\n") || "(no matches)",
        }),
      },
    });
  }

  /**
   * A cited locator as the model sees it: the sheet by the `sheetNo` the verified unit carried (stored with the
   * citation) — never looked up by the sheet's name, which may be scrubbed or cut (review #107 2차). Without one,
   * no sheet at all.
   */
  modelLocator(loc: CitedLocator): { locator: FileLocator; label: string } {
    const { sheetNo, textHash: _h, ...rest } = loc;
    void _h;
    return forModel(rest, sheetNo);
  }

  /**
   * The citation check of one file (#48): the snippet against the file's extracted text with the same rules as
   * a web citation (`findSnippetAt`), the unit named by `page` first. A verified passage gets its exact locator —
   * or none when its place was lost to a secret's removal (never a wrong one, review #107).
   */
  async check(f: FileRow, snippet: string, page: number | undefined): Promise<CheckResult> {
    return this.match(f, await this.ready(f), snippet, page);
  }

  /**
   * An earlier answer's file citation checked again for a later answer that writes its number again (#186, the
   * file side of #150's carry-over) — **the cited unit is unchanged at the same place** (review 4차): the file must
   * still be one a run of `scope` may read (`fileFor` — this conversation's and this user's, sent with an active
   * message; a deleted file or one an edit cut off is not), its extraction ready (being extracted again or failed →
   * `fetch_failed`, never waited for), a unit at the row's place whose whole text and marks hash to the row's
   * `unitHash` (`unitHashOf` — computed from the text now, so an identical re-extraction still matches; a changed
   * text, a newly masked secret or moved cells do not), and the row's whole passage found in it again (the usual
   * rules, in the unit's full text — the unit being the same, so is the place). Anything else is `snippet_not_found`: never looked
   * for elsewhere. The place shown is the row's own — the one the viewer opens and, on the same condition, claims
   * exact. Undefined when the file is not one (any more): the marker stays `unknown_source`. Registers nothing.
   */
  recheck(
    scope: Pick<ToolScope, "conversationId" | "userId">,
    input: { fileId: string; snippet: string; locator: CitedLocator | undefined; unitHash: string | null },
  ):
    { status: CitationStatus; quote: string | null; locator: FileLocator | null; file: FileRow } | undefined {
    const file = this.fileFor(scope, input.fileId);
    if (!file) return undefined;
    const no = { status: "snippet_not_found" as const, quote: null, locator: null, file };
    const extract = toFileExtract(file, this.extracts.get(file.id));
    if (extract.status !== "ok" || !extract.segments)
      return { status: "fetch_failed", quote: null, locator: null, file };
    const at = input.locator;
    if (!at || !input.unitHash || at.fileId !== file.id || at.fileRevision !== file.sha256) return no;
    // The row's whole passage (as stored, already scrubbed — again with the secrets known now); never cut.
    const snippet = scrubKnown(input.snippet);
    for (const seg of this.extracts.segments(file.id)) {
      if (!sameUnitAddress(unitAddressOf(file, seg), at) || unitHashOf(seg) !== input.unitHash) continue;
      // The unit is byte for byte (text and marks) the one verified: the passage found in it is at the row's place.
      const m = findSnippetAt(seg.text, snippet);
      if (!m.found) continue;
      const loc = FileLocator.safeParse(scrubKnownDeep(at));
      if (!loc.success) return no;
      return { status: "verified", quote: scrubKnown(m.quote), locator: loc.data, file };
    }
    return no;
  }

  /**
   * `check`'s search of the extraction `extract` (its state as given: a pending one is `fetch_failed`): the first
   * unit that has the passage, the unit named by `page` first.
   */
  private match(f: FileRow, extract: FileExtract, snippet: string, page: number | undefined): CheckResult {
    if (extract.status !== "ok" || !extract.segments)
      return { status: "fetch_failed", quote: null, locator: null, unitHash: null };
    const segs = this.extracts.segments(f.id);
    const ordered =
      page === undefined
        ? segs
        : [...segs.filter((s) => s.unit === page), ...segs.filter((s) => s.unit !== page)];
    for (const seg of ordered) {
      const m = findSnippetAt(seg.text, snippet);
      if (m.found) return verifiedAt(seg, m, locate(f, seg, m.start, m.end));
    }
    return { status: "snippet_not_found", quote: null, locator: null, unitHash: null };
  }
}

/** What `check` finds: a verified passage's quote, place and its unit's hash (`unitHashOf`), or why not. */
export type CheckResult = {
  status: CitationStatus;
  quote: string | null;
  locator: CitedLocator | null;
  unitHash: string | null;
  /**
   * The search unit the passage was found in (`file_segments.unit` — what `file_cite`'s `page` names first; a TXT unit
   * spans several lines, so it is not the line shown). Verified passages only.
   */
  unit?: number | undefined;
};

/**
 * A unit as it is (#186 review 4차): SHA-256 of its whole text and its marks (lines, cells, boxes) — what a carried
 * citation of it is verified against, and what lets the viewer claim the cited range exact.
 */
export const unitHashOf = (seg: Pick<SegmentRow, "text" | "marks">) =>
  crypto
    .createHash("sha256")
    .update(seg.text, "utf8")
    .update("\u0000")
    .update(seg.marks ?? "", "utf8")
    .digest("hex");

type VerifiedMatch = CheckResult & { status: "verified"; quote: string };

/** A verified passage at `[m.start, m.end)` of `seg`, with its exact place (`where`) when it has one. */
function verifiedAt(
  seg: SegmentRow,
  m: { quote: string; start: number; end: number },
  where: FileLocator | undefined,
): VerifiedMatch {
  // The verified unit's own sheet number goes with the locator (the model's sheet id comes from it).
  const sheetNo = locOf(seg).sheetNo;
  return {
    status: "verified",
    quote: m.quote,
    locator: where
      ? {
          ...where,
          ...(sheetNo !== undefined ? { sheetNo } : {}),
          // Only a passage with a range gets one: the text it was found in, up to its end.
          ...(where.charRange ? { textHash: prefixHash(seg.text, m.end) } : {}),
        }
      : null,
    unitHash: unitHashOf(seg),
    unit: seg.unit,
  };
}

/** A stored unit as an address: its own locator, its sheet's number (XLSX) and the lines of a run of lines. */
export type UnitAddress = { locator: FileLocator; sheetNo?: number | undefined; lines: readonly number[] };

/** `seg`'s address (see `sameUnitAddress`). */
export function unitAddressOf(f: Pick<FileRow, "id" | "sha256">, seg: SegmentRow): UnitAddress {
  return {
    locator: segmentLocator(f, seg),
    sheetNo: locOf(seg).sheetNo,
    lines: marksOf(seg).flatMap((m) => (typeof m[2].line === "number" ? [m[2].line] : [])),
  };
}

/**
 * Whether unit `u` is the unit place `at` names — **the one rule** (#186 review 5차) the carry-over recheck and the
 * viewer both use: the same kind and page, slide, paragraph or table row; a footnote's or endnote's number equal,
 * none included (a body paragraph is not its footnote); an XLSX row by its sheet's **number** when both have one
 * (two sheets whose names are masked alike stay two), by the served name otherwise; a line within the run's lines.
 */
export function sameUnitAddress(u: UnitAddress, at: FileLocator & { sheetNo?: number | undefined }): boolean {
  const l = u.locator;
  if (l.kind !== at.kind) return false;
  const note = l.footnote === at.footnote && l.endnote === at.endnote;
  switch (at.kind) {
    case "page":
    case "ocr_box":
      return l.page === at.page;
    case "line":
      return at.line !== undefined && u.lines.includes(at.line);
    case "paragraph":
      return l.paragraph === at.paragraph && note;
    case "table":
      return l.table === at.table && l.row === at.row && note;
    case "cell_range": {
      const sheet =
        u.sheetNo !== undefined && at.sheetNo !== undefined
          ? u.sheetNo === at.sheetNo
          : servedSheet(l.sheet) === servedSheet(at.sheet);
      return sheet && l.row === at.row;
    }
    case "slide":
      return l.slide === at.slide;
  }
}

/** Sheet names are file text: compared as served (scrubbed with the secrets known now). */
const servedSheet = (s: string | undefined) => (s === undefined ? undefined : scrubKnown(s, { tail: false }));
