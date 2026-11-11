import { sql } from "drizzle-orm";
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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

/**
 * One generation of an assistant reply (#12). At most one queued/running run per conversation. Survives
 * restarts: a run left queued/running at startup is marked failed ("서버 재시작으로 중단").
 */
export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The user message that started it (null for "다시 생성"). */
    userMessageId: text("user_message_id"),
    assistantMessageId: text("assistant_message_id").notNull(),
    status: text("status", { enum: ["queued", "running", "done", "interrupted", "failed"] }).notNull(),
    errorCode: text("error_code"),
    runtime: text("runtime").notNull(),
    model: text("model").notNull(),
    effort: text("effort"),
    /** Client `Idempotency-Key`: the same key from the same user returns the same run. */
    idempotencyKey: text("idempotency_key"),
    /** Next event sequence number (SSE id). */
    nextEventSeq: integer("next_event_seq").notNull().default(1),
    createdAt: integer("created_at").notNull().default(now),
    endedAt: integer("ended_at"),
  },
  (t) => [
    index("runs_conversation_idx").on(t.conversationId, t.status),
    uniqueIndex("runs_user_idempotency_idx").on(t.userId, t.idempotencyKey),
  ],
);

/** Stream events of a run, kept for replay (`Last-Event-ID`) until an hour after the run ends. */
export const runEvents = sqliteTable(
  "run_events",
  {
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    /** StreamEvent (@agentlee/shared). */
    data: text("data", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

/**
 * Recent errors for the admin screen (#46, FR-10.4) — the same policy as the logs: IDs, codes and route patterns
 * only, never an error message, prompt, tool input/output or SDK text. Trimmed to the newest rows by ErrorLog.
 * No foreign keys: an entry outlives the conversation it mentions, but it holds nothing from it.
 */
export const errorLog = sqliteTable(
  "error_log",
  {
    id: integer("id").primaryKey(),
    at: integer("at").notNull(),
    /** Where it happened: an HTTP request, a run, or a tool call inside a run. */
    source: text("source", { enum: ["http", "run", "tool"] }).notNull(),
    /** Sanitised code (`runtime_error`, `usage_limit`, `internal_error`, …). */
    code: text("code").notNull(),
    category: text("category").notNull(),
    userId: text("user_id"),
    conversationId: text("conversation_id"),
    runId: text("run_id"),
    runtime: text("runtime"),
    tool: text("tool"),
    /** `METHOD /route/:pattern` for HTTP errors. */
    route: text("route"),
    statusCode: integer("status_code"),
  },
  (t) => [index("error_log_at_idx").on(t.at)],
);

/**
 * In-app notifications (#34, FR-13.3) — the 🔔 inbox, and the push queue at the same time: `pushState` says what
 * happens with the device push. Rows outlive a restart, so pushes held for quiet hours are still sent afterwards.
 * - `queued`: to be pushed now (also what a push interrupted by a restart goes back to)
 * - `held`: quiet hours — pushed as one bundle when they end
 * - `sending` → `sent` (or `unsent`: no device took it); `cancelled`: permission gone at send time (hidden)
 * `refKind`/`refId` name the resource the notification is about; access to it is re-checked before every push
 * and every inbox read.
 */
export const notifications = sqliteTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    url: text("url").notNull(),
    refKind: text("ref_kind"),
    refId: text("ref_id"),
    pushState: text("push_state", {
      enum: ["queued", "held", "sending", "sent", "unsent", "cancelled"],
    }).notNull(),
    createdAt: integer("created_at").notNull(),
    readAt: integer("read_at"),
  },
  (t) => [
    index("notifications_user_created_idx").on(t.userId, t.createdAt),
    index("notifications_push_state_idx").on(t.pushState, t.userId),
  ],
);

/**
 * A device that receives web push (#34). Bound to the account *and* the login session that registered it:
 * logging out, a password change elsewhere, deactivation or an expired session removes it (FK cascade).
 * The endpoint is a bearer capability: it is stored encrypted (with keys) and found again by its hash.
 */
export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    endpointHash: text("endpoint_hash").notNull().unique(),
    /** Encrypted JSON `{ endpoint, keys: { p256dh, auth } }` (AAD `push:<id>`). */
    secret: text("secret").notNull(),
    label: text("label").notNull(),
    createdAt: integer("created_at").notNull(),
    lastSentAt: integer("last_sent_at"),
  },
  (t) => [index("push_subscriptions_user_idx").on(t.userId)],
);

/** Per-user notification settings (FR-12.8): quiet hours in the user's time zone ("HH:MM", null = off). */
export const notificationPrefs = sqliteTable("notification_prefs", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  quietStart: text("quiet_start"),
  quietEnd: text("quiet_end"),
  timeZone: text("time_zone").notNull().default("Asia/Seoul"),
  updatedAt: integer("updated_at").notNull(),
});
