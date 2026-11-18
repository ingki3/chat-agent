import {
  DREAMING_DEFAULT_TIME,
  DREAMING_TOKEN_CAP,
  DreamingConfig,
  RuntimeId,
  type DreamingSettings,
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
 * 기억 정리 storage (#146, #188, docs/memory-spec.md §5–§10): the admin's server-wide settings (switch, token cap,
 * allowed connections·models), the default prompt (the admin's last version of #146), each user's own settings
 * (switch, time, connection·model, prompt), checkpoint and pause, the day's rounds, the run records (`DREAMS.md` —
 * counts only) and the re-processing queue.
 */

export const CONFIG_KEY = "dreaming.config";
export const DEFAULT_CONFIG: DreamingConfig = {
  enabled: true,
  tokenCap: DREAMING_TOKEN_CAP.default,
  allowed: [],
};

/**
 * The editable part's built-in version (the default until an admin saved one under #146; each user may write their
 * own since #188 — the fixed rules around it are in prompt.ts). Kept short: what to pick and how to write it.
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
  time: string;
  runtime: string | null;
  connection_id: string | null;
  model: string | null;
  prompt: string | null;
  prompt_updated_at: number | null;
  /** The settings' revision (+1 on every settings write). */
  rev: number;
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

  /** The admin settings' revision (#188 review 9): +1 on every save, kept in the same setting. */
  configRev(): number {
    try {
      const rev = (JSON.parse(this.settings.get(CONFIG_KEY) ?? "{}") as { rev?: unknown }).rev;
      return typeof rev === "number" && Number.isInteger(rev) ? rev : 0;
    } catch {
      return 0;
    }
  }

  setConfig(c: DreamingConfig): void {
    const before = this.config();
    this.sql.transaction(() => {
      this.settings.set(CONFIG_KEY, JSON.stringify({ ...c, rev: this.configRev() + 1 }));
    })();
    // Turned off: every user's rounds pause (spec §6 — when they resume, a backlog older than 7 days is passed over).
    if (before.enabled && !c.enabled)
      this.sql
        .prepare("update dreaming_users set paused_at = ?, updated_at = ? where paused_at is null")
        .run(this.now(), this.now());
  }

  /** Whether a connection·model pair is one the admin allows. */
  allows(c: { runtime: string | null; connectionId: string | null; model: string | null }): boolean {
    return this.config().allowed.some(
      (a) => a.runtime === c.runtime && a.connectionId === c.connectionId && a.model === c.model,
    );
  }

  // ---- the default prompt: the admin's last version of #146 (FR-16.6), or the built-in one ----

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

  /**
   * The prompt a user's run uses: their own, or the default (`version` = the default's — null for their own, so a run
   * record says which one it was).
   */
  promptOf(userId: string): {
    content: string;
    custom: boolean;
    version: number | null;
    updatedAt: number | null;
  } {
    const st = this.state(userId);
    if (st.prompt !== null)
      return { content: scrubKnown(st.prompt), custom: true, version: null, updatedAt: st.prompt_updated_at };
    const d = this.prompt();
    return { content: d.content, custom: false, version: d.version, updatedAt: d.createdAt };
  }

  /** The user's own prompt; null (or the default's very text) goes back to the default. */
  setPrompt(userId: string, content: string | null): void {
    this.ensureState(userId);
    const v = content === null || content.trim() === this.prompt().content.trim() ? null : content.trim();
    this.sql
      .prepare(
        "update dreaming_users set prompt = ?, prompt_updated_at = ?, updated_at = ?, rev = rev + 1 where user_id = ?",
      )
      .run(v === null ? null : scrubKnown(v), v === null ? null : this.now(), this.now(), userId);
  }

  // ---- per user ----

  state(userId: string): UserState {
    const r = this.sql.prepare("select * from dreaming_users where user_id = ?").get(userId) as
      UserState | undefined;
    return (
      r ?? {
        user_id: userId,
        enabled: 0,
        time: DREAMING_DEFAULT_TIME,
        runtime: null,
        connection_id: null,
        model: null,
        prompt: null,
        prompt_updated_at: null,
        rev: 0,
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
        "insert or ignore into dreaming_users (user_id, enabled, time, checkpoint, updated_at) values (?, 0, ?, 0, ?)",
      )
      .run(userId, DREAMING_DEFAULT_TIME, this.now());
  }

  /** The user's own settings (no row: off, the default time, nothing chosen). */
  settingsOf(userId: string): DreamingSettings {
    const st = this.state(userId);
    const runtime = RuntimeId.safeParse(st.runtime);
    return {
      enabled: st.enabled === 1,
      time: st.time,
      runtime: runtime.success ? runtime.data : null,
      connectionId: st.connection_id,
      model: st.model,
    };
  }

  /**
   * Saves the user's settings (validated by the caller); turned off → paused like before (spec §9). A new time drops
   * the user's round that has not started yet (waiting, no attempt, never deferred) so the schedule plans it again at
   * the new time (#188 review 1); a round that ran, runs or waits for a retry or a busy answer stays — nothing twice.
   */
  setSettings(userId: string, s: DreamingSettings): void {
    this.ensureState(userId);
    const before = this.state(userId).time;
    this.sql.transaction(() => {
      if (before !== s.time)
        this.sql
          .prepare(
            "delete from dreaming_days where user_id = ? and state = 'waiting' and attempts = 0 and deferrals = 0",
          )
          .run(userId);
      // One write, one revision (+1 per save); turned off → paused like setEnabled.
      this.sql
        .prepare(
          `update dreaming_users set enabled = ?, time = ?, runtime = ?, connection_id = ?, model = ?, updated_at = ?,
             rev = rev + 1, paused_at = case when ? = 0 and paused_at is null then ? else paused_at end
           where user_id = ?`,
        )
        .run(
          s.enabled ? 1 : 0,
          s.time,
          s.runtime,
          s.connectionId,
          s.model,
          this.now(),
          s.enabled ? 1 : 0,
          this.now(),
          userId,
        );
    })();
  }

  setEnabled(userId: string, enabled: boolean): void {
    this.ensureState(userId);
    this.sql
      .prepare(
        `update dreaming_users set enabled = ?, updated_at = ?, rev = rev + 1,
           paused_at = case when ? = 0 and paused_at is null then ? else paused_at end where user_id = ?`,
      )
      .run(enabled ? 1 : 0, this.now(), enabled ? 1 : 0, this.now(), userId);
  }

  /**
   * Whether the rounds run for the user right now: the admin's server-wide switch, the user's own switch, and an
   * active account (spec §7·§9). Asked before an attempt starts and again right before its outcome is written.
   */
  switchedOn(userId: string): boolean {
    if (!this.config().enabled) return false;
    const r = this.sql
      .prepare(
        `select u.active as active, coalesce(d.enabled, 0) as enabled
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

  /** The earliest waiting round due after `after` (one already due but not started is not a reason to wake). */
  nextWaiting(after: number): number | null {
    const r = this.sql
      .prepare("select min(next_at) as t from dreaming_days where state = 'waiting' and next_at > ?")
      .get(after) as { t: number | null };
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

  /** The user's last attempt of `date` (not a preview). */
  lastRunOn(userId: string, date: string): RunRow | undefined {
    return this.sql
      .prepare(
        "select * from dreaming_runs where user_id = ? and date = ? and trigger != 'preview' order by started_at desc, attempt desc limit 1",
      )
      .get(userId, date) as RunRow | undefined;
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
