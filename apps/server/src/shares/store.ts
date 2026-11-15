import crypto from "node:crypto";
import type { ShareAudience, ShareItemKind, ShareMode } from "@agentlee/shared";
import type { Db } from "../db/client.js";
import type { shares } from "../db/schema.js";

export type ShareRow = typeof shares.$inferSelect;
export type SnapshotItemType = "message" | "file" | "artifact_version" | "citation" | "source";
export type SnapshotItem = {
  itemType: SnapshotItemType;
  itemId: string;
  revision: number;
  digest: string | null;
};

/** Why a share was refused (400/409 with this code). */
export class ShareError extends Error {
  constructor(
    readonly code:
      "invalid_share_target" | "share_boundary_not_found" | "share_run_in_progress" | "share_revoked",
  ) {
    super(code);
  }
}

type SqlRow = Record<string, unknown>;

/**
 * Share rows (#29): what is shared with whom, and the frozen list of a snapshot. Who may see what is not decided
 * here — that is the projection's job (`projection.ts`), the one place that reads these rows for access.
 */
export class ShareStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  private get sql() {
    return this.db.$client;
  }

  /** Runs `fn` in one immediate transaction (a snapshot's list and its rows: nothing can come in between). */
  atomically<T>(fn: () => T): T {
    return this.sql.transaction(fn).immediate();
  }

  get(id: string): ShareRow | undefined {
    const r = this.sql.prepare("select * from shares where id = ?").get(id) as SqlRow | undefined;
    return r && toRow(r);
  }

  /** The shares of one item, newest first (revoked ones included: the owner sees what they were). */
  ofItem(kind: ShareItemKind, itemId: string): ShareRow[] {
    return (
      this.sql
        .prepare(
          "select * from shares where item_kind = ? and item_id = ? order by created_at desc, rowid desc",
        )
        .all(kind, itemId) as SqlRow[]
    ).map(toRow);
  }

  /** Every share that is on, of the conversation and of artifacts in it. */
  activeInConversation(conversationId: string): ShareRow[] {
    return (
      this.sql
        .prepare("select * from shares where conversation_id = ? and revoked_at is null order by created_at")
        .all(conversationId) as SqlRow[]
    ).map(toRow);
  }

  /** Every share that is on and owned by `userId` (an owner's deactivation re-checks their streams). */
  activeOwnedBy(userId: string): ShareRow[] {
    return (
      this.sql
        .prepare("select * from shares where owner_id = ? and revoked_at is null")
        .all(userId) as SqlRow[]
    ).map(toRow);
  }

  /** Every share that is on and may reach `userId` (as a chosen account, or the whole family). */
  activeReaching(userId: string): ShareRow[] {
    return (
      this.sql
        .prepare(
          `select s.* from shares s where s.revoked_at is null and s.owner_id <> ? and (s.audience = 'family'
             or exists (select 1 from share_targets t where t.share_id = s.id and t.user_id = ?))
           order by s.created_at desc, s.rowid desc`,
        )
        .all(userId, userId) as SqlRow[]
    ).map(toRow);
  }

  /** The chosen accounts of a `users` share (active or not — the projection checks). */
  chosen(shareId: string): string[] {
    return (
      this.sql.prepare("select user_id as u from share_targets where share_id = ?").all(shareId) as {
        u: string;
      }[]
    ).map((r) => r.u);
  }

  snapshot(shareId: string): SnapshotItem[] {
    return (
      this.sql
        .prepare(
          "select item_type as itemType, item_id as itemId, revision, digest from share_snapshots where share_id = ?",
        )
        .all(shareId) as SnapshotItem[]
    ).map((r) => ({ ...r, digest: r.digest ?? null }));
  }

  /** Creates the share, its chosen accounts and (snapshot) its frozen list — all or nothing. */
  create(input: {
    ownerId: string;
    itemKind: ShareItemKind;
    itemId: string;
    conversationId: string;
    target: ShareAudience;
    mode: ShareMode;
    boundaryMessageId: string | null;
    snapshot: SnapshotItem[];
  }): ShareRow {
    const t = this.now();
    const row: ShareRow = {
      id: crypto.randomUUID(),
      ownerId: input.ownerId,
      itemKind: input.itemKind,
      itemId: input.itemId,
      conversationId: input.conversationId,
      audience: input.target.audience,
      mode: input.mode,
      boundaryMessageId: input.boundaryMessageId,
      createdAt: t,
      updatedAt: t,
      revokedAt: null,
    };
    this.sql.transaction(() => {
      this.sql
        .prepare(
          `insert into shares (id, owner_id, item_kind, item_id, conversation_id, audience, mode,
             boundary_message_id, created_at, updated_at, revoked_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null)`,
        )
        .run(
          row.id,
          row.ownerId,
          row.itemKind,
          row.itemId,
          row.conversationId,
          row.audience,
          row.mode,
          row.boundaryMessageId,
          t,
          t,
        );
      this.writeTargets(row.id, input.target);
      const add = this.sql.prepare(
        "insert or ignore into share_snapshots (share_id, item_type, item_id, revision, digest) values (?, ?, ?, ?, ?)",
      );
      for (const s of input.snapshot) add.run(row.id, s.itemType, s.itemId, s.revision, s.digest);
    })();
    return row;
  }

  /** Changes who the share is for. The frozen list stays as it was. */
  setTarget(id: string, target: ShareAudience): ShareRow {
    this.sql.transaction(() => {
      const s = this.get(id);
      if (!s || s.revokedAt !== null) throw new ShareError("share_revoked");
      this.sql.prepare("delete from share_targets where share_id = ?").run(id);
      this.sql
        .prepare("update shares set audience = ?, updated_at = ? where id = ?")
        .run(target.audience, this.now(), id);
      this.writeTargets(id, target);
    })();
    return this.get(id)!;
  }

  /** Turns the share off (idempotent). Its rows stay, so the owner still sees what it was. */
  revoke(id: string): ShareRow {
    const t = this.now();
    this.sql
      .prepare("update shares set revoked_at = ?, updated_at = ? where id = ? and revoked_at is null")
      .run(t, t, id);
    return this.get(id)!;
  }

  // ---- read receipts (#52, FR-14.6) ----

  /** `userId` opened the share (as a viewer, through the projection): the first time is kept, the last moves on. */
  markViewed(shareId: string, userId: string): void {
    const t = this.now();
    this.sql
      .prepare(
        `insert into share_views (share_id, user_id, first_viewed_at, last_viewed_at) values (?, ?, ?, ?)
           on conflict (share_id, user_id) do update set last_viewed_at = excluded.last_viewed_at`,
      )
      .run(shareId, userId, t, t);
  }

  /** Who opened the share, and when first and last. */
  views(shareId: string): { userId: string; firstViewedAt: number; lastViewedAt: number }[] {
    return this.sql
      .prepare(
        `select user_id as userId, first_viewed_at as firstViewedAt, last_viewed_at as lastViewedAt
           from share_views where share_id = ? order by first_viewed_at`,
      )
      .all(shareId) as { userId: string; firstViewedAt: number; lastViewedAt: number }[];
  }

  /** When `userId` first opened the share, or null. */
  viewedAt(shareId: string, userId: string): number | null {
    const r = this.sql
      .prepare("select first_viewed_at as t from share_views where share_id = ? and user_id = ?")
      .get(shareId, userId) as { t: number } | undefined;
    return r?.t ?? null;
  }

  // ---- result notifications of a shared schedule conversation (#52, FR-8.8) ----

  notifyResults(shareId: string, userId: string): boolean {
    const r = this.sql
      .prepare("select notify_results as n from share_subscriptions where share_id = ? and user_id = ?")
      .get(shareId, userId) as { n: number } | undefined;
    return r?.n === 1;
  }

  setNotifyResults(shareId: string, userId: string, on: boolean): void {
    this.sql
      .prepare(
        `insert into share_subscriptions (share_id, user_id, notify_results, updated_at) values (?, ?, ?, ?)
           on conflict (share_id, user_id) do update set notify_results = excluded.notify_results,
             updated_at = excluded.updated_at`,
      )
      .run(shareId, userId, on ? 1 : 0, this.now());
  }

  /** The accounts that chose to be notified of the share's new results (the projection still decides who gets one). */
  resultSubscribers(shareId: string): string[] {
    return (
      this.sql
        .prepare("select user_id as u from share_subscriptions where share_id = ? and notify_results = 1")
        .all(shareId) as { u: string }[]
    ).map((r) => r.u);
  }

  private writeTargets(shareId: string, target: ShareAudience): void {
    if (target.audience !== "users") return;
    const add = this.sql.prepare("insert or ignore into share_targets (share_id, user_id) values (?, ?)");
    for (const u of target.userIds) add.run(shareId, u);
  }
}

function toRow(r: SqlRow): ShareRow {
  return {
    id: r.id as string,
    ownerId: r.owner_id as string,
    itemKind: r.item_kind as ShareRow["itemKind"],
    itemId: r.item_id as string,
    conversationId: r.conversation_id as string,
    audience: r.audience as ShareRow["audience"],
    mode: r.mode as ShareRow["mode"],
    boundaryMessageId: (r.boundary_message_id as string | null) ?? null,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    revokedAt: (r.revoked_at as number | null) ?? null,
  };
}
