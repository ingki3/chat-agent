import { z } from "zod";

/**
 * 대화 중 기억해줘·잊어줘 (#145, PRD FR-16.4·16.7, docs/memory-spec.md §3–§5): the `memory_propose` tool's input, the
 * in-chat card, and the user setting "기억 반영 방식" (shared with Dreaming, #146).
 */

/** The list documents the conversation tool may change. */
export const MemoryListKind = z.enum(["user", "memory"]);
export type MemoryListKind = z.infer<typeof MemoryListKind>;

/** "기억 반영 방식" (spec §5): 검토 후 반영 (default) · 자동 반영 + 알림. */
export const MemoryApplyMode = z.enum(["review", "auto"]);
export type MemoryApplyMode = z.infer<typeof MemoryApplyMode>;
export const MEMORY_APPLY_MODE_LABEL: Record<MemoryApplyMode, string> = {
  review: "검토 후 반영",
  auto: "자동 반영 + 알림",
};
/** `locked`: a youth account — only the admin changes it (#188, sent only when true). */
export const MemoryPrefs = z.object({ applyMode: MemoryApplyMode, locked: z.literal(true).optional() });
export type MemoryPrefs = z.infer<typeof MemoryPrefs>;
export const SaveMemoryPrefsRequest = z.object({ applyMode: MemoryApplyMode }).strict();

/** One item's text as the tool may write it: one line (whitespace runs become one space), at most 500 characters. */
const ItemText = z.string().min(1).max(500);
/** The text as stored: one line. */
export const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const ItemId = z.string().min(1).max(64);
const MessageId = z.string().min(1).max(64);

/** One decision of `memory_propose` (spec §4 형식: add · replace · delete — `merge` is Dreaming's only). */
export const MemoryChangeInput = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), doc: MemoryListKind, text: ItemText }).strict(),
  z.object({ action: z.literal("replace"), itemId: ItemId, text: ItemText }).strict(),
  z.object({ action: z.literal("delete"), itemId: ItemId }).strict(),
]);
export type MemoryChangeInput = z.input<typeof MemoryChangeInput>;

export const MemoryProposeInput = z
  .object({
    changes: z.array(MemoryChangeInput).min(1).max(10),
    /**
     * The user messages of this conversation the request comes from (ids from `memory_list`). Absent: the message
     * this turn answers.
     */
    sourceMessageIds: z.array(MessageId).min(1).max(10).optional(),
    /** The model's own verdict that the content is a sensitive category (spec §4) — the card is then always shown. */
    sensitive: z.boolean().optional(),
  })
  .strict();
export type MemoryProposeInput = z.input<typeof MemoryProposeInput>;

export const MemoryListInput = z.object({}).strict();

/** Why a decision was left out (spec §4 — counts only, never the text). */
export const MEMORY_REFUSAL_KINDS = ["source", "secret_value", "rule_change", "size", "unchanged"] as const;
export type MemoryRefusalKind = (typeof MEMORY_REFUSAL_KINDS)[number];

/** A decision's state on the card. */
export const MemoryDecisionStatus = z.enum([
  /** waiting for 반영 / 거절 (검토 후 반영, or a sensitive one) */
  "pending",
  /** applied by the user's 반영 */
  "accepted",
  /** applied at once (자동 반영) */
  "applied",
  "rejected",
  /** the document changed meanwhile (spec §5): "다시 요청해 주세요" */
  "expired",
  /** left out on a re-check, or its source message was deleted (spec §10.3) */
  "dropped",
  /** taken back with 되돌리기 */
  "undone",
]);
export type MemoryDecisionStatus = z.infer<typeof MemoryDecisionStatus>;

export const MemoryDecision = z.object({
  index: z.number().int().nonnegative(),
  doc: MemoryListKind,
  /** `merge` comes from 기억 정리 only (#146): several items become one line. */
  action: z.enum(["add", "replace", "delete", "merge"]),
  /** The new line (add, replace, merge). */
  text: z.string().nullable(),
  /** The line it replaces or deletes, as it was when proposed — a merge's lines, one per line. */
  before: z.string().nullable(),
  /** A sensitive category (spec §4): always confirmed on the card. */
  sensitive: z.boolean(),
  status: MemoryDecisionStatus,
});
export type MemoryDecision = z.infer<typeof MemoryDecision>;

/** `GET /api/memory-proposals/:id`: the card (the owner's only — anyone else 403). */
export const MemoryProposal = z.object({
  id: z.string(),
  /** The conversation of a `memory_propose` card; null for a 기억 정리 bundle (#146). */
  conversationId: z.string().nullable(),
  /** Who proposed it: the conversation tool (the card under the reply) or 기억 정리 (설정 → 내 지침 → 제안). */
  origin: z.enum(["tool", "dreaming"]),
  /** The setting when it was made. */
  mode: MemoryApplyMode,
  /**
   * Why some decisions wait for the card in 자동 반영: a sensitive category, the answer read outside content, or (기억
   * 정리) a source message that itself reads like an instruction to the assistant (pasted text, spec §3.5).
   */
  forced: z.enum(["sensitive", "external", "suspicious"]).nullable(),
  decisions: z.array(MemoryDecision),
  /** 되돌리기 is possible: what this card applied is still the current document. */
  canUndo: z.boolean(),
  createdAt: z.number(),
});
export type MemoryProposal = z.infer<typeof MemoryProposal>;

export const MemoryDecisionsRequest = z
  .object({ indexes: z.array(z.number().int().nonnegative()).min(1).max(50) })
  .strict();
export type MemoryDecisionsRequest = z.infer<typeof MemoryDecisionsRequest>;

/** Refusals of the card's actions. */
export const MEMORY_PROPOSAL_ERRORS = {
  proposal_expired: "문서가 바뀌어 반영하지 않았어요. 다시 요청해 주세요.",
  proposal_closed: "이미 처리한 제안이에요.",
  undo_unavailable: "그 뒤에 문서가 바뀌어 되돌릴 수 없어요. 설정 → 내 지침의 버전에서 되돌려 주세요.",
} as const;

/** The tool's outcome codes (logged; fixed set). */
export const MEMORY_TOOL_CODES = [
  "memory_ok",
  "memory_bad_input",
  "memory_unknown_item",
  "memory_not_allowed",
  "memory_refused",
] as const;
