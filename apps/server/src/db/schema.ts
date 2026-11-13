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
  /**
   * Superseded by `initial_defaults.runtime` (0015 copied it there); no longer read or written. Kept so the table is
   * not rebuilt (every user-owned table refers to it).
   */
  defaultRuntime: text("default_runtime"),
  /**
   * The admin's initial defaults for this user (#35, FR-12.4): `RuntimeDefaults` in @agentlee/shared. Used while
   * the user has saved none of their own. Null = the service default (Claude Code · Opus 5.5).
   */
  initialDefaults: text("initial_defaults", { mode: "json" }).$type<unknown>(),
  /** The user's own defaults (FR-12.1·12.3), saved from settings; null = none saved yet. */
  defaults: text("defaults", { mode: "json" }).$type<unknown>(),
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
    /**
     * What the next message is answered with (#19, `ChatSettings`): set at creation from the user's defaults (FR-12.6
     * fallback applied) and changed only by the chip, so a change of the defaults never reaches an existing
     * conversation (FR-12.5). Null runtime: none was usable yet — the first message resolves it again.
     */
    runtime: text("runtime"),
    model: text("model"),
    effort: text("effort"),
    useShared: integer("use_shared", { mode: "boolean" }).notNull().default(false),
    /** `{ runtime, model }` JSON while the "기본값을 쓸 수 없어 ○○로 시작했어요" notice has not been shown yet. */
    fallbackNotice: text("fallback_notice", { mode: "json" }).$type<{
      runtime: string;
      model: string;
      limitedUntil?: number;
    }>(),
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
    /**
     * The model the session answers with now (#45): a model-only change resumes it with `setModel` when the runtime
     * can, otherwise it needs a fresh session. Null for sessions from before #45 (taken as the run's model).
     */
    model: text("model"),
    /**
     * The conversation summary the session was started with (#45, `conversation_summaries`), null for none. Resumed
     * only while that is still the conversation's current summary: a new one means the context reached its limit.
     */
    summaryId: text("summary_id"),
    /**
     * Its context was cut to fit (#45: a summary failed or the context overflowed): it never holds the full history,
     * so it is never resumed.
     */
    trimmed: integer("trimmed", { mode: "boolean" }).notNull().default(false),
    invalidated: integer("invalidated", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [index("runtime_sessions_conversation_idx").on(t.conversationId)],
);

/**
 * Summaries of the earlier part of a conversation (#45, PRD FR-3.6): written when the history a fresh session would
 * get reaches the model's context limit ratio, then reused for every fresh session while it still covers the same
 * messages. It covers the active user/assistant messages up to `throughSeq` (`coveredHash` is their ids, so an edit
 * or regenerate before that point makes it stale). The text is model output: known secrets are scrubbed on write.
 */
