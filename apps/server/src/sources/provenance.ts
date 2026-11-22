import { skillToolName } from "@agentlee/mcp-tools";
import { GOOGLE_NEWS_SKILL, SEARCH_GOOGLE_SKILL } from "@agentlee/mcp-tools/skills";
import {
  CITE_TOOL,
  SOURCES_LIST_TOOL,
  WEB_FETCH_TOOL,
  WEB_FIND_TOOL,
  WEB_SEARCH_TOOL,
} from "@agentlee/mcp-tools/web";
import { FILE_CITE_TOOL, FILE_READ_TOOL, FILE_SEARCH_TOOL } from "@agentlee/mcp-tools/files";
import type { MessagePart } from "@agentlee/shared";
import { isFinanceTool } from "../instructions/assemble.js";
import { OUR_TOOL_PREFIX } from "../runtime/lockdown.js";

/**
 * Where an answer's sources come from (#185, docs/decisions/sources.md): **the tools the answer called**, never its
 * text. A source is the record of a tool result that brought outside data into the answer:
 * - `web` — a page or search result (`web_search`, `web_fetch`, `web_find`, `sources_list`, `cite`, the search/news
 *   skills);
 *   stored in `sources`, cited by number (`[n]`, the server checks the quoted passage);
 * - `file` — an uploaded file of the conversation (`file_read`, `file_search`, `file_cite`; an audio transcript is a
 *   file too — `audio_transcribe` writes it, `file_cite` cites it); cited by number with its place;
 * - `finance` — a finance tool's stamped values (`kr_*`, `us_*`, `fx_*`, `dart_*`, `sec_*`, the finance skills):
 *   provider, as-of time and zone, delayed or not, kind — listed with that as-of time, not numbered.
 * The source note under an answer (RunManager `attachNoteTo`: `financeNote`, `citationNote`) is attached only for
 * the kinds this answer used (or for numbers it carries over from the answer before, checked again).
 */
export type SourceKind = "web" | "file" | "finance";

const BY_NAME: ReadonlyMap<string, SourceKind> = new Map([
  [WEB_SEARCH_TOOL.name, "web"],
  [WEB_FETCH_TOOL.name, "web"],
  // #234: passages of a fetched page (numbered `[1]`… like a list).
  [WEB_FIND_TOOL.name, "web"],
  [SOURCES_LIST_TOOL.name, "web"],
  [CITE_TOOL.name, "web"],
  [skillToolName(GOOGLE_NEWS_SKILL.name), "web"],
  [skillToolName(SEARCH_GOOGLE_SKILL.name), "web"],
  [FILE_READ_TOOL.name, "file"],
  [FILE_SEARCH_TOOL.name, "file"],
  [FILE_CITE_TOOL.name, "file"],
]);

const bare = (name: string) => (name.startsWith(OUR_TOOL_PREFIX) ? name.slice(OUR_TOOL_PREFIX.length) : name);

/** The kind of source a tool's result is, or undefined for a tool that brings in no source. */
export function sourceKindOf(name: string): SourceKind | undefined {
  return BY_NAME.get(bare(name)) ?? (isFinanceTool(name) ? "finance" : undefined);
}

/** The source kinds of the tools this answer called (a refused or failed call counts: it was used). */
export function usedSourceKinds(parts: readonly MessagePart[]): Set<SourceKind> {
  const kinds = new Set<SourceKind>();
  for (const p of parts)
    if (p.type === "tool_call") {
      const k = sourceKindOf(p.name);
      if (k) kinds.add(k);
    }
  return kinds;
}
