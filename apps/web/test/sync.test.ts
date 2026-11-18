import { onlineManager, QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";
import {
  behind,
  fetchedFrom,
  instant,
  instantView,
  saveAndSync,
  stamped,
  tick,
  type InstantState,
} from "../src/instructions/sync.js";

/**
 * Review #195 rounds 6–8: one ordering model (sync.ts). Synced = a successful GET that started after the save
 * completed; a save's value shows only over cache data fetched before that save was sent.
 */
afterEach(() => onlineManager.setOnline(true));

function setup(name: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const key = [name];
  const server = { value: 1, fail: false };
  const fn = stamped(key, async () => {
    if (server.fail) throw new Error("503");
    return server.value;
  });
  return { qc, key, server, fn };
}

describe("saveAndSync", () => {
  it("synced only by a successful GET that started after the save completed", async () => {
    const { qc, key, server, fn } = setup("ok");
    await qc.fetchQuery({ queryKey: key, queryFn: fn });
    const r = await saveAndSync(qc, key, async () => {
      server.value = 2;
    });
    expect(r.synced).toBe(true);
    expect(qc.getQueryData(key)).toBe(2);
    expect(fetchedFrom(key)).toBeGreaterThan(r.savedAt);
    expect(behind(key, r.savedAt)).toBe(false);
    qc.clear();
  });

  it("a failed refetch is not synced; a later successful one clears the notice", async () => {
    const { qc, key, server, fn } = setup("fail");
    await qc.fetchQuery({ queryKey: key, queryFn: fn });
    server.fail = true;
    const r = await saveAndSync(qc, key, async () => {
      server.value = 3;
    });
    expect(r.synced).toBe(false);
    expect(behind(key, r.savedAt)).toBe(true);
    expect(qc.getQueryData(key)).toBe(1);
    server.fail = false;
    await qc.refetchQueries({ queryKey: key });
    expect(behind(key, r.savedAt)).toBe(false);
    qc.clear();
  });

  it("offline right after the save (a paused refetch): not synced — no GET ran", async () => {
    const { qc, key, server, fn } = setup("offline");
    await qc.fetchQuery({ queryKey: key, queryFn: fn });
    const r = await saveAndSync(qc, key, async () => {
      server.value = 4;
      onlineManager.setOnline(false);
    });
    expect(r.synced).toBe(false);
    expect(behind(key, r.savedAt)).toBe(true);
    expect(qc.getQueryData(key)).toBe(1);
    onlineManager.setOnline(true);
    await qc.refetchQueries({ queryKey: key });
    expect(behind(key, r.savedAt)).toBe(false);
    qc.clear();
  });

  it("a refused save rejects (no stamps)", async () => {
    const { qc, key } = setup("refused");
    await expect(
      saveAndSync(qc, key, async () => {
        throw new Error("400");
      }),
    ).rejects.toThrow("400");
    qc.clear();
  });
});

describe("instant-save controls", () => {
  it("save ok + refetch failed → shows what was stored; a refused save then → still that, not the stale cache", () => {
    const from = tick(); // the cache (true) was fetched before
    let s: InstantState<boolean> = instant.pick({}, false);
    const sentAt = tick();
    const savedAt = tick();
    s = instant.saved(s, false, sentAt, savedAt); // PUT 200, GET 503: the cache is still the old one
    expect(instantView(s, true, from)).toEqual({ shown: false, stale: true });
    s = instant.failed(instant.pick(s, true)); // PUT 503
    expect(instantView(s, true, from)).toEqual({ shown: false, stale: true });
    // A GET that started after the save completed: authoritative, the notice goes.
    expect(instantView(s, false, tick())).toEqual({ shown: false, stale: false });
  });

  it("a late save response never hides a newer GET: the GET started after the save was sent wins", () => {
    // A sends false (t1) … another tab saves true, a GET started at t2 shows true … A's answer arrives (t3).
    const sentAt = tick();
    const getFrom = tick();
    const savedAt = tick();
    const s = instant.saved<boolean>({}, false, sentAt, savedAt);
    // The cache (true) is newer than A's request: shown as is. Still "behind" A's save (no GET after it yet).
    expect(instantView(s, true, getFrom)).toEqual({ shown: true, stale: true });
    // A later failed GET changes nothing; a later successful one clears the notice.
    expect(instantView(s, true, getFrom)).toEqual({ shown: true, stale: true });
    expect(instantView(s, true, tick())).toEqual({ shown: true, stale: false });
  });

  it("synced saves need no memory; a plain refusal shows the cache", () => {
    const sentAt = tick();
    const savedAt = tick();
    const after = tick();
    const s = instant.saved<string>({}, "auto", sentAt, savedAt);
    expect(instantView(s, "auto", after)).toEqual({ shown: "auto", stale: false });
    expect(instantView(instant.failed(instant.pick<string>({}, "review")), "auto", after)).toEqual({
      shown: "auto",
      stale: false,
    });
  });

  it("every 3-step sequence of {ok+synced, ok+refetch failed, refused} ends showing the server's real value", () => {
    type Step = "synced" | "stale" | "refused";
    const steps: Step[] = ["synced", "stale", "refused"];
    for (const a of steps)
      for (const b of steps)
        for (const c of steps) {
          let db = false;
          let cache = false;
          let from = tick();
          let s: InstantState<boolean> = {};
          let next = true;
          for (const step of [a, b, c]) {
            s = instant.pick(s, next);
            const sentAt = tick();
            if (step === "refused") s = instant.failed(s);
            else {
              db = next;
              const savedAt = tick();
              s = instant.saved(s, next, sentAt, savedAt);
              if (step === "synced") {
                from = tick();
                cache = db;
              }
            }
            next = !next;
          }
          expect(instantView(s, cache, from).shown, `${a}→${b}→${c}`).toBe(db);
        }
  });
});
