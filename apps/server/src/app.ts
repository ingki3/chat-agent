import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import type { HealthResponse } from "@agentlee/shared";
import type { Config } from "./config.js";

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

export type BuildOptions = {
  /** Directory of the built SPA. Defaults to apps/web/dist. */
  webDist?: string;
  /** Attach Vite in middleware mode (one port for UI + API in development). */
  vite?: boolean;
  logger?: boolean;
};

export async function buildApp(config: Config, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? config.env !== "test" });
  const startedAt = Date.now();

  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    if (config.env === "production") reply.header("Content-Security-Policy", APP_CSP);
    return payload;
  });

  app.get("/api/health", async (): Promise<HealthResponse> => ({
    status: "ok",
    service: "agent-lee",
    version: VERSION,
    uptimeSec: Math.round((Date.now() - startedAt) / 1000),
  }));

  // Unknown API routes are JSON 404s, never the SPA page.
  app.all("/api/*", async (_req, reply) => reply.code(404).send({ error: "not_found" }));

  if (opts.vite) {
    const { default: middie } = await import("@fastify/middie");
    const { createServer } = await import("vite");
    await app.register(middie);
    const vite = await createServer({
      root: WEB_ROOT,
      server: { middlewareMode: true, hmr: { server: app.server } },
      appType: "spa",
    });
    // API routes must reach Fastify; Vite's SPA fallback would otherwise answer /api/* with index.html.
    app.use((req, res, next) => (req.url?.startsWith("/api/") ? next() : vite.middlewares(req, res, next)));
    app.addHook("onClose", async () => vite.close());
  } else {
    const webDist = opts.webDist ?? DEFAULT_WEB_DIST;
    if (fs.existsSync(path.join(webDist, "index.html"))) {
      await app.register(fastifyStatic, { root: webDist, index: ["index.html"] });
      // SPA fallback: client-side routes (e.g. /c/123) get index.html.
      app.setNotFoundHandler((req, reply) => {
        if (req.method !== "GET" || req.url.startsWith("/api/"))
          return reply.code(404).send({ error: "not_found" });
        return reply.type("text/html").sendFile("index.html");
      });
    } else {
      app.log.warn(`web build not found at ${webDist} — run "pnpm build" first`);
    }
  }

  return app;
}
