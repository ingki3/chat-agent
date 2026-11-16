import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AccessOverview, AccessPreview, AccessSync, AdminEmailChange } from "@agentlee/shared";
import { access, ApiError, errorText } from "../api.js";

export const ACCESS_KEY = ["admin", "access"] as const;

const time = (ms: number) =>
  new Date(ms).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

const REVOKE: Record<string, string> = {
  revoked: "Access 세션 철회 요청함 — Cloudflare 반영까지 몇 분 걸릴 수 있어요",
  unavailable:
    "토큰에 세션 철회 권한이 없어요 — 기존 Access 세션은 만료(최대 24시간)까지 남을 수 있어요. 앱 로그인은 이미 끊겼어요",
  failed: "세션 철회 요청이 실패했어요 — 기존 Access 세션은 만료(최대 24시간)까지 남을 수 있어요",
};

/** "Access 허용 목록이 이렇게 바뀝니다" (FR-15.2): the final list, this change, and differences already there. */
export function AccessPreviewView({ p }: { p: AccessPreview }) {
  const nothing = p.add.length === 0 && p.remove.length === 0;
  return (
    <div className="access-preview" data-testid="access-preview">
      <p>
        <b>Access 허용 목록이 이렇게 바뀝니다</b>
        {p.policyName && <span className="muted small"> · 정책 “{p.policyName}”</span>}
      </p>
      {nothing ? (
        <p className="muted small">바뀌는 이메일이 없어요.</p>
      ) : (
        <ul className="delta">
          {p.add.map((e) => (
            <li key={`+${e}`} className="add">
              + {e}
              {p.drift?.add.includes(e) && !p.change.add.includes(e) && " (기존 불일치)"}
            </li>
          ))}
          {p.remove.map((e) => (
            <li key={`-${e}`} className="remove">
              − {e}
              {p.drift?.remove.includes(e) &&
                !p.change.remove.includes(e) &&
                " (기존 불일치 — 앱에 없는 이메일)"}
            </li>
          ))}
        </ul>
      )}
      {p.drift && (p.drift.add.length > 0 || p.drift.remove.length > 0) && (
        <p className="error small" role="alert">
          이번 변경과 상관없이 Access와 앱 목록이 이미 달라요(대시보드에서 직접 바꾼 경우 등). 확인하면 함께
          맞춰요.
        </p>
      )}
      <p className="small">
        최종 목록: <code>{p.final.join(", ")}</code>
      </p>
      {p.otherRules > 0 && (
        <p className="muted small">이메일이 아닌 규칙 {p.otherRules}개(그룹·도메인 등)는 그대로 둬요.</p>
      )}
    </div>
  );
}

