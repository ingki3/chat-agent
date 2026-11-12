import crypto from "node:crypto";
import { snippetKey } from "../citations/store.js";
import type { Db } from "../db/client.js";
import { logEvent, type EventLogger } from "../logging.js";
import { TEXT_COLUMNS, type RescrubKind } from "./columns.js";
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
};

const sha256 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

const DERIVED: Record<string, Pick<Table, "immutable" | "derived">> = {
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

/** The tables and columns to rescrub, from `TEXT_COLUMNS` (`run_events` is handled per run, as a stream). */
export const RESCRUB_TABLES: readonly Table[] = (() => {
  const byTable = new Map<string, Column[]>();
  for (const [key, rule] of Object.entries(TEXT_COLUMNS)) {
    if (!("rescrub" in rule)) continue;
    const [table, name] = key.split(".") as [string, string];
    if (table === "run_events") continue;
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
  log?: EventLogger;
};

export class StoredRescrub {
  private running: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  /** Values not yet looked for in the stored rows: a pass looks for these only (the rest were looked for before). */
  private pending = new Set<string>();
  private failures = 0;
  private readonly off: () => void;
  private readonly registry: KnownSecrets;
  private readonly delayMs: number;
  private readonly retryMs: number;
  private readonly maxRetryMs: number;

  constructor(
    private readonly db: Db,
    private readonly opts: RescrubOptions = {},
  ) {
    this.registry = opts.registry ?? knownSecrets;
    this.delayMs = opts.delayMs ?? 100;
    this.retryMs = opts.retryMs ?? 1000;
    this.maxRetryMs = opts.maxRetryMs ?? 60_000;
    this.off = this.registry.onRegistered((values) => {
      for (const v of values) this.pending.add(v);
      this.schedule();
    });
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
    } finally {
      this.running = undefined;
    }
    if (retry && !this.closed)
      this.schedule({}, Math.min(this.maxRetryMs, this.retryMs * 2 ** Math.min(16, this.failures - 1)));
    else if (this.pending.size && !this.closed) this.schedule();
  }

  /** Resolves once no pass is waiting, running or due for a retry (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running || this.timer) {
      if (this.running) await this.running;
      else await new Promise((r) => setTimeout(r, 5));
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
          if (Object.keys(set).length)
            changes.push({
              rowid: row._rowid as number,
              set: { ...set, ...(t.derived?.({ ...row, ...set }) ?? {}) },
            });
        }
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
          })();
        after = rows.at(-1)!._rowid as number;
        await tick();
      }
    }
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
        sql.transaction(() => {
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
