import { z } from "zod";

/**
 * A web source of a conversation (#50, PRD FR-5.1): a page a run fetched, or a search result it saw. The list is
 * what the source panel and citations (#25) show; the stored page text stays on the server (the citation check
 * reads it there), so it is not part of this shape.
 */
export const Source = z.object({
  id: z.string(),
  runId: z.string(),
  kind: z.enum(["page", "search"]),
  provider: z.string(),
  url: z.string(),
  finalUrl: z.string().nullable(),
  title: z.string(),
  site: z.string(),
  publishedAt: z.string().nullable(),
  fetchedAt: z.number(),
  contentType: z.string().nullable(),
  bodyHash: z.string().nullable(),
  /** Characters of stored text (0 for search results). */
  characters: z.number().int().nonnegative(),
  truncated: z.boolean(),
  snippet: z.string().nullable(),
});
export type Source = z.infer<typeof Source>;

export const SourcesResponse = z.object({ items: z.array(Source) });
export type SourcesResponse = z.infer<typeof SourcesResponse>;

/**
 * What kind of publisher an address belongs to, by its domain alone (#234 — primary sources first): `government`
 * (`go.kr`, `gov`, `gov.uk`, `mil`, `europa.eu` …), `academic` (`ac.kr`, `edu`, `ac.uk`, Korean research institutes
 * `re.kr`), `organization` (`or.kr`, `org` — public bodies and associations, but anyone can register `.org`) or
 * `other`. A hint for the researcher and the report, never a check: a domain says nothing about a page's accuracy.
 */
export const SourceType = z.enum(["government", "academic", "organization", "other"]);
export type SourceType = z.infer<typeof SourceType>;

export function sourceTypeOf(url: string): SourceType {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "other";
  }
  const labels = host.split(".");
  const tld = labels.at(-1) ?? "";
  const sld = labels.at(-2) ?? "";
  if (labels.length < 2) return "other";
  // A second-level label counts under a country code only (`go.kr`, `ac.uk` — not `ac.example.com`), the registry
  // domain itself (`gov.uk`, `go.kr`) included.
  const cc = /^[a-z]{2}$/.test(tld);
  // `gov`, `mil`; `go.kr`, `gov.uk`, `gouv.fr`, `gob.mx`, `govt.nz`; `europa.eu`; `int` (treaty organisations).
  if (tld === "gov" || tld === "mil" || tld === "int") return "government";
  if (cc && ["go", "gov", "gouv", "gob", "govt", "mil"].includes(sld)) return "government";
  if (sld === "europa" && tld === "eu") return "government";
  if (tld === "edu") return "academic";
  if (cc && ["ac", "edu", "re"].includes(sld)) return "academic";
  if (tld === "org" || (cc && sld === "or")) return "organization";
  return "other";
}
