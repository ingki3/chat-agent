import {
  docSize,
  parseItemLines,
  renderItems,
  MEMORY_DOC_LIMITS,
  type InstructionDoc,
  type MemoryDocKind,
  type MemoryDocLimit,
  type SystemDocRef,
  type UserDocKind,
  type VersionAuthor,
} from "@agentlee/shared";
import type { UserRow } from "../auth/users.js";
import type { Db } from "../db/client.js";
import { defaultTemplates, type Templates } from "../instructions/assemble.js";
import type { DocSet } from "./inject.js";
import { holdsSecret, triesRuleChange } from "./rules.js";
import {
  cleanFree,
  DocConflict,
  isListKind,
  MemoryStore,
  SYSTEM_AGENT_ID,
  SYSTEM_SOUL_ID,
  type DocRow,
  type VersionRow,
} from "./store.js";

/**
 * 내 지침 (#144, PRD FR-16.1·16.3·16.8): what each screen shows, the checks on a save (docs/memory-spec.md §4, the
 * "사용자 직접 편집" column — size, secret, rule change → 400), and the documents a new session gets (§2).
 * Who may touch what: a user their own SOUL / USER / MEMORY (AGENT read-only); the admin the family-wide AGENT, the
 * default SOUL and each account's AGENT — never another user's SOUL, USER, MEMORY (FR-1.5, the routes answer 403).
 */

export type DocErrorCode = "doc_too_long" | "doc_secret" | "doc_rule_change" | "doc_changed";

export class DocRejected extends Error {
  constructor(
    readonly code: DocErrorCode,
    readonly status: 400 | 409,
  ) {
    super(code);
  }
}

/** Where a save goes: a user's own document, or one of the admin's. */
type Target =
  | { kind: "own"; user: Pick<UserRow, "id">; doc: UserDocKind }
  | { kind: "system"; ref: SystemDocRef }
  | { kind: "account-agent"; userId: string };

const limitOf = (t: Target): MemoryDocLimit =>
  t.kind === "system"
    ? t.ref === "common-agent"
      ? MEMORY_DOC_LIMITS.agentCommon
      : MEMORY_DOC_LIMITS.soul
    : t.kind === "account-agent"
      ? MEMORY_DOC_LIMITS.agent
      : MEMORY_DOC_LIMITS[t.doc];

/** SOUL, USER and MEMORY go into the user material box: a rule change there is refused (spec §4). */
const ruleChecked = (t: Target) => t.kind === "own" || (t.kind === "system" && t.ref === "default-soul");

export class MemoryDocs {
  readonly store: MemoryStore;
  private readonly templates: Templates;

  constructor(db: Db, opts: { now?: () => number; templates?: Templates } = {}) {
    this.store = new MemoryStore(db, opts.now);
    this.templates = opts.templates ?? defaultTemplates();
  }

  private docOf(t: Target): DocRow {
    if (t.kind === "system") return this.store.ensure(null, t.ref === "common-agent" ? "agent" : "soul");
    if (t.kind === "account-agent") return this.store.ensure(t.userId, "agent");
    return this.store.ensure(t.user.id, t.doc);
  }

  /**
   * Refuses what may not be stored (400, spec §4): over a cap (code points or UTF-8 bytes), a secret, a rule change.
   * Checked on the text as it will be stored (list documents: their items rendered as `- item` lines).
   */
  private check(t: Target, stored: string): void {
    const size = docSize(stored);
    const l = limitOf(t);
    if (size.chars > l.chars || size.bytes > l.bytes) throw new DocRejected("doc_too_long", 400);
    if (holdsSecret(stored)) throw new DocRejected("doc_secret", 400);
    if (ruleChecked(t) && triesRuleChange(stored)) throw new DocRejected("doc_rule_change", 400);
  }

  /** The text `save` would store (to check it before anything is written). */
  private storedForm(doc: DocRow, content: string): string {
    return isListKind(doc.kind) ? renderItems(parseItemLines(content)) : cleanFree(content);
  }

  /** A save of a whole document (user edit, admin edit). */
  save(
    t: Target,
    content: string,
    opts: { actorId: string; base?: number | undefined },
  ): { doc: DocRow; version: VersionRow; changed: boolean } {
    const doc = this.docOf(t);
    this.check(t, this.storedForm(doc, content));
    const author: VersionAuthor = t.kind === "own" ? "user" : "admin";
    try {
      const r = this.store.save({
        doc,
        content,
        author,
        actorId: opts.actorId,
        base: opts.base,
        itemAuthor: "user",
      });
      return { doc: this.store.byId(doc.id)!, ...r };
    } catch (e) {
      if (e instanceof DocConflict) throw new DocRejected("doc_changed", 409);
      throw e;
    }
  }

  /** 되돌리기 (spec §1): a new version with the chosen version's content (and items). Undefined: no such version. */
  restore(
    t: Target,
    version: number,
    opts: { actorId: string; base?: number | undefined },
  ): { doc: DocRow; version: VersionRow; changed: boolean } | undefined {
    const doc = this.docOf(t);
    const v = this.store.version(doc.id, version);
    if (!v) return undefined;
    this.check(t, v.content);
    try {
      const r = this.store.save({
        doc,
        content: v.content,
        author: t.kind === "own" ? "user" : "admin",
        actorId: opts.actorId,
        base: opts.base,
        restoredFrom: v.version,
        ...(isListKind(doc.kind) ? { itemIds: v.itemIds ?? [] } : {}),
      });
      return { doc: this.store.byId(doc.id)!, ...r };
    } catch (e) {
      if (e instanceof DocConflict) throw new DocRejected("doc_changed", 409);
      throw e;
    }
  }

