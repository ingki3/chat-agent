import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { RuntimeId } from "@agentlee/shared";
import { evictPages } from "../citations/verify.js";
import type { Db } from "../db/client.js";
import { logEvent, type EventLogger } from "../logging.js";
import type { RuntimeRegistry } from "../runtime/adapter.js";
import { plainDir, startedHere } from "../runtime/forget.js";
import type { SessionRef } from "../runtime/runs.js";
import { CLEANUP_PENDING_KEY, deleteKey, setKey } from "../secrets/markers.js";
import { storagePaths } from "../storage/paths.js";
import type { ConversationStore } from "./store.js";

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Set while the start-up reconciliation has folders it could not read (retried until a full pass succeeds). */
export const RECONCILE_PENDING_KEY = "deletion.reconcile_incomplete";

export type PurgeOptions = {
  dataDir: string;
  runtimes: RuntimeRegistry;
  /** The run manager: a deleted conversation's jobs wait until its dropped runs have really stopped. */
  runs?: { quiet(conversationId: string): Promise<boolean> } | undefined;
  /**
   * The upload folder of a deleted conversation, removed inside the file-write lock: true once none of its files is
   * left (`FileStore.removeConversationFiles`).
   */
  removeFiles?: ((userId: string, conversationId: string) => Promise<boolean>) | undefined;
  /** Asks the background clean-up to checkpoint the WAL (`StoredRescrub.cleanup`; the marker is set here). */
  cleanup?: (() => void) | undefined;
  /** Extracted text kept in memory for these files (`FileExtracts.evict`). */
  evictFiles?: ((fileIds: string[]) => void) | undefined;
  log?: EventLogger | undefined;
  now?: () => number;
  /** Backoff after a failed attempt: `retryMs · 2^(attempts-1)`, at most `maxRetryMs`. */
  retryMs?: number;
  maxRetryMs?: number;
};

type JobRow = {
  id: string;
  kind: "runtime_session" | "conversation_files";
  conversation_id: string;
  user_id: string;
  runtime: string | null;
  connection_id: string | null;
  external_session_id: string | null;
  attempts: number;
};

/** Not done yet: the job stays and is tried again after the backoff. */
class NotYet extends Error {
  constructor(code: string) {
    super(code);
    this.name = "NotYet";
  }
}

const INSERT_JOB = `INSERT OR IGNORE INTO deletion_jobs
  (id, kind, conversation_id, user_id, runtime, connection_id, external_session_id, attempts, next_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`;

/**
 * A job a conversation (its delete, or its run handing over a session) is sure of: never lost to a job the
 * reconciliation queued earlier for the same session (review #124 round 5) — that one becomes this one (the
 * conversation's, no longer re-checked as a possible orphan) and is due now.
 */
const CLAIM_JOB = `INSERT INTO deletion_jobs
  (id, kind, conversation_id, user_id, runtime, connection_id, external_session_id, attempts, next_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  ON CONFLICT (runtime, connection_id, user_id, external_session_id) DO UPDATE SET
    conversation_id = CASE WHEN excluded.conversation_id <> '' THEN excluded.conversation_id
                           ELSE deletion_jobs.conversation_id END,
    attempts = 0,
    next_at = min(deletion_jobs.next_at, excluded.next_at)`;

