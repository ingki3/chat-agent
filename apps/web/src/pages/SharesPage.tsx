import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SHARE_FORK_NOTICE, type PublicPart, type SharedView } from "@agentlee/shared";
import { ApiError, conversations, errorText, files, shares, SHARES_KEY } from "../api.js";
import { CONVERSATIONS_KEY } from "../Sidebar.js";
import {
  BoundaryPicker,
  MODE_LABEL,
  MyShare,
  TargetPicker,
  targetOf,
  when,
  type TargetDraft,
} from "../shares/ShareDialog.js";
import { Parts } from "../chat/Parts.js";
import { ArtifactOpenContext } from "../artifacts/ArtifactPanel.js";
import { TopBar } from "../Shell.js";

/** "가족에게 공유" for one of my conversations: live, or "이 메시지까지" (a frozen snapshot, decision #3). */
function ShareForm() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["conversations", "share-picker"], queryFn: () => conversations.list() });
  const [conversationId, setConversationId] = useState("");
  const [mode, setMode] = useState<"live" | "snapshot">("live");
  const [boundary, setBoundary] = useState("");
  // No one until chosen: "가족 전체" is a choice too, never a default.
  const [target, setTarget] = useState<TargetDraft>({ audience: "users", userIds: [] });
  const audience = targetOf(target);
  const create = useMutation({
    mutationFn: () =>
      shares.shareConversation(conversationId, {
        target: audience!,
        mode,
        ...(mode === "snapshot" ? { boundaryMessageId: boundary } : {}),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: SHARES_KEY }),
  });
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  return (
    <form className="card-like" onSubmit={onSubmit} aria-label="가족에게 공유">
      <h2>가족에게 공유</h2>
      <label>
        대화{" "}
        <select
          aria-label="공유할 대화"
          value={conversationId}
          onChange={(e) => {
            setConversationId(e.target.value);
            setBoundary("");
          }}
        >
          <option value="">고르세요</option>
          {(list.data?.items ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
      </label>
      <div className="row wrap" role="radiogroup" aria-label="공유 범위">
        {(["live", "snapshot"] as const).map((m) => (
          <label key={m}>
            <input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} />{" "}
            {MODE_LABEL[m]}
          </label>
        ))}
      </div>
      {mode === "snapshot" && conversationId && (
        <BoundaryPicker conversationId={conversationId} value={boundary} onChange={setBoundary} />
      )}
      <TargetPicker value={target} onChange={setTarget} />
      <p className="muted small">
        공유받은 가족은 읽기만 해요. 생각 과정과 도구의 원본 결과는 보이지 않아요.
      </p>
      <button
        className="primary"
        type="submit"
        disabled={!conversationId || (mode === "snapshot" && !boundary) || !audience || create.isPending}
      >
        공유하기
      </button>
      {create.isError && <p className="notice warn">{errorText(create.error)}</p>}
      {create.isSuccess && <p className="notice info">공유했어요.</p>}
    </form>
  );
}

