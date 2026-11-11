import { desc, eq, lt, or, sql } from "drizzle-orm";
import type { RecentError } from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { errorLog } from "../db/schema.js";

/**
 * Error sanitising (#46): raw error text (SDK messages, stderr, tool output) never leaves the process — not to
 * the log, not to the admin list, not to the browser. What remains is a code and a category.
 */
export type ErrorCategory = "app" | "db" | "network" | "runtime" | "tool" | "limit" | "restart" | "client";
export type Classified = { code: string; category: ErrorCategory };

const NETWORK_CODES = new Set([
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

/** Maps any thrown value to a fixed code. Only the error's class name and `code` property are looked at. */
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
  if (name === "AbortError" || name === "TimeoutError") return { code: "timeout", category: "network" };
  if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") return { code: "db_busy", category: "db" };
  if (code.startsWith("SQLITE_")) return { code: "db_error", category: "db" };
  if (NETWORK_CODES.has(code)) return { code: "network_error", category: "network" };
  if (code === "ENOSPC") return { code: "disk_full", category: "app" };
  if (name === "SessionGoneError") return { code: "session_gone", category: "runtime" };
  if (name === "ShuttingDownError") return { code: "shutting_down", category: "restart" };
  const status = typeof err.statusCode === "number" ? err.statusCode : 0;
  if (status >= 400 && status < 500) return { code: "bad_request", category: "client" };
  return fallback;
}

/** Category of a run failure code (RunManager's `errorCode`). */
export function runFailureCategory(code: string): ErrorCategory {
  if (code === "usage_limit") return "limit";
  if (code === "server_restart") return "restart";
  if (code === "no_runtime") return "app";
  if (code === "tool_error") return "tool";
  return "runtime";
}

export type ErrorEntry = {
  source: RecentError["source"];
  code: string;
  category: string;
  userId?: string | null | undefined;
  conversationId?: string | null | undefined;
  runId?: string | null | undefined;
  runtime?: string | null | undefined;
  tool?: string | null | undefined;
  route?: string | null | undefined;
  statusCode?: number | null | undefined;
};

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CODE = /^[a-z][a-z0-9_.]{0,63}$/;
const TOOL = /^[A-Za-z0-9_.:-]{1,128}$/;
const ROUTE = /^[A-Z]{1,10} (\/[A-Za-z0-9_\-./:*]{0,200}|<unmatched>)$/;
const keep = (re: RegExp, v: string | null | undefined) => (typeof v === "string" && re.test(v) ? v : null);

/**
 * Stored recent errors (admin "최근 오류", FR-10.4). Every field is checked on the way in exactly like the log
 * fields, so nothing but IDs and codes can be stored even if a caller passes the wrong thing.
 */
export class ErrorLog {
  constructor(
    private readonly db: Db,
    private readonly opts: { now?: () => number; maxRows?: number; maxAgeMs?: number } = {},
  ) {}

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  record(e: ErrorEntry): void {
    try {
      const row = this.db
        .insert(errorLog)
        .values({
          at: this.now(),
          source: e.source,
          code: keep(CODE, e.code) ?? "unknown",
          category: keep(CODE, e.category) ?? "app",
          userId: keep(ID, e.userId),
          conversationId: keep(ID, e.conversationId),
          runId: keep(ID, e.runId),
          runtime: keep(/^[a-z0-9-]{1,32}$/, e.runtime),
          tool: keep(TOOL, e.tool),
          route: keep(ROUTE, e.route),
          statusCode: Number.isInteger(e.statusCode) ? e.statusCode! : null,
        })
        .returning({ id: errorLog.id })
        .get();
      const maxRows = this.opts.maxRows ?? 1000;
      const cutoff = this.now() - (this.opts.maxAgeMs ?? 30 * 24 * 3600_000);
      this.db
        .delete(errorLog)
        .where(or(lt(errorLog.at, cutoff), sql`${errorLog.id} <= ${row.id - maxRows}`))
        .run();
    } catch {
      // Recording an error must never cause one (e.g. the database itself is failing).
    }
  }

  recent(opts: { limit?: number; source?: RecentError["source"] } = {}): RecentError[] {
    const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
    const q = this.db.select().from(errorLog);
    return (opts.source ? q.where(eq(errorLog.source, opts.source)) : q)
      .orderBy(desc(errorLog.id))
      .limit(limit)
      .all();
  }
}
