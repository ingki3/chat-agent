import fs from "node:fs";
import path from "node:path";
import { Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { FastifyBaseLogger, FastifyServerOptions } from "fastify";
import {
  errorSummary,
  isAuthType,
  isCategory,
  isConnectionScope,
  isErrorCode,
  isErrorType,
  isHostname,
  isHttpStatus,
  isId,
  isMethod,
  isNotificationKind,
  isRoutePattern,
  isRuntime,
  isSkillCode,
  isStatus,
  isTestCode,
  isImportItem,
  isImportCode,
  isWebCode,
  isArtifactCode,
  isLoginCode,
  isToolName,
  UNMATCHED,
  isUsagePurpose,
} from "./observability/policy.js";

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
  // Skill calls on our MCP server (#21): tool name, outcome code, duration and IDs — never input or output.
  "skill.finished",
  // Web tool calls (#50): tool name, outcome code, duration and IDs — never the URL, host, query or page text.
  "web.finished",
  "artifact.finished",
  "web.build_missing",
  "server.start_failed",
  "log.line_dropped",
  // Notifications (#34): counts, kinds and push-service status codes only — never a title, body or endpoint.
  "push.sent",
  "push.unsent",
  "push.failed",
  "push.cancelled",
  "push.subscription_gone",
  // Runtime connections (#17): ids, runtime, scope, auth type and fixed test codes only — never a key or a token.
  "connection.created",
  "connection.tested",
  "connection.expired",
  "connection.disconnected",
  "connection.imported",
  "connection.import_failed",
  // Subscription logins (#18): ids, runtime and fixed outcome codes — never a token, the one-time code or an email.
  "connection.login_started",
  "connection.login_finished",
  "connection.refreshed",
  "connection.refresh_failed",
  // Usage storage (#44): a usage row could not be written — IDs, attempt and purpose only.
  "usage.record_failed",
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
/** Fastify's request IDs (`req-1`, `req-2a`, … a base-36 counter). */
const isReqId = (v: unknown) => typeof v === "string" && /^req-[0-9a-z]{1,10}$/.test(v);

type Check = (v: unknown) => boolean;

/**
 * Nested objects allowed for these keys only, with their own field checks. Maps, not object literals: a plain
 * object would also "find" inherited keys such as `constructor` or `toString` (and treat them as checks).
 */
const NESTED = new Map<string, Map<string, Check>>([
  [
    "req",
    new Map<string, Check>([
      ["method", isMethod],
      ["url", isRoutePattern],
      ["reqId", isReqId],
    ]),
  ],
  ["res", new Map<string, Check>([["statusCode", isHttpStatus]])],
  [
    "err",
    new Map<string, Check>([
      ["type", isErrorType],
      ["code", isErrorCode],
      ["statusCode", isHttpStatus],
    ]),
  ],
]);

/**
 * Allowed top-level fields and the check each value must pass. Strings must come from a fixed set or be
 * something the server generated (UUIDs, registered routes, known tools) — a shape check alone would let an
 * API key or the gate code through.
 */
const FIELDS = new Map<string, Check>([
  ["level", isInt],
  ["time", isNum],
  ["pid", isInt],
  ["hostname", isHostname],
  ["reqId", isReqId],
  ["responseTime", isNum],
  ["userId", isId],
  ["conversationId", isId],
  ["runId", isId],
  ["runtime", isRuntime],
  ["tool", isToolName],
  ["durationMs", isNum],
  ["status", isStatus],
  ["errorCode", isErrorCode],
  /** Why a skill call did not succeed (#21): one of the fixed `skill_*` codes. */
  ["skillCode", isSkillCode],
  /** Why a web tool call did not succeed (#50): one of the fixed `web_*` codes. */
  ["webCode", isWebCode],
  /** Why an artifact tool call did not succeed (#27): one of the fixed `artifact_*` codes. */
  ["artifactCode", isArtifactCode],
  ["category", isCategory],
  ["costUsd", isNum],
  ["inputTokens", isInt],
  ["outputTokens", isInt],
  /** Lines the log file could not write (disk full …), reported once writing works again. */
  ["dropped", isInt],
  /** Notifications (#34): what kind, how many entries in one push, how many devices took it. */
  ["notificationKind", isNotificationKind],
  ["count", isInt],
  ["devices", isInt],
  /** Status a push service answered with (404/410 = subscription gone). */
  ["httpStatus", isHttpStatus],
  /** Runtime connections (#17). */
  ["connectionId", isId],
  ["scope", isConnectionScope],
  ["authType", isAuthType],
  ["testCode", isTestCode],
  ["importItem", isImportItem],
  ["importCode", isImportCode],
  /** Subscription login outcome (#18): a fixed code. */
  ["loginCode", isLoginCode],
  /** Usage records (#44): the run's attempt number and what the usage was for. */
  ["attempt", isInt],
  ["purpose", isUsagePurpose],
]);

/** Every key that may ever appear in a written record (tests and docs refer to it). */
export const LOG_ALLOWED_FIELDS: ReadonlySet<string> = new Set(["msg", ...FIELDS.keys(), ...NESTED.keys()]);

function nested(spec: Map<string, Check>, v: unknown): Obj | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Obj = {};
  for (const [k, check] of spec) {
    if (!Object.hasOwn(v, k)) continue;
    const x = (v as Obj)[k];
    if (check(x)) out[k] = x;
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
    const check = FIELDS.get(k);
    if (check) {
      if (check(v)) out[k] = v;
      continue;
    }
    const spec = NESTED.get(k);
    if (spec) {
      const n = nested(spec, v);
      if (n) out[k] = n;
    }
  }
  out.msg = message(Object.hasOwn(record, "msg") ? record.msg : undefined, Object.hasOwn(record, "err"));
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

/** The file operations rotatingFile uses (tests inject failures such as ENOSPC or short writes). */
export type LogFileIo = Pick<
  typeof fs,
  | "mkdirSync"
  | "openSync"
  | "closeSync"
  | "fstatSync"
  | "writeSync"
  | "ftruncateSync"
  | "renameSync"
  | "rmSync"
  | "existsSync"
>;
export type RotateOptions = { maxBytes?: number; keep?: number; io?: LogFileIo };
/** A log file stream that never fails: `dropped` counts lines it could not write. */
export type RotatingFile = Writable & { readonly dropped: number };

/**
 * Size-rotated log file (`server.log` → `server.log.1` … `server.log.<keep>`), written synchronously so a crash
 * loses nothing. The service owns the file itself: launchd's StandardOutPath cannot be rotated without a
 * restart (docs/ops.md §9).
 *
 * Logging must never take the service down, and the file must only ever hold complete JSON lines:
 * - Opening is retried on the next write — also at startup, so a log file that cannot be opened (disk full,
 *   permissions) never stops the server from starting. Lines written meanwhile are dropped and counted.
 * - A line is written until every byte is out (writeSync may write less than asked). If a write fails partway,
 *   the file is truncated back to the end of the last complete line (at once, or when it is next opened), and
 *   the line counts as dropped.
 * - A failed rotation keeps appending to the current file.
 * - The next successful write reports the loss: `{"msg":"log.line_dropped","dropped":n}`.
 */
export function rotatingFile(file: string, opts: RotateOptions = {}): RotatingFile {
  const io = opts.io ?? fs;
  const maxBytes = opts.maxBytes ?? 10 * 1024 * 1024;
  const keep = Math.max(1, opts.keep ?? 5);
  let fd: number | undefined;
  let size = 0;
  /** Offset to truncate back to after a torn write that could not be undone at once. */
  let tornAt: number | undefined;
  let dropped = 0;
  let unreported = 0;

  const close = () => {
    try {
      if (fd !== undefined) io.closeSync(fd);
    } catch {
      // already gone
    }
    fd = undefined;
  };
  const open = () => {
    close();
    io.mkdirSync(path.dirname(file), { recursive: true });
    const f = io.openSync(file, "a", 0o640);
    try {
      let at = io.fstatSync(f).size;
      if (tornAt !== undefined && at > tornAt) {
        io.ftruncateSync(f, tornAt);
        at = tornAt;
      }
      tornAt = undefined;
      fd = f;
      size = at;
    } catch (e) {
      io.closeSync(f);
      throw e;
    }
  };
  const rotate = () => {
    if (tornAt !== undefined) return; // never archive a file that still ends in a partial line
    try {
      io.rmSync(`${file}.${keep}`, { force: true });
      for (let i = keep - 1; i >= 1; i--)
        if (io.existsSync(`${file}.${i}`)) io.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
      io.renameSync(file, `${file}.1`);
    } catch {
      // Could not rotate: keep appending to the current file rather than lose lines.
      return;
    }
    close(); // the next write opens the new file
  };
  /** Writes one whole line, or nothing: a partial line is cut off again. */
  const writeLine = (buf: Buffer) => {
    if (fd === undefined) open();
    const start = size;
    let off = 0;
    try {
      while (off < buf.length) {
        const n = io.writeSync(fd!, buf, off, buf.length - off);
        if (!(n > 0)) throw new Error("log write made no progress");
        off += n;
        size += n;
      }
    } catch (e) {
      if (off > 0) {
        try {
          io.ftruncateSync(fd!, start);
          size = start;
        } catch {
          tornAt = start; // undone when the file is next opened (before any rotation)
          size = start;
        }
      }
      throw e;
    }
  };

  try {
    open(); // create the file at startup when possible; otherwise the first write retries
  } catch {
    close();
  }

  const stream = new Writable({
    write(chunk, _enc, cb) {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
      try {
        // A torn line pending removal is cut off first (open() does it), so a torn file is never archived: if the
        // truncate still fails, open() throws and this line is dropped without rotating.
        if (fd === undefined || tornAt !== undefined) open();
        if (size > 0 && size + buf.length > maxBytes) rotate();
        if (unreported > 0) {
          const note = { level: 40, time: Date.now(), msg: "log.line_dropped", dropped: unreported };
          writeLine(Buffer.from(JSON.stringify(note) + "\n"));
          unreported = 0;
        }
        writeLine(buf);
      } catch {
        dropped++;
        unreported++;
        close(); // reopen on the next write (the file may have been removed or the descriptor broken)
      }
      cb();
    },
    final(cb) {
      close();
      cb();
    },
  });
  return Object.defineProperty(stream, "dropped", { get: () => dropped }) as RotatingFile;
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
  skillCode?: string;
  webCode?: string;
  artifactCode?: string;
  category?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  notificationKind?: string;
  count?: number;
  devices?: number;
  httpStatus?: number;
  connectionId?: string;
  scope?: string;
  authType?: string;
  testCode?: string;
  importItem?: string;
  importCode?: string;
  loginCode?: string;
  attempt?: number;
  purpose?: string;
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
  return typeof url === "string" && url ? url : UNMATCHED;
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
      // Error messages can embed user content or SDK output: class name and code from fixed sets only.
      // message/stack are emptied here and dropped again by sanitizeRecord (not in the err field list).
      err: (err) => ({ ...errorSummary(err), message: "", stack: "" }),
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
