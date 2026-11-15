import crypto from "node:crypto";
import { ScheduleTiming, type ScheduleProposalStatus } from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { scrubKnown } from "../secrets/known.js";

export type ProposalRow = {
  id: string;
  owner_id: string;
  conversation_id: string;
  run_id: string;
  name: string;
  prompt: string;
  timing: string;
  time_zone: string;
  skills: string;
  notify: number;
  status: ScheduleProposalStatus;
  schedule_id: string | null;
  created_at: number;
  updated_at: number;
};

export type NewProposal = {
  name: string;
  prompt: string;
  timing: ScheduleTiming;
  timeZone: string;
  skills: string[];
  notify: boolean;
};

/** The stored timing, parsed again (it was validated on the way in; a broken row is no timing). */
export const proposalTiming = (r: ProposalRow): ScheduleTiming | undefined => {
  try {
    const t = ScheduleTiming.safeParse(JSON.parse(r.timing));
    return t.success ? t.data : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Schedules proposed by the `schedule_create` tool (#55, FR-8.1). A proposal is not a schedule: nothing runs from
 * it. Its owner confirms it (the card, their own session) once — `confirm` makes the `proposed` → `confirmed`
 * step and names the schedule — or dismisses it. Name and prompt are runtime text: scrubbed of known secrets.
 */
export class ScheduleProposalStore {
  constructor(private readonly db: Db) {}

  private get sql() {
    return this.db.$client;
  }

  create(scope: { userId: string; conversationId: string; runId: string }, p: NewProposal, at: number) {
    const id = crypto.randomUUID();
    this.sql
      .prepare(
        `insert into schedule_proposals (id, owner_id, conversation_id, run_id, name, prompt, timing, time_zone,
           skills, notify, status, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?)`,
      )
      .run(
        id,
        scope.userId,
        scope.conversationId,
        scope.runId,
        scrubKnown(p.name),
        scrubKnown(p.prompt),
        JSON.stringify(p.timing),
        p.timeZone,
        JSON.stringify(p.skills),
        p.notify ? 1 : 0,
        at,
        at,
      );
    return this.byId(id)!;
  }

  /** Whether the conversation is the user's own (the tool proposes only into its run's own conversation). */
  ownsConversation(scope: { userId: string; conversationId: string }): boolean {
    const c = this.sql
      .prepare(`select owner_id from conversations where id = ?`)
      .get(scope.conversationId) as { owner_id: string } | undefined;
    return c?.owner_id === scope.userId;
  }

  byId(id: string): ProposalRow | undefined {
    return this.sql.prepare(`select * from schedule_proposals where id = ?`).get(id) as
      ProposalRow | undefined;
  }

  /**
   * Runs `make` and records its schedule — only while the proposal is still `proposed` (one transaction: two
   * confirms never make two schedules). Returns the schedule id and whether this call made it.
   */
  confirm(
    id: string,
    make: (p: ProposalRow) => string,
    at: number,
  ): { scheduleId: string | null; made: boolean } {
    return this.sql.transaction(() => {
      const p = this.byId(id);
      if (!p || p.status !== "proposed") return { scheduleId: p?.schedule_id ?? null, made: false };
      const scheduleId = make(p);
      this.sql
        .prepare(
          `update schedule_proposals set status = 'confirmed', schedule_id = ?, updated_at = ?
           where id = ? and status = 'proposed'`,
        )
        .run(scheduleId, at, id);
      return { scheduleId, made: true };
    })();
  }

  /** `proposed` → `dismissed`; false when it was not proposed any more. */
  dismiss(id: string, at: number): boolean {
    return (
      this.sql
        .prepare(
          `update schedule_proposals set status = 'dismissed', updated_at = ? where id = ? and status = 'proposed'`,
        )
        .run(at, id).changes === 1
    );
  }
}
