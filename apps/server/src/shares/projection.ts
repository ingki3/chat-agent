import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  MessagePart,
  type Artifact,
  type IncomingShare,
  type Message,
  type SharedView,
  type StreamEvent,
} from "@agentlee/shared";
import type { UserStore } from "../auth/users.js";
import type { Db } from "../db/client.js";
import { toMessage, type ConversationStore, type MessageRow } from "../conversations/store.js";
import { toArtifact, type ArtifactRow, type ArtifactStore } from "../artifacts/store.js";
import { toUploadedFile, type FileRow, type FileStore } from "../files/store.js";
import { toSource, type SourceStore } from "../web/sources.js";
import { scrubKnown } from "../secrets/known.js";
import type { ShareRow, ShareStore, SnapshotItem } from "./store.js";

/**
 * What one share lets one viewer see (#29). Everything a shared viewer is served — conversation, messages, files,
 * artifact versions, sources, run events, search hits, and later forks (#52), exports and references (#26) — is
 * cut to this, and nothing else decides it.
 */
export type Projection = {
  /** The conversation the shared item belongs to. */
  conversationId: string;
  /** The shares it was made from (one, or several of the same conversation for the same viewer). */
  shareIds: string[];
  /** Messages by id. Live: the active history now; snapshot: the frozen list (now edited away or not). */
  messages: Set<string>;
  files: Set<string>;
  /** Artifact id → its visible versions. */
  versions: Map<string, Set<number>>;
  citations: Set<string>;
  sources: Set<string>;
};

const empty = (conversationId: string, shareIds: string[]): Projection => ({
  conversationId,
  shareIds,
  messages: new Set(),
  files: new Set(),
  versions: new Map(),
  citations: new Set(),
  sources: new Set(),
});

/** The union of several projections of the same conversation (a viewer may be reached by more than one share). */
export function unionOf(ps: Projection[]): Projection | null {
  if (!ps.length) return null;
  const out = empty(ps[0]!.conversationId, []);
  for (const p of ps) {
    out.shareIds.push(...p.shareIds);
    for (const k of ["messages", "files", "citations", "sources"] as const)
      for (const v of p[k]) out[k].add(v);
    for (const [a, vs] of p.versions) {
      const set = out.versions.get(a) ?? new Set<number>();
      for (const v of vs) set.add(v);
      out.versions.set(a, set);
    }
  }
  return out;
}

const sha = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const json = (xs: Iterable<string>) => JSON.stringify([...xs]);

/**
 * A message part as a shared viewer gets it: reasoning never (as for every API answer, `toMessage`), and a tool's
 * raw result neither — the part stays (so part indexes match the owner's and the live stream's), its output is
 * gone. What tool was called, with what input, stays visible (FR-3.4).
 */
export function projectPart(p: MessagePart): MessagePart | null {
  if (p.type === "reasoning") return null;
  if (p.type === "tool_result") return { type: "tool_result", callId: p.callId, output: null };
  return p;
}

/** A stream event as a shared viewer gets it: no raw tool output, never a reasoning part. Null: not sent. */
export function projectEvent(e: StreamEvent): StreamEvent | null {
  if (e.type === "tool_end") return { type: "tool_end", messageId: e.messageId, callId: e.callId };
  if (e.type === "part_update") {
    const part = projectPart(e.part);
    return part ? ({ ...e, part } as StreamEvent) : null;
  }
  return e;
}

/**
 * The share policy (#29, PRD FR-14, decision #3). `project(share, viewer)` is THE projection function: every read a
 * shared viewer makes goes through it (directly, or through `conversationView` / `artifactView` / `viewers`, which
 * only combine its results). See docs/decisions/sharing.md for the list of paths and the rule for new ones.
 */
export class SharePolicy {
  constructor(
    private readonly db: Db,
    readonly store: ShareStore,
    private readonly users: UserStore,
    private readonly conversations: ConversationStore,
    private readonly artifacts: ArtifactStore,
    private readonly files: FileStore,
    private readonly sources: SourceStore,
  ) {}

  private get sql() {
    return this.db.$client;
  }

  // ---- who ----

