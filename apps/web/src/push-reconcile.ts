/**
 * What to do so the server's registration for this login session matches the browser's real push
 * subscription (#34). Pure, so it is unit-tested (apps/web/test/push-reconcile.test.ts).
 *
 * - `endpointHash`: SHA-256 of the browser's current subscription endpoint, null when it has none (or
 *   notifications are not allowed any more).
 * - `current`: the server's device registered by this session, if any.
 * - `pending`: the service worker could not register a renewed subscription (offline, 401/403 after the app or
 *   Access session ran out) and left a note for the app.
 *
 * The browser decides: no subscription → the server row is stale (`remove`); a different subscription than the
 * one registered → `replace`; a subscription the server lost while re-registering failed → `register`. A
 * subscription with no row and no note stays off: the user turned this device off elsewhere, or this is another
 * account / a new login, which must opt in with the button.
 */
export type ReconcileAction = "none" | "register" | "replace" | "remove";

export function reconcileAction(i: {
  endpointHash: string | null;
  current: { endpointHash: string } | undefined;
  pending: boolean;
}): ReconcileAction {
  if (i.endpointHash === null) return i.current ? "remove" : "none";
  if (i.current) return i.current.endpointHash === i.endpointHash ? "none" : "replace";
  return i.pending ? "register" : "none";
}
