import "../env.js";
import { loadConfig, REPO_ROOT } from "../config.js";
import { loadMasterKey } from "../crypto/secrets.js";
import { checkBackup, migrateData, predeployBackup, ReleaseError, releaseSummary } from "../release/ops.js";

/**
 * Release helper (#143, docs/ops.md §43), run by `scripts/release.sh` from an installed release
 * (`node apps/server/dist/cli/release.js …`) with the daemon's environment (`env -i`, NODE_ENV=production), so the
 * configuration is exactly the release's `.env` → `shared/.env`. Prints `key=value` lines of paths, ids and counts
 * only — never a value from `.env`.
 *
 *   config                     what the production configuration resolves to (port, DATA_DIR, BACKUP_DIR, …)
 *   backup                     the pre-deploy backup (server may run): `backup_id=` or `database=absent`
 *   check-backup <id>          whether this release can restore that backup (`compatible=ok`, else exit 1)
 *   migrate-data --from <dir>  one-time copy of an old data folder to DATA_DIR (server stopped)
 */
function fail(e: unknown): never {
  if (e instanceof ReleaseError) console.error(`release: ${e.code} — ${e.message}`);
  else console.error(`release: failed — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

const [command, ...rest] = process.argv.slice(2);
try {
  const config = loadConfig();
  const summary = releaseSummary(config, { repoRoot: REPO_ROOT, env: process.env });
  if (command === "config") {
    console.log(
      [
        `host=${summary.host}`,
        `port=${summary.port}`,
        `data_dir=${summary.dataDir}`,
        `backup_dir=${summary.backupDir}`,
        `database=${summary.database}`,
        `worker_run_user=${summary.workerRunUser ? "set" : "unset"}`,
        `python_run=${summary.pythonRun ? "on" : "off"}`,
      ].join("\n"),
    );
  } else if (command === "backup") {
    const r = await predeployBackup({
      dataDir: summary.dataDir,
      backupDir: summary.backupDir,
      masterKey: loadMasterKey(config.masterKeyPath),
    });
    if (!r) console.log("database=absent");
    else
      console.log(
        [
          `backup_id=${r.id}`,
          `backup_dir=${r.dir}`,
          `pending_migrations=${r.pendingMigrations}`,
          "integrity=ok",
        ].join("\n"),
      );
  } else if (command === "check-backup" && rest[0] && rest.length === 1) {
    const r = checkBackup(summary.backupDir, rest[0], loadMasterKey(config.masterKeyPath));
    console.log([`backup_id=${rest[0]}`, `pending_migrations=${r.pending}`, "compatible=ok"].join("\n"));
  } else if (command === "migrate-data" && rest[0] === "--from" && rest[1] && rest.length === 2) {
    const r = migrateData({ from: rest[1], to: summary.dataDir });
    console.log(
      [
        `from=${r.from}`,
        `to=${r.to}`,
        `files=${r.files}`,
        `bytes=${r.bytes}`,
        `sessions_invalidated=${r.sessionsInvalidated}`,
        "integrity=ok",
      ].join("\n"),
    );
  } else {
    console.error("usage: release.js config | backup | check-backup <id> | migrate-data --from <dir>");
    process.exit(2);
  }
} catch (e) {
  fail(e);
}
