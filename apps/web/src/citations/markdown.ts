import { CITATION_MISSING_MARK, type CitationNotePart, type TextRange } from "@agentlee/shared";
import { ADJACENT } from "./segments.js";

/**
 * Citation markers inside the markdown renderer (#25 on #78's message view). A rehype plugin turns each `[n]` in
 * ordinary text into `<sup data-cite-n="n">` — only for the numbers the server listed as markers of this answer, at
 * the server's marker positions where the text maps to its source (#202 review 3차), never in text without a source
 * position (KaTeX's output), never inside code (`pre`, `code`) and never in a link (a link's `[n]` is markup, not text, by then). Markers side
 * by side (`[1][3]`, spaces allowed between) become one `sup` (`data-cite-n="1,3"`, #150). The `sup` is then drawn
 * as the citation chip by the renderer's `sup` component.
 */

type Hast = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Hast[];
  position?: { start: { offset?: number }; end?: { offset?: number } };
};

const MARKER = /\[(\d{1,3})\]/g;
const startOf = (n: Hast) => n.position?.start.offset;
const endOf = (n: Hast) => n.position?.end?.offset;

export function rehypeCitationMarkers(
  numbers: ReadonlySet<number>,
  at?: { offset: number; markers: readonly { start: number; n: number }[] },
) {
  const split = (node: Hast): Hast[] => {
    const value = node.value ?? "";
    // Only text of the answer (review 3차): text a plugin made — KaTeX's MathML annotation, the ⚠️ — has no source
    // position and is never a marker. Where the text is its source character for character, only the server's
    // marker positions are markers.
    const s = startOf(node);
    if (s === undefined) return [node];
    const exact = at && value.length === (endOf(node) ?? -1) - s;
    const out: Hast[] = [];
    let pos = 0;
    let chip: Hast | undefined; // the sup right before `pos`, if the last thing written was one
    for (const m of value.matchAll(MARKER)) {
      const n = Number(m[1]);
      if (!numbers.has(n)) continue;
      if (exact && !at.markers.some((k) => k.n === n && k.start === at.offset + s + m.index)) continue;
      const between = value.slice(pos, m.index);
      if (chip && ADJACENT.test(between)) {
        chip.properties!.dataCiteN = `${String(chip.properties!.dataCiteN)},${n}`;
        chip.children![0]!.value += between + m[0];
      } else {
        if (m.index > pos) out.push({ type: "text", value: between });
        chip = {
          type: "element",
          tagName: "sup",
          properties: { dataCiteN: String(n) },
          children: [{ type: "text", value: m[0] }],
        };
        out.push(chip);
      }
      pos = m.index + m[0].length;
    }
    if (!out.length) return [node];
    if (pos < value.length) out.push({ type: "text", value: value.slice(pos) });
    return out;
  };
  const walk = (node: Hast) => {
    if (node.type === "element" && (node.tagName === "pre" || node.tagName === "code")) return;
    if (!node.children) return;
    node.children = node.children.flatMap((c) => (c.type === "text" ? split(c) : (walk(c), [c])));
  };
  return () => (tree: Hast) => walk(tree);
}

/** The marker numbers of a note. */
export const markerNumbers = (note: CitationNotePart): ReadonlySet<number> =>
  new Set(note.markers.map((m) => m.n));

/** The elements a paragraph of the answer becomes: what a missing-citation range marks (#202). */
const MARKABLE = new Set(["p", "li", "table", "blockquote"]);
const NESTED = new Set(["ul", "ol", "table", "blockquote", "pre", "div"]);

/** The small ⚠️ at the end of a marked paragraph. */
const badge = (): Hast => ({
  type: "element",
  tagName: "span",
  properties: {
    className: ["cite-missing-badge"],
    role: "img",
    ariaLabel: CITATION_MISSING_MARK,
    title: CITATION_MISSING_MARK,
  },
  children: [{ type: "text", value: "⚠️" }],
});

