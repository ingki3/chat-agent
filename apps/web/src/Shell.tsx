import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Outlet } from "react-router";
import type { AuthState, AuthUser } from "@agentlee/shared";
import { NOTIFICATIONS_KEY } from "./api.js";
import { PUSH_DEVICES_KEY, syncPush } from "./push.js";
import { Sidebar } from "./Sidebar.js";
import {
  ArtifactPanel,
  PANEL_FULL_SCREEN,
  useMediaQuery,
  useOpenArtifact,
} from "./artifacts/ArtifactPanel.js";

type ShellCtx = { openDrawer: (trigger: HTMLElement) => void };
const Ctx = createContext<ShellCtx>({ openDrawer: () => {} });
export const useShell = () => useContext(Ctx);

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Three-column app frame (claude.ai-like, mockup v2): sidebar · main · artifact panel (#28, only while an artifact
 * is open on a chat screen). At 900px and below the sidebar becomes a modal drawer opened with ☰ from every screen:
 * focus moves into it and stays there, the rest of the page is inert, and closing returns focus to ☰. Any
 * navigation closes it. There the artifact panel covers the screen too, and the page under it is inert.
 */
export function Shell({ user, onSignedOut }: { user: AuthUser; onSignedOut: (s: AuthState) => void }) {
  const [drawer, setDrawer] = useState(false);
  usePushMessages();
  const artifact = useOpenArtifact();
  const narrow = useMediaQuery(PANEL_FULL_SCREEN);
  const panelCovers = !!artifact && narrow;
  // The drawer exists only at 900px and below: widening the window closes it (and with it the modal state).
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const onChange = () => {
      if (!mq.matches) setDrawer(false);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const trigger = useRef<HTMLElement | null>(null);
  const aside = useRef<HTMLElement | null>(null);

  // Focus goes back to ☰ once the drawer is closed (while it is open, the rest of the page is inert).
  const restoreFocus = useRef(false);
  const close = () => {
    restoreFocus.current = true;
    setDrawer(false);
  };
  useEffect(() => {
    if (drawer || !restoreFocus.current) return;
    restoreFocus.current = false;
    trigger.current?.focus();
  }, [drawer]);

  useEffect(() => {
    if (!drawer) return;
    aside.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        restoreFocus.current = true;
        setDrawer(false);
      }
      if (e.key !== "Tab" || !aside.current) return;
      const items = [...aside.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    // Back/forward also closes it (it must never reopen on a page it was left open on).
    const onPop = () => setDrawer(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("popstate", onPop);
    };
  }, [drawer]);

  return (
    <Ctx.Provider
      value={{
        openDrawer: (el) => {
          trigger.current = el;
          setDrawer(true);
        },
      }}
    >
      <div className={`app${drawer ? " drawer-on" : ""}`}>
        <Sidebar
          ref={aside}
          user={user}
          open={drawer}
          onSignedOut={onSignedOut}
          onClose={close}
          // Picking anything in the drawer (a conversation, a shortcut) closes it.
          onNavigate={() => setDrawer(false)}
        />
        {drawer && <div className="scrim" data-testid="scrim" onClick={close} />}
        <main className="main" inert={drawer || panelCovers || undefined}>
          <Outlet />
        </main>
        {artifact && (
          // Keyed by artifact: another one starts fresh (its focus, export state).
          <ArtifactPanel key={artifact.id} id={artifact.id} version={artifact.version} fullScreen={narrow} />
        )}
      </div>
    </Ctx.Provider>
  );
}

/** Top bar of a screen: ☰ (narrow screens), title, actions. */
export function TopBar({ title, children }: { title: ReactNode; children?: ReactNode }) {
  const { openDrawer } = useShell();
  return (
    <div className="topbar">
      <button
        type="button"
        className="ghost hamb"
        aria-label="메뉴 열기"
        aria-haspopup="dialog"
        onClick={(e) => openDrawer(e.currentTarget)}
      >
        ☰
      </button>
      <div className="title">{title}</div>
      {children}
    </div>
  );
}

/**
 * Push on this account (#34): a push arrived → refresh the 🔔 badge at once; and on every app start, make the
 * server's registration match this browser's real subscription (a renewal the service worker could not
 * register — e.g. 403 after Access expired — is registered now). Tapped notifications are handled before login
 * too, in App (`useNotificationOpen`).
 */
function usePushMessages() {
  const qc = useQueryClient();
  useQuery({ queryKey: PUSH_DEVICES_KEY, queryFn: syncPush, staleTime: 60_000, retry: false });
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      if ((e.data as { type?: unknown } | null)?.type === "agentlee:notification")
        void qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [qc]);
}
