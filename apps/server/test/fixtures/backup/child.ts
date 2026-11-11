// A separate process for the backup tests (#37): holds or tries the data folder's lock, or runs a restore and kills
// itself between two steps of the swap. Run with `node --conditions=development --import tsx child.ts <mode> …`.
import { restoreBackup, type RestoreStep } from "../../../src/backup/restore.js";
import { loadMasterKey } from "../../../src/crypto/secrets.js";
import { acquireDataLock, DataLockHeld, type DataLockKind } from "../../../src/storage/data-lock.js";

const [mode, ...args] = process.argv.slice(2);

if (mode === "lock") {
  acquireDataLock(args[0]!, args[1] as DataLockKind);
  process.stdout.write("locked\n");
  setInterval(() => {}, 1000);
} else if (mode === "try-lock") {
  try {
    acquireDataLock(args[0]!, args[1] as DataLockKind).release();
    process.stdout.write("acquired\n");
  } catch (e) {
    if (!(e instanceof DataLockHeld)) throw e;
    process.stdout.write(`held:${e.holder}\n`);
  }
} else if (mode === "restore") {
  const [backup, target, keyPath, killAt] = args as [string, string, string, RestoreStep];
  restoreBackup({
    backup,
    target,
    key: loadMasterKey(keyPath),
    hooks: {
      step: (s) => {
        if (s !== killAt) return;
        process.kill(process.pid, "SIGKILL");
        // Never go on to the next step even if the signal took a moment.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
      },
    },
  });
  process.stdout.write("restored\n");
} else throw new Error(`unknown mode ${mode}`);
