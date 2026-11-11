import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "react-router";
import type { FinanceNotePart, Message, PublicPart, Run, StreamEvent } from "@agentlee/shared";
import { conversations, errorText, runs } from "../api.js";
import { TopBar } from "../Shell.js";
import { CONVERSATIONS_KEY, ConvMenu } from "../Sidebar.js";

/**
 * Minimal chat screen for the shell (#13): history, plain-text streaming, stop. Rich rendering (markdown, code,
 * math, tools, citations) is #14.
 */

type Live = {
  runId: string;
  messageId: string;
  text: string;
  tools: { callId: string; name: string; done: boolean }[];
  notices: string[];
  error?: string;
};

const RUNTIME: Record<string, string> = { "claude-code": "Claude", codex: "Codex" };

/** Follows a run's event stream. EventSource reconnects by itself and resumes from Last-Event-ID. */
function useRunStream(run: Run | null | undefined, onEnd: () => void): Live | null {
  const [state, setState] = useState<Live | null>(null);
  const endRef = useRef(onEnd);
  useEffect(() => {
    endRef.current = onEnd;
  });
  const runId = run && run.endedAt === null ? run.id : null;
  const messageId = run?.assistantMessageId ?? "";
  useEffect(() => {
    if (!runId) return;
    const fresh = (l: Live | null): Live =>
      l?.runId === runId ? l : { runId, messageId, text: "", tools: [], notices: [] };
    const update = (fn: (l: Live) => Live) => setState((l) => fn(fresh(l)));
    const es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
    // Our "error" event shares its name with EventSource's own connection-error event (which has no data).
    const on = (type: StreamEvent["type"], fn: (e: StreamEvent) => void) =>
      es.addEventListener(type, (m) => {
        const data = (m as MessageEvent<string>).data;
        if (typeof data === "string") fn(JSON.parse(data) as StreamEvent);
      });
    on("delta", (e) => e.type === "delta" && update((l) => ({ ...l, text: l.text + e.text })));
    on("tool_start", (e) => {
      if (e.type === "tool_start")
        update((l) => ({ ...l, tools: [...l.tools, { callId: e.callId, name: e.name, done: false }] }));
    });
    on("tool_end", (e) => {
      if (e.type === "tool_end")
        update((l) => ({
          ...l,
          tools: l.tools.map((t) => (t.callId === e.callId ? { ...t, done: true } : t)),
        }));
    });
    on(
      "notice",
      (e) =>
        e.type === "notice" &&
        update((l) => ({
          ...l,
          // A limit or an expired login names the runtimes to go on with (the switch itself is the chip, #19).
          notices: [
            ...l.notices,
            e.switchTo?.length
              ? `${e.message} (이어갈 수 있는 런타임: ${e.switchTo.map((r) => RUNTIME[r] ?? r).join(", ")})`
              : e.message,
          ],
        })),
    );
    on("error", (e) => e.type === "error" && update((l) => ({ ...l, error: e.message })));
    on("done", () => {
      es.close();
      endRef.current();
    });
    // A closed stream that will not reconnect (403/410 or the server ended it): show the saved state.
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) endRef.current();
    };
    return () => es.close();
  }, [runId, messageId]);
  if (!runId) return null;
  return state?.runId === runId ? state : { runId, messageId, text: "", tools: [], notices: [] };
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
  const refresh = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["messages", id] }),
      qc.invalidateQueries({ queryKey: ["active-run", id] }),
      qc.invalidateQueries({ queryKey: ["conversation", id] }),
      qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY }),
    ]);
  const live = useRunStream(active.data, () => void refresh());
  const bottom = useRef<HTMLDivElement>(null);
  const newestId = list?.at(-1)?.id; // scroll down for new messages, not when older ones load above
  // Braces matter: newer browsers return a Promise from scrollIntoView, and an effect must not return one.
  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [newestId, live?.text]);

  const send = async (text: string) => {
    const r = await conversations.send(id, text);
    qc.setQueryData(["active-run", id], r.run);
    await qc.invalidateQueries({ queryKey: ["messages", id] });
  };

  if (conv.isError) return <Missing error={conv.error} />;
  return (
    <>
      <TopBar title={conv.data?.title ?? "…"}>{conv.data && <ConvMenu c={conv.data} />}</TopBar>
      <div className="thread" data-testid="thread">
        <div className="col">
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
          {list?.map((m) =>
            live && m.id === live.messageId ? (
              <LiveReply key={m.id} live={live} />
            ) : (
              <MessageView key={m.id} m={m} />
            ),
          )}
          <div ref={bottom} />
        </div>
      </div>
      <Composer
        busy={!!live}
        onSend={send}
        onStop={live ? () => void runs.interrupt(live.runId).then(refresh) : undefined}
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
      <Composer busy={false} onSend={send} autoFocus />
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

function textOf(parts: PublicPart[]) {
  return parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("");
}

function MessageView({ m }: { m: Message }) {
  if (m.role === "user")
    return (
      <div className="msg user">
        <div className="bubble">{textOf(m.parts as PublicPart[])}</div>
      </div>
    );
  const tools = m.parts.filter((p) => p.type === "tool_call");
  return (
    <div className="msg assistant" data-testid="assistant">
      {tools.length > 0 && (
        <details className="tools">
          <summary>도구 {tools.length}개 사용</summary>
          {tools.map((t) =>
            t.type === "tool_call" ? (
              <div key={t.id} className="t">
                {t.name}
              </div>
            ) : null,
          )}
        </details>
      )}
      <div className="text">{textOf(m.parts as PublicPart[])}</div>
      {m.parts.map((p, i) => (p.type === "finance_note" ? <FinanceNote key={i} note={p} /> : null))}
      <div className="meta">
        {m.runtime && <span>{RUNTIME[m.runtime] ?? m.runtime}</span>}
        {m.model && <span>· {m.model}</span>}
        {m.status === "stopped" && <span className="badge warn">중지됨</span>}
        {m.status === "error" && <span className="badge err">오류</span>}
      </div>
    </div>
  );
}

/**
 * The server's note under an answer that used a finance tool (#30, FR-7.6·7.8): where the numbers come from and
 * as of when, a warning when the answer itself left that out, and the disclaimer.
 */
function FinanceNote({ note }: { note: FinanceNotePart }) {
  return (
    <div className="finance-note" data-testid="finance-note">
      {note.missing.length > 0 && (
        <div className="notice warn" data-testid="finance-missing">
          ⚠️{" "}
          {note.missing.includes("tool_meta")
            ? "일부 숫자는 출처·기준 시각을 확인하지 못했어요."
            : "답변에 출처·기준 시각이 빠진 부분이 있어 아래 기준을 덧붙였어요."}
        </div>
      )}
      {note.sources.length > 0 && (
        <ul className="sources" aria-label="출처·기준 시각">
          {note.sources.map((s) => (
            <li key={s.label}>{s.label}</li>
          ))}
        </ul>
      )}
      <p className="disclaimer">{note.disclaimer}</p>
    </div>
  );
}

function LiveReply({ live }: { live: Live }) {
  const running = live.tools.filter((t) => !t.done);
  return (
    <div className="msg assistant" data-testid="assistant" aria-live="polite">
      {running.length > 0 && (
        <div className="notice info">⏳ {running.map((t) => t.name).join(", ")} 실행 중…</div>
      )}
      {live.notices.map((n, i) => (
        <div key={i} className="notice warn">
          {n}
        </div>
      ))}
      <div className="text">
        {live.text}
        <span className="caret" aria-hidden>
          ▍
        </span>
      </div>
      {live.error && <div className="notice err">{live.error}</div>}
    </div>
  );
}

function Composer(props: {
  busy: boolean;
  onSend: (text: string) => Promise<void>;
  onStop?: (() => void) | undefined;
  autoFocus?: boolean;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  return (
    <div className="composer">
      <div className="box">
        <textarea
          aria-label="메시지 입력"
          placeholder="메시지를 입력하세요 (Shift+Enter 줄바꿈)"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          rows={2}
          autoFocus={props.autoFocus}
        />
        <div className="bar">
          {error && (
            <span className="error small" role="alert">
              {error}
            </span>
          )}
          <span className="grow" />
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
