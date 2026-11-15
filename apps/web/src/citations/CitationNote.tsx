import { useId, useState } from "react";
import { Link } from "react-router";
import { CITATION_MISSING_TEXT, type CitationNotePart } from "@agentlee/shared";
import { useFileViewHref } from "../files/context.js";
import { CitationMarkers } from "./CitationMarker.js";
import { segments, sourceLinkText, sourceSummary, sourceViews, type CitationView } from "./segments.js";
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
            <span className="cite-missing-badge" title="출처 표시 없음" aria-label="출처 표시 없음">
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
  const open = v.locator ? fileHref(v.locator.fileId, v.locator) : null;
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

/**
 * Under the answer: the missing-citation warning and the source list (#150). The list is folded behind a summary
 * row ("출처 N개 · 모두 확인됨 ▸"); a source that is not verified is never folded away — the summary says how many
 * ("⚠️ 확인 안 된 출처 N개") and those rows stay listed (PRD FR-5.2, 수용 기준 3). Nothing when the note has
 * neither sources nor missing paragraphs.
 */
export function CitationSources({
  note,
  text,
  defaultExpanded = false,
}: {
  note: CitationNotePart;
  text?: string;
  /** Starts unfolded (tests; the chat screen starts folded). */
  defaultExpanded?: boolean;
}) {
  const views = sourceViews(note);
  const [expanded, setExpanded] = useState(defaultExpanded);
  const listId = useId();
  if (!views.length && !note.missing.length) return null;
  // The paragraphs without a citation, as excerpts (the markdown view cannot mark ranges inline).
  const missing =
    text === undefined
      ? []
      : note.missing
          .filter((m) => m.start < m.end && m.end <= text.length)
          .map((m) => text.slice(m.start, m.end));
  const summary = sourceSummary(views);
  // Folding hides only verified rows: with none of those there is nothing to fold.
  const foldable = summary.failed < summary.total;
  const shown = expanded || !foldable ? views : views.filter((v) => !v.ok);
  return (
    <div className="cite-note" data-testid="citation-note">
      {note.missing.length > 0 && (
        <div className="notice warn">
          <span data-testid="citation-missing-warning">{CITATION_MISSING_TEXT}</span>
          {missing.length > 0 && (
            <ul className="cite-missing-list">
              {missing.map((t, i) => (
                <li key={i} data-testid="citation-missing">
                  {t}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {views.length > 0 && (
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
              <span data-testid="citation-summary">{summary.text}</span>
              <span className="cite-caret" aria-hidden="true">
                {expanded ? "▾" : "▸"}
              </span>
            </button>
          ) : (
            <span data-testid="citation-summary">{summary.text}</span>
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
    </div>
  );
}