/**
 * Paragraphs without a citation, marked in the rendered answer (#202 — the source note no longer repeats them).
 * `ranges` are the note's `missing` ranges in the answer text; this markdown block is `[offset, end)` of it (text
 * parts joined, then `splitBlocks`).
 *
 * **One focus target per range** (review 1차 — the summary line counts ranges and moves to targets, so the two
 * always agree): the first element, in document order, whose source starts inside the range — a paragraph, a list
 * item, a table or a quote — is the range's target: `data-cite-missing` (the answer's mark id), focusable, a ⚠️ at
 * the end of its own text (a table's is drawn by the table component). Its children of *other* ranges (a loose
 * item's second paragraph, a nested item) are still marked for theirs. A range that began in an earlier block or
 * text part (a paragraph cut by a tool call) only gets the bar here: its target is where it starts. A range that
 * starts in this block but has no such element (block math, code, raw HTML shown as text — ranges stored by an older
 * server) gets the top-level node it covers, found by its source position, wrapped as its target; several ranges
 * inside what renders as one block (an older server's table rows, `•` lines of one paragraph) get the row, cell or
 * the very text they cover inside it (review 3차), and a range that covers nothing visible (a delimiter row) the
 * nearest free element — never an empty target and never one already taken. It runs **before** KaTeX and the highlighter (review 2차): they replace elements and drop
 * source positions, so a target is always chosen by position, never by guessing.
 * Ranges stored by an older server mark the same way: the marks come from the ranges, nothing is recomputed.
 */
