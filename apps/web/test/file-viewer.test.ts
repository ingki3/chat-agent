import { createElement, type FunctionComponent } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { InfiniteQueryObserver, QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  fileViewPath,
  parseLocParam,
  type CitationNotePart,
  type FileLocator,
  type UploadedFile,
  type ViewSegment,
  type ViewTarget,
} from "@agentlee/shared";
import { FileRef } from "../src/chat/Parts.js";
import { CitationSources } from "../src/citations/CitationNote.js";
import { CitationPreview } from "../src/citations/CitationMarker.js";
import { citationView } from "../src/citations/segments.js";
import { FileViewContext } from "../src/files/context.js";
import { FileBody } from "../src/files/FileViewer.js";
import {
  combine,
  hasMore,
  moreAction,
  openingQuery,
  pagingQuery,
  shownPages,
  type ViewFetch,
} from "../src/files/queries.js";
import { blocks, cellsOf, colName, columns, highlightsOf, linesOf, pieces } from "../src/files/view-model.js";

/**
 * The file viewer's screen side (#24): file citations and file chips link to `/c/:id/files/:fileId?loc=`
 * (a link — click or tap, no hover), the layout groups units, and only what the server resolved is highlighted.
 * File text is always text.
 */

const REV = "b".repeat(64);
const base = { fileId: "f1", fileRevision: REV };
const seg = (
  seq: number,
  locator: Omit<FileLocator, "fileId" | "fileRevision">,
  text: string,
  extra: Partial<ViewSegment> = {},
): ViewSegment => ({
  seq,
  locator: { ...base, ...locator },
  text,
  marks: [],
  approximate: false,
  cut: false,
  split: false,
  ...extra,
});
const file: UploadedFile = {
  id: "f1",
  conversationId: "c1",
  messageId: "m1",
  uploadId: null,
  name: "과제안내.hwp",
  kind: "hwp",
  mediaType: "application/x-hwp",
  bytes: 10,
  createdAt: 0,
};
const inRouter = <P extends object>(el: FunctionComponent<P>, props: P, conversation: string | null = "c1") =>
  renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(FileViewContext.Provider, { value: conversation }, createElement(el, props)),
    ),
  );

describe("links to the viewer", () => {
  const locator: FileLocator = { ...base, kind: "table", table: 3, row: 2, col: 2, charRange: [8, 30] };
  const note: CitationNotePart = {
    type: "citation_note",
    citations: [
      {
        n: 1,
        status: "verified",
        sourceId: null,
        title: "과제안내.hwp",
        site: "3번째 표 · 2행 · 2열",
        url: null,
        publishedAt: null,
        quote: "학교 누리집 과제방에 PDF로 올립니다.",
        locator,
      },
      {
        n: 2,
        status: "snippet_not_found",
        sourceId: null,
        title: "과제안내.hwp",
        site: null,
        url: null,
        publishedAt: null,
        quote: "없는 구절",
      },
    ],
    missing: [],
    markers: [],
  };

  it("the address carries the locator and reads back the same", () => {
    const p = fileViewPath("c 1", "f1", locator);
    expect(p.startsWith("/c/c%201/files/f1?loc=")).toBe(true);
    expect(parseLocParam(new URLSearchParams(p.split("?")[1]).get("loc"))).toEqual(locator);
    expect(parseLocParam('{"kind":"page"}')).toBeUndefined();
    expect(parseLocParam("not json")).toBeUndefined();
  });

  it("a verified file citation links to its place — in the source list and the preview; a failed one does not", () => {
    const list = inRouter(CitationSources, { note });
    const href = fileViewPath("c1", "f1", locator).replace(/&/g, "&amp;");
    expect(list).toContain(`href="${href}"`);
    expect(list.match(/data-testid="citation-file-link"/g)).toHaveLength(1);
    expect(list).toContain("과제안내.hwp · 3번째 표 · 2행 · 2열");
    const preview = inRouter(CitationPreview, { view: citationView(1, note.citations[0]) });
    expect(preview).toContain('data-testid="citation-open-file"');
    expect(inRouter(CitationPreview, { view: citationView(2, note.citations[1]) })).not.toContain(
      "citation-open-file",
    );
    // Without a conversation (an artifact share): no link at all — and no router needed.
    expect(renderToStaticMarkup(createElement(CitationSources, { note }))).not.toContain(
      "citation-file-link",
    );
  });

  it("a file chip keeps its download and adds 보기", () => {
    const html = inRouter(FileRef, { part: { type: "file_ref", fileId: "f1", name: "숙제.pdf" } });
    expect(html).toContain('data-testid="file-ref"');
    expect(html).toContain('href="/api/files/f1/content"');
    expect(html).toContain('data-testid="file-ref-open"');
    expect(html).toContain('href="/c/c1/files/f1"');
    expect(
      renderToStaticMarkup(createElement(FileRef, { part: { type: "file_ref", fileId: "f1", name: "a" } })),
    ).not.toContain("file-ref-open");
  });
});

