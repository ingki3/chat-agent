import { z } from "zod";
import { FILE_LIMITS } from "./files.js";

/**
 * 깊이 조사 (Deep Research, #211, PRD FR-17): a long, multi-step research job of one conversation — a plan the owner
 * approves first, sub-researchers in parallel, a gap-filling round or two, a report whose every factual sentence is
 * server-checked (`cite` / `file_cite`; what does not verify is removed), as a markdown artifact. It runs on the
 * server, independent of the page (docs/decisions/deep-research.md).
 */

/** Limits of one job (the user's decisions 1–2 of #211: 30 minutes at most, no per-user quota). */
export const RESEARCH_LIMITS = {
  /** The hard cap of one job's active time (planning + research + writing). Approval wait does not count. */
  totalMs: 30 * 60_000,
  /** Stage budgets: planning, research (all rounds), writing + verification. */
  planMs: 60_000,
  researchMs: 20 * 60_000,
  writeMs: 8 * 60_000,
  /** Kept back from the cap for the server's own wrap-up (verification, the artifact, the message). */
  wrapUpMs: 60_000,
  /** A round of research needs at least this much left, otherwise the job goes on to writing (forced wrap-up). */
  minRoundMs: 3 * 60_000,
  /** Sub-questions of the plan, 2–6 (the lead's plan, the card's edits and the approval alike). */
  minSubQuestions: 2,
  maxSubQuestions: 6,
  /** Sub-researchers at once (the lead's fan-out). */
  concurrency: 3,
  /** One sub-researcher: tool calls and time. Over either, it is stopped and keeps the notes it wrote. */
  subagentToolCalls: 12,
  subagentMs: 6 * 60_000,
  /** Gap-filling rounds after the first (reflection depth). */
  maxDepth: 2,
  /**
   * One more gap-filling round beyond `maxDepth` (#234) — only when at least `extraRoundMs` of the research budget is
   * still left at that point (a quick job uses the time it has; it never runs past its deadline).
   */
  extraDepth: 1,
  extraRoundMs: 8 * 60_000,
  /** New sub-questions one reflection may add. */
  maxGapQuestions: 3,
  /**
   * Notes kept per sub-question, and for the whole job (what the writer gets — below the 50 citations one step may
   * register, `CITATION_LIMITS.perRun`, so every note can be cited).
   */
  notesPerQuestion: 12,
  maxNotes: 45,
  /** The question and one sub-question. */
  questionChars: 2000,
  subQuestionChars: 300,
  clarifyChars: 1000,
} as const;

/** Where a sub-question is looked for: the web, the conversation's attached files, or both (#211 decision 5). */
export const ResearchScope = z.enum(["web", "files", "both"]);
export type ResearchScope = z.infer<typeof ResearchScope>;

/**
 * Who researches (#211 decision 6). Stage 1 ships the built-in Claude backend only; external Deep Research APIs
 * (Gemini, OpenAI) plug in behind the same interface (apps/server/src/research/backend.ts) in stage 2 — TODO(#211
 * 2단계): add their ids here once an admin can configure them.
 */
export const ResearchBackendId = z.enum(["claude"]);
export type ResearchBackendId = z.infer<typeof ResearchBackendId>;

export const ResearchSubQuestion = z.object({
  id: z.string().min(1).max(16),
  question: z.string().trim().min(1).max(RESEARCH_LIMITS.subQuestionChars),
  scope: ResearchScope,
});
export type ResearchSubQuestion = z.infer<typeof ResearchSubQuestion>;

export const ResearchPlan = z.object({
  /** The report's title. */
  title: z.string().trim().min(1).max(120),
  subQuestions: z
    .array(ResearchSubQuestion)
    .min(RESEARCH_LIMITS.minSubQuestions)
    .max(RESEARCH_LIMITS.maxSubQuestions),
  /** The lead's estimate, minutes (shown on the card; the cap is the server's). */
  estimateMinutes: z.number().int().min(1).max(30),
  backend: ResearchBackendId,
});
export type ResearchPlan = z.infer<typeof ResearchPlan>;

export const ResearchStatus = z.enum([
  /** The lead is writing the plan (no search yet). */
  "planning",
  /** The lead asked one clarifying question; the owner's answer starts planning again (once). */
  "clarifying",
  /** The plan card waits for 승인 / 고치기 / 취소. Nothing is searched before approval (#211 decision 2). */
  "awaiting_approval",
  "researching",
  "writing",
  "done",
  "failed",
  /** Stopped by the owner while it ran. */
  "stopped",
  /** Cancelled at the plan card (or the clarifying question). */
  "cancelled",
]);
export type ResearchStatus = z.infer<typeof ResearchStatus>;
export const RESEARCH_ACTIVE: ReadonlySet<ResearchStatus> = new Set(["planning", "researching", "writing"]);
export const RESEARCH_ENDED: ReadonlySet<ResearchStatus> = new Set([
  "done",
  "failed",
  "stopped",
  "cancelled",
]);

