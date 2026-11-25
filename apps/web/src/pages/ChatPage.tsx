import {
  memo,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocation, useNavigate, useParams } from "react-router";
import {
  publicParts,
  type ChangeSettingsRequest,
  type ChatSettings,
  type Conversation,
  type Message,
  type Run,
  type StartRunResponse,
  type UploadedFile,
} from "@agentlee/shared";
import {
  ApiError,
  conversations,
  errorText,
  files as filesApi,
  runs,
  settings as settingsApi,
  MEMORY_PROPOSALS_KEY,
  research,
} from "../api.js";
import { AttachButton, AttachmentChips, useAttachments } from "../chat/Attachments.js";
import { ChipChoice, differs, noticeText, takeFallbackNotice, withoutNotice } from "../chat/chip.js";
import { CopyButton } from "../chat/CopyButton.js";
import { rereadQuery } from "../chat/reread.js";
import { listBusy, olderStep, type OlderAsk } from "../chat/older-pages.js";
import {
  forgetReadsAfterEnd,
  nextEnding,
  pageSignal,
  settleEnd,
  startSettleLoop,
  type Ending,
} from "../chat/settle.js";
import { IDLE, enter, free, type Deferred, type Queued } from "../chat/deferred-send.js";
import { DividerView, FileRef, Parts, RUNTIME_LABEL, textOf } from "../chat/Parts.js";
import { RuntimeChip } from "../chat/RuntimeChip.js";
import { useStickToBottom } from "../chat/scroll.js";
import { useRunStream, type LiveReply } from "../chat/stream.js";
import { takeAfter, type AfterRun } from "../chat/after-run.js";
import { TopBar } from "../Shell.js";
import { CONVERSATIONS_KEY, ConvMenu } from "../Sidebar.js";
import { ResearchToggle } from "../citations/ResearchToggle.js";
import { ReferencesButton } from "../citations/ReferencesExport.js";
import { MY_ARTIFACTS_KEY } from "../artifacts/viewer.js";
import { markStartedHere, useAutoShow } from "../artifacts/ArtifactCard.js";
import { FileViewContext } from "../files/context.js";
import { DiagramFixContext, type DiagramFix } from "../chat/diagram-fix.js";

/**
 * Chat screen (#14): streamed replies with markdown, code, math and tool status; stop, regenerate the last
 * reply, edit a message and send again; follows the bottom unless the user scrolls up; connection notices.
 */

/** Errors after which the conversation can carry on with another runtime (FR-11.8; the switch itself is #19). */
const SWITCHABLE = new Set([
  "usage_limit",
  "auth_expired",
  "connection_lost",
  "runtime_disconnected",
  "no_runtime",
]);

