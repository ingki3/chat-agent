import { z } from "zod";
import { MemoryListKind, MemoryProposal } from "./memory-proposals.js";
import { ClockTime } from "./notifications.js";
import { RuntimeId } from "./runtime.js";

/**
 * 기억 정리 (Dreaming, #146, PRD FR-16.5·16.6·16.8, docs/memory-spec.md §4–§10): once a day per user, the user's new
 * messages become proposed (or, 자동 반영, applied) changes of `USER.md` / `MEMORY.md`. The admin sets the switch, the
 * time, the shared connection and model, the token cap and the editable part of the prompt; the output format, the
 * forbidden rules and the validation are fixed in code. The admin sees whether it ran and counts — never content.
 */

/** Rounds are at the admin's HH:MM in this zone (spec §6). */
export const DREAMING_TIME_ZONE = "Asia/Seoul";
/** Each user (in user id order) starts this much after the one before. */
export const DREAMING_STAGGER_MIN = 5;
/** One run's input: at most this many characters of user messages (spec §6). */
export const DREAMING_INPUT_CHARS = 60_000;
/** Loss rate above this refuses all of a document's decisions (spec §4); exactly this passes. */
export const DREAMING_MAX_LOSS = 0.25;
/** At most this many decisions in one run's output (more: the output is refused as a whole — 형식). */
export const DREAMING_MAX_DECISIONS = 50;
/** The editable prompt's cap. */
export const DREAMING_PROMPT_MAX = 8000;
export const DREAMING_TOKEN_CAP = { min: 20_000, max: 1_000_000, default: 300_000 } as const;

/** The admin's settings (system settings — they stay when the admin changes, spec §7). */
export const DreamingConfig = z.object({
  enabled: z.boolean(),
  time: ClockTime,
  /** A shared API key connection (D2). Null: none chosen yet (or the FakeRuntime in development, `runtime` set). */
  connectionId: z.string().max(64).nullable(),
  runtime: RuntimeId.nullable(),
  model: z.string().max(100).nullable(),
  /** Upper bound of one run's tokens (prompt bytes + the output reserve, spec §2's byte bound). */
  tokenCap: z.number().int().min(DREAMING_TOKEN_CAP.min).max(DREAMING_TOKEN_CAP.max),
});
export type DreamingConfig = z.infer<typeof DreamingConfig>;
export const SaveDreamingConfigRequest = DreamingConfig.strict();

/** Per-user switch (admin). */
export const DreamingUserSwitchRequest = z.object({ enabled: z.boolean() }).strict();

/** Why a decision was left out (spec §4) — counts only. */
export const DREAMING_REFUSAL_KINDS = [
  /** the output could not be read, an unknown action or item: the whole run */
  "format",
  /** the document would be over its cap: all of that document's decisions */
  "size",
  /** more than 25% of the document's items would go: all of that document's decisions */
  "loss",
  /** a source is not one of the run's user messages (spec §3) */
  "source",
  "secret_value",
  "rule_change",
  /** a sensitive category (Dreaming refuses it) */
  "sensitive",
  /** the same line already there, or replaced by itself */
  "unchanged",
  /** its document has a bundle waiting for review: not touched this round (its input stays queued) */
  "blocked",
] as const;
export type DreamingRefusalKind = (typeof DREAMING_REFUSAL_KINDS)[number];

export const DreamingCounts = z.object({
  /** User messages in the input: new ones (after the checkpoint) and re-processed ones (from the queue). */
  newMessages: z.number().int().nonnegative(),
  queuedMessages: z.number().int().nonnegative(),
  /** Decisions the model returned. */
  decisions: z.number().int().nonnegative(),
  proposed: z.number().int().nonnegative(),
  applied: z.number().int().nonnegative(),
  refused: z.partialRecord(z.enum(DREAMING_REFUSAL_KINDS), z.number().int().nonnegative()),
  /** Messages older than 7 days were passed over when the rounds resumed (spec §6 "오래된 대화 건너뜀"). */
  skippedOld: z.boolean(),
  /** A message longer than the input cap went in cut (its first 60,000 characters). */
  cut: z.boolean(),
});
export type DreamingCounts = z.infer<typeof DreamingCounts>;

export const DreamingRunStatus = z.enum([
  "running",
  /** 자동 반영: changes applied */
  "applied",
  /** 검토 후 반영: a bundle waits in 설정 → 내 지침 */
  "proposed",
  /** 검증 거부: nothing passed the checks */
  "refused",
  /** the model found nothing to change */
  "unchanged",
  /** nothing to process, or not run (busy answers all day, documents waiting for review) */
  "skipped",
  /** 실행 실패: no connection, expired, limit, model error, time-out */
  "failed",
]);
export type DreamingRunStatus = z.infer<typeof DreamingRunStatus>;
export const DREAMING_STATUS_LABEL: Record<DreamingRunStatus, string> = {
  running: "실행 중",
  applied: "반영",
  proposed: "제안",
  refused: "검증 거부",
  unchanged: "바꿀 것 없음",
  skipped: "건너뜀",
  failed: "실행 실패",
};
export const DreamingTrigger = z.enum(["regular", "catchup", "retry", "manual", "preview"]);
export type DreamingTrigger = z.infer<typeof DreamingTrigger>;
export const DREAMING_TRIGGER_LABEL: Record<DreamingTrigger, string> = {
  regular: "정규",
  catchup: "보정",
  retry: "재시도",
  manual: "지금 실행",
  preview: "미리 실행",
};
/** Fixed codes of a skipped or failed run (never content). */
export const DREAMING_CODE_LABEL: Record<string, string> = {
  no_input: "새 메시지 없음",
  pending_review: "검토 대기 제안이 있어 다음에 이어 감",
  busy: "답하는 중이라 오늘은 넘어감",
  no_connection: "연결 없음",
  connection_missing: "지정한 연결이 지워짐",
  connection_limited: "연결 한도",
  runtime_auth: "연결 만료",
  model_error: "모델 오류",
  timeout: "시간 초과",
  interrupted: "서버가 멈춤",
  inactive: "비활성 계정",
  too_large: "입력이 토큰 상한을 넘음",
};

