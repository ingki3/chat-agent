import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { adminInstructions, ADMIN_INSTRUCTIONS_KEY, errorText } from "../api.js";
import { DocEditor } from "../instructions/DocEditor.js";

/**
 * 관리자 → 지침 (#144, PRD FR-16.1): the family-wide AGENT.md, the default SOUL.md (for everyone who has not written
 * their own) and each account's AGENT.md. Never anyone's SOUL / USER / MEMORY — the server refuses those (403).
 */
export function InstructionsAdmin() {
  const data = useQuery({ queryKey: ADMIN_INSTRUCTIONS_KEY, queryFn: adminInstructions.get });
  const [account, setAccount] = useState<string>();
  const d = data.data;
  const chosen = d?.accounts.find((a) => a.userId === account) ?? d?.accounts[0];
  return (
    <div className="admin-instructions">
      {data.isError && <p className="error">{errorText(data.error)}</p>}
      {d && (
        <>
          <section className="panel" aria-labelledby="ins-common-h">
            <h2 id="ins-common-h">가족 공통 AGENT.md</h2>
            <DocEditor
              doc={d.commonAgent}
              api={adminInstructions.doc("common-agent")}
              queryKey={ADMIN_INSTRUCTIONS_KEY}
              hint="모든 가족의 새 대화에 저장소의 공통 지침 다음, 청소년 지침 앞에 들어가요."
            />
          </section>
          <section className="panel" aria-labelledby="ins-soul-h">
            <h2 id="ins-soul-h">기본 SOUL.md</h2>
            <DocEditor
              doc={d.defaultSoul}
              api={adminInstructions.doc("default-soul")}
              queryKey={ADMIN_INSTRUCTIONS_KEY}
              hint="자기 SOUL.md를 쓰지 않은 가족에게 쓰이는 말투·성격이에요. 사용자 자료 칸에 들어가요."
            />
          </section>
          <section className="panel" aria-labelledby="ins-account-h">
            <h2 id="ins-account-h">계정별 AGENT.md</h2>
            {chosen ? (
              <>
                <label className="inline">
                  계정
                  <select value={chosen.userId} onChange={(e) => setAccount(e.target.value)}>
                    {d.accounts.map((a) => (
                      <option key={a.userId} value={a.userId}>
                        {a.name}
                        {a.youth ? " (청소년)" : ""}
                      </option>
                    ))}
                  </select>
                </label>
                <DocEditor
                  key={chosen.userId}
                  doc={chosen.agent}
                  api={adminInstructions.doc(`account-agent:${chosen.userId}`)}
                  queryKey={ADMIN_INSTRUCTIONS_KEY}
                  hint="이 계정의 새 대화에만, 청소년 지침 다음에 들어가요. 사용자는 읽기만 할 수 있어요."
                />
              </>
            ) : (
              <p className="muted">계정이 없어요.</p>
            )}
          </section>
          <p className="muted small">
            가족의 SOUL·USER·MEMORY 내용은 관리자도 볼 수 없어요(서버가 거부해요).
          </p>
        </>
      )}
    </div>
  );
}
