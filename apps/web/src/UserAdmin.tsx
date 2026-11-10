import { useEffect, useState, type FormEvent } from "react";
import type { AdminUser, Role } from "@agentlee/shared";
import { admin, errorText } from "./api.js";

/** Minimal family-account management (#41). The full admin screen is #35. */
export function UserAdmin({ selfId }: { selfId: string }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<{ email: string; password: string } | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [busy, setBusy] = useState(false);

  const reload = () =>
    admin
      .users()
      .then(setUsers)
      .catch((e: unknown) => setError(errorText(e)));
  useEffect(() => {
    void reload();
  }, []);

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await task();
      await reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await admin.create(name, email, role);
      setShown({ email: r.user.email, password: r.temporaryPassword });
      setName("");
      setEmail("");
    });
  };

  return (
    <section className="admin" aria-label="가족 계정">
      <h2>가족 계정</h2>
      {shown && (
        <div className="notice" role="status" data-testid="temp-password">
          <p>
            <strong>{shown.email}</strong> 임시 비밀번호: <code>{shown.password}</code>
          </p>
          <p className="hint">
            지금 한 번만 보여요. 직접 전달하세요. 첫 로그인 때 새 비밀번호로 바꿔야 해요. Cloudflare Access
            허용 목록에도 이 이메일을 직접 추가하세요(운영 문서 10절).
          </p>
          <button type="button" onClick={() => setShown(null)}>
            확인했어요
          </button>
        </div>
      )}
      <ul className="users">
        {users?.map((u) => (
          <li key={u.id} className={u.active ? "" : "inactive"}>
            <span>
              {u.name} · {u.email} · {u.role === "admin" ? "관리자" : "가족"}
              {!u.active && " · 비활성"}
              {u.active && u.mustChangePassword && " · 비밀번호 변경 전"}
            </span>
            {u.id !== selfId && u.active && (
              <span className="actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const r = await admin.resetPassword(u.id);
                      setShown({ email: u.email, password: r.temporaryPassword });
                    })
                  }
                >
                  비밀번호 초기화
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (confirm(`${u.name} 계정을 비활성화할까요? 바로 로그아웃되고 다시 들어올 수 없어요.`))
                      void run(async () => {
                        await admin.deactivate(u.id);
                      });
                  }}
                >
                  비활성화
                </button>
              </span>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="add-user">
        <label className="field">
          <span>이름</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} />
        </label>
        <label className="field">
          <span>새 가족 이메일</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="field">
          <span>역할</span>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="member">가족</option>
            <option value="admin">관리자</option>
          </select>
        </label>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button disabled={busy}>계정 추가</button>
      </form>
    </section>
  );
}
