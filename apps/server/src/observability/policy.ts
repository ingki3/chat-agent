import os from "node:os";
import { NotificationKind, RuntimeId } from "@agentlee/shared";

/**
 * What may be written about an event (#46), shared by the log sanitiser and the recent-error store.
 *
 * Shape checks are not enough: an API key, a JWT or the temporary gate code can be made only of "allowed"
 * characters. So every string field is checked against something the server itself produced — a fixed set of
 * codes, a UUID (all our IDs are crypto.randomUUID()), a registered route pattern, a known tool name. Anything
 * else is dropped or replaced by a fixed word.
 */

/** RFC 4122 v4 UUID — the only ID format the server generates (users, conversations, messages, runs). */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const isId = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

const set = (xs: readonly string[]): ReadonlySet<string> => new Set(xs);
const member =
  (s: ReadonlySet<string>) =>
  (v: unknown): v is string =>
    typeof v === "string" && s.has(v);

export const RUNTIMES = set(RuntimeId.options);
/** Run statuses and tool outcomes. */
export const STATUSES = set(["queued", "running", "done", "interrupted", "failed", "ok", "error"]);
export const ERROR_CATEGORIES = set([
  "app",
  "db",
  "network",
  "runtime",
  "tool",
  "limit",
  "restart",
  "client",
]);
export type ErrorCategory = "app" | "db" | "network" | "runtime" | "tool" | "limit" | "restart" | "client";
/** Every error code the server produces (classifyError and the run manager). */
export const ERROR_CODES = set([
  "internal_error",
  "bad_request",
  "timeout",
  "db_busy",
  "db_error",
  "network_error",
  "disk_full",
  "session_gone",
  "shutting_down",
  "runtime_error",
  "runtime_auth",
  "runtime_policy",
  "no_connection",
  "no_runtime",
  "server_restart",
  "usage_limit",
  "tool_error",
  "unknown",
]);
/** Error class names worth keeping; any other name is logged as "Error" (a class name can be anything). */
export const ERROR_TYPES = set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "AggregateError",
  "AbortError",
  "TimeoutError",
  "DOMException",
  "FastifyError",
  "SqliteError",
  "SessionGoneError",
  "RuntimeFailure",
  "ShuttingDownError",
  "RunBusyError",
  "IdempotencyConflictError",
]);
export const HTTP_METHODS = set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
  "TRACE",
  "CONNECT",
]);

export const isRuntime = member(RUNTIMES);
export const isNotificationKind = member(set(NotificationKind.options));
export const isStatus = member(STATUSES);
export const isErrorCode = member(ERROR_CODES);
export const isCategory = member(ERROR_CATEGORIES);
export const isErrorType = member(ERROR_TYPES);
export const isMethod = member(HTTP_METHODS);
export const isHttpStatus = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= 100 && (v as number) <= 599;
const HOSTNAME = os.hostname();
export const isHostname = (v: unknown) => v === HOSTNAME;

/** Route patterns registered with Fastify (filled by an onRoute hook in buildApp). */
const routes = new Set<string>();
export const UNMATCHED = "<unmatched>";
export function registerRoutePattern(url: string): void {
  routes.add(url);
}
export const isRoutePattern = (v: unknown): v is string =>
  typeof v === "string" && (v === UNMATCHED || routes.has(v));

/**
 * Tool names that may be logged. Built-in tools of the two runtimes are known; MCP tools are added by the server
 * that exposes them (`registerToolNames`, #42). Anything else — a runtime can report any string — is "other".
 */
const tools = new Set<string>([
  // Claude Code
  "Agent",
  "Task",
  "Bash",
  "BashOutput",
  "KillShell",
  "Edit",
  "MultiEdit",
  "Glob",
  "Grep",
  "LS",
  "NotebookEdit",
  "NotebookRead",
  "Read",
  "Write",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Skill",
  "ExitPlanMode",
  // Codex
  "shell",
  "local_shell",
  "exec_command",
  "apply_patch",
  "web_search",
  "update_plan",
  "view_image",
  // FakeRuntime (development)
  "slow_tool",
  "other",
]);
export function registerToolNames(names: Iterable<string>): void {
  for (const n of names) tools.add(n);
}
export const isToolName = (v: unknown): v is string => typeof v === "string" && tools.has(v);
/** The name to log for a tool the runtime reported. */
export const toolLabel = (name: string): string => (tools.has(name) ? name : "other");

export type Classified = { code: string; category: ErrorCategory };

/** The category of every error code — one table, so a code is always filed under the same category. */
export const CODE_CATEGORY: Readonly<Record<string, ErrorCategory>> = {
  internal_error: "app",
  bad_request: "client",
  timeout: "network",
  network_error: "network",
  db_busy: "db",
  db_error: "db",
  disk_full: "app",
  session_gone: "runtime",
  shutting_down: "restart",
  runtime_error: "runtime",
  runtime_auth: "runtime",
  runtime_policy: "runtime",
  no_connection: "app",
  no_runtime: "app",
  server_restart: "restart",
  usage_limit: "limit",
  tool_error: "tool",
  unknown: "app",
};
const as = (code: string): Classified => ({ code, category: CODE_CATEGORY[code]! });

const NETWORK_CODES = set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/**
 * Maps any thrown value to a fixed code (one of ERROR_CODES). Only the error's class name, `code` and
 * `statusCode` are looked at, and none of them is ever passed through.
 */
export function classifyError(
  e: unknown,
  fallback: Classified = { code: "internal_error", category: "app" },
): Classified {
  const err = (e && typeof e === "object" ? e : {}) as {
    name?: unknown;
    code?: unknown;
    statusCode?: unknown;
  };
  const name = typeof err.name === "string" ? err.name : "";
  const code = typeof err.code === "string" ? err.code : "";
  if (name === "AbortError" || name === "TimeoutError") return as("timeout");
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return as("db_busy");
  if (code.startsWith("SQLITE_")) return as("db_error");
  if (NETWORK_CODES.has(code)) return as("network_error");
  if (code === "ENOSPC") return as("disk_full");
  if (name === "SessionGoneError") return as("session_gone");
  if (name === "ShuttingDownError") return as("shutting_down");
  const status = typeof err.statusCode === "number" ? err.statusCode : 0;
  if (status >= 400 && status < 500) return as("bad_request");
  return fallback;
}

/** `{ type, code, statusCode }` of an error with every value from a fixed set. */
export function errorSummary(e: unknown): { type: string; code: string; statusCode?: number } {
  const err = (e && typeof e === "object" ? e : {}) as { name?: unknown; statusCode?: unknown };
  return {
    type: isErrorType(err.name) ? err.name : "Error",
    code: classifyError(e).code,
    ...(isHttpStatus(err.statusCode) ? { statusCode: err.statusCode } : {}),
  };
}
