import { useEffect, useRef, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useMatch, useNavigate, useSearchParams } from "react-router";
import { artifactPath } from "@agentlee/shared";
import { artifacts } from "../api.js";
import {
  ArtifactBody,
  ArtifactToolbar,
  KIND_ICON,
  KIND_LABEL,
  artifactErrorText,
  artifactKey,
  useArtifactViewer,
} from "./viewer.js";

/**
 * The artifact panel next to the chat (#28, PRD FR-6.1·6.2): the third column of the shell, there only while an
 * artifact is open. What is open lives in the address (`/c/<conversation>?artifact=<id>&v=<version>`, no `v` = the
 * newest), so a link opens it, "back" closes it and a reload keeps it. At 900px and below it covers the whole screen.
 */

/** Search parameters of the open artifact. */
export const PANEL_PARAM = "artifact";
export const PANEL_VERSION_PARAM = "v";
const PANEL_TITLE_ID = "artifact-panel-title";
/** At or below this width the panel is full screen (like the drawer, Shell). */
export const PANEL_FULL_SCREEN = "(max-width: 900px)";

/** The conversation with this artifact open in the panel. */
export const panelLink = (conversationId: string, id: string, version?: number) =>
  `/c/${encodeURIComponent(conversationId)}?${panelSearch(id, version)}`;
const panelSearch = (id: string, version?: number) => {
  const p = new URLSearchParams({ [PANEL_PARAM]: id });
  if (version !== undefined) p.set(PANEL_VERSION_PARAM, String(version));
  return p.toString();
};

export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(query);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
  );
}

/** The open artifact on a chat screen, if any (only chat screens have the panel). */
export function useOpenArtifact(): { id: string; version: number | undefined } | undefined {
  const onChat = useMatch("/c/:id");
  const [params] = useSearchParams();
  const id = params.get(PANEL_PARAM);
  if (!onChat || !id) return undefined;
  const v = Number(params.get(PANEL_VERSION_PARAM));
  return { id, version: Number.isInteger(v) && v > 0 ? v : undefined };
}

/**
 * The panel's address: closing drops its parameters, choosing a version sets `v` (none = the newest). Both replace
 * the history entry, so "back" leaves the conversation as it was before the panel opened.
 */
function usePanelAddress() {
  const [, setParams] = useSearchParams();
  const change = (edit: (p: URLSearchParams) => void) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        edit(next);
        return next;
      },
      { replace: true },
    );
  return {
    close: () =>
      change((p) => {
        p.delete(PANEL_PARAM);
        p.delete(PANEL_VERSION_PARAM);
      }),
    setVersion: (v: number | undefined) =>
      change((p) =>
        v === undefined ? p.delete(PANEL_VERSION_PARAM) : p.set(PANEL_VERSION_PARAM, String(v)),
      ),
  };
}

export function ArtifactPanel({
  id,
  version,
  fullScreen,
}: {
  id: string;
  version: number | undefined;
  fullScreen: boolean;
}) {
  const { close, setVersion } = usePanelAddress();
  const v = useArtifactViewer(id, { version, setVersion });
  const head = useRef<HTMLHeadingElement>(null);
  // Focus moves into the panel when it opens and goes back to what opened it (the card) when it closes.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    head.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  const { data, error } = v;
  return (
    <aside
      className={`art-panel${fullScreen ? " full" : ""}`}
      aria-label="아티팩트"
      role={fullScreen ? "dialog" : "complementary"}
      aria-modal={fullScreen || undefined}
      data-testid="artifact-panel"
      data-full={fullScreen ? "true" : "false"}
      onKeyDown={onKey}
    >
      <div className="art-head">
        <h2 ref={head} id={PANEL_TITLE_ID} tabIndex={-1} className="grow" data-testid="artifact-panel-title">
          {data ? `${KIND_ICON[data.kind]} ${v.title}` : "🧩 아티팩트"}
        </h2>
        {data && (
          <span className="badge" data-testid="artifact-kind">
            {KIND_LABEL[data.kind]}
          </span>
        )}
        <Link className="small" to={artifactPath(id)} title="아티팩트만 따로 열기">
          ↗ 따로 열기
        </Link>
        <button
          type="button"
          className="ghost"
          aria-label="아티팩트 닫기"
          onClick={close}
          data-testid="artifact-panel-close"
        >
          ✕
        </button>
      </div>
      <div className="art-body">
        {error ? (
          <div className="empty" role="alert">
            <p>{artifactErrorText(error)}</p>
          </div>
        ) : !data ? (
          <div className="empty muted">불러오는 중…</div>
        ) : (
          <>
            <ArtifactToolbar v={v} />
            <ArtifactBody v={v} />
          </>
        )}
      </div>
    </aside>
  );
}

/**
 * A card in the conversation for an artifact the reply made or changed (`artifact_ref`, set by the server from
 * what our tools stored for that run). Opens it in the panel at the card's version.
 */
export function ArtifactCard({ id, version }: { id: string; version: number | undefined }) {
  const { data, error } = useQuery({
    queryKey: artifactKey(id),
    queryFn: () => artifacts.get(id),
    retry: false,
  });
  const navigate = useNavigate();
  const open = useOpenArtifact();
  const shown = version ?? data?.latestVersion;
  const info = data?.versions.find((x) => x.version === shown);
  if (error)
    return (
      <div className="art-card off" data-testid="artifact-card">
        🧩 <span className="muted small">{artifactErrorText(error)}</span>
      </div>
    );
  const current = open?.id === id;
  return (
    <button
      type="button"
      className={`art-card${current ? " on" : ""}`}
      data-testid="artifact-card"
      data-version={shown}
      aria-current={current || undefined}
      // The newest version opens "following the newest" (a later edit shows in the panel at once).
      onClick={() => {
        void navigate({ search: `?${panelSearch(id, shown === data?.latestVersion ? undefined : shown)}` });
        // Into the panel, also when it was open already (a fresh panel focuses itself as it mounts).
        requestAnimationFrame(() => document.getElementById(PANEL_TITLE_ID)?.focus());
      }}
    >
      <span className="art-icon" aria-hidden>
        {data ? KIND_ICON[data.kind] : "🧩"}
      </span>
      <span className="grow">
        <b>{info?.title ?? data?.title ?? "아티팩트"}</b>
        <span className="small muted">
          {data ? `${KIND_LABEL[data.kind]} 아티팩트 · ` : ""}
          {shown ? `v${shown} ${shown === 1 ? "만듦" : info?.revertedFrom ? "복원" : "새 버전"}` : ""}
        </span>
      </span>
      <span className="chip">{current ? "열림" : "열기"}</span>
    </button>
  );
}
