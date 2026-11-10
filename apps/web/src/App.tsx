import { useEffect } from "react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { SERVICE_NAME, type AuthState } from "@agentlee/shared";
import { auth, setUnauthenticatedHandler } from "./api.js";
import { Card, ChangePassword, Login, Setup } from "./auth-screens.js";
import { AdminPage } from "./pages/AdminPage.js";
import { ChatPage, NewChatPage } from "./pages/ChatPage.js";
import { PlaceholderPage } from "./pages/PlaceholderPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { Shell } from "./Shell.js";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: true, staleTime: 5_000 } },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AuthGate />
      </BrowserRouter>
    </QueryClientProvider>
  );
}

export const AUTH_KEY = ["auth"] as const;

/**
 * Login comes first. The URL is never changed for it: after login (or after an expired session is renewed)
 * the same address renders, so the user lands back where they were (#13).
 */
function AuthGate() {
  const qc = useQueryClient();
  const { data, isError } = useQuery({ queryKey: AUTH_KEY, queryFn: auth.state });
  const set = (s: AuthState) => {
    qc.setQueryData(AUTH_KEY, s);
    // Another account may be signed in now: drop everything cached for the previous one.
    qc.removeQueries({ predicate: (q) => q.queryKey[0] !== AUTH_KEY[0] });
  };
  useEffect(() => {
    setUnauthenticatedHandler(() => void qc.invalidateQueries({ queryKey: AUTH_KEY }));
  }, [qc]);

  if (isError) return <Card title={SERVICE_NAME}>서버에 연결하지 못했어요.</Card>;
  if (!data) return <Card title={SERVICE_NAME}>불러오는 중…</Card>;
  if (data.setupRequired) return <Setup state={data} onDone={set} />;
  if (!data.user) return <Login state={data} onDone={set} />;
  if (data.user.mustChangePassword) return <ChangePassword onDone={set} temporary />;
  const isAdmin = data.user.role === "admin";
  return (
    <Routes>
      <Route element={<Shell user={data.user} onSignedOut={set} />}>
        <Route index element={<NewChatPage />} />
        <Route path="c/:id" element={<ChatPage />} />
        <Route path="shared" element={<PlaceholderPage title="👪 가족 공유" issue="#52" />} />
        <Route path="schedules" element={<PlaceholderPage title="⏰ 예약" issue="#55" />} />
        <Route path="artifacts" element={<PlaceholderPage title="🧩 아티팩트" issue="#28" />} />
        <Route path="settings" element={<SettingsPage onChanged={set} />} />
        <Route
          path="admin"
          element={isAdmin ? <AdminPage selfId={data.user.id} /> : <Navigate to="/" replace />}
        />
        <Route path="*" element={<PlaceholderPage title="찾을 수 없는 페이지" />} />
      </Route>
    </Routes>
  );
}
