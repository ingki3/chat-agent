import { z } from "zod";

/**
 * Artifacts (#27, PRD FR-6): pages, charts, diagrams, documents and code an agent makes. Each one has immutable
 * versions; a change or a revert adds a version. The address is `/a/<id>` and only the owner may open it until
 * family sharing (#29).
 */
export const ArtifactKind = z.enum(["html", "svg", "markdown", "code", "chart", "table", "document"]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

/** Bounds of what one artifact may hold. Content is measured in UTF-8 bytes of what is stored. */
export const ARTIFACT_LIMITS = {
  title: 200,
  /** Stored content of one version (html, svg, markdown and code text; chart, table and document JSON). */
  contentBytes: 512 * 1024,
  versionsPerArtifact: 100,
  artifactsPerConversation: 200,
  chartLabels: 500,
  chartSeries: 10,
  tableColumns: 50,
  tableRows: 5000,
  cellChars: 1000,
  language: 30,
} as const;

/** No control characters except tab (titles and labels are shown, never interpreted). */
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const LINE = /^[^\0-\x08\x0a-\x1f\x7f]*$/u;
const label = (max: number) => z.string().max(max).regex(LINE);

/** A chart as data (`chart` kind): the server draws it as SVG, so no script runs for it. */
export const ChartSpec = z.strictObject({
  type: z.enum(["bar", "line"]),
  title: label(200).optional(),
  xLabel: label(100).optional(),
  yLabel: label(100).optional(),
  labels: z.array(label(100)).min(1).max(ARTIFACT_LIMITS.chartLabels),
  series: z
    .array(
      z.strictObject({
        name: label(100),
        values: z.array(z.number().finite().nullable()).max(ARTIFACT_LIMITS.chartLabels),
      }),
    )
    .min(1)
    .max(ARTIFACT_LIMITS.chartSeries),
});
export type ChartSpec = z.infer<typeof ChartSpec>;

/** A table (`table` kind): shown as an HTML table, downloadable as CSV. */
export const TableData = z.strictObject({
  columns: z.array(label(200)).min(1).max(ARTIFACT_LIMITS.tableColumns),
  rows: z
    .array(
      z.array(z.union([z.string().max(ARTIFACT_LIMITS.cellChars), z.number().finite(), z.null()])).max(50),
    )
    .max(ARTIFACT_LIMITS.tableRows),
});
export type TableData = z.infer<typeof TableData>;

/**
 * A generated document file (`document` kind) — a DOCX, PDF, … made by file generation (#49) and stored with the
 * uploads (#22). Only the reference is kept here; the preview (pdf.js, PDF conversions) comes with those issues.
 */
export const DocumentRef = z.strictObject({
  fileId: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9_-]+$/),
  name: label(200).min(1),
  mimeType: z
    .string()
    .max(100)
    .regex(/^[a-z]+\/[a-z0-9.+-]+$/),
});
export type DocumentRef = z.infer<typeof DocumentRef>;

/** Code language label (`code` kind), e.g. `python`, `c++`, `c#`. */
export const CodeLanguage = z
  .string()
  .min(1)
  .max(ARTIFACT_LIMITS.language)
  .regex(/^[a-z0-9+#._-]+$/);

export const Artifact = z.object({
  id: z.string(),
  conversationId: z.string(),
  /** The assistant message whose run made it (null when that message is gone). */
  messageId: z.string().nullable(),
  runId: z.string().nullable(),
  kind: ArtifactKind,
  title: z.string(),
  language: z.string().nullable(),
  latestVersion: z.number().int().positive(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Artifact = z.infer<typeof Artifact>;

export const ArtifactVersionInfo = z.object({
  version: z.number().int().positive(),
  /** SHA-256 (hex) of the stored content. */
  contentHash: z.string(),
  bytes: z.number().int().nonnegative(),
  title: z.string(),
  /** `code` kind: this version's language. */
  language: z.string().nullable(),
  runId: z.string().nullable(),
  /** Set when this version is a copy of an earlier one (revert). */
  revertedFrom: z.number().int().positive().nullable(),
  createdAt: z.number(),
});
export type ArtifactVersionInfo = z.infer<typeof ArtifactVersionInfo>;

export const ArtifactDetail = Artifact.extend({ versions: z.array(ArtifactVersionInfo) });
export type ArtifactDetail = z.infer<typeof ArtifactDetail>;

export const ArtifactListResponse = z.object({ items: z.array(Artifact) });
export type ArtifactListResponse = z.infer<typeof ArtifactListResponse>;

/** One version's stored content as text (JSON text for chart, table and document). Never rendered by the app. */
export const ArtifactVersionContent = z.object({
  version: z.number().int().positive(),
  kind: ArtifactKind,
  content: z.string(),
});
export type ArtifactVersionContent = z.infer<typeof ArtifactVersionContent>;

export const RevertArtifactRequest = z.strictObject({ version: z.number().int().positive() });
export type RevertArtifactRequest = z.infer<typeof RevertArtifactRequest>;

/** In-app address of an artifact, and of one version's sandboxed original. */
export const artifactPath = (id: string) => `/a/${encodeURIComponent(id)}`;
export const artifactRawPath = (id: string, version: number) =>
  `/a/${encodeURIComponent(id)}/v/${version}/raw`;
export const artifactDownloadPath = (id: string, version: number) =>
  `/a/${encodeURIComponent(id)}/v/${version}/download`;
