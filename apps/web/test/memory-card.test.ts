import { describe, expect, it } from "vitest";
import type { MemoryProposal, PublicPart } from "@agentlee/shared";
import {
  cardFromError,
  cardGone,
  cardSummary,
  decisionDiff,
  decisionTitle,
  isMemoryTool,
  memoryProposalIds,
} from "../src/instructions/memory-card.js";

/** The in-chat card of `memory_propose` (#145): which replies get one, and what it says. */
describe("memory card (#145)", () => {
  const id = "0f1e2d3c-4b5a-4968-8776-655443322110";
  it("finds the bundles of a reply's memory_propose calls — not a failed or refused one, not a shared viewer's", () => {
    const parts: PublicPart[] = [
      { type: "tool_call", id: "c1", name: "mcp__agentlee__memory_propose", input: {} },
      { type: "tool_result", callId: "c1", output: { proposalId: id, status: "pending" } },
      { type: "tool_call", id: "c2", name: "memory_propose", input: {} },
      { type: "tool_result", callId: "c2", output: { error: "memory_unknown_item" }, isError: true },
      { type: "tool_call", id: "c3", name: "memory_propose", input: {} },
      { type: "tool_result", callId: "c3", output: { proposalId: null, status: "refused" } },
      { type: "tool_call", id: "c4", name: "schedule_create", input: {} },
      { type: "tool_result", callId: "c4", output: { proposalId: "other" } },
      // A shared viewer's projection: the output is gone.
      { type: "tool_call", id: "c5", name: "memory_propose", input: {} },
      { type: "tool_result", callId: "c5", output: null },
    ];
    expect(memoryProposalIds(parts)).toEqual([id]);
    expect(isMemoryTool("mcp__agentlee__memory_propose")).toBe(true);
    expect(isMemoryTool("memory_list")).toBe(false);
  });

  it("shows each decision as a small diff with its document and action", () => {
    expect(decisionTitle({ doc: "memory", action: "add" })).toBe("MEMORY.md · 추가");
    expect(decisionTitle({ doc: "user", action: "delete" })).toBe("USER.md · 지움");
    expect(decisionDiff({ action: "add", text: "새 줄", before: null })).toEqual([
      { op: "add", text: "새 줄" },
    ]);
    expect(decisionDiff({ action: "replace", text: "새", before: "옛" })).toEqual([
      { op: "del", text: "옛" },
      { op: "add", text: "새" },
    ]);
    expect(decisionDiff({ action: "delete", text: null, before: "옛" })).toEqual([{ op: "del", text: "옛" }]);
  });

  it("says why it waits, or that it expired; reads the card back from a 409", () => {
    const d = (status: MemoryProposal["decisions"][number]["status"]) => ({
      index: 0,
      doc: "memory" as const,
      action: "add" as const,
      text: "x",
      before: null,
      sensitive: false,
      status,
    });
    expect(cardSummary({ mode: "review", forced: null, decisions: [d("expired")] })).toContain(
      "다시 요청해 주세요",
    );
    expect(cardSummary({ mode: "auto", forced: "sensitive", decisions: [d("pending")] })).toContain(
      "민감한 내용",
    );
    expect(cardSummary({ mode: "auto", forced: "external", decisions: [d("pending")] })).toContain(
      "외부 자료",
    );
    expect(cardSummary({ mode: "review", forced: null, decisions: [d("pending")] })).toBeNull();
    const card: MemoryProposal = {
      id,
      conversationId: "c",
      mode: "review",
      forced: null,
      decisions: [d("expired")],
      canUndo: false,
      createdAt: 1,
    };
    expect(cardFromError({ error: "proposal_expired", proposal: card })).toEqual(card);
    expect(cardFromError({ error: "forbidden" })).toBeUndefined();
  });

  it("a 404 (its source was deleted, spec §10.3) means gone — the cached lines are not shown any more", () => {
    expect(cardGone({ status: 404, code: "not_found" })).toBe(true);
    expect(cardGone({ status: 409, code: "proposal_expired" })).toBe(false);
    expect(cardGone({ status: 403 })).toBe(false);
    expect(cardGone(null)).toBe(false);
    expect(cardGone(new Error("network"))).toBe(false);
  });
});
