import crypto from "node:crypto";
import { and, asc, count, desc, eq, lt, max, or, sql } from "drizzle-orm";
import {
  ARTIFACT_LIMITS,
  ChartSpec,
  chartShapeOk,
  CodeLanguage,
  DocumentRef,
  TableData,
  type Artifact,
  type ArtifactKind,
  type ArtifactVersionInfo,
} from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { artifacts, artifactVersions, conversations, messages, runs } from "../db/schema.js";
import {
  isRedactedContent,
  REDACTED_CONTENT,
  scrubContent,
  scrubKnown,
  scrubKnownDeep,
} from "../secrets/known.js";

/**
 * A version as read (round 26): its content scrubbed by kind — canonical JSON value by value, so it stays valid —
 * and its size and hash following the scrubbed content.
 */
function scrubVersion(v: ArtifactVersionRow, kind: ArtifactKind | undefined): ArtifactVersionRow {
  const { content, ...rest } = v;
  const scrubbed = scrubStored(kind, content);
  const out = { ...scrubKnownDeep(rest), content: scrubbed };
  if (scrubbed === content) return out.title === v.title && out.language === v.language ? v : out;
  return { ...out, bytes: Buffer.byteLength(scrubbed, "utf8"), contentHash: sha256(scrubbed) };
}

export type ArtifactRow = typeof artifacts.$inferSelect;
export type ArtifactVersionRow = typeof artifactVersions.$inferSelect;

/** Who an artifact is for — the run's MCP token scope (checked again against the conversation's owner). */
export type ArtifactScope = { userId: string; conversationId: string; runId: string };

/** The kind-specific field of a tool call; exactly the one of the artifact's kind is given. */
export type ArtifactBody = {
  content?: string | undefined;
  language?: string | undefined;
  chart?: unknown;
  table?: unknown;
  document?: unknown;
};

/** Outcome codes of the artifact tools (logged as `artifactCode`, shown to the model as `{ error }`). */
export const ARTIFACT_CODES = [
  "artifact_bad_input",
  "artifact_too_large",
  "artifact_not_found",
  "artifact_not_allowed",
  "artifact_limit",
  /** The version's content is unreadable: a known secret spans its JSON (#53 review, `REDACTED_CONTENT`). */
  "artifact_redacted",
] as const;
export type ArtifactCode = (typeof ARTIFACT_CODES)[number];

export class ArtifactError extends Error {
  constructor(readonly code: ArtifactCode) {
    super(code);
  }
}

const TEXT_KINDS = new Set<ArtifactKind>(["html", "svg", "markdown", "code"]);
const FIELDS = ["content", "chart", "table", "document"] as const;
const fieldOf = (kind: ArtifactKind): (typeof FIELDS)[number] =>
  TEXT_KINDS.has(kind) ? "content" : (kind as "chart" | "table" | "document");

const sha256 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
// eslint-disable-next-line no-control-regex -- refusing control characters is the point
const TITLE = /^[^\0-\x1f\x7f]+$/u;

export function cleanTitle(t: unknown): string {
  if (typeof t !== "string") throw new ArtifactError("artifact_bad_input");
  const s = t.trim();
  if (!s || s.length > ARTIFACT_LIMITS.title || !TITLE.test(s)) throw new ArtifactError("artifact_bad_input");
  return s;
}

/**
 * The stored text of one version: the given text (html, svg, markdown, code) or canonical JSON of the validated
 * data (chart, table, document). Exactly the field of the kind must be present; the byte limit is on the result.
 */