  versions(t: Target): VersionRow[] {
    const doc = this.lookup(t);
    return doc ? this.store.versions(doc.id) : [];
  }

  version(t: Target, v: number): VersionRow | undefined {
    const doc = this.lookup(t);
    return doc ? this.store.version(doc.id, v) : undefined;
  }

  private lookup(t: Target): DocRow | undefined {
    if (t.kind === "system") return this.store.doc(null, t.ref === "common-agent" ? "agent" : "soul");
    if (t.kind === "account-agent") return this.store.doc(t.userId, "agent");
    return this.store.doc(t.user.id, t.doc);
  }

  private view(
    doc: DocRow | undefined,
    kind: MemoryDocKind,
    o: { ref: string | null; editable: boolean; limit: MemoryDocLimit | null },
  ): InstructionDoc {
    const items = isListKind(kind) && doc ? this.store.items(doc) : isListKind(kind) ? [] : null;
    return {
      kind,
      ref: o.ref,
      editable: o.editable,
      source: "own",
      version: doc?.version ?? 0,
      content: this.store.content(doc),
      limit: o.limit ? { chars: o.limit.chars, bytes: o.limit.bytes } : null,
      items:
        items?.map((i) => ({ id: i.id, text: i.text, author: i.author, sources: i.sources.length })) ?? null,
      updatedAt: doc && doc.version > 0 ? doc.updatedAt : null,
    };
  }

  /** The AGENT a user reads (read-only): the repository's common rules, the family-wide part, youth, the account's. */
  composedAgent(user: Pick<UserRow, "id" | "youth">): string {
    const t = this.templates;
    const common = this.store.content(this.store.doc(null, "agent"));
    const account = this.store.content(this.store.doc(user.id, "agent"));
    return [
      t.common.body,
      ...(common ? [`## 가족 공통 운영 규칙\n${common}`] : []),
      ...(user.youth ? [t.youth.body] : []),
      ...(account ? [`## 이 계정의 운영 규칙\n${account}`] : []),
    ].join("\n\n");
  }

  /** `GET /api/instructions`: the caller's four documents (SOUL falls back to the admin's default). */
  userView(user: Pick<UserRow, "id" | "youth">): InstructionDoc[] {
    const agentDoc = this.store.doc(user.id, "agent");
    const commonDoc = this.store.doc(null, "agent");
    const agent: InstructionDoc = {
      kind: "agent",
      ref: null,
      editable: false,
      source: "composed",
      version: (commonDoc?.version ?? 0) + (agentDoc?.version ?? 0),
      content: this.composedAgent(user),
      limit: null,
      items: null,
      updatedAt: Math.max(commonDoc?.updatedAt ?? 0, agentDoc?.updatedAt ?? 0) || null,
    };
    const own = this.store.doc(user.id, "soul");
    const soul =
      own && own.version > 0
        ? this.view(own, "soul", { ref: null, editable: true, limit: MEMORY_DOC_LIMITS.soul })
        : {
            ...this.view(this.store.doc(null, "soul"), "soul", {
              ref: null,
              editable: true,
              limit: MEMORY_DOC_LIMITS.soul,
            }),
            source: "default" as const,
            // The editor's base is the user's own document (none yet), not the default's version.
            version: 0,
          };
    return [
      agent,
      soul,
      this.view(this.store.doc(user.id, "user"), "user", {
        ref: null,
        editable: true,
        limit: MEMORY_DOC_LIMITS.user,
      }),
      this.view(this.store.doc(user.id, "memory"), "memory", {
        ref: null,
        editable: true,
        limit: MEMORY_DOC_LIMITS.memory,
      }),
    ];
  }

  systemView(ref: SystemDocRef): InstructionDoc {
    const kind = ref === "common-agent" ? "agent" : "soul";
    return this.view(this.store.doc(null, kind), kind, {
      ref,
      editable: true,
      limit: ref === "common-agent" ? MEMORY_DOC_LIMITS.agentCommon : MEMORY_DOC_LIMITS.soul,
    });
  }

  accountAgentView(userId: string): InstructionDoc {
    return this.view(this.store.doc(userId, "agent"), "agent", {
      ref: `account-agent:${userId}`,
      editable: true,
      limit: MEMORY_DOC_LIMITS.agent,
    });
  }

  /** The documents a new session of this user gets (spec §2), at their current versions. */
  docSet(userId: string): DocSet {
    const free = (d: DocRow | undefined) => {
      const c = d && d.version > 0 ? this.store.current(d) : undefined;
      return d && c ? { id: d.id, version: d.version, text: c.content } : null;
    };
    const list = (d: DocRow | undefined) =>
      d && d.version > 0
        ? { id: d.id, version: d.version, items: this.store.items(d).map((i) => i.text) }
        : null;
    const ownSoul = this.store.doc(userId, "soul");
    return {
      agentCommon: free(this.store.doc(null, "agent")),
      agentAccount: free(this.store.doc(userId, "agent")),
      soul: free(ownSoul && ownSoul.version > 0 ? ownSoul : this.store.doc(null, "soul")),
      user: list(this.store.doc(userId, "user")),
      memory: list(this.store.doc(userId, "memory")),
    };
  }
}

export { SYSTEM_AGENT_ID, SYSTEM_SOUL_ID };
export type { Target as DocTarget };
