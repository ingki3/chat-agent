import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DREAMING_CODE_LABEL,
  DREAMING_PROBLEM_LABEL,
  DREAMING_PROMPT_MAX,
  DREAMING_STATUS_LABEL,
  DREAMING_TRIGGER_LABEL,
  MEMORY_DOC_FILE,
  type DreamingConnectionChoice,
  type DreamingCounts,
  type DreamingPreview,
  type DreamingSettings,
  type DreamsRecord,
  type SaveDreamingSettingsRequest,
  type MyDreaming,
} from "@agentlee/shared";
import { dreaming, DREAMING_KEY, errorText } from "../api.js";
import { afterSave, settleDraft, withDraft } from "./draft.js";
import { behind, SAVED_STALE, saveAndSync, stamped } from "./sync.js";
import { MemoryCard } from "./MemoryCard.js";

/**
 * 설정 → 내 지침 → 기억 정리 (#146, #188, PRD FR-16.5·16.7·16.8): the user's own settings (on/off, the time, the
 * connection·model among the pairs the admin allowed), their cleanup prompt (기본값으로 되돌리기, 미리 실행 on their own
 * data), the bundles 기억 정리 made (반영 / 거절 per change, 모두 반영, 되돌리기 — the same card as in a conversation)
 * and `DREAMS.md` (the run history: counts, times, results only). A youth account sees its settings read-only — the
 * admin sets them. Only the user sees this — the admin's screen has counts only.
 */
export function DreamingPanel() {
  const q = useQuery({ queryKey: DREAMING_KEY, queryFn: stamped(DREAMING_KEY, dreaming.mine) });
  // Read so the panel re-renders when a refetch lands (the "저장했지만…" notices follow it — sync.ts).
  void q.dataUpdatedAt;
  const d = q.data;
  // A failed refetch keeps the form (and its drafts) on the data we have, with the error above it (review #195 5).
  if (!d)
    return q.isError ? (
      <p className="error">{errorText(q.error)}</p>
    ) : (
      <p className="muted small">불러오는 중…</p>
    );
  return (
    <div className="dreaming-panel" data-testid="dreaming-panel">
      {q.isError && (
        <p className="error small" role="alert" data-testid="dreaming-load-error">
          새로 불러오지 못했어요: {errorText(q.error)} (보이는 값은 마지막으로 불러온 것이에요)
        </p>
      )}
      <p className="small" data-testid="dreaming-state">
        {d.enabled
          ? `기억 정리가 매일 ${d.time ?? ""}(한국 시각)에 새 메시지를 정리해요. 반영 방식은 위의 "기억 반영 방식"을 따라요.`
          : d.problem
            ? `기억 정리가 켜져 있지만 돌지 않아요: ${DREAMING_PROBLEM_LABEL[d.problem]}`
            : "기억 정리가 꺼져 있어요. 켜면 하루 한 번, 정한 시각에 새 메시지를 정리해요."}
      </p>
      <Settings view={d} />
      <Prompt view={d} />
      <h3>제안</h3>
      {d.proposals.length ? (
        <div className="dream-proposals">
          {d.proposals.map((p) => (
            <MemoryCard key={p.id} id={p.id} />
          ))}
        </div>
      ) : (
        <p className="muted small">기다리는 제안이 없어요.</p>
      )}
      <h3>DREAMS.md</h3>
      <p className="muted small">
        실행 기록이에요. 건수·시각·결과만 적고 내용은 적지 않아요(바뀐 내용은 문서의 버전에서 봐요).
      </p>
      <pre className="dreams-md" data-testid="dreams-md">
        {d.runs.length ? d.runs.map(line).join("\n") : "아직 실행 기록이 없어요."}
      </pre>
    </div>
  );
}

export const choiceKey = (c: {
  runtime: string | null;
  connectionId: string | null;
  model: string | null;
}) => (c.runtime && c.model ? `${c.runtime}|${c.connectionId ?? ""}|${c.model}` : "");

/**
 * On/off, time, connection·model — the form both the user (their own) and the admin (a youth account's) use. A stored
 * choice that is no longer offered shows as "쓸 수 없음" until another is picked. Locked while a save is in flight
 * (no edit can be lost, no second submit); a success drops the draft only if it is still the one sent, a failure
 * keeps it (review #195 round 4).
 */
