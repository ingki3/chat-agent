import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
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
import { catalogView, isStaleKeyError, newerStatus } from "./media-cache.js";

export const MEDIA_KEY = ["admin", "media"] as const;
/** Every catalog query; each one is keyed by the server's key generation too (a list of another key never shows). */
export const MEDIA_CATALOG_KEY = ["admin", "media-catalog"] as const;
const catalogKey = (generation: string, kind: MediaKind) => [...MEDIA_CATALOG_KEY, generation, kind] as const;

/**
 * A fresh key status from a write (key saved, deleted, re-checked; settings saved): the status read in flight is
 * cancelled first, then the newer of the two is kept (`newerStatus`); lists of other generations go.
 */
async function applyStatus(qc: QueryClient, r: MediaAdminView): Promise<void> {
  await qc.cancelQueries({ queryKey: MEDIA_KEY });
  const kept = newerStatus(qc.getQueryData<MediaAdminView>(MEDIA_KEY), r);
  qc.setQueryData(MEDIA_KEY, kept);
  qc.removeQueries({
    queryKey: MEDIA_CATALOG_KEY,
    predicate: (q) => q.queryKey[2] !== kept.key.generation,
  });
}

/** The status is out of date (a catalog said so): read it again — that re-keys the catalog queries. */
const refetchStatus = (qc: QueryClient) => void qc.invalidateQueries({ queryKey: MEDIA_KEY });

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
function KeySection({ m }: { m: MediaAdminView }) {
  const qc = useQueryClient();
  const [key, setKey] = useState("");
  const done = (r: MediaAdminView) => applyStatus(qc, r);
  const save = useMutation({
    mutationFn: () => admin.setMediaKey(key.trim()),
    onSuccess: (r) => {
      setKey("");
      return done(r);
    },
  });
  const remove = useMutation({ mutationFn: admin.deleteMediaKey, onSuccess: done });
  const check = useMutation({ mutationFn: admin.checkMediaKey, onSuccess: done });
  const k = m.key;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
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
          <button className="primary" disabled={save.isPending || !key.trim()}>
            {save.isPending ? "확인 중…" : "확인하고 저장"}
          </button>
          {k.source !== "none" && (
            <button type="button" disabled={check.isPending} onClick={() => check.mutate()}>
              {check.isPending ? "확인 중…" : "남은 한도 다시 확인"}
            </button>
          )}
          {k.source === "admin" && (
            <button
              type="button"
              disabled={remove.isPending}
              onClick={() => {
                if (confirm("등록한 OpenRouter 키를 지울까요?")) remove.mutate();
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
  onChange,
}: {
  kind: MediaKind;
  value: MediaSettings["kinds"][MediaKind];
  /**
   * The key status shown. The row is mounted per key generation (its React key), so a refresh's pending or failed
   * state never carries over to another key.
   */
  status: MediaAdminView;
  onChange: (v: MediaSettings["kinds"][MediaKind]) => void;
}) {
  const qc = useQueryClient();
  const generation = status.key.generation;
  const hasKey = status.key.source !== "none";
  const onStale = (e: unknown) => {
    if (isStaleKeyError(e)) refetchStatus(qc);
  };
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
    enabled: hasKey,
    staleTime: 5 * 60_000,
    retry: (n, e) => !isStaleKeyError(e) && n < 2,
  });
  const reload = useMutation({
    mutationFn: () => admin.mediaCatalog(kind, true, generation),
    // Stored under the generation the server actually read it with — shown only while that is the status's.
    onSuccess: (r) => qc.setQueryData(catalogKey(r.generation, kind), r),
    onError: onStale,
  });
  // Only a list read in the shown status's own generation, and only with a key (no models, prices or source else).
  const list = catalogView(status, catalog.data);
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
        disabled={!hasKey || reload.isPending}
        onClick={() => reload.mutate()}
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

function SettingsForm({ m }: { m: MediaAdminView }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<MediaSettings>(m.settings);
  const [saved, setSaved] = useState(false);
  const save = useMutation({
    mutationFn: () => admin.saveMediaSettings(draft),
    onSuccess: async (r) => {
      setDraft(r.settings);
      setSaved(true);
      await applyStatus(qc, r);
    },
  });
  const hasKey = m.key.source !== "none";
  const set = (patch: Partial<MediaSettings>) => {
    setSaved(false);
    setDraft((d) => ({ ...d, ...patch }));
  };
  const invalid = MEDIA_KINDS.some((k) => draft.kinds[k].enabled && !draft.kinds[k].model);
  const failedKind =
    save.error instanceof ApiError ? (save.error.body as { kind?: MediaKind } | undefined)?.kind : undefined;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const num = (v: string) => (v === "" ? NaN : Number(v));
  return (
    <form onSubmit={submit} aria-label="미디어 생성 설정">
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
      <p className="muted small">
        청소년 계정도 미디어 생성이 보여요. 청소년 계정의 요청은 제공자가 지원하면 가장 엄격한 검열 옵션으로
        보내요. 모든 요청은 데이터 수집을 거부하고(<code>data_collection: deny</code>), 비밀값이 든 프롬프트는
        보내지 않아요.
      </p>
      {save.isError && (
        <p className="error small" role="alert">
          {failedKind && `${MEDIA_KIND_LABEL[failedKind]}: `}
          {errorText(save.error)}
        </p>
      )}
      {saved && !save.isPending && (
        <p className="small" role="status">
          저장했어요.
        </p>
      )}
      <span className="actions">
        <button className="primary" disabled={save.isPending || invalid}>
          {save.isPending ? "모델 확인 중…" : "확인하고 저장"}
        </button>
      </span>
    </form>
  );
}

/** 관리자 → 미디어 생성 (#238 stage 1): the OpenRouter key, per-kind models and the cost limits. */
export function MediaAdmin() {
  const qc = useQueryClient();
  // A read that answers after a newer status arrived (a write's) never puts the older one back.
  const q = useQuery({
    queryKey: MEDIA_KEY,
    queryFn: async () => newerStatus(qc.getQueryData<MediaAdminView>(MEDIA_KEY), await admin.media()),
  });
  const m = q.data;
  if (q.isError) return <p className="error small">{errorText(q.error)}</p>;
  if (!m) return <p className="muted small">불러오는 중…</p>;
  return (
    <section className="admin" aria-label="미디어 생성">
      <h2>미디어 생성</h2>
      <p className="muted small">
        OpenRouter 모델로 이미지·음성·음악·영상을 만들어요(운영 문서 51절). 종류마다 켜고 모델을 골라요. 생성
        비용은 OpenRouter가 알려 준 실제 금액으로 사용량에 &quot;미디어 생성&quot;으로 기록돼요.
      </p>
      <KeySection m={m} />
      <SettingsForm m={m} />
    </section>
  );
}
