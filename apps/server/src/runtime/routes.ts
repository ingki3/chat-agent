import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { watchAccess } from "../authz/resources.js";
import { toMessage, type ConversationStore } from "../conversations/store.js";
import { RunAccessDenied } from "../connections/access.js";
import { AttachmentError } from "../files/store.js";
import { openSse } from "../sse.js";
import { IdempotencyConflictError, RunBusyError, ShuttingDownError, toRun, type RunManager } from "./runs.js";

const KIND = "run";

/** Thrown by a `prepare` step when the message to edit / regenerate is not (or no longer) in the history. */
export class MessageNotFoundError extends Error {}

/** Reads a valid `Idempotency-Key` (or none). Invalid keys are refused rather than ignored. */
export function idempotencyKey(req: FastifyRequest): string | undefined | false {
  const v = req.headers["idempotency-key"];
  if (v === undefined) return undefined;
  return typeof v === "string" && /^[A-Za-z0-9_.:-]{8,200}$/.test(v) ? v : false;
}

/** Shared by send / edit / regenerate: start the run and answer with the new messages and the run. */
export function startRun(
  reply: FastifyReply,
  runs: RunManager,
  conversations: ConversationStore,
  input: Parameters<RunManager["begin"]>[0],
  created = 201,
) {
  try {
    const r = runs.begin(input);
    return reply.code(r.reused ? 200 : created).send({
      message: r.user ? toMessage(r.user) : null,
      assistant: toMessage(conversations.messageById(r.assistant.id)!),
      run: toRun(r.run),
      revision: conversations.get(input.conversationId)!.revision,
    });
  } catch (e) {
    if (e instanceof RunBusyError) return reply.code(409).send({ error: "run_in_progress" });
    if (e instanceof ShuttingDownError) return reply.code(503).send({ error: "shutting_down" });
    if (e instanceof IdempotencyConflictError) return reply.code(409).send({ error: "idempotency_conflict" });
    if (e instanceof MessageNotFoundError) return reply.code(404).send({ error: "not_found" });
    // `fileIds` that are not this conversation's unsent files (#22): nothing was created.
    if (e instanceof AttachmentError) return reply.code(400).send({ error: "invalid_attachment" });
    // Runtime, model, effort or connection not allowed for this user (#17): nothing was created.
    if (e instanceof RunAccessDenied) return reply.code(403).send({ error: e.code });
    throw e;
  }
}

/**
 * Runs API (#12): status, live events over SSE with replay (`Last-Event-ID`), interrupt. Runs belong to the
 * conversation's owner (resource kind "run" → the conversation's access rule).
 */
export function registerRunRoutes(
  app: FastifyInstance,
  runs: RunManager,
  conversations: ConversationStore,
  opts: { heartbeatMs?: number } = {},
): void {
  app.resources.register(KIND, (id) => {
    const r = runs.get(id);
    const c = r && conversations.get(r.conversationId);
    return r && c ? { kind: KIND, id: r.id, ownerId: c.ownerId, sharedWith: [] } : undefined;
  });

  app.get<{ Params: { id: string } }>(
    "/api/runs/:id",
    { config: { resource: { kind: KIND, action: "read" } } },
    async (req, reply) => reply.header("Cache-Control", "no-store").send(toRun(runs.get(req.params.id)!)),
  );

  app.get<{ Params: { id: string } }>(
    "/api/conversations/:id/active-run",
    { config: { resource: { kind: "conversation", action: "read" } } },
    async (req, reply) => {
      const r = runs.active(req.params.id);
      return reply.header("Cache-Control", "no-store").send({ run: r ? toRun(r) : null });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/runs/:id/interrupt",
    { config: { resource: { kind: KIND, action: "write" } } },
    async (req, reply) => reply.send(toRun((await runs.interrupt(req.params.id))!)),
  );

  /**
   * Events. Replays everything after `Last-Event-ID` (header, or `?lastEventId=` for clients that cannot set
   * it), then follows live until the run ends. 15 s keep-alive comments, no compression or proxy buffering.
   */
  app.get<{ Params: { id: string }; Querystring: { lastEventId?: string } }>(
    "/api/runs/:id/events",
    { config: { resource: { kind: KIND, action: "read" } } },
    async (req, reply) => {
      const run = runs.get(req.params.id)!;
      const raw = req.headers["last-event-id"] ?? req.query.lastEventId ?? "0";
      const after = /^\d{1,9}$/.test(String(raw)) ? Number(raw) : 0;
      if (runs.eventsExpired(run)) return reply.code(410).send({ error: "events_expired" });

      const stream = openSse(reply, opts.heartbeatMs === undefined ? {} : { heartbeatMs: opts.heartbeatMs });
      // Access first: it may have been revoked since the request was checked. Nothing is replayed if so.
      const stopWatching = watchAccess(app, req, () => stream.close());
      stream.onClose(stopWatching);
      if (stream.closed) return;
      let sent = after;
      const send = (seq: number, data: { type: string }) => {
        if (seq <= sent) return; // replay and live overlap: never twice
        sent = seq;
        stream.send(data.type, data, seq);
      };
      // Subscribe before replaying so nothing emitted in between is lost; duplicates are skipped by seq.
      const buffered: [number, { type: string }][] = [];
      let replaying = true;
      const unsubscribe = runs.subscribe(
        run.id,
        (seq, e) => (replaying ? buffered.push([seq, e]) : send(seq, e)),
        () => stream.close(),
      );
      for (const e of runs.eventsAfter(run.id, after)) send(e.seq, e.data);
      replaying = false;
      for (const [seq, e] of buffered) send(seq, e);
      stream.onClose(() => unsubscribe?.());
      // Already over (or ended during the replay): nothing more will come.
      if (!unsubscribe || runs.get(run.id)!.endedAt !== null) stream.close();
    },
  );
}
