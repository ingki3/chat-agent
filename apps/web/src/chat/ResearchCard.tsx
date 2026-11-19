import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  RESEARCH_ENDED,
  RESEARCH_LIMITS,
  ResearchJob,
  type ResearchQuestionState,
  type ResearchScope,
} from "@agentlee/shared";
import { errorText, research } from "../api.js";
import "./research.css";

/**
 * The 깊이 조사 card (#211) in its conversation: the plan to approve, edit or cancel (nothing is searched before 승인),
 * the clarifying question, the live progress — stage, each sub-question, sources found, time used against the 30-minute
 * cap — with 중지, and the end. Its report is the artifact card the server adds to the same message. The job runs on
 * the server: closing the page changes nothing; the card follows it again when shown. Only the owner gets buttons.
 */

const key = (id: string) => ["research", id] as const;

const STATUS_TEXT: Record<ResearchJob["status"], string> = {
  planning: "계획을 세우는 중이에요…",
  clarifying: "질문을 조금 더 알려 주세요",
  awaiting_approval: "계획을 확인해 주세요",
  researching: "조사하는 중이에요",
  writing: "보고서를 쓰고 검증하는 중이에요",
  done: "보고서를 만들었어요",
  failed: "깊이 조사를 마치지 못했어요",
  stopped: "중지했어요",
  cancelled: "취소했어요",
};

const ERROR_TEXT: Record<string, string> = {
  no_connection: "Claude 연결이 없어요 — 설정 → 내 런타임 연결을 확인해 주세요.",
  runtime_auth: "런타임 로그인이 만료됐거나 키가 맞지 않아요.",
  usage_limit: "사용 한도에 도달했어요.",
  runtime_error: "조사 중 오류가 났어요.",
  plan_failed: "계획을 세우지 못했어요. 질문을 바꿔 다시 시도해 보세요.",
  no_findings: "확인된 근거를 하나도 찾지 못했어요.",
  server_restart: "서버 재시작으로 중단됐어요.",
  conversation_gone: "대화가 삭제됐어요.",
  not_allowed: "이 계정은 지금 Claude를 쓸 수 없어요.",
};

const SCOPE_TEXT: Record<ResearchScope, string> = { web: "웹", files: "첨부 파일", both: "웹 + 첨부" };
const Q_ICON: Record<ResearchQuestionState["status"], string> = {
  waiting: "⏳",
  running: "🔎",
  done: "✅",
  capped: "⏱",
  failed: "⚠️",
};

