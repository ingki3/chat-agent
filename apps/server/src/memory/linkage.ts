import type { Db } from "../db/client.js";
import type { ConversationPurge } from "../conversations/purge.js";
import type { ConversationStore } from "../conversations/store.js";
import { logEvent, type EventLogger } from "../logging.js";
import type { MemoryStore } from "./store.js";

/**
 * Deletion linkage of 내 지침 (#144, PRD FR-16.9, docs/memory-spec.md §10). When a conversation is deleted, or messages
 * leave its active history (edit / regenerate), in the same transaction:
 * 1. every item citing one of those messages goes whole, from the current document (a new "삭제 연동" version) and
 *    from every older version (MemoryStore.purgeSources) — a restore cannot bring it back;
 * 2. every runtime session of that user started with a document version that held one of them is invalidated and
 *    becomes a deletion job (`ConversationPurge.claimSessions`): forgotten with `RuntimeAdapter.forget` once its
 *    conversation's running turn has ended, and resumed at start when the server stopped in between.
 * Answers and summaries already written elsewhere stay — they are that conversation's own record (§10.6).
 * Proposals and the re-processing queue (§10.3) come with #145/#146.
 */
export function linkMemoryDeletion(deps: {
  db: Db;
  conversations: ConversationStore;
  store: MemoryStore;
  purge: Pick<ConversationPurge, "claimSessions">;
  log?: EventLogger | undefined;
}): void {
  const run = (by: { conversationId: string } | { messageIds: readonly string[] }) => {
    const r = deps.store.purgeSources(by);
    if (!r.items) return;
    const sessions = sessionsStartedWith(deps.db, r.affected);
    deps.purge.claimSessions(sessions);
    logEvent(deps.log, "info", "memory.items_unlinked", { count: r.items });
  };
  deps.conversations.onDelete((conversationId) => run({ conversationId }));
  deps.conversations.onDeactivate((_conversationId, messageIds) => run({ messageIds }));
}

/** The runtime sessions of each document's owner that were started with one of the given versions (spec §10.5). */
export function sessionsStartedWith(
  db: Db,
  affected: { documentId: string; ownerId: string | null; versions: number[] }[],
) {
  const q = db.$client.prepare(
    `SELECT DISTINCT s.id AS id, s.conversation_id AS conversationId, c.owner_id AS userId, s.runtime AS runtime,
            s.connection_id AS connectionId, s.external_session_id AS externalSessionId
       FROM runtime_sessions s
       JOIN conversations c ON c.id = s.conversation_id,
            json_each(s.doc_versions) j
      WHERE s.doc_versions IS NOT NULL
        AND c.owner_id = ? AND j.key = ? AND j.value IN (SELECT value FROM json_each(?))`,
  );
  const out = new Map<
    string,
    {
      id: string;
      conversationId: string;
      userId: string;
      runtime: string;
      connectionId: string | null;
      externalSessionId: string;
    }
  >();
  for (const a of affected) {
    if (!a.ownerId || !a.versions.length) continue;
    for (const s of q.all(a.ownerId, a.documentId, JSON.stringify(a.versions)) as {
      id: string;
      conversationId: string;
      userId: string;
      runtime: string;
      connectionId: string | null;
      externalSessionId: string;
    }[])
      out.set(s.id, s);
  }
  return [...out.values()];
}
