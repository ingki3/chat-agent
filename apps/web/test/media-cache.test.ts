import { describe, expect, it } from "vitest";
import { DEFAULT_MEDIA_SETTINGS, MEDIA_KINDS, type MediaAdmin, type MediaCatalog } from "@agentlee/shared";
import {
  catalogView,
  draftBase,
  expectedRevision,
  formState,
  MediaScreenStore,
  inputAfterSave,
  keySaveArgs,
  keyWriteArgs,
  mediaScreenStore,
  formValue,
  isStaleKeyError,
  onCatalogError,
  RejectedGenerations,
  StatusReads,
} from "../src/admin/media-cache.js";

/**
 * 관리자 → 미디어 생성 (#238 review r3–r4): what the screen may show. The races Codex reproduced in JSDOM are
 * played through the same decisions the components make: only the latest started status read is shown (writes
 * never set it), a rejected generation hides every list at once, one status read per rejected generation, and the
 * settings form follows the latest read until edited.
 */

const status = (
  generation: string,
  source: MediaAdmin["key"]["source"] = "admin",
  extra: Partial<MediaAdmin["key"]> = {},
  settings = DEFAULT_MEDIA_SETTINGS,
): MediaAdmin => ({
  key: {
    source,
    last4: source === "admin" ? "cccc" : null,
    limitUsd: null,
    limitRemainingUsd: null,
    usageUsd: null,
    checkedAt: null,
    generation,
    ...extra,
  },
  settings,
  settingsRevision: "initial",
  youthStrictModeration: true,
});
const catalog = (generation: string, id = "d/model"): MediaCatalog => ({
  kind: "image",
  source: "/api/v1/images/models",
  models: [{ id, name: id, price: "$1/image", options: [] }],
  generation,
});

/**
 * The screen's status cache as the component runs it: `begin` = a status read started (a ticket); `answer` = that
 * read answered (shown only when it is the latest started). Writes have no way in — they only `begin` a read.
 */
function screen(initial?: MediaAdmin) {
  const reads = new StatusReads();
  const rejected = new RejectedGenerations();
  let shown = initial;
  let refreshes = 0;
  return {
    rejected,
    get shown() {
      return shown;
    },
    get refreshes() {
      return refreshes;
    },
    begin: () => reads.start(),
    answer(ticket: number, r: MediaAdmin) {
      if (reads.isLatest(ticket) || !shown) shown = r;
    },
    /** A write finished (either way): it starts a read; its own answer is not used. */
    writeSettled: () => reads.start(),
    catalogError(e: unknown, generation: string) {
      return onCatalogError(e, generation, rejected, () => {
        refreshes += 1;
      });
    },
    list: (c: MediaCatalog | undefined) => catalogView(shown, c, rejected),
  };
}

