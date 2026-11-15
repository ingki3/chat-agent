import {
  DREAMING_TOKEN_CAP,
  DreamingConfig,
  type DreamingCounts,
  type DreamingRunStatus,
  type DreamingTrigger,
  type DreamsRecord,
  type MemoryListKind,
} from "@agentlee/shared";
import type { Db } from "../db/client.js";
import type { SettingsStore } from "../db/settings-store.js";
import { scrubKnown } from "../secrets/known.js";

/**
 * 기억 정리 storage (#146, docs/memory-spec.md §5–§10): the admin's settings and prompt versions, each user's switch,
 * checkpoint and pause, the day's rounds, the run records (`DREAMS.md` — counts only) and the re-processing queue.
 */

export const CONFIG_KEY = "dreaming.config";
export const DEFAULT_CONFIG: DreamingConfig = {
  enabled: false,
  time: "03:00",
  connectionId: null,
  runtime: null,
  model: null,
  tokenCap: DREAMING_TOKEN_CAP.default,
};

/**
 * The editable part's first version (the admin may rewrite it; the fixed rules around it are in prompt.ts). Kept
 * short: what to pick and how to write it.
 */
export const DEFAULT_PROMPT = [
  "오늘 사용자가 한 말에서 다음 대화에도 도움이 될 것만 골라 정리하세요.",
  "- USER.md: 사용자에 대한 정보와 답변 선호(말투·형식·관심 주제·호칭).",
  "- MEMORY.md: 오래 기억할 사실·결정·진행 중인 일.",
  "- 이미 있는 항목과 같은 내용은 더하지 마세요. 바뀐 사실은 고치고(replace), 겹치는 항목은 합치세요(merge).",
  "- 그날 한 번뿐인 일, 잡담, 질문 자체는 남기지 마세요.",
  "- 항목은 짧은 한 줄로, 사용자 말투가 아니라 사실로 적으세요.",
].join("\n");

export type UserState = {
  user_id: string;
  enabled: number;
  checkpoint: number;
  checkpoint_at: number | null;
  paused_at: number | null;
  updated_at: number;
};
export type DayRow = {
  user_id: string;
  date: string;
  state: "waiting" | "running" | "done" | "failed" | "skipped" | "missed" | "expired" | "paused";
  trigger: "regular" | "catchup" | "manual";
  scheduled_at: number;
  next_at: number;
  deferrals: number;
  attempts: number;
  updated_at: number;
};
export type RunRow = {
  id: string;
  user_id: string;
  date: string;
  attempt: number;
  idem_key: string;
  trigger: DreamingTrigger;
  status: DreamingRunStatus;
  code: string | null;
  counts: string;
  runtime: string | null;
  model: string | null;
  connection_id: string | null;
  prompt_version: number | null;
  started_at: number;
  finished_at: number | null;
};

export const emptyCounts = (): DreamingCounts => ({
  newMessages: 0,
  queuedMessages: 0,
  decisions: 0,
  proposed: 0,
  applied: 0,
  refused: {},
  skippedOld: false,
  cut: false,
});

export class DreamingStore {
  constructor(
    private readonly db: Db,
    private readonly settings: Pick<SettingsStore, "get" | "set">,
    private readonly now: () => number = Date.now,
  ) {}

  private get sql() {
    return this.db.$client;
  }

  // ---- the admin's settings (system settings: they outlive an admin change, spec §7) ----

