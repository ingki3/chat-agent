import type { Nodes, Parents, RootContent } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";
import { z } from "zod";
import { splitBlocks } from "./blocks.js";
import { FINANCE_DISCLAIMER } from "./finance.js";
import { FileLocator } from "./locators.js";

/**
 * Web citations (#25, PRD FR-5.1–5.5, G2, 수용 기준 3·11). The model cites with the `cite` tool (`{ sourceId,
 * snippet }`); the server checks the snippet against the page text it stored (#50) and numbers the citation for
 * the answer (`[n]`). At the end of the run the server appends a `citation_note` part: every `[n]` the answer
 * uses with its status, and the paragraphs that state something without any marker. A runtime cannot write or
 * change that part.
 *
 * This file is the data contract between the server and the chat screen: the statuses, the exact words shown
 * for them, and the paragraph and marker rules both sides apply to the same answer text.
 */

/**
 * - `verified` — the snippet is in the stored page text (after normalising whitespace, quote styles, NFKC, case)
 * - `snippet_not_found` — the page was fetched, the snippet is not in it
 * - `fetch_failed` — the source has no stored page text (a search result, or a page that could not be read)
 * - `unknown_source` — not a source of this conversation (another conversation's, another user's, made up),
 *   or a marker in the answer that no `cite` produced
 */
export const CitationStatus = z.enum(["verified", "snippet_not_found", "fetch_failed", "unknown_source"]);
export type CitationStatus = z.infer<typeof CitationStatus>;

/** What the screen says for each status (issue #25). Only `verified` reads as normal; every other has ⚠️. */
export const CITATION_STATUS_TEXT: Record<CitationStatus, string> = {
  verified: "원문 구절 확인",
  snippet_not_found: "⚠️ 출처에서 이 내용을 찾지 못했어요",
  fetch_failed: "⚠️ 출처를 가져오지 못했어요",
  unknown_source: "⚠️ 출처를 가져오지 못했어요",
};

/**
 * Shown for an `unbacked` note: the answer has `[n]` markers that cite nothing. About the markers only — the same
 * box may list the answer's finance sources (review #190 2차).
 */
export const CITATION_UNBACKED_TEXT = "⚠️ 근거에 연결되지 않은 출처 표시가 있어요.";

/**
 * Shown under an answer with paragraphs that state something without a citation marker (#202): one line with the
 * count — the paragraphs themselves are marked where they are in the answer (never repeated in the note).
 */
export const citationMissingText = (n: number) => `⚠️ 출처 표시 없는 문단 ${n}개`;
/** The mark on each such paragraph in the answer (its label for screen readers and its tooltip). */
export const CITATION_MISSING_MARK = "출처 표시 없음";

/** The only status that may be shown like a normal citation. Anything else (including unknown values) is a failure. */
export const citationVerified = (status: unknown): boolean => status === "verified";

export const CITATION_LIMITS = {
  /** Citations one answer may register. */
  perRun: 50,
  /** Characters of a snippet the model may send (and of the quote kept). */
  snippet: 500,
  /** Normalised characters a snippet needs at least: shorter ones prove nothing. */
  minSnippet: 8,
  /** Paragraph ranges a note marks at most. */
  missing: 100,
  /** Marker positions a note lists at most. */
  markers: 300,
  title: 300,
  site: 120,
  url: 2048,
} as const;

/** At most `n` UTF-16 units (what the schema's `max` counts), never cutting a character in half. */
export function boundText(s: string, n: number): string {
  if (s.length <= n) return s;
  let out = "";
  for (const ch of s) {
    if (out.length + ch.length > n) break;
    out += ch;
  }
  return out;
}

