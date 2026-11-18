import { describe, expect, it } from "vitest";
import { afterSave } from "../src/instructions/draft.js";

/** Review #195 round 3: a save's success never throws away text typed after it was sent. */
describe("afterSave", () => {
  it("clears the draft that was sent", () => {
    expect(afterSave("A", "A", "")).toBe("");
    expect(afterSave<string | undefined>("A", "A", undefined)).toBeUndefined();
  });
  it("keeps text typed while the save was in flight", () => {
    expect(afterSave("A, then B", "A", "")).toBe("A, then B");
    expect(afterSave<string | undefined>("B", "A", undefined)).toBe("B");
  });
});