export function DreamingSettingsForm({
  settings,
  choices,
  disabled,
  pending,
  label,
  onSave,
}: {
  settings: DreamingSettings;
  choices: DreamingConnectionChoice[];
  disabled: boolean;
  pending: boolean;
  /** Prefix of the accessible names (a row of the admin's table names its user). */
  label?: string;
  /**
   * Saves only the changed fields; resolves `true` once saved and refetched, `false` when saved but the refetch failed
   * (the draft stays), rejects when refused (the caller says why).
   */
  onSave: (s: SaveDreamingSettingsRequest) => Promise<boolean>;
}) {
  // Only the changed fields (draft.ts): the others follow the server.
  const [draft, setDraft] = useState<Partial<DreamingSettings>>();
  const s = withDraft(settings, draft);
  const edit = (p: Partial<DreamingSettings>) => setDraft((d) => ({ ...d, ...p }));
  const current = choiceKey(s);
  const offered = choices.some((c) => choiceKey(c) === current);
  const name = (n: string) => (label ? `${label} ${n}` : n);
  return (
    <form
      className="dream-settings"
      onSubmit={(e) => {
        e.preventDefault();
        if (pending || draft === undefined) return;
        const sent = draft;
        void onSave(sent).then(
          (synced) => {
            if (synced) setDraft((cur) => settleDraft(cur, sent));
          },
          () => {},
        );
      }}
    >
      <fieldset disabled={disabled || pending} aria-busy={pending} className="quiet">
        <label className="row">
          <input
            type="checkbox"
            aria-label={name("기억 정리 켜기")}
            checked={s.enabled}
            onChange={(e) => edit({ enabled: e.target.checked })}
          />{" "}
          기억 정리 켜기
        </label>
        <div className="row wrap">
          <label className="inline">
            실행 시각 (한국 시각)
            <input
              type="time"
              value={s.time}
              required
              aria-label={name("실행 시각")}
              onChange={(e) => edit({ time: e.target.value })}
            />
          </label>
          <label className="inline">
            연결·모델
            <select
              aria-label={name("연결·모델")}
              value={current}
              onChange={(e) => {
                const o = choices.find((x) => choiceKey(x) === e.target.value);
                edit(
                  o
                    ? { runtime: o.runtime, connectionId: o.connectionId, model: o.model }
                    : { runtime: null, connectionId: null, model: null },
                );
              }}
            >
              <option value="">고르세요</option>
              {current && !offered && <option value={current}>(쓸 수 없음) 다시 고르세요</option>}
              {choices.map((o) => (
                <option key={choiceKey(o)} value={choiceKey(o)}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" className="primary small" disabled={pending || draft === undefined}>
            저장
          </button>
        </div>
        {!choices.length && (
          <p className="muted small">관리자가 아직 기억 정리에 쓸 연결·모델을 허용하지 않았어요.</p>
        )}
      </fieldset>
    </form>
  );
}

function Settings({ view }: { view: MyDreaming }) {
  const qc = useQueryClient();
  // The answer is not put in the cache (it could be older than another form's save): saved, then refetched
  // (sync.ts) — `data` says whether the screen caught up.
  const save = useMutation({
    mutationFn: (s: SaveDreamingSettingsRequest) => saveAndSync(qc, DREAMING_KEY, () => dreaming.save(s)),
  });
  return (
    <section className="dream-section" aria-labelledby="dream-my-settings-h" data-testid="dreaming-settings">
      <h3 id="dream-my-settings-h">설정</h3>
      {!view.canEdit && (
        <p className="notice small" data-testid="dreaming-locked">
          청소년 계정은 기억 정리 설정을 관리자만 바꿀 수 있어요. 지금 설정을 보여 드려요.
        </p>
      )}
      <DreamingSettingsForm
        settings={view.settings}
        choices={view.choices}
        disabled={!view.canEdit}
        pending={save.isPending}
        onSave={(s) => save.mutateAsync(s).then((r) => r.synced)}
      />
      {save.isSuccess && (
        <p className="small" role="status">
          {behind(DREAMING_KEY, save.data.savedAt) ? SAVED_STALE : "저장했어요."}
        </p>
      )}
      {save.isError && (
        <p className="error small" role="alert">
          {errorText(save.error)}
        </p>
      )}
    </section>
  );
}

function Prompt({ view }: { view: MyDreaming }) {
  const qc = useQueryClient();
  const [text, setText] = useState<string>();
  const [preview, setPreview] = useState<DreamingPreview>();
  const content = text ?? view.prompt.content;
  // `typed`: the editor's draft when the save was sent — cleared on success only if it is still the same.
  const save = useMutation({
    mutationFn: (a: { content: string | null; typed: string | undefined }) =>
      saveAndSync(qc, DREAMING_KEY, () => dreaming.savePrompt(a.content)),
    // Only once the fresh prompt is on screen; a failed refetch keeps the text (and says so).
    onSuccess: (r, a) => {
      if (r.synced) setText((cur) => afterSave(cur, a.typed, undefined));
    },
  });
  // 미리 실행 runs the prompt **saved on the server** (it sends none — review #195 5): what the next run would use.
  const run = useMutation({
    mutationFn: () => dreaming.preview(),
    onMutate: () => setPreview(undefined),
    onSuccess: (p) => setPreview(p),
  });
  return (
    <details className="dream-section">
      <summary className="small">
        지금 쓰는 정리 프롬프트 ({view.prompt.custom ? "내가 고친 것" : "기본값"})
      </summary>
      <p className="muted small">
        무엇을 고르고 어떻게 적을지만 정해요. 출력 형식·금지 규칙·검증은 고정이라 바꿀 수 없어요.
      </p>
      <textarea
        aria-label="정리 프롬프트"
        data-testid="dreaming-prompt"
        rows={8}
        maxLength={DREAMING_PROMPT_MAX}
        readOnly={!view.canEdit || save.isPending}
        aria-busy={save.isPending}
        value={content}
        onChange={(e) => setText(e.target.value)}
      />
      {view.canEdit && (
        <div className="row wrap">
          <button
            type="button"
            className="primary"
            disabled={save.isPending || text === undefined}
            onClick={() => save.mutate({ content, typed: text })}
          >
            프롬프트 저장
          </button>
          <button
            type="button"
            disabled={save.isPending || (!view.prompt.custom && text === undefined)}
            onClick={() => save.mutate({ content: null, typed: text })}
          >
            기본값으로 되돌리기
          </button>
          <button type="button" disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending ? "미리 실행 중…" : "미리 실행 (내 데이터, 저장된 프롬프트)"}
          </button>
        </div>
      )}
      {view.canEdit && text !== undefined && (
        <p className="small muted">
          미리 실행은 저장된 프롬프트로 돌아요. 고친 내용은 저장한 뒤 미리 실행해 보세요.
        </p>
      )}
      {save.isSuccess && behind(DREAMING_KEY, save.data.savedAt) && (
        <p className="small" role="status">
          {SAVED_STALE}
        </p>
      )}
      {(save.isError || run.isError) && (
        <p className="error small" role="alert">
          {errorText(save.error ?? run.error)}
        </p>
      )}
      {preview && <PreviewResult preview={preview} />}
      <p className="small muted">고정 규칙(누구도 바꿀 수 없어요):</p>
      <pre className="small dream-rules">{view.prompt.fixedRules}</pre>
    </details>
  );
}

function PreviewResult({ preview }: { preview: DreamingPreview }) {
  return (
    <div className="dream-preview" data-testid="dreaming-preview" role="status">
      <p className="small">
        미리 실행 결과(내 데이터만, 반영하지 않음): <b>{DREAMING_STATUS_LABEL[preview.status]}</b>
        {preview.code ? ` — ${DREAMING_CODE_LABEL[preview.code] ?? preview.code}` : ""} ·{" "}
        {countsText(preview.counts)}
      </p>
      {preview.decisions.length > 0 && (
        <ul className="small">
          {preview.decisions.map((d, i) => (
            <li key={i}>
              {MEMORY_DOC_FILE[d.doc]} · {d.action}
              {d.before ? ` — ${d.before.replace(/\n/g, " / ")}` : ""}
              {d.text ? ` → ${d.text}` : ""}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function countsText(c: DreamingCounts): string {
  const refused = Object.values(c.refused).reduce((a, b) => a + (b ?? 0), 0);
  return [
    `새 메시지 ${c.newMessages}`,
    c.queuedMessages ? `다시 처리 ${c.queuedMessages}` : "",
    `제안 ${c.proposed}`,
    `반영 ${c.applied}`,
    refused ? `거부 ${refused}` : "",
    c.skippedOld ? "오래된 대화 건너뜀" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function line(r: DreamsRecord): string {
  const at = new Date(r.startedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  const code = r.code ? ` — ${DREAMING_CODE_LABEL[r.code] ?? r.code}` : "";
  return `- ${at} · ${DREAMING_TRIGGER_LABEL[r.trigger]} · ${DREAMING_STATUS_LABEL[r.status]}${code} · ${countsText(r.counts)}`;
}
