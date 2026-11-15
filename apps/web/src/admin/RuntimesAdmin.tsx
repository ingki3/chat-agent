import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Connection, ConnectionTestResult, RuntimeId } from "@agentlee/shared";
import { admin, errorText } from "../api.js";
import { RUNTIME_LABEL } from "../DefaultsEditor.js";

const STATUS: Record<Connection["status"], [string, string]> = {
  passed: ["사용 가능", "ok"],
  untested: ["테스트 필요", "gray"],
  failed: ["테스트 실패", "err"],
  expired: ["연결 끊김", "err"],
};
const yes = (b: boolean) => (b ? "예" : "아니요");

/** The FR-11.4 notice, shown wherever a connection is registered for someone else. */
const OWN_ONLY =
  "본인 구독만 연결하세요. 한 사람의 구독을 여러 명이 쓰는 것은 이용 정책에 어긋날 수 있습니다.";

/** Connection rows with test and remove. Only the masked hint or the login email is shown — never a key. */
function ConnectionTable({
  items,
  label,
  onTest,
  onRemove,
}: {
  items: Connection[];
  label: string;
  onTest: (c: Connection) => Promise<ConnectionTestResult>;
  onRemove: (c: Connection) => Promise<unknown>;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<string>();
  const act = async (c: Connection, fn: () => Promise<string>) => {
    setBusy(c.id);
    setMessage(undefined);
    try {
      setMessage(await fn());
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setBusy(undefined);
      void qc.invalidateQueries({ queryKey: ["admin"] });
    }
  };
  if (items.length === 0) return <p className="muted small">연결이 없어요.</p>;
  return (
    <>
      <table className="devices" aria-label={label}>
        <tbody>
          {items.map((c) => {
            const [text, cls] = STATUS[c.status];
            return (
              <tr key={c.id} data-testid="admin-connection">
                <td>
                  <b>{c.label}</b>
                  <br />
                  <span className="muted small">
                    {RUNTIME_LABEL[c.runtime]} · {c.authType === "subscription" ? "구독" : "API 키"}
                    {c.accountEmail ? ` · ${c.accountEmail}` : c.hint ? ` · ${c.hint}` : ""}
                    {c.registeredByAdmin ? " · 관리자가 등록" : ""}
                    {c.lastTestCode ? ` · 마지막 테스트: ${c.lastTestCode}` : ""}
                  </span>
                </td>
                <td>
                  <span className={`badge ${cls}`}>{text}</span>
                </td>
                <td className="actions">
                  <button
                    type="button"
                    className="small"
                    disabled={busy === c.id}
                    onClick={() =>
                      void act(c, async () => {
                        const r = await onTest(c);
                        return r.status === "passed" ? "테스트를 통과했어요." : `테스트 실패: ${r.code}`;
                      })
                    }
                  >
                    {busy === c.id ? "테스트 중…" : "테스트"}
                  </button>
                  <button
                    type="button"
                    className="small"
                    aria-label={`${c.label} 삭제`}
                    disabled={busy === c.id}
                    onClick={() => {
                      if (window.confirm("이 연결을 삭제할까요? 대화 기록은 남아요."))
                        void act(c, async () => {
                          await onRemove(c);
                          return "연결을 삭제했어요.";
                        });
                    }}
                  >
                    삭제
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {message && (
        <p className="small" role="status">
          {message}
        </p>
      )}
    </>
  );
}

/** Adds an API key connection (shared, or a member's personal one). The key leaves the page once and never returns. */
function AddKey({
  label,
  runtimes,
  onAdd,
}: {
  label: string;
  runtimes: RuntimeId[];
  onAdd: (runtime: RuntimeId, secret: string) => Promise<unknown>;
}) {
  const qc = useQueryClient();
  const [runtime, setRuntime] = useState<RuntimeId>(runtimes[0] ?? "claude-code");
  const [secret, setSecret] = useState("");
  const [message, setMessage] = useState<string>();
  const add = useMutation({
    mutationFn: () => onAdd(runtime, secret),
    onMutate: () => setMessage(undefined),
    onSuccess: () => {
      setSecret("");
      setMessage("연결을 추가했어요. ‘테스트’를 눌러 통과하면 쓸 수 있어요.");
    },
    onError: (e) => setMessage(errorText(e)),
    onSettled: () => qc.invalidateQueries({ queryKey: ["admin"] }),
  });
  return (
    <form
      className="add-connection"
      aria-label={label}
      onSubmit={(e) => {
        e.preventDefault();
        if (secret.trim()) add.mutate();
      }}
    >
      <label className="field">
        <span>런타임</span>
        <select value={runtime} onChange={(e) => setRuntime(e.target.value as RuntimeId)}>
          {runtimes.map((r) => (
            <option key={r} value={r}>
              {RUNTIME_LABEL[r]} · API 키
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>API 키</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={secret}
          placeholder={runtime === "claude-code" ? "sk-ant-…" : "sk-…"}
          onChange={(e) => setSecret(e.target.value)}
        />
      </label>
      <button type="submit" className="primary" disabled={add.isPending || !secret.trim()}>
        {add.isPending ? "추가하는 중…" : "연결 추가"}
      </button>
      {message && (
        <p className="small" role="status">
          {message}
        </p>
      )}
    </form>
  );
}

/** 관리자 → 런타임 (#35, FR-10.2 / FR-11): models and capabilities, shared connections, members' own connections. */
export function RuntimesAdmin() {
  const runtimes = useQuery({ queryKey: ["admin", "runtimes"], queryFn: admin.runtimes });
  const shared = useQuery({ queryKey: ["admin", "shared"], queryFn: admin.sharedConnections });
  const users = useQuery({ queryKey: ["admin", "users"], queryFn: admin.users });
  const [selected, setSelected] = useState("");
  const active = users.data?.filter((u) => u.active) ?? [];
  const user = active.find((u) => u.id === selected) ?? active[0];
  const personal = useQuery({
    queryKey: ["admin", "personal", user?.id],
    queryFn: () => admin.userConnections(user!.id),
    enabled: !!user,
  });
  const ids: RuntimeId[] = ["claude-code", "codex"];
  return (
    <section className="admin" aria-label="런타임">
      <h2>런타임별 모델</h2>
      {runtimes.isError && <p className="error small">{errorText(runtimes.error)}</p>}
      {runtimes.data?.map((r) => (
        <div key={r.runtime} className="runtime-models" data-testid="runtime-models">
          <h3>
            {RUNTIME_LABEL[r.runtime]} {!r.registered && <span className="badge gray">이 서버에 없음</span>}
          </h3>
          {r.registered && (
            <>
              <p className="muted small">
                이어 쓰기 {yes(r.capabilities.canResume)} · 세션 안 모델 변경{" "}
                {yes(r.capabilities.canSwitchModelInSession)} · 공통 도구 {yes(r.capabilities.usesTools)} ·
                연결 필요 {yes(r.capabilities.needsConnection)}
              </p>
              <table className="devices" aria-label={`${RUNTIME_LABEL[r.runtime]} 모델`}>
                <thead>
                  <tr>
                    <th>모델</th>
                    <th>추론 강도</th>
                  </tr>
                </thead>
                <tbody>
                  {r.models.map((m) => (
                    <tr key={m.id}>
                      <td>
                        {m.label}
                        <br />
                        <code className="small">{m.id}</code>
                      </td>
                      <td>
                        {m.efforts.length ? m.efforts.join(" · ") : "없음"}
                        {m.defaultEffort ? ` (기본 ${m.defaultEffort})` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>
      ))}
      <p className="muted small">누가 어떤 모델을 쓸지는 ‘권한’ 탭에서 사용자별로 정해요.</p>

      <h2>가족 공용 연결</h2>
      <p className="muted small">
        공용 연결은 API 키로만 만들어요. 권한에서 ‘가족 공용 연결 허용’한 가족이 써요.
      </p>
      {shared.isError && <p className="error small">{errorText(shared.error)}</p>}
      {shared.data && (
        <ConnectionTable
          items={shared.data}
          label="가족 공용 연결"
          onTest={(c) => admin.testShared(c.id)}
          onRemove={(c) => admin.removeShared(c.id)}
        />
      )}
      <AddKey
        label="공용 연결 추가"
        runtimes={ids}
        onAdd={(runtime, secret) => admin.addShared({ runtime, secret })}
      />

      <h2>가족 대신 개인 연결 등록</h2>
      <div className="notice warn small" role="note" data-testid="behalf-notice">
        {OWN_ONLY}
        <br />
        여기서는 그 사람의 API 키만 등록할 수 있어요. 구독 로그인(ChatGPT 계정, Claude 구독)은 그 사람이 직접
        자기 설정 → 내 런타임 연결에서 해야 해요. 등록한 키는 관리자도 다시 볼 수 없어요(삭제만 가능).
      </div>
      <label className="field">
        <span>가족</span>
        <select aria-label="가족 선택" value={user?.id ?? ""} onChange={(e) => setSelected(e.target.value)}>
          {active.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name} ({u.email})
            </option>
          ))}
        </select>
      </label>
      {user && personal.data && (
        <ConnectionTable
          items={personal.data}
          label={`${user.name} 개인 연결`}
          onTest={(c) => admin.testUserConnection(user.id, c.id)}
          onRemove={(c) => admin.removeUserConnection(user.id, c.id)}
        />
      )}
      {user && (
        <AddKey
          key={user.id}
          label={`${user.name} 대신 연결 추가`}
          runtimes={ids}
          onAdd={(runtime, secret) => admin.addUserConnection(user.id, { runtime, secret })}
        />
      )}
    </section>
  );
}
