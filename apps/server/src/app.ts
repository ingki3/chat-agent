import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import fastifyStatic from "@fastify/static";
import type { JWTVerifyGetKey } from "jose";
import type { HealthResponse } from "@agentlee/shared";
import { createAccessVerifier } from "./auth/access-jwt.js";
import { registerCsrf, registerSession, registerTrustBoundary } from "./auth/plugin.js";
import { registerAuthRoutes, type AuthRouteOptions } from "./auth/routes.js";
import { UserStore } from "./auth/users.js";
import { installRouteRules, registerResourceCheck } from "./authz/resources.js";
import { registerAccountSettings, registerUserAdmin, type UserAdminOptions } from "./users/routes.js";
import { DefaultsService } from "./users/defaults.js";
import { registerAdminSystemRoutes, type SystemRouteOptions } from "./admin/routes.js";
import { BackupService, type BackupServiceOptions } from "./backup/backup.js";
import { FileWriteLock } from "./backup/lock.js";
import { registerBackupRoutes } from "./backup/routes.js";
import { ScheduleEngine, type ScheduleEngineOptions, type ScheduleHandler } from "./schedules/engine.js";
import { FakeScheduleHandler } from "./schedules/fake.js";
import { registerScheduleRoutes } from "./schedules/routes.js";
import { ScheduleStore } from "./schedules/store.js";
import { SkillSwitches } from "./mcp/switches.js";
import { registerConversationRoutes } from "./conversations/routes.js";
import { ConversationStore } from "./conversations/store.js";
import { RuntimeRegistry } from "./runtime/adapter.js";
import { FakeRuntime } from "./runtime/fake.js";
import { claudeFromStore } from "./runtime/claude-config.js";
import { codexFromStore } from "./runtime/codex-config.js";
import { importEnvConnections, pendingImportTests } from "./connections/import.js";
import { ChatgptTokenService, type TokenPost } from "./connections/chatgpt.js";
import { SubscriptionLoginService, type DeviceLoginProvider } from "./connections/login.js";
import { cleanupLeftoverLogins, CodexDeviceLogin, type ProcessIdentity } from "./runtime/codex-login.js";
import { registerConnectionRoutes } from "./connections/routes.js";
import { ConnectionService } from "./connections/service.js";
import { ConnectionStore } from "./connections/store.js";
import { ConnectionTester } from "./connections/tester.js";
import { UsageStore } from "./usage/store.js";
import { registerUsageRoutes } from "./usage/routes.js";
import { UsageService, type UsageServiceOptions } from "./usage/service.js";
import { DEFAULT_TIME_ZONE } from "./notifications/quiet.js";
import {
  CLAUDE_EGRESS_HOSTS,
  CODEX_CHATGPT_EGRESS_HOSTS,
  CODEX_EGRESS_HOSTS,
  CODEX_LOGIN_EGRESS_HOSTS,
  EgressService,
} from "./isolation/egress.js";
import { registerRunRoutes } from "./runtime/routes.js";
import { RunManager, type RunManagerOptions } from "./runtime/runs.js";
import { McpTokens } from "./isolation/tokens.js";
import { McpService, type McpServiceOptions } from "./mcp/service.js";
import { mcpOptionsFromConfig, registerSkillRoutes } from "./mcp/routes.js";
import { SourceStore } from "./web/sources.js";
import { CitationStore } from "./citations/store.js";
import { fixtureWebWorker } from "./runtime/fake-citations.js";
import { sandboxedWorker } from "./web/service.js";
import { ArtifactStore } from "./artifacts/store.js";
import { registerArtifactRoutes, type AppPage } from "./artifacts/routes.js";
import { findBrowser } from "./artifacts/browser.js";
import { Renderer } from "./artifacts/export.js";
import { registerSourceRoutes } from "./web/routes.js";
import { FileStore, type FileStoreOptions } from "./files/store.js";
import { registerFileRoutes } from "./files/routes.js";
import { storagePaths } from "./storage/paths.js";
import { isInside } from "./fs-safety.js";
import type { Db } from "./db/client.js";
import { SettingsStore } from "./db/settings-store.js";
import { KEY_LEN } from "./crypto/secrets.js";
import { registerNotificationRoutes } from "./notifications/routes.js";
import { NotificationService, type NotificationServiceOptions } from "./notifications/service.js";
import { loadOrCreateVapidKeys } from "./notifications/vapid.js";
import { AppEvents } from "./events.js";
import { isApiPath, isArtifactPath } from "./paths.js";
import type { Config } from "./config.js";
import { registerDiag, type DiagOptions } from "./diag.js";
import { isGatePath, registerGate, type GateOptions } from "./gate.js";
import { BASE_HEADERS } from "./headers.js";
import { logEvent, loggerOptions, rotatingFile } from "./logging.js";
import { ErrorLog } from "./observability/errors.js";
import { registerRoutePattern } from "./observability/policy.js";
import { registerErrorHandling, registerErrorRoutes } from "./observability/routes.js";
import { registerResponseScrub } from "./secrets/http.js";
import { StoredRescrub } from "./secrets/rescrub.js";
import { primeStoredSecrets, registerConfigSecrets } from "./secrets/sources.js";

