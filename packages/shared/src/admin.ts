import { z } from "zod";
import { ConnectionStatus } from "./connections.js";
import { RuntimeId } from "./runtime.js";

/**
 * Admin screen (#35, PRD FR-10). Runtimes tab: each runtime with its model list and capabilities (what the adapter
 * offers on this server — the per-user allowance is the runtime policy).
 */
export const AdminRuntimeModel = z.object({
  id: z.string(),
  label: z.string(),
  efforts: z.array(z.string()),
  defaultEffort: z.string().nullable(),
});
export const AdminRuntime = z.object({
  runtime: RuntimeId,
  /** Registered on this server (development's FakeRuntime takes the `claude-code` id). */
  registered: z.boolean(),
  models: z.array(AdminRuntimeModel),
  capabilities: z.object({
    canResume: z.boolean(),
    canSwitchModelInSession: z.boolean(),
    usesTools: z.boolean(),
    needsConnection: z.boolean(),
  }),
});
export type AdminRuntime = z.infer<typeof AdminRuntime>;
export const AdminRuntimesResponse = z.object({ items: z.array(AdminRuntime) });

/** System status (FR-10.4). Codes and counts only — never an error message, prompt or credential. */
export const TunnelState = z.enum(["unconfigured", "ok", "down", "unreachable"]);
export type TunnelState = z.infer<typeof TunnelState>;
export const SystemStatus = z.object({
  version: z.string(),
  startedAt: z.number(),
  uptimeSec: z.number().nonnegative(),
  runtimes: z.array(
    z.object({
      runtime: RuntimeId,
      registered: z.boolean(),
      /** Family shared connections of this runtime with their last test state. */
      shared: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          status: ConnectionStatus,
          lastTestCode: z.string().nullable(),
          lastTestAt: z.number().nullable(),
        }),
      ),
      /** Personal connections of this runtime (all users), by status. */
      personal: z.record(ConnectionStatus, z.number().int()),
    }),
  ),
  /**
   * Cloudflare Tunnel from `cloudflared`'s own metrics server (`/ready`, loopback only): `unconfigured` without
   * `CLOUDFLARED_METRICS`, `ok` with at least one connection to Cloudflare, `down` with none, `unreachable` when the
   * metrics server does not answer.
   */
  tunnel: z.object({ state: TunnelState, readyConnections: z.number().int().nullable() }),
  /**
   * The sandboxed workers (#122) — the extractor, the document worker, the export browser: `account` once a kind's
   * self-check passed (it runs as the dedicated worker account, a different uid); otherwise `same_uid` — the
   * server's own uid inside the macOS sandbox only, NOT isolated by account — with why (`state`, a failed `step`).
   */
  workers: z
    .array(
      z.object({
        kind: z.enum(["extract", "docgen", "render"]),
        isolation: z.enum(["account", "same_uid"]),
        state: z.enum(["ok", "not_configured", "checking", "failed", "stopped", "unavailable"]),
        step: z.string().nullable(),
      }),
    )
    .default([]),
  /** Newest recent errors (#46): IDs and codes only. */
  recentErrors: z.array(
    z.object({
      id: z.number().int(),
      at: z.number().int(),
      source: z.enum(["http", "run", "tool"]),
      code: z.string(),
      category: z.string(),
      runtime: z.string().nullable(),
      tool: z.string().nullable(),
      route: z.string().nullable(),
      statusCode: z.number().int().nullable(),
    }),
  ),
  /** Failed skill calls of the retention period (#46 entries of `skill_*` tools), by tool and code. */
  skillFailures: z.array(
    z.object({ tool: z.string(), code: z.string(), count: z.number().int(), lastAt: z.number().int() }),
  ),
  /** The data folder's file system and the database file (with its WAL), in bytes. */
  disk: z.object({
    totalBytes: z.number().nullable(),
    freeBytes: z.number().nullable(),
    databaseBytes: z.number().nullable(),
  }),
});
export type SystemStatus = z.infer<typeof SystemStatus>;

/** Backups (#37, FR-10.5): the admin screen's list, schedule and "지금 백업". Restore is a CLI — the screen only explains it. */
export const BackupCode = z.enum([
  "backup_ok",
  "backup_running",
  "backup_unavailable",
  "backup_failed",
  "backup_disk_full",
]);
export type BackupCode = z.infer<typeof BackupCode>;
export const BackupItem = z.object({
  /** `20261111-183000Z-1a2b3c` — also what `pnpm -s restore` takes. */
  id: z.string(),
  createdAt: z.number().int(),
  bytes: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  /** Migrations applied to the backed-up database (its schema version). */
  migrations: z.number().int().nonnegative(),
  /** False when the manifest is missing or damaged (it cannot be restored). */
  valid: z.boolean(),
});
export type BackupItem = z.infer<typeof BackupItem>;
export const BackupsResponse = z.object({
  /** False when this server makes no backups (no BACKUP_DIR in tests, an in-memory database). */
  available: z.boolean(),
  schedule: z.object({ time: z.string(), timeZone: z.string(), retentionDays: z.number().int() }),
  running: z.boolean(),
  nextRunAt: z.number().int().nullable(),
  last: z.object({ at: z.number().int(), code: BackupCode }).nullable(),
  /** The database schema version of this server (migrations), to compare with a backup's. */
  schemaMigrations: z.number().int().nonnegative(),
  /**
   * Folders a restore left next to the data folder (docs/ops.md §21.4): `previous` = earlier data folders moved aside
   * (`<name>.before-restore-*`), `rejected` = damaged candidates a recovery moved aside (`<name>.restore-rejected-*`).
   * Neither is removed automatically.
   */
  leftovers: z.object({ previous: z.number().int().nonnegative(), rejected: z.number().int().nonnegative() }),
  items: z.array(BackupItem),
});
export type BackupsResponse = z.infer<typeof BackupsResponse>;
