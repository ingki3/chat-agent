import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ARTIFACT_EXPORTS,
  artifactDownloadPath,
  artifactExportPath,
  artifactRawPath,
  type ArtifactDetail,
  type ArtifactExportFormat,
} from "@agentlee/shared";
import { ApiError, artifacts } from "../api.js";
import { TopBar } from "../Shell.js";

const KIND_LABEL: Record<ArtifactDetail["kind"], string> = {
  html: "HTML",
  svg: "SVG",
  markdown: "마크다운",
  code: "코드",
  chart: "차트",
  table: "표",
  document: "문서",
};

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

/**
 * `/a/:id` (#27): one artifact, minimal viewer. The original is shown in `<iframe sandbox="allow-scripts">` —
 * no allow-same-origin, so it runs with an opaque origin and cannot reach this page, its cookies or the API (its
 * response also carries a sandboxing CSP). The artifact panel next to the chat is #28.
 */
export function ArtifactPage({ id }: { id: string }) {
  const qc = useQueryClient();
  const key = ["artifact", id];
  const { data, error } = useQuery({ queryKey: key, queryFn: () => artifacts.get(id), retry: false });
  const [picked, setPicked] = useState<number | undefined>();
  const [exporting, setExporting] = useState<ArtifactExportFormat | undefined>();
  const [exportError, setExportError] = useState<string | undefined>();
  const revert = useMutation({
    mutationFn: (version: number) => artifacts.revert(id, version),
    onSuccess: (d) => {
      qc.setQueryData(key, d);
      setPicked(undefined);
    },
  });

  if (error) {
    const status = error instanceof ApiError ? error.status : 0;
    const msg =
      status === 403
        ? "이 아티팩트를 볼 권한이 없어요."
        : status === 404
          ? "아티팩트를 찾을 수 없어요."
          : "불러오지 못했어요.";
    return (
      <>
        <TopBar title="🧩 아티팩트" />
        <div className="empty" role="alert">
          <p>{msg}</p>
        </div>
      </>
    );
  }
  if (!data)
    return (
      <>
        <TopBar title="🧩 아티팩트" />
        <div className="empty muted">불러오는 중…</div>
      </>
    );

  const version = picked ?? data.latestVersion;
  const info = data.versions.find((v) => v.version === version);
  const title = info?.title ?? data.title;
  // A chart's PNG is drawn here first; the server renders it only when that fails. Everything else is the server's.
  const exportAs = async (format: ArtifactExportFormat) => {
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
  return (
    <>
      <TopBar title={`🧩 ${data.title}`}>
        <span className="badge" data-testid="artifact-kind">
          {KIND_LABEL[data.kind]}
        </span>
      </TopBar>
      <div className="artifact-view">
        <div className="artifact-bar row">
          <label>
            버전{" "}
            <select
              value={version}
              onChange={(e) => setPicked(Number(e.target.value))}
              data-testid="artifact-version"
            >
              {[...data.versions].reverse().map((v) => (
                <option key={v.version} value={v.version}>
                  v{v.version}
                  {v.revertedFrom ? ` (v${v.revertedFrom} 복원)` : ""}
                  {v.version === data.latestVersion ? " · 최신" : ""}
                </option>
              ))}
            </select>
          </label>
          {version !== data.latestVersion && (
            <button type="button" disabled={revert.isPending} onClick={() => revert.mutate(version)}>
              이 버전으로 되돌리기
            </button>
          )}
          {data.kind !== "document" && (
            <a className="grow-right" href={artifactDownloadPath(data.id, version)} download>
              내려받기
            </a>
          )}
          {ARTIFACT_EXPORTS[data.kind].map((format) => (
            <button
              key={format}
              type="button"
              disabled={!!exporting}
              onClick={() => void exportAs(format)}
              data-testid={`artifact-export-${format}`}
            >
              {exporting === format ? "만드는 중…" : format.toUpperCase()}
            </button>
          ))}
        </div>
        {exportError && (
          <p role="alert" className="small" data-testid="artifact-export-error">
            {exportError}
          </p>
        )}
        {revert.isError && (
          <p role="alert" className="small">
            되돌리지 못했어요.
          </p>
        )}
        {data.kind === "document" ? (
          <div className="empty">
            <p>문서 미리보기는 준비 중이에요.</p>
            <p className="muted small">생성 문서 파일(#49)과 미리보기는 다음 단계에서 붙어요.</p>
          </div>
        ) : (
          <iframe
            key={version}
            className="artifact-frame"
            title={info?.title ?? data.title}
            src={artifactRawPath(data.id, version)}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            data-testid="artifact-frame"
          />
        )}
      </div>
    </>
  );
}
