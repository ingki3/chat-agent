import { useEffect, useState, type FormEvent } from "react";
import type { AdminUser, Role } from "@agentlee/shared";
import { admin, errorText } from "./api.js";

const ROLE: Record<Role, string> = { admin: "관리자", member: "가족" };

/** One account's edit form: name, email, role (FR-15.1, #35). An admin's email changes through #36 only. */
function EditUser({
  user,
  busy,
  onSave,
  onCancel,
}: {
  user: AdminUser;
  busy: boolean;
  onSave: (patch: { name?: string; email?: string; role?: Role }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [role, setRole] = useState<Role>(user.role);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave({
      ...(name !== user.name ? { name } : {}),
      ...(email !== user.email ? { email } : {}),
      ...(role !== user.role ? { role } : {}),
    });
  };
  return (
    <form className="edit-user" onSubmit={submit} aria-label={`${user.name} 계정 수정`}>
      <label className="field">
        <span>이름</span>
        <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} />
      </label>
      <label className="field">
        <span>이메일</span>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          readOnly={user.role === "admin"}
        />
      </label>
      {user.role === "admin" && <p className="hint">관리자 이메일은 Access 확인 절차(#36)로만 바꿔요.</p>}
      <label className="field">
        <span>역할</span>
        <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="member">가족</option>
          <option value="admin">관리자</option>
        </select>
      </label>
      <p className="hint">
        이메일을 바꾸면 그 사람은 다시 로그인해야 해요. Cloudflare Access 허용 목록도 직접 고치세요(운영 문서
        10절).
      </p>
      <span className="actions">
        <button type="submit" className="primary" disabled={busy}>
          저장
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          취소
        </button>
      </span>
    </form>
  );
}

/** 관리자 → 사용자 (#41, #35): add, edit, youth flag, reset password, deactivate. */
export function UserAdmin({ selfId }: { selfId: string }) {
  const [users, setUsers] = useState<AdminUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<{ email: string; password: string } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [youth, setYouth] = useState(false);
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
      const r = await admin.create(name, email, role, youth);
      setShown({ email: r.user.email, password: r.temporaryPassword });
      setName("");
      setEmail("");
      setYouth(false);
    });
  };

  return (
    <section className="admin" aria-label="가족 계정">
      <h2>가족 계정</h2>
      {shown && (
        <div className="notice-box" role="status" data-testid="temp-password">
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
          <li key={u.id} className={u.active ? "" : "inactive"} data-testid="user-row">
            <span>
              {u.name} · {u.email} · {ROLE[u.role]}
              {u.youth && " · 청소년"}
              {u.id === selfId && " · 나"}
              {!u.active && " · 비활성"}
              {u.active && u.mustChangePassword && " · 비밀번호 변경 전"}
            </span>
            {u.active && (
              <span className="actions">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setEditing(editing === u.id ? null : u.id)}
                >
                  수정
                </button>
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={u.youth}
                    disabled={busy}
                    onChange={(e) => {
                      const on = e.target.checked;
                      void run(async () => {
                        await admin.setYouth(u.id, on);
                      });
                    }}
                  />
                  청소년
                </label>
                {u.id !== selfId && (
                  <>
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
                        if (
                          confirm(`${u.name} 계정을 비활성화할까요? 바로 로그아웃되고 다시 들어올 수 없어요.`)
                        )
                          void run(async () => {
                            await admin.deactivate(u.id);
                          });
                      }}
                    >
                      비활성화
                    </button>
                  </>
                )}
              </span>
            )}
            {editing === u.id && (
              <EditUser
                user={u}
                busy={busy}
                onCancel={() => setEditing(null)}
                onSave={(patch) =>
                  void run(async () => {
                    if (Object.keys(patch).length) await admin.update(u.id, patch);
                    setEditing(null);
                  })
                }
              />
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
        <label className="inline">
          <input type="checkbox" checked={youth} onChange={(e) => setYouth(e.target.checked)} />
          청소년 계정 (안전 지침, 금융 스킬 기본 숨김)
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
