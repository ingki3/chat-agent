import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PUBLIC_LINK_DAYS, type PublicLink, type PublicLinkCheck } from "@agentlee/shared";
import { errorText, publicLinks, PUBLIC_LINKS_KEY } from "../api.js";
import "../shares/shares.css";

export const when = (t: number) => new Date(t).toLocaleString("ko-KR");
const STATUS_LABEL = { active: "열림", expired: "만료됨", disabled: "꺼짐" } as const;

/** The days field as the server takes it: a whole number 1–365, else undefined. */
export function daysOf(raw: string): number | undefined {
  const n = Number(raw);
  return /^\d+$/.test(raw.trim()) && n >= PUBLIC_LINK_DAYS.min && n <= PUBLIC_LINK_DAYS.max ? n : undefined;
}

/** What the pre-publish check found, as the dialog says it: a block, warnings and a notice. */
export function checkNotices(c: PublicLinkCheck): { level: "block" | "warn" | "info"; text: string }[] {
  const out: { level: "block" | "warn" | "info"; text: string }[] = [];
  if (c.secret)
    out.push({
      level: "block",
      text: "이 버전에 비밀 값(키·토큰)이 들어 있어 공개할 수 없어요. 지운 새 버전을 만드세요.",
    });
  const personal = [c.emails ? `이메일 주소 ${c.emails}개` : "", c.phones ? `전화번호 ${c.phones}개` : ""]
    .filter(Boolean)
    .join(", ");
  if (personal)
    out.push({ level: "warn", text: `개인 정보가 보여요: ${personal}. 공개해도 되는지 확인하세요.` });
  if (c.externalHosts.length)
    out.push({
      level: "info",
      text: `이 문서에 나오는 외부 주소: ${c.externalHosts.join(", ")} — 공개 페이지가 여기서 내용을 불러올 수 있고, 그러면 방문자 정보(IP 등)가 그 사이트에 전달돼요.`,
    });
  return out;
}

/** One link of mine: status, views, expiry, and turning it off. */
export function MyPublicLink({ l, showTitle }: { l: PublicLink; showTitle?: boolean }) {
  const qc = useQueryClient();
  const off = useMutation({
    mutationFn: () => publicLinks.disable(l.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: PUBLIC_LINKS_KEY }),
  });
  return (
    <li className="share-item" data-testid="public-link" data-status={l.status}>
      <div className="row wrap">
        <span className="badge">{STATUS_LABEL[l.status]}</span>
        {showTitle && <strong>{l.artifactTitle || "(제목 없음)"}</strong>}
        <span>v{l.version}</span>
        <span className="muted small" data-testid="public-link-views">
          조회 {l.viewCount}회{l.lastViewedAt !== null ? ` · 마지막 ${when(l.lastViewedAt)}` : ""}
        </span>
        <span className="muted small">
          {l.status === "disabled" && l.disabledAt !== null
            ? `${when(l.disabledAt)}에 끔`
            : `${when(l.expiresAt)}${l.status === "expired" ? "에 만료됨" : "까지"}`}
        </span>
        {l.status === "active" && (
          <button
            type="button"
            className="danger small"
            data-testid="public-link-disable"
            disabled={off.isPending}
            onClick={() => off.mutate()}
          >
            링크 끄기
          </button>
        )}
      </div>
      {off.isError && <p className="notice warn">{errorText(off.error)}</p>}
    </li>
  );
}