function MyShares() {
  const list = useQuery({ queryKey: ["conversations", "share-picker"], queryFn: () => conversations.list() });
  const ids = (list.data?.items ?? []).map((c) => c.id);
  const mine = useQuery({
    queryKey: [...SHARES_KEY, "mine", ids],
    queryFn: async () =>
      (await Promise.all(ids.map(async (id) => ({ id, items: await shares.ofConversation(id) })))).filter(
        (x) => x.items.length,
      ),
    enabled: ids.length > 0,
  });
  const titles = new Map((list.data?.items ?? []).map((c) => [c.id, c.title]));
  return (
    <section aria-label="내가 공유한 것">
      <h2>내가 공유한 것</h2>
      {!mine.data?.length && <p className="muted small">아직 공유한 대화가 없어요.</p>}
      {mine.data?.map((g) => (
        <div key={g.id}>
          <h3>{titles.get(g.id)}</h3>
          <ul className="share-list">
            {g.items.map((s) => (
              <MyShare key={s.id} s={s} />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function Incoming() {
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState("");
  const list = useQuery({
    queryKey: [...SHARES_KEY, "incoming", asked],
    queryFn: () => shares.incoming(asked),
  });
  return (
    <section aria-label="나에게 공유된 것">
      <h2>나에게 공유된 것</h2>
      <form
        className="row"
        role="search"
        onSubmit={(e) => {
          e.preventDefault();
          setAsked(q.trim());
        }}
      >
        <input
          className="grow"
          aria-label="공유받은 것 검색"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="submit">검색</button>
      </form>
      {!list.data?.length && <p className="muted small">공유받은 것이 없어요.</p>}
      <ul className="share-list">
        {list.data?.map((s) => (
          <li key={s.id} data-testid="incoming-share">
            <Link to={`/shared/${encodeURIComponent(s.id)}`}>{s.title || "(제목 없음)"}</Link>{" "}
            {s.viewedAt === null && <span className="badge new-share">새로 공유됨</span>}{" "}
            <span className="muted small">
              {s.ownerName} · {MODE_LABEL[s.mode]} · {when(s.createdAt)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * `/shared` — family sharing (#29, #52): what is shared with me, a share of one of my conversations, and every share
 * I made with who opened it. The same dialog opens from a conversation's and an artifact's menu ("가족에게 공유").
 */
export function SharesPage() {
  return (
    <>
      <TopBar title="👪 가족 공유" />
      <div className="page" data-testid="shares-page">
        <Incoming />
        <ShareForm />
        <MyShares />
      </div>
    </>
  );
}

/**
 * "이어서 대화하기" (#52, FR-14.3·14.4): the share as I see it copied into a new conversation of mine (an artifact
 * share: a conversation holding my copy of the artifact, to change it there), then opened.
 */
function ForkBar({ id, d }: { id: string; d: SharedView }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const fork = useMutation({
    mutationFn: () => shares.fork(id),
    onSuccess: async (c) => {
      await qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
      void navigate(`/c/${encodeURIComponent(c.id)}`);
    },
  });
  const artifact = d.share.itemKind === "artifact";
  return (
    <div className="fork-bar" data-testid="fork-bar">
      <button
        type="button"
        className="primary"
        data-testid="fork"
        disabled={fork.isPending}
        onClick={() => fork.mutate()}
      >
        {fork.isPending ? "복사하는 중…" : artifact ? "내 것으로 복사해서 고치기" : "이어서 대화하기"}
      </button>
      <span className="muted small">{SHARE_FORK_NOTICE}</span>
      {fork.isError && <p className="notice warn">{errorText(fork.error)}</p>}
    </div>
  );
}

/** A shared schedule's result conversation (FR-8.8): whether I am told of its new results. */
function NotifyToggle({ id, on }: { id: string; on: boolean }) {
  const qc = useQueryClient();
  const set = useMutation({
    mutationFn: (next: boolean) => shares.setNotifyResults(id, next),
    onSuccess: () => qc.invalidateQueries({ queryKey: [...SHARES_KEY, "view", id] }),
  });
  return (
    <label className="row small" data-testid="share-notify">
      <input
        type="checkbox"
        checked={set.isPending ? !!set.variables : on}
        disabled={set.isPending}
        onChange={(e) => set.mutate(e.target.checked)}
      />
      새 결과가 생기면 알림 받기
      {set.isError && <span className="notice warn">{errorText(set.error)}</span>}
    </label>
  );
}

/**
 * `/shared/:id` — a shared item, read-only, exactly as the server's projection gives it. A live share refreshes; the
 * share's event stream closes the moment it is turned off or no longer meant for me, and this screen closes with it.
 */
export function SharedViewPage({ id }: { id: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [gone, setGone] = useState(false);
  const view = useQuery({
    queryKey: [...SHARES_KEY, "view", id],
    queryFn: () => shares.view(id),
    retry: false,
    refetchInterval: (q) => (q.state.data?.share.mode === "live" && !gone ? 5000 : false),
    enabled: !gone,
  });
  useEffect(() => {
    if (gone) return;
    const es = new EventSource(shares.eventsUrl(id));
    const close = () => {
      es.close();
      setGone(true);
      qc.removeQueries({ queryKey: [...SHARES_KEY, "view", id] });
    };
    es.addEventListener("revoked", close);
    // A stream that ended and cannot come back (403 on reconnect) is gone too.
    es.onerror = () => {
      if (es.readyState === EventSource.CLOSED) close();
    };
    return () => es.close();
  }, [id, gone, qc]);
  const refused = view.error instanceof ApiError && (view.error.status === 403 || view.error.status === 404);
  if (gone || refused)
    return (
      <>
        <TopBar title="👪 가족 공유" />
        <div className="empty" role="alert" data-testid="share-closed">
          <p>공유가 꺼졌거나 더 이상 나에게 공유되지 않아요.</p>
          <p className="muted small">이미 내려받은 파일과 만든 사본은 그대로 남아요.</p>
          <Link to="/shared">가족 공유로 돌아가기</Link>
        </div>
      </>
    );
  if (view.isError) return <div className="empty">{errorText(view.error)}</div>;
  if (!view.data) return <div className="empty muted">불러오는 중…</div>;
  const d = view.data;
  return (
    <>
      <TopBar title={`👪 ${d.share.title || "공유받은 대화"}`}>
        <span className="badge">{MODE_LABEL[d.share.mode]}</span>
      </TopBar>
      <div className="page" data-testid="shared-view">
        <p className="muted small">
          {d.share.ownerName} 님이 {when(d.share.createdAt)}에 공유했어요 · 읽기 전용
        </p>
        {!d.own && <ForkBar id={id} d={d} />}
        {d.viewer && <NotifyToggle id={id} on={d.viewer.notifyResults} />}
        {/* Artifact cards open the shared artifact's own page (there is no panel here). */}
        <ArtifactOpenContext.Provider
          value={(artifactId) => void navigate(`/a/${encodeURIComponent(artifactId)}`)}
        >
          <ol className="shared-messages">
            {d.messages.map((m) => (
              <li key={m.id} className={`msg ${m.role}`} data-testid="shared-message">
                <Parts parts={m.parts as PublicPart[]} />
              </li>
            ))}
          </ol>
        </ArtifactOpenContext.Provider>
        {d.files.length > 0 && (
          <section aria-label="파일">
            <h2>파일</h2>
            <ul>
              {d.files.map((f) => (
                <li key={f.id}>
                  <a href={files.url(f.id)}>{f.name}</a>
                </li>
              ))}
            </ul>
          </section>
        )}
        {d.artifacts.length > 0 && (
          <section aria-label="아티팩트">
            <h2>아티팩트</h2>
            <ul>
              {d.artifacts.map((a) => (
                <li key={a.id}>
                  <Link to={`/a/${encodeURIComponent(a.id)}`}>{a.title}</Link>{" "}
                  <span className="muted small">v{a.latestVersion}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {d.sources.length > 0 && (
          <section aria-label="출처">
            <h2>출처</h2>
            <ul>
              {d.sources.map((s) => (
                <li key={s.id}>
                  <a href={s.finalUrl ?? s.url} target="_blank" rel="noreferrer noopener">
                    {s.title}
                  </a>{" "}
                  <span className="muted small">{s.site}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </>
  );
}
