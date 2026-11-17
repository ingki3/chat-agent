import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { conversations } from "../api.js";
import { useRunStream } from "../chat/stream.js";
import { keepAfter } from "../chat/after-run.js";
import { CONVERSATIONS_KEY } from "../Sidebar.js";
import { MY_ARTIFACTS_KEY, artifactKey } from "./viewer.js";

/**
 * The artifact page follows the conversation's running reply (review #175): the chat moves here as soon as a run
 * names an artifact (#172), and leaving the chat closed its stream — so this page subscribes to that run itself.
 * - each artifact version the run stores (`artifact_ref` parts) refreshes the artifact: a v2 made later in the same
 *   run shows at once (the page follows the newest unless a version was picked);
 * - when the run ends, everything the chat screen would have refreshed is refreshed (its messages, its run state —
 *   so the chat is not left busy —, the conversation, the sidebar list, the artifacts), and its notices and error
 *   are kept for the chat screen to show when the user goes back (`after-run.ts`).
 * Owner only: someone a share shows it to cannot read the conversation's run (403, nothing followed).
 */
export function useFollowRun(conversationId: string | undefined, artifactId: string, enabled: boolean) {
  const qc = useQueryClient();
  const on = enabled && !!conversationId;
  const cid = conversationId ?? "";
  // The chat screen's own key: what it knew is used at once, and what is read here is what it shows on return.
  const active = useQuery({
    queryKey: ["active-run", cid],
    queryFn: ({ signal }) => conversations.activeRun(cid, signal),
    enabled: on,
    retry: false,
  });
  const refreshAll = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["messages", cid] }),
      qc.invalidateQueries({ queryKey: ["active-run", cid] }),
      qc.invalidateQueries({ queryKey: ["conversation", cid] }),
      qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY }),
      qc.invalidateQueries({ queryKey: ["artifact"] }),
      qc.invalidateQueries({ queryKey: MY_ARTIFACTS_KEY }),
    ]);
  const { live } = useRunStream(
    on ? active.data : null,
    (last) => {
      if (last.notices.length || last.error)
        keepAfter(cid, last.messageId, {
          notices: last.notices,
          ...(last.error ? { error: last.error } : {}),
        });
      void refreshAll();
    },
    () => void refreshAll(),
  );
  // The versions this run has stored so far; a new one refreshes the artifact on screen.
  const stored = (live?.parts ?? [])
    .flatMap((p) => (p.type === "artifact_ref" ? [`${p.artifactId}:${p.version ?? ""}`] : []))
    .join(",");
  useEffect(() => {
    if (!stored) return;
    void qc.invalidateQueries({ queryKey: artifactKey(artifactId), exact: true });
    void qc.invalidateQueries({ queryKey: MY_ARTIFACTS_KEY });
  }, [stored, artifactId, qc]);
}