describe("layout and highlights (pure)", () => {
  it("pieces: cut at highlight edges, clipped to the slice", () => {
    expect(
      pieces("가나다라마바", [
        { start: 1, end: 4, kind: "focus" },
        { start: 2, end: 3, kind: "hit" },
      ]),
    ).toEqual([
      { text: "가", hit: false, focus: false },
      { text: "나", hit: false, focus: true },
      { text: "다", hit: true, focus: true },
      { text: "라", hit: false, focus: true },
      { text: "마바", hit: false, focus: false },
    ]);
    expect(pieces("가나다라", [{ start: 0, end: 4, kind: "hit" }], 1, 3)).toEqual([
      { text: "나다", hit: true, focus: false },
    ]);
  });

  it("only exact targets highlight a passage; nothing for stale / not found", () => {
    const exact: ViewTarget = {
      status: "exact",
      reasons: [],
      seqs: [3],
      range: { seq: 3, start: 1, end: 2 },
    };
    expect(highlightsOf(3, exact)).toEqual([{ start: 1, end: 2, kind: "hit" }]);
    expect(highlightsOf(4, exact)).toEqual([]);
    const stale = {
      status: "stale",
      reasons: ["revision_changed"],
      seqs: [],
      range: { seq: 3, start: 1, end: 2 },
    };
    expect(highlightsOf(3, stale as ViewTarget)).toEqual([]);
  });

  it("blocks: table rows (split pieces one row, notes under), sheets, pages, slides", () => {
    const b = blocks([
      seg(0, { kind: "paragraph", paragraph: 1 }, "안내"),
      seg(1, { kind: "table", table: 1, row: 1 }, "a | b", {
        marks: [
          { start: 0, end: 1, col: 1 },
          { start: 4, end: 5, col: 2 },
        ],
      }),
      seg(2, { kind: "table", table: 1, row: 2 }, "글꼴", {
        split: true,
        marks: [{ start: 0, end: 2, col: 2 }],
      }),
      seg(3, { kind: "table", table: 1, row: 2, footnote: 2 }, "각주"),
      seg(4, { kind: "table", table: 1, row: 2 }, "간격", {
        split: true,
        marks: [{ start: 0, end: 2, col: 3 }],
      }),
      seg(5, { kind: "table", table: 2, row: 1 }, "x"),
      seg(6, { kind: "cell_range", sheet: "성적", row: 1, range: "A1:B1" }, "1 | 2"),
      seg(7, { kind: "cell_range", sheet: "성적", row: 2, range: "A2" }, "3"),
      seg(8, { kind: "page", page: 12 }, "p"),
      seg(9, { kind: "slide", slide: 2 }, "s"),
    ]);
    expect(b.map((x) => x.kind)).toEqual(["paragraph", "table", "table", "sheet", "page", "slide"]);
    const t = b[1] as Extract<(typeof b)[number], { kind: "table" }>;
    expect(t.rows.map((r) => [r.row, r.segs.map((s) => s.seq)])).toEqual([
      [1, [1]],
      [2, [2, 4]],
    ]);
    expect(t.notes.map((s) => s.seq)).toEqual([3]);
    expect(cellsOf(t.rows[1]!.segs).map((c) => [c.col, c.seq])).toEqual([
      [2, 2],
      [3, 4],
    ]);
    expect((b[3] as { rows: unknown[] }).rows).toHaveLength(2);
    expect([colName(1), colName(26), colName(27), colName(52)]).toEqual(["A", "Z", "AA", "AZ"]);
    expect(linesOf(seg(0, { kind: "line", line: 1 }, "a\nbc"))).toEqual([
      { line: undefined, start: 0, end: 1 },
      { line: undefined, start: 2, end: 4 },
    ]);
  });
});