  /** The family accounts the share reaches right now: active, not the owner, and chosen (or the whole family). */
  targets(share: ShareRow): string[] {
    if (share.revokedAt !== null) return [];
    // A deactivated owner's shares reach no one (they are inactive, not revoked: reactivating restores them).
    if (!this.users.byId(share.ownerId)?.active) return [];
    const chosen = share.audience === "users" ? new Set(this.store.chosen(share.id)) : undefined;
    return this.users
      .list()
      .filter((u) => u.active && u.id !== share.ownerId && (!chosen || chosen.has(u.id)))
      .map((u) => u.id);
  }

  // ---- what ----

  /**
   * THE projection: what `viewerId` may see through `share` — null when the share is off, or does not reach them.
   * Live: computed now from the conversation (new messages included). Snapshot: the list frozen when it was made.
   */
  project(share: ShareRow, viewerId: string, memo?: Map<string, Projection>): Projection | null {
    if (share.revokedAt !== null) return null;
    if (!this.targets(share).includes(viewerId)) return null;
    const known = memo?.get(share.id);
    if (known) return known;
    const p = this.contents(share);
    memo?.set(share.id, p);
    return p;
  }

  /** The share's contents, whoever looks (the owner's preview; viewers get it through `project`). */
  contents(share: ShareRow): Projection {
    if (share.mode === "snapshot") return this.fromSnapshot(share, this.store.snapshot(share.id));
    if (share.itemKind === "artifact")
      return this.fromSnapshot(share, this.artifactSnapshot(share.itemId, share.conversationId));
    return this.fromSnapshot(share, this.compute(share.conversationId, { live: true }));
  }

  private fromSnapshot(share: ShareRow, items: SnapshotItem[]): Projection {
    const p = empty(share.conversationId, [share.id]);
    for (const i of items) {
      if (i.itemType === "message") p.messages.add(i.itemId);
      else if (i.itemType === "file") p.files.add(i.itemId);
      else if (i.itemType === "citation") p.citations.add(i.itemId);
      else if (i.itemType === "source") p.sources.add(i.itemId);
      else {
        const set = p.versions.get(i.itemId) ?? new Set<number>();
        set.add(i.revision);
        p.versions.set(i.itemId, set);
      }
    }
    return p;
  }

