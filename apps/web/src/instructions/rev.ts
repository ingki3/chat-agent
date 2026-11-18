import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type {
  DreamingAdmin,
  DreamingConfig,
  DreamingPromptView,
  DreamingSettings,
  DreamingUserStatus,
  MemoryPrefs,
  MyDreaming,
  NotificationPrefs,
} from "@agentlee/shared";

/**
 * Server revisions (#188 reviews 9–11): every settings resource — a user's 기억 정리 settings and prompt, their 반영 방식,
 * the admin's config, each youth account's settings, the notification preferences — carries a `rev` the server raises
 * by one on **every** write of it (a save, a background rescrub…), in the same statement. The order is the server's.
 *
 * Each answer has two parts, classified field by field below (`… satisfies Record<keyof T, Part>` — a new field does
 * not typecheck until it is classified):
 * - **stored** settings the rev covers — kept from the answer with the higher rev. A GET wins a tie; a save's answer
 *   only counts when its rev is strictly higher (an equal-rev GET already shows that very write, possibly scrubbed
 *   since);
 * - **live** state (whether it runs now, `problem`, the connection choices, a youth flag, run results…) — only from
 *   GETs: React Query runs one GET per key at a time and drops a cancelled one, so the latest successful GET is the
 *   newest. A save's answer never touches it.
 * `liveRev` (client side): the rev of the GET the live part came from — `rev > liveRev` means the stored settings are
 * newer than what the live part was computed for (a save not confirmed by a GET yet).
 */

type Revved = { rev: number };
type Part = "stored" | "live";
/** A cached answer: with the rev of the GET its live part came from. */
export type Cached<T> = T & { liveRev?: number };

const storedKeys = <T>(fields: Record<keyof T, Part>) =>
  (Object.keys(fields) as (keyof T)[]).filter((k) => fields[k] === "stored" && k !== "rev");

const pick = <T extends object>(o: T, keys: readonly (keyof T)[]): Partial<T> =>
  Object.fromEntries(keys.map((k) => [k, o[k]])) as Partial<T>;

/** Results of a save's merge: put into the cache as they are (`setQueryData` runs `structuralSharing` too). */
const fromSave = new WeakSet<object>();
const saved = <T extends object>(v: T): T => (fromSave.add(v), v);

/** The answer with the higher rev (`next` on a tie) — for resources that are all stored settings. */
export function newer<T extends Revved>(old: T | undefined, next: T): T {
  return !old || next.rev >= old.rev ? next : old;
}

/** A GET's answer: its live part always (and its rev as `liveRev`); the stored part only if not older. */
export function fromGet<T extends Revved>(fields: Record<keyof T, Part>) {
  const keys = storedKeys<T>(fields);
  return (old: Cached<T> | undefined, next: T): Cached<T> => {
    if (fromSave.has(next)) return next;
    const merged = !old || next.rev >= old.rev ? next : { ...next, ...pick(old, keys), rev: old.rev };
    return { ...merged, liveRev: next.rev };
  };
}

/** A save's answer: only the stored part, only if strictly newer; the live part (and `liveRev`) stay the cache's. */
export function fromPut<T extends Revved>(fields: Record<keyof T, Part>) {
  const keys = storedKeys<T>(fields);
  return (old: Cached<T> | undefined, put: T): Cached<T> =>
    !old
      ? saved({ ...put, liveRev: put.rev })
      : put.rev > old.rev
        ? saved({ ...old, ...pick(put, keys), rev: put.rev })
        : old;
}

/** For `useQuery({ structuralSharing })`. */
export const sharing =
  <T>(merge: (old: T | undefined, next: T) => T) =>
  (old: unknown, next: unknown): unknown =>
    merge(old as T | undefined, next as T);

// ---- the field maps (exhaustive: typecheck fails on an unclassified field) ----

/** Nested stored objects: every field is part of the stored settings. */
export const SETTINGS_FIELDS = {
  enabled: "stored",
  time: "stored",
  runtime: "stored",
  connectionId: "stored",
  model: "stored",
} as const satisfies Record<keyof DreamingSettings, "stored">;
export const PROMPT_FIELDS = {
  content: "stored",
  custom: "stored",
  updatedAt: "stored",
  // The default and the fixed rules are the server's constants, sent with the stored prompt.
  defaultContent: "stored",
  fixedRules: "stored",
} as const satisfies Record<keyof DreamingPromptView, "stored">;
export const CONFIG_FIELDS = {
  enabled: "stored",
  tokenCap: "stored",
  allowed: "stored",
} as const satisfies Record<keyof DreamingConfig, "stored">;