/** One line of `DREAMS.md` (the user's own run history — counts, time and result only, spec §10.4). */
export const DreamsRecord = z.object({
  id: z.string(),
  date: z.string(),
  trigger: DreamingTrigger,
  status: DreamingRunStatus,
  code: z.string().nullable(),
  counts: DreamingCounts,
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
});
export type DreamsRecord = z.infer<typeof DreamsRecord>;

/** The prompt as everyone may read it (FR-16.8: each user sees the one in use). */
export const DreamingPromptView = z.object({
  version: z.number().int().nonnegative(),
  content: z.string(),
  /** The fixed part around it (output format, forbidden rules) — code, not editable. */
  fixedRules: z.string(),
  updatedAt: z.number().nullable(),
});
export type DreamingPromptView = z.infer<typeof DreamingPromptView>;

/** `GET /api/dreaming`: the caller's own 기억 정리 — whether it runs, the prompt, DREAMS.md, the bundles. */
export const MyDreaming = z.object({
  /** On for this user (the admin's switches and an active account). */
  enabled: z.boolean(),
  /** The user's start time (HH:MM, Asia/Seoul) when on. */
  time: z.string().nullable(),
  prompt: DreamingPromptView,
  runs: z.array(DreamsRecord),
  /** Bundles with something to decide, newest first (and recent ones, to undo an automatic change). */
  proposals: z.array(MemoryProposal),
});
export type MyDreaming = z.infer<typeof MyDreaming>;

/** The admin's per-user status: ran / skipped / failed and counts — no content (FR-16.8, FR-1.5). */
export const DreamingUserStatus = z.object({
  userId: z.string(),
  name: z.string(),
  active: z.boolean(),
  enabled: z.boolean(),
  /** Start time of the user's round (HH:MM). */
  time: z.string().nullable(),
  /** Today's round: waiting, running, done, failed, … (null: none yet). */
  today: z.string().nullable(),
  last: z
    .object({
      status: DreamingRunStatus,
      code: z.string().nullable(),
      trigger: DreamingTrigger,
      startedAt: z.number(),
      counts: DreamingCounts,
    })
    .nullable(),
});
export type DreamingUserStatus = z.infer<typeof DreamingUserStatus>;

export const DreamingConnectionChoice = z.object({
  id: z.string().nullable(),
  label: z.string(),
  runtime: RuntimeId,
  models: z.array(z.object({ id: z.string(), label: z.string() })),
});
export type DreamingConnectionChoice = z.infer<typeof DreamingConnectionChoice>;

/** `GET /api/admin/dreaming`. */
export const DreamingAdmin = z.object({
  config: DreamingConfig,
  /** The chosen connection was deleted ("연결을 다시 고르세요") or is not a shared API key one any more. */
  connectionProblem: z.enum(["missing", "not_allowed"]).nullable(),
  /** Shared API key connections that passed their test, with their models of at least 200,000 tokens. */
  connections: z.array(DreamingConnectionChoice),
  prompt: DreamingPromptView,
  users: z.array(DreamingUserStatus),
  /** "지금 실행" per user is offered (the FakeRuntime server only — development and e2e). */
  manualRuns: z.boolean(),
});
export type DreamingAdmin = z.infer<typeof DreamingAdmin>;

export const SaveDreamingPromptRequest = z
  .object({ content: z.string().max(DREAMING_PROMPT_MAX), baseVersion: z.number().int().nonnegative() })
  .strict();
export const DreamingPromptVersions = z.object({
  versions: z.array(
    z.object({
      version: z.number().int().positive(),
      content: z.string(),
      restoredFrom: z.number().int().nullable(),
      createdAt: z.number(),
    }),
  ),
});
export type DreamingPromptVersions = z.infer<typeof DreamingPromptVersions>;

/** 미리 실행 (the admin's own data only): what a run would decide now — nothing is applied or moved. */
export const DreamingPreviewRequest = z
  .object({ content: z.string().max(DREAMING_PROMPT_MAX).optional() })
  .strict();
export const DreamingPreview = z.object({
  status: DreamingRunStatus,
  code: z.string().nullable(),
  counts: DreamingCounts,
  decisions: z.array(
    z.object({
      doc: MemoryListKind,
      action: z.enum(["add", "replace", "delete", "merge"]),
      text: z.string().nullable(),
      before: z.string().nullable(),
    }),
  ),
});
export type DreamingPreview = z.infer<typeof DreamingPreview>;

export const DREAMING_ERRORS = {
  dreaming_prompt_changed: "다른 곳에서 먼저 바뀌었어요. 새로 불러온 뒤 다시 고쳐 주세요.",
  dreaming_connection_not_allowed:
    "기억 정리는 공용 API 키 연결과 그 모델(맥락 200,000토큰 이상)만 쓸 수 있어요.",
  dreaming_secret: "비밀 값(키·비밀번호 같은 것)은 프롬프트에 적을 수 없어요.",
  dreaming_busy: "기억 정리가 이미 실행 중이에요.",
} as const;
