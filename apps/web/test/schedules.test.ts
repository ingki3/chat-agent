import { describe, expect, it } from "vitest";
import type { PublicPart } from "@agentlee/shared";
import { costText, isScheduleTool, proposalIds, timingText, whenText } from "../src/schedules/format.js";

describe("schedule screen text (#55)", () => {
  it("reads each timing in Korean", () => {
    expect(timingText({ type: "daily", time: "08:00" })).toBe("매일 08:00");
    expect(timingText({ type: "weekdays", time: "07:30" })).toBe("평일(월–금) 07:30");
    expect(timingText({ type: "weekly", time: "09:00", weekdays: [3, 1] })).toBe("매주 월·수 09:00");
    expect(timingText({ type: "once", date: "2026-12-01", time: "08:00" })).toBe("한 번 · 2026-12-01 08:00");
    expect(timingText({ type: "cron", cron: "0 8 * * 1-5" })).toBe("cron 0 8 * * 1-5");
  });

  it("shows a moment in the schedule's own zone, and a cost only when one is known", () => {
    // 2026-11-12 23:00 UTC = 11월 13일 (금) 오전 8:00 in Seoul
    const t = Date.UTC(2026, 10, 12, 23);
    expect(whenText(t, "Asia/Seoul")).toContain("8:00");
    expect(whenText(t, "Asia/Seoul")).toContain("13일");
    expect(whenText(t, "America/New_York")).toContain("12일");
    expect(costText(null)).toBe("—");
    expect(costText(0.01235)).toBe("$0.0124");
    expect(costText(1.5)).toBe("$1.50");
  });

  it("finds the confirmation cards of a reply: successful schedule_create results only, each once", () => {
    expect(isScheduleTool("schedule_create")).toBe(true);
    expect(isScheduleTool("mcp__agentlee__schedule_create")).toBe(true);
    expect(isScheduleTool("artifact_create")).toBe(false);
    const parts: PublicPart[] = [
      { type: "tool_call", id: "a", name: "mcp__agentlee__schedule_create", input: {} },
      { type: "tool_result", callId: "a", output: { proposalId: "p-1", status: "proposed" } },
      { type: "tool_call", id: "b", name: "schedule_create", input: {} },
      { type: "tool_result", callId: "b", output: { error: "schedule_in_past" }, isError: true },
      // another tool that happens to answer with the same field is not a card
      { type: "tool_call", id: "c", name: "web_search", input: {} },
      { type: "tool_result", callId: "c", output: { proposalId: "p-2" } },
      { type: "tool_call", id: "d", name: "schedule_create", input: {} },
      { type: "tool_result", callId: "d", output: { proposalId: "p-1" } },
      { type: "tool_call", id: "e", name: "schedule_create", input: {} },
      { type: "tool_result", callId: "e", output: { proposalId: "../../x" } },
    ];
    expect(proposalIds(parts)).toEqual(["p-1"]);
  });
});