/** One `[n]` of an answer as the server checked it. Titles, sites and quotes are page text: shown as text only. */
export const CitationEntry = z.object({
  n: z.number().int().positive(),
  status: CitationStatus,
  /** Null for `unknown_source` (nothing of another conversation is ever shown). */
  sourceId: z.string().nullable(),
  title: z.string().max(CITATION_LIMITS.title).nullable(),
  site: z.string().max(CITATION_LIMITS.site).nullable(),
  url: z.string().max(CITATION_LIMITS.url).nullable(),
  publishedAt: z.string().nullable(),
  /**
   * `verified`: the passage as it stands in the stored page text. Otherwise the snippet the model sent (what it
   * meant to quote) — or null for `unknown_source`.
   */
  quote: z.string().max(CITATION_LIMITS.snippet).nullable(),
  /**
   * A citation of an uploaded file (#48, `file_cite`): where the passage is. Then `title` is the file name, `site`
   * the place ("12쪽", `locatorLabel`), `url` null and `sourceId` null. Absent for web citations.
   */
  locator: FileLocator.optional(),
  /**
   * A citation of an uploaded file (#186): the file's id, whatever the status but `unknown_source` — what a later
   * answer that writes this number again carries over, checked again against the file's current text (the locator
   * has the id for verified passages only). Absent for web citations and on entries stored before #186.
   */
  fileId: z.string().min(1).max(64).optional(),
  /**
   * The server's citation row this entry stands for (#186 review 2차): an opaque id — what a later answer that writes
   * this number again is checked against (the row keeps the whole passage server-side; `quote` is for display and
   * may be cut). A carried entry names the row it was carried from. Absent on `unknown_source` and on entries stored
   * before (those are found by their answer's run and number, or not carried).
   */
  citationId: z.string().min(1).max(64).optional(),
});
export type CitationEntry = z.infer<typeof CitationEntry>;

/** A range of the answer text (text parts joined with ""), `[start, end)` in UTF-16 code units. */
export const TextRange = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});
export type TextRange = z.infer<typeof TextRange>;

/**
 * Added by the server at the end of an answer that used web or file source tools, cited sources, or carries numbers
 * of the answer before (#25, #150) — decided by those tool calls only, never by the text (#185). `citations`: every
 * marker the answer uses, by number. `missing`: body paragraphs without a marker (empty when every one has one).
 * The numbered part of the answer's source note: the screen shows it in one "출처" box with the `finance_note`, if
 * there is one.
 */
export const CitationNotePart = z.object({
  type: z.literal("citation_note"),
  citations: z.array(CitationEntry).max(CITATION_LIMITS.perRun * 2),
  missing: z.array(TextRange).max(CITATION_LIMITS.missing),
  /**
   * Where the citation markers are in the answer text (each `[n]` the screen turns into a citation). Only these:
   * an `[n]` elsewhere (array indexing, code) stays text.
   */
  markers: z.array(TextRange.extend({ n: z.number().int().positive() })).max(CITATION_LIMITS.markers),
  /**
   * The answer used no source and carried no number (#185, review #190 1차): its sentence-end `[n]` cite nothing.
   * Every citation is `unknown_source`; the screen flags the markers in the text and shows a short notice, never a
   * source box. Not an earlier answer's note for carrying numbers over. Absent on every other note.
   */
  unbacked: z.literal(true).optional(),
  /**
   * How `missing` was computed (#202 review 4차): `2` — from the blocks the screen renders (`citationUnits`), so the
   * screen marks each range in the answer and moves to it. Absent on notes stored before: their ranges came from the
   * old line-based split and are only counted ("출처 표시 없는 문단 N개" as text), never marked.
   */
  units: z.literal(2).optional(),
});
export type CitationNotePart = z.infer<typeof CitationNotePart>;

/** What the `cite` tool answers (also what `CitationStore.cite` returns). */
export type CiteResult = {
  n: number;
  marker: string;
  status: CitationStatus;
  sourceId: string | null;
};

// ---- the answer text: paragraphs and markers (same rules on the server and in the browser) ------------------

export type CitationUnitKind = "body" | "heading" | "lead_in" | "disclaimer" | "code" | "rule";
/** `table`: a GFM table, one unit whatever its rows look like (#202). */
/**
 * `table`: a GFM table, one unit whatever its rows look like; `footnote`: in a footnote the screen shows; `part`:
 * the text part it is in (a tool call between two parts, review 4차); `inline`: inline code or math — never a
 * marker, never a block (only `citationMarkers` reads it) (#202).
 */
