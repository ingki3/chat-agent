import { useEffect, useRef, useState } from "react";
import type { ChangeSettingsRequest, ChatSettings, RuntimeOption } from "@agentlee/shared";
import { errorText } from "../api.js";
import { canChooseShared, chipLabel, RUNTIME_NAME } from "./chip.js";

const dotClass = (r: string | null | undefined) =>
  r === "codex" ? "codex" : r === "claude-code" ? "claude" : "none";

/**
 * The runtime chip next to the composer (#19, PRD FR-3.5): shows who answers the next message and, when pressed,
 * lets the user change the runtime, model, effort and "공용으로 쓰기" of this conversation only. `options` are only
 * what can answer now (`/api/runtimes/usable`: allowed, with a passed connection); the server checks every change
 * again (403). `notice`: "기본값을 쓸 수 없어 ○○로 시작했어요", shown once by the page.
 */
export function RuntimeChip(props: {
  settings: ChatSettings | null;
  options: RuntimeOption[] | undefined;
  onChange: (change: ChangeSettingsRequest) => Promise<void>;
  notice?: string | null | undefined;
  /** "다음 메시지부터 …": the next reply differs from the last one. */
  pending?: boolean | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      document.getElementById("runtime-chip")?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const s = props.settings;
  const options = props.options;
  const option = s ? options?.find((o) => o.runtime === s.runtime) : undefined;
  const model = option?.models.find((m) => m.id === s?.model);
  const change = async (c: ChangeSettingsRequest) => {
    setBusy(true);
    setError(null);
    try {
      await props.onChange(c);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const label = chipLabel(s, options);
  return (
    <span className="chipwrap" ref={wrap}>
      {props.notice && (
        <span className="chipnote warn small" role="status" data-testid="fallback-notice">
          {props.notice}
        </span>
      )}
      {!props.notice && props.pending && s && (
        <span className="chipnote small muted" data-testid="chip-pending">
          다음 메시지부터
        </span>
      )}
      <button
        type="button"
        id="runtime-chip"
        className="rtchip"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`런타임·모델: ${label}`}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`dot ${dotClass(s?.runtime)}`} />
        <span className="rt-name">{label}</span>
      </button>
      {open && (
        <div className="pop open small" role="dialog" aria-label="런타임·모델 선택">
          {!options ? (
            <p className="muted">불러오는 중…</p>
          ) : options.length === 0 ? (
            <p>쓸 수 있는 런타임이 없어요 — 관리자에게 문의하세요.</p>
          ) : (
            <>
              <fieldset className="chipfield" disabled={busy}>
                <legend>런타임</legend>
                {options.map((o) => (
                  <label key={o.runtime} className="row">
                    <input
                      type="radio"
                      name="chip-runtime"
                      checked={s?.runtime === o.runtime}
                      onChange={() => void change({ runtime: o.runtime })}
                    />
                    <span className={`dot ${dotClass(o.runtime)}`} />
                    {RUNTIME_NAME[o.runtime] ?? o.runtime}
                  </label>
                ))}
              </fieldset>
              {s && !option && (
                <p className="warn">지금 이 런타임은 쓸 수 없어요 — 다른 런타임을 고르세요.</p>
              )}
              {option && (
                <label className="chipfield">
                  모델
                  <select
                    aria-label="모델"
                    disabled={busy}
                    value={model ? model.id : ""}
                    onChange={(e) => void change({ model: e.target.value })}
                  >
                    {!model && <option value="">(지금은 쓸 수 없는 모델)</option>}
                    {option.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {model && model.efforts.length > 0 && (
                <label className="chipfield">
                  추론 강도
                  <select
                    aria-label="추론 강도"
                    disabled={busy}
                    value={s?.effort ?? ""}
                    onChange={(e) => void change({ effort: e.target.value })}
                  >
                    {!s?.effort || !model.efforts.includes(s.effort) ? <option value="">-</option> : null}
                    {model.efforts.map((x) => (
                      <option key={x} value={x}>
                        {x}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {canChooseShared(option) && (
                <label className="row chipfield">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={s?.useShared ?? false}
                    onChange={(e) => void change({ useShared: e.target.checked })}
                  />
                  공용으로 쓰기
                </label>
              )}
              <p className="muted">
                이 대화에만 적용되고, 다음 메시지부터 바뀌어요. 기본값은 설정에서 바꿔요.
              </p>
            </>
          )}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </span>
  );
}
