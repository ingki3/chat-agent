import { memo, useCallback, useEffect, useEffectEvent, useRef, useState, type KeyboardEvent } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import { publicParts, type Message, type StartRunResponse } from "@agentlee/shared";
import { conversations, errorText, runs } from "../api.js";
import { CopyButton } from "../chat/CopyButton.js";
import { Parts, RUNTIME_LABEL, textOf } from "../chat/Parts.js";
import { useStickToBottom } from "../chat/scroll.js";
import { useRunStream, type LiveReply, type Notice } from "../chat/stream.js";
import { TopBar } from "../Shell.js";
import { CONVERSATIONS_KEY, ConvMenu } from "../Sidebar.js";

/**
 * Chat screen (#14): streamed replies with markdown, code, math and tool status; stop, regenerate the last
 * reply, edit a message and send again; follows the bottom unless the user scrolls up; connection notices.
 */

/** What a finished run leaves behind for its message: notices and errors are not stored with the message. */
type AfterRun = { notices: Notice[]; error?: { code: string; message: string } };

/** Errors after which the conversation can carry on with another runtime (FR-11.8; the switch itself is #19). */
const SWITCHABLE = new Set([
  "usage_limit",
  "auth_expired",
  "connection_lost",
  "runtime_disconnected",
  "no_runtime",
]);

const COMPOSER_INPUT = "composer-input";
const time = new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit" });
const dotClass = (r: string | null) => (r === "codex" ? "codex" : r === "claude-code" ? "claude" : "none");

function useOnline() {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}

