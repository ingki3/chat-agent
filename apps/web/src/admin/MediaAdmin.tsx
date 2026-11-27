import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { useMutation, useMutationState, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  MEDIA_KIND_LABEL,
  MEDIA_KINDS,
  MEDIA_LIMITS,
  type MediaAdmin as MediaAdminView,
  type MediaKind,
  type MediaSettings,
} from "@agentlee/shared";
import { admin, ApiError, errorText } from "../api.js";
import { usd } from "../usage-format.js";
import {
  catalogView,
  composeReadinessPollMs,
  anySavePaused,
  conflictNotice,
  draftBase,
  SETTINGS_SAVE_KEY,
  pendingText,
  readState,
  type ReadState,
  expectedRevision,
  formState,
  inputAfterSave,
  isStaleKeyError,
  keySaveArgs,
  keyWriteArgs,
  mediaScreenStore,
  type KeySave,
  type KeyWrite,
  type MediaScreenStore,
  type RejectedGenerations,
} from "./media-cache.js";

export const MEDIA_KEY = ["admin", "media"] as const;
/** The status shown, with the ticket of the read it came from. */
type Shown = { status: MediaAdminView; ticket: number };
/** "최신 값 불러오기" gives up after this (the draft stays, a retry is offered). */
const RELOAD_TIMEOUT_MS = 20_000;
/** Every catalog query; each one is keyed by the server's key generation too (a list of another key never shows). */
export const MEDIA_CATALOG_KEY = ["admin", "media-catalog"] as const;
const catalogKey = (generation: string, kind: MediaKind) => [...MEDIA_CATALOG_KEY, generation, kind] as const;

/**
 * What the screen's parts share (see `media-cache.ts`): `refresh` starts a new status read (the latest started one is
 * the only one shown — writes never set the status), `rejected` holds the generations a catalog call refused.
 */
type Screen = {
  refresh: () => void;
  rejected: RejectedGenerations;
  /** A generation was just rejected (re-render: every kind hides its list at once). */
  onReject: (e: unknown, generation: string) => boolean;
  /** Reads the status now; true only when a new status actually arrived (offline or failed: false). */
  reload: () => Promise<boolean>;
  store: MediaScreenStore;
};

const SOURCE: Record<MediaAdminView["key"]["source"], string> = {
  admin: "관리자가 등록한 키",
  env: ".env의 OPENROUTER_API_KEY",
  none: "키 없음",
};

const time = (ms: number) =>
  new Date(ms).toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/** The OpenRouter key: checked with OpenRouter before it is saved; only its last 4 characters are ever shown. */
