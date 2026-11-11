/**
 * Where each app-server notification says which thread it is about — derived from the protocol bindings of the
 * pinned binary (`codex app-server generate-ts`, @openai/codex 0.165.0: `ServerNotification` and its parameter
 * types). The macOS test regenerates the bindings and fails when this table no longer matches; update it with
 * the table that test prints.
 *  - "thread": `params.threadId` is a thread id (string).
 *  - "threadOrGlobal": `params.threadId` is a thread id, or null for a notification about the whole process.
 *  - "threadObject": the thread is `params.thread.id`.
 *  - "global": about the process, not a thread.
 * A method that is not in the table is treated as a policy breach (fail closed).
 */
export type ThreadScope = "thread" | "threadOrGlobal" | "threadObject" | "global";

export const CODEX_NOTIFICATION_SCOPE: Readonly<Record<string, ThreadScope>> = {
  error: "thread",
  "thread/started": "threadObject",
  "thread/status/changed": "thread",
  "thread/readState/changed": "thread",
  "thread/archived": "thread",
  "thread/deleted": "thread",
  "thread/unarchived": "thread",
  "thread/closed": "thread",
  "thread/reverted": "thread",
  "skills/changed": "global",
  "thread/name/updated": "thread",
  "thread/attachment/updated": "thread",
  "thread/goal/updated": "thread",
  "thread/prediction/updated": "thread",
  "thread/goal/cleared": "thread",
  "thread/queue/changed": "thread",
  "project/changed": "global",
  "thread/project/updated": "thread",
  "thread/environment/connected": "thread",
  "thread/environment/disconnected": "thread",
  "thread/settings/updated": "thread",
  "thread/tokenUsage/updated": "thread",
  "turn/started": "thread",
  "hook/started": "thread",
  "turn/completed": "thread",
  "hook/completed": "thread",
  "turn/diff/updated": "thread",
  "turn/plan/updated": "thread",
  "item/started": "thread",
  "item/autoApprovalReview/started": "thread",
  "item/autoApprovalReview/completed": "thread",
  "autoApprovalReview/strictReviewRequired": "thread",
  "item/completed": "thread",
  "rawResponseItem/completed": "thread",
  "rawResponse/completed": "thread",
  "item/agentMessage/delta": "thread",
  "item/plan/delta": "thread",
  "command/exec/outputDelta": "global",
  "process/outputDelta": "global",
  "process/exited": "global",
  "item/commandExecution/outputDelta": "thread",
  "item/commandExecution/terminalInteraction": "thread",
  "item/fileChange/outputDelta": "thread",
  "item/fileChange/patchUpdated": "thread",
  "serverRequest/resolved": "thread",
  "item/mcpToolCall/progress": "thread",
  "mcpServer/oauthLogin/completed": "threadOrGlobal",
  "mcpServer/startupStatus/updated": "threadOrGlobal",
  "mcpServer/event/stream/notification": "global",
  "account/updated": "global",
  "account/gatewayOAuth/changed": "global",
  "account/rateLimits/updated": "global",
  "app/list/updated": "global",
  "remoteControl/status/changed": "global",
  "externalAgentConfig/import/progress": "global",
  "externalAgentConfig/import/completed": "global",
  "fs/changed": "global",
  "item/reasoning/summaryTextDelta": "thread",
  "item/reasoning/summaryPartAdded": "thread",
  "item/reasoning/textDelta": "thread",
  "thread/compacted": "thread",
  "model/rerouted": "thread",
  "model/verification": "thread",
  "modelProvider/authRecoveryStarted": "thread",
  "modelProvider/authRecoveryCompleted": "thread",
  "turn/moderationMetadata": "thread",
  "model/safetyBuffering/updated": "thread",
  warning: "threadOrGlobal",
  guardianWarning: "thread",
  deprecationNotice: "global",
  configWarning: "global",
  "fuzzyFileSearch/sessionUpdated": "global",
  "fuzzyFileSearch/sessionCompleted": "global",
  "thread/realtime/started": "thread",
  "thread/realtime/itemAdded": "thread",
  "thread/realtime/item/started": "thread",
  "thread/realtime/item/transcript/delta": "thread",
  "thread/realtime/item/completed": "thread",
  "thread/realtime/transcript/delta": "thread",
  "thread/realtime/transcript/done": "thread",
  "thread/realtime/outputAudio/delta": "thread",
  "thread/realtime/sdp": "thread",
  "thread/realtime/error": "thread",
  "thread/realtime/closed": "thread",
  "windows/worldWritableWarning": "global",
  "windowsSandbox/setupCompleted": "global",
  "account/login/completed": "global",
};

/** The thread a notification is about: an id, "global" (none), or "malformed" (the shape the table says is missing). */
export function notificationThread(
  method: string,
  params: Record<string, unknown> | undefined,
): { thread: string } | "global" | "malformed" | "unknown" {
  const scope = CODEX_NOTIFICATION_SCOPE[method];
  if (!scope) return "unknown";
  const p = params ?? {};
  switch (scope) {
    case "global":
      return "global";
    case "thread":
      return typeof p.threadId === "string" ? { thread: p.threadId } : "malformed";
    case "threadOrGlobal":
      if (p.threadId === null || p.threadId === undefined) return "global";
      return typeof p.threadId === "string" ? { thread: p.threadId } : "malformed";
    case "threadObject": {
      const id = (p.thread as { id?: unknown } | null | undefined)?.id;
      return typeof id === "string" ? { thread: id } : "malformed";
    }
  }
}
