import { useDeferredValue, useState, type RefObject } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, NavLink, useMatch, useNavigate } from "react-router";
import type { AuthState, AuthUser, Conversation } from "@agentlee/shared";
import { auth, conversations, errorText, notifications, NOTIFICATIONS_KEY } from "./api.js";
import { unsubscribeOnSignOut } from "./push.js";

export const CONVERSATIONS_KEY = ["conversations"] as const;

const RUNTIME_LABEL: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex" };

export function Sidebar({
  ref,
  ...props
}: {
  ref?: RefObject<HTMLElement | null>;
  onNavigate?: () => void;
  user: AuthUser;
  open: boolean;
  onClose: () => void;
  onSignedOut: (s: AuthState) => void;
}) {
  const [q, setQ] = useState("");
  const query = useDeferredValue(q.trim());
  // Pages of 50, pinned first then most recent (server order); "더 보기" loads the next page.
  const list = useInfiniteQuery({
    queryKey: [...CONVERSATIONS_KEY, query],
    queryFn: ({ pageParam }) => conversations.list(query, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = list.data?.pages.flatMap((p) => p.items);
  const pinned = items?.filter((c) => c.pinned) ?? [];
  const recent = items?.filter((c) => !c.pinned) ?? [];
  // Unread badge (FR-13.3): refreshed on focus, every minute, and at once when a push arrives (Shell).
  const unread = useQuery({
    queryKey: [...NOTIFICATIONS_KEY, "unread"],
    queryFn: notifications.unread,
    refetchInterval: 60_000,
  });
  const badge = unread.data ?? 0;
  const signOut = async () => {
    // This browser stops getting this account's pushes (the server drops the device with the session too).
    await unsubscribeOnSignOut();
    props.onSignedOut(await auth.logout());
  };

  return (
    <aside
      ref={ref}
      className={`side${props.open ? " drawer-open" : ""}`}
      aria-label="사이드바"
      data-testid="sidebar"
      // As an open drawer (narrow screens) it is a modal dialog.
      {...(props.open ? { role: "dialog", "aria-modal": true } : {})}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a")) props.onNavigate?.();
      }}
    >
      <div className="brand">
        <span className="logo">AL</span>Agent Lee
        <span className="grow" />
        <NavLink
          to="/notifications"
          className="ghost bell"
          aria-label={badge ? `알림함, 안 읽은 알림 ${badge}개` : "알림함"}
          title="알림함"
        >
          🔔
          {badge > 0 && (
            <span className="badge count" data-testid="unread-badge">
              {badge > 99 ? "99+" : badge}
            </span>
          )}
        </NavLink>
        <button type="button" className="ghost close-drawer" aria-label="메뉴 닫기" onClick={props.onClose}>
          ✕
        </button>
      </div>
      <Link className="item" to="/">
        ✏️ 새 대화
      </Link>
      <input
        className="search"
        type="search"
        placeholder="🔍 내 대화 검색"
        aria-label="내 대화 검색"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      {list.isError && <p className="error small">{errorText(list.error)}</p>}
      {pinned.length > 0 && <div className="grp">고정</div>}
      {pinned.map((c) => (
        <ConvItem key={c.id} c={c} />
      ))}
      <div className="grp">{query ? "검색 결과" : "최근"}</div>
      {recent.map((c) => (
        <ConvItem key={c.id} c={c} />
      ))}
      {list.hasNextPage && (
        <button
          type="button"
          className="ghost small more"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? "불러오는 중…" : "더 보기"}
        </button>
      )}
      {items?.length === 0 && (
        <p className="muted small pad">{query ? "찾는 대화가 없어요." : "아직 대화가 없어요."}</p>
      )}
      <div className="grp">가족 공유</div>
      <NavLink className="item" to="/shared">
        👪 공유받은 항목
      </NavLink>
      <div className="grp">바로가기</div>
      <NavLink className="item" to="/schedules">
        ⏰ 예약
      </NavLink>
      <NavLink className="item" to="/artifacts">
        🧩 아티팩트
      </NavLink>
      <NavLink className="item" to="/settings">
        ⚙️ 설정
      </NavLink>
      {props.user.role === "admin" && (
        <NavLink className="item" to="/admin">
          🛠 관리자
        </NavLink>
      )}
      <div className="me row">
        <span className="logo small-logo">{Array.from(props.user.name)[0]}</span>
        <div className="grow small">
          <div data-testid="whoami">{props.user.name}</div>
          <div className="muted" title="사용량 (#32)">
            이번 달 사용량 —
          </div>
        </div>
        <button type="button" className="ghost small" onClick={() => void signOut()}>
          로그아웃
        </button>
      </div>
    </aside>
  );
}

function ConvItem({ c }: { c: Conversation }) {
  const active = useMatch(`/c/${c.id}`);
  const runtime = c.lastRuntime ? RUNTIME_LABEL[c.lastRuntime] : undefined;
  return (
    <div className={`conv${active ? " on" : ""}`}>
      <Link to={`/c/${c.id}`} className="conv-link" data-testid="conv">
        <span
          className={`dot ${c.lastRuntime === "codex" ? "codex" : c.lastRuntime ? "claude" : "none"}`}
          title={runtime ? `마지막 응답: ${runtime}` : "아직 응답 없음"}
          aria-label={runtime ? `마지막 응답 ${runtime}` : undefined}
        />
        <span className="t">{c.title}</span>
      </Link>
      <ConvMenu c={c} />
    </div>
  );
}

/** ⋯ menu: rename, pin, delete (with a confirmation that says what goes). */
export function ConvMenu({ c }: { c: Conversation }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const refresh = () => qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
  const act = useMutation({
    mutationFn: async (kind: "rename" | "pin" | "delete") => {
      if (kind === "rename") {
        const title = prompt("새 이름", c.title)?.trim();
        if (title && title !== c.title) await conversations.rename(c.id, title);
      } else if (kind === "pin") {
        await conversations.pin(c.id, !c.pinned);
      } else if (
        confirm(
          `"${c.title}" 대화를 삭제할까요?\n메시지와 이 대화의 실행 기록이 모두 지워지고 되돌릴 수 없어요. (이 대화의 파일·아티팩트·공유도 함께 지워져요.)`,
        )
      ) {
        await conversations.remove(c.id);
        // Leave only if this conversation is still the one on screen (the user may have moved on meanwhile).
        if (window.location.pathname === `/c/${c.id}`) navigate("/", { replace: true });
      }
    },
    onSettled: async () => {
      setOpen(false);
      await refresh();
      await qc.invalidateQueries({ queryKey: ["conversation", c.id] });
    },
    onError: (e) => alert(errorText(e)),
  });
  return (
    <div className="menu-wrap">
      <button
        type="button"
        className="ghost dots"
        aria-label={`${c.title} 메뉴`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        ⋯
      </button>
      {open && (
        <div className="menu" role="menu">
          <button type="button" role="menuitem" onClick={() => act.mutate("rename")}>
            이름 변경
          </button>
          <button type="button" role="menuitem" onClick={() => act.mutate("pin")}>
            {c.pinned ? "고정 해제" : "고정"}
          </button>
          <button type="button" role="menuitem" className="danger" onClick={() => act.mutate("delete")}>
            삭제
          </button>
        </div>
      )}
    </div>
  );
}
