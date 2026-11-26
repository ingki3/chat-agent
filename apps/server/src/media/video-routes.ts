import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { VIDEO_ENDED, VideoJobActionRequest } from "@agentlee/shared";
import { deny, passwordChangePending } from "../auth/plugin.js";
import { can } from "../authz/policy.js";
import { watchAccess } from "../authz/resources.js";
import type { ConversationStore } from "../conversations/store.js";
import { openSse } from "../sse.js";
import { VideoError, type VideoJobs } from "./video-jobs.js";

const KIND = "video-job";
type IdParams = { id: string };

/**
 * The video cards (#238 stage 3, review item 6). A job belongs to its conversation's owner, who alone reads it, follows
 * it and approves or dismisses it (resource kind "video-job" — no shared viewer: the card names the cost and the
 * prompt). An open stream closes when access ends (a session ended, the account deactivated).
 */
export function registerVideoRoutes(
  app: FastifyInstance,
  jobs: VideoJobs,
  conversations: Pick<ConversationStore, "get">,
  opts: { heartbeatMs?: number } = {},
): void {
  app.resources.register(KIND, (id) => {
    const r = jobs.get(id);
    const c = r && conversations.get(r.conversationId);
    return r && c ? { kind: KIND, id: r.id, ownerId: c.ownerId, scope: c.id } : undefined;
  });
  const read = { config: { resource: { kind: KIND, action: "read" as const } } };
  const write = { config: { resource: { kind: KIND, action: "write" as const } } };
  const refused = (reply: FastifyReply, e: unknown) => {
    if (e instanceof VideoError)
      return reply
        .code(e.status)
        .header("Cache-Control", "no-store")
        .send({ error: e.code, ...(e.job ? { job: jobs.view(e.job) } : {}) });
    throw e;
  };
  /** The request's session, account and resource check, again (asked inside the approval's reserving step). */
  const stillAllowed = (req: FastifyRequest) => () => {
    const token = req.ctx.sessionToken;
    const u = token ? app.users?.sessionUser(token) : undefined;
    if (!u || u.id !== req.ctx.user?.id || !u.active || passwordChangePending(req, u)) return false;
    const ref = app.resources.load(KIND, (req.params as IdParams).id);
    return !!ref && can(u, "write", ref);
  };
  const body = (req: FastifyRequest, reply: FastifyReply) => {
    const r = VideoJobActionRequest.safeParse(req.body ?? {});
    if (!r.success) {
      void deny(reply, 400, "invalid_request");
      return undefined;
    }
    return r.data;
  };

  app.get<{ Params: IdParams }>("/api/video-jobs/:id", read, async (req, reply) =>
    reply.header("Cache-Control", "no-store").send(jobs.view(jobs.get(req.params.id)!)),
  );

  /** Live progress: the job after every change, until it has ended. 15 s keep-alive comments. */
  app.get<{ Params: IdParams }>("/api/video-jobs/:id/events", read, async (req, reply) => {
    const stream = openSse(reply, opts.heartbeatMs === undefined ? {} : { heartbeatMs: opts.heartbeatMs });
    const stopWatching = watchAccess(app, req, () => stream.close());
    stream.onClose(stopWatching);
    if (stream.closed) return;
    const push = () => {
      const row = jobs.get(req.params.id);
      if (!row) return stream.close();
      stream.send("job", jobs.view(row));
      if (VIDEO_ENDED.has(row.status)) stream.close();
    };
    const off = jobs.subscribe(req.params.id, push);
    stream.onClose(off);
    stream.onClose(jobs.addStream(() => stream.close()));
    push();
  });

  app.post<{ Params: IdParams }>("/api/video-jobs/:id/approve", write, async (req, reply) => {
    const b = body(req, reply);
    if (!b) return reply;
    try {
      const row = await jobs.approve(req.params.id, req.ctx.user!.id, b.version, stillAllowed(req));
      if (!row) return reply.code(404).header("Cache-Control", "no-store").send({ error: "not_found" });
      return reply.header("Cache-Control", "no-store").send(jobs.view(row));
    } catch (e) {
      return refused(reply, e);
    }
  });

  app.post<{ Params: IdParams }>("/api/video-jobs/:id/dismiss", write, async (req, reply) => {
    const b = body(req, reply);
    if (!b) return reply;
    try {
      return reply
        .header("Cache-Control", "no-store")
        .send(jobs.view(jobs.dismiss(req.params.id, req.ctx.user!.id, b.version)));
    } catch (e) {
      return refused(reply, e);
    }
  });
}