describe("review #123", () => {
  it("[P2 2] windows before and after, then refetches (real QueryClient observers): the opening window and its target stay; each unit once", async () => {
    const target: ViewTarget = {
      status: "exact",
      reasons: [],
      seqs: [50],
      range: { seq: 50, start: 0, end: 1 },
    };
    const ALL = 200;
    const LIMIT = 10;
    const calls: string[] = [];
    // The server's windows (viewer.ts `viewWindow`): around seq 50 (20 before), or from/to.
    const fetch: ViewFetch = async (o) => {
      calls.push(JSON.stringify(o));
      const start = o.from ?? (o.loc ? 30 : 0);
      let end = Math.min(ALL, start + LIMIT);
      if (o.to !== undefined) end = Math.max(start, Math.min(end, o.to));
      return {
        file,
        extract: {
          fileId: "f1",
          fileRevision: REV,
          status: "ok",
          code: null,
          ocr: "none",
          units: ALL,
          segments: ALL,
          characters: 1,
          truncated: false,
        },
        items: Array.from({ length: end - start }, (_, i) =>
          seg(start + i, { kind: "slide", slide: start + i + 1 }, "x"),
        ),
        prev: start > 0 ? Math.max(0, start - LIMIT) : null,
        next: end < ALL ? end : null,
        target: o.loc ? target : null,
      };
    };
    const loc: FileLocator = { ...base, kind: "slide", slide: 51 };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const opening = new QueryObserver(client, openingQuery("f1", loc, fetch));
    const stop1 = opening.subscribe(() => {});
    const first = (await opening.refetch()).data!;
    const before = new InfiniteQueryObserver(client, pagingQuery("before", "f1", loc, first, fetch, true));
    const after = new InfiniteQueryObserver(client, pagingQuery("after", "f1", loc, first, fetch, true));
    const stop2 = before.subscribe(() => {});
    const stop3 = after.subscribe(() => {});
    await before.refetch();
    await before.fetchNextPage();
    await after.refetch();
    const shown = () =>
      combine([
        ...(before.getCurrentResult().data?.pages ?? []),
        opening.getCurrentResult().data,
        ...(after.getCurrentResult().data?.pages ?? []),
      ]).map((x) => x.seq);
    const expected = Array.from({ length: 40 }, (_, i) => i + 10);
    expect(shown()).toEqual(expected);
    // Refetches (focus, interval, a manual one) of every query: the same windows, the target kept.
    await before.refetch();
    await after.refetch();
    await opening.refetch();
    expect(opening.getCurrentResult().data!.target).toEqual(target);
    expect(shown()).toEqual(expected);
    // Windows before end where the next one starts: no overlap was ever asked for.
    expect(calls).toContain(JSON.stringify({ from: 20, to: 30 }));
    expect(calls).toContain(JSON.stringify({ from: 10, to: 20 }));
    expect(hasMore("before", first, true, before.getCurrentResult())).toBe(true);
    expect(hasMore("before", first, false, before.getCurrentResult())).toBe(true);
    stop1();
    stop2();
    stop3();
    client.clear();
  });

  it("[P2 3] a cell split around a footnote: both pieces of the column are drawn, in order", () => {
    const items = [
      seg(0, { kind: "table", table: 1, row: 3 }, "글꼴 11pt", {
        split: true,
        marks: [{ start: 0, end: 7, col: 2 }],
      }),
      seg(1, { kind: "table", table: 1, row: 3, footnote: 2 }, "본문 글꼴 기준."),
      seg(2, { kind: "table", table: 1, row: 3 }, "각주 뒤 글", {
        split: true,
        marks: [{ start: 0, end: 6, col: 2 }],
      }),
      seg(3, { kind: "table", table: 1, row: 3 }, "줄 간격 160%", {
        split: true,
        marks: [{ start: 0, end: 9, col: 3 }],
      }),
    ];
    const cols = columns(cellsOf([items[0]!, items[2]!, items[3]!]))!;
    expect(cols.map((c) => c.map((x) => x.seq))).toEqual([[], [0, 2], [3]]);
    const html = renderToStaticMarkup(createElement(FileBody, { file, items, target: null }));
    expect(html).toContain("글꼴 11pt");
    expect(html).toContain("각주 뒤 글");
    expect(html.indexOf("글꼴 11pt")).toBeLessThan(html.indexOf("각주 뒤 글"));
    expect(html).toContain("본문 글꼴 기준.");
  });
});

