import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ARTIFACT_EXPORTS,
  ARTIFACT_HTML_DOWNLOAD,
  artifactDownloadPath,
  artifactExportPath,
  artifactRawPath,
  DocumentRef,
  type ArtifactDetail,
  type ArtifactExportFormat,
} from "@agentlee/shared";
import { ApiError, artifacts, files } from "../api.js";

/**
 * The artifact viewer shared by the `/a/:id` page (#27) and the panel next to the chat (#28): the sandboxed frame,
 * the version picker, revert, downloads and PNG/PDF export (#51). The frame is defined here only.
 */

/**
 * The frame's sandbox: scripts run, but with an opaque origin — no allow-same-origin (no cookies, storage, API or
 * parent page), no top navigation, popups or forms. The original's response also carries a sandboxing CSP (#27).
 */
export const ARTIFACT_SANDBOX = "allow-scripts";

export const KIND_LABEL: Record<ArtifactDetail["kind"], string> = {
  html: "HTML",
  svg: "SVG",
  markdown: "마크다운",
  code: "코드",
  chart: "차트",
  table: "표",
  document: "문서",
};

export const KIND_ICON: Record<ArtifactDetail["kind"], string> = {
  html: "🌐",
  svg: "🖼",
  markdown: "📝",
  code: "💻",
  chart: "📊",
  table: "📋",
  document: "📄",
};

export const artifactKey = (id: string) => ["artifact", id] as const;
/** "내가 만든 것" (#28). */
export const MY_ARTIFACTS_KEY = ["my-artifacts"] as const;

/** The refusal shown for an artifact that cannot be loaded. */
export function artifactErrorText(error: unknown): string {
  const status = error instanceof ApiError ? error.status : 0;
  return status === 403
    ? "이 아티팩트를 볼 권한이 없어요."
    : status === 404
      ? "아티팩트를 찾을 수 없어요."
      : "불러오지 못했어요.";
}

/** Saves a blob as a file (a temporary link; the object URL is released right after). */
function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A file name from the title (characters file systems refuse are replaced). */
const fileName = (title: string, ext: string) =>
  // eslint-disable-next-line no-control-regex -- control characters are not allowed in a file name
  `${title.replace(/[\\/:*?"<>|\0-\x1f\x7f]+/g, "_").slice(0, 100) || "artifact"}.${ext}`;

/**
 * Chart → PNG in the browser (#51): the chart's SVG (the server-drawn download, no script) is drawn on a canvas.
 * Nothing of the sandboxed frame is touched — the SVG is fetched again from the owner-only download.
 */
export async function captureChartPng(id: string, version: number): Promise<Blob> {
  const res = await fetch(artifactDownloadPath(id, version), {
    credentials: "same-origin",
    redirect: "manual",
  });
  if (!isFile(res, "image/svg+xml")) throw new Error(`download ${res.status}`);
  const svg = await res.text();
  const box = /viewBox="0 0 (\d+(?:\.\d+)?) (\d+(?:\.\d+)?)"/.exec(svg);
  const w = Number(box?.[1] ?? 760);
  const h = Number(box?.[2] ?? 420);
  // Fixed size instead of width="100%" (an image has no container to fill); dark text on white.
  const sized = svg
    .replace(/^<svg /, `<svg width="${w}" height="${h}" color="#23211d" `)
    .replace(' width="100%"', "");
  const url = URL.createObjectURL(new Blob([sized], { type: "image/svg+xml" }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = w * scale;
    canvas.height = h * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("no png"))), "image/png"),
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

const EXPORT_TYPES: Record<ArtifactExportFormat, string> = { png: "image/png", pdf: "application/pdf" };

/**
 * Only the file itself counts: exactly 200 with the expected type. An expired session or gate answers with a
 * redirect to a login page (refused: `redirect: "manual"` gives an opaque response) or an HTML/JSON error —
 * never saved as a .png/.pdf.
 */
function isFile(res: Response, type: string): boolean {
  if (res.type === "opaqueredirect" || res.status !== 200) return false;
  const got = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  return got === type;
}

/** The server's isolated renderer (#51): the file, or an error with the server's code. */
async function serverExport(id: string, version: number, format: ArtifactExportFormat): Promise<Blob> {
  const res = await fetch(artifactExportPath(id, version, format), {
    credentials: "same-origin",
    redirect: "manual",
  });
  if (!isFile(res, EXPORT_TYPES[format])) throw new Error(`export ${res.status}`);
  return res.blob();
}

export type ArtifactViewer = ReturnType<typeof useArtifactViewer>;

/** Who holds the chosen version: the panel keeps it in the address; undefined = the newest. */
export type VersionControl = { version: number | undefined; setVersion: (v: number | undefined) => void };

/**
 * One artifact as a viewer shows it. The chosen version is the viewer's own, or `control`'s (the panel's address).
 * Nothing chosen (or a version that does not exist) shows the newest one and follows it: a later edit shows at once.
 */
