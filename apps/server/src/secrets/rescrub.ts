import crypto from "node:crypto";
import { snippetKey } from "../citations/store.js";
import { forgetCitedTextHashes, parseMarks, scrubFile } from "../files/scrub.js";
import type { Db } from "../db/client.js";
import { logEvent, type EventLogger } from "../logging.js";
import { TEXT_COLUMNS, type RescrubKind } from "./columns.js";
import {
  CLEANUP_PENDING_KEY,
  COMPACTED_KEY,
  compactionCheckpointed,
  compactionState,
  readKey,
} from "./markers.js";
import { runVacuum, truncateCheckpoint } from "./compact.js";
import {
  KnownSecrets,
  knownSecrets,
  scrubContent,
  scrubEventSequence,
  scrubKnown,
  scrubKnownDeep,
  scrubParts,
} from "./known.js";

/**
 * Background rescrub of stored rows (review rounds 25–26): when a secret that may already be stored is registered
 * (a connection key, a `.env` value at startup, a session after a restart), every text column that holds user or
 * runtime content (`TEXT_COLUMNS` with a `rescrub` kind) is scrubbed again, in small chunks with a yield to the
 * event loop between them, so a value stored before anyone knew it was a secret does not stay in the database.
 * A pass that fails keeps its values pending and is retried with backoff (`secrets.rescrub_failed`, a fixed code).
 * Reads and responses are scrubbed as well (defence in depth); this makes the rows themselves clean.
 */

type Column = { name: string; kind: RescrubKind };
type Table = {
  table: string;
  columns: Column[];
  /** A trigger that makes the rows immutable (lifted for the scrub only, inside its transaction). */
  immutable?: string;
  /** Columns recomputed from the scrubbed ones (content hashes, sizes). */
  derived?: (row: Record<string, unknown>) => Record<string, unknown>;
  /**
   * Columns that cannot hold a mask (an identifier the row is about, e.g. a watchlist symbol): a row with a hit in
   * one of them is deleted instead — with `secure_delete`, so the freed cell is zeroed, not left in the page.
   */
  removeOn?: readonly string[];
};

// The persisted clean-up state (markers.ts): re-exported for callers and tests.
export { CLEANUP_PENDING_KEY, COMPACTED_KEY, compactionCheckpointed } from "./markers.js";
const markPending = (sql: Db["$client"]) =>
  sql
    .prepare(
      "insert into settings (key, value) values (?, '1') on conflict(key) do update set value = excluded.value",
    )
    .run(CLEANUP_PENDING_KEY);

const sha256 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

const DERIVED: Record<string, Pick<Table, "immutable" | "derived" | "removeOn">> = {
  // 관심 종목 (#31, review #111): a masked symbol is no symbol — the row goes.
  watchlist_items: { removeOn: ["symbol"] },
  sources: { derived: (r) => (typeof r.body === "string" ? { body_hash: sha256(r.body) } : {}) },
  // The duplicate key (a hash) follows the scrubbed snippet (#25).
  citations: {
    derived: (r) => (typeof r.snippet === "string" ? { snippet_key: snippetKey(r.snippet) } : {}),
  },
  artifact_versions: {
    immutable: "artifact_versions_immutable",
    derived: (r) =>
      typeof r.content === "string"
        ? { content_hash: sha256(r.content), bytes: Buffer.byteLength(r.content, "utf8") }
        : {},
  },
};

/**
 * The tables and columns to rescrub, from `TEXT_COLUMNS` (`run_events` is handled per run, as a stream, and
 * `file_segments` per file — `rescrubFiles`).
 */
export const RESCRUB_TABLES: readonly Table[] = (() => {
  const byTable = new Map<string, Column[]>();
  for (const [key, rule] of Object.entries(TEXT_COLUMNS)) {
    if (!("rescrub" in rule)) continue;
    const [table, name] = key.split(".") as [string, string];
    // Run events go per run (a stream), extracted file text per file (its units in document order, #48).
    if (table === "run_events" || table === "file_segments") continue;
    byTable.set(table, [...(byTable.get(table) ?? []), { name, kind: rule.rescrub }]);
  }
  return [...byTable].map(([table, columns]) => ({ table, columns, ...DERIVED[table] }));
})();