const minutes = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}분 ${String(s % 60).padStart(2, "0")}초`;
};

/** Follows the job live (server-sent events) while it can still change; a page that cannot falls back to polling. */
function useResearch(id: string) {
  const qc = useQueryClient();
  const [polling, setPolling] = useState(false);
  const q = useQuery({
    queryKey: key(id),
    queryFn: () => research.get(id),
    refetchInterval: (query) =>
      polling && query.state.data && !RESEARCH_ENDED.has(query.state.data.status) ? 3000 : false,
  });
  const status = q.data?.status;
  const live = !!status && !RESEARCH_ENDED.has(status);
  useEffect(() => {
    if (!live || typeof EventSource === "undefined") return;
    const es = new EventSource(research.eventsUrl(id));
    es.addEventListener("job", (e) => {
      const parsed = ResearchJob.safeParse(JSON.parse((e as MessageEvent<string>).data));
      if (parsed.success) qc.setQueryData(key(id), parsed.data);
    });
    es.onerror = () => {
      es.close();
      setPolling(true);
    };
    return () => es.close();
  }, [id, live, qc]);
  // Ended: the card's message has its summary and report card now.
  const ended = !!status && RESEARCH_ENDED.has(status);
  const conversationId = q.data?.conversationId;
  useEffect(() => {
    if (ended && conversationId) void qc.invalidateQueries({ queryKey: ["messages", conversationId] });
  }, [ended, conversationId, qc]);
  return q;
}

export function ResearchCard({ jobId }: { jobId: string }) {
  const q = useResearch(jobId);
  const job = q.data;
  if (q.isError)
    return (
      <div className="research-card" data-testid="research-card">
        <p className="error small">깊이 조사를 불러오지 못했어요. {errorText(q.error)}</p>
      </div>
    );
  if (!job)
    return (
      <div className="research-card" data-testid="research-card">
        <p className="muted small">깊이 조사를 불러오는 중…</p>
      </div>
    );
  return (
    <div className="research-card" data-testid="research-card" data-status={job.status}>
      <div className="research-head">
        <strong>🔬 깊이 조사</strong>
        <span className="muted small" data-testid="research-status">
          {STATUS_TEXT[job.status]}
        </span>
      </div>
      <Body job={job} />
    </div>
  );
}

function Body({ job }: { job: ResearchJob }) {
  switch (job.status) {
    case "planning":
      return (
        <>
          <p className="small">
            「{job.question}」 — 하위 질문과 조사 범위를 정하고 있어요. 아직 아무것도 검색하지 않아요.
          </p>
          {job.owned && <Actions job={job} cancel />}
        </>
      );
    case "clarifying":
      return <Clarify job={job} />;
    case "awaiting_approval":
      return <PlanReview job={job} />;
    case "researching":
    case "writing":
      return <Progress job={job} />;
    case "done":
      return (
        <>
          <Questions job={job} />
          <p className="small" data-testid="research-result">
            출처 {job.result?.citations ?? 0}개 · 확인하지 못해 뺀 문장 {job.result?.removed ?? 0}개
            {job.result?.timedOut ? " · 시간 상한(30분)으로 일부만 조사" : ""}
          </p>
        </>
      );
    default:
      return (
        <p className="small" data-testid="research-ended">
          {job.status === "failed"
            ? (ERROR_TEXT[job.errorCode ?? ""] ?? STATUS_TEXT.failed)
            : STATUS_TEXT[job.status]}
        </p>
      );
  }
}

function useAction<A>(job: ResearchJob, fn: (a: A) => Promise<ResearchJob>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    // The live stream may have brought newer states before this answer arrived (an approval's first progress comes
    // at once): the answer is kept only when the card has not seen its state yet.
    onSuccess: (next) =>
      qc.setQueryData<ResearchJob>(key(job.id), (old) => (old && old.status === next.status ? old : next)),
    onError: () => void qc.invalidateQueries({ queryKey: key(job.id) }),
  });
}

function Actions({ job, cancel, stop }: { job: ResearchJob; cancel?: boolean; stop?: boolean }) {
  const c = useAction(job, () => research.cancel(job.id));
  const s = useAction(job, () => research.stop(job.id));
  return (
    <div className="research-actions">
      {cancel && (
        <button
          type="button"
          className="ghost small"
          disabled={c.isPending}
          onClick={() => c.mutate(undefined)}
          data-testid="research-cancel"
        >
          취소
        </button>
      )}
      {stop && (
        <button
          type="button"
          className="small"
          disabled={s.isPending}
          onClick={() => s.mutate(undefined)}
          data-testid="research-stop"
        >
          ■ 중지
        </button>
      )}
      {(c.isError || s.isError) && (
        <span className="error small" role="alert">
          {errorText(c.error ?? s.error)}
        </span>
      )}
    </div>
  );
}

function Clarify({ job }: { job: ResearchJob }) {
  const [answer, setAnswer] = useState("");
  const send = useAction(job, (a: string) => research.clarify(job.id, a));
  return (
    <>
      <p className="small">{job.clarify?.question}</p>
      {job.owned && (
        <form
          className="research-clarify"
          onSubmit={(e) => {
            e.preventDefault();
            if (answer.trim()) send.mutate(answer.trim());
          }}
        >
          <input
            aria-label="확인 질문에 답하기"
            value={answer}
            maxLength={RESEARCH_LIMITS.clarifyChars}
            onChange={(e) => setAnswer(e.target.value)}
          />
          <button type="submit" className="primary small" disabled={!answer.trim() || send.isPending}>
            답하기
          </button>
          <Actions job={job} cancel />
          {send.isError && (
            <span className="error small" role="alert">
              {errorText(send.error)}
            </span>
          )}
        </form>
      )}
    </>
  );
}

type Draft = { question: string; scope: ResearchScope }[];

function PlanReview({ job }: { job: ResearchJob }) {
  const plan = job.plan!;
  const [draft, setDraft] = useState<Draft | null>(null);
  const approve = useAction(job, (d: Draft | undefined) => research.approve(job.id, d));
  const scopes: ResearchScope[] = job.files ? ["web", "files", "both"] : ["web"];
  const valid = !draft || (draft.length > 0 && draft.every((q) => q.question.trim()));
  return (
    <>
      <p className="small">
        <strong data-testid="research-plan-title">{plan.title}</strong> · 예상 {plan.estimateMinutes}분 · 최대
        30분
        {job.files ? ` · 첨부 파일 ${job.files}개` : ""}
      </p>
      {draft ? (
        <ol className="research-plan edit" data-testid="research-plan">
          {draft.map((q, i) => (
            <li key={i}>
              <input
                aria-label={`하위 질문 ${i + 1}`}
                value={q.question}
                maxLength={RESEARCH_LIMITS.subQuestionChars}
                onChange={(e) =>
                  setDraft(draft.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)))
                }
              />
              {scopes.length > 1 && (
                <select
                  aria-label={`하위 질문 ${i + 1} 범위`}
                  value={q.scope}
                  onChange={(e) =>
                    setDraft(
                      draft.map((x, j) => (j === i ? { ...x, scope: e.target.value as ResearchScope } : x)),
                    )
                  }
                >
                  {scopes.map((s) => (
                    <option key={s} value={s}>
                      {SCOPE_TEXT[s]}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                className="ghost small"
                aria-label={`하위 질문 ${i + 1} 빼기`}
                disabled={draft.length <= 1}
                onClick={() => setDraft(draft.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <ol className="research-plan" data-testid="research-plan">
          {plan.subQuestions.map((q) => (
            <li key={q.id} data-testid="research-plan-item">
              {q.question} <span className="chip small">{SCOPE_TEXT[q.scope]}</span>
            </li>
          ))}
        </ol>
      )}
      <p className="muted small">
        승인하면 {job.files ? "웹 검색과 첨부 파일 읽기를" : "웹 검색을"} 시작해요. 화면을 닫아도 계속하고,
        끝나면 알려 드려요.
      </p>
      {job.owned && (
        <div className="research-actions">
          {draft && draft.length < RESEARCH_LIMITS.maxSubQuestions && (
            <button
              type="button"
              className="ghost small"
              onClick={() => setDraft([...draft, { question: "", scope: "web" }])}
            >
              + 질문 추가
            </button>
          )}
          <button
            type="button"
            className="primary small"
            disabled={approve.isPending || !valid}
            onClick={() => approve.mutate(draft ?? undefined)}
            data-testid="research-approve"
          >
            {draft ? "고친 계획으로 승인" : "승인"}
          </button>
          {draft ? (
            <button type="button" className="ghost small" onClick={() => setDraft(null)}>
              되돌리기
            </button>
          ) : (
            <button
              type="button"
              className="small"
              onClick={() =>
                setDraft(plan.subQuestions.map((q) => ({ question: q.question, scope: q.scope })))
              }
              data-testid="research-edit"
            >
              고치기
            </button>
          )}
          <Actions job={job} cancel />
          {approve.isError && (
            <span className="error small" role="alert">
              {errorText(approve.error)}
            </span>
          )}
        </div>
      )}
    </>
  );
}

function Questions({ job }: { job: ResearchJob }) {
  return (
    <ul className="research-questions" data-testid="research-progress">
      {job.questions.map((q) => (
        <li key={q.id} data-testid="research-question" data-status={q.status}>
          <span aria-hidden>{Q_ICON[q.status]}</span>{" "}
          {q.round > 0 ? <span className="chip small">보강</span> : null} {q.question}{" "}
          <span className="muted small">· 출처 {q.sources}개</span>
        </li>
      ))}
    </ul>
  );
}

function Progress({ job }: { job: ResearchJob }) {
  // The time used ticks on screen between the server's updates.
  const [now, setNow] = useState(() => Date.now());
  const [base] = useState(() => ({ at: Date.now(), elapsed: job.elapsedMs }));
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const elapsed = Math.max(job.elapsedMs, base.elapsed + (now - base.at));
  const stage =
    job.status === "writing" ? "작성·검증" : job.round > 0 ? `보강 조사 ${job.round}단계` : "조사";
  return (
    <>
      <p className="small" data-testid="research-stage">
        {stage} · 찾은 출처 {job.sources}개 · {minutes(Math.min(elapsed, RESEARCH_LIMITS.totalMs))} / 30분
      </p>
      <Questions job={job} />
      {job.owned && <Actions job={job} stop />}
    </>
  );
}
