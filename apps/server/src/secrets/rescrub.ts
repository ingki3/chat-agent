import crypto from "node:crypto";
import type { Db } from "../db/client.js";
import { KnownSecrets, knownSecrets, scrubEventSequence, scrubKnown, scrubKnownDeep } from "./known.js";

/**
 * Background rescrub of stored rows (review round 25): when a secret that may already be stored is registered (a
 * connection key, a `.env` value at startup, a session after a restart), every table that holds user or runtime
 * content is scrubbed again, in small chunks with a yield to the event loop between them, so a value stored before
 * anyone knew it was a secret does not stay in the database. Reads and responses are scrubbed as well (defence in
 * depth); this makes the rows themselves clean.
 */

type Column = { name: string; json?: boolean };
type Table = {
  table: string;
  columns: Column[];
  /** A trigger that makes the rows immutable (lifted for the scrub only, inside its transaction). */
  immutable?: string;
  /** Columns recomputed from the scrubbed ones (content hashes). */
  derived?: (row: Record<string, unknown>) => Record<string, unknown>;
};

const sha256 = (s: string) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

/** Every table with user or runtime text, and its text columns. `run_events` is handled per run (a stream). */
export const RESCRUB_TABLES: readonly Table[] = [
  { table: "conversations", columns: [{ name: "title" }] },
  { table: "messages", columns: [{ name: "parts", json: true }, { name: "search_text" }] },
  { table: "notifications", columns: [{ name: "title" }, { name: "body" }, { name: "url" }] },
  {
    table: "sources",
    columns: ["url", "final_url", "title", "site", "body", "snippet"].map((name) => ({ name })),
    derived: (r) => (typeof r.body === "string" ? { body_hash: sha256(r.body) } : {}),
  },
  { table: "artifacts", columns: [{ name: "title" }] },
  {
    table: "artifact_versions",
    columns: [{ name: "title" }, { name: "content" }],
    immutable: "artifact_versions_immutable",
    derived: (r) => (typeof r.content === "string" ? { content_hash: sha256(r.content) } : {}),
  },
  { table: "finance_results", columns: [{ name: "evidence", json: true }] },
  { table: "connections", columns: [{ name: "label" }] },
];

const CHUNK = 200;
const tick = () => new Promise<void>((r) => setImmediate(r));

export class StoredRescrub {
  private running: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private closed = false;
  /** Values registered since the last pass began: a pass looks for these only (the rest were looked for before). */
  private pending = new Set<string>();
  private readonly off: () => void;

  constructor(
    private readonly db: Db,
    private readonly registry: KnownSecrets = knownSecrets,
    private readonly delayMs = 100,
  ) {
    this.off = registry.onRegistered((values) => {
      for (const v of values) this.pending.add(v);
      this.schedule();
    });
  }

  /**
   * Starts a pass soon (registrations in a burst share one), for the values registered since the last one — or,
   * with `all`, for every registered value (at startup).
   */
  schedule(opts: { all?: boolean } = {}): void {
    if (this.closed) return;
    if (opts.all) for (const v of this.registry.list()) this.pending.add(v);
    if (this.running || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = (async () => {
        try {
          while (this.pending.size && !this.closed) {
            const look = new KnownSecrets();
            for (const v of this.pending) look.add(v, { fresh: true });
            this.pending = new Set();
            await this.pass(look);
          }
        } catch {
          // a failed pass leaves reads and responses scrubbed; the next registration tries again
        } finally {
          this.running = undefined;
        }
      })();
    }, this.delayMs);
    this.timer.unref();
  }

  /** Resolves once no pass is waiting or running (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running || this.timer) {
      if (this.running) await this.running;
      else await new Promise((r) => setTimeout(r, this.delayMs));
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
   * parsed); a row with a hit is scrubbed with everything the registry knows.
   */
  private async pass(look: KnownSecrets): Promise<void> {
    if (!look.matcher()) return;
    const hit = (text: string) => scrubKnown(text, { registry: look, tail: false }) !== text;
    const sql = this.db.$client;
    for (const t of RESCRUB_TABLES) {
      const cols = t.columns.map((c) => `"${c.name}"`).join(", ");
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
            if (typeof v !== "string" || !hit(v)) continue;
            let next: string;
            if (c.json) {
              try {
                next = JSON.stringify(scrubKnownDeep(JSON.parse(v) as unknown, { registry: this.registry }));
              } catch {
                next = scrubKnown(v, { registry: this.registry });
              }
            } else next = scrubKnown(v, { registry: this.registry });
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
            // is lifted and put back inside the same transaction, so nothing else can slip in.
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
                .run(...names.map((n) => set[n] as string), rowid);
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
