import { useEffect, useState, type FormEvent } from "react";
import type { AccessPreview, AccessPreviewChange, AccessSync, AdminUser, Role } from "@agentlee/shared";
import { access, admin, ApiError, errorText } from "./api.js";
import { AccessPreviewView } from "./admin/AccessAdmin.js";

/** Codes of a preview that refuse the change itself (nothing is saved). Any other failure: Cloudflare is unreachable. */
const REFUSED = new Set(["email_taken", "admin_email_protected", "not_found", "invalid_request"]);

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
      {user.role === "admin" && (
        <p className="hint">관리자 이메일은 관리자 → Access 탭의 “관리자 이메일 변경” 절차로만 바꿔요.</p>
      )}
      <label className="field">
        <span>역할</span>
        <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
          <option value="member">가족</option>
          <option value="admin">관리자</option>
        </select>
      </label>
      <p className="hint">
        이메일을 바꾸면 그 사람은 다시 로그인해야 해요. 저장 전에 Access 허용 목록이 어떻게 바뀌는지 보여줘요.
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
  /** The Access preview of a change about to be saved (FR-15.2), and the change itself. */
  const [confirming, setConfirming] = useState<{
    preview: AccessPreview | null;
    previewError: string | null;
    save: () => Promise<void>;
  } | null>(null);
  const [accessResult, setAccessResult] = useState<
    { sync: AccessSync } | { error: string } | { manual: true } | null
  >(null);

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

  /**
   * Every change the Access list follows (add, new email, deactivate): preview first, then — once confirmed — save
   * the change and write the previewed list. A failed write keeps the change (the Access tab offers "다시 시도").
   */
  const withAccess = (change: AccessPreviewChange, save: () => Promise<void>) => {
    setError(null);
    setAccessResult(null);
    void access.preview(change).then(
      (preview) => setConfirming({ preview, previewError: null, save }),
      (e: unknown) => {
        if (e instanceof ApiError && REFUSED.has(e.code)) setError(errorText(e));
        else setConfirming({ preview: null, previewError: errorText(e), save });
      },
    );
  };
  const confirmSave = () => {
    const c = confirming;
    if (!c) return;
    setConfirming(null);
    void run(async () => {
      await c.save();
      const p = c.preview;
      if (!p) return setAccessResult({ error: "access_unreachable" });
      if (p.mode === "manual") return setAccessResult({ manual: true });
      try {
        setAccessResult({ sync: await access.apply({ revision: p.revision!, final: p.final }) });
      } catch (e) {
        setAccessResult({ error: e instanceof ApiError ? e.code : "unknown" });
      }
    });
  };

  const add = (e: FormEvent) => {
    e.preventDefault();
    withAccess({ kind: "create", email }, async () => {
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
            지금 한 번만 보여요. 직접 전달하세요. 첫 로그인 때 새 비밀번호로 바꿔야 해요.
          </p>
          <button type="button" onClick={() => setShown(null)}>
            확인했어요
          </button>
        </div>
      )}
      {confirming && (
        <div className="notice-box" role="dialog" aria-label="Access 허용 목록 미리보기">
          {confirming.preview ? (
            <>
              <AccessPreviewView p={confirming.preview} />
              {confirming.preview.mode === "manual" && (
                <p className="hint">
                  수동 모드예요. 저장한 뒤 관리자 → Access 탭의 안내대로 대시보드에 직접 반영하세요.
                </p>
              )}
            </>
          ) : (
            <p className="error">
              Access 목록을 읽지 못했어요({confirming.previewError}). 앱에만 저장하고 나중에 Access 탭에서
              반영할 수 있어요.
            </p>
          )}
          <span className="actions">
            <button type="button" className="primary" onClick={confirmSave} disabled={busy}>
              {confirming.preview?.mode === "auto" ? "확인하고 저장·반영" : "저장"}
            </button>
            <button type="button" onClick={() => setConfirming(null)}>
              취소
            </button>
          </span>
        </div>
      )}
      {accessResult && (
        <div className="notice-box" role="status" data-testid="access-result">
          {"sync" in accessResult && accessResult.sync.status === "applied" && (
            <p>
              Access에 반영했어요.
              {accessResult.sync.removed.length > 0 &&
                (accessResult.sync.revokes.every((r) => r.result === "revoked")
                  ? " 뺀 이메일의 Access 세션 철회를 요청했어요(반영까지 몇 분)."
                  : " 뺀 이메일의 기존 Access 세션은 만료(최대 24시간)까지 남을 수 있어요 — 앱 로그인은 이미 끊겼어요.")}
            </p>
          )}
          {"sync" in accessResult && accessResult.sync.status !== "applied" && (
            <p className="error">
              저장했지만 Access에 반영 안 됨 —{" "}
              {errorText(new ApiError(0, accessResult.sync.errorCode ?? "unknown"))} 관리자 → Access 탭에서
              다시 시도하세요.
            </p>
          )}
          {"error" in accessResult && (
            <p className="error">
              저장했지만 Access에 반영 안 됨
              {accessResult.error !== "access_unreachable" &&
                ` — ${errorText(new ApiError(0, accessResult.error))}`}
              . 관리자 → Access 탭에서 다시 시도하세요.
            </p>
          )}
          {"manual" in accessResult && (
            <p>
              저장했어요. 관리자 → Access 탭의 목록대로 Cloudflare 대시보드를 고친 뒤 “대시보드에
              반영했어요”를 누르세요.
            </p>
          )}
          <button type="button" onClick={() => setAccessResult(null)}>
            확인
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
                          withAccess({ kind: "deactivate", userId: u.id }, async () => {
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
                onSave={(patch) => {
                  const save = async () => {
                    if (Object.keys(patch).length) await admin.update(u.id, patch);
                    setEditing(null);
                  };
                  if (patch.email) withAccess({ kind: "update", userId: u.id, email: patch.email }, save);
                  else void run(save);
                }}
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
