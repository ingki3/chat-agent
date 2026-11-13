import type { PublishInput } from "../notifications/compose.js";
import type { Publisher } from "../schedules/handler.js";
import type { SharePolicy } from "./projection.js";
import type { ShareRow } from "./store.js";
import { SHARE_KIND } from "./routes.js";

/**
 * What a viewer's notification says — built from the share alone, never from the owner's notification (review #119):
 * the title is the shared item's title as the viewer's own list shows it (`incoming`, the projection's), not the
 * schedule's name (the owner's, which the viewer cannot read and which may have been renamed since); the body is a
 * fixed line (no result text, no failure reason — the service replaces it with the shared body anyway); the link and
 * the reference are the share.
 */
function sharedInput(
  sharing: SharePolicy,
  s: ShareRow,
  kind: "schedule_succeeded" | "schedule_failed",
): PublishInput {
  const title = sharing.incoming(s).title || "공유받은 예약 결과";
  const url = `/shared/${s.id}`;
  const ref = { kind: SHARE_KIND, id: s.id };
  return kind === "schedule_succeeded"
    ? { kind, scheduleName: title, summary: "", url, ref }
    : { kind, scheduleName: title, reason: "", url, ref };
}

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
  const kind = r.input.kind;
  if (!publisher || (kind !== "schedule_succeeded" && kind !== "schedule_failed")) return;
  const told = new Set<string>();
  for (const s of sharing.store.activeInConversation(r.conversationId)) {
    if (s.itemKind !== "conversation") continue;
    for (const viewer of sharing.store.resultSubscribers(s.id)) {
      if (told.has(viewer)) continue;
      if (!sharing.project(s, viewer)?.messages.has(r.messageId)) continue;
      told.add(viewer);
      publisher.publish(viewer, sharedInput(sharing, s, kind), {
        dedupeKey: `${r.dedupeKey}:shared:${viewer}`,
      });
    }
  }
}
