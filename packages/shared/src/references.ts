import { z } from "zod";
import { CitationStatus } from "./citations.js";

/**
 * 참고문헌 내보내기 (#26, PRD FR-5.6): the sources a conversation's answers cited — web pages and (once #48's file
 * citations land) uploaded files — gathered once each, written in a citation style and copied or downloaded
 * (`.txt`, `.docx` through the #49 document worker).
 *
 * This file holds the data contract and the formatters. They are pure: the server gathers, de-duplicates and scrubs
 * the sources (apps/server/src/references), and the formatters only arrange fields that are already plain text.
 *
 * Style choices (docs/ops.md §31):
 * - The sources carry no author (pages are stored without one), so every web entry is the "no author" form of its
 *   style: the title takes the author's place (APA 7 §9.12), MLA 9 starts with the title. When an author is given
 *   it is written **as given** — names are never re-ordered or abbreviated (a Korean name stays "홍길동"; a Latin
 *   name cannot be split reliably, so it is not inverted either).
 * - Titles keep the source's own casing in every style — no sentence case (APA) or title case (MLA): without
 *   reliable proper-noun data either would damage names. Korean and English titles alike.
 * - APA and MLA dates are written the English way ("2026, November 10" / "10 Nov. 2026"), the school format the
 *   Korean way ("2026. 11. 10."). A publication date is the day the source states (in its own offset); the access
 *   date is the fetch time in the user's time zone.
 * - APA never writes "Retrieved …, from" (whether a page is "designed to change" is not known); MLA always writes
 *   "Accessed …" and drops the URL's `https://` (MLA 9 §5.93); the school format always has its access date.
 * - Plain text has no italics: the titles APA and MLA set in italics are plain in every output.
 * - Order: APA and MLA alphabetically (Korean entries first, then the others — the usual order of Korean reports),
 *   leading quotes and English articles ignored; the school format keeps the order sources were first cited and
 *   numbers them.
 */

export const REFERENCE_STYLES = ["apa", "mla", "school"] as const;
export const ReferenceStyle = z.enum(REFERENCE_STYLES);
export type ReferenceStyle = z.infer<typeof ReferenceStyle>;

export const REFERENCE_STYLE_LABEL: Record<ReferenceStyle, string> = {
  apa: "APA 7",
  mla: "MLA 9",
  school: "학교용 간단 형식",
};

export const REFERENCE_FORMATS = ["txt", "docx"] as const;
export const ReferenceFormat = z.enum(REFERENCE_FORMATS);
export type ReferenceFormat = z.infer<typeof ReferenceFormat>;

export const REFERENCE_LIMITS = {
  /** Entries one export lists (the document worker's `references` limit). */
  entries: 200,
  title: 300,
  site: 120,
  url: 2048,
  author: 200,
  /** Place labels of one file ("3쪽", "시트 1") and the length of each. */
  locators: 20,
  locator: 60,
} as const;

/** `YYYY`, `YYYY-MM` or `YYYY-MM-DD` — the only date form the formatters take (the server converts). */
/** A real calendar date: `y`, `y-m` or `y-m-d` (2026-02-31 is not one; leap years counted). */
export function isRealDate(y: number, m?: number, d?: number): boolean {
  if (!Number.isInteger(y) || y < 1 || y > 9999) return false;
  if (m === undefined) return d === undefined;
  if (!Number.isInteger(m) || m < 1 || m > 12) return false;
  if (d === undefined) return true;
  const days = new Date(Date.UTC(2000 + (y % 400), m, 0)).getUTCDate();
  return Number.isInteger(d) && d >= 1 && d <= days;
}

const DATE_FORM = /^(\d{4})(?:-(0[1-9]|1[0-2])(?:-(0[1-9]|[12]\d|3[01]))?)?$/;
/** `YYYY`, `YYYY-MM` or `YYYY-MM-DD`, a real date — the only date form the formatters take (the server converts). */
export const ReferenceDate = z.string().refine((v) => {
  const m = DATE_FORM.exec(v);
  return !!m && isRealDate(Number(m[1]), m[2] ? Number(m[2]) : undefined, m[3] ? Number(m[3]) : undefined);
});

/**
 * One source as the formatters get it. Every string is already plain text (no control characters, one line) and
 * scrubbed of known secrets by the server. `verified`: at least one citation of it was checked against the stored
 * text (`status` is then `verified`; otherwise the status of its latest citation).
 */
