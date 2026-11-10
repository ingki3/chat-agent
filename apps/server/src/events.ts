import { EventEmitter } from "node:events";

/**
 * In-process domain events. `user-access-changed` fires when a user's sessions are revoked or their role
 * changes, so long-lived connections (SSE, #12) can close or re-check permissions.
 */
export type UserAccessChanged = {
  userId: string;
  reason: "deactivated" | "role_changed" | "password_changed" | "session_ended";
};

/** Sharing of a resource changed (e.g. share revoked, #29): open streams on it must re-check access. */
export type ResourceAccessChanged = { kind: string; id: string };

type EventMap = {
  "user-access-changed": [UserAccessChanged];
  "resource-access-changed": [ResourceAccessChanged];
};

export class AppEvents extends EventEmitter<EventMap> {}
