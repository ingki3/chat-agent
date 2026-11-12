import {
  ProposalChangedResponse,
  type PublicPart,
  type ScheduleProposal,
  type ScheduleRun,
  type ScheduleRunStatus,
  type ScheduleTiming,
  type ScheduleTrigger,
} from "@agentlee/shared";

/**
 * The schedule screen's pure parts (#55): how a timing, a run and a cost read in Korean, and where a
 * `schedule_create` card is in a reply. When a schedule runs is never computed here — the server previews it
 * (`POST /api/schedules/preview`), so the screen cannot drift from its cron rules.
 */

export const WEEKDAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"] as const;

export const TYPE_LABEL: Record<ScheduleTiming["type"], string> = {
  once: "한 번",
  daily: "매일",
  weekdays: "평일",
  weekly: "매주",
  cron: "cron 식",
};

/** "매일 08:00", "평일 07:30", "매주 월·수 09:00", "한 번 2026-12-01 08:00", "cron 0 8 * * 1-5". */
export function timingText(t: ScheduleTiming): string {
  switch (t.type) {
    case "once":
      return `한 번 · ${t.date} ${t.time}`;
    case "daily":
      return `매일 ${t.time}`;
    case "weekdays":
      return `평일(월–금) ${t.time}`;
    case "weekly":
      return `매주 ${[...t.weekdays]
        .sort((a, b) => a - b)
        .map((d) => WEEKDAY_NAMES[d])
        .join("·")} ${t.time}`;
    case "cron":
      return `cron ${t.cron}`;
  }
}

/** A moment in the schedule's own time zone: "11월 13일 (금) 오전 8:00". */
export function whenText(ms: number, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone,
      month: "long",
      day: "numeric",
      weekday: "short",
      hour: "numeric",
      minute: "2-digit",
    }).format(ms);
  } catch {
    return new Date(ms).toLocaleString("ko-KR");
  }
}

export const STATUS_LABEL: Record<ScheduleRunStatus, string> = {
  pending: "대기",
  running: "실행 중",
  succeeded: "성공",
  failed: "실패",
  skipped: "건너뜀",
};
export const STATUS_CLASS: Record<ScheduleRunStatus, string> = {
  pending: "gray",
  running: "",
  succeeded: "ok",
  failed: "err",
  skipped: "warn",
};
export const TRIGGER_LABEL: Record<ScheduleTrigger, string> = {
  regular: "정시",
  missed: "놓친 실행",
  manual: "바로 실행",
};
export const CODE_LABEL: Record<NonNullable<ScheduleRun["errorCode"]>, string> = {
  handler_error: "실행 오류",
  interrupted: "서버가 실행 중에 멈췄어요",
  overlap: "앞 실행이 안 끝나서 건너뜀",
  superseded: "더 최근 회차로 대체",
  runtime_unavailable: "런타임을 쓸 수 없어요",
  not_allowed: "허용되지 않은 설정",
  run_failed: "실행 실패",
  timeout: "시간 초과",
};

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
/** "$0.0123", or "—" when nothing priced was recorded (subscription, no usage, no price). */
export const costText = (c: number | null) => (c === null ? "—" : usd.format(c));

/** A `schedule_create` call's tool name as each runtime reports it (bare, or `mcp__agentlee__…`). */
export const isScheduleTool = (name: string) =>
  name === "schedule_create" || name.endsWith("__schedule_create");

/**
 * The confirmation cards of a reply: the proposals its `schedule_create` calls made (a refused call has none), in
 * order, each once.
 */
export function proposalIds(parts: readonly PublicPart[]): string[] {
  const calls = new Set(
    parts.flatMap((p) => (p.type === "tool_call" && isScheduleTool(p.name) ? [p.id] : [])),
  );
  const out: string[] = [];
  for (const p of parts) {
    if (p.type !== "tool_result" || !calls.has(p.callId) || p.isError) continue;
    const id = (p.output as { proposalId?: unknown } | null)?.proposalId;
    if (typeof id === "string" && /^[A-Za-z0-9-]{1,64}$/.test(id) && !out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * The card as it is now, from a confirm refused with 409 `proposal_changed` (review #108): the defaults or what is
 * allowed changed after the card was shown. Undefined for any other error.
 */
export function changedProposal(body: unknown): ScheduleProposal | undefined {
  const r = ProposalChangedResponse.safeParse(body);
  return r.success ? r.data.proposal : undefined;
}