  /**
   * The list rule (#3): the messages of the history (up to and including the boundary message), and only what those
   * messages brought — the files sent with or made by them, the artifact versions their runs wrote, the citations of
   * their runs and the sources those cite. Material of later messages is left out even if it existed already.
   * Live adds the reverted copies of visible artifacts (made by the owner, not a message).
   */
  compute(
    conversationId: string,
    opts: { live: true } | { live: false; boundarySeq: number },
  ): SnapshotItem[] {
    const msgs = this.sql
      .prepare(
        `select id, revision from messages where conversation_id = ? and active = 1 ${opts.live ? "" : "and seq <= ?"}
         order by seq`,
      )
      .all(...(opts.live ? [conversationId] : [conversationId, opts.boundarySeq])) as {
      id: string;
      revision: number;
    }[];
    const ids = json(msgs.map((m) => m.id));
    const runIds = new Set(
      (
        this.sql
          .prepare(
            `select id from runs where conversation_id = ? and assistant_message_id in (select value from json_each(?))`,
          )
          .all(conversationId, ids) as { id: string }[]
      ).map((r) => r.id),
    );
    const sent = this.sql
      .prepare(
        `select id, sha256 from files where conversation_id = ? and message_id in (select value from json_each(?))`,
      )
      .all(conversationId, ids) as { id: string; sha256: string }[];
    const versions = this.sql
      .prepare(
        `select v.artifact_id as a, v.version as v, v.run_id as r from artifact_versions v
           join artifacts x on x.id = v.artifact_id where x.conversation_id = ? order by v.artifact_id, v.version`,
      )
      .all(conversationId) as { a: string; v: number; r: string | null }[];
    const linked = versions.filter((v) => v.r !== null && runIds.has(v.r));
    const visible = new Set(linked.map((v) => v.a));
    const kept = opts.live
      ? versions.filter((v) => runIds.has(v.r ?? "") || (v.r === null && visible.has(v.a)))
      : linked;
    // The files the kept `document` versions name (a restored version's file came with an answer now cut, review
    // #117) — of those versions only, never of every past version.
    const named = new Set(sent.map((f) => f.id));
    const files = [
      ...sent,
      ...this.documentFiles(
        conversationId,
        kept.map((v) => [v.a, v.v] as const),
      ).filter((f) => !named.has(f.id)),
    ];
    const cites = this.sql
      .prepare(
        `select c.id, c.source_id as s, c.quote, c.snippet, src.body_hash as h from citations c
           left join sources src on src.id = c.source_id and src.conversation_id = c.conversation_id
           where c.conversation_id = ? and c.run_id in (select value from json_each(?))`,
      )
      .all(conversationId, json(runIds)) as {
      id: string;
      s: string | null;
      quote: string | null;
      snippet: string;
      h: string | null;
    }[];
    const out: SnapshotItem[] = [
      ...msgs.map((m) => ({
        itemType: "message" as const,
        itemId: m.id,
        revision: m.revision,
        digest: null,
      })),
      ...files.map((f) => ({ itemType: "file" as const, itemId: f.id, revision: 0, digest: f.sha256 })),
      ...kept.map((v) => ({
        itemType: "artifact_version" as const,
        itemId: v.a,
        revision: v.v,
        digest: null,
      })),
      ...cites.map((c) => ({
        itemType: "citation" as const,
        itemId: c.id,
        revision: 0,
        digest: sha(c.quote ?? c.snippet),
      })),
    ];
    const seen = new Set<string>();
    for (const c of cites)
      if (c.s && !seen.has(c.s)) {
        seen.add(c.s);
        out.push({ itemType: "source", itemId: c.s, revision: 0, digest: c.h });
      }
    return out;
  }

  /** The frozen list of an artifact snapshot: the versions that exist now. */
  /**
   * An artifact share's list: its versions (all of them now — live computes this each time, a snapshot stores it),
   * and for a `document` artifact exactly the generated files those versions name (in the artifact's conversation),
   * so the document can be downloaded — no other file of the conversation.
   */
  artifactSnapshot(artifactId: string, conversationId: string): SnapshotItem[] {
    const versions = this.artifacts.versions(artifactId);
    const out: SnapshotItem[] = versions.map((v) => ({
      itemType: "artifact_version" as const,
      itemId: artifactId,
      revision: v.version,
      digest: null,
    }));
    for (const f of this.documentFiles(
      conversationId,
      versions.map((v) => [artifactId, v.version] as const),
    ))
      out.push({ itemType: "file", itemId: f.id, revision: 0, digest: f.sha256 });
    return out;
  }

  /**
   * The files of the conversation named by these artifact versions — `document` artifacts only (their content is a
   * `DocumentRef`); other kinds name none.
   */
  private documentFiles(
    conversationId: string,
    versions: readonly (readonly [string, number])[],
  ): { id: string; sha256: string }[] {
    if (!versions.length) return [];
    const contents = this.sql
      .prepare(
        `select v.content as c from artifact_versions v join artifacts x on x.id = v.artifact_id, json_each(?) k
           where x.kind = 'document' and x.conversation_id = ?
             and v.artifact_id = json_extract(k.value, '$[0]') and v.version = json_extract(k.value, '$[1]')`,
      )
      .all(JSON.stringify(versions), conversationId) as { c: string }[];
    const named = new Set<string>();
    for (const { c } of contents)
      try {
        const id = (JSON.parse(c) as { fileId?: unknown }).fileId;
        if (typeof id === "string") named.add(id);
      } catch {
        // not a document reference: names no file
      }
    if (!named.size) return [];
    return this.sql
      .prepare(
        "select id, sha256 from files where conversation_id = ? and id in (select value from json_each(?))",
      )
      .all(conversationId, json(named)) as { id: string; sha256: string }[];
  }

  // ---- combined views (each made of `project` results only) ----

