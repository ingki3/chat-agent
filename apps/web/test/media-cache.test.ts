import { describe, expect, it } from "vitest";
import { DEFAULT_MEDIA_SETTINGS, type MediaAdmin, type MediaCatalog } from "@agentlee/shared";
import { catalogView, isStaleKeyError, newerStatus, parseGeneration } from "../src/admin/media-cache.js";

/**
 * 관리자 → 미디어 생성 (#238 review r3): which key status and which catalog the screen may show. The races Codex
 * reproduced (another tab swapping the key, a delayed status read after a delete, a refresh error before a key
 * change) are played here through the same decisions the components make.
 */

const status = (
  generation: string,
  source: MediaAdmin["key"]["source"] = "admin",
  last4: string | null = "cccc",
) =>
  ({
    key: {
      source,
      last4: source === "admin" ? last4 : null,
      limitUsd: null,
      limitRemainingUsd: null,
      usageUsd: null,
      checkedAt: null,
      generation,
    },
    settings: DEFAULT_MEDIA_SETTINGS,
    youthStrictModeration: true,
  }) satisfies MediaAdmin;
const catalog = (generation: string, id = "d/model"): MediaCatalog => ({
  kind: "image",
  source: "/api/v1/images/models",
  models: [{ id, name: id, price: "$1/image", options: [] }],
  generation,
});

describe("media admin screen: status and catalog rules (#238)", () => {
  it("parses generations", () => {
    expect(parseGeneration("ab12:7")).toEqual({ boot: "ab12", n: 7 });
    expect(parseGeneration("nope")).toBeUndefined();
  });

  it("a status never goes back to an older generation of the same process; another process always wins", () => {
    const old = status("p:1");
    const fresh = status("p:2", "none");
    expect(newerStatus(undefined, old)).toBe(old);
    expect(newerStatus(fresh, old)).toBe(fresh);
    expect(newerStatus(old, fresh)).toBe(fresh);
    const same = status("p:2", "none");
    expect(newerStatus(fresh, same)).toBe(same);
    const restarted = status("q:0", "env");
    expect(newerStatus(fresh, restarted)).toBe(restarted);
  });

  it("a list shows only in its own generation, and never without a key", () => {
    expect(catalogView(status("p:1"), catalog("p:1"))).toEqual(catalog("p:1"));
    expect(catalogView(status("p:1"), catalog("p:2"))).toBeUndefined();
    expect(catalogView(status("p:1", "none"), catalog("p:1"))).toBeUndefined();
    expect(catalogView(undefined, catalog("p:1"))).toBeUndefined();
    expect(catalogView(status("p:1"), undefined)).toBeUndefined();
  });

  it("only media_key_changed and media_no_key mean 'read the status again'", () => {
    expect(isStaleKeyError({ code: "media_key_changed" })).toBe(true);
    expect(isStaleKeyError({ code: "media_no_key" })).toBe(true);
    expect(isStaleKeyError({ code: "media_key_invalid" })).toBe(false);
    expect(isStaleKeyError(new Error("x"))).toBe(false);
    expect(isStaleKeyError(undefined)).toBe(false);
  });

  it("race: another tab swaps C for D, then a manual refresh — D's list never shows next to C's last 4", () => {
    // The screen still shows C (p:1); the server is at D (p:2). A refresh asks for p:1 → refused (stale), so
    // nothing is stored; even a list the server read as D carries p:2 and is not shown beside C.
    const screen = status("p:1", "admin", "cccc");
    expect(catalogView(screen, catalog("p:2"))).toBeUndefined();
    expect(isStaleKeyError({ code: "media_key_changed" })).toBe(true);
    // The status is read again: D (p:2) — now D's own list shows.
    const reread = newerStatus(screen, status("p:2", "admin", "dddd"));
    expect(reread.key.last4).toBe("dddd");
    expect(catalogView(reread, catalog("p:2"))).toBeDefined();
  });

  it("race: a status read started before a delete answers after it — the deleted key does not come back", () => {
    const afterDelete = status("p:3", "none");
    const delayed = status("p:2", "admin", "cccc");
    const shown = newerStatus(afterDelete, delayed);
    expect(shown.key.source).toBe("none");
    expect(catalogView(shown, catalog("p:2"))).toBeUndefined();
  });

  it("race: a refresh failed under key A, then the key changes — A's list and generation no longer apply", () => {
    // The row is remounted per generation (its React key), so the failed refresh's state is gone; the stored
    // lists of A's generation are not shown under B's.
    const b = newerStatus(status("p:4"), status("p:5", "env"));
    expect(catalogView(b, catalog("p:4"))).toBeUndefined();
    expect(catalogView(b, catalog("p:5"))).toBeDefined();
  });
});
