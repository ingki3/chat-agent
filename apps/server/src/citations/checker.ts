import { skillToolName } from "@agentlee/mcp-tools";
import { GOOGLE_NEWS_SKILL, SEARCH_GOOGLE_SKILL } from "@agentlee/mcp-tools/skills";
import { CITE_TOOL, SOURCES_LIST_TOOL, WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "@agentlee/mcp-tools/web";
import { FILE_CITE_TOOL, FILE_LIST_TOOL, FILE_READ_TOOL, FILE_SEARCH_TOOL } from "@agentlee/mcp-tools/files";
import {
  boundText,
  CITATION_LIMITS,
  FileLocator,
  locatorLabel,
  citationMarkers,
  sentenceEndMarkers,
  citationUnits,
  uncitedUnits,
  unitSentences,
  type CitationUnit,
  type CitationMarker,
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
 * - the body paragraphs without any marker (headings, list lead-ins, disclaimers excluded; a table is one unit, and
 *   progress notes, closing offers and opinions said so are not flagged — #202, `missingUnits`) — marked in the
 *   answer on the screen, with one line "출처 표시 없는 문단 N개".
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

/** Where in the answer text each tool call came (the length of the text written before it), in order. */
export function toolCallsAt(parts: readonly MessagePart[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (const p of parts) {
    if (p.type === "tool_call") out.push(at);
    if (p.type === "text") at += p.text.length;
  }
  return out;
}

/** Where each text part starts in the answer text: the screen renders each part on its own (#202 review 3차). */
export function textPartStarts(parts: readonly MessagePart[]): number[] {
  const out: number[] = [];
  let at = 0;
  for (const p of parts)
    if (p.type === "text") {
      out.push(at);
      at += p.text.length;
    }
  return out;
}

/** Where in the answer text the first tool call came (the length of the text written before it). */
export function firstToolAt(parts: readonly MessagePart[]): number {
  return toolCallsAt(parts)[0] ?? Number.POSITIVE_INFINITY;
}

/** A clause joined to another ("…니", "…서", "…고", "…지만", "…는데", "since", "and" …). */
const CONNECTIVE =
  /(?:니까?|서|고|지만|는데|은데|던데|으며|며|면서|므로|라|나|만)[,]?\s|[,;:]|\b(?:and|because|since|so|but|as)\b/iu;

/** A complement clause that carries a fact ("양산이 확정됐음을 알려드리겠습니다", "…다는", "…라는"). */
const COMPLEMENT = /(?:음을|함을|임을|다는|라는|냐는|다고|라고)\s/u;
/** "…늘어난 것을 확인했어요" — what was found, said as the object of the step (#202): a statement. */
const FOUND = /(?:것을|걸|점을|사실을|내용을)\s/u;

/**
 * A progress note (#202, user decision 2026-11-19 — by position, not by wording): the text right before a tool call
 * — a unit that ends where a tool call comes, only blank space between — of at most 160 characters, with no digit
 * and no `[n]`. Whatever it says ("파일을 읽어 볼게요.", "엑셀 두 개를 다 읽었어요. 이제 학과별 입결 시트를 확인하고
 * 있어요."), it is not flagged. Accepted residual risk: a short sentence with no figure that states a fact right
 * before a tool call is not flagged either (`docs/decisions/sources.md` 7절). The same text anywhere else — the
 * last paragraph, or followed by more text before the call — is checked.
 */
export function isProgressNote(text: string, u: CitationUnit, toolsAt: readonly number[]): boolean {
  if (u.table) return false;
  const t = text.slice(u.start, u.end).trim();
  // Any decimal digit (full-width `３０` too, review 6차) — and so any `[n]`.
  if (t.length > 160 || /\p{Nd}/u.test(t)) return false;
  return toolsAt.some((at) => at >= u.end && !text.slice(u.end, at).trim());
}

/** Parts the screen does not show between a text and the tool call after it (the call's own row aside). */
const UNSEEN: ReadonlySet<string> = new Set([
  "tool_call",
  "tool_result",
  "reasoning",
  "citation_note",
  "finance_note",
]);

/**
 * Where in the answer text a tool call comes right after the text (review 6차 — by the parts as stored): the end of
 * a text part followed by a tool call with nothing shown in between. A card or a table between them (an artifact,
 * a file, a structured table) is shown there: the text before it is not right before the call.
 */
export function progressNoteEnds(parts: readonly MessagePart[]): number[] {
  const out: number[] = [];
  let at = 0;
  let pending: number | undefined;
  for (const p of parts) {
    if (p.type === "text") {
      at += p.text.length;
      // Blank text adds nothing shown: it keeps a candidate (moved to its end), never starts one after a card.
      if (p.text.trim() || pending !== undefined) pending = at;
    } else if (p.type === "tool_call") {
      if (pending !== undefined && out.at(-1) !== pending) out.push(pending);
    } else if (!UNSEEN.has(p.type)) pending = undefined;
  }
  return out;
}

/** A closing offer or question (#202): "원하시면 학과별로 비교해 드릴게요.", "어느 전형이 더 궁금하세요?" */
const OFFER_END =
  /(?:드릴까요|할까요|볼까요|드릴게요|드리겠습니다|해\s*드릴게요|말씀해\s*주세요|말씀해주세요|알려\s*주세요|알려주세요|물어보세요|물어봐\s*주세요|궁금하세요|궁금하신가요|원하세요|원하시나요|필요하세요|필요하신가요|있으세요|있으신가요|괜찮으세요|어떠세요|어떨까요)[.!?？…~]*$/u;
/** The conditional an offer starts with ("원하시면", "필요하시면", "더 궁금한 점이 있으면"). */
const OFFER_IF =
  /^(?:혹시\s*)?(?:더\s*)?(?:원하시면|필요하시면|궁금하시면|괜찮으시면|말씀해\s*주시면|알려\s*주시면|궁금한\s*점이\s*있으면|필요한\s*게\s*있으면)\s*,?\s*/u;

/**
 * A closing offer or question after the last tool call (#202): short, no figure, every sentence an offer or a question
 * to the user — nothing stated in it (no joined clause, no "…다는").
 */
export function isClosingOffer(text: string, u: TextRange, lastToolAt: number): boolean {
  if (u.start < lastToolAt) return false;
  const t = text.slice(u.start, u.end).trim();
  if (t.length > 200 || /\d/.test(t)) return false;
  // Sentences cut with or without a space: "마감되었습니다.더 볼까요?" is a statement and a question (review 1차).
  const sentences = unitSentences(t);
  return (
    sentences.length > 0 &&
    sentences.length <= 3 &&
    sentences.every((s) => {
      const bare = s.replace(OFFER_IF, "");
      return OFFER_END.test(bare) && !CONNECTIVE.test(bare) && !COMPLEMENT.test(bare) && !FOUND.test(bare);
    })
  );
}

/**
 * The paragraphs the note flags (#25, #202): body units without a marker (`uncitedUnits` — tables as one unit,
 * opinions said so excluded), less progress notes and, at the end of the answer, closing offers and questions.
 */
export function missingUnits(
  text: string,
  parts: readonly MessagePart[],
  units: readonly CitationUnit[] = citationUnits(text, textPartStarts(parts)),
  markers: readonly CitationMarker[] = citationMarkers(text, units),
): TextRange[] {
  const last = toolCallsAt(parts).at(-1) ?? Number.NEGATIVE_INFINITY;
  const ends = progressNoteEnds(parts);
  const flagged = new Set(uncitedUnits(text, units, markers).map((r) => `${r.start}:${r.end}`));
  const uncited = units.filter(
    (u) => !u.inline && flagged.has(`${u.start}:${u.end}`) && !isProgressNote(text, u, ends),
  );
  // Only at the very end: an offer is how an answer ends — nothing else (cited or not) may come after it.
  let end = uncited.length;
  let tail = text.length;
  while (end > 0) {
    const u = uncited[end - 1]!;
    if (text.slice(u.end, tail).trim() || !isClosingOffer(text, u, last)) break;
    tail = u.start;
    end--;
  }
  return uncited.slice(0, end).map(({ start, end }) => ({ start, end }));
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
    citationId: string;
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
    citationId: c.citationId,
  };
}

/**
 * Tools whose call makes this run's numbers its own (#150): a search, a fetch or a search skill (new material for
 * new numbers), reading or searching an uploaded file, and the two lists (#186 — `file_search`, `file_list` and
 * `sources_list` number their output `[1]`…: a number written after one may name a list item, never an earlier
 * answer's citation), and any `cite` or `file_cite` call — refused ones too (review #153: a
 * refused call registers no row, yet the model may still write the number it meant).
 */
const OWN_NUMBER_TOOLS: ReadonlySet<string> = new Set([
  WEB_SEARCH_TOOL.name,
  WEB_FETCH_TOOL.name,
  skillToolName(GOOGLE_NEWS_SKILL.name),
  skillToolName(SEARCH_GOOGLE_SKILL.name),
  CITE_TOOL.name,
  SOURCES_LIST_TOOL.name,
  FILE_LIST_TOOL.name,
  FILE_READ_TOOL.name,
  FILE_SEARCH_TOOL.name,
  FILE_CITE_TOOL.name,
]);
export const ownsNumbers = (name: string) =>
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
 * own (no search, fetch, news skill, `file_read`, `file_search`, `file_list` or `sources_list`) — then its numbers can only be the earlier ones.
 * As soon as it cites or tries to (or fetches or reads something new), every number is this run's: a marker without
 * a citation of this run stays `unknown_source`, whatever an earlier answer had under that number.
 * What is checked again is the earlier entry's **citation row** (review #186 2·3차, `CitationStore.rowFor`): by the
 * entry's `citationId`, this conversation's and user's only, and only a `complete` row (its snippet the model's whole
 * input, compared uncut). An entry without an id (stored before) or a row that is not complete → not carried —
 * never verified from a possibly cut passage. A web row is checked again against the source's stored text; a file
 * row (#186) by `recheckFile` — **still at the same place**: the file must still be one this conversation's runs may
 * read, and the passage must still be at the row's place (the same unit, line or cell and range, the unit's text up
 * to it unchanged — what the viewer highlights); moved or changed → `snippet_not_found`, being extracted again →
 * `fetch_failed`, a deleted file → not carried (`unknown_source`). Never matched by the sentence's text — only
 * the number the earlier answer gave. An answer that carries a number is an answer using
 * sources: its paragraphs without a marker are flagged as missing (review #153). An answer that used no source tool
 * and carries no number (nothing earlier under it, or the recheck failed) has no sources: its markers get an
 * `unbacked` note only (#185, review #190 1차).
 */
/** A cited file place as the citation row keeps it: the locator and the hash of its unit's text up to the end. */
export type CitedPlace = FileLocator & { textHash?: string | undefined; sheetNo?: number | undefined };

export type CitationCarry = {
  conversationId: string;
  userId: string;
  /** The citations of the newest earlier answer with numbers to carry (`previousCitations`). */
  previous: () => readonly CitationEntry[];
  /** An earlier file citation checked again now (#186, `FileTools.recheck`); without it no file citation carries. */
  recheckFile?: (
    scope: { conversationId: string; userId: string },
    input: { fileId: string; snippet: string; locator: CitedPlace | undefined; unitHash: string | null },
  ) =>
    | { status: CitationStatus; quote: string | null; locator: FileLocator | null; file: { name: string } }
    | undefined;
};

/** The note for one run's answer, or undefined when the check does not apply (or there is nothing to say). */
export function citationNote(
  runId: string,
  parts: readonly MessagePart[],
  store: Pick<CitationStore, "forRun"> & Partial<Pick<CitationStore, "recheck" | "rowFor">>,
  carry?: CitationCarry,
): CitationNotePart | undefined {
  const rows = store.forRun(runId);
  const kinds = usedSourceKinds(parts);
  const used = rows.length > 0 || kinds.has("web") || kinds.has("file");
  const text = answerText(parts);
  if (!text.trim()) return undefined;
  // No source tool and no citation: only sentence-end `[n]` can be numbers carried over (a[1], code and links are
  // text). Whether there is a note at all is decided below — by the carry-over, not by the markers.
  // No source and nothing that looks like a marker: nothing to parse (review 3차 — the common no-tool answer).
  if (!used && !/\[\d{1,3}\](?!\()/.test(text)) return undefined;
  // One parse of the answer, as the screen renders it part by part, for the markers and the missing paragraphs.
  const units = citationUnits(text, textPartStarts(parts));
  const allMarkers = used ? citationMarkers(text, units) : sentenceEndMarkers(text, units);
  const markers = allMarkers.slice(0, CITATION_LIMITS.markers);
  if (!used && !markers.length) return undefined;
  const byN = new Map(rows.map((r) => [r.n, r]));
  const numbers = [...new Set(markers.map((m) => m.n))].sort((a, b) => a - b);
  let earlier: Map<number, CitationEntry> | undefined;
  let carriedAny = false;
  const carriedFrom = (n: number): CitationEntry | undefined => {
    if (!carry || rows.length || !store.rowFor) return undefined;
    if (parts.some((p) => p.type === "tool_call" && ownsNumbers(p.name))) return undefined;
    earlier ??= new Map(carry.previous().map((e) => [e.n, e]));
    const e = earlier.get(n);
    // Only an entry that names its row (review 3차: entries from before are never carried).
    if (!e?.citationId || e.status === "unknown_source") return undefined;
    // The earlier entry's own row: the whole passage it cited (never the display quote, which may be cut).
    const row = store.rowFor(carry, e.citationId);
    if (!row || row.status === "unknown_source") return undefined;
    if (row.sourceId) return row.sourceId === e.sourceId ? carriedWeb(n, e, row) : undefined;
    if (row.fileId && !e.sourceId && e.fileId === row.fileId) return carriedFile(n, e, row);
    return undefined;
  };
  type Row = NonNullable<ReturnType<NonNullable<typeof store.rowFor>>>;
  const carriedWeb = (n: number, e: CitationEntry, row: Row): CitationEntry | undefined => {
    const c = store.recheck?.(carry!, { sourceId: row.sourceId!, snippet: row.snippet });
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
      citationId: row.id,
    };
  };
  // A file citation of the earlier answer: its whole passage looked for again at its own place in the file's text
  // now (#186, review 3차: still there, or not verified — the place shown is the row's, the one the viewer opens).
  const carriedFile = (n: number, e: CitationEntry, row: Row): CitationEntry | undefined => {
    if (!carry?.recheckFile) return undefined;
    // The place exactly as the row keeps it (with its text hash): the recheck looks there and only there.
    const locator = row.locator ? (JSON.parse(row.locator) as CitedPlace) : undefined;
    const c = carry.recheckFile(carry, {
      fileId: row.fileId!,
      snippet: row.snippet,
      locator,
      unitHash: row.unitHash,
    });
    if (!c) return undefined;
    carriedAny = true;
    return fileEntry(n, {
      status: c.status,
      fileId: row.fileId!,
      name: c.file.name,
      quote: c.status === "verified" ? c.quote : e.quote,
      locator: c.status === "verified" ? c.locator : null,
      citationId: row.id,
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
        citationId: r.id,
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
      citationId: r.id,
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
      ? // The markers this branch found (review 6차): a carried answer's `[n]` that is no marker covers nothing.
        missingUnits(text, parts, units, allMarkers).slice(0, CITATION_LIMITS.missing)
      : [];
  return {
    type: "citation_note",
    citations,
    missing,
    markers: markers.map(({ n, start, end }) => ({ n, start, end })),
    // The ranges are the screen's blocks: it marks them in the answer (review 4차; older notes are only counted).
    units: 2,
  };
}