export function ChatPage() {
  const { id = "" } = useParams();
  const qc = useQueryClient();
  const conv = useQuery({ queryKey: ["conversation", id], queryFn: () => conversations.get(id) });
  // Newest page first; "이전 메시지 보기" loads older pages (shown above).
  const messages = useInfiniteQuery({
    queryKey: ["messages", id],
    queryFn: ({ pageParam }) => conversations.messages(id, pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const list = messages.data ? [...messages.data.pages].reverse().flatMap((p) => p.items) : undefined;
  const active = useQuery({ queryKey: ["active-run", id], queryFn: () => conversations.activeRun(id) });
  const [after, setAfter] = useState<Record<string, AfterRun>>({});
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const online = useOnline();

  const refresh = async () => {
    // Messages first: the saved reply must be there before the live one is let go (no flash of stale text).
    await qc.invalidateQueries({ queryKey: ["messages", id] });
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["active-run", id] }),
      qc.invalidateQueries({ queryKey: ["conversation", id] }),
      qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY }),
    ]);
  };
  const { live, reconnect } = useRunStream(
    active.data,
    (last) => {
      if (last.notices.length || last.error)
        setAfter((a) => ({
          ...a,
          [last.messageId]: { notices: last.notices, ...(last.error ? { error: last.error } : {}) },
        }));
      void refresh();
    },
    () => void refresh(),
  );
  // Gave up on the stream: keep looking at the run now and then — once it has ended, the saved reply shows.
  const lost = !!live?.lost;
  const recheck = useEffectEvent(() => void refresh());
  useEffect(() => {
    if (!lost) return;
    const t = setInterval(recheck, 5000);
    return () => clearInterval(t);
  }, [lost]);
  // A lost stream does not keep the conversation busy: edit, regenerate and send are available again.
  const busy = (!!live && !lost) || starting;

  const { scroller, content, away, toBottom } = useStickToBottom();

  /** send / edit / regenerate: the response names the run that writes the reply. */
  const start = useCallback(
    async (call: () => Promise<StartRunResponse>) => {
      setStarting(true);
      setActionError(null);
      try {
        const r = await call();
        qc.setQueryData(["active-run", id], r.run);
        await qc.invalidateQueries({ queryKey: ["messages", id] });
        toBottom();
      } finally {
        setStarting(false);
      }
    },
    [id, qc, toBottom],
  );
  const send = (text: string) => start(() => conversations.send(id, text));
  // Stable callbacks: messages are memoised and must not re-render on every streamed frame.
  const edit = useCallback(
    (messageId: string, text: string) => start(() => conversations.edit(id, messageId, text)),
    [id, start],
  );
  const regenerate = useCallback(
    (messageId: string) =>
      void start(() => conversations.regenerate(id, messageId)).catch((e: unknown) =>
        setActionError(errorText(e)),
      ),
    [id, start],
  );
  const stop = live
    ? () =>
        void runs
          .interrupt(live.runId)
          .then(refresh)
          .catch((e: unknown) => setActionError(errorText(e)))
    : undefined;

  const lastAssistant = list?.findLast((m) => m.role === "assistant");
  const chip = lastAssistant?.runtime
    ? { runtime: lastAssistant.runtime, model: lastAssistant.model }
    : { runtime: conv.data?.lastRuntime ?? null, model: null };

  if (conv.isError) return <Missing error={conv.error} />;
  return (
    <>
      <TopBar title={conv.data?.title ?? "…"}>{conv.data && <ConvMenu c={conv.data} />}</TopBar>
      <div className="thread" data-testid="thread" ref={scroller}>
        <div className="col" ref={content}>
          {messages.hasNextPage && (
            <button
              type="button"
              className="ghost small older"
              disabled={messages.isFetchingNextPage}
              onClick={() => void messages.fetchNextPage()}
            >
              {messages.isFetchingNextPage ? "불러오는 중…" : "이전 메시지 보기"}
            </button>
          )}
          {messages.isError && (
            <div className="notice err" role="alert">
              메시지를 불러오지 못했어요. {errorText(messages.error)}{" "}
              <button type="button" className="small" onClick={() => void messages.refetch()}>
                다시 시도
              </button>
            </div>
          )}
          {list?.map((m) =>
            m.role === "user" ? (
              <UserMessage key={m.id} m={m} canEdit={!busy} onEdit={edit} />
            ) : m.role === "assistant" ? (
              <AssistantMessage
                key={m.id}
                m={m}
                live={live && m.id === live.messageId ? live : null}
                after={after[m.id]}
                canRegenerate={!busy && m.id === lastAssistant?.id}
                onRegenerate={regenerate}
                onReconnect={reconnect}
                onStop={stop}
              />
            ) : null,
          )}
        </div>
      </div>
      {away && (
        <div className="jump">
          <button type="button" className="small" onClick={toBottom}>
            ↓ 맨 아래로
          </button>
        </div>
      )}
      {!online && (
        <div className="notice warn banner" role="status">
          오프라인이에요 — 다시 연결되면 이어서 받아와요.
        </div>
      )}
      {actionError && (
        <div className="notice err banner" role="alert">
          {actionError}
        </div>
      )}
      <Composer
        busy={busy}
        onSend={send}
        onStop={lost ? undefined : stop}
        runtime={chip.runtime}
        model={chip.model}
      />
    </>
  );
}

/** "/": nothing to choose first — type and go (PRD FR-3.5). */
export function NewChatPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const send = async (text: string) => {
    const c = await conversations.create();
    const r = await conversations.send(c.id, text);
    qc.setQueryData(["active-run", c.id], r.run);
    await qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
    navigate(`/c/${c.id}`);
  };
  return (
    <>
      <TopBar title={<span className="muted">새 대화</span>} />
      <div className="thread">
        <div className="empty">
          <h1>무엇을 도와드릴까요?</h1>
          <p className="muted">질문을 입력하면 바로 시작해요.</p>
        </div>
      </div>
      <Composer busy={false} onSend={send} autoFocus runtime={null} model={null} />
    </>
  );
}

function Missing({ error }: { error: unknown }) {
  return (
    <>
      <TopBar title="대화" />
      <div className="empty">
        <h1>대화를 열 수 없어요</h1>
        <p className="muted">{errorText(error)}</p>
      </div>
    </>
  );
}

