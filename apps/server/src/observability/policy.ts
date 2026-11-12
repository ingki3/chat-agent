import os from "node:os";
import { NotificationKind, RuntimeId, SCHEDULE_RUN_CODES } from "@agentlee/shared";
import { USAGE_PURPOSES } from "../usage/store.js";

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
  "summary_failed",
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
  "RunAccessDenied",
  "ConnectionRuleError",
  "SecretError",
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

/** Outcome codes of a skill call on our MCP server (#21, mcp/service.ts). */
export const SKILL_CODES = set([
  "skill_not_allowed",
  "skill_bad_input",
  "skill_busy",
  "skill_unavailable",
  "skill_unconfigured",
  "skill_timeout",
  "skill_limit",
  "skill_failed",
  "skill_bad_output",
  "skill_changed",
]);
/** Connection test outcomes (#17, connections/tester.ts): fixed codes only. */
export const TEST_CODES = set([
  "ok",
  "test_no_reply",
  "test_no_stream",
  "test_no_tool",
  "test_no_skill",
  "timeout",
  "cancelled",
  "usage_limit",
  "no_runtime",
  "runtime_auth",
  "runtime_error",
  "runtime_policy",
  "no_connection",
]);
export const isTestCode = member(TEST_CODES);
/** Subscription login outcomes (#18, connections/login.ts). */
export const LOGIN_CODES = set([
  "completed",
  "login_failed",
  "login_expired",
  "login_error",
  "cancelled",
  "timeout",
  // Startup clean-up of logins a previous server left behind.
  "leftover_cleaned",
  "leftover_process_killed",
  "leftover_process_kept",
]);
export const isLoginCode = member(LOGIN_CODES);
/** `.env` import (#17): which value, and why it was not imported (fixed codes only). */
export const isImportItem = member(set(["claude_api_key", "claude_oauth_token", "codex_api_key"]));
export const isImportCode = member(
  set([
    "import_failed",
    "invalid_secret",
    "invalid_request",
    "subscription_not_allowed",
    "shared_subscription",
    "unsupported_auth",
    "not_found",
  ]),
);
export const isUsagePurpose = member(set(USAGE_PURPOSES));
export const isConnectionScope = member(set(["shared", "personal"]));
export const isAuthType = member(set(["api_key", "subscription"]));

/**
 * Outcome codes of the web tools (#50, web/service.ts `WEB_CODES` — a test keeps the two equal). The URL, its
 * host and the query are never logged: a host name is chosen by the model (or a page it read) and can carry
 * anything in its labels, so only these fixed codes say what happened.
 */
export const WEB_CODES = set([
  "web_bad_input",
  "web_bad_url",
  "web_blocked",
  "web_unreachable",
  "web_timeout",
  "web_tls",
  "web_too_large",
  "web_too_many_redirects",
  "web_unsupported_type",
  "web_http_error",
  "web_bad_content",
  "web_no_text",
  "web_search_blocked",
  "web_search_unavailable",
  "web_unavailable",
  "web_limit",
  "web_failed",
  "web_busy",
  "web_not_allowed",
]);

/** Outcomes of `cite` and `sources_list` (#25): a citation status or why nothing was registered. */
export const CITE_CODES = set([
  "verified",
  "snippet_not_found",
  "fetch_failed",
  "unknown_source",
  "cite_bad_input",
  "cite_not_allowed",
  "cite_snippet_too_short",
  "cite_limit",
]);

/** Outcome codes of the artifact tools (#27, artifacts/store.ts `ARTIFACT_CODES` — a test keeps the two equal). */
export const ARTIFACT_CODES = set([
  "artifact_bad_input",
  "artifact_too_large",
  "artifact_not_found",
  "artifact_not_allowed",
  "artifact_limit",
]);

/** Outcome codes of the finance tools (#30, finance/service.ts `FINANCE_CODES` — a test keeps the two equal). */
export const FINANCE_CODES = set([
  "finance_bad_input",
  "finance_not_allowed",
  "finance_unconfigured",
  "finance_unavailable",
  "finance_blocked",
  "finance_unreachable",
  "finance_timeout",
  "finance_http_error",
  "finance_rate_limited",
  "finance_not_found",
  "finance_bad_response",
  "finance_busy",
  "finance_failed",
]);

/** Outcome codes of PNG/PDF export (#51, artifacts/export.ts `EXPORT_CODES` — a test keeps the two equal). */
export const EXPORT_CODES = set([
  "export_ok",
  "export_unavailable",
  "export_busy",
  "export_timeout",
  "export_limit",
  "export_failed",
]);
export const EXPORT_FORMATS = set(["png", "pdf"]);

/** Upload outcomes (#22, files/routes.ts `FILE_CODES` — a test keeps the two equal). */
export const FILE_CODES = set([
  "file_ok",
  "file_aborted",
  "invalid_request",
  "file_too_large",
  "too_many_files",
  "file_type_unsupported",
  "file_type_mismatch",
  "file_empty",
  "file_attached",
  "upload_cancelled",
  "too_many_cancels",
]);
export const isFileCode = member(FILE_CODES);

/** Backup outcomes (#37, backup/backup.ts `BACKUP_CODES` — a test keeps the two equal). */
export const BACKUP_CODES = set([
  "backup_ok",
  "backup_running",
  "backup_unavailable",
  "backup_failed",
  "backup_disk_full",
]);
export const isBackupCode = member(BACKUP_CODES);
export const isBackupTrigger = member(set(["scheduled", "manual"]));
/** Schedules (#33): run outcome / skip codes (shared `SCHEDULE_RUN_CODES`) and the engine's own codes. */
export const SCHEDULE_CODES = set([
  ...SCHEDULE_RUN_CODES,
  "schedule_ok",
  "schedule_invalid",
  "storage_not_owned",
  "handler_missing",
]);
export const isScheduleCode = member(SCHEDULE_CODES);
export const isScheduleTrigger = member(set(["regular", "missed", "manual"]));
export const isScheduleStatus = member(set(["succeeded", "failed", "skipped", "retrying"]));
export const isScheduleStep = member(set(["save", "notify", "engine"]));
export const isRestoreRecovery = member(set(["completed", "rolled_back"]));

export const isRuntime = member(RUNTIMES);
export const isFinanceCode = member(FINANCE_CODES);
export const isCiteCode = member(CITE_CODES);
export const isExportCode = member(EXPORT_CODES);
export const isExportFormat = member(EXPORT_FORMATS);
export const isArtifactCode = member(ARTIFACT_CODES);
export const isWebCode = member(WEB_CODES);
export const isSkillCode = member(SKILL_CODES);
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
