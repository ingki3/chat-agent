import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MEMORY_APPLY_MODE_LABEL, MemoryApplyMode } from "@agentlee/shared";
import { errorText, MEMORY_PREFS_KEY, memoryPrefs } from "../api.js";

const HELP: Record<MemoryApplyMode, string> = {
  review: '대화 중 "기억해줘·잊어줘"는 답 아래 카드에서 반영을 눌러야 바뀌어요.',
  auto: '바로 반영하고 답 아래에 "기억했어요 · 되돌리기"를 보여 줘요. 건강·주소 같은 민감한 내용과 웹·파일을 읽은 답은 그래도 카드로 확인해요.',
};

/**
 * 설정 → 내 지침 → "기억 반영 방식" (#145, PRD FR-16.7, docs/memory-spec.md §5): 검토 후 반영 (default) or 자동 반영
 * + 알림 — one setting for the conversation tool and Dreaming (#146).
 */
export function MemoryModeSetting() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: MEMORY_PREFS_KEY, queryFn: memoryPrefs.get });
  // The choice shows at once (a controlled radio would snap back until the save answers); a failed save shows the
  // stored one again.
  const [picked, setPicked] = useState<MemoryApplyMode | null>(null);
  const save = useMutation({
    mutationFn: (m: MemoryApplyMode) => memoryPrefs.set(m),
    onSuccess: (p) => qc.setQueryData(MEMORY_PREFS_KEY, p),
    onSettled: () => setPicked(null),
  });
  const mode = picked ?? q.data?.applyMode;
  return (
    <section className="panel memory-mode" data-testid="memory-mode">
      <fieldset disabled={!q.data} aria-busy={save.isPending}>
        <legend>기억 반영 방식</legend>
        {MemoryApplyMode.options.map((m) => (
          <label key={m}>
            <input
              type="radio"
              name="memory-apply-mode"
              value={m}
              checked={mode === m}
              onChange={() => {
                setPicked(m);
                save.mutate(m);
              }}
              aria-describedby={`memory-mode-help-${m}`}
            />
            <span>
              {MEMORY_APPLY_MODE_LABEL[m]}
              {m === "review" && " (기본)"}
              <span id={`memory-mode-help-${m}`} className="small muted" style={{ display: "block" }}>
                {HELP[m]}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
      {(q.isError || save.isError) && (
        <p className="error small" role="alert">
          {errorText(q.error ?? save.error)}
        </p>
      )}
    </section>
  );
}
