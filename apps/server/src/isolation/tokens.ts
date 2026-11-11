import crypto from "node:crypto";
import { knownSecrets } from "../secrets/known.js";

/**
 * Tokens for calls from a runtime to our MCP server (#42, used by #43). Each token is scoped to one user, one
 * conversation and one run, and dies with the run. The MCP server resolves every tool call through `verify`
 * and must refuse resources outside `scope.conversationId` (`allows`).
 */
export type McpScope = { userId: string; conversationId: string; runId: string; expiresAt: number };
type Entry = McpScope & { token: string };

export class McpTokens {
  /** By hash; the token itself is kept only to unregister it from the known secrets when it dies. */
  private readonly byHash = new Map<string, Entry>();
  constructor(private readonly now: () => number = Date.now) {}

  private static hash(token: string) {
    return crypto.createHash("sha256").update(token).digest("hex");
  }

  issue(scope: Omit<McpScope, "expiresAt">, ttlMs = 6 * 3600_000): string {
    const token = crypto.randomBytes(32).toString("base64url");
    this.byHash.set(McpTokens.hash(token), { ...scope, expiresAt: this.now() + ttlMs, token });
    knownSecrets.add(token); // a runtime that echoes its token never gets it into the reply
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
    return { userId: s.userId, conversationId: s.conversationId, runId: s.runId, expiresAt: s.expiresAt };
  }

  /** True only for the token's own conversation (and its own user). */
  allows(scope: McpScope, req: { userId: string; conversationId: string }): boolean {
    return scope.userId === req.userId && scope.conversationId === req.conversationId;
  }

  revokeRun(runId: string): void {
    for (const [h, s] of this.byHash)
      if (s.runId === runId) {
        this.byHash.delete(h);
        knownSecrets.remove(s.token);
      }
  }

  size(): number {
    return this.byHash.size;
  }
}
