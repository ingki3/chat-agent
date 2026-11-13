import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SHARE_REVOKE_NOTICE, type PublicPart, type Share, type ShareAudience } from "@agentlee/shared";
import { ApiError, conversations, errorText, files, shares, SHARES_KEY } from "../api.js";
import { Parts } from "../chat/Parts.js";
import { ArtifactOpenContext } from "../artifacts/ArtifactPanel.js";
import { TopBar } from "../Shell.js";

const MODE_LABEL = { live: "살아 있는 공유", snapshot: "이 메시지까지" } as const;

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
function TargetPicker({ value, onChange }: { value: TargetDraft; onChange: (t: TargetDraft) => void }) {
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
  const msgs = useQuery({
    queryKey: ["conversations", conversationId, "share-messages"],
    queryFn: () => conversations.messages(conversationId),
    enabled: !!conversationId && mode === "snapshot",
  });
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
      {mode === "snapshot" && (
        <label>
          이 메시지까지{" "}
          <select aria-label="경계 메시지" value={boundary} onChange={(e) => setBoundary(e.target.value)}>
            <option value="">고르세요</option>
            {(msgs.data?.items ?? [])
              .filter((m) => m.role !== "system")
              .map((m) => (
                <option key={m.id} value={m.id}>
                  {m.role === "user" ? "나" : "답"}:{" "}
                  {m.parts
                    .flatMap((p) => (p.type === "text" ? [p.text] : []))
                    .join(" ")
                    .slice(0, 40)}
                </option>
              ))}
          </select>
        </label>
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

/** One of my shares: change who it is for, or turn it off (with what a revoke cannot take back). */
function MyShare({ s }: { s: Share }) {
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
        <span className="muted small">{new Date(s.createdAt).toLocaleString("ko-KR")}</span>
      </div>
      {s.revokedAt === null ? (
        <>
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
            <span className="muted small">
              {s.ownerName} · {MODE_LABEL[s.mode]} · {new Date(s.createdAt).toLocaleString("ko-KR")}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * `/shared` — family sharing (#29): the minimum to share, change, revoke and open what is shared with me. The
 * full share screens (from the conversation menu, read receipts, "이어서 대화하기") are #52.
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
          {d.share.ownerName} 님이 {new Date(d.share.createdAt).toLocaleString("ko-KR")}에 공유했어요 · 읽기
          전용
        </p>
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
