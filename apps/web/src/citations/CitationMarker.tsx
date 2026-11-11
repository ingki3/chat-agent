import { useEffect, useId, useRef, useState } from "react";
import type { CitationView } from "./segments.js";
import "./citations.css";

/**
 * One `[n]` at the end of a sentence (#25, PRD FR-5.1·5.3). Desktop: hovering shows the preview; a click pins
 * it. Mobile: a tap opens it, another tap (or a tap elsewhere, or Esc) closes it. The preview shows the quoted
 * passage and "원문 열기". A citation that is not verified carries ⚠️ in the marker itself and in the preview.
 *
 * Titles, sites and quotes are page text: rendered as text, never as HTML.
 */
export function CitationMarker({ view }: { view: CitationView }) {
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const id = useId();
  const open = hover || pinned;
  useEffect(() => {
    if (!pinned) return;
    const away = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setPinned(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setPinned(false);
        setHover(false);
      }
    };
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [pinned]);
  return (
    <span
      ref={ref}
      className="cite-anchor"
      onPointerEnter={(e) => e.pointerType === "mouse" && setHover(true)}
      onPointerLeave={(e) => e.pointerType === "mouse" && setHover(false)}
    >
      <button
        type="button"
        className={`cite-marker${view.ok ? "" : " warn"}`}
        data-testid="citation-marker"
        data-status={view.status}
        aria-expanded={open}
        aria-controls={id}
        aria-label={`출처 ${view.n}: ${view.label}`}
        onClick={() => setPinned((p) => !p)}
      >
        [{view.n}
        {view.ok ? "" : "⚠️"}]
      </button>
      {open && <CitationPreview id={id} view={view} />}
    </span>
  );
}

export function CitationPreview({ id, view }: { id?: string; view: CitationView }) {
  return (
    <span
      id={id}
      role="tooltip"
      className={`cite-preview${view.ok ? "" : " warn"}`}
      data-testid="citation-preview"
      data-status={view.status}
    >
      <span className={`cite-status${view.ok ? " ok" : " warn"}`}>{view.label}</span>
      {view.title && <span className="cite-title">{view.title}</span>}
      {(view.site || view.date) && (
        <span className="cite-meta">{[view.site, view.date].filter(Boolean).join(" · ")}</span>
      )}
      {view.quote && (
        <span className="cite-quote">
          <span className="cite-quote-label">{view.ok ? "인용 구절" : "인용하려던 구절"}</span>
          <q>{view.quote}</q>
        </span>
      )}
      {view.href && (
        <a className="cite-open" href={view.href} target="_blank" rel="noopener noreferrer nofollow">
          원문 열기 ↗
        </a>
      )}
    </span>
  );
}
