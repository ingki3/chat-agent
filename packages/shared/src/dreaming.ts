import { z } from "zod";
import { MemoryListKind, MemoryProposal } from "./memory-proposals.js";
import { ClockTime } from "./notifications.js";
import { RuntimeId } from "./runtime.js";

/**
 * 기억 정리 (Dreaming, #146, #188, PRD FR-16.5·16.6·16.8, docs/memory-spec.md §4–§10): once a day per user, the user's
 * new messages become proposed (or, 자동 반영, applied) changes of `USER.md` / `MEMORY.md`. Each user sets their own
 * switch, time, connection·model (from the shared API key connections the admin allowed, D2) and cleanup prompt in
 * 설정 → 내 지침 → 기억 정리 (a youth account's are the admin's to set, #188). The admin keeps the server-wide switch,
 * the token cap and the allowed connections·models; the output format, the forbidden rules and the validation are fixed
 * in code. The admin sees whether it ran and counts — never content.
 */

/** Each user's round is at their own HH:MM in this zone (spec §6). */
export const DREAMING_TIME_ZONE = "Asia/Seoul";
/** At most this many rounds run at once; the rest wait their turn in order (spec §6, #188). */
export const DREAMING_CONCURRENCY = 2;
/** A new user's time until they choose one. */
export const DREAMING_DEFAULT_TIME = "03:00";
/** One run's input: at most this many characters of user messages (spec §6). */
export const DREAMING_INPUT_CHARS = 60_000;
/** Loss rate above this refuses all of a document's decisions (spec §4); exactly this passes. */
export const DREAMING_MAX_LOSS = 0.25;
/** At most this many decisions in one run's output (more: the output is refused as a whole — 형식). */
export const DREAMING_MAX_DECISIONS = 50;
/** The editable prompt's cap. */
export const DREAMING_PROMPT_MAX = 8000;
export const DREAMING_TOKEN_CAP = { min: 20_000, max: 1_000_000, default: 300_000 } as const;
/** At most this many connection·model pairs the admin allows. */
export const DREAMING_ALLOWED_MAX = 50;

/** A connection·model pair: a shared API key connection (D2) and one of its models — or the FakeRuntime (id null). */
export const DreamingChoice = z.object({
  runtime: RuntimeId,
  connectionId: z.string().max(64).nullable(),
  model: z.string().min(1).max(100),
});
export type DreamingChoice = z.infer<typeof DreamingChoice>;

/** The admin's settings (system settings — they stay when the admin changes, spec §7). */
export const DreamingConfig = z.object({
  /** The server-wide switch: off → no user's rounds run (their own switches are kept). */
  enabled: z.boolean(),
  /** Upper bound of one run's tokens (prompt bytes + the output reserve, spec §2's byte bound). */
  tokenCap: z.number().int().min(DREAMING_TOKEN_CAP.min).max(DREAMING_TOKEN_CAP.max),
  /** The connection·model pairs users may choose from. */
  allowed: z.array(DreamingChoice).max(DREAMING_ALLOWED_MAX),
});
export type DreamingConfig = z.infer<typeof DreamingConfig>;
export const SaveDreamingConfigRequest = DreamingConfig.strict();

/** One user's own settings (설정 → 내 지침 → 기억 정리; a youth account's: the admin's). */
export const DreamingSettings = z.object({
  enabled: z.boolean(),
  time: ClockTime,
  runtime: RuntimeId.nullable(),
  connectionId: z.string().max(64).nullable(),
  model: z.string().max(100).nullable(),
});
export type DreamingSettings = z.infer<typeof DreamingSettings>;
export const SaveDreamingSettingsRequest = DreamingSettings.strict();

/** The user's own cleanup prompt; `null` = 기본값으로 되돌리기 (the default prompt). */
export const SaveDreamingPromptRequest = z
  .object({ content: z.string().max(DREAMING_PROMPT_MAX).nullable() })
  .strict();

/**
 * Why a user's rounds do not run although their switch is on: the server-wide switch is off, no connection·model is
 * chosen, or the chosen one is not usable any more (deleted, disconnected, no longer allowed — "다시 고르세요").
 */
export const DreamingProblem = z.enum(["server_off", "no_choice", "unavailable"]);
export type DreamingProblem = z.infer<typeof DreamingProblem>;
export const DREAMING_PROBLEM_LABEL: Record<DreamingProblem, string> = {
  server_off: "관리자가 서버 전체에서 기억 정리를 꺼 두었어요.",
  no_choice: "연결·모델을 골라야 돌아요.",
  unavailable: "고른 연결·모델을 더 이상 쓸 수 없어요. 다시 고르세요.",
};

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
  /** the user already rejected this very change (spec §5: never proposed again) */
  "rejected",
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
  paused: "꺼져 있어 멈춤",
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