export function useArtifactViewer(id: string, control?: VersionControl) {
  const qc = useQueryClient();
  const key = artifactKey(id);
  const query = useQuery({ queryKey: key, queryFn: () => artifacts.get(id), retry: false });
  const data = query.data;
  const [own, setOwn] = useState<number | undefined>();
  const chosen = control ? control.version : own;
  const setPicked = control ? control.setVersion : setOwn;
  const picked = data?.versions.some((v) => v.version === chosen) ? chosen : undefined;
  const [exporting, setExporting] = useState<ArtifactExportFormat | undefined>();
  const [exportError, setExportError] = useState<string | undefined>();
  const revert = useMutation({
    mutationFn: (version: number) => artifacts.revert(id, version),
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      setPicked(undefined);
    },
  });
  const version = data ? (picked ?? data.latestVersion) : undefined;
  const info = data?.versions.find((v) => v.version === version);
  const title = info?.title ?? data?.title ?? "";
  // A chart's PNG is drawn here first; the server renders it only when that fails. Everything else is the server's.
  const exportAs = async (format: ArtifactExportFormat) => {
    if (!data || version === undefined) return;
    setExporting(format);
    setExportError(undefined);
    try {
      let blob: Blob | undefined;
      if (format === "png" && data.kind === "chart")
        blob = await captureChartPng(data.id, version).catch(() => undefined);
      blob ??= await serverExport(data.id, version, format);
      saveBlob(blob, fileName(title, format));
    } catch {
      setExportError(`${format.toUpperCase()} 파일을 만들지 못했어요. 잠시 뒤 다시 해 보세요.`);
    } finally {
      setExporting(undefined);
    }
  };
  // A pick goes back to "follow the newest" when it is the newest.
  const pick = (v: number) => setPicked(data && v === data.latestVersion ? undefined : v);
  return {
    data,
    error: query.error,
    version,
    title,
    pick,
    revert,
    exporting,
    exportError,
    exportAs,
  };
}

/** Version picker, revert, downloads (original, HTML) and PNG/PDF export. */
export function ArtifactToolbar({ v }: { v: ArtifactViewer }) {
  const { data, version } = v;
  if (!data || version === undefined) return null;
  return (
    <>
      <div className="artifact-bar row">
        <label>
          버전{" "}
          <select
            value={version}
            onChange={(e) => v.pick(Number(e.target.value))}
            data-testid="artifact-version"
          >
            {[...data.versions].reverse().map((x) => (
              <option key={x.version} value={x.version}>
                v{x.version}
                {x.revertedFrom ? ` (v${x.revertedFrom} 복원)` : ""}
                {x.version === data.latestVersion ? " · 최신" : ""}
              </option>
            ))}
          </select>
        </label>
        {version !== data.latestVersion && (
          <button
            type="button"
            disabled={v.revert.isPending}
            onClick={() => v.revert.mutate(version)}
            data-testid="artifact-revert"
          >
            이 버전으로 되돌리기
          </button>
        )}
        {data.kind !== "document" && (
          <span className="grow-right row">
            <a
              href={artifactDownloadPath(data.id, version)}
              download
              data-testid="artifact-download"
              title="원본 파일"
            >
              {data.kind === "html" ? "HTML 내려받기" : "원본 내려받기"}
            </a>
            {ARTIFACT_HTML_DOWNLOAD.has(data.kind) && (
              <a
                href={artifactDownloadPath(data.id, version, "html")}
                download
                data-testid="artifact-download-html"
              >
                HTML
              </a>
            )}
          </span>
        )}
        {ARTIFACT_EXPORTS[data.kind].map((format) => (
          <button
            key={format}
            type="button"
            disabled={!!v.exporting}
            onClick={() => void v.exportAs(format)}
            data-testid={`artifact-export-${format}`}
          >
            {v.exporting === format ? "만드는 중…" : format.toUpperCase()}
          </button>
        ))}
      </div>
      {v.exportError && (
        <p role="alert" className="small" data-testid="artifact-export-error">
          {v.exportError}
        </p>
      )}
      {v.revert.isError && (
        <p role="alert" className="small">
          되돌리지 못했어요.
        </p>
      )}
    </>
  );
}

/**
 * A `document` artifact (#49): the generated file it names, as a download of the original (#22's route — owner
 * only, never shown inline). The preview comes with the file viewer (#24).
 */
function DocumentBody({ id, version }: { id: string; version: number }) {
  const query = useQuery({
    queryKey: [...artifactKey(id), "v", version],
    queryFn: () => artifacts.version(id, version),
    retry: false,
  });
  const ref = query.data ? DocumentRef.safeParse(parseJson(query.data.content)) : undefined;
  return (
    <div className="empty">
      {ref?.success ? (
        <p>
          <a href={files.url(ref.data.fileId)} download data-testid="document-download">
            📄 {ref.data.name} 내려받기
          </a>
        </p>
      ) : (
        <p>{query.isError ? "문서를 불러오지 못했어요." : "문서를 불러오는 중이에요."}</p>
      )}
      <p className="muted small">문서 미리보기는 준비 중이에요.</p>
    </div>
  );
}

const parseJson = (t: string): unknown => {
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
};

/** The chosen version: the sandboxed frame, or the document's download. */
export function ArtifactBody({ v }: { v: ArtifactViewer }) {
  const { data, version } = v;
  if (!data || version === undefined) return null;
  if (data.kind === "document") return <DocumentBody id={data.id} version={version} />;
  return (
    <iframe
      // A new frame per version: nothing of one version's document carries over to the next.
      key={`${data.id}:${version}`}
      className="artifact-frame"
      title={v.title}
      src={artifactRawPath(data.id, version)}
      sandbox={ARTIFACT_SANDBOX}
      referrerPolicy="no-referrer"
      data-testid="artifact-frame"
      data-version={version}
    />
  );
}
