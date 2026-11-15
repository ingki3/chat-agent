import { and, count, desc, eq, gte, like, lt, max, or, sql } from "drizzle-orm";
import type { RecentError } from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { errorLog } from "../db/schema.js";
import {
  isCategory,
  isErrorCode,
  isHttpStatus,
  isId,
  isMethod,
  isRoutePattern,
  isRuntime,
  isFinanceCode,
  isPythonCode,
  isSkillCode,
  isToolName,
  CODE_CATEGORY,
  type ErrorCategory,
} from "./policy.js";

// Error sanitising lives in policy.ts (shared with the log sanitiser); re-exported for callers.
export { classifyError, type Classified, type ErrorCategory } from "./policy.js";

/** Category of a run failure code (RunManager's `errorCode`): the same as classifyError's for shared codes. */
export function runFailureCategory(code: string): ErrorCategory {
  return CODE_CATEGORY[code] ?? "runtime";
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

const keep = (check: (v: unknown) => boolean, v: unknown): string | null =>
  typeof v === "string" && check(v) ? v : null;
/** `METHOD /registered/:pattern` (or `METHOD <unmatched>`). */
const isRoute = (v: unknown) => {
  if (typeof v !== "string") return false;
  const i = v.indexOf(" ");
  return i > 0 && isMethod(v.slice(0, i)) && isRoutePattern(v.slice(i + 1));
};

export const ERROR_MAX_AGE_MS = 30 * 24 * 3600_000;

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
          // Skill, finance and python_run (#47) tool outcomes too (#35: the admin's skill failure list), all fixed codes.
          code:
            keep((c) => isErrorCode(c) || isSkillCode(c) || isFinanceCode(c) || isPythonCode(c), e.code) ??
            "unknown",
          category: keep(isCategory, e.category) ?? "app",
          userId: keep(isId, e.userId),
          conversationId: keep(isId, e.conversationId),
          runId: keep(isId, e.runId),
          runtime: keep(isRuntime, e.runtime),
          tool: keep(isToolName, e.tool),
          route: keep(isRoute, e.route),
          statusCode: isHttpStatus(e.statusCode) ? e.statusCode : null,
        })
        .returning({ id: errorLog.id })
        .get();
      this.prune(row.id);
    } catch {
      // Recording an error must never cause one (e.g. the database itself is failing).
    }
  }

  private get maxAgeMs(): number {
    return this.opts.maxAgeMs ?? ERROR_MAX_AGE_MS;
  }

  /**
   * Drops entries older than the retention period and beyond the newest `maxRows`. Runs on every record() and
   * periodically (buildApp), so old entries go even when no new error arrives.
   */
  prune(newestId?: number): number {
    try {
      const newest =
        newestId ??
        this.db
          .select({ id: sql<number>`max(${errorLog.id})` })
          .from(errorLog)
          .get()?.id ??
        0;
      const maxRows = this.opts.maxRows ?? 1000;
      return this.db
        .delete(errorLog)
        .where(or(lt(errorLog.at, this.now() - this.maxAgeMs), sql`${errorLog.id} <= ${newest - maxRows}`))
        .run().changes;
    } catch {
      return 0;
    }
  }

  /**
   * Failed skill calls of the retention period (#35, FR-10.4 "스킬 실행 실패"): the entries our MCP server records
   * with a skill (`skill_*`) or finance tool (`finance_*`) outcome code, counted by tool and code, newest first.
   */
  skillFailures(): { tool: string; code: string; count: number; lastAt: number }[] {
    return this.db
      .select({ tool: errorLog.tool, code: errorLog.code, count: count(), lastAt: max(errorLog.at) })
      .from(errorLog)
      .where(
        and(
          gte(errorLog.at, this.now() - this.maxAgeMs),
          eq(errorLog.source, "tool"),
          or(like(errorLog.code, "skill_%"), like(errorLog.code, "finance_%")),
        ),
      )
      .groupBy(errorLog.tool, errorLog.code)
      .orderBy(desc(max(errorLog.at)))
      .all()
      .map((r) => ({ tool: r.tool ?? "other", code: r.code, count: r.count, lastAt: r.lastAt ?? 0 }));
  }

  /** Newest first, never older than the retention period (even if pruning has not run yet). */
  recent(opts: { limit?: number; source?: RecentError["source"] } = {}): RecentError[] {
    const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
    const fresh = gte(errorLog.at, this.now() - this.maxAgeMs);
    return this.db
      .select()
      .from(errorLog)
      .where(opts.source ? and(fresh, eq(errorLog.source, opts.source)) : fresh)
      .orderBy(desc(errorLog.id))
      .limit(limit)
      .all();
  }
}
