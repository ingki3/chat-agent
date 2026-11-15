import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Conversation } from "@agentlee/shared";
import { conversations, errorText } from "../api.js";
import "./citations.css";

/**
 * 자료 조사 모드 (PRD FR-5.5, #25), per conversation: on, the next reply is told to compare several sources, say
 * when they are not enough and state nothing without a citation (the #20 research instructions). The server
 * keeps the setting (`conversations.research_mode`); this is only its switch.
 */
export function ResearchToggle({ c }: { c: Conversation }) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: () => conversations.research(c.id, !c.researchMode),
    onSuccess: (next) => qc.setQueryData(["conversation", c.id], next),
    onError: (e) => alert(errorText(e)),
  });
  const on = c.researchMode;
  return (
    <button
      type="button"
      className={`ghost small research-toggle${on ? " on" : ""}`}
      data-testid="research-toggle"
      aria-pressed={on}
      disabled={toggle.isPending}
      title={
        on ? "자료 조사 모드 켜짐: 여러 출처를 비교하고 출처 없는 단정은 쓰지 않아요" : "자료 조사 모드 켜기"
      }
      onClick={() => toggle.mutate()}
    >
      🔎 자료 조사{on ? " 켜짐" : ""}
    </button>
  );
}
