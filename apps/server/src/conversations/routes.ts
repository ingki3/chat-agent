import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ChangeSettingsRequest,
  type ConsumeFallbackNoticeResponse,
  CreateConversationRequest,
  EditMessageRequest,
  ListConversationsQuery,
  ListMessagesQuery,
  RegenerateRequest,
  SendMessageRequest,
  UpdateConversationRequest,
} from "@agentlee/shared";
import type { z } from "zod";
import { deny } from "../auth/plugin.js";
import type { UserStore } from "../auth/users.js";
import { RunAccessDenied } from "../connections/access.js";
import type { DefaultsService } from "../users/defaults.js";
import { idempotencyKey, MessageNotFoundError, startRun } from "../runtime/routes.js";
import type { RunManager } from "../runtime/runs.js";
import { settingsOf, toConversation, toMessage, type ConversationStore } from "./store.js";

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

/** The per-turn choices of a request body (#17), without the text. */
const choiceOf = (body: z.infer<typeof SendMessageRequest>) => {
  const choice: Partial<typeof body> = { ...body };
  delete choice.text;
  return choice;
};
type MsgParams = { id: string; messageId: string };

/**
 * Conversation API (#11). Every route with an id goes through the #10 resource check (`config.resource`), so
 * the handlers below only ever see conversations the caller may use. Messages are looked up within the
 * conversation, so a message id from another conversation is simply not found.
 */
