import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { ServerToolInfo } from "./index.js";
import { SAFE_TEXT } from "./skills.js";

/**
 * Web tools of the common MCP server (#50, PRD FR-5.1·5.2·5.7): what the model sees. How they run — the sandboxed
 * worker (`web/worker.mjs`), the egress proxy that refuses private addresses, and where results are stored
 * (`sources`) — is the host's business (apps/server web).
 */

/** Folder of the sandboxed web worker (same from src/ and dist/). The sandbox reads this folder only. */
export const WEB_WORKER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");
export const WEB_WORKER_ENTRY = path.join(WEB_WORKER_DIR, "worker.mjs");

export const WEB_SEARCH_TOOL: ServerToolInfo = {
  name: "web_search",
  description:
    "Web search. Returns results (title, site, date when known, URL, snippet) and a sourceId for each. Results are leads, not evidence: read a page with web_fetch before stating or citing what it says. Links from the google-news provider are Google redirect pages that often cannot be read; search the publisher's site for the article instead.",
  input: {
    query: z.string().min(1).max(300).regex(SAFE_TEXT).describe("Search words."),
    maxResults: z.number().int().min(1).max(10).optional().describe("Default 8."),
  },
};

export const WEB_FETCH_TOOL: ServerToolInfo = {
  name: "web_fetch",
  description:
    "Fetches one public web page (http/https; HTML, plain text or JSON — not PDF) and returns its title, site, date when known, final URL, a sourceId and the beginning of its readable text. The full text is stored as the source for citations. Never use it on addresses of this machine or a home network: they are refused.",
  input: {
    url: z.string().min(1).max(2048).describe("Absolute http(s) URL."),
  },
};

export const WEB_TOOLS: readonly ServerToolInfo[] = [WEB_SEARCH_TOOL, WEB_FETCH_TOOL];
