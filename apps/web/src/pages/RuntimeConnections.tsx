import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Connection,
  ConnectionAuthType,
  ConnectionTestResult,
  RuntimeId,
  SubscriptionLogin,
} from "@agentlee/shared";
import { connections, errorText } from "../api.js";
import { pollStep } from "../login-poll.js";

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
const LOGIN_END: Record<string, string> = {
  cancelled: "로그인을 취소했어요.",
  timeout: "시간 안에 코드를 입력하지 않아 로그인이 끝났어요. 다시 시도해 주세요.",
  login_expired: "코드가 만료됐어요. 다시 시도해 주세요.",
  login_failed: "로그인이 완료되지 않았어요. 다시 시도해 주세요.",
  login_error: "로그인 중 문제가 생겼어요. 다시 시도해 주세요.",
  gone: "로그인이 더 이상 진행 중이 아니에요(서버가 다시 시작됐을 수 있어요). ‘ChatGPT로 로그인’을 다시 눌러 주세요.",
};

/** The FR-11.4 notice, shown wherever a subscription is connected. */
const OWN_ONLY =
  "본인 구독만 연결하세요. 한 사람의 구독을 여러 명이 쓰는 것은 이용 정책에 어긋날 수 있습니다.";

type Option = {
  runtime: RuntimeId;
  authType: ConnectionAuthType;
  label: string;
  placeholder: string;
  /** Connected by signing in (device code) instead of pasting a value. */
  login?: boolean;
};

const isLogin = (c: Pick<Connection, "runtime" | "authType">) =>
  c.runtime === "codex" && c.authType === "subscription";