/** 설정 → 내 지침 → 기억 정리. */
export const MINE_FIELDS = {
  rev: "stored",
  settings: "stored",
  prompt: "stored",
  enabled: "live",
  time: "live",
  canEdit: "live",
  problem: "live",
  choices: "live",
  runs: "live",
  proposals: "live",
} as const satisfies Record<keyof MyDreaming, Part>;
export const mineFromGet = fromGet<MyDreaming>(MINE_FIELDS);
export const mineFromPut = fromPut<MyDreaming>(MINE_FIELDS);

/** 기억 반영 방식. */
export const MODE_FIELDS = { rev: "stored", applyMode: "stored", locked: "live" } as const satisfies Record<
  keyof MemoryPrefs,
  Part
>;
export const modeFromGet = fromGet<MemoryPrefs>(MODE_FIELDS);
export const modeFromPut = fromPut<MemoryPrefs>(MODE_FIELDS);

/** Notification preferences: all stored. */
export type Prefs = NotificationPrefs & Revved;
export const PREFS_FIELDS = {
  quietStart: "stored",
  quietEnd: "stored",
  timeZone: "stored",
  memoryProposals: "stored",
  memoryApplied: "stored",
  memoryFailed: "stored",
  rev: "stored",
} as const satisfies Record<keyof Prefs, "stored">;
export const prefsFromGet = newer<Prefs>;
/** A save's answer: only if strictly newer (an equal-rev GET already shows that write). */
export const prefsFromPut = (old: Prefs | undefined, put: Prefs): Prefs =>
  !old || put.rev > old.rev ? saved(put) : old;

/** One admin row: two stored parts with their own revisions; the rest live. */
export const ROW_FIELDS = {
  rev: "stored",
  enabled: "stored",
  settings: "stored",
  customPrompt: "stored",
  applyModeRev: "stored",
  applyMode: "stored",
  userId: "live",
  name: "live",
  active: "live",
  youth: "live",
  problem: "live",
  time: "live",
  today: "live",
  last: "live",
} as const satisfies Record<keyof DreamingUserStatus, Part>;
const ROW_SETTINGS = [
  "enabled",
  "settings",
  "customPrompt",
] as const satisfies readonly (keyof DreamingUserStatus)[];

/** The admin view. */
export const ADMIN_FIELDS = {
  config: "stored",
  configRev: "stored",
  users: "live", // each row merged by ROW_FIELDS
  unavailable: "live",
  candidates: "live",
  manualRuns: "live",
} as const satisfies Record<keyof DreamingAdmin, Part>;

/** A row as shown: 반영 방식 only for a youth account (by its live flag — review 11). */
const normalized = (r: DreamingUserStatus): DreamingUserStatus => (r.youth ? r : { ...r, applyMode: null });

/** A row: live from `live`; the settings part and the 반영 방식 part each from the higher revision of the two. */
function row(live: DreamingUserStatus, a: DreamingUserStatus, b: DreamingUserStatus, strict: boolean) {
  const later = (x: number, y: number) => (strict ? x > y : x >= y);
  const s = later(b.rev, a.rev) ? b : a;
  const m = later(b.applyModeRev, a.applyModeRev) ? b : a;
  return normalized({
    ...live,
    ...pick(s, ROW_SETTINGS),
    rev: s.rev,
    applyMode: m.applyMode,
    applyModeRev: m.applyModeRev,
  });
}

/** A GET's row (a GET wins a tie). */
export function rowFromGet(
  old: DreamingUserStatus | undefined,
  next: DreamingUserStatus,
): DreamingUserStatus {
  return old ? row(next, old, next, false) : normalized(next);
}

/** The admin view from a GET: live from it; the config by `configRev` and each row's stored parts by their revisions. */
export function adminFromGet(old: DreamingAdmin | undefined, next: DreamingAdmin): DreamingAdmin {
  if (fromSave.has(next)) return next;
  const users = next.users.map((u) =>
    rowFromGet(
      old?.users.find((x) => x.userId === u.userId),
      u,
    ),
  );
  if (!old) return { ...next, users };
  const c = next.configRev >= old.configRev ? next : old;
  return { ...next, config: c.config, configRev: c.configRev, users };
}

/** The admin's config save answer: only the config, only if strictly newer. */
export function adminConfigFromPut(old: DreamingAdmin | undefined, put: DreamingAdmin): DreamingAdmin {
  if (!old) return saved(put);
  return put.configRev > old.configRev
    ? saved({ ...old, config: put.config, configRev: put.configRev })
    : old;
}

/** A youth row's save answer: only its stored parts, each only if strictly newer — never `youth`, status or problems. */
export function rowFromPut(
  view: DreamingAdmin | undefined,
  put: DreamingUserStatus,
): DreamingAdmin | undefined {
  if (!view) return view;
  return saved({
    ...view,
    users: view.users.map((u) => (u.userId === put.userId ? row(u, u, put, true) : u)),
  });
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
