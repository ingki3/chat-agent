import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router";
import type { Notification } from "@agentlee/shared";
import { errorText, notifications, NOTIFICATIONS_KEY } from "../api.js";
import { TopBar } from "../Shell.js";

const timeFmt = new Intl.DateTimeFormat("ko-KR", {
  month: "numeric",
  day: "numeric",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** 🔔 알림함 (FR-13.3): everything that was pushed — or held, or missed — with read state. */
export function NotificationsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const list = useQuery({ queryKey: [...NOTIFICATIONS_KEY, "list"], queryFn: notifications.list });
  const refresh = () => qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
  const readAll = useMutation({ mutationFn: notifications.readAll, onSettled: refresh });
  const open = useMutation({
    mutationFn: async (n: Notification) => {
      if (n.readAt === null) await notifications.read(n.id);
      return n;
    },
    onSettled: refresh,
    onSuccess: (n) => navigate(n.url),
  });
  const items = list.data?.items ?? [];
  const unread = list.data?.unread ?? 0;

  return (
    <>
      <TopBar title="🔔 알림함">
        <button
          type="button"
          className="small"
          disabled={unread === 0 || readAll.isPending}
          onClick={() => readAll.mutate()}
        >
          모두 읽음
        </button>
      </TopBar>
      <div className="page">
        {list.isError && <p className="error">{errorText(list.error)}</p>}
        {list.data && items.length === 0 && <p className="muted">아직 받은 알림이 없어요.</p>}
        <ul className="notis" aria-label="알림 목록">
          {items.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                className={`noti${n.readAt === null ? " unread" : ""}`}
                data-testid="notification"
                onClick={() => open.mutate(n)}
              >
                <b>{n.title}</b>
                {n.body && <span className="noti-body">{n.body}</span>}
                <span className="small muted">
                  {timeFmt.format(n.createdAt)}
                  {n.readAt === null ? " · 안 읽음" : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className="muted small">
          방해 금지 시간에 온 알림은 여기에만 쌓였다가 끝나면 한 번에 보내요.{" "}
          <Link to="/settings#notifications">알림 설정</Link>
        </p>
      </div>
    </>
  );
}
