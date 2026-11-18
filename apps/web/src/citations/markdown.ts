import { CITATION_MISSING_MARK, type CitationNotePart, type TextRange } from "@agentlee/shared";
import { ADJACENT } from "./segments.js";

/**
 * Citation markers inside the markdown renderer (#25 on #78's message view). A rehype plugin turns each `[n]` in
 * ordinary text into `<sup data-cite-n="n">` — only for the numbers the server listed as markers of this answer,
 * never inside code (`pre`, `code`) and never in a link (a link's `[n]` is markup, not text, by then). Markers side
 * by side (`[1][3]`, spaces allowed between) become one `sup` (`data-cite-n="1,3"`, #150). The `sup` is then drawn
 * as the citation chip by the renderer's `sup` component.
 */

type Hast = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Hast[];
  position?: { start: { offset?: number } };
};

const MARKER = /\[(\d{1,3})\]/g;

export function rehypeCitationMarkers(numbers: ReadonlySet<number>) {
  const split = (node: Hast): Hast[] => {
    const value = node.value ?? "";
    const out: Hast[] = [];
    let pos = 0;
    let chip: Hast | undefined; // the sup right before `pos`, if the last thing written was one
    for (const m of value.matchAll(MARKER)) {
      const n = Number(m[1]);
      if (!numbers.has(n)) continue;
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
 * `ranges` are the note's `missing` ranges in the answer text; `offset` is where this markdown block starts in it
 * (text parts joined, then `splitBlocks`). An element whose source starts inside a range is that paragraph: a
 * paragraph, a list item (the outermost — a loose item's own paragraph is inside it; a nested item starts its own
 * range), a table or a quote. It gets `data-cite-missing` (the answer's mark id, which the summary line moves to),
 * focusability for that move, and a ⚠️ at the end of its text (a table's ⚠️ is drawn by the table component).
 * Ranges stored by an older server mark the same way: the marks come from the ranges, nothing is recomputed.
 */
export function rehypeMissingMarks(ranges: readonly TextRange[], offset: number, markId: string) {
  const inRange = (at: number) => ranges.some((r) => at >= r.start && at < r.end);
  const mark = (el: Hast) => {
    const props = (el.properties ??= {});
    const cls = props.className;
    props.className = [...(Array.isArray(cls) ? (cls as unknown[]) : cls ? [cls] : []), "cite-missing-block"];
    props.dataCiteMissing = markId;
    props.dataTestid = "citation-missing";
    props.tabIndex = -1;
    if (el.tagName === "table") return;
    const kids = (el.children ??= []);
    // The ⚠️ goes at the end of the paragraph's own text: in a loose item or a quote, its last paragraph before
    // any nested list; else before the nested list.
    const nestedAt = kids.findIndex((k) => k.type === "element" && NESTED.has(k.tagName ?? ""));
    const own = nestedAt === -1 ? kids : kids.slice(0, nestedAt);
    const para = [...own].reverse().find((k) => k.type === "element" && k.tagName === "p");
    if (para) (para.children ??= []).push(badge());
    else kids.splice(nestedAt === -1 ? kids.length : nestedAt, 0, badge());
  };
  const walk = (node: Hast) => {
    for (const c of node.children ?? []) {
      if (c.type !== "element") continue;
      const at = c.position?.start.offset;
      if (MARKABLE.has(c.tagName ?? "") && at !== undefined && inRange(offset + at)) {
        mark(c);
        // A nested list's items are paragraphs of their own.
        for (const k of c.children ?? []) if (k.tagName === "ul" || k.tagName === "ol") walk(k);
      } else if (c.tagName !== "pre" && c.tagName !== "code") walk(c);
    }
  };
  return () => (tree: Hast) => {
    if (ranges.length) walk(tree);
  };
}
