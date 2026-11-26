import { describe, expect, it } from "vitest";
import { isVideoTool, videoJobIds, videoPollMs } from "../src/chat/video-card.js";

describe("video card (#238 stage 3)", () => {
  it("finds the cards of a reply's video_generate calls (each once, never a refused call's)", () => {
    const parts = [
      { type: "tool_call", id: "c1", name: "mcp__agentlee__video_generate", input: {} },
      { type: "tool_result", callId: "c1", output: { jobId: "job-1" }, isError: false },
      { type: "tool_call", id: "c2", name: "video_generate", input: {} },
      { type: "tool_result", callId: "c2", output: { jobId: "job-2" }, isError: true },
      { type: "tool_call", id: "c3", name: "image_generate", input: {} },
      { type: "tool_result", callId: "c3", output: { jobId: "job-3" }, isError: false },
    ] as unknown as Parameters<typeof videoJobIds>[0];
    expect(videoJobIds(parts)).toEqual(["job-1"]);
    expect(isVideoTool("video_generate")).toBe(true);
  });

  it("review r1: polls without EventSource (or after the stream failed), waiting cards now and then, ended never", () => {
    expect(videoPollMs("pending", false, false)).toBe(5000);
    expect(videoPollMs("in_progress", true, true)).toBe(5000);
    expect(videoPollMs("downloading", false, true)).toBe(false);
    expect(videoPollMs("awaiting_approval", false, true)).toBe(30_000);
    for (const s of ["done", "failed", "expired", "dismissed"] as const)
      expect(videoPollMs(s, true, false)).toBe(false);
    expect(videoPollMs(undefined, false, false)).toBe(false);
  });
});
