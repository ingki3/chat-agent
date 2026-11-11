import crypto from "node:crypto";
import { and, asc, desc, eq, gte, lt, or, sql } from "drizzle-orm";
import {
  autoTitle,
  MessagePart,
  publicParts,
  type Conversation,
  type Message,
  type RuntimeId,
} from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { conversations, messages, runtimeSessions } from "../db/schema.js";

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type SessionRow = typeof runtimeSessions.$inferSelect;

export const DEFAULT_TITLE = "새 대화";

/** Called inside the delete transaction, before rows go — files, artifacts and shares hook in here (#54). */
export type DeleteHook = (conversationId: string) => void;

export function toConversation(c: ConversationRow): Conversation {
  return {
    id: c.id,
    title: c.title,
    pinned: c.pinned,
    kind: c.kind,
    lastRuntime: (c.lastRuntime as RuntimeId | null) ?? null,
    forkedFrom: c.forkedFrom ?? null,
    revision: c.revision,
    researchMode: c.researchMode,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/** Public form of a message: internal parts (reasoning) are removed here, for every API response. */
export function toMessage(m: MessageRow): Message {
  return {
    id: m.id,
    conversationId: m.conversationId,
    seq: m.seq,
    role: m.role,
    parts: publicParts(MessagePart.array().parse(m.parts)),
    runtime: (m.runtime as RuntimeId | null) ?? null,
    model: m.model ?? null,
    effort: m.effort ?? null,
    status: m.status,
    revision: m.revision,
    replaces: m.replaces ?? null,
    createdAt: m.createdAt,
  };
}

const searchTextOf = (parts: MessagePart[]) =>
  publicParts(parts)
    .map((p) => (p.type === "text" ? p.text : ""))
    .join("\n");

type Cursor = { p: number; u: number; i: string };
const encodeCursor = (c: ConversationRow) =>
  Buffer.from(JSON.stringify({ p: c.pinned ? 1 : 0, u: c.updatedAt, i: c.id } satisfies Cursor)).toString(
    "base64url",
  );
function decodeCursor(s: string): Cursor | undefined {
  try {
    const c = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Cursor;
    return typeof c.p === "number" && typeof c.u === "number" && typeof c.i === "string" ? c : undefined;
  } catch {
    return undefined;
  }
}
const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export class ConversationStore {
  private readonly deleteHooks: DeleteHook[] = [];

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  onDelete(hook: DeleteHook): void {
    this.deleteHooks.push(hook);
  }

  get(id: string): ConversationRow | undefined {
    return this.db.select().from(conversations).where(eq(conversations.id, id)).get();
  }

  create(
    ownerId: string,
    opts: { title?: string | undefined; kind?: ConversationRow["kind"]; forkedFrom?: string } = {},
  ): ConversationRow {
    const t = this.now();
    const row = {
      id: crypto.randomUUID(),
      ownerId,
      title: opts.title ?? DEFAULT_TITLE,
      titleSource: opts.title ? ("user" as const) : ("auto" as const),
      pinned: false,
      kind: opts.kind ?? ("normal" as const),
      forkedFrom: opts.forkedFrom ?? null,
      lastRuntime: null,
      revision: 0,
      researchMode: false,
      nextSeq: 1,
      createdAt: t,
      updatedAt: t,
    };
    this.db.insert(conversations).values(row).run();
    return row;
  }

  /**
   * The owner's conversations: pinned first, then most recently updated. `q` matches the title or the public
   * text of active messages. Keyset pagination with an opaque cursor.
   */
  list(
    ownerId: string,
    opts: {
      q?: string | undefined;
      pinned?: boolean | undefined;
      limit: number;
      cursor?: string | undefined;
    },
  ): { items: ConversationRow[]; nextCursor: string | null } {
    const conds = [eq(conversations.ownerId, ownerId)];
    if (opts.pinned !== undefined) conds.push(eq(conversations.pinned, opts.pinned));
    if (opts.q) {
      const pattern = `%${likeEscape(opts.q)}%`;
      conds.push(
        or(
          sql`${conversations.title} like ${pattern} escape '\\'`,
          sql`exists (select 1 from ${messages} where ${messages.conversationId} = ${conversations.id}
                and ${messages.active} = 1 and ${messages.searchText} like ${pattern} escape '\\')`,
        )!,
      );
    }
    const cur = opts.cursor ? decodeCursor(opts.cursor) : undefined;
    if (cur) {
      const pinnedNum = sql`(case when ${conversations.pinned} then 1 else 0 end)`;
      conds.push(
        or(
          sql`${pinnedNum} < ${cur.p}`,
          and(sql`${pinnedNum} = ${cur.p}`, lt(conversations.updatedAt, cur.u)),
          and(sql`${pinnedNum} = ${cur.p}`, eq(conversations.updatedAt, cur.u), lt(conversations.id, cur.i)),
        )!,
      );
    }
    const rows = this.db
      .select()
      .from(conversations)
      .where(and(...conds))
      .orderBy(desc(conversations.pinned), desc(conversations.updatedAt), desc(conversations.id))
      .limit(opts.limit + 1)
      .all();
    const items = rows.slice(0, opts.limit);
    return { items, nextCursor: rows.length > opts.limit ? encodeCursor(items.at(-1)!) : null };
  }

  rename(id: string, title: string): void {
    this.db
      .update(conversations)
      .set({ title, titleSource: "user", updatedAt: this.now() })
      .where(eq(conversations.id, id))
      .run();
  }

  /** 자료 조사 모드 (FR-5.5). Not activity either; the next run picks it up (new instructions → fresh session). */
  setResearchMode(id: string, researchMode: boolean): void {
    this.db.update(conversations).set({ researchMode }).where(eq(conversations.id, id)).run();
  }

  setPinned(id: string, pinned: boolean): void {
    // Pinning is not activity: updatedAt (the "recent" order) stays.
    this.db.update(conversations).set({ pinned }).where(eq(conversations.id, id)).run();
  }

  /** Deletes the conversation, its messages and runtime sessions; extension hooks run first, in one transaction. */
  delete(id: string): void {
    this.db.$client.transaction(() => {
      for (const hook of this.deleteHooks) hook(id);
      this.db.delete(conversations).where(eq(conversations.id, id)).run();
    })();
  }

  /** Appends to the current history. A first user message names an untitled conversation. */
  append(
    conversationId: string,
    m: {
      role: MessageRow["role"];
      parts: MessagePart[];
      runtime?: string | null;
      model?: string | null;
      effort?: string | null;
      connectionId?: string | null;
      status?: MessageRow["status"];
      replaces?: string | null;
    },
  ): MessageRow {
    return this.db.$client.transaction(() => {
      const conv = this.get(conversationId);
      if (!conv) throw new Error("conversation not found");
      const parts = MessagePart.array().parse(m.parts);
      const t = this.now();
      const row: MessageRow = {
        id: crypto.randomUUID(),
        conversationId,
        seq: conv.nextSeq,
        role: m.role,
        parts,
        searchText: searchTextOf(parts),
        runtime: m.runtime ?? null,
        model: m.model ?? null,
        effort: m.effort ?? null,
        connectionId: m.connectionId ?? null,
        status: m.status ?? "complete",
        revision: conv.revision,
        active: true,
        replaces: m.replaces ?? null,
        supersededBy: null,
        archivedAtRevision: null,
        createdAt: t,
      };
      this.db.insert(messages).values(row).run();
      const firstUserText =
        m.role === "user" && conv.titleSource === "auto" && conv.title === DEFAULT_TITLE
          ? parts.find((p) => p.type === "text")
          : undefined;
      this.db
        .update(conversations)
        .set({
          nextSeq: conv.nextSeq + 1,
          updatedAt: t,
          ...(m.runtime ? { lastRuntime: m.runtime } : {}),
          ...(firstUserText?.type === "text" ? { title: autoTitle(firstUserText.text) } : {}),
        })
        .where(eq(conversations.id, conversationId))
        .run();
      if (m.replaces)
        this.db.update(messages).set({ supersededBy: row.id }).where(eq(messages.id, m.replaces)).run();
      return row;
    })();
  }

  /** Updates a message being generated (parts so far, final status). */
  updateMessage(
    id: string,
    patch: {
      parts?: MessagePart[];
      status?: MessageRow["status"];
      runtime?: string;
      model?: string;
      effort?: string | null;
    },
  ): void {
    const parts = patch.parts ? MessagePart.array().parse(patch.parts) : undefined;
    this.db
      .update(messages)
      .set({
        ...(parts ? { parts, searchText: searchTextOf(parts) } : {}),
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.runtime ? { runtime: patch.runtime } : {}),
        ...(patch.model ? { model: patch.model } : {}),
        ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
      })
      .where(eq(messages.id, id))
      .run();
  }

  messageById(id: string): MessageRow | undefined {
    return this.db.select().from(messages).where(eq(messages.id, id)).get();
  }

  message(conversationId: string, messageId: string): MessageRow | undefined {
    return this.db
      .select()
      .from(messages)
      .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
      .get();
  }

  /** One page of the active history (oldest → newest) and whether older messages exist. */
  messagePage(
    conversationId: string,
    opts: { before?: number | undefined; limit: number },
  ): { items: MessageRow[]; hasMore: boolean } {
    const rows = this.messages(conversationId, { ...opts, limit: opts.limit + 1 });
    const hasMore = rows.length > opts.limit;
    return { items: hasMore ? rows.slice(1) : rows, hasMore };
  }

  /** Active history, newest page first by `before`, returned oldest → newest. */
  messages(conversationId: string, opts: { before?: number | undefined; limit: number }): MessageRow[] {
    const rows = this.db
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.conversationId, conversationId),
          eq(messages.active, true),
          opts.before === undefined ? undefined : lt(messages.seq, opts.before),
        ),
      )
      .orderBy(desc(messages.seq))
      .limit(opts.limit)
      .all();
    return rows.reverse();
  }

  /** Every version of a message: follows `replaces` back and `supersededBy` forward. Oldest first. */
  versions(conversationId: string, messageId: string): MessageRow[] {
    let first = this.message(conversationId, messageId);
    if (!first) return [];
    const seen = new Set<string>([first.id]);
    while (first.replaces) {
      const prev = this.message(conversationId, first.replaces);
      if (!prev || seen.has(prev.id)) break;
      seen.add(prev.id);
      first = prev;
    }
    const out = [first];
    while (out.at(-1)!.supersededBy) {
      const next = this.message(conversationId, out.at(-1)!.supersededBy!);
      if (!next || out.some((m) => m.id === next.id)) break;
      out.push(next);
    }
    return out;
  }

  /**
   * Rewrites history from `messageId` on (edit / regenerate): that message and everything after it leave the
   * history but are kept, the revision goes up, and runtime sessions that saw the old history are invalidated.
   * Returns the new revision.
   */
  private truncateFrom(conv: ConversationRow, target: MessageRow): number {
    const revision = conv.revision + 1;
    this.db
      .update(messages)
      .set({ active: false, archivedAtRevision: revision })
      .where(
        and(eq(messages.conversationId, conv.id), eq(messages.active, true), gte(messages.seq, target.seq)),
      )
      .run();
    this.db
      .update(conversations)
      .set({ revision, updatedAt: this.now() })
      .where(eq(conversations.id, conv.id))
      .run();
    this.invalidateSessions(conv.id);
    return revision;
  }

  /** "수정 후 다시 보내기": replaces an active user message; later messages are cut off (kept as versions). */
  edit(conversationId: string, messageId: string, text: string): MessageRow | undefined {
    return this.db.$client.transaction(() => {
      const conv = this.get(conversationId);
      const target = this.message(conversationId, messageId);
      if (!conv || !target || !target.active || target.role !== "user") return undefined;
      this.truncateFrom(conv, target);
      return this.append(conversationId, {
        role: "user",
        parts: [{ type: "text", text }],
        replaces: target.id,
      });
    })();
  }

  /**
   * "다시 생성": replaces an active assistant message with a pending one that the runtime pipeline (#12) fills.
   */
  regenerate(conversationId: string, messageId: string): MessageRow | undefined {
    return this.db.$client.transaction(() => {
      const conv = this.get(conversationId);
      const target = this.message(conversationId, messageId);
      if (!conv || !target || !target.active || target.role !== "assistant") return undefined;
      this.truncateFrom(conv, target);
      return this.append(conversationId, {
        role: "assistant",
        parts: [],
        status: "pending",
        runtime: target.runtime,
        model: target.model,
        effort: target.effort,
        connectionId: target.connectionId,
        replaces: target.id,
      });
    })();
  }

  // ---- runtime sessions (used by #12 / #45) ----

  /**
   * Records a runtime session and what it has seen: `conversationRevision` is the revision the runtime actually
   * reflects, `lastMessageId` the last message it saw (an active message of this conversation, or null).
   * A session that saw an older revision is refused — it must never look current to #45.
   */
  saveSession(s: {
    conversationId: string;
    runtime: string;
    connectionId?: string | null;
    externalSessionId: string;
    lastMessageId: string | null;
    conversationRevision: number;
    /** Fingerprint of the instructions the session started with (#20). */
    instructionsHash?: string | null;
  }): SessionRow {
    const conv = this.get(s.conversationId);
    if (!conv) throw new Error("conversation not found");
    if (s.conversationRevision !== conv.revision) throw new Error("session reflects an older revision");
    this.assertCheckpoint(s.conversationId, s.lastMessageId);
    const t = this.now();
    const row: SessionRow = {
      id: crypto.randomUUID(),
      conversationId: s.conversationId,
      runtime: s.runtime,
      connectionId: s.connectionId ?? null,
      externalSessionId: s.externalSessionId,
      lastMessageId: s.lastMessageId,
      conversationRevision: s.conversationRevision,
      instructionsHash: s.instructionsHash ?? null,
      invalidated: false,
      createdAt: t,
      updatedAt: t,
    };
    this.db.insert(runtimeSessions).values(row).run();
    return row;
  }

  /** Valid sessions only (not invalidated by a rewrite). */
  sessions(conversationId: string): SessionRow[] {
    return this.db
      .select()
      .from(runtimeSessions)
      .where(and(eq(runtimeSessions.conversationId, conversationId), eq(runtimeSessions.invalidated, false)))
      .orderBy(asc(runtimeSessions.createdAt))
      .all();
  }

  private assertCheckpoint(conversationId: string, messageId: string | null): void {
    if (messageId === null) return;
    const m = this.message(conversationId, messageId);
    if (!m || !m.active) throw new Error("checkpoint must be an active message of this conversation");
  }

  /**
   * Moves a session's checkpoint after a completed turn. Same rules as `saveSession`: the revision the runtime
   * reflects must be current and the message an active one of this conversation — otherwise the session is
   * invalidated instead of being made to look current.
   */
  touchSession(id: string, lastMessageId: string, conversationRevision: number): void {
    const s = this.db.select().from(runtimeSessions).where(eq(runtimeSessions.id, id)).get();
    if (!s) return;
    const conv = this.get(s.conversationId);
    try {
      if (!conv || conversationRevision !== conv.revision) throw new Error("stale");
      this.assertCheckpoint(s.conversationId, lastMessageId);
    } catch {
      this.invalidateSession(id);
      return;
    }
    this.db
      .update(runtimeSessions)
      .set({ lastMessageId, conversationRevision, updatedAt: this.now() })
      .where(eq(runtimeSessions.id, id))
      .run();
  }

  invalidateSession(id: string): void {
    this.db
      .update(runtimeSessions)
      .set({ invalidated: true, updatedAt: this.now() })
      .where(eq(runtimeSessions.id, id))
      .run();
  }

  invalidateSessions(conversationId: string): void {
    this.db
      .update(runtimeSessions)
      .set({ invalidated: true, updatedAt: this.now() })
      .where(eq(runtimeSessions.conversationId, conversationId))
      .run();
  }
}
