import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(unixepoch() * 1000)`;

/** Family accounts (PRD FR-1). Emails are unique and lower-cased by the service layer. */
export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: text("role", { enum: ["admin", "member"] }).notNull(),
  passwordHash: text("password_hash"),
  mustChangePassword: integer("must_change_password", { mode: "boolean" }).notNull().default(false),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  /** What the user may use (runtimes, models, skills) — JSON, see `UserPermissions` in @agentlee/shared. */
  permissions: text("permissions", { mode: "json" })
    .$type<{ runtimes: string[]; models: "all" | string[]; skills: "all" | string[] }>()
    .notNull()
    .default(sql`'{"runtimes":["claude-code","codex"],"models":"all","skills":"all"}'`),
  /** The user's default runtime for new conversations (FR-12); null = service default. */
  defaultRuntime: text("default_runtime"),
  createdAt: integer("created_at").notNull().default(now),
  updatedAt: integer("updated_at").notNull().default(now),
});

/** Login sessions. `id` stores a hash of the cookie token, never the token itself. */
export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull().default(now),
    expiresAt: integer("expires_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull().default(now),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/** Key/value service settings. Secret values are stored encrypted (see crypto/secrets.ts). */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  encrypted: integer("encrypted", { mode: "boolean" }).notNull().default(false),
  updatedAt: integer("updated_at").notNull().default(now),
});

/**
 * Conversations (#11). The server owns the history (PRD D8); runtime sessions only process it.
 * `revision` goes up whenever history is rewritten (edit / regenerate).
 */
export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    /** "auto" titles may be replaced by a generated one; "user" titles are never touched. */
    titleSource: text("title_source", { enum: ["auto", "user"] })
      .notNull()
      .default("auto"),
    pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
    kind: text("kind", { enum: ["normal", "schedule", "fork"] })
      .notNull()
      .default("normal"),
    forkedFrom: text("forked_from"),
    lastRuntime: text("last_runtime"),
    revision: integer("revision").notNull().default(0),
    /** Next message sequence number (per conversation, monotonically increasing). */
    nextSeq: integer("next_seq").notNull().default(1),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [index("conversations_owner_updated_idx").on(t.ownerId, t.updatedAt)],
);

/**
 * Messages. Only `active` messages form the current history; edit / regenerate deactivates the edited message
 * and everything after it (kept as earlier versions) and links the new message via `replaces`.
 */
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
    /** MessagePart[] (@agentlee/shared), reasoning parts included — filtered on the way out. */
    parts: text("parts", { mode: "json" }).$type<unknown[]>().notNull(),
    /** Text of the public parts only, for search (reasoning never becomes searchable). */
    searchText: text("search_text").notNull().default(""),
    runtime: text("runtime"),
    model: text("model"),
    effort: text("effort"),
    connectionId: text("connection_id"),
    status: text("status", { enum: ["pending", "streaming", "complete", "stopped", "error"] })
      .notNull()
      .default("complete"),
    revision: integer("revision").notNull(),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    replaces: text("replaces"),
    supersededBy: text("superseded_by"),
    /** Conversation revision in which this message stopped being part of the history. */
    archivedAtRevision: integer("archived_at_revision"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("messages_conversation_seq_idx").on(t.conversationId, t.seq),
    index("messages_conversation_active_idx").on(t.conversationId, t.active, t.seq),
  ],
);

/** A runtime's own session for a conversation, and how much of the history it has seen (#45 checks it). */
export const runtimeSessions = sqliteTable(
  "runtime_sessions",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    runtime: text("runtime").notNull(),
    connectionId: text("connection_id"),
    externalSessionId: text("external_session_id").notNull(),
    /** Last message the runtime has seen, and the conversation revision at that point. */
    lastMessageId: text("last_message_id"),
    conversationRevision: integer("conversation_revision").notNull(),
    invalidated: integer("invalidated", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [index("runtime_sessions_conversation_idx").on(t.conversationId)],
);
