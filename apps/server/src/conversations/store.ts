import crypto from "node:crypto";
import { and, asc, desc, eq, gte, lt, or, sql } from "drizzle-orm";
import {
  autoTitle,
  MessagePart,
  publicParts,
  type ChatSettings,
  type FallbackNotice,
  type Conversation,
  type Message,
  type RuntimeId,
} from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { conversations, messages, runtimeSessions } from "../db/schema.js";
import { scrubKnown, scrubParts } from "../secrets/known.js";
import { SUMMARY_SWITCH_NOTE } from "../runtime/context.js";

export type ConversationRow = typeof conversations.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type SessionRow = typeof runtimeSessions.$inferSelect;

export const DEFAULT_TITLE = "새 대화";

/** Called inside the delete transaction, before rows go — files, artifacts and shares hook in here (#54). */
export type DeleteHook = (conversationId: string) => void;
/**
 * Called right after the delete transaction committed, with the row that went — files on disk go here (#22). The
 * caller of `delete` holds the file-write lock (`app.fileWrites`), so a backup never sees half of it.
 */
export type DeletedHook = (conversation: ConversationRow) => void;

/** The conversation's settings for its next message (#19), or null while none was usable yet. */
export function settingsOf(c: ConversationRow): ChatSettings | null {
  if (c.runtime !== "claude-code" && c.runtime !== "codex") return null;
  if (!c.model) return null;
  return { runtime: c.runtime, model: c.model, effort: c.effort ?? null, useShared: c.useShared };
}

const noticeFor = (s: ChatSettings, limitedUntil: number | undefined) => ({
  runtime: s.runtime,
  model: s.model,
  ...(limitedUntil !== undefined ? { limitedUntil } : {}),
});
/** A stored fallback notice, checked (null when it is not one). */
function noticeOf(v: unknown): FallbackNotice | null {
  const n = v as { runtime?: unknown; model?: unknown; limitedUntil?: unknown } | null;
  if (!n || (n.runtime !== "claude-code" && n.runtime !== "codex") || typeof n.model !== "string")
    return null;
  return {
    runtime: n.runtime,
    model: n.model,
    ...(typeof n.limitedUntil === "number" ? { limitedUntil: n.limitedUntil } : {}),
  };
}

/** What a reply was answered with — the divider rule compares these (#19). */
export type AnsweredWith = {
  runtime: string;
  model: string;
  effort: string | null;
  label: string;
  /** A switch to another runtime that hands over a summary (#45): its divider says so (FR-3.5). */
  summarized?: boolean;
};

