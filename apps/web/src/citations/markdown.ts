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
  position?: { start: { offset?: number }; end?: { offset?: number } };
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

const startOf = (n: Hast) => n.position?.start.offset;
const endOf = (n: Hast) => n.position?.end?.offset;

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
 * starts in this block but has no such element (block math, indented code, raw HTML shown as text — ranges stored
 * by an older server) gets the top-level node it covers wrapped as its target, or an empty target at its place.
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
    // Ranges of this block left without a target: the top-level node they cover, wrapped; else an empty target.
    const root = (tree.children ??= []);
    ranges.forEach((r, i) => {
      if (claimed.has(i) || !isOurs(i)) return;
      let k = root.findIndex((n) => {
        const s = startOf(n);
        const e = endOf(n);
        return s !== undefined && e !== undefined && offset + s < r.end && offset + e > r.start;
      });
      // Block math comes back from KaTeX without its source position: the element that has none.
      if (k === -1) k = root.findIndex((n) => n.type === "element" && startOf(n) === undefined);
      const props: Record<string, unknown> = { className: ["cite-missing-block", "cite-missing-wrap"] };
      targetProps(props);
      const wrap: Hast = { type: "element", tagName: "div", properties: props, children: [badge()] };
      if (k === -1) root.push(wrap);
      else wrap.children!.unshift(root.splice(k, 1, wrap)[0]!);
      claimed.add(i);
    });
  };
}
