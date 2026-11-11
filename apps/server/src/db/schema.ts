import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
  /** Youth account (PRD NFR 청소년 — the son, 고2): its runs get the youth safety and learning-support instructions. */
  youth: integer("youth", { mode: "boolean" }).notNull().default(false),
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
    /** "자료 조사 모드" toggle (FR-5.5): runs in this conversation get the research instructions (#20). */
    researchMode: integer("research_mode", { mode: "boolean" }).notNull().default(false),
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
    /**
     * Fingerprint of the system instructions the session was started with (#20). A session is resumed only with
     * the same instructions — runtimes keep the start prompt, so a changed one needs a fresh session.
     */
    instructionsHash: text("instructions_hash"),
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
    /** Instruction template versions the run used, e.g. `common@1,youth@1` (#20); null until its session opens. */
    instructions: text("instructions"),
    /** The runtime connection the run uses (#17); null for runtimes without connections (FakeRuntime). */
    connectionId: text("connection_id"),
    /**
     * The connection's credential version the run was accepted with (#17): the run uses exactly that credential,
     * and only a failure of the still-current version marks the connection expired.
     */
    connectionVersion: integer("connection_version"),
    /**
     * The user asked for the family shared connection (`useShared`), e.g. confirming the "personal connection
     * reached its limit — continue on the shared one?" notice. Kept on the run it applied to (#17).
     */
    useShared: integer("use_shared", { mode: "boolean" }).notNull().default(false),
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

/**
 * Per-session push generation (#34). Turning a device off (or removing it from another device) bumps it, and it
 * is part of the session tag every registration must carry — so a re-registration that started before the "off"
 * (a service worker request still in flight) is refused when it arrives. Gone with the session.
 */
export const pushSessionState = sqliteTable("push_session_state", {
  sessionId: text("session_id")
    .primaryKey()
    .references(() => sessions.id, { onDelete: "cascade" }),
  generation: integer("generation").notNull().default(0),
});

/**
 * Runtime connections (#17, PRD D2 / FR-11): runtime × auth type × scope.
 * - `shared`: registered by an admin, API key only, used by the family members the admin allows.
 * - `personal`: one user's own (`ownerId`); API key or subscription. A subscription is never shared, and its scope
 *   cannot be changed. A Claude subscription is allowed on an admin's own account only.
 * `secret` is the credential encrypted with the master key (AES-256-GCM, AAD `connection:<id>`); it is never
 * returned by any API — `hint` (last 4 characters) is all the UI sees. Disconnecting keeps the row (history refers
 * to it) but wipes the secret and sets `disconnectedAt`.
 * Only `passed` connections are offered or used; a runtime auth failure marks the connection `expired`.
 */
export const connections = sqliteTable(
  "connections",
  {
    id: text("id").primaryKey(),
    runtime: text("runtime").notNull(),
    authType: text("auth_type", { enum: ["api_key", "subscription"] }).notNull(),
    scope: text("scope", { enum: ["shared", "personal"] }).notNull(),
    /** The user a personal connection belongs to; null for shared connections. */
    ownerId: text("owner_id").references(() => users.id, { onDelete: "cascade" }),
    /** Who registered it (the owner, or an admin on the owner's behalf). */
    createdBy: text("created_by"),
    label: text("label").notNull(),
    secret: text("secret"),
    /**
     * Goes up whenever the stored credential changes — replaced by a person (new key, new login) or refreshed by the
     * server (a ChatGPT login's tokens, #18). Runs and tests are bound to the version they used.
     */
    credentialVersion: integer("credential_version").notNull().default(1),
    /**
     * The version at which a person last replaced the credential. Refreshes keep it: a run or test bound to any
     * version from here on still uses this credential, one bound to an older version never does.
     */
    credentialBaseVersion: integer("credential_base_version").notNull().default(1),
    hint: text("hint"),
    /** The signed-in account's email (ChatGPT login) — shown instead of a hint; never logged. */
    accountEmail: text("account_email"),
    status: text("status", { enum: ["untested", "passed", "failed", "expired"] })
      .notNull()
      .default("untested"),
    lastTestAt: integer("last_test_at"),
    /** Fixed code of the last test's outcome (`ok`, `test_no_stream`, `runtime_auth`, …) — never runtime text. */
    lastTestCode: text("last_test_code"),
    disconnectedAt: integer("disconnected_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    index("connections_owner_idx").on(t.ownerId),
    index("connections_scope_runtime_idx").on(t.scope, t.runtime),
  ],
);

/**
 * What a user may use, per runtime (#17, PRD FR-1.6 / FR-11): the runtime itself, its models and effort values,
 * and whether personal and shared connections are allowed. Without a row the user's `permissions` apply
 * (runtime and model lists), with every effort and both kinds of connection allowed.
 */
export const runtimePolicies = sqliteTable(
  "runtime_policies",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    runtime: text("runtime").notNull(),
    allowed: integer("allowed", { mode: "boolean" }).notNull().default(true),
    models: text("models", { mode: "json" })
      .$type<"all" | string[]>()
      .notNull()
      .default(sql`'"all"'`),
    efforts: text("efforts", { mode: "json" })
      .$type<"all" | string[]>()
      .notNull()
      .default(sql`'"all"'`),
    allowPersonal: integer("allow_personal", { mode: "boolean" }).notNull().default(true),
    allowShared: integer("allow_shared", { mode: "boolean" }).notNull().default(true),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.runtime] })],
);

