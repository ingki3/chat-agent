import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { WatchlistSearchHit, WatchMarket } from "@agentlee/shared";
import { errorText, watchlist, WATCHLIST_KEY } from "../api.js";
import { TopBar } from "../Shell.js";

const MARKET_LABEL: Record<WatchMarket, string> = { KR: "한국", US: "미국" };

/**
 * `/watchlist` — 관심 종목 (#31, FR-7.7): my own list of Korean and US stocks, used when I say "내 관심 종목" in a
 * conversation (`watchlist_get`). Search by name or code (Korean, Naver 증권) or type a US ticker; add; remove. An
 * account without finance skills (the son by default, #30) sees why it is empty instead.
 */
export function WatchlistPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: WATCHLIST_KEY, queryFn: watchlist.list });
  const [q, setQ] = useState("");
  const [asked, setAsked] = useState("");
  const search = useQuery({
    queryKey: [...WATCHLIST_KEY, "search", asked],
    queryFn: ({ signal }) => watchlist.search(asked, signal),
    enabled: asked.length > 0,
    retry: false,
  });
  const add = useMutation({
    mutationFn: (h: WatchlistSearchHit) => watchlist.add(h.market, h.symbol, h.name),
    onSuccess: () => qc.invalidateQueries({ queryKey: WATCHLIST_KEY, exact: true }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => watchlist.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: WATCHLIST_KEY, exact: true }),
  });
  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    setAsked(q.trim());
  };
  const markets = list.data?.markets ?? [];
  const have = new Set((list.data?.items ?? []).map((i) => `${i.market}:${i.symbol}`));

  return (
    <>
      <TopBar title="⭐ 관심 종목" />
      <div className="page" data-testid="watchlist-page">
        {list.isError && <p className="notice warn">{errorText(list.error)}</p>}
        {list.data && markets.length === 0 ? (
          <div className="empty" data-testid="watchlist-no-finance">
            <p>이 계정은 금융 기능을 쓸 수 없어요.</p>
            <p className="muted small">관리자가 금융 스킬을 켜 주면 관심 종목을 담을 수 있어요.</p>
          </div>
        ) : (
          <>
            <p className="muted small">
              대화에서 "내 관심 종목"이라고 하면 이 목록을 써요. 한국 종목은 이름이나 6자리 코드로, 미국
              종목은 티커(AAPL)로 찾아요.
            </p>
            <form className="row watch-search" onSubmit={onSearch} role="search">
              <input
                className="grow"
                aria-label="종목 검색"
                placeholder={markets.includes("KR") ? "삼성전자, 005930, AAPL…" : "AAPL, NVDA…"}
                value={q}
                maxLength={40}
                onChange={(e) => setQ(e.target.value)}
              />
              <button type="submit" disabled={!q.trim()}>
                검색
              </button>
            </form>
            {search.isFetching && <p className="muted small">찾는 중…</p>}
            {search.isError && <p className="notice warn">{errorText(search.error)}</p>}
            {search.data && (
              <ul className="watch-list" aria-label="검색 결과" data-testid="watch-results">
                {search.data.length === 0 && <li className="muted small">찾는 종목이 없어요.</li>}
                {search.data.map((h) => {
                  const added = have.has(`${h.market}:${h.symbol}`);
                  return (
                    <li key={`${h.market}:${h.symbol}`} className="row">
                      <span className="chip small">{MARKET_LABEL[h.market]}</span>
                      <span className="grow">
                        <b>{h.name ?? h.symbol}</b> <span className="muted small">{h.symbol}</span>
                        {h.exchange && <span className="muted small"> · {h.exchange}</span>}
                      </span>
                      <button
                        type="button"
                        className="small"
                        disabled={added || add.isPending}
                        aria-label={`${h.name ?? h.symbol} 추가`}
                        onClick={() => add.mutate(h)}
                      >
                        {added ? "담김" : "추가"}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {add.isError && <p className="notice warn">{errorText(add.error)}</p>}
            <h2 className="watch-h">내 관심 종목</h2>
            {list.data?.items.length === 0 && <p className="muted small">아직 담은 종목이 없어요.</p>}
            <ul className="watch-list" aria-label="내 관심 종목" data-testid="watch-items">
              {list.data?.items.map((i) => (
                <li key={i.id} className="row" data-testid="watch-item">
                  <span className="chip small">{MARKET_LABEL[i.market]}</span>
                  <span className="grow">
                    <b>{i.name ?? i.symbol}</b> <span className="muted small">{i.symbol}</span>
                  </span>
                  <button
                    type="button"
                    className="ghost small"
                    aria-label={`${i.name ?? i.symbol} 제거`}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(i.id)}
                  >
                    제거
                  </button>
                </li>
              ))}
            </ul>
            {remove.isError && <p className="notice warn">{errorText(remove.error)}</p>}
          </>
        )}
      </div>
    </>
  );
}
