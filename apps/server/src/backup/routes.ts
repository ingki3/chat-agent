import type { FastifyInstance } from "fastify";
import type { BackupsResponse } from "@agentlee/shared";
import { DEFAULT_TIME_ZONE } from "../notifications/quiet.js";
import { BACKUP_TIME, RETENTION_DAYS, type BackupService } from "./backup.js";
import { codeMigrations } from "./schema.js";

/**
 * Admin → 백업 (#37): recent backups, "지금 백업" and the schedule. Admin only. Restore is not here on purpose: it
 * replaces the data folder, which needs the server stopped (`pnpm -s restore`, docs/ops.md §21).
 */
export function registerBackupRoutes(app: FastifyInstance, service: BackupService | undefined): void {
  const admin = (what: string) => ({ auth: "admin" as const, noResource: what });
  const schemaMigrations = codeMigrations().length;

  app.get("/api/admin/backups", { config: admin("admin-only backup list") }, async (_req, reply) => {
    const status = service?.status();
    const body: BackupsResponse = {
      available: !!service,
      schedule: { time: BACKUP_TIME, timeZone: DEFAULT_TIME_ZONE, retentionDays: RETENTION_DAYS },
      running: status?.running ?? false,
      nextRunAt: status?.nextRunAt ?? null,
      last: status?.last ?? null,
      schemaMigrations,
      items: service?.list() ?? [],
    };
    return reply.header("Cache-Control", "no-store").send(body);
  });

  app.post("/api/admin/backups", { config: admin("admin-only backup now") }, async (_req, reply) => {
    if (!service) return reply.code(409).send({ error: "backup_unavailable" });
    const r = await service.run("manual");
    if (r.ok) return reply.code(201).send({ item: r.item });
    return reply
      .code(r.code === "backup_running" || r.code === "backup_unavailable" ? 409 : 500)
      .send({ error: r.code });
  });
}
