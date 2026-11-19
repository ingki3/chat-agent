import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { errorText, publicLinks } from "../api.js";

const KEY = ["admin", "public-links"] as const;
const time = (ms: number) => new Date(ms).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
const STATUS = { active: "열림", expired: "만료됨", disabled: "꺼짐" } as const;

/**
 * 관리자 → 공개 링크 (#204): how many links are open, expired or off, and per link whose it is, when it expires and
 * how often it was opened — with "끄기". Never the artifact's title or content (FR-1.5).
 */
export function PublicLinksAdmin() {
  const qc = useQueryClient();
  // The first page: counts and every open link (complete); then the history page by page.
  const q = useInfiniteQuery({
    queryKey: KEY,
    queryFn: ({ pageParam }) => publicLinks.adminList(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const off = useMutation({
    mutationFn: publicLinks.adminDisable,
    onSettled: () => qc.invalidateQueries({ queryKey: KEY }),
  });
  const first = q.data?.pages[0];
  const d = first && {
    ...first,
    items: (q.data?.pages ?? []).flatMap((p) => [...p.active, ...p.history]),
  };
  return (
    <section className="admin" aria-label="공개 링크" data-testid="admin-public-links">
      <h2>공개 링크</h2>
      {q.isError && <p className="error small">{errorText(q.error)}</p>}
      {d && (
        <>
          <p className="muted small">
            {d.enabled
              ? "공개 링크가 켜져 있어요(PUBLIC_LINKS_ENABLED=1). 링크를 아는 사람은 로그인 없이 그 버전을 봐요."
              : "공개 링크가 꺼져 있어요(PUBLIC_LINKS_ENABLED). 만든 링크도 열리지 않아요."}{" "}
            제목과 내용은 여기에 보이지 않아요.
          </p>
          <p data-testid="admin-public-link-counts">
            열림 {d.counts.active} · 만료 {d.counts.expired} · 꺼짐 {d.counts.disabled}
          </p>
          {d.items.length === 0 ? (
            <p className="muted small">아직 만든 링크가 없어요.</p>
          ) : (
            <table className="usage-table" aria-label="공개 링크 목록">
              <thead>
                <tr>
                  <th>만든 사람</th>
                  <th>상태</th>
                  <th>만든 때</th>
                  <th>만료</th>
                  <th>조회</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {d.items.map((l) => (
                  <tr key={l.id} data-testid="admin-public-link">
                    <td>{l.ownerName}</td>
                    <td>{STATUS[l.status]}</td>
                    <td>{time(l.createdAt)}</td>
                    <td>{time(l.expiresAt)}</td>
                    <td>{l.viewCount}</td>
                    <td>
                      {l.status === "active" && (
                        <button
                          type="button"
                          className="danger small"
                          disabled={off.isPending}
                          onClick={() => off.mutate(l.id)}
                        >
                          끄기
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {q.hasNextPage && (
            <button
              type="button"
              className="ghost small"
              disabled={q.isFetchingNextPage}
              onClick={() => void q.fetchNextPage()}
            >
              {q.isFetchingNextPage ? "불러오는 중…" : "지난 링크 더 보기"}
            </button>
          )}
          {off.isError && <p className="error small">{errorText(off.error)}</p>}
        </>
      )}
    </section>
  );
}
