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
  /** Other series sets of one chart (원화·달러 기준, #31). */
  chartViews: 4,
  /** Source lines and notes under one chart. */
  chartNotes: 12,
  tableColumns: 50,
  tableRows: 5000,
  cellChars: 1000,
  language: 30,
} as const;

/** No control characters except tab (titles and labels are shown, never interpreted). */
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const LINE = /^[^\0-\x08\x0a-\x1f\x7f]*$/u;
const label = (max: number) => z.string().max(max).regex(LINE);

const ChartSeries = z.strictObject({
  name: label(100),
  values: z.array(z.number().finite().nullable()).max(ARTIFACT_LIMITS.chartLabels),
  /** `candle`: open, high, low and close per label (null where there is none). `values` are the closes. */
  ohlc: z
    .array(
      z
        .tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()])
        .nullable(),
    )
    .max(ARTIFACT_LIMITS.chartLabels)
    .optional(),
});
export type ChartSeries = z.infer<typeof ChartSeries>;

/**
 * Another set of series over the same labels (#31): e.g. the same comparison 원화 기준 and 달러 기준. The page offers
 * a switch between the chart's own series (`seriesLabel`) and each view; the download is the chart's own series.
 */
export const ChartView = z.strictObject({
  label: label(40).min(1),
  yLabel: label(100).optional(),
  unit: label(20).optional(),
  series: z.array(ChartSeries).min(1).max(ARTIFACT_LIMITS.chartSeries),
});
export type ChartView = z.infer<typeof ChartView>;

/** A chart as data (`chart` kind): the server draws it as SVG, so no script runs for it. */
export const ChartSpec = z.strictObject({
  type: z.enum(["bar", "line", "candle"]),
  title: label(200).optional(),
  xLabel: label(100).optional(),
  yLabel: label(100).optional(),
  /** Unit of the values, shown in tooltips (e.g. `%`, `KRW`). */
  unit: label(20).optional(),
  labels: z.array(label(100)).min(1).max(ARTIFACT_LIMITS.chartLabels),
  series: z.array(ChartSeries).min(1).max(ARTIFACT_LIMITS.chartSeries),
  /** Name of the chart's own series set when `views` are given (e.g. "원화 기준"). */
  seriesLabel: label(40).optional(),
  views: z.array(ChartView).max(ARTIFACT_LIMITS.chartViews).optional(),
  /** Where the numbers come from and as of when (finance, FR-7.6): shown under the chart and in its download. */
  sources: z.array(label(200)).max(ARTIFACT_LIMITS.chartNotes).optional(),
  /** Short notes under the chart (e.g. which exchange rate converted the values, as of when). */
  notes: z.array(label(300)).max(ARTIFACT_LIMITS.chartNotes).optional(),
});
export type ChartSpec = z.infer<typeof ChartSpec>;

/**
 * Every series of a chart (its own and its views') has one value per label, a candle chart's an OHLC per label —
 * what the schema cannot say on its own.
 */
export function chartShapeOk(c: ChartSpec): boolean {
  const all = [...c.series, ...(c.views ?? []).flatMap((v) => v.series)];
  return all.every(
    (s) =>
      s.values.length === c.labels.length &&
      (c.type === "candle" ? s.ohlc?.length === c.labels.length : s.ohlc === undefined),
  );
}

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

/**
 * "내가 만든 것" (#28, FR-6.6): the caller's own artifacts across conversations, most recently changed first, with
 * the conversation's title. Paged by an opaque cursor.
 */
export const MyArtifact = Artifact.extend({ conversationTitle: z.string() });
export type MyArtifact = z.infer<typeof MyArtifact>;
export const MY_ARTIFACTS_PAGE = 50;
export const MyArtifactsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(MY_ARTIFACTS_PAGE),
  cursor: z
    .string()
    .max(200)
    .regex(/^[0-9]{1,16}:[A-Za-z0-9-]{1,100}$/)
    .optional(),
});
export const MyArtifactsResponse = z.object({
  items: z.array(MyArtifact),
  nextCursor: z.string().nullable(),
});
export type MyArtifactsResponse = z.infer<typeof MyArtifactsResponse>;

/** One version's stored content as text (JSON text for chart, table and document). Never rendered by the app. */
export const ArtifactVersionContent = z.object({
  version: z.number().int().positive(),
  kind: ArtifactKind,
  content: z.string(),
});
export type ArtifactVersionContent = z.infer<typeof ArtifactVersionContent>;

export const RevertArtifactRequest = z.strictObject({ version: z.number().int().positive() });
export type RevertArtifactRequest = z.infer<typeof RevertArtifactRequest>;

/**
 * The only message the app accepts from an artifact's frame (#28): Escape was pressed inside it — the panel closes.
 * Exactly `{ type: ARTIFACT_ESCAPE_MESSAGE }`, from the frame on screen.
 */
export const ARTIFACT_ESCAPE_MESSAGE = "agentlee:escape";

/** In-app address of an artifact, and of one version's sandboxed original. */
export const artifactPath = (id: string) => `/a/${encodeURIComponent(id)}`;
export const artifactRawPath = (id: string, version: number) =>
  `/a/${encodeURIComponent(id)}/v/${version}/raw`;
export const artifactDownloadPath = (id: string, version: number, format?: "html") =>
  `/a/${encodeURIComponent(id)}/v/${version}/download${format ? `?format=${format}` : ""}`;
/**
 * Kinds whose original is not HTML but whose served page is (#28 "HTML·원본 내려받기"): the download route also
 * gives that page as a file (`?format=html`). An html artifact's original already is its HTML.
 */
export const ARTIFACT_HTML_DOWNLOAD: ReadonlySet<ArtifactKind> = new Set(["chart", "table"]);

/** PNG/PDF export (#51): which formats each kind exports to (pictures → PNG, documents → PDF). */
export const ARTIFACT_EXPORT_FORMATS = ["png", "pdf"] as const;
export type ArtifactExportFormat = (typeof ARTIFACT_EXPORT_FORMATS)[number];
export const ARTIFACT_EXPORTS: Record<ArtifactKind, readonly ArtifactExportFormat[]> = {
  chart: ["png", "pdf"],
  svg: ["png"],
  html: ["png", "pdf"],
  table: ["pdf"],
  markdown: ["pdf"],
  code: ["pdf"],
  // A generated file's own preview and conversion are #49/#22.
  document: [],
};
/** Server-rendered export of one version (owner only, like the original). */
export const artifactExportPath = (id: string, version: number, format: ArtifactExportFormat) =>
  `/a/${encodeURIComponent(id)}/v/${version}/${format}`;
