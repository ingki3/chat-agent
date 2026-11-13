import { createContext, useContext, useEffect, useEffectEvent, useRef, useSyncExternalStore } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useMatch, useNavigate, useSearchParams } from "react-router";
import { ARTIFACT_ESCAPE_MESSAGE, artifactPath, type PublicPart } from "@agentlee/shared";
import { artifacts } from "../api.js";
import {
  ArtifactRevoked,
  ArtifactBody,
  ArtifactToolbar,
  KIND_ICON,
  KIND_LABEL,
  artifactErrorText,
  artifactKey,
  useArtifactViewer,
  type ArtifactViewer,
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
 * What opened the panel last (a card, or the composer when a reply opened it): focus goes back there when the panel
 * is really closed (✕, Esc) — not when it goes away because the user navigated elsewhere.
 */
let opener: HTMLElement | null = null;
/** Set by a real close only: where the focus goes when the panel has unmounted. */
let restoreTo: HTMLElement | null = null;
const rememberOpener = (el: Element | null) => {
  opener = el instanceof HTMLElement ? el : null;
};

/** Navigation state of a panel the reply opened by itself (not the user): it does not take focus beside the chat. */
type PanelState = { panelAuto?: boolean } | null;

/**
 * Runs started from this tab (send, edit, regenerate, a new chat) → the artifacts each has already named. Only their
 * new artifacts open the panel by themselves — never a run seen again after a reload or one started elsewhere (its
 * parts are replayed, not new). Tab-wide, not per screen: leaving the conversation and coming back replays the run's
 * parts too, and an artifact already handled (opened, or closed by the user) never opens again.
 */
const startedHere = new Map<string, Set<string>>();
export const markStartedHere = (runId: string) => {
  if (!startedHere.has(runId)) startedHere.set(runId, new Set());
};
/** The artifact a reply opened by itself and still on screen; cleared once the user opens one with a card. */
let autoOpened: string | null = null;

/**
 * PRD FR-6.1 "바로 보인다": while a run started here is streaming, each artifact it names for the first time opens
 * in the panel (following the newest version) — unless the user opened another artifact themselves (their choice
 * stays). The address is replaced, so "back" is not filled with panels.
 */
export function useAutoOpen(live: { runId: string; parts: readonly PublicPart[] } | null | undefined) {
  const [params, setParams] = useSearchParams();
  const current = params.get(PANEL_PARAM);
  useEffect(() => {
    const ids = live && startedHere.get(live.runId);
    if (!ids) return;
    for (const p of live.parts) {
      if (p.type !== "artifact_ref" || ids.has(p.artifactId)) continue;
      ids.add(p.artifactId);
      if (current === p.artifactId || (current && current !== autoOpened)) continue;
      autoOpened = p.artifactId;
      rememberOpener(document.activeElement);
      const id = p.artifactId;
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set(PANEL_PARAM, id);
          next.delete(PANEL_VERSION_PARAM);
          return next;
        },
        { replace: true, state: { panelAuto: true } satisfies PanelState },
      );
      return;
    }
  }, [live, current, setParams]);
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
    close: () => {
      // Given back once the panel is gone (its unmount), when the page under it is no longer inert.
      restoreTo = opener;
      opener = null;
      change((p) => {
        p.delete(PANEL_PARAM);
        p.delete(PANEL_VERSION_PARAM);
      });
    },
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
  const aside = useRef<HTMLElement>(null);
  const auto = !!(useLocation().state as PanelState)?.panelAuto;
  // Focus moves into the panel when it opens — except beside the chat when the reply opened it (the user may be
  // typing). Closing gives it back to the opener (`close`).
  const focusOnOpen = useRef(!auto || fullScreen);
  useEffect(() => {
    if (focusOnOpen.current) head.current?.focus();
    return () => {
      const el = restoreTo;
      restoreTo = null;
      if (el?.isConnected) el.focus();
    };
  }, []);
  // Escape inside the sandboxed frame (key events never leave it): the frame's one message (`ESCAPE_BRIDGE`, served
  // with the original). Accepted only from the frame on screen and in exactly that shape; all it can do is close.
  const onEscape = useEffectEvent(() => close());
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const frame = aside.current?.querySelector("iframe");
      if (!frame || e.source !== frame.contentWindow) return;
      const d: unknown = e.data;
      if (
        typeof d === "object" &&
        d !== null &&
        Object.keys(d).length === 1 &&
        (d as { type?: unknown }).type === ARTIFACT_ESCAPE_MESSAGE
      )
        onEscape();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  const { data } = v;
  return (
    <aside
      ref={aside}
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
        <PanelBody v={v} />
      </div>
    </aside>
  );
}

/**
 * The panel's body. A lost share comes first (#29, review #117): the viewer has no data then, which must not read as
 * "loading".
 */
export function PanelBody({ v }: { v: ArtifactViewer }) {
  if (v.revoked) return <ArtifactRevoked />;
  if (v.error)
    return (
      <div className="empty" role="alert">
        <p>{artifactErrorText(v.error)}</p>
      </div>
    );
  if (!v.data) return <div className="empty muted">불러오는 중…</div>;
  return (
    <>
      <ArtifactToolbar v={v} />
      <ArtifactBody v={v} />
    </>
  );
}

/**
 * Where a card opens its artifact when there is no panel (#29: a shared view opens `/a/:id`). Null: the panel.
 */
export const ArtifactOpenContext = createContext<((id: string, version: number | undefined) => void) | null>(
  null,
);

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
  const openElsewhere = useContext(ArtifactOpenContext);
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
      onClick={(e) => {
        if (openElsewhere) return openElsewhere(id, shown);
        rememberOpener(e.currentTarget);
        autoOpened = null;
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
