import type { FastifyInstance } from "fastify";
import {
  PriceTableRequest,
  UsageSettings,
  type AdminUsageReport,
  type MyUsage,
  type PriceTable,
  type PriceTableResponse,
} from "@agentlee/shared";
import { deny } from "../auth/plugin.js";
import { logEvent } from "../logging.js";
import type { PriceStore } from "./prices.js";
import type { UsageService } from "./service.js";

/**
 * Usage API (#32, FR-9.3·9.5).
 * - `GET /api/usage/me`: the caller's own usage this month. It takes no user id: it can only ever read the caller.
 * - `/api/admin/usage…` (admin only): everyone's usage in every breakdown, the price table (each save is a new
 *   version) and the daily cost threshold.
 */
export function registerUsageRoutes(app: FastifyInstance, usage: UsageService, prices: PriceStore): void {
  const admin = { auth: "admin" as const, noResource: "admin-only usage, price table and cost settings" };

  app.get(
    "/api/usage/me",
    { config: { noResource: "the caller's own usage (no id: only the session's user)" } },
    async (req, reply) => {
      const body: MyUsage = usage.mine(req.ctx.user!.id);
      return reply.header("Cache-Control", "no-store").send(body);
    },
  );

  app.get("/api/admin/usage", { config: admin }, async (_req, reply) => {
    const body: AdminUsageReport = usage.admin(prices.currentVersion());
    return reply.header("Cache-Control", "no-store").send(body);
  });

  app.get("/api/admin/usage/prices", { config: admin }, async (_req, reply) => {
    const body: PriceTableResponse = { current: prices.current(), versions: prices.versions() };
    return reply.header("Cache-Control", "no-store").send(body);
  });

  app.put("/api/admin/usage/prices", { config: admin }, async (req, reply) => {
    const r = PriceTableRequest.safeParse(req.body);
    if (!r.success) return deny(reply, 400, "invalid_request");
    const saved: PriceTable = prices.save(r.data.prices, req.ctx.user!.id);
    logEvent(req.log, "info", "usage.prices_saved", { userId: req.ctx.user!.id, count: saved.prices.length });
    return reply.header("Cache-Control", "no-store").send(saved);
  });

  app.get("/api/admin/usage/settings", { config: admin }, async (_req, reply) =>
    reply.header("Cache-Control", "no-store").send(usage.getSettings()),
  );

  app.put("/api/admin/usage/settings", { config: admin }, async (req, reply) => {
    const r = UsageSettings.safeParse(req.body);
    if (!r.success) return deny(reply, 400, "invalid_request");
    return reply.header("Cache-Control", "no-store").send(usage.setSettings(r.data));
  });
}
