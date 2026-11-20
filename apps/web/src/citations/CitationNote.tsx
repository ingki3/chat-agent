import { useCallback, useId, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router";
import {
  CITATION_MISSING_MARK,
  CITATION_UNBACKED_TEXT,
  citationMissingText,
  type CitationNotePart,
  type FinanceNotePart,
} from "@agentlee/shared";
import { useFileViewHref } from "../files/context.js";
import { CitationMarkers } from "./CitationMarker.js";
import { segments, sourceLinkText, sourceSummary, sourceViews, type CitationView } from "./segments.js";
import { dataSourceViews, financeWarning, type DataSourceView } from "./source-note.js";
import { marksReady, missingMarks, subscribeMarks } from "./marks.js";
import "./citations.css";

/**
 * The answer text of a message with a citation note (#25): `[n]` markers become citation buttons with their
 * preview (side by side ones one chip, #150), paragraphs the server found without a citation are marked ⚠️.
 * Everything is text — page titles and quotes are never read as HTML.
 */
export function CitedText({ text, note }: { text: string; note: CitationNotePart }) {
  return (
    <>
      {segments(text, note).map((s, i) =>
        s.kind === "text" ? (
          <span key={i}>{s.text}</span>
        ) : s.kind === "markers" ? (
          <CitationMarkers key={i} views={s.views} />
        ) : (
          <span key={i} className="cite-missing" data-testid="citation-missing">
            {s.text}
            <span
              className="cite-missing-badge"
              role="img"
              title={CITATION_MISSING_MARK}
              aria-label={CITATION_MISSING_MARK}
            >
              ⚠️
            </span>
          </span>
        ),
      )}
    </>
  );
}

/** One source row: number, title (the link to the original, or the file viewer at the place), site · date. */
function SourceRow({ v }: { v: CitationView }) {
  const fileHref = useFileViewHref();
  const open = v.locator ? fileHref(v.locator.fileId, v.locator, v.citationId) : null;
  const name = sourceLinkText(v);
  return (
    <li className={v.ok ? "" : "warn"} data-testid="citation-source" data-status={v.status}>
      <span className="cite-n">{v.n}</span>
      <span className="cite-body">
        {open ? (
          // A file citation (#24): the file name and place open the viewer there.
          <Link className="cite-title" to={open} data-testid="citation-file-link">
            {v.title}
            {v.site ? ` · ${v.site}` : ""}
          </Link>
        ) : (
          name &&
          (v.href ? (
            <a
              className="cite-title"
              href={v.href}
              target="_blank"
              rel="noopener noreferrer nofollow"
              data-testid="citation-link"
            >
              {name}
            </a>
          ) : (
            <span className="cite-title">{name}</span>
          ))
        )}
        {!open && (v.title ? v.site || v.date : v.date) && (
          <span className="cite-meta">{[v.title ? v.site : null, v.date].filter(Boolean).join(" · ")}</span>
        )}
        {/* Only a failure says what it is: a verified row needs no label (#150). */}
        {!v.ok && (
          <span className="cite-status warn" data-testid="citation-status">
            {v.label}
          </span>
        )}
      </span>
    </li>
  );
}

/** A recorded data source (#185): its name and, next to it, the as-of time (time-sensitive data). Never folded. */
function DataSourceRow({ d }: { d: DataSourceView }) {
  return (
    <li data-testid="source-data" data-kind={d.kind}>
      <span className="cite-n" aria-hidden="true">
        ·
      </span>
      <span className="cite-body">
        <span className="cite-title">{d.name}</span>
        <span className="cite-meta" data-testid="source-as-of">
          {d.asOf}
        </span>
      </span>
    </li>
  );
}

/**
 * "⚠️ 출처 표시 없는 문단 N개" (#202): one line — the paragraphs are marked where they are in the answer. Once the
 * marks are drawn it is a button: a press moves to the next marked paragraph (from the first, round again after the
 * last) and focuses it. Until then (the renderer still loading, or failed: plain text) it is the count as text.
 */
function MissingSummary({ count, markId }: { count: number; markId: string | undefined }) {
  const next = useRef(0);
  const text = citationMissingText(count);
  const ready = useSyncExternalStore(
    subscribeMarks,
    useCallback(() => marksReady(markId), [markId]),
    () => false,
  );
  if (!markId || !ready)
    return (
      <div className="notice warn cite-missing-summary">
        <span data-testid="citation-missing-warning">{text}</span>
      </div>
    );
  const jump = () => {
    const marks = missingMarks(markId);
    if (!marks.length) return;
    const el = marks[next.current % marks.length]!;
    next.current = (next.current + 1) % marks.length;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.focus({ preventScroll: true });
  };
  return (
    <div className="notice warn cite-missing-summary">
      <button
        type="button"
        className="cite-missing-jump"
        data-testid="citation-missing-warning"
        aria-label={`${text} — 눌러서 해당 문단으로 이동`}
        onClick={jump}
      >
        {text}
        <span className="cite-caret" aria-hidden="true">
          ↓
        </span>
      </button>
    </div>
  );
}

/**
 * The answer's one source note (#185, #150): every source the answer used, the same way for every kind — numbered
 * citations of web pages and files (`citation_note`) and recorded data sources such as finance results
 * (`finance_note`), what is missing, and the investment disclaimer when a finance source was used.
 * - The warnings come first: paragraphs without a citation (#202: one line with the count — the paragraphs are
 *   marked in the answer, never repeated here), figures without their source and as-of time.
 * - The list is folded behind a summary row ("출처 N개 · 모두 확인됨 ▸"). Only verified citations fold: a source
 *   that is not verified is never folded away ("⚠️ 확인 안 된 출처 N개", PRD FR-5.2, 수용 기준 3), and a data source
 *   stays listed with its as-of time (FR-7.6: the time is part of the figure).
 * Nothing when there is nothing to show (no source, no warning, no disclaimer).
 *
 * A citation note without sources (`unbacked`, #185 — the answer used no source, its `[n]` cite nothing) is no
 * source: its markers are flagged ⚠️ in the text, and here it is one short notice, never a source box (unless the
 * answer has a finance part, whose box then carries the notice).
 */
export function SourceNote({
  citation,
  finance,
  text,
  markId,
  defaultExpanded = false,
}: {
  citation?: CitationNotePart | undefined;
  finance?: FinanceNotePart | undefined;
  text?: string | undefined;
  /** The answer's marked paragraphs (`data-cite-missing`): the summary line moves to them. */
  markId?: string | undefined;
  /** Starts unfolded (tests; the chat screen starts folded). */
  defaultExpanded?: boolean;
}) {
  const unbacked = citation?.unbacked === true;
  const views = citation && !unbacked ? sourceViews(citation) : [];
  const data = dataSourceViews(finance);
  const unbackedNotice = unbacked && (
    <div className="notice warn" data-testid="citation-unbacked">
      {CITATION_UNBACKED_TEXT}
    </div>
  );
  const [expanded, setExpanded] = useState(defaultExpanded);
  const listId = useId();
  if (unbacked && !finance) return unbackedNotice;
  // The paragraphs without a citation: the ranges that fit the text (old notes' ranges too — #202 keeps them).
  const missingCount = (unbacked ? [] : (citation?.missing ?? [])).filter(
    (m) => m.start < m.end && (text === undefined || m.end <= text.length),
  ).length;
  const financeMissing = financeWarning(finance);
  const disclaimer = finance?.disclaimer;
  if (!views.length && !data.length && !missingCount && !financeMissing && !disclaimer) return null;
  const summary = sourceSummary(views);
  const total = views.length + data.length;
  const summaryText = views.length
    ? `출처 ${total}개 · ${summary.failed ? `⚠️ 확인 안 된 출처 ${summary.failed}개` : "모두 확인됨"}`
    : `출처 ${total}개`;
  // Folding hides only verified citations: with none of those there is nothing to fold.
  const foldable = summary.failed < summary.total;
  const shown = expanded || !foldable ? views : views.filter((v) => !v.ok);
  return (
    <div className="cite-note source-note" data-testid="source-note">
      {unbackedNotice}
      {missingCount > 0 && <MissingSummary count={missingCount} markId={markId} />}
      {financeMissing && (
        <div className="notice warn" data-testid="finance-missing">
          {financeMissing}
        </div>
      )}
      {total > 0 && (
        <div className={`cite-summary${summary.failed ? " warn" : ""}`}>
          {foldable ? (
            <button
              type="button"
              className="cite-toggle"
              aria-expanded={expanded}
              aria-controls={listId}
              data-testid="citation-toggle"
              onClick={() => setExpanded((e) => !e)}
            >
              <span data-testid="citation-summary">{summaryText}</span>
              <span className="cite-caret" aria-hidden="true">
                {expanded ? "▾" : "▸"}
              </span>
            </button>
          ) : (
            <span data-testid="citation-summary">{summaryText}</span>
          )}
        </div>
      )}
      {views.length > 0 && (
        <ol id={listId} className="cite-sources" aria-label="출처" hidden={shown.length === 0}>
          {shown.map((v) => (
            <SourceRow key={v.n} v={v} />
          ))}
        </ol>
      )}
      {data.length > 0 && (
        <ul className="cite-sources source-data" aria-label="데이터 출처·기준 시각">
          {data.map((d) => (
            <DataSourceRow key={d.key} d={d} />
          ))}
        </ul>
      )}
      {disclaimer && (
        <p className="source-disclaimer" data-testid="source-disclaimer">
          {disclaimer}
        </p>
      )}
    </div>
  );
}

/** A citation note alone (tests, and any caller without a finance part): the same source note. */
export function CitationSources({
  note,
  text,
  defaultExpanded = false,
}: {
  note: CitationNotePart;
  text?: string | undefined;
  defaultExpanded?: boolean;
}) {
  return <SourceNote citation={note} text={text} defaultExpanded={defaultExpanded} />;
}