function KeySection({ m, screen }: { m: MediaAdminView; screen: Screen }) {
  const [key, setKey] = useState("");
  // Whatever a write's outcome, the status shown comes from a new status read (never from the write's answer).
  // Every key write names the generation shown (the server refuses another: `media_key_changed`, nothing changes).
  // Each write's inputs are fixed at the click (`mutate(args)`); the mutation uses only those.
  const generation = m.key.generation;
  // A key write refused for its generation rejects that generation at once (as a refused catalog does).
  const onKeyError = (e: unknown, a: KeyWrite) => void screen.onReject(e, a.expectedGeneration);
  const save = useMutation({
    mutationFn: (a: KeySave) => admin.setMediaKey(a.key, a.expectedGeneration),
    onSuccess: (_r, a) => setKey((input) => inputAfterSave(input, a.key)),
    onError: onKeyError,
    onSettled: screen.refresh,
  });
  const remove = useMutation({
    mutationFn: (a: KeyWrite) => admin.deleteMediaKey(a.expectedGeneration),
    onError: onKeyError,
    onSettled: screen.refresh,
  });
  const check = useMutation({
    mutationFn: (a: KeyWrite) => admin.checkMediaKey(a.expectedGeneration),
    onError: onKeyError,
    onSettled: screen.refresh,
  });
  // A generation a catalog call refused: this key may no longer be the one in use — no key write until re-read.
  const stale = screen.rejected.has(generation);
  const k = m.key;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate(keySaveArgs(key, generation));
  };
  return (
    <section aria-label="OpenRouter 키">
      <h3>OpenRouter 키</h3>
      <p className="small" data-testid="media-key">
        {SOURCE[k.source]}
        {k.last4 && (
          <>
            {" "}
            · 끝 4자리 <code>{k.last4}</code>
          </>
        )}
        {k.checkedAt !== null && (
          <>
            {" "}
            · 남은 한도{" "}
            <b data-testid="media-key-remaining">
              {k.limitRemainingUsd === null ? "제한 없음" : usd(k.limitRemainingUsd)}
            </b>
            {k.limitUsd !== null && ` / ${usd(k.limitUsd)}`}
            <span className="muted"> ({time(k.checkedAt)} 확인)</span>
          </>
        )}
      </p>
      <p className="muted small">
        관리자가 등록한 키를 먼저 쓰고, 없으면 .env의 OPENROUTER_API_KEY를 써요. 음성 전사 외부 대체도 같은
        키를 써요.
      </p>
      <form onSubmit={submit} className="access-register">
        <label className="field">
          <span>{k.source === "admin" ? "새 키로 바꾸기" : "새 키 등록"}</span>
          <input
            type="password"
            autoComplete="off"
            aria-label="OpenRouter API 키"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="sk-or-v1-…"
            required
          />
        </label>
        {save.isError && (
          <p className="error small" role="alert">
            {errorText(save.error)}
          </p>
        )}
        <span className="actions">
          <button className="primary" disabled={stale || save.isPending || !key.trim()}>
            {save.isPending ? pendingText(save.isPaused, "확인 중…") : "확인하고 저장"}
          </button>
          {k.source !== "none" && (
            <button
              type="button"
              disabled={stale || check.isPending}
              onClick={() => check.mutate(keyWriteArgs(generation))}
            >
              {check.isPending ? pendingText(check.isPaused, "확인 중…") : "남은 한도 다시 확인"}
            </button>
          )}
          {k.source === "admin" && (
            <button
              type="button"
              disabled={stale || remove.isPending}
              onClick={() => {
                if (confirm("등록한 OpenRouter 키를 지울까요?")) remove.mutate(keyWriteArgs(generation));
              }}
            >
              키 지우기
            </button>
          )}
        </span>
        {(check.isError || remove.isError) && (
          <p className="error small" role="alert">
            {errorText(check.error ?? remove.error)}
          </p>
        )}
      </form>
    </section>
  );
}

/** One kind: on/off and the model, from that kind's OpenRouter catalog (price and options next to it). */
function KindRow({
  kind,
  value,
  status,
  screen,
  onChange,
}: {
  kind: MediaKind;
  value: MediaSettings["kinds"][MediaKind];
  /**
   * The key status shown. The row is mounted per key generation (its React key), so a refresh's pending or failed
   * state never carries over to another key.
   */
  status: MediaAdminView;
  screen: Screen;
  onChange: (v: MediaSettings["kinds"][MediaKind]) => void;
}) {
  const qc = useQueryClient();
  const generation = status.key.generation;
  const hasKey = status.key.source !== "none";
  const onStale = (e: unknown) => void screen.onReject(e, generation);
  const catalog = useQuery({
    queryKey: catalogKey(generation, kind),
    // The server refuses a read for another generation than this one (`media_key_changed`).
    queryFn: async () => {
      try {
        return await admin.mediaCatalog(kind, false, generation);
      } catch (e) {
        onStale(e);
        throw e;
      }
    },
    enabled: hasKey && !screen.rejected.has(generation),
    staleTime: 5 * 60_000,
    retry: (n, e) => !isStaleKeyError(e) && n < 2,
  });
  const reload = useMutation({
    mutationFn: (g: string) => admin.mediaCatalog(kind, true, g),
    // Stored under the generation the server actually read it with — shown only while that is the status's.
    onSuccess: (r) => qc.setQueryData(catalogKey(r.generation, kind), r),
    onError: onStale,
  });
  // Only a list read in the shown status's own generation, and only with a key (no models, prices or source else).
  const list = catalogView(status, catalog.data, screen.rejected);
  const models = list?.models ?? [];
  // An out-of-date status is not an error to show: the status is being read again.
  const shownError = [reload.error, catalog.error].find((e) => e && !isStaleKeyError(e)) ?? null;
  const chosen = models.find((x) => x.id === value.model);
  const label = MEDIA_KIND_LABEL[kind];
  return (
    <li className="media-kind" data-testid={`media-kind-${kind}`}>
      <label className="inline">
        <input
          type="checkbox"
          checked={value.enabled}
          aria-label={`${label} 생성 켜기`}
          onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
        />
        <b>{label}</b>
      </label>{" "}
      <select
        aria-label={`${label} 모델`}
        value={value.model ?? ""}
        disabled={!hasKey}
        onChange={(e) => onChange({ ...value, model: e.target.value || null })}
      >
        <option value="">모델 고르기</option>
        {value.model && !chosen && <option value={value.model}>{value.model} (목록에 없음)</option>}
        {models.map((x) => (
          <option key={x.id} value={x.id}>
            {x.name === x.id ? x.id : `${x.name} — ${x.id}`}
          </option>
        ))}
      </select>{" "}
      <button
        type="button"
        aria-label={`${label} 목록 새로 고침`}
        disabled={!hasKey || reload.isPending || screen.rejected.has(generation)}
        onClick={() => reload.mutate(generation)}
      >
        목록 새로 고침
      </button>
      {list && (
        <span className="muted small" data-testid={`media-catalog-source-${kind}`}>
          {" "}
          {models.length}개 · {list.source}
        </span>
      )}
      {hasKey && shownError && (
        <p className="error small" role="alert" data-testid={`media-catalog-error-${kind}`}>
          {label} 목록: {errorText(shownError)}
        </p>
      )}
      {chosen && (
        <p className="muted small" data-testid={`media-model-${kind}`}>
          가격: {chosen.price ?? "목록에 없음"}
          {chosen.options.length > 0 && ` · 옵션: ${chosen.options.join(", ")}`}
          {chosen.maxDurationSec ? ` · 최대 ${chosen.maxDurationSec}초` : ""}
        </p>
      )}
      {value.enabled && !value.model && <p className="error small">켜려면 모델을 골라요.</p>}
    </li>
  );
}

