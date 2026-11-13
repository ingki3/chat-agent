import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Share } from "@agentlee/shared";
import { boundaryOptions, Receipts, targetOf } from "../src/shares/ShareDialog.js";

const share = (over: Partial<Share>): Share => ({
  id: "s1",
  itemKind: "conversation",
  itemId: "c1",
  mode: "live",
  audience: "users",
  targets: [
    { id: "u1", name: "엄마" },
    { id: "u2", name: "아들" },
  ],
  boundaryMessageId: null,
  views: [],
  createdAt: 1,
  updatedAt: 1,
  revokedAt: null,
  ...over,
});

describe("read receipts — 열람 확인 (#52, FR-14.6)", () => {
  it("says, for each account it reaches, whether it was opened", () => {
    const html = renderToStaticMarkup(
      createElement(Receipts, {
        s: share({ views: [{ id: "u2", name: "아들", firstViewedAt: 1_800_000_000_000, lastViewedAt: 1 }] }),
      }),
    );
    expect(html).toMatch(/엄마<\/span> <span class="muted">아직 안 열어봄/);
    expect(html).toMatch(/아들<\/span> <span class="seen">✓ 열어봄/);
    expect(html.match(/data-seen="yes"/g)).toHaveLength(1);
  });

  it("shows nothing for a share that reaches no one now", () => {
    expect(renderToStaticMarkup(createElement(Receipts, { s: share({ targets: [] }) }))).toBe("");
  });
});

describe("who a share is for (#29, #52)", () => {
  it("never turns 'no one ticked' into the whole family", () => {
    expect(targetOf({ audience: "users", userIds: [] })).toBeUndefined();
    expect(targetOf({ audience: "family" })).toEqual({ audience: "family" });
    expect(targetOf({ audience: "users", userIds: ["a"] })).toEqual({ audience: "users", userIds: ["a"] });
  });
});

describe("the snapshot boundary picker (#52, review #119)", () => {
  const msg = (id: string, seq: number, role: "user" | "assistant" | "system", text: string) => ({
    id,
    conversationId: "c",
    seq,
    role,
    parts: [{ type: "text" as const, text }],
    runtime: null,
    model: null,
    effort: null,
    status: "complete" as const,
    revision: 0,
    replaces: null,
    createdAt: seq,
  });
  it("offers every loaded page, oldest first — older pages come after the newest in the API's order", () => {
    // Newest page first (as useInfiniteQuery holds them), each page oldest → newest.
    const pages = [
      { items: [msg("m3", 3, "user", "셋"), msg("m4", 4, "assistant", "넷")] },
      { items: [msg("m1", 1, "user", "하나"), msg("d", 2, "system", "구분선")] },
    ];
    expect(boundaryOptions(pages)).toEqual([
      { id: "m1", label: "나: 하나" },
      { id: "m3", label: "나: 셋" },
      { id: "m4", label: "답: 넷" },
    ]);
  });
});
