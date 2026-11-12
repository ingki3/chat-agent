import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CITATION_MISSING_TEXT,
  CITATION_STATUS_TEXT,
  citationMarkers,
  type CitationEntry,
  type CitationNotePart,
} from "@agentlee/shared";
import { CitationSources, CitedText } from "../src/citations/CitationNote.js";
import { CitationPreview } from "../src/citations/CitationMarker.js";
import { citationView, safeHref, segments, sourceViews } from "../src/citations/segments.js";

/**
 * The chat screen's citation rendering (#25, 수용 기준 3): only a citation the server verified looks normal; every
 * failure — and anything the screen does not recognise — shows ⚠️, in the marker, the preview and the source list.
 */

const entry = (n: number, status: string, o: Partial<CitationEntry> = {}): CitationEntry =>
  ({
    n,
    status,
    sourceId: `s${n}`,
    title: `제목 ${n}`,
    site: "가나다 신문",
    url: `https://news.example/${n}`,
    publishedAt: "2026-11-10T09:00:00+09:00",
    quote: `구절 ${n}`,
    ...o,
  }) as CitationEntry;

const note = (
  citations: CitationEntry[],
  missing: CitationNotePart["missing"] = [],
  text = "",
): CitationNotePart => ({
  type: "citation_note",
  citations,
  missing,
  markers: citationMarkers(text),
});

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const OK = CITATION_STATUS_TEXT.verified;
/** Every way a citation can fail, including values a newer server or a broken part might carry. */
const FAILURES = [
  "snippet_not_found",
  "fetch_failed",
  "unknown_source",
  "pending",
  "",
  "VERIFIED",
  "verified ",
];

describe("citation views", () => {
  it("verified reads as normal, with the issue's words", () => {
    const v = citationView(1, entry(1, "verified"));
    expect(v).toMatchObject({
      ok: true,
      label: "원문 구절 확인",
      date: "2026-11-10",
      href: "https://news.example/1",
    });
  });

  it.each(FAILURES)("status %j is never shown as normal", (status) => {
    const v = citationView(2, entry(2, status));
    expect(v.ok).toBe(false);
    expect(v.label.startsWith("⚠️ ")).toBe(true);
    expect(v.label).not.toBe(OK);
  });

  it("the exact failure words", () => {
    expect(citationView(1, entry(1, "snippet_not_found")).label).toBe("⚠️ 출처에서 이 내용을 찾지 못했어요");
    expect(citationView(1, entry(1, "fetch_failed")).label).toBe("⚠️ 출처를 가져오지 못했어요");
    expect(citationView(1, entry(1, "unknown_source")).label).toBe("⚠️ 출처를 가져오지 못했어요");
    // A marker the note does not list at all.
    expect(citationView(9, undefined)).toMatchObject({ ok: false, status: "unknown_source", href: null });
  });

  it("only http(s) links become links", () => {
    for (const u of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "not a url", "", null])
      expect(safeHref(u), String(u)).toBeNull();
    expect(safeHref("http://a.example/x?y=1")).toBe("http://a.example/x?y=1");
  });
});

