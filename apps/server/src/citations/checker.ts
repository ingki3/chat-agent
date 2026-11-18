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

/** "자료를 찾아 비교해 볼게요." — what the model says it is about to do, not something it states. */
const PROGRESS =
  /(?:볼게요|볼께요|볼게|보겠습니다|할게요|하겠습니다|드릴게요|드리겠습니다|올게요|오겠습니다)[.!…~]*$|^(?:let me|i'll|i will)\s+(?:search|look|check|find|fetch|read|compare)\b/iu;

/**
 * The assistant's own work on the material (#202, review 1·2차) — a closed list of predicates: reading, searching,
 * finding, checking, comparing, sorting out, going through, reviewing, calculating, analysing, looking up; going on
 * ("확인하고 있어요", "비교하는 중이에요"), done ("다 읽었어요") or next ("확인해 볼게요", "찾아볼게요").
 */
const WORK = "(?:읽|찾|찾아보|검색하|확인하|비교하|정리하|살펴보|훑어보|검토하|계산하|분석하|열어보|조회하)";
const WORK_DONE =
  "(?:읽었|찾았|찾아봤|검색했|확인했|비교했|정리했|살펴봤|살펴보았|훑어봤|검토했|계산했|분석했|열어봤|조회했|가져왔)";
const WORK_NEXT =
  "(?:읽을|찾을|검색할|확인할|비교할|정리할|검토할|계산할|분석할|조회할|가져올|(?:읽어|찾아|살펴|훑어|열어|검색해|확인해|비교해|정리해|검토해|계산해|분석해|조회해)\\s*볼)";
const WORK_PREDICATE = new RegExp(
  `(?:${WORK}(?:고\\s*있(?:어요|습니다)|는\\s*중(?:이에요|입니다))|${WORK_DONE}(?:어요|습니다)|${WORK_NEXT}(?:게요|께요|겠습니다))$`,
  "u",
);
/** Adverbs a work note may have ("이제", "다", "같이" …) — words, not subjects. */
const WORK_ADVERBS = new Set(
  "이제 지금 먼저 우선 다음으로 다시 다 모두 전부 같이 함께 한번 좀 마저 계속 차례로 더 꼼꼼히 자세히 하나씩 하나하나".split(
    " ",
  ),
);
/** The assistant as the subject: the only subject a work note may name. */
const AGENT = /^(?:제가|저는)$/u;
/** Determiners and numbers in front of the material ("두 파일을", "첫 기사를", "다음 시트를"). */
const DETERMINERS = new Set(
  "두 세 네 다섯 여섯 일곱 여덟 아홉 열 여러 몇 모든 각 첫 다음 나머지 남은 이 그 해당 새".split(" "),
);
const HANGUL_WORD = /^[가-힣A-Za-z0-9]+$/u;
/**
 * Head nouns that name the material (review 4차): a phrase with bare noun modifiers ("학과별 입결 시트를") is the
 * material only when its head is one of these — "입학처 지원서를" is not (the bare "입학처" may be a subject).
 */
const MATERIAL = new Set(
  "엑셀 파일 시트 자료 표 문서 PDF pdf 페이지 쪽 기사 결과 데이터 내용 입결 원문 보고서 목록 첨부 첨부파일 시행계획 계획 출처 링크 문단 항목 셀 행 열 탭 슬라이드 본문 통계 수치".split(
    " ",
  ),
);
/** Counters of the material ("엑셀 두 개를", "세 장을"). */
const COUNTERS = new Set("개 장 쪽 건 편 개의 부".split(" "));
/** A bare modifier that ends with a particle is no modifier ("교육부조차", "입학처마저", "대학 측에선"). */
const PARTICLE_END = /(?:조차|마저|까지|부터|에서|에선|께서|측|도|은|는|이|가|만|와|과|랑|로|에)$/u;

/**
 * The material as one object phrase, ending in "을/를" (review 3·4차): determiners or numbers, "…의" modifiers, and
 * bare noun modifiers only when the head names the material (`MATERIAL`, or a counter after a material noun:
 * "엑셀 두 개를"). Returns the index after the phrase, or -1.
 */
function objectPhrase(words: readonly string[], k: number): number {
  let j = k;
  const bare: string[] = [];
  while (j < words.length && !/.[을를]$/u.test(words[j]!)) {
    const w = words[j]!;
    if (DETERMINERS.has(w) || /.의$/u.test(w)) j++;
    else if (!WORK_ADVERBS.has(w) && !PARTICLE_END.test(w)) {
      bare.push(w);
      j++;
    } else return -1;
  }
  if (j >= words.length) return -1;
  const head = words[j]!.slice(0, -1);
  if (bare.length) {
    const material = MATERIAL.has(head) || (COUNTERS.has(head) && bare.some((w) => MATERIAL.has(w)));
    if (!material) return -1;
  }
  return j + 1;
}

/**
 * A sentence that only says the assistant works on the material (review 3·4차 — positive only): the predicate is
 * one of `WORK_PREDICATE`, and every word before it is one of
 * - the assistant as the subject: "제가", "저는" (or no subject at all);
 * - a listed adverb (`WORK_ADVERBS`);
 * - the material, as an object phrase (`objectPhrase`): "두 파일을", "파일의 시트를", "학과별 입결 시트를",
 *   "엑셀 두 개를".
 * Any other word — "교육부조차", "입학처마저", "대학 측에선", "경쟁률이", "입학처 지원서를" — and it is checked.
 */
function isWorkNote(sentence: string): boolean {
  const m = WORK_PREDICATE.exec(sentence);
  if (!m) return false;
  const words = sentence.slice(0, m.index).split(/\s+/u).filter(Boolean);
  if (!words.every((w) => HANGUL_WORD.test(w))) return false;
  let k = 0;
  if (k < words.length && AGENT.test(words[k]!)) k++;
  while (k < words.length) {
    if (WORK_ADVERBS.has(words[k]!)) {
      k++;
      continue;
    }
    const next = objectPhrase(words, k);
    if (next === -1) return false;
    k = next;
  }
  return true;
}

/** A clause joined to another ("…니", "…서", "…고", "…지만", "…는데", "since", "and" …). */
const CONNECTIVE =
  /(?:니까?|서|고|지만|는데|은데|던데|으며|며|면서|므로|라|나|만)[,]?\s|[,;:]|\b(?:and|because|since|so|but|as)\b/iu;

/** A complement clause that carries a fact ("양산이 확정됐음을 알려드리겠습니다", "…다는", "…라는"). */
const COMPLEMENT = /(?:음을|함을|임을|다는|라는|냐는|다고|라고)\s/u;
/** "…늘어난 것을 확인했어요" — what was found, said as the object of the step (#202): a statement. */
const FOUND = /(?:것을|걸|점을|사실을|내용을)\s/u;

/**
 * A short progress note before the first tool call: one sentence, no figure, no marker, saying what comes next.
 * Paragraphs that state something before a tool call are still checked.
 *
 * Between tool calls (#202 — the model narrating its work: "파일을 다 읽었어요. 이제 입결 시트를 확인하고 있어요."):
 * a short paragraph before a later tool call, no figure, up to three sentences, each one only saying that the
 * assistant (subject left out, or "제가/저는") will do, is doing or has done its work on the material (`isWorkNote`)
 * — never one that states something (another subject, a complement "…다는", "…것을", a comma). When in doubt it is
 * checked.
 */
export function isProgressNote(
  text: string,
  u: TextRange,
  toolAt: number,
  lastToolAt: number = toolAt,
): boolean {
  const t = text.slice(u.start, u.end).trim();
  if (u.end <= toolAt) {
    // One sentence — "수출이 늘었어요.더 찾아볼게요." is two, even without the space (review 1차).
    if (t.length > 80 || /\d/.test(t) || unitSentences(t).length > 1) return false;
    // "양산이 확정됐으니 자료를 더 찾아볼게요." states something before saying what comes next.
    if (CONNECTIVE.test(t) || COMPLEMENT.test(t)) return false;
    return PROGRESS.test(t);
  }
  if (u.end > lastToolAt || t.length > 160 || /\d/.test(t) || t.includes("\n")) return false;
  const sentences = unitSentences(t).map((s) => s.replace(/[\s.!?。！？…~]+$/u, ""));
  return (
    sentences.length > 0 &&
    sentences.length <= 3 &&
    sentences.every((s) => !COMPLEMENT.test(s) && !FOUND.test(s) && !/[,;:]/u.test(s) && isWorkNote(s))
  );
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
  const at = toolCallsAt(parts);
  const first = at[0] ?? Number.POSITIVE_INFINITY;
  const last = at.at(-1) ?? Number.NEGATIVE_INFINITY;
  const uncited = uncitedUnits(text, units, markers).filter((u) => !isProgressNote(text, u, first, last));
  // Only at the very end: an offer is how an answer ends — nothing else (cited or not) may come after it.
  let end = uncited.length;
  let tail = text.length;
  while (end > 0) {
    const u = uncited[end - 1]!;
    if (text.slice(u.end, tail).trim() || !isClosingOffer(text, u, last)) break;
    tail = u.start;
    end--;
  }
  return uncited.slice(0, end);
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
      ? missingUnits(text, parts, units, used ? allMarkers : citationMarkers(text, units)).slice(
          0,
          CITATION_LIMITS.missing,
        )
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
