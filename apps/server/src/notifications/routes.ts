import type { FastifyInstance, FastifyReply } from "fastify";
import { NotificationPrefs, PushSubscriptionRequest } from "@agentlee/shared";
import { z } from "zod";
import { deny } from "../auth/plugin.js";
import { SubscriptionError, toNotification, type NotificationService } from "./service.js";

const NOTIFICATION = "notification";
const DEVICE = "push-device";
const noStore = (reply: FastifyReply) => reply.header("Cache-Control", "no-store");
const ListQuery = z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) });

function parse<T extends z.ZodType>(schema: T, value: unknown, reply: FastifyReply): z.infer<T> | undefined {
  const r = schema.safeParse(value);
  if (!r.success) {
    void deny(reply, 400, "invalid_request");
    return undefined;
  }
  return r.data;
}

/**
 * Notification API (#34). Inbox, quiet hours and devices are always the caller's own: list routes filter by the
 * session's user, and routes naming an id go through the resource check (owner only).
 */
export function registerNotificationRoutes(app: FastifyInstance, service: NotificationService): void {
  app.resources.register(NOTIFICATION, (id) => {
    const n = service.get(id);
    return n && n.pushState !== "cancelled" ? { kind: NOTIFICATION, id: n.id, ownerId: n.userId } : undefined;
  });
  app.resources.register(DEVICE, (id) => {
    const d = service.device(id);
    return d ? { kind: DEVICE, id: d.id, ownerId: d.userId } : undefined;
  });

  app.get(
    "/api/notifications",
    { config: { noResource: "lists only the caller's own notifications" } },
    async (req, reply) => {
      const q = parse(ListQuery, req.query ?? {}, reply);
      if (!q) return reply;
      return noStore(reply).send(service.list(req.ctx.user!.id, q.limit));
    },
  );

  app.get(
    "/api/notifications/unread",
    { config: { noResource: "the caller's own unread count" } },
    async (req, reply) => noStore(reply).send({ unread: service.unread(req.ctx.user!.id) }),
  );

  app.post<{ Params: { id: string } }>(
    "/api/notifications/:id/read",
    { config: { resource: { kind: NOTIFICATION, action: "write" } } },
    async (req, reply) => {
      service.markRead(req.ctx.user!.id, req.params.id);
      return noStore(reply).send(toNotification(service.get(req.params.id)!));
    },
  );

  app.post(
    "/api/notifications/read-all",
    { config: { noResource: "marks the caller's own notifications" } },
    async (req, reply) => {
      service.markAllRead(req.ctx.user!.id);
      return noStore(reply).send({ unread: service.unread(req.ctx.user!.id) });
    },
  );

  app.post(
    "/api/notifications/test",
    { config: { noResource: "sends a test notification to the caller" } },
    async (req, reply) => {
      const id = service.publish(req.ctx.user!.id, { kind: "test" });
      return noStore(reply)
        .code(201)
        .send({ id: id ?? null });
    },
  );

  app.get(
    "/api/notifications/prefs",
    { config: { noResource: "the caller's own notification settings" } },
    async (req, reply) => noStore(reply).send(service.prefs(req.ctx.user!.id)),
  );

  app.put(
    "/api/notifications/prefs",
    { config: { noResource: "the caller's own notification settings" } },
    async (req, reply) => {
      const body = parse(NotificationPrefs, req.body, reply);
      if (!body) return reply;
      return noStore(reply).send(service.setPrefs(req.ctx.user!.id, body));
    },
  );

  app.get(
    "/api/push/key",
    { config: { noResource: "the service's public VAPID key" } },
    async (_req, reply) => noStore(reply).send({ publicKey: service.vapid.publicKey }),
  );

  app.get(
    "/api/push/devices",
    { config: { noResource: "lists only the caller's own devices" } },
    async (req, reply) =>
      noStore(reply).send({ devices: service.devices(req.ctx.user!.id, req.ctx.sessionToken) }),
  );

  // Binds this browser to the caller's account and current login session (gone on logout).
  app.post(
    "/api/push/devices",
    { config: { noResource: "registers a device for the caller's own session" } },
    async (req, reply) => {
      const body = parse(PushSubscriptionRequest, req.body, reply);
      if (!body) return reply;
      try {
        const id = service.subscribe(req.ctx.user!.id, req.ctx.sessionToken!, body);
        return noStore(reply)
          .code(201)
          .send({ devices: service.devices(req.ctx.user!.id, req.ctx.sessionToken), id });
      } catch (e) {
        if (e instanceof SubscriptionError) return deny(reply, 400, "invalid_request");
        throw e;
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/push/devices/:id",
    { config: { resource: { kind: DEVICE, action: "delete" } } },
    async (req, reply) => {
      service.removeDevice(req.params.id);
      return noStore(reply).send({ devices: service.devices(req.ctx.user!.id, req.ctx.sessionToken) });
    },
  );
}