const VERSION = "0.0.0";
const here = path.dirname(fileURLToPath(import.meta.url));
/** Built SPA (apps/web/dist), resolved from apps/server/{src,dist}. */
export const DEFAULT_WEB_DIST = path.resolve(here, "../../web/dist");
const WEB_ROOT = path.resolve(here, "../../web");

/** Content-Security-Policy for app pages in production. Dev mode skips it because Vite HMR needs inline scripts. */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

export { isApiPath };

declare module "fastify" {
  interface FastifyInstance {
    /** Accounts and sessions; undefined when the app is built without a database (some tests). */
    users: UserStore | undefined;
    appEvents: AppEvents;
    conversations: ConversationStore | undefined;
    runs: RunManager | undefined;
    mcp: McpService | undefined;
    /** Recent errors (admin, #46); undefined without a database. */
    errors: ErrorLog | undefined;
    /** Inbox, quiet hours and web push (#34); undefined without a database. Publishing points call `publish`. */
    notifications: NotificationService | undefined;
    /** Runtime connections (#17); undefined without a database. */
    connections: ConnectionService | undefined;
    /** Artifacts (#27); undefined without a database. */
    artifacts: ArtifactStore | undefined;
    /** Usage records (#44) and their price tables (#32); undefined without a database. */
    usageStore: UsageStore | undefined;
    /** Usage screens and the daily cost check (#32); undefined without a database. */
    usage: UsageService | undefined;
    /**
     * The data folder's file-write lock (#37): every writer of files under `files/`, `artifacts/` or `sources/`
     * writes inside `fileWrites.write()`, so a backup's snapshot of rows and files is from one moment.
     */
    fileWrites: FileWriteLock;
    /** Uploaded files (#22); undefined without a database. */
    files: FileStore | undefined;
    /** Daily backups (#37); undefined without BACKUP_DIR or with an in-memory database. */
    backups: BackupService | undefined;
    /** Background rescrub of stored rows when a secret is registered (round 25); undefined without a database. */
    storedRescrub: StoredRescrub | undefined;
    /**
     * Schedules (#33): the store, and the engine when there is a handler (none until #56; the fake one with
     * FAKE_RUNTIME=1). undefined without a database.
     */
    schedules: { store: ScheduleStore; engine: ScheduleEngine | undefined } | undefined;
  }
}

