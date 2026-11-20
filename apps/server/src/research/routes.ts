import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  ApproveResearchRequest,
  ClarifyResearchRequest,
  RESEARCH_ENDED,
  StartResearchRequest,
} from "@agentlee/shared";
import type { z } from "zod";
import { deny } from "../auth/plugin.js";
import { watchAccess } from "../authz/resources.js";
import { RunAccessDenied } from "../connections/access.js";
import { toMessage, type ConversationStore } from "../conversations/store.js";
import { AttachmentError } from "../files/store.js";
import { sharedWith } from "../shares/projection.js";
import { openSse } from "../sse.js";
import { ResearchError, type ResearchEngine } from "./engine.js";
import { toResearchJob, type ResearchJobRow } from "./store.js";

const KIND = "research";
type IdParams = { id: string };

function parse<T extends z.ZodType>(schema: T, value: unknown, reply: FastifyReply): z.infer<T> | undefined {
  const r = schema.safeParse(value ?? {});
  if (!r.success) {
    void deny(reply, 400, "invalid_request");
    return undefined;
  }
  return r.data;
}

/**
 * 깊이 조사 API (#211). A job belongs to its conversation's owner, who alone starts, approves, edits, cancels and stops
 * it; a family member the conversation is shared with (#29) reads it — the card and its progress — only while its card
 * message is in their projection (resource kind "research", like a run's).
 */
export function registerResearchRoutes(
  app: FastifyInstance,
  engine: ResearchEngine,
  conversations: ConversationStore,
  opts: { heartbeatMs?: number; now?: () => number } = {},
): void {
  const now = opts.now ?? Date.now;
  app.resources.register(KIND, (id) => {
    const r = engine.get(id);
    const c = r && conversations.get(r.conversationId);
    return r && c
      ? {
          kind: KIND,
          id: r.id,
          ownerId: c.ownerId,
          sharedWith: sharedWith(app, c.id, (p) => p.messages.has(r.messageId)),
          scope: c.id,
        }
      : undefined;
  });

  const view = (req: FastifyRequest, row: ResearchJobRow) =>
    toResearchJob(row, { owned: row.ownerId === req.ctx.user!.id, now: now() });
  const refused = (reply: FastifyReply, e: unknown) => {
    if (e instanceof ResearchError)
      return reply.code(e.status).header("Cache-Control", "no-store").send({ error: e.code });
    if (e instanceof RunAccessDenied)
      return reply.code(403).header("Cache-Control", "no-store").send({ error: e.code });
    if (e instanceof AttachmentError) return reply.code(400).send({ error: "invalid_attachment" });
    throw e;
  };

  app.post<{ Params: IdParams }>(
    "/api/conversations/:id/research",
    { config: { resource: { kind: "conversation", action: "write" } } },
    async (req, reply) => {
      const body = parse(StartResearchRequest, req.body, reply);
      if (!body) return reply;
      try {
        const { row, user, card } = engine.start({
          conversationId: req.params.id,
          userId: req.ctx.user!.id,
          text: body.text,
          fileIds: body.fileIds,
          backend: body.backend,
        });
        return reply.code(201).send({
          job: view(req, row),
          message: toMessage(conversations.messageById(user.id) ?? user),
          assistant: toMessage(conversations.messageById(card.id) ?? card),
        });
      } catch (e) {
        return refused(reply, e);
      }
    },
  );

  app.get<{ Params: IdParams }>(
    "/api/research/:id",
    { config: { resource: { kind: KIND, action: "read" } } },
    async (req, reply) =>
      reply.header("Cache-Control", "no-store").send(view(req, engine.get(req.params.id)!)),
  );

  /** Live progress: the job after every change, until it has ended. 15 s keep-alive comments. */
  app.get<{ Params: IdParams }>(
    "/api/research/:id/events",
    { config: { resource: { kind: KIND, action: "read" } } },
    async (req, reply) => {
      const stream = openSse(reply, opts.heartbeatMs === undefined ? {} : { heartbeatMs: opts.heartbeatMs });
      const stopWatching = watchAccess(app, req, () => stream.close());
      stream.onClose(stopWatching);
      if (stream.closed) return;
      const push = () => {
        const row = engine.get(req.params.id);
        if (!row) return stream.close();
        stream.send("job", view(req, row));
        if (RESEARCH_ENDED.has(row.status)) stream.close();
      };
      const off = engine.subscribe(req.params.id, push);
      stream.onClose(off);
      // Ended at shutdown (preClose): a card waiting for approval never holds the server open.
      stream.onClose(engine.addStream(() => stream.close()));
      push();
    },
  );

  const action =
    (fn: (req: FastifyRequest<{ Params: IdParams }>) => ResearchJobRow) =>
    async (req: FastifyRequest<{ Params: IdParams }>, reply: FastifyReply) => {
      try {
        return reply.header("Cache-Control", "no-store").send(view(req, fn(req)));
      } catch (e) {
        return refused(reply, e);
      }
    };
  const write = { config: { resource: { kind: KIND, action: "write" as const } } };

  app.post<{ Params: IdParams }>("/api/research/:id/clarify", write, async (req, reply) => {
    const body = parse(ClarifyResearchRequest, req.body, reply);
    if (!body) return reply;
    return action((r) => engine.clarify(r.params.id, r.ctx.user!.id, body.answer))(req, reply);
  });
  app.post<{ Params: IdParams }>("/api/research/:id/approve", write, async (req, reply) => {
    const body = parse(ApproveResearchRequest, req.body, reply);
    if (!body) return reply;
    return action((r) => engine.approve(r.params.id, r.ctx.user!.id, body.subQuestions))(req, reply);
  });
  app.post<{ Params: IdParams }>(
    "/api/research/:id/cancel",
    write,
    action((r) => engine.cancel(r.params.id, r.ctx.user!.id)),
  );
  app.post<{ Params: IdParams }>(
    "/api/research/:id/stop",
    write,
    action((r) => engine.stop(r.params.id, r.ctx.user!.id)),
  );
}