const CHUNK = 200;
const tick = () => new Promise<void>((r) => setImmediate(r));

function rescrubValue(v: string, kind: RescrubKind, registry: KnownSecrets): string {
  if (kind === "text") return scrubKnown(v, { registry });
  if (kind === "content") return scrubContent(v, { registry });
  try {
    const parsed = JSON.parse(v) as unknown;
    const next =
      kind === "parts" && Array.isArray(parsed)
        ? scrubParts(parsed, { registry })
        : scrubKnownDeep(parsed, { registry });
    return next === parsed ? v : JSON.stringify(next);
  } catch {
    return scrubKnown(v, { registry });
  }
}

export type RescrubOptions = {
  registry?: KnownSecrets;
  /** Wait before a pass (registrations in a burst share one). */
  delayMs?: number;
  /** First retry after a failed pass; doubles up to `maxRetryMs`. */
  retryMs?: number;
  maxRetryMs?: number;
  /** The compaction's `VACUUM` after a failure (compact.ts): first retry, doubling up to the maximum. */
  compactRetryMs?: number;
  maxCompactRetryMs?: number;
  log?: EventLogger;
};

export class StoredRescrub {
  private running: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  /** Values not yet looked for in the stored rows: a pass looks for these only (the rest were looked for before). */
  private pending = new Set<string>();
  private failures = 0;
  /**
   * A pass changed or removed rows and the files are not clean yet: the old values may still be in WAL frames or
   * in the database file's earlier page versions until a `wal_checkpoint(TRUNCATE)` succeeds (review #111).
   */
  private dirty = false;
  /** One-time compaction still `needed` (markers.ts): failures so far and when the next `VACUUM` may run. */
  private compactFailures = 0;
  private nextCompactAt = 0;
  private readonly off: () => void;
  private readonly registry: KnownSecrets;
  private readonly delayMs: number;
  private readonly retryMs: number;
  private readonly maxRetryMs: number;
  private readonly compactRetryMs: number;
  private readonly maxCompactRetryMs: number;

  constructor(
    private readonly db: Db,
    private readonly opts: RescrubOptions = {},
  ) {
    this.registry = opts.registry ?? knownSecrets;
    this.delayMs = opts.delayMs ?? 100;
    this.retryMs = opts.retryMs ?? 1000;
    this.maxRetryMs = opts.maxRetryMs ?? 60_000;
    this.compactRetryMs = opts.compactRetryMs ?? 60_000;
    this.maxCompactRetryMs = opts.maxCompactRetryMs ?? 3_600_000;
    this.off = this.registry.onRegistered((values) => {
      for (const v of values) this.pending.add(v);
      this.schedule();
    });
    // A clean-up left unfinished before a restart (the checkpoint was blocked): resumed.
    const sql = this.db.$client;
    if (readKey(sql, CLEANUP_PENDING_KEY)) this.dirty = true;
    // A compaction still to do: right away when it never ran here; after the backoff when it just failed (the
    // start-up attempt, compact.ts).
    if (readKey(sql, COMPACTED_KEY) === "needed") {
      this.compactFailures = 1;
      this.nextCompactAt = Date.now() + this.compactRetryMs;
    }
    if (this.dirty || compactionState(sql) !== "done") this.schedule();
  }

  /**
   * Rows were changed elsewhere (a file extracted again over its old text, files/extract.ts) and the marker is set:
   * a checkpoint soon, like after a pass of its own.
   */
  cleanup(): void {
    this.dirty = true;
    this.schedule();
  }

  /** Failed passes so far (tests, the admin's health view). */
  failed(): number {
    return this.failures;
  }

