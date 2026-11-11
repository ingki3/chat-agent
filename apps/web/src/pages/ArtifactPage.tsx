import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { artifactDownloadPath, artifactRawPath, type ArtifactDetail } from "@agentlee/shared";
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
        </div>
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
