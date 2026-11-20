import { CITATION_MISSING_MARK, type CitationNotePart, type TextRange } from "@agentlee/shared";
import { ADJACENT } from "./segments.js";

/**
 * Citation markers inside the markdown renderer (#25 on #78's message view). A rehype plugin turns each `[n]` in
 * ordinary text into `<sup data-cite-n="n">` — only for the numbers the server listed as markers of this answer and,
 * given the block's source (`at`), only at the server's marker positions, mapped through the text node's source
 * position (#202 review 3·4차 — an `[n]` that cannot be mapped stays text), never in text without a source
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
  at?: { offset: number; markers: readonly { start: number; n: number }[]; source?: string },
) {
  const split = (node: Hast): Hast[] => {
    const value = node.value ?? "";
    // Only text of the answer (review 3차): text a plugin made — KaTeX's MathML annotation, the ⚠️ — has no source
    // position and is never a marker. Where the text is its source character for character, only the server's
    // marker positions are markers.
    const s = startOf(node);
    if (s === undefined) return [node];
    const e = endOf(node) ?? s;
    // The node's [n] by the server's positions (review 4차): the k-th `[n]` of the rendered text is the k-th `[n]`
    // of its source when both have the same `[n]` in the same order (entities decoded elsewhere in the text do not
    // move them); then only those at a server marker position are chips. Text that does not map this way: none.
    let allowed: ReadonlySet<number> | undefined;
    if (at) {
      const src = [...(at.source?.slice(s, e) ?? "").matchAll(MARKER)];
      const shown = [...value.matchAll(MARKER)];
      if (!at.source || src.length !== shown.length || src.some((m, k) => m[0] !== shown[k]![0]))
        return [node];
      allowed = new Set(
        shown.flatMap((m, k) =>
          at.markers.some((x) => x.n === Number(m[1]) && x.start === at.offset + s + src[k]!.index)
            ? [m.index]
            : [],
        ),
      );
    }
    const out: Hast[] = [];
    let pos = 0;
    let chip: Hast | undefined; // the sup right before `pos`, if the last thing written was one
    for (const m of value.matchAll(MARKER)) {
      const n = Number(m[1]);
      if (!numbers.has(n)) continue;
      if (allowed && !allowed.has(m.index)) continue;
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
 * starts in this block but has no such element (raw HTML, shown as text) gets the text node it starts at, found by
 * its source position at any depth, wrapped where it is as its target. Only notes whose ranges are the screen's own blocks
 * (`units: 2`) are marked (review 4차): a note stored before is only counted, never marked — `Parts` does not pass
 * its ranges here. It runs **before** KaTeX and the highlighter (review 2차): they replace elements and drop
 * source positions, so a target is always chosen by position, never by guessing.
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
    // A range of this block with no such element: raw HTML, shown as text (`remarkHtmlAsText`) — the text node it
    // starts at, at any depth (two HTML blocks in one quote are two targets, review 5차), found by its source
    // position (this runs before KaTeX and the highlighter, which drop positions), wrapped where it is.
    const find = (node: Hast, at: number): { parent: Hast; k: number } | undefined => {
      const kids = node.children ?? [];
      for (let k = 0; k < kids.length; k++) {
        const c = kids[k]!;
        const s = startOf(c);
        if (c.type === "text" && s !== undefined && offset + s === at) return { parent: node, k };
        if (c.type === "element" && c.tagName !== "pre" && c.tagName !== "code") {
          const hit = find(c, at);
          if (hit) return hit;
        }
      }
      return undefined;
    };
    ranges.forEach((r, i) => {
      if (claimed.has(i) || !isOurs(i)) return;
      const hit = find(tree, r.start);
      if (!hit) return;
      const node = hit.parent.children![hit.k]!;
      const props: Record<string, unknown> = { className: ["cite-missing-block", "cite-missing-wrap"] };
      targetProps(props);
      hit.parent.children!.splice(hit.k, 1, {
        type: "element",
        tagName: "span",
        properties: props,
        children: [node, badge()],
      });
      claimed.add(i);
    });
  };
}
