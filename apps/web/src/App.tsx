import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useNavigate, useParams } from "react-router";
import { SERVICE_NAME, type AuthState } from "@agentlee/shared";
import { auth, setUnauthenticatedHandler } from "./api.js";
import { Card, ChangePassword, Login, Setup } from "./auth-screens.js";
import { AdminPage } from "./pages/AdminPage.js";
import { ArtifactPage } from "./pages/ArtifactPage.js";
import { ArtifactsPage } from "./pages/ArtifactsPage.js";
import { WatchlistPage } from "./pages/WatchlistPage.js";
import { ChatPage, NewChatPage } from "./pages/ChatPage.js";
import { NotificationsPage } from "./pages/NotificationsPage.js";
import { PlaceholderPage } from "./pages/PlaceholderPage.js";
import { SharedViewPage, SharesPage } from "./pages/SharesPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { ScheduleDetailPage, SchedulesPage } from "./pages/SchedulesPage.js";
import { Shell } from "./Shell.js";
import { FileViewerPage } from "./files/FileViewer.js";

/** Only the login state lives here. Everything an account sees lives in a per-account client (AccountData). */
const authClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true } },
});

export function App() {
  return (
    <QueryClientProvider client={authClient}>
      <BrowserRouter>
        <AuthGate />
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export const AUTH_KEY = ["auth"] as const;

/** Other tabs of this browser learn about logins and logouts at once (no stale account on screen). */
const authChannel =
  typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel("agentlee-auth");

/**
 * Login comes first. The URL is never changed for it: after login (or after an expired session is renewed)
 * the same address renders, so the user lands back where they were (#13).
 */
/** Keyed by id: another artifact starts from its own latest version. */
function SharedViewRoute() {
  const { id } = useParams();
  return <SharedViewPage key={id} id={id ?? ""} />;
}

function ArtifactRoute() {
  const { id = "" } = useParams();
  return <ArtifactPage key={id} id={id} />;
}

function AuthGate() {
  const qc = useQueryClient();
  const { data, isError } = useQuery({ queryKey: AUTH_KEY, queryFn: auth.state });
  useNotificationOpen();
  const set = (s: AuthState) => {
    qc.setQueryData(AUTH_KEY, s);
    authChannel?.postMessage("changed");
  };
  useEffect(() => {
    const recheck = () => void qc.invalidateQueries({ queryKey: AUTH_KEY });
    setUnauthenticatedHandler(recheck);
    authChannel?.addEventListener("message", recheck);
    return () => authChannel?.removeEventListener("message", recheck);
  }, [qc]);

  // A failed re-check must not leave the previous account's screens up.
  if (isError) return <Card title={SERVICE_NAME}>서버에 연결하지 못했어요.</Card>;
  if (!data) return <Card title={SERVICE_NAME}>불러오는 중…</Card>;
  if (data.setupRequired) return <Setup state={data} onDone={set} />;
  if (!data.user) return <Login state={data} onDone={set} />;
  if (data.user.mustChangePassword) return <ChangePassword onDone={set} temporary />;
  const isAdmin = data.user.role === "admin";
  return (
    // Keyed by account: switching accounts throws away every cached list, message and open stream.
    <AccountData key={data.user.id}>
      <Routes>
        <Route element={<Shell user={data.user} onSignedOut={set} />}>
          <Route index element={<NewChatPage />} />
          <Route path="c/:id" element={<ChatRoute />} />
          <Route path="c/:id/files/:fileId" element={<FileViewRoute />} />
          <Route path="shared" element={<SharesPage />} />
          <Route path="shared/:id" element={<SharedViewRoute />} />
          <Route path="schedules" element={<SchedulesPage />} />
          <Route path="schedules/new" element={<SchedulesPage creating />} />
          <Route path="schedules/:id" element={<ScheduleRoute />} />
          <Route path="artifacts" element={<ArtifactsPage />} />
          <Route path="watchlist" element={<WatchlistPage />} />
          <Route path="a/:id" element={<ArtifactRoute />} />
          <Route path="notifications" element={<NotificationsPage />} />
          <Route path="settings" element={<SettingsPage onChanged={set} isAdmin={isAdmin} />} />
          <Route
            path="admin"
            element={isAdmin ? <AdminPage selfId={data.user.id} /> : <Navigate to="/" replace />}
          />
          <Route path="*" element={<PlaceholderPage title="찾을 수 없는 페이지" />} />
        </Route>
      </Routes>
    </AccountData>
  );
}

function AccountData({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 5_000 } },
      }),
  );
  useEffect(() => () => client.clear(), [client]);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** One schedule screen per schedule: an edit form never carries over to another one. */
function ScheduleRoute() {
  const { id = "" } = useParams();
  return <ScheduleDetailPage key={id} />;
}

/** The file viewer (#24), one instance per file: a citation's file at its place. */
function FileViewRoute() {
  const { id = "", fileId = "" } = useParams();
  return <FileViewerPage key={`${id}/${fileId}`} conversationId={id} fileId={fileId} />;
}

/** One chat screen instance per conversation: no state (e.g. a half-streamed reply) carries over. */
function ChatRoute() {
  const { id = "" } = useParams();
  return <ChatPage key={id} />;
}

/** Same-origin single-slash in-app path only (the service worker checks too). */
export function inAppPath(url: unknown): string {
  if (typeof url !== "string" || !url.startsWith("/") || url.startsWith("//") || url.includes("\\"))
    return "/";
  try {
    const u = new URL(url, window.location.origin);
    const out = u.pathname + u.search + u.hash;
    return u.origin === window.location.origin && !out.startsWith("//") ? out : "/";
  } catch {
    return "/";
  }
}

/**
 * Fallback for a tapped notification when the service worker could not navigate the open window itself (a window
 * it does not control yet): move there in place. Mounted above the login gate, so it works on the login screen
 * too — the address changes and the page is shown once the user has signed in.
 */
function useNotificationOpen() {
  const navigate = useNavigate();
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: unknown; url?: unknown } | null;
      if (data?.type === "agentlee:open") void navigate(inAppPath(data.url));
    };
    navigator.serviceWorker.addEventListener("message", onMessage);
    return () => navigator.serviceWorker.removeEventListener("message", onMessage);
  }, [navigate]);
}
