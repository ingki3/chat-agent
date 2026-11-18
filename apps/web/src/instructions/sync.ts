import { useState } from "react";
import { onlineManager, type QueryClient, type QueryKey } from "@tanstack/react-query";

/**
 * Saving and catching up afterwards (#188 reviews 6–8) — one ordering model for every form and instant control of
 * 기억 정리 and the notification settings.
 *
 * - A monotonic clock (`tick`) stamps three moments: when a save request is **sent** (`sentAt`), when its response
 *   arrived (`savedAt`), and when the GET whose data is in the cache **started** (`fetchedFrom(key)`, recorded by
 *   `stamped` on success only).
 * - **Synced** after a save = the cache holds data of a GET that completed successfully and started after the save
 *   completed (`fetchedFrom ≥ savedAt`). A paused (offline), cancelled or failed GET leaves the stamp as it was: not
 *   synced, and the notice stays until a later GET succeeds (React Query refetches on reconnect and focus).
 * - A save's value is shown over the cache only while the cache's data was fetched **before that save was sent**
 *   (`fetchedFrom < sentAt`): a GET that started later is authoritative, whatever it shows — a late save response
 *   never re-asserts its value over it.
 */

let clock = 0;
/** The next stamp (strictly increasing within the page). */
export const tick = () => ++clock;

const fetchStarts = new Map<string, number>();
const keyOf = (k: QueryKey) => JSON.stringify(k);

/** The fetch-start stamp of the data in the cache for `key` (0: none recorded). */
export const fetchedFrom = (key: QueryKey) => fetchStarts.get(keyOf(key)) ?? 0;

/** Wraps a query function so the start of each **successful** fetch is recorded for its key. */
export function stamped<T>(key: QueryKey, fn: () => Promise<T>): () => Promise<T> {
  return async () => {
    const start = tick();
    const data = await fn();
    const k = keyOf(key);
    fetchStarts.set(k, Math.max(fetchStarts.get(k) ?? 0, start));
    return data;
  };
}

/** Longest wait for the refetch after a save: past it the screen counts as not caught up (it keeps trying). */
const SYNC_WAIT_MS = 10_000;

export type SaveStamps = { sentAt: number; savedAt: number; synced: boolean };

/**
 * Sends a save, then refetches `key`: `synced` only when a GET started after the save completed succeeded. Offline:
 * not refetched now (not synced — a reconnect refetches). Rejects only when the save itself is refused.
 */
export async function saveAndSync(
  qc: QueryClient,
  key: QueryKey,
  send: () => Promise<unknown>,
): Promise<SaveStamps> {
  const sentAt = tick();
  await send();
  const savedAt = tick();
  if (onlineManager.isOnline()) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        qc.refetchQueries({ queryKey: key, exact: true }),
        new Promise((r) => (timer = setTimeout(r, SYNC_WAIT_MS))),
      ]);
    } catch {
      // a failed refetch: the stamp did not move
    } finally {
      clearTimeout(timer);
    }
  }
  return { sentAt, savedAt, synced: fetchedFrom(key) >= savedAt };
}

/** Whether a save that completed at `savedAt` is still not shown by a successful GET (the "저장했지만…" notice). */
export const behind = (key: QueryKey, savedAt: number | undefined) =>
  savedAt !== undefined && fetchedFrom(key) < savedAt;

export const SAVED_STALE = "저장했지만 최신 상태를 불러오지 못했어요. 잠시 뒤 새로 고쳐 주세요.";

/**
 * An instant-save control (a toggle, a 반영 방식 choice): `picked` — chosen, being saved; `known` — the last value a
 * save stored, with its stamps. Shown over the cache only while the cache is older than that save's request; the
 * notice (`stale`) until a GET started after it completed succeeds. A refused save keeps `known`.
 */
export type InstantState<T> = { picked?: { v: T }; known?: { v: T; sentAt: number; savedAt: number } };

/** What to show, given the cache's value and its fetch-start stamp. */
export function instantView<T>(s: InstantState<T>, server: T, from: number): { shown: T; stale: boolean } {
  const k = s.known;
  const stale = !!k && from < k.savedAt;
  const own = !!k && from < k.sentAt;
  return { shown: s.picked ? s.picked.v : own ? k.v : server, stale };
}

export const instant = {
  pick: <T>(s: InstantState<T>, v: T): InstantState<T> => ({ ...s, picked: { v } }),
  /** The save of `v` (sent at `sentAt`, answered at `savedAt`) was stored. */
  saved: <T>(_s: InstantState<T>, v: T, sentAt: number, savedAt: number): InstantState<T> => ({
    known: { v, sentAt, savedAt },
  }),
  /** Refused or failed: back to the last value known to be stored. */
  failed: <T>(s: InstantState<T>): InstantState<T> => (s.known ? { known: s.known } : {}),
};

/**
 * `instantView` and `instant` as a component's state, for the query `key` that holds `server`. `updatedAt`: the query's
 * `dataUpdatedAt`, read by the caller so the component re-renders whenever a refetch lands (even with equal data).
 */
export function useInstant<T>(server: T, key: QueryKey, updatedAt: number) {
  void updatedAt;
  const [s, set] = useState<InstantState<T>>({});
  return {
    ...instantView(s, server, fetchedFrom(key)),
    pick: (v: T) => set((x) => instant.pick(x, v)),
    saved: (v: T, r: SaveStamps) => set((x) => instant.saved(x, v, r.sentAt, r.savedAt)),
    failed: () => set((x) => instant.failed(x)),
  };
}
