import type { FastifyInstance, FastifyReply } from "fastify";
import {
  CreateConversationRequest,
  EditMessageRequest,
  ListConversationsQuery,
  ListMessagesQuery,
  SendMessageRequest,
  UpdateConversationRequest,
} from "@agentlee/shared";
import type { z } from "zod";
import { deny } from "../auth/plugin.js";
import { toConversation, toMessage, type ConversationStore } from "./store.js";

const KIND = "conversation";
const conv = (action: "read" | "write" | "delete") => ({ resource: { kind: KIND, action } });
const notFound = (reply: FastifyReply) =>
  reply.code(404).header("Cache-Control", "no-store").send({ error: "not_found" });

function parse<T extends z.ZodType>(schema: T, value: unknown, reply: FastifyReply): z.infer<T> | undefined {
  const r = schema.safeParse(value);
  if (!r.success) {
    void deny(reply, 400, "invalid_request");
    return undefined;
  }
  return r.data;
}

type IdParams = { id: string };
type MsgParams = { id: string; messageId: string };

/**
 * Conversation API (#11). Every route with an id goes through the #10 resource check (`config.resource`), so
 * the handlers below only ever see conversations the caller may use. Messages are looked up within the
 * conversation, so a message id from another conversation is simply not found.
 */
export function registerConversationRoutes(app: FastifyInstance, store: ConversationStore): void {
  app.resources.register(KIND, (id) => {
    const c = store.get(id);
    // Sharing (#29) will fill sharedWith from its projection.
    return c ? { kind: KIND, id: c.id, ownerId: c.ownerId, sharedWith: [] } : undefined;
  });

  app.get(
    "/api/conversations",
    { config: { noResource: "lists only the caller's own conversations" } },
    async (req, reply) => {
      const q = parse(ListConversationsQuery, req.query, reply);
      if (!q) return reply;
      const page = store.list(req.ctx.user!.id, {
        q: q.q || undefined,
        pinned: q.pinned === undefined ? undefined : q.pinned === "true",
        limit: q.limit,
        cursor: q.cursor,
      });
      return reply
        .header("Cache-Control", "no-store")
        .send({ items: page.items.map(toConversation), nextCursor: page.nextCursor });
    },
  );

  app.post(
    "/api/conversations",
    { config: { noResource: "creates a conversation owned by the caller" } },
    async (req, reply) => {
      const body = parse(CreateConversationRequest, req.body ?? {}, reply);
      if (!body) return reply;
      return reply.code(201).send(toConversation(store.create(req.ctx.user!.id, { title: body.title })));
    },
  );

  app.get<{ Params: IdParams }>("/api/conversations/:id", { config: conv("read") }, async (req, reply) =>
    reply.header("Cache-Control", "no-store").send(toConversation(store.get(req.params.id)!)),
  );

  app.patch<{ Params: IdParams }>("/api/conversations/:id", { config: conv("write") }, async (req, reply) => {
    const body = parse(UpdateConversationRequest, req.body, reply);
    if (!body) return reply;
    if (body.title !== undefined) store.rename(req.params.id, body.title);
    if (body.pinned !== undefined) store.setPinned(req.params.id, body.pinned);
    return reply.send(toConversation(store.get(req.params.id)!));
  });

  app.delete<{ Params: IdParams }>(
    "/api/conversations/:id",
    { config: conv("delete") },
    async (req, reply) => {
      store.delete(req.params.id);
      return reply.send({ ok: true });
    },
  );

  app.get<{ Params: IdParams }>(
    "/api/conversations/:id/messages",
    { config: conv("read") },
    async (req, reply) => {
      const q = parse(ListMessagesQuery, req.query, reply);
      if (!q) return reply;
      const rows = store.messages(req.params.id, { before: q.before, limit: q.limit });
      const oldest = rows[0];
      return reply.header("Cache-Control", "no-store").send({
        items: rows.map(toMessage),
        // Older page exists when the oldest returned message is not the first one.
        nextBefore: oldest && rows.length === q.limit ? oldest.seq : null,
      });
    },
  );

  // Appends the user's message. Generating the reply is the runtime pipeline's job (#12).
  app.post<{ Params: IdParams }>(
    "/api/conversations/:id/messages",
    { config: conv("write") },
    async (req, reply) => {
      const body = parse(SendMessageRequest, req.body, reply);
      if (!body) return reply;
      const m = store.append(req.params.id, { role: "user", parts: [{ type: "text", text: body.text }] });
      return reply.code(201).send(toMessage(m));
    },
  );

  app.post<{ Params: MsgParams }>(
    "/api/conversations/:id/messages/:messageId/edit",
    { config: conv("write") },
    async (req, reply) => {
      const body = parse(EditMessageRequest, req.body, reply);
      if (!body) return reply;
      const m = store.edit(req.params.id, req.params.messageId, body.text);
      if (!m) return notFound(reply);
      return reply.send({ message: toMessage(m), revision: store.get(req.params.id)!.revision });
    },
  );

  app.post<{ Params: MsgParams }>(
    "/api/conversations/:id/messages/:messageId/regenerate",
    { config: conv("write") },
    async (req, reply) => {
      const m = store.regenerate(req.params.id, req.params.messageId);
      if (!m) return notFound(reply);
      return reply.send({ message: toMessage(m), revision: store.get(req.params.id)!.revision });
    },
  );

  app.get<{ Params: MsgParams }>(
    "/api/conversations/:id/messages/:messageId/versions",
    { config: conv("read") },
    async (req, reply) => {
      const versions = store.versions(req.params.id, req.params.messageId);
      if (!versions.length) return notFound(reply);
      return reply.header("Cache-Control", "no-store").send({ items: versions.map(toMessage) });
    },
  );
}
