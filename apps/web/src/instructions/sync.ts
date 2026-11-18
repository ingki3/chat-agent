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
