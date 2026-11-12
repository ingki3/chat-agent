import { describe, expect, it } from "vitest";
import type { ChatSettings, RuntimeOption } from "@agentlee/shared";
import {
  applyChange,
  canChooseShared,
  chipLabel,
  differs,
  runtimeLimit,
  noticeText,
  takeFallbackNotice,
  withoutNotice,
} from "../src/chat/chip.js";

const conn = (scope: "personal" | "shared") => ({
  id: scope,
  runtime: "claude-code" as const,
  authType: "api_key" as const,
  scope,
  ownerId: scope === "personal" ? "u" : null,
  label: scope,
  hint: null,
  accountEmail: null,
  status: "passed" as const,
  lastTestAt: null,
  lastTestCode: null,
  limitedUntil: null as number | null,
  registeredByAdmin: false,
  createdAt: 0,
});
const options = [
  {
    runtime: "claude-code",
    needsConnection: true,
    connections: [conn("personal"), conn("shared")],
    models: [
      { id: "claude-opus-5-5", label: "Opus 5.5", efforts: ["low", "high"], defaultEffort: "high" },
      { id: "claude-haiku-5-5", label: "Haiku 5.5", efforts: [], defaultEffort: null },
    ],
  },
  {
    runtime: "codex",
    needsConnection: true,
    connections: [],
    models: [
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", efforts: ["low", "max"], defaultEffort: "low" },
      { id: "gpt-6-luna", label: "GPT-6 Luna", efforts: ["medium", "max"], defaultEffort: "medium" },
    ],
  },
] as unknown as RuntimeOption[];
const opus: ChatSettings = {
  runtime: "claude-code",
  model: "claude-opus-5-5",
  effort: "high",
  useShared: true,
};

describe("the chip's label and choices (#19)", () => {
  it("names the runtime and the model's label", () => {
    expect(chipLabel(opus, options)).toBe("Claude Code · Opus 5.5");
    expect(chipLabel({ runtime: "codex", model: "x" }, options)).toBe("Codex · x");
    expect(chipLabel(null)).toBe("쓸 수 있는 런타임 없음");
  });
  it("offers 공용으로 쓰기 only with both a personal and a shared connection", () => {
    expect(canChooseShared(options[0])).toBe(true);
    expect(canChooseShared({ ...options[0]!, connections: [conn("shared")] })).toBe(false);
    expect(canChooseShared(options[1])).toBe(false);
  });
  it("says when the next reply differs from the last one", () => {
    expect(differs(opus, { runtime: "claude-code", model: "claude-opus-5-5", effort: "high" })).toBe(false);
    expect(differs(opus, { runtime: "claude-code", model: "claude-opus-5-5", effort: "low" })).toBe(true);
    expect(differs(opus, undefined)).toBe(false);
  });
});

describe("applyChange mirrors the server's rules on the new-conversation screen", () => {
  const defaults = {
    runtime: "claude-code" as const,
    models: { codex: { model: "gpt-6-luna", effort: "max" } },
  };
  it("runtime only → that runtime's saved default model and effort, else its first model; 공용 resets", () => {
    expect(applyChange(opus, { runtime: "codex" }, options, defaults)).toEqual({
      runtime: "codex",
      model: "gpt-6-luna",
      effort: "max",
      useShared: false,
    });
    expect(applyChange(opus, { runtime: "codex" }, options, undefined)).toMatchObject({
      model: "gpt-6.1-sol",
      effort: "low",
    });
  });
  it("model only → that model's default effort; an effort it does not take → null (refused)", () => {
    expect(applyChange(opus, { model: "claude-haiku-5-5" }, options, defaults)).toMatchObject({
      effort: null,
    });
    expect(applyChange(opus, { effort: "low" }, options, defaults)).toMatchObject({ effort: "low" });
    expect(applyChange(opus, { effort: "max" }, options, defaults)).toBeNull();
    expect(applyChange(opus, { model: "nope" }, options, defaults)).toBeNull();
  });
});

describe("the fallback notice on the page (review #101)", () => {
  it("shows only what the server handed out; a failed consume shows nothing", async () => {
    const n = { runtime: "codex", model: "gpt-6-luna" };
    expect(await takeFallbackNotice(async () => n)).toBe(n);
    expect(await takeFallbackNotice(async () => null)).toBeNull();
    expect(await takeFallbackNotice(() => Promise.reject(new Error("offline")))).toBeNull();
    expect(noticeText(n, options)).toBe("기본값을 쓸 수 없어 Codex · GPT-6 Luna로 시작했어요");
  });
  it("clears only the notice field of the cached conversation (a newer chip change stays)", () => {
    const newer = {
      id: "c",
      settings: { ...opus, model: "claude-haiku-5-5" },
      fallbackNotice: { runtime: "codex" },
    };
    expect(withoutNotice(newer)).toEqual({ ...newer, fallbackNotice: null });
  });
});

describe("usage limits in the chip (review #101)", () => {
  const now = 1_000_000;
  const opt = (personal: number | null | undefined, shared: number | null | undefined) =>
    ({
      ...options[0]!,
      connections: [
        ...(personal === undefined ? [] : [{ ...conn("personal"), limitedUntil: personal }]),
        ...(shared === undefined ? [] : [{ ...conn("shared"), limitedUntil: shared }]),
      ],
    }) as RuntimeOption;
  it("blocks a runtime whose connections are all at their limit; an expired limit does not count", () => {
    expect(runtimeLimit(opt(now + 10, undefined), now)).toEqual({
      blocked: true,
      viaShared: false,
      until: now + 10,
    });
    expect(runtimeLimit(opt(now + 10, now + 20), now)).toMatchObject({ blocked: true, until: now + 10 });
    expect(runtimeLimit(opt(now - 1, undefined), now)).toEqual({
      blocked: false,
      viaShared: false,
      until: null,
    });
    expect(runtimeLimit(opt(null, undefined), now).blocked).toBe(false);
  });
  it("only the personal one limited: switch via 공용으로 쓰기 instead", () => {
    expect(runtimeLimit(opt(now + 10, null), now)).toEqual({
      blocked: false,
      viaShared: true,
      until: now + 10,
    });
    // Shared limited but personal free: the run takes the personal one anyway.
    expect(runtimeLimit(opt(null, now + 10), now)).toMatchObject({ blocked: false, viaShared: false });
  });
});
