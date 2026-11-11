import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AdminRuntime, AdminUser, RuntimePolicy } from "@agentlee/shared";
import { admin, errorText } from "../api.js";
import { DefaultsEditor, RUNTIME_LABEL, type DefaultsOption } from "../DefaultsEditor.js";
import { UserSkillToggles } from "./SkillsAdmin.js";

const allows = (list: "all" | string[], v: string) => list === "all" || list.includes(v);

/** The models (with allowed efforts) a policy leaves — the same rule as the server's `RunAccess.models`. */
export function allowedOptions(runtimes: AdminRuntime[], policies: RuntimePolicy[]): DefaultsOption[] {
  return runtimes.flatMap((r) => {
    const p = policies.find((x) => x.runtime === r.runtime);
    if (!r.registered || !p?.allowed) return [];
    const models = r.models.flatMap((m) => {
      if (!allows(p.models, m.id)) return [];
      const efforts = m.efforts.filter((e) => allows(p.efforts, e));
      if (m.efforts.length > 0 && efforts.length === 0) return [];
      return [
        {
          ...m,
          efforts,
          defaultEffort: m.defaultEffort && efforts.includes(m.defaultEffort) ? m.defaultEffort : null,
        },
      ];
    });
    return models.length ? [{ runtime: r.runtime, models }] : [];
  });
}

/** A list of checkboxes with an "all (new ones too)" switch: `"all"` or the checked values. */
function ListChoice({
  label,
  allLabel,
  values,
  value,
  onChange,
}: {
  label: string;
  allLabel: string;
  values: { id: string; label: string }[];
  value: "all" | string[];
  onChange: (v: "all" | string[]) => void;
}) {
  return (
    <fieldset className="list-choice">
      <legend>{label}</legend>
      <label className="inline">
        <input
          type="checkbox"
          checked={value === "all"}
          onChange={(e) => onChange(e.target.checked ? "all" : values.map((v) => v.id))}
        />
        {allLabel}
      </label>
      {values.map((v) => (
        <label key={v.id} className="inline">
          <input
            type="checkbox"
            disabled={value === "all"}
            checked={value === "all" || value.includes(v.id)}
            onChange={(e) => {
              const list = value === "all" ? values.map((x) => x.id) : value;
              onChange(e.target.checked ? [...new Set([...list, v.id])] : list.filter((x) => x !== v.id));
            }}
          />
          {v.label}
        </label>
      ))}
    </fieldset>
  );
}

/** One runtime's policy for one user (FR-1.6, FR-11): runtime, models, efforts, personal/shared connections. */
function PolicyEditor({
  runtime,
  value,
  onChange,
}: {
  runtime: AdminRuntime;
  value: RuntimePolicy;
  onChange: (p: RuntimePolicy) => void;
}) {
  const efforts = [...new Set(runtime.models.flatMap((m) => m.efforts))];
  return (
    <fieldset className="policy" aria-label={`${RUNTIME_LABEL[runtime.runtime]} 권한`}>
      <legend>{RUNTIME_LABEL[runtime.runtime]}</legend>
      <label className="inline">
        <input
          type="checkbox"
          checked={value.allowed}
          onChange={(e) => onChange({ ...value, allowed: e.target.checked })}
        />
        이 런타임 허용
      </label>
      {value.allowed && (
        <>
          <ListChoice
            label="허용 모델"
            allLabel="모든 모델 (새 모델 포함)"
            values={runtime.models.map((m) => ({ id: m.id, label: m.label }))}
            value={value.models}
            onChange={(models) => onChange({ ...value, models })}
          />
          {efforts.length > 0 && (
            <ListChoice
              label="허용 추론 강도"
              allLabel="모든 강도"
              values={efforts.map((e) => ({ id: e, label: e }))}
              value={value.efforts}
              onChange={(e) => onChange({ ...value, efforts: e })}
            />
          )}
          <label className="inline">
            <input
              type="checkbox"
              checked={value.allowPersonal}
              onChange={(e) => onChange({ ...value, allowPersonal: e.target.checked })}
            />
            개인 연결 허용
          </label>
          <label className="inline">
            <input
              type="checkbox"
              checked={value.allowShared}
              onChange={(e) => onChange({ ...value, allowShared: e.target.checked })}
            />
            가족 공용 연결 허용
          </label>
        </>
      )}
    </fieldset>
  );
}