export const conversationSummaries = sqliteTable(
  "conversation_summaries",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** The last message it covers, and its seq. */
    throughMessageId: text("through_message_id").notNull(),
    throughSeq: integer("through_seq").notNull(),
    /** SHA-256 of the ids of the covered messages, in order. */
    coveredHash: text("covered_hash").notNull(),
    summary: text("summary").notNull(),
    /** Who wrote it, and in which run (its usage is recorded with purpose `summary`). */
    runtime: text("runtime").notNull(),
    model: text("model").notNull(),
    runId: text("run_id"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("conversation_summaries_conversation_idx").on(t.conversationId, t.throughSeq)],
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
    /**
     * The "앞부분을 요약했어요" divider written for this run's summary (#45): taken out of the history again when the
     * run ends without having stored its summary (failed, stopped before it ran, recovered after a restart).
     */
    summaryDividerId: text("summary_divider_id"),
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
 * Usage limits of a connection (#19, FR-9.2, FR-12.6), one row per scope (`ConnectionLimit` in @agentlee/shared:
 * `all`, `family:<name>`, `model:<id>`). New conversations do not start on a model a limit covers until `until`.
 * The connection's status stays `passed` (a limit is not an expiry). `recorded_at`: when the provider refused it —
 * only a reply that *started* after it (on a model in its scope), a passed test started after it, or a new
 * credential ends it early; an older run finishing late proves nothing.
 */
export const connectionLimits = sqliteTable(
  "connection_limits",
  {
    connectionId: text("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    scope: text("scope").notNull(),
    until: integer("until").notNull(),
    recordedAt: integer("recorded_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.connectionId, t.scope] })],
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
 *   without a connection; `unknown` when the row names a connection that cannot be found — e.g. rows from before
 *   0013 whose connection is gone). Only `api_key` rows are costed: `price_version` pins the price table version used
 *   when the row was first written, and `priced_cost_micros` is the cost from that version in integer micro-USD
 *   (1e-6 USD, so sums and threshold comparisons are exact) — a later price edit makes a new version and never
 *   rewrites these. NULL cost on an `api_key` row = no price ("미제공"); `unknown` rows count as 미제공 too.
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
    /** The connection's auth type at the first write (#32); NULL without a connection, `unknown` if not found. */
    authType: text("auth_type", { enum: ["api_key", "subscription", "unknown"] }),
    /** Price table version the row is costed with (#32); set once, at the first write. API key rows only. */
    priceVersion: integer("price_version"),
    /**
     * Cost from `price_version` (#32) in integer micro-USD. NULL = not costed (subscription, no connection) or no
     * price ("미제공").
     */
    pricedCostMicros: integer("priced_cost_micros"),
  },
  (t) => [
    uniqueIndex("usage_records_run_attempt_idx").on(t.runId, t.attempt),
    index("usage_records_user_created_idx").on(t.userId, t.createdAt),
    index("usage_records_created_idx").on(t.createdAt),
  ],
);

/**
 * One model's prices in a price table (#32): USD per million tokens as decimal strings (at most 6 decimals, never
 * floats — the cost is computed exactly from them). NULL = not provided ("미제공").
 */
export type ModelPriceRow = {
  runtime: string;
  model: string;
  input: string | null;
  output: string | null;
  cacheRead: string | null;
  cacheWrite: string | null;
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

/**
 * What the finance tools returned for one answer (#30): sources, numbers and identifiers (`AnswerEvidence`,
 * finance/checker.ts), written when the answer ends. The common finance output check reads a conversation's rows
 * in one indexed query to check follow-up answers anywhere later in the conversation — not by scanning messages.
 * Gone with the message (edit / regenerate keeps the row; the check joins on the message still being active).
 */
export const financeResults = sqliteTable(
  "finance_results",
  {
    messageId: text("message_id")
      .primaryKey()
      .references(() => messages.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    evidence: text("evidence", { mode: "json" }).$type<unknown>().notNull(),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [index("finance_results_conversation_idx").on(t.conversationId)],
);

/**
 * Citations registered with the `cite` tool (#25, PRD FR-5.2): numbered per run (`[n]` of that answer), checked
 * against the stored page text when they are made. Written by the server only — the citation note at the end of
 * the run is built from these rows, not from what a runtime reports. `sourceId` is null for an unknown source
 * (another conversation's or user's id is never kept). Gone with the conversation.
 */
export const citations = sqliteTable(
  "citations",
  {
    id: text("id").primaryKey(),
    /** The run's token scope (a connection test's run has no `runs` row, so no foreign key). */
    runId: text("run_id").notNull(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    n: integer("n").notNull(),
    sourceId: text("source_id"),
    status: text("status", {
      enum: ["verified", "snippet_not_found", "fetch_failed", "unknown_source"],
    }).notNull(),
    /** The snippet as the model sent it (bounded), normalised form for de-duplication. */
    snippet: text("snippet").notNull(),
    snippetKey: text("snippet_key").notNull(),
    /** Verified: the passage as it stands in the stored page text. */
    quote: text("quote"),
    /** A file citation (#48, `file_cite`): the cited upload (then `source_id` is null). */
    fileId: text("file_id"),
    /** A verified file citation: where the passage is (`FileLocator` JSON). */
    locator: text("locator"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("citations_run_n_idx").on(t.runId, t.n)],
);

/**
 * Uploaded files (#22, PRD FR-4.1·4.2·4.6): one row per file of a conversation, owned by its uploader. The bytes
 * are at `files/<user_id>/<conversation_id>/<id>` under DATA_DIR — server-generated ids only, never the user's
 * name (files/store.ts). `messageId` is the user message it was sent with (null while it is only in the composer;
 * cleared if that message row goes). `kind` and `mediaType` are what the server detected (extension and content
 * agree), never what the browser said. `name` is the user's file name, shown and used for downloads only.
 */
export const files = sqliteTable(
  "files",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
    /** The client's id for the upload (a UUID, unique per user): cancelling by it works before the file id is known. */
    uploadId: text("upload_id"),
    name: text("name").notNull(),
    kind: text("kind", {
      enum: ["pdf", "hwp", "hwpx", "docx", "xlsx", "pptx", "csv", "txt", "md", "png", "jpg"],
    }).notNull(),
    mediaType: text("media_type").notNull(),
    bytes: integer("bytes").notNull(),
    /** SHA-256 (hex) of the stored bytes. */
    sha256: text("sha256").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("files_conversation_idx").on(t.conversationId, t.createdAt),
    uniqueIndex("files_user_upload_idx").on(t.userId, t.uploadId),
  ],
);

/**
 * Cancelled uploads that have not arrived (review #102 7차): `DELETE /api/uploads/:uploadId` came before (or during)
 * the upload, so the upload is refused when it comes — also after a restart. A record goes when it is resolved (the
 * upload came and was refused) or after 6 hours; a user has at most 100 at a time (files/store.ts).
 */
export const uploadCancellations = sqliteTable(
  "upload_cancellations",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    uploadId: text("upload_id").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.uploadId] }),
    index("upload_cancellations_created_idx").on(t.createdAt),
  ],
);

/**
 * Schedules (#33, PRD FR-8.2): what to run (prompt, skills, runtime·model·effort checked like the chip's change)
 * and when (`type` with `date`/`time`/`weekdays`/`cron`, in `time_zone`). `next_run_at` is the engine's persistent
 * state: the next regular occurrence not yet turned into a run (null: a finished one-off). The UI is #55.
 */
export const schedules = sqliteTable(
  "schedules",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    type: text("type", { enum: ["once", "daily", "weekdays", "weekly", "cron"] }).notNull(),
    /** once: the local date "YYYY-MM-DD". */
    date: text("date"),
    /** once/daily/weekdays/weekly: the local time "HH:MM". */
    time: text("time"),
    /** weekly: JSON array of weekday numbers (0 = Sunday). */
    weekdays: text("weekdays", { mode: "json" }).$type<number[]>(),
    /** cron: the 5-field expression. */
    cron: text("cron"),
    timeZone: text("time_zone").notNull().default("Asia/Seoul"),
    /** Skill names the run may use (JSON array). */
    skills: text("skills", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    notify: integer("notify", { mode: "boolean" }).notNull().default(true),
    runtime: text("runtime").notNull(),
    model: text("model").notNull(),
    effort: text("effort"),
    useShared: integer("use_shared", { mode: "boolean" }).notNull().default(false),
    paused: integer("paused", { mode: "boolean" }).notNull().default(false),
    /** The schedule's own result conversation (#56). */
    conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    nextRunAt: integer("next_run_at"),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [
    index("schedules_owner_idx").on(t.ownerId, t.createdAt),
    index("schedules_next_run_idx").on(t.nextRunAt),
  ],
);

/**
 * One run of a schedule (#33, FR-8.6·8.7). `run_key` is unique: `<schedule id>@<scheduled ms>` for an occurrence
 * (regular or the one missed catch-up), `<schedule id>@manual:<ms>` for "바로 실행" — the same occurrence can never
 * become two runs, whoever inserts it. Status: pending → running → succeeded / failed, or skipped at once (overlap).
 * A failed first attempt goes back to pending with `retry_at` (2 minutes later); `attempts` counts starts, a crash
 * included. `outcome`, `result_saved_at` and `notified_at` mark the handler's steps, so a restart resumes after
 * the last finished one.
 */
export const scheduleRuns = sqliteTable(
  "schedule_runs",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => schedules.id, { onDelete: "cascade" }),
    runKey: text("run_key").notNull(),
    trigger: text("trigger", { enum: ["regular", "missed", "manual"] }).notNull(),
    scheduledAt: integer("scheduled_at").notNull(),
    status: text("status", { enum: ["pending", "running", "succeeded", "failed", "skipped"] }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    retryAt: integer("retry_at"),
    startedAt: integer("started_at"),
    finishedAt: integer("finished_at"),
    /** The execute step's result (set before the result is saved). */
    outcome: text("outcome", { enum: ["succeeded", "failed"] }),
    errorCode: text("error_code"),
    /** The handler's references: where its output is (execute) and where it saved the result (saveResult). */
    outputRef: text("output_ref"),
    resultRef: text("result_ref"),
    resultSavedAt: integer("result_saved_at"),
    notifiedAt: integer("notified_at"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [
    uniqueIndex("schedule_runs_key_idx").on(t.runKey),
    index("schedule_runs_schedule_idx").on(t.scheduleId, t.scheduledAt),
    index("schedule_runs_status_idx").on(t.status),
  ],
);

/**
 * A schedule proposed in a conversation (#55, FR-8.1): the `schedule_create` tool stores what it proposes here and
 * the reply shows it as a confirmation card. Nothing runs from this table: the schedule is created only when its
 * owner confirms the card (their own session, the same checks as `POST /api/schedules`), once — `schedule_id` then
 * names it. `timing` is the validated `ScheduleTiming` JSON.
 */
export const scheduleProposals = sqliteTable(
  "schedule_proposals",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    timing: text("timing", { mode: "json" }).notNull(),
    timeZone: text("time_zone").notNull(),
    skills: text("skills", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    notify: integer("notify", { mode: "boolean" }).notNull().default(true),
    status: text("status", { enum: ["proposed", "confirmed", "dismissed"] })
      .notNull()
      .default("proposed"),
    scheduleId: text("schedule_id").references(() => schedules.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull().default(now),
    updatedAt: integer("updated_at").notNull().default(now),
  },
  (t) => [index("schedule_proposals_conversation_idx").on(t.conversationId)],
);

/**
 * 관심 종목 (#31, FR-7.7): one person's list of Korean and US symbols, owner only (the admin cannot read it either,
 * FR-1.5). `name` is the display name picked from the search (third-party text, scrubbed on write).
 */
export const watchlistItems = sqliteTable(
  "watchlist_items",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    market: text("market", { enum: ["KR", "US"] }).notNull(),
    symbol: text("symbol").notNull(),
    name: text("name"),
    createdAt: integer("created_at").notNull().default(now),
  },
  (t) => [uniqueIndex("watchlist_items_user_symbol_idx").on(t.userId, t.market, t.symbol)],
);

/**
 * Text extraction of an upload (#48): one row per file, `pending` until the sandboxed extractor ran. Rows and
 * segments go with their file (cascade). Written by `FileExtracts` only.
 */
export const fileExtracts = sqliteTable("file_extracts", {
  fileId: text("file_id")
    .primaryKey()
    .references(() => files.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["pending", "ok", "failed"] }).notNull(),
  /** Why it failed (`EXTRACT_CODES`); null otherwise. */
  code: text("code"),
  ocr: text("ocr", { enum: ["none", "done", "partial", "unavailable"] })
    .notNull()
    .default("none"),
  /** Pages, slides, sheets … of the file; null when not known. */
  units: integer("units"),
  segments: integer("segments").notNull().default(0),
  characters: integer("characters").notNull().default(0),
  truncated: integer("truncated", { mode: "boolean" }).notNull().default(false),
  /** Some unit ends early (`file_segments.ends_early`): for display — the rule itself reads the units. */
  endedEarly: integer("ended_early", { mode: "boolean" }).notNull().default(false),
  /** The extractor version that wrote the row (a newer one extracts again). */
  extractor: text("extractor").notNull(),
  /** Attempts so far (a server that died mid-extraction retries it a bounded number of times). */
  attempts: integer("attempts").notNull().default(0),
  updatedAt: integer("updated_at").notNull(),
});

/** The extracted text of a file, one unit per row (page, slide, paragraph, table row, sheet row, run of lines). */
export const fileSegments = sqliteTable(
  "file_segments",
  {
    fileId: text("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    /** The unit's number in the file's natural order (`file_read` ranges over it). */
    unit: integer("unit").notNull(),
    /** `UnitLocator` JSON (kind and fields; the sheet name of an XLSX row). */
    locator: text("locator").notNull(),
    text: text("text").notNull(),
    /** Finer places inside `text`: `[start, end, fields]` JSON (line boxes, cells, OCR words); null when none. */
    marks: text("marks"),
    /**
     * A known secret across two marks was scrubbed out of `text` (files/scrub.ts): the marks are gone and only the
     * unit's own locator is true — nothing finer (box, range, line) may be claimed.
     */
    approximate: integer("approximate", { mode: "boolean" }).notNull().default(false),
    /** The stored copy was cut for display after scrubbing (`text` or the sheet name): it has a gap. */
    cut: integer("cut", { mode: "boolean" }).notNull().default(false),
    /** Text the extractor did not take follows right after this unit: the cut-off-secret rule applies here only. */
    endsEarly: integer("ends_early", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [primaryKey({ columns: [t.fileId, t.seq] }), index("file_segments_unit_idx").on(t.fileId, t.unit)],
);
