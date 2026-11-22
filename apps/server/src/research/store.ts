import crypto from "node:crypto";
import { and, desc, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  ResearchPlan,
  ResearchResult,
  type ResearchErrorCode,
  type ResearchJob,
  ResearchQuestionState,
  type ResearchStatus,
  type SourceType,
} from "@agentlee/shared";
import type { Db } from "../db/client.js";
import { researchJobs } from "../db/schema.js";
import { scrubKnown, scrubKnownDeep } from "../secrets/known.js";

export type ResearchJobRow = typeof researchJobs.$inferSelect;

/**
 * One verified note of a sub-researcher (#211): a claim, the passage it rests on, and where that passage is — a page
 * the job fetched (`sourceId`, a source of the conversation) or an attached file (`fileId`). Only notes whose passage
 * the server found in that source are kept (`verifyNote`); the writer gets these and nothing else.
 */
export type ResearchNote = {
  id: string;
  claim: string;
  quote: string;
  sourceId?: string | undefined;
  fileId?: string | undefined;
  /** The page or file's name (for the writer's list; page text, so it reaches the model as external content). */
  title?: string | undefined;
  page?: number | undefined;
  /** A file passage's verified place ("3쪽", "표 2 · B3") — from the check, never the model's own page. */
  place?: string | undefined;
  /** A web note's publisher kind by its domain (#234, `sourceTypeOf`): for the writer and the report (#233). */
  sourceType?: SourceType | undefined;
};

/** A sub-question's state with its verified notes (`found`); the API shows only their count. */
export type QuestionRecord = Omit<ResearchQuestionState, "notes"> & {
  found: ResearchNote[];
  /**
   * It was researched once more with rewritten queries (#234: no verified note, or one source only) — at most once.
   */
  retried?: boolean | undefined;
  /** Claims of its last run whose quote could not be verified, nor repaired (the retry and the lead see them). */
  unverified?: string[] | undefined;
  /** Notes kept because their quote was repaired to the page's own passage (`closestPassage`). */
  repaired?: number | undefined;
  /** Why its last run failed without a note (a runtime error code): a passing one may be retried (#234). */
  failure?: ResearchErrorCode | undefined;
};

/** The checkpoint (`research_jobs.state`): written after every step. */
export type JobState = {
  stage: "plan" | "research" | "write" | "end";
  /** The research round being run (0 = the plan's questions). */
  round: number;
  /** The last round whose reflection is done (−1: none). */
  reflected: number;
  questions: QuestionRecord[];
  /** The cap (or the research stage's budget) ended research early. */
  timedOut: boolean;
  /**
   * The sources the owner approved (the union of the approved sub-questions' scopes): a gap question added by the lead
   * stays within them — a files-only plan never searches the web.
   */
  scopes?: ("web" | "files")[] | undefined;
};

export const emptyState = (): JobState => ({
  stage: "plan",
  round: 0,
  reflected: -1,
  questions: [],
  timedOut: false,
});

export function stateOf(row: ResearchJobRow): JobState {
  try {
    const s = JSON.parse(row.state) as Partial<JobState>;
    const questions = Array.isArray(s.questions) ? s.questions : [];
    return { ...emptyState(), ...s, questions: questions.map((q) => ({ ...q, found: q.found ?? [] })) };
  } catch {
    return emptyState();
  }
}