/**
 * Usage records (#44, PRD FR-9): one row per run attempt — tokens, raw cost and request count, never content.
 * Keyed on (`run_id`, `attempt`): every usage event of the same attempt updates the same row (the last report
 * wins, see `RuntimeEvent` "usage"), so reconnects, duplicate events and a stop cannot add a second row.
 * - `run_id`: the run (`runs.id`) for purposes that run in a conversation; for `connection_test` the test's own
 *   id (there is no run row). No foreign keys on run, conversation or connection: usage outlives a deleted
 *   conversation or a disconnected connection (the FR-9.3 totals must not shrink).
 * - Token columns and `cost_usd` are NULL when the runtime did not report them (not 0).
 * - `cost_usd` is the runtime's own figure (Claude reports one); it is kept for reference only.
 * - Cost (#32, FR-9.1·9.2): `auth_type` is the connection's way of signing in when the row was first written (NULL
 *   without a connection). Only `api_key` rows are costed: `price_version` pins the price table version used when
 *   the row was first written, and `priced_cost_usd` is the cost from that version — a later price edit makes a new
 *   version and never rewrites these. NULL cost on an `api_key` row = no price for that model ("미제공").
 *   Subscription rows count requests and tokens only (no version, no cost).
 */
export const usageRecords = sqliteTable(
  "usage_records",
  {
    id: integer("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Null for purposes outside a conversation (connection tests). */
    conversationId: text("conversation_id"),
    runId: text("run_id").notNull(),
    /** 1, 2, … within the run: one session open + turn sent for the same reply (see runs.ts `Live.attempt`). */
    attempt: integer("attempt").notNull(),
    runtime: text("runtime").notNull(),
    model: text("model").notNull(),
    connectionId: text("connection_id"),
    purpose: text("purpose", {
      enum: ["chat", "schedule", "title", "summary", "connection_test"],
    }).notNull(),
    /** All input tokens, cached ones included (as the adapter contract reports them). */
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    cacheReadTokens: integer("cache_read_tokens"),
    cacheWriteTokens: integer("cache_write_tokens"),
    costUsd: real("cost_usd"),
    /** Requests sent to the runtime in this attempt: one turn = 1. */
    requestCount: integer("request_count").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    /** The connection's auth type at the first write (#32); NULL without a connection. */
    authType: text("auth_type", { enum: ["api_key", "subscription"] }),
    /** Price table version the row is costed with (#32); set once, at the first write. API key rows only. */
    priceVersion: integer("price_version"),
    /** Cost from `price_version` (#32). NULL = not costed (subscription, no connection) or no price ("미제공"). */
    pricedCostUsd: real("priced_cost_usd"),
  },
  (t) => [
    uniqueIndex("usage_records_run_attempt_idx").on(t.runId, t.attempt),
    index("usage_records_user_created_idx").on(t.userId, t.createdAt),
    index("usage_records_created_idx").on(t.createdAt),
  ],
);

/** One model's prices in a price table (#32), USD per million tokens. NULL = not provided ("미제공"). */
export type ModelPriceRow = {
  runtime: string;
  model: string;
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
};

/**
 * Model price table (#32, FR-9.1): every admin edit adds a new version; versions are never changed or deleted, so
 * a usage row's `price_version` always finds the prices it was costed with. The current table = highest version.
 */
export const priceTables = sqliteTable("price_tables", {
  version: integer("version").primaryKey(),
  prices: text("prices", { mode: "json" }).$type<ModelPriceRow[]>().notNull(),
  /** The admin who saved it (no foreign key: the version outlives the account). */
  createdBy: text("created_by"),
  createdAt: integer("created_at").notNull(),
});

/**
 * Web material a run looked at (#50, PRD FR-5.1·5.2): fetched pages (`page`, with the readable text the citation
 * check of #25 compares quotes against) and search results (`search`: title, link and snippet only — leads, not
 * evidence, so no body). Scoped to the conversation and its owner; gone with the conversation. `runId` names the
 * run that produced it (no foreign key: run rows are trimmed independently and the id is only a pointer).
 */
export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    kind: text("kind", { enum: ["page", "search"] }).notNull(),
    /** What produced it: `web_fetch`, a search provider (`google-news`, `duckduckgo`) or a skill name. */
    provider: text("provider").notNull(),
    /** URL asked for (pages) or the result link (search). */
    url: text("url").notNull(),
    /** Where the page really came from after redirects (pages only). */
    finalUrl: text("final_url"),
    title: text("title").notNull(),
    site: text("site").notNull(),
    /** Publication time as ISO 8601 when the page or the result says so. */
    publishedAt: text("published_at"),
    fetchedAt: integer("fetched_at").notNull(),
    contentType: text("content_type"),
    /** SHA-256 (hex) of `body`. */
    bodyHash: text("body_hash"),
    /** Readable text of the page (bounded); null for search results. */
    body: text("body"),
    /** True when the page had more text than was kept. */
    truncated: integer("truncated", { mode: "boolean" }).notNull().default(false),
    /** Search results: the snippet the provider showed. */
    snippet: text("snippet"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [
    index("sources_conversation_idx").on(t.conversationId, t.createdAt),
    index("sources_conversation_url_idx").on(t.conversationId, t.url),
  ],
);

/**
 * Artifacts (#27, PRD FR-6): one row per artifact, owned by the user of the run that made it and scoped to that
 * run's conversation (gone with the conversation or the user). `messageId` is the assistant message of that run
 * (cleared if the message row goes); `runId` is a pointer only, like `sources.run_id`. `latestVersion` is the
 * newest row of `artifact_versions`.
 */
export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    runId: text("run_id"),
    kind: text("kind", {
      enum: ["html", "svg", "markdown", "code", "chart", "table", "document"],
    }).notNull(),
    title: text("title").notNull(),
    /** `code` kind: the latest version's language (each version keeps its own). */
    language: text("language"),
    latestVersion: integer("latest_version").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("artifacts_conversation_idx").on(t.conversationId, t.createdAt)],
);

/**
 * Versions of an artifact — immutable: rows are only ever inserted (a revert inserts a copy). `content` is the
 * text served (html, svg, markdown, code) or the canonical JSON (chart, table, document); `contentHash` is its
 * SHA-256.
 */
export const artifactVersions = sqliteTable(
  "artifact_versions",
  {
    artifactId: text("artifact_id")
      .notNull()
      .references(() => artifacts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    title: text("title").notNull(),
    /** `code` kind: this version's language (download name, revert). */
    language: text("language"),
    content: text("content").notNull(),
    contentHash: text("content_hash").notNull(),
    bytes: integer("bytes").notNull(),
    runId: text("run_id"),
    revertedFrom: integer("reverted_from"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.artifactId, t.version] })],
);