/** A sync's outcome on the screen: applied, failed ("Access에 반영 안 됨 — 다시 시도"), or waiting. */
function SyncState({ s, onRetry, busy }: { s: AccessSync; onRetry?: () => void; busy: boolean }) {
  return (
    <div className="notice-box" data-testid="access-sync-state" role="status">
      {s.status === "applied" && (
        <p>
          {s.mode === "manual" ? "대시보드에 반영했다고 기록했어요" : "Access에 반영했어요"}
          {s.appliedAt && ` (${time(s.appliedAt)})`}
          {s.added.length > 0 && ` · 추가 ${s.added.join(", ")}`}
          {s.removed.length > 0 && ` · 제거 ${s.removed.join(", ")}`}
        </p>
      )}
      {s.status === "pending" && <p>앱 사용자 목록이 바뀌었어요 — 아직 Access에 반영 안 됨.</p>}
      {s.status === "applying" && <p>Access에 반영하는 중…</p>}
      {s.status === "failed" && (
        <>
          <p className="error">
            Access에 반영 안 됨 — {errorText(new ApiError(0, s.errorCode ?? "unknown"))}
            {s.retryAt && ` (${time(s.retryAt)}에 자동으로 다시 시도)`}
          </p>
          {onRetry &&
            (s.errorCode === "access_revision_changed" || s.errorCode === "access_preview_stale" ? (
              <p className="muted small">아래 “비교하기”로 다시 미리보기를 열어 반영하세요.</p>
            ) : (
              <button type="button" onClick={onRetry} disabled={busy}>
                다시 시도
              </button>
            ))}
        </>
      )}
      {s.removed.length > 0 && s.status === "applied" && (
        <ul className="small">
          {s.removed.map((e) => {
            const r = s.revokes.find((x) => x.email === e)?.result;
            return (
              <li key={e} data-testid="access-revoke">
                {e}: {r ? REVOKE[r] : s.mode === "manual" ? REVOKE.unavailable : "세션 철회 확인 중"}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Manual mode steps (FR-15.4): what to type into the Cloudflare dashboard. */
function ManualSteps({ emails }: { emails: string[] }) {
  return (
    <ol className="small" data-testid="access-manual-steps">
      <li>
        Cloudflare 대시보드 → Zero Trust → Access controls → Applications → Agent Lee → Edit → Policies.
      </li>
      <li>허용(Allow) 정책의 Include → Emails를 아래 목록과 똑같이 맞추고 저장해요(다른 규칙은 그대로).</li>
      <li>
        뺀 이메일의 기존 세션은 Zero Trust → My Team → Users → 그 사람 → <b>Revoke session</b>으로 끊어요.
      </li>
      <li>다 했으면 아래 “대시보드에 반영했어요”를 눌러요.</li>
      <li className="emails">
        <code data-testid="access-manual-emails">{emails.join("\n")}</code>
      </li>
    </ol>
  );
}

function Registration({ o, onDone }: { o: AccessOverview; onDone: () => void }) {
  const reg = o.registration;
  const [open, setOpen] = useState(!reg);
  const [token, setToken] = useState("");
  const [accountId, setAccountId] = useState(reg?.accountId ?? "");
  const [appId, setAppId] = useState(reg?.appId ?? "");
  const [policyId, setPolicyId] = useState(reg?.policyId ?? "");
  const save = useMutation({
    mutationFn: () => access.register({ ...(token ? { token } : {}), accountId, appId, policyId }),
    onSuccess: () => {
      setToken("");
      setOpen(false);
      onDone();
    },
  });
  const remove = useMutation({ mutationFn: access.unregister, onSuccess: onDone });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  return (
    <section aria-label="Cloudflare 등록">
      <h3>Cloudflare 등록</h3>
      {reg ? (
        <p className="small" data-testid="access-registration">
          자동 반영 · 앱 {reg.appName ?? reg.appId} · 정책 {reg.policyName ?? reg.policyId}(
          {reg.scope === "reusable" ? "재사용 정책" : "앱 정책"}) · 토큰 <code>{reg.tokenMasked}</code>
        </p>
      ) : (
        <p className="small" data-testid="access-registration">
          수동 모드 — API 토큰을 등록하지 않았어요. 아래 목록을 대시보드에 직접 넣어요.
        </p>
      )}
      {!open ? (
        <span className="actions">
          <button type="button" onClick={() => setOpen(true)}>
            {reg ? "토큰·정책 교체" : "토큰 등록"}
          </button>
          {reg && (
            <button
              type="button"
              disabled={remove.isPending}
              onClick={() => {
                if (confirm("토큰을 지우고 수동 모드로 바꿀까요?")) remove.mutate();
              }}
            >
              토큰 지우기(수동 모드)
            </button>
          )}
        </span>
      ) : (
        <form onSubmit={submit} className="access-register">
          <p className="hint">
            토큰은 <b>Access: Apps and Policies 편집</b> 권한만 주고 그 계정에만 한정해요(운영 문서 45절).
            저장하면 암호화되고 끝 4자리만 보여요.
          </p>
          <label className="field">
            <span>API 토큰{reg && " (비우면 지금 것 유지)"}</span>
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              required={!reg}
            />
          </label>
          <label className="field">
            <span>계정 ID (Account ID)</span>
            <input value={accountId} onChange={(e) => setAccountId(e.target.value)} required />
          </label>
          <label className="field">
            <span>애플리케이션 ID</span>
            <input value={appId} onChange={(e) => setAppId(e.target.value)} required />
          </label>
          <label className="field">
            <span>정책 ID</span>
            <input value={policyId} onChange={(e) => setPolicyId(e.target.value)} required />
          </label>
          {save.isError && (
            <p className="error small" role="alert">
              {errorText(save.error)}
            </p>
          )}
          <span className="actions">
            <button className="primary" disabled={save.isPending}>
              {save.isPending ? "확인 중…" : "확인하고 저장"}
            </button>
            {reg && (
              <button type="button" onClick={() => setOpen(false)}>
                취소
              </button>
            )}
          </span>
        </form>
      )}
    </section>
  );
}

const STEP: Record<AdminEmailChange["state"], number> = {
  pending: 1,
  added: 2,
  switched: 4,
  done: 5,
  cancelled: 0,
};

/** FR-15.7: the admin's own email, one step at a time. */
function AdminEmail({ o, onDone }: { o: AccessOverview; onDone: () => void }) {
  const [email, setEmail] = useState("");
  const ch = o.adminEmailChange;
  const open = ch && ch.state !== "done" && ch.state !== "cancelled" ? ch : null;
  const request = useMutation({ mutationFn: () => access.requestAdminEmail(email), onSuccess: onDone });
  const cancel = useMutation({ mutationFn: access.cancelAdminEmail, onSuccess: onDone });
  const step = open ? STEP[open.state] : 0;
  const mark = (n: number, text: string) => (
    <li className={step > n ? "done" : step === n ? "current" : ""}>
      {step > n ? "✓ " : ""}
      {text}
    </li>
  );
  return (
    <section aria-label="관리자 이메일 변경">
      <h3>관리자 이메일 변경</h3>
      {open ? (
        <div data-testid="admin-email-change">
          <p className="small">
            <code>{open.oldEmail}</code> → <code>{open.newEmail}</code>
          </p>
          <ol className="steps small">
            {mark(0, "변경 요청 저장(대기)")}
            {mark(
              1,
              o.mode === "auto"
                ? "새 이메일을 Access에 추가 — 아래 “비교하기 → 반영”"
                : "새 이메일을 대시보드에 추가하고 “대시보드에 반영했어요”",
            )}
            {mark(
              2,
              `https://…/cdn-cgi/access/logout 으로 Access에서 로그아웃 → 같은 브라우저에서 새 이메일로 Access 로그인 → 앱이 “새 이메일로 전환” 화면을 보여줘요`,
            )}
            {mark(3, "앱 계정 이메일과 세션이 새 이메일로 바뀌어요")}
            {mark(4, "이전 이메일을 Access에서 제거 — 아래 “비교하기 → 반영”")}
          </ol>
          <p className="muted small">
            어느 단계에서 실패하거나 서버가 다시 시작돼도 전환 전까지는 이전 이메일로 그대로 로그인해요.
          </p>
          {(open.state === "pending" || open.state === "added") && (
            <button type="button" disabled={cancel.isPending} onClick={() => cancel.mutate()}>
              변경 취소
            </button>
          )}
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            request.mutate();
          }}
          className="access-admin-email"
        >
          {ch?.state === "done" && (
            <p className="small" role="status">
              관리자 이메일을 {ch.newEmail}(으)로 바꿨어요. 서버 <code>.env</code>의 ADMIN_EMAIL도 새 주소로
              고쳐 두세요.
            </p>
          )}
          <label className="field">
            <span>새 관리자 이메일</span>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          {request.isError && (
            <p className="error small" role="alert">
              {errorText(request.error)}
            </p>
          )}
          <button disabled={request.isPending}>변경 요청</button>
        </form>
      )}
      {cancel.isError && <p className="error small">{errorText(cancel.error)}</p>}
    </section>
  );
}

/**
 * 관리자 → Access (#36, PRD FR-15): Cloudflare registration, the app's list beside Access's (difference warning,
 * "앱 사용자 목록을 Access에 반영"), the sync state with retry, manual mode, and the admin's email change.
 */
export function AccessAdmin() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ACCESS_KEY, queryFn: access.overview, refetchInterval: 10_000 });
  const reload = () => void qc.invalidateQueries({ queryKey: ACCESS_KEY });
  const [preview, setPreview] = useState<AccessPreview | null>(null);
  const compare = useMutation({ mutationFn: () => access.preview(), onSuccess: setPreview });
  const apply = useMutation({
    mutationFn: async (p: AccessPreview) =>
      p.mode === "auto"
        ? access.apply({ revision: p.revision!, final: p.final })
        : access.manualDone(p.final),
    onSuccess: () => {
      setPreview(null);
      reload();
    },
    onError: (e) => {
      // The policy or the app's list moved since the preview: show the fresh one.
      if (
        e instanceof ApiError &&
        (e.code === "access_revision_changed" || e.code === "access_preview_stale")
      )
        compare.mutate();
      reload();
    },
  });
  const retry = useMutation({ mutationFn: access.retry, onSettled: reload });
  const o = q.data;
  if (q.isError) return <p className="error small">{errorText(q.error)}</p>;
  if (!o) return <p className="muted small">불러오는 중…</p>;
  const shown = o.open ?? o.lastApplied;
  const appList = o.appEmails.map((e) => e.email);
  return (
    <section className="admin access-admin" aria-label="Cloudflare Access">
      <h2>Cloudflare Access</h2>
      <p className="muted small">
        Access 허용 목록 = 앱의 활성 사용자 이메일. 현재 관리자 이메일은 목록에서 뺄 수 없어요.
      </p>
      <Registration o={o} onDone={reload} />

      <section aria-label="반영 상태">
        <h3>반영 상태</h3>
        {shown ? (
          <SyncState s={shown} busy={retry.isPending} onRetry={() => retry.mutate()} />
        ) : (
          <p className="muted small">아직 반영한 적이 없어요.</p>
        )}
        {o.dirty && !o.open && (
          <p className="error small" role="alert">
            앱 사용자 목록이 마지막 반영 뒤에 바뀌었어요 — Access에 반영 안 됨.
          </p>
        )}
        {retry.isError && <p className="error small">{errorText(retry.error)}</p>}
      </section>

      <section aria-label="목록 비교">
        <h3>목록 비교</h3>
        <div className="access-compare">
          <div>
            <h4>앱 사용자 이메일</h4>
            <ul data-testid="access-app-emails">
              {o.appEmails.map((e) => (
                <li
                  key={e.email}
                  className={preview?.accessEmails && !preview.accessEmails.includes(e.email) ? "diff" : ""}
                >
                  {e.email}{" "}
                  <span className="muted small">
                    {e.source === "admin_email_change" ? "새 관리자 이메일(대기)" : e.name}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4>Access 허용 목록</h4>
            {preview?.accessEmails ? (
              <ul data-testid="access-live-emails">
                {preview.accessEmails.map((e) => (
                  <li key={e} className={appList.includes(e) ? "" : "diff"}>
                    {e}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted small">
                {o.mode === "manual"
                  ? "수동 모드에서는 Access 목록을 읽지 않아요."
                  : "“비교하기”를 누르면 읽어 와요."}
              </p>
            )}
          </div>
        </div>
        {preview?.drift && (preview.drift.add.length > 0 || preview.drift.remove.length > 0) && (
          <p className="error small" role="alert" data-testid="access-drift">
            ⚠️ Access 목록과 앱 사용자 목록이 달라요.
          </p>
        )}
        {preview?.drift && preview.add.length === 0 && preview.remove.length === 0 && (
          <p className="small" role="status">
            Access 목록과 앱 목록이 같아요.
          </p>
        )}
        <span className="actions">
          <button type="button" onClick={() => compare.mutate()} disabled={compare.isPending}>
            {compare.isPending ? "읽는 중…" : "비교하기"}
          </button>
        </span>
        {compare.isError && (
          <p className="error small" role="alert">
            {errorText(compare.error)}
          </p>
        )}
        {preview && (
          <div className="notice-box">
            <AccessPreviewView p={preview} />
            {preview.mode === "manual" && <ManualSteps emails={preview.final} />}
            {apply.isError && (
              <p className="error small" role="alert">
                {errorText(apply.error)}
              </p>
            )}
            <span className="actions">
              <button
                type="button"
                className="primary"
                disabled={apply.isPending}
                onClick={() => apply.mutate(preview)}
              >
                {preview.mode === "auto" ? "앱 사용자 목록을 Access에 반영" : "대시보드에 반영했어요"}
              </button>
              <button type="button" onClick={() => setPreview(null)}>
                닫기
              </button>
            </span>
          </div>
        )}
      </section>

      <AdminEmail o={o} onDone={reload} />
    </section>
  );
}
