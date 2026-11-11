import crypto from "node:crypto";
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import {
  ARTIFACT_LIMITS,
  ChartSpec,
  CodeLanguage,
  DocumentRef,
  TableData,
  type Artifact,
  type ArtifactKind,
  type ArtifactVersionInfo,
} from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { artifacts, artifactVersions, conversations, messages, runs } from "../db/schema.js";
import { scrubKnownDeep } from "../secrets/known.js";

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
    if (!c.success || c.data.series.some((s) => s.values.length !== c.data.labels.length))
      throw new ArtifactError("artifact_bad_input");
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
    // A runtime's artifact never stores a known secret (review round 23).
    const input = scrubKnownDeep(raw);
    const title = cleanTitle(input.title);
    const { content, language } = encodeBody(input.kind, input);
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
          kind: input.kind,
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
    const input = scrubKnownDeep(raw);
    const a = this.get(artifactId);
    if (!a || a.conversationId !== scope.conversationId || a.userId !== scope.userId)
      throw new ArtifactError("artifact_not_found");
    const title = input.title === undefined ? a.title : cleanTitle(input.title);
    const enc = encodeBody(a.kind, input);
    const latest = this.version(a.id, a.latestVersion);
    const language =
      a.kind === "code" && input.language === undefined ? (latest?.language ?? null) : enc.language;
    return this.append(a.id, {
      title,
      content: enc.content,
      language,
      runId: scope.runId,
      revertedFrom: null,
    });
  }

  /** Restores version `version` by copying it (title, content, language) as the newest version. */
  revert(artifactId: string, version: number): { artifact: ArtifactRow; version: ArtifactVersionRow } {
    const old = this.version(artifactId, version);
    const a = this.get(artifactId);
    if (!old || !a) throw new ArtifactError("artifact_not_found");
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

  /** Versions of one artifact, oldest first (API responses leave the content out: `toVersionInfo`). */
  versions(id: string): ArtifactVersionRow[] {
    return this.db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, id))
      .orderBy(asc(artifactVersions.version))
      .all()
      .map((r) => scrubKnownDeep(r));
  }

  version(id: string, version: number): ArtifactVersionRow | undefined {
    return scrubKnownDeep(
      this.db
        .select()
        .from(artifactVersions)
        .where(and(eq(artifactVersions.artifactId, id), eq(artifactVersions.version, version)))
        .get(),
    );
  }
}