/** `owned`: whether the caller owns it — every route but the shared read (`GET …/:id`) is the owner's own. */
export function toConversation(c: ConversationRow, owned = true): Conversation {
  return {
    owned,
    id: c.id,
    // Known secrets never leave in an API response (review round 23) — also ones registered after this was stored.
    title: scrubKnown(c.title),
    pinned: c.pinned,
    kind: c.kind,
    lastRuntime: (c.lastRuntime as RuntimeId | null) ?? null,
    forkedFrom: c.forkedFrom ?? null,
    revision: c.revision,
    researchMode: c.researchMode,
    settings: settingsOf(c),
    fallbackNotice: noticeOf(c.fallbackNotice),
    newResult: c.newResultAt !== null && c.newResultAt !== undefined,
    newResultMessageId:
      c.newResultAt !== null && c.newResultAt !== undefined ? (c.newResultMessageId ?? null) : null,
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
    // Text parts scrubbed as one text: a secret split around a tool call is found too (round 26).
    parts: scrubParts(publicParts(MessagePart.array().parse(m.parts))),
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
  private readonly deletedHooks: DeletedHook[] = [];

  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  onDelete(hook: DeleteHook): void {
    this.deleteHooks.push(hook);
  }

  onDeleted(hook: DeletedHook): void {
    this.deletedHooks.push(hook);
  }

  get(id: string): ConversationRow | undefined {
    return this.db.select().from(conversations).where(eq(conversations.id, id)).get();
  }

  create(
    ownerId: string,
    opts: {
      title?: string | undefined;
      kind?: ConversationRow["kind"];
      forkedFrom?: string;
      /** Start settings (#19): the user's defaults after the FR-12.6 fallback, or the chip's choice. */
      settings?: ChatSettings | null | undefined;
      /** The start used the fallback: show the notice once. */
      fallback?: boolean | undefined;
      /** The default was at a usage limit until then (the notice says so). */
      limitedUntil?: number | undefined;
    } = {},
  ): ConversationRow {
    const t = this.now();
    const row = {
      id: crypto.randomUUID(),
      ownerId,
      title: opts.title === undefined ? DEFAULT_TITLE : scrubKnown(opts.title),
      titleSource: opts.title ? ("user" as const) : ("auto" as const),
      pinned: false,
      kind: opts.kind ?? ("normal" as const),
      forkedFrom: opts.forkedFrom ?? null,
      lastRuntime: null,
      revision: 0,
      researchMode: false,
      runtime: opts.settings?.runtime ?? null,
      model: opts.settings?.model ?? null,
      effort: opts.settings?.effort ?? null,
      useShared: opts.settings?.useShared ?? false,
      fallbackNotice: opts.settings && opts.fallback ? noticeFor(opts.settings, opts.limitedUntil) : null,
      nextSeq: 1,
      newResultAt: null,
      newResultMessageId: null,
      createdAt: t,
      updatedAt: t,
    };
    this.db.insert(conversations).values(row).run();
    return row;
  }

  /**
   * The chip's change (#19), or the first resolution of a conversation that had none: from the next message on.
   * Not activity (the "recent" order stays). A change by the chip ends a pending fallback notice — it was about how
   * the conversation started, and the chip now shows the user's own choice.
   */
  setSettings(id: string, s: ChatSettings, opts: { fallback?: boolean; limitedUntil?: number } = {}): void {
    this.db
      .update(conversations)
      .set({
        runtime: s.runtime,
        model: s.model,
        effort: s.effort,
        useShared: s.useShared,
        fallbackNotice: opts.fallback ? noticeFor(s, opts.limitedUntil) : null,
      })
      .where(eq(conversations.id, id))
      .run();
  }

  /**
   * Takes the fallback notice (#19): one statement clears it and returns what it was, so of any number of callers —
   * tabs, reloads, concurrent requests — exactly one gets it. Null for everyone else.
   */
  consumeFallbackNotice(id: string): FallbackNotice | null {
    // RETURNING gives the new value (null), so: read and clear in one immediate transaction; the clear only counts
    // when it still found the notice (changes = 1).
    const n = this.db.$client
      .transaction(() => {
        const row = this.db.$client
          .prepare(
            "select fallback_notice as n from conversations where id = ? and fallback_notice is not null",
          )
          .get(id) as { n: string } | undefined;
        if (!row) return undefined;
        const r = this.db.$client
          .prepare(
            "update conversations set fallback_notice = null where id = ? and fallback_notice is not null",
          )
          .run(id);
        return r.changes === 1 ? row.n : undefined;
      })
      .immediate();
    if (!n) return null;
    try {
      return noticeOf(JSON.parse(n));
    } catch {
      return null;
    }
  }

  /**
   * `── 여기부터 Codex · ○○ ──` (FR-3.5, #19): makes the history right before the reply about to be written say who
   * answers it. Written when the change takes effect — the next message — so a change undone before sending leaves no
   * divider, and the first reply of a conversation gets none.
   *
   * The dividers after the last active reply belong to the turn being written: after an edit or a regeneration cut
   * the history they may be left over from the replaced turn (review #101 P2). Exactly one survives when it already
   * names who answers now; the others leave the history (kept, like every cut message, with the revision); a new one
   * is appended only when none fits.
   */
  syncSwitchDivider(conversationId: string, next: AnsweredWith): MessageRow | undefined {
    const active = this.db
      .select()
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.active, true)))
      .orderBy(asc(messages.seq))
      .all();
    const prev = active.findLast((m) => m.role === "assistant" && m.runtime !== null && m.model !== null);
    const pending = active.filter(
      (m) =>
        m.role === "system" &&
        (!prev || m.seq > prev.seq) &&
        (m.parts as MessagePart[]).some((p) => p.type === "divider" && p.kind === "runtime_switch"),
    );
    let label: string | null = null;
    if (prev) {
      const sameModel = prev.runtime === next.runtime && prev.model === next.model;
      if (!sameModel || (prev.effort ?? null) !== next.effort)
        // Only the effort changed: say so, or the divider would name what answered before too.
        label = `여기부터 ${sameModel && next.effort ? `${next.label} · 추론 ${next.effort}` : next.label}`;
      // Another runtime starts from the summary and the recent messages (#45, FR-3.5).
      if (label !== null && prev.runtime !== next.runtime && next.summarized)
        label = `${label} · ${SUMMARY_SWITCH_NOTE}`;
    }
    const keep =
      label === null
        ? undefined
        : pending.find((m) => {
            const d = (m.parts as MessagePart[])[0];
            return (
              d?.type === "divider" &&
              d.label === label &&
              d.runtime === next.runtime &&
              d.model === next.model
            );
          });
    const stale = pending.filter((m) => m !== keep);
    if (stale.length) {
      const revision = this.get(conversationId)!.revision;
      for (const m of stale)
        this.db
          .update(messages)
          .set({ active: false, archivedAtRevision: revision })
          .where(eq(messages.id, m.id))
          .run();
    }
    if (label === null || keep) return keep;
    return this.append(conversationId, {
      role: "system",
      parts: [
        {
          type: "divider",
          kind: "runtime_switch",
          label,
          runtime: next.runtime as RuntimeId,
          model: next.model,
        },
      ],
    });
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
      .set({ title: scrubKnown(title), titleSource: "user", updatedAt: this.now() })
      .where(eq(conversations.id, id))
      .run();
  }

  /** 자료 조사 모드 (FR-5.5). Not activity either; the next run picks it up (new instructions → fresh session). */
  setResearchMode(id: string, researchMode: boolean): void {
    this.db.update(conversations).set({ researchMode }).where(eq(conversations.id, id)).run();
  }

  /**
   * A schedule run left a result here (#56, FR-8.3): the sidebar's "새 결과" until the owner opens the conversation.
   * It is activity: the conversation moves up the "recent" list.
   */
  markNewResult(id: string, messageId: string | null): void {
    const t = this.now();
    this.db
      .update(conversations)
      .set({ newResultAt: t, newResultMessageId: messageId, updatedAt: t })
      .where(eq(conversations.id, id))
      .run();
  }

  /**
   * The owner has seen the result (#56). Not activity. With `messageId`: only when that is still the result marked
   * (a newer one stays). True when one was cleared.
   */
  clearNewResult(id: string, messageId?: string): boolean {
    return (
      this.db
        .update(conversations)
        .set({ newResultAt: null, newResultMessageId: null })
        .where(
          and(
            eq(conversations.id, id),
            sql`${conversations.newResultAt} is not null`,
            messageId === undefined
              ? undefined
              : sql`coalesce(${conversations.newResultMessageId}, '') = ${messageId}`,
          ),
        )
        .run().changes > 0
    );
  }

  setPinned(id: string, pinned: boolean): void {
    // Pinning is not activity: updatedAt (the "recent" order) stays.
    this.db.update(conversations).set({ pinned }).where(eq(conversations.id, id)).run();
  }

  /**
   * Deletes the conversation, its messages and runtime sessions; extension hooks run first, in one transaction, and
   * `onDeleted` hooks after it committed. Callers hold `app.fileWrites` (the conversation may have files).
   */
  delete(id: string): void {
    const row = this.db.$client.transaction(() => {
      const row = this.get(id);
      for (const hook of this.deleteHooks) hook(id);
      this.db.delete(conversations).where(eq(conversations.id, id)).run();
      return row;
    })();
    if (row) for (const hook of this.deletedHooks) hook(row);
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
      // Known secrets are never stored (review round 23): not in a message, not in the title made from it.
      const parts = scrubParts(MessagePart.array().parse(m.parts));
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
      connectionId?: string | null;
    },
  ): void {
    const parts = patch.parts ? scrubParts(MessagePart.array().parse(patch.parts)) : undefined;
    this.db
      .update(messages)
      .set({
        ...(parts ? { parts, searchText: searchTextOf(parts) } : {}),
        ...(patch.status ? { status: patch.status } : {}),
        ...(patch.runtime ? { runtime: patch.runtime } : {}),
        ...(patch.model ? { model: patch.model } : {}),
        ...(patch.effort !== undefined ? { effort: patch.effort } : {}),
        ...(patch.connectionId !== undefined ? { connectionId: patch.connectionId } : {}),
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
    // A schedule's result that leaves the history now (regenerated, or an earlier message edited — the owner is at
    // it, so it has been seen): its "새 결과" goes with it. Only that result's: a newer one stays (review #116).
    this.db
      .update(conversations)
      .set({ newResultAt: null, newResultMessageId: null })
      .where(
        and(
          eq(conversations.id, conv.id),
          sql`${conversations.newResultMessageId} in (select ${messages.id} from ${messages}
            where ${messages.conversationId} = ${conv.id} and ${messages.active} = 1 and ${messages.seq} >= ${target.seq})`,
        ),
      )
      .run();
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
  edit(
    conversationId: string,
    messageId: string,
    text: string,
    /** Runs after the cut, before the new message (the switch divider, #19). */
    afterCut?: () => void,
  ): MessageRow | undefined {
    return this.db.$client.transaction(() => {
      const conv = this.get(conversationId);
      const target = this.message(conversationId, messageId);
      if (!conv || !target || !target.active || target.role !== "user") return undefined;
      this.truncateFrom(conv, target);
      afterCut?.();
      // The edit changes the text only: files sent with the message stay with it (#22 review 2). The files' own
      // link moves in the same transaction (`FileStore.moveToMessage`, called by the route).
      const files = MessagePart.array()
        .parse(target.parts)
        .filter((p) => p.type === "file_ref");
      return this.append(conversationId, {
        role: "user",
        parts: [{ type: "text", text }, ...files],
        replaces: target.id,
      });
    })();
  }

  /**
   * "다시 생성": replaces an active assistant message with a pending one that the runtime pipeline (#12) fills.
   */
  regenerate(conversationId: string, messageId: string, afterCut?: () => void): MessageRow | undefined {
    return this.db.$client.transaction(() => {
      const conv = this.get(conversationId);
      const target = this.message(conversationId, messageId);
      if (!conv || !target || !target.active || target.role !== "assistant") return undefined;
      this.truncateFrom(conv, target);
      afterCut?.();
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
    /** The model it answers with (#45). */
    model?: string | null;
    /** The summary its context started from (#45). */
    summaryId?: string | null;
    /** Its context was cut to fit (#45): never resumed. */
    trimmed?: boolean;
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
      model: s.model ?? null,
      summaryId: s.summaryId ?? null,
      trimmed: s.trimmed ?? false,
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

  /** The session now answers with `model` (#45: a model-only change through `setModel`). */
  setSessionModel(id: string, model: string): void {
    this.db
      .update(runtimeSessions)
      .set({ model, updatedAt: this.now() })
      .where(eq(runtimeSessions.id, id))
      .run();
  }

  /**
   * Takes a message the server wrote out of the history (kept, like every cut message, with the revision) — the
   * summary divider of a summary that could not be written (#45).
   */
  deactivate(conversationId: string, messageId: string): void {
    const conv = this.get(conversationId);
    if (!conv) return;
    this.db
      .update(messages)
      .set({ active: false, archivedAtRevision: conv.revision })
      .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)))
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