  /**
   * Starts a pass soon, for the values not yet looked for — or, with `all`, for every registered value (startup).
   */
  schedule(opts: { all?: boolean } = {}, delay = this.delayMs): void {
    if (this.closed) return;
    if (opts.all) for (const v of this.registry.list()) this.pending.add(v);
    if (this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.run();
    }, delay);
    this.timer.unref();
  }

  private async run(): Promise<void> {
    let retry = false;
    let compactDelay: number | undefined;
    // Always yield first: `schedule` stores this promise as `running` after the call returns. A run with nothing to
    // look for (a checkpoint retry) would otherwise finish synchronously and clear `running` before it was set —
    // leaving a settled promise that `idle()` would await forever (review #111 round 2).
    await tick();
    try {
      while (this.pending.size && !this.closed) {
        const values = [...this.pending];
        const look = new KnownSecrets();
        for (const v of values) look.add(v, { fresh: true });
        try {
          await this.pass(look);
          // Only now are these values done; ones registered meanwhile stay pending for the next round.
          for (const v of values) this.pending.delete(v);
          this.failures = 0;
        } catch (e) {
          this.failures++;
          logEvent(this.opts.log, "warn", "secrets.rescrub_failed", { errorCode: "rescrub_failed", err: e });
          retry = true;
          break;
        }
      }
      // The one-time compaction (compact.ts), while it is still `needed`: the `VACUUM` again, with its own backoff
      // (a full disk does not free itself in seconds); each failure is logged once. `idle()` waits meanwhile.
      if (!retry && !this.closed && this.compactionNeeded()) {
        const wait = this.nextCompactAt - Date.now();
        if (wait > 0) compactDelay = wait;
        else if (runVacuum(this.db, this.opts.log) === "vacuumed") {
          this.compactFailures = 0;
          this.dirty = true;
        } else {
          this.compactFailures++;
          compactDelay = Math.min(
            this.maxCompactRetryMs,
            this.compactRetryMs * 2 ** Math.min(16, this.compactFailures - 1),
          );
          this.nextCompactAt = Date.now() + compactDelay;
        }
      }
      // The scrubbed rows are clean; the files are once the WAL is checkpointed into the database (whose new pages
      // carry zeroed free space, `secure_delete`) and truncated. A reader holding an old snapshot blocks it: never
      // waited for (no stall, no wait on another process or the backup's lock), retried with backoff, and the pass
      // stays unfinished — `idle()` resolves only once the files are clean.
      if (!retry && this.dirty && !this.closed) {
        const r = this.checkpoint();
        if (r === "clean") this.dirty = false;
        else {
          this.failures++;
          if (r === "busy")
            logEvent(this.opts.log, "warn", "secrets.rescrub_checkpoint_busy", {
              errorCode: "rescrub_checkpoint_busy",
            });
          retry = true;
        }
      }
    } finally {
      this.running = undefined;
    }
    if (this.closed) return;
    const retryDelay = retry
      ? Math.min(this.maxRetryMs, this.retryMs * 2 ** Math.min(16, this.failures - 1))
      : undefined;
    const delays = [retryDelay, compactDelay].filter((d): d is number => d !== undefined);
    if (delays.length) this.schedule({}, Math.min(...delays));
    else if (this.pending.size || this.compactionNeeded()) this.schedule();
  }

  /**
   * The files made clean, without waiting for anyone: freed pages handed back (`incremental_vacuum`, when the file is
   * in incremental mode — see compact.ts; their space is zeroed by `secure_delete` either way), then
   * `wal_checkpoint(TRUNCATE)`, which copies the new pages over the old ones in the database file and empties the
   * WAL. Only after that succeeds is the persisted marker cleared. True when clean.
   */
  private checkpoint(): "clean" | "busy" | "failed" {
    const sql = this.db.$client;
    try {
      if (sql.pragma("auto_vacuum", { simple: true }) === 2) sql.pragma("incremental_vacuum");
      if (!truncateCheckpoint(this.db)) return "busy";
      // Settling the markers is a write too (round 6: a full disk can refuse it): inside the same handling — the
      // state stays pending and the loop tries again; it never escapes as an unhandled rejection.
      sql.transaction(() => {
        compactionCheckpointed(sql);
        sql.prepare("delete from settings where key = ?").run(CLEANUP_PENDING_KEY);
      })();
      return "clean";
    } catch (e) {
      logEvent(this.opts.log, "warn", "secrets.rescrub_cleanup_failed", {
        errorCode: "rescrub_failed",
        err: e,
      });
      return "failed";
    }
  }

  /** Whether the one-time compaction is still `needed` — and, when the state cannot even be read, yes (look again). */
  private compactionNeeded(): boolean {
    try {
      return compactionState(this.db.$client) === "needed";
    } catch {
      return true;
    }
  }

  /** Resolves once no pass is waiting, running or due for a retry (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running || this.timer) {
      if (this.running) await this.running;
      else await new Promise((r) => setTimeout(r, 5));
    }
  }

  /**
   * Extracted file text (#48): each file's units together, in document order (`scrubFile` — a line-wrapped
   * base64 across two units is one value), looked at with the new values only, recomputed with everything the
   * registry knows when one is found; texts, marks and the `approximate` flag change together.
   */
  private async rescrubFiles(look: KnownSecrets): Promise<void> {
    const sql = this.db.$client;
    let after = "";
    for (;;) {
      if (this.closed) return;
      const ids = sql
        .prepare(`select distinct file_id from file_segments where file_id > ? order by file_id limit ?`)
        .all(after, 50) as { file_id: string }[];
      if (!ids.length) return;
      for (const { file_id } of ids) {
        const rows = sql
          .prepare(
            `select seq, text, marks, approximate, cut, ends_early as endsEarly, locator from file_segments
             where file_id = ? order by seq`,
          )
          .all(file_id) as {
          seq: number;
          text: string;
          marks: string | null;
          approximate: number;
          cut: number;
          endsEarly: number;
          locator: string;
        }[];
        // A file with a unit cut for display is not scrubbed in place (the cut part is not there): it is extracted
        // again from its original bytes (`FileExtracts.reextractCut`, called when the secret was registered).
        if (rows.some((r) => r.cut)) continue;
        // A cut-off secret only where the extractor left text out (`ends_early`).
        const units = rows.map((r) => ({
          text: r.text,
          marks: parseMarks(r.marks),
          endsEarly: !!r.endsEarly,
        }));
        const locHit = rows.some((r) => scrubKnown(r.locator, { registry: look, tail: false }) !== r.locator);
        if (!locHit && scrubFile(units, look).every((u, i) => u.text === rows[i]!.text)) continue;
        const next = scrubFile(units, this.registry);
        let changed = false;
        sql.transaction(() => {
          rows.forEach((r, i) => {
            const n = next[i]!;
            const locator = rescrubValue(r.locator, "deep", this.registry);
            const marks = n.marks ? JSON.stringify(n.marks) : null;
            const approximate = r.approximate || n.approximate ? 1 : 0;
            if (
              n.text === r.text &&
              marks === r.marks &&
              approximate === r.approximate &&
              locator === r.locator
            )
              return;
            sql
              .prepare(
                `update file_segments set text = ?, marks = ?, approximate = ?, locator = ? where file_id = ? and seq = ?`,
              )
              .run(n.text, marks, approximate, locator, file_id, r.seq);
            changed = true;
          });
          // The viewer's check hashes over the old text go with it (#24, review #123 2차).
          if (changed) forgetCitedTextHashes(sql, file_id);
          // Like every masked row (review #111): the old text may still be in WAL frames and old pages until a
          // TRUNCATE checkpoint — recorded in the same transaction, so a restart resumes the clean-up.
          if (changed) markPending(sql);
        })();
        if (changed) this.dirty = true;
      }
      after = ids.at(-1)!.file_id;
      await tick();
    }
  }

  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.off();
  }

  /**
   * One pass: a row is looked at with the new values only (`look`, cheap: most rows are untouched and never
   * parsed); a row with a hit is scrubbed with everything the registry knows. Any failure throws (retried).
   */
  private async pass(look: KnownSecrets): Promise<void> {
    if (!look.matcher()) return;
    const hit = (text: string) => scrubKnown(text, { registry: look, tail: false }) !== text;
    const sql = this.db.$client;
    for (const t of RESCRUB_TABLES) {
      // A parts column is also looked at as its text parts joined, and its reasoning parts joined (round 27: a
      // secret split around a tool call is in neither part on its own) — computed in SQL, nothing parsed here.
      const joinedOf = (col: string, type: string) =>
        `(select group_concat(json_extract(j.value, '$.text'), '') from json_each("${col}") as j
          where json_extract(j.value, '$.type') = '${type}') as "_j_${type}_${col}"`;
      const cols = t.columns
        .flatMap((c) =>
          c.kind === "parts"
            ? [`"${c.name}"`, joinedOf(c.name, "text"), joinedOf(c.name, "reasoning")]
            : [`"${c.name}"`],
        )
        .join(", ");
      let after = 0;
      for (;;) {
        if (this.closed) return;
        const rows = sql
          .prepare(`select rowid as _rowid, ${cols} from "${t.table}" where rowid > ? order by rowid limit ?`)
          .all(after, CHUNK) as Record<string, unknown>[];
        if (!rows.length) break;
        const changes: { rowid: number; set: Record<string, unknown> }[] = [];
        const removals: number[] = [];
        for (const row of rows) {
          const set: Record<string, unknown> = {};
          for (const c of t.columns) {
            const v = row[c.name];
            if (typeof v !== "string") continue;
            const joined = [row[`_j_text_${c.name}`], row[`_j_reasoning_${c.name}`]];
            if (!hit(v) && !joined.some((j) => typeof j === "string" && hit(j))) continue;
            const next = rescrubValue(v, c.kind, this.registry);
            if (next !== v) set[c.name] = next;
          }
          if (t.removeOn?.some((c) => c in set)) removals.push(row._rowid as number);
          else if (Object.keys(set).length)
            changes.push({
              rowid: row._rowid as number,
              set: { ...set, ...(t.derived?.({ ...row, ...set }) ?? {}) },
            });
        }
        if (removals.length) {
          // The connection runs with `secure_delete` (db/client.ts): the freed cells are zeroed.
          sql.transaction(() => {
            for (const rowid of removals) sql.prepare(`delete from "${t.table}" where rowid = ?`).run(rowid);
            markPending(sql);
          })();
          this.dirty = true;
        }
        if (changes.length) this.dirty = true;
        if (changes.length)
          sql.transaction(() => {
            // Versions are immutable (a trigger refuses updates): the one exception is this scrub — the trigger
            // is lifted and put back inside the same transaction (a failure rolls both back, and is retried).
            const triggers = t.immutable
              ? (sql
                  .prepare(
                    "select sql from sqlite_master where type = 'trigger' and tbl_name = ? and name = ?",
                  )
                  .all(t.table, t.immutable) as { sql: string }[])
              : [];
            if (triggers.length) sql.exec(`drop trigger "${t.immutable}"`);
            for (const { rowid, set } of changes) {
              const names = Object.keys(set);
              sql
                .prepare(
                  `update "${t.table}" set ${names.map((n) => `"${n}" = ?`).join(", ")} where rowid = ?`,
                )
                .run(...names.map((n) => set[n] as string | number), rowid);
            }
            for (const tr of triggers) sql.exec(tr.sql);
            markPending(sql);
          })();
        after = rows.at(-1)!._rowid as number;
        await tick();
      }
    }
    await this.rescrubFiles(look);
    // Run events: each run as one stream (a secret split across deltas is found too). Looked at without parsing:
    // the raw rows, and the delta texts joined in SQL.
    let afterRun = "";
    for (;;) {
      if (this.closed) return;
      const ids = sql
        .prepare(`select distinct run_id from run_events where run_id > ? order by run_id limit ?`)
        .all(afterRun, 50) as { run_id: string }[];
      if (!ids.length) break;
      for (const { run_id } of ids) {
        const rows = sql
          .prepare(`select seq, data from run_events where run_id = ? order by seq`)
          .all(run_id) as { seq: number; data: string }[];
        const joined = (
          sql
            .prepare(
              `select group_concat(t, '') as j from (select json_extract(data, '$.text') as t from run_events
               where run_id = ? and json_extract(data, '$.type') = 'delta' order by seq)`,
            )
            .get(run_id) as { j: string | null }
        ).j;
        if (!hit(rows.map((r) => r.data).join("\n")) && !(joined && hit(joined))) continue;
        const events = rows.map((e) => ({ seq: e.seq, raw: e.data, data: JSON.parse(e.data) as unknown }));
        const scrubbed = scrubEventSequence(events, this.registry);
        this.dirty = true;
        sql.transaction(() => {
          markPending(sql);
          for (const e of scrubbed) {
            const next = JSON.stringify(e.data);
            if (next !== e.raw)
              sql
                .prepare(`update run_events set data = ? where run_id = ? and seq = ?`)
                .run(next, run_id, e.seq);
          }
        })();
      }
      afterRun = ids.at(-1)!.run_id;
      await tick();
    }
  }
}
