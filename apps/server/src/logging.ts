import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { FastifyBaseLogger, FastifyServerOptions } from "fastify";

/**
 * Log policy (PRD NFR 관측성·개인정보, issue #46). Logs carry *who / what / how long / how it ended* — never
 * *what was said*. Enforced by construction at the last step before the destination (`sanitizeRecord`):
 *
 * - Only allow-listed fields are written, and each one must pass its own value check (an ID must look like an
 *   ID, a status like a status code, a number must be a number). A field that fails is dropped, so a prompt
 *   passed as `status` or `tool` never gets through.
 * - `msg` must be one of the known event names (`LOG_MESSAGES`, plus Fastify's own fixed lines). Anything else
 *   is replaced: free text such as an error message or an interpolated string can carry user data.
 * - Errors keep their class name and code only — never message, stack or cause (SDK errors embed prompts,
 *   tool output and stderr).
 * - Requests are logged by method and *route pattern* (`/api/conversations/:id`), never the raw URL, query,
 *   headers (Cookie, Authorization, Cf-Access-Jwt-Assertion, Idempotency-Key, …) or body.
 *
 * Forbidden by this policy: prompts, message or file content, tool input/output, model output, SDK raw errors,
 * stderr, passwords, tokens, cookie or header values, the temporary gate code, e-mail addresses.
 */

type Obj = Record<string, unknown>;

/** Event names the application writes (the `msg` of a record). Add new events here — free text is rejected. */
export const LOG_EVENTS = [
  "error",
  "request.error",
  "run.finished",
  "tool.finished",
  "web.build_missing",
  "server.start_failed",
  "log.line_dropped",
] as const;
export type LogEvent = (typeof LOG_EVENTS)[number];

/** Fixed messages Fastify itself writes; they never contain request data. */
const FASTIFY_MESSAGES = ["incoming request", "request completed"] as const;
/** `Server listening at http://127.0.0.1:3000` — loopback addresses only (the server never binds elsewhere). */
const LISTENING = /^Server listening at https?:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d{1,5}$/;
/** Fastify's default 404 line embeds the raw URL (with its query string); it is reduced to a fixed text. */
const ROUTE_NOT_FOUND = /^Route [A-Z]+:.* not found$/s;

export const LOG_MESSAGES: ReadonlySet<string> = new Set<string>([...LOG_EVENTS, ...FASTIFY_MESSAGES]);

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown): v is number => Number.isInteger(v);
const matches = (re: RegExp) => (v: unknown) => typeof v === "string" && re.test(v);

/** IDs are UUIDs or similar tokens: no spaces, no `@` (so neither a sentence nor an e-mail passes). */
const ID = matches(/^[A-Za-z0-9_-]{1,64}$/);
/** Status / error / category codes: snake_case words. */
const CODE = matches(/^[a-z][a-z0-9_.]{0,63}$/);
/** Tool names as runtimes report them (`web_search`, `mcp__agentlee__stocks`). */
const TOOL = matches(/^[A-Za-z0-9_.:-]{1,128}$/);
const RUNTIME = matches(/^[a-z0-9-]{1,32}$/);
const HOSTNAME = matches(/^[A-Za-z0-9.-]{1,253}$/);
const REQ_ID = matches(/^req-[0-9a-z]{1,16}$/);
const ERR_TYPE = matches(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);
const ERR_CODE = matches(/^[A-Za-z0-9_.-]{1,64}$/);
const METHOD = matches(/^[A-Z]{1,10}$/);
/** A registered route pattern, e.g. `/api/conversations/:id` or `/*` (static files). */
const ROUTE = matches(/^\/[A-Za-z0-9_\-./:*]{0,200}$/);

type Check = (v: unknown) => boolean;

/** Nested objects allowed for these keys only, with their own field checks. */
const NESTED: Record<string, Record<string, Check>> = {
  req: { method: METHOD, url: (v) => ROUTE(v) || v === "<unmatched>", reqId: REQ_ID },
  res: { statusCode: isInt },
  err: { type: ERR_TYPE, code: ERR_CODE, statusCode: isInt },
};

/** Allowed top-level fields and the check each value must pass. */
const FIELDS: Record<string, Check> = {
  level: isInt,
  time: isNum,
  pid: isInt,
  hostname: HOSTNAME,
  reqId: REQ_ID,
  responseTime: isNum,
  userId: ID,
  conversationId: ID,
  runId: ID,
  runtime: RUNTIME,
  tool: TOOL,
  durationMs: isNum,
  status: CODE,
  errorCode: CODE,
  category: CODE,
  costUsd: isNum,
  inputTokens: isInt,
  outputTokens: isInt,
};

