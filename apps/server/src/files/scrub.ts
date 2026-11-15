import { KNOWN_PLACEHOLDER, knownMasks, type KnownSecrets } from "../secrets/known.js";

/**
 * Known secrets out of a file's extracted text (#48, review #107): all its units together, in document order,
 * with the separator that is really between them (`\n` — the next line, row, page or slide), **uncut** — the
 * extractor never drops text inside the document (only past its 2M-character total, where the text simply ends).
 * Only the shared matcher is used (`knownMasks`, as `scrubKnown`: every common encoding with an optional transport
 * escape, whitespace inside base64 and hex, a cut-off secret at the very end). Each range is then masked in every
 * unit and mark it covers:
 *
 * - inside one mark (a line, a cell, a word): masked there, and the marks are moved to follow the replacement —
 *   a secret on line 2 leaves lines 1 and 3 exactly where they are;
 * - across a mark's edge or a unit's edge: masked in full in every piece it covers, and each unit it touches is
 *   `approximate` — its marks go, its own locator (page, row, slide) stays, nothing finer is claimed.
 *
 * Only **after** this is a long unit capped for display (`capUnit`): with every secret already a placeholder,
 * cutting anywhere shows nothing of one (review #107 6차 — scrubbing after the cut let where the cut fell defeat
 * every rule at the cut point).
 *
 * Accepted limitation (docs/decisions/isolation.md): a raw, percent-encoded or `\u`-escaped secret cut by a line
 * or cell break is two other strings, not that value in a common encoding — it is not looked for.
 */
export type Mark = [number, number, Record<string, unknown>];
export type ScrubbedSegment = { text: string; marks: Mark[] | null; approximate: boolean };
/**
 * `endsEarly`: text the extractor did not take follows right after this unit — a limit stopped it there (the 2M
 * total, the page or OCR limit, `extract/segments.mjs` `boundary`). Only there is a cut-off secret's beginning a
 * secret (review #107 9차): the cut-off rule applies at that point and nowhere else.
 */
type Unit = { text: string; marks?: readonly Mark[] | null | undefined; endsEarly?: boolean | undefined };

/** What goes between two units in the text they are matched in. */
export const UNIT_SEPARATOR = "\n";

/**
 * Linear in the text, the ranges, the units and the marks (review #107 4차). The units are split into **runs**
 * (review #107 10차): a run ends at each unit after which the extractor left text out (`endsEarly`) and at the
 * file's end. Within a run the units are joined with their real separators and matched whole (full matches);
 * at the end of a run that ends early, the cut-off-secret rule too — over the whole run, however long the encoded
 * value is (no fixed window). Nothing is ever matched across a run boundary: the text that was left out is not
 * there to join.
 */
export function scrubFile(units: readonly Unit[], registry?: KnownSecrets): ScrubbedSegment[] {
  const out: ScrubbedSegment[] = [];
  let from = 0;
  for (let i = 0; i < units.length; i++)
    if (units[i]!.endsEarly || i === units.length - 1) {
      out.push(...scrubRun(units.slice(from, i + 1), !!units[i]!.endsEarly, registry));
      from = i + 1;
    }
  return out;
}

/** One run: the units joined, full matches — and the cut-off rule at its end when it ends early. */
function scrubRun(units: readonly Unit[], endsEarly: boolean, registry?: KnownSecrets): ScrubbedSegment[] {
  return runRanges(units, endsEarly, registry).map((r, i) =>
    applyRanges(units[i]!.text, units[i]!.marks, r.ranges, r.edge),
  );
}

type UnitRanges = { ranges: [number, number][]; edge: boolean };

/** The masked ranges of each unit of one run (unit-local, sorted, apart); `edge`: a range crosses its edge. */
function runRanges(units: readonly Unit[], endsEarly: boolean, registry?: KnownSecrets): UnitRanges[] {
  const full = units.map((u) => u.text).join(UNIT_SEPARATOR);
  const ranges = knownMasks(full, { ...(registry ? { registry } : {}), tail: endsEarly });
  let at = 0;
  let j = 0;
  return units.map((u) => {
    const start = at;
    const end = start + u.text.length;
    at = end + UNIT_SEPARATOR.length;
    // Ranges are sorted and apart: skip the ones that ended before this unit, take the ones that start in it.
    while (j < ranges.length && ranges[j]![1] <= start) j++;
    const local: [number, number][] = [];
    let edge = false;
    for (let k = j; k < ranges.length && ranges[k]![0] < end; k++) {
      const [a, b] = ranges[k]!;
      if (a < start || b > end) edge = true;
      local.push([Math.max(a, start) - start, Math.min(b, end) - start]);
    }
    return { ranges: local, edge };
  });
}

/**
 * A text field cut to `max` characters after it was scrubbed (a sheet name, review #107 9차): never inside a
 * placeholder or a surrogate pair. `cut` says it was cut.
 */