function SettingsForm({
  m,
  screen,
  shownTicket,
  read,
}: {
  m: MediaAdminView;
  screen: Screen;
  /** The ticket of the status read shown (`m`). */
  shownTicket: number;
  /** Where the status read stands (under way, waiting for the connection, failed, idle). */
  read: ReadState;
}) {
  // The admin's unsaved edit and the version it started from; null = the form follows the latest status read (or a
  // failed save's values, kept in the store).
  const [edit, setEdit] = useState<MediaSettings | null>(null);
  const [editBase, setEditBase] = useState<string | null>(null);
  // The save itself lives in the screen store: whichever form is mounted when it settles shows its outcome.
  const { store } = screen;
  const pending = store.save;
  // The one settings-operation slot (a save or a "최신 값 불러오기" read) is the store's, not this form's.
  const reloading = store.op === "reload";
  const reloadFailed = store.reloadFailed;
  const {
    values: draft,
    locked,
    saved,
    failed,
    refreshed,
  } = formState({
    edit,
    save: pending,
    server: m.settings,
    shownTicket,
    busy: store.op !== null,
  });
  const base = draftBase(editBase, pending);
  // Read from the MutationCache, not this form's observer: a form mounted after the save was sent knows it too.
  const savePaused = anySavePaused(
    useMutationState({
      filters: { mutationKey: SETTINGS_SAVE_KEY, status: "pending" },
      select: (mu) => mu.state.isPaused,
    }),
  );
  const conflict = failed === "media_settings_changed";
  const save = useMutation({
    mutationKey: SETTINGS_SAVE_KEY,
    // Only the values and version fixed at the click are sent.
    mutationFn: (o: { id: number; values: MediaSettings; revision: string }) =>
      admin.saveMediaSettings(o.values, o.revision),
    // These run on the mutation, mounted form or not: the outcome goes to the store — for this operation's id only.
    onSuccess: (_r, o) => void store.settleSave(o.id, { ok: true }),
    // An error keeps the admin's values as the draft (never silently replaced).
    onError: (e, o) =>
      void store.settleSave(o.id, {
        ok: false,
        code: e instanceof ApiError ? e.code : "unknown",
        kind: e instanceof ApiError ? (e.body as { kind?: string } | undefined)?.kind : undefined,
      }),
    onSettled: screen.refresh,
  });
  const submit = (revision: string) => {
    // Nothing starts while another settings operation holds the slot (the form is locked then anyway).
    const id = store.beginSave(draft, revision);
    if (id === null) return;
    setEdit(null);
    setEditBase(null);
    save.mutate({ id, values: draft, revision });
  };
  const hasKey = m.key.source !== "none";
  const set = (patch: Partial<MediaSettings>) => {
    if (locked) return;
    setEditBase(base ?? m.settingsRevision);
    setEdit({ ...draft, ...patch });
    // An edit takes over from a finished or failed save.
    if (pending) store.clearSave();
  };
  const invalid = MEDIA_KINDS.some((k) => draft.kinds[k].enabled && !draft.kinds[k].model);
  const failedKind =
    failed &&
    pending?.phase === "failed" &&
    pending.kind &&
    (MEDIA_KINDS as readonly string[]).includes(pending.kind)
      ? (pending.kind as MediaKind)
      : undefined;
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!conflict && !locked) submit(expectedRevision(base, m.settingsRevision));
  };
  const num = (v: string) => (v === "" ? NaN : Number(v));
  return (
    <form onSubmit={onSubmit} aria-label="미디어 생성 설정">
      {/* Locked while a save is sent and until a status read shows it. */}
      <fieldset disabled={locked} className="plain">
        <section aria-label="종류별 모델">
          <h3>종류별 켜기와 모델</h3>
          {!hasKey && <p className="muted small">먼저 OpenRouter 키를 등록하면 모델 목록을 불러와요.</p>}
          <ul className="skill-list">
            {MEDIA_KINDS.map((k) => (
              <KindRow
                key={`${k}:${m.key.generation}`}
                kind={k}
                value={draft.kinds[k]}
                status={m}
                screen={screen}
                onChange={(v) => set({ kinds: { ...draft.kinds, [k]: v } })}
              />
            ))}
          </ul>
        </section>
        <section aria-label="비용과 횟수 한도">
          <h3>비용과 횟수 한도</h3>
          <label className="field">
            <span>1인당 하루 비용 한도 (USD)</span>
            <input
              type="number"
              min={0.01}
              max={MEDIA_LIMITS.dailyCostMaxUsd}
              step={0.01}
              value={Number.isNaN(draft.dailyCostLimitUsd) ? "" : draft.dailyCostLimitUsd}
              onChange={(e) => set({ dailyCostLimitUsd: num(e.target.value) })}
              required
            />
          </label>
          <p className="muted small">
            한 사람이 하루(서울 시간)에 쓸 수 있는 미디어 생성 비용이에요. 기본 $50.
          </p>
          <div className="media-per-run">
            {MEDIA_KINDS.map((k) => (
              <label className="field" key={k}>
                <span>한 번 실행에서 {MEDIA_KIND_LABEL[k]} 최대 횟수</span>
                <input
                  type="number"
                  min={0}
                  max={MEDIA_LIMITS.perRunMax}
                  step={1}
                  value={Number.isNaN(draft.perRunLimits[k]) ? "" : draft.perRunLimits[k]}
                  onChange={(e) => set({ perRunLimits: { ...draft.perRunLimits, [k]: num(e.target.value) } })}
                  required
                />
              </label>
            ))}
          </div>
          <label className="field">
            <span>영상 기본 길이 (초)</span>
            <input
              type="number"
              min={1}
              max={MEDIA_LIMITS.videoMaxSec}
              step={1}
              value={Number.isNaN(draft.videoDefaultSec) ? "" : draft.videoDefaultSec}
              onChange={(e) => set({ videoDefaultSec: num(e.target.value) })}
              required
            />
          </label>
          <p className="muted small">
            사용자가 더 길게 요청하면 모델이 지원하는 최대 길이까지 늘려요. 영상은 만들기 전에 확인 카드로
            길이와 예상 비용을 보여 줘요.
          </p>
        </section>
        <ComposeSection
          enabled={draft.composeEnabled}
          perRun={draft.perRunLimits.compose}
          readiness={m.compose}
          onEnabled={(v) => set({ composeEnabled: v })}
          onPerRun={(v) => set({ perRunLimits: { ...draft.perRunLimits, compose: v } })}
        />
        <p className="muted small">
          청소년 계정도 미디어 생성이 보여요. 청소년 계정의 요청은 제공자가 지원하면 가장 엄격한 검열 옵션으로
          보내요. 모든 요청은 데이터 수집을 거부하고(<code>data_collection: deny</code>), 비밀값이 든
          프롬프트는 보내지 않아요.
        </p>
        {failed && (
          <p className="error small" role="alert">
            {failedKind && `${MEDIA_KIND_LABEL[failedKind]}: `}
            {/* Until a read started after the refusal is shown, the latest values are not here yet. */}
            {(failed === "media_settings_changed" && conflictNotice(refreshed, read)) ||
              errorText(new ApiError(0, failed))}
          </p>
        )}
        {saved && (
          <p className="small" role="status">
            {locked ? "저장했어요. 최신 상태를 확인하는 중…" : "저장했어요."}
          </p>
        )}
        {locked && !reloading && !saved && (
          <p className="muted small" role="status">
            저장하는 중…
          </p>
        )}
        {reloading && (
          <p className="muted small" role="status">
            최신 값을 불러오는 중…
          </p>
        )}
        {reloadFailed && (
          <p className="error small" role="alert">
            최신 값을 불러오지 못했어요 — 입력한 값은 그대로예요. 다시 시도하세요.
          </p>
        )}
        {conflict ? (
          <span className="actions">
            <button
              type="button"
              onClick={() => submit(m.settingsRevision)}
              disabled={invalid || locked || !refreshed}
            >
              이 값으로 다시 저장
            </button>
            <button
              type="button"
              disabled={locked}
              onClick={() => {
                // The draft goes only once a new status actually arrived; offline or failed, it stays. The read
                // holds the slot; its outcome counts only while it still does.
                const id = store.beginReload();
                if (id === null) return;
                void screen.reload().then((arrived) => {
                  if (store.settleReload(id, arrived) && arrived) {
                    setEdit(null);
                    setEditBase(null);
                  }
                });
              }}
            >
              최신 값 불러오기
            </button>
          </span>
        ) : (
          <span className="actions">
            <button className="primary" disabled={invalid || locked}>
              {pending?.phase === "sending" ? pendingText(savePaused, "모델 확인 중…") : "확인하고 저장"}
            </button>
          </span>
        )}
      </fieldset>
    </form>
  );
}

