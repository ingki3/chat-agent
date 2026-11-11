import { useQuery } from "@tanstack/react-query";
import type { SystemStatus } from "@agentlee/shared";
import { admin, errorText } from "../api.js";
import { RUNTIME_LABEL } from "../DefaultsEditor.js";

const TUNNEL: Record<SystemStatus["tunnel"]["state"], [string, string]> = {
  unconfigured: ["미설정", "gray"],
  ok: ["연결됨", "ok"],
  down: ["끊김", "err"],
  unreachable: ["응답 없음", "err"],
};

const time = (ms: number) =>
  new Date(ms).toLocaleString("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/** 42.0 GB style. */
export function bytesText(n: number | null): string {
  if (n === null) return "알 수 없음";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 3일 4시간 style. */
export function durationText(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}일 ${h}시간`;
  if (h > 0) return `${h}시간 ${m}분`;
  return `${m}분`;
}

/**
 * 관리자 → 시스템 상태 (#35, FR-10.4): uptime, runtime connections, the tunnel, recent errors and skill failures
 * (codes only — #46 keeps no content), disk.
 */
export function SystemAdmin() {
  const q = useQuery({ queryKey: ["admin", "system"], queryFn: admin.system, refetchInterval: 30_000 });
  const s = q.data;
  return (
    <section className="admin" aria-label="시스템 상태">
      <h2>시스템 상태</h2>
      {q.isError && <p className="error small">{errorText(q.error)}</p>}
      {s && (
        <>
          <div className="usage-summary" data-testid="system-summary">
            <div>
              <div className="muted small">가동 시간</div>
              <strong data-testid="system-uptime">{durationText(s.uptimeSec)}</strong>
              <div className="muted small">
                {time(s.startedAt)} 시작 · v{s.version}
              </div>
            </div>
            <div>
              <div className="muted small">Cloudflare 터널</div>
              <strong>
                <span className={`badge ${TUNNEL[s.tunnel.state][1]}`} data-testid="tunnel-state">
                  {TUNNEL[s.tunnel.state][0]}
                </span>
              </strong>
              {s.tunnel.readyConnections !== null && (
                <div className="muted small">연결 {s.tunnel.readyConnections}개</div>
              )}
            </div>
            <div>
              <div className="muted small">디스크 (데이터 폴더)</div>
              <strong data-testid="disk-free">
                {bytesText(s.disk.freeBytes)} 남음 / {bytesText(s.disk.totalBytes)}
              </strong>
              <div className="muted small">DB {bytesText(s.disk.databaseBytes)}</div>
            </div>
          </div>
          {s.tunnel.state === "unconfigured" && (
            <p className="muted small">
              터널 상태를 보려면 cloudflared 메트릭 주소를 <code>.env</code>의{" "}
              <code>CLOUDFLARED_METRICS</code>에 넣으세요(루프백만, 운영 문서 6절). 7일 가동률은{" "}
              <code>pnpm uptime report</code>로 봐요.
            </p>
          )}

          <h3>런타임 연결</h3>
          <table className="devices" aria-label="런타임 연결 상태">
            <tbody>
              {s.runtimes.map((r) => (
                <tr key={r.runtime}>
                  <td>
                    <b>{RUNTIME_LABEL[r.runtime]}</b>
                    {!r.registered && <span className="muted small"> · 이 서버에 없음</span>}
                    <br />
                    <span className="muted small">
                      공용:{" "}
                      {r.shared.length === 0
                        ? "없음"
                        : r.shared
                            .map(
                              (c) =>
                                `${c.label} (${c.status}${c.lastTestCode ? ` · ${c.lastTestCode}` : ""})`,
                            )
                            .join(", ")}
                    </span>
                    <br />
                    <span className="muted small">
                      개인: 사용 가능 {r.personal.passed} · 테스트 필요 {r.personal.untested} · 실패{" "}
                      {r.personal.failed} · 끊김 {r.personal.expired}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>최근 오류</h3>
          <p className="muted small">코드와 경로만 남겨요. 대화 내용·오류 메시지는 저장하지 않아요.</p>
          {s.recentErrors.length === 0 ? (
            <p className="muted small" data-testid="no-errors">
              최근 오류가 없어요.
            </p>
          ) : (
            <table className="devices usage-table" aria-label="최근 오류">
              <thead>
                <tr>
                  <th>시각</th>
                  <th>어디서</th>
                  <th>코드</th>
                </tr>
              </thead>
              <tbody>
                {s.recentErrors.map((e) => (
                  <tr key={e.id}>
                    <td>{time(e.at)}</td>
                    <td>
                      {e.source === "http"
                        ? (e.route ?? "요청")
                        : e.source === "run"
                          ? `실행 ${e.runtime ?? ""}`
                          : `도구 ${e.tool ?? ""}`}
                    </td>
                    <td>
                      <code>{e.code}</code>
                      {e.statusCode ? ` · ${e.statusCode}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>스킬 실행 실패</h3>
          {s.skillFailures.length === 0 ? (
            <p className="muted small">최근 30일 동안 실패한 스킬 호출이 없어요.</p>
          ) : (
            <table className="devices usage-table" aria-label="스킬 실행 실패">
              <thead>
                <tr>
                  <th>스킬 도구</th>
                  <th>코드</th>
                  <th className="num">횟수</th>
                  <th>마지막</th>
                </tr>
              </thead>
              <tbody>
                {s.skillFailures.map((f) => (
                  <tr key={`${f.tool}-${f.code}`}>
                    <td>{f.tool}</td>
                    <td>
                      <code>{f.code}</code>
                    </td>
                    <td className="num">{f.count}</td>
                    <td>{time(f.lastAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}
