import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DREAMING_CODE_LABEL,
  DREAMING_STATUS_LABEL,
  DREAMING_TOKEN_CAP,
  DREAMING_TRIGGER_LABEL,
  MEMORY_DOC_FILE,
  type DreamingAdmin as View,
  type DreamingConfig,
  type DreamingCounts,
  type DreamingPreview,
} from "@agentlee/shared";
import { adminDreaming, ADMIN_DREAMING_KEY, errorText } from "../api.js";

/**
 * 관리자 → 기억 정리 (#146, PRD FR-16.6·16.8): the switches (all, per user), the time (Asia/Seoul, users 5 minutes
 * apart), the shared API key connection and its model, the token cap, the cleanup prompt (versions; 미리 실행 on the
 * admin's own data only) and a status table — ran / skipped / failed and counts, never anyone's content.
 */
export function DreamingAdmin() {
  const q = useQuery({ queryKey: ADMIN_DREAMING_KEY, queryFn: adminDreaming.get });
  const v = q.data;
  return (
    <div className="admin-dreaming" data-testid="admin-dreaming">
      {q.isError && <p className="error">{errorText(q.error)}</p>}
      {v && (
        <>
          <Settings view={v} />
          <Prompt view={v} />
          <Status view={v} />
          <p className="muted small">
            가족의 기억 내용·제안·DREAMS.md는 관리자도 볼 수 없어요. 이 화면에는 실행 여부와 건수만 보여요.
          </p>
        </>
      )}
    </div>
  );
}

const choiceKey = (c: { runtime: string | null; connectionId: string | null; model: string | null }) =>
  c.runtime && c.model ? `${c.runtime}|${c.connectionId ?? ""}|${c.model}` : "";

