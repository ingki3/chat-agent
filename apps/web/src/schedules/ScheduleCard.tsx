import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import type { ScheduleProposal } from "@agentlee/shared";
import { errorText, schedules, SCHEDULES_KEY } from "../api.js";
import { chipLabel } from "../chat/chip.js";
import { timingText, whenText } from "./format.js";

export const proposalKey = (id: string) => ["schedule-proposal", id] as const;

/**
 * The confirmation card of `schedule_create` (#55, PRD FR-8.1): what the reply proposes — name, when (the server's
 * next runs), the prompt, runtime·model (the creator's defaults, FR-8.2) — and "예약 만들기". Nothing exists until
 * the owner presses it: the schedule is created by their own request (`POST /api/schedule-proposals/:id/confirm`),
 * never by the tool. Someone else (a shared view) sees no details (403).
 */
export function ScheduleCard({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: proposalKey(id), queryFn: () => schedules.proposal(id) });
  const done = (p: ScheduleProposal) => {
    qc.setQueryData(proposalKey(id), p);
    void qc.invalidateQueries({ queryKey: SCHEDULES_KEY });
  };
  const confirm = useMutation({
    mutationFn: () => schedules.confirm(id),
    onSuccess: (r) => done(r.proposal),
  });
  const dismiss = useMutation({ mutationFn: () => schedules.dismiss(id), onSuccess: done });
  const p = q.data;
  const busy = confirm.isPending || dismiss.isPending;
  const headId = `sched-card-${id}`;
  if (q.isError)
    return (
      <div className="sched-card small muted" data-testid="schedule-card">
        예약 제안을 불러오지 못했어요. {errorText(q.error)}
      </div>
    );
  if (!p)
    return (
      <div className="sched-card small muted" data-testid="schedule-card">
        예약 제안을 불러오는 중…
      </div>
    );
  return (
    <section className="sched-card" data-testid="schedule-card" aria-labelledby={headId}>
      <div className="row">
        <span aria-hidden>⏰</span>
        <b id={headId} className="grow">
          {p.name}
        </b>
        {p.status === "confirmed" && <span className="badge ok">만들었어요</span>}
        {p.status === "dismissed" && <span className="badge gray">취소함</span>}
        {p.status === "proposed" && <span className="badge">확인 필요</span>}
      </div>
      <dl className="sched-facts small">
        <dt>언제</dt>
        <dd data-testid="schedule-card-timing">
          {timingText(p.timing)} <span className="muted">({p.timeZone})</span>
        </dd>
        {p.status === "proposed" && (
          <>
            <dt>다음 실행</dt>
            <dd data-testid="schedule-card-next">
              {p.next[0] !== undefined ? whenText(p.next[0], p.timeZone) : "실행될 시각이 없어요"}
            </dd>
            <dt>런타임·모델</dt>
            <dd>{p.settings ? `${chipLabel(p.settings)} (내 기본값)` : "쓸 수 있는 런타임이 없어요"}</dd>
          </>
        )}
        <dt>할 일</dt>
        <dd className="sched-prompt">{p.prompt}</dd>
        {p.skills.length > 0 && (
          <>
            <dt>스킬</dt>
            <dd>{p.skills.join(", ")}</dd>
          </>
        )}
        <dt>알림</dt>
        <dd>{p.notify ? "켬" : "끔"}</dd>
      </dl>
      {p.status === "proposed" && (
        <div className="row wrap">
          <button
            type="button"
            className="primary"
            disabled={busy || p.next.length === 0}
            onClick={() => confirm.mutate()}
          >
            {confirm.isPending ? "만드는 중…" : "예약 만들기"}
          </button>
          <button type="button" disabled={busy} onClick={() => dismiss.mutate()}>
            취소
          </button>
        </div>
      )}
      {p.status === "confirmed" && p.scheduleId && (
        <p className="small" role="status">
          예약을 만들었어요.{" "}
          <Link to={`/schedules/${encodeURIComponent(p.scheduleId)}`}>예약 화면에서 보기</Link>
        </p>
      )}
      {(confirm.error ?? dismiss.error) && (
        <p className="error small" role="alert">
          {errorText(confirm.error ?? dismiss.error)}
        </p>
      )}
    </section>
  );
}
