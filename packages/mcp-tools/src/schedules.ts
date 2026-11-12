import { ScheduleProposalInput } from "@agentlee/shared";
import type { ServerToolInfo } from "./index.js";

/**
 * `schedule_create` (#55, PRD FR-8.1): the model proposes a schedule from the conversation ("매일 아침 8시에 내 관심
 * 종목 브리핑해줘"). It only proposes: the user sees a confirmation card under the reply and the schedule exists
 * only after they confirm it there (their own session — never this tool). Runtime and model are not inputs: a new
 * schedule uses its creator's defaults (FR-8.2). Who proposes, in which conversation, comes from the run's token.
 */
export const SCHEDULE_CREATE_TOOL: ServerToolInfo = {
  name: "schedule_create",
  description:
    "Proposes a scheduled task for the user (it is NOT created yet). The user sees a confirmation card and the schedule is created only when they confirm it; after calling this, tell the user to check the card — never say the schedule was created. name: short title (e.g. 아침 관심 종목 브리핑). prompt: what to do at each run, written as a request to you. timing: {type:'once', date:'YYYY-MM-DD', time:'HH:MM'} | {type:'daily'|'weekdays', time:'HH:MM'} | {type:'weekly', time:'HH:MM', weekdays:[0-6, 0=Sunday]} | {type:'cron', cron:'m h dom mon dow'}. timeZone: IANA name, default Asia/Seoul. skills: skill names the run may use (optional). notify: default true. Returns proposalId and the first run time (ms).",
  input: ScheduleProposalInput.shape,
};