/**
 * 멀티미디어 합성 (#238 stage 4): its own switch (no model, no key, no cost — the server's ffmpeg puts the
 * conversation's files together), its per-run limit and whether ffmpeg/ffprobe and the sandbox are ready here.
 */
function ComposeSection(props: {
  enabled: boolean;
  perRun: number;
  readiness: MediaAdminView["compose"];
  onEnabled: (v: boolean) => void;
  onPerRun: (v: number) => void;
}) {
  const ready = props.readiness?.ready ?? null;
  return (
    <section aria-label="멀티미디어 합성" data-testid="media-compose">
      <h3>멀티미디어 합성</h3>
      <label className="row">
        <input
          type="checkbox"
          checked={props.enabled}
          onChange={(e) => props.onEnabled(e.target.checked)}
          data-testid="media-compose-enabled"
        />
        <span>대화의 이미지·영상·음성을 영상 하나로 합성하기 (compose_video)</span>
      </label>
      <p className="muted small">
        외부로 보내는 것이 없어 비용이 들지 않아요. 이 서버의 ffmpeg로 최대 5분·40개 클립·1080p까지 만들고, 한
        번에 하나씩(대기 3개, 한 사람 1개) 처리해요. 자막은 켜고 끌 수 있는 자막 트랙으로 넣어요.
      </p>
      <p className="small" data-testid="media-compose-ready">
        {ready === true
          ? "준비됨: ffmpeg·ffprobe와 격리 실행을 확인했어요."
          : ready === false
            ? "준비 안 됨: 이 서버에서 ffmpeg·ffprobe(H.264·AAC)나 격리 실행을 확인하지 못했어요. 켜 두어도 쓸 수 없어요."
            : "준비 상태를 확인하는 중이에요."}
      </p>
      <label className="field">
        <span>한 번 실행에서 합성 최대 횟수</span>
        <input
          type="number"
          min={0}
          max={MEDIA_LIMITS.perRunMax}
          step={1}
          value={Number.isNaN(props.perRun) ? "" : props.perRun}
          onChange={(e) => props.onPerRun(e.target.value === "" ? NaN : Number(e.target.value))}
          required
        />
      </label>
    </section>
  );
}

