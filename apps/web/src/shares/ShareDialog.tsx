import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SHARE_REVOKE_NOTICE, type Message, type Share, type ShareAudience } from "@agentlee/shared";
import { conversations, errorText, shares, SHARES_KEY } from "../api.js";
import "./shares.css";

export const MODE_LABEL = { live: "살아 있는 공유", snapshot: "이 메시지까지" } as const;
const KIND_LABEL = { conversation: "대화", artifact: "아티팩트" } as const;

export const when = (t: number) => new Date(t).toLocaleString("ko-KR");

/**
 * Who a share is for while it is being edited: the whole family, or the accounts ticked — possibly none yet. None is
 * never "the whole family" (unticking the last person must not widen a share): it just cannot be saved.
 */
export type TargetDraft = { audience: "family" } | { audience: "users"; userIds: string[] };
/** The draft as the API takes it, or undefined while no one is chosen. */
export const targetOf = (d: TargetDraft): ShareAudience | undefined =>
  d.audience === "family"
    ? d
    : d.userIds.length
      ? { audience: "users", userIds: d.userIds as [string, ...string[]] }
      : undefined;
const NO_ONE = "공유할 가족을 한 명 이상 고르거나 '가족 전체'를 고르세요.";

/** Who a share is for: "가족 전체" only when picked, or the family accounts ticked (ids from `/api/share-targets`). */
export function TargetPicker({
  value,
  onChange,
}: {
  value: TargetDraft;
  onChange: (t: TargetDraft) => void;
}) {
  const targets = useQuery({ queryKey: [...SHARES_KEY, "targets"], queryFn: shares.targets });
  const chosen = value.audience === "users" ? value.userIds : [];
  const toggle = (id: string, on: boolean) =>
    onChange({ audience: "users", userIds: on ? [...chosen, id] : chosen.filter((x) => x !== id) });
  return (
    <fieldset className="row wrap" data-testid="share-targets">
      <legend className="small muted">누구에게</legend>
      <label>
        <input
          type="checkbox"
          checked={value.audience === "family"}
          onChange={(e) =>
            onChange(e.target.checked ? { audience: "family" } : { audience: "users", userIds: [] })
          }
        />{" "}
        가족 전체
      </label>
      {(targets.data ?? []).map((t) => (
        <label key={t.id}>
          <input
            type="checkbox"
            checked={chosen.includes(t.id)}
            onChange={(e) => toggle(t.id, e.target.checked)}
          />{" "}
          {t.name}
        </label>
      ))}
      {!targetOf(value) && (
        <p className="notice warn small" data-testid="share-no-target">
          {NO_ONE}
        </p>
      )}
    </fieldset>
  );
}

