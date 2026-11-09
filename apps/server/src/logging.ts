import { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { FastifyServerOptions } from "fastify";

/**
 * Log policy (PRD NFR 관측성): only allow-listed fields are written. Request bodies, headers, query strings
 * and any ad-hoc fields (prompts, file contents, credentials) are dropped. Extended in #46.
 */
export const LOG_ALLOWED_FIELDS = new Set([
  "level",
  "time",
  "pid",
  "hostname",
  "msg",
  "reqId",
  "req",
  "res",
  "responseTime",
  "err",
  "userId",
  "conversationId",
  "runId",
  "tool",
  "durationMs",
  "status",
  "errorCode",
  "costUsd",
]);

type Obj = Record<string, unknown>;

/** Keeps allow-listed keys; any record carrying an error gets a fixed message (error text may hold user data). */
export function sanitizeRecord(record: Obj): Obj {
  const out = Object.fromEntries(Object.entries(record).filter(([k]) => LOG_ALLOWED_FIELDS.has(k)));
  if ("err" in record) out.msg = "error";
  return out;
}

/**
 * Final gate in front of the real destination: re-parses each JSON line and applies `sanitizeRecord`.
 * This also covers child-logger bindings, which pino serialises without calling the log formatter.
 */
export function sanitizingStream(dest: NodeJS.WritableStream = process.stdout): Writable {
  // Buffer until a newline (and across UTF-8 boundaries) so a record split over several chunks is
  // only parsed once it is complete — a fragment must never be emitted as its own record.
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const emit = (line: string) => {
    if (!line.trim()) return;
    let out: string;
    try {
      out = JSON.stringify(sanitizeRecord(JSON.parse(line) as Obj));
    } catch {
      out = JSON.stringify({ level: 50, time: Date.now(), msg: "unparseable log line dropped" });
    }
    dest.write(out + "\n");
  };
  return new Writable({
    write(chunk, _enc, cb) {
      pending += typeof chunk === "string" ? chunk : decoder.write(chunk as Buffer);
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) {
        emit(pending.slice(0, nl));
        pending = pending.slice(nl + 1);
      }
      cb();
    },
    final(cb) {
      pending += decoder.end();
      emit(pending);
      pending = "";
      cb();
    },
  });
}

export function loggerOptions(
  dest?: NodeJS.WritableStream,
): Exclude<FastifyServerOptions["logger"], boolean | undefined> {
  return {
    stream: sanitizingStream(dest),
    level: process.env.LOG_LEVEL ?? "info",
    serializers: {
      // Path only: query strings can carry tokens.
      req: (req) => ({ method: req.method, url: (req.url ?? "").split("?")[0] ?? "", reqId: req.id }),
      res: (res) => ({ statusCode: res.statusCode }),
      // Error messages can embed user content or SDK output; keep type and code only.
      err: (err) => {
        const e = err as { name?: string; code?: string; statusCode?: number };
        return { type: e.name ?? "Error", message: "", stack: "", code: e.code, statusCode: e.statusCode };
      },
    },
    hooks: {
      // pino uses an Error's message as the log message; replace it so error text never reaches the log.
      logMethod(args, method) {
        const [first, second] = args as unknown[];
        if (first instanceof Error) {
          return method.apply(this, [{ err: first }, typeof second === "string" ? second : "error"] as never);
        }
        if (first && typeof first === "object" && "err" in first && typeof second !== "string") {
          return method.apply(this, [first, "error"] as never);
        }
        return method.apply(this, args);
      },
    },
    formatters: {
      log: (obj: Obj) => Object.fromEntries(Object.entries(obj).filter(([k]) => LOG_ALLOWED_FIELDS.has(k))),
    },
  };
}
