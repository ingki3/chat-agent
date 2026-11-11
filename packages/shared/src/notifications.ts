import { z } from "zod";

/**
 * Notifications (#34, PRD FR-13): the in-app inbox (🔔), web push devices and quiet hours.
 * The server composes every title and body itself (see apps/server/src/notifications/compose.ts); the client
 * only ever shows what it gets.
 */

/** What a notification is about. Admin kinds go to admins only (re-checked right before sending). */
export const NotificationKind = z.enum([
  "schedule_succeeded",
  "schedule_failed",
  "share_received",
  "connection_lost",
  "system_warning",
  "daily_cost",
  "test",
]);
export type NotificationKind = z.infer<typeof NotificationKind>;

export const Notification = z.object({
  id: z.string(),
  kind: NotificationKind,
  title: z.string(),
  body: z.string(),
  /** In-app path to open (same origin), e.g. `/c/<id>`. */
  url: z.string(),
  createdAt: z.number().int(),
  readAt: z.number().int().nullable(),
});
export type Notification = z.infer<typeof Notification>;

export const NotificationList = z.object({ items: z.array(Notification), unread: z.number().int() });
export type NotificationList = z.infer<typeof NotificationList>;
export const UnreadCount = z.object({ unread: z.number().int() });

/** "HH:MM", 24-hour clock. */
export const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** Quiet hours (방해 금지): both set, or both null (off). Start and end may wrap midnight (23:00 ~ 07:00). */
export const NotificationPrefs = z
  .object({
    quietStart: ClockTime.nullable(),
    quietEnd: ClockTime.nullable(),
    /** IANA time zone the clock times are in. */
    timeZone: z.string().min(1).max(64),
  })
  .refine((p) => (p.quietStart === null) === (p.quietEnd === null), { message: "set both or neither" })
  .refine((p) => p.quietStart === null || p.quietStart !== p.quietEnd, { message: "start and end differ" });
export type NotificationPrefs = z.infer<typeof NotificationPrefs>;

/** A browser's push subscription (`PushSubscription.toJSON()`), plus a short device label. */
export const PushSubscriptionRequest = z.object({
  endpoint: z.string().max(2048),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{80,100}={0,2}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{16,32}={0,2}$/),
  }),
  label: z.string().trim().min(1).max(40),
});
export type PushSubscriptionRequest = z.infer<typeof PushSubscriptionRequest>;

/** One of the user's devices that receives push. `current` = registered by this login session. */
export const PushDevice = z.object({
  id: z.string(),
  label: z.string(),
  createdAt: z.number().int(),
  lastSentAt: z.number().int().nullable(),
  current: z.boolean(),
});
export type PushDevice = z.infer<typeof PushDevice>;
export const PushDeviceList = z.object({ devices: z.array(PushDevice) });
export const PushKey = z.object({ publicKey: z.string() });

/** What the service worker receives (JSON push payload). */
export const PushPayload = z.object({
  title: z.string(),
  body: z.string(),
  url: z.string(),
  /** Notification id (absent for a bundle). */
  id: z.string().optional(),
  tag: z.string(),
});
export type PushPayload = z.infer<typeof PushPayload>;
