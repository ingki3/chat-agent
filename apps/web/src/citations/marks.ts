/**
 * The marked paragraphs of answers (#202): where they are in the page, and a signal when a rendered answer has
 * (re)drawn its marks — the summary line under an answer is a button only once its marks exist (review 1차: while
 * the markdown renderer loads, or if it failed, there is nowhere to move to).
 */

const listeners = new Set<() => void>();

/** A markdown block with marks was drawn or changed. */
export function marksChanged(): void {
  for (const l of [...listeners]) l();
}

export function subscribeMarks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The focus targets of one answer (`data-cite-missing`), in document order — one per range. */
export const missingMarks = (markId: string): HTMLElement[] =>
  typeof document === "undefined"
    ? []
    : [
        ...document.querySelectorAll<HTMLElement>(
          `[data-cite-missing="${markId.replace(/["\\]/g, "\\$&")}"]`,
        ),
      ];
