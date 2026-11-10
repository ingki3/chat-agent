import { createContext, useContext, useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router";
import type { AuthState, AuthUser } from "@agentlee/shared";
import { Sidebar } from "./Sidebar.js";

type ShellCtx = { openDrawer: () => void };
const Ctx = createContext<ShellCtx>({ openDrawer: () => {} });
export const useShell = () => useContext(Ctx);

/**
 * Three-column app frame (claude.ai-like, mockup v2): sidebar · main · (artifact panel, #28).
 * At 900px and below the sidebar becomes a drawer opened with ☰ from every screen.
 */
export function Shell({ user, onSignedOut }: { user: AuthUser; onSignedOut: (s: AuthState) => void }) {
  const location = useLocation();
  // The drawer belongs to the screen it was opened on: moving to another screen closes it.
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const drawer = openedOn === location.pathname;
  const setDrawer = (open: boolean) => setOpenedOn(open ? location.pathname : null);
  useEffect(() => {
    if (!drawer) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpenedOn(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  return (
    <Ctx.Provider value={{ openDrawer: () => setDrawer(true) }}>
      <div className={`app${drawer ? " drawer-on" : ""}`}>
        <Sidebar user={user} open={drawer} onSignedOut={onSignedOut} onClose={() => setDrawer(false)} />
        {drawer && <div className="scrim" data-testid="scrim" onClick={() => setDrawer(false)} />}
        <main className="main">
          <Outlet />
        </main>
      </div>
    </Ctx.Provider>
  );
}

/** Top bar of a screen: ☰ (narrow screens), title, actions. */
export function TopBar({ title, children }: { title: React.ReactNode; children?: React.ReactNode }) {
  const { openDrawer } = useShell();
  return (
    <div className="topbar">
      <button type="button" className="ghost hamb" aria-label="메뉴 열기" onClick={openDrawer}>
        ☰
      </button>
      <div className="title">{title}</div>
      {children}
    </div>
  );
}
