import { useEffect, useState } from "react";
import { HealthResponse, SERVICE_NAME } from "@agentlee/shared";

/** Placeholder shell for M0: proves UI + API on one port. Real layout lands in #13. */
export function App() {
  const [health, setHealth] = useState<HealthResponse | "error" | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((j) => setHealth(HealthResponse.parse(j)))
      .catch(() => setHealth("error"));
  }, []);

  return (
    <main className="shell">
      <h1>{SERVICE_NAME}</h1>
      <p className="status" data-testid="health">
        {health === null
          ? "서버 확인 중…"
          : health === "error"
            ? "서버에 연결하지 못했어요"
            : `서버 정상 · v${health.version}`}
      </p>
    </main>
  );
}
