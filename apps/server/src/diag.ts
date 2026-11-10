import type { FastifyInstance } from "fastify";
import { openSse, SSE_HEARTBEAT_MS } from "./sse.js";

export type DiagOptions = { tickMs?: number; heartbeatMs?: number; maxConcurrent?: number };

export const DIAG_MAX_SECONDS = 600;

/**
 * Measurement stream for `scripts/sse-probe.ts` (#8): one `tick` event per `tickMs` for `seconds`, then `done`.
 * Registered only when DIAG_STREAM=1. It carries no user data, but it must sit behind Access (and admin auth
 * once #9 lands) whenever it is enabled on the public hostname.
 */
export function registerDiag(app: FastifyInstance, opts: DiagOptions = {}): void {
  const tickMs = opts.tickMs ?? 1000;
  const maxConcurrent = opts.maxConcurrent ?? 2;
  let active = 0;

  // No app login: the probe runs with only the Access cookie. Off unless DIAG_STREAM=1; the trust boundary
  // (Access JWT, or the temporary gate) still applies.
  app.get<{ Querystring: { seconds?: string } }>(
    "/api/diag/stream",
    { config: { auth: "public" } },
    async (req, reply) => {
      const seconds = Number(req.query.seconds ?? 180);
      if (!Number.isInteger(seconds) || seconds < 1 || seconds > DIAG_MAX_SECONDS)
        return reply.code(400).send({ error: "invalid_seconds", max: DIAG_MAX_SECONDS });
      if (active >= maxConcurrent) return reply.code(429).send({ error: "too_many_streams" });

      active++;
      const total = Math.round((seconds * 1000) / tickMs);
      const sse = openSse(reply, { heartbeatMs: opts.heartbeatMs ?? SSE_HEARTBEAT_MS });
      const startedAt = Date.now();
      let seq = 0;
      const timer = setInterval(() => {
        seq++;
        sse.send("tick", { seq, total, t: Date.now() });
        if (seq >= total) {
          sse.send("done", { count: seq, ms: Date.now() - startedAt });
          sse.close();
        }
      }, tickMs);
      sse.onClose(() => {
        clearInterval(timer);
        active--;
      });
    },
  );
}
