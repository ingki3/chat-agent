import { describe, expect, it } from "vitest";
import type { ChatSettings, RuntimeOption } from "@agentlee/shared";
import {
  ChipChoice,
  canChooseShared,
  chipLabel,
  differs,
  modelLimit,
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
  limits: [] as { scope: string; until: number }[],
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
  type L = { scope: string; until: number }[];
  const opt = (personal: L | undefined, shared: L | undefined) =>
    ({
      ...options[0]!,
      connections: [
        ...(personal === undefined ? [] : [{ ...conn("personal"), limits: personal }]),
        ...(shared === undefined ? [] : [{ ...conn("shared"), limits: shared }]),
      ],
    }) as RuntimeOption;
  const all = (until: number) => [{ scope: "all", until }];
  it("a connection-wide limit blocks every model; an expired one does not count", () => {
    expect(runtimeLimit(opt(all(now + 10), undefined), now)).toEqual({
      blocked: true,
      viaShared: false,
      until: now + 10,
    });
    expect(runtimeLimit(opt(all(now - 1), undefined), now)).toEqual({
      blocked: false,
      viaShared: false,
      until: null,
    });
  });
  it("an Opus-only limit blocks Opus, not Haiku — so the runtime stays usable", () => {
    const o = opt([{ scope: "family:opus", until: now + 10 }], undefined);
    expect(modelLimit(o, "claude-opus-5-5", now)).toMatchObject({ blocked: true, until: now + 10 });
    expect(modelLimit(o, "claude-haiku-5-5", now)).toEqual({ blocked: false, viaShared: false, until: null });
    expect(runtimeLimit(o, now).blocked).toBe(false);
    // An API key's per-model limit: only that model.
    const m = opt([{ scope: "model:claude-haiku-5-5", until: now + 10 }], undefined);
    expect(modelLimit(m, "claude-haiku-5-5", now).blocked).toBe(true);
    expect(modelLimit(m, "claude-opus-5-5", now).blocked).toBe(false);
  });
  it("only the personal one limited: switch via 공용으로 쓰기 instead", () => {
    expect(runtimeLimit(opt(all(now + 10), []), now)).toEqual({
      blocked: false,
      viaShared: true,
      until: now + 10,
    });
    // Shared limited but personal free: the run takes the personal one anyway.
    expect(runtimeLimit(opt([], all(now + 10)), now)).toMatchObject({ blocked: false, viaShared: false });
  });
  it("the notice names a usage limit as the cause and when it ends", () => {
    expect(noticeText({ runtime: "codex", model: "gpt-6-luna", limitedUntil: now }, options)).toMatch(
      /^기본값을 쓸 수 없어 Codex · GPT-6 Luna로 시작했어요 \(사용 한도 · .+ 이후 다시 쓸 수 있어요\)$/,
    );
  });
});

describe("ChipChoice: a send waits for the preview (review #101 4차)", () => {
  type S = { runtime: string; model: string };
  const start: S = { runtime: "claude-code", model: "claude-opus-5-5" };
  /** A preview the test resolves by hand. */
  const manual = () => {
    const calls: { base: S; change: object; resolve: (s: S) => void; reject: (e: unknown) => void }[] = [];
    const preview = (base: S, change: object) =>
      new Promise<S>((resolve, reject) => calls.push({ base, change, resolve, reject }));
    return { calls, preview };
  };

  it("nothing chosen: null at once (the server's start settings)", async () => {
    expect(await new ChipChoice<S>(async () => start).settled()).toBeNull();
  });

  it("a send made while the preview is pending gets the previewed settings, not the old ones", async () => {
    const m = manual();
    const c = new ChipChoice<S>(m.preview);
    void c.change(start, { runtime: "codex" });
    let sent: S | null | undefined;
    const send = c.settled().then((s) => (sent = s));
    await Promise.resolve();
    expect(sent).toBeUndefined(); // still waiting
    await new Promise((r) => setTimeout(r, 0));
    m.calls[0]!.resolve({ runtime: "codex", model: "gpt-6.1-sol" });
    await send;
    expect(sent).toEqual({ runtime: "codex", model: "gpt-6.1-sol" });
  });

  it("changes are previewed in order, each on the previous result", async () => {
    const m = manual();
    const c = new ChipChoice<S>(m.preview);
    void c.change(start, { runtime: "codex" });
    void c.change(start, { model: "gpt-6-luna" });
    const done = c.settled();
    await new Promise((r) => setTimeout(r, 0));
    expect(m.calls).toHaveLength(1);
    m.calls[0]!.resolve({ runtime: "codex", model: "gpt-6.1-sol" });
    await new Promise((r) => setTimeout(r, 0));
    expect(m.calls[1]!.base).toEqual({ runtime: "codex", model: "gpt-6.1-sol" });
    m.calls[1]!.resolve({ runtime: "codex", model: "gpt-6-luna" });
    expect(await done).toEqual({ runtime: "codex", model: "gpt-6-luna" });
  });

  it("a failed preview stops that send once; the next one goes with the last good choice", async () => {
    const m = manual();
    const c = new ChipChoice<S>(m.preview);
    void c.change(start, { runtime: "codex" });
    await new Promise((r) => setTimeout(r, 0));
    m.calls[0]!.resolve({ runtime: "codex", model: "gpt-6.1-sol" });
    const bad = c.change(start, { model: "nope" });
    bad.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 0));
    m.calls[1]!.reject(new Error("model_not_allowed"));
    await expect(c.settled()).rejects.toThrow("model_not_allowed");
    expect(await c.settled()).toEqual({ runtime: "codex", model: "gpt-6.1-sol" });
    // A later change builds on the last good one.
    void c.change(start, { model: "gpt-6-luna" });
    await new Promise((r) => setTimeout(r, 0));
    expect(m.calls[2]!.base).toEqual({ runtime: "codex", model: "gpt-6.1-sol" });
  });
});
