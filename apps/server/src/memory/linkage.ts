import type { Db } from "../db/client.js";
import type { ConversationPurge } from "../conversations/purge.js";
import type { ConversationStore } from "../conversations/store.js";
import { logEvent, type EventLogger } from "../logging.js";
import type { MemoryProposals } from "./proposals.js";
import type { MemoryStore } from "./store.js";
import type { DreamingStore } from "../dreaming/store.js";

/**
 * Deletion linkage of 내 지침 (#144, PRD FR-16.9, docs/memory-spec.md §10). When a conversation is deleted, or messages
 * leave its active history (edit / regenerate), in the same transaction:
 * 1. every item citing one of those messages goes whole, from the current document (a new "삭제 연동" version) and
 *    from every older version (MemoryStore.purgeSources) — a restore cannot bring it back;
 * 2. every runtime session of that user started with a document version that held one of them is invalidated and
 *    becomes a deletion job (`ConversationPurge.claimSessions`): forgotten with `RuntimeAdapter.forget` once its
 *    conversation's running turn has ended, and resumed at start when the server stopped in between.
 * Answers and summaries already written elsewhere stay — they are that conversation's own record (§10.6).
 * 3. every decision of a bundle — the conversation tool's (#145) or 기억 정리's (#146) — citing one of them is dropped
 *    (§10.3), and so are 기억 정리's queue entries of those messages (a deleted conversation's go with its messages).
 */
export function linkMemoryDeletion(deps: {
  db: Db;
  conversations: ConversationStore;
  store: MemoryStore;
  purge: Pick<ConversationPurge, "claimSessions">;
  proposals?: Pick<MemoryProposals, "dropBySources"> | undefined;
  /** 기억 정리's re-processing queue (#146): entries of messages that left the history go (a deleted conversation's
   * go with its messages). */
  dreaming?: Pick<DreamingStore, "dropQueued"> | undefined;
  log?: EventLogger | undefined;
}): void {
  const run = (by: { conversationId: string } | { messageIds: readonly string[] }) => {
    deps.proposals?.dropBySources(by);
    if ("messageIds" in by) deps.dreaming?.dropQueued(by.messageIds);
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

/**
 * A session registered after the deletion linkage ran (#144 review 1): its documents were read before, while it was
 * still opening, so the linkage did not find it (no row yet). Checked right after its row is saved — a version it
 * started with that the linkage has edited since (`unlinked_at`) held a removed item: the session is invalidated and
 * queued to be forgotten like the others (after its turn). Saved before the linkage ran, the linkage finds the row
 * itself — together the two never miss one. True when it was claimed.
 */
export function claimIfStale(
  db: Db,
  purge: Pick<ConversationPurge, "claimSessions">,
  session: {
    id: string;
    conversationId: string;
    runtime: string;
    connectionId: string | null;
    externalSessionId: string;
    docVersions: string | null;
  },
): boolean {
  if (!session.docVersions || session.docVersions === "{}") return false;
  const sql = db.$client;
  const stale = sql
    .prepare(
      `SELECT 1 FROM memory_versions v, json_each(?) j
        WHERE v.document_id = j.key AND v.version = j.value AND v.unlinked_at IS NOT NULL LIMIT 1`,
    )
    .get(session.docVersions);
  if (!stale) return false;
  const owner = sql
    .prepare("SELECT owner_id AS o FROM conversations WHERE id = ?")
    .get(session.conversationId) as { o: string } | undefined;
  if (!owner) return false; // its conversation is gone: the delete's own jobs (or the orphan path) forget it
  purge.claimSessions([{ ...session, userId: owner.o }]);
  return true;
}

/**
 * Start-up check (#144 review 2): every still-valid session whose row names a document version the deletion linkage
 * has edited (`unlinked_at`) is claimed now — whatever left it so (an older build, a check that could not run). Its
 * runs were all ended by the restart, so the jobs run once serving. Returns how many were claimed.
 */
export function reclaimStaleSessions(db: Db, purge: Pick<ConversationPurge, "claimSessions">): number {
  const rows = db.$client
    .prepare(
      `SELECT DISTINCT s.id AS id, s.conversation_id AS conversationId, c.owner_id AS userId, s.runtime AS runtime,
              s.connection_id AS connectionId, s.external_session_id AS externalSessionId
         FROM runtime_sessions s
         JOIN conversations c ON c.id = s.conversation_id,
              json_each(s.doc_versions) j
         JOIN memory_versions v ON v.document_id = j.key AND v.version = j.value
        WHERE s.invalidated = 0 AND s.doc_versions IS NOT NULL AND v.unlinked_at IS NOT NULL`,
    )
    .all() as {
    id: string;
    conversationId: string;
    userId: string;
    runtime: string;
    connectionId: string | null;
    externalSessionId: string;
  }[];
  if (rows.length) db.$client.transaction(() => purge.claimSessions(rows))();
  return rows.length;
}