/** 열람 확인 (FR-14.6): for each account the share reaches, whether and when it opened it. */
export function Receipts({ s }: { s: Share }) {
  const seen = new Map(s.views.map((v) => [v.id, v]));
  if (!s.targets.length) return null;
  return (
    <ul className="receipts small" data-testid="share-receipts" aria-label="열람 확인">
      {s.targets.map((t) => {
        const v = seen.get(t.id);
        return (
          <li key={t.id} data-testid="share-receipt" data-seen={v ? "yes" : "no"}>
            <span>{t.name}</span>{" "}
            {v ? (
              <span className="seen">✓ 열어봄 · {when(v.firstViewedAt)}</span>
            ) : (
              <span className="muted">아직 안 열어봄</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** One of my shares: who it is for and who opened it, change who it is for, or turn it off. */
export function MyShare({ s }: { s: Share }) {
  const qc = useQueryClient();
  const [target, setTarget] = useState<TargetDraft>(
    s.audience === "users"
      ? { audience: "users", userIds: s.targets.map((t) => t.id) }
      : { audience: "family" },
  );
  const done = () => qc.invalidateQueries({ queryKey: SHARES_KEY });
  const audience = targetOf(target);
  const change = useMutation({ mutationFn: () => shares.setTarget(s.id, audience!), onSuccess: done });
  const revoke = useMutation({ mutationFn: () => shares.revoke(s.id), onSuccess: done });
  return (
    <li className="share-item" data-testid="my-share">
      <div className="row wrap">
        <span className="badge">{MODE_LABEL[s.mode]}</span>
        <span>{s.audience === "family" ? "가족 전체" : s.targets.map((t) => t.name).join(", ")}</span>
        <span className="muted small">{when(s.createdAt)}</span>
      </div>
      {s.revokedAt === null ? (
        <>
          <Receipts s={s} />
          <TargetPicker value={target} onChange={setTarget} />
          <div className="row wrap">
            <button type="button" onClick={() => change.mutate()} disabled={!audience || change.isPending}>
              대상 바꾸기
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => revoke.mutate()}
              disabled={revoke.isPending}
            >
              공유 끄기
            </button>
          </div>
          <p className="muted small">{SHARE_REVOKE_NOTICE}</p>
        </>
      ) : (
        <p className="notice info" data-testid="share-revoked-notice">
          공유를 껐어요. {SHARE_REVOKE_NOTICE}
        </p>
      )}
      {(change.isError || revoke.isError) && (
        <p className="notice warn">{errorText(change.error ?? revoke.error)}</p>
      )}
    </li>
  );
}

/**
 * The messages a snapshot may end at, oldest first, from pages of the history as the API gives them (each page oldest
 * → newest, newest page first): system lines (dividers) are no boundary.
 */
export function boundaryOptions(
  pages: readonly { items: readonly Message[] }[],
): { id: string; label: string }[] {
  return [...pages]
    .reverse()
    .flatMap((p) => p.items)
    .filter((m) => m.role !== "system")
    .map((m) => ({
      id: m.id,
      label: `${m.role === "user" ? "나" : "답"}: ${m.parts
        .flatMap((p) => (p.type === "text" ? [p.text] : []))
        .join(" ")
        .slice(0, 40)}`,
    }));
}

/** "이 메시지까지": every message of the history can be the boundary — older pages load on request. */
export function BoundaryPicker({
  conversationId,
  value,
  onChange,
}: {
  conversationId: string;
  value: string;
  onChange: (id: string) => void;
}) {
  const msgs = useInfiniteQuery({
    queryKey: ["conversations", conversationId, "share-messages"],
    queryFn: ({ pageParam }) => conversations.messages(conversationId, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const options = boundaryOptions(msgs.data?.pages ?? []);
  return (
    <div className="row wrap">
      <label>
        이 메시지까지{" "}
        <select aria-label="경계 메시지" value={value} onChange={(e) => onChange(e.target.value)}>
          <option value="">고르세요</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      {msgs.hasNextPage && (
        <button
          type="button"
          className="ghost small"
          data-testid="boundary-older"
          disabled={msgs.isFetchingNextPage}
          onClick={() => void msgs.fetchNextPage()}
        >
          {msgs.isFetchingNextPage ? "불러오는 중…" : "이전 메시지 더 불러오기"}
        </button>
      )}
      {msgs.isError && <p className="notice warn small">{errorText(msgs.error)}</p>}
    </div>
  );
}

/**
 * The dialog's status line. A failed read — first load or a refetch over a cached list — is never "비공개": what is
 * cached may be out of date (shared from another tab meanwhile), so it says the state cannot be confirmed.
 */
export function shareStatusText(
  q: { isPending: boolean; isError: boolean },
  active: readonly Share[],
): string {
  if (q.isError) return "공유 상태를 확인할 수 없어요. 잠시 뒤 다시 열어 보세요.";
  if (q.isPending) return "불러오는 중…";
  if (!active.length) return "비공개 — 아직 아무에게도 공유하지 않았어요.";
  const names = active.flatMap((s) =>
    s.audience === "family" ? ["가족 전체"] : s.targets.map((t) => t.name),
  );
  return `공유 중 — ${[...new Set(names)].join(", ")}`;
}

export type ShareItem = { kind: "conversation" | "artifact"; id: string; title: string };

/** A new share of the item: who, and (a conversation) how far — live, or "이 메시지까지" (decision #3). */
function NewShare({ item }: { item: ShareItem }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<"live" | "snapshot">("live");
  const [boundary, setBoundary] = useState("");
  // No one until chosen: "가족 전체" is a choice too, never a default.
  const [target, setTarget] = useState<TargetDraft>({ audience: "users", userIds: [] });
  const audience = targetOf(target);
  const conversation = item.kind === "conversation";
  const create = useMutation({
    mutationFn: () =>
      conversation
        ? shares.shareConversation(item.id, {
            target: audience!,
            mode,
            ...(mode === "snapshot" ? { boundaryMessageId: boundary } : {}),
          })
        : shares.shareArtifact(item.id, { target: audience!, mode: "live" }),
    onSuccess: () => {
      setTarget({ audience: "users", userIds: [] });
      return qc.invalidateQueries({ queryKey: SHARES_KEY });
    },
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <form className="card-like" onSubmit={onSubmit} aria-label="새로 공유하기">
      <h3>새로 공유하기</h3>
      {conversation && (
        <div className="row wrap" role="radiogroup" aria-label="공유 범위">
          {(["live", "snapshot"] as const).map((m) => (
            <label key={m}>
              <input type="radio" name="share-mode" checked={mode === m} onChange={() => setMode(m)} />{" "}
              {m === "live" ? "대화 전체 (새 메시지도 보여요)" : MODE_LABEL[m]}
            </label>
          ))}
        </div>
      )}
      {conversation && mode === "snapshot" && (
        <BoundaryPicker conversationId={item.id} value={boundary} onChange={setBoundary} />
      )}
      <TargetPicker value={target} onChange={setTarget} />
      <p className="muted small">
        {conversation
          ? "공유받은 가족은 읽기만 해요. 생각 과정과 도구의 원본 결과는 보이지 않아요."
          : "공유받은 가족은 보고 내려받을 수 있어요. 고치려면 자기 것으로 복사해서 고쳐요."}
      </p>
      <button
        className="primary"
        type="submit"
        disabled={(mode === "snapshot" && !boundary) || !audience || create.isPending}
      >
        공유하기
      </button>
      {create.isError && <p className="notice warn">{errorText(create.error)}</p>}
      {create.isSuccess && <p className="notice info">공유했어요.</p>}
    </form>
  );
}

/**
 * "가족에게 공유" (#52, FR-14.2·14.6): the item's name and kind, whether it is private or whom it is shared with (and
 * who opened it), a new share, a change of who, or turning one off — with what a revoke cannot take back.
 */
export function ShareDialog({ item, onClose }: { item: ShareItem; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const list = useQuery({
    queryKey: [...SHARES_KEY, "of", item.kind, item.id],
    queryFn: () =>
      item.kind === "conversation" ? shares.ofConversation(item.id) : shares.ofArtifact(item.id),
  });
  // Shares turned off while the dialog is open stay listed (with the notice); older ones do not.
  const [shown] = useState(() => new Set<string>());
  const items = (list.data ?? []).filter((s) => {
    if (s.revokedAt === null) shown.add(s.id);
    return shown.has(s.id);
  });
  const active = items.filter((s) => s.revokedAt === null);
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="share-dialog"
      data-testid="share-dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      // Keys stay in the dialog (Esc closes the dialog only — the browser's own cancel — never the drawer or the
      // panel around it; Tab is the modal's own, not the drawer's focus loop).
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        if (e.target === dialog.current) dialog.current.close();
      }}
    >
      <div className="share-body">
        <div className="share-head">
          <h2 id={titleId}>가족에게 공유</h2>
          <button
            type="button"
            className="ghost small"
            aria-label="닫기"
            onClick={() => dialog.current?.close()}
          >
            ✕
          </button>
        </div>
        <p className="share-what">
          <span className="badge">{KIND_LABEL[item.kind]}</span>{" "}
          <strong>{item.title || "(제목 없음)"}</strong>
        </p>
        <p className="small" data-testid="share-status">
          {shareStatusText(list, active)}
        </p>
        {list.isError && <p className="notice warn">{errorText(list.error)}</p>}
        {items.length > 0 && (
          <ul className="share-list">
            {items.map((s) => (
              <MyShare key={s.id} s={s} />
            ))}
          </ul>
        )}
        <NewShare item={item} />
      </div>
    </dialog>
  );
}

/** A button that opens the dialog for one item; focus comes back to it when the dialog closes. */
export function ShareButton({ item, className }: { item: ShareItem; className?: string }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={button}
        type="button"
        className={className ?? "small"}
        aria-haspopup="dialog"
        data-testid="share-open"
        onClick={() => setOpen(true)}
      >
        👪 가족에게 공유
      </button>
      {open && (
        <ShareDialog
          item={item}
          onClose={() => {
            setOpen(false);
            button.current?.focus();
          }}
        />
      )}
    </>
  );
}
