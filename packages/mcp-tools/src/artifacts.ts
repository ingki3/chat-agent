import { z } from "zod";
import {
  ARTIFACT_LIMITS,
  ArtifactKind,
  ChartSpec,
  CodeLanguage,
  DocumentRef,
  TableData,
} from "@agentlee/shared";
import type { ServerToolInfo } from "./index.js";

/**
 * Artifact tools of the common MCP server (#27, PRD FR-6): what the model sees. Where an artifact is stored and
 * how it is served (sandboxed iframe, strict CSP) is the host's business (apps/server artifacts). The scope —
 * whose artifact, which conversation, which run — comes from the run's token, never from these inputs.
 */

const title = z
  .string()
  .trim()
  .min(1)
  .max(ARTIFACT_LIMITS.title)
  // eslint-disable-next-line no-control-regex -- refusing control characters is the point
  .regex(/^[^\0-\x1f\x7f]+$/u);
/** Characters; the byte limit (`ARTIFACT_LIMITS.contentBytes`) is checked by the host on the UTF-8 text. */
const content = z.string().min(1).max(ARTIFACT_LIMITS.contentBytes);

const body = {
  content: content
    .optional()
    .describe(
      "html, svg, markdown, code: the full text. HTML runs in a sandbox: inline <script> works; external scripts only from the allow-listed CDN URLs (Chart.js 4.4.1 at https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js); inline event attributes (onclick=…) do not run; no network access (fetch is blocked), no cookies or storage of the app.",
    ),
  language: CodeLanguage.optional().describe("code: language name, e.g. python."),
  chart: ChartSpec.optional().describe(
    "chart: data drawn by the server as SVG — type bar|line, labels, series (values per label).",
  ),
  table: TableData.optional().describe("table: columns and rows; shown as a table with a CSV download."),
  document: DocumentRef.optional().describe(
    "document: reference to a generated file (fileId, name, mimeType).",
  ),
};

export const ARTIFACT_CREATE_TOOL: ServerToolInfo = {
  name: "artifact_create",
  description:
    "Creates an artifact shown in the user's artifact panel and at /a/<id> (only the user can open it). kind: html | svg | markdown | code | chart | table | document; give exactly the matching field (content, chart, table or document). Returns artifactId, version and url.",
  input: { kind: ArtifactKind, title, ...body },
};

export const ARTIFACT_UPDATE_TOOL: ServerToolInfo = {
  name: "artifact_update",
  description:
    "Saves a new version of an artifact of this conversation (earlier versions stay and can be restored). Give the whole new content in the field of the artifact's kind; title is optional. Returns artifactId, version and url.",
  input: {
    artifactId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[A-Za-z0-9-]+$/),
    title: title.optional(),
    ...body,
  },
};

export const ARTIFACT_TOOLS: readonly ServerToolInfo[] = [ARTIFACT_CREATE_TOOL, ARTIFACT_UPDATE_TOOL];