  /** What `viewerId` sees of a conversation through its conversation shares, or null (not shared with them). */
  conversationView(conversationId: string, viewerId: string): Projection | null {
    const memo = new Map<string, Projection>();
    return unionOf(
      this.store
        .activeInConversation(conversationId)
        .filter((s) => s.itemKind === "conversation")
        .flatMap((s) => this.project(s, viewerId, memo) ?? []),
    );
  }

  /**
   * The files `viewerId` may open in a conversation: through its conversation shares, and the document files of
   * artifact shares in it.
   */
  fileView(conversationId: string, viewerId: string): Projection | null {
    const memo = new Map<string, Projection>();
    return unionOf(
      this.store.activeInConversation(conversationId).flatMap((s) => this.project(s, viewerId, memo) ?? []),
    );
  }

  /** What `viewerId` sees of an artifact: through shares of its conversation or of the artifact itself. */
  artifactView(artifact: Pick<ArtifactRow, "id" | "conversationId">, viewerId: string): Projection | null {
    const memo = new Map<string, Projection>();
    const p = unionOf(
      this.store
        .activeInConversation(artifact.conversationId)
        .filter((s) => s.itemKind === "conversation" || s.itemId === artifact.id)
        .flatMap((s) => this.project(s, viewerId, memo) ?? []),
    );
    return p && p.versions.get(artifact.id)?.size ? p : null;
  }

  /**
   * The accounts `test` holds for (the resource checks' `sharedWith`): every target of every share on in the
   * conversation whose projection passes. `conversationOnly`: artifact shares do not count (they never open the
   * conversation, its messages, files or runs).
   */
  viewers(conversationId: string, conversationOnly: boolean, test: (p: Projection) => boolean): string[] {
    const out = new Set<string>();
    const memo = new Map<string, Projection>();
    for (const s of this.store.activeInConversation(conversationId)) {
      if (conversationOnly && s.itemKind !== "conversation") continue;
      for (const v of this.targets(s)) {
        if (out.has(v)) continue;
        const p = this.project(s, v, memo);
        if (p && test(p)) out.add(v);
      }
    }
    return [...out];
  }

  // ---- shaping what a viewer is sent ----

  /** A message as a shared viewer gets it (`projectPart`); links to versions outside the projection are cut. */
  message(row: MessageRow, p: Projection): Message {
    const m = toMessage(row);
    const parts = MessagePart.array()
      .parse(m.parts)
      .flatMap((x) => projectPart(x) ?? []);
    return { ...m, parts, replaces: m.replaces && p.messages.has(m.replaces) ? m.replaces : null };
  }

  /** The projection's messages in history order, `before`/`limit` paged like the owner's history. */
  messagePage(p: Projection, opts: { before?: number | undefined; limit: number }) {
    const rows = this.messageRows(p).filter((m) => opts.before === undefined || m.seq < opts.before);
    const items = rows.slice(-opts.limit);
    return { items: items.map((m) => this.message(m, p)), hasMore: rows.length > items.length };
  }

  messageRows(p: Projection): MessageRow[] {
    const rows: MessageRow[] = [];
    for (const id of p.messages) {
      const m = this.conversations.message(p.conversationId, id);
      if (m) rows.push(m);
    }
    return rows.sort((a, b) => a.seq - b.seq);
  }

  file(f: FileRow, p: Projection) {
    const out = toUploadedFile(f);
    return {
      ...out,
      uploadId: null,
      messageId: out.messageId && p.messages.has(out.messageId) ? out.messageId : null,
    };
  }

  /** An artifact as a viewer gets it: its newest *visible* version stands for "latest". */
  artifact(a: ArtifactRow, p: Projection): (Artifact & { versions: number[] }) | null {
    const vs = [...(p.versions.get(a.id) ?? [])].sort((x, y) => x - y);
    const last = vs.at(-1);
    if (last === undefined) return null;
    const v = this.artifacts.version(a.id, last);
    return {
      ...toArtifact(a),
      messageId: a.messageId && p.messages.has(a.messageId) ? a.messageId : null,
      title: v?.title ?? a.title,
      language: v?.language ?? null,
      latestVersion: last,
      versions: vs,
    };
  }

