import type { UserStore } from "../auth/users.js";
import type { Config } from "../config.js";
import type { SettingsStore } from "../db/settings-store.js";
import { logEvent, type EventLogger } from "../logging.js";
import { ConnectionRuleError, type ConnectionRow, type ConnectionStore } from "./store.js";

/** The `.env` values that are imported, each once. */
export const IMPORT_ITEMS = ["claude_api_key", "claude_oauth_token", "codex_api_key"] as const;
export type ImportItem = (typeof IMPORT_ITEMS)[number];

/** Settings flag per imported value (the connection id): each `.env` credential is imported once, never again. */
const FLAG = (what: ImportItem) => `connections.env_imported.${what}`;
/** `createdBy` of imported connections. */
export const ENV_IMPORT = "env-import";

export type ImportFailure = { item: ImportItem; code: string };
export type ImportResult = { created: ConnectionRow[]; failed: ImportFailure[] };

/**
 * One-time import of the `.env` credentials used before #17 (docs/ops.md §11):
 * - `CLAUDE_API_KEY` → a shared Claude Code API key connection;
 * - `CLAUDE_OAUTH_TOKEN` → the admin's personal Claude subscription (once the admin account exists);
 * - `CODEX_API_KEY` → a shared Codex API key connection.
 *
 * Failure handling (review #84):
 * - All connections and their "imported" flags are written in **one** transaction: a failure in the middle (the
 *   database) leaves nothing, so a retry never duplicates a connection and never leaves one half-imported.
 * - A value the connection rules refuse (`ConnectionRuleError`) is skipped *without* its flag; the others still go
 *   in. The server starts either way: the failure is logged, reported to the admin (`failed`, shown by
 *   `GET /api/admin/connections`), and the import is tried again on the next start — fix `.env`, restart.
 * Imported connections start `untested`; `pendingImportTests` finds them on every start until they were tested.
 */
export function importEnvConnections(
  config: Pick<Config, "claude" | "codex" | "adminEmail">,
  store: ConnectionStore,
  users: Pick<UserStore, "byEmail">,
  settings: Pick<SettingsStore, "get" | "set">,
  log: EventLogger | undefined,
): ImportResult {
  const makers: [ImportItem, () => ConnectionRow | undefined][] = [];
  const apiKey = config.claude?.apiKey;
  if (apiKey)
    makers.push([
      "claude_api_key",
      () =>
        store.create({
          runtime: "claude-code",
          authType: "api_key",
          scope: "shared",
          owner: null,
          createdBy: ENV_IMPORT,
          label: "Claude API 키 (.env에서 가져옴)",
          secret: apiKey,
        }),
    ]);
  const token = config.claude?.oauthToken;
  if (token)
    makers.push([
      "claude_oauth_token",
      () => {
        const admin = users.byEmail(config.adminEmail);
        if (!admin || admin.role !== "admin" || !admin.active) return undefined; // next start
        return store.create({
          runtime: "claude-code",
          authType: "subscription",
          scope: "personal",
          owner: admin,
          createdBy: ENV_IMPORT,
          label: "Claude 구독 (.env에서 가져옴)",
          secret: token,
        });
      },
    ]);
  const codexKey = config.codex?.apiKey;
  if (codexKey)
    makers.push([
      "codex_api_key",
      () =>
        store.create({
          runtime: "codex",
          authType: "api_key",
          scope: "shared",
          owner: null,
          createdBy: ENV_IMPORT,
          label: "OpenAI API 키 (.env에서 가져옴)",
          secret: codexKey,
        }),
    ]);

  const todo = makers.filter(([item]) => !settings.get(FLAG(item)));
  if (!todo.length) return { created: [], failed: [] };
  const created: ConnectionRow[] = [];
  const failed: ImportFailure[] = [];
  try {
    store.transaction(() => {
      for (const [item, make] of todo) {
        let row: ConnectionRow | undefined;
        try {
          row = make();
        } catch (e) {
          if (!(e instanceof ConnectionRuleError)) throw e;
          failed.push({ item, code: e.code }); // this value only: no flag, tried again next start
          continue;
        }
        if (!row) continue;
        settings.set(FLAG(item), row.id);
        created.push(row);
      }
    });
  } catch {
    // Rolled back as a whole: nothing of this import exists. Reported, retried on the next start.
    created.length = 0;
    failed.length = 0;
    for (const [item] of todo) failed.push({ item, code: "import_failed" });
  }
  for (const c of created)
    logEvent(log, "info", "connection.imported", {
      connectionId: c.id,
      runtime: c.runtime,
      scope: c.scope,
      authType: c.authType,
    });
  for (const f of failed)
    logEvent(log, "warn", "connection.import_failed", { importItem: f.item, importCode: f.code });
  return { created, failed };
}

/**
 * Imported connections that still wait for their first test (still `untested`, not disconnected) — tested on every
 * start, so an import whose test never ran (a crash, no admin yet) recovers by itself.
 */
export function pendingImportTests(
  store: Pick<ConnectionStore, "get">,
  settings: Pick<SettingsStore, "get">,
): ConnectionRow[] {
  return IMPORT_ITEMS.flatMap((item) => {
    const id = settings.get(FLAG(item));
    const c = id ? store.get(id) : undefined;
    return c && c.status === "untested" && c.disconnectedAt === null && c.secret !== null ? [c] : [];
  });
}
