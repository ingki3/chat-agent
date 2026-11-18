import { describe, expect, it } from "vitest";
import type { DreamingAdmin, DreamingUserStatus } from "@agentlee/shared";
import { newer, newerAdmin, newerUser, withUser } from "../src/instructions/rev.js";

/** Review #195 round 9: the page keeps the newest revision of each resource — the server orders the writes. */
type R = { rev: number; v: boolean };

/** A page's cache for one resource, fed answers in the order they arrive. */
const feed = (answers: (R | "fail")[]) =>
  answers.reduce<R | undefined>((c, a) => (a === "fail" ? c : newer(c, a)), undefined);

describe("newest revision wins", () => {
  it("a late PUT answer older than a GET already seen is ignored", () => {
    // A saves false (rev 2) … another tab saves true (rev 3), a GET shows rev 3 … A's answer (rev 2) arrives.
    expect(feed([{ rev: 1, v: true }, { rev: 3, v: true }, { rev: 2, v: false }, "fail"])).toEqual({
      rev: 3,
      v: true,
    });
  });

  it("a GET that read the data from before the save cannot override the save's answer", () => {
    // PUT sent, a GET reads rev 1 (before the save applied) and lands after the PUT answer (rev 2), then a GET fails.
    expect(feed([{ rev: 1, v: true }, { rev: 2, v: false }, { rev: 1, v: true }, "fail"])).toEqual({
      rev: 2,
      v: false,
    });
  });

  it("a failed or cancelled GET changes nothing; a later GET with a newer revision wins (delayed recovery)", () => {
    expect(feed([{ rev: 1, v: true }, { rev: 2, v: false }, "fail", "fail"])).toEqual({ rev: 2, v: false });
    expect(feed([{ rev: 1, v: true }, { rev: 2, v: false }, "fail", { rev: 4, v: true }])).toEqual({
      rev: 4,
      v: true,
    });
  });

  it("an equal revision takes the newer answer (fresher derived fields)", () => {
    const a = { rev: 2, v: false, runs: 1 };
    const b = { rev: 2, v: false, runs: 2 };
    expect(newer(a, b)).toBe(b);
  });

  it("every sequence of saves (ok / refused) and GETs (ok, stale-read, failed) ends with the screen = the database", () => {
    type Op = "put-ok" | "put-refused" | "get-ok" | "get-stale" | "get-fail";
    const ops: Op[] = ["put-ok", "put-refused", "get-ok", "get-stale", "get-fail"];
    let n = 0;
    for (const a of ops)
      for (const b of ops)
        for (const c of ops)
          for (const d of ops) {
            let db: R = { rev: 1, v: true };
            const history: R[] = [db];
            let cache: R | undefined = db;
            let next = false;
            for (const op of [a, b, c, d]) {
              if (op === "put-ok") {
                db = { rev: db.rev + 1, v: next };
                history.push(db);
                cache = newer(cache, db);
                next = !next;
              } else if (op === "get-ok") cache = newer(cache, db);
              // A GET that started before the last write and lands now: an older revision.
              else if (op === "get-stale") cache = newer(cache, history[Math.max(0, history.length - 2)]!);
            }
            // After the last save's answer (or any successful GET), the screen is the database.
            const lastWrite = [a, b, c, d].lastIndexOf("put-ok");
            const lastGet = [a, b, c, d].lastIndexOf("get-ok");
            if (lastWrite >= 0 || lastGet >= 0) expect(cache, `${a} ${b} ${c} ${d}`).toEqual(db);
            n++;
          }
    expect(n).toBe(625);
  });
});

describe("the admin view merges per resource", () => {
  const user = (o: Partial<DreamingUserStatus>): DreamingUserStatus => ({
    userId: "u",
    rev: 1,
    applyModeRev: 1,
    name: "아들",
    active: true,
    youth: true,
    enabled: false,
    settings: { enabled: false, time: "03:00", runtime: null, connectionId: null, model: null },
    customPrompt: false,
    applyMode: "review",
    problem: null,
    time: null,
    today: null,
    last: null,
    ...o,
  });
  const view = (o: Partial<DreamingAdmin>): DreamingAdmin => ({
    config: { enabled: true, tokenCap: 300_000, allowed: [] },
    configRev: 1,
    unavailable: [],
    candidates: [],
    users: [user({})],
    manualRuns: false,
    ...o,
  });

  it("config, a youth row's settings and its 반영 방식 each by their own revision", () => {
    const saved = view({ config: { enabled: false, tokenCap: 300_000, allowed: [] }, configRev: 3 });
    const staleGet = view({ users: [user({ applyMode: "auto", applyModeRev: 2 })] });
    const merged = newerAdmin(saved, staleGet);
    expect(merged.config.enabled).toBe(false);
    expect(merged.configRev).toBe(3);
    expect(merged.users[0]).toMatchObject({ applyMode: "auto", applyModeRev: 2 });
    // A youth save's answer (settings rev 2) into the view; an older one afterwards is ignored.
    const on = withUser(merged, user({ rev: 2, enabled: true, applyMode: "review", applyModeRev: 1 }))!;
    expect(on.users[0]).toMatchObject({ rev: 2, enabled: true, applyMode: "auto", applyModeRev: 2 });
    expect(newerUser(on.users[0], user({ rev: 1 }))).toMatchObject({ rev: 2, enabled: true });
  });
});
