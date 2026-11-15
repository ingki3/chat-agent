import type { CitationNotePart } from "@agentlee/shared";
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