const COMPOSER_INPUT = "composer-input";
/** A result link (`#m-<id>`) loads at most this many older pages looking for its message (review #116). */
const SEARCH_PAGES = 20;
const linkKeyOf = (id: string, hash: string) => `${id}${hash}`;
/** What the chip may offer (#19): allowed runtimes with a passed connection. */
const USABLE_KEY = ["runtimes", "usable"] as const;
const useUsableRuntimes = () => useQuery({ queryKey: USABLE_KEY, queryFn: settingsApi.usableRuntimes });
const NO_FILES: readonly UploadedFile[] = [];
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
  // Read again every minute while visible (review #116): a schedule result arriving in the open conversation is
  // noticed here, whatever the sidebar shows (a search, another page).
  const conv = useQuery({
    queryKey: ["conversation", id],
    queryFn: () => conversations.get(id),
    refetchInterval: 60_000,
  });
  // Newest page first; "이전 메시지 보기" loads older pages (shown above).
  const messages = useInfiniteQuery({
    queryKey: ["messages", id],
    // The signal reaches the request: when the screen goes, a read still on its way is cancelled with it. Pages read by
    // the settle loop also get a time limit each (a hung request fails, the loop tries again); others wait.
    queryFn: async ({ pageParam, signal }) => {
      const page = pageSignal(qc, id, signal);
      try {
        return await conversations.messages(id, pageParam, page.signal);
      } finally {
        page.done();
      }
    },
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const list = messages.data ? [...messages.data.pages].reverse().flatMap((p) => p.items) : undefined;
  // The run this page just started (review #116): an answer to an `active-run` request sent before it (a background
  // refetch still in flight, `null`) never replaces it — the stream would close and the reply never come.
  const startedHere = useRef<{ id: string; runId: string; at: number } | null>(null);
  // A reply whose end is being settled (#103): every sign of an end marks it, one settle loop handles them all (see
  // chat/settle.ts). Keyed by run (`nextEnding`): a sign about a run no longer followed is ignored; one about the
  // run followed now replaces an older attempt; signs of the same end are one.
  const [ending, setEnding] = useState<Ending | null>(null);
  const beginEnding = useCallback(
    (e: Ending) => {
      const followed = qc.getQueryData<Run | null>(["active-run", e.conversationId]) ?? null;
      setEnding((cur) => nextEnding(cur, e, followed?.endedAt === null ? followed.id : null));
    },
    [qc],
  );
  const active = useQuery({
    queryKey: ["active-run", id],
    queryFn: async ({ signal }) => {
      const asked = Date.now();
      const r = await conversations.activeRun(id, signal);
      const cached = qc.getQueryData<Run | null>(["active-run", id]) ?? null;
      const mine = startedHere.current;
      if (mine && mine.id === id && mine.at >= asked && r?.id !== mine.runId) return cached;
      // The run followed live is over (or another took its place): it is let go only once its end is settled — a
      // messages read after the end shows the reply final — never on this answer alone.
      if (cached && cached.endedAt === null && !(r && r.id === cached.id && r.endedAt === null)) {
        beginEnding({ conversationId: id, messageId: cached.assistantMessageId, runId: cached.id });
        return cached;
      }
      return r;
    },
  });
  const usable = useUsableRuntimes();
  // Runs that ended while the user was on an artifact page they moved to (#172) left their notices there; taken
  // once (the store forgets them) — this screen keeps them from here on.
  const [after, setAfter] = useState<Record<string, AfterRun>>(() => takeAfter(id));
  const [actionError, setActionError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const online = useOnline();

  /** What a run may have changed besides its messages and its state. */
  const refreshAround = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["conversation", id] }),
      qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY }),
      // A run may have made a new version of an artifact (#28): the cards and its page show it.
      qc.invalidateQueries({ queryKey: ["artifact"] }),
      qc.invalidateQueries({ queryKey: MY_ARTIFACTS_KEY }),
    ]);
  /** The run whose stream closed (with or without `done`): if it turns out to be still going, it is followed again. */
  const closedRun = useRef<string | null>(null);
  const { live, reconnect } = useRunStream(
    active.data,
    (last) => {
      if (last.notices.length || last.error)
        setAfter((a) => ({
          ...a,
          [last.messageId]: { notices: last.notices, ...(last.error ? { error: last.error } : {}) },
        }));
      closedRun.current = last.runId;
      beginEnding({ conversationId: id, messageId: last.messageId, runId: last.runId });
    },
    () => void qc.invalidateQueries({ queryKey: ["active-run", id] }),
  );
  // No run in progress, yet the latest reply reads as unfinished: opened as its run ended (the messages read before
  // the end, the run after it), or a reply sent from another tab — settled like any end (#103 review).
  const lastAssistant = list?.findLast((m) => m.role === "assistant");
  const noRun = active.isSuccess && !active.isFetching && (!active.data || active.data.endedAt !== null);
  const unfinishedId =
    noRun && (lastAssistant?.status === "pending" || lastAssistant?.status === "streaming")
      ? lastAssistant.id
      : null;
  // Recorded once (while rendering, as derived state): its attempt then runs to its end — a status that changes
  // meanwhile (the read after it) never cancels the attempt that found a run (another tab's) before applying it.
  const [seenUnfinished, setSeenUnfinished] = useState<string | null>(null);
  const unfinishedKey = unfinishedId ? `${id}\n${unfinishedId}` : null;
  // (Only while nothing else settles here: that end, once settled, lets this be seen afresh.)
  if (unfinishedKey && unfinishedKey !== seenUnfinished && ending?.conversationId !== id) {
    setSeenUnfinished(unfinishedKey);
    beginEnding({ conversationId: id, messageId: unfinishedId!, runId: null });
  }

  // The settle loop (`startSettleLoop`): a try now, then again after 2 s, doubling up to 30 s while it stays unsettled (a
  // server that keeps a reply unfinished with no run is not asked every 2 s forever); one at a time; stopped when the
  // conversation is left.
  const around = useEffectEvent(() => refreshAround());
  const followAgain = useEffectEvent(() => reconnect());
  const marked = ending?.conversationId === id ? ending : null;
  // What is being settled, as plain values (the loop restarts only for another reply or run).
  const settleMessage = marked ? marked.messageId : null;
  const settleRun = marked ? marked.runId : null;
  /** The running loop's run and its poke (a stop answered with that run ended: check now, not after the backoff). */
  const pokeSettle = useRef<{ runId: string | null; poke: () => void } | null>(null);
  useEffect(() => {
    if (!settleMessage) return;
    const settling: Ending = { conversationId: id, messageId: settleMessage, runId: settleRun };
    const ac = new AbortController();
    const loop = startSettleLoop(
      () =>
        settleEnd({
          qc,
          ending: settling,
          signal: ac.signal,
          readActiveRun: conversations.activeRun,
          around,
        }),
      (r) => {
        if (r === "running" && settling.runId !== null && closedRun.current === settling.runId) followAgain();
        setEnding((e) =>
          e && e.conversationId === id && e.messageId === settleMessage && e.runId === settleRun ? null : e,
        );
      },
    );
    pokeSettle.current = { runId: settleRun, poke: loop.poke };
    return () => {
      ac.abort();
      loop.stop();
      pokeSettle.current = null;
    };
  }, [id, settleMessage, settleRun, qc]);
  useEffect(() => () => forgetReadsAfterEnd(qc, id), [qc, id]);
  // A new artifact of a run started here is shown on its page by itself (#28, FR-6.1, #172).
  useAutoShow(live, id);
  // Gave up on the stream: keep looking at the run now and then — once it has ended, the saved reply shows.
  const lost = !!live?.lost;
  // A lost stream does not keep the conversation busy: edit, regenerate and send are available again.
  const busy = (!!live && !lost) || starting;
  // The reply has its `done` but the run is not read as ended yet (#141): an Enter now is sent once it is.
  const finishing = !!live && !lost && live.status !== undefined;
  // A lost stream: the run is looked at now and then — an answer that it is over settles it like any end.
  const recheck = useEffectEvent(() => void qc.invalidateQueries({ queryKey: ["active-run", id] }));
  useEffect(() => {
    if (!lost) return;
    const t = setInterval(recheck, 5000);
    return () => clearInterval(t);
  }, [lost]);

  const { scroller, content, away, toBottom } = useStickToBottom();

  /** send / edit / regenerate: the response names the run that writes the reply. */
  const start = useCallback(
    async (call: () => Promise<StartRunResponse>) => {
      setStarting(true);
      setActionError(null);
      try {
        const r = await call();
        markStartedHere(r.run.id);
        startedHere.current = { id, runId: r.run.id, at: Date.now() };
        // An `active-run` read still in flight would answer from before this run: cancelled first.
        await qc.cancelQueries({ queryKey: ["active-run", id] });
        qc.setQueryData(["active-run", id], r.run);
        await rereadQuery(qc, ["messages", id]);
        // An edit or a regenerate may take a card's source out of the history (spec §10.3).
        void qc.invalidateQueries({ queryKey: MEMORY_PROPOSALS_KEY });
        toBottom();
      } finally {
        setStarting(false);
      }
    },
    [id, qc, toBottom],
  );
  const send = (text: string, fileIds: string[]) =>
    start(() => conversations.send(id, text, {}, fileIds)).then(() =>
      qc.invalidateQueries({ queryKey: ["files", id] }),
    );
  // "다이어그램 고치기" (#182): the fix request goes as a new message of this conversation, like the composer's
  // send — only while no run is in progress.
  const fixDiagram = useMemo<DiagramFix>(
    () => ({
      send: busy
        ? null
        : (text: string) =>
            void start(() => conversations.send(id, text, {}, [])).catch((e: unknown) =>
              setActionError(errorText(e)),
            ),
    }),
    [busy, id, start],
  );
  // 🔬 깊이 조사 (#211): the question becomes a user message and the plan card; the job runs on the server.
  const startResearch = useCallback(
    async (text: string, fileIds: string[]) => {
      await research.start(id, text, fileIds);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["messages", id] }),
        qc.invalidateQueries({ queryKey: ["files", id] }),
      ]);
    },
    [id, qc],
  );
  // How many files the conversation already has (the 20-per-conversation limit counts sent ones too).
  const fileList = useQuery({ queryKey: ["files", id], queryFn: () => filesApi.list(id) });
  const conversationId = useCallback(async () => id, [id]);
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
          // Ended already: settled like any end (with the `done` that may be on its way, the same end); still
          // going: its stream's `done` ends it.
          .then((run) => {
            if (run.endedAt === null) return;
            // Its end already applied (the run let go): a late answer starts nothing.
            if (qc.getQueryData<Run | null>(["active-run", id])?.id !== run.id) return;
            beginEnding({ conversationId: id, messageId: run.assistantMessageId, runId: run.id });
            // The same end already settling (its loop waiting out a backoff): checked now.
            if (pokeSettle.current?.runId === run.id) pokeSettle.current.poke();
          })
          .catch((e: unknown) => setActionError(errorText(e)))
    : undefined;

  const chatSettings = conv.data?.settings ?? null;
  // "기본값을 쓸 수 없어 ○○로 시작했어요" — once (FR-12.6): the server hands it to exactly one caller (another tab, a
  // reload or a failed request never shows it twice); only that page shows it, while the conversation is open.
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);
  const asked = useRef<string | null>(null);
  const pendingNotice = !!conv.data?.fallbackNotice;
  useEffect(() => {
    if (!pendingNotice || asked.current === id || usable.isPending) return;
    asked.current = id;
    void takeFallbackNotice(() => conversations.consumeFallbackNotice(id)).then((n) => {
      // Only the notice field: a full conversation from this response could undo a newer chip change.
      qc.setQueryData<Conversation>(["conversation", id], (c) => (c ? withoutNotice(c) : c));
      if (n) setNotice({ id, text: noticeText(n, usable.data) });
    });
  }, [pendingNotice, id, qc, usable.data, usable.isPending]);
  // A notification's link to the result message (`#m-<id>`, FR-8.4): older pages are loaded until it is there (a
  // result followed by many turns), then it is scrolled to — once per link. The search stops at a failed page (500,
  // 403 after a revoked share…) or after SEARCH_PAGES pages, and offers "다시 시도" (review #116).
  const { hash } = useLocation();
  const target = hash.startsWith("#m-") ? hash.slice(3) : null;
  const found = !!target && !!list?.some((m) => m.id === target);
  const { hasNextPage, isFetching, isFetchNextPageError, fetchNextPage } = messages;
  /** Whether the messages are being read right now — the query's own state (a paused, offline read counts too). */
  const messagesLoading = useCallback(() => listBusy(qc, ["messages", id]), [qc, id]);
  // "이전 메시지 보기" while the list is being read: the click waits and goes once it is idle, and is kept until its page
  // has arrived (chat/older-pages.ts; done by the effect after the schedule-result read below).
  const olderAsked = useRef<OlderAsk | null>(null);
  const pageCount = messages.data?.pages.length ?? 0;
  const loadOlder = () => {
    if (messagesLoading()) olderAsked.current = { conversationId: id, pages: pageCount };
    else void fetchNextPage();
  };
  const scrolledTo = useRef<string | null>(null);
  const search = useRef<{ key: string; pages: number }>({ key: "", pages: 0 });
  const [searchStopped, setSearchStopped] = useState<string | null>(null);
  // The link whose message was found once (review #116) — kept apart from whether it is in the list now (a regenerate,
  // an edit or later pages may take it out): a found link never searches again nor holds back later results.
  const [foundLink, setFoundLink] = useState<string | null>(null);
  // Every link transition — another hash, the hash removed, the same hash again later — is a new link: its found,
  // scrolled and stopped states start over (they are all keyed on this). Within one stay of a hash they persist
  // across list refreshes (review #116).
  const [linkGen, setLinkGen] = useState({ id, hash, n: 0 });
  if (linkGen.id !== id || linkGen.hash !== hash) setLinkGen({ id, hash, n: linkGen.n + 1 });
  const linkKey = `${linkKeyOf(id, hash)}@${linkGen.n}`;
  if (found && foundLink !== linkKey) setFoundLink(linkKey);
  const foundOnce = foundLink === linkKey;
  /** "다시 시도" asked for this link: its next page is fetched once the list is not being read (counted then). */
  const searchRetry = useRef<string | null>(null);
  useEffect(() => {
    if (search.current.key !== linkKey) search.current = { key: linkKey, pages: 0 };
    if (!target || !list || scrolledTo.current === linkKey) return;
    if (!found) {
      if (foundOnce) return;
      // Not while the list is being read (a read after a reply's end): an older page would cut it short; resumed after
      // (this effect runs again when the read ends). Checked on the query itself, as it is now.
      if (isFetching || messagesLoading()) return;
      if (searchRetry.current === linkKey) {
        searchRetry.current = null;
        search.current.pages = 1;
        void fetchNextPage();
        return;
      }
      if (searchStopped === linkKey) return;
      // Not there at all (deleted, another version), a failed page, or the cap: stop and say so.
      if (!hasNextPage || isFetchNextPageError || search.current.pages >= SEARCH_PAGES)
        return setSearchStopped(linkKey);
      search.current.pages++;
      void fetchNextPage();
      return;
    }
    const el = document.getElementById(`m-${target}`);
    if (!el) return;
    scrolledTo.current = linkKey;
    el.scrollIntoView({ block: "start" });
  }, [
    target,
    found,
    list,
    hasNextPage,
    isFetching,
    isFetchNextPageError,
    fetchNextPage,
    linkKey,
    searchStopped,
    foundOnce,
    messagesLoading,
  ]);
  const retrySearch = () => {
    // The page is asked for (and counted) by the search effect, once the list is not being read.
    search.current = { key: linkKey, pages: 0 };
    searchRetry.current = linkKey;
    setSearchStopped(null);
  };
  // A schedule's result (#56, FR-8.3): when the conversation says there is one that is not shown yet, the view is read
  // again; "새 결과" goes only once that very message has loaded without error (and, for a link, was found).
  const newResult = !!conv.data?.newResult;
  const resultId = newResult ? (conv.data?.newResultMessageId ?? null) : null;
  const settled = messages.isSuccess && !messages.isFetching && !!list;
  const resultLoaded = settled && (resultId === null || !!list?.some((m) => m.id === resultId));
  const linkOk = !target || found || foundOnce;
  // The link's own search (searching / found / stopped; the hash stays after it is found): only while it is
  // searching, or stopped on this very result, does it stand in for the refresh below — a found link, or a newer
  // result, is refreshed like any view (review #116).
  const linkSearching = !!target && !found && !foundOnce && searchStopped !== linkKey;
  const linkHolds = linkSearching || (searchStopped === linkKey && resultId === target);
  const reread = useRef(0);
  useEffect(() => {
    // Not while a result link looks for its message itself (it loads the pages, and stops on a failure), nor while
    // the list is being read (a page on its way would be cancelled).
    if (!newResult || resultLoaded || linkHolds || messages.isFetching || messagesLoading()) return;
    if (reread.current === conv.dataUpdatedAt) return;
    reread.current = conv.dataUpdatedAt;
    void qc.invalidateQueries({ queryKey: ["messages", id] });
    void qc.invalidateQueries({ queryKey: ["active-run", id] });
  }, [newResult, resultLoaded, linkHolds, messages.isFetching, messagesLoading, conv.dataUpdatedAt, id, qc]);
  // The waiting older-page click — after the effect above (a schedule result's read it starts goes first: the list is
  // then busy), after every render (the read's end re-renders, whenever it came); kept until its page arrived.
  useEffect(() => {
    const step = olderStep(olderAsked.current, {
      conversationId: id,
      pages: pageCount,
      hasNextPage: !!hasNextPage,
      errors: qc.getQueryState(["messages", id])?.errorUpdateCount ?? 0,
      nextPageFailed: isFetchNextPageError,
      busy: isFetching || messagesLoading(),
    });
    if (step === "done" || step === "none") olderAsked.current = null;
    else if (step === "fetch") {
      olderAsked.current = {
        ...olderAsked.current!,
        errorsAtStart: qc.getQueryState(["messages", id])?.errorUpdateCount ?? 0,
      };
      void fetchNextPage();
    }
  });
  useEffect(() => {
    if (!newResult || !resultLoaded || !linkOk) return;
    void conversations
      .resultSeen(id, resultId ?? undefined)
      .then((c) => {
        qc.setQueryData<Conversation>(["conversation", id], (old) =>
          old ? { ...old, newResult: c.newResult, newResultMessageId: c.newResultMessageId ?? null } : old,
        );
        return qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
      })
      .catch(() => {});
  }, [newResult, resultLoaded, linkOk, resultId, id, qc]);
  const changeSettings = async (change: ChangeSettingsRequest) => {
    const c = await conversations.changeSettings(id, change);
    qc.setQueryData(["conversation", id], c);
    setNotice(null);
  };

  if (conv.isError) return <Missing error={conv.error} />;
  return (
    <>
      <TopBar title={conv.data?.title ?? "…"}>
        {conv.data?.owned === true && <ResearchToggle c={conv.data} />}
        {conv.data && <ReferencesButton conversationId={conv.data.id} />}
        {/* Only the server-confirmed owner manages it (#52): a shared reader gets no menu, no share dialog. */}
        {conv.data?.owned === true && <ConvMenu c={conv.data} />}
      </TopBar>
      <div className="thread" data-testid="thread" ref={scroller}>
        {/* File citations and file chips open this conversation's file viewer (#24). */}
        <FileViewContext.Provider value={id}>
          <DiagramFixContext.Provider value={fixDiagram}>
            <div className="col" ref={content}>
              {conv.data?.kind === "fork" && (
                <p className="notice info small" data-testid="fork-notice">
                  가족이 공유한 내용을 복사한 내 대화예요. 여기서 이어가도 원래 대화는 바뀌지 않아요.
                </p>
              )}
              {messages.hasNextPage && (
                <button
                  type="button"
                  className="ghost small older"
                  disabled={messages.isFetchingNextPage}
                  onClick={loadOlder}
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
                ) : m.role === "system" ? (
                  <SystemMessage key={m.id} m={m} />
                ) : m.role === "assistant" ? (
                  <AssistantMessage
                    key={m.id}
                    m={m}
                    live={live && m.id === live.messageId ? live : null}
                    after={after[m.id]}
                    // A 깊이 조사 card (#211) is not an answer to regenerate.
                    canRegenerate={
                      !busy && m.id === lastAssistant?.id && !m.parts.some((p) => p.type === "research")
                    }
                    onRegenerate={regenerate}
                    onReconnect={reconnect}
                    onStop={stop}
                  />
                ) : null,
              )}
            </div>
          </DiagramFixContext.Provider>
        </FileViewContext.Provider>
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
      {searchStopped === linkKey && !found && (
        <div className="notice warn banner" role="alert" data-testid="link-search-stopped">
          결과 메시지를 찾지 못했어요.{" "}
          <button type="button" className="small" onClick={retrySearch}>
            다시 시도
          </button>
        </div>
      )}
      {actionError && (
        <div className="notice err banner" role="alert">
          {actionError}
        </div>
      )}
      <Composer
        key={id}
        busy={busy}
        finishing={finishing}
        onSend={send}
        onStop={lost ? undefined : stop}
        chip={
          <RuntimeChip
            settings={chatSettings}
            options={usable.data}
            onChange={changeSettings}
            notice={notice?.id === id ? notice.text : null}
            pending={differs(chatSettings, lastAssistant)}
          />
        }
        conversation={conversationId}
        existingFiles={fileList.data ?? NO_FILES}
        research={
          conv.data?.owned === true
            ? {
                start: startResearch,
                // Claude conversations only (#211 decision 3).
                ...((chatSettings?.runtime ?? "claude-code") !== "claude-code"
                  ? { disabled: "깊이 조사는 Claude 대화에서만 쓸 수 있어요" }
                  : {}),
              }
            : undefined
        }
      />
    </>
  );
}