export const ResearchQuestionState = z.object({
  id: z.string(),
  question: z.string(),
  scope: ResearchScope,
  /** Which round asked it: 0 = the plan, 1–2 = gap-filling rounds. */
  round: z.number().int().min(0),
  status: z.enum(["waiting", "running", "done", "capped", "failed"]),
  /**
   * Distinct sources (pages, files) its verified notes rest on — "검증한 자료" on the card: counted by content (#234,
   * the same page under another address is one), all that was verified, cited in the report or not.
   */
  sources: z.number().int().min(0),
  /** Notes the server could verify / that it dropped. */
  notes: z.number().int().min(0),
  dropped: z.number().int().min(0),
});
export type ResearchQuestionState = z.infer<typeof ResearchQuestionState>;

/** Fixed failure codes (never a runtime's own text). */
export const ResearchErrorCode = z.enum([
  "no_connection",
  "runtime_auth",
  "usage_limit",
  "runtime_error",
  "plan_failed",
  "no_findings",
  "server_restart",
  "conversation_gone",
  "not_allowed",
  /** The conversation was switched to another runtime (Codex) before or while the job ran. */
  "runtime_changed",
  /** The runtime stopped itself — it tried a tool it was not offered (#234: never retried). */
  "runtime_policy",
]);
export type ResearchErrorCode = z.infer<typeof ResearchErrorCode>;

export const ResearchResult = z.object({
  artifactId: z.string(),
  version: z.number().int().positive(),
  /** Sentences removed because no server-checked citation backs them (shown in the report's "한계"). */
  removed: z.number().int().min(0),
  /**
   * Sources the report cites (all verified) — "보고서에 인용한 출처" on the card: one per page (its stored final
   * address, fragment dropped) or file, as the report's 출처 list numbers them (#233). Not the same count as `sources`.
   */
  citations: z.number().int().min(0),
  /** The 30-minute cap ended research early: "시간 상한으로 일부만 조사". */
  timedOut: z.boolean(),
  /** The writer could not finish: the report lists the verified passages themselves. */
  fallback: z.boolean(),
});
export type ResearchResult = z.infer<typeof ResearchResult>;

/** A job as the API returns it (owner and share recipients alike; `owned` says who may act on it). */
export const ResearchJob = z.object({
  id: z.string(),
  conversationId: z.string(),
  messageId: z.string(),
  status: ResearchStatus,
  question: z.string(),
  clarify: z.object({ question: z.string(), answer: z.string().nullable() }).nullable(),
  plan: ResearchPlan.nullable(),
  stage: z.enum(["plan", "research", "write", "end"]),
  round: z.number().int().min(0),
  questions: z.array(ResearchQuestionState),
  /** Distinct verified sources so far — "검증한 자료", counted as a question's `sources` (not `result.citations`). */
  sources: z.number().int().min(0),
  /** Active time used so far (approval wait excluded), and the server's hard deadline once approved. */
  elapsedMs: z.number().int().min(0),
  deadlineAt: z.number().int().nullable(),
  /** The job uses the conversation's attached files (#211 decision 5). */
  files: z.number().int().min(0),
  result: ResearchResult.nullable(),
  errorCode: ResearchErrorCode.nullable(),
  createdAt: z.number().int(),
  approvedAt: z.number().int().nullable(),
  endedAt: z.number().int().nullable(),
  owned: z.boolean(),
  /** +1 on every change: a page keeps the newest it has seen (an action's answer may be older than the stream). */
  version: z.number().int().min(0),
});
export type ResearchJob = z.infer<typeof ResearchJob>;

/** `POST /api/conversations/:id/research`: the question (the composer's text) and the files sent with it. */
export const StartResearchRequest = z
  .object({
    text: z.string().trim().min(1).max(RESEARCH_LIMITS.questionChars),
    fileIds: z.array(z.string().min(1).max(64)).max(FILE_LIMITS.perConversation).optional(),
    /** Checked by the server: anything but an available backend is `backend_unavailable` (400). */
    backend: z.string().min(1).max(32).optional(),
  })
  .strict();
export type StartResearchRequest = z.infer<typeof StartResearchRequest>;

/** `POST /api/research/:id/clarify`: the owner's answer to the one clarifying question. */
export const ClarifyResearchRequest = z
  .object({ answer: z.string().trim().min(1).max(RESEARCH_LIMITS.clarifyChars) })
  .strict();

/**
 * `POST /api/research/:id/approve`: 승인 — with the card's edits (고치기), if any: the sub-questions as the owner left
 * them (ids of new ones are given by the server).
 */
export const ApproveResearchRequest = z
  .object({
    subQuestions: z
      .array(
        z
          .object({
            id: z.string().min(1).max(16).optional(),
            question: z.string().trim().min(1).max(RESEARCH_LIMITS.subQuestionChars),
            scope: ResearchScope,
          })
          .strict(),
      )
      .min(RESEARCH_LIMITS.minSubQuestions)
      .max(RESEARCH_LIMITS.maxSubQuestions)
      .optional(),
  })
  .strict();
export type ApproveResearchRequest = z.infer<typeof ApproveResearchRequest>;
