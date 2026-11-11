import { CITATION_MISSING_TEXT, type CitationNotePart } from "@agentlee/shared";
import { CitationMarker } from "./CitationMarker.js";
import { segments, sourceViews } from "./segments.js";
import "./citations.css";

/**
 * The answer text of a message with a citation note (#25): `[n]` markers become citation buttons with their
 * preview, paragraphs the server found without a citation are marked ⚠️. Everything is text — page titles and
 * quotes are never read as HTML. The chat screen uses it in place of the plain text when the note exists.
 */
export function CitedText({ text, note }: { text: string; note: CitationNotePart }) {
  return (
    <>
      {segments(text, note).map((s, i) =>
        s.kind === "text" ? (
          <span key={i}>{s.text}</span>
        ) : s.kind === "marker" ? (
          <CitationMarker key={i} view={s.view} />
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

/**
 * Under the answer: the missing-citation warning and the source list — number, title, site, date, URL and the
 * status ("원문 구절 확인" or the ⚠️ text). Nothing when the note has neither.
 */
export function CitationSources({ note }: { note: CitationNotePart }) {
  const views = sourceViews(note);
  if (!views.length && !note.missing.length) return null;
  return (
    <div className="cite-note" data-testid="citation-note">
      {note.missing.length > 0 && (
        <div className="notice warn" data-testid="citation-missing-warning">
          {CITATION_MISSING_TEXT}
        </div>
      )}
      {views.length > 0 && (
        <ol className="cite-sources" aria-label="출처">
          {views.map((v) => (
            <li key={v.n} className={v.ok ? "" : "warn"} data-testid="citation-source" data-status={v.status}>
              <span className="cite-n">[{v.n}]</span>{" "}
              <span className="cite-body">
                {v.title && <span className="cite-title">{v.title}</span>}
                {(v.site || v.date) && (
                  <span className="cite-meta">{[v.site, v.date].filter(Boolean).join(" · ")}</span>
                )}
                {v.url &&
                  (v.href ? (
                    <a className="cite-url" href={v.href} target="_blank" rel="noopener noreferrer nofollow">
                      {v.url}
                    </a>
                  ) : (
                    <span className="cite-url">{v.url}</span>
                  ))}
                <span className={`cite-status${v.ok ? " ok" : " warn"}`} data-testid="citation-status">
                  {v.label}
                </span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
