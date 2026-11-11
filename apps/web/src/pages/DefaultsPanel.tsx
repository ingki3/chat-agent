import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { errorText, settings } from "../api.js";
import { DefaultsEditor, RUNTIME_LABEL } from "../DefaultsEditor.js";

const KEY = ["settings", "defaults"] as const;
const SOURCE = {
  own: "내가 정한 값",
  initial: "관리자가 정한 처음 값",
  service: "기본값 (Claude Code · Opus 5.5)",
};

/**
 * 설정 → 기본 런타임·모델 (FR-12.1·12.3, #35). The lists come from `/api/runtimes` — the runtimes, models and effort
 * values the admin allows this user — and the server checks the choice again (403). Applying the defaults to new
 * conversations, with the FR-12.6 fallback, comes with the chip (#19).
 */
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
