import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import type { MemoryProposal } from "@agentlee/shared";
import {
  ApiError,
  DREAMING_KEY,
  errorText,
  INSTRUCTIONS_KEY,
  memoryProposalKey,
  memoryProposals,
} from "../api.js";
import {
  cardFromError,
  cardGone,
  cardSummary,
  decisionDiff,
  decisionTitle,
  STATUS_BADGE,
  STATUS_LABEL,
} from "./memory-card.js";

/**
 * The card of `memory_propose` (#145, PRD FR-16.4·16.7) under the reply: each proposed change as a small diff, with
 * 반영 / 거절 per change (and 모두 반영), or — 자동 반영 — "기억했어요 · 되돌리기". Nothing changes until the owner
 * presses it (their own request). Only the owner ever gets a card: a shared viewer's reply has no tool output to find
 * it by, and the API answers anyone else 403 — then nothing is shown.
 */
export function MemoryCard({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: memoryProposalKey(id),
    queryFn: () => memoryProposals.get(id),
    retry: false,
  });
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState<string | null>(null);
  const settle = (p: MemoryProposal) => {
    qc.setQueryData(memoryProposalKey(id), p);
    void qc.invalidateQueries({ queryKey: INSTRUCTIONS_KEY });
    if (p.origin === "dreaming") void qc.invalidateQueries({ queryKey: DREAMING_KEY });
  };
  const act = useMutation({
    mutationFn: (a: { kind: "accept" | "reject"; indexes: number[] } | { kind: "undo" }) =>
      a.kind === "undo" ? memoryProposals.undo(id) : memoryProposals[a.kind](id, a.indexes),
    onMutate: () => {
      setError(null);
      setDone(null);
    },
    onSuccess: (p, a) => {
      settle(p);
      setDone(a.kind === "undo" ? "되돌렸어요." : a.kind === "accept" ? "반영했어요." : "거절했어요.");
    },
    onError: (e) => {
      // Gone meanwhile (its source was deleted): the cached lines go at once, the card says why.
      if (cardGone(e)) qc.removeQueries({ queryKey: memoryProposalKey(id), exact: true });
      const fresh = e instanceof ApiError ? cardFromError(e.body) : undefined;
      if (fresh) settle(fresh);
      setError(e);
    },
  });
  if (cardGone(act.error) || cardGone(q.error))
    return (
      <div className="mem-card small muted" data-testid="memory-card" data-gone="true">
        출처 메시지가 지워져 이 기억 제안도 지웠어요.
      </div>
    );
  if (q.isError) {
    // Not the caller's (403) — a shared view, an admin — shows nothing; a bundle that is gone says so.
    if (q.error instanceof ApiError && q.error.status === 403) return null;
    return (
      <div className="mem-card small muted" data-testid="memory-card">
        기억 제안을 불러오지 못했어요. {errorText(q.error)}
      </div>
    );
  }
  const p = q.data;
  if (!p)
    return (
      <div className="mem-card small muted" data-testid="memory-card">
        기억 제안을 불러오는 중…
      </div>
    );
  const headId = `mem-card-${id}`;
  const pending = p.decisions.filter((d) => d.status === "pending");
  const applied = p.decisions.some((d) => d.status === "applied");
  const busy = act.isPending;
  const summary = cardSummary(p);
  return (
    <section className="mem-card" data-testid="memory-card" aria-labelledby={headId} aria-busy={busy}>
      <div className="row">
        <span aria-hidden>🧠</span>
        <b id={headId} className="grow">
          {p.origin === "dreaming"
            ? applied
              ? "기억 정리가 반영했어요"
              : "기억 정리 제안"
            : applied
              ? "기억했어요"
              : "기억 변경 제안"}
        </b>
        {pending.length > 0 && <span className="badge">확인 필요</span>}
      </div>
      {summary && (
        <p
          className={`small ${p.decisions.some((d) => d.status === "expired") ? "notice warn" : "muted"}`}
          data-testid="memory-card-summary"
        >
          {summary}
        </p>
      )}
      <ul className="mem-decisions">
        {p.decisions.map((d) => {
          const title = decisionTitle(d);
          return (
            <li key={d.index} className="mem-decision" data-testid="memory-decision" data-status={d.status}>
              <div className="row wrap">
                <span className="small muted grow">
                  {title}
                  {d.sensitive && " · 민감한 내용"}
                </span>
                {d.status !== "pending" && (
                  <span className={`badge ${STATUS_BADGE[d.status]}`}>{STATUS_LABEL[d.status]}</span>
                )}
              </div>
              <pre className="diff mem-diff" aria-label={`${title} 변경 내용`}>
                {decisionDiff(d).map((l, i) => (
                  <span key={i} className={`diff-${l.op}`}>
                    <span className="sr-only">{l.op === "add" ? "생김: " : "빠짐: "}</span>
                    <span aria-hidden>{l.op === "add" ? "+ " : "− "}</span>
                    {l.text}
                    {"\n"}
                  </span>
                ))}
              </pre>
              {d.status === "pending" && (
                <div className="row wrap">
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    aria-label={pending.length > 1 ? `${title} 반영` : undefined}
                    onClick={() => act.mutate({ kind: "accept", indexes: [d.index] })}
                  >
                    반영
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={pending.length > 1 ? `${title} 거절` : undefined}
                    onClick={() => act.mutate({ kind: "reject", indexes: [d.index] })}
                  >
                    거절
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {pending.length > 1 && (
        <div className="row">
          <button
            type="button"
            disabled={busy}
            onClick={() => act.mutate({ kind: "accept", indexes: pending.map((d) => d.index) })}
          >
            모두 반영
          </button>
        </div>
      )}
      {applied && p.canUndo && (
        <div className="row">
          <button type="button" disabled={busy} onClick={() => act.mutate({ kind: "undo" })}>
            되돌리기
          </button>
        </div>
      )}
      <p className="small muted">
        <Link to="/settings/instructions?doc=memory">설정 → 내 지침</Link>에서 보고 고칠 수 있어요.
      </p>
      <p className="small" role="status" aria-live="polite" data-testid="memory-card-status">
        {done}
      </p>
      {/* An expiry is the summary above ("다시 요청해 주세요"); anything else is said here. */}
      {error !== null && !(error instanceof ApiError && error.code === "proposal_expired") && (
        <p className="error small" role="alert" data-testid="memory-card-error">
          {errorText(error)}
        </p>
      )}
    </section>
  );
}