/** `── 여기부터 Codex · ○○ ──` written by the server where the answering runtime / model changed (#19). */
const SystemMessage = memo(function SystemMessage({ m }: { m: Message }) {
  return (
    <>{publicParts(m.parts).map((p, i) => (p.type === "divider" ? <DividerView key={i} d={p} /> : null))}</>
  );
});

/**
 * "/": nothing to choose first — type and go (PRD FR-3.5). The chip shows what the conversation will start with (the
 * defaults after the FR-12.6 fallback, by the server); changing it here is sent along when the conversation is made.
 * Nothing usable at all: a screen saying so instead of a composer that cannot work.
 */
export function NewChatPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const defaults = useQuery({ queryKey: ["settings", "defaults"], queryFn: settingsApi.defaults });
  const usable = useUsableRuntimes();
  const [chosen, setChosen] = useState<ChatSettings | null>(null);
  const start = chosen ?? defaults.data?.start ?? null;
  // Every chip change is previewed by the server; a send waits for the latest result (review #101 4차).
  const [choice] = useState(() => new ChipChoice<ChatSettings>(settingsApi.preview));
  const asRequest = (c: ChatSettings | null): ChangeSettingsRequest | undefined =>
    c
      ? {
          runtime: c.runtime,
          model: c.model,
          ...(c.effort ? { effort: c.effort } : {}),
          useShared: c.useShared,
        }
      : undefined;
  /**
   * Made on the first file (uploads need a conversation) or on send, whichever comes first — once, with the chip's
   * choice at that moment. A failed create is not kept: the next file or send tries again (review #102 4차).
   */
  const created = useRef<Promise<{ id: string; with: ChatSettings | null }> | null>(null);
  const make = useCallback(() => {
    if (!created.current) {
      const p = (async () => {
        const settled = await choice.settled();
        const c: Conversation = await conversations.create(asRequest(settled));
        qc.setQueryData(["conversation", c.id], c);
        return { id: c.id, with: settled };
      })();
      p.catch(() => {
        if (created.current === p) created.current = null;
      });
      created.current = p;
    }
    return created.current;
  }, [choice, qc]);
  const conversation = useCallback(async () => (await make()).id, [make]);
  const send = async (text: string, fileIds: string[]) => {
    // Waits for a preview still on its way; a failed one stops the send (its error shows under the composer).
    const chosen = await choice.settled();
    const made = await make();
    const id = made.id;
    // The conversation was made by a file before the chip changed: the send uses the chip as it is now.
    const change = made.with !== chosen ? asRequest(chosen) : undefined;
    if (change) qc.setQueryData(["conversation", id], await conversations.changeSettings(id, change));
    const r = await conversations.send(id, text, {}, fileIds);
    markStartedHere(r.run.id);
    qc.setQueryData(["active-run", id], r.run);
    await qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
    navigate(`/c/${id}`);
  };
  /** 🔬 깊이 조사 as the first question (#211): the same conversation creation and chip choice as a send. */
  const startResearch = async (text: string, fileIds: string[]) => {
    const chosen = await choice.settled();
    const made = await make();
    const id = made.id;
    const change = made.with !== chosen ? asRequest(chosen) : undefined;
    if (change) qc.setQueryData(["conversation", id], await conversations.changeSettings(id, change));
    await research.start(id, text, fileIds);
    await qc.invalidateQueries({ queryKey: CONVERSATIONS_KEY });
    navigate(`/c/${id}`);
  };
  // The server computes the choice (the same rules as the conversation is created with, limits included).
  const change = async (c: ChangeSettingsRequest) => {
    if (!start) return;
    setChosen(await choice.change(start, c));
  };
  if (defaults.data && defaults.data.start === null)
    return (
      <>
        <TopBar title={<span className="muted">새 대화</span>} />
        <div className="empty" data-testid="no-runtime">
          <h1>쓸 수 있는 런타임이 없어요</h1>
          <p className="muted">관리자에게 문의하세요. 런타임 연결이나 허용 범위를 확인해야 해요.</p>
        </div>
      </>
    );
  return (
    <>
      <TopBar title={<span className="muted">새 대화</span>} />
      <div className="thread">
        <div className="empty">
          <h1>무엇을 도와드릴까요?</h1>
          <p className="muted">질문을 입력하면 바로 시작해요.</p>
        </div>
      </div>
      <Composer
        busy={false}
        onSend={send}
        autoFocus
        chip={<RuntimeChip settings={start} options={usable.data} onChange={change} />}
        conversation={conversation}
        existingFiles={NO_FILES}
        research={{
          start: startResearch,
          // Claude conversations only (#211 decision 3): the chip's choice decides.
          ...(start && start.runtime !== "claude-code"
            ? { disabled: "깊이 조사는 Claude 대화에서만 쓸 수 있어요" }
            : {}),
        }}
      />
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
      // The composer is always in view: focusing it never scrolls anything (#247).
      document.getElementById(COMPOSER_INPUT)?.focus({ preventScroll: true });
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
  const fileRefs = m.parts.flatMap((p) => (p.type === "file_ref" ? [p] : []));
  return (
    <div className="msg user" data-testid="user-message">
      <div className="bubble">{text}</div>
      {fileRefs.length > 0 && (
        <div className="files row">
          {fileRefs.map((p) => (
            <FileRef key={p.fileId} part={p} />
          ))}
        </div>
      )}
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
      id={`m-${m.id}`}
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
  /** Busy only until the ended run is confirmed (#141): an Enter is queued instead of ignored. */
  finishing?: boolean;
  onSend: (text: string, fileIds: string[]) => Promise<unknown>;
  onStop?: (() => void) | undefined;
  autoFocus?: boolean;
  /** The runtime chip (#19). */
  chip: ReactNode;
  /** The conversation files are uploaded to (#22). */
  conversation: () => Promise<string>;
  /** The conversation's files on the server (unsent ones are shown as chips). */
  existingFiles: readonly UploadedFile[];
  /**
   * 🔬 깊이 조사 (#211): the composer's text (and files) as a research question. `disabled`: the reason it cannot be
   * used here (a Codex conversation) — shown on the button. Absent: no button (a shared reader, the new-chat screen).
   */
  research?: { start: (text: string, fileIds: string[]) => Promise<unknown>; disabled?: string } | undefined;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const attach = useAttachments(props.conversation, props.existingFiles);
  const [deferred, setDeferred] = useState<Deferred>(IDLE);
  /** Sends exactly `q` — the text and files of this Enter, or of the queued one (#141). */
  const deliver = async (q: Queued) => {
    setSending(true);
    setError(null);
    const fileIds = [...q.fileIds];
    try {
      await props.onSend(q.text.trim(), fileIds);
      setText("");
      attach.sent(fileIds);
    } catch (e) {
      setError(errorText(e));
      // Files that are gone (deleted elsewhere, or already sent): drop their chips so the next send works.
      if (e instanceof ApiError && e.code === "invalid_attachment")
        void attach.reconcile().catch(() => undefined);
    } finally {
      setSending(false);
    }
  };
  /** Sends the composer's text and files as a 깊이 조사 question (never queued: a plan card comes first). */
  const startResearch = async () => {
    if (!props.research || !text.trim()) return;
    setSending(true);
    setError(null);
    const fileIds = [...attach.ready];
    try {
      await props.research.start(text.trim(), fileIds);
      setText("");
      attach.sent(fileIds);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setSending(false);
    }
  };
  const submit = async () => {
    const step = enter(deferred, {
      text,
      fileIds: attach.ready,
      sending,
      uploading: attach.uploading,
      busy: props.busy,
      finishing: !!props.finishing,
    });
    setDeferred(step.next);
    if (step.send) await deliver(step.send);
  };
  // Free again (the run confirmed ended): a queued Enter goes now, as it was — only if the composer still holds it.
  const ready = !props.busy && !sending && !attach.uploading;
  const onReady = useEffectEvent(() => {
    const step = free(deferred, { text, fileIds: attach.ready });
    setDeferred(step.next);
    if (step.send) void deliver(step.send);
  });
  useEffect(() => {
    if (!ready || deferred === IDLE) return;
    // A task of its own, not this effect: an edit, a stop or leaving the conversation before it cancels it.
    const t = setTimeout(onReady, 0);
    return () => clearTimeout(t);
  }, [ready, deferred]);
  // Another file in or out changes what would be sent: a queued Enter is dropped (#141).
  const addFiles = (picked: Iterable<File>) => {
    setDeferred(IDLE);
    attach.add(picked);
  };
  const removeFile = (key: string) => {
    setDeferred(IDLE);
    attach.remove(key);
  };
  const stop = props.onStop
    ? () => {
        setDeferred(IDLE);
        props.onStop?.();
      }
    : undefined;
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  };
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    // Pasted files (a screenshot, files copied in Finder) are attached; pasted text stays text.
    if (!e.clipboardData.files.length) return;
    e.preventDefault();
    addFiles(e.clipboardData.files);
  };
  return (
    <div className="composer">
      <div
        className={`box${dragging ? " dragging" : ""}`}
        data-testid="composer"
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <AttachmentChips items={attach.items} onRemove={removeFile} />
        <textarea
          onPaste={onPaste}
          id={COMPOSER_INPUT}
          aria-label="메시지 입력"
          placeholder="메시지를 입력하세요 (Shift+Enter 줄바꿈)"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setDeferred(IDLE);
          }}
          onKeyDown={onKey}
          rows={2}
          autoFocus={props.autoFocus}
        />
        <div className="bar">
          <AttachButton onPick={addFiles} />
          {error && (
            <span className="error small" role="alert">
              {error}
            </span>
          )}
          {deferred.queued && (
            <span className="muted small" role="status" data-testid="queued-send">
              답변을 마무리하는 중이에요. 끝나면 바로 보낼게요.{" "}
              <button type="button" className="ghost small" onClick={() => setDeferred(IDLE)}>
                취소
              </button>
            </span>
          )}
          {deferred.hint === "busy" && props.busy && (
            <span className="muted small" role="status" data-testid="busy-hint">
              답변이 끝난 뒤에 보낼 수 있어요.
            </span>
          )}
          {deferred.hint === "uploading" && attach.uploading && (
            <span className="muted small" role="status" data-testid="upload-hint">
              파일을 다 올린 뒤에 보낼 수 있어요.
            </span>
          )}
          <span className="grow" />
          {props.chip}
          {props.research && !stop && (
            <button
              type="button"
              className="small research-start"
              data-testid="research-start"
              disabled={
                !!props.research.disabled || !text.trim() || sending || props.busy || attach.uploading
              }
              title={
                props.research.disabled ??
                "입력한 질문을 깊이 조사해요: 계획을 먼저 보여 드리고, 승인하면 여러 출처를 찾아 검증한 보고서를 만들어요 (최대 30분)"
              }
              aria-label={props.research.disabled ? `깊이 조사 — ${props.research.disabled}` : "깊이 조사"}
              onClick={() => void startResearch()}
            >
              <span aria-hidden>🔬</span>
              <span className="research-label"> 깊이 조사</span>
            </button>
          )}
          {stop ? (
            <button type="button" onClick={stop}>
              ■ 중지
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={!text.trim() || sending || props.busy || attach.uploading}
              title={attach.uploading ? "파일을 다 올린 뒤에 보낼 수 있어요" : undefined}
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