export function capText(text: string, max: number): { text: string; cut: boolean } {
  if (text.length <= max) return { text, cut: false };
  let at = max;
  const p = text.indexOf(KNOWN_PLACEHOLDER, Math.max(0, at - KNOWN_PLACEHOLDER.length + 1));
  if (p !== -1 && p < at) at = p;
  if (at > 0 && /[\uD800-\uDBFF]/.test(text[at - 1]!)) at--;
  return { text: text.slice(0, at), cut: true };
}

/** Characters one stored unit holds at most (a display cap — applied only after scrubbing, `capUnit`). */
export const MAX_UNIT_CHARS = 200_000;

/**
 * A scrubbed unit cut to `max` characters for storage and display: never inside a placeholder (the cut moves back
 * to its start) or a surrogate pair; marks past the cut go, one across it ends there. `cut` says it was cut.
 */
export function capUnit(s: ScrubbedSegment, max = MAX_UNIT_CHARS): ScrubbedSegment & { cut: boolean } {
  if (s.text.length <= max) return { ...s, cut: false };
  let at = max;
  const p = s.text.indexOf(KNOWN_PLACEHOLDER, Math.max(0, at - KNOWN_PLACEHOLDER.length + 1));
  if (p !== -1 && p < at) at = p;
  if (at > 0 && /[\uD800-\uDBFF]/.test(s.text[at - 1]!)) at--;
  const marks = s.marks
    ? s.marks.filter(([a]) => a < at).map(([a, e, f]): Mark => [a, Math.min(e, at), f])
    : null;
  return {
    text: s.text.slice(0, at),
    marks: marks?.length ? marks : null,
    approximate: s.approximate,
    cut: true,
  };
}

/** One unit on its own (`scrubFile` of a single unit). */
export function scrubSegment(
  text: string,
  marks: readonly Mark[] | null | undefined,
  registry?: KnownSecrets,
): ScrubbedSegment {
  return scrubFile([{ text, marks }], registry)[0]!;
}

function applyRanges(
  text: string,
  marks: readonly Mark[] | null | undefined,
  ranges: [number, number][],
  edge: boolean,
): ScrubbedSegment {
  if (!ranges.length) return { text, marks: marks?.length ? [...marks] : null, approximate: false };
  const parts: string[] = [];
  let at = 0;
  for (const [a, b] of ranges) {
    parts.push(text.slice(at, a), KNOWN_PLACEHOLDER);
    at = b;
  }
  parts.push(text.slice(at));
  const out = parts.join("");
  if (edge || !marks?.length) return { text: out, marks: null, approximate: true };
  // Every mark end, in position order, moved by the replacements before it (one sweep over the ranges).
  const points: { p: number; i: number; end: boolean }[] = [];
  marks.forEach(([s0, e0], i) => {
    points.push({ p: s0, i, end: false }, { p: e0, i, end: true });
  });
  points.sort((x, y) => x.p - y.p);
  const moved = marks.map(() => [0, 0]);
  let k = 0;
  let shift = 0;
  for (const pt of points) {
    // Ranges wholly before this point move it.
    while (k < ranges.length && ranges[k]![1] <= pt.p) {
      shift += KNOWN_PLACEHOLDER.length - (ranges[k]![1] - ranges[k]![0]);
      k++;
    }
    // Inside a masked range (not at its start): its place is lost.
    if (k < ranges.length && ranges[k]![0] < pt.p) return { text: out, marks: null, approximate: true };
    moved[pt.i]![pt.end ? 1 : 0] = pt.p + shift;
  }
  const next: Mark[] = [];
  for (const [i, [, , f]] of marks.entries()) {
    const [ns, ne] = moved[i]!;
    if (ne! < ns!) return { text: out, marks: null, approximate: true };
    next.push([ns!, ne!, f]);
  }
  return { text: out, marks: next, approximate: false };
}

/** Stored marks (`file_segments.marks` JSON), or null when none or unreadable. */
export function parseMarks(raw: unknown): Mark[] | null {
  if (typeof raw !== "string") return null;
  try {
    const m = JSON.parse(raw) as unknown;
    return Array.isArray(m) ? (m as Mark[]) : null;
  } catch {
    return null;
  }
}

/**
 * The viewer's check hashes of a file's citations (#24, `textHash` in `citations.locator`) are dropped: they were
 * computed over text that a secret registered since is now hidden in — kept, a hash of known context and a guessed
 * value would tell the value (review #123 2차). Called wherever a file's stored text changes after a citation could
 * have been made: the background rescrub of the file and its re-extraction. Those citations then open as the unit
 * ("unverified"), never as an exact range.
 */
export function forgetCitedTextHashes(
  sql: { prepare(sql: string): { run(...args: unknown[]): unknown } },
  fileId: string,
) {
  sql
    .prepare(
      `UPDATE citations SET locator = json_remove(locator, '$.textHash')
       WHERE file_id = ? AND locator IS NOT NULL AND json_valid(locator) AND json_extract(locator, '$.textHash') IS NOT NULL`,
    )
    .run(fileId);
}