  config(): DreamingConfig {
    const raw = this.settings.get(CONFIG_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    try {
      const r = DreamingConfig.safeParse({ ...DEFAULT_CONFIG, ...(JSON.parse(raw) as object) });
      return r.success ? r.data : { ...DEFAULT_CONFIG };
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  }

  setConfig(c: DreamingConfig): void {
    const before = this.config();
    this.settings.set(CONFIG_KEY, JSON.stringify(c));
    // Turned off: every user's rounds pause (spec §6 — when they resume, a backlog older than 7 days is passed over).
    if (before.enabled && !c.enabled)
      this.sql
        .prepare("update dreaming_users set paused_at = ?, updated_at = ? where paused_at is null")
        .run(this.now(), this.now());
  }

  // ---- the prompt's versions (FR-16.6) ----

  prompt(): { version: number; content: string; createdAt: number | null } {
    const r = this.sql
      .prepare(
        "select version, content, created_at as createdAt from dreaming_prompts order by version desc limit 1",
      )
      .get() as { version: number; content: string; createdAt: number } | undefined;
    return r
      ? { ...r, content: scrubKnown(r.content) }
      : { version: 0, content: DEFAULT_PROMPT, createdAt: null };
  }

  promptVersions(): { version: number; content: string; restoredFrom: number | null; createdAt: number }[] {
    return (
      this.sql
        .prepare(
          "select version, content, restored_from as restoredFrom, created_at as createdAt from dreaming_prompts order by version desc",
        )
        .all() as { version: number; content: string; restoredFrom: number | null; createdAt: number }[]
    ).map((v) => ({ ...v, content: scrubKnown(v.content) }));
  }

  /** Saves a new version on top of `base` (refused — false — when another one was saved meanwhile). */
  savePrompt(content: string, base: number, authorId: string, restoredFrom: number | null = null): boolean {
    return this.sql
      .transaction(() => {
        const cur = this.prompt().version;
        if (cur !== base) return false;
        if (cur > 0 && this.prompt().content === content) return true;
        this.sql
          .prepare(
            "insert into dreaming_prompts (version, content, author_id, restored_from, created_at) values (?, ?, ?, ?, ?)",
          )
          .run(cur + 1, scrubKnown(content), authorId, restoredFrom, this.now());
        return true;
      })
      .immediate();
  }

  // ---- per user ----

  state(userId: string): UserState {
    const r = this.sql.prepare("select * from dreaming_users where user_id = ?").get(userId) as
      UserState | undefined;
    return (
      r ?? {
        user_id: userId,
        enabled: 1,
        checkpoint: 0,
        checkpoint_at: null,
        paused_at: null,
        updated_at: 0,
      }
    );
  }

  private ensureState(userId: string): void {
    this.sql
      .prepare(
        "insert or ignore into dreaming_users (user_id, enabled, checkpoint, updated_at) values (?, 1, 0, ?)",
      )
      .run(userId, this.now());
  }

  setEnabled(userId: string, enabled: boolean): void {
    this.ensureState(userId);
    this.sql
      .prepare(
        `update dreaming_users set enabled = ?, updated_at = ?,
           paused_at = case when ? = 0 and paused_at is null then ? else paused_at end where user_id = ?`,
      )
      .run(enabled ? 1 : 0, this.now(), enabled ? 1 : 0, this.now(), userId);
  }

  /**
   * Whether the rounds run for the user right now: the admin's switch for everyone and for this user, and an active
   * account (spec §7·§9). Asked before an attempt starts and again right before its outcome is written.
   */
  switchedOn(userId: string): boolean {
    if (!this.config().enabled) return false;
    const r = this.sql
      .prepare(
        `select u.active as active, coalesce(d.enabled, 1) as enabled
           from users u left join dreaming_users d on d.user_id = u.id where u.id = ?`,
      )
      .get(userId) as { active: number; enabled: number } | undefined;
    return !!r && r.active === 1 && r.enabled === 1;
  }

  /** Turned off for everyone: the day's waiting rounds (a retry, a busy wait) are paused, not run later. */
  pauseWaiting(): number {
    return this.sql
      .prepare("update dreaming_days set state = 'paused', updated_at = ? where state = 'waiting'")
      .run(this.now()).changes;
  }

  /** The user's rounds stopped (deactivated, turned off): noted once, until the next run resumes them (spec §9). */
  markPaused(userId: string): void {
    this.ensureState(userId);
    this.sql
      .prepare(
        "update dreaming_users set paused_at = ?, updated_at = ? where user_id = ? and paused_at is null",
      )
      .run(this.now(), this.now(), userId);
  }

  /** Moves the checkpoint forward only — it never decreases (spec §6). In the caller's transaction. */
  advance(userId: string, to: number, resumed: boolean): void {
    this.ensureState(userId);
    this.sql
      .prepare(
        `update dreaming_users set checkpoint = max(checkpoint, ?), checkpoint_at = ?, updated_at = ?,
           paused_at = case when ? then null else paused_at end where user_id = ?`,
      )
      .run(to, this.now(), this.now(), resumed ? 1 : 0, userId);
  }

  // ---- the day's rounds ----

  day(userId: string, date: string): DayRow | undefined {
    return this.sql
      .prepare("select * from dreaming_days where user_id = ? and date = ?")
      .get(userId, date) as DayRow | undefined;
  }

  days(date: string): DayRow[] {
    return this.sql.prepare("select * from dreaming_days where date = ?").all(date) as DayRow[];
  }

  insertDay(row: Omit<DayRow, "updated_at" | "deferrals" | "attempts">): boolean {
    return (
      this.sql
        .prepare(
          `insert or ignore into dreaming_days (user_id, date, state, trigger, scheduled_at, next_at, deferrals,
             attempts, updated_at) values (?, ?, ?, ?, ?, ?, 0, 0, ?)`,
        )
        .run(row.user_id, row.date, row.state, row.trigger, row.scheduled_at, row.next_at, this.now())
        .changes > 0
    );
  }

  updateDay(
    userId: string,
    date: string,
    patch: Partial<Pick<DayRow, "state" | "next_at" | "deferrals" | "attempts">>,
    expect?: DayRow["state"],
  ): boolean {
    const cols = Object.keys(patch);
    if (!cols.length) return false;
    const set = cols.map((c) => `${c} = @${c}`).join(", ");
    return (
      this.sql
        .prepare(
          `update dreaming_days set ${set}, updated_at = @t where user_id = @u and date = @d${expect ? " and state = @e" : ""}`,
        )
        .run({ ...patch, t: this.now(), u: userId, d: date, ...(expect ? { e: expect } : {}) }).changes > 0
    );
  }

  /** Waiting rounds that are due. */
  dueDays(now: number): DayRow[] {
    return this.sql
      .prepare(
        "select * from dreaming_days where state = 'waiting' and next_at <= ? order by next_at, user_id",
      )
      .all(now) as DayRow[];
  }

  nextWaiting(): number | null {
    const r = this.sql
      .prepare("select min(next_at) as t from dreaming_days where state = 'waiting'")
      .get() as {
      t: number | null;
    };
    return r.t;
  }

  /** Rounds of an earlier date still waiting: past midnight that day has no round any more (spec §6). */
  expireBefore(date: string): number {
    return this.sql
      .prepare(
        "update dreaming_days set state = 'expired', updated_at = ? where state = 'waiting' and date < ?",
      )
      .run(this.now(), date).changes;
  }

  // ---- run records (DREAMS.md) ----

  /** Claims an attempt (the idempotency key is unique): false when it exists already — never run twice. */
  claimRun(row: Omit<RunRow, "finished_at" | "counts" | "status" | "code">): boolean {
    return (
      this.sql
        .prepare(
          `insert or ignore into dreaming_runs (id, user_id, date, attempt, idem_key, trigger, status, code, counts,
             runtime, model, connection_id, prompt_version, started_at, finished_at)
           values (?, ?, ?, ?, ?, ?, 'running', null, ?, ?, ?, ?, ?, ?, null)`,
        )
        .run(
          row.id,
          row.user_id,
          row.date,
          row.attempt,
          row.idem_key,
          row.trigger,
          JSON.stringify(emptyCounts()),
          row.runtime,
          row.model,
          row.connection_id,
          row.prompt_version,
          row.started_at,
        ).changes > 0
    );
  }

  /**
   * Records an attempt's outcome — only while it is still running (a run a restart already marked failed records
   * nothing, and the caller's transaction is undone). In the caller's transaction.
   */
  finishRun(id: string, status: DreamingRunStatus, code: string | null, counts: DreamingCounts): boolean {
    return (
      this.sql
        .prepare(
          `update dreaming_runs set status = ?, code = ?, counts = ?, finished_at = ? where id = ? and status = 'running'`,
        )
        .run(status, code, JSON.stringify(counts), this.now(), id).changes > 0
    );
  }

  run(id: string): RunRow | undefined {
    return this.sql.prepare("select * from dreaming_runs where id = ?").get(id) as RunRow | undefined;
  }

  runsOf(userId: string, limit = 30): DreamsRecord[] {
    return (
      this.sql
        .prepare(
          "select * from dreaming_runs where user_id = ? order by started_at desc, attempt desc limit ?",
        )
        .all(userId, limit) as RunRow[]
    ).map(recordOf);
  }

  lastRun(userId: string): RunRow | undefined {
    return this.sql
      .prepare(
        "select * from dreaming_runs where user_id = ? and trigger != 'preview' order by started_at desc, attempt desc limit 1",
      )
      .get(userId) as RunRow | undefined;
  }

  /** How many manual runs the user had on `date` (their idempotency keys count on). */
  manualCount(userId: string, date: string): number {
    return (
      this.sql
        .prepare(
          "select count(*) as n from dreaming_runs where user_id = ? and date = ? and trigger = 'manual'",
        )
        .get(userId, date) as { n: number }
    ).n;
  }

  /**
   * Start-up (spec §6 중복 방지): attempts a previous process left running never finish — they are failed
   * (`interrupted`), and their rounds wait for the retry (or fail, after the last attempt).
   */
  recover(retryAt: number, maxAttempts: number): { runs: number } {
    return this.sql
      .transaction(() => {
        const runs = this.sql
          .prepare(
            `update dreaming_runs set status = 'failed', code = 'interrupted', finished_at = ? where status = 'running'`,
          )
          .run(this.now()).changes;
        this.sql
          .prepare(
            `update dreaming_days set state = case when attempts < ? then 'waiting' else 'failed' end,
               next_at = ?, updated_at = ? where state = 'running'`,
          )
          .run(maxAttempts, retryAt, this.now());
        return { runs };
      })
      .immediate();
  }

  // ---- the re-processing queue (spec §5·§6) ----

  enqueue(userId: string, messageId: string, doc: MemoryListKind): void {
    this.sql
      .prepare(
        `insert or ignore into dreaming_queue (user_id, message_id, doc, added_at)
           select ?, id, ?, ? from messages where id = ? and active = 1`,
      )
      .run(userId, doc, this.now(), messageId);
  }

  dequeue(userId: string, messageId: string, doc: MemoryListKind): void {
    this.sql
      .prepare("delete from dreaming_queue where user_id = ? and message_id = ? and doc = ?")
      .run(userId, messageId, doc);
  }

  queueSize(userId: string): number {
    return (
      this.sql.prepare("select count(*) as n from dreaming_queue where user_id = ?").get(userId) as {
        n: number;
      }
    ).n;
  }

  /** Deletion linkage (spec §10.3): queue entries of messages that left the active history. */
  dropQueued(messageIds: readonly string[]): number {
    if (!messageIds.length) return 0;
    return this.sql
      .prepare("delete from dreaming_queue where message_id in (select value from json_each(?))")
      .run(JSON.stringify(messageIds)).changes;
  }
}

export function recordOf(r: RunRow): DreamsRecord {
  return {
    id: r.id,
    date: r.date,
    trigger: r.trigger,
    status: r.status,
    code: r.code,
    counts: { ...emptyCounts(), ...(JSON.parse(r.counts) as Partial<DreamingCounts>) },
    startedAt: r.started_at,
    finishedAt: r.finished_at,
  };
}