export function registerConversationRoutes(
  app: FastifyInstance,
  store: ConversationStore,
  runs: RunManager,
  /** Defaults and the chip (#19). Without them conversations start without settings (run manager tests). */
  deps?: { defaults: DefaultsService; users: UserStore },
): void {
  const refused = (reply: FastifyReply, e: unknown) => {
    // Runtime, model, effort or connection not allowed (#17's codes): 403, nothing changed.
    if (e instanceof RunAccessDenied)
      return reply.code(403).header("Cache-Control", "no-store").send({ error: e.code });
    throw e;
  };
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
      // New conversations start on the defaults without any picking step (FR-3.5, FR-12.2), with the FR-12.6
      // fallback (noticed once); a choice made on the chip before the first message is checked like a change.
      const user = deps?.users.byId(req.ctx.user!.id);
      let start: {
        settings: ReturnType<typeof settingsOf>;
        fallback: boolean;
        limitedUntil?: number | undefined;
      } = {
        settings: null,
        fallback: false,
      };
      if (deps && user) {
        try {
          start = body.settings
            ? { settings: deps.defaults.change(user, null, body.settings), fallback: false }
            : (deps.defaults.start(user) ?? start);
        } catch (e) {
          return refused(reply, e);
        }
      }
      return reply.code(201).send(
        toConversation(
          store.create(req.ctx.user!.id, {
            title: body.title,
            settings: start.settings,
            fallback: start.fallback,
            limitedUntil: start.limitedUntil,
          }),
        ),
      );
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
    if (body.researchMode !== undefined) store.setResearchMode(req.params.id, body.researchMode);
    return reply.send(toConversation(store.get(req.params.id)!));
  });

  // The fallback notice (#19, FR-12.6), taken atomically: only the caller that gets it shows it.
  app.post<{ Params: IdParams }>(
    "/api/conversations/:id/fallback-notice/consume",
    { config: conv("write") },
    async (req, reply) =>
      reply
        .header("Cache-Control", "no-store")
        .send({ notice: store.consumeFallbackNotice(req.params.id) } satisfies ConsumeFallbackNoticeResponse),
  );

  // The chip (#19, FR-3.5): runtime, model, effort or "공용으로 쓰기" of this conversation, from its next message on —
  // a reply being written now keeps what it started with. Not allowed → 403 with the run check's code. The divider
  // is written when the change takes effect (the next reply), see ConversationStore.syncSwitchDivider.
  app.put<{ Params: IdParams }>(
    "/api/conversations/:id/settings",
    { config: conv("write") },
    async (req, reply) => {
      const body = parse(ChangeSettingsRequest, req.body, reply);
      if (!body) return reply;
      const user = deps?.users.byId(req.ctx.user!.id);
      if (!deps || !user) return deny(reply, 404, "not_found");
      const c = store.get(req.params.id)!;
      let next;
      try {
        next = deps.defaults.change(user, settingsOf(c), body);
      } catch (e) {
        return refused(reply, e);
      }
      store.setSettings(c.id, next);
      return reply.header("Cache-Control", "no-store").send(toConversation(store.get(c.id)!));
    },
  );

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
      const page = store.messagePage(req.params.id, { before: q.before, limit: q.limit });
      return reply.header("Cache-Control", "no-store").send({
        items: page.items.map(toMessage),
        nextBefore: page.hasMore ? page.items[0]!.seq : null,
      });
    },
  );

  // Send / edit / regenerate all start a run (#12): the user message (if any) and a pending assistant message
  // are created in the same transaction as the one-run-per-conversation check.
  const key = (req: FastifyRequest, reply: FastifyReply) => {
    const k = idempotencyKey(req);
    if (k === false) void deny(reply, 400, "invalid_request");
    return k;
  };
  const previousOf = (conversationId: string, messageId: string) => {
    const m = store.message(conversationId, messageId);
    return m
      ? { runtime: (m.runtime as "claude-code" | "codex" | null) ?? null, model: m.model, effort: m.effort }
      : undefined;
  };
  const pending = (conversationId: string) =>
    store.append(conversationId, { role: "assistant", parts: [], status: "pending" });

  app.post<{ Params: IdParams }>(
    "/api/conversations/:id/messages",
    { config: conv("write") },
    async (req, reply) => {
      const body = parse(SendMessageRequest, req.body, reply);
      const k = body && key(req, reply);
      if (!body || k === false) return reply;
      return startRun(reply, runs, store, {
        conversationId: req.params.id,
        userId: req.ctx.user!.id,
        idempotencyKey: k,
        choice: choiceOf(body),
        prepare: (divider) => {
          divider();
          const user = store.append(req.params.id, {
            role: "user",
            parts: [{ type: "text", text: body.text }],
          });
          return { user, assistant: pending(req.params.id) };
        },
      });
    },
  );

  app.post<{ Params: MsgParams }>(
    "/api/conversations/:id/messages/:messageId/edit",
    { config: conv("write") },
    async (req, reply) => {
      const body = parse(EditMessageRequest, req.body, reply);
      const k = body && key(req, reply);
      if (!body || k === false) return reply;
      return startRun(
        reply,
        runs,
        store,
        {
          conversationId: req.params.id,
          userId: req.ctx.user!.id,
          idempotencyKey: k,
          choice: choiceOf(body),
          prepare: (divider) => {
            const user = store.edit(req.params.id, req.params.messageId, body.text, divider);
            if (!user) throw new MessageNotFoundError();
            return { user, assistant: pending(req.params.id) };
          },
        },
        200,
      );
    },
  );

  app.post<{ Params: MsgParams }>(
    "/api/conversations/:id/messages/:messageId/regenerate",
    { config: conv("write") },
    async (req, reply) => {
      const body = parse(RegenerateRequest, req.body ?? {}, reply);
      const k = body && key(req, reply);
      if (!body || k === false) return reply;
      return startRun(
        reply,
        runs,
        store,
        {
          conversationId: req.params.id,
          userId: req.ctx.user!.id,
          idempotencyKey: k,
          choice: body,
          previous: previousOf(req.params.id, req.params.messageId),
          prepare: (divider) => {
            const assistant = store.regenerate(req.params.id, req.params.messageId, divider);
            if (!assistant) throw new MessageNotFoundError();
            return { user: null, assistant };
          },
        },
        200,
      );
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
