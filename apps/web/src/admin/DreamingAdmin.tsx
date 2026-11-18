import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DREAMING_CODE_LABEL,
  DREAMING_PROBLEM_LABEL,
  DREAMING_PROMPT_MAX,
  MEMORY_APPLY_MODE_LABEL,
  MemoryApplyMode,
  DREAMING_STATUS_LABEL,
  DREAMING_TOKEN_CAP,
  DREAMING_TRIGGER_LABEL,
  type DreamingAdmin as View,
  type DreamingChoice,
  type DreamingConfig,
  type DreamingConnectionChoice,
  type DreamingSettings,
  type DreamingUserStatus,
  type SaveYouthDreamingRequest,
} from "@agentlee/shared";
import { adminDreaming, ADMIN_DREAMING_KEY, errorText } from "../api.js";
import { countsText, DreamingSettingsForm } from "../instructions/DreamingPanel.js";

/**
 * 관리자 → 기억 정리 (#146, #188, PRD FR-16.6·16.8): what stays the admin's once each user sets their own 기억 정리
 * (설정 → 내 지침): the server-wide switch, the token cap and which shared API key connections·models users may
 * choose — plus a youth account's settings (it cannot change its own) and a status table of each user's settings,
 * ran / skipped / failed and counts, never anyone's content or prompt. Kept as its own tab rather than folded into
 * 시스템 상태: the allowed pairs and the youth settings are settings, and 시스템 상태 is a read-only health page.
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
          <Status view={v} />
          <p className="muted small">
            켜기·시각·연결·정리 프롬프트는 각자 설정 → 내 지침 → 기억 정리에서 정해요(청소년 계정은 위 표에서
            관리자가). 가족의 기억 내용·제안·프롬프트·DREAMS.md는 관리자도 볼 수 없어요. 이 화면에는 실행
            여부와 건수만 보여요.
          </p>
        </>
      )}
    </div>
  );
}

const pairKey = (c: DreamingChoice) => `${c.runtime}|${c.connectionId ?? ""}|${c.model}`;

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
  const options = view.candidates.flatMap((x) =>
    x.models.map((m) => ({
      pair: { runtime: x.runtime, connectionId: x.id, model: m.id } satisfies DreamingChoice,
      label: `${x.label} · ${m.label}`,
    })),
  );
  const allowed = new Set(c.allowed.map(pairKey));
  const unavailable = new Set(view.unavailable.map(pairKey));
  // Allowed pairs no longer offered (their connection went away) stay listed, to be unticked.
  const gone = c.allowed.filter((a) => !options.some((o) => pairKey(o.pair) === pairKey(a)));
  const toggle = (p: DreamingChoice, on: boolean) =>
    edit({ allowed: on ? [...c.allowed, p] : c.allowed.filter((a) => pairKey(a) !== pairKey(p)) });
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
        하루 한 번, 각자 정한 시각에 그 사람의 새 메시지를 정리해 USER.md·MEMORY.md 변경을 만들어요(검토 후
        반영 또는 자동 반영). 공용 API 키 연결로 도구 없이 돌고, 사용량은 그 사용자의 &quot;기억 정리&quot;로
        남아요.
      </p>
      {view.unavailable.length > 0 && (
        <p className="notice warn small" role="alert" data-testid="dreaming-connection-problem">
          허용한 연결 중 지워지거나 끊긴 것이 있어요. 그 연결을 고른 사용자는 멈춰 있어요 — 연결을 되살리거나
          허용 목록에서 빼 주세요.
        </p>
      )}
      <label className="row">
        <input type="checkbox" checked={c.enabled} onChange={(e) => edit({ enabled: e.target.checked })} />{" "}
        서버 전체에서 기억 정리 쓰기
      </label>
      <p className="muted small">끄면 누구의 기억 정리도 돌지 않아요(각자의 설정은 그대로 남아요).</p>
      <fieldset className="quiet">
        <legend className="small">사용자가 고를 수 있는 연결·모델</legend>
        {options.map((o) => (
          <label key={pairKey(o.pair)} className="row">
            <input
              type="checkbox"
              checked={allowed.has(pairKey(o.pair))}
              onChange={(e) => toggle(o.pair, e.target.checked)}
            />{" "}
            {o.label}
          </label>
        ))}
        {gone.map((a) => (
          <label key={pairKey(a)} className="row">
            <input type="checkbox" checked onChange={() => toggle(a, false)} />{" "}
            <span className="muted">
              {a.model} ({unavailable.has(pairKey(a)) ? "연결이 지워지거나 끊김" : "쓸 수 없음"})
            </span>
          </label>
        ))}
        {!options.length && (
          <p className="muted small">
            고를 수 있는 연결이 없어요. 런타임 탭에서 공용 API 키 연결을 등록하고 테스트를 통과시켜 주세요.
          </p>
        )}
      </fieldset>
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

/** The pairs a youth account may be given: the allowed ones still offered. */
function youthChoices(view: View): DreamingConnectionChoice[] {
  return view.config.allowed.flatMap((a) => {
    const c = view.candidates.find((x) => x.runtime === a.runtime && x.id === a.connectionId);
    const m = c?.models.find((x) => x.id === a.model);
    return c && m ? [{ ...a, label: `${c.label} · ${m.label}` }] : [];
  });
}

