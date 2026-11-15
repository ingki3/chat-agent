import crypto from "node:crypto";
import {
  docSize,
  MEMORY_DOC_LIMITS,
  oneLine,
  renderItems,
  type MemoryApplyMode,
  type MemoryDecision,
  type MemoryDecisionStatus,
  type MemoryListKind,
  type MemoryProposal,
  type MemoryProposeInput,
  type MemoryRefusalKind,
} from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { scrubKnown } from "../secrets/known.js";
import { foldForCheck, holdsSecret, isSensitive, triesRuleChange } from "./rules.js";
import { DocConflict, type DocRow, type ItemOp, type ItemSource, type MemoryStore } from "./store.js";

/**
 * 대화 중 기억해줘·잊어줘 (#145, PRD FR-16.4·16.7, docs/memory-spec.md §3–§5, §10.3): the `memory_propose` tool's
 * bundles of decisions — the in-chat card — and the user setting "기억 반영 방식".
 *
 * - **Sources** (§3) are checked when a bundle is made and again right before a decision is applied: a user message of
 *   the token's own conversation, owned by the user, not a schedule conversation, not a message a fork copied, and
 *   still in the active history at the revision it was cited with. Only message ids go in — the text comes from the
 *   model, but it is checked as it will be stored.
 * - **Checks** (§4, conversation tool column): format and unknown item ids refuse the whole request (the tool's
 *   error); a source, secret or rule change refuses that decision; a document over its cap refuses all of that
 *   document's decisions; a sensitive category always waits for the card.
 * - **Mode** (§5): 검토 후 반영 → every decision waits for the card; 자동 반영 → applied at once (one version per
 *   document, author "대화 도구") except sensitive ones — and, as a guard against prompt injection, every one when the
 *   run had read outside content (web, files, tools) before it proposed.
 * - **Pinning** (§5): a bundle remembers each document's version. Accepting checks it: another change in between
 *   expires the whole bundle ("다시 요청해 주세요"); what the bundle itself applies moves the pin (A, then B), the
 *   remaining decisions being checked again against the new version.
 * Everything a call changes — documents, versions, decision states — is one transaction.
 */

type ProposalRow = {
  id: string;
  owner_id: string;
  /** Null for a Dreaming bundle (#146): each source names its own conversation. */
  conversation_id: string | null;
  run_id: string;
  origin: "tool" | "dreaming";
  mode: MemoryApplyMode;
  forced: "sensitive" | "external" | "suspicious" | null;
  base: string;
  applied: string;
  created_at: number;
  updated_at: number;
};
type DecisionRow = {
  proposal_id: string;
  idx: number;
  doc: MemoryListKind;
  action: "add" | "replace" | "delete" | "merge";
  item_id: string | null;
  /** A merge's items (JSON array), null otherwise. */
  merge_ids: string | null;
  text: string | null;
  before: string | null;
  sources: string;
  sensitive: number;
  status: MemoryDecisionStatus;
  updated_at: number;
};
type Applied = Partial<Record<MemoryListKind, { before: number; after: number }>>;
type Base = Partial<Record<MemoryListKind, number>>;

export type ToolScope = { userId: string; conversationId: string; runId: string };

/** What `memory_propose` answers (the model reads it; counts only, never text). */
export type ProposeOutcome =
  | { ok: false; code: "memory_bad_input" | "memory_unknown_item" | "memory_not_allowed" }
  | {
      ok: true;
      proposalId: string | null;
      applied: number;
      pending: number;
      /** Kept on the card but left out on the way (size once the auto-applied part went alone). */
      dropped?: number;
      refused: Partial<Record<MemoryRefusalKind, number>>;
    };

/** A refusal of a card action. */
export class ProposalError extends Error {
  constructor(
    readonly code: "not_found" | "forbidden" | "proposal_expired" | "proposal_closed" | "undo_unavailable",
    readonly status: 403 | 404 | 409,
  ) {
    super(code);
  }
}

const LIMIT: Record<MemoryListKind, { chars: number; bytes: number }> = {
  user: MEMORY_DOC_LIMITS.user,
  memory: MEMORY_DOC_LIMITS.memory,
};
const KINDS: MemoryListKind[] = ["user", "memory"];
/** How many of the conversation's user messages `memory_list` names (newest last). */
const LIST_MESSAGES = 20;
const PREVIEW = 120;

export class MemoryProposals {
  constructor(
    private readonly db: Db,
    private readonly store: MemoryStore,
    private readonly now: () => number = Date.now,
  ) {}

  private get sql() {
    return this.db.$client;
  }

  // ---- the setting (spec §5) ----

  /** "기억 반영 방식" of a user (no row: 검토 후 반영). */
  mode(userId: string): MemoryApplyMode {
    const r = this.sql.prepare("select apply_mode as m from memory_prefs where user_id = ?").get(userId) as
      { m: MemoryApplyMode } | undefined;
    return r?.m ?? "review";
  }