/**
 * The parts of deleting a conversation (#54) that are not its rows' foreign keys. The order, for crash safety:
 *
 * 1. **In the delete transaction** (`ConversationStore.onDelete`, before the rows go; the run manager has dropped the
 *    conversation's runs in the same transaction):
 *    - every runtime session of it becomes a `runtime_session` job, its upload folder a `conversation_files` job;
 *    - notifications about it or anything in it (its shares, artifacts, files, runs) go, whoever received them —
 *      their title or body may quote it (a schedule result's summary);
 *    - in-memory copies of its text go (extracted file text, normalised page bodies);
 *    - the clean-up marker is set: the deleted rows' bytes may still be in WAL frames until a TRUNCATE checkpoint.
 *    Then the rows go — conversation, messages, files, extracts, artifacts and versions, sources, citations, shares
 *    with targets, snapshots, read receipts and subscriptions, runs and events, sessions, summaries (foreign keys).
 *    One transaction: a crash before the commit leaves everything; after it, nothing is reachable any more.
 * 2. **After the commit** (`onDeleted`): the upload folder at once (FileStore), the WAL checkpoint (`StoredRescrub`,
 *    resumed from the marker at start), and the jobs below.
 * 3. **The jobs**: each waits until the conversation's dropped runs have really stopped (sessions closed), then does
 *    its part — the runtime forgets the session (`RuntimeAdapter.forget`), or the upload folder is removed and checked
 *    to be gone. Done jobs go; anything not verified done is retried with backoff; left-overs of a crash are resumed
 *    when the server is ready (`resume`).
 * 4. **At start** (`reconcile`, before anything runs): session state no conversation row owns — a session whose row
 *    was never saved because the server died after the runtime wrote it — becomes a job too.
 *
 * One-off sessions (conversation summaries) and sessions that finished opening after their conversation was deleted
 * are handed over by the run manager once closed (`orphan`). A fork made from the conversation is the forker's own
 * conversation and stays (its provenance rows hold ids only).
 */
export class ConversationPurge {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private closed = false;
  private readonly now: () => number;
  private readonly retryMs: number;
  private readonly maxRetryMs: number;
  /**
   * Backoff kept in memory for jobs whose own backoff could not be written (the database refused the write): the
   * loop does not pick them up again before this time.
   */
  private readonly held = new Map<string, { until: number; failures: number }>();
  private reconcileTimer: NodeJS.Timeout | undefined;
  private reconcileFailures = 0;

  constructor(
    private readonly db: Db,
    conversations: ConversationStore,
    private readonly opts: PurgeOptions,
  ) {
    this.now = opts.now ?? Date.now;
    this.retryMs = opts.retryMs ?? 30_000;
    this.maxRetryMs = opts.maxRetryMs ?? 3_600_000;
    conversations.onDelete((id) => this.beforeRows(id));
    conversations.onDeleted((c) => {
      this.opts.cleanup?.();
      logEvent(this.opts.log, "info", "conversation.deleted", {
        conversationId: c.id,
        count: this.pendingFor(c.id),
      });
      this.schedule(0);
    });
  }

  /** Inside the delete transaction, before the rows go. */
  private beforeRows(conversationId: string): void {
    const sql = this.db.$client;
    const conv = sql.prepare("SELECT owner_id AS o FROM conversations WHERE id = ?").get(conversationId) as
      { o: string } | undefined;
    if (!conv) return;
    const t = this.now();
    const insert = sql.prepare(CLAIM_JOB);
    for (const s of sql
      .prepare(
        "SELECT runtime, connection_id, external_session_id FROM runtime_sessions WHERE conversation_id = ?",
      )
      .all(conversationId) as {
      runtime: string;
      connection_id: string | null;
      external_session_id: string;
    }[])
      insert.run(
        crypto.randomUUID(),
        "runtime_session",
        conversationId,
        conv.o,
        s.runtime,
        s.connection_id,
        s.external_session_id,
        t,
        t,
      );
    insert.run(crypto.randomUUID(), "conversation_files", conversationId, conv.o, null, null, null, t, t);
    // Notifications about the conversation or anything in it — the ids are UUIDs, unique across tables.
    sql
      .prepare(
        `DELETE FROM notifications WHERE ref_id = @id
           OR ref_id IN (SELECT id FROM shares WHERE conversation_id = @id)
           OR ref_id IN (SELECT id FROM artifacts WHERE conversation_id = @id)
           OR ref_id IN (SELECT id FROM files WHERE conversation_id = @id)
           OR ref_id IN (SELECT id FROM runs WHERE conversation_id = @id)
           OR url = '/c/' || @id OR url LIKE '/c/' || @id || '#%' OR url LIKE '/c/' || @id || '?%'
           OR url IN (SELECT '/shared/' || id FROM shares WHERE conversation_id = @id)`,
      )
      .run({ id: conversationId });
    const fileIds = (
      sql.prepare("SELECT id FROM files WHERE conversation_id = ?").all(conversationId) as { id: string }[]
    ).map((f) => f.id);
    if (fileIds.length) this.opts.evictFiles?.(fileIds);
    // The citation check's normalised page bodies, keyed by body hash (citations/verify.ts).
    evictPages(
      (
        sql
          .prepare(
            "SELECT DISTINCT body_hash AS h FROM sources WHERE conversation_id = ? AND body_hash IS NOT NULL",
          )
          .all(conversationId) as { h: string }[]
      ).map((r) => r.h),
    );
    // The deleted rows' bytes stay in WAL frames until a TRUNCATE checkpoint (`secure_delete` zeroes the pages).
    setKey(sql, CLEANUP_PENDING_KEY, "1");
  }

