import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  DreamingAdmin,
  DreamingUserStatus,
  MemoryPrefs,
  MyDreaming,
  NotificationPrefs,
} from "@agentlee/shared";

/**
 * Server revisions (#188 reviews 9–10): every settings resource — a user's 기억 정리 settings and prompt, their 반영 방식,
 * the admin's config, each youth account's settings, the notification preferences — carries a `rev` the server raises
 * by one on every write, in the same statement. The order of writes is the server's, never a client clock.
 *
 * Each answer has two parts:
 * - the **stored settings** the rev covers — kept from whichever answer (GET or PUT) has the higher rev (a tie takes the
 *   newer answer);
 * - **derived / live state** (whether it runs now, `problem`, the connection choices, an account's youth flag and
 *   status, run results…) — taken **only from GETs**: React Query runs one GET per key at a time and drops a cancelled
 *   one, so the latest successful GET is the newest. A save's answer never touches it — a late PUT cannot bring back
 *   "on" after the server was switched off, or a deleted connection.
 * A GET that read data from before a save has a lower rev: its stored part is ignored (its live part is still the
 * newest). After a save the query is invalidated (marked stale and refetched; reconnecting refetches it too).
 */

type Revved = { rev: number };

/** The answer with the higher rev (`next` on a tie) — for resources that are all stored settings. */
export function newer<T extends Revved>(old: T | undefined, next: T): T {
  return !old || next.rev >= old.rev ? next : old;
}

const pick = <T extends object, K extends keyof T>(o: T, keys: readonly K[]): Pick<T, K> =>
  Object.fromEntries(keys.map((k) => [k, o[k]])) as Pick<T, K>;

/** A GET's answer: its live part always; the stored part (`keys` + rev) only if not older than the cache's. */
export function fromGet<T extends Revved, K extends keyof T>(keys: readonly K[]) {
  return (old: T | undefined, next: T): T =>
    !old || next.rev >= old.rev ? next : { ...next, ...pick(old, keys), rev: old.rev };
}

/** A save's answer: only the stored part (`keys` + rev), only if not older; the live part stays the cache's. */
export function fromPut<T extends Revved, K extends keyof T>(keys: readonly K[]) {
  return (old: T | undefined, put: T): T =>
    !old ? put : put.rev >= old.rev ? { ...old, ...pick(put, keys), rev: put.rev } : old;
}

/** For `useQuery({ structuralSharing })`. */
export const sharing =
  <T>(merge: (old: T | undefined, next: T) => T) =>
  (old: unknown, next: unknown): unknown =>
    merge(old as T | undefined, next as T);

// ---- the resources ----

/** 설정 → 내 지침 → 기억 정리: the settings and the prompt are stored; the rest (runs now, problem, choices…) is live. */
const MINE = ["settings", "prompt"] as const;
export const mineFromGet = fromGet<MyDreaming, (typeof MINE)[number]>(MINE);
export const mineFromPut = fromPut<MyDreaming, (typeof MINE)[number]>(MINE);

/** 기억 반영 방식: the mode is stored; `locked` (a youth account) is live. */
const MODE = ["applyMode"] as const;
export const modeFromGet = fromGet<MemoryPrefs, (typeof MODE)[number]>(MODE);
export const modeFromPut = fromPut<MemoryPrefs, (typeof MODE)[number]>(MODE);

/** Notification preferences: all stored. */
export type Prefs = NotificationPrefs & Revved;
export const prefsMerge = newer<Prefs>;

/** One admin row: the settings part (by `rev`) and the 반영 방식 part (by `applyModeRev`) — the rest is live. */
const ROW_SETTINGS = ["enabled", "settings", "customPrompt"] as const;
function rowStored(base: DreamingUserStatus, from: DreamingUserStatus): DreamingUserStatus {
  const s = from.rev >= base.rev ? from : base;
  const m = from.applyModeRev >= base.applyModeRev ? from : base;
  return {
    ...base,
    ...pick(s, ROW_SETTINGS),
    rev: s.rev,
    applyMode: m.applyMode,
    applyModeRev: m.applyModeRev,
  };
}

/** A GET's row: live from it, each stored part from the higher revision. */
export function rowFromGet(
  old: DreamingUserStatus | undefined,
  next: DreamingUserStatus,
): DreamingUserStatus {
  const s = old && old.rev > next.rev ? old : next;
  const m = old && old.applyModeRev > next.applyModeRev ? old : next;
  return {
    ...next,
    ...pick(s, ROW_SETTINGS),
    rev: s.rev,
    applyMode: m.applyMode,
    applyModeRev: m.applyModeRev,
  };
}

/** The admin view from a GET: live from it; the config by `configRev` and each row's stored parts by their revisions. */
export function adminFromGet(old: DreamingAdmin | undefined, next: DreamingAdmin): DreamingAdmin {
  if (!old) return next;
  const c = next.configRev >= old.configRev ? next : old;
  return {
    ...next,
    config: c.config,
    configRev: c.configRev,
    users: next.users.map((u) =>
      rowFromGet(
        old.users.find((x) => x.userId === u.userId),
        u,
      ),
    ),
  };
}

/** The admin's config save answer: only the config, only if not older. */
export function adminConfigFromPut(old: DreamingAdmin | undefined, put: DreamingAdmin): DreamingAdmin {
  if (!old) return put;
  return put.configRev >= old.configRev ? { ...old, config: put.config, configRev: put.configRev } : old;
}

/** A youth row's save answer: only its stored parts, each only if not older — never `youth`, status or problems. */
export function rowFromPut(
  view: DreamingAdmin | undefined,
  row: DreamingUserStatus,
): DreamingAdmin | undefined {
  if (!view) return view;
  return { ...view, users: view.users.map((u) => (u.userId === row.userId ? rowStored(u, row) : u)) };
}

/** A save's answer into the cache (`merge`: its fromPut), then refetched. */
export function applySaved<T>(
  qc: QueryClient,
  key: QueryKey,
  merge: (old: T | undefined) => T | undefined,
): void {
  qc.setQueryData<T>(key, (old) => merge(old));
  void qc.invalidateQueries({ queryKey: key });
}
