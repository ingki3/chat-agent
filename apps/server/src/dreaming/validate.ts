import { DREAMING_MAX_LOSS, oneLine, type DreamingRefusalKind, type MemoryListKind } from "@agentlee/shared";
import { holdsSecret, isSensitive, triesRuleChange } from "../memory/rules.js";
import type { OpLike } from "../memory/proposals.js";
import type { DocRow, Item, ItemSource } from "../memory/store.js";
import type { InputMessage } from "./input.js";
import type { RawDecision } from "./prompt.js";

/**
 * The server's fixed checks on a 기억 정리 run's decisions (#146, docs/memory-spec.md §4, "기억 정리" column), each
 * with its refusal unit:
 * - 형식 (the whole run): unreadable output, an unknown action, an item reference that names no current item of an
 *   editable document, an item named by two decisions, a merge across documents → `undefined` (nothing is applied);
 * - 출처 · 비밀 값 · 규칙 바꾸기 · 민감 범주 · 변화 없음 (that decision);
 * - 손실률 over 25% · 크기 (all of that document's decisions).
 * The admin cannot change any of it. Counts only come back for the record — never the text.
 */

export type DocCtx = { kind: MemoryListKind; doc: DocRow; items: Item[]; editable: boolean };

export type Checked = {
  doc: MemoryListKind;
  action: "add" | "replace" | "delete" | "merge";
  itemId: string | null;
  mergeIds: string[] | null;
  text: string | null;
  /** The line(s) that go (a merge's, one per line). */
  before: string | null;
  sources: (ItemSource & { range?: { from: number; to: number } })[];
  targetSources: ItemSource[];
  /** A source message reads like an instruction to the assistant: never applied without review (spec §3.5). */
  suspicious: boolean;
};

export type CheckResult =
  { ok: false } | { ok: true; decisions: Checked[]; refused: Partial<Record<DreamingRefusalKind, number>> };

/** Item references as the model sees them: `user-1`, `memory-3`, … in document order. */
export const itemRef = (kind: MemoryListKind, i: number) => `${kind}-${i + 1}`;

export function checkDecisions(
  raw: readonly RawDecision[],
  ctx: {
    docs: readonly DocCtx[];
    messages: readonly InputMessage[];
    /** Whether the document stays within its cap with these decisions (MemoryProposals.fits). */
    fits: (doc: DocRow, ops: readonly OpLike[]) => boolean;
  },
): CheckResult {
  const byKind = new Map(ctx.docs.map((d) => [d.kind, d]));
  const refs = new Map<string, { kind: MemoryListKind; item: Item }>();
  for (const d of ctx.docs)
    if (d.editable) d.items.forEach((item, i) => refs.set(itemRef(d.kind, i), { kind: d.kind, item }));
  const msgs = new Map(ctx.messages.map((m) => [m.ref, m]));
  const refused: Partial<Record<DreamingRefusalKind, number>> = {};
  const refuse = (k: DreamingRefusalKind, n = 1) => (refused[k] = (refused[k] ?? 0) + n);

  // 형식 (whole run): every reference resolves, no item twice.
  const targeted = new Set<string>();
  type Planned = Omit<Checked, "sources" | "suspicious"> & { raw: RawDecision };
  const planned: Planned[] = [];
  for (const d of raw) {
    if (d.action === "add") {
      planned.push({
        raw: d,
        doc: d.doc,
        action: "add",
        itemId: null,
        mergeIds: null,
        text: oneLine(d.text),
        before: null,
        targetSources: [],
      });
      continue;
    }
    const names = d.action === "merge" ? d.items : [d.item];
    const found = names.map((n) => refs.get(n));
    if (found.some((f) => !f)) return { ok: false };
    const kinds = new Set(found.map((f) => f!.kind));
    if (kinds.size !== 1) return { ok: false };
    for (const f of found) {
      if (targeted.has(f!.item.id)) return { ok: false };
      targeted.add(f!.item.id);
    }
    const kind = found[0]!.kind;
    planned.push({
      raw: d,
      doc: kind,
      action: d.action,
      itemId: d.action === "merge" ? null : found[0]!.item.id,
      mergeIds: d.action === "merge" ? found.map((f) => f!.item.id) : null,
      text: d.action === "delete" ? null : oneLine(d.text),
      before: found.map((f) => f!.item.text).join("\n"),
      targetSources: found.flatMap((f) => f!.item.sources),
    });
  }

  // That decision: blocked document, sources, secret, rule change, sensitive, unchanged.
  const kept: Checked[] = [];
  for (const p of planned) {
    const doc = byKind.get(p.doc);
    if (!doc?.editable) {
      refuse("blocked");
      continue;
    }
    const srcs = [...new Set(p.raw.sources)].map((r) => msgs.get(r));
    if (!srcs.length || srcs.some((m) => !m || !m.docs.has(p.doc))) {
      refuse("source");
      continue;
    }
    const text = p.text;
    if (text !== null && holdsSecret(text)) {
      refuse("secret_value");
      continue;
    }
    const flags = p.raw.flags ?? [];
    if ((text !== null && triesRuleChange(text)) || flags.includes("rule_change")) {
      refuse("rule_change");
      continue;
    }
    if (
      flags.includes("sensitive") ||
      (text !== null && isSensitive(text)) ||
      (p.before !== null && isSensitive(p.before))
    ) {
      refuse("sensitive");
      continue;
    }
    if (
      (p.action === "replace" && text === p.before) ||
      (p.action === "add" &&
        (doc.items.some((i) => i.text === text) ||
          kept.some((k) => k.doc === p.doc && k.action === "add" && k.text === text)))
    ) {
      refuse("unchanged");
      continue;
    }
    kept.push({
      doc: p.doc,
      action: p.action,
      itemId: p.itemId,
      mergeIds: p.mergeIds,
      text: p.text,
      before: p.before,
      targetSources: p.targetSources,
      sources: srcs.map((m) => ({ ...m!.source, ...(m!.range ? { range: m!.range } : {}) })),
      suspicious: srcs.some((m) => m!.suspicious),
    });
  }

  // The document's decisions: loss rate, then size. What is kept stays in the model's order.
  const out = new Set<MemoryListKind>();
  for (const d of ctx.docs) {
    const mine = kept.filter((k) => k.doc === d.kind);
    if (!mine.length) continue;
    if (lossRate(d.items.length, mine) > DREAMING_MAX_LOSS) {
      refuse("loss", mine.length);
      out.add(d.kind);
      continue;
    }
    if (!ctx.fits(d.doc, mine.map(opLike))) {
      refuse("size", mine.length);
      out.add(d.kind);
    }
  }
  return { ok: true, decisions: kept.filter((k) => !out.has(k.doc)), refused };
}

/**
 * Loss rate (spec §4) = (existing items that go by delete or replace + items whose text goes into a merge − new items
 * a merge makes) ÷ existing items; nothing to lose (no items) is not checked. 25% passes; above it is refused.
 */
export function lossRate(existing: number, ds: readonly Pick<Checked, "action" | "mergeIds">[]): number {
  if (existing === 0) return 0;
  let lost = 0;
  for (const d of ds) {
    if (d.action === "delete" || d.action === "replace") lost += 1;
    else if (d.action === "merge") lost += (d.mergeIds?.length ?? 0) - 1;
  }
  return lost / existing;
}

export const opLike = (c: Pick<Checked, "action" | "itemId" | "mergeIds" | "text">): OpLike => ({
  action: c.action,
  itemId: c.itemId,
  mergeIds: c.mergeIds,
  text: c.text,
});