export function encodeBody(
  kind: ArtifactKind,
  body: ArtifactBody,
): { content: string; language: string | null } {
  const field = fieldOf(kind);
  for (const f of FIELDS)
    if (f !== field && body[f] !== undefined) throw new ArtifactError("artifact_bad_input");
  if (body.language !== undefined && kind !== "code") throw new ArtifactError("artifact_bad_input");
  let content: string;
  let language: string | null = null;
  if (field === "content") {
    if (typeof body.content !== "string" || !body.content.trim())
      throw new ArtifactError("artifact_bad_input");
    content = body.content;
    if (kind === "svg" && !/<svg[\s>]/i.test(content)) throw new ArtifactError("artifact_bad_input");
    if (kind === "code" && body.language !== undefined) {
      const l = CodeLanguage.safeParse(body.language);
      if (!l.success) throw new ArtifactError("artifact_bad_input");
      language = l.data;
    }
  } else if (field === "chart") {
    const c = ChartSpec.safeParse(body.chart);
    if (!c.success || !chartShapeOk(c.data)) throw new ArtifactError("artifact_bad_input");
    content = JSON.stringify(c.data);
  } else if (field === "table") {
    const t = TableData.safeParse(body.table);
    if (!t.success || t.data.rows.some((r) => r.length !== t.data.columns.length))
      throw new ArtifactError("artifact_bad_input");
    content = JSON.stringify(t.data);
  } else {
    const d = DocumentRef.safeParse(body.document);
    if (!d.success) throw new ArtifactError("artifact_bad_input");
    content = JSON.stringify(d.data);
  }
  if (Buffer.byteLength(content, "utf8") > ARTIFACT_LIMITS.contentBytes)
    throw new ArtifactError("artifact_too_large");
  return { content, language };
}

/**
 * Chart, table and document data whose scrub just changed it, checked against the kind's schema again (#53 review): a
 * masked value that leaves invalid data (a candle's OHLC price) makes the version unreadable (`REDACTED_CONTENT`, 409)
 * rather than served wrong (a price drawn as 0). Text kinds and an unknown kind are returned as they are. Also used
 * by the background rescrub, which writes the result.
 */
export function checkStructured(kind: ArtifactKind | undefined, scrubbed: string): string {
  if (isRedactedContent(scrubbed) || !kind || TEXT_KINDS.has(kind)) return scrubbed;
  try {
    encodeBody(kind, { [fieldOf(kind)]: JSON.parse(scrubbed) as unknown });
    return scrubbed;
  } catch {
    return REDACTED_CONTENT;
  }
}

/**
 * An artifact version's stored text through the secrets known now, by its kind (#53 review): `scrubContent`, and only
 * when that changed it, `checkStructured`. Unchanged content is never parsed here (a list read stays cheap; what was
 * stored was checked when it was written, or by the rescrub that changed it). Every write, read and fork copy.
 */
export function scrubStored(kind: ArtifactKind | undefined, content: string): string {
  const scrubbed = scrubContent(content);
  return scrubbed === content ? content : checkStructured(kind, scrubbed);
}

/** A title as given, through the secrets known now (anything else is refused by `cleanTitle`). */
const scrubTitle = (t: unknown): unknown => (typeof t === "string" ? scrubKnown(t) : t);

/**
 * The stored text of a version written now (#53 review): the body encoded from what was given, then through
 * `scrubContent` — the one decision every read, fork copy and the background rescrub make too. JSON is scrubbed value
 * by value (a masked number becomes null); a secret spanning its structure makes the version unreadable
 * (`REDACTED_CONTENT`) instead of storing JSON broken by a mask; any other text is scrubbed as text.
 */
export function encodeScrubbed(
  kind: ArtifactKind,
  body: ArtifactBody,
): { content: string; language: string | null } {
  const enc = encodeBody(kind, body);
  return {
    content: scrubStored(kind, enc.content),
    language: enc.language === null ? null : scrubKnown(enc.language),
  };
}