  /**
   * A closed session no conversation row remembers (RunManager `forgetSession`: a summary's one-off session, or one
   * that opened after its conversation was deleted, or a start that failed after the session existed): forgotten
   * like the others, once the conversation's runs have stopped (their processes exited).
   */
  orphan(ref: SessionRef): void {
    const t = this.now();
    try {
      this.db.$client
        .prepare(CLAIM_JOB)
        .run(
          crypto.randomUUID(),
          "runtime_session",
          ref.conversationId,
          ref.userId,
          ref.runtime,
          ref.connectionId,
          ref.externalSessionId,
          t,
          t,
        );
    } catch {
      return; // the database is going (shutdown): the start-up reconciliation finds the session
    }
    this.schedule(0);
  }

  /**
   * Start-up reconciliation (only on the data folder's own database, before anything runs): every session a runtime
   * keeps state of in `runtimes/<connection>/<user>/` (`RuntimeAdapter.storedSessions`) that no `runtime_sessions` row
   * of that connection names becomes a job. That is a session whose row was never saved — the server died between the
   * runtime writing it and the row — or a session whose job never got written. Each folder on its own: one it cannot
   * read is skipped and the pass is incomplete — marked (`RECONCILE_PENDING_KEY`) and run again with backoff until a
   * pass reads everything. Later passes never take a session this process started for an orphan (`startedHere`, also
   * checked again by the adapter when the job runs). Returns how many were found; never throws.
   */
  reconcile(): number {
    let found = 0;
    let incomplete = false;
    const sql = this.db.$client;
    try {
      const root = plainDir(storagePaths(this.opts.dataDir).runtimes);
      if (root) {
        const known = sql.prepare(
          "SELECT 1 FROM runtime_sessions WHERE connection_id = ? AND external_session_id = ? LIMIT 1",
        );
        const queued = sql.prepare(
          "SELECT 1 FROM deletion_jobs WHERE connection_id = ? AND user_id = ? AND external_session_id = ? LIMIT 1",
        );
        const insert = sql.prepare(INSERT_JOB);
        const t = this.now();
        const adapters = this.opts.runtimes
          .ids()
          .map((id) => this.opts.runtimes.get(id)!)
          .filter((a) => a.storedSessions && a.forget);
        const entries = (dir: string) => {
          try {
            return fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            incomplete = true;
            return [];
          }
        };
        for (const conn of entries(root)) {
          if (!conn.isDirectory() || !SAFE_ID.test(conn.name)) continue;
          for (const user of entries(path.join(root, conn.name))) {
            if (!user.isDirectory() || !SAFE_ID.test(user.name) || user.name.endsWith("-meta")) continue;
            const dir = path.join(root, conn.name, user.name);
            for (const a of adapters) {
              let ids: string[];
              try {
                ids = a.storedSessions!(dir);
              } catch {
                incomplete = true; // this folder only; the others are still looked at
                continue;
              }
              for (const id of ids) {
                if (startedHere(id) || known.get(conn.name, id) || queued.get(conn.name, user.name, id))
                  continue;
                insert.run(crypto.randomUUID(), "runtime_session", "", user.name, a.id, conn.name, id, t, t);
                found++;
              }
            }
          }
        }
      }
    } catch {
      incomplete = true;
    }
    try {
      if (incomplete) setKey(sql, RECONCILE_PENDING_KEY, "1");
      else deleteKey(sql, RECONCILE_PENDING_KEY);
    } catch {
      // the marker is a record only: the retry below is what runs again
    }
    if (found) logEvent(this.opts.log, "info", "conversation.sessions_reconciled", { count: found });
    if (incomplete) {
      this.reconcileFailures++;
      logEvent(this.opts.log, "warn", "conversation.forget_failed", {
        errorCode: "reconcile_incomplete",
        attempt: this.reconcileFailures,
      });
      if (!this.closed) {
        const wait = Math.min(this.maxRetryMs, this.retryMs * 2 ** Math.min(16, this.reconcileFailures - 1));
        clearTimeout(this.reconcileTimer);
        this.reconcileTimer = setTimeout(() => this.reconcile(), wait);
        this.reconcileTimer.unref();
      }
    } else this.reconcileFailures = 0;
    if (found) this.schedule(0);
    return found;
  }

