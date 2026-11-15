import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { MEMORY_DOC_FILE, type MemoryDocKind } from "@agentlee/shared";
import { errorText, instructions, INSTRUCTIONS_KEY } from "../api.js";
import { TopBar } from "../Shell.js";
import { DocEditor } from "../instructions/DocEditor.js";
import { MemoryModeSetting } from "../instructions/MemoryModeSetting.js";
import { DreamingPanel } from "../instructions/DreamingPanel.js";

const KINDS: MemoryDocKind[] = ["agent", "soul", "user", "memory"];
/** The tabs: the four documents, then 기억 정리 (#146: its proposals, DREAMS.md and the prompt in use). */
type Tab = MemoryDocKind | "dreams";
const TABS: Tab[] = [...KINDS, "dreams"];
const TAB_LABEL = (t: Tab) => (t === "dreams" ? "기억 정리" : MEMORY_DOC_FILE[t]);
const HINT: Record<MemoryDocKind, string> = {
  agent: "관리자가 정한 운영 규칙이에요(가족 공통 → 청소년 지침 → 이 계정). 읽기만 할 수 있어요.",
  soul: '답하는 말투·성격이에요. 예: "반말로 짧게". 규칙·안전 지침을 바꾸는 문장은 저장되지 않아요.',
  user: '나에 대한 정보·선호를 한 줄에 하나씩 적어요. 예: "답은 표 위주로".',
  memory: "대화에서 쌓인 오래 기억할 사실·결정이에요. 한 줄에 하나씩, 필요 없는 줄은 지우면 돼요.",
};

/**
 * 설정 → 내 지침 (#144, PRD FR-16.1·16.3): AGENT.md (read-only), SOUL.md, USER.md, MEMORY.md — one tab each, the tab
 * in the address (`?doc=`). What is saved goes into every new conversation session from the next message on.
 */
export function InstructionsPage() {
  const [params, setParams] = useSearchParams();
  const kind: Tab = TABS.includes(params.get("doc") as Tab) ? (params.get("doc") as Tab) : "soul";
  const docs = useQuery({ queryKey: INSTRUCTIONS_KEY, queryFn: instructions.list });
  const doc = docs.data?.find((d) => d.kind === kind);
  return (
    <>
      <TopBar title="📝 내 지침" />
      <div className="page">
        <p className="muted small">
          <Link to="/settings">← 설정</Link> · 여기 적은 내용은 새 대화마다 Claude Code와 Codex에 똑같이
          들어가요. 관리자도 내 SOUL·USER·MEMORY는 볼 수 없어요.
        </p>
        <MemoryModeSetting />
        <div className="tabs" role="tablist" aria-label="내 지침 문서">
          {TABS.map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              id={`doc-tab-${k}`}
              aria-selected={kind === k}
              aria-controls={`doc-panel-${k}`}
              className={kind === k ? "on" : ""}
              onClick={() => setParams(k === "soul" ? {} : { doc: k }, { replace: true })}
            >
              {TAB_LABEL(k)}
            </button>
          ))}
        </div>
        <section
          className="panel"
          role="tabpanel"
          id={`doc-panel-${kind}`}
          aria-labelledby={`doc-tab-${kind}`}
        >
          {kind === "dreams" && <DreamingPanel />}
          {kind !== "dreams" && docs.isError && <p className="error">{errorText(docs.error)}</p>}
          {kind !== "dreams" && doc && (
            <DocEditor
              key={kind}
              doc={doc}
              api={instructions.doc(kind)}
              queryKey={INSTRUCTIONS_KEY}
              hint={HINT[doc.kind]}
            />
          )}
        </section>
      </div>
    </>
  );
}