describe("review #123 2차", () => {
  it("[P2 3] a piece that lost its columns (secret split into the footnote) is drawn with the rest — no served text dropped", () => {
    // The shape `/view` serves for it (apps/server/test/file-viewer.test.ts "[P2 3 2차]").
    const items = [
      seg(0, { kind: "table", table: 1, row: 1 }, "앞의 공개 문장 [숨김]", {
        split: true,
        approximate: true,
      }),
      seg(1, { kind: "table", table: 1, row: 1, footnote: 1 }, "[숨김]"),
      seg(2, { kind: "table", table: 1, row: 1 }, "뒤의 공개 문장", {
        split: true,
        marks: [{ start: 0, end: 8, col: 1 }],
      }),
    ];
    const html = renderToStaticMarkup(createElement(FileBody, { file, items, target: null }));
    expect(html).toContain("앞의 공개 문장 [숨김]");
    expect(html).toContain("뒤의 공개 문장");
    expect(html.indexOf("앞의 공개 문장")).toBeLessThan(html.indexOf("뒤의 공개 문장"));
  });
});

describe("review #123 3차: paging after a visit, and a failed window", () => {
  const ALL = 100;
  const LIMIT = 10;
  /** The server's windows (`viewWindow`) over `text(seq)`; `fail(o)` answers 500 for that request. */
  const server = (text: (seq: number) => string, fail: (o: object) => boolean = () => false) => {
    const fetch: ViewFetch = async (o) => {
      if (fail(o)) throw new Error("500");
      const start = o.from ?? (o.loc ? 30 : 0);
      let end = Math.min(ALL, start + LIMIT);
      if (o.to !== undefined) end = Math.max(start, Math.min(end, o.to));
      return {
        file,
        extract: {
          fileId: "f1",
          fileRevision: REV,
          status: "ok",
          code: null,
          ocr: "none",
          units: ALL,
          segments: ALL,
          characters: 1,
          truncated: false,
        },
        items: Array.from({ length: end - start }, (_, i) =>
          seg(start + i, { kind: "slide", slide: start + i + 1 }, text(start + i)),
        ),
        prev: start > 0 ? Math.max(0, start - LIMIT) : null,
        next: end < ALL ? end : null,
        target: null,
      };
    };
    return fetch;
  };
  const loc: FileLocator = { ...base, kind: "slide", slide: 31 };
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it("[P2 1] leave and come back after the text changed: no window of the earlier visit is shown", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 5_000 } } });
    let version = "old [비밀값]";
    const fetch = server((n) => `${version} ${n}`);
    // First visit: the opening window and one window before it.
    const o1 = new QueryObserver(client, openingQuery("f1", loc, fetch));
    const u1 = o1.subscribe(() => {});
    const first = (await o1.refetch()).data!;
    const b1 = new InfiniteQueryObserver(client, pagingQuery("before", "f1", loc, first, fetch, true));
    const u2 = b1.subscribe(() => {});
    await b1.refetch();
    expect(b1.getCurrentResult().data!.pages[0]!.items[0]!.text).toBe("old [비밀값] 20");
    u1();
    u2();
    await tick();
    // The text changed on the server (a secret registered since is hidden now).
    version = "new [숨김]";
    // Second visit, same file and place: nothing of the first visit is kept or shown.
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    const o2 = new QueryObserver(client, openingQuery("f1", loc, fetch));
    const u3 = o2.subscribe(() => {});
    const again = (await o2.refetch()).data!;
    const b2 = new InfiniteQueryObserver(client, pagingQuery("before", "f1", loc, again, fetch, false));
    const u4 = b2.subscribe(() => {});
    const shown = combine([...shownPages(false, b2.getCurrentResult()), again]);
    expect(shown.map((x) => x.text).some((t) => t.startsWith("old"))).toBe(false);
    expect(shown.map((x) => x.seq)).toEqual(Array.from({ length: 10 }, (_, i) => 30 + i));
    // Even a paging query left in the cache is not shown until asked on this visit.
    expect(shownPages(false, { data: { pages: [first] }, hasNextPage: true, isError: false })).toEqual([]);
    u3();
    u4();
    client.clear();
  });

  it("[P2 2] the first window before fails (500): the button stays, says 다시 시도, and retries", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let failing = true;
    const fetch = server(
      (n) => `x ${n}`,
      (o) => failing && "to" in o && (o as { to?: number }).to !== undefined,
    );
    const o = new QueryObserver(client, openingQuery("f1", loc, fetch));
    const u1 = o.subscribe(() => {});
    const first = (await o.refetch()).data!;
    const b = new InfiniteQueryObserver(client, pagingQuery("before", "f1", loc, first, fetch, true));
    const u2 = b.subscribe(() => {});
    await b.refetch();
    let r = b.getCurrentResult();
    expect([r.isError, r.data, r.hasNextPage]).toEqual([true, undefined, false]);
    // Still offered (the opening window says there is more), as a retry of that first window.
    expect(hasMore("before", first, true, r)).toBe(true);
    expect(moreAction(true, r)).toBe("retry");
    failing = false;
    await b.refetch();
    r = b.getCurrentResult();
    expect(r.data!.pages[0]!.items.map((x) => x.seq)).toEqual(Array.from({ length: 10 }, (_, i) => 20 + i));
    expect(moreAction(true, r)).toBe("next");
    // A later window failing keeps the button too.
    expect(hasMore("before", first, true, { ...r, hasNextPage: false, isError: true })).toBe(true);
    u1();
    u2();
    client.clear();
  });
});