function NewLink({ artifactId, version }: { artifactId: string; version: number }) {
  const qc = useQueryClient();
  const [days, setDays] = useState(String(PUBLIC_LINK_DAYS.default));
  const [copied, setCopied] = useState(false);
  const check = useQuery({
    queryKey: [...PUBLIC_LINKS_KEY, "check", artifactId, version],
    queryFn: () => publicLinks.check(artifactId, version),
  });
  const create = useMutation({
    mutationFn: () => publicLinks.create(artifactId, version, daysOf(days)!),
    onSuccess: () => qc.invalidateQueries({ queryKey: PUBLIC_LINKS_KEY }),
  });
  const notices = check.data ? checkNotices(check.data) : [];
  const blocked = !!check.data?.secret;
  // Built by the server from PUBLIC_HOST (https): the address outsiders open, even when made at home on localhost.
  const url = create.data?.url;
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };
  if (url)
    return (
      <div className="card-like" data-testid="public-link-created">
        <h3>링크를 만들었어요</h3>
        <p className="notice warn small">이 주소는 지금 한 번만 보여요. 잃어버리면 새로 만드세요.</p>
        <div className="row">
          <input
            className="grow"
            readOnly
            value={url}
            aria-label="공개 링크 주소"
            data-testid="public-link-url"
            onFocus={(e) => e.currentTarget.select()}
          />
          <button
            type="button"
            data-testid="public-link-copy"
            onClick={() =>
              void navigator.clipboard?.writeText(url).then(
                () => setCopied(true),
                () => setCopied(false),
              )
            }
          >
            {copied ? "복사했어요" : "복사"}
          </button>
        </div>
      </div>
    );
  return (
    <form className="card-like" onSubmit={onSubmit} aria-label="공개 링크 만들기">
      <h3>새 공개 링크 — v{version}</h3>
      <p className="notice warn small" data-testid="public-link-warning">
        링크를 아는 사람은 <b>누구나 로그인 없이</b> 이 버전을 보고 내려받을 수 있어요(가족 밖 사람도). 이후에
        고친 내용은 보이지 않아요. 언제든 끌 수 있어요.
      </p>
      {check.isPending && <p className="muted small">내용을 확인하는 중…</p>}
      {check.isError && <p className="notice warn">{errorText(check.error)}</p>}
      {notices.map((n) => (
        <p
          key={n.text}
          className={`notice small ${n.level === "info" ? "info" : "warn"}`}
          role={n.level === "block" ? "alert" : undefined}
          data-testid={`public-link-${n.level}`}
        >
          {n.text}
        </p>
      ))}
      <label className="row">
        열어 둘 기간{" "}
        <input
          type="number"
          inputMode="numeric"
          min={PUBLIC_LINK_DAYS.min}
          max={PUBLIC_LINK_DAYS.max}
          step={1}
          value={days}
          onChange={(e) => setDays(e.target.value)}
          aria-label="열어 둘 기간(일)"
          data-testid="public-link-days"
          style={{ width: "6em" }}
        />
        일 (1~365일)
      </label>
      <button
        className="primary"
        type="submit"
        data-testid="public-link-create"
        disabled={!check.isSuccess || blocked || daysOf(days) === undefined || create.isPending}
      >
        공개 링크 만들기
      </button>
      {create.isError && <p className="notice warn">{errorText(create.error)}</p>}
    </form>
  );
}

/**
 * "공개 링크 만들기" (#204): a warning that anyone with the link sees the version, what the server's check found in it
 * (a secret value blocks; emails, phone numbers and external hosts are warned about), the days it stays open (1–365,
 * default 7), the link shown once with a copy button, and this artifact's links (views, expiry, turn off).
 */
export function PublicLinkDialog({
  artifactId,
  version,
  title,
  onClose,
}: {
  artifactId: string;
  version: number;
  title: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const list = useLinkPages(artifactId);
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="share-dialog"
      data-testid="public-link-dialog"
      aria-labelledby={titleId}
      onClose={onClose}
      onKeyDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        if (e.target === dialog.current) dialog.current.close();
      }}
    >
      <div className="share-body">
        <div className="share-head">
          <h2 id={titleId}>공개 링크</h2>
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
          <strong>{title || "(제목 없음)"}</strong>
        </p>
        <NewLink artifactId={artifactId} version={version} />
        {list.isError && <p className="notice warn">{errorText(list.error)}</p>}
        <LinkList list={list} title="이 아티팩트의 공개 링크" />
      </div>
    </dialog>
  );
}

