import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { instant, instantView, resync, type InstantState } from "../src/instructions/sync.js";

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

/** Review #195 round 7: instant-save controls after a save whose refetch failed, then a refused save. */
describe("instant-save controls", () => {
  it("save ok + refetch failed → shows what was stored; a refused save then → back to that, not the stale cache", () => {
    const server = true; // the stale cache: the refetch after the first save failed
    let s: InstantState<boolean> = {};
    s = instant.pick(s, false);
    expect(instantView(s, server, 100).shown).toBe(false);
    s = instant.saved(s, false, false, 200); // PUT 200, GET 503
    expect(instantView(s, server, 100)).toEqual({ shown: false, stale: true });
    s = instant.pick(s, true);
    expect(instantView(s, server, 100).shown).toBe(true);
    s = instant.failed(s); // PUT 503
    expect(instantView(s, server, 100)).toEqual({ shown: false, stale: true });
    // A later refetch that works shows the server's value and clears the notice.
    expect(instantView(s, false, 300)).toEqual({ shown: false, stale: false });
  });

  it("synced saves and plain refusals need no memory", () => {
    let s: InstantState<string> = instant.pick({}, "auto");
    s = instant.saved(s, "auto", true, 10);
    expect(s).toEqual({});
    s = instant.failed(instant.pick(s, "review"));
    expect(instantView(s, "auto", 0)).toEqual({ shown: "auto", stale: false });
  });
});
