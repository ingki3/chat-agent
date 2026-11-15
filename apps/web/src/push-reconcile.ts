/**
 * What to do so the server's registration for this login session matches the browser's real push
 * subscription (#34). Pure, so it is unit-tested (apps/web/test/push-reconcile.test.ts).
 *
 * - `hasSubscription`: the browser has a subscription and notifications are allowed.
 * - `current`: the server has a device registered by *this* session; `match`: the server says one of this
 *   session's devices has exactly the browser's endpoint (compared on the server, `POST /api/push/devices/check`).
 * - `marker`: the service worker could not register a renewed subscription (offline, 401/403 after the app or
 *   Access session ran out) and noted the session tag the subscription had been turned on under.
 * - `sessionTag`: this login session's tag.
 *
 * The browser decides, but recovery is bound to the session that opted in:
 * - no subscription → the server row is stale (`remove`);
 * - this session's row is for an older subscription → `replace` (one server transaction, so a failure keeps the
 *   old row and the next start tries again);
 * - this session lost its row while re-registering failed → `register`, only if the marker names this session;
 * - anything else stays off: a device turned off elsewhere, a new login, another account — and a marker left by
 *   another session is dropped. Those must opt in with the button.
 */
export type ReconcileAction = "none" | "register" | "replace" | "remove";

export function reconcileAction(i: {
  hasSubscription: boolean;
  current: boolean;
  match: boolean;
  marker: { sessionTag: string | null } | null;
  sessionTag: string;
}): ReconcileAction {
  if (!i.hasSubscription) return i.current ? "remove" : "none";
  if (i.current) return i.match ? "none" : "replace";
  return i.marker !== null && i.marker.sessionTag === i.sessionTag ? "register" : "none";
}
