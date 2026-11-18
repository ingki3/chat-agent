import { describe, expect, it } from "vitest";
import { afterSave, settleDraft, withDraft } from "../src/instructions/draft.js";

/** Review #195 rounds 3–5: drafts hold only the changed fields and survive saves, refetches and late answers. */
describe("form drafts", () => {
  it("afterSave: clears the text that was sent, keeps text typed while the save was in flight", () => {
    expect(afterSave("A", "A", "")).toBe("");
    expect(afterSave<string | undefined>("A", "A", undefined)).toBeUndefined();
    expect(afterSave("A, then B", "A", "")).toBe("A, then B");
  });

  it("withDraft: untouched fields follow the server (a refetch, or another writer, updates them)", () => {
    const server1 = { enabled: true, tokenCap: 300_000, allowed: [] as string[] };
    const draft = { tokenCap: 400_000 };
    expect(withDraft(server1, draft)).toEqual({ enabled: true, tokenCap: 400_000, allowed: [] });
    // Someone else turned the server off meanwhile: the page shows it; the draft (the cap) stays.
    const server2 = { ...server1, enabled: false };
    expect(withDraft(server2, draft)).toEqual({ enabled: false, tokenCap: 400_000, allowed: [] });
    expect(withDraft(server2, undefined)).toEqual(server2);
  });

  it("settleDraft: drops what was saved, keeps what changed after sending; arrays compare by value", () => {
    type S = { time: string; enabled: boolean; allowed: string[] };
    expect(settleDraft<S>({ time: "04:00" }, { time: "04:00" })).toBeUndefined();
    expect(settleDraft<S>({ time: "05:00" }, { time: "04:00" })).toEqual({ time: "05:00" });
    expect(settleDraft<S>({ time: "04:00", enabled: true }, { time: "04:00" })).toEqual({ enabled: true });
    expect(settleDraft<S>({ allowed: ["a", "b"] }, { allowed: ["a", "b"] })).toBeUndefined();
    expect(settleDraft<S>(undefined, { time: "04:00" })).toBeUndefined();
  });
});
