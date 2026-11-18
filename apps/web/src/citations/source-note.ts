import {
  financeAsOfLabel,
  type CitationNotePart,
  type FinanceNotePart,
  type FinanceSource,
  type MessagePart,
} from "@agentlee/shared";

/**
 * The answer's one source note (#185, docs/decisions/sources.md). The server keeps two kinds of sources apart in
 * what it stores — numbered citations (`citation_note`: web pages and files, each `[n]` checked against the quoted
 * passage) and recorded data sources (`finance_note`: what a finance tool returned, with its as-of time) — but an
 * answer shows them together, in one "출처" box, the same way for every kind. Pure functions: the component draws.
 */

export type SourceNoteParts = {
  citation: CitationNotePart | undefined;
  finance: FinanceNotePart | undefined;
  /** The index (in the parts) of the first note part: the box is drawn there, once. */
  at: number;
};

/** The note parts of a message, or undefined when it has none (old messages too: whatever they stored). */
export function sourceNoteOf(parts: readonly MessagePart[]): SourceNoteParts | undefined {
  let citation: CitationNotePart | undefined;
  let finance: FinanceNotePart | undefined;
  let at = -1;
  parts.forEach((p, i) => {
    if (p.type === "citation_note" && !citation) citation = p;
    else if (p.type === "finance_note" && !finance) finance = p;
    else return;
    if (at === -1) at = i;
  });
  return at === -1 ? undefined : { citation, finance, at };
}

/** A recorded data source (not numbered): its name, and the as-of time shown next to it. */
export type DataSourceView = {
  key: string;
  kind: "finance";
  name: string;
  /** "2026-11-13 15:30 KST 종가", "… 장중 (지연)". */
  asOf: string;
  delayed: boolean;
};

/** The as-of part of a stored label (what the server wrote), or the same text made from the fields. */
function asOfOf(s: FinanceSource): string {
  const prefix = `${s.source} · `;
  return s.label.startsWith(prefix) ? s.label.slice(prefix.length) : financeAsOfLabel(s);
}

export function dataSourceViews(finance: FinanceNotePart | undefined): DataSourceView[] {
  return (finance?.sources ?? []).map((s) => ({
    key: s.label,
    kind: "finance",
    name: s.source,
    asOf: asOfOf(s),
    delayed: s.delayed,
  }));
}

/** What the finance check found missing, as the warning reads (old and new notes alike). */
export function financeWarning(finance: FinanceNotePart | undefined): string | null {
  if (!finance?.missing.length) return null;
  return finance.missing.includes("tool_meta")
    ? "⚠️ 일부 숫자는 출처·기준 시각을 확인하지 못했어요."
    : "⚠️ 답변에 출처·기준 시각이 빠진 부분이 있어 아래 기준을 덧붙였어요.";
}
