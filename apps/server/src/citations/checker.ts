import { skillToolName } from "@agentlee/mcp-tools";
import { GOOGLE_NEWS_SKILL } from "@agentlee/mcp-tools/skills";
import { CITE_TOOL, SOURCES_LIST_TOOL, WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from "@agentlee/mcp-tools/web";
import {
  boundText,
  CITATION_LIMITS,
  citationMarkers,
  sentenceEndMarkers,
  uncitedUnits,
  type TextRange,
  type CitationEntry,
  type CitationNotePart,
  type MessagePart,
} from "@agentlee/shared";
import { OUR_TOOL_PREFIX } from "../runtime/lockdown.js";
import type { CitationStore } from "./store.js";

/**
 * The citation check at the end of a run (#25, PRD FR-5.1·5.2, 수용 기준 3). It runs where the finance check runs
 * (RunManager `attachNoteTo`: every run end, stopped answers and answers recovered after a restart too) on every
 * answer that used a web tool (search, fetch, the source list, a search skill) or cited a source:
 * - every `[n]` of the answer, with the status the server gave that citation when the model registered it —
 *   a marker no `cite` produced is `unknown_source`;
 * - the body paragraphs without any marker (headings, list lead-ins, disclaimers excluded) — "일부 내용에 출처
 *   표시 없음".
 * The note is the server's, after the runtime's text. It is built from the server's own citation rows, not from
 * the tool results a runtime reports.
 */

const WEB_TOOL_NAMES: ReadonlySet<string> = new Set([
  WEB_SEARCH_TOOL.name,
  WEB_FETCH_TOOL.name,
  SOURCES_LIST_TOOL.name,
  CITE_TOOL.name,
  skillToolName(GOOGLE_NEWS_SKILL.name),
]);

export function isWebTool(name: string): boolean {
  const bare = name.startsWith(OUR_TOOL_PREFIX) ? name.slice(OUR_TOOL_PREFIX.length) : name;
  return WEB_TOOL_NAMES.has(bare);
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

/** The note for one run's answer, or undefined when the check does not apply (or there is nothing to say). */
export function citationNote(
  runId: string,
  parts: readonly MessagePart[],
  store: Pick<CitationStore, "forRun">,
): CitationNotePart | undefined {
  const rows = store.forRun(runId);
  const used = rows.length > 0 || parts.some((p) => p.type === "tool_call" && isWebTool(p.name));
  const text = answerText(parts);
  if (!text.trim()) return undefined;
  // No web tool and no citation: an answer whose sentences still end in `[n]` pretends to cite — those markers
  // are checked (and are unknown). Other `[n]` (a[1], code, links) and the paragraphs are left alone.
  const markers = (used ? citationMarkers(text) : sentenceEndMarkers(text)).slice(0, CITATION_LIMITS.markers);
  if (!used && !markers.length) return undefined;
  const byN = new Map(rows.map((r) => [r.n, r]));
  const numbers = [...new Set(markers.map((m) => m.n))].sort((a, b) => a - b);
  const citations: CitationEntry[] = numbers.slice(0, CITATION_LIMITS.perRun * 2).map((n) => {
    const r = byN.get(n);
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
  const missing = used
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
