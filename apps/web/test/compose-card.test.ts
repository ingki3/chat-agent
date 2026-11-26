import { describe, expect, it } from "vitest";
import type { ComposeJob } from "@agentlee/shared";
import {
  composeJobIds,
  composePollMs,
  isComposeTool,
  newestComposeJob,
  secondsText,
} from "../src/chat/compose-card.js";

describe("compose card (#238 stage 4)", () => {
  it("finds the jobs of a reply's compose_video calls by the call's id (each once, never a refused call's)", () => {
    const parts = [
      { type: "tool_call", id: "c1", name: "mcp__agentlee__compose_video", input: {} },
      { type: "tool_result", callId: "c1", output: { jobId: "job-1" }, isError: false },
      { type: "tool_result", callId: "c1", output: { jobId: "job-1" }, isError: false },
      { type: "tool_call", id: "c2", name: "compose_video", input: {} },
      { type: "tool_result", callId: "c2", output: { jobId: "job-2" }, isError: true },
      { type: "tool_call", id: "c3", name: "video_generate", input: {} },
      { type: "tool_result", callId: "c3", output: { jobId: "job-3" }, isError: false },
      { type: "tool_result", callId: "c9", output: { jobId: "job-9" }, isError: false },
    ] as unknown as Parameters<typeof composeJobIds>[0];
    expect(composeJobIds(parts)).toEqual(["job-1"]);
    expect(isComposeTool("compose_video")).toBe(true);
    expect(isComposeTool("compose_videos")).toBe(false);
  });

  it("keeps the newer state; polls only without a live stream and never once ended", () => {
    const a = { version: 3 } as ComposeJob;
    const b = { version: 2 } as ComposeJob;
    expect(newestComposeJob(a, b)).toBe(a);
    expect(newestComposeJob(b, a)).toBe(a);
    expect(newestComposeJob(undefined, b)).toBe(b);
    expect(composePollMs("queued", false, false)).toBe(3000);
    expect(composePollMs("running", true, true)).toBe(3000);
    expect(composePollMs("running", false, true)).toBe(false);
    expect(composePollMs("done", true, false)).toBe(false);
    expect(composePollMs("failed", true, false)).toBe(false);
    expect(secondsText(2)).toBe("2초");
    expect(secondsText(80)).toBe("1분 20초");
    expect(secondsText(300)).toBe("5분");
  });
});
