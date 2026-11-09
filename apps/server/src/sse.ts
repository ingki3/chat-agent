import type { FastifyReply } from "fastify";
import { BASE_HEADERS } from "./headers.js";

/** Comment line interval. Keeps Cloudflare (Proxy Read Timeout, 125 s by default) and browsers from timing out. */
export const SSE_HEARTBEAT_MS = 15_000;

export type SseStream = {
  /** Sends one event. Data is JSON-encoded on a single line. */
  send: (event: string, data: unknown) => void;
  /** Ends the stream. Safe to call more than once. */
  close: () => void;
  /** True once the client went away or close() ran. */
  readonly closed: boolean;
  /** Runs when the stream ends for any reason. */
  onClose: (fn: () => void) => void;
};

/**
 * Takes over the reply and starts a Server-Sent Events stream: headers are flushed immediately, an opening
 * comment is written so proxies commit the response, and a heartbeat comment follows every `heartbeatMs`.
 * Fastify hooks (onSend) do not run on hijacked replies, so the base headers are set here.
 */
export function openSse(reply: FastifyReply, opts: { heartbeatMs?: number } = {}): SseStream {
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    ...BASE_HEADERS,
    "Content-Type": "text/event-stream; charset=utf-8",
    // no-transform: stops intermediaries from compressing/buffering the stream.
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  res.write(": open\n\n");

  let closed = false;
  const listeners: (() => void)[] = [];
  const heartbeat = setInterval(() => {
    if (!closed) res.write(": hb\n\n");
  }, opts.heartbeatMs ?? SSE_HEARTBEAT_MS);
  const finish = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const fn of listeners.splice(0)) fn();
  };
  res.on("close", finish);

  return {
    send(event, data) {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close() {
      if (closed) return;
      finish();
      res.end();
    },
    get closed() {
      return closed;
    },
    onClose(fn) {
      if (closed) fn();
      else listeners.push(fn);
    },
  };
}