function UserPermissions({ user, runtimes }: { user: AdminUser; runtimes: AdminRuntime[] }) {
  const qc = useQueryClient();
  const key = ["admin", "policies", user.id];
  const saved = useQuery({ queryKey: key, queryFn: () => admin.policies(user.id) });
  // Edits on top of the saved policies; dropped once saved.
  const [edits, setDraft] = useState<RuntimePolicy[]>();
  const draft = edits ?? saved.data;
  const [message, setMessage] = useState<string>();
  const registered = runtimes.filter((r) => r.registered);
  const save = useMutation({
    mutationFn: (items: RuntimePolicy[]) => admin.setPolicies(user.id, items),
    onMutate: () => setMessage(undefined),
    onSuccess: (items) => {
      qc.setQueryData(key, items);
      setDraft(undefined);
      setMessage("권한을 저장했어요. 다음 실행부터 적용되고, 허용하지 않은 모델은 선택기에서 사라져요.");
    },
    onError: (e) => setMessage(errorText(e)),
  });
  const setDefaults = useMutation({
    mutationFn: (d: Parameters<typeof admin.setInitialDefaults>[1]) => admin.setInitialDefaults(user.id, d),
    onMutate: () => setMessage(undefined),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["admin", "users"] });
      setMessage("처음 기본값을 저장했어요. 본인이 설정에서 정한 값이 없을 때 쓰여요.");
    },
    onError: (e) => setMessage(errorText(e)),
  });

  return (
    <div className="user-permissions" data-testid="user-permissions">
      <h3>런타임·모델·추론 강도</h3>
      {saved.isError && <p className="error small">{errorText(saved.error)}</p>}
      {draft && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(draft.filter((p) => registered.some((r) => r.runtime === p.runtime)));
          }}
        >
          {registered.map((r) => {
            const p = draft.find((x) => x.runtime === r.runtime);
            return p ? (
              <PolicyEditor
                key={r.runtime}
                runtime={r}
                value={p}
                onChange={(next) => setDraft(draft.map((x) => (x.runtime === r.runtime ? next : x)))}
              />
            ) : null;
          })}
          <button type="submit" className="primary" disabled={save.isPending}>
            권한 저장
          </button>
        </form>
      )}
      <h3>처음 기본값 (FR-12.4)</h3>
      <p className="muted small">
        {user.name}님이 설정에서 직접 고르기 전까지 새 대화에 쓰는 값이에요. 비워 두면 Claude Code · Opus
        5.5예요. 저장된 권한 안에서만 고를 수 있어요.
      </p>
      {saved.data && (
        <DefaultsEditor
          key={JSON.stringify(user.initialDefaults)}
          options={allowedOptions(runtimes, saved.data)}
          value={user.initialDefaults}
          busy={setDefaults.isPending}
          onSave={(d) => setDefaults.mutate(d)}
          saveLabel="처음 기본값 저장"
        />
      )}
      {user.initialDefaults && (
        <button type="button" className="small" onClick={() => setDefaults.mutate(null)}>
          처음 기본값 지우기
        </button>
      )}
      <h3>스킬</h3>
      <UserSkillToggles user={user} />
      {message && (
        <p className="small" role="status">
          {message}
        </p>
      )}
    </div>
  );
}

/** 관리자 → 권한 (#35, FR-1.6 / FR-10.2): per-user runtimes, models, efforts, connections, skills, initial defaults. */
export function PermissionsAdmin() {
  const users = useQuery({ queryKey: ["admin", "users"], queryFn: admin.users });
  const runtimes = useQuery({ queryKey: ["admin", "runtimes"], queryFn: admin.runtimes });
  const [selected, setSelected] = useState<string>("");
  const active = users.data?.filter((u) => u.active) ?? [];
  const user = active.find((u) => u.id === selected) ?? active[0];
  return (
    <section className="admin" aria-label="사용자별 권한">
      <h2>사용자별 권한</h2>
      {(users.isError || runtimes.isError) && (
        <p className="error small">{errorText(users.error ?? runtimes.error)}</p>
      )}
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
      {user && runtimes.data && <UserPermissions key={user.id} user={user} runtimes={runtimes.data} />}
    </section>
  );
}
