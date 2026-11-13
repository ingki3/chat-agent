import { describe, expect, it } from "vitest";
import {
  ReferenceDate,
  ReferenceSource,
  isRealDate,
  formatReference,
  formatReferences,
  type ReferenceStyle,
} from "../src/index.js";

/**
 * Reference formatters (#26, PRD FR-5.6): one snapshot per style over the same sources — Korean and English pages,
 * with and without a date, a title ending in "?", an author given as written (a Korean name, never re-ordered),
 * no site, and an uploaded file with its cited places (#48).
 */

const web = (s: Partial<Extract<ReferenceSource, { kind: "web" }>>): ReferenceSource => ({
  kind: "web",
  author: null,
  title: "제목",
  site: null,
  url: null,
  publishedAt: null,
  accessedAt: "2026-11-13",
  verified: true,
  status: "verified",
  ...s,
});

const SOURCES: ReferenceSource[] = [
  web({
    title: "10월 반도체 수출 32% 증가",
    site: "가나다 신문",
    url: "https://fixture.agentlee.test/news/chips-a.html",
    publishedAt: "2026-11-10",
  }),
  web({
    title: "The Future Of AI Chips: What Comes Next For iPhone Makers",
    site: "Tech Weekly",
    url: "https://www.techweekly.example/ai-chips",
    publishedAt: "2026-10",
  }),
  web({
    title: "Semiconductor Export Statistics",
    site: "Korea Trade Data",
    url: "https://data.example.org/stats?year=2026",
  }),
  web({
    title: "Is the chip boom over?",
    site: "The Daily",
    url: "https://daily.example/boom",
    publishedAt: "2025",
  }),
  web({
    author: "홍길동",
    title: "청소년을 위한 경제 이야기",
    site: "라마바 블로그",
    url: "https://blog.example.kr/econ",
    publishedAt: "2026-03-05",
  }),
  web({ title: "World Health Organization", site: "World Health Organization", url: "https://who.example/" }),
  web({ title: "사이트 이름 없는 페이지", url: "https://nosite.example/p", accessedAt: null }),
  {
    kind: "file",
    fileName: "과학 보고서 자료.pdf",
    locators: ["3쪽", "5쪽"],
    verified: true,
    status: "verified",
  },
];

for (const s of SOURCES) ReferenceSource.parse(s);

const run = (style: ReferenceStyle) =>
  formatReferences(style, SOURCES)
    .map((e) => e.text)
    .join("\n");

describe("formats (snapshots)", () => {
  it("APA 7", () => {
    // Derived from the rules (ops §31.2): the source's casing kept, no "Retrieved", Korean entries first.
    expect(run("apa")).toMatchInlineSnapshot(`
      "10월 반도체 수출 32% 증가. (2026, November 10). 가나다 신문. https://fixture.agentlee.test/news/chips-a.html
      과학 보고서 자료.pdf [Unpublished document; 3쪽, 5쪽]. (n.d.).
      사이트 이름 없는 페이지. (n.d.). https://nosite.example/p
      홍길동. (2026, March 5). 청소년을 위한 경제 이야기. 라마바 블로그. https://blog.example.kr/econ
      The Future Of AI Chips: What Comes Next For iPhone Makers. (2026, October). Tech Weekly. https://www.techweekly.example/ai-chips
      Is the chip boom over? (2025). The Daily. https://daily.example/boom
      Semiconductor Export Statistics. (n.d.). Korea Trade Data. https://data.example.org/stats?year=2026
      World Health Organization. (n.d.). https://who.example/"
    `);
  });

  it("MLA 9", () => {
    expect(run("mla")).toMatchInlineSnapshot(`
      ""10월 반도체 수출 32% 증가." 가나다 신문, 10 Nov. 2026, fixture.agentlee.test/news/chips-a.html. Accessed 13 Nov. 2026.
      과학 보고서 자료.pdf. Unpublished document, 3쪽, 5쪽.
      "사이트 이름 없는 페이지." nosite.example/p.
      홍길동. "청소년을 위한 경제 이야기." 라마바 블로그, 5 Mar. 2026, blog.example.kr/econ. Accessed 13 Nov. 2026.
      "The Future Of AI Chips: What Comes Next For iPhone Makers." Tech Weekly, Oct. 2026, www.techweekly.example/ai-chips. Accessed 13 Nov. 2026.
      "Is the chip boom over?" The Daily, 2025, daily.example/boom. Accessed 13 Nov. 2026.
      "Semiconductor Export Statistics." Korea Trade Data, data.example.org/stats?year=2026. Accessed 13 Nov. 2026.
      "World Health Organization." who.example/. Accessed 13 Nov. 2026."
    `);
  });

  it("학교용 간단 형식 (저자·제목·사이트·날짜·URL·접속일), first-cited order", () => {
    expect(run("school")).toMatchInlineSnapshot(`
      "1. 저자 미상, 「10월 반도체 수출 32% 증가」, 가나다 신문, 2026. 11. 10., https://fixture.agentlee.test/news/chips-a.html (접속일: 2026. 11. 13.)
      2. 저자 미상, 「The Future Of AI Chips: What Comes Next For iPhone Makers」, Tech Weekly, 2026. 10., https://www.techweekly.example/ai-chips (접속일: 2026. 11. 13.)
      3. 저자 미상, 「Semiconductor Export Statistics」, Korea Trade Data, 날짜 없음, https://data.example.org/stats?year=2026 (접속일: 2026. 11. 13.)
      4. 저자 미상, 「Is the chip boom over?」, The Daily, 2025., https://daily.example/boom (접속일: 2026. 11. 13.)
      5. 홍길동, 「청소년을 위한 경제 이야기」, 라마바 블로그, 2026. 3. 5., https://blog.example.kr/econ (접속일: 2026. 11. 13.)
      6. 저자 미상, 「World Health Organization」, World Health Organization, 날짜 없음, https://who.example/ (접속일: 2026. 11. 13.)
      7. 저자 미상, 「사이트 이름 없는 페이지」, 사이트 미상, 날짜 없음, https://nosite.example/p
      8. 과학 보고서 자료.pdf (업로드한 파일, 3쪽, 5쪽)"
    `);
  });
});

