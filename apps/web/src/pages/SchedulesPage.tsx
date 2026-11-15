import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import type { Schedule, ScheduleRun } from "@agentlee/shared";
import { errorText, schedules, SCHEDULES_KEY, settings as settingsApi } from "../api.js";
import { TopBar } from "../Shell.js";
import { CONVERSATIONS_KEY } from "../Sidebar.js";
import { chipLabel } from "../chat/chip.js";
import { ScheduleForm } from "../schedules/ScheduleForm.js";
import {
  CODE_LABEL,
  costText,
  STATUS_CLASS,
  STATUS_LABEL,
  timingText,
  TRIGGER_LABEL,
  whenText,
} from "../schedules/format.js";

const scheduleKey = (id: string) => ["schedules", "one", id] as const;
const runsKey = (id: string) => ["schedules", "runs", id] as const;
const useUsable = () => useQuery({ queryKey: ["runtimes", "usable"], queryFn: settingsApi.usableRuntimes });

/**
 * `/schedules` (#55, PRD FR-8.5): my schedules — pause, run now, edit, delete and the run history. Only the
 * caller's own (owner only: the admin sees only theirs too). `/schedules/new` opens the form.
 */
export function SchedulesPage({ creating = false }: { creating?: boolean }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: SCHEDULES_KEY, queryFn: schedules.list });
  return (
    <>
      <TopBar title="⏰ 예약">
        {!creating && (
          <Link className="btnlink primary" to="/schedules/new">
            + 새 예약
          </Link>
        )}
      </TopBar>
      <div className="page wide">
        {creating && (
          <section className="panel" aria-labelledby="sched-new-h">
            <h2 id="sched-new-h">새 예약</h2>
            <ScheduleForm
              onSaved={(s) => {
                void qc.invalidateQueries({ queryKey: SCHEDULES_KEY });
                navigate(`/schedules/${encodeURIComponent(s.id)}`);
              }}
              onCancel={() => navigate("/schedules")}
            />
          </section>
        )}
        {list.isError ? (
          <div className="notice err" role="alert">
            목록을 불러오지 못했어요. {errorText(list.error)}
          </div>
        ) : !list.data ? (
          <div className="empty muted">불러오는 중…</div>
        ) : list.data.length === 0 ? (
          !creating && (
            <div className="empty" data-testid="schedules-empty">
              <p>아직 예약이 없어요.</p>
              <p className="muted small">
                “+ 새 예약”을 누르거나, 대화에서 “매일 아침 8시에 내 관심 종목 브리핑해줘”라고 해 보세요.
              </p>
            </div>
          )
        ) : (
          <ul className="sched-list" data-testid="schedule-list" aria-label="내 예약">
            {list.data.map((s) => (
              <li key={s.id}>
                <ScheduleItem schedule={s} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** One schedule with its actions: 일시정지/다시 켜기, 바로 실행, 수정, 삭제 (asks once more), 실행 이력. */
function ScheduleItem({ schedule: s, detail = false }: { schedule: Schedule; detail?: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const usable = useUsable();
  const [askDelete, setAskDelete] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const refresh = (next?: Schedule) => {
    if (next) qc.setQueryData(scheduleKey(next.id), next);
    void qc.invalidateQueries({ queryKey: SCHEDULES_KEY });
  };
  const pause = useMutation({
    mutationFn: () => schedules.update(s.id, { paused: !s.paused }),
    onSuccess: (n) => {
      refresh(n);
      setMessage(n.paused ? "일시정지했어요." : "다시 켰어요.");
    },
  });
  const run = useMutation({
    mutationFn: () => schedules.runNow(s.id),
    onSuccess: () => {
      setMessage("바로 실행을 시작했어요. 실행 이력에서 결과를 확인하세요.");
      void qc.invalidateQueries({ queryKey: runsKey(s.id) });
    },
  });
  const remove = useMutation({
    mutationFn: () => schedules.remove(s.id),
    onSuccess: () => {
      qc.removeQueries({ queryKey: scheduleKey(s.id) });
      void qc.invalidateQueries({ queryKey: SCHEDULES_KEY });
      if (detail) navigate("/schedules");
    },
  });
  const err = pause.error ?? run.error ?? remove.error;
  const headId = `sched-${s.id}`;
  const Heading = detail ? "h1" : "h2";
  return (
    <article className="panel sched-item" data-testid="schedule-item" aria-labelledby={headId}>
      <div className="row wrap">
        <Heading id={headId} className="grow sched-name">
          {detail ? s.name : <Link to={`/schedules/${encodeURIComponent(s.id)}`}>{s.name}</Link>}
        </Heading>
        {s.paused ? <span className="badge gray">일시정지</span> : <span className="badge ok">켜짐</span>}
        {!s.notify && <span className="badge gray">알림 끔</span>}
      </div>
      <dl className="sched-facts small">
        <dt>언제</dt>
        <dd>
          {timingText(s.timing)} <span className="muted">({s.timeZone})</span>
        </dd>
        <dt>다음 실행</dt>
        <dd data-testid="schedule-next-run">
          {s.paused ? "일시정지 중" : s.nextRunAt !== null ? whenText(s.nextRunAt, s.timeZone) : "없음(끝남)"}
        </dd>
        <dt>런타임·모델</dt>
        <dd data-testid="schedule-settings">
          {chipLabel(s.settings, usable.data)}
          {s.settings.effort ? ` · 추론 ${s.settings.effort}` : ""}
        </dd>
        {s.skills.length > 0 && (
          <>
            <dt>스킬</dt>
            <dd>{s.skills.join(", ")}</dd>
          </>
        )}
        {detail && (
          <>
            <dt>할 일</dt>
            <dd className="sched-prompt">{s.prompt}</dd>
          </>
        )}
      </dl>
      <div className="row wrap">
        <button type="button" disabled={pause.isPending} onClick={() => pause.mutate()}>
          {s.paused ? "▶ 다시 켜기" : "⏸ 일시정지"}
        </button>
        <button type="button" disabled={run.isPending} onClick={() => run.mutate()}>
          ⚡ 바로 실행
        </button>
        <Link className="btnlink" to={`/schedules/${encodeURIComponent(s.id)}?edit=1`}>
          ✎ 수정
        </Link>
        {!detail && (
          <Link className="btnlink" to={`/schedules/${encodeURIComponent(s.id)}`}>
            실행 이력
          </Link>
        )}
        {askDelete ? (
          <span className="row" role="group" aria-label="삭제 확인">
            <span className="small">정말 지울까요?</span>
            <button
              type="button"
              className="danger"
              disabled={remove.isPending}
              autoFocus
              onClick={() => remove.mutate()}
            >
              삭제
            </button>
            <button type="button" onClick={() => setAskDelete(false)}>
              그대로 두기
            </button>
          </span>
        ) : (
          <button type="button" className="danger" onClick={() => setAskDelete(true)}>
            🗑 삭제
          </button>
        )}
      </div>
      {message && !err && (
        <p className="small muted" role="status">
          {message}
        </p>
      )}
      {err && (
        <p className="error small" role="alert">
          {errorText(err)}
        </p>
      )}
    </article>
  );
}

/** `/schedules/:id`: one schedule, its edit form (`?edit=1`) and its run history (success, failure, skipped, cost). */
export function ScheduleDetailPage() {
  const { id = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const editing = params.get("edit") === "1";
  const one = useQuery({ queryKey: scheduleKey(id), queryFn: () => schedules.get(id) });
  const s = one.data;
  return (
    <>
      <TopBar title={<Link to="/schedules">⏰ 예약</Link>} />
      <div className="page wide">
        {one.isError ? (
          <div className="notice err" role="alert">
            예약을 불러오지 못했어요. {errorText(one.error)}
          </div>
        ) : !s ? (
          <div className="empty muted">불러오는 중…</div>
        ) : (
          <>
            <ScheduleItem schedule={s} detail />
            {editing && (
              <section className="panel" aria-labelledby="sched-edit-h">
                <h2 id="sched-edit-h">예약 수정</h2>
                <ScheduleForm
                  key={s.updatedAt}
                  schedule={s}
                  onSaved={(n) => {
                    qc.setQueryData(scheduleKey(n.id), n);
                    void qc.invalidateQueries({ queryKey: SCHEDULES_KEY });
                    setParams({}, { replace: true });
                  }}
                  onCancel={() => setParams({}, { replace: true })}
                />
              </section>
            )}
            {s.conversationId && (
              <p className="small">
                <Link to={`/c/${s.conversationId}`} data-testid="schedule-conversation">
                  💬 결과 대화 보기
                </Link>
              </p>
            )}
            <RunHistory scheduleId={s.id} timeZone={s.timeZone} />
          </>
        )}
      </div>
    </>
  );
}

const unfinished = (r: ScheduleRun) => r.status === "pending" || r.status === "running";

function RunHistory({ scheduleId, timeZone }: { scheduleId: string; timeZone: string }) {
  const runs = useQuery({
    queryKey: runsKey(scheduleId),
    queryFn: () => schedules.runs(scheduleId),
    // While a run is going, look again every 2 s (the engine moves it on its own).
    refetchInterval: (q) => (q.state.data?.some(unfinished) ? 2000 : false),
  });
  // A run that saved its result (#56) made or moved the result conversation: the sidebar ("새 결과") and the link.
  const qc = useQueryClient();
  const saved = runs.data?.filter((r) => r.resultSavedAt !== null).length ?? 0;
  useEffect(() => {
    if (!saved) return;
    void qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
    void qc.invalidateQueries({ queryKey: scheduleKey(scheduleId) });
  }, [saved, qc, scheduleId]);
  return (
    <section className="panel" aria-labelledby="sched-runs-h">
      <h2 id="sched-runs-h">실행 이력</h2>
      {runs.isError ? (
        <p className="error small" role="alert">
          {errorText(runs.error)}
        </p>
      ) : !runs.data ? (
        <p className="muted small">불러오는 중…</p>
      ) : runs.data.length === 0 ? (
        <p className="muted small" data-testid="schedule-runs-empty">
          아직 실행한 적이 없어요.
        </p>
      ) : (
        <div className="tablewrap">
          <table data-testid="schedule-runs">
            <caption className="sr-only">최근 실행 (최근 것부터)</caption>
            <thead>
              <tr>
                <th scope="col">예정 시각</th>
                <th scope="col">종류</th>
                <th scope="col">결과</th>
                <th scope="col" className="num">
                  비용
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.data.map((r) => (
                <tr key={r.id} data-testid="schedule-run">
                  <td>{whenText(r.scheduledAt, timeZone)}</td>
                  <td>{TRIGGER_LABEL[r.trigger]}</td>
                  <td>
                    <span className={`badge ${STATUS_CLASS[r.status]}`}>{STATUS_LABEL[r.status]}</span>
                    {r.errorCode && <span className="small muted"> {CODE_LABEL[r.errorCode]}</span>}
                    {r.attempts > 1 && <span className="small muted"> · {r.attempts}번 시도</span>}
                  </td>
                  <td className="num">{costText(r.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
