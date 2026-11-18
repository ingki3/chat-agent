import { describe, expect, it } from "vitest";
import type { DreamingAdmin, DreamingUserStatus, MemoryPrefs, MyDreaming } from "@agentlee/shared";
import {
  adminConfigFromPut,
  adminFromGet,
  mineFromGet,
  mineFromPut,
  modeFromGet,
  modeFromPut,
  newer,
  prefsFromGet,
  prefsFromPut,
  rowFromPut,
  type Prefs,
} from "../src/instructions/rev.js";
import { stateText } from "../src/instructions/DreamingPanel.js";

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
const FAKE = { runtime: "claude-code" as const, connectionId: null, model: "fake-large" };
const mine = (o: Partial<MyDreaming>): MyDreaming => ({
  rev: 3,
  enabled: true,
  time: "03:00",
  settings: { enabled: true, time: "03:00", ...FAKE },
  canEdit: true,
  problem: null,
  choices: [{ ...FAKE, label: "Fake · Large" }],
  prompt: { content: "A", custom: true, defaultContent: "D", fixedRules: "R", updatedAt: 1 },
  runs: [],
  proposals: [],
  ...o,
});

describe("stored settings by revision, live state only from GETs (review 10)", () => {
  it("server_off after a delayed prompt save: the late PUT answer (same rev) keeps the GET's live state", () => {
    // The prompt PUT stored rev 3 and is slow to answer; the admin turns the server off; a GET (rev 3) shows it.
    const get = mine({ enabled: false, time: null, problem: "server_off" });
    // (A save's answer counts only with a strictly higher rev — here the GET read rev 3, the PUT stored rev 4.)
    const put = mine({
      rev: 4,
      prompt: { content: "B", custom: true, defaultContent: "D", fixedRules: "R", updatedAt: 2 },
    });
    const after = mineFromPut(get, put);
    expect(after).toMatchObject({ enabled: false, time: null, problem: "server_off", rev: 4 });
    expect(after.prompt.content).toBe("B");
  });

  it("a connection deleted: the GET's choices and problem stay; a late settings PUT updates only the settings", () => {
    const get = mine({ rev: 4, choices: [], problem: "unavailable", enabled: false, time: null });
    const put = mine({ rev: 5, settings: { enabled: true, time: "05:00", ...FAKE } });
    const after = mineFromPut(get, put);
    expect(after).toMatchObject({ choices: [], problem: "unavailable", enabled: false });
    expect(after.settings.time).toBe("05:00");
    // A PUT answer older than the cache changes nothing.
    expect(mineFromPut(get, mine({ rev: 2, settings: { enabled: false, time: "01:00", ...FAKE } }))).toBe(
      get,
    );
  });

  it("a GET that read pre-save settings keeps the saved settings but brings its newer live state", () => {
    const saved = mine({ rev: 5, settings: { enabled: true, time: "06:00", ...FAKE } });
    const staleGet = mine({
      rev: 4,
      settings: { enabled: true, time: "03:00", ...FAKE },
      problem: "server_off",
    });
    const after = mineFromGet(saved, staleGet);
    expect(after).toMatchObject({ rev: 5, problem: "server_off" });
    expect(after.settings.time).toBe("06:00");
  });

  it("기억 반영 방식: `locked` is live (from GETs), the mode stored", () => {
    const get: MemoryPrefs = { applyMode: "review", rev: 2, locked: true };
    const latePut: MemoryPrefs = { applyMode: "auto", rev: 3 };
    expect(modeFromPut(get, latePut)).toMatchObject({ applyMode: "auto", rev: 3, locked: true });
    expect(
      modeFromGet({ applyMode: "auto", rev: 3 }, { applyMode: "review", rev: 2, locked: true }),
    ).toMatchObject({
      applyMode: "auto",
      rev: 3,
      locked: true,
    });
  });

  it("youth turned off, then a late youth-row PUT: the row keeps `youth: false` (and status/problem) from the GET", () => {
    const get = view({ users: [user({ youth: false, problem: "no_choice", rev: 2, applyMode: null })] });
    const late = user({
      youth: true,
      problem: null,
      rev: 3,
      enabled: true,
      applyMode: "auto",
      applyModeRev: 2,
    });
    const after = rowFromPut(get, late)!;
    // 반영 방식 is shown only for a youth account (by the live flag): null here (review 11).
    expect(after.users[0]).toMatchObject({
      youth: false,
      problem: "no_choice",
      enabled: true,
      rev: 3,
      applyMode: null,
    });
  });

  it("the admin's config save answer: only the config — users, candidates and problems stay the GET's", () => {
    const get = view({ unavailable: [FAKE], users: [user({ problem: "unavailable" })] });
    const put = view({
      config: { enabled: false, tokenCap: 300_000, allowed: [] },
      configRev: 2,
      unavailable: [],
    });
    const after = adminConfigFromPut(get, put);
    expect(after).toMatchObject({ configRev: 2, config: { enabled: false }, unavailable: [FAKE] });
    expect(after.users[0]!.problem).toBe("unavailable");
  });
});