describe("media admin screen rules (#238)", () => {
  it("a list shows only in its own generation, with a key, and not in a rejected generation", () => {
    const rejected = new RejectedGenerations();
    expect(catalogView(status("p:1"), catalog("p:1"), rejected)).toEqual(catalog("p:1"));
    expect(catalogView(status("p:1"), catalog("p:2"), rejected)).toBeUndefined();
    expect(catalogView(status("p:1", "none"), catalog("p:1"), rejected)).toBeUndefined();
    expect(catalogView(undefined, catalog("p:1"))).toBeUndefined();
    rejected.reject("p:1");
    expect(catalogView(status("p:1"), catalog("p:1"), rejected)).toBeUndefined();
  });

  it("only media_key_changed and media_no_key are 'read the status again' (not shown as errors)", () => {
    expect(isStaleKeyError({ code: "media_key_changed" })).toBe(true);
    expect(isStaleKeyError({ code: "media_no_key" })).toBe(true);
    expect(isStaleKeyError({ code: "media_key_invalid" })).toBe(false);
    expect(isStaleKeyError(undefined)).toBe(false);
    const r = new RejectedGenerations();
    let n = 0;
    expect(onCatalogError({ code: "media_key_invalid" }, "p:1", r, () => n++)).toBe(true);
    expect(n).toBe(0);
    expect(r.has("p:1")).toBe(false);
  });

  it("r4: a 409, then the status read still pending — no list of any kind is shown meanwhile", () => {
    const s = screen(status("p:7"));
    const lists = MEDIA_KINDS.map((k) => ({ ...catalog("p:7"), kind: k }));
    expect(lists.every((c) => s.list(c))).toBe(true);
    expect(s.catalogError({ code: "media_key_changed" }, "p:7")).toBe(false);
    s.begin(); // the recovery read, not answered yet
    expect(lists.map((c) => s.list(c))).toEqual([undefined, undefined, undefined, undefined]);
    expect(s.shown!.key.generation).toBe("p:7");
  });

  it("r4: four kinds hit the same stale generation — one status read", () => {
    const s = screen(status("p:7"));
    MEDIA_KINDS.forEach(() => s.catalogError({ code: "media_key_changed" }, "p:7"));
    expect(s.refreshes).toBe(1);
    // A later generation rejected starts its own one.
    s.catalogError({ code: "media_no_key" }, "p:8");
    expect(s.refreshes).toBe(2);
  });

  it("r4: a delayed settings answer during the recovery read — the final read wins", () => {
    const s = screen(status("p:7"));
    s.catalogError({ code: "media_key_changed" }, "p:7");
    const recovery = s.begin();
    // The settings save of p:7 finally answers: it starts a newer read; its own answer is never shown.
    const after = s.writeSettled();
    s.answer(recovery, status("p:8", "none")); // older read: dropped
    expect(s.shown!.key.generation).toBe("p:7");
    s.answer(after, status("p:8", "none"));
    expect(s.shown!.key).toMatchObject({ generation: "p:8", source: "none" });
    expect(s.list(catalog("p:7"))).toBeUndefined();
  });

  it("r4: after a restart, an old process's delayed delete answer is ignored (only reads set the status)", () => {
    const s = screen(status("old:10"));
    const read = s.begin();
    s.answer(read, status("new:1", "admin", { last4: "bbbb" }));
    expect(s.shown!.key.last4).toBe("bbbb");
    // The delete answer of the old process arrives: it only starts a read, which answers with the new process.
    const after = s.writeSettled();
    s.answer(after, status("new:1", "admin", { last4: "bbbb" }));
    expect(s.shown!.key).toMatchObject({ generation: "new:1", source: "admin", last4: "bbbb" });
    expect(s.list(catalog("new:1"))).toBeDefined();
  });

  it("r4: same generation, a delayed settings answer and a fresh balance — the latest read wins", () => {
    const s = screen(status("p:3", "admin", { limitRemainingUsd: 40, checkedAt: 1 }));
    const saveRead = s.writeSettled(); // a settings save (old $50) finished late
    const checkRead = s.writeSettled(); // the balance re-check ($5) finished after it
    s.answer(
      checkRead,
      status(
        "p:3",
        "admin",
        { limitRemainingUsd: 5, checkedAt: 2 },
        { ...DEFAULT_MEDIA_SETTINGS, dailyCostLimitUsd: 20 },
      ),
    );
    s.answer(saveRead, status("p:3", "admin", { limitRemainingUsd: 40, checkedAt: 1 })); // older read: dropped
    expect(s.shown!.key.limitRemainingUsd).toBe(5);
    expect(s.shown!.settings.dailyCostLimitUsd).toBe(20);
  });

  it("the form follows the latest read until edited; the edit stays until saved", () => {
    const server = { ...DEFAULT_MEDIA_SETTINGS, dailyCostLimitUsd: 20 };
    expect(formValue(null, server)).toBe(server);
    const edit = { ...server, dailyCostLimitUsd: 7 };
    expect(formValue(edit, { ...server, dailyCostLimitUsd: 30 })).toBe(edit);
  });

  it("StatusReads: only the latest ticket", () => {
    const r = new StatusReads();
    const a = r.start();
    const b = r.start();
    expect(r.isLatest(a)).toBe(false);
    expect(r.isLatest(b)).toBe(true);
  });

  // ---- round 5+ (revisions, read order) ------------------------------------------------------------------

  const fifty = DEFAULT_MEDIA_SETTINGS;
  const twenty = { ...fifty, dailyCostLimitUsd: 20 };

  /** A store whose coalesced refresh runs when `flush` is called (a turn of the event loop). */
  function store() {
    const queued: (() => void)[] = [];
    const st = new MediaScreenStore((f) => void queued.push(f));
    let reads = 0;
    st.setRefresh(() => void reads++);
    let renders = 0;
    st.subscribe(() => void renders++);
    return {
      st,
      flush: () => queued.splice(0).forEach((f) => f()),
      reads: () => reads,
      renders: () => renders,
    };
  }
  /** The form state with the status read `ticket` shown. */
  const shown = (
    st: MediaScreenStore,
    server: typeof fifty,
    ticket: number,
    edit: typeof fifty | null = null,
  ) => formState({ edit, save: st.save, server, shownTicket: ticket, busy: st.op !== null });

  it("r5/r9: $20 saved, then only the count edited — locked on $20 until a read started after the answer", () => {
    const t = store();
    const before = t.st.reads.start(); // the read shown (ticket 1), still the old $50
    const id = t.st.beginSave(twenty, "R0")!;
    expect(shown(t.st, fifty, before)).toMatchObject({ values: twenty, locked: true, saved: false });
    // A read started while the PUT was out (ticket 2) does not confirm it.
    const during = t.st.reads.start();
    t.st.settleSave(id, { ok: true });
    expect(shown(t.st, fifty, during)).toMatchObject({ values: twenty, locked: true, saved: true });
    // The read started after the answer (ticket 3) ends it, whatever it shows.
    const after = t.st.reads.start();
    expect(shown(t.st, twenty, after)).toMatchObject({ values: twenty, locked: false, saved: true });
    // An edit now starts from $20.
    const next = { ...twenty, perRunLimits: { ...twenty.perRunLimits, image: 2 } };
    expect(next).toMatchObject({ dailyCostLimitUsd: 20, perRunLimits: { image: 2 } });
  });

  it("r9: a restore brings back an older revision — the read after the answer still ends the lock", () => {
    const t = store();
    const id = t.st.beginSave(twenty, "R2")!;
    t.st.settleSave(id, { ok: true });
    const after = t.st.reads.start();
    // The read shows restored values (an old revision): the lock ends anyway — by read order, not by revision.
    expect(shown(t.st, { ...fifty, dailyCostLimitUsd: 10 }, after)).toMatchObject({
      values: { dailyCostLimitUsd: 10 },
      locked: false,
    });
  });

  it("r5: an edit begun before another tab saved names its own base revision (the server refuses it)", () => {
    expect(expectedRevision("R1", "R2")).toBe("R1");
    expect(expectedRevision(null, "R2")).toBe("R2");
  });

  it("r5: the rejected generations and read tickets live with the QueryClient — a re-entered menu still hides lists", () => {
    const qc = {};
    const first = mediaScreenStore(qc);
    first.rejected.reject("p:7");
    const t = first.reads.start();
    const again = mediaScreenStore(qc);
    expect(again).toBe(first);
    expect(catalogView(status("p:7"), catalog("p:7"), again.rejected)).toBeUndefined();
    expect(again.reads.isLatest(t)).toBe(true);
    expect(mediaScreenStore({}).rejected.has("p:7")).toBe(false);
  });

  it("r5: a deletion finished while away — the read started before it is never the one shown", () => {
    const s = screen(status("p:3", "admin", { last4: "aaaa" }));
    const before = s.begin();
    const afterDelete = s.writeSettled();
    s.answer(before, status("p:3", "admin", { last4: "aaaa" }));
    expect(s.shown!.key.last4).toBe("aaaa");
    s.answer(afterDelete, status("p:4", "none"));
    expect(s.shown!.key.source).toBe("none");
  });

  it("r6: a write's inputs are fixed at the click — what is on screen later does not change them", () => {
    let input = "sk-or-v1-e2e-key-bbbb";
    let generation = "p:3";
    const save = keySaveArgs(input, generation);
    const del = keyWriteArgs(generation);
    input = "sk-or-v1-e2e-key-cccc";
    generation = "p:4";
    expect(save).toEqual({ key: "sk-or-v1-e2e-key-bbbb", expectedGeneration: "p:3" });
    expect(del).toEqual({ expectedGeneration: "p:3" });
    expect(inputAfterSave(input, save.key)).toBe(input);
    expect(inputAfterSave("  sk-or-v1-e2e-key-bbbb ", save.key)).toBe("");
    expect(generation).toBe("p:4");
  });

  it("r6/r7: a save answered after re-entry settles in the form mounted now — success and refusal", () => {
    const qc = {};
    const first = mediaScreenStore(qc);
    const ok = first.beginSave(twenty, "R4")!;
    // The menu is left and entered again; the answer arrives (mutation callback): the new form sees it.
    const again = mediaScreenStore(qc);
    const renders = { n: 0 };
    again.subscribe(() => void renders.n++);
    expect(again.settleSave(ok, { ok: true })).toBe(true);
    expect(renders.n).toBeGreaterThan(0);
    expect(shown(again, fifty, again.reads.current()).locked).toBe(true);
    expect(shown(again, twenty, again.reads.start()).locked).toBe(false);
    // Refused: the form mounted now shows the error, the values stay as the draft with their own base.
    const no = again.beginSave(twenty, "R5")!;
    again.settleSave(no, { ok: false, code: "media_settings_changed" });
    expect(shown(again, fifty, again.reads.current())).toEqual({
      values: twenty,
      locked: false,
      saved: false,
      failed: "media_settings_changed",
      refreshed: false,
    });
    expect(draftBase(null, again.save)).toBe("R5");
    expect(expectedRevision(draftBase(null, again.save), "R6")).toBe("R5");
  });

  it("r6: a key write refused for its generation rejects that generation (lists hidden, one read)", () => {
    const s = screen(status("p:3"));
    expect(s.catalogError({ code: "media_key_changed" }, keyWriteArgs("p:3").expectedGeneration)).toBe(false);
    expect(s.list(catalog("p:3"))).toBeUndefined();
    expect(s.refreshes).toBe(1);
  });

  it("r7: a key write's 409 and its settle in the same turn start one status read", () => {
    const t = store();
    expect(t.st.stale({ code: "media_key_changed" }, "p:3")).toBe(false);
    t.st.requestRefresh();
    t.flush();
    expect(t.reads()).toBe(1);
    t.st.requestRefresh();
    t.flush();
    expect(t.reads()).toBe(2);
    expect(t.st.stale({ code: "media_key_invalid" }, "p:3")).toBe(true);
    t.flush();
    expect(t.reads()).toBe(2);
  });

  it("r8: one settings-operation slot — a reload in flight, the menu re-entered, a save cannot start", () => {
    const t = store();
    const reload = t.st.beginReload()!;
    expect(shown(t.st, fifty, 1).locked).toBe(true);
    expect(t.st.beginSave(twenty, "R1")).toBeNull();
    expect(t.st.beginReload()).toBeNull();
    expect(t.st.save).toBeNull();
    expect(t.st.settleReload(reload, true)).toBe(true);
    expect(t.st.op).toBeNull();
    expect(t.st.beginSave(twenty, "R1")).not.toBeNull();
  });

  it("r8: a late answer of an older operation is ignored — reload then save", () => {
    const t = store();
    const reload = t.st.beginReload()!;
    t.st.settleReload(reload, false);
    expect(t.st.reloadFailed).toBe(true);
    const save = t.st.beginSave(twenty, "R2")!;
    expect(t.st.settleReload(reload, true)).toBe(false);
    expect(t.st.op).toBe("save");
    expect(t.st.save).toMatchObject({ phase: "sending", values: twenty });
    expect(t.st.settleSave(save, { ok: true })).toBe(true);
    expect(t.st.save).toMatchObject({ phase: "confirming" });
  });

  it("r8: a late answer of an older operation is ignored — save then reload", () => {
    const t = store();
    const save = t.st.beginSave(twenty, "R2")!;
    t.st.settleSave(save, { ok: false, code: "media_settings_changed" });
    const reload = t.st.beginReload()!;
    expect(t.st.settleSave(save, { ok: true })).toBe(false);
    expect(t.st.op).toBe("reload");
    expect(t.st.save).toMatchObject({ phase: "failed" });
    expect(t.st.settleReload(reload, true)).toBe(true);
    expect(t.st.save).toBeNull();
  });

  it("r8: stale() asks for a read only on the first refusal of a generation, whatever the turns", () => {
    const t = store();
    expect(t.st.stale({ code: "media_key_changed" }, "p:5")).toBe(false);
    t.flush();
    for (let i = 0; i < 3; i++) {
      expect(t.st.stale({ code: "media_key_changed" }, "p:5")).toBe(false);
      t.flush();
    }
    expect(t.reads()).toBe(1);
    t.st.stale({ code: "media_no_key" }, "p:6");
    t.flush();
    expect(t.reads()).toBe(2);
  });

  it("r9: a new edit replacing a failed draft also clears the reload-failure note", () => {
    const t = store();
    const save = t.st.beginSave(twenty, "R1")!;
    t.st.settleSave(save, { ok: false, code: "media_settings_changed" });
    t.st.settleReload(t.st.beginReload()!, false);
    expect(t.st.reloadFailed).toBe(true);
    t.st.clearSave(); // the admin edits
    expect(t.st.reloadFailed).toBe(false);
    expect(t.st.save).toBeNull();
  });

  it("r10: after a refusal, the latest values count as here only once a read started after it is shown", () => {
    const t = store();
    const before = t.st.reads.start(); // the read shown at the refusal
    const id = t.st.beginSave(twenty, "R1")!;
    t.st.settleSave(id, { ok: false, code: "media_settings_changed" });
    // Still the old read: "불러오는 중…", no re-save yet.
    expect(shown(t.st, fifty, before)).toMatchObject({ failed: "media_settings_changed", refreshed: false });
    // The recovery read (started after the refusal) arrives: the latest values are here, re-save may go.
    const after = t.st.reads.start();
    expect(shown(t.st, { ...fifty, dailyCostLimitUsd: 35 }, after)).toMatchObject({
      values: twenty,
      failed: "media_settings_changed",
      refreshed: true,
    });
  });
});
