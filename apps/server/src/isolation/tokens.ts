import crypto from "node:crypto";
import { knownSecrets } from "../secrets/known.js";

/**
 * Tokens for calls from a runtime to our MCP server (#42, used by #43). Each token is scoped to one user, one
 * conversation and one run, and dies with the run. The MCP server resolves every tool call through `verify`
 * and must refuse resources outside `scope.conversationId` (`allows`).
 */
export type McpScope = {
  userId: string;
  conversationId: string;
  runId: string;
  expiresAt: number;
  /**
   * A narrower skill scope (#56): the only skills this run may use (a schedule's selection). Absent: every skill the
   * user may use. It never widens anything — the user's own permissions are checked as well.
   */
  skills?: readonly string[] | undefined;
};
/**
 * What a token's run may call, enforced by our MCP server at every call (#211: a 깊이 조사 step): only these tools,
 * and at most `left` calls in all. Absent: the run's usual tools, no count.
 */
type Limits = { tools?: ReadonlySet<string>; left?: number };
type Entry = McpScope & { token: string; limits?: Limits };

export class McpTokens {
  /** By hash; the token itself is kept only to unregister it from the known secrets when it dies. */
  private readonly byHash = new Map<string, Entry>();
  constructor(private readonly now: () => number = Date.now) {}

  private static hash(token: string) {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  issue(
    scope: Omit<McpScope, "expiresAt">,
    ttlMs = 6 * 3600_000,
    limits?: { tools?: readonly string[]; maxCalls?: number },
  ): string {
    const token = crypto.randomBytes(32).toString("base64url");
    this.byHash.set(McpTokens.hash(token), {
      ...scope,
      expiresAt: this.now() + ttlMs,
      token,
      ...(limits
        ? {
            limits: {
              ...(limits.tools ? { tools: new Set(limits.tools) } : {}),
              ...(limits.maxCalls !== undefined ? { left: limits.maxCalls } : {}),
            },
          }
        : {}),
    });
    knownSecrets.add(token, { fresh: true }); // a runtime that echoes its token never gets it into the reply
    return token;
  }

  verify(token: string | undefined): McpScope | undefined {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const h = McpTokens.hash(token);
    const s = this.byHash.get(h);
    if (!s) return undefined;
    if (s.expiresAt <= this.now()) {
      this.byHash.delete(h);
      knownSecrets.remove(s.token);
      return undefined;
    }
    return {
      userId: s.userId,
      conversationId: s.conversationId,
      runId: s.runId,
      expiresAt: s.expiresAt,
      ...(s.skills ? { skills: [...s.skills] } : {}),
    };
  }

  /** True only for the token's own conversation (and its own user). */
  allows(scope: McpScope, req: { userId: string; conversationId: string }): boolean {
    return scope.userId === req.userId && scope.conversationId === req.conversationId;
  }

  /**
   * Takes one call of `tool` for the run (#211): refused — nothing counted — when the run's token does not allow that
   * tool (`tool_not_allowed`) or has no calls left (`tool_quota`); a run without limits always may. Checked at our MCP
   * server's entry, before the tool runs, so a runtime that calls past its budget is refused there.
   */
  take(runId: string, tool: string): "tool_not_allowed" | "tool_quota" | undefined {
    for (const s of this.byHash.values()) {
      if (s.runId !== runId || !s.limits) continue;
      if (s.limits.tools && !s.limits.tools.has(tool)) return "tool_not_allowed";
      if (s.limits.left !== undefined) {
        if (s.limits.left <= 0) return "tool_quota";
        s.limits.left--;
      }
      return undefined;
    }
    return undefined;
  }

  /** Runs whose tokens were revoked (bounded, oldest out): a call still in flight then stores nothing (#211). */
  private readonly revoked = new Map<string, number>();

  /** Whether the run's tokens were revoked (stopped, interrupted) — not merely expired or never issued. */
  wasRevoked(runId: string): boolean {
    return this.revoked.has(runId);
  }

  /** Called once when the run's tokens are revoked (#234: a PDF extraction of that run stops at once). */
  private readonly stopWatchers = new Map<string, Set<() => void>>();
  onRevoke(runId: string, fn: () => void): () => void {
    // Revoked and not given a token again since: it is stopped now. (A run issued a token after a revocation —
    // tests that reopen a run — is watched for its next revocation.)
    if (this.revoked.has(runId) && !this.hasRun(runId)) {
      fn();
      return () => {};
    }
    let set = this.stopWatchers.get(runId);
    if (!set) this.stopWatchers.set(runId, (set = new Set()));
    set.add(fn);
    return () => {
      set.delete(fn);
      if (!set.size) this.stopWatchers.delete(runId);
    };
  }

  revokeRun(runId: string): void {
    const watchers = this.stopWatchers.get(runId);
    this.stopWatchers.delete(runId);
    this.revoked.delete(runId);
    this.revoked.set(runId, this.now());
    if (this.revoked.size > 2000) this.revoked.delete(this.revoked.keys().next().value!);
    for (const [h, s] of this.byHash)
      if (s.runId === runId) {
        this.byHash.delete(h);
        knownSecrets.remove(s.token);
      }
    for (const fn of watchers ?? []) {
      try {
        fn();
      } catch {
        // a watcher's failure never stops the revocation
      }
    }
  }

  /** Whether any live token of this run is left (false once the run ended or was revoked). */
  hasRun(runId: string): boolean {
    const t = this.now();
    for (const s of this.byHash.values()) if (s.runId === runId && s.expiresAt > t) return true;
    return false;
  }

  size(): number {
    return this.byHash.size;
  }
}
