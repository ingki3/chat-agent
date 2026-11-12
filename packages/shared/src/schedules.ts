import { z } from "zod";
import { RuntimeId } from "./runtime.js";
import { ChatSettings } from "./chat.js";

// ---- Schedules (#33 engine; the screen is #55, the real run is #56 — PRD FR-8) ----

export const ScheduleType = z.enum(["once", "daily", "weekdays", "weekly", "cron"]);
export type ScheduleType = z.infer<typeof ScheduleType>;

/** Local wall-clock time "HH:MM" (24h) in the schedule's time zone. */
export const LocalTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
/** A real calendar date "YYYY-MM-DD": month lengths and leap years checked (2027-02-29, 2027-04-31 are not). */
export function isCalendarDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]!;
  return d <= days;
}
/** Local calendar date "YYYY-MM-DD" in the schedule's time zone — a date that exists (never normalised). */
export const LocalDate = z.string().refine(isCalendarDate, { message: "not a calendar date" });

/**
 * When a schedule runs (FR-8.2): once on a date, every day, Monday–Friday, on chosen weekdays (0 = Sunday … 6 =
 * Saturday), or a 5-field cron expression (minute hour day-of-month month day-of-week). All in `timeZone`.
 */
export const ScheduleTiming = z.discriminatedUnion("type", [
  z.object({ type: z.literal("once"), date: LocalDate, time: LocalTime }).strict(),
  z.object({ type: z.literal("daily"), time: LocalTime }).strict(),
  z.object({ type: z.literal("weekdays"), time: LocalTime }).strict(),
  z
    .object({
      type: z.literal("weekly"),
      time: LocalTime,
      weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    })
    .strict(),
  z
    .object({
      type: z.literal("cron"),
      cron: z
        .string()
        .trim()
        .min(9)
        .max(100)
        .regex(/^[0-9*,/\- ]+$/),
    })
    .strict(),
]);
export type ScheduleTiming = z.infer<typeof ScheduleTiming>;

export const SCHEDULE_DEFAULT_TIME_ZONE = "Asia/Seoul";
const SkillName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

/**
 * `POST /api/schedules`. Runtime, model and effort are optional: without them the creator's defaults apply (FR-8.2,
 * the FR-12.6 fallback order); given ones are checked like the chip's change (403 when not allowed).
 */
export const CreateScheduleRequest = z
  .object({
    name: z.string().trim().min(1).max(100),
    prompt: z.string().trim().min(1).max(8000),
    timing: ScheduleTiming,
    timeZone: z.string().min(1).max(64).default(SCHEDULE_DEFAULT_TIME_ZONE),
    skills: z.array(SkillName).max(64).default([]),
    notify: z.boolean().default(true),
    runtime: RuntimeId.optional(),
    model: z.string().min(1).max(100).optional(),
    effort: z.string().min(1).max(20).optional(),
    useShared: z.boolean().optional(),
  })
  .strict();
export type CreateScheduleRequest = z.input<typeof CreateScheduleRequest>;

/**
 * `PATCH /api/schedules/:id` (#55): any of the fields; at least one. A new timing or time zone moves the next
 * occurrence (from now). Runtime·model·effort are checked like the chip's change on the schedule's own settings
 * (403 when not allowed); none given keeps them.
 */
export const UpdateScheduleRequest = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    prompt: z.string().trim().min(1).max(8000).optional(),
    timing: ScheduleTiming.optional(),
    timeZone: z.string().min(1).max(64).optional(),
    skills: z.array(SkillName).max(64).optional(),
    notify: z.boolean().optional(),
    paused: z.boolean().optional(),
    runtime: RuntimeId.optional(),
    model: z.string().min(1).max(100).optional(),
    effort: z.string().min(1).max(20).optional(),
    useShared: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "nothing to update" });
export type UpdateScheduleRequest = z.input<typeof UpdateScheduleRequest>;

/** `POST /api/schedules/preview` (#55): the next occurrences of a timing, computed by the server (no cron here). */
export const SchedulePreviewRequest = z
  .object({ timing: ScheduleTiming, timeZone: z.string().min(1).max(64).default(SCHEDULE_DEFAULT_TIME_ZONE) })
  .strict();
export type SchedulePreviewRequest = z.input<typeof SchedulePreviewRequest>;
export const SCHEDULE_PREVIEW_COUNT = 3;
export const SchedulePreviewResponse = z.object({ next: z.array(z.number()) });
export type SchedulePreviewResponse = z.infer<typeof SchedulePreviewResponse>;

/** `GET /api/schedules/options` (#55): the skills the caller may give a schedule (the same check as create). */
export const ScheduleOptionsResponse = z.object({ skills: z.array(z.object({ name: z.string() })) });
export type ScheduleOptionsResponse = z.infer<typeof ScheduleOptionsResponse>;

export const Schedule = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string(),
  timing: ScheduleTiming,
  timeZone: z.string(),
  skills: z.array(z.string()),
  notify: z.boolean(),
  settings: ChatSettings,
  paused: z.boolean(),
  /** The next regular occurrence (ms); null for a finished one-off or a paused schedule. */
  nextRunAt: z.number().nullable(),
  /** The schedule's own conversation for its results (#56); null until the first result. */
  conversationId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Schedule = z.infer<typeof Schedule>;
