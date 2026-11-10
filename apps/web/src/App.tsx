import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { PASSWORD_MIN, SERVICE_NAME, type AuthState } from "@agentlee/shared";
import { auth, errorText } from "./api.js";

/** Auth screens (#9): first-run admin, login, forced password change. The real app layout lands in #13. */
export function App() {
  const [state, setState] = useState<AuthState | "error" | null>(null);

  useEffect(() => {
    auth
      .state()
      .then(setState)
      .catch(() => setState("error"));
  }, []);

  if (state === null) return <Card title={SERVICE_NAME}>불러오는 중…</Card>;
  if (state === "error") return <Card title={SERVICE_NAME}>서버에 연결하지 못했어요.</Card>;
  if (state.setupRequired) return <Setup state={state} onDone={setState} />;
  if (!state.user) return <Login state={state} onDone={setState} />;
  if (state.user.mustChangePassword) return <ChangePassword onDone={setState} temporary />;
  return <Home state={state} onDone={setState} />;
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="shell">
      <section className="card">
        <h1>{title}</h1>
        {children}
      </section>
    </main>
  );
}

function useSubmit(run: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    run()
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };
  return { busy, error, onSubmit };
}

function Field(props: {
  label: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  autoComplete: string;
  readOnly?: boolean;
  minLength?: number;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type={props.type ?? "text"}
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        autoComplete={props.autoComplete}
        readOnly={props.readOnly}
        required
        minLength={props.minLength}
      />
    </label>
  );
}

const ErrorText = ({ text }: { text: string | null }) =>
  text ? (
    <p className="error" role="alert">
      {text}
    </p>
  ) : null;

function Setup({ state, onDone }: { state: AuthState; onDone: (s: AuthState) => void }) {
  const [name, setName] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const { busy, error, onSubmit } = useSubmit(async () => {
    setMismatch(pw !== pw2);
    if (pw !== pw2) return;
    onDone(await auth.setup(name, pw));
  });
  return (
    <Card title={`${SERVICE_NAME} 처음 설정`}>
      <p className="hint">관리자 계정을 만들어요. 이 화면은 한 번만 나와요.</p>
      <form onSubmit={onSubmit}>
        <Field
          label="관리자 이메일"
          value={state.adminEmail}
          onChange={() => {}}
          autoComplete="username"
          readOnly
        />
        <Field label="이름" value={name} onChange={setName} autoComplete="name" />
        <Field
          label={`비밀번호 (${PASSWORD_MIN}자 이상)`}
          type="password"
          value={pw}
          onChange={setPw}
          autoComplete="new-password"
          minLength={PASSWORD_MIN}
        />
        <Field
          label="비밀번호 확인"
          type="password"
          value={pw2}
          onChange={setPw2}
          autoComplete="new-password"
        />
        <ErrorText text={mismatch ? "비밀번호가 서로 달라요." : error} />
        <button disabled={busy}>관리자 만들기</button>
      </form>
    </Card>
  );
}

function Login({ state, onDone }: { state: AuthState; onDone: (s: AuthState) => void }) {
  const [email, setEmail] = useState(state.accessEmail ?? "");
  const [pw, setPw] = useState("");
  const { busy, error, onSubmit } = useSubmit(async () => onDone(await auth.login(email, pw)));
  return (
    <Card title={SERVICE_NAME}>
      <form onSubmit={onSubmit}>
        <Field
          label="이메일"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="username"
          readOnly={!!state.accessEmail}
        />
        <Field label="비밀번호" type="password" value={pw} onChange={setPw} autoComplete="current-password" />
        <ErrorText text={error} />
        <button disabled={busy}>로그인</button>
      </form>
    </Card>
  );
}

function ChangePassword({ onDone, temporary }: { onDone: (s: AuthState) => void; temporary?: boolean }) {
  const [current, setCurrent] = useState("");
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [mismatch, setMismatch] = useState(false);
  const { busy, error, onSubmit } = useSubmit(async () => {
    setMismatch(pw !== pw2);
    if (pw !== pw2) return;
    onDone(await auth.changePassword(current, pw));
  });
  return (
    <Card title="비밀번호 변경">
      {temporary && (
        <p className="hint">임시 비밀번호로 로그인했어요. 새 비밀번호를 정해야 계속할 수 있어요.</p>
      )}
      <form onSubmit={onSubmit}>
        <Field
          label="현재 비밀번호"
          type="password"
          value={current}
          onChange={setCurrent}
          autoComplete="current-password"
        />
        <Field
          label={`새 비밀번호 (${PASSWORD_MIN}자 이상)`}
          type="password"
          value={pw}
          onChange={setPw}
          autoComplete="new-password"
          minLength={PASSWORD_MIN}
        />
        <Field
          label="새 비밀번호 확인"
          type="password"
          value={pw2}
          onChange={setPw2}
          autoComplete="new-password"
        />
        <ErrorText text={mismatch ? "새 비밀번호가 서로 달라요." : error} />
        <button disabled={busy}>변경</button>
      </form>
    </Card>
  );
}

function Home({ state, onDone }: { state: AuthState; onDone: (s: AuthState) => void }) {
  const { busy, error, onSubmit } = useSubmit(async () => onDone(await auth.logout()));
  const user = state.user!;
  return (
    <Card title={SERVICE_NAME}>
      <p data-testid="whoami">
        {user.name}님 ({user.role === "admin" ? "관리자" : "가족"}) · {user.email}
      </p>
      <p className="hint">대화 화면은 다음 단계(#13·#14)에서 들어와요.</p>
      <form onSubmit={onSubmit}>
        <ErrorText text={error} />
        <button disabled={busy}>로그아웃</button>
      </form>
    </Card>
  );
}