export const ReferenceSource = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("web"),
    author: z.string().max(REFERENCE_LIMITS.author).nullable(),
    title: z.string().min(1).max(REFERENCE_LIMITS.title),
    site: z.string().max(REFERENCE_LIMITS.site).nullable(),
    /** http(s) only; null when the stored address was not one. */
    url: z.string().max(REFERENCE_LIMITS.url).nullable(),
    publishedAt: ReferenceDate.nullable(),
    accessedAt: ReferenceDate.nullable(),
    verified: z.boolean(),
    status: CitationStatus,
  }),
  /** An uploaded file (#48): its name, and the places cited in it (page or sheet labels), in first-cited order. */
  z.object({
    kind: z.literal("file"),
    fileName: z.string().min(1).max(REFERENCE_LIMITS.title),
    locators: z.array(z.string().max(REFERENCE_LIMITS.locator)).max(REFERENCE_LIMITS.locators),
    verified: z.boolean(),
    status: CitationStatus,
  }),
]);
export type ReferenceSource = z.infer<typeof ReferenceSource>;

/** `GET /api/conversations/:id/references` query (`download` takes `format` too). */
export const ReferencesQuery = z.object({
  style: ReferenceStyle.default("apa"),
  /** "1": sources whose citations all failed the check are listed too (off by default). */
  includeUnverified: z.enum(["0", "1"]).default("0"),
});
export const ReferencesDownloadQuery = ReferencesQuery.extend({ format: ReferenceFormat.default("txt") });

export const ReferenceItem = z.object({
  /** Opaque, stable within the conversation (a hash — never the address itself). */
  id: z.string(),
  kind: z.enum(["web", "file"]),
  verified: z.boolean(),
  status: CitationStatus,
  /** In the copied text and the downloads (false: a failed source while the toggle is off). */
  included: z.boolean(),
  /** The entry in the chosen style (as copied; the school format's number included). */
  text: z.string(),
});
export type ReferenceItem = z.infer<typeof ReferenceItem>;

export const ReferencesResponse = z.object({
  style: ReferenceStyle,
  includeUnverified: z.boolean(),
  /** Included entries first, in the style's order; then the excluded ones (shown, marked, not copied). */
  items: z.array(ReferenceItem),
  /** What 복사 copies and `.txt` holds: the included entries, one per line. Empty when there are none. */
  text: z.string(),
  /** Sources left out because none of their citations verified (0 when the toggle is on). */
  excluded: z.number().int().nonnegative(),
  /** More sources than `REFERENCE_LIMITS.entries`: the rest are not listed. */
  truncated: z.boolean(),
});
export type ReferencesResponse = z.infer<typeof ReferencesResponse>;

export const REFERENCE_ERRORS = {
  references_empty: "내보낼 출처가 없어요.",
  references_busy: "다른 내보내기가 진행 중이에요. 잠시 후 다시 해 주세요.",
  references_unavailable: "지금은 .docx 파일을 만들 수 없어요. 복사나 .txt를 써 주세요.",
  references_retry: "출처 정보가 바뀌는 중이에요. 잠시 후 다시 내려받아 주세요.",
} as const;

/** Document title of the `.docx` (and the downloads' file name before the date). */
export const REFERENCES_TITLE = "참고문헌";

// ---- the formatters ------------------------------------------------------------------------------------------

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
/** MLA 9 abbreviations (May, June and July are written out). */
const MLA_MONTHS = [
  "Jan.",
  "Feb.",
  "Mar.",
  "Apr.",
  "May",
  "June",
  "July",
  "Aug.",
  "Sept.",
  "Oct.",
  "Nov.",
  "Dec.",
];

type DateParts = { y: number; m?: number; d?: number };
function parts(date: string | null): DateParts | null {
  const m = date ? /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(date) : null;
  if (!m) return null;
  return {
    y: Number(m[1]),
    ...(m[2] ? { m: Number(m[2]) } : {}),
    ...(m[3] ? { d: Number(m[3]) } : {}),
  };
}

/** APA: "2026, November 10" / "2026, November" / "2026"; null for no date. */
function apaDate(p: DateParts): string {
  if (p.m === undefined) return String(p.y);
  return `${p.y}, ${MONTHS[p.m - 1]}${p.d !== undefined ? ` ${p.d}` : ""}`;
}
/** MLA: "10 Nov. 2026" / "Nov. 2026" / "2026". */
const mlaDate = (p: DateParts) =>
  `${p.d !== undefined ? `${p.d} ` : ""}${p.m !== undefined ? `${MLA_MONTHS[p.m - 1]} ` : ""}${p.y}`;
/** Korean: "2026. 11. 10." / "2026. 11." / "2026.". */
const koDate = (p: DateParts) =>
  `${p.y}.${p.m !== undefined ? ` ${p.m}.` : ""}${p.d !== undefined ? ` ${p.d}.` : ""}`;