function Settings({ view }: { view: View }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<DreamingConfig>();
  const [saved, setSaved] = useState(false);
  const c = draft ?? view.config;
  const save = useMutation({
    mutationFn: () => adminDreaming.save(c),
    onSuccess: (v) => {
      qc.setQueryData(ADMIN_DREAMING_KEY, v);
      setDraft(undefined);
      setSaved(true);
    },
  });
  const edit = (p: Partial<DreamingConfig>) => {
    setSaved(false);
    setDraft({ ...c, ...p });
  };
  const options = view.connections.flatMap((x) =>
    x.models.map((m) => ({
      key: `${x.runtime}|${x.id ?? ""}|${m.id}`,
      label: `${x.label} · ${m.label}`,
      runtime: x.runtime,
      connectionId: x.id,
      model: m.id,
    })),
  );
  const current = choiceKey(c);
  return (
    <form
      className="panel"
      aria-labelledby="dream-settings-h"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <h2 id="dream-settings-h">기억 정리</h2>
      <p className="muted small">
        하루 한 번 가족 각자의 새 메시지를 정리해 USER.md·MEMORY.md 변경을 만들어요(사용자가 정한 방식대로
        검토 후 반영 또는 자동 반영). 공용 API 키 연결로 도구 없이 돌고, 사용량은 그 사용자의 &quot;기억
        정리&quot;로 남아요.
      </p>
      {view.connectionProblem && (
        <p className="notice warn small" role="alert" data-testid="dreaming-connection-problem">
          {view.connectionProblem === "missing"
            ? "지정한 연결을 쓸 수 없어 기억 정리가 멈춰 있어요. 연결을 다시 고르세요."
            : "지정한 연결이 공용 API 키 연결이 아니에요. 연결을 다시 고르세요."}
        </p>
      )}
      <label className="row">
        <input type="checkbox" checked={c.enabled} onChange={(e) => edit({ enabled: e.target.checked })} />{" "}
        기억 정리 켜기
      </label>
      <div className="row wrap">
        <label className="inline">
          실행 시각 (Asia/Seoul)
          <input
            type="time"
            value={c.time}
            required
            aria-label="실행 시각"
            onChange={(e) => edit({ time: e.target.value })}
          />
        </label>
        <span className="muted small">사용자마다 5분씩 늦게 시작해요.</span>
      </div>
      <label className="inline">
        연결·모델
        <select
          aria-label="연결·모델"
          value={options.some((o) => o.key === current) ? current : ""}
          onChange={(e) => {
            const o = options.find((x) => x.key === e.target.value);
            edit(
              o
                ? { runtime: o.runtime, connectionId: o.connectionId, model: o.model }
                : { runtime: null, connectionId: null, model: null },
            );
          }}
        >
          <option value="">고르세요</option>
          {options.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {!options.length && (
        <p className="muted small">
          고를 수 있는 연결이 없어요. 런타임 탭에서 공용 API 키 연결을 등록하고 테스트를 통과시켜 주세요.
        </p>
      )}
      <label className="inline">
        1회 토큰 상한
        <input
          type="number"
          aria-label="1회 토큰 상한"
          min={DREAMING_TOKEN_CAP.min}
          max={DREAMING_TOKEN_CAP.max}
          step={1000}
          value={c.tokenCap}
          onChange={(e) => edit({ tokenCap: Number(e.target.value) })}
        />
      </label>
      <div className="row">
        <button type="submit" className="primary" disabled={save.isPending}>
          저장
        </button>
        {saved && (
          <span className="small" role="status">
            저장했어요.
          </span>
        )}
      </div>
      {save.isError && (
        <p className="error small" role="alert">
          {errorText(save.error)}
        </p>
      )}
    </form>
  );
}

function Prompt({ view }: { view: View }) {
  const qc = useQueryClient();
  const [text, setText] = useState<string>();
  const [base, setBase] = useState<number>();
  const [showVersions, setShowVersions] = useState(false);
  const [preview, setPreview] = useState<DreamingPreview>();
  const content = text ?? view.prompt.content;
  const baseVersion = base ?? view.prompt.version;
  const refresh = () => void qc.invalidateQueries({ queryKey: ADMIN_DREAMING_KEY });
  const save = useMutation({
    mutationFn: () => adminDreaming.savePrompt(content, baseVersion),
    onSuccess: () => {
      setText(undefined);
      setBase(undefined);
      refresh();
    },
  });
  const versions = useQuery({
    queryKey: [...ADMIN_DREAMING_KEY, "versions", view.prompt.version],
    queryFn: adminDreaming.versions,
    enabled: showVersions,
  });
  const restore = useMutation({
    mutationFn: (v: number) => adminDreaming.restore(v, view.prompt.version),
    onSuccess: () => {
      setText(undefined);
      setBase(undefined);
      refresh();
    },
  });
  const run = useMutation({
    mutationFn: () => adminDreaming.preview(content),
    onMutate: () => setPreview(undefined),
    onSuccess: (p) => setPreview(p),
  });
  return (
    <section className="panel" aria-labelledby="dream-prompt-h">
      <h2 id="dream-prompt-h">정리 프롬프트</h2>
      <p className="muted small">
        무엇을 고르고 어떻게 적을지만 정해요. 출력 형식·금지 규칙·검증은 고정이라 바꿀 수 없어요. 가족은 지금
        쓰는 프롬프트를 볼 수 있어요. 버전 {view.prompt.version || "기본"}
      </p>
      <textarea
        aria-label="정리 프롬프트"
        rows={8}
        value={content}
        onChange={(e) => {
          setText(e.target.value);
          if (base === undefined) setBase(view.prompt.version);
        }}
      />
      <div className="row wrap">
        <button
          type="button"
          className="primary"
          disabled={save.isPending || text === undefined}
          onClick={() => save.mutate()}
        >
          프롬프트 저장
        </button>
        <button type="button" disabled={run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? "미리 실행 중…" : "미리 실행 (내 데이터)"}
        </button>
        <button type="button" onClick={() => setShowVersions((x) => !x)} aria-expanded={showVersions}>
          버전
        </button>
      </div>
      {(save.isError || run.isError || restore.isError) && (
        <p className="error small" role="alert">
          {errorText(save.error ?? run.error ?? restore.error)}
        </p>
      )}
      <details>
        <summary className="small">고정 규칙 (수정 불가)</summary>
        <pre className="small dream-rules">{view.prompt.fixedRules}</pre>
      </details>
      {showVersions && (
        <ul className="small" aria-label="프롬프트 버전">
          {(versions.data ?? []).map((x) => (
            <li key={x.version} className="row wrap">
              <span className="grow">
                v{x.version} · {new Date(x.createdAt).toLocaleString("ko-KR")}
                {x.restoredFrom ? ` (v${x.restoredFrom} 되돌림)` : ""}
              </span>
              {x.version !== view.prompt.version && (
                <button
                  type="button"
                  className="small"
                  disabled={restore.isPending}
                  onClick={() => restore.mutate(x.version)}
                >
                  이 버전으로 되돌리기
                </button>
              )}
            </li>
          ))}
          {versions.data?.length === 0 && <li className="muted">저장한 버전이 없어요(기본 프롬프트).</li>}
        </ul>
      )}
      {preview && (
        <div className="dream-preview" data-testid="dreaming-preview" role="status">
          <p className="small">
            미리 실행 결과(내 데이터만, 반영하지 않음): <b>{DREAMING_STATUS_LABEL[preview.status]}</b>
            {preview.code ? ` — ${DREAMING_CODE_LABEL[preview.code] ?? preview.code}` : ""} ·{" "}
            {countsText(preview.counts)}
          </p>
          {preview.decisions.length > 0 && (
            <ul className="small">
              {preview.decisions.map((d, i) => (
                <li key={i}>
                  {MEMORY_DOC_FILE[d.doc]} · {d.action}
                  {d.before ? ` — ${d.before.replace(/\n/g, " / ")}` : ""}
                  {d.text ? ` → ${d.text}` : ""}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

export function countsText(c: DreamingCounts): string {
  const refused = Object.values(c.refused).reduce((a, b) => a + (b ?? 0), 0);
  return [
    `새 메시지 ${c.newMessages}`,
    c.queuedMessages ? `다시 처리 ${c.queuedMessages}` : "",
    `제안 ${c.proposed}`,
    `반영 ${c.applied}`,
    refused ? `거부 ${refused}` : "",
    c.skippedOld ? "오래된 대화 건너뜀" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

const TODAY_LABEL: Record<string, string> = {
  waiting: "대기",
  running: "실행 중",
  done: "끝남",
  failed: "실패",
  skipped: "건너뜀",
  missed: "오늘은 없음",
  expired: "자정 지나 없음",
  paused: "멈춤",
};

function Status({ view }: { view: View }) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ADMIN_DREAMING_KEY });
  const toggle = useMutation({
    mutationFn: (a: { id: string; enabled: boolean }) => adminDreaming.setUser(a.id, a.enabled),
    onSuccess: refresh,
  });
  const runNow = useMutation({ mutationFn: (id: string) => adminDreaming.runNow(id), onSuccess: refresh });
  return (
    <section className="panel" aria-labelledby="dream-status-h">
      <h2 id="dream-status-h">사용자별 상태</h2>
      <table className="usage-table" aria-label="기억 정리 상태">
        <thead>
          <tr>
            <th>사용자</th>
            <th>켜기</th>
            <th>시각</th>
            <th>오늘</th>
            <th>마지막 실행</th>
          </tr>
        </thead>
        <tbody>
          {view.users.map((u) => (
            <tr key={u.userId} data-testid="dreaming-user">
              <td>
                {u.name}
                {!u.active && <span className="badge gray">비활성</span>}
              </td>
              <td>
                <input
                  type="checkbox"
                  aria-label={`${u.name} 기억 정리`}
                  checked={u.enabled}
                  disabled={toggle.isPending}
                  onChange={(e) => toggle.mutate({ id: u.userId, enabled: e.target.checked })}
                />
              </td>
              <td>{u.time ?? "—"}</td>
              <td>{u.today ? (TODAY_LABEL[u.today] ?? u.today) : "—"}</td>
              <td className="small">
                {u.last ? (
                  <>
                    <b>{DREAMING_STATUS_LABEL[u.last.status]}</b> ({DREAMING_TRIGGER_LABEL[u.last.trigger]},{" "}
                    {new Date(u.last.startedAt).toLocaleString("ko-KR")})
                    {u.last.code ? ` — ${DREAMING_CODE_LABEL[u.last.code] ?? u.last.code}` : ""}
                    <br />
                    {countsText(u.last.counts)}
                  </>
                ) : (
                  "—"
                )}
                {view.manualRuns && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="small"
                      disabled={runNow.isPending}
                      onClick={() => runNow.mutate(u.userId)}
                    >
                      지금 실행
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {(toggle.isError || runNow.isError) && (
        <p className="error small" role="alert">
          {errorText(toggle.error ?? runNow.error)}
        </p>
      )}
    </section>
  );
}
