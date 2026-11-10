import { EventEmitter } from "node:events";

/**
 * In-process domain events. `user-access-changed` fires when a user's sessions are revoked or their role
 * changes, so long-lived connections (SSE, #12) can close or re-check permissions.
 */
export type UserAccessChanged = {
  userId: string;
  reason: "deactivated" | "role_changed" | "password_changed";
};

type EventMap = { "user-access-changed": [UserAccessChanged] };

export class AppEvents extends EventEmitter<EventMap> {}
