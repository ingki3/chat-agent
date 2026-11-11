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
import { registerUserAdmin, type UserAdminOptions } from "./users/routes.js";
import { registerConversationRoutes } from "./conversations/routes.js";
import { ConversationStore } from "./conversations/store.js";
import { RuntimeRegistry } from "./runtime/adapter.js";
import { FakeRuntime } from "./runtime/fake.js";
import { claudeFromStore } from "./runtime/claude-config.js";
import { codexFromStore } from "./runtime/codex-config.js";
import { importEnvConnections, pendingImportTests } from "./connections/import.js";
import { registerConnectionRoutes } from "./connections/routes.js";
import { ConnectionService } from "./connections/service.js";
import { ConnectionStore } from "./connections/store.js";
import { ConnectionTester } from "./connections/tester.js";
import { UsageStore } from "./usage/store.js";
import { CLAUDE_EGRESS_HOSTS, CODEX_EGRESS_HOSTS, EgressService } from "./isolation/egress.js";
import { registerRunRoutes } from "./runtime/routes.js";
import { RunManager, type RunManagerOptions } from "./runtime/runs.js";
import { McpTokens } from "./isolation/tokens.js";
import { McpService, type McpServiceOptions } from "./mcp/service.js";
import { mcpOptionsFromConfig, registerSkillRoutes } from "./mcp/routes.js";
import { SourceStore } from "./web/sources.js";
import { registerSourceRoutes } from "./web/routes.js";
import type { Db } from "./db/client.js";
import { SettingsStore } from "./db/settings-store.js";
import { KEY_LEN } from "./crypto/secrets.js";
import { registerNotificationRoutes } from "./notifications/routes.js";
import { NotificationService, type NotificationServiceOptions } from "./notifications/service.js";
import { loadOrCreateVapidKeys } from "./notifications/vapid.js";
import { AppEvents } from "./events.js";
import { isApiPath } from "./paths.js";
import type { Config } from "./config.js";
import { registerDiag, type DiagOptions } from "./diag.js";
import { isGatePath, registerGate, type GateOptions } from "./gate.js";
import { BASE_HEADERS } from "./headers.js";
import { logEvent, loggerOptions, rotatingFile } from "./logging.js";
import { ErrorLog } from "./observability/errors.js";
import { registerRoutePattern } from "./observability/policy.js";
import { registerErrorHandling, registerErrorRoutes } from "./observability/routes.js";

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
  /** Runtime adapters (tests pass FakeRuntime instances). Default: real adapters (#15/#16), FakeRuntime if FAKE_RUNTIME=1. */
  runtimes?: RuntimeRegistry;
  runs?: RunManagerOptions;
  /** MCP server overrides (tests: skill runner, clock). */
  mcp?: McpServiceOptions;
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
  /** Dev-mode HMR WebSocket port (loopback only, separate from the app port). */
  hmrPort?: number;
};

/** Tests without a master key: one throwaway key per database, so rebuilding the app on it still decrypts. */
const ephemeralKeys = new WeakMap<Db, Buffer>();
function ephemeralKey(db: Db): Buffer {
  let key = ephemeralKeys.get(db);
  if (!key) ephemeralKeys.set(db, (key = crypto.randomBytes(KEY_LEN)));
  return key;
}

export async function buildApp(config: Config, opts: BuildOptions = {}): Promise<FastifyInstance> {
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

  // First, before any route exists: every route that could address a resource must declare its permission.
  installRouteRules(app);
  // Route patterns are what logs and the error list may name (observability/policy.ts).
  app.addHook("onRoute", (route) => registerRoutePattern(route.url));

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.headers(BASE_HEADERS);
    if (config.env === "production") reply.header("Content-Security-Policy", APP_CSP);
    return payload;
  });

  const events = opts.events ?? new AppEvents();
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
    const settingsStore = new SettingsStore(opts.db!, masterKey);
    // Runtime connections (#17): credentials encrypted with the master key, resolved per run by the adapters.
    const connectionStore = new ConnectionStore(opts.db!, masterKey, config.dataDir);
    const runtimes = opts.runtimes ?? new RuntimeRegistry();
    if (!opts.runtimes && config.fakeRuntime) runtimes.register(new FakeRuntime());
    else if (!opts.runtimes) {
      // Runtime CLIs reach the internet only through an egress proxy (allow-listed API hosts, no private
      // addresses) — one per runtime, so each reaches only its own provider.
      const egressFor = (allow: readonly string[]) => {
        const egress = new EgressService({ allow });
        app.addHook("onClose", async () => egress.close());
        return egress;
      };
      // Both real runtimes are always there; whether a user can run one depends on their connections (#17).
      // Tests bring their own runtimes (opts.runtimes) and never start a real CLI.
      if (config.env !== "test") {
        runtimes.register(claudeFromStore(connectionStore, users, egressFor(CLAUDE_EGRESS_HOSTS)));
        runtimes.register(codexFromStore(connectionStore, users, egressFor(CODEX_EGRESS_HOSTS)));
      }
    }
    // Our MCP server (#43): its own loopback port, started on the first run of a runtime that uses tools.
    const mcpTokens = new McpTokens();
    // Usage records (#44): replies and connection tests write here, keyed on run and attempt.
    const usage = new UsageStore(opts.db!);
    // Web search and fetch (#50): results are stored as sources of the run's conversation.
    const sources = new SourceStore(opts.db!);
    const mcp = new McpService(mcpTokens, users, {
      log: app.log,
      web: { sources, providers: config.webSearchProviders },
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
    const runManager = new RunManager(opts.db!, app.conversations!, runtimes, events, {
      mcp,
      usage,
      mcpTokens,
      connections: {
        resolve: (input) => connections.access.resolve(input),
        runFailed: (run, code) => connections.runFailed(run, code),
      },
      log: app.log,
      ...(errors ? { errors } : {}),
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
    registerConversationRoutes(app, app.conversations!, runManager);
    registerRunRoutes(app, runManager, app.conversations!, opts.sse ?? {});
    registerErrorRoutes(app, errors!);
    registerSkillRoutes(app, mcp);
    registerConnectionRoutes(app, connections, users, runtimes);
    registerSourceRoutes(app, app.conversations!, sources);

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
    app.use((req, res, next) => {
      if (isApiPath(req.url) || isGatePath(req.url)) return next();
      for (const [k, v] of Object.entries(BASE_HEADERS)) res.setHeader(k, v);
      return vite.middlewares(req, res, next);
    });
    app.addHook("onClose", async () => vite.close());
  } else {
    const webDist = opts.webDist ?? DEFAULT_WEB_DIST;
    if (fs.existsSync(path.join(webDist, "index.html"))) {
      const indexHtml = fs.readFileSync(path.join(webDist, "index.html"));
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
