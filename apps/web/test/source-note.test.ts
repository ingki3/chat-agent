import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CITATION_UNBACKED_TEXT,
  FINANCE_DISCLAIMER,
  financeLabel,
  type CitationNotePart,
  type FinanceMeta,
  type FinanceNotePart,
  type PublicPart,
} from "@agentlee/shared";
import { Parts } from "../src/chat/Parts.js";
import { markerNumbers } from "../src/citations/markdown.js";
import { citationView } from "../src/citations/segments.js";
import { dataSourceViews, sourceNoteOf } from "../src/citations/source-note.js";

/**
 * The answer's one source note (#185): numbered citations (web, files) and recorded data sources (finance) shown in
 * one "출처" box, the disclaimer only with a finance source, and every stored note — old ones too — still drawn.
 */

const meta = (source: string, asOf: string, timeZone: string, delayed = false): FinanceMeta => ({
  source,
  asOf,
  timeZone,
  delayed,
  kind: delayed ? "intraday" : "close",
});
const yahoo = meta("Yahoo Finance", "2026-11-13T16:00:00-05:00", "America/New_York");
const naverLive = meta("네이버 증권", "2026-11-13T10:12:00+09:00", "Asia/Seoul", true);
const finance = (missing: FinanceNotePart["missing"] = []): FinanceNotePart => ({
  type: "finance_note",
  sources: [yahoo, naverLive].map((m) => ({ ...m, label: financeLabel(m) })),
  missing,
  disclaimer: FINANCE_DISCLAIMER,
});
const TEXT = "수출이 늘었어요[1].";
const citation: CitationNotePart = {
  type: "citation_note",
  citations: [
    {
      n: 1,
      status: "verified",
      sourceId: "s1",
      title: "수출 동향",
      site: "가나다 신문",
      url: "https://news.example/1",
      publishedAt: "2026-11-10T09:00:00+09:00",
      quote: "수출이 늘었다",
    },
  ],
  missing: [],
  markers: [{ n: 1, start: 7, end: 10 }],
};
const render = (parts: PublicPart[]) => renderToStaticMarkup(createElement(Parts, { parts }));
const count = (html: string, id: string) => html.split(`data-testid="${id}"`).length - 1;

describe("the answer's source note (#185)", () => {
  it("finance sources: each name with its as-of time next to it (delayed said), and the disclaimer", () => {
    expect(dataSourceViews(finance())).toEqual([
      expect.objectContaining({ name: "Yahoo Finance", asOf: "2026-11-13 16:00 ET 종가", delayed: false }),
      expect.objectContaining({
        name: "네이버 증권",
        asOf: "2026-11-13 10:12 KST 장중 (지연)",
        delayed: true,
      }),
    ]);
    const html = render([{ type: "text", text: "AAPL 349.8달러" }, finance()]);
    expect(count(html, "source-note")).toBe(1);
    expect(count(html, "source-data")).toBe(2);
    expect(html).toContain('data-testid="source-as-of">2026-11-13 10:12 KST 장중 (지연)<');
    expect(html).toContain('data-testid="citation-summary">출처 2개<');
    expect(html).toContain(FINANCE_DISCLAIMER);
    expect(html).not.toContain('data-testid="finance-missing"');
    // What the answer left out is a warning in the same box.
    expect(render([{ type: "text", text: "x" }, finance(["source", "as_of"])])).toContain(
      "출처·기준 시각이 빠진 부분이 있어",
    );
    expect(render([{ type: "text", text: "x" }, finance(["tool_meta"])])).toContain(
      "일부 숫자는 출처·기준 시각을 확인하지 못했어요",
    );
  });

  it("web citations alone: the same box, no disclaimer, no data rows", () => {
    const html = render([{ type: "text", text: TEXT }, citation]);
    expect(count(html, "source-note")).toBe(1);
    expect(html).toContain('data-testid="citation-summary">출처 1개 · 모두 확인됨<');
    expect(count(html, "source-data")).toBe(0);
    expect(html).not.toContain(FINANCE_DISCLAIMER);
  });

  it("both kinds in one answer (and old messages that stored both): one box, all sources counted", () => {
    const parts: PublicPart[] = [{ type: "text", text: TEXT }, finance(), citation];
    expect(sourceNoteOf(parts)).toMatchObject({ at: 1, citation, finance: finance() });
    const html = render(parts);
    expect(count(html, "source-note")).toBe(1);
    expect(html).toContain('data-testid="citation-summary">출처 3개 · 모두 확인됨<');
    // Folded: the verified citation is behind the summary, the time-sensitive data sources stay listed.
    expect(count(html, "citation-source")).toBe(0);
    expect(count(html, "source-data")).toBe(2);
    expect(html).toContain(FINANCE_DISCLAIMER);
  });

  it("an old finance note under an answer without tools (pre-#185 carry-over) still renders as stored", () => {
    const html = render([{ type: "text", text: "최대 2시간이에요." }, finance(["source", "as_of"])]);
    expect(count(html, "source-note")).toBe(1);
    expect(html).toContain("Yahoo Finance");
    expect(html).toContain(FINANCE_DISCLAIMER);
  });

  it("an answer whose [n] cite nothing (unbacked): the marker flagged in the text, a notice, no source box", () => {
    const text = "최신 수출은 32% 증가했다[1].";
    const unbacked: CitationNotePart = {
      type: "citation_note",
      citations: [
        {
          n: 1,
          status: "unknown_source",
          sourceId: null,
          title: null,
          site: null,
          url: null,
          publishedAt: null,
          quote: null,
        },
      ],
      missing: [],
      markers: [{ n: 1, start: 15, end: 18 }],
      unbacked: true,
    };
    const html = render([{ type: "text", text }, unbacked]);
    expect(count(html, "source-note")).toBe(0);
    expect(count(html, "citation-summary")).toBe(0);
    expect(html).toContain(`data-testid="citation-unbacked">${CITATION_UNBACKED_TEXT}<`);
    // The marker is still a citation marker of the answer (drawn as a button once the markdown chunk is there —
    // e2e), and it reads as a failure: ⚠️, never "원문 구절 확인".
    expect([...markerNumbers(unbacked)]).toEqual([1]);
    expect(citationView(1, unbacked.citations[0])).toMatchObject({ ok: false, status: "unknown_source" });
    // With a finance part (a finance tool, made-up [n]): the finance box, with the notice in it, no citation rows.
    const both = render([{ type: "text", text }, finance(), unbacked]);
    expect(count(both, "source-note")).toBe(1);
    expect(count(both, "citation-unbacked")).toBe(1);
    expect(count(both, "citation-source")).toBe(0);
    expect(both).toContain('data-testid="citation-summary">출처 2개<');
  });

  it("no note part: no box", () => {
    expect(sourceNoteOf([{ type: "text", text: "349.8달러 [1]" }])).toBeUndefined();
    expect(render([{ type: "text", text: "349.8달러" }])).not.toContain("source-note");
  });
});