  /** Jobs a crash left (or that are waiting for a retry): worked off now. */
  resume(): void {
    this.schedule(0);
  }

  /** Jobs not done yet (all, or of one conversation). */
  pendingFor(conversationId?: string): number {
    const sql = this.db.$client;
    return (
      (conversationId === undefined
        ? sql.prepare("SELECT count(*) AS n FROM deletion_jobs").get()
        : sql
            .prepare("SELECT count(*) AS n FROM deletion_jobs WHERE conversation_id = ?")
            .get(conversationId)) as { n: number }
    ).n;
  }

  private schedule(delay: number): void {
    if (this.closed) return;
    if (this.running) {
      this.again = true;
      return;
    }
    if (this.timer) {
      if (delay > 0) return;
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.work()
        .catch(() => {}) // every job handles its own failure; nothing may escape as a rejection
        .finally(() => {
          this.running = undefined;
          if (this.again) {
            this.again = false;
            this.schedule(0);
          } else this.scheduleNext();
        });
    }, delay);
    this.timer.unref();
  }

  /** The next retry, if any job waits for one. */
  private scheduleNext(): void {
    if (this.closed) return;
    try {
      const rows = this.db.$client.prepare("SELECT id, next_at AS t FROM deletion_jobs").all() as {
        id: string;
        t: number;
      }[];
      if (!rows.length) return;
      const next = Math.min(...rows.map((r) => Math.max(r.t, this.held.get(r.id)?.until ?? 0)));
      this.schedule(Math.max(0, next - this.now()));
    } catch {
      // the database is going (shutdown): the jobs stay and are resumed at the next start
    }
  }

  private async work(): Promise<void> {
    for (;;) {
      if (this.closed) return;
      let ready: JobRow[];
      try {
        // Jobs held in memory are left out in the query itself — never 20 held ones filling the page while a due
        // one behind them waits (review #124 round 3).
        ready = this.db.$client
          .prepare(
            `SELECT * FROM deletion_jobs WHERE next_at <= ? AND id NOT IN (SELECT value FROM json_each(?))
             ORDER BY created_at, id LIMIT 20`,
          )
          .all(this.now(), JSON.stringify(this.heldIds())) as JobRow[];
      } catch {
        return; // the database is going (shutdown): resumed at the next start
      }
      if (!ready.length) return;
      for (const job of ready) {
        if (this.closed) return;
        // Its outcome could not be written: stop this round (no tight loop on a failing database); retried later.
        if (!(await this.run(job))) return;
      }
    }
  }

  /** Ids held in memory right now (their hold has not run out). */
  private heldIds(): string[] {
    const t = this.now();
    const out: string[] = [];
    for (const [id, h] of this.held) if (h.until > t) out.push(id);
    return out;
  }

  /** False when its outcome could not be stored (the job is held in memory instead). */
  private async run(job: JobRow): Promise<boolean> {
    const sql = this.db.$client;
    try {
      // Its runs dropped by the delete: their sessions must be closed for good first (a process still writing would
      // put back what is removed). Not yet: tried again later — never done on a timeout.
      if (job.conversation_id && this.opts.runs && !(await this.opts.runs.quiet(job.conversation_id)))
        throw new NotYet("runs_still_stopping");
      if (job.kind === "conversation_files") {
        if (this.opts.removeFiles && !(await this.opts.removeFiles(job.user_id, job.conversation_id)))
          throw new NotYet("files_left");
      } else await this.forget(job);
      sql.prepare("DELETE FROM deletion_jobs WHERE id = ?").run(job.id);
      this.held.delete(job.id);
      if (job.attempts > 0)
        logEvent(this.opts.log, "info", "conversation.session_forgotten", {
          ...(job.runtime ? { runtime: job.runtime } : {}),
          attempt: job.attempts + 1,
        });
    } catch (e) {
      const attempts = job.attempts + 1;
      const wait = Math.min(this.maxRetryMs, this.retryMs * 2 ** Math.min(16, attempts - 1));
      let stored = true;
      try {
        sql
          .prepare("UPDATE deletion_jobs SET attempts = ?, next_at = ? WHERE id = ?")
          .run(attempts, this.now() + wait, job.id);
        this.held.delete(job.id);
      } catch {
        // The database refused the write: the backoff is kept here instead (the row still says "due").
        stored = false;
        const failures = (this.held.get(job.id)?.failures ?? job.attempts) + 1;
        this.held.set(job.id, {
          until: this.now() + Math.min(this.maxRetryMs, this.retryMs * 2 ** Math.min(16, failures - 1)),
          failures,
        });
      }
      logEvent(this.opts.log, "warn", "conversation.forget_failed", {
        ...(job.runtime ? { runtime: job.runtime } : {}),
        attempt: attempts,
        err: e,
      });
      return stored;
    }
    return true;
  }

  /**
   * What the runtime keeps of the session, in `runtimes/<connection>/<user>/` (connections/store.ts): through plain
   * folders only. No connection (FakeRuntime), or no folder (the connection was disconnected — its folder went with
   * it): nothing to do. A linked folder is not walked and the job is not done (retried, logged). A runtime that is
   * not registered right now: tried again later.
   */
  private async forget(job: JobRow): Promise<void> {
    if (!job.connection_id || !job.external_session_id || !job.runtime) return;
    if (!SAFE_ID.test(job.connection_id) || !SAFE_ID.test(job.user_id)) return;
    const root = storagePaths(this.opts.dataDir).runtimes;
    const conn = path.join(root, job.connection_id);
    for (const p of [root, conn]) {
      const st = fs.lstatSync(p, { throwIfNoEntry: false });
      if (!st) return;
      if (st.isSymbolicLink() || !st.isDirectory()) throw new NotYet("linked_folder");
    }
    const adapter = this.opts.runtimes.get(job.runtime as RuntimeId);
    if (!adapter) throw new NotYet("runtime_unavailable");
    // Found by the reconciliation (no conversation): checked again at the last moment, inside the adapter's ordering —
    // a session a row owns by now, or one live in this process, is no orphan: the job is dropped, nothing removed.
    const id = job.external_session_id;
    const connectionId = job.connection_id;
    // Owned by a row: no orphan — dropped. Merely live in this process: not now — kept and tried again (it may be a
    // session whose conversation is deleted meanwhile, review #124 round 5). Neither: an orphan — forgotten.
    const stillOrphan = () => {
      if (
        this.db.$client
          .prepare(
            "SELECT 1 FROM runtime_sessions WHERE connection_id = ? AND external_session_id = ? LIMIT 1",
          )
          .get(connectionId, id)
      )
        return false;
      if (startedHere(id)) throw new NotYet("session_live");
      return true;
    };
    await adapter.forget?.(
      id,
      path.join(conn, job.user_id),
      job.conversation_id === "" ? { stillOrphan } : {},
    );
  }

  /** Resolves once no job is running or due right now (tests, shutdown). */
  async idle(): Promise<void> {
    for (;;) {
      if (this.running) await this.running;
      else if (this.timer && !this.closed) {
        const t = this.now();
        const due = (
          this.db.$client.prepare("SELECT id FROM deletion_jobs WHERE next_at <= ?").all(t) as {
            id: string;
          }[]
        ).filter((r) => (this.held.get(r.id)?.until ?? 0) <= t);
        if (!due.length) return;
        await new Promise((r) => setTimeout(r, 5));
      } else return;
    }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.reconcileTimer);
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
