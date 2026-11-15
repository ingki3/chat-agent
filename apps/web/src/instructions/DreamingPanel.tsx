import { useQuery } from "@tanstack/react-query";
import {
  DREAMING_CODE_LABEL,
  DREAMING_STATUS_LABEL,
  DREAMING_TRIGGER_LABEL,
  type DreamsRecord,
} from "@agentlee/shared";
import { dreaming, DREAMING_KEY, errorText } from "../api.js";
import { countsText } from "../admin/DreamingAdmin.js";
import { MemoryCard } from "./MemoryCard.js";

/**
 * 설정 → 내 지침 → 기억 정리 (#146, PRD FR-16.5·16.7·16.8): the bundles 기억 정리 made (반영 / 거절 per change, 모두
 * 반영, 되돌리기 — the same card as in a conversation), `DREAMS.md` (the run history: counts, times, results only) and
 * the cleanup prompt in use (read-only). Only the user sees this — the admin's screen has counts only.
 */
export function DreamingPanel() {
  const q = useQuery({ queryKey: DREAMING_KEY, queryFn: dreaming.mine });
  const d = q.data;
  if (q.isError) return <p className="error">{errorText(q.error)}</p>;
  if (!d) return <p className="muted small">불러오는 중…</p>;
  return (
    <div className="dreaming-panel" data-testid="dreaming-panel">
      <p className="small" data-testid="dreaming-state">
        {d.enabled
          ? `기억 정리가 매일 ${d.time ?? ""}(한국 시각)에 새 메시지를 정리해요. 반영 방식은 위의 "기억 반영 방식"을 따라요.`
          : "기억 정리가 꺼져 있어요(관리자가 켜면 하루 한 번 돌아요)."}
      </p>
      <h3>제안</h3>
      {d.proposals.length ? (
        <div className="dream-proposals">
          {d.proposals.map((p) => (
            <MemoryCard key={p.id} id={p.id} />
          ))}
        </div>
      ) : (
        <p className="muted small">기다리는 제안이 없어요.</p>
      )}
      <h3>DREAMS.md</h3>
      <p className="muted small">
        실행 기록이에요. 건수·시각·결과만 적고 내용은 적지 않아요(바뀐 내용은 문서의 버전에서 봐요).
      </p>
      <pre className="dreams-md" data-testid="dreams-md">
        {d.runs.length ? d.runs.map(line).join("\n") : "아직 실행 기록이 없어요."}
      </pre>
      <details>
        <summary className="small">지금 쓰는 정리 프롬프트 (버전 {d.prompt.version || "기본"})</summary>
        <pre className="small" data-testid="dreaming-prompt">
          {d.prompt.content}
        </pre>
        <p className="small muted">고정 규칙(관리자도 바꿀 수 없어요):</p>
        <pre className="small">{d.prompt.fixedRules}</pre>
      </details>
    </div>
  );
}

function line(r: DreamsRecord): string {
  const at = new Date(r.startedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  const code = r.code ? ` — ${DREAMING_CODE_LABEL[r.code] ?? r.code}` : "";
  return `- ${at} · ${DREAMING_TRIGGER_LABEL[r.trigger]} · ${DREAMING_STATUS_LABEL[r.status]}${code} · ${countsText(r.counts)}`;
}
