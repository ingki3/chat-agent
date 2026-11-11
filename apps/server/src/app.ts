import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
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
import { registerRunRoutes } from "./runtime/routes.js";
import { RunManager, type RunManagerOptions } from "./runtime/runs.js";
import { McpTokens } from "./isolation/tokens.js";
import { McpService, type McpServiceOptions } from "./mcp/service.js";
import type { Db } from "./db/client.js";
import { AppEvents } from "./events.js";
import { isApiPath } from "./paths.js";
import type { Config } from "./config.js";
import { registerDiag, type DiagOptions } from "./diag.js";
import { isGatePath, registerGate, type GateOptions } from "./gate.js";
import { BASE_HEADERS } from "./headers.js";
import { loggerOptions } from "./logging.js";

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
  }
}

export type BuildOptions = {
  /** Directory of the built SPA. Defaults to apps/web/dist. */
  webDist?: string;
  /** Attach Vite in middleware mode (one port for UI + API in development). */
  vite?: boolean;
  logger?: boolean;
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
  /** Dev-mode HMR WebSocket port (loopback only, separate from the app port). */
  hmrPort?: number;
};

export async function buildApp(config: Config, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: (opts.logger ?? config.env !== "test") ? loggerOptions() : false });
  const startedAt = Date.now();

  // First, before any route exists: every route that could address a resource must declare its permission.
  installRouteRules(app);

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
    const runtimes = opts.runtimes ?? new RuntimeRegistry();
    if (!opts.runtimes && config.fakeRuntime) runtimes.register(new FakeRuntime());
    // Our MCP server (#43): its own loopback port, started on the first run of a runtime that uses tools.
    const mcpTokens = new McpTokens();
    const mcp = new McpService(mcpTokens, users, opts.mcp);
    const runManager = new RunManager(opts.db!, app.conversations!, runtimes, events, {
      mcp,
      mcpTokens,
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
      app.log.warn(`web build not found at ${webDist} — run "pnpm build" first`);
    }
  }

  return app;
}