/** Every key that may ever appear in a written record (tests and docs refer to it). */
export const LOG_ALLOWED_FIELDS: ReadonlySet<string> = new Set([
  "msg",
  ...Object.keys(FIELDS),
  ...Object.keys(NESTED),
]);

function nested(spec: Record<string, Check>, v: unknown): Obj | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Obj = {};
  for (const [k, check] of Object.entries(spec)) {
    const x = (v as Obj)[k];
    if (x !== undefined && check(x)) out[k] = x;
  }
  return out;
}

function message(msg: unknown, hasErr: boolean): string {
  if (typeof msg === "string") {
    if (LOG_MESSAGES.has(msg)) return msg;
    if (LISTENING.test(msg)) return msg;
    if (ROUTE_NOT_FOUND.test(msg)) return "route not found";
  }
  return hasErr ? "error" : "redacted";
}

/** The policy itself: allow-listed fields whose values pass their checks; everything else is dropped. */
export function sanitizeRecord(record: Obj): Obj {
  const out: Obj = {};
  for (const [k, v] of Object.entries(record)) {
    const check = FIELDS[k];
    if (check) {
      if (check(v)) out[k] = v;
      continue;
    }
    const spec = NESTED[k];
    if (spec) {
      const n = nested(spec, v);
      if (n) out[k] = n;
    }
  }
  out.msg = message(record.msg, "err" in record);
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
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a record");
      out = JSON.stringify(sanitizeRecord(parsed as Obj));
    } catch {
      out = JSON.stringify({ level: 50, time: Date.now(), msg: "log.line_dropped" });
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

export type RotateOptions = { maxBytes?: number; keep?: number };

/**
 * Size-rotated log file (`server.log` → `server.log.1` … `server.log.<keep>`), written synchronously so a crash
 * loses nothing. The service owns the file itself: launchd's StandardOutPath cannot be rotated without a
 * restart (docs/ops.md §9).
 */
export function rotatingFile(file: string, opts: RotateOptions = {}): Writable {
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const keep = Math.max(1, opts.keep ?? 5);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd = fs.openSync(file, "a", 0o640);
  let size = fs.fstatSync(fd).size;
  const rotate = () => {
    fs.closeSync(fd);
    fs.rmSync(`${file}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--)
      if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    fs.renameSync(file, `${file}.1`);
    fd = fs.openSync(file, "a", 0o640);
    size = 0;
  };
  return new Writable({
    write(chunk, _enc, cb) {
      try {
        const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
        if (size > 0 && size + buf.length > maxBytes) rotate();
        fs.writeSync(fd, buf);
        size += buf.length;
        cb();
      } catch (e) {
        cb(e as Error);
      }
    },
    final(cb) {
      fs.closeSync(fd);
      cb();
    },
  });
}

/** Fields an application event may carry (all checked again by `sanitizeRecord`). */
export type LogFields = {
  userId?: string;
  conversationId?: string;
  runId?: string;
  runtime?: string;
  tool?: string;
  durationMs?: number;
  status?: string;
  errorCode?: string;
  category?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** Logged as class name and code only. */
  err?: unknown;
};

export type EventLogger = Pick<FastifyBaseLogger, "info" | "warn" | "error">;

/** Writes one structured application event. The typed fields are the only way app code should log. */
export function logEvent(
  log: EventLogger | undefined,
  level: "info" | "warn" | "error",
  event: LogEvent,
  fields: LogFields = {},
): void {
  log?.[level](fields, event);
}

/** Route pattern of a request (never the raw URL): `/api/conversations/:id`, or `<unmatched>`. */
function routeOf(req: { routeOptions?: { url?: string | undefined } }): string {
  const url = req.routeOptions?.url;
  return typeof url === "string" && url ? url : "<unmatched>";
}

export function loggerOptions(
  dest?: NodeJS.WritableStream,
): Exclude<FastifyServerOptions["logger"], boolean | undefined> {
  return {
    stream: sanitizingStream(dest),
    level: process.env.LOG_LEVEL ?? "info",
    serializers: {
      // Route pattern only: raw paths and query strings can carry tokens or typed text.
      req: (req) => ({
        method: req.method,
        url: routeOf(req as unknown as { routeOptions?: { url?: string } }),
        reqId: req.id,
      }),
      res: (res) => ({ statusCode: res.statusCode }),
      // Error messages can embed user content or SDK output; keep class name and code only.
      err: (err) => {
        const e = err as { name?: unknown; code?: unknown; statusCode?: unknown };
        // message/stack are emptied here and dropped again by sanitizeRecord (not in the err field list).
        return {
          type: typeof e.name === "string" ? e.name : "Error",
          message: "",
          stack: "",
          code: e.code,
          statusCode: e.statusCode,
        };
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
