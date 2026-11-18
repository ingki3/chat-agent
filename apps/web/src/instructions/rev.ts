import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { DreamingAdmin, DreamingUserStatus } from "@agentlee/shared";

/**
 * Server revisions (#188 review 9): every settings resource — a user's 기억 정리 settings and prompt, their 반영 방식,
 * the admin's config, each youth account's settings, the notification preferences — carries a `rev` the server raises
 * by one on every write, in the same statement. The order of writes is the server's, never a client clock.
 *
 * The page keeps, per resource, the response with the **highest** rev it has seen — from a GET or a PUT alike:
 * - a PUT answers with the merged stored resource and its rev, applied at once (`applySaved`) — so a refetch that
 *   fails afterwards changes nothing about what is shown;
 * - a GET that read data from before the save has a lower rev and is ignored (`structuralSharing`), as is a late PUT
 *   answer older than a GET already seen; equal revs take the newer answer (its derived fields are fresher);
 * - a cancelled GET is never applied (React Query drops it), and an applied one is only ever newer or equal.
 * After a save the query is invalidated (marked stale and refetched; reconnecting refetches it too).
 */

type Revved = { rev: number };

/** The newer of two answers for one resource (`next` on a tie). */
export function newer<T extends Revved>(old: T | undefined, next: T): T {
  return !old || next.rev >= old.rev ? next : old;
}

/** For `useQuery({ structuralSharing })`: a fetched answer never replaces a newer one already in the cache. */
export const keepNewest =
  <T extends Revved>() =>
  (old: unknown, next: unknown): unknown =>
    newer(old as T | undefined, next as T);

/** One user's row in the admin view: its settings part and its 반영 방식 part each by their own rev. */
export function newerUser(old: DreamingUserStatus | undefined, next: DreamingUserStatus): DreamingUserStatus {
  if (!old) return next;
  const s = next.rev >= old.rev ? next : old;
  const m = next.applyModeRev >= old.applyModeRev ? next : old;
  return {
    ...next,
    rev: s.rev,
    enabled: s.enabled,
    settings: s.settings,
    customPrompt: s.customPrompt,
    applyModeRev: m.applyModeRev,
    applyMode: m.applyMode,
  };
}

/** The admin view: the config by `configRev`, each user by `newerUser`, everything else from the newer answer. */
export function newerAdmin(old: DreamingAdmin | undefined, next: DreamingAdmin): DreamingAdmin {
  if (!old) return next;
  const c = next.configRev >= old.configRev ? next : old;
  return {
    ...next,
    config: c.config,
    configRev: c.configRev,
    users: next.users.map((u) =>
      newerUser(
        old.users.find((x) => x.userId === u.userId),
        u,
      ),
    ),
  };
}

/** A youth row's save answer into the admin view. */
export function withUser(
  view: DreamingAdmin | undefined,
  row: DreamingUserStatus,
): DreamingAdmin | undefined {
  if (!view) return view;
  return { ...view, users: view.users.map((u) => (u.userId === row.userId ? newerUser(u, row) : u)) };
}

/** A save's answer: into the cache if not older than what is there, then refetched. */
export function applySaved<T>(
  qc: QueryClient,
  key: QueryKey,
  merge: (old: T | undefined) => T | undefined,
): void {
  qc.setQueryData<T>(key, (old) => merge(old));
  void qc.invalidateQueries({ queryKey: key });
}
