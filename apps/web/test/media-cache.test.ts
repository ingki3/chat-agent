import { describe, expect, it } from "vitest";
import { DEFAULT_MEDIA_SETTINGS, MEDIA_KINDS, type MediaAdmin, type MediaCatalog } from "@agentlee/shared";
import {
  catalogView,
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
});
