import { useState } from "react";
import type { QueryClient, QueryKey } from "@tanstack/react-query";

/**
 * After a save succeeded (#188 review 6): refetch what the form shows and say whether that worked. A form drops its
 * draft only when this is true — the fresh server values are then on screen. When it is false the save did land, but
 * the screen could not catch up: the form keeps what was sent and says "저장했지만 최신 상태를 불러오지 못했어요"
 * (`SAVED_STALE`), distinct from a refused save.
 */
export async function resync(qc: QueryClient, queryKey: QueryKey): Promise<boolean> {
  try {
    await qc.refetchQueries({ queryKey, exact: true }, { throwOnError: true });
    return !qc.getQueryState(queryKey)?.error;
  } catch {
    return false;
  }
}

export const SAVED_STALE = "저장했지만 최신 상태를 불러오지 못했어요. 잠시 뒤 새로 고쳐 주세요.";

/**
 * An instant-save control (a toggle, a 반영 방식 choice — #188 review 7): what it shows besides the server's value.
 * `picked` — chosen, being saved; `known` — the last value a save **stored** that no successful refetch has shown yet
 * (`at` = when). A refused save goes back to `known` (what the server really has), not to a stale cache; `known` and the
 * "저장했지만…" notice stay until a refetch succeeds after it.
 */
export type InstantState<T> = { picked?: { v: T }; known?: { v: T; at: number } };

/** The value to show and whether the screen is behind the server. */
export function instantView<T>(
  s: InstantState<T>,
  server: T,
  dataUpdatedAt: number,
): { shown: T; stale: boolean } {
  const known = s.known && dataUpdatedAt <= s.known.at ? s.known : undefined;
  return { shown: s.picked ? s.picked.v : known ? known.v : server, stale: !!known };
}

export const instant = {
  pick: <T>(s: InstantState<T>, v: T): InstantState<T> => ({ ...s, picked: { v } }),
  /** The save stored `v`; `synced`: a refetch then showed the server's values. */
  saved: <T>(_s: InstantState<T>, v: T, synced: boolean, now: number): InstantState<T> =>
    synced ? {} : { known: { v, at: now } },
  /** The save was refused or failed: back to the last value known to be stored. */
  failed: <T>(s: InstantState<T>): InstantState<T> => (s.known ? { known: s.known } : {}),
};

/** `instantView` and `instant` as a component's state (`dataUpdatedAt` of the query that holds `server`). */
export function useInstant<T>(server: T, dataUpdatedAt: number) {
  const [s, set] = useState<InstantState<T>>({});
  return {
    ...instantView(s, server, dataUpdatedAt),
    pick: (v: T) => set((x) => instant.pick(x, v)),
    saved: (v: T, synced: boolean) => set((x) => instant.saved(x, v, synced, Date.now())),
    failed: () => set((x) => instant.failed(x)),
  };
}