/** A sentence part ends with one mark: "Title." but "Why now?" (no "Why now?."). */
const end = (s: string) => (/[.?!。？！]$/u.test(s) ? s : `${s}.`);

const apaLocators = (l: readonly string[]) => (l.length ? `; ${l.join(", ")}` : "");

function apa(s: ReferenceSource): string {
  if (s.kind === "file") return `${s.fileName} [Unpublished document${apaLocators(s.locators)}]. (n.d.).`;
  // Titles keep the source's own casing (no sentence case — names cannot be told apart, ops §31.2).
  const date = parts(s.publishedAt);
  const when = `(${date ? apaDate(date) : "n.d."}).`;
  const lead = s.author ? `${end(s.author)} ${when} ${end(s.title)}` : `${end(s.title)} ${when}`;
  // The site name is left out when it is the author or the title (APA 7 §9.13).
  const site = s.site && s.site !== s.author && s.site !== s.title ? ` ${end(s.site)}` : "";
  // No "Retrieved …, from": nothing says whether a page is meant to change (APA 7 §9.16), so it is never written.
  const url = s.url ? ` ${s.url}` : "";
  return `${lead}${site}${url}`;
}

/** "https://www.example.com/a" → "www.example.com/a" (MLA 9 leaves the scheme out). */
const mlaUrl = (u: string) => u.replace(/^https?:\/\//i, "");

function mla(s: ReferenceSource): string {
  if (s.kind === "file")
    return `${end(s.fileName)} Unpublished document${s.locators.length ? `, ${s.locators.join(", ")}` : ""}.`;
  // `"Title." ` — the closing mark goes inside the quotes; a title ending in ? or ! keeps its own.
  const quoted = /[.?!。？！]$/u.test(s.title) ? `"${s.title}"` : `"${s.title}."`;
  const items: string[] = [];
  if (s.site && s.site !== s.author && s.site !== s.title) items.push(s.site);
  const date = parts(s.publishedAt);
  if (date) items.push(mlaDate(date));
  if (s.url) items.push(mlaUrl(s.url));
  const accessed = parts(s.accessedAt);
  const body = items.length ? ` ${items.join(", ")}.` : "";
  return `${s.author ? `${end(s.author)} ` : ""}${quoted}${body}${accessed ? ` Accessed ${mlaDate(accessed)}.` : ""}`;
}

/** 저자·제목·사이트·날짜·URL·접속일 — a missing field says so, so every entry has the same six parts. */
function school(s: ReferenceSource): string {
  if (s.kind === "file")
    return `${s.fileName} (업로드한 파일${s.locators.length ? `, ${s.locators.join(", ")}` : ""})`;
  const date = parts(s.publishedAt);
  const accessed = parts(s.accessedAt);
  const fields = [
    s.author ?? "저자 미상",
    `「${s.title}」`,
    s.site ?? "사이트 미상",
    date ? koDate(date) : "날짜 없음",
    ...(s.url ? [s.url] : []),
  ];
  return `${fields.join(", ")}${accessed ? ` (접속일: ${koDate(accessed)})` : ""}`;
}

const FORMAT: Record<ReferenceStyle, (s: ReferenceSource) => string> = { apa, mla, school };

/** One source in one style (the school format's number is added by `formatReferences`). */
export const formatReference = (style: ReferenceStyle, s: ReferenceSource): string => FORMAT[style](s);

const ko = new Intl.Collator("ko", { sensitivity: "base", numeric: true });
/** What an entry is alphabetised by: its first words, without quotes, brackets and a leading English article. */
const sortKey = (text: string) =>
  text
    .replace(/^[\s"'“‘「『(<[]+/u, "")
    .replace(/^(?:a|an|the)\s+/i, "")
    .trim();
/** Korean when the first letter is Hangul ("10월 …" is Korean too). */
const hangulFirst = (k: string) => (/^\P{L}*[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/u.test(k) ? 0 : 1);

/**
 * The sources in one style, in the style's order: `{ index, text }` with `index` the source's place in `sources`
 * (first-cited order). APA and MLA: alphabetical, Korean first. School: first-cited order, numbered "1. ".
 */
export function formatReferences(
  style: ReferenceStyle,
  sources: readonly ReferenceSource[],
): { index: number; text: string }[] {
  const out = sources.map((s, index) => ({ index, text: formatReference(style, s) }));
  if (style === "school") return out.map((e, i) => ({ ...e, text: `${i + 1}. ${e.text}` }));
  return out.sort((a, b) => {
    const ka = sortKey(a.text);
    const kb = sortKey(b.text);
    return hangulFirst(ka) - hangulFirst(kb) || ko.compare(ka, kb) || a.index - b.index;
  });
}
