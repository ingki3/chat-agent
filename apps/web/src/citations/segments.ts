import {
  CITATION_STATUS_TEXT,
  CitationStatus,
  citationVerified,
  type CitationEntry,
  type CitationNotePart,
  type FileLocator,
  type MessagePart,
} from "@agentlee/shared";

/**
 * How an answer with a citation note is shown (#25): the pieces of its text — plain text, `[n]` markers and the
 * paragraphs without a citation — and how each citation reads. Pure functions: the components only draw them.
 *
 * The rule the screen keeps: only a citation the server marked `verified` looks normal. Every other status, an
 * unknown status value and a marker the note does not list are shown with ⚠️.
 */

export function citationNoteOf(parts: readonly MessagePart[]): CitationNotePart | undefined {
  return parts.find((p): p is CitationNotePart => p.type === "citation_note");
}

/** A citation's status for display: anything that is not a known status counts as `unknown_source`. */
export function displayStatus(entry: CitationEntry | undefined): CitationStatus {
  if (!entry) return "unknown_source";
  const s = CitationStatus.safeParse(entry.status);
  return s.success ? s.data : "unknown_source";
}

export type CitationView = {
  n: number;
  ok: boolean;
  status: CitationStatus;
  /** "원문 구절 확인" or the ⚠️ text. */
  label: string;
  title: string | null;
  site: string | null;
  date: string | null;
  /** Only http(s) links are ever made clickable. */
  href: string | null;
  url: string | null;
  quote: string | null;
  /**
   * A verified file citation (#48): where the passage is — the viewer opens it there (#24). Null for web citations
   * and for anything not verified (nothing to open at a place the server did not find).
   */
  locator: FileLocator | null;
};

/** An http(s) URL as a link target, or null (anything else is never put into an href). */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

export function citationView(n: number, entry: CitationEntry | undefined): CitationView {
  const status = displayStatus(entry);
  const ok = citationVerified(status) && entry !== undefined;
  const known = status !== "unknown_source" && entry;
  return {
    n,
    ok,
    status,
    label: CITATION_STATUS_TEXT[ok ? "verified" : status === "verified" ? "unknown_source" : status],
    title: known ? entry.title : null,
    site: known ? entry.site : null,
    date:
      known && entry.publishedAt && /^\d{4}-\d{2}-\d{2}/.test(entry.publishedAt)
        ? entry.publishedAt.slice(0, 10)
        : null,
    href: known ? safeHref(entry.url) : null,
    url: known ? entry.url : null,
    quote: known ? entry.quote : null,
    locator: ok && entry.locator ? entry.locator : null,
  };
}

export type Segment =
  { kind: "text"; text: string } | { kind: "marker"; view: CitationView } | { kind: "missing"; text: string };

/**
 * The answer text cut into plain text, markers (with their citation) and missing-citation paragraphs (ranges
 * from the server's note; a range that does not fit the text is ignored).
 */
export function segments(text: string, note: CitationNotePart): Segment[] {
  const byN = new Map(note.citations.map((c) => [c.n, c]));
  type Cut = { start: number; end: number; seg: Segment };
  const cuts: Cut[] = [];
  for (const m of note.missing)
    if (m.start < m.end && m.end <= text.length)
      cuts.push({ start: m.start, end: m.end, seg: { kind: "missing", text: text.slice(m.start, m.end) } });
  // The server's marker positions; one that does not fit the text (or is not `[n]` there) is ignored.
  for (const m of note.markers ?? [])
    if (m.start < m.end && m.end <= text.length && text.slice(m.start, m.end) === `[${m.n}]`)
      if (!cuts.some((c) => m.start < c.end && m.end > c.start))
        cuts.push({
          start: m.start,
          end: m.end,
          seg: { kind: "marker", view: citationView(m.n, byN.get(m.n)) },
        });
  cuts.sort((a, b) => a.start - b.start);
  const out: Segment[] = [];
  let pos = 0;
  for (const c of cuts) {
    if (c.start < pos) continue;
    if (c.start > pos) out.push({ kind: "text", text: text.slice(pos, c.start) });
    out.push(c.seg);
    pos = c.end;
  }
  if (pos < text.length) out.push({ kind: "text", text: text.slice(pos) });
  return out;
}

/** The source list under the answer: every citation of the note, by number. */
export function sourceViews(note: CitationNotePart): CitationView[] {
  return [...note.citations].sort((a, b) => a.n - b.n).map((c) => citationView(c.n, c));
}