/** The user's cleanup prompt (FR-16.8: each user sees — and, unless a youth account, edits — the one in use). */
export const DreamingPromptView = z.object({
  /** The prompt in use: the user's own, or the default. */
  content: z.string(),
  /** Whether it is the user's own (false: the default — "기본값으로 되돌리기" goes back to it). */
  custom: z.boolean(),
  /** The default prompt (the last version the admin saved before #188, or the built-in one). */
  defaultContent: z.string(),
  /** The fixed part around it (output format, forbidden rules) — code, not editable. */
  fixedRules: z.string(),
  updatedAt: z.number().nullable(),
});
export type DreamingPromptView = z.infer<typeof DreamingPromptView>;

/** A connection·model a user may pick (an allowed pair whose connection is usable now). */
export const DreamingConnectionChoice = DreamingChoice.extend({ label: z.string() });
export type DreamingConnectionChoice = z.infer<typeof DreamingConnectionChoice>;

/** `GET /api/dreaming`: the caller's own 기억 정리 — settings, whether it runs, the prompt, DREAMS.md, the bundles. */
export const MyDreaming = z.object({
  /** It runs for this user (the server-wide switch, their own switch, an active account, a usable choice). */
  enabled: z.boolean(),
  /** The user's start time (HH:MM, Asia/Seoul) when it runs. */
  time: z.string().nullable(),
  settings: DreamingSettings,
  /** False for a youth account: only the admin changes its settings (#188). */
  canEdit: z.boolean(),
  /** Why it does not run although the switch is on (null: it runs, or it is off). */
  problem: DreamingProblem.nullable(),
  /** What the user may choose from. */
  choices: z.array(DreamingConnectionChoice),
  prompt: DreamingPromptView,
  runs: z.array(DreamsRecord),
  /** Bundles with something to decide, newest first (and recent ones, to undo an automatic change). */
  proposals: z.array(MemoryProposal),
});
export type MyDreaming = z.infer<typeof MyDreaming>;

/** The admin's per-user status: settings, ran / skipped / failed and counts — no content (FR-16.8, FR-1.5). */
export const DreamingUserStatus = z.object({
  userId: z.string(),
  name: z.string(),
  active: z.boolean(),
  /** A youth account: its settings are the admin's to change (here). */
  youth: z.boolean(),
  /** The user's own switch. */
  enabled: z.boolean(),
  settings: DreamingSettings,
  /** The user wrote their own prompt (its text is theirs — not shown). */
  customPrompt: z.boolean(),
  problem: DreamingProblem.nullable(),
  /** Start time of the user's round (HH:MM) when it runs. */
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

/** A connection·model the admin may allow (a shared API key connection that passed, a model of ≥ 200,000 tokens). */
export const DreamingCandidate = z.object({
  id: z.string().nullable(),
  label: z.string(),
  runtime: RuntimeId,
  models: z.array(z.object({ id: z.string(), label: z.string() })),
});
export type DreamingCandidate = z.infer<typeof DreamingCandidate>;

/** `GET /api/admin/dreaming`. */
export const DreamingAdmin = z.object({
  config: DreamingConfig,
  /** Allowed pairs whose connection was deleted or disconnected (users who chose them are paused). */
  unavailable: z.array(DreamingChoice),
  candidates: z.array(DreamingCandidate),
  users: z.array(DreamingUserStatus),
  /** "지금 실행" per user is offered (the FakeRuntime server only — development and e2e). */
  manualRuns: z.boolean(),
});
export type DreamingAdmin = z.infer<typeof DreamingAdmin>;

/** 미리 실행 (the caller's own data only): what a run would decide now — nothing is applied or moved. */
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
  dreaming_connection_not_allowed:
    "기억 정리는 공용 API 키 연결과 그 모델(맥락 200,000토큰 이상)만 쓸 수 있어요.",
  dreaming_choice_not_allowed: "관리자가 허용한 연결·모델 중에서 골라 주세요.",
  dreaming_youth_locked: "청소년 계정의 기억 정리 설정은 관리자만 바꿀 수 있어요.",
  dreaming_not_youth: "이 사용자의 기억 정리 설정은 본인이 정해요(관리자는 청소년 계정만 바꿀 수 있어요).",
  dreaming_secret: "비밀 값(키·비밀번호 같은 것)은 프롬프트에 적을 수 없어요.",
  dreaming_busy: "기억 정리가 이미 실행 중이에요.",
} as const;
