import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { resync } from "../src/instructions/sync.js";

/** Review #195 round 6: a refetch that fails after a successful save is not "synced". */
describe("resync", () => {
  it("true when the refetch brings fresh values, false when it fails (the old data stays)", async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let fail = false;
    let n = 0;
    const key = ["x"];
    await qc.fetchQuery({
      queryKey: key,
      queryFn: async () => {
        if (fail) throw new Error("503");
        return ++n;
      },
    });
    expect(await resync(qc, key)).toBe(true);
    expect(qc.getQueryData(key)).toBe(2);
    fail = true;
    expect(await resync(qc, key)).toBe(false);
    expect(qc.getQueryData(key)).toBe(2);
    fail = false;
    expect(await resync(qc, key)).toBe(true);
    qc.clear();
  });
});
