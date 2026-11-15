import crypto from "node:crypto";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  normalizeDoc,
  parseItemLines,
  renderItems,
  type ItemAuthor,
  type MemoryDocKind,
  type VersionAuthor,
} from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { memoryDocuments, memoryItemSources, memoryItems, memoryVersions } from "../db/schema.js";
import { scrubKnown } from "../secrets/known.js";

/**
 * 내 지침 storage (#144, docs/memory-spec.md §1·§10). Documents, their versions, and the items of the two list
 * documents (`USER.md`, `MEMORY.md`) with their sources. Every change makes a version in one transaction; nothing here
 * checks caps or rules — the service (`MemoryDocs`) does that before calling.
 */

export type DocRow = typeof memoryDocuments.$inferSelect;
export type VersionRow = typeof memoryVersions.$inferSelect;
export type ItemRow = typeof memoryItems.$inferSelect;
export type ItemSource = { messageId: string; revision: number; conversationId: string };
export type Item = ItemRow & { sources: ItemSource[] };

/** The family-wide AGENT and the admin's default SOUL. */
export const SYSTEM_AGENT_ID = "system:agent";
export const SYSTEM_SOUL_ID = "system:soul";

export const isListKind = (k: MemoryDocKind) => k === "user" || k === "memory";

/** A document's text as stored: LF line ends, no blank edges. A list document is rendered from its items. */
export const cleanFree = (s: string) => normalizeDoc(s).trim();

/** Which items of a list document a new text keeps, replaces, adds and drops (spec §1 줄 단위 맞추기). */
export type Reconciled = {
  /** The new document, in order: an existing item (same line) or a new one (with the sources it inherits). */
  next: ({ keep: Item } | { text: string; sources: ItemSource[] })[];
  removed: Item[];
};

/**
 * Matches the edited lines to the current items (spec §1), in two passes:
 * 1. **The same line is the same item, wherever it moved**: each line takes the first unused current item with the
 *    same text (duplicates in order, so the result never depends on anything but the two texts). A moved line keeps
 *    its id and sources — the deletion linkage (§10) still finds it.
 * 2. The lines left over are changed or new, the items left over changed or gone: they are paired in order — a
 *    changed line replaces the item it stands in for and **inherits its sources** (the new text was written from it,
 *    so deleting the source message still removes it); extra lines are new items without sources; extra items go.
 */
export function reconcile(current: readonly Item[], lines: readonly string[]): Reconciled {
  const pool = new Map<string, Item[]>();
  for (const i of current) pool.set(i.text, [...(pool.get(i.text) ?? []), i]);
  const kept = lines.map((text) => pool.get(text)?.shift());
  const used = new Set(kept.flatMap((k) => (k ? [k.id] : [])));
  const leftover = current.filter((i) => !used.has(i.id));
  let k = 0;
  const next: Reconciled["next"] = lines.map((text, j) => {
    const keep = kept[j];
    if (keep) return { keep };
    const replaced = leftover[k++];
    return { text, sources: replaced ? replaced.sources : [] };
  });
  return { next, removed: leftover };
}

