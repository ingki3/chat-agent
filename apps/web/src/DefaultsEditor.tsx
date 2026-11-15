import { useState } from "react";
import type { ModelDefault, RuntimeDefaults, RuntimeId } from "@agentlee/shared";

export const RUNTIME_LABEL: Record<RuntimeId, string> = { "claude-code": "Claude Code", codex: "Codex" };

/** What may be picked: runtimes with their allowed models and each model's allowed effort values. */
export type DefaultsOption = {
  runtime: RuntimeId;
  models: { id: string; label: string; efforts: string[]; defaultEffort: string | null }[];
};

/**
 * Default runtime and per-runtime model and effort (FR-12.1·12.3). Shows only what `options` allows — so a model
 * the admin took away is not in any list — and the server checks again when it is saved (403/400). Starts from
 * `value`; callers give it a `key` of the saved value so a new one starts a fresh form.
 */
export function DefaultsEditor({
  options,
  value,
  busy,
  onSave,
  saveLabel = "기본값 저장",
}: {
  options: DefaultsOption[];
  value: RuntimeDefaults | null;
  busy: boolean;
  onSave: (d: RuntimeDefaults) => void;
  saveLabel?: string;
}) {
  const first = options[0]?.runtime;
  const [runtime, setRuntime] = useState<RuntimeId | undefined>(value?.runtime ?? first);
  const [models, setModels] = useState<RuntimeDefaults["models"]>(value?.models ?? {});

  if (options.length === 0)
    return <p className="muted small">고를 수 있는 런타임이 없어요 — 관리자에게 문의하세요.</p>;
  const current = options.some((o) => o.runtime === runtime) ? runtime! : options[0]!.runtime;

  const setModel = (rt: RuntimeId, d: ModelDefault | undefined) =>
    setModels((m) => {
      const next = { ...m };
      if (d) next[rt] = d;
      else delete next[rt];
      return next;
    });

  return (
    <form
      className="defaults-editor"
      onSubmit={(e) => {
        e.preventDefault();
        // Only entries that are still offered are saved.
        const kept: RuntimeDefaults["models"] = {};
        for (const o of options) {
          const d = models[o.runtime];
          const m = d && o.models.find((x) => x.id === d.model);
          if (d && m)
            kept[o.runtime] = {
              model: d.model,
              effort: d.effort && m.efforts.includes(d.effort) ? d.effort : null,
            };
        }
        onSave({ runtime: current, models: kept });
      }}
    >
      <label className="field">
        <span>기본 런타임</span>
        <select value={current} onChange={(e) => setRuntime(e.target.value as RuntimeId)}>
          {options.map((o) => (
            <option key={o.runtime} value={o.runtime}>
              {RUNTIME_LABEL[o.runtime]}
            </option>
          ))}
        </select>
      </label>
      {options.map((o) => {
        const d = models[o.runtime];
        const model = o.models.find((m) => m.id === d?.model);
        return (
          <fieldset key={o.runtime} className="defaults-runtime">
            <legend>{RUNTIME_LABEL[o.runtime]}</legend>
            <label className="field">
              <span>{RUNTIME_LABEL[o.runtime]} 기본 모델</span>
              <select
                value={model?.id ?? ""}
                onChange={(e) =>
                  setModel(o.runtime, e.target.value ? { model: e.target.value, effort: null } : undefined)
                }
              >
                <option value="">허용된 첫 모델</option>
                {o.models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            {model && model.efforts.length > 0 && (
              <label className="field">
                <span>{RUNTIME_LABEL[o.runtime]} 추론 강도</span>
                <select
                  value={d?.effort ?? ""}
                  onChange={(e) => setModel(o.runtime, { model: model.id, effort: e.target.value || null })}
                >
                  <option value="">
                    모델 기본값{model.defaultEffort ? ` (${model.defaultEffort})` : ""}
                  </option>
                  {model.efforts.map((x) => (
                    <option key={x} value={x}>
                      {x}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </fieldset>
        );
      })}
      <button type="submit" className="primary" disabled={busy}>
        {saveLabel}
      </button>
    </form>
  );
}