describe("rendering the file", () => {
  it("HWP 3번째 표 · 2행: the row is the unit, its cell underlined, the passage marked — file text as text", () => {
    const items = [
      seg(0, { kind: "paragraph", paragraph: 1 }, "<script>window.__x=1</script> 안내"),
      seg(1, { kind: "table", table: 3, row: 1 }, "항목 | 안내", {
        marks: [
          { start: 0, end: 2, col: 1 },
          { start: 5, end: 7, col: 2 },
        ],
      }),
      seg(2, { kind: "table", table: 3, row: 2 }, "제출 방법 | 학교 누리집 과제방에 PDF로 올립니다.", {
        marks: [
          { start: 0, end: 5, col: 1 },
          { start: 8, end: 30, col: 2 },
        ],
      }),
    ];
    const target: ViewTarget = {
      status: "exact",
      reasons: [],
      seqs: [2],
      range: { seq: 2, start: 8, end: 30 },
      focus: { seq: 2, start: 8, end: 30 },
    };
    const html = renderToStaticMarkup(createElement(FileBody, { file, items, target }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toMatch(/<tr class="fv-unit" data-row="2" data-target="1" data-testid="file-view-unit"/);
    expect(html).toContain('class="fv-cell-focus"');
    expect(html).toMatch(
      /<mark class="fv-hit fv-focus" data-testid="file-view-hit">학교 누리집 과제방에 PDF로 올립니다\.<\/mark>/,
    );
    expect(html.match(/file-view-unit/g)).toHaveLength(1);
  });

  it("a page: the passage's box on the page map only when exact; a unit target marks the page, no box", () => {
    const page = seg(0, { kind: "page", page: 12 }, "Report page 12\nSummary", {
      marks: [
        { start: 0, end: 14, bbox: [0.1, 0.1, 0.5, 0.02] },
        { start: 15, end: 22, bbox: [0.1, 0.13, 0.3, 0.02] },
      ],
    });
    const exact: ViewTarget = {
      status: "exact",
      reasons: [],
      seqs: [0],
      range: { seq: 0, start: 15, end: 22 },
      bbox: [0.1, 0.13, 0.3, 0.02],
    };
    const html = renderToStaticMarkup(createElement(FileBody, { file, items: [page], target: exact }));
    expect(html).toContain('data-testid="file-view-box-hit"');
    expect(html).toContain('data-page="12"');
    expect(html).toContain(">Summary</mark>");
    const unit: ViewTarget = { status: "unit", reasons: ["unverified"], seqs: [0] };
    const u = renderToStaticMarkup(createElement(FileBody, { file, items: [page], target: unit }));
    expect(u).not.toContain("file-view-box-hit");
    expect(u).not.toContain("file-view-hit");
    expect(u).toContain('data-testid="file-view-unit"');
    const none: ViewTarget = { status: "not_found", reasons: ["unit_missing"], seqs: [] };
    expect(
      renderToStaticMarkup(createElement(FileBody, { file, items: [page], target: none })),
    ).not.toContain("file-view-unit");
  });

  it("an image: the picture from the inline route under the OCR boxes", () => {
    const img = { ...file, kind: "png" as const, name: "사진.png", mediaType: "image/png" };
    const s = seg(0, { kind: "ocr_box" }, "영수증 합계", {
      marks: [{ start: 0, end: 3, bbox: [0.1, 0.5, 0.2, 0.1] }],
    });
    const html = renderToStaticMarkup(createElement(FileBody, { file: img, items: [s], target: null }));
    expect(html).toContain('src="/api/files/f1/content?inline=1"');
  });
});
