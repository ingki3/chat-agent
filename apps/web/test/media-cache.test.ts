import { describe, expect, it } from "vitest";
import { DEFAULT_MEDIA_SETTINGS, MEDIA_KINDS, type MediaAdmin, type MediaCatalog } from "@agentlee/shared";
import {
  catalogView,
  draftBase,
  expectedVersion,
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
  settingsVersion: 0,
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

  // ---- round 5 ----------------------------------------------------------------------------------------------

  const fifty = DEFAULT_MEDIA_SETTINGS;
  const twenty = { ...fifty, dailyCostLimitUsd: 20 };

  it("r5: $20 saved, then only the image count edited — the form never builds the next save on the old $50", () => {
    // Sent: the submitted $20 is shown and the form is locked.
    let st = formState({
      edit: null,
      save: { phase: "sending", values: twenty, base: 0 },
      server: fifty,
      serverVersion: 0,
    });
    expect(st).toMatchObject({ values: twenty, locked: true });
    // Saved as v1, but the status read still shows v0 ($50): still $20, still locked.
    const confirming = { phase: "confirming" as const, values: twenty, base: 0, version: 1 };
    st = formState({ edit: null, save: confirming, server: fifty, serverVersion: 0 });
    expect(st).toMatchObject({ values: twenty, locked: true });
    // The read shows v1: unlocked, following it; an edit now starts from $20.
    st = formState({ edit: null, save: confirming, server: twenty, serverVersion: 1 });
    expect(st).toMatchObject({ values: twenty, locked: false });
    const next = { ...st.values, perRunLimits: { ...st.values.perRunLimits, image: 2 } };
    expect(next).toMatchObject({ dailyCostLimitUsd: 20, perRunLimits: { image: 2 } });
    expect(expectedVersion(1, 1)).toBe(1);
  });

  it("r5: an edit typed while a save is in flight is impossible (locked), never dropped silently", () => {
    const st = formState({
      edit: null,
      save: { phase: "sending", values: twenty, base: 0 },
      server: fifty,
      serverVersion: 0,
    });
    expect(st.locked).toBe(true);
  });

  it("r5: an edit begun before another tab saved names its own base version (the server refuses it)", () => {
    // Edit started at v1; meanwhile the status read shows v2: the save still says v1 → media_settings_changed.
    expect(expectedVersion(1, 2)).toBe(1);
    // No edit: the version shown.
    expect(expectedVersion(null, 2)).toBe(2);
  });

  it("r5: a failed save (or re-read) keeps the admin's values as their edit", () => {
    // After an error the component puts the submitted values back as the edit: they win over any read.
    expect(formState({ edit: twenty, save: null, server: fifty, serverVersion: 3 })).toMatchObject({
      values: twenty,
      locked: false,
    });
  });

  it("r5: the rejected generations and read tickets live with the QueryClient — a re-entered menu still hides lists", () => {
    const qc = {};
    const first = mediaScreenStore(qc);
    first.rejected.reject("p:7");
    const t = first.reads.start();
    // The menu is left and entered again: a new component, the same QueryClient.
    const again = mediaScreenStore(qc);
    expect(again).toBe(first);
    expect(catalogView(status("p:7"), catalog("p:7"), again.rejected)).toBeUndefined();
    expect(again.reads.isLatest(t)).toBe(true);
    // Another QueryClient (another app instance) has its own.
    expect(mediaScreenStore({}).rejected.has("p:7")).toBe(false);
  });

  it("r5: a deletion finished while away — the read started before it is never the one shown", () => {
    const s = screen(status("p:3", "admin", { last4: "aaaa" }));
    const before = s.begin(); // a re-check's read, still in flight when the admin leaves
    const afterDelete = s.writeSettled(); // the delete finished: it starts (and cancels for) a new read
    s.answer(before, status("p:3", "admin", { last4: "aaaa" }));
    expect(s.shown!.key.last4).toBe("aaaa"); // unchanged so far: the old read was not taken
    s.answer(afterDelete, status("p:4", "none"));
    expect(s.shown!.key.source).toBe("none");
  });

  // ---- round 6 ----------------------------------------------------------------------------------------------

  it("r6: a write's inputs are fixed at the click — what is on screen later does not change them", () => {
    let input = "sk-or-v1-e2e-key-bbbb";
    let generation = "p:3";
    const save = keySaveArgs(input, generation);
    const del = keyWriteArgs(generation);
    // Held back offline: meanwhile the input becomes CCCC and the status read shows another key (p:4).
    input = "sk-or-v1-e2e-key-cccc";
    generation = "p:4";
    expect(save).toEqual({ key: "sk-or-v1-e2e-key-bbbb", expectedGeneration: "p:3" });
    expect(del).toEqual({ expectedGeneration: "p:3" });
    // Once it succeeds, the newer input is kept; the saved one is cleared.
    expect(inputAfterSave(input, save.key)).toBe(input);
    expect(inputAfterSave("  sk-or-v1-e2e-key-bbbb ", save.key)).toBe("");
    expect(generation).toBe("p:4");
  });

  it("r6: a save waiting for its confirming read stays with the QueryClient — a re-entered form is still locked", () => {
    const qc = {};
    mediaScreenStore(qc).setSave({ phase: "confirming", values: twenty, base: 4, version: 5 });
    // The menu is left and entered again (a new form): the same store, the same lock.
    const again = mediaScreenStore(qc);
    expect(formState({ edit: null, save: again.save, server: fifty, serverVersion: 4 })).toMatchObject({
      values: twenty,
      locked: true,
    });
    expect(formState({ edit: null, save: again.save, server: twenty, serverVersion: 5 }).locked).toBe(false);
  });

  it("r6: a key write refused for its generation rejects that generation (lists hidden, one read)", () => {
    const s = screen(status("p:3"));
    expect(s.catalogError({ code: "media_key_changed" }, keyWriteArgs("p:3").expectedGeneration)).toBe(false);
    expect(s.list(catalog("p:3"))).toBeUndefined();
    expect(s.refreshes).toBe(1);
  });

  // ---- round 7 ----------------------------------------------------------------------------------------------

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

  it("r7: a save sent from one form and answered after re-entry settles in the form mounted now (success)", () => {
    const t = store();
    t.st.setSave({ phase: "sending", values: twenty, base: 0 });
    // The menu is left and entered again: the new form reads the same store (and is subscribed to it).
    const renders = t.renders();
    // The PUT answers (mutation callback, whatever form is mounted): v1 to wait for.
    t.st.setSave({ phase: "confirming", values: twenty, base: 0, version: 1 });
    expect(t.renders()).toBeGreaterThan(renders);
    expect(formState({ edit: null, save: t.st.save, server: fifty, serverVersion: 0 })).toMatchObject({
      values: twenty,
      locked: true,
    });
    expect(formState({ edit: null, save: t.st.save, server: twenty, serverVersion: 1 })).toMatchObject({
      values: twenty,
      locked: false,
      saved: true,
    });
  });

  it("r7: the status read already showed the new version before the PUT answered — unlocked at once", () => {
    const save = { phase: "confirming" as const, values: twenty, base: 0, version: 1 };
    expect(formState({ edit: null, save, server: twenty, serverVersion: 1 }).locked).toBe(false);
    expect(formState({ edit: null, save, server: twenty, serverVersion: 2 }).locked).toBe(false);
  });

  it("r7: a save refused after re-entry — the form mounted now shows the error and keeps the values as the draft", () => {
    const t = store();
    t.st.setSave({ phase: "sending", values: twenty, base: 3 });
    t.st.setSave({ phase: "failed", values: twenty, base: 3, code: "media_settings_changed" });
    const st = formState({ edit: null, save: t.st.save, server: fifty, serverVersion: 4 });
    expect(st).toEqual({ values: twenty, locked: false, saved: false, failed: "media_settings_changed" });
    // The draft keeps its own base (a plain save again would be refused too; "이 값으로 다시 저장" uses v4).
    expect(draftBase(null, t.st.save)).toBe(3);
    expect(expectedVersion(draftBase(null, t.st.save), 4)).toBe(3);
  });

  it("r7: while '최신 값 불러오기' reads, the form is locked; nothing arrived (offline) keeps the draft", () => {
    const failed = { phase: "failed" as const, values: twenty, base: 3, code: "media_settings_changed" };
    expect(formState({ edit: null, save: failed, server: fifty, serverVersion: 4, busy: true }).locked).toBe(
      true,
    );
    // The read resolved without new data: the component keeps `failed` (draft) — the same state as before.
    expect(formState({ edit: null, save: failed, server: fifty, serverVersion: 4 }).values).toBe(twenty);
  });

  it("r7: a key write's 409 and its settle in the same turn start one status read", () => {
    const t = store();
    expect(t.st.stale({ code: "media_key_changed" }, "p:3")).toBe(false); // onError
    t.st.requestRefresh(); // onSettled
    t.flush();
    expect(t.reads()).toBe(1);
    expect(t.st.rejected.has("p:3")).toBe(true);
    // A later write asks again in its own turn.
    t.st.requestRefresh();
    t.flush();
    expect(t.reads()).toBe(2);
    // Errors that are not stale are shown and start nothing by themselves.
    expect(t.st.stale({ code: "media_key_invalid" }, "p:3")).toBe(true);
    t.flush();
    expect(t.reads()).toBe(2);
  });
});
