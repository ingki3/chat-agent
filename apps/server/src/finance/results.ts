import { and, asc, eq, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { financeResults, messages } from "../db/schema.js";
import { scrubKnownDeep } from "../secrets/known.js";
import { mergeEvidence, type AnswerEvidence } from "./checker.js";

/**
 * A conversation's finance results (#30): written when an answer that used a finance tool ends, read by the
 * common finance output check of every later answer in that conversation — however far back, as long as the
 * answer is still part of the history the runtime gets (active, before the new answer). One indexed query
 * (`finance_results_conversation_idx`), not a scan of the messages.
 */
export class FinanceResultStore {
  constructor(private readonly db: Db) {}

  save(row: { messageId: string; conversationId: string; runId: string }, raw: AnswerEvidence): void {
    // No known secret is stored (round 25: one registered after the tool result, before the turn ended).
    const evidence = scrubKnownDeep(raw);
    this.db
      .insert(financeResults)
      .values({ ...row, evidence })
      .onConflictDoUpdate({ target: financeResults.messageId, set: { evidence } })
      .run();
  }

  /** The finance evidence of the active answers before `beforeSeq`, merged; undefined when there is none. */
  context(conversationId: string, beforeSeq: number): AnswerEvidence | undefined {
    const rows = this.db
      .select({ evidence: financeResults.evidence })
      .from(financeResults)
      .innerJoin(messages, eq(messages.id, financeResults.messageId))
      .where(
        and(
          eq(financeResults.conversationId, conversationId),
          eq(messages.active, true),
          lt(messages.seq, beforeSeq),
        ),
      )
      .orderBy(asc(messages.seq))
      .all();
    return mergeEvidence(rows.map((r) => scrubKnownDeep(r.evidence as AnswerEvidence)));
  }
}
