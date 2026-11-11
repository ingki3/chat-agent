// A separate process for the backup tests (#37): holds or tries the data folder's lock, or runs a restore and kills
// itself between two steps of the swap. Run with `node --conditions=development --import tsx child.ts <mode> …`.
import fs from "node:fs";
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
  const [dataDir, sentinel, n] = args as [string, string, string];
  let acquired = 0;
  for (let i = 0; i < Number(n); i++) {
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