export function rehypeMissingMarks(
  ranges: readonly TextRange[],
  offset: number,
  end: number,
  markId: string,
) {
  const rangeAt = (at: number) => ranges.findIndex((r) => at >= r.start && at < r.end);
  const isOurs = (i: number) => ranges[i]!.start >= offset && ranges[i]!.start < end;
  const targetProps = (props: Record<string, unknown>) => {
    props.dataCiteMissing = markId;
    props.dataTestid = "citation-missing";
    props.tabIndex = -1;
  };
  const mark = (el: Hast, i: number) => {
    const props = (el.properties ??= {});
    const cls = props.className;
    props.className = [...(Array.isArray(cls) ? (cls as unknown[]) : cls ? [cls] : []), "cite-missing-block"];
    if (!isOurs(i)) return; // the bar only: the range's target is where it starts
    targetProps(props);
    if (el.tagName === "table") return;
    const kids = (el.children ??= []);
    // The ⚠️ at the end of the element's own text: the last paragraph of this range before any nested block, or
    // right before the nested block.
    const nestedAt = kids.findIndex((k) => k.type === "element" && NESTED.has(k.tagName ?? ""));
    const own = nestedAt === -1 ? kids : kids.slice(0, nestedAt);
    const para = [...own]
      .reverse()
      .find((k) => k.type === "element" && k.tagName === "p" && rangeAt(offset + (startOf(k) ?? -1)) === i);
    if (para) (para.children ??= []).push(badge());
    else kids.splice(nestedAt === -1 ? kids.length : nestedAt, 0, badge());
  };
  return () => (tree: Hast) => {
    if (!ranges.length) return;
    const claimed = new Set<number>();
    const walk = (node: Hast) => {
      for (const c of node.children ?? []) {
        if (c.type !== "element") continue;
        const at = startOf(c);
        const i = MARKABLE.has(c.tagName ?? "") && at !== undefined ? rangeAt(offset + at) : -1;
        if (i !== -1 && !claimed.has(i)) {
          claimed.add(i);
          mark(c, i);
        }
        if (c.tagName !== "pre" && c.tagName !== "code") walk(c);
      }
    };
    walk(tree);
    // Ranges of this block left without a target (ranges an older server stored: math, code, raw HTML, or several
    // ranges inside what renders as one block — a table's rows, `•` lines in one paragraph). By source position
    // only (this runs before KaTeX and the highlighter, which drop positions); never an empty target.
    const root = (tree.children ??= []);
    const isTarget = (n: Hast) => n.properties?.dataCiteMissing === markId;
    const holdsTarget = (n: Hast): boolean => isTarget(n) || (n.children ?? []).some(holdsTarget);
    const overlaps = (n: Hast, r: TextRange) => {
      const s = startOf(n);
      const e = endOf(n);
      return s !== undefined && e !== undefined && offset + s < r.end && offset + e > r.start;
    };
    const asTarget = (el: Hast) => {
      const props = (el.properties ??= {});
      const cls = props.className;
      props.className = [
        ...(Array.isArray(cls) ? (cls as unknown[]) : cls ? [cls] : []),
        "cite-missing-block",
      ];
      targetProps(props);
      const kids = (el.children ??= []);
      // A row's ⚠️ goes in its last cell.
      const cell = el.tagName === "tr" ? [...kids].reverse().find((k) => k.type === "element") : undefined;
      if (el.tagName !== "table") (cell ? (cell.children ??= []) : kids).push(badge());
    };
    /** The part of a text node inside the range, as a target span (the text node split at the source offsets). */
    const textTarget = (parent: Hast, k: number, r: TextRange) => {
      const node = parent.children![k]!;
      const s = startOf(node)!;
      const e = endOf(node)!;
      const value = node.value ?? "";
      const exact = value.length === e - s;
      const a = exact ? Math.max(0, r.start - offset - s) : 0;
      const b = exact ? Math.min(value.length, r.end - offset - s) : value.length;
      const piece = (from: number, to: number): Hast => ({
        type: "text",
        value: value.slice(from, to),
        position: { start: { offset: s + from }, end: { offset: s + to } },
      });
      const props: Record<string, unknown> = { className: ["cite-missing-inline"] };
      targetProps(props);
      const span: Hast = {
        type: "element",
        tagName: "span",
        properties: props,
        children: [piece(a, b), badge()],
        position: { start: { offset: s + a }, end: { offset: s + b } },
      };
      parent.children!.splice(
        k,
        1,
        ...(a > 0 ? [piece(0, a)] : []),
        span,
        ...(b < value.length ? [piece(b, value.length)] : []),
      );
    };
    /** The first free place for `r` inside `node`: a node it covers that holds no target yet, deepest last. */
    const place = (node: Hast, r: TextRange): boolean => {
      const kids = node.children ?? [];
      // 1. Something it covers with no target in it: that element (or that text).
      for (let k = 0; k < kids.length; k++) {
        const c = kids[k]!;
        if (!overlaps(c, r) || holdsTarget(c)) continue;
        if (c.type === "text") {
          if (!(c.value ?? "").trim()) continue;
          textTarget(node, k, r);
          return true;
        }
        if (c.type !== "element") continue;
        // It starts before the range (the range is a later line of it): the place is inside it.
        if (offset + startOf(c)! < r.start && c.tagName !== "pre" && c.tagName !== "code" && place(c, r))
          return true;
        if (node === tree) {
          // A top-level block: wrapped whole (math, code and raw HTML are replaced or drawn by their own components).
          const props: Record<string, unknown> = { className: ["cite-missing-block", "cite-missing-wrap"] };
          targetProps(props);
          root.splice(k, 1, { type: "element", tagName: "div", properties: props, children: [c, badge()] });
        } else asTarget(c);
        return true;
      }
      // 2. Inside what it covers that already holds another range's target (a table's rows, a paragraph's lines).
      for (const c of kids)
        if (
          c.type === "element" &&
          overlaps(c, r) &&
          c.tagName !== "pre" &&
          c.tagName !== "code" &&
          place(c, r)
        )
          return true;
      return false;
    };
    /** Nothing it covers is free (a delimiter row has no element): the nearest free element after it, else before. */
    const nearest = (r: TextRange): boolean => {
      const free: Hast[] = [];
      const collect = (n: Hast) => {
        for (const c of n.children ?? [])
          if (c.type === "element") {
            if (!holdsTarget(c) && startOf(c) !== undefined && c.tagName !== "thead" && c.tagName !== "tbody")
              free.push(c);
            if (c.tagName !== "pre" && c.tagName !== "code") collect(c);
          }
      };
      collect(tree);
      const pick =
        free.find((c) => offset + startOf(c)! >= r.start) ?? [...free].reverse().find((c) => !holdsTarget(c));
      if (!pick || holdsTarget(pick)) return false;
      asTarget(pick);
      return true;
    };
    ranges.forEach((r, i) => {
      if (claimed.has(i) || !isOurs(i)) return;
      if (place(tree, r) || nearest(r)) claimed.add(i);
    });
  };
}