/** The button in the artifact's toolbar — shown to its owner, when the server offers public links. */
export function PublicLinkButton({
  artifactId,
  version,
  title,
  className,
}: {
  artifactId: string;
  version: number;
  title: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const settings = useQuery({ queryKey: [...PUBLIC_LINKS_KEY, "settings"], queryFn: publicLinks.settings });
  if (!settings.data?.enabled) return null;
  return (
    <>
      <button
        ref={button}
        type="button"
        className={className ?? "small"}
        aria-haspopup="dialog"
        data-testid="public-link-open"
        onClick={() => setOpen(true)}
      >
        🔗 공개 링크 만들기
      </button>
      {open && (
        <PublicLinkDialog
          artifactId={artifactId}
          version={version}
          title={title}
          onClose={() => {
            setOpen(false);
            button.current?.focus();
          }}
        />
      )}
    </>
  );
}

/**
 * The pages of a list as one: each link once, in the place it first appeared, with the state of the **latest** page
 * that has it (review #209 — a link turned off elsewhere between two pages shows as off, never with a stale "끄기").
 */
export function mergePages<T extends { id: string }>(pages: readonly { active: T[]; history: T[] }[]): T[] {
  const byId = new Map<string, T>();
  for (const p of pages) for (const l of [...p.active, ...p.history]) byId.set(l.id, l);
  return [...byId.values()];
}

/** My links (of one artifact, or all): every open one on the first page, then the history page by page. */
function useLinkPages(artifactId?: string) {
  return useInfiniteQuery({
    queryKey: [...PUBLIC_LINKS_KEY, "pages", artifactId ?? "all"],
    queryFn: ({ pageParam }) =>
      publicLinks.mine({
        ...(artifactId ? { artifactId } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

function LinkList({
  list,
  title,
  showTitle,
  empty,
}: {
  list: ReturnType<typeof useLinkPages>;
  title?: string;
  showTitle?: boolean;
  empty?: string;
}) {
  const pages = list.data?.pages ?? [];
  const links = mergePages(pages);
  return (
    <>
      {list.isError && <p className="notice warn">{errorText(list.error)}</p>}
      {!links.length && empty && <p className="muted small">{empty}</p>}
      {!!links.length && (
        <>
          {title && <h3>{title}</h3>}
          <ul className="share-list" data-testid="public-link-list">
            {links.map((l) => (
              <MyPublicLink key={l.id} l={l} {...(showTitle ? { showTitle } : {})} />
            ))}
          </ul>
        </>
      )}
      {list.hasNextPage && (
        <button
          type="button"
          className="ghost small"
          data-testid="public-link-more"
          disabled={list.isFetchingNextPage}
          onClick={() => void list.fetchNextPage()}
        >
          {list.isFetchingNextPage ? "불러오는 중…" : "지난 링크 더 보기"}
        </button>
      )}
    </>
  );
}

/** 가족 공유 → "내 공개 링크": every open link of mine across artifacts (never cut off), then the history. */
export function MyPublicLinks() {
  const settings = useQuery({ queryKey: [...PUBLIC_LINKS_KEY, "settings"], queryFn: publicLinks.settings });
  const list = useLinkPages();
  const any = !!list.data?.pages.some((p) => p.active.length || p.history.length);
  if (!settings.data?.enabled && !any) return null;
  return (
    <section aria-label="내 공개 링크" data-testid="my-public-links">
      <h2>내 공개 링크</h2>
      <p className="muted small">
        가족 밖 사람도 로그인 없이 여는 링크예요. 켜져 있는 링크 {settings.data?.active ?? 0}/
        {settings.data?.maxActive ?? 20}개.
      </p>
      <LinkList list={list} showTitle empty="아직 만든 공개 링크가 없어요." />
    </section>
  );
}
