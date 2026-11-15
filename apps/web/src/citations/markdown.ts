import type { CitationNotePart } from "@agentlee/shared";

/**
 * Citation markers inside the markdown renderer (#25 on #78's message view). A rehype plugin turns each `[n]` in
 * ordinary text into `<sup data-cite-n="n">` — only for the numbers the server listed as markers of this answer,
 * never inside code (`pre`, `code`) and never in a link (a link's `[n]` is markup, not text, by then). The `sup`
 * is then drawn as the citation button by the renderer's `sup` component.
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
    for (const m of value.matchAll(MARKER)) {
      const n = Number(m[1]);
      if (!numbers.has(n)) continue;
      if (m.index > pos) out.push({ type: "text", value: value.slice(pos, m.index) });
      out.push({
        type: "element",
        tagName: "sup",
        properties: { dataCiteN: String(n) },
        children: [{ type: "text", value: m[0] }],
      });
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
