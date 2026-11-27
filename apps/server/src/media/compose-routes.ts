import type { FastifyInstance } from "fastify";
import { COMPOSE_ENDED } from "@agentlee/shared";
import { watchAccess } from "../authz/resources.js";
import type { ConversationStore } from "../conversations/store.js";
import { openSse } from "../sse.js";
import type { ComposeJobs } from "./compose-jobs.js";

const KIND = "compose-job";
type IdParams = { id: string };

/**
 * The composition cards (#238 stage 4-1). A job belongs to its conversation's owner, who alone reads it, follows it and
 * reads its subtitle track (resource kind "compose-job" — no shared viewer, like the video cards). Nothing on it is
 * changed from the page: the job runs on the server. An open stream closes when access ends.
 */
export function registerComposeRoutes(
  app: FastifyInstance,
  jobs: ComposeJobs,
  conversations: Pick<ConversationStore, "get">,
  opts: { heartbeatMs?: number } = {},
): void {
  app.resources.register(KIND, (id) => {
    const r = jobs.get(id);
    const c = r && conversations.get(r.conversationId);
    return r && c ? { kind: KIND, id: r.id, ownerId: c.ownerId, scope: c.id } : undefined;
  });
  const read = { config: { resource: { kind: KIND, action: "read" as const } } };

  app.get<{ Params: IdParams }>("/api/compose-jobs/:id", read, async (req, reply) =>
    reply.header("Cache-Control", "no-store").send(jobs.view(jobs.get(req.params.id)!)),
  );

  /** The player's subtitle track: the timeline's subtitles as WebVTT (the MP4 carries the same as `mov_text`). */
  app.get<{ Params: IdParams }>("/api/compose-jobs/:id/subtitles.vtt", read, async (req, reply) => {
    const vtt = jobs.vtt(jobs.get(req.params.id)!);
    if (vtt === undefined)
      return reply.code(404).header("Cache-Control", "no-store").send({ error: "compose_no_subtitles" });
    return reply
      .header("Cache-Control", "no-store")
      .header("Content-Type", "text/vtt; charset=utf-8")
      .header("X-Content-Type-Options", "nosniff")
      .send(vtt);
  });

  /** Live progress: the job after every change, until it has ended. */
  app.get<{ Params: IdParams }>("/api/compose-jobs/:id/events", read, async (req, reply) => {
    const stream = openSse(reply, opts.heartbeatMs === undefined ? {} : { heartbeatMs: opts.heartbeatMs });
    const stopWatching = watchAccess(app, req, () => stream.close());
    stream.onClose(stopWatching);
    if (stream.closed) return;
    const push = () => {
      try {
        const row = jobs.get(req.params.id);
        if (!row) return stream.close();
        stream.send("job", jobs.view(row));
        if (COMPOSE_ENDED.has(row.status)) stream.close();
      } catch {
        stream.close();
      }
    };
    const off = jobs.subscribe(req.params.id, push);
    stream.onClose(off);
    stream.onClose(jobs.addStream(() => stream.close()));
    push();
  });
}