describe("rendering", () => {
  it("markers: verified plain, each failure with ⚠️ in the marker", () => {
    const TEXT = "가[1]. 나[2]. 다[3]. 라[4]. 마[5].";
    const n = note(
      [
        entry(1, "verified"),
        entry(2, "snippet_not_found"),
        entry(3, "fetch_failed"),
        entry(4, "unknown_source"),
      ],
      [],
      TEXT,
    );
    const out = html(createElement(CitedText, { text: TEXT, note: n }));
    const markers = [...out.matchAll(/data-status="([^"]+)"[^>]*>([^<]*)<\/button>/g)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(markers).toEqual([
      ["verified", "[1]"],
      ["snippet_not_found", "[2⚠️]"],
      ["fetch_failed", "[3⚠️]"],
      ["unknown_source", "[4⚠️]"],
      ["unknown_source", "[5⚠️]"],
    ]);
    expect(out.match(/class="cite-marker warn"/g)).toHaveLength(4);
  });

  it("source list: title, site, date, URL and status; every failure row ⚠️ and never the verified words", () => {
    const n = note([entry(1, "verified"), ...FAILURES.map((s, i) => entry(i + 2, s))]);
    const out = html(createElement(CitationSources, { note: n }));
    const rows = out.split("<li").slice(1);
    expect(rows).toHaveLength(1 + FAILURES.length);
    expect(rows[0]).toContain(OK);
    expect(rows[0]).toContain("제목 1");
    expect(rows[0]).toContain("가나다 신문 · 2026-11-10");
    expect(rows[0]).toContain('href="https://news.example/1"');
    for (const row of rows.slice(1)) {
      expect(row).toContain("⚠️");
      expect(row).not.toContain(OK);
      expect(row).toContain('class="warn"');
    }
    // An unknown source shows nothing of a source (no title, no link).
    const unknown = html(createElement(CitationSources, { note: note([entry(1, "unknown_source")]) }));
    expect(unknown).not.toContain("제목 1");
    expect(unknown).not.toContain("href");
  });

  it("preview: the quote and 원문 열기; a failure is labelled as what it meant to quote", () => {
    const ok = html(createElement(CitationPreview, { view: citationView(1, entry(1, "verified")) }));
    expect(ok).toContain("원문 구절 확인");
    expect(ok).toContain("인용 구절");
    expect(ok).toContain("<q>구절 1</q>");
    expect(ok).toMatch(
      /<a class="cite-open" href="https:\/\/news.example\/1" target="_blank" rel="noopener noreferrer nofollow">원문 열기/,
    );
    for (const s of FAILURES) {
      const bad = html(createElement(CitationPreview, { view: citationView(2, entry(2, s)) }));
      expect(bad, s).toContain("⚠️");
      expect(bad, s).not.toContain(OK);
      expect(bad, s).not.toContain(">인용 구절<");
    }
  });

  it("page text is text: tags in titles and quotes are escaped, never markup", () => {
    const evil = entry(1, "verified", {
      title: '<img src=x onerror="alert(1)">',
      quote: "<script>alert(1)</script>",
      site: "<b>site</b>",
    });
    const out =
      html(createElement(CitationSources, { note: note([evil]) })) +
      html(createElement(CitationPreview, { view: citationView(1, evil) }));
    expect(out).not.toContain("<img");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<b>");
    expect(out).toContain("&lt;img");
  });

  it("missing paragraphs are marked and the warning is shown", () => {
    const text = "가[1].\n\n나는 출처가 없어요.";
    const start = text.indexOf("나");
    const n = note([entry(1, "verified")], [{ start, end: text.length }], text);
    expect(segments(text, n).map((s) => s.kind)).toEqual(["text", "marker", "text", "missing"]);
    const body = html(createElement(CitedText, { text, note: n }));
    expect(body).toMatch(
      /<span class="cite-missing" data-testid="citation-missing">나는 출처가 없어요\.<span[^>]*>⚠️<\/span><\/span>/,
    );
    const list = html(createElement(CitationSources, { note: n }));
    expect(list).toContain(CITATION_MISSING_TEXT);
    expect(CITATION_MISSING_TEXT).toBe("⚠️ 일부 내용에 출처 표시 없음");
    // No missing ranges: no warning. A range that does not fit the text is ignored.
    expect(html(createElement(CitationSources, { note: note([entry(1, "verified")]) }))).not.toContain(
      CITATION_MISSING_TEXT,
    );
    expect(segments("짧다", note([], [{ start: 0, end: 99 }])).map((s) => s.kind)).toEqual(["text"]);
  });

  it("only the server's marker positions become citations: other [n] stay text, a wrong position is ignored", () => {
    const text = "a[1] 은 배열이고, 수출은 늘었다[1].";
    const at = text.lastIndexOf("[1]");
    const n: CitationNotePart = {
      ...note([entry(1, "unknown_source")]),
      markers: [
        { n: 1, start: at, end: at + 3 },
        { n: 2, start: 0, end: 3 }, // not "[2]" there
        { n: 1, start: 90, end: 93 }, // outside the text
      ],
    };
    expect(segments(text, n).map((s) => s.kind)).toEqual(["text", "marker", "text"]);
    expect(segments(text, n)[0]).toEqual({ kind: "text", text: "a[1] 은 배열이고, 수출은 늘었다" });
  });

  it("the source list is sorted by number", () => {
    expect(sourceViews(note([entry(2, "verified"), entry(1, "fetch_failed")])).map((v) => v.n)).toEqual([
      1, 2,
    ]);
  });
});
