import type { FastifyInstance } from "fastify";
import { knownSecrets, scrubKnown, scrubKnownDeep } from "./known.js";

/** Content types whose bodies are text (scrubbed); anything else (PNG, PDF, fonts) is binary and left alone. */
const TEXTUAL = /json|^text\/|svg|xml|javascript|ecmascript|csv|markdown|x-www-form-urlencoded/i;

/**
 * The safety net under every HTTP response (review round 25): known-value scrubbing over each JSON and text body
 * — API answers, artifact raw and download, error bodies, the inbox, admin screens — whatever route produced it.
 * Routes keep their own scrubbing; this catches the one that forgot. A JSON body with a hit is parsed, scrubbed
 * value by value (a numeric secret becomes a string) and serialised again, so it stays valid JSON. Streams (SSE,
 * files) pass: SSE frames are scrubbed where they are made, binary exports are made from scrubbed inputs.
 */
export function registerResponseScrub(app: FastifyInstance): void {
  app.addHook("onSend", async (_req, reply, payload) => {
    if (!knownSecrets.matcher()) return payload;
    const type = String(reply.getHeader("content-type") ?? "");
    let body: string;
    let buffer = false;
    if (typeof payload === "string") {
      if (type && !TEXTUAL.test(type)) return payload;
      body = payload;
    } else if (Buffer.isBuffer(payload)) {
      if (!TEXTUAL.test(type)) return payload;
      body = payload.toString("utf8");
      buffer = true;
    } else return payload;
    const text = scrubKnown(body, { tail: false });
    if (text === body) return payload;
    let out = text;
    if (/json/i.test(type))
      try {
        out = JSON.stringify(scrubKnownDeep(JSON.parse(body) as unknown, { tail: false }));
      } catch {
        // not JSON after all: the text scrub stands
      }
    if (reply.hasHeader("content-length")) reply.header("content-length", Buffer.byteLength(out, "utf8"));
    return buffer ? Buffer.from(out, "utf8") : out;
  });
}