const UserMessage = memo(function UserMessage({
  m,
  canEdit,
  onEdit,
}: {
  m: Message;
  canEdit: boolean;
  onEdit: (messageId: string, text: string) => Promise<void>;
}) {
  const text = textOf(publicParts(m.parts));
  const [editing, setEditing] = useState<string | null>(null);
  // Keyboard users keep their place: cancelling returns to "✎ 수정", sending moves on to the composer.
  const editButton = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (!refocus.current || editing !== null) return;
    refocus.current = false;
    editButton.current?.focus();
  }, [editing]);
  const cancel = () => {
    refocus.current = true;
    setEditing(null);
  };
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const t = editing?.trim();
    if (!t || saving) return;
    setSaving(true);
    setError(null);
    try {
      await onEdit(m.id, t);
      setEditing(null);
      document.getElementById(COMPOSER_INPUT)?.focus();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSaving(false);
    }
  };
  if (editing !== null)
    return (
      <div className="msg user editing" data-testid="user-message">
        <div className="editbox">
          <textarea
            aria-label="메시지 수정"
            value={editing}
            rows={3}
            autoFocus
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              } else if (e.key === "Escape") cancel();
            }}
          />
          <div className="small muted">수정하면 이 메시지 뒤의 대화는 새 답으로 바뀌어요.</div>
          {error && (
            <div className="error small" role="alert">
              {error}
            </div>
          )}
          <div className="row">
            <span className="grow" />
            <button type="button" className="ghost" onClick={cancel}>
              취소
            </button>
            <button
              type="button"
              className="primary"
              disabled={!editing.trim() || saving || !canEdit}
              onClick={() => void submit()}
            >
              다시 보내기
            </button>
          </div>
        </div>
      </div>
    );
  return (
    <div className="msg user" data-testid="user-message">
      <div className="bubble">{text}</div>
      <div className="meta">
        <span>{time.format(m.createdAt)}</span>
        {canEdit && (
          <button ref={editButton} type="button" className="ghost small" onClick={() => setEditing(text)}>
            ✎ 수정
          </button>
        )}
      </div>
    </div>
  );
});

