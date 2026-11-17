import { useEffect, useEffectEvent, useRef } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { ARTIFACT_ESCAPE_MESSAGE } from "@agentlee/shared";
import { TopBar } from "../Shell.js";
import { KIND_ICON, KIND_LABEL, ViewerBody, useArtifactViewer } from "../artifacts/viewer.js";
import {
  CARD_VERSION_PARAM,
  VERSION_PARAM,
  fromOf,
  resolveCardVersion,
  returningFrom,
} from "../artifacts/ArtifactCard.js";
import { useFollowRun } from "../artifacts/follow-run.js";

/**
 * `/a/:id` (#27): one artifact on its own page — the artifact menu, where the chat sends the user when a reply makes
 * an artifact and when a card is clicked (#172; the chat is never split). The chosen version is in the address
 * (`?v=`, none = the newest, followed), so a link opens it and a reload keeps it. "대화로 돌아가기" leads back to
 * where it was opened from (the conversation, or a shared view), else to its conversation for the owner; Escape does
 * the same — also with the focus inside an HTML artifact's sandboxed frame (its one message, `ESCAPE_BRIDGE`).
 */
export function ArtifactPage({ id }: { id: string }) {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const raw = Number(params.get(VERSION_PARAM));
  const pinned = Number.isInteger(raw) && raw > 0 ? raw : undefined;
  // A card's intent (`?cv=`, review #175 6차): shown as asked until it is resolved below (no flash of another version).
  const cv = params.get(CARD_VERSION_PARAM);
  const intent = Number(cv);
  const v = useArtifactViewer(id, {
    version: pinned ?? (Number.isInteger(intent) && intent > 0 ? intent : undefined),
    setVersion: (next) =>
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (next === undefined) p.delete(VERSION_PARAM);
          else p.set(VERSION_PARAM, String(next));
          return p;
        },
        // Keeps the navigation state (where it was opened from) and adds no history entry.
        { replace: true, state: location.state as unknown },
      ),
  });
  const from = fromOf(location.state);
  const { data } = v;
  // Once the first read is in (or failed): `?cv=` becomes a pin when it is an older version, else is dropped (the
  // page follows the newest). Replaced — no history entry — and the navigation state (where it came from) kept.
  const settled = !!data || !!v.error || v.revoked;
  useEffect(() => {
    if (cv === null || !settled) return;
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.delete(CARD_VERSION_PARAM);
        // A real pin given with it stays as it is.
        const to = p.has(VERSION_PARAM) ? undefined : resolveCardVersion(cv, data);
        if (to !== undefined) p.set(VERSION_PARAM, String(to));
        return p;
      },
      { replace: true, state: location.state as unknown },
    );
  }, [cv, settled, data, setParams, location.state]);
  // The reply that is still running in its conversation (it may store more versions): followed here (review #175).
  useFollowRun(data?.conversationId, id, !v.revoked && v.owner);
  const back = from
    ? { to: from, label: from.startsWith("/shared/") ? "공유 화면으로 돌아가기" : "대화로 돌아가기" }
    : data && v.owner
      ? { to: `/c/${encodeURIComponent(data.conversationId)}`, label: "대화로 돌아가기" }
      : undefined;
  const leave = () => {
    if (!back) return;
    returningFrom(id);
    // Opened from there in this tab: the history entry it came from (its scroll, no extra entry); else a link.
    const idx = (window.history.state as { idx?: unknown } | null)?.idx;
    if (from && typeof idx === "number" && idx > 0) void navigate(-1);
    else void navigate(back.to);
  };
  const goBack = useEffectEvent(leave);
  const view = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      // Not while the drawer, a dialog or a form field has it.
      const t = e.target instanceof Element ? e.target : null;
      if (document.querySelector(".app.drawer-on, dialog[open], [role=dialog][aria-modal=true]")) return;
      if (t?.closest("input, textarea, select, [contenteditable=true], dialog, [role=dialog]")) return;
      goBack();
    };
    // Escape inside the sandboxed frame (key events never leave it): accepted only from the frame on this page and
    // in exactly that shape; all it can do is go back.
    const onMessage = (e: MessageEvent) => {
      const frame = view.current?.querySelector("iframe");
      if (!frame || e.source !== frame.contentWindow) return;
      const d: unknown = e.data;
      if (
        typeof d === "object" &&
        d !== null &&
        Object.keys(d).length === 1 &&
        (d as { type?: unknown }).type === ARTIFACT_ESCAPE_MESSAGE
      )
        goBack();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
    };
  }, []);
  const backLink = back && (
    <Link
      className="small"
      to={back.to}
      data-testid="artifact-back"
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
        e.preventDefault();
        leave();
      }}
    >
      ← {back.label}
    </Link>
  );
  return (
    <>
      <TopBar
        title={
          <span data-testid="artifact-title">
            {data && !v.revoked ? `${KIND_ICON[data.kind]} ${v.title}` : "🧩 아티팩트"}
          </span>
        }
      >
        {data && !v.revoked && (
          <span className="badge" data-testid="artifact-kind">
            {KIND_LABEL[data.kind]}
          </span>
        )}
        {backLink}
      </TopBar>
      <div className="artifact-view" ref={view} data-testid="artifact-page">
        <ViewerBody v={v} />
      </div>
    </>
  );
}