export type CitationUnit = TextRange & {
  kind: CitationUnitKind;
  table?: true;
  footnote?: true;
  /** The footnote's id (with `footnote`): a footnote table takes cover only from its own footnote (review 5차). */
  note?: string;
  part?: number;
  inline?: true;
  /** A paragraph a tool call cut: the first fragment ends at `end`, the second (next part) starts at `start`. */
  cut?: { end: number; start: number };
};

/** A paragraph that is only bold text (a heading written as `**제목**`). */
const BOLD_LINE = /^\s*(\*\*|__)[^\n]{1,80}?\1\s*[:：]?\s*$/;
const LEAD_IN = /[:：]\s*$/;

const SENTENCES = /(?<=[.!?。！？])\s+/u;
/**
 * The pure notices a disclaimer may be made of — a small closed set, each a whole sentence (only its ending may
 * vary). Anything else, however it starts, is something stated and is checked (review #97 round 2: no prefixes).
 */
const NOTICES: readonly RegExp[] = [
  /^(?:출처|자료|근거)(?:가|는)\s*(?:충분하지\s*않아요|충분하지\s*않습니다|충분하지\s*않다|부족해요|부족합니다|부족하다)$/u,
  /^(?:공식\s*발표를|원문을)\s*확인해\s*(?:보세요|주세요)$/u,
  /^(?:최신\s*정보는|자세한\s*내용은)\s*원문을\s*확인해\s*(?:보세요|주세요)$/u,
  /^(?:이\s*답변은\s*)?공개\s*(?:보도|자료)를\s*바탕으로\s*(?:했어요|했습니다|했다|작성했어요|작성했습니다)$/u,
  /^(?:이\s*답변은\s*)?참고용(?:이에요|입니다|이다)$/u,
  /^(?:이\s*답변은\s*)?정확하지\s*않을\s*수\s*(?:있어요|있습니다|있다)$/u,
];
const isNotice = (sentence: string) => {
  const s = sentence
    .replace(/^[※\s]+/u, "")
    .replace(/[.!。\s]+$/u, "")
    .replace(/\s+/gu, " ");
  return NOTICES.some((re) => re.test(s));
};

/**
 * A pure disclaimer: the finance disclaimer and the notices above, nothing else — every sentence must be one of
 * them, whole. `※ 반도체 수출은 32% 증가했다.`, `출처가 부족하지만 양산은 확정됐다.`, `출처가 부족합니다만 …` and
 * `※ 최신 정보는 양산이 확정됐다는 소식입니다.` are claims.
 */
function isDisclaimer(t: string): boolean {
  if (t.length > 240) return false;
  const rest = t
    .split(FINANCE_DISCLAIMER)
    .join(" ")
    .replace(/^[\s※*]+|[\s*]+$/gu, "");
  if (!rest) return true;
  return rest.split(SENTENCES).filter(Boolean).every(isNotice);
}

/**
 * One markdown block as the chat screen's renderer parses it (#202, review 2차): the same parser family as
 * react-markdown with remark-gfm and remark-math (mdast-util-from-markdown + the GFM and math extensions, the same
 * locked versions) — so tables, lists, quotes, code, math and raw HTML are the blocks the user sees, with their
 * source positions (UTF-16 offsets of the block, CRLF included).
 */