describe("rules", () => {
  it("titles keep the source's own casing in every style (no sentence or title case)", () => {
    for (const title of [
      "How To Read A Balance Sheet",
      "exports from Seoul rose",
      "반도체 Market Report 2026",
    ]) {
      const s = web({ title, site: "Site", url: "https://a.example/" });
      expect(formatReference("apa", s).startsWith(`${title}. `)).toBe(true);
      expect(formatReference("mla", s).startsWith(`"${title}."`)).toBe(true);
      expect(formatReference("school", s)).toContain(`「${title}」`);
    }
  });

  it('APA never writes "Retrieved", with or without a date; MLA and the school format keep the access date', () => {
    const undated = web({ title: "T", site: "S", url: "https://a.example/" });
    expect(formatReference("apa", undated)).toBe("T. (n.d.). S. https://a.example/");
    expect(formatReference("apa", { ...undated, publishedAt: "2026-01-02" } as ReferenceSource)).toBe(
      "T. (2026, January 2). S. https://a.example/",
    );
    expect(formatReference("mla", undated)).toContain("Accessed 13 Nov. 2026.");
    expect(formatReference("school", undated)).toContain("(접속일: 2026. 11. 13.)");
  });

  it("dates are real calendar dates", () => {
    expect(isRealDate(2026, 2, 28)).toBe(true);
    expect(isRealDate(2026, 2, 29)).toBe(false);
    expect(isRealDate(2024, 2, 29)).toBe(true);
    expect(isRealDate(2100, 2, 29)).toBe(false);
    expect(isRealDate(2000, 2, 29)).toBe(true);
    expect(isRealDate(2026, 4, 31)).toBe(false);
    expect(ReferenceDate.safeParse("2026-02-31").success).toBe(false);
    expect(ReferenceDate.safeParse("2026-12-31").success).toBe(true);
    expect(ReferenceDate.safeParse("2026-13").success).toBe(false);
  });

  it("names are written as given — a Korean name is never inverted or abbreviated", () => {
    const s = web({ author: "김민수", title: "글", site: "사이트", url: "https://a.example/" });
    expect(formatReference("apa", s)).toMatch(/^김민수\. /);
    expect(formatReference("mla", s)).toMatch(/^김민수\. /);
    expect(formatReference("school", s)).toMatch(/^김민수, /);
  });

  it("one closing mark: no period after ? or ! or an existing period", () => {
    const s = web({ title: "Really!", site: "Site", url: "https://a.example/x", publishedAt: "2026-01-02" });
    expect(formatReference("apa", s)).toBe("Really! (2026, January 2). Site. https://a.example/x");
    expect(formatReference("mla", s)).toBe(
      '"Really!" Site, 2 Jan. 2026, a.example/x. Accessed 13 Nov. 2026.',
    );
  });

  it("APA/MLA order: Korean first, then the rest, leading quotes and articles ignored", () => {
    const list = [
      web({ title: "The Zebra Report", url: "https://z.example/" }),
      web({ title: "An Apple Study", url: "https://a.example/" }),
      web({ title: "나비 이야기", url: "https://n.example/" }),
      web({ title: "가지 이야기", url: "https://g.example/" }),
    ];
    expect(formatReferences("apa", list).map((e) => e.index)).toEqual([3, 2, 1, 0]);
    expect(formatReferences("mla", list).map((e) => e.index)).toEqual([3, 2, 1, 0]);
    expect(formatReferences("school", list).map((e) => e.index)).toEqual([0, 1, 2, 3]);
  });
});