describe("the admin view merges per resource", () => {
  it("config, a row's settings and its 반영 방식 each by their own revision; live parts from the GET", () => {
    const saved = view({ config: { enabled: false, tokenCap: 300_000, allowed: [] }, configRev: 3 });
    const staleGet = view({ users: [user({ applyMode: "auto", applyModeRev: 2, today: "done" })] });
    const merged = adminFromGet(saved, staleGet);
    expect(merged).toMatchObject({ configRev: 3, config: { enabled: false } });
    expect(merged.users[0]).toMatchObject({ applyMode: "auto", applyModeRev: 2, today: "done" });
    const on = rowFromPut(merged, user({ rev: 2, enabled: true, applyMode: "review", applyModeRev: 1 }))!;
    expect(on.users[0]).toMatchObject({
      rev: 2,
      enabled: true,
      applyMode: "auto",
      applyModeRev: 2,
      today: "done",
    });
    // An older row in a later GET does not take the saved settings back.
    expect(adminFromGet(on, view({ users: [user({ rev: 1 })] })).users[0]).toMatchObject({
      rev: 2,
      enabled: true,
    });
  });
});

describe("review 11: equal revisions, the status sentence", () => {
  it("a scrubbed GET at the same revision is never undone by a late PUT answer of that revision", () => {
    // The prompt was saved (rev 6); a secret is registered: the GET shows it masked (rev 6 before the background
    // rescrub, rev 7 after). The PUT's answer (rev 6, unmasked) arrives late: ignored either way.
    const prompt = (content: string) => ({
      content,
      custom: true,
      defaultContent: "D",
      fixedRules: "R",
      updatedAt: 1,
    });
    const unmasked = mine({ rev: 6, prompt: prompt("키 abc") });
    for (const rev of [6, 7]) {
      const cache = mineFromGet(mine({ rev: 5 }), mine({ rev, prompt: prompt("키 [가림]") }));
      expect(mineFromPut(cache, unmasked).prompt.content).toBe("키 [가림]");
    }
    const prefs: Prefs = {
      quietStart: null,
      quietEnd: null,
      timeZone: "Asia/Seoul",
      memoryProposals: true,
      memoryApplied: true,
      memoryFailed: false,
      rev: 4,
    };
    const got = prefsFromGet(undefined, prefs);
    expect(prefsFromPut(got, { ...prefs, memoryFailed: true })).toBe(got);
    expect(prefsFromPut(got, { ...prefs, memoryFailed: true, rev: 5 }).memoryFailed).toBe(true);
  });

  it("the status sentence follows the stored settings at once; whether it runs waits for a GET", () => {
    const off = { enabled: false, time: "03:00", ...FAKE };
    const on4 = { enabled: true, time: "04:00", ...FAKE };
    // Off (last GET rev 2), then saved on at 04:00 (rev 3).
    const got = mineFromGet(undefined, mine({ rev: 2, enabled: false, time: null, settings: off }));
    const saved = mineFromPut(got, mine({ rev: 3, settings: on4 }));
    expect(stateText(saved, false)).toBe("기억 정리를 매일 04:00(한국 시각)에 하도록 저장했어요 — 확인 중…");
    expect(stateText(saved, true)).toBe(
      "기억 정리를 매일 04:00(한국 시각)에 하도록 저장했어요 — 최신 상태 확인 실패",
    );
    // The GET after it (rev 3): it runs.
    const confirmed = mineFromGet(saved, mine({ rev: 3, enabled: true, time: "04:00", settings: on4 }));
    expect(stateText(confirmed, false)).toContain("기억 정리가 매일 04:00(한국 시각)에 새 메시지를 정리해요");
    // Turned off: says so at once.
    expect(
      stateText(mineFromPut(confirmed, mine({ rev: 4, settings: { ...on4, enabled: false } })), false),
    ).toContain("꺼져 있어요");
    // The server-wide switch off (live) applies even while a save is not confirmed yet.
    const serverOff = mineFromGet(
      confirmed,
      mine({ rev: 3, problem: "server_off", enabled: false, time: null, settings: on4 }),
    );
    const moved = mineFromPut(serverOff, mine({ rev: 5, settings: { ...on4, time: "05:00" } }));
    expect(stateText(moved, false)).toContain("관리자가 서버 전체에서 기억 정리를 꺼 두었어요");
  });

  it("an admin row's 반영 방식 follows the live youth flag", () => {
    const notYouth = view({ users: [user({ youth: false, applyMode: "auto", applyModeRev: 3 })] });
    expect(adminFromGet(undefined, notYouth).users[0]!.applyMode).toBeNull();
    const youth = view({ users: [user({ youth: true, applyMode: "auto", applyModeRev: 3 })] });
    expect(adminFromGet(adminFromGet(undefined, notYouth), youth).users[0]!.applyMode).toBe("auto");
  });
});