function choiceLabel(view: View, s: DreamingSettings): string {
  if (!s.runtime || !s.model) return "—";
  const c = view.candidates.find((x) => x.runtime === s.runtime && x.id === s.connectionId);
  const m = c?.models.find((x) => x.id === s.model);
  return c && m ? `${c.label} · ${m.label}` : `${s.model} (쓸 수 없음)`;
}

function Status({ view }: { view: View }) {
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: ADMIN_DREAMING_KEY });
  const setYouth = useMutation({
    mutationFn: (a: { id: string; body: SaveYouthDreamingRequest }) => adminDreaming.setUser(a.id, a.body),
    onSuccess: refresh,
  });
  const runNow = useMutation({ mutationFn: (id: string) => adminDreaming.runNow(id), onSuccess: refresh });
  const choices = youthChoices(view);
  return (
    <section className="panel" aria-labelledby="dream-status-h">
      <h2 id="dream-status-h">사용자별 상태</h2>
      <table className="usage-table" aria-label="기억 정리 상태">
        <thead>
          <tr>
            <th>사용자</th>
            <th>설정</th>
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
                {u.youth && <span className="badge">청소년</span>}
              </td>
              <td className="small">
                {u.youth ? (
                  <DreamingSettingsForm
                    key={JSON.stringify(u.settings)}
                    label={u.name}
                    settings={u.settings}
                    choices={choices}
                    disabled={false}
                    pending={setYouth.isPending}
                    onSave={(settings) => setYouth.mutate({ id: u.userId, body: settings })}
                  />
                ) : (
                  <>
                    {u.enabled ? `켜짐 · ${u.settings.time}` : "꺼짐"} · {choiceLabel(view, u.settings)}
                    {u.customPrompt && " · 프롬프트 직접 씀"}
                  </>
                )}
                {u.youth && (
                  <YouthExtras
                    user={u}
                    pending={setYouth.isPending}
                    save={(extra) => setYouth.mutateAsync({ id: u.userId, body: extra })}
                  />
                )}
                {u.problem && (
                  <>
                    <br />
                    <span className="muted">{DREAMING_PROBLEM_LABEL[u.problem]}</span>
                  </>
                )}
              </td>
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
      {(setYouth.isError || runNow.isError) && (
        <p className="error small" role="alert">
          {errorText(setYouth.error ?? runNow.error)}
        </p>
      )}
    </section>
  );
}

/**
 * A youth account's 반영 방식 and cleanup prompt (#188 review 1) — the admin sets them. The prompt is write-only: its
 * current text is the account's and is never sent here, only whether it is the default.
 */
function YouthExtras({
  user,
  pending,
  save,
}: {
  user: DreamingUserStatus;
  pending: boolean;
  /** Resolves when saved; rejects on a refusal (the error shows under the table). */
  save: (extra: Pick<SaveYouthDreamingRequest, "applyMode" | "prompt">) => Promise<unknown>;
}) {
  const [prompt, setPrompt] = useState("");
  return (
    <div className="dream-youth-extras">
      <label className="inline">
        반영 방식
        <select
          aria-label={`${user.name} 반영 방식`}
          value={user.applyMode ?? "review"}
          disabled={pending}
          onChange={(e) => void save({ applyMode: e.target.value as MemoryApplyMode }).catch(() => {})}
        >
          {MemoryApplyMode.options.map((m) => (
            <option key={m} value={m}>
              {MEMORY_APPLY_MODE_LABEL[m]}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">
        정리 프롬프트: {user.customPrompt ? "관리자가 새로 씀" : "기본값"} (지금 내용은 여기서 보이지 않아요)
      </p>
      <textarea
        aria-label={`${user.name} 정리 프롬프트 새로 쓰기`}
        rows={3}
        maxLength={DREAMING_PROMPT_MAX}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
      />
      <div className="row wrap">
        <button
          type="button"
          className="small"
          disabled={pending || !prompt.trim()}
          onClick={() => {
            // Cleared only once saved: a refusal (a secret value, …) keeps what was typed (review #195 round 2).
            void save({ prompt }).then(
              () => setPrompt(""),
              () => {},
            );
          }}
        >
          프롬프트 저장
        </button>
        <button
          type="button"
          className="small"
          disabled={pending || !user.customPrompt}
          onClick={() => void save({ prompt: null }).catch(() => {})}
        >
          기본값으로 되돌리기
        </button>
      </div>
    </div>
  );
}
