/**
 * The file-write lock of the data folder (#37). Files under `files/`, `artifacts/` and `sources/` are written only
 * inside `write()` — several writers at once are fine. A backup takes `exclusive()`: it waits for the writers already
 * inside, lets no new one in, takes the database snapshot and copies the files, then lets the writers go on. So a
 * backup never holds a database row whose file is missing, or a file whose row is not in the snapshot.
 *
 * A writer must do *both* halves of its change inside one `write()` (the row and the file), whatever order it uses.
 * The lock is held only for the copy of one backup (seconds for this family's data); a writer just waits.
 */
export class FileWriteLock {
  private writers = 0;
  private exclusiveHeld = false;
  /** Writers waiting for the exclusive holder, and exclusive waiters waiting for writers to leave. */
  private readonly waitingWriters: (() => void)[] = [];
  private readonly waitingExclusive: (() => void)[] = [];

  /** Runs `fn` as a file writer (waits while a backup is copying). */
  async write<T>(fn: () => Promise<T> | T): Promise<T> {
    // A queued backup goes first: new writers wait behind it, so a steady stream of writers cannot starve it.
    while (this.exclusiveHeld || this.waitingExclusive.length > 0)
      await new Promise<void>((r) => this.waitingWriters.push(r));
    this.writers++;
    try {
      return await fn();
    } finally {
      this.writers--;
      if (this.writers === 0) this.wake();
    }
  }

  /** Runs `fn` with no writer inside (the backup). One holder at a time. */
  async exclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    while (this.exclusiveHeld || this.writers > 0)
      await new Promise<void>((r) => this.waitingExclusive.push(r));
    this.exclusiveHeld = true;
    try {
      return await fn();
    } finally {
      this.exclusiveHeld = false;
      this.wake();
    }
  }

  private wake(): void {
    if (this.exclusiveHeld) return;
    const next = this.waitingExclusive.shift();
    if (next && this.writers === 0) return next();
    if (next) this.waitingExclusive.unshift(next);
    for (const w of this.waitingWriters.splice(0)) w();
  }
}