export const SchedulesResponse = z.object({ schedules: z.array(Schedule) });
export type SchedulesResponse = z.infer<typeof SchedulesResponse>;

export const ScheduleRunStatus = z.enum(["pending", "running", "succeeded", "failed", "skipped"]);
export type ScheduleRunStatus = z.infer<typeof ScheduleRunStatus>;
/** regular: on time · missed: the one catch-up after the server was off (FR-8.7) · manual: "바로 실행". */
export const ScheduleTrigger = z.enum(["regular", "missed", "manual"]);
export type ScheduleTrigger = z.infer<typeof ScheduleTrigger>;

/**
 * Why a run failed or was skipped (fixed codes; the handler's own codes must be one of these, else
 * `handler_error`). overlap: the previous run was not finished (FR-8.7 건너뜀) · superseded: an older unstarted
 * occurrence replaced by the newest one after a restart · interrupted: the server stopped mid-run.
 */
export const SCHEDULE_RUN_CODES = [
  "handler_error",
  "interrupted",
  "overlap",
  "superseded",
  "runtime_unavailable",
  "not_allowed",
  "run_failed",
  "timeout",
] as const;
export const ScheduleRunCode = z.enum(SCHEDULE_RUN_CODES);
export type ScheduleRunCode = z.infer<typeof ScheduleRunCode>;

export const ScheduleRun = z.object({
  id: z.string(),
  trigger: ScheduleTrigger,
  status: ScheduleRunStatus,
  /** The occurrence this run is for (ms; "바로 실행": when it was asked for). */
  scheduledAt: z.number(),
  attempts: z.number().int(),
  startedAt: z.number().nullable(),
  /** A failed first attempt: when the one retry starts (FR-8.6). */
  retryAt: z.number().nullable(),
  resultSavedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  errorCode: ScheduleRunCode.nullable(),
  /**
   * What the run cost (#55, FR-8.5): the priced usage of API-key connections recorded for it (`priced_cost_micros`),
   * in USD; null when nothing priced was recorded (a subscription run, no usage yet, or no price — 미제공).
   */
  costUsd: z.number().nullable(),
});
export type ScheduleRun = z.infer<typeof ScheduleRun>;
export const ScheduleRunsResponse = z.object({ runs: z.array(ScheduleRun) });
export type ScheduleRunsResponse = z.infer<typeof ScheduleRunsResponse>;
export const RunScheduleNowResponse = z.object({ run: ScheduleRun });
export type RunScheduleNowResponse = z.infer<typeof RunScheduleNowResponse>;

// ---- Schedules proposed in a conversation (#55, FR-8.1): the `schedule_create` tool → a confirmation card ----

/**
 * What the `schedule_create` tool may propose: the schedule's own fields. Never the runtime or model (those are the
 * creator's defaults, FR-8.2) — the card's confirm creates it with the user's own session.
 */
export const ScheduleProposalInput = z
  .object({
    name: z.string().trim().min(1).max(100),
    prompt: z.string().trim().min(1).max(8000),
    timing: ScheduleTiming,
    timeZone: z.string().min(1).max(64).default(SCHEDULE_DEFAULT_TIME_ZONE),
    skills: z.array(SkillName).max(64).default([]),
    notify: z.boolean().default(true),
  })
  .strict();
export type ScheduleProposalInput = z.input<typeof ScheduleProposalInput>;

export const ScheduleProposalStatus = z.enum(["proposed", "confirmed", "dismissed"]);
export type ScheduleProposalStatus = z.infer<typeof ScheduleProposalStatus>;

/** `GET /api/schedule-proposals/:id`: the card. `settings` and `next` are what confirming now would make. */
export const ScheduleProposal = z.object({
  id: z.string(),
  status: ScheduleProposalStatus,
  name: z.string(),
  prompt: z.string(),
  timing: ScheduleTiming,
  timeZone: z.string(),
  skills: z.array(z.string()),
  notify: z.boolean(),
  /** The creator's defaults now (FR-12.6 fallback); null when no runtime is usable. */
  settings: ChatSettings.nullable(),
  /** The next occurrences from now; empty when there is none any more (a one-off in the past). */
  next: z.array(z.number()),
  /** The schedule made from it (status `confirmed`). */
  scheduleId: z.string().nullable(),
  createdAt: z.number(),
});
export type ScheduleProposal = z.infer<typeof ScheduleProposal>;
/** `POST /api/schedule-proposals/:id/confirm`: the schedule (201 the first time, 200 when it was already made). */
export const ConfirmScheduleProposalResponse = z.object({ proposal: ScheduleProposal, schedule: Schedule });
export type ConfirmScheduleProposalResponse = z.infer<typeof ConfirmScheduleProposalResponse>;
/** What the tool answers the model (the schedule does not exist yet). */
export const ScheduleProposalToolOutput = z.object({
  proposalId: z.string(),
  status: z.literal("proposed"),
  nextRunAt: z.number(),
  note: z.string(),
});
export type ScheduleProposalToolOutput = z.infer<typeof ScheduleProposalToolOutput>;
/** Why `schedule_create` refused a proposal (fixed codes; the model sees one, the log may name it). */
export const SCHEDULE_PROPOSAL_CODES = [
  "schedule_bad_input",
  "schedule_not_allowed",
  "skill_not_allowed",
  "cron_invalid",
  "schedule_in_past",
  "schedule_never",
  "invalid_time_zone",
  "invalid_date",
] as const;