export function toArtifact(r: ArtifactRow): Artifact {
  return {
    id: r.id,
    conversationId: r.conversationId,
    messageId: r.messageId ?? null,
    runId: r.runId ?? null,
    kind: r.kind,
    title: r.title,
    language: r.language ?? null,
    latestVersion: r.latestVersion,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export function toVersionInfo(v: ArtifactVersionRow): ArtifactVersionInfo {
  return {
    version: v.version,
    contentHash: v.contentHash,
    bytes: v.bytes,
    title: v.title,
    language: v.language ?? null,
    runId: v.runId ?? null,
    revertedFrom: v.revertedFrom ?? null,
    createdAt: v.createdAt,
    // Unreadable content (#53 review): the viewer shows a notice instead of loading it.
    ...(isRedactedContent(v.content) ? { redacted: true as const } : {}),
  };
}

/**
 * Artifacts of conversations (#27). Written only for the run's own user and conversation, and only if that user
 * owns the conversation (the scope comes from the run-scoped token; this is the second check). Versions are
 * never changed: an update or a revert inserts the next one (the database refuses updates of version rows).
 */
export class ArtifactStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  private owns(scope: ArtifactScope): boolean {
    const c = this.db
      .select({ ownerId: conversations.ownerId })
      .from(conversations)
      .where(eq(conversations.id, scope.conversationId))
      .get();
    return c?.ownerId === scope.userId;
  }

  /** The assistant message of the scope's run, if that run belongs to the conversation and the message exists. */
  private messageOf(scope: ArtifactScope): string | null {
    const r = this.db
      .select({ messageId: runs.assistantMessageId })
      .from(runs)
      .innerJoin(messages, eq(messages.id, runs.assistantMessageId))
      .where(and(eq(runs.id, scope.runId), eq(runs.conversationId, scope.conversationId)))
      .get();
    return r?.messageId ?? null;
  }

  create(
    scope: ArtifactScope,
    raw: { kind: ArtifactKind; title: unknown } & ArtifactBody,
  ): { artifact: ArtifactRow; version: ArtifactVersionRow } {
    if (!this.owns(scope)) throw new ArtifactError("artifact_not_allowed");
    // A runtime's artifact never stores a known secret (review round 23) — by the same decision as every read.
    const title = cleanTitle(scrubTitle(raw.title));
    const { content, language } = encodeScrubbed(raw.kind, raw);
    return this.db.transaction((tx) => {
      const n = tx
        .select({ n: count() })
        .from(artifacts)
        .where(eq(artifacts.conversationId, scope.conversationId))
        .get()!.n;
      if (n >= ARTIFACT_LIMITS.artifactsPerConversation) throw new ArtifactError("artifact_limit");
      const at = this.now();
      const artifact = tx
        .insert(artifacts)
        .values({
          id: crypto.randomUUID(),
          userId: scope.userId,
          conversationId: scope.conversationId,
          messageId: this.messageOf(scope),
          runId: scope.runId,
          kind: raw.kind,
          title,
          language,
          latestVersion: 1,
          createdAt: at,
          updatedAt: at,
        })
        .returning()
        .get();
      const version = this.insertVersion(tx, artifact.id, 1, {
        title,
        content,
        language,
        runId: scope.runId,
        at,
      });
      return { artifact, version };
    });
  }

  /**
   * A new version of an artifact of the scope's conversation. An id from another conversation (or user) is not
   * found. The same content, title and language as the latest version adds nothing (a repeated call returns
   * it). A code artifact keeps the latest version's language unless the call gives one.
   */
  update(
    scope: ArtifactScope,
    artifactId: string,
    raw: { title?: unknown } & ArtifactBody,
  ): { artifact: ArtifactRow; version: ArtifactVersionRow } {
    if (!this.owns(scope)) throw new ArtifactError("artifact_not_allowed");
    const a = this.get(artifactId);
    if (!a || a.conversationId !== scope.conversationId || a.userId !== scope.userId)
      throw new ArtifactError("artifact_not_found");
    const title = raw.title === undefined ? a.title : cleanTitle(scrubTitle(raw.title));
    const enc = encodeScrubbed(a.kind, raw);
    const latest = this.version(a.id, a.latestVersion);
    const language =
      a.kind === "code" && raw.language === undefined ? (latest?.language ?? null) : enc.language;
    return this.append(a.id, {
      title,
      content: enc.content,
      language,
      runId: scope.runId,
      revertedFrom: null,
    });
  }

  /**
   * One version (default the latest) of an artifact of the scope's conversation, for `artifact_read` (#53): the
   * same checks as `update` — an id from another conversation (or user) is not found. Scrubbed like every read.
   */
  readFor(
    scope: ArtifactScope,
    artifactId: string,
    version?: number,
  ): { artifact: ArtifactRow; version: ArtifactVersionRow } {
    if (!this.owns(scope)) throw new ArtifactError("artifact_not_allowed");
    const a = this.get(artifactId);
    if (!a || a.conversationId !== scope.conversationId || a.userId !== scope.userId)
      throw new ArtifactError("artifact_not_found");
    const v = this.version(a.id, version ?? a.latestVersion);
    if (!v) throw new ArtifactError("artifact_not_found");
    if (isRedactedContent(v.content)) throw new ArtifactError("artifact_redacted");
    return { artifact: a, version: v };
  }

  /** Restores version `version` by copying it (title, content, language) as the newest version. */
  revert(artifactId: string, version: number): { artifact: ArtifactRow; version: ArtifactVersionRow } {
    const old = this.version(artifactId, version);
    const a = this.get(artifactId);
    if (!old || !a) throw new ArtifactError("artifact_not_found");
    // An unreadable version is not made the newest by copying it (#53 review).
    if (isRedactedContent(old.content)) throw new ArtifactError("artifact_redacted");
    return this.append(a.id, {
      title: old.title,
      content: old.content,
      language: old.language ?? null,
      runId: null,
      revertedFrom: old.version,
    });
  }

  private append(
    id: string,
    v: {
      title: string;
      content: string;
      language: string | null;
      runId: string | null;
      revertedFrom: number | null;
    },
  ): { artifact: ArtifactRow; version: ArtifactVersionRow } {
    return this.db.transaction((tx) => {
      const a = tx.select().from(artifacts).where(eq(artifacts.id, id)).get();
      if (!a) throw new ArtifactError("artifact_not_found");
      const latest = tx
        .select()
        .from(artifactVersions)
        .where(and(eq(artifactVersions.artifactId, id), eq(artifactVersions.version, a.latestVersion)))
        .get()!;
      if (
        v.revertedFrom === null &&
        latest.contentHash === sha256(v.content) &&
        latest.title === v.title &&
        (latest.language ?? null) === v.language
      )
        return { artifact: a, version: latest };
      if (a.latestVersion >= ARTIFACT_LIMITS.versionsPerArtifact) throw new ArtifactError("artifact_limit");
      const at = this.now();
      const next = a.latestVersion + 1;
      const version = this.insertVersion(tx, id, next, { ...v, at });
      const artifact = tx
        .update(artifacts)
        .set({ latestVersion: next, title: v.title, language: v.language, updatedAt: at })
        .where(eq(artifacts.id, id))
        .returning()
        .get();
      return { artifact, version };
    });
  }

  private insertVersion(
    tx: Pick<Db, "insert">,
    artifactId: string,
    version: number,
    v: {
      title: string;
      content: string;
      language: string | null;
      runId: string | null;
      revertedFrom?: number | null;
      at: number;
    },
  ): ArtifactVersionRow {
    return tx
      .insert(artifactVersions)
      .values({
        artifactId,
        version,
        title: v.title,
        content: v.content,
        language: v.language,
        contentHash: sha256(v.content),
        bytes: Buffer.byteLength(v.content, "utf8"),
        runId: v.runId,
        revertedFrom: v.revertedFrom ?? null,
        createdAt: v.at,
      })
      .returning()
      .get();
  }

  /**
   * A fork's copy of an artifact (#52, "이어서 대화하기"): a new artifact of `to` (the forker's conversation, which they
   * own) holding the given versions — the ones the share showed — numbered 1…n, oldest first. Scrubbed like every
   * write; no run made it (`runId` null), its message is linked by the fork once that is copied (`linkMessage`).
   */
  copyInto(
    to: { userId: string; conversationId: string },
    src: { kind: ArtifactKind },
    versions: readonly { title: string; language: string | null; content: string }[],
  ): ArtifactRow {
    if (!this.owns({ ...to, runId: "" })) throw new ArtifactError("artifact_not_allowed");
    if (!versions.length || versions.length > ARTIFACT_LIMITS.versionsPerArtifact)
      throw new ArtifactError("artifact_bad_input");
    return this.db.transaction((tx) => {
      const n = tx
        .select({ n: count() })
        .from(artifacts)
        .where(eq(artifacts.conversationId, to.conversationId))
        .get()!.n;
      if (n >= ARTIFACT_LIMITS.artifactsPerConversation) throw new ArtifactError("artifact_limit");
      const at = this.now();
      const clean = versions.map((v) => ({
        title: scrubKnown(v.title),
        language: v.language === null ? null : scrubKnown(v.language),
        content: scrubStored(src.kind, v.content),
      }));
      const last = clean.at(-1)!;
      const artifact = tx
        .insert(artifacts)
        .values({
          id: crypto.randomUUID(),
          userId: to.userId,
          conversationId: to.conversationId,
          messageId: null,
          runId: null,
          kind: src.kind,
          title: last.title,
          language: last.language,
          latestVersion: clean.length,
          createdAt: at,
          updatedAt: at,
        })
        .returning()
        .get();
      clean.forEach((v, i) => this.insertVersion(tx, artifact.id, i + 1, { ...v, runId: null, at }));
      return artifact;
    });
  }

  /** The fork's copied message an artifact copy came with (#52). */
  linkMessage(id: string, messageId: string): void {
    this.db.update(artifacts).set({ messageId }).where(eq(artifacts.id, id)).run();
  }

  // Reads are scrubbed too (round 24): a secret registered after an artifact was stored never comes back in the
  // API, the raw page, a download or an export.
  get(id: string): ArtifactRow | undefined {
    return scrubKnownDeep(this.db.select().from(artifacts).where(eq(artifacts.id, id)).get());
  }

  /** A conversation's artifacts, newest first. */
  list(conversationId: string): ArtifactRow[] {
    return this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.conversationId, conversationId))
      .orderBy(desc(artifacts.createdAt), desc(sql`rowid`))
      .all()
      .map((r) => scrubKnownDeep(r));
  }

  /**
   * The caller's own artifacts across conversations (#28 "내가 만든 것"), most recently changed first, each with
   * its conversation's title. Only artifacts the user made in a conversation the user owns. Keyset paged by
   * `(updatedAt, id)`; `cursor` is the last item of the previous page.
   */
  listByUser(
    userId: string,
    limit: number,
    cursor?: { updatedAt: number; id: string },
  ): {
    items: (ArtifactRow & { conversationTitle: string })[];
    next: { updatedAt: number; id: string } | null;
  } {
    const rows = this.db
      .select({ a: artifacts, conversationTitle: conversations.title })
      .from(artifacts)
      .innerJoin(conversations, eq(conversations.id, artifacts.conversationId))
      .where(
        and(
          eq(artifacts.userId, userId),
          eq(conversations.ownerId, userId),
          cursor
            ? or(
                lt(artifacts.updatedAt, cursor.updatedAt),
                and(eq(artifacts.updatedAt, cursor.updatedAt), lt(artifacts.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(artifacts.updatedAt), desc(artifacts.id))
      .limit(limit + 1)
      .all();
    const items = rows
      .slice(0, limit)
      .map((r) => scrubKnownDeep({ ...r.a, conversationTitle: r.conversationTitle }));
    const last = rows.length > limit ? rows[limit - 1]!.a : undefined;
    return { items, next: last ? { updatedAt: last.updatedAt, id: last.id } : null };
  }

  /**
   * What one run made or changed in its conversation (#28: the artifact cards of its reply): each artifact once,
   * with the newest version that run wrote, in the order the run first touched them. Read from the stored versions
   * — never from what the runtime reported.
   */
  refsOfRun(conversationId: string, runId: string): { artifactId: string; version: number }[] {
    return this.db
      .select({
        artifactId: artifactVersions.artifactId,
        version: max(artifactVersions.version),
      })
      .from(artifactVersions)
      .innerJoin(artifacts, eq(artifacts.id, artifactVersions.artifactId))
      .where(and(eq(artifacts.conversationId, conversationId), eq(artifactVersions.runId, runId)))
      .groupBy(artifactVersions.artifactId)
      .orderBy(asc(sql`min(${artifactVersions}.rowid)`))
      .all()
      .flatMap((r) => (r.version === null ? [] : [{ artifactId: r.artifactId, version: r.version }]));
  }

  /** Versions of one artifact, oldest first (API responses leave the content out: `toVersionInfo`). */
  versions(id: string): ArtifactVersionRow[] {
    const kind = this.kindOf(id);
    return this.db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, id))
      .orderBy(asc(artifactVersions.version))
      .all()
      .map((v) => scrubVersion(v, kind));
  }

  private kindOf(id: string): ArtifactKind | undefined {
    return this.db.select({ kind: artifacts.kind }).from(artifacts).where(eq(artifacts.id, id)).get()?.kind;
  }

  version(id: string, version: number): ArtifactVersionRow | undefined {
    const v = this.db
      .select()
      .from(artifactVersions)
      .where(and(eq(artifactVersions.artifactId, id), eq(artifactVersions.version, version)))
      .get();
    return v && scrubVersion(v, this.kindOf(id));
  }
}