export class MemoryStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** The document of `ownerId` (null = system) and kind, if it exists. */
  doc(ownerId: string | null, kind: MemoryDocKind): DocRow | undefined {
    if (ownerId === null) {
      const id = kind === "agent" ? SYSTEM_AGENT_ID : kind === "soul" ? SYSTEM_SOUL_ID : undefined;
      return id ? this.byId(id) : undefined;
    }
    return this.db
      .select()
      .from(memoryDocuments)
      .where(and(eq(memoryDocuments.ownerId, ownerId), eq(memoryDocuments.kind, kind)))
      .get();
  }

  byId(id: string): DocRow | undefined {
    return this.db.select().from(memoryDocuments).where(eq(memoryDocuments.id, id)).get();
  }

  /** The document, created empty (version 0) when it does not exist yet. */
  ensure(ownerId: string | null, kind: MemoryDocKind): DocRow {
    const found = this.doc(ownerId, kind);
    if (found) return found;
    if (ownerId === null && kind !== "agent" && kind !== "soul")
      throw new Error("no system document of this kind");
    const row: DocRow = {
      id: ownerId === null ? (kind === "agent" ? SYSTEM_AGENT_ID : SYSTEM_SOUL_ID) : crypto.randomUUID(),
      ownerId,
      kind,
      version: 0,
      updatedAt: this.now(),
    };
    this.db.insert(memoryDocuments).values(row).onConflictDoNothing().run();
    return this.doc(ownerId, kind)!;
  }

  /** Documents of one owner (null: the system ones). */
  docsOf(ownerId: string | null): DocRow[] {
    return this.db
      .select()
      .from(memoryDocuments)
      .where(ownerId === null ? isNull(memoryDocuments.ownerId) : eq(memoryDocuments.ownerId, ownerId))
      .all();
  }

  version(documentId: string, version: number): VersionRow | undefined {
    return this.db
      .select()
      .from(memoryVersions)
      .where(and(eq(memoryVersions.documentId, documentId), eq(memoryVersions.version, version)))
      .get();
  }

  /** Newest first. */
  versions(documentId: string): VersionRow[] {
    return this.db
      .select()
      .from(memoryVersions)
      .where(eq(memoryVersions.documentId, documentId))
      .orderBy(desc(memoryVersions.version))
      .all();
  }

  current(doc: DocRow): VersionRow | undefined {
    return doc.version > 0 ? this.version(doc.id, doc.version) : undefined;
  }

  /** The current text ("" before the first save). */
  content(doc: DocRow | undefined): string {
    return doc ? (this.current(doc)?.content ?? "") : "";
  }

  /** Items by id, with their sources, in the order of `ids` (ids whose item is gone are left out). */
  itemsByIds(ids: readonly string[]): Item[] {
    if (!ids.length) return [];
    const rows = this.db
      .select()
      .from(memoryItems)
      .where(inArray(memoryItems.id, [...ids]))
      .all();
    const srcs = this.db
      .select()
      .from(memoryItemSources)
      .where(inArray(memoryItemSources.itemId, [...ids]))
      .orderBy(asc(memoryItemSources.messageId))
      .all();
    const byId = new Map(rows.map((r) => [r.id, { ...r, sources: [] as ItemSource[] }]));
    for (const s of srcs)
      byId.get(s.itemId)?.sources.push({
        messageId: s.messageId,
        revision: s.revision,
        conversationId: s.conversationId,
      });
    return ids.flatMap((id) => {
      const i = byId.get(id);
      return i ? [i] : [];
    });
  }

  /** The current items of a list document, in order. */
  items(doc: DocRow): Item[] {
    return this.itemsByIds(this.current(doc)?.itemIds ?? []);
  }

  /**
   * Writes a new version (in the caller's transaction or its own). `base`: refused (`DocConflict`) when the current
   * version is another one. For a list document `content` is matched line by line to the current items; new items
   * are written by `itemAuthor`. Unchanged content writes nothing and returns the current version.
   */
  save(input: {
    doc: DocRow;
    content: string;
    author: VersionAuthor;
    actorId: string | null;
    base?: number | undefined;
    itemAuthor?: ItemAuthor;
    restoredFrom?: number;
    /** A restore of a list document: exactly these items (they exist — the deletion linkage removes ids everywhere). */
    itemIds?: string[];
  }): { version: VersionRow; changed: boolean } {
    return this.db.$client
      .transaction(() => {
        const doc = this.byId(input.doc.id)!;
        if (input.base !== undefined && input.base !== doc.version) throw new DocConflict();
        const cur = this.current(doc);
        if (!isListKind(doc.kind)) {
          const content = scrubKnown(cleanFree(input.content));
          if (cur && cur.content === content) return { version: cur, changed: false };
          return { version: this.write(doc, content, null, input), changed: true };
        }
        let ids: string[];
        if (input.itemIds) ids = this.itemsByIds(input.itemIds).map((i) => i.id);
        else {
          const lines = parseItemLines(input.content).map((l) => scrubKnown(l));
          const r = reconcile(this.items(doc), lines);
          ids = r.next.map((n) =>
            "keep" in n ? n.keep.id : this.addItem(doc, n.text, input.itemAuthor ?? "user", n.sources),
          );
        }
        const content = renderItems(this.itemsByIds(ids).map((i) => i.text));
        if (cur && sameIds(cur.itemIds ?? [], ids)) return { version: cur, changed: false };
        return { version: this.write(doc, content, ids, input), changed: true };
      })
      .immediate();
  }

  /**
   * Adds items to a list document with their sources — the entry point of the conversation tool and Dreaming (#145,
   * #146) once their checks passed; the deletion-linkage tests use it.
   */
  addItems(
    doc: DocRow,
    items: { text: string; author: ItemAuthor; sources: ItemSource[] }[],
    author: VersionAuthor,
  ): VersionRow {
    return this.db.$client
      .transaction(() => {
        const d = this.byId(doc.id)!;
        if (!isListKind(d.kind)) throw new Error("not a list document");
        const ids = [
          ...(this.current(d)?.itemIds ?? []),
          ...items.map((i) =>
            this.addItem(d, scrubKnown(i.text.replace(/\s+/g, " ").trim()), i.author, i.sources),
          ),
        ];
        return this.write(d, renderItems(this.itemsByIds(ids).map((i) => i.text)), ids, {
          author,
          actorId: null,
        });
      })
      .immediate();
  }

  private addItem(doc: DocRow, text: string, author: ItemAuthor, sources: ItemSource[]): string {
    const id = crypto.randomUUID();
    this.db.insert(memoryItems).values({ id, documentId: doc.id, text, author, createdAt: this.now() }).run();
    const seen = new Set<string>();
    for (const s of sources) {
      if (seen.has(s.messageId)) continue;
      seen.add(s.messageId);
      this.db
        .insert(memoryItemSources)
        .values({
          itemId: id,
          messageId: s.messageId,
          revision: s.revision,
          conversationId: s.conversationId,
        })
        .run();
    }
    return id;
  }

  private write(
    doc: DocRow,
    content: string,
    itemIds: string[] | null,
    input: { author: VersionAuthor; actorId: string | null; restoredFrom?: number },
  ): VersionRow {
    const t = this.now();
    const row: VersionRow = {
      documentId: doc.id,
      version: doc.version + 1,
      author: input.author,
      actorId: input.actorId,
      prevVersion: doc.version > 0 ? doc.version : null,
      restoredFrom: input.restoredFrom ?? null,
      content,
      itemIds,
      unlinkedAt: null,
      createdAt: t,
    };
    this.db.insert(memoryVersions).values(row).run();
    this.db
      .update(memoryDocuments)
      .set({ version: row.version, updatedAt: t })
      .where(eq(memoryDocuments.id, doc.id))
      .run();
    return row;
  }

  /**
   * Deletion linkage (spec §10.1–2), inside the caller's transaction: every item citing one of the messages (or any
   * message of the conversation) goes whole — from the current document (a new version by "삭제 연동") and from
   * **every** version (number kept, lines gone), so a restore cannot bring it back. Returns the document versions that
   * held one of them (before the edit): the sessions started with those are to be forgotten (§10.5).
   */
  purgeSources(by: { conversationId: string } | { messageIds: readonly string[] }): {
    items: number;
    affected: { documentId: string; ownerId: string | null; versions: number[] }[];
  } {
    const sql = this.db.$client;
    const ids =
      "conversationId" in by
        ? (
            sql
              .prepare("SELECT DISTINCT item_id AS id FROM memory_item_sources WHERE conversation_id = ?")
              .all(by.conversationId) as { id: string }[]
          ).map((r) => r.id)
        : by.messageIds.length
          ? (
              sql
                .prepare(
                  "SELECT DISTINCT item_id AS id FROM memory_item_sources WHERE message_id IN (SELECT value FROM json_each(?))",
                )
                .all(JSON.stringify(by.messageIds)) as { id: string }[]
            ).map((r) => r.id)
          : [];
    if (!ids.length) return { items: 0, affected: [] };
    const gone = new Set(ids);
    const docIds = [
      ...new Set(
        (
          sql
            .prepare(
              "SELECT DISTINCT document_id AS d FROM memory_items WHERE id IN (SELECT value FROM json_each(?))",
            )
            .all(JSON.stringify(ids)) as { d: string }[]
        ).map((r) => r.d),
      ),
    ];
    const affected: { documentId: string; ownerId: string | null; versions: number[] }[] = [];
    for (const docId of docIds) {
      const doc = this.byId(docId);
      if (!doc) continue;
      const touched = this.versions(docId).filter((v) => (v.itemIds ?? []).some((i) => gone.has(i)));
      affected.push({ documentId: docId, ownerId: doc.ownerId, versions: touched.map((v) => v.version) });
      const cur = this.current(doc);
      // The current document first: a new version without them (spec §10.1).
      if (cur && touched.some((v) => v.version === cur.version)) {
        const keep = (cur.itemIds ?? []).filter((i) => !gone.has(i));
        this.write(doc, renderItems(this.itemsByIds(keep).map((i) => i.text)), keep, {
          author: "deletion",
          actorId: null,
        });
      }
      // Every older version, in place (§10.2).
      for (const v of touched) {
        const keep = (v.itemIds ?? []).filter((i) => !gone.has(i));
        this.db
          .update(memoryVersions)
          .set({
            itemIds: keep,
            content: renderItems(this.itemsByIds(keep).map((i) => i.text)),
            unlinkedAt: this.now(),
          })
          .where(and(eq(memoryVersions.documentId, docId), eq(memoryVersions.version, v.version)))
          .run();
      }
    }
    // The items themselves (their sources go with them).
    this.db.delete(memoryItems).where(inArray(memoryItems.id, ids)).run();
    return { items: ids.length, affected };
  }
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** The document changed since the editor loaded it (409). */
export class DocConflict extends Error {
  constructor() {
    super("doc_changed");
  }
}
