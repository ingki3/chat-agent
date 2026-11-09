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

export function loggerOptions(): Exclude<FastifyServerOptions["logger"], boolean | undefined> {
  return {
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
