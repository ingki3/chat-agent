/**
 * Splits markdown into top-level blocks so a streaming reply re-renders only its last block (FR-3.1: no full
 * redraw per token) — without changing what the markdown means:
 *
 * - the blocks are consecutive slices of the text: joined, they are the text, byte for byte (every blank line
 *   stays where it was — inside indented code, too);
 * - a block ends before a line that follows one or more blank lines, but never inside fenced code (``` / ~~~)
 *   or `$$` math;
 * - a list stays one block across blank lines (a loose list, `1.` items numbered on, nested items), as does
 *   any indented continuation;
 * - a reply that contains `]:` anywhere is not split at all: it may hold a link reference or footnote
 *   definition, and those are document-wide (a definition may sit under a heading, run over several lines,
 *   have a label that spans lines or holds an escaped `\]`, and serve links in any block). Over-matching is
 *   harmless — such a reply is just re-rendered whole while it streams — and rare in chat.
 */
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/;

export function splitBlocks(text: string): string[] {
  if (!text) return [];
  if (text.includes("]:")) return [text];
  const out: string[] = [];
  let blockStart = 0; // offset where the current block starts
  let hasContent = false; // the current block has a non-blank line
  let fence: string | null = null; // the opening marker of the open code fence, if any
  let math = false;
  let blank = false; // blank lines were seen since the last content line
  let inList = false; // the current block holds a list that may go on after blank lines
  let offset = 0;
  for (const line of text.split("\n")) {
    const at = offset;
    offset += line.length + 1;
    const trimmed = line.trimStart();
    if (fence) {
      if (trimmed.startsWith(fence) && trimmed.slice(fence.length).trim() === "") fence = null;
      continue;
    }
    if (math) {
      if (trimmed.trimEnd().endsWith("$$")) math = false;
      continue;
    }
    if (line.trim() === "") {
      blank = hasContent;
      continue;
    }
    if (blank) {
      blank = false;
      // Indented lines continue a list item (or code); a new item continues the list. Otherwise a new block
      // starts at this line (the blank lines stay at the end of the previous one).
      if (!(/^[ \t]/.test(line) || (inList && LIST_ITEM.test(line)))) {
        out.push(text.slice(blockStart, at));
        blockStart = at;
        inList = false;
      }
    }
    hasContent = true;
    const f = /^(`{3,}|~{3,})/.exec(trimmed);
    if (f) {
      fence = f[1]!;
      continue;
    }
    if (trimmed.startsWith("$$")) {
      // "$$ … $$" on one line closes itself
      const t = trimmed.trimEnd();
      math = !(t.length >= 4 && t.endsWith("$$"));
      continue;
    }
    if (LIST_ITEM.test(line)) inList = true;
  }
  out.push(text.slice(blockStart));
  return out;
}
