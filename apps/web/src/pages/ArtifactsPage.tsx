import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { artifactPath } from "@agentlee/shared";
import { artifacts, errorText } from "../api.js";
import { TopBar } from "../Shell.js";
import { KIND_ICON, KIND_LABEL, MY_ARTIFACTS_KEY } from "../artifacts/viewer.js";
import { panelLink } from "../artifacts/ArtifactPanel.js";

const TABS = [
  ["mine", "내가 만든 것"],
  ["shared", "공유받은 것"],
] as const;
type Tab = (typeof TABS)[number][0];

const when = new Intl.DateTimeFormat("ko-KR", {
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * `/artifacts` (#28, PRD FR-6.6): the artifacts I made, across conversations, newest change first — each opens in
 * its conversation's panel. "공유받은 것" is filled by family sharing (#52). The tab is in the address (`?tab=`).
 */
export function ArtifactsPage() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "shared" ? "shared" : "mine";
  return (
    <>
      <TopBar title="🧩 아티팩트" />
      <div className="page wide">
        <div className="tabs" role="tablist" aria-label="아티팩트 목록">
          {TABS.map(([t, label]) => (
            <button
              key={t}
              type="button"
              role="tab"
              id={`artifacts-tab-${t}`}
              aria-selected={tab === t}
              aria-controls={`artifacts-panel-${t}`}
              className={tab === t ? "on" : ""}
              onClick={() => setParams(t === "mine" ? {} : { tab: t }, { replace: true })}
            >
              {label}
            </button>
          ))}
        </div>
        <div role="tabpanel" id={`artifacts-panel-${tab}`} aria-labelledby={`artifacts-tab-${tab}`}>
          {tab === "mine" ? (
            <Mine />
          ) : (
            <div className="empty" data-testid="artifacts-shared-empty">
              <p>아직 공유받은 아티팩트가 없어요.</p>
              <p className="muted small">가족이 아티팩트를 공유하면 여기에 모여요.</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function Mine() {
  const q = useInfiniteQuery({
    queryKey: MY_ARTIFACTS_KEY,
    queryFn: ({ pageParam }) => artifacts.mine(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  if (q.isError)
    return (
      <div className="notice err" role="alert">
        목록을 불러오지 못했어요. {errorText(q.error)}
      </div>
    );
  if (!q.data) return <div className="empty muted">불러오는 중…</div>;
  const items = q.data.pages.flatMap((p) => p.items);
  if (!items.length)
    return (
      <div className="empty" data-testid="artifacts-empty">
        <p>아직 만든 아티팩트가 없어요.</p>
        <p className="muted small">대화에서 차트·표·HTML 페이지를 만들어 달라고 해 보세요.</p>
      </div>
    );
  return (
    <>
      <ul className="art-grid" data-testid="artifact-list">
        {items.map((a) => (
          <li key={a.id} className="art-tile" data-testid="artifact-item">
            <Link className="art-open" to={panelLink(a.conversationId, a.id)}>
              <span className="art-thumb" aria-hidden>
                {KIND_ICON[a.kind]}
              </span>
              <b>{a.title}</b>
            </Link>
            <span className="small muted">
              {KIND_LABEL[a.kind]} · v{a.latestVersion} · {when.format(a.updatedAt)}
            </span>
            <span className="small muted ellipsis">💬 {a.conversationTitle}</span>
            <Link className="small" to={artifactPath(a.id)}>
              ↗ 따로 열기
            </Link>
          </li>
        ))}
      </ul>
      {q.hasNextPage && (
        <button
          type="button"
          className="ghost small"
          disabled={q.isFetchingNextPage}
          onClick={() => void q.fetchNextPage()}
        >
          {q.isFetchingNextPage ? "불러오는 중…" : "더 보기"}
        </button>
      )}
    </>
  );
}