  setMode(userId: string, mode: MemoryApplyMode): void {
    this.sql
      .prepare(
        `insert into memory_prefs (user_id, apply_mode, updated_at) values (?, ?, ?)
         on conflict(user_id) do update set apply_mode = excluded.apply_mode, updated_at = excluded.updated_at`,
      )
      .run(userId, mode, this.now());
  }

  // ---- where the tool may run, and its sources (spec §3) ----

  /**
   * Whether the tool may run in this conversation for this user: theirs (never a shared viewer's — a viewer has no
   * run there), and not a schedule conversation (spec §2: no conversation tool in scheduled runs).
   */
  allowedIn(scope: Pick<ToolScope, "userId" | "conversationId">): boolean {
    const c = this.sql
      .prepare("select owner_id as o, kind as k from conversations where id = ?")
      .get(scope.conversationId) as { o: string; k: string } | undefined;
    return !!c && c.o === scope.userId && c.k !== "schedule";
  }

  /**
   * Whether outside material may be in what the runtime knows of this conversation (review #154 rounds 1–2, P1). The
   * rule is deliberately coarse — auto-apply only in a conversation that has never had any: none of
   * - a tool other than the memory tools called by an answer still in the active history (web pages, files, skill and
   *   tool output stay in a resumed session and in the history a fresh one is given);
   * - an uploaded file, an artifact or a stored web source of the conversation — their names and titles reach every
   *   fresh session as conversation references (`renderPriorContext`), and they outlive an edit or a regenerate of
   *   the answer that made them;
   * - being a fork (#52): its copied messages, copy notice and copied artifacts / files / sources came from someone
   *   else's conversation.
   * Anything else (the user's own messages, our own answers without tools) is what the user said in this
   * conversation. Such a conversation never auto-applies; the card decides.
   */
  externalInHistory(conversationId: string): boolean {
    return !!this.sql
      .prepare(
        `select 1 where
           exists (select 1 from conversations where id = @c and kind = 'fork')
           or exists (select 1 from files where conversation_id = @c)
           or exists (select 1 from artifacts where conversation_id = @c)
           or exists (select 1 from sources where conversation_id = @c)
           or exists (
             select 1 from messages m, json_each(m.parts) j
              where m.conversation_id = @c and m.active = 1 and m.role = 'assistant'
                and json_extract(j.value, '$.type') = 'tool_call'
                and json_extract(j.value, '$.name') not in
                    ('memory_list', 'memory_propose', 'mcp__agentlee__memory_list', 'mcp__agentlee__memory_propose'))`,
      )
      .get({ c: conversationId });
  }

  /** The user message the run answers: its own, or (다시 생성) the last active one before its reply. */
  private turnMessage(scope: ToolScope): string | undefined {
    const run = this.sql
      .prepare(
        "select user_message_id as u, assistant_message_id as a from runs where id = ? and conversation_id = ?",
      )
      .get(scope.runId, scope.conversationId) as { u: string | null; a: string } | undefined;
    if (!run) return undefined;
    if (run.u) return run.u;
    const r = this.sql
      .prepare(
        `select m.id as id from messages m, messages a
          where a.id = ? and m.conversation_id = a.conversation_id and m.role = 'user' and m.active = 1
            and m.seq < a.seq order by m.seq desc limit 1`,
      )
      .get(run.a) as { id: string } | undefined;
    return r?.id;
  }

  /**
   * One source message as spec §3 allows it, or undefined: role user, in `conversationId` (owned by `userId`, not a
   * schedule conversation), active, not a copy a fork made, and — when `revision` is given — at that revision.
   */
  private source(
    userId: string,
    conversationId: string,
    messageId: string,
    revision?: number,
  ): ItemSource | undefined {
    const m = this.sql
      .prepare(
        `select m.id as id, m.revision as revision, m.conversation_id as conversationId
           from messages m join conversations c on c.id = m.conversation_id
          where m.id = ? and m.conversation_id = ? and m.role = 'user' and m.active = 1
            and c.owner_id = ? and c.kind != 'schedule'
            and not exists (select 1 from fork_items f where f.item_type = 'message' and f.copy_id = m.id)`,
      )
      .get(messageId, conversationId, userId) as (ItemSource & { id: string }) | undefined;
    if (!m || (revision !== undefined && m.revision !== revision)) return undefined;
    return { messageId: m.id, revision: m.revision, conversationId: m.conversationId };
  }

  /** Every source passes (§3), or none is taken. */
  private sources(userId: string, conversationId: string, ids: readonly string[]): ItemSource[] | undefined {
    const out: ItemSource[] = [];
    for (const id of new Set(ids)) {
      const s = this.source(userId, conversationId, id);
      if (!s) return undefined;
      out.push(s);
    }
    return out.length ? out : undefined;
  }

