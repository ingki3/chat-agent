import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { BackupCode } from "@agentlee/shared";
import { admin, errorText } from "../api.js";
import { bytesText } from "./SystemAdmin.js";

const time = (ms: number) =>
  new Date(ms).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const LAST: Record<BackupCode, string> = {
  backup_ok: "성공",
  backup_running: "이미 백업 중",
  backup_unavailable: "백업 꺼짐",
  backup_failed: "실패",
  backup_disk_full: "디스크 가득 참",
};

/**
 * 관리자 → 백업 (#37, FR-10.5): recent backups, "지금 백업" and how to restore. Restoring replaces the data folder, so
 * it is a command run with the server stopped — the screen only explains it (docs/ops.md §21).
 */
export function BackupAdmin() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["admin", "backups"], queryFn: admin.backups });
  const now = useMutation({
    mutationFn: admin.backupNow,
    onSettled: () => qc.invalidateQueries({ queryKey: ["admin", "backups"] }),
  });
  const b = q.data;
  return (
    <section className="admin" aria-label="백업">
      <h2>백업</h2>
      {q.isError && <p className="error small">{errorText(q.error)}</p>}
      {b && (
        <>
          <p className="muted small" data-testid="backup-schedule">
            매일 {b.schedule.time} (서울) 자동 백업 · {b.schedule.retentionDays}일 보관
            {b.nextRunAt !== null && ` · 다음 ${time(b.nextRunAt)}`}
            {b.last && ` · 마지막 ${time(b.last.at)} ${LAST[b.last.code]}`}
          </p>
          <p className="muted small">
            DB와 첨부·파일을 같은 시점으로 백업해요. 인증 정보는 암호화된 채로 들어가고,{" "}
            <b>마스터 키는 백업에 들어가지 않아요</b> — 키의 오프라인 사본은 따로 보관하세요(운영 문서 3절).
          </p>
          {b.leftovers.rejected > 0 && (
            <p className="error small" data-testid="backup-rejected" role="alert">
              복원이 중간에 끊겨 손상된 복원본 {b.leftovers.rejected}개를 데이터 폴더 옆(
              <code>…restore-rejected-…</code>)에 옮겨 뒀어요. 지금 데이터가 맞는지 확인한 뒤 지워도 돼요(운영
              문서 21.4절).
            </p>
          )}
          {b.leftovers.previous > 0 && (
            <p className="muted small" data-testid="backup-previous">
              복원 전 데이터 폴더 {b.leftovers.previous}개가 옆(<code>…before-restore-…</code>)에 남아 있어요.
              복원 결과를 확인했으면 직접 지우세요.
            </p>
          )}
          {!b.available && (
            <p className="error small" data-testid="backup-unavailable">
              이 서버는 백업을 만들지 않아요(BACKUP_DIR 설정 확인).
            </p>
          )}
          <button
            type="button"
            className="primary"
            disabled={!b.available || b.running || now.isPending}
            onClick={() => now.mutate()}
          >
            {now.isPending || b.running ? "백업 중…" : "지금 백업"}
          </button>
          {now.isError && <p className="error small">{errorText(now.error)}</p>}
          {now.isSuccess && (
            <p className="muted small" role="status">
              백업했어요: <code>{now.data.id}</code>
            </p>
          )}

          <h3>최근 백업</h3>
          {b.items.length === 0 ? (
            <p className="muted small" data-testid="no-backups">
              아직 백업이 없어요.
            </p>
          ) : (
            <table className="devices usage-table" aria-label="최근 백업">
              <thead>
                <tr>
                  <th>시각</th>
                  <th>ID</th>
                  <th className="num">크기</th>
                  <th className="num">파일</th>
                  <th>스키마</th>
                </tr>
              </thead>
              <tbody>
                {b.items.map((i) => (
                  <tr key={i.id}>
                    <td>{time(i.createdAt)}</td>
                    <td>
                      <code>{i.id}</code>
                    </td>
                    <td className="num">{i.valid ? bytesText(i.bytes) : "손상"}</td>
                    <td className="num">{i.valid ? i.fileCount : "—"}</td>
                    <td>
                      {i.valid
                        ? i.migrations === b.schemaMigrations
                          ? `${i.migrations} (현재)`
                          : `${i.migrations} (현재 ${b.schemaMigrations})`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h3>복원하는 방법</h3>
          <p className="muted small">
            복원은 데이터 폴더를 통째로 바꾸므로 화면에서 하지 않아요. 서버를 멈추고 맥의 터미널에서
            실행해요(운영 문서 21절).
          </p>
          <ol className="small" data-testid="restore-steps">
            <li>
              서버 멈추기: <code>sudo launchctl bootout system/com.agentlee.server</code> (개발 모드면 그냥
              종료)
            </li>
            <li>
              키 준비: 오프라인 사본에서 <code>~/.agentlee/master.key</code>를 되살리고 <code>chmod 600</code>
            </li>
            <li>
              검사: <code>pnpm -s restore check &lt;ID&gt;</code> — 키·해시·스키마 버전을 확인만 해요
            </li>
            <li>
              복원: <code>pnpm -s restore apply &lt;ID&gt; --yes</code> — 기존 데이터 폴더는 옆으로 옮겨 둬요
            </li>
            <li>
              다시 시작:{" "}
              <code>sudo launchctl bootstrap system /Library/LaunchDaemons/com.agentlee.server.plist</code>,
              이어서 <code>pnpm skills:install</code>
            </li>
          </ol>
          <p className="muted small">
            리허설은 <code>--target</code>으로 빈 폴더에 복원해 그 폴더로 서버를 띄워 확인해요. 키가 다르면{" "}
            <code>wrong_key</code>, 더 새 서버의 백업이면 <code>schema_newer</code>로 멈추고 아무것도 바꾸지
            않아요.
          </p>
        </>
      )}
    </section>
  );
}
