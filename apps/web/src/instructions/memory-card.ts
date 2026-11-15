import {
  MEMORY_DOC_FILE,
  MemoryProposal,
  type MemoryDecision,
  type MemoryDecisionStatus,
  type PublicPart,
} from "@agentlee/shared";

/** A `memory_propose` call's tool name as each runtime reports it (bare, or `mcp__agentlee__…`). */
export const isMemoryTool = (name: string) => name === "memory_propose" || name.endsWith("__memory_propose");

/**
 * The cards of a reply (#145): the bundles its `memory_propose` calls made (a refused or failed call has none), in
 * order, each once. A shared viewer's parts carry no tool output, so they never get one.
 */
export function memoryProposalIds(parts: readonly PublicPart[]): string[] {
  const calls = new Set(parts.flatMap((p) => (p.type === "tool_call" && isMemoryTool(p.name) ? [p.id] : [])));
  const out: string[] = [];
  for (const p of parts) {
    if (p.type !== "tool_result" || !calls.has(p.callId) || p.isError) continue;
    const id = (p.output as { proposalId?: unknown } | null)?.proposalId;
    if (typeof id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

export const STATUS_LABEL: Record<MemoryDecisionStatus, string> = {
  pending: "확인 필요",
  accepted: "반영됨",
  applied: "기억했어요",
  rejected: "거절됨",
  expired: "만료됨",
  dropped: "빠짐",
  undone: "되돌림",
};
export const STATUS_BADGE: Record<MemoryDecisionStatus, string> = {
  pending: "",
  accepted: "ok",
  applied: "ok",
  rejected: "gray",
  expired: "warn",
  dropped: "gray",
  undone: "gray",
};
const ACTION_LABEL = { add: "추가", replace: "고침", delete: "지움", merge: "합침" } as const;

/** "MEMORY.md · 추가" */
export const decisionTitle = (d: Pick<MemoryDecision, "doc" | "action">) =>
  `${MEMORY_DOC_FILE[d.doc]} · ${ACTION_LABEL[d.action]}`;

/** The decision as a small diff: the line that goes (−) and the one that comes (+). */
export function decisionDiff(
  d: Pick<MemoryDecision, "action" | "text" | "before">,
): { op: "add" | "del"; text: string }[] {
  return [
    // A merge's lines (one per line) all go.
    ...(d.action !== "add" && d.before !== null
      ? d.before.split("\n").map((text) => ({ op: "del" as const, text }))
      : []),
    ...(d.action !== "delete" && d.text !== null ? [{ op: "add" as const, text: d.text }] : []),
  ];
}

/**
 * The card is gone (404): its source message — or the item it would change — was deleted (spec §10.3), and its lines
 * with it. Whatever was cached is not shown any more.
 */
export const cardGone = (e: unknown) =>
  !!e && typeof e === "object" && (e as { status?: unknown }).status === 404;

/** The card as it is now from a refused action's answer (409 carries it), or undefined. */
export function cardFromError(body: unknown): MemoryProposal | undefined {
  const r = MemoryProposal.safeParse((body as { proposal?: unknown } | null)?.proposal);
  return r.success ? r.data : undefined;
}

/** What the card says on top, from its decisions. */
export function cardSummary(
  p: Pick<MemoryProposal, "decisions" | "mode" | "forced"> & { origin?: MemoryProposal["origin"] },
): string | null {
  const ds = p.decisions;
  if (ds.some((d) => d.status === "expired"))
    return p.origin === "dreaming"
      ? "문서가 바뀌어 다시 정리할게요. 다음 기억 정리에서 이어 가요."
      : "문서가 바뀌어 반영하지 않았어요. 다시 요청해 주세요.";
  if (ds.some((d) => d.status === "pending") && p.forced === "suspicious")
    return "지시처럼 보이는 글이 든 메시지에서 나온 내용이라 자동 반영 대신 확인을 받아요.";
  if (ds.some((d) => d.status === "pending") && p.forced === "sensitive")
    return "민감한 내용이 있어 자동 반영 대신 확인을 받아요.";
  if (ds.some((d) => d.status === "pending") && p.forced === "external")
    return "웹·파일 같은 외부 자료를 읽은 답이라 자동 반영 대신 확인을 받아요.";
  return null;
}
