import crypto from "node:crypto";
import { and, count, desc, eq, gt, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { PUBLIC_LINK_TOKEN, type PublicLinkStatus } from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { artifacts, artifactVersions, conversations, publicLinks, users } from "../db/schema.js";

export type PublicLinkRow = typeof publicLinks.$inferSelect;

const DAY_MS = 86_400_000;

/** SHA-256 of a token (hex): what the table holds and looks up. The token itself is never stored. */
export const tokenHash = (token: string) => crypto.createHash("sha256").update(token, "utf8").digest("hex");
/** A new token: 32 random bytes, base64url (43 characters, 256 bits — not guessable). */
export const newToken = () => crypto.randomBytes(32).toString("base64url");

export const statusOf = (
  r: Pick<PublicLinkRow, "disabledAt" | "expiresAt">,
  now: number,
): PublicLinkStatus => (r.disabledAt !== null ? "disabled" : r.expiresAt <= now ? "expired" : "active");

/** A link the public routes may serve: everything it shows is checked again on every request. */
export type LiveLink = {
  link: PublicLinkRow;
  artifact: typeof artifacts.$inferSelect;
};

/**
 * Public link rows (#204). Lookups are by the token's hash only. `live` decides whether a token opens anything: the
 * link is on and not expired, its artifact still exists and still belongs to the link's owner (in a conversation of
 * theirs), the owner's account is active and the fixed version exists. Anything else is "no such link" (404).
 */
export class PublicLinkStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  /** A new link of `version`; returns the row and the token (shown once, never stored). */
  create(input: { ownerId: string; artifactId: string; version: number; days: number }): {
    row: PublicLinkRow;
    token: string;
  } {
    const token = newToken();
    const at = this.now();
    const row = this.db
      .insert(publicLinks)
      .values({
        id: crypto.randomUUID(),
        tokenHash: tokenHash(token),
        ownerId: input.ownerId,
        artifactId: input.artifactId,
        version: input.version,
        createdAt: at,
        expiresAt: at + input.days * DAY_MS,
      })
      .returning()
      .get();
    return { row, token };
  }

  get(id: string): PublicLinkRow | undefined {
    return this.db.select().from(publicLinks).where(eq(publicLinks.id, id)).get();
  }

  /** Links that are on and not expired, of one account. */
  activeCount(ownerId: string): number {
    return (
      this.db
        .select({ n: count() })
        .from(publicLinks)
        .where(
          and(
            eq(publicLinks.ownerId, ownerId),
            isNull(publicLinks.disabledAt),
            gt(publicLinks.expiresAt, this.now()),
          ),
        )
        .get()?.n ?? 0
    );
  }

  /** The owner's links, newest first, with their artifact's kind and (scrubbed by the caller) title. */
  listByOwner(ownerId: string, artifactId?: string) {
    return this.db
      .select({ link: publicLinks, title: artifacts.title, kind: artifacts.kind })
      .from(publicLinks)
      .innerJoin(artifacts, eq(artifacts.id, publicLinks.artifactId))
      .where(
        and(
          eq(publicLinks.ownerId, ownerId),
          artifactId !== undefined ? eq(publicLinks.artifactId, artifactId) : undefined,
        ),
      )
      .orderBy(desc(publicLinks.createdAt), desc(sql`${publicLinks}.rowid`))
      .limit(200)
      .all();
  }

  /** One link with its artifact's kind and title (the owner's own view). */
  withArtifact(id: string) {
    return this.db
      .select({ link: publicLinks, title: artifacts.title, kind: artifacts.kind })
      .from(publicLinks)
      .innerJoin(artifacts, eq(artifacts.id, publicLinks.artifactId))
      .where(eq(publicLinks.id, id))
      .get();
  }

  /** Every link with its owner's name — the admin's list (no artifact title, no content: FR-1.5). */
  listAll() {
    return this.db
      .select({ link: publicLinks, ownerName: users.name })
      .from(publicLinks)
      .innerJoin(users, eq(users.id, publicLinks.ownerId))
      .orderBy(desc(publicLinks.createdAt), desc(sql`${publicLinks}.rowid`))
      .limit(500)
      .all();
  }

  counts(): { active: number; expired: number; disabled: number } {
    const at = this.now();
    const n = (where: ReturnType<typeof and>) =>
      this.db.select({ n: count() }).from(publicLinks).where(where).get()?.n ?? 0;
    return {
      active: n(and(isNull(publicLinks.disabledAt), gt(publicLinks.expiresAt, at))),
      expired: n(and(isNull(publicLinks.disabledAt), lte(publicLinks.expiresAt, at))),
      disabled: n(and(isNotNull(publicLinks.disabledAt))),
    };
  }

  /** Turns a link off (at once and for good). False when it was already off. */
  disable(id: string): boolean {
    return (
      this.db
        .update(publicLinks)
        .set({ disabledAt: this.now() })
        .where(and(eq(publicLinks.id, id), isNull(publicLinks.disabledAt)))
        .run().changes > 0
    );
  }

  /** Every link of an account off (its deactivation: they stay off if the account comes back). */
  disableAllOf(ownerId: string): number {
    return this.db
      .update(publicLinks)
      .set({ disabledAt: this.now() })
      .where(and(eq(publicLinks.ownerId, ownerId), isNull(publicLinks.disabledAt)))
      .run().changes;
  }

  /** The live link a token names, or undefined (malformed, unknown, off, expired, or its artifact or owner gone). */
  live(token: string): LiveLink | undefined {
    if (!PUBLIC_LINK_TOKEN.test(token)) return undefined;
    const r = this.db
      .select({ link: publicLinks, artifact: artifacts })
      .from(publicLinks)
      .innerJoin(artifacts, eq(artifacts.id, publicLinks.artifactId))
      .innerJoin(conversations, eq(conversations.id, artifacts.conversationId))
      .innerJoin(users, eq(users.id, publicLinks.ownerId))
      .innerJoin(
        artifactVersions,
        and(
          eq(artifactVersions.artifactId, publicLinks.artifactId),
          eq(artifactVersions.version, publicLinks.version),
        ),
      )
      .where(
        and(
          eq(publicLinks.tokenHash, tokenHash(token)),
          isNull(publicLinks.disabledAt),
          gt(publicLinks.expiresAt, this.now()),
          eq(users.active, true),
          eq(artifacts.userId, publicLinks.ownerId),
          eq(conversations.ownerId, publicLinks.ownerId),
        ),
      )
      .get();
    return r;
  }

  /** One view of the link's page: the count and when (nothing about who). */
  recordView(id: string): void {
    this.db
      .update(publicLinks)
      .set({ viewCount: sql`${publicLinks.viewCount} + 1`, lastViewedAt: this.now() })
      .where(eq(publicLinks.id, id))
      .run();
  }

  /** The version's stored text as written (not scrubbed on read) — for the pre-publish secret check only. */
  storedVersion(artifactId: string, version: number): { title: string; content: string } | undefined {
    return this.db
      .select({ title: artifactVersions.title, content: artifactVersions.content })
      .from(artifactVersions)
      .where(and(eq(artifactVersions.artifactId, artifactId), eq(artifactVersions.version, version)))
      .get();
  }
}