export type BuildOptions = {
  /** Directory of the built SPA. Defaults to apps/web/dist. */
  webDist?: string;
  /** Attach Vite in middleware mode (one port for UI + API in development). */
  vite?: boolean;
  logger?: boolean;
  /** Log destination (tests capture it). Implies logging on; otherwise LOG_FILE, else stdout. */
  logStream?: NodeJS.WritableStream;
  /** Timing overrides for the diagnostic stream (tests). The route exists only when config.diagStream is set. */
  diag?: DiagOptions;
  /** Rate-limit/clock overrides for the temporary gate (tests). Active only when config.tempGateCode is set. */
  gate?: Omit<GateOptions, "code">;
  /** Database for accounts and sessions. Without it nobody can sign in and private routes answer 401. */
  db?: Db;
  /** Access JWT key source override (tests sign with a local JWKS). */
  accessKeys?: JWTVerifyGetKey;
  /** Login rate-limit/clock overrides (tests). */
  auth?: AuthRouteOptions;
  events?: AppEvents;
  /**
   * PNG/PDF export (#51). Default: the sandboxed browser found by `findBrowser` (none in the test environment —
   * tests bring their own renderer).
   */
  renderer?: Pick<Renderer, "render">;
  /** Runtime adapters (tests pass FakeRuntime instances). Default: real adapters (#15/#16), FakeRuntime if FAKE_RUNTIME=1. */
  runtimes?: RuntimeRegistry;
  runs?: RunManagerOptions;
  /** MCP server overrides (tests: skill runner, clock). */
  mcp?: McpServiceOptions;
  /**
   * Web tool overrides (tests: an in-process worker, stub proxies and providers), merged into the web options
   * that hold the app's own source and citation stores.
   */
  web?: Partial<Omit<NonNullable<McpServiceOptions["web"]>, "sources" | "citations">>;
  /** SSE timing overrides (tests). */
  sse?: { heartbeatMs?: number };
  /** User-admin overrides (tests). */
  userAdmin?: UserAdminOptions;
  /**
   * Master key for stored secrets (VAPID private key, push subscriptions). index.ts passes the real one; without
   * it (tests) an ephemeral key is used, which production refuses.
   */
  masterKey?: Buffer;
  /** Push transport / clock overrides (tests). */
  notifications?: NotificationServiceOptions;
  /** Connection test overrides (tests: a short timeout). */
  connectionTest?: { timeoutMs?: number };
  /**
   * Codex ChatGPT login (#18). `device`: how a device-code login is started (default: the pinned app-server in its
   * sandbox; tests script it); `tokenPost`: the token endpoint for refreshes (tests: a fake).
   */
  subscription?: {
    device?: DeviceLoginProvider;
    tokenPost?: TokenPost;
    /** Tests: how a left-over login process is identified (default: `ps`). */
    identify?: (pid: number) => ProcessIdentity | undefined;
    maxActiveLogins?: number;
  };
  /** Usage screens (#32): time zone and clock overrides (tests). */
  usage?: UsageServiceOptions;
  /** Dev-mode HMR WebSocket port (loopback only, separate from the app port). */
  hmrPort?: number;
  /** System status overrides (tests: the tunnel probe). */
  system?: Pick<SystemRouteOptions, "tunnel">;
  /**
   * Backups (#37): clock and test hooks. The daily schedule runs outside tests; `schedule: true` turns it on in a
   * test.
   */
  backup?: BackupServiceOptions & { schedule?: boolean };
  /** Uploads (#22): clock and test hooks. */
  files?: FileStoreOptions;
  /**
   * Schedules (#33): the run handler (default: none — the real one is #56 — or the fake one with FAKE_RUNTIME=1),
   * engine timing overrides, and `start: true` to run the engine in a test (it runs by itself only in a server that
   * holds the data folder lock, `dataLock`).
   */
  schedules?: {
    handler?: ScheduleHandler;
    start?: boolean;
    engine?: ScheduleEngineOptions;
    now?: () => number;
  };
  /**
   * The data folder lock this process holds (index.ts, `openStorageForWrite`, #37). The schedule engine starts only
   * with it and stops as soon as it is no longer held — it never runs on storage that is not this process's.
   */
  dataLock?: { held: () => boolean };
};

/**
 * The database is DATA_DIR's own `agentlee.db`: the opened file itself, links resolved (review #102 — an
 * `agentlee.db` that is a link to another database is not this folder's), is the real `<DATA_DIR>/agentlee.db`.
 * "memory" for an in-memory database, "other" for any other file.
 */
function databaseOf(db: Db, dataDir: string): "own" | "memory" | "other" {
  if (db.$client.memory) return "memory";
  try {
    const opened = fs.realpathSync.native(db.$client.name);
    // The folder resolved, the file name not: a link named agentlee.db resolves to somewhere else than this.
    const own = path.join(fs.realpathSync.native(dataDir), path.basename(storagePaths(dataDir).db));
    return opened === own && isInside(opened, dataDir) ? "own" : "other";
  } catch {
    return "other";
  }
}

/** Tests without a master key: one throwaway key per database, so rebuilding the app on it still decrypts. */
const ephemeralKeys = new WeakMap<Db, Buffer>();
function ephemeralKey(db: Db): Buffer {
  let key = ephemeralKeys.get(db);
  if (!key) ephemeralKeys.set(db, (key = crypto.randomBytes(KEY_LEN)));
  return key;
}

