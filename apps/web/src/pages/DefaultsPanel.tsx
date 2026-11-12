import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DefaultsResponse } from "@agentlee/shared";
import { errorText, settings } from "../api.js";
import { DefaultsEditor, RUNTIME_LABEL } from "../DefaultsEditor.js";
import { chipLabel, untilText } from "../chat/chip.js";

const KEY = ["settings", "defaults"] as const;
const SOURCE = {
  own: "내가 정한 값",
  initial: "관리자가 정한 처음 값",
  service: "기본값 (Claude Code · Opus 5.5)",
};

/**
 * 설정 → 기본 런타임·모델 (FR-12.1·12.3, #35). The lists come from `/api/runtimes` — the runtimes, models and effort
 * values the admin allows this user — and the server checks the choice again (403). New conversations start on
 * these (#19); when they cannot be used right now (not allowed any more, no passed connection), the panel says what
 * new conversations start with instead (FR-12.6), or that nothing is usable.
 */
const defaultOf = (d: DefaultsResponse) => {
  const m = d.defaults.models[d.defaults.runtime];
  return m ? { runtime: d.defaults.runtime, model: m.model } : { runtime: d.defaults.runtime, model: "" };
};

export function DefaultsPanel() {
  const qc = useQueryClient();
  const runtimes = useQuery({ queryKey: ["runtimes"], queryFn: settings.runtimes });
  const defaults = useQuery({ queryKey: KEY, queryFn: settings.defaults });
  const [message, setMessage] = useState<string>();
  const save = useMutation({
    mutationFn: settings.setDefaults,
    onMutate: () => setMessage(undefined),
    onSuccess: (d) => {
      qc.setQueryData(KEY, d);
      setMessage("기본값을 저장했어요. 다음 새 대화부터 적용돼요.");
    },
    onError: (e) => setMessage(errorText(e)),
  });
  const d = defaults.data;
  return (
    <section className="panel" id="defaults" aria-labelledby="defaults-h">
      <h2 id="defaults-h">기본 런타임·모델</h2>
      {d && (
        <p className="muted small" data-testid="defaults-source">
          지금: {SOURCE[d.source]}
        </p>
      )}
      {d && d.unavailable.length > 0 && (
        <div className="notice warn small" role="note" data-testid="defaults-unavailable">
          {d.unavailable.map((r) => RUNTIME_LABEL[r]).join(", ")}의 저장된 기본값을 지금은 쓸 수
          없어요(관리자가 허용을 바꿨거나 이 서버에 없어요). 다시 골라 저장하세요.
        </div>
      )}
      {d && d.start === null && (
        <div className="notice err small" role="note" data-testid="defaults-start">
          지금은 쓸 수 있는 런타임이 없어요 — 관리자에게 문의하세요. 새 대화를 시작할 수 없어요.
        </div>
      )}
      {d?.fallback && d.start && (
        <div className="notice warn small" role="note" data-testid="defaults-start">
          기본값({chipLabel(defaultOf(d), runtimes.data)})을 지금 쓸 수 없어 새 대화는{" "}
          {chipLabel(d.start, runtimes.data)}로 시작해요.{" "}
          {d.limitedUntil !== null
            ? `사용 한도에 걸렸어요 — ${untilText(d.limitedUntil)} 이후 다시 기본값으로 시작해요.`
            : "연결(설정 → 내 런타임 연결)을 확인하거나 다른 기본값을 고르세요."}
        </div>
      )}
      {(runtimes.isError || defaults.isError) && (
        <p className="error small">{errorText(runtimes.error ?? defaults.error)}</p>
      )}
      {runtimes.data && d && (
        <DefaultsEditor
          key={JSON.stringify(d.defaults)}
          options={runtimes.data}
          value={d.source === "service" ? null : d.defaults}
          busy={save.isPending}
          onSave={(v) => save.mutate(v)}
        />
      )}
      {d?.source === "own" && (
        <button type="button" className="small" disabled={save.isPending} onClick={() => save.mutate(null)}>
          처음 값으로 되돌리기
        </button>
      )}
      {message && (
        <p className="small" role="status">
          {message}
        </p>
      )}
    </section>
  );
}