const AssistantMessage = memo(function AssistantMessage({
  m,
  live,
  after,
  canRegenerate,
  onRegenerate,
  onReconnect,
  onStop,
}: {
  m: Message;
  live: LiveReply | null;
  after: AfterRun | undefined;
  canRegenerate: boolean;
  onRegenerate: (messageId: string) => void;
  onReconnect: () => void;
  onStop: (() => void) | undefined;
}) {
  const lost = !!live?.lost;
  const streaming = !!live && !lost;
  const parts = live ? live.parts : publicParts(m.parts);
  const notices = live?.notices ?? after?.notices ?? [];
  const error = live?.error ?? after?.error;
  const status = live ? (live.status ?? "streaming") : m.status;
  const text = textOf(parts);
  return (
    <div
      className={`msg assistant${streaming ? " streaming" : ""}`}
      data-testid="assistant"
      data-status={lost ? "lost" : status}
      aria-busy={streaming || undefined}
    >
      {notices.map((n, i) => (
        <div key={i} className={`notice ${n.level}`} data-testid="notice">
          {n.message}
          {/* A limit or an expired login names the runtimes to go on with (the switch itself is the chip, #19). */}
          {n.switchTo?.length
            ? ` (이어갈 수 있는 런타임: ${n.switchTo.map((r) => RUNTIME_LABEL[r] ?? r).join(", ")})`
            : null}
        </div>
      ))}
      <Parts parts={parts} streaming={streaming} />
      {streaming && (
        <div className="row small muted generating" role="status">
          <span className={`dot ${dotClass(m.runtime)}`} />
          {parts.length ? "응답 생성 중…" : "응답을 기다리는 중…"}
          <span className="caret" aria-hidden>
            ▍
          </span>
        </div>
      )}
      {lost && (
        <div className="notice warn fx" role="alert">
          <span>
            연결이 끊겨 응답을 더 받아오지 못했어요. 응답은 서버에서 계속 만들어지고 있을 수 있어요.
          </span>
          <button type="button" className="small" onClick={onReconnect}>
            다시 연결
          </button>
          {onStop && (
            <button type="button" className="small" onClick={onStop}>
              ■ 중지
            </button>
          )}
        </div>
      )}
      {live?.reconnecting && (
        <div className="notice warn" role="status">
          연결이 끊겼어요 — 다시 연결하는 중…
        </div>
      )}
      {(error || status === "error") && (
        <div className="notice err fx" role="alert">
          <span>{error?.message ?? "응답이 끝나지 못했어요."}</span>
          {error && SWITCHABLE.has(error.code) && (
            <button
              type="button"
              className="small"
              onClick={() => document.getElementById("runtime-chip")?.click()}
            >
              다른 런타임으로 이어가기
            </button>
          )}
        </div>
      )}
      <div className="meta">
        {m.runtime && <span className={`dot ${dotClass(m.runtime)}`} />}
        {m.runtime && <span>{RUNTIME_LABEL[m.runtime] ?? m.runtime}</span>}
        {m.model && <span>· {m.model}</span>}
        <span>· {time.format(m.createdAt)}</span>
        {status === "stopped" && <span className="badge warn">중지됨</span>}
        {status === "error" && <span className="badge err">오류</span>}
      </div>
      {!streaming && (
        <div className="actions">
          {text && <CopyButton text={text} label="답변 복사" />}
          {canRegenerate && (
            <button type="button" onClick={() => onRegenerate(m.id)}>
              ↻ 다시 생성
            </button>
          )}
        </div>
      )}
    </div>
  );
});

function Composer(props: {
  busy: boolean;
  onSend: (text: string) => Promise<void>;
  onStop?: (() => void) | undefined;
  autoFocus?: boolean;
  runtime: string | null;
  model: string | null;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chipOpen, setChipOpen] = useState(false);
  const submit = async () => {
    const t = text.trim();
    if (!t || sending || props.busy) return;
    setSending(true);
    setError(null);
    try {
      await props.onSend(t);
      setText("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };
  const chipLabel = props.runtime
    ? [RUNTIME_LABEL[props.runtime] ?? props.runtime, props.model].filter(Boolean).join(" · ")
    : "기본값";
  return (
    <div className="composer">
      <div className="box">
        <textarea
          id={COMPOSER_INPUT}
          aria-label="메시지 입력"
          placeholder="메시지를 입력하세요 (Shift+Enter 줄바꿈)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          rows={2}
          autoFocus={props.autoFocus}
        />
        <div className="bar">
          {/* File upload arrives with #22. */}
          <button
            type="button"
            className="ghost"
            aria-label="파일 첨부"
            title="파일 첨부는 곧 지원돼요"
            disabled
          >
            📎
          </button>
          {error && (
            <span className="error small" role="alert">
              {error}
            </span>
          )}
          <span className="grow" />
          {/* Runtime / model switching arrives with #19; the chip already shows who answers. */}
          <span className="chipwrap">
            <button
              type="button"
              id="runtime-chip"
              className="rtchip"
              aria-expanded={chipOpen}
              onClick={() => setChipOpen((o) => !o)}
            >
              <span className={`dot ${dotClass(props.runtime)}`} />
              <span className="rt-name">{chipLabel}</span>
            </button>
            {chipOpen && (
              <span className="pop open small" role="status">
                런타임·모델 바꾸기는 곧 지원돼요. 지금은 이 대화의 런타임으로 이어서 답해요.
              </span>
            )}
          </span>
          {props.onStop ? (
            <button type="button" onClick={props.onStop}>
              ■ 중지
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={!text.trim() || sending || props.busy}
              onClick={() => void submit()}
            >
              보내기
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