export function planOf(row: ResearchJobRow): ResearchPlan | null {
  if (!row.plan) return null;
  try {
    const p = ResearchPlan.safeParse(JSON.parse(row.plan));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

export function resultOf(row: ResearchJobRow): ResearchResult | null {
  if (!row.result) return null;
  try {
    const p = ResearchResult.safeParse(JSON.parse(row.result));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
}

export const fileIdsOf = (row: ResearchJobRow): string[] => {
  try {
    const v = JSON.parse(row.fileIds) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

/** Distinct sources (pages and files) the verified notes rest on. */
export function sourceCount(notes: readonly ResearchNote[]): number {
  return new Set(notes.map((n) => (n.sourceId ? `s:${n.sourceId}` : `f:${n.fileId}`))).size;
}

const QUESTION_KEYS = new Set(Object.keys(ResearchQuestionState.shape));

/** The job as the API shows it (owner or share recipient). Notes stay on the server. */
export function toResearchJob(row: ResearchJobRow, opts: { owned: boolean; now: number }): ResearchJob {
  const s = stateOf(row);
  const plan = planOf(row);
  const notes = s.questions.flatMap((q) => q.found ?? []);
  return {
    id: row.id,
    conversationId: row.conversationId,
    messageId: row.messageId,
    status: row.status,
    question: row.question,
    clarify: row.clarifyQuestion ? { question: row.clarifyQuestion, answer: row.clarifyAnswer } : null,
    plan,
    stage: s.stage,
    round: s.round,
    // Only the API's fields: the notes and the retry's bookkeeping (#234) stay on the server.
    questions: s.questions.map(
      (q) =>
        ({
          ...Object.fromEntries(Object.entries(q).filter(([k]) => QUESTION_KEYS.has(k))),
          notes: q.found?.length ?? 0,
        }) as ResearchQuestionState,
    ),
    sources: sourceCount(notes),
    // Planning time (before approval) plus the time since approval; the wait at the plan card does not count.
    elapsedMs: Math.max(
      0,
      row.activeMs + (row.approvedAt !== null ? (row.endedAt ?? opts.now) - row.approvedAt : 0),
    ),
    deadlineAt: row.deadlineAt,
    files: fileIdsOf(row).length,
    result: resultOf(row),
    errorCode: (row.errorCode as ResearchErrorCode | null) ?? null,
    createdAt: row.createdAt,
    approvedAt: row.approvedAt,
    endedAt: row.endedAt,
    owned: opts.owned,
    version: row.version,
  };
}

export type JobPatch = Partial<{
  status: ResearchStatus;
  clarifyQuestion: string | null;
  clarifyAnswer: string | null;
  plan: ResearchPlan | null;
  state: JobState;
  result: ResearchResult | null;
  errorCode: ResearchErrorCode | null;
  activeMs: number;
  approvedAt: number | null;
  deadlineAt: number | null;
  endedAt: number | null;
}>;

/**
 * 깊이 조사 jobs (#211). Every text that is user, model or page text — the question, the clarifying exchange, the
 * plan, the checkpoint's notes — is scrubbed of known secrets on every write (the rescrub covers them later too).
 */
export class ResearchStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  create(input: {
    conversationId: string;
    ownerId: string;
    messageId: string;
    question: string;
    fileIds: string[];
    backend: string;
    id?: string;
  }): ResearchJobRow {
    const at = this.now();
    return this.db
      .insert(researchJobs)
      .values({
        id: input.id ?? crypto.randomUUID(),
        conversationId: input.conversationId,
        ownerId: input.ownerId,
        messageId: input.messageId,
        status: "planning",
        backend: input.backend,
        question: scrubKnown(input.question),
        fileIds: JSON.stringify(input.fileIds),
        state: JSON.stringify(emptyState()),
        createdAt: at,
        updatedAt: at,
      })
      .returning()
      .get();
  }

  get(id: string): ResearchJobRow | undefined {
    return this.db.select().from(researchJobs).where(eq(researchJobs.id, id)).get();
  }

  byConversation(conversationId: string): ResearchJobRow[] {
    return this.db
      .select()
      .from(researchJobs)
      .where(eq(researchJobs.conversationId, conversationId))
      .orderBy(desc(researchJobs.createdAt))
      .all();
  }

  /** The owner's jobs in these states (e.g. the one running, or those left by a previous process). */
  withStatus(statuses: ResearchStatus[], ownerId?: string): ResearchJobRow[] {
    return this.db
      .select()
      .from(researchJobs)
      .where(
        ownerId
          ? and(inArray(researchJobs.status, statuses), eq(researchJobs.ownerId, ownerId))
          : inArray(researchJobs.status, statuses),
      )
      .all();
  }

  /**
   * Writes a patch. `from`: only while the job is still in one of these states (a stop or a delete that came in between
   * wins) — false when nothing was written.
   */
  update(id: string, patch: JobPatch, from?: readonly ResearchStatus[]): boolean {
    const set: Partial<Omit<ResearchJobRow, "version">> & { version?: SQL } = {
      updatedAt: this.now(),
      version: sql`${researchJobs.version} + 1`,
    };
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.clarifyQuestion !== undefined)
      set.clarifyQuestion = patch.clarifyQuestion === null ? null : scrubKnown(patch.clarifyQuestion);
    if (patch.clarifyAnswer !== undefined)
      set.clarifyAnswer = patch.clarifyAnswer === null ? null : scrubKnown(patch.clarifyAnswer);
    if (patch.plan !== undefined)
      set.plan = patch.plan === null ? null : JSON.stringify(scrubKnownDeep(patch.plan));
    if (patch.state !== undefined) set.state = JSON.stringify(scrubKnownDeep(patch.state));
    if (patch.result !== undefined) set.result = patch.result === null ? null : JSON.stringify(patch.result);
    if (patch.errorCode !== undefined) set.errorCode = patch.errorCode;
    if (patch.activeMs !== undefined) set.activeMs = patch.activeMs;
    if (patch.approvedAt !== undefined) set.approvedAt = patch.approvedAt;
    if (patch.deadlineAt !== undefined) set.deadlineAt = patch.deadlineAt;
    if (patch.endedAt !== undefined) set.endedAt = patch.endedAt;
    const where = from?.length
      ? and(eq(researchJobs.id, id), inArray(researchJobs.status, [...from]))
      : eq(researchJobs.id, id);
    return this.db.update(researchJobs).set(set).where(where).run().changes > 0;
  }
}