/** 관리자 → 미디어 생성 (#238 stage 1): the OpenRouter key, per-kind models and the cost limits. */
export function MediaAdmin() {
  const qc = useQueryClient();
  // Lives with the QueryClient: leaving the menu and coming back keeps the tickets and the rejected generations.
  const store = mediaScreenStore(qc);
  const { reads, rejected } = store;
  // Every change of the store (a save's outcome, a rejected generation) re-renders the screen mounted now.
  useSyncExternalStore(store.subscribe, store.getSnapshot);
  // Only the latest started status read is shown: an older one that answers later keeps what is shown.
  const q = useQuery({
    queryKey: MEDIA_KEY,
    // The answer carries the ticket of the read it came from (a save is confirmed by a read started after it).
    queryFn: async (): Promise<Shown> => {
      const ticket = reads.start();
      const status = await admin.media();
      const shown = qc.getQueryData<Shown>(MEDIA_KEY);
      return reads.isLatest(ticket) || !shown ? { status, ticket } : shown;
    },
    // #238 stage 4 (review r1): while the composition's readiness is still being checked here, ask again now and then
    // (it settles within seconds) — never once it is known.
    refetchInterval: (query) => composeReadinessPollMs(query.state.data?.status.compose),
  });
  // After a write (or a refused catalog): any status read in flight is cancelled — watched or not — and the status
  // is invalidated and read again even with no one watching it (the next visit then reads it anyway).
  // Requests for a new read all go through the store (one read per turn).
  useEffect(() => {
    store.setRefresh(() => {
      void (async () => {
        await qc.cancelQueries({ queryKey: MEDIA_KEY });
        await qc.invalidateQueries({ queryKey: MEDIA_KEY, refetchType: "all" });
      })();
    });
  }, [qc, store]);
  const refresh = () => store.requestRefresh();
  const screen: Screen = {
    refresh,
    rejected,
    store,
    reload: async () => {
      const before = qc.getQueryState(MEDIA_KEY)?.dataUpdatedAt ?? 0;
      try {
        await qc.cancelQueries({ queryKey: MEDIA_KEY });
        // Bounded: a read that never answers must not hold the settings slot for good.
        await Promise.race([
          qc.refetchQueries({ queryKey: MEDIA_KEY, type: "all" }, { throwOnError: true }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), RELOAD_TIMEOUT_MS)),
        ]);
      } catch {
        return false;
      }
      // Resolved is not arrived: a paused (offline) read resolves with nothing new.
      return (qc.getQueryState(MEDIA_KEY)?.dataUpdatedAt ?? 0) > before;
    },
    onReject: (e, generation) => store.stale(e, generation),
  };
  const m = q.data?.status;
  const shownTicket = q.data?.ticket ?? 0;
  // A read waiting for the connection is not a failure, and a retry under way is not one either.
  const read = readState(q.fetchStatus, q.isError);
  // Only a first load that failed shows the empty error; with a status shown, a failed re-read keeps the screen.
  if (!m)
    return read === "failed" ? (
      <p className="error small" role="alert">
        {errorText(q.error)}{" "}
        <button type="button" onClick={() => void q.refetch()}>
          다시 시도
        </button>
      </p>
    ) : (
      <p className="muted small">{read === "paused" ? "연결을 기다리는 중…" : "불러오는 중…"}</p>
    );
  return (
    <section className="admin" aria-label="미디어 생성">
      <h2>미디어 생성</h2>
      <p className="muted small">
        OpenRouter 모델로 이미지·음성·음악·영상을 만들어요(운영 문서 51절). 종류마다 켜고 모델을 골라요. 생성
        비용은 OpenRouter가 알려 준 실제 금액으로 사용량에 &quot;미디어 생성&quot;으로 기록돼요.
      </p>
      {read === "paused" && (
        <p className="muted small" role="status" data-testid="media-status-paused">
          연결을 기다리는 중이에요 — 연결되면 최신 상태를 불러와요.
        </p>
      )}
      {read === "failed" && (
        <p className="error small" role="alert" data-testid="media-status-error">
          최신 상태를 다시 불러오지 못했어요 — {errorText(q.error)}{" "}
          <button type="button" onClick={refresh}>
            다시 시도
          </button>
        </p>
      )}
      <KeySection m={m} screen={screen} />
      <SettingsForm m={m} screen={screen} shownTicket={shownTicket} read={read} />
    </section>
  );
}
