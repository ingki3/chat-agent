import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "react-router";
import { artifactPath, type PublicPart } from "@agentlee/shared";
import { artifacts } from "../api.js";
import { KIND_ICON, KIND_LABEL, artifactErrorText, artifactKey } from "./viewer.js";

/**
 * Artifacts from the chat (#28, #172): a card in the reply opens the artifact on its own page (`/a/:id`, the
 * artifact menu) — the chat is never split. A new artifact of a run started from this tab goes there by itself. The
 * page offers the way back to where the user came from (`ArtifactPage`).
 */

/** Version parameter of the artifact page (none = the newest, followed). */
export const VERSION_PARAM = "v";

/** The artifact page at `version` (undefined: the newest). */
export const artifactLink = (id: string, version?: number) =>
  version === undefined ? artifactPath(id) : `${artifactPath(id)}?${VERSION_PARAM}=${version}`;

/** Where the artifact page was opened from (navigation state): the page it goes back to. */
export type ArtifactFrom = { from?: string };

/** Only a conversation or a shared view counts as where an artifact was opened from. */
const FROM = /^\/(c|shared)\/[^/?#]+$/;
export const fromOf = (state: unknown): string | undefined => {
  const from = (state as ArtifactFrom | null)?.from;
  return typeof from === "string" && FROM.test(from) ? from : undefined;
};

/** Old links to the split panel (`/c/<id>?artifact=<id>&v=<n>`): the artifact page, coming from that conversation. */
export function legacyPanelTarget(search: string): string | undefined {
  const p = new URLSearchParams(search);
  const id = p.get("artifact");
  if (!id) return undefined;
  const v = Number(p.get(VERSION_PARAM));
  return artifactLink(id, Number.isInteger(v) && v > 0 ? v : undefined);
}

/**
 * The card the user opened an artifact from; once they come back with the page's "back" (link, Escape), that card
 * takes the focus again as it mounts.
 */
let opener: { id: string; version: number | undefined } | null = null;
let restore: { id: string; version: number | undefined } | null = null;
/** Called by the artifact page as it goes back: the card it was opened from gets the focus. */
export function returningFrom(id: string) {
  restore = opener?.id === id ? opener : null;
  opener = null;
}

/**
 * Runs started from this tab (send, edit, regenerate, a new chat) → whether they have shown an artifact yet. Only
 * those runs go to the artifact page by themselves — never a run seen again after a reload, one started in another
 * tab, or a scheduled run (their parts are replayed, not new). A run does it once: coming back to the conversation
 * while it still runs (its parts replayed) never sends the user away again.
 */
const startedHere = new Set<string>();
const shown = new Set<string>();
export const markStartedHere = (runId: string) => void startedHere.add(runId);

/**
 * PRD FR-6.1 "바로 보인다" (#172): while a run started here streams in the open conversation, the first artifact
 * it names (made, or a new version) is shown on its page — the chat is left for the artifact page, which leads
 * back. Pushed onto the history: "back" returns to the conversation.
 */
export function useAutoShow(
  live: { runId: string; parts: readonly PublicPart[] } | null | undefined,
  conversationId: string,
) {
  const navigate = useNavigate();
  useEffect(() => {
    if (!live || !startedHere.has(live.runId) || shown.has(live.runId)) return;
    const ref = live.parts.find((p) => p.type === "artifact_ref");
    if (ref?.type !== "artifact_ref") return;
    shown.add(live.runId);
    opener = { id: ref.artifactId, version: ref.version };
    void navigate(artifactLink(ref.artifactId), {
      state: { from: `/c/${encodeURIComponent(conversationId)}` } satisfies ArtifactFrom,
    });
  }, [live, conversationId, navigate]);
}

/**
 * A card in the conversation for an artifact the reply made or changed (`artifact_ref`, set by the server from
 * what our tools stored for that run). Opens the artifact page at the card's version (the newest: following it).
 */
export function ArtifactCard({ id, version }: { id: string; version: number | undefined }) {
  const { data, error } = useQuery({
    queryKey: artifactKey(id),
    queryFn: () => artifacts.get(id),
    retry: false,
  });
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const shown = version ?? data?.latestVersion;
  const info = data?.versions.find((x) => x.version === shown);
  const button = useRef<HTMLButtonElement>(null);
  // Back from the artifact page this card opened: the focus is where the user left it.
  useEffect(() => {
    if (!restore || restore.id !== id || restore.version !== version) return;
    restore = null;
    button.current?.focus();
  }, [id, version, data]);
  if (error)
    return (
      <div className="art-card off" data-testid="artifact-card">
        🧩 <span className="muted small">{artifactErrorText(error)}</span>
      </div>
    );
  return (
    <button
      ref={button}
      type="button"
      className="art-card"
      data-testid="artifact-card"
      data-version={shown}
      onClick={() => {
        opener = { id, version };
        void navigate(artifactLink(id, shown === data?.latestVersion ? undefined : shown), {
          state: { from: pathname } satisfies ArtifactFrom,
        });
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
      <span className="chip">열기</span>
    </button>
  );
}
