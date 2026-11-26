import { describe, expect, it } from "vitest";
import { composeReadinessPollMs } from "../src/admin/media-cache.js";
import type { ComposeJob } from "@agentlee/shared";
import {
  composeJobIds,
  composePollMs,
  durationText,
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

  it("review r1: the admin screen reads the status again while the composition's readiness is unknown", () => {
    expect(composeReadinessPollMs({ ready: null })).toBe(3000);
    expect(composeReadinessPollMs({ ready: true })).toBe(false);
    expect(composeReadinessPollMs({ ready: false })).toBe(false);
    expect(composeReadinessPollMs(undefined)).toBe(false);
  });

  it("review r5: an ended job without a known length never says '계산 중'", () => {
    expect(durationText({ durationSec: 0, status: "queued" })).toBe("계산 중");
    expect(durationText({ durationSec: 0, status: "failed" })).toBe("확인할 수 없음");
    expect(durationText({ durationSec: 2, status: "failed" })).toBe("2초");
  });

  it("review r8: a one-frame video is not '0초'; minutes come from the rounded whole length", () => {
    expect(secondsText(0.033)).toBe("0.1초 미만");
    expect(secondsText(0.049)).toBe("0.1초 미만");
    expect(secondsText(0.05)).toBe("0.1초");
    expect(secondsText(0)).toBe("0초");
    expect(secondsText(12.46)).toBe("12.5초");
    expect(secondsText(59.94)).toBe("59.9초");
    expect(secondsText(59.96)).toBe("1분");
    expect(secondsText(119.6)).toBe("2분");
    expect(secondsText(119.4)).toBe("1분 59초");
    expect(secondsText(89.5)).toBe("1분 30초");
    expect(durationText({ durationSec: 1 / 30, status: "done" })).toBe("0.1초 미만");
  });
});