/**
 * 설정 → 내 런타임 연결 (#17, FR-11.1 / FR-12.7): add, test, disconnect personal connections. Only "사용 가능"
 * (a passed test) connections are used. Subscriptions (PRD D2, #18): the Claude subscription token is offered to
 * the admin only; every member can sign in with their own ChatGPT account (device code: the server shows a code,
 * the member enters it on OpenAI's page). Only a login's email is shown — never a token.
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
    {
      runtime: "codex",
      authType: "subscription",
      label: "Codex · 내 ChatGPT 계정으로 로그인",
      placeholder: "",
      login: true,
    },
  ];
  const [choice, setChoice] = useState(0);
  const [secret, setSecret] = useState("");
  const [message, setMessage] = useState<string>();
  const [results, setResults] = useState<Record<string, ConnectionTestResult>>({});
  const [pending, setPending] = useState<SubscriptionLogin>();
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
  const startLogin = useMutation({
    mutationFn: (connectionId?: string) =>
      connections.startLogin(connectionId ? { runtime: "codex", connectionId } : { runtime: "codex" }),
    onMutate: () => setMessage(undefined),
    onSuccess: (l) => setPending(l),
    onError: (e) => setMessage(errorText(e)),
  });
  const cancelLogin = useMutation({
    mutationFn: (id: string) => connections.cancelLogin(id),
    onSettled: () => {
      setPending(undefined);
      setMessage(LOGIN_END.cancelled);
    },
  });

  // While a login waits: ask the server every 2 s until it has ended, it is gone (404) or its time is up.
  const { mutate: runTest } = test;
  useEffect(() => {
    if (!pending) return;
    let over = false;
    const finish = () => {
      over = true;
      clearInterval(timer);
      setPending(undefined);
    };
    const handle = (r: Parameters<typeof pollStep>[0]) => {
      if (over) return;
      const step = pollStep(r);
      if (step.kind === "wait") return;
      finish();
      if (step.kind === "gone") return setMessage(LOGIN_END.gone);
      if (step.kind === "expired") return setMessage(LOGIN_END.timeout);
      const { login, connection } = step.result;
      if (login.status === "completed" && connection) {
        setMessage(
          `${connection.accountEmail ?? "ChatGPT"} 계정으로 로그인했어요. 연결을 테스트하는 중이에요…`,
        );
        void qc.invalidateQueries({ queryKey: KEY });
        runTest(connection.id); // a new login is tested right away
      } else setMessage(LOGIN_END[login.code ?? login.status] ?? LOGIN_END.login_error);
    };
    const timer = setInterval(() => {
      const base = { expiresAt: pending.expiresAt };
      void connections.login(pending.id).then(
        (result) => handle({ ...base, now: Date.now(), result }),
        (error: unknown) => handle({ ...base, now: Date.now(), error }),
      );
    }, 2000);
    return () => {
      over = true;
      clearInterval(timer);
    };
  }, [pending, runTest, qc]);

  return (
    <section className="panel" id="connections" aria-labelledby="conn-h">
      <h2 id="conn-h">내 런타임 연결</h2>
      <p className="muted small">
        내 연결이 있으면 먼저 써요. 없으면 관리자가 허용한 가족 공용 연결을 써요. 키는 서버에 암호화해
        저장하고 끝 4자리만 보여요. ChatGPT 로그인은 계정 이메일만 보여요.
      </p>
      {list.data && list.data.length > 0 && (
        <table className="devices">
          <tbody>
            {list.data.map((c) => {
              const [text, cls] =
                c.status === "expired" && c.authType === "subscription"
                  ? ["다시 로그인 필요", "err"]
                  : STATUS[c.status];
              const r = results[c.id];
              return (
                <tr key={c.id} data-testid="connection">
                  <td>
                    <b>{c.label}</b>
                    <br />
                    <span className="muted small">
                      {RUNTIME[c.runtime]} · {c.authType === "subscription" ? "구독" : "API 키"}
                      {c.accountEmail ? ` · ${c.accountEmail}` : c.hint ? ` · ${c.hint}` : ""}
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
                    {isLogin(c) && (
                      <button
                        type="button"
                        className="small"
                        disabled={startLogin.isPending || !!pending}
                        onClick={() => startLogin.mutate(c.id)}
                      >
                        다시 로그인
                      </button>
                    )}
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
      {pending ? (
        <div className="notice info" role="region" aria-label="ChatGPT 로그인" data-testid="device-login">
          <p>
            1.{" "}
            <a href={pending.verificationUrl ?? "#"} target="_blank" rel="noopener noreferrer">
              OpenAI 로그인 페이지
            </a>
            를 열고 <b>본인</b> ChatGPT 계정으로 로그인하세요.
          </p>
          <p>
            2. 이 코드를 입력하세요: <code data-testid="device-code">{pending.userCode}</code>
          </p>
          <p className="muted small">
            입력하면 이 화면이 저절로 바뀌어요
            {pending.expiresAt
              ? ` (${new Date(pending.expiresAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}까지)`
              : ""}
            . {OWN_ONLY}
          </p>
          <button type="button" className="small" onClick={() => cancelLogin.mutate(pending.id)}>
            취소
          </button>
        </div>
      ) : (
        <form
          className="add-connection"
          onSubmit={(e) => {
            e.preventDefault();
            if (option.login) startLogin.mutate(undefined);
            else if (secret.trim()) add.mutate();
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
          {!option.login && (
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
          )}
          {option.authType === "subscription" && (
            <div className="notice warn small" role="note">
              {OWN_ONLY}
              {option.runtime === "claude-code" ? (
                <>
                  <br />
                  터미널에서 <code>claude setup-token</code>을 실행해 받은 장기 토큰을 붙여 넣으세요. 이
                  연결은 관리자 본인 대화에만 쓰여요.
                </>
              ) : (
                <>
                  <br />
                  ‘ChatGPT로 로그인’을 누르면 코드가 나와요. OpenAI 페이지에서 그 코드를 입력하면 연결돼요.
                </>
              )}
            </div>
          )}
          {option.login ? (
            <button type="submit" className="primary" disabled={startLogin.isPending}>
              {startLogin.isPending ? "로그인 준비 중…" : "ChatGPT로 로그인"}
            </button>
          ) : (
            <button type="submit" className="primary" disabled={add.isPending || !secret.trim()}>
              {add.isPending ? "추가하는 중…" : "연결 추가"}
            </button>
          )}
        </form>
      )}
      {message && (
        <p className="small" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
