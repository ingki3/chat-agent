import type { PublishInput } from "../notifications/compose.js";
import type { Publisher } from "../schedules/handler.js";
import type { SharePolicy } from "./projection.js";
import { SHARE_KIND } from "./routes.js";

/**
 * A schedule's new result (or failure) in a shared result conversation (#52, FR-8.8): the viewers who chose "새 결과
 * 알림 받기" are told — only those whose projection holds that message right now (a snapshot never does; a revoked
 * or retargeted share reaches no one). The notification opens the shared view and refers to the share, so the inbox
 * re-checks it on every read, and its body is the fixed shared one (FR-13.5: the result stays off their lock screen).
 * Once per viewer and run, however many shares reach them.
 */
export function notifyResultSubscribers(
  sharing: SharePolicy,
  publisher: Publisher | undefined,
  r: { conversationId: string; messageId: string; input: PublishInput; dedupeKey: string },
): void {
  if (!publisher || (r.input.kind !== "schedule_succeeded" && r.input.kind !== "schedule_failed")) return;
  const told = new Set<string>();
  for (const s of sharing.store.activeInConversation(r.conversationId)) {
    if (s.itemKind !== "conversation") continue;
    for (const viewer of sharing.store.resultSubscribers(s.id)) {
      if (told.has(viewer)) continue;
      if (!sharing.project(s, viewer)?.messages.has(r.messageId)) continue;
      told.add(viewer);
      publisher.publish(
        viewer,
        { ...r.input, url: `/shared/${s.id}`, ref: { kind: SHARE_KIND, id: s.id } },
        { dedupeKey: `${r.dedupeKey}:shared:${viewer}` },
      );
    }
  }
}
