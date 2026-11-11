import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Connection, ConnectionAuthType, ConnectionTestResult, RuntimeId } from "@agentlee/shared";
import { connections, errorText } from "../api.js";

const KEY = ["connections"] as const;

const RUNTIME: Record<RuntimeId, string> = { "claude-code": "Claude Code", codex: "Codex" };
const STATUS: Record<Connection["status"], [string, string]> = {
  passed: ["사용 가능", "ok"],
  untested: ["테스트 필요", "gray"],
  failed: ["테스트 실패", "err"],
  expired: ["연결 끊김", "err"],
};
const TEST_CODE: Record<string, string> = {
  ok: "통과",
  test_no_reply: "응답이 없어요",
  test_no_stream: "스트리밍이 오지 않았어요",
  test_no_tool: "공통 도구(echo_time)를 부르지 못했어요",
  test_no_skill: "검증용 스킬을 실행하지 못했어요",
  runtime_auth: "키나 토큰이 맞지 않거나 만료됐어요",
  timeout: "시간 안에 끝나지 않았어요",
  usage_limit: "사용 한도에 걸렸어요",
  no_runtime: "이 런타임을 이 서버에서 쓸 수 없어요",
};

type Option = { runtime: RuntimeId; authType: ConnectionAuthType; label: string; placeholder: string };

/**
 * 설정 → 내 런타임 연결 (#17, FR-11.1 / FR-12.7): add, test, disconnect personal connections. Only "사용 가능"
 * (a passed test) connections are used. The Claude subscription option is shown to the admin only (PRD D2);
 * each member's ChatGPT login comes with #18.
 */
export function RuntimeConnections({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: KEY, queryFn: connections.list });
  const options: Option[] = [
    { runtime: "claude-code", authType: "api_key", label: "Claude Code · API 키", placeholder: "sk-ant-…" },
    ...(isAdmin
      ? [
          {
            runtime: "claude-code" as const,
            authType: "subscription" as const,
            label: "Claude Code · 관리자 본인 구독 (claude setup-token)",
            placeholder: "claude setup-token으로 받은 토큰",
          },
        ]
      : []),
    { runtime: "codex", authType: "api_key", label: "Codex · OpenAI API 키", placeholder: "sk-…" },
  ];
  const [choice, setChoice] = useState(0);
  const [secret, setSecret] = useState("");
  const [message, setMessage] = useState<string>();
  const [results, setResults] = useState<Record<string, ConnectionTestResult>>({});
  const refresh = () => qc.invalidateQueries({ queryKey: KEY });
  const option = options[choice] ?? options[0]!;

  const add = useMutation({
    mutationFn: () => connections.create({ runtime: option.runtime, authType: option.authType, secret }),
    onMutate: () => setMessage(undefined),
    onSuccess: () => {
      setSecret(""); // the credential is never kept in the page
      setMessage("연결을 추가했어요. ‘테스트’를 눌러 확인하면 쓸 수 있어요.");
    },
    onError: (e) => setMessage(errorText(e)),
    onSettled: refresh,
  });
  const test = useMutation({
    mutationFn: (id: string) => connections.test(id),
    onMutate: () => setMessage(undefined),
    onSuccess: (r, id) => setResults((x) => ({ ...x, [id]: r })),
    onError: (e) => setMessage(errorText(e)),
    onSettled: refresh,
  });
  const remove = useMutation({
    mutationFn: (id: string) => connections.remove(id),
    onSuccess: () => setMessage("연결을 해제했어요. 대화 기록은 그대로 남아요."),
    onError: (e) => setMessage(errorText(e)),
    onSettled: refresh,
  });

  return (
    <section className="panel" id="connections" aria-labelledby="conn-h">
      <h2 id="conn-h">내 런타임 연결</h2>
      <p className="muted small">
        내 연결이 있으면 먼저 써요. 없으면 관리자가 허용한 가족 공용 연결을 써요. 키는 서버에 암호화해
        저장하고 끝 4자리만 보여요.
      </p>
      {list.data && list.data.length > 0 && (
        <table className="devices">
          <tbody>
            {list.data.map((c) => {
              const [text, cls] = STATUS[c.status];
              const r = results[c.id];
              return (
                <tr key={c.id} data-testid="connection">
                  <td>
                    <b>{c.label}</b>
                    <br />
                    <span className="muted small">
                      {RUNTIME[c.runtime]} · {c.authType === "subscription" ? "구독" : "API 키"}
                      {c.hint ? ` · ${c.hint}` : ""}
                      {c.registeredByAdmin ? " · 관리자가 등록" : ""}
                    </span>
                    {(r || c.lastTestCode) && (
                      <span className="small" data-testid="test-result">
                        <br />
                        테스트: {TEST_CODE[r?.code ?? c.lastTestCode ?? ""] ?? r?.code ?? c.lastTestCode}
                      </span>
                    )}
                  </td>
                  <td>
                    <span className={`badge ${cls}`} data-testid="connection-status">
                      {text}
                    </span>
                  </td>
                  <td className="actions">
                    <button
                      type="button"
                      className="small"
                      disabled={test.isPending}
                      onClick={() => test.mutate(c.id)}
                    >
                      {test.isPending && test.variables === c.id ? "테스트 중…" : "테스트"}
                    </button>
                    <button
                      type="button"
                      className="small"
                      aria-label={`${c.label} 연결 해제`}
                      onClick={() => {
                        if (window.confirm("이 연결을 해제할까요? 대화 기록은 남아요.")) remove.mutate(c.id);
                      }}
                    >
                      해제
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {list.isError && <p className="error small">{errorText(list.error)}</p>}
      <form
        className="add-connection"
        onSubmit={(e) => {
          e.preventDefault();
          if (secret.trim()) add.mutate();
        }}
      >
        <label className="field">
          <span>연결 방식</span>
          <select value={choice} onChange={(e) => setChoice(Number(e.target.value))}>
            {options.map((o, i) => (
              <option key={`${o.runtime}-${o.authType}`} value={i}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{option.authType === "subscription" ? "토큰" : "API 키"}</span>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={secret}
            placeholder={option.placeholder}
            onChange={(e) => setSecret(e.target.value)}
          />
        </label>
        {option.authType === "subscription" && (
          <div className="notice warn small" role="note">
            본인 구독만 연결하세요. 한 사람의 구독을 여러 명이 쓰는 것은 이용 정책에 어긋날 수 있습니다.
          </div>
        )}
        <button type="submit" className="primary" disabled={add.isPending || !secret.trim()}>
          {add.isPending ? "추가하는 중…" : "연결 추가"}
        </button>
      </form>
      {message && (
        <p className="small" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