  /** `memory_list`: the current items (ids to replace or delete) and the conversation's user messages (sources). */
  list(scope: ToolScope) {
    const items = (kind: MemoryListKind) => {
      const doc = this.store.doc(scope.userId, kind);
      return doc ? this.store.items(doc).map((i) => ({ itemId: i.id, text: scrubKnown(i.text) })) : [];
    };
    const rows = this.sql
      .prepare(
        `select m.id as id, m.search_text as text from messages m join conversations c on c.id = m.conversation_id
          where m.conversation_id = ? and m.role = 'user' and m.active = 1 and c.owner_id = ?
            and not exists (select 1 from fork_items f where f.item_type = 'message' and f.copy_id = m.id)
          order by m.seq desc limit ?`,
      )
      .all(scope.conversationId, scope.userId, LIST_MESSAGES) as { id: string; text: string }[];
    return {
      user: items("user"),
      memory: items("memory"),
      currentMessageId: this.turnMessage(scope) ?? null,
      messages: rows.reverse().map((r) => ({
        messageId: r.id,
        preview: scrubKnown([...r.text.replace(/\s+/g, " ").trim()].slice(0, PREVIEW).join("")),
      })),
    };
  }

  // ---- making a bundle ----

  /**
   * `memory_propose` (spec §4–§5). `external`: the run read outside content before this call — nothing is applied
   * at once (the card decides).
   */
  propose(scope: ToolScope, input: MemoryProposeInput, opts: { external: boolean }): ProposeOutcome {
    if (!this.allowedIn(scope)) return { ok: false, code: "memory_not_allowed" };
    // Outside content seen by this run (the caller's mark) or still in what the runtime session may know.
    const external = opts.external || this.externalInHistory(scope.conversationId);
    return this.sql
      .transaction((): ProposeOutcome => {
        // 형식 (whole request): every replace / delete names a current item of the user's USER or MEMORY, once.
        const docs = Object.fromEntries(KINDS.map((k) => [k, this.store.ensure(scope.userId, k)])) as Record<
          MemoryListKind,
          DocRow
        >;
        const owner = new Map<string, { kind: MemoryListKind; text: string; sources: ItemSource[] }>();
        for (const k of KINDS)
          for (const i of this.store.items(docs[k]))
            owner.set(i.id, { kind: k, text: i.text, sources: i.sources });
        const seen = new Set<string>();
        const changes: {
          doc: MemoryListKind;
          action: "add" | "replace" | "delete";
          itemId: string | null;
          text: string | null;
          before: string | null;
          /** The target item's own sources (its `before` text came from them, spec §10.3). */
          targetSources: ItemSource[];
        }[] = [];
        for (const c of input.changes) {
          if (c.action === "add") {
            const text = oneLine(c.text);
            if (!text) return { ok: false, code: "memory_bad_input" };
            changes.push({ doc: c.doc, action: "add", itemId: null, text, before: null, targetSources: [] });
            continue;
          }
          const it = owner.get(c.itemId);
          if (!it) return { ok: false, code: "memory_unknown_item" };
          if (seen.has(c.itemId)) return { ok: false, code: "memory_bad_input" };
          seen.add(c.itemId);
          const text = c.action === "replace" ? oneLine(c.text) : null;
          if (c.action === "replace" && !text) return { ok: false, code: "memory_bad_input" };
          changes.push({
            doc: it.kind,
            action: c.action,
            itemId: c.itemId,
            text,
            before: it.text,
            targetSources: it.sources,
          });
        }
        // 출처 (that decision — here every decision shares the request's sources).
        const turn = this.turnMessage(scope);
        const ids = input.sourceMessageIds ?? (turn ? [turn] : []);
        const sources = this.sources(scope.userId, scope.conversationId, ids);
        const refused: Partial<Record<MemoryRefusalKind, number>> = {};
        const refuse = (k: MemoryRefusalKind) => (refused[k] = (refused[k] ?? 0) + 1);
        const kept: ((typeof changes)[number] & { sensitive: boolean })[] = [];
        for (const c of changes) {
          if (!sources) {
            refuse("source");
            continue;
          }
          // 비밀 값 · 규칙 바꾸기 (that decision): the new line as it would be stored.
          if (c.text !== null && holdsSecret(c.text)) {
            refuse("secret_value");
            continue;
          }
          if (c.text !== null && triesRuleChange(c.text)) {
            refuse("rule_change");
            continue;
          }
          if (
            (c.action === "replace" && c.text === c.before) ||
            (c.action === "add" && [...owner.values()].some((o) => o.kind === c.doc && o.text === c.text))
          ) {
            refuse("unchanged");
            continue;
          }
          const sensitive =
            input.sensitive === true ||
            (c.text !== null && isSensitive(c.text)) ||
            // The line that is replaced or deleted counts too (forgetting a health fact is still about health).
            (c.before !== null && isSensitive(c.before));
          kept.push({ ...c, sensitive });
        }
        // 크기 (the document's decisions): the document as it would be with all of them.
        const final = kept.filter((c) => {
          const ok = this.fits(
            docs[c.doc],
            kept.filter((k) => k.doc === c.doc),
          );
          if (!ok) refuse("size");
          return ok;
        });
        if (!final.length || !sources) return { ok: true, proposalId: null, applied: 0, pending: 0, refused };

        const mode = this.mode(scope.userId);
        const at = this.now();
        const id = crypto.randomUUID();
        const base: Base = {};
        for (const k of KINDS) if (final.some((c) => c.doc === k)) base[k] = docs[k].version;
        const autoOk = (c: { sensitive: boolean }) => mode === "auto" && !external && !c.sensitive;
        const forced =
          mode !== "auto"
            ? null
            : external
              ? ("external" as const)
              : final.some((c) => c.sensitive)
                ? ("sensitive" as const)
                : null;
        this.sql
          .prepare(
            `insert into memory_proposals (id, owner_id, conversation_id, run_id, mode, forced, base, applied,
               created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?)`,
          )
          .run(
            id,
            scope.userId,
            scope.conversationId,
            scope.runId,
            mode,
            forced,
            JSON.stringify(base),
            at,
            at,
          );
        const ins = this.sql.prepare(
          `insert into memory_proposal_decisions (proposal_id, idx, doc, action, item_id, text, before, sources,
             target_sources, sensitive, status, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
        );
        final.forEach((c, i) =>
          ins.run(
            id,
            i,
            c.doc,
            c.action,
            c.itemId,
            c.text === null ? null : scrubKnown(c.text),
            c.before === null ? null : scrubKnown(c.before),
            JSON.stringify(sources),
            JSON.stringify(c.targetSources),
            c.sensitive ? 1 : 0,
            at,
          ),
        );
        // 자동 반영: what may go at once goes now, one version per document.
        const now = final.flatMap((c, i) => (autoOk(c) ? [i] : []));
        if (now.length) this.applyIndexes(this.row(id)!, now, "applied");
        // What the bundle really holds now (review #154 round 3): an auto-applied decision can still be dropped (its
        // document would not fit without a decision that waits for the card).
        const st = this.decisions(id).map((d) => d.status);
        const count = (x: MemoryDecisionStatus) => st.filter((v) => v === x).length;
        return {
          ok: true,
          proposalId: id,
          applied: count("applied"),
          pending: count("pending"),
          dropped: count("dropped"),
          refused,
        };
      })
      .immediate();
  }

  /** Whether the document stays within its cap with these decisions (spec §4 크기). */
  fits(doc: DocRow, ops: readonly OpLike[]) {
    const z = this.sizeWith(doc, ops);
    if (!z) return false;
    const l = LIMIT[doc.kind as MemoryListKind];
    return z.chars <= l.chars && z.bytes <= l.bytes;
  }

  /** The document's size with these decisions applied (the store's planner), or undefined when they cannot be. */
  private sizeWith(doc: DocRow, ops: readonly OpLike[]): { chars: number; bytes: number } | undefined {
    const plan = this.store.planOps(
      doc,
      ops.map((o) => toOp(o)),
    );
    if (!plan) return undefined;
    const texts = new Map(
      this.store
        .itemsByIds(plan.ids.filter((x): x is string => typeof x === "string"))
        .map((i) => [i.id, i.text]),
    );
    return docSize(renderItems(plan.ids.map((x) => (typeof x === "string" ? (texts.get(x) ?? "") : x.text))));
  }

  // ---- the card ----

  private row(id: string): ProposalRow | undefined {
    return this.sql.prepare("select * from memory_proposals where id = ?").get(id) as ProposalRow | undefined;
  }

  private decisions(id: string): DecisionRow[] {
    return this.sql
      .prepare("select * from memory_proposal_decisions where proposal_id = ? order by idx")
      .all(id) as DecisionRow[];
  }

  /** Who a bundle belongs to (the route's resource check). */
  ownerOf(id: string): string | undefined {
    return this.row(id)?.owner_id;
  }

  /** The bundle, for its owner only (anyone else — the admin included, FR-1.5 — is refused). */
  private owned(id: string, userId: string): ProposalRow {
    const p = this.row(id);
    if (!p) throw new ProposalError("not_found", 404);
    if (p.owner_id !== userId) throw new ProposalError("forbidden", 403);
    return p;
  }

  view(id: string, userId: string): MemoryProposal {
    return this.viewOf(this.owned(id, userId));
  }

  private viewOf(p: ProposalRow): MemoryProposal {
    const ds = this.decisions(p.id);
    const applied = JSON.parse(p.applied) as Applied;
    const kinds = Object.keys(applied) as MemoryListKind[];
    const canUndo =
      ds.some((d) => d.status === "applied") &&
      kinds.length > 0 &&
      kinds.every((k) => (this.store.doc(p.owner_id, k)?.version ?? 0) === applied[k]!.after);
    return {
      id: p.id,
      conversationId: p.conversation_id,
      origin: p.origin,
      mode: p.mode,
      forced: p.forced,
      decisions: ds.map((d): MemoryDecision => ({
        index: d.idx,
        doc: d.doc,
        action: d.action,
        text: d.text === null ? null : scrubKnown(d.text),
        before: d.before === null ? null : scrubKnown(d.before),
        sensitive: d.sensitive === 1,
        status: d.status,
      })),
      canUndo,
      createdAt: p.created_at,
    };
  }

  private setStatus(p: ProposalRow, idx: number, status: MemoryDecisionStatus) {
    this.sql
      .prepare(
        "update memory_proposal_decisions set status = ?, updated_at = ? where proposal_id = ? and idx = ?",
      )
      .run(status, this.now(), p.id, idx);
  }

  /** A decision checked again right before it is applied (spec §3 sources at their revision, §4 content). */
  private stillValid(p: ProposalRow, d: DecisionRow): boolean {
    const srcs = JSON.parse(d.sources) as ItemSource[];
    if (!srcs.length) return false;
    // A Dreaming bundle's sources are in the user's own conversations, each its own (#146).
    for (const s of srcs)
      if (!this.source(p.owner_id, p.conversation_id ?? s.conversationId, s.messageId, s.revision))
        return false;
    if (d.text !== null && (holdsSecret(d.text) || triesRuleChange(d.text))) return false;
    // A Dreaming decision never applies a sensitive category (spec §4), however it got here.
    if (p.origin === "dreaming" && ((d.text !== null && isSensitive(d.text)) || d.sensitive === 1))
      return false;
    const doc = this.store.doc(p.owner_id, d.doc);
    const current = doc ? (this.store.current(doc)?.itemIds ?? []) : [];
    // Size is not judged per decision: only on the document with every decision applied together (spec §4 크기).
    if (d.item_id !== null && !current.includes(d.item_id)) return false;
    return !(
      d.merge_ids !== null && !(JSON.parse(d.merge_ids) as string[]).every((i) => current.includes(i))
    );
  }

  /**
   * Applies decisions of the bundle in order (one transaction, the caller's), each against its document's pinned
   * version: another change in between expires the bundle (thrown). After each, the pin moves to the new version and
   * the remaining pending decisions are checked again — those that no longer pass are dropped.
   */
  private applyIndexes(p: ProposalRow, indexes: readonly number[], as: "accepted" | "applied"): void {
    const base = JSON.parse(p.base) as Base;
    const applied = JSON.parse(p.applied) as Applied;
    const byIdx = new Map(this.decisions(p.id).map((d) => [d.idx, d]));
    const chosen = (k: MemoryListKind) =>
      indexes.map((i) => byIdx.get(i)).filter((d): d is DecisionRow => d?.doc === k);
    // Every pin first, before anything is written: another change to any document of the bundle — not only those of
    // the chosen decisions — expires it whole (spec §5).
    for (const k of KINDS)
      if (base[k] !== undefined && (this.store.doc(p.owner_id, k)?.version ?? 0) !== base[k])
        throw new Expired();
    // Grouped per document, in the order given: one new version per document.
    for (const k of KINDS) {
      const mine = chosen(k);
      if (!mine.length) continue;
      const doc = this.store.ensure(p.owner_id, k);
      const ok = mine.filter((d) => d.status === "pending" && this.stillValid(p, d));
      for (const d of mine)
        if (d.status === "pending" && !ok.includes(d)) this.setStatus(p, d.idx, "dropped");
      if (!ok.length) continue;
      if (!this.fits(doc, ok.map(opOf))) {
        for (const d of ok) this.setStatus(p, d.idx, "dropped");
        continue;
      }
      let v;
      try {
        v = this.store.applyOps({
          doc,
          ops: ok.map((d) => toOp(opOf(d), JSON.parse(d.sources) as ItemSource[])),
          base: doc.version,
          author: p.origin === "dreaming" ? "dreaming" : "tool",
          itemAuthor: p.origin === "dreaming" ? "dreaming" : "tool",
          actorId: p.owner_id,
        });
      } catch (e) {
        if (e instanceof DocConflict) throw new Expired();
        throw e;
      }
      for (const d of ok) this.setStatus(p, d.idx, as);
      applied[k] = { before: applied[k]?.before ?? doc.version, after: v.version };
      base[k] = v.version;
    }
    this.sql
      .prepare("update memory_proposals set base = ?, applied = ?, updated_at = ? where id = ?")
      .run(JSON.stringify(base), JSON.stringify(applied), this.now(), p.id);
    // The rest, against the new versions (spec §5 같은 묶음의 부분 반영).
    this.recheckRest(this.row(p.id)!);
  }

  /**
   * After a partial 반영 or 거절 (spec §5): the bundle's pending decisions checked again — sources, content, target
   * item — and, per document, size: a decision that no longer fits even with every remaining pending decision of its
   * document that makes room (deletes, replaces with a line no longer than the old one) can never be applied, so it is
   * dropped.
   */
  private recheckRest(p: ProposalRow): void {
    for (const d of this.decisions(p.id))
      if (d.status === "pending" && !this.stillValid(p, d)) this.setStatus(p, d.idx, "dropped");
    for (const k of KINDS) {
      const doc = this.store.doc(p.owner_id, k);
      if (!doc) continue;
      const rest = this.decisions(p.id).filter((d) => d.doc === k && d.status === "pending");
      // The best case: every remaining decision that makes room — whatever the planner says leaves the document no
      // larger: deletes, shorter replaces, and merges (their lines become one, review #160 round 1).
      const now = this.sizeWith(doc, []);
      const shrinks = (d: DecisionRow) => {
        const after = this.sizeWith(doc, [opOf(d)]);
        return !!now && !!after && after.chars <= now.chars && after.bytes <= now.bytes;
      };
      const room = rest.filter(shrinks);
      for (const d of rest)
        if (!shrinks(d) && !this.fits(doc, [...room.map(opOf), opOf(d)])) this.setStatus(p, d.idx, "dropped");
    }
  }

  /** 반영 (spec §5). A document changed by anything else since the bundle was made → the whole bundle expires. */
  accept(id: string, userId: string, indexes: readonly number[]): MemoryProposal {
    const outcome = this.sql
      .transaction(() => {
        const p = this.owned(id, userId);
        const ds = this.decisions(id);
        const pending = [...new Set(indexes)].filter(
          (i) => ds.find((d) => d.idx === i)?.status === "pending",
        );
        if (!pending.length) return "closed" as const;
        try {
          this.applyIndexes(p, pending, "accepted");
          return "ok" as const;
        } catch (e) {
          if (!(e instanceof Expired)) throw e;
          // Thrown before anything was written: every pending decision of the bundle expires — a Dreaming bundle's
          // sources go to the re-processing queue for the next run (spec §5 "다시 정리할게요").
          this.requeue(p);
          this.sql
            .prepare(
              `update memory_proposal_decisions set status = 'expired', updated_at = ?
                where proposal_id = ? and status = 'pending'`,
            )
            .run(this.now(), id);
          return "expired" as const;
        }
      })
      .immediate();
    if (outcome === "expired") throw new ProposalError("proposal_expired", 409);
    if (outcome === "closed") throw new ProposalError("proposal_closed", 409);
    return this.view(id, userId);
  }

  /** 거절: those decisions are never applied (and never proposed again from this bundle). */
  reject(id: string, userId: string, indexes: readonly number[]): MemoryProposal {
    this.sql
      .transaction(() => {
        const p = this.owned(id, userId);
        const ds = this.decisions(id);
        const pending = [...new Set(indexes)].filter(
          (i) => ds.find((d) => d.idx === i)?.status === "pending",
        );
        if (!pending.length) throw new ProposalError("proposal_closed", 409);
        for (const i of pending) this.setStatus(p, i, "rejected");
        this.recheckRest(p);
      })
      .immediate();
    return this.view(id, userId);
  }

  /**
   * 되돌리기 (spec §5 자동 반영): each document this bundle changed goes back to the version before it — only while
   * what it applied is still the current version (otherwise 409: the version screen restores any version).
   */
  undo(id: string, userId: string): MemoryProposal {
    this.sql
      .transaction(() => {
        const p = this.owned(id, userId);
        const applied = JSON.parse(p.applied) as Applied;
        const base = JSON.parse(p.base) as Base;
        const kinds = Object.keys(applied) as MemoryListKind[];
        const ds = this.decisions(id);
        if (!kinds.length || !ds.some((d) => d.status === "applied" || d.status === "accepted"))
          throw new ProposalError("undo_unavailable", 409);
        for (const k of kinds) {
          const doc = this.store.doc(p.owner_id, k);
          if (!doc || doc.version !== applied[k]!.after) throw new ProposalError("undo_unavailable", 409);
        }
        for (const k of kinds) {
          const doc = this.store.doc(p.owner_id, k)!;
          const before = applied[k]!.before;
          const r = this.store.save({
            doc,
            content: "",
            author: "user",
            actorId: userId,
            base: doc.version,
            itemIds: before > 0 ? (this.store.version(doc.id, before)?.itemIds ?? []) : [],
            ...(before > 0 ? { restoredFrom: before } : {}),
          });
          base[k] = r.version.version;
        }
        for (const d of ds)
          if (d.status === "applied" || d.status === "accepted") this.setStatus(p, d.idx, "undone");
        this.sql
          .prepare("update memory_proposals set base = ?, applied = '{}', updated_at = ? where id = ?")
          .run(JSON.stringify(base), this.now(), id);
      })
      .immediate();
    return this.view(id, userId);
  }

  // ---- 기억 정리 bundles (#146, spec §5) ----

  /**
   * A Dreaming bundle that expired: the sources of its decisions still pending go to the re-processing queue, each for
   * its decision's document (spec §5) — only messages still in the active history (a deleted one has nothing to give,
   * §10.3). Rejected decisions are never queued (the same proposal must not come back). In the caller's transaction.
   */
  private requeue(p: ProposalRow): void {
    if (p.origin !== "dreaming") return;
    const ins = this.sql.prepare(
      `insert or ignore into dreaming_queue (user_id, message_id, doc, added_at)
         select ?, m.id, ?, ? from messages m where m.id = ? and m.active = 1`,
    );
    for (const d of this.decisions(p.id))
      if (d.status === "pending")
        for (const src of JSON.parse(d.sources) as ItemSource[])
          ins.run(p.owner_id, d.doc, this.now(), src.messageId);
  }

  /**
   * Stores a Dreaming run's bundle (#146) in the caller's transaction and applies at once the decisions `auto` names
   * (자동 반영: one version per document, author 기억 정리). Decisions are already checked (spec §4) — this is the same
   * card model as the conversation tool's, so 반영 / 거절 / 만료 / 되돌리기 behave the same. Returns the bundle's id
   * and how many decisions are applied and pending now.
   */
  createDreamingBundle(input: {
    ownerId: string;
    runId: string;
    mode: MemoryApplyMode;
    forced: ProposalRow["forced"];
    base: Base;
    decisions: {
      doc: MemoryListKind;
      action: "add" | "replace" | "delete" | "merge";
      itemId: string | null;
      mergeIds: string[] | null;
      text: string | null;
      before: string | null;
      sources: ItemSource[];
      targetSources: ItemSource[];
      auto: boolean;
    }[];
  }): { id: string; applied: number; pending: number; dropped: number } {
    const at = this.now();
    const id = crypto.randomUUID();
    this.sql
      .prepare(
        `insert into memory_proposals (id, owner_id, conversation_id, run_id, origin, mode, forced, base, applied,
           created_at, updated_at) values (?, ?, null, ?, 'dreaming', ?, ?, ?, '{}', ?, ?)`,
      )
      .run(id, input.ownerId, input.runId, input.mode, input.forced, JSON.stringify(input.base), at, at);
    const ins = this.sql.prepare(
      `insert into memory_proposal_decisions (proposal_id, idx, doc, action, item_id, merge_ids, text, before, sources,
         target_sources, sensitive, status, updated_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', ?)`,
    );
    input.decisions.forEach((d, i) =>
      ins.run(
        id,
        i,
        d.doc,
        d.action,
        d.itemId,
        d.mergeIds === null ? null : JSON.stringify(d.mergeIds),
        d.text === null ? null : scrubKnown(d.text),
        d.before === null ? null : scrubKnown(d.before),
        JSON.stringify(d.sources),
        JSON.stringify(d.targetSources),
        at,
      ),
    );
    const now = input.decisions.flatMap((d, i) => (d.auto ? [i] : []));
    if (now.length) this.applyIndexes(this.row(id)!, now, "applied");
    const st = this.decisions(id).map((d) => d.status);
    const count = (x: MemoryDecisionStatus) => st.filter((v) => v === x).length;
    return { id, applied: count("applied"), pending: count("pending"), dropped: count("dropped") };
  }

  /**
   * The list documents of the user that have a Dreaming decision waiting for review (spec §5: not touched) — leaving
   * out the bundles in `except` (those about to expire).
   */
  pendingDreamingDocs(userId: string, except: ReadonlySet<string> = new Set()): Set<MemoryListKind> {
    const rows = this.sql
      .prepare(
        `select distinct d.doc as doc, p.id as id from memory_proposal_decisions d
           join memory_proposals p on p.id = d.proposal_id
          where p.owner_id = ? and p.origin = 'dreaming' and d.status = 'pending'`,
      )
      .all(userId) as { doc: MemoryListKind; id: string }[];
    return new Set(rows.filter((r) => !except.has(r.id)).map((r) => r.doc));
  }

  /**
   * What the user already rejected from 기억 정리 (spec §5: never proposed again), as fingerprints — the document,
   * the action, the folded new line and the items it targets (`dreamingFingerprint`). A message queued again for
   * another reason (an expired sibling decision) therefore cannot bring a rejected change back (review #160).
   */
  rejectedDreaming(userId: string): Set<string> {
    const rows = this.sql
      .prepare(
        `select d.* from memory_proposal_decisions d join memory_proposals p on p.id = d.proposal_id
          where p.owner_id = ? and p.origin = 'dreaming' and d.status = 'rejected'`,
      )
      .all(userId) as DecisionRow[];
    return new Set(
      rows.map((d) =>
        dreamingFingerprint({
          doc: d.doc,
          action: d.action,
          text: d.text,
          targets: d.merge_ids ? (JSON.parse(d.merge_ids) as string[]) : d.item_id ? [d.item_id] : [],
        }),
      ),
    );
  }

  /** Dreaming bundles with decisions pending whose pinned documents changed since (they expire at the next run). */
  private staleRows(userId: string): ProposalRow[] {
    const rows = this.sql
      .prepare(
        `select * from memory_proposals p where p.owner_id = ? and p.origin = 'dreaming' and exists (
           select 1 from memory_proposal_decisions d where d.proposal_id = p.id and d.status = 'pending')`,
      )
      .all(userId) as ProposalRow[];
    return rows.filter((p) => {
      const base = JSON.parse(p.base) as Base;
      return KINDS.some(
        (k) => base[k] !== undefined && (this.store.doc(p.owner_id, k)?.version ?? 0) !== base[k],
      );
    });
  }

  /**
   * What `expireStaleDreaming` would do, without writing (review #160 round 1: a run that then fails must change
   * nothing): the bundles, and the sources their pending decisions would queue again, per document.
   */
  staleDreaming(userId: string): { ids: Set<string>; requeue: { messageId: string; doc: MemoryListKind }[] } {
    const rows = this.staleRows(userId);
    const requeue: { messageId: string; doc: MemoryListKind }[] = [];
    for (const p of rows)
      for (const d of this.decisions(p.id))
        if (d.status === "pending")
          for (const src of JSON.parse(d.sources) as ItemSource[])
            requeue.push({ messageId: src.messageId, doc: d.doc });
    return { ids: new Set(rows.map((p) => p.id)), requeue };
  }

  /**
   * Before a run (spec §5): every Dreaming bundle of the user with decisions still pending whose documents changed
   * since (a user edit, the conversation tool, a restore, the deletion linkage) expires now — its pending sources go to
   * the queue, so the run takes them up again instead of the document staying blocked. Returns how many expired.
   */
  expireStaleDreaming(userId: string): number {
    let n = 0;
    for (const p of this.staleRows(userId)) {
      this.requeue(p);
      this.sql
        .prepare(
          `update memory_proposal_decisions set status = 'expired', updated_at = ?
            where proposal_id = ? and status = 'pending'`,
        )
        .run(this.now(), p.id);
      n++;
    }
    return n;
  }

  /**
   * The user's Dreaming bundles for 설정 → 내 지침 → 제안 (owner only): those with something to decide, and those of
   * the last 7 days (an automatic change can still be undone there). Newest first.
   */
  listDreaming(userId: string, limit = 20): MemoryProposal[] {
    const since = this.now() - 7 * 86_400_000;
    const rows = this.sql
      .prepare(
        `select * from memory_proposals p where p.owner_id = ? and p.origin = 'dreaming'
           and (p.created_at >= ? or exists (select 1 from memory_proposal_decisions d
                                              where d.proposal_id = p.id and d.status = 'pending'))
         order by p.created_at desc limit ?`,
      )
      .all(userId, since, limit) as ProposalRow[];
    return rows.map((p) => this.viewOf(p));
  }

  // ---- deletion linkage (spec §10.3) ----

  /**
   * Inside the deletion linkage's transaction (spec §10.3): every decision — whatever its state — whose sources or
   * whose target item's sources include one of these messages (or any message of the conversation) is deleted, its
   * lines with it: what came from a deleted message stays nowhere, not even on a card in another conversation. A
   * bundle left without decisions goes too. Returns how many decisions went.
   */
  dropBySources(by: { conversationId: string } | { messageIds: readonly string[] }): number {
    const cites = (col: "sources" | "target_sources") =>
      "conversationId" in by
        ? `exists (select 1 from json_each(${col}) j where json_extract(j.value, '$.conversationId') = @c)`
        : `exists (select 1 from json_each(${col}) j
             where json_extract(j.value, '$.messageId') in (select value from json_each(@m)))`;
    if (!("conversationId" in by) && !by.messageIds.length) return 0;
    const params = "conversationId" in by ? { c: by.conversationId } : { m: JSON.stringify(by.messageIds) };
    const n = this.sql
      .prepare(
        `delete from memory_proposal_decisions where ${cites("sources")} or ${cites("target_sources")}`,
      )
      .run(params).changes;
    if (n)
      this.sql
        .prepare(
          `delete from memory_proposals where not exists (
             select 1 from memory_proposal_decisions d where d.proposal_id = memory_proposals.id)`,
        )
        .run();
    return n;
  }
}

class Expired extends Error {}

/** One change, as rejection memory compares it (the line folded like the checks read it). */
export function dreamingFingerprint(d: {
  doc: string;
  action: string;
  text: string | null;
  targets: readonly string[];
}): string {
  return JSON.stringify([
    d.doc,
    d.action,
    d.text === null ? null : foldForCheck(oneLine(d.text)),
    [...d.targets].sort(),
  ]);
}

/** What the store's planner needs of a decision. */
export type OpLike = {
  action: string;
  itemId: string | null;
  mergeIds?: string[] | null;
  text: string | null;
};

const opOf = (d: DecisionRow): OpLike => ({
  action: d.action,
  itemId: d.item_id,
  mergeIds: d.merge_ids === null ? null : (JSON.parse(d.merge_ids) as string[]),
  text: d.text,
});

export function toOp(d: OpLike, sources: ItemSource[] = []): ItemOp {
  if (d.action === "add") return { action: "add", text: d.text ?? "", sources };
  if (d.action === "merge")
    return { action: "merge", itemIds: d.mergeIds ?? [], text: d.text ?? "", sources };
  if (d.action === "replace") return { action: "replace", itemId: d.itemId!, text: d.text ?? "", sources };
  return { action: "delete", itemId: d.itemId! };
}
