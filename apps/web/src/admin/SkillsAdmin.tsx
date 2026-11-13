import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminSkill, AdminUser, UserSkill } from "@agentlee/shared";
import { admin, errorText } from "../api.js";

const STATUS: Record<AdminSkill["status"], string> = {
  available: "사용 가능",
  not_installed: "설치 안 됨 (pnpm skills:install)",
  broken: "설치본이 바뀜 — 다시 설치",
  needs_python: "python 필요 (SKILL_PYTHON)",
  disabled: "꺼짐 (PYTHON_RUN)",
  needs_account: "전용 계정 필요 (python_run)",
  planned: "준비 중",
  document: "파일 도구로 제공 예정",
};
const REASON: Record<UserSkill["reason"], string> = {
  all: "모두 허용",
  youth_hidden: "청소년 기본 숨김",
  listed: "켜 둠",
  unlisted: "꺼 둠",
};

/** One user's skill switches (FR-1.6). The server works out the new list, so a youth account's finance skills stay hidden. */
export function UserSkillToggles({ user }: { user: Pick<AdminUser, "id" | "name"> }) {
  const qc = useQueryClient();
  const key = ["admin", "user-skills", user.id];
  const skills = useQuery({ queryKey: key, queryFn: () => admin.userSkills(user.id) });
  const toggle = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      admin.setUserSkill(user.id, name, enabled),
    onSuccess: (r) => qc.setQueryData(key, r),
  });
  const r = skills.data;
  return (
    <div className="skill-toggles" aria-label={`${user.name} 스킬`} role="group">
      {skills.isError && <p className="error small">{errorText(skills.error)}</p>}
      {toggle.isError && <p className="error small">{errorText(toggle.error)}</p>}
      {r && (
        <>
          <p className="muted small">
            {r.mode === "all"
              ? "모든 스킬 허용(새 스킬도 켜짐)"
              : "고른 스킬만 허용(새 스킬은 꺼진 채로 추가)"}
            {r.youth && " · 청소년 계정: 금융 스킬은 직접 켜기 전까지 숨김"}
          </p>
          <ul className="skill-list">
            {r.skills.map((s) => (
              <li key={s.name}>
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={s.allowed}
                    disabled={toggle.isPending}
                    onChange={(e) => toggle.mutate({ name: s.name, enabled: e.target.checked })}
                  />
                  {s.name}
                </label>
                <span className="muted small">
                  {" "}
                  {s.finance ? "금융 · " : ""}
                  {REASON[s.reason]}
                  {!s.serverEnabled && " · 서버에서 꺼짐"}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** 관리자 → 스킬 (#35, FR-10.3, D5): the server allow-list and each user's switches. */
export function SkillsAdmin() {
  const qc = useQueryClient();
  const skills = useQuery({ queryKey: ["admin", "skills"], queryFn: admin.skills });
  const users = useQuery({ queryKey: ["admin", "users"], queryFn: admin.users });
  const [selected, setSelected] = useState("");
  const setServer = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      admin.setServerSkill(name, enabled),
    onSuccess: (list) => {
      qc.setQueryData(["admin", "skills"], list);
      void qc.invalidateQueries({ queryKey: ["admin", "user-skills"] });
    },
  });
  const active = users.data?.filter((u) => u.active) ?? [];
  const user = active.find((u) => u.id === selected) ?? active[0];
  return (
    <section className="admin" aria-label="스킬">
      <h2>서버 허용 목록</h2>
      <p className="muted small">
        끈 스킬은 누구에게도 제공되지 않아요. 설치는 서버에서 <code>pnpm skills:install</code> 후
        재시작해요(운영 문서 15절).
      </p>
      {skills.isError && <p className="error small">{errorText(skills.error)}</p>}
      {setServer.isError && <p className="error small">{errorText(setServer.error)}</p>}
      <table className="devices" aria-label="서버 허용 목록">
        <tbody>
          {skills.data?.map((s) => (
            <tr key={s.name} data-testid="server-skill">
              <td>
                <b>{s.name}</b>
                <br />
                <span className="muted small">
                  {s.finance ? "금융 · " : ""}
                  {STATUS[s.status]}
                  {s.issue ? ` · ${s.issue}` : ""}
                </span>
              </td>
              <td>
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    disabled={setServer.isPending}
                    onChange={(e) => setServer.mutate({ name: s.name, enabled: e.target.checked })}
                    aria-label={`${s.name} 서버에서 허용`}
                  />
                  허용
                </label>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>사용자별 켜기</h2>
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
      {user && <UserSkillToggles key={user.id} user={user} />}
    </section>
  );
}
