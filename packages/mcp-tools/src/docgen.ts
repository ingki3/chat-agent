import { z } from "zod";
import { DOC_KINDS, DOC_LIMITS, DOC_REFUSED_KINDS, DocBlock } from "@agentlee/shared";
import type { ServerToolInfo } from "./index.js";

/**
 * Document generation tool of the common MCP server (#49, PRD FR-4.4·4.7·5.6): what the model sees. How the file is
 * made (a sandboxed worker with pinned libraries), checked and stored (the conversation's files, #22) is the host's
 * business (apps/server docgen). The scope — whose file, which conversation, which run — comes from the run's token.
 */
export const DOC_CREATE_TOOL: ServerToolInfo = {
  name: "doc_create",
  description:
    "Makes a downloadable document file from structured blocks and stores it with this conversation's files: kind docx (Word report), xlsx (Excel: each table becomes its own sheet), pptx (slides: the title slide, then a slide per heading; each table and image gets its own slide) or pdf. HWP/HWPX cannot be made — offer docx or pdf. Blocks, in order: heading (text, level 1-3), paragraph (text), list (items, ordered), table (columns, rows of cells — string, number or null; each row as long as columns; caption), image (fileId of a PNG/JPG file of this conversation that the user sent; never a URL), references (items, e.g. APA entries; title). Returns fileId, name, url (download) and `document` — pass that to artifact_create with kind document to show it in the artifact panel. The download link is also shown under your reply.",
  input: {
    kind: z.enum([...DOC_KINDS, ...DOC_REFUSED_KINDS]),
    title: z
      .string()
      .trim()
      .min(1)
      .max(DOC_LIMITS.title)
      .describe("Document title (first line / title slide)."),
    subtitle: z.string().max(DOC_LIMITS.title).optional(),
    author: z.string().max(100).optional(),
    fileName: z
      .string()
      .min(1)
      .max(DOC_LIMITS.fileName)
      .optional()
      .describe("File name without extension; default: the title."),
    blocks: z.array(DocBlock).max(DOC_LIMITS.blocks),
  },
};

export const DOC_TOOLS: readonly ServerToolInfo[] = [DOC_CREATE_TOOL];
