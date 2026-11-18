import { skillToolName } from "@agentlee/mcp-tools";
import { GOOGLE_NEWS_SKILL, SEARCH_GOOGLE_SKILL } from "@agentlee/mcp-tools/skills";
import { CITE_TOOL, WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "@agentlee/mcp-tools/web";
import { FILE_CITE_TOOL, FILE_READ_TOOL, FILE_SEARCH_TOOL } from "@agentlee/mcp-tools/files";
import {
  boundText,
  CITATION_LIMITS,
  FileLocator,
  locatorLabel,
  citationMarkers,
  sentenceEndMarkers,
  uncitedUnits,
  type TextRange,
  type CitationEntry,
  type CitationStatus,
  type CitationNotePart,
  type MessagePart,
} from "@agentlee/shared";
import { OUR_TOOL_PREFIX } from "../runtime/lockdown.js";
import { sourceKindOf, usedSourceKinds } from "../sources/provenance.js";
import type { CitationStore } from "./store.js";

/**
 * The citation check at the end of a run (#25, PRD FR-5.1·5.2, 수용 기준 3) — the numbered part of an answer's source
 * note (#185, `sources/provenance.ts`). It runs where the finance check runs (RunManager `attachNoteTo`: every run
 * end, stopped answers and answers recovered after a restart too) and applies **only by provenance**: the answer
 * used a web or file source tool (search, fetch, the source list, a search skill, reading an uploaded file #48),
 * registered a citation, or carries numbers of the answer before that the server checked again (#150). An `[n]` in
 * an answer that did none of these is text, not a citation: no note (#185 — the note is never decided from the text).
 * Marker validation is separate from that (review #190 1차): a no-tool answer whose sentence-end `[n]` carry nothing
 * gets an `unbacked` note — no sources, every such marker `unknown_source` — so the screen flags the marker in the
 * text and shows no source box. Arrays (`a[1]`), code and links are never markers.
 * When it applies:
 * - every `[n]` of the answer, with the status the server gave that citation when the model registered it —
 *   a marker no `cite` produced is `unknown_source`;
 * - the body paragraphs without any marker (headings, list lead-ins, disclaimers excluded) — "일부 내용에 출처
 *   표시 없음".
 * The note is the server's, after the runtime's text. It is built from the server's own citation rows, not from
 * the tool results a runtime reports.
 */

/** A web or file source tool (#25, #48): its use makes the citation check apply. */
export function isWebTool(name: string): boolean {
  const kind = sourceKindOf(name);
  return kind === "web" || kind === "file";
}

/** The answer text as the screen joins it (text parts, in order, no separator). */
export const answerText = (parts: readonly MessagePart[]) =>
  parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");

/** Where in the answer text the first tool call came (the length of the text written before it). */
export function firstToolAt(parts: readonly MessagePart[]): number {
  let at = 0;
  for (const p of parts) {
    if (p.type === "tool_call") return at;
    if (p.type === "text") at += p.text.length;
  }
  return Number.POSITIVE_INFINITY;
}

/** "자료를 찾아 비교해 볼게요." — what the model says it is about to do, not something it states. */
const PROGRESS =
  /(?:볼게요|볼께요|볼게|보겠습니다|할게요|하겠습니다|드릴게요|드리겠습니다|올게요|오겠습니다)[.!…~]*$|^(?:let me|i'll|i will)\s+(?:search|look|check|find|fetch|read|compare)\b/iu;

/** A clause joined to another ("…니", "…서", "…고", "…지만", "…는데", "since", "and" …). */
const CONNECTIVE =
  /(?:니까?|서|고|지만|는데|은데|던데|으며|며|면서|므로|라|나|만)[,]?\s|[,;:]|\b(?:and|because|since|so|but|as)\b/iu;

/** A complement clause that carries a fact ("양산이 확정됐음을 알려드리겠습니다", "…다는", "…라는"). */
const COMPLEMENT = /(?:음을|함을|임을|다는|라는|냐는|다고|라고)\s/u;

/**
 * A short progress note before the first tool call: one sentence, no figure, no marker, saying what comes next.
 * Paragraphs that state something before a tool call are still checked.
 */
export function isProgressNote(text: string, u: TextRange, toolAt: number): boolean {
  if (u.end > toolAt) return false;
  const t = text.slice(u.start, u.end).trim();
  if (t.length > 80 || /\d/.test(t) || /(?<=[.!?。！？])\s+\S/u.test(t)) return false;
  // "양산이 확정됐으니 자료를 더 찾아볼게요." states something before saying what comes next.
  if (CONNECTIVE.test(t) || COMPLEMENT.test(t)) return false;
  return PROGRESS.test(t);
}

const bound = (s: string | null | undefined, n: number) => (s ? boundText(s, n) : null);

/**
 * A file citation's entry (#48): the file's name and the place — the locator only for a verified passage — and the
 * file's id (#186: what a later answer carries over).
 */
function fileEntry(
  n: number,
  c: {
    status: CitationStatus;
    fileId: string;
    name: string;
    quote: string | null;
    locator: FileLocator | null;
  },
): CitationEntry {
  const locator = c.status === "verified" ? c.locator : null;
  return {
    n,
    status: c.status,
    sourceId: null,
    title: bound(c.name, CITATION_LIMITS.title),
    site: locator ? bound(locatorLabel(locator), CITATION_LIMITS.site) : null,
    url: null,
    publishedAt: null,
    quote: bound(c.quote, CITATION_LIMITS.snippet),
    ...(locator ? { locator } : {}),
    fileId: c.fileId,
  };
}

/**
 * Tools whose call makes this run's numbers its own (#150): a search, a fetch or a search skill (new material for
 * new numbers), reading or searching an uploaded file (#186 — `file_search` numbers its hits too: a number written
 * after one is never an earlier answer's), and any `cite` or `file_cite` call — refused ones too (review #153: a
 * refused call registers no row, yet the model may still write the number it meant).
 */
const OWN_NUMBER_TOOLS: ReadonlySet<string> = new Set([
  WEB_SEARCH_TOOL.name,
  WEB_FETCH_TOOL.name,
  skillToolName(GOOGLE_NEWS_SKILL.name),
  skillToolName(SEARCH_GOOGLE_SKILL.name),
  CITE_TOOL.name,
  FILE_READ_TOOL.name,
  FILE_SEARCH_TOOL.name,
  FILE_CITE_TOOL.name,
]);
const ownsNumbers = (name: string) =>
  OWN_NUMBER_TOOLS.has(name.startsWith(OUR_TOOL_PREFIX) ? name.slice(OUR_TOOL_PREFIX.length) : name);

/**
 * Carrying numbers over (#150): a follow-up ("내용 요약해줘") that writes the previous answer's `[n]` again without
 * citing anything itself. `previous` gives the citations of the newest earlier answer of the conversation that has
 * a citation note (the server's own note — a runtime cannot write one); a marker this run has no citation for takes
 * that answer's citation with the same number, **checked again now** (`CitationStore.recheck`: the source must
 * still be this conversation's and this user's, the passage is looked for in its stored text).
 *
 * The rule, and its precedence: numbers are per run, so a carry-over happens only when this run registered **no**
 * citation, **called** no `cite`/`file_cite` (a refused call counts — review #153) and brought in no source of its
 * own (no search, fetch, news skill, `file_read` or `file_search`) — then its numbers can only be the earlier ones.
 * As soon as it cites or tries to (or fetches or reads something new), every number is this run's: a marker without
 * a citation of this run stays `unknown_source`, whatever an earlier answer had under that number.
 * A file citation (#186) carries over by the file id its entry keeps (`fileId`), checked again by `recheckFile`: the
 * file must still be one this conversation's runs may read, and the passage is looked for in its extracted text as
 * it is now (being extracted again → `fetch_failed`, no longer there → `snippet_not_found`, a deleted file → not
 * carried, `unknown_source`). An entry stored before #186 has no `fileId`: not carried. Never matched by the
 * sentence's text — only the number the earlier answer gave. An answer that carries a number is an answer using
 * sources: its paragraphs without a marker are flagged as missing (review #153). An answer that used no source tool
 * and carries no number (nothing earlier under it, or the recheck failed) has no sources: its markers get an
 * `unbacked` note only (#185, review #190 1차).
 */
export type CitationCarry = {
  conversationId: string;
  userId: string;
  previous: () => readonly CitationEntry[];
  /** An earlier file citation checked again now (#186, `FileTools.recheck`); without it no file citation carries. */
  recheckFile?: (
    scope: { conversationId: string; userId: string },
    input: { fileId: string; snippet: string },
  ) =>
    | { status: CitationStatus; quote: string | null; locator: FileLocator | null; file: { name: string } }
    | undefined;
};

/** The note for one run's answer, or undefined when the check does not apply (or there is nothing to say). */
export function citationNote(
  runId: string,
  parts: readonly MessagePart[],
  store: Pick<CitationStore, "forRun"> & Partial<Pick<CitationStore, "recheck">>,
  carry?: CitationCarry,
): CitationNotePart | undefined {
  const rows = store.forRun(runId);
  const kinds = usedSourceKinds(parts);
  const used = rows.length > 0 || kinds.has("web") || kinds.has("file");
  const text = answerText(parts);
  if (!text.trim()) return undefined;
  // No source tool and no citation: only sentence-end `[n]` can be numbers carried over (a[1], code and links are
  // text). Whether there is a note at all is decided below — by the carry-over, not by the markers.
  const markers = (used ? citationMarkers(text) : sentenceEndMarkers(text)).slice(0, CITATION_LIMITS.markers);
  if (!used && !markers.length) return undefined;
  const byN = new Map(rows.map((r) => [r.n, r]));
  const numbers = [...new Set(markers.map((m) => m.n))].sort((a, b) => a - b);
  let earlier: Map<number, CitationEntry> | undefined;
  let carriedAny = false;
  const carriedFrom = (n: number): CitationEntry | undefined => {
    if (!carry || rows.length) return undefined;
    if (parts.some((p) => p.type === "tool_call" && ownsNumbers(p.name))) return undefined;
    earlier ??= new Map(carry.previous().map((e) => [e.n, e]));
    const e = earlier.get(n);
    if (!e || e.status === "unknown_source") return undefined;
    if (e.fileId && !e.sourceId) return carriedFile(n, e, e.fileId);
    if (!e.sourceId || !store.recheck) return undefined;
    // What the earlier answer quoted (verified: the passage itself; otherwise the snippet it sent).
    const c = e.quote ? store.recheck(carry, { sourceId: e.sourceId, snippet: e.quote }) : undefined;
    if (!c) return undefined;
    const s = c.source;
    carriedAny = true;
    return {
      n,
      status: c.status,
      sourceId: s.id,
      title: bound(s.title, CITATION_LIMITS.title),
      site: bound(s.site, CITATION_LIMITS.site),
      url: bound(s.finalUrl ?? s.url, CITATION_LIMITS.url),
      publishedAt: s.publishedAt ?? null,
      quote: bound(c.status === "verified" ? c.quote : e.quote, CITATION_LIMITS.snippet),
    };
  };
  // A file citation of the earlier answer, its passage (verified: as the file had it; otherwise the snippet sent)
  // looked for again in the file's text now (#186).
  const carriedFile = (n: number, e: CitationEntry, fileId: string): CitationEntry | undefined => {
    if (!carry?.recheckFile || !e.quote) return undefined;
    const c = carry.recheckFile(carry, { fileId, snippet: e.quote });
    if (!c) return undefined;
    carriedAny = true;
    return fileEntry(n, {
      status: c.status,
      fileId,
      name: c.file.name,
      quote: c.status === "verified" ? c.quote : e.quote,
      locator: c.status === "verified" ? c.locator : null,
    });
  };
  const citations: CitationEntry[] = numbers.slice(0, CITATION_LIMITS.perRun * 2).map((n) => {
    const r = byN.get(n);
    if (!r) {
      const carried = carriedFrom(n);
      if (carried) return carried;
    }
    // A file citation (#48): the file's name and the place; the locator only for a verified passage.
    if (r?.fileId && r.file && r.status !== "unknown_source") {
      const parsed =
        r.status === "verified" && r.locator ? FileLocator.safeParse(JSON.parse(r.locator)) : undefined;
      return fileEntry(n, {
        status: r.status,
        fileId: r.fileId,
        name: r.file.name,
        quote: r.status === "verified" ? r.quote : r.snippet,
        locator: parsed?.success ? parsed.data : null,
      });
    }
    // A marker without a citation of this run (made up, or a number of another answer): never shown as normal.
    if (!r || r.status === "unknown_source" || !r.source)
      return {
        n,
        status: "unknown_source",
        sourceId: null,
        title: null,
        site: null,
        url: null,
        publishedAt: null,
        quote: null,
      };
    const s = r.source;
    return {
      n,
      status: r.status,
      sourceId: s.id,
      title: bound(s.title, CITATION_LIMITS.title),
      site: bound(s.site, CITATION_LIMITS.site),
      url: bound(s.finalUrl ?? s.url, CITATION_LIMITS.url),
      publishedAt: s.publishedAt ?? null,
      quote: bound(r.status === "verified" ? r.quote : r.snippet, CITATION_LIMITS.snippet),
    };
  });
  // Provenance only (#185): an answer that used no source tool and carried no number has no sources — it gets no
  // source note. Its sentence-end markers still stand where citations stand, so they are not left to read as real
  // ones: a note *without sources* (`unbacked`) marks each of them unverified in the text (review #190 1차).
  if (!used && !carriedAny)
    return {
      type: "citation_note",
      citations,
      missing: [],
      markers: markers.map(({ n, start, end }) => ({ n, start, end })),
      unbacked: true,
    };
  // Carried numbers are sources used too: the answer's paragraphs without any marker are flagged (review #153).
  const missing =
    used || carriedAny
      ? uncitedUnits(text)
          .filter((u) => !isProgressNote(text, u, firstToolAt(parts)))
          .slice(0, CITATION_LIMITS.missing)
      : [];
  return {
    type: "citation_note",
    citations,
    missing,
    markers: markers.map(({ n, start, end }) => ({ n, start, end })),
  };
}