export async function buildApp(config: Config, opts: BuildOptions = {}): Promise<FastifyInstance> {
  // Review round 23: every secret this server holds is known before anything can produce output.
  registerConfigSecrets(config);
  const logOn = opts.logStream !== undefined || (opts.logger ?? config.env !== "test");
  const logDest = opts.logStream ?? (config.logFile ? rotatingFile(config.logFile) : undefined);
  const app = Fastify({
    logger: logOn ? loggerOptions(logDest) : false,
    // Errors Fastify raises before routing (bad percent-encoding, …) skip the error handler and every hook, and
    // their default body repeats the raw URL. Answer them with a fixed body and the usual security headers.
    frameworkErrors: (err, req, res) => {
      const reply = res as unknown as FastifyReply;
      logEvent(req.log, "info", "request.error", { err, errorCode: "bad_request", category: "client" });
      reply.headers(BASE_HEADERS).header("Cache-Control", "no-store");
      if (config.env === "production") reply.header("Content-Security-Policy", APP_CSP);
      return reply.code(400).send({ error: "invalid_request" });
    },
  });
  const startedAt = Date.now();
  /** The SPA's index.html for app routes the server answers itself (`/a/:id`); set once the UI is attached. */
  let appPage: AppPage = async () => undefined;

  // First, before any route exists: every route that could address a resource must declare its permission.
  installRouteRules(app);
  // Route patterns are what logs and the error list may name (observability/policy.ts).
  app.addHook("onRoute", (route) => registerRoutePattern(route.url));
  // Every JSON and text response is scrubbed of known secrets, whichever route made it (round 25).
  registerResponseScrub(app);

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.headers(BASE_HEADERS);
    // A route that sets its own CSP keeps it (artifact originals, #27: a stricter, sandboxing one).
    if (config.env === "production" && !reply.hasHeader("Content-Security-Policy"))
      reply.header("Content-Security-Policy", APP_CSP);
    return payload;
  });

  const events = opts.events ?? new AppEvents();
  app.decorate("fileWrites", new FileWriteLock());
  const users = opts.db ? new UserStore(opts.db, events) : undefined;
  app.decorate("appEvents", events);
  app.decorate("users", users);
  app.decorate("conversations", opts.db ? new ConversationStore(opts.db) : undefined);
  const errors = opts.db ? new ErrorLog(opts.db) : undefined;
  app.decorate("errors", errors);
  if (errors) {
    // Retention must not depend on new errors arriving.
    const prune = setInterval(() => errors.prune(), 3600_000);
    prune.unref();
    app.addHook("onClose", async () => clearInterval(prune));
  }
  // Before any route or plugin, so every one inherits it: sanitised error bodies, logs and recent-error entries.
  registerErrorHandling(app, errors);
  const verifier = config.access
    ? createAccessVerifier({ ...config.access, ...(opts.accessKeys ? { keys: opts.accessKeys } : {}) })
    : undefined;

  // Hook order matters — all of these run before every route, static file and Vite middleware:
  // trust boundary (Host / Access JWT) → temporary code gate (edge only) → CSRF → session → route rules.
  registerTrustBoundary(app, { config, verifier });
  if (config.tempGateCode) registerGate(app, { ...opts.gate, code: config.tempGateCode });
  registerCsrf(app, config);
  registerSession(app, users);
  // After the login check: resource load + policy (404 / 403).
  registerResourceCheck(app);
  if (users) {
    registerAuthRoutes(app, { config, users, ...opts.auth });
    registerUserAdmin(app, users, opts.userAdmin);
    if (!opts.masterKey && config.env === "production") throw new Error("buildApp: master key required");
    const masterKey = opts.masterKey ?? ephemeralKey(opts.db!);
    // Stored rows are scrubbed again whenever a secret that may already be stored is registered (round 25) —
    // and once now, for everything registered at startup.
    const storedRescrub = new StoredRescrub(opts.db!, { log: app.log });
    app.decorate("storedRescrub", storedRescrub);
    app.addHook("onClose", async () => {
      storedRescrub.close();
      await storedRescrub.idle();
    });
    primeStoredSecrets(opts.db!, masterKey);
    storedRescrub.schedule({ all: true });
    const settingsStore = new SettingsStore(opts.db!, masterKey);
    // Runtime connections (#17): credentials encrypted with the master key, resolved per run by the adapters.
    const connectionStore = new ConnectionStore(opts.db!, masterKey, config.dataDir);
    // ChatGPT logins (#18): tokens refreshed by the server, never by a runtime process.
    const chatgptTokens = new ChatgptTokenService(connectionStore, {
      log: app.log,
      ...(opts.subscription?.tokenPost ? { post: opts.subscription.tokenPost } : {}),
    });
    const egressFor = (allow: readonly string[]) => {
      const egress = new EgressService({ allow });
      app.addHook("onClose", async () => egress.close());
      return egress;
    };
    const runtimes = opts.runtimes ?? new RuntimeRegistry();
    // FAKE_RUNTIME=1 (e2e, manual testing): the scripted runtime as "Claude Code", with the service default model
    // (Opus 5.5, D3) next to the fake ones so a user with nothing set starts where a real one would (#19).
    if (!opts.runtimes && config.fakeRuntime)
      runtimes.register(
        new FakeRuntime({
          runTools: true,
          models: [
            {
              id: "fake-large",
              label: "Fake Large",
              efforts: ["low", "medium", "high"],
              defaultEffort: "medium",
            },
            { id: "fake-small", label: "Fake Small", efforts: [] },
            {
              id: "claude-opus-5-5",
              label: "Opus 5.5",
              efforts: ["low", "medium", "high"],
              defaultEffort: "high",
            },
          ],
        }),
      );
    else if (!opts.runtimes) {
      // Runtime CLIs reach the internet only through an egress proxy (allow-listed API hosts, no private
      // addresses) — one per runtime and way of signing in, so each reaches only its own provider's hosts.
      // Both real runtimes are always there; whether a user can run one depends on their connections (#17).
      // Tests bring their own runtimes (opts.runtimes) and never start a real CLI.
      if (config.env !== "test") {
        runtimes.register(claudeFromStore(connectionStore, users, egressFor(CLAUDE_EGRESS_HOSTS)));
        runtimes.register(
          codexFromStore(connectionStore, users, egressFor(CODEX_EGRESS_HOSTS), {
            tokens: chatgptTokens,
            egress: egressFor(CODEX_CHATGPT_EGRESS_HOSTS),
          }),
        );
      }
    }
    // Our MCP server (#43): its own loopback port, started on the first run of a runtime that uses tools.
    const mcpTokens = new McpTokens();
    // Usage records (#44): replies and connection tests write here, keyed on run and attempt. Each write is costed
    // from the current price table (#32) and then checked against the daily cost threshold (notify only).
    // The daily cost notification goes to every active admin (the inbox re-checks the role before sending).
    const usageService = new UsageService(
      opts.db!,
      settingsStore,
      (amountUsd, thresholdUsd) => {
        for (const admin of connectionStore.admins())
          notifications.publish(admin, { kind: "daily_cost", amountUsd, thresholdUsd, url: "/admin" });
      },
      app.log,
      { timeZone: DEFAULT_TIME_ZONE, ...opts.usage },
    );
    const usage = new UsageStore(opts.db!, opts.usage?.now ?? Date.now, {
      onRecorded: (at) => usageService.checkDailyCost(at),
    });
    app.decorate("usageStore", usage);
    // Web search and fetch (#50): results are stored as sources of the run's conversation.
    const sources = new SourceStore(opts.db!);
    // Artifacts (#27): made by the artifact tools, scoped to the run's conversation.
    const artifacts = new ArtifactStore(opts.db!);
    app.decorate("artifacts", artifacts);
    const mcp = new McpService(mcpTokens, users, {
      log: app.log,
      web: {
        sources,
        // Citations (#25): `cite` checks against the stored page text; the run's note reads them back.
        citations: new CitationStore(opts.db!),
        providers: config.webSearchProviders,
        // The FakeRuntime mode (e2e, local tries) answers the citation fixture pages in-process (no network).
        ...(config.fakeRuntime ? { worker: fixtureWebWorker(sandboxedWorker()) } : {}),
        ...opts.web,
      },
      artifacts,
      // Finance tools (#30): the OpenDART key and the SEC contact come from `.env` (SKILL_SECRET_NAMES).
      finance: { secrets: config.skillSecrets },
      // The server skill allow-list (#35) and the failed-skill list (FR-10.4).
      switches: new SkillSwitches(settingsStore),
      ...(errors ? { errors } : {}),
      ...mcpOptionsFromConfig(config),
      ...opts.mcp,
    });
    const connections = new ConnectionService(
      connectionStore,
      users,
      new ConnectionTester(runtimes, mcp, mcpTokens, { usage, log: app.log, ...opts.connectionTest }),
      runtimes,
      app.log,
    );
    app.decorate("connections", connections);
    // Defaults and the per-conversation settings (#35, #19): one service for the settings screen, new
    // conversations (FR-12.6 fallback) and the chip — all through the run check itself.
    const defaults = new DefaultsService(connections.access, runtimes);
    const startSettings = (userId: string) => {
      const u = users.byId(userId);
      return u ? defaults.start(u) : null;
    };
    const runManager = new RunManager(opts.db!, app.conversations!, runtimes, events, {
      startSettings,
      mcp,
      usage,
      mcpTokens,
      connections: {
        resolve: (input) => connections.access.resolve(input),
        runFailed: (run, code, info) => connections.runFailed(run, code, info),
        runSucceeded: (run) => connections.runSucceeded(run),
      },
      log: app.log,
      ...(errors ? { errors } : {}),
      context: config.context,
      // Uploaded files of the conversation for a fresh session's context (#45): those sent with a message (an upload
      // not sent yet is not part of the conversation). Opening them is #53.
      contextFiles: (conversationId) =>
        (app.files?.list(conversationId) ?? [])
          .filter((f) => f.messageId !== null)
          .map((f) => ({ id: f.id, name: f.name })),
      ...opts.runs,
    });
    // Runs left running by a previous process cannot be continued: mark them failed before serving.
    runManager.recover();
    const purge = setInterval(() => runManager.purgeEvents(), 10 * 60_000);
    purge.unref();
    app.addHook("onClose", async () => clearInterval(purge));
    // preClose: before Fastify waits for open connections, end the event streams that would otherwise hold it.
    app.addHook("preClose", async () => runManager.shutdown());
    app.addHook("onClose", async () => mcp.close());
    app.decorate("mcp", mcp);
    app.decorate("runs", runManager);
    // Uploads (#22): `files/<user>/<conversation>/<id>`, every change inside the file-write lock (#37).
    const fileStore = new FileStore(opts.db!, config.dataDir, app.fileWrites, app.conversations!, opts.files);
    app.decorate("files", fileStore);
    // Left-overs of the last run (cut-off uploads, files whose row never came) — only on the data folder's own
    // database: an app on another database (tests on the default folder) must not judge this folder's files.
    const which = databaseOf(opts.db!, config.dataDir);
    if (which === "own")
      app.addHook("onReady", async () => {
        const count = await app.fileWrites.write(() => fileStore.sweep());
        if (count) logEvent(app.log, "info", "file.swept", { count });
      });
    else if (which === "other")
      app.addHook("onReady", async () => logEvent(app.log, "warn", "file.sweep_skipped"));
    registerConversationRoutes(app, app.conversations!, runManager, { defaults, users }, fileStore);
    registerFileRoutes(app, app.conversations!, fileStore);
    // Cancel records of uploads that never came expire after 6 hours (review #102 7차): at start and every 10 min.
    app.addHook("onReady", async () => void fileStore.expireCancels());
    const expireCancels = setInterval(() => fileStore.expireCancels(), 10 * 60_000);
    expireCancels.unref();
    app.addHook("onClose", async () => clearInterval(expireCancels));
    registerRunRoutes(app, runManager, app.conversations!, opts.sse ?? {});
    registerErrorRoutes(app, errors!);
    registerSkillRoutes(app, mcp);
    // Codex ChatGPT device-code logins (#18): the pinned app-server, sandboxed, behind its own egress proxy.
    // Tests script it (opts.subscription.device) and never start a real process; neither does the development
    // FakeRuntime mode (no real Codex there to use the login with).
    const device =
      opts.subscription?.device ??
      (config.env === "test" || config.fakeRuntime
        ? undefined
        : new CodexDeviceLogin({ egress: egressFor(CODEX_LOGIN_EGRESS_HOSTS) }));
    // A server that died during a login left its folder (maybe with the tokens file) and maybe its process: both
    // go before anything else runs (#18 review).
    cleanupLeftoverLogins(config.dataDir, {
      ...(opts.subscription?.identify ? { identify: opts.subscription.identify } : {}),
      report: (outcome) =>
        logEvent(
          app.log,
          outcome === "leftover_process_kept" ? "warn" : "info",
          "connection.login_leftover",
          {
            loginCode: outcome,
          },
        ),
    });
    const logins = new SubscriptionLoginService(connectionStore, users, device, config.dataDir, {
      replaced: (id) => connections.replaced(id),
      log: app.log,
      ...(opts.subscription?.maxActiveLogins ? { maxActive: opts.subscription.maxActiveLogins } : {}),
    });
    app.addHook("onClose", async () => logins.close());
    registerConnectionRoutes(app, connections, users, runtimes, logins);
    // Admin screen (#35): accounts, defaults, skills, runtimes and system status.
    registerAccountSettings(app, users, {
      defaults,
      mcp,
    });
    registerAdminSystemRoutes(
      app,
      { registry: runtimes, connections: connectionStore, errors: errors! },
      {
        version: VERSION,
        startedAt,
        dataDir: config.dataDir,
        databaseFile: opts.db!.$client.memory ? null : opts.db!.$client.name,
        tunnelMetrics: config.tunnelMetrics,
        ...opts.system,
      },
    );
    // Backups (#37): a file database and a backup folder (config.ts keeps it outside DATA_DIR and the repository).
    const backups =
      config.backupDir && !opts.db!.$client.memory
        ? new BackupService(
            {
              sqlite: opts.db!.$client,
              dataDir: config.dataDir,
              backupDir: config.backupDir,
              masterKey,
              lock: app.fileWrites,
              log: app.log,
              // Every failure, and an empty backup folder, reach the admins (#34 inbox and push).
              notifyAdmins: (message) => {
                for (const admin of connectionStore.admins())
                  notifications.publish(admin, { kind: "system_warning", message, url: "/admin?tab=backup" });
              },
            },
            opts.backup,
          )
        : undefined;
    app.decorate("backups", backups);
    registerBackupRoutes(app, backups, config.dataDir);
    if (backups && (config.env !== "test" || opts.backup?.schedule))
      app.addHook("onReady", async () => backups.start());
    // Before the database closes (index.ts closes it in onClose): a backup in progress finishes first.
    if (backups) app.addHook("preClose", async () => backups.stop());
    // Schedules (#33): persistent occurrences and runs; the engine needs a handler and the data folder to be ours.
    const scheduleStore = new ScheduleStore(opts.db!);
    const scheduleHandler =
      opts.schedules?.handler ?? (config.fakeRuntime ? new FakeScheduleHandler() : undefined);
    const dataLock = opts.dataLock;
    const scheduleEngine = scheduleHandler
      ? new ScheduleEngine(scheduleStore, scheduleHandler, {
          log: app.log,
          ...(dataLock ? { owned: () => dataLock.held() } : {}),
          ...(opts.schedules?.now ? { now: opts.schedules.now } : {}),
          ...opts.schedules?.engine,
        })
      : undefined;
    app.decorate("schedules", { store: scheduleStore, engine: scheduleEngine });
    registerScheduleRoutes(app, {
      store: scheduleStore,
      engine: scheduleEngine,
      defaults,
      users,
      mcp,
      now: opts.schedules?.now ?? opts.schedules?.engine?.now ?? Date.now,
    });
    if (scheduleEngine && (opts.schedules?.start || (config.env !== "test" && dataLock)))
      app.addHook("onReady", async () => scheduleEngine.start());
    // Before the database closes: runs in progress are aborted and waited for (the rest recover at the next start).
    if (scheduleEngine) app.addHook("preClose", async () => scheduleEngine.stop());
    registerSourceRoutes(app, app.conversations!, sources);
    // PNG/PDF export (#51): one fresh sandboxed browser per render, behind its own CDN-only egress proxy.
    let renderer = opts.renderer;
    if (!renderer) {
      const own = new Renderer({
        browser: config.env === "test" ? undefined : findBrowser(config.exportBrowser),
      });
      app.addHook("onClose", async () => own.close());
      renderer = own;
    }
    registerArtifactRoutes(app, app.conversations!, artifacts, (url) => appPage(url), renderer);

    const vapid = loadOrCreateVapidKeys(settingsStore);
    const notifications = new NotificationService(
      opts.db!,
      masterKey,
      users,
      app.resources,
      vapid,
      `https://${config.publicHost}`,
      app.log,
      opts.notifications,
    );
    app.decorate("notifications", notifications);
    registerNotificationRoutes(app, notifications);
    app.decorate("usage", usageService);
    registerUsageRoutes(app, usageService, usage.prices);
    connections.attach({
      runs: runManager,
      notify: (userId, input) => void notifications.publish(userId, input),
    });
    // `.env` credentials from before #17, imported once and tested so they keep working (docs/ops.md §11).
    // A value that cannot be imported is logged and shown to the admin; the server still starts (fix, restart).
    connections.importFailures = importEnvConnections(
      config,
      connectionStore,
      users,
      settingsStore,
      app.log,
    ).failed;
    // Every start: imported connections still waiting for their first test are tested (also after a crash).
    const pending = pendingImportTests(connectionStore, settingsStore);
    if (pending.length)
      app.addHook("onReady", async () => {
        const tester = connectionStore.admins()[0];
        if (!tester) return; // no admin yet: tested on a later start, or by the admin in the app
        void (async () => {
          for (const c of pending) await connections.test(c, c.ownerId ?? tester).catch(() => undefined);
        })();
      });
    // Pushes held for quiet hours (or cut off by the last shutdown) are sent once their time has come.
    app.addHook("onReady", async () => notifications.start());
    app.addHook("onClose", async () => notifications.stop());
  } else {
    app.decorate("notifications", undefined);
    app.decorate("connections", undefined);
    app.decorate("artifacts", undefined);
    app.decorate("usageStore", undefined);
    app.decorate("usage", undefined);
    app.decorate("backups", undefined);
    app.decorate("storedRescrub", undefined);
    app.decorate("files", undefined);
    app.decorate("schedules", undefined);
  }

  app.get(
    "/api/health",
    { config: { auth: "public", noResource: "service status" } },
    async (): Promise<HealthResponse> => ({
      status: "ok",
      service: "agent-lee",
      version: VERSION,
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    }),
  );

  if (config.diagStream) registerDiag(app, opts.diag);

  // Unknown API routes are JSON 404s, never the SPA page.
  const apiNotFound = async (
    _req: unknown,
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ) => reply.code(404).send({ error: "not_found" });
  const notFound = { auth: "public" as const, noResource: "catch-all 404 for unknown API paths" };
  app.all("/api", { config: notFound }, apiNotFound);
  app.all("/api/*", { config: notFound }, apiNotFound);

  if (opts.vite) {
    const { default: middie } = await import("@fastify/middie");
    const { createServer } = await import("vite");
    await app.register(middie);
    const vite = await createServer({
      root: WEB_ROOT,
      // A WebSocket upgrade on the app port would bypass every Fastify hook (trust boundary, gate, session), so
      // HMR never shares the app server: it gets its own loopback-only port, which the tunnel does not reach,
      // and is switched off entirely while the code gate is on.
      // Host is already checked by the trust boundary; let Vite serve the public host too.
      server: config.tempGateCode
        ? { middlewareMode: true, hmr: false, ws: false, allowedHosts: [config.publicHost] }
        : {
            middlewareMode: true,
            hmr: { host: "127.0.0.1", port: opts.hmrPort ?? 24678 },
            allowedHosts: [config.publicHost],
          },
      appType: "spa",
    });
    // API routes must reach Fastify; Vite's SPA fallback would otherwise answer /api/* with index.html.
    // Vite ends responses itself (onSend never runs), so set the base headers before handing over.
    // App pages answered by Fastify routes (`/a/...`, #27) get Vite's index.html from there.
    const indexFile = path.join(WEB_ROOT, "index.html");
    appPage = (url) => vite.transformIndexHtml(url, fs.readFileSync(indexFile, "utf8"));
    app.use((req, res, next) => {
      if (isApiPath(req.url) || isGatePath(req.url) || isArtifactPath(req.url)) return next();
      for (const [k, v] of Object.entries(BASE_HEADERS)) res.setHeader(k, v);
      return vite.middlewares(req, res, next);
    });
    app.addHook("onClose", async () => vite.close());
  } else {
    const webDist = opts.webDist ?? DEFAULT_WEB_DIST;
    if (fs.existsSync(path.join(webDist, "index.html"))) {
      const indexHtml = fs.readFileSync(path.join(webDist, "index.html"));
      appPage = async () => indexHtml;
      await app.register(fastifyStatic, { root: webDist, index: ["index.html"], wildcard: false });
      // SPA fallback: client-side routes (e.g. /c/123) get index.html.
      app.setNotFoundHandler((req, reply) => {
        if ((req.method !== "GET" && req.method !== "HEAD") || isApiPath(req.url))
          return reply.code(404).send({ error: "not_found" });
        return reply.type("text/html; charset=utf-8").header("Cache-Control", "no-cache").send(indexHtml);
      });
    } else {
      // The path is not logged (log policy): the default is apps/web/dist — run "pnpm build" first.
      logEvent(app.log, "warn", "web.build_missing");
    }
  }

  return app;
}