const parseBlock = (text: string) =>
  fromMarkdown(text, {
    extensions: [gfm(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  });

const startOf = (n: Nodes) => n.position?.start.offset;
const endOf = (n: Nodes) => n.position?.end.offset;

/**
 * Internal: a plain paragraph (may join the paragraph a tool call cut), a rendered footnote's unit, a list item, and
 * a paragraph that is a lead-in if a list or table comes next (decided once the next unit is known — the screen's
 * blocks split a lead-in from its list at the blank line).
 */
type Unit = CitationUnit & { para?: true; footnote?: true; item?: true; leadIn?: true };

/** The units of one block, at `base` in the answer text. */
function blockUnits(block: string, base: number): Unit[] {
  const out: Unit[] = [];
  const tree = parseBlock(block);
  // Footnotes the screen shows (review 4차, as mdast-util-to-hast does): the first definition of each id, and only
  // those reached from the body — directly, or from a footnote that is itself shown.
  // Every definition first, nested ones too, the first of each id in document order (review 5차).
  const defs = new Map<string, Nodes & { type: "footnoteDefinition" }>();
  const index = (n: Nodes) => {
    if (n.type === "footnoteDefinition") {
      const id = n.identifier.toUpperCase();
      if (!defs.has(id)) defs.set(id, n);
    }
    if ("children" in n) for (const c of n.children) index(c as Nodes);
  };
  index(tree);
  // References of a node's own text (a definition inside it is its own: only its references when it is shown).
  const refsOf = (n: Nodes, into: string[]) => {
    if (n.type === "footnoteReference") into.push(n.identifier.toUpperCase());
    if ("children" in n)
      for (const c of n.children) if ((c as Nodes).type !== "footnoteDefinition") refsOf(c as Nodes, into);
  };
  const reached: string[] = [];
  refsOf(tree, reached);
  // Each definition reached from the body (directly or from a shown footnote) is checked once.
  const shown: { id: string; def: Nodes & { type: "footnoteDefinition" } }[] = [];
  for (let k = 0; k < reached.length; k++) {
    const id = reached[k]!;
    const def = defs.get(id);
    if (!def || shown.some((x) => x.def === def)) continue;
    shown.push({ id, def });
    for (const c of def.children) if (c.type !== "footnoteDefinition") refsOf(c as Nodes, reached);
  }
  // Inline code and math (`a[1]`, `$a[1]$`): never markers (review 4차).
  const inline = (n: Nodes) => {
    if (
      (n.type === "inlineCode" || n.type === "inlineMath") &&
      startOf(n) !== undefined &&
      endOf(n) !== undefined
    )
      out.push({ start: base + startOf(n)!, end: base + endOf(n)!, kind: "code", inline: true });
    if ("children" in n) for (const c of n.children) inline(c as Nodes);
  };
  inline(tree);
  const add = (
    kind: CitationUnitKind,
    start: number | undefined,
    end: number | undefined,
    o: { table?: boolean; para?: boolean; note?: string | undefined; item?: boolean; leadIn?: boolean } = {},
  ) => {
    if (start === undefined || end === undefined || end <= start) return;
    out.push({
      start: base + start,
      end: base + end,
      kind,
      ...(o.table ? { table: true as const } : {}),
      ...(o.para ? { para: true as const } : {}),
      ...(o.note !== undefined ? { footnote: true as const, note: o.note } : {}),
      ...(o.item ? { item: true as const } : {}),
      ...(o.leadIn ? { leadIn: true as const } : {}),
    });
  };
  const paragraph = (
    start: number | undefined,
    end: number | undefined,
    o: { para?: boolean; note?: string | undefined; item?: boolean },
  ) => {
    if (start === undefined || end === undefined) return;
    const t = block.slice(start, end).trim();
    if (!/[\r\n]/.test(t) && BOLD_LINE.test(t)) return add("heading", start, end, o);
    if (isDisclaimer(t)) return add("disclaimer", start, end, o);
    const leadIn = LEAD_IN.test(t) && !/[\r\n]/.test(t) && t.length <= 120;
    add("body", start, end, { ...o, leadIn });
  };
  const blocks = (parent: Parents, note: string | undefined) => {
    const kids = parent.children as RootContent[];
    kids.forEach((n) => {
      const o = { note };
      switch (n.type) {
        case "paragraph":
          return paragraph(startOf(n), endOf(n), { ...o, para: parent.type === "root" });
        case "heading":
          return add("heading", startOf(n), endOf(n), o);
        case "thematicBreak":
          return add("rule", startOf(n), endOf(n), o);
        case "code":
        case "math":
          return add("code", startOf(n), endOf(n), o);
        case "html":
          return add("body", startOf(n), endOf(n), o);
        case "table":
          return add("body", startOf(n), endOf(n), { ...o, table: true });
        case "list":
          for (const item of n.children) {
            const [first, ...rest] = item.children;
            if (first?.type === "paragraph") {
              // The item's own text: from its marker, so the screen's list item starts inside it.
              paragraph(startOf(item), endOf(first), { ...o, item: true });
              blocks({ ...item, children: rest } as Parents, note);
            } else blocks(item, note);
          }
          return;
        case "blockquote":
          return blocks(n, note);
        case "footnoteDefinition":
          return; // checked below, once, if the screen shows it — never where it is written

        default:
          return; // link definitions and anything else that is not shown as a block of text
      }
    });
  };
  blocks(tree, undefined);
  // The footnotes the screen shows (at the end of the answer, each one apart from the rest).
  for (const { id, def } of shown) blocks(def, id);
  return out;
}

/**
 * The answer split into units the missing-citation check looks at — exactly as the chat screen renders it
 * (review 3차): each text part (`partStarts`: where each starts in the answer text; a tool call comes between two)
 * on its own, cut into the same blocks (`splitBlocks`), each block parsed by `parseBlock`; the units are then moved
 * to answer-text offsets. So a closed math block or table at the end of one part never takes in the next part.
 * - a paragraph is `body` — or `lead_in` (one short line ending with a colon right before a list or table), a
 *   `disclaimer`, or a `heading` when it is only bold text; a paragraph a tool call cut in the middle (the two
 *   halves with no blank line between them) stays one unit, as before;
 * - a list item is `body` from its marker to the end of its first paragraph; its other paragraphs are units of
 *   their own, its nested lists are items of their own;
 * - a table is one `body` unit (`table: true`), whatever its rows look like;
 * - raw HTML (shown as text) is `body`; headings are `heading`, rules `rule`, code blocks (fenced or indented) and
 *   math blocks `code`; quotes are looked into; footnotes only when referred to (`footnote: true`); link
 *   definitions are nothing.
 */
export function citationUnits(text: string, partStarts: readonly number[] = [0]): CitationUnit[] {
  const starts = [...new Set([0, ...partStarts.filter((n) => n > 0 && n < text.length)])].sort(
    (a, b) => a - b,
  );
  const out: Unit[] = [];
  starts.forEach((start, k) => {
    const part = text.slice(start, starts[k + 1] ?? text.length);
    let at = start;
    const units: Unit[] = [];
    for (const block of splitBlocks(part)) {
      units.push(...blockUnits(block, at).map((u) => ({ ...u, part: k })));
      at += block.length;
    }
    // A paragraph cut by the tool call: the last one before it and the first one after it, no blank line between.
    const prev = out.filter((u) => !u.footnote && !u.inline).at(-1);
    const first = units.find((u) => !u.footnote && !u.inline);
    if (
      prev?.para &&
      first?.para &&
      prev.kind === "body" &&
      first.kind === "body" &&
      !/\r?\n[ \t]*\r?\n/.test(text.slice(prev.end, first.start))
    ) {
      // Where it was cut: a table looks only at the fragment in its own part (review 5차).
      prev.cut = { end: prev.end, start: first.start };
      prev.end = first.end;
      prev.kind = "body";
      delete prev.leadIn;
      units.splice(units.indexOf(first), 1);
    }
    out.push(...units);
  });
  out.sort((a, b) => a.start - b.start);
  const blocks = out.filter((u) => !u.inline);
  // A lead-in: a short line ending with a colon right before a list item or a table (shown next to it).
  return out.map((u) => {
    const unit: CitationUnit = {
      start: u.start,
      end: u.end,
      kind: u.kind,
      ...(u.table ? { table: true as const } : {}),
      ...(u.footnote ? { footnote: true as const } : {}),
      ...(u.note !== undefined ? { note: u.note } : {}),
      ...(u.part !== undefined ? { part: u.part } : {}),
      ...(u.cut ? { cut: u.cut } : {}),
      ...(u.inline ? { inline: true as const } : {}),
    };
    if (!u.leadIn || u.kind !== "body" || u.item) return unit;
    const next = shownNext(blocks, blocks.indexOf(u), 1);
    return next && ((next as Unit).item || next.table) ? { ...unit, kind: "lead_in" as const } : unit;
  });
}

/**
 * The unit shown right before (`dir` -1) or after (+1) the block at `i`, in the screen's order (review 4차): the
 * same text part (a tool row comes between two parts), body next to body and footnote next to footnote (a footnote
 * is shown at the end, apart from the body around its definition). Inline code and math are not blocks.
 */
function shownNext<U extends CitationUnit>(blocks: readonly U[], i: number, dir: 1 | -1): U | undefined {
  const u = blocks[i];
  if (!u) return undefined;
  for (let k = i + dir; k >= 0 && k < blocks.length; k += dir) {
    const c = blocks[k]!;
    if (c.inline) continue;
    if (!c.footnote !== !u.footnote) continue;
    // A footnote's block next to another block of the same footnote only (each footnote is shown apart).
    if (c.note !== u.note) return undefined;
    return c.part === u.part ? c : undefined;
  }
  return undefined;
}

export type CitationMarker = TextRange & { n: number };

/** `[n]` markers of the answer, outside fenced code. Not `[n](link)` (a markdown link) and not `[^n]`. */
export function citationMarkers(
  text: string,
  units: readonly CitationUnit[] = citationUnits(text),
): CitationMarker[] {
  const code = units.filter((u) => u.kind === "code");
  // Inline code spans (`a[1]`) on one line.
  for (const m of text.matchAll(/`[^`\n]+`/g))
    code.push({ start: m.index, end: m.index + m[0].length, kind: "code" });
  const out: CitationMarker[] = [];
  for (const m of text.matchAll(/\[(\d{1,3})\](?!\()/g)) {
    const start = m.index;
    if (code.some((c) => start >= c.start && start < c.end)) continue;
    const n = Number(m[1]);
    if (n >= 1) out.push({ n, start, end: start + m[0].length });
  }
  return out;
}

const END = /[.!?。！？]/u;

/**
 * Whether a marker at `start` is array indexing: right after `]` (`m[0][1]`), or right after an identifier that is
 * itself directly preceded by `[` or `]`, or by `=` (also `+=`, `==`) or `(` with spaces allowed — `x = a[1]`,
 * `f(a[1]`. Nothing else counts (review #97 rounds 4–5): `Windows, Linux[1]`, `GPT-4o[1]`, `S&P500[1]`,
 * `Node.js[1]`, `Python 3.12[1]`, `example.com[1]` are citation markers — and so is `obj.items[1]` at a prose line
 * end (a rare over-warning). Code blocks and inline code are never markers anyway.
 */
function inExpression(text: string, start: number): boolean {
  const prev = text[start - 1] ?? "";
  if (prev === "]") return true; // m[0][1]
  if (!/[A-Za-z0-9_]/.test(prev)) return false;
  let k = start - 1;
  while (k >= 0 && /[A-Za-z0-9_]/.test(text[k]!)) k--;
  if (k >= 0 && /[[\]]/.test(text[k]!)) return true;
  while (k >= 0 && (text[k] === " " || text[k] === "\t")) k--;
  return k >= 0 && /[=(]/.test(text[k]!);
}
/**
 * Markers that stand where a citation stands — at the end of a sentence: right before sentence punctuation (not
 * `a[1].length`), right after it (`늘었다.[1]`), or at the end of a line (trailing spaces allowed) unless it is
 * array indexing in an expression (`늘었다[1]`, `this year[1]`; not `x = a[1]`). Chained markers (`[1][2]`) count together. For answers that used no web tool:
 * a marker there pretends to cite, so it is checked; `a[1]` in prose is not.
 */
export function sentenceEndMarkers(
  text: string,
  units: readonly CitationUnit[] = citationUnits(text),
): CitationMarker[] {
  const all = citationMarkers(text, units);
  const out: CitationMarker[] = [];
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j + 1 < all.length && all[j + 1]!.start === all[j]!.end) j++;
    const before = text[all[i]!.start - 1] ?? "";
    const after = text[all[j]!.end] ?? "";
    const afterNext = text[all[j]!.end + 1] ?? "";
    // The line end may come after trailing spaces.
    const lineRest = /^[ \t]*(\r?\n|$)/.exec(text.slice(all[j]!.end, all[j]!.end + 200));
    const atEnd =
      (END.test(after) && !/[A-Za-z0-9_(]/.test(afterNext)) ||
      /[.!?。！？"”)]/u.test(before) ||
      (lineRest !== null && before !== "" && !inExpression(text, all[i]!.start));
    if (atEnd) out.push(...all.slice(i, j + 1));
    i = j + 1;
  }
  return out;
}

/**
 * A line right after a table that says where it is from: `출처: …`, `(자료: …)`, `※ …`, `표 1. …`, `표 1 전형별 인원`.
 */
const CAPTION = /^[\s*_(（[]*(?:(?:출처|자료|근거|source|표)\s*[:：.)\]]|표\s*\d+(?=[\s:：.)\]]))|^\s*※/iu;

/**
 * Opinion framing (#202, `common@11`): a sentence that says itself it is the assistant's own judgement — it starts
 * with "제 판단으로는", "제 생각에는", "제 의견으로는", "제 추정으로는", "개인적으로는" … or ends with "…제 추정이에요",
 * "…제 판단입니다" …. Only these explicit words: a sentence is never taken for an opinion from what it says.
 */
const OPINION_WORD = "(?:제|저의|내)\\s*(?:판단|생각|의견|추정|추측|견해|소견)";
const OPINION_LEAD = new RegExp(
  `^(?:${OPINION_WORD}(?:으로는|으론|에는|엔|에|으로|은|는|이지만|이긴\\s*하지만)?|개인적으로(?:는)?)(?:[,\\s]|$)`,
  "u",
);
const OPINION_TAIL = new RegExp(
  `${OPINION_WORD}(?:이에요|이예요|예요|입니다|이다|일\\s*뿐이에요|일\\s*뿐입니다|일\\s*뿐이다)$`,
  "u",
);

const LIST_MARKER = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/u;
/** A list item's leading label: bold text ending in a colon (`**추천:**`, `**추천**:`) — only that, never a sentence. */
const ITEM_LABEL = /^(\*\*|__)[^*_\n]{1,20}?[:：]\1\s*|^(\*\*|__)[^*_\n]{1,20}?\2\s*[:：]\s*/u;

const TERMINAL = /[.!?。！？．]/u;
/** What may close a sentence after its punctuation: brackets, quotes, emphasis (`…같아요[1].**`). */
const CLOSER = /[)\]"'”’」』*_~]/u;
const WORD = /[A-Za-z0-9]/;

/**
 * The one sentence boundary of the missing-citation rules (#202, review 2차) — the opinion check, the closing-offer
 * and progress-note checks and "the sentence right before a table" all use it. A sentence ends at `.`, `!`, `?`
 * (and their full-width forms `。！？．`), taking along more of them, closing brackets, quotes and emphasis marks and the
 * citation markers right after (`…했어요.[1]`, `…같아요[1].**`) — whatever follows, a space or not
 * (`유리해요.2027년 …`, `유리해요!30명 …` are two sentences). Not a boundary: a `.` between two ASCII letters or digits
 * (`3.5`, `Node.js`, `example.com`). A line break is a boundary. Ranges of `t`, trimmed, never empty.
 */
export function sentenceSpans(t: string): TextRange[] {
  const out: TextRange[] = [];
  let start = 0;
  const push = (end: number) => {
    const s = t.slice(start, end);
    const lead = s.length - s.trimStart().length;
    const body = s.trim();
    if (body) out.push({ start: start + lead, end: start + lead + body.length });
    start = end;
  };
  for (let i = 0; i < t.length;) {
    const ch = t[i]!;
    if (ch === "\n") {
      push(i);
      start = ++i;
      continue;
    }
    if (TERMINAL.test(ch) && !(ch === "." && WORD.test(t[i - 1] ?? "") && WORD.test(t[i + 1] ?? ""))) {
      let j = i + 1;
      for (;;) {
        if (j < t.length && (TERMINAL.test(t[j]!) || CLOSER.test(t[j]!))) j++;
        else {
          const m = /^\[\d{1,3}\]/.exec(t.slice(j));
          if (!m) break;
          j += m[0].length;
        }
      }
      push(j);
      i = j;
      continue;
    }
    i++;
  }
  push(t.length);
  return out;
}

/**
 * The sentences of a unit (#202): line by line — a list item's marker and its leading label (`- **추천:** …`) and a
 * quote's `>` are not part of it — cut by `sentenceSpans`. Emphasis marks are dropped, the words kept.
 */
export function unitSentences(t: string): string[] {
  return t
    .split(/\r?\n/u)
    .flatMap((raw) => {
      const quoted = raw.replace(/^[\s>]+/u, "");
      const item = LIST_MARKER.exec(quoted);
      const line = item ? quoted.slice(item[0].length).replace(ITEM_LABEL, "") : quoted;
      return sentenceSpans(line).map((r) => line.slice(r.start, r.end));
    })
    .map((s) => s.replace(/\*\*|__/gu, "").trim())
    .filter(Boolean);
}

const sentenceBody = (s: string) => s.replace(/[\s.!?。！？．…~]+$/gu, "");

/**
 * A paragraph of the assistant's own opinion, said so (#202): **every** sentence carries the explicit framing above.
 * One sentence without it (a fact next to the opinion) and the paragraph is checked like any other.
 */
export function isFramedOpinion(unit: string): boolean {
  const sentences = unitSentences(unit).map(sentenceBody);
  // An empty piece (a lone mark) is not framed either: every piece must say it is an opinion.
  return sentences.length > 0 && sentences.every((s) => OPINION_LEAD.test(s) || OPINION_TAIL.test(s));
}

/** The last sentence of a unit (`sentenceSpans`), as a range of the answer text. */
function lastSentence(text: string, u: TextRange): TextRange {
  const last = sentenceSpans(text.slice(u.start, u.end)).at(-1);
  return last ? { start: u.start + last.start, end: u.start + last.end } : { start: u.end, end: u.end };
}

/**
 * Body units that contain no marker: what the note marks as missing a citation. Not flagged (#202):
 * - a table — one unit — with a marker in it, in its caption (a short `출처: …` line right after it) or in the
 *   sentence right before it (the lead-in, a heading, the last sentence of the paragraph before);
 * - a paragraph of the assistant's opinion that says so in every sentence (`isFramedOpinion`).
 */
export function uncitedUnits(
  text: string,
  units: readonly CitationUnit[] = citationUnits(text),
  markers: readonly CitationMarker[] = citationMarkers(text, units),
): TextRange[] {
  const cited = (r: TextRange) => markers.some((m) => m.start >= r.start && m.end <= r.end);
  const blocks = units.filter((u) => !u.inline);
  // A table's neighbours are the fragments of its own text part (review 5차): a paragraph a tool call cut is two
  // fragments here — one per part — though it is one unit for the check.
  const frags = blocks.flatMap((u): CitationUnit[] => {
    if (!u.cut) return [u];
    const { cut, ...rest } = u;
    return [
      { ...rest, end: cut.end },
      { ...rest, start: cut.start, part: (u.part ?? 0) + 1 },
    ];
  });
  const tableCited = (u: CitationUnit) => {
    const i = frags.indexOf(u);
    const prev = shownNext(frags, i, -1);
    // The sentence before: not another table's last cell (two tables in a row are two tables).
    if (
      prev &&
      prev.kind !== "code" &&
      prev.kind !== "rule" &&
      !prev.table &&
      cited(lastSentence(text, prev))
    )
      return true;
    const next = shownNext(frags, i, 1);
    if (!next || next.kind === "code" || next.kind === "rule") return false;
    const t = text.slice(next.start, next.end).trim();
    return !/[\r\n]/.test(t) && t.length <= 160 && CAPTION.test(t) && cited(next);
  };
  return blocks
    .filter((u) => {
      if (u.kind !== "body" || cited(u)) return false;
      const t = text.slice(u.start, u.end);
      if (u.table) return !tableCited(u);
      return !isFramedOpinion(t);
    })
    .map(({ start, end }) => ({ start, end }));
}
