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
