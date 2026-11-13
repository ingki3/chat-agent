// A separate process for the backup tests (#37): holds or tries the data folder's lock, or runs a restore and kills
// itself between two steps of the swap. Run with `node --conditions=development --import tsx child.ts <mode> …`.
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { restoreBackup, type RestoreStep } from "../../../src/backup/restore.js";
import { loadMasterKey } from "../../../src/crypto/secrets.js";
import { acquireDataLock, DataLockHeld, type DataLockKind } from "../../../src/storage/data-lock.js";

const [mode, ...args] = process.argv.slice(2);

if (mode === "lock") {
  acquireDataLock(args[0]!, args[1] as DataLockKind);
  process.stdout.write("locked\n");
  setInterval(() => {}, 1000);
} else if (mode === "lock-drop") {
  // Holds the lock without keeping the handle; forced garbage collection must not release it.
  acquireDataLock(args[0]!, "server");
  for (let i = 0; i < 5; i++) (globalThis as { gc?: () => void }).gc?.();
  process.stdout.write(typeof (globalThis as { gc?: unknown }).gc === "function" ? "locked\n" : "no-gc\n");
  setInterval(() => (globalThis as { gc?: () => void }).gc?.(), 20);
} else if (mode === "commit-die") {
  // Commits one user in WAL mode and dies at once: the row lives only in the -wal file.
  const db = new Database(path.join(args[0]!, "agentlee.db"));
  db.pragma("journal_mode = WAL");
  db.pragma("wal_autocheckpoint = 0");
  db.prepare("INSERT INTO users (id, email, name, role) VALUES ('wal-user', 'wal@x', 'wal', 'member')").run();
  process.stdout.write("committed\n");
  process.kill(process.pid, "SIGKILL");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
} else if (mode === "hold-reader") {
  // Another process (not taking the data lock, like a sqlite3 shell) inside a read transaction on the old database.
  // `wal` (default): a snapshot that needs the WAL. A snapshot of a fully checkpointed WAL reads the main file alone
  // (SQLite's read mark 0) and does not stop a TRUNCATE checkpoint — rightly, nothing then lives only in the WAL;
  // whether the dead writer's frame was still un-checkpointed when this reader started was left to timing (a CI
  // flake, #111). So the reader commits a frame of its own first (no auto-checkpoint, nobody else running): its
  // snapshot below includes a frame no checkpoint has copied, deterministically.
  // `delete`: the database is in rollback-journal mode (e.g. after an earlier restore); the reader's transaction
  // holds a SHARED lock on the main file, which a WAL checkpoint does not see (#139 review).
  const journal = args[1] ?? "wal";
  const db = new Database(path.join(args[0]!, "agentlee.db"));
  if (journal === "wal") {
    db.pragma("journal_mode = WAL");
    db.pragma("wal_autocheckpoint = 0");
    db.prepare(
      "INSERT INTO users (id, email, name, role) VALUES ('wal-reader', 'reader@x', 'reader', 'member')",
    ).run();
  } else if (db.pragma("journal_mode", { simple: true }) !== "delete") {
    process.stdout.write("reader-failed: not in rollback-journal mode\n");
    process.exit(1);
  }
  db.exec("BEGIN");
  db.prepare("SELECT count(*) FROM users").get();
  // The connection must outlive this block: when nothing referred to `db`, V8 collected it while the process idled
  // and better-sqlite3's finalizer closed the connection — ending the read transaction (and, as the last
  // connection, checkpointing and deleting the WAL) before the restore ran, which then rightly found nothing to
  // wait for (#103). The interval keeps it reachable; forced collections (run with --expose-gc) prove it, and the
  // reader shows its transaction is still open (in WAL mode: it still sees its own WAL-only row) before it reports.
  setInterval(() => void db, 1000);
  setTimeout(() => {
    for (let i = 0; i < 5; i++) (globalThis as { gc?: () => void }).gc?.();
    setTimeout(() => {
      const own =
        journal !== "wal" || db.prepare("SELECT 1 FROM users WHERE id = 'wal-reader'").get() !== undefined;
      if (db.inTransaction && own) process.stdout.write("reader-ready\n");
      else {
        process.stdout.write("reader-failed\n");
        process.exit(1);
      }
    }, 50);
  }, 0);
} else if (mode === "try-lock") {
  try {
    acquireDataLock(args[0]!, args[1] as DataLockKind).release();
    process.stdout.write("acquired\n");
  } catch (e) {
    if (!(e instanceof DataLockHeld)) throw e;
    process.stdout.write(`held:${e.holder}\n`);
  }
} else if (mode === "race") {
  // Takes the lock N times; while holding it, a sentinel file must not exist (or two hold it at once).
  const [dataDir, sentinel, n, go] = args as [string, string, string, string | undefined];
  // Start together (the test makes `go` once every racer is up): tsx start-up time differs a lot on a loaded runner,
  // and a racer that starts early could finish all its rounds before the others exist.
  if (go) {
    process.stdout.write("ready\n");
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(go) && Date.now() < deadline)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
  // `n` is the number of successful holds each racer aims for; failed attempts don't count, so a racer that keeps
  // losing keeps trying (until a wall-clock bound) instead of running out of attempts while another one holds it.
  let acquired = 0;
  const until = Date.now() + 20_000;
  while (acquired < Number(n) && Date.now() < until) {
    let lock;
    try {
      lock = acquireDataLock(dataDir, "server");
    } catch (e) {
      if (!(e instanceof DataLockHeld)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.random() * 3);
      continue;
    }
    acquired++;
    try {
      fs.closeSync(fs.openSync(sentinel, "wx"));
    } catch {
      process.stdout.write("OVERLAP\n");
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
    fs.rmSync(sentinel, { force: true });
    lock.release();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.random() * 2);
  }
  process.stdout.write(`acquired=${acquired}\n`);
} else if (mode === "restore") {
  // killAt: a step name (after its journal write or clean-up) or `rename1`/`rename2` (right after that rename,
  // before the journal records it).
  const [backup, target, keyPath, killAt] = args as [string, string, string, RestoreStep | `rename${number}`];
  const die = () => {
    process.kill(process.pid, "SIGKILL");
    // Never go on to the next step even if the signal took a moment.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
  };
  let renames = 0;
  restoreBackup({
    backup,
    target,
    key: loadMasterKey(keyPath),
    hooks: {
      rename: (from, to) => {
        fs.renameSync(from, to);
        if (killAt === `rename${++renames}`) die();
      },
      step: (s) => {
        if (s === killAt) die();
      },
    },
  });
  process.stdout.write("restored\n");
} else throw new Error(`unknown mode ${mode}`);