  /**
   * Everything a share shows, as one bundle: the shared view's API answer and the one input for anything that
   * copies a shared item out (fork #52, conversation export, references #26) — none of those may read the stores.
   */
  bundle(share: ShareRow, p: Projection): Omit<SharedView, "share"> {
    if (share.itemKind === "artifact") {
      const a = this.artifacts.get(share.itemId);
      const view = a && this.artifact(a, p);
      // A document artifact's own file (its versions name it), nothing else of the conversation.
      const docs = this.files
        .list(p.conversationId)
        .filter((f) => p.files.has(f.id))
        .map((f) => this.file(f, p));
      return { conversation: null, messages: [], files: docs, artifacts: view ? [view] : [], sources: [] };
    }
    const c = this.conversations.get(p.conversationId);
    return {
      conversation: c ? { id: c.id, title: scrubKnown(c.title) } : null,
      messages: this.messageRows(p).map((m) => this.message(m, p)),
      files: this.files
        .list(p.conversationId)
        .filter((f) => p.files.has(f.id))
        .map((f) => this.file(f, p)),
      artifacts: this.artifacts.list(p.conversationId).flatMap((a) => this.artifact(a, p) ?? []),
      sources: this.sources
        .list(p.conversationId)
        .filter((s) => p.sources.has(s.id))
        .map(toSource),
    };
  }

  /** Who shared what, when (FR-14.6), for the person it is shared with. */
  incoming(share: ShareRow): IncomingShare {
    const owner = this.users.byId(share.ownerId);
    const artifact = share.itemKind === "artifact" ? this.artifacts.get(share.itemId) : undefined;
    const title =
      share.itemKind === "conversation"
        ? (this.conversations.get(share.itemId)?.title ?? "")
        : ((artifact && this.artifact(artifact, this.contents(share))?.title) ?? "");
    return {
      id: share.id,
      itemKind: share.itemKind,
      itemId: share.itemId,
      mode: share.mode,
      title: scrubKnown(title),
      ownerName: scrubKnown(owner?.name ?? ""),
      createdAt: share.createdAt,
    };
  }

  /** Search over what is shared with `viewerId` (FR-2.1 for the "가족 공유" list): titles and projected text only. */
  search(viewerId: string, q: string | undefined): ShareRow[] {
    const all = this.store.activeReaching(viewerId).filter((s) => this.project(s, viewerId) !== null);
    if (!q) return all;
    const needle = q.toLowerCase();
    return all.filter((s) => {
      const p = this.project(s, viewerId)!;
      if (this.incoming(s).title.toLowerCase().includes(needle)) return true;
      return this.messageRows(p).some((m) => m.searchText.toLowerCase().includes(needle));
    });
  }
}

declare module "fastify" {
  interface FastifyInstance {
    sharing: SharePolicy | undefined;
  }
}

/**
 * For a resource route: the caller's projection when they are a shared viewer (not the owner) — undefined for the
 * owner, null when the share went in the meantime (answer 403). `artifact`: the artifact the route serves.
 */
export function viewOf(
  app: FastifyInstance,
  req: FastifyRequest,
  scope:
    | { conversationId: string }
    | { artifact: Pick<ArtifactRow, "id" | "conversationId"> }
    /** One file of the conversation: conversation shares and artifact shares' document files. */
    | { fileIn: string },
): Projection | null | undefined {
  const user = req.ctx.user;
  if (!user || req.resource?.ownerId === user.id) return undefined;
  if (!app.sharing) return null;
  if ("fileIn" in scope) return app.sharing.fileView(scope.fileIn, user.id);
  return "artifact" in scope
    ? app.sharing.artifactView(scope.artifact, user.id)
    : app.sharing.conversationView(scope.conversationId, user.id);
}

/** `sharedWith` for a loader: the accounts whose projection passes `test` (none when sharing is not set up). */
export function sharedWith(
  app: FastifyInstance,
  conversationId: string,
  test: (p: Projection) => boolean = () => true,
  conversationOnly = true,
): string[] {
  return app.sharing ? app.sharing.viewers(conversationId, conversationOnly, test) : [];
}
